// ═══════════════════════════════════════════════════════════════════════════════
// 统一播出口 —— 网络 TTS 主路径 + 系统语音回退 + 队列 / 打断 / 频率闸门
//
// 为什么收口到一处：播报原本散在调用方（App.tsx 的 speakBalance），音频放行、频率限制、
// 打断各有各的写法。TTS 与系统语音是**两条**通道，只停一条会出事 —— 只
// speechSynthesis.cancel() 的话 TTS 音频继续响完，只 audio.pause() 的话系统语音继续念。
//
// 三条外部依赖刻意都不 import：`window.api.ttsSpeak` / Audio / window.speechSynthesis 都在
// **调用时**从全局读，因此 scripts/test-speech-out.mjs 可以在纯 node 里替换它们并加载
// **真实源码**来测（quality-guidelines：禁止把实现复制一份内联进测试）。
//
// 出网为什么在主进程（09-29-tts-request-to-main）：渲染层 CSP `connect-src 'self' data:
// blob: bd-asset:` 拦住一切外部 fetch —— 本文件里的 `fetch` 从未到过网络，三轮「实测」
// 全是在 curl 上验的（curl 不受 CSP 约束）。请求现在走 `window.api.ttsSpeak`，与
// `src/main/adapters/` 同一条边界；本文件只剩纯逻辑：队列、闸门、重试与错误分类。
//
// 打断语义（父任务 design.md D5）：
//   · 紧急入队时若正在播例行 → 停掉例行 + 清空队列，紧急插到最前
//   · 例行入队时排队，串行播放；积压到上限就跳过新触发（不叠加，记日志）
//   · 任何打断都让「估算时长」里的等待提前结束，否则紧急项要干等一整条例行念完
//
// 计费语义（09-29-voice-settings-refactor）：
//   频率闸门保护的是**免费服务配额**，不是用户的主动操作。所以闸门挂在 item 上
//   （SpeechItem.bill）而不是挂在公共路径上：定时/预警播报计费、测试播报不计费。
//   旧实现把闸门放在 playOne 开头，于是设置页「测试播报」连点第二次就被**静默丢弃** ——
//   无日志、无提示、无声音，而「上一次调用失败」也因此永远清不掉（见下面的探测段）。
// ═══════════════════════════════════════════════════════════════════════════════

import { DEFAULT_TTS_STYLE, DEFAULT_TTS_VOICE } from '../../shared/tts-preset'

/** TTS 服务配置 */
export interface TtsConfig {
  url: string
  voice: string
  speed: number
  /** 语音风格。清单见 shared/tts-preset.ts 的 TTS_STYLES；此前这里是硬编码的 'general' */
  style: string
  //
  // ⚠ 这里曾经有 `authHeader?: Record<string, string>`，**已随 09-29-tts-request-to-main 下线**。
  // 它的唯一用途是把 token 明文拼成 Authorization 头交给渲染层的 fetch，而渲染层
  // CSP 根本不让 fetch 出网 —— 请求搬进主进程之后，读 token 与拼头都在 `tts:speak` 里做。
  // 留着这个字段等于留一条「渲染层自己发认证头」的路：主进程虽然会覆盖它，但免费服务
  // （没有 token）的用户会被它悄悄带上一个假身份。门禁：test-speech-out.mjs D12。
}

/** 端点已在父任务实测（2026-09-29）：HTTP 200 / 1.71s / 有效 MP3。旧 workers.dev 域名被 DNS 污染，已弃用 */
export const DEFAULT_TTS_CONFIG: TtsConfig = {
  url: 'https://voice.mytts.ccwu.cc/v1/audio/speech',
  voice: DEFAULT_TTS_VOICE,
  speed: 1.0,
  style: DEFAULT_TTS_STYLE
}

/** 应用级频率限制：滑动窗口内存态，**不持久化**（重启后重置，避免陈旧窗口影响当日限额判断） */
export const RATE_LIMIT = { MAX_PER_MINUTE: 1, MAX_PER_HOUR: 10 } as const

/** 队列里最多攒几条待播。攒满说明播报时长已经追上了触发间隔，再入队只会越堆越多 */
const MAX_PENDING = 3

