//! 统一业务运行时与分发引擎。
//!
//! 性能优化重点：
//! - 全局共享**单一多线程 Tokio Runtime**（按 CPU 核数自适应 `clamp(2, 8)`，低内存/TV 模式 `clamp(2, 4)`），
//!   避免多套独立线程池叠加导致额外线程栈内存消耗与调度上下文切换；
//! - 所有业务动作均通过统一 `dispatch(action, params)` 异步并发执行，C-ABI、JNI 与内嵌 HTTP 共用同一条代码路径。

use crate::config::{CoreInitConfig, UpdateChannelMode, CORE_ABI_VERSION, CORE_VERSION};
use crate::downloader::DownloadManager;
use crate::models::{AddDownloadRequest, DownloadActionRequest, DownloadSettings, HostCapabilities};
use crate::media_server::MediaServer;
use crate::upstream::account::Account;
use crate::upstream::auth::{PhoneLogin, PhoneLoginOutcome, QrSession};
use crate::upstream::content::Content;
use crate::upstream::device::{build_http_client, now_secs, DeviceStore, UserJar};
use crate::updater::CoreUpdater;
use once_cell::sync::OnceCell;
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::runtime::Runtime;
use uuid::Uuid;

/// 宿主原生播放器回调类型（由 PC 等宿主可选注入：输入 JSON，返回响应 JSON）。
pub type NativePlayHook = Arc<dyn Fn(Value) -> Result<Value, String> + Send + Sync>;

/// 静态资源查找函数签名：给定请求路径（如 `/pc/app.js`），返回 `Some((mime, bytes))`。
pub type StaticAssetLookup = Arc<dyn Fn(&str) -> Option<(&'static str, Vec<u8>)> + Send + Sync>;

/// 核心全局运行上下文。
pub struct AppCore {
    pub rt: Runtime,
    pub data_dir: PathBuf,
    pub http: Client,
    pub devices: Arc<DeviceStore>,
    pub user: Arc<UserJar>,
    pub updater: Arc<CoreUpdater>,
    pub account: Arc<Account>,
    pub content: Arc<Content>,
    pub downloader: Arc<DownloadManager>,
    pub media_server: Arc<MediaServer>,
    capabilities: Mutex<HostCapabilities>,
    native_play_hook: Mutex<Option<NativePlayHook>>,
    static_lookup: Mutex<Option<StaticAssetLookup>>,
    static_dir: Mutex<Option<PathBuf>>,
    http_bind_addr: Mutex<Option<String>>,
    http_stop_tx: Mutex<Option<tokio::sync::watch::Sender<bool>>>,
    app_version: String,
    app_update_url: String,
    qr_sessions: tokio::sync::Mutex<HashMap<String, QrSession>>,
    phone_sessions: tokio::sync::Mutex<HashMap<String, PhoneLogin>>,
    last_heartbeat_at: Mutex<i64>,
}

static CORE: OnceCell<Mutex<Option<Arc<AppCore>>>> = OnceCell::new();

fn core_slot() -> &'static Mutex<Option<Arc<AppCore>>> {
    CORE.get_or_init(|| Mutex::new(None))
}

/// 获取当前已初始化的核心实例。
pub fn current_core() -> Result<Arc<AppCore>, String> {
    core_slot()
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "核心尚未初始化".to_string())
}

/// 根据设备核数与运行模式自适应计算 Tokio 工作线程数，兼顾高并发吞吐与低内存占用。
fn optimal_worker_threads(cfg: &CoreInitConfig) -> usize {
    let cpus = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    let is_android = cfg!(target_os = "android") || cfg.low_memory || cfg.host_kind == "android-tv";
    if is_android {
        cpus.clamp(2, 4)
    } else {
        cpus.clamp(2, 8)
    }
}

