---
id: "067a74d8-c3d4-42ec-8b9c-a9bd100dc025"
title: "BalanceDeck 收起态 3D 第二轮：球/宠物双形态、置顶开关与 CC0 GLB 素材管线（含 Electron 坑位）"
description: "BalanceDeck 第十七轮增量工程参考：默认 3D 球形态 vs 桌面宠物形态、ui:alwaysOnTop、收起态必须关原生窗口阴影（方框根因）、Kenney Cube Pets CC0 GLB 内联管线与 CSP、Electron 主进程定时器崩溃类坑、three.js 组合坑、自检命令与断言。修正并替代既有文档 38d69245 中已过期的部分事实。"
status: "active"
created_at: "2026-09-15T08:25:44.850Z"
updated_at: "2026-09-15T08:25:44.850Z"
content_hash: "e1270842c383bb34602a334c081abc360bb9ed07be2957e787d36f6385b96265"
source_paths:
  - "src/main/overlay.ts"
  - "src/main/ipc.ts"
  - "src/renderer/src/pet3d/scene.ts"
  - "src/renderer/src/pet3d/models.ts"
  - "src/renderer/src/pet3d/thumbnail.ts"
  - "src/renderer/src/PetBall.tsx"
  - "src/renderer/src/PetSection.tsx"
  - "src/renderer/src/assets/pets/LICENSE-kenney-cube-pets.txt"
  - "electron.vite.config.ts"
  - "src/renderer/index.html"
  - "src/shared/pet.ts"
  - "scripts/test-walker.mjs"
  - "scripts/test-pet.mjs"
  - "DESIGN.md"
  - "TASKS.md"
session_ids:
  - "9ad3b162-23db-45a5-a2fe-99798cf74087"
memory_body_ids:
  []
---

# BalanceDeck 收起态 3D 第二轮 — 双形态、置顶、CC0 GLB 素材管线与 Electron 坑位

来源：2026-09-15 第十七轮（用户 4 项反馈：① 悬浮球默认回到 3D 圆球形态，开启桌面宠物才是宠物形态；② 要置顶开关；③ 桌面宠物外面有个四方形框、宠物不够真实（建议上网找 3D 素材）；④ 点击悬浮球弹 Uncaught Exception）。

⚠️ **本文修正并替代既有文档《BalanceDeck 收起态 3D 桌面宠物：实现架构、自检流程与坑位》（id `38d69245-956d-408c-ae68-40d6fde75151`）中已过期的部分**：`ui:pet` 默认值、收起态窗口尺寸、`pet3d/rig.ts`（已删除）、角色取材方式。第十六轮的球体合成手法、逐皮肤令牌、命中半径换算、鼠标穿透协议仍然有效，不重复。

## 1. 双形态（替代原「收起态恒为 320×230 漫游区」）

| 形态 | 触发（偏好键 `ui:pet`） | 收起态窗口 | 内容 |
|---|---|---|---|
| 3D 悬浮球（**默认**） | 未设置 / `'0'` | 200×210 | 玻璃球 + 环形仪表，百分比在**环心** |
| 3D 桌面宠物 | `'1'`（设置页「宠物 → 桌面宠物」开关） | 320×230 漫游区 | 球内 3D 角色自主走动、发呆、打盹；百分比移到球下方 DOM 胶囊 |

- 窗口尺寸与形态绑定：`overlay.ts` 的 `collapsedTarget()`；启动时先 `await primePrefs()`（读 `ui:pet` / `ui:alwaysOnTop`）再 `createOverlay()`，避免先小后大闪一下；运行中开关切换走 IPC `pet:mode` → `setPetMode()` → `resizeCollapsed()`。
- 两种形态共用同一个 WebGL 场景（`createPet3dScene(host, id, { roam })`），球形态只是不加载/不显示角色（`petHolder.visible = roam`）。
- 相关偏好键：`ui:pet`（默认关）、`ui:petRing`（用量环）、`ui:alwaysOnTop`（默认开）、`ui:petState`（养成数据）；`ui:petCard` 已废弃。

