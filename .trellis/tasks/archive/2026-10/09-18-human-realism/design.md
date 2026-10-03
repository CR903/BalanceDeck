# 技术设计：真人化人物材质与光照升级

## 核心判断（本设计与原 PRD 的最大分歧）

原 PRD 认为最大的技术不确定性是：「皮肤与衣服共用一张图集，分材质调参必须靠 UV 区域识别，
不能靠 `material.name`」。

**实测把这个不确定性解掉了**：上游的 specular 贴图本身就是逐区域的物理信号。
拉下来实际看过（2048² TGA）：

| 贴图 | 观察到的高光分布 | 推出的材质差异 |
|---|---|---|
| `f014_body_specular` | 手指/手部很亮（带关节褶皱）、衬衫中灰、西装翻领更亮、未用图集空间纯黑 | 皮肤亮 / 布料暗 |
| `f014_head_specular` | 完整脸部 UV 展开：T 区柔和高光、嘴唇很亮、头发细丝结构、眼球最亮、牙齿亮 | 皮肤 / 头发 / 嘴唇 / 眼睛 四种粗糙度 |

于是**不需要手绘 UV 遮罩** —— 把 specular 反相重映射成 `roughnessMap`，
逐区域差异自动就有了。这是物理驱动的，不是手调的。

**同时证明了一件更要紧的事**：头材质里脸/头发/嘴唇/眼睛/牙齿**全在同一个图集**，
所以「分材质分组」（3 组：body / head / opacity）**在结构上就不够**。
现状三个分组的参数是**完全相同**的：

```ts
// src/renderer/src/pet3d/human.ts:95-98  ← 零差异化，这就是"CG 塑料感"的来源
mat.roughness = 0.62
mat.metalness = 0
mat.envMapIntensity = 0.9
```

## 三个材质分组实际是什么

贴图侧是 `f014_body_*` / `f014_head_*` / `f014_opacity_*` 三套（`resources/human-pets/aria/textures/`），
FBX 的 3 个材质分组对应它们。所以**分组级差异可以做（body vs head vs opacity）**，
**图集内差异只能靠贴图**。两层都要，缺一不可：

```
材质级（3 组）              图集内（UV 区域）
body  : roughness 0.58      由 body_specular 派生 → 手部/布料/翻领自动分三档
head  : roughness 0.48      由 head_specular 派生 → 脸/头发/嘴唇/眼睛自动分四档
opacity: roughness 0.40     睫毛/薄纱，基本不吃 specular
```

## R2：specular → roughnessMap 的转换

### 为什么不用 `specularMap`

- `MeshStandardMaterial` **没有** `specularMap` 属性（PBR 里 specular 由 `metalness` + F0 决定）
- three 也不给 `MeshStandardMaterial` 提供 `specularIntensity` 之类的直接入口
- 结论：想用上 specular 的信息，只能转成标准材质认识的通道

### 映射公式

three 的 `roughnessMap` 读 **G 通道**，且最终值 = `material.roughness × map.g`。
所以贴图承担**分布**、`material.roughness` 承担**上限**：

```
specLum  = 0.2126·R + 0.7152·G + 0.0722·B     // 取亮度
t        = clamp01((specLum - LO) / (HI - LO))  // 拉直对比：素材高光动态范围很窄
out.g    = 1 - t                                // 高光处 → 低粗糙度
out.rgb  = out.g                                // three 只读 G，RGB 复制一份便于肉眼检查
```

- `LO` / `HI` 是拉直窗口。看过的两张图里，高光集中在中低亮度区，
  直接线性反相会让大片布料变全白（粗糙度 0），所以必须拉直 —— 具体数值在实现时
  按实测直方图定，写进常量并注释。
- 输出**灰度 PNG**（RGB 三通道相同），尺寸 `1024`（粗糙度是低频信号，
  2048→1024 不损失观感，省一半体积）。用户已接受体积上涨，但没理由浪费。
- 未使用的图集空间在 specular 里是纯黑 → `t=0` → `out.g=1` → 粗糙度最大。
  这正确吗？那些区域**根本不会被贴到**（没有 UV 引用），所以取值无所谓 ——
  但要确认 FBX 的 UV 没在未用区域取样，实测时顺手记一下。

### 转换脚本：纯 JS，零新依赖

`sips` 只能转换格式/缩放/调伽马，做不了逐像素重映射。按仓库既有先例
（`scripts/gen-icons.js` 是纯 JS PNG 编码器，`TASKS.md` 明确记着"无外部依赖"）：

```
scripts/specular-to-roughness.mjs
  读 PNG → zlib.inflate + 反 filter → 逐像素变换 → 编码 PNG（filter 0 + deflate）
```

Node 内置 `zlib` 足够，不引任何依赖。这个脚本同时是**可单测的纯函数**
（`specToRoughnessPixel` 之类），供 R6 的护栏用。

### 采集链路

`scripts/fetch-human-pets.mjs:110-112` 现在把 specular 过滤掉了：

