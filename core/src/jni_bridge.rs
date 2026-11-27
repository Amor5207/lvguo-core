//! Android JNI 桥接层（仅在 `target_os = "android"` 时编译进同一个 `liblvguo_core.so`）。
//!
//! 让 Android TV 宿主与桌面端共享**同一个单一核心动态库**，Java 层无需再维护任何协议签名或网络同步代码。

use crate::config::{CoreInitConfig, CORE_ABI_VERSION, CORE_VERSION};
use crate::runtime::{current_core, init_core, shutdown_core};
use jni::objects::{JClass, JString};
use jni::sys::{jint, jstring};
use jni::JNIEnv;
use serde_json::{json, Value};

fn get_str(env: &mut JNIEnv, s: JString) -> String {
    if s.is_null() {
        return String::new();
    }
    env.get_string(&s)
        .map(|js| js.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn new_jstr(env: &mut JNIEnv, s: &str) -> jstring {
    env.new_string(s)
        .map(|js| js.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub extern "system" fn Java_ink_pengfei_lvguo_core_CoreBridge_nativeAbiVersion(
    _env: JNIEnv,
    _cls: JClass,
) -> jint {
    CORE_ABI_VERSION as jint
}

#[no_mangle]
pub extern "system" fn Java_ink_pengfei_lvguo_core_CoreBridge_nativeVersion(
    mut env: JNIEnv,
    _cls: JClass,
) -> jstring {
    new_jstr(&mut env, CORE_VERSION)
}

#[no_mangle]
pub extern "system" fn Java_ink_pengfei_lvguo_core_CoreBridge_nativeInit(
    mut env: JNIEnv,
    _cls: JClass,
    config_json: JString,
) -> jstring {
    let raw = get_str(&mut env, config_json);
    let mut cfg: CoreInitConfig = serde_json::from_str(&raw).unwrap_or_default();
    if cfg.host_kind.is_empty() {
        cfg.host_kind = "android-tv".into();
    }
    cfg.low_memory = true;
    let resp = match init_core(cfg) {
        Ok(c) => json!({
            "ok": true,
            "data": {
                "version": CORE_VERSION,
                "abiVersion": CORE_ABI_VERSION,
                "target": crate::config::current_target_id(),
                "mediaBaseUrl": c.media_server.base_url(),
                "dataDir": c.data_dir.to_string_lossy(),
            }
        }),
        Err(e) => json!({ "ok": false, "error": e }),
    };
    new_jstr(&mut env, &resp.to_string())
}

#[no_mangle]
pub extern "system" fn Java_ink_pengfei_lvguo_core_CoreBridge_nativeCall(
    mut env: JNIEnv,
    _cls: JClass,
    action: JString,
    params_json: JString,
) -> jstring {
    let act = get_str(&mut env, action);
    let raw_params = get_str(&mut env, params_json);
    let params: Value = if raw_params.trim().is_empty() {
        json!({})
    } else {
        match serde_json::from_str(&raw_params) {
            Ok(v) => v,
            Err(e) => {
                let err = json!({ "ok": false, "error": format!("参数 JSON 无效: {e}") });
                return new_jstr(&mut env, &err.to_string());
            }
        }
    };
    let resp = match current_core() {
        Ok(core) => match core.rt.block_on(core.dispatch(act.trim(), params)) {
            Ok(data) => json!({ "ok": true, "data": data }),
            Err(e) => json!({ "ok": false, "error": e }),
        },
        Err(e) => json!({ "ok": false, "error": e }),
    };
    new_jstr(&mut env, &resp.to_string())
}

#[no_mangle]
pub extern "system" fn Java_ink_pengfei_lvguo_core_CoreBridge_nativeShutdown(
    _env: JNIEnv,
    _cls: JClass,
) {
    shutdown_core();
}
