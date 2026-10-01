# Research 01 · 现状：`openai-billing` 现在到底查什么

- **Query**: `openai-billing` 现在能查到什么、查不到什么；与 ChatGPT 订阅额度是否共存
- **Scope**: internal
- **Date**: 2026-10-01

---

## 结论速览

| 问题 | 结论 |
|---|---|
| `openai-billing` 查什么 | **OpenAI Platform（API）账号的美元 hard limit**，即「API 计费口径」 |
| 它能给出「已用量」吗 | **不能**，`used` 恒为 0（`/v1/dashboard/billing/subscription` 不返回已用量） |
| 它是内置预设吗 | **不是**。只在「添加自定义提供方」目录里（`SELECTABLE_PROTOCOLS`），没有 `BUILTIN_PRESETS` 条目 |
| 它查得到 ChatGPT 订阅额度吗 | **完全查不到**。协议里没有任何一行与订阅/消息数/模型限额相关 |
| 两者能共存吗 | **能**。ChatGPT Plus/Pro 订阅与 API Platform 计费是**两套独立产品**（见下文证据） |

---

## 1. 声明本体（唯一事实来源）

`src/main/adapters/protocols.ts:230-244`

```ts
// ── OpenAI 计费：返回的是额度而非余额（used 恒为 0）──
'openai-billing': {
  id: 'openai-billing',
  label: 'OpenAI 计费',
  kind: 'balance',
  defaultBaseUrl: 'https://api.openai.com',
  hint: 'GET /v1/dashboard/billing/subscription + /usage（需老式 sk- key）',
  probe: () => ({ path: '/v1/dashboard/billing/subscription' }),
  read: (body) => {
    const b = body as { hard_limit_usd?: number; system_hard_limit_usd?: number }
    const limit = b?.hard_limit_usd ?? b?.system_hard_limit_usd
    if (!Number.isFinite(limit)) return null
    return [{ name: '账户额度', used: 0, limit: limit as number, unit: 'usd', note: '官方计费接口（不含已用量）' }]
  }
}
```

逐条拆解：

| 维度 | 现状 | file:line |
|---|---|---|
| kind | `balance`（直连余额类） | `protocols.ts:234` |
| host | `api.openai.com` | `protocols.ts:235` |
| 端点 | `/v1/dashboard/billing/subscription` | `protocols.ts:237` |
| 鉴权 | `Authorization: Bearer <key>`（工厂统一拼，`protocol-adapter.ts:70`） | `protocol-adapter.ts:69-72` |
| 读出 | `{ name: '账户额度', used: 0, limit: hard_limit_usd, unit: 'usd' }` | `protocols.ts:242` |
| 落在目录 | `SELECTABLE_PROTOCOLS`（设置页「添加自定义提供方」） | `protocols.ts:284` |
| 图标 | 已有映射 → `simple-icons:openai` | `src/renderer/src/provider-icons.ts:93-97`、`scripts/gen-provider-icons.mjs:39` |
| 黄金样本 | K 段一条断言 | `scripts/test-adapters.mjs:581-593` |

**没有任何地方把它注册成内置预设**：`BUILTIN_PRESETS`（`src/main/providers.ts:54-150`）
里没有 OpenAI 条目。也就是说**今天用户在界面上看不到任何一张 OpenAI 卡片** ——
除非他手动「添加自定义提供方」→ 选「OpenAI 计费」→ 自己填 `sk-` key。

---

## 2. 它查不到的东西（逐项）

| 想查 | `openai-billing` 能否 | 原因 |
|---|---|---|
| ChatGPT Plus/Pro 消息数 / 模型限额 | ❌ | 端点与订阅体系无关 |
| 订阅周期结束时间 / 续费日 | ❌ | 无对应字段 |
| API 已用量（spent） | ❌ | `used: 0` 是硬编码的（`protocols.ts:242`） |
| 账户当前可用余额 | ⚠️ 间接 | 只有 hard limit，没有 remaining；与 OpenRouter 的 `total_credits - total_usage` 不同 |
| 组织/项目维度成本（Admin API） | ❌ | 声明表达不了（需要两个不同端点 + `project_ids` 查询参数） |

---

## 3. ⚠ 端点本身可能已废弃（**未验证**）

`/v1/dashboard/billing/subscription` 与同族的 `/credit_grants`、`/usage`
**不在 OpenAI 当前的公开 API reference 里**。

证据（检索日期 2026-10-01）：

