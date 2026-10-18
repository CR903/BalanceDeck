# 2026-10-18 采集轮级看门狗：同步不再永久卡死 + 刷新不再静默丢弃

任务：`.trellis/tasks/10-18-sync-collect-watchdog`（孩子 A；孩子 B = `10-18-local-db-off-mainthread`）

## 起因

用户两个症状：①数据停在「3 小时前」，点刷新**毫无反应**，只有重启才恢复；②程序经常卡住、
鼠标转沙漏。父任务已取证（本次直接采信，不重复调查）：

- `balance-export.json` 冻结在 12:39、`usage-history.json` 冻结在 12:25，而进程 11:37 启动、
  15:35 仍存活可交互 → **采集轮次没有结束**。
- `lsof -p <pid>` 零 TCP 连接；`sample` 里一个线程 99.4% 采样陷在 `select()` → 卡在建连前
  阶段（DNS / connect），`AbortController` 覆盖不到。
- kill + 重启后立即恢复（12:39 → 15:49:44）→ `running` 被**永久**卡死，这就是「重启才活」。

## 定性：一票否决 + 无预算 + 两个定时器来源

```ts
// 旧 scheduler.ts:60-61
if (running) return        // ← 早退发生在这两行之前
running = true
...
} finally { running = false }
```

三条各自独立、可单独复现的缺陷：

1. **轮次无预算**：`try` 体内所有 await 都不受任何时间约束。任一次出网永不 settle，`running`
   就永远为 `true`，之后每 60s 的定时轮都在第一行静默返回 —— 采集**永久停摆**。
2. **刷新被静默丢弃**：`if (running) return` 在 `push({scanning:true})` **之前**，而且
   `ui:refresh` 仍正常 resolve（`Promise<void>`）⇒ 渲染层无法区分「开始了」与「被丢了」。
   用户看到的「点了没反应」是两件事叠加的结果。
3. **定时器有两个来源**：`scheduleLoop()` 每次进入都 `clearTimeout(timer)` + `setTimeout`，
   而它同时被定时器自身的 `.finally` 与 `refreshNow().finally` 调用 ⇒ 并发进入时先设的句柄
   失去引用，`stopScheduler()` 清不掉。

`request.ts` 还有第四条：超时只有 `setTimeout(() => ctrl.abort(), ms)` 这一种手段。真机取证说明
它兜不住建连前的挂起 —— 而且 `markNetResult(true)` 写在 `await res.text()` **之前**，连记账都
反映不出这类失败。

## 改了什么（6 步）

| 文件 | 改动 |
|---|---|
| `src/main/deadline.ts` | **新增**。`withDeadline(p, ms)`：把「永不 settle」变成「有界失败」。超时**不 reject**（返回 `{ok:false,reason:'timeout'}`），预算内 reject **原样抛出**（不吞异常，否则「超时」与「真失败」不可区分）。两个回调都挂上 —— 超时之后原 promise 仍会 settle，迟到 reject 无人接收会变成进程级 unhandled rejection |
| `src/main/collect-loop.ts` | **新增**。纯逻辑调度循环：轮次预算、epoch 失效、`started/queued` 刷新语义、`while + await sleep` 循环式控制流 |
| `src/main/request.ts` | 双保险超时：abort（让底层连接尽快被放弃）+ `Promise.race`（即使 abort 管不到也必须返回）。复用既有 `AbortError` 名（`isNetworkError` 已判它网络类），新增 `decided` 标志挡住「判负之后迟到的成功清零记账」 |
| `src/main/scheduler.ts` | 控制流切到 `createCollectLoop`；轮体 `runRound` 保留原采集/合并/推送/历史采样行为，在两处加 `current(epoch)` 闸门（写快照前 + 收尾路径）；`COLLECT_BUDGET_MS = 120_000` / `COLLECT_SLOW_WARN_MS = 45_000` |
| `src/shared/types.ts` | `AppState.lastTimeoutAt?: string`（**只新增可选字段**）、`RefreshOutcome` |
| `ipc.ts` / `preload/index.ts` | `ui:refresh` 返回 `RefreshOutcome`（`started` / `queued`） |
| `DetailView.tsx` / `App.tsx` | 接 `scanning`，⟳ 加 `spinning`（与 `CardView` 对齐） |
| `CardView.tsx` | 状态行如实追加「本轮采集超时」 |
| `scripts/test-deadline.mjs` / `scripts/test-collect-loop.mjs` | **新增**测试段（14 / 47 断言；47 → 56 见文末「复检」）注册进 `npm test` |
| `scripts/test-seam.mjs` | 追加 S9（abort 管不到的挂起）+ S10（迟到成功不改记账），45 → 53 断言 |
| `scripts/lib/load-ts.mjs` | 新增可选 `replace`（esbuild 的 `alias` 只认裸模块名，`./net` 会报 Invalid alias name） |
| `scripts/lib/net-probe.mjs` | **新增**。记账探针替身：让「有没有多记一次成功」可观测 |
| `src/main/qa/uitest.ts` | 详情页刷新按钮的 DOM 断言 `detailRefreshSpin` |

