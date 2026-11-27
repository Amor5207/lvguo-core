#!/usr/bin/env bash
# 打包 macOS 桌面端 .dmg（支持按 arm64 / x64 分架构直出或 universal 通用包，打开拖入 Applications 即用）。
set -euo pipefail

ARCH="universal"
BIN_SINGLE=""
CORE_SINGLE=""
BIN_ARM64=""
BIN_X64=""
CORE_ARM64=""
CORE_X64=""
APP_VERSION="3.0.1"
OUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch) ARCH="$2"; shift 2 ;;
    --bin) BIN_SINGLE="$2"; shift 2 ;;
    --core) CORE_SINGLE="$2"; shift 2 ;;
    --bin-arm64) BIN_ARM64="$2"; shift 2 ;;
    --bin-x64) BIN_X64="$2"; shift 2 ;;
    --core-arm64) CORE_ARM64="$2"; shift 2 ;;
    --core-x64) CORE_X64="$2"; shift 2 ;;
    --version) APP_VERSION="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ICON_PNG="$REPO_DIR/packaging/icons/lvguo-pc.png"
OUT_DIR="${OUT_DIR:-$REPO_DIR/dist}"

mkdir -p "$OUT_DIR"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

STAGE="$WORK/dmg-stage"
APP="$STAGE/绿果PC.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Frameworks" "$APP/Contents/Resources"

if [[ -n "$BIN_SINGLE" && -n "$CORE_SINGLE" ]]; then
  cp -f "$BIN_SINGLE" "$APP/Contents/MacOS/lvguo-pc"
  cp -f "$CORE_SINGLE" "$APP/Contents/Frameworks/liblvguo_core.dylib"
else
  lipo -create "$BIN_ARM64" "$BIN_X64" -output "$APP/Contents/MacOS/lvguo-pc"
  lipo -create "$CORE_ARM64" "$CORE_X64" -output "$APP/Contents/Frameworks/liblvguo_core.dylib"
fi
chmod +x "$APP/Contents/MacOS/lvguo-pc"
install_name_tool -id "@rpath/liblvguo_core.dylib" "$APP/Contents/Frameworks/liblvguo_core.dylib" || true

# 从 PNG 生成 macOS .icns 图标
ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
for sz in 16 32 128 256 512; do
  sips -z "$sz" "$sz" "$ICON_PNG" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null
  dbl=$((sz * 2))
  sips -z "$dbl" "$dbl" "$ICON_PNG" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleExecutable</key><string>lvguo-pc</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>ink.pengfei.lvguo.pc</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>绿果PC</string>
  <key>CFBundleDisplayName</key><string>绿果PC</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${APP_VERSION}</string>
  <key>CFBundleVersion</key><string>${APP_VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF

codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
ln -s /Applications "$STAGE/Applications"

if [[ "$ARCH" == "universal" ]]; then
  OUT_DMG="$OUT_DIR/LvguoPC-${APP_VERSION}-macOS.dmg"
else
  OUT_DMG="$OUT_DIR/LvguoPC-${APP_VERSION}-macOS-${ARCH}.dmg"
fi
rm -f "$OUT_DMG"
for attempt in 1 2 3 4 5; do
  if hdiutil create -volname "绿果PC" -srcfolder "$STAGE" -ov -format UDZO "$OUT_DMG"; then
    break
  fi
  if [[ "$attempt" -eq 5 ]]; then
    echo "hdiutil create 多次重试仍失败" >&2
    exit 1
  fi
  echo "hdiutil create 遇到临时占用，第 ${attempt} 次重试前等待..." >&2
  rm -f "$OUT_DMG"
  for vol in /Volumes/绿果PC*; do
    [[ -e "$vol" ]] && hdiutil detach "$vol" -force >/dev/null 2>&1 || true
  done
  sleep 3
done
echo "生成 macOS 安装镜像: $OUT_DMG"
