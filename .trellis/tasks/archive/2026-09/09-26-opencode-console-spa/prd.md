# opencode 控制台明细适配新版 SPA

## Goal

让「每模型用量明细」和窗口百分比在 opencode 控制台改版后重新可用 —— 改版把控制台重写成
纯客户端 SPA，旧的两条抓取路径同时失效。手段是**改用新控制台自己的 JSON API**
（`/console/api/usage/*`），而不是继续解析 DOM。

用户价值：卡片上的百分比不再只能靠本机 db 估算（口径与官方不同），每模型明细重新能出。

## 本轮实测确认的事实（2026-09-26，非推测）

### 站点改版

- 控制台已重写为纯客户端 SPA。`GET /workspace/<wid>/go` 返回 1565 字符的空壳
  （`<div id="app"></div>` + `/console/assets/index-*.js`），**SSR HTML 彻底消失**：
  `data-slot` 数量 **0**，无「每月配额」字样。
- 旧路径已废弃：`/workspace/<wid>/go` → **302 → `/console/login`**；`/workspace` → **404**；
  `/auth` → **302 → `/console/login`**（所以一键授权入口还能落到新登录页，但靠它反推 workspace 的三条路径全废）。
- 新路径 `GET /console/workspace/<wid>/go` → 200，但仍是同一个空壳。

### 失效原因不是"选择器变了"，是**会话不互通**

`persist:opencode-auth` 分区里只有 1 个 cookie `auth`（有效期到 2027-09-13，未过期），
但新控制台不接受它 —— SPA 自己水合后调 `GET /console/auth/session` → **401**，
随后被守卫重定向到 `/console/login?next=%2Fconsole`。

### 两条抓取路径的后果

| 路径 | 现状 | 证据 |
|---|---|---|
| `opencode-cookie.ts` 解析 SSR 的 `data-slot="usage-item"` | **失效**（HTML 里已无此内容） | HTML 1565 字符 / 0 个 data-slot |
| `opencode-details.ts` 隐藏窗口点「显示详情」读 DOM | **失效** | `npm run details:test` → 耗时 21s、结果 `{}` |
| 官方 `GET /zen/go/v1/usage`（Bearer key） | **403** | `EntitlementError: OpenCode Go subscription required.` |
| 本机 `opencode.db` 统计 | 可用（兜底，口径不同） | `verify:opencode`：1196 条 / 31 天 |

> 所以**四条路只剩一条**。三条远端路全断，是本任务要修的。

### 新控制台有稳定的 JSON API（关键发现）

从 SPA 的公开 bundle（`/console/assets/index-*.js`，无需登录）里挖到 Effect HttpApi 的声明，
每个操作都带 OpenAPI 描述，措辞是 "Stable ..."：

| 端点 | 用途 | 取代谁 |
|---|---|---|
| `GET /console/api/usage/summary` | 窗口汇总（5h / 周 / 月 百分比） | SSR 解析（`parseUsageHtml` / `parseUsagePayload`） |
| **`GET /console/api/usage/models`** | **每模型明细** | DOM 点击「显示详情」（`opencode-details.ts` 整个 234 行） |
| `GET /console/api/usage/cost-by-day` | 按天花费 | 无（本次不用） |
| `GET /console/api/usage/users` | 按成员明细 | 无（本次不用） |

- `summary` / `cost-by-day` / `models` / `users` 四个操作都挂在 `prefix("/api/usage")` 下。
- 查询参数 `scope`：`organization | member | service_account | model`；`range`：`24h | 7d | 30d`。
- 认证：cookie 会话（与旧 `auth` cookie 不互通）；SPA 遇到 401 会打 `/auth/refresh` 自动续期。
- 实测这四个端点现在都返回 **401**（Effect 错误体 `{ _tag, message }`）—— 路径存在，会话无效。
- 旧 `GET /zen/go/v1/usage`（需付费 entitlement）与新控制台 API 是**两套东西**，
  不能互相替代：前者用 Bearer key，后者用 cookie 会话。

## Requirements

- **R1**：一键授权必须能在**新控制台**完成登录。
  `LOGIN_URL` 改为 `https://opencode.ai/console/login`（`/auth` 现在只是 302 到它）。
- **R2**：workspace id 的发现路径全部重写 —— 现有三条
  （`/workspace`、`/dashboard`、`/`）已 404 / 无用。改为从新控制台的 URL 与页面解析
  （`/console/...`）。
- **R3**：cookie 采集必须能拿到新控制台设置的会话 cookie。
  现在只按 `opencode.ai` 域收集，**排除 `auth.opencode.ai` 等子域**（这条规则要重新验证：
  新控制台可能把会话 cookie 放在子域上）。要求是"能发出被接受的请求"，不是"cookie 数量变多"。
- **R4**：`fetchUsageViaCookie` 改打 **`GET /console/api/go/status`**（**2026-09-26 修订**：
  原定 `/console/api/usage/summary`，实测后者只有用量聚合、没有 percent/limit/resetsAt）
  并**保持既有返回形状**（`{ windows, raw, fetchedAt, unknownMeters }`）——
  下游 `officialWindows` 零改动。`unknownMeters` 是新增的改版信号字段。
