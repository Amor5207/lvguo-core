//! 本地敏感数据静态加密：AES-256-CTR + HMAC-SHA256（先加密后校验）。
//!
//! 用途：
//! 1. 文件加密：session.json / library.json 等落盘密文，前缀 LVG1:。
//! 2. 令牌加密：会话 cookie lvguo_sid 的值是加密且带 MAC 的令牌，客户端无法伪造或篡改，
//!    里面隐含的 sid 也不以明文暴露。
//!
//! 每目录一份随机主密钥 .lvguo_key（0600），据此派生加密密钥与校验密钥；
//! 旧明文文件读取后下一次写入自动迁移为密文；校验失败/密钥不符返回 None，上层按空处理，绝不崩溃。
//! 仅依赖已有 aes / ctr / sha2 / rand / base64，Android 同一 cdylib 可编译。

use aes::cipher::{KeyIvInit, StreamCipher};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

type Aes256Ctr = ctr::Ctr128BE<aes::Aes256>;

const MAGIC: &[u8] = b"LVG1:";

static KEYS: OnceLock<Mutex<HashMap<PathBuf, [u8; 32]>>> = OnceLock::new();

fn keys() -> &'static Mutex<HashMap<PathBuf, [u8; 32]>> {
    KEYS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 取（或创建）某目录的主密钥。目录即密钥作用域。
fn master(dir: &Path) -> [u8; 32] {
    let mut g = keys().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(k) = g.get(dir) {
        return *k;
    }
    let path = dir.join(".lvguo_key");
    let mut key = [0u8; 32];
    match std::fs::read(&path) {
        Ok(b) if b.len() == 32 => key.copy_from_slice(&b),
        _ => {
            rand::thread_rng().fill_bytes(&mut key);
            let _ = std::fs::create_dir_all(dir);
            let _ = std::fs::write(&path, key);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
        }
    }
    g.insert(dir.to_path_buf(), key);
    key
}

fn key_dir(path: &Path) -> PathBuf {
    path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."))
}

fn subkeys(dir: &Path) -> ([u8; 32], [u8; 32]) {
    let m = master(dir);
    let mut h = Sha256::new();
    h.update(m);
    h.update(b"|lvguo-enc");
    let ek: [u8; 32] = h.finalize().into();
    let mut h2 = Sha256::new();
    h2.update(m);
    h2.update(b"|lvguo-mac");
    let mk: [u8; 32] = h2.finalize().into();
    (ek, mk)
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        let d: [u8; 32] = Sha256::digest(key).into();
        k[..32].copy_from_slice(&d);
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let mut ih = Sha256::new();
    ih.update(ipad);
    ih.update(data);
    let inner = ih.finalize();
    let mut oh = Sha256::new();
    oh.update(opad);
    oh.update(inner);
    oh.finalize().into()
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

fn seal_payload(dir: &Path, plain: &[u8]) -> Vec<u8> {
    let (ek, mk) = subkeys(dir);
    let mut nonce = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut nonce);
    let mut buf = plain.to_vec();
    let mut cipher = Aes256Ctr::new(&ek.into(), &nonce.into());
    cipher.apply_keystream(&mut buf);
    let mut mac_in = Vec::with_capacity(16 + buf.len());
    mac_in.extend_from_slice(&nonce);
    mac_in.extend_from_slice(&buf);
    let tag = hmac_sha256(&mk, &mac_in);
    let mut out = Vec::with_capacity(16 + buf.len() + 32);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&buf);
    out.extend_from_slice(&tag);
    out
}

fn open_payload(dir: &Path, payload: &[u8]) -> Option<Vec<u8>> {
    if payload.len() < 48 {
        return None;
    }
    let (nonce, rest) = payload.split_at(16);
    let (ct, tag) = rest.split_at(rest.len() - 32);
    let (ek, mk) = subkeys(dir);
    let mut mac_in = Vec::with_capacity(16 + ct.len());
    mac_in.extend_from_slice(nonce);
    mac_in.extend_from_slice(ct);
    if !ct_eq(&hmac_sha256(&mk, &mac_in), tag) {
        return None;
    }
    let mut n16 = [0u8; 16];
    n16.copy_from_slice(nonce);
    let mut out = ct.to_vec();
    let mut cipher = Aes256Ctr::new(&ek.into(), &n16.into());
    cipher.apply_keystream(&mut out);
    Some(out)
}

