// 系统通知判定测试（renderer/src/systemNotify.ts）
// 用法：node scripts/test-system-notify.mjs
//
// 覆盖：阈值边界、resetSoon 边界、缺失值纪律、数据来源标注（数据诚实）、
//       脏配置回退、上升沿锁存去重、多供应商每轮只取最严重一档。
//
// 为什么独立于 test-alert-orchestration.mjs：那条管的是「编排」（谁先谁后、锁存记哪一批），
// 这一条管的是「系统通知这个通道自己的判定规则」。两者共享 alertOrchestrate.evaluate 这条
// 时间线，但阈值表、锁存集合、文案全是各管各的（design.md D1/D2）—— 混进一条文件里，
// 「改播报阈值顺手改坏通知阈值」会很难看出来。
//
// 全部经 loadTs 加载**真实源码**（scripts/lib/load-ts.mjs）：checkNotify / freshNotifies /
// notifyLatchKeys / buildNotifyBody / resolveNotifyConfig 一个都不内联 —— 内联过的测试已经
// 漂移过一次（test-percent.mjs），源文件改了测试还绿着，等于没有测试。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadTs } from './lib/load-ts.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const {
  checkNotify,
  freshNotifies,
  notifyLatchKeys,
  notifyKey,
  buildNotifyBody,
  resolveNotifyConfig,
  DEFAULT_NOTIFY_CONFIG,
  NOTIFY_LEVELS
} = await loadTs('src/renderer/src/systemNotify.ts')

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
function includes(hay, needle, label) {
  const hit = typeof hay === 'string' && hay.includes(needle)
  if (hit) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}\n      实际: ${JSON.stringify(hay)}\n      期望包含: ${needle}`)
  }
}
function notIncludes(hay, needle, label) {
  const hit = typeof hay === 'string' && hay.includes(needle)
  if (!hit) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}\n      实际: ${JSON.stringify(hay)}\n      期望不包含: ${needle}`)
  }
}

const HOUR = 3600_000
const T0 = 1_700_000_000_000
const ISO = '2026-09-29T00:00:00.000Z'
/** T0 之后 hours 小时的 ISO —— 造 resetAt 用（Date.parse 要得到一个真的未来时刻） */
const inHours = (h) => new Date(T0 + h * HOUR).toISOString()

const win = (o = {}) => ({ name: '本月', used: 0, limit: 100, unit: 'usd', ...o })
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
/** 套餐型、单一窗口；pct 由 used/limit 推出 */
const plan = (pct, o = {}) =>
  snap({ windows: [win({ used: pct, limit: 100, ...o })] })

const cfg = (o = {}) => ({ ...DEFAULT_NOTIFY_CONFIG, ...o })
/** 一轮判定；只取 id 列表便于断言 */
const ids = (list) => list.map((p) => p.id)
const levelOf = (list, id) => list.find((p) => p.id === id)?.level ?? null
const bodyOf = (list, id) => list.find((p) => p.id === id)?.body ?? null

// ═══ A. 阈值边界 ═══════════════════════════════════════════════════════════
//
// 边界一律取「**严格越过**」：与 checkTriggers 同口径。正好 80% 不提醒，
// 80.1% 提醒 —— 否则用户在阈值上会收到两条只差 0.01 的重复通知。

console.log('\nA. 阈值边界（严格越过）')

eq(checkNotify([plan(0)], cfg(), T0).length, 0, 'A1 用量 0% → 不通知')
eq(checkNotify([plan(80)], cfg(), T0).length, 0, 'A2 正好 80%（= pctWarn）→ 不通知（严格越过）')
eq(levelOf(checkNotify([plan(81)], cfg(), T0), 'x'), 'warn', 'A3 81% → warn')
eq(levelOf(checkNotify([plan(95)], cfg(), T0), 'x'), 'warn', 'A4 正好 95%（= pctHigh）→ 仍是 warn（不越线）')
eq(levelOf(checkNotify([plan(96)], cfg(), T0), 'x'), 'high', 'A5 96% → high')
// 对照：同样的数据在「>=」实现下 A2/A4 会变红，所以这两条是这条边界的判据
eq(levelOf(checkNotify([plan(81)], cfg({ pctWarn: 80, pctHigh: 95 }), T0), 'x'), 'warn', 'A6 对照：默认配置下与 A3 同档')

