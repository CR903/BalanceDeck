# Implement: P1-1 历史趋势图

## Ordered Checklist

### Phase 1: 聚合纯函数 usageHistory.ts

- [x] **1.1** 新建 `src/renderer/src/usageHistory.ts`
  - [x] `DayBucket` 类型（`day` / `lastPct` / `maxPct`）
  - [x] `bucketByDay(points, days, now)`：**本地日历日**切分（非 UTC）
  - [x] 末值取**最后一个已知值**：遍历时记住 `lastKnown`，遇到 `null` 不清空
  - [x] 缺样本的天**不补 0**；全 null 的天 `lastPct = null` 且不产生柱
  - [x] ⚠ **桶的天数 = 从第一天有采样到今天**（两端被可见天数夹住）。这一条原文没写，
        实现时按 design.md 的 Good/Base/Bad 三例推导：窗口**内**的断档要留空桶（缺口可见），
        窗口**外**的空白不画（刚装 2 天不伪造 30 根空柱）。反验 ② 打的就是这一条
  - [x] `scaleY(pct, height)`：**固定 0..100**，不随数据缩放
  - [x] `xOf(index, count, width)`：等距；`count === 1` 不除零
  - [x] `windowsWithHistory(pointsByWindow)`：过滤掉没有点的窗口
- [x] **1.2** 纯函数纪律自查：无 `Date.now` / `window.` / `document.`，`now` 一律由入参传

### Phase 2: 取数 hook

- [x] **2.1** `DetailView.tsx` 新增 `useUsageHistory(providerId, days, enabled)`
  - [x] 复用已有 `window.api.usagePredict`（**不加新 IPC**）
  - [x] 一次取 **30 天**（`windowDays` 上限），7/30 天切换在 `bucketByDay` 里切片
  - [x] 依赖数组**不含 `now`**（避免 30s 倒计时钟每圈重发 IPC）
  - [x] 失败/返回 `{}` → 保持空态，**不报错**
- [x] **2.2** 与 `usePredictions` **并列**而非父子：`predictOn` 只管预测文案那一行，
  趋势图不受它管（design.md D3）
- [x] **2.3** **余额类不请求**：`isPlan(s)` 为假时不发 IPC（余额类 pct 实测恒 null 或恒 0）

### Phase 3: TrendChart 组件

- [x] **3.1** 新建 `src/renderer/src/TrendChart.tsx`（轻量 SVG，**不引图表库**）
  - [x] 参考 `components.tsx` 里 `Ring` 的 SVG 写法
  - [x] `buckets` 为空 → 返回 `null`（不渲染空壳）
  - [x] `lastPct === null` 的天不画柱（缺口可见 = 用户知道那天没采集）
  - [x] 纵轴 0..100 固定，带一条 50% / 100% 参考线
- [x] **3.2** 窗口切换控件：窗口名来自 `windowsWithHistory`（`snapshot.windows[].name`）
  - [x] 切换**不重发 IPC**（数据已全取回）
  - [x] 默认选中 `primaryWindow`（`read-model.ts:22`）
- [x] **3.3** `DetailView.tsx` 插入趋势图区块
  - [x] 位置：**「每模型用量表」上方**（design.md 的插入点）
  - [x] ⚠ **只改 `DetailView.tsx` 与新文件，不碰 `App.tsx`**（账户分组子任务正在用它）

### Phase 4: CSS

- [x] **4.1** `src/renderer/src/skins.css` 加 `.trend-chart` / `.trend-bar` / `.trend-axis` /
  `.trend-switch`，沿用既有 token（`--fg-faint` / `--border` / `--surface`）
  - [x] 不引入新的颜色字面量（走既有 token，skin 才能继续换肤）

### Phase 5: 测试

- [x] **5.1** 新建 `scripts/test-usage-history.mjs`（`loadTs` 加载真源码）
  - [x] 覆盖 design.md Tests Required 第 1–9 条
  - [x] 第 2 条（末值取最后一个**已知**值）与第 3 条（缺样本不补 0）是本任务最容易写错的点，
  - [x] 必须各有正反两条断言
  - [x] 第 5 条用**相对差**断言（`(y5 - y95) / height ≈ 0.9`），不用绝对像素
