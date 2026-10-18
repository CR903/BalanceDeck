// uitest flaky 基线：跑 N 轮同一套 --uitest，输出**逐键通过率**与**跨轮翻转键**。
// 用法：node scripts/uitest-baseline.mjs --runs 5 [--user-data /tmp/bd-uitest] [--timeout-ms 300000]
//       [--all] [--keep] [--selftest]
//
// 为什么需要它：`--uitest` 是本仓唯一的运行期验收手段（无 linter、无 CI），它自己 flaky
// 等于每次验收都打折 —— 而且 flaky 的红会被当成「新引入的 bug」，前两个任务的核查代理都
// 额外花时间用 `git archive` 另建 HEAD 基线去自证清白。这个脚本把「自证」变成一条命令：
// 修复前后各跑一次，给出**同口径**的数字。
//
// 为什么解析 stdout 的 JSON 而不是 grep 日志：`src/main/qa/modes.ts` 已经把结果
// `JSON.stringify({ uitest: true, ...results })` 打到 stdout，结构化输出天然稳定；
// grep 会随日志文案变化而误判（本仓有过「断言的是注释里的文案」那种假门）。
//
// ⚠ 跑法纪律（照抄 design.md §4，都是踩过的坑）：
//   ① 每轮用**独立**的临时 BD_USER_DATA（`<base>-r<i>`），绝不用真实 userData ——
//      真实目录里有用户常驻实例在写 secrets.bin / usage-history.json / state.json，
//      两边抢文件既污染断言也污染用户数据。
//   ② 同一时刻只跑一个 uitest 实例（两个窗口互相抢焦点，断言会互相污染）—— 脚本用
//      `/tmp/bd-uitest.lock` 兜住，重复启动会直接退出而不是并行跑。
//   ③ 每轮有**墙钟上界**（默认 5 分钟）。超时记成 `timeout` 而不是让测量卡死 ——
//      实机出现过「整轮挂死」，2026-10-18 定位到它的真实形状是：
//      **断言全部跑完、JSON 已写到 stdout，但 `app.quit()` 没让进程退出**
//      （主进程 0% CPU 空转在 kevent，GPU/渲染/网络 helper 全都还在）。
//      所以本脚本**不等进程退出**：stdout 里一出现 `"uitest": true` 就收下结果并整组杀掉
//      （`detached: true` + `process.kill(-pid)`），把这种轮记成 `exitHang` ——
//      断言结果照常计入通过率（它们真的跑过了），收尾问题另记。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = resolve(ROOT, 'node_modules/.bin/electron')

// ─── 参数 ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { runs: 3, userData: '/tmp/bd-uitest', timeoutMs: 300_000, all: false, keep: false, selftest: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--runs') out.runs = Math.max(1, Number(argv[++i]) || 3)
    else if (a === '--user-data') out.userData = String(argv[++i] ?? out.userData)
    else if (a === '--timeout-ms') out.timeoutMs = Math.max(10_000, Number(argv[++i]) || out.timeoutMs)
    else if (a === '--all') out.all = true
    else if (a === '--keep') out.keep = true
    else if (a === '--selftest') out.selftest = true
  }
  return out
}

// ─── 聚合（纯函数；--selftest 直接喂构造数据）─────────────────────────────────

/** 断言值的三态分类。`fail*` = 红；`ok*` = 绿；`skipped*` = 前置不成立（不算红也不算绿）；其余 = 诊断串 */
export function classify(v) {
  if (typeof v !== 'string') return 'info'
  if (v.startsWith('fail')) return 'fail'
  if (v === 'ok' || v.startsWith('ok')) return 'ok'
  if (v.startsWith('skipped')) return 'skip'
  return 'info'
}

/**
 * 聚合多轮结果。入参每轮：`{ ms, timeout, keys }`（`keys` 为 null = 这轮没产出 JSON）。
 * 翻转键的定义：**既绿过又红过**（`okN > 0 && failN > 0`）—— 只看「不是全绿」会把
 * 恒定红的键也算成翻转，那是另一种问题（漏了产品能力），不该混进 flaky 数字里。
 */
