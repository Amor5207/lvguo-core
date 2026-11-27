package ink.pengfei.lvguo.net;

import ink.pengfei.lvguo.model.Series;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 轻量内存剧集索引缓存，供详情/历史页面快速回填标签与标题。
 */
public final class Catalog {
    private Catalog() {}

    private static final Map<String, Series> CACHE = new LinkedHashMap<>();

    public static synchronized void merge(List<Series> items) {
        if (items == null) return;
        for (Series s : items) {
            if (s != null && s.seriesId != null && !s.seriesId.isEmpty()) {
                CACHE.put(s.seriesId, s);
            }
        }
        while (CACHE.size() > 600) {
            String oldest = CACHE.keySet().iterator().next();
            CACHE.remove(oldest);
        }
    }

    public static synchronized List<Series> cached() {
        return new ArrayList<>(CACHE.values());
    }

    public static boolean stale() {
        return CACHE.isEmpty();
    }

    public static List<Series> refresh() {
        try {
            List<Series> list = Repo.rank(Repo.BOARD_RECOMMEND, Repo.DEFAULT_CELL, 40);
            merge(list);
            return list;
        } catch (Exception ignored) {
            return cached();
        }
    }

    public static void warm() {
        refresh();
    }

    public static List<Series> search(List<Series> src, String query) {
        List<Series> out = new ArrayList<>();
        if (src == null || query == null) return out;
        String q = query.trim().toLowerCase(java.util.Locale.ROOT);
        if (q.isEmpty()) return out;
        for (Series s : src) {
            if (s == null) continue;
            String hay = ((s.title == null ? "" : s.title) + " "
                    + (s.category == null ? "" : s.category) + " "
                    + (s.actors == null ? "" : s.actors)).toLowerCase(java.util.Locale.ROOT);
            if (hay.contains(q)) out.add(s);
        }
        return out;
    }
}
