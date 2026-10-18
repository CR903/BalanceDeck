# 补齐 AGENTS.md 引用的门禁文档（template.md / README.md / daily-to-knowledge.md）

## Goal

把 `AGENTS.md` 里**引用了但仓库中不存在**的三个门禁文件补出来，让「开发日志规范」从"文档里写着"变成"照着能执行"。

## Background（确认事实）

`AGENTS.md` 的「开发日志规范（根唯一 · Trellis 门禁）」写着结构四件套
（`daily/` + `index.md` + `README.md` + `template.md`）与 P2 沉淀门禁
（`docs/knowledge/common/best-practices/daily-to-knowledge.md` 的「3 问 + PR Checklist」），但实测：

| 引用 | 实际 |
|---|---|
| `docs/README.md` | **缺失** |
| `docs/template.md` | **缺失** |
| `docs/knowledge/common/best-practices/daily-to-knowledge.md` | **缺失** |
| `docs/index.md` | 存在（唯一索引，按年月表格，一直在用） |
| `docs/knowledge/<端>/index.md` | 存在（agents / frontend / main 三个端） |

`git log --all --pretty=format: --name-only -- docs` 与 `git log --diff-filter=D` 都查无这三个路径
⇒ 它们是**从未落地的规范**，不是被删掉的。

门禁的**实质**一直在满足（本轮之前的多个任务都有 daily 日志 + 索引行 + knowledge 沉淀），
所以缺的只是"可执行的说明书"：换个人或换个 agent 按 `AGENTS.md` 执行时会找不到文件而跳过。

## Requirements

- **R1**：补 `docs/template.md` —— 任务日志模板，形状取自本仓**实际在写**的日志
  （起因 → 改了什么 → 设计取舍 → 取证（命令 + 原始输出）→ 每条护栏弄坏一次的红集 →
  核查代理复测 → 未完成/存疑 → 后续），不是凭空设计一套。
- **R2**：补 `docs/README.md` —— 使用指南：目录结构、命名与粒度（一任务一日志、
  `YYYY-MM-DD_<slug>.md` 且 slug 与 `.trellis/tasks/<slug>/` 同名）、门禁触发点
  （`task.py archive` / `/trellis:finish-work` 之前）、检索命令、与 knowledge/adr/task 产物的分工。
- **R3**：补 `docs/knowledge/common/best-practices/daily-to-knowledge.md` —— P2 门禁的**可执行定义**：
  3 问 + PR Checklist + 拦截规则 + 判定命令 + "什么不算知识"。
- **R4**：索引同步：`docs/knowledge/common/index.md`（新端目录）+ `docs/knowledge/index.md` 端目录表加行；
  本任务自己的 daily 日志 + `docs/index.md` 加行（门禁对自身同样生效）。
- **R5**：不改 `AGENTS.md` 的规范内容（引用现在能落地了）。若发现 `AGENTS.md` 与落地产物仍有
  不一致，只允许**收窄引用或补一行指针**，不许改门禁语义。

## Out of Scope

- 不改门禁的**语义**（谁触发、拦什么），只补说明书。
- 不重构 `docs/` 的目录结构（`adr/`、`baseline/`、`daily/`、`knowledge/` 保持现状）。
- 不给 `docs/index.md` 的既有行做格式统一（历史行保持原样）。
- 不写脚本自动判定沉淀门禁（语义判定靠人/agent 核对，`daily-to-knowledge.md` 只给 grep 线索）。

## Acceptance Criteria

- [ ] AC1：`AGENTS.md` 里引用的三个路径**全部存在**，且内容能直接照着执行（不是占位符）。
- [ ] AC2：`docs/template.md` 的章节与本仓**实际日志**的章节对得上（抽查 ≥ 2 篇 2026-10 的日志，
      模板里的每一节都能在真实日志里找到对应；模板不发明仓库里没人写的节）。
- [ ] AC3：`docs/README.md` 的命名与粒度规则与 `.trellis/tasks/` 的实际目录名一致
      （用本轮的任务 slug 验证一遍）。
- [ ] AC4：`daily-to-knowledge.md` 的 PR Checklist 能**逐条核对**（每条都指向真实存在的路径/命令）。
- [ ] AC5：`docs/knowledge/common/index.md` 存在，且 `docs/knowledge/index.md` 的端目录表已加 `common/` 行。
- [ ] AC6：本任务的 daily 日志 + `docs/index.md` 行已加（自证门禁可执行）。
- [ ] AC7：仓库自检通过：`AGENTS.md` 引用的所有 `docs/` 路径存在性检查零缺失。
