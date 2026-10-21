#!/usr/bin/env python3
"""docs-recall.py — 钩子薄壳（Claude Code 与 Codex 通用）

它自己不实现任何匹配逻辑，只做一件事：把宿主通过 stdin 传来的钩子 JSON 转交给
项目内的 `.knowlog/recall-core.py`（旧项目为 `scripts/recall-core.py`），再把结果按钩子契约输出到 stdout。

- Claude Code：注册在 `.claude/settings.json` 的 `hooks.UserPromptSubmit`
- Codex：注册在 `.codex/hooks.json` 的 `UserPromptSubmit`（契约同形）

安装位置由 `.knowlog/install-recall.sh` 决定：`.claude/hooks/docs-recall.py` 或 `.codex/hooks/docs-recall.py`。
"""

from __future__ import annotations

import pathlib
import runpy
import sys


def main() -> int:
    here = pathlib.Path(__file__).resolve()
    # .claude/hooks/ 或 .codex/hooks/ → 项目根
    root = here.parents[2] if len(here.parents) > 2 else here.parent
    core = root / ".knowlog" / "recall-core.py"
    if not core.exists():
        core = root / "scripts" / "recall-core.py"     # 兼容旧项目布局
    if not core.exists():  # 允许项目把 core 放在别处 / 未安装
        return 0
    sys.argv = [str(core), "--hook", "claude"]
    runpy.run_path(str(core), run_name="__main__")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)  # 钩子失败绝不阻断宿主
