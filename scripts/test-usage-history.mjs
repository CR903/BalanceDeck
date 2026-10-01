// 历史趋势图的聚合与坐标换算（renderer/src/usageHistory.ts）
// 用法：node scripts/test-usage-history.mjs
//
// 覆盖：本地日历日切分、**末值取最后一个已知值**（本设计最容易写错的一处）、
//       缺样本的日子不补 0、纵轴固定 0..100、横轴等距、窗口过滤、纯度与纯函数纪律。
//
// 全部经 loadTs 加载**真实源码**（scripts/lib/load-ts.mjs）：bucketByDay / scaleY / xOf /
// windowsWithHistory 一个都不内联 —— 内联过的测试已经漂移过一次（test-percent.mjs），
// 源文件改了测试还绿着，等于没有测试。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadTs } from './lib/load-ts.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const { bucketByDay, scaleY, xOf, windowsWithHistory, dayKey, cutoffDayKey, TREND_MAX_DAYS } =
  await loadTs('src/renderer/src/usageHistory.ts')

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

const HOUR = 3600_000
const T0 = 1_700_000_000_000

/** 造一个「本地日历第 offsetDays 天的 hh 时」的时刻（与 test-usage-store 的 dayAt 同一构造） */
function dayAt(offsetDays, hour = 12) {
  const d = new Date(T0)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays, hour).getTime()
}
const pt = (pct, t) => ({ t, pct })
/** 某一天的已知序列：pcts 按 15 分钟铺开 */
function onDay(offsetDays, pcts, hour = 12) {
  const base = dayAt(offsetDays, hour)
  return pcts.map((pct, i) => ({ t: base + i * 15 * 60_000, pct }))
}
const lastPcts = (buckets) => buckets.map((b) => b.lastPct)
const days = (buckets) => buckets.map((b) => b.day)

// ═══ A. 本地日历日分桶 ═════════════════════════════════════════════════════════
console.log('\nA. 按本地日历日切分')

{
  // now = 第 6 天 20:00，回看 7 天 → 窗口是第 0..6 天
  const now = dayAt(6, 20)
  const pts = [...onDay(0, [10]), ...onDay(6, [50, 55])]
  const b = bucketByDay(pts, 7, now)
  eq(b.length, 7, 'A1 桶数 = 可见天数（从第一天有采样到今天）')
  eq(days(b)[0], dayKey(dayAt(0)), 'A2 第一个桶是第一天')
  eq(days(b)[6], dayKey(dayAt(6)), 'A3 最后一个桶是今天')
  eq(lastPcts(b), [10, null, null, null, null, null, 55],
    'A4 没采样的中间几天 lastPct = null（不补 0 —— 那会让用户以为「那几天用量是 0」）')
  eq(b[6].maxPct, 55, 'A5 峰值取当天最大已知值')
}

// 日历日而非 UTC 日：本地 23:00 的采样必须算「今天」，不能因为 UTC 是次日就被切走
{
  const late = new Date(2026, 8, 29, 23, 30).getTime()
  const b = bucketByDay([pt(42, late)], 1, late)
  eq(days(b), ['2026-09-29'], 'A6 本地 23:30 的采样算「当天」（跨时区用 UTC 日会算成明天）')
  eq(b[0].lastPct, 42, 'A7 同上，值没丢')
}

// 早于 cutoff 的点被丢掉
{
  const now = dayAt(6, 20)
  // 第 -3 天（8 天前）那个 80% 必须被丢掉；第 1..6 天照常分桶
  const b = bucketByDay([...onDay(-3, [80]), ...onDay(1, [10]), ...onDay(6, [55])], 7, now)
  eq(b.length, 6, 'A8 窗口之外的点被丢掉（8 天前那个 80% 既不进桶也不把窗口撑长）')
  eq(days(b)[0], dayKey(dayAt(1)), 'A9 第一个桶 = 窗口内第一天有采样的日子')
  eq(lastPcts(b), [10, null, null, null, null, 55],
    'A10 被丢掉的点没有污染任何桶（80% 不在任何一根柱上）')
}

