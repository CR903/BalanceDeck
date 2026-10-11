# 窗口驱动的用量序列视图：口径对齐与回退纪律

适用：把「某个配额窗口内的用量」画成时间序列（逐小时 / 逐日柱状）。
来源：2026-10-11 opencode 详情页趋势重构（`TrendChart.tsx` + `seriesView.ts`）；
取代了 2026-10-07 的日历热力图口径（`usageHeatmap.ts` 已随接线退役删除）。

## 1. 窗口对齐：用官方「窗口起点」，不要用 range 或 `now - span`

官方端点常有 `range=24h|7d|30d`，但**窗口未必是滚动的 7×24 小时**（周窗口常是
自然周对齐周一 0:00）。若用 `range` 或 `now - span` 当窗口起点：

- 周窗口会偏（`now - 7d` ≠ 自然周的周一 0:00）；
- 「5 小时窗口没有明细」会变成一条看似合理的限制，其实只是没找对参数。

**做法（2026-10-11 保留期纠错后）**：

- `go/status` 的每个 meter 都带 `startsAt`（`month` 用 `access.startsAt`），且**进缓存键**
  （5 小时窗口每 5 小时滚动一次，键里没有起点就会拿到上一个窗口的数据）。
- **`since` 只在窗口落在服务端约 48h 保留期内时可用** —— 只有 5 小时窗口满足：
  rolling 用 `range=24h&bucket=hour&since=<fiveHour.startsAt>`。
- **周/月不带 `since`**：带任意旧起点都会被服务端**静默钳制到最近约 2 天**
  （实测 `range=7d&since=10-05` ≡ `since=10-09`；不带 `since` 才返回完整 7 天）。
  改用 `range=7d|30d&bucket=day` 取全量日聚合，再由 `seriesByWindowOf` **客户端裁到
  `[startAt, resetAt)`**（见 §1.1）。
- 缺 `startsAt` 时才用 `resetAt - WINDOW_SPANS[kind]` 反推兜底（`windowStartIso`）。

⚠️ **校准（2026-10-11 实测纠错）**：`resetAt - span` 反推**不会偏** ——
`week.startsAt → resetsAt` 恰好 7 天，反推结果与官方起点逐毫秒相同。会偏的是
`now - 7d`。本仓库上一版知识页把这两者写混了，据此写下「周窗口不能反推」是**错**的；
正确表述是「官方 `startsAt` 是权威，反推只是缺字段时的兜底」。

### 1.1 裁剪口径：保留与窗口**相交**的桶

`cost-by-day` 的桶按 UTC **整点/整日向下取整**，所以窗口第一个桶可能早于 `startAt`
（rolling 小时桶最多早 59 分钟；month 的订阅起点是 `access.startsAt` 这种非整日时刻，
首日桶可能早将近一天）。若按「桶起点 `>= startAt`」裁，会把这**第一个不完整桶整只丢掉**，
于是时序求和 < meter 的已用量 —— 正是本项目最忌讳的「口径不一致」。

```ts
// 保留与窗口相交的桶：桶起点 + 桶宽 > lower && 桶起点 < upper
// lower = startAt ?? resetAt - spanMs；upper = resetAt ?? +∞
return buckets.filter((b) => t + span > lower && t < upper)
```

代价：首桶可能含极少量窗口外用量（≤ 一个桶宽）。**不会**把对齐窗口的前一整桶带进来 ——
自然周对齐时（`startAt` = 周一 00:00）前驱桶的末端恰好等于 `startAt`，不含在相交内。
口径由 `test-ssr-parser.mjs` M 段钉住（弄坏裁剪 → 5 条断言变红）。

⚠️ **序列求和 ≠ meter 已用量**（同轮 live 实测）：5 小时逐分一致，但本周 Σ 比 meter 低约 3.6%、
本月低约 14%（服务端 `cost-by-day` 有空洞，如缺 `09-25`）。**不要用序列求和反推百分比**，
百分比一律以 `go/status` 的 meter 为权威；趋势只画形状与逐桶数值。

## 2. 回退判据：key 缺失 vs 空数组是两回事

官方序列没抓到（超时 / 4xx）与「官方确认该窗口没用过」必须分开，否则
「确认没有」会被误标成「本机估算」：

| 状态 | 落点 | 渲染层行为 |
|---|---|---|
| 抓取失败 | **key 不存在** | 退回本机历史 + 标注「本机估算」 |
| 抓到且为空 | **key 存在，值为 `[]`** | 显示「该窗口暂无用量」，**不**退回本机 |

