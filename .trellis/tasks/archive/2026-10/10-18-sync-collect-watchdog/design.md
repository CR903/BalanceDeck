# 设计：采集轮级看门狗（孩子 A）

## 1. 边界与文件清单

**要改**：

| 文件 | 改动性质 |
|---|---|
| `src/main/collect-loop.ts` | **新增**。纯逻辑（不 import electron）的调度循环 + 轮次预算 + 刷新语义。可被 `loadTs` 单测 |
| `src/main/deadline.ts` | **新增**。纯逻辑 `withDeadline`，把"永不 settle"变成"有界失败"。可被 `loadTs` 单测 |
| `src/main/scheduler.ts` | 瘦身为装配：构造 `collect` 轮体、接 `push`/`updateTray`，控制流交给 `collect-loop` |
| `src/main/request.ts` | 出网兜底超时（race + abort 双保险） |
| `src/main/ipc.ts` | `ui:refresh` 返回 `RefreshOutcome` |
| `src/preload/index.ts` / `src/renderer/src/api.d.ts` | `refreshNow` 返回类型 `Promise<RefreshOutcome>` |
| `src/renderer/src/DetailView.tsx` | 接 `scanning`，刷新按钮加 `spinning` |
| `src/renderer/src/App.tsx` | 给 `DetailView` 传 `state.scanning` |
| `src/shared/types.ts` | `AppState` 追加**可选**字段 `lastTimeoutAt?: string` |
| `scripts/test-collect-loop.mjs` / `scripts/test-deadline.mjs` | **新增**测试套件 |
| `package.json` | 注册新测试段（`test` 串） |

**不碰**：适配器实现、`shared/quality.ts` 的判定口径（除 R3 复用的 `AbortError` 归类说明）、CSS 皮肤、灵动岛、托盘协议。

## 2. 契约

### 2.1 `src/main/deadline.ts`

```ts
export type DeadlineOutcome<T> = { ok: true; value: T } | { ok: false; reason: 'timeout' }

/**
 * 给一个 promise 加时间上界。**不 reject**：调用方无需 try/catch。
 * 超时后原 promise 仍在跑（JS 无法取消），因此调用方必须丢弃它的迟到结果。
 */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<DeadlineOutcome<T>>
```

纪律：不吞异常 —— 若 `p` 在预算内 reject，本函数**原样抛出该错误**（交由既有 `catch` 路径处理），只有超时才转成 `{ ok: false }`。

### 2.2 `src/main/collect-loop.ts`

```ts
export type RefreshOutcome = 'started' | 'queued'

export interface CollectLoop {
  /** 幂等启动唯一调度循环 */
  start(): void
  /** 停循环（`stopScheduler` 用）；不打断在飞轮次，只保证不再排新轮 */
  stop(): void
  /** 立即跑下一轮（首轮、手动刷新、重配）；已在跑则记为"合并待跑" */
  requestRefresh(): RefreshOutcome
  /** 设置变更后按新间隔重排（`reconfigure` 用） */
  reconfigure(): void
  isRunning(): boolean
  /** 本轮是否仍是最新轮次 —— 轮体在**任何写入/推送前**必须问一次（R2） */
  isCurrent(epoch: number): boolean
  lastTimeoutAt(): string | null
}

export function createCollectLoop(opts: {
  intervalMs: () => Promise<number>
  /** 轮体：epoch 供 isCurrent 判断；实现方负责真正的采集与推送 */
  runRound: (epoch: number, current: (e: number) => boolean) => Promise<void>
  budgetMs: number
  /** 软阈值：超过则记一条"轮次偏慢"，但不打断 */
  slowWarnMs: number
  onTimeout: (at: string, epoch: number) => void
  log: (msg: string) => void
}): CollectLoop
```

**轮次语义表**（这张表就是 R1/R4/R5/R6 的判据）：

