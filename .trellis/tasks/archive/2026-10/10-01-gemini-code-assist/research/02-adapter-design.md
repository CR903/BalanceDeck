# Research 02 — 适配器设计决策（凭据 / 降级 / 类别 / 声明表）

- **Query**: Q3 凭证格式与 keystore、Q4 降级路径、Q5 kind 与 mark、Q6 协议 vs 独立适配器
- **Scope**: internal（仓库基线 + 01 的协议结论）
- **Date**: 2026-10-01

---

## 0. 推荐方案速览

| 决策点 | **推荐** | 一句话理由 |
|---|---|---|
| Q6 落点 | **独立代码适配器** `src/main/adapters/gemini.ts` + `CODE_ADAPTERS['gemini']` | 需要 POST body、两次串行请求、token 刷新、本机文件 —— 四项都超出 `ProtocolDecl` 的表达能力；且进 `SELECTABLE_PROTOCOLS` 会打红共享黄金样本 T12 |
| Q5 kind | **`'coding'`** | 与 claude / codex / copilot 同为订阅制+限额+重置时间；`token` 留给按 token 计费的套餐（minimax） |
| Q5 mark | **`'gemini'`**（preset id 与 protocol id 取同一字符串） | `PROVIDER_MARKS` 只按 key 查（provider-icons.ts:114），两者一致才能让内置与自定义实例都拿到 logo |
| Q3 凭据 | **只读 `~/.gemini/oauth_creds.json`**（+ gcloud ADC 次选）；**不写我们的 keystore** | 与 copilot.ts 读 `apps.json` 同构；`client_id`/`client_secret` 本来就在那个文件里，不需要我们自己存 |
| Q3 渲染层 | **不新增任何回传 token 的 IPC** | `tts:getSecret` 刚被下线，理由就是「明文跨进渲染层就没有结构保证」 |
| Q4 降级 | 4 条分支，全部复用 `errSnap`/`noDataSnap`；`dataQuality` 成功时 `officialSnap` | 仓库里适配器**不设** `degradedReason`（那是 `applyCachePolicy` 的活） |

---

## 1. Q6：协议 vs 独立适配器 —— **推荐独立代码适配器**

### 1.1 判据逐条比对

任务给的判据是「解析复杂度 / 是否需要多请求聚合 / 是否需要本机文件读取」。逐条：

| 判据 | Gemini 的情况 | 是否超出声明表 |
|---|---|---|
| **解析复杂度** | 低。`buckets[]` 一层，每项 4 个字段 | ✅ 不超 |
| **是否需要多请求聚合** | **是**。`loadCodeAssist` → 拿 `cloudaicompanionProject` → 才能构造 `retrieveUserQuota` 的 body | ❌ **超** |
| **是否需要本机文件读取** | **是**。读 `~/.gemini/oauth_creds.json`（或 ADC 文件）拿 refresh token | ❌ **超** |
| （额外）**HTTP 动词** | 两个业务端点都是 **POST + JSON body** | ❌ **超** |
| （额外）**token 刷新** | 第三次出网，`application/x-www-form-urlencoded` | ❌ **超** |

### 1.2 为什么 `ProtocolDecl` 装不下（结构层面）

`ProtocolDecl`（`src/main/adapters/protocols.ts:20-38`）的 `read` 是 **`(body: unknown) => ProviderWindow[] | null` 的同步纯函数**。而 Gemini 的解析天然是两阶段的：

```
读文件 → 拿 refresh_token → 刷 access_token（可能不需要刷）
      → POST loadCodeAssist → 从响应里取 cloudaicompanionProject
      → POST retrieveUserQuota（body 里要用上一步的 project）
      → 从响应里取 buckets → 组装窗口
```

`read(body)` 拿不到「上一步的响应」，而 `createProtocolAdapter`（`protocol-adapter.ts:54-94`）只发**一次** GET。所以哪怕硬塞进去也做不到。

文件头注释已经把这类情况列为「声明表达不了」：`protocols.ts:13-15`
> 声明表达不了的协议（请求签名、浏览器会话、**本机文件**、备用端点）仍走代码适配器

