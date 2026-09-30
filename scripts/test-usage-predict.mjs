// 用量预测的估算逻辑测试（renderer/src/usagePredict.ts + shared/usage-predict.ts）
// 用法：node scripts/test-usage-predict.mjs
//
// 覆盖：最小二乘斜率、**重置点切段**（D2，最容易写错的一处）、样本不足不硬算、
//       斜率 ≤ 0 不预测、余额类/无限额/无百分比不预测、可信度分档、
//       数据来源标注、配置脏值回退、以及纯度。
//
// 全部经 loadTs 加载**真实源码**（scripts/lib/load-ts.mjs）：lastMonotonicRun /
// slopePerHour / ratePerHour / estimateRunsOutAt / confidenceOf / predictWindow /
// predictAll / buildPredictionText 一个都不内联 —— 内联过的测试已经漂移过一次
// （test-percent.mjs），源文件改了测试还绿着，等于没有测试。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadTs } from './lib/load-ts.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const {
  lastMonotonicRun,
  slopePerHour,
  ratePerHour,
  estimateRunsOutAt,
  confidenceOf,
  predictWindow,
  predictAll,
  buildPredictionText,
  bySoonest,
  resolvePredictConfig,
  DEFAULT_PREDICT_CONFIG,
  MIN_POINTS_FOR_RATE,
  LOW_CONFIDENCE_POINTS,
  LOW_CONFIDENCE_SPAN
} = await loadTs('src/renderer/src/usagePredict.ts')
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
function near(actual, expected, tol, label) {
  const hit = typeof actual === 'number' && Math.abs(actual - expected) <= tol
  if (hit) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}\n      实际: ${actual}\n      期望: ${expected} ±${tol}`)
  }
}
function includes(hay, needle, label) {
  const hit = typeof hay === 'string' && hay.includes(needle)
  if (hit) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}\n      实际: ${JSON.stringify(hay)}\n      期望包含: ${needle}`)
  }
}

const HOUR = 3600_000
const T0 = 1_700_000_000_000
const ISO = '2026-09-29T00:00:00.000Z'

/** 第 i 个点的百分比；step 是相邻两点的百分点差（默认 +10） */
const series = (pcts, { step = HOUR, t0 = T0 } = {}) =>
  pcts.map((pct, i) => ({ t: t0 + i * step, pct }))

const win = (o = {}) => ({ name: '本月', used: 0, limit: 100, unit: 'usd', ...o })
const snap = (o = {}) => ({
  id: 'go',
  name: 'Go',
  kind: 'coding',
  builtin: true,
  status: 'ok',
  windows: [],
  updatedAt: ISO,
  ...o
})
const plan = (pct, o = {}) =>
  snap({ windows: [win({ used: pct, limit: 100, percent: pct, ...o })] })
const cfg = (o = {}) => ({ ...DEFAULT_PREDICT_CONFIG, ...o })
const pctOf = (list, winName) => list.find((p) => p.windowName === winName) ?? null

// ═══ A. 最小二乘斜率 ═════════════════════════════════════════════════════════
console.log('\nA. 斜率：最小二乘（百分点/小时）')

near(slopePerHour(series([0, 10, 20, 30])), 10, 0.01, 'A1 完全线性：每小时 10 个点')
// ⚠ 期望值是**回归**出来的，不是首尾差：`[0,20,20,40]` 的首尾差是 40/3≈13.33，
//   而最小二乘给的是 12（平台段把两点连线的斜率拉平了 —— 这正是选 OLS 的理由）。
//   写首尾差当期望值会让 A2 变红，而那条红与「实现是不是回归」无关。
near(slopePerHour(series([0, 20, 20, 40])), 12, 0.01,
  'A2 含平台段：回归给 12（不是首尾差 13.33 —— 平台段把斜率拉平了）')
