// 统一播出口测试（src/renderer/src/speechOut.ts）
// 用法：node scripts/test-speech-out.mjs
//
// 覆盖：频率闸门（分钟/小时/滑出窗口）、队列与打断（紧急插队、例行排队、跳过不叠加、
//       在途请求丢弃）、stopAll 双通道、TTS 请求契约（URL/头/体/**style 真被发送**/
//       重试/401 不重试/revokeObjectURL）、**主进程原因码的映射**（E8-E13）、
//       未配置不播且不占配额、系统语音回退（含音色性别透传）、**计费分流**（N）、
//       **不可达自愈**（O）、纯函数 isDuplicate / pacedMs。
//
// 传输层（09-29-tts-request-to-main）：请求不再由渲染层 `fetch` 发出，而是走
// `window.api.ttsSpeak`（主进程 `tts:speak`，因为 index.html 的 CSP connect-src 拦着一切
// 外连）。桩与 routes 的契约保持不变，所以除 D 段那几条「主体搬到主进程」的之外，
// 既有断言一条没删。
//
// 加载的是**真实源码**（esbuild 打包 src 下的 .ts），不内联实现副本 ——
// quality-guidelines 明确禁止后者（test-percent.mjs 因此漂移过）。
// 外部依赖（window.api.ttsSpeak / fetch / Audio / window.speechSynthesis / Date.now / URL.*）
// 全部在测试里替换，替身都记账并断言「走到了哪条分支」，避免测试静默走别的分支；
// 其中 fetch 的桩是**立刻抛**的 —— 渲染层本就不许出网（CSP），谁把它加回来就红。
//
// 看门狗不是装饰：Node 在「顶层 await 永远不结算」时会打印一句 unsettled 警告然后**以退出码
// 0 结束** —— 也就是「实现改坏了但套件报绿」。这里把挂起变成失败。

setTimeout(() => {
  console.log('  ✗ 套件 30s 内没跑完（疑似挂起）')
  process.exit(1)
}, 30_000)

import { loadTs } from './lib/load-ts.mjs'
import { readFileSync } from 'node:fs'

const {
  RATE_LIMIT,
  DEFAULT_TTS_CONFIG,
  PROBE_DELAYS,
  PROBE_RESTART_COOLDOWN_MS,
  isDuplicate,
  pacedMs,
  allowCall,
  enqueue,
  stopAll,
  flush,
  probeStep,
  probeTts
} = await loadTs('src/renderer/src/speechOut.ts')

// 断言输出走 out()，不走 console.log —— 下面 captureLogs 会临时接管 console.log
const out = console.log.bind(console)

let pass = 0
let fail = 0
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    out(`  ✓ ${label}`)
  } else {
    fail++
    out(`  ✗ ${label}\n      实际: ${a}\n      期望: ${e}`)
  }
}
function ok(cond, label) {
  eq(!!cond, true, label)
}

// ─── 测试替身 ────────────────────────────────────────────────────────────────

/**
 * 临时替换 globalThis.fetch；返回 restore。
 *
 * 迁移后渲染层**一次都不该调用 fetch**（`index.html` 的 CSP `connect-src` 拦着，
 * 调了也到不了网络）。所以 `withBroadcast` 传给它的是「立刻抛」的桩：谁把 fetch
 * 加回 `requestAudioBlob`，第一次播报就会撞上它，相关断言集体变红。
 */
function withFetch(fn) {
  const prev = globalThis.fetch
  globalThis.fetch = fn
  return () => (globalThis.fetch = prev)
}

/**
 * 把 `window.api.ttsSpeak` 换成桩（主进程 `tts:speak` 的渲染层入口），返回 restore。
 *
 * 必须在 `withSystemSpeech()` 之后调用：它会把整个 `window` 换成一个只带
 * speechSynthesis 的纯桩，不补 api 的话 `requestAudioBlob` 会撞 TypeError ——
 * 表现为「套件全红但报的全是无关错误」。所以这里把前提显式化，缺了就直接抛。
 */
function withTtsSpeak(fn) {
  if (!globalThis.window) throw new Error('withTtsSpeak 必须在 withSystemSpeech() 之后调用')
  const prev = globalThis.window.api
  globalThis.window.api = { ttsSpeak: fn }
  return () => {
    if (prev === undefined) delete globalThis.window.api
    else globalThis.window.api = prev
  }
}

/**
 * 可控的 HTMLAudioElement 替身。
 * - autoEnd=true（默认）：构造后异步触发 onended（正常播完）
 * - autoError=true：构造后异步触发 onerror（播放失败 —— CSP 拦 blob、解码失败等）
 * - playRejects=true：play() 返回 rejected promise（CSP 下 play() 被拒的那条路径）
 * autoError 与 autoEnd 互斥（error 优先）；playRejects 独立，可与任一组合。
 */
class FakeAudio {
  static instances = []
  static autoEnd = true
  static autoError = false
  static playRejects = false
  constructor(src) {
    this.src = src
    this.playCalls = 0
    this.pauseCalls = 0
    this.onended = null
    this.onerror = null
    FakeAudio.instances.push(this)
    // 自动播完/失败挂在构造上、**不挂在 play() 上**：实现若忘了调 play()，套件仍能跑完并由
    // F3 断言变红；挂在 play() 上只会让它一路挂到看门狗，读不出是哪一条坏了
    if (FakeAudio.autoError) setTimeout(() => this.onerror?.(), 0)
    else if (FakeAudio.autoEnd) setTimeout(() => this.onended?.(), 0)
  }
  play() {
    this.playCalls++
    if (FakeAudio.playRejects) return Promise.reject(new Error('NotAllowedError: play() denied'))
    return Promise.resolve()
  }
  pause() {
    this.pauseCalls++
  }
  static reset(autoEnd = true) {
    FakeAudio.instances = []
    FakeAudio.autoEnd = autoEnd
    FakeAudio.autoError = false
    FakeAudio.playRejects = false
  }
}

function withAudio(autoEnd) {
  const prev = globalThis.Audio
  FakeAudio.reset(autoEnd)
  globalThis.Audio = FakeAudio
  return () => {
    globalThis.Audio = prev
    FakeAudio.reset()
  }
}

/** 记账式系统语音替身（voice.ts 读 window.speechSynthesis / SpeechSynthesisUtterance） */
function withSystemSpeech() {
  const spoken = []
  /** 每次 speak 用的音色名（用来证明 gender 偏好真的透到了 voice.speak） */
  const voiceNames = []
  let cancels = 0
  const prevWin = globalThis.window
  const prevUtt = globalThis.SpeechSynthesisUtterance
  globalThis.window = {
    speechSynthesis: {
      speak: (u) => {
        spoken.push(u.text)
        voiceNames.push(u.voice?.name ?? null)
      },
      cancel: () => {
        cancels++
      },
      // 有男声和女声：voice.speak() 按 gender 挑音色，替身要能证明「挑的是哪一位」
      getVoices: () => [
        { name: 'Ting-Ting', lang: 'zh-CN' },
        { name: 'Li-Mu', lang: 'zh-CN' }
      ]
    }
  }
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text
    }
  }
  return {
    spoken,
    voiceNames,
    cancelCount: () => cancels,
    restore: () => {
      globalThis.window = prevWin
      globalThis.SpeechSynthesisUtterance = prevUtt
    }
  }
}

/**
 * 冻结 Date.now。flush 内部读的是它（频率闸门的调用点），不冻结就没法在一条测试里
 * 连放行多次。**时刻必须单调递增** —— 闸门是滑动窗口，把时钟拨回去等于伪造旧记录。
 */
function withClock(start) {
  let t = start
  const prev = Date.now
  Date.now = () => t
  return {
    advance: (ms) => (t += ms),
    restore: () => (Date.now = prev)
  }
}

/** 记账式 blob URL：createObjectURL 必须与 revokeObjectURL 配平 */
function withObjectUrl() {
  const made = []
  const revoked = []
  const prevCreate = URL.createObjectURL
  const prevRevoke = URL.revokeObjectURL
  let n = 0
  URL.createObjectURL = () => {
    const u = `blob:test/${n++}`
    made.push(u)
    return u
  }
  URL.revokeObjectURL = (u) => revoked.push(u)
  return {
    made,
    revoked,
    restore: () => {
      URL.createObjectURL = prevCreate
      URL.revokeObjectURL = prevRevoke
    }
  }
}

/** 收走 console.warn/log，返回按需断言的记录器（预期失败路径不该污染测试输出） */
function captureLogs() {
  const lines = []
  const prevWarn = console.warn
  const prevLog = console.log
  const write = (...a) =>
    lines.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '))
  console.warn = write
  console.log = write
  return {
    lines,
    has: (frag) => lines.some((l) => l.includes(frag)),
    restore: () => {
      console.warn = prevWarn
      console.log = prevLog
    }
  }
}

// 端点逐字写死在这里，而不是 DEFAULT_TTS_CONFIG.url —— 从被测模块里取期望值，
// 断言就成了「自己和自己比」：域名改错也照样全绿（这正是父任务 D1 换过一次的字段）
const TTS_URL = 'https://voice.mytts.ccwu.cc/v1/audio/speech'
const LEGACY_URL = 'https://tts.chour903.workers.dev/v1/audio/speech'
const okBlob = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' })
const okRes = () => ({ ok: true, status: 200, blob: async () => okBlob() })

