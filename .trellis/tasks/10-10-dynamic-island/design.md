# 设计：灵动岛替换水柱

## 架构与边界

状态机复用、几何与渲染重写。`dockHide` 的 phases/timings（`src/main/dockHide.ts:10-12`：dwell-hide 1000ms → hiding → hidden；dwell-reveal 300ms → revealing；dwell-rehide 1500ms）**不动**；变的是隐藏态长什么样、窗口多大、命中区 Cover 什么。

```
现行：edge-visible（56×56 水球）→ hiding（morph 530ms）→ hidden（12px 温度计水柱，原地）
目标：edge-visible（顶部岛，全供应商）→ hiding（收缩动画）→ hidden（A 式 mini-pill：窄条 + 各家等级点，原地吸顶）
```

## 数据流与契约

- 主环 = `read-model.worstWindow`（最满窗口），阈值色 `shared/levels`，百分比 `shared/percent`（一位小数粒度，不断）。
- 收起数据源：与卡片同源（`ProviderInfo` + snapshots），可见口径 `visibleIds` / `orderForDisplay`；`speakableSnapshots`（ok + 未静音）即"有效供应商"。
- 图标：`provider-icons.providerMark` + `ProviderMark`（mask + 品牌色），原型已内联验证 5 家真实 SVG。
- 余额：`BalanceCard` 口径（`CardView.tsx:130-187`）——金额为主，`fmtAmount(used, unit)`，有 `limit` 才附 Bar。
- 拖动落盘：`extras` 新键（如 `ui:islandX` 0..1），与 `ui:groupFilter` 同机制（`store.ts` 空串删键幂等）；Y 恒定吸顶不存。
- 通道不变：`dock:hidden` / `dock:fluid` / `ui:collapsed`（`overlay.ts:100-101`），`safeSend` 语义不变。

## 关键技术决策

1. **窗口固定尺寸，不跟随岛 resize（推荐 A）**。现行窗口 56×56（`pet-view.ts:17`），岛收起 `fit-content`（上限 560px）、展开 430×~350。固定 `ISLAND_VIEW`（如 560×480，transparent + 穿透轮询已有 `overlay.ts:619-672`），渲染层按既有 `setPetHitbox` 上报岛/mini-pill rect。动态 `setBounds` 会与拖拽坐标、贴边持久化（R6：只存全可见位置）纠缠，否决。
2. **`isActive` 尺寸门同步改**（`overlay.ts:176-180` 要求 `BALL_VIEW` 全等，否则状态机不工作）。
3. **`peekHitbox` 改 mini-pill 矩形**：隐藏命中区从 `COLUMN_W` 条（`dock-hide.ts:112-129`）改为顶部 pill 区；`COLUMN_W`、`waterColumn`（`fluid.ts:110-114`）、`PetBall.tsx:957-984` 的 `fluid-pill` 同步删除。
4. **岛样式独立，不跟 skins 换皮**：深黑 iPhone 式是固定视觉资产；跟随 `--water-*` 令牌会引入四款环皮肤的条件分支，否决。等级色仍走连续水色口径。
5. **morph 复用相位、重写表现**：`fluidForPhase` 映射保留；absorbing/revealing 的 goo 水桥动画删，换 pill 收缩 + 岛 pop（原型 `islandPop` 用独立 `scale` 属性，避免冲掉定位 `translateX`——原型已踩坑）。
6. **展开态只读**：窗口切换等 mutations 留在详情页，岛内不接（与 UI 原型 anti-pattern 一致）。

## 兼容与回滚

- 设置页 + 右键菜单的隐藏开关（R7，`overlay.ts:203-210`）行为不变。
- `--uitest` / `--shots`：`dockDebugState` 的 fluid 字段、`data-ring` 探针（`PetBall.tsx:891` 多家语义变化）、`__bd_fluid_freeze` 取帧钩子同步更新；`test-fluid.mjs` 水柱用例删，`test-dock-hide.mjs` peek 用例改 pill。
- 回滚：水柱删除独立 commit；岛新增文件独立，`PetBall` 收起分支切换为单点开关。
