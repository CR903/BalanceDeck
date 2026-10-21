# 2026-10-05 球体外观四皮互不相同（P6：环替代水体）

> 任务：`10-04-rain-weather-column`（接 P1–P4 之后的球体外观批次）
> 真相源：`prototype/skin-applied.html` 的 V1/V3/V5/V6 四段（`ball()` / `arc()` / `waveSvg()`）
> + `docs/daily/2026-10-05_skin-applied-mock.md` 修订 1–7。

## 用户决策

**先做四种外观；进度环「替代」球内水体，不共存** —— 两者同时在场等于同一个百分比被画两遍
（液位一个数、弧长又一个数），是双重编码。

## 皮肤分配（V1/V3 都指向 dark 会撞车，故明确分配）

| 皮 | 形态 | 依据 |
|---|---|---|
| aero | **V6 潮汐水位蓝**（球内水体，唯一编码） | 现有语义零改动；P1 双层浪 + P2 玻璃罩已落地，本轮只复核 |
| dark | **V1 余烬橙环**：24 粒刻度圈 + 粗进度弧（r22/sw4） | 刻度圈读作"计时器"，与 dark 的仪表感同族；刻度用身份橙、弧用等级色（语义优先） |
| candy | **V3 极速双环**：外环进度（r24/sw2.5）+ 内装饰细环（r19/sw1.5） | 双环读作"速度/能量"，与 candy 的高饱和 Q 弹同族；顶图标位复用既有 `.dot-provider` |
| minimal | **V5 柠檬分段环**：3 段粗弧带缺口（r21/sw6，butt 端点） | 分段缺口在小尺寸下兼作刻度；minimal 的克制语法配 butt（圆头会把缺口两端糊住）。**轨道/分段用身份柠檬、弧用等级色**（2026-10-06 修正，见下节） |
| ink | 保留现状（球内水体） | 与 aero 同形态但不同波性格（雾雨 4 滴 / 只开两层），一眼可辨由水效承担 |

几何全部由原型 112 坐标折半（÷2）到 56 坐标系，**不重新设计**。

## 改动

- **新增** `src/renderer/src/skin-rings.ts`（纯函数，`ringDash` + `RING_DASH_SPACE`）。
  核心是 SVG `pathLength`：circle 上写 `pathLength="100"` 后周长被归一化，
  `stroke-dasharray` 的单位变成百分比 —— 于是半径/线宽可以留在 CSS 令牌里，
  **TS 里一个几何数字都没有**（换皮改半径不动一行 TS）。
  刻度圈用 `pathLength={96}`（24 粒 × 4）。
- `src/renderer/src/PetBall.tsx`：新增 `ringSvg(lvl, water)`（轨道/分段/刻度/内环/进度弧
  五个 circle），挂在 `.petball-goo` **之外**（goo 的 stdDeviation=4 会把 2px 的弧 blur 掉，
  与雨/读数同一取证结论）；摆位与 `.fluid-disc` 一致，因此 hidden/absorbing/revealing
  三条既有 `[data-fluid]` 规则把 `.fluid-ring` 加进名单就随 disc 收尽/回弹，不另写 morph。
  peek 预览气泡复用同一个 `ringSvg`（预览要预览的就是本体那张脸）。
- `src/renderer/src/skins.css`：`:root` 补全套 `--ring-*` + `--water-display/--ring-display`
  兜底；逐皮肤只覆盖令牌；ring 段 120 行；形态开关驱动 `.slosh` / `.pour-clip` 的
  `display`（不是 opacity —— 与 K9b 同纪律）。
- `scripts/test-structure.mjs`：D6 名单加 `.fluid-ring`；K11a–K11k + K11g2 共 30 条新门。
- `scripts/test-fluid.mjs`：用例 9b（弧长口径 12 条）。
- `src/main/qa/shots.ts`：5c 循环加 `5c-form` 探针（形态/弧长 dasharray/弧色/半径/三层显隐）。

## 2026-10-06 收尾修正（用户拍板的两条）

