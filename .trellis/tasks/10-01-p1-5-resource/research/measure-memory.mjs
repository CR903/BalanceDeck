#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// BalanceDeck 常驻内存实测（实现前调研用，不改任何仓库代码）
//
//   node .trellis/tasks/10-01-p1-5-resource/research/measure-memory.mjs <ball|figure> [秒数]
//
// 做法
// ─────
// 1) 建一次性 BD_USER_DATA 目录并 seed 两样东西：
//      secrets.bin → { version:1, items:{}, extras:{ 'ui:pet':'0'|'1' } }
//        store.ts 的 extras 是**明文**（见 store.ts:12 的磁盘格式注释），
//        overlay.primePrefs 直接 getExtra('ui:pet') 决定形态
//      state.json  → { collapsed:true }
//        overlay.loadPersisted 读它决定建窗尺寸；不 collapsed 就建 384×600 展开态，
//        展开态里根本没有 PetBall，测不到收起态
// 2) 直接 spawn Electron 二进制（不经 npx —— npx 会多一层 node，且拿不到真实主进程 pid）
// 3) 每 250ms `ps -Ao pid,ppid,rss,args`，**只认自己 spawn 出来的那棵子树**（按 ppid 走）
// 4) 三个点额外采 `footprint -p`（macOS 的 phys_footprint：把 Chromium 在各进程间共享的
//    框架页按比例摊开，是「这段代码真实占多少物理内存」的诚实口径；sum-of-RSS 会重复计数）
// 5) 加 --log-net-log（Chromium 开关，非 Electron API）：落一份网络日志，
//    用它判定渲染层到底请求了哪些 chunk —— 这是「默认形态有没有加载 3D 代码」的直接证据
//
// 为什么不用 --uitest：已知 flake（petFigureUnchanged 因 DPR=1 报红；进程常打完 JSON 不自行
// 退出），采样窗口长度会变得不确定。--smoke 干净且自带 app.quit()。
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../../../..')
const MODE = process.argv[2] ?? 'ball'
const WAIT_SEC = Number(process.argv[3] ?? 30)
// 第 4 个参数：collapsed（默认 1）。收起态才会起两条 90ms 轮询（主进程光标轮询
// overlay.ts:433 + 渲染层命中区上报 PetBall.tsx:332），展开态不起 —— 量 CPU 时要分开。
const COLLAPSED = (process.argv[4] ?? '1') !== '0'
const PET = MODE === 'figure' ? '1' : '0'
const TMP = '/private/var/folders/f7/l6wj46ps3p74mm412hdknnqh0000gn/T/opencode'
const UD = join(TMP, `bd-mem-${MODE}`)
const NETLOG = join(TMP, `bd-mem-${MODE}-netlog.json`)
const LOG = join(TMP, `bd-mem-${MODE}.stdout.log`)
const ELECTRON = join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')

const MB = (kb) => (kb / 1024).toFixed(1)
const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)] }
const pct = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * p))] }

rmSync(UD, { recursive: true, force: true })
rmSync(NETLOG, { force: true })
mkdirSync(UD, { recursive: true })
writeFileSync(join(UD, 'secrets.bin'), `{"version":1,"items":{},"extras":{"ui:pet":"${PET}"}}`)
writeFileSync(join(UD, 'state.json'), JSON.stringify(COLLAPSED ? { collapsed: true } : {}))

/** ps 的 time 字段（macOS 上形如 `MM:SS.ss`，累计 CPU 时间）→ 秒 */
function cpuSec(s) {
  s = s.trim()
  let days = 0
  if (s.includes('-')) { const p = s.split('-'); days = Number(p[0]); s = p[1] }
  const t = s.split(':').map(Number)
  return days * 86400 + (t.length === 3 ? t[0] * 3600 + t[1] * 60 + t[2] : t[0] * 60 + t[1])
}

