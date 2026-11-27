package ink.pengfei.lvguo.core;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * 绿果 Core 单文件动态库加载器。
 *
 * 加载策略（单文件无配置）：
 * 1. 优先尝试加载私有目录 {@code files/core_hot/liblvguo_core.so}（由 Core 自更新下载并校验落盘）；
 * 2. 使用瞬态尝试计数文件 {@code .attempt} 实现防崩保护：连续两次未完成初始化即判定新包异常，
 *    自动删除受损热更包并回退至 APK 内置基线 {@code System.loadLibrary("lvguo_core")}；
 * 3. 核心初始化成功后立即清除 {@code .attempt}。
 */
public final class CoreLoader {
    private static final String TAG = "LvguoCoreLoader";
    private static final String CORE_HOT_DIR = "core_hot";
    private static final String CORE_LIB_FILE = "liblvguo_core.so";
    private static final String ATTEMPT_FILE = ".attempt";
    private static final String CORE_LIB_NAME = "lvguo_core";

    private static volatile boolean loaded;
    private static volatile boolean loadedFromHot;

    private CoreLoader() {}

    public static File hotDir(Context ctx) {
        return new File(ctx.getFilesDir(), CORE_HOT_DIR);
    }

    public static File hotFile(Context ctx) {
        return new File(hotDir(ctx), CORE_LIB_FILE);
    }

    public static boolean isLoadedFromHot() {
        return loadedFromHot;
    }

    /** 按「热更单文件优先 + 防崩回退基线」加载 liblvguo_core.so。 */
    public static synchronized void ensureLoaded(Context ctx) {
        if (loaded) return;

        File hot = hotFile(ctx);
        File attempt = new File(hotDir(ctx), ATTEMPT_FILE);

        if (hot.isFile() && hot.length() > 16 * 1024L) {
            int count = readAttemptCount(attempt);
            if (count >= 2) {
                Log.w(TAG, "热更核心连续启动失败(" + count + "次)，自动清理并回退基线");
                safeDelete(hot);
                safeDelete(attempt);
            } else {
                writeAttemptCount(attempt, count + 1);
                try {
                    System.load(hot.getAbsolutePath());
                    loadedFromHot = true;
                    loaded = true;
                    Log.i(TAG, "已加载热更单文件 Core: " + hot.getAbsolutePath());
                    return;
                } catch (Throwable err) {
                    Log.w(TAG, "热更 Core 加载失败，回退 APK 基线: " + err.getMessage());
                    safeDelete(hot);
                    safeDelete(attempt);
                }
            }
        }

        System.loadLibrary(CORE_LIB_NAME);
        loadedFromHot = false;
        loaded = true;
        Log.i(TAG, "已加载 APK 内置基线 Core");
    }

    /** 在 nativeInit 成功返回后调用，清理防崩计数与历史遗留零散状态。 */
    public static void markHealthy(Context ctx) {
        File attempt = new File(hotDir(ctx), ATTEMPT_FILE);
        safeDelete(attempt);
    }

    /** 热更包与当前宿主 ABI 不一致时清理，下次冷启动恢复基线。 */
    public static void invalidateHot(Context ctx) {
        safeDelete(hotFile(ctx));
        safeDelete(new File(hotDir(ctx), ATTEMPT_FILE));
    }

    private static int readAttemptCount(File f) {
        if (!f.isFile()) return 0;
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[16];
            int n = in.read(buf);
            if (n <= 0) return 0;
            String s = new String(buf, 0, n, StandardCharsets.UTF_8).trim();
            return Integer.parseInt(s);
        } catch (Throwable ignored) {
            return 0;
        }
    }

    private static void writeAttemptCount(File f, int count) {
        try {
            File p = f.getParentFile();
            if (p != null && !p.exists()) //noinspection ResultOfMethodCallIgnored
                p.mkdirs();
            try (FileOutputStream out = new FileOutputStream(f, false)) {
                out.write(String.valueOf(count).getBytes(StandardCharsets.UTF_8));
            }
        } catch (Throwable ignored) {}
    }

    @SuppressWarnings("ResultOfMethodCallIgnored")
    private static void safeDelete(File f) {
        if (f != null && f.exists()) f.delete();
    }
}
