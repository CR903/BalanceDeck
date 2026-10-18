// 采集调度循环 —— src/main/collect-loop.ts（轮次预算 / 刷新语义 / epoch 失效）
// 用法：node scripts/test-collect-loop.mjs
//
// 本套件加载**真源码**（loadTs），不内联副本 —— 见 quality-guidelines.md
// 「不要把实现内联进测试」。runRound 是注入的桩，而**循环本身是真的**：
// 真 `sleep`、真 `withDeadline`、真 epoch 失效。
//
// 覆盖的判据（对应 prd.md 的 AC1/AC2/AC3/AC5/AC6/AC7 与 R1/R2/R4/R5/R6）：
//   · start 幂等（三条循环 = 三倍轮次，所以它必须真的只起一条）
//   · 空闲刷新 = started 且立刻跑（不等间隔）· 采集中刷新 = queued 且合并为 1 次
//   · 刷新不重置自动节奏（不多读一次间隔、不多睡一轮）
//   · 超时 → 复位 → 下一轮照常执行；迟到结果被 epoch 闸门挡下（R2 的核心）
//   · stop 后不再排新轮，且**没有遗留定时器句柄**（读进程活动句柄，不是靠推断）
//   · 接线守卫：scheduler.ts 的轮体在写状态**之前**确实问了 current(epoch)

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTs } from './lib/load-ts.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0

function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}\n      实际: ${a}\n      期望: ${e}`)
  }
}

function ok(cond, label) {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}`)
  }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

/** 轮询到条件成立为止（超时后返回 false，让断言自然变红而不是卡住） */
async function until(pred, timeoutMs = 1500) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true
    await sleep(5)
  }
  return false
}

/** 进程当前活动的 Timeout 句柄数 —— 用来断言「没有遗留定时器」 */
const timeoutHandles = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length

const { createCollectLoop } = await loadTs('src/main/collect-loop.ts')

/**
 * 造一台带记录仪的表。轮体由 `roundImpl(epoch, current, box)` 决定 ——
 * 大多数用例只关心「这一轮什么时候开始」，所以默认立即 resolve。
 */
function makeHarness({ intervalImpl, budgetMs = 5_000, slowWarnMs = 5_000, roundImpl, timeoutImpl } = {}) {
  const box = {
    events: [], // 每轮开始 { epoch, at, current }
    logs: [],
    timeouts: [], // onTimeout 的实参
    intervalReads: 0,
    loop: null
  }
  const intervalMs =
    intervalImpl ??
    (async () => {
      box.intervalReads += 1
      return 10_000
    })
  box.loop = createCollectLoop({
    intervalMs,
    runRound: async (epoch, current) => {
      const ev = { epoch, at: Date.now(), current: current(epoch), intervalReads: box.intervalReads }
      box.events.push(ev)
      if (roundImpl) await roundImpl(epoch, current, box, ev)
    },
    budgetMs,
    slowWarnMs,
    onTimeout: (at, epoch) => {
      box.timeouts.push({ at, epoch })
      // 可选的「收尾回调干了什么」——用来模拟**回调自己抛异常**（C9）与记录时序（C10）。
      // 记在既有记录之后：断言「超时确实发生过」不因注入实现而失效。
      if (timeoutImpl) timeoutImpl(at, epoch, box)
    },
    log: (m) => box.logs.push(m)
  })
  return box
}

const rounds = (box) => box.events.length

// ═══════════════════════════════════════════════════════════════════════════════
// C1. start 幂等 —— 三倍 start 只能是**一条**循环
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nC1. start 幂等（R6）')

{
  const box = makeHarness()
  box.loop.start()
  box.loop.start()
  box.loop.start()
  await until(() => rounds(box) >= 1)
  await sleep(60)
  // 间隔 10s，所以 60ms 内只可能看到「首轮」那一轮。若 start 不幂等，
  // 三条循环各自的首轮会一起涌进来（事件数是 3 而不是 1）。
  eq(rounds(box), 1, 'C1a 三次 start 只跑出一轮（幂等，不是三条循环）')
  ok(box.loop.isRunning() === false, 'C1b 轮次结束后 isRunning() 为 false（在睡下一轮）')
  eq(box.intervalReads, 1, 'C1c 首轮靠 pending 直接跑，随后才读一次间隔')
  box.loop.stop()
}

{
  // 还没 start 就刷新：起循环并立刻跑（否则「刷新」会静默无主）
  const box = makeHarness()
  const outcome = box.loop.requestRefresh()
  eq(outcome, 'started', 'C1d 未启动时 requestRefresh 返回 started（并自起循环）')
  await until(() => rounds(box) >= 1)
  eq(rounds(box), 1, 'C1e 自起的循环确实跑了一轮')
  box.loop.stop()
}

