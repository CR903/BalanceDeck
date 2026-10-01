# Research: 协议契约 — kind / mark / 凭证 / 降级路径

- **Query**: kind 与 mark 取什么？凭证放 items 还是 extras？降级路径怎么给 status/degradedReason/dataQuality？走协议表还是独立适配器？测试落点？
- **Scope**: mixed（基线代码 + 外部协议事实）
- **Date**: 2026-10-01

---

## 1. `kind` / `mark`

### `kind` = `'coding'` ✅

依据：
- `src/shared/types.ts:11-15`：`coding — Coding plan（订阅制，看用量/限额/重置时间/tokens）`
- `quality.ts:27` `isPlan = (s) => s.kind !== 'balance'` —— 决定要不要画用量环、叫「余额」还是「套餐」
- 现有同族：claude/codex/copilot/opencode-go 全是 `coding`；minimax 是 `token`

Antigravity 是**订阅制 + 滚动窗口 + 重置时间**，与 Claude Code / Codex 完全同构 → **`coding`**。
不是 `token`（minimax 那种按 token 计费的套餐包，Antigravity 的量纲是「额度百分比」不是 token 数）。

### `mark` = `'antigravity'` ⚠ 需配套改动

依据 `src/main/adapters/engine.ts:18-19`：
> mark 是**实例派生**的元数据（内置用预设 id、自定义用协议 id）

所以：
- 建议 **presetId = `'antigravity'`，protocol = `'antigravity'`**（两者同名）→ 内置与自定义 mark 都是 `'antigravity'`，不会劈叉
- `provider-icons.ts` 目前**没有** `antigravity` 键 → 需要加一条，否则 logo 落空
  - 可用图标：`simple-icons:google`（Astra 品牌非 Google，simple-icons 未必有）；参照 `volc` 用 `thesvg:volcengine` 的先例，可能需要自备 svg

**注意**：`protocols.ts` 是四家适配器子任务共用文件（父任务明确要求不碰）。`protocols.ts` 的改动会与其它三个子任务冲突 → 见 §5。

---

## 2. 凭证：`items`（加密）vs `extras`（明文）

### 2.1 硬规则（来自 `tts:getSecret` 教训）

`src/main/ipc.ts:54-68`：
> 凭据只有两条路，且**两个命名空间互不相通** ——
> `setKey`/`getKey` → `items`（safeStorage 加密落盘），
> `setExtra`/`getExtra` → `extras`（明文）
> 图省事写进 extras 就等于把 token 明文留在磁盘上，且混用两个命名空间是**静默失败**
> （写进去读出来都是 null，界面只会显示"未配置"）

⇒ **OAuth token / refresh_token 一律 `items`，绝不进 `extras`。**

### 2.2 渲染层不得拿到明文

`src/renderer/src/App.tsx:220`：
> ⚠ 别为了「少一次 IPC 往返」把 getter（`tts:getSecret`）加回来：它已随本次任务删除

`src/main/ipc.ts:283` 记录了 `tts:getSecret` 已下线。

⇒ **本任务不需要新增任何返回凭据的 IPC。** 令牌只在主进程适配器内部流转，快照里绝不能出现 token / email 之外的账号敏感值。

⚠ **email 的边界**：`GetUserStatus` / `antigravityAuthStatus` 会带用户 email。copilot.ts:159 已经在 detail 里回显 `账号 ${cred.user}` —— 有先例。但 Antigravity 的 email 是 Google 账号主邮箱，敏感度更高。**建议不放进 detail**，或只放 `detail` 不放 `plan`（`plan` 会被托盘/卡片直接渲染）。

### 2.3 需要存什么 / 存到哪

| 数据 | 敏感？ | 存放 |
|---|---|---|
| Google OAuth access_token | ⛔ 是 | **`items`**（`ctx.getKey('antigravityToken')`） |
| refresh_token | ⛔ 是 | **`items`** |
| cloudaicompanionProject | ❌ 否 | **`extras`**（如 `antigravityProject`） |
| 是否用完 project 才报数字（用户偏好） | ❌ 否 | `extras` |
| 限额覆盖 | ❌ 否 | `extras`（但 Antigravity 没有可覆盖的绝对限额 → **不需要**） |

