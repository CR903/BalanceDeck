# 技术设计：球表面令牌化 + 标签下移 + 自动轮播先走完窗口

任务 `09-28-dot-frame-label-carousel`。规划阶段（2026-09-28），尚未 `task.py start`。

---

## 1. 边界

| | 本任务动 | 本任务不动 |
|---|---|---|
| CSS | `.petball-fallback` 的背景/滤镜、`.dot-winlabel`、`:root` 与 5 个 `[data-skin]` 的球令牌 | `.dot-value`/`.dot-ring-*`/`.petball-caption`/`.petball-hit` |
| TSX | `PetBall.tsx` 的 `onWheel` 邻近逻辑、轮播 effect、`.dot-winlabel` 的 DOM 位置 | `advanceProvider` 的**手动**语义、动画 `Reading` 两态、人物形态任何分支 |
| 脚本 | `scripts/test-structure.mjs`（结构门）、`src/main/qa/uitest.ts`（行为门） | `read-model.ts`、`quality.ts`、任何适配器 |
| 文档 | `README.md`/`DESIGN.md`/`CONTEXT.md` 的对应行 | `docs/pet-3d.png`（`09-18-human-realism` 基线） |

---

## 2. 球表面：补令牌，不改「随皮肤变色」这件事

### 2.1 现状与病根

`.petball-fallback`（`skins.css:1667-1669`）：

```css
background: var(--bg);
backdrop-filter: blur(24px) saturate(180%);
```

`--bg` 是**页面/卡片表面色**。球的专属令牌族 `--track` / `--dot-rim` / `--dot-bottom`
5 个皮肤**全都定义了**，唯独**没有表面色** —— 球才去借了页面的。

证据（`--track` 逐皮肤取值证明球盘本就该逐皮肤）：

| 皮肤 | `--track` | 配的是 |
|---|---|---|
| `minimal` | `rgba(0,0,0,0.08)` | 浅盘（深色轨道） |
| `dark` | `rgba(235,235,245,0.14)` | 深盘（浅色轨道） |
| `aero`(暗) | `rgba(235,235,245,0.16)` | 深盘 |
| `ink` | `rgba(60,50,30,0.14)` | 浅盘 |
| `candy` | `rgba(120,90,200,0.16)` | 中间调盘 |

所以「球随皮肤变色」是**自洽设计**（用户 2026-09-28 也拍板走这条路），病根只有「借错令牌」。

### 2.2 新令牌

新增 `--ball-bg`（表面）与 `--ball-rim`（盘缘，替代/加强 `--dot-rim` 在盘边缘的角色）：

```css
/* :root 与 [data-skin='aero'] 同块 —— 外部皮肤（ext:*）的兜底也在 :root */
--ball-bg:  rgba(246, 246, 248, 0.86);
--ball-rim: rgba(0, 0, 0, 0.16);
```

取值原则（**判据可 grep、可算，不靠目测**）：

1. `--ball-rim` 的方向**必须与盘相反**：浅色盘的 rim 是**深色**且 `alpha ≥ 0.16`；
   深色盘的 rim 是**浅色**且 `alpha ≥ 0.12`。现状 `minimal` 的
   `rgba(0,0,0,0.08)` 直接不达标（这正是白底上看不出「这是一个球」的原因）。
2. `--ball-bg` **不接受与桌面同色**。`minimal` 原值 `#ffffff` 在白桌面下零对比 → 收到
   `#f2f2f6`（带一点冷调，仍读作「极简白」）。
3. `ink` 保留纸色 `#f4f1ea`（那是这款皮肤的灵魂），但 rim 从 `rgba(255,255,255,0.5)`
   改为**深色** `rgba(60,50,30,0.22)` —— 白 rim 贴在米盘上几乎不可见。
4. `candy` 的**渐变不许进球**。`--bg` 的
   `linear-gradient(160deg, …)` 是为几百 px 的卡片调的，56px 盘上会糊成一条污迹 →
   压成一个中间调纯色。
5. `aero` 浅色盘的 alpha 从 `0.72` 提到 `0.86`：半透明盘叠在浅桌面上会整体发灰、
   数字对比度不稳。

**`:root` 必须有定义**，否则外部皮肤（`ext:*`）没写这个令牌时球会**完全透明** ——
一个没有底的球，比一个浅色的球更糟（AC1.5）。

### 2.3 删掉 `backdrop-filter`

```css
backdrop-filter: blur(24px) saturate(180%);
-webkit-backdrop-filter: blur(24px) saturate(180%);
```

