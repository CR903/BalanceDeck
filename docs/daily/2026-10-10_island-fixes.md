# 2026-10-10 灵动岛跟进修复（复检 pass，实机待验）

## 起因

parent（`10-10-dynamic-island`）上线后 3 条反馈：启动不在顶部、不自动收缩、换皮肤环色不变。
第 4 条（环/logo 与原型差异）待用户确认包版本 + 截图，另起项，不在这里。

## 改了什么（`10-10-island-fixes`，2 文件）

- `overlay.ts`：无 `state.island` 标记 → 顶部居中（旧水球坐标不再作启动位置）；
  标记随移窗落盘（`notePosition` 统一出口）；show 后一次 `onDragStop()` 起 dwell。
- `IslandView.tsx`：`NestedRings` 改实时皮肤水色锚点（`.app` 计算样式 + `data-skin` observer，
  抄 PetBall 同路，读不到回缺省不断裂）。容器深黑、等级点、灰环不动。

## 验证

- `typecheck` ✓，`npm test` 全绿；R1/R2/R3 复检 pass（守卫/单次/清理逐项成立）。
- AC1–AC3 实机（首启位置、1s 收缩、换肤变色）本环境无显示服务，留用户 `npm run dev` 目检。

## 沉淀

- 无跨任务新约定（均为既有模式应用：extras 标记、onDragStop 同路、readWaterAnchors 同路），
  `knowledge/` 不更新。
