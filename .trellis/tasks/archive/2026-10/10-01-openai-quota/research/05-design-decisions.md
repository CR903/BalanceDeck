# Research 05 · 设计决策：kind / mark / 扩展还是新增 / 测试落点

- **Query**: `kind` 与 `mark` 选什么？扩展 `openai-billing` 还是新增独立文件？fixture 怎么造？
- **Scope**: internal
- **Date**: 2026-10-01

---

## 1. Q6 · `kind` 与 `mark`

### 1.1 `kind` 推荐：`coding`

`ProviderKind` 定义（`src/shared/types.ts:6-11`）：

```
balance — 直连查余额（按量付费平台）
coding  — Coding plan（订阅制，看用量/限额/重置时间/tokens）
token   — Token plan（按 token 计费的套餐）
```

| 候选 | 评价 |
|---|---|
| `balance` | ❌ 语义反了。`quality.ts:27` 的 `isPlan = kind !== 'balance'` 决定了卡片画不画用量环、叫「余额」还是「套餐」。订阅额度必须画环 |
| `token` | ⚠ MiniMax 用它（`protocols.ts:287`），因为 MiniMax Token Plan 有真实的 `used`/`limit` token 数。`wham/usage` **只给百分比**，没有 token 数 |
| **`coding`** | ✅ **推荐**。Copilot 也是「按次计费」却仍用 `kind:'coding'` + `unit:'token'`（`copilot.ts:20-26` 注释明说「Copilot 按次计费（非 USD），用 'token' 统一渲染逻辑」） |

**推荐组合**（与 `codex.ts:155-182` `buildServerWindows` 完全同形，有既有先例）：

```ts
{ name: '5 小时', used: 0, unit: 'token', percent: primary.used_percent,
  resetAt: new Date(primary.reset_at * 1000).toISOString(), note: '服务端真值' }
{ name: '本周',   used: 0, unit: 'token', percent: secondary.used_percent, … }
```

理由：`ProviderWindow.percent` 的注释（`shared/types.ts:25-29`）明确
「官方 API 直报使用比例 (0–100)。**有值时 UI 优先用它做环形进度图**，
比 used/limit 推算更精确」。`used: 0` + `percent` 是本仓库对
「只有百分比」的唯一既定表达（`codex.ts` 就是这么做的）。

> ⚠ **注意 `reset_at` 是 Unix 秒**（`1786617181`），不是 ISO 字符串。
> `codex.ts:163-165` 走的是 `resets_in_seconds`，需要自己 + nowMs；
> `wham/usage` 直接给绝对秒 → `new Date(reset_at * 1000).toISOString()`。

### 1.2 `plan` 字段

`plan_type` 直接映射：`free/plus/pro/team/enterprise/education` → 「ChatGPT Plus」/「ChatGPT Pro」…

⚠ **`codex.ts:253` 已经有 `plan: rl?.primary ? 'ChatGPT 订阅' : undefined`**。
文案要统一（避免两个供应商显示不同的同类名）。

### 1.3 `mark` 推荐

`mark` 是**实例派生**的（`bind-instance.ts:27` / `protocol-adapter.ts:48`）：

```ts
mark: inst.presetId || inst.protocol    // 内置用预设 id，自定义用协议 id
```

所以只需保证新增的 id 在图标表里有条目：

| 文件 | 现状 |
|---|---|
| `src/renderer/src/provider-icons.ts` | `:37` `"src": "simple-icons:openai"`；`:93-97` `"openai-billing": { … "src": "simple-icons:openai" }` |
| `scripts/gen-provider-icons.mjs` | `:28` `codex: { icon: 'simple-icons:openai' }`；`:39` `'openai-billing': { icon: 'simple-icons:openai' }` |

**推荐**：新增条目 `openai-chatgpt`（或最终选定的 protocol id）→ 复用
`simple-icons:openai`，与 `openai-billing` / `codex` 同图标。

**不要**把新协议挂到已存在的 `openai-billing` 键上 —— 那会让两个不同 kind 的卡片
共用一个图标 key，用户在设置页无法区分（且 `providers.ts` 目录里会重名）。

---

## 2. Q7 · 扩展 `openai-billing` vs 新增独立文件

