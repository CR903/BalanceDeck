// 播报编排层测试（App.tsx 里 evaluateAlerts 的纯函数边界）
// 用法：node scripts/test-alert-orchestration.mjs
//
// 覆盖：一轮播报的**编排** —— 先判后记的时序、锁存（AC9）、展开态分级（AC15）、
//       按供应商阈值覆盖、缺失值纪律、历史封顶（AC13）、空输入，以及 App.tsx 侧的
//       静态守卫（编排真的搬走了、没被搬回来、没长回去）。
//
// 为什么引擎测过了还要这一层：test-trigger-engine.mjs 管的是「给定快照与历史，
// 引擎能不能判出命中」；而「调用方有没有按对的顺序把它们喂进去」「命中之后锁存
// 记的是哪一批」一直留在 App.tsx 里，没有任何自动化断言能看见。盲审在 evaluateAlerts
// 里找出 3 个致命 bug —— 判定时序颠倒（相邻两差恒为 0，波动场景静默失效）、锁存缺失
// （每 60s 数据推送重播同一句）、按供应商覆盖被丢弃 —— **全都出在这一层**。
//
// 全部经 loadTs 加载**真实源码**（scripts/lib/load-ts.mjs）：checkTriggers /
// appendPoint / freshHits / latchKeys / mergeHits / balanceOf 一个都不内联 —— 内联过的
// test-percent.mjs 已经漂移过一次，源文件改了测试还绿着，等于没有测试。

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadTs } from './lib/load-ts.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const { evaluate, confirm, confirmLine, latestPending, pendingCountdown, REPEAT_MS, AUTO_CONFIRM_MS } =
  await loadTs('src/renderer/src/alertOrchestrate.ts')
const { DEFAULT_TRIGGER_CONFIG, THRESHOLD_FIELD, checkTriggers } =
  await loadTs('src/renderer/src/smartBroadcast.ts')
// P0-1：通知阈值表从引擎侧取。本段验的是「通知判定被编进了同一条时间线」，
// 阈值本身归 test-system-notify.mjs 管。
const { DEFAULT_NOTIFY_CONFIG } = await loadTs('src/renderer/src/systemNotify.ts')
// 频率闸门住在另一个模块里。AC7 的「重复间隔 5 分钟」与闸门的「10 次/小时」是**两个
// 模块各自的数字**，谁都不知道对方 —— 它们的相容性没有任何一层代码或测试看得见，
// 所以这里把两个模块的数字放在一起验一次（唯一的跨模块不变量断言）。
const { RATE_LIMIT } = await loadTs('src/renderer/src/speechOut.ts')

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
/**
 * 列出 src/ 下全部 .ts / .tsx（相对 ROOT），递归。
 *
 * 用途是「某个常量在全仓只允许声明一次」这类**数目**断言。只查两个已知文件答不了
 * 「有没有多出第三处定义」—— 而那恰恰是单一出处会破掉的方式。
 * 只读 .ts/.tsx：常量不可能声明在 css / mjs 里，而放宽到它们会把这个断言变成噪音。
 */
function srcFilesUnder(dir) {
  const out = []
  const walk = (rel) => {
    for (const e of readdirSync(resolve(ROOT, rel), { withFileTypes: true })) {
      const next = `${rel}/${e.name}`
      if (e.isDirectory()) walk(next)
      else if (/\.tsx?$/.test(e.name)) out.push(next)
    }
  }
  walk(dir)
  return out.sort()
}
/**
 * 子串出现次数（「供应商名只念一遍」这类断言用它，而不是 includes）。
 * 播报根本没生成（text 为 null）时返回 -1 而不是 0：返回 0 会让「一个分句都没有」
 * 这类断言空洞地绿，且反向验证时抛 TypeError 会中断整份报告，看不全红集。
 */
function times(hay, needle) {
  if (typeof hay !== 'string') return -1
  return hay.split(needle).length - 1
}

const HOUR = 3600_000
const T0 = 1_700_000_000_000
const ISO = '2026-09-29T00:00:00.000Z'

const win = (o = {}) => ({ name: '本月', used: 0, limit: 60, unit: 'usd', percent: 0, ...o })
const snap = (o = {}) => ({
  id: 'x',
  name: 'X',
  kind: 'coding',
  builtin: true,
  status: 'ok',
  windows: [],
  updatedAt: ISO,
  ...o
})
const pt = (o = {}) => ({ t: T0, id: 'x', balance: null, percent: null, ...o })
/** 充值余额型（kind=balance）：窗口的 used 本身就是账户余额 */
const cash = (balance, o = {}) =>
  snap({ id: 'cash', name: 'DeepSeek', kind: 'balance', windows: [{ name: '账户余额', used: balance, unit: 'cny' }], ...o })
/** 套餐型且限额未知 → 判不出余额（否则会顺带命中余额预警），只命中「用量耗尽」 */
const goHigh = snap({ id: 'go', name: 'Go', windows: [win({ used: 58, limit: undefined, percent: 95 })] })

const ALL_ON = { balance: true, fluctuation: true, exhaustion: true, idle: true, abnormal: true }
const cfg = (o = {}) => ({ ...DEFAULT_TRIGGER_CONFIG, ...o })

/** 一轮评估的完整上下文；`o` 覆盖任何一项。默认收起态、5 个场景全开、无待确认批次 */
const ctx = (o = {}) => ({
  snapshots: [],
  history: [],
  config: DEFAULT_TRIGGER_CONFIG,
  triggerOn: ALL_ON,
  format: 'simple',
  hideBalance: false,
  muted: [],
  collapsed: true,
  latched: [],
  pending: [],
  historyCap: 100,
  now: T0,
  // P0-1 通知通道：默认开 + 默认阈值。既有 A-L 段一律不带 notifyLatched，
  // 走的是「没弹过」这条路，所以它们的 notify 恒为 null，M 段才断得干净。
  notifyOn: true,
  notifyConfig: DEFAULT_NOTIFY_CONFIG,
  notifyLatched: [],
  ...o
})
const round = (o = {}) => evaluate(ctx(o))
/**
 * 下面 4 个取数器一律 **null 安全**：`evaluate` 返回 null 时取空值，让断言**报红**而不是抛
 * TypeError 把整份报告打断。
 *
 * 这不是洁癖：反向验证时实测过 —— 按 design.md 字面实现（「text 为 null 就整体 return null」）
 * 会让第 1 轮就返回 null，脚本在 A2 处抛异常中断，**B7「锁存轮次仍记历史」这条专门盯它的断言
 * 根本跑不到**。抛异常确实让退出码非 0（没被骗过），但红集看不到、batch 的声明目标集
 * 无法核对 —— 那正是 quality-guidelines「exact red set」要排除的情况。
 * 空值不是「什么都对」：下面对应的 eq 期望值非空，取到空值照样红。
 */
const textOf = (d) => d?.text ?? null
const latchOf = (d) => [...(d?.nextLatched ?? [])].sort()
const histOf = (d, field) => (d?.nextHistory ?? []).map((p) => p[field])
/** 历史的 [t, balance] 行，供「落库了什么」类断言用 */
const rowsOf = (d) => (d?.nextHistory ?? []).map((p) => [p.t, p.balance])
/** 播报文本，null 当空串 —— 只给 `.includes` 这类子串断言用；要断言 null 本身的地方用 textOf */
const speech = (d) => d?.text ?? ''

/** 待确认批次的三个取数器（AC7）。同样 null 安全，让断言报红而不是抛 TypeError */
const pendingOf = (d) => d?.nextPending ?? []
const reasonOf = (d) => d?.reason ?? null
const pendText = (list) => list.map((b) => b.text)

/** 系统通知的两个取数器（P0-1 / design.md 第 8-9 条）。同样 null 安全 */
const notifyOf = (d) => d?.notify ?? null
const nlatchOf = (d) => [...(d?.nextNotifyLatched ?? [])].sort()

// ─── 夹具 ──────────────────────────────────────────────────────────────────
// 25 小时里 4 条一动不动的采样：判得出「长时间未使用」（例行级），判不出波动
const idleHist = [0, 1, 2, 3].map((i) => pt({ t: T0 - 25 * HOUR + i * 60_000, id: 'cash', balance: 100 }))
// 同一批历史再加一条「1 小时前还是 100 元」：现在余额 70 → 同时命中波动（紧急）与未使用（例行）
const mixedHist = [...idleHist, pt({ t: T0 - HOUR, id: 'cash', balance: 100 })]

console.log('\nA. 编排时序：判定吃的是**上一轮**采样（历史 bug #1：先记后判）')

// 第 1 轮：冷启动，没有上一轮可比 —— 波动判不出来（宁漏不误报），但本轮采样必须落库
const a1 = round({ snapshots: [cash(100)], now: T0 })
eq(textOf(a1), null, 'A1 冷启动没有上一轮 → 不播')
eq(rowsOf(a1), [[T0, 100]], 'A2 本轮采样落库，供**下一轮**比对')

// 第 2 轮：余额掉了 30。判定若吃的是本轮自己，相邻两差恒为 0，这条就会是 null
const a2 = round({ snapshots: [cash(70)], history: a1?.nextHistory ?? [], now: T0 + HOUR })
eq(textOf(a2), 'DeepSeek 单次用量增长 30 元', 'A3 第 2 轮比的是上一轮余额 → 波动命中，金额正是 30')
eq(a2?.urgent ?? null, true, 'A4 波动是紧急级 → 整条按紧急插队（speechOut 会打断例行）')
eq(histOf(a2, 'balance'), [100, 70], 'A5 两条采样都在，本轮没有重复记一遍')
eq(histOf(a2, 't'), [T0, T0 + HOUR], 'A6 采样时刻取的是传入的 now（纯函数不读自己的钟）')

const a2b = round({ snapshots: [cash(65)], history: a1?.nextHistory ?? [], now: T0 + HOUR })
eq(textOf(a2b), 'DeepSeek 单次用量增长 35 元', 'A7 金额跟着两次采样之差走（35，不是本轮与自己的差 0）')

// 反查：把「已含本轮」的历史喂给引擎 —— 这就是顺序写反时的样子
const advanced = a2.nextHistory
eq(
  checkTriggers([cash(70)], advanced, DEFAULT_TRIGGER_CONFIG, T0 + HOUR).some((h) => h.kind === 'fluctuation'),
  false,
  'A8 反查：hist 若已含本轮，引擎就是恒不命中波动（AC4 静默失效长什么样）'
)
eq(
  checkTriggers([cash(70)], a1.nextHistory, DEFAULT_TRIGGER_CONFIG, T0 + HOUR).some((h) => h.kind === 'fluctuation'),
  true,
  'A9 对照：hist 只含上一轮时同一份数据会命中（所以 A3 的红来自编排顺序，不是数据本来就不触发）'
)

console.log('\nB. 锁存：条件持续成立期间只播一次（AC9「恰好一次」）')

const b1 = round({ snapshots: [cash(8)], now: T0 })
eq(textOf(b1), 'DeepSeek 余额不足，剩余 8 元', 'B1 余额 8 < 10 → 播')
eq(latchOf(b1), ['cash balance'], 'B2 锁存键 = 供应商 × 场景')

const b2 = round({ snapshots: [cash(8)], history: b1?.nextHistory ?? [], latched: b1?.nextLatched ?? [], now: T0 + HOUR })
eq(textOf(b2), null, 'B3 条件仍成立 → 本轮不播（数据每 60s 推一次，不锁存就是每分钟念一遍）')
eq(latchOf(b2), ['cash balance'], 'B4 锁存保持')
eq(b2?.urgent ?? null, false, 'B5 不播时 urgent 恒为 false（speakOut 用它决定要不要打断在途播报）')

