# Research: 详情页插入点 / 聚合口径 / 时间轴分桶

- **Query**: DetailView 里「每模型用量表」在第几行？趋势图插在哪？多窗口画哪个？各窗口 pct 量纲是否可比？分桶在渲染层还是 IPC？
- **Scope**: internal
- **Date**: 2026-10-01

---

## 1. 详情页结构与插入点（Q2）

### 1.1 「每模型用量表」= `DetailView.tsx:355-382`

**精确位置：`DetailView.tsx:355`**，`{hasModels && (...)}` 块。完整 JSX：

```tsx
// src/renderer/src/DetailView.tsx:355-382
{hasModels && (
  <section className="section">
    <div className="section-title">
      {s.models![0]?.source === 'console' ? '模型明细 · 控制台每月' : '模型明细 · 本机 30 天'}
    </div>
    <div className="model-list">
      {s.models!.map((m) => (
        <div className={`model-row${m.source === 'console' ? ' console' : ''}`} key={`${m.model}-${m.cost}`}>
          <span className="model-name" title={m.model}>{m.model}</span>
          <span className="model-amount">
            {fmtAmount(m.cost, 'usd')}
            {m.quota != null && m.quota > 0 && (
              <span className="model-quota"> / {fmtAmount(m.quota, 'usd')}</span>
            )}
          </span>
          {m.percent != null && <span className="model-pct">{fmtPercent(m.percent)}</span>}
          {m.tokens > 0 && (
            <span className="model-tokens">
              {m.source === 'console' ? '服务端' : '本机'} {fmtAmount(m.tokens, 'token')}
            </span>
          )}
        </div>
      ))}
    </div>
  </section>
)}
```

⚠ **术语澄清**：PRD 说的「每模型用量表」在代码里有**两个**：

| 名称 | 位置 | 标题 | 数据源 |
|---|---|---|---|
| **详情页级**「每模型明细」 | `DetailView.tsx:355` | `模型明细 · 控制台每月` / `模型明细 · 本机 30 天` | `s.models` |
| 窗口内嵌的「每模型明细」（可展开） | `DetailView.tsx:135-167` `WindowModels` | `模型 / 用量·配额 / %` 表头 | `s.modelsByWindow[w.name]` |

PRD 字面「每模型用量表上方」→ 按 `DetailView.tsx:355` 理解 = **趋势图区块插在
`{hasModels && ...}` 之前**。

### 1.2 详情页从上到下的 section 顺序（全部实测行号）

| 顺序 | 行号 | section | 条件 |
|---|---|---|---|
| — | 292 | `<QualityBanner>` | 总在 |
| 1 | 295-314 | `<section className="hero lvl-…">` 环形仪表 | `s.status==='ok' && hero` |
| 2 | 321-336 | `<section>` 预计耗尽（预测列表） | `predictions.length > 0` |
| 3 | 338-353 | `<section>` **用量窗口**（`.dwin-list`） | `s.windows.length > 0` |
| 4 | **355-382** | `<section>` **模型明细**（`.model-list`） | `hasModels` |
| 5 | 384-387 | `<section className="section meta">` 数据来源 | 总在 |

### 1.3 插在 355 之前 vs 塞进「用量窗口」section（339-353）

**代码里已有一条现成的先例判据** —— 预测区块的注释：

```tsx
// src/renderer/src/DetailView.tsx:316-320
{/* ── 用量预测（P0-2）────────────────────────────────────────
    放在 hero 环形仪表之后、窗口列表之前：环形仪表答「现在用了多少」，
    这一行答「按现在的速度还够用多久」，两个问题挨着答最省用户的心智切换。
    逐窗口各一条（5H / W / M 的速率不同，混成一条是错的 —— design.md D5），
    文案由 buildPredictionText 独家生成（含「估算」字样，AC3）。 */}
```

