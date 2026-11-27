package ink.pengfei.lvguo.core;

import android.app.Activity;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

import ink.pengfei.lvguo.core.CoreBridge;
import ink.pengfei.lvguo.core.CoreLoader;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 单文件 Core 自更新管理器（仅下载与校验唯一 {@code liblvguo_core.so}，不下载任何外部配置或 DEX）。
 */
public final class CoreUpdateManager {
    private CoreUpdateManager() {}

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final ExecutorService POOL = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "core-update");
        t.setDaemon(true);
        return t;
    });

    private static volatile boolean checking;
    private static volatile String latestVersion = "";
    private static volatile boolean stagedExists;
    private static volatile boolean restartRequired;
    private static volatile String mode = "default";
    private static volatile String customUrl = "";
    private static volatile String lastError = "";

    public static void cleanup(Context c) {
        POOL.execute(CoreUpdateManager::refreshStatusSync);
    }

    public static void onHomeResume(Activity host) {
        POOL.execute(() -> {
            refreshStatusSync();
            if ("disabled".equals(mode)) return;
            CoreBridge.callQuiet("core.update.check", quietBool("autoDownload", true));
            refreshStatusSync();
        });
    }

    public static void onItemClick(Activity host) {
        if (checking) {
            toast(host, "正在检查 Core 更新…");
            return;
        }
        checking = true;
        toast(host, "正在检查 Core 更新…");
        POOL.execute(() -> {
            String msg;
            try {
                JSONObject st = CoreBridge.call("core.update.check", quietBool("autoDownload", true));
                applyStatus(st);
                if (restartRequired || stagedExists) {
                    msg = "已就绪新版 Core " + (latestVersion.isEmpty() ? "" : latestVersion) + "，重启应用后生效";
                } else if (!lastError.isEmpty()) {
                    msg = lastError;
                } else {
                    msg = "当前 Core 已是最新";
                }
            } catch (Throwable e) {
                msg = "检查失败: " + (e.getMessage() == null ? "网络异常" : e.getMessage());
            } finally {
                checking = false;
            }
            final String fmsg = msg;
            MAIN.post(() -> toast(host, fmsg));
        });
    }

    public static String statusLabel() {
        refreshAsyncIfNeeded();
        if (checking) return "检查中…";
        if (restartRequired || stagedExists) {
            return "重启生效";
        }
        String v = CoreBridge.version();
        if (v.isEmpty()) return "已是最新";
        return (v.startsWith("v") || v.startsWith("V")) ? v.substring(1) : v;
    }

    public static String availableVersion() {
        return (restartRequired || stagedExists) && !latestVersion.isEmpty() ? latestVersion : null;
    }

    public static String currentMode() {
        return mode;
    }

    public static String currentCustomUrl() {
        return customUrl;
    }

    public static String modeLabel() {
        if ("custom".equals(mode)) return "自建渠道";
        if ("disabled".equals(mode)) return "已关闭";
        return "官方默认";
    }

    public static void setChannel(Context ctx, String nextMode, String nextCustomUrl, Runnable onDone) {
        POOL.execute(() -> {
            try {
                CoreBridge.saveUpdateChannelPref(ctx, nextMode, nextCustomUrl);
                JSONObject p = new JSONObject().put("mode", nextMode);
                if (nextCustomUrl != null) p.put("customUrl", nextCustomUrl);
                JSONObject st = CoreBridge.call("core.update.channel", p);
                applyStatus(st);
            } catch (Throwable ignored) {}
            if (onDone != null) MAIN.post(onDone);
        });
    }

    public static void rollback(Runnable onDone) {
        POOL.execute(() -> {
            JSONObject st = CoreBridge.callQuiet("core.update.rollback", null);
            if (st != null) applyStatus(st);
            if (onDone != null) MAIN.post(onDone);
        });
    }

    private static void refreshAsyncIfNeeded() {
        if (latestVersion.isEmpty() && !checking) {
            POOL.execute(CoreUpdateManager::refreshStatusSync);
        }
    }

    public static void refreshStatusSync() {
        JSONObject st = CoreBridge.callQuiet("core.update.status", null);
        if (st != null) applyStatus(st);
    }

    private static void applyStatus(JSONObject st) {
        if (st == null) return;
        mode = st.optString("mode", "default");
        customUrl = st.optString("customUrl", "");
        latestVersion = st.optString("latestVersion", "");
        stagedExists = st.optBoolean("stagedExists", false);
        restartRequired = st.optBoolean("restartRequired", false);
        lastError = st.optString("lastError", "");
    }

    private static JSONObject quietBool(String key, boolean v) {
        JSONObject o = new JSONObject();
        try { o.put(key, v); } catch (Exception ignored) {}
        return o;
    }

    private static void toast(Activity host, String msg) {
        if (host == null || host.isFinishing() || host.isDestroyed()) return;
        MAIN.post(() -> Toast.makeText(host, msg, Toast.LENGTH_SHORT).show());
    }
}
