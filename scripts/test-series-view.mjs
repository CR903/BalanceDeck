// 用量趋势「窗口驱动序列视图」的纯函数与结构纪律（renderer/src/seriesView.ts）
// 用法：node scripts/test-series-view.mjs
//
// 覆盖：
//   · 窗口名 → 粒度（5 小时 = 小时桶，周/月 = 日桶）与节点标签格式；
//   · 官方桶 → 节点（搬运 + 非法值落向 null/0）；
//   · 本机采样 → 节点（**重置感知增量**、首桶无基准不补 0、缺采样不补 0）；
//   · bucketByHour 的三条纪律（末值取最后一个已知、缺口可见、纯度）；
//   · 数据源诚实纪律（官方 key 存在就不退回本机；退回必须标注「本机估算」）的结构切片。
//
// 全部经 loadTs 加载**真实源码**，不内联实现（内联过的测试漂移过，见 test-percent.mjs）。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadTs } from './lib/load-ts.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const {
  granularityOf,
  nodeLabel,
  officialSeriesNodes,
  localSeriesNodes,
  maxCostOf,
  SERIES_GRANULARITY
} = await loadTs('src/renderer/src/seriesView.ts')
const { bucketByHour } = await loadTs('src/renderer/src/usageHistory.ts')

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

function dayAt(offsetDays, hour = 12) {
  const d = new Date(T0)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays, hour).getTime()
}
/** 相对 T0 第 offsetHours 小时的 hh:minute（本地） */
function hourAt(offsetHours, minute = 5) {
  const d = new Date(T0 + offsetHours * HOUR)
  d.setMinutes(minute, 0, 0)
  return d.getTime()
}
const dayPoint = (off, used, pct = 10) => ({ t: dayAt(off, 12), pct, used, unit: 'usd' })

// ═══ A. 粒度与标签 ════════════════════════════════════════════════════════════
console.log('\nA. 窗口 → 粒度（5 小时逐小时、周/月逐日）')
{
  eq(granularityOf('5 小时'), 'hour', 'A1 5 小时 = 小时桶（官方 cost-by-day?bucket=hour）')
  eq(granularityOf('本周'), 'day', 'A2 本周 = 日桶')
  eq(granularityOf('本月'), 'day', 'A3 本月 = 日桶')
  eq(granularityOf('未知窗口'), 'day', 'A4 认不出的窗口落向日桶（保守，不编小时）')
  eq(Object.keys(SERIES_GRANULARITY).sort(), ['5 小时', '本月', '本周'].sort(), 'A5 三窗口都有映射')
}

console.log('\nB. 节点标签（本地时区）')
{
  const noon = dayAt(0, 9)
  ok(/^\d{2}:00$/.test(nodeLabel(new Date(noon).toISOString(), 'hour')), 'B1 小时桶标签为 HH:00')
  eq(nodeLabel(new Date(noon).toISOString(), 'hour'), '09:00', 'B2 小时标签取本地小时')
  ok(/^\d{2}-\d{2} 周[一二三四五六日]$/.test(nodeLabel(new Date(noon).toISOString(), 'day')), 'B3 日桶标签为 MM-DD 周X')
  eq(nodeLabel('not-a-date', 'day'), 'not-a-date', 'B4 非法时间原样回显（不抛）')
}

// ═══ C. 官方桶 → 节点 ═════════════════════════════════════════════════════════
console.log('\nC. officialSeriesNodes（官方数据搬运）')
{
  const nodes = officialSeriesNodes([
    { t: '2026-10-11T04:00:00Z', bucket: 'hour', cost: 0.25, tokens: 1500, requests: 3 },
    { t: '2026-10-11T07:00:00Z', bucket: 'hour', cost: 1, tokens: 9000, requests: 12 }
  ])
  eq(nodes.length, 2, 'C1 两个节点全收')
  eq(nodes[0].cost, 0.25, 'C2 金额原样搬运（已是 USD）')
  eq(nodes[0].tokens, 1500, 'C3 tokens 原值')
  eq(nodes[0].requests, 3, 'C4 请求数原值')
  ok(/^\d{2}:00$/.test(nodes[0].label), 'C5 标签按官方 bucket 粒度生成')

  // 非法 cost → null（显示「—」），**不落向 0**
  eq(officialSeriesNodes([{ t: '2026-10-11T04:00:00Z', bucket: 'hour', cost: Number.NaN, tokens: 0, requests: 0 }])[0].cost, null,
    'C6 非法金额 → null（不是 0）')
  eq(officialSeriesNodes(null), [], 'C7 null 入参不抛')
}

