//! 内嵌轻量级异步 HTTP/1.1 服务（零重型 Web 框架依赖）。
//!
//! 为统一 Web UI（`web-ui/`）与任意外部 HTTP 宿主提供同一套接口：
//! - `/api/*`：完整兼容 `web-ui` 的浏览、播放、登录、历史、下载与核心更新接口；
//! - `/api/capabilities`：下发宿主能力开关（Web 模式简洁、PC 模式解锁下载/超分/原生播放器）；
//! - `/api/call`：通用 RPC 入口，任意语言可通过 HTTP 直接调用全部 Core Action；
//! - `/media/:vid.mp4`：优先流式分块读取已下载的本地 MP4，其次自动拉流解密并提供 Range 拖动；
//! - `/*`：优先从宿主内置静态资产读取，支持 SPA 路由回退至 `/pc/index.html`。

use crate::config::{UpdateChannelMode, CORE_ABI_VERSION, CORE_VERSION};
use crate::media_server::parse_byte_range;
use crate::runtime::AppCore;
use crate::upstream::content::{pick_gear, Gear};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::SeekFrom;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use url::form_urlencoded;

/// 启动内嵌 HTTP 服务，返回真实绑定地址（`ip:port`）与停止信号发送端。
pub fn start(core: Arc<AppCore>, bind_addr: &str) -> Result<(String, watch::Sender<bool>), String> {
    let std_listener = std::net::TcpListener::bind(bind_addr)
        .map_err(|e| format!("HTTP 服务绑定 {bind_addr} 失败: {e}"))?;
    std_listener
        .set_nonblocking(true)
        .map_err(|e| format!("HTTP 服务设置非阻塞失败: {e}"))?;
    let local_addr = std_listener
        .local_addr()
        .map_err(|e| format!("获取 HTTP 监听地址失败: {e}"))?;
    let listener = core
        .rt
        .block_on(async move { TcpListener::from_std(std_listener) })
        .map_err(|e| format!("初始化异步 HTTP 监听失败: {e}"))?;

    let (stop_tx, mut stop_rx) = watch::channel(false);
    let rt_handle = core.rt.handle().clone();
    rt_handle.spawn(async move {
        loop {
            tokio::select! {
                _ = stop_rx.changed() => {
                    if *stop_rx.borrow() {
                        break;
                    }
                }
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, _)) => {
                            let _ = stream.set_nodelay(true);
                            let c = core.clone();
                            tokio::spawn(async move {
                                let _ = serve_conn(stream, c).await;
                            });
                        }
                        Err(_) => {
                            tokio::time::sleep(std::time::Duration::from_millis(15)).await;
                        }
                    }
                }
            }
        }
    });

    Ok((local_addr.to_string(), stop_tx))
}

struct HttpRequest {
    method: String,
    path: String,
    query: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

async fn read_request(stream: &mut TcpStream) -> Result<Option<HttpRequest>, String> {
    let mut reader = BufReader::new(stream);
    let mut req_line = String::new();
    let n = reader
        .read_line(&mut req_line)
        .await
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Ok(None);
    }
    let parts: Vec<&str> = req_line.split_whitespace().collect();
    if parts.len() < 2 {
        return Err("请求行无效".into());
    }
    let method = parts[0].to_ascii_uppercase();
    let raw_target = parts[1];
    let (path, query) = raw_target.split_once('?').unwrap_or((raw_target, ""));

    let mut headers = HashMap::new();
    let mut content_len: usize = 0;
    loop {
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .await
            .map_err(|e| e.to_string())?;
        if read == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim().to_ascii_lowercase();
            let val = v.trim().to_string();
            if key == "content-length" {
                content_len = val.parse::<usize>().unwrap_or(0).min(8 * 1024 * 1024);
            }
            headers.insert(key, val);
        }
    }

    let mut body = vec![0u8; content_len];
    if content_len > 0 {
        reader
            .read_exact(&mut body)
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(Some(HttpRequest {
        method,
        path: path.to_string(),
        query: query.to_string(),
        headers,
        body,
    }))
}

