# 执行计划：球表面令牌化 + 标签下移 + 自动轮播先走完窗口

顺序原则：**先补令牌（纯 CSS、可逐皮肤实拍证伪）→ 再动 DOM 位置 → 最后改轮播逻辑（最容易静默冻死）**。
步 1 结束即可交付；步 3 出问题可以停在步 2（视觉两项已完成，轮播仍是旧的）。

---

## 进度快照

| 步 | 内容 | 状态 | 门 |
|---|---|---|---|
| 0 | 取证基线（逐皮肤实拍 + 当前键数） | ✅ 已完成 | 5 张皮肤图 + 键数记录在案 |
| 1 | `--ball-bg`/`--ball-rim` + 删 `backdrop-filter` | ✅ 已完成 | 结构门 + 5 皮肤实拍（rim 方向与盘相反，逐皮肤实测） |
| 2 | 标签下移 + 等宽 | ✅ 已完成 | 实拍：标签在数字下方、间隙 2.5px、不溢出 56×56 |
| 3 | 自动轮播先走完窗口 | ✅ 已完成 | `petCarouselOrder` + `petCarouselRhythm` |
| 4 | 结构门（`test-structure.mjs` **11 条断言**） | ✅ 已完成 | 每条弄坏一次，红集恰好等于声明目标 |
| 5 | 行为门（uitest：作废 1 条 + 新增 3 条 + 裁决①） | ✅ 已完成 | 红集恰好等于声明目标 |
| 6 | 文档同步 + **真实白底人工复现** | ⚠️ **部分完成** | 文档已同步；**AC1.4 待用户人工确认** |
| 7 | R5 定位方框真凶（删 outer box-shadow）+ 复核取证手段 | ✅ 已完成 | 结构门 D6 两条红绿循环 + `design.md` §9.8 的 alpha 实测 |
| 8 | 改名框去掉 outer box-shadow（用户拍板）+ **D6 扩成「宠物窗口满幅元素」这一类** | ✅ 已完成 | 结构门 **28 条**；批次 10–18 红集恰好等于声明目标 |

> **步 4 的断言数是 11 不是 5**：`design.md` §6.1 列的 5 个门里，`ball-surface-token` 拆成
> 「是 `--ball-bg`」+「不再引用 `--bg`」两条，`winlabel-mono` 拆成「独立字体栈」+「字号 ≤9px」
> 两条；另加 2 条 D0 骨架门（按选择器确实取到整块）—— 没有它们，取块失败会让上面几条
> **空洞地通过**（实测：改名选择器时，D1 的「不再引用 --bg」原本仍绿，已修）。
> 合计 13 → **23 条**；R5 之后 +1 条 `ball-no-outer-shadow` → **24 条**；
> **步 8 把 D6 从 1 条拆成 5 条（4 条 `no-outer-shadow` + 1 条 `inset-3d`）→ 28 条**，
> `npm run test:structure` 实测 `通过 28 项，失败 0 项`。
> `npm test` 合计随之由 473 → **477**（9 个 suite 全 0 失败）。
>
> ⚠ **D6 门表从 5 项缩回 4 项**：`.petball-debugring` 曾被列进去，理由写的是「按投影上报的
> 外接框 = 整个窗口」—— **那条理由是假的**（`PetBall.tsx:812` 写明它只可能是人物形态，球形态
> `w` 恒为 0，也就是它在 56×56 窗口里**根本不存在**；人物形态下也只是 213×293 里的
> 一圈虚线）。**门的前提不成立就不能进表** —— 留着等于让注释宣称一个代码不具备的性质，
> 与本任务修的正是同一类错。批次 13′ 实测：移出后给它加 outer shadow 门**不再红**（28/0），
> 这是预期结果，不是回归。

---

## 步 0：取证基线（不改行为）✅ 已完成

已产出（`BD_SKINS=1 npx electron . --ballshot` → `/tmp/balancedeck-shots/ball-skin-*.png`）：

| 皮肤 | `--bg` | 实拍观感 |
|---|---|---|
| `minimal` | `#ffffff` | 纯白盘（白桌面下零对比） |
| `ink` | `#f4f1ea` | 米色盘 |
| `candy` | 粉蓝渐变 | 渐变在 56px 上糊成一条 |
| `aero` | `rgba(246,246,248,0.72)` | 浅灰盘 |
| `dark` | `#101014` | 黑盘 ✓（用户实测在这款上看到浅框 → 只能是 `backdrop-filter`） |

