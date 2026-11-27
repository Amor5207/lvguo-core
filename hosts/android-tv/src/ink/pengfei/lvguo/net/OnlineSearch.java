package ink.pengfei.lvguo.net;

import ink.pengfei.lvguo.core.CoreBridge;
import ink.pengfei.lvguo.model.Series;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 在线搜索与联想词接口（委托给 {@link CoreBridge}）。
 */
public final class OnlineSearch {
    private OnlineSearch() {}

    public static final class Page {
        public final List<Series> items = new ArrayList<>();
        public int number, total;
        public boolean more;
    }

    public static List<String> suggest(String query) throws Exception {
        List<String> out = new ArrayList<>();
        if (query == null || query.trim().isEmpty()) return out;
        JSONObject data = CoreBridge.call("suggest", new JSONObject().put("q", query.trim()));
        JSONArray arr = data.optJSONArray("items");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                String w = arr.optString(i).trim();
                if (!w.isEmpty()) out.add(w);
            }
        }
        return out;
    }

    public static Page page(String query, int number) throws Exception {
        JSONObject p = new JSONObject()
                .put("q", query == null ? "" : query.trim())
                .put("page", Math.max(1, number));
        JSONObject data = CoreBridge.call("search", p);
        Page page = new Page();
        page.number = data.optInt("page", Math.max(1, number));
        page.total = data.optInt("total", 0);
        page.more = data.optBoolean("more", false);
        List<Series> parsed = Repo.parseSeriesList(data.optJSONArray("items"));
        page.items.addAll(parsed);
        Catalog.merge(parsed);
        return page;
    }
}