P6 的 check 阶段查出两件 P6 自己引入的问题，主会话裁决后单独立两条收尾（主工作树直接改，不新开任务）。

### 一、minimal 环找回柠檬身份色（已修）

**原状是沉默偏离，不是画错颜色。** `minimal` 的 `--ring-track` 写的是
`color-mix(in srgb, var(--ok) 22%, transparent)`，而 minimal 的 `--ok` 是绿 `#1a9e4b` ——
于是 V5「柠檬分段环」的三个部件（轨道 / 分段 / 弧）**全是语义绿**，一点身份色都不剩。
真相源 `prototype/skin-applied.html` 的 V5 段轨道是 `rgba(190,255,60,.22)`（柠檬）。

**口径（用户决定）：轨道/分段 = 身份色，弧 = 等级色。** 与 dark 同口径
（那里是 `--ring-ticks-c: rgba(255,159,10,.85)` / `--ring-track: rgba(255,159,10,.22)`）。

改动三处：

| 位置 | 改前 | 改后 | 性质 |
|---|---|---|---|
| minimal `--ring-track` | `color-mix(var(--ok) 22%)` | `rgba(190, 255, 60, 0.5)` | 找回身份色 + **抬 alpha**（判据见下） |
| minimal `--ring-seg-c`（新令牌） | 无（`.ring-seg` 里直接 `stroke: var(--ok)` + `opacity: .35`） | `rgba(190, 255, 60, 0.7)` | 同上；`opacity` 折进令牌 |
| candy `--ring-track` / `--ring-inner-c` | `color-mix(var(--ok) 22% / 16%)` | `rgba(34, 181, 115, 0.22 / 0.16)` | **零像素变化**，见下 |

- **candy 为什么也动**：K11p 这条门按用户要求覆盖三款环皮肤（dark/candy/minimal），
  candy 那两条是同一类缺陷，不改就绿不了。而 candy 的 `--ok` 恰好就是 `#22b573 = rgb(34,181,115)`，
  所以 `color-mix(...22%)` 与原型 V3 的字面量 `rgba(34,181,115,.22)` **逐位相同** ——
  这次改的只是「它从哪来」（从语义令牌推导 → 回到真相源），渲染结果一个像素都不变。
- **分段色为什么不再跟等级**：`.ring-seg` 是**量具的格线**，不承载 `fluidLvl`（唯一进度载体是
  `.ring-arc`）。以前 `stroke: var(--ok)` + 三条 `lvl-*` 覆写，让分段也跟着等级变 = 同一个
  百分比被画两遍色，且等级一变「这张脸」就变。现已全部删掉，只由 `--ring-seg-c` 一处给。

**⚠ alpha 从原型的 0.22/0.35 抬到 0.5/0.7，不是随手调的**：原型 V5 的盘是**深色**（`#1d2b12`），
柠檬在深盘上 0.22 就够读；minimal 的盘是近白 `--ball-bg: #f2f2f6`，照搬 0.22 会把柠檬混成
`rgb(231,245,205)` —— 几乎就是盘面本身。判据是**实算**的，而且换了尺子：

| 量 | 值 |
|---|---|
| 柠檬 `#beff3c` 对 `#f2f2f6` 的 WCAG 对比度 | **1.07**（纯柠檬也是）→ 此处亮度对比度**不适用** |
| 色相位移（合成后 G−B 级差）@ 原型 0.22 / 0.35 | 40 / 66 级 → 读不出来 |
| 色相位移 @ 本次 0.5 / 0.7 | **96 / 135** 级 → 读得出是柠檬 |
| 对照：弧的绿 `#1a9e4b` 对该盘 | **3.12** → 全环**唯一**靠亮度读出来的部件 |

即分工是「弧抢眼、身份环靠色相」。这条不能反：反了就变成亮绿弧压着一圈柠檬，身份又被读没了。

### 二、freeze 停表名单提权封死（已修 · 行为变更）

