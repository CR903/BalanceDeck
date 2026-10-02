# Design: Cursor 适配器

## Architecture

```
┌─ 凭据（三源级联，只读，ENOENT 安全）──────────────────────────────────┐
│                                                                        │
│  ① state.vscdb ── node:sqlite 只读 SELECT ──► cursorAuth/accessToken  │
│     macOS ~/Library/.../Cursor/User/globalStorage/state.vscdb          │
│     Win   %APPDATA%/Cursor/User/globalStorage/state.vscdb              │
│     Linux $XDG_CONFIG_HOME/Cursor/User/globalStorage/state.vscdb       │
│     + 同库 cursorAuth/stripeMembershipType（套餐名，零成本）             │
│     ⚠ WAL 失败 → 不碰目录，直接回落 ②（Q7）                             │
│  ② CLI auth.json ── 多候选试探 ──► accessToken                         │
│     ~/.cursor/auth.json · $XDG_CONFIG_HOME/cursor/auth.json ·           │
│     ~/Library/Application Support/cursor/auth.json · %APPDATA%/Cursor/  │
│     + CURSOR_CONFIG_DIR / XDG_CONFIG_HOME 环境覆盖                     │
│  ③ ctx.getKey(inst.id) ── 用户手动粘贴（items 加密，优先级最低）        │
│                                                                        │
│  ❌ 不刷新 ❌ 不回写 ❌ 不缓存 ❌ 不新增回传 token 的 IPC                  │
└────────────────────────────────────────────────────────────────────────┘
                                    ↓ JWT 本地 exp 判定（过期→errSnap，不发请求）
┌─ collect(ctx)：单 POST ───────────────────────────────────────────────┐
│                                                                        │
│  POST api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage │
│    headers: Authorization: Bearer <jwt>  ← 注意：Bearer，不是 copilot 的 token 前缀
│             Content-Type: application/json   ← 适配器显式写（D8）        │
│             Connect-Protocol-Version: 1   ← 适配器自己写，接缝不管      │
│    body: '{}'   ← Connect RPC 空 message                               │
│         ↓                                                              │
│  不变量 includedSpend + remaining === limit ?                          │
│    否 → errSnap（schema drift，绝不返回 0）                             │
│    是 → 主窗口（usd，自算 percent）+ 按需预算窗口（若有）                │
└────────────────────────────────────────────────────────────────────────┘
```

## Technical Decisions

### D1 · 独立代码适配器，**不进 `protocols.ts`**

三条硬理由：POST + body 表达不了（工厂写死 GET）、`Connect-Protocol-Version: 1`
自定义头表达不了、凭据是「本机文件 → SQLite/JWT → 过期判定」级联而非单个 key。
另有产品语义理由：`SELECTABLE_PROTOCOLS` 是给用户手填 Base URL 的自定义协议用的，
Cursor 不该出现在那里。N7（`:800`）断言 8 条是额外保险。

### D2 · 直接用 `readJson` 的可选第 5 参（Gemini 已扩好）

```ts
readJson(ctx, USAGE_URL, { Authorization, 'Content-Type', 'Connect-Protocol-Version': '1' }, 12000,
  { method: 'POST', body: '{}' })
```

Gemini 任务已把参透传好并证明零影响，Cursor 是**第二个消费者**。
⚠ `engine.ts` 不许再动——参已够用，动它就是没事找事。

### D3 · `mark` 与 preset id / protocol id **三同 `'cursor'`**

Gemini 的教训现学现用：`providerMark` 只按 key 查，劈叉会让自定义实例静默退回
generic 图标（claude 的 preset `claude` / protocol `claude-code` 就是活反例）。

### D4 · headers **显式写全三项**，不依赖接缝自动补

接缝会在「有 body 且无 Content-Type」时自动补 `application/json`，生产行为一致。
但**测试桩不模拟这个行为**：`makeRichRequest` 只记录调用方传了什么。
若适配器不显写 `Content-Type`，W 段的请求形状断言就**测不到生产真实发出的头**——
断言与生产行为脱节，这是假覆盖。

→ 三个头全由适配器显式写。接缝的自动补只当兜底，不当依赖。
（Gemini 也是这么做的：`:229` form 与 `:248` JSON 都是显式头。）

### D5 · percent 只用绝对值自算，服务端 percent 字段**不进快照**

