# island-open-overflow-and-tray-expand

## Goal

1. 修掉灵动岛展开面板在非 2K 屏上出现的横竖滚动条（根因：氛围辉光伪元素撑出滚动区，非分辨率兼容问题）。
2. 状态栏（托盘）左键点击：展开面板并定位到屏幕顶部居中、紧贴菜单栏下沿；再次点击收起/隐藏面板。右键保持现有菜单不变。

## Background / 已核实的排查结论

### R0 滚动条根因（已实测复现）

用真实 `island.css` + `skins.css` 在 Chromium 里量 `.isl-body.open`：

| 状态 | scrollWidth / clientWidth | scrollHeight / clientHeight |
|---|---|---|
| 现状 | 435 / **419** | 245 / **237** |
| `.isl-body::after{inset:0}` 后 | 430 / 430 | 237 / 237 |

因果链（每一环都要在修复说明里保留）：

- `src/renderer/src/island.css:323` `.isl-body.open` 设 `overflow-y: auto`；
- CSS 规范：一轴为 `visible` 且另一轴非 `visible` 时，`visible` 被计算为 `auto` → 横轴实际是 `auto`；
- `island.css:50` 起的 `.isl-body::after`（氛围辉光）`inset: -8px -16px`，向外扩 16px（横）/ 8px（纵）；
- 于是横竖都产生可滚动溢出。2K 屏叠加式滚动条平时不渲染，外接屏/非视网膜屏露出。

**结论：所有屏都溢出，只是有的屏把滚动条藏起来了。修复必须消掉溢出本身，而不是"隐藏滚动条"。**

### R1 托盘点击现状

- `src/main/tray.ts:52` 左键只调 `toggleOverlay()`：纯显隐，不改收起态、不重新定位。
- `src/main/tray.ts:57` macOS 右键菜单已实现（`setContextMenu` 会吃掉左键 click，故 macOS 只在右键手动 `popUpContextMenu`）。
- `src/main/overlay.ts:531` `toggleOverlay()` 只做 `win.hide()/show()`；`win.on('show')`（`overlay.ts:447`）已把 y 锁到 workArea 顶部，x 不动。
- 展开/收起收起态由 `overlay.ts:570` `setCollapsed()` 负责（并经 `ui:collapsed` 推送给渲染层）。

## Requirements

### R2 展开面板零横向溢出（必达）

- `.isl-body.open` 在**内容不超高**时，`scrollWidth === clientWidth` 且 `scrollHeight === clientHeight`（无横竖滚动条）。
- 内容超高时纵向仍可滚（`max-height: 440px` 语义不变），且此时**不产生横向滚动条**。
- 修法约束：消掉溢出源头本身。禁止用"隐藏滚动条"（`scrollbar-width: none` / `::-webkit-scrollbar{display:none}`）掩盖 —— 那样内容仍然可以被横向拖走。
- 氛围辉光（`.isl-body::after` 的 `--glow` 模糊层）视觉不得丢失：收起态 strip 与展开态 panel 都要保留环境辉光与 danger 呼吸。
- 不得回归既有约束：`.isl-root` 仍 `overflow: hidden`；`.isl-strip` 的横滑（超长岛身 528px 上限后横滑）行为不变；`scripts/test-island-clip.mjs` 全绿。

### R3 托盘左键 = 展开灵动岛面板 + 顶部居中定位

- 「第一张图面板」= 灵动岛**展开态**（`.isl-body.open`，2 列卡片，430px 居中），不是 384×600 主卡片视图。
- 左键点击状态栏 = 打开该展开面板：窗口置于**屏幕顶部居中、紧贴菜单栏下沿**（workArea 顶部 y、x 居中），且灵动岛处于展开态。
- 再次左键点击（面板正处于「已由托盘打开」状态时）= 隐藏面板。
- 面板若已在展示（无论主卡片视图还是灵动岛），首次点击按上一条展开语义处理，不额外多一次显隐跳变。
- 右键：菜单项与现有行为完全不变（macOS 手动 `popUpContextMenu`；非 macOS `setContextMenu`）。回归断言 `trayInteractionMode() === 'click-toggle'`（macOS）必须继续成立 —— 见 `src/main/qa/uitest.ts:965`。
- 定位逻辑只在"托盘点击展开"这条路径上生效：**不得**改变用户手动拖拽后的位置持久化语义（`notePosition` / `state.island` 落盘口径不变），也不得影响启动定位（`createOverlay` 的既有 R1/R2 规则）。
- 贴边自动隐藏状态机不受影响：点击前先取消隐藏计时/动画（复位到贴边全可见），与 `setCollapsed()` 既有口径一致。

### R4 跨层与可测性

- 主进程 → 渲染层的"展开"意图需有明确通道（如 `ui:collapsed` 推送或新增事件），渲染层不靠轮询。
- 新增/改动的可观察行为要有断言兜底（`--uitest` 或 `scripts/test-*.mjs` 静态守卫），至少覆盖：托盘点击模式仍为 `click-toggle`、展开后窗口几何、溢出归零。

## Acceptance Criteria

- [ ] AC1 溢出归零：在真实 `island.css` 加载下，`.isl-body.open` 内容不超高时 `scrollWidth === clientWidth && scrollHeight === clientHeight`（有自动化断言，且断言加载真源码而非内联副本）。
- [ ] AC2 辉光不丢：展开态与收起态的环境辉光/danger 呼吸仍在（`--glow` 仍被消费，`islandGlowPulse` 动画不因修复失效）。
- [ ] AC3 超高内容仍可纵滚，且此时无横向滚动条。
- [ ] AC4 macOS 托盘左键：显示 + 展开主面板，窗口 x 顶部居中、y = workArea 顶部；再次点击隐藏。
- [ ] AC5 托盘右键菜单项与现在一致；`trayInteractionMode()` 在 macOS 仍为 `click-toggle`。
- [ ] AC6 `npm run typecheck` 通过；`npm test` 全绿（含 `test:island-clip`、`test:tray`）；`--uitest` 相关段无回归。
- [ ] AC7 用户手动拖拽后的位置落盘语义不变（`state.island` / `notePosition` 口径未被改写）。

## Out of Scope

- 托盘图标跟随面板位置（不引入图标屏幕坐标定位）。
- 灵动岛内部布局、环几何、卡片内容调整。
- 非 macOS 平台的托盘左键行为改动（保持 `setContextMenu` 现状）。

## Notes

- 排查证据：probe 复现文件在会话临时目录（`island-scroll-probe2.html`），非仓库产物；修复后以仓库内自动化断言为准。
