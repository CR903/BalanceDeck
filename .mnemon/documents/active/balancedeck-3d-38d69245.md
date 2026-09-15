---
id: "38d69245-956d-408c-ae68-40d6fde75151"
title: "BalanceDeck 收起态 3D 桌面宠物：实现架构、自检流程与坑位"
description: "BalanceDeck 悬浮球/桌面宠物工程参考：three.js 场景构成、逐皮肤令牌、漫游与鼠标穿透协议、命中半径换算、--ballshot/uitest 自检工具、受限沙箱与 WebGL 环境坑位、已修的 bug 类。"
status: "active"
created_at: "2026-09-15T07:20:44.006Z"
updated_at: "2026-09-15T07:20:44.006Z"
content_hash: "70fc696515067b374fa449c180524f2034cc0e45060503a64574530ef7a56fc1"
source_paths:
  - "src/renderer/src/pet3d/scene.ts"
  - "src/renderer/src/pet3d/rig.ts"
  - "src/renderer/src/pet3d/walker.ts"
  - "src/renderer/src/pet3d/tokens.ts"
  - "src/renderer/src/PetBall.tsx"
  - "src/renderer/src/PetSection.tsx"
  - "src/main/overlay.ts"
  - "src/main/ipc.ts"
  - "src/shared/types.ts"
  - "scripts/test-walker.mjs"
session_ids:
  - "28104388-49cb-4466-9ea5-f8443d20b4ae"
memory_body_ids:
  []
---

# BalanceDeck 收起态 3D 桌面宠物 — 实现架构、自检流程与坑位

来源：2026-09-15 第十六轮（用户反馈两项：① 悬浮球有黑边、不是真立体、其它皮肤没立体感；② 去掉面板宠物精灵模块，让整个悬浮圆球变成会走动的 3D 桌面宠物）。以下为可复用的工程结论，不含凭据与原始日志。

## 1. 交付形态

- 收起态窗口从 **56×56 圆点** 改为 **320×230 透明漫游区**（`src/main/overlay.ts: COLLAPSED`）。区域内唯一可见物是 three.js 渲染的**玻璃球壳 + 贴球面的环形 KPI + 球内 3D 卡通角色**；其余像素完全透明且鼠标穿透。
- KPI 数值与供应商名不用 WebGL 文字，改用 **DOM 胶囊**锚定在球下方（透明窗口里 DOM 文字更清晰，且随皮肤换色）。
- 面板里的宠物卡整块删除（`PetCard.tsx`、`CollapsedDot.tsx` 已移除）；宠物管理迁到**设置页「宠物」分区**（`PetSection.tsx`）。
- 偏好键：`ui:pet`（是否 3D 桌面宠物，默认开，`'0'` 关闭）、`ui:petRing`（是否显示用量环）、`ui:petState`（养成数据单行 JSON）；**`ui:petCard` 已废弃**。

## 2. 代码地图

| 文件 | 职责 |
|---|---|
| `src/renderer/src/pet3d/scene.ts` | 球壳/亮边/皮肤色暗边/镜面高光/接触阴影/环形仪表/光照/逐帧动画/命中框投影 |
| `src/renderer/src/pet3d/rig.ts` | 程序化 3D 角色：`SPECS` 参数表（比例+调色板+部件开关）共用一套构建器，含描边与全套动作 |
| `src/renderer/src/pet3d/walker.ts` | 桌面漫游纯函数状态机（idle/walk/pet/eat/sleep），24 项单测覆盖 |
| `src/renderer/src/pet3d/tokens.ts` | 皮肤令牌 → 3D 材质颜色（`getComputedStyle` 读 `--bg-solid/--ok/--warn/--danger/--track/--fg`） |
| `src/renderer/src/PetBall.tsx` | 收起态组件：命中层、单击/拖动/长按/右键、2D 兜底、`window.__bd_ball()` 调试钩子 |
| `src/main/overlay.ts` | 漫游窗口尺寸、位置持久化、抓取点拖拽、**光标轮询与鼠标穿透** |
| `src/main/ipc.ts` | `pet:menu`（原生菜单）、`pet:hitbox`、`debug:pet-state`（仅测试模式注册） |
| `src/shared/types.ts` | `PetHitbox` / `PetMenuModel` / API 契约 |
| `scripts/test-walker.mjs` | 漫游状态机单测（`npm run test:walker`） |

## 3. 关键技术决策与理由

