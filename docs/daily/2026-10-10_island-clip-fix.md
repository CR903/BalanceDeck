# 2026-10-10 灵动岛边缘裁剪修复（复检 pass，截图交付）

## 起因

用户截图：岛拖到两边时右侧 logo 被裁掉一半。harness（真代码 + 真样式）复现：
`posX=0.821` 时 body 右溢 560 窗口 142px。真因：`left: posX%` + `translateX(-50%)`
定位，`posX` 只按比例钳 `[0.08,0.92]`，不看岛宽（fit-content 随家数变）。

## 改了什么（`10-10-island-clip-fix`）

- `pet-view.ts`：新增纯函数 `clampIslandPos(raw, islandW, hostW)` + `ISLAND_EDGE_PX=8`，
  中心 px 界与 legacy 比例界取交；`POS_MIN/MAX` 搬家单源。
- `IslandView.tsx`：加载/重测/落盘/拖拽四处同走钳制；`islandW` 实测重测（展开态跳过）；
  `ui:islandX` 仍是中心比例，口径不变。
- `test-island-clip.mjs` 新建 30 断言并入 `npm test` 链尾；harness 加 `?x=` 钩。
- 交付截图：`prototype/shots/harness-clip-{left,center,right}.png`（两端 8px 边距不断尾）。

## 验证

- 先红后绿：旧 bundle 右拖 +500px 右溢 107px（与报障同症）；修后四测全落窗内。
- `typecheck` ✓，`npm test` 全绿（含新套件 30/0）；复检 pass。
- `--uitest` 实机未验证（无显示服务，harness 截图为交付证据）。

## 附带记录

- 4 灰点 = 余额打码 `••••`，by design 未动。
- harness 窄视口会被 `.app:flex` 挤压（既有样式），验证用 1400px 视口。
