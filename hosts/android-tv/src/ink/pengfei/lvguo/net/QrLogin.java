package ink.pengfei.lvguo.net;

import android.util.Base64;

import ink.pengfei.lvguo.core.CoreBridge;

import org.json.JSONObject;

/**
 * 红果扫码登录外观类（委托给 {@link CoreBridge}）。
 */
public final class QrLogin {
    public enum State { WAITING, SCANNED, CONFIRMED, EXPIRED, CANCELED }

    private String token = "";
    public byte[] image;
    public long expiresAt;

    public void start() throws Exception {
        JSONObject data = CoreBridge.call("login.qr.start", null);
        token = data.optString("token");
        String qr = data.optString("qr");
        int comma = qr.indexOf(',');
        String b64 = (qr.startsWith("data:") && comma > 0) ? qr.substring(comma + 1) : qr;
        image = Base64.decode(b64, Base64.DEFAULT);
        expiresAt = data.optLong("expiresAt", System.currentTimeMillis() + 120_000L);
    }

    public State poll() throws Exception {
        JSONObject data = CoreBridge.call("login.qr.poll", new JSONObject().put("token", token));
        String st = data.optString("state", "waiting").toLowerCase(java.util.Locale.US);
        switch (st) {
            case "expired": return State.EXPIRED;
            case "canceled": return State.CANCELED;
            case "scanned": return State.SCANNED;
            case "confirmed":
                Session.markLoggedInFromCore();
                return State.CONFIRMED;
            default:
                return State.WAITING;
        }
    }
}