## 2. 置顶开关（`ui:alwaysOnTop`）

- 主进程 `setAlwaysOnTopPref(on)` → `win.setAlwaysOnTop(on, on ? 'floating' : 'normal')`；`primePrefs()` 在启动时先读再做首次应用。
- 两个入口：设置页「系统 → 悬浮球总在最前」、悬浮球右键菜单「总在最前」（菜单模型字段 `PetMenuModel.alwaysOnTop`）。
- 注意：光标轮询里的“被盖住时重新置顶”必须先判 `if (alwaysOnTop)`，否则会把用户的关闭偏好打回去。

## 3. 收起态**必须**关闭原生窗口阴影（「四方形框」根因）

- 现象：桌面宠物外面套着一个矩形阴影框，不像真实贴桌面的宠物。
- 根因：窗口 `transparent: true` + 内容由 **GPU 合成（WebGL canvas）** 时，macOS 的原生窗口阴影按**窗口矩形**计算，不跟随内容 alpha 形状（普通 DOM 内容才会跟随）。
- 修法：`hasShadow: !collapsed`（`createOverlay` 初始）+ 在 `setCollapsed()` 里 `win.setHasShadow(!collapsed)`；收起态的立体感全部交给场景内接触阴影（软阴影贴图；有真阴影时用 `ShadowMaterial` 承接面）。
- 已加回归断言：uitest `petNoWindowShadow`（收起态 `win.hasShadow()` 必须为 false）。

## 4. CC0 3D 素材管线（替代原程序化角色 `rig.ts`，该文件已删除）

- 素材：**Kenney「Cube Pets 2.0」，CC0 1.0**（公共领域，可商用免署名；仍随包附授权原文 `src/renderer/src/assets/pets/LICENSE-kenney-cube-pets.txt`，README 署名）。内置 8 只 GLB：`animal-{cat,dog,penguin,fox,panda,bunny,koala,tiger}.glb`（各 120–175 KB）+ 外链贴图 `colormap.png`。
- 角色 id：`mochi`(猫) / `shiba`(犬) / `penguin` / `fox` / `panda` / `bunny` / `koala` / `tiger`；旧 id 自动迁移 `dino→fox`、`slime→bunny`（`shared/pet.ts: LEGACY_PET_IDS` + `normalizePetId`），养成进度不丢。
- **打包期**：Vite 自带的 `?inline` 对二进制资源是“原样内联成字符串”，Rollup 会按 JS 解析而报错。`electron.vite.config.ts` 新增 `glbInline()` 插件（`enforce: 'pre'`，`resolveId` + `load`）把 `*.glb?inline` 变成 `export default "data:model/gltf-binary;base64,…"`。
- **运行期不能 fetch**：打包后渲染层是 `file://` 页面，`fetch('file://…/x.glb')` 被 Chromium 拦（跨源）。所以走 base64 data URL 交给 `GLTFLoader`；每个模型是独立 chunk（动态 `import()`），首屏只加载当前那只。
- **外链贴图**：Cube Pets 的调色板在 GLB 之外（`Textures/colormap.png`），从 data URL 加载时相对路径无从解析 → 把该 PNG 也用 `?inline` 内联，并用 `THREE.LoadingManager().setURLModifier(url => /colormap\.png$/i.test(url) ? dataUrl : url)` 重定向。
- **CSP**：`src/renderer/index.html` 放宽到 `img-src 'self' data: blob:; connect-src 'self' data: blob:`（脚本/样式仍限自身）。
- **设置页缩略图**（`pet3d/thumbnail.ts`）：临时 `WebGLRenderer` 渲一帧 → `toDataURL` → **立即 `renderer.dispose()` + `forceContextLoss()`**，结果按尺寸缓存后以 `<img>` 显示。8 只角色各占一个 WebGL 上下文会吃满浏览器额度，必须用完即弃；渲染需串行。
- **归一化**：加载后统一「水平居中 + 缩放到目标高度（26 世界单位）+ 脚踩 y=0」，朝向统一为 +Z。

