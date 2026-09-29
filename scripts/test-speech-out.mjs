// 统一播出口测试（src/renderer/src/speechOut.ts）
// 用法：node scripts/test-speech-out.mjs
//
// 覆盖：频率闸门（分钟/小时/滑出窗口）、队列与打断（紧急插队、例行排队、跳过不叠加、
//       在途请求丢弃）、stopAll 双通道、TTS 请求契约（URL/头/体/重试/401 不重试/
//       revokeObjectURL）、未配置不播且不占配额、系统语音回退（含音色性别透传）、
//       纯函数 isDuplicate / pacedMs。
//
// 加载的是**真实源码**（esbuild 打包 src 下的 .ts），不内联实现副本 ——
// quality-guidelines 明确禁止后者（test-percent.mjs 因此漂移过）。
// 外部依赖（fetch / Audio / window.speechSynthesis / Date.now / URL.*）全部在测试里替换，
// 替身都记账并断言「走到了哪条分支」，避免测试静默走别的分支。
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
  isDuplicate,
  pacedMs,
  allowCall,
  enqueue,
  stopAll,
  flush
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

/** 临时替换 globalThis.fetch；返回 restore */
function withFetch(fn) {
  const prev = globalThis.fetch
  globalThis.fetch = fn
  return () => (globalThis.fetch = prev)
}

