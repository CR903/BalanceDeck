# FBX 材质实测记录（Aria/Ray 发黑根因）

诊断时间：2026-09-18。工具：`/tmp/probe-fbx.mjs`（Node + 仓库内 `three@0.177` 的 `FBXLoader`，
零 Electron，解析 `resources/human-pets/<id>/model.fbx`）。基线截图：
`/tmp/balancedeck-shots/pet-aria.png`、`pet-ray.png`（`BD_PETS=1` 于 12:20 采集）。

## 结论

**Aria/Ray 是纯黑剪影，根因是 `material.color = 0x000000`，不是打光问题。**
three 的漫反射是 `material.color × map.rgb`，黑 × 贴图 = 黑，所以调灯、调曝光、加 IBL 全都无效。

Rocketbox 的 FBX 是给 Unity/Unreal 做的，`DiffuseColor` factor 留黑、albedo 完全由贴图承担；
`FBXLoader` 忠实地把该黑值写进 `material.color`（`FBXLoader.js:570-577` 一带）。

## 实测原始输出

`aria`（`ray` 结构完全相同，仅贴图前缀 `m008_`）：

```
--- aria: meshes ---
material isArray: true  ctor: Array      // o.material 是数组，不是单材质
  [mat 0] type=MeshPhongMaterial color=000000 map=true mapName=Map #1  normalMap=true  alphaMap=false specularMap=true  transparent=false opacity=1 envMapIntensity=ABSENT
  [mat 1] type=MeshPhongMaterial color=000000 map=true mapName=Map #98 normalMap=true  alphaMap=false specularMap=true  transparent=false opacity=1 envMapIntensity=ABSENT
  [mat 2] type=MeshPhongMaterial color=000000 map=true mapName=Map #103 normalMap=false alphaMap=true  specularMap=false transparent=true  opacity=1 envMapIntensity=ABSENT
  groups: 7 组，materialIndex ∈ {0,1,2}，全覆盖 26898 顶点
  morphTargets: 0   bindMode: attached
  bbox size: [121.73, 174.04, 30.50]
--- aria: texture URLs requested (8) ---
  f014_head_specular.tga   f014_head_color.tga   f014_opacity_color.tga   f014_head_normal.tga
  f014_body_specular.tga   f014_body_color.tga   f014_body_normal.tga     f014_opacity_color.tga
```

`ray`：`bbox size: [134.78, 182.33, 35.12]`，其余同上。

## 由这些事实直接推出的修法

1. **反照率修正**：`color` 亮度 < 0.05 → 设白，让贴图决定颜色。（R1）
2. **Phong → Standard 转换**：实测 `envMapIntensity` 在 Phong 上是 `ABSENT`，
   而 `WebGLRenderer.js:2050` 只把 `scene.environment` 交给 `MeshStandardMaterial`
   → `human.ts:139-140` 那行 `if (mat && 'envMapIntensity' in mat)` 是**静默空操作**，
   `scene.ts:147-155` 的 `RoomEnvironment`（`DESIGN.md:277` 称"PBR 质感的关键"）从未作用到真人模型。（R2）
3. **必须处理 `material` 是数组**：现状 `human.ts:134-141` 把 `m.material` 当单材质用，
   实测它是长度 3 的数组 → 那段代码连数组都没遍历，是双重失效。（R1 实现要点）
4. **丢弃 `specularMap`**：FBX 引用 `f014_body_specular.tga` / `f014_head_specular.tga`，
   而 `scripts/fetch-human-pets.mjs:73` 用 `!/specular|wrinkle/i` 刻意排除采集
   → 磁盘上没有对应 PNG，搬过来就是每个材质一次 404。（R3）
5. **`morphTargets: 0`**：父任务 PRD 里"Rocketbox 含 ARKit 表情 blendshapes"的说法在 FBXLoader
   解析结果中不成立 → 表情/口型没有现成通路（写进 `09-18-human-realism` 的 out-of-scope）。

## 排除掉的假设（避免后人重走）

- **不是贴图 404 导致发黑**：color/normal/opacity 的 PNG 实测齐全，且与 `human.ts:43` 的重定向
  路径 `textures/<basename>.png` 完全对得上：
  `resources/human-pets/aria/textures/{f014_body_color,f014_body_normal,f014_head_color,f014_head_normal,f014_opacity_color}.png`
  （`.tga` 原件同目录共存）。缺的只有 specular。
- **不是 `SkeletonUtils.clone` 用错**：`human.ts:111` 用法正确。
- **不是 ACES / `premultipliedAlpha` / `powerPreference:'low-power'` 压暗**：
  若是曝光问题会看到明暗过渡，实测是**无渐变的平涂黑**，只有反照率为零才长这样。
- **不是"只有 opacity 网格、主网格丢了"**：FBX 本身就只有 1 个 SkinnedMesh
  （名字恰好带 `_opacity` 后缀），`scene.ts` 的 dump 输出是完整的。

## 复用这条诊断路径

`node /tmp/probe-fbx.mjs <aria|ray>` 可在 10 秒内复现上述全部结论，不需要起 Electron、不需要网络。
脚本要点（踩过的坑）：
- Node Buffer 是池化的（`byteOffset != 0`），直接 `loader.parse(buf)` 会让 `FBXLoader` 的
  `DataView` 从池首读起 → 报 `THREE.FBXLoader: Unknown format.`。
  要传 `new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice().buffer`。
- Node 无 DOM，需最小桩：`globalThis.self`、`TextDecoder`、`document.createElement(NS)`。
- 必须显式 `import` 仓库内的 `node_modules/three/build/three.module.js` 与
  `examples/jsm/loaders/FBXLoader.js`，否则版本与运行时不一致。

## 顺带发现：自检工具进不去宠物形态

`BD_PET=1 npx electron . --ballshot` 实测停在球形态（`diag.win = [200,210]`，
`petHolder.visible = roam` 因此为 false），拍不到角色——`src/main/index.ts:113-117` 用
`[...document.querySelectorAll('.pet-sec .switch')][0]` 按**下标**定位开关。
修任何视觉问题前要先修这个门禁，否则所有"我验证过了"都不可信。`BD_TOGGLE=1` 会打印
`after click: pet=… switchOn=…`，可用来区分"点错开关"与"点了但窗口没缩放"。