// 连推 5 轮「推送密」场景：只应播 1 次，但每一轮都仍要记历史
{
  let latched = []
  let history = []
  const spoken = []
  for (let i = 0; i < 5; i++) {
    const d = round({ snapshots: [cash(8)], history, latched, now: T0 + i * HOUR })
    if (textOf(d)) spoken.push(textOf(d))
    // 传下去的是**上一轮的输出**；d 为 null 时保留上一轮的值，让断言报红而不是抛异常
    if (d) {
      latched = d.nextLatched
      history = d.nextHistory
    }
  }
  eq(spoken, ['DeepSeek 余额不足，剩余 8 元'], 'B6 连续 5 轮越界 → 只播 1 次')
  eq(history.length, 5, 'B7 被锁存挡下的轮次**仍然记历史**（不记的话异常检测永远攒不够 10 个样本）')
}

// 条件解除 → 解锁 → 再越过 → 重新播
{
  const c1 = round({ snapshots: [cash(8)], now: T0 })
  const c2 = round({ snapshots: [cash(50)], history: c1?.nextHistory ?? [], latched: c1?.nextLatched ?? [], now: T0 + HOUR })
  eq(textOf(c2), null, 'B8 回到阈值以上 → 不播')
  eq(latchOf(c2), [], 'B9 锁存随之清掉（锁存的是「播过」不是「发生过」）')
  const c3 = round({ snapshots: [cash(8)], history: c2?.nextHistory ?? [], latched: c2?.nextLatched ?? [], now: T0 + 2 * HOUR })
  eq(textOf(c3), 'DeepSeek 余额不足，剩余 8 元', 'B10 再次越过 → 重新播（充了钱又花光仍要听得见）')
}

console.log('\nC. 按供应商阈值覆盖（历史 bug #3：覆盖被丢弃 + 键名写读不一致）')

// 覆盖生效的方向是「把阈值改掉」：压到 1，余额 5 就不再越线（抬到 999 只会照报）
const overLow = cfg({ perProvider: { cash: { balanceLow: 1 } } })
eq(textOf(round({ snapshots: [cash(5)], config: overLow, now: T0 })), null, 'C1 覆盖把余额阈值压到 1 → 余额 5 不再报')
eq(
  textOf(round({ snapshots: [cash(5)], config: DEFAULT_TRIGGER_CONFIG, now: T0 })),
  'DeepSeek 余额不足，剩余 5 元',
  'C2 对照：同一份数据用全局阈值 10 会报（所以 C1 的红来自覆盖，不是数据本来就不触发）'
)
eq(
  textOf(round({ snapshots: [cash(5)], config: cfg({ perProvider: { other: { balanceLow: 1 } } }), now: T0 })),
  'DeepSeek 余额不足，剩余 5 元',
  'C3 覆盖别的供应商不影响它'
)

// 覆盖键名必须与引擎 resolveConfig 读的是同一个键 —— THRESHOLD_FIELD 是唯一映射表
const balKey = THRESHOLD_FIELD.balance
eq(balKey, 'balanceLow', 'C4 场景→阈值字段名由 THRESHOLD_FIELD 说了算（不是各写一份字符串）')
eq(
  textOf(round({ snapshots: [cash(5)], config: cfg({ perProvider: { cash: { [balKey]: 1 } } }), now: T0 })),
  null,
  'C5 用 THRESHOLD_FIELD 拼出的键同样生效（写侧与读侧同源，见 K10 静态守卫）'
)

// 覆盖挡下的那一轮不锁存：把阈值调回去要立刻能播
{
  const d1 = round({ snapshots: [cash(5)], config: overLow, now: T0 })
  eq(latchOf(d1), [], 'C6 被覆盖挡下的一轮不锁存（记了就等于谎称「用户已经听过」）')
  const d2 = round({
    snapshots: [cash(5)],
    config: DEFAULT_TRIGGER_CONFIG,
    history: d1?.nextHistory ?? [],
    latched: d1?.nextLatched ?? [],
    now: T0 + HOUR
  })
  eq(textOf(d2), 'DeepSeek 余额不足，剩余 5 元', 'C7 阈值调回去 → 立即播')
}

console.log('\nD. 展开态只放行紧急（AC15），收起态放行全部')

const dCollapsed = round({ snapshots: [cash(100)], history: idleHist, collapsed: true, now: T0 })
eq(textOf(dCollapsed), 'DeepSeek 已 25 小时无用量变化', 'D1 收起态：例行项照播')
eq(dCollapsed?.urgent ?? null, false, 'D2 只有例行项 → 不是紧急（不插队、不打断在途的紧急播报）')
const dExpanded = round({ snapshots: [cash(100)], history: idleHist, collapsed: false, now: T0 })
eq(textOf(dExpanded), null, 'D3 展开态：例行项被挡下（屏幕上已经看得见，AC15）')
// 契约上写着「text 为 null 时 urgent 恒为 false」——这里在**展开态被挡**这条路径上验一次，
// 免得那条注释变成一句没人核对的话
eq(dExpanded?.urgent ?? null, false, 'D3b 展开态被挡下时 urgent 也是 false（Decision 契约）')

eq(
  textOf(round({ snapshots: [cash(70)], history: [pt({ t: T0 - HOUR, id: 'cash', balance: 100 })], collapsed: false, now: T0 + HOUR })),
  'DeepSeek 单次用量增长 30 元',
  'D4 展开态：紧急项照播（分级只挡例行）'
)

const mixedBase = { snapshots: [cash(70)], history: mixedHist, now: T0 }
const mixedExp = round({ ...mixedBase, collapsed: false, format: 'detailed' })
eq(textOf(mixedExp), 'DeepSeek 单次用量增长 30 元', 'D5 展开态：紧急 + 例行同轮命中 → 只念紧急那条')
eq(mixedExp?.urgent ?? null, true, 'D6 有紧急 → urgent')
const mixedCol = round({ ...mixedBase, collapsed: true, format: 'detailed' })
eq(textOf(mixedCol), 'DeepSeek 单次用量增长 30 元，已 25 小时无用量变化', 'D7 收起态：两条都念，且合成同一句（AC12）')
eq(times(textOf(mixedCol), 'DeepSeek'), 1, 'D8 收起态同一个供应商只出现一次（不是逐条念）')
eq(times(textOf(mixedCol), '；'), 0, 'D9 一个供应商不分句')

console.log('\nE. 锁存只记「实际进入播报判定」的那批（AC9 × AC15 的交互）')

const e1 = round({ snapshots: [cash(100)], history: idleHist, collapsed: false, now: T0 })
eq(textOf(e1), null, 'E1 展开态：例行项被挡下')
eq(latchOf(e1), [], 'E2 被挡下的例行项**不**锁存（锁了它，用户收起面板后就永远听不到）')
// E1 那一轮已经把本轮采样记进了历史，所以第 2 轮的静默跨度是 26 小时而不是 25
const e2 = round({
  snapshots: [cash(100)],
  history: e1?.nextHistory ?? [],
  latched: e1?.nextLatched ?? [],
  collapsed: true,
  now: T0 + HOUR
})
eq(textOf(e2), 'DeepSeek 已 26 小时无用量变化', 'E3 收起面板后同一条件仍能播（这正是该 bug 的症状）')
// 对照：确实播过的项照旧进锁存（否则 E2 的绿没有意义）
eq(latchOf(dCollapsed), ['cash idle'], 'E4 收起态真播过的例行项确实进了锁存')

console.log('\nF. 缺失值不得当成 0（type-safety.md：不知道 ≠ 0）')

// 套餐型但限额未知 → balanceOf 判不出余额。阈值抬到 100 万：任何**非 null** 的余额
// 都会触发，而 0 < 1000000 —— 一旦实现里写了 ?? 0，这里立刻冒出一条假的「余额不足」。
const noLimit = [snap({ id: 'go', name: 'Go', windows: [win({ used: 58, limit: undefined, percent: 95 })] })]
const f1 = round({ snapshots: noLimit, config: cfg({ balanceLow: 1_000_000 }), now: T0 })
eq(textOf(f1), 'Go 用量已用 95%', 'F1 套餐限额未知 → 余额判不出，只播耗尽（没拿 0 冒充余额）')
// F2/F3 用 `speech`（null → ''）：text 为 null 时这两条会**空洞地绿**，但 F1 就在上一行把
// 文本钉成了非空串 —— 文本真没了是 F1 红，不是这两条在放水
ok(!speech(f1).includes('余额'), 'F2 播报里没有余额从句')
ok(!speech(f1).includes('元'), 'F3 播报里没有金额（0 元也算金额）')
eq(histOf(f1, 'balance'), [null], 'F4 历史里的 balance 保持 null（填 0 会同时造出假的「余额不足」和被拉低的均值）')
eq(histOf(f1, 'percent'), [95], 'F5 用量率照常记')

// 余额型但没有货币窗口 → 同样判不出余额
const noMoney = [snap({ id: 'go', name: 'Go', kind: 'balance', windows: [{ name: '请求数', used: 1200, unit: 'request' }] })]
const f2 = round({ snapshots: noMoney, config: cfg({ balanceLow: 1_000_000 }), now: T0 })
eq(textOf(f2), null, 'F6 余额型但没有货币窗口 → 判不出余额 → 沉默')
eq(histOf(f2, 'balance'), [null], 'F7 历史里同样是 null')

// 非 ok 的快照不参与判定，但也不该被写成 0
const f3 = round({ snapshots: [cash(0, { status: 'error' })], now: T0 })
eq(textOf(f3), null, 'F8 status=error → 不判（这一轮没有可信数据，播报只是把上一轮的旧闻再说一遍）')
eq(histOf(f3, 'balance'), [], 'F9 非 ok 的快照不记历史')

console.log('\nG. 历史封顶与「本轮无需落盘」（AC13）')

const gHist = [1, 2, 3].map((i) => pt({ t: T0 - (4 - i) * HOUR, id: 'cash', balance: 100 - i * 10 }))
const g1 = round({ snapshots: [cash(100)], history: gHist, historyCap: 3, now: T0 })
eq(histOf(g1, 't'), [T0 - 2 * HOUR, T0 - HOUR, T0], 'G1 cap=3：保留的是最新三条，超出丢掉最旧的')
// ⚠ 负向断言一律带 `!= null` 前置：evaluate 返回 null 时取到的是 []，判「引用不同」会
//   空洞地绿（那是「压根没返回历史」，不是「历史变了」）—— 与 test-structure.mjs 同一条纪律
ok(g1 != null && g1.nextHistory !== gHist, 'G2 历史变了 → 返回新数组（App 据此落盘）')

const g2 = round({ snapshots: [cash(8, { status: 'error' })], history: gHist, now: T0 })
ok(g2 != null && g2.nextHistory === gHist, 'G3 没有 status=ok 的快照 → 历史原样返回（同一引用，App 不落盘）')
eq(latchOf(g2), [], 'G4 同一轮没有命中 → 锁存清空')

const many = Array.from({ length: 100 }, (_, i) => pt({ t: T0 - (100 - i) * HOUR, id: 'cash', balance: 100 }))
eq(histOf(round({ snapshots: [cash(100)], history: many, historyCap: 100, now: T0 }), 't').length, 100, 'G5 满 100 条 + 1 → 仍恒为 100')
eq(histOf(round({ snapshots: [cash(100)], history: many, historyCap: 1000, now: T0 }), 't').length, 101, 'G6 cap 从 ctx 传入，不是写死的 100')

console.log('\nH. 空输入与纯函数性')

eq(round({ snapshots: [], now: T0 }), null, 'H1 没有任何快照 → null（不播、不动历史与锁存）')
eq(round({}), null, 'H2 默认空上下文同样是 null')

