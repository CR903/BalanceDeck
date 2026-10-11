# Design：新版官网数据对齐与用量视图重构

## 边界

**改**：
- `src/main/opencode-details.ts` — 扩展现有控制台明细抓取：新增 `cost-by-day`（hour/day）与「带 `since` 的 models」，返回分窗口序列 + 分窗口模型。
- `src/main/adapters/opencode-cookie.ts` — `parseGoStatus` 消费每个 meter 的 `startsAt`（及 `access.startsAt`），把窗口起点带出来。
- `src/main/adapters/opencode.ts` — `officialWindows` 用官方 `startsAt` 作窗口起点；`modelsByWindow` 覆盖三窗口；新增 `seriesByWindow`；读取 `billing/status` 余额。
- `src/shared/types.ts` — `ProviderWindow.startAt?`；`ProviderSnapshot.seriesByWindow?`、`extraCredit?`。
- `src/renderer/src/TrendChart.tsx`（及必要的 `DetailView.tsx` 接线）— 去 7/30 切换，趋势/记录随窗口联动、节点按 hour/day 动态，图形改为窗口驱动序列视图；详情页加余额区块。
- 样式 `skins.css` 中 `.trend-*` 相关新增/调整（只用既有 token）。
- 测试：`scripts/test-ssr-parser.mjs`（go/status startsAt）、新增/扩展控制台明细解析单测；结构门禁 `test-structure.mjs` 同步。

**不改**：
- 凭据链（分区实时 cookie / `x-org-id` / `/console/api` base）、`USAGE_UNIT_SCALE`。
- 本机降级链与诚实标注纪律（ADR-0002）。
- 岛 / 卡片 / 托盘展示。

## 契约（数据形状）

```ts
// shared/types.ts
interface ProviderWindow {
  // …既有字段
  startAt?: string // ISO：官方 meter.startsAt（缺少时由 resetAt - span 反推兜底）
}

/** 一个时间桶（官方 cost-by-day 口径） */
interface UsageBucket {
  t: string        // ISO：小时桶为整点，日桶为该日 UTC 00:00
  bucket: 'hour' | 'day'
  cost: number     // USD
  tokens: number
  requests: number
}

interface ProviderSnapshot {
  // …既有
  modelsByWindow?: Record<string, ProviderModelRow[]> // 扩展为含「5 小时」
  seriesByWindow?: Record<string, UsageBucket[]>       // key = 窗口名
  /** Go 之外可用的额外额度（billing/status）；官方不可达时不产出 */
  extraCredit?: { available: number; balance: number }
}
```

## 数据流

```
collect(ctx)
  ├─ go/status ──> parseGoStatus ──> meters.{fiveHour,week,month}.{startsAt,resetsAt,limit,used}
  │                                   └─> ProviderWindow{ startAt, resetAt, used, limit, percent, tokens }
  └─ fetchConsoleDetails(wid, cookie)   [5min 缓存，非阻塞]
       ├─ models(range=7d)                 ─┐
       ├─ models(range=30d)                 ├─> modelsByWindow[本周/本月]
       ├─ models(range=24h&since=5h 起点)   ┘   modelsByWindow[5 小时]  ← 新增
       ├─ cost-by-day(range=24h,bucket=hour&since=5h 起点) ─> seriesByWindow[5 小时]（逐小时）
       ├─ cost-by-day(range=7d,bucket=day&since=week 起点) ─> seriesByWindow[本周]（逐日）
       └─ cost-by-day(range=30d,bucket=day&since=month 起点) ─> seriesByWindow[本月]（逐日）
  └─ billing/status ──> extraCredit{ available, balance }（只读；失败则不改快照）
```

- 窗口起点**统一取自 `go/status`**（权威）：`fiveHour.startsAt`、`week.startsAt`、`month` 用 `access.startsAt`；缺失时才回退 `resetAt - WINDOW_SPANS`。
- 每窗口的 `since` 参数即该窗口 `startsAt`，保证与窗口百分比同源同窗。
- 明细仍走「增强项、失败不影响主采集」的既有语义（原生 fetch，不经过可达性记账）。

## 渲染层（TrendChart 重构）

- **删除**右侧「7 天 / 30 天」`DAY_CHOICES` 切换及其 state。
- 保留左侧窗口切换（5 小时 / 本周 / 本月）；它即「左侧的范围」。
- 数据源改为 `s.seriesByWindow[activeWindow]`（官方）；无该窗口序列时退回本机 `usagePredict` 历史并在标题标注「本机估算」（与现「本机历史」tag 一致）。
- 节点/列随 `bucket` 动态：
  - `hour`：纵/横节点为整点（`HH:00`），如 5 小时窗口内每小时。
  - `day`：节点为日期（`MM-DD 周X`）。
- 记录表列：`时间节点` + `用量`（USD）+ `tokens` + `请求数`；表头与单元格随 bucket 变。空桶若官方没返回则不显示（与既有「不显示空」纪律一致）；官方返回的 0 桶照实显示（那是真实的 0）。
- 图体：**改为窗口驱动的序列视图**（不再是日历热力图）。日桶 = 纵向柱（≤31 根），小时桶 = 等宽列（≤24 列）；横轴标节点，柱高 ∝ 桶用量（USD），悬停给 tokens/请求数。沿用轻量 SVG，不引图表库。旧的日历热力图代码（`usageHeatmap.ts` / `placeDays` 等）在本任务中退役或保留为纯函数但不再接线——由实现时按复用面决定，避免留死代码。
- 余额区块：详情页新增「额外可用额度」行，展示 `extraCredit.available`（不足则显示 `balance`）；`extraCredit` 缺失时整块不显示。

**验证**：`npm run typecheck`；`npm run shots`（人工看详情页三窗口）；`npm run test:structure`。

## 权衡

- **快照内嵌 vs 详情页即时 IPC**：选**快照内嵌**（与既有 `modelsByWindow` 一致，渲染层不接触 cookie，无新增 IPC 面）。代价是数据鲜活度 = 采集周期（15 min）；对用量趋势足够，且 `cost-by-day` 有 5 min 缓存。
- **`since` 服务端切桶 vs 客户端裁剪**：选 `since`。服务端已实测按 `since` 过滤，语义清晰、少传数据；客户端裁剪只用于兜底。
- **每模型配额**：接口不提供 → 展示「窗口级配额 + 每模型用量」，per-model 百分比缺省「—」。不伪造独立配额。
- **周/月起点语义**：周用官方 `week.startsAt`（UTC 自然周），月用 `access.startsAt`（订阅周期），与官网口径一致；不再用「重置前 N 天」反推。

## 兼容与回滚

- `seriesByWindow` 为**可选**字段：旧快照 / 无 cookie 时不存在，渲染层退回本机历史，行为不劣于现状。
- `startAt` 为**可选**：缺省时渲染层沿用 `resetAt`。
- 迁移：无 schema 版本升级（仅新增可选键）；`usageStore` 历史格式不动。
- 回滚 = revert 本任务提交；本机历史路径未被删除。
- 风险点：官方 `cost-by-day` 未来再改结构 → `parseCostByDay` 必须容忍未知键（照旧只取已知字段），失败时该窗口序列缺失而非整轮失败。

## 验证手段

- 单测（纯函数）：`parseGoStatus`（startsAt）、`parseCostByDay`（hour/day）、带 since 的 models 解析。
- live 探针：`npx electron scripts/probe-console-live.js` 复核端点。
- 结构门禁：`npm run test:structure`；`npm run typecheck`。