// ═══════════════════════════════════════════════════════════════════════════════
// C2. 空闲刷新 —— started 且**立刻**跑，不等间隔（AC6 / R4）
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nC2. 空闲时刷新 —— started + 立刻跑（R4/AC6）')

{
  const box = makeHarness()
  box.loop.start()
  await until(() => rounds(box) >= 1)
  await until(() => !box.loop.isRunning())
  ok(box.loop.isRunning() === false, 'C2a 前置：刷新前确实空闲（否则下面测的是排队语义）')

  const t0 = Date.now()
  const outcome = box.loop.requestRefresh()
  eq(outcome, 'started', 'C2b 空闲刷新返回 started')
  ok(box.loop.isRunning() === true, 'C2c 返回时立刻处于「有活要干」（渲染层的 scanning 由此而来）')
  await until(() => rounds(box) >= 2)
  const spent = Date.now() - t0
  eq(rounds(box), 2, 'C2d 刷新确实开跑（不是被丢弃）')
  ok(spent < 200, `C2e 立刻开跑，没有等满 10s 的间隔（${spent}ms）`)
  box.loop.stop()
}

// ═══════════════════════════════════════════════════════════════════════════════
// C3. 采集中刷新 —— queued，多次点击**合并**为 1 次补跑（R4）
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nC3. 采集中刷新 —— queued 且合并（R4）')

{
  let release = null
  const box = makeHarness({
    roundImpl: async (epoch) => {
      if (epoch === 1) await new Promise((res) => (release = res))
    }
  })
  box.loop.start()
  await until(() => rounds(box) >= 1)
  ok(box.loop.isRunning() === true, 'C3a 前置：第一轮在飞')

  const outcomes = [box.loop.requestRefresh(), box.loop.requestRefresh(), box.loop.requestRefresh()]
  eq(outcomes, ['queued', 'queued', 'queued'], 'C3b 在飞时刷新一律返回 queued（不是静默丢弃）')
  eq(box.intervalReads, 0, 'C3c 排队不读间隔（刷新不参与节奏，R5）')

  const tRelease = Date.now()
  release()
  await until(() => rounds(box) >= 2)
  const gap = Date.now() - tRelease
  eq(rounds(box), 2, 'C3d 当轮结束后**补跑一轮**')
  ok(gap < 200, `C3e 补跑是立刻的（${gap}ms，没有等 10s 间隔）`)
  eq(
    box.events[1]?.intervalReads,
    box.events[0]?.intervalReads,
    'C3f 补跑那轮跳过睡眠：两轮开始时的「已读间隔次数」相同'
  )

  await sleep(80)
  eq(rounds(box), 2, 'C3g 三次点击只补跑一轮（队列深度 1，成本有界）')
  ok(box.loop.isRunning() === false, 'C3h 补跑结束后回到空闲')
  box.loop.stop()
}

// ═══════════════════════════════════════════════════════════════════════════════
// C4. 刷新不推后自动节奏（R5）
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nC4. 刷新不重置自动节奏（R5）')

{
  const INTERVAL = 150
  let reads = 0
  // 在第 2 轮**运行中**注入一次刷新：模拟用户点了⟳ 而自动轮正在跑
  const box2 = makeHarness({
    intervalImpl: async () => {
      reads += 1
      return INTERVAL
    },
    roundImpl: async (epoch, _current, b) => {
      if (epoch === 2) b.loop.requestRefresh()
    }
  })
  box2.loop.start()
  await until(() => rounds(box2) >= 5, 3000)
  const at = box2.events.map((e) => e.at)
  ok(at.length >= 5, `C4a 节奏持续产轮（${at.length} 轮）`)
  if (at.length >= 5) {
    // 第 2 轮（下标 1）发起刷新 → 第 3 轮（下标 2）是补跑的，两者几乎同时；
    // 再下一轮（下标 3）必须回到 INTERVAL 的节奏，而**不是** 2×INTERVAL
    // （旧实现 refreshNow().finally(scheduleLoop) 会把节奏整个推后）。
    const comp = at[2] - at[1]
    const after = at[3] - at[2]
    ok(comp < INTERVAL, `C4b 补跑紧跟其后（${comp}ms < ${INTERVAL}ms）`)
    ok(
      after >= INTERVAL * 0.5 && after < INTERVAL * 2,
      `C4c 补跑之后回到原节奏（${after}ms，期望 ${INTERVAL}ms 量级且不超过 2 倍）`
    )
  }
  box2.loop.stop()
}