/**
 * 单次 TTS 请求在**渲染层**的看门超时。
 *
 * 真正掐 socket 的是主进程 `ipc.ts` 的 `TTS_TIMEOUT_MS`（12s，AbortController）；
 * 这条守的是 **IPC 本身** —— `invoke` 若永不结算，`flush` 的 draining 闩会把整条播报链
 * 永久卡死（此后所有 flush 都返回同一个 pending promise，且 `stopAll` 解不开它）。
 * 所以必须**大于**主进程那条，否则这里的超时会抢在 socket 超时之前触发。
 */
const TTS_TIMEOUT_MS = 15000

/** 系统语音的估算时长：中文约 5 字/秒，voice.ts 固定 rate = 1.0。估得准不准只影响两条播报之间的间隔 */
const PACED_MS_PER_CHAR = 180
const PACED_MIN_MS = 600
const PACED_MAX_MS = 15000

/** 一条待播内容。urgent 决定它能不能打断别人，bill 决定它要不要占一次免费配额 */
export interface SpeechItem {
  text: string
  urgent: boolean
  /**
   * 是否计入频率闸门的配额。
   *
   * 定时播报 / 预警播报 = true（无人值守，必须限流）；
   * 设置页「测试播报」= false（用户自己点的，一分钟点十次也是他自己的选择）。
   *
   * 必填而非可选：可选的话新调用方漏写就默认摊上「被拦且无提示」的旧故障，
   * 而那正是这个字段存在的理由 —— 每个入口都得显式表态自己算不算。
   */
  bill: boolean
}

export interface FlushOptions {
  config: TtsConfig
  /** TTS 失败时是否改用系统语音 */
  fallback: boolean
  /**
   * 系统语音的音色性别。回退路径必须透传它 ——
   * 漏掉就落回 voice.speak() 的默认 'any'，助理的性别被作废（改播报链路时丢过）。
   *
   * 值的来源是**助理身份**（shared/pet.ts 的 petGender），不再有用户手选的那一项：
   * ui:voiceGender 已下线（FR8），每轮从 pet.id 现算。
   */
  gender?: 'female' | 'male' | 'any'
  /** 视觉通知回调。与音频通道独立：频率闸门只拦音频，视觉通知照发 */
  onVisual?: (text: string) => void
  /**
   * TTS 通路失败时回调一次（连接失败 / 非 2xx / 重试后仍失败）。
   * 设置页的「连不上语音服务」提示靠它 —— 没有它，用户只会看到"没声音"，
   * 分不清是服务挂了还是自己关了开关。
   */
  onTtsFailed?: (reason: string) => void
  /** 成功播出一句后回调（用于清掉「连不上」提示，同时把退避探测停下来） */
  onTtsOk?: () => void
}

// ─── 频率闸门 ────────────────────────────────────────────────────────────────

/** 已经放行过的时间戳，按时间升序；只保留最近一小时 */
const callLog: number[] = []

/**
 * 频率闸门（检查并记账：放行时把 now 记进去）。
 *
 * 副作用是设计要的：它是一道「开一次就关上一段时间」的闸，不是纯查询。
 */
export function allowCall(now: number): boolean {
  const hourAgo = now - 3_600_000
  // 顺手丢掉滑出窗口的记录，callLog 不会无限增长
  while (callLog.length > 0 && callLog[0] <= hourAgo) callLog.shift()

  const minuteAgo = now - 60_000
  let inMinute = 0
  for (const t of callLog) if (t > minuteAgo) inMinute++

  if (inMinute >= RATE_LIMIT.MAX_PER_MINUTE) {
    console.warn(`[speechOut] 触发频率超限（${RATE_LIMIT.MAX_PER_MINUTE} 次/分钟），跳过本次播报`)
    return false
  }
  if (callLog.length >= RATE_LIMIT.MAX_PER_HOUR) {
    console.warn(`[speechOut] 触发频率超限（${RATE_LIMIT.MAX_PER_HOUR} 次/小时），跳过本次播报`)
    return false
  }
  callLog.push(now)
  return true
}

// ─── 不可达自愈：退避探测 ────────────────────────────────────────────────────
//
// 要解决的问题是一个**因果链**，只修一半等于没修：
//
//   某次 TTS 调用失败 → unreachable 置位
//     → 之后每条播报都撞上频率闸门（1 次/分钟）被静默丢弃
//       → onTtsOk 再也不会被调用 → unreachable 永久为真
//
// 用户看到的正是「提示连不上 + 连点测试播报没反应」。所以「清掉提示」不能靠
// 「下一次播报碰碰运气」，必须由**不经过队列、不经过闸门**的静默探测来推动：
// 拿到音频字节就说明恢复了，清提示并停止排程；拿不到就换下一档延迟，档位用尽即停。

