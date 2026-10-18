# 补齐 AGENTS.md 引用的门禁文档：三个从未落地的文件

任务：`.trellis/tasks/10-18-docs-gate-files`（轻量任务，纯文档）

## 起因

`AGENTS.md` 的「开发日志规范（根唯一 · Trellis 门禁）」引用了结构四件套与 P2 沉淀门禁的判据文件，
但实测这三个路径**在仓库里不存在**，而且**从未存在过**（不是被删）：

| # | 证据 | 观测值 |
|---|---|---|
| E1 | `ls docs/README.md docs/template.md docs/knowledge/common/best-practices/daily-to-knowledge.md` | 三个全 **缺失** |
| E2 | `git log --all --pretty=format: --name-only -- docs \| sort -u \| grep -iE "readme\|template"` | **无输出** |
| E3 | `git log --diff-filter=D --name-only -- docs/README.md docs/template.md` | **无输出** |
| E4 | `docs/index.md` / `docs/knowledge/<端>/index.md` | **存在**且一直在用（门禁的实质是满足的） |

来源：任务 `10-18-local-db-worker-offload` 的核查代理在核对门禁时发现（它的原话是"AGENTS.md 引用的
三个文件在仓库里不存在"）。触发点很具体：**换个人或换个 agent 按 `AGENTS.md` 执行时会找不到文件而跳过**。

## 改了什么

| 文件 | 改动 |
|---|---|
| `docs/template.md` | **新增**。任务日志模板：起因 / 改了什么 / 设计取舍 / 取证（命令 + 原始输出）/ 每条护栏「弄坏一次」的红集 / 核查代理复测 / 未完成-存疑 / 后续 |
| `docs/README.md` | **新增**。使用指南：目录结构、命名与粒度（一任务一日志、slug 与 `.trellis/tasks/<slug>/` 同名）、门禁触发点、检索命令、与 knowledge/adr/task 产物的分工表 |
| `docs/knowledge/common/best-practices/daily-to-knowledge.md` | **新增**。P2 门禁的可执行定义：3 问 + PR Checklist + 拦截规则 + grep 判定 + 「什么不算知识」 |
| `docs/knowledge/common/index.md` | **新增**。新端目录（跨端约定）的端内索引 |
| `docs/knowledge/index.md` | 端目录表加 `common/` 行 |
| `docs/index.md` | 本任务日志加一行 |

## 设计取舍

### ① 模板的章节**取自实际日志**，不是凭空设计

先抽查了 `docs/daily/2026-10-18_*` 三篇日志的实际骨架（起因 / 改了什么 / 设计取舍 / 取证（命令 + 原始输出）/
每条新护栏「弄坏一次」的红集 / 核查代理独立复测 / 未完成-存疑），模板照这个形状写。
代价：模板看起来"很长"，但它约束的是**已经有内容要写**的日志，不是为了凑节数。

### ② `common/` 是新端目录，不是塞进 `main/`

`daily-to-knowledge.md` 讲的是跨端流程门禁，塞进任何一端都会让"端目录 = 技术结论"的分类失真。
代价：多一层目录（`common/index.md`），但它同时给未来的跨端约定留了位置。

### ③ 不动 `AGENTS.md` 的门禁语义

`AGENTS.md` 的规范内容是对的，缺的只是落地物。所以本轮只补文件，**不改**门禁的触发点与拦截规则。
（`AGENTS.md` 本身在本轮也零改动。）

### ④ 不做脚本自动判定沉淀门禁

「日志里有没有可复用结论」是语义判断，写不出可靠的正则。`daily-to-knowledge.md` 只给 **grep 线索**
（先找「坑/教训/以后注意/否则」这类词，再核对 knowledge 的 diff），判定仍由 check 阶段的人/agent 做。
代价：门禁不是自动的；收益：不会因为一条正则漏判就放行或误拦。

## 取证（命令 + 原始输出）

### 1. AC1 / AC7：`AGENTS.md` 引用的路径全部存在

```bash
for f in docs/template.md docs/README.md docs/knowledge/common/best-practices/daily-to-knowledge.md docs/index.md; do
  printf "%-58s %s\n" "$f" "$([ -e "$f" ] && echo 存在 || echo 缺失)"
done
```

```
docs/template.md                                           存在
docs/README.md                                             存在
docs/knowledge/common/best-practices/daily-to-knowledge.md  存在
docs/index.md                                              存在
```

（改前同一条命令：前三个 **缺失**。）

### 2. AC2：模板章节与真实日志对得上

```bash
grep -n "^#\{1,3\} " docs/daily/2026-10-18_local-db-worker-offload.md | head -20
```

真实日志的骨架（起因 / 改了什么 / 设计取舍 / 取证 / 每条新护栏「弄坏一次」的红集 / 核查代理独立复测 /
未完成-存疑）与 `template.md` 的章节一一对应；模板未发明仓库里没人写的节。

### 3. AC3：命名规则与 `.trellis/tasks/` 实际目录名一致

```bash
ls -1 .trellis/tasks/ | grep 10-18
ls -1 docs/daily/ | grep 10-18
```

```
.trellis/tasks/: 10-18-docs-gate-files 10-18-local-db-worker-offload 10-18-sync-stall-and-mainthread-block
                 （A/B 已归档到 .trellis/tasks/archive/2026-10/，故不在活跃列表里）
docs/daily/     : 2026-10-18_docs-gate-files.md 2026-10-18_local-db-off-mainthread.md 2026-10-18_local-db-worker-offload.md 2026-10-18_sync-collect-watchdog.md
```

### 4. AC5 / AC6：索引行

```bash
grep -n "common/" docs/knowledge/index.md
grep -n "docs-gate-files" docs/index.md
```

## 每条新护栏「弄坏一次」的红集

**无**（纯文档任务，没有断言）。可执行性由 AC1/AC7 的**存在性检查**兜底 ——
这条检查在改前是红的（3 个缺失），改后变绿，具备"先红后绿"的形状。

## 核查代理独立复测

**无**（轻量任务，未派 `trellis-check`）。风险面是纯文档：不改代码、不改门禁语义、
不改任何被引用的既有文件，因此没有需要独立复跑的运行时行为。

## 未完成 / 存疑

1. **模板没有强制力**：本仓无 linter、无 CI，`template.md` 是"照着写"的约定，不写也不会有东西变红。
   门禁的执行仍依赖 check 阶段的人/agent 核对 —— 这是 `frontend/quality-guidelines.md`
   已经承认过的同一件事（"tsc 是唯一的类型门，没有 linter，也没有 CI"）。
2. **`daily-to-knowledge.md` 的判定是语义判断**，只给了 grep 线索；刻意不做脚本（取舍 ④）。
3. **`docs/index.md` 的历史行格式未统一**：早年的行与本轮的行样式有细微差异，按 Out of Scope 保留原样。
4. **`AGENTS.md` 提到的「domain context/」目录**在本轮核对时未在 `docs/` 下找到（只有 `adr/`、
   `baseline/`、`daily/`、`knowledge/`）。本轮**未动**它（不属于本任务的三文件范围），
   留作下一次 AGENTS.md 与现实对齐时的候选项。

## 后续

- 下一次有人按 `AGENTS.md` 执行门禁时，如果发现某条规则仍无处落地 → 同轮补文件或收窄引用，
  不要再次留下死引用。
- 存疑 4（`domain context/`）可与 `AGENTS.md` 的其它陈旧表述一起，开一个小任务统一对齐。
