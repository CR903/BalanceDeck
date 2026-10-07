// 用量历史快照的落盘存储测试（main/usageStore.ts）
// 用法：node scripts/test-usage-store.mjs
//
// 覆盖：追加 → 读回一致、按天分桶、保留期裁剪、跨天读取与排序、文件损坏重建、
//       脏 retentionDays 回退、以及**一条机制守卫**（不得走 extras —— design.md B2）。
//
// 全部经 loadTs 加载**真实源码**（scripts/lib/load-ts.mjs）：createUsageStore 一个都不内联。
// 落盘位置一律是 mkdtemp 建出来的临时目录：**不得写真实 userData**。

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadTs } from './lib/load-ts.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const { createUsageStore, DEFAULT_RETENTION_DAYS, SNAPSHOT_INTERVAL_MS } =
  await loadTs('src/main/usageStore.ts')
const { MAX_RETENTION_DAYS } = await loadTs('src/shared/usage-predict.ts')

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

const HOUR = 3600_000
const DAY = 24 * HOUR
const T0 = 1_700_000_000_000
/** 与 usageStore 的 dayKey 同一个本地日构造器：造一个「本地日历第 n 天」的基准时刻 */
function dayAt(offsetDays, hour = 12) {
  const d = new Date(T0)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays, hour).getTime()
}
function dayKeyOf(t) {
  const d = new Date(t)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${dd}`
}
/** 一个临时目录 + 一个绑定到它的 store；返回时目录会被清掉 */
function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bd-usage-'))
  const file = join(dir, 'usage-history.json')
  try {
    return fn(createUsageStore({ filePath: () => file }), file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
/** 一条采样 */
const pt = (providerId, window, pct, t) => ({ providerId, window, pct, t })

// ═══ A. 追加 → 读回 ═════════════════════════════════════════════════════════
console.log('\nA. 追加与读回')

withStore((store, file) => {
  store.appendBatch([pt('go', '本月', 40, T0), pt('go', '本周', 20, T0)], T0)
  const r = store.loadRecent('go', 7, T0)
  eq(Object.keys(r).sort(), ['本周', '本月'], 'A1 读回按窗口分组')
  eq(r['本月'], [{ t: T0, pct: 40 }], 'A2 百分比原样读回')
  eq(r['本周'], [{ t: T0, pct: 20 }], 'A3 另一个窗口也读到了')
  ok(existsSync(file), 'A4 落盘文件真的建出来了')
  const raw = JSON.parse(readFileSync(file, 'utf-8'))
  eq(raw.version, 1, 'A5 磁盘格式带 version')
  eq(Object.keys(raw.days), [dayKeyOf(T0)], 'A6 按天分桶（键是 YYYY-MM-DD）')
})

// 同一窗口多次追加 → 累积（不是覆盖）
withStore((store) => {
  store.appendBatch([pt('go', '本月', 40, T0)], T0)
  store.appendBatch([pt('go', '本月', 50, T0 + 15 * 60_000)], T0 + 15 * 60_000)
  eq(store.loadRecent('go', 7, T0 + HOUR)['本月'],
    [{ t: T0, pct: 40 }, { t: T0 + 15 * 60_000, pct: 50 }], 'A7 同窗口多次追加是累积（不是覆盖）')
})

// 空批次与脏条目
withStore((store) => {
  store.appendBatch([], T0)
  eq(store.loadRecent('go', 7, T0), {}, 'A8 空批次不写盘也不报错')
  store.appendBatch([
    null,
    { providerId: '', window: '本月', pct: 10, t: T0 },
    { providerId: 'go', window: '本月', pct: 10, t: Number.NaN },
    pt('go', '本月', 11, T0)
  ], T0)
  eq(store.loadRecent('go', 7, T0)['本月'], [{ t: T0, pct: 11 }],
    'A9 脏条目被跳过（空 id / 非法 t），合法的照常写入')
})

console.log('\nB. 缺失值纪律（pct 不写 0）')

withStore((store) => {
  store.appendBatch([pt('go', '本月', null, T0), pt('go', '本月', 30, T0 + HOUR)], T0 + HOUR)
  const r = store.loadRecent('go', 7, T0 + HOUR)
  eq(r['本月'][0], { t: T0, pct: null }, 'B1 pct=null 落盘仍是 null（不写 0）')
})
// 直接看磁盘上写成了什么（null 不能变成 0）
withStore((store, file) => {
  store.appendBatch([pt('go', '本月', null, T0)], T0)
  const raw = readFileSync(file, 'utf-8')
  ok(raw.includes('"pct":null'), 'B4 磁盘上是 "pct":null（不是 0 —— 缺失值保持缺失）')
  ok(!/"pct":0\b/.test(raw), 'B5 磁盘上没有 "pct":0')
  // 非法 pct（NaN / 字符串）也落成 null
  store.appendBatch([{ providerId: 'go', window: '本月', pct: Number.NaN, t: T0 + HOUR }], T0 + HOUR)
  store.appendBatch([{ providerId: 'go', window: '本月', pct: 'x', t: T0 + 2 * HOUR }], T0 + 2 * HOUR)
  const r = store.loadRecent('go', 7, T0 + 3 * HOUR)
  eq(r['本月'].slice(1).map((p) => p.pct), [null, null], 'B6 NaN / 字符串 pct 落成 null（不写成 0）')
})

console.log('\nC. 保留期裁剪')

withStore((store) => {
  // 造 40 天数据，每天一条
  const pts = []
  for (let i = 39; i >= 0; i--) pts.push(pt('go', '本月', i, dayAt(-i)))
  store.appendBatch(pts, dayAt(0), DEFAULT_RETENTION_DAYS)
  const r = store.loadRecent('go', DEFAULT_RETENTION_DAYS, dayAt(0))
  const first = r['本月'][0]
  ok(first.t >= dayAt(-(DEFAULT_RETENTION_DAYS - 1)),
    `C1 loadRecent 按 ${DEFAULT_RETENTION_DAYS} 天裁（最早一条不早于第 -${DEFAULT_RETENTION_DAYS - 1} 天）`)
  ok(r['本月'].length <= DEFAULT_RETENTION_DAYS, `C2 读回条数 ≤ ${DEFAULT_RETENTION_DAYS}`)
  ok(r['本月'].some((p) => p.t === dayAt(0)), 'C3 今天的采样在读回结果里')
})

// 落盘时就该裁掉过期分桶（appendBatch 里的 dropExpired）
withStore((store, file) => {
  const pts = []
  for (let i = 35; i >= 0; i--) pts.push(pt('go', '本月', i, dayAt(-i)))
  store.appendBatch(pts, dayAt(0), 30)
  const days = Object.keys(JSON.parse(readFileSync(file, 'utf-8')).days)
  ok(days.length <= 30, `C4 落盘时已裁掉超保留期的分桶（实得 ${days.length} 个）`)
  ok(!days.includes(dayKeyOf(dayAt(-35))), 'C5 第 35 天那个桶不在磁盘上（30 天保留期的第一天之外）')
  ok(days.includes(dayKeyOf(dayAt(0))), 'C7 今天那个桶还在')
})

// prune：设置改完之后立即裁，不等下一轮采样
withStore((store, file) => {
  const pts = []
  for (let i = 20; i >= 0; i--) pts.push(pt('go', '本月', i, dayAt(-i)))
  store.appendBatch(pts, dayAt(0), 30)
  const before = Object.keys(JSON.parse(readFileSync(file, 'utf-8')).days).length
  store.prune(dayAt(0), 5)
  const after = Object.keys(JSON.parse(readFileSync(file, 'utf-8')).days).length
  ok(after < before && after <= 5, `C8 prune 立刻裁剪（${before} → ${after} 天，保留期 5）`)
})

console.log('\nD. 脏 retentionDays 落向默认（绝不落向「不裁」）')

withStore((store, file) => {
  const pts = []
  for (let i = 40; i >= 0; i--) pts.push(pt('go', '本月', i, dayAt(-i)))
  store.appendBatch(pts, dayAt(0), Number.NaN)
  let days = Object.keys(JSON.parse(readFileSync(file, 'utf-8')).days)
  ok(days.length <= DEFAULT_RETENTION_DAYS, `D1 NaN → 回退默认 ${DEFAULT_RETENTION_DAYS}（实得 ${days.length}）`)
  store.appendBatch([pt('go', '本月', 99, dayAt(0))], dayAt(0), -5)
  days = Object.keys(JSON.parse(readFileSync(file, 'utf-8')).days)
  ok(days.length <= DEFAULT_RETENTION_DAYS, `D2 负数 → 回退默认（实得 ${days.length}）`)
  store.appendBatch([pt('go', '本月', 98, dayAt(0))], dayAt(0), 9999)
  days = Object.keys(JSON.parse(readFileSync(file, 'utf-8')).days)
  ok(days.length <= 40, `D3 超上限 → 钳到 ${MAX_RETENTION_DAYS}（实得 ${days.length}）`)
})

console.log('\nE. 跨天读取与排序')

withStore((store) => {
  // 一次性写入跨 3 天的点（同一批里分属不同天）
  store.appendBatch([
    pt('go', '本月', 10, dayAt(-2)),
    pt('go', '本月', 30, dayAt(-1)),
    pt('go', '本月', 60, dayAt(0))
  ], dayAt(0))
  const r = store.loadRecent('go', 7, dayAt(0))
  eq(r['本月'].map((p) => p.pct), [10, 30, 60], 'E1 跨天分桶读回后按 t 升序（回归对顺序敏感）')
  const ts = r['本月'].map((p) => p.t)
  ok(ts.every((t, i) => i === 0 || t >= ts[i - 1]), 'E2 时间戳单调不降（切段靠的就是这个顺序）')
})

// 窗口名在不同天不一致时归到各自的桶
withStore((store) => {
  store.appendBatch([pt('go', '本月', 10, dayAt(-1)), pt('go', '本周', 5, dayAt(-1))], dayAt(-1))
  const r = store.loadRecent('go', 7, dayAt(0))
  eq(Object.keys(r).sort(), ['本周', '本月'], 'E3 同一天的两个窗口分别成组')
})

console.log('\nF. 缺供应商 / 缺参数')

withStore((store) => {
  store.appendBatch([pt('go', '本月', 40, T0)], T0)
  eq(store.loadRecent('other', 7, T0), {}, 'F1 查没有的供应商 → 空对象（不是 null）')
  eq(store.loadRecent('', 7, T0), {}, 'F2 空 id → 空对象')
  eq(store.loadRecent('go', Number.NaN, T0)['本月'], [{ t: T0, pct: 40 }],
    'F3 days 非法 → 落向默认保留期（脏值不回退成「不裁」）')
})

console.log('\nG. 文件损坏 → 重建为空（不抛）')

withStore((store, file) => {
  writeFileSync(file, '{ this is not json', 'utf-8')
  let threw = null
  let r
  try {
    r = store.loadRecent('go', 7, T0)
  } catch (e) {
    threw = e
  }
  eq(threw, null, 'G1 损坏文件不抛异常（预测是增值功能，坏了不该让应用起不来）')
  eq(r, {}, 'G2 损坏文件读出空对象')
  // 损坏之后仍可写
  store.appendBatch([pt('go', '本月', 42, T0)], T0)
  eq(store.loadRecent('go', 7, T0)['本月'], [{ t: T0, pct: 42 }], 'G3 重建后仍能正常写入')
})
// version 不认的也重建
withStore((store, file) => {
  writeFileSync(file, JSON.stringify({ version: 99, days: { x: {} } }), 'utf-8')
  eq(store.loadRecent('go', 7, T0), {}, 'G4 version 不认 → 重建为空（不按老格式猜）')
})
// clear
withStore((store) => {
  store.appendBatch([pt('go', '本月', 40, T0)], T0)
  store.clear()
  eq(store.loadRecent('go', 7, T0), {}, 'G5 clear 清空全部历史')
})

console.log('\nH. 机制守卫：不得走 extras（design.md B2）')

// ⚠ 这条是本任务最贵的一条设计约束的守门人。`store.ts` 的 setExtra 每次都全量重写
//   整个文件：30 天 × 60s × N 供应商 ≈ 8–12MB，每 60s 重写一次 ≈ 每天 200GB 写盘。
//   有人「顺手统一成 extras」的那一刻，这条断言必须红。
const storeSrc = readFileSync(resolve(ROOT, 'src/main/usageStore.ts'), 'utf-8')
const storeCode = storeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

ok(storeCode.trim().length > 0, 'H0 前置：模块源码读得到（下面的负向断言不能空洞通过）')
ok(!/from '\.\/keystore'/.test(storeCode), 'H1 usageStore 不 import keystore（不走 extras 通道）')
ok(!/getExtra|setExtra|secrets\.bin/.test(storeCode), 'H2 usageStore 不碰 extras 的读写函数')
ok(/usage-history\.json|filePath/.test(storeSrc), 'H3 落盘路径由调用方注入（usage-history.ts 注入 userData）')
ok(!/from 'electron'/.test(storeCode), 'H4 usageStore 不 import electron（可被 loadTs 在纯 node 里加载）')
ok(!/Date\.now\(|new Date\(\s*\)/.test(storeCode), 'H5 不读自己的钟（now 一律由调用方传入）')

// 装配层必须惰性求值 app.getPath（app ready 之后才拿得到）
const histSrc = readFileSync(resolve(ROOT, 'src/main/usage-history.ts'), 'utf-8')
ok(
  /filePath:\s*\(\)\s*=>/.test(histSrc) && /app\.getPath\('userData'\)/.test(histSrc),
  'H6 装配层用惰性函数拿 userData（静态求值会钉在默认路径上，--uitest / BD_USER_DATA 覆盖时就是错的位置）'
)

// 采样间隔必须是 15 分钟级而不是跟着采集频率走
ok(SNAPSHOT_INTERVAL_MS === 15 * 60_000,
  `H7 快照采样间隔 = 15 分钟（实得 ${SNAPSHOT_INTERVAL_MS / 60_000} 分钟；60s 会让 30 天体积不可接受）`)

// ═══ I. 绝对量（2026-10-07 加，用量热力图下方逐日明细要用）════════════════════
console.log('\nI. 绝对量与 version 1 前向兼容')

withStore((store) => {
  // I1 / I2：used + unit 成对写、成对读回。unit 缺一个，那个数字就没法解释了。
  store.appendBatch([
    { providerId: 'go', window: '本月', pct: 40, used: 4.8, unit: 'usd', t: T0 }
  ], T0)
  const r1 = store.loadRecent('go', 7, T0)['本月']
  eq(r1, [{ t: T0, pct: 40, used: 4.8, unit: 'usd' }], 'I1 used + unit 成对落盘、成对读回')

  // I2：没给 used → 读回里**根本没有这个键**（不是 0、不是 null）。
  // 填 0 会让升级前那几天显示「当天用了 $0.00」，而真实原因是那时还没记绝对量。
  store.appendBatch([{ providerId: 'go', window: '本月', pct: 50, t: T0 + 1000 }], T0)
  const both = store.loadRecent('go', 7, T0)['本月']
  eq(both.length, 2, 'I2 前置：两条都读回来了')
  const p2 = both[both.length - 1]
  eq(p2.pct, 50, 'I2b 没给 used 的那条 pct 正常读回（绝对量缺失不影响百分比）')
  ok(!('used' in p2), 'I2 没给 used → 读回里没有这个键（不是 0、不是 null）')
})

withStore((store) => {
  // I3 / I4：两个字段**独立**判。pct 与 used 在官方 API 里是两份数据，
  // 坏一个不必然坏另一个 —— 谁已知谁被保留，另一个保持 null / undefined。
  store.appendBatch([
    { providerId: 'go', window: '本月', pct: null, used: 2.5, unit: 'usd', t: T0 },
    { providerId: 'go', window: '本月', pct: 30, t: T0 + 1 }
  ], T0)
  const day0 = store.loadRecent('go', 7, T0)['本月']
  const knownPct = day0.filter((p) => p.pct == null)
  eq(knownPct.length, 1, 'I3 前置：有且只有一条 pct=null 的记录')
  eq(knownPct[0].used, 2.5, 'I3 pct 不可知时 used 仍完整保留')
  eq(knownPct[0].unit, 'usd', 'I3b 单位跟着保留')
  const knownUsed = day0.filter((p) => !('used' in p))
  eq(knownUsed.length, 1, 'I4 前置：有且只有一条没有 used 的记录')
  eq(knownUsed[0].pct, 30, 'I4 used 缺失时 pct 仍是真值')
})

withStore((store) => {
  // I5：NaN / Infinity 当未知处理，不落盘 —— 落下去读回的是字符串 "NaN"，会污染计算
  store.appendBatch([
    { providerId: 'go', window: '本月', pct: 10, used: NaN, t: T0 },
    { providerId: 'go', window: '本月', pct: 11, used: Infinity, t: T0 + 1 }
  ], T0)
  const bad = store.loadRecent('go', 7, T0)['本月']
  ok(bad.every((p) => !('used' in p)), 'I5 used 是 NaN / Infinity 时不落盘（读回没有该键）')
  eq(bad.map((p) => p.pct), [10, 11], 'I5b 两条的 pct 都正常保留')
})

withStore((store, file) => {
  // I6：旧文件（没有 used 字段）读回来不报错、不把缺失当成 0
  const d = dayKeyOf(T0)
  writeFileSync(file, JSON.stringify({
    version: 1,
    days: { [d]: { old: [{ window: '本月', t: T0, pct: 25 }] } }
  }), 'utf-8')
  const old = store.loadRecent('old', 7, T0)['本月']
  eq(old, [{ t: T0, pct: 25 }], 'I6 升级前的旧文件读回正常，且没有多出 used: 0')
})

console.log(`\n通过 ${pass} · 失败 ${fail}`)
if (fail > 0) process.exit(1)
