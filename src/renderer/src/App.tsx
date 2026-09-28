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
import { stopVoice } from './voice'
import { providerSummary, qualitySuffix } from '../../shared/tray-text'
import { speakableSnapshots } from './read-model'

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
  /** 语音播报开关（ui:voiceOn，默认关） */
  const [voiceOn, setVoiceOn] = useState(false)
  /** 语音播报间隔（分钟，ui:voiceEvery，默认 60，档位 1/3/5/10/15/30/60） */
  const [voiceEvery, setVoiceEvery] = useState(60)
  /** 不播报的供应商 id（ui:voiceMuted，默认空 = 全部播报） */
  const [voiceMuted, setVoiceMuted] = useState<string[]>([])
  /** 语音播报音色性别（ui:voiceGender，默认 any = 不限制） */
  const [voiceGender, setVoiceGender] = useState<'female' | 'male' | 'any'>('any')

  /**
   * 播报上下文：定时器 effect 只依赖「开关 + 间隔」，其余值一律从 ref 读。
   * 为什么必须如此：依赖数组里一旦带上 collapsed / view，每次收/展面板、切视图
   * 都会重跑 effect 并「立即触发一次」—— 间隔设成 1 分钟就会感觉被播报了好几次。
   */
  const speakCtxRef = useRef({ collapsed: false, snapshots: state.snapshots, hideBalance: false, muted: voiceMuted, gender: voiceGender })
  speakCtxRef.current = { collapsed, snapshots: state.snapshots, hideBalance, muted: voiceMuted, gender: voiceGender }
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
  /** 语音播报开关 */
  const toggleVoiceOn = (on: boolean): void => {
    setVoiceOn(on)
    void window.api.setExtras({ 'ui:voiceOn': on ? '1' : '0' })
  }
  /** 某个供应商要不要播报（写进 ui:voiceMuted 的「不播报」列表） */
  const toggleVoiceFor = (id: string): void => {
    const next = voiceMuted.includes(id) ? voiceMuted.filter((x) => x !== id) : [...voiceMuted, id]
    setVoiceMuted(next)
    void window.api.setExtras({ 'ui:voiceMuted': JSON.stringify(next) })
  }

  /** 语音播报间隔（分钟） */
  const setVoiceEveryInterval = (minutes: number): void => {
    setVoiceEvery(minutes)
    void window.api.setExtras({ 'ui:voiceEvery': String(minutes) })
  }

  /** 语音播报音色性别 */
  const setVoiceGenderPref = (g: 'female' | 'male' | 'any'): void => {
    setVoiceGender(g)
    void window.api.setExtras({ 'ui:voiceGender': g })
  }

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
    void window.api.getExtras(['ui:hideBalance', 'ui:pet', 'ui:petState', 'ui:alwaysOnTop', 'ui:voiceOn', 'ui:voiceEvery', 'ui:voiceMuted', 'ui:voiceGender']).then((e) => {
      setHideBalance(e['ui:hideBalance'] === '1')
      // 默认是 2D 小圆环；只有用户显式开启（'1'）才是个性人物形态
      setPetOn(e['ui:pet'] === '1')
      setAlwaysTop(e['ui:alwaysOnTop'] !== '0')
      setVoiceOn(e['ui:voiceOn'] === '1')
      try {
        const muted = JSON.parse(e['ui:voiceMuted'] || '[]') as unknown
        setVoiceMuted(Array.isArray(muted) ? muted.filter((x): x is string => typeof x === 'string') : [])
      } catch {
        setVoiceMuted([])
      }
      const gender = e['ui:voiceGender']
      setVoiceGender(gender === 'female' || gender === 'male' ? gender : 'any')
      const every = parseInt(e['ui:voiceEvery'] || '60', 10)
      // 支持档位：1/3/5/10/15/30/60 分钟
      if (every >= 1 && [1, 3, 5, 10, 15, 30, 60].includes(every)) {
        setVoiceEvery(every)
      }
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

  /** 动态 import 语音模块并朗读；失败只记一条日志，不影响界面 */
  const say = (text: string): void => {
    import('./voice')
      .then(({ speak }) => speak(text, 'zh-CN', speakCtxRef.current.gender))
      .catch(() => console.warn('[voice] 无法导入 speak 函数'))
  }

  /** 播报焦点供应商：文案复用 shared/tray-text 的纯函数（与托盘同一口径，不再手写一份） */
  const speakBalance = (): void => {
    if (!voiceOn) return
    const ctx = speakCtxRef.current
    // 只在收起态播报：面板开着时屏幕上已经看得见，念出来是打扰
    // （原实现写的是 `if (collapsed || view !== 'card') return`，与它自己的注释
    //   「展开面板时不播报」正好相反 —— 结果是开着面板才播、收成球反而不播）
    if (!ctx.collapsed) return

    const snapshots = speakableSnapshots(ctx.snapshots, ctx.muted)
    if (snapshots.length === 0) return

    // 遍历所有可播报的供应商（2026-09-28 修复：原来只播第一个）
    for (const snapshot of snapshots) {
      const name = snapshot.name || snapshot.id
      // 隐藏余额时不能把金额读出来（界面上是 ••••），只播用量；连用量都没有就如实说明
      if (ctx.hideBalance && !snapshot.windows.some((w) => w.percent != null)) {
        say(`${name}，余额已隐藏`)
        continue
      }
      const summary = providerSummary(snapshot)
      if (!summary) continue
      say(`${name}，${summary}${qualitySuffix(snapshot)}`)
    }
  }

  /** 语音播报定时器 */
  useEffect(() => {
    if (!voiceOn) {
      if (voiceTimerRef.current) {
        window.clearInterval(voiceTimerRef.current)
        voiceTimerRef.current = null
      }
      return
    }

    // 清除旧定时器
    if (voiceTimerRef.current) {
      window.clearInterval(voiceTimerRef.current)
    }

    // 立即触发一次
    speakBalance()

    // 自重排定时器：只有开关或间隔变化才会走到这里
    voiceTimerRef.current = window.setInterval(() => {
      speakBalance()
    }, voiceEvery * 60 * 1000)

    return () => {
      if (voiceTimerRef.current) {
        window.clearInterval(voiceTimerRef.current)
        voiceTimerRef.current = null
      }
    }
  }, [voiceOn, voiceEvery])

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
            voiceOn={voiceOn}
            voiceEvery={voiceEvery}
            onToggleVoiceOn={toggleVoiceOn}
            onSetVoiceEvery={setVoiceEveryInterval}
            alwaysTop={alwaysTop}
            onToggleAlwaysTop={toggleAlwaysTop}
            voiceGender={voiceGender}
            onSetVoiceGender={setVoiceGenderPref}
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
