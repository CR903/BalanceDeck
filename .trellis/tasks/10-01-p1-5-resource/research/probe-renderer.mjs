#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 「默认形态到底有没有加载 three.js / 3D 素材」的**运行时**取证（不改任何仓库代码）
//
//   node .trellis/tasks/10-01-p1-5-resource/research/probe-renderer.mjs <ball|figure> [秒数]
//
// 为什么需要它
// ──────────
// 「默认形态不加载 three.js」这句要对外说，就必须能**证明**它。而 bundle 静态分析只能证明
// 「哪些代码在磁盘上」，不能证明「哪些模块在运行时被 import 了」。
// 本机实测：--log-net-log **不记录 file:// 的模块脚本加载**（0 条 file:// URL），
// 人物形态下还会把 network service 搞崩 → 不可用。
// 剩下的零改动通道就是 CDP：--remote-debugging-port=0 让 Chromium 把端口写进
// <BD_USER_DATA>/DevToolsActivePort，然后用 WebSocket 打 Runtime.evaluate / Performance.getMetrics。
//
// 取到什么
// ────────
//   · performance.getEntriesByType('resource') —— 渲染层**真的**发起过的加载：入口 chunk、
//     动态 import 的 human-* / voice-*、以及 bd-asset:// 的 3D 素材（preview.png / *.glb）
//   · window.__bd_ball() —— 3D 场景是否真的建起来了（petReady）
//   · document.querySelectorAll('canvas').length / .pet3d-canvas —— 有没有 WebGL 上下文
//   · Performance.getMetrics 的 JSHeapUsedSize / JSHeapTotalSize —— 量化「代码本身」的代价
//   · SystemInfo.getProcessInfo（browser 侧）—— 进程表，交叉核对 GPU 进程是否因 3D 变大
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../../../..')
const MODE = process.argv[2] ?? 'ball'
const WAIT_SEC = Number(process.argv[3] ?? 30)
const PET = MODE === 'figure' ? '1' : '0'
const TMP = '/private/var/folders/f7/l6wj46ps3p74mm412hdknnqh0000gn/T/opencode'
const UD = join(TMP, `bd-probe-${MODE}`)
const ELECTRON = join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')

const MB = (kb) => (kb / 1024).toFixed(1)

rmSync(UD, { recursive: true, force: true })
mkdirSync(UD, { recursive: true })
writeFileSync(join(UD, 'secrets.bin'), `{"version":1,"items":{},"extras":{"ui:pet":"${PET}"}}`)
writeFileSync(join(UD, 'state.json'), '{"collapsed":true}')

console.log('═══════════════════════════════════════════════════════════════════')
console.log(`  probe mode = ${MODE}   (ui:pet='${PET}')   SMOKE_WAIT_MS=${WAIT_SEC * 1000}`)
console.log(`  date = ${new Date().toISOString()}`)
console.log('═══════════════════════════════════════════════════════════════════')

let outLog = ''
const child = spawn(ELECTRON, ['.', '--smoke', '--remote-debugging-port=0'], {
  cwd: ROOT,
  env: { ...process.env, BD_USER_DATA: UD, SMOKE_WAIT_MS: String(WAIT_SEC * 1000) },
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stdout.on('data', (d) => { outLog += d })
child.stderr.on('data', (d) => { outLog += d })

// 等 DevToolsActivePort 落盘
const portFile = join(UD, 'DevToolsActivePort')
let port = null
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 250))
  if (existsSync(portFile)) {
    const txt = readFileSync(portFile, 'utf8').split('\n')
    const p = Number(txt[0])
    if (p > 0) { port = p; break }
  }
}
if (!port) {
  console.log('❌ 没拿到 DevTools 端口（DevToolsActivePort 未生成）')
  console.log(outLog.slice(-800))
  child.kill('SIGKILL')
  process.exit(1)
}
console.log(`DevTools 端口 = ${port}\n`)

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
console.log('CDP target:', page ? `${page.url}  (${page.title})` : '(无 page target)')
console.log('')

// ── 极简 CDP 客户端 ────────────────────────────────────────────────────────
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  const send = async (method, params = {}) => {
    await ready
    const myId = ++id
    return new Promise((res) => { pending.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })) })
  }
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text }
    return r.result?.result?.value
  }
  return { send, evalJs, close: () => ws.close() }
}

const PROBE_AT = [10, Math.round(WAIT_SEC * 0.6), WAIT_SEC - 5].filter((v) => v > 2)
const t0 = Date.now()
const results = []

