// local-scan-host（src/main/adapters/local-scan-host.ts）—— worker 宿主：正常 / 三种降级 / 迟到丢弃 / 停机
// 用法：node scripts/test-local-scan-host.mjs
//
// 为什么单独成一套：它是本任务**唯一的传输层**，而它的三条纪律全是"沉默型"失败 ——
// 降级不留痕（用户还在卡，没人知道为什么）、超时按往返计（卡在 sqlite 读上就永不回退）、
// 迟到结果覆盖（和 collect-loop 的 epoch 闸门同一类事故）。三条都必须有断言。
//
// 纪律（见 quality-guidelines.md）：
//   · 被测实现用 `loadTs` 加载**真源码**；
//   · 这里的「假 worker」是**真的子线程** —— 临时目录里的真 .mjs 入口，不是 mock。
//     每个 fixture 启动时往 `BD_FIXTURE_LOG` 追加一行，于是"worker 到底起没起"
//     是可数的事实，而不是靠推断（AC3 的负向验证要的正是这个）。

import { loadTs } from './lib/load-ts.mjs'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'

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

/**
 * 轮询等待某个条件成立。
 * 为什么不用固定 `sleep`：worker 的**启动**是异步的（实测 online ≈ 81ms，高负载下更久），
 * 固定睡眠会在负载高时假红 —— 而假红比没有断言更坏（会训练人忽略红灯）。
 */
async function waitFor(cond, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(20)
  }
  return cond()
}

const { createScanHost, DEFAULT_SCAN_TIMEOUT_MS } = await loadTs('src/main/adapters/local-scan-host.ts')

// ─── fixture：真子线程入口 ───────────────────────────────────────────────────
const DIR = mkdtempSync(joinPath(tmpdir(), 'bd-scan-host-'))
const SPAWN_LOG = joinPath(DIR, 'spawns.log')
writeFileSync(SPAWN_LOG, '')
process.env.BD_FIXTURE_LOG = SPAWN_LOG

/** 每个 fixture 的公共头：启动即记账（"worker 真的起来了"这件事要可数） */
const head = (tag) => `
import { appendFileSync } from 'node:fs'
import { parentPort } from 'node:worker_threads'
appendFileSync(process.env.BD_FIXTURE_LOG, ${JSON.stringify(`${tag}\n`)})
`

const RESULT = `{ seq: m.seq, ok: true, rows: 3, tables: [{ name: 'session_message', rows: new Map([[1, { tc: 11, p: { t: 11, cost: 1, tokens: 2, model: 'w' } }]]) }] }`

const fixtures = {
  ok: head('ok') + `parentPort.on('message', (m) => parentPort.postMessage(${RESULT}))\n`,
  throwAtLoad: head('throw') + `throw new Error('boom: fixture 起不来')\n`,
  hangLate:
    head('late') +
    `parentPort.on('message', (m) => { setTimeout(() => parentPort.postMessage(${RESULT}), 300) })\n`,
  unknownShape: head('shape') + `parentPort.on('message', () => parentPort.postMessage('我不是那个形状'))\n`,
  failOnce:
    head('failOnce') +
    `let n = 0
parentPort.on('message', (m) => {
  if (++n === 1) return parentPort.postMessage({ seq: m.seq, ok: false, error: '库读不动' })
  parentPort.postMessage(${RESULT})
})\n`
}

const paths = {}
for (const [name, src] of Object.entries(fixtures)) {
  paths[name] = joinPath(DIR, `${name}.mjs`)
  writeFileSync(paths[name], src)
}
const MISSING = joinPath(DIR, 'does-not-exist.js')

const spawns = () => readFileSync(SPAWN_LOG, 'utf8').split('\n').filter(Boolean)

// ─── 辅助 ────────────────────────────────────────────────────────────────────
/** 只投影可比较的形状：Map 不能直接 JSON.stringify */
const shape = (r) =>
  r === null
    ? null
    : { rows: r.rows, tables: r.tables.map((t) => [t.name, [...t.rows.entries()].map(([k, v]) => [k, v.tc, v.p])]) }

/** 主线程降级实现（宿主把它当参数，不认识它）。`calls` 是"有没有真的回退"的可数证据 */
function fallbackOf(tag, rows = 999) {
  const fn = async () => ({
    rows,
    tables: [{ name: 'main', rows: new Map([[7, { tc: 77, p: { t: 77, cost: 7, tokens: 7, model: tag } }]]) }]
  })
  const out = async () => {
    out.calls++
    return fn()
  }
  out.calls = 0
  return out
}

function makeHost(workerPath, timeoutMs) {
  const logs = []
  const host = createScanHost({ workerPath, timeoutMs, log: (m) => logs.push(m) })
  return { host, logs }
}

const REQ = { dbPath: '/tmp/whatever.db', sinceMs: 1000 }

// ═══════════════════════════════════════════════════════════════════════════════
// H1. 正常：worker 返回 ⇒ via='worker'，主线程降级实现一次都不跑
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nH1. 正常路径（via=worker）')

