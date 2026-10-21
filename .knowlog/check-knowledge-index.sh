#!/bin/bash
# check-knowledge-index.sh — 校验「知识文档 ↔ 索引」一致性（支持 by-end 两级 与 flat 单级两种布局）
#
# 为什么需要它：日志有 check-daily-index.sh 把关，但知识库常年在悄悄漂移 ——
# 文档加了没登记、索引链接指空、两级索引只更新了一级。漂移之后"按需召回"就召不到东西，
# 知识库退化成"没人翻的文件夹"。
#
# 用法：
#   bash .knowlog/check-knowledge-index.sh [--strict] [--fix-hint] [--root DIR]
#   --strict：把"告警"也算失败（建议接 CI）
set -euo pipefail

ROOT=""; STRICT=0; FIX=0
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --root=*) ROOT="${1#--root=}"; shift ;;
    --strict) STRICT=1; shift ;;
    --fix-hint) FIX=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
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
export ROOT STRICT FIX

python3 - <<'PY'
import os, pathlib, re, sys

def junk(name: str) -> bool:
    """macOS 在 exFAT/网络卷上会为每个文件生成 ._xxx 影子文件；系统垃圾也不算文档。"""
    return name.startswith("._") or name in {".DS_Store"} or name.startswith(".Spotlight")

root = pathlib.Path(os.environ["ROOT"]); KNOW = root / "docs" / "knowledge"
strict = os.environ["STRICT"] == "1"; fix = os.environ["FIX"] == "1"
CATS = ["architecture", "guides", "troubleshooting", "best-practices"]
errors, warns, hints = [], [], []

if not KNOW.is_dir():
    print("❌ 未找到 docs/knowledge/（先跑 bootstrap-docs.sh）"); sys.exit(1)


def links_of(p: pathlib.Path) -> list[str]:
    if not p.exists():
        return []
    return re.findall(r"\]\(([^)\s]+?\.md)\)", p.read_text(encoding="utf-8"))


def docs_in(d: pathlib.Path) -> list[pathlib.Path]:
    out = []
    for c in CATS:
        if (d / c).is_dir():
            out += [p for p in sorted((d / c).glob("*.md"))
                    if p.name != "README.md" and not junk(p.name)]
    return out


# 布局判定：docs/knowledge/<X>/ 里出现 index.md 且 X 不是分类名 → by-end；否则 flat
end_dirs = [d for d in sorted(KNOW.iterdir())
            if d.is_dir() and not junk(d.name) and d.name not in CATS and (d / "index.md").exists()]
layout = "by-end" if end_dirs else "flat"
root_index = KNOW / "index.md"
root_links = [l.split("#")[0] for l in links_of(root_index)]
root_index_text = root_index.read_text(encoding="utf-8") if root_index.exists() else ""

if layout == "by-end":
    for end in end_dirs:
        rel_prefix = f"{end.name}/"
        # 1) 文档 → 分端索引
        for p in docs_in(end):
            rel = f"{p.parent.name}/{p.name}"
            if rel not in links_of(end / "index.md"):
                errors.append((f"knowledge/{end.name}/{rel}", "分端索引中无对应行"))
                hints.append(f"在 docs/knowledge/{end.name}/index.md 的 「## {p.parent.name}」表格追加：| [{p.name}]({rel}) | <说明> | <来源> |")
            # 2) 文档 → 根索引（缺失只告警：历史文档可能没登记）
            from_root = f"{rel_prefix}{rel}"
            if from_root not in root_links and f"{end.name}/{p.parent.name}/{p.name}" not in root_index_text:
                warns.append((f"knowledge/{from_root}", "根索引 docs/knowledge/index.md 中未登记"))
                hints.append(f"bash .knowlog/new-knowledge.sh {end.name} {p.parent.name} {p.stem} \"<说明>\"  # 会补登记（重跑前先删同名文档或用 --source 手补）")
        # 3) 分端索引 → 文档
        for l in links_of(end / "index.md"):
            if "#" in l:
                l = l.split("#")[0]
            if not (end / l).exists():
                errors.append((f"knowledge/{end.name}/index.md", f"死链：{l}"))
else:
    for p in docs_in(KNOW):
        rel = f"{p.parent.name}/{p.name}"
        if rel not in root_links:
            errors.append((f"knowledge/{rel}", "根索引 docs/knowledge/index.md 中无对应行"))
            hints.append(f"在 docs/knowledge/index.md 的 「## {p.parent.name}」表格追加：| [{p.name}]({rel}) | <说明> | <来源> |")
    for l in root_links:
        if re.match(rf"^({'|'.join(CATS)})/", l) and not (KNOW / l).exists():
            errors.append(("knowledge/index.md", f"死链：{l}"))

# 根索引死链（两种布局都查）
for l in root_links:
    if not l.startswith(("http", "/")) and not (KNOW / l).exists() and not l.endswith("index.md"):
        warns.append(("knowledge/index.md", f"链接指向不存在的文件：{l}"))

print(f"📗 check-knowledge-index — 知识文档 ↔ 索引一致性（布局：{layout}）")
if layout == "by-end":
    print(f"   端：{', '.join(d.name for d in end_dirs)} · 文档 "
          f"{sum(len(docs_in(d)) for d in end_dirs)} 篇")
else:
    print(f"   flat 布局 · 文档 {len(docs_in(KNOW))} 篇")


def dump(title, items, mark):
    if items:
        print(f"\n{mark} {title}（{len(items)}）")
        for path, why in items:
            print(f"  - {path}\n      {why}")


dump("错误", errors, "❌")
dump("告警", warns, "⚠️ ")
if fix and hints:
    print("\n🔧 修复建议")
    for h in sorted(set(hints))[:12]:
        print(f"  $ {h}")

if errors or (strict and warns):
    print(f"\n失败：{len(errors)} 错误" + (f" + {len(warns)} 告警（--strict）" if strict and warns else ""))
    sys.exit(1)
print(f"\n✅ 通过：知识文档与索引一致" + (f"（{len(warns)} 条告警）" if warns else ""))
PY
