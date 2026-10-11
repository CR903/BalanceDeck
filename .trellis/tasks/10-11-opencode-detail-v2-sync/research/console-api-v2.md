# 研究：新版 opencode 控制台数据与接口（2026-10-11 实测）

> 目的：在动手前把「官网改了哪些入口、现在能拿到什么、口径如何」钉死。
> 方法：静态逆向公开 bundle + live 带真实会话探测。探针脚本 `scripts/probe-console-live.js`（只打印结构，不打印明文凭据/金额明细）。

## 0. 结论速览（决定本任务可行性）

- 官网确实改版：UI 重写，`go/status` 响应变胖（多了 `startsAt`、订阅/续费字段），并新增 `usage/cost-by-day`（按天/按小时）等端点。
- **但鉴权路径没变**：仍是 Cookie（`auth` + `__Host-console_session`）+ `x-org-id` 头，挂在 `https://opencode.ai/console/api/*` 下。现有适配器**无需迁移**。
- **四个目标的数据官网全部拿得到**（含 5 小时窗口的「每小时」与「每模型」），无需本机兜底；本机只保留为离线降级。
- 唯一拿不到的是**每模型配额/百分比**（接口从未提供，只有窗口级 `limit/used`）——按既有纪律如实标注，不伪造。

## 1. 端点全貌（live 实测，均为 `GET`，Base = `https://opencode.ai/console`）

| 端点 | 用途 | 关键响应字段 |
|---|---|---|
| `/api/go/status` | 三窗口配额 meter | `access.{startsAt,endsAt,cancelAtPeriodEnd,meters.{fiveHour,week,month}}`；meter = `{startsAt?,resetsAt?,limitMicroCents,usedMicroCents}` |
| `/api/billing/status` | 余额/额度 | `balanceMicroCents,availableMicroCents,billingMode,mode,creditLimitMicroCents,canPurchaseCredits,canEnableAutoRecharge` |
| `/api/billing/account` | 账户 | `orgId,creditLimitMicroCents,createdAt,updatedAt` |
| `/api/usage/summary` | 聚合汇总 | `totalRequests,total*Tokens,totalCostMicroCents,services[]` |
| `/api/usage/models` | **每模型明细** | `items[]{model,provider,totalRequests,total*Tokens,totalCostMicroCents}` + `pageInfo` |
| `/api/usage/cost-by-day` | **按天/按小时成本** | `[]{date,totalCostMicroCents,totalTokens,totalRequests}` |
| `/api/usage/users` | 按用户 | `items[]{userId,principalType,email,name,avatarUrl,total*,lastActiveAt}` + `pageInfo` |
| `/api/providers/opencode` | 模型目录+定价 | `models[]{providerId,modelId,apiId,name,family,status,costTiers[],capabilities{...}}`（86 个模型） |
| `/api/budgets/org` | 组织预算 | 无预算时返回 `null` |
| `/api/internal/orgs/:orgId/go/status` | 管理员内部路径 | **403 `Forbidden`**（普通用户不可用；控制台实际走 legacy `/api/go/status`） |

### 查询参数（来自公开 bundle schema，与 live 一致）

- `range ∈ {24h, 7d, 30d, all}`
- `bucket ∈ {day, hour}`（仅 `cost-by-day`）
- `since` = ISO 8601（如 `2026-10-11T07:07:31.262Z`）——**覆盖 range 的起点，实测生效**
- `models` 另有 `page/pageSize/costOrder`；`users` 另有 `page/pageSize`

### 金额单位

`*MicroCents` = **1e-8 USD 的整数字符串**（1 USD = 1e8 microcents），与现有 `USAGE_UNIT_SCALE` 同尺度，下游换算不用改。

## 2. 实测关键行为（决定实现细节）

