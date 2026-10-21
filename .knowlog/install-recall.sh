#!/bin/bash
# install-recall.sh — 把「关键词召回」按各 agent 的机制装到项目里
#
# 为什么需要它：每家 agent 的注入机制完全不同（Claude Code / Codex 是 UserPromptSubmit 钩子、
# OpenCode 是 TS 插件、DSH 是 cordis patch 层、Cursor/Gemini/Copilot 只有静态规则文件，
# 还有大量 agent 什么机制都没有）。本脚本把它们统一到**同一个召回核心**（.knowlog/recall-core.py），
# 适配器只负责"怎么送进上下文"。
#
# 用法：
#   bash .knowlog/install-recall.sh --list                     # 看本机有哪些 agent、各自会写什么
#   bash .knowlog/install-recall.sh --agent auto               # 按检测到的 agent 全部装（幂等）
#   bash .knowlog/install-recall.sh --agent claude,codex,opencode
#   bash .knowlog/install-recall.sh --agent generic            # 无机制的 agent：指针文件 + 命令行兜底
#   bash .knowlog/install-recall.sh --agent auto --dry-run
#   bash .knowlog/install-recall.sh --agent auto --verify      # 装完喂一条假 prompt 自测
set -euo pipefail

# 环境变量归一化：KNOWLOG_HOME 为准，兼容旧的 DOCS_SYSTEM_HOME
KNOWLOG_HOME="${KNOWLOG_HOME:-${DOCS_SYSTEM_HOME:-}}"
ROOT=""; AGENTS=""; DRY=0; VERIFY=0; LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --root=*) ROOT="${1#--root=}"; shift ;;
    --agent) AGENTS="${2:-}"; shift 2 ;;
    --agent=*) AGENTS="${1#--agent=}"; shift ;;
    --dry-run) DRY=1; shift ;;
    --verify) VERIFY=1; shift ;;
    --list) LIST=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
# adapters 定位：项目内自包含副本 .knowlog/adapters/ → 同目录 → skill 原始位置
AD=""
for cand in "$HERE/adapters" "$(cd "$HERE/.." && pwd)/.knowlog/adapters" "$(cd "$HERE/.." && pwd)/adapters" "${KNOWLOG_HOME:-}/adapters"; do
  if [ -n "$cand" ] && [ -d "$cand" ]; then AD="$cand"; break; fi
done
[ -n "$AD" ] || { echo "❌ 找不到 adapters 目录（可在 skill 目录运行，或设 KNOWLOG_HOME=<skill 目录>）" >&2; exit 1; }
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

# ---------- 检测 ----------
detect() {
  # 注意：本函数在 set -e 下运行，**不能**以 `[ ... ] && cmd` 结尾
  #（bash 3.2 会把函数返回码变成 1，进而让整个脚本静默退出）
  DETECTED=()
  if [ -d "$ROOT/.claude" ] || [ -d "$HOME/.claude" ] || command -v claude >/dev/null 2>&1; then DETECTED+=(claude); fi
  if [ -d "$ROOT/.codex" ] || [ -d "$HOME/.codex" ] || command -v codex >/dev/null 2>&1; then DETECTED+=(codex); fi
  if [ -d "$ROOT/.opencode" ] || [ -d "$HOME/.config/opencode" ] || command -v opencode >/dev/null 2>&1; then DETECTED+=(opencode); fi
  if [ -d "$ROOT/.dsh" ] || [ -d "$HOME/.dsh" ] || command -v dsh >/dev/null 2>&1; then DETECTED+=(dsh); fi
  if [ -d "$ROOT/.cursor" ] || [ -d "$HOME/.cursor" ]; then DETECTED+=(cursor); fi
  if [ -f "$ROOT/GEMINI.md" ] || [ -d "$ROOT/.gemini" ] || [ -d "$HOME/.gemini" ] || command -v gemini >/dev/null 2>&1; then DETECTED+=(gemini); fi
  if [ -d "$ROOT/.github" ]; then DETECTED+=(copilot); fi
  return 0
}

