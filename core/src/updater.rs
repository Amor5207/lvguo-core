//! 插槽式单文件 Core 自更新模块。
//!
//! 设计原则：
//! 1. **只更新单个 core 动态库文件**：下载校验仅针对当前平台对应的唯一 `.so` / `.dll` / `.dylib`，
//!    不下载也不生成任何外置配置文件（例如 JSON 策略或 DEX 模块）。
//! 2. **插槽式渠道切换**：通过 `UpdateProvider` 抽象提供三档策略：
//!    - `default`：接入官方更新服务；
//!    - `custom`：接入任意符合 `sdk/UPDATE_SPEC.md` 规范的自建更新清单 URL；
//!    - `disabled`：完全关闭更新检查，不发起任何外部请求，纯离线独立运行。
//! 3. **安全落地校验**：SHA-256 校验 + 二进制魔数校验（ELF / PE / Mach-O）+ 原子替换，
//!    防止残包或错误架构包破坏启动。

use crate::config::{
    core_library_filename, current_target_id, UpdateChannelMode, CORE_ABI_VERSION, CORE_VERSION,
    DEFAULT_APP_UPDATE_URL, DEFAULT_CORE_UPDATE_URL,
};
use crate::upstream::device::now_secs;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 热更目录名（位于 data_dir 下，仅存放单个最新 core 二进制文件与瞬态加载保护标记）。
pub const CORE_HOT_DIR: &str = "core_hot";

/// 单个平台的 Core 产物描述。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreArtifactInfo {
    #[serde(default)]
    pub filename: String,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub size: u64,
}

/// 公开更新清单结构（官方接口与第三方自建更新源共用同一协议）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreManifest {
    #[serde(default = "default_schema")]
    pub schema: i32,
    #[serde(default = "default_abi")]
    pub abi_version: u32,
    pub version: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub published_at: String,
    #[serde(default)]
    pub update: Option<bool>,
    #[serde(default)]
    pub artifact: Option<CoreArtifactInfo>,
    #[serde(default)]
    pub artifacts: HashMap<String, CoreArtifactInfo>,
}

fn default_schema() -> i32 {
    1
}
fn default_abi() -> u32 {
    CORE_ABI_VERSION
}

/// 热更新运行状态快照（供各端设置页读取展示）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreUpdateStatus {
    pub mode: UpdateChannelMode,
    pub custom_url: String,
    pub default_url: String,
    pub effective_url: String,
    pub current_version: String,
    pub abi_version: u32,
    pub target: String,
    pub filename: String,
    pub hot_path: String,
    pub staged_exists: bool,
    pub staged_version: String,
    pub latest_version: String,
    pub latest_notes: String,
    pub update_available: bool,
    pub restart_required: bool,
    pub last_check_at: i64,
    pub last_error: String,
}

/// 客户端软件更新检查结果（供 Web/PC 及自定义宿主检查软件本身升级）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateCheckResult {
    pub ok: bool,
    pub disabled: bool,
    pub has_update: bool,
    pub current_version: String,
    pub latest_version: String,
    pub notes: String,
    pub release_url: String,
    pub download_url: String,
    pub asset_name: String,
    pub asset_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChannelPrefs {
    mode: UpdateChannelMode,
    #[serde(default)]
    custom_url: String,
}

impl Default for ChannelPrefs {
    fn default() -> Self {
        Self {
            mode: UpdateChannelMode::Default,
            custom_url: String::new(),
        }
    }
}

/// 更新源插槽抽象：任何自定义更新器只需实现该接口即可替换默认更新源。
pub trait UpdateProvider: Send + Sync {
    fn mode(&self) -> UpdateChannelMode;
    fn effective_url(&self) -> String;
    fn fetch_manifest<'a>(
        &'a self,
        http: &'a Client,
        target: &'a str,
        current_version: &'a str,
        abi_version: u32,
    ) -> Pin<Box<dyn Future<Output = Result<Option<CoreManifest>, String>> + Send + 'a>>;
}

/// 标准 HTTP 清单更新源（服务于官方源与自建 JSON 源）。
pub struct HttpManifestProvider {
    mode: UpdateChannelMode,
    base_url: String,
}

impl HttpManifestProvider {
    pub fn new(mode: UpdateChannelMode, base_url: String) -> Self {
        Self { mode, base_url }
    }
}

impl UpdateProvider for HttpManifestProvider {
    fn mode(&self) -> UpdateChannelMode {
        self.mode
    }

