# Research 07 · 需要用户确认的问题

- **Date**: 2026-10-01
- **状态**: 待用户拍板。每条都给了推荐与影响面。

---

## Q1（阻塞性）· 与现有 `codex` 卡片的关系

**背景**：`src/main/adapters/codex.ts` 已经是一个内置预设
（`providers.ts:76-84`，`protocol='codex'`，`kind='coding'`，`singleton`），
它读 `~/.codex/sessions/**/*.jsonl`，从 `token_count` 事件的
`payload.rate_limits.{primary,secondary}` 产出 5 小时 / 本周窗口，
并把 `plan` 设为 `'ChatGPT 订阅'`（`codex.ts:253`）。

而 `wham/usage` 的 `rate_limit.primary_window/secondary_window`
**就是同一份服务端真值**，只是从 rollout 快照 vs 主动查询两个来源拿。

**问题**：装了 Codex CLI 的用户，加了新适配器后会看到**两张卡片
显示同一份额度**。

| 选项 | 说明 | 影响 |
|---|---|---|
| **A（推荐）· 升级 `codex.ts` 的数据源** | 在 `codex.ts` 内把 `rate_limits` 优先级降到 `wham/usage` 之下（官方优先），jsonl 只作兜底。本机估算口径保留 | 用户无感、无重复卡片；但改动已有内置适配器，需确认不破坏现有行为（`codex.ts` 目前**没有任何 fixture**） |
| **B · 独立适配器，接受两张卡** | 新增 `openai-chatgpt.ts` 独立存在 | 实现最干净、风险最低；但产品上有重复信息（违反 `guides` Step 5「口径要跟着数据走」） |
| **C · 独立适配器 + 仅在无 Codex CLI 时出现** | 检测不到 `~/.codex` 才显示新卡 | 逻辑分支多、用户难以预测「为什么我的卡不见了」 |

**推荐 A**，理由：它同时提升精度（服务端直查 vs 读快照）并消除重复。
若担心改坏 `codex.ts`，退而选 B。

---

## Q2 · 是否需要显式开关才读 `~/.codex/auth.json`？

**背景**：CodexBar（MIT）把「读另一个应用的 OAuth 文件」
（External Codex OAuth sources）做成**默认关闭**的开关，
README 写明 "This cross-application credential access defaults off."

| 选项 | 说明 |
|---|---|
| **A（推荐）· 不加开关** | 与现有 `claude` / `codex` / `copilot` 预设一致：它们都直接读 `~/.claude`、`~/.codex`、`~/.config/github-copilot`（`providers.ts:67-93`，`localCredential: true`）。用户点了「添加 Codex」就是授权读 Codex 的凭据，语义一致 |
| **B · 加开关** | 更保守；但会与仓库既有的三个本机文件型预设**语义不一致**，且设置页要多一个控件 |

**推荐 A**，理由是**一致性**：本仓库已经把「读某个 CLI 的登录凭据」当作
内置预设的正常语义。

无论选哪个，UI 文案必须写清「读取的是 Codex CLI 自己的登录凭据文件，
我们不会修改它」，**绝不**要求用户输入 ChatGPT 密码（风险 R8）。

---

## Q3 · 多 Codex home / 多账号是否要支持？

**背景**：`auth.json` 是单账号的。多账号需多套 `CODEX_HOME`，
但 **`CODEX_HOME` 是进程级环境变量**，本仓库的 `ProviderInstance`
机制无法无歧义地把不同 home 绑到不同实例。

| 选项 | 说明 |
|---|---|
| **A（推荐）· v1 只支持默认 `$CODEX_HOME` 或 `~/.codex`** | 与 `codex.ts:41-43` 现状一致。文档注明限制 |
| **B · 支持「路径 + 环境变量前缀」的多 home** | 需要新的实例字段（`ProviderInstance` 加字段 → 共享 `shared/types.ts`，四个子任务都会受影响） |

**推荐 A**。多账号需求留给用户自己改 `CODEX_HOME` 启动。

---

## Q4 · 共享文件的合并策略

**背景**：本任务与其它三家适配器子任务都要改
`src/main/adapters/index.ts`（`CODE_ADAPTERS`）、
`scripts/test-adapters.mjs`（追加段）、
`scripts/gen-provider-icons.mjs`、`src/renderer/src/provider-icons.ts`、
`src/main/providers.ts`（`BUILTIN_PRESETS`）。

