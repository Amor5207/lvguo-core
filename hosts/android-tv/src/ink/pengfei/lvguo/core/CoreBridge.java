package ink.pengfei.lvguo.core;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONObject;

import java.io.IOException;

/**
 * 绿果 Core JNI 统一桥接器。
 *
 * 所有内容抓取、接口签名、设备注册、扫码/短信登录、云端同步及 CENC 解密流媒体服务
 * 均由单一 {@code liblvguo_core.so} 提供，TV Java 层只负责界面展示与播放器宿主控制。
 */
public final class CoreBridge {
    private static final String TAG = "LvguoCoreBridge";
    public static final int EXPECTED_ABI_VERSION = 1;

    private static final String PREF_UPDATE_MODE = "core_update_mode";
    private static final String PREF_UPDATE_URL = "core_update_custom_url";

    private static volatile boolean initialized;
    private static volatile String version = "";
    private static volatile String target = "";
    private static volatile String mediaBaseUrl = "";

    private CoreBridge() {}

    // JNI 原生入口（方法名与签名严格对应 core/src/jni_bridge.rs）
    public static native int nativeAbiVersion();
    public static native String nativeVersion();
    public static native String nativeInit(String configJson);
    public static native String nativeCall(String action, String paramsJson);
    public static native void nativeShutdown();

    /** 初始化 Core 运行时，返回是否成功；失败时安全清理异常热更包。 */
    public static synchronized void init(Context ctx) {
        if (initialized) return;
        CoreLoader.ensureLoaded(ctx);

        int abi = 0;
        try {
            abi = nativeAbiVersion();
        } catch (Throwable err) {
            if (CoreLoader.isLoadedFromHot()) CoreLoader.invalidateHot(ctx);
            throw new IllegalStateException("Core ABI 读取失败: " + err.getMessage(), err);
        }
        if (abi != EXPECTED_ABI_VERSION) {
            if (CoreLoader.isLoadedFromHot()) CoreLoader.invalidateHot(ctx);
            Log.w(TAG, "Core ABI 不匹配: got=" + abi + " expected=" + EXPECTED_ABI_VERSION);
        }

        SharedPreferences prefs = ctx.getSharedPreferences("lvguo", Context.MODE_PRIVATE);
        JSONObject cfg = new JSONObject();
        try {
            cfg.put("dataDir", ctx.getFilesDir().getAbsolutePath());
            cfg.put("hostKind", "android-tv");
            cfg.put("lowMemory", true);
            String mode = prefs.getString(PREF_UPDATE_MODE, "");
            String customUrl = prefs.getString(PREF_UPDATE_URL, "");
            if (mode != null && !mode.isEmpty()) cfg.put("updateMode", mode);
            if (customUrl != null && !customUrl.isEmpty()) cfg.put("customUpdateUrl", customUrl);
        } catch (Exception ignored) {}

        String raw = nativeInit(cfg.toString());
        try {
            JSONObject resp = new JSONObject(raw == null ? "{}" : raw);
            if (!resp.optBoolean("ok", false)) {
                String msg = resp.optString("error", "Core 初始化失败");
                Log.e(TAG, msg);
                return;
            }
            JSONObject data = resp.optJSONObject("data");
            if (data != null) {
                version = data.optString("version", "");
                target = data.optString("target", "");
                mediaBaseUrl = data.optString("mediaBaseUrl", "");
            }
            CoreLoader.markHealthy(ctx);
            initialized = true;
            Log.i(TAG, "Core 就绪 version=" + version + " target=" + target + " hot=" + CoreLoader.isLoadedFromHot());
        } catch (Exception e) {
            Log.e(TAG, "解析 nativeInit 响应失败: " + raw, e);
        }
    }

    public static String version() {
        if (!version.isEmpty()) return version;
        try {
            return initialized ? nativeVersion() : "";
        } catch (Throwable ignored) {
            return "";
        }
    }

    public static String target() { return target; }
    public static String mediaBaseUrl() { return mediaBaseUrl; }

    /** 执行指定 Core Action 并解包返回 data 对象，失败抛出 IOException。 */
    public static JSONObject call(String action, JSONObject params) throws IOException {
        if (!initialized) throw new IOException("核心尚未初始化");
        String payload = params == null ? "{}" : params.toString();
        String raw = nativeCall(action, payload);
        if (raw == null || raw.isEmpty()) throw new IOException("核心返回空响应");
        try {
            JSONObject obj = new JSONObject(raw);
            if (!obj.optBoolean("ok", false)) {
                throw new IOException(obj.optString("error", "核心调用失败"));
            }
            JSONObject data = obj.optJSONObject("data");
            return data != null ? data : new JSONObject();
        } catch (IOException io) {
            throw io;
        } catch (Exception e) {
            throw new IOException("核心响应解析失败: " + e.getMessage(), e);
        }
    }

    /** 静默执行 Core Action，发生异常返回 null。 */
    public static JSONObject callQuiet(String action, JSONObject params) {
        try {
            return call(action, params);
        } catch (Throwable e) {
            Log.w(TAG, "action=" + action + " failed: " + e.getMessage());
            return null;
        }
    }

    /** 保存更新通道偏好（用于下次冷启动传入 CoreInitConfig，无额外配置文件落地）。 */
    public static void saveUpdateChannelPref(Context ctx, String mode, String customUrl) {
        SharedPreferences.Editor ed = ctx.getSharedPreferences("lvguo", Context.MODE_PRIVATE).edit();
        if (mode == null || mode.isEmpty()) ed.remove(PREF_UPDATE_MODE);
        else ed.putString(PREF_UPDATE_MODE, mode);
        if (customUrl == null || customUrl.isEmpty()) ed.remove(PREF_UPDATE_URL);
        else ed.putString(PREF_UPDATE_URL, customUrl);
        ed.apply();
    }
}
