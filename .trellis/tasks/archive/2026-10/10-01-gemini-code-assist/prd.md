# Gemini Code Assist 适配器

## Goal

新增 **Google Gemini Code Assist** 供应商：用 Gemini CLI 官方客户端自己调用的
`cloudcode-pa.googleapis.com/v1internal:*` 端点取**逐模型官方配额读数**，凭据只读本机
Gemini CLI 的 OAuth 文件，**不新增任何回传 token 的 IPC**。

调研原文与逐字证据：`.trellis/tasks/10-01-gemini-code-assist/research/`
（`00-README.md` 索引 / `01-protocol-research.md` 协议 / `02-adapter-design.md` 设计 /
`03-testing-and-pitfalls.md` 测试）

## Background

### 端点（Google 未公开文档，但由 Gemini CLI 官方使用）

```
POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist
     body { metadata: { ideType, platform, pluginType: 'GEMINI' } }
     → { currentTier, paidTier, allowedTiers, ineligibleTiers, cloudaicompanionProject }

POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
     body { project: <上一步的 cloudaicompanionProject> }     ← 决定成败的字段
     → { buckets: [{ modelId, tokenType, remainingFraction: 0–1, resetTime }] }

POST https://oauth2.googleapis.com/token          ← 仅在 access_token 过期时
     Content-Type: application/x-www-form-urlencoded   ← 注意：form，不是 JSON
```

已**否决**四条替代路线（都有硬伤，见 `01-protocol-research.md` §2.1）：
Cloud Console 抓取（SPA + cookie）、Cloud Quotas API（**粒度是 project 级，拿不到 per-user**）、
Cloud Monitoring（组织级聚合）、`~/.gemini/usage-limits.json`（**是第三方工具的派生缓存**）。

### ⚠️ 目标用户池已被调研收窄（用户已确认仍按企业档做）

Google 官方 deprecation 页：**2026-06-18 起** Code Assist 面向
individuals / Google AI Pro / Ultra **全部关停**，「Login with Google」选项也已移除。
**活着的只有 Workspace Code Assist Standard / Enterprise 许可 + Gemini API key。**

→ 适配器只做 Standard / Enterprise；免费档给**明确的退役文案**（不是含糊的「无数据」）。

### 前置已交付：采集接缝（`10-01-seam-post-body`，commit `168c6bc`）

调研时最大的结构性阻塞是「夹具送不出 POST body」。**已解决**：
`CollectRequest` 有了 `method?: 'GET'|'POST'` 与 `body?: string`，
测试桩有了 `callProjectRich` / `makeRichRequest`（投影 `method` / `contentType` / `body`）。

**Gemini 是 `makeRichRequest` 的第一个消费者** —— 它此前处于「已交付但无人使用」的状态。

## Requirements

### R1 · 落点：独立代码适配器

1. 新增 `src/main/adapters/gemini.ts`，注册进 `CODE_ADAPTERS['gemini']`。
   **不进 `protocols.ts`**（`SELECTABLE_PROTOCOLS` 会打红共享黄金样本 T12，
   且「读本机文件的 singleton」放进「自定义协议」列表是错的交互）。
2. `kind: 'coding'`（订阅制 + 逐项限额 + 重置时间，与 claude/codex/copilot 同）；
   `mark: 'gemini'` 且 **preset id == protocol id == `'gemini'`**
   —— `providerMark` 只按 key 查 `PROVIDER_MARKS`，两者不一致会让自定义实例静默退回 generic 图标。
3. `providers.ts` 的 `BUILTIN_PRESETS` 加一条（形状照 claude/codex/copilot：
   `localCredential: true` + `singleton: true`，**不加** `keyHint`）。
4. `scripts/gen-provider-icons.mjs` 的 `MARKS` 加 `gemini` 键，**跑脚本**生成
   `provider-icons.ts`（该文件是生成物，手改会被覆盖）。