**论证（不是「看着不对」）**：悬浮窗是 `transparent: true`（`src/main/overlay.ts:138`，
`backgroundColor: '#00000000'`），页面内 `html, body, #root` 全部
`background: transparent`（`skins.css:188-195`）。**页面里不存在任何可被采样的 backdrop**，
`backdrop-filter` 要么空操作，要么在透明窗口上把 backdrop-root 渲成一块浅色区域。

用户实测正是后者：`dark` 皮肤（`--bg: #101014` 深色，**解释不了**浅框）下看到
「黑球外套一圈浅色圆角框，白底很明显」，而 `backdrop-filter` 是**逐皮肤都存在**的，
与「哪个皮肤都能看到」吻合。

它无法履行注释宣称的职责，留着就是**一条会骗人的注释** —— 按项目纪律必须删。

⚠️ **`--ballshot` 拍不到「桌面 backdrop」，但拍得到方框**（2026-09-28 check 订正）：
`capturePage` 出的透明 PNG 不合成桌面，所以它**无法**用来判断「球有没有透出壁纸」；
但方框是**页面自己画在窗口内**的 alpha，而 capturePage 拍的正是 56×56 的窗口内容，
逐像素解码就看得见（数字见 §9.8）。原文写的「实拍不能作为这条的证据」只对 backdrop 那一问成立，
对方框那一问是错的。**AC1.4 的人工确认因此仍然值得做（它验的是屏幕合成，PNG 验不了），
但不再是「AI 侧取不到证据」。**

---

## 3. 标签：移到数字正下方 + 等宽

### 3.1 几何（先算再写）

盘内可用直径 = 环外缘直径 = `2 × 24.5 = 49px`（r=22 + stroke 5/2）。

- 数字 `.dot-value` 13px（`.small` 变体 10px），`line-height: 1`
- 标签 **8px** 等宽，`line-height: 1`
- 间距 `gap: 1px`

```
内容总高 = 13 + 1 + 8 = 22px   <   49px   ✓ 余 13.5px（上下一半各 6.75px）
```

**与上一任务对比**：旧方案塞在左下角，与环外缘只剩 **1.3px** 余量（design §6 当时就算出
「压环就退 8px」的预案）。下移到中列后 1.3px 的死结**消失**，且不再需要那个预案。

### 3.2 DOM 位置：改用 grid 行流，不再绝对定位

`.petball-fallback` 已经是 `display: grid; place-items: center`。SVG 是
`position: absolute; inset: 0`（`skins.css`），**不参与 grid 流**，所以：

```css
.petball.no3d .petball-fallback {
  grid-auto-flow: row;      /* 数字与标签竖排 */
  align-content: center;    /* 整组居中 */
  gap: 1px;
}
.petball.no3d .dot-winlabel {
  position: static;         /* 旧方案是 left:0;bottom:0 的绝对定位 */
  font-size: 8px;
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  letter-spacing: 0.04em;   /* 等宽下 5H 两个字符偏挤，补一点字距 */
  font-weight: 500;
  line-height: 1;
  color: var(--fg-dim);
}
```

**不再需要** `left/bottom/transform` 那一套。仍保留 `pointer-events: none`。

**光学居中**：整组居中会让数字**偏上** 5.5px。若实拍觉得高，
用 `padding-top: 2px` 微调（**只调这一个数，不动 gap**）。

### 3.3 字体

全项目只有一套 stack（`skins.css:198`，`-apple-system` 系 sans），无第二种字体观感。
标签内容是 `5H`/`W`/`M` —— **纯拉丁字符，不涉及中文字体回退**，直接上等宽栈即可。
`ui-monospace` 在 macOS 命中 SF Mono、Windows 命中 Consolas，缺失才退到 `monospace`。

---

## 4. 自动轮播：先走完窗口再换人

### 4.1 算法

```ts
const advanceAuto = useCallback((): void => {
  const n = s?.windows.length ?? 0
  if (n > 1 && winIdx + 1 < n) setWinIdx(winIdx + 1)   // 先在同一家里往后走
  else advanceProvider(1)                              // 走完了才换人（内部 setWinIdx(0)）
}, [s, winIdx, advanceProvider])
```

- 3 窗口供应商的自动序列：`0 → 1 → 2 → 换人且回 0`（`advanceProvider` 已含 `setWinIdx(0)`）
- 单窗口供应商：`n > 1` 不成立 → 直接换人（AC4.2，不空转）
- 充值余额供应商无环，但同样走这条路径（AC4.6，行为一致，不为视觉特殊-case）