    fn effective_url(&self) -> String {
        self.base_url.clone()
    }

    fn fetch_manifest<'a>(
        &'a self,
        http: &'a Client,
        target: &'a str,
        current_version: &'a str,
        abi_version: u32,
    ) -> Pin<Box<dyn Future<Output = Result<Option<CoreManifest>, String>> + Send + 'a>> {
        Box::pin(async move {
            let trimmed = self.base_url.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            let sep = if trimmed.contains('?') { '&' } else { '?' };
            let url = format!(
                "{trimmed}{sep}target={}&version={}&abiVersion={abi_version}",
                url::form_urlencoded::byte_serialize(target.as_bytes()).collect::<String>(),
                url::form_urlencoded::byte_serialize(current_version.as_bytes()).collect::<String>(),
            );
            let resp = http
                .get(&url)
                .timeout(Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("检查更新失败: {e}"))?;
            if !resp.status().is_success() {
                return Err(format!("更新服务返回异常状态: HTTP {}", resp.status()));
            }
            let bytes = resp.bytes().await.map_err(|e| format!("读取更新清单失败: {e}"))?;
            if bytes.len() > 256 * 1024 {
                return Err("更新清单体积超出限制".into());
            }
            let manifest: CoreManifest =
                serde_json::from_slice(&bytes).map_err(|e| format!("解析更新清单失败: {e}"))?;
            Ok(Some(manifest))
        })
    }
}

/// 离线独立模式插槽：不发起任何网络更新请求。
pub struct DisabledUpdateProvider;

impl UpdateProvider for DisabledUpdateProvider {
    fn mode(&self) -> UpdateChannelMode {
        UpdateChannelMode::Disabled
    }

    fn effective_url(&self) -> String {
        String::new()
    }

    fn fetch_manifest<'a>(
        &'a self,
        _http: &'a Client,
        _target: &'a str,
        _current_version: &'a str,
        _abi_version: u32,
    ) -> Pin<Box<dyn Future<Output = Result<Option<CoreManifest>, String>> + Send + 'a>> {
        Box::pin(async { Ok(None) })
    }
}

struct UpdaterState {
    prefs: ChannelPrefs,
    latest_version: String,
    latest_notes: String,
    staged_version: String,
    restart_required: bool,
    last_check_at: i64,
    last_error: String,
}

/// Core 单文件自更新管理器。
pub struct CoreUpdater {
    data_dir: PathBuf,
    http: Client,
    prefs_path: PathBuf,
    state: Mutex<UpdaterState>,
    check_lock: tokio::sync::Mutex<()>,
}

impl CoreUpdater {
    /// 创建更新管理器；若初始化参数显式指定了更新模式，则优先生效。
    pub fn new(
        data_dir: &Path,
        http: Client,
        init_mode: Option<UpdateChannelMode>,
        init_custom_url: &str,
    ) -> Arc<Self> {
        let prefs_path = data_dir.join("core_channel.json");
        let mut prefs = std::fs::read_to_string(&prefs_path)
            .ok()
            .and_then(|s| serde_json::from_str::<ChannelPrefs>(&s).ok())
            .unwrap_or_default();
        if let Some(m) = init_mode {
            prefs.mode = m;
        }
        if !init_custom_url.trim().is_empty() {
            prefs.custom_url = init_custom_url.trim().to_string();
        }
        Arc::new(Self {
            data_dir: data_dir.to_path_buf(),
            http,
            prefs_path,
            state: Mutex::new(UpdaterState {
                prefs,
                latest_version: String::new(),
                latest_notes: String::new(),
                staged_version: String::new(),
                restart_required: false,
                last_check_at: 0,
                last_error: String::new(),
            }),
            check_lock: tokio::sync::Mutex::new(()),
        })
    }

    /// 构造当前生效的更新源插槽实现。
    pub fn active_provider(&self) -> Box<dyn UpdateProvider> {
        let prefs = self.state.lock().unwrap().prefs.clone();
        match prefs.mode {
            UpdateChannelMode::Default => Box::new(HttpManifestProvider::new(
                UpdateChannelMode::Default,
                DEFAULT_CORE_UPDATE_URL.to_string(),
            )),
            UpdateChannelMode::Custom => {
                if valid_update_url(&prefs.custom_url) {
                    Box::new(HttpManifestProvider::new(
                        UpdateChannelMode::Custom,
                        prefs.custom_url,
                    ))
                } else {
                    Box::new(DisabledUpdateProvider)
                }
            }
            UpdateChannelMode::Disabled => Box::new(DisabledUpdateProvider),
        }
    }

