# 调研报告：免费像素宠物 / 玩偶素材替代 Rocketbox 3D 真人数字人（应用瘦身）

> 调研日期：2026-09-30
> 调研方式：`sn-search-code`（GitHub 搜索 + GitHub API 元数据核验）× HuggingFace 搜索 + 网页搜索（OpenGameArt / itch.io / Kenney / DiceBear / Live2D 官网等）交叉验证
> 调研目标：为 BalanceDeck「个性人物」形态寻找可免费使用的像素宠物 / 玩偶形象素材（含平台自动生成接口 / 工具），评估替代 Microsoft Rocketbox 3D 真人素材的可行性
> 关联任务：`.trellis/tasks/09-30-pixel-pet-assets-research/prd.md`；竞品报告见 `.trellis/tasks/09-30-similar-projects-research/research/report.md`（第 2 节 D 类、第 4.9 节）

---

## 0. 现状基线（BalanceDeck 3D 素材体积实测）

在评估替代方案前，先量化现状（本机实测）：

| 项 | 数据 | 说明 |
|---|---|---|
| `resources/human-pets/` 总大小 | **221 MB** | aria 94MB + ray 96MB + reyna-pilot 31MB |
| 单角色构成（aria 为例） | 模型 FBX 604KB；**纹理 70MB**（同时保留 `.tga` 12–16MB/张 + `.png`）；动作 23MB | 纹理 TGA/PNG 双份是体积大头 |
| 单条动作 FBX | 1.3–4.5MB（talk 4.77MB、clap 2.9MB、drink 2.4MB…） | 每人 11 条动作 |
| three.js | `package.json` 运行时依赖 `three ^0.177.0`；`pet3d/human.ts` 独立 chunk 约 118KB（FBXLoader + SkeletonUtils） | 只有开启「个性人物」才加载 |

结论：**3D 真人方案整体占用约 221MB 素材 + three.js 运行时 + WebGL 上下文（显存）**，瘦身空间极大。

---

## 1. 候选素材源 / 接口清单

共整理 **17 个候选**，按 5 类列出。每个候选均注明：来源、许可协议、格式、动画支持、是否可离线随包分发。

### A. 免费像素宠物 / 玩偶精灵图（sprite sheet）

#### A1. Kenney 官方素材（Animal Pack Remastered / Pixel Pack / Roguelike Characters）
- **来源**：<https://kenney.nl/assets/animal-pack-remastered>、<https://kenney.nl/assets/pixel-pack>、<https://kenney.nl/assets/roguelike-characters>
- **许可**：**CC0**（公有领域，可商用、可再分发、无需署名）
- **格式**：PNG 精灵图 / sprite sheet（含透明背景，2D）
  - Animal Pack Remastered：240 个文件，10 种动物 × 多帧（idle / walk 等），含 88× 独立 PNG + 精灵表 + 矢量版
  - Pixel Pack：98 个文件，像素风通用素材
  - Roguelike Characters：450 个文件，像素 RPG 角色
- **动画支持**：✅ 多帧精灵表，可直接做帧动画（idle / 移动 / 攻击等）
- **离线分发**：✅ 下载 zip 后随包分发，零网络依赖
- **适配度**：★ 极高。CC0 无任何署名/再分发限制，是 2D 像素宠物首选素材源；本项目历史上曾用 Kenney「Cube Pets 2.0」3D 素材，属同一作者、许可一致。

#### A2. OpenGameArt 像素宠物合集（多作者 CC0）
- **来源**：<https://opengameart.org/>（站内搜索 `pixel pet`、`virtual pet`、`CC0`）
- **代表性素材**（均为 CC0）：
  - Penguin SpriteSheet（企鹅精灵表，<https://opengameart.org/content/penguin-spritesheet>）
  - Pixel Squirrel（松鼠 5 帧 52×52 侧跑动画，<https://opengameart.org/content/pixel-squirrel>）
  - shuaagotchi crab virtual pet（螃蟹虚拟宠物精灵表，含开关机/动眼/动螯动作，<https://opengameart.org/content/shuaagotchi-crab-virtual-pet>）
  - Plant Pets（植物宠物 dog/cat，PNG+GIF，<https://opengameart.org/content/plant-pets>）
  - Wolf Pack 32×32 行走动画（<https://opengameart.org/content/wolf-pack-32x32-walking-wolf-animation>）