**原状**：停表名单 `[data-freeze]`（无值）= **(0,5,0)**，morph 段给同元素挂动画的
`[data-edge][data-fluid='absorbing']` 那一族 = **(0,6,0)**。后者胜出，所以
**`data-freeze` 与 `data-fluid='absorbing'` 共存时球体（disc）与环都不停** —— 用户原话：
「不只是环」。

**为什么这比「少停一张表」严重**：运行中的 `animation` 会盖掉静态 `transform`，所以下面四条
定帧 transform（`stretch` / `stretch` 纵向 / `bridge` / `stain`）在这两个相位共存时**根本没生效**，
5i/5j/5k 拍到的是动画中段的 matrix，不是定帧那一帧。**这是取帧机制本身失效。**

**修法**：`animation: none` 加 `!important`（与上一轮 K11m 降级段同款，文件尾 `.pet/.pet *`
早有先例）。**⚠ 行为变更**：`freeze × absorbing` 共存时球体现在真停，`--shots` 那几张取帧的
内容会随之变化（变正确）。定帧 transform 那组规则**一行未动**。

**上一轮遗留项已划掉**（原 M2 的后半段「名单提权」当时只做了一半：加了 `.fluid-ring` 进名单，
但名单本身压不过 morph，所以等于没加）。

### 门禁证据（先红后绿 + 变异验证）

新增 **K11p / K11p2（身份色不得由语义色推导，9 + 2 条）** 与 **K11n2（停表名单优先级，4 条）**。

`test:structure` 287 → **302/0**；`test:fluid` **125/0**；`test:dock-hide` **155/0**；
`npm test` 20 个套件 exit 0；`typecheck` 双工程干净。

逐条变异验证（**每个门都真红**，红集是最小值）：

| 变异 | 红 |
|---|---|
| minimal 轨道改回 `color-mix(...var(--ok)...)` | K11p minimal track（**1**） |
| **半吊子**：分段色改回 `color-mix(var(--ok) 35%)`（轨道仍是柠檬） | K11p minimal seg（**1**） |
| candy 内环改回 `--ok` 混色 | K11p candy inner（1） |
| 重新盖回 `.lvl-warn .ring-seg { stroke: var(--warn) }` | K11p2（**2**） |
| `.ring-seg` 绕过令牌直接写 `stroke: var(--ok)` | K11p2（**2**） |
| 删 `:root` 的 `--ring-seg-c` 兜底 | K11c2 seg（1） |
| **撤掉停表名单的 `!important`** | K11n2 disc + ring（**2**） |

- **门的设计取舍**：K11p 断的是「有没有从 `--ok` 推导」，**不是**「等于某个 hex」——
  逐皮钉死色值会把调色变成改测试（换皮就得改门），而这条要守的是一条**纪律**（身份 ≠ 等级）。
  K11k 断另一半：弧必须走等级色令牌。
- **K11p2 为什么必须有**（写完 K11p 才发现的漏）：令牌那层干净了，**覆写那层**照样能把分段
  拽回等级色 —— 一条 `.petball.no3d.lvl-warn .ring-seg { stroke: var(--warn) }` 就让 K11p 全绿，
  而屏幕上正是那个要消灭的半吊子。逐条断言也不合并：合并的话「轨道干净了但分段还是绿的」会被平均掉。

## 门禁证据（先红后绿 + 变异验证）

> 以下是 **P6 首轮**的数字；后续几轮（K11g2/K11m/K11n…）与 10-06 收尾修正累积到
> **302/0**，见上节。

- `test:structure` 212 → **258/0**；`test:fluid` 114 → **125/0**；`npm test` 全绿；
  `typecheck` 双工程干净；`npm run build` 通过。
- **逐条变异验证（红集是真的）**：

