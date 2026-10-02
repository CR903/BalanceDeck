# Implement: Gemini Code Assist 适配器

> ### 📌 基线（2026-10-01 实测，AC27 的对照基准 —— 直接引用，不必重测）
>
> 口径：数每个套件 stdout 里的 `✓` 标记数。**共 20 个套件 / 合计 1806 项。**
>
> | 套件 | 项数 | | 套件 | 项数 |
> |---|---|---|---|---|
> | percent | 21 | | trigger-engine | 146 |
> | ssr | 72 | | alert-orchestration | 240 |
> | quality | 32 | | system-notify | 73 |
> | tray | 98 | | usage-predict | 104 |
> | pet | 43 | | usage-store | 42 |
> | gesture | 58 | | usage-history | 72 |
> | **adapters** | **166** | | cli-export | 107 |
> | structure | 85 | | seam | 46 |
> | read-model | 118 | | resource | 37 |
> | voice | 49 | | **合计** | **1806** |
> | speech-out | 197 | | | |
>
> ⚠ **除 `adapters` 之外的 19 个套件，项数必须与上表逐个一致** —— 只允许 `adapters` 增长
> （V 段是纯追加）。任何一个其它套件变了，说明「纯增量」被破坏，**停下来查**。
>
> ⚠ 20 个套件不是 18 —— `seam`（接缝任务）与 `resource`（资源占用任务）是后加的。
> 旧记录里的「1723 / 18 套件」是这两个任务之前的数，**不要再拿它当基线**。

## Ordered Checklist

### Phase 1: 先扩 `readJson`（design.md D2，Gemini 的硬前置）

- [x] **1.1** `src/main/adapters/engine.ts:96-111` 的 `readJson` 加**可选**第 5 参
      `opts?: { method?: 'GET' | 'POST'; body?: string }`，透传进 `ctx.request({ url, headers, timeoutMs, ...opts })`
  - [x] ⚠ **既有 7 个调用点一行都不改**（`copilot.ts:103` / `minimax.ts:49,62` /
        `opencode.ts:687` / `protocol-adapter.ts:69` / `qwen.ts:90` / `volc.ts:87`）
  - [x] ⚠ **接缝不做序列化**（`JSON.stringify` 在 `engine.ts` 里也不许出现）——
        form-encoded 的 token 刷新与 JSON 的业务端点由调用方各自给 `Content-Type`
- [x] **1.2** 跑 `npm test` + `npm run typecheck` + 18 套件断言数对照
      —— **必须与基线完全一致**。不一致就停下来查，不要往下走

### Phase 2: 写适配器 `src/main/adapters/gemini.ts`（新建）

- [x] **2.1** 文件头来源声明（零成本，且许可边界要求）：

  ```ts
  // 端点常量与响应字段名参考自 google-gemini/gemini-cli（Apache-2.0, Google LLC）
  // 与 rarf/hermes-quota-plugin（MIT）。本文件为独立重写实现，未复制任何函数体。
  ```
- [x] **2.2** 常量与类型：三个端点 URL、metadata 常量
      （`pluginType: 'GEMINI'`）、`LoadCodeAssistResponse` / `BucketInfo` / `RetrieveUserQuotaResponse` 的 TS 形状
- [x] **2.3** 导出 `geminiHome()`（认 `GEMINI_CLI_HOME`）与 `readGeminiCreds()`
  - [x] 4 条路径按序：`$GEMINI_CLI_HOME/oauth_creds.json` → `~/.gemini/oauth_creds.json` →
        `$GOOGLE_APPLICATION_CREDENTIALS` → `~/.config/gcloud/application_default_credentials.json`
  - [x] 逐个 `try/catch` 继续（**ENOENT 安全**），参考 `copilot.ts:62-68` 的写法
  - [x] ⚠ **不回写** keystore、**不 import** `keychain`/`setKey`（design.md D5）
  - [x] ⚠ `expiry_date` 单位是毫秒但**未在本机核对** → 解析防 `NaN`
- [x] **2.4** `accessToken(creds)`：**有效则直接返回，不发刷新请求**（R3 第 9 条）
  - [x] 刷新走 `POST https://oauth2.googleapis.com/token`，
        **`Content-Type: application/x-www-form-urlencoded`**（⚠ 不是 JSON），
        body 是 form 编码的 `grant_type=refresh_token&refresh_token=…&client_id=…&client_secret=…`
  - [x] ⚠ **400** + body 含 `invalid_grant` → `errSnap`「refresh token 被吊销」
        （**不是 401** —— 这是最容易写错的分支）
  - [x] 解析 token 响应时**宽松取 `error` 字段**（body 形状未验证）
