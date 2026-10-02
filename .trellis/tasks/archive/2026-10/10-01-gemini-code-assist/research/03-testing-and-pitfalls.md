# Research 03 — 测试落点与断言设计

- **Query**: Q7 fixture 怎么造？断言点应该有哪些？共享文件只能追加段，怎么追加？
- **Scope**: internal（`scripts/test-adapters.mjs` 结构 + 01 的协议结论）
- **Date**: 2026-10-01

---

## 1. 共享文件结构（先摸清段位，避免撞段）

`scripts/test-adapters.mjs` 共 1222 行，段标记在 `═══` 分隔的注释块里：

| 段 | 主题 | 行号 |
|---|---|---|
| 头部说明 | 为什么要这套夹具 | 1–28 |
| 工具 | `stable` / `eq` / `makeCtx` / `makeRequest` / `callProject` / `project` / `ok` / `err` / `nodata` / `expectFor` / `check` / `instBuiltin` / `instCustom` | 29–231 |
| A | DeepSeek 内置 | 233 |
| B | DeepSeek 自定义协议 | 312 |
| C | Kimi 内置 | 366 |
| D | Moonshot 自定义 | 417 |
| E(D) | 智谱 | 438 |
| F | 智谱自定义 | 485 |
| G / H | 硅基流动 | 517 |
| I ~ L | 只在自定义协议里存在的四家 | 559 |
| M | MiniMax 内置（含旧端点回落） | 606 |
| N | 实例绑定 + 声明表边界 | 664 |
| T | 存储与注册表（store / providers / buildAdapters） | 759 |
| P1-4 | 多账户分组 | 938 |
| D5 / R / S | 存储往返 / 生产出网与可达性 / 并行采集与身份重盖 | 1000–1175 |
| **U** | 收口验收：内置 vs 自定义一致性（子标签 `U7`…`U14`） | 1177–1219 |
| 汇总 | `console.log(\n通过 ${pass} 项…` + `process.exit` | 1221–1222 |

### 推荐：新增 **V 段**，插在 1220 行与 1221 行之间

```js
// ═══════════════════════════════════════════════════════════════════════════
// V. Gemini Code Assist（代码适配器 · adapters/gemini.ts）
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nV. Gemini Code Assist（代码适配器）')
…（V 段内容）

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)   // ← 原有 1221 行，位置不动
process.exit(fail === 0 ? 0 : 1)                // ← 原有 1222 行，位置不动
```

- `U` 已被「收口验收」块占用（且其子标签已到 `U14`），`V` 是下一个空闲字母。
- **只追加，不改动任何既有行** —— 满足「多人共改的共享文件」的约束。
- 段内子标签从 `V1` 起编号。

⚠️ 落笔前先跑一次 `node scripts/test-adapters.mjs` 记下基线 `通过 N 项，失败 0 项`；追加后再跑，确认 `通过 N+k 项，失败 0 项`。

---

## 2. 🚧 结构性阻塞：夹具**送不出也看不见请求体**

这是本次测试设计最大的障碍，必须先解决或明确绕过。

### 2.1 现状

```ts
// src/main/adapters/types.ts:11-16
export interface CollectRequest {
  url: string
  headers: Record<string, string>
  timeoutMs?: number
}
// ← 没有 body
```

```ts
// src/main/request.ts:21
const res = await fetch(req.url, { headers: req.headers, signal: ctrl.signal })
// ← 没有 body，固定 GET
```

```js
// scripts/test-adapters.mjs:112-118
function callProject(url, headers) {
  return { url, auth: headers.Authorization ?? null, accept: headers.Accept ?? null }
}
// ← 只投影 url / auth / accept，body 根本不记录
```

```js
// scripts/test-adapters.mjs:98-110
request: async (req) => {
  list.push(callProject(req.url, req.headers ?? {}))
  const r = routes.find((x) => x.url === req.url)   // ← 只按 URL 匹配
  ...
}
```

**后果**：
- Gemini 适配器发出的 `POST …/v1internal:loadCodeAssist` 与 `POST …/v1internal:retrieveUserQuota` **在生产与测试里都会退化成无 body 的请求**。真实环境会 400，夹具里则「假装成功」。
- **`{ project: ... }` 这个最关键的字段（01 P2）完全无法断言**。

### 2.2 两条路

