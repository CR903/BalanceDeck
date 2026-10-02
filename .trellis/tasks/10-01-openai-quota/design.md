# Design: OpenAI 额度（`codex.ts` 数据源升级）

## Architecture

```
┌─ 凭据三源（只读，全部 ENOENT 安全）───────────────────────────────────┐
│                                                                        │
│  ① $CODEX_HOME/auth.json ──► tokens.access_token + tokens.account_id  │
│  ② CODEX_ACCESS_TOKEN env ──► token（account_id 无）                   │
│  ③ ctx.getKey(instanceId) ──► token + getExtra('accountId:codex')      │
│     （items 加密，优先级最低；account_id 非凭据可明文，冒号惯例）          │
│                                                                        │
│  ❌ 不写回 auth.json ❌ 不新增回传 token 的 IPC                            │
└────────────────────────────────────────────────────────────────────────┘
                                    ↓ 有 token？
                    ┌───────────────┴───────────────┐
                   有                              无
                    ↓                               ↓
┌─ wham/usage（GET，readJson）──────────────────┐  ┌─ 现有 jsonl 逻辑 ──┐
│ 200 + 可识别 → wham 窗口（official）直接返回    │  │ 逐字不变          │
│ 401 → errSnap（codex login），不回退           │  │ rate_limits →     │
│ 其他失败 → 右侧 jsonl 逻辑                     │  │   official；      │
└──────────────────────────────────────────────┘  │ deltas → local；  │
                                                  │ 空 → nodata/err   │
                                                  └──────────────────┘
```

## Technical Decisions

### D1 · 方案 A：在 `codex.ts` 内升级，不新增文件

`wham/usage` 的 `primary/secondary_window` 与 jsonl 的 `rate_limits.primary/secondary`
是**同一份服务端真值**（只是主动查 vs 等快照）。另起卡片 = 两张卡同一份额度，
违反 external-api-integration Step 5「口径要跟着数据走」。代价是改已有内置适配器——
用 Y 段把"今天的行为"先冻结，再加新行为，改坏立刻红。

### D2 · 优先级链：wham 成功升级，其他失败等于今天（唯 401 例外）

```ts
creds = resolveCreds()
if (creds) {
  r = await tryWham(creds)          // 200 → 窗口直接返回；401 → errSnap 直接返回
  if (r.ok) return r.snap           // 其他失败 → r.ok=false，往下走
}
// ↓↓↓ 以下为现有 jsonl 逻辑，一字不改（函数照旧调用） ↓↓↓
…listRollouts / parseFile / buildServerWindows / buildLocalWindows…
```

- **401 不回退的理由**：凭据已死是确定性信号，不是瞬时故障。回退会拿旧快照
  冒充 live 真值，且用户永远收不到"去跑 `codex login`"的可操作信息。
  这是本任务唯一"比今天更严格"的地方，AC6 用"有 sessions 仍报错"锁死。
- 其他失败回退的理由：429/404/抛错/形状漂移都是"端点侧问题"，jsonl 转录不受影响；
  回退 = 今天的行为，零回归。漂移韧性白得：端点改版炸掉的只是升级项，不是基本盘。

### D3 · 窗口名按秒数映射（research V5 的落地）

```ts
function whamWindowName(limitSecs: number): string {
  if (limitSecs === 18000) return '5 小时'
  if (limitSecs === 604800) return '本周'
  if (Number.isInteger(limitSecs / 3600)) return `${limitSecs / 3600} 小时`
  if (Number.isInteger(limitSecs / 86400)) return `${limitSecs / 86400} 天`
  return `${limitSecs} 秒窗口`
}
```

已知值保持与现有卡片一字不差（用户无感）；未知值算术推导，不报错不丢弃。
`'5 小时'` 与现有 jsonl 窗口**同名**——故意的：同一口径就该同名，UI 按实例聚合不叠卡。

### D4 · `plan` 保持 `'ChatGPT 订阅'`，不映射 tier 名

`codex.ts:253` 已有 `plan: 'ChatGPT 订阅'`。`plan_type` 的 plus/pro/team 中文名是
官方 marketing 名，没有仓库内的既定译法，发明翻译 = 制造第二套叫法。
保持一字不差，AC19 锁死各种 `plan_type` 下 plan 不变。

### D5 · `used` 回填只复用，不重写

wham 窗口的 `used` 先置 0；若 sessions 可读，用现有 `sumSince` +
`reset_at - limit_window_seconds` 起点回填（与现有 `resetAt - 5h` 同式，
只是窗口长度从变量来）。无 sessions → 0（网页版用户的新增量：今天他们是 nodata，
连 0 都看不到——0 在这里是"有额度无本地量"，注释写清）。

### D6 · 凭据解析宽容，缺字段不崩

- `auth.json` JSON 坏 / 无 `tokens` / 无 `access_token` → 当"无 token"走下一源
  （R5 低风险：结构变化不断头，只降级来源）。
- `account_id` 缺失 → 省略该头照发（单 workspace 降级，AC13 覆盖）。
- `getKey` 返回空串 → 当无 token（空串 Bearer 是无效请求，不如不用）。

### D7 · 未知字段忽略（对调研的有意偏离，理由公开）

调研 05/06 要求解析器返回未知字段列表（`unknownMeters` 模式）。但：
1. `console.warn` 在 `src/main/adapters/*` **零先例**，新开日志口无处可查；
2. 快照 `detail` 塞字段名 = 把内部漂移暴露给用户看，不符合 detail 的用户语言定位；
3. **漂移韧性已由 jsonl 回退承担**：wham 形状大改 → 认不出 → 回退 jsonl → 功能不炸。
   小改（多几个未知键）→ 已知窗口照出，未知键忽略 → 界面不少东西。

