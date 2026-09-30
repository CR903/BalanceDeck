# Design: P0-2 用量预测与预计耗尽时间

## 现状基线（实现前必须知道的三件事）

这一节不是背景介绍，是**三条会直接决定设计形状**的实测结论。

### B1 · 现有历史存储**不能**复用，但**口径**要沿用

`src/renderer/src/history.ts` 的 `HistoryPoint` 只有四个字段：

```ts
interface HistoryPoint { t: number; id: string; balance: number | null; percent: number | null }
```

两处硬伤，都不是「加个字段」能解决的：

| 硬伤 | 事实 | 后果 |
|---|---|---|
| **不分窗口** | `percent` 存的是 `maxPercent(s)`（**最紧张那个窗口**的百分比） | 5H / W / M 三个窗口在存储层就已经被压成同一个数。分窗口预测拿不到数据 —— 要改就得改 `appendPoint` / `statsFor` / `lastSeen` / `checkTriggers` 四个消费方，动 TTS 的地基 |
| **量级根本不够** | `DEFAULT_HISTORY_CAP = 100`（`ui:ttsHistoryCap`），采集间隔默认 60s | 100 × 60s ≈ **100 分钟**。7 天速率估算需要 ≈ **10080** 个点，差两个数量级 |

**决策**：**不复用** `HistoryPoint`，新建独立的快照存储 `UsageSnapshot`（分窗口、有时间戳、按天分桶）。
但**沿用它的纪律**：缺失值保持 `null` 绝不填 0（type-safety.md 第 2 条），样本不足返回 `null` 而非硬算（AC10 宁漏不误报）。

理由：TTS 历史的**消费者**（异常检测 / 长时间未使用）语义是「最近 N 次采样的滚动窗口」，要的是**近期**；
预测要的是「跨天的消耗趋势」，要的是**长程**。两者共用一个数组就必然有一方被 cap 砍掉 ——
把 TTS 的 cap 从 100 提到 10080 会让 `ui:ttsHistory` 这个 JSON 涨到几百 KB 且每 60s 全量重写（见 B2），
把预测的数据塞进 TTS 数组则会让异常检测的「近期均值」被 7 天前的数据拖偏。**分开存，共享纪律。**

### B2 · 走 `extras` 存快照会每 60s 全量重写一个渐大的 JSON

`src/main/store.ts` 的 `setExtra` 每次调用都 `persist()` → `writeFileSync(filePath(), JSON.stringify(cache))`
（`store.ts:60-64`），即**全量重写整个 secrets.bin**。

30 天 × 60s × N 供应商的分窗口快照，量级估算（N=5 供应商、每轮 3 窗口）：

| 保留期 | 点数/供应商 | 序列化体积 | 每 60s 全量重写 |
|---|---|---|---|
| 30 天 @ 60s | 43200 | ≈ 8–12 MB | **每天 ~200GB 写盘** |
| 30 天 @ 15min 采样 | 2880 | ≈ 600 KB | 每天 ~1.4GB 写盘 |

两者都不可接受。所以快照**不能**走 extras。

**决策**：新增**独立存储模块** `src/main/usageStore.ts`，落盘到 `app.getPath('userData')/usage-history.json`，
**增量写**（只追加当天的分桶，见 D3），并**按天分桶**存储（`{ '2026-09-30': { <providerId>: Snapshot[] } }`）。
顺带解决第二个问题：`extras:set` 对非 `ui:` 键会**触发全量重采集**（`ipc.ts:218-223`），快照每秒级的写入绝不能走那条路。

### B3 · 采样频率必须降级到「分钟级」，不能沿用 60s

采集默认 60s（`scheduler.ts:21`），但**消耗速率**不需要秒级精度，且 60s 采样在 30 天保留期下体积不可接受（见 B2）。

**决策**：快照**按独立频率**采样（默认 15 分钟，可配），复用 scheduler 的采集结果但**不跟随每次采集**。
判据：15 分钟粒度对「按当前速率预计何时用完」完全够用（7 天 = 672 个点，拟合斜率的相对误差 < 5%），
而体积降到 1/60。

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  main/usageStore.ts  ← 快照的唯一持久化所有者（不进 extras）      │
│  · appendBatch(points, now)   增量写，只追加当天分桶              │
│  · loadRecent(providerId, days)  读回最近 N 天，裁剪保留期          │
│  落盘：userData/usage-history.json  { 'YYYY-MM-DD': { id: Point[] } }│
└───────────▲────────────────────────────────────────┬───────────┘
            │ 每次采集后按采样间隔判定是否记一点          │ loadRecent
            │                                        ▼
