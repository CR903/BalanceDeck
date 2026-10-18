# 采集轮级看门狗：同步不再永久卡死 + 刷新不再静默丢弃

## Goal

让"采集轮次"成为一个**有预算、可恢复、可观测**的单元：

1. 任何一轮都不可能无限期占住调度权；超时必须复位并如实推出状态（修「同步 3 小时不动、只能重启」）。
2. 手动刷新永远有确定语义（开始 / 排队），且渲染层立刻可见（修「点击没有反应」）。
3. 定时器只有**唯一**持有者，重入不再泄漏句柄。

## Background（源码取证，行号截至 2026-10-18）

- 轮次无预算：`src/main/scheduler.ts:60` `collect()` 首行 `if (running) return`（:61），`running`（:38）只在 `finally` 复位；`try` 体内 `collectAll(...)` 的所有 await 都不受任何轮级时间约束。
- 早退点位置有讲究：`if (running) return` 在 `push({ snapshots, lastSync, scanning: true, … })` **之前** ⇒ 被丢弃的手动刷新连"正在采集"都不推。
- `refreshNow()`（:204）= `collect(true).finally(() => scheduleLoop())`；`scheduleLoop()`（:185-193）每次进入都 `clearTimeout(timer)` + `setTimeout`，且有**两个**调用来源（定时器自身 `.finally` 与 `refreshNow` 的 `.finally`）⇒ 并发进入时先设的那个句柄失去引用，`stopScheduler()`（:236）清不掉 ⇒ 定时器泄漏。
- 出网超时只有一种手段：`src/main/request.ts:18-19` `AbortController` + `setTimeout(…12s)`；:27 `markNetResult(true)` 在 :28 `await res.text()` **之前**（拿到响应头即记成功）。→ DNS/建连阶段的挂起既不被 abort 覆盖，也不体现在可达性记账上。
- 刷新通道无返回：`src/main/ipc.ts:134-136` `ui:refresh` 只调 `refreshNow()`；`src/preload/index.ts:27` 声明为 `Promise<void>` ⇒ 渲染层无法区分"开始了"与"被丢弃了"。
- 详情页零反馈：`src/renderer/src/DetailView.tsx:272` 的刷新 `IconButton` 没有 `spinning`/`disabled`，且 `DetailView` 的 props（:213-220）里**没有** `scanning`；对照 `src/renderer/src/CardView.tsx:657,759` 是有 `spinning` 的。App.tsx 在 :1161 / :1167 分别渲染 DetailView / CardView。

真机证据（E1-E6：落盘心跳冻结 + 重启后立刻恢复 + `lsof` 零连接 + `sample` 卡在 `select()`）见父任务 `prd.md`。

## Requirements

- **R1 轮次预算**：为 `collect()` 的整体执行加时间预算（常量，不新增用户偏好）。超时后：复位 `running`、推出 `scanning: false`、**不伪造本轮数据**（沿用上一轮快照），并让下一轮能正常开始。
- **R2 迟到结果必须丢弃**：超时那一刻，"原轮次"仍在后台跑。它的迟到结果与迟到异常**不得**写进 `lastSnapshots` / `lastSync` / 托盘，也不得让 `running` 二次翻真。
- **R3 出网兜底超时**：`request()` 除了 abort，还必须保证"永不 settle 的 fetch"也能在 `timeoutMs` 量级内返回失败，且该失败仍被 `shared/quality.ts` 判为网络类错误（复用既有 `AbortError` 归类，不新增分类分支）。
- **R4 刷新语义**：`ui:refresh` 返回结果枚举，取值仅 `started` / `queued`。空闲时立即开跑；采集中则**排队 1 次**（多次点击合并为 1 次），当前轮结束后立即执行，且在排队时就推 `scanning: true`。
- **R5 刷新不推后自动刷新**：手动刷新不得重置/延后自动刷新的节奏；自动刷新计时只由唯一的调度循环掌管。
- **R6 单一定时器与防重入**：调度循环重入时必须直接返回；任何时刻最多一个被跟踪的定时器句柄，`stopScheduler()` 能清干净。
- **R7 渲染层可见反馈**：`DetailView` 接收 `scanning` 并让刷新按钮进入 `spinning`；与 `CardView` 的既有表现对齐，不新增组件、不改视觉规范。
- **R8 可观测**：每轮的开始/结束/超时/排队/复位都写 `BALANCEDECK_DEBUG` 日志（沿用 `debugLog` 写法）；超时另在推送状态上留一个可选字段，供状态行如实显示"本轮采集超时"。

## Out of Scope

