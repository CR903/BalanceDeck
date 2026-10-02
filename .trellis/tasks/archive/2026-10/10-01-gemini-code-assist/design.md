# Design: Gemini Code Assist 适配器

## Architecture

```
┌─ 凭据（只读，5 路径，ENOENT 安全）────────────────────────────────────┐
│                                                                        │
│  $GEMINI_CLI_HOME/oauth_creds.json   ← gemini.ts 导出 geminiHome()    │
│  ~/.gemini/oauth_creds.json             认 env，与 CLAUDE_CONFIG_DIR  │
│                                         / CODEX_HOME 同一惯例          │
│  $GOOGLE_APPLICATION_CREDENTIALS                                       │
│  ~/.config/gcloud/application_default_credentials.json                  │
│                                                                        │
│  ❌ 不回写 keystore（client_id/secret 本就在上面那个文件里）             │
│  ❌ 不新增任何回传 token 的 IPC                                        │
└────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─ collect(ctx) 三步，最多 3 次出网 ────────────────────────────────────┐
│                                                                        │
│  ① token = access_token 仍有效 ? 直接用 : POST oauth2.googleapis.com/token
│     ⚠ form-encoded（不是 JSON！）  ← 接缝按调用方给的原样转发
│     ⚠ 有效时不发这一步（不新增无谓出网）                               │
│         ↓                                                              │
│  ② POST /v1internal:loadCodeAssist     body { metadata:{ pluginType:'GEMINI' } }
│         → tier（paidTier 优先）+ cloudaicompanionProject              │
│     ↓                                                                  │
│  ③ POST /v1internal:retrieveUserQuota  body { project }   ← 决定成败    │
│         → buckets[]（兼容回落 quota[]）                               │
│         ↓                                                              │
│  windows = buckets.filter(REQUESTS).map(percent-only)                  │
└────────────────────────────────────────────────────────────────────────┘
```

## Technical Decisions

### D1 · 独立代码适配器，**不进 `protocols.ts`**

四项超出 `ProtocolDecl` 的表达能力：POST body、**两次串行请求**（第二步的 body 依赖第一步的
响应）、token 刷新、本机文件读取。`ProtocolDecl.read` 是 `(body: unknown) => ProviderWindow[] | null`
的**同步纯函数**，而 Gemini 的解析天然两阶段 —— 结构上装不下。

更硬的理由：**加进 `SELECTABLE_PROTOCOLS` 会打红共享黄金样本 T12**
（`test-adapters.mjs` 的自定义协议目录断言），而 `test-adapters.mjs` 是共改文件、
不能改它的期望值。产品语义也不对：Code Assist 实例不是「用户自己填 Base URL 的中转」。

### D2 · `readJson` 扩为**可选**第 5 参（接缝之后新暴露的缺口）

**这是调研之后新发现的问题。** 接缝给 `CollectRequest` 加了 `method`/`body`，
但 `engine.ts:96-111` 的 `readJson` 写死：

```ts
const res = await ctx.request({ url, headers, timeoutMs })   // ← 不透传 method/body
```

Gemini 的三个端点**全是 POST** → 它**用不了 `readJson`**。
若绕过 `readJson` 直接调 `ctx.request`，就要重写它 10 行里最有价值的部分
（JSON.parse 失败时截断 200 字，供「响应格式未识别：<预览>」用）—— 而那正是 R5 要复用的。

**做法**：加**可选**第 5 参，既有 **7 个调用点一行不改**：

```ts
export async function readJson(
  ctx: CollectContext,
  url: string,
  headers: Record<string, string>,
  timeoutMs = 12000,
  opts?: { method?: 'GET' | 'POST'; body?: string }
): Promise<{ status: number; body: unknown }>
```

与接缝任务同一套纪律：**纯增量 + 用 18 套件断言数零变化证明零影响**。
（既有 7 个调用点全是 GET，语义不变。）

### D3 · `mark` 与 preset id / protocol id **三者同为 `'gemini'`**

`providerMark(id)` 只查 `PROVIDER_MARKS[id]`，查不到就**静默回退 generic 插头图标**。
`mark` 的取值是 `inst.presetId || inst.protocol`。若 preset=`gemini` 而 protocol=`gemini-code-assist`，
**自定义实例会拿不到 logo**。