现有 section 的粒度惯例是 **`<section>` = 一个用户问题**（`.section` 只有
`margin-bottom: 14px`，`skins.css:838-840`；标题靠 `.section-title`
`skins.css:841-847`）。

**塞进「用量窗口」section 的问题**：那个 section 的结构是
`<div className="section-title">用量窗口</div>` + `<div className="dwin-list">`（两行），
`dwin-list` 是 `flex-direction: column` 的窗口卡列表（`skins.css:848-852`）。
把图表塞进去要么加第三个子节点破坏「标题 + 列表」的两段式，要么套一层卡片再嵌一层列表卡片
（`.predict-row` 与 `.dwin` 的形状刻意一致 —— `skins.css:855-856` 的注释说
「视觉刻意贴着 .dwin 的形状」）→ 三层嵌套。

**结论：独立 `<section>`，插在 `DetailView.tsx:355` 之前（即 353 `}` 与 355 `{hasModels` 之间）**，
与「预计耗尽」section 平级。

### 1.4 若要做 7/30 天切换

- **不要改 `App.tsx`**（约束）。切换状态放在 `DetailView` 或趋势图组件内部。
- 现成的同款 UI：`VoiceReminderSection.tsx:929-948` 有一组 `vrs-predict-days` /
  `vrs-predict-retention` 的数字选择控件，但那是设置页布局，样式不通用。
- 更轻的做法：`win-chip` 系列（`skins.css:586-600`，带 `.on` / `.lvl-warn` 状态）已在
  详情页之外的卡片上用作时限切换。

---

## 2. 聚合口径（Q3）

### 2.1 各窗口 pct 的量纲：**同一量纲，可叠画**

所有窗口的 `pct` 都来自**同一个函数** `windowPercent`（`shared/percent.ts:14-20`），
输出恒被钳在 `0..100`（`percent.ts:19`）：

```ts
return roundPercent(Math.max(0, Math.min(100, raw)))
```

`pct` 的语义在契约里写死：

```ts
// src/shared/usage-predict.ts:30-35
/**
 * 该窗口的用量百分比。
 * **不可知 = null，绝不填 0**
 */
pct: number | null
```

→ 三条线的 y 值都落在 `[0, 100]` 的「该窗口已用百分比」，**量纲一致、可叠画**。

### 2.2 但「叠画」有一个语义陷阱：窗口长度不同

| 窗口名 | 周期 | 重置频率 |
|---|---|---|
| `5 小时` | 5 小时滚动块 | 每 5 小时（7 天重置 **33 次**） |
| `本周（7天）` | 滚动 7 天 | 每 7 天 |
| `本月` | 自然月 / 滚动 30 天取大 | 每月 |

`usagePredict.ts:70-79` 的注释把这件事讲透了：

> 5H 窗口 7 天里重置 33 次，整段回归等于把 33 个负跳变均摊进斜率。

对**折线图**来说这不是斜率问题而是**锯齿问题**：5H 线在 7 天视图上会出现 33 次
垂直跌落（100→0）。**这不是数据错误，是窗口语义的真实反映** —— 但用户看到
一条上下颠倒的锯齿线，很可能读成「图表坏了」。

`lastMonotonicRun`（`usagePredict.ts:85-93`）**不能直接复用**：它是给回归找
「当前这一段」的，趋势图要的是**完整序列**（重置点本身就是信息）。

### 2.3 主窗口的选法：复用 `read-model.ts`

```ts
// src/renderer/src/read-model.ts:15-24
/** 卡片 / 详情页的主窗口：第一个带限额的窗口，否则第一个 */
export function primaryWindowIndex(s: ProviderSnapshot): number {
  if (s.windows.length === 0) return 0
  const i = s.windows.findIndex((w) => w.limit != null && w.limit > 0)
  return i >= 0 ? i : 0
}
export function primaryWindow(s: ProviderSnapshot): ProviderWindow | undefined {
  return s.windows[primaryWindowIndex(s)]
}
```

