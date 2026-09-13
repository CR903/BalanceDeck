// shared/quality.ts 行为测试（纯函数，node 直接跑）
// 用法：node scripts/test-quality.mjs
//
// 覆盖：断网/降级时的「最后有效值」策略、数据时间、可信度徽章、网络错误分类。
// 直接 import 源文件（Node 22.18+ 默认开启类型剥离），避免内联副本与实现漂移。

import {
  applyCachePolicy,
  dataTime,
  isStale,
  staleLabel,
  isNetworkError,
  MAX_CACHE_AGE
} from '../src/shared/quality.ts'

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

const NOW = Date.parse('2026-09-13T12:00:00.000Z')
const iso = (msAgo) => new Date(NOW - msAgo).toISOString()

/** 造一个快照 */
function snap(over = {}) {
  return {
    id: 'opencode',
    name: 'OpenCode Go',
    kind: 'coding',
    builtin: true,
    status: 'ok',
    windows: [{ name: '5 小时', used: 5, limit: 12, unit: 'usd', percent: 41.7 }],
    updatedAt: iso(0),
    dataAt: iso(0),
    dataQuality: 'official',
    ...over
  }
}

console.log('数据可信度 · 「最后有效值」策略')
eq(applyCachePolicy(undefined, snap({ status: 'error' }), NOW).status, 'error', '无历史数据时如实展示错误')
{
  const prev = snap({ dataAt: iso(60_000) })
  const next = snap({ status: 'error', detail: 'fetch failed', windows: [] })
  const got = applyCachePolicy(prev, next, NOW)
  eq(got.status, 'ok', '本轮失败 → 沿用上次成功数据')
  eq(got.dataQuality, 'cached', '  且标记为 cached')
  eq(got.dataAt, prev.dataAt, '  数据时间保持为上次成功时间')
  eq(got.degradedReason, 'fetch failed', '  降级原因透传（用于 UI 提示）')
  eq(got.windows.length, 1, '  窗口数据保留')
}
{
  const prev = snap()
  const next = snap({ dataQuality: 'local', source: '本机统计', degradedReason: '官方不可达' })
  const got = applyCachePolicy(prev, next, NOW)
  eq(got.dataQuality, 'cached', '官方 → 本机估算：优先展示官方缓存（口径一致）')
  eq(got.degradedReason, '官方不可达', '  原因来自适配器')
}
eq(
  applyCachePolicy(snap({ dataQuality: 'local' }), snap({ status: 'error', windows: [] }), NOW).status,
  'error',
  '上次本身就是本机估算 → 不缓存（无权威数据可留）'
)
eq(
  applyCachePolicy(snap(), snap({ status: 'nodata', windows: [] }), NOW).status,
  'nodata',
  '本轮未配置 → 如实展示（可能刚清空凭据）'
)
eq(
  applyCachePolicy(snap({ dataAt: iso(MAX_CACHE_AGE + 60_000) }), snap({ status: 'error', windows: [] }), NOW).status,
  'error',
  '超过 24 小时 → 不再展示过期数据'
)
{
  const prev = snap({ windows: [] })
  eq(applyCachePolicy(prev, snap({ status: 'error', windows: [] }), NOW).status, 'error', '上次无窗口数据 → 不缓存')
}
{
  const fresh = snap({ windows: [{ name: '5 小时', used: 6, limit: 12, unit: 'usd', percent: 50 }] })
  const got = applyCachePolicy(snap(), fresh, NOW)
  eq(got.windows[0].used, 6, '本轮成功 → 直接使用新数据')
  eq(got.dataQuality, 'official', '  且保持 official')
}
{
  // 缓存提示要说"为什么没更新"，而不是"本机估算"（否则与展示的数据不符）
  const prev = snap()
  const next = snap({
    status: 'error',
    windows: [],
    detail: '很长的失败细节…',
    degradedReason: '本机估算说明',
    failureReason: '官方接口不可达（fetch failed）'
  })
  eq(applyCachePolicy(prev, next, NOW).degradedReason, '官方接口不可达（fetch failed）', '缓存原因优先用 failureReason')
}

console.log('数据可信度 · 展示语义')
eq(dataTime({ dataAt: 'A', updatedAt: 'B' }), 'A', 'dataTime 优先 dataAt')
eq(dataTime({ updatedAt: 'B' }), 'B', 'dataTime 回退 updatedAt')
eq(isStale({ dataQuality: 'cached' }), true, 'cached 视为过期')
eq(isStale({ dataQuality: 'local' }), true, 'local 视为非官方')
eq(isStale({ dataQuality: 'official' }), false, 'official 不算过期')
eq(isStale({}), false, '缺省不标记（兼容旧数据）')
eq(staleLabel({ dataQuality: 'cached' }), '缓存', '徽章文案 · 缓存')
eq(staleLabel({ dataQuality: 'local' }), '本机', '徽章文案 · 本机')
eq(staleLabel({ dataQuality: 'official' }), '', '徽章文案 · 官方为空')

console.log('网络错误分类（决定是否判定离线）')
eq(isNetworkError(new TypeError('fetch failed')), true, 'fetch failed → 离线类')
eq(isNetworkError(Object.assign(new Error('x'), { name: 'AbortError' })), true, '请求超时 → 离线类')
eq(isNetworkError(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), true, 'DNS 失败 → 离线类')
eq(isNetworkError(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } })), true, '连接被拒 → 离线类')
eq(isNetworkError(new Error('HTTP 401')), false, 'HTTP 401 不算离线（凭据问题）')
eq(isNetworkError(new Error('端点不存在（HTTP 404）')), false, 'HTTP 404 不算离线')
eq(isNetworkError(new Error('Cookie 格式无效')), false, '解析错误不算离线')
eq(isNetworkError(undefined), false, '空值安全')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
