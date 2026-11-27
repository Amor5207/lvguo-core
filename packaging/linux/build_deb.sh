#!/usr/bin/env bash
# 打包 Linux PC 客户端 Debian 安装包（.deb），打开即用。
set -euo pipefail

ARCH="amd64"
BIN_PATH=""
CORE_PATH=""
APP_VERSION="3.0.2"
OUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch) ARCH="$2"; shift 2 ;;
    --bin) BIN_PATH="$2"; shift 2 ;;
    --core) CORE_PATH="$2"; shift 2 ;;
    --version) APP_VERSION="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ICON_PATH="$REPO_DIR/packaging/icons/lvguo-pc.png"
OUT_DIR="${OUT_DIR:-$REPO_DIR/dist}"

if [[ ! -f "$BIN_PATH" || ! -f "$CORE_PATH" ]]; then
  echo "缺少二进制输入: bin=$BIN_PATH core=$CORE_PATH" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/DEBIAN" \
  "$STAGE/opt/lvguo-pc" \
  "$STAGE/usr/bin" \
  "$STAGE/usr/share/applications" \
  "$STAGE/usr/share/icons/hicolor/256x256/apps"

install -m 0755 "$BIN_PATH" "$STAGE/opt/lvguo-pc/lvguo-pc"
install -m 0644 "$CORE_PATH" "$STAGE/opt/lvguo-pc/liblvguo_core.so"
install -m 0644 "$ICON_PATH" "$STAGE/usr/share/icons/hicolor/256x256/apps/lvguo-pc.png"

cat > "$STAGE/usr/bin/lvguo-pc" <<'EOF'
#!/usr/bin/env bash
exec /opt/lvguo-pc/lvguo-pc "$@"
EOF
chmod 0755 "$STAGE/usr/bin/lvguo-pc"

cat > "$STAGE/usr/share/applications/lvguo-pc.desktop" <<'EOF'
[Desktop Entry]
Name=绿果PC
Comment=绿果PC 桌面客户端（基于 lvguo-core）
Exec=/usr/bin/lvguo-pc %U
Icon=lvguo-pc
Terminal=false
Type=Application
Categories=AudioVideo;Video;Player;
MimeType=x-scheme-handler/lvguo;
EOF

cat > "$STAGE/DEBIAN/control" <<EOF
Package: lvguo-pc
Version: $APP_VERSION
Section: video
Priority: optional
Architecture: $ARCH
Maintainer: Pengfei <support@pengfei.ink>
Recommends: mpv, xdg-utils
Description: 绿果PC 独立桌面客户端（基于单一动态库 lvguo-core，支持本地解析与单文件热更新）
EOF

OUT_DEB="$OUT_DIR/LvguoPC-$APP_VERSION-linux-$ARCH.deb"
dpkg-deb --root-owner-group --build "$STAGE" "$OUT_DEB"
echo "生成 Linux 安装包: $OUT_DEB"
