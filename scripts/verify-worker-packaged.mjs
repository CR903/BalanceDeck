// 打包态验证：worker 到底能不能在 **asar** 里加载（AC3，本任务的核心门）
//
// 用法：node scripts/verify-worker-packaged.mjs [--app <path>] [--no-install]
//
// 为什么必须单独有这个脚本：`new Worker()` 要一个**真实文件**，而打包态那个文件在
// `app.asar` 里 —— worker 自己的模块加载器认不认 asar，**只在打包态能测出来**。
// dev 态通过完全不代表打包态通过（dev 跑的是 `out/`，根本没有 asar）。
//
// 两次验证缺一不可：
//   ① **正向**：从 `.app` 启动 → 日志里必须出现 `via=worker`。
//      只断言"应用能起来"是不够的 —— 静默降级到主线程时应用一样好好的（而且更快出数），
//      看起来像成功。唯一可信的判据是那条 `via=` 日志。
//   ② **负向**：把 workerPath 指到一个不存在的文件（`BD_LOCAL_SCAN_WORKER`）→
//      必须出现 `via=main degraded=…`，且 rows/pts 与正向那次相当。
//      没有这一步，正向的绿灯也可能只是"反正它总会走主线程"的巧合。
//
// 顺带用 `sample` 取一次**主线程**的调用图：正向那次主线程里不该有 sqlite 帧，
// 负向那次应该有 —— 这是「阻塞真的发生在主线程」的直接证据（AC1）。

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
/** 产品路径固定写这个文件（src/main/adapters/opencode.ts 的 debugLog），所以每轮先清空 */
const LOG = '/tmp/balancedeck-scheduler.log'
const WORKER_REL = 'Contents/Resources/app.asar.unpacked/out/main/local-scan-worker.js'

let pass = 0
let fail = 0