**关键推论：Antigravity 完全没有 `ctx.getKey` 的必要位置。**
token 是**从本机自动发现**的（Keychain / SQLite / token 文件），不需要用户粘贴。
⇒ 对应 `BuiltinPreset` 应配 `localCredential: true` + `singleton: true`（与 claude/codex/copilot 同，见 `providers.ts:67-90`）。

**但这带来一个矛盾**：`localCredential: true` 的预设，用户无法在设置页填凭据。如果 Keychain 读取在某些平台失败（Linux Secret Service 未必可用、Windows Credential Manager 需要 win32 调用），用户就**彻底无法使用**。

⇒ **建议**：仍提供一个手动兜底入口（`items` 存 access_token 粘贴），让 Keychain 失败的用户有出路。这是新增能力，标注在 §7 待确认。

---

## 3. 降级路径矩阵

必须走 `applyCachePolicy`（`quality.ts:37`）。三条纪律：
1. 铸造是唯一产出快照的地方
2. 身份必填（`identityOf`）
3. **可信度必填** —— 错误/nodata 显式传 `undefined`，不允许默认成 `official`

参考 `copilot.ts:114-127` 的四分支写法：

| 场景 | `status` | `dataQuality` | 文案落点 | `detail` / `failureReason` 建议 |
|---|---|---|---|---|
| **未找到凭据**（Keychain/SQLite/token 文件都没有） | `nodata` | `undefined` | `noDataSnap` | `未找到 Antigravity 凭据：请在 Antigravity 或 agy 中登录一次`（**不是错误**，用户还没配置） |
| **HTTP 401**（token 过期/被吊销） | `error` | `undefined` | `errSnap` | `Antigravity 凭据已失效（HTTP 401）：请在 Antigravity 中重新登录` |
| **HTTP 403** | `error` | `undefined` | `errSnap` | **必须区分**三种 reason：<br>`SUBSCRIPTION_REQUIRED (#3501)` → `当前账号无有效 Antigravity 订阅（免费档可能不提供额度接口）`<br>`VALIDATION_REQUIRED` → `账号需完成 Google 验证`<br>其它 → 透传 reason 字段 |
| **HTTP 429** | `error` | `undefined` | `errSnap` | `配额接口限流（HTTP 429）`；**记 `Retry-After`**（多家实现都做了有界退避） |
| **离线 / 超时**（`isNetworkError`） | `error` | `undefined` | 抛错 → `collectAll` 兜成 `errSnap` | 由 `src/main/net.ts` 的 `markNetResult` 记离线；`errSnap` 会把 message 同时塞进 `detail` 与 `failureReason`（test-adapters.mjs D5 断言了这点） |
| **响应格式未识别**（groups 为空 / 字段全缺） | `error` | `undefined` | `errSnap` | `响应格式未识别：<前 160 字>`（照 `copilot.ts:125`） |
| **成功** | `ok` | `official` | `officialSnap` | `source: '官方接口'` |
| **成功但某个 bucket 缺 remainingFraction** | `ok` | `official` | `officialSnap` | **只渲染有值的窗口**；缺的**不补 0、不补 100** |
| **成功但一个窗口都没有** | `ok` + `windows: []` | `official` | `officialSnap` | ⚠ 这会**触发 `applyCachePolicy` 的降级分支**（`quality.ts:45` 把 `windows.length === 0` 算作 degraded）→ 正确行为（缓存上次的官方数据 + `degradedReason`），不是 bug |

⚠ **`dataQuality: 'local'` 在 Antigravity 场景不适用**：我们没有本机估算的额度。`applyCachePolicy:43` 规定 `prev.dataQuality === 'local'` 时不缓存 —— 这条路径我们走不到。
（如果父任务想加「本机对话库 token 估算」，那才是 `local`，且必须**另开窗口**，不能与官方百分比混在同一窗口 —— external-api-integration.md Step 4。）

⚠ **`degradedReason` 由谁写**：`applyCachePolicy` 在**降级发生时**才写 `degradedReason`（`quality.ts:56-57`，取 `next.failureReason ?? next.degradedReason ?? next.detail`）。适配器本身**不需要**直接写 `degradedReason` —— 照 `copilot.ts` 写 `detail`/`failureReason` 即可。

---

## 4. 协议表 vs 独立适配器

