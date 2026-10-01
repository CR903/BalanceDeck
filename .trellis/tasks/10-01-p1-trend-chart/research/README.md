# Research: P1-1 详情页 7/30 天用量趋势图（实现前调研）

- **Query**: 详情页在「每模型用量表」上方展示 7/30 天用量趋势图（轻量 SVG，不引入图表库），
  数据来自 P0-2 已落盘的本机快照
- **Scope**: internal
- **Date**: 2026-10-01
- **约束**: 改动限于 `DetailView.tsx` + 新增趋势图组件 + 可能的 IPC 扩展；**不碰 `App.tsx`**；不改任何代码

---

## 详报告

| 文件 | 覆盖的问题 |
|---|---|
| [`data-path-and-balance.md`](./data-path-and-balance.md) | Q1 快照读回路径 / IPC 链路 / 余额类可用性 |
| [`detailview-insertion-and-aggregation.md`](./detailview-insertion-and-aggregation.md) | Q2 插入点 / Q3 聚合口径 / Q5 时间轴分桶 |
| [`svg-css-and-testing.md`](./svg-css-and-testing.md) | Q4 SVG 惯例 / Q6 测试落点 / Q7 CSS 规范 |

---

## 速答表

| # | 问题 | 结论 |
|---|---|---|
| 1 | 走哪条 IPC | **现有的 `usage:predict` 就够**（`ipc.ts:374` → `preload/index.ts:98`）。它返回的是**原始历史** `Record<窗口名, UsagePoint[]>`，`predictAll` 才是渲染层的加工。**不需要新增通道**。 |
| 1 | 要余额类历史吗 | **不需要，且数据不支持**。窗口名只有 `'账户余额'` 与 `'账户额度'`，`windowPercent` 实测分别是 **恒 `null`** 与 **恒 `0`**。磁盘上根本没有余额金额（`UsagePoint` 只有 `t`+`pct`）。 |
| 2 | 插入点 | `DetailView.tsx:355` 的 `{hasModels && ...}` **之前**，独立 `<section>`。不塞进「用量窗口」section（那会破坏它的「标题 + dwin-list」两段式）。 |
| 3 | 画哪个窗口 | 主窗口 → **`primaryWindow(s)`**（`read-model.ts:22`）独家，勿自写 `windows[0]`。 |
| 3 | pct 量纲可比吗 | **可比**。所有窗口的 pct 都经 `windowPercent` 钳到 `[0,100]`（`percent.ts:19`），语义统一为「该窗口已用百分比」。但 5H 窗口每 5 小时重置（7 天锯齿 33 次），叠画易误读。 |
| 4 | SVG 惯例 | 全仓只有 `Ring`（`components.tsx:14-27`）与 `PetBall` 小圆环，**都是 `<circle>`，没有折线/坐标轴/网格先例**。可复用：`aria-hidden` + `viewBox` + `stroke="currentColor"` + `lvl-${Level}` 上色 + 钳位在前。 |
| 5 | 分桶在哪 | **推荐渲染层**。复用现有 IPC，分桶是一个可单测的纯函数。理由见下。 |
| 6 | 测试落点 | 纯函数 → **新增 `src/renderer/src/usageTrend.ts`**（`hook-guidelines.md:5-27`：本仓零自定义 hook，答案是纯函数模块）。测试 → 新建 `scripts/test-usage-trend.mjs`，复用 `series()` / `snap()` / `win()` / `dayAt()`。 |
| 7 | CSS | 前缀 `trend-`（widget 前缀，非 BEM）。卡片外壳沿用 `.predict-row` 形状。色板：`--track`（网格）+ `--fg-faint`（刻度）+ `lvl-${Level}`（数据）。数值一律 `tabular-nums`。 |

---

## 三个决定性发现

### ① 余额类的 pct 实测为 `null` / 恒 `0` —— 趋势图不做余额

`loadTs('src/shared/percent.ts')` 跑真源码：

| 窗口 | 输入 | `windowPercent` |
|---|---|---|
| 通用余额 | `{ name:'账户余额', used:1288.5, unit:'cny' }` | **`null`** |
| 账户额度 | `{ name:'账户额度', used:0, limit:120, unit:'usd' }` | **`0`** |
| 套餐 5 小时 | `{ name:'5 小时', used:40, limit:100, unit:'usd' }` | `40` |

余额窗口**确实在被采样落盘**（`scheduler.ts:132` 没有 kind 过滤，只过滤 `status !== 'ok'`），
但 `UsagePoint` 只有 `pct`，采样时 `w.used`（金额）**被丢掉了**。
→ 若将来要余额趋势（金额下降曲线），需扩展跨进程契约 `UsagePoint` 加 `used`，
并改 `scheduler` 采样。**超出本任务范围**（PRD 只说「用量趋势」）。

