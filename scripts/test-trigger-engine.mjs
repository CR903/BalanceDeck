// 智能播报触发引擎测试（历史采样 + 5 场景判定 + 播报文案合并）
// 用法：node scripts/test-trigger-engine.mjs
//
// 覆盖：采样封顶、统计的样本量门槛、lastSeen 的口径、5 个场景各自在阈值两侧的边界、
//       缺失值不得当成 0、分级、同轮合并去重（AC12）、隐藏余额不泄露金额（AC10/AC12）、
//       播报锁存（AC9 恰好一次）、调用方的「先判后记」时序（AC4 不静默失效）。
//
// 全部经 loadTs 加载**真实源码**（scripts/lib/load-ts.mjs）——不内联实现副本：
// 内联过的 test-percent.mjs 已经漂移过一次，源文件改了测试还绿着，等于没有测试。

import { loadTs } from './lib/load-ts.mjs'

const hist = await loadTs('src/renderer/src/history.ts')
const sb = await loadTs('src/renderer/src/smartBroadcast.ts')
const { appendPoint, statsFor, lastSeen, DEFAULT_HISTORY_CAP, MIN_POINTS_FOR_ANOMALY } = hist
const { checkTriggers, mergeHits, resolveConfig, balanceOf, freshHits, latchKeys, hitKey, DEFAULT_TRIGGER_CONFIG, TRIGGER_LEVEL, THRESHOLD_FIELD } = sb

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
/** 子串出现次数（「名字只念一遍」这类断言用它，而不是 includes） */
function times(hay, needle) {
  return hay.split(needle).length - 1
}

const HOUR = 3600_000
const T0 = 1_700_000_000_000
const ISO = '2026-09-29T00:00:00.000Z'

const win = (o = {}) => ({ name: '本月', used: 0, limit: 60, unit: 'usd', percent: 0, ...o })
const snap = (o = {}) => ({
  id: 'x',
  name: 'X',
  kind: 'coding',
  builtin: true,
  status: 'ok',
  windows: [],
  updatedAt: ISO,
  ...o
})
const pt = (o = {}) => ({ t: T0, id: 'x', balance: null, percent: null, ...o })
/** 充值余额型（kind=balance）：窗口的 used 本身就是账户余额 */
const cash = (balance, o = {}) => snap({ id: 'cash', name: 'DeepSeek', kind: 'balance', windows: [{ name: '账户余额', used: balance, unit: 'cny' }], ...o })
/** 套餐型（kind=coding）：默认三窗口里的「本月」 */
const planPct = (o = {}) => snap({ id: 'go', name: 'OpenCode Go', windows: [win(o)] })

const CFG = DEFAULT_TRIGGER_CONFIG
// 断言只盯着**被测的那个场景**：同一份数据常常同时命中两三个场景，
// 「整体等于某个数组」会把无关场景一起断言进来，测试就变成了在测别的东西。
const hitsOf = (snaps, history = [], cfg = CFG) => checkTriggers(snaps, history, cfg, T0)
const has = (kind, snaps, history = [], cfg = CFG) => hitsOf(snaps, history, cfg).some((x) => x.kind === kind)
const hitOf = (kind, snaps, history = [], cfg = CFG) => hitsOf(snaps, history, cfg).find((x) => x.kind === kind)

// 结算：checkTriggers 的第一个命中 kind
const kindOf = (hits) => hits.map((h) => h.kind).sort()

console.log('\nA. 采样封顶（cap 恒生效，超出丢最旧）')

let h = []
for (let i = 0; i < 5; i++) h = appendPoint(h, pt({ t: T0 + i, balance: i }), 3)
eq(h.length, 3, 'A1 cap=3 连续追加 5 条 → 长度恒为 3')
eq(h.map((p) => p.t), [T0 + 2, T0 + 3, T0 + 4], 'A2 丢最旧的，保留最新三条')
eq(h.map((p) => p.balance), [2, 3, 4], 'A3 丢的确实是开头那两条')

let big = []
for (let i = 0; i < 101; i++) big = appendPoint(big, pt({ t: T0 + i }))
eq(big.length, DEFAULT_HISTORY_CAP, 'A4 不传 cap → 用默认上限 100（AC13）')
eq(DEFAULT_HISTORY_CAP, 100, 'A5 默认上限就是 100')

