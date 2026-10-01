# Research 01 — Gemini Code Assist 额度协议与可选来源

- **Query**: Gemini Code Assist 的额度到底怎么查？有无官方 quota API？需要什么凭据？可选来源与代价？竞品怎么做的、许可是什么？
- **Scope**: mixed（外部协议调研 + 仓库基线核对）
- **Date**: 2026-10-01
- **对应任务问题**: Q1（额度怎么查）、Q2（可选来源与代价）、Q8（踩坑预判）

---

## 0. 一句话结论（先看这个）

> **有一个事实上的权威额度端点，但它不是公开文档化的 API**：
> `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`
> —— 这正是 Gemini CLI 官方自己用的那个（`google-gemini/gemini-cli`，Apache-2.0）。
> 它返回**逐模型的 `remainingFraction`（0–1）+ `resetTime`**，是**每账号**权威读数。
> 前置一次 `POST /v1internal:loadCodeAssist` 拿 `cloudaicompanionProject`（配额归属项目 id）。
>
> **不需要抓 Google Cloud Console，不需要 Cloud Quotas API。**

---

## 1. Q1：有没有官方的用量 / 配额 API？

### 1.1 官方文档里「有」和「没有」的是两回事

| 来源 | 有没有额度 API | 说明 |
|---|---|---|
| [Gemini for Google Cloud — Quotas and limits](https://docs.cloud.google.com/gemini/docs/quotas) | ❌ 只有**数字**，没有查询接口 | 列出各档限额：Code Assist Individual 6000 code req/day、240 chat req/day；Gemini CLI + agent mode 共享：Standard 1500 / Enterprise 2000 req/user/day；个人 Google 账号 1000 req/day |
| [Monitor Gemini Code Assist usage](https://docs.cloud.google.com/gemini/docs/codeassist/monitor-gemini-code-assist) | ⚠️ 有，但是**组织级聚合**，不是个人额度 | Cloud Monitoring 指标（`code_assist/daily_active_users`、`chat_responses_count`、`code_assist/code_lines_accepted_count`）。需要 `roles/monitoring.viewer` + `roles/geminicloudassist.user`，且**只记录 IDE 内交互** |
| [Cloud Quotas API](https://docs.cloud.google.com/docs/quotas/reference/rest)（`cloudquotas.googleapis.com`） | ⚠️ 有，但是 **project/folder/org 级** | `GET /v1/{parent=projects/*/locations/*}/services/*/quotaInfos`。粒度是项目级配额，**拿不到「per-user Code Assist 请求数」**（因为 Code Assist 限额是 per user per day，不是 per project 配额项） |
| `cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` | ✅ **有，且是 per-account 权威读数** | **未在公开文档中记载**，但由 Google 自己的 Gemini CLI 客户端调用 |

**结论**：Google 没有发布「Gemini Code Assist 个人额度查询」的公开 API。Cloud Monitoring / Cloud Quotas 两条路都拿不到个人口径。唯一能拿到 per-account 真值的是 Gemini CLI 内部用的 `v1internal:*` 端点族。

### 1.2 端点细节（已从 gemini-cli 源码逐字核对）

`google-gemini/gemini-cli`（Apache-2.0）`packages/core/src/code_assist/server.ts`：

```ts
export const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
export const CODE_ASSIST_API_VERSION = 'v1internal';
getMethodUrl(method) { return `${base}/${version}:${method}` }   // → .../v1internal:<method>
```

**① 查配额**

```
POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
Content-Type: application/json
Authorization: Bearer <access_token>

{ "project": "<cloudaicompanionProject>", "userAgent": "<optional>" }
```

响应类型（`packages/core/src/code_assist/types.ts`，逐字）：

```ts
export interface BucketInfo {
  remainingAmount?: string;    // int64 以字符串表示；【100% 时该字段被省略】
  remainingFraction?: number;  // 0.0–1.0，1.0 = 100% 剩余
  resetTime?: string;          // RFC3339，如 "2026-05-23T02:48:06Z"
  tokenType?: string;          // 实测 "REQUESTS"（也有 INPUT_TOKENS / OUTPUT_TOKENS 桶）
  modelId?: string;            // 实测 "gemini-3.1-pro-preview"
}
export interface RetrieveUserQuotaResponse {
  buckets?: BucketInfo[];
}
```

**真实响应样本**（来自 [gemini-cli issue #27363](https://github.com/google-gemini/gemini-cli/issues/27363)，用户贴出的原始返回）：

```json
{
  "resetTime": "2026-05-23T02:48:06Z",
  "tokenType": "REQUESTS",
  "modelId": "gemini-3.1-pro-preview",
  "remainingFraction": 1
}
```

⚠️ 注意 `remainingAmount` 在 100% 时**被 Google 省略**——这是 gemini-cli 自己的一个 bug（#27363），我们不能重蹈。

**② 拿 tier + 配额归属项目**

```
POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist
Content-Type: application/json
Authorization: Bearer <access_token>

{
  "cloudaicompanionProject": "<可省>",
  "metadata": { "ideType": "IDE_UNSPECIFIED", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI" }
}
```

响应（`types.ts` 逐字）：

```ts
export interface LoadCodeAssistResponse {
  currentTier?: GeminiUserTier | null;   // { id, name, description, isDefault, hasOnboardedPreviously, availableCredits }
  allowedTiers?: GeminiUserTier[] | null;
  ineligibleTiers?: IneligibleTier[] | null;   // { reasonCode, reasonMessage, tierId, tierName, validationUrl, ... }
  cloudaicompanionProject?: string | null;     // ← 配额归属项目 id
  paidTier?: GeminiUserTier | null;            // 付费档，含 availableCredits
}
export const UserTierId = { FREE: 'free-tier', LEGACY: 'legacy-tier', STANDARD: 'standard-tier' }
```

`metadata` 是**必填**（`LoadCodeAssistRequest.metadata` 非可选）。gemini-cli `setup.ts` 用的就是上面那组三字段常量。

**③ 刷新 access token**

```
POST https://oauth2.googleapis.com/token
Content-Type: application/x-www-form-urlencoded

client_id=...&client_secret=...&refresh_token=...&grant_type=refresh_token
```

注意是 **form-encoded**，不是 JSON —— 与 `readJson` 的假设不同。

### 1.3 需要的凭据

| 凭据 | 用途 | 形态 |
|---|---|---|
| Google OAuth **refresh_token** | 换 access_token | 长效，scope 含 `cloud-platform` |
| `client_id` / `client_secret` | 换 token 时一并提交 | Gemini CLI 的「installed application」client |
| access_token | 调 `v1internal:*` | 约 1 小时过期 |

Gemini CLI 内置的 OAuth client（`packages/core/src/code_assist/oauth2.ts`，Apache-2.0）：

```
client_id     = 681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com
client_secret = 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
scope         = https://www.googleapis.com/auth/cloud-platform
                https://www.googleapis.com/auth/userinfo.email
                https://www.googleapis.com/auth/userinfo.profile
```

**这不是密钥泄漏**：源码注释直接引用了 Google 官方对 installed-app 的说明 ——
*"The process results in a client ID and, in some cases, a client secret, which you embed in the source code of your application. (In this context, the client secret is obviously not treated as a secret.)"*

`hermes-quota-plugin` 的处理方式值得照抄：它**优先从用户自己的 `oauth_creds.json` 里读 `client_id`/`client_secret`**，读不到才回落到内置字面量，并且**刻意把字面量拆成两半拼接**（`"…dib135" + "j.apps.googleusercontent.com"`）以免 secret scanner 误报。我们照做。

---

## 2. Q2：可选来源与代价（本任务的核心决策点）

### 2.1 逐项评估

| # | 来源 | 能否拿到 per-user 额度 | 代价 | 结论 |
|---|---|---|---|---|
| **A** | `cloudcode-pa…:retrieveUserQuota` + `loadCodeAssist` | ✅ 逐模型 `remainingFraction` + `resetTime` | 需要 OAuth refresh token；`v1internal` 未文档化，Google 可随时改 | ✅ **采用** |
| **B** | Google Cloud Console 的 Quotas 页面抓取 | ❌ 拿不到 | 那是 JS SPA，需要浏览器会话 cookie；控制台展示的是 project 级配额，**不含** per-user Code Assist 请求数；改版即碎 | ❌ **否决** |
| **C** | Cloud Quotas API（`cloudquotas.googleapis.com`） | ❌ 粒度不对 | 需 project IAM（`cloudquotas.quotas.get`）+ 只能看 project/folder/org 级配额项；Code Assist 的 per-user 日限不是 quotaInfo 项 | ❌ **否决**（B/C 都不解决「个人口径」） |
| **D** | Cloud Monitoring 指标 | ❌ 只是组织活跃度 | 要 IAM；只有 IDE 交互；无 resetTime | ❌ **否决** |
| **E** | `~/.gemini/oauth_creds.json` | — **不是数据源，是凭据源** | 读本机文件，mode 0600 | ✅ **采用（凭据来源）** |
| **F** | `~/.config/gcloud` ADC | — 凭据源（Workspace/Enterprise 走 ADC 时） | 读 `application_default_credentials.json` 或 `GOOGLE_APPLICATION_CREDENTIALS` | ✅ **采用（次选凭据）** |
| **G** | `~/.gemini/usage-limits.json` | ✅ 但**是别家工具的缓存** | 那是 PyPI `gemini-cli-usage` 写的派生缓存，依赖第三方进程在跑 | ❌ **否决**（可以当「顺带发现」的可选增强，不能当主源） |
| **H** | Antigravity（继任产品）`agy` | ✅ 同端点 | 凭据在**系统钥匙串**（service `gemini`, account `antigravity`），不是文件；另有一个本地 language-server Connect-RPC 端点 | ⏸ **本任务外**，但见 §5 |

### 2.2 明确推荐

> **主数据源 = A（`retrieveUserQuota` + `loadCodeAssist`）**。
> **凭据来源 = E 优先、F 次之**（都是**只读**，不把用户凭据复制进我们的 keystore）。
> **B / C / D / G 一律否决。**

理由（可执行层面）：
1. 只有 A 同时满足「per-user 口径」+「有 resetTime」+「不需要额外 IAM/浏览器会话」。
2. A 的响应形状简单到不需要 `findNumber` 那种递归宽容解析 —— 就是一层 `buckets[]`，每项四个字段。这直接决定了 §03 的实现复杂度。
3. 采集频率友好：`retrieveUserQuota` 是纯读，不消耗模型额度，不受「2 req/s per user」生成侧限流影响。

### 2.3 本机数据源的确切路径与格式

**E. `~/.gemini/oauth_creds.json`**

- 路径推导（`packages/core/src/config/storage.ts`）：
  ```ts
  static getOAuthCredsPath() { return path.join(Storage.getGlobalGeminiDir(), 'oauth_creds.json') }
  static getGlobalGeminiDir() { return path.join(homedir(), '.gemini') }
  ```
- **`homedir()` 会被 `GEMINI_CLI_HOME` 覆盖**（`packages/core/src/utils/paths.ts`）：
  ```ts
  export function homedir(): string {
    const envHome = process.env['GEMINI_CLI_HOME'];
    if (envHome) return envHome;
    return os.homedir();
  }
  ```
  → 我们的查找顺序应当是 `$GEMINI_CLI_HOME/oauth_creds.json` → `~/.gemini/oauth_creds.json`。
  这与本仓库既有的 `CLAUDE_CONFIG_DIR`（claude.ts:71）、`CODEX_HOME`（codex.ts:42）处理方式一致。
- 写入方式（`oauth2.ts` `cacheCredentials`）：`mode 0o600`，先写临时文件再 `rename`。
- 内容 = google-auth-library 的 `Credentials`，字段：
  `access_token` / `refresh_token` / `expiry_date`（**epoch 毫秒**）/ `scope` / `token_type` / `id_token` / `client_id` / `client_secret`
  ⚠️ `expiry_date` 是**毫秒**（google-auth-library 约定）。`hermes-quota-plugin` 用 `time.time() * 1000 >= float(exp) - 30000` 判定——我们自己写时别把 1000 漏掉。
- 其它可读文件：`~/.gemini/google_accounts.json`（`GOOGLE_ACCOUNTS_FILENAME`）—— 缓存的 Google 账号 email，可用于 `detail` 回显。

**F. gcloud ADC**

- `$GOOGLE_APPLICATION_CREDENTIALS`（gemini-cli `oauth2.ts` `fetchCachedCredentialsList` 会读这个路径当凭据文件）
- `~/.config/gcloud/application_default_credentials.json`（ADC，`type: "authorized_user"`，含 `refresh_token`）
- Workspace / Code Assist Standard / Enterprise 用户常用这条；个人账号没有。

⚠️ **重要区分**：`isAdcCredentials()` 判断 `type !== 'authorized_user'`。ADC 文件可能是 service account（`type: "service_account"`，没有 `refresh_token`，靠 `client_email`+`private_key` 走 JWT）。我们要处理**两种**：`authorized_user`（有 refresh_token，能自己刷）和 service_account（不能，至少降级为不可用而不是崩）。

### 2.4 竞品调研（仓库名 + 许可协议）

已用 GitHub API 核对 SPDX：

| 项目 | 仓库 | 许可 | 怎么处理 Gemini |
|---|---|---|---|
| **Gemini CLI（官方）** | `google-gemini/gemini-cli` | **Apache-2.0** | 端点/类型定义的**权威来源**。每个源文件头有 `SPDX-License-Identifier: Apache-2.0` + `Copyright 2025 Google LLC` |
| ClaudeBar | `tddworks/ClaudeBar` | 站点与 README 声称 MIT；**GitHub API 的 `license.spdx_id` 返回 `null`**（未检测到 LICENSE 文件或非标准）→ **未验证** | 19 家 provider 含 Gemini；实现在 `Sources/CodexBarCore/Providers/Gemini/GeminiStatusProbe.swift` |
| CodexBar | `steipete/CodexBar` | **MIT**（22k★） | 有**专门的公开文档** `docs/gemini.md` 写清端点、解析、tier 映射。是本次最有价值的「解析思路」参考 |
| codexbar（另一 fork/前身） | `bcharleson/codexbar` | **MIT** | 同上文档 |
| hermes-quota-plugin | `rarf/hermes-quota-plugin` | **MIT** | `quota_providers/gemini.py`：**最完整的一手参考实现**（凭据读取、token 刷新、tier 判定、free-tier 退役处理都有） |
| agy-quota | `tingyi365/agy-quota` | **MIT** | Antigravity/Gemini headless 配额查询；额外覆盖了「非 Google 模型（Claude/GPT）只能从 `fetchAvailableModels` 拿」这一点 |
| OpenTokenUsage | `PowerUserZ/OpenTokenUsage` | **MIT** | `docs/providers/antigravity.md` 记录了 Antigravity 本地 Connect-RPC 端点与 keychain 位置 |
| claudebar（同名不同项目） | `kevinmaes/claudebar` | MIT | 纯 Claude bash 状态栏，**与 Gemini 无关** |
| ClaudeBar（Touch Bar） | `narendraio/ClaudeBar` | MIT | 纯 Claude，且**零网络请求**（只读本机文件） |
| AIQuotaBar | `yagcioglutoprak/AIQuotaBar` | MIT | 无 Gemini |

### 2.5 复用边界（本仓库纪律）

> 边界是「**参考解析思路并自己重写，不逐行复制**；若复用片段必须在文件头附版权与许可声明」。

落到具体动作：
- ✅ 可以**照抄事实**：端点 URL、请求体字段名、响应字段名、OAuth client id/secret、tier id 枚举、限额数字。这些是接口事实，不是创作表达。
- ✅ 可以**照抄算法结构**（先 loadCodeAssist 拿 project 再 retrieveUserQuota；读 `remainingFraction` 算 `100 - f*100`；tier id → 人类名映射）——这是「思路」，各家实现都一样因为接口就那样。
- ❌ **不要**从 `gemini.py` / `GeminiStatusProbe.swift` 逐行移植函数体（它们是 Python / Swift）。
- ❌ **不要**把 `hermes-quota-plugin` 那个「拆两半拼 client_id」的注释与技巧原样抄成我们的注释文案 —— 换成我们自己的说法，保留行为。
- 📄 若最终真的复制了任何**表达式或常量块**（比如那段 client_id 拼接），在 `src/main/adapters/gemini.ts` 文件头加：
  ```ts
  // 部分端点常量与字段名参考自 google-gemini/gemini-cli（Apache-2.0, Google LLC）
  // 与 rarf/hermes-quota-plugin（MIT）。本文件为独立重写实现。
  ```
  实际上按上面的分析，**很可能一行代码都不需要复制** —— 只引用事实即可。仍建议主动加这行声明，成本为零。

---

## 3. Q8：踩坑预判（限流 / header / 改版）

### 3.1 必踩的坑（高置信度）

| # | 坑 | 证据 | 应对 |
|---|---|---|---|
| **P1** | **`remainingAmount` 在 100% 时被省略** | gemini-cli #27363（用户贴原始响应 + 官方 CLI 因此出 bug） | **只用 `remainingFraction`**。它 100% 时一定有值（实测样本 `remainingFraction: 1`） |
| **P2** | **`project` 必填，且必须是 `cloudaicompanionProject`** | `RetrieveUserQuotaRequest.project: string`（非可选）；hermes 注释：不给就返 `IneligibleTier`/`UNSUPPORTED_CLIENT` | 先 `loadCodeAssist` 拿；`cloudaicompanionProject` 为空 → 明确报错，不硬发 `{}` |
| **P3** | **免费 / Pro / Ultra 档已在 2026-06-18 关停** | [官方 deprecation 页](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals)：*"Starting June 18, 2026, Gemini Code Assist IDE extensions stopped serving requests for the Gemini Code Assist for individuals, Google AI Pro, and Google AI Ultra tiers… you can no longer use the Login with Google option"* | 活着的只有 **Workspace Code Assist Standard / Enterprise** + API key。`currentTier.id === 'free-tier'` 或 `ineligibleTiers` 含 free-tier → 走专门的「已退役」文案 |
| **P4** | **`invalid_grant` 是 HTTP 400，不是 401** | Google OAuth 标准行为 | token 刷新 400 + body 含 `invalid_grant` → 映射成「请重新登录」，别只判 401 |
| **P5** | **VPC-SC 用户拿 403 + `details[].reason === 'SECURITY_POLICY_VIOLATED'`** | gemini-cli `server.ts` `isVpcScAffectedUser()` | gemini-cli 的做法是**吞掉并假装 standard-tier**。我们**不要照抄这个撒谎** —— 单独给一条「VPC 服务边界拦截」的文案 |
| **P6** | **`cloudshell-gca` 特例：403 + 专门文案** | gemini-cli `loadCodeAssist` 的 `isPermissionDeniedError` 分支 | 单独分支：「Cloud Shell 默认项目被拒，请 `gcloud config set project`」 |
| **P7** | **`expiry_date` 是毫秒不是秒** | google-auth-library `Credentials` 约定 | 判定过期时 `Date.now() >= expiry_date - 30_000` |
| **P8** | **token 端点是 form-encoded，其余是 JSON** | gemini-cli 用 google-auth-library；`hermes` 用 `urllib` 手拼 form body | 刷新 token 的请求**不能**走 `readJson` 的默认 JSON 假设 |
| **P9** | **`~/.gemini` 目录可能存在但没有 `oauth_creds.json`** | Antigravity 也用 `~/.gemini/antigravity-cli/` | 必须按 **ENOENT** 处理，不能假设目录存在即有效 |
| **P10** | **`buckets` 字段名有第三方分歧** | 官方 `types.ts` + gemini-cli `config.ts` 都是 `quota.buckets`；但 `hermes-quota-plugin` 读 `data.get("quota")` | **以 `buckets` 为准**；`quota` 作为宽容回落（`buckets ?? quota`）。见下方「未验证」标注 |

### 3.2 header 要求

- `Content-Type: application/json` + `Authorization: Bearer <token>` —— 就这两个。
- **不需要** Copilot 那种 `Editor-Version: vscode/1.96.2` 的伪装 header。`cloudcode-pa` 不校验客户端版本。
- `loadCodeAssist` 的 **body 里 `metadata` 才是有语义的部分**（`ideType` / `platform` / `pluginType`）。用 gemini-cli `setup.ts` 的常量：
  `{ ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }`
  （hermes 与 CodexBar 文档用 `ideType: 'GEMINI_CLI'`，也 work。**选一个并在 fixture 里冻住**。建议跟官方 `setup.ts` 一致。）

### 3.3 限流

- 官方文档：Gemini for Google Cloud **Requests per second: 2 per user per project**，Requests per day 6000/960。
  这是**生成侧**的限制；`retrieveUserQuota` 是纯读，但我们仍不应高频轮询。
- gemini-cli 用 google-auth-library 对 **429 / 499 / 500–599** 做 `retry: 3`。
  **我们不加重试** —— 与 copilot.ts / minimax.ts 保持一致（单次尝试 + errSnap）。理由：仓库里没有重试 helper（`engine.ts` 只有 `readJson`），引入重试是与既有风格相悖的额外机制；且 scheduler 已有刷新频率上限。

### 3.4 响应被改版的历史与风险

- [Gemini Code Assist release notes](https://docs.cloud.google.com/gemini/docs/codeassist/release-notes)：*"Gemini Code Assist clients are communicating with a **new API** (`cloudcode-pa.googleapis.com`), which may require updates to your configuration."* —— 换过一次端点。
- API 版本是 `v1internal`。「internal」按定义即无稳定性承诺。
- `types.ts` 里的注释直接指向 Google 内部 proto 路径（`http://google3/google/internal/cloud/code/v1internal/cloudcode.proto`），并注明 *"This is a subset of all available tiers. Since the source list is frequently updated…"*。
- 备用主机名：`daily-cloudcode-pa.googleapis.com` 也提供同一端点（agy-quota README 记录，**未验证**）。gemini-cli 支持 `CODE_ASSIST_ENDPOINT` / `CODE_ASSIST_API_VERSION` 环境变量覆盖（`server.ts` `getBaseUrl`）—— 值得在适配器里留这两个 override 的读取，成本极低。

### 3.5 语义陷阱：配额读数 ≠ 实际可发请求

- [gemini-cli #14883](https://github.com/google-gemini/gemini-cli/issues/14883)：服务端在 token 桶耗尽时**不把它写进 `retrieveUserQuota` 响应**，导致官方 CLI 误报「还有额度」。
- [CLIProxyAPI #1015](https://github.com/router-for-me/CLIProxyAPI/issues/1015)：17 个账号全部 generation 端点 429，而 quota API 同时报 60–100% 剩余。
- **含义**：`retrieveUserQuota` 是「配额池读数」，不是「可发请求数」。只应展示 `tokenType === 'REQUESTS'` 的桶，且 `detail` 不应宣称「还能再发 N 个请求」。

---

## 4. 未验证 / 需要一手验证的点

| 点 | 状态 | 怎么验 |
|---|---|---|
| 响应数组字段是 `buckets` 还是 `quota` | 官方源码 = `buckets`（高置信）；`quota` 只见于一个第三方实现，**未验证** | 实现里写成 `buckets ?? quota` 两者兼容，各加一个 fixture |
| `expiry_date` 单位 | 毫秒（google-auth-library 约定，高置信） | 读本机 `~/.gemini/oauth_creds.json` 看数值量级 |
| 活着的账号实际返回几个 bucket、有没有非 `REQUESTS` 桶 | **未验证**（我们机器上没有 Code Assist Standard/Enterprise 账号） | 需要用户提供一个可用账号做 `--uitest` |
| `daily-cloudcode-pa.googleapis.com` 同端点可用 | **未验证**（单一来源） | 留 env override 但不默认用 |
| token 刷新 400 + `invalid_grant` 的确切 body 形状 | **未验证**（标准行为推断） | 解析时宽松取 `error` 字段，fixture 造一个 |
| 真实 `ineligibleTiers[].reasonMessage` 文案 | **未验证** | `detail` 里直接回显 Google 给的 `reasonMessage`（不自己编文案），这样 Google 改文案我们自动跟上 |

---

## 5. 后继产品：Antigravity（本任务范围外，但要知道）

Gemini CLI / Code Assist 的继任者是 **Antigravity CLI（`agy`）**，2026-05-19 公告，2026-06-18 消费者路径关停。

- 仓库：`google-antigravity/antigravity-cli`（**未核对许可**，README 里有 ToS/数据使用警告条款）
- 凭据：**系统钥匙串**（macOS Keychain / Linux Secret Service / Windows Credential Manager），不是文件。`agy-quota` 记录 service = `gemini`、account = `antigravity`（**未验证**）
- 另有一条**本地 Connect-RPC** 路径：探测随机端口的 `exa.language_server_pb.LanguageServerService/GetUserStatus`，能一次拿到 Gemini + Claude + GPT-OSS 全部模型的 `quotaInfo.remainingFraction`。要求 IDE / language server 正在跑 —— 这正是 `agy-quota` 主张避开的原因
- 配置文件：`~/.gemini/antigravity-cli/settings.json`
- **影响本任务**：`~/.gemini/` 目录在 2026-06 后更常见（有 Antigravity 用户），因此 P9（目录存在 ≠ 有 oauth_creds.json）从「边角」升级为「常态」

---

## 6. 仓库基线核对结果（供实现者对照）

| 事实 | 位置 |
|---|---|
| 已有 9 种协议声明（deepseek/moonshot/zhipu/siliconflow/siliconflow-intl/openrouter/openai-billing/generic + minimax 在 CODE_ADAPTERS） | `src/main/adapters/protocols.ts:108-260`、`:277-293` |
| `ProtocolDecl` 只有 `probe`（GET-able 的 path/url）+ `read`（纯同步 body→windows） | `src/main/adapters/protocols.ts:20-38` |
| 协议工厂固定发 **GET** + `Authorization: Bearer` + **单次**请求 | `src/main/adapters/protocol-adapter.ts:64-70` |
| `CollectRequest` **没有 body 字段** | `src/main/adapters/types.ts:11-16` |
| 生产出网实现也**没有 body** | `src/main/request.ts:21` `fetch(req.url, { headers: req.headers, signal })` |
| 三个参照适配器全部 `kind: 'coding'` | `claude.ts:181`、`codex.ts:189`、`copilot.ts:89` |
| `mark` 取 `inst.presetId \|\| inst.protocol` | `bind-instance.ts:27`、`protocol-adapter.ts:48` |
| `mark` 必须在 `PROVIDER_MARKS` 里有键，否则回退 generic 图标 | `src/renderer/src/provider-icons.ts:114-116` |
| 图标是**脚本生成**的，`勿手工编辑` | `provider-icons.ts:1-2` → `node scripts/gen-provider-icons.mjs` |
| `degradedReason` 由 `applyCachePolicy` 写，适配器基本不写（唯一例外 opencode.ts:822） | `src/shared/quality.ts:56-57` |
| 错误快照的 `dataQuality` 必须是 `undefined` | `engine.ts:73-84`（ADR-0002） |
| `request` 桩按 URL 精确匹配，且**只记录 url/auth/accept**（不记 body） | `scripts/test-adapters.mjs:98-118` |
| T12 断言「自定义协议目录 9 条」——加一条 `SELECTABLE_PROTOCOLS` 就会红 | `scripts/test-adapters.mjs:860` |
| 凭据落盘：`items` 加密 / `extras` **明文** | `src/main/store.ts:12-13`、`:92-102` |
| 多段值塞进单个 key 的既有先例：qwen/volc 冒号分隔、opencode JSON 数组 | `providers.ts:140,148`、`bind-instance.ts:42-45` |
| 渲染层**不得**拿明文凭据（`tts:getSecret` 已下线） | `src/main/ipc.ts:283-292` |