// 两点也必须算得出斜率（回归在 n=2 上有定义）；门槛由 ratePerHour 单独管
near(slopePerHour(series([10, 30])), 20, 0.01, 'A3 两点也算得出斜率（n=2 的斜率 = Δpct/Δt）')
eq(slopePerHour(series([10])), null, 'A4 单点无斜率（横轴无方差）')
eq(slopePerHour([]), null, 'A5 空序列 → null')
// 同一时刻的两个点：sxx = 0 → 斜率无定义 → null
// （这里一度写成「期望 0」，实际实现返回 null —— null 才对：「同一时刻两个点」是
//  **数据坏了**（usageStore 的 t 全被写坏），不是「速率为零」。写成 0 会把
//  「用量没动」与「时刻写坏」混成同一个数，与缺失值纪律冲突。）
eq(slopePerHour([{ t: T0, pct: 10 }, { t: T0, pct: 10 }]), null,
  'A6 两点同一时刻 → null（sxx=0 时斜率无定义，不是「速率为零」）')
// ⚠ 时间轴的量级：t 是 1.7e12 的 epoch ms，直接进平方和会吃掉大半浮点有效位。
//   造一条跨度很大的序列（30 天）来盯这个 —— 斜率仍要准。
near(slopePerHour(series([0, 50, 100], { step: 15 * 24 * HOUR })), 50 / (15 * 24), 0.01,
  'A7 跨度 30 天仍给出准确斜率（横轴已减去 t0，浮点有效位没有被吃掉）')
// 真实体量：15 分钟采样 × 7 天 = 672 个点，每步涨 2/672 个百分点
const week = series(Array.from({ length: 672 }, (_, i) => (i * 2) / 672))
near(slopePerHour(week), 2 / 672, 0.0001,
  'A8 真实体量（672 点 / 7 天）斜率准确（期望是每步 2/672，不是 2/7）')

console.log('\nB. 重置点切段（D2 —— 本设计最容易写错的一处）')

// Bad 案例（写进 design.md 的那个）：7 天窗口，序列中 97 → 0 是窗口重置
const resetSeries = series([95, 97, 0, 12, 25, 38])
eq(lastMonotonicRun(resetSeries).map((p) => p.pct), [0, 12, 25, 38],
  'B1 按向下跳变断开，取最后一段')
// 切段后只对 [0,12,25,38] 回归：OLS 斜率 12.7（不是首尾差 38/3≈12.67，两者接近但不等）
near(ratePerHour(resetSeries), 12.7, 0.2, 'B2 切段后斜率为正（不切段会被 −97 拉到负数）')
// 对照：整段回归的斜率确实为负 —— 这正是 B2 要防的症状
const wholeSlope = (() => {
  const pts = resetSeries
  const t0 = pts[0].t
  const mx = pts.reduce((s, p) => s + (p.t - t0) / HOUR, 0) / pts.length
  const my = pts.reduce((s, p) => s + p.pct, 0) / pts.length
  let sxy = 0
  let sxx = 0
  for (const p of pts) {
    const dx = (p.t - t0) / HOUR - mx
    sxy += dx * (p.pct - my)
    sxx += dx * dx
  }
  return sxy / sxx
})()
ok(wholeSlope <= 0, `B3 对照：整段回归的斜率 = ${wholeSlope.toFixed(2)}（≤0 就是「预测永远说用不完」的成因）`)
// 多个重置点：取的是**最后一个**之后那一段
eq(lastMonotonicRun(series([10, 20, 5, 15, 25, 1, 5, 9])).map((p) => p.pct), [1, 5, 9],
  'B4 多个重置点 → 取最后一段')
// 没有重置 → 整段保留
eq(lastMonotonicRun(series([1, 2, 3, 4])).map((p) => p.pct), [1, 2, 3, 4], 'B5 无重置 → 整段')
// 相等不算重置（持平的用量是「没在用」，不是重置）
eq(lastMonotonicRun(series([10, 10, 10])).map((p) => p.pct), [10, 10, 10],
  'B6 持平不算重置（p[i] < p[i-1] 是严格小于）')
// null 点被剔除，且**不是**按 0 处理
eq(lastMonotonicRun([{ t: T0, pct: 10 }, { t: T0 + HOUR, pct: null }, { t: T0 + 2 * HOUR, pct: 20 }])
  .map((p) => p.pct), [10, 20], 'B7 null 点被剔除（不是按 0 参与回归）')
