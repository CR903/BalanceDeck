# Research: Google Antigravity 是什么 & 额度模型

- **Query**: Google Antigravity 是 Google 的什么产品？额度/用量概念是什么（订阅？配额？token 数？）
- **Scope**: external
- **Date**: 2026-10-01（检索日期）
- **来源检索方式**: Exa web_search_exa + web_fetch_exa，只取官方文档与头部开源实现，未在本机实测（见文末「未验证」）

---

## 1. 它是哪个「Antigravity」

⚠ 名字确实对应多个东西，但**只有一个是「供应商额度」语境下的那个**：

| 名字 | 是什么 | 与本任务的关系 |
|---|---|---|
| **Google Antigravity（IDE / 独立应用）** | Google 的 agentic-first 编程 IDE（内部代号 **Jetski**，VS Code 衍生）。有桌面 IDE、也拆出了独立 App | ✅ **就是它**。用户买的是 Google AI 订阅，Antigravity 额度搭车 |
| **Antigravity CLI（`agy`）** | 同一产品的命令行形态，配置在 `~/.gemini/antigravity-cli/`，二进制名 `agy` | ✅ 同一账号体系、同一后端，**是 CLI 而不是另一个供应商** |
| Google Antigravity **物理/材料公司** | 一家做碳负材料的创业公司 | ❌ 无关 |

> 注：Go 生态的 `antigravity`（`go-keyring` 的 base64 前缀 `go-keyring-base64:`）与 Rust 的 `antigravity` crate 也只是**同名**的其它东西，不是产品。

