# 执行计划：灵动岛高保真还原

## 有序清单

1. **收起氛围**（`island.css` + IslandView 传 `--glow`）：常驻环境辉光、高光线、danger 呼吸，
   数值贴原型（blur 22 / opacity .35）。
2. **logo 动画**：呼吸 + ping 环 + danger 抖动 + reduced-motion 全静止。
3. **尺寸**：收起环 36 + gap 12；mini-pill 收窄（padding/gap，高度不动）。
4. **展开嵌套**：`PlanCell` 多窗切嵌套环 40 + 图例，单窗保持；`RING_SIZE` 拆分。
5. **启动面板**：启动序列内存态强制展开，不回写持久化。
6. **验证**：harness 与原型并排截图（收起/隐藏/展开/换肤）+ `typecheck` + `npm test`；
   相关断言先红后绿。

## 验证命令

```bash
npm run typecheck
npm test
# harness：rebuild bundle → http.server → playwright 并排截图（流程见 parent 任务日志）
```

## 风险文件 / 回滚点

- `src/renderer/src/island.css`（表现集中，revert 即回）。
- `src/renderer/src/IslandView.tsx`（传参 + PlanCell 分支）。
- `src/main/overlay.ts`（仅启动序列，dwell/拖拽不动）。
- 旧水柱已删，无回滚耦合；`git status` 的 `.playwright-mcp/` 不入库。
