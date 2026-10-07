# 详情页优化：去预计耗尽 + 用量热力图

## Goal

详情页去掉无实际意义的「预计耗尽」；「用量趋势」柱状图改为 GitHub 式日历热力图（单图 + streak 头），悬停能读出具体数值（末值% + 日增量pp）。

参考图：深色卡片上按月排列的每日小方格，颜色深浅表示当天强度；卡片头有图标、标题、火焰 streak、天数、右上徽标。

## Background（确认事实，源码取证）

- 预计耗尽区块：`DetailView.tsx:381-396`，由 `usePredictions` + `predictAll` + `buildPredictionText`（`usagePredict.ts`）逐窗口渲染。
- 设置页用量预测分区：`VoiceReminderSection.tsx:905-960`（总开关 `ui:predictOn` + 回看天数 + 保留天数）；`App.tsx:178-181,395-415,1134-1163` 持有 state 并读写 extras。
- 采集链与预测共享 `usage:predict` 通道名但语义独立（`scheduler.ts:130-141` → `usageStore.ts` → `ipc.ts:395` → `useUsageHistory`）：删预测必须保留采集，否则热力图无数据。
- 历史库只存 `pct`（`StoreUsagePoint { providerId, window, t, pct }`，`usageStore.ts:43-48`）；每日绝对用量（token/cost）磁盘上不存在。
- 现有趋势图是「每天末值」柱状图（`TrendChart.tsx` + `bucketByDay`，`usageHistory.ts:87`），纵轴固定 0–100，缺样本天不画柱，有窗口切换 + 7/30 天切换，空历史返回 null。

## Requirements

- R1：详情页不再显示「预计耗尽」区块；热力图取数与 `predictOn` 无关（现状已独立，删除后保持）。
- R2：设置页去掉「用量预测」分区；`App.tsx` 对应的 state、extras 读写、回调透传一并清理；保留期权威键 `sample:usageHistoryDays` 保留，语义转给热力图（改注释不改键名，老用户历史不被裁）。
- R3：预测算法（`usagePredict.ts` 的 slope/rate/predictWindow/predictAll/buildPredictionText）与 `test-usage-predict.mjs` 随功能下线；`UsagePoint` 形状保留（`usageHistory.ts`、`preload` 在用）；`usageHistory.ts` 分桶函数保留并作为热力图数据源。
- R4：热力图每格一天，日历网格（列=周，行=周一..周日），颜色深浅 = 当天日增量 pp（`heatmapOf` 口径见 `design.md`：cur<prev 视为重置，delta=cur；null 不补 0）；缺样本天为空格；悬停显示日期 + 末值% + 日增量pp，缺失如实写「未采样」；强度档 0–4 相对分档。
- R5：单图 + streak 头（2026-10-07 已定）：沿用窗口切换 + 7/30 天切换；卡片头火焰 = 截至今天连续正增量天数（遇 null/≤0 即断），天数 = 近N天有采样天数，右上徽标 = 今日增量 pp（无则显示末值%）。
- R6：余额类仍不画热力图；无历史 / 当前天数下全空 → 返回 null（空态纪律不变）。
- R7：**追加（2026-10-07 实现后用户要求，原 Out of Scope 项转为本轮范围）** 历史库补存每日**绝对**用量（token/cost），热力图下方加逐日明细表：日期 + 末值% + 当天绝对用量。只列有采样的天（不显示空的）；升级前的旧采样没有绝对量 → 显示「—」，**不填 0**。

## Out of Scope

- ~~历史库 schema 升级（补存每日绝对 token/cost）：~~ **已转为 R7，本轮做**（2026-10-07 用户明确要求「显示每一天使用量记录」，只有绝对值能答「今天具体花了多少钱」）。
- 语音播报 `exhaustion` 触发器与系统通知阈值：不动。
- 回看范围放宽到 90/180 天：deferred，先保持 30 天上限（`TREND_MAX_DAYS` 不动）。
- 球柱皮肤任务：互不牵连。
- 明细表的「合计 / 趋势摘要」：不做，streak 头已给概览。

## Acceptance Criteria

- [x] AC1：详情页无「预计耗尽」字样与区块；`grep 预计耗尽 src/renderer` 零命中（测试脚本注释除外）。
- [x] AC2：设置页无「用量预测」分区、无 `vrs-predict-on`；`ui:predictOn / ui:predictConfig` 不再被写入；保留期设置仍有效且热力图取数天数与之对应。
- [x] AC3：有数据时热力图按日历网格渲染，强度分档可见；缺样本天为空格；悬停可读出日期 + 末值% + 日增量pp。
- [x] AC4：streak 头显示连续正增量天数、有采样天数、今日增量徽标；重置天不断错（重置天 delta=cur，streak 不因此断）。
- [x] AC5：无历史时返回 null（什么都不显示）；余额类无图。
- [x] AC6：`test-usage-history.mjs`（G 段纪律）+ 新增 `test-usage-heatmap.mjs` + `test:structure` + `typecheck` + `npm test` 全绿。

