# Implement：周/月 since 保留期缺陷修复

## 0. 前置
- [x] `research/since-retention.md`（live 证据）、`prd.md`、`design.md`。

## 1. 抓取层（`src/main/opencode-details.ts`）
- [ ] `costByDayUrl(range, bucket, since?)`：`since` 改可选，仅在提供时拼 `since`。
- [ ] `scrape`：
  - models：`rolling` 用 `modelsUrl(MODELS_RANGE_ROLLING, starts.rolling)`；`weekly/monthly` 用 `modelsUrl(MODELS_RANGES[kind])`（**不带 since**）。
  - series：`rolling` 用 `costByDayUrl('24h', 'hour', starts.rolling)`；`weekly/monthly` 用 `costByDayUrl(MODELS_RANGES[kind], 'day')`（**不带 since**）。
  - 保留「非空响应但 0 桶可用 → 不设 key」的结构变更判据（N1）。
- [ ] 纯函数 `seriesByWindowOf`：增窗口边界入参，按 `[startAt, resetAt)` 裁剪；无 `startAt` 时回退 `[resetAt - span, resetAt)`；key 契约不变。

## 2. 组装层（`src/main/adapters/opencode.ts`）
- [ ] `seriesByWindow` 改调用带边界的 `seriesByWindowOf`（传入 windows 的 `startAt/resetAt`）。
- [ ] `modelsByWindow` 保持（现在 week/month 无 since 已是全量；rolling 仍 since）。
- [ ] 缓存键：`starts` 指纹只对 rolling 有意义；week/month 不再因窗口起点变化而重取（可保留现状，属性能优化，非必需）。

## 3. 渲染层
- [ ] 无需改动（`seriesByWindow` 已是裁剪后的桶，`TrendPanel`/记录表照常消费）。若发现桶时间刻度与窗口文案不符，再最小调整。

## 4. 测试与门禁
- [ ] `scripts/test-ssr-parser.mjs`：更新 L 段（映射契约）；新增裁剪断言（边界内/外、缺 startAt 回退、空数组保留）。
- [ ] `scripts/test-structure.mjs`：如调用签名变化涉及静态断言，同步。
- [ ] `npm run typecheck`、`npm run test` 全绿。
- [ ] live 复核（需有效授权）：
  - `npm run build && npx electron . --details-test` → weekly/monthly `series` 桶数 > 2（应≈整周/整月有数据日数）；
  - 对比 `models?range=7d`（无 since）与实现输出的 weekly 模型集合一致。

## 5. 文档同步
- [ ] `.trellis/spec/adapters/opencode-console.md`：更正 `since` 语义与窗口→请求映射表；错误矩阵补「since 超保留期被钳制」的表现与对策。
- [ ] `research/console-api-v2.md`（归档任务内）与 `docs/knowledge/frontend/window-series-view.md`：同步更正。
- [ ] 本任务 daily 日志 + `docs/index.md`。

## 回滚点
- 改动集中在两处主进程函数 + 纯函数 + 测试 + 文档；回滚 = revert 本任务提交。渲染层未动。

## 评审门
- 开工前用户已同意开修复任务并立即修；`task.py start` 后进入实现。