eq(lastMonotonicRun([{ t: T0, pct: null }]).length, 0, 'B8 全是 null → 空段')
// ⚠ B9 / B10 判的是「剔除 null」这件事的**后果**，不是它的字面表述。
//   上一版写的是 `lastMonotonicRun([null, null]).every(...) === false || true` ——
//   `X || true` 恒真，红集为 0，是一条装饰性假护栏（quality-guidelines §「反验」）。
//   有牙的判据：中间隔着 null 的 30 → 20 **仍然**要判成重置断开。
//   若 null 被当 0 参与比较，`20 < null` 为 false → 不断开 → 整段 [30, 20] 被留下。
eq(lastMonotonicRun([{ t: T0, pct: 30 }, { t: T0 + HOUR, pct: null }, { t: T0 + 2 * HOUR, pct: 20 }])
  .map((p) => p.pct), [20],
  'B9 隔着 null 的向下跳变仍被认成重置（null 不参与比较：20 < null 为 false 会漏判）')
eq(lastMonotonicRun([{ t: T0, pct: null }, { t: T0 + HOUR, pct: null }]), [],
  'B10 全 null 的多点序列 → 空数组（不是一串 null）')

console.log('\nC. 样本不足与斜率 ≤ 0 → 不预测（data honesty）')

eq(ratePerHour(series([1, 2, 3])), null,
  `C1 3 个点（< MIN_POINTS_FOR_RATE=${MIN_POINTS_FOR_RATE}）→ null（两点连线是平的确定性结果，任何噪声都被当成趋势）`)
eq(ratePerHour(series([10, 20, 30, 40])), 10, 'C2 刚好 4 个点 → 算得出')
eq(ratePerHour(series([40, 30, 20, 10])), null, 'C3 斜率为负（用量在回落）→ null')
eq(ratePerHour(series([10, 10, 10, 10])), null, 'C4 斜率为 0（用量没动）→ null（不是「永远用不完」）')
eq(ratePerHour([]), null, 'C5 空 → null')
eq(estimateRunsOutAt({ t: T0, pct: 50 }, 0), null, 'C6 perHour=0 → null')
eq(estimateRunsOutAt({ t: T0, pct: 50 }, -5), null, 'C7 perHour<0 → null')
eq(estimateRunsOutAt({ t: T0, pct: null }, 10), null, 'C8 当前百分比未知 → null（不按 0 算）')
eq(estimateRunsOutAt({ t: T0, pct: 100 }, 10), null, 'C9 已经用完（无剩余）→ null')
ok(estimateRunsOutAt({ t: T0, pct: 50 }, 10) > T0, 'C10 正常情况给出未来的时刻')

console.log('\nD. 可信度分档（不显示 / low / mid）')

eq(confidenceOf(series([1, 2, 3])), null, 'D1 样本不足 → null（整条不显示）')
eq(confidenceOf(series([10, 20, 30, 40])), 'low', 'D2 4 个点（< 8）→ low')
// 8 个点、step=1h → 跨度 7 小时，**超过** 6 小时阈值 → mid
// （7 × 1h = 7h，t 从 0 到 7h 是 7 个间隔；别把「8 个点」当成「8 小时」）
eq(confidenceOf(series([10, 20, 30, 40, 50, 60, 70, 80])), 'mid',
  'D3 8 个点、跨度 7 小时（> 6h 阈值）→ mid')
// 真正落在阈值内侧：step=30min × 7 = 3.5 小时
eq(confidenceOf(series([10, 20, 30, 40, 50, 60, 70, 80], { step: 30 * 60_000 })), 'low',
  `D3b 8 个点但跨度只 3.5 小时（< ${LOW_CONFIDENCE_SPAN / HOUR}h）→ low`)
eq(confidenceOf(series([10, 20, 30, 40, 50, 60, 70, 80], { step: 2 * HOUR })), 'mid',
  'D4 8 个点且跨度 14 小时 → mid')
// 刚够 LOW_CONFIDENCE_POINTS(8) 个点、跨度也过线
eq(confidenceOf(series([10, 20, 30, 40, 50, 60, 70, 80], { step: 2 * HOUR })), 'mid',
  'D4b 8 个点、跨度 14 小时 → mid（点数与跨度都过线）')
