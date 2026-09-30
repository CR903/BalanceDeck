import { Component, useEffect, useRef, useState } from 'react'
import type { AppState, ProviderSnapshot } from '../../shared/types'
import { CardView } from './CardView'
import { DetailView } from './DetailView'
import { SettingsView } from './SettingsView'
import { presetConfig } from './VoiceReminderSection'
import { PetBall } from './PetBall'
import { renderTrayIcon } from './ProviderMark'
import {
  PETS,
  decodePetState,
  defaultPetState,
  encodePetState,
  petGender,
  petMeta,
  type PetId,
  type PetState
} from '../../shared/pet'
import type { PetMenuModel } from '../../shared/types'
import { providerSummary, qualitySuffix } from '../../shared/tray-text'
import { speakableSnapshots } from './read-model'
import {
  DEFAULT_TTS_CONFIG,
  PROBE_IDLE,
  enqueue,
  flush,
  probeStep,
  probeTts,
  stopAll,
  type ProbeEvent,
  type ProbeState,
  type TtsConfig
} from './speechOut'
import {
  DEFAULT_TRIGGER_CONFIG,
  THRESHOLD_FIELD,
  type ProviderOverride,
  type TriggerConfig,
  type TriggerKind
} from './smartBroadcast'
import { DEFAULT_HISTORY_CAP, type HistoryPoint } from './history'
import {
  confirm,
  evaluate,
  latestPending,
  pendingCountdown,
  type PendingAlert
} from './alertOrchestrate'

/**
 * 待确认预警的轮询周期。
 *
 * 为什么是轮询而不是「精确 5 分钟后排一次」：重复间隔是「**至少**隔这么久」，早几秒无所谓；
 * 精确调度要额外处理系统休眠唤醒后的补偿，而 30s 的粒度下最坏也就早播 30 秒。
 * 唯一的一处近似是不播时评估得比数据推送勤（纯函数 + appendPoint，上限 100 条，开销可忽略），
 * 换来的是唤醒后立刻恢复。`backgroundThrottling: false` 已关（main/overlay.ts）。
 */
const ALERT_TICK_MS = 30_000

/** 渲染层兜底：任何未捕获渲染异常显示可重载界面，避免"假死"白屏 */
class ErrorBoundary extends Component<{ children: React.ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null }
  static getDerivedStateFromError(err: Error): { err: Error } {
    return { err }
  }
  render(): React.JSX.Element {
    if (this.state.err) {
      return (
        <div
          className="err-boundary"
          onClick={() => {
            this.setState({ err: null })
            window.location.reload()
          }}
        >
          界面出错：{this.state.err.message}
          <br />
          <b>点击重载</b>
        </div>
      )
    }
    return this.props.children as React.JSX.Element
  }
}

type View = 'card' | 'detail' | 'settings'