for (const at of PROBE_AT) {
  while ((Date.now() - t0) / 1000 < at) await new Promise((r) => setTimeout(r, 200))
  if (child.exitCode !== null) break
  const c = cdp(page.webSocketDebuggerUrl)
  const r = {
    t: Math.round((Date.now() - t0) / 1000),
    resources: await c.evalJs(`JSON.stringify(performance.getEntriesByType('resource').map(e=>e.name).filter(n=>n.includes('/out/renderer/')||n.startsWith('bd-asset:')||n.startsWith('blob:')))`),
    allScripts: await c.evalJs(`JSON.stringify([...document.querySelectorAll('script[type=module]')].map(s=>s.src))`),
    canvas: await c.evalJs(`document.querySelectorAll('canvas').length`),
    pet3dCanvas: await c.evalJs(`(()=>{const c=document.querySelector('.pet3d-canvas');return c?[c.width,c.height,c.clientWidth,c.clientHeight]:null})()`),
    ball: await c.evalJs(`(()=>{const b=window.__bd_ball?.();if(!b)return null;return JSON.stringify({petReady:b.petReady,rect:b.rect,clipParseMs:b.clipParseMs,dumpLen:Array.isArray(b.dump)?b.dump.length:-1})})()`),
    ballExists: await c.evalJs(`typeof window.__bd_ball`),
    figureAttr: await c.evalJs(`document.querySelector('.petball')?.getAttribute('data-figure') ?? '(无 .petball)'`),
    webglCtx: await c.evalJs(`(()=>{try{const c=document.createElement('canvas');return !!(c.getContext('webgl2')||c.getContext('webgl'))}catch(e){return 'err:'+e}})()`)
  }
  const m = await c.send('Performance.getMetrics')
  r.perf = Object.fromEntries((m.result?.metrics ?? []).map((x) => [x.name, x.value]))
  // browser 侧进程表
  const bc = cdp(page.webSocketDebuggerUrl)
  const sys = await bc.send('SystemInfo.getProcessInfo')
  r.procs = sys.result?.processInfo ?? []
  bc.close()
  c.close()
  results.push(r)
  console.log(`── t=+${r.t}s ─────────────────────────────────────────────`)
  const res = JSON.parse(r.resources ?? '[]')
  const chunks = res.filter((n) => n.includes('/out/renderer/'))
  const assets = res.filter((n) => n.startsWith('bd-asset:'))
  console.log('  module <script> 标签 :', r.allScripts)
  console.log('  渲染层加载的 chunk    :')
  for (const c2 of chunks) console.log(`      ${c2.replace(/.*\/out\/renderer\//, '')}`)
  console.log(`  → index-*.js（含 three.js 本体）: ${chunks.some((c2) => /index-[^/]*\.js$/.test(c2)) ? '已加载' : '未加载'}`)
  console.log(`  → human-*.js（FBX/骨骼/材质，动态 import）: ${chunks.some((c2) => c2.includes('/human-')) ? '已加载' : '未加载'}`)
  console.log(`  → voice-*.js（speechOut 动态 import）: ${chunks.some((c2) => c2.includes('/voice-')) ? '已加载' : '未加载'}`)
  console.log(`  bd-asset:// 素材请求 (${assets.length}):`)
  for (const a of assets) console.log(`      ${a}`)
  console.log(`  <canvas> 数=${r.canvas}   .pet3d-canvas=${JSON.stringify(r.pet3dCanvas)}`)
  console.log(`  .petball data-figure=${r.figureAttr}    window.__bd_ball 类型=${r.ballExists}`)
  console.log(`  __bd_ball() = ${r.ball}`)
  console.log(`  可新建 WebGL 上下文 = ${r.webglCtx}（说明这台机器能不能建，不是说本应用建了）`)
  console.log(`  JSHeapUsedSize=${MB(r.perf.JSHeapUsedSize ?? 0)} MB  JSHeapTotalSize=${MB(r.perf.JSHeapTotalSize ?? 0)} MB  Nodes=${r.perf.Nodes}  Documents=${r.perf.Documents}  JSEventListeners=${r.perf.JSEventListeners}`)
  console.log(`  CDP 看到的进程表: ${r.procs.map((p) => `${p.type}#${p.id}`).join(' ')}`)
  console.log('')
}

const rc = await new Promise((r) => child.on('close', r))
console.log(`electron exit=${rc}`)
if (outLog.trim()) { console.log('--- stdout/stderr 尾部 ---'); console.log(outLog.slice(-500)) }

rmSync(UD, { recursive: true, force: true })
console.log('')
console.log(`临时 userData 已清理: ${UD}`)
writeFileSync(join(TMP, `bd-probe-${MODE}.json`), JSON.stringify(results, null, 2))
console.log(`原始结果: ${join(TMP, `bd-probe-${MODE}.json`)}`)