export function aggregate(runs) {
  const keySet = new Set()
  for (const r of runs) if (r.keys) for (const k of Object.keys(r.keys)) keySet.add(k)
  const keys = [...keySet].sort()
  const perKey = keys.map((key) => {
    const vals = runs.map((r) => (r.keys && key in r.keys ? r.keys[key] : '<missing>'))
    // 缺键是**独立的一类**（不是 info）：某一轮没产出这个键意味着那一轮的键集合与别轮不同，
    // 那是 AC9（修复前后键集合相同）要盯的事，不能被归进"诊断串"里静默掉。
    const cls = vals.map((v) => (v === '<missing>' ? 'missing' : classify(v)))
    const okN = cls.filter((c) => c === 'ok').length
    const failN = cls.filter((c) => c === 'fail').length
    const skipN = cls.filter((c) => c === 'skip').length
    const missingN = cls.filter((c) => c === 'missing').length
    const distinct = [...new Set(vals)]
    return {
      key,
      vals,
      okN,
      failN,
      skipN,
      missingN,
      flips: okN > 0 && failN > 0,
      unstable: missingN > 0 || (okN > 0 && failN > 0) || distinct.length > 2,
      diag: [...vals].reverse().find((v) => v.startsWith('fail')) ?? ''
    }
  })
  const flipped = perKey.filter((x) => x.flips)
  const unstable = perKey.filter((x) => x.unstable)
  // 判据键 vs 诊断键：诊断串（`snapDiag` / `intervalDiag` / `consoleErrors`…）的值是现场记录，
  // 天然不带 ok/fail 前缀 —— 混进「通过率」会把它们显示成 0/3（看起来像恒定红），
  // 那是本仓最忌讳的「把诊断读成判据」。分开列，且翻转/不稳定只在判据键上算。
  const isJudgement = (p) => p.okN + p.failN + p.skipN > 0
  const counts = runs.map((r) => (r.keys ? Object.keys(r.keys).length : -1))
  return {
    runs,
    keys,
    perKey,
    judgement: perKey.filter(isJudgement),
    diagnostics: perKey.filter((p) => !isJudgement(p)),
    flipped,
    unstable,
    counts,
    keySetStable: counts.every((c) => c === counts[0]) && counts[0] >= 0,
    timeouts: runs.filter((r) => r.timeout).length,
    exitHangs: runs.filter((r) => r.exitHang).length,
    noResult: runs.filter((r) => !r.keys).length
  }
}

// ─── stdout 解析 ──────────────────────────────────────────────────────────────

/**
 * 从 stdout 里取出 `{"uitest": true, …}` 那个对象。
 * 不按行切：JSON 是 pretty-print 的，用「`"uitest": true` 之前最近的一个 `{`」定位起点，
 * 再用括号配对找终点（配对要跳过字符串内的括号与转义，否则 `document.querySelector('{')`
 * 这类断言串会把终点算错）。
 */
