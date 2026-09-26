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
- **R4**：`fetchUsageViaCookie` 改打 `GET /console/api/usage/summary` 并**保持既有返回形状**
  （`{ windows, raw, fetchedAt }`）—— 下游 `cookieWindowsToProvider` 与所有调用方零改动。
- **R5**：`parseUsageHtml` / `parseUsagePayload` 两个纯函数被 `parseUsageSummary(json)` 取代，
  仍是**纯函数**、仍可单测，沿用「宽容取值」纪律（多个候选字段名，取到即用）。
- **R6**：`opencode-details.ts` 改打 `GET /console/api/usage/models`，
  保持 `ConsoleModelRow`（`model` / `usageUsd` / `quotaUsd` / `percent`）形状，
  供 `ConsoleDetails` 与界面继续渲染。
- **R7**：**首帧形状转储**。第一次成功拿到新端点响应时，把响应的键路径结构写进
  `/tmp/balancedeck-details.log`（沿用既有 `BALANCEDECK_DEBUG` 通道）。
  目的是让下一步按**真实**结构收紧解析器，而不是照猜的 schema 写死。
- **R8**：401/403 的错误提示必须**可操作** —— 明确说"新控制台会话无效，请重新授权"，
  并指向一键授权，而不是笼统的"cookie 已过期"。
- **R9**：`test:ssr`（现 17 项，覆盖被替换的两个纯函数）改为覆盖新解析器。
  **禁止占位式断言** —— 用真实响应做 fixture，见「卡点 C2」。
- **R10**：无回归 —— `typecheck` / `npm test` / `--uitest`（82 项）全绿；本机 db 兜底路径不变。

## 卡点（必须先解决，否则 R9 只能写占位测试）

- **C1（用户动作，阻塞）**：新控制台会话要**用户在应用里重新走一次一键授权**。
  现有 `auth` cookie 新控制台不认（`/console/auth/session` 401），无法用代码绕过。
- **C2（依赖 C1，阻塞 R9）**：拿到真实响应之后才能定字段名。
  现在的响应形状是**未知**的 —— 我只知道端点路径与查询参数（从 bundle 声明里来），
  不知道 `summary` / `models` 各字段叫什么。
  **所以 R5/R6/R9 的第一版只能是宽容解析 + R7 的形状转储，不能声称"已适配完成"。**
  诚实的完成态定义：R1–R4、R7、R8 落地且 R6 拿到过一份真实数据；解析器按真实字段收紧后才算 R9 完成。

## Acceptance criteria

- [ ] 一键授权能在 `/console/login` 完成，并解析出 workspace id（不再是靠 404 的旧路径）
- [ ] 授权后 `/console/auth/session` 不再是 401（这是"会话真的建立了"的判据，比"登录页打开了"强）
- [ ] `npm run details:test` 能打印出 `models` 端点的真实内容（不再返回 `{}`）
- [ ] 一次成功响应后，`/tmp/balancedeck-details.log` 里有该响应的键路径转储
- [ ] 拿到真实字段后，解析器收紧 + `test:ssr` 用真实 fixture 覆盖（无占位断言）
- [ ] 401 时界面提示指向"重新授权"而不是"cookie 过期"
- [ ] `typecheck` / `npm test` / `--uitest` 82 项全绿；本机 db 兜底路径行为不变

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
