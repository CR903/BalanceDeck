#!/bin/bash
# check-docs-structure.sh — 项目文档体系的**结构规范**自检
#
# 与另外两个 checker 的分工：
#   check-daily-index.sh      → 日志 ↔ 索引（内容一致性）
#   check-knowledge-index.sh  → 知识 ↔ 索引（内容一致性）
#   check-docs-structure.sh   → **结构本身**是否规范（本脚本）：目录/文件/脚本齐备性、命名与布局不变量、
#                               托管块、召回表可用性、以及"该采纳但没采纳"的残留
#
# 为什么单独一层：索引一致但结构跑偏（布局混用、脚本缺一个、托管块被删、keywords 表空）同样会让体系
# 悄悄失效 —— 而这类问题不会在"索引比对"里暴露出来。
#
# 用法：
#   bash ${TOOLNAME}/check-docs-structure.sh [--strict] [--fix-hint] [--root DIR]
# 退出码：0 通过；1 有 ERROR（或 --strict 下有 WARN）
set -euo pipefail

ROOT=""; STRICT=0; FIX=0
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --root=*) ROOT="${1#--root=}"; shift ;;
    --strict) STRICT=1; shift ;;
    --fix-hint) FIX=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
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
export ROOT STRICT FIX

TOOL="$TOOL" python3 - <<'PY'
import json, os, pathlib, re, stat, sys

root = pathlib.Path(os.environ["ROOT"])
strict = os.environ["STRICT"] == "1"; fix = os.environ["FIX"] == "1"
CATS = ["architecture", "guides", "troubleshooting", "best-practices"]
E = []; W = []; I = []; H = []      # I = INFO（建议项，--strict 也算通过）


def err(p, why, hint=None):
    E.append((p, why))
    if hint: H.append(hint)


def warn(p, why, hint=None):
    W.append((p, why))
    if hint: H.append(hint)


def info(p, why, hint=None):
    """建议项：不构成"不规范"。例如"还没加第一条召回规则"——那是欠缺，不是错。"""
    I.append((p, why))
    if hint: H.append(hint)


def exists(rel):
    return (root / rel).exists()


# ---------- 1. 目录与文件齐备性 ----------
for d in ["docs", "docs/daily", "docs/knowledge"]:
    if not (root / d).is_dir():
        err(d + "/", "必需目录缺失", "bash ${TOOLNAME}/bootstrap-docs.sh   # 幂等补齐")
for d in ["docs/domain context", "docs/agents", "docs/templates"]:
    if not (root / d).is_dir():
        warn(d + "/", "推荐目录缺失（领域记忆 / agent 约定 / 文档模板）", "bash ${TOOLNAME}/bootstrap-docs.sh")

for f in ["docs/index.md", "docs/README.md", "docs/template.md", "docs/knowledge/index.md"]:
    if not exists(f):
        err(f, "必需文件缺失", "bash ${TOOLNAME}/bootstrap-docs.sh")

# 脚本齐备且可执行（缺哪个，"收尾记日志"这条链就断在哪）
need_exec = ["new-daily-log.sh", "check-daily-index.sh", "check-docs-structure.sh",
             "new-knowledge.sh", "check-knowledge-index.sh", "new-keyword.sh",
             "knowledge-retrieve.sh", "install-recall.sh", "bootstrap-docs.sh", "adopt-docs.sh"]
for s in need_exec:
    p = pathlib.Path(os.environ["TOOL"]) / s
    if not p.exists():
        err(f"scripts/{s}", "脚本缺失", "bash ${TOOLNAME}/bootstrap-docs.sh")
    elif not (p.stat().st_mode & stat.S_IXUSR):
        warn(f"scripts/{s}", "缺少可执行位", f"chmod +x scripts/{s}")
for s in ["index-util.py", "recall-core.py"]:
    if not (pathlib.Path(os.environ["TOOL"]) / s).exists():
        err(f"scripts/{s}", "脚本缺失（索引写入/召回的单一实现）", "bash ${TOOLNAME}/bootstrap-docs.sh")

# ---------- 2. 知识库布局不变量 ----------
KNOW = root / "docs" / "knowledge"
end_dirs = [d for d in sorted(KNOW.iterdir())
            if d.is_dir() and d.name not in CATS and (d / "index.md").exists()] if KNOW.is_dir() else []
flat_cats = [c for c in CATS if (KNOW / c).is_dir()]
layout = "by-end" if end_dirs else ("flat" if flat_cats else "unknown")

if layout == "unknown":
    err("docs/knowledge/", "既没有端目录也没有分类目录：布局未建立", "bash ${TOOLNAME}/bootstrap-docs.sh --knowledge-layout flat")
