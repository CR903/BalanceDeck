#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 「默认形态到底有没有加载 three.js / 3D 素材」的**运行时**取证（不改任何仓库代码）
//
//   node .trellis/tasks/10-01-p1-5-resource/research/probe-renderer.mjs <ball|figure> [秒数]
//
// 为什么需要它
// ──────────
// 「默认形态不加载 three.js」这句要对外说，就必须能**证明**它。bundle 静态分析只能证明
// 「哪些代码在磁盘上」，证明不了「哪些模块在运行时被 import 了」。
//
// 本机（macOS 12.7.6 + Electron 37.10.3）试过并**排除**的两条路：
//   ① --log-net-log → netlog 里 0 条 file:// URL（file scheme 不进 netlog 的 network stack）；
//      人物形态下还会把 network service 搞崩重启。不可用。
//   ② performance.getEntriesByType('resource') → file:// 的 <script type=module> **不产生**
//      Resource Timing 条目（实测返回空数组）。不可用。
//
// 剩下零改动的通道：--remote-debugging-port=0（Chromium 把端口写进
// <BD_USER_DATA>/DevToolsActivePort）→ WebSocket 打 CDP：
//   · Network.enable + Page.reload → 收 Network.requestWillBeSent，**这才是「谁被加载了」的
//     权威答案**（含 ES module chunk 与 bd-asset:// 协议请求）
//   · Runtime.evaluate → window.__bd_ball()、canvas 数、performance.memory
//   · Performance.getMetrics → V8 侧 JSHeapUsedSize
//   · SystemInfo.getProcessInfo（要在 **browser** 端点，不是 page 端点）→ 进程表
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
const OUTJSON = join(TMP, `bd-probe-${MODE}.json`)
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

const portFile = join(UD, 'DevToolsActivePort')
let port = null
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 250))
  if (existsSync(portFile)) {
    const p = Number(readFileSync(portFile, 'utf8').split('\n')[0])
    if (p > 0) { port = p; break }
  }
}
if (!port) {
  console.log('❌ 没拿到 DevTools 端口（DevToolsActivePort 未生成）')
  console.log(outLog.slice(-800))
  child.kill('SIGKILL')
  process.exit(1)
}
console.log(`DevTools 端口 = ${port}`)

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
console.log(`CDP page target : ${page?.url}`)
console.log(`CDP browser端点 : ${ver.webSocketDebuggerUrl}\n`)

// ── 极简 CDP 客户端（同时收事件；每条 send 带超时，避免 session detach 后永久挂住）────
function cdp(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    else if (m.method && onEvent) onEvent(m)
  }
  ws.onclose = () => { for (const [, f] of pending) f({ __closed: true }) ; pending.clear() }
  const send = async (method, params = {}, timeoutMs = 10000) => {
    await ready
    const myId = ++id
    const p = new Promise((res) => {
      const timer = setTimeout(() => res({ __timeout: true }), timeoutMs)
      pending.set(myId, (m) => { clearTimeout(timer); res(m) })
    })
    ws.send(JSON.stringify({ id: myId, method, params }))
    const r = await p
    pending.delete(myId)
    return r
  }
  const evalJs = async (expr, timeoutMs = 10000) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs)
    if (r.__closed) return '__ERR__ session closed'
    if (r.__timeout) return '__ERR__ timeout'
    if (r.result?.exceptionDetails) return '__ERR__ ' + r.result.exceptionDetails.text
    return r.result?.result?.value
  }
  return { send, evalJs, close: () => { try { ws.close() } catch { /* ignore */ } } }
}

const result = { mode: MODE, pet: PET, checks: [], reloadNetwork: [], t0: Date.now() }
const page0 = cdp(page.webSocketDebuggerUrl)

