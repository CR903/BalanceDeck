# Research: 推荐方案（可执行结论）

- **Date**: 2026-10-01
- **Scope**: mixed

---

## 推荐方案：独立代码适配器 + Cloud Code 出网 + 本机发现凭据

**一句话**：新建 `src/main/adapters/antigravity.ts`，走 `retrieveUserQuotaSummary` 出网，凭据从 macOS Keychain / 旧 token 文件自动发现，注册进 `CODE_ADAPTERS`，`kind='coding'`、`mark='antigravity'`。

### 前置条件（阻塞项，必须先解决）

**现有采集接缝是 GET-only，无法发 POST。**

```ts
// src/main/adapters/types.ts:11-16
export interface CollectRequest {
  url: string
  headers: Record<string, string>
  timeoutMs?: number   // ← 没有 method，没有 body
}
```

```ts
// src/main/request.ts:26
const res = await fetch(req.url, { headers: req.headers, signal: ctrl.signal })
```

Antigravity 的 Cloud Code 端点全是 `POST` + JSON body。
**这是本任务唯一的硬阻塞**，且是接缝的历史缺口第一次被暴露（现有 9 个协议全是 GET，`qwen.ts` / `volc.ts` 甚至把签名拼进 URL 来规避无 body）。

**建议改动（纯增量，既有调用点零改动）**：
```ts
export interface CollectRequest {
  url: string
  headers: Record<string, string>
  timeoutMs?: number
  method?: 'GET' | 'POST'      // 缺省 GET
  body?: string                 // 缺省无 body
}
```
`request.ts` 相应加 `method: req.method ?? 'GET', body: req.body`。
测试桩 `makeRequest` / `callProject` 同步加字段（**只加不改**，见 §测试）。

⚠ 这是**共享文件**（`types.ts` 被全部适配器 import），若其它三家子任务也在改会冲突。**需要父任务协调顺序。**

---

## 明确回答「结构性问题」（父任务问题 4）

> 如果 Antigravity 的额度只能从本机文件读……

**不成立。** 额度在 Google 后端，有出网 API（`retrieveUserQuotaSummary`）。

**准确的表述应该是**：

> Antigravity 是「**凭据来自本机、数据来自出网**」的混合模型。

这**不是新架构**。本仓库已有两个同构先例：
- `copilot.ts`：凭据读 `~/.config/github-copilot/apps.json`（本机文件）→ 出网打 `api.github.com/copilot_internal/v2/user`
- `opencode.ts`：凭据读本机 `auth.json` / `opencode.db` → 出网打 console API

⇒ **不需要新增「本机文件读取路径」这种采集类别**。现有代码适配器机制（`localCredential: true` 的 `BuiltinPreset`）已经表达得了。

**唯一要评估的备选路线是本机语言服务器（`GetUserStatus`）** —— 那才是真正的结构性问题（要 `ps` + `lsof` + 关 TLS 校验 + 随机端口 + 两个 CSRF token，且 IDE 不开就不可用）。**结论：不走这条。** CodexBar 为此写了 13 个测试和两次 TLS 修复 PR（#693 / #727）。

---

## 实施步骤（建议顺序）

### Step 1 — 扩展采集接缝（阻塞）
- `src/main/adapters/types.ts`：`CollectRequest` 加 `method?` / `body?`
- `src/main/request.ts`：透传
- `scripts/test-adapters.mjs`：`makeRequest` 路由 + `callProject` 投影加 `method` / `body`（**只加不改**；`stable()` 会过滤 `undefined`，既有断言不受影响）

### Step 2 — 纯函数解析层（可独立单测，无网络）
新建 `antigravity.ts`，**先只写导出纯函数**：

```ts
/** 纯函数：响应 → 窗口；null = 不可识别。三种 nesting 都要认。 */
export function parseQuotaSummary(body: unknown): ProviderWindow[] | null
```

解析规则：
- 找 groups：`body.groups` → `body.response.groups` → `body.summary.groups`
- 每 group 每 bucket：
  - `remainingFraction` → `remaining_fraction` → `remaining.case === 'remainingFraction' ? remaining.value`
  - **值不在 0..1 ⇒ 跳过该 bucket**（不 clamp 成 0/100 —— 那是撒谎）
  - `resetTime` 解析失败 ⇒ 留 `resetAt: undefined`（不报错）
  - `window` 字段 → 窗口名（`5h` → `5 小时`，`weekly` → `本周`）
  - `displayName` → `note`
