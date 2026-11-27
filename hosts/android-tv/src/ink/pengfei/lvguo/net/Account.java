package ink.pengfei.lvguo.net;

import ink.pengfei.lvguo.core.CoreBridge;
import ink.pengfei.lvguo.store.Store;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 云端账号与书架同步外观类（全部委托给 {@link CoreBridge}）。
 */
public final class Account {
    private Account() {}

    public static final class AccountException extends java.io.IOException {
        public final boolean sessionExpired;
        public AccountException(String msg, boolean expired) {
            super(msg);
            this.sessionExpired = expired;
        }
    }

    /** 云端条目（历史 / 收藏 / 预约通用）。 */
    public static final class Entry {
        public String seriesId = "", title = "", cover = "", vid = "", desc = "", publishText = "";
        public int episodeIndex, episodeCount, positionMs, durationMs;
        public long time, watchedMs, progressTime;
        public boolean online = true;
    }

    public static final class Reservations {
        public final List<Entry> items = new ArrayList<>();
        public int onlineTotal, offlineTotal;
    }

    public static Session.Profile profile() throws Exception {
        Session.refreshFromCore();
        return Session.profile();
    }

    public static boolean heartbeat() throws Exception {
        JSONObject data = CoreBridge.call("me", null);
        return data.optBoolean("loggedIn", false);
    }

    public static void logoutRemote(String unused) {
        CoreBridge.callQuiet("logout", null);
    }

    public static List<Entry> history(int limit) throws Exception {
        JSONObject p = new JSONObject().put("limit", Math.max(1, limit));
        JSONObject data = CoreBridge.call("history.list", p);
        return parseEntries(data.optJSONArray("items"));
    }

    public static Map<String, Long> deletedHistoryTimes(List<String> seriesIds) {
        return new HashMap<>();
    }

    public static void deleteHistory(List<Store.Item> entries) throws Exception {
        if (entries == null) return;
        for (Store.Item it : entries) {
            if (it == null || it.seriesId == null || it.seriesId.isEmpty()) continue;
            CoreBridge.call("history.delete", new JSONObject().put("seriesId", it.seriesId));
        }
    }

    public static void uploadProgress(String seriesId, String vid, int episodeIndex,
                                      int positionMs, int durationMs, int episodeCount) throws Exception {
        if (seriesId == null || seriesId.isEmpty()) return;
        Store.Item item = Store.watched(seriesId);
        JSONObject p = new JSONObject()
                .put("seriesId", seriesId)
                .put("vid", vid == null ? "" : vid)
                .put("index", episodeIndex)
                .put("positionMs", Math.max(0, positionMs))
                .put("episodeCount", Math.max(0, episodeCount));
        if (item != null) {
            if (item.title != null) p.put("title", item.title);
            if (item.cover != null) p.put("cover", item.cover);
        }
        CoreBridge.call("progress.report", p);
    }

    public static void reportHistory(String seriesId, String title, String vid, int episodeIndex,
                                     String cover, int episodeCount, int positionMs) {
        JSONObject p = new JSONObject();
        try {
            p.put("seriesId", seriesId == null ? "" : seriesId)
                    .put("title", title == null ? "" : title)
                    .put("vid", vid == null ? "" : vid)
                    .put("index", episodeIndex)
                    .put("cover", cover == null ? "" : cover)
                    .put("episodeCount", Math.max(0, episodeCount))
                    .put("positionMs", Math.max(0, positionMs));
            CoreBridge.call("progress.report", p);
        } catch (Exception ignored) {}
    }

    public static List<Entry> favorites() throws Exception {
        JSONObject data = CoreBridge.call("favorites.list", null);
        return parseEntries(data.optJSONArray("items"));
    }

    public static void setFavorite(String seriesId, boolean add) throws Exception {
        CoreBridge.call("favorite.set", new JSONObject()
                .put("seriesId", seriesId == null ? "" : seriesId)
                .put("add", add));
    }

    public static void setFavorites(List<String> seriesIds, boolean add) throws Exception {
        if (seriesIds == null) return;
        for (String id : seriesIds) {
            if (id != null && !id.isEmpty()) setFavorite(id, add);
        }
    }

    public static Reservations reservations(boolean online) throws Exception {
        JSONObject data = CoreBridge.call("reservations.list", new JSONObject().put("online", online));
        Reservations res = new Reservations();
        List<Entry> list = parseEntries(data.optJSONArray("items"));
        for (Entry e : list) {
            e.online = online;
            res.items.add(e);
        }
        if (online) res.onlineTotal = list.size();
        else res.offlineTotal = list.size();
        return res;
    }

    public static void setReservation(String seriesId, boolean add) throws Exception {
        CoreBridge.call("reservation.set", new JSONObject()
                .put("seriesId", seriesId == null ? "" : seriesId)
                .put("add", add));
    }

    private static List<Entry> parseEntries(JSONArray arr) {
        List<Entry> out = new ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            Entry e = new Entry();
            e.seriesId = o.optString("seriesId");
            e.title = o.optString("title");
            e.cover = o.optString("cover");
            e.vid = o.optString("vid");
            e.desc = o.optString("desc");
            e.publishText = o.optString("publishText");
            e.episodeIndex = o.optInt("episodeIndex");
            e.episodeCount = o.optInt("episodeCount");
            e.positionMs = o.optInt("positionMs");
            e.durationMs = o.optInt("durationMs");
            e.time = o.optLong("time");
            e.watchedMs = o.optLong("watchedMs");
            e.progressTime = o.optLong("progressTime", e.time);
            e.online = o.optBoolean("online", true);
            if (!e.seriesId.isEmpty()) out.add(e);
        }
        return out;
    }
}
