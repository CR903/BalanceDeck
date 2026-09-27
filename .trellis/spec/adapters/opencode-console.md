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
GO_STATUS_PATH        // '/api/go/status'        ← 配额窗口
BILLING_STATUS_PATH   // '/api/billing/status'   ← 未接线，仅记录
USAGE_SUMMARY_PATH    // '/api/usage/summary'    ← 不是窗口源！仅授权探针
USAGE_MODELS_PATH     // '/api/usage/models'     ← 每模型明细
ORG_ID_HEADER         // 'x-org-id'
USAGE_UNIT_SCALE      // 1e8  → 1 USD = 1e8 microcents
METER_FIELDS          // { fiveHour:'rolling', week:'weekly', month:'monthly' }
PERIOD_END_RESET_FIELDS // Set(['month'])
MODELS_RANGES         // { weekly:'7d', monthly:'30d' }  ← **故意没有 rolling**
MODELS_PAGE_SIZE      // 50

buildConsoleHeaders(cookie: string, orgId?: string | null): Record<string, string>
findOrgId(text: string): string | null
classifyConsoleStatus(status: number): 'unauthorized' | 'forbidden' | null
consoleAuthMessage(kind): string | null
```

两个纯解析函数（可单测，全部有真实 fixture）：

```ts
// src/main/adapters/opencode-cookie.ts
parseGoStatus(body: unknown, nowMs: number): {
  windows: Partial<Record<UsageWindowKind, SsrUsageWindow>>
  raw: Partial<Record<UsageWindowKind, SsrRawWindow>>
  unknownMeters: string[]          // 非空 = 站点改版信号
}

// src/main/opencode-details.ts
parseModelsResponse(body: unknown): ConsoleModelRow[]
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
- 输出沿用旧 `SsrRawWindow` / `SsrUsageWindow` 形状，**`officialWindows` 零改动**

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
- ⚠️ **`MODELS_RANGES` 故意不映射 `rolling`**：端点最小 range 是 24h，对不上 5 小时窗口。
  「5 小时」没有明细表是**正确行为**，不是 bug
- 401/403 → 静默降级为空明细（增强项，不该让整轮采集失败），但**必须记日志**

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
| 明细 401/403 | — | 不重试，静默降级为空 + 日志 |

> 401 与 404 必须分开：401 是"要用户去做一件事"，404/5xx 是"这条路暂时不通"。
> 笼统的「cookie 已过期或无效」已删除。

## 5. Good / Base / Bad Cases

**Good**（实测真实账号）
```
本周: used=5.05884411 limit=30 pct=16.9 note='控制台'
detail=明细分窗 key=['本周','本月']（5 小时缺席）
models: deepseek-flash $11.8085 tokens=879438123 source='console'
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

`npm run test:ssr` —— **72 项 0 失败**。`scripts/test-ssr-parser.mjs`，
用 `loadTs()` 加载**真源码**，fixture 取自真实响应（脱敏）。

| 组 | 断言点 | 抓到过的回归 |
|---|---|---|
| A | 三个窗口映射 + 服务端限额 $12/$30/$60 + used 取原值 | 字段错位 |
| B | 精确百分比与整数显示 | 取整方向 |
| C | **`month` 回落 `access.endsAt`** | 回落被删 → 2 项失败 |
| D | 未知计费项要报出来、不能静默少一个窗口 | 改名后静默 |
| E / E2 | 异常输入不抛；**「花了钱算不出百分比」不报 0%** | 撒谎的 0% → 2 项失败 |
| E3 | `resetInSec = 0` 表示"未知"；非法 `resetsAt` 视同缺失 | 垃圾秒数 |
| F | 满额 / 超额钳位 | 出现 133% |
| G2 | **`MODELS_RANGES` 取值 + 绝不能有 `rolling`** | 拿 30d 冒充 7d → 3 项失败 |
| G3 | 端点常量、`x-org-id` 头带/不带、`PERIOD_END_RESET_FIELDS` | 丢必需头 → 1 项失败 |
| H–J | 明细解析、**不产出 `quotaUsd`/`percent`**、异常输入 | 字段回潮 |

**两条必须知道的测试陷阱**（本项目都犯过）：

1. **别在测试里内联一份实现。** 旧版 `test-ssr-parser.mjs` 复制了一份解析器，
   注释写「若源文件逻辑变更，请同步更新此测试」—— 源改错测试照样绿。已改用 `loadTs`。
2. **加护栏后先弄坏它一次。** 独立评审把 6 处行为改坏（并发、重试、必需头、
   键映射、服务端 tokens、range 表），当时 **49 项全绿** —— 套件只覆盖纯解析器，
   编排层是盲区。补完断言后同样 6 个实验**全部被抓到**。

**已知缺口**：`fetchRange`/`scrape` 的**串行与重试无自动化测试**（需给原生
`fetch` 打桩，而本模块刻意不用 `ctx.request`，不能复用 `test-adapters` 的桩）。
已在 `opencode-details.ts` 的函数注释里写明。

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

## 8. 已知未接线 / 未覆盖

- `/console/api/billing/status` → `availableMicroCents`（实测 $5.00 可用额外额度）、
  `renewalAuthorizationRequired`（页面提示需在 Oct 21 前重新授权支付方式）。
  **两者都是真实可用的数据源**，接入要改快照形状（余额型 vs 套餐型），应单开一轮
- `/console/api/usage/summary` 与 `cost-by-day` 可用于"本机 vs 全局"对照，本轮未用
- `SsrUsageWindow` / `SsrRawWindow` 的 `Ssr` 前缀已名不副实（不再有 SSR），
  留待下一轮清理
