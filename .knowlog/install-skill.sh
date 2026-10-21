#!/bin/bash
# install-skill.sh — 把 knowlog **本体**装到各 agent 的 skill/规则位置（幂等、可版本对比）
#
# 与 install-recall.sh 的分工（两层，别混）：
#   ① 本体安装（本脚本）：让 agent *知道有这个 skill*（Claude/OpenCode 的 skills 目录、Cursor 的 rules…）
#   ② 项目内适配（install-recall.sh）：让**某个具体项目**的召回/约束落到 agent 的钩子/插件/规则文件
#
# 各 agent 的事实（本机实测，不猜）：
#   · Claude Code  → `~/.claude/skills/<name>/SKILL.md`（user）或 `<repo>/.claude/skills/<name>/`（project）
#   · OpenCode     → `~/.config/opencode/skills/<name>/SKILL.md`（user）或 `<repo>/.opencode/skills/<name>/`
#                    （本机 ~/.config/opencode/skills 下已有一批 skill，格式与 Claude 相同）
#   · Codex        → **没有 skill 目录**（`codex plugin` 是 marketplace 插件；子代理在 ~/.codex/agents/*.toml）
#                    → 项目级落地走 AGENTS.md 托管块 + UserPromptSubmit 钩子（install-recall.sh --agent codex）
#   · Cursor       → 没有 skill 概念 → 项目级 `.cursor/rules/knowlog.mdc`
#   · Gemini CLI   → 项目级 `GEMINI.md` 指针块
#   · Copilot      → 项目级 `.github/copilot-instructions.md` 指针块
#   · DSH          → 插件 = pnpm 包 + cordis patch 层（需打包，本脚本只给落地指引，不假装能装）
#   · 其它 agent   → 项目级：AGENTS.md 托管块 + scripts/ 脚本（最通用、且与有钩子的同源）
#
# 用法：
#   bash .knowlog/install-skill.sh --list                 # 列出各 agent 的目标位置与已装版本
#   bash .knowlog/install-skill.sh --agent auto           # 本机检测到的 agent 全装（user scope）
#   bash .knowlog/install-skill.sh --agent claude,opencode
#   bash .knowlog/install-skill.sh --agent claude --scope project --root /path/to/repo
#   bash .knowlog/install-skill.sh --check                # 只对比"已装版本 vs 当前版本"
#   bash .knowlog/install-skill.sh --agent claude --dry-run
set -euo pipefail

# 环境变量归一化：KNOWLOG_HOME 为准，兼容旧的 DOCS_SYSTEM_HOME
KNOWLOG_HOME="${KNOWLOG_HOME:-${DOCS_SYSTEM_HOME:-}}"
AGENTS=""; SCOPE="user"; MODE="auto"; DRY=0; LIST=0; CHECK=0; ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --agent) AGENTS="${2:-}"; shift 2 ;;
    --agent=*) AGENTS="${1#--agent=}"; shift ;;
    --scope) SCOPE="${2:-}"; shift 2 ;;
    --scope=*) SCOPE="${1#--scope=}"; shift ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --mode=*) MODE="${1#--mode=}"; shift ;;
    --root) ROOT="${2:-}"; shift 2 ;;
    --root=*) ROOT="${1#--root=}"; shift ;;
    --dry-run) DRY=1; shift ;;
    --list) LIST=1; shift ;;
    --check) CHECK=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done
case "$MODE" in auto|copy|link|skills) ;; *) echo "❌ --mode 只能是 auto / copy / link / skills" >&2; exit 2 ;; esac
# user 范围默认走"单一权威副本 + 软链"（若本机有 ~/.agents/skills —— 那是这台机器的 skill 仓库，
# 既有 129 个 skill 都是这个形态）；项目范围默认真复制（可提交、可移植）。
AGENTS_REPO="$HOME/.agents/skills"
if [ "$MODE" = "auto" ]; then
  if [ "$SCOPE" = "user" ] && [ -d "$AGENTS_REPO" ]; then MODE="link"; else MODE="copy"; fi
