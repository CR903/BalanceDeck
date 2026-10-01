# Research 04 · 凭据格式、cookie 风险与降级路径

- **Query**: cookie/bearer 怎么存？渲染层不得拿到明文。cookie 过期怎么办？降级路径怎么给？
- **Scope**: internal + external
- **检索日期**: 2026-10-01

---

## 1. 存储契约：`items`（加密）vs `extras`（明文）

`src/main/store.ts:11-36`：

```
磁盘格式：{ version: 1, items: { <id>: base64密文 | 'plain:<base64>' }, extras: { <key>: 明文 } }
```

| 命名空间 | 加密 | 用途 | 判据 |
|---|---|---|---|
| `items[<providerId>]` | ✅ `safeStorage`（macOS Keychain / Windows DPAPI），`store.ts:68-79` | **任何**凭据：API key、cookie、token | `setKey(id, plain)` |
| `extras[<key>]` | ❌ 明文 | 偏好：刷新间隔、皮肤、分组、`opencodeWorkspaceId` | `setExtra(key, value)` |

**用错命名空间 = 静默失败**（`ipc.ts:58-61` 原话）：

```ts
// ipc.ts:58-61
 * `setKey`/`getKey` → `items`（safeStorage 加密落盘），
 * `setExtra`/`getExtra` → `extras`（明文，state-management.md:208-217）。
 * 图省事写进 extras 就等于把 token 明文留在磁盘上，且混用两个命名空间是**静默失败**
```

已有护栏（照抄这个模式）：`scripts/test-structure.mjs` E3b / E3d / E7 / F6
—— 「把 setKey 改成 setExtra 即红」。

### 本任务的凭据决策

| 场景 | 存哪 | 理由 |
|---|---|---|
| **主路径：读 `~/.codex/auth.json`** | **不存**（零拷贝） | 那是 Codex CLI 的文件。照 `claude`/`codex`/`copilot` 预设的 `localCredential: true`（`providers.ts:67-93`），`credentialSource` 报 `'file'`，设置页无需填 key |
| 用户手动粘贴 token（想脱离 Codex CLI） | `setKey(<instanceId>, token)` → **`items` 加密** | 绝不能进 `extras` |
| 环境变量兜底 | `process.env.OPENAI_ACCESS_TOKEN` / `CODEX_ACCESS_TOKEN` / `OPENAI_CHATGPT_TOKEN` | 与现有预设的 `envKey` 机制一致 |

### ⚠ 绝对不写回 `~/.codex/auth.json`

CodexBar 明文规定（MIT，检索 2026-10-01）：

> 「CodexBar **never publishes refreshed native tokens into `auth.json`** …
> the OAuth error is surfaced instead of mutating the shared file.」

对齐 `.trellis/spec/guides/external-api-integration.md` Step 6 的精神：
那是 Codex CLI 拥有的文件，我们改它会让 `codex login` 与我们互相覆盖。
→ **token 过期时唯一动作是提示用户跑 `codex login`。**

---

## 2. 渲染层不得拿到明文 —— 已有模板

`tts:getSecret` 是教训（`ipc.ts:283-295`）：

> 「读 token 的 `tts:getSecret` **已随本次任务下线**（2026-09-29）…⚠ 别以「只是少一次
> IPC 往返」为由把它加回来：明文一旦跨进渲染层，FR6 门禁即破。
> 门禁：`test-structure.mjs` E5（preload 无 `getTtsSecret`）+ F6（渲染层无明文通道）。」

**安全的回显形态（已在本仓库存在）** —— `providers.ts:428-461`：

```ts
const supportsCookie = protocol === 'opencode-go'
const cookie = supportsCookie ? await db().getKey('opencodeCookie') : ''
…
cookieHint: supportsCookie && cookie
  ? `已配置·${cookie.slice(-4)}`          // ← 只有尾 4 位
  : supportsCookie ? '待填 Cookie' : undefined
```

即 `ProviderInfo` 侧只有 **布尔 + 尾 4 位**。

**本任务要保持的契约**：

1. 快照 `ProviderSnapshot` 里**永不**出现 token / cookie（连尾 4 位也不要 —— 那是 `ProviderInfo` 的字段，不是快照的）。
2. 若新增 `ProviderInfo` 字段（如 `supportsOpenAiSession`），值只能是布尔或尾 4 位。
3. 用户输入 token 时走 `ProviderPatch.key`（渲染层 → 主进程写入）。这是**写入方向**，
   渲染层拿不到读回通道 —— 与 `providers:update`（`ipc.ts:126-154`）现状一致。
4. 快照 `detail` / `degradedReason` / `failureReason` 里**不得**夹带 token 片段。
   参照 `opencode-cookie.ts:249`：「任何失败都抛 Error（消息不含 cookie）」。

---

## 3. Q3 重答：cookie 结构性风险 —— 主路径可完全避开

### 3.1 本仓库已有的 cookie 自愈先例（供对照）

`opencode.ts:226-254` `resolveCookie()`：

