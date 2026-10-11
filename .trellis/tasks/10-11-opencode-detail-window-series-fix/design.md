# Design：周/月 since 保留期缺陷修复

## 边界

**改**：
- `src/main/opencode-details.ts` — `scrape`：仅 `rolling` 传 `since`；`weekly`/`monthly` 用 range（models + cost-by-day 都不带 `since`）。`costByDayUrl` 的 `since` 改可选。
- `src/main/adapters/opencode.ts` — 组装 `seriesByWindow` 时按窗口 `[startAt, resetAt]` 裁剪日桶。
- `src/main/opencode-details.ts` 的纯函数 `seriesByWindowOf` — 增窗口边界入参（或新增独立裁剪函数），使「裁剪到窗口」可单测。
- 测试：`scripts/test-ssr-parser.mjs`（L 段 + 新增裁剪断言）；必要时 `test-adapters.mjs`。
- spec `.trellis/spec/adapters/opencode-console.md` + `research/console-api-v2.md`：更正 `since` 语义。

**不改**：鉴权、base、`shared/types.ts` 对外形状、渲染层组件（序列视图已能从 `seriesByWindow` 消费裁剪后的桶）。

## 契约更正（核心）

```
since 语义（更正）：
  · 走服务端短期数据路径，保留约 48h；超过保留期的 since 被钳制到最近约 2 天。
  · 因此 since 仅用于「窗口落在保留期内」的场景：5 小时（fiveHour.start）、24h。
  · 周/月一律不带 since，用 range 取完整日聚合，再由客户端裁剪到窗口。
```

窗口→请求映射（更正后）：

| kind | models | cost-by-day |
|---|---|---|
| rolling | `range=24h&since=<fiveHour.start>` | `range=24h&bucket=hour&since=<fiveHour.start>` |
| weekly | `range=7d` | `range=7d&bucket=day` |
| monthly | `range=30d` | `range=30d&bucket=day` |

## 数据流（裁剪点）

```
go/status → windows[].{name,startAt,resetAt}
fetchConsoleDetails(cookie, orgId, starts)   starts 仍传（rolling 需要）
  ├─ models:  rolling 带 since；weekly/monthly 不带
  └─ series:  rolling 带 since(hour)；weekly/monthly 不带（day，range 全量）
opencode.ts:
  seriesByWindow = seriesByWindowOf(details, windows)
      对每个窗口：取 details.series[kind]，裁到 [startAt, resetAt)（无 startAt 时裁到 [resetAt-span, resetAt)）
      key 语义不变：成功即产出（空数组保留）、失败不产出
```

## 权衡

- **客户端裁剪 vs 依赖 since**：选客户端裁剪。since 保留期不可控且会静默少数据；range 日聚合稳定且完整。
- **周/月 models 口径**：models 无日粒度，只能 7d/30d 滚动口径，无法精确等于自然周/订阅月边界——接口限制，如实接受并在文案/文档记录；不为此造「近似百分比」。
- **5h 保持 since**：实测准确，且是唯一能拿到 5h 口径的路径。

## 兼容与回滚

- 无类型形状变更（渲染层零改动）；回滚 = revert 本任务提交。
- 旧快照兼容：`seriesByWindow` 晚到/缺失时渲染层照旧退回本机。
- 风险点：裁剪边界用 `>= startAt && < resetAt`；rolling 的首桶按小时向下取整可能早于 `startAt` 近 59 分钟——裁剪会去掉该首桶的前置部分（或按桶保留，需实现时明确并单测钉住口径）。

## 验证

- 纯函数单测：裁剪到窗口（含边界、缺 startAt 回退、空数组保留）。
- live 复核：`--details-test` 观察 weekly/monthly `series` 桶数 > 2，且 models 与不带 since 的 `range=7d/30d` 一致。
- `npm run typecheck`、`npm run test`。