### 4.2 ⚠️ 最容易踩的坑：**effect 重跑会把节奏冻死**

现有 effect（`PetBall.tsx:322-339`）deps 是 `[count, advanceProvider]`，两者都只随
`count` 变，所以 effect 体里的 `lastAdvance.current = Date.now()` **只在换人/挂载时跑一次**，
6 秒节奏成立。

`advanceAuto` 依赖 `s` 与 `winIdx` —— **每切一次窗口就是一个新函数**。若把它塞进 deps：

```
切窗口 → advanceAuto 变 → effect 重跑 → lastAdvance 归零 → 6 秒重新开始计
      → 永远走不到 6 秒 → 球再也不动了
```

**功能看起来「实现了」，实则完全静止**，而且单元测试很容易漏（要等 12 秒以上才看得出）。

⚠ **本节那条「球彻底静止」的推断已被实测推翻**（2026-09-28 check）。原文推断
「effect 重跑 → `lastAdvance` 归零 → 6 秒永远走不到 → 球再也不动了」**不成立**：
tick 是先把 `lastAdvance` 置成 `now`、**再**改状态，effect 紧接着重跑又置成同一个 `now`，
两者相差不到 1ms —— 节奏仍是 6 秒。实测两轮，分别把 `live.current.winIdx` 和一个
每渲染都变的量塞进 deps，**uitest 全绿、球照常推进**。
真实代价是另外两条：**定时器反复拆建**，以及「满 6 秒」的基准从「上次推进」漂成
「上次 effect 重跑」（数据刷新顺带改了 `count`/`s` 时，用户等的那一步被往后推）。
`live` ref 仍然是对的写法，但**理由要按实测写** —— `PetBall.tsx` 的注释已改。
这也意味着 `petCarouselRhythm` 守的不是「冻结」，而是「节拍持续推进」。

**解法（保留）：tick 内读 ref，不让 interval 因取值变化而重建。**

```ts
const live = useRef({ n: 0, winIdx: 0 })
live.current = { n: s?.windows.length ?? 0, winIdx }   // 每次渲染同步

useEffect(() => {
  if (count <= 1) return
  lastAdvance.current = Date.now()          // 只在 [count] 变化时初始化
  const t = window.setInterval(() => {
    const now = Date.now()
    if (now < holdUntil.current) return
    if (now - lastAdvance.current < AUTO_MS) return
    lastAdvance.current = now
    const { n, winIdx } = live.current     // ← 读 ref，不进 deps
    if (n > 1 && winIdx + 1 < n) setWinIdx(winIdx + 1)
    else advanceProvider(1)
  }, 1000)
  return () => window.clearInterval(t)
}, [count, advanceProvider])                // ← 保持不变
```

`advanceProvider` 自身只依赖 `count`，留在 deps 里是安全的。

### 4.3 红线「换人唯一入口」的调整

上一任务的红线是「`idx` 变化只允许发生在 `advanceProvider` 里」，本任务**不破坏**它：
`advanceAuto` 走窗口时**不碰 `idx`**，换人时仍然调 `advanceProvider(1)`。

红线**放宽一处**：`advanceProvider` 不再是「自动轮播的唯一出口」，
而是「**`idx` 的唯一出口**」。这个措辞变化要同步进 spec 与断言命名。

---

## 5. 对既有断言的冲击（必须处理，不能装作没有）

### 5.1 `petCarouselResetsWindow` 的语义**已被本任务作废**

上一任务该断言守的是「**自动轮播推进后窗口回到 0**」。R4 之后，多窗口供应商的自动
轮播**正确行为就是窗口往后走**，该断言**会把正确实现判成红的** —— 留着就是一条
**会误报的假护栏**，比没有更坏。

处理：**替换**为 `petCarouselOrder`，守新的完整序列：

```
自动推进的观测序列必须是 [win0, win1, win2, (换人) win0, …]
且换人那一刻的 winIdx 必须是 0
```

同时把上一任务 `implement.md` 批次表里 `petCarouselResetsWindow` 那条记录标注为
**已被本任务作废**（留痕，不删）。

### 5.2 `petBallRingDiag` / `petBallCenterValue` 不受影响

它们不读轮播位置以外的东西；但 `petBallCenterValue` 的夹具若依赖 `winIdx === 0`，
R4 之后自动轮播会离开 0 —— **实现时必须确认这两条断言在 `winIdx ≠ 0` 时仍成立**
（这是本任务最可能踩的回归面）。