describe() {
  case "$1" in
    claude)   echo "Claude Code      → UserPromptSubmit 命令钩子（.claude/settings.json + .claude/hooks/docs-recall.py）" ;;
    codex)    echo "Codex CLI        → .codex/hooks.json 的 UserPromptSubmit（与 Claude 同形契约）" ;;
    opencode) echo "OpenCode ≥ v2    → .opencode/plugins/docs-recall.ts（chat.message 钩子自动加载）" ;;
    dsh)      echo "DeepSeek Harness → agent/pre-step 插件（.dsh/docs-recall.patch.yml + .dsh/bridge/，免安装）" ;;
    cursor)   echo "Cursor           → .cursor/rules/knowlog.mdc（alwaysApply）" ;;
    gemini)   echo "Gemini CLI       → GEMINI.md 指针块" ;;
    copilot)  echo "GitHub Copilot   → .github/copilot-instructions.md 指针块" ;;
    generic)  echo "其它 agent       → docs/agents/recall.md 指针 + bash $TOOLNAME/knowledge-retrieve.sh 兜底" ;;
  esac
}

detect
if [ "$LIST" -eq 1 ]; then
  echo "📋 本机检测结果（项目：${ROOT}）"
  echo "   已检测到：${DETECTED[*]:-（无）}"
  echo
  for a in claude codex opencode dsh cursor gemini copilot generic; do
    printf '   %s\n' "$(describe "$a")"
  done
  echo
  echo "   建议：bash $TOOLNAME/install-recall.sh --agent auto"
  exit 0
fi

if [ -z "$AGENTS" ] || [ "$AGENTS" = "auto" ]; then
  AGENTS="$(printf '%s\n' "${DETECTED[*]:-} generic" | tr ' ' ',' )"
fi
AGENTS="$(printf '%s' "$AGENTS" | tr ',' ' ')"

KMAP="$ROOT/docs/knowledge/.keyword-map.json"
if [ ! -f "$KMAP" ]; then
  echo "❌ 还没装文档体系（缺 ${KMAP}）。先跑：npx knowlog init（或 bash $TOOLNAME/bootstrap-docs.sh）" >&2
  exit 1
fi
REAL_RULES=$(python3 - "$KMAP" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    d = {}
print(sum(1 for k, v in d.items() if isinstance(v, dict) and not k.startswith("_")))
PY
)
if [ "$REAL_RULES" -eq 0 ]; then
  echo "⚠️  召回表里还没有真实规则（只有占位）→ 装了也不会命中。加第一条：bash $TOOLNAME/new-keyword.sh \"<正则>\" \"<提示>\" \"<文档>\""
fi

ROOT="$ROOT" AGENTS="$AGENTS" AD="$AD" DRY="$DRY" TOOLNAME="$TOOLNAME" python3 - <<'PY'
import json, os, pathlib, re, shutil, stat, sys

root = pathlib.Path(os.environ["ROOT"]); ad = pathlib.Path(os.environ["AD"])
agents = os.environ["AGENTS"].split(); dry = os.environ["DRY"] == "1"
MARK_START = "<!-- KNOWLOG:START"      # 前缀匹配：说明文字变了也认得
MARK_RE = r"<!--\s*KNOWLOG:START[^\n]*-->.*?<!--\s*KNOWLOG:END[^\n]*-->"
LEGACY_START = "<!-- " + "DOCS" + "-SYSTEM:START"
MARK_END = "<!-- KNOWLOG:END -->"
done, skipped, notes = [], [], []


TOOLNAME = os.environ.get("TOOLNAME", ".knowlog")


def projectize(text: str) -> str:
    """把适配器文本里的项目级 scripts/ 引用改成实际工具目录（team 目录名可能是旧 scripts/）。"""
    if TOOLNAME == "scripts":
        return text
    # 旧目录名用变量拼出来：bootstrap 复制到项目时会把字面量 "scripts/" 改写成新目录，
    # 如果这里写字面量，函数自身的匹配模式会被改坏（自我指涉，真踩过）。
    legacy = "scripts"
    for pat in ("bash " + legacy + "/", "`" + legacy + "/", '"' + legacy + "/", "'" + legacy + "/",
                legacy + "/recall-core.py", legacy + "/knowledge-retrieve.sh", legacy + "/index-util.py"):
        text = text.replace(pat, pat.replace(legacy + "/", TOOLNAME + "/"))
    return text


