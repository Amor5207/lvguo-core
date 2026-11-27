//! 轻量级流式 CENC 解密与 Range 代理服务（边下边解边播）。
//!
//! 性能优化与低内存设计：
//! 1. **绝不整片缓存**：仅拉取 MP4 的 `moov` 索引盒与前 256 KiB 数据头（< 4 MiB 总缓存），
//!    构建只读 `CencIndex` 后立即响应前端/原生播放器；
//! 2. **零等待 Range 直通流式解密**：后续视频切片按客户端 `Range` 实时向上游按块拉流，
//!    每收到一块网络数据即用 AES-CTR 按偏移原地解密并立刻写出到播放器，支持瞬时首帧与零卡顿拖动；
//! 3. **并发请求合并**：同一剧集清晰度的并发首帧/预热共享同一 `watch` 信号，避免重复建索引。

use crate::cenc::{spade_to_key, CencIndex};
use crate::upstream::content::{pick_gear, Content, Gear};
use reqwest::Client;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, Mutex};
use url::form_urlencoded;

/// 流式元数据缓存上限（仅保存轻量索引与 256 KiB 首片，不缓存整部视频）。
const MAX_META_ENTRIES: usize = 16;
const META_TTL: Duration = Duration::from_secs(90);
const HEAD_PREFETCH_BYTES: usize = 256 * 1024;
const MAX_MOOV_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
pub struct StreamMeta {
    urls: Vec<String>,
    total_size: usize,
    index: Option<Arc<CencIndex>>,
    head_bytes: Vec<u8>,
    moov_slice: Option<(usize, Vec<u8>)>,
    resolved_at: Instant,
}

struct MetaCache {
    entries: HashMap<String, Arc<StreamMeta>>,
    order: VecDeque<String>,
    inflight: HashMap<String, watch::Sender<bool>>,
}

impl MetaCache {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            inflight: HashMap::new(),
        }
    }

    fn get(&mut self, key: &str) -> Option<Arc<StreamMeta>> {
        if let Some(item) = self.entries.get(key) {
            if item.resolved_at.elapsed() >= META_TTL {
                self.entries.remove(key);
                self.order.retain(|k| k != key);
                return None;
            }
            let meta = item.clone();
            self.order.retain(|k| k != key);
            self.order.push_back(key.to_string());
            return Some(meta);
        }
        None
    }

    fn put(&mut self, key: String, meta: Arc<StreamMeta>) {
        if self.entries.remove(&key).is_some() {
            self.order.retain(|k| k != &key);
        }
        while self.entries.len() >= MAX_META_ENTRIES {
            if let Some(evict_key) = self.order.pop_front() {
                self.entries.remove(&evict_key);
            } else {
                break;
            }
        }
        self.entries.insert(key.clone(), meta);
        self.order.push_back(key);
    }

    fn invalidate(&mut self, key: &str) {
        self.entries.remove(key);
        self.order.retain(|k| k != key);
    }

    fn invalidate_vid(&mut self, vid: &str) {
        let prefix = format!("{vid}|");
        self.entries.retain(|k, _| !k.starts_with(&prefix));
        self.order.retain(|k| !k.starts_with(&prefix));
    }
}

pub struct MediaServer {
    base_url: String,
    stop_tx: watch::Sender<bool>,
    content: Arc<Content>,
    http: Client,
    cache: Arc<Mutex<MetaCache>>,
}

