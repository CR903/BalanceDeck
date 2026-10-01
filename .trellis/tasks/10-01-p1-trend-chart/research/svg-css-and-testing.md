# Research: SVG 绘制惯例 / 测试落点 / CSS 规范

- **Query**: components.tsx 的 Ring 怎么画 SVG？有无可复用的坐标/轴/网格？项目里有没有轻量图表？测试 fixture 哪些可复用？纯函数放哪个文件？skins.css 的图表/列表 class 与配色 token？
- **Scope**: internal
- **Date**: 2026-10-01

---

## 1. 现有 SVG 绘制惯例（Q4）

### 1.1 全仓 SVG 只有三处，全是 `<circle>` / `<path>`，**没有折线/坐标轴/网格**

`grep -rn "viewBox|<svg|polyline|<path d=" src/renderer/src/*.tsx` 的结果：

| 文件 | 行号 | 内容 |
|---|---|---|
| `components.tsx` | 14-27 | `Ring`：两个 `<circle>`（track + fill） |
| `components.tsx` | 220-233 | `Icon`：24×24 `viewBox`，`stroke="currentColor"` |
| `PetBall.tsx` | 853-866 | 收起态小圆环：两个 `<circle>` |
| `ProviderMark.tsx` | 15 | 字符串模板注入的第三方 SVG |

**结论：项目里没有任何坐标轴、网格线、刻度、`<polyline>`、`<rect>` 柱、
`getTotalLength()` 路径测长的先例。** 趋势图要从零写坐标换算。

### 1.2 Ring 的写法（唯一值得复用的形状惯例）

