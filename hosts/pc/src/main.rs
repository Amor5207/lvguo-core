#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

//! 绿果 PC 桌面极薄宿主入口。
//!
//! 设计特点：
//! 1. **不塞 Chromium**：不打包任何庞大浏览器内核，优先用系统原生应用模式或系统 WebView/浏览器打开统一 `web-ui/`（兼容 Win7 / WinXP 老旧系统回退）；
//! 2. **只依赖单个 `lvguo_core` 动态库**：内置崩溃保护自动回退，热更新仅替换 `core_hot/` 下单个核心文件；
//! 3. **GPU 硬件加速与超分**：当系统或同目录存在 `mpv` 时，注册原生播放回调拉起独立 GPU 硬解窗口并按需注入 CAS/FSR 着色器。

use lvguo_host_common::{LoadedCore, NativePlayCallback};
use once_cell_lite::Slot;
use serde_json::{json, Value};
use std::ffi::CStr;
use std::os::raw::{c_char, c_int};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::Duration;

// 极简一次性全局上下文占位（避免为 1 个全局静态变量额外引入依赖）
mod once_cell_lite {
    use std::sync::OnceLock;
    pub struct Slot<T>(OnceLock<T>);
    impl<T> Slot<T> {
        pub const fn new() -> Self {
            Self(OnceLock::new())
        }
        pub fn set(&self, v: T) -> Result<(), T> {
            self.0.set(v)
        }
        pub fn get(&self) -> Option<&T> {
            self.0.get()
        }
    }
}

/// GPU 对比度自适应锐化（CAS）MPV 着色器，按需写入临时缓存使用。
const SHADER_CAS_GLSL: &str = r#"//!HOOK MAIN
//!BIND HOOKED
//!DESC Contrast Adaptive Sharpening
vec4 hook() {
    vec2 px = 1.0 / HOOKED_size;
    vec3 c = HOOKED_tex(HOOKED_pos).rgb;
    vec3 n = HOOKED_tex(HOOKED_pos + vec2(0.0, -px.y)).rgb;
    vec3 s = HOOKED_tex(HOOKED_pos + vec2(0.0, px.y)).rgb;
    vec3 w = HOOKED_tex(HOOKED_pos + vec2(-px.x, 0.0)).rgb;
    vec3 e = HOOKED_tex(HOOKED_pos + vec2(px.x, 0.0)).rgb;
    vec3 mn = min(min(n, s), min(w, e));
    vec3 mx = max(max(n, s), max(w, e));
    vec3 lap = c - 0.25 * (n + s + w + e);
    vec3 sharp = clamp(c + 0.55 * lap, mn, mx);
    return vec4(sharp, 1.0);
}
"#;

/// GPU 轻量两步边缘超分（FSR 风格）着色器。
const SHADER_FSR_GLSL: &str = r#"//!HOOK MAIN
//!BIND HOOKED
//!DESC Lightweight Edge Adaptive Upscale
vec4 hook() {
    vec2 px = 1.0 / HOOKED_size;
    vec3 c = HOOKED_tex(HOOKED_pos).rgb;
    vec3 n = HOOKED_tex(HOOKED_pos + vec2(0.0, -px.y)).rgb;
    vec3 s = HOOKED_tex(HOOKED_pos + vec2(0.0, px.y)).rgb;
    vec3 w = HOOKED_tex(HOOKED_pos + vec2(-px.x, 0.0)).rgb;
    vec3 e = HOOKED_tex(HOOKED_pos + vec2(px.x, 0.0)).rgb;
    vec3 edge = abs(n - s) + abs(w - e);
    vec3 detail = c - 0.25 * (n + s + w + e);
    vec3 boost = clamp(c + detail * (0.85 + 0.45 * clamp(edge, 0.0, 1.0)), min(c, min(min(n, s), min(w, e))), max(c, max(max(n, s), max(w, e))));
    return vec4(boost, 1.0);
}
"#;