- 不改 `AppState.snapshots` / 快照铸造与可信度口径（只允许**新增可选字段**）。
- 不做适配器级并发/退避重构；不动各适配器的请求次数与端点。
- 不把调度挪进独立进程/worker（属孩子 `10-18-local-db-off-mainthread` 的评估范围）。
- 不新增视觉组件、不改 CSS 皮肤与灵动岛。
- 不动离线判定阈值语义。

## Acceptance Criteria

- [x] AC1：`collect()` 的整体执行受一个常量预算约束；用桩构造"永不 settle 的适配器"，一轮在预算内结束并复位，`scanning` 回到 false（单测）。
- [x] AC2：超时后**迟到结果被丢弃**：让挂起的轮次在超时后才 resolve/reject，断言 `lastSnapshots` / `lastSync` 不被它改写，且 `running` 不再为真（单测）。
- [x] AC3：超时后的下一轮**照常执行**（不被一票否决），连续 N 轮不再出现"静默空转"（单测）。
- [x] AC4：`request()` 对"永不 settle 的 fetch"在超时量级内抛错，且该错误被 `isNetworkError` 判为网络类错误（单测，含桩）。
- [x] AC5：采集中调用刷新返回 `queued`，当轮结束后立即补跑一轮，且**不**改变自动刷新计时（单测：调度门状态机）。
- [x] AC6：空闲时调用刷新返回 `started` 并立刻推 `scanning: true`（单测/集成）。
- [x] AC7：调度循环并发调用只产生 1 个定时器句柄；`stopScheduler()` 后无遗留句柄（单测，含重入路径）。
- [x] AC8：`DetailView` 的刷新按钮在 `scanning` 为真时带 `spinning` 类（`--uitest` DOM 断言）。
- [x] AC9：`npm run typecheck` + `npm test` 全绿；新增护栏先弄坏一次确认变红。
- [x] AC10：真机：用 `BALANCEDECK_FORCE_*` 或桩制造一次挂起，日志出现"超时→复位"，随后 `balance-export.json` 的 `updatedAt` 继续前进（验收取证）。

## 实施结论（2026-10-18，实施代理回填）

**AC 逐条**（「✅」= 有可复现证据；红证据 = 把实现弄坏一次后该断言确实变红）：

| AC | 结论 | 证据 |
|---|---|---|
| AC1 | ✅ | `test-deadline.mjs` D2；`test-collect-loop.mjs` C5a/C5g（超时后 `isRunning()` 回 false）；真机日志见下 |
| AC2 | ✅ | `test-collect-loop.mjs` C5f/C5i（放行挂起轮 → `current(旧 epoch) === false`）；真机 `collect stale: epoch 1 已失效，丢弃 7 条迟到结果`。红证据：去掉 `epoch += 1` → ✗ C5f/C5i/C5j |
| AC3 | ✅ | `test-collect-loop.mjs` C5l/C5m/C5n（超时后连续多轮照常）；真机 epoch 1→3→4→6 持续推进。红证据：同上（C5l 也会红） |
| AC4 | ✅ | `test-seam.mjs` S9（桩 fetch 既不 resolve 也不听 abort → 62ms 内抛 `AbortError`，且 `isNetworkError` 判网络类）。红证据：拿掉 `Promise.race` → S9 卡死，`Warning: Detected unsettled top-level await`，退出码 13 |
| AC5 | ✅ | `test-collect-loop.mjs` C3b（queued）/C3d（当轮结束立即补跑）/C3g（点 3 次只补 1 轮）/C4b/C4c（节奏不被打乱）。红证据：在飞时直接返回 `started` → 7 条红 |
| AC6 | ✅ | `test-collect-loop.mjs` C2b/C2c/C2e（started + 立刻跑，6ms）；`scheduler.refreshNow()` 在 `queued` 时当场 `push(scanning:true)` |
| AC7 | ✅ | `test-collect-loop.mjs` C7a（`process.getActiveResourcesInfo()` 里恰好 1 个 Timeout）/C7d（`stop()` 后 0 个）；C1a（三次 `start()` 只跑一轮） |
| AC8 | ✅ | `--uitest`：`detailRefreshSpin = ok`；去掉 `className={spinning}` → `fail:no-spinning`（同一次构建产物 + 真实点击） |
| AC9 | ✅ | `npm run typecheck` ✓；`npm test` 22 个套件 0 失败（新增 `test:deadline` 14 项 / `test:collect-loop` 47 项，**check 代理复检后加到 58 项**）；上面 7 条红证据 |
| AC10 | ✅ | 见下方真机取证（超时→复位→下一轮照常→`generatedAt` 继续前进，**同一次运行内**） |

