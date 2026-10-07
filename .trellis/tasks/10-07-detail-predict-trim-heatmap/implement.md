# Implement：去预计耗尽 + 用量热力图

## Checklist（按序）

- [ ] I1 热力图纯函数 + 单测（先红后绿）
  - 在 `usageHistory.ts` 旁新增 `usageHeatmap.ts`：`heatmapOf / intensityOf / streakOf`（口径见 design.md）。
  - 新增 `scripts/test-usage-heatmap.mjs`（经 loadTs 跑真源码）：重置天 delta=cur、null 不补 0、streak 遇 null 即断、intensity 相对分档、空输入→空数组。
  - 风险文件：`src/renderer/src/usageHistory.ts`（只读不改动，仅复用 `DayBucket`）。
- [ ] I2 `TrendChart.tsx` 改热力图（保留 `TrendPanel` 切换与空态纪律）
  - 图体改日历网格 + 月份标签 + `<title>`（日期/末值/增量）；卡片头加 streak 行；CSS 类 `.heat-*`。
  - 回归：`scripts/test-usage-history.mjs` 的 G 段（切换不发 IPC、余额不发、不受 predictOn 管）保持绿；空历史仍 null。
- [ ] I3 `DetailView.tsx` 去预测
  - 删 `usePredictions`、`predictAll/buildPredictionText` import、`predictOn/predictConfig` props、预计耗尽 section；`useUsageHistory` 的 `on` 改为 `planish`（语义不变，去注释里的 predictOn 引用）。
  - 门：`grep 预计耗尽 src/renderer` 零命中；`test-structure.mjs` 相关断言更新。
- [ ] I4 设置页 + App 去预测配置
  - `VoiceReminderSection.tsx` 删 F 分区与 props；`App.tsx` 删 predict state、extras 读写、回调透传；`PREDICT_KEYS.on/config` 标 legacy。
  - 门：`grep ui:predictOn src` 仅剩注释/legacy；设置页无 `vrs-predict-on`。
- [ ] I5 删预测算法与旧单测
  - 删 `renderer/usagePredict.ts` 的算法函数（保留类型转出口或迁移至 shared 引用）；删/归档 `scripts/test-usage-predict.mjs`；`package.json` test 列表同步。
  - 先做 I3/I4 再做 I5（避免中间态 import 断裂红）。
- [ ] I6 全链验证
  - `node scripts/test-usage-history.mjs`、`node scripts/test-usage-heatmap.mjs`、`npm run test:structure`、`typecheck`、`npm test`、实拍（有/无历史、重置天、缺口天、余额类无图）。

## Validation

```bash
node scripts/test-usage-heatmap.mjs
node scripts/test-usage-history.mjs
grep -rn "预计耗尽" src/renderer src/main | grep -v "^Binary" || echo "clean"
grep -rn "ui:predictOn" src | head -20
npm run test:structure
npx tsc --noEmit -p tsconfig.web.json
npm test
```

## Rollback points

- I1 独立可回滚（新增文件 + 新测试脚本，不碰现有行为）。
- I2–I5 合并为一次提交；回滚即 revert，历史落盘文件不受影响（无 schema 变更）。
- 若 `test-structure.mjs` 因删断言红，先还原断言再修实现（先红后绿纪律）。