const src = [pt({ t: 1 })]
appendPoint(src, pt({ t: 2 }), 1)
eq(src.length, 1, 'A6 纯函数：入参数组不被就地修改')

let bad = appendPoint([pt({ t: 1 }), pt({ t: 2 }), pt({ t: 3 })], pt({ t: 4 }), 0)
eq(bad.length, 4, 'A7 cap=0 是脏值 → 退回默认上限（历史不会被清空：清空等于异常检测永久失效）')
eq(appendPoint([pt({ t: 1 })], pt({ t: 2 }), NaN).length, 2, 'A8 cap=NaN 同样退回默认')

console.log('\nB. statsFor：样本量门槛 + null 不参与统计')

const flat = (id, n, v) => Array.from({ length: n }, (_, i) => pt({ t: T0 + i, id, percent: v }))
eq(MIN_POINTS_FOR_ANOMALY, 10, 'B1 门槛就是 10 条')
eq(statsFor(flat('a', 9, 50), 'a'), null, 'B2 n=9 → null（AC10 不误报）')
eq(statsFor(flat('a', 10, 50), 'a')?.n, 10, 'B3 n=10 → 出统计')
eq(statsFor([], 'a'), null, 'B4 空历史 → null')
eq(statsFor(flat('a', 30, 20), 'b'), null, 'B5 别的供应商的点不参与')

const withNulls = Array.from({ length: 10 }, (_, i) => pt({ t: T0 + i, id: 'a', percent: i < 9 ? null : 50 }))
eq(statsFor(withNulls, 'a'), null, 'B6 10 条里 9 条是 null → 仍不足 10（null 不计入 n）')
eq(statsFor(Array.from({ length: 10 }, (_, i) => pt({ t: T0 + i, id: 'a', percent: 20 })), 'a')?.avg, 20, 'B7 10 条 × 20 → 均值 20')
eq(statsFor(Array.from({ length: 10 }, (_, i) => pt({ t: T0 + i, id: 'a', percent: 20 })), 'a')?.peak, 20, 'B8 峰值')
const spread = Array.from({ length: 10 }, (_, i) => pt({ t: T0 + i, id: 'a', percent: i < 5 ? 0 : 100 }))
eq(statsFor(spread, 'a')?.avg, 50, 'B9 0/100 各 5 条 → 均值 50（总体标准差口径）')
eq(statsFor(spread, 'a')?.stddev, 50, 'B10 标准差 50')
eq(statsFor([...flat('a', 5, 88), ...flat('a', 5, 10)], 'a')?.peak, 88, 'B11 峰值取最大的那条')

console.log('\nC. lastSeen：只有「相邻两条的差」才算用过')

eq(lastSeen([], 'a', T0), null, 'C1 没有这个供应商 → null')
eq(lastSeen([pt({ t: 1, id: 'a', percent: 10 })], 'a', T0), 1, 'C2 只有一条有数据 → 就是它的 t（基线）')
eq(lastSeen([pt({ t: 1, id: 'a' }), pt({ t: 2, id: 'a' })], 'a', T0), null, 'C3 全是缺失值 → null（不是「从没用过」，是「看不出来」）')

const idle = [1, 2, 3, 4].map((i) => pt({ t: i, id: 'a', percent: 40 }))
eq(lastSeen(idle, 'a', T0), 1, 'C4 全程无变化 → 最早那条有数据的 t（只证明到这里，不外推）')

const moved = [1, 2, 3, 4].map((i) => pt({ t: i, id: 'a', percent: i < 3 ? 40 : 55 }))
eq(lastSeen(moved, 'a', T0), 3, 'C5 最后一次变化在 t=3，之后两条没动')

const gap = [pt({ t: 1, id: 'a', percent: 40, balance: 100 }), pt({ t: 2, id: 'a' }), pt({ t: 3, id: 'a', percent: 40, balance: 100 })]
eq(lastSeen(gap, 'a', T0), 1, 'C6 中途这次采集失败不算「用过」：首尾数值相同 → 证明不了变化，能证明的只有 t=1 起（不是 t=3）')
const allNull = [pt({ t: 1, id: 'a' }), pt({ t: 2, id: 'a' }), pt({ t: 3, id: 'a', percent: 40 })]
eq(lastSeen(allNull, 'a', T0), 3, 'C6b 前面几条全缺、只有最新一条有数 → 只能从这一条起算')