console.log('\nD. maxCostOf（柱高标尺）')
{
  eq(maxCostOf([{ t: 'a', label: 'a', cost: 1, tokens: 0, requests: 0 }, { t: 'b', label: 'b', cost: 5, tokens: 0, requests: 0 }]), 5, 'D1 取最大已知花费')
  eq(maxCostOf([{ t: 'a', label: 'a', cost: null, tokens: 0, requests: 0 }]), 0, 'D2 全未知 → 0（不产生 NaN 坐标）')
  eq(maxCostOf([]), 0, 'D3 空 → 0')
  eq(maxCostOf([{ t: 'a', label: 'a', cost: Number.NaN, tokens: 0, requests: 0 }]), 0, 'D4 非法值忽略')
}

// ═══ E. 本机采样 → 节点（官方不可达时的降级）═══════════════════════════════════
console.log('\nE. localSeriesNodes —— 日窗口')
{
  const now = dayAt(6, 20)
  const nodes = localSeriesNodes([dayPoint(0, 5), dayPoint(1, 20)], '本周', now)
  eq(nodes.map((n) => n.cost), [null, 15, null, null, null, null, null],
    'E1 首日无基准 → cost=null；次日 20-5=15；没采到的日不补 0')
  ok(/^\d{2}-\d{2} 周/.test(nodes[0].label), 'E2 日节点标签')

  // 窗口重置天：used 从 95 掉到 30 → 取 30（不是 -65）
  const reset = localSeriesNodes([dayPoint(0, 95), dayPoint(1, 30)], '本月', now)
  eq(reset.map((n) => n.cost), [null, 30, null, null, null, null, null],
    'E3 重置感知：used 下降 = 换周期，取 cur 本身而不是负数')

  // 绝对量缺失的那天不补 0
  const gap = localSeriesNodes([dayPoint(0, 5), { t: dayAt(1, 12), pct: 10 }], '本周', now)
  eq(gap[1].cost, null, 'E4 缺 used 的那天 → cost=null（不是 0）')

  eq(localSeriesNodes([], '本周', now), [], 'E5 空历史 → []（调用方据此不显示）')
  eq(localSeriesNodes(null, '本周', now), [], 'E6 null 入参不抛')
}

console.log('\nF. localSeriesNodes —— 小时窗口')
{
  const now = T0
  const nodes = localSeriesNodes(
    [
      { t: hourAt(-3), pct: 5, used: 1, unit: 'usd' },
      { t: hourAt(-2), pct: 10, used: 3, unit: 'usd' },
      { t: hourAt(-1), pct: 15, used: 6, unit: 'usd' }
    ],
    '5 小时',
    now
  )
  eq(nodes.map((n) => n.cost), [null, 2, 3, null],
    'F1 逐小时重塑感知增量；首桶 null，末桶无采样也 null（不补 0）')
  ok(nodes.every((n) => /^\d{2}:00$/.test(n.label)), 'F2 小时节点标签')
  eq(nodes.map((n) => n.tokens), [0, 0, 0, 0], 'F3 本机兜底没有服务端 tokens（0 而不是编造）')

  const many = localSeriesNodes(
    Array.from({ length: 20 }, (_, i) => ({ t: hourAt(-i), pct: 1, used: i, unit: 'usd' })),
    '5 小时',
    now
  )
  ok(many.length <= 5, 'F4 小时桶数被 5 小时窗口夹住（不画出 20 根）')
}