| 触发 | 循环当前状态 | 行为 | 推送 | `ui:refresh` 返回 |
|---|---|---|---|---|
| 首轮 | 空闲 | 立即跑 | `scanning:true` → `false` | — |
| 自动节奏到期 | 空闲 | 跑 | 同上 | — |
| 手动刷新 | 空闲 | 立即跑 | `scanning:true` → `false` | `started` |
| 手动刷新 | 轮次在飞 | 记 `pending = true`（**合并**多次点击） | **维持 `scanning:true`** | `queued` |
| 手动刷新 | 轮次超时收尾中 | 同上（合并） | 同上 | `queued` |
| 轮次正常结束 + `pending` | — | **立即**补跑一轮，不等待间隔 | 维持 true → 结束后 `false` | — |
| 轮次超时 | — | 收尾、`onTimeout`、`lastTimeoutAt = at`；有 `pending` 则补跑 | `scanning:false` → 补跑时再 `true` | — |

**关键取舍**：

- **`queued` 也推 `scanning: true`**：UI 的"正在采集"表示的是"**有活要干**"，而不是"某一轮正在跑"。这样渲染层不需要自己实现乐观状态（避免两处状态机）。R4/R7 因此天然对齐。
- **`pending` 只留 1 个布尔**：刷新请求的语义是"我要最新数据"，点击 10 次与 1 次等价；队列深度 1 让成本有界（最多多跑一轮）。
- **手动刷新不重置间隔**：自动节奏由循环自身持有（`nextDelay`），刷新只设置 `pending`。这直接消灭旧实现里 `refreshNow().finally(scheduleLoop)` 把下一轮推后的问题（R5）。
- **循环式而非定时器式**（R6 的结构性解法）：用 `while + await sleep(delay)` 取代 `setTimeout`，句柄在**结构上**不存在，因此不存在"两个来源各设一个 timer、先设的失去引用"的泄漏。`wake()` 通过提前 resolve 睡眠 promise 实现，`stop()` 只置标志位。这比"加一个 `scheduling` 卫兵"更强：卫兵是与重入的赛跑，循环是没有赛道。
- **超时后迟到结果必须丢弃**（R2）：`epoch` 是单调递增的轮次号；`runRound` 在写 `lastSnapshots` / `lastSync` / `push` / 托盘**之前**调用 `current(epoch)`。超时那一刻循环就把该 epoch 标为失效，迟到结果自然被挡在门外。**不能**只靠"复位 running"——那会让两轮同时写状态。

### 2.3 预算取值（依据，不是拍脑袋）

- 单次出网超时 = `request.ts` 的 12s。
- **合法最坏轮次**（全部是串行 await）：opencode 官方 API 12s + 控制台 status 12s + billing 12s ≈ 36s；antigravity 的 `postEachHost` 是「3 host × 12s」× 2 个路径 ≈ 72s；`collectAll` 并行取最大值。
- → `budgetMs = 120_000`（2 分钟）：显著大于最坏合法轮次（避免误杀），同时把"永久卡死"降级为"最多卡 2 分钟 + 自动恢复 + 可观测"。
- → `slowWarnMs = 45_000`：只有日志，不打断。用于将来判断是否该收敛串行请求。
- 二者都是常量，**不新增用户偏好**（父 PRD Out of Scope）。

### 2.4 `src/main/request.ts`（R3）

```ts
const ms = req.timeoutMs ?? 12000
const ctrl = new AbortController()
let decided = false                     // race 已判负后，迟到响应不得再改可达性记账
const abortErr = () => { const e = new Error(`请求超时（${ms}ms）`); e.name = 'AbortError'; return e }
try {
  return await Promise.race([
    send(),                             // fetch + markNetResult(true) + await res.text()
    new Promise<never>((_, rej) => setTimeout(() => { ctrl.abort(); rej(abortErr()) }, ms))
  ])
} catch (e) { if (!decided) markNetResult(false, e); throw e } finally { decided = true; clearTimeout(timer) }
```

- **复用 `AbortError` 这个名**，而不是新增 `TimeoutError`：`shared/quality.ts` 的 `isNetworkError` 已经把 `name === 'AbortError'` 判为网络类错误（"我方超时"），语义完全等价。新增一个名字就得同时改分类器与它的测试，扩大面。
- 原来的 `setTimeout(() => ctrl.abort(), ms)` 保留（让底层连接尽快被放弃）；race 是"即使 abort 管不到也必须返回"的兜底。两者都要，不是二选一。
- `decided` 标志解决一个真实污染：超时判负后原 `send()` 若迟到成功会把 `failStreak` 清零，从而干扰离线判定。

