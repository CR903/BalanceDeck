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
const { parseModelsResponse, parseCostByDay, modelsByWindowOf, seriesByWindowOf, modelsRequestOf, seriesRequestOf } =
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
  // 2026-10-11：`since` 只在**窗口落在服务端约 48h 保留期内**时有效（rolling 用
  // `range=24h + since=<5h 起点>` 精确裁到 5h）；周/月一律**不传 since**，用 range 取
  // 完整日聚合再客户端裁剪（超保留期的 since 会被钳制到最近约 2 天，见
  // `10-11-opencode-detail-window-series-fix/research/since-retention.md`）。
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
  const bucket = (t, cost, b = 'hour') => ({ t, bucket: b, cost, tokens: 1, requests: 1 })
  const HOUR = 3600_000
  const DAY = 86400_000
  const bound = (kind, startAt, resetAt, spanMs) => ({ kind, name: NAMES[kind], startAt, resetAt, spanMs })
  const ALL_BOUNDS = [
    bound('rolling', '2026-10-11T12:00:00Z', '2026-10-11T17:00:00Z', 5 * HOUR),
    bound('weekly', '2026-10-05T00:00:00Z', '2026-10-12T00:00:00Z', 7 * DAY),
    bound('monthly', '2026-10-01T00:00:00Z', '2026-10-31T00:00:00Z', 30 * DAY)
  ]

  // ① 三窗口 key 都产出（含 5 小时 —— 旧的「rolling 无明细」限制已推翻）。models 不裁剪。
  const models = modelsByWindowOf(
    { models: { rolling: [modelRow('a')], weekly: [modelRow('b')], monthly: [modelRow('c')] } },
    NAMES
  )
  eq(Object.keys(models).sort(), ['5 小时', '本月', '本周'].sort(), 'L1 models 三窗口 key 都产出（含 5 小时）')
  const series = seriesByWindowOf(
    {
      series: {
        rolling: [bucket('2026-10-11T13:00:00Z', 1)],
        weekly: [bucket('2026-10-06T00:00:00Z', 2, 'day')],
        monthly: [bucket('2026-10-02T00:00:00Z', 3, 'day')]
      }
    },
    ALL_BOUNDS
  )
  eq(Object.keys(series).sort(), ['5 小时', '本月', '本周'].sort(), 'L2 series 三窗口 key 都产出')

  // ② 空数组必须**保留 key**（官方确认该窗口无用量 ≠ 抓取失败）
  const empty = modelsByWindowOf({ models: { rolling: [], weekly: [modelRow('b')] } }, NAMES)
  ok('5 小时' in empty, 'L3a models 空数组保留 key（不是压成缺失）')
  eq(empty['5 小时'], [], 'L3b models 空数组照原样带出')
  ok(!('本月' in empty), 'L3c 未抓到的窗口不产出 key（缺失 = 失败）')
  const emptySeries = seriesByWindowOf({ series: { monthly: [] } }, [bound('monthly', undefined, undefined, 30 * DAY)])
  ok('本月' in emptySeries && emptySeries['本月'].length === 0, 'L3d series 空数组保留 key')

  // ③ 缺失（失败）时该窗口 key **不存在** —— 渲染层据此退回本机并标注「本机估算」
  const partial = seriesByWindowOf({ series: { weekly: [bucket('2026-10-06T00:00:00Z', 2, 'day')] } }, ALL_BOUNDS)
  eq(Object.keys(partial), ['本周'], 'L4a 只有抓到的窗口产出 key')
  ok(!('5 小时' in partial) && !('本月' in partial), 'L4b 抓取失败的窗口 key 不存在')

  // ④ 鲁棒：details 为 null / 缺字段
  eq(modelsByWindowOf(null, NAMES), {}, 'L5a null details → {}')
  eq(seriesByWindowOf(undefined, ALL_BOUNDS), {}, 'L5b undefined details → {}')
  eq(modelsByWindowOf({}, NAMES), {}, 'L5c 无 models 字段 → {}')
  eq(Object.keys(modelsByWindowOf({ models: { weekly: [] } }, NAMES)), ['本周'], 'L5d 空数组窗口也算「产出了 key」')
}