console.log('═══════════════════════════════════════════════════════════════════')
console.log(`  mode = ${MODE}   (secrets.bin extras: 'ui:pet' = '${PET}')`)
console.log(`  SMOKE_WAIT_MS = ${WAIT_SEC * 1000}`)
console.log(`  BD_USER_DATA = ${UD}`)
console.log(`  date = ${new Date().toISOString()}`)
console.log(`  host = macOS ${execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()} ${execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim()}`)
console.log(`  electron = ${JSON.parse(readFileSync(join(ROOT, 'node_modules/electron/package.json'), 'utf8')).version}   node = ${process.version}`)
console.log('═══════════════════════════════════════════════════════════════════')

/** 采一次 ps，返回 {pid, ppid, rssKB, type, args} 全表（不过滤，后面按自己的树筛） */
function psAll() {
  let out = ''
  try { out = execFileSync('ps', ['-Ao', 'pid,ppid,rss,args'], { encoding: 'utf8', maxBuffer: 1 << 26 }) } catch { return [] }
  const res = []
  for (const line of out.split('\n').slice(1)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    const args = m[4]
    if (!/Electron/.test(args)) continue
    let type = 'main'
    if (args.includes('--type=renderer')) type = 'renderer'
    else if (args.includes('--type=gpu-process')) type = 'gpu'
    else if (args.includes('--type=utility')) type = 'utility'
    else if (args.includes('--type=zygote')) type = 'zygote'
    else if (args.includes('crashpad')) type = 'crashpad'
    res.push({ pid: +m[1], ppid: +m[2], rss: +m[3], type, args })
  }
  return res
}

/**
 * 从 rootPid 出发按 ppid 走，取整棵子树的进程表（**含 root 自己**）。
 * 用 args 匹配 `Electron` 而非 pid 精确匹配，是因为 npx 之外的 helper 进程
 * args 里没有本仓库路径，只有一个共享的 Electron.app 前缀。
 */
function subtree(rootPid) {
  const all = psAll()
  const byPpid = new Map()
  for (const p of all) {
    if (!byPpid.has(p.ppid)) byPpid.set(p.ppid, [])
    byPpid.get(p.ppid).push(p)
  }
  const self = all.find((p) => p.pid === rootPid)
  const out = self ? [self] : []
  const seen = new Set()
  const walk = (pid) => {
    if (seen.has(pid)) return
    seen.add(pid)
    for (const c of byPpid.get(pid) ?? []) { out.push(c); walk(c.pid) }
  }
  walk(rootPid)
  return out
}

/** footprint → phys_footprint (MB)，取不到返回 null */
function physFP(pids) {
  let sum = 0
  const per = []
  for (const pid of pids) {
    try {
      const o = execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8', timeout: 15000 })
      const m = o.match(/phys_footprint:\s+([\d.]+)\s*MB/)
      if (m) { const v = +m[1]; sum += v; per.push([pid, v]) }
    } catch { /* 进程可能刚好退了 */ }
  }
  return { sum, per }
}

/** 各进程累计 CPU 时间（秒） */
function cpuTable(rootPid) {
  let out = ''
  try { out = execFileSync('ps', ['-Ao', 'pid,ppid,time,args'], { encoding: 'utf8', maxBuffer: 1 << 26 }) } catch { return [] }
  const rows = []
  for (const line of out.split('\n').slice(1)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d:\-.]+)\s+(.*)$/)
    if (!m || !/Electron/.test(m[4])) continue
    rows.push({ pid: +m[1], ppid: +m[2], cpu: cpuSec(m[3]), args: m[4] })
  }
  const byPpid = new Map()
  for (const r of rows) { if (!byPpid.has(r.ppid)) byPpid.set(r.ppid, []); byPpid.get(r.ppid).push(r) }
  const self = rows.find((r) => r.pid === rootPid)
  const out2 = self ? [self] : []
  const seen = new Set()
  const walk = (pid) => { if (seen.has(pid)) return; seen.add(pid); for (const c of byPpid.get(pid) ?? []) { out2.push(c); walk(c.pid) } }
  walk(rootPid)
  const label = (a) => a.includes('--type=renderer') ? 'renderer' : a.includes('--type=gpu-process') ? 'gpu'
    : a.includes('--type=utility') ? 'utility' : a.includes('crashpad') ? 'crashpad' : 'main'
  return out2.map((r) => ({ type: label(r.args), cpu: r.cpu }))
}