{
  const { host, logs } = makeHost(paths.ok, 15_000)
  const fb = fallbackOf('main')
  const before = spawns().length
  const r = await host.runFull(REQ, fb)
  eq(r.via, 'worker', 'H1a worker 在预算内返回 ⇒ via=worker')
  eq(shape(r.result), { rows: 3, tables: [['session_message', [[1, 11, { t: 11, cost: 1, tokens: 2, model: 'w' }]]]] }, 'H1b 结果原样透传（Map 经 structured clone 后仍是 Map）')
  eq(fb.calls, 0, 'H1c 走通 worker 时**一次都不回退**主线程')
  eq(spawns().length - before, 1, 'H1d worker 是**真的**起来了（fixture 启动记账 +1）')
  eq(host.lastRun().via, 'worker', 'H1e lastRun().via = worker')
  ok(host.lastRun().degradedReason === undefined, 'H1f 走通时**没有** degradedReason（缺失就是缺失）')
  eq(logs, [], 'H1g 走通时不打降级日志（否则日志会被常态淹掉）')

  // 第二个请求复用同一个线程（不是每次都新起）
  const r2 = await host.runFull(REQ, fb)
  eq(r2.via, 'worker', 'H1h 第二次仍走 worker')
  eq(spawns().length - before, 1, 'H1i 复用同一个 worker 线程（不重复起线程）')
  await host.stop()
}

// ═══════════════════════════════════════════════════════════════════════════════
// H2/H3. 起不来：入口不存在 / 顶层抛错 ⇒ 降级 + **留痕**
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nH2/H3. worker 起不来 ⇒ 降级必须留痕')

{
  const { host, logs } = makeHost(MISSING, 15_000)
  const fb = fallbackOf('main')
  const r = await host.runFull(REQ, fb)
  eq(r.via, 'main', 'H2a 入口不存在 ⇒ via=main')
  eq(shape(r.result), shape(await fallbackOf('main')()), 'H2b 结果**完整**（原样来自主线程降级实现）')
  eq(fb.calls, 1, 'H2c 主线程降级实现恰好被调用一次')
  ok(
    typeof host.lastRun().degradedReason === 'string' && host.lastRun().degradedReason.length > 0,
    'H2d degradedReason 有值（**去掉它即红** —— 静默降级是本任务要消灭的东西）'
  )
  const why = host.lastRun().degradedReason ?? ''
  ok(/Cannot find module|worker/i.test(why), `H2e 原因里带着真实路径/成因（${why.slice(0, 60)}…）`)
  ok(logs.some((l) => l.includes('降级')), 'H2f 降级写进了日志出口（产品注入的是 debugLog）')
  await host.stop()
}

{
  const { host, logs } = makeHost(paths.throwAtLoad, 15_000)
  const fb = fallbackOf('main')
  const r = await host.runFull(REQ, fb)
  eq(r.via, 'main', 'H3a worker 顶层抛错 ⇒ via=main')
  ok((host.lastRun().degradedReason ?? '').includes('boom'), 'H3b degradedReason 带上了 worker 自己的错误文本')
  eq(fb.calls, 1, 'H3c 回退主线程一次')
  ok(logs.some((l) => l.includes('降级')), 'H3d 留痕')
  await host.stop()
}

// ═══════════════════════════════════════════════════════════════════════════════
// H4. 超时：按**整次扫描**计 + 迟到结果必须丢弃
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nH4. 超时与迟到结果')

{
  const { host, logs } = makeHost(paths.hangLate, 80)
  const fb = fallbackOf('main')
  const t0 = Date.now()
  const r = await host.runFull(REQ, fb)
  const spent = Date.now() - t0
  ok(spent < 3000, `H4a 在超时量级内回退（${spent}ms < 3000ms，预算 80ms）`)
  eq(r.via, 'main', 'H4b 超时 ⇒ via=main')
  ok((host.lastRun().degradedReason ?? '').includes('超时'), 'H4c degradedReason 说明是超时')
  eq(fb.calls, 1, 'H4d 回退主线程一次')
  eq(shape(r.result), shape(await fallbackOf('main')()), 'H4e 采用的结果是主线程的')

  // worker 在 300ms 才回来 —— 必须被丢弃，且不得改变 lastRun
  const sawDiscard = await waitFor(() => logs.some((l) => l.includes('丢弃')), 8000)
  ok(sawDiscard, 'H4f 迟到结果被**丢弃并留痕**（去掉判据即红）')
  eq(host.lastRun().via, 'main', 'H4g 迟到结果没有覆盖已采用的结果（与 collect-loop 的 epoch 闸门同一纪律）')
  eq((host.lastRun().degradedReason ?? '').includes('超时'), true, 'H4h lastRun 仍是那次超时（不是迟到的 worker 结果）')

  // 卡住的线程必须被换掉：下一个请求仍然要能跑通
  await host.stop()
}