async fn serve_conn(mut stream: TcpStream, core: Arc<AppCore>) -> Result<(), String> {
    let req = match read_request(&mut stream).await {
        Ok(Some(r)) => r,
        Ok(None) => return Ok(()),
        Err(e) => {
            write_json(&mut stream, 400, &json!({ "error": e })).await;
            return Ok(());
        }
    };

    if req.method == "OPTIONS" {
        write_bytes(&mut stream, 204, "text/plain; charset=utf-8", b"", false).await;
        return Ok(());
    }

    // 媒体流通道优先：支持本地磁盘分块 Range 直出，零整片内存拷贝
    if req.path.starts_with("/media/") {
        handle_media(&mut stream, &req, &core).await;
        return Ok(());
    }

    if req.path == "/healthz" {
        write_json(
            &mut stream,
            200,
            &json!({
                "ok": true,
                "version": CORE_VERSION,
                "abiVersion": CORE_ABI_VERSION,
                "target": crate::config::current_target_id(),
            }),
        )
        .await;
        return Ok(());
    }

    if req.path == "/api/capabilities" {
        write_json(&mut stream, 200, &serde_json::to_value(core.capabilities()).unwrap()).await;
        return Ok(());
    }

    if req.path.starts_with("/api/") {
        match handle_api(&req, &core).await {
            Ok((status, val)) => write_json(&mut stream, status, &val).await,
            Err((status, msg)) => write_json(&mut stream, status, &json!({ "error": msg })).await,
        }
        return Ok(());
    }

    // 静态页面与 SPA 路由托管
    let asset_path = if req.path == "/" {
        "/pc/index.html"
    } else {
        req.path.as_str()
    };
    if let Some((mime, bytes)) = core.load_static_asset(asset_path) {
        write_bytes(&mut stream, 200, mime, &bytes, req.method == "HEAD").await;
        return Ok(());
    }
    if is_spa_route(&req.path) {
        if let Some((mime, bytes)) = core.load_static_asset("/pc/index.html") {
            write_bytes(&mut stream, 200, mime, &bytes, req.method == "HEAD").await;
            return Ok(());
        }
    }
    write_json(&mut stream, 404, &json!({ "error": "Not Found" })).await;
    Ok(())
}

fn is_spa_route(p: &str) -> bool {
    p == "/"
        || p == "/home"
        || p == "/feed"
        || p == "/rank"
        || p == "/category"
        || p == "/mine"
        || p.starts_with("/mine/")
        || p.starts_with("/detail/")
        || p == "/play"
        || p == "/settings"
        || p == "/search"
        || p == "/downloads"
}

fn parse_query_map(raw: &str) -> (HashMap<String, String>, Vec<(String, String)>) {
    let mut single = HashMap::new();
    let mut all = Vec::new();
    for (k, v) in form_urlencoded::parse(raw.as_bytes()) {
        let ks = k.into_owned();
        let vs = v.into_owned();
        single.insert(ks.clone(), vs.clone());
        all.push((ks, vs));
    }
    (single, all)
}

fn body_json(req: &HttpRequest) -> Value {
    if req.body.is_empty() {
        return json!({});
    }
    serde_json::from_slice(&req.body).unwrap_or_else(|_| json!({}))
}

