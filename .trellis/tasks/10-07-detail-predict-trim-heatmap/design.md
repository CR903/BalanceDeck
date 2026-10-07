# Design：去预计耗尽 + 用量热力图

## 边界

- 删除面：`DetailView.tsx` 预测区块 + `usePredictions` hook + `predictOn/predictConfig` props；`VoiceReminderSection.tsx` 的 F 分区 + 对应 props；`App.tsx` 的 predict state、extras 读写、回调透传。
- 保留面：采集链（`scheduler.ts` 采样 → `usageStore.ts` 落盘 → `ipc.ts:usage:predict` 通道 → `useUsageHistory`）**一字不动**；`sample:usageHistoryDays` 权威键保留，语义转给热力图保留期（改注释，不改键名，避免老用户历史被裁）。
- 类型保留：`UsagePoint / StoreUsagePoint` 留在 `shared/usage-predict.ts`（`usageHistory.ts`、`preload`、`DetailView` 都在用）；删的是**算法**（`renderer/usagePredict.ts` 的 slope/rate/predictWindow/predictAll/buildPredictionText）不是形状。
- 语音播报 `exhaustion` 触发器、系统通知阈值：**不动**（本次只删详情页预计耗尽展示）。

## 数据流

```
usageStore.loadRecent(providerId, TREND_MAX_DAYS, now)
  → Record<windowName, UsagePoint[]>
  → bucketByDay(points, days, now) : DayBucket[]（沿用，缺样本天 lastPct=null）
  → 新增 heatmapOf(buckets) : HeatDay[] { day, lastPct, deltaPp }
      delta 口径：prev==null 或 cur==null → null；
                 cur < prev → 视为窗口重置，delta = cur（新周期当天增量）；
                 否则 delta = cur - prev。
  → intensityOf(delta) : 0（空）..4（深）
      0 = null；1 = delta<=0（含持平）；2/3/4 按 delta 在 [0, maxDelta] 的三分位，
      maxDelta 取本轮 active 窗口的 max delta（相对分档，不跨窗口比）。
  → streakOf(heatDays) : { streak, sampledDays, todayDelta }
      streak = 从今天往前连续 delta>0 的天数，遇到 null/<=0 即断；
      sampledDays = 近N天 lastPct!=null 的天数；
      todayDelta = 最后一格的 delta（null 则徽标显示末值%）。
```

## 热力图布局（用户已定：单图 + streak 头）

- 沿用 `TrendPanel` 的窗口切换 + 7/30 天切换（不新增数据源，不重发 IPC）。
- 图体由「每天一根柱」改为日历网格：列 = 周，行 = 周一..周日（与本地 `dayKey` 同口径）；顶部月份标签由 buckets 首字母推导（`MM-dd` → `MMM`）；每格 `<rect>` + `<title>`（日期 + 末值% + 日增量pp，缺失如实写「未采样」）。
- 卡片头：火焰 icon + `{streak} 连击` + `{sampledDays} 天有记录` + 右上徽标（今日增量 `+X.Xpp`，无今日增量时显示末值 `Y%`）。
- 空态：沿用现有纪律——无历史 / 当前天数下全空 → 返回 null（什么都不显示）。

## 兼容与样式纪律

- 颜色只用既有 token：空格 `var(--track)`、强度档用 `color-mix(in srgb, var(--ok) X%, var(--track))` 或沿用 `lvl-ok/warn/danger` 三档映射（待实现时二选一，**不写新颜色字面量**，外部皮肤只吃得到 var）。
- `skins.css`：删除 `.predict-*` 规则，`.trend-*` 保留外壳（`.trend-switch/.trend`），图体类改为 `.heat-*`；`test-structure.mjs` 中与 predict 相关的断言同步删/改。
- extras 旧键 `ui:predictOn / ui:predictConfig`：读侧容忍（老用户残留无害），写侧删除；`PREDICT_KEYS.on/config` 标记为 legacy 注释，不再被引用。

## 权衡

- 日增量 vs 末值强度：选日增量。末值强度在高位用量下整张图全深、看不出「哪天用得多」——这正是用户报的「趋势不明显」；日增量直接回答「这天用了多少」，悬停再给末值，双数齐下。
- 不做多窗口堆叠：堆叠要为每个窗口各算一份 streak/分档，纵向占 3x 空间，而用户多数时间只看主窗口；单图 + 切换改动最小。
- 回看范围保持 30 天上限（`TREND_MAX_DAYS` 不动）：参考图 Sep–Mar 是 7 个月，但保留期放宽到 90/180 天会让单文件体积 x3–x6；先 30 天把样式做对，多月 deferred。
- 绝对用量（token/cost）不做：磁盘上根本没有这列历史，补存要升级 `usageStore` schema v1→v2 + 回填策略，本轮明确 out of scope；悬停如实标注「占额度百分点」口径，不冒充绝对量。

## 回滚

- 纯前端 + 纯函数改动，无 schema 变更；回滚 = revert 本任务提交，历史文件 untouched。
- 风险点：`usagePredict.ts` 删除后仍有残留 import 会导致 typecheck 红——实现清单里先删引用再删文件，并以 typecheck 为门。
