# 设计：宠物渲染修复与定时播报

对应 `prd.md` 的 R1–R17。只写边界、契约、数据流与取舍；执行顺序在 `implement.md`。

## 改动边界

| 文件 | 责任 | 本任务改什么 |
|---|---|---|
| `src/renderer/src/pet3d/human.ts` | 真人素材加载/实例化 | 材质转换（Phong→Standard）+ 反照率修正 + 丢弃 specularMap（R1–R3） |
| `src/renderer/src/pet3d/viewfit.ts`（新） | 视口 → 可行漫游区反算 | 纯函数，无 three/React 依赖，可单测（R5–R7） |
| `src/renderer/src/pet3d/scene.ts` | 场景与帧循环 | `resize()` 里反算并写回 area；真人朝向偏航（R5、R10） |
| `src/renderer/src/pet3d/walker.ts` | 漫游状态机 | area 改为外部注入的可变量；输出速度方向供偏航用（R5、R10） |
| `src/main/overlay.ts` | 形态窗口尺寸与夹取 | `COLLAPSED_ROAM` 尺寸、拖拽夹取口径统一（R7、R11） |
| `src/renderer/src/skins.css` | 覆盖层定位 | 泡泡/caption/角标随新窗口尺寸复核（R8） |
| `src/renderer/src/voice.ts`（新） | 系统语音封装 | `speechSynthesis` 封装 + 中文音色选择（R12） |
| `src/renderer/src/App.tsx` | 偏好与数据主拥有者 | 播报定时器（R13–R16） |
| `src/renderer/src/PetSection.tsx` | 设置页宠物分区 | 开关 + 间隔档位（R13） |
| `src/main/index.ts` | `--ballshot` 自检工具 | 修 `BD_PET=1` 进不去宠物形态（验收前置） |

不动：`models.ts`（Q 版素材管线）、点击穿透状态机（`overlay.ts:341-408`）、`scheduler.ts` 采集节奏。

## 1. 材质转换（R1–R4）

### 契约

在 `loadHumanTemplate()` 里、FBX 解析完成后**对模板**做一次材质归一，`instantiateHuman` 不再碰材质。

原因：`SkeletonUtils.clone` **共享材质对象**（只深拷贝骨骼/蒙皮）。现状 `human.ts:134-141` 在每个实例上
遍历改材质，既改不到共享材质的同一批属性、又会在每次切宠物时重复执行。放在模板上做，一次生效、实例天然继承。

```
normalizeHumanMaterials(root: THREE.Object3D): { converted: number; albedoFixed: number }
```

返回值给 `dump()`/诊断用，便于验收时核对"确实转换过"。

### 逐材质规则

实测每个真人模型是 **1 个 SkinnedMesh + 3 个材质分组**（`geometry.groups` 全部被覆盖），
所以必须处理 `material` 是**数组**的情况——这是现状代码的一个隐藏缺陷：`human.ts:139` 把数组当单材质用。

对数组里每个源材质（`MeshPhongMaterial` / `MeshLambertMaterial`）：

| 目标属性 | 取值 | 依据 |
|---|---|---|
| `map` | 原样搬迁，并断言 `colorSpace === SRGBColorSpace`（不是则显式设） | FBX 的 DiffuseColor 是 sRGB albedo |
| `normalMap` / `normalScale` | 原样搬迁 | 实测 mat0/mat1 有 normalMap |
| `alphaMap` / `transparent` / `opacity` | 原样搬迁 | mat2 是睫毛/皮肤透明度通道，`transparent=true` |
| `color` | 若源 `color` 亮度 < 0.05 → 设白；否则保留源值 | **发黑根因**：实测 3 个材质 `color=000000` |
| `roughness` / `metalness` | 常量起步值（`0.62` / `0`），皮肤/布料不区分 | 不区分是**故意的**：材质分类属真人化任务（D5） |
| `envMapIntensity` | `0.9`（沿用 `human.ts:140` 原本想表达的值） | 转 Standard 后该属性才存在（实测 Phong 上 `ABSENT`） |
| `specularMap` | **丢弃**（置空，不搬迁） | `fetch-human-pets.mjs:73` 刻意不采集 specular，搬过来就是 404（R3） |
| `name` | 保留源材质名 | 便于 `dump()` 与逐材质调试 |

