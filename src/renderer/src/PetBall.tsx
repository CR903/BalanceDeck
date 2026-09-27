import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, ProviderSnapshot } from '../../shared/types'
import { type PetId, type PetState } from '../../shared/pet'
import { FIGURE_VIEW } from '../../shared/pet-view'
import { fmtAmount, fmtPercent, windowPercent, dataTime, isStale } from './format'
import { ballLevel, severityRank, worstWindow } from './read-model'
import { Icon } from './components'
import { createPet3dScene, type BallFrame, type Pet3dHandle } from './pet3d/scene'

// ═══════════════════════════════════════════════════════════════════════════════
// 收起态 = 3D 悬浮物，两种形态（见 shared/pet-view 与 pet3d/rig.ts 的 FORMS）
//
//   · 球形态（默认）：玻璃球 + 环形仪表 + 球心读数，窗口 200×210 贴合球体；
//   · 个性人物：**只有人物**独立站在窗口中央（无球壳、无用量环），窗口 320×440 竖版，
//     读数走窗口下方的胶囊。
//
// 共同点：鼠标穿透（主进程按 scene 上报的命中区轮询）、单击展开、拖动移动、右键菜单。
// 定位是**数字助理**：没有喂食/亲密度那套养成互动（2026-09-21 下线）。
//
// 设计依据见 DESIGN.md「收起态：3D 悬浮球 / 个性人物」。
// ═══════════════════════════════════════════════════════════════════════════════

export interface PetBallProps {
  pet: PetState
  /** 收起态是否为「个性人物」形态（关闭 = 默认的悬浮球，省显存/不加载角色素材） */
  figure: boolean
  onExpand: () => void
  onDragStart: (grab: { x: number; y: number }) => void
  onDragEnd: () => void
  /** 右键菜单：交给主进程弹原生菜单，返回被选中的 action */
  onMenu: () => Promise<string | null>
  onRename: (name: string) => void
  hideBalance: boolean
  /** 是否显示用量环（ui:petRing，右键菜单可关；球形态可见，人物形态本就没有环） */
  showRing?: boolean
}

