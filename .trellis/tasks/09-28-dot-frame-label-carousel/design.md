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

⚠️ **`--ballshot` 拍不到它**：`capturePage` 出的透明 PNG 不合成桌面 backdrop，
所以实拍**不能**作为这条的证据。必须另做**真实白底桌面复现**（AC1.4）。

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

⚠ 两条**曾经是假护栏**、已修（记录在此，别退回去）：
1. 「`:root` 有定义」若不分层，暗色 `@media` 块里的 `:root, [data-skin='aero']` 会冒充顶层那份
   —— 删掉顶层 `--ball-rim` 门仍绿，而外部皮肤在**浅色**系统上恰恰只吃得到顶层那份。已按 `@media` 分层。
2. 「字体与 body 不同 stack」若只比**字面量**，`font-family: inherit` 会通过（字面量当然不同，
   解析结果却完全相同）—— 正是 AC3.3 要防的。已单列 `inherit` 判据。

另加 2 条 D0 骨架门（按选择器确实取到了整块），否则上面几条会因「取块失败」而**空洞地通过**。

### 6.2 行为门（进 `src/main/qa/uitest.ts`）

| 断言 | 守什么 | 弄坏手法 |
|---|---|---|
| `petCarouselOrder` | 自动序列 `[0,1,2]` 后换人且回 0（替代作废的 `petCarouselResetsWindow`） | 把 `advanceAuto` 改回 `advanceProvider(1)` → 必红 |
| `petCarouselRhythm` | 走完窗口**不冻结**：连观 3 个窗口后仍在推进（**专打 §4.2 那个 effect 重跑陷阱**） | 把 `advanceAuto` 加进 effect deps → 必红（球静止） |
| `petWinLabelBelow` | 标签与数字**同列、数字在上**，且取值随窗口切换 | 删 `grid-auto-flow: row` → 必红 |
| `petBallSkinSurface` | 5 个皮肤下 `--ball-bg` 均已解析、非透明 | `:root` 去掉兜底 → 必红 |
| `petFigureUnchanged` | 人物形态 8 个确定性字段逐位不变（沿用上一任务） | — （基线比对） |

**「白框真的消失了吗」无法用自动化断言回答** —— 它是**桌面合成**的结果，
`--ballshot` 的透明 PNG 拍不到（§2.3）。**AC1.4 只能人工看**：
把球拖到纯白背景上肉眼确认。这一条**不许用「拍出来颜色没变」搪塞**。

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
