# Design: P0-1 额度阈值提醒与系统通知

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    VoiceReminderSection.tsx               │
│  系统通知分区：总开关 + pctWarn/pctHigh/resetSoonHours      │
└───────────────────────┬─────────────────────────────────┘
                        │ ui:notifyConfig (extras JSON)
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                    App.tsx                                 │
│  evaluateAlerts：evaluate(ctx) → Decision{text, notify, …} │
│  若 d.notify 非空 → window.api.notifyShow(payload)          │
└───────────┬──────────────────────────────┬────────────────┘
            │ 快照/历史/锁存                │ IPC notify:show
            ▼                               ▼
┌──────────────────────────────┐   ┌──────────────────────────┐
│  alertOrchestrate.ts         │   │  main/ipc.ts            │
│  · AlertContext 增 notifyConfig│   │  ipcMain.handle(       │
│    + notifyLatched             │   │    'notify:show', …)   │
│  · Decision 增 notify /          │   │  new Notification({  │
│    nextNotifyLatched           │   │    title, body }).show()│
└───────────────┬──────────────┘   └──────────────────────────┘
                 │ 纯函数
                 ▼
┌──────────────────────────────────────────────┐
│  systemNotify.ts (new, 纯函数)               │
│  · NotifyConfig / DEFAULT_NOTIFY_CONFIG       │
│  · checkNotify(snapshot, cfg, now)            │
│  · freshNotifies / notifyLatchKeys（去重锁存） │
│  · buildNotifyBody（含数据来源标注）           │
└──────────────────────────────────────────────┘
```

## Technical Decisions

### D1 · 系统通知是**独立于 TTS 的第二输出通道**，不修改现有播报引擎

现有 `smartBroadcast.ts` 的 `checkTriggers` 服务于 TTS 播报（默认 `exhaustionPct=90`）。P0-1 的默认阈值是 `>80% 提醒、>95% 强提醒、重置前 1h 提醒`，与 TTS 阈值不同。

**决策**：新增纯函数模块 `systemNotify.ts`，用**独立的阈值配置**判定「要不要弹系统通知」；不改动 `checkTriggers` 的语义与默认值，避免 TTS 行为变化吓到老用户。

理由：
- 语音播报与系统通知是两种通知渠道，用户可能只想开其中一个；
- 阈值分开配置，`>80% 通知 / >90% 语音`可以共存，互不覆盖；
- 新增模块是纯函数，能被 `scripts/test-system-notify.mjs` 用 `loadTs` 直接测（沿用 quality-guidelines 的「测试加载真源码」约定）。

### D2 · 通知判定复用 `alertOrchestrate.evaluate` 这一条时间线

通知**不能**在 App.tsx 里另起炉灶单独跑一遍快照循环——那样会重复实现「判定时序、锁存、条件解除」三套逻辑（history bug #1/#2 的教训）。

**决策**：在 `alertOrchestrate.ts` 的 `AlertContext` 增加 `notifyConfig` 与 `notifyLatched`，在 `Decision` 增加 `notify` / `nextNotifyLatched`。`evaluate` 在现有 TTS 编排之后跑一次 `checkNotify` 循环：
- 通知只在**新命中**时发（`notify` 非空仅当本轮有新鲜通知事件）；TTS 的「到期重复」不重复弹系统通知——通知栏不是聊天框，重复轰炸会招致系统级静音。
- 通知与 TTS 共用同一份 `snapshots` 与历史时序，但使用**独立的锁存集合** `notifyLatched`（键前缀 `notify:`），互不干扰。

### D3 · 通知键与去重

沿用 `smartBroadcast` 的「上升沿锁存」模式：
- 键 = `notify:<providerId>:<level>`（如 `notify:inst:opencode:high`）；
- 条件持续成立期间只弹一次；用量回落后键从锁存集合消失，再次越过阈值会重新弹（与 AC5「充值后再花光能再提醒」一致）。

`freshNotifies(notifies, latched)` / `notifyLatchKeys(notifies)` 与 `freshHits` / `latchKeys` 同构，但独立实现，避免改坏现有 TTS 锁存。

### D4 · 数据诚实：cached / local 必须带标注

复用 `shared/quality.ts` 的 `staleLabel(s)`（`'缓存'` / `'本机'`）：
- 通知 body 统一追加来源标注：`官方数据` / `缓存数据` / `本机估算`；cached/local 时前缀 `⚠`。
- 与卡片徽章、托盘 `⚠`、TTS 文案同一口径（`staleLabel` 是唯一来源，不在新模块里写第二份字符串）。

### D5 · IPC 契约与信任边界

- 渲染层通过 `window.api.notifyShow(payload)` → `ipcRenderer.invoke('notify:show', payload)` 发到主进程。
- 主进程 `ipcMain.handle('notify:show', …)` 用 Electron `Notification` 弹出（macOS Notification Center / Windows Toast）。
- 主进程**必须重新校验** payload 形状（title/body 为非空字符串、level ∈ {'warn','high','reset'}、name/id 为字符串）——渲染层是受信边界之外（type-safety 与 state-management 的读取处校验纪律）。

### D6 · extras 键表（全部 `ui:` 前缀，避免触发全量重采集）

| 键 | 类型 | 默认 |
|---|---|---|
| `ui:notifyOn` | `'1' \| '0'`（总开关） | `'1'`（开） |
| `ui:notifyConfig` | JSON 字符串 `{pctWarn, pctHigh, resetSoonHours}` | `{"pctWarn":80,"pctHigh":95,"resetSoonHours":1}` |

读取处重新校验（state-management 纪律）：`pctWarn/pctHigh/resetSoonHours` 必须是有限正数，且 `pctHigh > pctWarn`，否则回退默认值并**不触发**（沿用 `positive()` 的「脏值落向不触发」约定）。

### D7 · 设置页归属

系统通知配置放在 `VoiceReminderSection.tsx` 内新增「系统通知」分组（与语音播报同一视觉分区，因为都是「提醒」语义）。class 命名沿用 `vrs-` 前缀（`vrs-notify-on` / `vrs-notify-warn` / `vrs-notify-high` / `vrs-notify-reset`），给 `--uitest` 做定位钩子。

## Contracts

### systemNotify.ts 导出

```ts
export interface NotifyConfig {
  pctWarn: number        // 用量率 > 它就提醒（默认 80）
  pctHigh: number        // 用量率 > 它就强提醒（默认 95）
  resetSoonHours: number // 距重置 < 它就提醒「即将重置」（默认 1）
}
export const DEFAULT_NOTIFY_CONFIG: NotifyConfig = { pctWarn: 80, pctHigh: 95, resetSoonHours: 1 }