export function PetBall({
  pet,
  figure,
  onExpand,
  onDragStart,
  onDragEnd,
  onMenu,
  onRename,
  hideBalance,
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
  /** 真人系语音泡泡（打招呼 / 余额播报，比 toast 大、停留更久，最多两行） */
  const [bubble, setBubble] = useState('')
  /** 测试观测点：命中环（--uitest / --shots 打开，用于核对球体投影与命中判定） */
  const debugRing = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('bddebug')
  const [ringBox, setRingBox] = useState({ x: 0, y: 0, w: 0, h: 0 })
  /** 命中区中心（DOM 覆盖层对准它；两种形态都由 scene 按投影给出） */
  const [center, setCenter] = useState({ x: 100, y: 105 })
  /** 命中区半宽/半高：覆盖层按它上下避开主体（球 = 半径，人物 = 半身高） */
  const [half, setHalf] = useState({ w: 90, h: 95 })
  /**
   * 窗口像素尺寸：胶囊锚点要按它夹在窗内 —— 人物形态下主体几乎占满窗口，
   * 覆盖层一律贴窗口边（不是贴主体）才不会溢出被 overflow 切掉。
   */
  const [viewSize, setViewSize] = useState({ w: FIGURE_VIEW.width, h: FIGURE_VIEW.height })
  /** 光标是否悬停在球上（主进程轮询回传）：悬停时停步，避免「抓不到」 */
  const [hover, setHover] = useState(false)
  const petRef = useRef(pet)
  petRef.current = pet
  const press = useRef({ down: false, moved: false, x: 0, y: 0 })
  const bubbleTimer = useRef<number | null>(null)

  useEffect(() => {
    void window.api.getState().then(setState)
    return window.api.onState(setState)
  }, [])

  useEffect(
    () => () => {
      if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current)
    },
    []
  )

  /** 真人系泡泡：4.2s 后自动消失；新泡泡顶掉旧泡泡 */
  const showBubble = (msg: string, ms = 4200): void => {
    setBubble(msg)
    if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current)
    bubbleTimer.current = window.setTimeout(() => setBubble(''), ms)
  }

  // ─── 3D 场景（挂载一次；换角色走 setPet，皮肤变化走 setSkin）────────────────
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // 形态决定机位与窗口（见 shared/pet-view 与 pet3d/rig.ts 的 FORMS）；球形态不加载角色素材
    let handle: Pet3dHandle | null = null
    try {
      handle = createPet3dScene(host, petRef.current.id, { form: figure ? 'figure' : 'ball' })
    } catch (e) {
      // WebGL 不可用（老显卡/驱动异常）→ 退回 2D 圆点，功能不丢
      setFailed(true)
      console.error('[pet3d] 初始化失败，退回 2D 圆点：', e)
      return
    }
    sceneRef.current = handle
    setReady(true)
    frameRef.current && handle.setFrame(frameRef.current)
    return () => {
      handle?.dispose()
      sceneRef.current = null
      setReady(false)
    }
    // 形态切换要换机位与窗口尺寸，直接重建场景最省心（换角色走 handle 的 setPet）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [figure])

  useEffect(() => {
    if (ready && frameRef.current) sceneRef.current?.setFrame(frameRef.current)
  }, [ready, hideBalance])

  // 角色切换：换人 + 自报家门（进场动作由场景在模型就位那一刻自己播，见 scene.ts）
  //
  // `figure` 必须进依赖数组并在函数体里守卫（2026-09-27 修）：
  // 球形态里没有人，原实现无条件 `showBubble('你好，我是…～')`，
  // 于是「未开启个性人物」时点一下球也会冒出人物打招呼的泡泡。
  // 放进依赖是有意的：球 → 人物形态切换时角色"到场"，自报家门合理。
  useEffect(() => {
    sceneRef.current?.setPet(pet.id)
    if (figure) showBubble(`你好，我是${pet.name}～`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pet.id, figure])

  // 皮肤：主进程推送时 App 会重挂 data-skin，等一帧让 CSS 变量生效再重读令牌
  useEffect(() => {
    const t = window.setTimeout(() => sceneRef.current?.setSkin(), 60)
    return () => window.clearTimeout(t)
  }, [pet.id, ready])

  // 测试钩子：让 --uitest / --shots 能读到真实像素范围与命中区
  useEffect(() => {
    // ⚠️ 返回值必须是「可结构化克隆」的纯数据：里面塞函数会让 executeJavaScript
    //    的结果无法回传（报 An object could not be cloned）。调试用的操作型钩子
    //    单独挂在 window.__bd_hide 上。
    const w = window as unknown as {
      __bd_ball?: () => unknown
      __bd_hide?: (i: number, on: boolean) => void
      __bd_gesture?: (id: string) => Promise<void>
    }
    w.__bd_ball = () => ({
      rect: sceneRef.current?.hitRect() ?? null,
      center: sceneRef.current?.hitCenter() ?? null,
      rootMotion: sceneRef.current?.rootMotion() ?? null,
      perf: sceneRef.current?.perf() ?? null,
      stride: sceneRef.current?.stride() ?? 0,
      gesture: sceneRef.current?.gesture() ?? null,
      pose: sceneRef.current?.pose() ?? null,
      travel: sceneRef.current?.travel() ?? null,
      clipParseMs: sceneRef.current?.clipParseMs() ?? 0,
      measure: sceneRef.current?.measure() ?? null,
      petReady: sceneRef.current?.petReady() ?? false,
      dump: sceneRef.current?.dump() ?? [],
      frame: frameRef.current
    })
    w.__bd_hide = (i, on) => sceneRef.current?.hideIndex(i, on)
    // 动作触发口（测试用）：--uitest 要能在收起态下驱动一次退场，核对"真的走出去了"
    w.__bd_gesture = (id) => sceneRef.current?.playGesture(id as never) ?? Promise.resolve()
    return () => {
      delete w.__bd_ball
      delete w.__bd_hide
      delete w.__bd_gesture
    }
  }, [ready])

  useEffect(() => {
    const el = document.querySelector('.app')
    if (!el) return
    const obs = new MutationObserver(() => sceneRef.current?.setSkin())
    obs.observe(el, { attributes: true, attributeFilter: ['data-skin'] })
    return () => obs.disconnect()
  }, [])

  // 鼠标停在主体上时通知场景（主进程轮询回传，用于 hover 反馈）
  useEffect(() => {
    return window.api.onPetCursor?.((over) => setHover(over)) ?? (() => {})
  }, [])

  // 点击穿透：把主体的屏幕矩形报给主进程（窗口里只有那一块接收鼠标）
  const reportHit = useCallback(() => {
    const handle = sceneRef.current
    if (!handle) {
      // 2D 圆点：窗口正中一个 60×60 的可点区域
      const w = hostRef.current?.clientWidth ?? FIGURE_VIEW.width
      const h = hostRef.current?.clientHeight ?? FIGURE_VIEW.height
      window.api.setPetHitbox({ x: w / 2 - 30, y: h / 2 - 30, width: 60, height: 60 })
      return
    }
    const r = handle.hitRect()
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
    // 命中区随视口（scene 的 ResizeObserver）变化 → 持续刷新（90ms 与主进程光标轮询同频）。
    // 同一个矩形同时喂给覆盖层锚点：中心 + 半宽/半高，一处口径。
    const t = window.setInterval(() => {
      reportHit()
      const h = sceneRef.current
      if (!h) return
      const r = h.hitRect()
      const c = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      setCenter((prev) => (Math.abs(prev.x - c.x) < 0.5 && Math.abs(prev.y - c.y) < 0.5 ? prev : c))
      setHalf((prev) =>
        Math.abs(prev.w - r.width / 2) < 0.5 && Math.abs(prev.h - r.height / 2) < 0.5
          ? prev
          : { w: r.width / 2, h: r.height / 2 }
      )
      const host = hostRef.current
      if (host) {
        const w = host.clientWidth
        const h = host.clientHeight
        setViewSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
      }
      if (debugRing) setRingBox({ x: r.x, y: r.y, w: r.width, h: r.height })
    }, 90)
    return () => window.clearInterval(t)
  }, [ready, figure, reportHit, debugRing])

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
   * 覆盖层锚点横向夹紧（R8）：主体可能投影到窗口两侧，而 .petball 是 overflow:hidden ——
   * 不夹的话贴边帧会被切成半截。
   * pad 取该元素 CSS 里保证的半宽上界（caption max-width 140 → 70；bubble max-width 190+padding → 106）。
   */
  const clampX = (x: number, pad: number): number => {
    const w = hostRef.current?.clientWidth ?? FIGURE_VIEW.width
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

  // 余额播报：每 90s 冒一次主指标泡泡（value 已含余额显隐与诚实口径）。
  // 数据变化会重置计时（新数据值得先播），球形态（没有人可以说话）即停。
  useEffect(() => {
    if (!figure || failed) return
    if (!s || s.status !== 'ok') return
    const stale = isStale(s) ? (s.dataQuality === 'cached' ? '（缓存）' : '（估算）') : ''
    const text = `${label} ${value}${stale}`
    const t = window.setTimeout(() => {
      showBubble(text)
      // 播报是"说话"的场合：让人物比划着讲（动作目录里的 talk，剪辑按需加载）
      void sceneRef.current?.playGesture?.('talk')?.catch?.(() => {})
    }, 90_000)
    return () => window.clearTimeout(t)
  }, [pet.id, figure, failed, s, value, label])

  // ─── 交互 ───────────────────────────────────────────────────────────────────
  /** 复位指针状态（含主进程拖拽）：菜单弹出、指针在窗口外抬起、窗口失焦时都要调用 */
  const resetPress = useCallback((endDrag = false): void => {
    const wasDown = press.current.down
    press.current = { down: false, moved: false, x: 0, y: 0 }
    if (endDrag && wasDown) onDragEnd()
  }, [onDragEnd])

  // 兜底：指针在窗口外抬起、窗口失焦、或指针取消时，按下状态必须复位，
  // 否则残留状态会让"移动鼠标 = 拖拽"，表现为主体黏着光标乱跑（只能再点一下才释放）
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


  const onPointerDown = (e: React.PointerEvent): void => {
    if (renaming) return
    // 只处理主键：右键会弹原生菜单，此时若还进入"按下"状态，
    // 菜单关闭后残留的按下标记会把随后的鼠标移动误判成拖拽（"黏住光标"乱跑）
    if (e.button !== 0) return
    press.current = { down: true, moved: false, x: e.clientX, y: e.clientY }
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
      // 抓取点 = 按下时鼠标在窗口内的位置：拖动时该点始终贴着光标，球不会跳到光标中心
      const rc = (e.currentTarget as HTMLElement).getBoundingClientRect()
      onDragStart({ x: press.current.x - rc.x, y: press.current.y - rc.y })
    }
  }

  const finish = (cancel = false): void => {
    if (!press.current.down) return
    const wasMoved = press.current.moved
    press.current = { down: false, moved: false, x: 0, y: 0 }
    if (wasMoved || cancel) onDragEnd()
    else if (!renaming) {
      // 点击 = 立即展开。挥手动画**不阻塞**：等 1.5s 动画播完再展开，既是体验问题
      // （点一下要等一秒半），也会让 UI 断言在 700ms 的等待窗口里读不到展开后的窗口。
      // 球形态没有人可挥（2026-09-27 修：原来无条件挥手），但**展开照常**。
      if (figure) {
        const scene = (window as any).__bd_pet_scene__
        void scene?.playGesture?.('wave')?.catch?.(() => {})
      }
      onExpand()
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
      } · 单击展开 · 拖动移动 · 右键菜单`
    : `单击展开 · 拖动移动 · 右键菜单`

  return (
    <div
      className={`petball lvl-${lvl}${hover ? ' hover' : ''}${failed ? ' no3d' : ''}`}
      data-pet={pet.id}
      data-figure={figure ? '1' : '0'}
    >
      <div className="petball-stage" ref={hostRef} />

      {/* 主体以外的窗口区域不接收鼠标：命中层只覆盖 scene 上报的那块投影范围 */}
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
      {/* 数值：球形态放回环心；人物形态环心被人物占着 → 只走下方胶囊 */}
      {!failed && !figure && (
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
          className={`petball-caption${figure ? '' : ' sub'}`}
          style={{
            left: clampX(center.x, 70),
            // 人物形态：优先贴在主体下方，但**夹在窗内**（窗口矮，按半身高推会溢出被切）
            top: figure
              ? Math.min(center.y + half.h + 20, viewSize.h - 26)
              : center.y + half.h + 18
          }}
          aria-hidden="true"
        >
          {figure && <span className={`petball-value${value.length > 5 ? ' small' : ''}`}>{value}</span>}
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

      {debugRing && ringBox.w > 0 && (
        <div
          className="petball-debugring"
          style={{
            left: ringBox.x,
            top: ringBox.y,
            width: ringBox.w,
            height: ringBox.h,
            // 球形态画圆核对投影，人物形态画方框核对包围盒
            borderRadius: figure ? 10 : '50%'
          }}
          aria-hidden="true"
        />
      )}
      {bubble && (
        // 锚点是泡泡底边（translate(-50%,-100%)）：主体上方留白有限，两行文案高 46px，
        // 所以上移量最多 4 再按高度兜底，否则第一行被窗口顶切掉（R8）
        <div
          className="petball-bubble"
          style={{ left: clampX(center.x, 95), top: Math.max(46, center.y - half.h - 4) }}
          aria-hidden="true"
        >
          {bubble}
        </div>
      )}
      {isStale(s ?? {}) && figure && !failed && (
        // 角标贴主体右上（人物形态落在肩侧、球形态落在球缘）
        <div
          className="petball-badge"
          style={{ left: clampX(center.x + half.w * 0.62, 8), top: center.y - half.h * 0.62 }}
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
            aria-label="助理名字"
          />
        </div>
      )}
    </div>
  )
}