- [x] `--track` 逐皮肤取值已取证，证明「球随皮肤变色」是自洽设计（`design.md` §2.1）
- [ ] 记下当前 `npm test` 通过数与 `--uitest` 键数（上一任务终值：**462 项 / 109 键**）
- [ ] 记下 `test-structure.mjs` 当前断言数（上一任务终值：**13 项**）

---

## 步 1：球表面令牌化（R1 + R2）

- [ ] `skins.css` 的 `:root, [data-skin='aero']` 块内加 `--ball-bg` / `--ball-rim`
- [ ] 5 个皮肤各自加这两个令牌，取值按 `design.md` §2.2 的 5 条原则：
      - `minimal`：`--ball-bg: #f2f2f6`、`--ball-rim: rgba(0,0,0,0.18)`、
        `--track` 由 `rgba(0,0,0,0.08)` 提到 `rgba(0,0,0,0.12)`
      - `ink`：保留 `#f4f1ea`，rim 改**深色** `rgba(60,50,30,0.22)`（现值是白 rim，贴米盘不可见）
      - `candy`：渐变压成中间调**纯色**（渐变是为几百 px 卡片调的）
      - `aero` 浅色：`--ball-bg` alpha `0.72 → 0.86`
      - `dark` / `aero` 暗：基本沿用现值，只需把 `--bg` 的值搬进 `--ball-bg`
- [ ] `.petball-fallback`：`background: var(--bg)` → `var(--ball-bg)`；
      **删** `backdrop-filter` 与 `-webkit-backdrop-filter` 两行
- [ ] 检查 `--dot-rim` 的去留：若 `--ball-rim` 取代了它在盘缘的职责，
      把 `box-shadow` 里那条 `inset 0 0 0 1px var(--dot-rim)` 改指 `--ball-rim`，
      **不要留一个没人用的令牌**（会变成下一个误导源）
- [ ] `:root` 兜底必须在（AC1.5：外部皮肤没写该令牌时球不能变成透明的）

**门**：`grep -n "petball-fallback" -A14 src/renderer/src/skins.css` 内无 `var(--bg)`、
无 `backdrop-filter`；5 张皮肤实拍逐一**肉眼看是否读作一个物体**（`minimal`/`ink` 是重点）。

**回滚点**：本步只动 CSS，可单独 revert。

---

## 步 2：标签下移 + 等宽（R3）

- [ ] `.petball-fallback` 加 `grid-auto-flow: row; align-content: center; gap: 1px`
- [ ] `.dot-winlabel` 去掉 `position/left/bottom`，改 `position: static`；
      `font-size: 8px`、加 `font-family: ui-monospace, …`、
      `font-weight: 500`、`letter-spacing: 0.04em`（等宽下 `5H` 偏挤）
- [ ] 保留 `pointer-events: none` 与「仅 `windows.length > 1` 时渲染」的条件（沿用上一任务）
- [ ] `PetBall.tsx` 里 `<span className="dot-winlabel">` 的**位置**：必须在 `.dot-value`
      之后、且与它同属 `.petball-fallback` 的 grid 流（SVG 是 `position:absolute`，不参与）

**验证**
```bash
npm run typecheck && npm run build
npx electron . --ballshot
```
实拍放大确认：标签**不压环、不压数字、不溢出 56×56**、与数字同列。
整组居中会让数字偏上 5.5px —— 觉得高就 `padding-top: 2px`（**只调这一个数**）。

**回滚点**：本步与步 1 互不依赖，可单独 revert。

---

## 步 3：自动轮播先走完窗口（R4）

- [ ] `PetBall.tsx` 加 `advanceAuto`（`design.md` §4.1）：
      `n > 1 && winIdx + 1 < n` → `setWinIdx(winIdx + 1)`；否则 `advanceProvider(1)`
- [ ] **⚠️ 不要把 `advanceAuto` 放进 interval effect 的 deps** —— 它依赖 `s`/`winIdx`，
      每次切窗口都是新函数 → effect 重跑 → `lastAdvance` 归零 → 6 秒永远走不到
      → **球彻底静止**（`design.md` §4.2）
