import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, ProviderSnapshot } from '../../shared/types'
import { petMood, type PetId, type PetState } from '../../shared/pet'
import { ROAM_VIEW } from '../../shared/pet-view'
import { fmtAmount, fmtPercent, windowPercent, dataTime, isStale } from './format'
import { ballLevel, severityRank, worstWindow } from './read-model'
import { Icon } from './components'
import { createPet3dScene, type BallFrame, type Pet3dHandle, type PetAction } from './pet3d/scene'

// ═══════════════════════════════════════════════════════════════════════════════
// 收起态 = 3D 桌面宠物（悬浮球）
//
// 收起后窗口变成一块漫游区（尺寸见 shared/pet-view，由 overlay.ts 决定），里面只有一个 WebGL 小球：
//   · 玻璃球壳 + 环形仪表（KPI）+ 球心的 3D 卡通角色（宠物）
//   · 角色在球内自主走动（walkers.ts 状态机），鼠标靠近时停下看着你
//   · 交互：单击展开面板、拖动移动、长按 0.62s 撸一把、右键菜单
//   · 球以外的窗口区域全部鼠标穿透（主进程轮询光标 + setIgnoreMouseEvents）
//
// 设计依据见 DESIGN.md「收起态：3D 桌面宠物」。
// ═══════════════════════════════════════════════════════════════════════════════

export interface PetBallProps {
  pet: PetState
  /** 是否作为 3D 桌面宠物（关闭 = 静止的 2D 圆点，省电/省显存） */
  roam: boolean
  onExpand: () => void
  onDragStart: (grab: { x: number; y: number }) => void
  onDragEnd: () => void
  /** 长按撸一把（冷却中返回 false，静默忽略） */
  onPet: () => { ok: boolean; levelUps: number }
  /** 右键菜单：交给主进程弹原生菜单，返回被选中的 action */
  onMenu: () => Promise<string | null>
  onRename: (name: string) => void
  hideBalance: boolean
  /** 由 App 触发的动作（设置页/菜单里点撸一把、喂食） */
  action: PetAction
  actionSeq: number
  /** 是否显示用量环（ui:petRing，右键菜单可关） */
  showRing?: boolean
}