/** 可控的 HTMLAudioElement 替身；autoEnd=false 时音频一直「在播」，供打断测试用 */
class FakeAudio {
  static instances = []
  static autoEnd = true
  constructor(src) {
    this.src = src
    this.playCalls = 0
    this.pauseCalls = 0
    this.onended = null
    this.onerror = null
    FakeAudio.instances.push(this)
    // 自动播完挂在构造上、**不挂在 play() 上**：实现若忘了调 play()，套件仍能跑完并由
    // F3 断言变红；挂在 play() 上只会让它一路挂到看门狗，读不出是哪一条坏了
    if (FakeAudio.autoEnd) setTimeout(() => this.onended?.(), 0)
  }
  play() {
    this.playCalls++
    return Promise.resolve()
  }
  pause() {
    this.pauseCalls++
  }
  static reset(autoEnd = true) {
    FakeAudio.instances = []
    FakeAudio.autoEnd = autoEnd
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

/** 一条完整的播报环境：冻结时钟 + 记账 fetch + 假音频 + 假系统语音 + 日志收走 */
let clockSeq = 100_000_000
async function withBroadcast({ autoEnd = true, clock, routes } = {}) {
  stopAll()
  // 每段场景的时钟至少往前推一小时：闸门的记录必须落在窗口外，各段才互不干扰
  const clk = withClock(clock ?? (clockSeq += 3_600_001))
  const calls = []
  // 未覆盖的 URL 直接抛 —— 避免测试因为「URL 拼错」而静默走了别的分支
  const restoreFetch = withFetch(async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    const r = routes(url, calls.length)
    if (!r) throw new TypeError(`fetch failed（本套件未覆盖的 URL: ${url}）`)
    if (r.throw) throw new TypeError(r.throw)
    return r.res
  })
  const restoreAudio = withAudio(autoEnd)
  const sys = withSystemSpeech()
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
    enqueue({ text: '余额不足', urgent: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    eq(b.calls.length, 1, 'D1 播一条 = 一次请求')
    eq(b.calls[0].url, TTS_URL, 'D2 打的是实测端点（父任务 D1）')
    eq(b.calls[0].url !== LEGACY_URL, true, 'D3 不是已被 DNS 污染的旧域名')
    eq(b.calls[0].init.method, 'POST', 'D4 方法 POST')
    eq(b.calls[0].init.headers['Content-Type'], 'application/json', 'D5 默认带 Content-Type')
    eq(b.calls[0].init.headers.Authorization, undefined, 'D6 未配 authHeader → 不带认证头')
    eq(
      b.calls[0].body,
      { input: '余额不足', voice: 'zh-CN-YunxiNeural', speed: 1, pitch: '0', style: 'general' },
      'D7 请求体字段与父任务 D1 一致'
    )
    eq(b.calls[0].init.signal instanceof AbortSignal, true, 'D8 带 AbortSignal（超时靠它）')
  } finally {
    await b.done()
  }
}

{
  // D7 只证明「信号传下去了」，没证明「真的会在超时后中断」——15s 太长，单元套件里等不起。
  // 这一条是**静态**护栏：它证明超时那条线还接着 abort，不是行为断言（quality-guidelines
  // 里 grep 门与行为断言是两回事，这里明说是前者）。
  const src = readFileSync(new URL('../src/renderer/src/speechOut.ts', import.meta.url), 'utf8')
  ok(
    /const timer = setTimeout\(\(\) => ctrl\.abort\(\), TTS_TIMEOUT_MS\)/.test(src),
    'D9 超时定时器仍然调 ctrl.abort()（静态检查，非行为断言）'
  )
  ok(/const TTS_TIMEOUT_MS = \d+/.test(src), 'D10 超时时长有具名常量（静态检查）')
}

{
  const b = await withBroadcast({ routes: () => ({ res: okRes() }) })
  try {
    enqueue({ text: '余额不足', urgent: true })
    await flush({
      config: {
        url: 'https://x.test/tts',
        voice: 'v',
        speed: 2,
        authHeader: { Authorization: 'Bearer k' }
      },
      fallback: false
    })
    eq(b.calls[0].url, 'https://x.test/tts', 'D11 自定义 url 被使用')
    eq(b.calls[0].init.headers.Authorization, 'Bearer k', 'D12 authHeader 合并进请求头')
    eq(
      b.calls[0].init.headers['Content-Type'],
      'application/json',
      'D13 authHeader 不覆盖 Content-Type'
    )
    eq(b.calls[0].body.voice, 'v', 'D14 自定义音色生效')
    eq(b.calls[0].body.speed, 2, 'D15 自定义语速生效')
  } finally {
    await b.done()
  }
}

{
  const b = await withBroadcast({ routes: () => ({ res: okRes() }) })
  try {
    enqueue({ text: '余额不足', urgent: true })
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
      enqueue({ text: `未配置 ${i}`, urgent: true })
      await flush({ config: { ...DEFAULT_TTS_CONFIG, url: '' }, fallback: false })
    }
    enqueue({ text: '配好之后的第一句', urgent: true })
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
    enqueue({ text: '余额不足', urgent: true })
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
    enqueue({ text: '余额不足', urgent: true })
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
    enqueue({ text: '余额不足', urgent: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    eq(b.calls.length, 1, 'E5 403 同样不重试')
  } finally {
    await b.done()
  }
}

{
  const b = await withBroadcast({ routes: () => ({ throw: 'fetch failed' }) })
  try {
    enqueue({ text: '余额不足', urgent: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    eq(b.calls.length, 2, 'E6 网络层失败重试 1 次后放弃（共 2 次请求）')
    ok(b.logs.has('TTS 播报失败'), 'E7 失败显式抛给上层（回退路径依赖它）')
  } finally {
    await b.done()
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
out('\nF. 音频生命周期：createObjectURL / revokeObjectURL 必须配平')

{
  const b = await withBroadcast({ routes: () => ({ res: okRes() }) })
  try {
    enqueue({ text: '余额不足', urgent: true })
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
    enqueue({ text: '例行一', urgent: false })
    enqueue({ text: '例行二', urgent: false })
    enqueue({ text: '例行三', urgent: false })
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
    enqueue({ text: '例行一', urgent: false })
    const p = flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    await waitForCount(b.audio, 1)
    b.clk.advance(61_000)
    enqueue({ text: '例行二', urgent: false })
    enqueue({ text: '例行三', urgent: false })
    enqueue({ text: '例行四', urgent: false })
    b.clk.advance(61_000)
    enqueue({ text: '例行五', urgent: false })
    b.clk.advance(61_000)
    enqueue({ text: '例行六', urgent: false })
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
    enqueue({ text: '例行一', urgent: false })
    const p = flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    await waitForCount(b.audio, 1)
    b.clk.advance(61_000)
    enqueue({ text: '例行二', urgent: false })
    enqueue({ text: '例行三', urgent: false })
    b.clk.advance(61_000)
    enqueue({ text: '紧急预警', urgent: true })
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
    enqueue({ text: '例行一', urgent: false })
    const p = flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    await waitForCount(b.audio, 1)
    b.clk.advance(61_000)
    enqueue({ text: '例行二', urgent: false })
    b.clk.advance(61_000)
    enqueue({ text: '紧急预警', urgent: true })
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
    enqueue({ text: '例行一', urgent: false })
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
    enqueue({ text: '紧急一', urgent: true })
    const p = flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    await waitForCount(b.audio, 1)
    b.clk.advance(61_000)
    enqueue({ text: '例行二', urgent: false })
    enqueue({ text: '例行三', urgent: false })
    b.clk.advance(61_000)
    enqueue({ text: '紧急四', urgent: true })
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
    enqueue({ text: long, urgent: false })
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
    enqueue({ text: '例行一', urgent: false })
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
    enqueue({ text: '甲', urgent: true })
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
    enqueue({ text: '甲', urgent: true })
    const p = flush({ config: DEFAULT_TTS_CONFIG, fallback: true })
    for (let i = 0; i < 200 && b.sys.spoken.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    b.clk.advance(61_000)
    enqueue({ text: '乙', urgent: false })
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
    enqueue({ text: '甲', urgent: true })
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
    enqueue({ text: '甲', urgent: true })
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
    enqueue({ text: '要男声', urgent: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: true, gender: 'male' })
    b.clk.advance(61_000)
    enqueue({ text: '要女声', urgent: false })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: true, gender: 'female' })
    b.clk.advance(61_000)
    enqueue({ text: '不限制', urgent: false })
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
    enqueue({ text: '甲', urgent: true })
    const p = flush({ config: DEFAULT_TTS_CONFIG, fallback: false })
    await waitForCount(b.audio, 1)
    enqueue({ text: '乙', urgent: false })
    enqueue({ text: '丙', urgent: false })
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
    enqueue({ text: '甲', urgent: true })
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
    enqueue({ text: '甲', urgent: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false, onVisual: (t) => seen.push(t) })
    enqueue({ text: '乙', urgent: false })
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
    enqueue({ text: '甲', urgent: true })
    const p = flush({
      config: DEFAULT_TTS_CONFIG,
      fallback: false,
      onVisual: (t) => {
        if (t === '甲') throw new Error('视觉通知炸了（调用方的锅）')
      }
    })
    b.clk.advance(61_000)
    enqueue({ text: '乙', urgent: false })
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
    enqueue({ text: '甲', urgent: true })
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
    enqueue({ text: '甲', urgent: true })
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
    enqueue({ text: '甲', urgent: true })
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
    enqueue({ text: '甲', urgent: true })
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
    enqueue({ text: '未配置', urgent: true })
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
    enqueue({ text: '甲', urgent: true })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false, onTtsFailed: (r) => seen.push(r) })
    enqueue({ text: '乙', urgent: false })
    await flush({ config: DEFAULT_TTS_CONFIG, fallback: false, onTtsFailed: (r) => seen.push(r) })
    eq(b.calls.length, 1, 'M11 前提：第二条被分钟闸门拦下（没发请求）')
    eq(seen.length, 0, 'M12 被闸门拦下 → 不报不可达（没联系过服务）')
  } finally {
    await b.done()
  }
}

out(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