export default function App(): React.JSX.Element {
  const [state, setState] = useState<AppState>({ snapshots: [], lastSync: null, scanning: false })
  const [view, setView] = useState<View>('card')
  const [openId, setOpenId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [skin, setSkinId] = useState('aero')
  const [skinCss, setSkinCss] = useState<string | null>(null)
  /** 主面板余额显隐（ui:hideBalance）——隐私偏好，跨收起态共享 */
  const [hideBalance, setHideBalance] = useState(false)


  // ─── 数字助理（身份由 App 统一持有：悬浮球、右键菜单、设置页共用同一份）──────
  const [pet, setPet] = useState<PetState>(() => defaultPetState())
  const petRef = useRef(pet)
  petRef.current = pet
  /** 收起态形态（ui:pet）：true = 个性人物（人物独立站着），false = 默认的悬浮球 */
  const [petOn, setPetOn] = useState(true)
  /** 悬浮球是否总在最前（ui:alwaysOnTop，默认开） */
  const [alwaysTop, setAlwaysTop] = useState(true)
  /** 语音播报开关（ui:voiceOn，默认关）—— **已下线**，播报改由 ui:ttsOn 接管。
   *  读一次只为把旧配置迁到 ui:ttsOn（新值优先，键留着不动），不再有 setter：
   *  留一个能写却没人听的开关，就是让用户以为设置生效了。 */
  /** 不播报的供应商 id（ui:voiceMuted，默认空 = 全部播报） */
  const [voiceMuted, setVoiceMuted] = useState<string[]>([])

  // ─── 语音提醒（TTS 集成 + 智能播报）────────────────────────────────────────
  // 所有键都是 ui: 前缀：非 ui: 的 extras 写入会触发一次全量重新采集（ipc.ts:191-193）
  /** TTS 播报总开关（ui:ttsOn，默认关） */
  const [ttsOn, setTtsOn] = useState(false)
  /** TTS 服务配置（ui:ttsConfig，**不含密钥** —— token 走主进程加密 IPC） */
  const [ttsConfig, setTtsConfig] = useState<TtsConfig>(DEFAULT_TTS_CONFIG)
  /** 预设 id（'' = 自定义）（ui:ttsPreset） */
  const [ttsPreset, setTtsPreset] = useState('mytts')
  /** 触发条件 + 阈值（ui:ttsTriggers） */
  const [ttsTriggers, setTtsTriggers] = useState<TriggerConfig>(DEFAULT_TRIGGER_CONFIG)
  /** 场景开关（ui:ttsTriggerOn）—— 与阈值分开存：阈值是数，开关是 bool，拼在一起不好校验 */
  const [ttsTriggerOn, setTtsTriggerOn] = useState<Record<TriggerKind, boolean>>({
    balance: true,
    fluctuation: true,
    exhaustion: true,
    idle: false,
    abnormal: false
  })
  /** 播报内容格式（ui:ttsTextFormat） */
  const [ttsFormat, setTtsFormat] = useState<'simple' | 'detailed'>('simple')
  /** 视觉通知（ui:ttsVisual） */
  const [ttsVisual, setTtsVisual] = useState(false)
  /** TTS 失败时回退系统语音（ui:ttsFallback，默认开：降级比静默好） */
  const [ttsFallback, setTtsFallback] = useState(true)
  /** 定时兜底播报（ui:ttsRoutine，默认关：智能播报已覆盖日常提醒） */
  const [ttsRoutine, setTtsRoutine] = useState(false)
  /** 兜底间隔分钟（ui:ttsRoutineEvery，默认 60） */
  const [ttsRoutineEvery, setTtsRoutineEvery] = useState(60)
  /** 历史条数上限（ui:ttsHistoryCap） */
  const [ttsHistoryCap, setTtsHistoryCap] = useState(DEFAULT_HISTORY_CAP)
  /** 历史快照（ui:ttsHistory）—— 供波动/未使用/异常三个场景判定 */
  const [ttsHistory, setTtsHistory] = useState<HistoryPoint[]>([])
  /** TTS 服务是否仍连不上（内存态，不持久化：重启后重新探测） */
  const [ttsUnreachable, setTtsUnreachable] = useState(false)
  /**
   * 退避探测的进度（不可达 → 5s/15s/1min/5min 各试一次 → 恢复即停）。
   *
   * 内存态、**不落盘**：它描述的是「这一轮连不上」，跨重启保留下来只会让新会话一上来
   * 就挂着一条已经过期的提示。纯状态机在 speechOut 的 probeStep（可单测），这里只排程。
   */
  const probeRef = useRef<ProbeState>(PROBE_IDLE)
  /** 探测定时器句柄。与播报的两条定时器分开 —— 探测是「服务不可达」时才存在的旁路，
   *  混进播报链会让每次切换开关都重建它（定时器契约见 state-management.md）。 */
  const probeTimerRef = useRef<number | null>(null)
  /**
   * 组件是否还活着。探测的 await 回来时必须先看它，否则卸载后还会 setState + 排下一个
   *  定时器（hook-guidelines「异步 effect 用 cancelled 守卫」的那一条）。
   *
   * ⚠ 这个标志**必须在 effect 体里置回 true**，只在 cleanup 里置 false 是错的：
   *   本项目渲染入口挂着 `<React.StrictMode>`（main.tsx），而 React 18 的 StrictMode
   *   在开发模式下会把每个 effect 跑成「挂载 → 清理 → 再挂载」。ref 跨这次假卸载**不会**
   *   被重置，于是清理里写下的 false 会一直留着 —— 开发模式下 runProbe 的结果从此
   *   全被丢弃，退避探测（也就是缺陷 2 的自愈通路）静默失效，而 production 构建里
   *   又一切正常。component-guidelines 那条「清理里只清 ref，状态复位放回 effect 体」
   *   说的正是这件事。
   */
  const probeInFlightRef = useRef(true)
  /**
   * 已配置 token（只记有无）。
   *
   * token 明文的落点在本组件里是**没有**：这里曾经有 `const ttsSecretRef = useRef('')`
   * 存明文、每条播报现拼一个 `Authorization` 头，09-29-tts-request-to-main 把它删了 ——
   * 请求改由主进程发出去，读 token 与拼头一并归 `ipc.ts` 的 `tts:speak`（FR6 / AC7）。
   *
   * ⚠ 别为了「少一次 IPC 往返」把 getter（`tts:getSecret`）加回来：它已随本次任务删除，
   *   明文一旦跨进渲染层，「全程留在主进程」就只剩「现在这版没读」。门禁：E5 + F6。
   */
  const [ttsHasSecret, setTtsHasSecret] = useState(false)
  /** 视觉通知文本（'' = 无） */
  const [ttsVisualText, setTtsVisualText] = useState('')
  const ttsVisualTimerRef = useRef<number | null>(null)
  /** 「测试播报」的试听反馈（null = 无）。成功会自己消失，失败留着等用户改配置 */
  const [testNote, setTestNote] = useState<{ ok: boolean; text: string } | null>(null)
  const testNoteTimerRef = useRef<number | null>(null)

  const voiceTimerRef = useRef<number | null>(null)
  /**
   * 待确认预警（AC7）：已播但用户还没点「知道了」的批次。
   *
   * 内存态、**不落盘**（NFR4）：用户重启应用说明他已经看到过屏幕，把「上次播过」跨重启
   * 记下来只会让重启后的第一轮永远不播。给引用（而不是直接读 state）是为了让轮询定时器
   * 读到最新值而不必把它加进依赖数组 —— 定时器契约见 state-management.md。
   */
  const alertPendingRef = useRef<PendingAlert[]>([])
  /** 确认条要显示的批次与倒计时（渲染用；真正的时钟在 evaluateAlerts 里取） */
  const [alertPending, setAlertPending] = useState<PendingAlert[]>([])
  /** 倒计时的**显示**时钟。0 = 还没起表（首帧用真实时钟兜底），之后由 30s 轮询顺带推进 */
  const [alertNow, setAlertNow] = useState(0)
  /** 待确认轮询的 setTimeout 句柄（自重排链，与兜底播报那个是两条） */
  const alertTimerRef = useRef<number | null>(null)

  const persistPet = (s: PetState): void => {
    void window.api.setExtras({ 'ui:petState': encodePetState(s) })
  }

  /**
   * 收起态 3D 场景句柄（由 PetBall 创建后挂到 window，见 scene.ts）。
   * 画面编排（进场/退场/平时随机动作）全在场景里，这里只表达意图。
   */
  const petScene = (): { playGesture?: (id: string) => Promise<void> } | undefined =>
    (window as unknown as { __bd_pet_scene__?: { playGesture?: (id: string) => Promise<void> } })
      .__bd_pet_scene__

  /** 播一个动作，播完（或场景不存在）后兑现；动画时长由场景按素材算，这里不猜秒数 */
  const playGesture = async (id: 'enter' | 'exit' | 'wave'): Promise<void> => {
    try {
      const scene = petScene()
      if (scene?.playGesture) await scene.playGesture(id)
    } catch (e) {
      console.warn(`[app] ${id} 动作播放失败:`, e)
    }
  }

  /** 换一位：换形象与默认名 */
  const changePet = (id: PetId): void => {
    const s: PetState = { ...petRef.current, id, name: petMeta(id).name }
    const swap = (): void => {
      setPet(s)
      persistPet(s)
    }
    // 先让人退场、**等它真的走完**再换人（换人后场景会自动播进场）：
    // 老代码在这里 setPet 紧跟 playExitAnim，退场动作实际上从没播出来过。
    if (!petOn) {
      swap()
      return
    }
    void playGesture('exit').then(swap)
  }
  const renamePet = (name: string): void => {
    const s = { ...petRef.current, name }
    setPet(s)
    persistPet(s)
  }
  /** 收起态是否显示个性人物（关闭 = 悬浮球） */
  const togglePetBall = (on: boolean): void => {
    const apply = (): void => {
      setPetOn(on)
      void window.api.setExtras({ 'ui:pet': on ? '1' : '0' })
    }
    // 关掉时先让它退场（挥手告别 + 转身走出窗口）再收成球；开启时场景会在模型就位时自动进场
    if (on) {
      apply()
      return
    }
    void playGesture('exit').then(apply)
  }
  /** 总在最前（关闭后不再悬浮于其它窗口之上） */
  const toggleAlwaysTop = (on: boolean): void => {
    setAlwaysTop(on)
    window.api.setAlwaysOnTop(on)
    void window.api.setExtras({ 'ui:alwaysOnTop': on ? '1' : '0' })
  }
  /** 某个供应商要不要播报（写进 ui:voiceMuted 的「不播报」列表） */
  const toggleVoiceFor = (id: string): void => {
    const next = voiceMuted.includes(id) ? voiceMuted.filter((x) => x !== id) : [...voiceMuted, id]
    setVoiceMuted(next)
    void window.api.setExtras({ 'ui:voiceMuted': JSON.stringify(next) })
  }

  // ─── 语音提醒：持久化辅助 ─────────────────────────────────────────────────
  // 读取处一律重新校验：extras 可能被旧版本或手改写成任意值（state-management.md:178-180）

  const pos = (v: unknown, fallback: number, min = 0): number =>
    typeof v === 'number' && Number.isFinite(v) && v > min ? v : fallback

  const persistTriggers = (next: TriggerConfig): void => {
    setTtsTriggers(next)
    void window.api.setExtras({ 'ui:ttsTriggers': JSON.stringify(next) })
  }

  const persistTriggerOn = (next: Record<TriggerKind, boolean>): void => {
    setTtsTriggerOn(next)
    void window.api.setExtras({ 'ui:ttsTriggerOn': JSON.stringify(next) })
  }

  const persistConfig = (next: TtsConfig): void => {
    setTtsConfig(next)
    void window.api.setExtras({ 'ui:ttsConfig': JSON.stringify(next) })
  }

  const persistHistory = (next: HistoryPoint[]): void => {
    setTtsHistory(next)
    void window.api.setExtras({ 'ui:ttsHistory': JSON.stringify(next) })
  }

  // ─── 语音提醒：加载 ───────────────────────────────────────────────────────
  useEffect(() => {
    const KEYS = [
      'ui:ttsOn', 'ui:ttsConfig', 'ui:ttsPreset', 'ui:ttsTriggers', 'ui:ttsTriggerOn',
      'ui:ttsTextFormat', 'ui:ttsVisual', 'ui:ttsFallback', 'ui:ttsRoutine',
      'ui:ttsRoutineEvery', 'ui:ttsHistoryCap', 'ui:ttsHistory', 'ui:voiceOn'
    ]
    void window.api.getExtras(KEYS).then((e) => {
      // ⚠ `extras:get` 对**不存在的键**返回 `''`（`out[k] = getExtra(k) ?? ''`，ipc.ts:198），
      //   不是 undefined。所以「键缺失」只能判 `!v`，**判 `v == null` 永远为假** ——
      //   本来就是这么写的，于是下面两条都静默失效过（新用户落在自定义服务、迁移永不触发）。
      const raw = (k: string): string => e[k] ?? ''

      // 旧版 ui:voiceOn 迁移：播报开关从「系统语音」平移到「语音提醒」，不丢用户既有配置。
      // 判据：ui:ttsOn 明确写过就以它为准（`'0'` = 用户主动关了，不许被旧键翻回开）；
      // 没写过（''）才回落到旧键。
      const legacyOn = raw('ui:voiceOn') === '1'
      setTtsOn(raw('ui:ttsOn') === '1' || (raw('ui:ttsOn') !== '0' && legacyOn))
      // 预设同理：缺省落在免费服务上，而不是「自定义」（自定义下地址是空的，等于没配服务 → 不播报）
      setTtsPreset(raw('ui:ttsPreset') || 'mytts')

      try {
        const c = JSON.parse(e['ui:ttsConfig'] || '{}') as Partial<TtsConfig>
        persistConfigSilently({
          url: typeof c.url === 'string' && c.url ? c.url : DEFAULT_TTS_CONFIG.url,
          voice: typeof c.voice === 'string' && c.voice ? c.voice : DEFAULT_TTS_CONFIG.voice,
          speed: pos(c.speed, DEFAULT_TTS_CONFIG.speed, 0.1),
          // style 是本轮新增的字段：**旧配置里根本没有这个键**（那时它是写死的），
          // 所以读不到是常态而不是异常，补默认值即可 —— 补的值正是当时写死的那个，
          // 升级前后行为不变（NFR2）。
          style: typeof c.style === 'string' && c.style ? c.style : DEFAULT_TTS_CONFIG.style
        })
      } catch {
        persistConfigSilently(DEFAULT_TTS_CONFIG)
      }

      try {
        const t = JSON.parse(e['ui:ttsTriggers'] || '{}') as Partial<TriggerConfig>
        persistTriggersSilently({
          balanceLow: pos(t.balanceLow, DEFAULT_TRIGGER_CONFIG.balanceLow, 0),
          fluctuation: pos(t.fluctuation, DEFAULT_TRIGGER_CONFIG.fluctuation, 0),
          exhaustionPct: pos(t.exhaustionPct, DEFAULT_TRIGGER_CONFIG.exhaustionPct, 0),
          idleHours: pos(t.idleHours, DEFAULT_TRIGGER_CONFIG.idleHours, 0),
          abnormalMul: pos(t.abnormalMul, DEFAULT_TRIGGER_CONFIG.abnormalMul, 1),
          ...(t.perProvider && typeof t.perProvider === 'object' ? { perProvider: t.perProvider } : {})
        })
      } catch {
        persistTriggersSilently(DEFAULT_TRIGGER_CONFIG)
      }

      try {
        const s = JSON.parse(e['ui:ttsTriggerOn'] || '{}') as Partial<Record<TriggerKind, boolean>>
        setTtsTriggerOn({
          balance: s.balance !== false,
          fluctuation: s.fluctuation !== false,
          exhaustion: s.exhaustion !== false,
          idle: s.idle === true,
          abnormal: s.abnormal === true
        })
      } catch {
        /* 保持默认 */
      }

      const fmt = e['ui:ttsTextFormat']
      setTtsFormat(fmt === 'detailed' ? 'detailed' : 'simple')
      setTtsVisual(e['ui:ttsVisual'] === '1')
      setTtsFallback(e['ui:ttsFallback'] !== '0')
      setTtsRoutine(e['ui:ttsRoutine'] === '1')
      setTtsRoutineEvery(pos(parseInt(e['ui:ttsRoutineEvery'] || '', 10), 60, 1))
      setTtsHistoryCap(pos(parseInt(e['ui:ttsHistoryCap'] || '', 10), DEFAULT_HISTORY_CAP, 10))

      try {
        const h = JSON.parse(e['ui:ttsHistory'] || '[]') as unknown
        if (Array.isArray(h)) {
          const cap = pos(parseInt(e['ui:ttsHistoryCap'] || '', 10), DEFAULT_HISTORY_CAP, 10)
          // 裁剪到上限：旧配置或手改可能存超量
          setTtsHistory(h.filter((p): p is HistoryPoint => !!p && typeof p === 'object'
            && typeof (p as HistoryPoint).t === 'number' && typeof (p as HistoryPoint).id === 'string'
          ).slice(-cap))
        }
      } catch {
        setTtsHistory([])
      }

      // token 只取「有没有」：明文不出主进程（FR6）
      void window.api.ttsHasSecret('default').then((v) => setTtsHasSecret(!!v))
    })

    // 只写 state 不回写 extras：加载时回写会触发一次无谓的落盘
    function persistConfigSilently(c: TtsConfig): void {
      setTtsConfig(c)
    }
    function persistTriggersSilently(t: TriggerConfig): void {
      setTtsTriggers(t)
    }
  }, [])

  // 暴露诊断函数到 window，方便在控制台排查音色问题
  //
  // 用动态 import 而非顶层静态 import：speechOut 的系统语音回退刻意把 voice.ts 放在
  // 动态 import 后面（回退是「网络不通」时才走的路径，不该拖慢也不该绑死主链路）。
  // 这里若改成静态 import，voice.ts 就同时被静态与动态引用，vite 会退化成单块 —— 连带
  // 把那层隔离也拆了（构建时会给一条 dynamic-import 警告）。
  useEffect(() => {
    let off = false
    const w = window as unknown as { __bd_voice_diagnostic__?: () => void }
    void import('./voice')
      .then(({ diagnosticVoice }) => {
        if (off) return
        w.__bd_voice_diagnostic__ = diagnosticVoice
      })
      .catch(() => console.warn('[voice] 诊断模块加载失败'))
    return () => {
      off = true
      delete w.__bd_voice_diagnostic__
    }
  }, [])

  /** 悬浮球右键菜单：原生菜单由主进程渲染，动作回到这里执行 */
  const petMenu = async (): Promise<string | null> => {
    const p = petRef.current
    const model: PetMenuModel = {
      title: p.name,
      status: petMeta(p.id).desc,
      pets: PETS.map((x) => ({ id: x.id, name: x.name, checked: x.id === p.id })),
      alwaysOnTop: alwaysTop,
      hideBalance
    }
    const picked = await window.api.petMenu(model)
    if (!picked) return null
    if (picked.startsWith('pet:')) {
      const id = picked.slice(4)
      if (PETS.some((x) => x.id === id)) changePet(id as PetId)
    } else if (picked === 'toggle-top') {
      const next = !alwaysTop
      setAlwaysTop(next)
      window.api.setAlwaysOnTop(next)
      void window.api.setExtras({ 'ui:alwaysOnTop': next ? '1' : '0' })
    } else if (picked === 'toggle-balance') {
      const next = !hideBalance
      setHideBalance(next)
      void window.api.setExtras({ 'ui:hideBalance': next ? '1' : '' })
    } else if (picked === 'expand') {
      setCollapsed(false)
      setView('card')
      window.api.expand()
    } else if (picked === 'settings') {
      setCollapsed(false)
      setView('settings')
      window.api.expand()
    }
    return picked
  }
  useEffect(() => {
    void window.api.getExtras(['ui:hideBalance', 'ui:pet', 'ui:petState', 'ui:alwaysOnTop', 'ui:voiceMuted']).then((e) => {
      setHideBalance(e['ui:hideBalance'] === '1')
      // 默认是 2D 小圆环；只有用户显式开启（'1'）才是个性人物形态
      setPetOn(e['ui:pet'] === '1')
      setAlwaysTop(e['ui:alwaysOnTop'] !== '0')
      try {
        const muted = JSON.parse(e['ui:voiceMuted'] || '[]') as unknown
        setVoiceMuted(Array.isArray(muted) ? muted.filter((x): x is string => typeof x === 'string') : [])
      } catch {
        setVoiceMuted([])
      }
      // ⚠ 这里**不再读** ui:voiceGender：性别改由 petGender(pet.id) 现算（FR3）。
      //   旧键留在 extras 里不动 —— 读过再用它改写用户选的助理，就是「覆盖用户显式偏好」
      //   （上一轮集成复核因此还原过一次），而它本来也只是「谁播报」的另一种问法。
      const st = decodePetState(e['ui:petState'])
      if (st) setPet(st)
    })
  }, [])

  // 收起态形态同步给主进程：球（默认，窗口贴合球体）↔ 个性人物（竖版窗口）。
  // 进场动作不在这里触发 —— 场景在**模型就位**那一刻自己播（模型没加载完就请求等于没播，
  // 老代码那个 300ms 延迟正是进场动画从来没被看到过的原因）。
  useEffect(() => {
    window.api.setPetFigure(petOn)
  }, [petOn])

  const toggleHideBalance = (): void => {
    const next = !hideBalance
    setHideBalance(next)
    void window.api.setExtras({ 'ui:hideBalance': next ? '1' : '' })
  }

  // ─── 语音提醒：智能播报 ───────────────────────────────────────────────────

  /** 播报上下文镜像。定时器依赖数组里**不得**再加第四个依赖，否则每次切换都会立即播一次
   *  （state-management.md:199-202）——所以这些值全部走 ref 读。 */
  const alertCtxRef = useRef({
    collapsed: true,
    snapshots: [] as ProviderSnapshot[],
    history: [] as HistoryPoint[],
    historyCap: DEFAULT_HISTORY_CAP,
    config: DEFAULT_TRIGGER_CONFIG,
    triggerOn: {} as Record<TriggerKind, boolean>,
    format: 'simple' as 'simple' | 'detailed',
    hideBalance: false,
    muted: [] as string[],
    pending: [] as PendingAlert[],
    ttsConfig: DEFAULT_TTS_CONFIG as TtsConfig,
    fallback: true,
    visual: false,
    routine: false,
    // 性别**每轮从助理现算**，不落盘、不进 state（FR3/FR4）：换助理立刻生效，
    // 不必重启、也不必去设置页改第二处。代价是这里每轮多一次查表，可以忽略。
    gender: petGender(petRef.current.id)
  })
  alertCtxRef.current = {
    collapsed,
    snapshots: state.snapshots,
    history: ttsHistory,
    historyCap: ttsHistoryCap,
    config: ttsTriggers,
    triggerOn: ttsTriggerOn,
    format: ttsFormat,
    hideBalance,
    muted: voiceMuted,
    pending: alertPendingRef.current,
    ttsConfig,
    fallback: ttsFallback,
    visual: ttsVisual,
    routine: ttsRoutine,
    gender: petGender(pet.id)
  }

  /**
   * 播报锁存：已播报过的「供应商 × 场景」。
   *
   * 内存态、不持久化：重启后第一次评估会把仍在越界的条件当成新事件播一遍 —— 这是对的，
   * 「上次播过」不该跨重启成立（隔了一夜，余额早就不是同一个语境了）。
   */
  const alertLatchRef = useRef<Set<string>>(new Set())

  /** 视觉通知：文字挂在球上，不依赖系统通知权限 */
  const showVisual = (text: string): void => {
    if (ttsVisualTimerRef.current) window.clearTimeout(ttsVisualTimerRef.current)
    setTtsVisualText(text)
    ttsVisualTimerRef.current = window.setTimeout(() => setTtsVisualText(''), 12_000)
  }

  /** 试听反馈：成功 3 秒后自动消失；失败**不自动消失**（用户得看见它才知道要去改配置） */
  const showTestNote = (ok: boolean, text: string): void => {
    if (testNoteTimerRef.current !== null) {
      window.clearTimeout(testNoteTimerRef.current)
      testNoteTimerRef.current = null
    }
    setTestNote({ ok, text })
    if (ok) testNoteTimerRef.current = window.setTimeout(() => setTestNote(null), 3000)
  }

  const clearProbeTimer = (): void => {
    if (probeTimerRef.current !== null) {
      window.clearTimeout(probeTimerRef.current)
      probeTimerRef.current = null
    }
  }

  /**
   * 不可达 / 恢复的唯一入口。状态迁移交给纯函数 probeStep，本函数只做副作用：
   * 置界面标志 + 排下一次探测定时器。
   *
   * ⚠ `delayMs === null` **不等于**「停止探测」：链还在跑、或这一轮已用尽时它也是 null，
   *   而此时绝不能去动已经挂着的定时器（动了就把下一次探测无限推后）。恢复态
   *   （`next.unreachable === false`）才是唯一该清定时器的情况。
   */
  const stepProbe = (event: ProbeEvent, reason: string): void => {
    if (event === 'fail') console.warn('[voice] TTS 通路不可达：', reason)
    const r = probeStep(probeRef.current, event, Date.now())
    probeRef.current = r.next
    setTtsUnreachable(r.next.unreachable)
    if (!r.next.unreachable) {
      // 恢复：把还挂着的探测停掉，否则它会在服务已经好的情况下再问一次
      clearProbeTimer()
      return
    }
    if (r.delayMs === null) return
    clearProbeTimer()
    probeTimerRef.current = window.setTimeout(() => {
      probeTimerRef.current = null
      void runProbe()
    }, r.delayMs)
  }

  /**
   * 静默探测：只验连通性，不播声、不入队、不占配额（speechOut 的 probeTts 内部直连
   * 主进程 `tts:speak`）。它存在的理由是缺陷 2 的因果链 —— 清标志若只靠「下一次播报成功」，
   * 而后续播报全被闸门拦下，标志就永远粘着。
   */
  const runProbe = async (): Promise<void> => {
    const ctx = alertCtxRef.current
    // 探测与播报共用同一条传输（主进程 tts:speak），认证头由主进程拼，这里只给配置
    const r = await probeTts(ctx.ttsConfig)
    if (!probeInFlightRef.current) return
    if (r.ok) stepProbe('ok', '')
    else stepProbe('probe-fail', r.reason)
  }

  /**
   * 走统一播出口：频率闸门 + 队列 + TTS/系统语音回退都在里面。
   *
   * `bill` 决定这条播报**要不要占免费服务配额**：定时/预警传 true（无人值守，必须限流），
   * 设置页「测试播报」传 false（用户自己点的，一分钟点十次也是他自己的选择）。
   * 过去闸门挂在公共路径上无条件生效，于是第二次点击被**静默丢弃** —— 无日志、无提示、无声音。
   */
  const speakOut = (text: string, urgent: boolean, bill: boolean): void => {
    const ctx = alertCtxRef.current
    enqueue({ text, urgent, bill })
    // 认证头不在这里拼：token 明文不进渲染层，`Authorization` 由主进程 `tts:speak` 自己加
    void flush({
      config: ctx.ttsConfig,
      fallback: ctx.fallback,
      gender: ctx.gender,
      onVisual: ctx.visual ? showVisual : undefined,
      onTtsFailed: (reason) => {
        stepProbe('fail', reason)
        // 试听失败要给用户看得见的反馈；定时播报失败只留日志 + 那条会自动消失的提示
        if (!bill) showTestNote(false, `没播出来：${reason}。检查服务地址是否正确，或点「测试播报」再试。`)
      },
      onTtsOk: () => {
        stepProbe('ok', '')
        if (!bill) showTestNote(true, '试听正常')
      }
    })
  }

  /**
   * 一轮评估：**组装 ctx → 调纯函数 → 落副作用**。返回是否真的产生了新播报。
   *
   * 编排（先判后记、锁存、分级、合并成一条、到期重复与待确认裁剪）都在 alertOrchestrate.ts 里
   * —— 它此前住在这个函数体内，而盲审在这里找出 3 个致命 bug：判定时序颠倒、锁存缺失、阈值覆盖
   * 被丢弃，全部发生在「引擎答不了、只有调用方答得了」的那一层。抽成纯函数后这层终于
   * 有测试盯着（scripts/test-alert-orchestration.mjs）。
   *
   * 数据推送与 30s 轮询**都走这里**（AC7 的重复提醒就靠后者推动），两者天然幂等：
   * 锁存挡「不新鲜」，pending 管「没确认就再播一遍」，两道门各管一段。
   *
   * 两种 reason 走的是同一个 speakOut：频率闸门（每分钟 1 次 / 每小时 10 次）住在那里，
   * 重复播报必须被它约束，不许另开一条绕过 allowCall 的路（NFR1）。
   *
   * 这里仍然走 ref 镜像读实时值：定时器/推送 effect 的依赖数组里不得再加第四个依赖
   * （state-management.md 的定时器契约），所以 ctx 是**这一轮**的显式快照而不是闭包。
   */
  const evaluateAlerts = (): boolean => {
    const ctx = alertCtxRef.current
    // spread 出来的字段全是 ctx 上的；多带的那几个（ttsConfig / fallback / visual…）
    // 编排纯函数不看。必填项缺一个，tsc 就报错 —— 不靠人工核对。
    const d = evaluate({ ...ctx, latched: alertLatchRef.current, now: Date.now() })
    // 整轮无变更（没有快照）：不播、不动历史与锁存
    if (!d) return false
    // 纯函数返回同一引用 = 本轮没有新采样，不必落盘
    if (d.nextHistory !== ctx.history) persistHistory(d.nextHistory)
    ctx.history = d.nextHistory
    // 锁存必须写回：漏了这一句就退回「每 60s 数据推送重播同一句」（AC9）
    alertLatchRef.current = d.nextLatched
    // 同理：待确认批次没动就不 setState，否则每 30s 空转一次渲染
    alertPendingRef.current = d.nextPending
    if (d.nextPending !== ctx.pending) setAlertPending(d.nextPending)
    if (!d.text) return false
    // 「新命中」与「到期重复」走**同一条**播出口 —— 频率闸门在 speakOut 里，重复不能绕开它。
    // 两者都是无人值守的，bill = true。
    speakOut(d.text, d.urgent, true)
    return true
  }

  /**
   * 点「知道了」：只确认**最近播的那一批**（用户回应的是他刚听到的那句），其余批次原样保留
   * —— 确认余额预警不该让用量耗尽的提醒跟着停（FR7 / AC6）。
   * 紧接着重评估一轮：已确认的批次会在那一步被裁掉，同一轮里到期的重复也顺带处理。
   */
  const onConfirmAlert = (): void => {
    const next = confirm(alertPendingRef.current, Date.now())
    // confirm 没有可确认的批次时原样返回同一引用 —— 别为一次空操作触发渲染
    if (next === alertPendingRef.current) return
    alertPendingRef.current = next
    setAlertPending(next)
    evaluateAlerts()
  }

  /** 定时兜底播报：只念当前读数，不判触发 */
  const speakRoutine = (): void => {
    const ctx = alertCtxRef.current
    if (!ctx.routine || !ctx.collapsed) return
    const snapshots = speakableSnapshots(ctx.snapshots, ctx.muted)
    if (snapshots.length === 0) return
    // 合并成一条，避免多个供应商时逐条念完（AC12）
    const parts = snapshots.map((s) => {
      const name = s.name || s.id
      if (ctx.hideBalance && !s.windows.some((w) => w.percent != null)) return `${name}，余额已隐藏`
      const summary = providerSummary(s)
      return summary ? `${name}，${summary}${qualitySuffix(s)}` : null
    }).filter((x): x is string => !!x)
    if (parts.length === 0) return
    // 定时兜底是无人值守的，计费（仍受闸门约束）
    speakOut(parts.join('；'), false, true)
  }

  // ① 数据一变化就评估一次：智能播报的触发源是**数据**，不是时间
  useEffect(() => {
    if (!ttsOn) return
    evaluateAlerts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsOn, state.snapshots])

  // ② 待确认预警的轮询钟：AC7 的重复提醒与倒计时自动确认**共用这一条**自重排 setTimeout 链，
  //    不为它们各加一个定时器（NFR2）。
  useEffect(() => {
    if (!ttsOn) return
    const armAlertTimer = (): void => {
      alertTimerRef.current = window.setTimeout(() => {
        evaluateAlerts()
        // 倒计时的显示时钟只在真的有批次待确认时推：没有待确认的预警就没有倒计时可显示，
        // 这一次 setState 纯属浪费一次渲染
        if (alertPendingRef.current.length > 0) setAlertNow(Date.now())
        armAlertTimer()
      }, ALERT_TICK_MS)
    }
    armAlertTimer()
    return () => {
      if (alertTimerRef.current) {
        window.clearTimeout(alertTimerRef.current)
        alertTimerRef.current = null
      }
    }
    // ⚠ 依赖**只有** [ttsOn]：其余全走 alertCtxRef 镜像。加任何一个都会在每次数据推送时
    //   重建整条链，把下一次重复的时间基准推后（定时器契约见 state-management.md）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsOn])

  // ③ 定时兜底
  useEffect(() => {
    if (!ttsOn || !ttsRoutine) {
      if (voiceTimerRef.current) {
        window.clearTimeout(voiceTimerRef.current)
        voiceTimerRef.current = null
      }
      return
    }
    if (voiceTimerRef.current) window.clearTimeout(voiceTimerRef.current)
    const scheduleNext = (): void => {
      voiceTimerRef.current = window.setTimeout(() => {
        speakRoutine()
        scheduleNext()
      }, ttsRoutineEvery * 60 * 1000)
    }
    scheduleNext()
    return () => {
      if (voiceTimerRef.current) {
        window.clearTimeout(voiceTimerRef.current)
        voiceTimerRef.current = null
      }
    }
  }, [ttsOn, ttsRoutine, ttsRoutineEvery])

  // ④ 关闭播报时把在途音频停掉，并清掉锁存与待确认（下次开启按新的一轮算）。
  //    待确认必须一起清：不清理的话用户关掉再打开，会看到一条早该消失的「知道了」，
  //    而且那一批还会按旧的时间表继续重复播下去。
  //    探测链也一起停：用户主动关了播报，后台不该还替他连服务。
  useEffect(() => {
    if (ttsOn) return
    stopAll()
    alertLatchRef.current = new Set()
    alertPendingRef.current = []
    setAlertPending([])
    probeRef.current = PROBE_IDLE
    setTtsUnreachable(false)
    clearProbeTimer()
  }, [ttsOn])

  // ⑤ 卸载清理：探测定时器与试听提示定时器都必须停，否则组件没了定时器还在跑
  //    （收起态切换会卸载设置页那棵树，定时器活过组件 = 在一个看不见的地方继续请求）。
  useEffect(() => {
    // 复位放回**体**里，不放清理里 —— StrictMode 的开发态双调用会让「只清理不复位」
    // 的写法把标志永久按成 false（见 probeInFlightRef 的注释）。
    probeInFlightRef.current = true
    return () => {
      clearProbeTimer()
      probeInFlightRef.current = false
      if (testNoteTimerRef.current !== null) window.clearTimeout(testNoteTimerRef.current)
    }
  }, [])

  // ─── 语音提醒：设置页回调 ─────────────────────────────────────────────────

  const toggleTts = (on: boolean): void => {
    setTtsOn(on)
    void window.api.setExtras({ 'ui:ttsOn': on ? '1' : '0' })
    if (!on) stopAll()
  }

  const setSecret = (value: string): void => {
    const v = value.trim()
    // 空串在 UI 上是 no-op（VoiceReminderSection 的契约如此），这里也不删
    if (!v) return
    // 明文只在这一跳里过进程（用户刚敲的那串）：主进程落 items 密文，渲染层不回读、不缓存
    void window.api.setTtsSecret('default', v).then(() => setTtsHasSecret(true))
  }

  /**
   * 「测试播报」：用户主动点的，**不计配额**（FR5）。
   *
   * 一分钟内连点三次就该响三次 —— 过去第二次就被频率闸门静默丢弃，连同「服务不可达」
   * 一起变成一个用户解不开的死结（缺陷 1 与缺陷 2 是同一条因果链）。
   */
  const testSpeak = (text: string): void => {
    speakOut(text, false, false)
  }

  const changeTrigger = (kind: string, patch: { on?: boolean; value?: number }): void => {
    const k = kind as TriggerKind
    if (patch.on !== undefined) {
      persistTriggerOn({ ...ttsTriggerOn, [k]: patch.on })
    }
    if (patch.value !== undefined && Number.isFinite(patch.value)) {
      const field = THRESHOLD_FIELD[k]
      if (!field) return
      persistTriggers({ ...ttsTriggers, [field]: patch.value })
    }
  }

  const changeOverride = (providerId: string, kind: string, value: number | null): void => {
    const k = kind as TriggerKind
    const field = THRESHOLD_FIELD[k]
    if (!field) return
    const prev = ttsTriggers.perProvider ?? {}
    // cur 的类型必须是 ProviderOverride（阈值字段名 → 数值）：写宽成 Record<string, number>
    // 的话，写错键名（存成 'balance' 而不是 'balanceLow'）编译期一声不吭，
    // 运行时覆盖表里躺着一个引擎永远读不到的键 —— 设置页显示「已覆盖」，实际不生效
    const cur: ProviderOverride = { ...(prev[providerId] ?? {}) }
    if (value == null) delete cur[field]
    else cur[field] = value
    const perProvider: Record<string, ProviderOverride> = { ...prev }
    if (Object.keys(cur).length === 0) delete perProvider[providerId]
    else perProvider[providerId] = cur
    persistTriggers({ ...ttsTriggers, perProvider })
  }

  useEffect(() => {
    void window.api.getState().then(setState)
    const off1 = window.api.onState(setState)
    const off2 = window.api.onCollapsed(setCollapsed)
    const apply = (id: string): void => {
      setSkinId(id)
      if (id.startsWith('ext:')) void window.api.getSkinCss(id).then(setSkinCss)
      else setSkinCss(null)
    }
    void window.api.currentSkin().then(apply)
    const off3 = window.api.onSkin(apply)
    return () => {
      off1()
      off2()
      off3()
    }
  }, [])

  const doCollapse = (): void => {
    setCollapsed(true)
    window.api.collapse()
  }
  const doExpand = (): void => {
    setCollapsed(false)
    setView('card')
    window.api.expand()
  }
  const openDetail = (id: string): void => {
    setOpenId(id)
    setView('detail')
  }

  const current = state.snapshots.find((s) => s.id === openId)

  // 托盘图标随「优先级第一位」的供应商变化（卡片顺序 = 用户定义的优先级）
  const primaryMark = (state.snapshots.find((s) => s.status === 'ok' && s.windows.length > 0) ?? state.snapshots[0])?.mark
  useEffect(() => {
    if (!primaryMark) return
    let cancelled = false
    void renderTrayIcon(primaryMark)
      .then(({ png1x, png2x }) => {
        if (!cancelled) window.api.setTrayIcon(primaryMark, png1x, png2x)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [primaryMark])

  // Esc：详情/设置返回主页（悬浮组件的通用习惯）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setView((v) => (v === 'card' ? v : 'card'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /**
   * 确认条要显示什么。**只有最近播的那一批**（latestPending）：用户点的「知道了」
   * 回应的是他刚听到的那一句，同时这一条也保证了「一次确认只关一批」（AC6）。
   *
   * 倒计时取**分钟**而不是秒：它由 30s 轮询推进（NFR2 不为倒计时另加一个定时器），
   * 秒级显示会是一个永远慢半拍的数字。alertNow 为 0（还没起表）时用真实时钟兜底，
   * 首帧的显示与起表后完全一致。
   */
  const alert = latestPending(alertPending)
  const alertText = alert?.text ?? ''
  const alertMinutes = alert ? Math.ceil(pendingCountdown(alert, alertNow || Date.now()) / 60) : 0

  return (
    <ErrorBoundary>
      <div className="app" data-skin={skin}>
        {skinCss && <style>{skinCss}</style>}
        {collapsed ? (
          <PetBall
            pet={pet}
            figure={petOn}
            hideBalance={hideBalance}
            onExpand={doExpand}
            onDragStart={(grab) => window.api.dragStart(grab)}
            onDragEnd={() => window.api.dragEnd()}
            onMenu={petMenu}
            onRename={renamePet}
            notice={ttsVisualText}
            alertText={alertText}
            alertMinutes={alertMinutes}
            onConfirmAlert={onConfirmAlert}
          />
        ) : view === 'settings' ? (
          <SettingsView
            onBack={() => setView('card')}
            onDataChanged={() => void window.api.refreshNow()}
            voiceMuted={voiceMuted}
            onToggleVoice={toggleVoiceFor}
            pet={pet}
            petOn={petOn}
            onChangePet={changePet}
            onRenamePet={renamePet}
            onTogglePetBall={togglePetBall}
            alwaysTop={alwaysTop}
            onToggleAlwaysTop={toggleAlwaysTop}
            ttsOn={ttsOn}
            onToggleTts={toggleTts}
            servicePreset={ttsPreset}
            onChangePreset={(id) => {
              setTtsPreset(id)
              void window.api.setExtras({ 'ui:ttsPreset': id })
              // 切到预设时把 url/voice/style 一并落进 ui:ttsConfig —— 预设分支里界面显示的是
              // 只读端点（读自预设表），而真正发请求用的是 ui:ttsConfig.url。不同步的话，
              // 用户在「预设 / 自定义」之间来回切一次，界面写着免费服务、请求却打向他
              // 之前填的自定义地址，且没有任何提示。
              // 切到「自定义服务」时**不动**配置：那几项本来就是用户自己填的。
              const p = presetConfig(id)
              if (p) persistConfig({ ...ttsConfig, url: p.url, voice: p.voice, style: p.style })
            }}
            ttsUrl={ttsConfig.url}
            onChangeUrl={(url) => persistConfig({ ...ttsConfig, url })}
            ttsVoice={ttsConfig.voice}
            onChangeVoice={(v) => persistConfig({ ...ttsConfig, voice: v })}
            ttsStyle={ttsConfig.style}
            onChangeStyle={(s) => persistConfig({ ...ttsConfig, style: s })}
            ttsSpeed={ttsConfig.speed}
            onChangeSpeed={(n) => persistConfig({ ...ttsConfig, speed: n })}
            hasSecret={ttsHasSecret}
            onSetSecret={setSecret}
            onTestSpeak={testSpeak}
            testNote={testNote}
            triggers={Object.fromEntries(
              (Object.keys(ttsTriggerOn) as TriggerKind[]).map((k) => [
                k,
                {
                  on: ttsTriggerOn[k],
                  // 缺字段回落到引擎的默认阈值，**不是 0**：0 是「余额必须为负」这个
                  // 事实性判断，拿它冒充「不知道」会让设置页显示一个假的 0
                  value: ttsTriggers[THRESHOLD_FIELD[k]] ?? DEFAULT_TRIGGER_CONFIG[THRESHOLD_FIELD[k]]
                }
              ])
            )}
            onChangeTrigger={changeTrigger}
            overrides={ttsTriggers.perProvider ?? {}}
            onChangeOverride={changeOverride}
            textFormat={ttsFormat}
            onChangeTextFormat={(f) => {
              setTtsFormat(f)
              void window.api.setExtras({ 'ui:ttsTextFormat': f })
            }}
            visual={ttsVisual}
            onToggleVisual={(on) => {
              setTtsVisual(on)
              void window.api.setExtras({ 'ui:ttsVisual': on ? '1' : '0' })
            }}
            fallback={ttsFallback}
            onToggleFallback={(on) => {
              setTtsFallback(on)
              void window.api.setExtras({ 'ui:ttsFallback': on ? '1' : '0' })
            }}
            routineOn={ttsRoutine}
            onToggleRoutine={(on) => {
              setTtsRoutine(on)
              void window.api.setExtras({ 'ui:ttsRoutine': on ? '1' : '0' })
            }}
            routineMinutes={ttsRoutineEvery}
            onChangeRoutineMinutes={(n) => {
              setTtsRoutineEvery(n)
              void window.api.setExtras({ 'ui:ttsRoutineEvery': String(n) })
            }}
            historyCap={ttsHistoryCap}
            onChangeHistoryCap={(n) => {
              setTtsHistoryCap(n)
              void window.api.setExtras({ 'ui:ttsHistoryCap': String(n) })
            }}
            unreachable={ttsUnreachable}
            mutedProviders={voiceMuted}
            providerNames={state.snapshots.map((s) => ({ id: s.id, name: s.name || s.id }))}
          />
        ) : view === 'detail' ? (
          <DetailView
            s={current}
            onBack={() => setView('card')}
            onRefresh={() => void window.api.refreshNow()}
          />
        ) : (
          <CardView
            state={state}
            hideBalance={hideBalance}
            onToggleHideBalance={toggleHideBalance}
            onOpen={openDetail}
            onRefresh={() => void window.api.refreshNow()}
            onSettings={() => setView('settings')}
            onCollapse={doCollapse}
          />
        )}
      </div>
    </ErrorBoundary>
  )
}