elif layout == "by-end":
    # 混用检测：根下同时存在分类目录（说明有人把 flat 的知识塞进了 by-end 项目）
    stray = list(flat_cats)      # 判定修正：by-end 项目里根下**不应**有任何裸分类目录（哪怕端里也有同名分类）
    if stray:
        warn("docs/knowledge/" + ", ".join(stray) + "/",
             f"布局混用：这是 by-end 项目，但根下还有裸分类目录（flat 残留）",
             "git mv docs/knowledge/<分类>/<file>.md docs/knowledge/<端>/<分类>/ && 重跑 new-knowledge.sh 登记")
    for e in end_dirs:
        for f in ("README.md", "index.md"):
            if not (e / f).exists():
                warn(f"docs/knowledge/{e.name}/{f}", "端目录缺说明/索引", "bash ${TOOLNAME}/bootstrap-docs.sh")
        missing = [c for c in CATS if not (e / c).is_dir()]
        if missing:
            warn(f"docs/knowledge/{e.name}/", "缺分类目录：" + ", ".join(missing), "bash ${TOOLNAME}/bootstrap-docs.sh")
else:
    for c in CATS:
        if not (KNOW / c).is_dir():
            warn(f"docs/knowledge/{c}/", "分类目录缺失（flat 布局）", "bash ${TOOLNAME}/bootstrap-docs.sh")
    # flat 布局下，除了四个分类与常见附属目录，其它目录属"非常规分类"（例如历史 notes/）
    ALLOW_EXTRA = {"templates", "assets", "research", "archive"}
    for d in sorted(x for x in KNOW.iterdir() if x.is_dir()):
        if d.name not in CATS and d.name not in ALLOW_EXTRA:
            warn(f"docs/knowledge/{d.name}/", "非常规分类目录（结构漂移：知识不在四个分类下）",
                 f"把内容归入四个分类之一：git mv docs/knowledge/{d.name}/*.md docs/knowledge/<分类>/ 并重新登记索引")

# 端目录里塞了不属于它的东西（布局漂移的另一种形态）
if layout == "by-end":
    for e in end_dirs:
        for item in e.iterdir():
            if item.is_dir() and item.name not in CATS and item.name not in {"research", "assets"}:
                warn(f"docs/knowledge/{e.name}/{item.name}/", "端目录下出现非分类目录（结构漂移）")

# ---------- 3. 索引与召回表可用性 ----------
idx = root / "docs" / "index.md"
if idx.exists():
    txt = idx.read_text(encoding="utf-8")
    if "](daily/" not in txt and "### " not in txt:
        warn("docs/index.md", "索引里既没有年月 section 也没有日志链接（可能被清空）")
    if re.search(r"\d{4}-\d{2}-\d{2}", txt):
        for l in re.findall(r"\]\((daily/[^)\s]+?\.md)\)", txt):
            if not re.match(r"^daily/\d{4}-\d{2}/", l):
                err(l, "索引里存在旧扁平路径（结构不符规范）",
                    "bash ${TOOLNAME}/check-daily-index.sh --fix-hint")

kmap = KNOW / ".keyword-map.json"
if not kmap.exists():
    err("docs/knowledge/.keyword-map.json", "召回表缺失", "bash ${TOOLNAME}/bootstrap-docs.sh")
else:
    try:
        d = json.loads(kmap.read_text(encoding="utf-8") or "{}")
        real = [k for k, v in d.items() if isinstance(v, dict) and not k.startswith("_")]
        exempt = set(d.get("_exempt", []) or [])
        kdocs = [p for p in KNOW.rglob("*.md")
                 if p.name not in {"README.md", "index.md"} and not p.name.startswith("._")
                 and p.relative_to(root).as_posix() not in exempt]
        if not real and kdocs:
            # 有知识却没有任何召回规则 → 召回永远空转：不报错、不失败，只是静默失去意义
            warn("docs/knowledge/.keyword-map.json",
                 f"有 {len(kdocs)} 篇知识文档但 0 条召回规则 → 召回永远空转",
                 "沉淀时用 new-knowledge.sh（自动挂规则）；存量用 reindex-knowledge.sh --apply 补齐")
        elif not real:
            info("docs/knowledge/.keyword-map.json", "还没有知识文档/召回规则（尚无可用结论，属正常）",
                 'bash ${TOOLNAME}/new-knowledge.sh --flat <分类> <name> "<结论>" --source <日志>')
        for k in real:
            for doc in d[k].get("docs", []):
                if not (root / doc.split("#")[0]).exists():
                    warn(f"docs/knowledge/.keyword-map.json", f"规则 `{k}` 指向不存在的文档：{doc}")
    except Exception as e:
        err("docs/knowledge/.keyword-map.json", f"JSON 解析失败：{e}", "手工修复该文件的 JSON")

# ---------- 4. 约束是否就位（AGENTS.md 托管块） ----------
ag = root / "AGENTS.md"
if not ag.exists():
    err("AGENTS.md", "缺失（约束没有任何落点）", "bash ${TOOLNAME}/bootstrap-docs.sh")