- [ ] 改用 `live` ref 在 tick 内读 `n` / `winIdx`，effect deps 保持 `[count, advanceProvider]`
- [ ] 手动左右/上下滚轮的语义**一律不动**（`advanceProvider` 仍是 `idx` 的唯一出口）

**验证**：`petCarouselOrder` + `petCarouselRhythm`（步 5 建）。
**`petCarouselRhythm` 是专打上面那个冻结陷阱的**，不能省。

**回滚点**：本步若出问题，回滚后行为 = 上一任务（只自动换人），视觉两项仍保留。

---

## 步 4：结构门（`scripts/test-structure.mjs`，5 条）

按 `design.md` §6.1：`ball-surface-token` / `ball-no-backdrop-filter` /
`ball-bg-defined-per-skin` / `winlabel-mono` / `winlabel-not-absolute`。

**每条走完整循环**：写绿 → 弄坏 → 红 → 还原 → 绿，红集**恰好等于**该批声明目标。

**门**：`node scripts/test-structure.mjs` 现有 13 项 + 新增 5 项 = **18 项全绿**
（R5 之后 +`ball-no-outer-shadow` = **24 项全绿**）。

---

## 步 5：行为门（`src/main/qa/uitest.ts`）

- [x] **作废** `petCarouselResetsWindow`，替换为 `petCarouselOrder`（`design.md` §5.1）。
      作废原因留在代码注释里：R4 之后多窗口供应商的自动轮播**正确行为就是窗口往后走**，
      旧断言会把正确实现判红 —— 留着是**会误报的假护栏**
- [x] `implment.md` 批次表里 `petCarouselResetsWindow` 那条标注「已被 09-28 作废」（留痕不删）
- [x] 新增 `petCarouselRhythm` / `petWinLabelBelow` / `petBallSkinSurface`
- [x] **确认** `petBallCenterValue` / `petBallRingDiag` 在 `winIdx ≠ 0` 时仍成立
      —— **确认方式**：二者都只读**当帧的 DOM**（`data-ring`、track/fill 的 computed stroke、
      `.dot-value` 的 textContent），不读 `idx`/`winIdx` 任何一个。`winIdx` 变了只会让
      「当帧是哪个窗口的读数」不同，而断言本身是**关系式**（有百分比则 fill 的 dash>0、
      余额则连 track 都不许有），对读数取值不敏感。`petBallRingDiag` 是**纯记录**，
      其值从此带时序性，**不得**当硬期望。
- [x] 人物形态 8 字段基线逐位不变 → **已裁决并实施**，见下「步 5 裁决记录 ①」

**门**：`npm run uitest` 全绿 + 每条断言的弄坏记录写完。

### 步 5 裁决记录 ①：`petFigureUnchanged` 的 `overlay` 字段（已实施，方案 b）

**先量后判**：`BD_PET=1 BD_PET_ID=aria npx electron . --ballshot` 各连跑 3 次 ——
R4 版本 3/3 得 `[["petball-caption",65,245,148,289]]`（idx0，宽 83），
`git stash` 回到 HEAD 后 3/3 得 `[["petball-caption",68,245,145,289]]`（idx1，宽 77）。
**完全确定，不是 flake。** 根因与预判一致：R4 改了节拍，同一墙钟时刻落在不同供应商。

采纳方案 **(b)**，且**没有为了门变绿而移动任何已建立的基线**：
7 个几何/时序字段（win/stage/canvas/rect/center/stride/petReady）**仍逐位钉死**；
`overlay` 改为有界检查（存在且恰好一项且是 `.petball-caption`；`top==245`、`h==44` 逐位钉死；
`x/w` 落在窗内且 `w ∈ [60,120]`）；`caption` 文案本身**仍逐位钉死** `'13.7% / Claude Code'`。
理由：胶囊宽度是「标签文字宽 + padding」的函数，**从来不是人物形态的属性**。

**护栏强度用「弄坏」证明过**（不是靠论证）：

| 弄坏手法 | 实测红集 |
|---|---|
| 胶囊 `padding` 横向 9px→40px（宽度跑飞） | {`petFigureUnchanged`: `fail:overlay-width=139`} |
| 胶囊 `padding` 纵向 3px→30px（高度跑飞） | {`petFigureUnchanged`: `fail:overlay-yh=top232/h70`} |
| 把有界判据里的 `top` 基线 245 挪成 240（「改基线让它变绿」） | {`petFigureUnchanged`: `fail:overlay-yh=top245/h44`} |
| 把 `w` 上界 120 收紧到 78（想卡死 R4 后的 83） | **{空集}** —— 见下，这条是本裁决的**已知盲区** |

