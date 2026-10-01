# Design: P1-1 历史趋势图

## 调研结论（已核实，直接采用）

| 问题 | 结论 |
|---|---|
| 要新增 IPC 吗 | **不需要**。`usage:predict`（`ipc.ts:374`）返回的已经是 `loadRecent` 的**原始历史** `Record<窗口名, UsagePoint[]>`；`predictAll` 才是渲染层加工。「只在套餐类请求」是 `DetailView.tsx:245` 的**选择**，不是通道限制 |
| 余额类能做趋势图吗 | **不能**（实测）。余额窗口名只有 `'账户余额'`（`adapters/types.ts:57`）与 `'账户额度'`（`protocols.ts:242`），`windowPercent` 实测分别是**恒 `null`** 与**恒 `0`** —— 后者画出来是贴底平线，比 null 更危险（看起来像有数据）。且 `UsagePoint` 只有 `pct`，采样时 `w.used`（金额）已被丢弃，磁盘上没有余额金额历史 |
| 按天分桶放哪 | **渲染层**。`load()` 有 cache 短路（`usageStore.ts:101-103`），额外 IO 为零。代价是 30 天×3 窗口 = 8640 点过 IPC —— 可接受。后端零改动更符合本任务约束（不碰 `usageStore` / `ipc.ts` / `preload`） |

## Architecture

```
                    DetailView.tsx
                          │
        ┌─────────────────┴──────────────────┐
        │ 新增 hook: useUsageHistory(providerId, days) │
        │  与现有 usePredictions **并列**（不是父子）    │
        │  · 一次取 windowDays 的上限（30 天）        │
        │  · 7/30 天切换纯前端（不重发 IPC）          │
        └─────────────────┬──────────────────┘
                          │
              window.api.usagePredict(id, 30, now)
                          │
              ┌───────────▼────────────┐
              │ 新增 TrendChart.tsx     │
              │  · 轻量 SVG（无图表库）  │
              │  · 每根柱 = 那天**末值**  │
              │  · 坐标换算纯函数可测    │
              └───────────┬────────────┘
                          │
              ┌───────────▼────────────┐
              │ usageHistory.ts（新）    │
              │  · bucketByDay()        │
              │  · dayColumn()          │
              │  · scaleY() / xOf()     │
              │  纯函数，无 DOM          │
              └────────────────────────┘
```

## Technical Decisions

### D1 · 每根柱 = 那天**末值**（用户已拍板）

每天最后一笔采样的 `pct`。与卡片当前显示的数字**同一口径** —— 用户能自己核对，
不需要理解「峰值/均值」是什么。

替代方案与理由：峰值对「哪几天把额度烧掉了」更敏感，但与卡片对不上号；
折线图（672 点不聚合）能看出 5H 窗口的重置形态，但密集且无法回答「按天对比」。
末值是三者中唯一能被用户自行验证的那个。

⚠ **末值的取法**：一天 96 个点（15 分钟粒度），取 `pct != null` 的**最后一个**，
而不是数组最后一个 —— 末尾可能是采样失败记下的 `null`（缺失值保持缺失，不填 0）。

### D2 · 只画**主窗口**，其余窗口给切换控件（不做三窗口叠画）

调研指出量纲**可比**（都经 `shared/percent.ts:19` 钳到 0..100），但：

- 5H 窗口在 7 天内**重置 33 次**（每次 5 小时一个周期），叠画出来是锯齿，
  用户看不出「哪条线是本月用量」；
- 三条线的颜色要在 template/色盲下都能区分，而项目没有既定的图表配色 token。

**决策**：默认画 `primaryWindow`（`read-model.ts:22`，第一个带限额的窗口），
给一个窗口切换控件（`5H / 本周 / 本月`）让用户自己看。

窗口名来自 `snapshot.windows[].name`，切换时**不重发 IPC**（数据已全取回）。

### D3 · 趋势图**不受 `predictOn` 管**（用户已拍板）

`predictOn`（`ui:predictOn`）的语义是「预计耗尽」，它只该管那行文案。
现状问题：`usePredictions` 在 `!on` 时**根本不请求**（`DetailView.tsx:67`），
若趋势图复用同一个 hook，关掉 `predictOn` 会连带让趋势图消失 —— 而用户关掉的
是「预计耗尽那句话」，不是「趋势图」。

**决策**：把取数从 `usePredictions` 里拆出成独立的 `useUsageHistory`，
两个 hook 各自请求、各自消费。`predictOn` 只管 `buildPredictionText` 那一行。

代价：两者各自发一次 IPC。**接受** —— 一次多传几 KB 的本地数组，
换来「开关语义互不牵连」，比省一次 IPC 重要。

### D4 · 7/30 天共用一次 IPC，切换纯前端

一次取 `windowDays` 上限（30 天），两个视图共用同一份数组。
`bucketByDay` 按可见天数切片即可，切换不发请求。

理由：快照文件每 15 分钟才动一次，而切换会频繁发生；把网络/IPC 往返放在切换路径上
是本末倒置。

### D5 · 坐标换算全部是纯函数，放 `src/renderer/src/usageHistory.ts`

不引图表库（竞品报告原话：「轻量 SVG 即可」）。需要可测的三件事：

- `bucketByDay(points, days, now)` → `{ day: string; lastPct: number; maxPct: number }[]`
  （按本地日历日切；`pct == null` 的点跳过，**不按 0 参与**）
