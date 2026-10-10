# 灵动岛跟进修复

## Goal

修 parent 任务（`archive/2026-10/10-10-dynamic-island`）上线后的 3 个体验回归：
启动默认吸顶、启动即起隐藏计时、环色跟随皮肤。

## Confirmed Facts（已取证）

- 启动位置：`overlay.ts:343-344` 恢复水球时代旧坐标或回落右下角，岛（560×480）从不在顶部。
- 隐藏计时：只靠 `onDragStop` 起（拖拽结束 `overlay.ts:612` / 显示器变化 `:466`），启动时无人调用 →
  永远 idle。`dock.restore(state.dock)`（`:419`）只恢复边/隐藏态，不起新计时。
- 环色：`IslandView.tsx:82` 的 `NestedRings` 用 `useMemo(() => defaultWaterAnchors(), [])`，
  静态缺省锚点，不读皮肤。`PetBall.tsx:85-94` 有现成 `readWaterAnchors`（读 `.app` 计算样式）
  + `:177-183` 有 `data-skin` 的 `MutationObserver`，同路可抄。
- 容器深黑 iPhone 资产保持不变（parent design 决策，沿用）。

## Requirements

- R1 首次启动默认吸顶：无岛定位标记时窗口放顶部居中（`x = wa.x + (wa.width - 560)/2`，`y = wa.y）；
  标记（`state.island`）随窗口移动落盘，之后启动沿用持久化位置。旧水球坐标不再直接复用。
- R2 启动即起隐藏计时：窗口 show 后走一次 `onDragStop()`（与显示器变化 `:466` 同路）；
  在顶部边沿即起 1s dwell，不在边沿则是无害空转；开关关闭/展开态由 `onDragStop` 内部清掉（现行语义）。
- R3 环色跟皮肤：`NestedRings` 改读实时皮肤水色锚点（`.app` 计算样式 + `data-skin` 监听，
  与 PetBall 同路）；等级点保持语义色；容器深黑不动。
- R4 回归：`tsc` + `npm test` 全绿；dwell 时序（1000/300/1500）与拖拽分区行为不变。

## Acceptance Criteria

- [ ] AC1 全新启动（删 `state.json` 或无标记）岛在顶部居中；移动窗口重启后位置保持。
- [ ] AC2 启动后静置 1s（顶部位）岛缩成 mini-pill；窗口不在边沿时不隐藏。
- [ ] AC3 切换皮肤（至少深色/浅色两款）收起态环色可见变化；缺失值仍灰环 `--`。
- [ ] AC4 `npm run typecheck` 与 `npm test` 通过。

## Out of Scope

- 第 4 条（嵌套环/logo 与原型差异）：待用户确认本地包版本 + 截图后另起项；
  若为单窗供应商退化或静态 logo，已在 parent scope 内定过，不在本任务返工。
- 容器跟皮肤换底色（iPhone 资产不变）。
- `--uitest`/`--shots` 实机（本环境无显示服务，留用户环境）。

## Open Questions

- 无。
