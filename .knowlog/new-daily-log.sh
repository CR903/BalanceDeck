#!/bin/bash
# new-daily-log.sh — 按「写入即按月份」规范新建一篇任务日志
#
# 路径恒为：docs/daily/<YYYY-MM>/YYYY-MM-DD_<slug>.md
# 月份取「日志日期所在月」（跨月补写按日期归月），与 docs/index.md 年月表格严格一致。
# 这样路径就是日期的纯函数：写入即定路径，不需要事后归档、也不需要回改索引链接。
#
# 用法：
#   bash .knowlog/new-daily-log.sh <slug>                  # 用今天日期
#   bash .knowlog/new-daily-log.sh <slug> 2026-09-02       # 补写指定日期（进 2026-09/）
#   bash .knowlog/new-daily-log.sh <slug> --no-index       # 只建文件，不动索引
#   bash .knowlog/new-daily-log.sh <slug> --root /path/to/project
set -euo pipefail

ROOT=""
SLUG=""
DATE=""
WRITE_INDEX=1
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --root=*) ROOT="${1#--root=}"; shift ;;
    --no-index) WRITE_INDEX=0; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
set -- ${ARGS[@]+"${ARGS[@]}"}

if [ -z "$ROOT" ]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$ROOT" ] || {
    _self="$(cd "$(dirname "$0")/.." && pwd)"
    # 非 git 目录：区分「项目内副本」与「skill/包本体」
    #   · skill/包本体（带 SKILL.md + assets/）→ 目标是**用户当前目录**
    #     （否则会写进 skill 自己——0.3.3 真机事故：npx 运行时体系建到了 npx 缓存包里）
    #   · 项目内副本 → 目标是项目根
    if [ -f "$_self/SKILL.md" ] && [ -d "$_self/assets" ]; then ROOT="$PWD"; else ROOT="$_self"; fi
  }

fi

# 项目内工具目录：.knowlog（新）优先，兼容旧 scripts/
TOOL="$ROOT/.knowlog"
if [ ! -d "$TOOL" ] && [ -f "$ROOT/.knowlog/bootstrap-docs.sh" ]; then TOOL="$ROOT/scripts"; fi
TOOLNAME="${TOOL#"$ROOT"/}"
TPL="$ROOT/docs/template.md"
INDEX="$ROOT/docs/index.md"
PROJECT_NAME="${PROJECT_NAME:-$(basename "$ROOT")}"

if [ $# -ge 1 ]; then SLUG="$1"; fi
if [ $# -ge 2 ]; then DATE="$2"; fi

if [ -z "$SLUG" ]; then
  echo "❌ 用法：bash .knowlog/new-daily-log.sh <slug> [YYYY-MM-DD] [--no-index] [--root DIR]" >&2
  exit 2
fi
printf '%s' "$SLUG" | grep -Eq '^[a-z0-9]+(-[a-z0-9]+)*$' || {
  echo "❌ slug 必须是 kebab-case（小写字母/数字，短横线连接）：$SLUG" >&2; exit 2; }
if [ -z "$DATE" ]; then DATE="$(date +%Y-%m-%d)"; fi
printf '%s' "$DATE" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' || {
  echo "❌ 日期格式应为 YYYY-MM-DD：$DATE" >&2; exit 2; }
python3 -c "import datetime,sys; datetime.date.fromisoformat(sys.argv[1])" "$DATE" 2>/dev/null || {
  echo "❌ 不是合法日期：$DATE" >&2; exit 2; }
[ -f "$TPL" ] || {
  echo "❌ 找不到日志模板 $TPL" >&2
  echo "   新项目请先跑：bash .knowlog/bootstrap-docs.sh" >&2
  exit 1; }

MONTH="${DATE%-*}"
DIR="$ROOT/docs/daily/$MONTH"
TARGET="$DIR/${DATE}_${SLUG}.md"
REL="daily/$MONTH/${DATE}_${SLUG}.md"
[ -e "$TARGET" ] && { echo "❌ 已存在，未覆盖：docs/$REL" >&2; exit 1; }

mkdir -p "$DIR"
# 用 python 做替换：slug/日期/项目名里可能含 / & \ 等 sed 敏感字符，sed 会静默写坏文件
TPL="$TPL" TARGET="$TARGET" SLUG="$SLUG" DATE="$DATE" PROJECT="$PROJECT_NAME" python3 - <<'PY'
import os, pathlib, sys
tpl = pathlib.Path(os.environ["TPL"]); out = pathlib.Path(os.environ["TARGET"])
slug, date, proj = os.environ["SLUG"], os.environ["DATE"], os.environ["PROJECT"]
text = tpl.read_text(encoding="utf-8")
for k, v in {"YYYY-MM-DD_<slug>": f"{date}_{slug}", "<slug>": slug, "<PROJECT>": proj,
             "YYYY-MM-DD": date}.items():
    text = text.replace(k, v)     # 顺序敏感：先替换长模式
out.write_text(text, encoding="utf-8")
if out.stat().st_size == 0:
    print("❌ 渲染结果为空，已中止", file=sys.stderr); sys.exit(1)
PY
echo "✅ 已创建日志：docs/$REL"

if [ "$WRITE_INDEX" -eq 0 ] || [ ! -f "$INDEX" ]; then
  [ "$WRITE_INDEX" -eq 1 ] && echo "ℹ️  未找到 docs/index.md，跳过索引行（记得手补，否则 check-daily-index.sh 会报错）"
  exit 0
fi

TASK_SLUG="$(printf '%s' "$DATE" | cut -c6-10)-${SLUG}"
UTIL="$TOOL/index-util.py"
[ -f "$UTIL" ] || {
  echo "❌ 缺少 ${UTIL}（索引写入原语）。请重跑：bash .knowlog/bootstrap-docs.sh" >&2
  exit 1; }
STATUS="$(python3 "$UTIL" upsert --index "$INDEX" --date "$DATE" --rel "$REL" \
  --cells "${TASK_SLUG}|待回填|待提交|待回填")"

echo "✅ 已插入索引行骨架 → docs/index.md 的 ${STATUS}"
echo
echo "下一步："
echo "  1. 填内容：vim docs/$REL"
echo "  2. 回填索引行的「工作内容 / 提交 / 备注」"
echo "  3. 校验：bash $TOOLNAME/check-daily-index.sh"
echo
echo "收尾两问（决定要不要沉淀知识）："
echo "  · 这次有没有「会重复踩 / 会被反复问」的可复用结论？"
echo "    有 → bash $TOOLNAME/new-knowledge.sh --flat <分类> <kebab-name> \"<结论>\" --source \"docs/$REL\""
echo "          （会自动从「来源日志里的代码标识符」挂召回规则；也可 --keywords \"tenantId,x\" 显式指定）"
echo "  · 只是一次性任务细节 → 不用沉淀，留在本篇日志即可"
