# 绿果 Core SDK 接入指南与动作手册（API_SPEC v1）

`lvguo-core` 将全部上游协议签名、设备注册、扫码/短信登录、内容检索、CENC 流式解密、多线程离线下载以及单文件热更新封装在单一原生动态库内。任何语言或 UI 框架均可直接嵌入或复用。

---

## 一、三层对接方式（全语言通用）

1. **C / C++ / Rust / Go / Python / Electron / Qt / .NET（推荐 C-ABI + `libloading`/`dlopen`）**
   - 直接引入 [lvguo_core.h](./lvguo_core.h)，先按「热更目录 `<dataDir>/core_hot/<lib>` 优先 + `.attempt` 防崩回退基线」加载动态库；
   - 若只需要做自定义原生 UI：调用 `lvguo_init` 后通过 `lvguo_call(action, paramsJson)` 驱动全套业务；
   - 若要复用现成前端（`web-ui/`）：再调用 `lvguo_start_http(...)` 直接开放统一 `/api/*` 与 `/media/:vid.mp4` 端点。
2. **Android / Android TV（内置 JNI）**
   - `liblvguo_core.so` 已内置 `ink.pengfei.lvguo.core.CoreBridge` JNI 符号：
     - `nativeAbiVersion() -> int`
     - `nativeVersion() -> String`
     - `nativeInit(String configJson) -> String`
     - `nativeCall(String action, String paramsJson) -> String`
     - `nativeShutdown() -> void`
   - 启动 `nativeInit` 时会自动开启低内存适配的本地解密流媒体端口（返回 `mediaBaseUrl`），直接交给 Media3 / ExoPlayer 拖动播放，Java 层无需保留任何加解密或签名逻辑。
3. **跨语言 HTTP RPC（`POST /api/call`）**
   - 请求体：`{"action": "<action_name>", "params": { ... }}`
   - 响应体：`{"ok": true, "data": ...}` 或 `{"ok": false, "error": "..."}`

---

## 二、Core Actions 总表

> **无邀请码 / 无强制登录**：浏览、榜单、分类筛选、搜索、详情、分季、评论与 1080p/720p 在线播放/下载全部默认直接可用；登录仅用于云端同步个人收藏、观看历史与预约提醒。

### 基础信息
| Action | 参数 | 返回说明 |
| --- | --- | --- |
| `core.info` | `{}` | 返回 `version`、`abiVersion`、`target`、`mediaBaseUrl`、`dataDir`、`capabilities` |

### 内容浏览、解析与流媒体
| Action | 主要参数 | 返回说明 |
| --- | --- | --- |
| `home` | `{}` | 首页继续观看、推荐频道与首屏推荐流 |
| `foryou` | `{"channel":"16","offset":0,"cell":"","session":""}` | 个性化推荐流分页 |
| `rank` | `{"board":"ranklist_hot_sc","offset":0,"session":""}` | 榜单分页（`ranklist_hot_sc` / `ranklist_hot_play_sc` / `ranklist_new_rank_sc`） |
| `category.options` | `{"type":"all"}` | 返回 `types` 与各板块筛选维度 `boards` |
| `category.list` | `{"type":"all","board":"...","selected":{},"offset":0,"session":""}` | 多维组合筛选列表 |
| `search` | `{"q":"关键词","page":1}` | 在线搜索（支持剧名/演员） |
| `suggest` | `{"q":"关键词"}` | 搜索联想词 |
| `detail` | `{"id":"seriesId","lite":false}` | 剧集详情、全集列表、演职员、分季标记及本地/云端进度 |
| `seasons` | `{"id":"seriesId","quick":false}` | 同专辑多季列表 |
| `comments` | `{"id":"seriesId","vid":"epVid","offset":0}` | 剧评与分集评论 |
| `play` | `{"vid":"epVid","q":"1080p","fresh":false,"prefetch":false}` | 清晰度列表、分辨率与本地解密流地址 `mediaUrl` |

