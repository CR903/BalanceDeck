// CLI / JSON 快照导出测试（src/main/cli/）
// 用法：node scripts/test-cli-export.mjs
//
// 覆盖：argv 解析、buildSnapshot 的契约与隐私红线、缺失值纪律、纯度、
//       renderTable、export-writer 的哈希去重与写失败不抛、
//       runExportCommand 的三条退出码路径、以及**三条机制守卫**
//       （cli/ 不 import electron / 不碰凭据 / 写盘点在 index.ts 而非 scheduler）。
//
// 全部经 loadTs 加载**真实源码**（scripts/lib/load-ts.mjs）：一个实现都不内联。
// 落盘位置一律是 mkdtemp 建出来的临时目录：**不得写真实 userData**。

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadTs } from './lib/load-ts.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const { buildSnapshot, EXPORT_SCHEMA_VERSION, EXPORT_FILE_NAME } = await loadTs('src/main/cli/export-snapshot.ts')
const { parseExportArgs, renderTable, runExportCommand, parseExportedSnapshot, EXIT_OK, EXIT_USAGE, EXIT_NO_DATA } =
  await loadTs('src/main/cli/export-command.ts')
const { createExportWriter } = await loadTs('src/main/cli/export-writer.ts')

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

const T0 = 1_700_000_000_000
const ISO0 = new Date(T0).toISOString()

/**
 * 一条夹具快照。
 *
 * ⚠ 故意带上**三个不该进导出的字段**，且其中两个各含一块真实隐私：
 *   · `source` 里是 opencode.ts 的 keyTag —— **API key 尾 4 位**（…9dFe）
 *   · `failureReason` 里是 GitHub 用户名（copilot.ts:159 那类自由文案）
 * 这两个是 D4 隐私红线的守门人样本：一旦有人「顺手把整个 snapshot 序列化出去」，
 * 下面的负向断言立刻报红。
 */
function fixture(over = {}) {
  return {
    id: 'opencode',
    name: 'OpenCode Go',
    kind: 'coding',
    builtin: false,
    status: 'ok',
    source: '控制台（精确） + API · 账号1(…9dFe)',
    detail: '响应体预览 {"plan":"go"}',
    failureReason: '鉴权失败：GitHub 用户 octocat',
    degradedReason: '离线',
    models: [{ model: 'gpt-5', cost: 1, tokens: 2 }],
    mark: 'opencode',
    plan: 'Go 套餐',
    dataQuality: 'official',
    updatedAt: ISO0,
    windows: [
      { name: '5 小时', used: 0.62, limit: 12, unit: 'usd', resetAt: new Date(T0 + 3600_000).toISOString() },
      { name: '本周', used: 3, limit: 10, unit: 'usd' }
    ],
    ...over
  }
}

const stateOf = (snapshots, over = {}) => ({ snapshots, lastSync: ISO0, scanning: false, ...over })

