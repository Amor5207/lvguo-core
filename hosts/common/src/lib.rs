//! 宿主共享基础模块：
//! 1. 单文件 Core 动态库加载器（支持 `core_hot/` 热更优先 + 崩溃保护自动回退基线）；
//! 2. 编译期内嵌 `web-ui` 静态资源对外暴露 C-ABI 回调。

use libloading::Library;
use serde_json::Value;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::path::{Path, PathBuf};

include!(concat!(env!("OUT_DIR"), "/embedded_web_ui.rs"));

/// 宿主期望的 Core C-ABI 主版本号；热更库 ABI 不一致时拒绝加载并自动回退。
pub const EXPECTED_ABI_VERSION: u32 = 1;

pub type AssetCallback = extern "C" fn(
    path: *const c_char,
    out_ptr: *mut *const u8,
    out_len: *mut usize,
    out_mime: *mut *const c_char,
) -> c_int;

pub type NativePlayCallback =
    extern "C" fn(payload_json: *const c_char, out_buf: *mut c_char, out_cap: usize) -> c_int;

type FnAbiVer = unsafe extern "C" fn() -> u32;
type FnVersion = unsafe extern "C" fn() -> *const c_char;
type FnStr1 = unsafe extern "C" fn(*const c_char) -> *mut c_char;
type FnStr2 = unsafe extern "C" fn(*const c_char, *const c_char) -> *mut c_char;
type FnStr3 = unsafe extern "C" fn(*const c_char, *const c_char, *const c_char) -> *mut c_char;
type FnRegAsset = unsafe extern "C" fn(Option<AssetCallback>) -> c_int;
type FnRegPlay = unsafe extern "C" fn(Option<NativePlayCallback>) -> c_int;
type FnVoid = unsafe extern "C" fn();
type FnFree = unsafe extern "C" fn(*mut c_char);

/// 当前平台 Core 动态库标准文件名。
pub fn core_filename() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "lvguo_core.dll"
    }
    #[cfg(target_os = "macos")]
    {
        "liblvguo_core.dylib"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        "liblvguo_core.so"
    }
}

/// 统一供给 Core 内嵌 HTTP 服务的 C-ABI 静态资产查找函数（零额外堆分配）。
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub extern "C" fn embedded_asset_callback(
    path_ptr: *const c_char,
    out_ptr: *mut *const u8,
    out_len: *mut usize,
    out_mime: *mut *const c_char,
) -> c_int {
    if path_ptr.is_null() || out_ptr.is_null() || out_len.is_null() || out_mime.is_null() {
        return 0;
    }
    let req_path = unsafe { CStr::from_ptr(path_ptr) }.to_string_lossy();
    if let Some((bytes, mime_z)) = lookup_embedded_asset(req_path.as_ref()) {
        unsafe {
            *out_ptr = bytes.as_ptr();
            *out_len = bytes.len();
            *out_mime = mime_z.as_ptr() as *const c_char;
        }
        return 1;
    }
    0
}

/// 已加载并完成初始化的 Core 动态库句柄。
pub struct LoadedCore {
    _lib: Library,
    loaded_path: PathBuf,
    is_hot: bool,
    version: String,
    fn_call: FnStr2,
    fn_start_http: FnStr3,
    fn_reg_asset: Option<FnRegAsset>,
    fn_reg_native_player: Option<FnRegPlay>,
    fn_shutdown: FnVoid,
    fn_free: FnFree,
}

