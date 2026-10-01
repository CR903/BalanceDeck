# Implement: P1-1 历史趋势图

## Ordered Checklist

### Phase 1: 聚合纯函数 usageHistory.ts

- [ ] **1.1** 新建 `src/renderer/src/usageHistory.ts`
  - [ ] `DayBucket` 类型（`day` / `lastPct` / `maxPct`）
  - [ ] `bucketByDay(points, days, now)`：**本地日历日**切分（非 UTC）
  - [ ] 末值取**最后一个已知值**：遍历时记住 `lastKnown`，遇到 `null` 不清空
  - [ ] 缺样本的天**不补 0**；全 null 的天 `lastPct = null` 且不产生柱
  - [ ] `scaleY(pct, height)`：**固定 0..100**，不随数据缩放
  - [ ] `xOf(index, count, width)`：等距；`count === 1` 不除零
  - [ ] `windowsWithHistory(pointsByWindow)`：过滤掉没有点的窗口
- [ ] **1.2** 纯函数纪律自查：无 `Date.now` / `window.` / `document.`，`now` 一律由入参传

### Phase 2: 取数 hook

- [ ] **2.1** `DetailView.tsx` 新增 `useUsageHistory(providerId, days, enabled)`
  - [ ] 复用已有 `window.api.usagePredict`（**不加新 IPC**）
  - [ ] 一次取 **30 天**（`windowDays` 上限），7/30 天切换在 `bucketByDay` 里切片
  - [ ] 依赖数组**不含 `now`**（避免 30s 倒计时钟每圈重发 IPC）
  - [ ] 失败/返回 `{}` → 保持空态，**不报错**
- [ ] **2.2** 与 `usePredictions` **并列**而非父子：`predictOn` 只管预测文案那一行，
  趋势图不受它管（design.md D3）
- [ ] **2.3** **余额类不请求**：`isPlan(s)` 为假时不发 IPC（余额类 pct 实测恒 null 或恒 0）

### Phase 3: TrendChart 组件

- [ ] **3.1** 新建 `src/renderer/src/TrendChart.tsx`（轻量 SVG，**不引图表库**）
  - [ ] 参考 `components.tsx` 里 `Ring` 的 SVG 写法
  - [ ] `buckets` 为空 → 返回 `null`（不渲染空壳）
  - [ ] `lastPct === null` 的天不画柱（缺口可见 = 用户知道那天没采集）
  - [ ] 纵轴 0..100 固定，带一条 50% / 100% 参考线
- [ ] **3.2** 窗口切换控件：窗口名来自 `windowsWithHistory`（`snapshot.windows[].name`）
  - [ ] 切换**不重发 IPC**（数据已全取回）
  - [ ] 默认选中 `primaryWindow`（`read-model.ts:22`）
- [ ] **3.3** `DetailView.tsx` 插入趋势图区块
  - [ ] 位置：**「每模型用量表」上方**（design.md 的插入点）
  - [ ] ⚠ **只改 `DetailView.tsx` 与新文件，不碰 `App.tsx`**（账户分组子任务正在用它）

### Phase 4: CSS

- [ ] **4.1** `src/renderer/src/skins.css` 加 `.trend-chart` / `.trend-bar` / `.trend-axis` /
  `.trend-switch`，沿用既有 token（`--fg-faint` / `--border` / `--surface`）
  - [ ] 不引入新的颜色字面量（走既有 token，skin 才能继续换肤）

### Phase 5: 测试

- [ ] **5.1** 新建 `scripts/test-usage-history.mjs`（`loadTs` 加载真源码）
  - [ ] 覆盖 design.md Tests Required 第 1–9 条
  - [ ] 第 2 条（末值取最后一个**已知**值）与第 3 条（缺样本不补 0）是本任务最容易写错的点，
        必须各有正反两条断言
  - [ ] 第 5 条用**相对差**断言（`(y5 - y95) / height ≈ 0.9`），不用绝对像素
- [ ] **5.2** `package.json` 加 `test:usage-history` 并接入 `test` 链
  - ⚠ 若账户分组子任务也在改 `package.json`，合并时**统一接一次**（见父任务 prd.md 的冲突表）
- [ ] **5.3** `src/main/qa/uitest.ts` 加断言
  - [ ] 详情页渲染出 `.trend-chart` 且柱数 = 可见天数
  - [ ] 余额类供应商详情页**没有** `.trend-chart`
  - ⚠ 若托盘子任务也在改 `uitest.ts`，两边各自只加自己的键，合并时人工去重

### Phase 6: spec

- [ ] **6.1** Phase 3.3 更新 spec：记录「余额类 pct 实测恒 null / 恒 0，故不做余额趋势图」
      这条实测结论（否则下一个人会想当然地给余额类也画一张图）

## Review Gates

- [ ] `npm test` 通过（含新增的 `test-usage-history.mjs`）
- [ ] `npm run typecheck` 通过
- [ ] **反验**：把 `bucketByDay` 的末值逻辑改成「取数组最后一个」→ 5.1 第 2 条必须报红
- [ ] **反验**：把缺样本的天补成 0 → 5.1 第 3 条必须报红
- [ ] `trellis-check` 对照 prd.md 验收标准逐条复核

## Rollback

- **纯增量、无数据迁移**：删掉 `DetailView.tsx` 里的趋势图区块即可；
  `usageHistory.ts` / `TrendChart.tsx` 是新文件，可直接删。
- 不涉及任何持久化键、不改 `usageStore`、不改 IPC —— 快照数据完全不受影响。