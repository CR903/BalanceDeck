# Google Antigravity 适配器

## Goal

新增 **Google Antigravity** 供应商：用本机 Antigravity 登录态里的 OAuth token，出网打
Google Cloud Code 的 `v1internal:retrieveUserQuotaSummary` 取服务端真值（2 池 × 2 窗口，
纯百分比口径）。凭据只读本机、**不刷新、不回写**。

调研原文与逐字证据：`.trellis/tasks/10-01-google-antigravity/research/`
（`01-what-is-antigravity.md` 背景 / `02-quota-lookup-paths.md` 端点与凭据 /
`03-competitors-and-licenses.md` 竞品与许可 / `04-repo-contract-mapping.md` 契约映射 /
`05-recommendation.md` 推荐方案 / `06-open-questions.md` 待确认问题 / `07-sources.md` 信息源）

## Background

### 端点（无官方文档，逆向来源；两个独立来源互证 + oh-my-pi #9940 真实 JSON）

```
POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
     headers: Authorization: Bearer <google_oauth_access_token>
              Content-Type: application/json
              User-Agent: <可识别自己的字符串，不伪装>
     body: {}  或  {"project": "<cloudaicompanionProject>"}
     → { groups: [{ displayName, buckets: [{ bucketId, displayName, window, resetTime, remainingFraction }] }] }
```

前置：`POST <base>/v1internal:loadCodeAssist` 取 `cloudaicompanionProject` + tier。
Base URL 三候选按序回退：`daily-cloudcode-pa` → `daily-cloudcode-pa.sandbox` → `cloudcode-pa`。

### ⚠️ 两个已知的静默撒谎陷阱

1. **不带 project 的查询会假报 100% 剩余**（usagebar 文档明确警告）。
   project 缺失 ⇒ 不报数字。
2. **`currentTier` 对 Pro 账号也返回 `free-tier`，真实订阅在 `paidTier`**
   （pi-antigravity 源码注释）。plan 取 `paidTier.name` 优先。

### 前置已交付

- 采集接缝（`10-01-seam-post-body` / `168c6bc`）：`method`/`body` 透传，测试桩有
  `callProjectRich` / `makeRichRequest`
- `readJson` 可选第 5 参（Gemini 任务扩的）：`opts?: { method, body }`
- 段字母锁定（父任务）：Gemini `V` · Cursor `W` · **Antigravity `X`** · OpenAI `Y`

## Requirements

### R1 · 落点：独立代码适配器

1. 新增 `src/main/adapters/antigravity.ts`，注册进 `CODE_ADAPTERS['antigravity']`。
   **不进 `protocols.ts`**（N7 断言 `PROTOCOLS.length === 8`；声明表表达不了
   POST + 本机文件 + 多 base URL 回退）。
2. `kind: 'coding'`；`mark` / preset id / protocol id **三同 `'antigravity'`**。
3. `providers.ts` 的 `BUILTIN_PRESETS` 加一条（`localCredential: true` + `singleton: true`，
   无 `keyHint`）。
4. `scripts/gen-provider-icons.mjs` 的 `MARKS` 加 `antigravity` 键后**跑脚本**生成
   `provider-icons.ts`（生成物不手改；`simple-icons:antigravity` 实测 404，
   用 `simple-icons:google`（实测 200）—— Antigravity 是 Google 产品且与
   `googlegemini` 键不冲突）。

### R2 · 凭据：三源级联，只读不写

5. 顺序：macOS Keychain（`security find-generic-password -a antigravity -s gemini -w`，
   剥 `go-keyring-base64:` 前缀；仅 macOS，其他平台静默跳过）→
   旧 token 文件 `~/.gemini/antigravity-cli/antigravity-oauth-token`（只读）→
   `ctx.getKey(inst.id)`（用户手动粘贴，`items` 加密，**优先级最低**）。
6. **Keychain 值不得回写**（那是 Antigravity 自己的登录态）。
   **不实现 token 刷新、不做 `setKey` 回写**——access_token 过期 → `errSnap`
   「请在 Antigravity 中重新登录」。
7. **不新增任何返回 token 的 IPC**（`tts:getSecret` 教训，E5/F6 门禁守着）。
8. email 不进 `detail`（Google 主邮箱，比 copilot 的 GitHub 用户名更敏感；无先例则不做）。

### R3 · 采集：loadCodeAssist 前置 + 三 base URL 回退

9. `loadCodeAssist`（body `{"metadata":{"ideType":"ANTIGRAVITY",...,"pluginType":"GEMINI"}}`）
   → 取 `cloudaicompanionProject` + tier（`paidTier.name` 优先于 `currentTier.name`）。
10. `project` 为空 → `errSnap` 说明原因，**不报数字**（假 100% 陷阱）。
11. `retrieveUserQuotaSummary`，body 带 `{"project": project}`。
12. 三 base URL 按序回退：**仅在请求抛错/超时时**试下一个；HTTP 错误状态（401/403/429）
    不回退（那是凭据/权限问题，换 host 没用，还浪费请求）。

### R4 · 解析：宽容三种 nesting，值域外跳过

