# Spec: opencode.ai 控制台集成

> 可执行契约。来源：任务 `09-26-opencode-console-spa`（2026-09-26 实施，
> 2026-09-27 沉淀），全部内容以**实测响应**为准，不是文档推断。
> 思考触发器见 [`../guides/external-api-integration.md`](../guides/external-api-integration.md)。

---

## 1. Scope / Trigger

改任何与 opencode 控制台相关的代码前读这份。涉及四类改动：

- 抓配额窗口百分比（余额板主显示）
- 抓每模型明细（详情页）
- 授权会话的建立与校验
- 上述任何一条的**错误提示**（提示语错 = 用户不知道该做什么）

## 2. Signatures

唯一常量来源：`src/main/adapters/opencode-console-api.ts`

```ts
CONSOLE_ORIGIN        // 'https://opencode.ai/console'
LOGIN_PATH            // '/login'
ORGS_PATH             // '/api/orgs'
GO_STATUS_PATH        // '/api/go/status'        ← 配额窗口（meter 带 startsAt）
BILLING_STATUS_PATH   // '/api/billing/status'   ← 额外可用额度/余额（v2 已接线，只读展示）
USAGE_SUMMARY_PATH    // '/api/usage/summary'    ← 不是窗口源！仅授权探针
USAGE_MODELS_PATH     // '/api/usage/models'     ← 每模型明细
USAGE_COST_BY_DAY_PATH// '/api/usage/cost-by-day' ← 用量时序（趋势区数据源）
ORG_ID_HEADER         // 'x-org-id'
USAGE_UNIT_SCALE      // 1e8  → 1 USD = 1e8 microcents
METER_FIELDS          // { fiveHour:'rolling', week:'weekly', month:'monthly' }
PERIOD_END_RESET_FIELDS // Set(['month'])   ← month 的 reset 回落 endsAt、start 回落 access.startsAt
MODELS_RANGES         // { weekly:'7d', monthly:'30d' }  ← 周/月用 range 全量，**不带 since**
MODELS_RANGE_ROLLING  // '24h'  ← 仅 rolling 用 range=24h + since=<fiveHour.startsAt> 对齐
COST_BUCKETS          // { hour:'hour', day:'day' }  → COST_BUCKETS: 窗口 rolling=hour，周/月=day
MODELS_PAGE_SIZE      // 50

buildConsoleHeaders(cookie: string, orgId?: string | null): Record<string, string>
findOrgId(text: string): string | null
classifyConsoleStatus(status: number): 'unauthorized' | 'forbidden' | null
consoleAuthMessage(kind): string | null
```

三个能单测的纯解析/派生函数（全部有真实 fixture）：

```ts
// src/main/adapters/opencode-cookie.ts
parseGoStatus(body: unknown, nowMs: number): {
  windows: Partial<Record<UsageWindowKind, SsrUsageWindow>>
  raw: Partial<Record<UsageWindowKind, SsrRawWindow>>   // 现在带 startAt?: string（ISO）
  unknownMeters: string[]          // 非空 = 站点改版信号
}
windowStartIso(raw, kind, nowMs): string | undefined      // 官方 startsAt 优先，缺失才 resetAt-span 反推

// src/main/opencode-details.ts
parseModelsResponse(body: unknown): ConsoleModelRow[]
parseCostByDay(body: unknown, bucket: CostBucket): UsageBucket[]   // 升序；容忍未知键/坏行；**缺金额 → 跳过该桶**
modelsByWindowOf(details, windowNames): Record<string, ConsoleModelRow[]>   // 纯映射；空数组保留、缺失不产出
modelsRequestOf(kind, starts): { range; since? } | null            // 窗口 → models 请求口径（纯函数）
seriesRequestOf(kind, starts): { range; bucket; since? } | null    // 窗口 → cost-by-day 请求口径（纯函数）
seriesByWindowOf(details, windows: SeriesWindowBound[]): Record<string, UsageBucket[]>
//   纯映射 + **裁到窗口**：`windows` 逐项 `{kind,name,startAt?,resetAt?,spanMs}`；
//   保留与 `[startAt, resetAt)` 相交的桶（`startAt` 缺 → `resetAt - spanMs` 反推）；
//   空数组保留 key、缺失不产出 key（契约同 modelsByWindowOf）
fetchConsoleDetails(wid, cookie, starts: ConsoleWindowStarts): ConsoleDetails | null
//   ConsoleDetails = { models?: Partial<Record<'rolling'|'weekly'|'monthly', ConsoleModelRow[]>>
//                      series?: Partial<Record<'rolling'|'weekly'|'monthly', UsageBucket[]>> }
//   规则：**key 不存在 = 抓取失败**（渲染层退回本机）；key 存在但空数组 = 官方确认该窗口无用量。
```