{
  // 超时过的线程必须被**换掉**（同步 sqlite 读没法取消，卡住的线程只会一直卡着）
  const { host } = makeHost(paths.hangLate, 80)
  const fb = fallbackOf('main')
  const before = spawns().length
  await host.runFull(REQ, fb)
  await waitFor(() => spawns().length - before >= 1, 8000)
  eq(spawns().length - before, 1, 'H4i 第一个 worker 线程起来了')
  await host.runFull(REQ, fb)
  await waitFor(() => spawns().length - before >= 2, 8000)
  eq(spawns().length - before, 2, 'H4j 超时过的线程被换掉（第二次是新线程，不是又撞同一个卡死的线程）')
  await host.stop()
}

// ═══════════════════════════════════════════════════════════════════════════════
// H5. 停机：幂等 + 不再起线程 + 不遗留定时器
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nH5. 停机')

{
  const timerCount = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  const baseline = timerCount()
  const { host } = makeHost(paths.ok, 30_000)
  await host.runFull(REQ, fallbackOf('main'))
  const beforeStop = spawns().length
  await host.stop()
  await host.stop() // 幂等：第二次不许抛
  ok(true, 'H5a stop() 幂等（连续两次都正常返回）')

  const fb = fallbackOf('main')
  const r = await host.runFull(REQ, fb)
  eq(r.via, 'main', 'H5b stop() 之后 runFull 直接走主线程')
  ok((host.lastRun().degradedReason ?? '').includes('停机'), 'H5c degradedReason 说明是停机（不是"没配 worker"）')
  eq(spawns().length - beforeStop, 0, 'H5d stop() 之后**不再起** worker 线程')
  await sleep(30)
  const after = timerCount()
  ok(after <= baseline, `H5e 没有遗留定时器（Timeout ${baseline} → ${after}）`)
}

{
  // 有在飞请求时停机：pending 的定时器也必须被清掉（否则 30s 后还会响一次）
  const timerCount = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  const baseline = timerCount()
  const { host } = makeHost(paths.hangLate, 30_000)
  const p = host.runFull(REQ, fallbackOf('main'))
  await sleep(30)
  await host.stop()
  const r = await p
  eq(r.via, 'main', 'H5f 在飞请求被停机打断 ⇒ 同样回退主线程（不会永远挂着）')
  await sleep(30)
  ok(timerCount() <= baseline, `H5g 在飞请求的超时定时器也被清掉（Timeout ${baseline} → ${timerCount()}）`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// H6. 没配路径 / 不认识的形状 / worker 自己报错（线程仍然健康）
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nH6. 其余边界')

{
  const { host, logs } = makeHost('', 15_000)
  const fb = fallbackOf('main')
  const r = await host.runFull(REQ, fb)
  eq(r.via, 'main', 'H6a 没配 worker 路径 ⇒ 直接主线程')
  ok((host.lastRun().degradedReason ?? '').includes('未配置'), 'H6b 原因说明是"未配置"（不是"起不来"）')
  ok(logs.some((l) => l.includes('降级')), 'H6c 同样留痕')
  await host.stop()
}

{
  const { host, logs } = makeHost(paths.unknownShape, 15_000)
  const p = host.runFull(REQ, fallbackOf('main'))
  const seen = await waitFor(() => logs.some((l) => l.includes('不认识的形状')), 10_000)
  ok(seen, 'H6d 未知形状有出口（留痕），不是静默吞掉')
  ok(!logs.some((l) => l.includes('降级')), 'H6e 形状不认识时**不冒充成功**：既没结算、也没提前降级')
  await host.stop()
  eq((await p).via, 'main', 'H6f 那条请求最终被结算为降级（不会永远挂着）')
}

{
  const { host } = makeHost(paths.failOnce, 15_000)
  const fb = fallbackOf('main')
  const r1 = await host.runFull(REQ, fb)
  eq(r1.via, 'main', 'H6f worker 回 ok:false ⇒ 降级')
  ok((host.lastRun().degradedReason ?? '').includes('库读不动'), 'H6g 把 worker 报的错原样带出来')
  const r2 = await host.runFull(REQ, fb)
  eq(r2.via, 'worker', 'H6h worker **自己**报错不算线程坏掉：下一个请求仍然用它（不必重起线程）')
  await host.stop()
}

// ═══════════════════════════════════════════════════════════════════════════════
// H7. 静态守卫
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nH7. 静态守卫')

{
  eq(DEFAULT_SCAN_TIMEOUT_MS >= 10_000, true, `H7a 缺省超时 ≥ 10s（全量实测最坏 4.4s，当前 ${DEFAULT_SCAN_TIMEOUT_MS}ms）`)
  const src = readFileSync(new URL('../src/main/adapters/local-scan-host.ts', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ok(!/electron/.test(code), 'H7b 宿主不 import electron（纯传输层，可被 loadTs 加载）')
  ok(!/opencode-local/.test(code.replace(/import type[^\n]*\n/g, '')), 'H7c 宿主不**运行时**依赖 opencode-local（降级实现由调用方注入 —— 换 utilityProcess 时调用方不动）')
  ok(code.includes('workerBad'), 'H7d 卡住的线程会被换掉（去掉 workerBad 即红：超时后每次都会撞同一个死线程）')
}

// ─── 收尾 ────────────────────────────────────────────────────────────────────
rmSync(DIR, { recursive: true, force: true })
delete process.env.BD_FIXTURE_LOG

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