### 推荐：**独立代码适配器 `src/main/adapters/antigravity.ts`** ✅

理由（逐条对照 ADR-0001）：

| 声明表表达不了的 | Antigravity 是否需要 |
|---|---|
| 请求签名 | ❌ 不需要（Bearer token，无签名） |
| 浏览器会话 | ❌ 不需要 |
| **本机文件** | ✅ **需要**（Keychain / SQLite / token 文件三级回退） |
| **备用端点** | ✅ **需要**（3 个 base URL 按序回退 + `loadCodeAssist` 前置） |
| POST body | ✅ 需要（且接缝本身要扩展） |
| 多段凭据解析 | ✅ 需要 |

ADR-0001 Considered Options 原文：
> 「本机转录、sqlite、浏览器会话也会被硬塞进协议这个词里」

⇒ 声明表的 `probe` 只能返回 `{path} | {url}`（**恒 GET、无 body、无本机读取**），Antigravity 四项全中。

**与现有 7 个代码适配器的对照**（`index.ts:16-31` 的注释已把这类归为「浏览器会话 / 本机文件」）：
```
· 浏览器会话 / 本机文件：opencode-go、claude-code、codex、copilot
```
Antigravity 正好落在这条既有分类里。

### 因此**不需要**改 `protocols.ts` ✅

这正好满足父任务「不要碰 protocols.ts（四家子任务共用）」的约束。
需要动的注册点只有：
- `src/main/adapters/index.ts` → `CODE_ADAPTERS['antigravity'] = antigravityAdapter`
- `src/main/providers.ts` → `BUILTIN_PRESETS` 加一条

### 复用价值检查

`protocols.ts` 的 `ProtocolDecl` 有 `read(body) => ProviderWindow[] | null` —— 这正是 Antigravity 响应解析的形状。
**但把它做成声明式会破坏**：
- `probe` 无法表达 POST + project 前置依赖
- 三个 base URL 的回退需要在 `probe` 之外的状态
- 无 `unknownMeters` 信号位（`.trellis/spec/adapters/index.md` 层规则 3 要求「未知形状要有出口」）

⇒ **纯函数解析可以复用形状，采集流程必须留代码侧。** 建议：`antigravity.ts` 内部导出一个**纯函数** `parseQuotaSummary(body): ProviderWindow[] | null`（便于单测），流程部分自己写。这与 `plan-utils.ts`（`claude.ts` / `codex.ts` 共用的纯函数模块）是同一个模式。

---

## 5. 测试落点

### 5.1 段落位置

`scripts/test-adapters.mjs` 已用段：**A B C D E F G H I J K L M N T R S U**（`grep` 实测；T 段在 N 之后、R/S 之前，见文件 758/1017/1105 行）。

**T 段有一条硬断言会挡路**：
```js
// test-adapters.mjs ~N7
eq(Object.keys(PROTOCOLS).length, 8, 'N7 声明表恰好 8 条：…')
```
⇒ 走独立适配器（不加进 `PROTOCOLS`）正好不用改这条。

⇒ **建议新开一段 `V. Antigravity · 代码适配器`**，追加在文件末尾（U 节之后、`console.log(\`\n通过 ${pass} 项…\`)` 之前）。

### 5.2 fixture 怎么造

**来源标注（强制）**：`scripts/test-adapters.mjs` 文件头的纪律是「夹具按产品代码注释与 DESIGN.md §4 的实测记录手写」。而 Antigravity 我们**没有实测**，只有二手实录。

⇒ fixture 的注释里必须写清：
```
// 来源：robinebers/openusage docs/providers/antigravity.md（MIT）与
//      can1357/oh-my-pi#9940 贴出的真实响应（2026-08）。
// ⚠ 二手实录，非本仓库实测。external-api-integration.md Step 2：
//   冻结的 fixture 只是 fixture，不是活系统的证据。
```

三份 fixture（对应 §1 的三种 nesting）：
1. **正常**：`groups` 顶层 + `remainingFraction` 驼峰 + 2 池 × 2 窗口
2. **变体**：`response.groups` 嵌套 + `remaining_fraction` 蛇形 → 断言与 #1 **完全同结果**（照 E5「双字段探针」的思路）
3. **不可识别**：`{"foo":1}` → 断言 errSnap 文案