## 3. Contracts

### 3.1 授权会话

分区 `persist:opencode-auth`。**两条 cookie 都要带**（`buildCookieHeader` 按域全量收集）：

| Cookie | 角色 |
|---|---|
| `auth` | 旧控制台遗留，仍在但新站**不认** |
| `__Host-console_session` | 新控制台的会话凭据 |

`org` / `workspace` id 通过**请求头 `x-org-id` 传，不是路径段**。
两种 id 前缀都合法（bundle 校验规则 `/^(org_|wrk_)/`）：实测同一账号下
`wrk_…`（Default）与 `org_…`（Personal）并存。**`opencodeWorkspaceId` 存的值继续有效，
不需要迁移。**

### 3.2 配额窗口 —— `GET /console/api/go/status`

请求头：`Cookie` + `x-org-id`（缺 → `400 {"_tag":"BadRequest"}`；缺 org → `400 org_required`）

```jsonc
// 实测响应（脱敏）
{
  "renewalAuthorizationRequired": true,
  "access": {
    "endsAt": "2026-10-21T01:25:47.000Z",
    "meters": {
      "fiveHour": { "startsAt": "…", "resetsAt": "2026-09-26T15:22:41.617Z",
                    "limitMicroCents": "1200000000", "usedMicroCents": "52000" },
      "week":     { "startsAt": "…", "resetsAt": "2026-09-28T00:00:00.000Z",
                    "limitMicroCents": "3000000000", "usedMicroCents": "505884411" },
      "month":    { /* 没有 resetsAt */    "limitMicroCents": "6000000000",
                    "usedMicroCents": "505884411" }
    }
  }
}
```

要点：

- 所有金额是**字符串**的 microcents（1 USD = 1e8）→ `Number(v) / USAGE_UNIT_SCALE`
- **限额由服务端下发**，`LOCAL_LIMITS`（$12/$30/$60）只是拿不到时的兜底
- `month` **没有 `resetsAt`** → 回落 `access.endsAt`。
  实测核对：`endsAt` 减当时 = 24 天 10 小时 41 分，与控制台页面 "Resets in 24d 10h" 吻合。
  ⚠️ 只有 `month` 适用：`week.resetsAt` 是 `2026-09-28T00:00:00Z`（**自然周对齐周一 0 点**），
  而 `access` 是周日 09-21 开的 —— 两者锚定方式不同，不能推广。
- **每个 meter 现在都带 `startsAt`（窗口起点）**（2026-10-11 新增实测）。
  起点优先取 `meter.startsAt`；`month` 没有 → 回落 `access.startsAt`（与 reset 同一组字段）。
  下游用它做 `since`（仅 rolling）与趋势**裁剪到窗口**；缺失时才用 `resetAt - WINDOW_SPANS[kind]` 反推兜底
  （`windowStartIso`）。
  ⚠️ **官方优先不等于「反推会偏」**：实测 `week.startsAt → resetsAt` 恰好 7 天，
  `resetAt - 7d` **精确等于**起点。会偏的是 `now - 7d`（那假设窗口是滚动 7 天，
  而实际是自然周）。别再写「周窗口不能反推」——那句话是错的。
- 输出沿用旧 `SsrRawWindow` / `SsrUsageWindow` 形状，只是 `raw` 多一个可选 `startAt`，
  **`officialWindows` 零破坏**

### 3.3 每模型明细 —— `GET /console/api/usage/models`

```
?range=7d|30d&page=1&pageSize=50     （端点支持 24h|7d|30d，默认 pageSize=10）
```

```jsonc
{ "items": [ { "model": "deepseek-flash", "provider": "opencode-go",
               "totalRequests": "4357", "totalInputTokens": "18089708",
               "totalOutputTokens": "3193794", "totalCacheReadTokens": "858154621",
               "totalCacheWrite5mTokens": "0", "totalCacheWrite1hTokens": "0",
               "totalCostMicroCents": "1180850167" } ],
  "pageInfo": { … } }
```

`ConsoleModelRow = { model, provider, usageUsd, tokens, requests }`