const balMoved = [1, 2].map((i) => pt({ t: i, id: 'a', percent: 40, balance: 100 - i * 30 }))
eq(lastSeen(balMoved, 'a', T0), 2, 'C7 余额变了也算用过（用量率没变也一样）')
eq(lastSeen([pt({ t: T0 + 999, id: 'a', percent: 1 })], 'a', T0), T0, 'C8 数据时间晚于 now → 钳到 now，不算出负的「距今」')

console.log('\nD. 余额预警：余额 < 阈值（缺余额不判，套餐型比的是「还剩多少」）')

const base = snap({ id: 'go', name: 'OpenCode Go', windows: [win({ used: 58, limit: 60, percent: 95 })] })
eq(kindOf(checkTriggers([cash(8)], [], CFG, T0)), ['balance'], 'D1 余额 8 < 10 → 触发')
eq(checkTriggers([cash(10)], [], CFG, T0).length, 0, 'D2 余额正好 10（等于阈值）→ 不触发')
eq(kindOf(checkTriggers([cash(9.99)], [], CFG, T0)), ['balance'], 'D3 余额 9.99 越过阈值 → 触发')
eq(checkTriggers([cash(10.01)], [], CFG, T0).length, 0, 'D3b 余额 10.01 还在阈值之上 → 不触发')
eq(checkTriggers([cash(8, { status: 'error' })], [], CFG, T0).length, 0, 'D4 error → 不判')
eq(checkTriggers([cash(8, { status: 'nodata' })], [], CFG, T0).length, 0, 'D5 nodata → 不判')
eq(checkTriggers([snap({ id: 'e', name: 'E', windows: [] })], [], CFG, T0).length, 0, 'D6 没有窗口 → 不判')

const noLimit = snap({ id: 'go', name: 'OpenCode Go', windows: [win({ used: 58, percent: 95, limit: undefined })] })
eq(kindOf(checkTriggers([noLimit], [], CFG, T0)), ['exhaustion'], 'D7 套餐限额未知 → 余额判不了，只有耗尽命中（**没拿 0 冒充余额**）')
eq(has('balance', [noLimit]), false, 'D7b 同一个供应商加上 limit 60/used 58 才会判余额（对照组：差别只在限额）')
eq(has('balance', [base]), true, 'D8 有 limit 60 / used 58 → 还剩 2 < 10，触发')
eq(hitOf('balance', [base])?.detail, '余额不足，剩余 2 元', 'D8b 套餐型报的是「还剩多少」，不是「已用多少」')
eq(checkTriggers([snap({ id: 'g', name: 'G', windows: [win({ used: 50, limit: 60, percent: 50 })] })], [], CFG, T0).length, 0, 'D9 剩余正好 10 → 不触发')
eq(checkTriggers([cash(8)], [], CFG, T0)[0]?.detail, '余额不足，剩余 8 元', 'D10 文案带确切金额')
eq(checkTriggers([cash(8)], [], CFG, T0)[0]?.level, 'urgent', 'D11 余额预警是紧急级')

// balanceOf 是对外的口径函数（采样与设置页都要用），单独立一组
eq(balanceOf(cash(8)), 8, 'D12 充值余额型：窗口数值就是剩余')
eq(balanceOf(base), 2, 'D13 套餐型：最紧张窗口的 limit − used')
const twoWin = snap({ id: 'go', name: 'Go', windows: [win({ name: '5 小时', used: 1, limit: 10, percent: 10 }), win({ name: '本月', used: 25, limit: 60, percent: 42 })] })
eq(balanceOf(twoWin), 35, 'D14 多窗口取最紧张那个的剩余（本月 60−25，而不是 5 小时那个）')
eq(balanceOf(noLimit), null, 'D15 套餐限额未知 → null（不是 0）')
eq(balanceOf(snap({ id: 'e', name: 'E', kind: 'balance', windows: [] })), null, 'D16 没有窗口 → null')
eq(balanceOf(cash(8, { status: 'error' })), 8, 'D17 只看 kind 与窗口，不看 status（status 由 checkTriggers 把关）')
eq(THRESHOLD_FIELD.balance, 'balanceLow', 'D18 场景→阈值字段的映射由本模块说了算（设置页别再各写一份）')
eq(THRESHOLD_FIELD.abnormal, 'abnormalMul', 'D19 同上')

