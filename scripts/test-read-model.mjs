// 渲染层读模型测试（纯函数，node 直接跑）
// 用法：node scripts/test-read-model.mjs
//
// 覆盖：主窗口选择、最接近限额的窗口、最大百分比、快照等级、窗口等级、排序严重度、
//       收起态球的等级、金额格式化的紧凑档。
//
// 为什么值得单独测：这些规则此前在主页卡片 / 详情页 / 收起态球里各写一份
// （CardLevel / snapLevel / severity / ballLevel 外加两份主窗口选择），
// 没有一处能被测试盯住。收口成 read-model.ts 之后，这里就是它们的契约。

import { loadTs } from './lib/load-ts.mjs'

const rm = await loadTs('src/renderer/src/read-model.ts')
const { fmtAmount } = await loadTs('src/renderer/src/format.ts')
const { primaryWindow, primaryWindowIndex, worstWindow, maxPercent, snapshotLevel, windowLevel, severityRank, ballLevel } = rm

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

const win = (o = {}) => ({ name: '5 小时', used: 0, unit: 'percent', ...o })
const snap = (o = {}) => ({
  id: 'x',
  name: 'X',
  kind: 'coding',
  builtin: true,
  status: 'ok',
  windows: [],
  updatedAt: '2026-09-19T00:00:00.000Z',
  ...o
})

console.log('\nA. 主窗口：第一个带限额的，否则第一个')

eq(primaryWindowIndex(snap({ windows: [win({ name: 'a' }), win({ name: 'b', limit: 100 })] })), 1, 'A1 跳过无限额窗口')
eq(primaryWindowIndex(snap({ windows: [win({ name: 'a' }), win({ name: 'b' })] })), 0, 'A2 都没有限额 → 第一个')
eq(primaryWindowIndex(snap({ windows: [win({ name: 'a', limit: 0 })] })), 0, 'A3 limit=0 不算「带限额」')
eq(primaryWindowIndex(snap({ windows: [] })), 0, 'A4 没有窗口 → 0')
eq(primaryWindow(snap({ windows: [win({ name: 'a' }), win({ name: 'b', limit: 5 })] }))?.name, 'b', 'A5 primaryWindow 与索引一致')
eq(primaryWindow(snap({ windows: [] })), undefined, 'A6 没有窗口 → undefined')

console.log('\nB. 最接近限额的窗口（收起态球用）')

eq(worstWindow(snap({ windows: [win({ percent: 10 }), win({ percent: 70 })] }))?.percent, 70, 'B1 取最大百分比')
eq(worstWindow(snap({ windows: [win({ name: 'a' }), win({ name: 'b' })] }))?.name, 'a', 'B2 都没有百分比 → 第一个')
eq(worstWindow(snap({ status: 'error', windows: [win({ percent: 70 })] })), undefined, 'B3 非 ok → undefined')
eq(worstWindow(snap({ status: 'nodata', windows: [] })), undefined, 'B4 nodata → undefined')
eq(worstWindow(undefined), undefined, 'B5 没有快照 → undefined')

console.log('\nC. 最大百分比')

eq(maxPercent(snap({ windows: [win({ percent: 10 }), win({ percent: 70 })] })), 70, 'C1 取最大')
eq(maxPercent(snap({ windows: [win({})] })), null, 'C2 没有百分比 → null')
eq(maxPercent(snap({ windows: [] })), null, 'C3 没有窗口 → null')

console.log('\nD. 等级（阈值只在 format.levelOfPercent 一处）')

eq(snapshotLevel(snap({ status: 'error' })), 'danger', 'D1 error → danger')
eq(snapshotLevel(snap({ status: 'nodata' })), 'muted', 'D2 nodata → muted')
eq(snapshotLevel(snap({ windows: [win({ percent: 85 })] })), 'danger', 'D3 ≥85 → danger')
eq(snapshotLevel(snap({ windows: [win({ percent: 60 })] })), 'warn', 'D4 ≥60 → warn')
eq(snapshotLevel(snap({ windows: [win({ percent: 59.9 })] })), 'ok', 'D5 <60 → ok')
eq(snapshotLevel(snap({ windows: [win({})] })), 'ok', 'D6 没有百分比 → ok')
eq(windowLevel(win({ percent: 90 })), 'danger', 'D7 窗口等级')
eq(windowLevel(win({})), 'muted', 'D8 窗口没有百分比 → muted')

console.log('\nE. 排序严重度：危险 0 → 警告 1 → 正常 2 → 出错 3 → 未配置 4')

eq(severityRank(snap({ windows: [win({ percent: 90 })] })), 0, 'E1 危险最靠前')
eq(severityRank(snap({ windows: [win({ percent: 70 })] })), 1, 'E2 警告次之')
eq(severityRank(snap({ windows: [win({ percent: 10 })] })), 2, 'E3 正常')
eq(severityRank(snap({ windows: [win({})] })), 2, 'E4 无百分比也算正常')
eq(severityRank(snap({ status: 'error' })), 3, 'E5 出错')
eq(severityRank(snap({ status: 'nodata' })), 4, 'E6 未配置排在最后')
eq(
  [90, 70, 10].map((p) => severityRank(snap({ windows: [win({ percent: p })] }))).join(','),
  '0,1,2',
  'E7 阈值随百分比单调'
)

console.log('\nF. 收起态球的等级 —— 与快照等级在「没有百分比」时**故意不同**')

eq(ballLevel(snap({ windows: [win({ percent: 90 })] }), win({ percent: 90 })), 'danger', 'F1 有百分比：与窗口等级一致')
eq(
  ballLevel(snap({ windows: [win({})] }), win({})),
  'muted',
  'F2 球显示不出百分比 → 灰的（此时 snapshotLevel 是 ok）'
)
eq(snapshotLevel(snap({ windows: [win({})] })), 'ok', 'F3 对照：同一输入，快照等级是 ok（所以两者不能互替）')
eq(ballLevel(snap({ status: 'error' }), undefined), 'danger', 'F4 出错 → danger')
eq(ballLevel(snap({ status: 'nodata' }), undefined), 'muted', 'F5 未配置 → muted')
eq(ballLevel(undefined, undefined), 'muted', 'F6 没有快照 → muted')

console.log('\nG. 金额格式化：紧凑档只改写法，改口径的是调用方')

eq(fmtAmount(1234.5, 'cny'), '¥1234.50', 'G1 默认保留两位')
eq(fmtAmount(1234.5, 'cny', { compact: true }), '¥1.2k', 'G2 紧凑档 ≥1000 用 k')
eq(fmtAmount(150, 'cny', { compact: true }), '¥150', 'G3 紧凑档 ≥100 取整')
eq(fmtAmount(88.5, 'usd', { compact: true }), '$88.50', 'G4 紧凑档 <100 仍保留两位')
eq(fmtAmount(1500000, 'token'), '1.5M', 'G5 token 用 M/K')
eq(fmtAmount(1500000, 'token', { compact: true }), '1.5M', 'G6 token 两档写法相同（口径未变）')

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