- CodexBar 官方 provider 文档 `docs/openai.md`（MIT）明确写道：
  > 「Best-effort fallback: legacy `GET https://api.openai.com/v1/dashboard/billing/credit_grants`
  > for older user API keys … **This endpoint is not part of OpenAI's current public API reference.**」
  https://raw.githubusercontent.com/steipete/CodexBar/main/docs/openai.md
- OpenAI 开发者社区多帖反馈这两个端点「无响应」：
  - https://community.openai.com/t/issue-in-fetching-openai-api-usage-billing-cost-and-credit-balance-programmatically-for-backend-monitoring/1379947
  - https://community.openai.com/t/v1-dashboard-billing-usage-is-not-work/305887
- 同社区另有「OpenAI 要求组织在 2026-07-24 前切换到预付 API 计费」的讨论，
  暗示旧的月度后付/仪表盘计费体系正在退场。
  https://www.reddit.com/r/1uyvcdo/

**现代替代（API 花费侧）** —— CodexBar 的首选路径，需要 **Admin API key**：

```
GET https://api.openai.com/v1/organization/costs?bucket_width=1d
GET https://api.openai.com/v1/organization/usage/completions?bucket_width=1d
Authorization: Bearer <OPENAI_ADMIN_KEY>
可选：project_ids=<proj_…>
```

来源同 `docs/openai.md`。

> **对本任务的含义**：`openai-billing` 这条声明的**存活性本身存疑**。
> 它不在本任务的必答范围内，但实现时若发现它长期 404/401，
> 应作为独立议题上报（不要在本任务里顺手改 `protocols.ts` —— 那是共享文件）。

---

## 4. ChatGPT 订阅 与 API 计费 能共存吗？—— **能，是两套东西**

**结论：能，且经常同时存在。必须按两个 `kind` 处理。**

| 事实 | 来源 |
|---|---|
| 「ChatGPT 订阅与 OpenAI API 不是一回事。付 ChatGPT（Plus/Pro）只在 ChatGPT app 内可用，**不**提供 API 额度。」 | Facebook 群组转述的 OpenAI FAQ（检索 2026-10-01）· 弱来源，需用户侧确认 |
| Codex 包含在各级 ChatGPT 计划内（Free/Go/Plus/Pro/Business/Enterprise…），走 ChatGPT workspace 权限与 RBAC | OpenAI Help Center 官方：https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan |
| 「When you sign in with ChatGPT for subscription access / Sign in with an API key for usage-based access」—— 两条独立的认证入口 | OpenAI 官方文档：https://learn.chatgpt.com/docs/auth |

推论：

1. 一个账号**可以**同时有 ChatGPT 订阅 + API 余额（或只有其中一个）。
2. 因此 `ProviderKind` 天然分叉：
   - API 余额 → `balance`（`openai-billing` 现状正确，**不要动**）
   - ChatGPT 订阅 → 套餐类（`coding` 或 `token`，见 `05-design-decisions.md`）
3. **两者无法合并成一张卡**：单位不同（USD 额度 vs 百分比窗口 + 重置时间），
   凭据不同（`sk-` vs OAuth bearer），host 不同（`api.` vs `chatgpt.`）。
4. 反过来，只订了 ChatGPT、**没有 Platform API key** 的用户，
   根本无法配置 `openai-billing` —— 这是新适配器的真实增量价值。

---

## 相关文件

| 路径 | 说明 |
|---|---|
| `src/main/adapters/protocols.ts` | 协议声明表（`openai-billing` 在 :231-244，目录登记在 :284）**← 本任务勿改** |
| `src/main/adapters/protocol-adapter.ts` | 声明 → 适配器工厂（Bearer 头、状态映射、错误文案） |
| `src/main/providers.ts` | `BUILTIN_PRESETS`（**无** OpenAI 条目）、`instanceInfo` |
| `scripts/test-adapters.mjs` | K 段 = `openai-billing` 冻结样本；N7 断言声明表恰好 8 条（:752-756） |
| `docs/adr/0001-protocol-owns-the-query.md` | ADR-0001「协议是唯一决定查哪个端点的东西」 |
| `.trellis/tasks/archive/2026-10/10-01-p1-trend-chart/research/data-path-and-balance.md` | 记录余额类窗口名只有两个：`账户余额` / `账户额度` |

## Caveats

- `openai-billing` 端点是否仍可用：**未验证**（无凭据，无法实测）。
- 「ChatGPT 订阅不附带 API 额度」只有二手来源，未找到 OpenAI 一手文档原文。
- 本仓库代码与历史任务记录全部读自 2026-10-01 的工作树。