### 5.3 断言点

复用文件里的 `check(label, {adapter, extras, routes, expect})` + `expectFor(protocol, builtin)` 骨架。注意几点：

| 断言 | 怎么做 |
|---|---|
| `mark` 为 `null`（基座不声明） | `kind: 'coding', mark: null`（照 M 段的 `EM`） |
| `source` | `'官方接口'` |
| `plan` | 从 `paidTier`/`currentTier` 解析（照 pi-antigravity：**真实订阅在 `paidTier`**） |
| 窗口 | `percent` = `100 - frac*100`，保留一位小数（`Math.round(x*10)/10`，照 `copilot.ts:145`）；`used: 0`、`limit: **undefined**`、`resetAt` 直接用 `resetTime` |
| 请求序列 | `expect.calls` —— ⚠ **需要先给 `callProject` 加 body/method 投影**，否则断言不到 POST |
| 403 三种 reason | 三条独立用例 |
| 429 | 一条用例，断言文案 |
| 未找到凭据 | `nodata`（`EM.nodata` 没有 kind: 'token' 那种改写，需为 coding 单独建期望构造器） |
| `loadCodeAssist` 前置 | 断言两次请求的顺序（`expect.calls`） |
| 项目名缺失时不报数字 | 一条用例：project 为空 → 断言 errSnap 而非 `ok`（这是**外部 guide Step 4 的落地**） |

### 5.4 测试桩要改的地方

`makeRequest`（`test-adapters.mjs:92-107`）的 `routes.find(x => x.url === req.url)` 只按 URL 匹配 —— Antigravity 三个端点 URL 不同，够用。
但 `callProject`（:110）只投影 `url` / `auth` / `accept` ⇒ **需要加 `method` 和 `body`** 才能断言 POST。

⚠ 这是**共享文件**，只加不改（父任务要求）。加字段是纯增量，不影响既有 `expect.call` 比较（既有断言用的是 `stable()`，新字段 `undefined` 会被 `stable` 过滤掉 —— `stable` 里 `.filter(k => v[k] !== undefined)`）。

---

## 6. 凭据读取路径的实现代价（对照 `opencode.ts`）

`opencode.ts` 的 `resolveKeys`（:155-183）是最好的参照：**多来源按优先级 push，标签记来源**。Antigravity 对应：

```
1. macOS Keychain  (security find-generic-password -a antigravity -s gemini -w)
2. ~/.gemini/antigravity-cli/antigravity-oauth-token   (旧版，纯 JSON)
3. IDE SQLite state.vscdb → antigravityAuthStatus.apiKey  (需 sqlite3)
4. 用户手动粘贴（存 items）
```

⚠ **第 3 步的成本**：本仓库无 SQLite 依赖。查了 `package.json` 未确认（需 implement 阶段核）。
- 若不引依赖：可调 `sqlite3` CLI（CodexBar/usagebar 都用 `execSync` 调 CLI）—— 但要处理「CLI 不存在」
- 若引 `better-sqlite3`：打包体积 + 原生模块重编译（electron-builder）是个坑

⇒ **建议第一版只做 1+2+4，跳过 3**（`antigravityAuthStatus.apiKey` 是 access token，Keychain 与它通常同源；SQLite 那条是给 IDE 关且 CLI 也没登过的边缘用户兜底）。

⚠ **第 1 步要 `child_process.execFile('security', ...)`** —— 这在 Electron 主进程可行，但 `test-adapters.mjs` 的纯 node 环境里 `security` 存在（macOS）却读不到东西（返回码非 0）。⇒ 适配器里必须把它包成「失败即跳过下一个来源」，且**测试要能注入**（目前 `CollectContext` 没有这个能力）。

---

## 7. 需要用户确认的问题

见 `06-open-questions.md`。简版：
1. 是否接受扩展 `CollectRequest`（加 `method`/`body`）—— 不接受则 Antigravity 只能做成本机 LS 路线（代价大得多）
2. 是否内嵌 Google 的公开 OAuth client_id/secret（源自 AGPL 源码的字面量）
3. 是否引 SQLite 依赖 / 是否做第 3 条凭据路径
4. `unit` 用 `'percent'` 还是 `'token'`（影响 UI 渲染路径）
5. 是否要「手动粘贴 token」的兜底入口