// 空历史 → 空数组（而不是 30 个空桶：那是画一张「用量都是 0」的假图）
eq(bucketByDay([], 7, T0), [], 'A11 空历史 → []（TrendPanel 据此什么都不显示）')
eq(bucketByDay(null, 7, T0), [], 'A12 null 入参不抛（IPC 返回可能是 {})')
eq(bucketByDay(undefined, 7, T0), [], 'A13 undefined 入参不抛')

// 脏点（t 非有限数）跳过，不炸
{
  const now = dayAt(0, 20)
  const b = bucketByDay([{ t: Number.NaN, pct: 10 }, pt(30, dayAt(0, 12))], 1, now)
  eq(lastPcts(b), [30], 'A14 t=NaN 的脏点被跳过（它连属于哪一天都说不清）')
}

console.log('\nB. 末值 = 最后一个**已知**值（本设计最容易写错的一处）')

{
  const now = dayAt(0, 20)
  const b = bucketByDay(onDay(0, [10, 30, 55]), 1, now)
  eq(b[0].lastPct, 55, 'B1 末值 = 数组最后一个')
  eq(b[0].maxPct, 55, 'B2 峰值同值（单点序列）')
}

// ⚠ 核心断言：末尾是采样失败记下的 null 时，要**跳过它继续往前找**，
//   不是取数组最后一个（那是 null），也不是按 0 处理。
{
  const now = dayAt(0, 20)
  const b = bucketByDay(onDay(0, [10, 30, 55, null]), 1, now)
  eq(b[0].lastPct, 55, 'B3 末尾是 null → 取前一个已知值 55（不是 null，也不是 0）')
}
{
  const now = dayAt(0, 20)
  const b = bucketByDay(onDay(0, [null, 30, null, null]), 1, now)
  eq(b[0].lastPct, 30, 'B4 null 夹在中间也不清空已知的末值')
}
{
  const now = dayAt(0, 20)
  const b = bucketByDay(onDay(0, [null, null, null]), 1, now)
  eq(b[0].lastPct, null, 'B5 全 null 的天 → lastPct = null（不产生柱）')
}
{
  const now = dayAt(0, 20)
  const b = bucketByDay(onDay(0, [null, 20, null]), 1, now)
  eq(b[0].maxPct, 20, 'B6 峰值跳过 null（null 不参与 max）')
}

// 反向对照：这两条证明 B3 的判据不是恒真
{
  const now = dayAt(0, 20)
  const pts = onDay(0, [10, 30, 55, null])
  ok(bucketByDay(pts, 1, now)[0].lastPct !== pts[pts.length - 1].pct,
    'B7 对照：末值确实不是「数组最后一个」（那条会是 null）')
  ok(bucketByDay(pts, 1, now)[0].lastPct !== 0,
    'B8 对照：末值也不是按 0 处理（那条会让图上凭空出现一根 0% 的柱）')
}

// 多天各取自己的末值（不是全局最后一个）
{
  const now = dayAt(2, 20)
  const b = bucketByDay([...onDay(0, [10, 40]), ...onDay(1, [50, 60, null]), ...onDay(2, [70])], 3, now)
  eq(lastPcts(b), [40, 60, 70], 'B9 每天各取自己的末值')
}

// 入参乱序：按**时刻**判定，不按数组位置
{
  const now = dayAt(0, 20)
  const a = onDay(0, [10, 30, 55])
  const b = bucketByDay([a[2], a[0], a[1]], 1, now)
  eq(b[0].lastPct, 55, 'B10 入参乱序也取时刻最晚的那个（不是数组最后那个）')
}

console.log('\nC. 纵轴固定 0..100（不随数据缩放）')