### R2 · 凭据：只读不写

5. 发现顺序：`$GEMINI_CLI_HOME/oauth_creds.json` → `~/.gemini/oauth_creds.json` →
   `$GOOGLE_APPLICATION_CREDENTIALS` → `~/.config/gcloud/application_default_credentials.json`。
   全部未命中 → `noDataSnap`（ENOENT 安全，逐个 try/catch 继续）。
6. **不回写我们的 keystore。** `client_id`/`client_secret` 本来就在那个文件里，
   复制进 `secrets.bin` 等于把用户 Gemini CLI 的长效凭据搬进第二个存储，且
   `gemini logout` 后会变成孤儿凭据。与 `copilot.ts` 的 `readCopilotToken()` 同构。
7. **不新增任何返回 token / refresh_token 的 IPC。** `tts:getSecret` 已于 2026-09-29
   下线，理由是「明文一旦跨进渲染层，FR6 就没有结构上的保证」。
8. **v1 不做「用户手填 refresh token」**（需新 UI + `keyHint` + IPC 布尔通道），留 v2。
   本任务**零 UI 改动**。

### R3 · 采集流程

9. `readGeminiCreds()` → access_token 未过期则直接用；否则刷 token。
   **access_token 仍有效时不发刷新请求**（不新增无谓出网）。
10. `loadCodeAssist` → 取 tier（`paidTier.name` 优先于 `currentTier.name`）与
    `cloudaicompanionProject`。
11. `retrieveUserQuota`，body **恰好**是 `{ project }`。
12. 解析 `buckets`（**兼容回落** `quota` 键——官方类型定义是 `buckets`，
    `quota` 仅见于第三方实现，作宽容回落而非契约）。

### R4 · 窗口模型：只给百分比，**不硬造 limit**

13. `unit: 'percent'`，`used === percent === (1 - remainingFraction) * 100`，
    归一到**一位小数**（同 `copilot.ts:145` 的 `Math.round(rawPct * 10) / 10`）。
14. **只保留 `tokenType === 'REQUESTS'` 的桶**，其它（如 `INPUT_TOKENS`）过滤掉。
15. **绝不硬造 `limit`**：官方不返回可靠的绝对请求数上限
    （`remainingAmount` 只在部分时刻给，且 100% 时省略）。
    不引入 `claude.ts` 那种「社区预设限额」——限额随 tier 变且 2026 年改过多次。
16. `remainingFraction` 缺失的桶**跳过**，不产生 `NaN` percent。
17. `resetTime` 缺失时 `resetAt` **整个字段省略**（不写 `null`）。

### R5 · 降级：9 条分支，全部复用既有铸造器

18. 成功 → `officialSnap`（`dataQuality: 'official'`：这是 Google 自己后端的每账号权威读数）。
    **所有失败 → `errSnap` / `noDataSnap`，`dataQuality` 必须是 `undefined`**（ADR-0002）。
19. 适配器**不写 `degradedReason`**（那是 `applyCachePolicy` 的活）。
20. 免费档退役 → **`errSnap` 而非 `ok` + 空窗口**。理由：`ok` + 空 `windows` 在
    `applyCachePolicy` 眼里也算降级（展示效果几乎一样），但 `errSnap` 会填
    `failureReason`，而托盘读的正是 `failureReason ?? degradedReason ?? detail`
    —— **`errSnap` 的文案能直接透出到托盘**。且这是**终态**（数据源永久消失），`error` 语义更诚实。
21. VPC-SC（`SECURITY_POLICY_VIOLATED`）与 `cloudshell-gca` 两个 403 要**分别给可操作文案**。
    ⚠️ **不照抄 gemini-cli 的「假装 standard-tier」**。

## Constraints

- **共享文件只追加，不改既有行**：`scripts/test-adapters.mjs` 是四家适配器任务的共改文件
  （Gemini `V` / Cursor `W` / Antigravity `X` / OpenAI `Y`）。段字母撞车会让两段互相覆盖，
  且表现为「某段没跑到」而非报错。