- **许可**：逐条看，多数为 **CC0 / CC-BY 4.0 / OGA-BY**（OGA 站内许可证均允许商用；CC-BY 需署名）
- **格式**：PNG / sprite sheet / GIF
- **动画支持**：✅ 多数带多帧动画（部分仅静态）
- **离线分发**：✅ 下载后离线可用
- **适配度**：★ 高。CC0 条目可直接随包分发；CC-BY 条目需在第三方素材区署名（BalanceDeck README 已有署名区，成本低）。

#### A3. FreeGameSprites（CC0 像素素材库，含「玩偶」风格）
- **来源**：<https://freegamesprites.com/>
- **许可**：全站 **CC0**（官方声明 `All assets are CC0 — free for any use`）
- **格式**：PNG 像素精灵（20,000+，覆盖角色 / 动物 / 物品 / UI）
- **玩偶相关**：如 [Plush Teddy Bear — 256×256 像素毛绒泰迪熊](https://freegamesprites.com/en/assets/plush-teddy-bear)（CC0，静态精灵）
- **动画支持**：⚠️ 大部分为静态单帧；少量有动画
- **离线分发**：✅ 逐张下载后离线可用
- **适配度**：★ 中高。适合补充「玩偶 / 毛绒」风格的单帧形象；若需动画需自行补帧或与其他源组合。

#### A4. itch.io 免费像素宠物 / 玩偶素材（社区）
- **来源**：<https://itch.io/game-assets/free/tag-virtual-pet>、<https://itch.io/game-assets/free/tag-pixel-art> 等
- **代表性免费素材**：
  - [2D Pixel Art Cat Sprites（Elthen's Pixel Art Shop）](https://itch.io/game-assets/free/tag-virtual-pet)：猫 idle/clean/move/sleep/paw/jump/scared 多动作
  - [Pet Cats Pack（LuizMelo）](https://itch.io/game-assets/free/tag-virtual-pet)：猫宠物包
  - [Blue Tongued Skink FREE Pixel Art Pet（TheStarvingArtificer）](https://itch.io/game-assets/free/tag-virtual-pet)：免费蜥蜴宠物精灵表
  - [Simply Plush (Sprite + Animations)（SplendidDog）](https://splendiddog.itch.io/simply-plush)：**Godot 毛绒玩偶**，3 组动画 / 3 种配色，免费（name your own price）
  - [Doll Characters（shiax's）](https://shiaxs.itch.io/doll-characters)：玩偶风角色 4 方向行走图，免费基础版
- **许可**：**逐条不同**！多为「免费可商用」或 CC0，但必须逐个查看页面许可（部分付费、部分禁止商用）。⚠️ 不可默认全部可用
- **格式**：PNG / sprite sheet / GIF / zip
- **动画支持**：✅ 多数带多帧动画（idle / 移动 / 互动）
- **离线分发**：✅ 下载 zip 后离线可用
- **适配度**：★ 高（但需人工核验每条的许可条款；「玩偶 / 毛绒」风格选择多）

### B. 平台自动生成接口 / 工具

#### B1. DiceBear（开源头像库 + API，含 pixel-art 风格）⭐ 推荐
- **来源**：<https://github.com/dicebear/dicebear>（9.7k★，MIT）；官网 <https://www.dicebear.com/>
- **许可**：核心库 **MIT**；各风格素材由作者自行授权，`pixel-art` 风格为 **CC0 1.0**（见 <https://www.dicebear.com/styles/pixel-art>）
- **格式**：SVG（可转 PNG/WebP/AVIF）
- **生成方式**：
  - HTTP API：`https://api.dicebear.com/10.x/pixel-art/svg?seed=John`（无需 key）
  - npm 库：`npm install @dicebear/core @dicebear/styles`，**本地生成 SVG，完全离线**
- **动画支持**：❌ 静态头像（无帧动画）
- **离线分发**：✅ 用 npm 库本地生成，不依赖联网 CDN；也可预生成一批 PNG 随包分发
- **适配度**：★ 高。作为「平台自动生成接口」候选最合适：用 seed（如角色名 / 供应商 id）确定性生成像素形象，可为不同供应商生成不同外观；MIT/CC0 许可干净。缺点是无动画，需搭配 A 类精灵表做动画层。

#### B2. dsh-pet（MIT 桌宠：106 段透明动画 + AI 素材生成管线）⭐ 推荐
- **来源**：<https://github.com/PC2005-cloud/dsh-pet>（910★，**MIT**）
- **许可**：**MIT**（含素材与代码，可商用、可再分发）
- **格式**：**VP9-Alpha 透明 `.webm` 动画**（106 段，每段约 300–600KB，总约 50MB）+ `config.jsonc` 动作配置
- **动画支持**：✅✅ 106 段手绘风透明动画：待机呼吸、打瞌睡、玩魔方、吃火锅、写代码、余额分档动画（钱袋满溢 / 袋空如洗等）、工作状态动画等；首尾无缝衔接
- **离线分发**：✅ 素材在仓库内（`dsh-pet/assets/webm/`），可随包分发；Electron 透明窗口可直接用 Chromium 播放 webm alpha
- **额外价值**：仓库还包含**完整 AI 素材生成管线**（提示词配方 + 源视频 → 透明动画），可复现「自己造新宠物」
- **适配度**：★ 高。同为 Electron 桌面宠物场景，动作分类（余额档位动画、说话气泡、待机/移动/点击反馈）与 BalanceDeck「余额播报」需求几乎一一对应；MIT 许可干净。注意格式是视频（webm）而非帧序列，需要 `<video>` 播放器而非 CSS sprite；需评估动画风格（手绘风，非严格像素风）是否符合「像素宠物 / 玩偶」定位。

#### B3. spritebrew（AI 像素精灵表生成器）
- **来源**：<https://github.com/GAlbanese09/spritebrew>（57★）
- **许可**：**AGPL-3.0**（工具本身）；生成产物版权归属未明确 ⚠️
- **格式**：AI 生成 sprite sheet → 导出 PNG（面向 Unity / Godot / GameMaker）
- **动画支持**：✅ 生成后可动画化导出
- **离线分发**：⚠️ 工具可本地跑，但 AGPL 传染性 + 生成物版权不明确，**不建议**直接用于商业闭源分发的素材管线（除非咨询法务）
- **适配度**：★ 低（许可风险）。

#### B4. 开源像素头像生成器（MIT 小工具）
- **来源**：
  - [levilansing/pixel-avatar-generator](https://github.com/levilansing/pixel-avatar-generator)（33★，**MIT**，PHP）
  - [Chernavskikh/pixel-avatars](https://github.com/Chernavskikh/pixel-avatars)（16★，**MIT**，React，可在线生成）
- **许可**：均 **MIT**
- **格式**：PNG / 前端生成
- **动画支持**：❌ 静态头像
- **离线分发**：✅ 代码本地运行，无网络依赖
- **适配度**：★ 中。作为「自动生成头像」的参考实现可用，但成熟度远低于 DiceBear，仅作备选。

### C. 开源桌宠 / 虚拟形象项目可复用素材

#### C1. TermiPet（Apache-2.0，15 只宠物 = pet.json + spritesheet.webp）⭐ 推荐
- **来源**：<https://github.com/bleeeet/TermiPet>（84★，**Apache-2.0**）
- **许可**：**Apache-2.0**（含素材，可商用、可再分发，保留 LICENSE 声明即可）
- **格式**：每只宠物一个目录：`pet.json`（id / displayName / description / spritesheetPath）+ **`spritesheet.webp`**（1.5–2.4MB/只）
- **体量**：`Pets/` 目录共 15 只，**合计 23.2MB**
- **动画支持**：✅ spritesheet 为帧动画精灵表（应用侧按帧播放；TermiPet 是 macOS Swift 原生应用，BalanceDeck 用 CSS/Canvas 同样可播放）
- **离线分发**：✅ webp 文件随包分发，零网络
- **适配度**：★ 极高。格式轻量（一只 1.7MB）、许可宽松（Apache-2.0）、且 TermiPet 本身就是「macOS 桌宠 + 终端/AI 状态」同类产品（竞品报告 D 类），素材风格（猫/狗/卡通/玩偶）贴合「玩偶形象」。可直接复用其 spritesheet.webp + JSON 元数据的组织方式。

#### C2. BongoCat（跨平台桌宠，Apache-2.0）
- **来源**：<https://github.com/ayangweb/BongoCat>（23.7k★，**Apache-2.0**，Tauri/Rust 跨平台）
- **许可**：**Apache-2.0**（GitHub API license 字段与 LICENSE 文件均确认）
- **格式**：`resources/models/` 下为 PNG 图片（keyboard / gamepad / standard 三套猫形象）；皮肤机制为 `skin.json` + 三张 PNG（idle / left / right）
- **动画支持**：⚠️ 轻量（3 姿态切换 + 旋转，非帧动画）
- **离线分发**：✅
- **适配度**：★ 中。许可干净、项目成熟，但其动画模型简单（按键敲击类），不适合 BalanceDeck 的「动作编排」需求；可作为皮肤格式参考。

#### C3. TokenTracker（MIT，含桌面宠物）
- **来源**：<https://github.com/xiufengsun/TokenTracker>（1.9k★，**MIT**）
- **许可**：**MIT**（仓库整体）
- **格式**：桌面宠物位于 `dashboard/pet.html` + `dashboard/public`，像素风；具体精灵素材需逐个核验来源与授权 ⚠️
- **动画支持**：✅ 有宠物动画（成就系统等）
- **离线分发**：需核验素材是否第三方授权
- **适配度**：★ 中。MIT 仓库本身可参考实现，但**素材来源未在调研中逐项确权**，直接搬运有风险；建议仅借鉴交互/实现思路。

#### C4. DyberPet（GPL-3.0 桌宠框架）
- **来源**：<https://github.com/ChaozhongLiu/DyberPet>（987★，**GPL-3.0**，Python/PySide6）
- **许可**：**GPL-3.0**（含 122MB 素材）
- **格式**：PNG 精灵图 + 配置
- **动画支持**：✅ 丰富（多状态、互动）
- **离线分发**：✅ 但 ⚠️ **GPL 传染性**：若把其素材并入 MIT 项目并分发，可能要求整个项目开源为 GPL。**不建议**直接采用，除非 BalanceDeck 改协议。
- **适配度**：★ 低（许可不兼容）。

#### C5. Ark-Pets（明日方舟桌宠，GPL-3.0）
- **来源**：<https://github.com/isHarryh/Ark-Pets>（1.1k★，**GPL-3.0**，Java/Live2D）
- **许可**：**GPL-3.0**（且素材来自游戏版权方鹰角，二次分发风险更高）⚠️
- **格式**：Live2D 模型 / 精灵图
- **动画支持**：✅ Live2D 骨骼动画（待机 / 互动 / 多状态）
- **离线分发**：⚠️ GPL 传染性 + 素材版权属游戏版权方，**不建议**随包分发
- **适配度**：★ 低（许可 + 版权双重风险），仅作竞品参考。

### D. Live2D / Spine / 骨骼动画免费素材

#### D1. Live2D 官方免费示例模型
- **来源**：<https://www.live2d.com/en/learn/sample/>（如 Hiyori Momose 等）
- **许可**：**Live2D Free Material License Agreement**
  - 免费供小规模企业 / 非商业使用；**年销售额 ≥ 1000 万日元的企业需书面申请**
  - **禁止修改、禁止再分发**（sample data 不得 alter / redistribute）
- **格式**：Live2D 模型（`.model3.json` + 贴图 + motion）
- **动画支持**：✅ 官方自带表情 / 动作
- **离线分发**：❌ **禁止再分发**，无法随包分发
- **适配度**：★ 不适用（许可硬伤）。若未来走 Live2D 路线，需从 nizima 等市场购买可商用授权模型。

#### D2. Spine 官方示例 / 免费第三方 Spine 素材
- **来源**：
  - Spine 官方示例（随 [spine-runtimes](https://github.com/EsotericSoftware/spine-runtimes) 分发，**Spine 许可**：分发含 runtime 的软件要求用户各自持有 Spine 许可）
  - [SbaDany 免费 Spine 动画（itch.io）](https://sbadany.itch.io/coronavirus-spine-animations)：可商用、无需署名，但 **禁止再分发**
  - Unity Asset Store 免费 Spine 包：受 Unity EULA 约束
- **许可**：普遍存在「禁止再分发」或「需持有 Spine 编辑器许可」条款
- **格式**：`.json` 骨骼数据 + `.atlas` + 贴图
- **动画支持**：✅ 骨骼动画
- **离线分发**：⚠️ 多数禁止再分发，不满足「随包分发」要求
- **适配度**：★ 不适用。结论：**Live2D / Spine 免费素材普遍禁止再分发，不适合开源应用随包内置**；如需骨骼动画，建议自购授权模型或自建管线。

### E. 3D 轻量替代（若仍需 3D 立体感）

#### E1. Kenney Cube Pets（CC0 低模宠物 GLB）⭐ 备选
- **来源**：<https://kenney.nl/assets/cube-pets>（OpenGameArt 镜像：<https://opengameart.org/content/cube-pets>）
- **许可**：**CC0**
- **格式**：**GLB / GLTF / FBX / OBJ**（16 只方块宠物，低多边形，带动画）
- **动画支持**：✅ 自带动画（idle 等）
- **离线分发**：✅
- **适配度**：★ 高。这是 BalanceDeck 历史版本用过的素材（Kenney Cube Pets 2.0，后因需求改为 Rocketbox 真人）。若用户仍想要 3D 立体感，这是最轻量、许可最宽松的替代：体积从 221MB → **数 MB**，且可直接复用现有 three.js GLTF 加载管线（无需 FBXLoader）。

#### E2. Kenney Character Assets / Animated Characters 3（CC0 骨骼角色）
- **来源**：<https://kenney.itch.io/kenney-character-assets>（4 个低模角色 + 75 皮肤 + 40 配件 + **17 条动画**，CC0；免费 demo 可下载）、<https://kenney-assets.itch.io/animated-characters-3>（4 皮肤 + 3 动画，CC0，689KB）
- **许可**：**CC0**
- **格式**：GLTF / FBX / OBJ（rigged）
- **动画支持**：✅ 17 条（idle / walk / run / jump / interact / attack 等）
- **离线分发**：✅
- **适配度**：★ 中高。适合「保留 3D 但不要真人」的场景，角色为低模卡通，比 Rocketbox 轻几个数量级。

---

## 2. 替代可行性评估

### 2.1 能否用纯 2D 像素宠物（CSS / SVG / sprite 动画）替代 three.js 3D？

**结论：完全可行，且对 BalanceDeck 是「低风险高收益」的改动。**

理由：

1. **3D 形态本就是可选功能**：README / DESIGN.md 明确「默认 2D 圆环不加载 three.js、不下载 3D 素材」。移除 3D 只影响「个性人物」这一可选开关，不影响默认形态与核心数据面板。
2. **渲染载体同构**：个性人物形态是 213×293 透明置顶小窗，人物居中 + 脚下读数胶囊。2D 精灵完全可以在同一窗口用 CSS background / Canvas 播放帧动画，命中区（点击穿透）仍可沿用现有「投影矩形」逻辑（只是从 3D 包围盒改为精灵矩形）。
3. **动作编排逻辑可复用**：`pet3d/gesture.ts`（动作目录 + 调度）与 `clips.ts`（逻辑剪辑键 → 素材文件）是**纯函数、与 three.js 解耦**的。改为 2D 后只需把「剪辑键 → FBX」换成「动作键 → 精灵帧区间 / webm 片段」，测试套件（`test:gesture` 58 条、`test:pet` 43 条）大部分可保留。
4. **动画素材丰富**：A 类（Kenney / OpenGameArt / FreeGameSprites / itch.io）与 C1（TermiPet spritesheet.webp）都能提供多帧 idle / 走动 / 互动动画，足够覆盖现有动作目录（进出场、张望、伸懒腰、思考、说话、挥手等）。
5. **彻底移除 three.js**：删除 `three` 运行时依赖、`pet3d/` 的 WebGL 场景/FBXLoader/SkeletonUtils chunk、WebGL 不可用时的降级分支（2D 圆环兜底逻辑可简化为「2D 宠物本身就是兜底」）。

### 2.2 若仍需要 3D，是否有比 Rocketbox 更轻量、许可更宽松的模型源？

**有，且就是项目历史用过的 Kenney 系列（CC0）。**

- **Kenney Cube Pets**：16 只低模宠物 GLB + 动画，CC0，体积数 MB（对比 Rocketbox 221MB）。
- **Kenney Character Assets / Animated Characters 3**：rigged 低模角色 + 17 条动画，CC0。
- 二者均为 **CC0**（比 Rocketbox 的 MIT 更宽松，无需保留版权声明），且 GLB 可直接用 three.js GLTFLoader 加载，无需 FBX 转换链与骨骼名对齐的坑。

### 2.3 对包体 / 启动 / 显存的影响估算

| 维度 | 现状（Rocketbox 3D） | 改为纯 2D 像素宠物 | 改为 Kenney Cube Pets 3D |
|---|---|---|---|
| 素材包体 | **221 MB** | 1–25MB（TermiPet 式 spritesheet 约 1.7MB/只；Kenney 精灵表 KB 级；dsh-pet webm 约 0.5MB/段） | 数 MB |
| JS 依赖 | three.js（运行时）+ 118KB chunk | 移除 three.js，仅保留轻量帧动画代码 | 保留 three.js，但移除 FBXLoader |
| 启动 | 开启时解析 FBX + 骨骼蒙皮（单条 581ms 级） | 加载图片/webp 即播，接近零等待 | 加载 GLB，比 FBX 快 |
| 显存 / GPU | WebGL 上下文 + 实时阴影 + PBR，占用 GPU | **0 GPU 占用** | WebGL 上下文仍占，但几何体极简 |
| 维护复杂度 | FBX 根位移抵消、骨骼对齐、动作懒加载、软渲染降级… | 显著降低 | 中等（GLB 自带动画） |

### 2.4 许可合规要点

- **可直接随包分发**：Kenney（CC0）、OpenGameArt CC0 条目、FreeGameSprites（CC0）、TermiPet（Apache-2.0）、BongoCat（Apache-2.0）、dsh-pet（MIT）、DiceBear（MIT + 风格 CC0）。
- **需署名**：OpenGameArt CC-BY 条目（在 README 第三方素材区加署名即可，项目已有该区）。
- **禁止再分发 / 有传染性，不建议**：Live2D 官方免费模型（禁改禁分发）、Spine 免费素材（禁分发 / 需持有 Spine 许可）、DyberPet / Ark-Pets（GPL-3.0）、spritebrew（AGPL-3.0，生成物版权不明）。
- **itch.io 免费素材须逐条核验**：不能默认全部可商用。

---

## 3. 推荐方案

### 方案一（首选）：纯 2D 像素宠物，彻底移除 three.js

- **素材**：
  - 基础角色：**Kenney Animal Pack Remastered / Pixel Pack**（CC0，多帧精灵表）或 **TermiPet** 的 `spritesheet.webp + pet.json` 组织方式（Apache-2.0，1.7MB/只，玩偶/卡通风格）。
  - 若想要「玩偶 / 毛绒」观感：FreeGameSprites 的 Plush 系列（CC0）或 itch.io Simply Plush（免费）补充。
  - 「自动生成」外观：接入 **DiceBear pixel-art 风格**（CC0，npm 本地生成 SVG），用 seed（角色名 / 供应商 id）确定性生成形象，作为「换肤 / 多角色」的低成本来源。
- **实现**：保留 `gesture.ts` 动作编排，把素材层从 FBX 换成精灵帧区间（CSS steps() 或 Canvas）；删除 `three` 依赖与 `pet3d/` WebGL 场景；窗口尺寸可维持 213×293 或按精灵比例调整。
- **收益**：包体 −220MB 以上；启动更快；**显存 0 占用**；无 WebGL 兼容性分支；许可全部 CC0/MIT/Apache，随包分发无风险。
- **理由**：与用户诉求（去掉 3D、瘦身）完全一致；素材与许可最干净；动作编排与测试资产可大量复用，改动可控。

### 方案二（备选）：若仍要保留 3D 立体感

- **素材**：**Kenney Cube Pets**（CC0，16 只低模宠物 GLB + 动画）替换 Rocketbox 真人。
- **实现**：three.js 保留，移除 FBXLoader / SkeletonUtils / 动作懒加载链，改用 GLTFLoader 直接加载 GLB。
- **收益**：素材 221MB → 数 MB；许可从 MIT 变为更宽松的 CC0；规避 FBX 骨骼名对齐、根位移抵消等维护成本。
- **理由**：BalanceDeck 历史版本即用过 Kenney Cube Pets，有实现经验；是「仍要 3D」前提下最轻量、许可最宽松的选项。

---

## 4. 调研摘要

- **候选总数**：17 个（像素精灵图 4 类 / 生成接口 4 个 / 桌宠项目 5 个 / 骨骼动画 2 类 / 3D 轻量替代 2 个）。
- **推荐方案一句话**：首选**纯 2D 像素宠物**（Kenney CC0 精灵表或 TermiPet Apache-2.0 spritesheet.webp，配 DiceBear pixel-art 做形象生成），彻底移除 three.js 与 221MB Rocketbox 素材；若必须保留 3D，退而用 **Kenney Cube Pets（CC0 GLB）**。
- **可行性结论**：完全可行 —— 3D 是可选项、动作编排逻辑与 three.js 解耦、2D 素材许可干净且体量小两个数量级；Live2D/Spine 免费素材因「禁止再分发」不适合随包分发。