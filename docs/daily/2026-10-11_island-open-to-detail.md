# 2026-10-11 灵动岛展开面板点进详情（复检 pass）

## 起因

用户要：展开面板点某家卡片直达其详情页，省去“回卡片再点一次”。

## 改了什么（`10-11-island-open-to-detail`，轻量 PRD-only）

- `IslandView.tsx`：`IslandViewProps` 新增可选 `onOpenDetail?: (id)`（缺省只读，
  旧行为保留）；`IslandOpen` 透传给 `PlanCell`/`BalanceCell`，两类 cell 根 div 加
  `onClick`（`stopPropagation + onOpen?.(s.id)`，`title` 兼 uitest 选择器）；
  根 `onPointerDown`/`onDoubleClick` 守卫扩展为 `button, .isl-cell[data-supplier]`，
  点卡片不进拖拽/点击状态机、不误触切换；空 cell 无 `data-supplier` 仍走旧切换。
- `App.tsx`：新增 `openIslandDetail(id)`（`setCollapsed(false)` + `window.api.expand()`
  + `openDetail(id)`，复用 `doExpand` 语义但省掉经 `card` 的中间渲染）；返回沿用
  `DetailView onBack → card`，无新增路径。
- `island.css`：`.isl-grid .isl-cell[data-supplier]` 加 `cursor: pointer` +
  `:hover brightness(1.12)`，作用域限定可点卡片。

## 波折

- 用 `onClick` 而不用 pointerUp：拖拽手势不产 `click`，天然不误触（与 button 同路）。
- 中途 D6d12 结构门因换行假红一次，收回一行解决，未改测试。

## 验证

- `npm run typecheck` ✓；`test:structure` 447 / `island-clip` 37 / `dock-hide` 155 /
  `fluid` 115 / `seam` 46 / `read-model` 119 / `quality` 32，全部 0 失败。
- 完整 `--uitest` 未跑（实机行为级复验，建议回归时补一次真机点击）。
- 提交：`4b7bb22`。

## 沉淀

- `.trellis/spec/frontend/component-guidelines.md` 新增可点击浮层纪律
  （`onClick` + 根指针守卫豁免）。
- 观察项（非拦截）：展开态从卡片起拖不再移窗（与 button 同路的自洽权衡），如需保留另起任务。