/// 初始化或复用核心单实例（支持 C-ABI 与 Android JNI）。
pub fn init_core(cfg: CoreInitConfig) -> Result<Arc<AppCore>, String> {
    let data_dir = if cfg.data_dir.trim().is_empty() {
        dirs::data_local_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("Lvguo")
    } else {
        PathBuf::from(cfg.data_dir.trim())
    };
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("创建数据目录失败: {e}"))?;

    {
        let guard = core_slot().lock().unwrap();
        if let Some(existing) = guard.as_ref() {
            return Ok(existing.clone());
        }
    }

    let workers = optimal_worker_threads(&cfg);
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(workers)
        .max_blocking_threads(workers.max(2))
        .thread_name("lvguo-core")
        .build()
        .map_err(|e| format!("启动核心异步运行时失败: {e}"))?;

    let http = build_http_client(30);
    let devices = Arc::new(DeviceStore::new(&data_dir, http.clone()));
    let user = Arc::new(UserJar::new(&data_dir));
    let updater = CoreUpdater::new(&data_dir, http.clone(), cfg.update_mode, &cfg.custom_update_url);
    updater.start_background(rt.handle());

    let account = Account::new(&data_dir, http.clone(), devices.clone(), user.clone());
    let content = Content::new(http.clone(), devices.clone());
    let downloader = DownloadManager::new_with_mode(
        data_dir.clone(),
        content.clone(),
        rt.handle(),
        cfg.host_kind != "web",
    );
    let media_server = MediaServer::start(content.clone(), http.clone(), rt.handle())?;

    let mut caps = HostCapabilities {
        core_version: CORE_VERSION.to_string(),
        target: crate::config::current_target_id().to_string(),
        core_update: true,
        ..Default::default()
    };
    if cfg.host_kind == "pc" {
        caps.desktop = true;
        caps.download = true;
    }

    let core = Arc::new(AppCore {
        rt,
        data_dir,
        http,
        devices,
        user,
        updater,
        account,
        content,
        downloader,
        media_server,
        capabilities: Mutex::new(caps),
        native_play_hook: Mutex::new(None),
        static_lookup: Mutex::new(None),
        static_dir: Mutex::new(None),
        http_bind_addr: Mutex::new(None),
        http_stop_tx: Mutex::new(None),
        app_version: if cfg.app_version.trim().is_empty() {
            CORE_VERSION.to_string()
        } else {
            cfg.app_version.trim().to_string()
        },
        app_update_url: cfg.app_update_url.trim().to_string(),
        qr_sessions: tokio::sync::Mutex::new(HashMap::new()),
        phone_sessions: tokio::sync::Mutex::new(HashMap::new()),
        last_heartbeat_at: Mutex::new(0),
    });

    // 提前预热设备身份、推荐首页；已登录用户顺便对齐脏进度，消除首屏冷启动卡顿
    {
        let c2 = core.clone();
        core.rt.spawn(async move {
            let _ = c2.devices.get().await;
            if c2.user.logged_in() {
                c2.account.flush_dirty_progress().await;
            }
            let _ = c2.content.for_you(&c2.account, "16", 0, "", "").await;
        });
    }

    *core_slot().lock().unwrap() = Some(core.clone());
    Ok(core)
}

/// 关闭并释放核心全局运行实例。
pub fn shutdown_core() {
    let taken = core_slot().lock().unwrap().take();
    if let Some(c) = taken {
        if let Some(tx) = c.http_stop_tx.lock().unwrap().take() {
            let _ = tx.send(true);
        }
        c.media_server.shutdown();
        c.downloader.shutdown();
    }
}

impl AppCore {
    /// 读取宿主运行能力描述。
    pub fn capabilities(&self) -> HostCapabilities {
        let mut caps = self.capabilities.lock().unwrap().clone();
        caps.core_version = CORE_VERSION.to_string();
        caps.target = crate::config::current_target_id().to_string();
        caps
    }

    /// 更新宿主能力标志。
    pub fn set_capabilities(&self, mut next: HostCapabilities) {
        next.core_version = CORE_VERSION.to_string();
        next.target = crate::config::current_target_id().to_string();
        *self.capabilities.lock().unwrap() = next;
    }

    /// 注入宿主静态资源查找表（用于单一可执行文件内置 Web UI）。
    pub fn set_static_lookup(&self, lookup: StaticAssetLookup) {
        *self.static_lookup.lock().unwrap() = Some(lookup);
    }

    /// 设置外置静态目录回退路径。
    pub fn set_static_dir(&self, dir: Option<PathBuf>) {
        *self.static_dir.lock().unwrap() = dir;
    }

    /// 注入原生播放窗口回调。
    pub fn set_native_play_hook(&self, hook: NativePlayHook) {
        *self.native_play_hook.lock().unwrap() = Some(hook);
        self.capabilities.lock().unwrap().native_player = true;
    }