### ② `usage:predict` 是无差别的历史读取通道 —— 「只在套餐请求」是渲染层的选择

```ts
// src/main/ipc.ts:374-380 —— 不看 kind，逐字段复验后直接 loadUsageHistory
ipcMain.handle('usage:predict', async (_e, providerId, days, now) => { ... })
```

```tsx
// src/renderer/src/DetailView.tsx:243-246 —— 余额不请求
const planish = !!s && isPlan(s)
const predictions = usePredictions(s, planish ? now : 0, predictOn, predictConfig)
```

趋势图若走 `usagePredict` 这条通道，**自己在渲染层守 `isPlan` 闸门**即可
（`predictAll:238` 是第二道，可作参照）。

### ③ 分桶放渲染层更划算

| 维度 | A. 渲染层分桶 | B. 新增 IPC 返回分桶结构 |
|---|---|---|
| 磁盘读 | **无额外 IO** —— `load()` 有 `cache` 短路（`usageStore.ts:101-103`） | 同 |
| IPC 传输 | 8640 个 `{t,pct}`（30 天 × 3 窗口 × 96 点/天），约 200-400KB | 30 个 `{day, pct}`，约 2KB |
| 渲染层计算 | 一次 O(n) reduce（亚毫秒） | 无 |
| **改动面** | **0**（`usageStore` / `ipc.ts` / `preload` 全不动） | `UsageStore` 接口 + `ipc.ts` + `preload` + `shared` 契约 |
| **测试影响** | 新建一个测试文件 | **触发 `test-usage-store.mjs` H 段机制守卫复核**（`:241-265`） |
| 复用 | 可与 `usePredictions` **共用同一次 IPC** | 独立通道 |

**推荐 A**，核心理由是**改动面**：约束已限定在 `DetailView.tsx` + 新增组件，
A 方案下后端零改动。

⚠ 若走 A，渲染层需要一份 `dayKey`。`usageStore.ts:70` 的 `dayKey` **没有导出**，
且 `cutoffDayKey`（`:84-87`）刻意用**日历减法**而非 `now - n*86400_000`
（注释：跨夏令时会差一小时，`:80-82`）。渲染层若自己算「今天往前推 7 天」
**必须照抄日历减法**。

---

## 推荐方案

### 改动清单（不碰 `App.tsx`）

```
新增  src/renderer/src/usageTrend.ts     纯函数：dayKey / 按天分桶 / 坐标换算 / 阈值
新增  src/renderer/src/usageTrend.tsx    TrendChart 组件（轻量 SVG）
新增  scripts/test-usage-trend.mjs       纯函数测试（复用现有 fixture）
改    src/renderer/src/DetailView.tsx    插入 section + 复用/扩展取数 hook
改    src/renderer/src/skins.css         trend-* class（写在 :879 之后，勿进 :2105-2366 死区）
改    package.json                       加 test:usage-trend 并挂进 test 总链
```

**后端零改动** —— 不新增 IPC，不改 `usageStore`，不碰 `App.tsx`。

### 数据流

```
DetailView
  └─ useUsageHistory(providerId, days, now)     ← 扩展现有 usePredictions，或独立 hook
       └─ window.api.usagePredict(id, days, Date.now())   ← 现有 IPC
       └─ setLoaded({ id, points })             ← 带 providerId 防错配（DetailView.tsx:46-50 的纪律）
  └─ primaryWindow(s) → 主窗口名                 ← read-model.ts:22
  └─ bucketByDay(points[hero.name], now, days)   ← usageTrend.ts 纯函数
  └─ <TrendChart buckets days={days} />         ← usageTrend.tsx
```

### 必须遵守的既有纪律（各带 file:line）

| 纪律 | 依据 |
|---|---|
| 取回的历史**连着 providerId 一起存**，id 对不上当没有 | `DetailView.tsx:46-50`（曾把 A 家的斜率配 B 家的窗口） |
| 依赖数组**不挂 `now`**（30s 钟会让它每圈重发一次 IPC） | `DetailView.tsx:42-44`、`:83-85` |
| 请求失败/卸载 → **清空**而不是保持原状 | `DetailView.tsx:74-79` |
| async effect 用 **`live`/`cancelled` 守卫** | `hook-guidelines.md:161-174` |
| `pct: null` **不填 0**；某天全 null → **该天不画柱** | `shared/usage-predict.ts:30-35`、`usagePredict.ts:31-33` |
| 数据不足 → **不画**，不画 0% 假图 | `PetBall.tsx:845-852` L3 |
| 纯函数**不读自己的钟**，`now` 由调用方传入 | `usageStore.ts:26`（H5 守卫 `test-usage-store.mjs:254`） |
| 主窗口**必须**走 `primaryWindow` | `read-model.ts:4-13`「一个回答哪个窗口重要的地方」 |
| 文案含**数据来源标注** | `DetailView.tsx:325` `<em className="tag env">本机历史估算</em>` |
| 数值排版 `font-variant-numeric: tabular-nums` | `skins.css:1052` 等 6 处硬惯例 |
| 新 class 不写进死区 | `skins.css:2105-2366`（`component-guidelines.md:366-371`） |