/** 退避档位（毫秒）。4 次探测 ≈ 5 分钟内确认一次，之后不再打扰用户 */
export const PROBE_DELAYS: readonly number[] = [5_000, 15_000, 60_000, 300_000]

/** 探测排程要用的文本。越短越省：探测只验连通性，不播声 */
const PROBE_TEXT = '测试'

export interface ProbeState {
  /** 已经排出去的探测次数；等于 PROBE_DELAYS.length 表示这轮退避用尽 */
  tried: number
  /** 服务是否仍不可达 —— 设置页那句提示就是它 */
  unreachable: boolean
  /**
   * 上一条链**用尽**的时刻（epoch ms，0 = 从没用尽过）。
   *
   * 为什么需要：链用尽后，每次新的真实失败都会重开一条链。而真实失败由 30s 轮询驱动、
   * 又有 1 次/分钟的闸门，理论上能到 **1 次/分** —— 每次都重开链的话，服务挂着时会有
   * 4 条探测同时排着，约 8 次请求/分打向免费服务。加了这个冷却，重开之间至少隔 10 分钟。
   */
  exhaustedAt: number
}

export const PROBE_IDLE: ProbeState = { tried: 0, unreachable: false, exhaustedAt: 0 }

/** 链用尽后，重开一条新链的最小间隔（毫秒）。10 分钟 → 服务不可达时 ≤ 0.4 次探测/分 */
export const PROBE_RESTART_COOLDOWN_MS = 600_000

/** 三种事件，对应「真实播报失败」「探测失败」「恢复」 */
export type ProbeEvent = 'fail' | 'probe-fail' | 'ok'

/**
 * 不可达状态机的一步（纯函数，不读时钟、不发请求）。
 *
 * 返回 `delayMs` 就是「排下一次探测，等这么久」；返回 null = 这一步不排程。
 * ⚠ null 有两种含义，调用方必须靠 `next.unreachable` 区分：
 *   · 恢复了 → 把还挂着的探测**停掉**
 *   · 链还在跑 / 已用尽 → **别动**已有定时器（动了会把下一次探测推后）
 * 忘了这个区分，表现就是「探测自己把自己取消了」。
 */
export function probeStep(
  prev: ProbeState,
  event: ProbeEvent,
  now = 0
): { next: ProbeState; delayMs: number | null } {
  // 恢复：清零并停止排程。真实播报成功与探测成功都走这一支。
  // ⚠ 必须把 exhaustedAt 也清掉 —— 否则服务恢复后第一次失败会撞上上一轮残留的冷却，
  //   明明已经通了却要再等 10 分钟才重新探测。
  if (event === 'ok') return { next: { tried: 0, unreachable: false, exhaustedAt: 0 }, delayMs: null }

  // 探测失败：换下一档延迟；用尽即停（不无限重试，否则一天几千次请求）
  if (event === 'probe-fail') {
    if (!prev.unreachable) return { next: prev, delayMs: null }
    if (prev.tried >= PROBE_DELAYS.length) {
      // 刚用尽：记下时刻，供下次「真实失败」判断冷却是否已过
      return { next: { ...prev, exhaustedAt: prev.exhaustedAt || now }, delayMs: null }
    }
    return {
      next: { tried: prev.tried + 1, unreachable: true, exhaustedAt: prev.exhaustedAt },
      delayMs: PROBE_DELAYS[prev.tried]
    }
  }

  // 真实播报失败：链还在跑就别打扰它（重排会把下一次探测推后）；
  // 首次失败、或上一轮已用尽（tried === length）→ 重排整条链，探一次看看是不是恢复了。
  if (prev.unreachable && prev.tried < PROBE_DELAYS.length) return { next: prev, delayMs: null }
  // 上一条链刚用尽：在冷却期内就不再重开。没有这条，服务挂着时每次真实失败都重开一条链
  // （轮询 30s + 1 次/分钟闸门 → 约 1 次/分 → 4 条探测并排 → 8 次请求/分）。
  if (prev.exhaustedAt !== 0 && now - prev.exhaustedAt < PROBE_RESTART_COOLDOWN_MS) {
    return { next: prev, delayMs: null }
  }
  return { next: { tried: 1, unreachable: true, exhaustedAt: 0 }, delayMs: PROBE_DELAYS[0] }
}

