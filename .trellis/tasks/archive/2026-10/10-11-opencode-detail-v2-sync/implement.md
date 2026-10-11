# Implement：新版官网数据对齐与用量视图重构

> 状态：**已开工并实现完毕（含 check 后返工）**。每步以「验证命令 + 观察点」收口，不跳步。

## 0. 前置（已完成本轮）

- [x] 研究并落盘 `research/console-api-v2.md`（静态 bundle + live 探针）。
- [x] 探针脚本 `scripts/probe-console-live.js`。
- [x] `prd.md` / `design.md` / 本文件。

## 1. 适配器常量与解析（主进程，纯函数优先）

- [x] `opencode-console-api.ts`：新增常量
  - `USAGE_COST_BY_DAY_PATH = '/api/usage/cost-by-day'`
  - `COST_BUCKETS = { hour: 'hour', day: 'day' }`
  - 保留 `MODELS_RANGES`，**新增** `MODELS_RANGE_ROLLING = '24h'`，并改注释：rolling 用 `range=24h&since=<5h 起点>` 对齐（推翻旧「故意不映射 rolling」）。
- [x] `opencode-cookie.ts`：`parseGoStatus` 消费 `startsAt`
  - `SsrRawWindow` 增 `startsAtSec?`（或直接带 ISO `startAt?`）。
  - `month` 的起点取 `access.startsAt`。
- [x] `opencode-details.ts`：
  - 新增纯函数 `parseCostByDay(body): UsageBucket['raw'][]`（只取 `date/totalCostMicroCents/totalTokens/totalRequests`，容忍未知键）。
  - `fetchRange` 增 `since?` 参数（query 拼接 `&since=<iso>`）。
  - `scrape` 扩展为：weekly/monthly/rolling 三档 models + 三档 cost-by-day（hour/day），全部串行 + 重试一次。
  - 返回类型 `ConsoleDetails` 扩展为 `{ models?: Partial<Record<kind, ConsoleModelRow[]>>, series?: Partial<Record<kind, RawBucket[]>> }`（保持向后兼容：旧调用方可只读 models）。

**验证**：`npm run test:ssr`（扩 case）+ 纯解析单测新增；`npm run typecheck`。

## 2. 适配器组装

- [x] `opencode.ts:officialWindows`：窗口起点优先用 `raw.startAt`，缺失回退 `resetAt - WINDOW_SPANS[kind]`；写入 `ProviderWindow.startAt`。
- [x] `modelsByWindow` 覆盖三窗口（rolling 用 `range=24h&since=<fiveHour.startAt>`）。
- [x] 新增 `seriesByWindow`：把 `cost-by-day` 桶换算成 `UsageBucket`（microcents→USD），key = 窗口名。
- [x] 读取 `GET /api/billing/status`（`BILLING_STATUS_PATH`，带 cookie + org）→ `extraCredit{ available, balance }`；失败静默不产出。
- [x] 保留「官方不可达 → 本机估算」降级；本机分支不产出 `seriesByWindow` / `extraCredit`（渲染层退回本机历史 / 不显示余额块）。
- [x] `shared/types.ts`：`ProviderWindow.startAt?`、`UsageBucket`、`ProviderSnapshot.seriesByWindow?`、`extraCredit?`。

**验证**：`npm run test:adapters`；手工 `BALANCEDECK_DEBUG=1` 看日志确认三窗口均产明细与序列。

## 3. 详情页渲染

- [x] `TrendChart.tsx`：删 `DAY_CHOICES` 7/30 切换与 `days` state；`TrendPanel` 改吃 `windows + seriesByWindow +（本机回退）pointsByWindow`。
- [x] 记录表：列 = 时间节点 / 用量 / tokens / 请求数；节点格式随 `bucket`（`HH:00` 或 `MM-DD 周X`）；小时桶新→旧排序与现有一致。
- [x] 图体：改为窗口驱动序列视图——日桶纵向柱（≤31）、小时桶等宽列（≤24），横轴标节点，柱高∝桶用量；退役旧日历热力图接线（`usageHeatmap`/`placeDays`），不留死代码。
- [x] `DetailView.tsx`：接线 `seriesByWindow`；标题 tag 在有官方序列时去掉「本机历史」改「官方」，回退时保留「本机估算」；新增余额区块（`extraCredit`，缺失不显示）。
- [x] 5 小时窗口模型明细：`WindowRow`/`WindowModels` 已支持 `modelsByWindow[w.name]`，确认 rolling key 显示正常，per-model 无 quota 时显示「—」。
- [x] `skins.css`：新增/调整 `.trend-*`、`.dwin-*`、余额行规则，仅用既有 token。

**验证**：`npm run typecheck`；`npm run shots`（人工看详情页三窗口）；`npm run test:structure`。

## 4. 门禁与收口

- [x] 补测试：`test-structure.mjs`（新结构断言）、纯函数单测（startsAt / cost-by-day / since models）。
- [x] 复跑：`npm run test` 全绿。
- [x] 更新 spec `.trellis/spec/adapters/opencode-console.md`：
  - 新增 `cost-by-day` 契约与 `since` 语义；
  - 修正 §3.3「5 小时没有明细是正确行为」→ 现由 `since` 支持；
  - `MODELS_RANGES` 说明更新。
- [x] `docs/daily/2026-10-11_opencode-detail-v2-sync.md` + `docs/index.md` 追加（Trellis 门禁）。
- [x] 如产生通用知识，沉淀 `docs/knowledge/`。

## 回滚点

- 步骤 1–2 纯新增 + 向后兼容字段：回滚 = revert 提交，快照少 `seriesByWindow`，渲染层自动回退本机历史。
- 步骤 3 渲染层改动与步骤 1–2 解耦：可单独回滚渲染层，恢复旧 TrendChart。
- 无 `usageStore` schema 变更，无数据迁移风险。

## 评审门

- [x] 用户已定：R4 只出报告；**本轮顺带接入余额（R5）**；**趋势改为窗口驱动序列视图**。
- [x] 待用户回「开工」后执行 `python3 ./.trellis/scripts/task.py start`。