| 方案 | 改动 | 代价 | 评价 |
|---|---|---|---|
| **A. 扩接缝**（推荐） | ① `CollectRequest` 加 `body?: string`（可选）<br>② `request.ts:21` 传 `body: req.body`<br>③ 测试桩 `callProject` 加 `body` 投影；`routes` 仍**只按 url 匹配** | 改 1 个共享类型 + 1 个生产模块 + 夹具工具函数各一行 | `body` 可选 ⇒ **所有既有适配器调用点零改动**；`routes` 匹配逻辑不变 ⇒ **既有 A~U 段全部 fixture 零影响**。这是干净的最小扩 |
| B. 不扩 | 适配器绕过 `ctx.request`，自己 `fetch` | 破坏「出网是注入能力」这条 ADR-0003 的核心纪律，且测试无法加载（electron 依赖） | ❌ 不可行 |

**推荐 A**，但它要动共享接缝，**已列入 02 文档的待确认问题 Q-b**。若不批准，退而求其次的 B'：保留 `ctx.request`，但把 `project` 塞进 URL query（`?project=xxx`）—— ⚠️ **不推荐**，那是为迁就测试而扭曲生产协议。

### 2.3 若采纳方案 A，测试桩的最小 diff

```js
// scripts/test-adapters.mjs —— callProject 加一个字段
function callProject(url, headers, body) {
  return { url, auth: headers.Authorization ?? headers.authorization ?? null,
           accept: headers.Accept ?? null, body: body ?? null }
}
```

⚠️ **注意**：这会让 `inst.list` 的元素多一个 `body` 键，从而**打红所有断言 `inst.list` 的既有段**（`check()` 的 `expect.call` / `expect.calls`，如 A1/B1 等）。

→ **规避方式**：新增一个 `makeRequest2`（或给 `callProject` 加第三参默认 `undefined` 且**不写入返回对象**）—— 即：

```js
function callProject(url, headers) { /* 原样不动 */ }
function callProjectWithBody(url, headers, body) {
  return { ...callProject(url, headers), body: body ?? null }
}
```
V 段用自己的投影函数，**既有 `makeRequest` 与 `callProject` 一行不改**。这是本段唯一能同时做到「断言 body」与「不动既有段」的做法。

---

## 3. fixture 怎么造

### 3.1 有无真实样本？

**部分有。** 仓库里当然没有（这是新供应商），但外部有一手样本：