### 真机取证（命令 + 原始输出）

> 注：`balance-export.json` 里那个字段实际叫 **`generatedAt`**（`src/main/cli/export-snapshot.ts:92`），
> 不是 AC 里写的 `updatedAt`；下按真实字段名取证。
> 运行方式：`npm run build` 单独一行，再 `BALANCEDECK_DEBUG=1 BD_USER_DATA=/tmp/bd-accept npx electron .`
> （独立 userData，**不碰用户那份**；日志落在 `/tmp/balancedeck-scheduler.log`）。

**A. 超时 → 复位 → 下一轮照常 → `generatedAt` 继续前进（同一次运行，临时把 `COLLECT_BUDGET_MS` 调到 4000ms 制造真实超时）**

```
08:24:45.762Z collect start (epoch 1)
08:24:49.484Z 轮次超时（epoch 1，预算 4000ms）：本轮作废，复位后继续
08:24:49.484Z collect 超时（epoch 1）：本轮作废并复位，下一轮照常
08:24:50.043Z collect stale: epoch 1 已失效，丢弃 7 条迟到结果
08:25:49.648Z collect start (epoch 3)
08:25:52.707Z collect done: 7 个供应商，cached=0，offline=false
08:26:52.810Z collect start (epoch 4)
08:26:57.061Z 轮次超时（epoch 4，预算 4000ms）…
08:26:58.245Z collect stale: epoch 4 已失效，丢弃 7 条迟到结果
08:27:57.108Z collect start (epoch 6)
08:28:00.042Z collect done: 7 个供应商，cached=0，offline=false
```
`generatedAt`：`08:24:45` → `08:25:52` → `08:28:00`（每有一次正常收尾就前进）。

**B. 恢复 120s 真实预算后连续观察 13 分钟（同一份日志，`grep -c`）**

```
$ grep -c 'collect done' /tmp/balancedeck-scheduler.log   → 13
$ grep -c '超时'          /tmp/balancedeck-scheduler.log   → 0
$ head -1 …  → 2026-10-18T08:34:12.501Z collect start (epoch 1)
$ tail -2 …  → 2026-10-18T08:47:13.394Z opencode: 无 cookie 凭据（workspace/key 缺失）
               2026-10-18T08:47:13.444Z collect done: 7 个供应商，cached=0，offline=false
$ python3 -c "…balance-export.json…"  → generatedAt = 2026-10-18T08:47:13.442Z
```
13 轮全部正常收尾、零误杀、节奏 ~60s，`generatedAt` 每轮前进（对照症状是 12:39 冻死 3 小时）。

**C. 渲染层可见反馈**

```
$ # --uitest（构建产物 + 真实点击详情页 ⟳）
detailRefreshSpin = ok
$ # 把 className={scanning ? 'spinning' : ''} 去掉后重建再跑
detailRefreshSpin = fail:no-spinning
$ # 状态行提示（临时预算 400ms 逼出超时后读 .status-line 原文）
probeStatusLine = '暂无数据 · 本轮采集超时'
```

**D. 常量已还原**

```
$ grep -n 'COLLECT_BUDGET_MS =' src/main/scheduler.ts
51:export const COLLECT_BUDGET_MS = 120_000
```

### 实施者注记（与 design/implement 的偏差，已在本轮决定并留痕）

1. **`RefreshOutcome` 的家是 `src/shared/types.ts`**（design 写在 `collect-loop.ts`）：`preload` 与渲染层都要用，而 preload 从不 import main。名字/语义不变。
2. **每轮开始都推 `scanning:true`**：按 design §2.2 语义表实现（§3 的「正常路径 push 次数逐字不变」与之冲突，取语义表）。副作用：自动刷新时卡片页 ⟳ 也会转一下；首轮从「暂无数据」变成「正在采集…」（`CardView:608` 的 `firstLoad` 本就依赖它）。若 review 要求，改法是给 `runRound` 传入 announce 标志、只让刷新路径推。
3. **`loadTs` 新增可选 `replace`**：esbuild 的 `alias` 不支持相对路径（`./net` 报 Invalid alias name），而「迟到成功不得清零记账」必须观测到内联副本里的 `markNetResult`。纯增量，既有 6 个使用方零改动。
4. **状态行提示放在 `CardView`**（design §2.5 的 `status-line` + `dim` 字面位置）：新鲜度用「超时时刻 > 最后成功同步时刻」比较判定，避免把采集间隔复制到渲染层。
5. **`lastTimeoutAt` 只有一个持有者**：调度循环；`scheduler` 只读（`loop.lastTimeoutAt()`），不留第二份。
6. **未做/留待后手**：适配器级并发与退避、把 sqlite 扫描移出主线程（孩子 `10-18-local-db-off-mainthread`）；`src/main/adapters/**` 本轮零改动。