┌───────────────────────────┐        ┌──────────────────────────────┐
│  main/scheduler.ts        │        │  renderer/usagePredict.ts    │
│  collect() 的 finally 里   │        │  纯函数（loadTs 可测）        │
│  sampleUsageHistory()     │        │  · ratePerHour(points)       │
│  （不新增网络请求）         │        │  · estimateExhaustionAt(...) │
└───────────────────────────┘        │  · confidenceOf(...)         │
                                     │  · buildPredictionText(...)  │
                                     └──────────────┬───────────────┘
                                                    │ Decision.predictions
                                                    ▼
                                     ┌──────────────────────────────┐
                                     │  DetailView.tsx（套餐类才显示）│
                                     │  环形仪表下方 / 窗口行         │
                                     │  「按近 7 天速率估算，约 3 天后│
                                     │   用完 · 缓存数据估算」        │
                                     └──────────────────────────────┘
```

## Technical Decisions

### D1 · 估算逻辑是纯函数，全部住 `src/renderer/src/usagePredict.ts`

沿用 `smartBroadcast.ts` / `alertOrchestrate.ts` 的既定模式：**判定纯函数化 + `loadTs` 测真源码**。
本仓库没有 linter，`tsc` + 断言脚本是唯一质量门（spec/frontend/index.md「the four things that matter most」第 1 条），
而内联过一份实现的测试已经漂移过一次（`test-percent.mjs`，见 quality-guidelines）。

`usagePredict.ts` 刻意**不碰 electron / DOM / extras / Date.now()** —— `now` 由调用方传入，
`scripts/test-usage-predict.mjs` 经 `loadTs` 加载真源码跑。

### D2 · 速率算法：最小二乘线性回归（而非首尾两点差）

候选算法与取舍：

| 方案 | 公式 | 否决理由 |
|---|---|---|
| 首尾两点差 | `(last.pct - first.pct) / hours` | 中间任何一次窗口重置（pct 骤降 100→0）都会算出一个**巨大负速率**或荒谬正速率。5H 窗口每 5 小时就重置一次，7 天窗口里有 33 次 —— 不可用 |
| 最近两相邻点差 | `(b.pct - a.pct) / dt` | 采样间隔固定 15min，短程噪声直接进斜率；一次窗口重置就毁掉它 |
| **最小二乘线性回归** | 对 (t, pct) 做 OLS，取斜率 | ✅ 单调窗口与重置点都能被「整体趋势」吸收；异常点被均摊而不是主导结论 |

**决策**：最小二乘线性回归，斜率单位 `百分点/小时`。

⚠ **重置点的处理**（这是本设计最容易被写错的一处）：`pct` 序列在窗口重置时**骤降**（100 → 0）。
直接对整段回归，斜率会被这些负跳变拉向 0 —— 表现为「怎么用都不快，预测永远说用不完」。
做法：**回归前把序列按「向下跳变」切成若干单调不降的段**，只取**最后一段**做回归。
判据一条就够：`p[i] < p[i-1]` 即视为重置，在该点断开。理由：预测问的是「**从现在往后**」，
只有最近这一段连续消耗才携带相关信息；更早的段属于上一个窗口周期，对当前速率没有预测力。

### D3 · 存储按天分桶 + 只追加当天

`{ '2026-09-30': { 'inst:xxx': Point[] } }`。

- **只追加当天分桶**：一轮采样只改 `data[今天]` 一个键，其余键逐字不动 → 可以走「读 → 改 → 写」而不必担心并发（单进程 scheduler，串行采集）。
- **保留期裁剪**：`loadRecent` 与 `appendBatch` 都按 `days` 裁掉 `Date` 早于今天的分桶。默认 30 天（`DEFAULT_RETENTION_DAYS`），可配。
- **不做全量重写**：这是与 extras 的本质区别。extras 每次写都全量重写整个文件；这里每 15 分钟只重写一个文件、但**只改当天的那个子对象**。
  ⚠ 诚实说明：JSON 整体仍需序列化写出（`writeFileSync` 是全量的），所以**收益来自采样频率降低 60 倍 + 体积降低 60 倍**（1/60 频率 × 1/N 供应商合并写），
  而不是「增量写盘」这个说法本身。design 不写做不到的承诺。

### D4 · 可信度：四档，且必须与 `staleLabel` 同源

`src/shared/quality.ts` 的 `staleLabel` 是全仓数据诚实口径的**唯一来源**（卡片徽章 / 托盘 / 详情页横幅都用它）。
预测文案**必须**复用它，不在新模块里写第二份字符串。

在此之上多一层**样本可信度**（这是预测特有的，STL 那边没有）：

| 档 | 判据 | 文案后缀 |
|---|---|---|
| 不可信 | 样本 < `MIN_POINTS_FOR_RATE`（默认 4 个点 ≈ 1 小时） | **不显示**（宁可不预测，不显示没有依据的数字） |
| 低 | 样本 < 8 个点，或时间跨度 < 6 小时 | `样本较少` |
| 中 | 样本 ≥ 8 且跨度 ≥ 6 小时，斜率为正 | 无后缀 |
| 数据源降级 | `dataQuality` 为 cached / local | `staleLabel` 的 `⚠ 缓存` / `⚠ 本机` |

**决策**：`confidenceOf` 返回 `null` 时**整个预测不显示**（与 `statsFor` 样本不足返回 `null` 是同一条纪律，AC10）。
斜率 ≤ 0（用量没涨 / 在回落）时也返回 `null` —— 「按当前速率永远用不完」这句话没有信息量，
不如不说。这两条是**数据诚实**在预测功能上的具体落点。

### D5 · 余额类不显示，套餐类按窗口逐个显示

- 判据用 `isPlan(s)`（`src/shared/quality.ts:27`），**不重写** `kind !== 'balance'`。
- 套餐类：**每个有 `limit > 0` 且百分比可算的窗口**各给一条预测（5H / W / M 各自的消耗速率不同，混成一条是错的）。
- 余额类：不显示 —— 它没有「窗口」也没有「限额」，`limit` 恒缺省，速率估算的整个前提（会触顶）不存在。

### D6 · 文案与展示位置

文案形如：`按近 7 天速率估算，约 3 天 4 小时后用完`。

- **必须含「估算」二字**（AC3）—— 措辞不能是「3 天后用完」这种断言式表达。
- 展示位置：详情页 `DetailView.tsx` 的 `<section className="hero">` 环形仪表下方（`DetailView.tsx:214-221` 那一组 `hero-sub` 旁边），
  以及「用量窗口」列表的每个 `WindowRow` 旁。卡片（`CardView.tsx`）**本任务不做** —— 卡片空间紧张且折叠态常驻，
  预测文案挤进去会与余额数字争夺注意力；prd 的 AC 说「详情页（及卡片）」，这里**收窄为详情页**并在 prd 的 Notes 里记明这一偏差
  （implement.md 的 6.5 走查只覆盖详情页）。
  ⚠ 这是**对 prd 的一处刻意收窄**，实现时若要扩到卡片，需先确认卡片布局能容纳而不挤掉余额。
- 复用 `humanDur`（`format.ts:44`）做时长格式化，不另写一份「X 天 Y 小时」。

### D7 · extras 键

| 键 | 类型 | 默认 |
|---|---|---|
| `ui:predictOn` | `'1' \| '0'` | `'1'`（开） |
| `ui:predictConfig` | JSON `{ windowDays, retentionDays }` | `{"windowDays":7,"retentionDays":30}` |
| `sample:usageHistoryDays` | 天数（**非 `ui:` 前缀**） | `30` |

⚠ 保留期**故意不用 `ui:` 前缀**：`ipc.ts:218-223` 的 `extras:set` 对含非 `ui:` 键的 patch 会调 `refreshNow()` 触发全量重采集。
保留期是采集侧的配置，本来就该触发重排；而采样间隔若做成 `ui:` 键，改它会**静默不生效**（用户在设置页改了间隔，快照还是按老频率采）。
这条「前缀决定副作用」的分界必须写在这里，否则一定会有人把三个键统一成 `ui:` 然后踩坑。

## Contracts

### usagePredict.ts 导出

```ts
export interface UsagePoint {
  /** 采样时刻（epoch ms） */
  t: number
  /** 该窗口的用量百分比；不可知 = null（**不得填 0**） */
  pct: number | null
}