---

## 6. QA 门

### 6.1 结构门（进 `scripts/test-structure.mjs` —— 它本来就是「静态读文件」的架构守卫）

判据一律作用于**生效声明**：先剥 `/* */`，再**按完整选择器**定位，最后**配平花括号**取整块。
三个坑都真实发生过（2026-09-28 check 逐个踩过并修进门里）：

- 块内那条解释 backdrop-filter 的**注释**必须留着（它是本任务最值钱的一条知识），
  所以「块内 grep 0 命中」是**永假**的判据；门只看生效声明。
- `background: var(--ball-bg)` 在选择器下方**第 18 行**，`grep -A14` 够不到 → 永真的假护栏。
- `grep petball-fallback` 的**首个命中**是 `:root` 里的一条注释；同尾选择器还有
  `.petball.no3d:has(.petball-hit:active) .petball-fallback`（按压态，不是底盘）。

| 门 | 判据 | 弄坏手法 → 实测红集 |
|---|---|---|
| `ball-surface-token` | 生效声明有 `var(--ball-bg)`、无 `--bg` 引用 | 改回 `var(--bg)` → {D1×2} |
| `ball-no-backdrop-filter` | 生效声明无 `backdrop-filter` | 加回真声明（注释仍在）→ {D2} |
| `ball-bg-defined-per-skin` | **顶层** `:root` + 5 个皮肤都有 `--ball-bg`/`--ball-rim` | 删任一处 → {D3 对应那条} |
| `winlabel-mono` | 声明了独立字体栈，**且不是 `inherit`、也不是 body 的 stack**；字号 ≤ 9px | 改 `inherit` → {D4 字体}；改 12px → {D4 字号} |
| `winlabel-not-absolute` | 生效声明的 `position` 不是 absolute/fixed | 退回 `absolute`+left/bottom → {D5} |
| `ball-no-outer-shadow`（**R5 补，2026-09-28 check**） | 底盘 `box-shadow` **逐层**都是 `inset`，且至少一层 | 加回 outer shadow → {D6}；整条删掉 → {D6} |

**D6 后来从「一个选择器」扩成「一类元素」（2026-09-28 check 第二轮）。**
`.petball-rename input` 被确认为**同一机理的第二实例**（用户拍板一并去掉），所以门的作用域
改成一张**宠物窗口满幅/溢幅元素**的表，逐个独立判：

```js
const PET_WINDOW_FULLBLEED = [
  ['.petball.no3d .petball-fallback', '球盘：56×56 = 球形态窗口 56×56（BALL_VIEW）'],
  ['.petball.no3d:has(.petball-hit:active) .petball-fallback', '球盘按压态：同一元素、同一尺寸'],
  ['.petball-rename input', '改名输入框：168×28 却活在 56×56 窗口里，20px 光晕照样铺满'],
  ['.petball-hit', '命中层：inset:0 = 整块窗口'],
  // ⚠ `.petball-debugring` 曾列在表里，理由「按投影上报的外接框 = 整个窗口」是**假的**：
  //   `PetBall.tsx:812` 写明它只可能是人物形态（球形态 w 恒为 0，压根不渲染），
  //   人物形态下也只是 213×293 里的一圈虚线。**门的前提不成立就不能进表。**
]
```

⚠ **`层数 > 0` 只对底盘提，不能推广到整张表**：改名输入框的**正确终态就是 0 层**
（一个投影都不许有），对它要求「层数 > 0」等于逼着人把阴影写回去。所以拆成两条：
4 条 `no-outer-shadow`（负向，带 `body != null` 前置防空洞）+ 1 条 `inset-3d`（正向，
只守底盘的 AC5.3）。**`body != null` 前置是必需的**：选择器一改名，取块失败会让
`outer.length === 0` 空洞地变绿 —— 批次 16 实测：改名框选择器一改，只有那一条红。

⚠ 两条**曾经是假护栏**、已修（记录在此，别退回去）：
1. 「`:root` 有定义」若不分层，暗色 `@media` 块里的 `:root, [data-skin='aero']` 会冒充顶层那份
   —— 删掉顶层 `--ball-rim` 门仍绿，而外部皮肤在**浅色**系统上恰恰只吃得到顶层那份。已按 `@media` 分层。