`index.ts:16-22` 同样列了「浏览器会话 / 本机文件」这一类。

### 1.3 决定性理由：会打红共享黄金样本

若走声明表，就必须把它加进 `SELECTABLE_PROTOCOLS`（`protocols.ts:277-293`），它会成为设置页「添加自定义提供方」里的一条模板。但：

- `scripts/test-adapters.mjs:860` 有 `T12 自定义协议目录 9 条（8 声明 + MiniMax）`，加一条就红。
- **产品语义也不对**：Gemini Code Assist 实例不是「用户自己填 Base URL 的中转」，它是一个**读本机文件的 singleton**。放进「自定义协议」列表是错的交互。

而 `test-adapters.mjs` 是多人共改的共享文件（任务明确要求只能追加自己的段），**不能去改 T12 的期望值**。走代码适配器就完全绕开这个冲突。

### 1.4 落点清单

```
新增  src/main/adapters/gemini.ts                      # 适配器实现
改    src/main/adapters/index.ts                      # CODE_ADAPTERS 加一条 + import
新增  src/main/providers.ts  BUILTIN_PRESETS          # 加一条 preset（⚠ 见下方冲突提示）
改    src/renderer/src/provider-icons.ts              # ⚠ 生成物，跑脚本而不是手改
跑    node scripts/gen-provider-icons.mjs
追加  scripts/test-adapters.mjs                       # 新增 V 段
```

**⚠ 冲突提示**：`providers.ts` 的 `BUILTIN_PRESETS` 虽不在「四家共用 protocols.ts」的范围内，但新增条目会改变 `listCatalog()` 的输出，进而可能影响 `test-adapters.mjs` T 段的目录断言（如 T11/T11b）。实现时先跑一遍 `node scripts/test-adapters.mjs` 确认基线，再加 preset，再跑一遍看有没有新的红。

---

## 2. Q5：`kind` 与 `mark`

### 2.1 `kind: 'coding'`

**推荐 `'coding'`。**

既有判定：

| 适配器 | kind | 依据 |
|---|---|---|
| claude.ts:181 | `coding` | 订阅制，推算限额窗口 + 重置时间 |
| codex.ts:189 | `coding` | 订阅制，服务端 rate_limits |
| copilot.ts:89 | `coding` | 订阅制，`quota_snapshots` 逐项限额 |
| minimax.ts:37 | `token` | 按 token 计费的套餐 |

Gemini Code Assist 三个参照项全中：订阅制、逐项限额、有重置时间。
- 不是 `balance` —— 没有金额。`isPlan`（`quality.ts:27`）判 `kind !== 'balance'`，所以 `coding` 会被渲染成「套餐」并画用量环。
- 不是 `token` —— `token` 在这个仓库里的语义是「按 token 计费的套餐」（minimax 的 `Token Plan`，`unit: 'request'`）。Gemini 的桶虽然有 `tokenType` 字段，但主桶是 `REQUESTS`，且这是**限额次数**而非「花了多少 token」。

### 2.2 `mark: 'gemini'`

**推荐 preset id 与 protocol id 都用 `gemini`（同一个字符串）。**

理由：
- `mark` 决定 logo：`providerMark(id)` 只查 `PROVIDER_MARKS[id]`，查不到就**静默回退 generic 插头图标**（`provider-icons.ts:114-116`）。
- `mark` 的取值是 `inst.presetId || inst.protocol`（`bind-instance.ts:27`、`protocol-adapter.ts:48`）。若 preset=`gemini` 而 protocol=`gemini-code-assist`，**自定义实例会拿不到 logo**。既有反例：preset `claude` / protocol `claude-code`，而 `PROVIDER_MARKS` 只有 `"claude"` 键 —— 自定义 claude 实例今天就是 generic 图标。
- 协议 id 用 `gemini` 也符合 `providers.ts` 里 balance 类协议的命名惯例（preset id == protocol id：deepseek/deepseek、kimi/moonshot 是少数例外）。

**图标**：`PROVIDER_MARKS` 需要新增 `"gemini"` 键。`simple-icons:gemini` 存在（Google Gemini 品牌图标）。但 `provider-icons.ts:1-2` 写明 **由 `scripts/gen-provider-icons.mjs` 生成，勿手工编辑** —— 必须跑脚本。实现时确认脚本的 id 清单在哪个文件里维护。