13. groups 位置：`body.groups` → `body.response.groups` → `body.summary.groups`。
14. fraction 字段：`remainingFraction` → `remaining_fraction` →
    `remaining.case === 'remainingFraction'` 时取 `.value`。
15. fraction **不在 0..1 ⇒ 跳过该 bucket**（不 clamp 成 0/100 —— 那是撒谎）。
16. `resetTime` 解析失败 ⇒ `resetAt` 省略（不报错）。
17. groups 找不到，或所有 bucket 都无可用 fraction ⇒ 返回 null → `errSnap('响应格式未识别')`。
18. **不做 `fetchAvailableModels` 回退**（只有 5h 口径，且 per-model 合并正是 oh-my-pi#9940
    修掉的 bug：weekly 被吞、5h 被误分类为 Daily）。

### R5 · 窗口：percent-only，组名前缀防重名

19. `{ used: 0, limit: undefined（字段省略）, unit: 'percent',
    percent: Math.round((1 - frac) * 100 * 10) / 10,
    resetAt: resetTime（已是 ISO）, note: bucket.displayName }`。
20. 窗口名 = **`${groupDisplayName} · ${windowLabel}`**
    （`5h`→`5小时`，`weekly`→`本周`，未知 window 原样透传）。
    两组各有 5h + weekly，裸窗口名会重名——这是对调研推荐模型的**有意偏离**，理由见 design.md D7。
21. `plan` 取 `paidTier.name`，拿不到留空。**不多打 `GetPlanInfo`**。
22. 成功 → `officialSnap`，`source: 'Antigravity 接口'`，`dataQuality: 'official'`。
    所有失败 → `errSnap` / `noDataSnap`，`dataQuality === undefined`（ADR-0002）。
    本适配器**永不出现 `local`**；不写 `degradedReason`。

## Constraints

- **共享文件只追加**：`scripts/test-adapters.mjs` 是四家共改文件（V、W 已被占，
  Antigravity 用 `X`）。段字母撞车会让两段互相覆盖，且表现为「某段没跑到」而非报错。
- **`protocols.ts` 一行都不碰**（N7 守着 8 条）。`engine.ts` 也不动（第 5 参已够用）。
- **凭据字面量红线**（`keystore.ts:5-6`）：源码、示例、测试禁止出现可用凭据字面量。
- **许可边界**：`aqua5230/usage` 是 **AGPL-3.0-only——代码禁抄**，协议形状（端点名、
  字段名、三种 nesting）是事实可读；OAuth `client_id`/`client_secret` 字面量**不进仓库**
  （Q2 选 A 的直接后果）。MIT 来源（openusage / CodexBar / usagebar fork）复用思路，
  文件头附来源与许可声明。
- **未文档化声明**：文件头 + 本 prd 明确写「Antigravity 适配器使用未文档化的内部接口，
  Google 可能随时改版失效」。`source` 写 `'Antigravity 接口'` 而非 `'官方接口'`——
  数据是服务端真值（`official` 的含义），但端点不是公开官方 API，不冒充。
- **v1 不做**：IDE SQLite 凭据路径（`state.vscdb`）、本机语言服务器 `GetUserStatus`
  （ps+lsof+自签 TLS+双 CSRF+IDE 必须开着——代价与收益完全不成比例）、
  `fetchAvailableModels` 回退、本机对话库 token 估算、User-Agent 伪装（未验证是否必需，
  先不伪装，401/403 时再考虑，注释写清）。
- **不新增网络请求**：`stripeMembershipType` 不需要（plan 从 paidTier 来）；
  base URL 回退只在抛错时触发。

## Acceptance Criteria

- [ ] AC1 `src/main/adapters/antigravity.ts` 存在并注册进 `CODE_ADAPTERS['antigravity']`
- [ ] AC2 `kind: 'coding'`、mark/preset/protocol 三同 `'antigravity'`
- [ ] AC3 `BUILTIN_PRESETS` 加一条 `localCredential: true` + `singleton: true`，无 `keyHint`
- [ ] AC4 `provider-icons.ts` 由脚本**跑出来**（非手改），`PROVIDER_MARKS['antigravity']` 存在
- [ ] AC5 三源全空 → `noDataSnap` 且 `dataQuality === undefined`，文案点名登录入口
- [ ] AC6 401 → `errSnap` 重登录文案，且**请求序列里没有 oauth2 token 端点**（锁住"不刷新"）
- [ ] AC7 手动粘贴优先级最低：本机文件有值时用文件的
- [ ] AC8 **未调用 `setKey`**；`antigravity.ts` 无 `setKey` import（Keychain 只读 exec 允许，
      守卫必须精确到写操作，不能一刀切 ban `security`）
- [ ] AC9 请求序列断言：`loadCodeAssist` → `retrieveUserQuotaSummary`；
      后者 body 恰好是 `{"project": <project>}`；两 request 都是 POST + Bearer + JSON Content-Type