结论：额外键忽略，`secondary_window: null` 与缺 `used_percent` 按 R4 处理。
偏离已记录，将来若要补"改版信号灯"，另开任务做（需要先有日志/信号基建）。

### D8 · headers 精确到三个，不多不少

```ts
{ Authorization: `Bearer ${token}`,
  ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
  Accept: 'application/json' }
```

- `Accept` 是仓库惯例（`protocol-adapter.ts:71` 统一带）。
- 不带 `Content-Type`（GET 无 body，带了反而怪）。
- 不伪装 UA，不带 Cookie（Q3 重答的结论；AC2 用富投影锁死头集合——**多一个少一个都红**）。

## Contracts

### codex.ts 新增（导出以便测试，照 `codexHome()` 先例）

```ts
export function codexAuthFile(): string   // $CODEX_HOME/auth.json（认 CODEX_HOME，与 codexHome() 同根）
export interface CodexCreds { token: string; accountId: string | null; source: 'file' | 'env' | 'manual' }
export function readCodexCreds(getKey, getExtra): Promise<CodexCreds | null>
```

`source` 进 `detail` 调试？不——detail 保持现有语义（仅本地估算分支有 detail）。
source 只用于内部排序，不进快照（快照里加来源会改现有形状，违背"今天什么样还什么样"）。

### wham 常量（模块顶层，单一来源）

```ts
const WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage'
```

### 窗口组装（与 `buildServerWindows` 同形）

```ts
{ name: whamWindowName(limit_window_seconds), used, unit: 'token',
  percent: used_percent, resetAt: new Date(reset_at * 1000).toISOString(),
  note: '服务端真值' }
```

## Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| 有 token + wham 200 + 双窗口可识别 | wham 窗口（official），直接返回 |
| 有 token + wham 200 + 仅 primary 可识别 | 单窗口 +（secondary 缺席不报错，沿 research V4） |
| 有 token + wham 401 | `errSnap`「请运行 `codex login`」，**不回退**（AC6） |
| 有 token + wham 403/429/404/抛错/形状认不出 | 静默走现有 jsonl 逻辑（AC7/AC8/AC9） |
| 无 token | 现有 jsonl 逻辑逐字不变（AC10/AC11） |
| 手动/env token | 同"有 token"三行（AC12/AC13） |
| 成功 | `officialSnap`；失败 `dataQuality === undefined`（现有铸造器已保证） |

## Good / Base / Bad Cases

- **Good**：装了 Codex CLI 且登录过，sessions 也有 → wham live 双窗口 + used 回填，
  与今天同名同形，只是数字更新、plan 不变。
- **Base**：只用网页版（无 `~/.codex/sessions`，有 auth.json）→ 今天 nodata，
  升级后 wham 双窗口 `used: 0`。**这是新增量，不是回归。**
- **Bad**：token 过期 → 不回退旧快照，直接 errSnap 报 `codex login`。
  旧快照冒充 live 真值才是撒谎，可见的错误好过陈旧的正确。

## Tests Required

1. **Y 段**（插在 X 段恢复块之后、汇总行之前）：prd.md 的 AC1–AC20。
2. **共享文件只追加**：既有 A~X 段与汇总行一行未改；N7 与 T 段不动。
3. **冻结"今天"**：AC10/AC11 用无 auth 的 fixture 把现有 jsonl 行为逐字锁死——
   这是方案 A 的安全带，wham 逻辑以后再改也不能悄悄动旧行为。
4. **静态守卫**（每条都要**前置断言**）：
   - `codex.ts` 无裸 `fetch(`（出网走 `readJson`，可注入）
   - `codex.ts` 无 `writeFile`（不碰 auth.json）
   - 快照 `JSON.stringify` 不含 token/account_id（AC14，行为级）
   - `setKey` 从未被调用（AC15，用 onSetKey 计数）
   - `protocols.ts` 零 diff（AC21，连带 N7）
5. **两个必做反验**：删 Account-Id 头必须红；跳过 wham 必须红。

## Wrong vs Correct

#### Wrong
wham 失败（401 除外）直接 errSnap：

- 端点是未公开接口，429/404/改版都是**预期内**事件；一失败就整卡变红，
  等于把"升级项"的脆弱性传染给"基本盘"。
- 今天没 auth 的用户好好的，升级后反而动不动红——这是回归，不是升级。

#### Correct
wham 是"有则更好"的升级层：成功则新快照，失败则今天的行为。
唯一的例外是 401——凭据已死，回退即撒谎，必须可见。

## Out of Scope

- `openai-billing`（Q6 A；API 计费与订阅是两套产品，kind/host/凭据全不同，合并不了也动不得）
- `rate-limit-reset-credits`（明确 429 记录）、`monthly-usage`（普通账号 404）、
  `/backend-api/codex/usage`（未验证）、`additional_rate_limits` 明细
- 多 Codex home（Q3 A；`shared/types.ts` 不加字段）
- 显式读取开关（Q2 A；与三家预设语义一致，文案说清即可）
- cookie 路径（Q3 重答：主路径可完全避开；将来要做按 `opencode-auth.ts` 模板另开任务）
- `app-server` JSON-RPC 兜底（拉子进程 + 熔断逻辑，v1 不值）
- 未知字段信号灯（D7；等日志/信号基建另开任务）
