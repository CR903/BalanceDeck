# Bootstrap Task: Fill Project Development Guidelines

**You (the AI) are running this task. The developer does not read this file.**

The developer just ran `trellis init` on this project for the first time.
`.trellis/` now exists with empty spec scaffolding, and this bootstrap task
exists under `.trellis/tasks/`. When they want to work on it, they should start
this task from a session that provides Trellis session identity.

**Your job**: help them populate `.trellis/spec/` with the team's real
coding conventions. Every future AI session — this project's
`trellis-implement` and `trellis-check` sub-agents — auto-loads spec files
listed in per-task jsonl manifests. Empty spec = sub-agents write generic
code. Real spec = sub-agents match the team's actual patterns.

Don't dump instructions. Open with a short greeting, figure out if the repo
has any existing convention docs (CLAUDE.md, .cursorrules, etc.), and drive
the rest conversationally.

---

## Status (update the checkboxes as you complete each item)

- [x] Fill frontend guidelines
- [x] Add code examples

**完成记录（2026-09-27）**

6 个文件全部从空壳填成真实规范，共约 3,150 行。做法与要求一致：
不照抄理想形态，而是**派 explore 子代理从代码里取证**（三个并行方向：渲染层、
类型与配置、`src/main` 与 `scripts/`），每条结论都带 `file:line` 与原文摘录。

写入前抽查了 **39 条最吃重的事实**（index.ts 行数、`as any` 恰好 4 处且全在一个 global、
`useMemo` 9 处、无 `React.memo`、无自定义 hook、`typecheck` 不在 `npm test` 里、
`test-structure` 的 `qa/` 目录闭集断言、…）—— 39/39 核实。抽查脚本本身也写错过一次
（把 `ui:hideBalance` 的编码猜成 `collapsed ? '1' : ''`，实际是 `next ? '1' : ''`），
说明这类校验值得做。产品代码零改动，typecheck + 10 套件 0 失败。

刻意记录的**不一致**（而不是悄悄抹平），因为它们是"别照抄这里"的信号：
两处独立 `AppState`、两处 skin 状态、三种 props 写法、三种严重度类名拼法、
`extras` 两种布尔编码（`'1'/'0'` vs `'1'/''`）、`quality.ts` 把 `DataQuality` 放宽成 `string`、
`Unit` 格式化在两处实现且对 `request` 的取整不同、5 处该用 `as unknown as {}` 却写了 `as any`、
`test-percent.mjs` 仍在测内联副本、`@shared/*` alias 声明了但无人使用、
`tsconfig.web.json` include 了一个不存在的文件。

`frontend/index.md` 顶部补了「最该知道的 4 件事」摘要，并说明语言约定
（本层英文，与既有 `spec/guides/` 一致；产品文档与 `adapters/` 层是中文，
这个不一致记在 index 里，留待后续统一）。

---

## Spec files to populate


### Frontend guidelines

| File | What to document |
|------|------------------|
| `.trellis/spec/frontend/directory-structure.md` | Component/page/hook organization |
| `.trellis/spec/frontend/component-guidelines.md` | Component patterns, props conventions |
| `.trellis/spec/frontend/hook-guidelines.md` | Custom hook naming, patterns |
| `.trellis/spec/frontend/state-management.md` | State library, patterns, what goes where |
| `.trellis/spec/frontend/type-safety.md` | TypeScript conventions, type organization |
| `.trellis/spec/frontend/quality-guidelines.md` | Linting, testing, accessibility |


### Thinking guides (already populated)

`.trellis/spec/guides/` contains general thinking guides pre-filled with
best practices. Customize only if something clearly doesn't fit this project.

---

## How to fill the spec

### Step 1: Import from existing convention files first (preferred)

Search the repo for existing convention docs. If any exist, read them and
extract the relevant rules into the matching `.trellis/spec/` files —
usually much faster than documenting from scratch.

| File / Directory | Tool |
|------|------|
| `CLAUDE.md` / `CLAUDE.local.md` | Claude Code |
| `AGENTS.md` | Codex / Claude Code / agent-compatible tools |
| `.cursorrules` | Cursor |
| `.cursor/rules/*.mdc` | Cursor (rules directory) |
| `.windsurfrules` | Windsurf |
| `.clinerules` | Cline |
| `.roomodes` | Roo Code |
| `.github/copilot-instructions.md` | GitHub Copilot |
| `.vscode/settings.json` → `github.copilot.chat.codeGeneration.instructions` | VS Code Copilot |
| `CONVENTIONS.md` / `.aider.conf.yml` | aider |
| `CONTRIBUTING.md` | General project conventions |
| `.editorconfig` | Editor formatting rules |

### Step 2: Analyze the codebase for anything not covered by existing docs

Scan real code to discover patterns. Before writing each spec file:
- Find 2-3 real examples of each pattern in the codebase.
- Reference real file paths (not hypothetical ones).
- Document anti-patterns the team clearly avoids.

### Step 3: Document reality, not ideals

**Critical**: write what the code *actually does*, not what it should do.
Sub-agents match the spec, so aspirational patterns that don't exist in the
codebase will cause sub-agents to write code that looks out of place.

If the team has known tech debt, document the current state — improvement
is a separate conversation, not a bootstrap concern.

---

## Quick explainer of the runtime (share when they ask "why do we need spec at all")

- Every AI coding task spawns two sub-agents: `trellis-implement` (writes
  code) and `trellis-check` (verifies quality).
- Each task has `implement.jsonl` / `check.jsonl` manifests listing which
  spec files to load.
- The platform hook auto-injects those spec files + the task's `prd.md`
  into every sub-agent prompt, so the sub-agent codes/reviews per team
  conventions without anyone pasting them manually.
- Source of truth: `.trellis/spec/`. That's why filling it well now pays
  off forever.

---

## Completion

When the developer confirms the checklist items above are done with real
examples (not placeholders), guide them to run:

```bash
python3 ./.trellis/scripts/task.py finish
python3 ./.trellis/scripts/task.py archive 00-bootstrap-guidelines
```

After archive, every new developer who joins this project will get a
`00-join-<slug>` onboarding task instead of this bootstrap task.

---

## Suggested opening line

"Welcome to Trellis! Your init just set me up to help you fill the project
spec — a one-time setup so every future AI session follows the team's
conventions instead of writing generic code. Before we start, do you have
any existing convention docs (CLAUDE.md, .cursorrules, CONTRIBUTING.md,
etc.) I can pull from, or should I scan the codebase from scratch?"