export function extractResult(stdout) {
  const anchor = stdout.lastIndexOf('"uitest": true')
  if (anchor < 0) return null
  const start = stdout.lastIndexOf('{', anchor)
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < stdout.length; i++) {
    const c = stdout[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(stdout.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

// ─── 单轮 ─────────────────────────────────────────────────────────────────────

const fmtMs = (ms) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`)

/**
 * 收到 JSON 之后等进程自己退出的宽限窗口。
 *
 * `app.quit()` 的正常收尾（拆窗口 / 托盘 / 调度器）本身要几百毫秒，所以不能一看到 JSON
 * 就判「收尾卡住」—— 那样每轮都会被标成 `exitHang`，信号就没意义了。
 * 超过这个窗口还没退，才算「断言跑完但进程未退」（实机观测到的 10 分钟不退）。
 */
const JSON_GRACE_MS = 8000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 尽力删掉一轮的临时 userData。
 *
 * ⚠ 不能用裸 `rmSync(recursive)`：刚被整组 SIGKILL 的 helper 还在写这个目录，
 * rimraf 走到一半会抛 `ENOTEMPTY`（实测把整个批跑崩了）。重试几次，最后放弃也无所谓 ——
 * 它只是个临时目录。
 */
async function rmDirBestEffort(dir) {
  for (let i = 0; i < 4; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch {
      await sleep(400)
    }
  }
  return false
}

function runOnce({ userData, timeoutMs, label }) {
  return new Promise((done) => {
    const t0 = Date.now()
    // `detached: true`：让这一轮独占一个**进程组**，收尾时能整组杀掉（主进程 + GPU/渲染/网络
    // helper 全在内）。不这样做的话，主进程死了 helper 还活着，stdio 管道不关 → 'close' 不触发。
    const child = spawn(ELECTRON, ['.', '--uitest'], {
      cwd: ROOT,
      env: { ...process.env, BD_USER_DATA: userData },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })
    let out = ''
    let err = ''
    let timedOut = false
    /** 收到 `"uitest": true` 的时刻（0 = 还没收到） */
    let jsonAt = 0
    /** 断言跑完但进程没退：实机观测到的「整轮挂死」就是这个形状（见文件头注释） */
    let exitHang = false
    let finished = false
    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 已经没了 */
        }
      }
    }
    const finish = (why) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      const ms = Date.now() - t0
      // ⚠ 关键：解析**已经收到**的 stdout，而不是等进程退出。
      //   实机踩过：断言全部跑完、JSON 已写到 stdout，但 `app.quit()` 卡住不退
      //   （主进程 0% CPU 空转在 kevent）—— 旧实现只在 'close' 里解析，于是**永远读不到
      //   结果**，整轮看起来像「挂死」（10 分钟无输出）。这与「断言路径挂死」是两回事：
      //   前者是产品收尾问题（记 `exitHang`），后者才是测试工具的问题。
      const parsed = extractResult(out)
      const keys = parsed ? Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== 'uitest')) : null
      const tag = jsonAt ? (why === 'json' || exitHang ? ' [断言跑完但进程未退]' : '') : timedOut ? ' [timeout]' : ''
      console.log(`  · ${label} ${fmtMs(ms)} ${keys ? `${Object.keys(keys).length} 键` : '无 JSON'}${tag}`)
      if (!keys && err.trim()) console.log(`    stderr: ${err.trim().split('\n').slice(-3).join(' / ').slice(0, 300)}`)
      killGroup()
      done({ ms, timeout: timedOut, exitHang: Boolean(jsonAt) && why !== 'close', keys, stdoutTail: out.slice(-2000), stderrTail: err.slice(-2000) })
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup()
      setTimeout(() => finish('timeout'), 1500)
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      out += d
      // JSON 一到就算这轮结束：不依赖进程退出（上面那段注释）。
      // ⚠ 但**不能立刻判 exitHang**：`app.quit()` 之后正常收尾本身也要几百毫秒
      //   （拆窗口/托盘/调度器）。给一个宽限窗口，窗口内退了 = 正常；没退才是收尾卡住。
      //   2026-10-18 实测：宽限 300ms 会把正常收尾也标成 exitHang（信号失去意义）。
      if (!jsonAt && out.includes('"uitest": true')) {
        jsonAt = Date.now()
        exitHang = true // 先标记；'close' 路径会清掉
        setTimeout(() => finish('json'), JSON_GRACE_MS)
      }
    })
    child.stderr.on('data', (d) => (err += d))
    child.on('close', () => {
      exitHang = false
      finish('close')
    })
    child.on('error', () => finish('error'))
  })
}

// ─── 自检 ─────────────────────────────────────────────────────────────────────

function selftest() {
  let pass = 0
  let fail = 0
  const ok = (cond, label) => {
    if (cond) {
      pass++
      console.log(`  ✓ ${label}`)
    } else {
      fail++
      console.log(`  ✗ ${label}`)
    }
  }
  console.log('\nS. 基线脚本自检（构造数据 → 通过率 / 翻转集合）')
  // 构造：b 真翻转（fail→ok→fail）；c 只红过一轮也算翻转；a 恒绿；d 恒 skip；e 少了一轮；
  //       f 是诊断串（不带 ok/fail 前缀）—— 不许混进通过率
  const runs = [
    { ms: 1000, timeout: false, keys: { a: 'ok', b: 'fail:no-flash', c: 'ok', d: 'skipped:no-card', e: 'ok', f: '{"cards":3}' } },
    { ms: 2000, timeout: false, keys: { a: 'ok', b: 'ok', c: 'fail', d: 'skipped:no-card', e: 'ok', f: '{"cards":4}' } },
    { ms: 3000, timeout: false, keys: { a: 'ok', b: 'fail:no-flash', c: 'ok', d: 'skipped:no-card', f: '{"cards":4}' } }
  ]
  const agg = aggregate(runs)
  const rate = (k) => {
    const x = agg.perKey.find((p) => p.key === k)
    return `${x.okN}/${agg.runs.length}`
  }
  ok(agg.keys.length === 6, `键总数 6（实际 ${agg.keys.length}）`)
  ok(rate('a') === '3/3', `恒绿键 a 通过率 3/3（实际 ${rate('a')}）`)
  ok(rate('b') === '1/3', `翻转键 b 通过率 1/3（实际 ${rate('b')}）`)
  ok(rate('c') === '2/3', `翻转键 c 通过率 2/3（实际 ${rate('c')}）`)
  ok(rate('d') === '0/3' && agg.perKey.find((p) => p.key === 'd').skipN === 3, 'skip 不算绿也不算红')
  ok(
    agg.flipped.map((x) => x.key).join(',') === 'b,c',
    `翻转集合 = [b,c]（实际 [${agg.flipped.map((x) => x.key).join(',')}]）`
  )
  ok(agg.flipped.find((x) => x.key === 'b').diag === 'fail:no-flash', '翻转键带最后一轮诊断串')
  ok(agg.keySetStable === false, '键集合不稳定（e 少了一轮）能被判出来')
  ok(agg.unstable.map((x) => x.key).join(',') === 'b,c,e', `不稳定集合含缺失键（实际 [${agg.unstable.map((x) => x.key).join(',')}]）`)
  ok(
    agg.judgement.map((x) => x.key).join(',') === 'a,b,c,d,e',
    `判据键 = [a,b,c,d,e]（诊断串 f 不算，实际 [${agg.judgement.map((x) => x.key).join(',')}]）`
  )
  ok(agg.diagnostics.map((x) => x.key).join(',') === 'f', `诊断键 = [f]（实际 [${agg.diagnostics.map((x) => x.key).join(',')}]）`)
  // 解析器：字符串里带括号 / 转义也要配平
  const fake = 'noise\n{\n  "uitest": true,\n  "x": "fail:selector({) escaped \\"q\\"",\n  "y": "ok"\n}\ntrailing'
  const parsed = extractResult(fake)
  ok(parsed && parsed.x === 'fail:selector({) escaped "q"' && parsed.y === 'ok', 'extractResult 跳过字符串内的括号与转义')
  ok(extractResult('nothing here') === null, '没有 JSON 时返回 null（不抛）')
  // 收尾形态：完全没跑完（noResult）与「断言跑完但进程未退」（exitHang）必须分开计
  const aggNoResult = aggregate([...runs, { ms: 5000, timeout: true, exitHang: false, keys: null }])
  ok(aggNoResult.noResult === 1 && aggNoResult.keySetStable === false, '完全没产出 JSON 的轮计成 noResult 且键集合判不稳')
  const aggHang = aggregate([{ ms: 1, timeout: false, exitHang: true, keys: { a: 'ok' } }])
  ok(aggHang.exitHangs === 1 && aggHang.noResult === 0, '「断言跑完但进程未退」计成 exitHang 但不计 noResult（结果仍可用）')
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
  return fail === 0 ? 0 : 1
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

async function main() {
  const opt = parseArgs(process.argv.slice(2))
  if (opt.selftest) process.exit(selftest())

  const lock = '/tmp/bd-uitest.lock'
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf-8').trim())
    let alive = false
    try {
      process.kill(pid, 0)
      alive = true
    } catch {
      alive = false
    }
    if (alive) {
      console.error(`已有 uitest 基线在跑（pid ${pid}，锁 ${lock}）。两个实例会互相抢焦点污染断言 —— 先等它跑完。`)
      process.exit(2)
    }
    unlinkSync(lock)
  }
  writeFileSync(lock, String(process.pid))

  try {
    if (!existsSync(ELECTRON)) {
      console.error(`找不到 electron：${ELECTRON}`)
      process.exit(2)
    }
    console.log(`uitest flaky 基线：${opt.runs} 轮，每轮独立 BD_USER_DATA=${opt.userData}-r<i>，墙钟上界 ${fmtMs(opt.timeoutMs)}`)
    console.log('⚠ 跑之前请确认 out/ 是最新构建（npm run build）—— 否则测的是上一次的 bundle。\n')
    const runs = []
    for (let i = 1; i <= opt.runs; i++) {
      const dir = `${opt.userData}-r${i}`
      mkdirSync(dir, { recursive: true })
      const res = await runOnce({ userData: dir, timeoutMs: opt.timeoutMs, label: `run ${i}/${opt.runs}` })
      runs.push(res)
      if (!opt.keep) {
        const gone = await rmDirBestEffort(dir)
        if (!gone) console.log(`    （临时目录 ${dir} 没删掉：被刚杀掉的 helper 占着，无害）`)
      }
    }

    const agg = aggregate(runs)
    const n = runs.length
    console.log('\n── 每轮耗时 ──')
    console.log(
      runs
        .map((r, i) => `run${i + 1}: ${fmtMs(r.ms)}${r.exitHang ? '（断言跑完但进程未退）' : ''}${!r.keys ? '（无结果）' : ''}`)
        .join(' / ')
    )
    console.log(`\n── 键总数 ──`)
    console.log(`${agg.counts[0]}（各轮 ${agg.counts.join('/')}）${agg.keySetStable ? '' : '  ⚠ 键集合不稳定 —— AC9 要求修复前后键集合相同'}`)

    console.log('\n── 逐键通过率（判据键）──')
    for (const p of agg.judgement) {
      if (!opt.all && p.okN === n) continue
      console.log(`${p.key}: ${p.okN}/${n}${p.skipN ? `（${p.skipN} 轮 skip）` : ''}${p.flips ? '  ← 翻转' : ''}${p.missingN ? `（${p.missingN} 轮缺该键）` : ''}`)
    }
    if (!opt.all) console.log(`（只列非满勤键；--all 打印全部 ${agg.judgement.length} 个判据键）`)
    console.log(`判据键 ${agg.judgement.length} 个 / 诊断键 ${agg.diagnostics.length} 个（后者不参与通过率）`)

    console.log('\n── 跨轮翻转键 ──')
    if (!agg.flipped.length) console.log('无（每一条要么全绿、要么全红）')
    for (const p of agg.flipped) console.log(`${p.key}（值序列 ${p.vals.join(',')}）`)

    console.log('\n── 恒定红键（不是 flaky，但没被掩盖）──')
    const alwaysRed = agg.perKey.filter((p) => p.failN === n)
    if (!alwaysRed.length) console.log('无')
    for (const p of alwaysRed) console.log(`${p.key}: ${p.diag.slice(0, 160)}`)

    console.log('\n── 诊断键（现场记录，不参与通过率）──')
    for (const p of agg.diagnostics) console.log(`${p.key}: ${String(p.vals[p.vals.length - 1]).slice(0, 160)}`)

    console.log('\n── 诊断摘要（每个失败键附最后一轮的 diag）──')
    for (const p of agg.judgement.filter((x) => x.diag)) console.log(`${p.key}: ${p.diag.slice(0, 200)}`)

    if (agg.exitHangs)
      console.log(
        `\n⚠ ${agg.exitHangs} 轮「断言跑完但进程未退」：JSON 已写到 stdout，但 app.quit() 没让进程退出（主进程 0% CPU 空转）。这些轮的断言结果**计入**通过率（真的跑过了），收尾问题记进存疑。`
      )
    if (agg.noResult) console.log(`\n⚠ ${agg.noResult} 轮完全没产出 JSON（墙钟上界 ${fmtMs(opt.timeoutMs)} 内没跑完）—— 见存疑。`)

    const outFile = `${opt.userData}-runs.json`
    writeFileSync(outFile, JSON.stringify(runs, null, 2))
    console.log(`\n原始结果已写入 ${outFile}`)
    const bad = agg.flipped.length + (agg.keySetStable ? 0 : 1) + agg.noResult
    console.log(
      bad === 0
        ? `\n结论：翻转键 0，键集合稳定 ✅${agg.exitHangs ? `（${agg.exitHangs} 轮收尾未退，不影响结果）` : ''}`
        : `\n结论：翻转键 ${agg.flipped.length} / 键集合不稳 ${agg.keySetStable ? 0 : 1} / 无结果 ${agg.noResult} ❌`
    )
    process.exit(bad === 0 ? 0 : 1)
  } finally {
    try {
      unlinkSync(lock)
    } catch {
      /* 已被清掉 */
    }
  }
}

main()