⚠ **诚实记录的盲区**：`w > 120 → 78` 竟然没红。原因是该轮 uitest 的 `overlayRaw` 落在
**宽度 77 的那一帧**（uitest 自己会重试到 `idx==1`），83 是 **ballshot** 那一帧的值。
即：uitest 观测不到 83 这个宽度，所以「上界收到 78」对它不产生影响 ——
但**把上界收到 77 就会红**（真实值 77 > 77 不成立），说明 120 这个上界仍是有牙齿的，
只是比「看起来」更依赖当帧文案。**不建议**再收紧：收成 77 就等于把 `overlay` 重新
耦合回某一帧的文案长度，正是本裁决要拆掉的耦合。

顺带修掉一个**真 bug**（我自己写出来的）：最初把 `overlay` 的
`[class, x, y, w, h]` 当宽高读，而 `figFieldsJs` 产出的其实是 `[class, left, top, right, bottom]`
—— 于是 `h` 读成了 289。首轮实跑报 `fail:overlay-yh=245/289` 才暴露。已改为差值运算，
并加了 `OverlayBox` 类型注释说明「只做差值、绝不直接拿 right/bottom 当尺寸」。

---

## 步 6：文档同步 + **真实白底人工复现**

- [x] `README.md` / `DESIGN.md` / `CONTEXT.md` 的对应行
      —— `CONTEXT.md` 新增「球盘」术语 + 令牌按归属分族；`DESIGN.md` 的「窗口全平台透明 /
      磨砂」那两条已改（`backdrop-filter` 在透明窗口里履行不了宣称）；README 轮播那行补上
      「先走完窗口再换人」
- [x] `.trellis/spec/frontend/component-guidelines.md` 加两条形态共用陷阱：
      「改跨形态共用的规则前先问它在另一形态下成立吗」+「别把依赖文案长度的量钉成硬期望」
- [ ] ⚠️ **AC1.4 纯白背景肉眼确认** —— 待用户确认。
      （另：裁决④ 数字内探 1.1px 经复核**维持不动**，理由已写进 `prd.md` AC3.2）
      把球放到**纯白背景**上肉眼确认那圈浅色框消失（不是「变淡」）。
      ⚠️ **2026-09-28 check 订正**：原文的理由「`--ballshot` 的 `capturePage` 出的是透明 PNG、
      **不合成桌面 backdrop**，所以「实拍没变化」不算证据」**只对「球有没有透出壁纸」成立**。
      **方框本身 capturePage 拍得到** —— 它是页面自己画在窗口内的 alpha，而 capturePage 拍的
      就是那 56×56 的窗口内容。免权限的机器可读证据见 `design.md` §9.8：
      `node scripts/lib/png-probe.mjs /tmp/balancedeck-shots/ball-skin-minimal.png`
      修前「球外 2688/2688 个像素 alpha>0、最远半径 78.5px（= 窗口对角线）」，
      修后「208/2688、最远半径 56.7px、离球沿 2px 外 0 个」，5 个皮肤一致。
      **本项仍未完成**（它验的是屏幕合成，PNG 验不了），但它**不再是「AI 无法取证」**。
- [x] 门：`grep -rn "backdrop-filter" src/renderer/src/skins.css` 在 `.petball-fallback`
      **生效声明**内 0 命中（结构门 D2，已剥注释验证：注释里保留该词但 D2 绿）；
      `--dot-rim` 全项目 0 定义 0 引用（已删净）

---

## 步 7：R5 的护栏与取证手段复核（2026-09-28 check）

- [x] **结构门 D6 `ball-no-outer-shadow`**：`.petball-fallback` 的 `box-shadow` **逐层**都是 `inset`
      （判据：剥注释 → 按完整选择器配平花括号取整块 → 按**顶层逗号**切层 → 每层 `^inset`；
      并要求 `层数 > 0` 防空洞）。弄坏记录见下方批次 8/9
