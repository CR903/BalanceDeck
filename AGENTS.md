# AGENTS.md — BalanceDeck Master Architecture & Global Rules

永远用中文回答

### 📝 开发日志规范（根唯一 · Trellis 门禁）

- **唯一入口**：所有开发日志统一归集于 **根 `docs/daily/`**。
- **结构四件套**：根 `docs/` 下 `daily/`（日志）+ `index.md`（唯一索引）+ `README.md`（使用指南）+ `template.md`（任务模板）与 `domain context/`、`agents/`、`knowledge/` 并列。
- **命名与粒度**：按 **Trellis 任务**一任务一日志，命名 `YYYY-MM-DD_<slug>.md`（`<slug>` 与 `.trellis/tasks/<slug>/` 同名，kebab-case），例 `2026-09-02_instorebatch-flow-memo.md`。历史按日日志（2026-04~05）保留不重命名。
- **门禁**：`task.py archive` / `/trellis:finish-work` 前**必须**完成日志（`docs/daily/YYYY-MM-DD_<slug>.md`）+ 索引更新（`docs/index.md` 对应年月表格追加一行），否则视为未完成；有可沉淀知识需同步更新 `docs/knowledge/` 对应分类。详见 `docs/README.md`、`docs/template.md`。
- **P2 沉淀门禁（trellis-check 必检）**：`check` 阶段对照 `docs/knowledge/common/best-practices/daily-to-knowledge.md` 3 问 + PR Checklist 自检；日志含坑位/通用解法但 `knowledge/<端>/<分类>` + 两级 `index.md` 未更新 → **拦截 archive**（见 `docs/knowledge/common/best-practices/daily-to-knowledge.md`）。
- **检索**：`grep -rn "关键词" docs/daily/`；索引定位 `grep -n "2026-09" docs/index.md`。

<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->