## 核查裁定（trellis-check，2026-10-18）

> 独立复检（不采信实施自述）：重跑了 `typecheck` / `npm test` / `npm run uitest`，并把实施代理声称会变红的变异**逐条自己重做一遍**。结论与差异如下。

### 1. R2「迟到结果被丢弃」——实施代理说的「4 秒窗口里的极窄缝隙」**测不成立**（改为钉原子性）

- 实施代理自述：「epoch 失效发生在循环拿回控制权的那个 microtask；若旧轮 resolve 与 deadline 落在同一 tick 且旧轮在前，理论上存在一次写入机会」。
- 实测与推演（临时探针，跑完即弃、未入库：同毫秒两个定时器的微任务排空实验 + 72 组预算/耗时边界扫描 + 对抗性构造）：
  1. Node 22 在同一 tick 的**两个定时器回调之间会排空微任务**（实测顺序 `timerA → microA → timerB`）。因此 `withDeadline` 的 `resolve({ok:false})` 一发生，紧随其后的 `epoch += 1` 一定先于轮体的任何后续 continuation 执行。
  2. 「旧轮 resolve 在前」的情形等于**该轮在预算内正常收尾**：`p.then` 会 `clearTimeout`，即使 deadline 定时器仍然触发，`resolve` 也是 no-op（先到先得）⇒ 结果是 `{ok:true}`，不会既写入又报超时。72 组边界样本中「失效后写入 / 无超时丢弃 / 既写入又超时」各为 **0**。
- **裁定：不是真漏洞，也不是「可接受代价」——当前实现下不可达。** 但它成立的**前提**是一条没被任何断言守住的纪律：闸门与写入必须在**同一个同步块**里（中间一旦有 `await` 就真的成了 TOCTOU）。故本轮补了一条静态护栏（见下），把前提本身钉住。

### 2. 行为变更裁定：「每轮开始都推 `scanning:true`」**判为合理，保留**（本轮已写进本文件）

- 影响面（实测 grep，非估计）：`scanning` 的消费者只有 `CardView`（`firstLoad` 骨架屏 / 状态行「正在采集…」/ 头部与底部两个 ⟳）与 `DetailView`（本轮新增的 ⟳）；`PetBall` 只在自己的默认 state 里出现该字段（不使用），灵动岛不读它。
- 判为合理的依据：①`scanning` 的语义按 design §2.2 语义表就是「**有活要干**」（在飞或已排队），自动轮当然算；②`CardView:608` 的 `firstLoad` 本就依赖它（旧实现下首轮永远显示「暂无数据」，首轮骨架屏是死的）；③它让「数据在动」可见，而不是让 UI 假装静止。
- 代价（认账）：每轮自动采集（真机 ~3s / 60s 一轮）卡片页 ⟳ 会转一下、底部按钮短暂显示「刷新中…」。这是**表现层变化**，不改任何数据口径；若日后要收回，最小改法是给 `runRound` 传 `announce` 标志、只让刷新路径推。

### 3. 本轮修的**新增**问题：收尾回调抛异常会**永久杀死调度循环**（R1 的另一种触发）

- `onTimeout` 干的是 `push(...)`，而 `pushState` 走 `getOverlay()?.webContents.send(...)` —— webContents 已销毁时会抛（渲染进程崩溃 / 窗口正在销毁而 `closed` 未处理）；`maybeWrite` 自己吞异常，所以这是 `push` 唯一会抛的口子。
- 实测（探针）：`onTimeout` 抛一次 ⇒ `rounds=[1]`，**此后再也不排新轮**，症状与本任务要修的「采集永久停摆、只能重启」逐字相同，只是触发概率更低。
- 修法：`loopBody` 里把 `await runOneRound()` 包进 try/catch，异常只记日志（该轮已在 `runOneRound` 里复位过，`inFlight` 不受影响）。护栏 `test-collect-loop.mjs` C9（去掉 try/catch → C9b 红）。

### 4. 独立复核的变异（自己重做，红集与实施自述一致）

| 变异 | 实测红集 |
|---|---|
| `request.ts` 拿掉 `Promise.race` | `test-seam` S9 处挂死，`Warning: Detected unsettled top-level await`，**退出码 13** |
| `request.ts` 拿掉 `if (!decided)` | ✗ S10d（唯一红） |
| `collect-loop.ts` 去掉 `epoch += 1` | ✗ C5f/C5i/C5j + ✗ C10a/C10c（新增的行为面守卫也红） |
| `scheduler.ts` 在闸门与写入之间插一个 `await` | ✗ C8f（新增） |
| `collect-loop.ts` 去掉本轮新加的 try/catch | ✗ C9b（新增） |