- `tokens` = input + output + cacheRead + cacheWrite5m + cacheWrite1h，**服务端口径**
- ⚠️ **没有 per-model 的 `quota` / `percent`**。旧 DOM 版能从表头读到，新接口没有。
  这两个字段已从 `ConsoleModelRow` **删除**（不是填 0）—— 填 0 会渲染成「$0 / 0%」
- ⚠️ **`since` 只对「窗口落在约 48h 保留期内」的场景有效**（5 小时；2026-10-11 live 实测纠错）：
  超过保留期的 `since` 会被服务端**静默钳制到最近约 2 天**。所以：
  - **rolling**：`range=24h&since=<fiveHour.startsAt>` —— 窗口在保留期内，准确；这是 5 小时
    明细唯一正确的取法（推翻了 v1「5 小时没有明细是正确行为」）。
  - **weekly/monthly**：`range=7d|30d`，**不带 `since`** —— 整周/整月口径。
    带任意旧起点（实测 `range=7d&since=10-05` ≡ `since=10-09`）只会得到最近 2 天的模型。
  - **口径纪律**：rolling 的 `since` 必须是官方 `startsAt`，绝不是「now - 5h」本地推算。
  - 映射固定在纯函数 `modelsRequestOf` / `seriesRequestOf` 里，有单测钉住（N 段）。
- 401/403 → 静默降级为空明细（增强项，不该让整轮采集失败），但**必须记日志**
- **key 语义（与 §3.5 一致）**：抓取成功就产出 `models[窗口kind]`（**空数组也保留**，
  表示「官方确认该窗口无已用模型」）；抓取失败才不产出该 key。快照映射由纯函数
  `modelsByWindowOf` 完成（三条契约有单测钉住），**不要**在 `collect()` 里内联
  `if (rows.length)` —— 那会把「确认没有」与「拿不到」压成同一态。

### 3.5 用量时序 —— `GET /console/api/usage/cost-by-day`（趋势区数据源）

```
?range=24h|7d|30d&bucket=hour|day[&since=<ISO>]     （必需 x-org-id）
→ [{ date, totalCostMicroCents, totalTokens, totalRequests }]
```
- `date` 为 **UTC 整点/整日**（如 `2026-10-11T04:00:00Z`）
- **`since` 保留期语义同 §3.3**：只对落在约 48h 保留期内的窗口有效（rolling）；
  周/月**不带 `since`**，取 range 全量日聚合，再由 `seriesByWindowOf` **客户端裁到
  `[startAt, resetAt)`**。裁剪口径：保留与窗口**相交**的桶（`桶起点+桶宽 > startAt`），
  这样不会丢掉窗口内第一个不完整桶（rolling 小时桶/月订阅非整日起点的日桶），
  也不会把对齐窗口的前一整桶带进来（自然周对齐时前驱桶末端恰等于 `startAt`）。
- `parseCostByDay(body, bucket)` 升序返回 `UsageBucket{ t, bucket, cost(USD), tokens, requests }`；
  容忍未知键、坏 `date` 行跳过不丢整表；**空数组是合法结果**（官方确认该窗口无用量）。
  ⚠️ **`totalCostMicroCents` 缺失/不可解析 → 跳过该桶**（不补 0）：它是必填字段，
  缺它说明结构变了；补 0 会把「不知道」渲染成「$0.00」。
- 窗口粒度：rolling = `bucket=hour`（逐小时），周/月 = `bucket=day`（逐日）
- ⚠️ **序列求和 ≠ meter 已用量**（2026-10-11 live 实测）：5 小时逐分一致，但本周 Σ 比 meter 低约 3.6%、
  本月低约 14%（`cost-by-day` 存在服务端空洞，如缺 `09-25`）。**不要用序列求和反推百分比**；
  趋势图只画形状与逐桶数值，百分比一律以 `go/status` 的 meter 为权威。
- 快照落点：`ProviderSnapshot.seriesByWindow[窗口名]`；**key 缺失 = 抓取失败** →
  渲染层退回本机历史并标注「本机估算」；**key 存在但空数组 = 官方确认无用量**（不退回）
- 余额：`GET /api/billing/status` 的 `availableMicroCents/balanceMicroCents` →
  `ProviderSnapshot.extraCredit{ available, balance }`（USD，只读）。失败 → 不产出该字段，
  详情页整块不显示（**不显示 0**）

### 3.4 失败语义：两条路径不同（设计决定）

