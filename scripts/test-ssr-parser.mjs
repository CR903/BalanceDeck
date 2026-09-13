// SSR 解析器单元测试（node 直接运行，不依赖 electron）
// 用法：node scripts/test-ssr-parser.mjs
// 覆盖：英文/中文页面、嵌套 div、缺失字段

// 从编译产物导入（out/main/index.js 是 bundle，不适合直接测）。
// 这里直接内联一份等价实现用于行为验证 —— 与 src/main/adapters/opencode-cookie.ts 保持一致。
// 若源文件逻辑变更，请同步更新此测试。

const itemStartRe = /<div[^>]*data-slot="usage-item"/g

function parseUsageHtml(html) {
  const starts = []
  let m = itemStartRe.exec(html)
  while (m !== null) {
    starts.push(m.index)
    m = itemStartRe.exec(html)
  }
  const items = []
  for (let i = 0; i < starts.length; i++) {
    const block = html.slice(starts[i], starts[i + 1] ?? html.length)
    const labelMatch = block.match(/data-slot="usage-label"[^>]*>([^<]+)</)
    const valueMatch = block.match(/data-slot="usage-value"[\s\S]*?<!--\$-->\s*(\d+)\s*<!--\/-->/)
    const resetMatch = block.match(
      /data-slot="reset-time"[\s\S]*?(?:Resets in|重置于)(?:<!--\/-->\s*)?([\s\S]*?)(?:<!--\/-->|<\/span>)/
    )
    if (!labelMatch || !valueMatch) continue
    items.push({
      label: (labelMatch[1] ?? '').trim(),
      percent: Number.parseInt(valueMatch[1] ?? '0', 10),
      resetsIn: resetMatch ? resetMatch[1].replace(/<!--[\s\S]*?-->/g, '').trim() : ''
    })
  }
  const out = {}
  const kindOf = (label) => {
    const l = label.toLowerCase()
    if (l.startsWith('rolling') || l.startsWith('滚动')) return 'rolling'
    if (l.startsWith('weekly') || l.startsWith('每周')) return 'weekly'
    if (l.startsWith('monthly') || l.startsWith('每月')) return 'monthly'
    return undefined
  }
  for (const it of items) {
    const kind = kindOf(it.label)
    if (!kind) continue
    out[kind] = {
      kind,
      percent: Math.max(0, Math.min(100, Math.floor(it.percent))),
      resetInSec: parseDurationToSec(it.resetsIn),
      status: it.percent >= 100 ? 'rate-limited' : 'ok'
    }
  }
  return out
}

function parseDurationToSec(phrase) {
  if (!phrase) return 0
  const p = phrase.replace(/<!--[\s\S]*?-->/g, ' ').trim().replace(/\s+/g, ' ').toLowerCase()
  if (!p) return 0
  const re = /(\d+)\s*(?:个\s*)?(second|minute|hour|day|week|month|year|秒|分钟|小时|天|周|月|年)s?/g
  let total = 0
  let matched = false
  let m = re.exec(p)
  while (m !== null) {
    const n = Number.parseInt(m[1] ?? '0', 10)
    const unit = m[2] ?? ''
    matched = true
    switch (unit) {
      case 'second': case '秒': total += n; break
      case 'minute': case '分钟': total += n * 60; break
      case 'hour': case '小时': total += n * 3600; break
      case 'day': case '天': total += n * 86400; break
      case 'week': case '周': total += n * 604800; break
      case 'month': case '月': total += n * 2592000; break
      case 'year': case '年': total += n * 31536000; break
    }
    m = re.exec(p)
  }
  return matched ? total : 0
}

// ─── 断言辅助 ───────────────────────────────────────────────────────────────
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

// ─── 用例 1：英文页面（含嵌套 div 与 SolidStart 注释）───────────────────────
console.log('用例 1：英文页面')
const enHtml = `
<div class="usage"><div data-slot="usage-item" class="card">
  <span data-slot="usage-label">Rolling Usage</span>
  <div class="bar"><div class="fill"></div></div>
  <span data-slot="usage-value"><!--$-->42<!--/--></span>
  <span data-slot="reset-time">Resets in 2 hours 29 minutes</span>
</div><div data-slot="usage-item" class="card">
  <span data-slot="usage-label">Weekly Usage</span>
  <span data-slot="usage-value"><!--$-->100<!--/--></span>
  <span data-slot="reset-time">Resets in 5 days</span>
</div><div data-slot="usage-item" class="card">
  <span data-slot="usage-label">Monthly Usage</span>
  <span data-slot="usage-value"><!--$-->7<!--/--></span>
  <span data-slot="reset-time">Resets in 3 weeks</span>
</div></div>`
const en = parseUsageHtml(enHtml)
eq(en.rolling?.percent, 42, 'rolling.percent = 42')
eq(en.rolling?.resetInSec, 2 * 3600 + 29 * 60, 'rolling.resetInSec = 8940')
eq(en.rolling?.status, 'ok', 'rolling.status = ok')
eq(en.weekly?.percent, 100, 'weekly.percent = 100')
eq(en.weekly?.status, 'rate-limited', 'weekly.status = rate-limited')
eq(en.monthly?.percent, 7, 'monthly.percent = 7')
eq(en.monthly?.resetInSec, 3 * 604800, 'monthly.resetInSec = 1814400')

// ─── 用例 2：中文页面 ───────────────────────────────────────────────────────
console.log('用例 2：中文页面')
const zhHtml = `
<div data-slot="usage-item"><span data-slot="usage-label">滚动用量</span>
  <span data-slot="usage-value"><!--$-->88<!--/--></span>
  <span data-slot="reset-time">重置于 45 分钟</span></div>
<div data-slot="usage-item"><span data-slot="usage-label">每周用量</span>
  <span data-slot="usage-value"><!--$-->23<!--/--></span>
  <span data-slot="reset-time">重置于 2 天 4 小时</span></div>
<div data-slot="usage-item"><span data-slot="usage-label">每月用量</span>
  <span data-slot="usage-value"><!--$-->5<!--/--></span>
  <span data-slot="reset-time">重置于 1 个月</span></div>`
const zh = parseUsageHtml(zhHtml)
eq(zh.rolling?.percent, 88, '滚动用量.percent = 88')
eq(zh.rolling?.resetInSec, 45 * 60, '滚动用量.resetInSec = 2700')
eq(zh.weekly?.resetInSec, 2 * 86400 + 4 * 3600, '每周用量.resetInSec = 187200')
eq(zh.monthly?.resetInSec, 2592000, '每月用量.resetInSec = 2592000')

// ─── 用例 3：登录页（无 usage-item）─────────────────────────────────────────
console.log('用例 3：登录页（解析为空）')
eq(Object.keys(parseUsageHtml('<html><body><form>Sign in</form></body></html>')).length, 0, '空页面 → 零窗口')

// ─── 用例 4：时长短语单测 ───────────────────────────────────────────────────
console.log('用例 4：时长短语')
eq(parseDurationToSec('30 seconds'), 30, '"30 seconds" = 30')
eq(parseDurationToSec('1 week'), 604800, '"1 week" = 604800')
eq(parseDurationToSec('1 个月'), 2592000, '"1 个月" = 2592000')
eq(parseDurationToSec('1 year 2 months'), 31536000 + 2 * 2592000, '"1 year 2 months"')
eq(parseDurationToSec(''), 0, '空短语 = 0')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