三条设计取舍：

- **epoch 失效而不是只复位 `running`**：超时那一刻把该轮次号标为作废，轮体在任何写入/推送前
  必须问一次 `current(epoch)`。只复位 `running` 会让「看门狗复位后的新轮」与「仍在后台跑的旧轮」
  同时写状态。护栏 `test-collect-loop.mjs` C5f/C5i + C8（静态：闸门在写入**之前**）。
- **循环式而非定时器式**：`while + await sleep(delay)` 里的句柄是闭包局部量，结构上只可能有
  一个睡眠者 ⇒ 「两个来源各设一个 timer」这种泄漏没有发生的地方。比「再加一个 `scheduling`
  卫兵」更强：卫兵是与重入赛跑，循环是没有赛道。护栏 C7 直接读进程活动句柄
  （`process.getActiveResourcesInfo()`：空闲时恰好 1 个，`stop()` 后 0 个）。
- **`queued` 也推 `scanning: true`**：UI 的「正在采集」表示「**有活要干**」，而不是「某一轮
  正在跑」——否则渲染层得自己造一套乐观状态（两处状态机必然漂）。

## 波折 / 需要如实说清楚的地方

1. **design §2.2 语义表与 §3 之间有一处内部张力。** §2.2 的表写「自动节奏到期 → 推
   `scanning:true` → `false`」，§3 却写「正常路径逐字不变（同样的 push 次数与内容）」。
   旧实现的定时轮只在收尾推一次。我按**语义表**实现（每轮开始都推 `scanning:true`），
   理由是 `CardView:608` 的 `firstLoad = snaps.length === 0 && scanning` 本来就需要它
   （旧实现下首轮永远显示「暂无数据」而不是「正在采集…」）。副作用要认账：**每轮自动刷新时
   卡片页的 ⟳ 都会转一下**（诚实反映「正在采集」，但确实是一处视觉行为变化）。若 review
   认为不该动，改法是把 `runRound` 的入参加一个 `announce` 标志、只让刷新路径推。
2. **`RefreshOutcome` 落在 `src/shared/types.ts`，不是 design 写的 `collect-loop.ts`。**
   `preload/index.ts` 与渲染层都要用它，而 **preload 从不 import main**。名字与语义不变，
   只挪了家（「一个概念一个家」）。
3. **`balance-export.json` 里那个字段叫 `generatedAt`，不是 prd/验收话术里的 `updatedAt`。**
   取证命令按真实字段名写。
4. **`loadTs` 加了 `replace` 选项才测得到 `decided`。** esbuild 会把 `net.ts` 内联成私有副本，
   测试拿不到它的 `failStreak` ——「迟到的成功不得清零记账」这条断言原本无从下手。新选项纯增量
   （不传时行为逐字相同，既有 6 个使用方零改动）。
5. **`withDeadline` 的 `ms` 用常量、不新增用户偏好**；验收时临时把 `COLLECT_BUDGET_MS` 调到
   5000 / 4000 制造真实超时，**已还原为 120_000**（`grep -n 'COLLECT_BUDGET_MS =' src/main/scheduler.ts`）。
6. **没做的**（PRD Out of Scope，留给孩子 B 或不做）：适配器级并发/退避重构、把调度挪进
   worker、改快照口径、改 CSS/灵动岛。主进程同步阻塞那 ~2 秒仍由孩子 B 负责
   （本次**没有**动 `opencode.ts` 的 sqlite 扫描）。