// 阈值是 extras 里读回来的 JSON，脏值必须落到「不触发」而不是「每次都报」
const quiet = [pt({ t: T0 - 30 * HOUR, id: 'cash', balance: 100, percent: 10 }), pt({ t: T0 - HOUR, id: 'cash', balance: 100, percent: 10 })]
// 套餐超额用（used 65 / limit 60 → 剩余 −5）时余额确实是负数，负阈值就会每轮报「余额不足」
const overdrawn = [snap({ id: 'go', name: 'Go', windows: [win({ used: 65, limit: 60, percent: 100 })] })]
eq(checkTriggers(overdrawn, [], { ...CFG, balanceLow: -1 }, T0).filter((x) => x.kind === 'balance').length, 0, 'D20 阈值是负数 → 不触发（否则超额套餐每轮都报「余额不足，剩余 −5 元」）')
eq(kindOf(checkTriggers(overdrawn, [], CFG, T0)), ['balance', 'exhaustion'], 'D20b 对照：同一份数据在正常阈值下**会**报余额（所以 D20 的红来自阈值脏值，不是数据本来就不触发）')
eq(checkTriggers([cash(8)], [], { ...CFG, balanceLow: NaN }, T0).length, 0, 'D21 阈值是 NaN → 不触发')
eq(checkTriggers([cash(8)], [], { ...CFG, balanceLow: 0 }, T0).length, 0, 'D22 阈值是 0 → 不触发（等于关掉这个场景，而不是变成「余额必须为负」）')
eq(checkTriggers([planPct({ percent: 95 })], [], { ...CFG, exhaustionPct: -1 }, T0).length, 0, 'D23 耗尽阈值是负数 → 不触发')
eq(checkTriggers([cash(100)], quiet, { ...CFG, idleHours: -1 }, T0).length, 0, 'D24 未使用阈值是负数 → 不触发（对照组：同数据配正常阈值会报）')
eq(kindOf(checkTriggers([cash(100)], quiet, CFG, T0)), ['idle'], 'D24b 对照：阈值正常时同样的数据会报')
eq(checkTriggers([cash(88)], [pt({ t: T0 - HOUR, id: 'cash', balance: 100 })], { ...CFG, fluctuation: -1 }, T0).length, 0, 'D25 波动阈值是负数 → 不触发')
eq(checkTriggers([planPct({ used: 30, limit: 60, percent: 88 })], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => pt({ t: T0 - i * HOUR, id: 'go', balance: 60, percent: 10 })), { ...CFG, abnormalMul: 0 }, T0).filter((x) => x.kind === 'abnormal').length, 0, 'D26 异常倍数是 0 → 不触发（对照：倍数 2 时同数据会报）')
// 供应商没名字时用 id 兜底（App.tsx:278 同一口径）
eq(checkTriggers([cash(8, { name: '' })], [], CFG, T0)[0]?.name, 'cash', 'D27 供应商没有名字 → 用 id 兜底')
eq(mergeHits(checkTriggers([cash(8, { name: '' })], [], CFG, T0), 'detailed'), 'cash 余额不足，剩余 8 元', 'D28 文案里也用 id，不出现「，余额不足」这种缺主语的句子')

console.log('\nE. 用量波动：单次增长 > 阈值（金额口径优先，限额未知才退到百分点）')

const prevBal = (balance) => [pt({ t: T0 - HOUR, id: 'cash', balance, percent: null })]
eq(kindOf(checkTriggers([cash(88)], prevBal(100), CFG, T0)), ['fluctuation'], 'E1 100 → 88 = 花掉 12 > 10 → 触发')
eq(checkTriggers([cash(90)], prevBal(100), CFG, T0).length, 0, 'E2 正好花掉 10（等于阈值）→ 不触发')
eq(kindOf(checkTriggers([cash(89.99)], prevBal(100), CFG, T0)), ['fluctuation'], 'E3 花掉 10.01 → 触发')
eq(checkTriggers([cash(110)], prevBal(100), CFG, T0).length, 0, 'E4 余额反而涨了（充值）→ 不报「用量增长」')
eq(checkTriggers([cash(88)], [pt({ t: T0 - HOUR, id: 'cash', percent: null })], CFG, T0).length, 0, 'E5 上一次没采到余额 → 不判（不拿 0 当「上次有 0」）')
eq(checkTriggers([cash(88)], [], CFG, T0).length, 0, 'E6 冷启动没有历史 → 不判')
eq(checkTriggers([cash(88)], prevBal(100), CFG, T0)[0]?.detail, '单次用量增长 12 元', 'E7 文案是金额口径')

