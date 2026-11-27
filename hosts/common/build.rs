//! 编译期收集 `../../web-ui` 下的全部静态前端文件并生成零拷贝匹配查找表。

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|x| x.path())).collect();
    paths.sort();
    for p in paths {
        if p.is_dir() {
            collect_files(root, &p, out);
        } else if p.is_file() {
            if let Ok(rel) = p.strip_prefix(root) {
                let web_path = format!("/{}", rel.to_string_lossy().replace('\\', "/"));
                out.push((web_path, p));
            }
        }
    }
}

fn guess_mime(path: &str) -> &'static str {
    let l = path.to_ascii_lowercase();
    if l.ends_with(".html") || l.ends_with(".htm") {
        "text/html; charset=utf-8"
    } else if l.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if l.ends_with(".js") {
        "application/javascript; charset=utf-8"
    } else if l.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if l.ends_with(".png") {
        "image/png"
    } else if l.ends_with(".webp") {
        "image/webp"
    } else if l.ends_with(".svg") {
        "image/svg+xml"
    } else if l.ends_with(".ico") {
        "image/x-icon"
    } else {
        "application/octet-stream"
    }
}

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let web_ui_dir = fs::canonicalize(manifest_dir.join("../../web-ui"))
        .unwrap_or_else(|_| manifest_dir.join("../../web-ui"));
    println!("cargo:rerun-if-changed={}", web_ui_dir.display());

    let mut files = Vec::new();
    collect_files(&web_ui_dir, &web_ui_dir, &mut files);

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let dest = out_dir.join("embedded_web_ui.rs");

    let mut code = String::new();
    code.push_str("pub fn lookup_embedded_asset(path: &str) -> Option<(&'static [u8], &'static [u8])> {\n");
    code.push_str("    match path {\n");
    for (web_path, abs_path) in &files {
        println!("cargo:rerun-if-changed={}", abs_path.display());
        let mime = guess_mime(web_path);
        let abs_escaped = abs_path.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
        code.push_str(&format!(
            "        {web_path:?} => Some((include_bytes!(\"{abs_escaped}\"), b\"{mime}\\0\")),\n"
        ));
    }
    code.push_str("        _ => None,\n");
    code.push_str("    }\n");
    code.push_str("}\n");

    fs::write(dest, code).expect("write embedded_web_ui.rs");
}
