// 用量热力图的差分与分档（renderer/src/usageHeatmap.ts）
// 用法：node scripts/test-usage-heatmap.mjs
//
// 覆盖：日增量口径（含**窗口重置天**这条最容易写错的路径）、null 不补 0、
//       强度相对分档、streak 连击口径、以及 TrendChart 的网格纪律（结构切片）。
//
// 全部经 loadTs 加载**真实源码**（scripts/lib/load-ts.mjs），一个都不内联 ——
// 内联过的测试已经漂移过一次（test-percent.mjs），源文件改了测试还绿着，等于没有测试。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadTs } from './lib/load-ts.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const { heatmapOf, maxDelta, intensityOf, streakOf } = await loadTs('src/renderer/src/usageHeatmap.ts')

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
function near(actual, expected, tol, label) {
  if (Math.abs(actual - expected) <= tol) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}\n      实际: ${actual}\n      期望: ${expected} (±${tol})`)
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

/** 一天一个桶。lastPct 缺省取 maxPct，省得每行都写一遍 */
function b(day, lastPct) {
  return { day, lastPct, maxPct: lastPct }
}
const D = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']

console.log('\nA. 日增量口径')

{
  // 基本差分：cur - prev
  const days = heatmapOf([b(D[0], 40), b(D[1], 55)])
  eq(days[1].deltaPp, 15, 'A1 第二天的 delta = cur - prev')
  eq(days[0].deltaPp, null, 'A2 第一天没有对比基准 → null（不是 0：0 会被读成「那天没用」）')
  eq(days.map((d) => d.lastPct), [40, 55], 'A3 lastPct 原样透传')
}

{
  // ⚠ 最容易写错的一条：窗口重置（cur < prev）。用量不会自己下降，下降只可能是换了周期。
  // 若按 cur - prev 算，重置那天是负数 → streak 断 + 图上是负增量，而实际那天用量很高。
  const days = heatmapOf([b(D[0], 95), b(D[1], 30)])
  eq(days[1].deltaPp, 30, 'A4 重置天 delta = cur（新周期当天的用量），不是 cur - prev 的负数')
  ok(days[1].deltaPp > 0, 'A4b 重置天的 delta 是正的（streak 不因重置断掉）')
}

{
  // 持平 = 0，不是 null：那天确实有采样，只是没涨
  eq(heatmapOf([b(D[0], 40), b(D[1], 40)])[1].deltaPp, 0, 'A5 持平 delta = 0（与「没采到」的 null 区分）')
}

console.log('\nB. null 不补 0（缺失值必须保持缺失）')

{
  // prev 未知 → 这天的 delta 不能拿 0 去减
  const days = heatmapOf([b(D[0], null), b(D[1], 50)])
  eq(days[0].lastPct, null, 'B1 缺样本天的 lastPct 保持 null')
  eq(days[1].deltaPp, null, 'B2 prev 未知 → delta null（拿 0 去减会把「没采到」读成「涨到 50」）')
  eq(days[1].lastPct, 50, 'B2b lastPct 自己不受影响')
}

{
  // cur 未知 → delta null，且**不更新 prev**：否则下一天会跟这个「没采到」比
  const days = heatmapOf([b(D[0], 40), b(D[1], null), b(D[2], 60)])
  eq(days[1].deltaPp, null, 'B3 cur 未知 → delta null')
  eq(days[2].deltaPp, 20, 'B4 中间缺一天时，第三天的 prev 仍是 40（不是被 null 顶掉）')
}

{
  // 全缺 → 全 null，不抛
  const days = heatmapOf([b(D[0], null), b(D[1], null)])
  eq(days.map((d) => d.deltaPp), [null, null], 'B5 全部缺样本 → delta 全 null')
}

console.log('\nC. maxDelta（强度分档的相对标尺）')

{
  eq(maxDelta(heatmapOf([b(D[0], 10), b(D[1], 30), b(D[2], 55)])), 25, 'C1 取正增量的最大者')
  eq(maxDelta([]), 0, 'C2 空输入 → 0（不产生 NaN 坐标）')
  eq(maxDelta(heatmapOf([b(D[0], 50), b(D[1], null)])), 0, 'C3 没有正增量 → 0')
  eq(maxDelta(heatmapOf([b(D[0], 40), b(D[1], 20)])), 20, 'C4 重置天也是正增量，参与标尺')
  // 脏值不进标尺
  eq(maxDelta([{ day: D[0], lastPct: null, deltaPp: NaN }, { day: D[1], lastPct: null, deltaPp: Infinity }]),
    0, 'C5 NaN / Infinity 不计入（进了标尺会让三分位全错位）')
}

console.log('\nD. intensityOf（相对分档 0..4）')

{
  eq(intensityOf(null, 30), 0, 'D1 null → 0 档（空格；与 1 档「有记录但没涨」必须能区分）')
  eq(intensityOf(0, 30), 1, 'D2 持平 → 1 档')
  eq(intensityOf(-5, 30), 1, 'D3 负增量 → 1 档（不是负档）')
  // 三分位：delta <= max/3 → 2；<= 2max/3 → 3；否则 4
  eq(intensityOf(10, 30), 2, 'D4 10 <= 30/3 → 2 档')
  eq(intensityOf(20, 30), 3, 'D5 20 <= 2*30/3 → 3 档')
  eq(intensityOf(21, 30), 4, 'D6 21 > 20 → 4 档')
  eq(intensityOf(30, 30), 4, 'D7 等于 max → 4 档（不越界）')
  // ⚠ 标尺坏了（max <= 0）时正增量仍要有档：回 2，而不是退回 0 档（空格）
  eq(intensityOf(12, 0), 2, 'D8 max=0 时正增量 → 2 档（回 0 会让整张图变成空格）')
  eq(intensityOf(12, NaN), 2, 'D9 max=NaN 时同上')
}

console.log('\nE. streakOf（火焰 = 连续正增量天数）')

{
  eq(streakOf([]), { streak: 0, sampledDays: 0, todayDelta: null, todayPct: null },
    'E1 空输入 → 全零（调用方据此不画头）')

  // 从**最后**一天往前数，遇到 null / <=0 即断。第一天没有对比基准（delta null），
  // 所以 n 天数据的 streak 上限是 n-1。
  const days = heatmapOf([b(D[0], 10), b(D[1], 20), b(D[2], 35), b(D[3], 50)])
  const s = streakOf(days)
  eq(s.streak, 3, 'E2 4 天里 3 个正增量 → streak = 3（第一天无对比基准，不算连击）')
  eq(s.sampledDays, 4, 'E2b 有采样天数 = 4')
  eq(s.todayDelta, 15, 'E2c 徽标 = 今日增量')
  eq(s.todayPct, 50, 'E2d 末值也一并给出')

  // 持平（0）断 streak
  eq(streakOf(heatmapOf([b(D[0], 10), b(D[1], 20), b(D[2], 20)])).streak, 0,
    'E3 最后一天持平 → streak 断（跳过持平会让「天天在用」与「昨天没用」显示成同一个连击数）')

  // 中间缺采断 streak
  eq(streakOf(heatmapOf([b(D[0], 10), b(D[1], null), b(D[2], 30)])).streak, 1,
    'E4 中间缺一天 → streak 从缺那天断，只数得到今天的 1 天')

  // sampledDays 只数 lastPct 已知的天
  eq(streakOf(heatmapOf([b(D[0], 10), b(D[1], null), b(D[2], 30)])).sampledDays, 2,
    'E5 有采样天数不含缺样本的天')

  // 重置天不算断（delta = cur > 0）
  eq(streakOf(heatmapOf([b(D[0], 95), b(D[1], 30), b(D[2], 45)])).streak, 2,
    'E6 重置天 delta=cur 是正的 → streak 不因此断（3 天里 2 个正增量；这是 R4 的验收点）')

  // 今天还没第二次采样 → 徽标回退到末值
  const one = streakOf(heatmapOf([b(D[0], 42)]))
  eq(one.todayDelta, null, 'E7 只有一天 → todayDelta null')
  eq(one.todayPct, 42, 'E7b 回退显示末值')

  // 今天没采到 → 两个都 null
  const none = streakOf(heatmapOf([b(D[0], 42), b(D[1], null)]))
  eq([none.todayDelta, none.todayPct], [null, null], 'E8 最后一天缺样本 → 徽标两个数都拿不到')
}

console.log('\nF. 纯度与纪律')

{
  const src = readFileSync(resolve(ROOT, 'src/renderer/src/usageHeatmap.ts'), 'utf-8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ok(code.trim().length > 0, 'F0 前置：模块源码读得到（下面的负向断言不能空洞通过）')
  ok(!/Date\.now\(|new Date\(/.test(code), 'F1 不读自己的钟（日历日由上游 bucketByDay 切好传进来）')
  ok(!/window\.|document\./.test(code), 'F2 不碰 window / DOM（纯差分与分档）')
  ok(!/Math\.random/.test(code), 'F3 没有随机性')
  // 入参不被就地修改
  const buckets = [b(D[0], 10), b(D[1], 25)]
  const before = JSON.stringify(buckets)
  heatmapOf(buckets)
  eq(JSON.stringify(buckets), before, 'F4 入参不被就地修改（热路径每 30s 重算一次，改坏入参会累积）')
}

console.log('\nG. TrendChart 的网格纪律（结构切片）')

{
  const tc = readFileSync(resolve(ROOT, 'src/renderer/src/TrendChart.tsx'), 'utf-8')
  // 取数与分档必须走纯函数，不能内联口径
  ok(/heatmapOf\(buckets\)/.test(tc), 'G1 差分走 heatmapOf（内联就会漂）')
  ok(/intensityOf\(c\.day\.deltaPp,\s*mx\)/.test(tc), 'G2 分档走 intensityOf，且标尺是本轮的 maxDelta')
  ok(/maxDelta\(heatDays\)/.test(tc), 'G3 标尺只取当前窗口的 maxDelta（不跨窗口比，切换后深浅会变是刻意的）')
  ok(/streakOf\(heatDays\)/.test(tc), 'G4 streak 走纯函数')
  // 空格纪律：缺样本不画格，且**不画最浅档**
  ok(/if \(c\.day\.lastPct == null\) return null/.test(tc),
    'G5 lastPct 为 null 的天不画格（画 1 档 = 把「应用没跑」读成「那天没用」）')
  ok(!/heat-0/.test(tc), 'G6 TS 里不出现 heat-0（0 档没有对应 DOM 节点；出现说明有人把空格渲出来了）')
  // 空态纪律
  ok(/if \(buckets\.length === 0\) return null/.test(tc), 'G7 空 buckets → null（不是空壳）')
  ok(/if \(cells\.length === 0\) return null/.test(tc), 'G8 一个格都没有 → null')
  // 日历几何：列 = 周，行 = 周一..周日
  ok(/weekdayMon/.test(tc), 'G9 行坐标走 weekdayMon（周一=0..周日=6，不是 JS 的周日=0）')
  // 悬停双数
  ok(/末值/.test(tc) && /日增量/.test(tc), 'G10 悬停同时给末值% 与日增量pp')
  ok(/未采样/.test(tc), 'G11 缺失如实写「未采样」（不拿 0 充数）')
}

console.log('\nH. 颜色只用既有 token（D5）')

{
  const css = readFileSync(resolve(ROOT, 'src/renderer/src/skins.css'), 'utf-8')
  // 抠出热力图段，别把整个 skins.css 的字面量都算进来
  const start = css.indexOf('/* 用量热力图（P1-1）')
  ok(start > 0, 'H0 前置：找得到热力图段（下面的负向断言不能空洞通过）')
  const seg = css.slice(start, css.indexOf('.wmodels', start))
  ok(!/[#][0-9a-fA-F]{3,8}\b/.test(seg), 'H1 热力图段没有色值字面量（外部皮肤只吃得到 var()）')
  ok(!/rgba?\(/.test(seg), 'H2 热力图段没有 rgba() 字面量')
  ok(/color-mix\(in srgb, var\(--ok\)/.test(seg), 'H3 强度档用 color-mix(--ok, --track) 派生（不是四个新颜色）')
  // 空格与 1 档必须不同色
  ok(/\.trend-cell\s*{\s*fill: var\(--track\)/.test(seg), 'H4 空格用 --track')
  ok(/\.heat-1\s*{/.test(seg) && /var\(--ok\)/.test(seg), 'H5 1 档含 --ok（与空格的 --track 区分）')
}

// ═══ I. 绝对量口径：热力图与逐日明细必须一致 ═══════════════════════════════════
// 为什么要单独一段：百分比是相对数 —— $12 额度和 $120 额度都可以是 60%。用户问
// 「今天具体花了多少钱」只有绝对值能答。绝对量沿用了**同一条** reset 口径
// （cur < prev 视为换周期，delta = cur 而不是负数），两条口径一旦分叉就会出现
// 「热力图这天最深、明细这天用量是负的」这种自相矛盾的显示。
console.log('\nI. 绝对量口径与逐日明细')

{
  const u = (day, lastPct, lastUsed, unit) => ({ day, lastPct, maxPct: lastPct, lastUsed, unit })

  eq(heatmapOf([u(D[0], 20, 2, 'usd'), u(D[1], 50, 5, 'usd')]).map((h) => h.deltaUsed), [null, 3],
    'I1 绝对量走同一条口径：deltaUsed = 5 - 2 = 3；首日无基准 = null')
  eq(heatmapOf([u(D[0], 95, 100, 'usd'), u(D[1], 30, 30, 'usd')]).map((h) => h.deltaUsed), [null, 30],
    'I2 重置天 deltaUsed = cur = 30（不是 -70）—— 与 deltaPp 的 R4 完全同口径')

  eq(
    heatmapOf([
      u(D[0], 10, 1, 'usd'),
      { day: D[1], lastPct: null, maxPct: null, lastUsed: null },
      u(D[2], 80, 8, 'usd')
    ]).map((h) => h.deltaUsed),
    [null, null, 7],
    'I3 缺样本天不更新 prevUsed：第 3 天仍与最后一个**已知**基准相减（8-1=7），缺口不拿 0 去减'
  )

  eq(heatmapOf([u(D[0], 50, 5, 'usd')]).map((h) => h.deltaPp), [null],
    'I4 只有 pct 没有 used → deltaPp 不受影响')
  eq(heatmapOf([u(D[0], 50, 5, 'usd')]).map((h) => h.deltaUsed), [null],
    'I5 只有 pct 没有 used → deltaUsed = null（**不是 0**；未知就是未知）')

  const h0 = heatmapOf([{ day: D[0], lastPct: 50, maxPct: 50, lastUsed: null }])[0]
  ok(h0.unit === undefined, 'I6 unit 缺失时保持 undefined（不臆造单位）')
  eq(h0.lastUsed, null, 'I6b lastUsed 保持 null')

  // 明细表的结构纪律（读源码切片，与 G 段同一手法）
  // ⚠ 从 `function usedLabel` 切而不是从 TrendRecords 切：usedLabel / cellTitle 定义在它
  //   前面，切晚了这两个函数就不在切片里，下面的断言会空洞通过。
  const tc = readFileSync(resolve(ROOT, 'src/renderer/src/TrendChart.tsx'), 'utf-8')
  const seg = tc.slice(tc.indexOf('function usedLabel'))
  ok(seg.length > 0, 'I10 前置：切得到 usedLabel + TrendRecords（下面的负向断言不能空洞通过）')
  ok(/\.filter\(\(d\)\s*=>\s*d\.lastPct\s*!=\s*null\)/.test(seg),
    'I7 明细只列有采样的天（用户明确不要空行；空格是热力图的「位置」信息）')
  ok(/\.reverse\(\)/.test(seg), 'I8 明细新近优先（与热力图左→右相反，查账用）')
  ok(/deltaUsed\s*!=\s*null/.test(seg) && /lastUsed\s*!=\s*null/.test(seg),
    'I9 绝对量优先当天增量，首日无基准回退累计（并在文案里标明「累计」口径）')
  ok(/return '—'/.test(seg), 'I10b 升级前的旧采样没有绝对量 → 显示「—」（不填 0）')
  ok(/<TrendRecords days=\{heatDays\}\s*\/>/.test(tc), 'I11 逐日明细接进 TrendChart')

  // 明细的样式段：同样只用既有 token
  const css2 = readFileSync(resolve(ROOT, 'src/renderer/src/skins.css'), 'utf-8')
  const recStart = css2.indexOf('/* ── 逐日明细')
  ok(recStart > 0, 'I12 前置：找得到逐日明细样式段（下面的负向断言不能空洞通过）')
  const recSeg = css2.slice(recStart, css2.indexOf('.wmodels', recStart))
  ok(recSeg.length > 0, 'I13 前置：明细样式段非空')
  ok(!/[#][0-9a-fA-F]{3,8}\b/.test(recSeg), 'I14 明细样式段没有色值字面量')
  ok(!/rgba?\(/.test(recSeg), 'I15 明细样式段没有 rgba() 字面量')
  ok(/var\(--surface-sunken\)/.test(recSeg) && /var\(--fg-faint\)/.test(recSeg),
    'I16 明细样式只用既有 token（换皮肤自动跟着走）')
}

console.log(`\n通过 ${pass} · 失败 ${fail}`)
if (fail > 0) process.exit(1)