const raw = []
const fpPoints = []
const cpuPoints = []
let running = true
const t0 = Date.now()
const child = spawn(ELECTRON, ['.', '--smoke'], {
  cwd: ROOT,
  env: { ...process.env, BD_USER_DATA: UD, SMOKE_WAIT_MS: String(WAIT_SEC * 1000) },
  stdio: ['ignore', 'pipe', 'pipe']
})
const ROOT_PID = child.pid

// 5 个点采 phys_footprint，最后 3 个的中位数作为「常驻口径」（footprint 会短暂挂起进程，
// 单点读数有抖动，取中位数更稳）
const FP_AT = [10, 20, Math.round(WAIT_SEC * 0.6), WAIT_SEC - 12, WAIT_SEC - 4].filter((v) => v > 1)
let fpIdx = 0

const ticker = setInterval(() => {
  if (!running) return
  const t = (Date.now() - t0) / 1000
  const sec = Math.floor(t)
  for (const p of subtree(ROOT_PID)) raw.push({ t, ...p })
  if (fpIdx < FP_AT.length && sec >= FP_AT[fpIdx]) {
    fpPoints.push({ t: sec, ...physFP(subtree(ROOT_PID).map((p) => p.pid)) })
    cpuPoints.push({ t: sec, table: cpuTable(ROOT_PID) })
    fpIdx++
  }
}, 250)

let outLog = ''
child.stdout.on('data', (d) => { outLog += d })
child.stderr.on('data', (d) => { outLog += d })
const rc = await new Promise((r) => child.on('close', r))
running = false
clearInterval(ticker)
const wall = (Date.now() - t0) / 1000

console.log(`electron exit=${rc}  wall=${wall.toFixed(1)}s  采样条数=${raw.length}`)
console.log(`collapsed=${COLLAPSED}（收起态才起两条 90ms 轮询：overlay.ts:433 + PetBall.tsx:332）`)
console.log('')

// ── CPU 累计时间 ────────────────────────────────────────────────────────────
console.log('─── A0. 累计 CPU 时间（ps time；等于「定时器唤醒」的总账）──────────────')
for (const p of cpuPoints) {
  const tot = p.table.reduce((a, b) => a + b.cpu, 0)
  console.log(`   t=+${String(p.t).padStart(3)}s  合计 ${tot.toFixed(1).padStart(6)}s CPU  (${p.table.map((x) => `${x.type} ${x.cpu.toFixed(1)}`).join('  ')})`)
}
if (cpuPoints.length >= 2) {
  const a = cpuPoints[0]
  const b = cpuPoints[cpuPoints.length - 1]
  const dt = b.t - a.t
  const sum = (t) => t.reduce((m, x) => { m[x.type] = (m[x.type] ?? 0) + x.cpu; return m }, {})
  const ca = sum(a.table)
  const cb2 = sum(b.table)
  const types = [...new Set([...Object.keys(ca), ...Object.keys(cb2)])]
  console.log(`   ── 稳定段 t=+${a.t}s → +${b.t}s（${dt}s）内的 CPU 增量 ──`)
  let grand = 0
  for (const ty of types) {
    const d = (cb2[ty] ?? 0) - (ca[ty] ?? 0)
    grand += d
    console.log(`      ${ty.padEnd(9)} +${d.toFixed(1).padStart(6)}s   = ${(100 * d / dt).toFixed(1)}% of one core`)
  }
  console.log(`      ${'合计'.padEnd(9)} +${grand.toFixed(1).padStart(6)}s   = ${(100 * grand / dt).toFixed(1)}% of one core`)
}
console.log('')

// ── 分桶（250ms）────────────────────────────────────────────────────────────
const BUCKET = 0.25
const buckets = new Map()
for (const r of raw) {
  const k = Math.round(r.t / BUCKET)
  if (!buckets.has(k)) buckets.set(k, { main: 0, renderer: 0, gpu: 0, utility: 0, zygote: 0, crashpad: 0, procs: 0, pids: new Set() })
  const b = buckets.get(k)
  b[r.type] += r.rss
  b.procs++
  b.pids.add(r.pid)
}
const series = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => ({ k, ...v, total: v.main + v.renderer + v.gpu + v.utility + v.zygote + v.crashpad }))
const totals = series.map((s) => s.total)
const tail = series.slice(Math.floor(series.length * 0.5)) // 启动爬坡之后的稳态段

