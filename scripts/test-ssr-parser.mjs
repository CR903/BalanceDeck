// 新版控制台配额窗口 / 每模型明细的解析测试
// 用法：node scripts/test-ssr-parser.mjs
//
// ⚠️ 文件名保留 `test-ssr-parser` 是因为 `package.json` 与 TASKS.md 都在引用它，
//    但内容已**整体重写**：原来测的是 SSR HTML 正则解析（2026-09-26 起控制台重写成
//    纯客户端 SPA，SSR 已不存在，那套解析器连同被测实现一起删了）。
//
// 两个刻意的做法：
//
// 1) **测真源码，不测副本。** 原版在这个文件里内联复制了一份实现来测，注释自己承认
//    「若源文件逻辑变更，请同步更新此测试」—— 那样的测试在源改错时照样绿，是假护栏。
//    现在用 `loadTs` 直接加载 src 下的真模块（与 test-pet.mjs 同一手法）。
//
// 2) **fixture 是真实响应**，2026-09-26 带有效会话实测抓取，敏感字段已脱敏
//    （user/email/paymentMethod 删掉，金额按量级保留因为断言要用）。
//    每条断言都能指出对应响应的哪一行，不是凭空造的数。

import { loadTs } from './lib/load-ts.mjs'

const { parseGoStatus, WINDOW_NAMES, windowStartIso } = await loadTs('src/main/adapters/opencode-cookie.ts')
const { parseModelsResponse, parseCostByDay, modelsByWindowOf, seriesByWindowOf } =
  await loadTs('src/main/opencode-details.ts')
const api = await loadTs('src/main/adapters/opencode-console-api.ts')