7. **单次 4 秒挂起窗口的边界**：`epoch` 失效发生在「循环拿回控制权」的那个 microtask；
   理论上若旧轮的 resolve 与 deadline 落在同一 tick 的微任务队列里且旧轮在前，会有一个极窄的
   写入窗口。这是「JS 无法取消 promise」的固有代价，design 也接受；实测（真机 6 轮 + 单测）
   未复现，但**不等于不存在**，如实记下。
   > ⚠ **复检推翻了这条自述**：Node 在同一 tick 的两个定时器回调之间会排空微任务，而
   > 「旧轮 resolve 在前」等价于该轮**在预算内正常收尾**（`clearTimeout` + 先到先得），
   > 72 组边界扫描里「失效后写入 / 无超时丢弃 / 既写入又超时」都是 0。**这条不是真缝隙**；
   > 真正的风险是另一件事（闸门与写入之间出现 `await`），已补 C8f 钉住。详见文末「复检」。

## 验证

### 门禁

```
npm run typecheck        # 两个 tsconfig 都过
npm test                 # 22 个套件（新增 deadline / collect-loop），0 失败
npm run uitest           # 172 个 key；detailRefreshSpin = ok
                         # ⚠ 首次自测时 dockSettings 是 ok，据此写成「唯一非 ok 是既有的 cardBack」
                         #   —— 复检发现该断言 flaky（同构建两跑一红一绿），见文末「复检」
```

### 每条新护栏都「先弄坏一次」确认变红

| 弄坏方式 | 红的位置 |
|---|---|
| `withDeadline` 超时分支改成 `reject` | D2 段未及断言即进程终止（未捕获错误，退出码非 0） |
| 超时返回 `{ok:true, value:undefined}`（把超时当成功） | ✗ D2a、✗ D4a（超时被伪装成成功） |
| 去掉 `epoch += 1`（超时后不作废轮次） | ✗ C5f、✗ C5i、✗ C5j（R2 三条） |
| `requestRefresh` 在飞时直接返回 `'started'`（不排队） | ✗ C3b/C3d/C3e/C3f/C3g、✗ C4b（7 条） |
| `request.ts` 拿掉 `if (!decided)` 闸门 | ✗ S10d（迟到的成功追记了一次成功） |
| `request.ts` 拿掉 `Promise.race`（只留 abort） | S9 卡死：`Warning: Detected unsettled top-level await`，退出码 13 |
| `scheduler.ts` 把 `current(epoch)` 闸门挪到 `lastSnapshots =` **之后** | ✗ C8d（接线守卫真的看得见顺序） |
| `DetailView` 的 ⟳ 去掉 `className={scanning ? 'spinning' : ''}` | uitest `detailRefreshSpin = fail:no-spinning` |

### 真机取证（`npx electron .` + `BALANCEDECK_DEBUG=1`，独立 `BD_USER_DATA`，不碰用户那份）

**A. 超时 → 复位 → 下一轮照常 → `generatedAt` 继续前进（同一次运行内）**
（临时预算 4000ms 制造真实超时；round 本身要 4.5–5.2s）

```
08:24:45.762 collect start (epoch 1)
08:24:49.484 轮次超时（epoch 1，预算 4000ms）：本轮作废，复位后继续
08:24:49.484 collect 超时（epoch 1）：本轮作废并复位，下一轮照常
08:24:50.043 collect stale: epoch 1 已失效，丢弃 7 条迟到结果      ← R2：迟到结果被丢弃
08:25:49.648 collect start (epoch 3)                                ← R1/R3：下一轮照常，没被一票否决
08:25:52.707 collect done: 7 个供应商，cached=0，offline=false      ← 且真的成功
08:26:52.810 collect start (epoch 4)
08:26:57.061 轮次超时（epoch 4，预算 4000ms）…
08:28:00.042 collect done: 7 个供应商
```
`balance-export.json` 的 `generatedAt`：`08:24:45` → `08:25:52` → `08:28:00` → **继续前进**
（对照症状是 12:39 冻死 3 小时）。

**B. 恢复 120s 真实预算后连续观察 13 分钟（`grep` 计数）**

