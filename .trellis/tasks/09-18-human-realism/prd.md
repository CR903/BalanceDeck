# 真人化人物材质与光照升级

用户反馈第 2 项：「人物能不能真人化点，类似 AI 视频那种人物」。
已确认路线（D2）：**升级现有 3D 材质与光照**，不换素材源、不走 AI 视频帧序列。

依赖顺序：本任务在 `09-18-pet-render-fixes-tts` **之后**开工。那个任务会先把 FBX 材质
Phong→Standard 转换并修好反照率（否则一切观感调整都建立在"纯黑"之上），并改动同一批文件
（`pet3d/human.ts`、`pet3d/scene.ts`）。

## Goal

把 Aria/Ray 从"能看清的 CG 游戏模型"推进到"桌面小人身上的可信小人"：皮肤有高光与粗糙度差异、
布料与头发有不同材质响应、打光有主次、转身走位不违和。用户价值：桌宠看起来像一个"人"，
而不是一个未贴材质的小人模型。

## 现实预期（必须先对齐，否则会一直不满意）

「AI 视频那种人物」是**逐帧渲染的照片级影像**，与"一个 80MB 实时 WebGL 模型 + 60fps 桌面透明窗口"
不是同一技术类别。本任务的天花板是**高质量实时渲染**（接近游戏 CG 过场 / Ready Player Me 高级档），
不是照片级真人。若验收标准是"和 AI 生成视频里的人一样"，本路线必然不达标——
届时需要回到 `first_frame_to_video` 那条伪 3D 路线（AI 生成真人走动视频抽帧成精灵），
代价是没有真实转身、素材体积大、走路循环接缝难自然。这一点在开工前需用户再次确认接受。

## Background（本轮实测到的事实）

- 每个真人模型是 **1 个 SkinnedMesh + 3 个材质分组**（`geometry.groups` 全覆盖）：
  mat0/mat1 = 身体与头（`map` + `normalMap` + `specularMap`，不透明），
  mat2 = 透明度通道（`alphaMap` + `transparent`，睫毛/皮肤）。
- **specular 与 wrinkle 贴图当前刻意不采集**：`scripts/fetch-human-pets.mjs:73`
  `!/specular|wrinkle/i` 过滤掉了。写实渲染最需要的恰恰是这两张——specular 可转成 `roughnessMap`，
  wrinkle 可作细节法线叠加。
- 材质分组只有 3 组且**皮肤与衣服共用一张 `f014_body_color` 图集**，所以"分材质调参"必须靠
  **UV 区域**或贴图图集分区识别，不能靠 `material.name` 直接分出头/手/衣。这是本任务最大的技术不确定性。
- `morphTargets: 0`（实测）：父任务 PRD 里"Rocketbox 含 ARKit 表情 blendshapes"的说法
  **在 three 的 FBXLoader 解析结果里不成立** → 口型/表情不能指望剪辑，需要另找路径（或不做强表情）。
- 模型原始尺寸 aria `121.7 × 174.0 × 30.5`（FBX 单位），`HUMAN_HEIGHT=36` → 缩放约 0.207；
  细节预算（多长算"近"）要以缩放后的屏幕像素为准。
- 现有渲染基座：`scene.ts:110-123`（ACES + exposure 1.05 + PCFSoft 阴影 + `premultipliedAlpha`
  + `powerPreference:'low-power'`）、`147-155`（`RoomEnvironment` IBL，强度 0.55）、
  `158-175`（key 2.4 / fill 0.5 / rim 1.0 / ambient 0.24）。
  **注意**：`applyTokens()`（`scene.ts:465-466`）每次换肤都会覆写 `environmentIntensity` 与
  `ambient.intensity`，打光改动若不同步这里，只会在换肤那一刻生效。
- 参考目标图：`resources/human-pets/aria/preview.png`、`ray/preview.png`（素材官方渲染图）。

## Requirements

