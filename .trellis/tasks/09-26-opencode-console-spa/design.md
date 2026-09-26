# 技术设计：opencode 控制台明细适配新版 SPA

## 边界

本任务只动 opencode 控制台这一条凭据路径。**协议层不变** —— 仍然是「opencode-go 计划的用量」，
`CONTEXT.md` 里的协议/适配器/采集引擎分工不需要重新划分。

```
采集引擎 (engine.ts / request.ts)  ── 发请求 / 超时 / 可达性记账 / HTTP→错误映射
        │
        ├─ 官方 API 路径   opencode.ts        GET /zen/go/v1/usage  (Bearer key)   → 403 EntitlementError
        │
        └─ cookie 路径      opencode-cookie.ts ─┐
                              opencode-details.ts ┴─ GET /console/api/usage/summary   ← 改这里
                                                    GET /console/api/usage/models    ← 改这里
opencode-auth.ts  ── 一键授权（登录 URL / workspace 发现 / cookie 采集）        ← 改这里
```

**刻意不改**：`CollectorWindow` 形状、`cookieWindowsToProvider`、`ConsoleModelRow`、界面渲染、
本机 db 兜底分支。改动的终点是「数据来源换了，下游一行不动」。

## 契约

### 1. `fetchUsageViaCookie` 返回形状不变（R4 的意义）

```ts
// 现状与改后完全一致 —— 这是本设计最重要的一条约束：
// 下游 cookieWindowsToProvider / officialWindows / 界面零改动。
interface CookieFetchResult {
  windows: Partial<Record<UsageWindowKind, SsrUsageWindow>>
  raw:      Partial<Record<UsageWindowKind, SsrRawWindow>>
  fetchedAt: number
}
```

所以 `SsrUsageWindow` / `SsrRawWindow` 这两个名字虽然写着 `Ssr`，**可以先留着不改名** ——
改名会让 diff 变成"大面积重命名"，掩盖真正的行为变更。等 R9 收紧解析器时再一并清理。

> 取舍：命名先脏一点，换 diff 可读。这是刻意的。

### 2. 新增端点常量（唯一来源）

```ts
// src/main/adapters/opencode-console-api.ts（新增）
export const CONSOLE_BASE = 'https://opencode.ai/console'
export const USAGE_SUMMARY_PATH = '/api/usage/summary'
export const USAGE_MODELS_PATH  = '/api/usage/models'
```

`opencode-cookie.ts` 与 `opencode-details.ts` 都从这里取，**不再各自拼字符串**
（对齐 `TASKS.md` 记的那条纪律：环境变量名/常量只留一张表）。

### 3. 解析器：宽容取值 + 形状转储

沿用采集引擎的「宽容取值」纪律（`CONTEXT.md`：**必须显式声明，缺失即错误**的反面 ——
这里是"取到即用，取不到就降级"，但**降级必须有提示**）。

```ts
/** 从 summary 响应里取三个窗口。字段名待 R7 转储后收紧。 */
export function parseUsageSummary(body: unknown): {
  windows: Partial<Record<UsageWindowKind, SsrUsageWindow>>
  raw:     Partial<Record<UsageWindowKind, SsrRawWindow>>
  /** 认不出的字段路径 —— 提示语与日志用，避免"静默为空" */
  unknownKeys: string[]
}
```

`unknownKeys` 非空时，主进程把它写进 debug 日志并**在界面上给一句提示**
（对齐既有做法：`parseUsagePayload` 失败时抛「用量页面解析为空」而不是白屏）。

### 4. 明细：删掉整个 DOM 驱动

`opencode-details.ts` 现状是 234 行，其中约 150 行是 `EXTRACT_JS`（页面内点击「显示详情」、
轮询水合、按表头文字归属窗口、双语正则）。改后：

- 删 `EXTRACT_JS`、`LOAD_TIMEOUT_MS`、隐藏窗口的创建/销毁
- 保留：按 workspace 的 5 分钟缓存、后台非阻塞刷新（`fetchConsoleDetails` 的形状）、
  `BALANCEDECK_DEBUG` 日志通道
- 新增：`GET /console/api/usage/models?range=30d`（`range` 取自 bundle 声明的枚举）

> 这里有个**取舍**要说清：原实现的注释明确写了选 DOM 是因为"与其逆向私有 RPC 协议，
> 不如驱动窗口完成用户手动做的事，对站点改版更鲁棒"。**这个判断这次被证伪了** ——
> 改版直接把 SSR 干掉，DOM 也一起换了，而 API 反倒在 bundle 里公开声明并标了 stable。
> 所以推翻它是有实测依据的，不是潮流变化。

### 5. 认证链路（R1–R3）