/**
 * 静默连通性探测：只验「能不能拿到音频字节」。
 *
 * **不入队、不播声、不占频率配额** —— 它走的是和播报同一个请求函数，但没有队列、
 * 没有 Audio、没有闸门。这是它与播报的**全部**区别，也正是它能在闸门把播报全拦住的
 * 情况下仍然确认服务是否恢复的原因。
 */
export async function probeTts(config: TtsConfig): Promise<{ ok: boolean; reason: string }> {
  if (!config.url) return { ok: false, reason: '未配置 TTS 服务' }
  try {
    await requestAudioBlob(PROBE_TEXT, config)
    return { ok: true, reason: '' }
  } catch (e) {
    return { ok: false, reason: describeError(e) }
  }
}

// ─── 纯函数（供合并去重 / 设置页复用） ────────────────────────────────────────

/**
 * 两条内容是否重复（同文本）。合并去重的调用方传各自的 `.text`。
 *
 * 空文本不算重复：两条「都是空的」不构成「有两条一样的东西」。
 */
export function isDuplicate(a: string, b: string): boolean {
  const x = a.trim()
  const y = b.trim()
  if (x === '' || y === '') return false
  return x === y
}

/** 系统语音念一段文本大约要多久（毫秒） */
export function pacedMs(text: string): number {
  const raw = text.length * PACED_MS_PER_CHAR
  return Math.min(PACED_MAX_MS, Math.max(PACED_MIN_MS, raw))
}

// ─── 队列与打断状态 ──────────────────────────────────────────────────────────

/** 当前正在播的那一条。pause 是「停这条对应的通道」，settle 是「让 flush 对它的等待结束」 */
type Active = { urgent: boolean; pause: () => void; settle: () => void }

let queue: SpeechItem[] = []
let active: Active | null = null
let draining: Promise<void> | null = null

/** 打断代数。在途的 TTS 请求回来时若代数已变，说明它已经被抢断了，直接丢弃不播 */
let generation = 0

/** 正在「估算时长」里等待的解算器；打断时全部唤醒 */
let interruptWaiters: Array<() => void> = []

/**
 * 入队一条待播内容。
 *
 * · urgent 且正在播例行 → 停掉例行、清空队列，紧急插到最前
 * · urgent 且没有例行可打断 → 仍然插到最前（紧急不排在例行后面干等）
 * · routine → 追加到队尾；队列已满则跳过并记日志（播报时长追上触发间隔，不叠加）
 */
export function enqueue(item: SpeechItem): void {
  if (item.urgent) {
    if (active !== null && !active.urgent) {
      queue = []
      haltPlayback()
      console.log('[speechOut] 紧急插队：已打断例行播报并清空队列')
    }
    queue.unshift(item)
    return
  }
  if (queue.length >= MAX_PENDING) {
    console.warn(`[speechOut] 队列已满（${MAX_PENDING} 条待播），跳过本次例行播报：${item.text}`)
    return
  }
  queue.push(item)
}

/**
 * 立刻停掉所有播报。**两个通道都要停**：
 * · 系统语音 → speechSynthesis.cancel()
 * · TTS 音频 → audio.pause()
 * 只停一条的结果是另一条继续响完。
 */
export function stopAll(): void {
  queue = []
  haltPlayback()
}

/** 排空队列，串行播放。并发调用时沿用先到的那次配置（实际只有一处调用方，配置同源） */
export function flush(opts: FlushOptions): Promise<void> {
  if (draining) return draining
  const run: Promise<void> = drain(opts)
  draining = run
  const clear = (): void => {
    if (draining === run) draining = null
  }
  void run.then(clear, clear)
  return run
}

// ─── 内部实现 ────────────────────────────────────────────────────────────────

/** 打断的共同动作：换代、唤醒等待、停掉当前这条（两个通道） */
function haltPlayback(): void {
  generation++
  const waiters = interruptWaiters
  interruptWaiters = []
  for (const done of waiters) done()

  cancelSystemSpeech()
  const cur = active
  active = null
  if (!cur) return
  cur.pause()
  cur.settle()
}

/** 等待 ms 毫秒，但一旦被打断立刻返回 */
function waitOrInterrupt(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      resolve()
    }
    timer = setTimeout(done, ms)
    interruptWaiters.push(done)
  })
}