| 选项 | 说明 |
|---|---|
| **A（推荐）· 串行合并 / 或四家合到一个 PR** | 冲突面清晰，`git diff` 可审 |
| **B · 并行开发，收尾时统一 rebase** | 冲突集中在一个提交里解决 |
| **C · 本任务只交付适配器文件，注册留 TODO** | 留下「代码存在但未生效」的半成品状态，不推荐 |

**推荐 A**。同时**段字母需要协商** —— 我建议本任务用 `V`，
但若其它子任务也选了 `V`，需改成 `V-OpenAI` 之类带语义的标题。

---

## Q5 · 是否先做一次真实凭据实测？

**背景**：本调研**零实测**（无 ChatGPT Plus/Pro 凭据）。
所有关于 `wham/usage` 的字段形状都来自二手：

- CodexBar issue #2900（实测样本，EDU 账号，脱敏）
- gist `monperrus/21dc7d85ea518dc2a66606006d356b5b`（非官方，页面超时，只读到搜索摘要）
- CodexBar `docs/codex.md`（描述性，非样本）

`.trellis/spec/guides/external-api-integration.md` Step 1~2 的核心教训正是
「不要相信第三方文档，实测真实产品」，并记录了一次
「三次 'curl 实测 200' 但功能从未工作过」的教训。

| 选项 | 说明 |
|---|---|
| **A（推荐）· 先实测** | 用一个有 ChatGPT 订阅的账号：① `codex login`；② 打开 `https://chatgpt.com/codex/settings/usage` 抓它自己的请求（确认端点/头/间隔）；③ 把真实响应脱敏后存成 fixture。**只做一次，产出就是 fixture + 文档** |
| **B · 直接按二手实现** | 快，但字段漂移时排查方向不明 |

**推荐 A**，且实测结果应回写到 `02-endpoints-and-auth.md`
并把「未验证」逐条改成「已验证（日期）」。

⚠ 实测时的安全要求：`store.ts:13`「源码、示例、测试禁止出现可用凭据字面体」——
真实响应必须脱敏（`email` / `user_id` / `account_id` / token 全部替换）。

---

## Q6 · `openai-billing` 的处置（**超出本任务范围**）

调研发现 `/v1/dashboard/billing/subscription` 有强证据已废弃
（不在 OpenAI 公开 API reference；CodexBar 称之为 legacy 且
「not part of OpenAI's current public API reference」；社区多帖反馈无响应）。

| 选项 | 说明 |
|---|---|
| **A（推荐）· 本任务不动，单独上报** | `protocols.ts` 是共享文件，改它必然与其它子任务冲突；且这属于既有行为的变更，需要独立决策 |
| **B · 顺手改成 Admin API** | 越界 + 需要 Admin key（多数用户没有），会改变 `kind` 语义 |

**推荐 A**。建议在实现过程中若实测到 404/401，作为独立任务上报。

---

## Q7 · v1 功能边界

| 端点 | 建议 | 理由 |
|---|---|---|
| `wham/usage` | **做** | 唯一必需 |
| `wham/rate-limit-reset-credits` | 不做 | 有明确 429 记录（openai/codex#37934），且是锦上添花 |
| `accounts/{id}/spend-controls/current-user/monthly-usage` | 不做 | 普通 Plus/Pro 无此额度（EDU/Business 管理员限定），必然大量 404 |
| `/backend-api/codex/usage` | 不做 | **未验证**是否存在 |
| 每模型明细 / `additional_rate_limits` | 不做（可留口） | 解析器保留 `unknownFields` 出口即可，不主动渲染 |

**确认**：v1 只做 `wham/usage` 的 `plan_type` + `primary_window` + `secondary_window`，
外加 `reset_at` → ISO 时间，是否同意？

---

## 已替你做完的技术决策（无需回答，仅备案）

| 决策 | 结论 | 依据 |
|---|---|---|
| `kind` | `coding` | `05-design-decisions.md` §1.1 |
| 窗口形状 | `{ used: 0, unit: 'token', percent, resetAt, note: '服务端真值' }` | 与 `codex.ts:155-182` 同形 |
| `mark` | 新 id 复用 `simple-icons:openai` | `bind-instance.ts:27` |
| 端点常量单独成模块 | `openai-chatgpt-api.ts` | 层内规则第 1 条「常量只有一个来源」 |
| 解析器返回未知字段列表 | 必须 | 层内规则第 3 条 |
| 不写回 `auth.json` | 必须 | CodexBar 明文规定 + 本仓库诊断/产品同源纪律 |
| `extras` 绝不存 token | 必须 | `ipc.ts:58-61` + `test-structure.mjs` E3b/E3d/F6 |
| 测试段字母 | `V`（待与其它子任务协商） | `05-design-decisions.md` §3.1 |