| | 窗口（`opencode-cookie.ts`） | 明细（`opencode-details.ts`） |
|---|---|---|
| 请求方式 | `ctx.request`（**经采集引擎**） | 原生 `fetch`（**不经**） |
| 理由 | 参与可达性记账与离线判定 | 挂掉**不该**让 opencode 被判「离线」 |
| 串/并 | 单发 | **串行** + 失败重试一次 |
| 失败后果 | 快照退到本机估算并标 `local` | 该窗口明细缺失 |

## 4. Validation & Error Matrix

| 条件 | 响应 | 行为 |
|---|---|---|
| 会话无效 | `401` | 抛「控制台会话无效：控制台已改版，需重新点「一键授权」登录 opencode.ai/console」 |
| 缺 org | `400` + `org_required` | 抛「控制台要求指定工作区，但当前 workspace id 无效（请重新授权）」 |
| 有会话无权 | `403` | 抛「控制台会话有效但无权访问该工作区」 |
| 端点 5xx / 429 | `500` / `429` | 抛「控制台接口返回 HTTP …」 |
| 200 但非 JSON | — | 抛「返回的不是 JSON（站点可能改版或返回了错误页）」 |
| 200 但 meter 全不认识 | `unknownMeters` 非空 | 抛「控制台接口结构已变（出现未知计费项：…）」 |
| 200 但无任何窗口 | — | 抛「未返回任何计费窗口（会话可能已失效，请重新授权）」 |
| 有 `usage` 但算不出百分比（`limit` 缺失或为 0） | — | **不产出窗口**，由 `opencode.ts` 提示「百分比不可用（控制台未给限额）」 |
| 明细某 range 失败 | 任意 | 重试一次；仍失败则该窗口 key 缺失 + 日志 |
| 时序某窗口失败 | 任意 | 同上；该窗口 `series` key 缺失 → 渲染层退回本机并标注「本机估算」 |
| **周/月请求带了 `since`**（超 ~48h 保留期） | 200 | 服务端**静默钳制到最近约 2 天** → 序列只剩 2 桶、模型只剩 2 天的。**禁止**：周/月一律不带 `since`（`modelsRequestOf`/`seriesRequestOf` 钉住）；周/月序列客户端裁到窗口 |
| 运维/结构变更致 `since` 语义再变 | — | 表现是「窗口序列桶数 < 窗口应有天数」而非报错 → live 复核（`--details-test`）比对桶数，不要只信 200 |
| 明细 401/403 | — | 不重试，静默降级为空 + 日志 |
| 时序 401/403 | — | 同上（不重试） |
| 官方确认无明细/无用量 | 200 + 空数组 | `models`/`series` 该 key 为 `[]` → 渲染层**不**退回本机（那是「确认没有」，不是「拿不到」） |
| 时序非空响应但全行缺必填金额 | 200 + 非空数组且解析出 0 桶 | **不设该 `series` key**（结构可能已变）+ 日志 → 渲染层按「拿不到」处理，**不得**冒充「官方确认无用量」 |
| billing 失败 | 任意 | `extraCredit` 不产出 → 详情页整块不显示（不显示 0） |

> 401 与 404 必须分开：401 是"要用户去做一件事"，404/5xx 是"这条路暂时不通"。
> 笼统的「cookie 已过期或无效」已删除。

## 5. Good / Base / Bad Cases

**Good**（实测真实账号，2026-10-11 三窗口口径）
```
本周: used=5.05884411 limit=30 pct=16.9 note='控制台'
detail=明细分窗 key=['5 小时','本周','本月']   ← rolling=24h+since；周/月=7d/30d（无 since）
series=时序分窗 key=['5 小时','本周','本月']   ← rolling=hour+since；周/月=day 全量后**裁到窗口**
models: deepseek-flash $11.8085 tokens=879438123 requests=4357 source='console'
extraCredit: available=5.00 balance=0
```

**Base**（会话有效但没花过钱）—— 0% 是真的，如实给出窗口。

**Bad 1**（曾经的真实回归）
```
控制台每月
deepseek-flash  $11.81  —  本机 880.1M     ← 标题说控制台，标签说本机，数字是服务端的
```
修法：`tokenProvenanceLabel(rows)` 按行 `source` 判定，混合时明确写「服务端 + 本机」。

