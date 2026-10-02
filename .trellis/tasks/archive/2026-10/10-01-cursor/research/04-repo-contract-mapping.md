# Research: 仓库契约映射 — kind / mark / 凭据 / 降级 / 协议表 vs 代码适配器 / 测试落点

- **Query**: kind 与 mark 取什么？凭据放 items 还是 extras？降级路径怎么给？走 protocols.ts 还是独立 cursor.ts？fixture 怎么造？
- **Scope**: mixed（基线代码 + 协议事实）
- **Date**: 2026-10-01

---

## 1. `kind` = `'coding'`

依据：
- `src/shared/types.ts:11-15`：`coding — Coding plan（订阅制，看用量/限额/重置时间/tokens）`
- `src/shared/quality.ts:27`：`isPlan = (s) => s.kind !== 'balance'` —— 决定画不画用量环、叫「余额」还是「套餐」
- 同族：claude / codex / copilot / opencode-go 全是 `coding`

Cursor 是**月度订阅 + 限额 + 重置日**，与 Claude Code / Codex 完全同构 → **`coding`**。

不是 `token`（minimax 那种按 token 计费的套餐包）。虽然量纲是美元，但 `copilot.ts:25-26` 已确立
「非 USD 的次数/额度一律借 `'token'` 渲染」的先例；**Cursor 的量纲本来就是美元，所以应该直接用 `'usd'`**，
不需要借 `token`。这样 `smartBroadcast.balanceOf()`（`src/renderer/src/smartBroadcast.ts:145-149`）
的 `limit - used` 会直接得到「本月还剩多少美元」，语义正确。

---

## 2. `mark` = `'cursor'`（presetId 与 protocol 同名）

依据 `src/main/adapters/engine.ts:18-19`：
> mark 是**实例派生**的元数据（内置用预设 id、自定义用协议 id）

- 建议 **presetId = `'cursor'`，protocol = `'cursor'`**（同名）→ 内置与自定义 mark 都是 `'cursor'`，不劈叉。
- ⚠ **`src/renderer/src/provider-icons.ts` 里没有 `cursor` 键** → 必须补，否则 logo 落空。
  该文件是**生成物**（文件头：「由 scripts/gen-provider-icons.mjs 生成，请勿手工编辑」），
  要改的是 `scripts/gen-provider-icons.mjs:26-44` 的 `MARKS` 表，加一行：
  ```js
  cursor: { icon: 'simple-icons:cursor', color: '' },
  ```
  **已验证**：`GET https://api.iconify.design/simple-icons/cursor.svg?height=24` → `200`
  （`simple-icons:cursorlogo` 与 `lucide:cursor` 均 404）。
  ⚠ 生成脚本会**重写整个 `provider-icons.ts`** → 与其它三个并行子任务**必然冲突**。
  **建议：Cursor 子任务只改 `gen-provider-icons.mjs`，把 `provider-icons.ts` 的重新生成留给合并阶段统一跑一次。**

---

## 3. 凭据：`items`（加密），且**默认不要存**

### 3.1 硬规则（来自 `tts:getSecret` 教训）

`src/main/ipc.ts:54-68`：
> 凭据只有两条路，且**两个命名空间互不相通** ——
> `setKey`/`getKey` → `items`（safeStorage 加密落盘），
> `setExtra`/`getExtra` → `extras`（明文）… 图省事写进 extras 就等于把 token 明文留在磁盘上

⇒ **JWT / refreshToken 一律 `items`，绝不进 `extras`。**

### 3.2 渲染层不得拿到明文

`src/main/ipc.ts:283-296`：`tts:getSecret` 已随 `09-29-tts-request-to-main` 下线；
只保留 `tts:hasSecret`（回布尔）。

⇒ **本任务不需要新增任何返回凭据的 IPC。**
⚠ `providers.ts:427` 有 `const supportsCookie = protocol === 'opencode-go'` 的硬编码，
`:434-447` 会把 cookie 尾 4 位回显进 `cookieHint`。**Cursor 不要接这条路**（既不要 cookie，
也不要尾号回显）——那会要求改 `providers.ts` 这个共享文件。