export function PetBall({
  pet,
  roam,
  onExpand,
  onDragStart,
  onDragEnd,
  onPet,
  onMenu,
  onRename,
  hideBalance,
  action,
  actionSeq,
  showRing = true
}: PetBallProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const hitRef = useRef<HTMLDivElement | null>(null)
  const sceneRef = useRef<Pet3dHandle | null>(null)
  const frameRef = useRef<BallFrame | null>(null)
  const [state, setState] = useState<AppState>({ snapshots: [], lastSync: null, scanning: false })
  const [idx, setIdx] = useState(0)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [toast, setToast] = useState('')
  /** 真人系语音泡泡（打招呼 / 余额播报，比 toast 大、停留更久，最多两行） */
  const [bubble, setBubble] = useState('')
  /** 测试观测点：命中环（--uitest / --shots 打开，用于核对球体投影与命中判定） */
  const debugRing = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('bddebug')
  const [ringBox, setRingBox] = useState({ x: 0, y: 0, size: 0 })
  /** 球在窗口内的投影中心（DOM 遮罩对准球心；随宠物走动更新） */
  const [center, setCenter] = useState({ x: 160, y: 115 })
  const [ballR, setBallR] = useState(60)
  /** 光标是否悬停在球上（主进程轮询回传）：悬停时停步，避免「抓不到」 */
  const [hover, setHover] = useState(false)
  const petRef = useRef(pet)
  petRef.current = pet
  const press = useRef({ down: false, moved: false, x: 0, y: 0 })
  const longPressed = useRef(false)
  const holdTimer = useRef<number | null>(null)
  const petCoolUntil = useRef(0)
  const toastTimer = useRef<number | null>(null)
  const bubbleTimer = useRef<number | null>(null)

  useEffect(() => {
    void window.api.getState().then(setState)
    return window.api.onState(setState)
  }, [])

  useEffect(
    () => () => {
      if (holdTimer.current !== null) window.clearTimeout(holdTimer.current)
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
      if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current)
    },
    []
  )

  const showToast = (msg: string): void => {
    setToast(msg)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 1600)
  }

  /** 真人系泡泡：4.2s 后自动消失；新泡泡顶掉旧泡泡 */
  const showBubble = (msg: string, ms = 4200): void => {
    setBubble(msg)
    if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current)
    bubbleTimer.current = window.setTimeout(() => setBubble(''), ms)
  }

  // ─── 3D 场景（挂载一次；宠物切换走 setPet，皮肤变化走 setSkin）──────────────
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // 两种形态都要建场景：球形态不加载角色，宠物形态才放角色（见 setRoam / scene.ts）
    let handle: Pet3dHandle | null = null
    try {
      handle = createPet3dScene(host, petRef.current.id, { roam })
    } catch (e) {
      // WebGL 不可用（老显卡/驱动异常）→ 退回 2D 圆点，功能不丢
      setFailed(true)
      console.error('[pet3d] 初始化失败，退回 2D 圆点：', e)
      return
    }
    sceneRef.current = handle
    setReady(true)
    frameRef.current && handle.setFrame(frameRef.current)
    handle.setStats({ mood: petMood(petRef.current), affection: petRef.current.affection, fullness: petRef.current.fullness })
    return () => {
      handle?.dispose()
      sceneRef.current = null
      setReady(false)
    }
    // 形态切换需要重算相机构图与窗口尺寸，直接重建场景最省心（球/宠物切换走 handle 增量更新）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roam])

  useEffect(() => {
    if (ready && frameRef.current) sceneRef.current?.setFrame(frameRef.current)
  }, [ready, hideBalance])

  // 宠物切换 / 动作 / 心情
  useEffect(() => {
    sceneRef.current?.setPet(pet.id)
    // 见面打招呼：挥手（场景播 wave）+ 自报家门（泡泡）
    sceneRef.current?.setAction('happy', 1700)
    showBubble(`你好，我是${pet.name}～`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pet.id])

  useEffect(() => {
    sceneRef.current?.setStats({
      mood: petMood(pet),
      affection: pet.affection,
      fullness: pet.fullness
    })
  }, [pet.affection, pet.fullness, pet.level, pet.id, pet.name])

  useEffect(() => {
    if (!actionSeq) return
    sceneRef.current?.setAction(action, action === 'happy' ? 1700 : action === 'eat' ? 2200 : 9000)
  }, [actionSeq, action])

  // 皮肤：主进程推送时 App 会重挂 data-skin，等一帧让 CSS 变量生效再重读令牌
  useEffect(() => {
    const t = window.setTimeout(() => sceneRef.current?.setSkin(), 60)
    return () => window.clearTimeout(t)
  }, [pet.id, ready])

  // 测试钩子：让 --uitest / --shots 能读到球的真实像素范围与命中框
  useEffect(() => {
    // ⚠️ 返回值必须是「可结构化克隆」的纯数据：里面塞函数会让 executeJavaScript
    //    的结果无法回传（报 An object could not be cloned）。调试用的操作型钩子
    //    单独挂在 window.__bd_hide 上。
    const w = window as unknown as {
      __bd_ball?: () => unknown
      __bd_hide?: (i: number, on: boolean) => void
      __bd_pin?: (x: number, z: number) => void
    }
    w.__bd_ball = () => ({
      rect: sceneRef.current?.ballRect() ?? null,
      center: sceneRef.current?.ballCenter() ?? null,
      roamArea: sceneRef.current?.roamArea() ?? null,
      walker: sceneRef.current?.walkerPos() ?? null,
      rootMotion: sceneRef.current?.rootMotion() ?? null,
      measure: sceneRef.current?.measure() ?? null,
      petReady: sceneRef.current?.petReady() ?? false,
      dump: sceneRef.current?.dump() ?? [],
      frame: frameRef.current
    })
    w.__bd_hide = (i, on) => sceneRef.current?.hideIndex(i, on)
    w.__bd_pin = (x, z) => sceneRef.current?.setPin(x, z)
    return () => {
      delete w.__bd_ball
      delete w.__bd_hide
      delete w.__bd_pin
    }
  }, [ready])

  useEffect(() => {
    const el = document.querySelector('.app')
    if (!el) return
    const obs = new MutationObserver(() => sceneRef.current?.setSkin())
    obs.observe(el, { attributes: true, attributeFilter: ['data-skin'] })
    return () => obs.disconnect()
  }, [])

  // 鼠标在球上时停步（主进程轮询回传）
  useEffect(() => {
    return window.api.onPetCursor?.((over) => setHover(over)) ?? (() => {})
  }, [])

  // 点击穿透：把球的屏幕矩形报给主进程（漫游区里只有球那块区域接收鼠标）
  const reportHit = useCallback(() => {
    const handle = sceneRef.current
    if (!handle) {
      // 2D 圆点：窗口正中一个 60×60 的可点区域
      const w = hostRef.current?.clientWidth ?? ROAM_VIEW.width
      const h = hostRef.current?.clientHeight ?? ROAM_VIEW.height
      window.api.setPetHitbox({ x: w / 2 - 30, y: h / 2 - 30, width: 60, height: 60 })
      return
    }
    const r = handle.ballRect()
    const pad = 6
    window.api.setPetHitbox({
      x: r.x - pad,
      y: r.y - pad,
      width: r.width + pad * 2,
      height: r.height + pad * 2
    })
  }, [])

  useEffect(() => {
    reportHit()
    // 球在漫游区内会移动 → 命中框需要持续刷新（90ms 与主进程光标轮询同频）
    const t = window.setInterval(() => {
      reportHit()
      const h = sceneRef.current
      if (!h) return
      const c = h.ballCenter()
      setCenter((prev) => (Math.abs(prev.x - c.x) < 0.5 && Math.abs(prev.y - c.y) < 0.5 ? prev : c))
      setBallR((prev) => (Math.abs(prev - h.ballRect().width / 2) < 0.5 ? prev : h.ballRect().width / 2))
      if (debugRing) {
        const r = h.ballRect()
        setRingBox({ x: r.x + r.width / 2, y: r.y + r.height / 2, size: r.width })
      }
    }, 90)
    return () => window.clearInterval(t)
  }, [ready, roam, reportHit, debugRing])

  // ─── 轮播 ───────────────────────────────────────────────────────────────────
  const snaps = useMemo(() => [...state.snapshots].sort((a, b) => severityRank(a) - severityRank(b)), [state.snapshots])
  const count = snaps.length
  useEffect(() => {
    if (count <= 1) return
    const t = window.setInterval(() => setIdx((i) => (i + 1) % count), 6000)
    return () => window.clearInterval(t)
  }, [count])

  const s: ProviderSnapshot | undefined = count ? snaps[idx % count] : undefined

  /** 主指标：最接近限额的窗口（选择规则归 read-model，三处视图同一份） */
  const worst = useMemo(() => worstWindow(s), [s])

  const pct = worst ? windowPercent(worst) : null
  const lvl = ballLevel(s, worst)

  const value = useMemo(() => {
    if (!s) return '…'
    if (s.status === 'error') return '!'
    if (s.status === 'nodata') return '—'
    if (pct != null) return fmtPercent(pct)
    if (worst) return hideBalance && s.kind === 'balance' ? '••••' : fmtAmount(worst.used, worst.unit, { compact: true })
    return '—'
  }, [s, pct, worst, hideBalance])

  const label = s?.name ?? ''

  /**
   * 覆盖层锚点横向夹紧（R8）：球会走到漫游区两侧（反算出的 ±halfX 在 320px 窗口里约 ±110px），
   * 而 .petball 是 overflow:hidden —— 不夹的话贴边帧会被切成半截。
   * pad 取该元素 CSS 里保证的半宽上界（caption max-width 140 → 70；bubble max-width 190+padding → 106）。
   */
  const clampX = (x: number, pad: number): number => {
    const w = hostRef.current?.clientWidth ?? ROAM_VIEW.width
    return Math.min(Math.max(x, pad), w - pad)
  }

  useEffect(() => {
    const frame: BallFrame = {
      percent: pct,
      level: lvl,
      value,
      label,
      pager: count > 1 ? { count: Math.min(count, 6), index: idx % count } : null,
      showRing
    }
    frameRef.current = frame
    sceneRef.current?.setFrame(frame)
    // 球的投影位置与数据无关，尺寸变化由 ResizeObserver/轮询兜底
  }, [pct, lvl, value, label, count, idx, s, showRing])

  useEffect(() => {
    sceneRef.current?.setPaused(renaming)
  }, [renaming])

  // 真人系余额播报：每 90s 冒一次主指标泡泡（value 已含余额显隐与诚实口径）。
  // 数据变化会重置计时（新数据值得先播），切走真人系即停。
  useEffect(() => {
    if (!roam || failed) return
    if (!s || s.status !== 'ok') return
    const stale = isStale(s) ? (s.dataQuality === 'cached' ? '（缓存）' : '（估算）') : ''
    const text = `${label} ${value}${stale}`
    const t = window.setTimeout(() => showBubble(text), 90_000)
    return () => window.clearTimeout(t)
  }, [pet.id, roam, failed, s, value, label])

  // ─── 交互 ───────────────────────────────────────────────────────────────────
  const clearHold = (): void => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
  }

  /** 复位指针状态（含主进程拖拽）：菜单弹出、指针在窗口外抬起、窗口失焦时都要调用 */
  const resetPress = useCallback((endDrag = false): void => {
    const wasDown = press.current.down
    press.current = { down: false, moved: false, x: 0, y: 0 }
    longPressed.current = false
    clearHold()
    if (endDrag && wasDown) onDragEnd()
  }, [onDragEnd])

  // 兜底：指针在窗口外抬起、窗口失焦、或指针取消时，按下状态必须复位，
  // 否则残留状态会让"移动鼠标 = 拖拽"，表现为宠物黏着光标乱跑（只能再点一下才释放）
  useEffect(() => {
    const onGlobalUp = (): void => resetPress(true)
    const onBlur = (): void => resetPress(true)
    window.addEventListener('pointerup', onGlobalUp)
    window.addEventListener('pointercancel', onGlobalUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerup', onGlobalUp)
      window.removeEventListener('pointercancel', onGlobalUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [resetPress])


  /** 长按 0.62s：撸一把（冷却中静默忽略，不打扰用户） */
  const petNow = (): void => {
    const now = performance.now()
    if (now < petCoolUntil.current) {
      showToast('让我缓一下…')
      return
    }
    petCoolUntil.current = now + 5000
    const r = onPet()
    // 长按 = 挥手回应（wave 由父级 action 驱动），配泡泡不配 toast
    if (r.levelUps > 0) showBubble(`升级！Lv.${petRef.current.level + r.levelUps}`)
    else showBubble('好舒服～')
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (renaming) return
    // 只处理主键：右键会弹原生菜单，此时若还进入"按下"状态，
    // 菜单关闭后残留的按下标记会把随后的鼠标移动误判成拖拽（宠物"黏住光标"乱跑）
    if (e.button !== 0) return
    press.current = { down: true, moved: false, x: e.clientX, y: e.clientY }
    longPressed.current = false
    clearHold()
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null
      longPressed.current = true
      petNow()
    }, 620)
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      // 合成事件/无效 pointerId：忽略
    }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!press.current.down || press.current.moved) return
    // buttons 里没有主键 = 按下状态已经失效（指针抬起丢失/菜单抢走了事件序列）→ 复位，不起拖拽
    if ((e.buttons & 1) === 0) {
      resetPress()
      return
    }
    if (Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 8) {
      press.current.moved = true
      clearHold()
      // 抓取点 = 按下时鼠标在窗口内的位置：拖动时该点始终贴着光标，球不会跳到光标中心
      const rc = (e.currentTarget as HTMLElement).getBoundingClientRect()
      onDragStart({ x: press.current.x - rc.x, y: press.current.y - rc.y })
    }
  }

  const finish = (cancel = false): void => {
    if (!press.current.down) return
    const wasMoved = press.current.moved
    const wasLong = longPressed.current
    press.current = { down: false, moved: false, x: 0, y: 0 }
    longPressed.current = false
    clearHold()
    if (wasMoved || cancel) onDragEnd()
    else if (!wasLong && !renaming) {
      // 点击展开时触发动画（如果当前是 idle 状态）
      const scene = (window as any).__bd_pet_scene__
      if (scene && scene.playAnim) {
        // 先播放 wave 进场动画，然后展开
        scene.playAnim('wave', 1.5).then(() => {
          onExpand()
        })
      } else {
        onExpand()
      }
    }
  }

  const openMenu = async (e: React.MouseEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    if (renaming) return
    // 右键也要把按下状态清干净：原生菜单会抢走后续的 pointerup
    resetPress(true)
    sceneRef.current?.setPaused(true)
    const picked = await onMenu()
    resetPress(true)
    sceneRef.current?.setPaused(false)
    if (picked === 'rename') {
      setNameDraft(pet.name)
      setRenaming(true)
    }
  }

  const commitRename = (): void => {
    const name = nameDraft.trim()
    if (name) onRename(name)
    setRenaming(false)
  }

  const tooltip = s
    ? `${s.name}${pct != null ? ` · ${fmtPercent(pct)}` : ''}${
        isStale(s)
          ? `（${s.dataQuality === 'cached' ? '缓存数据 · ' + (dataTime(s) ? new Date(dataTime(s)!).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '') : '本机估算'}）`
          : ''
      } · 单击展开 · 拖动移动 · 长按撸一把 · 右键菜单`
    : `单击展开 · 拖动移动 · 长按撸一把 · 右键菜单`

  return (
    <div
      className={`petball lvl-${lvl}${hover ? ' hover' : ''}${failed ? ' no3d' : ''}`}
      data-pet={pet.id}
      data-roam={roam ? '1' : '0'}
    >
      <div className="petball-stage" ref={hostRef} />

      {/* 球以外的窗口区域不接收鼠标：命中层只覆盖球的投影范围 */}
      <div
        className="petball-hit"
        ref={hitRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => {
          try {
            ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
          } catch {
            // 忽略
          }
          finish()
        }}
        onPointerCancel={() => finish(true)}
        onContextMenu={(e) => void openMenu(e)}
        title={tooltip}
        role="button"
        tabIndex={-1}
      />

      {failed && (
        // 兜底：WebGL 不可用时退回 2D 圆点（功能不丢，只是没有 3D）
        <div className="petball-fallback">
          <svg viewBox="0 0 56 56" aria-hidden="true">
            <circle className="dot-ring-track" cx="28" cy="28" r="22" fill="none" strokeWidth="5" />
            {pct != null && (
              <circle
                className="dot-ring-fill"
                cx="28"
                cy="28"
                r="22"
                fill="none"
                strokeWidth="5"
                strokeLinecap="round"
                strokeDasharray={`${(2 * Math.PI * 22 * Math.min(100, Math.max(0, pct))) / 100} ${2 * Math.PI * 22}`}
                transform="rotate(-90 28 28)"
              />
            )}
          </svg>
          <span className={`dot-value${value.length > 4 ? ' small' : ''}`}>{value}</span>
        </div>
      )}

      {/* 球心数值（DOM 而非 WebGL 文字：透明窗口下更清晰，且随皮肤换色） */}
      {/* 数值：球形态放回环心（宠物形态环心被角色占用 → 移到球下方胶囊） */}
      {!failed && !roam && (
        <div
          className={`petball-center-value${value.length > 5 ? ' small' : ''}`}
          style={{ left: center.x, top: center.y }}
          aria-hidden="true"
        >
          {value}
        </div>
      )}
      {!failed && (
        <div
          className={`petball-caption${roam ? '' : ' sub'}`}
          style={{ left: clampX(center.x, 70), top: center.y + ballR + (roam ? 22 : 18) }}
          aria-hidden="true"
        >
          {roam && <span className={`petball-value${value.length > 5 ? ' small' : ''}`}>{value}</span>}
          {label && <span className="petball-label">{label}</span>}
          {count > 1 && (
            <span className="petball-dots">
              {snaps.slice(0, 6).map((_, i) => (
                <i key={i} className={i === idx % count ? 'on' : ''} />
              ))}
            </span>
          )}
        </div>
      )}

      {debugRing && ringBox.size > 0 && (
        <div
          className="petball-debugring"
          style={{ left: ringBox.x, top: ringBox.y, width: ringBox.size, height: ringBox.size }}
          aria-hidden="true"
        />
      )}
      {toast && <div className="petball-toast">{toast}</div>}
      {bubble && (
        // 锚点是泡泡底边（translate(-50%,-100%)）：球上方只剩 ~50px，两行文案高 46px，
        // 所以上移量最多 4 再按高度兜底，否则第一行被窗口顶切掉（R8）
        <div
          className="petball-bubble"
          style={{ left: clampX(center.x, 95), top: Math.max(46, center.y - ballR - 4) }}
          aria-hidden="true"
        >
          {bubble}
        </div>
      )}
      {isStale(s ?? {}) && roam && !failed && (
        <div
          className="petball-badge"
          style={{ left: clampX(center.x + ballR * 0.6, 8), top: center.y - ballR * 0.6 }}
          aria-hidden="true"
        >
          <Icon name={s?.dataQuality === 'local' ? 'flask' : 'history'} size={9} />
        </div>
      )}

      {renaming && (
        <div className="petball-rename">
          <input
            autoFocus
            value={nameDraft}
            maxLength={12}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setRenaming(false)
            }}
            onBlur={commitRename}
            aria-label="宠物名字"
          />
        </div>
      )}
    </div>
  )
}