| 变异 | 红 |
|---|---|
| 删 dark 的 `--water-display` | K11a + K11b（2） |
| 弧长改绑 `pct ?? 0` | K11e（1） |
| 把 `.fluid-ring` 挪进 goo 容器内 | K11h（1，div 配平 1/0） |
| 删 dark 的 `--ring-r` | K11c（1） |
| 摘 morph 段 hidden 名单里的 `.fluid-ring` | K11g hidden（1） |
| peek 不跟随形态 | K11j（1） |
| 删 minimal 的 `--ring-seg-dash` | K11d（1） |
| `.ring-arc` 兜底 stroke 写成硬编码 `#30d158` | K11k（1） |
| 水体显隐改成 opacity | K11i（1） |

- **K11g 踩到两次假绿**（记录在此，值一条纪律）：
  ① `[data-fluid='hidden'] … .fluid-ring … scale(0)` 会匹配到文件尾
  `@media (prefers-reduced-motion)` 里**另一条**同形状的降级态规则 → morph 那条删掉仍全绿；
  ② 改按 @media 切段后仍假绿 —— 本文件有 **4 处** prefers-reduced-motion 块，切哪一刀都躲不开；
  ③ 改成按**选择器列表内容**认人（要求同时列 `.fluid-disc`+`.fluid-bridge`+`.fluid-ring`）后转绿，
  但开括号栈又差一次 pop（`head` 指向的是上一条规则的 `}`，排除它就等于少弹一次）→ K11g 三条恒红。
  最终判据：`phaseRingBody()` 按选择器列表认人 + 栈扫到 `m.index` 且跳过 at-rule 内层。

## 五皮取帧取证（`--shots` 5c + 逐像素解码）

DPR 由 CSS 尺寸推（`img.width / 56` = 2，ballshot 教训）。弧长比判据用"更接近弧色还是更接近
非弧基色"（200–280° 的中位色，弧必不覆盖）—— 固定亮度阈值在 minimal 的分段轨道上会误判。

| 皮 | 形态 | 弧长比 | 期望 | 弧头→弧尾 |
|---|---|---|---|---|
| dark | ring | **0.414** | 0.400 | 0° → 148° |
| minimal | ring | **0.397** | 0.400 | 0° → 142° |
| candy | ring | **0.408** | 0.400 | 0° → 146° |
| ink | water | 水色像素 323 | — | — |
| aero | water | 水色像素 245 | — | — |

- `5c-form` 逐皮读到：`ringDisplay`（ring 皮 block / 水体皮 none）、`waterDisplay`
  与 `pourDisplay`（环形态皮都是 none = 水与雨整体退场）、`arcDash="40.00 100"`
  （= 快照 wave40Snapshot 的 40%）、`arcR` 22/21/24px 三档 distinct、`arcCap`
  round/butt/round、`ticksDisplay` 仅 dark block、`segDisplay` 仅 minimal block、
  `innerDisplay` 仅 candy block、`pathLength=100`。
- 稳态无溢出：五皮一致，球圆外（>28css+1）alpha **26**、>28css+2 **0**，最远半径 28.7css
  —— 与 R4 基线同档（AA），goo 裁剪纪律未回归。
  ⚠ 第一次量出 587 是我拿 r=27 的**水盘圆**当界（27 vs 28），把球自己的边缘 AA 算成溢出 ——
  判据的基数要按 CSS 尺寸推，同 ballshot 那条教训。

## e2e（`--uitest`，EXIT 由超时触发，JSON 完整）

160 键 / 142 `ok`；`fail:` 3 项 —— `grpFixtureCard`、`grpUngroupedBucket`、`petWaterColumn`。
**基线 122fef4 复现为同一失败串**（在 `/tmp/bd-base` worktree 复跑基线取证，**一次观测**），
即 headless 基线问题，非本轮回归。`execErrors=none`、`consoleErrors=none`。
⚠ 措辞降格记录：这里原来写的是「三项与基线逐字相同」。实际只跑过**一次**基线，
拿不到「逐字相同」这种结论所需的重复观测；而 `--uitest` 本身存在 run-to-run 抖动 ——
复现者（2026-10-06 check）实跑基线时比本轮**多出一项** `grpUnknownBucket`。
所以准确的说法是「一次复现落在同一失败串上」，不是「逐字相同」。
`petWaterColumn` 的基线遗留缺陷已由主会话单独立项，不在本轮范围。
流体/贴边键全绿：`dockFluidHidden/dockFluidLevel/dockFluidGoo/dockFluidReveal/dockHide/
dockEdges/dockPeekSize/dockPassby/dockReveal/dockRehide/dockExpandCancel/dockSwitchOff`，
另 `petBallCenterValue/petWaterLevel/petBallSkinSurface/petBallRingDiag` 亦 ok。

