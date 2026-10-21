#!/bin/bash
# docs-doctor.sh — 文档体系体检总入口（结构 + 日志索引 + 知识索引）
#
# 三个 checker 的分工：
#   check-docs-structure.sh    → 结构规范（目录/脚本齐备、布局不变量、托管块、召回表、未采纳残留）
#   check-daily-index.sh       → 日志 ↔ 索引（双向一致 + 路径格式 + 三处月份）
#   check-knowledge-index.sh   → 知识 ↔ 索引（两级/flat 自适应）
#
# 为什么要有总入口：单跑一个 checker 绿灯不代表体系健康（结构跑偏时索引照样"一致"）。
# 体检的价值在于"一次跑完、给出可执行修复"，而不是让人记住三个脚本名。
#
# 用法：
#   bash .knowlog/docs-doctor.sh                 # 体检（有 ERROR → 退出码 1）
#   bash .knowlog/docs-doctor.sh --strict        # 告警也算失败（建议接 CI / pre-commit）
#   bash .knowlog/docs-doctor.sh --fix-hint      # 每个检查都带上可复制的修复命令
#   bash .knowlog/docs-doctor.sh --root DIR
set -uo pipefail

ROOT=""; STRICT=0; FIX=0; QUIET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --root=*) ROOT="${1#--root=}"; shift ;;
    --strict) STRICT=1; shift ;;
    --fix-hint) FIX=1; shift ;;
    --quiet) QUIET=1; shift ;;          # 只输出汇总（供 pre-commit 用）
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done
HERE="$(cd "$(dirname "$0")" && pwd)"
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

ARGS=(--root "$ROOT")
[ "$STRICT" -eq 1 ] && ARGS+=(--strict)
[ "$FIX" -eq 1 ] && ARGS+=(--fix-hint)

declare -a NAMES=("结构规范" "日志↔索引" "知识↔索引")
declare -a SCRIPTS=("check-docs-structure.sh" "check-daily-index.sh" "check-knowledge-index.sh")
FAILED=0; RESULTS=()

printf '\033[1m🩺 docs-doctor — 文档体系体检（%s）\033[0m\n' "$ROOT"
for i in 0 1 2; do
  s="$TOOL/${SCRIPTS[$i]}"
  if [ ! -f "$s" ]; then
    RESULTS+=("SKIP  ${NAMES[$i]}（缺 scripts/${SCRIPTS[$i]}）"); continue
  fi
  if [ "$QUIET" -eq 1 ]; then
    if bash "$s" "${ARGS[@]}" >"${TMPDIR:-/tmp}/docs-doctor-$$-$i.log" 2>&1; then
      RESULTS+=("PASS  ${NAMES[$i]}")
    else
      RESULTS+=("FAIL  ${NAMES[$i]}（详见 ${TMPDIR:-/tmp}/docs-doctor-$$-$i.log）"); FAILED=1
    fi
  else
    echo
    printf '\033[1m── %s ──\033[0m\n' "${NAMES[$i]}"
    if bash "$s" "${ARGS[@]}"; then
      RESULTS+=("PASS  ${NAMES[$i]}")
    else
      RESULTS+=("FAIL  ${NAMES[$i]}"); FAILED=1
    fi
  fi
done

echo
printf '\033[1m── 汇总 ──\033[0m\n'
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo
if [ "$FAILED" -eq 1 ]; then
  echo "❌ 体检未通过。上面每个失败项都给了修复建议；加 --fix-hint 看可复制命令。"
  echo "   常见修法速查（详见 references/maintenance.md）："
  echo "     · 结构/脚本缺失        → bash $TOOLNAME/bootstrap-docs.sh"
  echo "     · 日志散落/月份不符    → bash $TOOLNAME/check-daily-index.sh --fix-hint"
  echo "     · 知识未登记/死链      → bash $TOOLNAME/check-knowledge-index.sh --fix-hint"
  echo "     · 体系外的旧日志       → bash $TOOLNAME/adopt-docs.sh（先看计划，再 --apply）"
  echo
  echo "  📝 修完别漏一步：给这次修复记一笔 —— 「我修了什么、为什么」正是留给未来自己的信息。"
  echo "     bash $TOOLNAME/new-daily-log.sh fix-doc-drift   # slug 自取；索引行会自动插好"
  exit 1
fi
echo "✅ 体检通过：结构规范、日志与知识索引全部一致。"