| 来源 | 内容 | 可信度 |
|---|---|---|
| `google-gemini/gemini-cli` `packages/core/src/code_assist/types.ts` | `BucketInfo` / `RetrieveUserQuotaResponse` / `LoadCodeAssistResponse` 的完整 TS 定义 | 高（官方源码，Apache-2.0） |
| [gemini-cli issue #27363](https://github.com/google-gemini/gemini-cli/issues/27363) 用户贴出的**真实原始响应** | 单个 bucket，`remainingAmount` 缺失、`remainingFraction: 1` | 高（真实抓包） |
| [gemini-cli `config.ts` 的 `refreshUserQuota()` 片段](https://github.com/google-gemini/gemini-cli/issues/27363)（issue 引用） | `for (const bucket of quota.buckets)` → **确认数组字段名是 `buckets`** | 高 |
| `hermes-quota-plugin` `gemini.py` | 完整流程 + 免费档退役处理 | 中（第三方，MIT；其读 `data.get("quota")` 与官方矛盾，见 01 P10） |
| `steipete/CodexBar` `docs/gemini.md` | 端点/解析/tier 映射的书面描述 | 中（第三方，MIT） |

**没有的**：多 bucket 的完整响应、全额/耗尽两个极端的实测、真实 `ineligibleTiers` 文案。

→ **结论**：夹具**手写**，基于官方类型定义 + 那条真实样本。文件头已声明这个做法（`test-adapters.mjs:9-11`：「夹具按产品代码注释与 DESIGN.md §4 的实测记录手写」），照做即可，**但应在 V 段注释里写明来源出处**。

### 3.2 建议的 fixture 常量

```js
// ── V 段夹具 ────────────────────────────────────────────────────────────────
// 来源：字段名与类型逐字取自 google-gemini/gemini-cli（Apache-2.0）
//   packages/core/src/code_assist/types.ts 的 BucketInfo / LoadCodeAssistResponse
// 单桶样本取自 gemini-cli issue #27363 的真实返回（100% 时 remainingAmount 被省略）
// ⚠️ 「quota」作为数组键的写法来自第三方实现（hermes-quota-plugin, MIT），
//    与官方类型定义矛盾 —— 作为宽容回落的兼容夹具，非官方契约。

const GEMINI_HOST = 'https://cloudcode-pa.googleapis.com'
const GEMINI_LOAD = `${GEMINI_HOST}/v1internal:loadCodeAssist`
const GEMINI_QUOTA = `${GEMINI_HOST}/v1internal:retrieveUserQuota`
const GEMINI_TOKEN = 'https://oauth2.googleapis.com/token'
const GEMINI_PROJECT = 'gen-lang-client-abc123'   // 形状仿 cloudaicompanionProject

/** loadCodeAssist：Standard 档 + 已绑定配额项目（happy path） */
const GEMINI_LOAD_OK = {
  currentTier: { id: 'standard-tier', name: 'Standard', isDefault: true, hasOnboardedPreviously: true },
  cloudaicompanionProject: GEMINI_PROJECT,
  allowedTiers: [{ id: 'standard-tier', name: 'Standard', isDefault: true }],
  ineligibleTiers: null
}

/** retrieveUserQuota：真实样本（100%，remainingAmount 缺失）—— 01 P1 */
const GEMINI_BUCKET_FULL = {
  resetTime: '2026-05-23T02:48:06Z',
  tokenType: 'REQUESTS',
  modelId: 'gemini-3.1-pro-preview',
  remainingFraction: 1
}

/** 构造一个部分消耗的 REQUESTS 桶（remainingAmount 在场） */
const gBucket = (modelId, frac, resetTime, remainingAmount) => ({
  ...(remainingAmount === undefined ? {} : { remainingAmount: String(remainingAmount) }),
  resetTime, tokenType: 'REQUESTS', modelId, remainingFraction: frac
})
```

⚠️ **凭据字面量红线**：`store.ts:13` 与 `keystore.ts:6` 都写明「源码、示例、测试**禁止出现可用凭据字面量**」。所以 fixture 里：
- ✅ 可以用 `const KEY = 'sk-golden'` 这种**明显假的**占位（同现有做法 `test-adapters.mjs:70`）
- ❌ **不要**把 Gemini CLI 的真实 `client_id` / `client_secret` 写进夹具
- ❌ **不要**造一个长得像真的 Google refresh token（`1//0eXaMpLe...`）
- 若测试需要 client_id/secret，让它走「从 `oauth_creds.json` 读」这条路径（用 `makeCtx` 的 `getExtra` 桩喂假值），从而**根本不需要在夹具里出现这两个常量**

### 3.3 本机文件路径的测试注入

`copilot.ts:49-70` 的 `readCopilotToken()` 是**直接 `readFileSync` 真实路径**，没有注入点 —— 所以 `test-adapters.mjs` 里 **copilot 根本没有夹具段**（N 段只测绑定层，不测 collect）。

⚠️ **这是一个必须先解决的测试性问题**：Gemini 适配器也要读 `~/.gemini/oauth_creds.json`，如果照抄 copilot 的写法，V 段就**无法在 CI/别人机器上稳定跑**（会读到开发机上真实的、或根本不存在的文件）。

**推荐**：给 Gemini 适配器的读文件函数加一个**可注入的根目录**：

```ts
// 参照 claude.ts:70-72 / codex.ts:41-43 的既有惯例
export function geminiHome(): string {
  return process.env.GEMINI_CLI_HOME || join(homedir(), '.gemini')
}
export function readGeminiCreds(): Creds | null { /* 读 geminiHome()/oauth_creds.json */ }
```

测试时用 `process.env.GEMINI_CLI_HOME` 指向一个 fixture 目录（`test-adapters.mjs:68` 已有 `delete process.env.BALANCEDECK_FORCE_OFFLINE` 这类 env 操作的先例）。**注意**：改 env 要在 V 段开始时设、结束时恢复，且 `test-adapters.mjs` 是单进程顺序执行 —— 放在文件**最后**（1220 行前）正好不会影响任何既有段。

---

## 4. 断言点清单

### 4.1 身份与来路（必测，ADR-0001/0002）

| # | 断言 | 期望 |
|---|---|---|
| V1 | happy path 的完整 `project(snap)` | `status: 'ok'`、`quality: 'official'`、`kind: 'coding'`、`builtin: true`、`mark: 'gemini'`、`source: '官方接口'`、`plan: 'Standard'` |
| V2 | `dataAt` 等于 `AT`（`NOW.toISOString()`） | `'2026-09-19T02:00:00.000Z'` |
| V3 | **无凭据时** `status: 'nodata'`、`quality: null` | 文案点名 Gemini 登录入口（`quality: null` 是关键 —— 断言 ADR-0002 生效） |

### 4.2 请求序列与请求头（核心）

| # | 断言 | 期望 |
|---|---|---|
| V4 | 请求序列长度 = 2（或 3，含 token 刷新） | `inst.list` 的 `url` 依次为 `[GEMINI_LOAD, GEMINI_QUOTA]` |
| V5 | 两个请求的 `auth` 都是 `Bearer <access_token>` | 断言**不带** `token ` 前缀（对比 copilot 的 `token ghu_…`，copilot.ts:106） |
| V6 | 请求头含 `Content-Type: application/json` | ⚠️ `callProject` 不投影 `Content-Type` → 若采纳方案 A 的 `callProjectWithBody`，需一并投影 header |
| V7 | （需方案 A）`loadCodeAssist` 的 body 含 `metadata.pluginType === 'GEMINI'` | 冻结 V4 里选定的 metadata 常量 |
| V8 | （需方案 A）`retrieveUserQuota` 的 body **恰好**是 `{ project: GEMINI_PROJECT }` | ⭐ **最重要的一条** —— 直接盯住 01 P2 |

### 4.3 解析（⭐ 真正的价值所在）

| # | 场景 | 期望 |
|---|---|---|
| V9 | 单桶 100%（**`remainingAmount` 缺失**） | `percent: 0`，不报错。⭐ 直接盯 01 P1 |
| V10 | 单桶 `remainingFraction: 0.965` | `percent: 3.5`（一位小数，与 copilot.ts:145 的 `Math.round(rawPct * 10) / 10` 同精度） |
| V11 | 单桶 `remainingFraction: 0` | `percent: 100`，`resetAt` 正确解析为 ISO |
| V12 | 多桶（pro + flash） | `windows.length === 2`，**每桶一个 window**，`name === modelId` |
| V13 | 非 `REQUESTS` 桶（`tokenType: 'INPUT_TOKENS'`） | **被过滤掉**（01 §3.5 语义陷阱） |
| V14 | `buckets: []`（空数组） | `errSnap`，`响应格式未识别`（不是 ok+空窗口） |
| V15 | 响应里**没有** `buckets` 键 | `errSnap` + 160 字符预览（同 copilot.ts:125-127 / protocol-adapter.ts:84-85） |
| V16 | `buckets: null` / 非数组 | `errSnap`（`Array.isArray` 守卫） |
| V17 | （宽容回落）数组键是 `quota` 而非 `buckets` | **也能解析成功** —— 冻结 01 P10 的兼容行为 |
| V18 | `resetTime` 缺失 | `resetAt` 字段**整个省略**（`undefined` 不写成字段，同 `test-adapters.mjs:44-52` 的 `stable()` 语义） |
| V19 | `remainingFraction` 缺失的桶 | 该桶被跳过，不产生 `NaN` percent |

### 4.4 降级分支（逐条对应 02 §4.2）

| # | 场景 | 期望 |
|---|---|---|
| V20 | `loadCodeAssist` 401 | `errSnap`，`quality: null`，文案含「重新登录」 |
| V21 | `retrieveUserQuota` 403 | `errSnap` |
| V22 | `loadCodeAssist` 403 + `details[0].reason === 'SECURITY_POLICY_VIOLATED'` | `errSnap`，文案点名 VPC 服务边界（⭐ 盯住「不照抄 gemini-cli 假装 standard-tier」） |
| V23 | `loadCodeAssist` 403 + `cloudaicompanionProject === 'cloudshell-gca'` | `errSnap`，文案含 `gcloud config set project` |
| V24 | token 端点 **400** + `{"error":"invalid_grant"}` | `errSnap`，文案「refresh token 被吊销」（⭐ 盯 01 P4：不是 401） |
| V25 | `loadCodeAssist` 200 + `cloudaicompanionProject` 缺失 | `errSnap` |
| V26 | `currentTier.id === 'free-tier'` | `errSnap`，文案含 2026-06-18 退役（⭐ 盯 01 P3） |
| V27 | `currentTier` 缺失但 `ineligibleTiers` 含 `tierId: 'free-tier'` | 同 V26 |
| V28 | `paidTier` 存在 | `plan` 取 `paidTier.name` 优先于 `currentTier.name`（同 CodexBar 的 tier 优先级） |
| V29 | `request` 抛 `fetch failed` | `errSnap`，`detail: '请求失败: fetch failed…'`（同 copilot.ts:163-165） |
| V30 | HTTP 500 | `errSnap`，`detail: 'HTTP 500'`（同 copilot.ts:121） |

### 4.5 实例绑定（S/N 段模式复用）

| # | 断言 | 期望 |
|---|---|---|
| V31 | `bindInstance(geminiAdapter, customInst).collect()` | `id`/`name` 取实例身份；`mark` = `gemini`（preset id 空串时回退 protocol id，因为两者同名所以值相同） |
| V32 | 内置实例与自定义实例对**同一响应**解析结果一致 | 复用 1184-1189 的 `PARSED_FIELDS` + `parsedDiff`；`expect.calls` 相同 |
| V33 | `getKey` 被调用时传的是**实例 id** 而非 `'gemini'` | 复用 `keyIds` 断言（`test-adapters.mjs:198`） |

### 4.6 不该测的（避免过度）

- ❌ 真实网络调用（套件用注入桩，`:8-12` 已声明）
- ❌ token 刷新的真实 OAuth 流程
- ❌ `applyCachePolicy` 的交互（那是 `quality.ts` 的测试范围，且需要真实 `Date.now()`）
- ❌ 图标/UI（`provider-icons.ts` 是生成物，跑 `gen-provider-icons.mjs` 即可，不进这套夹具）

---

## 5. 需要用户确认（补充 02 文档）

| # | 问题 |
|---|---|
| **Q-b**（同上） | `CollectRequest` 加 `body?: string` + 改 `request.ts:21` + 新增 `callProjectWithBody`（**既有 `callProject`/`makeRequest` 一行不动**）—— 批准吗？不批准则 V7/V8 两条断言作废 |
| **Q-g** | 夹具是否允许用 `process.env.GEMINI_CLI_HOME` 指向临时目录（需要写临时 `oauth_creds.json`）？还是让适配器接受一个可注入的读文件函数以便在纯内存里喂数据？**推荐后者**（不碰 env、不落盘、更快），但需要 `gemini.ts` 导出一个类似 `claudeConfigDir()` 的可覆盖函数 |
| **Q-h** | V 段编号用 `V`，还是并入既有 `N` 段（`N` 已在测代码适配器/绑定层）？**推荐独立 V 段** —— N 段是「通用绑定行为」，Gemini 有 30 条专属断言，混进去会让 N 段失焦 |

---

## 6. Caveats

- 我**没有**在任何真实账号上验证过任何响应样本。若用户能提供一个可用的 Code Assist Standard/Enterprise 账号，**强烈建议**先跑一次 `--uitest` 把真实响应贴回来，再冻结 fixture —— 这会把 V9/V10/V12 从「按类型定义推的」升级为「实测的」。
- `test-adapters.mjs` 的 `check()` 辅助函数（`:189-200`）的 `expect` 结构是 `{ snap, call?, calls?, keyIds? }` —— V 段可以直接复用，但 `expect.calls` 会对每个元素做全等比较，所以**请求投影的字段集一旦加了 `body`，既有段就会红**（见 §2.3 的规避方式）。
- `stable()`（`:46-53`）会过滤掉 `undefined` 值的键并对键排序 —— 所以「某字段应该不存在」的正确断言方式是**不把它写进期望对象**，而不是写 `field: null`。
- 我读了 `test-adapters.mjs` 的全部 1222 行，但**没有**读 `scripts/lib/load-ts.mjs` 与 `scripts/test-structure.mjs` —— 若 V 段需要用 `loadTs` 加载新文件（现有做法见 `:33-36`），格式照抄即可；但 `test-structure.mjs` 的门禁（E5/F6 等）在追加前应确认不会拦。