// ① 页面原样状态（首屏：生产启动后 renderer 自己加载的那一次）
//    等 App 真的挂上（#root 有子节点）再做第一次快照 —— 端口文件比首屏早几十到几百 ms。
for (let i = 0; i < 100; i++) {
  const n = await page0.evalJs(`document.getElementById('root')?.children.length ?? -1`)
  if (typeof n === 'number' && n > 0) break
  await new Promise((r) => setTimeout(r, 200))
}
// 人物形态：等模型就位（__bd_ball().petReady），最多 30s。
// ⚠ 球形态**不要**等 petReady —— 它按设计永远是 false（PetBall.tsx:188 的 `if (!figure) return`
//   根本不建场景），干等就是白烧 30s，等完 --smoke 早就自己 quit 了。
if (MODE === 'figure') {
  for (let i = 0; i < 150; i++) {
    const ready = await page0.evalJs(`window.__bd_ball?.()?.petReady === true`)
    if (ready === true) break
    await new Promise((r) => setTimeout(r, 200))
  }
}
const before = {
  waitedForPetReady: MODE === 'figure',
  scriptTags: await page0.evalJs(`JSON.stringify([...document.querySelectorAll('script')].map(s=>({type:s.type,src:s.src})))`),
  canvasCount: await page0.evalJs(`document.querySelectorAll('canvas').length`),
  pet3dCanvas: await page0.evalJs(`(()=>{const c=document.querySelector('.pet3d-canvas');return c?[c.width,c.height,c.clientWidth,c.clientHeight]:null})()`),
  figureAttr: await page0.evalJs(`document.querySelector('.petball')?.getAttribute('data-figure') ?? '(无 .petball)'`),
  ballHook: await page0.evalJs(`typeof window.__bd_ball`),
  ballInfo: await page0.evalJs(`(()=>{const b=window.__bd_ball?.();return b?JSON.stringify({petReady:b.petReady,rect:b.rect,clipParseMs:b.clipParseMs,dumpLen:Array.isArray(b.dump)?b.dump.length:-1}):null})()`),
  heap: (await page0.send('Runtime.getHeapUsage')).result ?? null
}
result.checks.push({ when: '首屏（无 reload）', ...before })

// ② Network.enable + Page.reload → 抓「一次完整冷加载里，渲染层到底请求了什么」
//    ⚠ reload 之后原来的 page session 会被 detach（渲染进程换了 target），
//    所以抓完请求就 close，重新 attach 一个新 session 取「reload 后」的状态。
const reqs = []
const c1 = cdp(page.webSocketDebuggerUrl, (m) => {
  if (m.method === 'Network.requestWillBeSent') reqs.push({ url: m.params.request.url, type: m.params.type })
  if (m.method === 'Network.loadingFailed') reqs.push({ url: '(failed)', type: m.params.type, error: m.params.errorText })
})
await c1.send('Network.enable')
await c1.send('Page.enable')
await c1.send('Page.reload', { ignoreCache: false })
await new Promise((r) => setTimeout(r, 1500))
c1.close()

// reload 后重新查 target（渲染进程可能换了一个 pid）
let page2 = page
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500))
  const l2 = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const p2 = l2.find((t) => t.type === 'page')
  if (p2 && p2.webSocketDebuggerUrl && p2.webSocketDebuggerUrl !== page.webSocketDebuggerUrl) { page2 = p2; break }
  if (p2) page2 = p2
}
// 等场景/模型就位
const waitSec = MODE === 'figure' ? 25 : 6
for (let i = 0; i < waitSec * 5; i++) {
  const ok = await (async () => {
    const c = cdp(page2.webSocketDebuggerUrl)
    const v = await c.evalJs(`document.getElementById('root')?.children.length ?? -1`)
    c.close()
    return typeof v === 'number' && v > 0
  })()
  if (ok) break
  await new Promise((r) => setTimeout(r, 200))
}
for (let i = 0; i < 60 && MODE === 'figure'; i++) {
  const c = cdp(page2.webSocketDebuggerUrl)
  const ready2 = await c.evalJs(`window.__bd_ball?.()?.petReady === true`)
  c.close()
  if (ready2 === true) break
  await new Promise((r) => setTimeout(r, 500))
}
await new Promise((r) => setTimeout(r, 2000))

const c2 = cdp(page2.webSocketDebuggerUrl)
const after = {
  canvasCount: await c2.evalJs(`document.querySelectorAll('canvas').length`),
  pet3dCanvas: await c2.evalJs(`(()=>{const c=document.querySelector('.pet3d-canvas');return c?[c.width,c.height,c.clientWidth,c.clientHeight]:null})()`),
  ballInfo: await c2.evalJs(`(()=>{const b=window.__bd_ball?.();return b?JSON.stringify({petReady:b.petReady,rect:b.rect,clipParseMs:b.clipParseMs,dumpLen:Array.isArray(b.dump)?b.dump.length:-1}):null})()`),
  heap: (await c2.send('Runtime.getHeapUsage')).result ?? null
}
c2.close()
result.reloadNetwork = reqs
result.checks.push({ when: 'Page.reload 冷加载后', ...after })