既有反例就在仓库里：preset `claude` / protocol `claude-code`，而 `PROVIDER_MARKS` 只有
`"claude"` 键 —— **自定义 claude 实例今天就是 generic 图标**。Gemini 不重复这个错误。

### D4 · 图标：**跑脚本**，不手改

`provider-icons.ts:1-2` 写明由 `scripts/gen-provider-icons.mjs` 生成、勿手工编辑。
id 清单维护在该脚本的 `MARKS` 常量里（`opencode`/`claude`/`codex`/… 那张表）。
加 `gemini: { icon: 'simple-icons:gemini', color: <品牌色> }` 后**跑脚本**。
`provider-icons.ts` 的 diff 应当**只有新增一个键** —— 若是整文件重排，说明脚本行为变了，要查。

### D5 · 凭据只读，且**不新增 UI**

`client_id` / `client_secret` **本来就在** `~/.gemini/oauth_creds.json` 里
（google-auth-library 写回的 `Credentials` 含这两个字段）。复制进我们的 `secrets.bin` =
把用户 Gemini CLI 的长效凭据搬进第二个存储，且 `gemini logout` 后变成孤儿凭据。

v1 不做「手填 refresh token」：那需要新 UI + `keyHint` + 一个只回布尔的 IPC 通道，
而本任务的全部价值在解析链路，UI 是另一件事。**零 UI 改动**（`provider-icons.ts` 这个
生成物除外）。

### D6 · 测试注入用 env 指向临时目录

**理由**：`loadTs` 每次重新求值模块，**无法猴补它的 import** —— 调研 §5 推荐的
「可注入的读文件函数」在当前测试基建里做不到。而 env 是仓库既有惯例
（`CLAUDE_CONFIG_DIR` / `CODEX_HOME`），且顺带把**路径解析逻辑**也测了。

V 段在开始时 `process.env.GEMINI_CLI_HOME = <临时目录>`（`mkdtempSync`），
段末恢复原值。**V 段是最后一段**（插在汇总行之前），所以它不会影响任何既有段。

⚠ 临时 `oauth_creds.json` 里只能用**明显假的**值（凭据字面量红线，`keystore.ts:6`）。
测试要 client_id/secret 时**走「从文件读」这条路径**喂假值，
**根本不需要在 fixture 里出现这两个常量**。

### D7 · 窗口：percent-only，**不硬造 limit**

`ProviderWindow` 在 `unit: 'percent'` 时约定 `used = 百分比值`（`types.ts:16-18`），
UI 优先用 `percent` 画环。Gemini 只给 `remainingFraction`、**没有可靠的绝对上限**
（`remainingAmount` 只在部分时刻给，且 100% 时省略）。

不引入 `claude.ts` 的「社区预设限额 + `extras limits:claude` 覆盖」：
Code Assist 限额随 tier 变且 2026 年改过多次，**没有可靠默认值**，硬造会给出假数字。

`resetAt` 缺失时**整个字段省略**（`stable()` 会过滤 `undefined` 值，
所以正确断言是「不把它写进期望对象」，不是写 `field: null`）。

### D8 · 免费档退役用 `errSnap`，不是 `ok` + 空窗口

表面上两者展示效果差不多（`applyCachePolicy` 把 `status==='ok' && windows.length===0`
也算降级）。但 `errSnap` 会填 `failureReason`，而托盘读的正是
`degradedReason ?? detail`（`quality.ts:57` 的取值顺序让 `failureReason` 优先透出）——
**`errSnap` 的文案能直接透出到托盘**。

且这是**终态**（数据源 2026-06-18 永久消失），不是临时故障，`error` 语义更诚实。

## Contracts

### engine.ts（只加可选第 5 参）

```ts
const res = await ctx.request({ url, headers, timeoutMs, ...opts })
```

### gemini.ts 的凭据发现（导出以便测试与复用）

```ts
export function geminiHome(): string {
  return process.env.GEMINI_CLI_HOME || join(homedir(), '.gemini')
}
export function readGeminiCreds(): GeminiCreds | null   // 逐路径 try/catch，ENOENT 安全
```

### 窗口组装

```ts
{ name: b.modelId, used: pct, percent: pct, unit: 'percent',
  resetAt,                       // resetTime 缺失 → undefined → 字段整个省略
  note: '官方配额接口' }
```

## Validation & Error Matrix

