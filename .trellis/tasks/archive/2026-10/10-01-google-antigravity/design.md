# Design: Google Antigravity 适配器

## Architecture

```
┌─ 凭据（三源级联，只读，ENOENT 安全）──────────────────────────────────┐
│                                                                        │
│  ① macOS Keychain ── execFile security ──► { token: { access_token … } }│
│     find-generic-password -a antigravity -s gemini -w                  │
│     剥 go-keyring-base64: 前缀；仅 darwin，其他平台静默跳过              │
│     ⚠ 只读，绝不回写（写坏等于毁掉用户登录）                             │
│  ② ~/.gemini/antigravity-cli/antigravity-oauth-token ── 纯 JSON，只读   │
│  ③ ctx.getKey(inst.id) ── 用户手动粘贴（items 加密，优先级最低）        │
│                                                                        │
│  ❌ 不刷新 ❌ 不回写 ❌ 不新增回传 token 的 IPC                            │
└────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─ collect(ctx)：loadCodeAssist 前置 + 三 host 回退 ─────────────────────┐
│                                                                        │
│  ① POST <base>/v1internal:loadCodeAssist                               │
│     body {"metadata":{"ideType":"ANTIGRAVITY","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}}
│     → cloudaicompanionProject + tier（paidTier.name 优先）              │
│     project 空 → errSnap（假 100% 陷阱，此处截停）                       │
│         ↓                                                              │
│  ② POST <base>/v1internal:retrieveUserQuotaSummary                     │
│     body {"project": project}   ← 决定成败的字段                        │
│     base 按序：daily → daily.sandbox → cloudcode-pa                     │
│     ⚠ 只在抛错/超时时换 host；HTTP 错误状态不换                        │
│         ↓                                                              │
│  parseQuotaSummary(body) → windows[] | null                            │
│    null → errSnap('响应格式未识别：<160 字符预览>')                     │
└────────────────────────────────────────────────────────────────────────┘
```

## Technical Decisions

### D1 · 独立代码适配器，**不进 `protocols.ts`**

四项超出声明表：POST body、**前置依赖**（第二个请求的 body 依赖第一个的响应）、
本机文件读取、三 base URL 回退状态。N7（`:800`）断言 8 条是额外保险。

### D2 · 直接用 `readJson` 的可选第 5 参，`engine.ts` 不动

```ts
readJson(ctx, url, { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
  'User-Agent': 'BalanceDeck/1.0' }, 12000, { method: 'POST', body })
```

Gemini 扩参、Cursor 复用，Antigravity 是**第三个消费者**。参已够用，动它就是没事找事。

### D3 · `mark` 与 preset id / protocol id **三同 `'antigravity'`**

Gemini/Cursor 的教训，不重复。`providerMark` 只按 key 查，劈叉会让自定义实例
静默退回 generic 图标。

### D4 · headers 显式写全，User-Agent **不伪装**

三个头全由适配器显式写（D4 的理由同 Cursor：测试桩不模拟接缝自动补，
不显写就是假覆盖）。UA 用可识别自己的字符串；伪装 `antigravity/…` 或
`cursor-agent/x` 是最后手段——未验证是否必需，先不伪装，401/403 时再考虑，
注释写清。**不发送 `Connect-Protocol-Version`**：该头只见于本机 LS 的 Connect 端点
文档，Cloud Code `v1internal` 无证据要求它；多发未知头等于多一个被拒理由。

### D5 · 解析宽容三种 nesting，但**值域纪律严格**

找 groups 三位置、fraction 三写法——这是逆向接口的生存必需（字段名在多个版本间
不一致，多家实现都写了宽容）。但宽容**只在"形状"不在"值"**：
fraction 不在 0..1 ⇒ 跳过（不 clamp）；groups 找不到或全灭 ⇒ null（不给空窗口）。
形状宽容 + 值严格，两个方向各守一条。

### D6 · project 缺失截停（假 100% 陷阱的守卫）

usagebar 警告：不带 project 的查询会假报 100% 剩余。`loadCodeAssist` 拿不到 project
⇒ `errSnap` 说明原因，**连第二个请求都不发**（省一次出网 + 杜绝假数字）。
⚠ 这条必须有行为断言（project 为空时请求序列长度为 1），否则某天有人"优化"成
空 project 照查，套件照绿——静默撒谎。

### D7 · 窗口名组名前缀（对调研推荐模型的**有意偏离**）

调研 05 说 name 取 `'5 小时'`/`'本周'`。但两组各有 5h + weekly，裸名会撞车
（卡片按名渲染，重名即不可区分）。改为 `${groupDisplayName} · ${windowLabel}`，
group 名用服务端原文不映射（不发明映射就是诚实）。fixture 必须覆盖"两组同窗口"
且断言四名互异——这是本偏离的冻结测试。

### D8 · 403 三种 reason 分开（免费档矛盾的直接处理）

二手来源对免费档互相矛盾（403 `SUBSCRIPTION_REQUIRED` vs 可用）。三种 reason
各给独立文案 + 独立 fixture，就是把"矛盾"翻译成"分支覆盖"：
将来真机验证出免费档可用，删一条分支即可，结构不用动。

### D9 · base URL 回退只在抛错时触发

401/403/429 是凭据/权限/限流问题，换 host 不解决，还多打请求。只有 `ctx.request`
抛错（DNS/超时/连接拒绝）才换下一个 host。顺序 daily → daily.sandbox → cloudcode-pa。
⚠ 回退是"换 host 重发**同一个**请求"，不是"换端点"——端点名不变，断言盯 URL 全串。

### D10 · 测试注入缝：三个 env 变量

