# 绿果 Core 单文件热更新规范（UPDATE_SPEC v1）

`lvguo-core` 采用**插槽式更新渠道 + 单文件热替换**机制。任何个人或团队均可通过接入本规范搭建完全独立的自建更新服务，实现脱离官方更新源的自主分发。

---

## 一、核心原则（严格单文件）

1. **只更新单个核心动态库二进制文件**：
   - Windows: `lvguo_core.dll`
   - Linux / Android: `liblvguo_core.so`
   - macOS: `liblvguo_core.dylib`
   热更新目录（`<dataDir>/core_hot/`）**只允许下载和落盘上述唯一目标二进制文件**，**绝对不下载、不依赖也不生成任何外部 JSON/DEX 策略配置**。
2. **插槽式三档更新渠道**：
   - `default`：使用内置默认官方更新源；
   - `custom`：接入任意自建 Manifest JSON URL；
   - `disabled`：纯离线独立模式，不发起任何更新检查网络请求。
3. **完整性与架构安全校验**：
   - 下载完成后先核对字节长度与 **SHA-256** 摘要；
   - 校验目标平台二进制魔数（ELF `0x7F 'E' 'L' 'F'` / PE `'M' 'Z'` / Mach-O `0xFEEDFACF` 等）；
   - 校验证书与 `abiVersion` 一致后通过临时文件原子重命名替换 `<dataDir>/core_hot/<filename>`。
4. **防崩回退保护**：
   - 各端宿主加载热更包前写入瞬态 `.attempt` 标记并在 `lvguo_init` / `nativeInit` 成功后立即删除；
   - 若连续两次启动未健康完成初始化，宿主自动清理问题热更文件并无缝回退到内置基线版本。

---

## 二、支持的平台标识（`target`）

| `target` | 平台与架构 | 核心产物文件名 |
| --- | --- | --- |
| `android-arm64-v8a` | Android / TV 64 位 | `liblvguo_core.so` |
| `android-armeabi-v7a` | Android / TV 32 位 | `liblvguo_core.so` |
| `windows-x86_64` | Windows 64 位 | `lvguo_core.dll` |
| `windows-x86` | Windows 32 位（兼容老系统） | `lvguo_core.dll` |
| `linux-x86_64` | Linux x86_64 | `liblvguo_core.so` |
| `linux-x86` | Linux i686 32 位 | `liblvguo_core.so` |
| `linux-aarch64` | Linux ARM64 | `liblvguo_core.so` |
| `linux-armv7` | Linux ARMv7 32 位 | `liblvguo_core.so` |
| `macos-aarch64` | macOS Apple Silicon | `liblvguo_core.dylib` |
| `macos-x86_64` | macOS Intel | `liblvguo_core.dylib` |

---

## 三、请求与响应协议

### 1. 检查更新请求

Core 会向更新渠道 URL 发起 `HTTP GET` 请求（`Timeout: 15s`），并自动附加以下查询参数：

```text
GET <channel_url>?target=<target>&version=<current_version>&abiVersion=<abi_version>
```

示例：

```text
GET https://example.com/lvguo/core-manifest.json?target=android-armeabi-v7a&version=1.0.0&abiVersion=1
```

### 2. Manifest JSON 响应格式

服务端可返回按当前 `target` 定制的 `artifact`（推荐，响应体积更小），也可返回包含全部平台的 `artifacts` 映射表，两者 Core 均兼容解析：

```json
{
  "schema": 1,
  "abiVersion": 1,
  "version": "1.0.1",
  "notes": "修复播放签名参数，优化缓冲速度",
  "publishedAt": "2026-11-26T12:00:00Z",
  "update": true,
  "artifact": {
    "filename": "liblvguo_core.so",
    "url": "https://cdn.example.com/lvguo-core/1.0.1/android-armeabi-v7a/liblvguo_core.so",
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "size": 2948120
  }
}
```

兼容静态 CDN 多端总表格式（例如直接将单个静态 `manifest.json` 托管在 GitHub Pages / OSS / Nginx）：

```json
{
  "schema": 1,
  "abiVersion": 1,
  "version": "1.0.1",
  "notes": "1.0.1 更新说明",
  "artifacts": {
    "windows-x86_64": {
      "filename": "lvguo_core.dll",
      "url": "https://cdn.example.com/1.0.1/windows-x86_64/lvguo_core.dll",
      "sha256": "...",
      "size": 4512000
    },
    "linux-x86_64": {
      "filename": "liblvguo_core.so",
      "url": "https://cdn.example.com/1.0.1/linux-x86_64/liblvguo_core.so",
      "sha256": "...",
      "size": 5210000
    }
  }
}
```

### 字段校验规则

- `abiVersion`：必须等于当前宿主支持的 ABI 版本（当前为 `1`）。若不一致，Core 将拒绝下载热更，避免跨 ABI 破坏二进制兼容；
- `version`：采用点分语义版本号比较（如 `1.0.1 > 1.0.0`）；若服务端下发 `update: false`，则不下载；
- `sha256`：必填 64 位十六进制 SHA-256 校验和（大小写不敏感）；
- `url`：仅允许合法 `http://` 或 `https://` 二进制直链，限制单包最大 `128 MiB`。
