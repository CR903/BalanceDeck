#!/bin/bash
# bootstrap-docs.sh — 给一个项目建立「开发文档体系」（日志 + 知识库 + 领域上下文 + 索引 + 召回 + 约束）
#
# 设计原则：
#   1. 幂等 —— 已存在的文件一律不覆盖；重复执行的结果必须逐字节相同（可 `shasum` 对拍）
#   2. 不破坏 —— AGENTS.md 只在托管块标记之间写入；**用户手工维护的内容（如领域路由表）放在块外**，
#      由本脚本"只创建一次、永不重写"
#   3. 自包含 —— 会把 assets 复制到项目的 .knowlog/assets/，因此**复制到项目后依然能独立运行**
#      （`--ends` 加端、补建目录都不需要原始 skill）
#   4. 可验证 —— 收尾自动跑 check-daily-index.sh，把"结构对不对"变成退出码
#
# 用法：
#   bash .knowlog/bootstrap-docs.sh                                  # 当前 git 仓库
#   bash .knowlog/bootstrap-docs.sh --ends "backend frontend"        # 指定端（默认自动探测）
#   bash .knowlog/bootstrap-docs.sh --knowledge-layout flat|by-end   # 知识库布局（默认 auto）
#   bash .knowlog/bootstrap-docs.sh --project-name "我的项目" --with-recall
#   bash .knowlog/bootstrap-docs.sh --dry-run                        # 只看要做什么
set -euo pipefail

# 环境变量归一化：KNOWLOG_HOME 为准，兼容旧的 DOCS_SYSTEM_HOME
KNOWLOG_HOME="${KNOWLOG_HOME:-${DOCS_SYSTEM_HOME:-}}"
ROOT=""; ENDS=""; PROJECT_NAME=""; LAYOUT="auto"; WITH_RECALL=0; DRY=0; FORCE_SCRIPTS=0; RESYNC=1
while [ $# -gt 0 ]; do
  case "$1" in
    --root)
      [ $# -ge 2 ] || { echo "❌ --root 需要值（例：--root <值>）" >&2; exit 2; }
      ROOT="$2"; shift 2 ;;
    --root=*) ROOT="${1#--root=}"; shift ;;
    --ends)
      [ $# -ge 2 ] || { echo "❌ --ends 需要值（例：--ends <值>）" >&2; exit 2; }
      ENDS="$2"; shift 2 ;;
    --ends=*) ENDS="${1#--ends=}"; shift ;;
    --project-name)
      [ $# -ge 2 ] || { echo "❌ --project-name 需要值（例：--project-name <值>）" >&2; exit 2; }
      PROJECT_NAME="$2"; shift 2 ;;
    --project-name=*) PROJECT_NAME="${1#--project-name=}"; shift ;;
    --knowledge-layout)
      [ $# -ge 2 ] || { echo "❌ --knowledge-layout 需要值（例：--knowledge-layout <值>）" >&2; exit 2; }
      LAYOUT="$2"; shift 2 ;;
    --knowledge-layout=*) LAYOUT="${1#--knowledge-layout=}"; shift ;;
    --with-hook|--with-recall) WITH_RECALL=1; shift ;;
    --force-scripts) FORCE_SCRIPTS=1; shift ;;        # 强制覆盖（一般不需要：版本不同会自动同步）
    --no-force-scripts) RESYNC=0; shift ;;            # 只补缺失、不自动更新（应急开关）
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done
case "$LAYOUT" in auto|flat|by-end) ;; *) echo "❌ --knowledge-layout 只能是 auto / flat / by-end" >&2; exit 2 ;; esac

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
[ -d "$ROOT" ] || { echo "❌ 目标目录不存在：$ROOT" >&2; exit 1; }

# ---- assets 定位：优先自包含副本（项目内 .knowlog/assets/），其次 skill 原始位置 ----
ASSETS=""
for cand in "${KNOWLOG_HOME:-}/assets" "$HERE/assets" "$ROOT/.knowlog/assets" "$ROOT/.knowlog/assets" "$(cd "$HERE/.." && pwd)/assets"; do
  if [ -n "$cand" ] && [ -d "$cand" ]; then ASSETS="$cand"; break; fi
done
if [ -z "$ASSETS" ]; then
  echo "❌ 找不到 assets 目录。请在 skill 目录里首次运行，或设 KNOWLOG_HOME=<skill 目录>" >&2
  exit 1
