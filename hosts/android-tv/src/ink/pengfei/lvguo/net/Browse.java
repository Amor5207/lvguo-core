package ink.pengfei.lvguo.net;

import ink.pengfei.lvguo.core.CoreBridge;
import ink.pengfei.lvguo.model.Series;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 首页信息流、榜单、分类筛选与评论接口外观类（全部委托给 {@link CoreBridge}）。
 */
public final class Browse {
    private Browse() {}

    public static final String CH_RECOMMEND = "16";

    private static volatile JSONArray cachedFilterGroups = new JSONArray();
    private static volatile List<String[]> cachedChannels = new ArrayList<>();

    public static final class Result {
        public final List<Series> items = new ArrayList<>();
        public int next;
        public boolean more;
        public String session = "";
        public JSONObject selector;
    }

    public static synchronized JSONArray cachedFilters() {
        return cachedFilterGroups;
    }

    public static void preloadFilters() {
        ink.pengfei.lvguo.App.io().execute(() -> {
            try {
                categoryOptions("all");
            } catch (Exception ignored) {}
        });
    }

    public static synchronized List<String[]> feedChannels() {
        if (!cachedChannels.isEmpty()) return new ArrayList<>(cachedChannels);
        try {
            JSONObject home = CoreBridge.call("home", null);
            JSONArray arr = home.optJSONArray("channels");
            List<String[]> list = new ArrayList<>();
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject c = arr.optJSONObject(i);
                    if (c == null) continue;
                    String id = c.optString("id");
                    String label = c.optString("label");
                    if (!id.isEmpty() && !label.isEmpty()) list.add(new String[]{id, label});
                }
            }
            if (!list.isEmpty()) {
                cachedChannels = list;
                return new ArrayList<>(list);
            }
        } catch (Exception ignored) {}
        List<String[]> fallback = new ArrayList<>();
        fallback.add(new String[]{CH_RECOMMEND, "推荐"});
        return fallback;
    }

    public static Result forYou(int offset) throws Exception {
        return forYou(CH_RECOMMEND, offset, false);
    }

    public static Result forYou(String channel, int offset) throws Exception {
        return forYou(channel, offset, false);
    }

    public static Result forYou(String channel, int offset, boolean first) throws Exception {
        JSONObject p = new JSONObject()
                .put("channel", channel == null || channel.isEmpty() ? CH_RECOMMEND : channel)
                .put("offset", Math.max(0, offset));
        JSONObject res = CoreBridge.call("foryou", p);
        JSONObject pageObj = res.optJSONObject("page");
        return parseResult(pageObj != null ? pageObj : res);
    }

    public static Result page(String board, String filter, int offset, String session) throws Exception {
        return page("all", board, filter, offset, session);
    }

    public static Result page(String type, String board, String filter, int offset, String session) throws Exception {
        if (filter != null && !filter.isEmpty()) {
            JSONObject sel = new JSONObject();
            sel.put("精选", filter);
            return categoryPage(type, board, sel, offset, session);
        }
        JSONObject p = new JSONObject()
                .put("board", board == null || board.isEmpty() ? Repo.BOARD_RECOMMEND : board)
                .put("offset", Math.max(0, offset))
                .put("session", session == null ? "" : session);
        JSONObject res = CoreBridge.call("rank", p);
        return parseResult(res);
    }

    public static JSONObject categoryOptions(String type) throws Exception {
        JSONObject res = CoreBridge.call("category.options", new JSONObject()
                .put("type", type == null || type.isEmpty() ? "all" : type));
        JSONArray boards = res.optJSONArray("boards");
        if (boards != null && boards.length() > 0) {
            JSONObject b0 = boards.optJSONObject(0);
            if (b0 != null && b0.optJSONArray("groups") != null) {
                cachedFilterGroups = b0.optJSONArray("groups");
            }
        }
        return res;
    }

    public static Result categoryPage(String type, String board, JSONObject selected, int offset, String session) throws Exception {
        JSONObject p = new JSONObject()
                .put("type", type == null || type.isEmpty() ? "all" : type)
                .put("board", board == null ? "" : board)
                .put("selected", selected == null ? new JSONObject() : selected)
                .put("offset", Math.max(0, offset))
                .put("session", session == null ? "" : session);
        JSONObject res = CoreBridge.call("category.list", p);
        return parseResult(res);
    }

    public static JSONArray filters(JSONObject selector, String board) throws JSONException {
        return cachedFilterGroups;
    }

    public static JSONObject comments(String id, int offset) throws Exception {
        return comments(id, null, offset);
    }

    public static JSONObject comments(String id, String episodeId, int offset) throws Exception {
        JSONObject p = new JSONObject()
                .put("id", id == null ? "" : id)
                .put("vid", episodeId == null ? "" : episodeId)
                .put("offset", Math.max(0, offset));
        JSONObject res = CoreBridge.call("comments", p);
        JSONArray src = res.optJSONArray("items");
        JSONArray mapped = new JSONArray();
        if (src != null) {
            for (int i = 0; i < src.length(); i++) {
                JSONObject it = src.optJSONObject(i);
                if (it == null) continue;
                JSONObject row = new JSONObject();
                String cid = it.optString("id");
                if (cid.isEmpty()) cid = id + "_" + offset + "_" + i;
                row.put("comment_id", cid);
                row.put("text", it.optString("text"));
                row.put("score", it.optString("score"));
                row.put("digg_count", it.optLong("likes"));
                row.put("user_info", new JSONObject()
                        .put("user_name", it.optString("user", "观众"))
                        .put("user_avatar", it.optString("avatar", "")));
                mapped.put(row);
            }
        }
        JSONObject out = new JSONObject();
        out.put("comment", mapped);
        out.put("comment_cnt", res.optLong("comment_cnt", res.optLong("total", mapped.length())));
        int next = res.optInt("next_offset", offset + mapped.length());
        out.put("next_offset", next);
        out.put("has_more", res.optBoolean("has_more", false));
        return out;
    }

    public static String commentText(JSONObject row) {
        if (row == null) return "";
        String t = row.optString("text");
        if (!t.isEmpty()) return t;
        return row.optString("content");
    }

    public static JSONArray commentImages(JSONObject row) {
        JSONArray arr = row == null ? null : row.optJSONArray("images");
        return arr != null ? arr : new JSONArray();
    }

    public static List<Series> search(String query) throws Exception {
        return OnlineSearch.page(query, 1).items;
    }

    public static void collect(Object value, List<Series> out, java.util.Set<String> seen) {
        // 兼容接口保留：搜索直连 Core
    }

    public static String categoryNames(String raw) {
        if (raw == null || raw.isEmpty()) return "";
        if (!raw.trim().startsWith("[")) return raw;
        try {
            JSONArray a = new JSONArray(raw);
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < a.length(); i++) {
                String v = a.optString(i);
                if (v == null || v.isEmpty()) {
                    JSONObject o = a.optJSONObject(i);
                    if (o != null) v = o.optString("name", o.optString("category_name"));
                }
                if (v != null && !v.trim().isEmpty()) {
                    if (sb.length() > 0) sb.append(',');
                    sb.append(v.trim());
                }
            }
            return sb.toString();
        } catch (Exception ignored) {
            return raw;
        }
    }

    private static Result parseResult(JSONObject res) {
        Result r = new Result();
        if (res == null) return r;
        List<Series> list = Repo.parseSeriesList(res.optJSONArray("items"));
        r.items.addAll(list);
        r.next = res.optInt("next", list.size());
        r.more = res.optBoolean("more", false);
        r.session = res.optString("session", "");
        Catalog.merge(list);
        return r;
    }
}