async function drain(opts: FlushOptions): Promise<void> {
  while (queue.length > 0) {
    const item = queue.shift()
    if (!item) return
    try {
      await playOne(item, opts)
    } catch (e) {
      // 单条播报失败不能让整条队列停摆
      console.warn('[speechOut] 单条播报失败，已跳过：', describeError(e))
    }
  }
}

async function playOne(item: SpeechItem, opts: FlushOptions): Promise<void> {
  // 视觉通知与音频是两条通道：频率闸门只拦音频
  opts.onVisual?.(item.text)

  // 未配置 TTS 服务 → 播报功能不工作（连回退也不走：回退的前提是「本该有网络播报」）
  //
  // 这条检查**必须在频率闸门之前**：没配置就根本没有播报发生，不该占掉一次配额 ——
  // 放它后面的话，用户把地址清空的那几分钟里，闸门被「没播成的事」记满，恢复地址后
  // 反而要等窗口滑出才播得出第一句。
  if (!opts.config.url) {
    console.warn('[speechOut] 未配置 TTS 服务，本次不播报')
    return
  }

  // 频率闸门**按条**判定：谁产生的播报谁决定要不要计费。
  // 定时/预警照旧受限（配额保护不削弱），设置页的「测试播报」不被拦 —— 用户自己点的，
  // 连点三次就该响三次。旧实现无条件过闸，于是第二次点击被静默丢弃。
  if (item.bill && !allowCall(Date.now())) return

  try {
    await speakViaTts(item, opts.config)
    opts.onTtsOk?.()
  } catch (e) {
    console.warn('[speechOut] TTS 播报失败：', describeError(e))
    // 服务不可达提示：这是「网络播报没成功」的信号，与是否回退无关 ——
    // 即使回退到系统语音播出来了，服务本身仍然是不可达的
    opts.onTtsFailed?.(describeError(e))
    if (!opts.fallback) return
    await speakViaSystem(item, opts.gender)
  }
}

/** 401/403 是凭据/会话问题，重试没有意义（external-api-integration §7） */
const AUTH_STATUS = new Set([401, 403])

/**
 * 主进程「DNS/连接/超时」的原因码。**与 `src/main/ipc.ts` 抛的是同一个字面量**，
 * 两边各一份、由 test-structure.mjs F5 静态钉死 —— 文件所有权不许新增 shared 文件，
 * 故不抽共享常量（同 ipc.ts 里 E3/E5 的做法）。
 */
const CODE_UNREACHABLE = 'TTS_UNREACHABLE'

class TtsAuthError extends Error {
  constructor(status: number) {
    super(`TTS ${status}：凭据或会话问题，不重试`)
    this.name = 'TtsAuthError'
  }
}

async function speakViaTts(item: SpeechItem, config: TtsConfig): Promise<void> {
  const gen = generation
  const blob = await requestAudioBlob(item.text, config)
  // 请求在途时被打断 → 回来的音频直接丢弃，不播
  if (gen !== generation) {
    console.log('[speechOut] TTS 请求在途时被打断，丢弃该条：', item.text)
    return
  }
  const url = URL.createObjectURL(blob)
  try {
    await playElement(new Audio(url), item.urgent)
  } finally {
    // 无论播完、播失败还是被打断，blob URL 都必须释放，否则音频数据一直驻留
    URL.revokeObjectURL(url)
  }
}

/** 播放一个音频元素，结束/失败/被打断都会 resolve（失败不重试，只记日志） */
function playElement(el: HTMLAudioElement, urgent: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      el.onended = null
      el.onerror = null
      if (active !== null && active.settle === settle) active = null
      resolve()
    }
    el.onended = settle
    el.onerror = (): void => {
      console.warn('[speechOut] 音频播放失败（不重试）')
      settle()
    }
    active = { urgent, pause: () => el.pause(), settle }
    void Promise.resolve(el.play()).then(undefined, (e: unknown) => {
      console.warn('[speechOut] audio.play() 被拒：', describeError(e))
      settle()
    })
  })
}

/** 回退路径：复用 voice.ts 的系统语音。voice.speak() 没有「念完了」信号，只能按字数估时长。
 *  gender 必须透传：缺省会落回 voice.speak() 的默认 'any'，等于把用户选的偏好作废。 */