{
  // 这份数据命中的是**波动**（100 → 70），所以锁存键也必须是波动那条：锁存键错了
  // 会静默退化成「永远当成没播过」——H8 就是拿它当对照的。
  const hCtx = ctx({ snapshots: [cash(70)], history: [pt({ t: T0 - HOUR, id: 'cash', balance: 100 })], latched: new Set(['cash fluctuation']), now: T0 + HOUR })
  const snapBefore = JSON.stringify(hCtx.snapshots)
  const histBefore = hCtx.history.length
  const h1 = evaluate(hCtx)
  const h2 = evaluate(hCtx)
  eq(JSON.stringify(hCtx.snapshots), snapBefore, 'H3 入参快照未被就地修改（深比较）')
  eq(hCtx.history.length, histBefore, 'H4 入参 history 未被就地追加')
  ok([...hCtx.latched].length === 1, 'H5 入参的 latched 集合未被就地写入（仍是那一项）')
  ok(h1 != null && h1.nextLatched !== hCtx.latched, 'H6 nextLatched 是新集合，不是入参那个')
  eq(textOf(h1), null, 'H7 这份 ctx 的波动场景已被锁存 → 不播（锁存真的读了 ctx.latched）')
  eq(latchOf(h1), ['cash fluctuation'], 'H8 锁存仍保住这一项')
  ok(h1 != null && h2 != null && h1.nextLatched !== h2.nextLatched, 'H9 nextLatched 每次都是新对象')
}

{
  // 纯度：同一份 ctx 调两次要**整个 Decision 相等**。
  // ⚠ 这条不能建在 H7 那份 ctx 上 —— 它的 text 恒为 null（已锁存），比 `null === null`
  //   是**空洞地绿**，模块里藏一份跨轮次状态它照样通过。所以用一份**真的会播**的 ctx：
  //   有状态的实现（模块级计数器、上一轮缓存）恰恰在这里才分岔。
  const pCtx = ctx({ snapshots: [cash(70)], history: [pt({ t: T0 - HOUR, id: 'cash', balance: 100 })], now: T0 + HOUR })
  const shape = (d) => ({
    text: d?.text ?? null,
    urgent: d?.urgent ?? null,
    nextHistory: d?.nextHistory ?? null,
    nextLatched: [...(d?.nextLatched ?? [])].sort(),
    // AC7 的两个新字段同样要进纯度比较：跨轮次的隐藏状态（上一批的 firstSpokenAt 之类）
    // 恰恰是它们最容易藏的地方
    nextPending: JSON.stringify(d?.nextPending ?? null),
    reason: d?.reason ?? null
  })
  const p1 = evaluate(pCtx)
  const p2 = evaluate(pCtx)
  ok(textOf(p1) != null, 'H10 前置：这份 ctx 真的会播（否则下面的相等比较是空洞的）')
  eq(shape(p1), shape(p2), 'H11 同一份 ctx 调两次 → 整个 Decision 逐字段相等（无隐藏的轮次状态）')
  eq(textOf(p1), 'DeepSeek 单次用量增长 30 元', 'H12 对照：播报内容确实非空，H11 不是在比两个 null')
}

console.log('\nI. 另外两个过滤器：静音供应商 / 场景开关')

const i1 = round({ snapshots: [cash(8)], muted: ['cash'], now: T0 })
eq(textOf(i1), null, 'I1 静音的供应商不播')
eq(latchOf(i1), [], 'I2 静音的不锁存（取消静音后仍要能播）')
eq(histOf(i1, 't'), [T0], 'I3 静音的供应商仍然记历史（否则取消静音后波动/异常会缺样本）')
const i2 = round({ snapshots: [cash(8)], history: i1?.nextHistory ?? [], latched: i1?.nextLatched ?? [], now: T0 + HOUR })
eq(textOf(i2), 'DeepSeek 余额不足，剩余 8 元', 'I4 取消静音后仍能播')

eq(textOf(round({ snapshots: [cash(8)], triggerOn: { ...ALL_ON, balance: false }, now: T0 })), null, 'I5 关掉余额场景 → 不播')
eq(textOf(round({ snapshots: [cash(8)], triggerOn: { balance: true }, now: T0 })), 'DeepSeek 余额不足，剩余 8 元', 'I6 triggerOn 缺字段 = 开（判据是 !== false）')

console.log('\nJ. 文案参数透传：格式与隐藏余额')

eq(textOf(round({ ...mixedBase, collapsed: true, format: 'simple' })), 'DeepSeek 单次用量增长 30 元', 'J1 简洁：只说最高优先级那一条')
eq(textOf(round({ ...mixedBase, collapsed: true, format: 'detailed' })), 'DeepSeek 单次用量增长 30 元，已 25 小时无用量变化', 'J2 详细：同一供应商的命中连成一句')
eq(textOf(round({ snapshots: [cash(8)], hideBalance: true, now: T0 })), 'DeepSeek 余额已隐藏', 'J3 隐藏余额：金额从句整条剔除（不是只藏掉符号）')
eq(textOf(round({ snapshots: [cash(8)], hideBalance: false, now: T0 })), 'DeepSeek 余额不足，剩余 8 元', 'J4 对照：不隐藏时照常播金额')
eq(textOf(round({ snapshots: noLimit, hideBalance: true, now: T0 })), 'Go 用量已用 95%', 'J5 隐藏余额时用量照念（隐藏的是钱，不是数据）')

// ─── K. App.tsx 静态守卫 ──────────────────────────────────────────────────
// 前面的断言证明编排**行为**对；这几条证明编排**住在纯函数里**、且没被搬回 App.tsx。
// 没有它们的话，把 6 步逻辑改回组件体内、靠人工 review 才拦得住。
const appPath = resolve(ROOT, 'src/renderer/src/App.tsx')
const appSrc = readFileSync(appPath, 'utf-8')
const aoSrc = readFileSync(resolve(ROOT, 'src/renderer/src/alertOrchestrate.ts'), 'utf-8')

/** 取 `const <marker>` 开头、以同缩进 `}` 收尾的整个函数体；取不到返回 null */
function bodyOf(src, marker) {
  const from = src.indexOf(marker)
  if (from < 0) return null
  const end = src.indexOf('\n  }\n', from)
  if (end < 0) return null
  return src.slice(from, end + 4)
}
const evalBody = bodyOf(appSrc, 'const evaluateAlerts = ')

/** 剥掉注释后再判负向断言 —— 否则本模块头注释里那句「不读 Date.now()」自己就把门点红了
 *  （与 test-structure.mjs 处理 CSS 注释是同一条纪律：判的是**生效声明**，不是提到过这个词） */
const aoCode = aoSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

console.log('\nK. 编排层真的搬走了，且没长回去')

