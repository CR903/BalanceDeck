# 设计：灵动岛高保真还原

## 架构与边界

纯表现层还原 + 一条启动路径改动，不动数据口径（percent/levels/read-model/ProviderMark
全部沿用）与 dock 状态机。不新增 IPC 通道。

## 数据流与契约

- 环境辉光颜色由 JS 算（最满家等级 → rgba），以 `--glow` CSS 变量下发，CSS 只消费；
  与阈值判定单一来源（`levels`），不另起颜色表。
- 展开嵌套环复用收起 `NestedRings`（参数化 size），图例为其附属小组件；单窗回退现有
  单环 + 单行条 patri。
- 启动面板：内存态强制 `collapsed=false`，不回写 `state.json`（幂等：每次启动都先见面板）。

## 关键技术决策

1. **combo 36px 只动收起**：`RING_SIZE` 拆分为收起 36 / 展开嵌套 40（原型两处本就不同，
   demo.html:154 vs :233），展开单环保持 40 不动。
2. **动画只用合成器属性**（scale/opacity），`prefers-reduced-motion` 下整组静止；
   ping 环用 `::after` + `currentColor`，不新增 DOM。
3. **mini-pill 收窄不改高**：26px 高不变，padding 0 14→0 10，dots gap 7→5，
   贴原型 A 的窄条精神（原型 B 无隐藏态可抄，以 Chak 截图验收为准）。
4. **启动面板不污染持久化**：`ui:get-collapsed` 首帧仍读盘，但主进程启动序列把内存态
   置展开；用户点收起后走正常落盘。`toggleOverlay` 语义不变。
5. **验收以 harness 并排截图为准**：原型 `?variant=B` 与 harness 同视口同数据截图，
   目检 + 关键 px（52 高 / 36 环 / 12 间距 / 430 展开宽）断言。

## 兼容与回滚

- 水色锚点/阈值/拖拽/隐藏时序零改动；CSS 文件独立（`island.css`），回滚即 revert。
- `--uitest` 探针不动（只加嵌套环的 `data-win` 已有覆盖）。
