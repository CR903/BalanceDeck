# Research 02 · ChatGPT 订阅额度的可用端点与鉴权

- **Query**: ChatGPT Plus/Pro 额度有没有查询接口？`openai.com/api/...` 覆盖吗？cookie 还是 token？
- **Scope**: external
- **检索日期**: 2026-10-01（所有外部信息均在此日期检索）

---

## 🔑 最重要的发现（推翻任务前提）

> **任务前提假设 `chatgpt.com/backend-api/` 需要浏览器会话 cookie。
> 调研结论：主数据路径需要的是 `Authorization: Bearer <access_token>`
> （Codex CLI 的 ChatGPT OAuth token），不是 cookie。**
>
> 竞品 CodexBar（MIT）把它列为**首选路径**，把 OpenAI 浏览器 cookie 列为
> **默认关闭的、可选的「dashboard 增强项」**。

因此 Q3「cookie 结构性风险」的答案可以重写为：**主路径可以完全避开 cookie。**

---

## 1. 端点清单（按推荐度排序）

### ① `GET https://chatgpt.com/backend-api/wham/usage` ⭐ 主数据源

**鉴权头**（两个都要）：

```
Authorization: Bearer <access_token>
ChatGPT-Account-Id: <account_id>
```

> 注：CodexBar 文档只写了 `Authorization`，gist 与各语言实现都同时带
> `ChatGPT-Account-Id`。实现时**两个都带**，缺失时按多 workspace 场景降级。

**响应形状**（CodexBar issue #2900 里的实测样本，EDU 账号，检索 2026-10-01）：

```json
{
  "user_id": "…", "account_id": "…", "email": "…",
  "plan_type": "education",              // free | plus | pro | team | enterprise | education
  "rate_limit": {
    "allowed": true,
    "limit_reached": false,
    "primary_window":   { "used_percent": 14, "limit_window_seconds": 18000,
                          "reset_after_seconds": 15542, "reset_at": 1786617181 },
    "secondary_window": { "used_percent": 33, "limit_window_seconds": 604800,
                          "reset_after_seconds": 417595, "reset_at": 1787019234 }
  },
  "code_review_rate_limit": { … },
  "additional_rate_limits": [ { "id": "codex-spark", "title": "Codex Spark 5-hour",
                                "primary_window": {…}, "secondary_window": {…} } ],
  "credits": { "has_credits": true, "unlimited": false, "overage_limit_reached": false,
               "balance": null, "approx_local_messages": …, "approx_cloud_messages": … },
  "spend_control": { "reached": false, "individual_limit": null },
  "rate_limit_reached_type": null,
  "promo": null,
  "rate_limit_reset_credits": { "available_count": 3 }
}
```

来源：https://github.com/steipete/CodexBar/issues/2900 （实测全文，含 EDU 账号脱敏样本）

补充形状（非官方 gist，`gist.github.com/monperrus/21dc7d85ea518dc2a66606006d356b5b`，
检索 2026-10-01，页面超时但搜索摘要完整）：
`secondary_window` 在只有单窗口的计划下为 `null`；`additional_rate_limits` 无模型级限额时为 `null`。

**语义要点**（对本仓库的口径纪律很关键）：

- `primary_window.limit_window_seconds = 18000` = **5 小时**；
  `secondary_window.limit_window_seconds = 604800` = **7 天/本周**。
  → 窗口长度**由服务端下发**，不要硬编码（对齐 `opencode-console-api.ts:31-46` 的经验：
  限额由服务端下发好过硬编码 `$12/$30/$60`）。
- 端点只给 `used_percent`，**不给绝对用量**，也不给金额。
  → 必须走 `percent` 字段，不能伪造 `used/limit`（见
  `.trellis/spec/guides/external-api-integration.md` Step 4）。
- `plan_type` 直接可映射到 `ProviderSnapshot.plan`。

---

### ② `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`

同 Bearer + Account-Id 上下文。返回 `{ available_count }`（可存储的重置次数）。

⚠ **已知会 429**：`GET /backend-api/wham/rate-limit-reset-credits` → 429 Too Many Requests，
**同时影响 ChatGPT 桌面 app 与网页**（Pro 订阅）。
来源：https://github.com/openai/codex/issues/37934 （检索 2026-10-01）