### 3.3 建议的凭据解析顺序（**不落盘**）

```
① ctx.getKey(inst.id)              ← 用户在设置里手动粘贴的 JWT（items，加密）—— 兜底
② state.vscdb 的 cursorAuth/accessToken   ← 主源（Cursor IDE 开着时最鲜活）
③ CLI auth.json 的 accessToken            ← 无 IDE 的纯终端机
```

- ①②③ 的顺序建议**把手动粘贴放最后**：`providers.ts:412-421` 的 `credentialSource` 判定是
  `saved > env > file`，若本机文件有值，用户会看到「本机配置自动读取」；
  手动粘贴是给「IDE 没装 / 没登录」的用户留的逃生口。
  ⚠ 若把手动放最前，则「Cursor IDE 明明登录了、界面却说未配置」——正是
  `external-api-integration.md` Step 6 点名的症状。
- **不要 `setKey` 自愈回写**。理由见 `02-endpoints-and-auth.md` §5：刷新权在 Cursor 手里，
  我们回写只会与它抢写同一个文件；而且缓存副本必然比 Cursor 自己维护的那份旧。

### 3.4 `extras` 只放非敏感的可选覆盖

参考 `minimax.ts:43-46` 的先例（`baseUrl:minimax`、`minimaxGroupId`）。
Cursor 可选：`baseUrl:cursor`（默认 `https://api2.cursor.sh`）—— 纯地址，非敏感。
`scanner.ts:6-14` 的 `ENV_MAP` 可加 `cursor: ['CURSOR_ACCESS_TOKEN']`（pi-cursor 也认这个变量），
但那是 `src/main/scanner.ts` 共享文件 → 与其它三家可能撞车，**建议合并阶段统一加**。

---

## 4. 降级路径（逐场景）

**重要事实：`applyCachePolicy` 不在适配器里。** 它由 `scheduler.ts:87` 在采集后统一套用：
`merged.push(applyCachePolicy(prevById.get(id), next))`。
适配器的责任只有一条：**`ok` 路径显式声明 `dataQuality`；错误/无数据路径用 `errSnap`/`noDataSnap`
（`quality === undefined`，ADR-0002）**，`applyCachePolicy` 才能正确地把上一轮 official 数据降级成 `cached`。

| 场景 | `status` | `dataQuality` | 文案方向 |
|---|---|---|---|
| 没装 Cursor / 从未登录（三个源都没有 token） | `nodata` | `undefined` | `noDataSnap`：点名在哪登录（仿 `copilot.ts:96-100` / `claude.ts:188`） |
| 文件在但 token 空 / JWT 解不出 `sub` | `nodata` | `undefined` | 同上（这是「未配置」不是「错误」） |
| JWT `exp` 已过（本地可判定，不必发请求） | `error` | `undefined` | `errSnap`：可操作 —— 「在 Cursor 中重新登录」 |
| HTTP 401 / 403 | `error` | `undefined` | `errSnap`：会话失效（`copilot.ts:114-119` 先例） |
| HTTP 429 | `error` | `undefined` | `errSnap`：限流，**不要说「请检查网络」** |
| 其它非 200 | `error` | `undefined` | `errSnap`：`HTTP ${status}`（`copilot.ts:121`） |
| 离线 / DNS / 超时（`request.ts:26-30` 会 throw 并 `markNetResult(false)`） | `error` | `undefined` | `errSnap`：请求失败；scheduler 会同时置 `offline` |
| JSON 解析失败 / 认不出的形状 | `error` | `undefined` | `errSnap`：`响应格式未识别：<预览 160 字符>`（`copilot.ts:124-127` 先例） |
| 成功且形状可识别 | `ok` | **`official`** | `officialSnap`（服务端真值，与 copilot 同） |

补充要求：
- **没有 `local` 路径**。Cursor 的额度只存在于服务端，本机没有任何可推算的口径
  （不像 claude.ts 用转录 + 社区限额常量）。所以 `dataQuality === 'local'` 在本适配器里**永不应出现**，
  一旦出现就是 bug。