// ═══════════════════════════════════════════════════════════════════════════════
// C5. 超时 → 复位 + 迟到结果被丢弃 + 下一轮照常执行（R1/R2 · AC1/AC2/AC3）
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nC5. 轮次超时（R1/R2 · AC1/AC2/AC3）')

{
  // ── C5-A：R2 —— 超时即作废该 epoch，且**不靠「下一轮开始」来作废** ──────────
  // 间隔给 10s：超时之后到「迟到 resolve」之间不会有任何新轮次，
  // 所以下面那条 current(旧 epoch) === false 只可能来自超时那条路。
  let releaseHang = null
  let lateProbe = null
  let lateCurrents = null
  const box = makeHarness({
    budgetMs: 60,
    intervalImpl: async () => 10_000,
    roundImpl: async (epoch, current) => {
      if (epoch !== 1) return
      await new Promise((res) => (releaseHang = res))
      // 迟到时刻再问一次「我还是当前轮吗」—— 这就是 scheduler 写入前的闸门
      lateProbe = current(1)
      lateCurrents = lateProbe
    }
  })
  box.loop.start()
  const timedOut = await until(() => box.timeouts.length >= 1, 1500)
  ok(timedOut, 'C5a 永不 settle 的轮次在预算内被判定超时（AC1）')
  eq(box.timeouts.length, 1, 'C5b 只判一次超时')
  eq(box.timeouts[0]?.epoch, 1, 'C5c onTimeout 收到的是那一轮的 epoch')
  ok(/^\d{4}-\d{2}-\d{2}T/.test(box.timeouts[0]?.at ?? ''), 'C5d onTimeout 带 ISO 时刻（供状态行如实展示）')
  eq(box.loop.lastTimeoutAt(), box.timeouts[0]?.at ?? null, 'C5e lastTimeoutAt() 与回调同一时刻')
  ok(box.loop.isCurrent(1) === false, 'C5f 超时那一刻第 1 轮即失效（不是等它自己结束，AC2）')
  ok(box.loop.isRunning() === false, 'C5g 超时后复位：isRunning() 为 false（AC1）')
  eq(rounds(box), 1, 'C5h 前置：此间没有新轮开始（下面那条闸门与「下一轮」无关）')

  releaseHang()
  await sleep(30)
  ok(lateProbe === false, 'C5i 迟到结果拿到 current(旧 epoch)=false → 会被丢弃（R2 的核心，AC2）')
  eq(lateCurrents, false, 'C5j 迟到路径只走到闸门一次，得到的都是 false')
  eq(box.timeouts.length, 1, 'C5k 迟到的 resolve 不触发第二次超时')
  box.loop.stop()
}

{
  // ── C5-B：AC3 —— 超时后的下一轮照常执行（不被一票否决）────────────────────
  const box = makeHarness({
    budgetMs: 60,
    intervalImpl: async () => 30,
    roundImpl: async (epoch) => {
      if (epoch === 1) await new Promise(() => {}) // 第 1 轮永远挂住（不会有人放行）
    }
  })
  box.loop.start()
  await until(() => box.timeouts.length >= 1, 1500)
  const continued = await until(() => rounds(box) >= 2, 1500)
  ok(continued, 'C5l 超时后的下一轮照常执行（不被一票否决，AC3）')
  ok(box.events[1]?.epoch !== 1, 'C5m 下一轮用的是新的 epoch')
  const more = await until(() => rounds(box) >= 3, 1500)
  ok(more, 'C5n 连续多轮都在走（不出现「静默空转」）')
  eq(box.timeouts.length, 1, 'C5o 只有挂死的那一轮超时，后续正常轮次不再触发')
  box.loop.stop()
}

// ═══════════════════════════════════════════════════════════════════════════════
// C6. 软阈值「轮次偏慢」只记日志，不打断
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nC6. 慢轮次软阈值')

{
  const box = makeHarness({
    slowWarnMs: 10,
    intervalImpl: async () => 10_000,
    roundImpl: async () => {
      await sleep(40)
    }
  })
  box.loop.start()
  await until(() => box.logs.some((m) => m.includes('轮次偏慢')))
  ok(
    box.logs.some((m) => m.includes('轮次偏慢')),
    'C6a 超过 slowWarnMs 记一条「轮次偏慢」'
  )
  eq(box.timeouts.length, 0, 'C6b 软阈值不打断（没有超时回调）')
  box.loop.stop()
}

// ═══════════════════════════════════════════════════════════════════════════════
// C7. stop 后不再排新轮，且没有遗留定时器句柄（R6 · AC7）
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nC7. 单一定时器与 stop 清干净（R6 · AC7）')