// 高档一旦越过就压住低档（一个供应商一轮只弹一条）
eq(checkNotify([plan(99)], cfg(), T0).length, 1, 'A7 99% → 仍只有一条（高档吃掉低档）')

console.log('\nB. resetSoon 边界')

// 距重置 <= 1h → reset；无 resetAt → 不触发；已过点 → 不触发（永动机防线）
const soon = plan(10, { resetAt: inHours(0.5) })
eq(levelOf(checkNotify([soon], cfg(), T0), 'x'), 'reset', 'B1 还剩 30 分钟 → reset')
eq(levelOf(checkNotify([plan(10, { resetAt: inHours(1) })], cfg(), T0), 'x'), 'reset', 'B2 还剩正好 1 小时 → reset（<= 边界）')
eq(checkNotify([plan(10, { resetAt: inHours(2) })], cfg(), T0).length, 0, 'B3 还剩 2 小时 → 不触发')
eq(checkNotify([plan(10)], cfg(), T0).length, 0, 'B4 没有 resetAt → 不触发')
// ⚠ 这条是踩过的坑：适配器在数据过期（cached）时给的 resetAt 会落在过去，
//   若不判 `left > 0`，那条记录会变成「每 30 秒弹一次重置临近」的永动机。
eq(checkNotify([plan(10, { resetAt: inHours(-1) })], cfg(), T0).length, 0, 'B5 resetAt 已落在过去 → 不触发（防永动机）')
eq(checkNotify([plan(10, { resetAt: 'not-a-date' })], cfg(), T0).length, 0, 'B6 resetAt 不是合法日期 → 不触发')
// 阈值本身也可配
eq(levelOf(checkNotify([plan(10, { resetAt: inHours(4) })], cfg({ resetSoonHours: 6 }), T0), 'x'), 'reset', 'B7 放宽到 6 小时后，还剩 4 小时 → 触发')

console.log('\nC. 缺失值与状态纪律（type-safety.md：不知道 ≠ 0）')

eq(checkNotify([snap({ status: 'error', windows: [win({ used: 99, limit: 100 })] })], cfg(), T0).length, 0,
  'C1 status=error → 不通知（没有可信数据，不拿旧闻当新闻）')
eq(checkNotify([snap({ status: 'nodata', windows: [win({ used: 99, limit: 100 })] })], cfg(), T0).length, 0,
  'C2 status=nodata → 不通知')
eq(checkNotify([snap({ windows: [] })], cfg(), T0).length, 0, 'C3 没有窗口 → 不通知')
// 限额未知时算不出百分比 —— 不能拿 0 冒充「用量 0%」
eq(checkNotify([snap({ windows: [{ name: '本周', used: 58, limit: undefined, unit: 'usd', percent: 95 }] })], cfg(), T0).length, 1,
  'C4 官方直报 percent=95（limit 未知）→ 仍能判（百分比有权威来源）')
eq(checkNotify([snap({ windows: [{ name: '本周', used: 58, limit: undefined, unit: 'usd' }] })], cfg(), T0).length, 0,
  'C5 百分比与限额都判不出 → 不通知（不拿「不知道」冒充 0%）')
eq(checkNotify([], cfg(), T0).length, 0, 'C6 空快照 → 不通知')

console.log('\nD. 数据诚实：cached / local 必须标注（design.md D4）')

const body = (s, level = 'warn') => buildNotifyBody(s, level, s.windows[0], T0)
// ⚠ `dataQuality` 挂在 **snapshot** 上（staleLabel 读的是 `s.dataQuality`），
//   而 `plan()` 的第二个参数透传给窗口 —— 写成 `plan(85, { dataQuality: 'cached' })`
//   会安静地当成 official。这条夹具陷阱已经让 D2/D3 报红过一次，记在这里。
const qual = (q) => snap({ dataQuality: q, windows: [win({ used: 85, limit: 100 })] })
includes(body(plan(85)), '官方数据', 'D1 official → 正文标「官方数据」')
includes(body(qual('cached')), '⚠ 缓存数据', 'D2 cached → 正文标「⚠ 缓存数据」')
includes(body(qual('local')), '⚠ 本机估算', 'D3 local → 正文标「⚠ 本机估算」')
// 对照：official 的正文里不该出现告警符号
notIncludes(body(plan(85)), '⚠', 'D4 对照：official 正文无 ⚠ 前缀（否则标注失去意义）')
// 正文里必须有百分比（AC1 要求「当前百分比」看得见）
includes(body(plan(85)), '85', 'D5 正文含当前百分比')
includes(body(plan(85)), '本月', 'D6 正文含窗口名')
// 百分比判不出时，正文里**不能**出现百分比 —— 只有来源标注还在
const noPct = snap({ windows: [{ name: '账户余额', used: 58, unit: 'cny' }] })
includes(buildNotifyBody(noPct, 'reset', noPct.windows[0], T0), '官方数据', 'D7 判不出百分比时来源标注仍在（说明数据有多可信）')