export interface NotifyPayload {
  id: string
  name: string
  title: string
  body: string
  level: 'warn' | 'high' | 'reset'
}

export function checkNotify(
  snapshots: ProviderSnapshot[],
  cfg: NotifyConfig,
  now: number
): NotifyPayload[]          // 每轮可命中多条（每个供应商最多一条，取最严重）
export function freshNotifies(payloads: NotifyPayload[], latched: Iterable<string>): NotifyPayload[]
export function notifyLatchKeys(payloads: NotifyPayload[]): string[]
export function buildNotifyBody(s: ProviderSnapshot, level: 'warn'|'high'|'reset'): string
export function resolveNotifyConfig(raw: Partial<NotifyConfig>): NotifyConfig  // 读取处校验
```

### IPC payload

```ts
interface NotifyIpcPayload {
  id: string
  name: string
  title: string
  body: string
  level: 'warn' | 'high' | 'reset'
}
// preload: notifyShow(payload: NotifyIpcPayload): Promise<void>
// main: ipcMain.handle('notify:show', (_e, payload) => …)
```

## Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| `status !== 'ok'` 或无窗口 | 不通知（没有可信数据，不拿旧闻当新闻） |
| `pct <= pctWarn` | 不通知 |
| `pctWarn < pct <= pctHigh` | `level: 'warn'`，title `「{name} 用量提醒」` |
| `pct > pctHigh` | `level: 'high'`，title `「{name} 用量告警」` |
| `pctHigh <= pctWarn`（脏配置） | 回退默认值；仍不触发（`resolveNotifyConfig` 钳制） |
| `resetAt` 存在且 `resetAt - now < resetSoonHours * 3600_000` | `level: 'reset'`，title `「{name} 即将重置」`（套餐窗口） |
| cached / local | body 追加 `⚠ 缓存数据` / `⚠ 本机估算`（`staleLabel`） |
| 同一 `id + level` 已锁存且条件未解除 | 不弹（去重） |
| 条件解除后再次越过 | 重新弹（锁存键消失） |

## Good / Base / Bad Cases

- Good：`pct=97 > pctHigh=95` → `{level:'high', body:'本月额度已用 97% · 官方数据'}`，弹一次；用量回落后再涨到 97 → 再弹。
- Base：`pct=85`，`pctWarn=80`、`pctHigh=95` → `{level:'warn', body:'本月额度已用 85% · 官方数据'}`。
- Bad：`pct=85` 但数据是 cached → body 必须带 `⚠ 缓存数据`；不带标注直接弹 = 违反数据诚实（等同于卡片不标缓存）。

## Tests Required

新增 `scripts/test-system-notify.mjs`（`loadTs` 加载 `systemNotify.ts`）：
1. 阈值边界：`<= pctWarn` 不触发、`(warn, high]` 为 warn、`> high` 为 high
2. `resetAt` 在 `resetSoonHours` 内 → reset；不在 → 不触发；无 `resetAt` → 不触发
3. 非 ok / 无窗口 → 不触发
4. cached / local → body 含 `缓存` / `本机` 标注
5. 脏配置（NaN / 负数 / `pctHigh <= pctWarn`）→ 回退默认且不触发
6. 去重：首次命中返回、已锁存不返回、条件解除后再返回
7. 多供应商每轮最多各一条（取最严重 level）

扩展 `scripts/test-alert-orchestration.mjs`：
8. `Decision.notify` 在新命中时非空、在重复/无命中时为 null
9. `nextNotifyLatched` 只含本轮实际进入通知判定的键

UI 走查：`npm run shots` 或 `electron . --uitest` 覆盖设置页「系统通知」分组的开关与阈值输入（`vrs-notify-*` 定位钩子）。

## Wrong vs Correct

#### Wrong
在 App.tsx 里另写一个 `setInterval` 轮询快照判阈值弹通知：
- 重复实现判定时序/锁存/条件解除三套逻辑；
- 与 TTS 各跑各的时间线，同一状态会被念一遍又弹一遍；
- 纯逻辑无法被 loadTs 测试覆盖。

#### Correct
把通知判定作为**纯函数**放进 `systemNotify.ts`，由 `alertOrchestrate.evaluate` 统一编排：
- 与 TTS 共享同一份快照与历史时序；
- 独立锁存、独立开关、独立阈值；
- 全部判定可被 `test-system-notify.mjs` / `test-alert-orchestration.mjs` 直接覆盖。