const prevPct = (percent) => [pt({ t: T0 - HOUR, id: 'go', balance: null, percent })]
eq(kindOf(checkTriggers([planPct({ used: 3, percent: 55 })], prevPct(40), CFG, T0)), ['fluctuation'], 'E8 套餐用量率 40 → 55 = 涨 15 个百分点 > 10 → 触发')
eq(checkTriggers([planPct({ used: 3, percent: 50 })], prevPct(40), CFG, T0).length, 0, 'E9 正好涨 10 个百分点 → 不触发')
eq(checkTriggers([planPct({ used: 3, percent: 55 })], prevPct(55), CFG, T0).length, 0, 'E10 用量率没变 → 不触发')
eq(hitOf('fluctuation', [planPct({ used: 3, percent: 55 })], prevPct(40))?.detail, '用量率单次上涨 15 个百分点', 'E11 文案说清是百分点（量纲不同，不含糊）')
eq(hitOf('fluctuation', [planPct({ used: 3, percent: 55 })], prevPct(40))?.level, 'urgent', 'E12 波动是紧急级')

console.log('\nF. 用量耗尽：用量率 > 阈值（取最大的那个窗口）')

eq(kindOf(checkTriggers([planPct({ percent: 90.1 })], [], CFG, T0)), ['exhaustion'], 'F1 90.1 > 90 → 触发')
eq(checkTriggers([planPct({ percent: 90 })], [], CFG, T0).length, 0, 'F2 正好 90 → 不触发')
eq(checkTriggers([planPct({ percent: 30 })], [], CFG, T0).length, 0, 'F3 30% → 不触发')
const multi = snap({ id: 'go', name: 'OpenCode Go', windows: [win({ name: '5 小时', percent: 5 }), win({ name: '本月', percent: 92 })] })
eq(checkTriggers([multi], [], CFG, T0)[0]?.detail, '用量已用 92%', 'F4 多窗口取最大的那个说')
eq(checkTriggers([multi], [], CFG, T0)[0]?.level, 'urgent', 'F5 耗尽是紧急级')

console.log('\nG. 长时间未使用：静默时长 > 阈值小时')

const silent = (hours) => Array.from({ length: 4 }, (_, i) => pt({ t: T0 - hours * HOUR + i * 60_000, id: 'cash', balance: 100, percent: 10 }))
eq(checkTriggers([cash(100)], silent(24), CFG, T0).length, 0, 'G1 恰好静默 24 小时 → 不触发')
eq(kindOf(checkTriggers([cash(100)], silent(24.01), CFG, T0)), ['idle'], 'G2 静默超过 24 小时 → 触发')
eq(checkTriggers([cash(100)], [], CFG, T0).length, 0, 'G3 没有历史 → 判不出「多久没用过」→ 不触发')
eq(checkTriggers([cash(100)], silent(30), CFG, T0)[0]?.detail, '已 30 小时无用量变化', 'G4 文案里的时长向下取整（宁少报不多报）')
eq(checkTriggers([cash(100)], silent(30), CFG, T0)[0]?.level, 'routine', 'G5 未使用是例行级')
const stillBusy = [pt({ t: T0 - 48 * HOUR, id: 'cash', balance: 100, percent: 10 }), pt({ t: T0 - 5 * 60_000, id: 'cash', balance: 90, percent: 10 })]
eq(checkTriggers([cash(90)], stillBusy, CFG, T0).length, 0, 'G6 5 分钟前还在用 → 不报未使用')

console.log('\nH. 异常模式：用量率 > 历史均值 × 倍数（历史不足一律不判）')