- **`degradedReason` 由 `applyCachePolicy` 写**（`quality.ts:56-57`，取 `next.failureReason ?? next.degradedReason ?? next.detail`）。
  适配器只需把话写进 `detail`（`errSnap` 会同时写 `failureReason`）。
- **`isUnlimited: true`** → 不给假进度条。照 `copilot.ts:150-152` 的先例推一个无 limit 的窗口：
  `{ name: '套餐额度', used: 0, unit: 'usd', note: '当前套餐不限量' }`。
- **`status: 'ok'` 但 `windows: []`** 会被 `applyCachePolicy` 判为 degraded（`quality.ts:45`）——
  所以「形状认不出」必须走 `errSnap`，不能返回空窗口的 ok 快照。

---

## 5. 走 `protocols.ts` 还是独立 `cursor.ts`？—— **强烈建议独立 `cursor.ts`**

五条理由（前三条是硬阻塞）：

1. **方法与请求体表达不了**（**已由另一个任务解掉，见下**）。
   `CollectRequest`（`types.ts:11-16`）只有 `{ url, headers, timeoutMs }`，
   生产实现 `src/main/request.ts:22-26` 是 `fetch(req.url, { headers, signal })` —— **恒为 GET，无 body**。
   Cursor 的 Connect 端点是 **POST + `{}` + `Content-Type` + `Connect-Protocol-Version: 1`**。

   > ✅ **接缝扩展已单独设计并提交**：`.trellis/tasks/10-01-seam-post-body/`（`design.md`，commit `6c81361`，
   > 2026-10-01）。契约：`method?: 'GET' | 'POST'` + `body?: string`（**已序列化**，序列化与 Content-Type 归调用方，
   > 但「有 body 且无 Content-Type」时接缝自动补 `application/json`）。
   > 门禁：既有 18 个套件的断言数必须与改动前完全一致（纯增量证明）；
   > 测试桩**新增** rich 记录函数（记 `method`/`body`）而**不改** `callProject`。
   >
   > **⇒ 对 Cursor 的影响**：
   > · 适配器只写 `ctx.request({ url, method:'POST', body:'{}', headers: { Authorization, 'Connect-Protocol-Version':'1' } })`，
   >   `Content-Type` 由接缝补；
   > · **仍不能走声明表** —— `protocol-adapter.ts:68-72` 的工厂写死了 GET + `Authorization: Bearer` + `Accept`，
   >   没有 body/自定义头的扩展点；
   > · 开工前确认该任务已合入（工作区 `types.ts` / `request.ts` 目前**还是旧的**）。

2. **自定义请求头表达不了。** `protocol-adapter.ts:69-72` 的工厂**写死**了
   `Authorization: Bearer` + `Accept: application/json` 两个头，没有扩展点。

3. **凭据形状不是「一个 API key」。** 声明表的 `ctx.getKey(inst.id)`（`protocol-adapter.ts:55`）
   只能拿到单个字符串；而 Cursor 要的是「本机文件 → SQLite/JWT → 过期判定」的级联，
   与 `copilot.ts:49-70` 的 `readCopilotToken()` 同型。copilot 就是为此留在代码侧的。

4. **`SELECTABLE_PROTOCOLS` 会把它暴露成「自定义协议」。**
   `protocols.ts:277-293` 的目录列表是给用户「添加自定义提供方」用的，
   Cursor 不该出现在那里（用户没法手填一个能用的 token）。claude/codex/copilot 都不在。

5. **改动面。** 走声明表要碰 `protocols.ts`（四家共用，父任务明令不碰）+ 三个共享文件；
   走代码侧只需碰 `cursor.ts`（新建）、`index.ts` 的 `CODE_ADAPTERS` 加一行、
   `providers.ts` 的 `BUILTIN_PRESETS` 加一条。