## 5. Electron 主进程健壮性坑（用户报的崩溃就是这一类）

1. **定时器回调里抛异常 = 应用直接弹「Uncaught Exception」并终止**（不是只中断那一帧）。所以拖拽帧（16 ms）与光标轮询（90 ms）两处 `setInterval` 回调整体 `try/catch`，异常只记录一次日志。
2. 具体触发点：`win.setPosition(nx, ny)` 收到 `NaN` → Electron 报 `conversion failure from`。防御：渲染层传来的抓取点、`screen.getCursorScreenPoint()` 结果、目标坐标全部 `Number.isFinite` 校验，非有限值跳过该帧（不要在回调里做可能返回 NaN 的算术后直接调用窗口 API）。
3. **`executeJavaScript` 的返回值必须可结构化克隆**：调试钩子里塞函数（如 `window.__bd_ball()` 返回对象里带一个操作函数）会让结果回传失败，表现为 renderer 侧未捕获的 `An object could not be cloned`。把“取数据”和“做操作”拆成两个钩子（`__bd_ball()` / `__bd_hide()`）。

## 6. three.js 组合坑

1. **归一化层与动画层必须分离**：动画若直接改承载“缩放/居中”的那层 `Group.scale`，会把归一化缩放覆盖掉，模型缩回原始尺寸（表现为“宠物看不见”）。做法：外层动画容器 → 内含 `instantiatePet()` 返回的归一化容器。
2. **角色别挂在会移动的父节点下**：球壳为跟随角色做了延迟位移（lerp），若角色是球壳子节点、又按世界坐标赋值，位置会被叠加两次（角色跑到球外）。角色放 `scene` 世界坐标，球壳跟随它。
3. 关掉阴影时（软渲染器 SwiftShader/llvmpipe 自动关）必须同时 `light.castShadow = false` 且隐藏 `ShadowMaterial` 承接面，否则会采到空阴影图、把整块面渲染成深色圆盘。

## 7. 自检与验证（受限环境下的可复现流程）

- 单帧迭代 3D 观感：`electron . --ballshot`（十几秒出图到 `/tmp/balancedeck-shots/`）
  - `BD_PET=1` 宠物形态 · `BD_PETS=1` 逐只角色 · `BD_SKINS=1` 逐皮肤 · `BD_SETTINGS=1` 设置页宠物分区
  - `BD_DEBUG_RING=1` 画出命中环（核对“球的投影”与“可点区域”）· `BD_ISOLATE=1` 逐个隐藏场景物体排查多余像素
- 完整走查：`--shots`（29 张，含 `5-ball-*`/`5c-ball-{5 皮肤}`/`5b-pet`/`5d-pet-happy`/`5e-pet-menu`/`5f-pet-*`/`4b-settings-pet`）
- 回归：`npm test`（单元 187：percent 21 / ssr 17 / quality 32 / tray 29 / **pet 64** / **walker 24**）、`--uitest`（**74 项**，含两种形态窗口尺寸、`petModel` 素材就位、置顶开关三态、`petNoWindowShadow`、鼠标穿透、长按撸一把、右键菜单）
- 宿主沙箱里跑 Electron 需要：`BD_SANDBOX_OFF=1`（`no-sandbox` + `disable-gpu-sandbox` + `enable-unsafe-swiftshader`）与 `BD_USER_DATA=<可写目录>`（把 state.json/secrets.bin 落到工作区内）；**仅自检用，用户正常运行不需要**。
- 相关仓库文档：`DESIGN.md`（设计取舍与形态表）、`TASKS.md`（第十六/十七轮记录）、`README.md`（素材署名与使用说明）。