/// 文件密文串（标准 base64）。
pub fn seal(dir: &Path, plain: &[u8]) -> String {
    format!("LVG1:{}", STANDARD.encode(seal_payload(dir, plain)))
}

/// 打开文件内容；无 LVG1: 前缀视为历史明文原样返回。
pub fn open(dir: &Path, raw: &[u8]) -> Option<Vec<u8>> {
    if !raw.starts_with(MAGIC) {
        return Some(raw.to_vec());
    }
    let b64 = std::str::from_utf8(&raw[MAGIC.len()..]).ok()?.trim();
    let payload = STANDARD.decode(b64).ok()?;
    open_payload(dir, &payload)
}

/// 读取文件并解密；无文件或解密失败返回 None。
pub fn read(path: &Path) -> Option<Vec<u8>> {
    let raw = std::fs::read(path).ok()?;
    open(&key_dir(path), &raw)
}

/// 加密并原子写入（先写 .tmp 再 rename）。
pub fn write(path: &Path, plain: &[u8]) -> bool {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let body = seal(&key_dir(path), plain);
    let tmp = PathBuf::from(format!("{}.tmp", path.to_string_lossy()));
    if std::fs::write(&tmp, body.as_bytes()).is_ok() && std::fs::rename(&tmp, path).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        return true;
    }
    false
}

/// 生成防篡改令牌（URL-safe base64，适合放进 cookie）；sid 以密文形式隐含其中。
pub fn seal_token(dir: &Path, plain: &[u8]) -> String {
    format!("LVG1:{}", URL_SAFE_NO_PAD.encode(seal_payload(dir, plain)))
}

/// 校验并解密令牌；任何伪造/篡改/换密钥都会返回 None。
pub fn open_token(dir: &Path, token: &str) -> Option<Vec<u8>> {
    let t = token.trim();
    if !t.as_bytes().starts_with(MAGIC) {
        return None;
    }
    let payload = URL_SAFE_NO_PAD.decode(&t[MAGIC.len()..]).ok()?;
    open_payload(dir, &payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lvguo-secret-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::create_dir_all(&d);
        d
    }

    #[test]
    fn roundtrip_legacy_tamper() {
        let dir = tmpdir("file");
        let p = dir.join("x.json");
        let legacy: &[u8] = b"{\"a\":1}";
        std::fs::write(&p, legacy).unwrap();
        assert_eq!(read(&p).unwrap().as_slice(), legacy);
        let msg: &[u8] = b"hello-secret";
        assert!(write(&p, msg));
        let raw = std::fs::read(&p).unwrap();
        assert!(raw.starts_with(b"LVG1:"));
        assert_eq!(read(&p).unwrap().as_slice(), msg);
        let mut bad = raw.clone();
        let n = bad.len();
        bad[n - 2] ^= 0x01;
        std::fs::write(&p, &bad).unwrap();
        assert!(read(&p).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn token_auth_and_cross_key() {
        let a = tmpdir("tok-a");
        let b = tmpdir("tok-b");
        let sid = b"0123456789abcdef0123456789abcdef";
        let tok = seal_token(&a, sid);
        assert!(tok.starts_with("LVG1:"));
        // 明文 sid 不应出现在令牌里
        assert!(!tok.contains("0123456789abcdef"));
        // 本目录可解
        assert_eq!(open_token(&a, &tok).unwrap().as_slice(), sid);
        // 换一个目录（不同主密钥）无法伪造/解密
        assert!(open_token(&b, &tok).is_none());
        // 篡改一位即失败
        let mut t = tok.clone().into_bytes();
        let last = t.len() - 1;
        t[last] = if t[last] == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(t).unwrap();
        assert!(open_token(&a, &tampered).is_none());
        // 裸 sid / 空值一律拒绝
        assert!(open_token(&a, "0123456789abcdef0123456789abcdef").is_none());
        assert!(open_token(&a, "").is_none());
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }
}