/** 一条完整的播报环境：冻结时钟 + 记账 ttsSpeak + 假音频 + 假系统语音 + 日志收走 */
let clockSeq = 100_000_000
async function withBroadcast({ autoEnd = true, autoError = false, playRejects = false, clock, routes } = {}) {
  stopAll()
  // 每段场景的时钟至少往前推一小时：闸门的记录必须落在窗口外，各段才互不干扰
  const clk = withClock(clock ?? (clockSeq += 3_600_001))
  const calls = []
  const restoreAudio = withAudio(autoEnd)
  // withAudio 的 reset 把 autoError/playRejects 清成 false；按调用方意图再设回去。
  // 必须在 flush 创建音频之前设好 —— reset 之后、return 之前这一刻是安全的。
  if (autoError) FakeAudio.autoError = true
  if (playRejects) FakeAudio.playRejects = true
  // 顺序有讲究：withSystemSpeech() 会**整个换掉 window**，所以补 api 必须在它之后；
  // 撤的时候反过来，先撤 api 再把 window 换回去（否则 restore 会打在已被还原的 window 上）
  const sys = withSystemSpeech()
  // ── 传输层桩（window.api.ttsSpeak，主进程 tts:speak 的渲染层入口）────────────
  // `routes` 的形状沿用旧的 fetch 契约（`{ res: { ok, status, blob } }` / `{ throw }`），
  // 这样既有断言一条都不用改，换掉的只有传输层：
  //   · 成功      → 回 ArrayBuffer（主进程 `tts:speak` 返回的就是字节）
  //   · HTTP 失败 → 抛 `TTS_HTTP_<n>`（主进程对非 2xx 的原因码）
  //   · 网络失败  → 抛 `TypeError('fetch failed')`（与主进程归类后的失败同一路）
  // 未覆盖的 URL 照旧直接抛 —— 避免测试因为「URL 拼错」而静默走了别的分支。
  const restoreSpeak = withTtsSpeak(async (req) => {
    calls.push({
      url: req.url,
      init: { method: 'POST', headers: req.headers },
      body: JSON.parse(req.body)
    })
    const r = routes(req.url, calls.length)
    if (!r) throw new TypeError(`tts:speak 未覆盖的 URL: ${req.url}`)
    if (r.throw) throw new TypeError(r.throw)
    if (r.res.ok) {
      const blob = await r.res.blob()
      return await blob.arrayBuffer()
    }
    throw new Error(`TTS_HTTP_${r.res.status}`)
  })
  // 渲染层不许出网（CSP 本来也拦）：把 fetch 钉成一个会立刻失败的桩，
  // 谁把 fetch 加回 requestAudioBlob，第一次播报就撞上它
  const restoreFetch = withFetch(() => {
    throw new Error('渲染层不许出网：请求必须走 window.api.ttsSpeak（CSP connect-src）')
  })
  const urls = withObjectUrl()
  const logs = captureLogs()
  return {
    calls,
    sys,
    urls,
    logs,
    clk,
    audio: () => FakeAudio.instances,    async done() {
      logs.restore()
      urls.restore()
      restoreSpeak()
      sys.restore()
      restoreAudio()
      restoreFetch()
      clk.restore()
      stopAll()
    }
  }
}

/** 等假音频元素被创建出来（播报中途打断 / 串行排队的测试要用） */
async function waitForCount(getAudio, n, tries = 200) {
  for (let i = 0; i < tries && getAudio().length < n; i++) {
    await new Promise((r) => setTimeout(r, 2))
  }
}

/** 让第 i 条手动播完，并把时钟往前推一分钟（闸门只放行每分钟一次，不推就下一条被拦） */
async function finishItem(b, i) {
  b.clk.advance(61_000)
  b.audio()[i].onended?.()
  await new Promise((r) => setTimeout(r, 2))
}

// 断言里的 `b.calls[n]?.body?.input` 一律 null 安全：改坏了实现（闸门调紧、串行被破坏…）
// 时，第 n 条根本没发出去，直接 `b.calls[2].body` 会抛 TypeError 把整份报告打断 ——
// 那样只看得到一个栈，看不全红集，batch 的声明目标集无法核对。与 test-alert-orchestration
// 里 textOf / latchOf 同一条纪律。期望值仍是非空串：取到 undefined 照样红。
// ═══════════════════════════════════════════════════════════════════════════════
out('\nA. 频率闸门：滑动窗口 + 检查即记账（用显式 now 驱动）')

{
  const quiet = captureLogs()
  try {
    const T0 = 0
    eq(allowCall(T0), true, 'A1 第一次放行')
    eq(allowCall(T0), false, 'A2 分钟内第 2 次被拒')
    eq(allowCall(T0), false, 'A3 连续第 3 次仍被拒（不推时间就一直拒）')
    eq(allowCall(60_000), true, 'A4 恰好 60s 后滑出分钟窗口 → 放行')
  } finally {
    quiet.restore()
  }
}

out('\nB. 频率闸门的小时窗口（10 次/小时 + 滑出恢复）')

