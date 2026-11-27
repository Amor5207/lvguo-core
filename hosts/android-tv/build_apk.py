#!/usr/bin/env python3
"""
绿果 TV Android APK 构建脚本（minSdk 23 / targetSdk 28）。

特点：
1. 不依赖 Gradle 缓存环境，直接调用 Android SDK `aapt2` / `javac` / `d8` / `zipalign` / `apksigner`；
2. 自动把跨架构编译产出的单文件核心 `lib/arm64-v8a/liblvguo_core.so` 与 `lib/armeabi-v7a/liblvguo_core.so`
   以 ZIP_STORED（不压缩 + zipalign 4K 页对齐）打入安装包；
3. 支持本机调试与 GitHub Actions CI 无缝复用。
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


def pick_build_tools(sdk_root: Path) -> Path:
    bt_dir = sdk_root / "build-tools"
    if not bt_dir.is_dir():
        raise SystemExit(f"未找到 Android build-tools: {bt_dir}")
    versions = sorted([p for p in bt_dir.iterdir() if p.is_dir()], key=lambda p: p.name)
    if not versions:
        raise SystemExit(f"build-tools 为空: {bt_dir}")
    for pref in ("35.0.0", "35.0.1", "34.0.0"):
        cand = bt_dir / pref
        if cand.is_dir():
            return cand
    return versions[-1]


def pick_platform_jar(sdk_root: Path) -> Path:
    for api in ("android-35", "android-34", "android-33"):
        jar = sdk_root / "platforms" / api / "android.jar"
        if jar.is_file():
            return jar
    plats = sorted((sdk_root / "platforms").glob("android-*/android.jar"))
    if plats:
        return plats[-1]
    raise SystemExit(f"未找到 android.jar: {sdk_root / 'platforms'}")


def exe(folder: Path, name: str) -> str:
    p = folder / name
    if p.exists():
        return str(p)
    win = folder / f"{name}.exe"
    return str(win if win.exists() else p)


def run(*cmd):
    subprocess.run([str(c) for c in cmd], check=True)


def ensure_debug_keystore(keystore: Path, java_bin: Path, store_pass: str, key_pass: str, alias: str):
    if keystore.is_file():
        return
    keystore.parent.mkdir(parents=True, exist_ok=True)
    run(
        exe(java_bin, "keytool"),
        "-genkey", "-v",
        "-keystore", keystore,
        "-storepass", store_pass,
        "-alias", alias,
        "-keypass", key_pass,
        "-keyalg", "RSA",
        "-keysize", "2048",
        "-validity", "10000",
        "-dname", "CN=LvguoCore,O=Lvguo,C=CN",
    )


def main():
    here = Path(__file__).resolve().parent
    repo = here.parent.parent

    parser = argparse.ArgumentParser(description="构建绿果 TV APK（支持全架构或分架构输出）")
    parser.add_argument("--version-code", type=int, default=int(os.environ.get("LVGUO_VERSION_CODE", "3002")))
    parser.add_argument("--version-name", default=os.environ.get("LVGUO_VERSION_NAME", "3.0.2"))
    parser.add_argument("--abi", choices=("all", "arm64-v8a", "armeabi-v7a"), default=os.environ.get("LVGUO_APK_ABI", "all"))
    parser.add_argument("--arm64-so", default=os.environ.get("LVGUO_ARM64_SO", str(repo / "target/aarch64-linux-android/release/liblvguo_core.so")))
    parser.add_argument("--armv7-so", default=os.environ.get("LVGUO_ARMV7_SO", str(repo / "target/armv7-linux-androideabi/release/liblvguo_core.so")))
    parser.add_argument("--out", default=str(here / "out/lvguo-tv.apk"))
    args = parser.parse_args()

    sdk_root = Path(
        os.environ.get("ANDROID_SDK_ROOT")
        or os.environ.get("ANDROID_HOME")
        or "/root/toolchains/android/Sdk"
    ).expanduser()
    java_home = Path(os.environ.get("JAVA_HOME") or "/usr/lib/jvm/java-21-openjdk-amd64").expanduser()
    java_bin = java_home / "bin" if (java_home / "bin").is_dir() else Path("/usr/bin")

    bt = pick_build_tools(sdk_root)
    platform_jar = pick_platform_jar(sdk_root)

    keystore = Path(os.environ.get("LVGUO_KEYSTORE") or (Path.home() / ".android/debug.keystore")).expanduser()
    store_pass = os.environ.get("LVGUO_STORE_PASSWORD", "android")
    key_pass = os.environ.get("LVGUO_KEY_PASSWORD", "android")
    key_alias = os.environ.get("LVGUO_KEY_ALIAS", "androiddebugkey")
    ensure_debug_keystore(keystore, java_bin, store_pass, key_pass, key_alias)

    arm64_so = Path(args.arm64_so)
    armv7_so = Path(args.armv7_so)
    native_libs = []
    if args.abi in ("all", "arm64-v8a") and arm64_so.is_file():
        native_libs.append(("lib/arm64-v8a/liblvguo_core.so", arm64_so))
    if args.abi in ("all", "armeabi-v7a") and armv7_so.is_file():
        native_libs.append(("lib/armeabi-v7a/liblvguo_core.so", armv7_so))
    if not native_libs:
        raise SystemExit(f"未找到目标架构 ({args.abi}) 的 liblvguo_core.so（已检查 {arm64_so} 与 {armv7_so}）")

    sys.path.insert(0, str(here / "tools"))
    from media3_dependencies import prepare

    jars, library_resources, library_packages = prepare(here, here / "third_party/hgtv_media3_dependencies")
    jars = [here / "libs/zxing-core-3.5.3.jar"] + jars
    classpath = os.pathsep.join(str(p) for p in [platform_jar] + jars)

    build_dir = here / "build/apk-work"
    shutil.rmtree(build_dir, ignore_errors=True)
    for sub in ("classes", "gen", "dexout"):
        (build_dir / sub).mkdir(parents=True, exist_ok=True)

    manifest_text = (here / "AndroidManifest.xml").read_text(encoding="utf-8")
    manifest_text = (
        manifest_text
        .replace("${appLabel}", "@string/app_name")
        .replace("${applicationId}", "ink.pengfei.lvguo")
        .replace("${updateChannel}", os.environ.get("LVGUO_UPDATE_CHANNEL", "stable"))
    )
    manifest_text = re.sub(r'android:versionCode="[^"]+"', f'android:versionCode="{args.version_code}"', manifest_text, count=1)
    manifest_text = re.sub(r'android:versionName="[^"]+"', f'android:versionName="{args.version_name}"', manifest_text, count=1)
    manifest_out = build_dir / "AndroidManifest.xml"
    manifest_out.write_text(manifest_text, encoding="utf-8")

    run(exe(bt, "aapt2"), "compile", "--dir", here / "res", "-o", build_dir / "res.zip")
    compiled_libraries = []
    for n, folder in enumerate(library_resources):
        archive = build_dir / f"library-{n}.zip"
        run(exe(bt, "aapt2"), "compile", "--dir", folder, "-o", archive)
        compiled_libraries.extend(["-R", archive])

    aapt_link = [
        exe(bt, "aapt2"), "link",
        "--auto-add-overlay",
        "--custom-package", "ink.pengfei.lvguo",
        "--rename-manifest-package", "ink.pengfei.lvguo",
    ]
    if library_packages:
        aapt_link.extend(["--extra-packages", ":".join(library_packages)])
    aapt_link.extend([
        "-o", build_dir / "base.apk",
        "--manifest", manifest_out,
        "-I", platform_jar,
        "--java", build_dir / "gen",
        "--min-sdk-version", "23",
        "--target-sdk-version", "28",
        "--version-code", str(args.version_code),
        "--version-name", args.version_name,
        *compiled_libraries,
        build_dir / "res.zip",
    ])
    run(*aapt_link)

    java_files = list((here / "src").rglob("*.java")) + list((build_dir / "gen").rglob("*.java"))
    javac_args_file = build_dir / "javac.args"
    javac_args_file.write_text("\n".join(str(p) for p in java_files), encoding="utf-8")
    run(
        exe(java_bin, "javac"),
        "-J-Duser.language=en",
        "-encoding", "UTF-8",
        "-source", "8",
        "-target", "8",
        "-nowarn",
        "-cp", classpath,
        "-d", build_dir / "classes",
        f"@{javac_args_file}",
    )

    class_files = list((build_dir / "classes").rglob("*.class"))
    run(
        exe(java_bin, "java"),
        "-cp", bt / "lib/d8.jar",
        "com.android.tools.r8.D8",
        "--min-api", "23",
        "--lib", platform_jar,
        "--output", build_dir / "dexout",
        *class_files,
        *jars,
    )

    unsigned_apk = build_dir / "unsigned.apk"
    with zipfile.ZipFile(build_dir / "base.apk") as src, zipfile.ZipFile(unsigned_apk, "w") as out:
        for entry in src.infolist():
            out.writestr(entry, src.read(entry.filename))
        for doc in ("LICENSE", "NOTICE"):
            p = here / doc
            if p.is_file():
                out.write(p, f"assets/{doc}")
        notices = here / "THIRD_PARTY_NOTICES.md"
        if notices.is_file():
            out.write(notices, "assets/third_party/NOTICES.md")
        for dex in sorted((build_dir / "dexout").glob("classes*.dex")):
            out.write(dex, dex.name, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        for arc_name, so_file in native_libs:
            out.write(so_file, arc_name, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)

    aligned_apk = build_dir / "aligned.apk"
    run(exe(bt, "zipalign"), "-f", "-P", "16", "4", unsigned_apk, aligned_apk)

    out_apk = Path(args.out)
    out_apk.parent.mkdir(parents=True, exist_ok=True)
    run(
        exe(java_bin, "java"),
        "-jar", bt / "lib/apksigner.jar",
        "sign",
        "--ks", keystore,
        "--ks-pass", f"pass:{store_pass}",
        "--key-pass", f"pass:{key_pass}",
        "--ks-key-alias", key_alias,
        "--out", out_apk,
        aligned_apk,
    )
    print(f"Android TV APK 已生成: {out_apk} ({out_apk.stat().st_size} bytes)")
    print("包含 Core ABI:", ", ".join(arc for arc, _ in native_libs))


if __name__ == "__main__":
    main()