const hist9 = Array.from({ length: 9 }, (_, i) => pt({ t: T0 - (9 - i) * HOUR, id: 'go', balance: 60, percent: 40 }))
const hist10 = [...hist9, pt({ t: T0 - HOUR, id: 'go', balance: 60, percent: 40 })]
const spike = [planPct({ used: 50, limit: 60, percent: 90 })]
const atTwice = [planPct({ used: 40, limit: 60, percent: 80 })]
const pastTwice = [planPct({ used: 42, limit: 60, percent: 80.1 })]
eq(has('abnormal', spike, hist9), false, 'H1 n=9 → 不判异常（AC10：冷启动不误报）')
eq(has('abnormal', spike, hist10), true, 'H2 n=10 → 异常触发')
eq(has('abnormal', atTwice, hist10), false, 'H3 正好等于均值 × 2 → 不触发')
eq(has('abnormal', pastTwice, hist10), true, 'H4 刚过 2 倍 → 触发')
eq(has('abnormal', atTwice, hist9), false, 'H4b 同样 2 倍的数据，n=9 时也不报（门槛是真的，不是碰巧）')
eq(has('abnormal', [cash(8)], hist10), false, 'H5 余额型永远没有用量率 → 不判异常（不是判成异常）')
eq(hitOf('abnormal', pastTwice, hist10)?.level, 'routine', 'H6 异常是例行级')
// 一份够长的静止历史能同时判出「一直没动过」和「这一下跳得反常」——两个场景互不遮蔽
const still25 = Array.from({ length: 25 }, (_, i) => pt({ t: T0 - (25 - i) * HOUR, id: 'go', balance: 60, percent: 40 }))
eq(has('idle', atTwice, still25), true, 'H7 静止满 25 小时 → 判出未使用')
eq(has('abnormal', atTwice, still25), false, 'H8 同一份历史下 2 倍不算异常（两个判定各看各的，互不替代）')

console.log('\nI. 分级表（父 prd：余额/波动/耗尽 = 紧急，未使用/异常 = 例行）')

eq(TRIGGER_LEVEL.balance, 'urgent', 'I1 余额 = 紧急')
eq(TRIGGER_LEVEL.fluctuation, 'urgent', 'I2 波动 = 紧急')
eq(TRIGGER_LEVEL.exhaustion, 'urgent', 'I3 耗尽 = 紧急')
eq(TRIGGER_LEVEL.idle, 'routine', 'I4 未使用 = 例行')
eq(TRIGGER_LEVEL.abnormal, 'routine', 'I5 异常 = 例行')

// 一个供应商同时命中 5 个场景：25 条静止的历史（均值 40、剩余 60），本轮一下冲到 95%
const all5Hist = Array.from({ length: 25 }, (_, i) => pt({ t: T0 - (25 - i) * HOUR, id: 'go', balance: 60, percent: 40 }))
const all5Snap = snap({ id: 'go', name: 'Go 套餐', windows: [win({ used: 58, limit: 60, percent: 95 })] })
const all5 = checkTriggers([all5Snap], all5Hist, CFG, T0)
eq(all5.map((x) => x.kind).sort(), ['abnormal', 'balance', 'exhaustion', 'fluctuation', 'idle'], 'I6 单个供应商可以同时命中 5 个场景')
eq(all5.filter((x) => x.level === 'urgent').length, 3, 'I7 其中 3 个是紧急')
eq(all5.filter((x) => x.level === 'routine').length, 2, 'I8 另外 2 个是例行')

console.log('\nJ. resolveConfig：全局 + 按供应商覆盖')

const withOverride = { ...CFG, perProvider: { go: { balanceLow: 2, abnormalMul: 5 } } }
eq(resolveConfig(CFG, 'go').balanceLow, CFG.balanceLow, 'J1 没有覆盖 → 原样返回')
eq(resolveConfig(withOverride, 'go').balanceLow, 2, 'J2 覆盖生效')
eq(resolveConfig(withOverride, 'go').abnormalMul, 5, 'J3 覆盖第二个字段')
eq(resolveConfig(withOverride, 'go').exhaustionPct, CFG.exhaustionPct, 'J4 没列出的字段继承全局')
eq(resolveConfig(withOverride, 'other').balanceLow, CFG.balanceLow, 'J5 别的供应商不受影响')
eq(resolveConfig({ ...CFG, perProvider: { go: { perProvider: { deep: { balanceLow: 1 } } } } }, 'go').balanceLow, CFG.balanceLow, 'J6 覆盖里再塞 perProvider 不递归展开')
eq(resolveConfig(withOverride, 'go').perProvider, withOverride.perProvider, 'J7 覆盖不动全局的 perProvider 表')

