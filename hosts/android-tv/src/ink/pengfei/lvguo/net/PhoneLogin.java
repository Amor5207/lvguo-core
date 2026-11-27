package ink.pengfei.lvguo.net;

import ink.pengfei.lvguo.core.CoreBridge;

import org.json.JSONObject;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 手机号验证码登录外观类（全部委托给 {@link CoreBridge}，TV 端不再内嵌账密签名算法）。
 */
public final class PhoneLogin {
    public static final class Mfa {
        public final String number;
        public final String content;
        public Mfa(String number, String content) {
            this.number = number == null ? "" : number;
            this.content = content == null ? "" : content;
        }
    }

    public static final class MfaRequired extends IOException {
        public final Mfa mfa;
        public MfaRequired(Mfa mfa) {
            super("需要短信验证");
            this.mfa = mfa;
        }
    }

    public static final class MfaPending extends IOException {
        public MfaPending() { super("等待确认短信"); }
    }

    private volatile String sessionId = "";

    public static boolean validCN(String phone) {
        return phone != null && phone.trim().matches("^1[3-9]\\d{9}$");
    }

    /** 预热底层设备注册态（已在 Core 初始化时完成，保持异步调用兼容）。 */
    public void warmDevice() {}

    public void sendCode(String phone) throws Exception {
        JSONObject p = new JSONObject().put("phone", phone == null ? "" : phone.trim());
        if (!sessionId.isEmpty()) p.put("sessionId", sessionId);
        JSONObject res = CoreBridge.call("login.phone.send", p);
        sessionId = res.optString("sessionId", sessionId);
    }

    public Map<String, String> smsLogin(String phone, String code) throws Exception {
        JSONObject res = CoreBridge.call("login.phone.login", new JSONObject()
                .put("sessionId", sessionId)
                .put("phone", phone == null ? "" : phone.trim())
                .put("code", code == null ? "" : code.trim()));
        return handleOutcome(res);
    }

    public Map<String, String> verifyMfa() throws Exception {
        JSONObject res = CoreBridge.call("login.phone.verify", new JSONObject()
                .put("sessionId", sessionId));
        return handleOutcome(res);
    }

    public void cancelMfa() {
        sessionId = "";
    }

    private Map<String, String> handleOutcome(JSONObject res) throws Exception {
        String st = res.optString("status", "");
        if ("mfa".equals(st)) {
            throw new MfaRequired(new Mfa(res.optString("number"), res.optString("content")));
        }
        if ("pending".equals(st)) {
            throw new MfaPending();
        }
        Session.markLoggedInFromCore();
        return new LinkedHashMap<>();
    }
}