fi
if [ "$MODE" = "link" ]; then
  if [ -z "${AGENTS_REPO:-}" ] || [ ! -d "$AGENTS_REPO" ]; then
    if [ "$SCOPE" = "user" ] && [ ! -d "$AGENTS_REPO" ]; then
      echo "ℹ️  没找到 $AGENTS_REPO —— 退回 copy 模式（本机没有共享 skill 仓库）"
    fi
    MODE="copy"
  fi
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
# 源目录解析：① skill 目录里跑 ② KNOWLOG_HOME 指定 ③ 已安装的全局副本（用于升级）
SKILL_DIR=""
for cand in "${KNOWLOG_HOME:-}" "$(cd "$HERE/.." && pwd)" \
            "$HOME/.claude/skills/knowlog" "$HOME/.config/opencode/skills/knowlog"; do
  if [ -n "$cand" ] && [ -f "$cand/SKILL.md" ]; then SKILL_DIR="$cand"; break; fi
done
if [ -z "$SKILL_DIR" ]; then
  # --list / --check 只是"查看安装位置与版本"，即使当前目录拿不到 payload 也应该能跑
  if [ "${LIST:-0}" -eq 1 ] || [ "${CHECK:-0}" -eq 1 ]; then
    echo "⚠️  当前目录拿不到 skill 源（缺 SKILL.md）；下面仅列出位置，版本对比会显示「来自未知源」" >&2
    SKILL_DIR="(unknown)"
    VERSION="?"
  else
  echo "❌ 找不到 skill 源（缺 SKILL.md）。三选一：" >&2
  echo "   ① 在 skill 目录里跑本脚本；② 用 KNOWLOG_HOME=<skill 目录> bash .knowlog/install-skill.sh …；" >&2
  echo "   ③ 先装一份到 ~/.claude/skills/knowlog/ 再用它升级其它 agent。" >&2
  echo "   （项目里只需要'项目级适配'时，用 bash .knowlog/install-recall.sh --agent auto）" >&2
  exit 1
  fi
fi
VERSION="$(cat "$SKILL_DIR/VERSION" 2>/dev/null || echo "0.0.0")"
NAME="$(basename "$SKILL_DIR")"      # 权威副本目录名 / 安装元数据里的 skill 名


if [ -z "$ROOT" ]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$ROOT" ] || ROOT="$(pwd)"
fi

# 项目内工具目录：.knowlog（新）优先，兼容旧 scripts/
TOOL="$ROOT/.knowlog"
if [ ! -d "$TOOL" ] && [ -f "$ROOT/.knowlog/bootstrap-docs.sh" ]; then TOOL="$ROOT/scripts"; fi
TOOLNAME="${TOOL#"$ROOT"/}"

# ---- 检测本机有哪些 agent（与 install-recall 同口径） ----
DETECTED=()
if [ -d "$HOME/.claude" ] || command -v claude >/dev/null 2>&1; then DETECTED+=(claude); fi
if [ -d "$HOME/.config/opencode" ] || command -v opencode >/dev/null 2>&1; then DETECTED+=(opencode); fi
if [ -d "$HOME/.codex" ] || command -v codex >/dev/null 2>&1; then DETECTED+=(codex); fi
if [ -d "$HOME/.cursor" ] || [ -d "$ROOT/.cursor" ]; then DETECTED+=(cursor); fi
if [ -d "$HOME/.gemini" ] || command -v gemini >/dev/null 2>&1; then DETECTED+=(gemini); fi
if [ -d "$ROOT/.github" ] || command -v gh >/dev/null 2>&1; then DETECTED+=(copilot); fi
if [ -d "$HOME/.dsh" ] || command -v dsh >/dev/null 2>&1; then DETECTED+=(dsh); fi

targets_for() {   # 输出 "<agent>|<target dir or file>|<kind:dir|rules|pointer|guidance>"
  local a="$1"
  case "$a" in
    claude)   if [ "$SCOPE" = "project" ]; then echo "claude|$ROOT/.claude/skills/knowlog|dir"
              else echo "claude|$HOME/.claude/skills/knowlog|dir"; fi ;;
    opencode) if [ "$SCOPE" = "project" ]; then echo "opencode|$ROOT/.opencode/skills/knowlog|dir"
              else echo "opencode|$HOME/.config/opencode/skills/knowlog|dir"; fi ;;
    codex)    echo "codex|$ROOT/AGENTS.md + $ROOT/.codex/hooks.json|project-adapter" ;;
    cursor)   echo "cursor|$ROOT/.cursor/rules/knowlog.mdc|file" ;;
    gemini)   echo "gemini|$ROOT/GEMINI.md|pointer" ;;
    copilot)  echo "copilot|$ROOT/.github/copilot-instructions.md|pointer" ;;
    dsh)      echo "dsh|$ROOT/.dsh/docs-recall.patch.yml + $ROOT/.dsh/bridge/|project-adapter" ;;
    *)        echo "$a|$ROOT/AGENTS.md + $ROOT/.knowlog/|project-adapter" ;;
  esac
}