ok(aoCode.trim().length > 0, 'K0 前置：编排模块源码读得到（下面的负向断言不能空洞通过）')
ok(!/Date\.now\(|new Date\(/.test(aoCode), 'K1 编排纯函数里没有时钟读取（now 由 ctx 传入）')
ok(!/window\.|document\.|setExtras|api\./.test(aoCode), 'K2 编排纯函数不碰 window / DOM / IPC')
ok(evalBody != null, 'K3 取得到 evaluateAlerts 的整段源码')
ok(
  evalBody != null && (evalBody.match(/Date\.now\(\)/g) || []).length === 1,
  'K4 App 侧只在组装 ctx 时取一次当前时间（编排决策里不再有隐式时钟）'
)
// K4 只数了「有一个 Date.now()」，没管它**去哪**了 —— 写成 `now: 0` 再另处调一次 Date.now()
// 照样绿，而那正是 AC1 要防的（隐式时钟重新参与编排决策）。所以单独钉住流向
ok(
  evalBody != null && /now:\s*Date\.now\(\)/.test(evalBody),
  'K4b 唯一那次 Date.now() 必须**喂给 evaluate 的 now**（写成 now: 0 就退回隐式时钟了）'
)
ok(
  evalBody != null && !/checkTriggers|appendPoint|freshHits|latchKeys|mergeHits|balanceOf/.test(evalBody),
  'K5 evaluateAlerts 里没有残留任何引擎细节 —— 6 步编排全在纯函数里'
)
// ⚠ 依赖数组里现在**有** notifyOn（P0-1：系统通知是独立通道，那一路也要被它叫醒，
//   判据见 M30b/M30c），所以这条不能再钉死成字面量 `[ttsOn, state.snapshots]` ——
//   它要守的是「触发源是**数据**（state.snapshots）而不是时间」，与 notifyOn 在不在场无关。
//   钉字面量的后果是：为了加 notifyOn 而把这条改成永久红，等于把守卫废掉。
ok(
  evalBody != null &&
    /\}, \[ttsOn, (?:notifyOn, )?state\.snapshots\]\)/.test(appSrc) &&
    /evaluateAlerts\(\)/.test(appSrc),
  'K6 数据推送 effect 仍认得 state.snapshots，且触发源是数据（不是时间）'
)
ok(
  evalBody != null && /alertLatchRef\.current\s*=/.test(evalBody),
  'K7 锁存必须被写回（AC9：漏了这一句就退回「每 60s 重播同一句」）'
)
ok(
  evalBody != null && /persistHistory\(/.test(evalBody) && /nextHistory !== ctx\.history/.test(evalBody),
  'K8 历史落盘仍由 App 负责，且只在真的变了时才落盘'
)
ok(evalBody != null && /speakOut\(/.test(evalBody), 'K9 播报仍由 App 负责（纯函数不碰音频）')
ok(
  evalBody != null && /cur\[field\] = value/.test(appSrc) && /const field = THRESHOLD_FIELD\[k\]/.test(appSrc),
  'K10 阈值覆盖的写侧按 THRESHOLD_FIELD 取到的字段名写（与引擎 resolveConfig 读的同一个键，见 C5）'
)
const evalLines = evalBody == null ? 0 : evalBody.split('\n').length
// 抽离后 37 行 → 现状 21 行（09-29 加了 bill 那一行说明，多 1 行）。
// 上限 20 是在那之前定的，21 行会被误红，所以本轮放宽到 **24**：留 3 行余量给下一处
// 真实的小改动，但不给「函数又长起来了」留空间 —— 这个函数存在的全部意义就是薄。
// 放宽到 26 也不会更安全，只会让它在没人注意的时候长到 25。
ok(evalLines > 0 && evalLines <= 24, `K11 evaluateAlerts 保持在 24 行以内（当前 ${evalLines} 行；抽离前是 37 行）`)

// 「服务不可达」这条链：speechOut 的 onTtsFailed → App 的自愈探测 stepProbe → setTtsUnreachable
// → 设置页提示条。它断了不抛不红，用户只是"没声音"，分不清是服务挂了还是自己关了开关。
// ⚠ 置位逻辑**住在 stepProbe 里**（失败时置位 + 排下一档退避探测），不在 onTtsFailed 的回调体里 ——
//   所以这里不能断言「onTtsFailed ... setTtsUnreachable」相邻出现，要顺着 stepProbe 找。
const vrsSrc = readFileSync(resolve(ROOT, 'src/renderer/src/VoiceReminderSection.tsx'), 'utf-8')
ok(
  /onTtsFailed:\s*\(reason\)\s*=>\s*\{[^}]*stepProbe\(\s*'fail'/.test(appSrc) &&
    /onTtsOk:\s*\(\)\s*=>\s*\{[^}]*stepProbe\(\s*'ok'/.test(appSrc) &&
    /const stepProbe[\s\S]{0,700}?probeStep\(probeRef\.current, event,\s*Date\.now\(\)\)[\s\S]{0,400}?setTtsUnreachable\(r\.next\.unreachable\)/.test(appSrc),
  'K12 onTtsFailed / onTtsOk 接到自愈探测；探测把 unreachable 状态交给纯函数 probeStep 算，再回填 setTtsUnreachable'
)
// K13 只管**接线**：unreachable 为真时确实渲染出那条提示条。
// 文案质量由 test-speech-out.mjs 的 P1–P5 判（那边切的是被渲染出来的那一段正文）。
//
// ⚠ 这里**不能**再用「文件里出现过『连不上语音服务』」判文案：那条提示有 fallback 开/关
//   两个分支，上一版只判了其中一支的名字 —— 把它换成技术术语实测红集为 0，K13 照样绿。
//   弱判据放在这里等于给回归发通行证，所以只保留「条件 + 容器 + 文案非空」。
const warnAt = vrsSrc.indexOf('vrs-warn')
const warnBlock = warnAt > 0 ? vrsSrc.slice(warnAt, vrsSrc.indexOf('</div>', warnAt)) : ''
ok(
  warnAt > 0 && /unreachable\s*&&\s*\(/.test(vrsSrc),
  'K13a unreachable 为真时设置页渲染出那条提示条（这条提示是 D2 唯一的用户可见信号）'
)
ok(
  warnBlock.length > 0 && warnBlock.includes('{fallback'),
  'K13b 提示正文随 fallback 开关分支，两支都要有话可说（不是只写死一句）'
)

// 探测定时器的两处纪律，都是「写错了不抛不红、只是功能悄悄没了」那一类：
//
// ① delayMs === null 有两种含义（链还在跑 / 本轮已用尽），只有「恢复态」才允许清定时器。
//    按 null 就清，表现是探测自己把自己取消。
// ② 「组件还活着」那个标志必须**在 effect 体里复位**，不能只在 cleanup 里写 false。
//    本项目渲染入口挂着 <React.StrictMode>（main.tsx），React 18 在开发模式下把每个 effect
//    跑成 挂载 → 清理 → 再挂载，ref 跨这次假卸载不会重置 → 标志永久为 false →
//    runProbe 的结果全被丢弃 → 缺陷 2 的自愈通路在 dev 下静默死掉，而 prod 一切正常。
const stepProbeBody = bodyOf(appSrc, 'const stepProbe')
ok(
  stepProbeBody != null &&
    /if\s*\(!r\.next\.unreachable\)\s*\{[\s\S]{0,200}?clearProbeTimer\(\)/.test(stepProbeBody) &&
    /if\s*\(r\.delayMs === null\)\s*return/.test(stepProbeBody),
  'K17 只有恢复态才清探测定时器；delayMs === null（链还在跑/已用尽）不动它，否则探测会自己取消自己'
)
// 判的是**顺序**：复位在体里（`= true`）→ 才是 `return () => {` → 清理里 `= false`。
// 上一版试过用正则去切某个 useEffect 的体，切中的是文件里第一个 `useEffect(() => {…}, [])`
// （配置加载那个），判据整条落空 —— 结构断言里这种「匹配到了但不是那一处」最难读，
// 所以改成按位置判，并先证明三处锚点都存在。
const aliveTrueAt = appSrc.indexOf('probeInFlightRef.current = true')
const aliveRetAt = appSrc.indexOf('return () => {', aliveTrueAt)
const aliveFalseAt = appSrc.indexOf('probeInFlightRef.current = false')
ok(
  aliveTrueAt > 0 && aliveRetAt > aliveTrueAt && aliveFalseAt > aliveRetAt,
  'K18 「组件还活着」标志在 effect 体里复位、只在 cleanup 里置否（StrictMode 双调用下少了前者，自愈在 dev 下永久失效）'
)

// 预设表与出厂默认必须一致：两者不一致 = 用户点一下预设就悄悄换了个音色，且界面上
// 一点也看不出来。
// 单一出处：两边都引用 shared/tts-preset 的 DEFAULT_TTS_VOICE 常量 —— 「必须保持一致」的
// 注释不是机制（quality-guidelines），改成同一个来源之后它们不可能再漂。
// （放在 vrsSrc 声明之后 —— ⚠ K14 曾经写在它前面，TDZ ReferenceError 直接把整份报告打断，
//   只看得到一个栈。这与本文件那段 null 安全的注释是同一条纪律：宁可断言报红，
//   也不要让脚本抛异常中断。）
const presetSrc = readFileSync(resolve(ROOT, 'src/shared/tts-preset.ts'), 'utf-8')
const soSrc = readFileSync(resolve(ROOT, 'src/renderer/src/speechOut.ts'), 'utf-8')
ok(
  /voice:\s*DEFAULT_TTS_VOICE/.test(vrsSrc) &&
    /voice:\s*DEFAULT_TTS_VOICE/.test(soSrc) &&
    /style:\s*DEFAULT_TTS_STYLE/.test(vrsSrc) &&
    /style:\s*DEFAULT_TTS_STYLE/.test(soSrc),
  'K14 预设表与 DEFAULT_TTS_CONFIG 的音色**和风格**都写成常量引用（各自一个字面量 = 两处会悄悄漂）'
)
ok(
  /export const DEFAULT_TTS_VOICE\s*=\s*'zh-CN-[A-Za-z]+'/.test(presetSrc),
  'K14b DEFAULT_TTS_VOICE 定义在 shared/tts-preset（单一出处的「那一份」）'
)

// 「单一出处」的反向断言：整个 src/ 里这个常量**只允许被声明一次**。
//
// ⚠ 上一版的 K14b 判的是「VoiceReminderSection 从 shared/tts-preset import 过东西」——
//   判的不是这个常量。在组件里本地 `const DEFAULT_TTS_VOICE = '…'` 把导入的名字遮住，
//   K14 与 K14b 一起全绿（已实测：红集 0），而「同一份数据只有一个家」这条纪律已经破了：
//   组件与 speechOut 各有一份字面量，改一处另一处不跟着动 —— 正是这次重构要消灭的东西。
//   数目断言挡住的是「多出第二份定义」这个失效模式，与谁遮住谁无关。
const voiceDeclSites = srcFilesUnder('src').filter((f) =>
  /(?:^|\n)\s*(?:export\s+)?const\s+DEFAULT_TTS_VOICE\s*=/.test(readFileSync(f, 'utf-8'))
)
ok(
  voiceDeclSites.length === 1 && voiceDeclSites[0].endsWith('shared/tts-preset.ts'),
  `K14c DEFAULT_TTS_VOICE 全仓只有一处声明且在 shared/tts-preset（实得 ${voiceDeclSites.length} 处：${
    voiceDeclSites.map((f) => f.replace(/^src\//, '')).join(', ') || '无'
  }）`
)
const styleDeclSites = srcFilesUnder('src').filter((f) =>
  /(?:^|\n)\s*(?:export\s+)?const\s+DEFAULT_TTS_STYLE\s*=/.test(readFileSync(f, 'utf-8'))
)
ok(
  styleDeclSites.length === 1 && styleDeclSites[0].endsWith('shared/tts-preset.ts'),
  `K14d DEFAULT_TTS_STYLE 同上（风格与音色是同一条纪律，实得 ${styleDeclSites.length} 处）`
)


// `extras:get` 对缺失的键返回 `''`，**不可能**返回 null / undefined。所以「这个键配过吗」
// 在这一层**只能**判 `!v` —— 判 `== null` / `typeof v === 'string'` 一定是错的，而且错得
// 悄无声息：迁移逻辑不触发、新用户落在「自定义服务」（地址为空 → 整个播报不工作）。
// 真实踩过两处，都在本文件的守卫之前就写好了。
//
// ⚠ 这是**静态门**，不是行为断言：真正的行为面在 --uitest 的 vrs* 段（那里能观察到
//   渲染出来的分支），但迁移读侧没有行为断言 —— 老实记着，别把它当行为覆盖。
const loadEffect = (() => {
  const from = appSrc.indexOf('void window.api.getExtras(KEYS)')
  if (from < 0) return null
  const end = appSrc.indexOf("}, [])", from)
  return end < 0 ? null : appSrc.slice(from, end)
})()
ok(loadEffect != null, 'K15a 前置：取得到 TTS 配置的加载 effect 源码（下面的负向断言不能空洞通过）')
ok(
  loadEffect != null && !/\[[^\]]*ui:tts[^\]]*\]\s*==\s*null/.test(loadEffect) &&
    !/typeof\s+e\['ui:tts[^']*'\]\s*===\s*'string'/.test(loadEffect),
  'K15 extras 读侧不用 null / undefined 判「键缺失」（extras:get 只给 \'\'；判错会让迁移与默认值静默失效）'
)

// ═══ L. 重复提醒直到确认（AC7）══════════════════════════════════════════════
// 状态机：**播 → 未确认则按间隔重复 → 确认（或超窗 / 条件解除）→ 停止**。
//
// 为什么这一段与 B 段（锁存）不是一件事：锁存管「同一条件下**首播恰好一次**」，
// 这里是「首播之后、确认之前**还要再播**」。少了 pending，只有 B 的话用户离开电脑边
// 只会听到一次 —— 那正是 AC7 要补的洞；少了 B，只有 pending 的话每 60s 数据推送
// 就会重播一遍（AC9 崩塌）。两道门必须都在。

console.log('\nL. 重复提醒直到确认（AC7）')

// 间隔/窗口取自被测源码本身，本文件不另写一份 5min/15min —— 数字改了这里会跟着红
ok(REPEAT_MS === 5 * 60_000, 'L0 重复间隔 = 5 分钟（用户裁定）')
ok(AUTO_CONFIRM_MS === 3 * REPEAT_MS, 'L0b 自动确认窗口 = 3 个重复周期（15 分钟）')
// ⚠ 这条是 AC7 能不能成立的前提，不是口味：窗口 ≤ 间隔时重复永远等不到，
//   「重复提醒直到确认」就退化成「播一次」
ok(AUTO_CONFIRM_MS > REPEAT_MS, 'L0c 自动确认窗口必须**大于**重复间隔（否则 AC7 是空功能）')

/** 把上一轮的输出接到下一轮：history / latched / pending 全部沿用上一轮的结果 */
const chain = (d, o = {}) => ({
  history: d?.nextHistory ?? [],
  latched: d?.nextLatched ?? [],
  pending: d?.nextPending ?? [],
  ...o
})

// ── AC1：首播后 5 分钟内再次播报同一条 ──────────────────────────────────────
const l1 = round({ snapshots: [cash(8)], now: T0 })
eq(reasonOf(l1), 'new', 'L1 首播 reason=new')
eq(pendText(pendingOf(l1)), ['DeepSeek 余额不足，剩余 8 元'], 'L2 首播开出一批待确认')
const l2 = round(chain(l1, { snapshots: [cash(7)], now: T0 + 2 * 60_000 }))
eq(reasonOf(l2), null, 'L3 还没到重复间隔 → 不播（数据每 60s 推一次）')
eq(pendingOf(l2).length, 1, 'L4 批次仍在待确认，只是没到重播时间')
// 余额在这 5 分钟里从 8 掉到 7：正是「重复时重算文案」会露馅的地方
const l3 = round(chain(l1, { snapshots: [cash(7)], now: T0 + REPEAT_MS }))
eq(reasonOf(l3), 'repeat', 'L5 满 5 分钟 → reason=repeat（AC1）')
eq(textOf(l3), textOf(l1), 'L6 重复的是**同一条原文**（不重算：余额变了也不会说成别的数）')
eq(pendingOf(l3)[0]?.firstSpokenAt, T0, 'L7 重复不推迟首播时刻（自动确认窗口从首播起算）')
eq(pendingOf(l3)[0]?.lastSpokenAt, T0 + REPEAT_MS, 'L8 只有 lastSpokenAt 被推进')
eq(pendingOf(l3).length, 1, 'L9 重复**不开新批次**（否则每 5 分钟多攒一条待确认）')

// ── AC2 / AC4：点「知道了」后立即停止；条件仍成立也不再播 ────────────────────
const confirmed = confirm(l1.nextPending, T0 + 90_000)
eq(confirmed[0]?.confirmedAt, T0 + 90_000, 'L10 confirm 给最近播的那批打上确认时刻')
eq(confirmed.length, 1, 'L11 confirm 不删批次（标记，等下一轮 evaluate 裁掉）')
const l4 = round(chain(l1, { pending: confirmed, snapshots: [cash(8)], now: T0 + REPEAT_MS }))
eq(textOf(l4), null, 'L12 确认后条件持续成立 → 永不再播（AC4）')
eq(pendingOf(l4), [], 'L13 已确认的批次被裁掉')
ok(latchOf(l4).length === 1, 'L14 确认**不**动锁存（否则确认一次就把 AC9 也一起解除了）')

// ── AC3：倒计时到期自动确认 ────────────────────────────────────────────────
const l5 = round(chain(l1, { snapshots: [cash(8)], now: T0 + AUTO_CONFIRM_MS }))
eq(textOf(l5), null, 'L15 到自动确认窗口 → 不再重复（AC3）')
eq(pendingOf(l5), [], 'L16 超窗批次被裁掉')
eq(latchOf(l5), ['cash balance'], 'L17 自动确认≠解锁：条件还成立，锁存保持（否则每 15 分钟重开一轮）')

// ── AC5：条件解除后重新越过阈值能再播（与 AC4 相反，两条都必须有）────────────
const noWave = { ...ALL_ON, fluctuation: false }
const m1 = round(chain(l1, { snapshots: [cash(50)], triggerOn: noWave, now: T0 + 10 * 60_000 }))
eq(pendingOf(m1), [], 'L18 条件解除（充值）→ 待确认批次作废，不再重复提醒')
eq(latchOf(m1), [], 'L19 锁存随之清掉')
// 「解除即作废」的**另一半**：余额早就回到阈值以上，绝不能再拿「余额不足，剩余 8 元」
// 这句旧文案重播。L18 只验了「批次没了」，这两条验的是「它确实不会再张嘴」——
// 且时间刻意落在 15 分钟窗口**之内**：落在窗口外的话，超窗裁剪会替它把 bug 遮掉
eq(textOf(m1), null, 'L19b 条件解除的那一轮不重播旧文案（仍在自动确认窗口之内）')
eq(reasonOf(m1), null, 'L19c 同上：reason 也必须是 null（不是「到期重复」）')
const m2 = round(chain(m1, { snapshots: [cash(8)], triggerOn: noWave, now: T0 + 20 * 60_000 }))
eq(reasonOf(m2), 'new', 'L20 再次越过阈值 → 又是一轮「新命中」（AC5）')
eq(pendText(pendingOf(m2)), ['DeepSeek 余额不足，剩余 8 元'], 'L21 重新开一批待确认')

// ── AC6 / AC9：紧急与例行各自独立待确认；倒计时期间的新命中立即播 ───────────
const n0 = round({ snapshots: [cash(8)], triggerOn: noWave, now: T0 })
const n1 = round(chain(n0, { snapshots: [cash(8), goHigh], now: T0 + 2 * 60_000 }))
eq(pendingOf(n1).length, 2, 'L22 余额预警与用量耗尽各自成批（FR7 / AC6）')
eq(
  pendText(pendingOf(n1)),
  ['DeepSeek 余额不足，剩余 8 元', 'Go 用量已用 95%'],
  'L23 新命中只播**新增的那部分**（已锁存的余额预警不跟着重念）'
)
eq(latestPending(n1.nextPending)?.text, 'Go 用量已用 95%', 'L24 确认条指向最近播的那一批')
eq(pendingOf(n1)[1]?.firstSpokenAt, T0 + 2 * 60_000, 'L25 倒计时期间出现新命中 → 立即开新批次，从那一刻起算窗口（AC9）')
eq(pendingOf(n1)[0]?.firstSpokenAt, T0, 'L26 旧批次的计时不被新命中重置（FR8 重置的是新批次自己）')
const n2 = confirm(n1.nextPending, T0 + 3 * 60_000)
// confirm 的目标是**最近播的那批**（= Go 那批，用户刚听到的是它）。所以：
//   · Go 批被打上确认时刻，DeepSeek 批原封不动
//   · 下一轮该重复的是**剩下**那批 —— 确认余额预警没有误伤，额度耗尽的提醒还在继续
// 这组断言合起来正是「confirm 清掉全部批次而非指定的那一批」这个变异的红集
eq(n2.length, 2, 'L27 confirm 不删批次：两批都还在，只有被点的那批被标记')
eq(n2[1]?.confirmedAt, T0 + 3 * 60_000, 'L28 被点的那批（最近播的 Go）打上确认时刻')
eq(n2[0]?.confirmedAt, null, 'L29 另一批（余额预警）的确认态没被动过 —— AC6')
const n3 = round(chain(n1, { pending: n2, snapshots: [cash(8), goHigh], now: T0 + 7 * 60_000 }))
eq(textOf(n3), 'DeepSeek 余额不足，剩余 8 元', 'L30 剩下那批到点照常重复（确认没有误伤）')
eq(pendingOf(n3).length, 1, 'L31 下一轮把已确认的那批裁掉，留下的继续计时')
eq(latestPending(pendingOf(n3))?.text, 'DeepSeek 余额不足，剩余 8 元', 'L32 确认条切回剩下的那批')

// ── AC7：重复播报受频率闸门约束 ───────────────────────────────────────────
// 闸门本身在 speechOut（1 次/分钟、10 次/小时，scripts/test-speech-out.mjs 已覆盖）。
// 编排层只答「该不该播」，**不许**为了重复提醒另开一条绕过 allowCall 的路（NFR1）。
eq(
  reasonOf(round(chain(l1, { snapshots: [cash(8)], now: T0 + 60_000 }))),
  null,
  'L33 首播后 1 分钟内的第二次触发不重复（重复间隔是 5 分钟）'
)
ok(
  (appSrc.match(/\benqueue\(/g) || []).length === 1,
  'L34 App 全程只在 speakOut 里 enqueue 一次（重复播报没有第二条绕过频率闸门的路）'
)
// speakOut 第三个参数是 bill（是否计入配额）：预警/重复播报必须计费（bill=true），
// 否则频率闸门形同虚设，10 次/小时的白嫖保护就没了。测试播报才传 false。
ok(
  evalBody != null && /speakOut\(\s*d\.text,\s*d\.urgent,\s*true\s*\)/.test(evalBody),
  'L35 新命中与到期重复共用同一个播报出口，且计费（bill=true，频率闸门不得被绕开）'
)

// ── AC8：待确认状态不持久化（重启即重置）──────────────────────────────────
const extrasCalls = appSrc.match(/setExtras\(\s*\{[^}]*\}/g) || []
ok(extrasCalls.length > 0, 'L36 前置：App 里确实有 setExtras 调用（下面的负向断言不能空洞通过）')
ok(!extrasCalls.some((c) => /pending|alert/i.test(c)), 'L37 待确认状态不进 extras（重启即重置，NFR4）')
ok(!/ui:[A-Za-z]*pending/i.test(appSrc), 'L38 extras 键表里没有 pending 相关键')
ok(
  /alertPendingRef\s*=\s*useRef/.test(appSrc) && /const \[alertPending, setAlertPending\] = useState/.test(appSrc),
  'L39 待确认是内存态（ref 给编排读、state 给渲染），不是从 extras 读回来的'
)

// ── 倒计时取值（给 UI 用的那个数）─────────────────────────────────────────
const cdOf = (b, now) => (b ? pendingCountdown(b, now) : -1)
ok(pendingOf(l3)[0] != null, 'L40 前置：l3 确实有批次在待确认（否则下面在比 -1）')
const l3b = pendingOf(l3)[0]
eq(cdOf(l3b, T0), AUTO_CONFIRM_MS / 1000, 'L41 倒计时从**首播**起算')
eq(cdOf(l3b, T0 + REPEAT_MS), (AUTO_CONFIRM_MS - REPEAT_MS) / 1000, 'L42 重复之后按剩余窗口走（不是重新给 15 分钟）')
eq(cdOf(l3b, T0 + AUTO_CONFIRM_MS), 0, 'L43 到点为 0')
eq(cdOf(l3b, T0 + AUTO_CONFIRM_MS + 60_000), 0, 'L44 超时之后钳在 0，不出现负数')

// ── 确认气泡的那一句（confirmLine：把截断问题从根上解决）───────────────────────
//
// 原实现把播报原文原样塞进 190px 的条子配 text-overflow:ellipsis，长句必然被截成
// "OpenCode Go …" —— 而「余额不足」「已用 92%」这类最该看见的都在省略号里。
// 完整内容已经由 TTS 念给耳朵了，气泡只承担「这条提醒是关于什么」的标题。
// 判据全部对着上面 L32 那句真实文案验：它就是当时被截断的那条。
eq(confirmLine('Go 用量已用 95%'), 'Go 用量已用 95%', 'L51 短句原样返回（没有它就不该动）')
eq(
  confirmLine('DeepSeek 余额不足，剩余 8 元'),
  'DeepSeek 余额不足，剩余 8 元',
  'L52 两段的明细也原样返回（「余额不足」与「剩余 8 元」缺一不可，砍掉金额等于删了结论）'
)
eq(
  confirmLine('DeepSeek 余额不足，剩余 8 元，已 6 小时无变化'),
  'DeepSeek 余额不足，剩余 8 元',
  'L53 超宽时在逗号处收口（不在逗号中间硬砍，砍出来仍是完整短语）'
)
// 边界逗号：整句「DeepSeek 余额不足，剩余 8 元」按这里的估算正好 168px、顶格装下。
// 加个尾巴之后必须从**第二个逗号**前面砍，而不是第一个 —— 砍成「DeepSeek 余额不足」
// 就把金额这个最该看见的结论丢了。反验时循环把逗号记在超宽判断之后，就是踩这个坑。
eq(
  confirmLine('DeepSeek 余额不足，剩余 8 元，剩余额度'),
  'DeepSeek 余额不足，剩余 8 元',
  'L53b 顶到边界的逗号也算切割点（不能因为「装不下逗号」就退回到上一个逗号）'
)
eq(
  confirmLine('DeepSeek 余额不足，剩余 8 元，已 6 小时无变化', 1000),
  'DeepSeek 余额不足，剩余 8 元，已 6 小时无变化',
  'L54 宽度够宽时不截（宽度是显示口径，不是语义边界）'
)
// 收口按**像素宽度**而不是字符数 —— 供应商名是拉丁、明细是中文，同字符数宽度差一半。
// 这条钉死那个错误做法：按 24 字符一刀切会把下面这句砍成「OpenCode Go 余额不足」，
// 丢掉金额这个最该看见的结论。
eq(
  confirmLine('OpenCode Go 用量已用 92%'),
  'OpenCode Go 用量已用 92%',
  'L59 20 个字符但只占约 148px：混排按像素算才装得下（按字符预算会误砍）'
)
eq(
  confirmLine('OpenCode Go 余额不足，剩余 12 元，已 6 小时无变化，用量高于历史均值'),
  'OpenCode Go 余额不足',
  'L60 供应商名长到吃满预算时在逗号处收口（宁可少说一句金额，也不留半句）'
)
// 供应商名本身可能带空格（「OpenCode Go」），所以不能按空格切分供应商与明细 —— 这条钉死它。
eq(
  confirmLine('OpenCode Go 已 6 小时无变化，用量高于历史均值'),
  'OpenCode Go 已 6 小时无变化',
  'L61 供应商名内含空格也不受影响（不能按空格切，会切在「OpenCode」后面）'
)
eq(confirmLine(''), '', 'L55 空串返回空串（App 用它判「有没有待确认」）')
eq(confirmLine('  '), '', 'L56 纯空白返回空串')
// 预算内没有逗号就不硬砍：砍出一个半句比一句完整的话更糟。交给 CSS 的 nowrap 兜底。
eq(
  confirmLine('这是一个超过预算但没有逗号分隔的一整句话内容很多', 40),
  '这是一个超过预算但没有逗号分隔的一整句话内容很多',
  'L58 宽度内无逗号时原样返回（不硬砍出半句）'
)

// ── 接缝：重复节奏 vs 频率闸门（跨模块，两边的数字谁都不知道对方）───────────
//
// 编排层答「该不该播」，speechOut 的闸门答「允不允许播」。两边的数字在**不同模块**里，
// 没有任何一层代码看得见它们的相容性（重复走同一条 speakOut，闸门也在那里，但
// 「重复 5 分钟一次」与「每小时最多 10 次」谁也没跟谁对过账）。
//
// 出问题时的症状特别安静：闸门把某次重复挡掉 → 编排照样推进 lastSpokenAt →
// 倒计时照走、确认条照显，用户却**什么都听不到**。L33 只验了 1 分钟内不重复，
// 没有验过「整段 AC7 周期不会被闸门吃光」。

// 一个未确认批次在整个自动确认窗口内最多发出几次：首播 1 次 + 每个重复间隔 1 次
const perBatch = 1 + Math.floor(AUTO_CONFIRM_MS / REPEAT_MS)
ok(
  REPEAT_MS >= RATE_LIMIT.MAX_PER_MINUTE * 60_000,
  `L33b 重复间隔（${REPEAT_MS / 60_000} 分钟）≥ 分钟闸门（${RATE_LIMIT.MAX_PER_MINUTE} 次/分钟）：否则重复永远被闸门挡在门外`
)
ok(
  perBatch <= RATE_LIMIT.MAX_PER_HOUR,
  `L33c 单个未确认批次最多 ${perBatch} 次播报 ≤ 小时闸门 ${RATE_LIMIT.MAX_PER_HOUR} 次/小时（否则 AC7 会被静默吃光）`
)
// 同一时刻可能挂着几批？L22/L27 明确要求「余额预警」与「用量耗尽」各自成批、互不确认，
// 所以至少要容得下 2 批不互相挤掉。这条是那两条的行为侧前提。
const concurrentBatches = Math.floor(RATE_LIMIT.MAX_PER_HOUR / perBatch)
ok(
  concurrentBatches >= 2,
  `L33d 小时闸门至少容得下 2 个并发待确认批次（实得 ${concurrentBatches}；L22/L27 要求两批各自独立重复）`
)

// ── 接线：轮询链 / 确认回调 / props ───────────────────────────────────────
const alertEffectAt = appSrc.indexOf('const armAlertTimer')
const alertEffectEnd = appSrc.indexOf('}, [ttsOn])', alertEffectAt)
const alertEffect = alertEffectAt < 0 || alertEffectEnd < 0 ? null : appSrc.slice(alertEffectAt, alertEffectEnd)
ok(alertEffect != null, 'L45 取得到待确认轮询 effect 的源码')
ok(
  alertEffect != null && (alertEffect.match(/setTimeout\(/g) || []).length === 1,
  'L46 重复播报与倒计时共用**同一条** setTimeout 链，不新增独立定时器（NFR2）'
)
ok(
  alertEffect != null && (alertEffect.match(/armAlertTimer\(\)/g) || []).length >= 2,
  'L47 那条链是自重排的（回调里重新排下一次，不是跑一次就完）'
)
ok(
  /}, \[ttsOn\]\)/.test(appSrc.slice(alertEffectEnd, alertEffectEnd + 20)),
  'L48 轮询 effect 的依赖数组**只含** [ttsOn]（定时器契约，见 state-management.md）'
)
ok(
  /confirm\(alertPendingRef\.current, Date\.now\(\)\)/.test(appSrc),
  'L49 onConfirmAlert 走纯函数的 confirm()，不在组件里手搓一份状态机'
)
ok(
  /alertText=\{alertText\}/.test(appSrc) && /onConfirmAlert=\{onConfirmAlert\}/.test(appSrc),
  'L50 确认条与回调从 App 接到 PetBall（props 链没断）'
)

// ═══ M. 系统通知编排（P0-1 / design.md 第 8-9 条）═══════════════════════════
// 通知判定本身归 test-system-notify.mjs；这里只答**编排层**的那三件事：
//   · 通知跑在**同一条时间线**上（复用 snapshots / now，不另起轮询）
//   · 通知只在「新命中」时弹，到期重复不弹（通知栏不是聊天框）
//   · nextNotifyLatched 只记**真弹出去的那条**（没弹的不锁存）

console.log('\nM. 系统通知编排（P0-1：第二个输出通道，同一条时间线）')

/**
 * 套餐型且用量率够高的快照：唯一会让通知命中的数据。
 *
 * ⚠ `percent` 必须**显式给**：本文件既有的 `win()` 夹具带着 `percent: 0`，
 *   而 `windowPercent` 对 percent 有值时**优先用它**（types.ts:29 说明了理由：
 *   官方直报比 used/limit 推算更精确）。只传 used/limit 的话算出来是 0%，
 *   通知永不命中 —— 写这条注释是因为它已经让 M2/M13/M14 报红过一次。
 */
const nofifySnap = (pct, o = {}) =>
  snap({ id: 'go', name: 'Go', kind: 'coding', windows: [win({ used: pct, limit: 100, percent: pct })], ...o })

// 阈值与播报不同：播报 exhaustionPct=90，通知 pctWarn=80。所以 pct=85 时
// **播报不响、通知要响** —— 这一条正是两个通道互不干扰的判据。
eq(
  DEFAULT_TRIGGER_CONFIG.exhaustionPct,
  90,
  'M0a 前置：播报耗尽阈值 = 90%（与通知的 80% 不同档，两个通道各配各的）'
)
eq(DEFAULT_NOTIFY_CONFIG.pctWarn, 80, 'M0b 通知提醒阈值 = 80%')

const nfy1 = round({ snapshots: [nofifySnap(85)], triggerOn: { ...ALL_ON, exhaustion: false }, now: T0 })
eq(textOf(nfy1), null, 'M1 85% 且播报侧关掉耗尽场景 → 不播报')
eq(notifyOf(nfy1)?.level, 'warn', 'M2 同一份数据 → 通知照弹（播报关了不影响通知）')
eq(notifyOf(nfy1)?.id, 'go', 'M3 通知带上供应商 id（锁存键的组成部分）')
eq(nlatchOf(nfy1), ['notify:go:warn'], 'M4 nextNotifyLatched 记下本轮弹出的那一条')
// 反向对照：把 pct 抬到播报阈值之上（96 > 90），播报通道就响了 ——
// 证明 M1 的「不播」来自 triggerOn 与两个通道的阈值差，不是这份数据在播报侧永远静默。
//
// ⚠ 用 detailed 而非 simple：96% 配 limit=100 会让「余额不足，剩余 4 元」也命中，
//   而余额的 TRIGGER_RANK 是 0（最高优先级），simple 模式只念它那一条 ——
//   拿 simple 断言「播报内容是耗尽那句」会红，而那条红与本段要验的无关。
eq(textOf(round({ snapshots: [nofifySnap(96)], format: 'detailed', now: T0 })),
  'Go 余额不足，剩余 4 元，用量已用 96%',
  'M5 对照：96%（越过播报阈值 90%）时播报照响')
eq(notifyOf(round({ snapshots: [nofifySnap(96)], now: T0 }))?.level, 'high',
  'M5b 96% 时通知升到 high 档（越过 pctHigh=95）—— 两个通道各按各的阈值判')

// 去重：条件持续成立期间只弹一次
const nfy2 = round({
  snapshots: [nofifySnap(85)],
  triggerOn: { ...ALL_ON, exhaustion: false },
  notifyLatched: nfy1?.nextNotifyLatched ?? [],
  now: T0 + HOUR
})
eq(notifyOf(nfy2), null, 'M6 条件仍成立 → 不再弹（数据每 60s 推一次，不锁存就是每分钟弹一次）')
eq(nlatchOf(nfy2), ['notify:go:warn'], 'M7 锁存保持')

// 条件解除 → 键消失 → 再次越过要能重新弹（AC5）
const nfy3 = round({
  snapshots: [nofifySnap(10)],
  triggerOn: { ...ALL_ON, exhaustion: false },
  notifyLatched: nfy2?.nextNotifyLatched ?? [],
  now: T0 + 2 * HOUR
})
eq(nlatchOf(nfy3), [], 'M8 条件解除 → 通知锁存随之清掉（锁存的是「弹过」不是「发生过」）')
const nfy4 = round({
  snapshots: [nofifySnap(85)],
  triggerOn: { ...ALL_ON, exhaustion: false },
  notifyLatched: nfy3?.nextNotifyLatched ?? [],
  now: T0 + 3 * HOUR
})
eq(notifyOf(nfy4)?.level, 'warn', 'M9 再次越过 → 重新弹（充了额度又花光仍要看得见）')

// 总开关：关掉时整段判定跳过，且不产生新锁存
const mOff = round({ snapshots: [nofifySnap(85)], notifyOn: false, now: T0 })
eq(notifyOf(mOff), null, 'M10 notifyOn=false → 不弹（与 TTS 开关各管各的）')
eq(nlatchOf(mOff), [], 'M11 开关关着时不新增锁存（否则开回来会以为用户已经看过）')

// 无快照的整轮不产生任何通知字段
eq(round({ snapshots: [], now: T0 }), null, 'M12 整轮无快照 → 仍返回 null（不弹不锁存，与 TTS 同规则）')

// 静音只挡播报、不挡通知：mute 的语义是「别**念**给我听」，不是「别提醒我」。
// 取 96% 这份数据，让播报侧本来就会响 —— 否则「静音后不播」是空洞的
// （85% 在播报侧本就静默，这条断言证明不了静音起了作用）。
const mMute = round({ snapshots: [nofifySnap(96)], format: 'detailed', now: T0 })
eq(textOf(mMute), 'Go 余额不足，剩余 4 元，用量已用 96%', 'M13a 前置：不静音时这份数据会播报（否则下面两条是空洞的）')
const mMute2 = round({ snapshots: [nofifySnap(96)], muted: ['go'], format: 'detailed', now: T0 })
eq(textOf(mMute2), null, 'M13b 静音 → 播报被挡下')
eq(notifyOf(mMute2)?.level, 'high', 'M14 同一份数据仍弹通知（静音是语音语义，不是通知语义）')

// 多供应商同时越线：通知一轮只出一条（先弹最严重的那家），**其余的必须排队**，
// 不能被记成「弹过了」—— 那是谎称用户已经看过，第二家会被永久吞掉。
// 这组是返工补上的：首版把「本轮仍然成立的候选」整份记进 nextNotifyLatched。
const two = (a, b, o = {}) =>
  round({ snapshots: [nofifySnap(a), nofifySnap(b, { id: 'nd', name: 'ND' })], now: T0, ...o })
const q1 = two(96, 85, { triggerOn: { ...ALL_ON, exhaustion: false } })
eq(notifyOf(q1)?.id, 'go', 'M40 第一轮弹更严重的那家（96% 的 high）')
eq(nlatchOf(q1), ['notify:go:high'], 'M41 锁存里**只有真弹过的那一条**（nd 还没轮到）')
const q2 = two(96, 85, { triggerOn: { ...ALL_ON, exhaustion: false }, notifyLatched: q1?.nextNotifyLatched })
eq(notifyOf(q2)?.id, 'nd', 'M42 第二轮轮到 nd（85% 的 warn）—— 没弹过的那条没有被吞掉')
eq(nlatchOf(q2), ['notify:go:high', 'notify:nd:warn'], 'M43 两条都在锁存里')
const q3 = two(96, 85, { triggerOn: { ...ALL_ON, exhaustion: false }, notifyLatched: q2?.nextNotifyLatched })
eq(notifyOf(q3), null, 'M44 第三轮两家都弹过了 → 静默（不是 A/B 交替刷屏）')
// 反向：条件解除后锁存要清空，否则回落复位失效（AC5）
const q4 = round({
  snapshots: [nofifySnap(5), nofifySnap(5, { id: 'nd', name: 'ND' })],
  notifyLatched: q2?.nextNotifyLatched ?? [],
  now: T0 + HOUR
})
eq(nlatchOf(q4), [], 'M45 两家都回落到阈值以下 → 锁存清空（AC5 复位）')

console.log('\nM2. App 侧接线：锁存写回 + IPC 调用（静态守卫）')

ok(evalBody != null && /notifyLatchRef\.current\s*=/.test(evalBody),
  'M20 通知锁存必须被写回（漏了这一句就退回「每 30s 弹一次同一条」）')
ok(evalBody != null && /window\.api\.notifyShow\(\s*d\.notify\s*\)/.test(evalBody),
  'M21 Decision.notify 直接喂给 notify:show（中间不重新判一次阈值）')
// 30s 轮询那一路常常一次渲染都不产生：镜像不回填就等于没锁存
ok(evalBody != null && /ctx\.notifyLatched\s*=/.test(evalBody),
  'M22 通知锁存回填 alertCtxRef 镜像（轮询那一路不产生渲染，不回填就拿旧锁存去判）')
// 通知与播报共用同一份快照：不能在 App 侧另起一个轮询单独跑一遍
ok(evalBody != null && /checkNotify|checkTriggers/.test(evalBody) === false,
  'M23 evaluateAlerts 内没有残留通知判定细节（编排全在纯函数里）')
// extras 键表里必须有这两个键，且都用 ui: 前缀（避免触发全量重采集）
const appKeys = appSrc.slice(appSrc.indexOf('const KEYS = ['), appSrc.indexOf('].', appSrc.indexOf('const KEYS = [')))
ok(/'ui:notifyOn'/.test(appKeys), 'M24 extras 键表含 ui:notifyOn')
ok(/'ui:notifyConfig'/.test(appKeys), 'M25 extras 键表含 ui:notifyConfig')
// 判据必须盯住**带前缀的那一份**：剥掉 ui: 再找同名键是「找得到就算过」，
// 而剥前缀之后 `notifyOn':` 必然还在（键名后半段没变）—— 上一版就是这么写的，
// 它在正例下也报红。正确判据是「App 里不存在不带 ui: 前缀的 notify 键」。
const bareNotifyKeys = (appSrc.match(/'(?:ui:)?notify(?:On|Config)'/g) || []).filter(
  (k) => !k.startsWith("'ui:")
)
eq(bareNotifyKeys, [], 'M26 两个键都带 ui: 前缀（不带会触发全量重采集，ipc.ts:218-223）')
// 判「键缺失」只能判 !v：extras:get 对不存在的键返回 ''（K15 的同款纪律）
ok(
  /raw\('ui:notifyOn'\)\s*!==\s*'0'/.test(appSrc),
  'M27 通知开关按「不是 0 就是开」判（判 == null 恒为假，新用户会拿到 undefined 而非 true）'
)
// 设置页的开关入口必须在 {ttsOn && …} 之外：放进去的话关语音会顺手藏掉通知设置
const vrsNotifyAt = vrsSrc.indexOf('vrs-notify-on')
ok(vrsNotifyAt > 0, 'M28 设置页有系统通知分组（vrs-notify-on 定位钩子）')
const ttsGate = vrsSrc.indexOf('{ttsOn && (')
ok(
  vrsNotifyAt > ttsGate,
  'M29 通知分组在 {ttsOn && …} 之外（放进去的话「关掉语音」会顺手藏掉通知设置入口）'
)

// ═══ M3. 两个开关必须真的独立：评估那一路不能只被 ttsOn 叫醒 ═══════════════
//
// 这组是**返工补上的**：首版把「① 数据一变化就评估一次」那个 useEffect 的早退写成
// `if (!ttsOn) return`，而 ttsOn 出厂默认**关**（App.tsx 的 useState(false)）、
// notifyOn 出厂默认**开** —— 于是安装这份代码的每一个用户（也就是全部用户）一条
// 通知都收不到，设置页那个开关还亮着、怎么点都没反应。**没有任何一条断言报红**：
// 纯函数侧全绿（M 段验的是 evaluate，而 evaluate 本身是对的），typered 绿，
// 唯一能看见它的是「关掉语音之后还收不收得到通知」。
//
// 两条方向相反的漏洞都要堵住，所以下面四条成对：
//   · 评估那一路的早退要认 notifyOn（否则 = 上面那个 bug）
//   · evaluateAlerts 里的早退要认 ctx.ttsOn（否则反过来：语音关了照样出声）
//   · 且通知的副作用必须排在 TTS 早退**之前**（顺序反了 = 第一个漏洞换个写法复活）
// ⚠ 切片要**越过** `state.snapshots])` 这个串本身（它是依赖数组的末尾），否则依赖数组
//   被切在窗口外，M30c 就成了一条永远红的断言。
const pushSnapAt = appSrc.indexOf('state.snapshots])')
const pushEnd = pushSnapAt > 0 ? pushSnapAt + 'state.snapshots])'.length : -1
const pushStart = pushEnd > 0 ? appSrc.lastIndexOf('useEffect(', pushEnd) : -1
const pushEffect = pushStart > 0 && pushEnd > pushStart ? appSrc.slice(pushStart, pushEnd) : ''
ok(pushEffect.length > 0, 'M30a 前置：取得到「数据一变化就评估一次」那个 useEffect')
ok(
  /if \(!ttsOn && !notifyOn\) return/.test(pushEffect),
  'M30b 数据推送那一路同时认两个开关（只认 ttsOn 的话：ttsOn 默认关 → 通知永不弹）'
)
ok(
  /\[ttsOn, notifyOn, state\.snapshots\]/.test(pushEffect),
  'M30c 依赖里有 notifyOn（开关本身的变化要能叫醒这一轮，否则打开开关后要等下一次采集）'
)
// 反向：语音关着时不得播、也不得产生待确认批次（确认条不认 ttsOn，会出现「从没听过」的确认条）
const ttsEarlyReturn = /if \(!ctx\.ttsOn\) return false/.test(evalBody)
ok(ttsEarlyReturn, 'M31a evaluateAlerts 里 TTS 侧有总开关早退（否则关语音后 evaluateAlerts 仍会播）')
const notifyCallAt = evalBody.indexOf('window.api.notifyShow')
const ttsGateAt = evalBody.indexOf('!ctx.ttsOn')
ok(
  notifyCallAt > 0 && ttsGateAt > 0 && notifyCallAt < ttsGateAt,
  'M31b 通知副作用排在 TTS 早退之前（顺序反了 = 「关语音后通知静默失效」换个写法复活）'
)
const latchAt = evalBody.indexOf('notifyLatchRef.current')
ok(
  latchAt > 0 && latchAt < ttsGateAt,
  'M31c 通知锁存写回也在早退之前（只弹不锁存 = 每 30s 弹一次同一条）'
)

// ── UI：确认条是泡泡的**兄弟节点**，不是泡泡的子节点 ────────────────────────
const petSrc = readFileSync(resolve(ROOT, 'src/renderer/src/PetBall.tsx'), 'utf-8')

/**
 * 从 `from` 处最近的 `<div` 起，按开闭配对取出**整个**元素的源码（含收尾 `</div>`）。
 *
 * ⚠ 边界必须来自**结构**，不能来自内容。反向验证实测过两处：
 *   ① 用 `{notice || bubble}` 当结束标记的那版，在「把确认条搬进泡泡内部、放在那句话
 *      **之后**」这个真实变异下**全绿** —— 切片压根没覆盖到确认条；
 *   ② `<div` 用 indexOf 向前找也不对：`from` 是 `className="petball-bubble"` 的位置，
 *      **已经在那个开标签里面**，向前找只会找到**下一个** div（确认条自己），于是
 *      「泡泡的块」变成了确认条的块，L53 恒红 —— 假红和上面那个假绿一样有害。
 *   所以要**向前**找最近的那个 `<div`。自闭合的 `<div … />`（本文件的 .petball-stage
 *   就是）不参与配对计数，否则后面的层级会算错。
 */
function jsxDivBlock(src, from) {
  const start = src.lastIndexOf('<div', from)
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src.startsWith('<div', i)) {
      const tagEnd = src.indexOf('>', i)
      if (tagEnd < 0) return null
      if (src[tagEnd - 1] !== '/') depth++
      i = tagEnd
    } else if (src.startsWith('</div>', i)) {
      depth--
      i += 5
      if (depth === 0) return { text: src.slice(start, i + 1), end: i + 1 }
    }
  }
  return null
}

const bubbleAt = petSrc.indexOf('className="petball-bubble"')
const bubbleBlock = jsxDivBlock(petSrc, bubbleAt)
ok(bubbleBlock != null, 'L51 前置：取得到 .petball-bubble 的整个 JSX 元素')
ok(bubbleBlock != null && /aria-hidden="true"/.test(bubbleBlock.text), 'L52 泡泡仍是 aria-hidden 的纯装饰')
ok(
  bubbleBlock != null && !/petball-confirm|<button/.test(bubbleBlock.text),
  'L53 泡泡内**没有**交互元素（确认条绝不能塞进 aria-hidden 容器）'
)

const confirmAt = petSrc.indexOf('className="petball-confirm"')
// 结束位置取「下一个同层级的 `{` 兄弟」（6 空格缩进）。取不到就一路读到文件尾 ——
// 正向断言（role/button）仍然成立，作用域只会变宽不会变松
const confirmEnd = confirmAt < 0 ? -1 : petSrc.indexOf('\n      {', confirmAt)
const confirmBlock = confirmAt < 0 ? null : petSrc.slice(confirmAt, confirmEnd < 0 ? undefined : confirmEnd)
ok(confirmBlock != null, 'L54 取得到确认条的 JSX 片段')
ok(confirmBlock != null && /role="status"/.test(confirmBlock), 'L55 确认条带 role="status"（它是活的通知，不是装饰）')
ok(
  confirmBlock != null && /<button[\s\S]*?type="button"[\s\S]*?onClick/.test(confirmBlock),
  'L56 确认条里是真实的 <button type="button" onClick>（不是 div 模拟的）'
)
// 关键：确认条**容器自己**不能是 aria-hidden —— 那样整条（含按钮）对辅助技术就不可见了。
// 内部那一格倒计时带 aria-hidden 反而是有意的：它每 30s 变一次，live region 会把
// 「还剩 14 分 / 13 分 / 12 分」一句句念出来。所以这里只钉容器，不钉整块片段。
// ⚠ 开标签要从 `<div` 取起，不能从 `className=` 起：属性顺序变了就会漏检。
// 反向验证实测过 —— 把 `aria-hidden="true"` 写在 `className` **之前**，从 className 切片的那版
// 恒绿，L58 变成一个守不住「容器是装饰」的空断言。从 `<div` 起才是完整的开标签。
const confirmTagStart = confirmAt < 0 ? -1 : petSrc.lastIndexOf('<div', confirmAt)
const confirmOpenTag =
  confirmAt < 0 || confirmTagStart < 0 ? null : petSrc.slice(confirmTagStart, petSrc.indexOf('>', confirmTagStart) + 1)
ok(confirmOpenTag != null, 'L57 取得到确认条容器的开标签')
ok(confirmOpenTag != null && !/aria-hidden/.test(confirmOpenTag), 'L58 确认条容器不是 aria-hidden（否则按钮对辅助技术不可见）')
// 落在泡泡元素**之外**才是兄弟节点。与 L53 互补：L53 盯「泡泡里没有它」，
// 这一条盯「它确实在泡泡元素结束之后」，两者一起把「塞进去」与「整条删掉」都变红
ok(
  bubbleBlock != null && confirmAt > bubbleAt && confirmAt >= bubbleBlock.end,
  'L59 确认条落在 .petball-bubble 元素之外（兄弟节点，不是它的子节点）'
)
// ── 2026-09-30 重设计：气泡形态、有语义的倒计时、可点的按钮 ──────────────────
ok(
  confirmOpenTag != null && /ref=\{confirmRef\}/.test(confirmOpenTag),
  'L60 确认条容器带 confirmRef（命中区要靠实测它的矩形，没 ref 就量不到）'
)
ok(
  confirmBlock != null && /<button[\s\S]*?aria-label=/.test(confirmBlock),
  'L61 按钮带 aria-label（可见文案只有「好的」两个字，屏幕阅读器念不出来）'
)
ok(
  confirmBlock != null && />\s*好的\s*</.test(confirmBlock),
  'L62 按钮文案是「好的」（「知道了」是系统弹窗口吻，放在 2D 小圆环旁边格格不入）'
)
ok(
  confirmBlock != null && /不再提示/.test(confirmBlock),
  'L63 倒计时有语义（原先只写「15 分」，没人知道那是什么意思；现在说清「X 分钟后不再提示」）'
)
// 命中区并入：确认气泡在环**上方**、落在圆环主体矩形之外。主进程只按上报的那一个
// 矩形决定窗口哪块收鼠标（overlay.ts 的 cursorInsideHit），不并进就是「画得出、点不动」。
const reportAt = petSrc.indexOf('const reportHit = useCallback')
const reportEnd = reportAt < 0 ? -1 : petSrc.indexOf('}, [])', reportAt)
const reportBlock = reportAt < 0 || reportEnd < 0 ? null : petSrc.slice(reportAt, reportEnd)
ok(reportBlock != null, 'L64 前置：取得到 reportHit 的源码')
ok(
  reportBlock != null && /confirmRef\.current/.test(reportBlock) && /getBoundingClientRect\(\)/.test(reportBlock),
  'L65 命中区会读确认条的实测矩形（它超出圆环主体，不并进就点不动）'
)
ok(
  reportBlock != null &&
    /Math\.min\(box\.x, o\.x\)/.test(reportBlock) &&
    /Math\.max\(box\.y \+ box\.height/.test(reportBlock) &&
    /setPetHitbox\(box\)/.test(reportBlock),
  'L66 报给主进程的是**并入**后的矩形（union，不是只报气泡、也不是只报圆环）'
)
// 有确认气泡时不渲染普通语音泡泡：两者共用同一位置，而 notice 的内容就是刚播完那句
// TTS 的视觉回声，确认气泡里已经是它的收敛版。一起画会叠在一起。
// 人物形态下线后问候泡泡（bubble 状态）已删除，只剩 notice。
ok(
  /\{\s*!alertText && notice\s*&&/.test(petSrc),
  'L67 有确认气泡时普通语音泡泡让位（同一位置，可点的那条优先）'
)
ok(
  /confirmLine\(alert\.text\)/.test(appSrc),
  'L68 App 侧把播报原文过 confirmLine 再给气泡（原文可能拼好几条明细，直接给必然 ellipsis 截断）'
)

// ── 样式：复用 token、够得着的点击区、不许 outer box-shadow ────────────────
const cssSrc = readFileSync(resolve(ROOT, 'src/renderer/src/skins.css'), 'utf-8')
function cssBody(src, sel) {
  const i = src.indexOf(`${sel} {`)
  if (i < 0) return null
  const end = src.indexOf('}', i)
  return end < 0 ? null : src.slice(i + sel.length + 2, end)
}
const confirmCss = cssBody(cssSrc, '.petball-confirm')
const btnCss = cssBody(cssSrc, '.petball-confirm-btn')
const textCss = cssBody(cssSrc, '.petball-confirm-text')
const etaCss = cssBody(cssSrc, '.petball-confirm-eta')
ok(
  confirmCss != null && btnCss != null && textCss != null && etaCss != null,
  'L69 取得到确认气泡的四条 CSS 规则'
)
ok(confirmCss != null && /pointer-events:\s*auto/.test(confirmCss), 'L70 确认气泡自己开回 pointer-events（.petball 整体是 none）')
ok(
  btnCss != null && parseFloat((btnCss.match(/min-height:\s*([\d.]+)px/) || [])[1]) >= 24,
  'L71 按钮点击区 ≥ 24×24（WCAG 2.2 最小目标尺寸）'
)
// 气泡形态：锚点必须是**底边**（尖角朝下指向圆环），和 .petball-bubble 同族同位。
// 锚回中线会让它盖住环心读数 —— 气泡是外溢浮层，读数 crisp 的前提是它不压环。
ok(
  confirmCss != null &&
    /transform:\s*translate\(-50%\s*,\s*-100%\)/.test(confirmCss) &&
    /border-bottom-left-radius:\s*([\d.]+)px/.test(confirmCss) &&
    parseFloat((confirmCss.match(/border-bottom-left-radius:\s*([\d.]+)px/) || [])[1]) <
      parseFloat((confirmCss.match(/border-radius:\s*([\d.]+)px/) || [])[1]),
  'L72 确认气泡锚在底边、左下角收成尖角（形态上是气泡，不是胶囊条）'
)
// 与 .petball-bubble 同深：两条气泡挨着出现时深浅必须一致，否则读起来像两个来源的浮层。
// 两者都得指向同一个令牌 —— 一个写死 rgba、一个写 var，就等于把这次的一致性判死。
const bubbleCss = cssBody(cssSrc, '.petball-bubble')
ok(
  bubbleCss != null &&
    /background:\s*var\(--bubble-bg\)/.test(bubbleCss) &&
    /background:\s*var\(--bubble-bg\)/.test(confirmCss || ''),
  'L73 语音气泡与确认气泡共用 --bubble-bg（同一族的底色不能各写各的）'
)
// 文案不许截断：nowrap + overflow:hidden 可以（confirmLine 已按像素宽度收敛，正常走不到），
// text-overflow:ellipsis 是这次要修掉的旧行为本身。
ok(
  textCss != null &&
    !/text-overflow:\s*ellipsis/.test(textCss) &&
    /white-space:\s*nowrap/.test(textCss),
  'L74 气泡文案按宽收敛后用 nowrap、不再有 text-overflow:ellipsis（「OpenCode Go …」就是这么来的）'
)
// eta 也不许折行：气泡宽度由**最宽的子元素**决定（flex column + align-items:stretch），
// 文案短的时候操作行就是那个最宽的 —— eta 一旦折成两行，整个气泡跟着变高一截，
// 锚点又得重算。实测过：短文案下「15 分钟后不再提示」真折成了「15 分钟后不 / 再提示」。
ok(
  etaCss != null && /white-space:\s*nowrap/.test(etaCss),
  'L78 eta 单行（它一旦折行就把气泡顶高，锚点白夹一次）'
)
// 高度上限：这是这次改设计时最容易被破坏的一条。
//
// 高度构成沿用 2026-09-30 的实测账（人物形态存续期：窗口 213×293，角色投影 rect.y = 39.5，
// 头顶以上只有 39.5px —— 第一版 78px 两行文案会从发冠盖到脸上）。形态下线后窗口只剩 56×56，
// 气泡是外溢浮层，高度仍由同一组构成项钉住：CSS 的 padding / 文案行高 / 间距 /
// 操作行高度，超了说明有人动过其中之一，少了多半是少算了一项。
//
// ⚠ 两处坑，反验都真踩过：① 本文件的 cssBody 会吃进整条注释，`.petball-confirm` 的块里有一整段
//   注释在写「4+13.2+2+24+5 = 48.2」，用第一个命中去匹配会拿到注释里的 4 和 13.2；② 字号与行高
//   的取值链是「文案自己写的 → 父级继承的 → 兜底 1」，少一环就少算一份（实测把 line-height 那环
//   漏掉会得到 39.2，看着更矮、守卫照样绿）。
{
  const stripComment = (body) => body.replace(/\/\*[\s\S]*?\*\//g, '')
  // ⚠ 单位必须写成 (?:px)?，不能写 px? —— `px?` 在正则里是「字母 p 加一个可选的 x」，
  // 对无单位的 `line-height: 1.2` 一个字符都匹配不到。实测踩过：它静默返回 NaN，回退到
  // 兜底值 1，总高从 48.2 被算成 46，恰好还落在 40~49 的区间里，守卫照样绿着。
  // 所以这里不用 || 兜底，每个构成项都要求真匹配到，取不到就让断言失败。
  const NUM = (body, prop) => stripComment(body).match(new RegExp(prop + ':\\s*([\\d.]+)(?:px)?'))?.[1]
  const padShort = stripComment(confirmCss).match(/padding:\s*([\d.]+)px\s+([\d.]+)px\s+([\d.]+)px/)
  const parts = {
    padT: NUM(confirmCss, 'padding-top') ?? padShort?.[1],
    padB: NUM(confirmCss, 'padding-bottom') ?? padShort?.[3],
    gap: NUM(confirmCss, 'gap'),
    fs: NUM(textCss, 'font-size') ?? NUM(confirmCss, 'font-size'),
    lh: NUM(textCss, 'line-height') ?? NUM(confirmCss, 'line-height'),
    btnH: NUM(btnCss, 'min-height')
  }
  ok(
    Object.values(parts).every((v) => typeof v === 'string' && v !== ''),
    `L77a 确认气泡的高度构成项都真取到了（实际：${JSON.stringify(parts)}）`
  )
  const total =
    parseFloat(parts.padT) + parseFloat(parts.padB) + parseFloat(parts.gap) +
    parseFloat(parts.fs) * parseFloat(parts.lh) + parseFloat(parts.btnH)
  ok(
    total > 40 && total <= 49,
    `L77b 确认气泡高 ${total}px 落在 40~49（构成沿用 2026-09-30 实测账 48.2：超 49 说明 padding/行高/间距有人动过，` +
      `小于 40 多半是又少算了一项 —— 对照浏览器实测应是 48.2）`
  )
}
// 禁硬编码颜色：皮肤是令牌驱动的，写死一个 hex 就等于新皮肤里它不跟着变。
// ⚠ none / transparent 不算硬编码 —— 那是「没有这个属性」，写死一个颜色才是。
// 旧版判据只看 `var(`，把 `.no3d` 那条 `background: none` 也一起判红，只好把 no3d 变体
// 从名单里悄悄拿掉 —— 等于守门范围自己缩了，比改代码更糟。
const COLOR_PROPS = /(?:^|;)\s*(color|background|background-color|border|border-color|box-shadow)\s*:\s*([^;]+)/g
const COLOR_OK = /^(none|transparent)$/
const confirmSelectors = [
  '.petball-confirm',
  '.petball-confirm-text',
  '.petball-confirm-eta',
  '.petball-confirm-btn',
  '.petball-confirm-btn:hover',
  '.petball.no3d .petball-confirm',
  '.petball.no3d .petball-confirm-btn'
]
const hardCoded = confirmSelectors.flatMap((sel) => {
  const b = cssBody(cssSrc, sel)
  if (b == null) return []
  return [...b.matchAll(COLOR_PROPS)].filter((m) => !/var\(/.test(m[2]) && !COLOR_OK.test(m[2].trim())).map((m) => m[1])
})
ok(
  hardCoded.length === 0,
  `L75 确认气泡样式全部走 token，无硬编码颜色（实际硬编码：${hardCoded.join(' / ') || '无'}）`
)
// 与球盘同一条纪律：元素与窗口同量级时 outer box-shadow 会被窗口裁成方框。
// 气泡（CSS 最宽 190px，内联按命中区夹到 62 以内）相对 56×56 窗口是外溢浮层，
// 外阴影会被窗口裁成方框。
const outerShadows = ['.petball-confirm', '.petball-confirm-btn', '.petball.no3d .petball-confirm', '.petball.no3d .petball-confirm-btn']
  .flatMap((sel) => {
    const body = cssBody(cssSrc, sel)
    if (body == null) return []
    const v = (body.match(/box-shadow:\s*([^;]+)/) || [])[1] || ''
    return v && !/^\s*inset\b/.test(v.trim()) ? [`${sel}: ${v.trim()}`] : []
  })
ok(outerShadows.length === 0, `L76 确认气泡没有 outer box-shadow（实际：${outerShadows.join(' / ') || '无'}）`)

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