官方亲口承认三个 percent 字段 ≠ spend/limit，且出过 3 天冻结事故（64.4% 报成 3.73%）。
`percent = Math.round(includedSpend / limit * 100 * 10) / 10`（与 copilot `:145` 同精度）。

⚠ 这条必须有**方向性守卫**：反验 AC29（改成读 `totalPercentUsed` 必须红）
证明的不是「代码对」，而是「测试真在盯这个方向」。没有这条，某天有人"优化"成
直接读服务端字段，套件照绿——这是本任务最危险的静默退化。

### D6 · 不变量是 schema drift 的唯一探测器

`includedSpend + remaining === limit`（论坛两个独立样本都成立：23222+16778=40000、
1288+712=2000）。Cursor 换过一次接口形态且没发公告，**下一次改版不会通知我们**。
不变量不成立 → `errSnap('响应格式未识别…')`，绝不硬凑、绝不返回 0。

⚠ 分/美元单位是这条最容易错的地方：三个值**全是分**，比较前不换算（同单位直接加），
展示时才 `/100`。若先换算再比较，浮点会制造假 drift。

### D7 · 子池 / 团队 / 不限量：三条「不猜」纪律

- 子池只有 percent 无绝对值 → **v1 不展示**（Q4）。展示一个无法自校验的数字，
  出事时（2026-08 冻结）我们连"错了"都证明不了。
- 团队形状（无 `planUsage`）→ 明确 `errSnap`（Q5）。ai-usagebar 的"两条 DisplayMessage
  都正则成功才认"是尽力了，但**从人话里抠数字**一旦 Cursor 改文案就静默出错，
  正是 `external-api-integration.md` Step 4 要防的。
- `isUnlimited` → 无 limit 窗口（Q 照 copilot `:150-152` 不限量先例）。
  给假进度条是撒谎，不给窗口但 `ok` 会被 `applyCachePolicy` 判 degraded——
  所以是"无 limit 的 ok 窗口"，不是空 windows。

### D8 · SQLite 只读打开，WAL 失败就走（Q7）

```ts
const { DatabaseSync } = await import('node:sqlite')   // 照 opencode.ts:122 写法
db = new DatabaseSync(path, { readOnly: true })
SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'   // 只查一行，不 SELECT *
```

- `readOnly: true` 没有 immutable 语义：活跃 WAL 下可能 `SQLITE_CANTOPEN` /
  "attempt to write a readonly database" → **catch 后直接回落 `auth.json`**，
  绝不重试、绝不碰 Cursor 目录（CodexBar 的 immutable 做法在 node:sqlite 里没有对应物）。
- 值解码：先去 NUL 字节（UTF-16LE BLOB 陷阱），再 `JSON.parse` 试探，失败则当 raw 字符串。
- 两个路径都失败 → `nodata`，detail **同时列出两个路径**（排障一眼看到）。

### D9 · 测试注入缝：`CURSOR_STATE_DB` + 平台路径函数可测

```ts
export function cursorStateDb(): string {
  return process.env.CURSOR_STATE_DB
    ?? <按 process.platform 的默认路径>
}
export function cursorAuthJsonCandidates(): string[] { ... }  // 认 CURSOR_CONFIG_DIR / XDG_CONFIG_HOME
```

W 段用 `node:sqlite` 在临时目录**真实建库**（`ItemTable(key TEXT, value TEXT)` + 假 JWT），
`CURSOR_STATE_DB` 指过去。段末 try/finally 恢复 env（V 段 `:1790-1799` 的恢复块就是模板，
照抄形状）。⚠ 沿用 `stable()` 语义：`undefined` 字段不写进期望对象。

### D10 · JWT 处理：最小解码，不校验签名

只需要 `sub`（不用，仅诊断）与 `exp`（过期判定）。`Buffer.from(payload, 'base64url')` +
`JSON.parse`，失败 → 当"解不出"走 `nodata`（这是"未配置"不是"错误"）。
`exp` 是**秒**（JWT 标准），与 billingCycle 的**毫秒字符串**是两套单位——
解析器必须分别处理，混了就会把有效 token 判过期（或反之）。

## Contracts

### cursor.ts 凭据发现（导出以便测试）