2. 「字体与 body 不同 stack」若只比**字面量**，`font-family: inherit` 会通过（字面量当然不同，
   解析结果却完全相同）—— 正是 AC3.3 要防的。已单列 `inherit` 判据。
3. 「box-shadow 是 inset」若只 `includes('inset')` 会放过 `inset …, inset …, 0 6px 18px rgba(…)`
   —— 而那**正是出事之前的那一行**。且切「层」必须按**顶层逗号**：`rgba(0,0,0,0.28)` 和
   `color-mix(in srgb, var(--ok) 18%, transparent)` 里都有逗号，裸切会切出假层 → 假红。
   层数为 0 时「没有非 inset 层」**空洞成立**，所以判据必须带 `层数 > 0`（同 D2/D5 的纪律）。

另加 2 条 D0 骨架门（按选择器确实取到了整块），否则上面几条会因「取块失败」而**空洞地通过**。

### 6.2 行为门（进 `src/main/qa/uitest.ts`）

| 断言 | 守什么 | 弄坏手法 |
|---|---|---|
| `petCarouselOrder` | 自动序列 `[0,1,2]` 后换人且回 0（替代作废的 `petCarouselResetsWindow`） | 把 `advanceAuto` 改回 `advanceProvider(1)` → 必红 |
| `petCarouselRhythm` | 走完窗口**不冻结**：连观 3 个窗口后仍在推进（**专打 §4.2 那个 effect 重跑陷阱**） | 把 `advanceAuto` 加进 effect deps → 必红（球静止） |
| `petWinLabelBelow` | 标签与数字**同列、数字在上**，且取值随窗口切换 | 删 `grid-auto-flow: row` → 必红 |
| `petBallSkinSurface` | 5 个皮肤下 `--ball-bg` 均已解析、非透明 | `:root` 去掉兜底 → 必红 |
| `petFigureUnchanged` | 人物形态 8 个确定性字段逐位不变（沿用上一任务） | — （基线比对） |

**「方框还在不在」是**可以**自动断言的**（2026-09-28 check 订正，原文说不能）：
方框是页面自己画在窗口内的 alpha，`--ballshot` 的透明 PNG 逐像素解码就看得见（§9.8）。
原文「它是桌面合成的结果，PNG 拍不到，AC1.4 只能人工看」把两件事混了：
**PNG 验不了的是「球有没有透出壁纸」，验得了的是「窗口内有没有方形 alpha」**。
所以纯白桌面上的肉眼确认仍然该做（它验屏幕合成），但它不再是唯一手段 ——
更不许用「拍出来颜色没变」搪塞：肉眼扫一张 112×112 的近全透明 PNG，看不出
「球外 100% 的像素都带 alpha」这件事。

---

## 7. 取舍与回退

| 决策 | 取舍 | 回退 |
|---|---|---|
| 球随皮肤变色（补 `--ball-bg`）而非恒深色 | 尊重 `--track` 逐皮肤设计，不动 15 个既有取值 | 改回恒深色需重调 3 令牌 × 5 皮肤 |
| 删 `backdrop-filter` | 失去「磨砂」观感 —— 但它在透明窗口上本就无法生效 | 想要磨砂得改成**主进程**侧合成，不是本任务范围 |
| 标签下移而非缩到更小 | 彻底解决 1.3px 余量死结 | 若实拍偏挤，退回 `font-size: 7px`（不动位置） |
| 自动轮播先走完窗口 | 多窗口供应商停留 3×6=18 秒 | 若嫌久，改成「走完但 3 秒一步」——只改 `AUTO_MS` 的分档 |
| 标签等宽 | 引入第二个字体栈（无新依赖，纯 CSS） | 回 `font-family: inherit` 即可 |

**回滚**：三项互相独立，可单独 revert。唯一跨项耦合是 §5.1 的断言替换 ——
若只回退 R4 而不回退 `petCarouselOrder`，uitest 会红（这是**正确的失败**，
不是要修的 bug）。

---

## 8. 兼容与文档

- 无新依赖、无新设置项、无新持久化键
- 外部皮肤（`ext:*`）不写 `--ball-bg` 时由 `:root` 兜底（AC1.5）
- 需同步：`README.md`（皮肤令牌表若列举球相关项）、`DESIGN.md`（表面令牌归属）、
  `CONTEXT.md`（若「球表面令牌」进统一术语）
- `.trellis/spec/frontend/component-guidelines.md` 的 §9「人物形态陷阱」清单**要加一条**：
  「`.petball-hit`/`.petball-fallback` 跨形态共用，视觉改动要问「这条规则在另一种形态下成立吗」」