// ═══ G. bucketByHour 的三条纪律 ═══════════════════════════════════════════════
console.log('\nG. bucketByHour —— 末值 / 缺口 / 纯度')
{
  const now = T0
  eq(bucketByHour([], 5, now), [], 'G1 空历史 → []')
  eq(bucketByHour(null, 5, now), [], 'G2 null 入参不抛')

  // 同一小时多个采样：取最后一个**已知** used；末尾 null 不清空
  const b = bucketByHour(
    [
      { t: hourAt(-1, 10), pct: 10, used: 1 },
      { t: hourAt(-1, 40), pct: 20, used: 4 },
      { t: hourAt(-1, 55), pct: null, used: null }
    ],
    5,
    now
  )
  eq(b.map((x) => x.lastUsed), [4, null], 'G3 取该小时最后一个已知 used（末尾 null 不清空、也不补 0）')
  eq(b[1].lastUsed, null, 'G4 没有采样的小时是 null，不是 0')

  // 纯度：入参不被就地修改
  const input = [{ t: hourAt(-1, 10), pct: 10, used: 1 }]
  const before = JSON.stringify(input)
  bucketByHour(input, 5, now)
  eq(JSON.stringify(input), before, 'G5 不就地修改入参')
}

// ═══ H. 数据源诚实纪律（结构切片）═════════════════════════════════════════════
console.log('\nH. 官方优先 / 本机回退标注（TrendChart + DetailView 结构切片）')
{
  const tc = readFileSync(resolve(ROOT, 'src/renderer/src/TrendChart.tsx'), 'utf-8')
  ok(/seriesByWindow\?\.\[name\]/.test(tc), 'H1 官方序列按窗口名取（key 存在即官方）')
  ok(/if \(official != null\) return officialSeriesNodes/.test(tc),
    'H2 官方 key 存在（哪怕空数组）就不退回本机 —— 空数组是「官方确认无用量」，不是「拿不到」')
  ok(/localSeriesNodes\(/.test(tc), 'H3 官方缺失才退回本机历史')
  ok(/本机估算/.test(tc), 'H4 本机回退必须标注「本机估算」（ADR-0002 诚实标注）')
  // ⚠ 只断言「不再接线」这个**机制**（import 路径 / 常量定义 / 调用），不断言注释里出现的名字 ——
  //   TrendChart 的退役说明里就写着 usageHeatmap/placeDays，整文 grep 会匹配到注释（假绿/假红）。
  ok(!/from '\.\/usageHeatmap'/.test(tc), 'H5a 不再 import 旧热力图模块（不留死接线）')
  ok(!/DAY_CHOICES\s*=/.test(tc), 'H5b 7/30 天切换常量已删除（趋势跟随左侧窗口）')
  ok(!/\bplaceDays\(/.test(tc), 'H5c 日历网格布局函数调用已删除')

  const dv = readFileSync(resolve(ROOT, 'src/renderer/src/DetailView.tsx'), 'utf-8')
  ok(/seriesByWindow=\{s\.seriesByWindow\}/.test(dv), 'H6 详情页把官方序列接进 TrendPanel')

  // H7（AC9）：余额块。⚠️ 不能只 grep `s.extraCredit` —— 那个字符串也出现在注释里，
  //   删掉整块 UI 后套件照样绿（quality-guidelines「assert on text found in a comment」）。
  //   做法：按**渲染分支**切片（`{s.extraCredit && (` → 该 section 结束），断言切片内
  //   有 `.credit-row` 与 available/balance 两个取值。删掉整块 → creditAt < 0 → 三条全红。
  const creditAt = dv.indexOf('{s.extraCredit && (')
  const closeAt = creditAt < 0 ? -1 : dv.indexOf('</section>', creditAt)
  const creditSeg = creditAt < 0 || closeAt < 0 ? '' : dv.slice(creditAt, closeAt)
  ok(creditAt >= 0, 'H7a 前置：找得到 extraCredit 的渲染分支（下面的断言不能空洞通过）')
  ok(/className="credit-row"/.test(creditSeg), 'H7 余额块渲染 .credit-row（删掉整块即红）')
  ok(/s\.extraCredit\.available/.test(creditSeg) && /s\.extraCredit\.balance/.test(creditSeg),
    'H7b 余额块用到 available 与 balance 两个字段')
  // 负向：`.credit-row` 只应出现在 extraCredit 分支内 —— 若有人加了无条件渲染的余额行，
  //   或把分支条件去掉（只剩 `{s.extraCredit.available &&`），这条会红。
  const allCreditRows = (dv.match(/className="credit-row"/g) ?? []).length
  ok(allCreditRows === 1, `H7c .credit-row 恰好出现一次且条件为 extraCredit 非空（实际 ${allCreditRows} 处）`)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