- **`src/main/adapters/protocols.ts` 一行都不碰**（`test-adapters.mjs` 断言
  `Object.keys(PROTOCOLS).length === 8`）。
- **接缝不得回退**：`request.ts` 必须继续读 `req.method`；接缝**不做**任何序列化
  （token 刷新是 form-encoded、两个业务端点是 JSON，序列化归调用方）。
- **不新增无谓网络请求**：access_token 有效时不刷新；不重试无意义的失败。
- **凭据字面量红线**（`store.ts:13` / `keystore.ts:6`）：源码、示例、测试**禁止出现可用凭据字面量**。
  fixture 里只能用**明显假的**占位，**不得**写入 Gemini CLI 真实 `client_id`/`client_secret`，
  **不得**造一个形似真的 Google refresh token。
- **许可边界**：参考竞品/上游的**解析思路**并自行重写。可以照抄的是**接口事实**
  （端点 URL、字段名、OAuth 常量、tier 枚举）；不照抄任何函数体。
  建议在文件头加零成本的来源声明。
- **数据诚实**：这是「配额池读数」，不是「还能发多少请求」——
  `detail` 不得写「剩余 N 次请求」。

## Acceptance Criteria

- [ ] AC1 `src/main/adapters/gemini.ts` 存在并注册进 `CODE_ADAPTERS['gemini']`
- [ ] AC2 `kind: 'coding'`、`mark: 'gemini'`、preset id == protocol id == `'gemini'`
- [ ] AC3 `BUILTIN_PRESETS` 加一条 `localCredential: true` + `singleton: true`，**无** `keyHint`
- [ ] AC4 `provider-icons.ts` 由 `gen-provider-icons.mjs` **跑出来**（不是手改），
      `PROVIDER_MARKS['gemini']` 存在
- [ ] AC5 凭据 4 条路径按序尝试，全部未命中 → `noDataSnap` 且 `dataQuality === undefined`
- [ ] AC6 `$GEMINI_CLI_HOME` 被支持（与 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 同一惯例）
- [ ] AC7 **未回写 keystore**、**未新增任何返回 token 的 IPC**；
      `test-structure.mjs` 的 E5/F6 门禁仍绿
- [ ] AC8 请求序列断言成立：`loadCodeAssist` → `retrieveUserQuota`；
      `retrieveUserQuota` 的 body **恰好**是 `{ project: GEMINI_PROJECT }`
- [ ] AC9 `Authorization: Bearer <token>` —— **不带** `token ` 前缀（对比 copilot 的 `token ghu_…`）
- [ ] AC10 token 刷新是 **form-encoded**（`Content-Type: application/x-www-form-urlencoded`），
      且 **access_token 有效时该请求不发出**
- [ ] AC11 单桶 100%（`remainingAmount` **缺失**）→ `percent: 0`，不报错
- [ ] AC12 `remainingFraction: 0.965` → `percent: 3.5`（一位小数）
- [ ] AC13 多桶（pro + flash）→ `windows.length === 2`，`name === modelId`
- [ ] AC14 非 `REQUESTS` 桶被过滤掉
- [ ] AC15 数组键为 `quota`（而非 `buckets`）时**也能解析成功**（宽容回落被冻结）
- [ ] AC16 `remainingFraction` 缺失的桶被跳过，**不产生 `NaN`**
- [ ] AC17 `resetTime` 缺失时 `resetAt` **字段整个不存在**（不是 `null`）
- [ ] AC18 9 条降级分支各有断言：未配置 / 401 / 403 / VPC-SC / `cloudshell-gca` /
      token 400 `invalid_grant` / project 缺失 / 格式未识别 / HTTP 500
- [ ] AC19 免费档退役（`currentTier.id === 'free-tier'` 或 `ineligibleTiers` 含之）
      → `errSnap` + **2026-06-18 退役文案**