installed_version() {   # $1=目标目录
  local d="$1"
  [ -f "$d/VERSION" ] && cat "$d/VERSION" && return
  # 新文件名优先，兼容 rename 之前留下的旧名
  for meta in "$d/.knowlog-install.json" "$d/.docs-system-install.json"; do
    [ -f "$meta" ] && python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('version','?'))" "$meta" 2>/dev/null && return
  done
  echo "?"
}

if [ "$LIST" -eq 1 ] || [ "$CHECK" -eq 1 ]; then
  echo "📦 knowlog 安装位置（当前版本 ${VERSION}）"
  echo "   本机检测到：${DETECTED[*]:-（无）}"
  if [ -n "${AGENTS_REPO:-}" ] && [ -d "${AGENTS_REPO}" ]; then
    echo "   共享 skill 仓库：${AGENTS_REPO}（存在 → user 范围默认 --mode link：单一权威副本 + 软链）"
  else
    echo "   共享 skill 仓库：${AGENTS_REPO:-~/\.agents/skills}（不存在 → user 范围默认 --mode copy：各 agent 各存一份）"
  fi
  if [ -n "${AGENTS_REPO:-}" ] && [ -f "$AGENTS_REPO/.skill-lock.json" ]; then
    echo "   检测到 skills CLI 的 lock（vercel-labs/skills）→ 想让它接管安装/升级可用：--mode skills"
  fi
  echo
  printf '   %-10s %-8s %-46s %s\n' "AGENT" "形态" "位置" "已装版本"
  for a in claude opencode codex cursor gemini copilot dsh; do
    IFS='|' read -r ag tgt kind <<<"$(SCOPE=user targets_for "$a")"
    v="—"
    if [ "$kind" = "dir" ]; then
      v="$(installed_version "${tgt}")"; [ "$v" = "?" ] && v="未安装"
    else
      [ -e "${tgt}" ] && v="（项目级适配，看 install-recall.sh）"
    fi
    printf '   %-10s %-8s %-46s %s\n' "$ag" "$kind" "${tgt/#$HOME/~}" "$v"
  done
  echo
  if [ "$CHECK" -eq 1 ]; then
    echo "   版本对比："
    for a in claude opencode; do
      IFS='|' read -r ag tgt kind <<<"$(SCOPE=user targets_for "$a")"
      v="$(installed_version "${tgt}")"
      if [ "$v" = "未安装" ]; then echo "     - ${a}：未安装 → bash .knowlog/install-skill.sh --agent $a"
      elif [ "$v" = "$VERSION" ]; then echo "     - ${a}：${v}（最新）"
      else echo "     - ${a}：$v → 可升级到 ${VERSION}：bash .knowlog/install-skill.sh --agent $a"; fi
    done
  fi
  exit 0
fi

if [ -z "$AGENTS" ] || [ "$AGENTS" = "auto" ]; then
  AGENTS="${DETECTED[*]:-generic}"
fi
AGENTS="$(printf '%s' "$AGENTS" | tr ',' ' ')"

if [ "$MODE" = "skills" ]; then
  echo "📦 交给本机 skills CLI 安装（vercel-labs/skills）：它会装到 ~/.agents/skills/ 并给各 agent 建软链、写 lock"
  if [ "$DRY" -eq 1 ]; then
    echo "   + npx -y skills@latest add $SKILL_DIR -g -y"
    exit 0
  fi
  if npx -y skills@latest add "$SKILL_DIR" -g -y; then
    echo "✅ 已由 skills CLI 安装；升级用：npx -y skills@latest update knowlog"
    exit 0
  fi
  echo "⚠️  skills CLI 安装失败（离线？）→ 退回 --mode link"
  MODE="link"
fi

echo "📦 安装 knowlog v$VERSION"
echo "   来源：$SKILL_DIR"
echo "   范围：$SCOPE · 目标项目：$ROOT"
[ "$DRY" -eq 1 ] && echo "   ⚠️  --dry-run：只打印计划"
echo

