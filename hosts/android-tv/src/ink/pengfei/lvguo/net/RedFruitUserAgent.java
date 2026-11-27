package ink.pengfei.lvguo.net;

import android.os.Build;

import java.util.Locale;

/**
 * 提供与红果上游兼容的默认图片与媒体 User-Agent 字符串。
 */
public final class RedFruitUserAgent {
    private static final String VERSION_CODE = "74132";
    private static final String TTNET_SUFFIX =
            "; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)";

    private RedFruitUserAgent() {}

    public static String app() {
        return build(false);
    }

    public static String video() {
        return build(true);
    }

    private static String build(boolean includeTtNet) {
        StringBuilder ua = new StringBuilder()
                .append("com.phoenix.read/").append(VERSION_CODE)
                .append(" (Linux; U; Android ").append(Build.VERSION.RELEASE)
                .append("; ").append(Locale.getDefault().toString());
        String model = Build.MODEL;
        if (model != null && !model.isEmpty()) ua.append("; ").append(model);
        String buildId = Build.ID;
        if (buildId != null && !buildId.isEmpty()) ua.append("; Build/").append(buildId);
        if (includeTtNet) return ua.append(TTNET_SUFFIX).toString();
        return ua.append(')').toString();
    }
}
