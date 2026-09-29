# Design: AC7 重复提醒直到确认

## 状态机

```
条件成立（未锁存）
   │  evaluate → text 非空
   ▼
首次播报 ── 记录批次 firstSpokenAt = lastSpokenAt = now，进入 pending
   │
   │  未确认 且 now ≥ lastSpokenAt + 5min
   ▼
重复播报 ── lastSpokenAt = now（同一条文案，不重算）
   │
   │  …最多 3 次…
   │
   ├── 用户点「知道了」 → confirmedAt = now → 移出 pending（条件仍成立也不再播）
   └── now ≥ firstSpokenAt + 15min → 自动确认 → 移出 pending
   │
   ▼
条件解除（键不在本轮命中里）→ 移出 pending **且** 移出 latched → 下次越过阈值可再播
```

## 核心数据结构

```ts
/** 一条待确认的播报批次 */
export interface PendingAlert {
  /** 这一批涉及的命中键；条件解除的判据 */
  keys: string[]
  text: string
  urgent: boolean
  /** 首次播报时刻（自动确认窗口从它起算，不是从最后一次重复起算） */
  firstSpokenAt: number
  lastSpokenAt: number
  confirmedAt: number | null
}

export const REPEAT_MS = 5 * 60_000        // 重复间隔
export const AUTO_CONFIRM_MS = 15 * 60_000 // 自动确认窗口 = 3 个重复周期
```

`confirmedAt` 保留在批次里而不是直接删除，是为了 `App.tsx` 能显示倒计时剩余秒数；确认后即从
`pending` 数组移除，所以「不再播」是结构性保证而非运行时判断。

## 纯函数边界（沿用 `alertOrchestrate.ts`）

```ts
export interface AlertContext {
  /* ...已有字段... */
  pending: PendingAlert[]        // 新增
}

export interface Decision {
  /* ...已有字段... */
  nextPending: PendingAlert[]    // 新增
  /** 本次播报是「新命中」还是「到期重复」——UI 决定要不要显示确认条 */
  reason: 'new' | 'repeat' | null
}

export function evaluate(ctx: AlertContext): Decision | null
export function confirm(pending: PendingAlert[], now: number): PendingAlert[]
export function pendingCountdown(b: PendingAlert, now: number): number   // 剩余秒数，给 UI
```

`REPEAT_MS` / `AUTO_CONFIRM_MS` 是导出常量，**不进 ctx**。测试用 `now: T0 + REPEAT_MS`
构造时间轴即可，不必注入口。

## 播报优先级

一轮里可能同时有「新命中」和「到期重复」。**新命中优先**（FR8：出现新内容立刻播），
且新命中会重置待确认计时 —— 用户此刻正需要知道最新情况，旧批次的重复没有意义。

```
const fresh = freshHits(speakable, ctx.latched)
if (fresh.length > 0)          → 播 fresh 合并文本，开新批次
else if (有批次到期)            → 播该批次的 text（复用，不重算）
else                            → text = null
```

同一轮只播**一条**（AC12），不排队。

## pending 的裁剪

每轮结束前对 `pending` 做三件事：

1. **条件解除的丢弃** —— 键不在本轮 `speakable` 里 → 移除（FR6）
2. **超窗自动确认** —— `now - firstSpokenAt ≥ AUTO_CONFIRM_MS` → 移除
3. **已确认的移除** —— `confirm()` 已标记且已被 UI 消费过 → 移除

第 1 条是解锁的前提：充值后余额恢复，该键从 `speakable` 消失，批次被丢，键也随之从
`nextLatched` 消失，下次再越过阈值就是新一轮「新的命中」。

## UI：确认条不能放进泡泡

`PetBall.tsx:856` 的泡泡是 `aria-hidden="true"` 的纯装饰：

```tsx
<div className="petball-bubble" aria-hidden="true">{notice || bubble}</div>
```

把 `<button>` 塞进 `aria-hidden` 容器 = 交互元素对辅助技术不可见，是无障碍缺陷；
顺带 `aria-hidden` 容器内的可聚焦元素会破坏「隐藏内容不可聚焦」的规则。

**方案**：确认条是泡泡的**兄弟节点**，带 `role="status"`（播报内容）内含真实 `<button>`，
点击区域不小于 24×24。不新增浮层（NFR3），只是泡泡下方多一条小控件。

倒计时用 `pendingCountdown()` 的返回值显示剩余秒数，视觉上让「它会自己停」可预期。

## 定时器

沿用**自重排 `setTimeout` 链**，不新增独立定时器（NFR2）：

```ts
const armAlertTimer = (): void => {
  if (!ttsOn) return
  alertTimerRef.current = window.setTimeout(() => {
    evaluateAlerts()          // 顺带处理到期重复
    armAlertTimer()
  }, ALERT_TICK_MS)           // 30s 轮询
}
```

轮询 30s 而非精确 5 分钟：重复间隔是「至少间隔」，早几秒无所谓；精确调度反而在
系统休眠唤醒后要处理补偿。`backgroundThrottling: false` 已关（见 `overlay.ts`），
后台不会被压到最低频率。

依赖数组只含 `[ttsOn]` —— 其余全走 `alertCtxRef` 镜像（`state-management.md` 定时器契约）。

## 取舍

- **不做**：逐条确认（用户要点 N 次）。一次确认整批，简单且不会漏
- **不做**：把重复播报塞进 `speechOut` 队列。队列语义是「串行播放」，
  这里是「按时间重新播」，两回事，混在一起会让频率闸门的记账变模糊
- **代价**：`evaluate` 的输入多一个 `pending` 字段，所有既有断言的 ctx 要补它。
  这是显式成本，好过把状态藏在 ref 里
- **代价**：30s 轮询在应用开着时每分钟跑一次 `evaluate`（纯函数 + `appendPoint`，
  上限 100 条）—— 开销可忽略，换来的是休眠唤醒后自动恢复