export interface PredictConfig {
  /** 速率回看天数（默认 7） */
  windowDays: number
  /** 本地快照保留天数（默认 30） */
  retentionDays: number
}
export const DEFAULT_PREDICT_CONFIG: PredictConfig = { windowDays: 7, retentionDays: 30 }
/** 速率估算的最小样本数；不足则不预测（AC10 同款纪律） */
export const MIN_POINTS_FOR_RATE = 4
/** 低可信度的样本数上限（< 它则标「样本较少」） */
export const LOW_CONFIDENCE_POINTS = 8
/** 低可信度的时间跨度下限（毫秒） */
export const LOW_CONFIDENCE_SPAN = 6 * 3600_000

export type Confidence = 'low' | 'mid'

export interface Prediction {
  providerId: string
  windowName: string
  /** 预计耗尽时刻（epoch ms） */
  runsOutAt: number
  /** 斜率，百分点/小时（恒 > 0，否则不产出预测） */
  perHour: number
  confidence: Confidence
  /** 数据源降级标注（'' = 官方数据）。取自 staleLabel，**不在这里写第二份字符串** */
  qualityLabel: string
}

export function resolvePredictConfig(raw: Partial<PredictConfig>): PredictConfig
/** 最小二乘斜率（百分点/小时）。样本不足 / 斜率 ≤ 0 → null */
export function ratePerHour(points: UsagePoint[]): number | null
/** 预计耗尽时刻；perHour ≤ 0 或剩余 ≤ 0 → null */
export function estimateRunsOutAt(last: UsagePoint, perHour: number): number | null
export function confidenceOf(points: UsagePoint[]): Confidence | null
/** 完整预测：判据不满足时返回 null（不显示，而不是显示一个没有依据的数） */
export function predictWindow(
  points: UsagePoint[],
  now: number,
  cfg: PredictConfig
): Prediction | null
/** 逐窗口预测；余额类 / 无限额窗口一律跳过（返回空数组，不报错） */
export function predictAll(
  s: ProviderSnapshot,
  pointsByWindow: Record<string, UsagePoint[]>,
  now: number,
  cfg: PredictConfig
): Prediction[]
/** 展示文案；**必须含「估算」**（AC3） */
export function buildPredictionText(p: Prediction, windowDays: number): string
```

### usageStore.ts 导出（主进程）

```ts
export interface StoreUsagePoint { providerId: string; window: string; pct: number | null; t: number }
export function createUsageStore(opts: { filePath: () => string }): {
  appendBatch(points: StoreUsagePoint[], now: number, retentionDays: number): void
  loadRecent(providerId: string, days: number, now: number): Record<string, UsagePoint[]>
  clear(): void
}
export const DEFAULT_RETENTION_DAYS = 30
/** 快照采样间隔（毫秒）。默认 15 分钟 —— 见 B3 */
export const SNAPSHOT_INTERVAL_MS = 15 * 60_000
```

## Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| 供应商 `kind === 'balance'` | 不预测（D5） |
| 窗口 `limit` 缺省 / `≤ 0` | 不预测（限额未知，算不出「用完」的时刻） |
| 窗口 `pct` 为 `null` | 该窗口不预测（**不得按 0 处理**） |
| 样本 < `MIN_POINTS_FOR_RATE` | 不预测（不显示） |
| 斜率 ≤ 0（用量未增长 / 在回落） | 不预测（「永远用不完」没有信息量） |
| 序列含向下跳变（窗口重置） | 只取**最后一段**单调不降的序列做回归（D2） |
| 预测时刻已过 | 不显示（`runsOutAt ≤ now` → null） |
| `dataQuality` 为 cached / local | 文案追加 `⚠ 缓存` / `⚠ 本机`（`staleLabel`） |
| 快照文件损坏 | 重建为空（与 `store.ts` 的 `load()` 同一纪律） |
| `retentionDays` 非法（非正数 / NaN） | 回退 `DEFAULT_RETENTION_DAYS` |
| 快照写入失败 | 记日志、**不抛**、不阻断采集（预测是增值功能，不能拖垮采集） |

## Good / Base / Bad Cases

- **Good**：本周窗口 `pct` 序列 `[30, 35, 41, 46, 52]`（每 15 分钟一点，跨度 1h，斜率 ≈ 22 点/小时），
  当前 `pct=52`、`limit` 已知 → 剩余 48 个点 / 22 ≈ 2.2 小时 → 预测「按近 1 天速率估算，约 2 小时 11 分后用完」。
- **Base**：样本只有 2 个点（刚启动 30 分钟）→ `confidenceOf` 返回 `null` → **整条不显示**。
  反面教材：拿 2 个点硬算出一个「还剩 40 天」的数字 —— 那是在编造。
- **Bad**：7 天窗口，序列 `[95, 97, 0, 12, 25, 38]`（中间 97→0 是窗口重置）。
  对整段回归，斜率被那个 −97 拉到 ≈ 0 → 预测说「永远用不完」。
  正确做法（D2）：在 `0` 处断开，只对 `[12, 25, 38]` 回归 → 斜率 ≈ 26 点/小时 → 给出真实预测。

## Tests Required

新建 `scripts/test-usage-predict.mjs`（`loadTs` 加载 `src/renderer/src/usagePredict.ts` 真源码）：

1. 斜率：单调上升序列 → 斜率 > 0 且量级正确；两点也能算（不是只有 ≥3 点才算）
2. **重置点**：上述 Bad 案例必须给出 `> 0` 的斜率（回归前已切段）
3. 样本不足（0 / 1 / 3 点）→ `ratePerHour` / `predictWindow` 返回 `null`
4. 斜率 ≤ 0（序列持平 / 下降）→ `null`
5. `limit` 缺省、`pct` 为 `null`、`kind === 'balance'` → `predictAll` 不产出该项
6. 可信度分档：4 点 / 8 点 / 跨度 6h 三条边界两侧
7. `dataQuality` cached → `qualityLabel` 含「缓存」；local → 含「本机」；official → 空串
8. `buildPredictionText` **必含「估算」**（AC3 的行为断言，不是源码正则）
9. `resolvePredictConfig` 脏值回退（NaN / 负数 / 缺失键）
10. 纯度：同一份 points 调两次结果相等；入参未被就地修改

新建 `scripts/test-usage-store.mjs`（`loadTs` 加载 `src/main/usageStore.ts`）：
11. 追加 → 读回的点数与内容一致
12. 保留期裁剪：跨 31 天的数据按 30 天裁掉最老分桶
13. 文件损坏 → 重建为空，不抛
14. `retentionDays` 非法 → 回退默认

`package.json` 加 `test:usage-predict` 与 `test:usage-store` 并接入 `test` 链。

## Wrong vs Correct

#### Wrong

在 `scheduler.ts` 里直接算速率、把结果塞进 `ProviderSnapshot` 传下去：

- 采集侧一碰预测逻辑，**主进程就有了一份估算文案**，而 UI 上还有第二份（详情页 / 卡片 / 托盘三处都要显示）→ 两份文案必然漂移；
- 速率估算要「读回历史」，而主进程此刻刚把快照写进 `usageStore`，读回逻辑与写入逻辑耦合在一起，无法单独测；
- 缺失值纪律无处安放：`null` 百分比在主进程算成 0 的话，会造出「速率正常」的假象。

#### Correct

`usageStore`（主进程，**只管存**）与 `usagePredict`（渲染层，**只管算**）职责分开：

- 存储不知道「速率」是什么，估算不知道「文件」在哪；
- 估算全部是纯函数，`scripts/test-usage-predict.mjs` 经 `loadTs` 跑真源码，边界（重置点 / 样本不足 / 斜率为 0）逐条钉住；
- 文案只在 `buildPredictionText` 一处生成，卡片 / 详情页 / 未来任何新入口都复用它 —— 与 `staleLabel` 的单一出处是同一条纪律。
