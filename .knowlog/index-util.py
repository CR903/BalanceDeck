#!/usr/bin/env python3
"""index-util.py — 日志索引（docs/index.md）的插入原语

为什么单独抽出来：`new-daily-log.sh`（日常记录）和 `adopt-docs.sh`（迁移既有日志）都要往
同一个索引里插行，且规则一样（年内月份降序、月内日期升序、缺 section 就建）。
两处各写一份必然漂移 —— 索引格式一漂移，门禁就会开始误报，人就开始绕过门禁。

用法：
  python3 .knowlog/index-util.py upsert --index docs/index.md --date 2026-10-17 \
      --rel daily/2026-10/2026-10-17_fix-x.md --cells "10-17-fix-x|待回填|待提交|待回填"
  python3 .knowlog/index-util.py list-months --index docs/index.md
退出码：0 成功；2 参数/文件问题
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

HEADER = [
    "| 日期 | 任务 | 工作内容 | 提交 | 备注 |",
    "|------|------|----------|------|------|",
]


def read(path: pathlib.Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines()


def write(path: pathlib.Path, lines: list[str]) -> None:
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def table_range(lines: list[str], month: str):
    head = next(
        (
            i
            for i, l in enumerate(lines)
            if re.match(rf"^###\s+{re.escape(month)}\s*$", l)
        ),
        None,
    )
    if head is None:
        return None
    sep = next(
        (
            j
            for j in range(head + 1, min(head + 7, len(lines)))
            if lines[j].lstrip().startswith("|------")
        ),
        None,
    )
    if sep is None:
        return None
    first, last = sep + 1, sep
    for j in range(first, len(lines)):
        if not lines[j].lstrip().startswith("|"):
            break
        last = j
    return (first, last)


def upsert(index: pathlib.Path, date: str, rel: str, cells: list[str]) -> str:
    month, year = date[:7], date[:4]
    row = f"| [{date}]({rel}) | " + " | ".join(cells) + " |"
    lines = read(index)
    if any(f"({rel})" in l for l in lines):
        return f"已存在，跳过（{rel}）"
    out = list(lines)
    rng = table_range(lines, month)
    if rng:
        first, last = rng
        pos = last + 1
        for j in range(first, last + 1):
            m = re.search(r"^\|\s*\[(\d{4}-\d{2}-\d{2})\]", lines[j])
            if m and m.group(1) > date:
                pos = j
                break
        out.insert(pos, row)
        write(index, out)  # ← 必须落盘：早先漏了这一行，行被静默丢弃
        return f"### {month} 表格（按日期升序落位）"

    block = [f"### {month}", ""] + HEADER + [row, ""]
    pos = None
    for i, l in enumerate(lines):
        m = re.match(r"^###\s+(\d{4})-(\d{2})\s*$", l)
        if m and f"{m.group(1)}-{m.group(2)}" < month:
            pos = i          # 插到第一个"更老的月份"之前（年内降序）
            break
    if pos is None:
        # 没有更老的月份 → 说明我们在补一个"最老的月份"：应落到最后一个月份 section 之后，
        # 而不是插到年份标题下面（那样会变成升序，与"年内降序"约定不符）
        month_starts = [i for i, l in enumerate(lines) if re.match(r"^###\s+\d{4}-\d{2}\s*$", l)]
        if month_starts:
            j = max(month_starts) + 1
            while j < len(lines) and not lines[j].startswith("## "):
                j += 1
            pos = j
    if pos is None:
        # 只有"全新索引（还没有任何月份 section）"才走年份标题分支；
        # 否则上面已经把 pos 定好了，这里若再覆盖就会退回升序（真实 bug）
        yh = next(
            (
                i
                for i, l in enumerate(lines)
                if re.match(rf"^##\s+.*{re.escape(year)}", l)
            ),
            None,
        )
        if yh is not None:
            pos = yh + 1
            while pos < len(out) and out[pos].strip() == "":
                pos += 1
        else:
            tail = next(
                (
                    i
                    for i, l in enumerate(lines)
                    if re.match(r"^##\s+(?!.*\d{4})(?!.*📅)", l)
                ),
                None,
            )
            block = [f"## 📅 {year}年", ""] + block
            pos = tail if tail is not None else len(lines)
    out[pos:pos] = block
    write(index, out)
    return f"新建 ### {month} 表格（年内按月份降序落位）"


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    u = sub.add_parser("upsert")
    u.add_argument("--index", required=True)
    u.add_argument("--date", required=True)
    u.add_argument("--rel", required=True)
    u.add_argument(
        "--cells", required=True, help="用 | 分隔的单元格：任务|工作内容|提交|备注"
    )
    l = sub.add_parser("list-months")
    l.add_argument("--index", required=True)
    args = ap.parse_args()

    idx = pathlib.Path(args.index)
    if not idx.exists():
        print(f"❌ 索引不存在：{idx}", file=sys.stderr)
        return 2
    if args.cmd == "list-months":
        months = re.findall(
            r"^###\s+(\d{4}-\d{2})\s*$", idx.read_text(encoding="utf-8"), re.M
        )
        print(json.dumps(months, ensure_ascii=False))
        return 0
    cells = args.cells.split("|")
    print(upsert(idx, args.date, args.rel, cells))
    return 0


if __name__ == "__main__":
    sys.exit(main())
