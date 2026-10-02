# Research: Cursor 的额度模型与官方 API 可用性

- **Query**: Cursor 是订阅制还是按 token 计费？官方是否提供用量/额度查询 API？CLI 有没有额度子命令？
- **Scope**: external（官方文档 + 社区实证）
- **Date**: 2026-10-01

---

## 1. 额度模型：订阅制（月度周期），量纲是**美元**，不是 token

Cursor 现行（usage-based）计划全部是**按月订阅 + 两个用量池 + 月度重置**：

| 计划 | 价格 | Cursor Models 池 | Other Models 池 |
|---|---|---|---|
| Start（仅印度） | ₹649/mo | 含 | **不含** |
| Pro | $20/mo | 含 | 含 |
| Pro Plus | $60/mo | 含 | 含 |
| Ultra | $200/mo | 含 | 含 |

来源：<https://cursor.com/docs/models-and-pricing>（检索 2026-10-01）、<https://cursor.com/help/models-and-usage/usage-limits>

要点：
- **两个独立的用量池**，各自按月重置（`billingCycleEnd`）：
  - `Cursor Models`（Cursor 自研/代理池：Grok 4.5/4.6/4.7、Composer 2.5）
  - `Other Models`（第三方模型池，按模型 API 原价扣）
- 池的用量以**美元**计量（Pro = $20 额度，Ultra = $200 额度），不是 token 数、不是请求数。
- 超出后可选 **on-demand（按需）** 继续计费，可设硬上限（`spendLimitUsage`）。
- 历史遗留的 **request-based（按次）** 计划仍存在（`/api/usage?user=ID` 那条端点就是它），但**新计划不再有**。
  → 适配器要**同时认识两种口径**，否则老用户会看到「0 请求」的怪数据。

**对本仓库的映射含义**：
- `kind` 应为 `'coding'`（订阅制、看用量/限额/重置时间）—— 与 claude/codex/copilot 同族。
- 主窗口的 `unit` 应为 `'usd'`（服务端给的 `limit` 就是美元额度，除以 100 得到）。
  copilot 用 `'token'` 是因为它的量纲是「请求次数」，**不要照抄**。
- 金额量纲确认：`planUsage.limit = 2000` 对应 Pro 的 `$20` → **服务端单位是「分」（cents）**。
  交叉验证：官方论坛 2026-08 的真实响应 `{"totalSpend":1288,"includedSpend":1288,"remaining":712,"limit":2000}`
  且 `displayMessage: "You've used 64% of your included usage"` —— 1288/2000 = 64.4% ✅。

---

## 2. 官方 API：**个人计划没有官方用量 API**

`https://cursor.com/docs/api`（检索 2026-10-01）列出的全部 API：

| API | 可用范围 | 能否查个人 Pro/Ultra 额度 |
|---|---|---|
| Admin API (`api.cursor.com/teams/*`) | **Enterprise teams** | ❌ 需要团队管理员在 team settings 建的 `admin:*` key |
| Analytics API (`api.cursor.com/analytics/*`) | **Enterprise teams** | ❌ 同上 |
| AI Code Tracking API | Enterprise teams | ❌ |
| Bugbot API | Enterprise teams | ❌ |
| Cloud Agents API (`/v1/agents`) | Beta（所有计划） | ❌ 只管 agent 生命周期，不管额度 |
| Origin API | Early Beta | ❌ |
| TypeScript / Python SDK / SDK Bridge | 所有用户 | ❌ 跑 agent，不报额度 |

- key 格式：Admin 侧 `key_…`（旧文档）或 `crsr_…`（新文档），**必须在团队设置里生成**。
- `CURSOR_API_KEY`（CLI 用）也是这类 key，**不是个人订阅额度的钥匙**。
- Cursor 官方论坛长期有「个人计划能不能查用量的 API」的提问，官方从未提供；
  社区一致结论（ai-usagebar 源码注释）：
  > "Cursor has no documented usage API or API key for personal quota — every community tool
  > that shows it reads the same place: a SQLite key-value store … under the key `cursorAuth/accessToken`."

**结论**：官方文档路径走不通。必须用**逆向的 dashboard 接口**（见 `02-endpoints-and-auth.md`）。

---

## 3. CLI：**没有额度子命令**

官方 CLI 参考 <https://cursor.com/docs/cli/reference/parameters>（检索 2026-10-01）的全部子命令：

```
agent [prompt…] | login | logout | status/whoami | worker | acp | update
| ls | resume | create-chat | generate-rule | install-shell-integration
| mcp * | sandbox * | about
```

- **没有 `usage` / `quota` / `limits` 子命令。**
- `agent status --format json` 只回鉴权状态 / 账号信息 / endpoint 配置（`--format` 支持 `text|json`）。
- REPL 里有个 `/usage` 斜杠命令，但社区确认它只显示 activity streak / lines edited / daily stats，
  **不是套餐花费**（来源：forum.cursor.com/t/usage-via-cli/154101，检索 2026-10-01）。
- ⚠ `agent status --format json` 的 JSON 里**是否真的带 `auth.accessToken`**：**未验证**。
  只有 `wakamex/cursor-cli-usage`（无 LICENSE、0 star）在代码里这么读，且其 README 声称
  「reports the current authentication state without ever printing the secret」
  （limboo 的 cursor-integration 文档也这么说）—— **两者互相矛盾**。
  → **不要把 CLI 子进程当主凭据源。**

---

## 4. 结论摘要

| 问题 | 结论 |
|---|---|
| 订阅制还是 token 制 | **订阅制**，月度周期，量纲是美元（分），两个独立池 |
| 官方用量 API | **没有**（只有 Enterprise 团队 Admin/Analytics API，需要团队 key） |
| 官方 CLI 额度子命令 | **没有** |
| 逆向 dashboard 接口 | **有，且稳定被多家独立实现使用**（`api2.cursor.sh` Connect RPC / `cursor.com/api/*` cookie 路径） |
| 凭据来源 | 本机文件 / Keychain（**不是**用户填的 API key） |

---

## Caveats / 未验证

- 「Pro = $20 额度」是从官方文档表格 + `limit: 2000`（分）反推的，未在真实账号上核对过 `GetPlanInfo` 返回的 `includedAmountCents`。
- `billingCycleStart/End` 在 `api2.cursor.sh` 是 **unix 毫秒字符串**，在 `cursor.com/api/usage-summary` 是 **RFC3339 字符串** —— 两个端点格式不同，别混用解析器。
- 检索日期：2026-10-01。所有 URL 见 `04-competitors-and-licenses.md` 的来源清单。