- [x] **5.2** `package.json` 加 `test:usage-history` 并接入 `test` 链
  - ⚠ 若账户分组子任务也在改 `package.json`，合并时**统一接一次**（见父任务 prd.md 的冲突表）
- [ ] **5.3** `src/main/qa/uitest.ts` 加断言
  - [ ] 详情页渲染出 `.trend-chart` 且柱数 = 可见天数
  - [ ] 余额类供应商详情页**没有** `.trend-chart`
  - ⚠ 若托盘子任务也在改 `uitest.ts`，两边各自只加自己的键，合并时人工去重
  - ⛔ **本批次不做**（主会话派发时明确划为越界文件）：`uitest.ts` 多子任务并行改，
    合并后由主会话统一加键、统一跑一次 `--uitest`。落到 `prd.md` 的 AC 里仍标未完成

### Phase 6: spec

- [x] **6.1** Phase 3.3 更新 spec：记录「余额类 pct 实测恒 null / 恒 0，故不做余额趋势图」
      这条实测结论（否则下一个人会想当然地给余额类也画一张图）

## Review Gates

- [x] `npm test` 通过（含新增的 `test-usage-history.mjs`：18 个套件全绿）
- [x] `npm run typecheck` 通过
- [x] **反验 ①**：把 `bucketByDay` 的末值逻辑改成「取数组最后一个」→ 实测红 **5** 条
      （B3/B4/**B6**/B7/B9）。⚠ 2026-10-01 trellis-check 复测修正：实现方原报 4 条，
      漏了 B6 —— 同一个 break 也把 `maxPct` 打成 null 了（峰值同样不该被末尾的 null 带走）。
- [x] **反验 ②**：把缺样本的天补成 0 → 实测红 3 条（A4/A10/B5）✅ 与原报一致
- [x] **反验 ③（额外）**：给 `scaleY` 加 `maxPct` 上界参数并在组件里传数据最大值 → 实测红 2 条
      （C9/C10）✅ 与原报一致
- [x] **反验 ④（trellis-check 新增的守卫）**：把 `TrendChart` 里的 `scaleY` 调用全部去掉
      （图不再走这条换算）→ 原 C10 **空洞通过**（负向断言在「那行代码不存在」时恒真）。
      已补前置断言 C10a，并实测反验：红 1 条（C10a）
- [x] **反验 ⑤（trellis-check 新增）**：把 `useUsageHistory` 改名 → G0/G2/G3a/G3/G4 变红，
      证明 G 段不是「文件里没有这段代码所以全过」
- [x] `trellis-check` 对照 prd.md 验收标准逐条复核（已完成；AC14 仍缺，见下）

### Phase 5 补充（trellis-check 加，G 段）

17 个既有套件**没有一个碰过 `DetailView.tsx`**（`grep -rn DetailView scripts/*.mjs` → 0 命中），
于是 PRD 第 4/5/6 条（切换不重发 IPC、余额类不发、不受 `predictOn` 管）三条要求**原本零守卫** ——
正是本仓记录过的那类事故（「开关看起来是活的，`npm test` 与 `tsc` 全绿」）。
`test-usage-history.mjs` 补了 G 段（G0–G7），按**调用形状**切片（函数体 → 依赖数组字面量 →
早退守卫），**不用整文 grep**：这个 hook 的注释里就写着「依赖数组里不含 now」，整文 grep
匹配到的是注释，即本仓明确点名的假守卫种类。每条都带前置，且逐条反验过（见上）。

## Rollback

- **纯增量、无数据迁移**：删掉 `DetailView.tsx` 里的趋势图区块即可；
  `usageHistory.ts` / `TrendChart.tsx` 是新文件，可直接删。
- 不涉及任何持久化键、不改 `usageStore`、不改 IPC —— 快照数据完全不受影响。