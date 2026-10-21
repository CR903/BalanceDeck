#!/bin/bash
# new-keyword.sh — 往 .keyword-map.json 增加一条「关键词 → 提示 + 文档」的召回规则
#
# 什么时候加：某类问题「调试花超过 30 分钟」或「被反复问第二次」时，抽一条正则出来。
# 规则要能命中"写码当下"的表达（函数名、字段名、枚举值、报错关键词），而不是自然语言标题。
#
# 用法：
#   bash .knowlog/new-keyword.sh "<正则>" "<一句话提示>" "<文档路径[,文档2]>" [--root DIR]
# 例：
#   bash .knowlog/new-keyword.sh "tenantId|ShardingSphere" \
#     "分片：所有 GORM 查询必须带 tenantId，否则全库扫描" \
#     "docs/knowledge/backend/guides/database-guidelines.md"
set -euo pipefail

ROOT=""
PAT=""; HINT=""; DOCS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --root=*) ROOT="${1#--root=}"; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *)
      if [ -z "$PAT" ]; then PAT="$1"
      elif [ -z "$HINT" ]; then HINT="$1"
      elif [ -z "$DOCS" ]; then DOCS="$1"
      else echo "❌ 多余参数：$1" >&2; exit 2
      fi
      shift ;;
  esac
done

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

[ -n "$PAT" ] && [ -n "$HINT" ] && [ -n "$DOCS" ] || {
  echo "❌ 用法：bash .knowlog/new-keyword.sh \"<正则>\" \"<提示>\" \"<文档路径,文档2>\" [--root DIR]" >&2; exit 2; }

MAP="$ROOT/docs/knowledge/.keyword-map.json"
[ -f "$MAP" ] || { echo "❌ 未找到 ${MAP}（先跑 bootstrap-docs.sh）" >&2; exit 1; }

PAT="$PAT" HINT="$HINT" DOCS="$DOCS" MAP="$MAP" ROOT="$ROOT" python3 - <<'PY'
import json, os, pathlib, re, sys

mapp = pathlib.Path(os.environ["MAP"]); root = pathlib.Path(os.environ["ROOT"])
pat = os.environ["PAT"]; hint = os.environ["HINT"]
docs = [d.strip() for d in os.environ["DOCS"].split(",") if d.strip()]

try:
    data = json.loads(mapp.read_text(encoding="utf-8") or "{}")
except Exception as e:
    print(f"❌ .keyword-map.json 解析失败：{e}", file=sys.stderr); sys.exit(1)
if not isinstance(data, dict):
    print("❌ .keyword-map.json 顶层必须是对象", file=sys.stderr); sys.exit(1)

try:
    re.compile(pat)
except re.error as e:
    print(f"❌ 正则不合法：{e}", file=sys.stderr); sys.exit(1)

def normalize(d):
    """把「相对 docs/ 写」的路径归一化成「相对项目根」——避免召回里出现 (not found)。"""
    if (root / d.split("#")[0]).exists():
        return d
    alt = "docs/" + d
    if (root / alt.split("#")[0]).exists():
        return alt
    return d

docs = [normalize(d) for d in docs]
missing = [d for d in docs if not (root / d.split("#")[0]).exists()]
if missing:
    print(f"⚠️  以下文档暂不存在（仍会写入，但召回时显示 not found）：{', '.join(missing)}")

if pat in data:
    print(f"🔄 已存在同正则规则，替换其内容：{pat}")
data[pat] = {"docs": docs, "hint": hint}

mapp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"✅ 已写入召回规则（共 {len(data)} 条）：{pat}")
print(f"   提示：{hint}")
print(f"   文档：{', '.join(docs)}")
print("\n验证：")
print(f"  bash {os.environ.get('TOOLNAME', '.knowlog')}/knowledge-retrieve.sh \"{pat.split(chr(124))[0]}\"")
PY