fi
SOURCE_SCRIPT_DIR="$(dirname "$ASSETS")/scripts"      # skill 的 scripts/（用于复制全套脚本）
if [ ! -d "$SOURCE_SCRIPT_DIR" ]; then SOURCE_SCRIPT_DIR="$HERE"; fi

if [ -z "$PROJECT_NAME" ]; then PROJECT_NAME="$(basename "$ROOT")"; fi
DATE="$(date +%Y-%m-%d)"

# ---- 端自动探测 ----
if [ -z "$ENDS" ]; then
  detected=()
  if [ -f "$ROOT/go.mod" ]; then detected+=("backend"); fi
  if [ -f "$ROOT/package.json" ] && grep -qE '"(react|vue|@angular/core|svelte|next|nuxt)"' "$ROOT/package.json" 2>/dev/null; then detected+=("frontend"); fi
  if [ -f "$ROOT/manifest.json" ] && [ -f "$ROOT/pages.json" ]; then detected+=("mobile"); fi
  if [ -f "$ROOT/pubspec.yaml" ]; then detected+=("mobile"); fi
  if [ ${#detected[@]} -eq 0 ]; then
    for d in "$ROOT"/*/; do
      if [ -f "${d}go.mod" ] || [ -f "${d}package.json" ]; then detected+=("$(basename "$d")"); fi
    done
  fi
  if [ ${#detected[@]} -eq 0 ]; then detected=("app"); fi
  ENDS="$(printf '%s ' "${detected[@]}")"
fi
ENDS="$(printf '%s' "$ENDS" | tr ',' ' ')"
read -r -a END_ARR <<< "$ENDS"
if [ "$LAYOUT" = "auto" ]; then
  if [ ${#END_ARR[@]} -ge 2 ]; then LAYOUT="by-end"; else LAYOUT="flat"; fi
fi

echo "📗 bootstrap-docs"
echo "   项目：${PROJECT_NAME}（${ROOT}）"
if [ "$LAYOUT" = "by-end" ]; then
  echo "   知识布局：by-end（端：${END_ARR[*]} · 通用：common）"
else
  echo "   知识布局：flat（单面项目：四个分类直接放 docs/knowledge/ 下，无端层）"
fi
if [ "$DRY" -eq 1 ]; then echo "   ⚠️  --dry-run：只打印计划，不落盘"; fi
echo

ROOT="$ROOT" PROJECT_NAME="$PROJECT_NAME" DATE="$DATE" ENDS="$ENDS" LAYOUT="$LAYOUT" \
ASSETS="$ASSETS" SOURCE_SCRIPT_DIR="$SOURCE_SCRIPT_DIR" DRY="$DRY" FORCE_SCRIPTS="$FORCE_SCRIPTS" RESYNC="$RESYNC" python3 - <<'PY'
import os, pathlib, re, shutil, stat, sys

root = pathlib.Path(os.environ["ROOT"]); assets = pathlib.Path(os.environ["ASSETS"])
srcdir = pathlib.Path(os.environ["SOURCE_SCRIPT_DIR"])
name = os.environ["PROJECT_NAME"]; date = os.environ["DATE"]
ends = os.environ["ENDS"].split(); layout = os.environ["LAYOUT"]
dry = os.environ["DRY"] == "1"

created, skipped, notes = [], [], []
MARK_START = "<!-- KNOWLOG:START (由 knowlog skill 托管，手工改动请放在块外) -->"
MARK_END = "<!-- KNOWLOG:END -->"
# 识别用「前缀」而不是整行：标记行尾的说明文字可能被改过（真实踩过：
# 手写块写的是"块内由脚本维护…"，于是整行不匹配 → 被当成"没有块"→ 又追加一份）
MARK_RE = r"<!--\s*KNOWLOG:START[^\n]*-->.*?<!--\s*KNOWLOG:END[^\n]*-->"
CATS = ["architecture", "guides", "troubleshooting", "best-practices"]

TOOL = ".knowlog"     # 项目内工具目录（knowlog 专有，隐藏）


def transform(t: str) -> str:
    """把「项目内工具目录」的引用改成 .knowlog（skill 自身路径 ~/.agents/.../scripts 不动）。"""
    t = t.replace("$ROOT/.knowlog/", "$ROOT/.knowlog/")
    t = t.replace('root / ".knowlog"', 'root / ".knowlog"')
    t = t.replace("bash .knowlog/", "bash .knowlog/")
    t = t.replace(".knowlog/assets", ".knowlog/assets")
    t = t.replace(".knowlog/adapters", ".knowlog/adapters")
    t = t.replace(".knowlog/index-util.py", ".knowlog/index-util.py")
    t = t.replace(".knowlog/recall-core.py", ".knowlog/recall-core.py")
    return t


def put(rel: str, content: str):
    content = transform(content)
    p = root / rel
    if p.exists():
        if p.read_text(encoding="utf-8", errors="ignore") == content:
            skipped.append(rel); return
        skipped.append(rel + "（已存在，保留现有内容）"); return
    if dry:
        created.append(rel); return
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    created.append(rel)


def backup_block(rel: str, old_block_text: str):
    """刷新托管块前，把旧块内容留一份备份 —— 块被视为工具所有，但绝不静默覆盖掉人写的东西。"""
    if dry:
        return
    # 备份放进 .knowlog/（knowlog 自己的隐藏目录），别在项目根留 .bak 干扰 git status
    bak = root / TOOL / (rel.replace("/", "_") + ".block.bak")
    try:
        bak.parent.mkdir(parents=True, exist_ok=True)
        bak.write_text(old_block_text, encoding="utf-8")
        notes.append(f"旧托管块已备份到 {TOOL}/{bak.name}（若你在块内写过内容，去那里找）")
    except Exception:
        pass


def normalize(text: str) -> str:
    return text.rstrip("\n") + "\n"


LEGACY_START = "<!-- " + "DOCS" + "-SYSTEM:START"     # 旧标记（本项目 v0.2 及更早写入的），只为兼容迁移
LEGACY_END = "DOCS" + "-SYSTEM:END -->"


def put_block_managed(rel: str, block: str, preamble: str = ""):
    """托管块：块内由脚本维护（幂等：内容规范化后相同就不写）

    兼容：老项目里可能是旧标记（DOCS-SYSTEM），这里顺手迁移到新标记（KNOWLOG），
    否则老项目会一直被判"缺少托管块"，人就得手工改。
    """
    p = root / rel; block = transform(normalize(block))
    if p.exists():
        old = p.read_text(encoding="utf-8")
        if LEGACY_START in old and LEGACY_END in old and MARK_START not in old:
            # 迁移"标记"而不是"重置内容"：老项目块内可能已经写了项目自己的规矩，
            # 直接拿通用模板覆盖会**静默吃掉它们**（真实踩过）。所以只换标记，内容原样保留。
            m = re.search(re.escape(LEGACY_START) + r".*?" + re.escape(LEGACY_END), old, flags=re.S)
            backup_block(rel, m.group(0) if m else old)
            # 整行规范化：旧标记行可能带额外后缀（如 `<!-- DOCS-SYSTEM:START (旧) -->`），
            # 只替换前缀会留下 ` (旧) -->` 这种残尾
            migrated = re.sub(r"<!--\s*" + re.escape("DOCS" + "-SYSTEM:START") + r"[^\n]*-->",
                              lambda _: MARK_START, old)
            migrated = re.sub(r"<!--\s*" + re.escape("DOCS" + "-SYSTEM:END") + r"\s*-->",
                              lambda _: MARK_END, migrated)
            if not dry:
                p.write_text(normalize(migrated), encoding="utf-8")
            created.append(rel + "（托管块标记已从 DOCS-SYSTEM 迁移到 KNOWLOG；块内内容原样保留）")
            notes.append(f"如需把 {rel} 的块内容同步到上游模板，请 diff 后手工合并（块内容被视为你的自定义）")
            return
        if "<!-- KNOWLOG:START" in old and "<!-- KNOWLOG:END" in old:
            new = re.sub(MARK_RE, lambda _: block.strip(), old, flags=re.S)
            new = normalize(re.sub(r"\n{3,}", "\n\n", new))
            if new == normalize(old):
                skipped.append(rel + "（托管块已最新）"); return
            m = re.search(MARK_RE, old, flags=re.S)
            backup_block(rel, m.group(0) if m else old)
            if not dry:
                p.write_text(new, encoding="utf-8")
            created.append(rel + "（刷新托管块）"); return
        new = normalize(old.rstrip("\n") + "\n\n" + block)
        if not dry:
            p.write_text(new, encoding="utf-8")
        created.append(rel + "（追加托管块）"); return
    if not dry:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(preamble + block, encoding="utf-8")
    created.append(rel + "（新建）")


def ensure_unmanaged_section(rel: str, marker_re: str, content: str):
    """用户手工维护的 section：**只创建一次，之后永不改写**（否则会吃掉用户的编辑）

    注意：判断必须用「行首标题」正则，不能用子串包含 —— 托管块正文里会**提到**这个标题
    （"路由表在…一节"），子串匹配会误判成"已存在"，于是手工区永远建不出来。
    """
    p = root / rel
    if p.exists():
        t = p.read_text(encoding="utf-8")
        # 必须先剥掉托管块：托管块自己也有一节「🧭 领域上下文路由（业务长期记忆）」，
        # 不剥的话宽判据会误判成手工区已存在，于是手工区永远建不出来（真实踩过）。
        t_wo_block = re.sub(MARK_RE, "", t, flags=re.S)
        if re.search(marker_re, t_wo_block, re.M):
            skipped.append(rel + "（手工维护区已存在，未改动）"); return
    if not p.exists():
        put_block_managed(rel, "")     # 先确保文件存在
    p = root / rel
    old = p.read_text(encoding="utf-8") if p.exists() else ""
    if not dry:
        p.write_text(normalize(old.rstrip("\n") + "\n\n" + content), encoding="utf-8")
    else:
        created.append(rel + "（新增手工维护区）"); return
    created.append(rel + "（新增手工维护区）")


# ---------- 渲染上下文 ----------
def end_sections_for(dirs):
    out = []
    for e in dirs:
        rows = "\n".join(
            f"| — | [{f}]({e}/{f}) | {'端知识库说明与文档模板' if f == 'README.md' else f'{e} 端索引（新增知识后必须更新）'} | 初始化 |"
            for f in ("README.md", "index.md"))
        out.append(f"## 📦 {e} 知识 `docs/knowledge/{e}/`\n\n| 分类 | 文档 | 说明 | 来源 |\n|------|------|------|------|\n{rows}\n")
    return "\n".join(out)


known_ends = list(dict.fromkeys(ends + (["common"] if layout == "by-end" and "common" not in ends else [])))
end_table = "\n".join(
    f"| {e} | [index.md]({e}/index.md) | {e} 端知识（架构 / 规范 / 踩坑 / 最佳实践） | — |" for e in known_ends)
flat_rows = "\n".join(
    f"| — | [{c}/]({c}/) | {c}：{'架构、目录、启动流程、数据模型' if c == 'architecture' else '规范与开发指南' if c == 'guides' else '踩坑与 Bug 复盘' if c == 'troubleshooting' else '最佳实践与性能优化'} | 初始化 |"
    for c in CATS)


def render(tpl: str, extra: dict | None = None) -> str:
    s = (assets / tpl).read_text(encoding="utf-8")
    if layout == "by-end":
        know_paths = "`docs/knowledge/<端>/{architecture,guides,troubleshooting,best-practices}/`（端 = " + "、".join(known_ends) + "）"
        know_indexes = "分端 `docs/knowledge/<端>/index.md` + 根 `docs/knowledge/index.md` 两级"
        know_tree = ("<端>/                # 按端聚合（" + " / ".join(known_ends) + "）\n"
                     "│       ├── README.md · index.md\n"
                     "│       └── {architecture,guides,troubleshooting,best-practices}/")
        new_know_cmd = "bash .knowlog/new-knowledge.sh <端> <分类> <kebab-name> \"<一句话说明>\""
        layout_desc = "**by-end（多端项目）**：知识按端聚合（" + "、".join(known_ends) + "）── 各端知识基本不通用，混在一起会互相淹没"
    else:
        know_paths = "`docs/knowledge/{architecture,guides,troubleshooting,best-practices}/`（flat：单面项目不分端）"
        know_indexes = "根 `docs/knowledge/index.md` 一级"
        know_tree = ("{architecture,guides,troubleshooting,best-practices}/   # flat：四个分类直接放这里\n"
                     "│       └── <kebab-name>.md")
        new_know_cmd = "bash .knowlog/new-knowledge.sh --flat <分类> <kebab-name> \"<一句话说明>\""
        layout_desc = "**flat（单面项目）**：只有一个「面」（一个服务/CLI/管道），知识按分类放，不造端层"

    mapping = {
        "__PROJECT__": name, "__DATE__": date, "__ENDS__": " / ".join(ends) if layout == "by-end" else "（无端层：flat 布局）",
        "__LAYOUT_DESC__": layout_desc, "__KNOW_PATHS__": know_paths,
        "__KNOW_INDEXES__": know_indexes, "__KNOW_TREE__": know_tree, "__NEW_KNOW_CMD__": new_know_cmd,
        "__END_DIRS__": (", ".join(f"{e}/" for e in known_ends) if layout == "by-end" else ", ".join(f"{c}/" for c in CATS)),
        "__END_TABLE__": end_table if layout == "by-end" else flat_rows,
        "__END_SECTIONS__": end_sections_for(known_ends) if layout == "by-end" else "",
        "__LAYOUT__": layout,
    }
    if extra:
        mapping.update(extra)
    for k, v in mapping.items():
        s = s.replace(k, v)
    return s


# ---------- 1. 目录树 ----------
dirs = ["docs/daily", "docs/agents", "docs/templates", "docs/domain context", "docs/knowledge", TOOL]
if layout == "by-end":
    for e in known_ends:
        for c in CATS:
            dirs.append(f"docs/knowledge/{e}/{c}")
else:
    for c in CATS:
        dirs.append(f"docs/knowledge/{c}")
for d in dirs:
    if dry:
        continue
    (root / d).mkdir(parents=True, exist_ok=True)
# 空目录不被 git 跟踪 → 别人 clone 后结构 checker 会退化成告警，所以放占位文件
KEEP_DIRS = [d for d in dirs if d.startswith("docs/knowledge/") and d.count("/") >= 2]
for d in KEEP_DIRS:
    if not any((root / d).iterdir()):
        (root / d / ".gitkeep").write_text("", encoding="utf-8")
notes.append(f"目录：{len(dirs)} 个（已存在的不动；空的分类目录放了 .gitkeep）")

# ---------- 2. 文档骨架 ----------
put("docs/index.md", render("daily-index.md.tmpl"))
put("docs/README.md", render("daily-README.md.tmpl"))
put("docs/template.md", render("daily-template.md.tmpl"))
put("docs/templates/knowledge-doc.md", render("knowledge-doc.md.tmpl"))
put("docs/knowledge/.keyword-map.json", render("keyword-map.json.tmpl"))
put("docs/domain context/README.md", render("domain-readme.md.tmpl"))
put("docs/agents/domain.md", render("agents-domain.md.tmpl"))
put("docs/agents/issue-tracker.md", render("agents-issue-tracker.md.tmpl"))
put("docs/agents/triage-labels.md", render("agents-triage-labels.md.tmpl"))
if layout == "by-end":
    put("docs/knowledge/README.md", render("knowledge-root-README.md.tmpl"))
    put("docs/knowledge/index.md", render("knowledge-root-index.md.tmpl"))
    for e in known_ends:
        put(f"docs/knowledge/{e}/README.md", render("knowledge-end-README.md.tmpl", {"__END__": e}))
        put(f"docs/knowledge/{e}/index.md", render("knowledge-end-index.md.tmpl", {"__END__": e}))
else:
    put("docs/knowledge/README.md", render("knowledge-flat-README.md.tmpl"))
    put("docs/knowledge/index.md", render("knowledge-flat-index.md.tmpl"))
    for c in CATS:
        put(f"docs/knowledge/{c}/README.md", render("knowledge-flat-category-README.md.tmpl",
                                                   {"__CAT__": c, "__CAT_DESC__": {
                                                       "architecture": "架构、目录结构、启动流程、数据模型",
                                                       "guides": "规范与开发指南（接口约定、错误处理、部署）",
                                                       "troubleshooting": "踩坑与 Bug 复盘（症状 → 根因 → 修法 → 判据）",
                                                       "best-practices": "最佳实践与性能优化"}[c]}))

# ---------- 3. 脚本 + 资产（自包含：复制到项目后仍可独立运行） ----------
SCRIPTS = ["bootstrap-docs.sh", "adopt-docs.sh", "new-daily-log.sh", "check-daily-index.sh",
           "check-docs-structure.sh", "docs-doctor.sh", "new-knowledge.sh",
           "check-knowledge-index.sh", "reindex-knowledge.sh", "new-keyword.sh", "knowledge-retrieve.sh",
           "install-recall.sh", "install-skill.sh", "package-skill.sh", "check-secrets.sh",
           "index-util.py", "recall-core.py"]

dst_dir = root / TOOL
legacy = root / ".knowlog"
FORCE = os.environ.get("FORCE_SCRIPTS") == "1"
RESYNC = os.environ.get("RESYNC") == "1"          # 默认自动同步（由插件决定，不问用户）

SRC_VERSION_FILE = srcdir.parent / "VERSION"
SRC_VERSION = SRC_VERSION_FILE.read_text(encoding="utf-8").strip() if SRC_VERSION_FILE.exists() else ""
BUNDLE_VERSION = ""
if (dst_dir / "VERSION").exists():
    BUNDLE_VERSION = (dst_dir / "VERSION").read_text(encoding="utf-8").strip()


# ---------- 迁移：老项目的 scripts/（仅搬 knowlog 名下资产，业务脚本原样留下） ----------
migrated = 0
if (legacy / "bootstrap-docs.sh").exists() and (legacy / "assets").is_dir():
    if not dry:
        dst_dir.mkdir(parents=True, exist_ok=True)
    for item in sorted(legacy.iterdir()):
        if item.name in SCRIPTS or item.name in {"assets", "adapters", "VERSION", "_paths.sh"}:
            target = dst_dir / item.name
            if not target.exists():
                if not dry:
                    shutil.move(str(item), str(target))
                migrated += 1
    if migrated:
        notes.append(f"迁移：旧 scripts/ → {TOOL}/（{migrated} 项；只搬 knowlog 名下文件，业务脚本原样留在原处）")
        # assets 刚被搬走 → 本次渲染必须改用新位置（否则 render() 会读旧路径直接崩）
        if str(assets).startswith(str(legacy)):
            assets = dst_dir / "assets"
    if not dry:
        try:
            rest = [x for x in legacy.iterdir() if not x.name.startswith("._") and x.name != ".DS_Store"]
            if not rest:
                legacy.rmdir()                 # 只剩空壳才删；有用户文件就保留
                notes.append("迁移：空的 scripts/ 已移除（避免与业务目录混淆）")
        except Exception:
            pass

# ---------- 脚本同步（默认自动：bundle 版本 ≠ skill 版本 就整体更新） ----------
same_src_dir = srcdir.resolve() == dst_dir.resolve()
auto_sync = RESYNC and (BUNDLE_VERSION != SRC_VERSION)
updated = 0
skipped_scripts = 0
for s in SCRIPTS:
    src = srcdir / s
    dst = dst_dir / s
    if not src.exists():
        notes.append(f"⚠️ 资产缺失：{s}（跳过）"); continue
    if same_src_dir:
        notes.append("ℹ️ 来源就是项目自己的 .knowlog，无需自拷（升级请从已安装的 skill 跑）")
        break
    try:
        content = transform(src.read_text(encoding="utf-8"))
        data = content.encode("utf-8")
    except UnicodeDecodeError:
        data = src.read_bytes()
    if dst.exists():
        try:
            same = dst.read_text(encoding="utf-8", errors="replace") == content
        except Exception:
            same = dst.read_bytes() == data
        if same:
            skipped_scripts += 1
            continue
        if not (auto_sync or FORCE):
            notes.append(f"⚠️ {TOOL}/{s} 内容不同但版本一致 → 保留（--force-scripts 可强制覆盖）")
            continue
        if not dry:
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(data)
            os.chmod(dst, dst.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        updated += 1
        continue
    if not dry:
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)
        os.chmod(dst, dst.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    created.append(f"{TOOL}/{s}")

if updated:
    created.append(f"{TOOL}/（自动同步 {updated} 个脚本：{BUNDLE_VERSION or '无版本'} → {SRC_VERSION or '未知'}）")

# 版本戳：下次靠它判断“要不要自动同步”
if SRC_VERSION and (not (dst_dir / "VERSION").exists()
                    or (dst_dir / "VERSION").read_text(encoding="utf-8").strip() != SRC_VERSION):
    if not dry:
        (dst_dir / "VERSION").write_text(SRC_VERSION + "\n", encoding="utf-8")
    created.append(f"{TOOL}/VERSION（{SRC_VERSION}）")

# assets 自包含副本（供复制后的 bootstrap 独立运行；模板里的 scripts/ 也要改成 .knowlog/）
asset_dst = dst_dir / "assets"
if assets.resolve() != asset_dst.resolve():
    if dry:
        created.append(f"{TOOL}/assets/（模板副本）")
    else:
        asset_dst.mkdir(parents=True, exist_ok=True)
        n = 0
        for f in sorted(assets.glob("*.tmpl")):
            t = asset_dst / f.name
            try:
                content = transform(f.read_text(encoding="utf-8")).encode("utf-8")
            except UnicodeDecodeError:
                content = f.read_bytes()
            if not t.exists() or t.read_bytes() != content:
                t.write_bytes(content); n += 1
        if n:
            created.append(f"{TOOL}/assets/（{n} 个模板更新）")

if not dry:
    extra_src = srcdir.parent / "adapters"
    extra_dst = dst_dir / "adapters"
    if extra_src.is_dir():
        if not extra_dst.exists():
            shutil.copytree(extra_src, extra_dst)
            created.append(f"{TOOL}/adapters/（各 agent 适配器）")
        elif RESYNC:
            # 适配器同样是 knowlog 资产（桥接/钩子本体）：内容不同就更新，否则旧项目会继续用旧桥接
            n = 0
            for f in sorted(extra_src.rglob("*")):
                if f.is_dir() or f.name.startswith("._") or f.name == ".DS_Store" \
                        or "__pycache__" in f.parts or f.suffix == ".pyc":
                    continue
                t = extra_dst / f.relative_to(extra_src)
                if not t.exists() or t.read_bytes() != f.read_bytes():
                    t.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(f, t); n += 1
            if n:
                created.append(f"{TOOL}/adapters/（{n} 个文件同步）")

# ---------- 4. 约束：托管块（规则）+ 手工维护区（路由表，只创建一次） ----------
put_block_managed("AGENTS.md", render("agents-block.md.tmpl"),
                  preamble=f"# {name} — Agent 指南\n\n")
# 判据要宽：项目可能已有手工写的路由节，标题形如「## 🧭 Domain Context Routing (业务领域上下文路由)」，
# 这时候不能再造一个（会变成两份路由表）
ensure_unmanaged_section("AGENTS.md", r"^##[^\n]*🧭[^\n]*(路由|Domain Context Routing)",
                         render("agents-routing-section.md.tmpl"))

# ---------- 报告 ----------
print(f"✅ 新建/更新 {len(created)} 项")
for c in created:
    print(f"   + {c}")
if skipped:
    print(f"⏭️  跳过（已存在，未覆盖）{len(skipped)} 项")
    for s in skipped[:10]:
        print(f"   = {s}")
    if len(skipped) > 10:
        print(f"   … 另有 {len(skipped) - 10} 项")
for n in notes:
    print(f"ℹ️  {n}")
PY

if [ "$DRY" -eq 0 ]; then
  TOOL="$ROOT/.knowlog"; [ -d "$TOOL" ] || TOOL="$ROOT/scripts"
  if [ "$WITH_RECALL" -eq 1 ] && [ -f "$TOOL/install-recall.sh" ]; then
    echo
    echo "🔌 安装关键词召回适配器（按本机检测到的 agent）"
    bash "$TOOL/install-recall.sh" --root "$ROOT" --agent auto
  fi
  echo
  echo "🔎 自检："
  if [ -f "$TOOL/check-daily-index.sh" ]; then bash "$TOOL/check-daily-index.sh" --root "$ROOT" || true; fi
  if [ -f "$TOOL/check-knowledge-index.sh" ]; then bash "$TOOL/check-knowledge-index.sh" --root "$ROOT" || true; fi
  echo
  echo "下一步："
  echo "  1. 记日志：bash ${TOOL#$ROOT/}/new-daily-log.sh <slug>"
  echo "  2. 沉淀：bash ${TOOL#$ROOT/}/new-knowledge.sh <端|--flat> <分类> <name> \"<说明>\" --source <日志路径>"
  echo "  3. 召回：bash ${TOOL#$ROOT/}/new-keyword.sh \"<正则>\" \"<提示>\" \"<文档>\"（并 install-recall.sh 装到各 agent）"
  echo "  4. 门禁：bash ${TOOL#$ROOT/}/check-daily-index.sh --strict && bash ${TOOL#$ROOT/}/check-knowledge-index.sh --strict"
  echo "  5. 既有异构文档：bash ${TOOL#$ROOT/}/adopt-docs.sh（先看计划，再 --apply）"
fi