// ────────────────────────────────────────────────────────────────────────────
// ③ 运行时切换取证：「切到个性人物的那一刻，渲染层又去请求了什么」
//    Page.reload 会把渲染层的 collapsed 状态打回 false（App.tsx:101 默认 false，
//    重载后不再从主进程拿），于是 reload 后的页面是**展开态**、PetBall 根本没挂上
//    （两种模式下 reload 后都是 canvas=0 / __bd_ball=null）—— 所以「切形态那一刻加载了
//    什么」必须**在首屏那次会话里**用 UI 驱动来取，不能靠 reload。
//    用的就是 ballshot.ts:41-49 那套「按相邻文本定位开关」的 JS。
// ────────────────────────────────────────────────────────────────────────────
const reqs2 = []
const c3 = cdp(page.webSocketDebuggerUrl, (m) => {
  if (m.method === 'Network.requestWillBeSent') reqs2.push({ url: m.params.request.url, type: m.params.type })
  if (m.method === 'Network.loadingFailed') reqs2.push({ url: '(failed)', type: m.params.type, error: m.params.errorText })
})
await c3.send('Network.enable')
const petRow = `[...document.querySelectorAll('.pet-sec .enable-row')].find(r=>r.textContent.includes('个性人物'))`
const petSwitch = `(()=>{const r=${petRow};const s=r?.querySelector('.switch');if(!s)return 'no-switch';if(s.classList.contains('on'))return 'already-on';s.click();return 'clicked'})()`
const toggleLog = {}
toggleLog.expand = await c3.evalJs(`window.api.expand()`)
await new Promise((r) => setTimeout(r, 1000))
toggleLog.openSettings = await c3.evalJs(`[...document.querySelectorAll('.btn-secondary')].find(b=>b.textContent.includes('设置'))?.click()`)
await new Promise((r) => setTimeout(r, 1500))
toggleLog.switch = await c3.evalJs(petSwitch)
await new Promise((r) => setTimeout(r, 800))
toggleLog.back = await c3.evalJs(`[...document.querySelectorAll('.icon-btn')].find(b=>b.title==='返回')?.click()`)
await new Promise((r) => setTimeout(r, 800))
toggleLog.collapse = await c3.evalJs(`[...document.querySelectorAll('.btn-secondary')].find(b=>b.textContent.includes('收起'))?.click()`)
// 等模型就位
for (let i = 0; i < 60; i++) {
  const r = await c3.evalJs(`window.__bd_ball?.()?.petReady === true`)
  if (r === true) { toggleLog.petReadyAtSec = (i * 0.5).toFixed(1); break }
  await new Promise((r2) => setTimeout(r2, 500))
}
await new Promise((r) => setTimeout(r, 2500))
const afterToggle = {
  canvasCount: await c3.evalJs(`document.querySelectorAll('canvas').length`),
  pet3dCanvas: await c3.evalJs(`(()=>{const c=document.querySelector('.pet3d-canvas');return c?[c.width,c.height,c.clientWidth,c.clientHeight]:null})()`),
  figureAttr: await c3.evalJs(`document.querySelector('.petball')?.getAttribute('data-figure') ?? '(无 .petball)'`),
  ballInfo: await c3.evalJs(`(()=>{const b=window.__bd_ball?.();return b?JSON.stringify({petReady:b.petReady,rect:b.rect,clipParseMs:b.clipParseMs,dumpLen:Array.isArray(b.dump)?b.dump.length:-1}):null})()`),
  heap: (await c3.send('Runtime.getHeapUsage')).result ?? null
}
c3.close()
result.toggleNetwork = reqs2
result.toggleLog = toggleLog
result.checks.push({ when: 'UI 切到个性人物后', ...afterToggle })

// ④ 进程表（要在 browser 端点上调 SystemInfo.getProcessInfo）
const cb = cdp(ver.webSocketDebuggerUrl)
const sys = await cb.send('SystemInfo.getProcessInfo')
result.cdpProcessInfo = sys.result?.processInfo ?? []
result.cdpProcessInfoError = sys.error ?? null
cb.close()