// 判据看的是**当前这一段**而不是总点数：7 天点数很足，但重置后只剩 4 个 → 仍是 low
const longThenReset = [...series([10, 20, 30, 40, 50, 60, 70, 80, 90, 95], { step: HOUR }),
  { t: T0 + 10 * HOUR, pct: 5 }, { t: T0 + 11 * HOUR, pct: 8 }, { t: T0 + 12 * HOUR, pct: 11 },
  { t: T0 + 13 * HOUR, pct: 14 }]
eq(confidenceOf(longThenReset), 'low',
  'D5 判据取当前这一段：重置后只剩 4 个点 → low（拿 14 个总点数给它盖章是拿旧数据替新数据背书）')

console.log('\nE. 完整预测 predictWindow / predictAll')

// 构造一份能算出预测的数据：每 15 分钟 +8 个点，当前 88%
const good = series([8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88], { step: 15 * 60_000 })
const pw = predictWindow(snap(), '本月', good, T0 + 11 * 15 * 60_000, cfg())
ok(pw != null, 'E0 前置：这份数据确实能算出预测')
eq(pw?.windowName, '本月', 'E1 窗口名进 Prediction（UI 要说清是哪个窗口）')
eq(pw?.providerId, 'go', 'E2 供应商 id')
near(pw?.perHour, 32, 1, 'E3 斜率量级正确（每 15 分钟 8 个点 = 32 点/小时）')
ok(pw?.leftMs > 0, 'E4 leftMs 为正（还有剩余）')
ok(pw?.runsOutAt > T0, 'E5 预计耗尽时刻在未来')
eq(pw?.qualityLabel, '', 'E6 official → qualityLabel 空串（staleLabel 独家判定）')
eq(predictWindow(snap({ dataQuality: 'cached' }), '本月', good, T0 + 11 * 15 * 60_000, cfg())?.qualityLabel,
  '缓存', 'E7 cached → qualityLabel = 缓存（取自 staleLabel）')
eq(predictWindow(snap({ dataQuality: 'local' }), '本月', good, T0 + 11 * 15 * 60_000, cfg())?.qualityLabel,
  '本机', 'E8 local → qualityLabel = 本机')

// 回看窗口之外的点不参与。
// ⚠ fixture 特意让「窗外那批点」与 good **首尾相接且不下降**（0,2,4,6 → 8,16,…），
//   这样它们不会触发 D2 的重置断开 —— 也就是说**只有回看窗口的过滤**能排除它们。
//   旧版用 `10,20,30,40 → 8,16,…`（40 > 8 = 一次重置），于是切段顺手就把它们切掉了，
//   把过滤代码整个删掉这条断言照样是绿的（假护栏）。
const older = [...series([0, 2, 4, 6], { step: HOUR, t0: T0 - 20 * 24 * HOUR }), ...good]
const pwWin1 = predictWindow(snap(), '本月', older, T0 + 11 * 15 * 60_000, cfg({ windowDays: 1 }))
near(pwWin1?.perHour, 32, 1,
  'E9 回看窗口外的旧点被排除（1 天窗口下斜率与只用 good 时一致；删掉过滤会被 20 天前的点摊平）')
near(predictWindow(snap(), '本月', older, T0 + 11 * 15 * 60_000, cfg({ windowDays: 30 }))?.perHour,
  0.14, 0.05,
  'E9b 对照：窗口放宽到 30 天（把 20 天前的点算进来）斜率被明显摊平 —— 证明 E9 测的是过滤本身')

// 余额类一律空
const balance = snap({ id: 'cash', kind: 'balance', windows: [{ name: '账户余额', used: 42, unit: 'cny' }] })
eq(predictAll(balance, { 账户余额: good }, T0, cfg()), [], 'E10 余额类 → 空数组（D5：没有窗口也没有限额）')
// 无限额的窗口不预测
const noLimit = snap({ windows: [{ name: '本周', used: 58, unit: 'usd', percent: 95 }] })
eq(predictAll(noLimit, { 本周: good }, T0, cfg()), [], 'E11 限额未知 → 不预测（算不出「用完」的时刻）')
// 百分比算不出的窗口不预测。
// ⚠ 如实记录：`windowPercent` 只在「percent 为空**且** limit 缺省/≤0」时返回 null，
//   而 limit 判据在它前面已经跑过 —— 所以这条命中的是 **limit 那一道**，
//   `predictAll` 里的 windowPercent 判据是纯防御性的（结构上不可达，不是漏测）。
//   保留它是为了将来 windowPercent 放宽口径时不必回头改这里。
const noPct = snap({ windows: [{ name: '本月', used: 58, limit: undefined, unit: 'usd' }] })
eq(predictAll(noPct, { 本月: good }, T0, cfg()), [], 'E12 百分比/限额都算不出 → 不预测（不拿历史旧值冒充现在）')
eq(predictAll(snap({ windows: [{ name: '本月', used: 58, limit: 0, unit: 'usd' }] }), { 本月: good }, T0, cfg()), [],
  'E12b limit=0 同样不预测（无限额就没有「用完」这个时刻）')
