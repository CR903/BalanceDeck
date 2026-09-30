# Implement: P0-2 用量预测与预计耗尽时间

> 读 `design.md` 的 B1/B2/B3 三条基线再动手 —— 它们直接决定「为什么不用现有 history.ts / 为什么不走 extras」。
> D2（重置点切段）是最容易写错的一处，其测试（case 2）不是可选项。

## Ordered Checklist

### Phase 1: 纯函数模块 usagePredict.ts

- [ ] **1.1** 新建 `src/renderer/src/usagePredict.ts`
  - [ ] `UsagePoint` / `PredictConfig` / `DEFAULT_PREDICT_CONFIG`（`windowDays:7` / `retentionDays:30`）
  - [ ] `MIN_POINTS_FOR_RATE = 4` / `LOW_CONFIDENCE_POINTS = 8` / `LOW_CONFIDENCE_SPAN = 6h`
  - [ ] `resolvePredictConfig(raw)`：脏值（NaN / 负数 / 缺键）回退默认（state-management 读取处复验）
  - [ ] `lastMonotonicRun(points)`：**按向下跳变切段，取最后一段**（D2 的核心，落在这里）
  - [ ] `ratePerHour(points)`：最小二乘 OLS 斜率，百分点/小时；样本不足 / 斜率 ≤ 0 → `null`
  - [ ] `estimateRunsOutAt(last, perHour)`：`runsOutAt ≤ now` → `null`
  - [ ] `confidenceOf(points)`：`null`（不显示）/ `'low'`（标「样本较少」）/ `'mid'`
  - [ ] `predictWindow(points, now, cfg)`：串起上面四个，任一不满足 → `null`
  - [ ] `predictAll(s, pointsByWindow, now, cfg)`：余额类 / `limit` 缺省 / `pct` 为 `null` 的窗口一律跳过
  - [ ] `buildPredictionText(p, windowDays)`：**必含「估算」**；时长用 `humanDur`（`format.ts`），不另写一份
  - [ ] `qualityLabel` 取 `staleLabel`（`src/shared/quality.ts`），**不在本模块写第二份字符串**
- [ ] **1.2** 纯函数纪律自查：`usagePredict.ts` 内**不得**出现 `Date.now` / `window` / `document` / `extras` / `api.`
  （对齐 `test-alert-orchestration.mjs` 的 K1/K2；`now` 一律由入参传）

### Phase 2: 主进程存储 usageStore.ts

- [ ] **2.1** 新建 `src/main/usageStore.ts`（**不依赖 electron**，路径由调用方注入 —— 对齐 `store.ts` 的既有模式）
  - [ ] `createUsageStore({ filePath })`，磁盘格式 `{ version: 1, days: { 'YYYY-MM-DD': { [providerId]: Point[] } } }`
  - [ ] `appendBatch(points, now, retentionDays)`：只动当天分桶 + 裁掉超保留期的分桶
  - [ ] `loadRecent(providerId, days, now)`：按天分桶读回，裁掉 `days` 之前的
  - [ ] `clear()`；文件损坏 → 重建为空（与 `store.ts` 的 `load()` 同一纪律，不抛）
  - [ ] `retentionDays` 非法 → 回退 `DEFAULT_RETENTION_DAYS = 30`
- [ ] **2.2** 新建装配层（注入 `app.getPath('userData')`，**惰性**求值 —— 对齐 `keystore.ts:11-19` 的注释理由）
  - [ ] 文件 `userData/usage-history.json`
  - [ ] `SNAPSHOT_INTERVAL_MS = 15 * 60_000`（B3）
- [ ] **2.3** 守卫：`test-usage-store.mjs` 加一条负向断言 —— **`usageStore.ts` 里不得 import `extras`**
  （design B2 的机制守卫：一旦有人改走 extras，B2 的全量重写问题就回来了）

### Phase 3: scheduler 采样接线

- [ ] **3.1** `src/main/scheduler.ts`：模块级持有 `lastSnapshotAt`；在 `collect()` 的 `finally` 里调
  `maybeSampleUsageHistory(lastSnapshots)` —— **不新增任何网络请求**（AC4）
  - [ ] 仅当 `now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS` 时才记（15 分钟粒度，不是每次采集都记）
  - [ ] 每条记录：逐窗口展开 `{ providerId, window, pct, t }`；`pct` 不可知时写 `null`（**不填 0**）
  - [ ] `status !== 'ok'` 的快照不记（没有可信数据不进历史）
  - [ ] 写入失败 → `debugLog` + **不抛**，不阻断采集