# 复制"运行所需"内容到目标目录（SKILL.md + VERSION + .knowlog/adapters/assets/references；不含 evals/）
copy_payload() {
  local dst="$1"
  mkdir -p "$dst"
  local item
  for item in SKILL.md VERSION package.json bin scripts adapters assets references; do
    [ -e "$SKILL_DIR/$item" ] || continue
    rm -rf "$dst/$item"
    cp -R "$SKILL_DIR/$item" "$dst/$item"
  done
  cat > "$dst/.knowlog-install.json" <<JSON
{
  "skill": "$NAME",
  "version": "$VERSION",
  "agent": "$AGENT_FOR_META",
  "scope": "$SCOPE",
  "mode": "$MODE",
  "source": "$SKILL_DIR",
  "installed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
}

INSTALLED=(); CANON_DONE=0
for a in $AGENTS; do
  IFS='|' read -r ag tgt kind <<<"$(targets_for "$a")"
  AGENT_FOR_META="$ag"
  case "$kind" in
    dir)
      if [ "$DRY" -eq 1 ]; then
        if [ "$MODE" = "link" ]; then echo "   + [$ag] 软链 → ${tgt/#$HOME/~} ⇒ $AGENTS_REPO/$NAME"
        else echo "   + [$ag] 复制 → ${tgt/#$HOME/~}"; fi
        INSTALLED+=("$ag"); continue
      fi
      if [ "$MODE" = "link" ]; then
        CANON="$AGENTS_REPO/$NAME"
        if [ "$CANON_DONE" -eq 0 ]; then
          rm -rf "$CANON"; copy_payload "$CANON"; CANON_DONE=1
          echo "   ✅ 权威副本 → ${CANON/#$HOME/~}（v${VERSION}）"
        fi
        rm -rf "$tgt"; mkdir -p "$(dirname "$tgt")"; ln -s "$CANON" "$tgt"
        echo "   ✅ [$ag] 软链 → ${tgt/#$HOME/~} ⇒ ${CANON/#$HOME/~}"
      else
        copy_payload "$tgt"
        echo "   ✅ [$ag] 已安装（真复制） → ${tgt/#$HOME/~}（v${VERSION}）"
      fi
      INSTALLED+=("$ag")
      ;;
    file)
      if [ "$DRY" -eq 1 ]; then echo "   + [$ag] 写规则文件 → ${tgt}"; continue; fi
      mkdir -p "$(dirname "${tgt}")"
      cp "$SKILL_DIR/adapters/cursor/knowlog.mdc" "${tgt}"
      echo "   ✅ [$ag] 已写规则文件 → ${tgt/#$ROOT/<repo>}（Cursor 无 skill 概念，退化为规则文件+脚本）"
      INSTALLED+=("$ag")
      ;;
    pointer|project-adapter)
      _proj_tool="$ROOT/.knowlog"; [ -d "$_proj_tool" ] || _proj_tool="$ROOT/scripts"
      if [ -x "$_proj_tool/install-recall.sh" ] && [ "$DRY" -eq 0 ]; then
        echo "   → [$ag] 交给项目内适配器（install-recall.sh --agent ${ag}）"
        bash "$_proj_tool/install-recall.sh" --root "$ROOT" --agent "$ag" || true
        INSTALLED+=("$ag")
      else
        echo "   ℹ️  [$ag] 需要在项目里跑：bash .knowlog/install-recall.sh --agent $ag"
        if [ "$ag" = "codex" ]; then
          echo "        （Codex 没有 skill 目录；项目级落地 = AGENTS.md 托管块 + .codex/hooks.json，"
          echo "          且钩子需你在交互式会话里**一次性信任**后才会执行）"
        fi
        if [ "$ag" = "dsh" ]; then
          echo "        （DSH 每轮注入 = agent/pre-step waterfall 插件；桥接包已落到 .dsh/bridge/，"
          echo "          免安装。先 dry-run：dsh --profile web --patch .dsh/docs-recall.patch.yml --dump-config"
          echo "          要真生效需你自己把 insert 段并进 \$DSH_HOME/profiles/<profile>/cordis.patch.yml"
          echo "          —— 或改用命令行兜底：bash .knowlog/knowledge-retrieve.sh \"<prompt>\"）"
        fi
      fi
      ;;
  esac
done

echo
if [ ${#INSTALLED[@]} -gt 0 ]; then
  echo "已处理：${INSTALLED[*]}"
fi
echo "用法："
echo "  · Claude / OpenCode：新开会话后说「帮我把这个项目的文档体系建起来」即可触发（skill 按描述自动加载）"
echo "  · 项目级落地（日志/知识/门禁/召回）：cd <项目> && npx knowlog init --agent auto"
echo "  · 体检：bash .knowlog/docs-doctor.sh --fix-hint"
echo "  · 版本对比：bash .knowlog/install-skill.sh --check"