```ts
export function antigravityTokenFile(): string {
  return process.env.ANTIGRAVITY_TOKEN_FILE
    ?? join(homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
}
// Keychain：process.env.ANTIGRAVITY_KEYCHAIN 存在时直接用其值（JSON 字符串）代替 execFile。
// HOME 重定向覆盖 ~/.gemini 默认路径（Gemini V 段先例）。
```

`ANTIGRAVITY_KEYCHAIN` 是"测试替身"，不是"第二凭据源"——实现注释写清，
防止后来人把它当正式功能宣传。`security` execFile 走 `child_process.execFile`
（不走 shell，无注入面）；非 darwin 直接跳过（不尝试不报错）。

## Contracts

### antigravity.ts 凭据发现（导出以便测试）

```ts
export function antigravityTokenFile(): string
export function readAntigravityToken(): { token: string; source: 'keychain' | 'file' } | null
export function parseQuotaSummary(body: unknown): ProviderWindow[] | null   // 纯函数，plan-utils 模式
```

`source` 进 `detail`（与 `credentialSource: 'file'` 的设置页文案一致）。
手动粘贴走 `ctx.getKey`，优先级最低（Q5）。

### 窗口组装

```ts
{ name: `${group} · ${windowLabel}`, used: 0, limit: undefined（字段省略）,
  unit: 'percent', percent: Math.round((1 - frac) * 100 * 10) / 10,
  resetAt,                       // resetTime 非法 → undefined → 字段整个省略
  note: bucket.displayName }
```

## Validation & Error Matrix

| 条件 | 行为 | 文案要点 |
|---|---|---|
| 三源全空 | `noDataSnap` | 点名入口：在 Antigravity 或 agy 中登录一次 |
| 任一业务端点 401 | `errSnap` | 凭据失效：在 Antigravity 中重新登录（**不提刷新**，v1 不做刷新） |
| 403 + `SUBSCRIPTION_REQUIRED` | `errSnap` | 当前账号无有效订阅（免费档可能不提供额度接口） |
| 403 + `VALIDATION_REQUIRED` | `errSnap` | 账号需完成 Google 验证 |
| 403 其他 | `errSnap` | 透传 reason 字段，不自己编 |
| 429 | `errSnap` | 配额接口限流；`Retry-After` 有值时进 detail |
| `loadCodeAssist` 200 但 project 空 | `errSnap` | 未取到配额归属项目，不报数字（且只发了一个请求） |
| 200 但 groups 缺失/全灭 | `errSnap` | `响应格式未识别：<160 字符预览>` |
| `ctx.request` 抛错 | 换 host 重试；三 host 全灭 → `errSnap('请求失败: <message>')` | scheduler 同时置 offline |
| 成功 | `officialSnap` | `source: 'Antigravity 接口'`、`dataQuality: 'official'` |

## Good / Base / Bad Cases

- **Good**：Pro 账号，`loadCodeAssist` 返回 project + `paidTier: pro`，
  quota 返回 2 组 × 2 窗口 → 4 个组名前缀窗口，plan `Pro`。
- **Base**：用户没装 Antigravity → `nodata`，detail 点名登录入口。
  **这是预期路径，不是 bug。**
- **Bad**：project 为空仍发 quota 请求 → 服务端回全 100% → 用户看到满格假额度。
  守卫是 AC11（请求序列长度为 1）+ D6。

## Tests Required

1. **X 段**（插在 W 段恢复块之后、汇总行之前）：prd.md 的 AC5–AC25。
2. **共享文件只追加**：既有 A~W 段与汇总行一行未改；N7 与 T 段不动。
3. **静态守卫**（每条都要**前置断言**，否则负向断言空洞通过）：
   - `antigravity.ts` 用 `method: 'POST'`（改回 GET 必须红）
   - quota 请求 body 含 `project`（删掉必须红）
   - 未调用 `setKey`、未 import `setKey`（锁住不刷新不回写；**守卫精确到写操作**，
     `security` 只读 exec 不在 ban 范围——ban 错会逼后来人绕开守卫）
   - `PROTOCOLS.antigravity === undefined`（锁住不走声明表）
   - 无 AGPL 字面量：`client_id` 的 `1071006060591` 与 `GOCSPX-` 在 `antigravity.ts` 零出现
4. **两个必做反验**：GET 必须红；删掉 `project` 必须红。

## Wrong vs Correct

#### Wrong
`fetchAvailableModels` 拿来当回退"至少有个 5h 数字"：

- 它只有 5h 没有 weekly，per-model 还要自己合并——oh-my-pi#9940 修的正是
  "weekly 被吞"和"5h 被误分类为 Daily"两个 bug，**抄回退等于把修掉的 bug 抄回来**。
- external-api-integration.md Step 4：口径不同不得近似。

#### Correct
quota 全灭 → `errSnap`。没数字就是没数字，宁可明确报错，不给口径不全的数字。

## Out of Scope

- IDE SQLite 凭据路径（Q3 A；Keychain + token 文件 + 手动已覆盖；node:sqlite 先例虽有，
  但新平台路径矩阵 + protobuf key 是另一份工作量，v2 再议）
- 本机语言服务器 `GetUserStatus`（代价与收益完全不成比例；CodexBar 的文档是"为什么不走"的证据）
- `fetchAvailableModels` 回退（上 loadedWrongVsCorrect）
- token 刷新 + client_id/secret 内嵌（Q2 A；AGPL 字面量不进仓库是硬线）
- 本机对话库 token 估算（另一口径；要做也是另开窗口，绝不混进官方百分比窗口）
- `CURSOR_ACCESS_TOKEN` 式环境变量（scanner 共享文件，合并阶段统一安排——与 Cursor 同一处理）
- `baseUrl:antigravity` 的 extras 覆盖（v1 不需要可替换地址）
