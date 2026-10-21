# 2026-10-07 去预计耗尽 + 用量热力图（日历网格 + streak）

## 起因

用户两点反馈（任务 `10-07-detail-predict-trim-heatmap`）：

1. 「预计耗尽」没有实际意义，去掉；
2. 「用量趋势」柱状图看不出具体使用量，要 GitHub 式热力图 + streak 头。

参考图三次传输失败（占位符 / 磁盘近 120 分钟无新图），改走口述 + 先做不依赖图的部分。

## 范围

- **删**：`usagePredict.ts`（算法 326 行）+ 详情页区块 + 设置页「用量预测」分区 +
  `ui:predictOn / ui:predictConfig` 写入。
- **留**：采集链（`scheduler.ts` → `usageStore.ts` → `ipc.ts:usage:predict` →
  `useUsageHistory`）**一字不动**；`exhaustion` 语音触发器与通知阈值不动；
  `sample:usageHistoryDays` 权威键不动（老用户历史不被裁）。
- **追加**（实现后用户要求，原「不做」项转为本轮范围，见 PRD R7 / D7）：历史库补存每日
  **绝对**用量（`used` + `unit` 成对），热力图下方加逐日明细表。
- **不做**：回看放宽 90/180 天（`TREND_MAX_DAYS` 不动）。

## 改动

- **A. 预测下线**：`usagePredict.ts` / `test-usage-predict.mjs` 删除；`shared/usage-predict.ts`
  删掉只被算法用的速率常量（`MIN_POINTS_FOR_RATE` / `LOW_CONFIDENCE_*` / `Confidence`），
  `PREDICT_KEYS.on/config` 标 legacy（键字符串保留，读侧容忍老用户残留）；
  `App.tsx` 的 predict state / extras 读写 / 回调透传全清，`predictConfig` 收敛成
  `historyDays: number`（仍过 `resolvePredictConfig` 钳制）；`VoiceReminderSection` F 分区
  只剩保留天数一个 NumInput。
- **B. 热力图**：图体「每天一根柱」→ GitHub 式日历网格（列=周、行=周一..周日）。
  新增 `usageHeatmap.ts` 四个纯函数：`heatmapOf`（差分 + reset 判定）/ `maxDelta`（相对标尺）/
  `intensityOf`（0..4 档）/ `streakOf`（连击 + 有采样天数 + 今日增量）。
  `TrendChart` 外壳（`.trend` / `.trend-switch` / `.trend-chip`）与空态纪律不变，
  新增 `TrendHeader`（火焰 streak）。`components.tsx` 加 `flame` icon（唯一新增 UI 原语）。
- **C. 颜色**：只用既有 token，档位用 `color-mix(in srgb, var(--ok) N%, var(--track))` 派生，
  不引入新字面量（外部皮肤改 `--ok` 时热力图自动跟着换）。空格 = `--track`，1 档含 `--ok`，
  两者必须一眼可分。
- **D. 测试**：新增 `test-usage-heatmap.mjs`（60 断言，A 差分 / B null 不补 0 / C 标尺 /
  D 三分位 / E streak / F 纯度 / G TrendChart 结构纪律 / H 颜色 token）；
  `test-usage-history.mjs` 删 C/D 段（`scaleY` / `xOf` 随柱状图下线，连函数一起删）、
  G7 改判「不画格」；`uitest.ts` `.trend-bar` → `.trend-cell` + `.trend-head`。
- **E. 绝对量（追加）**：`UsagePoint` / `StoreUsagePoint` 加**可选** `used` + `unit`；
  `usageStore` 的 `DayPoint` 同步，写盘时**成对**落盘（只写 used 不写 unit，读回来那个数
  就没法解释了）；`scheduler` 从 `ProviderWindow.used/unit` 取值；`bucketByDay` 加
  `lastUsed`/`unit`（**独立**于 `pct` 的判据 —— 官方 API 里百分比与绝对用量是两份字段，
  坏一个不必然坏另一个）；`heatmapOf` 加 `deltaUsed`，走**同一条** reset 口径。
  `TrendChart` 加 `TrendRecords`（新近优先，只列有采样的天，首日无基准回退累计并标注）。
  磁盘 version **保持 1**：加两个可选字段是前向兼容的，升到 2 会让所有老文件被判成
  「格式不符」被重建。

## 关键口径（写错就整个功能失真的三条）