async function speakViaSystem(item: SpeechItem, gender?: 'female' | 'male' | 'any'): Promise<void> {
  const { speak } = await import('./voice')
  let rec: Active
  const settle = (): void => {
    if (active === rec) active = null
  }
  rec = { urgent: item.urgent, pause: () => cancelSystemSpeech(), settle }
  active = rec
  speak(item.text, 'zh-CN', gender)
  await waitOrInterrupt(pacedMs(item.text))
  settle()
}

/** 取音频字节：最多试两次，401/403 不重试 */
async function requestAudioBlob(text: string, config: TtsConfig): Promise<Blob> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }
  const body = JSON.stringify({
    input: text,
    voice: config.voice,
    speed: config.speed,
    pitch: '0',
    // ⚠ 这一项过去是**硬编码**的 'general'：用户在服务页面能挑 11 种风格，我们这边一个都
    //   发不出去（ui:ttsConfig 里存了也白存）。清单见 shared/tts-preset.ts。
    style: config.style
  })

  let lastErr: unknown = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchWithTimeout(config.url, headers, body)
      if (res.ok) return await res.blob()
      if (AUTH_STATUS.has(res.status)) throw new TtsAuthError(res.status)
      lastErr = new Error(`TTS HTTP ${res.status}`)
    } catch (e) {
      if (e instanceof TtsAuthError) throw e
      lastErr = e
    }
    console.warn(`[speechOut] TTS 第 ${attempt} 次尝试失败：`, describeError(lastErr))
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * 主进程原因码 `TTS_HTTP_<n>` → HTTP 状态；不是这个形状就返回 null。
 *
 * 为什么用码而不是靠 `Error.name`：Electron 的 IPC **只透传 `message`**，
 * 跨进程的失败必须把可辨识的原因写进 message（design.md「代价」那一条）。
 */
const HTTP_CODE_RE = /^TTS_HTTP_(\d{3})$/

function httpStatusOf(e: unknown): number | null {
  // 读**原始** message，不能走 describeError —— 后者会把码翻译成人话，翻译完就匹配不上了
  const raw = e instanceof Error ? e.message : String(e)
  const m = HTTP_CODE_RE.exec(raw)
  if (!m) return null
  const n = Number(m[1])
  // `new Response(_, { status })` 只收 200..599：码本身畸形时按网络层失败处理
  // （重试一次 + 置不可达），而不是在这一层再抛一个谁也看不懂的 RangeError
  return n >= 200 && n <= 599 ? n : null
}

/**
 * 传输层：渲染层不出网，请求交给主进程 `tts:speak`（CSP 见 `src/renderer/index.html`）。
 *
 * 为什么把主进程的返回与原因码**还原成 `Response` 形状**：上面那个循环连同
 * 超时/重试/401-403/blob 配平是既有逻辑（design.md「其余全部逻辑留在原位不动」），
 * 换掉的只有传输。用别的返回类型就得把循环一起改写，那正是「只换传输层、既有断言仍有效」
 * 这条自我约束失效的地方。
 *
 * 渲染层仍留一个看门超时（`TTS_TIMEOUT_MS`）：主进程那条掐的是 socket，这条掐的是 IPC。
 */
async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const buffer = await Promise.race([
      window.api.ttsSpeak({ url, headers, body }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(CODE_UNREACHABLE)), TTS_TIMEOUT_MS)
      })
    ])
    // 服务返回的 Content-Type 不随字节过 IPC，这里按 MP3 标注：预设端点与
    // OpenAI 兼容的 /v1/audio/speech 都回 MP3（父任务实测 2026-09-29）。
    return new Response(buffer, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
  } catch (e) {
    const status = httpStatusOf(e)
    if (status !== null) return new Response(null, { status })
    throw e
  } finally {
    clearTimeout(timer)
  }
}

function cancelSystemSpeech(): void {
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.cancel()
  }
}

/**
 * 错误 → 一句话。**原因码在这里翻译**：`TTS_UNREACHABLE` / `TTS_HTTP_*` 是跨进程的内部
 * 约定，原样端给用户就是把实现术语塞进设置页的试听反馈（quality-guidelines 的 P 系列
 * 挡的正是这类东西）。日志里留的是同一句话 —— 定位靠上下文，不靠码。
 */
function describeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  if (raw === CODE_UNREACHABLE) return '连不上语音服务'
  const http = HTTP_CODE_RE.exec(raw)
  if (http) return `语音服务返回 ${http[1]}`
  return raw
}