### 2.3 `BUILTIN_PRESETS` 建议条目

参照 claude/codex/copilot 三条（`providers.ts:67-93`）的形状：

```ts
{
  id: 'gemini',
  name: 'Gemini Code Assist',
  kind: 'coding',
  protocol: 'gemini',
  defaultBaseUrl: 'https://cloudcode-pa.googleapis.com',
  localCredential: true,
  singleton: true
}
```

- `localCredential: true` —— 凭据来自本机 Gemini CLI 文件，用户无需手填
- `singleton: true` —— 本机文件型数据源，重复无意义（同 claude/codex/copilot）
- `defaultBaseUrl` 给 `https://cloudcode-pa.googleapis.com`（虽然实际 URL 是 base + `/v1internal:<method>`，但 `bind-instance.ts:49-56` 已经处理 `baseUrl:<baseId>` 覆盖，且显示上有意义）
- ⚠️ `keyHint`：现有本机文件型三条都**没有** `keyHint`。保持一致，不加。

---

## 3. Q3：凭证格式与 keystore

### 3.1 结论先行：**我们不需要往 keystore 里写 Gemini 凭据**

理由链条：
1. `client_id` / `client_secret` **本来就在** `~/.gemini/oauth_creds.json` 里（google-auth-library 写回的 `Credentials` 含这两个字段）。
2. 我们只需要「读文件 + 拿 refresh_token + 刷 token」。
3. 这与 `copilot.ts:49-70` 的 `readCopilotToken()` 完全同构：**只读本机工具的凭据文件，从不回写**。
4. 若我们把 refresh token 复制进自己的 `secrets.bin`，等于**把用户 Gemini CLI 的长效凭据搬进第二个存储** —— 扩大暴露面，且用户 `gemini logout` 后我们那份会变成孤儿凭据。

**推荐：适配器只读，不写。** 因此 `keystore` 的 `items` 结构**不需要为 Gemini 改动**。

### 3.2 如果仍要支持「没有 Gemini CLI 的用户」

有些用户（尤其 Code Assist Standard/Enterprise，走 gcloud ADC 的）可能没有 `~/.gemini/oauth_creds.json`。这时允许他们在设置里**手填 refresh token**。那种情况下：

- **落 `items`（加密），绝不落 `extras`（明文）**。`store.ts:12-13` 写明 `items` = base64 密文、`extras` = **明文**。refresh token 是长效凭据，落 extras 等于裸奔。
- `items` 是 `Record<string, string>`（`store.ts:26`）—— **一个 id 一个字符串，能装多段值**。既有两种打包惯例：
  - 冒号分隔：`keyHint: 'AccessKeyId:AccessKeySecret'`（`providers.ts:140,148`，qwen / volc）
  - JSON：`bind-instance.ts:42-45` 把实例 key 包成 `JSON.stringify([own])`
- **推荐 JSON blob**：`JSON.stringify({ refresh_token, client_id, client_secret })`，存进 `items[<instanceId>]`。
  - 理由：refresh_token 本身可能含 `:` 以外的结构化内容；且未来若要加 `project_id` 不用改格式。
  - JSON-in-key 已有先例（opencode）。
- ⚠️ **不要**把 `client_id`/`client_secret` 作为用户输入项暴露在 UI —— 它们是公开值，从文件读或用内置常量即可（见 01 §1.3 的「不是密钥」说明）。UI 只需要一个 refresh token 输入框。

### 3.3 渲染层红线（`tts:getSecret` 教训）

`src/main/ipc.ts:283-292` 记录得很清楚：

> 读 token 的 `tts:getSecret` **已随本次任务下线**（2026-09-29 `09-29-tts-request-to-main`）。
> ⚠️ 别以「只是少一次 IPC 往返」为由把它加回来：明文一旦跨进渲染层，FR6「token 全程留在主进程」就没有结构上的保证，只剩「现在这版没读」。
> 门禁：test-structure.mjs E5（preload 无 getTtsSecret）+ F6（渲染层无明文通道）。