```tsx
// src/renderer/src/components.tsx:8-31
export function Ring({ pct, lvl, size = 68, stroke = 6, dim = false }: { pct: number; lvl: Level; size?: number; stroke?: number; dim?: boolean }): React.JSX.Element {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const clamped = Math.min(100, Math.max(0, pct))
  return (
    <div className={`ring lvl-${lvl}${dim ? ' dim' : ''}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} aria-hidden="true">
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
        <circle
          className="ring-fill"
          cx={size / 2} cy={size / 2} r={r}
          strokeWidth={stroke} fill="none" strokeLinecap="round"
          strokeDasharray={`${(c * clamped) / 100} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="ring-text">{fmtPercent(clamped)}</span>
    </div>
  )
}
```

可复用的五条惯例：

1. **`aria-hidden="true"`**（`:14`）—— 无障碍层不存在（`component-guidelines.md:188-206`
   说明这是透明置顶窗口的架构选择），纯装饰 SVG 一律 `aria-hidden`。
2. **钳位在前**：`const clamped = Math.min(100, Math.max(0, pct))`（`:11`），
   `Bar`/`MiniBar` 也是同一句（`:36`、`:44`）。趋势图的 y 值必须照做。
3. **颜色靠 class 不用 inline**：`className="ring-fill"` + `lvl-${lvl}` 外层
   （`:13`），stroke 由 CSS 给（`skins.css:661-665`）。趋势图同理。
4. **`size` 有默认值 + 数字 props**（`size = 68, stroke = 6`）——
   `component-guidelines.md:95-96` 规定「可选 prop 必须带默认值解构」。
5. **`Icon` 的 `viewBox="0 0 24 24"` + `stroke="currentColor"` + `fill="none"`
   + `strokeWidth={1.8}`**（`:220-231`）：这是**描边式图标**规范，
   图表的网格线/坐标轴应该走同一套（`stroke="currentColor"` 让 CSS 的
   `--fg-faint` 自动接管颜色）。

### 1.3 PetBall 的第三层判据（趋势图空态的先例）

```tsx
// src/renderer/src/PetBall.tsx:845-852
{/* 环的三层判定（缺一层就少画一层，不合并成一个大布尔）：
    L1 只有**套餐**（plan）供应商有环 …
    L3 填充弧才需要 pct：算不出比例就没有弧，绝不画 0% 的假弧（数据诚实） */}
{s && isPlan(s) && (
  <svg viewBox="0 0 56 56" aria-hidden="true">
```

**「没有数据就不画，不画 0% 的假弧」**是本仓反复出现的纪律
（`usagePredict.ts:31-33`、`component-guidelines.md:226-234`）。
趋势图的数据不足态必须遵守同一条。

### 1.4 无障碍层的实际情况

`component-guidelines.md:188-206`：窗口是 `frame:false, transparent: true,
alwaysOnTop` + `contextIsolation: true`，点击穿透由**主进程**决定
（`ipc.ts:278-284`）。`role`/`aria-*` 不会改变行为。
新增控件给 `title`（它兼任 `--uitest` 选择器），不要引入 ARIA 层。

---

## 2. 测试落点（Q6）

### 2.1 现有两个测试文件

| 文件 | 加载的源码 | 覆盖 |
|---|---|---|
| `scripts/test-usage-store.mjs` | `src/main/usageStore.ts` + `src/shared/usage-predict.ts` | 落盘格式 / 分桶 / 裁剪 / 损坏重建 / 机制守卫 |
| `scripts/test-usage-predict.mjs` | `src/renderer/src/usagePredict.ts` + `src/shared/usage-predict.ts` | 斜率 / 切段 / 可信度 / predictAll / 文案 / 纯度 |

两者都用 `loadTs`（`scripts/lib/load-ts.mjs:26-39`）跑**真源码**，
`package.json:31-32` 注册为 `test:usage-predict` / `test:usage-store`，
并在 `test` 总链里（`package.json:33`）。

### 2.2 `test-usage-store.mjs` 可复用的 fixture

```js
// scripts/test-usage-store.mjs:43-68
const HOUR = 3600_000
const DAY = 24 * HOUR
const T0 = 1_700_000_000_000
/** 与 usageStore 的 dayKey 同一个本地日构造器 */
function dayAt(offsetDays, hour = 12) {
  const d = new Date(T0)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays, hour).getTime()
}
function dayKeyOf(t) { /* 同 dayKey */ }
/** 一个临时目录 + 一个绑定到它的 store */
function withStore(fn) { /* mkdtemp + createUsageStore + finally rm */ }
const pt = (providerId, window, pct, t) => ({ providerId, window, pct, t })
```

⚠ `dayAt` / `dayKeyOf` 是**与 `usageStore` 的 `dayKey` 等价的本地实现**
（`:46` 注释直说）。趋势图测试若要按天分桶断言，可复用 `dayAt` 造数据、
`dayKeyOf` 造期望键。

已有的「多天数据」造法范例：

```js
// scripts/test-usage-store.mjs:130-139
const pts = []
for (let i = 39; i >= 0; i--) pts.push(pt('go', '本月', i, dayAt(-i)))
store.appendBatch(pts, dayAt(0), DEFAULT_RETENTION_DAYS)
const r = store.loadRecent('go', DEFAULT_RETENTION_DAYS, dayAt(0))
ok(r['本月'].length <= DEFAULT_RETENTION_DAYS, ...)
```

⚠ 但这造的是**每天 1 个点**。趋势图测试要的是**每天 96 个点**
（15 分钟粒度），需要按 `SNAPSHOT_INTERVAL_MS` 内层再循环一层。

### 2.3 `test-usage-predict.mjs` 可复用的 fixture

```js
// scripts/test-usage-predict.mjs:79-101
const HOUR = 3600_000
const T0 = 1_700_000_000_000
const ISO = '2026-09-29T00:00:00.000Z'
/** 第 i 个点的百分比；step 是相邻两点的百分点差（默认 +10） */
const series = (pcts, { step = HOUR, t0 = T0 } = {}) =>
  pcts.map((pct, i) => ({ t: t0 + i * step, pct }))
const win = (o = {}) => ({ name: '本月', used: 0, limit: 100, unit: 'usd', ...o })
const snap = (o = {}) => ({ id: 'go', name: 'Go', kind: 'coding', builtin: true, status: 'ok', windows: [], updatedAt: ISO, ...o })
const plan = (pct, o = {}) => snap({ windows: [win({ used: pct, limit: 100, percent: pct, ...o })] })
const cfg = (o = {}) => ({ ...DEFAULT_PREDICT_CONFIG, ...o })
const pctOf = (list, winName) => list.find((p) => p.windowName === winName) ?? null
```

⭐ **`series()` 是最直接可复用的** —— 它已经支持 `{ step, t0 }`，
15 分钟粒度写成 `series(pcts, { step: 15 * 60_000 })` 即可（`:218` 就是这么用的）。

⭐ **672 点真实体量的先例**（趋势图 7 天视图的同一体量）：

```js
// scripts/test-usage-predict.mjs:126-129
// 真实体量：15 分钟采样 × 7 天 = 672 个点，每步涨 2/672 个百分点
const week = series(Array.from({ length: 672 }, (_, i) => (i * 2) / 672))
near(slopePerHour(week), 2 / 672, 0.0001, 'A8 真实体量（672 点 / 7 天）斜率准确')
```

**重置点序列**（趋势图 5H 锯齿的现成 fixture）：

```js
// scripts/test-usage-predict.mjs:133-136
// Bad 案例：7 天窗口，序列中 97 → 0 是窗口重置
const resetSeries = series([95, 97, 0, 12, 25, 38])
eq(lastMonotonicRun(resetSeries).map((p) => p.pct), [0, 12, 25, 38], 'B1 按向下跳变断开，取最后一段')
```

**多窗口 fixture**：

```js
// scripts/test-usage-predict.mjs:261-269
const twoWin = snap({
  windows: [win({ name: '本周', used: 40, limit: 100, percent: 40 }), win({ name: '本月', used: 80, limit: 100, percent: 80 })]
})
const twoPred = predictAll(twoWin, { 本周: series([10,20,30,40,45], {step:HOUR}), 本月: series([40,55,70,80], {step:HOUR}) }, T0 + 4*HOUR, cfg())
```

**余额类 fixture**（趋势图若要测余额空态）：

```js
// scripts/test-usage-predict.mjs:246-247
const balance = snap({ id: 'cash', kind: 'balance', windows: [{ name: '账户余额', used: 42, unit: 'cny' }] })
eq(predictAll(balance, { 账户余额: good }, T0, cfg()), [], 'E10 余额类 → 空数组')
```

### 2.4 纯函数该放哪个文件 —— `hook-guidelines.md` 的规则

**「这个仓库没有自定义 hook，一个都没有。」**
（`.trellis/spec/frontend/hook-guidelines.md:5-8`）：

> The single most important fact: **there are no custom hooks. None.**
> `grep -E "(function|const|export (function|const))\s+use[A-Z]" src/` → no matches.
> Every hook call is inline in a component body.

项目的答案不是 hook，而是**一个纯函数模块**（`hook-guidelines.md:10-27`）：

> If you find yourself writing the same hook logic twice, the project's answer is **a plain pure
> function module**, not a hook. … That choice is deliberate: pure-function modules are directly
> unit-testable in Node, and hooks are not.

现成范例：`read-model.ts`、`pet3d/gesture.ts`、`usagePredict.ts`、`history.ts`。

**推荐落点：新增 `src/renderer/src/usageTrend.ts`**，理由：

| 判据 | 依据 |
|---|---|
| 纯函数（无 React / 无 DOM / 无 electron），`loadTs` 可直跑 | `usagePredict.ts:19-20` 的文件头就是这条 |
| `now` 由调用方传入，不读自己的钟 | `usageStore.ts:26`（H5 守卫）、`usagePredict.ts:19` |
| 不新增 hook | `hook-guidelines.md:5-8` |
| 与 `usagePredict.ts` 同目录同形状 | `test-usage-predict.mjs` 的 `loadTs('src/renderer/src/usagePredict.ts')` 可原样复制 |

**不推荐放 `usagePredict.ts`**：那个文件的文件头（`:16-33`）把职责写死为
「预计耗尽时刻」的估算；趋势图是另一件事，混进去会让两者的纪律互相干扰
（预测要 `lastMonotonicRun` 切段，趋势图不能切）。

**跨进程契约放哪**：若需要新常量（如 `TREND_DEFAULT_DAYS = 7`），
放 `src/shared/usage-predict.ts`（`shared/usage-predict.ts:1-17` 说明这是
唯一能让「一处定义、三处引用」的位置，且 `tsconfig.node.json` 与
`tsconfig.web.json` 两边都 include）。若纯渲染层专用，就放 `usageTrend.ts`。

**新测试脚本**：`scripts/test-usage-trend.mjs`，
照抄 `test-usage-predict.mjs:17-35` 的加载头（`loadTs` + `eq`/`ok`/`near` 断言器）。
需在 `package.json` 加 `"test:usage-trend"` 并挂进 `test` 总链（`:33`）。

### 2.5 `test-usage-store.mjs` 的机制守卫会拦什么

H 段（`:241-265`）是**负向源码断言**，如果改动 `usageStore.ts` 会连带影响：

```js
ok(!/from '\.\/keystore'/.test(storeCode), 'H1 usageStore 不 import keystore')
ok(!/getExtra|setExtra|secrets\.bin/.test(storeCode), 'H2 usageStore 不碰 extras')
ok(!/from 'electron'/.test(storeCode), 'H4 usageStore 不 import electron')
ok(!/Date\.now\(|new Date\(\s*\)/.test(storeCode), 'H5 不读自己的钟')
```

⚠ **H5 尤其关键**：趋势图的「今天是哪一天」绝不能在 `usageStore` 里算 ——
必须由 `now` 参数传入。若方案 B（新增 IPC 返回分桶）在 `usageStore` 里分桶，
分桶函数**也必须吃 `now`**。

⚠ `test-structure.mjs` 的 F6 段（`:549-573`）会扫描
`src/renderer/src/*.{ts,tsx}` 的**全部文件**，禁止 `ttsSecretRef|getTtsSecret`
与 `Authorization|Bearer`。新增文件自动被纳入扫描（无害，但别写这些词）。

---

## 3. CSS 惯例（Q7）

### 3.1 文件契约

```css
/* src/renderer/src/skins.css:1-5 */
/* ═══ BalanceDeck — 设计系统
   令牌驱动：所有组件消费语义变量；皮肤 = 覆盖令牌（新增皮肤零代码）。
   风格：macOS 原生质感 —— 克制的层次、克制的色彩、克制的动效。 */
```

**一个样式表，`main.tsx:4` 导入一次**（`component-guidelines.md:110-115`）。
令牌解析在 `.app` 上而不是 `body`（`skins.css:202-204`）。

### 3.2 可用于图表的配色 token（`skins.css:10-30` 亮色 / `:65-90` 暗色）

| Token | 亮色值 | 用途（现有先例） |
|---|---|---|
| `--accent` | `#0a84ff` | 强调 / 主色（`.tag.saved`） |
| `--accent-soft` | `rgba(10,132,255,.14)` | 淡背景 |
| `--ok` | `#30d158` | 正常（`.bar-fill`、`.ring-fill` 默认） |
| `--warn` | `#ff9f0a` | 警告（`.lvl-warn`） |
| `--danger` | `#ff453a` | 危险（`.lvl-danger`） |
| `--track` | `rgba(120,120,128,.18)` | **轨道/槽**（`.bar` 底、`.ring-track`） |
| `--fg-dim` | `rgba(60,60,67,.62)` | 次要文字 |
| `--fg-faint` | `rgba(60,60,67,.36)` | **三级文字 / 轴标签的天然选择** |
| `--surface` / `--border` | — | 卡片面 / 描边 |

⭐ **`--track` 已被定义为「轨道」语义**（`skins.css:661` `.ring-track { stroke: var(--track) }`、
`skins.css:687` `.bar { background: var(--track) }`）—— 图表的网格线/轴线用
`--track` 或 `--fg-faint` 都有先例。
⭐ **`--fg-faint` 是刻度标签的天然选择**（`.section-title` 用它，`skins.css:846`）。

### 3.3 图表颜色：`lvl-${Level}` 三档映射

```css
/* src/renderer/src/skins.css:661-682 */
.ring-track { stroke: var(--track); }
.ring-fill  { stroke: var(--ok); transition: stroke-dasharray 480ms var(--ease), ... }
.ring.lvl-warn   .ring-fill { stroke: var(--warn); }
.ring.lvl-danger .ring-fill { stroke: var(--danger); }
.ring.lvl-muted  .ring-fill { stroke: var(--fg-faint); }
```

```css
/* src/renderer/src/skins.css:684-703 */
.bar       { height: 5px; border-radius: 3px; background: var(--track); overflow: hidden; }
.bar-fill  { height: 100%; border-radius: 3px; background: var(--ok); transition: width 480ms var(--ease), ... }
.bar-fill.lvl-warn   { background: var(--warn); }
.bar-fill.lvl-danger { background: var(--danger); }
.bar-fill.lvl-muted  { background: var(--fg-faint); }
```

**推荐：趋势图的颜色沿用 `lvl-${Level}`**，
`Level` 来自 `format.ts:55`（`'ok' | 'warn' | 'danger' | 'muted'`），
判定用 `levelOfPercent`（`format.ts:58-64`，阈值 ≥85 danger / ≥60 warn）。
这是 `component-guidelines.md:168-174` 列的**三种严重度拼写**里的第一种，
且是 `Ring`/`Bar`/卡片/详情页共用的那一种。

### 3.4 class 命名：widget 前缀，非 BEM

`component-guidelines.md:151-166`：**「松散的 widget 前缀惯例，不是 BEM」**，
全仓没有 `__element` 或 `--modifier`。

| 前缀 | 归属 |
|---|---|
| `dwin-` | 详情页窗口（`DetailView.tsx`） |
| `model-` | 详情页模型表 |
| `wmodels-` | 窗口内的模型表 |
| `predict-` | 详情页预测行（P0-2） |
| `petball-` / `pcard-` / `prow-` / `pet-` / `pmark-` | 其他 |

⭐ **`predict-` 是本任务最贴近的先例** —— 它就是 P0-2 在同一个文件里新建的
一族 class（`skins.css:855-879`）。趋势图建议 `trend-` 前缀：

```css
/* src/renderer/src/skins.css:855-879 —— predict 族的完整写法 */
/* 用量预测行（P0-2）。视觉刻意贴着 .dwin 的形状：它回答的是与「用量窗口」
   同一批问题（这个窗口还能用多久），形状不同会让用户以为它属于别的模块。 */
.predict-list { display: flex; flex-direction: column; gap: 6px; }
.predict-row  { display: flex; align-items: baseline; gap: 8px; padding: 9px 12px;
                border-radius: var(--radius-md); background: var(--surface);
                border: 1px solid var(--border); }
.predict-win  { font-size: 12.5px; font-weight: 600; flex: none; }
.predict-text { font-size: 11.5px; color: var(--fg-dim); line-height: 1.45; }
```

⚠ `skins.css:855-856` 那条注释值得逐字读：「视觉刻意贴着 `.dwin` 的形状」。
趋势图是新形态，但**卡片外壳应沿用 `.predict-row` 的形状**
（`--radius-md` + `--surface` + `--border`），否则会读成别的模块。

### 3.5 列表类 grid 惯例

```css
/* src/renderer/src/skins.css:1016-1067 */
.model-list { display: flex; flex-direction: column; border-radius: var(--radius-md);
              background: var(--surface); border: 1px solid var(--border); overflow: hidden; }
.model-row   { display: flex; align-items: center; gap: 10px; padding: 9px 12px; font-size: 12px; }
.model-row + .model-row { border-top: 1px solid var(--border); }
.model-pct   { flex: 0 0 auto; min-width: 42px; text-align: right;
               font-variant-numeric: tabular-nums; font-weight: 600; color: var(--fg-dim); }
```

⭐ **`font-variant-numeric: tabular-nums` 是所有数值列的硬惯例**
（`.ring-text`、`.model-amount`、`.model-pct`、`.model-tokens`、
`.hero-amount`、`.dwin-value` 都有）。趋势图的 y 轴刻度标签必须带。

⭐ **`flex: 0 0 auto; min-width: Npx; text-align: right`** 是数值列的三件套
（`.model-pct` 用 42px，`.model-tokens` 用 66px）。

### 3.6 排版尺度（可直接抄的字号梯度）

| 用途 | 值 | 先例 |
|---|---|---|
| section 标题 | `11px` / `600` / `uppercase` / `letter-spacing: .06em` / `--fg-faint` | `.section-title`（`:841-847`） |
| 卡片主数值 | `22px` / `680` / `tabular-nums` / `letter-spacing: -.02em` | `.hero-amount`（`:820-826`） |
| 列表主文本 | `12.5px` / `600` | `.dwin-name`、`.predict-win` |
| 列表副文本 | `11.5px` / `--fg-dim` / `line-height: 1.45` | `.predict-text`、`.hero-sub` |
| 徽标 | `10px` / `600` / `padding: 1px 6px` / `border-radius: 5px` | `.tag`（`:1278-1284`） |

⭐ **`<em className="tag env">本机历史估算</em>` 是数据来源标注的现成写法**
（`DetailView.tsx:325` + `skins.css:1289-1292`：`.tag.env { background: var(--surface-sunken);
color: var(--fg-dim); }`）。趋势图的「本机历史」标注照抄这个。

### 3.7 动效

`--ease: cubic-bezier(0.32, 0.72, 0, 1)` / `--dur: 200ms`（`skins.css:62-63`）。
现有图表动效：`480ms var(--ease)`（`.ring-fill`、`.bar-fill` 的
`stroke-dasharray` / `width` 过渡）。趋势图可沿用 `480ms`。

### 3.8 ⚠ 死区：不要在那里写新规则

`component-guidelines.md:366-371`：

> ### Don't: extend the dead pet CSS
> `skins.css:2105-2366`（262 行）targets the removed SVG-sprite pets
> （`mochi`/`shiba`/`dino`/`penguin`/`slime`）；`.dot-badge` and `.dot-btn.stale` likewise.
> **Do not write new rules in that region.**

新 class 写在 `.predict-*` 附近（`skins.css:879` 之后）或 `.model-*` 附近。

---

## 4. 汇总建议

| 项 | 建议 | 依据 |
|---|---|---|
| 组件文件 | `src/renderer/src/usageTrend.tsx`（渲染）+ `usageTrend.ts`（纯函数）或同文件导出纯函数 | `component-guidelines.md:12-23` 一屏一文件；`hook-guidelines.md:10-27` 纯函数模块 |
| 纯函数落点 | `src/renderer/src/usageTrend.ts`（分桶 + 坐标换算），不塞 `usagePredict.ts` | `usagePredict.ts:16-33` 职责已写死 |
| SVG 写法 | `aria-hidden` + `viewBox` + `stroke="currentColor"` + 颜色走 `lvl-${Level}` class | `components.tsx:14-27`、`:220-231` |
| 坐标换算 | 纯函数，`now` 由调用方传入 | `usageStore.ts:26` H5 守卫 |
| 空态 | 数据不足/余额类**不画**，不画 0% 假图 | `PetBall.tsx:845-852` L3、`usagePredict.ts:31-33` |
| CSS 前缀 | `trend-`，卡片外壳沿用 `.predict-row` 形状 | `skins.css:855-879`、`:855-856` 注释 |
| 颜色 | `--track`（轨道/网格）+ `--fg-faint`（刻度）+ `lvl-${Level}`（数据） | `skins.css:661-682`、`:841-847` |
| 数值排版 | `font-variant-numeric: tabular-nums`（硬惯例） | `skins.css:1052-1057` 等 6 处 |
| 测试 | 新建 `scripts/test-usage-trend.mjs`，复用 `series()` / `snap()` / `win()` / `dayAt()` | `test-usage-predict.mjs:79-101`、`test-usage-store.mjs:43-68` |
| 测试体量 | 7 天 = 672 点已有先例 | `test-usage-predict.mjs:126-129` |
| 接线 | `package.json` 加 `test:usage-trend` 并挂进 `test` 总链 | `package.json:31-33` |

---

## 相关文件

| 文件 | 作用 |
|---|---|
| `src/renderer/src/components.tsx:8-31` | Ring（唯一 SVG 数据可视化先例） |
| `src/renderer/src/components.tsx:218-235` | Icon（描边式 SVG 规范） |
| `src/renderer/src/PetBall.tsx:845-866` | 空态三层判据 |
| `src/renderer/src/format.ts:55-64` | `Level` / `levelOfPercent` |
| `src/renderer/src/skins.css:661-703` | `lvl-${Level}` 颜色映射 |
| `src/renderer/src/skins.css:838-879` | `.section` / `.predict-*` 区块 |
| `src/renderer/src/skins.css:1016-1067` | `.model-*` 列表 grid |
| `src/renderer/src/skins.css:10-63` | 令牌定义 |
| `scripts/lib/load-ts.mjs:26-39` | `loadTs`（跑真源码） |
| `scripts/test-usage-predict.mjs:79-101` | 可复用 fixture（`series`/`snap`/`win`） |
| `scripts/test-usage-store.mjs:43-68` | 可复用 fixture（`dayAt`/`withStore`/`pt`） |
| `scripts/test-usage-store.mjs:241-265` | 机制守卫 H 段（改 usageStore 会碰） |
| `scripts/test-structure.mjs:549-573` | F6 扫描全部渲染层文件 |
| `.trellis/spec/frontend/hook-guidelines.md:5-27` | 无自定义 hook；纯函数模块 |
| `.trellis/spec/frontend/component-guidelines.md:151-182` | class 命名 / 死区警告 |
| `.trellis/spec/frontend/quality-guidelines.md:1-46` | 无 linter/CI；loadTs 纪律 |
