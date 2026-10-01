# Research: Antigravity 额度怎么查（端点 / 凭据 / 本机数据）

- **Query**: 有没有官方 API / CLI / 本地状态文件？需要什么凭据？
- **Scope**: external
- **Date**: 2026-10-01（检索日期）

---

## 结论先行

**有出网 API。** 首选路径是 Google Cloud Code 的 `v1internal:retrieveUserQuotaSummary`（POST + Bearer OAuth），**不是**只能读本机文件。

但**凭据必须从本机取**（macOS Keychain / SQLite / 旧版 token 文件），所以这是「**凭据来自本机、数据来自出网**」的混合模型 —— 与本仓库已支持的 `opencode.ts`（本机 opencode.db 凭据 + 出网 usage API）、`copilot.ts`（本机 apps.json + 出网 API）**完全同构**，不是新的架构问题。

---

## 1. 出网端点（首选）

### 1.1 主端点 `retrieveUserQuotaSummary`

```
POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
Authorization: Bearer <google_oauth_access_token>
Content-Type: application/json
User-Agent: antigravity/…

body: {}   或   {"project": "<cloudaicompanionProject>"}
```

响应（多来源交叉一致）：

```jsonc
{
  "groups": [
    {
      "displayName": "Gemini Models",
      "description": "Models within this group: Gemini Flash, Gemini Pro",
      "buckets": [
        { "bucketId": "gemini-weekly", "displayName": "Weekly Limit Remaining",
          "window": "weekly", "resetTime": "2026-08-29T12:08:59Z", "remainingFraction": 0.583 },
        { "bucketId": "gemini-5h", "displayName": "Five Hour Limit Remaining",
          "window": "5h", "resetTime": "2026-08-27T15:45:28Z", "remainingFraction": 0.853 }
      ]
    },
    {
      "displayName": "Claude and GPT models",
      "buckets": [ /* 同形，5h + weekly */ ]
    }
  ]
}
```

**必须宽容解析的形状差异**（竞品实现里都写了，因为字段名在多个版本间不一致）：

| 位置 | 写法 A | 写法 B | 写法 C |
|---|---|---|---|
| groups 数组 | 顶层 `groups` | `response.groups` | `summary.groups` |
| 剩余比例 | `bucket.remainingFraction` | `bucket.remaining_fraction` | `bucket.remaining.case === 'remainingFraction'` 时取 `.value` |
| 重置时间 | `bucket.resetTime` | — | — |