// 逐窗口各出一条
const twoWin = snap({
  windows: [win({ name: '本周', used: 40, limit: 100, percent: 40 }), win({ name: '本月', used: 80, limit: 100, percent: 80 })]
})
const twoPred = predictAll(twoWin, {
  本周: series([10, 20, 30, 40, 45], { step: HOUR }),
  本月: series([40, 55, 70, 80], { step: HOUR })
}, T0 + 4 * HOUR, cfg())
eq(twoPred.map((p) => p.windowName), ['本周', '本月'],
  'E13 多窗口逐个预测，顺序随快照的窗口序（5H / W / M 速率不同，混成一条是错的）')
// 排序：本周斜率 9.0 点/小时、剩 60 个点（6.7h）；本月斜率 13.5、剩 20 个点（1.5h）
// → 本月先耗尽。断言的是**实际算出来的**相对次序，不是「哪个窗口名听起来更急」。
const sortedTwo = [...twoPred].sort(bySoonest)
eq(sortedTwo.map((p) => p.windowName), ['本月', '本周'],
  'E13b bySoonest 把先耗尽的排前面（本月剩 20 点 / 13.5 每小时，先于本周的 60 点 / 9.0）')
ok(sortedTwo[0].leftMs < sortedTwo[1].leftMs, 'E13c 排在前面的那条 leftMs 确实更小（排序真的按耗尽时刻）')
ok(bySoonest(twoPred[0], twoPred[1]) !== 0, 'E14 bySoonest 能排序（详情页按耗尽先后排）')
// 没有历史的窗口不出预测
eq(predictAll(plan(50), { 本月: [] }, T0, cfg()), [], 'E15 该窗口无历史 → 不预测')
eq(predictAll(plan(50), {}, T0, cfg()), [], 'E16 完全没有历史 → 不预测')

console.log('\nF. 文案（AC3：必含「估算」）')

const p = predictWindow(plan(88), '本月', good, T0 + 11 * 15 * 60_000, cfg())
const text = buildPredictionText(p, 7)
includes(text, '估算', 'F1 文案必含「估算」（AC3 的行为断言，不是源码正则）')
includes(text, '7', 'F2 文案说明回看天数')
ok(!text.includes('undefined') && !text.includes('NaN'), `F3 文案里没有 undefined / NaN（实际: ${text}）`)
// ⚠ 指针述式表达，不写成断言。判据抽成谓词，**两条都要测**：真文案通过、断言式
//   对照文案不通过 —— 只测前者的话，「谓词恒真」和「谓词有牙」看起来一模一样
//   （上一版写成 `!re.test(...) || text.includes('估算')`，而 F1 已保证右项为真，
//   于是整条恒真、红集 0）。反向那半边才是「守卫有牙」的证据。
const readsAsEstimate = (t) => {
  const i = t.indexOf('后用完')
  return i > 0 && t.slice(0, i).includes('估算')
}
ok(readsAsEstimate(text), `F4 「用完」前面有「估算」限定，不是断言式表达（实际: ${text}）`)
ok(!readsAsEstimate('按近 7 天速率，约 3 天后用完'),
  'F4b 反向验证：一条断言式对照文案通不过同一条判据（守卫确实有牙，不是恒真）')
// 低可信度要标出来
const lowP = predictWindow(plan(88), '本月', series([8, 16, 24, 32, 40], { step: 15 * 60_000 }),
  T0 + 4 * 15 * 60_000, cfg())
