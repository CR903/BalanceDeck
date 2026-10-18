# 开发日志使用指南（docs/）

> 本文件是 `AGENTS.md` 里「开发日志规范」的落地说明。**门禁的可执行定义在
> [`knowledge/common/best-practices/daily-to-knowledge.md`](knowledge/common/best-practices/daily-to-knowledge.md)**，
> 任务日志的写法照 [`template.md`](template.md)。

## 目录结构

```
docs/
├── index.md                      ← 唯一索引（按年月分表格，一行一篇日志）
├── README.md                     ← 本文件：使用指南
├── template.md                   ← 任务日志模板（新日志从这里复制）
├── daily/                        ← 全部开发日志（唯一入口，不按端分）
├── knowledge/                    ← 可复用结论（两级索引）
│   ├── index.md                  ← 总索引（端目录表 + 沉淀规则）
│   ├── agents/  frontend/  main/ ← 各端目录 + 各自 index.md
│   └── common/                   ← 跨端约定（含门禁定义）
├── adr/                          ← 架构决策记录（一次性决策，不进 knowledge）
└── baseline/                     ← 基线产物
```

## 命名与粒度

- **一任务一日志**，按 **Trellis 任务**切分，不是按天切分。
- 文件名：`YYYY-MM-DD_<slug>.md`，`<slug>` 与 `.trellis/tasks/<slug>/` **同名**（kebab-case）。
  例：`.trellis/tasks/10-18-local-db-worker-offload/` → `docs/daily/2026-10-18_local-db-worker-offload.md`。
- 日期取**该任务完成/交付那天**（不是开工那天）。
- 一个任务如果分多轮交付，仍是一篇日志（在文中按轮次分节），不要拆成多篇。
- 历史按日切的日志（2026-04 ~ 05）保留原样，**不重命名**。

## 门禁（什么时候必须写）

在 `task.py archive` / `/trellis:finish-work` **之前**必须完成：

1. 日志已写：`docs/daily/YYYY-MM-DD_<slug>.md`（照 `template.md`）；
2. 索引已加行：`docs/index.md` 对应年月表格追加一行；
3. 可沉淀知识已同步：`docs/knowledge/<端>/<分类>.md` + 该端 `index.md` + 总 `index.md`
   （判据与自检清单见 [`knowledge/common/best-practices/daily-to-knowledge.md`](knowledge/common/best-practices/daily-to-knowledge.md)）。

缺任一项视为**任务未完成**。日志里含坑位/通用解法却未更新 knowledge 的，**拦截 archive**。

## 检索

```bash
grep -rn "关键词" docs/daily/          # 全文找历史坑位
grep -n "2026-09" docs/index.md        # 按月份定位
grep -rn "关键词" docs/knowledge/      # 找已成准则的结论
```

## 与其它产物的分工

| 产物 | 记什么 | 不记什么 |
|---|---|---|
| `docs/daily/` | **这次做了什么**：起因、改动、取舍、取证、未完成项 | 通用准则（进 knowledge） |
| `docs/knowledge/` | **下次不该再踩**：能写成「遇到 X → 做 Y，否则 Z」+ 取证 | 流水账 |
| `docs/adr/` | 一次性架构决策及其代价 | 操作步骤 |
| `.trellis/tasks/<slug>/` | 任务的 prd / design / implement / 上下文清单 | 交付后的复盘（进 daily） |