**Bad 2**（评审抓出）
```
本周: $5.06 / $30.00 · 0% · 控制台          ← 花了 5 块却显示 0%
```
根因：`limit=0` → `usagePercent` 算不出 → 落 `percent = 0`，而 `0%` 是一个断言。
修法：不产出窗口条目（`raw` 仍留金额），并给可操作提示。

**Bad 3**（踩过两次的坑）
```
控制台接口结构已变（出现未知计费项：fiveHour, week, month）
```
根因：`new Set(Object.values(METER_FIELDS))` 取的是**值**（rolling/weekly/monthly），
应该是**键**（fiveHour/week/month）。

## 6. Tests Required

`npm run test:ssr` —— **133 项 0 失败**。`scripts/test-ssr-parser.mjs`，
用 `loadTs()` 加载**真源码**，fixture 取自真实响应（脱敏）。
`npm run test:series-view` —— 47 项，覆盖 `seriesView.ts`（官方搬运 / 本机重置感知增量 /
`bucketByHour`）与「官方优先、本机回退必标注」的结构切片。

| 组 | 断言点 | 抓到过的回归 |
|---|---|---|
| A | 三个窗口映射 + 服务端限额 $12/$30/$60 + used 取原值 | 字段错位 |
| B | 精确百分比与整数显示 | 取整方向 |
| C | **`month` 回落 `access.endsAt`** | 回落被删 → 2 项失败 |
| C5/C6 | **每 meter `startsAt`（month 用 `access.startsAt`）** + `windowStartIso` 官方优先/反推兜底 | 起点改用 `now - span`（忽略官方 startsAt，滚动假设 → 周窗口会偏） |
| D | 未知计费项要报出来、不能静默少一个窗口 | 改名后静默 |
| E / E2 | 异常输入不抛；**「花了钱算不出百分比」不报 0%** | 撒谎的 0% → 2 项失败 |
| E3 | `resetInSec = 0` 表示"未知"；非法 `resetsAt` 视同缺失 | 垃圾秒数 |
| F | 满额 / 超额钳位 | 出现 133% |
| G2 | **`MODELS_RANGES` 周/月档 + `MODELS_RANGE_ROLLING='24h'`** | 拿 30d 冒充 7d → 3 项失败 |
| G2b | `USAGE_COST_BY_DAY_PATH` / `COST_BUCKETS` | 趋势源写错 |
| G3 | 端点常量、`x-org-id` 头带/不带、`PERIOD_END_RESET_FIELDS` | 丢必需头 → 1 项失败 |
| H–J | 明细解析、**不产出 `quotaUsd`/`percent`**、异常输入 | 字段回潮 |
| K | **`parseCostByDay`** 升序 / 未知键 / 坏行跳过 / 空数组合法 / **缺金额跳过该桶（不补 0）** | 趋势解析 |
| L | **`modelsByWindowOf` / `seriesByWindowOf`**：三窗口 key 都产出、**空数组保留 key**、缺失不产出 | 5 小时明细丢失 / 空数组被压成缺失 |
| M | **`seriesByWindowOf` 窗口裁剪**：周=整周 7 桶（修复前 2）、窗口外桶裁掉、自然周前驱桶排除、rolling/月的边界不完整桶**保留**、缺 startAt 反推、无边界不裁、空数组保留 | 周/月序列只剩 2 天；把上一周算进来 |
| N | **`modelsRequestOf` / `seriesRequestOf`**：rolling=24h+since；**周/月 range 全量且不带 since**；rolling 缺起点 → null | 周/月被塞回 `since` → 静默只剩 2 天（R1/R2 的核心） |

**两条必须知道的测试陷阱**（本项目都犯过）：

1. **别在测试里内联一份实现。** 旧版 `test-ssr-parser.mjs` 复制了一份解析器，
   注释写「若源文件逻辑变更，请同步更新此测试」—— 源改错测试照样绿。已改用 `loadTs`。
2. **加护栏后先弄坏它一次。** 独立评审把 6 处行为改坏（并发、重试、必需头、
   键映射、服务端 tokens、range 表），当时 **49 项全绿** —— 套件只覆盖纯解析器，
   编排层是盲区。补完断言后同样 6 个实验**全部被抓到**。

**已知缺口**：`scrape` 的**串行与重试无自动化测试**（需给原生
`fetch` 打桩，而本模块刻意不用 `ctx.request`，不能复用 `test-adapters` 的桩）。
已在 `opencode-details.ts` 的函数注释里写明。
**2026-10-11 起部分收窄**：把「窗口 → 请求口径」抽成纯函数 `modelsRequestOf` /
`seriesRequestOf`（N 段），因此本任务这类「给周/月塞回 `since`」的回归**有牙**了；
仍无覆盖的是 `fetchJson` 的串行/重试与 `scrape` 的 key 落点编排。