```
$ grep -c 'collect done' /tmp/balancedeck-scheduler.log   → 13
$ grep -c '超时'          /tmp/balancedeck-scheduler.log   → 0
$ head -1 …  → 2026-10-18T08:34:12.501Z collect start (epoch 1)
$ tail -2 …  → 2026-10-18T08:47:13.394Z … 07:47:13.444Z collect done: 7 个供应商，cached=0，offline=false
$ balance-export.json → generatedAt = 2026-10-18T08:47:13.442Z
```
13 轮全部正常收尾、零误杀、节奏 ~60s，`generatedAt` 每轮前进。

**C. 渲染层可见反馈（R7/R8）**
- `--uitest`（构建产物 + 真实点击）：`detailRefreshSpin = ok`；去掉 `spinning` 后
  `fail:no-spinning`。
- 状态行提示的运行时取证（临时预算 400ms 逼出超时）：`document.querySelector('.status-line')
  .textContent` → `'暂无数据 · 本轮采集超时'`。

**D. 常量已还原**：`grep -n 'COLLECT_BUDGET_MS =' src/main/scheduler.ts` → `120_000`（build 产物随之重建）。

## 沉淀

- **spec**：留给 `trellis-update-spec`（`scheduler.ts` 的「轮次预算 + epoch 闸门 + 循环式调度」
  与 `request.ts` 的「双保险超时 + decided」应进 `.trellis/spec/`）。
- **knowledge**：已沉淀 `docs/knowledge/main/scheduler-watchdog.md`（判断准则：永不 settle 的
  await = 调度权丢失；AbortController 兜不住建连前挂起）+ 两级索引。
- **待人工**：在用户那份真实 `userData`（带 opencode cookie）上跑一轮，确认详情页 ⟳ 与状态行
  的实际观感；以及孩子 B 落地后复测单轮耗时。

## 复检（trellis-check 代理，2026-10-18）

独立重跑 + 自己重做变异，不采信上文自述。差异与新增如下。

### A. 结论被推翻的一条

- **「4 秒挂起窗口里的极窄写入缝隙」不存在**（上文「波折」第 7 条）。Node 22 在**同一 tick 的两个
  定时器回调之间会排空微任务**（探针实测顺序 `timerA → microA → timerB`），所以
  `withDeadline` 的 `resolve({ok:false})` 一发生，紧随其后的 `epoch += 1` 必然先于轮体的任何
  后续 continuation 执行；而「旧轮 resolve 在前」等于该轮**在预算内正常收尾**（`p.then` 里
  `clearTimeout`，即便 deadline 定时器仍触发，`resolve` 也是先到先得的 no-op）⇒ 只会得到
  `{ok:true}`。72 组「预算 ≈ 轮次耗时」边界扫描（2–12ms、含抖动）里
  「失效后写入 / 无超时丢弃 / 既写入又超时」全为 **0**。
- 但 R2 依赖的**前提**（闸门与写入在同一个同步块）此前没被任何断言守住 —— 中间一旦有 `await`
  就真的成了 TOCTOU。故补 **C8f/C8g/C8h**：闸门与写入、收尾闸门与推送之间**不得出现 `await`**。
  变异实测：插一个 `await` ⇒ 只有 C8f 变红。

### B. 新发现并修掉的一个真问题（R1 的另一张脸）

`onTimeout` 里的 `push(...)` 在 webContents 已销毁时**会抛**（渲染进程崩溃 / 窗口正在销毁而
`closed` 未处理；`maybeWrite` 自己吞异常，所以这是 `push` 唯一会抛的口子）。抛出来会一路冒到
`loopBody` 末尾 ⇒ 循环退出 ⇒ **采集永久停摆**，与本次要修的症状逐字相同。探针实测：
`onTimeout` 抛一次后 `rounds=[1]`，再无新轮。

- 修：`loopBody` 里 `await runOneRound()` 包 try/catch，异常只记日志（该轮已在 `runOneRound`
  内复位过，`inFlight` 不受影响）。
- 护栏 **C9**（去掉 try/catch ⇒ C9b 红）。这是**本轮复检新增的唯一代码改动**。

### C. 自己重做的变异（红集与上文表格一致）