impl MediaServer {
    pub fn start(
        content: Arc<Content>,
        http: Client,
        rt: &tokio::runtime::Handle,
    ) -> Result<Arc<Self>, String> {
        let std_listener = std::net::TcpListener::bind("127.0.0.1:0")
            .map_err(|e| format!("本地媒体服务绑定失败: {e}"))?;
        std_listener
            .set_nonblocking(true)
            .map_err(|e| format!("本地媒体服务设置非阻塞失败: {e}"))?;
        let addr = std_listener
            .local_addr()
            .map_err(|e| format!("获取本地媒体端口失败: {e}"))?;

        let listener = rt
            .block_on(async move { TcpListener::from_std(std_listener) })
            .map_err(|e| format!("创建异步监听失败: {e}"))?;

        let (stop_tx, mut stop_rx) = watch::channel(false);
        let cache = Arc::new(Mutex::new(MetaCache::new()));

        let loop_content = content.clone();
        let loop_http = http.clone();
        let loop_cache = cache.clone();
        rt.spawn(async move {
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
                                let content_c = loop_content.clone();
                                let http_c = loop_http.clone();
                                let cache_c = loop_cache.clone();
                                tokio::spawn(async move {
                                    let _ = handle_conn(stream, content_c, http_c, cache_c).await;
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

        Ok(Arc::new(Self {
            base_url: format!("http://{addr}"),
            stop_tx,
            content,
            http,
            cache,
        }))
    }

    /// 后台预热指定剧集的 256 KiB 首片与 CENC 索引，实现点击播放秒开。
    pub fn prefetch(&self, vid: String, quality: String, rt: &tokio::runtime::Handle) {
        if vid.trim().is_empty() {
            return;
        }
        let content = self.content.clone();
        let http = self.http.clone();
        let cache = self.cache.clone();
        rt.spawn(async move {
            let _ = get_or_resolve_meta(&vid, &quality, &content, &http, &cache).await;
        });
    }

    pub fn base_url(&self) -> String {
        self.base_url.clone()
    }

    pub fn media_url(&self, vid: &str, quality: &str) -> String {
        if quality.trim().is_empty() {
            format!("{}/media/{vid}.mp4", self.base_url)
        } else {
            let encoded: String = form_urlencoded::Serializer::new(String::new())
                .append_pair("q", quality.trim())
                .finish();
            format!("{}/media/{vid}.mp4?{encoded}", self.base_url)
        }
    }

    pub fn shutdown(&self) {
        let _ = self.stop_tx.send(true);
    }

    /// 使指定视频的所有缓存元数据失效（强制下次重新获取播放地址）。
    pub async fn invalidate_vid(&self, vid: &str) {
        self.cache.lock().await.invalidate_vid(vid);
    }

    /// 按 HTTP Range 边下边解边播写出流数据（供主 HTTP 服务与 Android 媒体桥接共同复用）。
    pub async fn stream_range<W: AsyncWrite + Unpin>(
        &self,
        vid: &str,
        quality: &str,
        range_hdr: Option<&str>,
        is_head: bool,
        writer: &mut W,
    ) -> Result<(), String> {
        stream_media_range(
            vid,
            quality,
            range_hdr,
            is_head,
            &self.content,
            &self.http,
            &self.cache,
            writer,
        )
        .await
    }
}

async fn handle_conn(
    stream: TcpStream,
    content: Arc<Content>,
    http: Client,
    cache: Arc<Mutex<MetaCache>>,
) -> Result<(), String> {
    let (reader, mut writer) = stream.into_split();
    let mut buf_reader = BufReader::new(reader);

    let mut request_line = String::new();
    let n = buf_reader
        .read_line(&mut request_line)
        .await
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Ok(());
    }

    let mut range_header: Option<String> = None;
    loop {
        let mut line = String::new();
        let bytes = buf_reader
            .read_line(&mut line)
            .await
            .map_err(|e| e.to_string())?;
        if bytes == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range_header = Some(v.trim().to_string());
            }
        }
    }

    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        write_simple_resp(&mut writer, 400, "Bad Request").await;
        return Ok(());
    }
    let method = parts[0];
    let target = parts[1];
    if method != "GET" && method != "HEAD" {
        write_simple_resp(&mut writer, 405, "Method Not Allowed").await;
        return Ok(());
    }

    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let Some(vid) = parse_media_vid(path) else {
        write_simple_resp(&mut writer, 404, "Not Found").await;
        return Ok(());
    };

    let mut q_pref = String::new();
    for (k, v) in form_urlencoded::parse(query.as_bytes()) {
        if k == "q" {
            q_pref = v.into_owned();
        }
    }