- [x] **同机理扫描**：把 `skins.css` 里全部 outer `box-shadow` 列出来，逐个判「元素尺寸是否等于
      窗口尺寸」。展开态 384×600 直接实拍解码（`.card` 无 box-shadow，16px 圆弧之外带 alpha 的
      220 个像素全在离弧 ≤1.12px 处 = 抗锯齿，**没有方框**）；球形态用真实构建产物的样式表在
      56×56 透明窗口里复现。**结论与数字见 `design.md` §9.8 的表**
- [x] **取证手段复核（推翻了产物里三处说法）**：`capturePage` 拍得到方框（球外 100% 像素带 alpha），
      「拍不到屏幕合成」只对桌面 backdrop 那一问成立。已订正 `prd.md` R2/AC1.4/AC5.4、
      `design.md` §2.3/§6.2/§9.3/§9.5/§9.7、`implement.md` 步 6、`skins.css` 两条注释，
      以及 `src/main/overlay.ts` 里把方框归给原生窗口阴影的那段（**误诊 #2**，只改注释，
      `hasShadow: !state.collapsed` 行为未动）
- [x] 补 `scripts/lib/png-probe.mjs`（纯 zlib 的 PNG→RGBA 解码，~90 行，不引新依赖）

---

## 步 8：改名框 + D6 扩类（2026-09-28 check 第二轮）

- [x] **删掉 `.petball-rename input` 的 `box-shadow: 0 6px 20px rgba(0,0,0,0.35)`**
      （用户 2026-09-28 拍板）。留下注释说明**为什么不能加回来**：它 168×28 却活在同一个
      56×56 窗口里，20px 光晕实测把 112×112 像素 100% 铺满；辨认度靠深色底 + 1px 强调色边框
- [x] **D6 从「守一个选择器」扩成「守宠物窗口满幅/溢幅元素这一类」**：4 条 `no-outer-shadow`
      （底盘 / 底盘按压态 / 改名框 / 命中层，**逐个独立判**）+ 1 条 `inset-3d`
      （只守底盘的 AC5.3）。沿用 `shadowLayers()` / `ruleBody()` / `decls()`，**未重写**
- [x] ⚠️ **「层数 > 0」没有推广到整张表**：改名框的**正确终态就是 0 层**，对它要求层数 > 0
      等于逼着人把阴影写回去。只对「本该有 inset 立体感」的底盘提
- [x] 批次 10–18 全部走完「写绿 → 弄坏 → 红 → 还原 → 绿」，红集**恰好等于**声明目标
      （表在下方）。批次 17/18 顺带把原文标注「未重跑，不作数」的批次 6/7 重跑了
- [x] **独立复验「展开态那 13 处 outer box-shadow 不该动」**（不采信上一轮结论），实跑：
      - `npm run shots` 重拍 `1-card.png` / `8-drag-preview.png`（384×600 → 768×1200 设备像素），
        逐像素解码：两帧都是**圆角矩形之外 0 个像素带 alpha、四角点 alpha `0/0/0/0`**
      - 右缘 alpha 轮廓**对称收口**（x=370 → 行 0..600，x=376 → 2..598，x=382 → 8..592）→ 圆角
      - ⚠️ **推翻了上一轮的理由**：`.pcard` 的右边框在 `x ≈ 369.5`，384 宽窗口里只剩 **14px 余量**；
        `.pcard.dragging` 的压暗带一路走到 **`x = 383` 最后一个像素都没退回底色** ——
        阴影**确实被窗口边界裁了**。保护来自 `.card` 的 `overflow:hidden` + `border-radius:16px`，
        不是「元素被内缩」
      - ⚠️ 顺带查出两处**不实记录**，已订正 `design.md` §9.8 的表：
        ① `.petball-bubble` 从未有过 `0 6px 20px`（`git log -S` 只命中 `63aa291` 新增的
        `.petball-rename input`）；② 人物形态「四条窗口边全 0 alpha」不成立 —— 实测
        **下缘**最后一行 alpha `1..20`、横跨 `x 58.5..153.5`（`.petball-caption` 的合法
        `0 2px 10px` 投影被窗口下缘裁了一道；左/右/四角仍是 0，**不构成方框**）
      - **未加 `.card` 的门**（本任务作用域是宠物窗口；`design.md`/`spec` 都记了这条潜藏风险）
