#!/bin/bash
# package-skill.sh — 自己打包成 .skill（纯 zip），**不依赖任何第三方打包工具**
#
# 为什么自带：早期依赖某个第三方 skill 打包器，产物会落到那个工具自己的目录里，
# 位置不可控、还平白多一层依赖。自带打包后：
#   · 产物位置可控（默认 ~/.agents/skills/.packages/，即本机 skill 仓库下的包目录）
#   · 只依赖系统 zip，换机器/换工具链都不受影响
#
# 用法：
#   bash .knowlog/package-skill.sh                    # 默认输出到 ~/.agents/skills/.packages/
#   bash .knowlog/package-skill.sh --out ./dist
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:-}"; shift 2 ;;
    --out=*) OUT="${1#--out=}"; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done
[ -f "$SKILL_DIR/SKILL.md" ] || { echo "❌ 这里不是 skill 目录：$SKILL_DIR" >&2; exit 1; }
VERSION="$(cat "$SKILL_DIR/VERSION" 2>/dev/null || echo 0.0.0)"
NAME="$(basename "$SKILL_DIR")"

if [ -z "$OUT" ]; then
  if [ -d "$HOME/.agents/skills" ]; then OUT="$HOME/.agents/skills/.packages"
  else OUT="$HOME/.local/share/knowlog/packages"; fi
fi
mkdir -p "$OUT"
PKG="$OUT/${NAME}-v${VERSION}.skill"

# 打包内容与安装内容一致：SKILL.md + VERSION + scripts + adapters + assets + references（不含 evals/）
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/$NAME"
for item in SKILL.md VERSION package.json bin scripts adapters assets references; do
  [ -e "$SKILL_DIR/$item" ] && cp -R "$SKILL_DIR/$item" "$TMP/$NAME/"
done
rm -f "$PKG"
( cd "$TMP" && zip -qr "$PKG" "$NAME" )
echo "✅ 已打包：${PKG}（v${VERSION}，$(du -h "$PKG" | cut -f1)）"
echo "   安装（含各 agent）：bash .knowlog/install-skill.sh --agent auto"