- [ ] **3.2** 读回接口：`ipc.ts` 新增 `ipcMain.handle('usage:predict', (_e, providerId, now) => …)`
  - [ ] 逐字段复验 `providerId` 为非空字符串、`now` 为有限正数（type-safety.md §D）
  - [ ] `now` 非法 → 回退 `Date.now()`（主进程侧唯一读时钟的地方；渲染层仍不读）
  - [ ] **不新增网络请求**（AC4）

### Phase 4: 渲染层展示

- [ ] **4.1** `src/preload/index.ts` 暴露 `usagePredict(providerId, now)`
  - [ ] `src/renderer/src/api.d.ts` **无需手改** —— 它是 `typeof api` 推导的（该文件第 1-8 行说明了这一点），
    加了 preload 方法类型自动就有了
- [ ] **4.2** `DetailView.tsx`：
  - [ ] 套餐类（`isPlan(s)`）才请求 / 显示；余额类不请求（省一次 IPC）
  - [ ] 展示位置：`<section className="hero">` 环形仪表下方的 `hero-sub` 组（`DetailView.tsx:214-221` 附近）
  - [ ] 文案直接用 `buildPredictionText`
  - [ ] **卡片（`CardView.tsx`）本任务不做**（design D6 的刻意收窄）
- [ ] **4.3** 文案必须含「估算」；`dataQuality` 为 cached / local 时带 `⚠ 缓存` / `⚠ 本机`

### Phase 5: 测试

- [ ] **5.1** 新建 `scripts/test-usage-predict.mjs`（`loadTs` 加载 `src/renderer/src/usagePredict.ts` 真源码）
  - [ ] 覆盖 design.md Tests Required 第 1–10 条
  - [ ] **case 2（重置点切段）必须实现**，且要做反验：故意不切段 → 该用例必须报红
  - [ ] case 8 用**行为断言**（`buildPredictionText(...).includes('估算')`），不用源码正则
- [ ] **5.2** 新建 `scripts/test-usage-store.mjs`（`loadTs` 加载 `src/main/usageStore.ts`）
  - [ ] 覆盖第 11–14 条 + 2.3 的负向断言
  - [ ] 用 `mkdtemp` 建临时目录，**不得写真实 userData**
- [ ] **5.3** `package.json` 加 `test:usage-predict` / `test:usage-store` 并接入 `test` 链
  - [ ] 放在 `test:alert-orchestration` 之后

### Phase 6: extras 与设置项

- [ ] **6.1** extras 键（design D7）：
  - [ ] `ui:predictOn`（`'1'` / `'0'`，默认开）
  - [ ] `ui:predictConfig`（JSON `{ windowDays, retentionDays }`，经 `resolvePredictConfig` 校验）
  - [ ] `sample:usageHistoryDays`（**非 `ui:` 前缀** —— 保留期要能触发重排，见 D7 的警告）
- [ ] **6.2** 设置页：`VoiceReminderSection.tsx` 内新增「用量预测」小节
  - [ ] 总开关 class `vrs-predict-on`；回看天数 `vrs-predict-days`；保留天数 `vrs-predict-retention`
  - [ ] 文案说明「预测基于本机历史快照，为估算值」

## Review Gates

- [ ] `npm test` 全绿（含新增两个脚本）
- [ ] `npm run typecheck` 通过
- [ ] 反验：把 D2 的切段逻辑去掉 → `test-usage-predict.mjs` 的重置点用例必须报红
- [ ] 反验：把 `usageStore` 改成走 extras → 2.3 的负向断言必须报红
- [ ] 手动冒烟：详情页套餐供应商显示「按近 7 天速率估算，约 X 后用完」；余额类不显示；
  断网（cached）时文案带 `⚠ 缓存`；刚启动样本不足时**不显示**
- [ ] `trellis-check` 对照 prd.md 验收标准逐条复核

## Rollback

- **纯增量、无数据迁移**：`usageStore` 只写自己的新文件，删掉该文件即回到「无预测」状态。
- 关闭总开关（`ui:predictOn` = `'0'`）即可停止展示，但后台仍会继续记快照（要彻底停需删文件或移走 `usageStore` 接线）。
- 回滚代码：新删 `usagePredict.ts` / `usageStore.ts`，撤掉 `scheduler.ts` / `ipc.ts` / `preload` / `DetailView.tsx` 的接线。
  ⚠ 不影响 TTS —— 两者共用 `src/shared/quality.ts` 的 `staleLabel`，但那条本来就在，不会被本任务改到。