// 覆盖后的实际效果：Go 阈值 2 → 剩余 2 不再报警（其余场景随数据走，只盯余额这一条）
const goSnap = [snap({ id: 'go', name: 'Go', windows: [win({ used: 58, limit: 60, percent: 50 })] })]
eq(has('balance', goSnap, all5Hist, withOverride), false, 'J8 覆盖为 2 之后，剩余正好 2 → 不再报余额不足')
eq(has('balance', goSnap, all5Hist, CFG), true, 'J9 用全局 10 时同样的数据会报（对照：差别只在阈值来源）')

console.log('\nK. mergeHits：同轮合并成一条（AC12）')

eq(mergeHits([], 'detailed'), null, 'K1 没有命中 → null（不播空话）')
const d1 = mergeHits(all5, 'simple')
const d2 = mergeHits(all5, 'detailed')
eq(times(d2, 'Go 套餐'), 1, 'K2 detailed：供应商名只出现一次（不逐条念）')
eq(d1, 'Go 套餐 余额不足，剩余 2 元', 'K3 simple：只说最高优先级那一条（余额命中时就是「仅余额信息」）')
for (const d of all5.map((x) => x.detail)) eq(d2.includes(d), true, `K4 detailed 包含「${d}」`)
eq(d2.includes('余额不足，剩余 2 元，单次用量增长 58 元'), true, 'K5 detailed 把同一供应商的命中连成一句（不是五条独立播报）')
ok(d2.indexOf('余额不足') < d2.indexOf('无用量变化'), 'K6 紧急的排前面，例行的排后面')

const twoProv = [...checkTriggers([cash(8), snap({ id: 'k', name: 'Kimi', kind: 'balance', windows: [{ name: '账户余额', used: 3, unit: 'cny' }] })], [], CFG, T0)]
const two = mergeHits(twoProv, 'detailed')
eq(two, 'DeepSeek 余额不足，剩余 8 元；Kimi 余额不足，剩余 3 元', 'K7 两个供应商也合成一条（分号分隔）')
eq(times(two, 'DeepSeek'), 1, 'K8 DeepSeek 只出现一次')
eq(times(two, 'Kimi'), 1, 'K9 Kimi 只出现一次')
eq(mergeHits([...all5].reverse(), 'detailed'), d2, 'K10 与传入顺序无关（紧急优先是排序的结果，不是调用方的巧合）')

const hidden = mergeHits(all5, 'detailed', { hideBalance: true })
ok(!hidden.includes('元'), 'K11 隐藏余额：金额单位整个不出现')
ok(!hidden.includes('剩余'), 'K12 隐藏余额：金额从句整条剔除（不是只藏掉 ¥/元 符号）')
ok(hidden.includes('用量已用 95%'), 'K13 隐藏余额：用量照念（父 prd：隐藏余额时只播用量）')
eq(times(hidden, 'Go 套餐'), 1, 'K14 隐藏余额后名字仍只出现一次')
eq(mergeHits(all5, 'simple', { hideBalance: true }), 'Go 套餐 用量已用 95%', 'K15 隐藏余额 + 简洁：优先级最高的那条降级成用量')
const onlyMoney = checkTriggers([cash(8)], [], CFG, T0)
eq(mergeHits(onlyMoney, 'detailed', { hideBalance: true }), 'DeepSeek 余额已隐藏', 'K16 隐藏余额且只剩余额命中 → 如实说已隐藏，不拿 0 元凑数')
eq(mergeHits(onlyMoney, 'detailed'), 'DeepSeek 余额不足，剩余 8 元', 'K17 同样这组数据，不隐藏时照常播金额')

console.log('\nL. 播报锁存：条件持续成立期间只播一次（AC9「恰好播报一次」）')