async fn handle_api(req: &HttpRequest, core: &Arc<AppCore>) -> Result<(u16, Value), (u16, String)> {
    let (q, q_all) = parse_query_map(&req.query);
    let qstr = |k: &str| q.get(k).cloned().unwrap_or_default();
    let qint = |k: &str| qstr(k).parse::<i64>().unwrap_or(0);

    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/api/ping") => Ok((200, json!({ "ok": true, "version": CORE_VERSION }))),

        ("POST", "/api/call") => {
            let body = body_json(req);
            let action = body["action"].as_str().unwrap_or("").trim().to_string();
            if action.is_empty() {
                return Err((400, "缺少 action".into()));
            }
            let params = body.get("params").cloned().unwrap_or_else(|| json!({}));
            let data = core.dispatch(&action, params).await.map_err(map_err)?;
            Ok((200, json!({ "ok": true, "data": data })))
        }

        // ---------------- 账号与登录（可选，无强制门禁） ----------------
        ("GET", "/api/me") => Ok((200, core.dispatch("me", json!({})).await.map_err(map_err)?)),
        ("POST", "/api/login/start") => {
            Ok((200, core.dispatch("login.qr.start", json!({})).await.map_err(map_err)?))
        }
        ("GET", "/api/login/poll") => {
            let data = core
                .dispatch("login.qr.poll", json!({ "token": qstr("token") }))
                .await
                .map_err(map_err)?;
            Ok((200, data))
        }
        ("POST", "/api/login/phone/send") => Ok((
            200,
            core.dispatch("login.phone.send", body_json(req)).await.map_err(map_err)?,
        )),
        ("POST", "/api/login/phone/login") => Ok((
            200,
            core.dispatch("login.phone.login", body_json(req)).await.map_err(map_err)?,
        )),
        ("POST", "/api/login/phone/verify") => Ok((
            200,
            core.dispatch("login.phone.verify", body_json(req)).await.map_err(map_err)?,
        )),
        ("POST", "/api/logout") => Ok((200, core.dispatch("logout", json!({})).await.map_err(map_err)?)),

        // ---------------- 浏览与推荐 ----------------
        ("GET", "/api/home") => Ok((200, core.dispatch("home", json!({})).await.map_err(map_err)?)),
        ("GET", "/api/foryou") => Ok((
            200,
            core.dispatch(
                "foryou",
                json!({
                    "channel": qstr("channel"),
                    "offset": qint("offset"),
                    "cell": qstr("cell"),
                    "session": qstr("session"),
                }),
            )
            .await
            .map_err(map_err)?,
        )),
        ("GET", "/api/rank") => Ok((
            200,
            core.dispatch(
                "rank",
                json!({
                    "board": qstr("board"),
                    "offset": qint("offset"),
                    "session": qstr("session"),
                }),
            )
            .await
            .map_err(map_err)?,
        )),
        ("GET", "/api/category/options") => Ok((
            200,
            core.dispatch("category.options", json!({ "type": qstr("type") }))
                .await
                .map_err(map_err)?,
        )),
        ("GET", "/api/category") => {
            let mut selected = serde_json::Map::new();
            for (k, v) in q_all {
                if k == "sel" {
                    if let Some((grp, opt)) = v.split_once(':') {
                        selected.insert(grp.to_string(), Value::String(opt.to_string()));
                    }
                }
            }
            Ok((
                200,
                core.dispatch(
                    "category.list",
                    json!({
                        "type": qstr("type"),
                        "board": qstr("board"),
                        "offset": qint("offset"),
                        "session": qstr("session"),
                        "selected": selected,
                    }),
                )
                .await
                .map_err(map_err)?,
            ))
        }
        ("GET", "/api/search") => Ok((
            200,
            core.dispatch(
                "search",
                json!({ "q": qstr("q"), "page": qint("page").max(1) }),
            )
            .await
            .map_err(map_err)?,
        )),
        ("GET", "/api/suggest") => Ok((
            200,
            core.dispatch("suggest", json!({ "q": qstr("q") }))
                .await
                .map_err(map_err)?,
        )),
        ("GET", "/api/detail") => Ok((
            200,
            core.dispatch(
                "detail",
                json!({ "id": qstr("id"), "lite": qstr("lite") == "1" }),
            )
            .await
            .map_err(map_err)?,
        )),
        ("GET", "/api/seasons") => {
            let res = core
                .dispatch(
                    "seasons",
                    json!({ "id": qstr("id"), "quick": qstr("quick") == "1" }),
                )
                .await
                .map_err(map_err)?;
            Ok((200, json!({ "seasons": res["items"] })))
        }
        ("GET", "/api/comments") => {
            let vid = {
                let e = qstr("ep");
                if e.is_empty() { qstr("vid") } else { e }
            };
            let raw = core
                .dispatch(
                    "comments",
                    json!({ "id": qstr("id"), "vid": vid, "offset": qint("offset") }),
                )
                .await
                .map_err(map_err)?;
            Ok((200, raw))
        }
        ("GET", "/api/play") => {
            let vid = qstr("vid");
            let quality = qstr("q");
            let fresh = qstr("fresh") == "1";
            if !fresh {
                if let Some(local_path) = core.downloader.get_local_path(&vid) {
                    let def = if quality.is_empty() { "本地" } else { quality.as_str() };
                    return Ok((
                        200,
                        json!({
                            "src": format!("/media/{vid}.mp4"),
                            "definition": def,
                            "gears": [],
                            "localFile": local_path,
                        }),
                    ));
                }
            }
            let gears = core.content.play(&vid, fresh).await.map_err(map_err)?;
            let picked = pick_gear(&gears, &quality, 1080)
                .ok_or((502, "没有可播放的清晰度".to_string()))?;
            let mut list: Vec<Value> = gears
                .iter()
                .filter(|g| g.short_side() > 0)
                .map(|g| {
                    json!({
                        "definition": g.definition,
                        "codec": g.codec,
                        "short": g.short_side(),
                        "size": g.size,
                        "width": g.width,
                        "height": g.height,
                    })
                })
                .collect();
            list.sort_by_key(|v| v["short"].as_i64().unwrap_or(0));
            let enc_def: String =
                form_urlencoded::byte_serialize(picked.definition.as_bytes()).collect();
            core.media_server
                .prefetch(vid.clone(), picked.definition.clone(), core.rt.handle());
            Ok((
                200,
                json!({
                    "src": format!("/media/{vid}.mp4?q={enc_def}"),
                    "definition": picked.definition,
                    "gears": list,
                }),
            ))
        }

        // ---------------- 历史 / 收藏 / 预约 / 进度 ----------------
        ("GET", "/api/history") => {
            let limit = qint("limit");
            let params = if limit > 0 { json!({ "limit": limit }) } else { json!({ "limit": 120 }) };
            Ok((200, core.dispatch("history.list", params).await.map_err(map_err)?))
        }
        ("POST", "/api/history/delete") => {
            let b = body_json(req);
            let sid = b["seriesId"]
                .as_str()
                .or_else(|| b["id"].as_str())
                .unwrap_or("")
                .to_string();
            Ok((
                200,
                core.dispatch("history.delete", json!({ "seriesId": sid }))
                    .await
                    .map_err(map_err)?,
            ))
        }
        ("GET", "/api/favorites") => Ok((
            200,
            core.dispatch("favorites.list", json!({})).await.map_err(map_err)?,
        )),
        ("POST", "/api/favorite") => {
            let b = body_json(req);
            let sid = b["seriesId"]
                .as_str()
                .or_else(|| b["id"].as_str())
                .unwrap_or("")
                .to_string();
            let add = b["add"].as_bool().unwrap_or(true);
            core.dispatch("favorite.set", json!({ "seriesId": sid, "add": add }))
                .await
                .map_err(map_err)?;
            Ok((200, json!({ "ok": true, "favorite": add })))
        }
        ("GET", "/api/reservations") => {
            if !core.user.logged_in() {
                return Ok((200, json!({ "online": [], "upcoming": [] })));
            }
            let (on_res, off_res) = tokio::join!(
                core.account.reservations(true),
                core.account.reservations(false)
            );
            let online = on_res.unwrap_or_default();
            let upcoming = off_res.unwrap_or_default();
            Ok((200, json!({ "online": online, "upcoming": upcoming })))
        }
        ("POST", "/api/reservation") => {
            let b = body_json(req);
            let sid = b["seriesId"]
                .as_str()
                .or_else(|| b["id"].as_str())
                .unwrap_or("")
                .to_string();
            let add = b["add"].as_bool().unwrap_or(true);
            core.dispatch("reservation.set", json!({ "seriesId": sid, "add": add }))
                .await
                .map_err(map_err)?;
            Ok((200, json!({ "ok": true, "reserved": add })))
        }
        ("POST", "/api/progress") => {
            let mut b = body_json(req);
            if b.get("seriesId").is_none() {
                if let Some(id) = b.get("id").cloned() {
                    b["seriesId"] = id;
                }
            }
            if b.get("positionMs").is_none() {
                if let Some(p) = b.get("pos").cloned() {
                    b["positionMs"] = p;
                }
            }
            Ok((
                200,
                core.dispatch("progress.report", b).await.map_err(map_err)?,
            ))
        }

        // ---------------- PC 离线下载、原生播放与单文件 Core 热更新 ----------------
        ("GET", "/api/download/list") => Ok((
            200,
            core.dispatch("download.list", json!({})).await.map_err(map_err)?,
        )),
        ("GET", "/api/download/summary") => Ok((
            200,
            core.dispatch("download.summary", json!({})).await.map_err(map_err)?,
        )),
        ("POST", "/api/download/add") => Ok((
            200,
            core.dispatch("download.add", body_json(req)).await.map_err(map_err)?,
        )),
        ("POST", "/api/download/add-batch") => Ok((
            200,
            core.dispatch("download.add_batch", body_json(req)).await.map_err(map_err)?,
        )),
        ("POST", "/api/download/delete-batch") => Ok((
            200,
            core.dispatch("download.delete_batch", body_json(req)).await.map_err(map_err)?,
        )),
        ("POST", "/api/download/action") => Ok((
            200,
            core.dispatch("download.action", body_json(req)).await.map_err(map_err)?,
        )),
        ("GET", "/api/download/settings") => Ok((
            200,
            core.dispatch("download.settings.get", json!({})).await.map_err(map_err)?,
        )),
        ("POST", "/api/download/settings") => Ok((
            200,
            core.dispatch("download.settings.set", body_json(req)).await.map_err(map_err)?,
        )),
        ("POST", "/api/download/open") => Ok((
            200,
            core.dispatch("download.open", body_json(req)).await.map_err(map_err)?,
        )),
        ("GET", "/api/core/update") => Ok((
            200,
            core.dispatch("core.update.status", json!({})).await.map_err(map_err)?,
        )),
        ("POST", "/api/core/update/check") => Ok((
            200,
            core.dispatch("core.update.check", body_json(req)).await.map_err(map_err)?,
        )),
        ("POST", "/api/core/update/channel") => {
            let b = body_json(req);
            let mode = match b["mode"].as_str().unwrap_or("default") {
                "custom" => UpdateChannelMode::Custom,
                "disabled" => UpdateChannelMode::Disabled,
                _ => UpdateChannelMode::Default,
            };
            let st = core
                .updater
                .set_channel(mode, b.get("customUrl").and_then(|v| v.as_str()))
                .map_err(map_err)?;
            Ok((200, serde_json::to_value(st).unwrap()))
        }
        ("POST", "/api/core/update/rollback") => Ok((
            200,
            core.dispatch("core.update.rollback", json!({})).await.map_err(map_err)?,
        )),
        ("GET", "/api/app/update/check") => Ok((
            200,
            core.dispatch("app.update.check", json!({ "appVersion": qstr("version") }))
                .await
                .map_err(map_err)?,
        )),
        ("POST", "/api/native/play") => {
            let res = core.invoke_native_play(body_json(req)).map_err(map_err)?;
            Ok((200, res))
        }

        _ => Err((404, "未找到接口".into())),
    }
}