### 2.1 推荐：**新增独立代码适配器**，不动 `openai-billing`

理由（逐条可验证）：

| 判据 | `openai-billing`（声明式） | ChatGPT 订阅（需要） |
|---|---|---|
| host | `api.openai.com` | `chatgpt.com` |
| 鉴权 | 单头 `Authorization: Bearer <sk->`（`protocol-adapter.ts:69-72` 写死） | **两个头**（Bearer + `ChatGPT-Account-Id`） |
| 凭据来源 | 设置里填的 key（`provider:<id>` extras + `items`） | **本机文件** `~/.codex/auth.json`（或环境变量） |
| 请求数 | 1（`ProtocolDecl.probe` 只有一个） | 1 必需 + 2 可选（reset-credits / monthly-usage） |
| `kind` | `balance` | `coding` |
| 窗口语义 | `used/limit` 金额 | `percent` + `resetAt`（无绝对量） |
| 降级 | 统一 401/403/404 映射 | 需要 401/403/429/非JSON/结构变更多档（见 04 §4.2） |
| 未识别形状 | `unrecognizedHint` 单串 | 需要「未知字段名列表」信号（`unknownMeters` 式） |
| 自愈 | 声明式工厂没有 `ctx.setKey` 回写路径 | token 过期需引导 `codex login` |

**`ProtocolDecl` 的形状本身表达不了这个协议** —— 这与
`docs/adr/0001-protocol-owns-the-query.md:12-14` 的分类完全一致：

> 「声明表达不了的协议（**请求签名、浏览器会话、本机文件、备用端点**）仍走代码适配器」

本协议同时踩中「本机文件」+「需要额外请求头」+「备用端点」三条。

### 2.2 ⚠ 决定性证据：新增声明会打破共享测试

`scripts/test-adapters.mjs:752-756`：

```js
eq(Object.keys(PROTOCOLS).length, 8,
   'N7 声明表恰好 8 条：deepseek / moonshot / zhipu / siliconflow / siliconflow-intl / openrouter / openai-billing / generic')
```

→ 只要往 `protocols.ts` 加一条声明，**N7 必红**。而 `protocols.ts` 是
任务书明令「四家适配器子任务共用，不要碰」的共享文件。

→ **不动 `protocols.ts` 既符合 ADR-0001，也是唯一不与其它三个子任务冲突的做法。**

### 2.3 备选方案评估：扩展 `codex.ts`？

⚠ 这是一个**真实的开放问题**，因为：

- `codex.ts` 已经 `kind: 'coding'`，已经在读 `~/.codex`（`:41-43`），
  已经输出 5 小时 / 本周窗口（`:155-182`），`plan` 已经是「ChatGPT 订阅」（`:253`）
- 而 `wham/usage` 的两个窗口，**与 `codex.ts` 从 rollout jsonl 里读的
  `rate_limits.primary/secondary` 是同一份服务端真值** —— 只是来源不同
  （jsonl 快照 vs 主动查询）

**代价**：装了 Codex CLI 的用户会看到**两张卡片显示同一份额度**
（`codex.ts` 的 local 估算 + 新卡的 official），违反
`.trellis/spec/guides/external-api-integration.md` Step 5「口径要跟着数据走，
别让人以为两份是不同的东西」。

→ **建议先按「新增独立适配器」做，把合并与否交给用户拍板**（见 `07-open-questions.md` Q1）。
若用户选了合并，则改为**在 `codex.ts` 内升级数据源**（jsonl → `wham/usage`），
而不是加第二张卡。

### 2.4 建议的文件形状

```
src/main/adapters/openai-chatgpt-api.ts     ← 端点/请求头常量（唯一来源）
                                               对齐 opencode-console-api.ts 的角色
src/main/adapters/openai-chatgpt.ts         ← 适配器本体 + parse 函数（纯函数，可单测）
```

⚠ **不要** import electron；出网走 `ctx.request`（`types.ts:31-35`）。
这是 opencode 家族「能进单测」的前提（`opencode-cookie.ts:270-272` 的注释：
「这里曾经自己 fetch 并直接 import ../net，那条依赖让整个 opencode 家族无法被单测加载」）。