转换后 `dispose()` 源材质。Q 版走 `models.ts` 完全不受影响（R4）。

### 与真人化任务的边界（D5）

本任务只保证「贴图颜色正确 + IBL 生效」。皮肤高光、次表面近似、毛发/眼睛单独材质、
重打光与曝光、`RoomEnvironment` 换成自建环境——全部留给 `09-18-human-realism`。

**风险**：转 Standard 后观感可能从"黑"变成"过亮/塑料"。缓解：`scene.ts:465-466` 每次换皮肤都会覆写
`environmentIntensity` 与 `ambient.intensity`，改曝光必须同时改这两处，否则只有换肤后才生效。

## 2. 视口反算（R5–R9）

### 为什么必须反算而不是调常量

`halfX:58` 的问题不是"值不对"，是**它和视口没有任何函数关系**：窗口尺寸、形态、相机参数任一变化都会让它失效。
所以新增纯函数把三者绑起来，而不是把常量从 58 改成 44。

### 契约（`pet3d/viewfit.ts`，2026-09-18 步骤 3 最终形态）

```
fitRoamArea(o: {
  fovDeg: number; camY: number; camZ: number; lookY: number;
  viewW: number; viewH: number;
  shell: { radius; centerY };   // 球壳/用量环/装饰带外沿的最大者，恒定停在 z=0
  body:  { radius; centerY };   // 宠物本体（按实际世界包围盒测得的包围球）
  margin: number;               // 世界单位留白（吸收「按圆处理」的椭圆误差）
  depthBudget: number;          // 期望纵深上限
}): { halfX: number; halfZ: number }
```

两条独立约束（原稿只有一条 `silhouetteRadius`，那是球壳还跟着 z 移动时的形状；R7 之后球固定在
z=0，宠物的纵深必须单独约束）：

- **C1 球壳**：在 `(±halfX, 0)` 完整可见 → 给 `halfX` 一个上界（320×230 下 ≈34.13）。
- **C2 宠物**：在 `(±halfX, ±halfZ)` 的**任意组合**（四角 + z 两端）完整可见
  → 定 `halfZ` 上界，并反过来收紧 `halfX`。

求解顺序：先对 `halfZ` 二分（竖直 NDC 与 x 无关，取 x=0），与 `depthBudget` 取小；
再在该 `halfZ` 的两侧对 `halfX` 二分（耦合就体现在这一步：z 越大宠物离镜头越近越大 → 可用 x 越小）。
两者都用单调性 + 二分 24 次，不用解析式（相机有俯角 `camY-lookY=34`，解析解可读性差且易写错符号）。

下限保护：`halfX ≥ 12`、`halfZ ≥ 6`（窗口被系统缩到极小时，宁可让球略微出界，也不能让宠物冻死）。

投影复用 `scene.ts:485-498` `updateBallScreen` 已有的算法（角半径 `asin(r/dist)` + `tan(FOV/2)` 换算），
**不新写一套投影数学**——两处各写一份正是 `halfX:58` 这类漂移的来源。

#### 步骤 3 实测数字（320×230 / 相机 35°·162·俯角 34）

| 量 | 值 | 来源 |
|---|---|---|
| 球壳轮廓半径 | 28.96（`RING_R+RING_HALO_TUBE` 最大者） | scene.ts 常量 |
| 宠物包围球 | aria 25.2×36×6.3 → **r=22.19**；ray 26.6×36×6.9 → **r=22.65** | 复刻 `instantiateHuman` 后取世界 bbox 对角线/2 |
| 包围球中心 y | ≈26.5（脚点 8.5 + 身高一半；实测 27） | 同上 |
| `halfX` / `halfZ` | 34.12 / **28.00**（r=22.65 口径）；aria 运行时 35.05 | `test-viewfit` + ballshot `roamArea` |
| 缩放跨度 | 解析 **1.398×**；实拍像素（宠物单独量）94px ↔ 69px = **1.362×** | `BD_ONLY` + `BD_PIN_POS` |

