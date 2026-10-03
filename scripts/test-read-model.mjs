// 渲染层读模型测试（纯函数，node 直接跑）
// 用法：node scripts/test-read-model.mjs
//
// 覆盖：主窗口选择、最接近限额的窗口、最大百分比、快照等级、窗口等级、排序严重度、
//       收起态球的等级、金额格式化的紧凑档。
//
// 为什么值得单独测：这些规则此前在主页卡片 / 详情页 / 收起态球里各写一份
// （CardLevel / snapLevel / severity / ballLevel 外加两份主窗口选择），
// 没有一处能被测试盯住。收口成 read-model.ts 之后，这里就是它们的契约。

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTs } from './lib/load-ts.mjs'

// 仓库根（静态守卫要直接读源码文件；load-ts.mjs 里的 ROOT 不是导出，不能从那里拿）
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const rm = await loadTs('src/renderer/src/read-model.ts')
const { fmtAmount } = await loadTs('src/renderer/src/format.ts')
const {
  primaryWindow,
  primaryWindowIndex,
  worstWindow,
  maxPercent,
  snapshotLevel,
  windowLevel,
  severityRank,
  ballLevel,
  speakableSnapshots,
  ALL_GROUPS,
  UNGROUPED,
  groupOf,
  groupNames,
  visibleIds,
  orderForDisplay,
  distinguishSuffixes,
  displayName
} = rm

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
/** 非 JSON 值也能比（布尔断言用） */
function ok(cond, label) {
  eq(!!cond, true, label)
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

console.log('\nH. 哪些可以播报（muted = 不播报的 id 列表，空 = 全部允许）')

const okSnap = (id) => snap({ id, name: id })
const badSnap = (id, status) => snap({ id, name: id, status })

eq(speakableSnapshots([okSnap('a'), okSnap('b')]).map((s) => s.id).join(','), 'a,b', 'H1 默认全部允许 → 返回所有正常供应商')
eq(speakableSnapshots([okSnap('a'), okSnap('b')], ['a']).map((s) => s.id).join(','), 'b', 'H2 静音 a → 只返回 b')
eq(speakableSnapshots([okSnap('a'), okSnap('b')], ['b', 'a']).length, 0, 'H3 全静音 → 返回空数组')
eq(speakableSnapshots([badSnap('a', 'error'), okSnap('b')]).map((s) => s.id).join(','), 'b', 'H4 跳过非 ok 的')
eq(speakableSnapshots([badSnap('a', 'error'), badSnap('b', 'nodata')]).length, 0, 'H5 都不可用 → 返回空数组')
eq(speakableSnapshots([]).length, 0, 'H6 没有快照 → 返回空数组')
eq(speakableSnapshots([okSnap('a')], ['不存在']).map((s) => s.id).join(','), 'a', 'H7 静音未列出的 id 不影响结果')

console.log('\nI. 多账户分组（P1-4）')

const info = (o = {}) => ({
  id: 'p',
  name: 'X',
  kind: 'coding',
  builtin: true,
  enabled: true,
  credentialSource: 'saved',
  protocol: 'claude-code',
  baseUrl: '',
  presetId: '',
  createdAt: 0,
  groupId: '',
  ...o
})
// 公司/个人两组各两条，数组顺序刻意与「公司在前」相反 —— 组序必须由**数组位置**决定，
// 而不由组名字母序决定（把公司/个人换成 甲组/乙组 结论不变，那才是真在测排序规则）。
const mixed = [
  info({ id: 'a2', name: 'A2', groupId: '个人' }),
  info({ id: 'a1', name: 'A1', groupId: '个人' }),
  info({ id: 'b1', name: 'B1', groupId: '公司' }),
  info({ id: 'b2', name: 'B2', groupId: '公司' })
]
const ids = (list) => [...list].join(',')

// ── 哨兵 ────────────────────────────────────────────────────────────────────
// ALL_GROUPS 必须与「组名可能的取值」不可能重合，否则自建一个叫「全部」的组就与
// 「看全部」撞在同一个 value 上，选中哪一项变成浏览器的实现细节。
eq(ALL_GROUPS, '', 'I1 「全部」用空串当哨兵（extras 里「没写过」也是空串，天然幂等）')
ok(
  !['未分组', '公司', '个人'].includes(ALL_GROUPS),
  'I1b 空串哨兵不与任何真实组名相等（sanitizeGroupId 先 trim → 空串只能是「全部」）'
)

eq(rm.UNGROUPED, '未分组', 'I2 未分组桶有固定的显示名')
// 全部实例都有组 → 不该凭空多出一个「未分组」选项（用户没建过它就不该看见它）
eq(groupNames(mixed), ['个人', '公司'], 'I3 去重后按组名升序；没有未分组成员就不出现该桶')
eq(groupNames([]), [], 'I4 没有实例 → 空数组')
eq(groupNames([info({}), info({})]), ['未分组'], 'I5 全未分组 → 只有一项（与今天行为一致）')
eq(groupNames([info({ id: 'x', groupId: '公司' }), info({ id: 'y', groupId: '' })]), ['公司', '未分组'],
  'I6 groupId 缺省与空串都归入未分组桶')
eq(groupNames([info({ id: 'x' }), info({ id: 'y', groupId: '公司' }), info({ id: 'z', groupId: '公司' })]),
  ['公司', '未分组'], 'I7 同一组出现两次只留一个')
// '未分组' 参与排序时必须落在末尾：用户建的组才是正常排序的一部分
eq(groupNames([info({ id: 'x', groupId: 'zzz' }), info({ id: 'y', groupId: 'aaa' }), info({ id: 'u' })]),
  ['aaa', 'zzz', '未分组'], 'I8 未分组不参与字母序，恒在末尾')

eq(groupOf(info({})), '未分组', 'I9 空 groupId → 未分组桶')
eq(groupOf(info({ groupId: '公司' })), '公司', 'I10 有 groupId → 原样')

// ── visibleIds：**单选**筛选器（2026-10-01 用户决策：点组 = 只看它）────────────
// ⚠ 这里的语义与第一版（黑名单「藏起这些组」）**完全相反**，断言必须整体重写：
//   传 '公司' 得到的是**公司那几个**，不是「除公司以外的那些」。
eq([...visibleIds(mixed)].sort().join(','), 'a1,a2,b1,b2', 'I11 缺省 = 全部可见（等价于 ALL_GROUPS）')
eq([...visibleIds(mixed, ALL_GROUPS)].sort().join(','), 'a1,a2,b1,b2', 'I12 显式传哨兵空串 → 全部可见')
eq([...visibleIds(mixed, '公司')].sort().join(','), 'b1,b2', 'I13 选中公司 → 只剩该组成员（单选，不是取反）')
eq([...visibleIds(mixed, '个人')].sort().join(','), 'a1,a2', 'I14 选中个人 → 只剩该组成员')
eq([...visibleIds([info({ id: 'x' }), info({ id: 'y', groupId: '公司' })], '未分组')].join(','), 'x',
  'I15 选中未分组 → 只剩无 groupId 的那些')
eq([...visibleIds([info({ id: 'x', groupId: '公司' }), info({ id: 'y' })], '公司')].join(','), 'x',
  'I16 未分组成员不在选中组里 → 被排除')
// 筛选值指向**已不存在的组**（最后一个成员被删，组自然消失）→ 空集，不抛。
// ⚠ 注意这里**不是**「回落全部」：回落是渲染层的判断（它手里有下拉选项列表，
//   能证明那个组确实没了），纯函数只回答「这个组里有哪些成员」。
eq([...visibleIds(mixed, '已消失的组')].length, 0, 'I17 筛选值指向已消失的组 → 空集（不抛、不回落）')
eq([...visibleIds([], '公司')].length, 0, 'I18 没有实例 → 空集合，不抛')

eq(orderForDisplay(mixed), ['a2', 'a1', 'b1', 'b2'], 'I19 无筛选时保持数组顺序（组首下标顺序）')
eq(orderForDisplay(mixed, '个人'), ['a2', 'a1'], 'I20 选中个人 → 只剩该组且组内顺序不变')
// **本节的核心护栏：数组顺序是交错的。**
// 「两组各两条且各自连续」的数组下，纯数组顺序与分组顺序**恰好相同** —— 那种断言在
// 「不分组」的实现下也是绿的（实测：把 orderForDisplay 换成纯数组顺序，全套仍然全绿）。
// 交错数组才让这两条路径产生不同的输出。
const interleaved = [
  info({ id: 'a1', name: 'A1', groupId: '个人' }),
  info({ id: 'b1', name: 'B1', groupId: '公司' }),
  info({ id: 'a2', name: 'A2', groupId: '个人' }),
  info({ id: 'b2', name: 'B2', groupId: '公司' })
]
eq(ids(interleaved.map((p) => p.id)), 'a1,b1,a2,b2', 'I21 前置：数组本身是交错的（不是分组排列）')
eq(orderForDisplay(interleaved), ['a1', 'a2', 'b1', 'b2'],
  'I22 交错数组 → 同组成员被聚到一起（组内仍按数组顺序：a1 在 a2 前）')
eq(orderForDisplay(interleaved, '个人'), ['a1', 'a2'], 'I23 交错数组下选中一组 → 只剩该组且同样聚合')
eq(orderForDisplay(interleaved, '公司'), ['b1', 'b2'], 'I24 交错数组下选中另一组 → 结果对称')
// 三组交错：中间那组也必须归位，且仍以「组首成员」定义组序
const tri = [
  info({ id: 'p1', groupId: '丙' }),
  info({ id: 'q1', groupId: '甲' }),
  info({ id: 'r1', groupId: '乙' }),
  info({ id: 'q2', groupId: '甲' }),
  info({ id: 'r2', groupId: '乙' }),
  info({ id: 'p2', groupId: '丙' })
]
eq(orderForDisplay(tri), ['p1', 'p2', 'q1', 'q2', 'r1', 'r2'], 'I25 三组交错 → 按组首下标聚成三段')
eq(orderForDisplay(tri, '乙'), ['r1', 'r2'], 'I26 三组交错下选中中间那组 → 只剩它，组内仍按数组顺序')
// 组序由**成员在数组里的位置**决定（D4：不存组序）。把「公司」整组挪到数组最前，
// 组序就该跟着换 —— 这条在「按组名字母序排」的实现下会报红。
const moved = [
  info({ id: 'b1', name: 'B1', groupId: '公司' }),
  info({ id: 'b2', name: 'B2', groupId: '公司' }),
  info({ id: 'a2', name: 'A2', groupId: '个人' }),
  info({ id: 'a1', name: 'A1', groupId: '个人' })
]
eq(orderForDisplay(moved), ['b1', 'b2', 'a2', 'a1'], 'I27 组首成员在前 → 该组在前（不按组名字母序）')
eq(orderForDisplay([info({ id: 'x', groupId: '乙组' }), info({ id: 'y', groupId: '甲组' })]), ['x', 'y'],
  'I28 汉字组名同样只看数组位置（甲在乙后不改变顺序）')
eq(orderForDisplay(mixed, '已消失的组'), [], 'I29 筛选值指向已消失的组 → 空数组（不抛）')
eq(orderForDisplay([], ''), [], 'I30 没有实例 → 空数组')
// D4 的已知代价：某组最后一个成员被移走 → 组的位置按剩下的成员重算。
// 「个人」只剩 a2 且它在数组里排第一 → 该组移到最前。这是**刻意接受**的行为，
// 钉住它是为了让下一个改排序规则的人看到代价，而不是误以为是回归。
eq(orderForDisplay([info({ id: 'a2', name: 'A2', groupId: '个人' }), info({ id: 'b1', groupId: '公司' })]),
  ['a2', 'b1'], 'I31 组末成员移走后，组序按剩余成员重算')

// 纯度：三个函数都不得就地修改入参（渲染层拿到的实例列表会被多处复用）
const purityInput = [
  info({ id: 'a1', groupId: '个人' }),
  info({ id: 'b1', groupId: '公司' })
]
const purityBefore = JSON.stringify(purityInput)
groupNames(purityInput)
visibleIds(purityInput, '公司')
orderForDisplay(purityInput, '公司')
ok(JSON.stringify(purityInput) === purityBefore, 'I32 三个函数都不就地修改入参（深比较）')
// 连入参实例对象本身也不能被改：filter 出来的对象可能与入参同一引用
ok(
  purityInput.every((p) => p.groupId !== undefined && typeof p.groupId === 'string'),
  'I33 入参对象的字段未被改写（groupId 仍是原值）'
)

console.log('\nK. 同名多账号的区分（D5）')

// 同名两账号，host 不同 → 两张卡都必须带后缀（今天是连 logo 都一样的）
const dup = [
  info({ id: 'c1', name: 'Claude', distinguishKey: 'corp.example.com' }),
  info({ id: 'c2', name: 'Claude', distinguishKey: 'home.example.com' })
]
eq(distinguishSuffixes(dup), { c1: 'corp.example.com', c2: 'home.example.com' }, 'K1 同名两账号 → 两个都带 host 后缀')
// 只有一个 → 不加后缀（host 拼到唯一那个名字后面是噪音）
eq(distinguishSuffixes([dup[0]]), {}, 'K2 只有一个同名账号 → 不加后缀')
// 同名但一个读不出 host：那个不加，**不编「(2)」**
const halfDup = [
  info({ id: 'c1', name: 'Claude', distinguishKey: 'corp.example.com' }),
  info({ id: 'c2', name: 'Claude', distinguishKey: '' })
]
eq(distinguishSuffixes(halfDup), { c1: 'corp.example.com' }, 'K3 缺区分依据的那个不加后缀（不造假区分）')
// 不同名 → 不加（哪怕两个都有 host）
eq(
  distinguishSuffixes([
    info({ id: 'a', name: 'Claude', distinguishKey: 'x.com' }),
    info({ id: 'b', name: 'Codex', distinguishKey: 'y.com' })
  ]),
  {},
  'K4 不同名 → 都不加后缀（host 不是装饰品）'
)
// 三家同名：全部带后缀（不是只给「(2)」那个编的）
const triDup = [
  info({ id: 'a', name: 'X', distinguishKey: 'a.com' }),
  info({ id: 'b', name: 'X', distinguishKey: 'b.com' }),
  info({ id: 'c', name: 'X', distinguishKey: 'c.com' })
]
eq(Object.keys(distinguishSuffixes(triDup)).sort().join(','), 'a,b,c', 'K5 三家同名 → 全部带后缀')
eq(distinguishSuffixes([]), {}, 'K6 没有实例 → 空对象')
// 纯度：入参不被就地修改（渲染层拿到的实例列表会被多处复用）
const dupBefore = JSON.stringify(dup)
distinguishSuffixes(dup)
ok(JSON.stringify(dup) === dupBefore, 'K7 distinguishSuffixes 不就地修改入参')

eq(displayName('Claude', 'corp.example.com'), 'Claude corp.example.com', 'K8 有后缀 → 名称 + 空格 + 后缀')
eq(displayName('Claude'), 'Claude', 'K9 无后缀 → 原样')
eq(displayName('Claude', ''), 'Claude', 'K10 空串后缀（读不到区分依据）→ 原样，不留多余空格')

console.log('\nJ. 静态守卫：纯函数各只声明一次')

const rmSrc = readFileSync(resolve(ROOT, 'src/renderer/src/read-model.ts'), 'utf8')
const declCount = (name) => (rmSrc.match(new RegExp(`export function ${name}\\b`, 'g')) ?? []).length
for (const n of ['groupNames', 'visibleIds', 'orderForDisplay', 'distinguishSuffixes', 'displayName', 'groupOf']) {
  eq(declCount(n), 1, `J1 ${n} 只声明一次（重复声明会让「契约是哪一份」变成问题）`)
}
// 纯函数纪律：不得引入 electron / DOM —— 纯度是它能被 loadTs 在纯 node 里加载的前提
ok(!/from ['"]electron['"]/.test(rmSrc), 'J2 read-model 不 import electron（纯 node 可加载）')
ok(!/\bdocument\.|\bwindow\./.test(rmSrc), 'J3 read-model 不碰 DOM')

// 剥掉注释再判生效代码 —— 注释里写着「判 `v == null` 永远为假」这句说明本身
// 会被裸 grep 匹配上，把一条守实现的门变成永红（test-structure.mjs §D 记的同一个坑）。
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const appSrc = stripComments(readFileSync(resolve(ROOT, 'src/renderer/src/App.tsx'), 'utf8'))
const setSrc = stripComments(readFileSync(resolve(ROOT, 'src/renderer/src/SettingsView.tsx'), 'utf8'))
ok(appSrc.length > 0, 'J4 前置：App.tsx 剥注释后非空（负向断言不能空洞通过）')

const cardRaw = stripComments(readFileSync(resolve(ROOT, 'src/renderer/src/CardView.tsx'), 'utf8'))
console.log('\nJ2. 分组语义的边界守卫（这几条都是「写错了不报错、只是功能悄悄变了」）')

// 分组筛选下拉已随按组分块**删除**（2026-10-03）：存量 `ui:groupFilter` 残留磁盘无害，
// 渲染层读都不读 —— 下面几条钉住的正是「读都不读」（删了控件却留着读取，
// 存量用户打开面板会只剩一组的卡，那是比控件点不动更坏的静默回归）。
ok(
  !/ui:groupFilter/.test(appSrc) && !/ui:groupFilter/.test(cardRaw),
  'J5 App/CardView 不再读写 ui:groupFilter（存量键残留磁盘，读都不读）'
)
// 先剥掉 ui:groupFilter 再判：它是唯一合法的携带者，剩下的 groupFilter 必然是死管线。
const noFilterKey = (src) => !/groupFilter/.test(src.replace(/ui:groupFilter/g, ''))
ok(
  noFilterKey(appSrc) && noFilterKey(cardRaw),
  'J6 groupFilter/onSetGroupFilter/applyGroupFilter 无残留（漏删一项就是死代码）'
)
ok(!/ALL_GROUPS/.test(cardRaw), 'J7 ALL_GROUPS 哨兵退役出 CardView（缺省即全部，不再需要哨兵层）')
// ⚠ 旧键 ui:groupHidden 已**退役**（黑名单 → 单选筛选器 → 按组分块，两轮删除都没把它加回来）。
//   读侧必须完全忽略它：否则一次升级就会把「我藏起来的组」的 JSON 当成别的值，
//   那串东西不可能等于任何真实组名 → 列表莫名其妙变成空白。
ok(
  !/ui:groupHidden/.test(appSrc) && !/ui:groupHidden/.test(cardRaw),
  'J8 读侧完全不再提 ui:groupHidden（残留值留在 extras 里不动，照 ui:voiceGender 的处置）'
)
// 「无筛选」是**结构性质**，用静态守卫钉住最省事：只要主进程读了这个键，
// 就说明有人把分组接到了采集或托盘上 —— 而分组只是显示层的归类。
// ⚠ uitest.ts 是观测点（它读注册表断言分块），豁免它。
const mainHits = readdirSync(resolve(ROOT, 'src/main'), { recursive: true })
  .filter((f) => typeof f === 'string' && f.endsWith('.ts') && !f.includes('qa/uitest'))
  .filter((f) => /ui:groupFilter/.test(stripComments(readFileSync(resolve(ROOT, 'src/main', f), 'utf8'))))
eq(mainHits, [], 'J9 主进程不读 ui:groupFilter（分组不碰采集与托盘：托盘仍覆盖全部账户）')

// 设置页写明分组的语义边界。没有它，用户会以为分到不同块的账户收不到告警 ——
// 而实际上（且应该）仍然收得到。这条只能静态断言：仓库没有 React 测试基础设施。
// ⚠ 旧文案提「标题栏的下拉」（控件已删）：留着它等于给一个不存在的控件写说明书。
ok(
  setSrc.includes('分组只影响列表分块') && setSrc.includes('托盘与提醒仍覆盖全部账户'),
  'J10 设置页写明「分组只影响列表分块，托盘与提醒仍覆盖全部账户」'
)
ok(!setSrc.includes('筛选只影响列表显示'), 'J10b 设置页不再提已删除的筛选下拉（旧文案随控件退役）')

ok(!cardRaw.includes('分组已全部隐藏'), 'J11 「分组已全部隐藏」空态随筛选一并删除（无筛选即无此状态）')
ok(!/effFilter/.test(cardRaw), 'J12 effFilter/selectValue 管线删除（排序与空态不再经筛选值）')
ok(
  !/onSetGroupFilter/.test(cardRaw),
  'J13 onSetGroupFilter prop 与空态回全部按钮删除（无写入路径，ui:groupFilter 只减不增）'
)
// ⚠ instanceInfo 空守卫：首帧 IPC 未返回时 orderForDisplay 返回空集，拿空集去算组序会
//   让全部卡片挤进默认名次里乱跳。
ok(/instanceInfo\.length/.test(cardRaw), 'J14 instanceInfo 未到手时走兜底分支（否则组序是空集上算出来的）')
// 无筛选即无隐藏（未知实例显示语义保留：快照有而 instanceInfo 里查不到的 id 照样显示）。
// 将来若加回筛选，解开位置在 hidden 与 seq 传参 —— 这条变红时记得两处一起改。
ok(
  /hidden: \(_id: string\): boolean => false/.test(cardRaw),
  'J15 hidden 恒 false（无筛选即无隐藏；未知实例照样显示，排末尾）'
)
// 分块渲染：section[role=group] + 组头 + 网格；块顺序复用 groupNames（不另起顺序源）。
ok(
  /className="pcard-section"/.test(cardRaw) &&
    /role="group"/.test(cardRaw) &&
    /groupNames\(instanceInfo\)/.test(cardRaw),
  'J16 按组分块渲染（section + 组头 + 网格，块顺序复用 groupNames）'
)
// 组名标签：分块后组内每卡都打组名 = 视觉噪音，上下文由组头承担。
// ⚠ 负向断言带存在前提（cardRaw 非空），否则文件改名即空洞通过。
ok(
  cardRaw.length > 1000 && !/pcard-group/.test(cardRaw),
  'J17 组内卡不再渲染 .pcard-group 标签（组头即上下文）'
)
// 同一条链上的一环：`groupOfId` 查不到实例时必须返回**空串**而不是 UNGROUPED。
// J17 只钉住「标签已删」；这里是「空串从哪来」那一端 —— 未知实例进兜底块但不读组名。
ok(
  /const groupOfId = \(id: string\): string => \{[\s\S]{0,200}?return it \? groupOf\(it\) : ''/.test(cardRaw),
  'J17b groupOfId 对查不到的实例返回空串（不知道 ≠ 未分组，aria 才有空可留）'
)
// GroupTag 组件随标签一并删除（确认无他处引用 —— 删调用不删定义等于留死代码）。
ok(!/function GroupTag/.test(cardRaw), 'J18 GroupTag 组件已删除（无他处引用，不留死代码）')
// 哨兵 value 随下拉退役：存储缺省即全部，不再需要控件层的哨兵映射。
ok(!/ALL_GROUPS_VALUE/.test(cardRaw), 'J19 下拉哨兵 ALL_GROUPS_VALUE 已删除（无控件即无撞名）')
// 标题栏分组筛选下拉已删除：.grp-select 缺 no-drag 导致「点不动」，删除即修复。
// 反验搭档是 uitest 的 grpSections（含「下拉不存在」断言）—— 静态门钉源码，行为门钉产物。
ok(!/grp-select/.test(cardRaw), 'J20 标题栏 .grp-select 已删除（点不动的根因随控件消除）')

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