`DetailView.tsx:267` 已经在用它算 hero 环形仪表（`const hero = primaryWindow(s)`）。
`read-model.ts:4-13` 的注释明确「**一个**回答『哪个窗口重要』的地方」，
三个视图都必须从这里取答案 —— 趋势图选主窗口**必须**走 `primaryWindow`，
不能自己写 `s.windows[0]`。

⚠ 注意 `primaryWindowIndex` 对套餐返回第一个带 limit 的窗口；对**余额类**返回 0
（余额窗口无 limit）。若沿用 `isPlan` 闸门（推荐，见下），余额不会走到这里。

---

## 3. 时间轴聚合（Q5）

### 3.1 问题的准确表述

- 磁盘格式**本身按天分桶**：`{ days: { 'YYYY-MM-DD': { providerId: DayPoint[] } } }`
  （`usageStore.ts:50-53`，注释 `usageStore.ts:16-17`）
- `loadRecent` **主动拍平**了天层（`usageStore.ts:163-175` 遍历 `f.days` 后 push 进同一个数组）
- 一天的量级：15 分钟采样 × 24 = **96 点/窗口/天**
  - 7 天 × 1 窗口 = **672 点**（`usagePredict.ts:36` 注释也用这个数）
  - 30 天 × 3 窗口 = **8640 点**

### 3.2 两个方案的取舍

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 渲染层分桶** | 复用 `usagePredict(providerId, 30, now)` 拿 8640 点，渲染层按天 groupBy | IPC 传 8640 个 `{t, pct}` 对象（结构化克隆，量级约 200-400KB JSON）；渲染层要跑一次 8640 次的 reduce |
| **B. 新增 IPC 返回分桶结构** | 新增 `usage:trend` 或给 `usage:predict` 加参数，返回 `{ 'YYYY-MM-DD': number }` | 改 `ipc.ts` + `preload` + `usageStore`（新增方法）+ `shared` 契约；触碰面更大 |

**方案 A 的实际代价比看起来小**：分桶是一次 O(n) reduce，8640 个点的 reduce 在
渲染层是亚毫秒级；IPC 传的是 `JSON.parse` 后的对象（`loadRecent` 已经从 `cache` 读，
**不重新读盘** —— `usageStore.ts:101-117` 的 `load()` 有 `cache` 短路）。

方案 B 的代价在**改动面**：`usageStore` 的 `UsageStore` 接口
（`usageStore.ts:55-64`）要加方法，且 `test-usage-store.mjs` 的 H 段机制守卫
（`test-usage-store.mjs:241-265`）会因为源码变化需要复核。

### 3.3 `dayKey` 已经存在，但**不在渲染层**

```ts
// src/main/usageStore.ts:68-75
/** 本地时区的 `YYYY-MM-DD`。用本地日而不是 UTC 日：用户的心智是「今天」 */
function dayKey(t: number): string {
  const d = new Date(t)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
```

⚠ 它**没有导出**（`usageStore.ts:70` 的 `function dayKey`，不是 `export function`）。
若在渲染层分桶，需要一份等价实现 —— 这是 `quality-guidelines.md:24-46`
「不要把实现内联复制到测试里」那条纪律的镜像：在**产品代码**里写第二份
`dayKey` 就是同一个漂移风险的变体。

`cutoffDayKey`（`usageStore.ts:84-87`）用的是**日历减法**而不是 `now - n*86400_000`，
注释说明理由：跨夏令时会差一小时（`usageStore.ts:80-82`）。渲染层若自己算
「今天往前推 7 天」必须照抄这个日历减法写法。

### 3.4 分桶的语义选择

一天 96 个点，画成「每天一根柱」需要选一个代表值：