- [x] **踩到并修掉一个测量陷阱**：`capturePage()` 出的是 **2× 设备像素**（56 CSS → 112×112）。
      我第一版把 DPR 写成 `width / 112`（设备宽）→ `dpr=1`、`R=28`，于是一份**干净**的构建
      报出「球外 75.4% 带 alpha、7236 个离沿 2px 外」。改正后独立复现出已知良好数字：
      **5 个皮肤 + 2 张 `5-ball` 全部 208/2688 = 7.7%、最远 56.7px、离沿 2px 外 0 个**
- [x] **顺带修掉一个真 bug（本轮实测崩的）**：`uitest.ts` 的 `r.petDiag` 只判了 `ball &&`
      就直接读 `ball.rect.width` / `ball.measure.box.width`，而这两个字段**运行时可以是 null**
      （球形态不建 3D 场景；人物形态在首帧 `measure()` 之前）。实测崩在
      `out/main/index.js:4696` → `TypeError: Cannot read properties of null (reading 'width')`，
      它是**未捕获的 promise rejection**，于是**整轮 `--uitest` 一条 JSON 都不打印**
      （stdout 仅 1.2KB 错误栈，退出码 1）。一条**纯诊断**字段把 112 键的证据换成了
      「什么都没跑」。已改成先取 `bRect`/`bInk` 再序列化，并把类型改成如实可空。
      **没有断言读 `petDiag`，所以这不弱化任何门。**
      ⚠ 诚实标注：原崩溃**是时序依赖的**，修完后连续多轮 `--uitest` 都没再崩，但
      「能按需稳定复现原崩溃」做不到 —— 能证明的是修复后不再发生，且修复前的崩溃有明确
      堆栈与字节数留痕。

---

**结构门**（`node scripts/test-structure.mjs`，快，可反复跑）：

| 批次 | 弄坏手法 | 实测红集 | 声明目标 | ✓ |
|---|---|---|---|---|
| 1 | 底盘 `var(--ball-bg)` → `var(--bg)` | {D1 底盘, D1 无 --bg} | D1 两条 | ✓ |
| 2 | 加回真 `backdrop-filter` 声明（**注释仍在**） | {D2} | D2 | ✓ |
| 3a | 删**顶层** `:root` 的 `--ball-rim` | {D3 rim} | D3 rim | ✓ |
| 3b | 删顶层 `:root` 的 `--ball-bg` | {D3 bg} | D3 bg | ✓ |
| 3c | 删 `minimal` 的 `--ball-bg` | {D3 bg} | D3 bg | ✓ |
| 3d | 删 `ink` 的 `--ball-rim` | {D3 rim} | D3 rim | ✓ |
| 3e | 删 `dark` 的 `--ball-bg` | {D3 bg} | D3 bg | ✓ |
| 4a | 标签 `font-family` → `inherit` | {D4 字体} | D4 字体 | ✓ |
| 4b | 标签 `font-size` → `12px` | {D4 字号} | D4 字号 | ✓ |
| 5 | 标签 `position: static` → `absolute`+left/bottom | {D5} | D5 | ✓ |
| 6 | 改名 `.petball-fallback` 选择器 | {D0×1, D1×2, D2} | 取块失败扇出 | ✓ |
| 7 | 改名 `.dot-winlabel` 选择器 | {D0×1, D4×2, D5} | 取块失败扇出 | ✓ |
| 8 | **加回 outer `box-shadow: 0 6px 18px rgba(0,0,0,0.28)`** | {D6}（4 层，1 层非 inset） | D6 | ✓ |
| 9 | **整条 `box-shadow` 删掉**（0 层） | {D6} | D6 | ✓ |
| 10 | **改名框加回 `box-shadow: 0 6px 20px rgba(0,0,0,0.35)`**（出事那一行，逐字还原） | {D6 no-outer-shadow `.petball-rename input`} | 同 | ✓ |
| 11 | **球盘按压态加 `box-shadow: 0 4px 12px rgba(0,0,0,0.3)`** | {D6 no-outer-shadow `…:active…`} | 同 | ✓ |
| 12 | 命中层 `.petball-hit` 加 `box-shadow: 0 0 20px rgba(0,0,0,0.4)` | {D6 no-outer-shadow `.petball-hit`} | 同 | ✓ |
| 13 | 调试环 `.petball-debugring` 加 `box-shadow: 0 0 12px rgba(255,0,128,0.5)` | {D6 no-outer-shadow `.petball-debugring`} | 同 | ✓（**随后该项被移出门表**，见下） |
| 13′ | 同上，移出门表之后重跑 | **{空集}**（28/0） | 无 —— 前提不成立 | 预期 |
| 14 | **球盘加回 outer `0 6px 18px rgba(0,0,0,0.28)`**（D6 扩成 6 条后重跑批次 8） | {D6 no-outer-shadow `.petball.no3d .petball-fallback`}，**`inset-3d` 仍绿**（4 层 ≥1） | 同 | ✓ |
| 15 | **球盘整条 `box-shadow` 删掉**（0 层，重跑批次 9） | {D6 inset-3d} | 同 | ✓ |
| 16 | 改名框选择器改名 `.petball-rename2 input` | {D6 no-outer-shadow `.petball-rename input`}（`body == null` 兜住空洞） | 同 | ✓ |
| 17 | 底盘选择器改名 `.petball-disc`（2 处 replaceAll） | {D0×1, D1×2, D2, D6 no-outer-shadow, D6 inset-3d} = **6 条** | 取块失败扇出 | ✓ |
| 18 | 短标签选择器改名 `.winlabel` | {D0×1, D4×2, D5} = **4 条** | 取块失败扇出 | ✓ |