// reset 档的正文形态
const rSnap = plan(10, { resetAt: inHours(0.5) })
includes(buildNotifyBody(rSnap, 'reset', rSnap.windows[0], T0), '后重置', 'D8 reset 档正文含重置倒计时')
includes(body(plan(85, { resetAt: inHours(0.5) })), '后重置', 'D9 warn 档正文也带重置倒计时（AC1 要求重置时间可见）')
notIncludes(body(plan(85)), '后重置', 'D10 没有 resetAt 时 warn 档正文不写倒计时（不编造）')

console.log('\nE. 脏配置回退（state-management：读取处一律重新校验）')

eq(resolveNotifyConfig({ pctWarn: Number.NaN, pctHigh: 90, resetSoonHours: 2 }),
  { pctWarn: 80, pctHigh: 90, resetSoonHours: 2 }, 'E1 NaN → 回退默认（不影响别的字段）')
eq(resolveNotifyConfig({ pctWarn: -5, pctHigh: -1, resetSoonHours: -3 }), DEFAULT_NOTIFY_CONFIG,
  'E2 负数全部回退默认')
eq(resolveNotifyConfig({}), DEFAULT_NOTIFY_CONFIG, 'E3 空对象 → 默认')
eq(resolveNotifyConfig(null), DEFAULT_NOTIFY_CONFIG, 'E4 null → 默认')
eq(resolveNotifyConfig(undefined), DEFAULT_NOTIFY_CONFIG, 'E5 undefined → 默认')
eq(resolveNotifyConfig({ pctWarn: 50, pctHigh: 60, resetSoonHours: 3 }),
  { pctWarn: 50, pctHigh: 60, resetSoonHours: 3 }, 'E6 合法值原样保留')
// 倒挂的一对：warn=96 / high=95 时「提醒」那一档永远不可能触发，而界面上看不出异常
const inverted = resolveNotifyConfig({ pctWarn: 96, pctHigh: 95, resetSoonHours: 1 })
ok(inverted.pctHigh > inverted.pctWarn, `E7 倒挂被收口（pctHigh > pctWarn，实得 ${inverted.pctWarn} / ${inverted.pctHigh}）`)
ok(resolveNotifyConfig({ pctWarn: 100, pctHigh: 1 }).pctHigh >= 100, 'E8 warn=100 时 high 抬到 100（用量率上限外 = 强提醒不触发）')
// 脏配置在 checkNotify 里也必须「不触发」而不是「乱触发」
eq(checkNotify([plan(0)], cfg({ pctWarn: -1, pctHigh: -1 }), T0).length, 0,
  'E9 负阈值 → 用量 0% 也不通知（负阈值会让「0% 也越线」）')

console.log('\nF. 上升沿锁存去重（prd.md 需求 4：恰好一次）')

const cands = checkNotify([plan(85)], cfg(), T0)
ok(cands.length === 1, 'F0 前置：85% 确实产出一条候选（否则下面在比空集合）')
eq(notifyLatchKeys(cands), ['notify:x:warn'], 'F1 锁存键 = notify:<供应商>:<档位>')
eq(freshNotifies(cands, []), cands, 'F2 首次 → 全新命中（返回原数组内容）')
eq(freshNotifies(cands, ['notify:x:warn']).length, 0, 'F3 已锁存 → 不再返回（不轰炸通知中心）')
// 条件解除 → 键消失 → 再次越过要能重新弹（AC5：充了额度又花光仍要看得见）
const relieved = checkNotify([plan(10)], cfg(), T0)
eq(relieved.length, 0, 'F4 条件解除 → 本轮无候选')
eq(freshNotifies(checkNotify([plan(85)], cfg(), T0), notifyLatchKeys(relieved)).length, 1,
  'F5 解除后再越过 → 重新弹（键随条件解除而消失）')
