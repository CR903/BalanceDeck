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
  且不破坏 Q 版 8 只与 `09-18-pet-render-fixes-tts` 已修好的反照率。
- **R2**：采集并接入 specular/wrinkle 贴图（转成 `roughnessMap` / 细节法线），
  同时保持"素材不进仓库"与 `predist` 钩子可用；需处理 `sips` 仅 macOS 的既有事实（至少明确 Windows 降级行为）。
- **R3**：打光重构——主/补/轮廓光与曝光重新调参，环境贴图可替换为自建 studio 环境；
  必须与 `applyTokens()` 的逐皮肤覆写路径一致（同一份参数源）。
- **R4**：真人观感在**漫游窗口实际像素尺寸**下经得起看（不是在大窗口 demo 里好看）。
- **R5**：无回归——`test:walker` / `test-viewfit` / `test:pet` / `typecheck` / 宠物 uitest 全绿；
  Q 版观感不变。

## Acceptance criteria

- [ ] `BD_PET=1 BD_PETS=1 electron . --ballshot` 出图与改动前对比，皮肤/头发/布料有明显不同的材质响应。
- [ ] 逐皮肤（`BD_SKINS=1`）打光一致，不存在"只有换肤后才生效"的参数。
- [ ] 与 `preview.png` 并排比对：脸型、发色、西装配色可辨认且接近。
- [ ] 用户肉眼确认"比之前像人"（主观项，需实机演示，不接受只看截图代答）。
- [ ] 全量测试与 uitest 绿。

## Out of scope

- 换素材源（Avaturn 自拍 / Ready Player Me / 自制 VRoid）——若 R 系列做完仍不满意再启。
- 照片级真人（见"现实预期"）。
- 面部表情/口型同步（`morphTargets: 0`，无现成通路）。
- 新增角色（第三人）。

## Open questions

- Q1（开工前必答）：本任务做到"高质量实时 CG"这一档是否就满足"真人化"的期望？
      还是必须走 AI 视频帧序列才能让用户满意？（决定整条技术路线）
- Q2：是否接受为写实重新采集素材（体积从 ~80MB/只上升，含 specular/wrinkle）？
- Q3：Windows 打包链路是否要求本轮一起修（`sips` 依赖）？
