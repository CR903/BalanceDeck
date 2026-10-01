# Research: 可用来源与代价 —— 端点、鉴权、结构性风险

- **Query**: 有哪些可用来源？各自的代价是什么？是否结构性违反「出网采集」模型？
- **Scope**: mixed（端点事实 + 本仓库契约）
- **Date**: 2026-10-01

---

## 0. ⚠️ 对「结构性风险」这个问题的直接回答

任务书假设了两种可能：「只能读本机文件」或「只有出网 API 且需要浏览器 cookie」。
**实测结论：两个假设都不完全成立，真实形态是第三种 ——**

> **数据必须出网取（服务端权威），但鉴权材料来自本机（Cursor 自己维护的登录态）。**

这与 `copilot.ts` **完全同构**：

| | Copilot | Cursor |
|---|---|---|
| 数据来源 | `api.github.com/copilot_internal/v2/user`（出网） | `api2.cursor.sh/.../GetCurrentPeriodUsage`（出网） |
| 凭据来源 | `~/.config/github-copilot/apps.json`（本机文件） | `state.vscdb` / `auth.json` / Keychain（本机） |
| 采集器形态 | `officialSnap`（声明为官方） | 同 |
| 预设标记 | `localCredential: true, singleton: true` | 应当相同 |

⇒ **不违反出网采集模型。** 与 `claude.ts` / `codex.ts`（真的只读本机转录、只能给 `local`）性质不同，
Cursor 能拿到服务端真值，应当声明 `official`。

**唯一真实的结构性风险是「过期」**，见 §5。

---

## 1. 端点清单（按推荐度排序）

### ① `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` —— **推荐**

Connect RPC v1（JSON over HTTP）。请求体固定 `{}`。

必需头：
```
Authorization: Bearer <accessToken>
Content-Type: application/json
Connect-Protocol-Version: 1
```

真实响应（2026-08-12 官方论坛用户贴出，已脱敏；检索 2026-10-01）：
```json
{
  "billingCycleStart": "1768399334000",
  "billingCycleEnd":   "1771077734000",
  "planUsage": {
    "totalSpend": 23222,        // 分 = includedSpend + bonusSpend
    "includedSpend": 23222,     // 分 = 计入套餐限额的部分
    "bonusSpend": 0,
    "remaining": 16778,         // 分 = limit - includedSpend
    "limit": 40000,             // 分 = 套餐额度（Pro=2000 / Ultra=40000）
    "remainingBonus": false,
    "bonusTooltip": "…",
    "autoPercentUsed": 0,
    "apiPercentUsed": 46.444,
    "totalPercentUsed": 15.48
  },
  "spendLimitUsage": {
    "totalSpend": 0, "pooledLimit": 50000, "pooledUsed": 0, "pooledRemaining": 50000,
    "individualLimit": 10000, "individualUsed": 0, "individualRemaining": 10000,
    "limitType": "user"
  },
  "displayThreshold": 200,
  "enabled": true,
  "displayMessage": "You've used 46% of your usage limit",
  "autoModelSelectedDisplayMessage": "…",
  "namedModelSelectedDisplayMessage": "…"
}
```

**未鉴权可达性实测（2026-10-01，本机 curl，无任何凭据）：**
```
POST → 401
{"code":"unauthenticated","message":"Error","details":[{"type":"aiserver.v1.ErrorDetails",
 "debug":{"error":"ERROR_NOT_LOGGED_IN","details":{"title":"Authentication error",
 "detail":"If you are logged in, try logging out and back in.","isRetryable":false,
 "analyticsMetadata":{"actionRequired":"login"}}}…]}
```
⇒ 端点存在、协议是 Connect（错误体带 `code`/`details[]` 结构）、缺登录态时明确回 `ERROR_NOT_LOGGED_IN`。
**这是本次调研唯一「本机实测过」的事实**（只验证了未鉴权分支）。

⚠ **不变量（可用来做断言）**：`includedSpend + remaining === limit`
（23222+16778=40000 ✅；论坛样本 1288+712=2000 ✅）

同族端点（都可同头同体调用）：
- `POST …/DashboardService/GetPlanInfo` → `{ planInfo: { planName, includedAmountCents, price, billingCycleEnd } }`
  —— **拿套餐名的正解**（`GetCurrentPeriodUsage` 不含 `membershipType`）。