// 锁存是「按档位」的，不是「按供应商」：越过 80% 弹过一次之后，「即将重置」不该被记成弹过
const mixed = checkNotify([plan(85, { resetAt: inHours(0.5) })], cfg(), T0)
// ⚠ 优先级是**每家每轮只留最严重的一条**（checkNotify 契约），所以这里产出的是 warn 而**不是**
//   reset —— 「用量 85% 且 30 分钟后重置」只提醒用量那一件（正文里仍带倒计时，见 D9）。
//   曾经把这条写成 `ok(mixed.length >= 1)` 之类的模糊判据 + 「reset 下一轮会补上」的注释，
//   注释是错的而断言是空的：length >= 0 恒真，等于没有断言。
eq(mixed.length, 1, 'F6 用量越线 + 临近重置同轮成立 → 仍只有一条（每家每轮取最严重）')
eq(levelOf(mixed, 'x'), 'warn', 'F6b 同轮成立时取更严重的 warn（reset 被压住，不是被记成弹过）')
// 压住的那一档**没有被锁存**：用量回落到阈值以下后，reset 立刻能补上自己的那一轮
const relieved85 = checkNotify([plan(10, { resetAt: inHours(0.5) })], cfg(), T0)
eq(levelOf(relieved85, 'x'), 'reset', 'F6c 用量回落后，「即将重置」补上它自己的一轮（键从没被误记）')
eq(freshNotifies(relieved85, notifyLatchKeys(mixed)).length, 1,
  'F6d F6 里那轮的锁存（notify:x:warn）挡不住 reset 档（档位在键里）')
const latchedWarn = freshNotifies(mixed, ['notify:x:warn'])
eq(latchedWarn.length, 0, 'F7 已锁存的 warn 候选被滤掉（本轮无新事件）')
eq(notifyKey({ id: 'a', name: 'A', title: 't', body: 'b', level: 'high' }), 'notify:a:high',
  'F8 notifyKey 形状稳定（主窗口按它去重）')
// 跨档升级不吞：81% 弹过 warn 之后涨到 96%，high 是**新事件**，必须弹
const crossed = freshNotifies(checkNotify([plan(96)], cfg(), T0), ['notify:x:warn'])
eq(notifyLatchKeys(crossed), ['notify:x:high'], 'F9 越过 95% → high 是新键，能弹（阈值升级不被误吞）')

console.log('\nG. 多供应商：每家各一条，各取最严重档（design.md D2）')

// ⚠ 夹具注意：`plan(pct, o)` 的 `o` 透传给**窗口**，而供应商名要传给 `snap`。
//   写成 `plan(99, { name: 'Y' })` 会把 name 塞进 window 而 snapshot 仍是 'X'，
//   三家于是都叫 X —— 断言 ids 会看到 ["x","x"]，而这条红的正是「没发现」。
const named = (id, name, pct) => snap({ id, name, windows: [win({ used: pct, limit: 100 })] })
const multi = checkNotify([named('x', 'X', 85), named('y', 'Y', 99), named('z', 'Z', 5)], cfg(), T0)
eq(ids(multi).sort(), ['x', 'y'], 'G1 只有越线的两家各一条（5% 那家不通知）')
eq(levelOf(multi, 'x'), 'warn', 'G2 85% 那家是 warn')
eq(levelOf(multi, 'y'), 'high', 'G3 99% 那家是 high')
ok(multi.every((p) => p.title.startsWith(p.name)), 'G4 标题以供应商名开头（通知中心一眼看出是谁）')
// 名字为空时回落 id（不弹一条没主的通知）
eq(checkNotify([snap({ id: 'inst:a', name: '', windows: [win({ used: 85, limit: 100 })] })], cfg(), T0)[0].name,
  'inst:a', 'G5 供应商名为空 → 回落 id（标题不出现「null」）')