- [x] **2.5** `collect(ctx)` 三步 + 9 条降级分支，逐条对应 design.md 的 Error Matrix
  - [x] `Authorization: Bearer <access_token>` —— ⚠ **不带 `token ` 前缀**
        （对比 `copilot.ts:106` 的 `token ${cred.token}`）
  - [x] `retrieveUserQuota` 的 body **恰好**是 `{ project }`
  - [x] `plan` 取 `paidTier.name` **优先于** `currentTier.name`
  - [x] ⚠ VPC-SC（`SECURITY_POLICY_VIOLATED`）与 `cloudshell-gca` **分别**给可操作文案。
        **不照抄 gemini-cli 的「假装 standard-tier」**
- [x] **2.6** 窗口组装（design.md D7）：`unit: 'percent'`、
      `used === percent === (1 - remainingFraction) * 100` 归一到一位小数
      （`Math.round(rawPct * 10) / 10`）
  - [x] 只保留 `tokenType === 'REQUESTS'`
  - [x] ⚠ **不硬造 `limit`**（`remainingFraction` 缺失 → 跳过该桶，不产生 `NaN`）
  - [x] `resetTime` 缺失 → `resetAt` **整个字段省略**（不写 `null`）
  - [x] 数组键 `buckets` **兼容回落** `quota`
- [x] **2.7** 降级纪律：成功 `officialSnap`（`dataQuality: 'official'`）；
      **所有失败 `dataQuality === undefined`**；**不写 `degradedReason`**
- [x] **2.8** 免费档退役 → **`errSnap` + 2026-06-18 文案**（design.md D8），
      `currentTier.id === 'free-tier'` 与 `ineligibleTiers` 含之**两条都判**
- [x] **2.9** `detail` **回显 Google 原文**（`ineligibleTiers[].reasonMessage` 未验证，不自己编），
      且**不写**「剩余 N 次请求」（那是配额池读数，不是还能发多少）

### Phase 3: 注册与图标

- [x] **3.1** `src/main/adapters/index.ts:24-32` 的 `CODE_ADAPTERS` 加 `'gemini': geminiAdapter` + import
- [x] **3.2** `src/main/providers.ts` 的 `BUILTIN_PRESETS` 加一条
      （照 `copilot` 那条 `:86-93` 的形状）：`id: 'gemini'`、`protocol: 'gemini'`、
      `kind: 'coding'`、`localCredential: true`、`singleton: true`、**不加 `keyHint`**
  - [x] ⚠ preset id **必须** == protocol id == `'gemini'`（design.md D3，否则自定义实例没 logo）
  - [x] ⚠ 改完**立刻**跑 `node scripts/test-adapters.mjs` 看 T 段目录断言（T11/T11b）有没有新红
- [x] **3.3** `scripts/gen-provider-icons.mjs:24` 的 `MARKS` 加 `gemini` 键，然后**跑脚本**
      `node scripts/gen-provider-icons.mjs`
  - [x] ⚠ `provider-icons.ts` 的 diff 应**只有新增一个键**。若是整文件重排 → 停，查脚本行为
  - [x] ⚠ **不手改 `provider-icons.ts`**（生成物）

### Phase 4: V 段测试（`scripts/test-adapters.mjs`）

- [x] **4.1** 落笔前再跑一次 `node scripts/test-adapters.mjs` 确认仍是「失败 0 项」
- [x] **4.2** 插入位置：**`:1269`（汇总 `console.log`）之前**，作为最后一段
  - [x] ⚠ **只追加，既有 A~U 段与汇总行一行不改**（四家共改文件，段字母撞车会让两段互相覆盖，
        且表现为「某段没跑到」而非报错）
  - [x] `:801` 的 `PROTOCOLS.length === 8` 与 `:908` 的 T12 **都不许动**
- [x] **4.3** 段首用 `makeRichRequest(routes)`（接缝任务留下的）—— **它是 Gemini 的第一个消费者**
  - [x] ⚠ V 段在开始时 `process.env.GEMINI_CLI_HOME = <mkdtempSync 临时目录>`，
        写一个**明显假的** `oauth_creds.json`；**段末恢复原值**
  - [x] ⚠ 凭据字面量红线（`keystore.ts:6`）：**不得**写 Gemini CLI 真实
        `client_id`/`client_secret`，**不得**造形似真的 refresh token