**来源**：
- [Plans | Google Antigravity Docs](https://antigravity.google/docs/plans)（官方，检索 2026-10-01）
- [Installation & Auth | Google Antigravity Docs](https://antigravity.google/docs/cli/install/)（官方）
- [agentcode.ai/google-antigravity](https://agentcode.ai/google-antigravity)（第三方评测，2026-08-16）
- [robinebers/openusage `docs/providers/antigravity.md`](https://raw.githubusercontent.com/robinebers/openusage/main/docs/providers/antigravity.md)（MIT）

---

## 2. 额度概念：**订阅搭车的配额百分比，不是余额、不是 token 数**

这是本次调研最重要的口径结论，直接决定适配器怎么建模。

### 2.1 没有独立的 Antigravity 订阅

Antigravity **不单独售卖**。额度搭在 Google AI 消费者订阅里：

| 档位 | 月费 | Google 官方对额度的表述 |
|---|---|---|
| Individual（免费） | $0 | "Meaningful quota, refreshed **weekly**" |
| Google AI Pro | $19.99 | "High, generous quota, refreshed **every five hours** until weekly limit reached" |
| Google AI Ultra | $100 | 5X Pro（I/O 2026 公告） |
| Google AI Ultra（顶档） | $200 | 20X Pro（I/O 2026，原 $250） |
| Organization / Enterprise | 按量 | 走 Gemini Enterprise Agent Platform 计费 |

> **Google 从未发布过绝对数字**。官方 plans 页只用形容词（"meaningful" / "high, generous"），唯一公布的是 5X / 20X 两个乘数，而它们的基准 Pro 本身没有数字。

**这条对本仓库的含义**：**绝对不能把 Claude Code 那套「社区估算限额」搬过来**。`claude.ts:27` 的 `DEFAULT_LIMITS = { fiveHour: 35, weekly: 140, monthly: 420 }` 是社区反推的；Antigravity 连乘数基准都没有，硬编一个数就是纯撒谎。

### 2.2 真实额度单位 = `remainingFraction`（0..1 的剩余比例）

竞品一致实测的响应形状（见 `04-protocol-and-endpoints.md`）：

- **2 个共享额度池**（不是每模型一份）：
  - `Gemini Models` 池 —— Gemini Pro 与 Flash **共用**一份额度
  - `Claude and GPT models` 池 —— Claude Opus/Sonnet、GPT-OSS **共用**另一份
- **每个池 2 个窗口**：`weekly`（周）+ `5h`（滚动 5 小时）
- 每个 bucket 报 `remainingFraction`（0..1）与 `resetTime`（ISO 8601）
- **没有绝对量、没有 token 数、没有 used 计数**

> 来源：[can1357/oh-my-pi#9940](https://github.com/can1357/oh-my-pi/issues/9940)（贴出真实 JSON）、[quotas crate `antigravity.rs`](https://docs.rs/quotas/latest/src/quotas/providers/antigravity.rs.html)（含 2026-07-14 实录 fixture 断言）

### 2.3 与本仓库现有模型的映射

| Antigravity 概念 | `ProviderWindow` 字段 | 说明 |
|---|---|---|
| `remainingFraction` | `percent`（**存已用百分比** = `100 - frac*100`） | 服务端直报，优先用它（`shared/types.ts:31` 的注释就是这么说的） |
| 窗口身份（`5h` / `weekly`） | `name` | 建议 `5 小时` / `本周`，与 claude/codex/opencode 对齐 |
| `resetTime` | `resetAt` | 直接 ISO，无需换算 |
| `displayName`（"Weekly Limit Remaining"） | `note` | |
| `planName`（Free/Pro/Ultra） | `plan` | |
| — | `used` / `limit` / `unit` | **无源可填**。`limit` 是编的 → 必须留空 |

⚠ `percent` 与 `limit` 的关系：`shared/types.ts` 明确「`0` 或缺省 = 限额未知，只展示用量」。而 `percent` 的渲染路径（`src/shared/tray-text.ts`、UI 环形进度）就是为「有百分比、无绝对量」设计的。**`limit` 留空 + `percent` 有值是本仓库已支持的合法组合**（codex.ts:158-167 的服务端窗口正是这么做的：`used: 0, limit: 缺省, percent: 服务端值`）。

**`unit` 该选什么**：`'percent'` 还是 `'token'`？现有先例不一致：
- `codex.ts` 服务端窗口用 `unit: 'token'` 且 `limit` 缺省
- `copilot.ts:141` 用 `unit: 'token'`，`limit` 是 entitlement（真值）
- `shared/types.ts:3` 里 `'percent'` 是**合法**的 Unit，且 `tray-text.ts:48` 会走 `formatPercent`

因为 Antigravity 的数字本身就是百分比语义，`unit: 'percent'` 是更诚实的选择，但**它会带来一处 UI 行为差异**，见 `05-recommendation.md` §风险。

---

## 3. 未验证 / 需要实测的部分

以下均为**二手来源**，未在本机核对（这台机器没装 Antigravity —— `~/.gemini`、`~/Library/Application Support/Antigravity*`、macOS Keychain `gemini/antigravity` 全部不存在，实测 2026-10-01）：

- ❓ Google 是否有**正式公开**的 quota API 文档 —— 官方 docs 只公开了 CLI 的 `/usage` 命令和 statusline 的 JSON 形状，**`retrieveUserQuotaSummary` 未见官方文档**。它是「官方后端内部端点」，不是稳定的公开契约。
- ❓ 免费档是否也能拿到 `retrieveUserQuotaSummary`。有源码注释说免费档会 `403 SUBSCRIPTION_REQUIRED (#3501)`（`pi-antigravity` 的 `fetchQuotaSummarySafe` 注释），也有 GitHub issue 报 403 `VALIDATION_REQUIRED`。**这两条互相矛盾，且都是二手**。
- ❓ 4 个 bucket（2 池 × 2 窗口）是否在所有套餐/地区都齐。老版本 Antigravity 不暴露 weekly 窗口（openusage 排障条目：「The weekly meters show "No data" — your Antigravity build doesn't expose the quota-summary endpoint yet」）。
- ❓ 「Claude/GPT 池」在免费档是否可用。第三方称免费档有 Claude Sonnet/Opus + GPT-OSS，但**免费档不可用于 Enterprise**。