### 3.1 为什么用真 WebGL（three.js）
用户明确选「真 3D」而非 CSS/SVG 拟真：角色体积、走动、转身、光照一致性，以及「角色 + 玻璃球 + 环」三者互相遮挡，2D 伪 3D 无法自洽。代价是渲染层 bundle 增加约 1.48 MB（Vite 内联，打包无需 node_modules/three）。

### 3.2 玻璃球怎么合成（刻意不用 transmission）
透明窗口 + 软渲染器下 `MeshPhysicalMaterial.transmission` 要多一趟渲染，太贵。实际用五层叠加得到玻璃感：低不透明度球壳（`depthWrite:false`）+ **反面球壳加法混合的菲涅尔亮边** + **皮肤色暗边**（约 14–22% 不透明、取 `--fg` 派生色，**不是黑色**——这正是上一版「黑边」的根因）+ 顶/底镜面高光 + 地面软阴影贴图。所有球内元素 `renderOrder` 分层，球壳不写深度以免遮住角色。

### 3.3 逐皮肤立体（新增皮肤零代码）
3D 场景不消费 CSS，但颜色全部从 `document` 上的 CSS 变量读取（`getComputedStyle`）：壳体取 `--bg-solid`（浅色压暗 4%、深色提亮 18%）、环色取 `--ok/--warn/--danger`、环底托取 `--track`、暗边取 `--fg`。皮肤令牌变化时通过 `MutationObserver` 监听 `.app[data-skin]` 重读，无需重建场景。

### 3.4 角色材质与造型
- `MeshToonMaterial` + `DataTexture` 渐变在实机发灰发暗（颜色被当亮度查找表用），已换 **`MeshLambertMaterial`**；小件（眼白/瞳孔/嘴）用 `MeshBasicMaterial` 保证小尺寸清晰。
- 描边用**背面外扩壳**（同几何、scale≈1.07、`side: BackSide`），每帧同步主体的 position/rotation/scale。
- 眨眼用**眼皮网格下盖**而不是压扁眼球；角色永远面向镜头（侧对镜头会像被压扁），仅按行走方向 `root.scale.x = ±1` 翻转。

### 3.5 相机与命中半径（换算坑）
透视相机 FOV 35°、距离 162，球约占窗口高度 40%。命中半径必须按**切线角**换算：

```
r_px = tan(asin(BALL_RADIUS / dist)) / tan(fov/2) * (h/2) * 0.98
```

朴素的 `BALL_RADIUS / dist / tan(fov/2)` 与实测像素差约 2 倍（实测球 216px vs 估算 105px）。命中框中心必须**跟着球走**（球壳位置投影），否则角色走到一侧时点不到。

### 3.6 漫游状态机（纯函数）
idle 随机等 1.6–5.2s → 随机选点 → 走向目标（1.2 单位判达、4.5s 超时保护）→ 回 idle；靠近边界时目标取对侧（自然回头）；位置硬夹在漫游区内；**单帧 dt 夹到 0.1s**（休眠/掉帧后不瞬移）。漫游区半径 ±58（世界单位），窗口 320×230。

### 3.7 鼠标穿透协议（收起态核心）
渲染层每 90ms 用球心投影 + 上述半径算出命中框，`pet:hitbox` 上报；主进程每 90ms 轮询光标：命中 → `setIgnoreMouseEvents(false)`；未命中 → `setIgnoreMouseEvents(true, { forward: true })`。**轮询只在收起态运行**，展开面板立即停止（否则面板会出现点不动的空洞）。冷启动即收起态时，开关必须在 `syncCollapsedState()` 里补一次，因为 `setCollapsed` 不会被调用。

### 3.8 菜单：模型在渲染层，原生菜单在主进程
`pet:menu(model)` 由渲染层给出 `PetMenuModel`（标题、状态行、可否撸/喂、宠物 radio 列表、开关勾选态），主进程 `Menu.buildFromTemplate(...).popup({window, callback})` 回传选中项 id，业务动作（改状态、落盘、播放动画）仍在渲染层。避免主进程持有宠物业务状态。

### 3.9 兜底与省电
WebGL 初始化失败或用户关闭「桌面宠物」时回到原 2D 圆点（`--dot-*` 令牌保留，功能不丢）。面板展开时 PetBall 卸载 → 场景整体 dispose，不空转渲染。

## 4. 自检流程（可复现）