### 可选账号同步
| Action | 主要参数 | 返回说明 |
| --- | --- | --- |
| `me` | `{}` | 返回 `loggedIn` 与 `profile` / `daysLeft` |
| `login.qr.start` | `{}` | 获取扫码登录二维码 Base64 与轮询 `token` |
| `login.qr.poll` | `{"token":"..."}` | 轮询扫码状态（`waiting`/`scanned`/`confirmed`/`expired`/`canceled`） |
| `login.phone.send` | `{"phone":"138...","sessionId":""}` | 发送短信验证码 |
| `login.phone.login` | `{"sessionId":"...","code":"123456"}` | 短信登录（需要二次验证时返回 `status:"mfa"`） |
| `login.phone.verify` | `{"sessionId":"..."}` | 查询并确认风控上行短信 |
| `logout` | `{}` | 登出并清空会话 |
| `history.list` / `history.delete` | `limit` / `seriesId` | 观看历史读取（优先云端，未登录走本地缓存）与删除 |
| `favorites.list` / `favorite.set` | `seriesId`, `add` | 云端收藏读写（需已登录） |
| `reservations.list` / `reservation.set` | `online`, `seriesId`, `add` | 在线/待上线预约读写 |
| `progress.report` | `seriesId`, `vid`, `index`, `positionMs`, `title`, `cover`, `episodeCount` | 本地与云端播放进度上报 |

### 多线程断点下载（PC / 原生宿主）
| Action | 主要参数 | 返回说明 |
| --- | --- | --- |
| `download.list` | `{}` | 当前所有下载任务与实时速度 |
| `download.summary` | `{}` | 活跃任务数 |
| `download.add` / `download.add_batch` | `seriesId`, `seriesTitle`, `vid`, `episodeIndex`, `definition` 等 | 添加单集或批量剧集（支持 HTTP Range 多线程分段与 CENC 解密落盘） |
| `download.action` | `{"id":"...","action":"pause|resume|delete"}` | 单任务控制 |
| `download.delete_batch` | `{"seriesId":"...","ids":[...]}` | 批量清理任务及本地文件 |
| `download.settings.get` / `download.settings.set` | `maxConcurrent`, `threadsPerTask`, `speedLimitKbps`, `preferredQuality`, `downloadDir` 等 | 读取/更新并发数与限速配置 |
| `download.local` / `download.open` | `vid` / `seriesId` | 查询已下载文件路径或调用系统文件管理器打开 |

### 客户端自身升级与单文件 Core 热更新（详见 [UPDATE_SPEC.md](./UPDATE_SPEC.md)）
| Action | 主要参数 | 返回说明 |
| --- | --- | --- |
| `app.update.check` | `{"appVersion":"1.0.0","url":""}` | 检查宿主客户端本身安装包升级（禁用更新渠道时纯离线返回 `disabled:true`） |
| `core.update.status` | `{}` | 当前核心版本、更新渠道、是否已就绪新包及错误状态 |
| `core.update.check` | `{"autoDownload":true}` | 立即按当前渠道拉取清单并单文件校验落盘 |
| `core.update.channel` | `{"mode":"default|custom|disabled","customUrl":"..."}` | 切换更新源插槽 |
| `core.update.rollback` | `{}` | 删除待生效热更文件，下次启动回退基线 |

---

## 三、能力协商接口（`GET /api/capabilities`）

统一 Web 前端（`web-ui/`）启动后首先请求 `/api/capabilities`，据此动态决定是否显示桌面专属高级面板：

```json
{
  "desktop": true,
  "download": true,
  "nativePlayer": true,
  "gpuShaders": true,
  "coreUpdate": true,
  "coreVersion": "1.0.0",
  "target": "windows-x86_64"
}
```

- Web 服务端模式（`lvguo-web`）：仅开启 `coreUpdate: true`，界面聚焦纯浏览与网页播放；
- PC 桌面模式（`lvguo-pc`）：解锁多集批量多线程下载、离线优先播放、`mpv` 独立 GPU 硬件解码窗口（CAS 锐化 / FSR 超分 GLSL 着色器）、热更新渠道配置。