### 复用清单（不要重写）

| 可复用 | 位置 |
|---|---|
| `primaryWindow(s)` | `read-model.ts:22-24` |
| `windowPercent` / `levelOfPercent` / `Level` | `percent.ts:14`、`format.ts:58`/`:55` |
| `isPlan` | `shared/quality.ts:27` |
| `fmtPercent` | `format.ts:9` |
| `series()` / `snap()` / `win()` / `plan()` 测试 fixture | `test-usage-predict.mjs:84-99` |
| `dayAt()` / `dayKeyOf()` 测试 fixture | `test-usage-store.mjs:47-56` |
| `loadTs` | `scripts/lib/load-ts.mjs:26-39` |
| `eq`/`ok`/`near` 断言器 | `test-usage-predict.mjs:38-77` |

---

## 需要澄清的问题

### 阻塞级（建议先拍板再动手）

1. **一根柱代表什么？**
   每天 96 个点。候选：末值（推荐，语义最接近「这个窗口用了多少」）/
   均值（百分比不可加，会被误读）/ 峰值（高估且被 5H 重置污染）。
   **影响**：类名、轴标题、测试断言。

2. **单窗口还是多窗口？**
   量纲可比可叠画，但 5H 线在 7 天视图上是 33 次垂直跌落的锯齿
   （`usagePredict.ts:70-79` 描述同一现象）。三条：
   - (a) 只画主窗口 + 窗口切换控件
   - (b) 三窗口同图叠画 + 图例
   - (c) 三窗口同图但只画当前选中的一条（与 (a) 同成本）
   **倾向 (a)** —— 与 `.predict-row`「逐窗口各一行」的既有形态一致。

3. **7 天与 30 天共用一次 IPC 吗？**
   共用只能按 `retentionDays`（默认 30）取一次，传输 30 天量，切 7/30 天纯前端；
   分开请求则切换时多一次 IPC 但传输小。**影响**：`DetailView` 的取数 hook 结构。

4. **`predictOn` 关掉时趋势图还显示吗？**
   `ui:predictOn` 的语义是「预计耗尽」（`VoiceReminderSection.tsx:916-917`
   的 title 明说），趋势图不是预计耗尽。
   `usePredictions` 在 `on === false` 时**根本不请求**（`DetailView.tsx:67`）——
   复用这个 hook 会让趋势图一起消失。
   **影响**：是否要把 `usePredictions` 拆成「取数 hook」+「两个消费方」。

### 非阻塞级

5. **趋势图是否受 `hasModels` 条件约束？**
   PRD 说插在「每模型用量表」上方，但趋势图本身不需要 `s.models` 存在。
   挂在 `{hasModels && ...}` 之后还是并列？（建议**并列**，包在 `{isPlan(s) && ...}` 里。）

6. **`predictOn` 与趋势图的开关是否要在 UI 上分开表述？**
   若共用一个开关，趋势图的「本机历史」标注会与预测的「本机历史估算」视觉混淆。

7. **数据不足的门槛是多少？**
   `MIN_POINTS_FOR_RATE = 4`（`shared/usage-predict.ts:64`）是速率的门槛。
   趋势图要几天数据才画？一个点画不出趋势；7 天 × 96 点 = 672 点时
   每根柱有 96 个样本支撑。

---

## Caveats

- `loadRecent` 的 `days` 参数经 `keepDaysOf`（`usageStore.ts:90-93`）钳到
  `MAX_RETENTION_DAYS = 365`，传 30 安全。
- 趋势图如果按 `predictConfig.retentionDays` 取数，注意它**不是 `ui:predictConfig` 里的值**，
  权威键是 `sample:usageHistoryDays`（`shared/usage-predict.ts:120-121`、`App.tsx:438-440`），
  且 `DetailView` 拿到的 `predictConfig.retentionDays` 是 App 侧的另一份状态。
- `usageStore` 的 `load()` 抛错时**静默重建为空**（`:112-114`），
  渲染层会拿到 `{}` → 空态，不是报错态。
- `qa/uitest.ts:299-300` 的详情页断言只查 `.card.detail` / `.dwin` / `.empty-state`，
  插入新 section **不会破坏** `--uitest` 的现有断言。
- `test-structure.mjs:59-66`（C1）与 `:549-573`（F6）会扫描
  `src/renderer/src` 的**全部** `.ts/.tsx` —— 新增文件自动纳入，
  别在其中出现 `ttsSecretRef|getTtsSecret|Authorization|Bearer`（无实际风险，仅提示）。