/// GPU 高强度超清重建着色器（Anime4K 风格边缘细化 + 局部微观对比度增强）。
const SHADER_ANIME4K_GLSL: &str = r#"//!HOOK MAIN
//!BIND HOOKED
//!DESC High-Clarity Line & Detail Reconstruction
vec4 hook() {
    vec2 px = 1.0 / HOOKED_size;
    vec3 c = HOOKED_tex(HOOKED_pos).rgb;
    vec3 n = HOOKED_tex(HOOKED_pos + vec2(0.0, -px.y)).rgb;
    vec3 s = HOOKED_tex(HOOKED_pos + vec2(0.0, px.y)).rgb;
    vec3 w = HOOKED_tex(HOOKED_pos + vec2(-px.x, 0.0)).rgb;
    vec3 e = HOOKED_tex(HOOKED_pos + vec2(px.x, 0.0)).rgb;
    vec3 nw = HOOKED_tex(HOOKED_pos + vec2(-px.x, -px.y)).rgb;
    vec3 ne = HOOKED_tex(HOOKED_pos + vec2(px.x, -px.y)).rgb;
    vec3 sw = HOOKED_tex(HOOKED_pos + vec2(-px.x, px.y)).rgb;
    vec3 se = HOOKED_tex(HOOKED_pos + vec2(px.x, px.y)).rgb;
    vec3 blur = (n + s + w + e) * 0.15 + (nw + ne + sw + se) * 0.10;
    vec3 mn = min(min(min(n, s), min(w, e)), c);
    vec3 mx = max(max(max(n, s), max(w, e)), c);
    vec3 sharp = clamp(c + (c - blur) * 1.45, mn, mx);
    return vec4(clamp((sharp - 0.5) * 1.06 + 0.5, 0.0, 1.0), 1.0);
}
"#;

struct PcRuntime {
    mpv_path: PathBuf,
    shader_dir: PathBuf,
    active_player: Mutex<Option<Child>>,
}

static PC_RT: Slot<Arc<PcRuntime>> = Slot::new();

fn default_pc_data_dir() -> PathBuf {
    if let Ok(v) = std::env::var("LVGUO_DATA_DIR") {
        if !v.trim().is_empty() {
            return PathBuf::from(v.trim());
        }
    }
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("LvguoPC")
}

/// 探测宿主同目录或系统 PATH 下可用的 `mpv` 可执行文件。
fn find_mpv_binary() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(target_os = "windows") {
        &["mpv.exe", "mpv/mpv.exe"]
    } else {
        &["mpv", "bin/mpv"]
    };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for n in names {
                let p = dir.join(n);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    let path_var = std::env::var_os("PATH")?;
    let bin_name = if cfg!(target_os = "windows") { "mpv.exe" } else { "mpv" };
    for dir in std::env::split_paths(&path_var) {
        let p = dir.join(bin_name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn ensure_shader_file(dir: &Path, kind: &str) -> Option<PathBuf> {
    let (name, body) = match kind {
        "cas" => ("cas.glsl", SHADER_CAS_GLSL),
        "fsr" => ("fsr.glsl", SHADER_FSR_GLSL),
        "anime4k" => ("anime4k.glsl", SHADER_ANIME4K_GLSL),
        _ => return None,
    };
    if std::fs::create_dir_all(dir).is_err() {
        return None;
    }
    let path = dir.join(name);
    if std::fs::write(&path, body).is_ok() {
        Some(path)
    } else {
        None
    }
}

extern "C" fn native_play_callback(
    payload_ptr: *const c_char,
    out_buf: *mut c_char,
    out_cap: usize,
) -> c_int {
    if payload_ptr.is_null() || out_buf.is_null() || out_cap == 0 {
        return -1;
    }
    let Some(rt) = PC_RT.get() else {
        return -1;
    };
    let raw = unsafe { CStr::from_ptr(payload_ptr) }.to_string_lossy();
    let req: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));

    let media_url = req["url"].as_str().unwrap_or("").trim();
    if media_url.is_empty() {
        return write_out(out_buf, out_cap, &json!({ "ok": false, "error": "播放地址为空" }));
    }

    let title = req["title"].as_str().unwrap_or("绿果视频").trim();
    let start_sec = req["startSec"].as_f64().unwrap_or(0.0);
    let gpu_accel = req["gpuAccel"].as_bool().unwrap_or(true);
    let super_res = req["superRes"].as_str().unwrap_or("off");
    let frame_interp = req["frameInterp"]
        .as_bool()
        .unwrap_or_else(|| req["frameInterp"].as_str().is_some_and(|s| s != "off"));

    let mut cmd = Command::new(&rt.mpv_path);
    cmd.arg("--force-window=immediate")
        .arg("--keep-open=no")
        .arg(format!("--title={title}"));
    if start_sec > 1.0 {
        cmd.arg(format!("--start={start_sec:.2}"));
    }
    if gpu_accel {
        cmd.arg("--vo=gpu").arg("--hwdec=auto-safe");
    } else {
        cmd.arg("--hwdec=no");
    }
    if frame_interp {
        cmd.arg("--video-sync=display-resample")
            .arg("--interpolation=yes")
            .arg("--tscale=oversample");
    }
    if let Some(shader_path) = ensure_shader_file(&rt.shader_dir, super_res) {
        cmd.arg(format!("--glsl-shaders={}", shader_path.display()));
    }
    cmd.arg(media_url);

    // 同一时间保持单个独立原生播放窗口，避免旧窗残留
    if let Ok(mut guard) = rt.active_player.lock() {
        if let Some(mut old) = guard.take() {
            let _ = old.kill();
            let _ = old.wait();
        }
        match cmd.spawn() {
            Ok(child) => {
                *guard = Some(child);
                return write_out(out_buf, out_cap, &json!({ "ok": true, "mode": "mpv" }));
            }
            Err(e) => {
                return write_out(
                    out_buf,
                    out_cap,
                    &json!({ "ok": false, "error": format!("启动原生播放器失败: {e}") }),
                );
            }
        }
    }
    -1
}

fn write_out(out_buf: *mut c_char, out_cap: usize, val: &Value) -> c_int {
    let bytes = val.to_string().into_bytes();
    let n = bytes.len().min(out_cap.saturating_sub(1));
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_buf as *mut u8, n);
        *out_buf.add(n) = 0;
    }
    n as c_int
}