{
  const box = makeHarness({ intervalImpl: async () => 5_000 })
  box.loop.start()
  box.loop.start()
  box.loop.reconfigure()
  box.loop.requestRefresh()
  await until(() => rounds(box) >= 1)
  await sleep(30)
  // 睡在 5s 的间隔里：**唯一**的句柄就是那一个睡眠定时器
  eq(timeoutHandles(), 1, 'C7a 空闲时进程里恰好 1 个定时器句柄（重入不会各设一个）')
  const before = rounds(box)
  box.loop.stop()
  await sleep(120)
  eq(rounds(box), before, 'C7b stop 之后不再排新轮')
  ok(box.loop.isRunning() === false, 'C7c stop 后 isRunning() 为 false')
  eq(timeoutHandles(), 0, 'C7d stop 之后没有遗留定时器句柄（5s 的睡眠被清掉了）')
}

// ═══════════════════════════════════════════════════════════════════════════════
// C8. 接线守卫 —— scheduler.ts 的轮体在写状态**之前**问了 current(epoch)（R2）
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nC8. 接线守卫：轮体写入前的 epoch 闸门')

{
  const src = readFileSync(resolve(ROOT, 'src/main/scheduler.ts'), 'utf8')
  // 切片靠「收尾 } 落在第 0 列」收住；给长度地板/天花板，防止切片失效后
  // 下面的断言去检查别的函数然后照绿（spec 里点名的「假护栏」）。
  const m = /async function runRound\(([\s\S]*?)\n\}/.exec(src)
  const body = m?.[0] ?? ''
  ok(body.length > 500 && body.length < 6000, `C8a 前置：找到 runRound 且切片收得住（${body.length} 字节）`)
  if (body.length > 500 && body.length < 6000) {
    const gate = body.indexOf('current(epoch)')
    const write = body.indexOf('lastSnapshots = ')
    ok(gate > -1, 'C8b 轮体里出现 current(epoch)（epoch 闸门没被删掉）')
    ok(write > -1, 'C8c 轮体里确实有 lastSnapshots 赋值（守卫不是空洞的）')
    ok(gate > -1 && write > -1 && gate < write, 'C8d 闸门出现在写入**之前**（顺序反了等于没有闸门）')
    ok((body.match(/current\(epoch\)/g) ?? []).length >= 2, 'C8e 收尾路径（推送/托盘/历史采样）也在闸门之内')
    // 「问一次再写」只有在**同一个同步块**里才成立：中间一旦有 await，检查通过后、写入前
    // 就会让出控制权 —— 超时正落在那个缝隙里时，闸门判过 true 但写入已经属于被作废的轮次。
    // 这是 R2 唯一的真实缝隙来源（时序极窄、行为测试难以稳定复现），所以静态钉住。
    const gateToWrite = body.slice(gate, write)
    ok(!/\bawait\b/.test(gateToWrite), 'C8f 闸门与写入之间没有 await（有 await 即 TOCTOU：判过之后才被作废）')
    const gate2 = body.indexOf('current(epoch)', gate + 1)
    const push2 = body.indexOf('push?.(stateWith(false))')
    ok(gate2 > gate && push2 > gate2, `C8g 前置：找得到收尾闸门与收尾推送（gate2=${gate2} push2=${push2}）`)
    if (gate2 > gate && push2 > gate2) {
      ok(!/\bawait\b/.test(body.slice(gate2, push2)), 'C8h 收尾闸门与推送之间没有 await（同上）')
    }

    // R8 的「排队」那一格：刷新结果必须留下一条日志（否则「点刷新没反应」在日志里
    // 也查不到）。断的是**调用形状**（refreshNow 里有 debugLog 调用），不是文案 ——
    // 但先剥掉注释，否则「注释里写的 debugLog(...)」会让守卫空洞通过。
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const rn = /export function refreshNow\(\)[\s\S]*?\n\}/.exec(strip(src))
    ok(rn != null, 'C8i 前置：找得到 refreshNow 的函数体')
    if (rn) {
      ok(/\bdebugLog\(/.test(rn[0]), 'C8j refreshNow 里保留了 refresh 结果的日志（R8：排队/开始都要可观测）')
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// C9. 收尾回调自己抛异常，也不能丢掉调度权（R1 的另一种触发方式）
// ═══════════════════════════════════════════════════════════════════════════════
// 为什么要有这条：`onTimeout` 里干的是 `push(...)`，而 `pushState` 会走
// `getOverlay()?.webContents.send(...)` —— webContents 已销毁时它**会抛**（渲染进程崩溃、
// 窗口正在销毁而 closed 事件还没处理）。收尾路径上的一次异常若把循环带走，症状与本任务
// 要修的「采集永久停摆、只能重启」逐字相同，只是触发概率更低。
console.log('\nC9. onTimeout 抛异常不杀死循环')

{
  const box = makeHarness({
    budgetMs: 30,
    intervalImpl: async () => 30,
    roundImpl: async (epoch) => {
      if (epoch === 1) await new Promise(() => {}) // 第 1 轮永不 settle → 必然超时
    },
    timeoutImpl: () => {
      throw new Error('pushState: Object has been destroyed')
    }
  })
  box.loop.start()
  const timedOut = await until(() => box.timeouts.length >= 1, 1500)
  ok(timedOut, 'C9a 前置：确实超时了一次（否则下面测的是别的东西）')
  const survived = await until(() => rounds(box) >= 2, 1500)
  ok(survived, 'C9b 收尾回调抛异常后循环仍在排新轮（调度权没有永久丢失）')
  ok(
    box.logs.some((m) => m.includes('收尾异常') || m.includes('调度循环退出')),
    'C9c 该异常留下了日志（不是静默死亡）'
  )
  box.loop.stop()
}

// ═══════════════════════════════════════════════════════════════════════════════
// C10. 预算边界扫描 —— 「失效之后才写入」在行为上也发生不了（R2 的行为面）
// ═══════════════════════════════════════════════════════════════════════════════
// C5 钉的是机制（超时那一刻旧 epoch 就失效）；这里把轮次耗时与预算都压到同一量级
// （2–12ms）反复跑，让「写入」与「超时」在时序上真正贴近，再断言三者都不出现：
//   · 失效（timeout）之后才写入 —— R2 的真 violation
//   · 没有超时却被丢弃 —— 静默丢失（AC3 的反面）
//   · 同一轮既写入又被判超时 —— 把成功的一轮报成超时（诚实性）
console.log('\nC10. 预算边界扫描（R2 的行为面）')

{
  const cases = [
    [2, 2],
    [3, 3],
    [4, 4],
    [5, 4],
    [5, 5],
    [5, 6],
    [6, 5],
    [8, 7],
    [10, 9],
    [12, 12]
  ]
  const problems = []
  let finished = 0
  let timeoutsN = 0
  let wrote = 0
  let dropped = 0
  for (const [budgetMs, delayMs] of cases) {
    let seq = 0
    const trace = []
    const box = makeHarness({
      budgetMs,
      intervalImpl: async () => 1,
      roundImpl: async (epoch, current) => {
        await sleep(delayMs)
        const cur = current(epoch)
        trace.push({ kind: cur ? 'write' : 'drop', epoch, seq: seq++ })
      },
      timeoutImpl: (_at, epoch) => trace.push({ kind: 'timeout', epoch, seq: seq++ })
    })
    box.loop.start()
    await sleep(150)
    box.loop.stop()
    await sleep(20)

    const timeoutSeq = new Map()
    for (const ev of trace) if (ev.kind === 'timeout') timeoutSeq.set(ev.epoch, ev.seq)
    for (const ev of trace) {
      if (ev.kind === 'write') {
        wrote += 1
        finished += 1
        const t = timeoutSeq.get(ev.epoch)
        if (t !== undefined && t < ev.seq) {
          problems.push(`失效后写入 budget=${budgetMs} delay=${delayMs} epoch=${ev.epoch}`)
        }
        // 成功写入的一轮**不该**同时留下超时记录：那等于把一次正常收尾报成超时。
        if (t !== undefined) problems.push(`既写入又被判超时 budget=${budgetMs} epoch=${ev.epoch}`)
      } else if (ev.kind === 'drop') {
        dropped += 1
        finished += 1
        if (!timeoutSeq.has(ev.epoch)) problems.push(`无超时的丢弃 budget=${budgetMs} epoch=${ev.epoch}`)
      } else {
        timeoutsN += 1
      }
    }
  }
  ok(problems.length === 0, `C10a 边界扫描没出现「失效后写入」/「无超时的丢弃」（${cases.length} 组，${finished} 轮）`)
  if (problems.length) console.log(`      ${problems.slice(0, 6).join('\n      ')}`)
  ok(finished >= 40, `C10b 前置：确实跑了足够多轮（${finished} 轮，另判超时 ${timeoutsN} 次；太少则上面那条断言接近空洞）`)
  ok(wrote >= 1 && dropped >= 1, `C10c 前置：两种结局都被走到（写入 ${wrote} / 丢弃 ${dropped}）`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// 汇总
// ═══════════════════════════════════════════════════════════════════════════════
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