---

## 9. 「球外面套一圈浅色方框」：三次误诊与真凶

> 这是本任务最有价值的一节。**同一个症状被归因错了三次**，每一次都「有证据」，
> 直到拿到能测屏幕合成的手段才定位到真凶。记录全过程是为了让下一个人不再重走。
> ⚠️ §9.3 / §9.5 / §9.7 里三处「拍不到 / macOS 按方形轮廓合成」的说法已在 §9.8 订正。

### 9.1 症状

用户实机报告：悬浮球外面套一圈**浅灰色圆角方框**，白底背景下非常明显。
用户补充两条决定性观察：**方框跟着球移动**、**颜色不随桌面背景变化**。

### 9.2 三次误诊（每一次都被自己的证据推翻）

| # | 假设 | 当时「支持它的证据」 | 怎么被推翻 |
|---|---|---|---|
| 1 | `backdrop-filter` 画出来的 | 注释写着「磨砂桌面背景」；用户皮肤是深色而方框是浅色，页面级 `--bg` 解释不了 | **删掉后方框仍在**（用户实机复测）。删除本身仍该做（透明窗口里没有 backdrop 可采样），但**归因是错的** |
| 2 | macOS 原生窗口层的圆角/底色 | 静态排查已排除页面 CSS、窗口阴影、vibrancy、debugring、半透明；窗口参数层是最后的剩余层 | 实测 `roundedCorners:false` + `setBackgroundColor('#00000000')` **方框仍在**，只是圆角从 9pt 变 6pt。这两处改动已**全部撤回** |
| 3 | 是「不随背景变的浅灰方框」，即窗口自带的**不透明**底 | 联立白底/深底两次测量解出「≈20% 不透明度的深灰 rgb(70)」 | **解方程的前提就错了**。那个「不随背景变」是用户的**视觉感受**，不是测量结论 —— 我拿它当约束去解方程，方程无解时就该怀疑前提 |

### 9.3 关键转折：拿到能测屏幕合成的手段

`screencapture` 在本机因缺 Screen Recording 权限只输出桌面图片、**略过所有窗口** ——
所以**前两轮连「方框到底有多大、什么颜色」都问不出来**。用户授权后，用「纯白全屏窗口打底 +
实屏抓屏 + 纯 Node 像素解码」才拿到可算的数字。

**教训（已进 spec 候选）**：「实拍没变化」不能当作「改对了」的证据；
**当一个症状无法被现有工具观测时，先解决观测手段，再谈归因**。

⚠️ **2026-09-28 check 订正**：这段把「拍不到」归给了 `capturePage`，那是**错的**（§9.8）。
真正的分界是：`capturePage` 拍不到**桌面合成**，但拍得到**页面自己画的 alpha** ——
方框就在后者里。所以前两轮不是「无法证伪任何假设」，而是**手里有证据却没去解码**。

### 9.4 定位过程

1. **复现**：把桌面壁纸临时设为纯白 → 白色方框稳定复现（深色壁纸上只差 6 级，所以之前量不到）
2. **量尺寸**：方框像素范围 = 屏幕 `x[1200..1255] y[300..355]`，**正好 56×56 pt = 窗口本身**，
   均色 `rgb(218,218,218)`，圆角 ≈9pt
3. **排原生**：CDP 注入 `box-shadow:none` / `background:transparent` 逐项二分，同一会话内连抓 5 张：

   | 注入 | 窗口顶缘 y=300 | 球心 y=328 |
   |---|---|---|
   | baseline | 253,252,252,251,251,250 | 118（暗球缘） |
   | **no-box-shadow** | **255,255,255,255,255,255** | 101（平盘） |
   | no-background | 253,252,252,251,251,250（不变） | 214→235（浅灰） |
   | no-both | **255,255,255,255,255,255** | 255,255,255 |

4. **结论**：元凶是 `.petball-fallback` 的 **outer `box-shadow: 0 6px 18px rgba(0,0,0,0.28)`**

### 9.5 机理

收起态窗口 = 56×56 = `.petball-fallback` 本身 56×56，**两者一样大，外阴影没有任何容身之处**。
但 outer shadow 仍被绘制：它是一团从 56×56 的圆扩散出去的模糊光晕，被 56×56 的窗口裁切，
于是**窗口内、圆外**的那四块（四个角）留在画面上；浅灰方框就浮在球外 ——
**形状是方的，尽管元素是 `border-radius:50%` 的圆**。
白底上 `rgba(0,0,0,0.28)` 的模糊衰减正好落在实测的 204–229 亮度区间。