> 来源：[`aqua5230/usage` `agy_quota_probe.py` 的 `_extract_groups` / `_remaining_fraction`](https://github.com/aqua5230/usage/blob/refs/heads/main/agy_quota_probe.py)（AGPL-3.0-only，仅读思路）、[`quotas` crate `antigravity.rs`](https://docs.rs/quotas/latest/src/quotas/providers/antigravity.rs.html)（含 live fixture）、[can1357/oh-my-pi#9940](https://github.com/can1357/oh-my-pi/issues/9940)（贴真实 JSON）

### 1.2 前置端点 `loadCodeAssist`

```
POST <base>/v1internal:loadCodeAssist
{"metadata":{"ideType":"ANTIGRAVITY","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}}
```

用途：
- 取 `cloudaicompanionProject`（后续请求的 project id）
- 取 `currentTier` / `paidTier` → 套餐名

⚠ **重要陷阱（来源明确写出来了）**：不带 project 的 quota 查询会**假报 100% 剩余**。
> 「UsageBar first resolves the account's Cloud AI Companion project. A quota response without this project is rejected because projectless model requests can falsely report `100%` remaining.」
> —— [usagebar `docs/providers/antigravity.md`](https://raw.githubusercontent.com/luisleineweber/usagebar-fork-archive/main/docs/providers/antigravity.md)（MIT，fork 自 openusage）

但另一家实现说「Project is optional for the summary endpoint (empty body works)」（`quotas` crate 注释）。**两条冲突 → 实现时必须实测。** 保守做法：先 `loadCodeAssist` 拿 project，再带 project 请求；拿不到 project 时**不报数字**（按 external-api-integration.md Step 4「口径不一致时宁可不显示」）。

⚠ 另一个坑：`currentTier` 对 Google AI Pro 账号也返回 `free-tier`，**真实订阅在 `paidTier`**（`g1-pro-tier` / Google AI Pro）。

### 1.3 Base URL 候选（按序回退）

1. `https://daily-cloudcode-pa.googleapis.com`
2. `https://daily-cloudcode-pa.sandbox.googleapis.com`
3. `https://cloudcode-pa.googleapis.com`

> 来源：usagebar 文档；`noeFabris/opencode-antigravity-auth` 的 debug 日志显示 IDE 实际会打 sandbox 主机

### 1.4 回退端点 `fetchAvailableModels`（只有 5h 窗口）

```
POST <base>/v1internal:fetchAvailableModels
{"project": "<cloudaicompanionProject>"}
```

响应按模型给 `quotaInfo.remainingFraction` / `resetTime`。**只有 5 小时窗口，没有 weekly**。多家实现用它合并成池（取池内最差 fraction）。

**建议：不做这一层回退。** 口径不同（只有 5h），external-api-integration.md Step 4 明确「不得近似」。且它是 per-model 的，要自己合并 —— 这正是 oh-my-pi#9940 被修掉的 bug。

---

## 2. 本机数据源（凭据）

### 2.1 macOS Keychain（首选）

```bash
security find-generic-password -a antigravity -s gemini -w
```

- service = `gemini`，account = `antigravity`
- 值是 JSON：**可能**被 go-keyring 包了一层 `go-keyring-base64:` 前缀（要先剥 base64 再 parse）
- 内部形状：`{ "token": { "access_token", "refresh_token", "expiry" } }`

> 来源：`agy_quota_probe.py` 的 `_read_macos_credential` / `_parse_keyring_secret`；[google-antigravity/antigravity-cli#51](https://github.com/google-antigravity/antigravity-cli/issues/51) 佐证 keychain item 存在但 `agy` 内部 1s 超时（该 issue 也说明 **IDE/CLI 自身读 keychain 有 bug**，我们的读取要独立做）

### 2.2 IDE SQLite（本机文件，IDE 侧凭据）

- 路径（macOS）：`~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb`
  - 新版目录名是 `Antigravity IDE`，旧版是 `Antigravity`（两个都要试）
- Windows：`%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb`
- Linux：`~/.config/Antigravity IDE/User/globalStorage/state.vscdb`
- 表：`ItemTable(key TEXT, value TEXT)`

三个有用的 key：

| key | 内容 | 可用性 |
|---|---|---|
| `antigravityAuthStatus` | `{"apiKey":"ya29.…","email":…,"name":…}` | ✅ 纯 JSON，最好读 |
| `antigravityUnifiedStateSync.oauthToken` | OAuth token JSON | ✅ |
| `jetskiStateSync.agentManagerInitState` | base64 protobuf，field #6 = `OAuthTokenInfo{access_token, token_type, refresh_token, expiry}` | ⚠ 要手写 protobuf wire parser |

> 来源：[jackwener/open-antigravity `src/bridge/statedb.ts`](https://github.com/jackwener/open-antigravity/blob/fab75833/src/bridge/statedb.ts)（读 `antigravityAuthStatus.apiKey`）、usagebar 文档（protobuf 结构）、[ericxliu.me 反向工程笔记](https://ericxliu.me/posts/reverse-engineering-antigravity-ide/)（2026-01-16）

⚠ **SQLite 读取需要 `sqlite3` CLI 或 node 原生库**。本仓库目前没有 node-sqlite3 依赖（`package.json` 待确认），copilot/claude/codex 都只读文本文件。**这是实现成本的主要来源。**

### 2.3 旧版 token 文件（回退）

`~/.gemini/antigravity-cli/antigravity-oauth-token` —— 纯 JSON，只读。

### 2.4 CLI 配置目录（不是凭据）

`~/.gemini/antigravity-cli/settings.json` —— 只有偏好设置（`modelProvider`、`statusLine` 等），**无凭据**。不要指望它。

### 2.5 本机对话库（token 用量，不是额度）

`~/.gemini/antigravity-cli/conversations/*.db` / `~/.gemini/antigravity-ide/conversations/` —— protobuf generation-accounting 记录，可算 token 与估算花费。openusage 用它做「今日/昨日/30 天花费」。

**本任务建议不做**（与 quota 是两个口径，且引入 protobuf 解析 + 定价表）。

---

## 3. 刷新 token

```
POST https://oauth2.googleapis.com/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&refresh_token=…&client_id=…&client_secret=…
```

各实现内嵌的 **Antigravity 公开客户端**（RFC 8252 installed-app public client）：
- `client_id` = `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`
- `client_secret` = `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`

> 这些值来自 `agy_quota_probe.py`（**AGPL-3.0-only**）与 `pi-antigravity`（jsDelivr 包，未核许可）。
> 该文件的注释自己论证了合理性：「RFC 8252 installed apps cannot keep a client secret confidential, so this is a public client, not a security boundary. It is not the user's credential and grants nothing on its own.」
>
> ⚠ **但这是从 AGPL 源码抄来的字面量**，落在「参考思路自己重写；若复用片段必须在文件头附声明」的边界内。**需要用户拍板**（见 `06-open-questions.md` Q2）。可行替代：不内嵌，只在 access_token 过期时如实报「凭据已过期，请在 Antigravity 中重新登录」—— 代价是用户要手动操作。

---

## 4. 本机实测记录（2026-10-01，这台开发机）

```
~/.gemini                              → 不存在
~/Library/Application Support/Antigravity* → 不存在
~/Library/Preferences/*antigravity*    → 无
~/Library/Caches/*antigravity*         → 无
which antigravity / agy                → not found
security find-generic-password -a antigravity -s gemini → item not found
find ~ -maxdepth 3 -iname "*antigravity*" → 无
```

⇒ **本机无法实测任何端点/凭据。** 所有 fixture 只能来自二手实录（`quotas` crate 的 `retrieve_user_quota_summary_live.json` 是唯一带日期的实录：2026-07-14）。

⇒ **对 external-api-integration.md Step 2 的直接影响**：任何 fixture 都只是 fixture，不是活系统证据；文案**不得**写「实测」。实现完成后必须让有 Antigravity 的用户跑一次真机验证。