### 5. 新增护栏（`test-collect-loop.mjs` 47 → **58** 项）

- **C8f / C8g / C8h**：闸门与写入、收尾闸门与推送之间**不得有 `await`**（R2 得以成立的前提；异步入内即 TOCTOU）。
- **C8i / C8j**：`refreshNow` 里保留「刷新结果」的 `debugLog` 调用（R8 的「排队」那一格）。断的是**调用形状**，且先剥注释 —— 否则「注释里写的 `debugLog(...)`」会让守卫空洞通过。
- **C9a(前置)/C9b/C9c**：收尾回调抛异常后循环仍排新轮 + 该异常有日志。
- **C10a / C10b / C10c**：10 组「预算 ≈ 轮次耗时」边界扫描（2–12ms），断言不出现「失效后写入」「无超时的静默丢弃」「既写入又判超时」；并带前置（轮数、两个分支都被走到），避免负向断言空洞通过。

### 5.5 本轮补的 R8 缺口：「排队」这一格没有任何日志

- 逐格核对 R8（「每轮的开始/结束/超时/**排队**/复位都写 `BALANCEDECK_DEBUG` 日志」）时发现：**排队是空的** —— `requestRefresh` 的合并分支与 `refreshNow` 的 `queued` 分支都不写日志。症状恰好是本次要修的那副面孔：日志里查不到「刷新被并入当前轮」。
- 修法：`scheduler.refreshNow` 加一行 `debugLog(\`刷新请求：${outcome}…\`)`（沿用既有写法）。护栏 C8j 见上；变异实测：删掉该行（或改成注释）⇒ 只有 C8j 变红。
- 其余各格都在：轮次开始 / 结束 / 出错 / 迟到丢弃 / 超时 / 复位 / 慢轮次 / 读间隔失败 / 循环退出。

### 6. 其它核对结论（无改动）

- **对外契约零破坏**：`startScheduler / refreshNow / reconfigure / resort / currentState / debugPush / stopScheduler / refreshIntervalMs / loadUsageHistory / pruneUsageHistory` 名称与签名全在；`index.ts` / `qa/*` 调用点**零改动**（唯一改的是 `ipc.ts` 的 `ui:refresh` 返回值，即 R4 本身）。`refreshNow` 由 `void` 变 `RefreshOutcome`，既有 `void window.api.refreshNow()` 调用点类型兼容。
- **诚实口径**：超时只推 `scanning:false` + `lastTimeoutAt`，快照与 `lastSync` 原样沿用（时间戳如实变老）；`export-writer` 的 `bodyHash` 只哈希 `{offline, providers}`（**不含** `generatedAt`）⇒ 超时推送因内容不变而**不写盘**，`generatedAt` 只在真有新数据时前进 —— 实施代理用 `generatedAt` 作 AC10 证据是成立的。
- **句柄纪律**：`collect-loop.ts` **并非零 `setTimeout`** —— `sleep()` 里有且仅有一个（design §2.2「句柄在结构上不存在」这句字面不准，代码注释与日志里的表述是准的）。真实不变量是「至多一个被跟踪的睡眠句柄，`stop()` 清干净」，由 C7a/C7d 直接读 `process.getActiveResourcesInfo()` 钉住。
- **`uitest` 的 flaky key 不止一个，且 HEAD 基线也红**（实施日志「唯一非 ok 是 cardBack」不成立）：新构建连跑 6 次，除一次全 ok 外，失败 key 每次不同（`dockSettings` / `intervalFlash` / `grpUnknownBucket` / 岛上夹具簇一串 / 一次整轮挂住），`detailRefreshSpin` **6/6 都是 ok**；HEAD 构建（`git archive` 到临时目录另建）跑 2 次，1 次 `intervalFlash = fail:no-flash` ⇒ **这类红不是本次改动造成的**。两个构建的红都是「瞬态 DOM / 点击 / 原生菜单」形状，与采集调度的因果路径不成立（`.dock-hide` 直接 `setExtras` 无 debounce、`view` 不受 state 推送影响）。**待办（本轮未改 harness）**：夹具段用固定 `sleep(2500)` 等真实轮次收尾，改成轮询 `scanning` 为假；R5（刷新不再推后自动刷新）会让夹具窗口更容易被真实轮次命中。


