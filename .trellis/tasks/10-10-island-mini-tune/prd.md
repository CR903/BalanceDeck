# 灵动岛mini微调与点击穿透修复

## Goal

mini-pill 点距拉大、条做薄、窗口锁顶真贴边；修 mini 态点不着（穿透到桌面）。

## Confirmed Facts（已取证）

- 穿透真因：隐藏稳态主进程用 `peekOverride`（`dock-hide.ts:121-129` 居中 132×26、y=0）
  覆盖命中，且覆盖生效时不采信渲染层上报；但渲染的 pill 跟 `posX` 走（非居中）、
  宽 fit-content（非 132）、top 10px（非 y=0）。三处全对不上 → 点 pill 必穿透。
  只要拖过岛或家数不是正好 5 家，100% 复现。
- 微调基线：现 pill 高 26（`MINI_PILL_H`）、padding 0 10、dots gap 5；岛 `top:10px`；
  窗口 y 可被边缘拖拽带离 `wa.y`。
- 锁顶与隐藏判定相容：`detectEdge` 顶部阈值 8px，`y=wa.y` 时 d=0，dwell 正常起。

## Requirements

- R1 mini 瘦身：dots gap 5→10，pill 高 26→22（`MINI_PILL_H` 同步改 + D6b + dock-hide
  单测同步）；padding 保持 0 10。
- R2 真贴边：窗口 y 锁 `wa.y`（移动/show/拖拽三处钳回，x 自由）；岛 `top:10px`→`top:0`
  （顶部辉光被窗沿裁掉一点，接受；hitbox 上报的是实测矩形，不受影响）。
- R3 穿透修复：隐藏稳态信任渲染层实测矩形（`reportHit` 上报的 pill 区），不再用居中
  132×26 覆盖；morph 过渡期保持全窗可点（fail-open，现行注释语义不变）；
  `peekHitbox` 的 pill 分支删除（`MINI_PILL_*` 常量同步清），单测改断新契约。
  保留原位收缩（R6 不变：pill 不跳居中）。
- R4 回归：`tsc` + `npm test` 全绿；harness 截图（mini 态 + 贴边）交付。

## Acceptance Criteria

- [ ] AC1 mini 截图：点距拉开、条高 22，5 家不断尾。
- [ ] AC2 窗口 y 恒为 `wa.y`（拖拽/重启后仍贴顶）；岛与屏顶零距离。
- [ ] AC3 隐藏态点击 pill 唤出（harness 断言 dockReveal + 实机目检）；过渡期全窗可点。
- [ ] AC4 `npm run typecheck` 与 `npm test` 通过。

## Out of Scope

- 收起岛 combo 间距（已按原型 12 定）；`••••` 打码；logo 动画回加；实机 `--uitest`。

## Open Questions

- 无。