注册（`src/main/adapters/index.ts:24-32` `CODE_ADAPTERS` + `:41-59` `buildAdapters`）。
⚠ `index.ts` 也被四家共用 —— 见 `07-open-questions.md` Q4（合并冲突）。

---

## 3. Q8 · 测试落点

### 3.1 已占用的段位（`scripts/test-adapters.mjs`）

| 段 | 内容 | 行 |
|---|---|---|
| A/B | DeepSeek 内置 / 自定义 | 235 / 314 |
| C/D | Kimi 内置 / 自定义 | 368 / 419 |
| E/F | 智谱 内置 / 自定义 | 440 / 487 |
| G/H | 硅基流动 内置 / 自定义 | 519 / 546 |
| I | SiliconFlow 国际 | 561 |
| J | OpenRouter | 571 |
| **K** | **OpenAI 计费（openai-billing）** | **581-593** |
| L | 通用 JSON | 595 |
| M | MiniMax（代码适配器） | 608 |
| N | 实例绑定 + 声明表边界（N7 恰好 8 条） | 666 |
| T / T-b | 存储、注册表、路由；多账户分组 | 762 / 949 |
| R | 生产出网 `request.ts` + `net.ts` | 1020 |
| S | `collectAll` + 身份重盖 | 1108 |
| U | 收口验收：内置 vs 自定义一致性 | 1180 |

→ **建议新开 `V` 段**（追加在 U 之后、`:1221` 的 `console.log(通过…)` 之前）。
⚠ **必须与其它三个适配器子任务协商** —— 都在同一个文件尾部追加会冲突。
建议：各自用带语义的前缀标记段标题（如 `V. OpenAI ChatGPT 订阅`），
并在追加时用 `git diff` 检查是否覆盖了别人的段落。

### 3.2 可直接复用的测试脚手架

```js
makeCtx({ key, extras, request, onKey, onSetKey })   // :79-92
makeRequest(routes)                                  // :98-110  ★ 精确匹配 URL
check(label, { adapter, key, extras, routes, expect })// :189-200
project(s)                                           // :121-135  冻结字段集
DEFAULTS / ok / err / nodata / expectFor(protocol, builtin)  // :139-187
```

`makeRequest` 的价值：**未覆盖的 URL 直接抛 `TypeError`**
（`:105`：`本套件未覆盖的 URL`）→ 自动守住「适配器只请求列出的端点」。

### 3.3 ⚠ 坑：`callProject` 会丢掉自定义请求头

`test-adapters.mjs:112-118`：

```js
function callProject(url, headers) {
  return { url, auth: headers.Authorization ?? …, accept: headers.Accept ?? null }
}
```

**只记录 `url` / `auth` / `accept` 三个字段。**
若要断言 `ChatGPT-Account-Id`，必须：

- 方案 a：把 `callProject` 扩成记录全部头 —— 改共享文件，**冲突风险**
- 方案 b：在本段内自建一个局部 projector（如 `const callWithAcct = (url, h) => …`）
- 方案 c：把 `ChatGPT-Account-Id` 编进 URL 之外的可观测行为（不推荐）

→ **推荐 b**：段内局部 helper，不动共享的 `callProject`。

### 3.4 建议的断言清单

| # | 断言 | 依据 |
|---|---|---|
| V1 | `plan_type: 'pro'` → `plan: 'ChatGPT 订阅'`、`kind: 'coding'` | `codex.ts:253` |
| V2 | `primary_window` → `{ name: '5 小时', used: 0, unit: 'token', percent: 14, resetAt: <ISO>, note: '服务端真值' }`，**请求头带 `ChatGPT-Account-Id`** | `codex.ts:155-182` |
| V3 | `secondary_window` → `{ name: '本周', … }` | 同上 |
| V4 | `secondary_window: null` → **只产出一个窗口**，且 `note` 说明只有一个窗口 | gist：`secondary_window` 可为 null |
| V5 | `limit_window_seconds` 不同 → 窗口名按秒数映射（**不硬编码 5h/7d**） | `opencode-console-api.ts:34-46` 的教训 |
| V6 | 出现未知字段 → `status:'error'`、`failureReason` 含字段名 | `unknownMeters` 模式（`opencode-cookie.ts:106-111`） |
| V7 | 401 → 文案点名 `codex login` | `authFailedMessage` 模式（`protocol-adapter.ts:26-38`） |
| V8 | 403 / 429 与 401 文案**互不相同** | `consoleAuthMessage` 的 401/403 分档（`opencode-console-api.ts:144-158`） |
| V9 | `~/.codex/auth.json` 缺失 → `status:'nodata'`、文案点名该路径 | `codex.ts:197` 的同形先例 |
| V10 | `dataQuality`：ok = `official`；error/nodata = `undefined` | ADR-0002 / `engine.ts:11-19` |
| V11 | 请求序列：**只请求列出的端点**（`makeRequest` 自动守） | `:105` |
| V12 | 快照里**不含**任何 token/account_id 片段 | `opencode-cookie.ts:249` |