- **R1**：分材质响应——皮肤 / 头发 / 布料至少三类，各有独立的 `roughness`/`metalness`/高光强度，
  且不破坏已修好的反照率。
  **实现路线已定**：由 specular 派生的 `roughnessMap` 承担**图集内**的逐区域差异
  （见「关键发现」），`material.roughness` 承担材质级上限。
  `metalness` 保持 0（这套素材没有金属）。当前三个材质分组是**完全相同**的
  `roughness 0.62 / metalness 0 / envMapIntensity 0.9`，即"零差异化"。
- **R2**：采集并接入 **specular** 贴图，转成 `roughnessMap`。
  **wrinkle 图不存在**，R2 收缩为只做 specular（理由见「开工前修订」）。
  转换需要逐像素数学，而 `sips` 只能转换/缩放/调伽马 —— 按仓库既有先例
  （`scripts/gen-icons.js` 纯 JS PNG 编码、零外部依赖）写纯 JS 转换脚本，
  Node 内置 `zlib` 够用。同时保持「素材不进仓库」与 `predist` 钩子可用。
- **R3**：打光重构——主/补/轮廓光与曝光重新调参，环境贴图可替换为自建 studio 环境；
  **必须与 `applyTokens()` 的逐皮肤覆写路径一致（同一份参数源）**。
  已确认陷阱：`scene.ts:520-521` 里 `applyTokens` 每次换肤都硬写
  `environmentIntensity = t.dark ? 0.4 : 0.55` 与 `ambient.intensity = 0.18/0.26`，
  任何在别处改的打光都只在换肤那一刻生效。
  **方案**：新增 `LIGHT_RIG` 表（放 `pet3d/rig.ts`，与 `FORMS` 同为"唯一来源"），
  `applyTokens` 从表里取而不是硬写。
- **R4**：真人观感在**实际像素尺寸**下经得起看 —— 人物形态窗口是 **213×293**，
  不是原 PRD 写的 320×230。细节预算按缩放后的屏幕像素算。
- **R5**：无回归——`typecheck` / `npm test` / `test:pet` / `test:gesture` / `test:projection`
  / 宠物 uitest 全绿。**`test:walker` / `test-viewfit` 已随漫游机制删除，不在本轮范围。**
- **R6（新增）**：**必须有非主观的护栏**。原 AC 全靠"用户肉眼确认"，
  补一条可机械验证的断言：派生出的 roughness 图**亮度分布要有实际方差**，
  且各材质不再是同一个值 —— 否则"平铺的 roughness"也能通过肉眼验收而实际什么都没做。
  这条防的是"看起来没坏"这种最危险的假通过。

## Acceptance criteria

- [ ] 走查截图出图，**皮肤 / 头发 / 布料**有肉眼可辨的不同材质响应（不是同一片塑料感）
- [ ] 派生 roughness 图的亮度分布有实际方差（`test-human-mat` 断言，非占位）
- [ ] 三个材质分组不再是完全相同的 `roughness`/`envMapIntensity`
- [ ] 逐皮肤（`BD_SKINS=1`）打光一致，不存在"只有换肤后才生效"的参数
- [ ] 与 `preview.png` 并排比对：脸型、发色、西装配色可辨认且接近
- [ ] 用户肉眼确认"比之前像人"（主观项，需实机演示，不接受只看截图代答）
- [ ] 全量测试与 uitest 绿；素材体积上涨已记录

## Out of scope

- 换素材源（Avaturn 自拍 / Ready Player Me / 自制 VRoid）
- 照片级真人（见"现实预期"；Q1 已确认接受实时 CG 天花板）
- 面部表情/口型同步（`morphTargets: 0`，无现成通路）
- 新增角色（第三人）
- wrinkle 贴图 / 细节法线叠加（**上游没有这个文件**）
- **Windows 打包链路修复**（Q3 明确本轮不做；`sips` 依赖记为已知限制）


## Open questions —— 已答（2026-09-26）