⚠️ 原文这里写的是「把 alpha 轮廓填成方形，**macOS 便按这个方形轮廓合成**」。
§9.8 的 capturePage alpha 实测说明**这一步并不需要**：那团光晕是**页面自己**画进窗口的
（capturePage = 窗口内容，逐像素解码直接可见），**窗口把圆形光晕裁成方形**本身就已经
解释了全部现象。结论（真凶是 outer box-shadow）不受影响，但别再把「macOS 合成方轮廓」
当成必要的一环 —— 那会让人以为必须去原生窗口层找答案（误诊 #2 就是这么来的）。

### 9.6 修法

**删掉 outer box-shadow**，保留三条 inset（顶部发丝高光 / 盘缘 / 底部内阴影）。
立体感不靠外阴影 —— 实拍确认球在纯白与深底上都读作一个立体的圆盘。

**这不是「调参」，是删掉一个在当前窗口尺寸下物理上无处安放的声明。**

### 9.7 为什么 14 条 uitest 断言 + 10 条结构门都没抓到它

`--ballshot` 的透明 PNG **拍不到桌面合成**，而这正是唯一的观测面。
**这是取证手段的盲区，不是断言写得不够多** —— 所以补的护栏必须是**结构门**
（`.petball-fallback` 里不许出现任何非 inset 的 box-shadow，即 D6），而不是再加一条 uitest。

⚠️ **2026-09-28 check 订正**：本节把盲区说成「PNG 拍不到」，只对**桌面合成**成立。
**方框本身 PNG 拍得到**（§9.8）—— 所以更准确的说法是：
**观测面一直都在，缺的是「把 PNG 解成 alpha 去看」这一步**。
真要说盲区，是「肉眼扫一张 112×112 的近全透明图」这个**习惯**。
所以两条护栏都要：**结构门 D6**（防它再被写回去）**＋** 用 ballshot 的 PNG 逐像素解码验一次
（`scripts/lib/png-probe.mjs`，证明当下没有）。

### 9.8 复核补记（2026-09-28 check）：capturePage 拍得到，附实测数字

主会话用「纯白全屏窗口打底 + `screencapture` 实屏抓屏」定位并修掉了它，但那套流程需要
Screen Recording 权限。check 阶段复核时发现**不需要权限也能证伪**：`capturePage()` 拍的
就是 56×56 的**窗口内容**，方框是页面自己画的 alpha，逐像素解码直接可见。
仓里原本没有图像解码能力（且不引新依赖），所以补了 `scripts/lib/png-probe.mjs`
（纯 `zlib` + 手写 unfilter，约 90 行，只做 8 位非隔行 PNG → RGBA）。

⚠️ **量之前先定 DPR，否则数字全是假的**（2026-09-28 check 第二轮踩过）：
`capturePage()` 出的是 **2× 设备像素** —— 球形态 56 CSS → 112×112、展开态 384×600 →
768×1200。我第一版把 DPR 写成 `width / 112`（设备宽）得到 `dpr = 1`、`R = 28`，于是一份
**干净**的构建报出「球外 75.4% 的像素带 alpha、7236 个离沿 2px 外」这种明显不对的数字。
正确的除数是 CSS 尺寸（`BALL_VIEW.width = 56`），而唯一可信的自检是**数字必须与已知良好帧
吻合**：修好后 = 208/2688、最远半径 56.7px、离沿 2px 外 0 个。**量错不会报错，只会编数字。**

用 `--ballshot` 留下的修复前样本（`BD_SKINS=1`，11:30）与修复后重拍（13:50）对比，
**5 个皮肤的数字完全一致**：

| | 球外（离圆心 > 56px）alpha>0 的像素 | alpha>0 的最远半径 | 离球沿 2px 外仍带 alpha |
|---|---|---|---|
| 修复前 | **2688 / 2688 = 100%** | **78.5px**（窗口对角线 79.2，球盘半径仅 56） | 2132 |
| 修复后 | 208 / 2688 = 7.7% | 56.7px（球沿 0.7px 抗锯齿） | **0** |

「球外 100% 的像素都带 alpha、四角被填满、轮廓到窗口对角线为止」= 用户看到的方框，
在 PNG 里一直是**可测的**；只是这张图肉眼看去近乎全透明，从来没人去解码。

