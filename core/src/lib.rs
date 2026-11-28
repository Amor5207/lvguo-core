#![recursion_limit = "256"]

//! 绿果统一共享核心库（`lvguo-core`）。
//!
//! 将全部上游协议签名、设备会话、流式 CENC 解密、多线程下载、历史进度融合与插槽式单文件自更新
//! 收敛到单一动态库（`.so` / `.dll` / `.dylib`）中，对外提供稳定的 C-ABI 与可选 Android JNI 入口。

pub mod cenc;
pub mod config;
pub mod downloader;
pub mod http_server;
pub mod limiter;
pub mod media_server;
pub mod models;
pub mod runtime;
pub mod secret;
pub mod sign;
pub mod updater;
pub mod upstream;

#[cfg(target_os = "android")]
pub mod jni_bridge;

use config::{CoreInitConfig, CORE_ABI_VERSION, CORE_VERSION};
use runtime::{current_core, init_core, shutdown_core};
use serde_json::{json, Value};
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::sync::Arc;

fn cstr_to_string(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() }
}

fn to_c_ptr(val: Value) -> *mut c_char {
    match CString::new(val.to_string()) {
        Ok(c) => c.into_raw(),
        Err(_) => CString::new(r#"{"ok":false,"error":"响应编码失败"}"#)
            .unwrap()
            .into_raw(),
    }
}

fn ok_json(data: Value) -> Value {
    json!({ "ok": true, "data": data })
}

fn err_json(msg: &str) -> Value {
    json!({ "ok": false, "error": msg })
}

/// 返回 C-ABI 主版本号；宿主加载热更动态库前须确认二者一致。
#[no_mangle]
pub extern "C" fn lvguo_core_abi_version() -> u32 {
    CORE_ABI_VERSION
}

/// 返回当前 Core 版本字符串（静态只读指针，无需调用方释放）。
#[no_mangle]
pub extern "C" fn lvguo_core_version() -> *const c_char {
    concat!(env!("CARGO_PKG_VERSION"), "\0").as_ptr() as *const c_char
}

/// 初始化核心运行上下文。
///
/// `config_json_ptr` 支持两种入参：
/// - JSON 对象，如 `{"dataDir":"/path","hostKind":"pc","updateMode":"default"}`；
/// - 兼容简写：直接传纯目录路径字符串或空指针（使用系统默认应用目录）。
#[no_mangle]
pub extern "C" fn lvguo_init(config_json_ptr: *const c_char) -> *mut c_char {
    let raw = cstr_to_string(config_json_ptr);
    let trimmed = raw.trim();
    let cfg: CoreInitConfig = if trimmed.is_empty() {
        CoreInitConfig::default()
    } else if trimmed.starts_with('{') {
        match serde_json::from_str(trimmed) {
            Ok(c) => c,
            Err(e) => return to_c_ptr(err_json(&format!("初始化配置 JSON 无效: {e}"))),
        }
    } else {
        CoreInitConfig {
            data_dir: trimmed.to_string(),
            ..Default::default()
        }
    };

    match init_core(cfg) {
        Ok(c) => to_c_ptr(ok_json(json!({
            "version": CORE_VERSION,
            "abiVersion": CORE_ABI_VERSION,
            "target": config::current_target_id(),
            "mediaBaseUrl": c.media_server.base_url(),
            "dataDir": c.data_dir.to_string_lossy(),
        }))),
        Err(e) => to_c_ptr(err_json(&e)),
    }
}

/// 执行业务动作，返回 `{"ok":true,"data":...}` 或 `{"ok":false,"error":"..."}`（需调用 `lvguo_free` 释放）。
#[no_mangle]
pub extern "C" fn lvguo_call(
    action_ptr: *const c_char,
    params_json_ptr: *const c_char,
) -> *mut c_char {
    let action = cstr_to_string(action_ptr);
    let raw_params = cstr_to_string(params_json_ptr);
    let params: Value = if raw_params.trim().is_empty() {
        json!({})
    } else {
        match serde_json::from_str(&raw_params) {
            Ok(v) => v,
            Err(e) => return to_c_ptr(err_json(&format!("参数 JSON 无效: {e}"))),
        }
    };

    let core = match current_core() {
        Ok(c) => c,
        Err(e) => return to_c_ptr(err_json(&e)),
    };

    match core.rt.block_on(core.dispatch(action.trim(), params)) {
        Ok(data) => to_c_ptr(ok_json(data)),
        Err(msg) => to_c_ptr(err_json(&msg)),
    }
}

/// 在核心内部启动本地 HTTP 服务，返回真实监听地址（`{"ok":true,"data":{"addr":"127.0.0.1:..."}}`）。
#[no_mangle]
pub extern "C" fn lvguo_start_http(
    bind_addr_ptr: *const c_char,
    static_dir_ptr: *const c_char,
    caps_json_ptr: *const c_char,
) -> *mut c_char {
    let core = match current_core() {
        Ok(c) => c,
        Err(e) => return to_c_ptr(err_json(&e)),
    };
    let bind_addr = cstr_to_string(bind_addr_ptr);
    let static_dir = cstr_to_string(static_dir_ptr);
    let caps_json = cstr_to_string(caps_json_ptr);
    match core.start_http(
        &bind_addr,
        if static_dir.trim().is_empty() { None } else { Some(static_dir.as_str()) },
        if caps_json.trim().is_empty() { None } else { Some(caps_json.as_str()) },
    ) {
        Ok(addr) => to_c_ptr(ok_json(json!({ "addr": addr, "baseUrl": format!("http://{addr}") }))),
        Err(e) => to_c_ptr(err_json(&e)),
    }
}

/// 静态资源回调函数签名：
/// 由宿主注入，给定请求路径后填充静态字节切片、长度与 MIME；命中返回 1，未命中返回 0。
pub type LvguoAssetCallback = extern "C" fn(
    path: *const c_char,
    out_ptr: *mut *const u8,
    out_len: *mut usize,
    out_mime: *mut *const c_char,
) -> c_int;

/// 原生播放器回调函数签名：
/// Core 将播放参数 JSON 传给宿主，宿主将结果 JSON 写入 `out_buf`（返回写入字节数，失败返回负值）。
pub type LvguoNativePlayCallback =
    extern "C" fn(payload_json: *const c_char, out_buf: *mut c_char, out_cap: usize) -> c_int;

/// 为内嵌 HTTP 服务注册宿主内置静态资产提供器（无需落地解压静态文件）。
#[no_mangle]
pub extern "C" fn lvguo_register_asset_provider(cb: Option<LvguoAssetCallback>) -> c_int {
    let Ok(core) = current_core() else {
        return 0;
    };
    let Some(func) = cb else {
        return 0;
    };
    core.set_static_lookup(Arc::new(move |req_path: &str| {
        let c_path = CString::new(req_path).ok()?;
        let mut ptr: *const u8 = std::ptr::null();
        let mut len: usize = 0;
        let mut mime_ptr: *const c_char = std::ptr::null();
        let hit = func(c_path.as_ptr(), &mut ptr, &mut len, &mut mime_ptr);
        if hit == 0 || ptr.is_null() || len == 0 {
            return None;
        }
        let bytes = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
        let mime: &'static str = if mime_ptr.is_null() {
            runtime::guess_mime(req_path)
        } else {
            let s = unsafe { CStr::from_ptr(mime_ptr) }.to_string_lossy();
            match s.as_ref() {
                "text/html; charset=utf-8" => "text/html; charset=utf-8",
                "text/css; charset=utf-8" => "text/css; charset=utf-8",
                "application/javascript; charset=utf-8" => "application/javascript; charset=utf-8",
                "application/json; charset=utf-8" => "application/json; charset=utf-8",
                "image/png" => "image/png",
                "image/webp" => "image/webp",
                "image/svg+xml" => "image/svg+xml",
                "image/x-icon" => "image/x-icon",
                _ => runtime::guess_mime(req_path),
            }
        };
        Some((mime, bytes))
    }));
    1
}