| # | 问题 | 答案 |
|---|---|---|
| **Q1** | 「高质量实时 CG」够不够满足"真人化"的期望？还是要走 AI 视频帧序列？ | **够，走实时 CG 路线。** 不走 `first_frame_to_video`。 |
| **Q2** | 是否接受为写实重新采集素材（体积上升，含 specular/wrinkle）？ | **接受。** 重新采集，体积上涨可接受。 |
| **Q3** | Windows 打包链路（`sips` 依赖）是否本轮一起修？ | **否。** 本轮不修，记为已知限制（Windows 上不能重新采集素材；产物由 `predist` 在 macOS 上预先做好）。 |

## 开工前修订（2026-09-26 实测，本文档多处前提已过期）

原 PRD 写作时（2026-09-18）依赖的前提变了，逐条订正：

| 原表述 | 现状 | 依据 |
|---|---|---|
| "皮肤与衣服共用一张 `f014_body_color` 图集，所以分材质调参**必须靠 UV 区域识别**" | **这个"最大的技术不确定性"已解决**，见下方「关键发现」 | 实测两张 specular 图 |
| "采集并接入 specular/wrinkle 贴图（`fetch-human-pets.mjs:73` 过滤掉了）" | specular **确实存在且必须采**；但 **wrinkle 图根本不存在** —— `!/wrinkle/i` 那个过滤什么都没滤到 | GitHub API 列 `Textures/`：只有 7 张，body/head 各 color+normal+specular，加 opacity |
| "mat0/mat1 = 身体与头" | 实测贴图是 **`f014_body_*` 与 `f014_head_*` 分开的两套**，"共用图集"只在 body 内部成立 | `resources/human-pets/aria/textures/` |
| 验收引用 `test:walker` / `test-viewfit` | **这两个套件已随漫游机制删除**（`4f85487`）。现存：`test:pet` / `test:gesture` / `test:projection` | `4f85487` |
| 窗口 320×230 | 人物形态 **213×293**（`src/shared/pet-view.ts` 是唯一来源） | `aed234c` / `69d9aff` |
| "皮肤/毛发/眼睛材质重构属本任务"（原 D5 划分） | 材质 Phong→Standard + 反照率修正**已由 `09-18-pet-render-fixes-tts` 完成**（`pet3d/human.ts:63-111`）。本任务接着做的是**分材质差异化 + 打光** | `ce6755a` 前置任务已归档 |
| `morphTargets: 0` → 口型/表情无通路 | 仍然成立，维持 out of scope | 2026-09-18 实测 |

### 关键发现（2026-09-26 实测，改变了 R1 的技术路线）

把上游的 specular 贴图拉下来实际看过（`Business_Female_01/Textures/f014_{body,head}_specular.tga`，2048²）：

- **`f014_body_specular`**：手指/手部**很亮**（皮肤高光，带关节褶皱细节）、衬衫**中灰**（布料）、
  西装翻领**更亮**、其余是未用图集空间（纯黑）。
- **`f014_head_specular`**：这是**完整的脸部 UV 展开** —— T 区（额头/鼻梁/颧骨）柔和高光、
  嘴唇**很亮**、头发有**细丝结构**、眼球**最亮**、牙齿亮、耳钉亮。

**结论：specular 贴图本身就是"皮肤 / 头发 / 布料 / 嘴唇 / 眼睛"的天然判别器。**

于是 R1 不需要手绘 UV 遮罩 —— 把 specular **反相重映射成 `roughnessMap`**，
就能在共享图集内**逐区域**得到不同的粗糙度（three 的 `roughnessMap` 读 G 通道，
且与 `material.roughness` 相乘，所以 `material.roughness` 当上限、图当分布）。

**这同时证明了一件重要的事**：头部材质里脸/头发/嘴唇/眼睛/牙齿**全在同一个图集**，
所以"分材质分组"（3 组：body / head / opacity）**在结构上就不够** ——
必须走贴图驱动的逐区域差异。


