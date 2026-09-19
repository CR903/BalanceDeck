import { Component, useEffect, useRef, useState } from 'react'
import type { AppState, ProviderSnapshot } from '../../shared/types'
import { CardView } from './CardView'
import { DetailView } from './DetailView'
import { SettingsView } from './SettingsView'
import { PetBall } from './PetBall'
import { renderTrayIcon } from './ProviderMark'
import type { PetAction } from './pet3d/scene'
import {
  PETS,
  applyDecay,
  buildPetExport,
  decodePetState,
  defaultPetState,
  encodePetState,
  feedOnce,
  petMeta,
  petMood,
  petOnce,
  type PetActionResult,
  type PetId,
  type PetState
} from '../../shared/pet'
import type { PetMenuModel } from '../../shared/types'
import { stopVoice } from './voice'
import { providerSummary, qualitySuffix } from '../../shared/tray-text'

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
  /** 最新状态的可读引用：定时器 effect 的依赖里没有 state，闭包直读会拿到旧值 */
  const stateRef = useRef(state)
  stateRef.current = state
  const [view, setView] = useState<View>('card')
  const [openId, setOpenId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [skin, setSkinId] = useState('aero')
  const [skinCss, setSkinCss] = useState<string | null>(null)
  /** 主面板余额显隐（ui:hideBalance）——隐私偏好，跨收起态共享 */
  const [hideBalance, setHideBalance] = useState(false)

  // ─── 宠物（状态由 App 统一持有：悬浮球、右键菜单、设置页共用同一份成长数据）──
  const [pet, setPet] = useState<PetState>(() => defaultPetState())
  const petRef = useRef(pet)
  petRef.current = pet
  /** 收起态是否作为 3D 桌面宠物（ui:pet）：关闭后收起态退回 2D 圆点 */
  const [petOn, setPetOn] = useState(true)
  /** 悬浮球是否显示用量环（ui:petRing） */
  const [petRing, setPetRing] = useState(true)
  /** 悬浮球是否总在最前（ui:alwaysOnTop，默认开） */
  const [alwaysTop, setAlwaysTop] = useState(true)
  /** 语音播报开关（ui:voiceOn，默认关） */
  const [voiceOn, setVoiceOn] = useState(false)
  /** 语音播报间隔（分钟，ui:voiceEvery，默认 60，档位 1/3/5/10/15/30/60） */
  const [voiceEvery, setVoiceEvery] = useState(60)
  const voiceTimerRef = useRef<number | null>(null)
  /** 宠物动作状态：'entering'/'idle'/'exiting' */
  const [petAnimState, setPetAnimState] = useState<'entering' | 'idle' | 'exiting'>('idle')
  /** 当前播放的宠物动作（happy/eat），播完自动回 idle */
  const [petAction, setPetAction] = useState<PetAction>('idle')
  /** 动作序号：同一动作重复触发时也要求重播 */
  const [actionSeq, setActionSeq] = useState(0)
  const actionTimer = useRef<number | null>(null)

  const playPetAction = (a: PetAction): void => {
    setPetAction(a)
    setActionSeq((n) => n + 1)
    if (actionTimer.current !== null) window.clearTimeout(actionTimer.current)
    actionTimer.current = window.setTimeout(() => setPetAction('idle'), a === 'happy' ? 1700 : 2400)
  }

  const persistPet = (s: PetState): void => {
    void window.api.setExtras({ 'ui:petState': encodePetState(s) })
  }

  /** 撸一把：+亲密度/+经验（冷却中返回 ok:false） */
  const petNow = (): PetActionResult => {
    const now = Date.now()
    const before = petRef.current
    const r = petOnce(applyDecay(before, now), now)
    if (r.ok) {
      setPet(r.state)
      persistPet(r.state)
      playPetAction('happy')
    }
    return { ok: r.ok, reason: r.reason, levelUps: r.state.level - before.level }
  }

  /** 喂食：+饱食度/+亲密度（吃饱了返回 ok:false） */
  const feedNow = (): PetActionResult => {
    const now = Date.now()
    const before = petRef.current
    const r = feedOnce(applyDecay(before, now), now)
    if (r.ok) {
      setPet(r.state)
      persistPet(r.state)
      playPetAction('eat')
    }
    return { ok: r.ok, reason: r.reason, levelUps: r.state.level - before.level }
  }

  /** 换一只：保留成长进度，只换形象与默认名 */
  const changePet = (id: PetId): void => {
    const now = Date.now()
    const s: PetState = { ...applyDecay(petRef.current, now), id, name: petMeta(id).name, lastTickAt: now }
    // 切换角色前播放退场动画
    if (petOn) playExitAnim()
    setPet(s)
    persistPet(s)
    // 切换后播放进场动画
    setTimeout(() => playEnterAnim(), 1600)
  }
  const renamePet = (name: string): void => {
    const s = { ...petRef.current, name }
    setPet(s)
    persistPet(s)
  }
  /** 收起态是否显示 3D 桌面宠物（关闭 = 退回 2D 圆点） */
  const togglePetBall = (on: boolean): void => {
    setPetOn(on)
    void window.api.setExtras({ 'ui:pet': on ? '1' : '0' })
  }
  /** 播放进场动画 */
  const playEnterAnim = async (): Promise<void> => {
    if (!petOn) return
    setPetAnimState('entering')
    // 播放 wave 动作作为进场
    try {
      await import('./pet3d/scene').then(async () => {
        // 触发进场动作（场景句柄由 PetBall 创建后挂到 window，见 scene.ts）
        const scene = (window as any).__bd_pet_scene__
        if (scene && scene.playAnim) {
          await scene.playAnim('wave', 1.5) // 1.5 秒进场
        }
      })
    } catch (e) {
      console.warn('[app] 进场动画播放失败:', e)
    }
    // 1.5 秒后回到 idle
    setTimeout(() => {
      setPetAnimState('idle')
      setPetAction('idle')
    }, 1500)
  }
  /** 播放退场动画 */
  const playExitAnim = async (): Promise<void> => {
    if (!petOn || petAnimState === 'exiting') return
    setPetAnimState('exiting')
    try {
      await import('./pet3d/scene').then(async () => {
        const scene = (window as any).__bd_pet_scene__
        if (scene && scene.playAnim) {
          await scene.playAnim('talk', 1.5) // 1.5 秒退场
        }
      })
    } catch (e) {
      console.warn('[app] 退场动画播放失败:', e)
    }
    setTimeout(() => {
      setPetAnimState('idle')
    }, 1500)
  }
  /** 总在最前（关闭后不再悬浮于其它窗口之上） */
  const toggleAlwaysTop = (on: boolean): void => {
    setAlwaysTop(on)
    window.api.setAlwaysOnTop(on)
    void window.api.setExtras({ 'ui:alwaysOnTop': on ? '1' : '0' })
  }
  /** 悬浮球是否显示用量环 */
  const togglePetRing = (on: boolean): void => {
    setPetRing(on)
    void window.api.setExtras({ 'ui:petRing': on ? '1' : '0' })
  }
  /** 语音播报开关 */
  const toggleVoiceOn = (on: boolean): void => {
    setVoiceOn(on)
    void window.api.setExtras({ 'ui:voiceOn': on ? '1' : '0' })
  }
  /** 语音播报间隔（分钟） */
  const setVoiceEveryInterval = (minutes: number): void => {
    setVoiceEvery(minutes)
    void window.api.setExtras({ 'ui:voiceEvery': String(minutes) })
  }

  /** 悬浮球右键菜单：原生菜单由主进程渲染，动作回到这里执行 */
  const petMenu = async (): Promise<string | null> => {
    const p = petRef.current
    const model: PetMenuModel = {
      title: `${p.name} · Lv.${p.level}`,
      status: `亲密度 ${Math.round(p.affection)} · 饱食度 ${Math.round(p.fullness)} · ${
        petMood(p) === 'hungry' ? '饿了' : petMood(p) === 'lonely' ? '有点孤单' : petMood(p) === 'happy' ? '心情很好' : '还好'
      }`,
      canPet: true,
      canFeed: p.fullness < 95,
      pets: PETS.map((x) => ({ id: x.id, name: x.name, checked: x.id === p.id })),
      ring: petRing,
      alwaysOnTop: alwaysTop,
      hideBalance
    }
    const picked = await window.api.petMenu(model)
    if (!picked) return null
    if (picked === 'pet') {
      petNow()
    } else if (picked === 'feed') {
      feedNow()
    } else if (picked.startsWith('pet:')) {
      const id = picked.slice(4)
      if (PETS.some((x) => x.id === id)) changePet(id as PetId)
    } else if (picked === 'toggle-top') {
      const next = !alwaysTop
      setAlwaysTop(next)
      window.api.setAlwaysOnTop(next)
      void window.api.setExtras({ 'ui:alwaysOnTop': next ? '1' : '0' })
    } else if (picked === 'toggle-ring') {
      const next = !petRing
      setPetRing(next)
      void window.api.setExtras({ 'ui:petRing': next ? '1' : '0' })
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
  const exportPet = async (): Promise<'ok' | 'cancel' | 'fail'> => {
    const r = await window.api.exportPet(buildPetExport(petRef.current))
    if (r.ok) return 'ok'
    return r.canceled ? 'cancel' : 'fail'
  }
  const importPet = async (): Promise<'ok' | 'cancel' | 'fail'> => {
    const r = await window.api.importPet()
    if (!r.ok) return r.canceled ? 'cancel' : 'fail'
    const st = decodePetState(r.text)
    if (!st) return 'fail'
    setPet(st)
    persistPet(st)
    return 'ok'
  }

  useEffect(() => {
    void window.api.getExtras(['ui:hideBalance', 'ui:pet', 'ui:petRing', 'ui:petState', 'ui:alwaysOnTop', 'ui:voiceOn', 'ui:voiceEvery']).then((e) => {
      setHideBalance(e['ui:hideBalance'] === '1')
      // 默认是 3D 悬浮球；只有用户显式开启（'1'）才是 3D 桌面宠物
      setPetOn(e['ui:pet'] === '1')
      setAlwaysTop(e['ui:alwaysOnTop'] !== '0')
      setPetRing(e['ui:petRing'] !== '0')
      setVoiceOn(e['ui:voiceOn'] === '1')
      const every = parseInt(e['ui:voiceEvery'] || '60', 10)
      // 支持档位：1/3/5/10/15/30/60 分钟
      if (every >= 1 && [1, 3, 5, 10, 15, 30, 60].includes(every)) {
        setVoiceEvery(every)
      }
      const st = decodePetState(e['ui:petState'])
      if (st) setPet(applyDecay(st, Date.now()))
    })
  }, [])

  // 收起态形态同步给主进程：球（默认，窗口贴合球体）↔ 桌面宠物（更大漫游区）
  useEffect(() => {
    window.api.setPetMode(petOn)
    // petOn 变化时触发动画
    if (petOn) {
      // 延迟一点播放进场动画，等场景初始化完成
      setTimeout(() => playEnterAnim(), 300)
    }
  }, [petOn])

  // 惰性衰减的 UI 侧结算（持久化只在互动时写盘，见 persistPet）
  useEffect(() => {
    const t = window.setInterval(() => setPet((p) => applyDecay(p, Date.now())), 30_000)
    return () => window.clearInterval(t)
  }, [])

  const toggleHideBalance = (): void => {
    const next = !hideBalance
    setHideBalance(next)
    void window.api.setExtras({ 'ui:hideBalance': next ? '1' : '' })
  }

  /** 动态 import 语音模块并朗读；失败只记一条日志，不影响界面 */
  const say = (text: string): void => {
    import('./voice')
      .then(({ speak }) => speak(text))
      .catch(() => console.warn('[voice] 无法导入 speak 函数'))
  }

  /** 播报焦点供应商：文案复用 shared/tray-text 的纯函数（与托盘同一口径，不再手写一份） */
  const speakBalance = (): void => {
    if (!voiceOn) return
    if (collapsed || view !== 'card') return // 展开面板时不播报
    // 从 ref 取最新状态（见 stateRef 的说明）
    const snapshot = stateRef.current.snapshots.find((s) => s.status === 'ok')
    if (!snapshot) return

    const name = snapshot.name || snapshot.id
    // 隐藏余额时不能把金额读出来（界面上是 ••••），只播用量；连用量都没有就如实说明
    if (hideBalance && !snapshot.windows.some((w) => w.percent != null)) {
      say(`${name}，余额已隐藏`)
      return
    }
    const summary = providerSummary(snapshot)
    if (!summary) return
    say(`${name}，${summary}${qualitySuffix(snapshot)}`)
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

    // 设置自重排定时器（依赖 voiceOn && voiceEvery）
    voiceTimerRef.current = window.setInterval(() => {
      speakBalance()
    }, voiceEvery * 60 * 1000)

    return () => {
      if (voiceTimerRef.current) {
        window.clearInterval(voiceTimerRef.current)
        voiceTimerRef.current = null
      }
    }
  }, [voiceOn, voiceEvery, collapsed, view])

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
            roam={petOn}
            hideBalance={hideBalance}
            action={petAction}
            actionSeq={actionSeq}
            onExpand={doExpand}
            onDragStart={(grab) => window.api.dragStart(grab)}
            onDragEnd={() => window.api.dragEnd()}
            onPet={petNow}
            onMenu={petMenu}
            onRename={renamePet}
            showRing={petRing}
          />
        ) : view === 'settings' ? (
          <SettingsView
            onBack={() => setView('card')}
            onDataChanged={() => void window.api.refreshNow()}
            pet={pet}
            petOn={petOn}
            onPet={petNow}
            onFeed={feedNow}
            onChangePet={changePet}
            onRenamePet={renamePet}
            onTogglePetBall={togglePetBall}
            onTogglePetRing={togglePetRing}
            petRing={petRing}
            voiceOn={voiceOn}
            voiceEvery={voiceEvery}
            onToggleVoiceOn={toggleVoiceOn}
            onSetVoiceEvery={setVoiceEveryInterval}
            alwaysTop={alwaysTop}
            onToggleAlwaysTop={toggleAlwaysTop}
            onExportPet={exportPet}
            onImportPet={importPet}
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