| 变异 | 实测 |
|---|---|
| `request.ts` 拿掉 `Promise.race` | `test-seam` S9 挂死，`Detected unsettled top-level await`，退出码 13 |
| `request.ts` 拿掉 `if (!decided)` | ✗ S10d（唯一红） |
| `collect-loop.ts` 去掉 `epoch += 1` | ✗ C5f/C5i/C5j + ✗ C10a/C10c |
| `scheduler.ts` 闸门后插 `await` | ✗ C8f（新增） |
| `collect-loop.ts` 去掉新加的 try/catch | ✗ C9b（新增） |
| `scheduler.ts` 删掉 refreshNow 的日志行（或改成注释） | ✗ C8j（新增） |

### C2. 复检补的一个 R8 缺口：「排队」没有日志

逐格核对 R8（开始/结束/超时/**排队**/复位都要有 `BALANCEDECK_DEBUG` 日志）时发现**排队那一格是空的**：
`requestRefresh` 的合并分支与 `refreshNow` 的 `queued` 分支都不写日志 —— 于是「刷新被并入当前轮」
在日志里查不到，而这正是本次要修的那副面孔（「查不到的丢弃」）。修法：`scheduler.refreshNow`
加一行 `debugLog(`刷新请求：${outcome}…`)`，护栏 C8j（断言调用形状、先剥注释）。

### D. `--uitest` 的 flaky key 不止一个（上文的「唯一非 ok」说法不成立）

同一份新构建连跑 6 次（每次全新 `BD_USER_DATA`），输出的失败 key **每次都不一样**
（另有一次整轮挂住、主线程空转在 `kevent`，即流程在等一个永不到来的事件）：

| 样本 | 新构建失败 key | `detailRefreshSpin` |
|---|---|---|
| NEW#1/#2/#3/#4/#5 | `dockSettings` / 全 ok / `intervalFlash` / `grpUnknownBucket` / 挂住 | ok |
| NEW#6 | 岛上夹具簇（`islandDisable`/`petBallHitRect: fail:no-island`/`petRingRemoved: fail:menu=<not-called>`/`cachedCard`…） | ok |

**HEAD 基线（`git archive HEAD` 到临时目录另建）同样会红**：2 次跑里 1 次
`intervalFlash = fail:no-flash` —— 所以这类红**不是本次改动造成的**（至少 `intervalFlash` 已证）。
两个构建里失败的都是同一类形状：**瞬态 DOM / 点击 / 原生菜单**（`.saved-flash` 只活 1600ms、
`.dock-hide` 靠一次点击、右键菜单靠真实 popup、夹具要在真实采集轮的空隙里读）。
`intervalFlash` 那条的成因可以直接指出来：断言在 `sleep(900)` 后去抓一个 1600ms 后自己消失的元素。

岛上那簇（NEW#6）形状与 harness 自己的注释吻合 —— 「60 秒一轮的真实采集随时可能把夹具覆盖掉」
（`uitest.ts` 的夹具段注释）：`refreshNow()` 那一轮的收尾推送落在夹具窗口里就会把夹具冲掉。
可疑之处在于 **R5 恰好改变了相位**：旧实现的 `refreshNow().finally(scheduleLoop)` 会把下一轮自动
刷新**推后**一个整间隔，新实现（R5）**不再推后** —— 于是夹具窗口被真实轮次命中的概率变高了。
本轮**没有**改 harness（每次验证要 2 分钟且本身 flaky，改了无法自证），把它作为**待办**记下，
最小改法是：夹具段之前不再用固定 `sleep(2500)`，改成「轮询 `scanning` 为假」再推夹具。

结论：**单次 uitest 的非 ok key 不足以归因**；上文那句「唯一非 ok 是 cardBack」必须删掉 —— 它不是证据。

### E. 复检新增护栏（`test-collect-loop.mjs` 47 → 58 项）

- C8f/C8g/C8h：闸门到写入（及收尾闸门到推送）之间无 `await`。
- C8i/C8j：`refreshNow` 保留刷新结果的日志（R8 排队格）。
- C9a/C9b/C9c：收尾回调抛异常不杀死循环 + 有日志。
- C10a/C10b/C10c：10 组预算边界扫描，「失效后写入 / 无超时丢弃 / 既写入又超时」三空 +
  轮数与分支覆盖前置（负向断言不留空洞）。
- 复检门禁：`npm run typecheck` ✓ · `npm test` 22 套件 0 失败（`test-collect-loop` 58）·
  `npm run uitest` `detailRefreshSpin = ok`。