## 未做 / 遗留

- 弧的**入场动效**（pour-top 那套冲顶）没做：环形态皮目前是直接落定。pour 三段是水体的入场，
  环要不要另配一套（例如弧从 0 扫到 fluidLvl）是设计决定，留给 G1 视觉验收时定。
- `.ring-inner`（V3 内环）目前恒满圈、不承载进度；颜色是**身份色字面量**
  `rgba(34,181,115,.16)`（2026-10-06 起不再从 `--ok` 推导，与 K11p 同口径）。
  若验收觉得「内环也该跟等级」，改 `--ring-inner-c` 的取值即可，不必动 JSX。
- 环形态皮**没有对应天气差异**（雨/水花在环形态皮上整体退场，`--water-display: none` 把
  `.pour-clip` 一起收了）—— 环没有"液面"可落雨。要保留天气差异需要另想机制
  （例如雨落在弧的进度头上），属新一轮设计。

## 坑位（可沉淀）

1. **`pathLength` 是"半径留在 CSS 里"的前提**。SVG 的 `r` 是 CSS 几何属性（Chromium 支持
   `r: var(--ring-r)`），配合 `pathLength` 归一化后 dasharray 与半径解耦。没有它，
   半径就得进 TS，CSS 与 TS 各写一份几何 —— 那正是本仓反复踩的漂移源。
2. **断言"某条规则在某作用域下"要按选择器列表内容认人**，不能只按字符串形状：
   本文件 reduced-motion 块里存在与 morph 段几乎同形的第二处实现（假绿集 3 → 修 → 反向假红 3）。
3. **像素判据的"更接近 A 还是更接近 B"比阈值稳**：固定亮度阈值在有明暗变化的轨道
   （minimal 的分段环）上整段误判；基线取样必须落在弧**必不覆盖**的区段。
4. **DOM 位置的取证用 div 配平**（K7h 的办法），比"找闭标签下标"可靠：自闭合 `<div />` 不计 open。
5. **把原型的 alpha 搬到另一块盘面上之前必须重算**（2026-10-06）。原型 V5 的轨道是柠檬
   `rgba(190,255,60,.22)`，看着"淡一点正好"，但那是**深盘**上的淡；minimal 的盘是近白
   `#f2f2f6`，同一个 0.22 混出来是 `rgb(231,245,205)`，肉眼等于盘面本身。**同一串数值在两块
   盘上的可见性是两个量**。而且这里的尺子也要换：柠檬对近白盘的 WCAG 对比度只有 1.07，
   亮度对比度从一开始就**不适用**，得改用色相位移（合成后的 G−B 级差）当判据。
6. **"把某类元素加进一张名单"和"那张名单压得住"是两件事**（2026-10-06）。上一轮把 `.fluid-ring`
   补进 freeze 停表名单就以为完事了，其实名单自己 (0,5,0) 打不过 morph 的 (0,6,0)，等于没加 ——
   而失败表现是"定帧 transform 悄悄不生效"，比漏项更难认出来。加名单之后必须**顺手比一次
   specificity**，否则这是一次**看起来做了**的修复。
7. **alpha 只能在一处乘**。`opacity: .35` 的元素 + 令牌里再写 alpha 35% = 0.12，比谁都看不见。
   本文件现在的规矩是 alpha 一律写进颜色令牌（同 `--ring-ticks-c` / `--ring-inner-c`），
   元素上不再挂 `opacity`。