- [ ] AC10 `plan` 取 `paidTier.name`；`currentTier` 为 `free-tier` 但 `paidTier` 为 Pro 时 plan 是 Pro
- [ ] AC11 `loadCodeAssist` 返回 project 为空 → `errSnap`，不是 ok（假 100% 陷阱）
- [ ] AC12 三种 groups nesting（顶层 / `response.` / `summary.`）解析出**完全同结果**
- [ ] AC13 三种 fraction 写法（驼峰 / 蛇形 / case-value）解析出**完全同结果**
- [ ] AC14 fraction 为 1.5 / -0.1 / 非数字 → 该 bucket 被跳过，不产生窗口
- [ ] AC15 `resetTime` 非法 → 该窗口 `resetAt` 字段省略，不报错
- [ ] AC16 groups 缺失 → `errSnap` + 160 字符预览
- [ ] AC17 所有 bucket 都无可用 fraction → `errSnap`（不是 ok + 空窗口）
- [ ] AC18 percent = (1-frac)*100 一位小数；`used: 0`；**无 `limit` 字段**；`note` = displayName
- [ ] AC19 两组各出 5h + weekly → 4 个窗口**名字互不相同**（组名前缀）
- [ ] AC20 未知 `window` 值（如 `monthly`）→ 原样透传进窗口名，不报错不丢弃
- [ ] AC21 403 三种 reason 各有独立文案：`SUBSCRIPTION_REQUIRED` / `VALIDATION_REQUIRED` / 其他透传
- [ ] AC22 429 → 限流文案；`Retry-After` 有值时进 detail
- [ ] AC23 第一 base URL 抛错 → 自动试第二 host；401 不触发回退（仍是一次请求）
- [ ] AC24 成功 `dataQuality === 'official'` + `source === 'Antigravity 接口'`；
      每条失败路径 `dataQuality === undefined`；`local` 永不出现；未写 `degradedReason`
- [ ] AC25 Keychain 值带 `go-keyring-base64:` 前缀 → 剥前缀后可用
- [ ] AC26 `protocols.ts` **零改动**（N7 仍绿）；`PROTOCOLS.antigravity === undefined`
- [ ] AC27 `test-adapters.mjs` **X 段**追加在 W 段之后、汇总行之前，既有行**一行未改**
- [ ] AC28 **`npm test` 全绿，且除 `adapters` 外 19 套件断言数与基线逐个一致**
- [ ] AC29 `npm run typecheck` 通过；`test-structure.mjs` E5/F6 仍绿
- [ ] AC30 **零 UI 改动**（`src/renderer/**` 只允许 `provider-icons.ts` 生成物变化）
- [ ] AC31 **反验实测**：`method: 'POST'` 改回 GET → X 段必须报红
- [ ] AC32 **反验实测**：从 quota 请求 body 删掉 `project` → X 段必须报红

## Notes

### 用户 / 前期已定的决策

| 问题 | 结论 | 来源 |
|---|---|---|
| 段字母 | **Antigravity 用 `X`**（V、W 已被占） | 父任务 prd.md:79 |
| Q1 扩接缝 | ✅ **已交付**（`168c6bc`），`readJson` 第 5 参已就位 | 已完成 |
| Q2 client_id/secret | **A：v1 不内嵌、不刷新**，过期如实报重登录 | 本任务决定（采纳调研建议） |
| Q3 SQLite 凭据路径 | **A：v1 不做**，Keychain + token 文件 + 手动已覆盖绝大多数 | 本任务决定 |
| Q4 unit | **`'percent'`**（Gemini percent-only 窗口已验证渲染无坑） | 本任务决定 |
| Q5 手动粘贴 | **B：做**，`items` 加密，优先级最低，守住渲染层边界 | 本任务决定 |
| Q6 图标 | **`simple-icons:google`**（`antigravity` 404 无品牌图标；Google 产品，与 `googlegemini` 不冲突） | 本任务决定，已实测 200 |
| Q7 逆向前提 | **接受**；`source` 写 `'Antigravity 接口'`（诚实），`dataQuality` 仍 `'official'`（服务端真值） | 本任务决定 |

### 未验证的点（不要当断言用）

| 点 | 状态 |
|---|---|
| 响应字段形状 | 二手实录（openusage 文档 + oh-my-pi #9940 + quotas crate live fixture 2026-07-14），**本机无 Antigravity 可抓**；fixture 逐字标注来源与检索日期，不得标「实测」 |
| 免费档是否 403 | 二手来源互相矛盾（`SUBSCRIPTION_REQUIRED` vs 可用）→ 三种 reason 分开写就是为此 |
| project 是否可选 | 两条冲突（usagebar 说必须 vs quotas crate 说可选）→ 保守：拿不到 project 就不报数字 |
| `daily-cloudcode-pa` 三 host 回退顺序 | usagebar 文档 + IDE debug 日志；sandbox 是否该第二顺位未经生产验证 |
| Keychain 登录态与 token 文件是否同源 | 多家实现一致认为同源；不同源时 Keychain 优先（顺序即语义） |
| Electron 打包后 `security` 子进程 | Cursor 任务已验证 `node:sqlite` 在 Electron 里可用；`security` execFile 仍需实现时实测一次 |
