#!/bin/bash
# check-daily-index.sh — 校验「日志 ↔ docs/index.md」双向一致 + 路径格式
#
# 三个不变量：
#   1. 目录月 == 文件名月（月份取日志日期所在月）
#   2. 每篇日志在 docs/index.md 有且仅有一行
#   3. 每条索引链接都指向真实文件，且所在的年月表格 == 文件所在月
#
# 用法：
#   bash .knowlog/check-daily-index.sh              # 报告；有 ERROR → 退出码 1
#   bash .knowlog/check-daily-index.sh --strict     # 告警也算失败（接 CI / 收尾门禁用这个）
#   bash .knowlog/check-daily-index.sh --fix-hint   # 额外打印可执行的修复建议
#   bash .knowlog/check-daily-index.sh --root DIR
#
# 历史遗留目录（早期「按日流水日志」未登记索引的月份）可用 LEGACY_MONTHS="2026-04 2026-05" 豁免为告警。
set -euo pipefail

ROOT=""
STRICT=0
FIX_HINT=0
GH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --root=*) ROOT="${1#--root=}"; shift ;;
    --strict) STRICT=1; shift ;;
    --fix-hint) FIX_HINT=1; shift ;;
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

export ROOT STRICT FIX_HINT
export LEGACY_MONTHS="${LEGACY_MONTHS:-}"

python3 - <<'PY'
import os, re, sys, pathlib

def junk(name: str) -> bool:
    """macOS 在 exFAT/网络卷上会为每个文件生成 ._xxx 影子文件；系统垃圾也不算文档。"""
    return name.startswith("._") or name in {".DS_Store"} or name.startswith(".Spotlight")

root = pathlib.Path(os.environ["ROOT"])
daily = root / "docs" / "daily"
index = root / "docs" / "index.md"
legacy = set(os.environ["LEGACY_MONTHS"].split())
strict = os.environ["STRICT"] == "1"
fix_hint = os.environ["FIX_HINT"] == "1"

errors, warns, hints = [], [], []
FILE_RE = re.compile(r"^(\d{4})-(\d{2})-\d{2}_.+\.md$")
MONTH_DIR_RE = re.compile(r"^(\d{4})-(\d{2})$")

if not daily.is_dir():
    print(f"❌ 未找到 {daily.relative_to(root)}（新项目先跑：bash .knowlog/bootstrap-docs.sh）")
    sys.exit(1)

# ---------- 1. 采集磁盘上的日志 ----------
files = {}
for month_dir in sorted(p for p in daily.iterdir() if p.is_dir()):
    md = MONTH_DIR_RE.match(month_dir.name)
    if not md:
        for f in sorted(p for p in month_dir.glob("*.md") if not junk(p.name)):
            errors.append((f"daily/{month_dir.name}/{f.name}", "目录名不合规范（应为 YYYY-MM）"))
        continue
    dir_month = month_dir.name
    for f in sorted(p for p in month_dir.glob("*.md") if not junk(p.name)):
        rel = f"daily/{dir_month}/{f.name}"
        m = FILE_RE.match(f.name)
        if not m:
            errors.append((rel, "文件名不合规范（应为 YYYY-MM-DD_<kebab-slug>.md，不要中文/空格）"))
            files[rel] = None
            continue
        file_month = f"{m.group(1)}-{m.group(2)}"
        files[rel] = file_month
        if file_month != dir_month:
            errors.append((rel, f"目录月({dir_month}) ≠ 文件名月({file_month})：跨月补写按日志日期归月"))
            hints.append(f"mkdir -p docs/daily/{file_month} && git mv docs/{rel} docs/daily/{file_month}/{f.name}"
                         f"   # 再改 docs/index.md 的链接与所在表格")
for f in sorted(p for p in daily.glob("*.md") if not junk(p.name)):
    rel = f"daily/{f.name}"
    errors.append((rel, "日志散落在 daily/ 根：必须放进 daily/<YYYY-MM>/"))
    m = FILE_RE.match(f.name)
    if m:
        hints.append(f"mkdir -p docs/daily/{m.group(1)}-{m.group(2)} && git mv docs/{rel} "
                     f"docs/daily/{m.group(1)}-{m.group(2)}/{f.name}")