console.log('\nM. seriesByWindowOf 窗口裁剪 —— 周/月 range 全量 + 客户端裁到窗口')
{
  const NAMES = { rolling: '5 小时', weekly: '本周', monthly: '本月' }
  const HOUR = 3600_000
  const DAY = 86400_000
  const b = (t, cost, kind = 'day') => ({ t, bucket: kind, cost, tokens: 1, requests: 1 })
  const WINDOWS = [
    { kind: 'rolling', name: NAMES.rolling, startAt: '2026-10-11T12:00:59Z', resetAt: '2026-10-11T17:00:59Z', spanMs: 5 * HOUR },
    { kind: 'weekly', name: NAMES.weekly, startAt: '2026-10-05T00:00:00Z', resetAt: '2026-10-12T00:00:00Z', spanMs: 7 * DAY },
    { kind: 'monthly', name: NAMES.monthly, startAt: '2026-10-01T01:25:47Z', resetAt: '2026-10-31T01:25:47Z', spanMs: 30 * DAY }
  ]

  // 周：range=7d 全量（不带 since）返回 10-05..10-11 共 7 个日桶 → 全落在自然周内
  const week7 = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']
    .map((d, i) => b(`${d}T00:00:00Z`, i + 1))
  const clippedWeek = seriesByWindowOf({ series: { weekly: week7 } }, WINDOWS)['本周']
  eq(clippedWeek.length, 7, 'M1a 周序列保留整周 7 个日桶（修复前 since 只剩 2 天）')
  eq(clippedWeek.map((x) => x.cost), [1, 2, 3, 4, 5, 6, 7], 'M1b 桶内容与顺序不变')

  // 窗口外的桶被裁掉（更早的 09-30 / 更晚的 10-12）
  const withOutliers = [b('2026-09-30T00:00:00Z', 99), ...week7, b('2026-10-12T00:00:00Z', 99)]
  eq(seriesByWindowOf({ series: { weekly: withOutliers } }, WINDOWS)['本周'].length, 7,
    'M2 窗口外的日桶被裁掉（09-30 与 10-12）')

  // 自然周对齐：前驱桶（10-04，末端恰好 = startAt）不与窗口相交 → 排除，不把上一周算进来
  const aligned = [b('2026-10-04T00:00:00Z', 99), ...week7]
  eq(seriesByWindowOf({ series: { weekly: aligned } }, WINDOWS)['本周'].length, 7,
    'M3 自然周对齐时前驱桶(10-04)被排除 —— 不把上一周算进来')

  // rolling：小时桶按整点向下取整，首桶(12:00)早于 startsAt(12:00:59) → **保留**
  // （口径：保留与窗口相交的桶，避免丢掉窗口内第一个不完整桶的用量）
  const rollingBuckets = ['2026-10-11T11:00:00Z', '2026-10-11T12:00:00Z', '2026-10-11T13:00:00Z',
    '2026-10-11T14:00:00Z', '2026-10-11T15:00:00Z', '2026-10-11T16:00:00Z', '2026-10-11T18:00:00Z']
    .map((t) => b(t, 1, 'hour'))
  const clippedRolling = seriesByWindowOf({ series: { rolling: rollingBuckets } }, WINDOWS)['5 小时']
  eq(clippedRolling.map((x) => x.t), ['2026-10-11T12:00:00Z', '2026-10-11T13:00:00Z', '2026-10-11T14:00:00Z',
    '2026-10-11T15:00:00Z', '2026-10-11T16:00:00Z'],
    'M4a rolling 保留相交首桶(12:00)与窗口内小时桶；11:00 前驱、18:00 越界桶排除')

  // 月份：订阅起点非整日（01:25:47Z），首日桶(10-01)与其相交 → 保留（不漏首日用量）
  const monthBuckets = ['2026-09-30T00:00:00Z', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z',
    '2026-10-31T00:00:00Z', '2026-11-01T00:00:00Z'].map((t) => b(t, 1))
  eq(seriesByWindowOf({ series: { monthly: monthBuckets } }, WINDOWS)['本月'].map((x) => x.t),
    ['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', '2026-10-31T00:00:00Z'],
    'M5 月份首日桶(10-01 00:00 < startAt 01:25)保留；10-31 保留；09-30/11-01 排除')

  // 缺 startAt → 用 resetAt - spanMs 反推（口径同 windowStartIso）
  const noStart = [{ kind: 'weekly', name: NAMES.weekly, startAt: undefined, resetAt: '2026-10-12T00:00:00Z', spanMs: 7 * DAY }]
  eq(seriesByWindowOf({ series: { weekly: aligned } }, noStart)['本周'].length, 7,
    'M6 缺 startAt → resetAt - span 反推，效果同上（前驱桶仍排除）')

  // 两侧都缺 → 不裁剪（保守，不冒丢数据之险）
  const noBounds = [{ kind: 'weekly', name: NAMES.weekly, startAt: undefined, resetAt: undefined, spanMs: 7 * DAY }]
  eq(seriesByWindowOf({ series: { weekly: withOutliers } }, noBounds)['本周'].length, 9,
    'M7 无任何边界 → 原样返回（不裁剪）')

  // 空数组裁剪后仍为空，且 key 保留
  ok(('本周' in seriesByWindowOf({ series: { weekly: [] } }, WINDOWS)) &&
    seriesByWindowOf({ series: { weekly: [] } }, WINDOWS)['本周'].length === 0,
    'M8 空数组裁剪后仍为空数组且保留 key')

  // 坏 t（不可解析）的桶丢弃
  eq(seriesByWindowOf({ series: { weekly: [b('not-a-date', 99), ...week7] } }, WINDOWS)['本周'].length, 7,
    'M9 坏时间戳的桶被丢弃（不污染窗口）')
}

