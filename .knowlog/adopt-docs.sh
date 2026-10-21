#!/bin/bash
# adopt-docs.sh — 把「已经存在但结构不同」的开发日志/文档纳入本体系
#
# 典型场景：项目里早就有一堆 `docs/logs/2026-10-17xxx.md`、`docs/journal/`、根目录 `daily/`、
# 或按日流水的中文日志。直接跑 bootstrap 会造出**两套并行的结构**（两份真相），所以先"采纳（adopt）"：
#   ① 扫出所有像"日期日志"的 markdown → 规划成 `docs/daily/<YYYY-MM>/YYYY-MM-DD_<slug>.md`
#   ② 把结果登记进 `docs/index.md`（年内月份降序、月内日期升序）
#   ③ `--apply` 才真正移动（默认只打印计划）；移动前备份索引，优先 `git mv` 保历史
#
# 已有 `docs/knowledge/`：**不动**，只在其缺失的四个分类目录与索引处补齐（交给 bootstrap-docs.sh）。
#
# 用法：
#   bash ${TOOLNAME}/adopt-docs.sh                 # 只打印计划（dry-run，默认）
#   bash ${TOOLNAME}/adopt-docs.sh --apply         # 执行迁移
#   bash ${TOOLNAME}/adopt-docs.sh --apply --root /path/to/project
set -euo pipefail

ROOT=""; APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --root=*) ROOT="${1#--root=}"; shift ;;
    --apply) APPLY=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
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
[ -d "$ROOT/docs" ] || echo "ℹ️  没有 docs/ 目录——本脚本用于"已有异构文档"的项目；全新项目请直接 bootstrap-docs.sh"
export ROOT APPLY

PLAN=$(python3 - <<'PY'
"""扫描 → 规划（不改动磁盘）；输出 JSON"""
import json, os, pathlib, re, sys

def junk(name: str) -> bool:
    """macOS 在 exFAT/网络卷上会为每个文件生成 ._xxx 影子文件；系统垃圾也不算文档。"""
    return name.startswith("._") or name in {".DS_Store"} or name.startswith(".Spotlight")

root = pathlib.Path(os.environ["ROOT"])
SKIP_DIRS = {".git", "node_modules", "vendor", "dist", "build", ".next", ".venv", "venv",
             "__pycache__", ".idea", ".vscode", "coverage", ".pytest_cache"}
SKIP_PREFIX = ("docs/daily/", "docs/knowledge/", "docs/domain context/", "docs/agents/",
               ".trellis/", ".scratch/", ".claude/", ".codex/", ".opencode/", ".dsh/",
               "docs/templates/")
DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})[_\-\s]*(.*)$")

found = []
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".git")]
    rel_dir = pathlib.Path(dirpath).relative_to(root).as_posix()
    for fn in filenames:
        if not fn.endswith(".md") or fn.startswith("._") or fn == ".DS_Store":
            continue
        rel = f"{rel_dir}/{fn}" if rel_dir != "." else fn
        rel = rel.lstrip("./")
        if any(rel.startswith(p) for p in SKIP_PREFIX):
            continue
        if fn in {"README.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", "CHANGELOG.md", "LICENSE.md"}:
            continue
        m = DATE_RE.match(fn[:-3])
        if not m:
            continue
        # 只采纳"看起来像日志"的：路径含关键字，或文件名带日期（本项目约定）
        looks_like_log = bool(re.search(r"(daily|logs?|journal|日报|日志|devlog|worklog)", rel, re.I))
        found.append({"src": rel, "date": m.group(1), "rest": m.group(2).strip("_- ")})


def slugify(rest: str) -> str:
    kebab = re.sub(r"[^A-Za-z0-9]+", "-", rest).strip("-").lower()
    if len(kebab) >= 3:
        return kebab
    if rest:
        return re.sub(r"\s+", "-", rest)          # 中文等保留可读性（门禁允许日期后任意字符）
    return "log"


targets, used = [], set()
for item in sorted(found, key=lambda x: (x["date"], x["src"])):
    date, slug = item["date"], slugify(item["rest"])
    rel = f"daily/{date[:7]}/{date}_{slug}.md"
    n = 2
    while rel in used:
        rel = f"daily/{date[:7]}/{date}_{slug}-{n}.md"; n += 1
    used.add(rel)
    targets.append({**item, "dst": rel, "action": "move"})

existing = []
d = root / "docs" / "daily"
if d.is_dir():
    for p in sorted(x for x in d.rglob("*.md") if not junk(x.name)):
        existing.append(f"daily/{p.parent.name}/{p.name}" if p.parent != d else f"daily/{p.name}")

print(json.dumps({"found": targets, "existing_daily": existing,
                  "knowledge_exists": (root / "docs" / "knowledge").is_dir(),
                  "domain_exists": (root / "docs" / "domain context").is_dir(),
                  "index_exists": (root / "docs" / "index.md").exists()}, ensure_ascii=False))
PY
)

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$ROOT" APPLY="$APPLY" PLAN="$PLAN" HERE="$HERE" TOOL="$TOOL" python3 - <<'PY'
import datetime, json, os, pathlib, shutil, subprocess, sys

