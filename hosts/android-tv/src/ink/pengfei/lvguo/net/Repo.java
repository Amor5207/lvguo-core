package ink.pengfei.lvguo.net;

import ink.pengfei.lvguo.core.CoreBridge;
import ink.pengfei.lvguo.model.Episode;
import ink.pengfei.lvguo.model.Gear;
import ink.pengfei.lvguo.model.Series;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 剧集榜单、详情、分季与播放地址外观类（全部由单一 {@code liblvguo_core.so} 提供能力）。
 */
public final class Repo {
    private Repo() {}

    public static final String BOARD_HOT = "ranklist_hot_play_sc";
    public static final String BOARD_RECOMMEND = "ranklist_hot_sc";
    public static final String BOARD_NEW = "ranklist_new_rank_sc";
    public static final String TAB_VIDEO = "26";
    public static final String DEFAULT_CELL = "7470092475068071998";
    public static final int DEVICE_LEVEL_H265 = 2;

    private static final int MAX_MEM_CACHE = 256;
    private static final Map<String, Detail> DETAIL_CACHE = new LinkedHashMap<String, Detail>(64, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Detail> eldest) {
            return size() > MAX_MEM_CACHE;
        }
    };
    private static final Map<String, List<Season>> SEASON_CACHE = new LinkedHashMap<String, List<Season>>(64, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, List<Season>> eldest) {
            return size() > MAX_MEM_CACHE;
        }
    };
    private static final Map<String, List<Gear>> PLAY_CACHE = new LinkedHashMap<String, List<Gear>>(64, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, List<Gear>> eldest) {
            return size() > 96;
        }
    };
    private static final Map<String, Long> PLAY_CACHE_TS = new java.util.HashMap<>();
    private static final java.util.Set<String> FRESH_PLAY_VIDS = new java.util.HashSet<>();
    private static final long PLAY_CACHE_TTL_MS = 60_000L;

    public static final class Detail {
        public String title = "";
        public String cover = "";
        public String intro = "";
        public int episodeCount;
        public boolean multiSeason;
        public int seasonIndex;
        public String relatedAlbumId = "";
        public int payType = -1;
        public String rating = "";
        public String heatText = "";
        public String hotTag = "";
        public long playCount;
        public final List<String> actors = new ArrayList<>();
        public final List<Episode> episodes = new ArrayList<>();

        public boolean free() {
            return payType == -1 || payType == 0;
        }
    }

    public static final class Season {
        public String id = "", title = "", cover = "";
        public int number, episodes;
    }

    static List<Series> parseSeriesList(JSONArray arr) {
        List<Series> out = new ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            Series s = new Series();
            s.seriesId = o.optString("id");
            if (s.seriesId.isEmpty()) s.seriesId = o.optString("seriesId");
            s.title = o.optString("title");
            s.cover = o.optString("cover");
            s.episodeCount = o.optInt("episodes", o.optInt("episodeCount"));
            s.playCount = o.optLong("plays", o.optLong("playCount"));
            s.intro = o.optString("intro");
            s.category = o.optString("category");
            s.firstVid = o.optString("firstVid");
            s.rank = o.optInt("rank");
            s.showRank = s.rank > 0;
            if (!s.seriesId.isEmpty()) out.add(s);
        }
        return out;
    }

    public static List<Series> rank(String board, String cellId, int limit) throws Exception {
        JSONObject p = new JSONObject()
                .put("board", board == null || board.isEmpty() ? BOARD_RECOMMEND : board)
                .put("offset", 0);
        JSONObject res = CoreBridge.call("rank", p);
        List<Series> list = parseSeriesList(res.optJSONArray("items"));
        Catalog.merge(list);
        if (limit > 0 && list.size() > limit) {
            return new ArrayList<>(list.subList(0, limit));
        }
        return list;
    }

    public static synchronized Detail cachedDetail(String seriesId) {
        return seriesId == null ? null : DETAIL_CACHE.get(seriesId);
    }

    public static synchronized Detail memoryDetail(String seriesId) {
        return cachedDetail(seriesId);
    }

    public static Detail detail(String seriesId) throws Exception {
        return fetchDetail(seriesId, false);
    }

    public static Detail retryDetail(String seriesId) throws Exception {
        return fetchDetail(seriesId, true);
    }

    private static Detail fetchDetail(String seriesId, boolean bypassMem) throws Exception {
        if (seriesId == null || seriesId.isEmpty()) throw new IllegalArgumentException("剧集 ID 为空");
        if (!bypassMem) {
            Detail hit = memoryDetail(seriesId);
            if (hit != null && !hit.episodes.isEmpty()) return hit;
        }
        JSONObject resp = CoreBridge.call("detail", new JSONObject().put("id", seriesId).put("lite", true));
        JSONObject o = resp.optJSONObject("detail");
        if (o == null) throw new java.io.IOException("详情数据为空");
        Detail d = new Detail();
        d.title = o.optString("title");
        d.cover = o.optString("cover");
        d.intro = o.optString("intro");
        d.episodeCount = o.optInt("count");
        d.rating = o.optString("rating");
        d.heatText = o.optString("heat");
        d.hotTag = o.optString("tag");
        d.playCount = o.optLong("plays");
        d.multiSeason = o.optBoolean("multiSeason");
        d.seasonIndex = o.optInt("seasonIndex");
        d.relatedAlbumId = o.optString("relatedAlbumId");
        JSONArray acts = o.optJSONArray("actors");
        if (acts != null) {
            for (int i = 0; i < acts.length(); i++) {
                String a = acts.optString(i).trim();
                if (!a.isEmpty()) d.actors.add(a);
            }
        }
        JSONArray eps = o.optJSONArray("episodes");
        if (eps != null) {
            for (int i = 0; i < eps.length(); i++) {
                JSONObject eo = eps.optJSONObject(i);
                if (eo == null) continue;
                Episode e = new Episode();
                e.index = eo.optInt("index", i + 1);
                e.title = eo.optString("title");
                e.vid = eo.optString("vid");
                e.durationSec = eo.optInt("duration");
                e.cover = eo.optString("cover");
                if (!e.vid.isEmpty()) d.episodes.add(e);
            }
        }
        if (d.episodeCount <= 0) d.episodeCount = d.episodes.size();
        synchronized (Repo.class) {
            DETAIL_CACHE.put(seriesId, d);
        }
        return d;
    }

    public static Map<String, Detail> prefetch(Collection<String> seriesIds) {
        Map<String, Detail> out = new LinkedHashMap<>();
        if (seriesIds == null) return out;
        for (String id : seriesIds) {
            if (id == null || id.isEmpty()) continue;
            try {
                out.put(id, detail(id));
            } catch (Exception ignored) {}
        }
        return out;
    }

    public static List<Season> seasons(String seriesId, String albumId) throws Exception {
        return fetchSeasons(seriesId, false);
    }

    public static List<Season> seasonsQuick(String seriesId, String albumId) throws Exception {
        return fetchSeasons(seriesId, true);
    }

    public static synchronized List<Season> cachedSeasonsQuick(String seriesId, String albumId) {
        return seriesId == null ? null : SEASON_CACHE.get(seriesId);
    }

    private static List<Season> fetchSeasons(String seriesId, boolean quick) throws Exception {
        JSONObject res = CoreBridge.call("seasons", new JSONObject()
                .put("id", seriesId == null ? "" : seriesId)
                .put("quick", quick));
        JSONArray arr = res.optJSONArray("items");
        List<Season> out = new ArrayList<>();
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                Season s = new Season();
                s.id = o.optString("id");
                s.title = o.optString("title");
                s.cover = o.optString("cover");
                s.number = o.optInt("number");
                s.episodes = o.optInt("episodes");
                if (!s.id.isEmpty()) out.add(s);
            }
        }
        if (!out.isEmpty() && seriesId != null) {
            synchronized (Repo.class) { SEASON_CACHE.put(seriesId, out); }
        }
        return out;
    }

    public static synchronized void invalidatePlay(String vid) {
        if (vid != null && !vid.isEmpty()) {
            PLAY_CACHE.remove(vid);
            PLAY_CACHE_TS.remove(vid);
            FRESH_PLAY_VIDS.add(vid);
        }
    }

    public static void refreshPlaybackProfile(String vid) {
        invalidatePlay(vid);
    }

    public static synchronized List<Gear> memoryPlay(String vid, int deviceLevel) {
        if (vid == null) return null;
        Long cachedAt = PLAY_CACHE_TS.get(vid);
        if (cachedAt == null || android.os.SystemClock.elapsedRealtime() - cachedAt >= PLAY_CACHE_TTL_MS) {
            PLAY_CACHE.remove(vid);
            PLAY_CACHE_TS.remove(vid);
            return null;
        }
        return PLAY_CACHE.get(vid);
    }

    public static List<Gear> play(String vid, int deviceLevel) throws Exception {
        if (vid == null || vid.isEmpty()) return Collections.emptyList();
        boolean forceFresh;
        synchronized (Repo.class) {
            forceFresh = FRESH_PLAY_VIDS.remove(vid);
        }
        JSONObject req = new JSONObject().put("vid", vid);
        if (forceFresh) req.put("fresh", true);
        JSONObject res = CoreBridge.call("play", req);
        JSONArray arr = res.optJSONArray("gears");
        List<Gear> out = new ArrayList<>();
        String base = CoreBridge.mediaBaseUrl();
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                Gear g = new Gear();
                g.definition = o.optString("definition", "720p");
                g.codec = o.optString("codec", "h264");
                g.width = o.optInt("width");
                g.height = o.optInt("height");
                g.size = o.optLong("size");
                g.encrypted = false; // 解密工作已由 liblvguo_core.so 本地流媒体服务完成
                g.mainUrl = buildMediaUrl(base, vid, g.definition);
                out.add(g);
            }
        }
        if (out.isEmpty()) {
            String fallbackUrl = res.optString("mediaUrl");
            if (!fallbackUrl.isEmpty()) {
                Gear g = new Gear();
                g.definition = res.optString("definition", "720p");
                g.codec = "h264";
                g.width = res.optInt("width", 720);
                g.height = res.optInt("height", 1280);
                g.encrypted = false;
                g.mainUrl = fallbackUrl;
                out.add(g);
            }
        }
        synchronized (Repo.class) {
            if (!out.isEmpty()) {
                PLAY_CACHE.put(vid, out);
                PLAY_CACHE_TS.put(vid, android.os.SystemClock.elapsedRealtime());
            }
        }
        return out;
    }

    private static String buildMediaUrl(String base, String vid, String definition) {
        if (base == null || base.isEmpty()) return "";
        try {
            String q = URLEncoder.encode(definition == null ? "720p" : definition, StandardCharsets.UTF_8.name());
            return base + "/media/" + vid + ".mp4?q=" + q;
        } catch (Exception e) {
            return base + "/media/" + vid + ".mp4";
        }
    }

    public static Gear pickGear(List<Gear> gears, String prefer, int maxShortSide) {
        if (gears == null || gears.isEmpty()) return null;
        List<Gear> allowed = new ArrayList<>();
        for (Gear g : gears) {
            if (g != null && g.shortSide() <= maxShortSide) allowed.add(g);
        }
        if (allowed.isEmpty()) allowed.addAll(gears);

        Gear exact = null;
        if (prefer != null && !prefer.isEmpty()) {
            for (Gear g : allowed) {
                if (prefer.equals(g.definition)) {
                    if (exact == null || g.codecRank() < exact.codecRank()) exact = g;
                }
            }
            if (exact != null) return exact;
        }

        Gear best = null;
        for (Gear g : allowed) {
            if (best == null) {
                best = g;
                continue;
            }
            if (g.shortSide() > best.shortSide()
                    || (g.shortSide() == best.shortSide() && g.codecRank() < best.codecRank())) {
                best = g;
            }
        }
        return best;
    }
}