- `electron . --ballshot`：只拍收起态悬浮球，十几秒出图到 `/tmp/balancedeck-shots/`；
  - `BD_SKINS=1` 逐皮肤各拍一张（回归「每种皮肤都有立体感」）；
  - `BD_DEBUG_RING=1` 在窗口里画命中环（虚线圆），用于核对「球的投影」与「可点区域」是否重合；同时打印 `ballState`/`ballDiag`。
- 渲染层调试钩子 `window.__bd_ball()` 返回 `{rect, center, measure}`：`measure` 用 `gl.readPixels` 统计 alpha>8 的真实像素范围与占比 —— 它是命中框的**真值来源**。
- `npm run uitest`：74 项断言含 `petPierce`（主进程轮询在跑 + 命中框已上报）、`petCmdOk`（收起态窗口 320×230）、`petLongPress`（长按加亲密度且不展开）、`petFallback`（关掉后无 canvas）、`petBallOff/On`、`pet3dCanvas`、`petMenuOpened`；窗口尺寸断言已随 `COLLAPSED` 同步修改。
- `npm run shots`：26 张走查图（`4b-settings-pet` / `5-ball` / `5b-ball-walk` / `5c-ball-{5 皮肤}` / `5d-ball-pet-happy` / `5e-ball-menu` / `5f-ball-2d`）。
- 单测：`npm test` 共 183 项（新增 `test:walker` 24 项）。

## 5. 受限环境坑位（本次实测）

- **Electron GPU 进程起不来**：沙箱里启动即 SIGTRAP / `sandbox initialization failed`。开关 `BD_SANDBOX_OFF=1` 会追加 `--no-sandbox --disable-gpu-sandbox --enable-unsafe-swiftshader`（仅自检用，正常启动不走）。
- **userData 不可写**：`~/Library/Application Support/balancedeck` 在工作区外，写 secrets.bin/state.json 会 EPERM。用 `BD_USER_DATA=<目录>` 覆盖 `app.setPath('userData', …)`。
- **npm 安装**：本机 `~/.npm` 缓存被 root 拥有 → `EPERM`；`registry.npmjs.org` 不可达。改用 `npm install three --cache ./.npm-cache --registry https://registry.npmmirror.com`（`.npm-cache/` 已加入 .gitignore）。
- **WebGL 版本**：本机只有 WebGL2 可用；渲染器为 SwiftShader 软渲染，代码里按 renderer 字符串降采样（`pixelRatio ≤ 1.25`）保帧率。

## 6. 坑位与教训（bug 类，值得回归）

1. **穿透开关极性写反**：`setCollapsed(true)` 里误写 `setPetCursorWatch(!collapsed)`，导致**展开面板时反而开穿透**——面板出现「点了没反应」的空洞。定位手段：在 `setCollapsed`/轮询开关打 trace + 调用栈，发现 `setCollapsed(true)` 紧跟 `setPetCursorWatch(false)`。教训：开关类副作用的极性必须有断言覆盖（`petPierce`/`petCmdOk` 就是为此加的）。
2. **`gl.readPixels` 必须紧接同一次 `render()`**：WebGL 后备缓冲在合成后失效，异步读取会得到全 0。
3. **`MeshToonMaterial` + 3 阶 `DataTexture` 渐变发灰**：实机颜色严重去饱和，换 Lambert 后恢复。
4. **合成指针事件 + 真实光标错位会甩飞窗口**：拖动测试里抓取点必须用 `screen.getCursorScreenPoint() - win.getBounds()` 换算，否则窗口跳到物理光标处，后续位置类断言全崩。
5. **命中框必须随球移动**：静止球心会让走到一侧的角色点不到；改为每帧用球壳位置投影并 90ms 上报。
6. **构图参数改动要连带改断言**：`COLLAPSED` 从 56×56 变 320×230 后，uitest 里写死 `width <= 60` 的开合断言全部要改。

## 7. 已知取舍与后续

- **球走动时窗口不跟随**：`setBounds` 有延迟，跟随会产生抖动感；当前以 320×230 漫游区表达「走动」。跨屏串门需要窗口跟随方案，已列入 README/DESIGN 路线图。
- **角色保持原创程序化建模**（不内置动漫/版权 IP），后续计划支持 `userData/pets` 外部模型/皮肤包。
- 走查基线图：`docs/dot-pet.png`（收起态球）、`docs/screenshot.png`（面板，已无宠物卡）。