→ **建议：本任务不做这个端点**（可选增强项，锦上添花但有明确 429 记录）。

---

### ③ `GET https://chatgpt.com/backend-api/accounts/{account_id}/spend-controls/current-user/monthly-usage`

ChatGPT.app 用来取**管理员设定的月度上限**（EDU/Business 场景）用的独立端点：

```json
{ "current_month_usage": 3046.4506806135178,
  "effective_monthly_limit": { "limit": 7000,
                               "enforcement_mode": "HARD_CAP",
                               "limit_mode": "amount_credits" } }
```

同 Bearer + Account-Id。`wham/usage` 里对同一账号
`spend_control.individual_limit` 是 `null`，月度上限只在这里有。

来源：https://github.com/steipete/CodexBar/issues/2900

→ **建议：列为可选增强**，且必须容忍 404/401（普通 Plus/Pro 账号没有这个额度）。

---

### ④ `GET https://chatgpt.com/backend-api/codex/usage` —— **未验证**

pi 的 `pi-codex-status` 包 README 的 "How It Works" 段称此端点可返回
5h / weekly / credits / 每模型限额。

来源：https://pi.dev/packages/pi-codex-status?page=52 （检索 2026-10-01）

⚠ **未验证**：端点是否仍存在、与 `wham/usage` 是否重复、是否需要不同鉴权。
**不要在实现里依赖它**。若要探，先单独探测并记录实测日期。

---

### ⑤ `openai.com/api/...` 覆盖 ChatGPT 订阅吗？—— **不覆盖**

CodexBar `docs/openai.md` 第一句就写死了：

> 「CodexBar's OpenAI API provider targets the **API Platform organization
> dashboard**, **not ChatGPT/Codex subscription limits**.」

`api.openai.com` / `openai.com/api` 侧能拿到的是 **Platform 花费**（Admin API 或 legacy
`/v1/dashboard/billing/*`），与 ChatGPT 订阅额度**完全无关**。

→ **答 Q2 子问 2：不能覆盖，方向从一开始就错了。**

---

## 2. 凭据来源（决策核心）

### 推荐：`~/.codex/auth.json`（或 `$CODEX_HOME/auth.json`）

**形状**（由多份独立实现交叉确认，检索 2026-10-01）：

```
{ "tokens": { "access_token": "<jwt>", "id_token": "<jwt>",
              "refresh_token": "<…>", "account_id": "<uuid>" } }
```

（另可能有 `personal_access_token`，见下）

来源：
- Simon Willison `llm-openai-via-codex`（明确注释 "Return (access_token, account_id) borrowed from the local Codex CLI"，并「自动刷新 access_token 后写回 auth.json」）
  https://github.com/simonw/llm-openai-via-codex/blob/main/llm_openai_via_codex.py
- pi `pi-codex-token` 包的凭据解析顺序：`CODEX_ACCESS_TOKEN` 环境变量 →
  `CODEX_PAT` → `~/.codex/auth.json` 的 `personal_access_token`；account_id 最后兜底读
  `~/.codex/auth.json` 的 `tokens.account_id`。https://pi.dev/packages/pi-codex-token
- CodexBar `docs/codex.md`：Reads OAuth tokens from `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`)。

**为什么这条路在本仓库尤其自然**：
`src/main/adapters/codex.ts:41-43` 已经有 `codexHome()`（读 `CODEX_HOME` 或 `~/.codex`），
`codex.ts:45-63` 已经在遍历 `~/.codex/sessions`。同一目录、同一套 home 解析逻辑，
零新增依赖。

**致命限制（必须诚实处理）**：

| 限制 | 证据 | 对本仓库的含义 |
|---|---|---|
| access_token 会过期 | CodexBar `docs/codex.md`：「CodexBar **never publishes refreshed native tokens into `auth.json`** … delegates recovery to the Codex CLI, which owns that file」 | **我们也不要写回 `auth.json`**（那是 Codex CLI 的文件，不是我们的）。过期时的用户动作 = 「运行 `codex login`」 |
| `personal_access_token`（PAT，`at-…`）不自动刷新 | pi `pi-codex-token`：PATs are not auto-refreshable；「mints a long-lived personal/enterprise access token」；401 时提示重新签发。属 **Enterprise/Business 特性**（`codex login --with-access-token`） | 普通 Plus/Pro 用户拿不到 PAT。别把它当主路径 |
| 读 auth.json 是否算「读用户凭据」 | CodexBar 把「External Codex OAuth sources（读别的应用的 OAuth 文件）」做成**默认关闭**的开关，并写明「This cross-application credential access defaults off」 | 本仓库要**明确说清**读的是 Codex CLI 自己的文件，而不是窃取浏览器会话 |

