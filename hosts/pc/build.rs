fn main() {
    #[cfg(target_os = "windows")]
    {
        let mut res = winresource::WindowsResource::new();
        let icon = "../../packaging/windows/app_icon.ico";
        if std::path::Path::new(icon).is_file() {
            res.set_icon(icon);
        }
        res.set("ProductName", "绿果PC");
        res.set("FileDescription", "绿果PC 桌面客户端");
        if let Err(e) = res.compile() {
            eprintln!("cargo:warning=嵌入 Windows 图标失败: {e}");
        }
    }
}