console.log('\nN. modelsRequestOf / seriesRequestOf —— 窗口 → 请求口径（since 只给 rolling）')
{
  const STARTS = { rolling: '2026-10-11T12:00:59Z', weekly: '2026-10-05T00:00:00Z', monthly: '2026-09-21T01:25:47Z' }

  // rolling：24h + since（窗口在服务端 ~48h 保留期内，准确）
  eq(modelsRequestOf('rolling', STARTS), { range: '24h', since: STARTS.rolling }, 'N1a rolling models = 24h + since')
  eq(seriesRequestOf('rolling', STARTS), { range: '24h', bucket: 'hour', since: STARTS.rolling },
    'N1b rolling series = 24h + hour + since')

  // 周/月：range 全量、**不带 since**（带旧起点会被服务端钳制到最近 2 天）
  eq(modelsRequestOf('weekly', STARTS), { range: '7d' }, 'N2a weekly models = 7d（无 since）')
  eq(seriesRequestOf('weekly', STARTS), { range: '7d', bucket: 'day' }, 'N2b weekly series = 7d + day（无 since）')
  eq(modelsRequestOf('monthly', STARTS), { range: '30d' }, 'N3a monthly models = 30d（无 since）')
  eq(seriesRequestOf('monthly', STARTS), { range: '30d', bucket: 'day' }, 'N3b monthly series = 30d + day（无 since）')

  // 缺起点也不影响周/月口径（它们不依赖起点）
  eq(modelsRequestOf('weekly', {}), { range: '7d' }, 'N4a 缺起点时 weekly 仍抓 7d（无 since）')
  eq(seriesRequestOf('monthly', {}), { range: '30d', bucket: 'day' }, 'N4b 缺起点时 monthly 仍抓 30d')

  // rolling 缺官方起点 → null（宁可不给，也不拿 24h 冒充 5 小时）
  eq(modelsRequestOf('rolling', {}), null, 'N5a rolling 缺起点 → null（不拿 24h 冒充 5h）')
  eq(seriesRequestOf('rolling', {}), null, 'N5b rolling 缺起点 → null')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