两点与原稿不符、以实测为准的地方：

1. **「人的轮廓比球小、约束更松」只对了一半。** 包围球半径被**身高**主导（36 → r≈22.7，只比球的
   28.96 小 22%），不是被"宽约 7"主导。所以 C2 实际与 C1 同量级、在 320×230 下就是它把 `halfX`
   卡在 34.12（比球壳单独约束的 34.13 只松一点点）。纵深给到 28 是靠"球不再跟 z"换来的，
   不是靠"人比球小"。
2. **包围球对"高 36 × 厚 7"的人形是浪费的**（横向白给了约 3 倍余量）。这里代价恰好为零
   （C1 自己就压到 34.13），但换更宽的素材/更扁的窗口时 C2 会先塌，届时该换 OBB 而不是换魔数。

### 数据流

```
主进程 overlay.ts: setBounds(形态尺寸)
        ↓ (窗口 resize → renderer 的 ResizeObserver)
scene.ts resize(): host.clientWidth/Height
        ↓ fitRoamArea(...)
walkerCfg.area ← 新值        （stepWalker 每帧读 cfg.area，天然生效）
        ↓
walker.ts: 位置夹在 area 内；越界时先夹回再走（R6）
```

`area` 从"构造时快照"改为"外部持有的可变量"：`scene.ts:431` 现在做 `{...DEFAULT_WALKER, ...opts.walker}`
浅拷贝，`area` 对象是共享引用——正好可以在 `resize()` 里原地改 `walkerCfg.area.halfX/halfZ`。
保留这条路径，不引入新的 setter。

### 纵深实现（D4'，2026-09-18 改写：原「加高窗口」方案作废）

**为什么不能靠放大窗口**：`viewfit.ts` 里 `viewW/viewH` 只以 `aspect = viewW/viewH` 进入计算，
NDC 投影与像素分辨率无关 → 等比放大窗口，世界坐标活动范围**完全不变**（`test-viewfit.mjs` 有断言）。
460×340 的 aspect（1.353）比 320×230（1.391）更小，反而让 `halfX` 从 34.13 降到 32.2。

**实际做法**：去掉 `scene.ts:561` 的 `shellGroup.position.z` 跟随（x 跟随保留），
球壳与用量环恒定停在 z=0 → 球不再随宠物靠近镜头 → 球的可见性约束与宠物的 z 解耦。
于是 `halfZ` 的约束从"球必须在 z=+halfZ 处仍完整可见"变成"**宠物**必须在 z=+halfZ 处仍完整可见"。

缩放跨度按 `dist(z) = √(34² + (162−z)²)` 估：`halfZ=13` → 1.17×（用户反馈"看不出来"）；
`halfZ=28` → **1.398×**（实测像素比 1.362×，见上面的实测数字表）。窗口保持 `320×230`。

注意：这里"人比球小"只体现在**厚度**上（人 25.2×36×6.3 vs 球直径 57.9），包围球半径仍被身高
撑到 22.7（球 28.96）→ 纵深能加深靠的是"球不再跟 z"这条几何变化，不是靠人轮廓小。

副作用清单：
- `ringGroup.position.z`（`scene.ts:563`）跟着 shell 一起停止 z 跟随，否则环与壳错位。
- 宠物走到球前方时会**视觉上离开玻璃球壳**——这是 D4' 的既定取舍，不是 bug；但不得走出窗口，
  所以 `fitRoamArea` 需要**第二条独立约束**：以宠物包围盒（不是球轮廓）在 `z = ±halfZ` 处仍完整可见。