function ok(cond, label) {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}`)
  }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}

function findApp() {
  const explicit = argValue('--app')
  const candidates = [
    explicit,
    '/Applications/BalanceDeck.app',
    join(ROOT, 'dist/mac-arm64/BalanceDeck.app'),
    join(ROOT, 'dist/mac/BalanceDeck.app'),
    join(ROOT, 'dist/mac-universal/BalanceDeck.app')
  ].filter(Boolean)
  return candidates.find((p) => existsSync(join(p, 'Contents/MacOS/BalanceDeck'))) ?? null
}

/**
 * 解析 `sample` 的调用图 → 每个线程的「sqlite 工作帧」条数与**最大样本数**。
 *
 * 四处坑，都实测过：
 *   · **主线程的标签会变**：Electron 启动早期是 `Main Thread`，随后重命名成 `CrBrowserMain`
 *     （同一台机器、同一个应用，两次采样分别拿到这两个名字）。只认其中一个 ⇒
 *     主线程认不出来 ⇒ 它的帧被算到"其余线程"里 ⇒ 结论整个反过来。
 *   · **`Binary Images:` 尾巴里也有 `libsqlite3.dylib` 字样** —— 不切掉就会把静态链接
 *     当成"主线程在做 sqlite"。
 *   · 只数**真干活的**帧（`StatementSync::All` / `sqlite3VdbeExec` …）；`UserDefinedFunction::xDestroy`
 *     这类符号在两侧都会零星出现（符号化偏移的产物），拿它当判据等于没有判据。
 *   · 认不出主线程时**必须让调用方知道**（`mainFound`），否则「主线程 0 帧」是假绿。
 *
 * `maxSamples` 就是「采样窗口里这个线程有多少毫秒陷在 sqlite 里」（`sample` 默认 1ms 一采），
 * 所以它直接可比 AC1 的「无单次 > 200ms 主线程热点」。
 */
function sampleThreads(text) {
  if (!text) return null
  const graph = text.split('\nBinary Images:')[0]
  const blocks = graph.split(/\n(?=\s*\d+ Thread_)/).slice(1)
  if (blocks.length === 0) return null
  const work = /StatementSync::|sqlite3VdbeExec|sqlite3_step|ExtractRowValues|sqlite3Btree|sqlite3Where/
  return blocks.map((b) => {
    const header = b.split('\n')[0].trim()
    let frames = 0
    let maxSamples = 0
    for (const l of b.split('\n')) {
      if (!work.test(l)) continue
      frames++
      const m = l.match(/\s(\d+)\s+\S/)
      if (m) maxSamples = Math.max(maxSamples, Number(m[1]))
    }
    return {
      header,
      isMain: /CrBrowserMain|Main Thread|com\.apple\.main-thread/.test(header),
      frames,
      maxSamples
    }
  })
}

/** 主线程 / 其余线程各自的 sqlite 工作帧数与最大样本数 */
function splitSqliteWork(threads) {
  if (!threads) return null
  const frames = (arr) => arr.reduce((n, t) => n + t.frames, 0)
  const max = (arr) => arr.reduce((n, t) => Math.max(n, t.maxSamples), 0)
  const main = threads.filter((t) => t.isMain)
  const other = threads.filter((t) => !t.isMain)
  return {
    mainFound: main.length > 0,
    mainHeaders: main.map((t) => t.header).join(' | '),
    mainFrames: frames(main),
    mainMax: max(main),
    otherFrames: frames(other),
    otherMax: max(other)
  }
}

/** 从调度器日志里取「本机扫描 full …」那一行的字段 */
function scanLine(log) {
  const line = log.split('\n').find((l) => l.includes('本机扫描 full'))
  if (!line) return null
  const num = (k) => {
    const m = line.match(new RegExp(`${k}=(\\d+)`))
    return m ? Number(m[1]) : null
  }
  const via = line.match(/via=(\w+)/)?.[1] ?? null
  const degraded = line.match(/degraded=(.*)$/)?.[1] ?? null
  return { line, via, degraded, rows: num('rows'), pts: num('pts') }
}

/**
 * 跑一次 `.app` 的 `--smoke`（一轮采集后自动退出），返回 { stdout, log, sample }。
 *
 * `--smoke` 是本仓库既有的 QA 模式：起调度器 → 等 SMOKE_WAIT_MS → 把状态打到 stdout → quit。
 * 首轮采集里必然包含本机全量扫描，所以这一条路径就够验证了。
 * `BD_USER_DATA` 指向临时目录：不动用户的 state/secrets（本机库路径与它无关）。
 */
async function runApp(app, { label, workerPath, waitMs = 25_000, sample = false }) {
  const exe = join(app, 'Contents/MacOS/BalanceDeck')
  const userData = mkdtempSync(join(tmpdir(), 'bd-worker-verify-'))
  writeFileSync(LOG, '')
  const child = spawn(exe, ['--smoke'], {
    env: {
      ...process.env,
      BALANCEDECK_DEBUG: '1',
      BD_USER_DATA: userData,
      SMOKE_WAIT_MS: String(waitMs),
      ...(workerPath ? { BD_LOCAL_SCAN_WORKER: workerPath } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  child.stdout.on('data', (d) => (stdout += d.toString()))
  child.stderr.on('data', (d) => (stdout += d.toString()))

  let sampleText = null
  if (sample) {
    // 采样窗口要**盖住首轮全量**，而它的起点随启动竞争在 3–12s 之间漂（worker 那条路还要
    // 加上线程启动）。固定窗口实测红过两次（两边都是 0 帧）—— 那是最坏的假红：它长得像
    // "worker 没在干活"。所以改成**多轮短窗，直到真的看到 sqlite 工作为止**（最多 4 轮 × 4s）。
    const sampleFile = join(tmpdir(), `balancedeck-worker-sample-${label}.txt`)
    for (let i = 0; i < 4; i++) {
      const r = spawnSync('sample', [String(child.pid), '4', '-file', sampleFile], { encoding: 'utf8' })
      if (!existsSync(sampleFile)) {
        console.log(`  （sample 没产出文件：status=${r.status} err=${r.error?.message ?? '-'} ${(r.stderr ?? '').trim().slice(0, 160)}）`)
        break
      }
      const text = readFileSync(sampleFile, 'utf8')
      sampleText = text
      const w = splitSqliteWork(sampleThreads(text))
      if (w && (w.mainFrames > 0 || w.otherFrames > 0)) break
    }
    console.log(`     采样文件：${sampleFile}`)
  }

  const done = new Promise((res) => child.on('exit', res))
  const timed = await Promise.race([done.then(() => 'exit'), sleep(waitMs + 30_000).then(() => 'timeout')])
  if (timed === 'timeout') {
    child.kill('SIGKILL')
    await done
  }
  const log = existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''
  rmSync(userData, { recursive: true, force: true })
  return { stdout, log, sampleText, timedOut: timed === 'timeout' }
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('打包态 worker 验证（正向 + 负向）')
console.log('──────────────────────────────────────────────────')

const app = findApp()
if (!app) {
  console.log('✗ 找不到打包产物。先跑 `npm run dist:mac`，或用 `--app <path>` 指定。')
  process.exit(1)
}
console.log(`app: ${app}`)

// 0. 产物与 asarUnpack 的落位（信息 + 一条硬断言：worker 文件必须存在）
const unpacked = join(app, WORKER_REL)
const asar = join(app, 'Contents/Resources/app.asar')
{
  console.log(`asar: ${existsSync(asar) ? statSync(asar).size + ' B' : '(无)'}`)
  console.log(`unpacked worker: ${existsSync(unpacked) ? unpacked : '(不在 app.asar.unpacked 下)'}`)
  const chunkDir = join(app, 'Contents/Resources/app.asar.unpacked/out/main/chunks')
  if (existsSync(chunkDir)) {
    const list = spawnSync('ls', [chunkDir], { encoding: 'utf8' }).stdout.trim().split('\n')
    console.log(`unpacked chunks: ${list.join(', ')}`)
  }
  ok(existsSync(unpacked) || existsSync(asar), 'P0 产物存在（asar 或 asarUnpack 至少有一条路）')
}

// 1. 正向：日志里必须出现 via=worker
console.log('\n① 正向：从 .app 启动 → 必须走 worker')
const pos = await runApp(app, { label: 'pos', sample: true })
if (pos.timedOut) console.log('  （应用未在预期时间内退出，已强杀）')
{
  const s = scanLine(pos.log)
  ok(s !== null, 'P1 日志里有「本机扫描 full」那一行（说明首轮全量真的跑了）')
  if (s) {
    console.log(`     ${s.line}`)
    ok(s.via === 'worker', `P2 **via=worker**（不是静默降级到主线程）—— 实测 ${s.via}`)
    ok(s.rows > 0 && s.pts > 0, `P3 真的读到了本机数据（rows=${s.rows} pts=${s.pts}）`)
  }
  ok(!pos.log.includes('本机扫描降级'), 'P4 正向那轮没有出现降级日志')
  const work = splitSqliteWork(sampleThreads(pos.sampleText))
  if (work) {
    console.log(`     sqlite 采样（1ms 一采，数字≈毫秒）：主线程[${work.mainHeaders}] 帧${work.mainFrames}/最大${work.mainMax}ms；其余线程 帧${work.otherFrames}/最大${work.otherMax}ms`)
    ok(work.mainFound, 'P5a 前置：在 sample 里**认出了主线程**（认不出 ⇒ 下面那条"主线程 0 帧"是假绿）')
    // 主线程**会**碰一下 sqlite（它自己那条只读连接上的 `PRAGMA data_version` / `MAX(rowid)`
    // 探针），所以判据不是"0 帧"，而是 AC1 的原话：**单次不得超过 50ms / 200ms**。
    ok(
      work.mainMax <= 50,
      `P5 主线程在 sqlite 里的最长连续样本 ≤ 50ms（AC1 红线；降级对照是 976–1229ms）—— 实测 ${work.mainMax}ms / ${work.mainFrames} 帧`
    )
    ok(work.otherMax > 0, `P6 sqlite 工作在**别的线程**上（worker 真的在干活）—— 实测最长连续 ${work.otherMax}ms`)
  } else {
    console.log('     （未取到 sample，P5/P6 跳过）')
  }
}

// 2. 负向：workerPath 指到不存在的文件 → 必须降级且数据完整
console.log('\n② 负向：把 workerPath 指到不存在的文件 → 必须降级且数据完整')
const neg = await runApp(app, { label: 'neg', workerPath: '/nonexistent/balancedeck-worker.js', sample: true })
if (neg.timedOut) console.log('  （应用未在预期时间内退出，已强杀）')
{
  const s = scanLine(neg.log)
  ok(neg.log.includes('本机扫描降级'), 'N1 出现**降级日志**（降级路径真的被走到了，不是"看起来跑通了"）')
  ok(s !== null, 'N2 日志里仍有「本机扫描 full」那一行')
  if (s) {
    console.log(`     ${s.line}`)
    ok(s.via === 'main', `N3 via=main（回退到主线程同步扫描）—— 实测 ${s.via}`)
    ok(typeof s.degraded === 'string' && s.degraded.length > 0, 'N4 degradedReason 有值（降级必须留痕）')
    ok(s.rows > 0 && s.pts > 0, `N5 数据仍然完整（rows=${s.rows} pts=${s.pts}）`)
  }
  const work = splitSqliteWork(sampleThreads(neg.sampleText))
  if (work) {
    console.log(`     sqlite 采样（1ms 一采，数字≈毫秒）：主线程[${work.mainHeaders}] 帧${work.mainFrames}/最大${work.mainMax}ms；其余线程 帧${work.otherFrames}/最大${work.otherMax}ms`)
    ok(work.mainFound, 'N6a 前置：在 sample 里认出了主线程')
    ok(
      work.mainMax > 200,
      `N6 主线程**陷在 sqlite 里**（降级真的把全量搬回了主线程）—— 实测最长连续 ${work.mainMax}ms（AC1 的红线是 200ms）`
    )
  } else {
    console.log('     （未取到 sample，N6 跳过）')
  }
}

// 3. 两次的规模必须相当（"数据完整"的跨轮判据）
console.log('\n③ 正向 vs 负向：本机数据的规模必须相当')
{
  const a = scanLine(pos.log)
  const b = scanLine(neg.log)
  if (a && b) {
    const drift = Math.abs(a.pts - b.pts)
    ok(drift <= Math.max(5, Math.round(a.pts * 0.01)), `C1 pts 差异 ≤ 1%（正向 ${a.pts} / 负向 ${b.pts}，差 ${drift}；两次之间窗口在前进，允许极小漂移）`)
    ok(Math.abs(a.rows - b.rows) <= Math.max(5, Math.round(a.rows * 0.01)), `C2 rows 差异 ≤ 1%（正向 ${a.rows} / 负向 ${b.rows}）`)
  } else {
    ok(false, 'C1/C2 两次都取到了扫描行（否则无从比较）')
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  console.log('提示：正向失败但负向通过，通常意味着 asar 内加载不了 worker ——')
  console.log('      按 design.md §5 用 electron-builder 的 asarUnpack 把 out/main/** 解出来，再重跑本脚本。')
}
process.exit(fail === 0 ? 0 : 1)
