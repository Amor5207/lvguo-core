//! 核心内置基线配置与初始化参数定义。
//!
//! 所有接口基线与路由均编译内置在单个 core 二进制内部，不依赖外置配置文件即可独立运行。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 对外稳定的 C-ABI 版本号；仅当导出函数签名产生破坏性变更时递增。
pub const CORE_ABI_VERSION: u32 = 1;

/// 当前 Core 版本号（默认来自 Cargo.toml，打 `core-v*` 标签时可通过 `LVGUO_CORE_VERSION` 覆盖）。
pub const CORE_VERSION: &str = match option_env!("LVGUO_CORE_VERSION") {
    Some(v) => {
        if v.is_empty() {
            env!("CARGO_PKG_VERSION")
        } else {
            v
        }
    }
    None => env!("CARGO_PKG_VERSION"),
};

/// 默认官方 Core 单文件更新源地址。
pub const DEFAULT_CORE_UPDATE_URL: &str = "https://update.pengfei.ink/api/v1/core/check";

/// 默认官方客户端安装包检查更新地址（Web/PC 桌面端）。
pub const DEFAULT_APP_UPDATE_URL: &str = "https://update.pengfei.ink/api/v1/desktop/check";

/// 默认播放链路端点常量（内置基线，无需外部 JSON）。
pub const LEGACY_MOBILE_ENDPOINT: &str =
    "https://api5-normal-sinfonlinea.fqnovel.com/novel/player/multi_video_model/v1/";
pub const MINI_REEL_SINGLE_ENDPOINT: &str =
    "https://api5-normal-sinfonlinea.fqnovel.com/novel/player/video_model/v1/";

/// 更新渠道插槽模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannelMode {
    /// 默认接入官方更新服务。
    #[default]
    Default,
    /// 自建更新源：只要返回符合 UPDATE_SPEC 规范的 JSON 即可完成单文件热更。
    Custom,
    /// 完全关闭网络更新，纯离线独立运行。
    Disabled,
}

/// Core 初始化配置（由宿主在调用 lvguo_init 时以 JSON 传入，可全部省略走默认值）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreInitConfig {
    /// 本地数据目录（设备注册信息、登录凭证、本地历史与热更 core 缓存所在目录）。
    #[serde(default)]
    pub data_dir: String,
    /// 宿主类型标识（web / pc / android-tv / custom），用于状态展示与运行时线程调优。
    #[serde(default)]
    pub host_kind: String,
    /// 更新渠道模式：default / custom / disabled。
    #[serde(default)]
    pub update_mode: Option<UpdateChannelMode>,
    /// 自建更新源 URL（仅 update_mode = custom 时生效）。
    #[serde(default)]
    pub custom_update_url: String,
    /// 是否允许低功耗模式（Android TV 默认更节省内存与线程）。
    #[serde(default)]
    pub low_memory: bool,
    /// 宿主客户端版本号（如 `1.0.0`，用于检查客户端安装包更新）。
    #[serde(default)]
    pub app_version: String,
    /// 自定义客户端安装包更新检查地址（留空使用官方默认地址）。
    #[serde(default)]
    pub app_update_url: String,
}

/// 单个播放路由的参数配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybackRouteConfig {
    pub endpoint: String,
    #[serde(default)]
    pub device_level: i32,
    #[serde(default)]
    pub video_platform: i32,
    #[serde(default)]
    pub need_all: Option<bool>,
}

/// 上游内容接口配置描述。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiEndpointConfig {
    pub method: String,
    pub host: String,
    #[serde(default)]
    pub backup_host: String,
    pub path: String,
    #[serde(default)]
    pub sign: String,
    #[serde(default)]
    pub query: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<serde_json::Value>,
}

/// 内置完整播放与接口策略表。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybackConfig {
    pub routes: Vec<String>,
    pub legacy: PlaybackRouteConfig,
    pub single: PlaybackRouteConfig,
    pub apis: HashMap<String, ApiEndpointConfig>,
}