| 选项 | 定义 | 风险 |
|---|---|---|
| 当日**末值** | 每天最后一个有效 pct | 若当天最后一次采集 `status!=='ok'`，末值是旧的 |
| 当日**均值** | 有效点算术平均 | 与「已用百分比」的直觉不符（百分比不是可加量） |
| 当日**峰值** | 最大值 | 高估，且 5H 窗口重置会污染 |
| **每天一根柱 = 当日末值** | — | 与「窗口现在用了多少」的语义最接近 |

⚠ 缺失值纪律：`pct: null` 的点**不计入任何统计，也不能填 0**
（`type-safety` 第 2 条；`usagePredict.ts:22-24` 与 `history.ts:10-12` 都重申）。
若某天全为 null → **该天不画柱**（留空），而不是画一根 0 柱
（0 柱会被读成「这天没用」，见 `usagePredict.ts:31-33` 的同一论据）。

---

## 结论

| 问题 | 答案 |
|---|---|
| 插入点 | `DetailView.tsx:355`（`{hasModels && ...}`）**之前**，独立 `<section>`，与「预计耗尽」平级。不塞进「用量窗口」section。 |
| 画哪个窗口 | 主窗口 → `primaryWindow(s)`（`read-model.ts:22`）独家，勿自写 `windows[0]`。 |
| 是否可叠画 | **量纲可比**（都经 `windowPercent` 钳到 0..100），可同图叠画。但窗口长度不同（5H 每天重置）→ 7 天视图上 5H 线是锯齿。**建议每窗口一条 + 窗口切换**，或只画主窗口。 |
| 分桶在哪 | **推荐渲染层**（方案 A）：复用现有 `usage:predict`，分桶是一个可单测的纯函数，`usageStore` 零改动、IPC 零新增。 |
| dayKey | 需在渲染层有一份；必须照抄 `usageStore.ts:84-87` 的**日历减法**，不能用 `now - n*86400_000`（夏令时）。 |

---

## 需要澄清的问题

1. **单窗口还是多窗口叠画？** 量纲可比，但 5H 线的锯齿可能误导。
   折中：只画主窗口（`primaryWindow`），窗口切换控件让用户自己切。
   —— 这与 `.predict-row` 的「逐窗口各一行」（`DetailView.tsx:328-333`）是两种形态。

2. **一根柱 = 当日末值 / 均值 / 峰值？** 推荐末值（语义最接近「这个窗口用了多少」）。
   若选均值，需要在 PRD 里写明「日均用量百分比」而不是「日用量」。

3. **7 天与 30 天是否共用一次 IPC？** 若共用，只能按 `retentionDays`（默认 30）
   取一次，然后在渲染层切 7/30 天 —— 省一次往返但每次都传 30 天的量。
   若分开请求，切换时多一次 IPC 但传输量小。

4. **`predictOn` 关掉时趋势图还显不显示？** 见 `data-path-and-balance.md` 的问题 3
   —— 趋势图不是「预计耗尽」，共用开关会让语义不符。

---

## 相关文件

| 文件 | 作用 |
|---|---|
| `src/renderer/src/DetailView.tsx:355-382` | 每模型用量表（PRD 的插入目标） |
| `src/renderer/src/DetailView.tsx:338-353` | 用量窗口 section（不建议塞进去） |
| `src/renderer/src/DetailView.tsx:316-336` | 预计耗尽 section（位置与注释先例） |
| `src/renderer/src/read-model.ts:15-24` | `primaryWindow` 独家 |
| `src/shared/percent.ts:14-20` | `windowPercent` 钳 0..100 |
| `src/main/usageStore.ts:44-53` | 磁盘格式（天分桶） |
| `src/main/usageStore.ts:68-87` | `dayKey` / `cutoffDayKey`（未导出） |
| `src/main/usageStore.ts:158-180` | `loadRecent`（拍平天层） |
| `src/main/usageStore.ts:39` | `SNAPSHOT_INTERVAL_MS` = 15 分钟 |
| `src/shared/usage-predict.ts:64-70` | 样本量门槛常量 |