root = pathlib.Path(os.environ["ROOT"]); plan = json.loads(os.environ["PLAN"]); apply = os.environ["APPLY"] == "1"
found, existing = plan["found"], plan["existing_daily"]

print("📗 adopt-docs — 采纳既有文档进入本体系" + ("" if apply else "（dry-run：默认只打印计划）"))
print(f"   扫描到 {len(found)} 篇疑似日志 · docs/daily 下已有 {len(existing)} 篇")
for k in ("knowledge_exists", "domain_exists", "index_exists"):
    if plan[k]:
        print(f"   ℹ️  {k} = true → 已存在的内容原样保留")
if not found:
    print("\n（没找到需要采纳的日志。若你的日志命名不含日期，请手工整理或告诉我你的命名规则）")
    sys.exit(0)

print("\n迁移计划（源 → 目标）：")
for it in found:
    print(f"   {it['src']}\n     → docs/{it['dst']}")

if not apply:
    print("\n执行：bash ${TOOLNAME}/adopt-docs.sh --apply")
    sys.exit(0)

# 备份索引
idx = root / "docs" / "index.md"
if idx.exists():
    bak = idx.with_suffix(".md.bak")
    shutil.copy2(idx, bak)
    print(f"\n🔒 已备份索引：docs/{bak.name}")
else:
    # 采纳流程常常发生在 bootstrap 之前。优先用 skill 自带模板渲染（与 bootstrap 产物一致，
    # 免去"先 adopt 后 bootstrap 留下骨架版索引、还要人工收口"）；找不到模板才退回最小骨架。
    idx.parent.mkdir(parents=True, exist_ok=True)
    tpl_candidates = [
        pathlib.Path(os.environ.get("HERE", ".")).parent / "assets" / "daily-index.md.tmpl",
        pathlib.Path(os.environ.get("HERE", ".")) / "assets" / "daily-index.md.tmpl",
        pathlib.Path(os.environ["TOOL"]) / "assets" / "daily-index.md.tmpl",
    ]
    tpl = next((t for t in tpl_candidates if t.exists()), None)
    if tpl is not None:
        text = tpl.read_text(encoding="utf-8")
        for k, v in {"__PROJECT__": root.name, "__DATE__": datetime.date.today().isoformat()}.items():
            pass
        text = text.replace("__PROJECT__", root.name).replace("__DATE__", datetime.date.today().isoformat())
        idx.write_text(text, encoding="utf-8")
        print("ℹ️  已按 skill 模板创建 docs/index.md（与 bootstrap 产物一致，无需再收口）")
    else:
        idx.write_text(
            "# 开发日志索引\n\n"
            "> 唯一索引：日志位于 `docs/daily/<YYYY-MM>/YYYY-MM-DD_<slug>.md`（月份取日志日期所在月）。\n"
            "> 新建：`bash ${TOOLNAME}/new-daily-log.sh <slug>` · 校验：`bash ${TOOLNAME}/check-daily-index.sh --strict`\n\n"
            "## 📊 统计\n\n> 计数用 `ls docs/daily/*/*.md | wc -l`。\n\n"
            "## 🔗 快速链接\n\n- [使用指南](README.md)\n- [日志模板](template.md)\n- [统一知识库](knowledge/index.md)\n",
            encoding="utf-8")
        print("ℹ️  已创建 docs/index.md 最小骨架")

moved = []
for it in found:
    src = root / it["src"]; dst = root / "docs" / it["dst"]
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(["git", "mv", str(src), str(dst)], cwd=root, check=True,
                       capture_output=True)
    except Exception:
        shutil.move(str(src), str(dst))
    moved.append(it["dst"])
    print(f"   ✅ {it['src']} → docs/{it['dst']}")

util = None
for cand in [pathlib.Path(os.environ["TOOL"]) / "index-util.py", pathlib.Path(os.environ.get("HERE", ".")) / "index-util.py"]:
    if cand.exists():
        util = cand
        break
if util:
    for rel in moved:
        date = pathlib.Path(rel).name[:10]
        subprocess.run(["python3", str(util), "upsert", "--index", str(idx),
                        "--date", date, "--rel", rel,
                        "--cells", f"{date[5:7]}-{date[8:10]}-adopted|（迁移自既有文档，待回填）|—|迁移采纳"],
                       capture_output=True)
    print(f"\n✅ 已登记 {len(moved)} 行索引")
else:
    print("\n⚠️  未找到 .knowlog/index-util.py（索引未登记）→ 请重跑 bootstrap-docs.sh 后再跑本脚本")

print("\n下一步（第 0 步别漏：迁移本身就是该记一笔的事）：")
print("  0. 记一笔（写清你动了哪些历史文件）：bash ${TOOLNAME}/new-daily-log.sh adopt-legacy-docs")
print("  1. 补齐体系并生成门禁：bash ${TOOLNAME}/bootstrap-docs.sh")
print("  2. 校验：bash ${TOOLNAME}/check-daily-index.sh --strict --fix-hint")
print("  3. 历史月份若故意不登记：LEGACY_MONTHS=\"2026-04 2026-05\" bash ${TOOLNAME}/check-daily-index.sh")
PY
