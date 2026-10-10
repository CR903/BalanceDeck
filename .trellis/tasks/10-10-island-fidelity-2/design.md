# 设计：灵动岛收起比例与展开结构还原

## 架构与边界

纯表现层：`island.css`（比例/阴影/伪元素）+ `IslandView.tsx`（cell 骨架与环 SVG 参数）。
不动数据口径、read-model、dwell/拖拽/钳制、overlay 启动序列。无新增 IPC。

## 数据流与契约

- 环 SVG 只换几何参数（viewBox/r/stroke），`pathLength=100` + `stroke-dasharray` 百分比口径不变，
  `NestedRings`（收起与展开共用）与 `Ring` 各自传 size/几何常量，≤3 环。
- 环心百分比文字：`fmtPercent(mainPct)`，缺失时保持缺失（不编 0，显示 `—` 或省略，与既有缺失值纪律一致）。
- 等级色仍由 `levels` 单一来源计算，彩条 `i` 宽 = percent、色 = 等级色，`--glow` 下发逻辑复用。

## 关键技术决策

1. **cell 骨架一次改到位**：`PlanCell` 输出 `.isl-cell > .isl-cell-top(单行: mark | ring | 列)`，
   右列 `.isl-cell-side = name + (嵌套 ? .isl-legend : .isl-wins)`；`BalanceCell` 仅对齐 padding/阴影，不改语义。
   去 `StatusDot`（等级已由环/条色表达，避免重复信号）。
2. **环几何常量共享**：`RING_GEO = { vb: 36, r: [15.5, 11.5, 7.5], stroke: [3.5, 3.2] }` 收起/展开同源，
   消除两处各写一套再漂移（本轮漂移的根因）。
3. **容器阴影/伪元素单点定义**：`.isl-strip`（收起）与 `.isl-body[open]`（展开）共用同一条 shadow 声明
   （含红晕 + 底部 inset 暗 + 1px ring），`::before/::after` 挂到不分状态的 `.isl-body` 上，
   用 `data-island` 只切宽度不动显隐 —— 避免再出现"展开态氛围丢失"。
4. **头部条移除不改手势**：`.isl-open-head` 删除；`展开面板` 按钮的回卡片入口由既有双击/右键承接
   （已签字的交互口径），backdrop 点击收起不变。
5. **断言先红后绿**：`test-structure` L 章按新数值改（logo 15 / gap 10 / 高光 60% / vb36），
   展开结构新增 D6c（单行骨架 + 无 head + 彩条）。

## 兼容与回滚

- 改动集中在 `island.css` + `IslandView.tsx` 两文件，revert 即回；测试断言随码同步。
- `--uitest` 探针：`data-supplier`/`data-kind`/`data-lvl`/`data-win` 全保留，D6 不破。