- `POST …/DashboardService/GetUsageLimitStatusAndActiveGrants` → 限流阶段 + 赠送额度（响应未文档化）
- `POST …/DashboardService/GetUsageLimitPolicyStatus` → 是否进 slow pool（响应未文档化）

### ② `GET https://cursor.com/api/usage-summary` —— 备选（cookie 路径）

需要 `WorkosCursorSessionToken` cookie，值由**同一个 JWT 合成**：
```
WorkosCursorSessionToken = <userId>%3A%3A<accessToken>
userId = JWT.sub 按最后一个 "|" 切分的后半段（形如 auth0|user_abc → user_abc）
```

真实响应（live Ultra 账号，来源 ai-usagebar 源码注释，检索 2026-10-01）：
```json
{
  "billingCycleStart": "2026-07-04T00:35:51.000Z",   // ← RFC3339，不是毫秒
  "billingCycleEnd":   "2026-08-04T00:35:51.000Z",
  "membershipType": "ultra",
  "isUnlimited": false,
  "individualUsage": {
    "plan": { "enabled": true, "used": 40000, "limit": 40000, "remaining": 0,
              "autoPercentUsed": 98.109, "apiPercentUsed": 100, "totalPercentUsed": 98.5128 },
    "onDemand": { "enabled": true, "used": 1785, "limit": 35000, "remaining": 33215 }
  },
  "teamUsage": {}
}
```
- **含 `membershipType`（套餐名）与 `isUnlimited`** —— 这是 ① 缺的。
- 金额同样是**分**。
- 部分实现会伪装 User-Agent 为 `cursor-agent/<version>`（vibe_coding_tracker、CodexBar）——
  **是否必需未验证**。

**未鉴权可达性实测（2026-10-01）：**
```
GET → 401
{"error":"not_authenticated","description":"The user does not have an active session or is not authenticated"}
```

### ③ `GET https://cursor.com/api/auth/me` —— 账号身份（可选）

稳定 user id / email / name。用于 `detail` 回显「当前是哪个账号」。

### ④ `POST https://cursor.com/api/dashboard/get-sand-usage-status` —— Grok Bot 周额度（可选）

`usagePercent` + `nextResetTimestampUtc`。**需要 `Origin: https://cursor.com`（CSRF）**。
Best-effort：失败不影响月度两条。

### ⑤ `POST https://cursor.com/api/dashboard/get-filtered-usage-events` —— 每请求成本明细（**本次不做**）

需 cookie + 匹配 `Origin`；1000 条/页，最多 200 页；CodexBar 实测 **403 会触发 6 小时冷却**。
体量大、限流狠、跟「订阅/额度查询」不是一件事 → **明确排除**。

### ⑥ `POST https://api2.cursor.sh/oauth/token` —— token 刷新（**本次不做**）

`grant_type=refresh_token` + `client_id` → 新 access_token；`shouldLogout:true` 表示 refresh token 失效。
**本仓库不应实现它**（见 §5 的自愈决策）。

---

## 2. 鉴权材料来源（按优先级）