- [x] AC7：历史库落盘绝对用量（`used` + `unit` 成对），读回前向兼容 version 1；逐日明细表按日期 + 末值% + 当天绝对用量渲染，只列有采样的天，旧采样显示「—」。

## 验收取证（2026-10-07 实现完成）

- `npm run typecheck` → 0 error（tsconfig.node.json + tsconfig.web.json）
- `npm test` → exit 0，13 个测试段全绿：532 / 393 / 119 / 44 / 197 / 146 / 240 / 73 / **54** / **59** / **78** / 107 / 46
  - `test-usage-store.mjs` **54/0**（原 42；新增 I 段 12 条：used/unit 成对写读、缺失不填 0、两字段独立判、NaN/Infinity 不落盘、旧文件前向兼容）
  - `test-usage-history.mjs` **59/0**（原 51；新增 H 段 8 条：lastUsed 只取最后一个已知值、unit 成对、空天两字段都 null、pct 判据不受绝对量影响）
  - `test-usage-heatmap.mjs` **78/0**（原 60；新增 I 段 18 条：deltaUsed 同口径 reset、缺样本不更新 prevUsed、明细表结构纪律、明细样式段无字面量）
- `npm run build` → ✓ 2.88s
- `grep 预计耗尽 src/renderer` → 仅剩 2 处**注释**（App.tsx 的历史说明、skins.css 的删除说明）
- `grep predictOn|predictConfig src/`（去注释）→ 零命中
- 日历几何数学独立验算（Node 重算 placeDays/weekdayMon/monthMarks）：
  - 7 天窗口 → cols=2、cells=7、rows=[0..6]、月份标签只在 col0 出现
  - 30 天窗口（2026-09-08..10-07 跨月）→ cols=5、cells=30、marks=[{col0,9月},{col4,10月}]
  - 每格 (col,row) 唯一（30/30）、row 无越界；vbW=95 vbH=123
- ⚠ `npm run uitest` **未跑**：本环境 Electron 起不来（`EGL Driver message: eglQueryDeviceAttribEXT`，无可用显示会话）。
  `src/main/qa/uitest.ts` 的 `.trend-bar` → `.trend-cell` + `.trend-head` 断言已改好，需在真实桌面跑一次确认。
- ⚠ 绝对量**只对新采样生效**：磁盘 version 1 的旧采样读回 `used` 就是 undefined，明细表那几行显示「—」。
  这是前向兼容的代价，也是 D7 明确接受的行为（不把缺失当 0）。

## Key Decisions

- D1 删除范围 = 详情页区块 + 设置页分区，采集链保留（用户 2026-10-07）。
- D2 热力图 = 单图 + streak 头，不做多窗口堆叠（用户 2026-10-07）。
- D3 颜色口径 = 日增量 pp，悬停双数（末值% + 增量pp），绝对量缺失如实标注口径（用户「先做样式再定」收敛）。
- D4 streak 口径 = 增量口径（火焰=连续正增量天数，天数=有采样天数，徽标=今日增量pp），全部由现有 pct 历史算出，不改采集（用户 2026-10-07）。
- D5 颜色只用既有 token，不写新字面量；`ui:predictOn/config` 旧键只读容忍、不再写入。
- D6 明细表新近优先（与热力图左→右相反）：明细是「查账」用的，最新的一天在最上面，而不是让人先滚 20 行才能看到今天。
- D7 schema 升级**前向兼容**：`used` / `unit` 是**可选**字段，磁盘 version 保持 1 —— 加两个可选字段不需要升版本，升到 2 会让所有老文件被判成「格式不符」被重建。代价是升级前那几天绝对量显示「—」，这是用户能接受的（明确说过旧数据不必回填），而**填 0** 不可接受（会让用户以为那几天真的没花钱）。
- D8 绝对量口径与热力图**完全同源**：`deltaUsed` 与 `deltaPp` 走同一条 reset 判定（`cur < prev` 视为换周期，delta = cur 而非负数），缺失时都不更新 prev。两条口径一旦分叉就会出现「热力图这天最深、明细这天用量是负的」这种自相矛盾的显示。