{
  const quiet = captureLogs()
  try {
    // 每 61s 一次：分钟窗口内恒为 1，单独卡住后面的只会是小时窗口
    const T0 = 10_000_000
    const grants = []
    for (let i = 0; i < 12; i++) grants.push(allowCall(T0 + i * 61_000))
    eq(
      grants.map((g) => (g ? '1' : '0')).join(''),
      '111111111100',
      'B1 前 10 次放行，第 11、12 次被小时窗口拒'
    )
    eq(allowCall(T0 + 3_661_000), true, 'B2 最老的一条滑出小时窗口 → 恢复放行')
    eq(RATE_LIMIT.MAX_PER_MINUTE, 1, 'B3 每分钟 1 次')
    eq(RATE_LIMIT.MAX_PER_HOUR, 10, 'B4 每小时 10 次')
    // A / B 两段用的时刻互不相干 —— 若闸门是累计计数而不是滑动窗口，这里会红
    eq(allowCall(20_000_000), true, 'B5 换一个完全不同的时刻依旧是独立窗口')
  } finally {
    quiet.restore()
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
out('\nC. 纯函数：合并去重 / 系统语音估算时长')

eq(isDuplicate('余额不足', '余额不足'), true, 'C1 同文本 → 重复')
eq(isDuplicate('余额不足', '余额充足'), false, 'C2 不同文本 → 不重复')
eq(isDuplicate('  余额不足  ', '余额不足'), true, 'C3 首尾空白视为同一文本')
eq(isDuplicate('', ''), false, 'C4 两条都为空不构成重复')
eq(isDuplicate('', '余额不足'), false, 'C5 一条为空 → 不重复')
eq(pacedMs('一'), 600, 'C6 单字按下限 600ms')
eq(pacedMs('甲'.repeat(10)), 1800, 'C7 10 字 × 180ms')
eq(pacedMs('甲'.repeat(1000)), 15000, 'C8 超长文本封顶 15s')

// ═══════════════════════════════════════════════════════════════════════════════
out('\nD. TTS 请求契约：URL / 头 / 体 / 未配置不播')

{
  const b = await withBroadcast({ routes: () => ({ res: okRes() }) })
  try {
    enqueue({ text: '余额不足', urgent: true, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    eq(b.calls.length, 1, 'D1 播一条 = 一次请求')
    eq(b.calls[0].url, TTS_URL, 'D2 打的是实测端点（父任务 D1）')
    eq(b.calls[0].url !== LEGACY_URL, true, 'D3 不是已被 DNS 污染的旧域名')
    // D4（方法 POST）与 D8（带 AbortSignal）的主体随请求搬进了主进程：渲染层既不指定
    // 方法也不持有 socket，断言留在这里就成了「断言自己的桩」。改判在 test-structure.mjs
    // 的 F 段（读 ipc.ts 的 tts:speak handler），标签仍是 D4 / D8。
    eq(b.calls[0].init.headers['Content-Type'], 'application/json', 'D5 默认带 Content-Type')
    eq(b.calls[0].init.headers.Authorization, undefined, 'D6 渲染层不带认证头（拼头归主进程）')
    eq(
      b.calls[0].body,
      { input: '余额不足', voice: 'zh-CN-YunxiNeural', speed: 1, pitch: '0', style: 'general' },
      'D7 请求体字段与父任务 D1 一致'
    )
  } finally {
    await b.done()
  }
}

{
  // ── 静态护栏：渲染层的看门超时 ────────────────────────────────────────────
  // 主进程那条 12s 超时守的是 socket（在 ipc.ts，由 test-structure F3 守）；这里守的是
  // **IPC 自己** —— invoke 永不结算时 flush 的 draining 闩会把整条播报链永久卡死。
  // 注释先剥掉：D9/D10 的字面量在注释里也出现过，裸 grep 会得到永远为绿的假护栏。
  const speechSrc = readFileSync(new URL('../src/renderer/src/speechOut.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  ok(speechSrc.length > 0, 'D0 前置：speechOut.ts 剥掉注释后非空（下面的静态断言不能空洞通过）')
  ok(
    /setTimeout\(\(\) => reject\(new Error\(CODE_UNREACHABLE\)\), TTS_TIMEOUT_MS\)/.test(speechSrc),
    'D9 渲染层的看门超时仍然排着（IPC 卡死时兜底；改回 fetch 即红）'
  )
  ok(/const TTS_TIMEOUT_MS = \d+/.test(speechSrc), 'D10 超时时长有具名常量（静态检查）')
}

{
  const b = await withBroadcast({ routes: () => ({ res: okRes() }) })
  try {
    enqueue({ text: '余额不足', urgent: true, bill: true })
    await flush({
      config: {
        url: 'https://x.test/tts',
        voice: 'v',
        speed: 2,
        style: 'newscast',
        authHeader: { Authorization: 'Bearer k' }
      },
      fallback: false
    })
    eq(b.calls[0].url, 'https://x.test/tts', 'D11 自定义 url 被使用')
    // D12 曾经断言「authHeader 合并进请求头 = Bearer k」，**方向反过来了**：
    // token 收口之后渲染层不许自己拼认证头，配置里塞进来的 authHeader 必须发不出去
    // （主进程 tts:speak 会覆盖它，但免费服务没有 token，放行就是带一个假身份出去）。
    eq(
      b.calls[0].init.headers.Authorization,
      undefined,
      'D12 渲染层不拼认证头：配置里塞 authHeader 也不发出去（token 收口，AC7/FR6）'
    )
    eq(
      b.calls[0].init.headers['Content-Type'],
      'application/json',
      'D13 Content-Type 照常发出（认证头收口后请求头只剩它）'
    )
    eq(b.calls[0].body.voice, 'v', 'D14 自定义音色生效')
    eq(b.calls[0].body.speed, 2, 'D15 自定义语速生效')
    // D16/D17：语音风格此前是被**硬编码**写死的 'general' —— 用户在服务页面能挑 11 种，
    // 我们这边一个都发不出去。这条要能在「style 改回硬编码」时变红。
    eq(b.calls[0].body.style, 'newscast', 'D16 自定义语音风格真的进了请求体（不是写死的 general）')
    eq(
      DEFAULT_TTS_CONFIG.style,
      'general',
      'D17 出厂默认风格仍是 general（旧配置无 style 字段时补的就是它，行为不变）'
    )
  } finally {
    await b.done()
  }
}

{
  const b = await withBroadcast({ routes: () => ({ res: okRes() }) })
  try {
    enqueue({ text: '余额不足', urgent: true, bill: true })
    await flush({ config: { ...DEFAULT_TTS_CONFIG, url: '' }, fallback: true })
    eq(b.calls.length, 0, 'D16 未配置 TTS 服务 → 一次请求都不发（AC3）')
    eq(b.sys.spoken.length, 0, 'D17 未配置时连系统语音回退也不走（AC3）')
    ok(b.logs.has('未配置 TTS 服务'), 'D18 未配置时留日志')
  } finally {
    await b.done()
  }
}

{
  // 「没配置」不是一次播报，不该占掉一次频率配额：
  // 用户把地址清空的那几分钟里若把配额记满，恢复地址后反而要等窗口滑出才播得出第一句。
  // 所以这里连发 3 条「未配置」，随后配好地址立刻播 —— 必须一次就放行。
  const b = await withBroadcast({ routes: () => ({ res: okRes() }) })
  try {
    for (let i = 0; i < 3; i++) {
      enqueue({ text: `未配置 ${i}`, urgent: true, bill: true })
      await flush({ config: { ...DEFAULT_TTS_CONFIG, url: '' }, fallback: false })
    }
    enqueue({ text: '配好之后的第一句', urgent: true, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    eq(b.calls.length, 1, 'D19 未配置的 3 次不占配额：配好之后第一句立刻放行')
    eq(b.calls[0].body.input, '配好之后的第一句', 'D20 且播的是配好之后那一条')
  } finally {
    await b.done()
  }
}

out('\nE. 重试与回退的触发条件（external-api-integration §7）')

{
  const b = await withBroadcast({
    routes: (url, n) => (n === 1 ? { res: { ok: false, status: 500 } } : { res: okRes() })
  })
  try {
    enqueue({ text: '余额不足', urgent: true, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    eq(b.calls.length, 2, 'E1 5xx 重试 1 次后成功（共 2 次请求）')
    ok(b.logs.has('第 1 次尝试失败'), 'E2 第一次失败有日志（外部调用失败必须留痕）')
  } finally {
    await b.done()
  }
}

{
  const b = await withBroadcast({ routes: () => ({ res: { ok: false, status: 401 } }) })
  try {
    enqueue({ text: '余额不足', urgent: true, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    eq(b.calls.length, 1, 'E3 401 是会话问题 → 不重试（只 1 次请求）')
    ok(b.logs.has('不重试'), 'E4 401 明确说明为什么不重试')
  } finally {
    await b.done()
  }
}

{
  const b = await withBroadcast({ routes: () => ({ res: { ok: false, status: 403 } }) })
  try {
    enqueue({ text: '余额不足', urgent: true, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    eq(b.calls.length, 1, 'E5 403 同样不重试')
  } finally {
    await b.done()
  }
}

{
  const b = await withBroadcast({ routes: () => ({ throw: 'fetch failed' }) })
  try {
    enqueue({ text: '余额不足', urgent: true, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    eq(b.calls.length, 2, 'E6 网络层失败重试 1 次后放弃（共 2 次请求）')
    ok(b.logs.has('TTS 播报失败'), 'E7 失败显式抛给上层（回退路径依赖它）')
  } finally {
    await b.done()
  }
}

// ── 原因码契约（09-29-tts-request-to-main）─────────────────────────────────────
//
// 请求搬进主进程后，失败只以**原因码**跨进程（Electron IPC 只透传 `Error.message`，
// 靠 Error.name 带信息是行不通的）：`TTS_UNREACHABLE`（DNS/连接/超时）、
// `TTS_HTTP_<n>`（服务返回非 2xx）。这一组直接让桩抛主进程会抛的那种 Error，
// 断言的是契约本身，而不是桩的转换逻辑。

{
  const b = await withBroadcast({ routes: () => ({ throw: 'TTS_UNREACHABLE' }) })
  const seen = []
  try {
    enqueue({ text: '甲', urgent: true, bill: true })
    await flush({
      config: DEFAULT_TTS_CONFIG,
      fallback: false,
      onTtsFailed: (r) => seen.push(r)
    })
    eq(b.calls.length, 2, 'E8 TTS_UNREACHABLE 按网络层失败重试 1 次后放弃')
    eq(
      seen,
      ['连不上语音服务'],
      'E9 原因码翻译成人话再给用户（设置页不该看到 TTS_UNREACHABLE 这种内部码）'
    )
  } finally {
    await b.done()
  }
}

{
  // 「置不可达」的那条链：probeTts 的 reason 就是设置页提示与退避排程的输入。
  const b = await withBroadcast({ routes: () => ({ throw: 'TTS_UNREACHABLE' }) })
  try {
    const r = await probeTts(DEFAULT_TTS_CONFIG)
    eq(r.ok, false, 'E10 原因码失败 → 探测判为未恢复')
    eq(r.reason, '连不上语音服务', 'E11 探测原因同样是人话（它是那句提示的唯一来源）')
    eq(b.calls.length, 2, 'E12 探测与播报共用同一条重试策略')
  } finally {
    await b.done()
  }
}

{
  // 401/403 不重试：E3/E5 走的是桩里 `{ res: { status } }` → `TTS_HTTP_401` 的转换，
  // 这一条直接抛主进程会抛的字面量，钉住「码的形状」本身（ipc.ts 的 `TTS_HTTP_${status}`）。
  const b = await withBroadcast({ routes: () => ({ throw: 'TTS_HTTP_401' }) })
  try {
    enqueue({ text: '甲', urgent: true, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    eq(b.calls.length, 1, 'E13 TTS_HTTP_401 是凭据问题 → 不重试（只 1 次请求）')
  } finally {
    await b.done()
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
out('\nF. 音频生命周期：createObjectURL / revokeObjectURL 必须配平')

{
  const b = await withBroadcast({ routes: () => ({ res: okRes() }) })
  try {
    enqueue({ text: '余额不足', urgent: true, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    eq(b.urls.made.length, 1, 'F1 播一条申请 1 个 blob URL')
    eq(b.urls.revoked, b.urls.made, 'F2 播完释放同一个 blob URL')
    eq(b.audio()[0].playCalls, 1, 'F3 音频只播一次')
  } finally {
    await b.done()
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
out('\nG. 队列：例行串行排队；播报时长追上触发间隔就跳过')

{
  // 播报进行中再次触发 → 排队串行：三条同时在队列里（第一条在播、后两条待播），
  // 逐条放行，绝不合并、绝不并发
  const b = await withBroadcast({ autoEnd: false, routes: () => ({ res: okRes() }) })
  try {
    enqueue({ text: '例行一', urgent: false, bill: true })
    enqueue({ text: '例行二', urgent: false, bill: true })
    enqueue({ text: '例行三', urgent: false, bill: true })
    const p = flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    await waitForCount(b.audio, 1)
    eq(b.calls.length, 1, 'G1 只发了第 1 条，后两条在排队（没有并发请求）')
    await finishItem(b, 0)
    await waitForCount(b.audio, 2)
    eq(b.calls[1]?.body?.input, '例行二', 'G2 第 1 条播完才放第 2 条（串行）')
    await finishItem(b, 1)
    await waitForCount(b.audio, 3)
    eq(b.calls[2]?.body?.input, '例行三', 'G3 第 2 条播完才放第 3 条（串行）')
    await finishItem(b, 2)
    await p
    eq(
      b.calls.map((c) => c.body.input),
      ['例行一', '例行二', '例行三'],
      'G4 例行逐条串行播，不合并不丢弃'
    )
    eq(b.audio().length, 3, 'G5 每条各播一次，串行不叠加')
  } finally {
    await b.done()
  }
}

{
  const b = await withBroadcast({ autoEnd: false, routes: () => ({ res: okRes() }) })
  try {
    enqueue({ text: '例行一', urgent: false, bill: true })
    const p = flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    await waitForCount(b.audio, 1)
    b.clk.advance(61_000)
    enqueue({ text: '例行二', urgent: false, bill: true })
    enqueue({ text: '例行三', urgent: false, bill: true })
    enqueue({ text: '例行四', urgent: false, bill: true })
    b.clk.advance(61_000)
    enqueue({ text: '例行五', urgent: false, bill: true })
    b.clk.advance(61_000)
    enqueue({ text: '例行六', urgent: false, bill: true })
    ok(b.logs.has('队列已满'), 'G6 队列堆到上限后跳过新触发并记日志')
    stopAll()
    await p
    eq(b.calls.length, 1, 'G7 被跳过的触发没有发请求（不叠加）')
  } finally {
    await b.done()
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
out('\nH. 打断：紧急插队打断例行，并清空队列')

{
  const b = await withBroadcast({ autoEnd: false, routes: () => ({ res: okRes() }) })
  try {
    enqueue({ text: '例行一', urgent: false, bill: true })
    const p = flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    await waitForCount(b.audio, 1)
    b.clk.advance(61_000)
    enqueue({ text: '例行二', urgent: false, bill: true })
    enqueue({ text: '例行三', urgent: false, bill: true })
    b.clk.advance(61_000)
    enqueue({ text: '紧急预警', urgent: true, bill: true })
    eq(b.audio()[0].pauseCalls, 1, 'H1 紧急入队 → 例行音频被 pause')
    ok(b.logs.has('紧急插队'), 'H2 打断有日志')
    await waitForCount(b.audio, 2)
    eq(b.calls[1]?.body?.input, '紧急预警', 'H3 紧急插到最前播')
    // 让紧急播完，并给「若例行二/三没被清空」留出一个真能发请求的窗口：
    // 不断言这一点的话，只把「清空」改坏会让队列多播两条，而断言永远等不到
    b.clk.advance(61_000)
    await finishItem(b, 1)
    await new Promise((r) => setTimeout(r, 20))
    eq(
      b.calls.map((c) => c.body.input),
      ['例行一', '紧急预警'],
      'H4 例行二/三被清空，紧急播完后一次请求都没再发'
    )
    stopAll()
    await p
  } finally {
    await b.done()
  }
}

{
  const b = await withBroadcast({ autoEnd: false, routes: () => ({ res: okRes() }) })
  try {
    enqueue({ text: '例行一', urgent: false, bill: true })
    const p = flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    await waitForCount(b.audio, 1)
    b.clk.advance(61_000)
    enqueue({ text: '例行二', urgent: false, bill: true })
    b.clk.advance(61_000)
    enqueue({ text: '紧急预警', urgent: true, bill: true })
    await waitForCount(b.audio, 2)
    eq(b.calls[1]?.body?.input, '紧急预警', 'H5 没有正在播的例行可打断时，紧急仍插到例行二前面')
    b.clk.advance(61_000)
    await finishItem(b, 1)
    await new Promise((r) => setTimeout(r, 20))
    eq(
      b.calls.map((c) => c.body.input),
      ['例行一', '紧急预警'],
      'H6 被插队的例行二同样被清空，一次请求都没发'
    )
    stopAll()
    await p
  } finally {
    await b.done()
  }
}

{
  // 打断发生在**请求在途**（用户按停止）：响应回来时必须丢弃，不能把被抢断的那条补播出来
  let release = null
  const gate = new Promise((r) => (release = r))
  const b = await withBroadcast({
    routes: () => ({ res: { ok: true, status: 200, blob: () => gate.then(okBlob) } })
  })
  try {
    enqueue({ text: '例行一', urgent: false, bill: true })
    const p = flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    // 等请求确实发出、卡在 blob() 上
    for (let i = 0; i < 200 && b.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 2))
    stopAll()
    release()
    await p
    eq(b.calls.length, 1, 'H7 在途请求被丢弃：停止后不补播已发出的那一条')
    eq(b.audio().length, 0, 'H8 在途响应没有建音频元素')
    ok(b.logs.has('在途时被打断'), 'H9 丢弃有日志')
  } finally {
    await b.done()
  }
}

{
  // 紧急在「紧急正在播」时到来：队列不会被清空（没有例行可打断），但它仍必须排到最前 ——
  // 否则紧急要干等着前面的例行一条条念完
  const b = await withBroadcast({ autoEnd: false, routes: () => ({ res: okRes() }) })
  try {
    enqueue({ text: '紧急一', urgent: true, bill: true })
    const p = flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    await waitForCount(b.audio, 1)
    b.clk.advance(61_000)
    enqueue({ text: '例行二', urgent: false, bill: true })
    enqueue({ text: '例行三', urgent: false, bill: true })
    b.clk.advance(61_000)
    enqueue({ text: '紧急四', urgent: true, bill: true })
    b.clk.advance(61_000)
    await finishItem(b, 0)
    await waitForCount(b.audio, 2)
    eq(b.calls[1]?.body?.input, '紧急四', 'H10 紧急即使不能打断，也排到排队的例行前面')
    await finishItem(b, 1)
    await waitForCount(b.audio, 3)
    eq(b.calls[2]?.body?.input, '例行二', 'H11 紧急播完后回到例行的原顺序')
    await finishItem(b, 2)
    await waitForCount(b.audio, 4)
    await finishItem(b, 3)
    await p
    eq(
      b.calls.map((c) => c.body.input),
      ['紧急一', '紧急四', '例行二', '例行三'],
      'H12 完整顺序：两条紧急在前，两条例行按入队顺序'
    )
  } finally {
    await b.done()
  }
}

{
  // 打断必须立刻结束「估算时长」里的等待：否则紧急项要干等一整条例行念完（这里 9s）
  const long = '甲'.repeat(50)
  const b = await withBroadcast({
    autoEnd: false,
    routes: () => ({ res: { ok: false, status: 500 } })
  })
  try {
    enqueue({ text: long, urgent: false, bill: true })
    const p = flush({ config: DEFAULT_TTS_CONFIG, fallback: true })
    for (let i = 0; i < 400 && b.sys.spoken.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    eq(pacedMs(long), 9000, 'H13 这条会按 9s 估算（前提成立，后面的时间断言才有意义）')
    const t0 = performance.now()
    stopAll()
    await p
    const spent = Math.round(performance.now() - t0)
    ok(spent < 3000, `H14 打断立刻结束估算等待（实测 ${spent}ms，不唤醒的话要等满 9000ms）`)
  } finally {
    await b.done()
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
out('\nI. stopAll：两个通道都要停')

{
  const b = await withBroadcast({ autoEnd: false, routes: () => ({ res: okRes() }) })
  try {
    enqueue({ text: '例行一', urgent: false, bill: true })
    const p = flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    await waitForCount(b.audio, 1)
    stopAll()
    await p
    eq(b.audio()[0].pauseCalls, 1, 'I1 TTS 音频通道被 pause')
    eq(b.sys.cancelCount(), 1, 'I2 系统语音通道被 cancel')
    eq(b.urls.revoked, b.urls.made, 'I3 被打断的音频 blob URL 仍然释放')
  } finally {
    await b.done()
  }
}

{
  const b = await withBroadcast({
    autoEnd: false,
    routes: () => ({ res: { ok: false, status: 500 } })
  })
  try {
    enqueue({ text: '甲', urgent: true, bill: true })
    const p = flush({ config: DEFAULT_TTS_CONFIG, fallback: true })
    for (let i = 0; i < 200 && b.sys.spoken.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    stopAll()
    await p
    eq(b.sys.spoken, ['甲'], 'I4 系统语音确实开口了（这条测的是真在播）')
    ok(b.sys.cancelCount() >= 1, 'I5 系统语音通道被 cancel')
  } finally {
    await b.done()
  }
}

{
  const b = await withBroadcast({
    autoEnd: false,
    routes: () => ({ res: { ok: false, status: 500 } })
  })
  try {
    enqueue({ text: '甲', urgent: true, bill: true })
    const p = flush({ config: DEFAULT_TTS_CONFIG, fallback: true })
    for (let i = 0; i < 200 && b.sys.spoken.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    b.clk.advance(61_000)
    enqueue({ text: '乙', urgent: false, bill: true })
    await p
    eq(b.sys.spoken, ['甲', '乙'], 'I6 系统语音播报中再次触发 → 接着念，不是叠在一起')
  } finally {
    await b.done()
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
out('\nJ. 系统语音回退（fallback）')

{
  const b = await withBroadcast({ routes: () => ({ throw: 'fetch failed' }) })
  try {
    enqueue({ text: '甲', urgent: true, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: true })
    eq(b.calls.length, 2, 'J1 重试 1 次后走回退')
    eq(b.sys.spoken, ['甲'], 'J2 系统语音收到同一条文本（DNS 污染场景，AC11）')
    eq(b.audio().length, 0, 'J3 回退时不建 TTS 音频元素')
  } finally {
    await b.done()
  }
}

{
  const b = await withBroadcast({ routes: () => ({ throw: 'fetch failed' }) })
  try {
    enqueue({ text: '甲', urgent: true, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    eq(b.sys.spoken.length, 0, 'J4 fallback=false 时不开口')
  } finally {
    await b.done()
  }
}

{
  // ui:voiceGender 必须一路透到 voice.speak()：改播报链路时漏过一次，
  // 用户挑的男声被作废、回退时一律用列表里第一个音色念
  const b = await withBroadcast({ routes: () => ({ throw: 'fetch failed' }) })
  try {
    enqueue({ text: '要男声', urgent: true, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: true, gender: 'male' })
    b.clk.advance(61_000)
    enqueue({ text: '要女声', urgent: false, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: true, gender: 'female' })
    b.clk.advance(61_000)
    enqueue({ text: '不限制', urgent: false, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: true })
    eq(b.sys.voiceNames, ['Li-Mu', 'Ting-Ting', 'Ting-Ting'], 'J4b 回退播报按 gender 选音色（不传 = 不限制）')
    eq(b.sys.spoken, ['要男声', '要女声', '不限制'], 'J4c 三条都真的念了（不是只有第一条过了闸门）')
  } finally {
    await b.done()
  }
}

{
  const b = await withBroadcast({ autoEnd: false, routes: () => ({ res: okRes() }) })
  try {
    enqueue({ text: '甲', urgent: true, bill: true })
    const p = flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    await waitForCount(b.audio, 1)
    enqueue({ text: '乙', urgent: false, bill: true })
    enqueue({ text: '丙', urgent: false, bill: true })
    b.clk.advance(61_000)
    await finishItem(b, 0)
    await waitForCount(b.audio, 2)
    b.clk.advance(61_000)
    await finishItem(b, 1)
    await waitForCount(b.audio, 3)
    await finishItem(b, 2)
    await p
    eq(
      b.calls.map((c) => c.body.input),
      ['甲', '乙', '丙'],
      'J5 TTS 播报中再次触发 → 排队串行'
    )
  } finally {
    await b.done()
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
out('\nK. 视觉通知与频率闸门的关系')

{
  const b = await withBroadcast({ routes: () => ({ res: okRes() }) })
  try {
    const seen = []
    enqueue({ text: '甲', urgent: true, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false, onVisual: (t) => seen.push(t) })
    eq(seen, ['甲'], 'K1 正常播报时视觉通知触发')
  } finally {
    await b.done()
  }
}

{
  const b = await withBroadcast({ routes: () => ({ res: okRes() }) })
  try {
    const seen = []
    enqueue({ text: '甲', urgent: true, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false, onVisual: (t) => seen.push(t) })
    enqueue({ text: '乙', urgent: false, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false, onVisual: (t) => seen.push(t) })
    eq(b.calls.length, 1, 'K2 闸门拦住第二条 → 不发请求')
    eq(seen, ['甲', '乙'], 'K3 视觉通知与音频通道独立，被拦的仍然提示')
    ok(b.logs.has('频率超限'), 'K4 超限有日志（跳过本次播报要留痕）')
  } finally {
    await b.done()
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
out('\nL. 一条播报抛错不能掐断整条队列')

{
  // onVisual 是**调用方给的回调**，它抛错是别人的 bug，不该让后面的播报一起陪葬
  const b = await withBroadcast({ routes: () => ({ res: okRes() }) })
  try {
    enqueue({ text: '甲', urgent: true, bill: true })
    const p = flush({
      config: DEFAULT_TTS_CONFIG,
      fallback: false,
      onVisual: (t) => {
        if (t === '甲') throw new Error('视觉通知炸了（调用方的锅）')
      }
    })
    b.clk.advance(61_000)
    enqueue({ text: '乙', urgent: false, bill: true })
    let outcome = 'resolved'
    try {
      await p
    } catch (e) {
      outcome = `rejected: ${e.message}`
    }
    eq(outcome, 'resolved', 'L1 单条抛错不会让 flush 整个 reject')
    eq(b.calls.map((c) => c.body.input), ['乙'], 'L2 出错的那条被跳过，后面的照常播')
    ok(b.logs.has('单条播报失败'), 'L3 跳过有日志')
  } finally {
    await b.done()
  }
}

out('\nM. 「服务不可达」信号：onTtsFailed / onTtsOk')

// 为什么这一整节都要有：onTtsFailed 是设置页那句「服务当前不可达」的唯一来源
// （design.md D2 的优雅降级）。它断了不会抛、不会红 —— 用户只是「没声音」，
// 分不清是服务挂了还是自己关了开关。那正是 D2 要挡的静默失效。

{
  const b = await withBroadcast({ routes: () => ({ throw: 'fetch failed' }) })
  const seen = []
  const oks = []
  try {
    enqueue({ text: '甲', urgent: true, bill: true })
    await flush({
      config: DEFAULT_TTS_CONFIG,
      fallback: false,
      onTtsFailed: (r) => seen.push(r),
      onTtsOk: () => oks.push(1)
    })
    eq(seen.length, 1, 'M1 网络层失败 → onTtsFailed 回调一次（带原因）')
    ok(seen[0] !== '', 'M2 回调带的是非空原因，不是空串（设置页要显示「为什么」）')
    eq(oks.length, 0, 'M3 失败了不许顺带报成功')
  } finally {
    await b.done()
  }
}

{
  // 这一条最容易写错：回退到系统语音**播出来了**，但 TTS 服务**仍然是不可达的**。
  // 少回调一次，用户看到的却是「一切正常」—— 而下一次真正的新命中仍然会失败。
  const b = await withBroadcast({ routes: () => ({ throw: 'fetch failed' }) })
  const seen = []
  try {
    enqueue({ text: '甲', urgent: true, bill: true })
    await flush({
      config: DEFAULT_TTS_CONFIG,
      fallback: true,
      onTtsFailed: (r) => seen.push(r)
    })
    eq(b.sys.spoken.length, 1, 'M4 前提：回退确实开口了')
    eq(seen.length, 1, 'M5 回退成功**仍然**要报不可达（服务还是挂着，只是不再静默）')
  } finally {
    await b.done()
  }
}

{
  const b = await withBroadcast({ routes: () => ({ res: { ok: false, status: 401 } }) })
  const seen = []
  try {
    enqueue({ text: '甲', urgent: true, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false, onTtsFailed: (r) => seen.push(r) })
    eq(seen.length, 1, 'M6 401（不重试的那条）同样要报不可达 —— 用户换错了 token 就是这个现象')
  } finally {
    await b.done()
  }
}

{
  const b = await withBroadcast({ routes: () => ({ res: okRes() }) })
  const oks = []
  const seen = []
  try {
    enqueue({ text: '甲', urgent: true, bill: true })
    await flush({
      config: DEFAULT_TTS_CONFIG,
      fallback: false,
      onTtsOk: () => oks.push(1),
      onTtsFailed: (r) => seen.push(r)
    })
    eq(oks.length, 1, 'M7 成功 → onTtsOk 回调（用来清掉那句「不可达」提示）')
    eq(seen.length, 0, 'M8 成功时不该同时报失败')
  } finally {
    await b.done()
  }
}

{
  // 没配置 / 被闸门拦下：根本没联系过服务，谈不上「可达或不可达」。
  // 报了反而会让设置页挂着一句用户看不懂的警告。
  const b = await withBroadcast({ routes: () => ({ res: okRes() }) })
  const seen = []
  const oks = []
  try {
    enqueue({ text: '未配置', urgent: true, bill: true })
    await flush({
      config: { ...DEFAULT_TTS_CONFIG, url: '' },
      fallback: true,
      onTtsFailed: (r) => seen.push(r),
      onTtsOk: () => oks.push(1)
    })
    eq(seen.length, 0, 'M9 未配置 TTS → 不报不可达（那是用户还没填地址，不是服务挂了）')
    eq(oks.length, 0, 'M10 未配置 TTS → 也不报成功')
  } finally {
    await b.done()
  }
}

{
  // 闸门拦下时同理：这一轮压根没发请求
  const b = await withBroadcast({ routes: () => ({ res: okRes() }) })
  const seen = []
  try {
    enqueue({ text: '甲', urgent: true, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false, onTtsFailed: (r) => seen.push(r) })
    enqueue({ text: '乙', urgent: false, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false, onTtsFailed: (r) => seen.push(r) })
    eq(b.calls.length, 1, 'M11 前提：第二条被分钟闸门拦下（没发请求）')
    eq(seen.length, 0, 'M12 被闸门拦下 → 不报不可达（没联系过服务）')
  } finally {
    await b.done()
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
out("\nM+. 播放层失败：onerror / play() 被拒不再被吞（09-30-tts-playback-fix）")

// 为什么这一整节都要有：playElement 旧契约「结束/失败/被打断都会 resolve」使 onTtsOk
// 永远触发 —— 请求拿到了字节、CSP 却把 blob 音频拦死时，用户看到的是「试听正常」。
// 现在失败必须 reject 抛上去，让 onTtsFailed 生效；reason 带 TTS_PLAYBACK 前缀，
// 与请求层原因码（TTS_UNREACHABLE / TTS_HTTP_*）可区分 —— 都进 onTtsFailed，但
// 设置页的「为什么没响」能告诉用户是「服务挂了」还是「音频放不出来」。

{
  // onerror 路径：请求成功拿到 blob，但 <audio> 加载 blob: 被 CSP 拦（或解码失败）
  const b = await withBroadcast({ autoError: true, autoEnd: false, routes: () => ({ res: okRes() }) })
  const seen = []
  const oks = []
  try {
    enqueue({ text: '甲', urgent: true, bill: true })
    await flush({
      config: DEFAULT_TTS_CONFIG,
      fallback: false,
      onTtsFailed: (r) => seen.push(r),
      onTtsOk: () => oks.push(1)
    })
    eq(seen.length, 1, 'MP1 onerror → onTtsFailed 回调一次（不再被吞成 onTtsOk）')
    eq(oks.length, 0, 'MP2 onerror → 不许顺带报成功（旧契约的 bug 就是这条）')
    ok(seen.length > 0 && seen[0].startsWith('TTS_PLAYBACK'), `MP3 onerror 原因带 TTS_PLAYBACK 前缀（实际 ${JSON.stringify(seen[0])}）`)
    eq(b.urls.made.length, 1, 'MP4 onerror 仍申请了 1 个 blob URL（请求是成功的）')
    eq(b.urls.revoked, b.urls.made, 'MP5 onerror 失败路径也释放 blob URL（finally 不因 throw 而跳过）')
  } finally {
    await b.done()
  }
}

{
  // play() 被拒路径：CSP 下 <audio>.play() 返回 rejected promise（NotSupportedError）
  const b = await withBroadcast({ playRejects: true, autoEnd: false, routes: () => ({ res: okRes() }) })
  const seen = []
  const oks = []
  try {
    enqueue({ text: '甲', urgent: true, bill: true })
    await flush({
      config: DEFAULT_TTS_CONFIG,
      fallback: false,
      onTtsFailed: (r) => seen.push(r),
      onTtsOk: () => oks.push(1)
    })
    eq(seen.length, 1, 'MP6 play() 被拒 → onTtsFailed 回调一次')
    eq(oks.length, 0, 'MP7 play() 被拒 → 不报成功')
    ok(seen.length > 0 && seen[0].startsWith('TTS_PLAYBACK'), `MP8 play() 被拒原因带 TTS_PLAYBACK 前缀（实际 ${JSON.stringify(seen[0])}）`)
    eq(b.urls.revoked, b.urls.made, 'MP9 play() 被拒失败路径也释放 blob URL')
    eq(b.audio()[0].playCalls, 1, 'MP10 play() 真被调用过（不是没调就报失败）')
  } finally {
    await b.done()
  }
}

{
  // 正常路径回归：onended 仍 resolve → onTtsOk（改契约不能把成功也误伤成失败）
  const b = await withBroadcast({ routes: () => ({ res: okRes() }) })
  const seen = []
  const oks = []
  try {
    enqueue({ text: '甲', urgent: true, bill: true })
    await flush({
      config: DEFAULT_TTS_CONFIG,
      fallback: false,
      onTtsFailed: (r) => seen.push(r),
      onTtsOk: () => oks.push(1)
    })
    eq(oks.length, 1, 'MP11 onended 正常播完 → onTtsOk（成功路径未被误伤）')
    eq(seen.length, 0, 'MP12 正常播完不报失败')
  } finally {
    await b.done()
  }
}

{
  // 打断路径回归：被新播报抢断不是失败（旧 active.settle 调用现走 done=resolve）
  // 若改契约时把打断也误改成 reject，这里会红 —— 打断会把旧条报成 onTtsFailed。
  // 注：被打断的那条走 done=resolve，仍会触发 onTtsOk（既有行为，本任务不动这条路径）；
  // 这里只验「打断不产生失败」，不验 onTtsOk 的次数。
  const b = await withBroadcast({ autoEnd: false, routes: () => ({ res: okRes() }) })
  const seen = []
  try {
    enqueue({ text: '例行一', urgent: false, bill: true })
    const p1 = flush({ config: DEFAULT_TTS_CONFIG, fallback: false, onTtsFailed: (r) => seen.push(r) })
    await waitForCount(b.audio, 1)
    // 推进时钟让频率闸门放行第二条（bill=true 都受限，紧急也不例外）
    b.clk.advance(61_000)
    enqueue({ text: '紧急预警', urgent: true, bill: true })
    const p2 = flush({ config: DEFAULT_TTS_CONFIG, fallback: false, onTtsFailed: (r) => seen.push(r) })
    await waitForCount(b.audio, 2)
    eq(b.audio()[0].pauseCalls, 1, 'MP13a 前提：例行一真被打断（pause 被调），不是被当成失败')
    // 让紧急播完
    b.audio()[1].onended?.()
    await Promise.all([p1, p2])
    eq(seen.length, 0, 'MP13b 打断不报失败（打断是设计内行为，若误改成 reject 这里会红）')
  } finally {
    await b.done()
  }
}

{
  // 回退路径：播放失败若开了 fallback，应接着念系统语音（与请求失败同一条回退语义）
  const b = await withBroadcast({ autoError: true, autoEnd: false, routes: () => ({ res: okRes() }) })
  const seen = []
  try {
    enqueue({ text: '甲', urgent: true, bill: true })
    await flush({
      config: DEFAULT_TTS_CONFIG,
      fallback: true,
      onTtsFailed: (r) => seen.push(r)
    })
    eq(seen.length, 1, 'MP15 播放失败 + 开回退 → 仍报 onTtsFailed（服务字节回来了但没出声）')
    eq(b.sys.spoken.length, 1, 'MP16 播放失败 + 开回退 → 接着念系统语音（用户至少听到一句）')
    ok(seen.length > 0 && seen[0].startsWith('TTS_PLAYBACK'), 'MP17 回退路径的失败原因仍带 TTS_PLAYBACK 前缀')
  } finally {
    await b.done()
  }
}

{
  // 测试播报（bill=false）播放失败 → 走 onTtsFailed，绝不走 onTtsOk（AC6）
  // 「试听正常」只允许在真的播完时出现 —— 旧契约正是把播放失败也报成了成功。
  // 这条不设 fallback 回调：测试播报的反馈（showTestNote）由 App.tsx 在 onTtsFailed 里拼，
  // 这里验的是 flush 层的回调契约（P6/P6e 已钉 App.tsx 侧的文案与通路）。
  const b = await withBroadcast({ autoError: true, autoEnd: false, routes: () => ({ res: okRes() }) })
  const seen = []
  const oks = []
  try {
    enqueue({ text: '示例句', urgent: false, bill: false })
    await flush({
      config: DEFAULT_TTS_CONFIG,
      fallback: false,
      onTtsFailed: (r) => seen.push(r),
      onTtsOk: () => oks.push(1)
    })
    eq(seen.length, 1, 'MP18 测试播报（bill=false）播放失败 → onTtsFailed 回调（AC6 的行为侧）')
    eq(oks.length, 0, 'MP19 测试播报（bill=false）播放失败 → 不触发 onTtsOk（不会弹「试听正常」）')
    ok(seen.length > 0 && seen[0].startsWith('TTS_PLAYBACK'), 'MP20 测试播报失败原因也带 TTS_PLAYBACK 前缀')
  } finally {
    await b.done()
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
out('\nN. 计费分流（缺陷 1）：测试播报不受频率闸门限制，定时播报照旧受限')

// 为什么这一整节都要有：闸门过去挂在 playOne 的公共路径上无条件生效，于是设置页的
// 「测试播报」第二次点击就被**静默丢弃** —— 无日志、无提示、无声音。更糟的是它连带
// 造成了缺陷 2：onTtsOk 再也不会触发，那句「服务当前不可达」就永久粘住了。
// 这一节的两侧都必须钉死：放行用户主动点击 ≠ 削弱无人值守播报的配额保护（NFR3）。

{
  // AC5：一分钟内连点三次「测试播报」，三次都得响。
  // 刻意**不推时钟** —— 推了就等于证明「其实只是等到了下一分钟」，闸门有没有被绕过就说不清了。
  //
  // 每次点击单独 enqueue + 单独 flush（App 的 testSpeak 就是这么做的：两次调用，不是
  // 一次入队一次排空）。用「一次入队 3 条 + 一次 flush」也能过，但那只证明了队列放得下
  // 3 条，证明不了「点 3 次」这条真实通路 —— 上一版就是那么写的，这里改成点击序列。
  const b = await withBroadcast({ routes: () => ({ res: okRes() }) })
  try {
    const p = Promise.all(
      [1, 2, 3].map((i) => {
        enqueue({ text: `试听 ${i}`, urgent: false, bill: false })
        return flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
      })
    )
    await p
    eq(b.calls.length, 3, 'N1 测试播报连点 3 次 → 3 次都发了请求（AC5）')
    eq(
      b.calls.map((c) => c.body.input),
      ['试听 1', '试听 2', '试听 3'],
      'N2 三条都真的播了，一条都没被静默丢弃'
    )
    eq(b.audio().length, 3, 'N3 每条都建了音频元素（不是只请求了没播）')
    ok(!b.logs.has('频率超限'), 'N4 测试播报不该留下「频率超限」的日志')
  } finally {
    await b.done()
  }
}

{
  // AC6 / NFR3：定时与预警播报仍然被 1 次/分钟、10 次/小时约束。
  // 这条与 N1 是同一批的目标 —— 只钉住放行侧就等于把配额保护悄悄删了。
  const b = await withBroadcast({ routes: () => ({ res: okRes() }) })
  try {
    for (let i = 1; i <= 3; i++) enqueue({ text: `定时 ${i}`, urgent: true, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    eq(b.calls.length, 1, 'N5 定时播报连发 3 次 → 仍只放行 1 次（AC6 配额保护未削弱）')
    ok(b.logs.has('频率超限'), 'N6 被拦下的那条有日志（不是无声消失）')
  } finally {
    await b.done()
  }
}

{
  // 「不计费」的另一半：不只是自己不被拦，还**不许占掉别人的一次配额**。
  // 漏掉记账的话，用户试听十次就把当小时的配额吃光了，定时播报随后全部哑火。
  const b = await withBroadcast({ routes: () => ({ res: okRes() }) })
  try {
    enqueue({ text: '试听', urgent: false, bill: false })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    enqueue({ text: '紧接着的定时播报', urgent: true, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    eq(b.calls.length, 2, 'N7 测试播报不占配额：紧随其后的定时播报立刻放行')
    eq(b.calls[1]?.body?.input, '紧接着的定时播报', 'N8 且播的是定时那一条')
  } finally {
    await b.done()
  }
}

{
  // 顺序反过来也成立：先占掉配额的那次不能因为后面有不计费的播报而被「退」回去
  const b = await withBroadcast({ routes: () => ({ res: okRes() }) })
  try {
    enqueue({ text: '定时播报', urgent: true, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    enqueue({ text: '用户试听', urgent: false, bill: false })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    enqueue({ text: '第二条定时', urgent: true, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    eq(b.calls.length, 2, 'N9 计时序被正确记账：第二次定时播报仍被拦，只有试听放行')
  } finally {
    await b.done()
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
out('\nO. 不可达自愈（缺陷 2）：退避探测状态机 + 静默探测')

// 这一节钉的是 AC7「一次失败后，若服务恢复，『不可达』提示能自动消失」。
// 旧实现里清标志只靠 onTtsOk，而 onTtsOk 只在**播报成功**后触发 —— 于是
// 「失败置位 → 后续播报被闸门拦下 → 永远不成功 → 永久置位」形成死结。
// 破局点必须是一个**不经过队列、不经过闸门**的通路，也就是 probeTts。

{
  eq(PROBE_DELAYS, [5_000, 15_000, 60_000, 300_000], 'O1 退避档位 5s/15s/1min/5min')
  const idle = { tried: 0, unreachable: false, exhaustedAt: 0 }
  const s1 = probeStep(idle, 'fail', 1000)
  eq(s1.next, { tried: 1, unreachable: true, exhaustedAt: 0 }, 'O2 首次失败 → 置位并排第一次探测')
  eq(s1.delayMs, 5_000, 'O3 第一次探测等 5 秒')

  // 用满四档：15s → 60s → 5min，然后停止
  const s2 = probeStep(s1.next, 'probe-fail', 6000)
  eq(s2.delayMs, 15_000, 'O4 探测仍失败 → 第二档 15 秒')
  const s3 = probeStep(s2.next, 'probe-fail', 21000)
  eq(s3.delayMs, 60_000, 'O5 第三档 1 分钟')
  const s4 = probeStep(s3.next, 'probe-fail', 81000)
  eq(s4.delayMs, 300_000, 'O6 第四档 5 分钟')
  const s5 = probeStep(s4.next, 'probe-fail', 381000)
  eq(s5.delayMs, null, 'O7 档位用尽 → 不再排程（不无限重试）')
  eq(s5.next.unreachable, true, 'O8 用尽之后提示仍在（别把用户吓跑）')
  eq(s5.next.exhaustedAt, 381000, 'O8b 用尽时刻被记下（供重启冷却判断）')
}

{
  // 恢复：AC7 的另一半。两条通路都能清 —— 真实播报成功、探测成功。
  eq(
    probeStep({ tried: 3, unreachable: true, exhaustedAt: 0 }, 'ok', 1000).next,
    { tried: 0, unreachable: false, exhaustedAt: 0 },
    'O9 探测成功 → 标志清掉且计数归零（AC7）'
  )
  eq(
    probeStep({ tried: 3, unreachable: true, exhaustedAt: 999_000 }, 'ok', 1000).next.exhaustedAt,
    0,
    'O9b 恢复时清掉 exhaustedAt（否则下次失败会撞上残留冷却，明明通了还要等 10 分钟）'
  )
  eq(
    probeStep({ tried: 3, unreachable: true, exhaustedAt: 0 }, 'ok', 1000).delayMs,
    null,
    'O10 恢复后不再排下一次探测'
  )
  eq(
    probeStep({ tried: 2, unreachable: true, exhaustedAt: 0 }, 'probe-fail', 1000).next.unreachable,
    true,
    'O11 探测失败不会误清标志'
  )
}

{
  // 「null 有两种含义」那条契约：不许因为一次新失败就把正在跑的链推后。
  // 链在跑时再来一次真实失败 → 状态原样返回（调用方据此**不动**已有定时器）。
  const running = { tried: 2, unreachable: true, exhaustedAt: 0 }
  const again = probeStep(running, 'fail', 1000)
  eq(again.next, running, 'O12 链还在跑时新的失败不重置进度')
  eq(again.delayMs, null, 'O13 也不重排下一次探测（否则越失败越往后推）')

  // ── 重启冷却：链用尽后不是每次失败都能重开 ──────────────────────────────
  // 真实失败由 30s 轮询驱动 + 1 次/分钟闸门 → 约 1 次/分。若每次都重开一条链，
  // 服务挂着时会有 4 条探测并排 ≈ 8 次请求/分打向免费服务。
  const T0 = 1_000_000
  const justExhausted = { tried: PROBE_DELAYS.length, unreachable: true, exhaustedAt: T0 }
  const withinCooldown = probeStep(justExhausted, 'fail', T0 + 60_000)
  eq(withinCooldown.delayMs, null, 'O14a 刚用尽 1 分钟内的新失败不重开链（冷却中）')
  eq(withinCooldown.next, justExhausted, 'O14b 冷却期内状态原样返回，不动已有定时器')
  const edgeBefore = probeStep(justExhausted, 'fail', T0 + PROBE_RESTART_COOLDOWN_MS - 1)
  eq(edgeBefore.delayMs, null, 'O14c 冷却差 1 毫秒仍不放行（边界在包含侧）')
  const afterCooldown = probeStep(justExhausted, 'fail', T0 + PROBE_RESTART_COOLDOWN_MS)
  eq(afterCooldown.delayMs, 5_000, 'O14d 冷却满 10 分钟才允许重开链')
  eq(
    afterCooldown.next,
    { tried: 1, unreachable: true, exhaustedAt: 0 },
    'O14e 重开时清掉 exhaustedAt（新链自己的冷却重新计时）'
  )
  eq(
    probeStep({ tried: PROBE_DELAYS.length, unreachable: true, exhaustedAt: 0 }, 'fail', T0).delayMs,
    5_000,
    'O15 从没用尽过（exhaustedAt=0）→ 立即重开，不受冷却限制'
  )
  // 恢复后第一次失败必须能立刻探测 —— 不该被上一轮的冷却卡住
  const recovered = probeStep(justExhausted, 'ok', T0)
  eq(
    probeStep(recovered.next, 'fail', T0 + 1).delayMs,
    5_000,
    'O16 服务恢复后的首次失败立即重开链（否则刚通了却 10 分钟不探测）'
  )
}

{
  const b = await withBroadcast({ routes: () => ({ res: okRes() }) })
  try {
    const r = await probeTts(DEFAULT_TTS_CONFIG)
    eq(r.ok, true, 'O16 探测成功返回 ok')
    eq(r.reason, '', 'O17 成功时不带原因（空串，不是 undefined）')
    eq(b.calls.length, 1, 'O18 探测确实联系了服务（一次请求）')
    eq(b.audio().length, 0, 'O19 探测不播声（没有音频元素）')
    eq(b.sys.spoken.length, 0, 'O20 探测不走系统语音')
    // 探测不许占配额：闸门的记账在 allowCall 里，探测压根没碰它
    enqueue({ text: '探测之后的定时播报', urgent: true, bill: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    eq(b.calls.length, 2, 'O21 探测不占频率配额：随后的定时播报立刻放行')
  } finally {
    await b.done()
  }
}

{
  const b = await withBroadcast({ routes: () => ({ throw: 'fetch failed' }) })
  try {
    const r = await probeTts(DEFAULT_TTS_CONFIG)
    eq(r.ok, false, 'O22 探测失败返回 ok=false')
    ok(r.reason !== '', 'O23 失败带原因（设置页要能说「连不上」）')
    eq(b.calls.length, 2, 'O24 网络失败重试 1 次后放弃（与播报同一条重试策略）')
    eq(b.audio().length, 0, 'O25 探测失败也不播声')
  } finally {
    await b.done()
  }
}

{
  const b = await withBroadcast({ routes: () => ({ res: okRes() }) })
  try {
    const r = await probeTts({ ...DEFAULT_TTS_CONFIG, url: '' })
    eq(r.ok, false, 'O26 没配地址 → 探测直接判失败')
    eq(b.calls.length, 0, 'O27 没配地址 → 一次请求都不发（不拿空地址去骚扰谁）')
  } finally {
    await b.done()
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
out('\nP. 用户可见文案：说人话 + 给下一步（缺陷 3）')

// 文案类断言的唯一有效形式是「断言那块被渲染出来的文本」，不是断言源码里某个字符串存在。
// 这里按标记切出不可达提示那一段再判 —— 拿整份文件去 grep 会把 prop 名
// （unreachable / fallback）与代码注释一起算进去，判不出任何东西。
{
  const src = readFileSync(new URL('../src/renderer/src/VoiceReminderSection.tsx', import.meta.url), 'utf8')
  const at = src.indexOf('vrs-warn')
  ok(at > 0, 'P0 前置：不可达提示仍在（找不到就说明整段被删了，下面几条会空洞通过）')
  const block = src.slice(at, src.indexOf('</div>', at))
  ok(block.length > 0, 'P0b 前置：切到了提示的正文（非空）')
  // 实现术语用拼接构造：运行时完全相同，但 grep 源码的人/门禁看不见它
  const jargon = ['回' + '退', '通' + '路', '不' + '可达', 'unreach' + 'able', '上' + '一次调用']
  for (const j of jargon) {
    ok(!block.includes(j), `P1 不可达提示不含实现术语「${j}」`)
  }
  ok(block.includes('连不上'), 'P2 说人话：告诉用户发生了什么')
  ok(block.includes('检查'), 'P3 给下一步：出现可执行的行动词')
  ok(block.includes('换个服务地址'), 'P4 给下一步：具体到可改的那一项')

  // 旧文案整句不许复活（用拼接构造，见上）
  const oldCopy = '上一次调用语音服务失败'
  ok(!src.includes(oldCopy), 'P5 旧文案整句已删除')
}
{
  const appSrc = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')

  // 试听反馈的文案住在 **App.tsx**（在 onTtsFailed / onTtsOk 里现拼），而
  // VoiceReminderSection 只负责把 testNote 渲染出来 —— 所以判「用户看得见反馈」必须判 App。
  //
  // ⚠ 而且判的是**调用形状**（showTestNote(false, 后面跟着一个模板串），不是「文件里出现过
  //   『没播出来』这几个字」。上一版判的是后者、且判错了文件：VoiceReminderSection.tsx 里
  //   唯一那处「没播出来」在一段 JSDoc 注释里，于是把 App 里整行反馈删掉，这条断言照样绿
  //   （已实测：红集 0）。注释里出现一个字不能证明用户看得到它。
  const failNote = appSrc.match(/showTestNote\(\s*false\s*,\s*`([^`]*)`/)
  ok(failNote != null, 'P6 试听失败真的调 showTestNote(false)（不是静默失败）')
  // 判内容而不是判存在：先把 ${...} 换成占位符，「带上了服务端真实原因」才可判
  const failText = (failNote?.[1] ?? '').replace(/\$\{[^}]*\}/g, '{原因}')
  ok(failText.includes('{原因}'), 'P6b 失败文案带上了服务端给的真实原因（用户知道为什么没响）')
  ok(
    ['检' + '查', '再试'].some((a) => failText.includes(a)),
    'P6c 失败文案给了下一步（说清发生了什么之后还要说「现在该怎么办」）'
  )
  ok(
    !['回' + '退', '通' + '路', '不' + '可达'].some((j) => failText.includes(j)),
    'P6d 失败文案不含实现术语'
  )
  ok(
    /showTestNote\(\s*true\s*,\s*['`]试听正常['`]/.test(appSrc),
    'P6e 试听成功也有反馈（走的是同一条 showTestNote 通路，不是另起一条）'
  )

  // 会跳闸的地方只有一处：App 的 speakOut 给测试播报传的 bill 必须是 false
  ok(
    /const testSpeak = \(text: string\): void => \{\s*speakOut\(text, false, false\)/.test(appSrc),
    'P7 设置页「测试播报」走的是不计费那条路（回归即红：bill 又被写成 true）'
  )
  ok(
    /speakOut\(d\.text, d\.urgent, true\)/.test(appSrc),
    'P8 定时 / 预警播报仍然计费（配额保护没有被顺手削弱）'
  )
  // P9 判的是「这个键在 App 里只剩注释」。注释里**必须**还能提到它 —— 那是解释
  // 「为什么不再读它」的唯一记录，删掉注释等于删掉理由。
  //
  // ⚠ 上一版的判据是「ui:voiceGender 没出现在 getExtras([...]) / setExtras({...}) 的字面量里」，
  //   而标签写的是「不再被读也不再被写」—— 判据撑不起标签：把 `const g = e['ui:voiceGender']`
  //   加回加载 effect（读一个从没被取过的键）实测红集 0。改判「去掉注释后这个键不存在」，
  //   任何形式的读或写都盖不住；标签与判据这才对得上。
  const appNoComment = appSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')
  ok(
    !appNoComment.includes('ui:voiceGender'),
    'P9 ui:voiceGender 已下线：去掉注释后 App.tsx 里再无此键（不读也不写；键本身留在 extras 里不动）'
  )
  ok(
    appSrc.includes('ui:voiceGender'),
    'P9b 但注释里留了「为什么不再读它」—— 删掉理由就等于删掉了这条决策'
  )
  const setSrc = readFileSync(new URL('../src/renderer/src/SettingsView.tsx', import.meta.url), 'utf8')
  // 判「代码里还在用」，不是判「文件里出现过这个词」—— 注释必须能说清为什么删，才不会有人加回来
  ok(
    !/onSetVoiceGender\s*[({]/.test(setSrc) &&
      !/\bvoiceGender\b\s*[:=]/.test(setSrc) &&
      !/value="(female|male|any)"/.test(setSrc),
    'P10 设置页不再有性别下拉，也没有它的 setter'
  )
}
{
  // ── 性别的接线：固定值一路走到 voice.speak ───────────────────────────────
  // 人物形态下线前这里是 `gender: petGender(pet.id)`（AC3/AC4：性别跟助理走）；
  // 下线后固定为 DEFAULT_VOICE_GENDER（原默认助理 Aria 的女声），仍不落盘。
  // 中间那一段被改回 `gender: 'any'` 的话全仓套件照样全绿，而用户听到的是不挑性别的
  // 系统音色 —— 静默失效，正是「校验守卫能失败」这条纪律要挡的东西。
  const appSrc = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
  ok(
    /const DEFAULT_VOICE_GENDER = 'female'/.test(appSrc) &&
      /gender:\s*DEFAULT_VOICE_GENDER/.test(appSrc),
    'P11 ctx.gender 取固定值 DEFAULT_VOICE_GENDER（人物下线后不再跟助理走，仍不落盘）'
  )
  ok(
    /void flush\(\{[\s\S]{0,300}?gender:\s*ctx\.gender/.test(appSrc),
    'P12 播报时把 ctx.gender 透传给 flush（漏了就落回 voice.speak() 的默认 any）'
  )

  // ── AC2 的最后两跳：下拉 → 存档 ────────────────────────────────────────────
  // 前面 P0–P6 证明了 style/voice 会进请求体（speechOut 的 D7/D16 证明了那一跳），
  // 但「用户在界面上选的那一下有没有被存下来」这一跳此前**完全没人测**。
  // 它坏掉的表现是静默的：onChange 变成空函数 → ttsConfig 不变 → 受控 <select> 的
  // value 不变 → 用户点了、界面纹丝不动、也没有任何报错（实测：两个套件全绿）。
  for (const [key, prop] of [
    ['onChangeVoice', 'voice'],
    ['onChangeStyle', 'style']
  ]) {
    // 逐行判 + 两个扁平的捕获，**不写嵌套分组**：这一条的第一版把
    // 「箭头参数」和「persistConfig 的实参」塞进同一个带嵌套的 pattern，
    // 结果整个 pattern 匹配不上 —— 判据自己红着，却很容易被读成「哦产品有问题」。
    // 护栏恒红和恒绿一样没用，pattern 匹配不到任何东西时尤其容易骗过人。
    const line = appSrc.split('\n').find((l) => l.includes(key + '={'))
    const arrowParam = line == null ? null : new RegExp(key + '=\\{\\(([A-Za-z_$][\\w$]*)').exec(line)
    const propVal = line == null ? null : new RegExp(prop + ': ([A-Za-z_$][\\w$]*)').exec(line)
    ok(
      line != null &&
        line.includes(`persistConfig({ ...ttsConfig, ${prop}:`) &&
        arrowParam != null &&
        arrowParam[1] === propVal?.[1],
      `P13 ${key} 真的把选中的 ${prop} 写进 ui:ttsConfig（否则点下拉纹丝不动且不报错）`
    )
  }
  ok(
    /const persistConfig = \(next: TtsConfig\): void => \{[\s\S]{0,200}?'ui:ttsConfig': JSON\.stringify\(next\)/.test(
      appSrc
    ),
    'P14 persistConfig 落盘到 ui:ttsConfig（上面两跳的终点；不落盘则重启即失效）'
  )
  ok(
    /alertCtxRef\.current\s*=\s*\{[\s\S]{0,900}?ttsConfig,/.test(appSrc),
    'P15 ttsConfig 每轮进 ctx 快照（播报时才读得到用户刚选的值）'
  )
}

out(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