| 环节 | 现状 | 改后 |
|---|---|---|
| 登录 URL | `https://opencode.ai/auth`（现在只是 302 到新登录页） | `https://opencode.ai/console/login` |
| workspace 发现 | 从 `/workspace`、`/dashboard`、`/` 的 URL/HTML 找（**三条全废**） | 从 `/console/...` 的 URL 找；兜底打 `/console/api/orgs` |
| **验证 cookie 的判据** | 「页面 HTML 含 `usage-item`」—— **SPA 下永不成立，会一路轮询到 5 分钟超时** | 打 `/console/api/usage/summary` 是否 200 |
| cookie 采集 | 只收 `opencode.ai` 域，**排除子域** | 规则要重新验证（R3） |

**验证判据为什么选 `usage/summary` 而不是 `api/orgs`**：`orgs` 在**不带** `x-org-id`
时也能列（列的就是"我属于哪些 org"），所以多工作区账号下它会对一个
根本读不到数据的会话返回 200 —— 假通过。带 org 头的数据端点才真的验证了
「这个会话能读到该工作区的数据」。

### 5b. 实测补记：workspace 改叫 org，但两种 id 前缀都合法

从 bundle 的 id 校验规则 `it(/^(org_|wrk_)/)`（同时用于 `OrgId` 与 `Actor.WorkspaceID`）：

- `wrk_` 仍合法 → **`opencodeWorkspaceId` 这个 extra 存的值继续有效，不必迁移**
- 但新站可能发 `org_` → `findWorkspaceId` 改成两种前缀都认
- **org/workspace 通过请求头 `x-org-id` 传，不是路径段**（bundle 里 `Pg="x-org-id"`，
  且在 CORS 允许头白名单里）→ 步 3/4 的每个数据请求都要带

`setWindowOpenHandler` 的域名白名单（`opencode-auth.ts:214`）也含 `opencode.ai`，
新登录会走 Google / GitHub OAuth，这条应该不用改，但要在实施时**实测确认**。

## 数据流与失败语义

```
采集一轮
  │
  ├─ 官方 API 403 EntitlementError ──────────────┐
  │                                              │
  └─ cookie 路径                                  │
       ├─ GET /console/api/usage/summary          │
       │    200 → windows/raw  → 铸快照 (official)│
       │    401 → 错误「新控制台会话无效，请重新授权」│
       │    404/5xx → 可达但不可用 → 退 local     │
       │                                          │
       └─ GET /console/api/usage/models（后台，非阻塞，下一轮生效）
            200 → ConsoleDetails（每模型明细）
            401 → 静默（明细是增强项，不影响快照）
```

**401 与 404 必须分开**：401 是"要用户去做一件事"，404/5xx 是"这条路暂时不通"。
混成一句"cookie 已过期"就是 R8 要修的那个问题。

## 兼容性

- 凭据不变（仍是 `auth` cookie + `opencodeWorkspaceId`），用户已有配置继续可用。
  只是**需要重新授权一次**才能拿到新控制台认的会话。
- 旧用户的 `opencodeKeys` 多账号 failover 逻辑不受影响（那是官方 API 路径的事）。
- 已归档的 `09-18-pet-render-fixes-tts` 无关。

## 实施顺序与回滚

| 步 | 内容 | 回滚 |
|---|---|---|
| 1 | 修 `verify-opencode.mjs` 的误导性注释与写死 fixture（先把**错误的文档**纠正） | 单文件还原 |
| 2 | `opencode-auth.ts`：登录 URL + workspace 发现（R1/R2） | 单文件还原 |
| 3 | 新增 `opencode-console-api.ts` + 改 `fetchUsageViaCookie` 打 summary（R4/R5） | 还原两个文件 |
| 4 | `opencode-details.ts` 改打 models（R6） | 单文件还原 |
| 5 | R7 形状转储 + R8 错误提示 | — |
| 6 | 真实 fixture 收紧解析器 + `test:ssr` 重写（R9） | — |

**每步独立可回滚**，因为它们是不同文件、不同层。第 3 步之前 `npm test` 必须保持全绿
（只加常量不加行为）。

**回滚的兜底姿态**：本机 db 兜底路径全程不动 —— 最坏情况是"退回本机估算 + 标注 local 可信度"，
也就是 2026-09-13 之前的状态。这是可接受的降级，不是故障。

## 风险

| 风险 | 应对 |
|---|---|
| 真实响应字段名与猜的不一样 | R7 形状转储；解析器宽容取值；C2 明确写"第一版不算适配完成" |
| 新控制台再改版 | 换成 API 之后，DOM 改版不再影响我们（只影响站点自己）；API 若改版，会有明确的 4xx 而非静默为空 |
| 401 长期修不好（用户不授权） | 明细静默降级为空，快照走 local 并标 `local` —— 与今天的既有行为一致 |
| bundle 声明 ≠ 线上实际（端点被网关下线） | 实测 401 而不是 404，说明端点存在；真下线会是 404，届时错误提示能区分 |
