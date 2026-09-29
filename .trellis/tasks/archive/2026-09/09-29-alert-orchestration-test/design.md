# Design: alertOrchestrate 纯函数边界

## 边界

```
App.tsx  evaluateAlerts()
   │  组装 AlertContext（读 alertCtxRef.current + Date.now()）
   ▼
alertOrchestrate.ts  evaluate(ctx) → Decision | null     ← 纯函数，本任务核心
   │  1. checkTriggers(ctx.snapshots, ctx.history, ...)  ← 传入的是**上一轮** history
   │  2. 记历史：appendPoint 累加，产出 nextHistory
   │  3. 分级过滤：collapsed ? 全部 : 仅 urgent
   │  4. 锁存：freshHits(speakable, ctx.latched) → 产出 nextLatched
   │  5. 合并：mergeHits(fresh, ctx.format, { hideBalance }) → text
   ▼
App.tsx  副作用：persistHistory(nextHistory) + speakOut(text, urgent)
```

## 契约

```ts
export interface AlertContext {
  snapshots: ProviderSnapshot[]
  /** 上一轮的采样。本轮采样不得提前入参 —— 否则相邻两次之差恒为 0（历史 bug #1） */
  history: HistoryPoint[]
  config: TriggerConfig
  triggerOn: Record<TriggerKind, boolean>
  format: 'simple' | 'detailed'
  hideBalance: boolean
  muted: string[]
  collapsed: boolean
  /** 已播过的键集合（上升沿锁存，AC9） */
  latched: Iterable<string>
  historyCap: number
  now: number
}

export interface Decision {
  text: string
  urgent: boolean
  nextHistory: HistoryPoint[]
  nextLatched: Set<string>
}

export function evaluate(ctx: AlertContext): Decision | null
```

`null` 表示本轮不播。纯函数**不得**读 `Date.now()`（`now` 由调用方传入）、不得调 `setExtras`、不得读 ref。

## 为什么这么切

| 约束 | 纯函数如何满足 |
|------|---------------|
| `state-management.md` 定时器契约 | `App.tsx` 保留 ref 镜像；纯函数只接收快照，不闭包捕获实时值 |
| `state-management.md` 无自定义 hook | 抽纯函数模块正是项目既有答案（hook-guidelines 明示） |
| 缺失值纪律（`type-safety.md`） | `history` 的 `balance`/`percent` 保持 `null`，纯函数内不做 `?? 0` |
| 覆盖键一致性 | 纯函数内部不做键名转换，读写都用 `THRESHOLD_FIELD`（历史 bug #3） |

## 锁存与分级的交互（历史 bug 区域的加固）

`nextLatched` 只能来自**实际进入播报判定的那批**：

```ts
const speakable = ctx.collapsed ? hits : hits.filter((h) => h.level === 'urgent')
const fresh = freshHits(speakable, ctx.latched)
const nextLatched = new Set(latchKeys(speakable))   // 注意：speakable 而非 hits
```

若用 `hits`，展开面板时被 AC15 挡下的例行项也会被记成「播过了」，等用户收起面板就永远听不到。

## 与 AC7 的接口

`Decision` 不预留 `pending` 字段 —— AC7 任务的确认状态机应在纯函数内新增独立的纯函数（如 `shouldRepeat(pending, now, confirmed)`），而不是给本接口塞可空字段。当前 `evaluate` 的返回值形状保持稳定，便于 AC7 以「新增纯函数 + 扩展 evaluate 的输入」方式叠加。

## 取舍

- **不做**：把 `speakOut` / `persistHistory` 注入纯函数。会引入副作用且让测试需要 mock，得不偿失
- **不做**：引入 vitest + RTL。仓库无 React 测试设施；本任务目标是「能测到那 6 步编排」，纯函数边界已足够
- **代价**：`App.tsx` 仍无法整体测试，只测编排层。这是有意的范围限定，AC8（行为不变）靠抽离前后测试均绿来保证