    /// 单文件热更新目标落盘路径（`<data_dir>/core_hot/<core_filename>`）。
    pub fn hot_library_path(&self) -> PathBuf {
        self.data_dir
            .join(CORE_HOT_DIR)
            .join(core_library_filename())
    }

    /// 切换更新渠道模式与自建更新 URL，并持久化渠道偏好。
    pub fn set_channel(
        &self,
        mode: UpdateChannelMode,
        custom_url: Option<&str>,
    ) -> Result<CoreUpdateStatus, String> {
        let clean_url = custom_url.map(|s| s.trim().to_string());
        if mode == UpdateChannelMode::Custom {
            let candidate = clean_url
                .as_deref()
                .unwrap_or("")
                .trim();
            if !candidate.is_empty() && !valid_update_url(candidate) {
                return Err("自建更新地址必须为合法的 http/https URL".into());
            }
        }
        {
            let mut st = self.state.lock().unwrap();
            st.prefs.mode = mode;
            if let Some(u) = clean_url {
                if u.is_empty() || valid_update_url(&u) {
                    st.prefs.custom_url = u;
                }
            }
            st.last_error.clear();
            let serialized = serde_json::to_string_pretty(&st.prefs).map_err(|e| e.to_string())?;
            let tmp = self.prefs_path.with_extension("tmp");
            std::fs::write(&tmp, serialized).map_err(|e| e.to_string())?;
            let _ = std::fs::rename(&tmp, &self.prefs_path);
        }
        Ok(self.status())
    }

    /// 清理已下载的热更 core 文件，下次启动自动回到宿主内置基线库。
    pub fn rollback_hot_core(&self) -> CoreUpdateStatus {
        let hot = self.hot_library_path();
        let _ = std::fs::remove_file(&hot);
        let _ = std::fs::remove_file(hot.with_extension("attempt"));
        {
            let mut st = self.state.lock().unwrap();
            st.staged_version.clear();
            st.restart_required = false;
            st.last_error.clear();
        }
        self.status()
    }