```
cookie 来源优先级：
  ① 授权分区的实时 cookie（唯一可靠来源 —— 服务端每次响应都轮换 session，
    保存的副本必然过期）
  ② 设置中保存的 cookie / 环境变量 / dsh 插件配置（手动粘贴场景的兜底）
```

自愈闭环（`opencode.ts:726-755`）：

1. `fetchUsageViaCookie` 抛错 → `cookieError = e.message`
2. `readLiveCookie(workspaceId)` 从授权分区取实时 cookie
3. 若与保存值不同 → 重试成功则 `cookieError = ''`，
   并 **`await ctx.setKey('opencodeCookie', live)` 静默回写**
4. 自愈后**仍要报未知计费项**，否则「第一次失败恰好因为结构变了」时改版信号会丢失

`CollectContext.setKey` 就是为这个存在的（`types.ts:29-30`：
「回写凭据（仅用于自愈场景，如 cookie 被服务端轮换后静默更新）」）。

⚠ 配套坑：`bind-instance.ts:58-60` 注释指出
「`setKey` 必须透传：cookie 自愈靠它。旧实现漏了这一项，于是自愈代码在任何代码适配器上都不执行。」
→ 若我们用代码适配器 + 实例绑定，**`setKey` 透传已经在 `bind-instance.ts:60` 做好了**，
不需要额外工作；但如果认证状态也存在 `extras` 里，自愈就无路可走。

### 3.2 为什么 `chatgpt.com` 的 cookie 比 `opencode.ai` 的 cookie 风险高得多

| 维度 | opencode（现状可接受） | chatgpt.com（不推荐） |
|---|---|---|
| 凭据范围 | 单站点 `auth` cookie | **整个 ChatGPT 账号的会话 token**（等于账号） |
| 取得方式 | 内嵌 `BrowserWindow` 登录 `opencode.ai/console/login` | 需要用户从**浏览器** cookie 存储里挖（Keychain / Full Disk Access） |
| 浏览器可得性 | 内嵌窗口授权，不碰用户浏览器 | Chrome app-bound 加密让第三方 macOS app **无法**解密；macOS 需 Keychain 授权 |
| 泄露后果 | 单站点配额 | **全账号**（对话历史、邮箱、文件） |
| 服务端行为 | 会话轮换 → 已有自愈 | 会话轮换 + Cloudflare 风控 |

CodexBar 的做法印证了这判断：它读 `chatgpt.com` cookie 需要
**Full Disk Access + macOS Keychain 访问**，且**默认关闭**，
README 里专门有一节解释 macOS 权限为何必要。

> 来源：https://raw.githubusercontent.com/steipete/CodexBar/main/docs/codex.md
> （检索 2026-10-01）

### 3.3 现有 opencode cookie 流程怎么向用户解释（文案模板）

`src/renderer/src/SettingsView.tsx:244-250`：

> 「官方 API 只返回整数百分比（如 4%）。登录 OpenCode 控制台后能拿到
> **服务端下发的限额**与**精确已用量**（如 $5.0588 / 一位小数 16.9%），不用再从百分比反算。
> **不配置也能用**，但会退回本机 opencode.db 估算 ——
> 那是**另一种口径**（本机记录、只覆盖这台机器），不只是精度变粗。」

三个可迁移的要素：

1. 折叠区标题「**高级设置 · 控制台精度增强**」，默认关闭，带「可选」标签（`SettingsView.tsx:239-240`）
2. 明确「**不配置也能用**」
3. 明确降级后是「**另一种口径**」，而不是「精度变粗」
4. 输入框 `type="password"`，只回显尾 4 位（`SettingsView.tsx:274-282`）

### 3.4 Q3 最终结论

> **主路径（`wham/usage` + Codex OAuth token）不需要 cookie，因此 Q3 的结构性风险不成立。**
> 建议 v1 **不做 cookie 路径**。
>
> 若将来确实需要（如 credits 历史 / code review remaining），
> 按 `opencode-auth.ts` 的完整模板落地：
> 独立持久分区 `persist:openai-auth` → 轮询 cookie → 抓完 `clearStorageData()` →
> 唯一持久副本是 safeStorage（`opencode-auth.ts:22-25`），
> 并复用 `ctx.setKey` 自愈。

---

## 4. Q5 降级路径矩阵（`status` + `degradedReason` + `dataQuality`）

### 4.1 可用的状态词汇

| 字段 | 取值 | 定义 |
|---|---|---|
| `status` | `ok` / `nodata` / `error` / `skipped` | `src/shared/types.ts:46` |
| `dataQuality` | `official` / `local` / `cached` / `undefined` | `src/shared/types.ts:54` |
| `degradedReason` | string | 「降级原因（离线 / 超时 / 鉴权失败…）」 |
| `failureReason` | string | 「本轮失败的具体原因（缓存展示时用）」 |

**铸造纪律**（`engine.ts:11-19`）：
- ok 路径必须**显式**声明 `dataQuality`（用 `officialSnap` / `localSnap`）
- 错误 / 未配置快照**显式传 undefined**，不允许默认成 `official`

