// shared/tray-text.ts 行为测试（纯函数，node 直接跑）
// 用法：node scripts/test-tray.mjs
//
// 用户明确要求的状态栏形态：
//   多时限窗口的供应商（如 OpenCode Go）→ logo + `5H 2.7% W 51.9% M 67.9%`
//   其他（余额类）→ 余额或使用比例
// 顺带锁定：离线/缓存前缀、主供应商选取（= 卡片顺序第一位）

import { loadTs } from './lib/load-ts.mjs'

const {
  compactAmount,
  primarySnapshot,
  providerSummary,
  qualitySuffix,
  shortWindowLabel,
  trayTitle
} = await loadTs('src/shared/tray-text.ts')

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

function snap(over = {}) {
  return {
    id: 'x',
    name: 'X',
    kind: 'coding',
    builtin: true,
    status: 'ok',
    windows: [],
    updatedAt: new Date().toISOString(),
    ...over
  }
}

const go = snap({
  id: 'opencode',
  name: 'OpenCode Go',
  windows: [
    { name: '5 小时', used: 0.32, limit: 12, unit: 'usd', percent: 2.7 },
    { name: '本周', used: 15.58, limit: 30, unit: 'usd', percent: 51.9 },
    { name: '本月', used: 40.82, limit: 60, unit: 'usd', percent: 67.9 }
  ]
})
const balance = snap({
  id: 'deepseek',
  name: 'DeepSeek',
  kind: 'balance',
  windows: [{ name: '账户余额', used: 500.67, unit: 'cny' }]
})

console.log('窗口短标签')
eq(shortWindowLabel('5 小时'), '5H', '5 小时 → 5H')
eq(shortWindowLabel('本周'), 'W', '本周 → W')
eq(shortWindowLabel('本月'), 'M', '本月 → M')
eq(shortWindowLabel('本月（30 天）'), 'M', '带后缀仍识别')
eq(shortWindowLabel('账户余额'), '$', '余额 → $')
eq(shortWindowLabel('Token Plan'), 'To', '未知窗口取前两字')

console.log('状态栏标题（用户要求的形态）')
eq(providerSummary(go), '5H 2.7% W 51.9% M 67.9%', 'Go：全部窗口平铺')
eq(trayTitle([go], false), '5H 2.7% W 51.9% M 67.9%', '在线且官方数据不加前缀')
eq(providerSummary(balance), '¥500.67', '余额类：显示金额')
eq(trayTitle([balance], false), '¥500.67', '余额类标题')
eq(
  trayTitle([snap({ windows: [{ name: '本周', used: 15, limit: 30, unit: 'usd', percent: 50 }] })], false),
  'W 50%',
  '单窗口百分比带标签'
)
eq(trayTitle([snap({ windows: [{ name: '账户余额', used: 12.34, unit: 'usd' }] })], false), '$12.34', '单窗口美元金额')
eq(
  trayTitle([snap({ windows: [{ name: '账户余额', used: 12345.67, unit: 'usd' }] })], false),
  '$12.3k',
  '万元级金额缩写'
)
eq(
  trayTitle([snap({ windows: [{ name: '账户余额', used: 1234567, unit: 'usd' }] })], false),
  '$1.2M',
  '百万元级金额缩写'
)

console.log('离线 / 缓存前缀')
eq(trayTitle([go], true), '⚠ 5H 2.7% W 51.9% M 67.9%', '离线加 ⚠')
eq(trayTitle([snap({ ...go, dataQuality: 'cached' })], false), '⚠ 5H 2.7% W 51.9% M 67.9%', '缓存数据加 ⚠')
eq(trayTitle([snap({ ...go, dataQuality: 'local' })], false), '⚠ 5H 2.7% W 51.9% M 67.9%', '本机估算加 ⚠')
eq(trayTitle([], false), '', '无供应商时标题为空')
eq(trayTitle([snap({ status: 'error', windows: [] })], false), '', '全部出错时不显示假数据')
eq(trayTitle([snap({ status: 'error', windows: [] }), go], false), '5H 2.7% W 51.9% M 67.9%', '跳过出错项取下一个')

console.log('主供应商 = 卡片顺序第一位')
eq(primarySnapshot([balance, go])?.id, 'deepseek', '顺序第一位优先（用户拖拽排序即优先级）')
eq(primarySnapshot([go, balance])?.id, 'opencode', '顺序变化即切换主供应商')
eq(
  primarySnapshot([snap({ id: 'a', status: 'error', windows: [] }), go])?.id,
  'opencode',
  '第一位无数据则顺延'
)
eq(primarySnapshot([])?.id, undefined, '空列表安全')

console.log('其他')
eq(qualitySuffix(snap({ dataQuality: 'cached' })), '（缓存）', 'tooltip 缓存后缀')
eq(qualitySuffix(snap({ dataQuality: 'local' })), '（本机估算）', 'tooltip 估算后缀')
eq(qualitySuffix(snap({})), '', '官方无后缀')
eq(compactAmount({ name: 'x', used: 0.1974, unit: 'usd' }), '$0.20', '小额保留两位')
eq(compactAmount({ name: 'x', used: 2_300_000, unit: 'token' }), '2.3M', 'token 紧凑写法')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
