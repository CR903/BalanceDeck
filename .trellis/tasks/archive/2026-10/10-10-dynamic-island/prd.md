# 灵动岛替换水柱

## Goal

收起态悬浮球的「水柱隐藏态」（贴边 12px 温度计柱）替换为顶部灵动岛：用户一眼看到各供应商用量，iPhone 式展开查看多时限详情。

## Background（已定结论，高保真原型见 `prototype/dynamic-island-demo.html?variant=B`）

- 形态：B 方案。只吸顶、不贴左右边，顶栏内可左右拖动（`state.posX`，截图验证拖动 0.5→0.72 全程吸顶）。
- 收起态：平铺**全部有效供应商**，每家=嵌套用量环（外→内=窗口顺序，最多 3 环）+ 中央真实 logo（`provider-icons.ts` 的 mark），无名称、无轮询；超长岛身自动加长（`fit-content`，上限 560px 后横滑）。
- 展开态：2 列卡片。plan 显示主环（=最满窗口）+ 各窗口单行条（名 · % · 重置倒计时）或嵌套环+图例；balance 显示大金额（`BalanceCard` 口径，金额为主）。
- 圆环统一 40px；滚动条深色；居中展开右偏 bug 已在原型修（动画用独立 `scale` 属性）。
- 图标动画：轮切 pop、常态呼吸 + ping 环、danger 抖动 + 环境辉光（原型级，落地时按性能取舍）。

## Requirements

- R1 收起态渲染顶部灵动岛替代水柱：吸顶、岛内左右拖动（`posX` 落盘 `ui:islandX`）、岛边缘/空白拖动移动窗口（拖拽分区，见 R7）。
- R2 收起态内容：全部启用的供应商（与 `visibleIds` / 分组筛选同口径），plan 家嵌套环 + logo，balance 家 logo + 金额；无数据/非 ok 态保持诚实表达（灰环 `--`，不编数字）。
- R3 展开态：点击岛身展开（弹簧 pop），点击空白收起；内容为各家多窗口明细 + 余额卡；只读，不接 mutations。
- R4 移除水柱实现：`PetBall.tsx` 的 `fluid-pill` / 水柱分支、`shared/fluid.ts` 的 `waterColumn`、`dock-hide.ts` 的 `COLUMN_W` 温度计口径及相关单测同步更新。
- R5 口径复用：百分比 `shared/percent` + `read-model.worstWindow`（主环=最满窗口），阈值色 `levels`，图标 `provider-icons` / `ProviderMark`。
- R6 隐藏行为（已决：保留自动隐藏）：dwell 时序沿用现行（贴边 1s 隐藏 / 痕迹 300ms 唤出 / 离开 1.5s 重藏，`dockHide.ts:10-12`），隐藏态缩成 A 式 mini-pill（窄条 + 各家等级点，顶部原位收缩，不贴边）；唤出 = hover 痕迹 / 点击。
- R7 回归：`tsc` + `npm test` 全绿；收起态现有能力（单击展开→现为岛展开/收起、窗口拖动移动、右键菜单）保持可达——窗口移动走拖拽分区（岛身 `posX` / 边缘空白移窗）；`--uitest` / `--shots` 探针同步。

## Acceptance Criteria

- [ ] AC1 收起态顶部可见灵动岛，无水柱残留（水柱 DOM 与水柱几何选择器删除；`data-fluid` 仅保留作隐藏相位同步钩子，不再挂水柱形态）。
- [ ] AC2 启用 4 家（含 1 家余额）时收起态一排显示，岛宽自适应；禁用某家后该家消失。
- [ ] AC3 多窗供应商展开后各窗口名 · % · 重置倒计时逐行可见；余额家显示金额而非环。
- [ ] AC4 岛身拖动改 `posX`、重开后位置保持；边缘/空白拖动移动窗口；点击（非拖）切换岛展开/收起。
- [ ] AC5 静置 1s 后岛缩成 mini-pill（窄条 + 各家等级点），hover/点击唤回；唤出后离开 1.5s 重藏。
- [ ] AC6 `npm run typecheck` 与 `npm test` 通过；受影响的单测已同步（不断言已删除的水柱几何）。

## Out of Scope

- A/C 变体（侧边胶囊、侧边常展轨）不落地。
- 图标动画的逐帧还原（以性能为准，可降级为静态 + danger 高亮）。
- 展开态内的 mutations（窗口切换选择器等沿用详情页，岛内只读）。

## Open Questions

- 无（Q1 已决，见 R6）。