- **透明排序（实拍核对结论）**：`halfZ=28 < 球壳半径 28.96`，所以宠物走到最前方时仍"在球壳里"，
  玻璃（`MeshPhysicalMaterial`，`depthWrite:false`，renderOrder 6~9）会合成在他身上。
  实拍 `BD_PIN_POS=0,28` 与 `34,28`：人仍是全对比度的深色西装+肤色，没有被糊成磨砂/发白，
  最坏角上右侧留 17px 余量（ink box 右缘 303 / 320）。→ 不需要为 R8 动 renderOrder。
- `PetBall.tsx:530-574` 的覆盖层按 `center.x/y ± ballR` 定位，球不再跟 z 后这些锚点确实更简单
  （球心投影恒在画面竖直中心，见 `test-viewfit` 的断言）。但**横向**必须夹：`halfX≈35` 在 320px 窗口里
  是 ±110px 偏移，而 `.petball` 是 `overflow:hidden` → caption/bubble/badge 一律走 `clampX(x, 半宽上界)`，
  半宽上界由 CSS `max-width` 反推（caption 140→70、bubble 190→95、badge 15→8），不是拍出来的数。
  **纵向**：泡泡锚点是底边（`translate(-50%,-100%)`），球上方只剩 50px，两行文案高 46px
  → 上移量从 -34 一路收到 -4 并按 46 兜底，否则第一行被窗口顶切掉。
  `--ballshot` 的 `diag.overlay` 会把每个覆盖层的实际 rect 打出来，越界一眼可见（R8 的可判绿/红检查）。
- `DESIGN.md:268`「球内站着 3D 角色」与 `TASKS.md:477` 的取舍描述需按新行为改写。

### 朝向（R10）

`walker.ts` 增加速度方向输出（`dirX`, `dirZ`，归一化；idle 时保持上一次方向），
`scene.ts` 真人分支把它转成偏航：`heading = atan2(dirX, dirZ)`，
以**角差最短路径**平滑（`k = min(1, dt*4)`）写到 `petGroup.rotation.y`。

- 为什么写 `petGroup` 而不是 `petHolder`：`petHolder` 是 `human.ts:117-121` 的归一化层（带 `scale.setScalar`），
  `DESIGN.md:312-314` 明确记录过"动画层与归一化层必须分离"的回归；`petGroup.rotation` 绕自身原点转，
  其子节点在局部 (0,0,0)，是安全的旋转层。
- `HUMAN_YAW`（`human.ts:106`）保持 `0`：基线截图 `pet-aria.png` 里黑剪影能看到正脸与领带 → 默认已朝镜头。
  该常量的注释写着"若背对镜头改成 Math.PI"，本任务把它并入 heading 的常量偏移，避免两处朝向逻辑打架。
- **剪辑自带根位移 —— 实测成立，且缓解点与原稿设想不同。** 位移曲线不在"内层 group"上，
  而是挂在**骨骼层根节点 `Bip01` 的 `position` 轨道**上：walk 的 z 振幅 159.7（FBX 单位=cm），
  归一化（×0.2069）后一个 1.23s 循环把骨架沿局部 z 拖走 ≈33 世界单位；连 idle 也有 ≈12。
  而 `MotionExtractionHelper`（3ds Max 用来承载提取位移的替身）**在 FBX 里根本没导出**
  （运行时可见 three 报 `No target node found for track: MotionExtractionHelper.position`），
  `Bip01_Footsteps` 有节点但只在小范围内动（不是位移载体）。
  → 原稿设想的"每帧把内层 `group.position.x/z` 归零"是**空操作**（那个节点没有动画曲线）。
  实际做法：`instantiateHuman` 找出骨骼层根节点，导出 `cancelRootMotion()`，
  在 `mixer.update(dt)` 之后把它的 x/z 拉回绑定值（y 保留 = 步伐起伏）。
  抵消后实测网格中心 z 从 `[1.2, 25.1]` 收到 `[-1.5, 1.9]`；`rootMotion()` 观测点报告
  被抵消掉的峰值（真人系实拍 22~33 世界单位，Q 版 null），是"素材在拖"的现场证据。