/** 临时目录 + 落在里面的导出文件；返回时目录被清掉 */
function withFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bd-export-'))
  const file = join(dir, EXPORT_FILE_NAME)
  if (content !== null) writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf-8')
  try {
    return fn(file, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ═══ A. argv 解析 ═════════════════════════════════════════════════════════════
console.log('\nA. parseExportArgs')

eq(parseExportArgs([]), { json: false, out: null, unknown: null, missingValue: false }, 'A1 无参数 → 表格档')
eq(parseExportArgs(['--json']), { json: true, out: null, unknown: null, missingValue: false }, 'A2 --json')
eq(parseExportArgs(['--out', '/tmp/x.json']),
  { json: false, out: '/tmp/x.json', unknown: null, missingValue: false }, 'A3 --out <path>')
eq(parseExportArgs(['--json', '--out', 'p']),
  { json: true, out: 'p', unknown: null, missingValue: false }, 'A4 两个参数都在')
eq(parseExportArgs(['--out', 'p', '--json']),
  { json: true, out: 'p', unknown: null, missingValue: false }, 'A5 顺序无关')
eq(parseExportArgs(['foo']), { json: false, out: null, unknown: 'foo', missingValue: false }, 'A6 未知命令被认出（不猜）')
eq(parseExportArgs(['--out']), { json: false, out: null, unknown: null, missingValue: true }, 'A7 --out 缺值')
eq(parseExportArgs(['--json', '--out']), { json: true, out: null, unknown: null, missingValue: true },
  'A8 --out 缺值时 --json 仍被认出')
// 下一个 token 是选项时不能被当成路径吃掉
eq(parseExportArgs(['--out', '--json']),
  { json: true, out: null, unknown: null, missingValue: true }, 'A9 --out 后面跟选项 → 缺值而不是吃掉它')
// 非数组入参不崩（脏调用方）
eq(parseExportArgs(undefined).json, false, 'A10 argv 脏值退回表格档，不抛')

// ═══ B. buildSnapshot 的契约 ════════════════════════════════════════════════
console.log('\nB. buildSnapshot 契约')

const doc = buildSnapshot(stateOf([fixture()]), T0)
eq(doc.schemaVersion, EXPORT_SCHEMA_VERSION, 'B1 带 schemaVersion')
eq(EXPORT_SCHEMA_VERSION, 1, 'B2 schemaVersion = 1')
eq(doc.generatedAt, ISO0, 'B3 generatedAt 由入参 now 决定（不读自己的钟）')
eq(doc.offline, false, 'B4 offline 缺省 false')
eq(doc.providers.length, 1, 'B5 providers 与 snapshots 一一对应')

const p = doc.providers[0]
eq(p.id, 'opencode', 'B6 id')
eq(p.name, 'OpenCode Go', 'B7 name')
eq(p.kind, 'coding', 'B8 kind')
eq(p.status, 'ok', 'B9 status')
eq(p.dataQuality, 'official', 'B10 dataQuality 透传')
eq(p.updatedAt, ISO0, 'B11 updatedAt')
eq(p.windows.length, 2, 'B12 windows 逐个搬运')

console.log('\nC. 隐私红线：契约层面不导自由文案（design.md D4）')

// ⚠ 这一节是本任务最贵的一条约束的守门人。逐个 key 断言，不是只断言「序列化后不含某串」
for (const k of ['source', 'detail', 'failureReason', 'degradedReason', 'models', 'modelsByWindow', 'mark', 'plan']) {
  ok(!(k in p), `C1 导出供应商不含 ${k}`)
}
const json = JSON.stringify(doc)
ok(!json.includes('9dFe'), 'C2 导出里没有 API key 尾 4 位（source 的 keyTag）')
ok(!json.includes('octocat'), 'C3 导出里没有 GitHub 用户名（failureReason）')
ok(!json.includes('控制台（精确）'), 'C4 导出里没有自由文案来源串')

console.log('\nD. 缺失值纪律（null 不变 0）')

const bal = buildSnapshot(
  stateOf([fixture({
    dataQuality: undefined,
    windows: [
      // 余额类：没有 limit → percent 不可知
      { name: '账户余额', used: 1288.5, unit: 'usd' },
      // limit 显式 0（types.ts:18「0 或缺省 = 限额未知」）→ 也不该推出百分比
      { name: '额度', used: 3, limit: 0, unit: 'usd' }
    ]
  })]),
  T0
)
eq(bal.providers[0].dataQuality, 'official', 'D1 dataQuality 缺省按 official（types.ts:77）')
eq(bal.providers[0].windows[0].limit, null, 'D2 limit 缺失 → null（不是 0）')
eq(bal.providers[0].windows[0].percent, null, 'D3 余额类窗口 percent 不可知 → null（不是 0%）')
eq(bal.providers[0].windows[1].limit, 0, 'D4 limit 显式 0 原样保留（它是「未知」的合法写法）')
eq(bal.providers[0].windows[1].percent, null, 'D5 limit=0 时 percent 仍是 null，不按 used/0 算')
eq(bal.providers[0].windows[0].resetAt, null, 'D6 resetAt 缺失 → null（不是空串）')

// 官方直报的 percent 优先于 used/limit 推算
const offPct = buildSnapshot(stateOf([fixture({
  windows: [{ name: '本月', used: 5, limit: 10, unit: 'usd', percent: 3.333 }]
})]), T0)
eq(offPct.providers[0].windows[0].percent, 3.3, 'D7 官方直报 percent 优先且归一化到一位小数')
// 两者都没有时回退 used/limit
const derived = buildSnapshot(stateOf([fixture({
  windows: [{ name: '本周', used: 3, limit: 10, unit: 'usd' }]
})]), T0)
eq(derived.providers[0].windows[0].percent, 30, 'D8 无官方 percent 时回退 used/limit')

console.log('\nE. dataQuality 三态透传 + 空快照')

for (const q of ['official', 'cached', 'local']) {
  eq(buildSnapshot(stateOf([fixture({ dataQuality: q })]), T0).providers[0].dataQuality, q,
    `E1 dataQuality=${q} 原样透传（搬运，不是判断）`)
}
eq(buildSnapshot(stateOf([], { offline: true }), T0),
  { schemaVersion: 1, generatedAt: ISO0, offline: true, providers: [] },
  'E2 空快照 → providers: [] 且 offline 透传（空数据是有效状态）')
ok(buildSnapshot({ snapshots: [], lastSync: null, scanning: true }, T0).providers.length === 0,
  'E3 采集中的空状态不抛')

console.log('\nF. 纯度：buildSnapshot 不修改入参')

const inSnap = fixture()
const inState = stateOf([inSnap], { offline: false })
const before = JSON.stringify(inState)
buildSnapshot(inState, T0)
eq(JSON.stringify(inState), before, 'F1 入参 AppState 逐字未变（纯函数）')

console.log('\nG. renderTable')

const table = renderTable(doc)
ok(table.includes('OpenCode Go'), 'G1 含供应商名')
ok(table.includes('5 小时'), 'G2 含窗口名')
ok(/5\.2%/.test(table), `G3 含百分比（5 小时 0.62/12 = 5.2%）：${table.split('\n')[1] ?? ''}`)
ok(/30%/.test(table), 'G4 第二个窗口的百分比也在（3/10 = 30%）')
ok(table.includes(`格式 v${EXPORT_SCHEMA_VERSION}`), 'G5 标了格式版本')
ok(!renderTable(buildSnapshot(stateOf([], {}), T0)).includes('undefined'), 'G6 空快照渲染不出现 undefined')
ok(renderTable(buildSnapshot(stateOf([], {}), T0)).includes('暂无数据'), 'G7 空快照给一句人话而不是空行')
const cachedTable = renderTable(buildSnapshot(stateOf([fixture({ dataQuality: 'cached' })]), T0))
ok(cachedTable.includes('缓存'), `G8 cached 在表格里看得见（否则脚本会当实时数据）：${cachedTable.split('\n')[1] ?? ''}`)
ok(renderTable(buildSnapshot(stateOf([fixture({ dataQuality: 'local' })]), T0)).includes('本机'), 'G9 local 也标注')
const errTable = renderTable(buildSnapshot(stateOf([fixture({ status: 'error', windows: [] })]), T0))
ok(errTable.includes('error'), 'G10 非 ok 状态在表格里显形')

console.log('\nH. 机制守卫：导出文件格式校验')

ok(EXPORT_FILE_NAME, 'H0 前置：导出文件名有定义（下面的负向断言不能空洞通过）')
eq(parseExportedSnapshot(JSON.stringify(doc)).ok, true, 'H1 自己写出的快照能被自己读回')
eq(parseExportedSnapshot('{ not json').ok, false, 'H2 损坏文件 → 明确「不合法」而不是抛')
eq(parseExportedSnapshot('{notjson').reason, '不是合法 JSON', 'H3 损坏给出人话原因')
eq(parseExportedSnapshot('[]').ok, false, 'H4 顶层不是对象 → 不认')
eq(parseExportedSnapshot(JSON.stringify({ schemaVersion: 99, providers: [] })).ok, false,
  'H5 不认识的 schemaVersion → 不按老格式猜')
ok(parseExportedSnapshot(JSON.stringify({ schemaVersion: 99, providers: [] })).reason.includes('99'),
  'H6 原因里带上实际读到的版本号')
eq(parseExportedSnapshot(JSON.stringify({ schemaVersion: 1 })).ok, false, 'H7 providers 缺失 → 不认')
eq(parseExportedSnapshot(JSON.stringify({ schemaVersion: 1, providers: [null] })).ok, false, 'H8 providers 里有 null → 不认')

console.log('\nI. runExportCommand 的三条退出码')

withFile(null, (file) => {
  const r = runExportCommand({ argv: [], filePath: () => file, now: T0 })
  eq(r.code, EXIT_NO_DATA, 'I1 没有导出文件 → 退出码 2（去启动应用）')
  ok(r.err.includes('请先启动一次 BalanceDeck'), 'I2 并说清下一步该做什么')
  eq(r.out, '', 'I3 出错时 stdout 保持空（别把提示混进 JSON）')
})
withFile('{ broken', (file) => {
  const r = runExportCommand({ argv: ['--json'], filePath: () => file, now: T0 })
  eq(r.code, EXIT_NO_DATA, 'I4 格式不认识 → 退出码 2（不是解析崩溃）')
  ok(r.err.includes('格式不认识'), 'I5 明确说「格式不认识」')
})
withFile(doc, (file) => {
  const r = runExportCommand({ argv: ['--json'], filePath: () => file, now: T0 })
  eq(r.code, EXIT_OK, 'I6 正常读 → 退出码 0')
  eq(JSON.parse(r.out).schemaVersion, EXPORT_SCHEMA_VERSION, 'I7 --json 输出可被 JSON.parse')
  eq(JSON.parse(r.out).providers[0].id, 'opencode', 'I8 --json 内容与写盘的一致')
  const t = runExportCommand({ argv: [], filePath: () => file, now: T0 })
  eq(t.code, EXIT_OK, 'I9 无参数 → 退出码 0（人类可读）')
  ok(t.out.includes('OpenCode Go') && !t.out.trimStart().startsWith('{'), 'I10 无参数输出的是表格不是 JSON')
  ok(t.out.endsWith('\n'), 'I11 stdout 以换行结尾（终端友好）')
})
withFile(doc, (file, dir) => {
  const out = join(dir, 'sub', 'x.json')
  const r = runExportCommand({ argv: ['--json', '--out', out], filePath: () => file, now: T0 })
  eq(r.code, EXIT_USAGE, 'I12 --out 到不存在的目录 → 退出码 1')
  ok(r.err.includes('写不进'), 'I13 说明是写失败')
  eq(r.out, '', 'I14 **不静默改写 stdout**（写不进去就报错，不是换个地方输出）')
  ok(!existsSync(out), 'I15 没有偷偷建目录（静默 mkdir -p 是意外行为）')
})
withFile(doc, (file, dir) => {
  const out = join(dir, 'x.json')
  const r = runExportCommand({ argv: ['--json', '--out', out], filePath: () => file, now: T0 })
  eq(r.code, EXIT_OK, 'I16 --out 正常写 → 退出码 0')
  eq(JSON.parse(readFileSync(out, 'utf-8')).providers[0].id, 'opencode', 'I17 写出去的内容是同一份')
  eq(r.out, '', 'I18 --out 档 stdout 安静（脚本可以重定向）')
})
withFile(doc, (file) => {
  eq(runExportCommand({ argv: ['nope'], filePath: () => file, now: T0 }).code, EXIT_USAGE, 'I19 未知参数 → 退出码 1')
  eq(runExportCommand({ argv: ['--out'], filePath: () => file, now: T0 }).code, EXIT_USAGE, 'I20 缺值 → 退出码 1')
  eq(EXIT_OK + EXIT_USAGE + EXIT_NO_DATA, 3, 'I21 三个退出码互不相同（脚本靠它们分支）')
})

console.log('\nJ. export-writer：哈希去重 + 写失败不抛')

withFile(null, (file, dir) => {
  const w = createExportWriter({ filePath: () => file })
  const s = stateOf([fixture()])
  w.maybeWrite(s, T0)
  ok(existsSync(file), 'J1 第一次调用真的写了盘')
  const h1 = w.lastHash()
  ok(typeof h1 === 'string' && h1.length === 40, `J2 lastHash 是一个定长摘要（实得 ${String(h1).length} 位）`)
  w.maybeWrite(s, T0 + 60_000)
  eq(w.lastHash(), h1, 'J3 内容没变 → 哈希不变（60s 一轮不会变成每天 1440 次写盘）')
  // generatedAt 变了但内容没变 → 仍然不写（否则去重等于没有）
  w.maybeWrite(s, T0 + 3_600_000)
  eq(w.lastHash(), h1, 'J4 只有 generatedAt 变时也判定「内容没变」')
  w.maybeWrite(stateOf([fixture({ dataQuality: 'cached' })]), T0 + 7_200_000)
  ok(w.lastHash() !== h1, 'J5 内容真变了 → 哈希变（下一轮会写盘）')
  eq(JSON.parse(readFileSync(file, 'utf-8')).providers[0].dataQuality, 'cached', 'J6 盘上是新内容')
  // 写失败必须只记日志、不抛（导出是增值功能，不能拖垮采集）
  const bad = createExportWriter({ filePath: () => join(dir, 'no-such-dir', 'x.json') })
  let threw = null
  try {
    bad.maybeWrite(s, T0)
  } catch (e) {
    threw = e
  }
  eq(threw, null, 'J7 写盘失败不抛（采集是主路径）')
})

console.log('\nK. 机制守卫：三条边界')

const cliFiles = readdirSync(resolve(ROOT, 'src/main/cli')).filter((f) => f.endsWith('.ts')).sort()
const cliSrc = cliFiles.map((f) => readFileSync(resolve(ROOT, 'src/main/cli', f), 'utf-8'))
const cliCode = cliSrc.map((s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')).join('\n')

ok(cliCode.trim().length > 0, 'K0 前置：cli/ 源码读得到（下面的负向断言不能空洞通过）')
ok(cliFiles.length >= 3, `K1 cli/ 至少三个模块（当前 ${cliFiles.join(', ')}）`)
ok(!/from 'electron'/.test(cliCode), 'K2 cli/ 不 import electron（能被 loadTs 在纯 node 里加载）')
ok(!/keystore|safeStorage|secrets\.bin|getKey\(|setKey\(/.test(cliCode),
  'K3 cli/ 不碰任何凭据通道（CLI 绝不能重写 secrets.bin）')
ok(!/getExtra|setExtra|\bextras\b/.test(cliCode),
  'K4 cli/ 不走 extras（setExtra 每次全量重写整个 secrets.bin）')
ok(/windowPercent/.test(cliCode), 'K5 百分比只有一个实现（经 shared/percent，不自己算）')
ok(/staleLabel/.test(cliCode), 'K6 可信度判断复用 shared/quality（不写第二份 dataQuality === …）')

const indexRaw = readFileSync(resolve(ROOT, 'src/main/index.ts'), 'utf-8')
const indexCode = indexRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
ok(/function pushState[\s\S]*?exportWriter\.maybeWrite\(/.test(indexCode),
  'K7 写盘点挂在 index.ts 的 pushState 上（不改 scheduler.ts）')
ok(/process\.argv\.slice\(app\.isPackaged \? 1 : 2\)/.test(indexCode),
  'K8 argv 按 isPackaged 切片（开发态 argv 多一个 app 路径）')
ok(!/\bapp\.argv\b/.test(indexRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
  'K9 不用 app.argv（实测本机 Electron 37 里它是 undefined）')
ok(/app\.exit\(/.test(indexCode), 'K10 用 app.exit(code) 而不是 app.quit()（退出码是脚本的契约）')

const schedCode = readFileSync(resolve(ROOT, 'src/main/scheduler.ts'), 'utf-8')
ok(!/from '\.\/cli\//.test(schedCode), 'K11 scheduler 不 import cli/（本任务的写盘点不许碰 scheduler）')
// ⚠ 判据必须用**剥掉注释**的源码：'requestSingleInstanceLock' 这个词就写在
//   export-writer.ts 的注释里（解释为什么两进程隔离），拿原文判会永远为红。
//   同 quality-guidelines 的「不要断言注释里出现的文本」。
ok(!/requestSingleInstanceLock/.test(indexCode + cliCode + schedCode),
  'K12 全仓仍无单实例锁（两进程隔离是「CLI 纯读」这个设计的前提）')

console.log(`\n通过 ${pass} · 失败 ${fail}`)
if (fail > 0) process.exit(1)