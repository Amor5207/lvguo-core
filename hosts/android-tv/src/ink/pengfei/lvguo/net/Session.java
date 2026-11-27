package ink.pengfei.lvguo.net;

import ink.pengfei.lvguo.App;
import ink.pengfei.lvguo.core.CoreBridge;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * TV 端账号会话视图（状态由单一 {@code liblvguo_core.so} 托管，Java 层仅保留内存镜像与 UI 监听）。
 */
public final class Session {
    private Session() {}

    private static final String KEY_PROFILE = "acct_profile";
    private static final String KEY_LOGGED_IN = "acct_logged_in";
    private static final String KEY_EXPIRED = "acct_expired";

    private static volatile boolean loggedIn;
    private static volatile int daysLeft = 90;
    private static volatile long generation = 1L;
    private static Profile profile;
    private static final List<Runnable> listeners = new ArrayList<>();

    static {
        try {
            loggedIn = App.prefs() != null && App.prefs().getBoolean(KEY_LOGGED_IN, false);
        } catch (Throwable ignored) {}
    }

    public static long generation() { return generation; }

    /** 账号资料实体。 */
    public static final class Profile {
        public String uid = "", name = "", avatar = "", cover = "", coverColor = "", signature = "";
        public boolean vip;
        public long vipExpire;
        public int gender;
        public long watchMs;
        public int activeDays;

        JSONObject toJson() {
            JSONObject o = new JSONObject();
            try {
                o.put("uid", uid).put("name", name).put("avatar", avatar)
                        .put("cover", cover).put("coverColor", coverColor)
                        .put("signature", signature).put("vip", vip)
                        .put("vipExpire", vipExpire).put("gender", gender)
                        .put("watchMs", watchMs).put("activeDays", activeDays);
            } catch (Exception ignored) {}
            return o;
        }

        public static Profile from(JSONObject o) {
            Profile p = new Profile();
            if (o == null) return p;
            p.uid = o.optString("uid");
            p.name = o.optString("name");
            p.avatar = o.optString("avatar");
            p.cover = o.optString("cover");
            p.coverColor = o.optString("coverColor");
            p.signature = o.optString("signature");
            p.vip = o.optBoolean("vip");
            p.vipExpire = o.optLong("vipExpire");
            p.gender = o.optInt("gender");
            p.watchMs = o.optLong("watchMs");
            p.activeDays = o.optInt("activeDays");
            return p;
        }
    }

    public static synchronized boolean loggedIn() { return loggedIn; }

    public static synchronized String cookieHeader() { return loggedIn ? "managed-by-core=1" : ""; }

    public static synchronized boolean wasExpired() {
        return App.prefs().getBoolean(KEY_EXPIRED, false);
    }

    public static synchronized int daysLeft() { return daysLeft; }

    public static synchronized Profile profile() {
        if (profile != null) return profile;
        try {
            profile = Profile.from(new JSONObject(App.prefs().getString(KEY_PROFILE, "{}")));
        } catch (Exception e) {
            profile = new Profile();
        }
        return profile;
    }

    public static synchronized void setProfile(Profile p) {
        profile = p == null ? new Profile() : p;
        App.prefs().edit().putString(KEY_PROFILE, profile.toJson().toString()).apply();
    }

    /** 由 Core 登录动作成功后调用：从核心同步最新账号资料并通知界面刷新。 */
    public static void markLoggedInFromCore() {
        boolean prev;
        synchronized (Session.class) {
            prev = loggedIn;
            loggedIn = true;
            if (!prev) generation++;
        }
        App.prefs().edit().putBoolean(KEY_LOGGED_IN, true).putBoolean(KEY_EXPIRED, false).apply();
        refreshFromCore();
        if (!prev) notifyListeners();
    }

    /** 从 Core 拉取并同步当前登录态与个人资料。 */
    public static void refreshFromCore() {
        JSONObject data = CoreBridge.callQuiet("me", null);
        if (data == null) return;
        boolean nowLogged = data.optBoolean("loggedIn", false);
        int dl = data.optInt("daysLeft", 90);
        Profile pf = Profile.from(data.optJSONObject("profile"));
        boolean changed;
        synchronized (Session.class) {
            changed = (loggedIn != nowLogged);
            loggedIn = nowLogged;
            daysLeft = dl;
            if (nowLogged && (!pf.name.isEmpty() || !pf.uid.isEmpty())) {
                profile = pf;
            } else if (!nowLogged) {
                profile = new Profile();
            }
            if (changed) generation++;
        }
        App.prefs().edit()
                .putBoolean(KEY_LOGGED_IN, nowLogged)
                .putString(KEY_PROFILE, profile().toJson().toString())
                .apply();
        if (changed) notifyListeners();
    }

    public static void begin(Map<String, String> unused) {
        markLoggedInFromCore();
    }

    public static void expire() {
        synchronized (Session.class) {
            loggedIn = false;
            generation++;
        }
        App.prefs().edit().putBoolean(KEY_LOGGED_IN, false).putBoolean(KEY_EXPIRED, true).apply();
        notifyListeners();
    }

    public static void logout() {
        CoreBridge.callQuiet("logout", null);
        synchronized (Session.class) {
            loggedIn = false;
            profile = new Profile();
            generation++;
        }
        App.prefs().edit()
                .putBoolean(KEY_LOGGED_IN, false)
                .putBoolean(KEY_EXPIRED, false)
                .remove(KEY_PROFILE)
                .apply();
        ink.pengfei.lvguo.store.Store.clearAccountData();
        notifyListeners();
    }

    public static void listen(Runnable r) {
        synchronized (listeners) { if (!listeners.contains(r)) listeners.add(r); }
    }

    public static void unlisten(Runnable r) {
        synchronized (listeners) { listeners.remove(r); }
    }

    private static void notifyListeners() {
        List<Runnable> copy;
        synchronized (listeners) { copy = new ArrayList<>(listeners); }
        for (Runnable r : copy) {
            try { r.run(); } catch (RuntimeException ignored) {}
        }
    }
}