# ---------- 2. 解析 index.md ----------
links = {}
if not index.exists():
    errors.append(("docs/index.md", "索引文件不存在"))
else:
    text = index.read_text(encoding="utf-8").splitlines()
    cur_month = None
    for i, line in enumerate(text, 1):
        m = re.match(r"^###\s+(\d{4}-\d{2})\s*$", line.strip())
        if m:
            cur_month = m.group(1)
        for link in re.findall(r"\]\((daily/[^)\s]+?\.md)\)", line):
            links.setdefault(link, []).append((cur_month, i))
            parts = link.split("/")
            if not (len(parts) > 1 and MONTH_DIR_RE.match(parts[1])):
                errors.append((link, f"docs/index.md:{i} 链接仍是旧扁平路径（应为 daily/<YYYY-MM>/…）"))
                fn = os.path.basename(link)
                mm = FILE_RE.match(fn)
                if mm:
                    hints.append(f"docs/index.md:{i} 改为 ](daily/{mm.group(1)}-{mm.group(2)}/{fn})")

# ---------- 2.5 占位残留：行存在但没填（原门禁查不出，导致"待回填"能长期常绿） ----------
PLACEHOLDERS = ("待回填",)
if index.exists():
    for i, line in enumerate(index.read_text(encoding="utf-8").splitlines(), 1):
        if not line.lstrip().startswith("|") or "](daily/" not in line:
            continue
        hit = [ph for ph in PLACEHOLDERS if ph in line]
        if hit:
            m = re.search(r"\]\((daily/[^)]+)\)", line)
            warns.append((m.group(1) if m else f"docs/index.md:{i}",
                          f"索引行仍含占位「{'/'.join(hit)}」（第 {i} 行）—— 建了日志就该把它填实"))
            hints.append(f"把 docs/index.md:{i} 的占位换成真实内容（工作内容 / 提交 / 备注）")

# ---------- 3. 双向比对 ----------
for rel, file_month in sorted(files.items()):
    entry = links.get(rel)
    if not entry:
        msg = "docs/index.md 中无对应索引行"
        if file_month in legacy:
            warns.append((rel, msg + "（历史遗留月，豁免）"))
        else:
            errors.append((rel, msg))
            hints.append(f"在 docs/index.md 的 ### {file_month} 表格追加一行：| [..]({rel}) | .. |")
        continue
    if len(entry) > 1:
        errors.append((rel, "docs/index.md 有 %d 行重复索引（第 %s 行）"
                       % (len(entry), ", ".join(str(ln) for _, ln in entry))))
    for table_month, ln in entry:
        if file_month and table_month and table_month != file_month:
            errors.append((rel, f"docs/index.md:{ln} 所在表格月({table_month}) ≠ 文件月({file_month})"))
            hints.append(f"把 docs/index.md:{ln} 这一行移到 ### {file_month} 表格下")

for rel, entry in sorted(links.items()):
    if not (root / "docs" / rel).exists():
        for _, ln in entry:
            errors.append((rel, f"docs/index.md:{ln} 死链：文件不存在"))
        hints.append(f"docs/index.md:{entry[0][1]} 删除该行，或修正链接/恢复文件")


def dump(title, items, mark):
    if not items:
        return
    print(f"\n{mark} {title}（{len(items)}）")
    for path, why in items:
        print(f"  - {path}\n      {why}")


print("📒 check-daily-index — 日志 ↔ docs/index.md 一致性")
print(f"   日志 {len(files)} 篇 · 索引 {len(links)} 条" + (f" · 豁免月 {' '.join(sorted(legacy))}" if legacy else ""))
dump("错误", errors, "❌")
dump("警告", warns, "⚠️ ")
if fix_hint and hints:
    print("\n🔧 修复建议")
    for h in sorted(set(hints)):
        print(f"  $ {h}")

if errors or (strict and warns):
    print(f"\n失败：{len(errors)} 错误" + (f" + {len(warns)} 警告（--strict）" if strict and warns else ""))
    sys.exit(1)
print(f"\n✅ 通过：{len(files)} 篇日志与索引双向一致" + (f"（{len(warns)} 条遗留告警）" if warns else ""))
PY