// ── 打印 ────────────────────────────────────────────────────────────────────
const onlyRenderer = reqs.filter((r) => /\/out\/renderer\/|bd-asset:|blob:/.test(r.url))
const uniqueUrls = [...new Set(onlyRenderer.map((r) => r.url))].sort()
console.log('① 首屏（生产启动后，**未** reload）')
console.log(`   <script> 标签          : ${before.scriptTags}`)
console.log(`   <canvas> 数            : ${before.canvasCount}`)
console.log(`   .pet3d-canvas         : ${JSON.stringify(before.pet3dCanvas)}`)
console.log(`   .petball data-figure   : ${before.figureAttr}`)
console.log(`   window.__bd_ball 类型  : ${before.ballHook}`)
console.log(`   __bd_ball()            : ${before.ballInfo}`)
console.log(`   Runtime.getHeapUsage   : usedSize=${((before.heap?.usedSize ?? 0) / 1048576).toFixed(1)} MB  totalSize=${((before.heap?.totalSize ?? 0) / 1048576).toFixed(1)} MB`)
console.log('')
console.log('② Page.reload 冷加载 —— Network.requestWillBeSent 全量（只列渲染层相关）')
for (const u of uniqueUrls) console.log(`   ${u.replace('file:///Users/zhouri/project/BalanceDeck/out/renderer/', '').replace('file:///Users/zhouri/project/BalanceDeck/', 'REPO/')}`)
console.log(`   总请求数 ${reqs.length}，其中渲染层相关 ${onlyRenderer.length}`)
const failed = reqs.filter((r) => r.url === '(failed)')
if (failed.length) { console.log('   失败请求:'); for (const f of failed) console.log(`      ${f.type} ${f.error}`) }
console.log('')
console.log('   判定:')
const has = (re) => uniqueUrls.some((u) => re.test(u))
console.log(`      入口 chunk index-*.js  : ${has(/index-[^/]*\.js/)}`)
console.log(`      human-*.js（FBX/骨骼/材质，**动态** import）: ${has(/\/human-/)}`)
console.log(`      voice-*.js（speechOut **动态** import）      : ${has(/\/voice-/)}`)
console.log(`      bd-asset:// 3D 素材                        : ${has(/^bd-asset:/)}`)
console.log('')
console.log('③ reload 后')
console.log(`   <canvas> 数=${after.canvasCount}  .pet3d-canvas=${JSON.stringify(after.pet3dCanvas)}`)
console.log(`   __bd_ball()          : ${after.ballInfo}`)
console.log(`   Runtime.getHeapUsage : usedSize=${((after.heap?.usedSize ?? 0) / 1048576).toFixed(1)} MB  totalSize=${((after.heap?.totalSize ?? 0) / 1048576).toFixed(1)} MB`)
console.log('')
console.log('③ UI 驱动切到「个性人物」（用 ballshot.ts:41-49 那套 JS；Network 全程开着）')
console.log(`   驱动日志 : ${JSON.stringify(toggleLog)}`)
const u2 = [...new Set(reqs2.map((r) => r.url))].sort()
for (const u of u2) console.log(`   ${u.replace('file:///Users/zhouri/project/BalanceDeck/out/renderer/', '').replace('file:///Users/zhouri/project/BalanceDeck/', 'REPO/')}`)
console.log(`   → human-*.js（FBX/骨骼/材质）: ${u2.some((u) => u.includes('/human-')) ? '**已加载**' : '未加载'}`)
console.log(`   → bd-asset:// 3D 素材         : ${u2.filter((u) => u.startsWith('bd-asset:')).length} 个请求`)
console.log(`   <canvas> 数=${afterToggle.canvasCount}  .pet3d-canvas=${JSON.stringify(afterToggle.pet3dCanvas)}  data-figure=${afterToggle.figureAttr}`)
console.log(`   __bd_ball()          : ${afterToggle.ballInfo}`)
console.log(`   Runtime.getHeapUsage : usedSize=${((afterToggle.heap?.usedSize ?? 0) / 1048576).toFixed(1)} MB  totalSize=${((afterToggle.heap?.totalSize ?? 0) / 1048576).toFixed(1)} MB`)
console.log('')
console.log('④ SystemInfo.getProcessInfo（browser 端点）')
if (result.cdpProcessInfoError) console.log('   ', JSON.stringify(result.cdpProcessInfoError).slice(0, 300))
else for (const p of result.cdpProcessInfo) console.log(`   type=${p.type} pid=${p.id} cpuTime=${p.cpuTime}`)
console.log('')

const rc = await new Promise((r) => child.on('close', r))
console.log(`electron exit=${rc}`)
rmSync(UD, { recursive: true, force: true })
console.log(`临时 userData 已清理: ${UD}`)
writeFileSync(OUTJSON, JSON.stringify(result, null, 2))
console.log(`原始结果: ${OUTJSON}`)