**落地清单（代码侧）**：
```
src/main/adapters/cursor.ts               ← 新建（唯一新文件）
src/main/adapters/index.ts:24-32          ← CODE_ADAPTERS 加 'cursor': cursorAdapter
src/main/providers.ts:54-150              ← BUILTIN_PRESETS 加一条（照 copilot 那条抄形状）
scripts/gen-provider-icons.mjs:26-44      ← MARKS 加 'cursor'（**不要**顺手重生成 provider-icons.ts）
scripts/test-adapters.mjs                 ← **只追加**自己的段（见 §7）
```

预设条目建议（形状照 `providers.ts:86-93` 的 copilot）：
```ts
{
  id: 'cursor',
  name: 'Cursor',
  kind: 'coding',
  protocol: 'cursor',
  defaultBaseUrl: 'https://api2.cursor.sh',
  localCredential: true,   // 凭据来自本机 Cursor 登录态
  singleton: true          // 本机文件型数据源，重复无意义
}
```
⚠ `localCredential: true` 会让 `providers.ts:412-421` 把 `credentialSource` 报成 `'file'` →
  设置页显示「本机配置自动读取」（`SettingsView.tsx:212`）。这正是想要的。

---

## 6. 窗口模型（口径）

主窗口（**只用绝对值，不用服务端 percent**）：
```ts
{
  name: '本月套餐',
  used:  planUsage.includedSpend / 100,   // 分 → 美元
  limit: planUsage.limit / 100,
  unit:  'usd',
  percent: roundPercent(includedSpend / limit * 100),  // 自算，与 used/limit 一致
  resetAt: new Date(Number(billingCycleEnd)).toISOString(),
  note: '官方接口'
}
```
- 不变量自检：`includedSpend + remaining === limit`；不成立 → 判为 schema drift（`errSnap`），
  **不要**硬凑一个数（`ai-usagebar` 的 `Schema` 错误路径值得照抄这个思路）。
- `spendLimitUsage.individualLimit > 0` 时可加第二窗口「按需预算」：`used = individualUsed/100`,
  `limit = individualLimit/100`，同样自算 percent；`limitType === 'team'` 时用 `pooledLimit/pooledUsed`。
- **两个子池（`autoPercentUsed` / `apiPercentUsed`）建议 v1 不展示**：
  它们没有对应的绝对值，无法自校验，而社区对 `*PercentUsed` 的语义有三种互相矛盾的解读（`02` §4）。
  若一定要展示，必须在 `note` 里写明「服务端百分比字段」并接受它是官方口径。

`plan` 字段：先读同库 `cursorAuth/stripeMembershipType`（`pro`/`ultra`…）→ title-case；
拿不到就留空（`plan` 是可选字段，缺省不出错）。**不要**为此多打一次 `GetPlanInfo`。

---

## 7. 测试落点（`scripts/test-adapters.mjs`）

### 7.1 段落字母：建议用 **`V`**

现有段：`A B C D E F G H I J K L M N T R S U` + 「已收口的缺陷」。
空闲字母：`O P Q V W X Y Z`。
⚠ 另外三个并行子任务也要挑字母 —— 建议各家约定：**gemini→O、antigravity→P、openai-quota→Q、cursor→V**。
（挑 `V` 是因为 Cursor 与 O/P/Q 无语义关联，最不容易撞。）

### 7.2 fixture 怎么造

**本机没有 Cursor（实测 `~/.cursor` 与 `~/Library/Application Support/Cursor` 均不存在，
`cursor-agent` 不在 PATH，检索日 2026-10-01）→ 无法抓真实响应。**

⇒ fixture 只能**照第三方记录手写**，并在文件里**逐字标注来源与检索日期**
（这正是 `external-api-integration.md` Step 2 要求的：「frozen fixture 作为 fixture 没问题，
但它不是活系统的证据」）。

可用的高可信样本（两个独立来源互相印证）：
- `GetCurrentPeriodUsage`：PaceBar `docs/providers/cursor` 的示例 + Cursor 官方论坛 2026-08-12 贴文
- `usage-summary`：ai-usagebar 源码注释里的 live Ultra 样本

### 7.3 必须新增的测试可注入缝（**当前没有**）