1. **`cost-by-day bucket=hour`**：`date` 按小时取整为 UTC 边界，如 `2026-10-11T04:00:00Z`、`...T07:00:00Z`。24h 范围返回 9 个桶。
2. **`since` 精确过滤**：`bucket=hour&since=07:07:31Z` → 首桶 `07:00:00Z`、共 6 桶（floor 到小时，起点前的丢弃）。
3. **`usage/models` 的 `since` 生效**：
   - `range=7d` 全集：11 个模型，Σ cost = 763,790,290 microcents
   - `range=7d&since=<5h 前>`：8 个模型，Σ = 23,036,841
   - `range=24h&since=<5h 前>`：与上**完全相同**（8 个 / 23,036,841）
   → **`since` 覆盖 range 起点；5 小时窗口的每模型明细官方可得**。
4. **每个 meter 现在都带 `startsAt`**（旧版只有 `resetsAt`）：
   - `fiveHour`：`12:00:59Z → 17:00:59Z`（精确 5 小时滚动窗）
   - `week`：`2026-10-05T00:00:00Z → 2026-10-12T00:00:00Z`（**UTC 自然周，周一 0 点对齐**）
   - `month`：只有 `resetsAt = 2026-10-21T01:25:47Z`；周期起点 = `access.startsAt = 2026-09-21T01:25:47Z`（订阅月）
5. **鉴权**：请求头 `Cookie` + `x-org-id` 即可（探针实时 cookie 608 长度）；`/api/orgs` 可在无 org 时发现 id。

## 3. 现状代码与新版差距

- `opencode-cookie.ts:parseGoStatus` 只消费 `resetsAt`，**丢弃 `startsAt`**；`month` 靠 `PERIOD_END_RESET_FIELDS` 回落到 `access.endsAt`。窗口起点一律用 `resetAt - WINDOW_SPANS` 反推 —— 现在可以直接读 `startsAt`，更准（尤其周窗口是自然周对齐，不是「重置前 7 天」）。
- `opencode.ts:officialWindows` 的每窗口 tokens 用 `[resetAt-span, now)` 本机求和；明细 `modelsByWindow` 用 `MODELS_RANGES` 写死 `weekly→7d / monthly→30d`，且**刻意不给 rolling**（旧注释理由：range 最小 24h，口径对不上）。**该理由已被 `since` 推翻**。
- `opencode-details.ts:fetchRange` 只发 `range`，不带 `since`。
- `DetailView.tsx` 的趋势区（`TrendChart.tsx`）用**本机** `usagePredict` 历史 + 7/30 天切换，与官方窗口无关。

## 4. 目标可行性判定

| 目标 | 官方能否拿到 | 实现路径 |
|---|---|---|
| 1 用量窗口详情/模型与用量同步一致 | ✅ | 窗口边界取 `meters.*.startsAt/resetsAt`；每窗模型用 `usage/models?since=<window.startsAt>` |
| 2 趋势按 5h(每小时)/本周(每日)/本月(每日) | ✅ | `cost-by-day?bucket=hour\|day&since=<window.startsAt>` |
| 3 5h 窗口模型用量 + 配额详情 | ⚠ 部分 | 模型**用量**可得；模型**配额**接口不提供 → 展示窗口级配额 + 每模型用量 |
| 4 其他可展示数据 | ✅ | billing 余额、usage/users 按人、providers 定价目录、summary.services |

## 5. 复用与不变量（不可破坏）

- 凭据解析（`resolveCookie` / 分区实时 cookie）、`x-org-id` 头、`/console/api` base 不变。
- 金额尺度 `USAGE_UNIT_SCALE` 不变。
- 官方不可达时的**本机估算**降级链与「诚实标注」纪律（ADR-0002）不变。
- 细则：接口无 per-model quota，UI 不写 0，缺省显示「—」。

## 6. 探针复现

```bash
npx electron scripts/probe-console-live.js   # 需本机已有一次有效「一键授权」
```

（已实测：除 `/api/internal/**` 403 外，其余全部 200。）