{
  // 模拟 App.evaluateAlerts 的真实时序：每一轮 checkTriggers → 锁存 → 只播没播过的。
  // 余额 8 元恒定低于阈值 10 —— 这正是「每轮都命中」的最坏情况。
  // 刻意不带历史：不带历史就只有余额这一条命中，断言不会被波动/未使用顺手带出别的场景
  let latch = []
  const spoken = []
  for (let round = 0; round < 5; round++) {
    const hits = checkTriggers([cash(8)], [], CFG, T0 + round * HOUR)
    const fresh = freshHits(hits, latch)
    latch = latchKeys(hits)
    if (fresh.length) spoken.push(mergeHits(fresh, 'simple'))
  }
  eq(spoken, ['DeepSeek 余额不足，剩余 8 元'], 'L1 余额持续越界 5 轮 → 只播 1 次（不每轮重念）')
  eq(latch, ['cash balance'], 'L2 锁存里留下这一条（说明它已被播过）')
  eq(hitKey({ id: 'go', kind: 'idle' }), 'go idle', 'L3 锁存键 = 供应商 × 场景')
}

{
  // 条件解除 → 解锁 → 再越过 → 重新播。否则用户充了钱又花光就再也听不到预警
  const round = (bal) => checkTriggers([cash(bal)], [], CFG, T0)
  let latch = []
  const round1 = freshHits(round(8), latch)
  latch = latchKeys(round(8))
  const round2 = freshHits(round(50), latch) // 回到阈值以上
  latch = latchKeys(round(50))
  const round3 = freshHits(round(8), latch) // 又掉下去
  eq(round1.length, 1, 'L4 第一次越过 → 播')
  eq(round2.length, 0, 'L5 条件解除的那一轮不播，锁存同时被清掉')
  eq(round3.length, 1, 'L6 再次越过 → 重新播（锁存的是「播过」不是「发生过」）')
}

{
  // 供应商之间互不串扰：锁存键带 id，甲播过了不影响乙
  const both = checkTriggers([cash(8), snap({ id: 'k', name: 'Kimi', kind: 'balance', windows: [{ name: '账户余额', used: 3, unit: 'cny' }] })], [], CFG, T0)
  eq(latchKeys(both).sort(), ['cash balance', 'k balance'], 'L7 两个供应商 → 两个独立锁存键')
  const onlyKimi = both.filter((x) => x.id === 'k')
  eq(freshHits(onlyKimi, ['cash balance']).length, 1, 'L8 扣掉甲的锁存，乙仍然是新的')
  eq(freshHits(both, ['cash balance', 'k balance']).length, 0, 'L9 两个都播过 → 整轮静音')
  // checkTriggers 本身不会吐出同一条两遍，这层去重是给调用方的防御：锁存集合按
  // 「命中过的键」当集合用，重复项会让它无意义地膨胀，也让 L7 的断言变成看运气
  eq(latchKeys([...both, ...both]).sort(), ['cash balance', 'k balance'], 'L13 同一批命中传两遍 → 键集合不膨胀')
}

{
  // 波动是「一次性事件」：不锁存会在每一轮都判（因为 checkTriggers 自己按阈值过滤了大小）
  const prevBig = [pt({ t: T0 - HOUR, id: 'cash', balance: 100, percent: null })]
  const big = [cash(88)]
  const spike = checkTriggers(big, prevBig, CFG, T0).filter((x) => x.kind === 'fluctuation')
  const calm = checkTriggers([cash(95)], prevBig, CFG, T0).filter((x) => x.kind === 'fluctuation')
  ok(spike.length === 1, 'L10 花掉 12 元那一轮命中波动')
  eq(calm.length, 0, 'L11 下一轮只花掉 5 元（< 阈值 10）→ 不命中，锁存随之解除')
  eq(freshHits(checkTriggers(big, prevBig, CFG, T0).filter((x) => x.kind === 'fluctuation'), latchKeys(calm)).length, 1, 'L12 又一次大额增长 → 重新播')
}

console.log('\nM. App 侧时序契约：hist 必须是「上一轮」的采样')
{
  // 本轮采样一旦先进 hist，checkTriggers 拿到的 prev 就是「本轮自己」——
  // 相邻两差恒为 0，波动场景永远命中不了。这条断言守住调用方别把顺序写反。
  const prev = [pt({ t: T0 - HOUR, id: 'cash', balance: 100, percent: null })]
  const cur = appendPoint(prev, pt({ t: T0, id: 'cash', balance: 88, percent: null }))
  ok(hitOf('fluctuation', [cash(88)], prev, CFG) !== undefined, 'M1 先判后记 → 命中波动')
  eq(hitOf('fluctuation', [cash(88)], cur, CFG), undefined, 'M2 先记后判 → 波动永远不命中（AC4 静默失效）')
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