- **返回 `null` 的条件**（走 errSnap「响应格式未识别」）：groups 找不到，或所有 bucket 都无可用 fraction
- **未知形状信号**：对认不出的 `bucketId` 前缀记一条日志（`.trellis/spec/adapters/index.md` 层规则 3）

⚠ **不做 `fetchAvailableModels` 回退**：只有 5h 窗口、无 weekly、口径不同（guide Step 4）。

### Step 3 — 凭据发现（按优先级，全部失败即 `nodata`）
1. macOS Keychain：`execFile('security', ['find-generic-password','-a','antigravity','-s','gemini','-w'])`
   - 值可能是 `go-keyring-base64:<base64>` → 剥前缀再 parse
   - 形状 `{ token: { access_token, refresh_token, expiry } }`
2. `~/.gemini/antigravity-cli/antigravity-oauth-token`（旧版纯 JSON，只读不写）
3. 用户手动粘贴（存 `items`，`ctx.getKey('antigravityToken')`）

**跳过** IDE SQLite `state.vscdb` —— 本仓库无 SQLite 依赖，引入需处理 electron-builder 原生模块重编译；且 `antigravityAuthStatus.apiKey` 与 Keychain 通常同源。
⚠ Keychain 值**不得回写**（那是 Antigravity 自己的登录态，写坏等于毁掉用户登录）。参照 `_read_macos_credential` 的注释。

**多来源的标签**（照 `opencode.ts:155` 的 `KeyEntry.label`）：让用户看得见数字来自哪。

### Step 4 — 采集流程
```
① loadCodeAssist（取 cloudaicompanionProject + paidTier）
   ↓ project 空 → 不报数字（errSnap，说明原因）
② retrieveUserQuotaSummary（带 project）
   ↓ 3 个 base URL 按序回退
③ 铸造 officialSnap，source: '官方接口'，plan: paidTier.name
```

### Step 5 — 注册
- `src/main/adapters/index.ts` → `CODE_ADAPTERS['antigravity'] = antigravityAdapter`
- `src/main/providers.ts` → `BUILTIN_PRESETS` 加：
  ```ts
  { id: 'antigravity', name: 'Google Antigravity', kind: 'coding',
    protocol: 'antigravity', defaultBaseUrl: '',
    localCredential: true, singleton: true }
  ```
- `src/renderer/src/provider-icons.ts` → 加 `antigravity` 键（否则 logo 落空）
- `README.md` 支持的供应商表加一行
- **`src/main/adapters/protocols.ts` 不用碰** ✅（满足父任务约束）

### Step 6 — 测试（`scripts/test-adapters.mjs` 追加 `V` 段）
见 `04-repo-contract-mapping.md` §5。

---

## 窗口模型（照抄此处，不要临场发挥）

```ts
// 服务端只报「剩余比例」，没有绝对量
{
  name: '5 小时',          // 或 '本周'
  used: 0,                 // ⚠ 无源，恒 0（codex.ts:158 同款）
  limit: undefined,        // ⚠ 绝不能编（claude.ts 的 35/140/420 是社区估算，Antigravity 连乘数基准都没有）
  unit: 'percent',         // 或 'token' —— 见 Q4
  percent: Math.round((1 - remainingFraction) * 1000) / 10,
  resetAt: bucket.resetTime,   // 已是 ISO，无需换算
  note: bucket.displayName
}
```

`kind = 'coding'` → UI 画用量环、叫「套餐」（`quality.ts:27`）。

---

## 风险

| 风险 | 缓解 |
|---|---|
| **端点是内部 API，无官方文档** | 官方 docs 只公开 CLI `/usage` 与 statusline JSON 形状；`retrieveUserQuotaSummary` 全靠逆向。Google 可随时改 |
| **免费档可能 403** | 二手来源互相矛盾（`SUBSCRIPTION_REQUIRED (#3501)` vs 可用）。**必须写清 403 的三种 reason**，别混成一句「失败」 |
| **project 为空会假报 100%** | usagebar 文档明确警告。**project 缺失 ⇒ 不报数字**（guide Step 4） |
| **fixture 是二手的** | 注释里标来源+日期+「非本仓库实测」。实现完必须找有 Antigravity 的用户真机验证 |
| **`types.ts` 是共享文件** | 父任务协调 —— 与其它三家子任务并发改会冲突 |
| **接缝扩展影响面** | 纯增量，但 `request.ts` 是生产出网实现，R 段（`test-adapters.mjs:1017`）测的是它，要回归 |
| **Keychain 读取在 Electron 打包后** | `security` 子进程在沙箱/公证后的行为需实测 |