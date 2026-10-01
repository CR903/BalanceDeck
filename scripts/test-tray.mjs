// shared/tray-text.ts + shared/levels.ts + main/tray-badge.ts 行为测试（纯函数，node 直接跑）
// 用法：node scripts/test-tray.mjs
//
// 用户明确要求的状态栏形态：
//   多时限窗口的供应商（如 OpenCode Go）→ logo + `5H 2.7% W 51.9% M 67.9%`
//   其他（余额类）→ 余额或使用比例
// 顺带锁定：离线/缓存前缀、主供应商选取（= 卡片顺序第一位）
// P1-3 加锁：等级阈值（85/60 唯一出处）、标题 ANSI、图标状态点分层。

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadTs } from './lib/load-ts.mjs'

const {
  compactAmount,
  primarySnapshot,
  providerSummary,
  qualitySuffix,
  shortWindowLabel,
  stripAnsiTitle,
  trayTitle
} = await loadTs('src/shared/tray-text.ts')
const { ANSI_RESET, ansiColor, levelOfPercent, stripAnsi } = await loadTs('src/shared/levels.ts')
const { badgeOf, paintBadge, trayIconKey, trayLevel } = await loadTs('src/main/tray-badge.ts')

const ROOT = resolve(import.meta.dirname, '..')

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
/** 正向存在性判据的伴随门：负向断言在「文件读不到」时会空洞通过 */
function ok(cond, label) {
  eq(!!cond, true, label)
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
// ⚠ 全部走 stripAnsi：P1-3 之后标题里带 ANSI 包裹码，而**文案措辞逐字未变**。
// 这批断言守的就是「加色不许顺手改字」—— 措辞变了一定红。
eq(providerSummary(go), '5H 2.7% W 51.9% M 67.9%', 'Go：全部窗口平铺')
eq(stripAnsiTitle([go], false), '5H 2.7% W 51.9% M 67.9%', '在线且官方数据不加前缀')
eq(providerSummary(balance), '¥500.67', '余额类：显示金额')
eq(stripAnsiTitle([balance], false), '¥500.67', '余额类标题')
eq(
  stripAnsiTitle([snap({ windows: [{ name: '本周', used: 15, limit: 30, unit: 'usd', percent: 50 }] })], false),
  'W 50%',
  '单窗口百分比带标签'
)
eq(stripAnsiTitle([snap({ windows: [{ name: '账户余额', used: 12.34, unit: 'usd' }] })], false), '$12.34', '单窗口美元金额')
eq(
  stripAnsiTitle([snap({ windows: [{ name: '账户余额', used: 12345.67, unit: 'usd' }] })], false),
  '$12.3k',
  '万元级金额缩写'
)
eq(
  stripAnsiTitle([snap({ windows: [{ name: '账户余额', used: 1234567, unit: 'usd' }] })], false),
  '$1.2M',
  '百万元级金额缩写'
)

console.log('离线 / 缓存前缀')
eq(stripAnsiTitle([go], true), '⚠ 5H 2.7% W 51.9% M 67.9%', '离线加 ⚠')
eq(stripAnsiTitle([snap({ ...go, dataQuality: 'cached' })], false), '⚠ 5H 2.7% W 51.9% M 67.9%', '缓存数据加 ⚠')
eq(stripAnsiTitle([snap({ ...go, dataQuality: 'local' })], false), '⚠ 5H 2.7% W 51.9% M 67.9%', '本机估算加 ⚠')
eq(trayTitle([], false), '', '无供应商时标题为空')
eq(trayTitle([snap({ status: 'error', windows: [] })], false), '', '全部出错时不显示假数据')
eq(stripAnsiTitle([snap({ status: 'error', windows: [] }), go], false), '5H 2.7% W 51.9% M 67.9%', '跳过出错项取下一个')

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

// ─── P1-3 · 等级阈值（85/60 的唯一出处）─────────────────────────────────────
//
// 边界值逐个钉死：卡片 / 详情页 / 球 / 托盘都走这一份，把判定搬回第二处或改数字即红。
console.log('\nP1-3 · 等级阈值 levelOfPercent（85 / 60）')
eq(levelOfPercent(0, 'ok'), 'ok', '0% → ok')
eq(levelOfPercent(59.9, 'ok'), 'ok', '59.9% → ok（未到 60）')
eq(levelOfPercent(60, 'ok'), 'warn', '60% → warn（边界含）')
eq(levelOfPercent(84.9, 'ok'), 'warn', '84.9% → warn（未到 85）')
eq(levelOfPercent(85, 'ok'), 'danger', '85% → danger（边界含）')
eq(levelOfPercent(100, 'ok'), 'danger', '100% → danger')
eq(levelOfPercent(null, 'ok'), 'muted', '百分比缺失 → muted（**不填 0**）')
eq(levelOfPercent(99, 'error'), 'muted', 'status 非 ok → muted（状态优先于数字）')
eq(levelOfPercent(99, 'nodata'), 'muted', 'nodata → muted')

// ─── P1-3 · ANSI 包裹码 ────────────────────────────────────────────────────
//
// 码值不是「ANSI 规范里有的」就算数 —— 判据是 Electron 的 NSString+ANSI.mm
// 实际实现过的那几个（见 levels.ts 的注释）。90 不在表里，灰用 1;30。
console.log('\nP1-3 · ANSI 包裹码 ansiColor')
eq(ansiColor('danger'), '\x1b[31m', 'danger → 红 31')
eq(ansiColor('warn'), '\x1b[33m', 'warn → 黄 33（ANSI 调色板没有橙）')
eq(ansiColor('muted'), '\x1b[1;30m', 'muted → 灰 1;30（90 不被实现，会与 ok 同色）')
eq(ansiColor('ok'), '', 'ok → **空串**（跟随系统色；不是某个转义）')
eq(ANSI_RESET, '\x1b[0m', '复位码')
eq(stripAnsi('\x1b[33mM 67.9%\x1b[0m'), 'M 67.9%', 'stripAnsi 剥掉包裹')

// ─── P1-3 · 标题上色 ───────────────────────────────────────────────────────
console.log('\nP1-3 · 托盘标题按等级上色')
const oneWin = (pct) =>
  [snap({ windows: [{ name: '本周', used: 1, limit: 10, unit: 'usd', percent: pct }] })]
eq(trayTitle(oneWin(10), false), 'W 10%', 'ok 档：**一个转义都没有**（与改动前逐字节相同）')
eq(trayTitle(oneWin(70), false), '\x1b[33mW 70%\x1b[0m', 'warn 档整段包黄')
eq(trayTitle(oneWin(90), false), '\x1b[31mW 90%\x1b[0m', 'danger 档整段包红')
// 余额类没有百分比 → muted 灰色 + 空心点（两处信号必须同时变，见 design Bad case）
eq(trayTitle([balance], false), '\x1b[1;30m¥500.67\x1b[0m', '无百分比 → 灰（用户看到的是金额，不是低用量）')
// 多窗口：每段**各按自己的百分比**上色，不是整条一个颜色
const multi = [
  snap({
    windows: [
      { name: '5 小时', used: 1, limit: 10, unit: 'usd', percent: 5 },
      { name: '本周', used: 1, limit: 10, unit: 'usd', percent: 90 }
    ]
  })
]
eq(trayTitle(multi, false), '5H 5% \x1b[31mW 90%\x1b[0m', '多窗口：只有超阈的那段上色')
eq(stripAnsiTitle(multi, false), '5H 5% W 90%', '剥掉转义后措辞逐字未变')
// ⚠ 前缀与分隔符不着色（reset 之后 attributes 被清空）
eq(trayTitle(oneWin(90), true), '⚠ \x1b[31mW 90%\x1b[0m', '离线 ⚠ 前缀不着色，与颜色叠加不互相覆盖')
eq(
  trayTitle([snap({ ...snap({ windows: oneWin(90)[0].windows }), dataQuality: 'cached' })], false),
  '⚠ \x1b[31mW 90%\x1b[0m',
  '缓存数据：颜色由**百分比**决定，缓存身份由 ⚠ 表达（不混成一个含义）'
)
eq(trayTitle(oneWin(90), false).endsWith(ANSI_RESET), true, '每段以复位码收尾（否则颜色会漏到后面）')

// ─── P1-3 · 图标状态点分层 ──────────────────────────────────────────────────
console.log('\nP1-3 · 图标状态点 badgeOf / trayLevel')
eq(badgeOf('danger'), 'solid-large', 'danger → 实心大点')
eq(badgeOf('warn'), 'translucent', 'warn → 半透明中点')
eq(badgeOf('muted'), 'hollow-small', 'muted → 空心小点')
eq(badgeOf('ok'), 'none', 'ok → **无点**（不给正常状态加噪点）')
eq(trayLevel(oneWin(10)), 'ok', '托盘等级：10% → ok')
eq(trayLevel(oneWin(70)), 'warn', '托盘等级：70% → warn')
eq(trayLevel(oneWin(90)), 'danger', '托盘等级：90% → danger')
eq(trayLevel(multi), 'danger', '多窗口取**最大**百分比（与标题里最红的那段同一个数）')
eq(trayLevel([balance]), 'muted', '余额类无百分比 → muted（与标题灰色同档）')
eq(trayLevel([]), 'ok', '无供应商 → ok（无点，回归现状）')
eq(trayLevel([snap({ status: 'nodata', windows: [] })]), 'ok', '全部未配置 → ok（无点）')
eq(trayLevel([snap({ status: 'error', windows: [] })]), 'ok', '全部出错 → ok（无点）')
// 标题与状态点判的是**同一个等级** —— 一个红一个绿正是本任务要消灭的矛盾。
// ⚠ 判据是「标题里最重的那个 ANSI 码」与 `trayLevel` 的返回值相等，
//   两边各走各的实现（trayTitle 在 shared/tray-text.ts、trayLevel 在 main/tray-badge.ts），
//   真的分叉就会红。把标题剥成纯文案再比就什么都测不到了（那是同一个函数调用两次）。
/** 标题里出现的最重的 ANSI 包裹码 → 等级（无码即 ok） */
const levelOfTitle = (title) => {
  if (title.includes('\x1b[31m')) return 'danger'
  if (title.includes('\x1b[33m')) return 'warn'
  if (title.includes('\x1b[1;30m')) return 'muted'
  return 'ok'
}
for (const [fix, want] of [
  [oneWin(10), 'ok'],
  [oneWin(70), 'warn'],
  [oneWin(90), 'danger'],
  [[balance], 'muted'],
  [multi, 'danger'],
  [[], 'ok']
]) {
  eq([levelOfTitle(trayTitle(fix, false)), trayLevel(fix)], [want, want], `标题与状态点同源（${want}）`)
}

console.log('\nP1-3 · 状态点像素（alpha 分层，template 图标只有 alpha 生效）')
/** 数某形状点亮的像素与峰值 alpha —— 判据是「真的画了东西，且浓淡有别」 */
function badgePixels(shape, size) {
  const px = new Uint8Array(size * size * 4)
  const painted = paintBadge(px, size, shape)
  let n = 0
  let maxA = 0
  for (let i = 3; i < px.length; i += 4) {
    if (px[i] > 0) {
      n++
      maxA = Math.max(maxA, px[i])
    }
  }
  return { painted, n, maxA }
}
const b22ok = badgePixels('none', 22)
eq(b22ok, { painted: false, n: 0, maxA: 0 }, "ok 形状一个像素都不碰（'ok 档逐字节相同'的前提）")
const solid = badgePixels('solid-large', 22)
const trans = badgePixels('translucent', 22)
const hollow = badgePixels('hollow-small', 22)
ok(solid.painted && solid.n > 8, `实心大点画出来了（${solid.n} px）`)
ok(solid.maxA === 255, `实心大点 alpha 满（${solid.maxA}）`)
ok(trans.painted && trans.n > 0, `半透明中点画出来了（${trans.n} px）`)
ok(
  trans.maxA > 0 && trans.maxA < solid.maxA,
  `半透明档 alpha 低于实心档（${trans.maxA} < ${solid.maxA}）—— 这是 macOS 上唯一的浓淡旋钮`
)
ok(hollow.painted && hollow.n > 0, `空心小点画出来了（${hollow.n} px）`)
ok(
  solid.n > trans.n,
  `实心档覆盖多于半透明档（${solid.n} > ${trans.n}）—— 分层要同时靠直径与 alpha`
)
// 2x 必须与 1x 同形：几何按边长比例给，否则高分屏上点会大一圈
const ratio = (a, b) => a / b
ok(
  Math.abs(ratio(badgePixels('solid-large', 44).n, badgePixels('solid-large', 22).n) - 4) < 1.2,
  `2x 覆盖约为 1x 的 4 倍（${badgePixels('solid-large', 44).n} vs ${badgePixels('solid-large', 22).n}）`
)
// 纯度：paintBadge 的越界守卫**在 JS 里测不出来** —— TypedArray 的越界写是静默丢弃，
// 既不抛也不改内存（实测：删掉 `i + 3 >= bgra.length` 后，传短缓冲 / 传 subarray +
// 金丝雀，两种写法都仍然 97/0 全绿）。所以这里不假装能测它，改守真正起作用的那一层：
// **唯一的生产调用点**在画之前先校验了长度。几何本身越不了界（x,y 都被夹在 [0,size-1]），
// 于是长度校验就是全部的防线，它必须留在。
{
  const size = 22
  const full = new Uint8Array(size * size * 4)
  ok(paintBadge(full, size, 'solid-large'), '对照：足额位图会点亮右下角')
  // 传入不足一整份表示的位图时不抛、不写（守卫的语义；能否观测到越界由 JS 决定）
  let threw = false
  try {
    paintBadge(new Uint8Array(4), 1, 'solid-large')
  } catch {
    threw = true
  }
  eq(threw, false, '位图不足一份表示时不抛（守卫在位）')
}
// 生产调用点必须自己校验长度 —— 这是真正生效的那道防线（守卫 6b 在静态段）

// ─── P1-3 · 去重键（形状必须在里面）──────────────────────────────────────────
//
// 这条是本任务最容易静默失效的一处：等级变了但 logo 还是同一个 mark，只按原始 key
// 去重会把换级后的图标整个吞掉 —— 不抛、不红，用户只看到「状态点永远停在旧等级」。
// 把它做成纯函数才有单测入口（tray.ts 本身 import electron，loadTs 加载不了）。
console.log('\nP1-3 · 去重键 trayIconKey')
eq(trayIconKey('opencode', 'none'), 'opencode#none', '键 = mark + 形状')
const shapes = ['none', 'translucent', 'solid-large', 'hollow-small']
eq(
  new Set(shapes.map((s) => trayIconKey('opencode', s))).size,
  4,
  '同一 mark 的四档形状给出**四个不同**的键（否则换级会被去重吃掉）'
)
eq(
  new Set(shapes.map((s) => trayIconKey(s, 'none'))).size,
  4,
  '形状真的进了键里（拿形状当 mark 反向验：键只拼 mark 的话这里会塌成 1）'
)
eq(
  shapes.filter((s) => trayIconKey('opencode', s) === 'opencode'),
  [],
  '没有任何一档的键等于裸 mark（这条就是「形状被漏掉」的精确判据）'
)

// ─── P1-3 · 静态守卫 ────────────────────────────────────────────────────────
console.log('\nP1-3 · 静态守卫')

/** 递归列出 src/ 下的 .ts / .tsx */
function srcFiles(dir = 'src') {
  const out = []
  for (const f of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
    if (f.name === 'node_modules') continue
    const rel = `${dir}/${f.name}`
    if (f.isDirectory()) out.push(...srcFiles(rel))
    else if (/\.tsx?$/.test(f.name)) out.push(rel)
  }
  return out
}
const allSrc = srcFiles()

// 守卫 1 · levelOfPercent 全仓只许**声明**一次（把 85/60 搬回第二处即红）。
// ⚠ 判据数的是**声明点**（function / const / 箭头函数），不是出现次数 ——
//   re-export、import、调用点都必须豁免，否则这条门在第一次搬迁时就红，之后没人敢碰。
// ⚠ 正则必须带 `g`：`exec` 在无 `g` 的正则上永远从第 0 位重试，while 循环不退出
//   （实测踩过：整个套件挂在这一行，不报错、不结束）。
const decls = []
for (const f of allSrc) {
  const src = readFileSync(resolve(ROOT, f), 'utf8')
  const re = /(^|\n)\s*(?:export\s+)?(?:function\s+levelOfPercent\b|(?:const|let|var)\s+levelOfPercent\s*=|levelOfPercent\s*=\s*\()/g
  if (re.test(src)) decls.push(f)
}
ok(allSrc.length > 0, `守卫前置：扫到了源文件（${allSrc.length} 个；一个都没扫到时下面几条会空洞通过）`)
eq(decls, ['src/shared/levels.ts'], 'levelOfPercent 全仓只声明一次，且落在 shared/levels.ts')

// 守卫 2 · 阈值数字只在那一处。判据是**字面量** `>= 85` / `>= 60` 的出现位置。
const levelsSrc = readFileSync(resolve(ROOT, 'src/shared/levels.ts'), 'utf8')
const thresholds = []
for (const f of allSrc) {
  const src = readFileSync(resolve(ROOT, f), 'utf8')
  if (/pct\s*>=\s*85\b/.test(src)) thresholds.push(`${f}:85`)
  if (/pct\s*>=\s*60\b/.test(src)) thresholds.push(`${f}:60`)
}
eq(thresholds, ['src/shared/levels.ts:85', 'src/shared/levels.ts:60'], '85 / 60 两个阈值字面量只在 shared/levels.ts')

// 守卫 3 · 渲染层不得反向依赖主进程（levels.ts 是跨进程的，不许长出方向）
// ⚠ 判据前必须**剥注释**：levels.ts 的头注释里就写着「不 import electron、不碰 DOM」，
//   裸 grep 会匹配到这句说明本身，把一条守纯度的门变成永红（test-structure.mjs §D
//   记的同一个坑：注释里的词）。
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const levelsCode = stripComments(levelsSrc)
ok(levelsSrc.length > 0, '守卫前置：shared/levels.ts 读得到')
ok(!/from '.*\/(main|renderer)\//.test(levelsCode), 'shared/levels.ts 不 import 主进程 / 渲染层')
ok(
  !/\belectron\b|\bdocument\.|window\.|navigator\./.test(levelsCode),
  'shared/levels.ts 不碰 electron / DOM（剥注释后判生效代码；纯 node 可加载）'
)

// 守卫 4 · trayTitle 的拼装只有 tray-text.ts 一处。调用点多一个就意味着
// 有人在自己拼标题（转义会不一致，debug:tray-title 与真实托盘对不上）。
const callSites = []
for (const f of allSrc) {
  const src = readFileSync(resolve(ROOT, f), 'utf8')
  if (f === 'src/shared/tray-text.ts') continue // 定义与本模块内的自用
  if (/\btrayTitle\s*\(/.test(src)) callSites.push(f)
}
eq(callSites.sort(), ['src/main/ipc.ts', 'src/main/tray.ts'], 'trayTitle 的调用点仍只有 ipc.ts 与 tray.ts 两处')

// 守卫 5 · 渲染层**消费者**仍从 format.ts 取等级。
// ⚠ format.ts 本身不在被查集合里 —— 它就是那道 re-export 转发口，豁免它是定义而非放行。
//   真正要防的是有人绕过转发直接引 shared/levels：那样会出现两条 import 路径，
//   迟早一个改了另一个没改（与 tray-text.ts 拆 summaryParts 是同一个理由）。
const rendererConsumers = allSrc.filter(
  (f) =>
    f.startsWith('src/renderer/') &&
    f !== 'src/renderer/src/format.ts' &&
    /\blevelOfPercent\b/.test(readFileSync(resolve(ROOT, f), 'utf8'))
)
ok(
  rendererConsumers.length > 0,
  `守卫前置：渲染层确实在用 levelOfPercent（${rendererConsumers.length} 个消费者）`
)
ok(
  !rendererConsumers.some((f) => /from '.*shared\/levels'/.test(readFileSync(resolve(ROOT, f), 'utf8'))),
  `渲染层消费者仍经 format.ts 取等级（绕过转发就多出一条会分叉的路径；越界文件：${
    rendererConsumers.filter((f) => /from '.*shared\/levels'/.test(readFileSync(resolve(ROOT, f), 'utf8'))).join(', ') || '无'
  }）`
)

// 守卫 6 · 去重键必须**走 trayIconKey**，不许在 tray.ts 里手拼模板串。
// 上面的纯函数断言钉的是 `trayIconKey` 自己；这条钉的是「托盘真的用它」——
// 手拼一个 `\`${key}#${shape}\`` 也能跑，但形状一旦漏掉没有任何断言会红。
// ⚠ 剥注释后再判：tray.ts 的注释里就写着 `#${形状}` 这几个字。
const trayCode = stripComments(readFileSync(resolve(ROOT, 'src/main/tray.ts'), 'utf8'))
ok(trayCode.length > 0, '守卫前置：src/main/tray.ts 读得到')
ok(
  /\btrayIconKey\s*\(/.test(trayCode),
  'tray.ts 的去重键走 trayIconKey()（手拼模板串会让形状漏掉时无人报警）'
)
eq(/`[^`]*#\$\{/.test(trayCode), false, 'tray.ts 不再手拼 `#${…}` 键（形状并进键的口径只有一处）')

// 守卫 6b · 画状态点前必须先校验位图长度。paintBadge 自己的越界守卫在 JS 里**不可测**
// （TypedArray 越界写静默丢弃），几何也越不了界 —— 于是这道长度校验是全部的防线。
ok(
  /\.length\s*<\s*size\s*\*\s*size\s*\*\s*4/.test(trayCode),
  'tray.ts 画状态点前校验位图长度（paintBadge 的内部守卫不可测，这道是唯一生效的防线）'
)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