fn map_err(msg: String) -> (u16, String) {
    if msg.starts_with("SESSION_EXPIRED:") || msg.contains("请先登录") {
        (401, msg.trim_start_matches("SESSION_EXPIRED:").to_string())
    } else if msg.contains("参数无效") || msg.contains("缺少") {
        (400, msg)
    } else {
        (502, msg)
    }
}

async fn handle_media(stream: &mut TcpStream, req: &HttpRequest, core: &Arc<AppCore>) {
    if req.method != "GET" && req.method != "HEAD" {
        write_json(stream, 405, &json!({ "error": "Method Not Allowed" })).await;
        return;
    }
    let rest = req.path.strip_prefix("/media/").unwrap_or("");
    let vid = rest.strip_suffix(".mp4").unwrap_or(rest);
    if vid.is_empty() || !vid.bytes().all(|b| b.is_ascii_digit()) {
        write_json(stream, 404, &json!({ "error": "Invalid vid" })).await;
        return;
    }
    let range_hdr = req.headers.get("range").map(|s| s.as_str());
    let is_head = req.method == "HEAD";

    // 若本地已完成离线下载，直接按磁盘分块流式输出，避免整片加载到内存
    if let Some(local_path) = core.downloader.get_local_path(vid) {
        if stream_local_file(stream, &local_path, range_hdr, is_head).await.is_ok() {
            return;
        }
    }

    let (q_map, _) = parse_query_map(&req.query);
    let q_pref = q_map.get("q").map(|s| s.as_str()).unwrap_or("");
    if let Err(e) = core
        .media_server
        .stream_range(vid, q_pref, range_hdr, is_head, stream)
        .await
    {
        write_json(stream, 502, &json!({ "error": e })).await;
    }
}