/// 编译期内置的默认接口表（不依赖任何外部配置服务）。
pub fn default_api_configs() -> HashMap<String, ApiEndpointConfig> {
    let primary = "api5-normal-sinfonlinea.fqnovel.com".to_string();
    let backup = "api3-normal-sinfonlinea.fqnovel.com".to_string();
    let mut m = HashMap::new();

    m.insert(
        "detail".into(),
        ApiEndpointConfig {
            method: "POST".into(),
            host: primary.clone(),
            backup_host: backup.clone(),
            path: "/novel/player/video_detail/v1/".into(),
            sign: "v5".into(),
            query: HashMap::new(),
            body: Some(serde_json::json!({
                "biz_param": {
                    "caller_scene": "single_col",
                    "detail_page_version": 0,
                    "from_video_id": "",
                    "need_all_video_definition": false,
                    "need_mp4_align": false,
                    "source": 4,
                    "video_id_type": 1
                }
            })),
        },
    );

    m.insert(
        "detail_batch".into(),
        ApiEndpointConfig {
            method: "POST".into(),
            host: primary.clone(),
            backup_host: backup.clone(),
            path: "/novel/player/multi_video_detail/player/v1".into(),
            sign: "v5".into(),
            query: HashMap::new(),
            body: Some(serde_json::json!({
                "dr_scene": "player",
                "biz_param": {
                    "detail_page_version": 0,
                    "need_all_video_definition": false,
                    "need_mp4_align": false,
                    "source": 7,
                    "use_os_player": false,
                    "use_server_dns": false
                }
            })),
        },
    );

    let mut rank_q = HashMap::new();
    rank_q.insert("tab_type".into(), "26".into());
    rank_q.insert("client_req_type".into(), "2".into());
    rank_q.insert("client_template".into(), "2".into());
    rank_q.insert("screen_width_px".into(), "1350".into());
    m.insert(
        "rank".into(),
        ApiEndpointConfig {
            method: "GET".into(),
            host: primary.clone(),
            backup_host: backup.clone(),
            path: "/reading/bookapi/bookmall/cell/change/v1/".into(),
            sign: "v5".into(),
            query: rank_q,
            body: None,
        },
    );

    m.insert(
        "album_videos".into(),
        ApiEndpointConfig {
            method: "GET".into(),
            host: primary.clone(),
            backup_host: backup.clone(),
            path: "/api/novel/origin/album/get_video_list/v1/".into(),
            sign: "v5".into(),
            query: HashMap::new(),
            body: None,
        },
    );

    m.insert(
        "comments_book".into(),
        ApiEndpointConfig {
            method: "GET".into(),
            host: primary.clone(),
            backup_host: backup.clone(),
            path: "/reading/ugc/novel_comment/book/v1/".into(),
            sign: "v5".into(),
            query: HashMap::new(),
            body: None,
        },
    );

    m.insert(
        "comments_item".into(),
        ApiEndpointConfig {
            method: "GET".into(),
            host: primary,
            backup_host: backup,
            path: "/reading/ugc/novel_comment/item/v1/".into(),
            sign: "v5".into(),
            query: HashMap::new(),
            body: None,
        },
    );

    m
}

/// 生成内置默认播放配置。
pub fn default_playback_config() -> PlaybackConfig {
    PlaybackConfig {
        routes: vec!["dynamic".into(), "videotab".into(), "legacy".into()],
        legacy: PlaybackRouteConfig {
            endpoint: LEGACY_MOBILE_ENDPOINT.into(),
            device_level: 1,
            video_platform: 1024,
            need_all: Some(true),
        },
        single: PlaybackRouteConfig {
            endpoint: MINI_REEL_SINGLE_ENDPOINT.into(),
            device_level: 0,
            video_platform: 3,
            need_all: Some(true),
        },
        apis: default_api_configs(),
    }
}

/// 当前编译目标的标准化平台标识，供单文件更新清单匹配对应产物的唯一键。
pub fn current_target_id() -> &'static str {
    #[cfg(all(target_os = "android", target_arch = "aarch64"))]
    {
        "android-arm64-v8a"
    }
    #[cfg(all(target_os = "android", target_arch = "arm"))]
    {
        "android-armeabi-v7a"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "windows-x86_64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86"))]
    {
        "windows-x86"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "macos-aarch64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "macos-x86_64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x86_64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86"))]
    {
        "linux-x86"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-aarch64"
    }
    #[cfg(all(target_os = "linux", target_arch = "arm"))]
    {
        "linux-armv7"
    }
    #[cfg(not(any(
        all(target_os = "android", target_arch = "aarch64"),
        all(target_os = "android", target_arch = "arm"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "arm"),
    )))]
    {
        "unknown"
    }
}

/// 当前平台对应的单文件动态库标准文件名。
pub fn core_library_filename() -> &'static str {
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
