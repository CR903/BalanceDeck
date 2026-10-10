# 灵动岛边缘裁剪修复

## Goal

岛拖到顶栏两边时不再被窗口裁掉（用户截图：右侧 logo 被裁掉一半）。

## Confirmed Facts（harness 实测，真代码 + 真样式）

- 默认居中渲染正确：嵌套环、居中 logo、余额金额都在（`prototype/shots/harness-collapsed.png`）。
- 打码余额 `••••` 即用户截图里的 4 灰点，by design，不改。
- 隐藏 mini-pill 渲染正确（`harness-hidden.png`）。
- 真因：`.isl-body` 用 `left: posX%` + `translateX(-50%)` 定位（`IslandView.tsx:409` +
  `island.css:24-28`），`posX` 只钳在比例 `[0.08, 0.92]`（`IslandView.tsx:44-45,357`），
  不看岛宽。岛宽随供应商数量变（fit-content，上限 528px），靠边时 `center ± islandW/2`
  伸出 560px 窗口 → 被透明窗口裁掉；且 body shrink-to-fit 压窄 strip → 内部横滑断尾。
  harness 实测：`posX=0.821` 时 body `x=860 w=284`，相对 560 窗口右溢 142px。

## Requirements

- R1 宽度感知钳制：用 `bodyRef.clientWidth` 实测岛宽，中心 px 钳在
  `[islandW/2 + 8, 560 - islandW/2 - 8]`；`posX` 仍按中心比例持久化（`ui:islandX` 口径不变，
  极窄岛退化为现行行为）。
- R2 拖拽映射同步改：`dx` 折中心 px（分母仍是窗口宽），落盘值经同一钳制；CLICK_SLOP、
  拖拽分区、dwell 时序不动。
- R3 回归：`tsc` + `npm test` 全绿；harness 拖到最左/最右不断尾（截图交付）。

## Acceptance Criteria

- [ ] AC1 harness 里把岛拖到 `posX=0/1` 两端，body 矩形完全落在 560 窗口内（断言 + 截图）。
- [ ] AC2 居中默认渲染与修前一致（环/logo/余额位置不变）。
- [ ] AC3 `npm run typecheck` 与 `npm test` 通过。

## Out of Scope

- `••••` 打码样式（by design）；logo 呼吸/ping 动画（parent 已降级，如需加回另起项）；
- `--uitest`/`--shots` 实机（无显示服务，harness 截图即交付证据）。

## Open Questions

- 无。