includes(buildPredictionText(lowP, 7), '样本较少', 'F5 low → 标注「样本较少」')
// 数据源降级要标出来
const cachedP = predictWindow(snap({ dataQuality: 'cached' }), '本月', good, T0 + 11 * 15 * 60_000, cfg())
includes(buildPredictionText(cachedP, 7), '缓存', 'F6 cached → 标注「缓存」')
ok(!buildPredictionText(p, 7).includes('缓存'), 'F7 对照：official 文案里没有「缓存」')
// 脏的 windowDays 落向默认
includes(buildPredictionText(p, Number.NaN), '7', 'F8 windowDays 脏值 → 回看天数落回默认 7')
includes(buildPredictionText(p, -3), '7', 'F9 windowDays 负数 → 回退默认')

console.log('\nG. 配置脏值回退（state-management：读取处一律重新校验）')

eq(resolvePredictConfig({}), DEFAULT_PREDICT_CONFIG, 'G1 空对象 → 默认')
eq(resolvePredictConfig(null), DEFAULT_PREDICT_CONFIG, 'G2 null → 默认')
eq(resolvePredictConfig(undefined), DEFAULT_PREDICT_CONFIG, 'G3 undefined → 默认')
eq(resolvePredictConfig({ windowDays: Number.NaN, retentionDays: 60 }),
  { windowDays: 7, retentionDays: 60 }, 'G4 NaN → 回退默认（不影响别的字段）')
eq(resolvePredictConfig({ windowDays: -3, retentionDays: -1 }), DEFAULT_PREDICT_CONFIG,
  'G5 负数 → 回退默认（回看 -3 天会把全部历史拉进来算速率）')
eq(resolvePredictConfig({ windowDays: 0, retentionDays: 0 }), DEFAULT_PREDICT_CONFIG, 'G6 0 → 回退默认')
eq(resolvePredictConfig({ windowDays: 14, retentionDays: 60 }), { windowDays: 14, retentionDays: 60 },
  'G7 合法值原样保留')
eq(resolvePredictConfig({ windowDays: 9999, retentionDays: 9999 }),
  { windowDays: MAX_RETENTION_DAYS, retentionDays: MAX_RETENTION_DAYS },
  `G8 超上限 → 钳到 ${MAX_RETENTION_DAYS}（单文件无节制地长）`)
eq(resolvePredictConfig({ windowDays: 7.9, retentionDays: 30.5 }), { windowDays: 7, retentionDays: 30 },
  'G9 小数 → 向下取整（天数不是小数）')

console.log('\nH. 纯函数纪律与纯度')

const upSrc = readFileSync(resolve(ROOT, 'src/renderer/src/usagePredict.ts'), 'utf-8')
const upCode = upSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