### 2.5 通道与渲染层（R4/R7）

- `ipc.ts`：`ipcMain.handle('ui:refresh', () => loop.requestRefresh())`（不再 `async` 包 void）。
- `preload`：`refreshNow: (): Promise<RefreshOutcome> => ipcRenderer.invoke('ui:refresh')`；`api.d.ts` 同步。
- 既有调用点（`App.tsx:1055 / 1164 / 1172`）都是 `() => void window.api.refreshNow()`，`void` 吃掉新返回值即可，**零改动**。
- `DetailView` 新增 `scanning: boolean` prop，刷新按钮 `className={scanning ? 'spinning' : ''}`（与 `CardView.tsx:657,759` 同款）；`App.tsx:1161` 传 `state.scanning`。
- 状态行（R8 的最小展示面）：`AppState.lastTimeoutAt` 有值且距今 < 一轮间隔时，在既有 `status-line` 的 `dim` 文本位置追加"本轮采集超时"，**不新增组件**。

### 2.6 时序（正常 vs 超时）

```
正常轮：sleep(interval) → begin(epoch=7) → runRound(7) → [push true … push false] → epoch 仍 current → 收尾
超时轮：sleep(interval) → begin(epoch=7) → runRound(7) ──budget 命中──> epoch 置为失效
                          → onTimeout → push {scanning:false, lastTimeoutAt} → 下一轮 begin(epoch=8)
        （epoch 7 的迟到 resolve 想写 lastSnapshots 时被 current(7)=false 挡下）
```

## 3. 兼容性与回归面

- `AppState` 只**新增可选字段** → 老渲染层/CLI 导出/托盘不受影响；`export-snapshot.ts` 的契约（只搬结构化字段）不需要动（`lastTimeoutAt` 不进导出）。
- `RefreshOutcome` 是新增返回类型，既有 `void` 调用点兼容；`api.d.ts` 是新通道形状的唯一声明处。
- `collect()` 的对外行为在**正常路径**上逐字不变（同样的 push 次数与内容），只有"挂起/超时/并发刷新"三条路径是新语义 —— 这保证既有 19 个测试段不受影响，风险集中在新增段。

## 4. 测试策略

- `scripts/test-deadline.mjs`：`loadTs` 加载真源码。断言：永不 settle → `{ok:false}`；正常 → `{ok:true,value}`；预算内 reject → **原样抛出**；超时后迟到 resolve 不改变已返回结果。
- `scripts/test-collect-loop.mjs`：`loadTs` 加载真源码 + 桩 `runRound`，用真实短延时（5–30ms）跑真循环。断言：幂等 `start`；`requestRefresh` 的 `started/queued`；合并语义（连点 3 次只补跑 1 轮）；`queued` 期间 `scanning` 不为 false；超时轮次**迟到结果被丢弃**（`epoch` 失效断言）；超时后下一轮照常执行；`stop()` 后不再排新轮；**不产生任何未清理的定时器**（以"stop 后无新轮次"断言，因为结构上已无句柄）。
- `scripts/test-seam.mjs` 追加：`request.ts` 的兜底超时用桩 fetch（永不 settle）断言在 `ms` 量级内抛 `AbortError`（既有套件已有桩接缝，扩展而非新建）。
- `--uitest`：详情页点击刷新按钮 → DOM 断言按钮带 `spinning` 类（`qa/uitest.ts` 已有 DOM 断言能力）。
- 每个新护栏都要**先弄坏一次**确认变红（`frontend/quality-guidelines.md` 纪律 3）。

## 5. 回滚形态

改动按"可单独 revert"切三段：

1. `deadline.ts` + `collect-loop.ts` + 测试（纯新增，不动产品路径）→ 可独立合入。
2. `scheduler.ts` 切到 `collect-loop`（控制流替换）→ 出问题 revert 这一个文件即回到旧控制流（旧实现保留在 git 历史里，不并行留双实现）。
3. 通道与 UI（`ipc.ts`/`preload`/`api.d.ts`/`DetailView`/`App`/`types.ts`）→ 独立一段；即使第 2 段回滚，第 3 段单独也不会让功能变差（按钮 spinning 依赖 `scanning`，而 `scanning` 是既有字段）。