/// 为 PC 等桌面宿主注册原生播放窗口回调，使统一 Web UI 可直接触发 GPU 硬解与着色器播放。
#[no_mangle]
pub extern "C" fn lvguo_register_native_player(cb: Option<LvguoNativePlayCallback>) -> c_int {
    let Ok(core) = current_core() else {
        return 0;
    };
    let Some(func) = cb else {
        return 0;
    };
    core.set_native_play_hook(Arc::new(move |payload: Value| {
        let c_in = CString::new(payload.to_string()).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 8192];
        let written = func(c_in.as_ptr(), buf.as_mut_ptr() as *mut c_char, buf.len());
        if written <= 0 {
            return Err("宿主原生播放器启动失败".into());
        }
        let n = (written as usize).min(buf.len());
        let txt = std::str::from_utf8(&buf[..n]).map_err(|e| e.to_string())?;
        serde_json::from_str::<Value>(txt).map_err(|e| format!("解析原生播放响应失败: {e}"))
    }));
    1
}

/// 关闭核心运行时、媒体与下载后台任务。
#[no_mangle]
pub extern "C" fn lvguo_shutdown() {
    shutdown_core();
}

/// 释放由 `lvguo_init` / `lvguo_call` / `lvguo_start_http` 返回的堆字符串。
#[no_mangle]
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub extern "C" fn lvguo_free(ptr: *mut c_char) {
    if !ptr.is_null() {
        unsafe {
            let _ = CString::from_raw(ptr);
        }
    }
}

/// 兼容旧命名的字符串释放别名。
#[no_mangle]
pub extern "C" fn lvguo_free_string(ptr: *mut c_char) {
    lvguo_free(ptr);
}