let pass = 0
let fail = 0
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}\n      实际 ${a}\n      期望 ${b}`)
  }
}
function ok(cond, label) {
  eq(!!cond, true, label)
}

// ═══════════════════════════════════════════════════════════════════════════════
// fixture：GET /console/api/go/status 的真实响应（脱敏）
// ═══════════════════════════════════════════════════════════════════════════════
const NOW = Date.parse('2026-09-26T14:44:44.000Z')
const GO_STATUS = {
  subscriberUserId: 'user_REDACTED',
  product: 'go',
  renewalProduct: 'go',
  paymentMethodId: 'payment_method_REDACTED',
  renewalCurrency: 'usd',
  useBalance: false,
  cancelAtPeriodEnd: false,
  renewalPending: false,
  renewalAuthorizationRequired: true,
  access: {
    startsAt: '2026-09-21T01:25:47.000Z',
    endsAt: '2026-10-21T01:25:47.000Z',
    cancelAtPeriodEnd: false,
    meters: {
      fiveHour: {
        startsAt: '2026-09-26T10:22:41.617Z',
        resetsAt: '2026-09-26T15:22:41.617Z',
        limitMicroCents: '1200000000',
        usedMicroCents: '52000'
      },
      week: {
        startsAt: '2026-09-21T00:00:00.000Z',
        resetsAt: '2026-09-28T00:00:00.000Z',
        limitMicroCents: '3000000000',
        usedMicroCents: '505884411'
      },
      month: { limitMicroCents: '6000000000', usedMicroCents: '505884411' }
    }
  },
  upgradePrice: { amountMicroCents: '3084000000', currency: 'usd' }
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('A. parseGoStatus —— 三个窗口的基本映射')
{
  const r = parseGoStatus(GO_STATUS, NOW)

  eq(r.unknownMeters, [], 'A1 认识的 meter 字段不该报未知（回归：曾用 Object.values 取到窗口名，把 fiveHour/week/month 全判成未知）')
  ok(r.windows.rolling && r.windows.weekly && r.windows.monthly, 'A2 三个窗口都产出')

  // limitMicroCents / 1e8 = USD
  eq(r.raw.rolling?.limit, 1200000000, 'A3 rolling 配额 = $12（端点下发，不是代码硬编码）')
  eq(r.raw.weekly?.limit, 3000000000, 'A4 weekly 配额 = $30')
  eq(r.raw.monthly?.limit, 6000000000, 'A5 monthly 配额 = $60')

  eq(r.raw.weekly?.usage, 505884411, 'A6 weekly 已用量取服务端原值（不做 percent×limit 反算）')
  eq(r.raw.rolling?.usage, 52000, 'A7 rolling 已用量 52000 microcents = $0.00052')
}

console.log('\nB. 百分比：精确值与整数显示')
{
  const r = parseGoStatus(GO_STATUS, NOW)
  // 505884411 / 3000000000 = 16.8628...%
  eq(Number(r.raw.weekly?.usagePercent?.toFixed(4)), 16.8628, 'B1 weekly 精确百分比 = 16.8628%')
  eq(r.windows.weekly?.percent, 16, 'B2 整数百分比向下取整 = 16（控制台页面显示 17，它四舍五入）')
  eq(Number(r.raw.monthly?.usagePercent?.toFixed(4)), 8.4314, 'B3 monthly 精确百分比 = 8.4314%')
  eq(r.windows.monthly?.percent, 8, 'B4 monthly 整数百分比 = 8（与控制台页面一致）')
  eq(r.windows.rolling?.percent, 0, 'B5 rolling = 0%')
}

console.log('\nC. 重置时间 —— month 没有 resetsAt，要回落到订阅周期末')
{
  const r = parseGoStatus(GO_STATUS, NOW)
  eq(r.raw.rolling?.resetInSec, Math.round((Date.parse('2026-09-26T15:22:41.617Z') - NOW) / 1000), 'C1 rolling 倒计时来自 resetsAt')
  eq(r.raw.weekly?.resetInSec, Math.round((Date.parse('2026-09-28T00:00:00.000Z') - NOW) / 1000), 'C2 weekly 倒计时来自 resetsAt')
  // month 的 meter 没有 resetsAt；access.endsAt 减当时 = 24 天 10 小时 41 分
  eq(r.raw.monthly?.resetInSec, Math.round((Date.parse('2026-10-21T01:25:47.000Z') - NOW) / 1000), 'C3 monthly 回落到 access.endsAt（实测与页面 "Resets in 24d 10h" 吻合）')
  eq(r.windows.monthly?.resetInSec, r.raw.monthly?.resetInSec, 'C4 monthly 的 windows 与 raw 倒计时一致')
}

console.log('\nC5. 窗口起点（2026-10-11 新增：meter.startsAt；month 用 access.startsAt）')
{
  const r = parseGoStatus(GO_STATUS, NOW)
  eq(r.raw.rolling?.startAt, '2026-09-26T10:22:41.617Z', 'C5a rolling 起点取 meter.startsAt（官方权威）')
  eq(r.raw.weekly?.startAt, '2026-09-21T00:00:00.000Z', 'C5b weekly 起点取 meter.startsAt —— 自然周对齐周一 0 点，不是「重置前 7 天」')
  eq(r.raw.monthly?.startAt, '2026-09-21T01:25:47.000Z', 'C5c month 没有 startsAt → 回落 access.startsAt（订阅周期起点）')
  // weekly: startAt 到 resetAt（= now + resetInSec）恰好 7 天，证明确实是自然周而不是滚动
  eq(
    (NOW + r.raw.weekly.resetInSec * 1000 - Date.parse(r.raw.weekly.startAt)) / 86400000,
    7,
    'C5d weekly 起止恰好 7 天（自然周）'
  )
  // 垃圾 startsAt 视同缺失（与 resetsAt 同一条纪律）
  eq(
    parseGoStatus({ access: { meters: { week: { limitMicroCents: '1', usedMicroCents: '0', startsAt: 'nope' } } } }, NOW)
      .raw.weekly?.startAt,
    undefined,
    'C5e 非法 startsAt 视同缺失（不算出乱七八糟的起点）'
  )
}

console.log('\nC6. windowStartIso —— 官方优先、反推兜底')
{
  const raw = { startAt: '2026-09-26T10:22:41.617Z', resetInSec: 18000 }
  eq(windowStartIso(raw, 'rolling', NOW), '2026-09-26T10:22:41.617Z', 'C6a 有官方起点时原样用（不反推）')
  // 无 startAt → resetAt(=now+resetInSec) - span
  const noStart = { resetInSec: 7 * 86400 }
  eq(
    windowStartIso(noStart, 'weekly', NOW),
    new Date(NOW + 7 * 86400_000 - 7 * 86400_000).toISOString(),
    'C6b 缺官方起点 → resetAt - 窗口跨度反推兜底'
  )
  eq(windowStartIso({}, 'weekly', NOW), undefined, 'C6c 既无起点也无重置时间 → undefined（不编）')
  eq(windowStartIso({ resetInSec: 0 }, 'weekly', NOW), undefined, 'C6d resetInSec=0 含义是「未知」，不反推')
}

console.log('\nD. 站点改版的早期信号：未知计费项不能被静默吞掉')
{
  const mutated = structuredClone(GO_STATUS)
  mutated.access.meters.week2 = { limitMicroCents: '100', usedMicroCents: '1' }
  const r = parseGoStatus(mutated, NOW)
  eq(r.unknownMeters, ['week2'], 'D1 新增的未知计费项被报出来（不是悄悄少一个窗口）')
  ok(r.windows.weekly, 'D2 已知的三个窗口不受影响')
}
{
  // 整个 meters 结构变了（改版最坏情况）
  const r = parseGoStatus({ access: { meters: { foo: {}, bar: {} } } }, NOW)
  eq(r.unknownMeters, ['foo', 'bar'], 'D3 全部改名 → 全部报未知，且不产出任何窗口（上层会据此提示"结构已变"）')
  eq(r.windows, {}, 'D4 没有窗口时返回空而不是编造 0%')
}

console.log('\nE. 异常输入 —— 不能抛，返回空')
{
  eq(parseGoStatus(null, NOW).windows, {}, 'E1 null')
  eq(parseGoStatus({}, NOW).windows, {}, 'E2 空对象')
  eq(parseGoStatus({ access: {} }, NOW).windows, {}, 'E3 access 缺 meters')
  eq(parseGoStatus({ access: { meters: null } }, NOW).windows, {}, 'E4 meters 为 null')
  const partial = parseGoStatus({ access: { meters: { week: { limitMicroCents: '3000000000' } } } }, NOW)
  eq(partial.raw.weekly?.usage, undefined, 'E5 只有 limit 没有 used → usage 留空，不编 0')
  eq(partial.windows.weekly?.percent, 0, 'E6 只有 limit 没有 used → 百分比 0（真的是 0）')
  eq(parseGoStatus({ access: { meters: { week: { limitMicroCents: 'abc' } } } }, NOW).windows, {}, 'E7 金额不是数字 → 跳过该窗口')
}

console.log('\nE2. 「花了钱但算不出百分比」绝不能报 0%（2026-09-26 评审发现的诚实性漏洞）')
{
  // 复现：limit 为 0 或缺失，但 used 有值。
  // 旧行为 → windows.weekly.percent = 0 → 界面渲染「已用 $5.06 / 配额 $30 · 0%」。
  const zeroLimit = parseGoStatus(
    { access: { meters: { week: { limitMicroCents: '0', usedMicroCents: '505884411' } } } },
    NOW
  )
  ok(zeroLimit.raw.weekly?.usage === 505884411, 'E2a 金额仍然保留（那是真数据）')
  eq(zeroLimit.raw.weekly?.usagePercent, undefined, 'E2b 百分比算不出就不给')
  ok(!('rolling' in zeroLimit.windows) && !('weekly' in zeroLimit.windows), 'E2c **不产出** windows 条目 —— 否则下游会拿 0% 当权威值')
  eq(zeroLimit.raw.weekly?.status, 'percent-unavailable', 'E2d 状态标记为百分比不可用')

  // 真的 0 花费 → 0% 是真的，该给
  const zeroUsage = parseGoStatus(
    { access: { meters: { week: { limitMicroCents: '3000000000', usedMicroCents: '0' } } } },
    NOW
  )
  eq(zeroUsage.windows.weekly?.percent, 0, 'E2e 真的没花钱 → 0% 如实给出')
  ok('weekly' in zeroUsage.windows, 'E2f 该窗口正常产出')

  // 没有 limit 也没有 used → 什么都没有，不产出窗口
  const nothing = parseGoStatus({ access: { meters: { week: {} } } }, NOW)
  ok(!('weekly' in nothing.windows) && !('weekly' in nothing.raw), 'E2g 空 meter 被跳过')
}

console.log('\nE3. resetInSec = 0 的含义是"未知"，不是"还有 0 秒"')
{
  // month 无 resetsAt 且 access 无 endsAt → 倒计时未知
  const r = parseGoStatus({ access: { meters: { month: { limitMicroCents: '1', usedMicroCents: '0' } } } }, NOW)
  eq(r.windows.monthly?.resetInSec, 0, 'E3a 未知时用 0 表示（下游都判 > 0 才用，等于不显示倒计时）')
  eq(r.raw.monthly?.resetInSec, undefined, 'E3b raw 里保持 undefined —— 两种表示"未知"的方式不同，刻意如此')
  // 垃圾时间戳与缺失同样处理
  const junk = parseGoStatus(
    { access: { meters: { week: { limitMicroCents: '3000000000', usedMicroCents: '0', resetsAt: 'not-a-date' } } } },
    NOW
  )
  eq(junk.raw.weekly?.resetInSec, undefined, 'E3c 非法 resetsAt 视同缺失，不算出乱七八糟的秒数')
  eq(junk.windows.weekly?.resetInSec, 0, 'E3d 同样落回 0')
}

console.log('\nF. 满额时状态应为限流')
{
  const full = structuredClone(GO_STATUS)
  full.access.meters.week.usedMicroCents = '3000000000'
  const r = parseGoStatus(full, NOW)
  eq(r.windows.weekly?.percent, 100, 'F1 满额 = 100%')
  eq(r.windows.weekly?.status, 'rate-limited', 'F2 状态标记为已触发限流')
  const over = structuredClone(GO_STATUS)
  over.access.meters.week.usedMicroCents = '4000000000'
  eq(parseGoStatus(over, NOW).windows.weekly?.percent, 100, 'F3 超额后钳在 100%（不出现 133%）')
}

console.log('\nG. 窗口名映射（下游按这个名字分组，错了会串窗）')
{
  eq(WINDOW_NAMES.rolling, '5 小时', 'G1 rolling → 5 小时')
  eq(WINDOW_NAMES.weekly, '本周', 'G2 weekly → 本周')
  eq(WINDOW_NAMES.monthly, '本月', 'G3 monthly → 本月')
}

console.log('\nG2. 窗口对齐表 —— 口径撒谎的最后一道闸')
{
  // 2026-09-26 评审实测：把这张表改成 { weekly: '30d' }（把 30 天数据标成「本周」），
  // 当时 49 项与 146 项测试**全绿**。这张表是本文件里最强的诚实性声明，必须有护栏。
  eq(api.MODELS_RANGES, { weekly: '7d', monthly: '30d' }, 'G2a weekly 必须用 7d（自然周口径）')
  eq(api.MODELS_RANGES.monthly, '30d', 'G2b monthly 必须用 30d')
  ok(!('rolling' in api.MODELS_RANGES), 'G2c rolling 不在 range 表里 —— 它靠 since 对齐，不用自然 range')
  eq(Object.keys(api.MODELS_RANGES).sort(), ['monthly', 'weekly'], 'G2d 只有这两个自然对齐档')
  // 2026-10-11：`since` 实测覆盖 range 起点，5 小时窗口的明细/时序因此可得。
  // range 仍取端点允许的最小值 24h（真正的裁剪交给 since）。
  eq(api.MODELS_RANGE_ROLLING, '24h', 'G2e rolling 用端点最小 range 24h + since=<5h 起点>（推翻旧「故意不映射」）')
}

console.log('\nG2b. 时序端点与桶粒度')
{
  eq(api.USAGE_COST_BY_DAY_PATH, '/api/usage/cost-by-day', 'G2f 趋势数据源是 cost-by-day（不是本机历史）')
  eq(api.COST_BUCKETS.hour, 'hour', 'G2g 小时桶')
  eq(api.COST_BUCKETS.day, 'day', 'G2h 日桶')
}

console.log('\nG3. 端点常量与请求头')
{
  eq(api.GO_STATUS_PATH, '/api/go/status', 'G3a 窗口端点是 go/status（不是 usage/summary —— 后者只有用量聚合）')
  eq(api.ORG_ID_HEADER, 'x-org-id', 'G3b org 走请求头，不是路径段')
  eq(api.USAGE_UNIT_SCALE, 1e8, 'G3c 金额尺度 1 USD = 1e8 microcents')
  eq(Object.keys(api.METER_FIELDS), ['fiveHour', 'week', 'month'], 'G3d meter 字段名')
  eq([...api.PERIOD_END_RESET_FIELDS], ['month'], 'G3e 只有 month 回落 access.endsAt（week 是自然周对齐，不能推广）')
  const h = api.buildConsoleHeaders('auth=x; __Host-console_session=y', 'wrk_1')
  eq(h['x-org-id'], 'wrk_1', 'G3f 有 id 时带 x-org-id（缺它实测 400 org_required）')
  eq(h.Cookie, 'auth=x; __Host-console_session=y', 'G3g cookie 原样带上，不做筛选')
  ok(!('x-org-id' in api.buildConsoleHeaders('auth=x', null)), 'G3h 没 id 时**不**带 x-org-id（列 orgs 的接口带了会被拒）')
}

// ═══════════════════════════════════════════════════════════════════════════════
// fixture：GET /console/api/usage/models?range=30d 的真实响应（截取前 3 条，脱敏）
// ═══════════════════════════════════════════════════════════════════════════════
const MODELS = {
  items: [
    {
      model: 'deepseek-flash',
      provider: 'opencode-go',
      totalRequests: '4357',
      totalInputTokens: '18089708',
      totalOutputTokens: '3193794',
      totalCacheReadTokens: '858154621',
      totalCacheWrite5mTokens: '0',
      totalCacheWrite1hTokens: '0',
      totalCostMicroCents: '1180850167'
    },
    {
      model: 'deepseek-v4.1-flash',
      provider: 'opencode-go',
      totalRequests: '2558',
      totalInputTokens: '6246874',
      totalOutputTokens: '2261870',
      totalCacheReadTokens: '846124032',
      totalCacheWrite5mTokens: '0',
      totalCacheWrite1hTokens: '0',
      totalCostMicroCents: '499182428'
    },
    {
      model: 'deepseek-v4-flash',
      provider: 'opencode-go',
      totalRequests: '1488',
      totalInputTokens: '6296601',
      totalOutputTokens: '1021473',
      totalCacheReadTokens: '230644096',
      totalCacheWrite5mTokens: '0',
      totalCacheWrite1hTokens: '0',
      totalCostMicroCents: '286700992'
    }
  ],
  pageInfo: { page: 1, pageSize: 10 }
}

console.log('\nH. parseModelsResponse —— 每模型明细')
{
  const rows = parseModelsResponse(MODELS)
  eq(rows.length, 3, 'H1 三条全收')
  eq(rows[0].model, 'deepseek-flash', 'H2 模型名')
  eq(rows[0].provider, 'opencode-go', 'H3 provider')
  // 1180850167 / 1e8 = 11.80850167
  eq(rows[0].usageUsd, 11.80850167, 'H4 金额 microcents → USD')
  eq(rows[0].requests, 4357, 'H5 请求数')
  // tokens = input + output + cacheRead + cacheWrite5m + cacheWrite1h
  eq(rows[0].tokens, 18089708 + 3193794 + 858154621, 'H6 tokens 五个来源求和（含 cache read）')
  eq(rows[1].tokens, 6246874 + 2261870 + 846124032, 'H7 第二条同样口径')
}

console.log('\nI. 明细的诚实性：没有的字段就不给')
{
  const rows = parseModelsResponse(MODELS)
  // 旧 DOM 版能从表头读到「每月配额」与百分比，新接口没有。
  // 填 0 会让界面显示「$0 / 0%」= 撒谎，所以这两个键必须不存在。
  ok(!('quotaUsd' in rows[0]), 'I1 不产出 quotaUsd（接口没有该数据）')
  ok(!('percent' in rows[0]), 'I2 不产出 percent（接口没有该数据）')
  ok(rows[0].usageUsd > 0, 'I3 有的是真的已用量')
}

console.log('\nJ. 异常输入')
{
  eq(parseModelsResponse(null), [], 'J1 null')
  eq(parseModelsResponse({}), [], 'J2 没有 items')
  eq(parseModelsResponse({ items: 'not-an-array' }), [], 'J3 items 不是数组')
  eq(parseModelsResponse({ items: [null, {}, { model: '  ' }] }), [], 'J4 空 model 被丢弃')
  const partial = parseModelsResponse({ items: [{ model: 'x' }] })
  eq(partial, [{ model: 'x', provider: '', usageUsd: 0, tokens: 0, requests: 0 }], 'J5 缺字段补 0 而不是 undefined（数字字段）')
  const numeric = parseModelsResponse({ items: [{ model: 'y', totalCostMicroCents: 25000000, totalRequests: 3 }] })
  eq(numeric[0].usageUsd, 0.25, 'J6 数字形态（非字符串）也认 —— 测试里可能用数字')
}

console.log('\nK. parseCostByDay —— 官方用量时序（趋势数据源）')
{
  // 真实响应形状（2026-10-11 实测，脱敏）：date 为 UTC 整点/整日
  const HOURLY = [
    { date: '2026-10-11T04:00:00Z', totalCostMicroCents: '25000000', totalTokens: '1500', totalRequests: '3' },
    { date: '2026-10-11T07:00:00Z', totalCostMicroCents: '100000000', totalTokens: '9000', totalRequests: '12' }
  ]
  const rows = parseCostByDay(HOURLY, 'hour')
  eq(rows.length, 2, 'K1 两个桶全收')
  eq(rows[0].bucket, 'hour', 'K2 bucket 由调用方给定（响应里没有这个字段）')
  eq(rows[0].t, '2026-10-11T04:00:00Z', 'K3 桶起点取官方 date 原值')
  eq(rows[0].cost, 0.25, 'K4 金额 microcents → USD')
  eq(rows[0].tokens, 1500, 'K5 tokens 原值')
  eq(rows[0].requests, 3, 'K6 请求数原值')

  // 倒序输入 → 升序返回（图表从左到右按时间画）
  const reversed = parseCostByDay([...HOURLY].reverse(), 'day')
  eq(reversed.map((r) => r.t), ['2026-10-11T04:00:00Z', '2026-10-11T07:00:00Z'], 'K7 升序返回')
  eq(reversed[0].bucket, 'day', 'K8 日桶同样由调用方给定')

  // 容忍未知键（站点改版加字段不该丢行）
  eq(parseCostByDay([{ ...HOURLY[0], extraField: 'x' }], 'hour').length, 1, 'K9 未知键不影响解析')

  // 坏 date 行跳过，好行保留（不因一行坏数据丢整张表）
  eq(
    parseCostByDay([HOURLY[0], { date: 'not-a-date', totalCostMicroCents: '1' }, HOURLY[1]], 'hour').length,
    2,
    'K10 坏 date 行被跳过，好行保留'
  )

  eq(parseCostByDay(null, 'hour'), [], 'K11 null → []')
  eq(parseCostByDay({ items: [] }, 'hour'), [], 'K12 非数组 → []（宽容，不是崩溃）')
  eq(parseCostByDay([], 'hour'), [], 'K13 空数组是合法结果（官方确认该窗口无用量）')

  // 缺金额 = 结构变化信号 → 跳过该桶，**不补 0**（0 是「$0.00」，是断言）
  eq(parseCostByDay([{ date: '2026-10-11T04:00:00Z' }], 'hour'), [], 'K14a 缺 totalCostMicroCents → 跳过该桶（不补 0）')
  eq(
    parseCostByDay([HOURLY[0], { date: '2026-10-11T07:00:00Z', totalCostMicroCents: 'abc' }, HOURLY[1]], 'hour').length,
    2,
    'K14b 金额不可解析 → 只跳过那一桶，好桶保留'
  )
  // 「真的是 0」仍要保留（0 桶是官方真实数据）
  const zero = parseCostByDay([{ date: '2026-10-11T04:00:00Z', totalCostMicroCents: '0' }], 'hour')
  eq([zero.length, zero[0].cost], [1, 0], 'K14c totalCostMicroCents="0" → 保留（真的 0，与缺失区分）')
}

console.log('\nL. modelsByWindowOf / seriesByWindowOf —— 明细/时序 → 快照的窗口映射')
{
  const NAMES = { rolling: '5 小时', weekly: '本周', monthly: '本月' }
  const modelRow = (model) => ({ model, provider: 'opencode-go', usageUsd: 1, tokens: 10, requests: 2 })
  const bucket = (t, cost) => ({ t, bucket: 'hour', cost, tokens: 1, requests: 1 })

  // ① 三窗口 key 都产出（含 5 小时 —— 旧的「rolling 无明细」限制已推翻）
  const models = modelsByWindowOf(
    { models: { rolling: [modelRow('a')], weekly: [modelRow('b')], monthly: [modelRow('c')] } },
    NAMES
  )
  eq(Object.keys(models).sort(), ['5 小时', '本月', '本周'].sort(), 'L1 models 三窗口 key 都产出（含 5 小时）')
  const series = seriesByWindowOf(
    { series: { rolling: [bucket('t1', 1)], weekly: [bucket('t2', 2)], monthly: [bucket('t3', 3)] } },
    NAMES
  )
  eq(Object.keys(series).sort(), ['5 小时', '本月', '本周'].sort(), 'L2 series 三窗口 key 都产出')

  // ② 空数组必须**保留 key**（官方确认该窗口无用量 ≠ 抓取失败）
  const empty = modelsByWindowOf({ models: { rolling: [], weekly: [modelRow('b')] } }, NAMES)
  ok('5 小时' in empty, 'L3a models 空数组保留 key（不是压成缺失）')
  eq(empty['5 小时'], [], 'L3b models 空数组照原样带出')
  ok(!('本月' in empty), 'L3c 未抓到的窗口不产出 key（缺失 = 失败）')
  const emptySeries = seriesByWindowOf({ series: { monthly: [] } }, NAMES)
  ok('本月' in emptySeries && emptySeries['本月'].length === 0, 'L3d series 空数组保留 key')

  // ③ 缺失（失败）时该窗口 key **不存在** —— 渲染层据此退回本机并标注「本机估算」
  const partial = seriesByWindowOf({ series: { weekly: [bucket('t2', 2)] } }, NAMES)
  eq(Object.keys(partial), ['本周'], 'L4a 只有抓到的窗口产出 key')
  ok(!('5 小时' in partial) && !('本月' in partial), 'L4b 抓取失败的窗口 key 不存在')

  // ④ 鲁棒：details 为 null / 缺字段
  eq(modelsByWindowOf(null, NAMES), {}, 'L5a null details → {}')
  eq(seriesByWindowOf(undefined, NAMES), {}, 'L5b undefined details → {}')
  eq(modelsByWindowOf({}, NAMES), {}, 'L5c 无 models 字段 → {}')
  eq(Object.keys(modelsByWindowOf({ models: { weekly: [] } }, NAMES)), ['本周'], 'L5d 空数组窗口也算「产出了 key」')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