⚠ **批次 17/18 是原批次 6/7 的重跑，原文那句「现在重跑批次 6 的红集会是
{D0×1, D1×2, D2, D6} —— **未重跑，不作数**」到此作废**：D6 拆成 6 条后实测是
**6 条**（{D0, D1×2, D2, D6 no-outer-shadow, D6 inset-3d}），比原先预估多一条，因为
`inset-3d` 与 `no-outer-shadow` 现在是两条独立断言。批次 6 用的 `replaceAll` 命中
底盘规则与 `.petball.no3d .petball-fallback svg` 两处，**`:active` 按压态那条不含该字符串，
所以按压态的门在批次 17 里仍绿** —— 它的覆盖由批次 11 单独证明。

⚠ **批次 11 第一次跑是空集**（该记，不藏）：第一版补丁把 shadow 写成了
`transform: … scale(0.94) 0 4px 12px rgba(0,0,0,0.3);` —— 拼进了 `transform` 的值里，
`box-shadow` 键压根没出现，门自然绿。**这就是「弄不红」的一种伪装形态：补丁本身是错的，
不是门没牙齿。** 改正成独立声明后红集恰好等于声明目标。

⚠ 批次 8 是本任务最关键的一次「弄坏」：**它还原的正是出事那一行**
（`inset …, inset …, 0 6px 18px rgba(0,0,0,0.28)`）。批次 9 证明 D6 不是
「删光了自然就绿」的假护栏 —— 层数为 0 时「没有非 inset 层」空洞成立，所以判据带 `层数 > 0`。

⚠ 批次 2 同时是**「grep 门 vs 必须断言的字面量」的同轮红绿证明**：注释里始终有
`backdrop-filter`，加真声明 → 红；只有注释 → 绿。

**行为门**（每轮一次 `npm run build` + `--uitest`，约 150s）：

| 批次 | 弄坏手法 | 实测红集 | 声明目标 | ✓ |
|---|---|---|---|---|
| B1 | 删**全部** `--ball-bg` 定义 | {`petBallSkinSurface`} | 同 | ✓ |
| B2 | 标签退回 `position:absolute` 左下角 | {`petWinLabelBelow`: `gap=13.5`} + 结构 {D5} | 同 | ✓ |
| B3 | tick 退回「只换人、从不走窗口」 | {`petCarouselOrder`: `no-window-walk seq=[0,-1]`, `petCarouselRhythm`: `stalled seen=[1/0,0/0]`} | 两条 | ✓ |
| B4 | 胶囊 padding 横向 9→40px | {`petFigureUnchanged`: `overlay-width=139`} | 同 | ✓ |
| B5 | 胶囊 padding 纵向 3→30px | {`petFigureUnchanged`: `overlay-yh=top232/h70`} | 同 | ✓ |
| B6 | 把有界判据 `top` 基线 245 → 240 | {`petFigureUnchanged`: `overlay-yh=top245/h44`} | 同 | ✓ |
| B7 | 把 `w` 上界 120 → 78 | **{空集}** | — | ✗ 盲区，已在裁决①记录 |

