# 研究：`cost-by-day` / `models` 的 `since` 保留期限制（2026-10-11 实测）

> 触发：归档任务 `10-11-opencode-detail-v2-sync` 上线后，在真实授权会话下补做 live 取证时发现。

## 结论

`since` 参数走的是**服务端短期数据路径（约 48h 保留）**，不是「任意起点」。超过保留期的 `since` 会被**钳制到最近约 2 天**：

- **日桶（`bucket=day`）**：任何「2 天以前」的 `since` 都只返回最近 2 天。
- **`models`**：同上，只返回最近约 2 天的模型。
- **小时桶（`bucket=hour`）**：因为窗口本身就在最近时段内，`since` 表现正常。
- **不带 `since`**：返回完整日聚合（7d→7 桶、30d→29 桶、all→29 桶）。

## 实测数据（真实会话，脱敏）

```
fiveHour.start=2026-10-11T12:00:59Z   now=14:02Z
models?range=24h&since=<5h.start>      → 1 模型  Σ122,017,500 (=$1.2202)
cost-by-day?range=24h&bucket=hour&since=<5h.start> → 3 桶 Σ$1.2202   ✅ 与 5h 窗口逐分一致
cost-by-day?range=24h&bucket=hour（无 since，裁到窗口）→ 3 桶 Σ$1.2202 ✅

cost-by-day?range=30d&bucket=day&since=09-21 → 10-10,10-11（2 天）
cost-by-day?range=30d&bucket=day&since=10-01 → 10-10,10-11
cost-by-day?range=30d&bucket=day&since=10-09 → 10-10,10-11
cost-by-day?range=7d&bucket=day&since=10-05  → 10-10,10-11
cost-by-day?range=7d&bucket=day（无 since）   → 10-05..10-11（7 天）   ✅
cost-by-day?range=30d&bucket=day（无 since）  → 29 天                  ✅

models?range=7d（无 since）Σ861,925,769（11 模型）
models?range=7d&since=10-05 Σ592,980,635（8 模型）≡ since=10-09（钳制到 2 天）
models?range=30d（无 since）Σ3,277,636,844（20 模型）
```

## 旁证：新版 SPA 自己怎么调

公开 bundle（`app-pages.js`）里：

- `costByDay` 的 queryFn 里 `bucket = isHourly(range) ? 'hour' : 'day'`；
- SPA 只在 **24h 视图**传 `since = localStartOfToday`，**7d/30d 视图不传 `since`**（走日聚合）；
- 端点最小 `range` 是 `24h`，官方 UI 没有「5 小时」档。

即：**「日聚合」与「`since` 短期路径」是两条不同的数据源**，我们此前对周/月也塞了 `since`，落进了短期路径。

## 正确用法（修复依据）

| 窗口 | series | models |
|---|---|---|
| 5 小时 | `range=24h&bucket=hour&since=fiveHour.start`（窗口在保留期内，准确） | `range=24h&since=fiveHour.start` |
| 本周 | `range=7d&bucket=day`（**无 since**）+ 客户端裁到 `[week.start, week.resetAt]` | `range=7d`（**无 since**） |
| 本月 | `range=30d&bucket=day`（**无 since**）+ 客户端裁到 `[month.start, now]` | `range=30d`（**无 since**） |

> 注：周/月 models 无日粒度，只能用 range 口径（7d/30d 滚动）。与「自然周/订阅月」在边界日可能略有出入，属接口能力限制；series 侧用窗口边界客户端裁剪，保证与 meter 窗口一致。