- Q 版不读 heading，保持"只左右翻转"的既有取舍（`walker.ts:9-11`）。

## 3. 定时语音播报（R12–R16）

### 分层

`voice.ts` 只做"怎么出声"，`App.tsx` 只做"何时说什么"：

```
voice.ts:  speak(text): void        // 取消上一条 → 入队；无 speechSynthesis 时静默 no-op
           pickVoice(lang='zh-CN'): SpeechSynthesisVoice | null   // voiceschanged 后缓存
           stopVoice(): void
```

`speechSynthesis.getVoices()` 在 Chromium 里首轮可能返回空数组，必须监听 `voiceschanged` 再取一次；
取不到 `zh-CN` 音色时回退默认音色（R12）而不是不播。

### 定时器（R15）

沿用 `scheduler.ts:98-108` 的**自重排单定时器**形状（那里 `94-97` 的注释记录了 runaway-timer 事故）：

```
一个 timeoutRef；fire() 里先算下一次再排；
依赖变化（开关/间隔/焦点供应商/展开态）→ 清定时器重排，不叠加；
组件卸载 → 清定时器 + stopVoice()。
```

放在 `App.tsx` 而不是 `PetBall.tsx`：余额数据、`hideBalance`、展开/收起态都在 `App.tsx`
（`App.tsx:61-62,159,210`），`PetBall` 只拿到投影后的 `frame`。播报内容必须与卡片同源，
否则会出现"听的和看到的不一样"（正是 `feedback-ask-dont-guess` 记录的口径分裂代价）。

### 触发条件（全部满足才播）

`voiceOn && !expanded && !dragging && s.status === 'ok' && 有焦点供应商`。
`hideBalance` 时金额段整体省略，只播用量百分比（R14，与卡片 `App.tsx:180-182` 同一口径）。

### 文案

`「${label}」余额 ${compactAmount(value)}，已用 ${percent}%` + 现有诚实后缀（缓存/估算）。
数字读法沿用 `compactAmount`（`PetBall.tsx:21-32`）的缩写值会被读成"一万二千"还是"1.2万"取决于音色，
实现时实测一次并决定播报用完整数字还是缩写——**这是唯一需要实测才能定的口径**，写进 `implement.md` 的验证步骤。

### 与现有泡泡的关系（R16）

`PetBall.tsx:336-345` 的 90s 一次性文字泡泡**保持不动**。语音是独立周期，两者不合并、不互相取消。

## 4. 验证策略

1. **视觉门禁**：`BD_PET=1 BD_PETS=1 electron . --ballshot` 逐只出图，与 `resources/human-pets/*/preview.png` 肉眼比对
   （这是 R1 唯一的直接证据，单测测不出"黑"）。
   前置：先修 `index.ts:113-117` 的开关点击（我这次跑 `BD_PET=1` 实测停在球形态 `win:[200,210]`，
   没进宠物形态，`BD_TOGGLE=1` 可打印 `after click: pet=… switchOn=…` 定位）。
2. **裁切门禁**：`measure()`（`scene.ts:741+`）已能给出像素 ink box；加断言
   「ink box 完整落在 `window.innerWidth × innerHeight` 内」，在多个连续帧上采样，把 R6 变成可判绿/红的检查。
3. **单测**：`fitRoamArea` 纯函数进 `scripts/`（与 `test-walker.mjs` 同构，零依赖），
   覆盖 320×230 / 460×340 / 极小窗口 / 极端 aspect 四类。
4. **回归**：`test:walker`、`test:pet`、`typecheck`、宠物 uitest 用例。
5. **语音**：无法在 uitest 里断言音频，改为断言"该播时调用了一次 `speak`、不该播时零次"
   （`voice.ts` 暴露可注入的 `speak`，测试里替换成 spy），并手工实听一次。