同理 **`models` 与 `series` 两条链都要一致**，且**映射必须在纯函数里做**：

```ts
// opencode-details.ts — 空数组保留 key（`if (rows)`，不是 `if (rows.length)`）
modelsByWindowOf(details, windowNames)   // 三窗口都要有，含 5 小时
seriesByWindowOf(details, windows)       // windows: {kind,name,startAt?,resetAt?,spanMs}[]
                                         // 额外把每个窗口的桶裁到 [startAt, resetAt)（§1.1）
```

⚠️ 把 `if (rows)` 写成 `if (rows.length)` 就把「官方确认该窗口无已用模型」压成了
「抓取失败」；而内联在 `collect()` 里时，删掉 rolling 映射、或改这个条件，**一个测试都不会红**
（本仓库 2026-10-11 评审实测）；抽成纯函数 + 单测才拦得住（见
`.trellis/spec/adapters/opencode-console.md` §3.3/§3.5、`test-ssr-parser.mjs` L 段）。

## 3. 本机兜底：重置感知增量，首桶无基准不补 0

本机采样存的 `used` 是**窗口内累计**，只有相邻差值才是花费：

```ts
// seriesView.localSeriesNodes：cur < prev 即换周期，取 cur 本身（不是负数）
if (cur != null && prev != null) cost = cur < prev ? cur : cur - prev
// 首桶（无基准）/ 缺采样的桶 → cost = null
```

- **不补 0**：0 是断言「这小时没花钱」；`null` 才是「算不出」。
- **未知预算的桶不画柱**（`{h > 0 && …}`）—— 缺口可见，比一根贴地柱诚实。
- **整个区块的判据是「至少一根已知花费的柱」**：只有 1 个采样点时所有桶都是
  `null`，此时画一个没有柱的空坐标系比什么都不显示更像坏了 → `TrendPanel` 返回 `null`。

## 4. 退役一个可视化：模块 / 测试 / 脚本 / 结构门一起删

换图形时最容易留下的是**死接线**（新图不再用的旧纯函数模块 + 只测它的脚本 +
`package.json` 里的 test 条目）。清单：

1. 删模块（`usageHeatmap.ts`）与只引用它的组件代码；
2. 删它的测试脚本（`test-usage-heatmap.mjs`）与 `package.json` 的两处条目
   （`test:<x>` 与 `test` 链）；
3. 检查其余套件的**结构切片**是否切了被删的 DOM/函数（本次 `test-usage-history.mjs`
   的 G 段切了 `.trend-cell` 等，需同步改写）；
4. 门禁：新纯函数要有**自己的**结构切片（`test-series-view.mjs` H 段）——
   官方优先、本机回退必标注「本机估算」、不再 import 旧模块。

⚠️ 结构切片**不要**用整文 `grep` 断言「旧名字不出现」—— 退役说明的注释里就写着
那个名字，会假红。改断言**机制**（`from './usageHeatmap'` 不存在、常量定义不存在、函数调用不存在）。

## 5. JSON 存储加可选字段不需要升 version

磁盘格式从 `{ t, pct }` 扩到 `{ t, pct, used?, unit? }` / 快照加
`seriesByWindow?` / `extraCredit?`，**version 保持 1**：可选字段前向兼容，老文件读回来
是 `undefined`。升 version 会让实现把**所有**老文件判成「格式不符」并重建 ——
30 天 × N 供应商的历史在一次升级里全灭。代价（升级前那几天显示「—」）要在 PRD 写明。

## 6. 绝对量与百分比是两份字段，判据必须独立

`bucketByDay` / 本机序列里，`pct` 与 `used` 谁已知谁保留，另一个保持 `null`：
官方 API 里这两者是两份字段，坏一个不必然坏另一个。绝对量走**同一条** reset 口径，
否则会出现「图上最深、明细是负的」这种自相矛盾的显示。

## 门禁钉住什么

`test-series-view.mjs`：

- 官方 key 存在（哪怕 `[]`）就不退回本机（`if (official != null) return officialSeriesNodes`）；
- 本机回退必须标注「本机估算」；
- 未知花费（`cost=null`）不画柱（`{h > 0 &&`）；
- 不再 import 旧热力图模块、不再有 `DAY_CHOICES`。

⚠️ 负向断言必须带**前置断言**（先确认切片找得到），否则「那段代码不存在」时会空洞通过。