fn log_pc_error(data_dir: &Path, msg: &str) {
    eprintln!("{msg}");
    let _ = std::fs::create_dir_all(data_dir);
    let _ = std::fs::write(data_dir.join("lvguo-pc.log"), format!("{msg}\n"));
}

/// 内嵌 WebView 拒绝新窗口时，交给系统默认浏览器处理外链与安装包下载。
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn open_external_url(url: &str) {
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("cmd").args(["/C", "start", "", url]).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg(url).spawn();
    }
}

/// 优先尝试用系统已有 Edge/Chrome 以独立配置目录 + `--app=` 应用窗口打开（不捆绑浏览器，
/// 且避免复用已运行浏览器进程后立即退出导致宿主误判关闭）；否则回退至系统默认浏览器。
fn open_ui_window(url: &str, data_dir: &Path, force_browser: bool) -> Option<Child> {
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    let _ = (data_dir, force_browser);

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    if !force_browser {
        let profile_dir = data_dir.join("ui_profile");
        let _ = std::fs::create_dir_all(&profile_dir);
        let profile_arg = format!("--user-data-dir={}", profile_dir.display());

        #[cfg(target_os = "windows")]
        {
            let mut candidates: Vec<PathBuf> = vec![
                PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
                PathBuf::from(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
                PathBuf::from(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
                PathBuf::from(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
            ];
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                candidates.push(Path::new(&local).join(r"Microsoft\Edge\Application\msedge.exe"));
                candidates.push(Path::new(&local).join(r"Google\Chrome\Application\chrome.exe"));
            }
            for exe in candidates {
                if exe.is_file() {
                    if let Ok(child) = Command::new(&exe)
                        .arg(format!("--app={url}"))
                        .arg(&profile_arg)
                        .arg("--no-first-run")
                        .arg("--no-default-browser-check")
                        .arg("--window-size=1280,800")
                        .spawn()
                    {
                        return Some(child);
                    }
                }
            }
        }
        #[cfg(target_os = "linux")]
        {
            for bin in ["microsoft-edge", "google-chrome", "chromium", "chromium-browser"] {
                if let Ok(child) = Command::new(bin)
                    .arg(format!("--app={url}"))
                    .arg(&profile_arg)
                    .arg("--no-first-run")
                    .arg("--no-default-browser-check")
                    .arg("--window-size=1280,800")
                    .spawn()
                {
                    return Some(child);
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("cmd").args(["/C", "start", "", url]).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg(url).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("xdg-open").arg(url).spawn();
    }
    None
}

fn cleanup_native_players() {
    if let Some(rt) = PC_RT.get() {
        if let Ok(mut g) = rt.active_player.lock() {
            if let Some(mut child) = g.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
#[derive(Debug)]
enum PcEvent {
    OpenPlayer { url: String },
    ClosePlayer,
    WindowAction { is_player: bool, action: String },
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn run_native_window(
    url: &str,
    data_dir: &Path,
    core: LoadedCore,
) -> Result<(), (String, LoadedCore)> {
    use tao::dpi::LogicalSize;
    use tao::event::{Event, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoopBuilder};
    use tao::window::{Fullscreen, WindowBuilder};
    use wry::{NewWindowResponse, WebContext, WebViewBuilder};

    let event_loop = EventLoopBuilder::<PcEvent>::with_user_event().build();
    let open_proxy = event_loop.create_proxy();
    let ipc_proxy = event_loop.create_proxy();
    let main_win = match WindowBuilder::new()
        .with_title("绿果PC")
        .with_inner_size(LogicalSize::new(1280.0, 800.0))
        .with_min_inner_size(LogicalSize::new(960.0, 600.0))
        .with_decorations(false)
        .with_theme(None)
        .build(&event_loop)
    {
        Ok(w) => w,
        Err(e) => return Err((format!("创建桌面窗口失败: {e}"), core)),
    };

    let webview_dir = data_dir.join("webview");
    let _ = std::fs::create_dir_all(&webview_dir);
    let mut web_ctx = WebContext::new(Some(webview_dir));
    let base_origin = url.trim_end_matches('/').to_string();
    let ipc_origin = base_origin.clone();
    let main_wv = match WebViewBuilder::new_with_web_context(&mut web_ctx)
        .with_url(url)
        .with_autoplay(true)
        .with_devtools(false)
        .with_ipc_handler(move |req| {
            if let Ok(v) = serde_json::from_str::<Value>(req.body()) {
                match v["type"].as_str() {
                    Some("openPlayer") => {
                        if let Some(play_url) = v["url"].as_str() {
                            if let Some(rest) = play_url.strip_prefix(&ipc_origin) {
                                if rest == "/play" || rest.starts_with("/play?") {
                                    let _ = ipc_proxy.send_event(PcEvent::OpenPlayer {
                                        url: play_url.to_string(),
                                    });
                                }
                            }
                        }
                    }
                    Some("win") => {
                        if let Some(act) = v["action"].as_str() {
                            let _ = ipc_proxy.send_event(PcEvent::WindowAction {
                                is_player: false,
                                action: act.to_string(),
                            });
                        }
                    }
                    _ => {}
                }
            }
        })
        .with_new_window_req_handler(move |req_url, _| {
            if let Some(rest) = req_url.strip_prefix(&base_origin) {
                if rest == "/play" || rest.starts_with("/play?") {
                    let _ = open_proxy.send_event(PcEvent::OpenPlayer { url: req_url });
                    return NewWindowResponse::Deny;
                }
            }
            if req_url.starts_with("https://") || req_url.starts_with("http://") {
                open_external_url(&req_url);
            }
            NewWindowResponse::Deny
        })
        .build(&main_win)
    {
        Ok(wv) => wv,
        Err(e) => return Err((format!("初始化桌面 WebView 失败: {e}"), core)),
    };

    let mut core_slot = Some(core);
    let mut player_slot: Option<(tao::window::Window, wry::WebView)> = None;
    let loop_proxy = event_loop.create_proxy();
    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;
        let _keep = (&main_win, &main_wv);
        match event {
            Event::UserEvent(PcEvent::OpenPlayer { url: play_url }) => {
                if let Some((ref p_win, ref p_wv)) = player_slot {
                    let _ = p_wv.load_url(&play_url);
                    p_win.set_title("绿果播放");
                    p_win.set_focus();
                } else if let Ok(p_win) = WindowBuilder::new()
                    .with_title("绿果播放")
                    .with_inner_size(LogicalSize::new(1200.0, 760.0))
                    .with_min_inner_size(LogicalSize::new(800.0, 520.0))
                    .with_decorations(false)
                    .with_theme(Some(tao::window::Theme::Dark))
                    .build(target)
                {
                    let close_proxy = loop_proxy.clone();
                    if let Ok(p_wv) = WebViewBuilder::new_with_web_context(&mut web_ctx)
                        .with_url(&play_url)
                        .with_autoplay(true)
                        .with_devtools(false)
                        .with_ipc_handler(move |req| {
                            if let Ok(v) = serde_json::from_str::<Value>(req.body()) {
                                match v["type"].as_str() {
                                    Some("closePlayer") => {
                                        let _ = close_proxy.send_event(PcEvent::ClosePlayer);
                                    }
                                    Some("win") => {
                                        if let Some(act) = v["action"].as_str() {
                                            let _ = close_proxy.send_event(PcEvent::WindowAction {
                                                is_player: true,
                                                action: act.to_string(),
                                            });
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        })
                        .build(&p_win)
                    {
                        player_slot = Some((p_win, p_wv));
                    }
                }
            }
            Event::UserEvent(PcEvent::ClosePlayer) => {
                player_slot = None;
            }
            Event::UserEvent(PcEvent::WindowAction { is_player, action }) => {
                if action == "close" {
                    if is_player {
                        player_slot = None;
                    } else {
                        player_slot = None;
                        cleanup_native_players();
                        drop(core_slot.take());
                        *control_flow = ControlFlow::Exit;
                    }
                } else {
                    let win_ref = if is_player {
                        player_slot.as_ref().map(|(w, _)| w)
                    } else {
                        Some(&main_win)
                    };
                    if let Some(win) = win_ref {
                        match action.as_str() {
                            "minimize" => win.set_minimized(true),
                            "maximize" => win.set_maximized(!win.is_maximized()),
                            "drag" => {
                                let _ = win.drag_window();
                            }
                            "fullscreen" => {
                                if win.fullscreen().is_some() {
                                    win.set_fullscreen(None);
                                } else {
                                    win.set_fullscreen(Some(Fullscreen::Borderless(None)));
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            Event::WindowEvent {
                window_id,
                event: WindowEvent::CloseRequested,
                ..
            } => {
                if player_slot.as_ref().is_some_and(|(w, _)| w.id() == window_id) {
                    player_slot = None;
                } else if window_id == main_win.id() {
                    player_slot = None;
                    cleanup_native_players();
                    drop(core_slot.take());
                    *control_flow = ControlFlow::Exit;
                }
            }
            _ => {}
        }
    });
}

fn main() {
    let mut bind = "127.0.0.1:0".to_string();
    let mut data_dir = default_pc_data_dir();
    let mut update_mode = std::env::var("LVGUO_UPDATE_MODE").ok();
    let mut custom_url = std::env::var("LVGUO_UPDATE_URL").ok();
    let mut headless = false;
    let mut browser_only = false;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--listen" => {
                if let Some(v) = args.next() {
                    bind = v;
                }
            }
            "--data-dir" => {
                if let Some(v) = args.next() {
                    data_dir = PathBuf::from(v);
                }
            }
            "--update-mode" => update_mode = args.next(),
            "--update-url" => custom_url = args.next(),
            "--headless" => headless = true,
            "--browser" => browser_only = true,
            "--help" | "-h" => {
                println!("用法: lvguo-pc [--listen 127.0.0.1:0] [--data-dir PATH] [--browser] [--headless]");
                return;
            }
            _ => {}
        }
    }

    let core = match LoadedCore::open_and_init(
        &data_dir,
        "pc",
        update_mode.as_deref(),
        custom_url.as_deref(),
        None,
    ) {
        Ok(c) => c,
        Err(e) => {
            log_pc_error(&data_dir, &format!("[lvguo-pc] 启动失败: {e}"));
            std::process::exit(1);
        }
    };

    core.register_embedded_assets();
    let has_mpv = if let Some(mpv) = find_mpv_binary() {
        let _ = PC_RT.set(Arc::new(PcRuntime {
            mpv_path: mpv,
            shader_dir: data_dir.join("shaders"),
            active_player: Mutex::new(None),
        }));
        let cb: NativePlayCallback = native_play_callback;
        core.register_native_player(cb)
    } else {
        false
    };

    let use_native_win = cfg!(any(target_os = "windows", target_os = "macos")) && !headless && !browser_only;
    let caps = json!({
        "desktop": true,
        "download": true,
        "nativePlayer": has_mpv,
        "gpuShaders": true,
        "standalonePlayer": use_native_win,
        "customTitlebar": use_native_win,
        "coreUpdate": true,
        "appVersion": env!("CARGO_PKG_VERSION")
    })
    .to_string();

    let url = match core.start_http(&bind, &caps) {
        Ok(u) => u,
        Err(e) => {
            log_pc_error(&data_dir, &format!("[lvguo-pc] 本地服务启动失败: {e}"));
            std::process::exit(1);
        }
    };

    println!(
        "[lvguo-pc] 已启动于 {url}（core v{}, mpv={}, hot={}）",
        core.version(),
        has_mpv,
        core.is_hot_loaded()
    );

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let core_for_fallback = if !headless && !browser_only {
        match run_native_window(&url, &data_dir, core) {
            Ok(()) => return,
            Err((err, recovered_core)) => {
                log_pc_error(
                    &data_dir,
                    &format!("[lvguo-pc] 原生窗口初始化失败，回退兼容浏览器模式: {err}"),
                );
                recovered_core
            }
        }
    } else {
        core
    };

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let core_for_fallback = core;

    let launched_at = std::time::Instant::now();
    let mut ui_child = if headless {
        None
    } else {
        open_ui_window(&url, &data_dir, browser_only)
    };

    // 若独立应用窗关闭则随之优雅退出；若浏览器在 3 秒内转交给已有进程退出，则继续保持本地服务存活
    loop {
        if let Some(ref mut ch) = ui_child {
            if let Ok(Some(_)) = ch.try_wait() {
                if launched_at.elapsed() >= Duration::from_secs(3) {
                    break;
                }
                ui_child = None;
            }
        }
        std::thread::sleep(Duration::from_millis(400));
    }

    cleanup_native_players();
    drop(core_for_fallback);
}