ok(upCode.trim().length > 0, 'H0a 前置：模块源码读得到（下面的负向断言不能空洞通过）')
ok(!/Date\.now\(|new Date\(\s*\)/.test(upCode), 'H0b 估算纯函数里没有读自己的钟（now 由入参传）')
ok(!/window\.|document\.|setExtras|ipcRenderer/.test(upCode), 'H0c 不碰 window / DOM / IPC（纯估算）')
ok(!/Math\.random/.test(upCode), 'H0d 没有随机性（同一份输入必须给出同一份结果）')

// 入参不被就地修改
{
  const pts = series([10, 20, 30, 40, 50])
  const before = JSON.stringify(pts)
  ratePerHour(pts)
  predictWindow(snap(), '本月', pts, T0, cfg())
  predictAll(plan(50), { 本月: pts }, T0, cfg())
  confidenceOf(pts)
  eq(JSON.stringify(pts), before, 'H1 入参 points 未被就地修改（深比较）')
}

// 纯度：同一份输入调两次结果相等
{
  const args = [snap(), '本月', good, T0 + 11 * 15 * 60_000, cfg()]
  const a = predictWindow(...args)
  const b = predictWindow(...args)
  eq(a, b, 'H2 同一份输入调两次 → 结果逐字段相等（无隐藏的轮次状态）')
  eq(ratePerHour(good), ratePerHour(good), 'H3 ratePerHour 纯度')
  eq(lastMonotonicRun(good), lastMonotonicRun(good), 'H4 lastMonotonicRun 纯度')
}

// 单一出处：数据源判定必须走 staleLabel
ok(/from '\.\.\/\.\.\/shared\/quality'/.test(upSrc) && /staleLabel\(s\)/.test(upCode),
  'H5 数据源降级判定复用 shared/quality 的 staleLabel（不写第二份「哪些算非官方」）')
// 套餐 / 余额判据走 isPlan 独家
ok(/isPlan\(s\)/.test(upCode) && !/kind !== 'balance'/.test(upCode),
  'H6 套餐判据用 shared/quality 的 isPlan（不重写 kind !== balance）')
// 时长格式化复用 humanDur
ok(/humanDur\(/.test(upCode) && !/const DAY_STR|天.*小时.*\}/.test(upCode),
  'H7 时长格式化复用 format 的 humanDur（不另写一份「X 天 Y 小时」）')
// 跨进程契约住在 shared（主进程 / preload / 渲染层共用同一份形状）
ok(/from '\.\.\/\.\.\/shared\/usage-predict'/.test(upSrc),
  'H8 形状 / 默认值 / 键名取自 shared/usage-predict（跨进程三处引用同一份）')

// ─── I. extras 键名的单一出处 ────────────────────────────────────────────────
//
// 为什么这一段存在：PREDICT_KEYS 曾经**只声明不用** —— 三个键分散在 App（读 + 写
// ui: 两键）、scheduler（读 retention）、ipc（写 retention）三处各写一份字面量。
// 那不是「重复劳动」而是**静默失效**：改键名要改三个文件，漏一个的症状是
// 「设置改了没反应」，不抛不红，界面照旧。
console.log('\nI. extras 键名的单一出处（三处引用同一份，不是各写一份）')

const { PREDICT_KEYS } = await loadTs('src/shared/usage-predict.ts')
/** 剥掉块注释与行注释后再判 —— 键名的字面量在注释里也出现过（quality-guidelines §D） */
const codeOf = (rel) =>
  readFileSync(resolve(ROOT, rel), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

ok(PREDICT_KEYS.on.startsWith('ui:') && PREDICT_KEYS.config.startsWith('ui:'),
  'I1 两个界面偏好键是 ui: 前缀（写入不触发全量重采集，test-structure E8 依然成立）')
ok(!PREDICT_KEYS.retention.startsWith('ui:'),
  'I2 保留期键**不是** ui: 前缀（非 ui: 键的 setExtras 会 refreshNow()，所以走专用通道）')

const appCode2 = codeOf('src/renderer/src/App.tsx')
const callSites = [
  ['src/renderer/src/App.tsx', appCode2],
  ['src/main/scheduler.ts', codeOf('src/main/scheduler.ts')],
  ['src/main/ipc.ts', codeOf('src/main/ipc.ts')]
]
for (const [rel, code] of callSites) {
  ok(code.length > 0 && /PREDICT_KEYS\./.test(code),
    `I3a ${rel} 引用 shared 的 PREDICT_KEYS（前置：源码读得到，不能空洞通过）`)
  for (const k of ['on', 'config', 'retention']) {
    ok(!code.includes(`'${PREDICT_KEYS[k]}'`),
      `I3b ${rel} 里没有 '${PREDICT_KEYS[k]}' 的字面量（键名只有 shared 一个出处）`)
  }
}
// 保留期**不经** setExtras：那条路会因为非 ui: 键触发一次全量重采集（AC4 的「无新增请求」）
ok(!/setExtras\([\s\S]{0,200}?PREDICT_KEYS\.retention/.test(appCode2),
  'I4 App 不经 setExtras 写保留期（它归主进程的 usage:setRetention 通道所有）')
// 权威键必须被**读**：显示值读的是 ui:predictConfig 里的副本时，改完保留期重启就回退
ok(appCode2.includes('PREDICT_KEYS.retention') && /parseInt\(raw\(PREDICT_KEYS\.retention\)/.test(appCode2),
  'I5 App 从权威键读保留期（不在 ui:predictConfig 里另存一份 —— 两份必然漂）')
ok(/PREDICT_KEYS\.config[^\n]*JSON\.stringify\(\{\s*windowDays/.test(appCode2.replace(/\s+/g, ' ')),
  'I6 写 ui:predictConfig 时只带 windowDays（保留期不在这里存副本）')

console.log(`\n通过 ${pass} · 失败 ${fail}`)
if (fail > 0) process.exit(1)