```js
const texEntries = (await ghDir(`${pet.dir}/Textures`)).filter(
  (e) => e.type === 'file' && e.name.endsWith('.tga') && !/specular|wrinkle/i.test(e.name)
)
```

改成**采 specular 但不转格式**（转格式是纯 JS 脚本的活，`sips` 留着只处理 color/normal/opacity）：

- 过滤条件改为排除 `wrinkle`（虽然实测无此文件，留着无害且表达意图）
- specular 只下 TGA，不走 `sips`
- 收集完毕调 `specular-to-roughness.mjs` 批量生成 `f014_{body,head}_rough.png`
- `meta.json` 的 `files` 列表随 `readdirSync` 自动更新，无需手改

## R3：打光的「唯一参数源」

### 陷阱的准确位置

```ts
// src/renderer/src/pet3d/scene.ts:520-521  ← 每次换肤都硬写
scene.environmentIntensity = t.dark ? 0.4 : 0.55
ambient.intensity = t.dark ? 0.18 : 0.26
```

`applyTokens()` 在建场景时（`scene.ts:782`）和每次 `setSkin`（`scene.ts:802`）都会跑。
所以**任何在别处调的打光参数都只在换肤那一刻生效一次**，然后被这两行打回原形。
原 PRD 把这条标成"注意"，但没说清它会让 R3 的改动**根本观察不到**。

### 方案

`pet3d/rig.ts` 已经是「机位与轮廓常量的单一来源」（`fe1f00f` 建的原则），
照它加一张 `LIGHT_RIG`：

```ts
export const LIGHT_RIG = {
  light: { key: 2.4, fill: 0.5, rim: 1.0, ambient: 0.26, env: 0.55, exposure: 1.05 },
  dark:  { key: 1.7, fill: 0.38, rim: 0.85, ambient: 0.18, env: 0.40, exposure: 1.0 }
} as const
```

`applyTokens` 改成 `applyLightRig(t.dark ? 'dark' : 'light')`，
`applyLightRig` 负责写 `key/fill/rim/ambient.intensity/environmentIntensity/toneMappingExposure`。
建场景时也走同一个函数 —— 这样"只有换肤后才生效"的结构性陷阱被消除，而不是靠注释提醒。

数值是初值，实施时按走查截图调，调完**只改 `LIGHT_RIG` 一处**。

## R6：非主观护栏

原 AC 全是肉眼判断，最危险的失败模式是"看起来没坏"——平铺的 roughness 也能通过肉眼。
补 `scripts/test-human-mat.mjs`（纳入 `npm test`），三条断言都要有实际判据：

| 断言 | 判据 | 防的是什么 |
|---|---|---|
| 材质不再全等 | 三个分组的 `roughness` 不全等，且 head < body（皮肤比布料亮） | 「零差异化」原地不动 |
| 派生图有方差 | roughness PNG 的亮度标准差 > 阈值 | 平铺图（常数图）也能过肉眼 |
| 区域确实分档 | 抽样对比「手部区 vs 衬衫区」的粗糙度差 > 阈值 | 图虽然有方差但方差都在图集噪声区，真实部位没分档 |

第三条需要 UV 区域坐标。用固定抽样点（如 body 图集的四个象限），
坐标在实现时从实际图上量，写进脚本并注释「这是手/衬衫/裤/翻领」。

## 兼容性与回滚

| 面 | 影响 |
|---|---|
| 素材体积 | 每只 +2 张灰度 1024 PNG（~0.5–1MB），已确认接受 |
| 素材不进仓库 | `resources/` 已在 `.gitignore`，走 `bd-asset://` + `extraResources`，不变 |
| 老素材兼容 | 派生图是**新增**文件；缺失时 `human.ts` 退回当前常数 `roughness`，不报错 |
| Q 版 8 只 | **已下线**（`0f70602`），本轮无 Q 版回归面。原 AC「Q 版观感不变」已作废 |
| `predist:win` | **仍产不出 PNG**（`sips` 依赖，Q3 决定不修）。新增的纯 JS 转换脚本**无平台依赖**，反而是唯一能在 Windows 上跑的那一段 |
| 回滚 | R2 独立可回滚（不生成派生图即可，代码有缺失兜底）；R1/R3 各自单文件 |

## 风险

| 风险 | 应对 |
|---|---|
| 拉直窗口 `LO`/`HI` 取错 → 布料全变镜面 | R6 的「区域确实分档」断言 + 走查截图对比 |
| roughnessMap 在 `213×293` 窗口下看不出差别 | R4 明确按实际像素尺寸验收；必要时提高 `material.roughness` 的上限/下限差 |
| 采集体积涨太多 | roughness 用 1024 灰度，不无脑上 2048 |
| 换肤后又被打回原形 | 结构性消除（`applyLightRig` 单一入口），不是靠注释 |
| specular 图集未用区域被 UV 误取样 | 转换后抽一条基线：实拍时对比派生图在模型上的表现，记录取样范围 |