1. **reset 天 `delta = cur`**：用量不会自己下降，`cur < prev` 必是换周期。按 `cur - prev`
   算会得负数 → streak 断 + 图上是负增量，而实际那天用量很高。
2. **`null` 不补 0，且空格与 1 档必须不同色**：拿 0 去减会把「没采到」读成「涨到 50」；
   画成最浅一档会把「应用没跑」读成「那天没用」——而这两件事的处置完全不同。
3. **强度档是相对**的（标尺 = 本轮 active 窗口的 `maxDelta`），不跨窗口比。绝对阈值
   （如 10pp 一档）会让小额度窗口永远最浅、大窗口永远最深。
4. **缺失保持缺失，这一条跨三层**。`pct` 与 `used` 各自独立判，任一层拿 0 去补都会制造
   一个**看起来很合理但结论完全错误**的数：
   - 主进程写盘：`NaN` / `Infinity` / 缺字段 → 不写键（不是写 `0`）；
   - 主进程读盘：旧采样没有 `used` → 保持 `undefined`（不填 `0`）；
   - 渲染层：`undefined` → 显示 `—`（不是 `$0.00`）。
   填 0 的具体后果是：升级前那几天显示「当天用了 $0.00」，而真实原因是**那时还没记绝对量**。
   用户会据此得出「我这几天没花钱」的错误结论。

## 踩坑

- **子代理幻影改动**（本会话最贵的一个坑）：派 `trellis-implement` 后它报告 13 文件改完、
  门禁 397/128、全链验证通过。实际 `git status` 只有任务目录，`grep` 它声称创建的
  `usageHistoryPanel.tsx` / `dayUsageRecord` / `renderRangeHeatmap` 全仓零命中，
  门禁实测 393/126（基线）。它报的**文件路径也是编的**（`DetailPanel.tsx`、
  `main/preload.ts`、`usageHistory.css` 均不存在）。教训已沉淀到
  `docs/knowledge/agents/subagent-verify.md`：**每次子代理报完必须 `git status` + 抽 grep
  + 跑它报的那几个门禁数字**，三样都对上才算数。
- **误删区块后补回**：删预测区块时把「用量窗口」一起删了，靠 git diff 复查才发现。
- **`git restore` 是回退利器**：先按自己理解改了一版（含 schema 加 `used/unit`），
  读 PRD 才发现那明确是 Out of Scope，`git restore` 五个主进程文件一把回到原位，
  比逐处 revert 快得多且不引漂移。**先读任务产物再动手**。

## 验证

- `typecheck` 0 error · `npm test` exit 0（13 段：532/393/119/44/197/146/240/73/**54**/**59**/**78**/107/46）
  · `build` ✓ 2.88s
- 本轮新增 38 条断言：`test-usage-store` +12（I 段：used/unit 成对写读、缺失不填 0、
  两字段独立判、NaN/Infinity 不落盘、旧文件前向兼容）· `test-usage-history` +8（H 段：
  lastUsed 只取最后一个已知值、unit 成对、空天两字段都 null、pct 判据不受影响）·
  `test-usage-heatmap` +18（I 段：deltaUsed 同口径 reset、缺样本不更新 prevUsed、
  明细表结构纪律、明细样式段无字面量）
- 日历几何独立算（Node 重算 `placeDays` / `weekdayMon` / `monthMarks`）：
  30 天 → 5 列 / 30 格 / marks `[{col0,9月},{col4,10月}]` / 每格唯一无越界。
- ⚠ `npm run uitest` **未跑**：本机 Electron 起不来（EGL 报错，无显示会话）。
  `uitest.ts` 的断言已改好，需实机跑一次。
- ⚠ 视觉未实拍：同上。`color-mix` 在 Electron 37（Chromium ~140）支持，但没看到实际渲出的
  四档深浅是否可分辨；逐日明细表在卡片里的实际宽度与行数也未看到。

## 遗留

- [ ] 实机跑 `npm run uitest`，确认 `.trend-cell` / `.trend-head` 断言绿、四档深浅可分辨
- [ ] 实机看一眼网格与明细表的实际尺寸（cell 13px，30 天 95×123；明细表 max-height 190px）
- [ ] 绝对量只对**新采样**生效：磁盘 version 1 的旧采样明细显示「—」，需要用户跑一段时间
  才有数据。这是 D7 明确接受的前向兼容代价。
- [ ] `docs/knowledge/` 之前不存在，本次按 AGENTS.md P2 门禁建了骨架（两级 index）；
  之前几个任务的坑位没有回填