else:
    t = ag.read_text(encoding="utf-8")
    LEGACY = "DOCS" + "-SYSTEM"
    if "<!-- KNOWLOG:START" not in t or "<!-- KNOWLOG:END" not in t:
        if LEGACY + ":START" in t and LEGACY + ":END" in t:
            warn("AGENTS.md", "托管块仍是旧标记 DOCS-SYSTEM（rename 之前写入的）",
                 "bash ${TOOLNAME}/bootstrap-docs.sh   # 会把它迁移成 KNOWLOG 标记")
        # 有些项目（尤其"先有规范、后引入本 skill"的）已经把等价规则手写在 AGENTS.md 里。
        # 那不该判 ERROR —— 否则会逼人塞一个重复规则块，两份真相必然漂移。
        equivalent = ("new-daily-log" in t or "daily/<YYYY-MM>" in t or "daily/YYYY-MM" in t) and \
                     ("check-daily-index" in t or "docs-doctor" in t)
        if equivalent:
            warn("AGENTS.md", "未用 DOCS-SYSTEM 托管块，但检出手写等价规范（易与脚本漂移）",
                 "把规则搬进托管块：bash ${TOOLNAME}/bootstrap-docs.sh（块内脚本维护，块外保留你的内容）")
        else:
            err("AGENTS.md", "既无 DOCS-SYSTEM 托管块，也未检出等价规范（日志规范/门禁没被声明）",
                "bash ${TOOLNAME}/bootstrap-docs.sh")
    if "KNOWLOG:START" in t:
        # 门禁命令名三选一即可：新版模板只写 docs-doctor，旧版写 check-daily-index
        if not any(k in t for k in ("docs-doctor", "check-daily-index", "check-knowledge-index")):
            warn("AGENTS.md", "托管块里没写门禁命令（agent 无从知道要跑什么）", "bash ${TOOLNAME}/bootstrap-docs.sh")
    if not re.search(r"^##[^\n]*🧭[^\n]*(路由|Domain Context Routing)", t, re.M):
        warn("AGENTS.md", "缺少「领域上下文路由表（手工维护）」一节", "bash ${TOOLNAME}/bootstrap-docs.sh")

# 召回适配器是否装过（有钩子才叫"自动"）
adapters = [".claude/settings.json", ".codex/hooks.json", "opencode.json",
            ".cursor/rules/knowlog.mdc", "GEMINI.md", ".github/copilot-instructions.md",
            "docs/agents/recall.md"]
if not any(exists(a) for a in adapters):
    info("（召回适配器）", "没有任何 agent 适配器 → 只能靠手工跑 knowledge-retrieve.sh",
         "bash ${TOOLNAME}/install-recall.sh --agent auto")

# ---------- 5. 该采纳但没采纳的残留 ----------
SKIP = {".git", "node_modules", "vendor", "dist", "build", ".venv", "venv", "__pycache__",
        ".mnemon", ".trellis", ".scratch", ".claude", ".codex", ".opencode", ".dsh", ".agents",
        ".idea", ".vscode", "coverage", "outputs"}
strays = []
for dirpath, dirnames, filenames in os.walk(root):
    # 只跳过"工具/运行时目录"，不跳过普通隐藏目录之外的东西（否则会漏报真实残留）
    dirnames[:] = [d for d in dirnames if d not in SKIP and not d.startswith(".git")]
    rel_dir = pathlib.Path(dirpath).relative_to(root).as_posix()
    if rel_dir.startswith(("docs/daily", "docs/knowledge", "docs/templates", "docs/agents")):
        continue
    for fn in filenames:
        if fn.endswith(".md") and re.match(r"^\d{4}-\d{2}-\d{2}[_\-\s]", fn) \
                and fn not in {"README.md", "AGENTS.md", "CHANGELOG.md"}:
            strays.append(f"{rel_dir}/{fn}")
if strays:
    warn(f"（{len(strays)} 篇日期日志在体系外）", "示例：" + ", ".join(strays[:3]),
         "bash ${TOOLNAME}/adopt-docs.sh   # 先看计划，再 --apply")


def dump(title, items, mark):
    if not items:
        return
    print(f"\n{mark} {title}（{len(items)}）")
    for p, why in items:
        print(f"  - {p}\n      {why}")


print(f"📐 check-docs-structure — 项目文档体系结构规范（{root.name}）")
print(f"   知识布局：{layout}" + (f"（端：{', '.join(d.name for d in end_dirs)}）" if end_dirs else ""))
print(f"   目录 {sum(1 for _ in root.glob('docs/**/*'))} 项 · 脚本 {len(list(pathlib.Path(os.environ["TOOL"]).glob("*")))} 个" if pathlib.Path(os.environ["TOOL"]).is_dir() else "")
dump("错误", E, "❌")
dump("告警", W, "⚠️ ")
dump("建议", I, "💡")
if fix and H:
    print("\n🔧 修复建议")
    for h in dict.fromkeys(H):
        print(f"  $ {h}")

if E or (strict and W):
    print(f"\n失败：{len(E)} 错误" + (f" + {len(W)} 告警（--strict）" if strict and W else ""))
    sys.exit(1)
print(f"\n✅ 通过：结构规范" + (f"（{len(W)} 条告警）" if W else ""))
PY