- [x] **4.4** fixture 常量 + 来源注释：字段名取自官方 `types.ts`（Apache-2.0），
      单桶样本取自 gemini-cli issue #27363（真实返回，100% 时 `remainingAmount` 被省略）；
      `quota` 键的夹具**注明来自第三方、与官方类型定义矛盾、是宽容回落**
- [x] **4.5** 断言清单照 prd.md 的 **AC5–AC23** 逐条写，每条都要真断言
  - [x] ⭐ **AC8**：`retrieveUserQuota` 的 body **恰好**是 `{ project: GEMINI_PROJECT }`
  - [x] ⭐ **AC11**：单桶 100% 且 `remainingAmount` **缺失** → `percent: 0`，不报错
  - [x] ⭐ **AC17**：`resetTime` 缺失 → `resetAt` 字段**整个不存在**（不写进期望对象，
        因为 `stable()` 会过滤 `undefined`）
  - [x] ⭐ **AC19**：免费档两条触发路径都测（`currentTier` 与 `ineligibleTiers`）
  - [x] AC21：**每一条**失败路径都断言 `dataQuality === undefined`（ADR-0002）
- [x] **4.6** 静态守卫（design.md Tests Required 4），**每条都要前置断言**
      （先断言找得到那段源码，否则负向断言会「匹配不到就不成立」而**空洞通过**）：
  - [x] `gemini.ts` 走 `method: 'POST'`（改回 GET 必须红）
  - [x] `retrieveUserQuota` 的 body 含 `project`（删掉必须红）
  - [x] `gemini.ts` 未 import `keychain` / `setKey`（不回写凭据）
  - [x] token 刷新的 `Content-Type` 是 form-urlencoded（不是 JSON）

### Phase 5: 收尾验证

- [x] **5.1** `npm test` → **既有 18 套件断言数与基线完全一致**（AC27，逐套件列对照表）
- [x] **5.2** `npm run typecheck` → clean
- [x] **5.3** `node scripts/test-structure.mjs` → E5/F6 门禁仍绿（未新增回传 token 的 IPC）
- [x] **5.4** **零 UI 改动核对**：`git diff --stat -- src/renderer/` 应**只有** `provider-icons.ts`，
      且其 diff 只是新增 `gemini` 键
- [x] **5.5** `git diff -- src/main/adapters/protocols.ts` → **空**（AC24）
- [x] **5.6** **两个必做反验**，都要实际跑并给实测红集：
  - [x] ① `gemini.ts` 的 POST 改回 GET → V 段必须红
  - [x] ② 从 `retrieveUserQuota` 的 body 删掉 `project` → V 段必须红
  - [x] 跑完恢复，复跑确认全绿
- [x] **5.7** `makeRichRequest` 现在**有消费者了** —— 确认它不再是「已交付但无人使用」的死代码

## Review Gates

- [x] `npm test` 通过，且 **18 套件断言数合计 == 基线**（逐套件对照表写进报告）
- [x] `npm run typecheck` 通过
- [x] `protocols.ts` 零改动；`PROTOCOLS.length === 8` 与 T12 仍绿
- [x] `test-adapters.mjs` 既有行零改动（`git diff` 只应是纯新增块）
- [x] 零 UI 改动（除生成的 `provider-icons.ts`）
- [x] 两个反验的实测红集
- [x] `trellis-check` 对照 prd.md 的 **31 条 AC** 逐条复核

## Rollback

| 改动 | 回滚 |
|---|---|
| `engine.ts` 的 `readJson` 可选第 5 参 | 删掉 `opts`（既有 7 个调用点本就不传，删掉即回到改动前） |
| `gemini.ts` + `CODE_ADAPTERS` 注册 | 删文件 + 删注册行 |
| `BUILTIN_PRESETS` 条目 | 删该条 |
| `gen-provider-icons.mjs` 的 `gemini` 键 | 删该键后**重跑脚本**（不要手改 `provider-icons.ts`） |
| V 段 | 删掉插入的整块（纯追加，删除即复原） |
| 临时目录 env | 段末已恢复；若泄漏就 `delete process.env.GEMINI_CLI_HOME` |

⚠ 回滚 `gen-provider-icons` 时**必须重跑脚本**，手改生成物会与脚本不一致
（下一个人跑脚本时 diff 会突然冒出一个键，很难查）。