```ts
export function cursorStateDb(): string
export function cursorAuthJsonCandidates(): string[]
export function readCursorToken(): { token: string; source: 'vscdb' | 'auth.json' } | null
```

`source` 进 `detail`（"本机配置自动读取（state.vscdb）"之类），与 `credentialSource: 'file'` 的
设置页文案一致。`ctx.getKey` 的手动 token 优先级最低（Q3）。

### 窗口组装

```ts
{ name: '本月套餐', used: includedSpend / 100, limit: limit / 100, unit: 'usd',
  percent: Math.round(includedSpend / limit * 100 * 10) / 10,
  resetAt: new Date(Number(billingCycleEnd)).toISOString(), note: '官方接口' }
```

## Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| 三源全空 / token 空 / JWT 解不出 | `noDataSnap`（未配置，不是错误） |
| JWT `exp` 已过 | `errSnap`「在 Cursor 中重新登录」，**请求序列为空** |
| 401/403 | `errSnap` 会话失效 |
| 429 | `errSnap` 限流文案（不含「检查网络」） |
| 其它非 200 | `errSnap('HTTP <status>')` |
| `ctx.request` 抛错 | `errSnap('请求失败: <message>')` |
| 不变量不成立 / 缺 `planUsage` / 形状认不出 | `errSnap('响应格式未识别：<160 字符预览>')` |
| 成功 | `officialSnap`，`dataQuality: 'official'` |

## Good / Base / Bad Cases

- **Good**：Pro 账号，`includedSpend 1288 / remaining 712 / limit 2000` →
  `{ used: 12.88, limit: 20, percent: 64.4 }`，plan `Pro`。
- **Base**：用户没装 Cursor → `nodata`，detail 同时列出 `state.vscdb` 与 `auth.json` 路径。
  **这是预期路径，不是 bug。**
- **Bad**：把 `totalPercentUsed: 3.73` 直接画成进度环 → 用户实际用了 64.4%。
  守卫是 AC11（快照里无服务端 percent 字段）+ AC29（改读服务端字段必须红）。

## Tests Required

1. **W 段**（插在 V 段恢复块之后、`:1800` 汇总行之前）：prd.md 的 AC5–AC24。
2. **共享文件只追加**：既有 A~V 段与汇总行一行未改；N7（`:800`）与 T 段不动。
3. **静态守卫**（每条都要**前置断言**，否则负向断言空洞通过——Gemini 的 E4/B3 教训）：
   - `cursor.ts` 用 `method: 'POST'`（改回 GET 必须红）
   - percent 来自自算（改读 `totalPercentUsed` 必须红）
   - 未调用 `setKey`（锁住不自愈）
   - `PROTOCOLS.cursor === undefined`（锁住不走声明表）
   - 快照里无 `totalPercentUsed` / `autoPercentUsed` / `apiPercentUsed` 任一键
4. **两个必做反验**：GET 必须红；读服务端 percent 必须红。

## Wrong vs Correct

#### Wrong
团队账号从两条 `*DisplayMessage` 文本里正则百分比：

- Cursor 一改文案就静默出错，而测试 fixture 锁的是旧文案——**测试会继续绿，生产已在撒谎**。
- 这正是"认不出就报错"纪律要防的：宁可明确说不支持，不给可能是错的数字。

#### Correct
无 `planUsage` → `errSnap('团队账号的用量口径暂不支持')`。等 Cursor 给团队账号
稳定字段的那天，再把这条改成解析——那时测试锁的是**字段**不是人话。

## Out of Scope

- 备选 cookie 端点 `usage-summary`（Bearer 主路径已覆盖个人计划；cookie 路径要碰
  Keychain/浏览器 DB 权限与弹窗，代价不对等）
- `GetPlanInfo` 第二请求（`stripeMembershipType` 同库零成本已够）
- `get-filtered-usage-events` 明细（403 有 6 小时冷却；不属订阅查询）
- `CURSOR_ACCESS_TOKEN` 环境变量（`scanner.ts` 共享文件，合并阶段统一安排）
- `baseUrl:cursor` 的 extras 覆盖（minimax 有先例，但 v1 不需要可替换地址）
- User-Agent 伪装（未验证是否必需；先不伪装，401/403 时再考虑，注释写清）
- 子池展示、request-based 老端点（`GET /api/usage?user=ID`，legacy）