- **R5**：`parseUsageHtml` / `parseUsagePayload` 两个纯函数被 **`parseGoStatus(body, nowMs)`** 取代，
  仍是**纯函数**、仍可单测。**不写宽容取值分支** —— 真实字段名在 2026-09-26 已拿到，
  按真实字段写死即可，宽容分支只会在改版时把问题吞掉。
- **R6**：`opencode-details.ts` 改打 `GET /console/api/usage/models`。
  **2026-09-26 修订**：`ConsoleModelRow` 改为 `{ model, provider, usageUsd, tokens, requests }`，
  **删掉** `quotaUsd` / `percent` —— 实测该接口不提供每模型配额与百分比，
  留一个填 0 的字段会让界面显示「$0 / 0%」，那是撒谎（界面按缺省显示「—」）。
  同时**新增** `tokens` / `requests`（服务端口径，取代原先只能取本机 db 的做法）。
- **R7**：**首帧形状转储** —— 形态由「首次成功响应时写结构日志」**改为**
  「真实响应做 fixture + 结构断言」。理由：一次性的转储对回归没有约束力，
  fixture + 断言才能在改版时报警。日志通道（`BALANCEDECK_DEBUG`）保留。
- **R8**：401/403 的错误提示必须**可操作** —— 明确说"新控制台会话无效，请重新授权"，
  并指向一键授权，而不是笼统的"cookie 已过期"。400 `org_required` 单独归类。
- **R9**：`test:ssr`（原 17 项）**整体重写**为覆盖新解析器，现 72 项 0 失败。
  **禁止占位式断言** —— 用真实响应做 fixture；且**必须测真源码**（`loadTs`），
  不用内联副本（2026-09-26 删掉了那份副本）。
- **R10**：无回归 —— `typecheck` / `npm test` / `--uitest`（82 项）全绿；本机 db 兜底路径不变。

## 卡点（均已于 2026-09-26 解除）

- ~~**C1（用户动作，阻塞）**~~：用户已重新授权，`/console/auth/session` 返回 200。
- ~~**C2（依赖 C1，阻塞 R9）**~~：真实响应已拿到（`go/status` 与 `usage/models` 的完整 JSON），
  解析器按真实字段写死，fixture 取自真实响应。
- **新增卡点 C3（评审发现，仍未解除）**：`fetchRange`/`scrape` 的**并发与重试**逻辑
  无自动化测试（需要给原生 fetch 打桩，而本模块刻意不用 `ctx.request`）。
  评审实测把串行改回并发、删掉重试，测试全绿。已在代码注释里写明这个缺口。

## Acceptance criteria（2026-09-26 逐条核对）

- [x] 一键授权能在 `/console/login` 完成，并解析出 workspace id
      —— 用户已成功授权，`/console/api/orgs` 返回 `wrk_01M0…`（Default）与
      `org_01M2…`（Personal），两种前缀并存，`ORG_ID_RE` 两种都认
- [x] 授权后 `/console/auth/session` 不再是 401 —— **200**，返回 `expiresAt` 与 `user`
- [x] `npm run details:test` 打印出真实内容（不再返回 `{}`）——
      weekly 6 行 / monthly 14 行，约 1.4s（旧实现 21s 返回 `{}`）
- [x] 解析器按真实字段收紧 + `test:ssr` 用真实 fixture 覆盖 ——
      72 项 0 失败，**测真源码**（`loadTs`）不用副本
- [x] 401 时提示指向"重新授权"而不是"cookie 过期"；400 `org_required` 单独归类
- [x] 三个窗口全部来自控制台，且 `used` 是服务端精确值 ——
      实测 `used=5.05884411`（反算只会得 `16% × 30 = 4.8`）、`pct=16.9`
- [x] 限额由服务端下发（`limitMicroCents` = $12/$30/$60），不再是代码硬编码当权威
- [x] 5 小时窗口**没有**明细表（端点 range 最小 24h，口径对不上，宁可不给）
- [x] `typecheck` / `npm test`（10 套件 0 失败）/ `--uitest` 82 项全绿；本机 db 兜底不变
- [x] 独立 `trellis-check` 复核通过，2 CRITICAL + 9 WARNING 全部处置（见 `implement.md`）
- [ ] **（未做）** `fetchRange`/`scrape` 的并发与重试无自动化测试（卡点 C3）

## Out of scope

- `GET /console/api/usage/cost-by-day` 与 `/users` 的接入（先不做，端点已记录）
- 旧 `GET /zen/go/v1/usage` 的 403：`TASKS.md:490` 已有的用户侧待办
  （重新生成 API Key 并 `/connect`），那是**另一条**路，与本任务解耦
- 其它供应商的凭据探测
- 任何"猜测 schema 后写死解析器"的做法 —— 见卡点 C2

## 与既有文档的关系

- `TASKS.md`「2026-09-26 第二十一轮」里我写过一句「官方 `zen/go/v1/usage` API 正常（实测…）」——
  **那句是错的**：`scripts/verify-opencode.mjs:66-70` 的"官方 API 响应（实测）"是硬编码字面量
  （`resetsAt` 还是 9-13/14/20），脚本从不发请求。实测该端点 403。
  本任务开工时要一并修正这句与该脚本的误导性注释。
- `verify:opencode` 的定位需要重写：它现在验证的是「本机 db 统计 vs 一组写死的期望」，
  不验证任何线上行为。