**落到 Gemini**：
- ❌ 不要新增任何返回 token / refresh_token 的 IPC。
- ✅ 设置页若要显示「已配置 / 未配置」，加一个**只回布尔**的 handler（与 `tts:hasSecret` 同套路，见 `ipc.ts:294`）。
- ✅ 若 UI 想显示账号信息（email / tier / projectId），可以让 `snapshot.detail` 承载**非敏感**文本（这三样都不是凭据）。这正是 `copilot.ts:159` 的做法（`detail: cred.user ? \`账号 ${cred.user}\` : undefined`）。
- ⚠️ `test-structure.mjs` 有 E5/F6 门禁，任何新 IPC 都要过那道静态检查。

### 3.4 凭据发现顺序（建议实现）

```
1. extras['geminiRefreshToken:<instanceId>]   ← 不建议：extras 是明文
   （故此项默认不做；若做，refresh token 放 items）
1'. items[<instanceId>]                        ← 用户手填的 JSON blob（可选路径）
2. $GEMINI_CLI_HOME/oauth_creds.json            ← Gemini CLI 凭据（主路径）
3. ~/.gemini/oauth_creds.json                   ← 同上（GEMINI_CLI_HOME 未设时）
4. $GOOGLE_APPLICATION_CREDENTIALS             ← gcloud ADC / service account
5. ~/.config/gcloud/application_default_credentials.json
```

**环境变量**：`GEMINI_CLI_HOME` 必须支持（`paths.ts` `homedir()` 认它），与 `CLAUDE_CONFIG_DIR`（`claude.ts:71`）、`CODEX_HOME`（`codex.ts:42`）同一惯例。

---

## 4. Q4：降级路径

### 4.1 仓库既有纪律（先对齐）

- **错误 / 未配置快照的 `dataQuality` 必须是 `undefined`**（`engine.ts:73-84`，ADR-0002）。不允许「省略即 official」。
- **`degradedReason` 适配器不写**。它由 `applyCachePolicy` 写（`quality.ts:56-57`），读方是 `tray.ts:197` / `CardView.tsx:30` / `DetailView.tsx:167`。10 个适配器里只有 `opencode.ts:822` 在本机降级时自己写过。
- **`applyCachePolicy` 的降级判定**（`quality.ts:44-46`）：
  ```ts
  const degraded = next.status === 'error'
                || next.dataQuality === 'local'
                || (next.status === 'ok' && next.windows.length === 0)
  ```
  → 也就是说 **`status==='ok'` 且 `windows` 为空也算降级**，会回落缓存。

### 4.2 推荐的分支表

| 场景 | 判定 | status | dataQuality | 文案（detail / failureReason） | 用哪个铸造器 |
|---|---|---|---|---|---|
| **没装/没登录** | 五个凭据路径全未命中 | `nodata` | `undefined` | 未找到 Gemini 凭据（先运行 `gemini` 登录，或在设置中填 refresh token） | `noDataSnap`（同 copilot.ts:96-101） |
| **凭据失效（401/403）** | 任一业务端点 401/403 | `error` | `undefined` | 凭据失效（HTTP 4xx）：请重新运行 `gemini` 登录 | `errSnap`（同 copilot.ts:114-120） |
| **refresh token 被吊销** | token 端点 **400** + body 含 `invalid_grant` | `error` | `undefined` | 凭据已失效：refresh token 被吊销，请重新登录 | `errSnap`（见 01 P4） |
| **档位已退役** | `currentTier.id === 'free-tier'`，或 `ineligibleTiers` 含 free-tier | `error` | `undefined` | Google 已于 2026-06-18 关停免费/Pro/Ultra 档；本账号无可查额度（Code Assist Standard/Enterprise 可用） | `errSnap` |
| **VPC-SC 拦截** | 403 且 `error.details[].reason === 'SECURITY_POLICY_VIOLATED'` | `error` | `undefined` | 被 VPC 服务边界拦截（SECURITY_POLICY_VIOLATED） | `errSnap`（**不要**照抄 gemini-cli 假装 standard-tier，见 01 P5） |
| **Cloud Shell 默认项目被拒** | 403 且 `cloudaicompanionProject === 'cloudshell-gca'` | `error` | `undefined` | 请设置自己的项目：`gcloud config set project <PROJECT_ID>` | `errSnap`（见 01 P6） |
| **配额归属项目缺失** | `loadCodeAssist` 200 但 `cloudaicompanionProject` 为空 | `error` | `undefined` | 服务端未返回配额归属项目（该账号未绑定 Code Assist 许可） | `errSnap`（见 01 P2） |
| **响应格式未识别** | 200 但 `buckets`/`quota` 缺失或非数组 | `error` | `undefined` | 响应格式未识别：<160 字符预览> | `errSnap`（同 copilot.ts:125-127 / protocol-adapter.ts:84-85） |
| **其它非 200** | status ∉ {200, 401, 403} | `error` | `undefined` | `HTTP <status>` | `errSnap`（同 copilot.ts:121） |
| **网络不可达 / 超时** | `ctx.request` 抛错 | `error` | `undefined` | `请求失败: <message>` | 抛出去由 `collectAll` 兜（collect.ts:29-33），**或**自己 try/catch 成 errSnap（copilot.ts:163-165 两种都存在） | 
| **成功** | 200 + 至少一个可识别 bucket | `ok` | **`official`** | `source: '官方接口'` | `officialSnap` |