| # | 来源 | 路径 / 取法 | 平台 | 代价 |
|---|---|---|---|---|
| 1 | **Cursor IDE `state.vscdb`** | macOS `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`；Windows `%APPDATA%\Cursor\User\globalStorage\state.vscdb`；Linux `$XDG_CONFIG_HOME/Cursor/User/globalStorage/state.vscdb`。SQLite 表 `ItemTable`，key `cursorAuth/accessToken` | 三平台 | 需 `node:sqlite`（仓库已用，见 `opencode.ts:122`）。⚠ WAL 陷阱见 §4 |
| 2 | **Cursor CLI `auth.json`** | 纯 JSON，含 `accessToken` / `refreshToken`。路径**分歧**：<br>· CAAM 实测（2026.09.18 bundle）：macOS `~/.cursor/auth.json`、Linux `$XDG_CONFIG_HOME/cursor/auth.json`、Windows `%APPDATA%\Cursor\auth.json`<br>· ai-usagebar 用 `config_dir()/cursor/auth.json`（macOS 上 = `~/Library/Application Support/cursor/auth.json`）<br>· Cursor 官方文档只给了 `~/.cursor/cli-config.json`，**没提 auth.json** | 三平台 | 路径需多候选试探；`CURSOR_CONFIG_DIR` 环境变量可覆盖 |
| 3 | **macOS Keychain** | 条目 `cursor-access-token` / `cursor-refresh-token` | 仅 macOS | ⚠ 读**别的 App 的钥匙串条目**会触发系统授权弹窗 → **不建议** |
| 4 | **浏览器 cookie 导入** | Safari `~/Library/Cookies/Cookies.binarycookies`；Chrome `~/Library/Application Support/Google/Chrome/*/Cookies`；Firefox `…/cookies.sqlite`。域名 `cursor.com`/`cursor.sh`，需要 `WorkosCursorSessionToken` 或 `__Secure-next-auth.session-token` | 仅 macOS | 钥匙串/文件权限、Chrome 加密、**可能弹窗** → **不建议** |
| 5 | **用户手动粘贴 token** | 设置页 → `providers:update` 的 `key` 字段 → `setKey(inst.id)` → **`items`（safeStorage 加密）** | 三平台 | 需要用户自己去抠 JWT；会过期 |

**同库里的其它 key**（`state.vscdb`，PaceBar 文档列出）：
`cursorAuth/refreshToken`、`cursorAuth/cachedEmail`、`cursorAuth/stripeMembershipType`（`pro`/`ultra`…）、
`cursorAuth/stripeSubscriptionStatus`。

⇒ **`stripeMembershipType` 可以零成本拿到套餐名**，比多打一次 `GetPlanInfo` 更省。

---

## 3. 明确推荐

> **主源：Cursor IDE `state.vscdb` 的 `cursorAuth/accessToken`（无则回落 CLI `auth.json` 的 `accessToken`）**
> **请求：`POST api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`（Bearer + Connect 头 + `{}`）**
> **套餐名：先读同库的 `cursorAuth/stripeMembershipType`；拿不到再打 `GetPlanInfo`（可选，第二请求）**
> **用户手动粘贴的 token 作为最后兜底（`items`），优先级最低**
> **percent 一律由绝对值自算（`includedSpend / limit`），不信 `*PercentUsed`**

理由：
1. 与 `copilot.ts` 同构 —— 本机读凭据 + 出网取数 + `officialSnap`，无需任何新架构。
2. 端点是 Connect RPC 而**非** GET，声明表工厂表达不了（见 `05-repo-contract-mapping.md`）。
3. Bearer 路径**不需要浏览器会话 cookie**，避开了 Keychain/浏览器 DB 权限与弹窗问题。
4. 绝对值（`includedSpend`/`limit`/`remaining`）满足 `includedSpend+remaining===limit` 不变量，
   可自校验；百分比字段语义在社区里有三种互相矛盾的解读（见 §4），不可信。

---

## 4. ⚠️ 最大的口径陷阱：`totalPercentUsed` 不可信

同一字段在四份独立材料里有**互相矛盾**的解读：

| 来源 | 解读 | 依据 |
|---|---|---|
| PaceBar 文档 | = 已用百分比；`limit` 缺失时回落 `(limit-remaining)/limit*100` | 文档示例 `totalSpend 23222 / limit 40000` 但 `totalPercentUsed 15.48` —— **两者本身就不一致** |
| ai-usagebar | = 已用百分比（98.5 配 used=limit=40000） | live Ultra 样本 |
| VibeCodingTracker | **= 剩余百分比**（新账号 `used==0` 却 `totalPercentUsed==94`），代码里做了 `100 - p` 反转 | live free 样本 |
| Cursor 官方员工（论坛 2026-08-13） | 「这三个 percent 字段**不是** `totalSpend/limit`，它们反映另一个内部指标，不会等于那个除法。属预期行为。」 | 官方回复 |

**结论**：`totalPercentUsed` 在某些账号上与 `includedSpend/limit` 差一个数量级
（官方论坛样本：真实 64.4%，字段值 3.73）。**用它做进度环 = 撒谎。**

