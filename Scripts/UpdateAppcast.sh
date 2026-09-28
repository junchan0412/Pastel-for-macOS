#!/bin/sh
# 为一个新的 DMG 生成/更新 Sparkle appcast 条目（签名、大小、发布时间、下载地址）。
#
# 用法：
#   Scripts/UpdateAppcast.sh <dmg> <marketing-version> <build-version> <release-tag> [repo]
# 环境变量：
#   SPARKLE_BIN   sign_update 所在目录（默认按 ~/.sparkle/bin → 已下载缓存 → 自动下载 依次查找）
#   SPARKLE_REPO  owner/name（默认取 git remote origin）
#
# 签名私钥来自 macOS 钥匙串（由 generate_keys 生成）；如需离线签名，
# 用 SPARKLE_BIN/sign_update --ed-key-file <私钥文件>。
set -eu

usage() {
    echo "Usage: $0 <dmg> <marketing-version> <build-version> <release-tag> [repo]" >&2
    exit 64
}

[ $# -ge 4 ] || usage
dmg=$1
marketing=$2
build=$3
tag=$4
repo=${5:-${SPARKLE_REPO:-}}

if [ -z "$repo" ]; then
    repo=$(git remote get-url origin 2>/dev/null \
        | sed -E 's#.*github\.com[:/]##' | sed -E 's#\.git$##' || true)
fi
[ -n "$repo" ] || { echo "error: 无法确定仓库（传第 5 个参数或设置 SPARKLE_REPO=owner/name）" >&2; exit 1; }

[ -f "$dmg" ] || { echo "error: 找不到 DMG: $dmg" >&2; exit 1; }

project_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
appcast="${project_root}/appcast.xml"
notes_file="${project_root}/release-notes/${marketing}/release-notes.md"
[ -f "$appcast" ] || { echo "error: 找不到 appcast.xml" >&2; exit 1; }

command -v python3 >/dev/null 2>&1 || { echo "error: 需要 python3" >&2; exit 1; }

# --- 定位 sign_update ---
# 输出目录（统一约定：调用方拼 /sign_update）
find_sign_update() {
    if [ -n "${SPARKLE_BIN:-}" ] && [ -x "${SPARKLE_BIN}/sign_update" ]; then
        echo "${SPARKLE_BIN}"
        return 0
    fi
    if [ -x "${HOME}/.sparkle/bin/sign_update" ]; then
        echo "${HOME}/.sparkle/bin"
        return 0
    fi
    cached=$(ls -d "${TMPDIR:-/tmp}/sparkle-tools-2.10.0/bin" 2>/dev/null || true)
    if [ -n "$cached" ] && [ -x "${cached}/sign_update" ]; then
        echo "${cached}"
        return 0
    fi
    return 1
}

sign_update=$(find_sign_update || true)
if [ -z "$sign_update" ]; then
    cache="${TMPDIR:-/tmp}/sparkle-tools-2.10.0"
    echo "下载 Sparkle 2.10.0 工具…" >&2
    mkdir -p "$cache"
    curl -sL --max-time 300 -o "${cache}/sparkle.tar.xz" \
        "https://github.com/sparkle-project/Sparkle/releases/download/2.10.0/Sparkle-2.10.0.tar.xz"
    tar -xf "${cache}/sparkle.tar.xz" -C "$cache"
    sign_update="${cache}/bin"
    [ -x "${sign_update}/sign_update" ] || { echo "error: sign_update 不可用" >&2; exit 1; }
fi

# --- 签名并校验 ---
signature=$("${sign_update}/sign_update" -p "$dmg" | tr -d '\r' | sed '/^$/d' | tail -n 1)
[ -n "$signature" ] || { echo "error: 签名失败（私钥是否已在钥匙串？）" >&2; exit 1; }
"${sign_update}/sign_update" --verify "$dmg" "$signature" >/dev/null 2>&1 || {
    echo "error: 签名校验未通过" >&2
    exit 1
}

DMG_PATH="$dmg" DMG_NAME=$(basename "$dmg") \
DMG_SIZE=$(stat -f%z "$dmg") \
MARKETING="$marketing" BUILD="$build" TAG="$tag" REPO="$repo" \
SIGNATURE="$signature" NOTES_FILE="$notes_file" \
APPCAST="$appcast" \
python3 - <<'PY'
import html, os, pathlib, re, sys, datetime, zoneinfo

def fail(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)

appcast_path = pathlib.Path(os.environ["APPCAST"])
text = appcast_path.read_text(encoding="utf-8")

dmg_name = os.environ["DMG_NAME"]
marketing = os.environ["MARKETING"]
build = os.environ["BUILD"]
tag = os.environ["TAG"]
repo = os.environ["REPO"]
size = os.environ["DMG_SIZE"]
signature = os.environ["SIGNATURE"]
notes_path = pathlib.Path(os.environ["NOTES_FILE"])

notes = notes_path.read_text(encoding="utf-8").rstrip() + "\n" if notes_path.exists() else ""
notes = notes.replace("]]>", "]]]]><![CDATA[>")

url = f"https://github.com/{repo}/releases/download/{tag}/{dmg_name}"
pub_date = datetime.datetime.now(zoneinfo.ZoneInfo("Asia/Shanghai")).strftime("%a, %d %b %Y %H:%M:%S %z")

item = f"""        <item>
            <title>{html.escape(marketing)}</title>
            <pubDate>{pub_date}</pubDate>
            <link>https://github.com/{repo}/releases/tag/{tag}</link>
            <sparkle:version>{html.escape(build)}</sparkle:version>
            <sparkle:shortVersionString>{html.escape(marketing)}</sparkle:shortVersionString>
            <sparkle:minimumSystemVersion>26.0</sparkle:minimumSystemVersion>
            <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>
            <description sparkle:format="plain-text"><![CDATA[{notes}]]></description>
            <enclosure url="{html.escape(url)}" length="{size}" type="application/octet-stream" sparkle:edSignature="{html.escape(signature)}"/>
        </item>
"""

# 已有同 build 的条目 → 原地替换；否则插到 channel 最前面。
pattern = re.compile(
    r'[ \t]*<item>(?:(?!</item>).)*?<sparkle:version>' + re.escape(build) +
    r'</sparkle:version>(?:(?!</item>).)*?</item>\n', re.S)

if pattern.search(text):
    text = pattern.sub(item, text, count=1)
    action = "updated"
else:
    anchor = "        <item>"
    if anchor not in text:
        fail("appcast.xml 中找不到可插入的位置")
    text = text.replace(anchor, item + anchor, 1)
    action = "added"

appcast_path.write_text(text, encoding="utf-8")

# 合法性检查
import xml.dom.minidom
xml.dom.minidom.parse(str(appcast_path))
versions = re.findall(r"<sparkle:version>([^<]+)</sparkle:version>", text)
print(f"{action} appcast item: build={build} size={size} url={url}")
print(f"edSignature={signature}")
print(f"versions (newest first): {', '.join(versions[:3])}")
print("下一步：上传 DMG 到 release，然后把 appcast.xml 提交推送。")
PY

# 保留给后续步骤：把签名写到文件，方便外层脚本使用
printf '%s\n' "$signature" > "${dmg}.ed25519"
echo "signature 已写入 ${dmg}.ed25519"