console.log('─── A. sum-of-RSS（ps 口径；会重复计入各进程共享的 Electron Framework）──────────')
console.log(`进程数  峰值 ${Math.max(...series.map((s) => s.procs))} · 稳态中位 ${med(tail.map((s) => s.procs))} · 收尾 ${series[series.length - 1].procs}`)
console.log(`全树 RSS  稳态中位 ${MB(med(tail.map((s) => s.total)))} MB   p90 ${MB(pct(tail.map((s) => s.total), 0.9))} MB   全程峰值 ${MB(Math.max(...totals))} MB`)
const lastB = series[series.length - 1]
console.log('末桶分进程:')
for (const k of ['main', 'renderer', 'gpu', 'utility', 'zygote', 'crashpad']) if (lastB[k] > 0) console.log(`   ${k.padEnd(9)} ${MB(lastB[k]).padStart(7)} MB`)
console.log('')

console.log('─── B. phys_footprint（footprint -p；共享页按比例摊开，诚实口径）────────────')
for (const p of fpPoints) {
  console.log(`t=+${String(p.t).padStart(3)}s  合计 ${p.sum.toFixed(1).padStart(7)} MB   [${p.per.map(([pid, v]) => `${pid}:${v}`).join('  ')}]`)
}
if (fpPoints.length) {
  const last3 = fpPoints.slice(-3).map((p) => p.sum)
  const last2 = fpPoints.slice(-2).map((p) => p.sum)
  console.log(`→ 全程峰值 footprint: ${Math.max(...fpPoints.map((p) => p.sum)).toFixed(1)} MB`)
  console.log(`→ 常驻口径（末 3 点中位）: ${med(last3).toFixed(1)} MB    末 2 点: ${last2.map((v) => v.toFixed(1)).join(' / ')} MB`)
}
console.log('')

console.log('─── C. 时间线（每 ~1s 一行）─────────────────────────────────────────────')
let prevK = -99
for (const s of series) {
  if (s.k - prevK < 4 && s.k !== series[series.length - 1].k) continue
  prevK = s.k
  console.log(`  t=+${(s.k * BUCKET).toFixed(1).padStart(5)}s  main=${MB(s.main).padStart(6)}  rend=${MB(s.renderer).padStart(6)}  gpu=${MB(s.gpu).padStart(6)}  util=${MB(s.utility).padStart(6)}  ΣRSS=${MB(s.total).padStart(6)}  n=${s.procs}`)
}
console.log('')

// ── E. 为什么这里没有「chunk 是否加载」的证据 ────────────────────────────────
// 实测记录（本机 macOS 12.7.6 + Electron 37.10.3）：
//   · 试过 --log-net-log：netlog 里**0 条 file:// URL**（file scheme 走 file:// handler，
//     不进 netlog 的 network stack），人物形态下还会把 network service 搞崩重启。
//     → 放弃这条路。
//   · 替代方案见 probe-renderer.mjs：--remote-debugging-port + CDP Runtime.evaluate，
//     直接在渲染层读 performance.getEntriesByType('resource') 与 window.__bd_ball()。
console.log('─── D. 运行时证据的取法 ─────────────────────────────────────')
console.log('   本次不带 --log-net-log（实测 file:// 不进 netlog，人物形态还会崩 network service）')
console.log('   「默认形态有没有加载 three.js / 3D 素材」由 probe-renderer.mjs 用 CDP 取：')
console.log('     performance.getEntriesByType("resource")  → 渲染层真请求过哪些 chunk / bd-asset')
console.log('     window.__bd_ball()                        → 3D 场景是否创建（petReady）')
console.log('     Performance.getMetrics                    → JSHeapUsedSize（量化 three.js 代码代价）')
console.log('')

writeFileSync(LOG, outLog)
console.log('─── E. electron stdout 尾部 ─────────────────────────────────────────────')
console.log(outLog.slice(-420))

rmSync(UD, { recursive: true, force: true })
console.log('')
console.log(`临时 userData 已清理: ${UD}（netlog 保留在 ${NETLOG} 供复核）`)