`applyCachePolicy`（`src/shared/quality.ts:37-59`）会在下一轮降级时
把上一轮 official 数据以 `dataQuality: 'cached'` 展示（≤24h，`MAX_CACHE_AGE`）。

### 4.2 逐情况矩阵（推荐实现口径）

| 情况 | 判据 | `status` | `dataQuality` | `detail` / `degradedReason` 建议文案 |
|---|---|---|---|---|
| 未装 Codex CLI / 未登录 | `~/.codex/auth.json` 不存在或无 `tokens.access_token` | `nodata` | `undefined` | 「未找到 ~/.codex/auth.json（未安装 Codex CLI 或未登录）；可安装 Codex CLI 后运行 `codex login`，或在设置中手动填入 access token」 |
| token 过期 / 401 | HTTP 401 | `error` | `undefined` | 「ChatGPT 会话已过期（HTTP 401）：请运行 `codex login` 重新登录，或在设置中更新 access token」 |
| 403 | HTTP 403 | `error` | `undefined` | 「会话有效但无权访问该账号（HTTP 403）」—— 参考 `consoleAuthMessage` 的 401/403 分档（`opencode-console-api.ts:153-158`） |
| 429 限流 | HTTP 429 | `error` | `undefined` | 「请求过于频繁（HTTP 429），请稍后重试」——**不要自动重试** |
| 端点下线 / 改版 | 404 / 410 | `error` | `undefined` | 「ChatGPT 额度接口已不可用（HTTP 404），该端点为未公开接口，可能已变更」 |
| 返回非 JSON | `JSON.parse` 失败（Cloudflare 拦截页） | `error` | `undefined` | 「响应不是 JSON（可能被 Cloudflare 拦截或端点已变更）」—— 对齐 `opencode-cookie.ts:286-290` |
| 结构变了 | 认不出任何窗口，但有未知字段 | `error` | `undefined` | 「ChatGPT 额度接口结构已变（出现未知字段：xxx, yyy）」—— 对齐 `unknownMeters` 模式（`opencode-cookie.ts:106-111, 296-300`） |
| **只有** `primary_window` | `secondary_window: null` | `ok` | `official` | 只产出 5 小时窗口 + `note: '仅一个限额窗口'`。**不要**造第二个窗口 |
| 网络不可达 | `isNetworkError(e)`（`quality.ts:83-93`） | `error` → 被 `applyCachePolicy` 转 `cached` | `undefined` → `cached` | 沿用现有机制，不额外处理 |
| 部分字段缺失但主窗口在 | `used_percent` 缺失 | `ok` | `official` | 参照 `opencode-cookie.ts:167-176`：**不产出 `percent: 0`**，让 `renderedPct` 落到 `null`，UI 显示「百分比不可用」 |

### 4.3 「百分比不可用」为什么不能报 0%

`opencode-cookie.ts:167-171` 的原话（本仓库已付费学到的）：

> 「算不出百分比时**不能报 0%**。那会让界面显示「已用 $5.06 / 配额 $30 · 0%」——
> 花了钱却显示 0%，是撒谎。」

`wham/usage` 只给 `used_percent` 不给绝对量，所以这条路径是：
`used: 0, unit: 'token', percent: <used_percent>, resetAt: <reset_at>`，
与 `codex.ts:155-182` `buildServerWindows` 完全同形（有既有先例）。

---

## 相关文件

| 路径 | 行 | 作用 |
|---|---|---|
| `src/main/store.ts` | 68-79 | `setKey` → `items` 加密 |
| `src/main/keystore.ts` | 16-26 | safeStorage 装配 |
| `src/main/ipc.ts` | 58-61, 126-154, 204-230 | 命名空间纪律、cookie 写入、`opencode:auth` |
| `src/main/providers.ts` | 428-461 | `supportsCookie` / `cookieHint` 尾 4 位模板 |
| `src/main/adapters/opencode-auth.ts` | 22-25, 39, 92-116 | 授权分区、验证判据（2026-09-26 换过） |
| `src/main/adapters/opencode.ts` | 226-254, 726-755 | cookie 优先级 + `ctx.setKey` 自愈 |
| `src/main/adapters/bind-instance.ts` | 58-60 | `setKey` 透传（自愈的前提） |
| `src/shared/quality.ts` | 37-59, 83-93 | `applyCachePolicy` / `isNetworkError` |
| `src/main/scheduler.ts` | 29-31, 117-127 | 刷新间隔与快照节流 |
| `src/renderer/src/SettingsView.tsx` | 231-296, 419-428 | cookie UI 文案与一键授权 |
| `scripts/test-structure.mjs` | 356-440, 548-564 | items/extras 与渲染层明文护栏 |

## Caveats

- 未验证 `chatgpt.com/backend-api/` 是否对无 `ChatGPT-Account-Id` 的请求宽容。
- 未验证 access_token 的典型有效期（CodexBar 说会过期，但没给数字）。
- 未确认 Electron 的 `session.fromPartition` 读 `chatgpt.com` cookie 在打包后的 macOS
  应用中是否需要额外 entitlement（若将来做 cookie 路径才需要关心）。