const src = readFileSync(resolve(ROOT, 'src/renderer/src/usageHistory.ts'), 'utf-8')
{
  const H = 100
  near(scaleY(0, H), 100, 0.001, 'C1 0% → 底边')
  near(scaleY(100, H), 0, 0.001, 'C2 100% → 顶边')
  near(scaleY(50, H), 50, 0.001, 'C3 50% → 一半高')
  // ⚠ 相对差断言，不用绝对像素：5% 与 95% 的 y 差必须是高度的 90%。
  //   若 scaleY 改成「按数据里的最大/最小缩放」，这一条立刻变红 ——
  //   那正是「上周 90% / 本周 20% 两张图形状一样」的成因。
  const gap = (scaleY(5, H) - scaleY(95, H)) / H
  near(gap, 0.9, 0.001, 'C4 5% 与 95% 的 y 差 = 高度的 90%（纵轴没有跟着数据缩放）')
  // 反向对照：同一个数据集（5..95）缩放后仍要占满同一段高度
  const dataMax = 95
  const dataMin = 5
  const scaledGap = ((100 - (95 / dataMax) * 100) - (100 - (5 / dataMax) * 100)) / H
  ok(Math.abs(scaledGap - gap) > 0.01,
    `C5 对照：按数据缩放会给出不同的相对差（缩放版 ${scaledGap.toFixed(3)} vs 固定版 ${gap.toFixed(3)}）—— 证明 C4 测的是「有没有缩放」`)
  // 越界值钳到边界（与 Ring / Bar 同一口径），不产生图外坐标
  near(scaleY(120, H), 0, 0.001, 'C6 120% → 钳到顶边')
  near(scaleY(-5, H), 100, 0.001, 'C7 -5% → 钳到底边')
  near(scaleY(Number.NaN, H), 100, 0.001, 'C8 NaN → 钳到底边（不是 NaN 坐标，图会整块消失）')
  // ⚠ 「不随数据缩放」这条**结构上**钉住：C4 只判函数本身，一旦有人给它加上第三个
  //   `maxPct` 参数（默认值 100）并在组件里传「数据里的最大值」，C4 照样绿（默认值仍走 100），
  //   而图已经缩放了 —— 那正是「上周 90% / 本周 20% 形状一样」的成因。
  //   签名正则走 `[^)]*,[^)]*,` 而不是逐字符匹配：`[^)]` 含换行，重排版也不会误红。
  //   ⚠ 判据必须是**源码签名**而不是 `scaleY.length`：带默认值的形参不计入 Function.length，
  //   加上 `maxPct = 100` 之后 length 仍是 2，实测过 —— 那条门会空洞通过。
  //   ⚠ 两条负向断言都带**前置**：不带前置的负向断言在「那行代码根本不存在」时空洞通过
  //     （实测把 TrendChart 里所有 scaleY 调用去掉，C10 照样绿 —— 而图已经不走了 scaleY）。
  ok(/export function scaleY/.test(src), 'C9a 前置：scaleY 在本模块里定义（下面的负向断言不能空洞通过）')
  ok(!/export function scaleY\([^)]*,[^)]*,/.test(src),
    'C9 scaleY 的签名只有 (pct, height)，没有可缩放的上界参数')
  const tcSrc = readFileSync(resolve(ROOT, 'src/renderer/src/TrendChart.tsx'), 'utf-8')
  ok(/scaleY\(/.test(tcSrc), 'C10a 前置：TrendChart 确实在调 scaleY（C10 不能空洞通过）')
  ok(!/scaleY\([^)]*,[^)]*,/.test(tcSrc),
    'C10 TrendChart 不给 scaleY 传第三个参数（那会让「本周 20%」也铺满整幅图）')
}

console.log('\nD. 横轴等距')

{
  const W = 300
  near(xOf(0, 10, W), 15, 0.001, 'D1 第一根柱在第一个槽的中心')
  near(xOf(9, 10, W), 285, 0.001, 'D2 最后一根柱在最后一个槽的中心')
  near(xOf(1, 10, W) - xOf(0, 10, W), 30, 0.001, 'D3 相邻等距（槽宽 = width/count）')
  near(xOf(0, 10, W), 30 - 15, 0.001, 'D4 起点留半槽，首尾对称')
  // ⚠ count===1 不除零：除以零会得到 NaN，而 SVG 属性里 NaN **静默不渲染**
  //   —— 症状是「一根柱凭空消失」，不报错。
  near(xOf(0, 1, W), 150, 0.001, 'D5 count=1 → 落在正中（不产生 NaN）')
  ok(Number.isFinite(xOf(0, 1, W)), 'D6 count=1 的 x 是有限数（NaN 会让那根柱静默消失）')
  ok(Number.isFinite(xOf(0, 0, W)), 'D7 count=0 也是有限数')
}

console.log('\nE. 窗口筛选（供切换控件）')