`claude.ts` / `codex.ts` / `copilot.ts` 三个本机文件型适配器**目前都没有 fixture 段**
（`test-adapters.mjs:33-36` 只 load 了 `protocols`/`protocol-adapter`/`minimax`/`engine`），
它们的凭据探测是**直接 `readFileSync`** —— 在测试里没法注入。

⇒ Cursor 若要写端到端 fixture，必须**给凭据探测留环境变量缝**（业界先例：
`wakamex/cursor-cli-usage` 有 `CURSOR_USAGE_STATE_DB`，`copilot.ts:51` 已有 `XDG_CONFIG_HOME` 先例）：
```ts
const dbPath = process.env.CURSOR_STATE_DB ?? <平台默认路径>
```
测试里 `process.env.CURSOR_STATE_DB = <临时目录>/state.vscdb`，用 `node:sqlite` 建一张
`ItemTable(key TEXT, value TEXT)` 塞一条假 JWT 即可跑通全链路。
⚠ 假 JWT 用 `{"alg":"none"}` + base64url payload（`sub` / `exp`），**源码与示例里不得出现任何可用凭据字面量**
（`src/main/keystore.ts:5-6` 的既有纪律）。
⚠ 测试文件顶部 `test-adapters.mjs:68` 已 `delete process.env.BALANCEDECK_FORCE_OFFLINE`，
新增的环境变量覆写要在**自己的段里 try/finally 复原**，别污染后续段。

### 7.4 断言点（建议清单）

| # | 断言 |
|---|---|
| V1 | 正常响应 → `ok` + `dataQuality === 'official'` + 单窗口 `{本月套餐, used/limit(美元), percent 自算, resetAt}` |
| V2 | 请求形状：URL、`method:'POST'`、`body:'{}'`、`Authorization: Bearer <jwt>`、`Connect-Protocol-Version: 1`、`Content-Type: application/json`（**用 `10-01-seam-post-body` 新增的 rich 记录函数断言**，不要改 `callProject`——它被既有断言深度依赖） |
| V3 | 金额换算：`limit: 40000` → `limit: 400`（美元），不是 40000 |
| V4 | `resetAt` 由 **unix 毫秒字符串** → ISO |
| V5 | `includedSpend + remaining !== limit` → `errSnap('响应格式未识别…')`，**不是** 0% |
| V6 | 401 → `errSnap`，文案点名「在 Cursor 中重新登录」 |
| V7 | 429 → `errSnap`，文案是限流（断言**不含**「检查网络」） |
| V8 | 三个凭据源都空 → `nodata`，文案点名路径 |
| V9 | JWT `exp` 已过 → `error` 且**不发请求**（`inst.list` 为空） |
| V10 | `isUnlimited: true` → 无 limit 的窗口 + note「不限量」，`percent` 缺省 |
| V11 | 缺 `planUsage`（team 形状）→ `errSnap`，**不是** 0% |
| V12 | `bindInstance` 后 `mark === 'cursor'`、`kind === 'coding'`、id/name 换成实例身份 |
| V13 | **不调 `setKey`**（`onSetKey` 未被触发）—— 锁住「不自愈」这条决策 |
| V14 | `PROTOCOLS.cursor === undefined`（锁住「不走声明表」这条决策） |

⚠ **`test-adapters.mjs:750-756` 有 `N5`/`N7` 断言 `Object.keys(PROTOCOLS).length === 8`** ——
这是「不走声明表」的**额外保险**：谁把 Cursor 加进 `protocols.ts`，N7 立刻红。

---

## Caveats / 未验证

- `providers.ts` / `index.ts` / `scanner.ts` / `gen-provider-icons.mjs` 都是共享文件，
  本研究**没有**列清楚其它三家会不会碰它们 —— 合并冲突面需要主 agent 统一裁决。
- 「Cursor 适配器会是第一个带端到端 fixture 的本机文件型适配器」—— 若 claude/codex/copilot
  之后也要补测试，测试基建（可注入的凭据探测）应当抽成共享约定，不要各家各造。