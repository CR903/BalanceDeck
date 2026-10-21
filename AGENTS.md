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

<!-- KNOWLOG:START (由 knowlog skill 托管，手工改动请放在块外) -->
## 📝 开发日志规范（唯一索引 · 收尾门禁）

- **路径（写入即定月份）**：`docs/daily/<YYYY-MM>/YYYY-MM-DD_<slug>.md`；**月份取日志日期所在月**（跨月补写按日期归月）；不变量 = 目录月 == 文件名月 == `docs/index.md` 所在表格月。
- **新建**：`bash .knowlog/new-daily-log.sh <slug> [YYYY-MM-DD]` —— 自动落月份目录 + 在 `docs/index.md` 插入索引行骨架。**不要**手写散落在 `docs/daily/` 根的日志。
- **门禁**：任务收尾 / 提交前**必须**跑 `bash .knowlog/docs-doctor.sh --strict`（= 结构规范 + 日志↔索引 + 知识↔索引；缺索引行、死链、路径不符、布局混用、索引行没填 → 非零退出，红灯不许收摊）。
- **收尾清单（任务「完成」的定义）**：① 记日志；② 有可复用结论 → `bash .knowlog/new-knowledge.sh` 沉淀（**会自动挂召回规则**；门禁会拦"有知识却 0 条规则"）；③ 跑门禁至绿灯；④ 才允许对外宣称完成。
- **写什么**：给未来的自己/下一个人看 —— 为什么这么做、踩了什么坑、怎么证明是对的。不要复述 diff。

## 📚 知识库导航（结构化记忆）

- **布局**：**flat（单面项目）**：只有一个「面」（一个服务/CLI/管道），知识按分类放，不造端层
- **位置**：`docs/knowledge/{architecture,guides,troubleshooting,best-practices}/`（flat：单面项目不分端）
- **索引**：根 `docs/knowledge/index.md` 一级（新增后必须同步，脚本会自动做）
- **新增一篇**：`bash .knowlog/new-knowledge.sh --flat <分类> <kebab-name> "<一句话说明>"`（默认自动从来源日志里的代码标识符挂召回规则；用 `--keywords "a,b"` 显式指定更准，`--no-keyword` 表示不需要召回）
- **沉淀判断**：这条结论会被**重复踩**或**被反复问**吗？会 → 沉淀成知识；只是一次性任务细节 → 留在日志里就够了。
- **召回（非全量，按需）**：`bash .knowlog/knowledge-retrieve.sh "<prompt 或代码片段>"`；命中只给提示+路径，确认相关后再全量读该文档。
- **召回规则**：沉淀知识时**已自动挂**；手工补用 `bash .knowlog/new-keyword.sh "<正则>" "<提示>" "<文档路径>"`；正则要命中"写码当下"的标识符（函数名/字段/枚举/报错词），不要写自然语言标题。存量缺规则：`bash .knowlog/reindex-knowledge.sh --apply`。

## 🧭 领域上下文路由（业务长期记忆）

- 任务涉及某条业务线时，**必须首选全量加载**对应领域文档，严禁凭空编写（业务规则写错是最贵的错误：代码能跑、测试能过，但业务是错的）。
- **路由表在本文档的「## 🧭 领域上下文路由表（手工维护）」一节**（在托管块之外，不会被脚本覆盖）。
- 新增业务领域时：写一份 `docs/domain context/domain-<name>.md` → 在路由表补一行 → 更新 `docs/domain context/README.md`。

## 🔍 检索入口

```bash
grep -rn "关键词" docs/daily/ docs/knowledge/ "docs/domain context/"   # 日志 + 知识 + 领域
grep -n "关键词" docs/index.md docs/knowledge/index.md                 # 先查索引最快
```

> 若本仓同时使用其它 agent 入口文件（如 `CLAUDE.md`），在其中写一行指向本块即可，不要复制粘贴出第二份真相。
<!-- KNOWLOG:END -->

## 🧭 领域上下文路由表（手工维护）

> **这一节由人/agent 手工维护，bootstrap 只创建一次、之后永不改写**（与上面托管块相反，放这里就是为了不被覆盖）。
> 规则：任务涉及某条业务线时，**必须先全量加载**对应领域文档再动手 —— 业务规则写错是最贵的错误（代码能跑、测试能过，但业务是错的）。
> 新增业务线时：写一份 `docs/domain context/domain-<name>.md` → 在下表补一行 → 更新 `docs/domain context/README.md`。

| 业务关键词（含别名） | 领域文档 | 这份文档能防住什么错 |
|----------------------|----------|----------------------|
| （示例，按项目替换或删除）计费 / 账单 / 价格 | `/docs/domain context/domain-billing.md` | 例：阶梯计费与按次计费的切换条件 |
