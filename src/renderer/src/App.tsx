import { Component, useEffect, useRef, useState } from 'react'
import type { AppState } from '../../shared/types'
import { CardView } from './CardView'
import { DetailView } from './DetailView'
import { SettingsView } from './SettingsView'
import { CollapsedDot } from './CollapsedDot'
import { renderTrayIcon } from './ProviderMark'
import type { PetAction } from './PetSprites'
import type { PetActionResult } from './PetCard'
import {
  applyDecay,
  buildPetExport,
  decodePetState,
  defaultPetState,
  encodePetState,
  feedOnce,
  petMeta,
  petOnce,
  type PetId,
  type PetState
} from '../../shared/pet'

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

  // ─── 宠物精灵（状态由 App 统一持有：面板与收起态圆点共用同一份成长数据）──
  const [pet, setPet] = useState<PetState>(() => defaultPetState())
  const petRef = useRef(pet)
  petRef.current = pet
  /** 圆点是否显示宠物（ui:pet） */
  const [petOn, setPetOn] = useState(false)
  /** 面板宠物卡片是否收起（ui:petCard） */
  const [petCollapsed, setPetCollapsed] = useState(false)
  /** 当前播放的宠物动作（happy/eat），播完自动回 idle */
  const [petAction, setPetAction] = useState<PetAction>('idle')
  const actionTimer = useRef<number | null>(null)

  const playPetAction = (a: PetAction): void => {
    setPetAction(a)
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
    setPet(s)
    persistPet(s)
  }
  const renamePet = (name: string): void => {
    const s = { ...petRef.current, name }
    setPet(s)
    persistPet(s)
  }
  const togglePetDot = (on: boolean): void => {
    setPetOn(on)
    void window.api.setExtras({ 'ui:pet': on ? '1' : '' })
  }
  const togglePetCard = (): void => {
    const next = !petCollapsed
    setPetCollapsed(next)
    void window.api.setExtras({ 'ui:petCard': next ? '0' : '1' })
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
    void window.api.getExtras(['ui:hideBalance', 'ui:pet', 'ui:petState', 'ui:petCard']).then((e) => {
      setHideBalance(e['ui:hideBalance'] === '1')
      setPetOn(e['ui:pet'] === '1')
      setPetCollapsed(e['ui:petCard'] === '0')
      const st = decodePetState(e['ui:petState'])
      if (st) setPet(applyDecay(st, Date.now()))
    })
  }, [])

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
    const off4 = window.api.onSettingsChanged?.(() => setView('settings')) ?? (() => {})
    return () => {
      off1()
      off2()
      off3()
      off4()
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
          <CollapsedDot
            onExpand={doExpand}
            hideBalance={hideBalance}
            pet={pet}
            petOn={petOn}
            onPet={petNow}
          />
        ) : view === 'settings' ? (
          <SettingsView onBack={() => setView('card')} onDataChanged={() => void window.api.refreshNow()} />
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
            pet={pet}
            petOn={petOn}
            petAction={petAction}
            petCollapsed={petCollapsed}
            onPet={petNow}
            onFeed={feedNow}
            onChangePet={changePet}
            onRenamePet={renamePet}
            onTogglePetDot={togglePetDot}
            onTogglePetCard={togglePetCard}
            onExportPet={exportPet}
            onImportPet={importPet}
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