    /// 在后台启动一次性自检（不阻塞宿主启动首帧）。
    pub fn start_background(self: &Arc<Self>, rt: &tokio::runtime::Handle) {
        let this = self.clone();
        rt.spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let _ = this.check_and_download(true).await;
        });
    }

    /// 检查更新；当 `auto_download = true` 且发现兼容 ABI 的新版时自动下载单个 core 文件。
    pub async fn check_and_download(&self, auto_download: bool) -> Result<CoreUpdateStatus, String> {
        let _guard = self.check_lock.lock().await;
        let provider = self.active_provider();
        if provider.mode() == UpdateChannelMode::Disabled {
            return Ok(self.status());
        }
        if provider.effective_url().is_empty() {
            let mut st = self.state.lock().unwrap();
            st.last_error = "自定义更新源地址未配置或无效".into();
            return Err(st.last_error.clone());
        }

        let target = current_target_id();
        let manifest_opt = match provider
            .fetch_manifest(&self.http, target, CORE_VERSION, CORE_ABI_VERSION)
            .await
        {
            Ok(m) => m,
            Err(e) => {
                let mut st = self.state.lock().unwrap();
                st.last_check_at = now_secs();
                st.last_error = e.clone();
                return Err(e);
            }
        };

        let Some(manifest) = manifest_opt else {
            return Ok(self.status());
        };

        // 严格校验 ABI 兼容性，避免主版本号不匹配导致宿主符号缺失崩溃
        if manifest.abi_version != CORE_ABI_VERSION {
            let msg = format!(
                "远端核心 ABI v{} 与当前宿主期待 ABI v{} 不兼容，请升级宿主安装包",
                manifest.abi_version, CORE_ABI_VERSION
            );
            let mut st = self.state.lock().unwrap();
            st.last_check_at = now_secs();
            st.latest_version = manifest.version;
            st.latest_notes = manifest.notes;
            st.last_error = msg.clone();
            return Err(msg);
        }

        let artifact = manifest
            .artifact
            .clone()
            .or_else(|| manifest.artifacts.get(target).cloned());

        let newer = is_newer_version(&manifest.version, CORE_VERSION)
            && manifest.update.unwrap_or(true);
        let already_staged = {
            let st = self.state.lock().unwrap();
            !st.staged_version.is_empty() && !is_newer_version(&manifest.version, &st.staged_version)
        };

        {
            let mut st = self.state.lock().unwrap();
            st.last_check_at = now_secs();
            st.latest_version = manifest.version.clone();
            st.latest_notes = manifest.notes.clone();
            st.last_error.clear();
        }

        if auto_download && newer && !already_staged {
            if let Some(art) = artifact {
                if let Err(e) = self.download_single_core(&manifest.version, &art).await {
                    let mut st = self.state.lock().unwrap();
                    st.last_error = e.clone();
                    return Err(e);
                }
            }
        }

        Ok(self.status())
    }

    async fn download_single_core(
        &self,
        next_version: &str,
        art: &CoreArtifactInfo,
    ) -> Result<(), String> {
        if !valid_update_url(&art.url) {
            return Err("核心下载地址协议无效".into());
        }
        let expected_sha = art.sha256.trim().to_ascii_lowercase();
        if expected_sha.len() != 64 || !expected_sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("核心产物 SHA-256 校验摘要格式无效".into());
        }

        let resp = self
            .http
            .get(&art.url)
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(|e| format!("下载核心更新失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("下载核心失败: HTTP {}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| format!("读取核心文件失败: {e}"))?;
        if bytes.len() < 4096 || bytes.len() > 64 * 1024 * 1024 {
            return Err("下载的核心文件大小异常".into());
        }
        if art.size > 0 && bytes.len() as u64 != art.size {
            return Err("下载的核心文件字节数不匹配".into());
        }
        if !verify_binary_magic(&bytes) {
            return Err("下载的文件不是当前平台合法的动态库格式".into());
        }

        let actual_sha = hex::encode(Sha256::digest(&bytes));
        if actual_sha != expected_sha {
            return Err(format!(
                "核心文件 SHA-256 校验失败（期望 {expected_sha}，实际 {actual_sha}）"
            ));
        }

        let hot_path = self.hot_library_path();
        if let Some(parent) = hot_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建热更目录失败: {e}"))?;
        }
        let part = hot_path.with_extension("part");
        std::fs::write(&part, &bytes).map_err(|e| format!("写入核心文件失败: {e}"))?;

        // Android 14+ 要求动态加载的原生库为只读，否则可能被系统拒绝加载
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o444));
            if hot_path.exists() {
                let _ = std::fs::set_permissions(&hot_path, std::fs::Permissions::from_mode(0o644));
            }
        }
        std::fs::rename(&part, &hot_path).map_err(|e| format!("切换核心文件失败: {e}"))?;
        let _ = std::fs::remove_file(hot_path.with_extension("attempt"));

        let mut st = self.state.lock().unwrap();
        st.staged_version = next_version.to_string();
        st.restart_required = true;
        st.last_error.clear();
        Ok(())
    }

    /// 返回当前更新状态快照。
    pub fn status(&self) -> CoreUpdateStatus {
        let provider = self.active_provider();
        let st = self.state.lock().unwrap();
        let hot = self.hot_library_path();
        let staged_exists = hot.is_file();
        let update_available = !st.latest_version.is_empty()
            && is_newer_version(&st.latest_version, CORE_VERSION);
        CoreUpdateStatus {
            mode: st.prefs.mode,
            custom_url: st.prefs.custom_url.clone(),
            default_url: DEFAULT_CORE_UPDATE_URL.to_string(),
            effective_url: provider.effective_url(),
            current_version: CORE_VERSION.to_string(),
            abi_version: CORE_ABI_VERSION,
            target: current_target_id().to_string(),
            filename: core_library_filename().to_string(),
            hot_path: hot.to_string_lossy().to_string(),
            staged_exists,
            staged_version: st.staged_version.clone(),
            latest_version: st.latest_version.clone(),
            latest_notes: st.latest_notes.clone(),
            update_available,
            restart_required: st.restart_required,
            last_check_at: st.last_check_at,
            last_error: st.last_error.clone(),
        }
    }

    /// 检查宿主软件本身（EXE/AppImage/DMG）是否有新版本发布；禁用更新通道时纯离线返回。
    pub async fn check_app_update(
        &self,
        app_version: &str,
        app_update_url: &str,
    ) -> Result<AppUpdateCheckResult, String> {
        let cur_ver = if app_version.trim().is_empty() {
            CORE_VERSION
        } else {
            app_version.trim()
        };
        if self.active_provider().mode() == UpdateChannelMode::Disabled {
            return Ok(AppUpdateCheckResult {
                ok: true,
                disabled: true,
                has_update: false,
                current_version: cur_ver.to_string(),
                latest_version: String::new(),
                notes: String::new(),
                release_url: String::new(),
                download_url: String::new(),
                asset_name: String::new(),
                asset_size: 0,
            });
        }
        let custom_app_base = {
            let st = self.state.lock().unwrap();
            if st.prefs.mode == UpdateChannelMode::Custom {
                let raw = st.prefs.custom_url.trim();
                if let Ok(u) = reqwest::Url::parse(raw) {
                    if !u.path().ends_with(".json") {
                        Some(format!("{}://{}/api/v1/desktop/check", u.scheme(), u.host_str().unwrap_or_default()))
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        };
        let base = if !app_update_url.trim().is_empty() {
            app_update_url.trim().to_string()
        } else if let Some(derived) = custom_app_base {
            derived
        } else {
            DEFAULT_APP_UPDATE_URL.to_string()
        };
        let os_key = match std::env::consts::OS {
            "windows" => "windows",
            "macos" => "macos",
            _ => "linux",
        };
        let arch_key = match std::env::consts::ARCH {
            "x86_64" => "x86_64",
            "x86" => "x86",
            "aarch64" => "aarch64",
            "arm" => "armv7",
            other => other,
        };
        let sep = if base.contains('?') { '&' } else { '?' };
        let url = format!(
            "{base}{sep}version={}&os={os_key}&arch={arch_key}",
            url::form_urlencoded::byte_serialize(cur_ver.as_bytes()).collect::<String>()
        );
        let resp = self
            .http
            .get(&url)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("检查软件更新失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("软件更新服务返回异常状态: HTTP {}", resp.status()));
        }
        let v: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("解析软件更新响应失败: {e}"))?;
        let latest = v["latestVersion"].as_str().unwrap_or("").to_string();
        let has_update = v["hasUpdate"]
            .as_bool()
            .unwrap_or_else(|| !latest.is_empty() && is_newer_version(&latest, cur_ver));
        Ok(AppUpdateCheckResult {
            ok: true,
            disabled: false,
            has_update,
            current_version: cur_ver.to_string(),
            latest_version: latest,
            notes: v["notes"].as_str().unwrap_or("").to_string(),
            release_url: v["releaseUrl"].as_str().unwrap_or("").to_string(),
            download_url: v["downloadUrl"].as_str().unwrap_or("").to_string(),
            asset_name: v["assetName"].as_str().unwrap_or("").to_string(),
            asset_size: v["assetSize"].as_u64().unwrap_or(0),
        })
    }
}

fn valid_update_url(raw: &str) -> bool {
    let s = raw.trim();
    if s.is_empty() {
        return false;
    }
    match reqwest::Url::parse(s) {
        Ok(u) => matches!(u.scheme(), "http" | "https") && u.host_str().is_some(),
        Err(_) => false,
    }
}

fn verify_binary_magic(bytes: &[u8]) -> bool {
    if bytes.len() < 4 {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        bytes[0] == b'M' && bytes[1] == b'Z'
    }
    #[cfg(target_os = "macos")]
    {
        let magic = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        matches!(
            magic,
            0xFEED_FACE | 0xCEFA_EDFE | 0xFEED_FACF | 0xCFFA_EDFE | 0xCAFE_BABE | 0xBEBA_FECA
        )
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        bytes[0..4] == [0x7F, b'E', b'L', b'F']
    }
}

/// 语义化版本号对比：判断 `candidate` 是否严格高于 `current`。
pub fn is_newer_version(candidate: &str, current: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.trim()
            .trim_start_matches(['v', 'V'])
            .split(['-', '+'])
            .next()
            .unwrap_or("")
            .split('.')
            .filter_map(|p| p.parse::<u64>().ok())
            .collect()
    };
    let a = parse(candidate);
    let b = parse(current);
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let len = a.len().max(b.len());
    for i in 0..len {
        let av = *a.get(i).unwrap_or(&0);
        let bv = *b.get(i).unwrap_or(&0);
        if av != bv {
            return av > bv;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compare_works() {
        assert!(is_newer_version("1.0.1", "1.0.0"));
        assert!(is_newer_version("v1.1.0", "1.0.9"));
        assert!(!is_newer_version("1.0.0", "1.0.0"));
        assert!(!is_newer_version("0.9.9", "1.0.0"));
    }
}