### 4.3 为什么 `dataQuality: 'official'`

与 `codex.ts:239` / `copilot.ts:153` 同理：`retrieveUserQuota` 是 **Google 自己的后端返回的每账号权威读数**，与 Cloud Console 口径一致。这满足 `quality.ts:50` 的 `official — 官方/权威源实时数据`。

⚠️ **但要照 01 §3.5 收着措辞**：它是「配额池读数」，不是「还能发多少请求」。`detail` 不要写「剩余 N 次请求」，写「官方配额读数」之类。

### 4.4 为什么「档位退役」用 `errSnap` 而不是 `ok` + 空窗口

- `ok` + 空 `windows` 在 `applyCachePolicy` 眼里也是 degraded，**展示效果与 `errSnap` 几乎一样**（都会回落缓存 + 给 degradedReason）。
- 但 `errSnap` 会额外填 `failureReason`（`engine.ts:82`），而 `applyCachePolicy` 的 `degradedReason` 取值顺序是 `next.failureReason ?? next.degradedReason ?? next.detail`（`quality.ts:57`）—— **`errSnap` 的文案能直接透出到托盘**（`tray.ts:197` `s.degradedReason ?? s.detail`）。
- 这是**终态**（数据源永久消失），不是临时故障，用 `error` 语义更诚实。

### 4.5 降级到本机估算？

**不推荐做。** 理由：Gemini CLI 没有像 `~/.claude/projects/*.jsonl` 那样的本地用量转录，也没有可推算的社区限额预设（限额随 tier 变，且 2026 年改过多次）。硬造一个 `local` 快照只会给出无意义的数字。

若未来要加 Antigravity 的本地 language-server 路径，那是**另一个数据源**，仍然 `official`（Google 后端），不是 `local`。

---

## 5. 建议的 `collect()` 骨架（仅结构，不是代码）

```
collect(ctx):
  creds = readGeminiCreds()            // 5 路径，ENOENT 安全
  if !creds            → noDataSnap
  token = validToken(creds) ?? refresh(creds)     // 失败 → errSnap(含 invalid_grant 特判)
  la = POST loadCodeAssist(metadata)   // → 档位 + cloudaicompanionProject
      403 + SECURITY_POLICY_VIOLATED   → errSnap
      403 + cloudshell-gca            → errSnap
  tier = la.currentTier ?? la.paidTier
  if tier is free-tier / ineligible   → errSnap（退役文案）
  project = la.cloudaicompanionProject
  if !project                         → errSnap
  q = POST retrieveUserQuota({ project })
      401/403                         → errSnap
      != 200                          → errSnap(HTTP n)
  buckets = q.buckets ?? q.quota
  if !Array.isArray(buckets)          → errSnap(格式未识别 + 预览)
  windows = buckets.filter(tokenType==='REQUESTS')
             .map(b => ({ name: b.modelId, used: (1-b.remainingFraction)*100,
                          percent: (1-b.remainingFraction)*100,
                          unit: 'percent', resetAt: b.resetTime, note: '官方配额接口' }))
  if windows.length === 0             → errSnap（无可用 REQUESTS 桶，见 01 §3.5 #14883）
  return officialSnap({ windows, plan: tierLabel(tier), source: '官方接口', detail })
```