### 两条**弄不红**的尝试（诚实记录：它们不是本任务门的失职，是被测对象本身无此行为）

| 尝试 | 实测结果 | 说明 |
|---|---|---|
| 把 `live.current.winIdx/winCount` 塞进 interval effect 的 deps | **全绿**，球照常 6s 推进 | `design.md` §4.2 推断的「球彻底静止」**不成立**（原文已改）。真实代价是定时器 churn + 基准漂移 |
| 依赖里放 `Date.now()`（每渲染都变） | `petCarouselRhythm`/`petCarouselOrder` **仍绿**；只有 `petFigureUnchanged` 因轮播时刻偏移而红 | 同上。`petCarouselRhythm` 守的是**节拍持续推进**，不是「冻结」 |

### 裁决③：`petCarouselResetsWindow` 的时间余量 —— 已实测，非推算

- 旧实现的观测窗：① 手动滚轮后 7s 采样守 `idx` 不变 + ② 最多 8s 等 `idx` 变化。
- **R4 下 ② 必然不够**：Fix B 有 2 个窗口 → 暂停 8s 后第一步走**窗口**（`idx` 不变），
  第二步（再 6s）才换人 → 换人落在 t≈14–15s，而 ② 在 t≈15s 结束 → **余量 ≈ 0，且必然超时**。
- 处置：按 `design.md` §5.1 用 `petCarouselOrder` 取代，并把观测窗从 `16 × 500ms`
  放宽到 `24 × 500ms`（12s），失败信息里带上实测序列 `seq=[...]`。
- 修好后的实测余量：换人落在 t≈14–15s，观测窗到 t≈21s → **余量 ≈ 6s**（不再是 flake 边缘）。
  佐证：三轮 uitest（含基线那一轮）`petCarouselOrder` 全绿，且 `petCarouselRhythm`
  在 36s 内稳定看到 ≥3 个状态。

## 自检命令

> ⚠️ **`npx electron . --X` 跑的是 `out/`，不是 `src/`** —— `"main": "./out/main/index.js"`。
> 任何源码改动后**先 `npm run build`**。`BD_USER_DATA=... npm run build && ...` 会把 env
> 只传给 build 而**丢给 electron**，构建必须**单独一行**。

```bash
npm run typecheck
npm test                            # 9 个 suite，合计 477 通过 / 0 失败
node scripts/test-structure.mjs      # 期望 28 项（步 8 把 D6 从 1 条扩成 5 条）

npm run build

# uitest 必须带 BD_USER_DATA，否则继承本机偏好报 20+ 项假失败
rm -rf /tmp/bd-ud && mkdir -p /tmp/bd-ud
BD_USER_DATA=/tmp/bd-ud npx electron . --uitest

# 逐皮肤实拍（步 1 的主要证据）
BD_USER_DATA=/tmp/bd-ud BD_SKINS=1 npx electron . --ballshot
# → /tmp/balancedeck-shots/ball-skin-{aero,dark,minimal,candy,ink}.png

# 球盘外不该有任何方形 alpha（R5 / AC1.4 的机器可读版，免 Screen Recording 权限）：
# 期望「球外 alpha>0 的像素 ≈ 0」「alpha>0 的最远半径 ≈ 56.7px（球盘 56 + 抗锯齿）」
node scripts/lib/png-probe.mjs /tmp/balancedeck-shots/ball-skin-minimal.png

# 人物形态基线复核
BD_PET=1 BD_PET_ID=aria npx electron . --ballshot
```

**判 `out/` 新鲜度**：`ls -l out/main/index.js` 的 mtime 必须晚于最后一个改动的源文件。

---

## 上下文清单（按需 `Read`，不进 jsonl）

- `src/renderer/src/skins.css` —— `:root` 与 5 个 `[data-skin]` 块（令牌全部在这）
- `src/renderer/src/PetBall.tsx` —— 轮播 effect、`.dot-winlabel` 渲染处
- `scripts/test-structure.mjs` —— 结构门写法与现有 13 项的风格
- `src/main/qa/ballshot.ts` —— `BD_SKINS=1` 分支
- `src/main/overlay.ts:133-139` —— 透明窗口参数（`backdrop-filter` 论证的证据）
