#!/bin/bash
# check-secrets.sh — 提交/推送前扫一遍：密钥、令牌、私钥、以及"不是密钥但会泄露内部信息"的东西
#
# 为什么要有它：泄露一旦进了 git 历史就很难收回（要 rewrite history + 通知所有协作者）。
# 所以把"扫一遍"从"人记得做"变成"钩子必做"。
#
# 用法：
#   bash .knowlog/check-secrets.sh                 # 扫工作区（排除 .git/）
#   bash .knowlog/check-secrets.sh --staged        # 只扫暂存区（pre-commit 用，最快）
#   bash .knowlog/check-secrets.sh --root DIR
# 退出码：0 干净；1 命中（打印命中行，便于定位）
set -uo pipefail

MODE="worktree"; ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --staged) MODE="staged" ;;
    --root) ROOT="${2:-}"; shift ;;
    --root=*) ROOT="${1#--root=}" ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$ROOT" ] || ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT" || exit 1

# 高危模式：真密钥形态
SECRET_RE='(sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{15,}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})'
# 疑似赋值：key/secret/token/password = "一串"（排除明显占位与示例）
ASSIGN_RE='(api[_-]?key|apikey|secret|passwd|password|token|credential|private[_-]?key)[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"']{16,}'
PLACEHOLDER_RE='(example|sample|placeholder|your[_-]|xxx|\.\.\.|<[^>]+>|changeme|dummy|test-key|abc123|\*\*\*|\$\{|\$[A-Z_]+)'
# 内部信息：个人绝对路径 / 内网地址 / 私有域
INTERNAL_RE='(/Users/[A-Za-z0-9._-]+/|/home/[A-Za-z0-9._-]+/|https?://(10|192\.168|172\.(1[6-9]|2[0-9]|3[01]))[0-9.]*|[a-z0-9.-]+\.(internal|corp|lan)\b)'

FAIL=0
scan() {                       # $1=标签 $2=正则 $3=额外过滤（排除正则）
  local label="$1" re="$2" excl="${3:-}" hits
  if [ "$MODE" = "staged" ]; then
    hits=$(git diff --cached -U0 | grep -E '^\+' | grep -vE '^\+\+\+' | grep -nE "$re" || true)
  else
    hits=$(grep -rInE "$re" . 2>/dev/null | grep -v '^\./\.git/' || true)
  fi
  [ -n "$excl" ] && hits=$(printf '%s\n' "$hits" | grep -ivE "$excl" || true)   # 占位符判定放宽大小写
  hits=$(printf '%s\n' "$hits" | grep -v '^$' || true)
  if [ -n "$hits" ]; then
    echo "❌ $label —— 命中 $(printf '%s\n' "$hits" | wc -l | tr -d ' ') 处："
    printf '%s\n' "$hits" | head -10 | sed 's/^/   /'
    FAIL=1
  fi
}

echo "🔍 check-secrets（模式：$MODE · 根：${ROOT}）"
scan "高危密钥/令牌/私钥" "$SECRET_RE"
scan "疑似赋值型密钥" "$ASSIGN_RE" "$PLACEHOLDER_RE"
scan "个人绝对路径 / 内网地址 / 私有域（不是密钥，但会泄露内部信息）" "$INTERNAL_RE" \
     "(~/\.agents|~/\.claude|~/\.config)"   # 只放行文档里 ~ 举例的写法；真实个人绝对路径仍会被拦

if [ "$FAIL" -eq 1 ]; then
  echo
  echo "❌ 扫描未通过：先移除/改为占位（如 \${ENV_VAR}）再提交。"
  echo "   确属误报可临时跳过：SKIP_SECRET_SCAN=1 git commit ...（请谨慎）"
  exit 1
fi
echo "✅ 干净：未发现密钥/令牌/私钥，也未发现个人路径或内网地址。"