async fn stream_local_file(
    stream: &mut TcpStream,
    path: &str,
    range_hdr: Option<&str>,
    is_head: bool,
) -> Result<(), String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| e.to_string())?;
    let meta = file.metadata().await.map_err(|e| e.to_string())?;
    let total = meta.len() as usize;
    if total == 0 {
        return Err("空文件".into());
    }
    let (start, end, partial) = match range_hdr {
        Some(rng) => match parse_byte_range(rng, total) {
            Some((s, e)) => (s, e, true),
            None => {
                let hdr = format!(
                    "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\nConnection: close\r\n\r\n"
                );
                let _ = stream.write_all(hdr.as_bytes()).await;
                let _ = stream.flush().await;
                return Ok(());
            }
        },
        None => (0, total - 1, false),
    };
    let len = end - start + 1;
    let hdr = if partial {
        format!(
            "HTTP/1.1 206 Partial Content\r\nAccept-Ranges: bytes\r\nContent-Type: video/mp4\r\nContent-Range: bytes {start}-{end}/{total}\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n"
        )
    } else {
        format!(
            "HTTP/1.1 200 OK\r\nAccept-Ranges: bytes\r\nContent-Type: video/mp4\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n"
        )
    };
    stream
        .write_all(hdr.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    if !is_head {
        file.seek(SeekFrom::Start(start as u64))
            .await
            .map_err(|e| e.to_string())?;
        let mut remaining = len;
        let mut buf = [0u8; 64 * 1024];
        while remaining > 0 {
            let chunk = remaining.min(buf.len());
            let n = file
                .read(&mut buf[..chunk])
                .await
                .map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            stream
                .write_all(&buf[..n])
                .await
                .map_err(|e| e.to_string())?;
            remaining -= n;
        }
    }
    let _ = stream.flush().await;
    Ok(())
}

async fn write_json(stream: &mut TcpStream, status: u16, val: &Value) {
    let bytes = serde_json::to_vec(val).unwrap_or_else(|_| b"{}".to_vec());
    write_bytes(stream, status, "application/json; charset=utf-8", &bytes, false).await;
}

async fn write_bytes(
    stream: &mut TcpStream,
    status: u16,
    mime: &str,
    bytes: &[u8],
    head_only: bool,
) {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Bad Gateway",
    };
    let hdr = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        bytes.len()
    );
    let _ = stream.write_all(hdr.as_bytes()).await;
    if !head_only && !bytes.is_empty() {
        let _ = stream.write_all(bytes).await;
    }
    let _ = stream.flush().await;
}

#[allow(dead_code)]
fn _unused(_: Gear) {}
