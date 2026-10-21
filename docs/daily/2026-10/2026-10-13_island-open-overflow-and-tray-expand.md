# 2026-10-13 展开面板滚动条归零 + 托盘左键展开定位

## 起因

用户两张截图报两个问题：①展开面板出现横向滚动条，**2K 屏下没有** → 请做分辨率兼容；
②点击状态栏应展开第一张图那块面板并定位在状态栏底下，右击保留现有选项。

追问后确认三点：立 Trellis 轻量任务并清掉失效任务指针（`09-18-pet-render-fixes-tts`）；
定位 = 屏幕顶部居中、紧贴菜单栏下沿；再点 = 收起/隐藏。另需澄清「第一张图面板」是
灵动岛**展开态**（`.isl-body.open`，430px 居中 2 列卡片），不是 384×600 主卡片视图 ——
PRD 初稿我写成「展开成主面板」，review 阶段改回。

## 起因定性：不是分辨率问题

用户表述「2K 屏下没有」很容易把修复引向 DPI 相关 CSS。用真实 `island.css` + `skins.css`
在 Chromium 里量，真相是**所有屏都在溢出**，2K 只是叠加式（overlay）滚动条平时不渲染：

| 状态 | scrollWidth / clientWidth | scrollHeight / clientHeight |
|---|---|---|
| 修复前 | 435 / **419** | 245 / **237** |
| `.isl-body.open::after{inset:0}` 后 | 430 / 430 | 237 / 237 |

因果链一环扣一环（少一环都会修错地方）：

1. `.isl-body.open` 设 `overflow-y: auto`；
2. CSS 规范：一轴为 `visible` 且另一轴非 `visible` 时，`visible` 被计算成 `auto`
   → 横轴实际也可滚（写的人只想着纵向）；
3. 氛围辉光 `.isl-body::after` 的 `inset: -8px -16px` 把盒子向外扩 16px（横）/ 8px（纵）；
4. 于是那 16/8px 成了**可滚动溢出**，滚动条长度恒等于 inset。

关键洞察：`filter: blur()` 的**绘制**外溢不计入可滚动溢出 —— 所以把 inset 收回 0，
blur 保留、辉光不丢、溢出照样归零。

## 改了什么（`10-13-island-open-overflow-and-tray-expand`，2 次提交）

- R2 溢出归零（`island.css`）：展开态辉光 `inset: 0`；另加 `overflow-x: hidden`
  作**结构护栏**（`.isl-legend-item` 是 `nowrap` 且整条链无裁剪，长窗口名实测撑出 21px）。
  收起态 `.isl-strip` 的外扩辉光原样不动（它没有 overflow，扩出去本来就该看得到）。
  明令禁止用 `scrollbar-width: none` 那类「藏滚动条」掩盖 —— 内容照样能被横向拖走，
  下一块屏还会再露一次。
- R3 托盘展开（`overlay.ts` / `tray.ts`）：新增 `expandIslandPanelFromTray()`，
  落位顶部居中紧贴菜单栏下沿；居中算术抽 `centeredX()` 与 `dockTestToEdge` 共用，
  不长第四份坐标计算（已有 `snapBackToWorkArea`/`resizeCollapsed`/`setCollapsed`/
  `win.on('show')` 四处同类）。macOS 左键走展开、右键菜单与非 macOS 行为不变。
- R4 跨层通道：`ui:island-open` 用**单调序号**而非布尔，由常驻 `App` 订阅后以 prop
  转发给岛（岛随收起/展开挂载卸载，自己订阅会吞掉「面板还在卡片视图」那一帧）；
  `dockHidden` 期间不消费，避免与强制收起 effect 同帧打架把意图花掉。
- 门禁：静态门 `L10`~`L10d`（`test-structure.mjs`）+ uitest 运行门
  （`islandOpenNoOverflow`/`islandOpenTallScroll`/`islandOpenGlow`/AC4 托盘几何段）。

## 波折

1. 子代理派发失败（provider `ECONNRESET` 两次，含一次 HTTP 400 streaming），改主会话内联实现。
   实现代码其实在更早一次中断的会话里已落地，本轮主要工作是**审阅 + 补验证**，
   而非从零写 —— `git status` 显示 11 个文件已改是判断的转折点，否则会重复实现一遍。
2. PRD 初稿把「第一张图面板」写成主卡片视图，review 时按截图核对发现是灵动岛展开态，
   已修正 PRD 再开工 —— 两个面板的窗口尺寸与落位语义完全不同，照初稿做会全错。
3. 排查期一度怀疑是 2K/非 2K 的 DPI 或字体渲染差异，靠把 inset 改 0 前后量一次
   才收敛到「伪元素外扩」这个单一根因。教训：分辨率相关 bug 先量滚动量，再谈缩放。

## 验证

- `npm run typecheck` ✓；`npm test` 全绿（`structure`/`tray` 98/`island-clip` 37 等，0 失败）。
- **守卫红过一次**：把 `inset` 改回 `-8px -16px` → `✗ L10 展开态辉光 inset 收回 0
  （实际 -8px -16px）`，复原后 0 失败（「没红过的守卫等于没有守卫」）。
- 浏览器实测：不超高时 `sw==cw`、`sh==ch`；塞 18 卡超高时 `sw 419 == cw 419`（无横条）、
  `sh 1415 > ch 440`（纵滚正常）。
- 提交：`8f526ae`（源码 + spec）→ `7d35da9`（任务产物）。

## 沉淀

- `.trellis/spec/frontend/component-guidelines.md` 新增「氛围辉光不许外扩出滚动容器」
  （与 D6 box-shadow 条目同类，含两种错误修法对照）。
- `.trellis/spec/frontend/state-management.md` 新增「间歇挂载组件不得持有主进程推送订阅」
  （契约表 + 错误矩阵 + wrong/correct）。
- `docs/knowledge/` 判断为**不更新**：两条都已带取证落在 spec，knowledge 收「判断准则」、
  spec 收「怎么写代码」，本次属后者。
- 待人工实机：外接非 2K 屏确认横向滚动条消失、托盘左键展开落位与再点隐藏。