console.log('\nH. ipc 侧档位字面量必须与渲染层一致（无共享模块，靠静态比对钉住）')
//
// 两边没有共享模块（文件所有权不许新增 shared 文件），所以 NOTIFY_LEVELS 各写一份。
// 与 test-structure.mjs 的 F5「原因码两侧一致」是同一条做法：没有共享模块时，
// 静态比对是唯一能防漂移的机制 —— 忘了同步的话，新增档位会在主进程静默被拒。
const ipcSrc = readFileSync(resolve(ROOT, 'src/main/ipc.ts'), 'utf-8')
const m = ipcSrc.match(/const NOTIFY_LEVELS\s*=\s*\[([^\]]*)\]/)
ok(m != null, 'H0a 前置：主进程有 NOTIFY_LEVELS 校验表')
eq(
  m == null ? null : m[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean),
  [...NOTIFY_LEVELS],
  'H0b 主进程 NOTIFY_LEVELS 与渲染层逐项一致（顺序也一致）'
)
// 通知 handler 必须存在，且不做「抛异常」而是返回 false
ok(/ipcMain\.handle\(\s*'notify:show'/.test(ipcSrc), 'H1 主进程注册了 notify:show')
const nHandler = ipcSrc.indexOf("ipcMain.handle('notify:show'")
const nBody = nHandler > 0 ? ipcSrc.slice(nHandler, ipcSrc.indexOf('\n  })', nHandler)) : ''
ok(nBody.length > 0, 'H2a 前置：取得到 notify:show 的 handler 体')
ok(nBody.includes('return false'), 'H2b 载荷不合法时返回 false（不抛：抛出去只是渲染层一个未处理 rejection）')
ok(nBody.includes('NOTIFY_LEVELS.includes'), 'H3 档位走白名单校验（渲染层是信任边界之外）')
ok(!/throw new Error/.test(nBody), 'H4 handler 内不抛异常（通知失败不该炸掉渲染层的 IPC await）')

// Windows Toast：主进程必须设 AppUserModelId，否则通知在部分 Windows 上根本不出现
// （不抛不红，只是「通知永远不来」，而 macOS 上完全看不出来 —— 跨平台差异的典型形态）。
// appId 与 electron-builder.yml 各写一份（yml 读不到 TS 常量），所以静态比对钉住。
const idxSrc = readFileSync(resolve(ROOT, 'src/main/index.ts'), 'utf-8')
ok(/app\.setAppUserModelId\(\s*'[^']+'\s*\)/.test(idxSrc), 'H6a 主进程设置了 AppUserModelId（Windows Toast 的归属 id）')
const yamlAppId = (readFileSync(resolve(ROOT, 'electron-builder.yml'), 'utf-8').match(/^appId:\s*(\S+)\s*$/m) ?? [])[1] ?? null
const codeAppId = (idxSrc.match(/app\.setAppUserModelId\(\s*'([^']+)'/) ?? [])[1] ?? null
ok(yamlAppId != null && codeAppId != null, 'H6b 两处 appId 都读得到（否则下面的比对是空洞通过）')
eq(codeAppId, yamlAppId, 'H6c 运行时 appId 与 electron-builder.yml 的 appId 一致（不一致 = 打包后归属又变了）')

// preload 必须暴露 notifyShow —— 渲染层的类型是从它推导的，没有它就编译不过
const preloadSrc = readFileSync(resolve(ROOT, 'src/preload/index.ts'), 'utf-8')
ok(/notifyShow:[^=]*=>[\s\S]{0,300}?invoke\(\s*'notify:show'/.test(preloadSrc),
  'H5 preload 暴露 notifyShow（且走 notify:show 通道，不是复用别的方式）')

// ═══ I. 纯函数纪律 ═════════════════════════════════════════════════════════
const notifySrc = readFileSync(resolve(ROOT, 'src/renderer/src/systemNotify.ts'), 'utf-8')
const notifyCode = notifySrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

console.log('\nI. 纯函数纪律（与 alertOrchestrate 同款守卫）')

ok(notifyCode.trim().length > 0, 'I0a 前置：模块源码读得到（下面的负向断言不能空洞通过）')
ok(!/Date\.now\(|new Date\(\s*\)/.test(notifyCode), 'I0b 判定纯函数里没有读自己的钟（now 由入参传）')
ok(!/window\.|document\.|setExtras|api\./.test(notifyCode), 'I0c 不碰 window / DOM / IPC（纯判定）')
// 数据诚实口径的单一出处：判定「哪些算非官方」必须走 staleLabel，不在本地写第二份
ok(/from '\.\.\/\.\.\/shared\/quality'/.test(notifySrc) && /staleLabel\(/.test(notifyCode),
  'I1 来源标注的判定复用 shared/quality 的 staleLabel（不在本模块写第二份「哪些算非官方」）')
// 阈值判定不许绕过 pctWarn/pctHigh 的白名单
ok(!/Math\.random/.test(notifyCode), 'I2 判定里没有随机性（同一份输入必须给出同一份结果）')

console.log(`\n通过 ${pass} · 失败 ${fail}`)
if (fail > 0) process.exit(1)