eq(windowsWithHistory({ 本月: [pt(1, T0)], 本周: [] }), ['本月'], 'E1 没点位的窗口不列（切过去只能看到空图）')
eq(windowsWithHistory({ 本月: [pt(1, T0)], 本周: [pt(2, T0)] }), ['本月', '本周'], 'E2 两个窗口都有历史 → 都列')
eq(windowsWithHistory({}), [], 'E3 没有窗口 → 空数组')
eq(windowsWithHistory(null), [], 'E4 null 入参不抛（IPC 返回可能是 {})')
eq(windowsWithHistory({ 本月: [] }), [], 'E5 空数组不算「有历史」')

console.log('\nF. 纯函数纪律与纯度')

{
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ok(code.trim().length > 0, 'F0 前置：模块源码读得到（下面的负向断言不能空洞通过）')
  ok(!/Date\.now\(|new Date\(\s*\)/.test(code),
    'F1 纯函数里没有读自己的钟（now 一律由入参传，否则「同一天」成了运行环境的函数）')
  ok(!/window\.|document\./.test(code), 'F2 不碰 window / DOM（纯聚合）')
  ok(!/Math\.random/.test(code), 'F3 没有随机性（同一份输入必须给出同一份结果）')
  ok(!/\.sort\(/.test(code.replace(/\.sort\(\(a, b\) => a\.t - b\.t\)/, '')),
    'F4 唯一的 sort 在**副本**上（就地排序会改坏入参）')
}

// 入参不被就地修改（深比较）
{
  const now = dayAt(2, 20)
  const pts = [...onDay(0, [10, 40]), ...onDay(2, [70, null])]
  const before = JSON.stringify(pts)
  const byWindow = { 本月: pts }
  const beforeMap = JSON.stringify(byWindow)
  bucketByDay(pts, 3, now)
  bucketByDay(byWindow['本月'], 30, now)
  windowsWithHistory(byWindow)
  eq(JSON.stringify(pts), before, 'F5 入参 points 未被就地修改（深比较）')
  eq(JSON.stringify(byWindow), beforeMap, 'F6 传进 windowsWithHistory 的对象也没被改')
}

// 纯度：同一份输入调两次结果相等
{
  const now = dayAt(2, 20)
  const pts = [...onDay(0, [10, 40, null]), ...onDay(2, [70])]
  eq(bucketByDay(pts, 3, now), bucketByDay(pts, 3, now), 'F7 bucketByDay 纯度（无隐藏的轮次状态）')
  eq(scaleY(42, 76), scaleY(42, 76), 'F8 scaleY 纯度')
  eq(xOf(3, 7, 320), xOf(3, 7, 320), 'F9 xOf 纯度')
}

// 单一出处：日分桶口径与主进程 usageStore 一致
{
  ok(/function dayKey/.test(src),
    'F10 本模块自带 dayKey（与 usageStore 的同名函数同一纪律；散落三处各写一遍必然漂）')
  near(TREND_MAX_DAYS, 30, 0, 'F10b 取数上限 30 天（7/30 两视图共用同一次 IPC 的前提）')
}

// ═══ G. 取数 hook 的三条纪律（结构切片，不是整文 grep）══════════════════════════
//
// 为什么单开一段：PRD 的第 4 / 5 / 6 条（切换不重发 IPC、余额类不发、不受 predictOn 管）
// 全都落在 `DetailView.tsx` 的 `useUsageHistory` 里，而 `npm test` 的 17 个套件**没有一个**
// 碰过 DetailView —— 这正是本仓记录过的那类事故（「开关看起来是活的，测试与 tsc 全绿」）。
//
// ⚠ 为什么用结构切片而不是整文 `grep`：这个 hook 的注释里就写着「依赖数组里**不含 now**」
//   「不挂 now / on」，整文 grep 匹配到的是**注释**。本仓已明确点名的假守卫种类：
//   「在注释里断言」等于没有断言（quality-guidelines「Don't: assert on text you found in a
//   comment」）。所以下面一律按**调用形状**切：函数体 → 依赖数组字面量 → 早退守卫。
console.log('\nG. 取数 hook 的三条纪律（DetailView.tsx）')

const dvSrc = readFileSync(resolve(ROOT, 'src/renderer/src/DetailView.tsx'), 'utf-8')
const tcSrcAll = readFileSync(resolve(ROOT, 'src/renderer/src/TrendChart.tsx'), 'utf-8')

/** 从 `function <name>(` 切到下一个顶层声明（注释块 / function / export）之前 */
function sliceFn(src, name) {
  const at = src.indexOf(`function ${name}(`)
  if (at < 0) return null
  const rest = src.slice(at)
  const m = rest.slice(1).search(/\n(?:\/\*\*|function|export)/)
  return m < 0 ? rest : rest.slice(0, m + 1)
}

/** 取 hook 里 useEffect 的依赖数组**内容**（React 写法：}, [ … ])），不含方括号 */
function depsOf(fnSrc) {
  if (!fnSrc) return null
  const i = fnSrc.lastIndexOf('}, [')
  if (i < 0) return null
  const open = fnSrc.indexOf('[', i)
  const close = fnSrc.indexOf(']', open)
  return open < 0 || close < 0 ? null : fnSrc.slice(open + 1, close)
}

const histFn = sliceFn(dvSrc, 'useUsageHistory')
ok(histFn != null && depsOf(histFn) != null,
  'G0 前置：切得到 useUsageHistory 的 useEffect 依赖数组（下面的断言不能空洞通过）')

const deps = depsOf(histFn) ?? ''
{
  // ① 依赖数组不含 now —— 含了则 30s 倒计时钟每转一圈就重发一次 IPC
  ok(!/\bnow\b/.test(deps),
    `G1 依赖数组 [${deps.replace(/\s+/g, ' ')}] 不含 now（否则 30s 倒计时钟每圈重发一次 IPC）`)
  ok(/\bproviderId\b/.test(deps),
    'G2 依赖数组含 providerId（换供应商才重取 —— 这是 G1 成立的前提：靠它触发，不靠时间）')

  // ② 余额类不发 IPC：早退守卫必须在 IPC 调用**之前**（只判「不渲染」而请求已发，是静默失效）
  const body = histFn ?? ''
  const call = body.indexOf('usagePredict(')
  ok(call > 0, 'G3a 前置：hook 里能找到 usagePredict 调用')
  const before = body.slice(0, call)
  ok(/!on\b/.test(before) && /isPlan\(/.test(before),
    'G3 IPC 之前有 `!on` + isPlan 双闸门（余额类不请求，而不只是不渲染）')
  ok(/usagePredict\(\s*providerId,\s*TREND_MAX_DAYS/.test(body),
    'G4 一次取 TREND_MAX_DAYS 天（7/30 共用一次 IPC 的前提；改成跟着 UI 变的 days 就不成立）')

  // ③ 不受 predictOn 管：hook 的第二参数是 planish，不是 predictOn
  ok(/useUsageHistory\(\s*s,\s*planish\s*\)/.test(dvSrc),
    'G5 TrendPanel 的取数开关是 planish（有没有这家且是套餐类），不是 predictOn')
  ok(!/useUsageHistory\([^)]*predictOn/.test(dvSrc),
    'G5b useUsageHistory 的调用点不接 predictOn（接了则「关掉预计耗尽」会连带让趋势图消失）')
}

// 空历史 → 不渲染（不是渲染一个空壳）；缺样本的天 → 不画柱
{
  ok(/if \(buckets\.length === 0\) return null/.test(tcSrcAll),
    'G6 TrendChart 收到空 buckets 返回 null（界面上什么都不显示，不是空壳）')
  ok(/if \(b\.lastPct == null\) return null/.test(tcSrcAll),
    'G7 lastPct 为 null 的天不画柱（缺口可见；画一根 0 高的柱与补 0 等价）')
  // ⚠ 「有历史」不等于「这个回看窗口里有历史」：最后一次采样在 10 天前、之后应用没跑时，
  //   windowsWithHistory 照样列出该窗口。若 TrendPanel 只判 windows.length，
  //   界面上就是一个「用量趋势」标题 + 两组切换钮、底下空着 —— 比不显示更像坏了。
  ok(/if \(windows\.length === 0\) return null/.test(tcSrcAll),
    'G8a 前置：TrendPanel 至少要判「没有任何有历史的窗口」就返回 null')
  ok(/if \(!windows\.some\(/.test(tcSrcAll),
    'G8 TrendPanel 在当前回看窗口里一个桶都没有时也返回 null（有历史≠窗口内有历史）')
}

console.log(`\n通过 ${pass} · 失败 ${fail}`)
if (fail > 0) process.exit(1)