## 7. Wrong vs Correct

### 7.1 算不出百分比时不要报 0%

```ts
// WRONG —— 0% 是一个断言，会渲染成「花了 $5.06 但 0%」
const pct = usagePercent === undefined ? 0 : clamp(Math.floor(usagePercent))
out.windows[kind] = { kind, percent: pct, resetInSec: resetInSec ?? 0, status: 'ok' }

// CORRECT —— 保留金额（真数据），不产出百分比；把"不知道"报出去
if (usagePercent === undefined && (usage ?? 0) > 0) {
  out.raw[kind] = { status: 'percent-unavailable', usage, limit, resetInSec }
  continue
}
const pct = usagePercent === undefined ? 0 : clamp(Math.floor(usagePercent))
out.raw[kind] = { status: pct >= 100 ? 'rate-limited' : 'ok', usagePercent, usage, limit, resetInSec }
out.windows[kind] = { kind, percent: pct, resetInSec: resetInSec ?? 0, status: 'ok' }
```

### 7.2 校验会话的判据不能用页面内容

```ts
// WRONG —— SPA 返回 1565 字符空壳，这个判据永不成立 → 授权一路轮询到 5 分钟超时
const html = await res.text()
return html.includes('usage-item')

// CORRECT —— 打一个"带 org 头的数据端点"，200 才算会话可用
// （别用 /api/orgs：它不带 org 头也能列，多工作区账号下会假通过）
const res = await fetch(`${CONSOLE_ORIGIN}${USAGE_SUMMARY_PATH}`, {
  headers: buildConsoleHeaders(cookie, orgId), redirect: 'manual', signal: ctrl.signal
})
return res.status === 200
```

### 7.3 诊断命令读凭据要用同一个 accessor

```ts
// WRONG —— setKey 写 items，getExtra 读 extras，两个不相干的 map，永远 null
const cookie = (await getExtra('opencodeCookie')) ?? ''

// CORRECT —— 与产品 resolveCookie 同源：分区实时优先，保存值兜底，用 getKey
const cookie = (await readPartitionCookie()) ?? (await getKey('opencodeCookie')) ?? ''
```

### 7.4 `since` 只给窗口落在保留期内的场景（周/月不带）

`since` 走服务端**约 48h 短期数据路径**；超出保留期的起点会被静默钳制到最近 2 天，
表现为「本周序列只剩 2 天、模型只剩最近 2 天」——**不报错，只是少**。

```ts
// WRONG —— 三窗口一律 since=<窗口起点>：周/月被钳到最近 2 天
for (const kind of kinds) {
  await fetchJson(modelsUrl(kind === 'rolling' ? '24h' : MODELS_RANGES[kind], starts[kind]), …)
  await fetchJson(costByDayUrl(range, bucket, starts[kind]), …)
}

// CORRECT —— since 只给 rolling；周/月用 range 全量，序列再客户端裁到窗口
modelsRequestOf(kind, starts)   // rolling → { range:'24h', since }; 周/月 → { range:'7d'|'30d' }
seriesRequestOf(kind, starts)   // rolling → { range:'24h', bucket:'hour', since }; 周/月 → { …, bucket:'day' }
seriesByWindowOf(details, windows)  // 裁到 [startAt, resetAt)（保留相交桶）
```

## 8. 已知未接线 / 未覆盖

- `/console/api/billing/status` 的 `availableMicroCents` / `balanceMicroCents`
  **已接线**（`extraCredit`，只读展示）。仍未接线的是 `renewalAuthorizationRequired`
  （页面提示需重新授权支付方式）—— 那是余额/套餐型快照之外的又一次形状扩展，应单开一轮。
- `/console/api/usage/summary`（聚合）与 `/api/usage/users`（按人）、
  `/api/providers/opencode`（模型目录+定价）本轮未用 —— 见
  `tasks/10-11-opencode-detail-v2-sync/research/console-api-v2.md`。
- `SsrUsageWindow` / `SsrRawWindow` 的 `Ssr` 前缀已名不副实（不再有 SSR），
  留待下一轮清理
- `fetchJson` 的**串行 + 重试**仍无自动化测试（见 §6 已知缺口）