### 备选：`codex app-server` JSON-RPC

```
codex -s read-only -a never app-server
→ initialize / account/read / account/rateLimits/read
```

优点：不读任何凭据文件，由 CLI 自己管 token。
缺点：拉起子进程、有 per-method 超时与 SIGTERM/SIGKILL 升级逻辑、
macOS 可能拦 `codex` 可执行文件（CodexBar 为此有 30 分钟熔断）。

来源：CodexBar `docs/codex.md`「Codex CLI RPC (automatic CLI source)」。

→ **不建议作为 v1**，但可作为「auth.json 缺失时用户已装 CLI」的兜底。

### 明确不推荐：浏览器 cookie（详见 `04-credential-security-and-degradation.md`）

CodexBar 只把它用于**可选的 dashboard 增强**（code review remaining、usage breakdown、
credits history），需要从 Safari / Chrome / Firefox 导入 cookie，且 macOS 上要
Keychain 访问权限或 Full Disk Access。

---

## 3. 官方有没有公开接口？

| 问法 | 答 |
|---|---|
| OpenAI 公开 API 里有 ChatGPT 订阅额度查询吗 | **没有**。`api.openai.com` 是 Platform；订阅在 `chatgpt.com/backend-api/`（非公开、无文档、可随时改版） |
| 「Sign in with ChatGPT」公开文档 | 有身份层规范（`https://auth.openai.com` issuer、`oaiapp_example` client id、ID token 校验），但**不承诺** `wham/usage` 稳定。https://developers.openai.com/siwc/website |
| ChatGPT 学习文档 | `https://learn.chatgpt.com/docs/auth` 描述「ChatGPT 订阅访问」与「API key 按量访问」两条独立认证线 |

**定性**：这是一个**未公开、无 SLA、可随时消失**的端点。
按 `.trellis/spec/guides/external-api-integration.md` Step 1~3 的要求，
实现前必须**观测真实产品页面实际请求什么**，不能只信第三方文档。

---

## 4. 独立第三方印证（说明端点真实存在且被广泛使用）

- **headroom**（`headroomlabs-ai/headroom`）CHANGELOG：`codex: poll /wham/usage for subscription …`
  https://github.com/headroomlabs-ai/headroom/blob/main/CHANGELOG.md
- **openclaw/openclaw** v2026.4.29-beta.4 release notes：提到 agents/auth 与 "WHAM usage" 的来源标注治理
  https://newreleases.io/project/github/openclaw/openclaw/release/v2026.4.29-beta.4
- **pleaseai/shunt**：`Codex response x-codex-* headers and optional wham/usage polling populate its observed 5-hour and shared weekly windows`
  https://github.com/pleaseai/shunt
- **ForkMesh** 开发者文档：`wham/usage, Authorization: Bearer <access_token>`
  https://app.forkmesh.com/dashboard/docs
- Reddit 有 Raspberry Pi 直接轮询 `chatgpt.com/backend-api/wham/usage` 的实践
  https://www.reddit.com/r/codex/comments/1tyd2u2/limit_usage_widget_polling/

→ 四个互不相关的项目都在用同一端点，说明**它是真的、且当前（2026-10）活着**。

---

## Caveats / 未验证

- 全部外部信息检索于 **2026-10-01**，无一条经本机实测（无 ChatGPT Plus/Pro 凭据）。
- `wham/usage` 是否**必须**带 `ChatGPT-Account-Id`、缺失时返回什么：**未验证**。
- `wham/usage` 对 `free` 计划的行为（是否只有 `primary_window`）：**未验证**。
- `/backend-api/codex/usage` 是否仍存在：**未验证**。
- Cloudflare / UA / Origin 头要求：**未验证**（CodexBar 未提及，说明 Bearer 路径
  很可能不需要；但 `codex` 文档提到网页路径会有 "Cloudflare interstitial" 错误）。
- gist 提供的字段注释未逐条核对原始 gist 全文（页面超时，仅取搜索摘要）。