import { Component, useEffect, useRef, useState } from 'react'
import type { AppState, ProviderSnapshot } from '../../shared/types'
import { CardView } from './CardView'
import { DetailView } from './DetailView'
import { SettingsView } from './SettingsView'
import { PetBall } from './PetBall'
import { renderTrayIcon } from './ProviderMark'
import {
  PETS,
  decodePetState,
  defaultPetState,
  encodePetState,
  petMeta,
  type PetId,
  type PetState
} from '../../shared/pet'
import type { PetMenuModel } from '../../shared/types'
import { providerSummary, qualitySuffix } from '../../shared/tray-text'
import { maxPercent, speakableSnapshots } from './read-model'
import {
  DEFAULT_TTS_CONFIG,
  enqueue,
  flush,
  stopAll,
  type TtsConfig
} from './speechOut'
import {
  DEFAULT_TRIGGER_CONFIG,
  THRESHOLD_FIELD,
  balanceOf,
  checkTriggers,
  freshHits,
  latchKeys,
  mergeHits,
  type ProviderOverride,
  type TriggerConfig,
  type TriggerKind
} from './smartBroadcast'
import {
  DEFAULT_HISTORY_CAP,
  appendPoint,
  type HistoryPoint
} from './history'

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
  /** 语音播报音色性别（ui:voiceGender，默认 any = 不限制） */
  const [voiceGender, setVoiceGender] = useState<'female' | 'male' | 'any'>('any')

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
  /** 上次 TTS 调用是否失败（内存态，不持久化：重启后重新探测） */
  const [ttsUnreachable, setTtsUnreachable] = useState(false)
  /** 已配置 token（只记有无：明文只在下面那个 ref 里，绝不进 state 也不进 extras） */
  const [ttsHasSecret, setTtsHasSecret] = useState(false)
  /** 视觉通知文本（'' = 无） */
  const [ttsVisualText, setTtsVisualText] = useState('')
  const ttsVisualTimerRef = useRef<number | null>(null)

  /**
   * 自定义 TTS 服务的认证 token 明文。
   *
   * 为什么是 ref 而不是 state：① 放 state 等于每次播报都进 React 状态树，密码字符串
   * 会被 devtools / 错误上报顺走，放 ref 至少不进任何可枚举的快照；② 放 state 会让
   * 组件重渲染，而它只在**播报那一刻**读一次，没必要。
   * 落盘由主进程 items 加密负责（design.md D3），**这里绝不能把它写进 extras**。
   */
  const ttsSecretRef = useRef('')
  const voiceTimerRef = useRef<number | null>(null)

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

  /** 语音播报音色性别（ui:voiceGender）—— 走系统语音回退路径时生效 */
  const setVoiceGenderPref = (g: 'female' | 'male' | 'any'): void => {
    setVoiceGender(g)
    void window.api.setExtras({ 'ui:voiceGender': g })
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
      // 旧版 ui:voiceOn 迁移：播报开关从「系统语音」平移到「语音提醒」，不丢用户既有配置
      const legacyOn = e['ui:voiceOn'] === '1'
      setTtsOn(e['ui:ttsOn'] === '1' || (e['ui:ttsOn'] == null && legacyOn))
      setTtsPreset(typeof e['ui:ttsPreset'] === 'string' ? e['ui:ttsPreset'] : 'mytts')

      try {
        const c = JSON.parse(e['ui:ttsConfig'] || '{}') as Partial<TtsConfig>
        persistConfigSilently({
          url: typeof c.url === 'string' && c.url ? c.url : DEFAULT_TTS_CONFIG.url,
          voice: typeof c.voice === 'string' && c.voice ? c.voice : DEFAULT_TTS_CONFIG.voice,
          speed: pos(c.speed, DEFAULT_TTS_CONFIG.speed, 0.1)
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

      void window.api.getTtsSecret('default').then((s) => {
        ttsSecretRef.current = s ?? ''
        setTtsHasSecret(!!s)
      })
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
    void window.api.getExtras(['ui:hideBalance', 'ui:pet', 'ui:petState', 'ui:alwaysOnTop', 'ui:voiceMuted', 'ui:voiceGender']).then((e) => {
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
      const gender = e['ui:voiceGender']
      setVoiceGender(gender === 'female' || gender === 'male' ? gender : 'any')
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
    ttsConfig: DEFAULT_TTS_CONFIG as TtsConfig,
    fallback: true,
    visual: false,
    routine: false,
    gender: 'any' as 'female' | 'male' | 'any'
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
    ttsConfig,
    fallback: ttsFallback,
    visual: ttsVisual,
    routine: ttsRoutine,
    gender: voiceGender
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

  /** 走统一播出口：频率闸门 + 队列 + TTS/系统语音回退都在里面 */
  const speakOut = (text: string, urgent: boolean): void => {
    const ctx = alertCtxRef.current
    enqueue({ text, urgent })
    // 认证头**每条现拼**：token 只从 ref 读，不进 state、不进 ui:ttsConfig（design.md D3）。
    // 自由约定的自定义服务几乎都用 Bearer，故固定这个前缀；免费服务没有 token，不受影响。
    const token = ttsSecretRef.current
    const config: TtsConfig = token
      ? {
          ...ctx.ttsConfig,
          authHeader: { ...ctx.ttsConfig.authHeader, Authorization: `Bearer ${token}` }
        }
      : ctx.ttsConfig
    void flush({
      config,
      fallback: ctx.fallback,
      gender: ctx.gender,
      onVisual: ctx.visual ? showVisual : undefined,
      onTtsFailed: (reason) => {
        console.warn('[voice] TTS 通路不可达：', reason)
        setTtsUnreachable(true)
      },
      onTtsOk: () => setTtsUnreachable(false)
    })
  }

  /**
   * 一轮评估：先判触发，再记历史，最后合并成**一条**播报（AC12）。
   * 返回是否真的产生了新播报。
   *
   * ⚠ 顺序不能反：checkTriggers 拿到的 hist 必须是**上一轮**的采样（smartBroadcast.ts
   * 文件头的约定）。先把本轮塞进去的话，「相邻两次采样之差」恒为 0 —— 波动场景永远
   * 命中不了（AC4 静默失效），异常检测的均值也会被当轮自己拉偏。
   */
  const evaluateAlerts = (): boolean => {
    const ctx = alertCtxRef.current
    if (ctx.snapshots.length === 0) return false
    const now = Date.now()

    // ① 判触发：沿用上一轮的历史；只判用户开着的场景，已静音的供应商不参与
    const hits = checkTriggers(ctx.snapshots, ctx.history, ctx.config, now)
      .filter((h) => ctx.triggerOn[h.kind] !== false)
      .filter((h) => !ctx.muted.includes(h.id))

    // ② 记历史：本轮采样在判定之后落库，供**下一轮**比对
    let next = ctx.history
    for (const s of ctx.snapshots) {
      if (s.status !== 'ok') continue
      next = appendPoint(
        next,
        { t: now, id: s.id, balance: balanceOf(s), percent: maxPercent(s) },
        ctx.historyCap
      )
    }
    if (next !== ctx.history) persistHistory(next)
    ctx.history = next

    // ③ 锁存：条件持续成立期间只播一次（AC9「恰好一次」）。
    //    锁存的是**本轮进入播报判定的那批**（speakable），不是全部命中 —— 否则展开面板
    //    时被 AC15 挡下的例行项也被记成「播过了」，等用户收起面板就再也听不到。
    const speakable = ctx.collapsed ? hits : hits.filter((h) => h.level === 'urgent')
    const fresh = freshHits(speakable, alertLatchRef.current)
    alertLatchRef.current = new Set(latchKeys(speakable))
    if (fresh.length === 0) return false

    // ④ 合并去重成一条；有紧急就整条按紧急插队（speechOut 会打断例行）
    const text = mergeHits(fresh, ctx.format, { hideBalance: ctx.hideBalance })
    if (!text) return false
    speakOut(text, fresh.some((h) => h.level === 'urgent'))
    return true
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
    speakOut(parts.join('；'), false)
  }

  // ① 数据一变化就评估一次：智能播报的触发源是**数据**，不是时间
  useEffect(() => {
    if (!ttsOn) return
    evaluateAlerts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsOn, state.snapshots])

  // ② 定时兜底
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

  // ③ 关闭播报时把在途音频停掉，并清掉锁存（下次开启按新的一轮算）
  useEffect(() => {
    if (ttsOn) return
    stopAll()
    alertLatchRef.current = new Set()
  }, [ttsOn])

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
    void window.api.setTtsSecret('default', v).then(() => {
      // 明文只留在这个 ref 里（不进 state、不进 extras，见 ttsSecretRef 的注释）
      ttsSecretRef.current = v
      setTtsHasSecret(true)
    })
  }

  const testSpeak = (text: string): void => {
    speakOut(text, false)
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
            voiceGender={voiceGender}
            onSetVoiceGender={setVoiceGenderPref}
            ttsOn={ttsOn}
            onToggleTts={toggleTts}
            servicePreset={ttsPreset}
            onChangePreset={(id) => {
              setTtsPreset(id)
              void window.api.setExtras({ 'ui:ttsPreset': id })
            }}
            ttsUrl={ttsConfig.url}
            onChangeUrl={(url) => persistConfig({ ...ttsConfig, url })}
            ttsVoice={ttsConfig.voice}
            onChangeVoice={(v) => persistConfig({ ...ttsConfig, voice: v })}
            ttsSpeed={ttsConfig.speed}
            onChangeSpeed={(n) => persistConfig({ ...ttsConfig, speed: n })}
            hasSecret={ttsHasSecret}
            onSetSecret={setSecret}
            onTestSpeak={testSpeak}
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
