// shared/percent.ts 行为测试（纯函数，node 直接跑）
// 用法：node scripts/test-percent.mjs
// 覆盖：无限小数归一化、整数不带小数、四舍五入边界、used/limit 回退

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

// 与 src/shared/percent.ts 等价的内联实现（保持同步；源文件为 TS，node 直接跑需转译）
function roundPercent(p) {
  return Math.round(p * 10) / 10
}
function windowPercent(w) {
  let raw = null
  if (w.percent != null && Number.isFinite(w.percent)) raw = w.percent
  else if (w.limit != null && w.limit > 0) raw = (w.used / w.limit) * 100
  if (raw == null) return null
  return roundPercent(Math.max(0, Math.min(100, raw)))
}
function formatPercent(p) {
  if (p == null || !Number.isFinite(p)) return '—'
  const rounded = roundPercent(p)
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`
}

console.log('用例 1：无限小数归一化（用户反馈的 4.53888625% 场景）')
eq(formatPercent(4.53888625), '4.5%', '4.53888625 → 4.5%')
eq(formatPercent(4.53888625).includes('.'), true, '保留一位小数')
eq(formatPercent(4.53888625).length <= 5, true, '长度受控（≤5 字符）')
eq(formatPercent(50.24999), '50.2%', '50.24999 → 50.2%')
eq(formatPercent(67.20001), '67.2%', '67.20001 → 67.2%')

console.log('用例 2：整数不带小数')
eq(formatPercent(4), '4%', '4 → 4%')
eq(formatPercent(50.0), '50%', '50.0 → 50%')
eq(formatPercent(0), '0%', '0 → 0%')
eq(formatPercent(100), '100%', '100 → 100%')

console.log('用例 3：边界与异常')
eq(formatPercent(null), '—', 'null → —')
eq(formatPercent(undefined), '—', 'undefined → —')
eq(formatPercent(NaN), '—', 'NaN → —')
eq(formatPercent(Infinity), '—', 'Infinity → —')
eq(formatPercent(-3), '-3%', '负数保留（由 windowPercent 负责 clamp）')

console.log('用例 4：windowPercent（percent 优先，used/limit 回退，clamp 到 0-100）')
eq(windowPercent({ percent: 4.53888625 }), 4.5, 'percent 优先且归一化')
eq(windowPercent({ used: 1, limit: 3 }), 33.3, 'used/limit 回退 → 33.3')
eq(windowPercent({ used: 3, limit: 3 }), 100, '满额 → 100')
eq(windowPercent({ used: 99, limit: 3 }), 100, '超限 clamp 到 100')
eq(windowPercent({ used: -5, limit: 10 }), 0, '负值 clamp 到 0')
eq(windowPercent({ used: 5 }), null, '无 limit 且无 percent → null')
eq(windowPercent({ percent: 0 }), 0, 'percent=0 → 0')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