| 条件 | 行为 | 文案要点 |
|---|---|---|
| 5 条凭据路径全未命中 | `noDataSnap` | 点名入口：先跑 `gemini` 登录 |
| 任一业务端点 401/403 | `errSnap` | 「凭据失效：请重新运行 `gemini` 登录」 |
| token 端点 **400** + `invalid_grant` | `errSnap` | 「refresh token 被吊销」——⚠️ **不是 401** |
| 403 + `details[].reason === 'SECURITY_POLICY_VIOLATED'` | `errSnap` | 点名 VPC 服务边界。⚠️ **不照抄 gemini-cli 假装 standard-tier** |
| 403 + `cloudaicompanionProject === 'cloudshell-gca'` | `errSnap` | 给 `gcloud config set project <ID>` |
| `loadCodeAssist` 200 但 project 为空 | `errSnap` | 「未绑定 Code Assist 许可」 |
| `currentTier.id === 'free-tier'` 或 `ineligibleTiers` 含之 | `errSnap` | 2026-06-18 退役 + 指向 Standard/Enterprise |
| 200 但 `buckets`/`quota` 缺失或非数组 | `errSnap` | `响应格式未识别：<160 字符预览>` |
| 无可用 `REQUESTS` 桶 | `errSnap` | 非 `ok` + 空窗口（空 `windows` 在 `applyCachePolicy` 眼里也是降级） |
| status ∉ {200, 401, 403} | `errSnap` | `HTTP <status>` |
| `ctx.request` 抛错 | `errSnap` | `请求失败: <message>` |
| 成功 | `officialSnap` | `source: '官方接口'`、`dataQuality: 'official'` |

## Good / Base / Bad Cases

- **Good**：Standard 档，`loadCodeAssist` 返回 `standard-tier` + project，
  `retrieveUserQuota` 返回 2 个 `REQUESTS` 桶 → 2 个 percent 窗口，plan `Standard`。
- **Base**：用户有 Gemini CLI 但账号是免费档 → `errSnap`，托盘上直接显示
  「Google 已于 2026-06-18 关停免费/Pro/Ultra 档」。**这是预期路径，不是 bug。**
- **Bad**：把 `buckets` 之外的键也当数组解析（比如把 `error` 对象当 buckets 迭代）
  → 必然产出 `NaN` percent 或空窗口被误判成 ok。守卫是 `Array.isArray`。

## Tests Required

1. **V 段（`test-adapters.mjs`，插在汇总行之前）**：prd.md 的 AC5–AC23。
2. **共享文件只追加**：既有 A~U 段与汇总行**一行未改**；
   `PROTOCOLS.length === 8` 仍绿（`protocols.ts` 零改动）。
3. **`readJson` 扩展的零影响证明**：18 套件断言数与改动前**完全一致**。
4. **静态守卫**（每条都要**前置断言**，否则负向断言会空洞通过）：
   - `gemini.ts` 走 `method: 'POST'`（改回 GET 必须红）
   - `retrieveUserQuota` 的 body 含 `project`（删掉必须红）
   - `gemini.ts` 未 import 任何 `keychain`/`setKey`（不回写凭据）
   - token 刷新的 `Content-Type` 是 form-urlencoded（不是 JSON）
5. **两个必做反验**：改回 GET 必须红；删掉 `project` 必须红。

## Wrong vs Correct

#### Wrong
把 `project` 塞进 URL query（`?project=xxx`）来绕开「夹具送不出 body」：

- 那是**为迁就测试而扭曲生产协议** —— 而 `project` 恰恰是 Google 端点的正确传法。
- 现在接缝已经支持 body 了，这条路的前提**已经不成立**。

#### Correct
按 D2 扩 `readJson` 的可选参数，用接缝已有的 `callProjectRich` 断言 body。
AC8（body 恰好是 `{ project }`）与 AC31（删掉 `project` 必须红）就是它的守卫。

## Out of Scope

- `protocols.ts`（四家共用，会冲突）
- 免费/Pro/Ultra 档（2026-06-18 已关停，不是技术选择）
- 用户手填 refresh token 的 UI（v2）
- Antigravity 继任产品（**另一个任务**，它的凭据在系统钥匙串不在文件里）
- 本机估算降级（Gemini CLI 没有类似 `~/.claude/projects/*.jsonl` 的用量转录，
  硬造 `local` 快照只会给出无意义的数字）
- `daily-cloudcode-pa.googleapis.com` 备用主机（单一来源未验证，只留 env override）