- `scaleY(pct, height, max)` → 像素 y（纵轴固定 0..100，不随数据缩放 ——
  否则「上周 90%、本周 20%」的两张图形状一样，用户读不出差异）
- `xOf(index, count, width)` → 像素 x

放独立文件而非 `usagePredict.ts`：趋势图不需要预测的任何东西，
混进去会让那个模块同时管「估算」与「绘图」两件不相干的事。

## Contracts

### usageHistory.ts（新，纯函数）

```ts
import type { UsagePoint } from '../../shared/usage-predict'

export interface DayBucket {
  /** 本地日历日 'YYYY-MM-DD' */
  day: string
  /** 该天最后一个**已知** pct（末尾是 null 时不取它）；无已知值 = null */
  lastPct: number | null
  /** 该天峰值（画柱内的高亮/参考线用） */
  maxPct: number | null
}

/** 按本地日历日聚合成「每天一根柱」。缺样本的天**不补 0**（缺口就是缺口） */
export function bucketByDay(points: UsagePoint[], days: number, now: number): DayBucket[]
/** 纵轴固定 0..100 → 像素 y。⚠ 不随数据缩放 */
export function scaleY(pct: number, height: number): number
/** 横轴等距 */
export function xOf(index: number, count: number, width: number): number
/** 挑出可见的窗口名（供切换控件）；只列真的有历史点位的 */
export function windowsWithHistory(pointsByWindow: Record<string, UsagePoint[]>): string[]
```

### TrendChart.tsx（新组件）

```tsx
export function TrendChart(props: {
  buckets: DayBucket[]
  /** 当前纵轴最大值（默认 100 固定） */
  maxPct?: number
  windowName: string
}): React.JSX.Element | null   // buckets 为空 → null（不渲染空壳）
```

## Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| 供应商是余额类 | **不请求、不渲染**（调研实测：余额类 pct 恒 null 或恒 0，画出来是贴底平线/假数据） |
| 该窗口没有任何历史点 | 该窗口不出现在切换控件里（`windowsWithHistory` 过滤） |
| 某一天完全没采样 | **不补 0**，那一天在图上留空（缺口可见 = 用户知道那天应用没跑） |
| 某天全是 `pct: null` | 该桶 `lastPct = null` → 不画那根柱 |
| 历史不足 2 天 | 仍渲染，但柱很稀疏（**不隐藏** —— 有 1 天的数据也有信息量） |
| `usage:predict` 返回 `{}` | `TrendChart` 收到空 buckets → 返回 `null`（界面上什么都不显示，**不是**「加载失败」） |
| 窗口名含特殊字符 | SVG 文本节点自然转义，不需要额外处理 |

## Good / Base / Bad Cases

- **Good**：本月窗口 30 天，每天末值 12% → 88%，图上是 30 根递增的柱。用户在详情页同时看到「已用 88%」和「这 30 天是怎么涨到 88% 的」，两个数字口径一致。
- **Base**：刚装 2 天，只有 2 根柱。图很稀疏但**真实** —— 不为了好看而伪造 30 天。
- **Bad**：某应用断了 5 天。图上留 5 天空档。若用 `null` 填 0 补齐，用户会看到「那 5 天用量是 0」并据此得出「我这几天没用」的错误结论，而真实原因是**采集没跑**。

## Tests Required

新建 `scripts/test-usage-history.mjs`（`loadTs` 加载 `usageHistory.ts` 真源码）：

1. `bucketByDay`：跨天切分正确；本地日历日（非 UTC —— 跨时区用 UTC 日会在每天早上把最近 8 小时归到昨天）
2. **末值取的是最后一个已知值**：末尾是 `null` 时取前一个已知值，**不是**取 null 也不是取 0
3. 缺样本的天**不补 0**（桶数少于采样天数）
4. 全 null 的天 → `lastPct = null` 且**不产生柱**
5. `scaleY` 固定 0..100：输入 5% 与 95% 的 y 差必须接近 height 的 90%（验证「不随数据缩放」）
6. `xOf` 等距；`count === 1` 不除零
7. `windowsWithHistory` 过滤掉没有点的窗口
8. 纯度：同一份 points 调两次相等；**入参未被就地修改**（深比较）
9. 静态守卫：`usageHistory.ts` 内不得出现 `Date.now` / `window.` / `document.`
   （与既有纯函数纪律一致，见 `spec/frontend/quality-guidelines.md`）

`--uitest`：
10. 详情页渲染出 `.trend-chart` 且柱数 = 可见天数（有历史时）
11. 余额类供应商详情页**没有** `.trend-chart`

## Wrong vs Correct

#### Wrong
复用 `usePredictions` 并把趋势图塞进 `{predictOn && …}`：

- 关掉「预计耗尽」会连带让趋势图消失 —— 用户关掉的是一句话，不是趋势本身；
- `usePredictions` 返回的是 `predictAll` **加工后**的 `Prediction[]`（已经过样本门槛与切段），
  而趋势图要的是**原始采样序列**。切段会把每天分属不同窗口周期的点隔开，画出来的图是断的。

#### Correct
独立的 `useUsageHistory` 取原始历史、`usageHistory.ts` 做纯函数聚合、
`TrendChart.tsx` 只渲染。三个环节各自可测，预测那条线完全不受影响。