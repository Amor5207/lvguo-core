//! 绿果 Web 端极薄宿主入口（支持直接运行或一键安装为系统常驻服务）。
//!
//! 自身仅负责：
//! 1. 按「热更 core 优先 + 崩溃回退基线」加载单一 `liblvguo_core` 动态库；
//! 2. 注入内嵌 `web-ui/` 静态资产；
//! 3. 启动核心内置 HTTP 服务并保持监听；支持 `service install|uninstall|status` 一键系统服务托管。

use lvguo_host_common::LoadedCore;
use serde_json::json;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

fn default_web_data_dir() -> PathBuf {
    if let Ok(v) = std::env::var("LVGUO_DATA_DIR") {
        if !v.trim().is_empty() {
            return PathBuf::from(v.trim());
        }
    }
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("LvguoWeb")
}

fn handle_service_cmd(sub: &str, bind: &str, data_dir: &Path) {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[lvguo-web] 获取程序路径失败: {e}");
            std::process::exit(1);
        }
    };

    #[cfg(target_os = "linux")]
    {
        let unit_path = PathBuf::from("/etc/systemd/system/lvguo-web.service");
        match sub {
            "install" => {
                let unit = format!(
                    "[Unit]\nDescription=Lvguo Web Service\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart={} --listen {} --data-dir {}\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=multi-user.target\n",
                    exe.display(),
                    bind,
                    data_dir.display()
                );
                if let Err(e) = std::fs::write(&unit_path, unit) {
                    eprintln!("[lvguo-web] 写入 systemd 服务文件失败（请用 root 执行）: {e}");
                    std::process::exit(1);
                }
                let _ = Command::new("systemctl").args(["daemon-reload"]).status();
                let st = Command::new("systemctl")
                    .args(["enable", "--now", "lvguo-web.service"])
                    .status();
                match st {
                    Ok(s) if s.success() => println!("[lvguo-web] 已注册并启动 systemd 服务，监听 {bind}"),
                    _ => {
                        eprintln!("[lvguo-web] 启用 systemd 服务失败");
                        std::process::exit(1);
                    }
                }
            }
            "uninstall" => {
                let _ = Command::new("systemctl")
                    .args(["disable", "--now", "lvguo-web.service"])
                    .status();
                let _ = std::fs::remove_file(&unit_path);
                let _ = Command::new("systemctl").args(["daemon-reload"]).status();
                println!("[lvguo-web] 已卸载 systemd 服务");
            }
            "status" => {
                let _ = Command::new("systemctl")
                    .args(["status", "--no-pager", "lvguo-web.service"])
                    .status();
            }
            _ => {
                eprintln!("未知服务指令: {sub}，支持 install | uninstall | status");
                std::process::exit(1);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let task_name = "LvguoWebService";
        match sub {
            "install" => {
                let cmdline = format!(
                    "\"{}\" --listen {} --data-dir \"{}\"",
                    exe.display(),
                    bind,
                    data_dir.display()
                );
                let st = Command::new("schtasks")
                    .args(["/Create", "/F", "/SC", "ONSTART", "/RL", "HIGHEST", "/TN", task_name, "/TR", &cmdline])
                    .status();
                let _ = Command::new("schtasks").args(["/Run", "/TN", task_name]).status();
                match st {
                    Ok(s) if s.success() => println!("[lvguo-web] 已注册并启动开机后台服务 {task_name}，监听 {bind}"),
                    _ => {
                        eprintln!("[lvguo-web] 注册 Windows 计划任务服务失败（请以管理员权限运行）");
                        std::process::exit(1);
                    }
                }
            }
            "uninstall" => {
                let _ = Command::new("schtasks").args(["/End", "/TN", task_name]).status();
                let _ = Command::new("schtasks").args(["/Delete", "/F", "/TN", task_name]).status();
                println!("[lvguo-web] 已移除后台服务 {task_name}");
            }
            "status" => {
                let _ = Command::new("schtasks").args(["/Query", "/TN", task_name]).status();
            }
            _ => {
                eprintln!("未知服务指令: {sub}，支持 install | uninstall | status");
                std::process::exit(1);
            }
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = (sub, bind, data_dir, exe);
        eprintln!("[lvguo-web] 当前系统请使用 launchd / supervisor 直接托管二进制: --listen {bind}");
    }
}

fn pause_before_exit() {
    #[cfg(target_os = "windows")]
    {
        use std::io::Read;
        eprintln!("\n按回车键退出...");
        let _ = std::io::stdin().read(&mut [0u8; 1]);
    }
}

fn resolve_bind_from_env() -> (String, String, String) {
    let host = std::env::var("LVGUO_HOST")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "0.0.0.0".to_string());
    let port = std::env::var("LVGUO_PORT")
        .ok()
        .or_else(|| std::env::var("PORT").ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "8780".to_string());
    let bind = std::env::var("LVGUO_LISTEN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("{host}:{port}"));
    (bind, host, port)
}

fn main() {
    let (env_bind, mut host, mut port) = resolve_bind_from_env();
    let mut bind_override: Option<String> = None;
    let mut host_port_override = false;
    let mut data_dir = default_web_data_dir();
    let mut update_mode = std::env::var("LVGUO_UPDATE_MODE").ok();
    let mut custom_url = std::env::var("LVGUO_UPDATE_URL").ok();
    let mut core_path: Option<PathBuf> = std::env::var("LVGUO_CORE_PATH")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from);
    let mut service_cmd: Option<String> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "service" => {
                service_cmd = Some(args.next().unwrap_or_else(|| "status".to_string()));
            }
            "--listen" => {
                if let Some(v) = args.next() {
                    bind_override = Some(v);
                }
            }
            "--host" => {
                if let Some(v) = args.next() {
                    host = v;
                    host_port_override = true;
                }
            }
            "--port" => {
                if let Some(v) = args.next() {
                    port = v;
                    host_port_override = true;
                }
            }
            "--data-dir" => {
                if let Some(v) = args.next() {
                    data_dir = PathBuf::from(v);
                }
            }
            "--update-mode" => update_mode = args.next(),
            "--update-url" => custom_url = args.next(),
            "--core" => core_path = args.next().map(PathBuf::from),
            "--help" | "-h" => {
                println!(
                    "用法:\n  lvguo-web [--listen IP:PORT | --host IP --port PORT] [--data-dir PATH]\n  lvguo-web service install|uninstall|status [--listen IP:PORT]\n环境变量:\n  LVGUO_HOST=0.0.0.0|127.0.0.1  LVGUO_PORT=8780  LVGUO_LISTEN=IP:PORT  LVGUO_DATA_DIR=PATH"
                );
                return;
            }
            _ => {}
        }
    }

    let bind = bind_override.unwrap_or_else(|| {
        if host_port_override {
            format!("{host}:{port}")
        } else {
            env_bind
        }
    });

    if let Some(sub) = service_cmd {
        handle_service_cmd(&sub, &bind, &data_dir);
        return;
    }

    let core = match LoadedCore::open_and_init(
        &data_dir,
        "web",
        update_mode.as_deref(),
        custom_url.as_deref(),
        core_path.as_deref(),
    ) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[lvguo-web] 启动失败: {e}");
            pause_before_exit();
            std::process::exit(1);
        }
    };

    core.register_embedded_assets();
    let caps = json!({
        "desktop": false,
        "download": false,
        "nativePlayer": false,
        "gpuShaders": false,
        "coreUpdate": true
    })
    .to_string();

    let url = match core.start_http(&bind, &caps) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[lvguo-web] HTTP 服务启动失败: {e}");
            pause_before_exit();
            std::process::exit(1);
        }
    };

    let bin_hint = if cfg!(target_os = "windows") {
        "lvguo-web.exe"
    } else {
        "lvguo-web"
    };
    println!("[lvguo-web] 已启动于 {url}（core v{}）", core.version());
    if url.contains("0.0.0.0") {
        if let Some((_, p)) = url.strip_prefix("http://").and_then(|s| s.rsplit_once(':')) {
            println!("  本机访问: http://127.0.0.1:{p}");
        }
    }
    println!("[lvguo-web] 可用环境变量说明（用于覆盖默认监听与核心路径配置）:");
    println!("  LVGUO_HOST         监听网卡地址（默认 0.0.0.0 允许局域网访问；设 127.0.0.1 仅本机访问）");
    println!("  LVGUO_PORT         监听端口号（默认 8780，与 --port 作用相同）");
    println!("  LVGUO_LISTEN       完整监听地址 IP:PORT（优先级高于 LVGUO_HOST / LVGUO_PORT）");
    println!("  LVGUO_DATA_DIR     数据与热更新存放目录（保存账号会话、观看记录与 core_hot 动态库）");
    println!("  LVGUO_UPDATE_MODE  Core 更新模式：default（官方源）/ custom（自建源）/ disabled（纯离线）");
    println!("  LVGUO_UPDATE_URL   更新模式为 custom 时的自建 Manifest 清单 URL");
    println!("  LVGUO_CORE_PATH    手动指定外部 liblvguo_core.so / lvguo_core.dll 动态库路径");
    println!("[lvguo-web] 系统服务: {bin_hint} service install|uninstall|status");

    let running = Arc::new(AtomicBool::new(true));
    while running.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_secs(1));
    }
}