def put(rel: str, content: str, exec_bit=False):
    content = projectize(content)
    p = root / rel
    if p.exists() and p.read_text(encoding="utf-8", errors="ignore") == content:
        skipped.append(rel); return
    if dry:
        done.append(rel + ("（已存在→覆盖）" if p.exists() else "")); return
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    if exec_bit:
        p.chmod(p.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    done.append(rel)


def put_from(src: pathlib.Path, rel: str, exec_bit=False):
    if src.name.startswith("._"):
        return                      # AppleDouble 影子文件：跳过（不是真文件）
    try:
        text = src.read_text(encoding="utf-8")
    except UnicodeDecodeError as e:
        notes.append(f"⚠️ 跳过非 UTF-8 源文件 {src}（{e}）—— 若是 ._ 影子文件可忽略")
        return
    put(rel, text, exec_bit)


def put_tree(src: pathlib.Path, rel: str):
    """把一个小目录整棵复制进项目（用于 .dsh/bridge 这类要能直接 import 的插件包）。"""
    if not src.is_dir():
        notes.append(f"⚠️ 缺少 {src} → 跳过 {rel}"); return
    for f in sorted(src.rglob("*")):
        # 跳过 macOS 在 exFAT/网络卷上生成的 AppleDouble 影子文件（二进制，按 UTF-8 读会崩）
        if f.is_dir() or f.name == ".DS_Store" or f.name.startswith("._"):
            continue
        put_from(f, str(pathlib.Path(rel) / f.relative_to(src)), exec_bit=f.suffix == ".mjs")


def put_block(rel: str, block: str):
    """把指针块写进文件（有标记则替换块内，没有则追加）——保证不会写第二份规则"""
    p = root / rel; block = projectize(block.rstrip("\n") + "\n")
    if p.exists():
        old = p.read_text(encoding="utf-8")
        # 新旧标记并存（老项目升级）→ 先删掉旧标记块，避免同一文件里两份指针
        if LEGACY_START in old and MARK_START in old:
            old = re.sub(re.escape(LEGACY_START) + r"[^\n]*" + r".*?" + re.escape(MARK_END),
                         "", old, flags=re.S).strip() + "\n"
            if not dry:
                p.write_text(old, encoding="utf-8")
        if LEGACY_START in old and MARK_END in old and MARK_START not in old:
            # 旧标记的指针块：整块替换成新版（兼容老项目）
            new_old = re.sub(re.escape(LEGACY_START) + r"[^\n]*" + r".*?" + re.escape(MARK_END),
                             lambda _: block.strip(), old, flags=re.S)
            if not dry:
                p.write_text(new_old, encoding="utf-8")
            done.append(rel + "（指针块标记已迁移）"); return
        if MARK_START in old and MARK_END in old:
            new = re.sub(MARK_RE, lambda _: block.strip(), old, flags=re.S)
            if new == old:
                skipped.append(rel + "（指针块已最新）"); return
            if not dry:
                p.write_text(new, encoding="utf-8")
            done.append(rel + "（刷新指针块）"); return
        if not dry:
            p.write_text(old.rstrip("\n") + "\n\n" + block, encoding="utf-8")
        done.append(rel + "（追加指针块）"); return
    if not dry:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(block, encoding="utf-8")
    done.append(rel + "（新建）")


def merge_opencode_instructions(rel: str, entry: str):
    """把指针文件加进 opencode.json 的 instructions 数组（幂等；保留其它键）"""
    p = root / rel
    cfg = {}
    if p.exists():
        try:
            cfg = json.loads(p.read_text(encoding="utf-8") or "{}")
        except Exception:
            notes.append(f"⚠️ {rel} 解析失败 → 跳过（请手工把 {entry} 加进 instructions）"); return
    arr = cfg.setdefault("instructions", [])
    if entry in arr:
        skipped.append(rel + "（instructions 已含该条）"); return
    arr.append(entry)
    if not dry:
        p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    done.append(rel + "（instructions 注入已注册）")


def merge_hook_json(rel: str, cmd: str, timeout: int = 10):
    """把 Hook 注册合并进 settings.json / hooks.json（保持原有内容）"""
    p = root / rel
    cfg = {}
    if p.exists():
        try:
            cfg = json.loads(p.read_text(encoding="utf-8") or "{}")
        except Exception:
            notes.append(f"⚠️ {rel} 解析失败 → 跳过注册（请手工加 UserPromptSubmit 钩子: {cmd}）"); return
    hooks = cfg.setdefault("hooks", {})
    ups = hooks.setdefault("UserPromptSubmit", [])
    if any(cmd in json.dumps(e) for e in ups):
        skipped.append(rel + "（钩子已注册）"); return
    ups.append({"hooks": [{"type": "command", "command": cmd, "timeout": timeout}]})
    if not dry:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    done.append(rel + "（注册 UserPromptSubmit 钩子）")


shim = ad / "hook-shim.py"
pointer = projectize((ad / "static" / "pointer.block.md").read_text(encoding="utf-8"))

for a in agents:
    if a == "claude":
        put_from(shim, ".claude/hooks/docs-recall.py", exec_bit=True)
        merge_hook_json(".claude/settings.json", "python3 .claude/hooks/docs-recall.py", 10)
    elif a == "codex":
        put_from(shim, ".codex/hooks/docs-recall.py", exec_bit=True)
        merge_hook_json(".codex/hooks.json", "python3 .codex/hooks/docs-recall.py", 10)
        notes.append("Codex 项目钩子需要**一次性人工信任**才会执行：在该项目里开一次交互式 codex 并批准该钩子"
                     "（写入 ~/.codex/config.toml 的 hooks.state.<hooks.json>:user_prompt_submit 的 trusted_hash）；"
                     "未信任时钩子不跑、也无报错（已实测）。信任必须由人批准 —— 脚本不会替你写，避免绕过安全模型。")
    elif a == "opencode":
        # v2（当前主流）：项目 opencode.json 的 instructions 字段每会话注入 —— 本机实测生效
        put_from(ad / "opencode" / "recall-instructions.md", "docs/agents/recall-instructions.md")
        merge_opencode_instructions("opencode.json", "./docs/agents/recall-instructions.md")
        # v1 才支持每轮关键词注入的插件钩子；v2 装了也不会被调用（静默失效），故仅在显式要求时安装
        if os.environ.get("DOCS_RECALL_OPENCODE_V1_PLUGIN") == "1":
            put_from(ad / "opencode" / "docs-recall.ts", ".opencode/plugins/docs-recall.ts")
        else:
            notes.append("OpenCode v2：已用 opencode.json 的 instructions 注入（每会话必读）；"
                         "若要每轮关键词召回，需 v1 插件 API —— 设 DOCS_RECALL_OPENCODE_V1_PLUGIN=1 再跑一次")
    elif a == "dsh":
        put_from(ad / "dsh" / "README.md", ".dsh/docs-recall-README.md")
        # 桥接插件整包落地：patch 里写 `name: ./bridge/lib/index.js` 即可免 pnpm 安装直接加载
        # （DSH 会把相对 name 锚成 file://…；必须以**入口文件**结尾，目录导入 ESM 不支持 —— verify.sh V5）
        put_tree(ad / "dsh" / "bridge", ".dsh/bridge")
        # 项目内 patch 用免安装路线（与其它 agent 适配器一样：只动项目、不装全局包）
        put(".dsh/docs-recall.patch.yml", """\
# docs-recall-dsh 的项目内 patch 层 —— 每轮把 knowlog 召回结果注入 DSH 上下文。
#
# 免安装路线：name 写相对本文件的**入口文件** ./bridge/lib/index.js，
# DSH 会锚成 file://…/.dsh/bridge/lib/index.js —— 不需要 `dsh plugin add`，也不动 ~/.dsh。
# ⚠️ 必须指到**文件**而不是目录：Node ESM 不支持目录导入（ERR_UNSUPPORTED_DIR_IMPORT），
#    指目录会让插件静默加载失败（真机踩过）。走 bundle 安装（dsh plugin add）时才用裸包名。
#
# 验证（只读、dry-run，不会 boot、不会改配置）：
#   dsh --profile web --patch .dsh/docs-recall.patch.yml --dump-config | grep -A6 docs-recall
# 固化到某个 profile（这一步只改你自己的 ~/.dsh，按需执行）：
#   把下面 insert 段并进 $DSH_HOME/profiles/<profile>/cordis.patch.yml
- insert:
    - id: docs-recall
      name: ./bridge/lib/index.js
      config:
        # 相对项目根（DSH 在项目工作区启动时解析）
        root: "."
        # core 省略：桥接默认依次找 .knowlog/recall-core.py、.knowlog/recall-core.py
        maxChars: 4000
        minQueryChars: 4
""")
        notes.append("DSH 的每轮注入机制 = `agent/pre-step` waterfall（已在 adapters/dsh/verify.sh 中非破坏性验证）；"
                     "桥接插件已放在 .dsh/bridge/，patch 已写在 .dsh/docs-recall.patch.yml（name: ./bridge/lib/index.js，免安装）。\n"
                     "        · 先 dry-run：dsh --profile web --patch .dsh/docs-recall.patch.yml --dump-config | grep -A6 docs-recall\n"
                     "        · 要真生效：把 .dsh/docs-recall.patch.yml 的 insert 段并进 $DSH_HOME/profiles/<profile>/cordis.patch.yml"
                     "（这一步只改你自己的 profile，脚本不代劳）\n"
                     "        · 不想装插件也行：命令行兜底 `bash " + TOOLNAME + "/knowledge-retrieve.sh \"<prompt>\"`，与插件同一份召回核心")
    elif a == "cursor":
        put_from(ad / "cursor" / "knowlog.mdc", ".cursor/rules/knowlog.mdc")
    elif a == "gemini":
        put_block("GEMINI.md", pointer)
    elif a == "copilot":
        put_block(".github/copilot-instructions.md", pointer)
    elif a == "generic":
        put("docs/agents/recall.md", (pointer.rstrip() + """

## 没有"每轮注入"机制时怎么召回

各家 agent 的注入机制差别很大，很多（Aider / Cline / Roo / Qwen / iFlow / Antigravity / Kilo / Windsurf / Devin / Amp …）
没有可靠的每轮注入。这些环境一律用命令行兜底，结果与有钩子的 agent 完全同源：

```bash
bash @@TOOL@@/knowledge-retrieve.sh "<任务描述或将要改的代码片段>"
git diff --cached | bash @@TOOL@@/knowledge-retrieve.sh
```
""").replace("@@TOOL@@", TOOLNAME))
    else:
        notes.append(f"⚠️ 未知 agent：{a}（跳过；可用 generic）")

print(f"✅ 已完成 {len(done)} 项")
for d in done:
    print(f"   + {d}")
if skipped:
    print(f"⏭️  跳过（已是最新）{len(skipped)} 项：{', '.join(skipped[:6])}")
for n in notes:
    print(f"ℹ️  {n}")
PY

if [ "$VERIFY" -eq 1 ] && [ "$DRY" -eq 0 ]; then
  echo
  echo "🔎 自测（用召回表里的第一条规则喂一条假 prompt）"
  PROBE=$(python3 - "$KMAP" <<'PY'
import json, sys, re
d = json.load(open(sys.argv[1], encoding="utf-8"))
for k, v in d.items():
    if isinstance(v, dict) and not k.startswith("_"):
        # 取正则里第一个字面量候选作为探针
        cand = re.split(r"\|", k)[0]
        cand = re.sub(r"[\\^$.*+?()\[\]{}]", " ", cand).strip() or "test"
        print(cand.split()[0]); break
PY
)
  echo "   探针词：${PROBE:-(空)}"
  for f in .claude/hooks/docs-recall.py .codex/hooks/docs-recall.py; do
    [ -f "$ROOT/$f" ] || continue
    OUT=$(printf '{"prompt":"%s"}' "$PROBE" | python3 "$ROOT/$f" 2>/dev/null || true)
    if [ -n "$OUT" ]; then echo "   ✅ $f → 注入 $(printf '%s' "$OUT" | wc -c | tr -d ' ') 字节"; else echo "   ⚠️  $f 无输出（规则未命中探针词，或 core 路径不对）"; fi
  done
  if [ -f "$ROOT/.opencode/plugins/docs-recall.ts" ]; then
    python3 -c "import ast,sys" 2>/dev/null
    grep -q "chat.message" "$ROOT/.opencode/plugins/docs-recall.ts" && echo "   ✅ .opencode/plugins/docs-recall.ts → 含 chat.message 钩子（真实注入需开一次会话，可设 DOCS_RECALL_DEBUG=1 看 .opencode/docs-recall.log）" || echo "   ⚠️  opencode 插件缺少 chat.message 钩子"
  fi
  echo "   通用兜底自测：bash $TOOLNAME/knowledge-retrieve.sh \"$PROBE\""
fi