### 3.5 fixture 造法

**用真实响应形状**（CodexBar issue #2900 的 EDU 样本，已脱敏），
不要用 `ok: () => ({})` 这种最小对象 —— 那样测不到
「`secondary_window` 为 null」「`additional_rate_limits` 为 null」这些真实分支。

`.trellis/spec/guides/external-api-integration.md` Step 2：
「A frozen fixture is fine **as a fixture**. It is not evidence about the live system.
**Label it as such.**」
→ fixture 上方注释写明「形状来源：CodexBar#2900（MIT）实测样本，2026-10-01 转录；
未在本机实测」。

---

## 4. 其它必须知道的测试盲区

`scripts/test-adapters.mjs` **只覆盖**：
8 条声明式协议 + MiniMax + 绑定 + 存储/路由 + 出网实现 + collectAll。

**`opencode` / `claude` / `codex` / `copilot` 四个代码适配器没有任何 fixture。**

→ 本任务会是**第一个除 MiniMax 外带黄金样本的代码适配器**。这是好事
（Step 8「先弄坏它一次，确认测试真的会红」），但也意味着没有现成的
`expectFor(codeAdapter)` 惯例可抄 —— `codex.ts` 的输出形状得手工推导。

⚠ `codex.ts` 在 `codexHome()` 里读 `process.env.CODEX_HOME`。
测试里若要指向临时目录，**必须设/清这个环境变量**，否则会读到真实 `~/.codex`
（fixture 测试绝不能碰用户真实文件 —— `store.ts:13`：「源码、示例、测试禁止出现可用凭据字面体」）。

---

## 相关文件

| 路径 | 行 | 作用 |
|---|---|---|
| `src/shared/types.ts` | 6-11, 13-30 | `ProviderKind` / `ProviderWindow` |
| `src/main/adapters/index.ts` | 24-32, 41-59 | `CODE_ADAPTERS` 注册 + 路由 |
| `src/main/adapters/bind-instance.ts` | 19-67 | 实例绑定（含 `setKey` 透传） |
| `src/main/adapters/codex.ts` | 155-182, 249-259 | percent-only 窗口的既有形状 |
| `src/main/adapters/copilot.ts` | 20-26 | 「非 USD 但用 token 渲染」的先例 |
| `src/main/adapters/opencode-console-api.ts` | 34-46, 106-158 | 端点常量唯一来源 + 结构变更信号 + 401/403 分档 |
| `scripts/test-adapters.mjs` | 79-200, 581-593, 752-756, 1180-1222 | 脚手架 / K 段 / N7 / 段尾 |
| `docs/adr/0001-protocol-owns-the-query.md` | 11-14 | 声明 vs 代码适配器的分类判据 |
| `.trellis/spec/guides/external-api-integration.md` | Step 1-9 | 本任务的方法论依据 |

## Caveats

- `V` 段字母未经协商，可能与其它三个适配器子任务冲突。
- `renderedPct` 的具体实现位置未查（`opencode-cookie.ts:171` 提到它）——
  实现时需确认 `percent: undefined` 时 UI 的实际表现。
- `mark` 的图标表（`provider-icons.ts`）不在任务书的共享文件清单里，
  但 `gen-provider-icons.mjs` 可能会被多个子任务同时改。**建议合并到一个 PR 或串行执行。**