impl LoadedCore {
    /// 按顺序尝试加载单个 Core 动态库（热更新版优先，带崩溃保护自动回退内置基线版）。
    pub fn open_and_init(
        data_dir: &Path,
        host_kind: &str,
        update_mode: Option<&str>,
        custom_update_url: Option<&str>,
        explicit_core_path: Option<&Path>,
    ) -> Result<Self, String> {
        let mut init_obj = serde_json::json!({
            "dataDir": data_dir.to_string_lossy(),
            "hostKind": host_kind,
            "appVersion": env!("CARGO_PKG_VERSION"),
        });
        if let Some(m) = update_mode {
            if !m.trim().is_empty() {
                init_obj["updateMode"] = Value::String(m.trim().to_string());
            }
        }
        if let Some(u) = custom_update_url {
            if !u.trim().is_empty() {
                init_obj["customUpdateUrl"] = Value::String(u.trim().to_string());
            }
        }
        let init_json = init_obj.to_string();

        if let Some(p) = explicit_core_path {
            return Self::try_load_single(p, false, &init_json);
        }

        let filename = core_filename();
        let hot_path = data_dir.join("core_hot").join(filename);
        let attempt_flag = hot_path.with_extension("attempt");

        // 1) 若存在热更新单文件 core 且无上次未清除的崩溃标记，则优先尝试加载热更版
        if hot_path.is_file() {
            if attempt_flag.exists() {
                eprintln!("[lvguo] 检测到热更核心上次启动未完成，自动清理并回退基线版本");
                let _ = std::fs::remove_file(&hot_path);
                let _ = std::fs::remove_file(&attempt_flag);
            } else {
                let _ = std::fs::write(&attempt_flag, b"1");
                match Self::try_load_single(&hot_path, true, &init_json) {
                    Ok(loaded) => {
                        let _ = std::fs::remove_file(&attempt_flag);
                        return Ok(loaded);
                    }
                    Err(e) => {
                        eprintln!("[lvguo] 热更核心加载失败 ({e})，自动清理并回退基线版本");
                        let _ = std::fs::remove_file(&hot_path);
                        let _ = std::fs::remove_file(&attempt_flag);
                    }
                }
            }
        }

        // 2) 回退加载宿主同目录或系统路径下的基线单文件 core
        let mut candidates = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join(filename));
                candidates.push(dir.join("lib").join(filename));
                #[cfg(target_os = "macos")]
                if let Some(contents) = dir.parent() {
                    candidates.push(contents.join("Frameworks").join(filename));
                }
            }
        }
        candidates.push(PathBuf::from(filename));

        let mut errs = Vec::new();
        for c in candidates {
            if c.is_file() || c == Path::new(filename) {
                match Self::try_load_single(&c, false, &init_json) {
                    Ok(loaded) => return Ok(loaded),
                    Err(e) => errs.push(format!("{}: {e}", c.display())),
                }
            }
        }
        Err(format!("未能加载 {filename}：{}", errs.join("; ")))
    }

    fn try_load_single(path: &Path, is_hot: bool, init_json: &str) -> Result<Self, String> {
        let lib = unsafe { Library::new(path) }.map_err(|e| format!("打开动态库失败: {e}"))?;

        let abi_ver: u32 = unsafe {
            let f: libloading::Symbol<FnAbiVer> = lib
                .get(b"lvguo_core_abi_version\0")
                .map_err(|e| format!("缺少 ABI 版本符号: {e}"))?;
            f()
        };
        if abi_ver != EXPECTED_ABI_VERSION {
            return Err(format!(
                "ABI 版本不兼容（核心 ABI v{abi_ver}，宿主期望 v{EXPECTED_ABI_VERSION}）"
            ));
        }

        let version = unsafe {
            let f: libloading::Symbol<FnVersion> = lib
                .get(b"lvguo_core_version\0")
                .map_err(|e| format!("缺少版本符号: {e}"))?;
            CStr::from_ptr(f()).to_string_lossy().into_owned()
        };

        let fn_free: FnFree = unsafe {
            *lib.get::<FnFree>(b"lvguo_free\0")
                .map_err(|e| format!("缺少 lvguo_free 符号: {e}"))?
        };
        let fn_init: FnStr1 = unsafe {
            *lib.get::<FnStr1>(b"lvguo_init\0")
                .map_err(|e| format!("缺少 lvguo_init 符号: {e}"))?
        };
        let fn_call: FnStr2 = unsafe {
            *lib.get::<FnStr2>(b"lvguo_call\0")
                .map_err(|e| format!("缺少 lvguo_call 符号: {e}"))?
        };
        let fn_start_http: FnStr3 = unsafe {
            *lib.get::<FnStr3>(b"lvguo_start_http\0")
                .map_err(|e| format!("缺少 lvguo_start_http 符号: {e}"))?
        };
        let fn_shutdown: FnVoid = unsafe {
            *lib.get::<FnVoid>(b"lvguo_shutdown\0")
                .map_err(|e| format!("缺少 lvguo_shutdown 符号: {e}"))?
        };
        let fn_reg_asset = unsafe {
            lib.get::<FnRegAsset>(b"lvguo_register_asset_provider\0")
                .ok()
                .map(|s| *s)
        };
        let fn_reg_native_player = unsafe {
            lib.get::<FnRegPlay>(b"lvguo_register_native_player\0")
                .ok()
                .map(|s| *s)
        };

        let c_init = CString::new(init_json).map_err(|e| e.to_string())?;
        let raw_ptr = unsafe { fn_init(c_init.as_ptr()) };
        let resp_str = take_c_string(raw_ptr, fn_free)?;
        let resp: Value =
            serde_json::from_str(&resp_str).map_err(|e| format!("解析初始化响应失败: {e}"))?;
        if resp["ok"].as_bool() != Some(true) {
            return Err(resp["error"]
                .as_str()
                .unwrap_or("核心初始化失败")
                .to_string());
        }

        Ok(Self {
            _lib: lib,
            loaded_path: path.to_path_buf(),
            is_hot,
            version,
            fn_call,
            fn_start_http,
            fn_reg_asset,
            fn_reg_native_player,
            fn_shutdown,
            fn_free,
        })
    }

    pub fn loaded_path(&self) -> &Path {
        &self.loaded_path
    }

    pub fn is_hot_loaded(&self) -> bool {
        self.is_hot
    }

    pub fn version(&self) -> &str {
        &self.version
    }

    /// 注入内嵌静态前端资产回调。
    pub fn register_embedded_assets(&self) -> bool {
        if let Some(f) = self.fn_reg_asset {
            unsafe { f(Some(embedded_asset_callback)) == 1 }
        } else {
            false
        }
    }

    /// 注入原生播放回调（PC 端专用）。
    pub fn register_native_player(&self, cb: NativePlayCallback) -> bool {
        if let Some(f) = self.fn_reg_native_player {
            unsafe { f(Some(cb)) == 1 }
        } else {
            false
        }
    }

    /// 调用 Core 业务接口。
    pub fn call(&self, action: &str, params: Value) -> Result<Value, String> {
        let c_act = CString::new(action).map_err(|e| e.to_string())?;
        let c_par = CString::new(params.to_string()).map_err(|e| e.to_string())?;
        let ptr = unsafe { (self.fn_call)(c_act.as_ptr(), c_par.as_ptr()) };
        let s = take_c_string(ptr, self.fn_free)?;
        let v: Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
        if v["ok"].as_bool() == Some(true) {
            Ok(v["data"].clone())
        } else {
            Err(v["error"].as_str().unwrap_or("调用失败").to_string())
        }
    }

    /// 启动核心内嵌 HTTP 服务并返回 `http://addr`。
    pub fn start_http(&self, bind_addr: &str, caps_json: &str) -> Result<String, String> {
        let c_bind = CString::new(bind_addr).map_err(|e| e.to_string())?;
        let c_dir = CString::new("").unwrap();
        let c_caps = CString::new(caps_json).map_err(|e| e.to_string())?;
        let ptr = unsafe { (self.fn_start_http)(c_bind.as_ptr(), c_dir.as_ptr(), c_caps.as_ptr()) };
        let s = take_c_string(ptr, self.fn_free)?;
        let v: Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
        if v["ok"].as_bool() == Some(true) {
            Ok(v["data"]["baseUrl"]
                .as_str()
                .unwrap_or("")
                .to_string())
        } else {
            Err(v["error"]
                .as_str()
                .unwrap_or("启动 HTTP 服务失败")
                .to_string())
        }
    }
}

impl Drop for LoadedCore {
    fn drop(&mut self) {
        unsafe {
            (self.fn_shutdown)();
        }
    }
}

fn take_c_string(ptr: *mut c_char, free_fn: FnFree) -> Result<String, String> {
    if ptr.is_null() {
        return Err("核心返回空指针".into());
    }
    let text = unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned();
    unsafe {
        free_fn(ptr);
    }
    Ok(text)
}
