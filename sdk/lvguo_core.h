#ifndef LVGUO_CORE_H
#define LVGUO_CORE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * 绿果统一共享核心库（liblvguo_core.so / lvguo_core.dll / liblvguo_core.dylib）C-ABI 头文件。
 *
 * 所有返回堆分配 `char*` 的函数（`lvguo_init` / `lvguo_call` / `lvguo_start_http`）
 * 均统一输出 UTF-8 JSON：
 * - 成功：`{"ok":true,"data":...}`
 * - 失败：`{"ok":false,"error":"..."}`
 * 调用方使用完毕后必须调用 `lvguo_free()` 释放对应字符串内存。
 */

#define LVGUO_CORE_ABI_VERSION 1u

/** 宿主内嵌静态资源查找回调：命中返回 1 并填充 ptr/len/mime，未命中返回 0。 */
typedef int (*LvguoAssetCallback)(
    const char *path,
    const uint8_t **out_ptr,
    size_t *out_len,
    const char **out_mime
);

/** 宿主原生播放器回调（例如调用 mpv / GPU 超分渲染）：写入结果 JSON 至 out_buf 并返回字节数。 */
typedef int (*LvguoNativePlayCallback)(
    const char *payload_json,
    char *out_buf,
    size_t out_cap
);

/** 返回核心库当前实现的 C-ABI 主版本号。宿主应在加载热更包后立即比对。 */
uint32_t lvguo_core_abi_version(void);

/** 返回核心库版本字符串（静态只读内存，不可释放）。 */
const char *lvguo_core_version(void);

/**
 * 初始化全局共享核心上下文（只需调用一次）。
 *
 * `config_json` 示例：
 *   {"dataDir":"/path/to/data","hostKind":"pc","updateMode":"default","customUpdateUrl":""}
 * 也可传入纯目录路径字符串或 NULL 使用系统默认目录。
 */
char *lvguo_init(const char *config_json);

/**
 * 同步调用任意 Core Action（详见 sdk/API_SPEC.md）。
 * `params_json` 为 JSON 对象字符串，允许为 NULL 或 "{}"。
 */
char *lvguo_call(const char *action, const char *params_json);

/**
 * 启动核心内嵌轻量 HTTP/1.1 服务，提供 `/api/*`、`/api/capabilities`、`/api/call` 与 `/media/:vid.mp4`。
 * - `bind_addr`: 监听地址，如 `"127.0.0.1:0"` 或 `"0.0.0.0:8780"`
 * - `static_dir`: 可选磁盘静态目录（搭配 `lvguo_register_asset_provider` 使用时可传 NULL）
 * - `caps_json`: 宿主能力 JSON，如 `{"desktop":true,"download":true,"nativePlayer":true,"gpuShaders":true,"coreUpdate":true}`
 */
char *lvguo_start_http(
    const char *bind_addr,
    const char *static_dir,
    const char *caps_json
);

/** 注册宿主内嵌前端资产回调（使 Web / PC 可直接从可执行文件零散落文件托管 UI）。 */
int lvguo_register_asset_provider(LvguoAssetCallback cb);

/** 注册宿主原生播放器回调，让前端可唤起本地 GPU 硬件加速播放器。 */
int lvguo_register_native_player(LvguoNativePlayCallback cb);

/** 关闭核心运行时、本地媒体解密服务与后台下载调度器。 */
void lvguo_shutdown(void);

/** 释放由 `lvguo_init` / `lvguo_call` / `lvguo_start_http` 返回的字符串指针。 */
void lvguo_free(char *ptr);

#ifdef __cplusplus
}
#endif

#endif /* LVGUO_CORE_H */