**同机理扫了一遍 skins.css 的全部 outer box-shadow**（窗口 = 元素的组合才算同机理）。
⚠️ **下面这张表在 2026-09-28 check 第二轮被逐行复验并订正了三处**，原文的错误结论留着比
删掉更坏，所以订正写在同一格里：

| 元素 | 所在窗口 | outer shadow | 实测结论（2026-09-28 check 第二轮复核） |
|---|---|---|---|
| `.petball-fallback` | 56×56 球 | 已删 | 修前 100% 方框 → 修后仅抗锯齿。**本轮 5 个皮肤 + 2 张 `5-ball` 复拍，独立复现出同一组数字**（208/2688、最远 56.7px、离沿 2px 外 0 个） |
| `.petball-rename input` | **56×56 球** | ~~`0 6px 20px rgba(0,0,0,0.35)`~~ → **已删** | **原文判「属产品取舍，未改」是错的，已订正**：12544/12544 = 100% 带 alpha，与底盘**完全同机理**；判据不是「这个投影是不是有意画的」，而是「元素盒子是否等于/大于窗口」。**用户 2026-09-28 拍板一并去掉** |
| `.petball-bubble` | 56×56 球 | **本来就没有** | ⚠️ **原文写 `0 6px 20px …` 是不实记录**：`git log -S` 显示这条只出现在 `63aa291` 新增的 `.petball-rename input` 上，`.petball-bubble` 从未有过 box-shadow（HEAD 与工作区都没有） |
| `.petball-caption` | 213×293 人物 | `0 2px 10px rgba(0,0,0,0.22)`（**合法**） | 胶囊要靠投影在任何壁纸上读得清，且 `max-width:140px` 装在 213 宽的窗口里，左右各留 57px。⚠️ **原文「四条窗口边全 0 alpha，干净」不准确**：实测**下缘**确实带 alpha —— 最后一行 alpha `1..20`、横跨 `x 58.5..153.5`（正是胶囊盒 `x 65..148` 向下 2px、横向外扩 ~8px 的投影），即阴影被窗口下缘裁了一道。左/右/四角仍是 0，**不构成方框**，但记录要改 |
| `.petball-bubble` / `.petball-rename`（容器，无阴影） | 213×293 人物 | 无 | 干净 |
| `.card` | 384×600 展开 | **无 box-shadow**（独立复核确认） | 干净：16px 圆弧之外 0 个像素带 alpha，四角点 `0/0/0/0` |
| `.pcard` / `.hero` / `.dot.lvl-*` / `.btn-primary` / `.field :focus` / `.switch .knob` | 384×600 展开 | 各种 | ⚠️ **原文的理由「都由 padding/margin 内缩，从不等于窗口尺寸」经实测不成立**：`.pcard` 的右边框在 `x ≈ 369.5`，384 宽的窗口里**只剩 14px 余量**；`.pcard.dragging`（`var(--shadow-pop), 0 14px 30px`，暗色皮肤 36+30px 模糊）的压暗带一路走到 **`x = 383` 窗口最后一个像素都没有退回底色** —— 阴影**确实被窗口边界裁了**。结论（不该动）不变，但**保护来自别处**，见下 |

**展开态真正的保护是 `.card`，不是那些阴影本身。** `.card` 是 `width:100%; height:100%`
（即窗口本身）+ `border-radius:16px` + `overflow:hidden`，且**自己没有 box-shadow**，于是所有
后代的墨迹溢出（含 box-shadow）都被裁进**圆角矩形**内。像素证据（`1-card.png` 与
`8-drag-preview.png` 两帧一致）：右缘 alpha 轮廓**对称收口** —— x=370 → 行 `0..600`，
x=376 → `2..598`，x=382 → `8..592`；**圆角矩形之外 0 个像素带 alpha**。对照球形态修复前
那是 100% 一路铺到窗口对角线。

⚠️ **由此得到一条尚未加门的潜藏风险**：谁把 `.card` 的 `overflow:hidden` 去掉、或把圆角
设成 `0`，展开态就会长出同样的方框。护栏该加在 `.card` 上（须有 `overflow:hidden`、
圆角 ≠ 0、无 own box-shadow），但**本任务的作用域是宠物窗口，未加，如实记录**。

结论：**真凶是 `.petball-fallback`（已修）**，**`.petball-rename input` 是同一机理的第二实例
（用户拍板已修）**，两处都由 D6 的 `no-outer-shadow` 守住；展开态因 `.card` 的圆角裁剪而不受影响，
但那条保护目前没有门。