    /// 读取内置或外置静态资源。
    pub fn load_static_asset(&self, req_path: &str) -> Option<(&'static str, Vec<u8>)> {
        if let Some(lookup) = self.static_lookup.lock().unwrap().as_ref().cloned() {
            if let Some(found) = lookup(req_path) {
                return Some(found);
            }
        }
        let dir = self.static_dir.lock().unwrap().clone()?;
        let clean = req_path.trim_start_matches('/');
        if clean.contains("..") {
            return None;
        }
        let candidate = if clean.is_empty() {
            dir.join("pc/index.html")
        } else {
            dir.join(clean)
        };
        if !candidate.is_file() {
            return None;
        }
        let bytes = std::fs::read(&candidate).ok()?;
        let mime = guess_mime(&candidate.to_string_lossy());
        Some((mime, bytes))
    }

    /// 调用宿主注册的原生播放器（若有）。
    pub fn invoke_native_play(&self, payload: Value) -> Result<Value, String> {
        let hook = self
            .native_play_hook
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "当前宿主未注册原生播放器".to_string())?;
        hook(payload)
    }

    /// 启动（或复用）内嵌异步 HTTP 服务，返回真实监听地址（如 `127.0.0.1:43210`）。
    pub fn start_http(
        self: &Arc<Self>,
        bind_addr: &str,
        static_dir: Option<&str>,
        caps_json: Option<&str>,
    ) -> Result<String, String> {
        if let Some(existing) = self.http_bind_addr.lock().unwrap().clone() {
            return Ok(existing);
        }
        if let Some(sd) = static_dir {
            let trimmed = sd.trim();
            if !trimmed.is_empty() {
                self.set_static_dir(Some(PathBuf::from(trimmed)));
            }
        }
        if let Some(cj) = caps_json {
            let trimmed = cj.trim();
            if !trimmed.is_empty() {
                if let Ok(caps) = serde_json::from_str::<HostCapabilities>(trimmed) {
                    self.set_capabilities(caps);
                }
            }
        }
        let target_addr = if bind_addr.trim().is_empty() {
            "127.0.0.1:0"
        } else {
            bind_addr.trim()
        };
        let (addr, stop_tx) = crate::http_server::start(self.clone(), target_addr)?;
        *self.http_bind_addr.lock().unwrap() = Some(addr.clone());
        *self.http_stop_tx.lock().unwrap() = Some(stop_tx);
        Ok(addr)
    }

    fn cookie(&self) -> String {
        if self.user.logged_in() {
            self.user.cookie_string()
        } else {
            String::new()
        }
    }

    /// 统一异步业务分发入口，供 C-ABI / Android JNI / HTTP 路由器共同调用。
    pub async fn dispatch(self: &Arc<Self>, action: &str, params: Value) -> Result<Value, String> {
        match action {
            // ---------------- 基础信息与能力 ----------------
            "core.info" => Ok(json!({
                "version": CORE_VERSION,
                "abiVersion": CORE_ABI_VERSION,
                "target": crate::config::current_target_id(),
                "appVersion": self.app_version,
                "mediaBaseUrl": self.media_server.base_url(),
                "dataDir": self.data_dir.to_string_lossy(),
                "capabilities": self.capabilities(),
            })),

            // ---------------- 账号与可选同步（无强制登录门槛） ----------------
            "me" => self.act_me().await,
            "login.qr.start" => self.act_qr_start().await,
            "login.qr.poll" => self.act_qr_poll(&params).await,
            "login.phone.send" => self.act_phone_send(&params).await,
            "login.phone.login" => self.act_phone_login(&params).await,
            "login.phone.verify" => self.act_phone_verify(&params).await,
            "logout" => self.act_logout().await,

            // ---------------- 内容浏览、解析与弹幕 ----------------
            "home" => self.act_home().await,
            "foryou" => self.act_for_you(&params).await,
            "rank" => self.act_rank(&params).await,
            "category.options" => self.act_category_options(&params).await,
            "category.list" => self.act_category_list(&params).await,
            "search" => self.act_search(&params).await,
            "suggest" => self.act_suggest(&params).await,
            "detail" => self.act_detail(&params).await,
            "seasons" => self.act_seasons(&params).await,
            "comments" => self.act_comments(&params).await,
            "play" => self.act_play(&params).await,

            // ---------------- 历史 / 收藏 / 预约 / 进度 ----------------
            "history.list" => self.act_history_list(&params).await,
            "history.delete" => self.act_history_delete(&params).await,
            "favorites.list" => self.act_favorites_list().await,
            "favorite.set" => self.act_favorite_set(&params).await,
            "reservations.list" => self.act_reservations_list(&params).await,
            "reservation.set" => self.act_reservation_set(&params).await,
            "progress.report" => self.act_progress_report(&params).await,

            // ---------------- 多线程离线下载 ----------------
            "download.list" => self.act_download_list(),
            "download.summary" => self.act_download_summary(),
            "download.add" => self.act_download_add(&params),
            "download.add_batch" => self.act_download_add_batch(&params),
            "download.delete_batch" => self.act_download_delete_batch(&params),
            "download.action" => self.act_download_action(&params),
            "download.settings.get" => Ok(serde_json::to_value(self.downloader.settings()).unwrap()),
            "download.settings.set" => self.act_download_settings_set(&params),
            "download.local" => self.act_download_local(&params),
            "download.open" => self.act_download_open(&params),

            // ---------------- 单文件 Core 自更新插槽 ----------------
            "core.update.status" => Ok(serde_json::to_value(self.updater.status()).unwrap()),
            "core.update.check" => {
                let auto_dl = params["autoDownload"].as_bool().unwrap_or(true);
                let st = self.updater.check_and_download(auto_dl).await?;
                Ok(serde_json::to_value(st).unwrap())
            }
            "core.update.channel" => {
                let mode_str = pstr(&params, "mode");
                let mode = match mode_str.as_str() {
                    "custom" => UpdateChannelMode::Custom,
                    "disabled" => UpdateChannelMode::Disabled,
                    _ => UpdateChannelMode::Default,
                };
                let custom_url = params.get("customUrl").and_then(|v| v.as_str());
                let st = self.updater.set_channel(mode, custom_url)?;
                Ok(serde_json::to_value(st).unwrap())
            }
            "core.update.rollback" => Ok(serde_json::to_value(self.updater.rollback_hot_core()).unwrap()),
            "app.update.check" => {
                let ver_arg = pstr(&params, "appVersion");
                let ver = if ver_arg.is_empty() {
                    self.app_version.as_str()
                } else {
                    ver_arg.as_str()
                };
                let url_arg = pstr(&params, "url");
                let url = if url_arg.is_empty() {
                    self.app_update_url.as_str()
                } else {
                    url_arg.as_str()
                };
                let res = self.updater.check_app_update(ver, url).await?;
                Ok(serde_json::to_value(res).unwrap())
            }

            _ => Err(format!("未知指令: {action}")),
        }
    }

    async fn act_me(self: &Arc<Self>) -> Result<Value, String> {
        if !self.user.logged_in() {
            return Ok(json!({ "loggedIn": false }));
        }
        let profile = self.account.profile().await?;
        let now = now_secs();
        let need_hb = {
            let mut last = self.last_heartbeat_at.lock().unwrap();
            if now - *last > 6 * 3600 {
                *last = now;
                true
            } else {
                false
            }
        };
        if need_hb {
            let acct = self.account.clone();
            self.rt.spawn(async move {
                let _ = acct.heartbeat().await;
            });
        }
        Ok(json!({
            "loggedIn": true,
            "profile": profile,
            "daysLeft": self.user.days_left(),
        }))
    }

    async fn act_qr_start(&self) -> Result<Value, String> {
        let (sess, res) = QrSession::start().await?;
        let token = sess.token().to_string();
        let data_url = res.qr;
        let mut map = self.qr_sessions.lock().await;
        if map.len() > 8 {
            map.clear();
        }
        map.insert(token.clone(), sess);
        Ok(json!({
            "token": token,
            "qr": data_url,
            "expiresAt": res.expires_at,
            "open": res.open,
        }))
    }

    async fn act_qr_poll(&self, params: &Value) -> Result<Value, String> {
        let token = pstr(params, "token");
        let mut map = self.qr_sessions.lock().await;
        let sess = if token.is_empty() {
            map.values_mut().next()
        } else {
            map.get_mut(&token)
        };
        let Some(sess) = sess else {
            return Ok(json!({ "state": "expired" }));
        };
        let (state, jar) = sess.poll().await?;
        if state == "confirmed" {
            if let Some(cookies) = jar {
                self.user.set(cookies);
                self.account.flush_dirty_progress().await;
            }
            if !token.is_empty() {
                map.remove(&token);
            } else {
                map.clear();
            }
        }
        Ok(json!({ "state": state }))
    }

    async fn act_phone_send(&self, params: &Value) -> Result<Value, String> {
        let phone = pstr(params, "phone");
        let existing_id = pstr(params, "sessionId");
        let mut map = self.phone_sessions.lock().await;
        let sid = if !existing_id.is_empty() && map.contains_key(&existing_id) {
            existing_id
        } else {
            let new_id = Uuid::new_v4().simple().to_string();
            let sess = PhoneLogin::new().await?;
            if map.len() > 8 {
                map.clear();
            }
            map.insert(new_id.clone(), sess);
            new_id
        };
        let sess = map.get_mut(&sid).unwrap();
        sess.send_code(&phone).await?;
        Ok(json!({ "sessionId": sid }))
    }

    async fn act_phone_login(&self, params: &Value) -> Result<Value, String> {
        let sid = pstr(params, "sessionId");
        let code = pstr(params, "code");
        let outcome = {
            let mut map = self.phone_sessions.lock().await;
            let sess = map
                .get_mut(&sid)
                .ok_or_else(|| "验证会话不存在或已过期，请重新发送验证码".to_string())?;
            sess.login(&code).await?
        };
        self.finish_phone_outcome(&sid, outcome).await
    }

    async fn act_phone_verify(&self, params: &Value) -> Result<Value, String> {
        let sid = pstr(params, "sessionId");
        let outcome = {
            let mut map = self.phone_sessions.lock().await;
            let sess = map
                .get_mut(&sid)
                .ok_or_else(|| "验证会话不存在或已过期".to_string())?;
            sess.verify_mfa().await?
        };
        self.finish_phone_outcome(&sid, outcome).await
    }

    async fn finish_phone_outcome(
        &self,
        sid: &str,
        outcome: PhoneLoginOutcome,
    ) -> Result<Value, String> {
        match outcome {
            PhoneLoginOutcome::Ok { cookies, device } => {
                self.devices.adopt(device).await;
                self.user.set(cookies);
                self.account.flush_dirty_progress().await;
                self.phone_sessions.lock().await.remove(sid);
                Ok(json!({ "status": "ok" }))
            }
            PhoneLoginOutcome::Mfa { number, content } => Ok(json!({
                "status": "mfa",
                "number": number,
                "content": content,
            })),
            PhoneLoginOutcome::Pending => Ok(json!({ "status": "pending" })),
        }
    }

    async fn act_logout(&self) -> Result<Value, String> {
        if self.user.logged_in() {
            self.account.flush_dirty_progress().await;
            self.account.logout_remote().await;
        }
        self.user.clear();
        self.account.clear_local_library();
        Ok(json!({ "ok": true }))
    }

    async fn act_home(&self) -> Result<Value, String> {
        let logged = self.user.logged_in();
        let (hist_res, channels, fy_res) = tokio::join!(
            async {
                if logged {
                    self.account.cloud_history(12).await
                } else {
                    Ok(self.account.local_history(12))
                }
            },
            self.content.feed_channels(&self.account),
            self.content.for_you(&self.account, "16", 0, "", "")
        );
        let cont = hist_res.unwrap_or_else(|_| self.account.local_history(12));
        let (page, cell, sess) = fy_res?;
        Ok(json!({
            "continue": cont,
            "forYou": page,
            "cell": cell,
            "session": sess,
            "channels": channels,
        }))
    }

    async fn act_for_you(&self, params: &Value) -> Result<Value, String> {
        let ch = pstr(params, "channel");
        let offset = params["offset"].as_i64().unwrap_or(0) as i32;
        let cell = pstr(params, "cell");
        let session = pstr(params, "session");
        let (page, next_cell, next_sess) = self
            .content
            .for_you(&self.account, &ch, offset, &cell, &session)
            .await?;
        Ok(json!({
            "page": page,
            "cell": next_cell,
            "session": next_sess,
        }))
    }

    async fn act_rank(&self, params: &Value) -> Result<Value, String> {
        let board = pstr(params, "board");
        let offset = params["offset"].as_i64().unwrap_or(0) as i32;
        let session = pstr(params, "session");
        let page = self
            .content
            .rank(&self.cookie(), &board, offset, &session)
            .await?;
        Ok(serde_json::to_value(page).unwrap())
    }

    async fn act_category_options(&self, params: &Value) -> Result<Value, String> {
        let typ = pstr(params, "type");
        let opts = self
            .content
            .category_options(&self.cookie(), &typ)
            .await?;
        Ok(serde_json::to_value(opts).unwrap())
    }

    async fn act_category_list(&self, params: &Value) -> Result<Value, String> {
        let typ = pstr(params, "type");
        let board = pstr(params, "board");
        let offset = params["offset"].as_i64().unwrap_or(0) as i32;
        let session = pstr(params, "session");
        let mut selected = HashMap::new();
        if let Some(obj) = params["selected"].as_object() {
            for (k, v) in obj {
                if let Some(s) = v.as_str() {
                    selected.insert(k.clone(), s.to_string());
                }
            }
        }
        let page = self
            .content
            .category_page(&self.cookie(), &typ, &board, &selected, offset, &session)
            .await?;
        Ok(serde_json::to_value(page).unwrap())
    }

    async fn act_search(&self, params: &Value) -> Result<Value, String> {
        let q = pstr(params, "q");
        let page = params["page"].as_i64().unwrap_or(1) as i32;
        let res = self.content.search(&self.account, &q, page).await?;
        Ok(serde_json::to_value(res).unwrap())
    }

    async fn act_suggest(&self, params: &Value) -> Result<Value, String> {
        let q = pstr(params, "q");
        let items = self.content.suggest(&self.account, &q).await;
        Ok(json!({ "items": items }))
    }

    async fn act_detail(&self, params: &Value) -> Result<Value, String> {
        let id = pstr(params, "id");
        let lite = params["lite"].as_bool().unwrap_or(false);
        let cookie = self.cookie();
        let detail = self.content.detail(&cookie, &id).await?;
        // 详情页加载完成后立即后台预热第 1 集首片与 CENC 索引，实现点击播放秒开
        if let Some(ep0) = detail.episodes.first() {
            if !ep0.vid.is_empty() {
                self.media_server
                    .prefetch(ep0.vid.clone(), "720p".to_string(), self.rt.handle());
            }
        }
        let mut out = json!({ "detail": detail });

        if !lite {
            if self.user.logged_in() {
                let (favs_res, hist_res) =
                    tokio::join!(self.account.favorites(), self.account.cloud_history(200));
                if let Ok(favs) = favs_res {
                    if favs.iter().any(|f| f.series_id == id) {
                        out["favorite"] = json!(true);
                    }
                }
                if let Ok(hist) = hist_res {
                    if let Some(p) = hist.into_iter().find(|h| h.series_id == id) {
                        out["progress"] = serde_json::to_value(p).unwrap();
                    }
                }
                if detail.episodes.is_empty() {
                    let (r0, r1) = tokio::join!(
                        self.account.reservations(false),
                        self.account.reservations(true)
                    );
                    let found = r0
                        .ok()
                        .and_then(|v| v.into_iter().find(|r| r.series_id == id))
                        .or_else(|| {
                            r1.ok()
                                .and_then(|v| v.into_iter().find(|r| r.series_id == id))
                        });
                    if let Some(rv) = found {
                        out["reserved"] = json!(true);
                        out["reservation"] = serde_json::to_value(rv).unwrap();
                    }
                }
            } else if let Some(p) = self
                .account
                .local_history(200)
                .into_iter()
                .find(|h| h.series_id == id)
            {
                out["progress"] = serde_json::to_value(p).unwrap();
            }
        }
        Ok(out)
    }

    async fn act_seasons(&self, params: &Value) -> Result<Value, String> {
        let id = pstr(params, "id");
        let quick = params["quick"].as_bool().unwrap_or(false);
        let list = self.content.seasons(&self.cookie(), &id, quick).await?;
        Ok(json!({ "items": list }))
    }

    async fn act_comments(&self, params: &Value) -> Result<Value, String> {
        let id = pstr(params, "id");
        let vid = pstr(params, "vid");
        let offset = params["offset"].as_i64().unwrap_or(0) as i32;
        self.content.comments(&self.cookie(), &id, &vid, offset).await
    }

    async fn act_play(&self, params: &Value) -> Result<Value, String> {
        let vid = pstr(params, "vid");
        let quality = pstr(params, "q");
        let fresh = params["fresh"].as_bool().unwrap_or(false);
        if fresh {
            self.media_server.invalidate_vid(&vid).await;
        }
        let local_file = self.downloader.get_local_path(&vid);
        if !fresh {
            if let Some(ref path) = local_file {
                return Ok(json!({
                    "gears": [],
                    "definition": if quality.is_empty() { "本地" } else { quality.as_str() },
                    "width": 0,
                    "height": 0,
                    "mediaUrl": self.media_server.media_url(&vid, &quality),
                    "localFile": path,
                }));
            }
        }
        let gears = self.content.play(&vid, fresh).await?;
        let picked = crate::upstream::content::pick_gear(&gears, &quality, 1080);
        let active_def = picked
            .map(|g| g.definition.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| quality.clone());
        let width = picked.map(|g| g.width).unwrap_or(0);
        let height = picked.map(|g| g.height).unwrap_or(0);
        let media_url = self.media_server.media_url(&vid, &active_def);
        if params["prefetch"].as_bool() == Some(true) {
            self.media_server
                .prefetch(vid.clone(), active_def.clone(), self.rt.handle());
        }
        Ok(json!({
            "gears": gears,
            "definition": active_def,
            "width": width,
            "height": height,
            "mediaUrl": media_url,
            "localFile": local_file,
        }))
    }

    async fn act_history_list(&self, params: &Value) -> Result<Value, String> {
        let limit = params["limit"].as_u64().unwrap_or(100) as usize;
        let items = if self.user.logged_in() {
            match self.account.cloud_history(limit).await {
                Ok(items) => items,
                Err(_) => self.account.local_history(limit),
            }
        } else {
            self.account.local_history(limit)
        };
        Ok(json!({ "items": items }))
    }

    async fn act_history_delete(&self, params: &Value) -> Result<Value, String> {
        let series_id = pstr(params, "seriesId");
        self.account.forget_local_history(&series_id);
        if self.user.logged_in() {
            self.account.delete_history(&series_id).await?;
        }
        Ok(json!({ "ok": true }))
    }

    async fn act_favorites_list(&self) -> Result<Value, String> {
        if !self.user.logged_in() {
            return Ok(json!({ "items": [] }));
        }
        let items = self.account.favorites().await?;
        Ok(json!({ "items": items }))
    }

    async fn act_favorite_set(&self, params: &Value) -> Result<Value, String> {
        if !self.user.logged_in() {
            return Err("请先登录后再收藏".into());
        }
        let series_id = pstr(params, "seriesId");
        let add = params["add"].as_bool().unwrap_or(true);
        self.account.set_favorite(&series_id, add).await?;
        Ok(json!({ "ok": true }))
    }

    async fn act_reservations_list(&self, params: &Value) -> Result<Value, String> {
        if !self.user.logged_in() {
            return Ok(json!({ "items": [] }));
        }
        let online = params["online"].as_bool().unwrap_or(false);
        let items = self.account.reservations(online).await?;
        Ok(json!({ "items": items }))
    }

    async fn act_reservation_set(&self, params: &Value) -> Result<Value, String> {
        if !self.user.logged_in() {
            return Err("请先登录后再预约".into());
        }
        let series_id = pstr(params, "seriesId");
        let add = params["add"].as_bool().unwrap_or(true);
        self.account.set_reservation(&series_id, add).await?;
        Ok(json!({ "ok": true }))
    }

    async fn act_progress_report(&self, params: &Value) -> Result<Value, String> {
        let series_id = pstr(params, "seriesId");
        let vid = pstr(params, "vid");
        let index = params["index"].as_i64().unwrap_or(0) as i32;
        let pos = params["positionMs"]
            .as_i64()
            .or_else(|| params["pos"].as_i64())
            .unwrap_or(0) as i32;
        let title = pstr(params, "title");
        let cover = pstr(params, "cover");
        let episode_count = params["episodeCount"].as_i64().unwrap_or(0) as i32;
        match self
            .account
            .report_progress(&series_id, &vid, index, pos, &title, &cover, episode_count, true)
            .await
        {
            Ok(()) => Ok(json!({ "ok": true })),
            Err(_) => Ok(json!({ "ok": true, "localOnly": true })),
        }
    }

    fn act_download_list(&self) -> Result<Value, String> {
        Ok(json!({ "items": self.downloader.list_slim() }))
    }

    fn act_download_summary(&self) -> Result<Value, String> {
        Ok(json!({ "active": self.downloader.active_count() }))
    }

    fn act_download_add(&self, params: &Value) -> Result<Value, String> {
        let req: AddDownloadRequest =
            serde_json::from_value(params.clone()).map_err(|e| format!("下载参数无效: {e}"))?;
        let task = self.downloader.add(req, self.rt.handle())?;
        Ok(serde_json::to_value(task).unwrap())
    }

    fn act_download_add_batch(&self, params: &Value) -> Result<Value, String> {
        let raw_items = params.get("items").cloned().unwrap_or_else(|| json!([]));
        let reqs: Vec<AddDownloadRequest> =
            serde_json::from_value(raw_items).map_err(|e| format!("批量下载参数无效: {e}"))?;
        let tasks = self.downloader.add_batch(reqs, self.rt.handle())?;
        Ok(json!({
            "count": tasks.len(),
            "items": tasks,
        }))
    }

    fn act_download_delete_batch(&self, params: &Value) -> Result<Value, String> {
        let raw_ids = params.get("ids").cloned().unwrap_or_else(|| json!([]));
        let ids: Vec<String> =
            serde_json::from_value(raw_ids).map_err(|e| format!("批量删除参数无效: {e}"))?;
        let remove_file = params["removeFile"].as_bool().unwrap_or(false);
        let deleted = self.downloader.delete_batch(&ids, remove_file, self.rt.handle())?;
        Ok(json!({
            "deleted": deleted,
            "items": self.downloader.list_slim(),
        }))
    }

    fn act_download_action(&self, params: &Value) -> Result<Value, String> {
        let req: DownloadActionRequest =
            serde_json::from_value(params.clone()).map_err(|e| format!("操作参数无效: {e}"))?;
        match req.action.as_str() {
            "pause" => self.downloader.pause(&req.id)?,
            "resume" | "retry" => self.downloader.resume(&req.id, self.rt.handle())?,
            "cancel" => self.downloader.cancel(&req.id)?,
            "delete" => self.downloader.delete(&req.id, req.remove_file)?,
            "pause_all" => self.downloader.pause_all()?,
            "resume_all" => self.downloader.resume_all(self.rt.handle())?,
            "clear_completed" => self.downloader.clear_completed()?,
            other => return Err(format!("不支持的下载操作: {other}")),
        }
        Ok(json!({ "items": self.downloader.list_slim() }))
    }

    fn act_download_settings_set(&self, params: &Value) -> Result<Value, String> {
        let next: DownloadSettings =
            serde_json::from_value(params.clone()).map_err(|e| format!("下载设置无效: {e}"))?;
        let saved = self.downloader.update_settings(next, self.rt.handle())?;
        Ok(serde_json::to_value(saved).unwrap())
    }

    fn act_download_local(&self, params: &Value) -> Result<Value, String> {
        let vid = pstr(params, "vid");
        Ok(json!({ "path": self.downloader.get_local_path(&vid) }))
    }

    fn act_download_open(&self, params: &Value) -> Result<Value, String> {
        let id = pstr(params, "id");
        self.downloader.open_location(&id)?;
        Ok(json!({ "ok": true }))
    }
}

fn pstr(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// 根据文件后缀推断 HTTP MIME 类型。
pub fn guess_mime(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".html") || lower.ends_with(".htm") {
        "text/html; charset=utf-8"
    } else if lower.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if lower.ends_with(".js") {
        "application/javascript; charset=utf-8"
    } else if lower.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".ico") {
        "image/x-icon"
    } else if lower.ends_with(".mp4") {
        "video/mp4"
    } else {
        "application/octet-stream"
    }
}
