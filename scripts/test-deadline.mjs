// withDeadline —— 把「永不 settle」变成「有界失败」
// 用法：node scripts/test-deadline.mjs
//
// 本套件加载**真源码**（loadTs），不内联副本 —— 见 quality-guidelines.md
// 「不要把实现内联进测试」。
//
// 为什么单独成一套：它是 R1/R3 的公共地基。「卡在建连前阶段的 fetch 不受
// AbortController 约束」是 2026-10-18 真机取证的结论（lsof 零连接 + 线程陷在
// select()），而**唯一**能兜住它的手段就是「有界返回」。这里钉四条：
//   ① 正常路径原样给值；② 永不 settle 在预算量级内返回 timeout；
//   ③ 预算内 reject **原样抛出**（不吞异常，否则「超时」与「真失败」不可区分）；
//   ④ 超时后迟到的 resolve / reject 都不得改变已返回的结果，也不得产生
//      unhandled rejection（超时之后才 settle 是正常路径，不是异常路径）。

import { loadTs } from './lib/load-ts.mjs'

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

const { withDeadline } = await loadTs('src/main/deadline.ts')

/** 进程级未处理拒绝：超时后迟到的 reject 若没人接住会走到这里 */
const unhandled = []
process.on('unhandledRejection', (e) => unhandled.push(e))

// ═══════════════════════════════════════════════════════════════════════════════
// D1. 正常路径：原样给值（不吞、不改、不延迟）
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nD1. 预算内 settle —— 原样给值')

{
  const r = await withDeadline(Promise.resolve(7), 1000)
  eq(r, { ok: true, value: 7 }, 'D1a resolve → { ok: true, value }')
}

{
  const obj = { a: 1 }
  const r = await withDeadline(Promise.resolve(obj), 1000)
  ok(r.ok === true && r.value === obj, 'D1b 值按**同一个引用**传出（没有中途克隆/重塑）')
}

{
  const t0 = Date.now()
  await withDeadline(sleep(10).then(() => 'x'), 1000)
  const spent = Date.now() - t0
  ok(spent < 500, `D1c 预算内不等满预算（${spent}ms < 500ms）`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// D2. 永不 settle：在预算量级内返回 timeout（R1/R3 的核心）
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nD2. 永不 settle —— 预算到了必须返回')

{
  const t0 = Date.now()
  const r = await withDeadline(new Promise(() => {}), 30)
  const spent = Date.now() - t0
  eq(r, { ok: false, reason: 'timeout' }, 'D2a 永不 settle → { ok: false, reason: "timeout" }')
  ok(spent >= 25, `D2b 真的是等到了预算（${spent}ms ≥ 25ms），不是提前返回`)
  ok(spent < 500, `D2c 也不会超预算太多（${spent}ms < 500ms）`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// D3. 预算内 reject：**原样抛出**（纪律：不吞异常）
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nD3. 预算内 reject —— 原样抛出，不转成 timeout')

{
  const boom = new TypeError('fetch failed')
  let thrown = null
  let resolved = null
  try {
    resolved = await withDeadline(Promise.reject(boom), 1000)
  } catch (e) {
    thrown = e
  }
  eq(resolved, null, 'D3a reject 不会被压成 { ok: false }（两者混同会丢掉失败原因）')
  ok(thrown === boom, 'D3b 抛出的是**同一个**错误对象（原样，不包装）')
}

{
  const boom = Object.assign(new Error('aborted'), { name: 'AbortError' })
  let thrown = null
  try {
    await withDeadline(sleep(5).then(() => Promise.reject(boom)), 1000)
  } catch (e) {
    thrown = e
  }
  ok(thrown?.name === 'AbortError', 'D3c 异步 reject 同样原样抛出（name 保留 → isNetworkError 仍判网络类）')
}

// ═══════════════════════════════════════════════════════════════════════════════
// D4. 超时之后迟到 settle：不得改变已返回的结果
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nD4. 超时后迟到 settle —— 结果不变、不产生 unhandled rejection')

{
  let lateResolve = null
  const hanging = new Promise((res) => {
    lateResolve = res
  })
  const r = await withDeadline(hanging, 20)
  eq(r, { ok: false, reason: 'timeout' }, 'D4a 先拿到 timeout')
  lateResolve('迟到的好消息')
  await sleep(20)
  eq(r, { ok: false, reason: 'timeout' }, 'D4b 迟到 resolve 不改变已返回的结果（调用方已按「本轮作废」处理）')
  eq(unhandled.length, 0, 'D4c 没有 unhandled rejection')
}

{
  let lateReject = null
  const hanging = new Promise((_res, rej) => {
    lateReject = rej
  })
  const r = await withDeadline(hanging, 20)
  eq(r, { ok: false, reason: 'timeout' }, 'D4d 先拿到 timeout')
  lateReject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  await sleep(20)
  eq(unhandled.length, 0, 'D4e 迟到的 reject 被接住（否则进程级告警会出现在正常路径上）')
}

// ═══════════════════════════════════════════════════════════════════════════════
// 汇总
// ═══════════════════════════════════════════════════════════════════════════════
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
