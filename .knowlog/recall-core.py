#!/usr/bin/env python3
"""recall-core.py — 关键词召回的**唯一实现**（所有 agent 适配器都薄薄地调它）

为什么要有这个文件：各 agent 的注入机制完全不同（Claude/Codex 是 UserPromptSubmit 钩子、
OpenCode 是 TS 插件、DSH 是 cordis patch 层、Cursor/Gemini/Copilot 只有静态规则文件、
还有一堆 agent 什么机制都没有）。如果每个都实现一遍匹配逻辑，行为必然漂移。
所以：**匹配与渲染只在这里做**，适配器只负责"怎么把它送进上下文"。

用法：
  python3 .knowlog/recall-core.py --query "用户 prompt 或代码片段"        # 输出注入文本（命中才有输出）
  python3 .knowlog/recall-core.py --query "..." --format json-hook        # Claude Code / Codex 钩子输出
  python3 .knowlog/recall-core.py --hook claude                           # 从 stdin 读钩子 JSON，自动取 prompt
  cat prompt.txt | python3 .knowlog/recall-core.py                        # 从 stdin 读纯文本

设计要点（为什么这么写）：
- 触发源 = prompt + `git diff --cached`：很多坑是在"正要写的那段代码"里踩的，光看 prompt 会漏。
- 命中上限 4 条、只给 hint + 文档路径、不展开全文：控制在 ~800 token；确认相关后再全量读文件。
- 任何异常都安静退出 0：钩子/插件绝不能让宿主会话崩掉或刷屏。
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import subprocess
import sys

MAX_HITS = 4
MAX_DIFF = 8000


def find_root() -> pathlib.Path | None:
    """先按脚本位置（项目内 scripts/），再按 cwd 向上找带 keyword-map 的根。"""
    here = pathlib.Path(__file__).resolve()
    for base in [here, *here.parents]:
        if (base / "docs/knowledge/.keyword-map.json").exists():
            return base
    cur = pathlib.Path.cwd()
    for _ in range(6):
        if (cur / "docs/knowledge/.keyword-map.json").exists():
            return cur
        cur = cur.parent
    return None


def load_map(root: pathlib.Path) -> dict:
    try:
        data = json.loads(
            (root / "docs/knowledge/.keyword-map.json").read_text(encoding="utf-8")
        )
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def staged_diff(root: pathlib.Path) -> str:
    try:
        d = subprocess.check_output(
            ["git", "diff", "--cached"], cwd=root, text=True, timeout=2
        )
        return d[:MAX_DIFF]
    except Exception:
        return ""


def hook_prompt(fmt: str) -> str:
    """从宿主钩子的 stdin JSON 里取 prompt（Claude Code / Codex 的契约相同）"""
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except Exception:
        return ""
    if isinstance(data, dict):
        return str(data.get("prompt", "") or "")
    return ""


def main() -> int:
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--query", default="")
    ap.add_argument("--hook", default="")  # claude | codex
    ap.add_argument("--format", default="text", choices=["text", "json-hook"])
    ap.add_argument("--max-hits", type=int, default=MAX_HITS)
    ap.add_argument("-h", "--help", action="store_true")
    try:
        args, _ = ap.parse_known_args()
    except SystemExit:
        return 0
    if args.help:
        print(__doc__)
        return 0

    if args.hook:
        prompt = hook_prompt(args.hook)
        fmt = "json-hook"
    else:
        prompt = args.query
        fmt = args.format
    if not prompt.strip() and sys.stdin.isatty() is False and not args.query:
        try:
            prompt = sys.stdin.read()
        except Exception:
            prompt = ""
    if not prompt.strip():
        return 0

    root = find_root()
    if root is None:
        return 0
    mmap = load_map(root)
    if not mmap:
        return 0

    query = prompt + "\n" + staged_diff(root)
    hits = []
    for pat, meta in mmap.items():
        if not isinstance(meta, dict):
            continue
        try:
            if re.search(pat, query, re.IGNORECASE | re.MULTILINE):
                hits.append((pat, meta))
        except re.error:
            continue
    if not hits:
        return 0

    lines = [
        "<knowledge-auto> 命中本仓已沉淀的规范/坑点（关键词触发，非全量；需要时再全量加载）："
    ]
    for pat, meta in hits[: max(1, args.max_hits)]:
        lines.append(f"- `{pat}` → {meta.get('hint', '')}")
        for doc in meta.get("docs", [])[:1]:
            exists = (root / doc.split("#")[0]).exists()
            lines.append(f"  · {doc}" + ("" if exists else " (not found)"))
    lines.append(
        "提示：确认相关时用 Read 全量加载上述文档，不要凭记忆写。"
        '全量检索：`grep -rn 关键词 docs/knowledge/ docs/daily/ "docs/domain context/"`</knowledge-auto>'
    )
    text = "\n".join(lines)

    if fmt == "json-hook":
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "UserPromptSubmit",
                        "additionalContext": text,
                    }
                },
                ensure_ascii=False,
            )
        )
    else:
        print(text)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)  # 绝不因为召回失败拖垮宿主会话