- [ ] AC20 `paidTier` 存在时 `plan` 取 `paidTier.name`
- [ ] AC21 成功时 `dataQuality === 'official'`；**每一条**失败路径 `dataQuality === undefined`
- [ ] AC22 适配器**未**写 `degradedReason`
- [ ] AC23 **不硬造 `limit`**：窗口只有 `percent`，无 `limit` 字段
- [ ] AC24 `protocols.ts` **零改动**（`PROTOCOLS.length === 8` 断言仍绿）
- [ ] AC25 `test-adapters.mjs` **V 段**追加在汇总行之前，既有行**一行未改**
- [ ] AC26 `engine.ts` 的 `readJson` 扩为**可选**第 5 参以透传 `method`/`body`；
      既有 **7 个调用点一行未改**
- [ ] AC27 **`npm test` 全绿，且既有 18 套件断言数与改动前完全一致**（纯增量的硬证明）
- [ ] AC28 `npm run typecheck` 通过
- [ ] AC29 **零 UI 改动**（`src/renderer/**` 只允许 `provider-icons.ts` 这个生成物变化）
- [ ] AC30 **反验实测**：把 `gemini.ts` 的 POST 改回 GET → V 段必须报红
- [ ] AC31 **反验实测**：从 `retrieveUserQuota` 的 body 里删掉 `project` → V 段必须报红

## Notes

### 用户 / 前期已定的决策

| 问题 | 结论 | 来源 |
|---|---|---|
| 只支持 Standard/Enterprise（免费档已关停）？ | ✅ **用户已确认仍按企业档做** | 本会话 |
| Q-b 扩接缝加 `body`？ | ✅ **已完成**（`10-01-seam-post-body` / `168c6bc`） | 已交付 |
| Q-d 用户手填 refresh token？ | **v1 不做**，留 v2（本任务零 UI 改动） | 本任务决定 |
| Q-e 自定义实例特殊处理？ | **不特殊处理**，行为与 claude/codex 相同 | 本任务决定 |
| Q-g 夹具怎么注入凭据？ | **用 `process.env.GEMINI_CLI_HOME` 指向临时目录** | 本任务决定 |
| Q-h V 段独立编号？ | **独立 V 段**（N 段是通用绑定行为，30 条专属断言混进去会失焦） | 本任务决定 |

### ⚠️ Q-g 的理由（调研内部有矛盾，此处定论）

调研 §3.3 建议 env 注入、§5 的 Q-g 又推荐「可注入的读文件函数」。**取 env**，因为：
`loadTs` 每次重新求值模块，**无法猴补它的 import** —— 「可注入函数」在当前测试基建里做不到；
而 env 是仓库既有惯例（`CLAUDE_CONFIG_DIR` / `CODEX_HOME`），且**正好把路径解析逻辑也测了**。

### 未验证的点（不要当断言用）

| 点 | 状态 |
|---|---|
| 数组键 `buckets`（官方类型）vs `quota`（第三方） | 官方 = `buckets`；实现**两者兼容** |
| `expiry_date` 单位是毫秒 | google-auth-library 约定（高置信），未在本机文件核对 → 解析要防 NaN |
| 活账号实际返回几个 bucket、有无非 `REQUESTS` 桶 | **完全未验证** |
| `daily-cloudcode-pa.googleapis.com` 提供同端点 | 单一来源未验证 → **只留 env override，不默认用** |
| token 刷新 400 的 body 形状 | 标准行为推断 → 解析时**宽松取 `error` 字段** |
| 真实 `ineligibleTiers[].reasonMessage` 文案 | 未验证 → `detail` **回显 Google 原文，不自己编** |

**若用户能提供一个可用的 Code Assist Standard/Enterprise 账号**，
跑一次 `--uitest` 把真实响应贴回来，可把 AC11–AC17 从「按官方类型定义推的」升级为「实测的」。
