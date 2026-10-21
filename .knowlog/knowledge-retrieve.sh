#!/bin/bash
# knowledge-retrieve.sh — 关键词触发的知识召回（非全量，按 prompt + 暂存 diff 命中 .keyword-map.json）
#
# 目的：把「已被验证过的坑位/规范」在需要时精准送进上下文，而不是每次全量加载知识库。
# 全量检索（grep 整个 docs/）适合"找"，本脚本适合"防"——防你在写码时忘掉某条硬约束。
#
# 用法：
#   bash .knowlog/knowledge-retrieve.sh "用户 prompt 或代码片段"
#   git diff --cached | bash .knowlog/knowledge-retrieve.sh
#   bash .knowlog/knowledge-retrieve.sh --root /path/to/project "prompt"
set -euo pipefail

ROOT=""
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --root=*) ROOT="${1#--root=}"; shift ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
set -- ${ARGS[@]+"${ARGS[@]}"}

if [ -z "$ROOT" ]; then
  cur="$(pwd)"
  ROOT=""
  for _ in 1 2 3 4 5; do
    if [ -f "$cur/docs/knowledge/.keyword-map.json" ]; then ROOT="$cur"; break; fi
    cur="$(dirname "$cur")"
  done
  [ -n "$ROOT" ] || ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

QUERY="${1:-}"
if [ -z "$QUERY" ]; then QUERY="$(cat 2>/dev/null || true)"; fi
if [ -z "$QUERY" ]; then QUERY="$(git -C "$ROOT" diff --cached 2>/dev/null | head -n 200 || true)"; fi

export QR="$QUERY" ROOT
export MAP="$ROOT/docs/knowledge/.keyword-map.json"
python3 - <<'PY'
import json, os, pathlib, re, sys

mapp = pathlib.Path(os.environ["MAP"])
root = pathlib.Path(os.environ["ROOT"])
if not mapp.exists():
    sys.exit(0)
try:
    data = json.loads(mapp.read_text(encoding="utf-8"))
except Exception as e:
    print(f"keyword-map 读取失败：{e}", file=sys.stderr); sys.exit(0)

q = os.environ.get("QR", "")
if not q.strip():
    sys.exit(0)

hits = []
for pat, meta in data.items():
    if not isinstance(meta, dict):
        continue
    try:
        if re.search(pat, q, re.IGNORECASE | re.MULTILINE):
            hits.append((pat, meta))
    except re.error as e:
        print(f"正则错误 {pat}: {e}", file=sys.stderr)

if not hits:
    sys.exit(0)

print(f"<knowledge-retrieve> 命中 {len(hits)} 条规范/坑点（关键词触发，非全量；需要时再全量加载）")
for pat, meta in hits[:4]:
    print(f"- 关键词 `{pat}` → {meta.get('hint', '')}")
    for doc in meta.get("docs", [])[:2]:
        p = root / doc.split("#")[0]
        if p.exists():
            print(f"  · {doc}")
            try:
                lines = [l for l in p.read_text(encoding="utf-8").splitlines() if l.strip()][:6]
                for l in lines:
                    print(f"    {l[:120]}")
            except Exception:
                pass
        else:
            print(f"  · {doc} (not found)")
print("</knowledge-retrieve>")
PY