**`unit` 的选择**：`ProviderWindow` 的 `percent` 单位约定是「percent 单位时 used=百分比值」（`types.ts:16-18`）。Gemini 只给 `remainingFraction` 没有绝对量，所以 **`unit: 'percent'` + `used = 已用百分比` + 同时给 `percent`** 是最贴合的（UI 会优先用 `percent` 画环，`types.ts:26-29`）。

⚠️ **不要**硬造 `limit`：官方不返回绝对请求数上限（`remainingAmount` 只在部分时刻给，且 100% 时省略）。`claude.ts` 那种「社区预设限额 + `extras limits:claude` 覆盖」的做法在这里**没有可靠默认值**，不建议引入。

---

## 6. 需要用户确认的问题

| # | 问题 | 为什么必须问 | 我的倾向 |
|---|---|---|---|
| **Q-a** | 是否接受**只支持 Code Assist Standard/Enterprise**（免费/Pro/Ultra 已于 2026-06-18 关停）？ | 若产品预期是「个人免费用户也能看到额度」，那这个适配器的目标用户群几乎为空，任务优先级需要重估 | 按 Enterprise/Standard 做；免费档给明确退役文案 |
| **Q-b** | `CollectRequest` 加 `body?: string`（配套改 `request.ts:21` 与测试桩）—— **批准吗？** | 这是**共享接缝**改动。`types.ts:11-16` 与 `request.ts:21` 都没有 body，不加就无法发 POST。加了会影响所有适配器（虽然 body 可选、不改现有调用点） | 建议批准，body 可选、测试桩仍按 URL 匹配 → 其它段 fixture 零影响 |
| **Q-c** | 若不批准 Q-b：接受「请求体不被测试覆盖」吗？ | 那样只能断言 URL 序列，**断言不了 `project` 字段传对** —— 而这正是 01 P2 的关键坑 | 不理想但可行 |
| **Q-d** | 要不要支持**用户手填 refresh token**（写 `items`）？还是**只支持读本机文件**？ | 前者需要新 UI + `keyHint` + IPC 布尔通道；后者零 UI 改动 | 建议**先只做本机文件**（与 claude/codex/copilot 三家一致），手填留 v2 |
| **Q-e** | 要不要在 `SELECTABLE_PROTOCOLS` 里**隐藏**（即完全不做自定义实例）？ | 若 preset id == protocol id == `gemini`，用户理论上仍能从目录加一个「自定义 Gemini」—— 这没有意义 | 建议不特殊处理：代码适配器本来就能被 `bindInstance` 绑到自定义实例，行为与 claude/codex 相同（自定义实例 mark 也是 `gemini`，logo 正常） |
| **Q-f** | `providers.ts` 的 `BUILTIN_PRESETS` 归谁改？ | 它不在「四家共用 protocols.ts」的声明范围，但改动会影响 T 段目录断言 | 需确认是否已有别人在改同一文件 |

---

## 7. Caveats / 未验证

- `PROVIDER_MARKS` 的 id 维护在 `scripts/gen-provider-icons.mjs` 里，**我没读那个脚本** —— 加 `gemini` 键的具体做法需实现时确认。
- `test-structure.mjs` 的 E5/F6 门禁我只从 `ipc.ts:283-292` 的注释里读到描述，**没读门禁实现** —— 新增 IPC 前应先读它。
- `provider-icons.ts` 里**没有 `minimax` 之外的 token 类 id**，也**没有** `gemini`；`claude-code`/`opencode-go` 这类 protocol id 同样不在表里 —— 印证了「preset id == protocol id」对 logo 有实质影响。
- 未在真实账号上验证过任何一个响应样本；所有 fixture 都将基于 01 §1.2 的官方类型定义 + 一条真实 issue 样本构造。