    if let Err(err) = stream_media_range(
        &vid,
        &q_pref,
        range_header.as_deref(),
        method == "HEAD",
        &content,
        &http,
        &cache,
        &mut writer,
    )
    .await
    {
        write_simple_resp(&mut writer, 502, &err).await;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn stream_media_range<W: AsyncWrite + Unpin>(
    vid: &str,
    quality: &str,
    range_hdr: Option<&str>,
    is_head: bool,
    content: &Arc<Content>,
    http: &Client,
    cache: &Arc<Mutex<MetaCache>>,
    writer: &mut W,
) -> Result<(), String> {
    let cache_key = format!("{vid}|{}", if quality.is_empty() { "auto" } else { quality });
    let mut meta = get_or_resolve_meta(vid, quality, content, http, cache).await?;
    let total = meta.total_size;
    if total == 0 {
        return Err("媒体长度为 0".into());
    }

    let (start, end, partial) = match range_hdr {
        Some(rng) => match parse_byte_range(rng, total) {
            Some((s, e)) => (s, e, true),
            None => {
                let hdr = format!(
                    "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\nConnection: close\r\n\r\n"
                );
                let _ = writer.write_all(hdr.as_bytes()).await;
                let _ = writer.flush().await;
                return Ok(());
            }
        },
        None => (0, total - 1, false),
    };

    let content_len = end - start + 1;
    let compute_upstream_start = |m: &StreamMeta| -> usize {
        let mut s = start;
        if s < m.head_bytes.len() {
            let head_end = end.min(m.head_bytes.len() - 1);
            s = head_end + 1;
        }
        if s <= end {
            if let Some((m_off, ref m_bytes)) = m.moov_slice {
                if s >= m_off && end < m_off + m_bytes.len() {
                    s = end + 1;
                }
            }
        }
        s
    };

    let upstream_start = compute_upstream_start(&meta);
    let mut upstream_resp: Option<reqwest::Response> = None;
    if !is_head && upstream_start <= end {
        match open_range_stream(&meta.urls, upstream_start, end, http).await {
            Ok(resp) => {
                upstream_resp = Some(resp);
            }
            Err((_need_refresh, first_err)) => {
                cache.lock().await.invalidate(&cache_key);
                content.forget_play(vid);
                let fresh_meta =
                    get_or_resolve_meta(vid, quality, content, http, cache).await?;
                if fresh_meta.total_size != total {
                    return Err(first_err);
                }
                meta = fresh_meta;
                let retry_start = compute_upstream_start(&meta);
                if retry_start <= end {
                    upstream_resp = Some(
                        open_range_stream(&meta.urls, retry_start, end, http)
                            .await
                            .map_err(|(_, msg)| msg)?,
                    );
                }
            }
        }
    }

    let hdr = if partial {
        format!(
            "HTTP/1.1 206 Partial Content\r\nAccept-Ranges: bytes\r\nContent-Type: video/mp4\r\nContent-Range: bytes {start}-{end}/{total}\r\nContent-Length: {content_len}\r\nConnection: close\r\n\r\n"
        )
    } else {
        format!(
            "HTTP/1.1 200 OK\r\nAccept-Ranges: bytes\r\nContent-Type: video/mp4\r\nContent-Length: {content_len}\r\nConnection: close\r\n\r\n"
        )
    };
    writer
        .write_all(hdr.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    if is_head {
        let _ = writer.flush().await;
        return Ok(());
    }

    // 1) 优先直接写出内存中已预解的头部切片（首帧零网络延迟）
    let mut cur = start;
    if cur < meta.head_bytes.len() {
        let head_end = end.min(meta.head_bytes.len() - 1);
        if writer.write_all(&meta.head_bytes[cur..=head_end]).await.is_err() {
            return Ok(());
        }
        cur = head_end + 1;
    }

    // 1.5) 若尾部 moov 索引已在内存中且覆盖请求范围，直接内存直出避免二次 CDN 往返
    if cur <= end {
        if let Some((m_off, ref m_bytes)) = meta.moov_slice {
            if cur >= m_off && end < m_off + m_bytes.len() {
                if writer
                    .write_all(&m_bytes[cur - m_off..=end - m_off])
                    .await
                    .is_err()
                {
                    return Ok(());
                }
                cur = end + 1;
            }
        }
    }

    // 2) 剩余字节直接按上游 Range 分块拉流，边收边 AES-CTR 原地解密并吐给客户端
    if cur <= end {
        if let Some(mut resp) = upstream_resp {
            let expected_end = end;
            while let Ok(Some(chunk)) = resp.chunk().await {
                if cur > expected_end {
                    break;
                }
                let max_take = (expected_end - cur + 1).min(chunk.len());
                if max_take == 0 {
                    break;
                }
                let mut buf = chunk[..max_take].to_vec();
                if let Some(ref idx) = meta.index {
                    if idx.transform(&mut buf, cur as i64).is_err() {
                        break;
                    }
                }
                if writer.write_all(&buf).await.is_err() {
                    break;
                }
                cur += buf.len();
            }
        }
    }

    let _ = writer.flush().await;
    Ok(())
}

async fn open_range_stream(
    urls: &[String],
    start: usize,
    end: usize,
    http: &Client,
) -> Result<reqwest::Response, (bool, String)> {
    let mut need_refresh = false;
    let mut last_err = String::from("上游请求失败");
    let range_val = format!("bytes={start}-{end}");
    for url in urls {
        match http.get(url).header("Range", &range_val).send().await {
            Ok(resp) => {
                let code = resp.status().as_u16();
                if matches!(code, 401 | 403 | 410) {
                    need_refresh = true;
                    last_err = format!("上游返回 HTTP {code}");
                    continue;
                }
                if !resp.status().is_success() {
                    last_err = format!("上游返回 HTTP {code}");
                    continue;
                }
                return Ok(resp);
            }
            Err(e) => last_err = format!("请求媒体流失败: {e}"),
        }
    }
    Err((need_refresh, last_err))
}

fn parse_media_vid(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/media/")?;
    let vid = rest.strip_suffix(".mp4").unwrap_or(rest);
    if vid.is_empty() || !vid.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(vid.to_string())
}

pub fn parse_byte_range(header: &str, total: usize) -> Option<(usize, usize)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (s_str, e_str) = first.split_once('-')?;
    if s_str.is_empty() {
        let suffix: usize = e_str.trim().parse().ok()?;
        if suffix == 0 || total == 0 {
            return None;
        }
        let start = total.saturating_sub(suffix);
        return Some((start, total - 1));
    }
    let start: usize = s_str.trim().parse().ok()?;
    if start >= total {
        return None;
    }
    let end = if e_str.trim().is_empty() {
        total - 1
    } else {
        e_str.trim().parse::<usize>().ok()?.min(total - 1)
    };
    if start > end {
        return None;
    }
    Some((start, end))
}

async fn write_simple_resp(writer: &mut tokio::net::tcp::OwnedWriteHalf, status: u16, msg: &str) {
    let reason = match status {
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Bad Gateway",
    };
    let body = msg.as_bytes();
    let hdr = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = writer.write_all(hdr.as_bytes()).await;
    let _ = writer.write_all(body).await;
    let _ = writer.flush().await;
}

async fn get_or_resolve_meta(
    vid: &str,
    quality: &str,
    content: &Arc<Content>,
    http: &Client,
    cache: &Arc<Mutex<MetaCache>>,
) -> Result<Arc<StreamMeta>, String> {
    let cache_key = format!("{vid}|{}", if quality.is_empty() { "auto" } else { quality });
    loop {
        let wait_rx = {
            let mut guard = cache.lock().await;
            if let Some(hit) = guard.get(&cache_key) {
                return Ok(hit);
            }
            if let Some(tx) = guard.inflight.get(&cache_key) {
                Some(tx.subscribe())
            } else {
                let (tx, _rx) = watch::channel(false);
                guard.inflight.insert(cache_key.clone(), tx);
                None
            }
        };

        if let Some(mut rx) = wait_rx {
            if !*rx.borrow_and_update() {
                let _ = rx.changed().await;
            }
            continue;
        }
        break;
    }

    let res = resolve_stream_meta(vid, quality, content, http).await;
    let mut guard = cache.lock().await;
    let tx = guard.inflight.remove(&cache_key);
    let out = match res {
        Ok(meta) => {
            let arc = Arc::new(meta);
            guard.put(cache_key, arc.clone());
            Ok(arc)
        }
        Err(e) => Err(e),
    };
    drop(guard);
    if let Some(tx) = tx {
        let _ = tx.send(true);
    }
    out
}

async fn fetch_range_bytes(
    urls: &[String],
    start: usize,
    end: usize,
    http: &Client,
) -> Result<(Vec<u8>, Option<usize>), (bool, String)> {
    let mut resp = open_range_stream(urls, start, end, http).await?;
    let total_size = resp
        .headers()
        .get("content-range")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.rsplit('/').next())
        .and_then(|s| s.trim().parse::<usize>().ok())
        .or_else(|| {
            if resp.status().as_u16() == 200 {
                resp.content_length().map(|n| n as usize)
            } else {
                None
            }
        });

    let mut out = Vec::with_capacity((end - start + 1).min(MAX_MOOV_BYTES));
    let mut limit = end - start + 1;
    while limit > 0 {
        match resp.chunk().await {
            Ok(Some(c)) => {
                let take = c.len().min(limit);
                out.extend_from_slice(&c[..take]);
                limit -= take;
                if c.len() > take {
                    break;
                }
            }
            Ok(None) => break,
            Err(e) => return Err((false, format!("读取媒体范围数据失败: {e}"))),
        }
    }
    Ok((out, total_size))
}

fn parse_top_box_header(buf: &[u8]) -> Option<(usize, [u8; 4], usize)> {
    if buf.len() < 8 {
        return None;
    }
    let size32 = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    let typ = [buf[4], buf[5], buf[6], buf[7]];
    if size32 == 1 {
        if buf.len() < 16 {
            return None;
        }
        let s64 = u64::from_be_bytes([
            buf[8], buf[9], buf[10], buf[11], buf[12], buf[13], buf[14], buf[15],
        ]) as usize;
        Some((s64, typ, 16))
    } else {
        Some((size32, typ, 8))
    }
}

async fn resolve_stream_meta(
    vid: &str,
    quality: &str,
    content: &Content,
    http: &Client,
) -> Result<StreamMeta, String> {
    let mut fresh = false;
    for attempt in 0..2 {
        let gears = content.play(vid, fresh).await?;
        let gear = pick_gear(&gears, quality, 1080)
            .cloned()
            .ok_or_else(|| "暂无可用播放清晰度".to_string())?;
        let urls = collect_gear_urls(&gear);
        if urls.is_empty() {
            return Err("播放地址为空".into());
        }

        let (mut head_bytes, maybe_total) =
            match fetch_range_bytes(&urls, 0, HEAD_PREFETCH_BYTES - 1, http).await {
                Ok(v) => v,
                Err((true, _)) if attempt == 0 => {
                    fresh = true;
                    continue;
                }
                Err((_, e)) => return Err(e),
            };
        let total_size = maybe_total.unwrap_or(if gear.size > 0 {
            gear.size as usize
        } else {
            head_bytes.len()
        });
        if total_size == 0 || head_bytes.is_empty() {
            return Err("媒体数据为空".into());
        }

        if !gear.encrypted || gear.spade_a.is_empty() {
            return Ok(StreamMeta {
                urls,
                total_size,
                index: None,
                head_bytes,
                moov_slice: None,
                resolved_at: Instant::now(),
            });
        }

        // 查找加密 MP4 中的 moov 盒子并构建轻量 CENC 解密索引（不下载整部 mdat）
        let mut at = 0usize;
        let mut moov_pair: Option<(usize, Vec<u8>)> = None;
        for _ in 0..64 {
            if at + 8 > total_size {
                break;
            }
            let hdr_slice: Vec<u8> = if at + 16 <= head_bytes.len() {
                head_bytes[at..at + 16].to_vec()
            } else {
                let end = (at + 15).min(total_size - 1);
                fetch_range_bytes(&urls, at, end, http)
                    .await
                    .map_err(|(_, e)| e)?
                    .0
            };
            let Some((raw_size, typ, hdr_len)) = parse_top_box_header(&hdr_slice) else {
                break;
            };
            let box_size = if raw_size == 0 {
                total_size - at
            } else {
                raw_size
            };
            if box_size < hdr_len || at + box_size > total_size {
                return Err("视频索引结构损坏".into());
            }
            if &typ == b"moov" {
                if box_size > MAX_MOOV_BYTES {
                    return Err("视频索引过大".into());
                }
                let moov_bytes = if at + box_size <= head_bytes.len() {
                    head_bytes[at..at + box_size].to_vec()
                } else {
                    fetch_range_bytes(&urls, at, at + box_size - 1, http)
                        .await
                        .map_err(|(_, e)| e)?
                        .0
                };
                moov_pair = Some((at, moov_bytes));
                break;
            }
            at += box_size;
        }

        let (moov_off, moov_bytes) =
            moov_pair.ok_or_else(|| "未找到加密视频索引 (moov)".to_string())?;
        let key = spade_to_key(&gear.spade_a).ok_or_else(|| "解析媒体密钥失败".to_string())?;
        let need_moov_slice = moov_off + moov_bytes.len() > head_bytes.len();
        let (idx, mut moov_bytes) = tokio::task::spawn_blocking(move || {
            let idx = CencIndex::new(&moov_bytes, moov_off as i64, &key)?;
            Ok::<_, String>((idx, moov_bytes))
        })
        .await
        .map_err(|e| format!("索引构建线程异常: {e}"))??;
        let idx = Arc::new(idx);
        idx.transform(&mut head_bytes, 0)?;
        let moov_slice = if need_moov_slice {
            idx.transform(&mut moov_bytes, moov_off as i64)?;
            Some((moov_off, moov_bytes))
        } else {
            None
        };

        return Ok(StreamMeta {
            urls,
            total_size,
            index: Some(idx),
            head_bytes,
            moov_slice,
            resolved_at: Instant::now(),
        });
    }
    Err("解析媒体流失败".into())
}

fn collect_gear_urls(g: &Gear) -> Vec<String> {
    let mut out = Vec::new();
    if !g.main_url.trim().is_empty() {
        out.push(g.main_url.clone());
    }
    if !g.backup_url.trim().is_empty() && !out.contains(&g.backup_url) {
        out.push(g.backup_url.clone());
    }
    for u in &g.backup_urls {
        if !u.trim().is_empty() && !out.contains(u) {
            out.push(u.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_media_vid_and_range() {
        assert_eq!(parse_media_vid("/media/123456.mp4"), Some("123456".into()));
        assert_eq!(parse_media_vid("/media/bad.mp4"), None);
        assert_eq!(parse_media_vid("/other/123.mp4"), None);

        assert_eq!(parse_byte_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_byte_range("bytes=500-", 1000), Some((500, 999)));
        assert_eq!(parse_byte_range("bytes=-200", 1000), Some((800, 999)));
        assert_eq!(parse_byte_range("bytes=1000-1005", 1000), None);
    }

    #[test]
    fn test_meta_cache_put_and_hit() {
        let mut cache = MetaCache::new();
        let meta = Arc::new(StreamMeta {
            urls: vec!["http://example.com/v.mp4".into()],
            total_size: 4096,
            index: None,
            head_bytes: vec![1, 2, 3, 4],
            moov_slice: None,
            resolved_at: Instant::now(),
        });
        cache.put("v1|1080p".into(), meta);
        assert_eq!(cache.get("v1|1080p").unwrap().head_bytes, &[1, 2, 3, 4]);
        assert!(cache.get("missing").is_none());
    }
}