⇒ **只用绝对值自算 percent**（`roundPercent(includedSpend/limit*100)`，落进 `ProviderWindow.percent`）。
⇒ 两个子池（`autoPercentUsed` / `apiPercentUsed`）**没有对应的绝对值**，无法自校验 →
**建议 v1 不展示**（或展示但在 detail 里标注口径来自服务端百分比字段）。
⇒ 绝不做 `100 - p` 这种反转（那是社区某个账号的观察，不是契约）。

---

## 5. 过期与自愈

| 事实 | 来源 |
|---|---|
| access token 是**短期 JWT**，Cursor 自己的 app/CLI 会在过期前刷新并**回写**到 SQLite / Keychain | PaceBar 文档 |
| CodexBar：「token 只在 JWT `exp` 距今 > 60s 时使用；**CodexBar 从不刷新它**」 | CodexBar docs/cursor.md |
| VibeCodingTracker：「token 有效期 ~60 天，官方 CLI/IDE 在后台保持 `auth.json` 新鲜；刷新是**被动的**」 | 源码注释 |
| 401/403 → 需要重新登录；过期 token 自己**无法**刷新 | VibeCodingTracker / CodexBar 一致 |

**决策**：
- **不要实现 `oauth/token` 刷新**。Cursor 自己就是刷新权威；我们抢在它前面刷新会与它抢写同一个文件，
  并且要在本仓库里长期保存 `refreshToken`（扩大凭据面）。
- **不要把 token 缓存进 `items`**。缓存副本必然比 Cursor 自己维护的那份旧（Cursor 每 60s 刷新一次采集，
  缓存只会越来越过期）。
- ⇒ **每轮从本机源重读 token**（一次 SQLite 只读查询，成本可忽略），**不做任何 `setKey` 自愈回写**。
  这与 `opencode.ts` 的 cookie 自愈**不同**：那里的 session 由服务端每次响应轮换、必须回写；
  这里的刷新权在 Cursor 手里，我们回写只会制造冲突。
- 兜底的用户粘贴 token（存 `items`）**永不自动刷新**；它过期时提示用户重新粘贴。

---

## 6. 其它实测/已知事实

- **端点存在性已在本机 curl 验证（2026-10-01，无凭据）**：
  - `POST api2.cursor.sh/.../GetCurrentPeriodUsage` → `401` + `ERROR_NOT_LOGGED_IN`
  - `GET cursor.com/api/usage-summary` → `401` + `not_authenticated`
  两者都不是 404/405，说明路径与服务都还活着。
- **`GET /api/usage?user=ID` 是 legacy request-based 计划的老端点**，不要拿来当主源。
- **限流**：官方文档只给了 `api.cursor.com`（Admin/Analytics）的配额表，
  `api2.cursor.sh` 的 dashboard 端点**没有公开配额**（**未验证**）。
  CodexBar 对 `get-filtered-usage-events` 的实测是 403 → 6 小时冷却。
  本仓库默认刷新 60s（`scheduler.ts:29 DEFAULT_INTERVAL = 60_000`），单实例单请求，
  量级远低于任何合理限流 → **先不额外限速，把 429 当可诊断错误处理**。
- **CSRF**：只有 `cursor.com/api/dashboard/*` 的 **POST** 需要匹配 `Origin`；
  `api2.cursor.sh` 的 Connect 端点与 `GET /api/usage-summary` 不需要（**未验证 Origin 是否被检查**）。
- **`.trellis/spec/guides/external-api-integration.md` Step 1 的教训直接适用**：
  「在 bundle/文档里声明的端点不证明它带着你要的数据」。
  `GetUsageLimitPolicyStatus` / `GetUsageLimitStatusAndActiveGrants` 的响应形状就是活例子（社区都写「响应未文档化」）。

---

## Caveats / 未验证

- 端点响应形状全部来自第三方记录（论坛贴文 + 各项目源码/文档），**本机没有 Cursor 账号可抓真实响应**。
  其中 `GetCurrentPeriodUsage` 的样本有**两个独立来源**（PaceBar 文档 + Cursor 官方论坛贴文），互相印证，可信度较高。
- `billingCycleStart/End` 的单位在两个端点不同（ms-string vs RFC3339）—— 已在上文标注，解析器必须分别处理。
- 「Cursor 无官方个人额度 API」这一判断基于 2026-10-01 的 `cursor.com/docs/api` 页面内容；官方随时可能补上。