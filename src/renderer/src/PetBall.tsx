import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, ProviderSnapshot } from '../../shared/types'
import { type PetId, type PetState } from '../../shared/pet'
import { BALL_VIEW, FIGURE_VIEW } from '../../shared/pet-view'
import { fmtAmount, fmtPercent, windowPercent, dataTime, isStale } from './format'
import { ballLevel, severityRank, worstWindow } from './read-model'
import { Icon } from './components'
import { createPet3dScene, type Pet3dHandle } from './pet3d/scene'

// ═══════════════════════════════════════════════════════════════════════════════
// 收起态，两种形态（尺寸见 shared/pet-view）：
//
//   · 球形态（默认）：**2D 小圆环** —— 56×56 窗口、SVG 环、环心一个数；
//     纯 DOM，不建 3D 场景、不占显存、不加载任何角色素材（首版设计，`d5a028e`）。
//   · 个性人物：three.js 场景，**只有人物**独立站在 213×293 竖版窗口中央
//     （无球壳、无用量环），读数走窗口下方的胶囊。
//
// 共同点：鼠标穿透（主进程按渲染层上报的命中区轮询）、单击展开、拖动移动、右键菜单。
// 定位是**数字助理**：没有喂食/亲密度那套养成互动（2026-09-21 下线）。
//
// 设计依据见 DESIGN.md「收起态」。
// ═══════════════════════════════════════════════════════════════════════════════

export interface PetBallProps {
  pet: PetState
  /** 收起态是否为「个性人物」形态（关闭 = 默认的 2D 小圆环，省显存/不加载角色素材） */
  figure: boolean
  onExpand: () => void
  onDragStart: (grab: { x: number; y: number }) => void
  onDragEnd: () => void
  /** 右键菜单：交给主进程弹原生菜单，返回被选中的 action */
  onMenu: () => Promise<string | null>
  onRename: (name: string) => void
  hideBalance: boolean
  /** 是否显示用量环（ui:petRing，右键菜单可关）：球形态控制 2D 环的填充弧，人物形态本就没有环 */
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
  /** 2D 小圆环本体：命中区按它的实测方块上报（球形态它就是整块窗口） */
  const fallbackRef = useRef<HTMLDivElement | null>(null)
  const sceneRef = useRef<Pet3dHandle | null>(null)
  const [state, setState] = useState<AppState>({ snapshots: [], lastSync: null, scanning: false })
  const [idx, setIdx] = useState(0)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  /** 真人系语音泡泡（打招呼 / 余额播报，比 toast 大、停留更久，最多两行） */
  const [bubble, setBubble] = useState('')
  /** 测试观测点：命中环（--uitest / --shots 打开，用于核对人物投影与命中判定；球形态无投影） */
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

  // ─── 3D 场景（仅个性人物形态；挂载一次，换角色走 setPet，皮肤变化走 setSkin）────
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // 球形态**不建场景**。不是「建一个空场景」：createPet3dScene 在 scene.ts:151 无条件
    // `new THREE.WebGLRenderer`，省显存是这一版的硬要求（2026-09-27 用户原话：默认状态下
    // 桌面只有一个安静的小环，不占显存、不加载任何 3D 资源）。所以由调用方跳过构造，
    // 而不是给场景加一个「什么都不渲染」的形态 —— 后者照样占着 GPU 上下文。
    if (!figure) return
    let handle: Pet3dHandle | null = null
    try {
      handle = createPet3dScene(host, petRef.current.id)
    } catch (e) {
      // WebGL 不可用（老显卡/驱动异常）→ 退回 2D 小圆环，功能不丢
      setFailed(true)
      console.error('[pet3d] 初始化失败，退回 2D 小圆环：', e)
      return
    }
    sceneRef.current = handle
    setReady(true)
    // 上一轮失败留下的 failed 必须复位，否则「人物→球→人物」再来一次时，
    // 即便这次 WebGL 正常，也会被上一次的 failed 钉在 2D 兜底上（人物形态看得见人，
    // 但走的是 2D 环）。failed 只在 catch 里置 true，不复位就是单向棘轮。
    setFailed(false)
    return () => {
      handle?.dispose()
      sceneRef.current = null
      setReady(false)
    }
    // 形态切换要换窗口尺寸，直接重建场景最省心（换角色走 handle 的 setPet）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [figure])

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
      dump: sceneRef.current?.dump() ?? []
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
      // 无 3D 场景时按 **2D 小圆环的实测方块** 上报，不写死尺寸：
      //   · 球形态恒走这里，窗口 56×56 本身就是那个环 → 整块窗口可点（主进程再外扩 pad=3）
      //   · 人物形态只在这里出现（WebGL 初始化失败），窗口 213×293、环仍是 56×56，
      //     所以必须按它在窗口里的**居中位置**算，不能拿整块窗口去撑成一个 213×293 的热点。
      // 旧实现一律回退到「居中 60×60 + FIGURE_VIEW 兜底值」，两个尺寸都写错了。
      const el = fallbackRef.current
      const hw = hostRef.current?.clientWidth || BALL_VIEW.width
      const hh = hostRef.current?.clientHeight || BALL_VIEW.height
      const w = el?.clientWidth || BALL_VIEW.width
      const h = el?.clientHeight || BALL_VIEW.height
      window.api.setPetHitbox({ x: (hw - w) / 2, y: (hh - h) / 2, width: w, height: h })
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

  /**
   * 2D 小圆环的呈现条件（三种情形，缺一不可）：
   *   · 球形态：恒为真 —— 它本来就是 2D（这一版没有 3D 球）
   *   · 人物形态 + WebGL 初始化失败：`failed` 兜底，老显卡/驱动异常时仍要有可用界面
   * 这一条不能因为「球形态已经是 2D 了」顺手删掉：它服务的是**人物形态的失败路径**。
   */
  const dot2d = !figure || failed

  return (
    <div
      className={`petball lvl-${lvl}${hover ? ' hover' : ''}${dot2d ? ' no3d' : ''}`}
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

      {dot2d && (
        // 2D 小圆环：球形态的**正常**呈现（不建 3D），也是人物形态 WebGL 失败时的兜底。
        // 这段 JSX 就是首版（`d5a028e` 的 CollapsedDot）的那份，逻辑早已在 PetBall 里
        // 重写过一遍（严重度排序 / 轮播 / 8px 拖拽 / tooltip），搬回旧组件会多出一份状态来源。
        <div className="petball-fallback" ref={fallbackRef}>
          <svg viewBox="0 0 56 56" aria-hidden="true">
            <circle className="dot-ring-track" cx="28" cy="28" r="22" fill="none" strokeWidth="5" />
            {/* 填充弧由「显示用量环」（ui:petRing）控制：关掉只剩素圆盘 + 数字。
                没有这一条，右键菜单那个开关在球形态下就成了点了没反应的死开关。 */}
            {showRing && pct != null && (
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

      {/* 下方胶囊（供应商名 + 轮播点）只在人物形态出现：球形态的窗口只有 56×56，
          胶囊最宽 140px 会被 .petball 的 overflow:hidden 切掉；它的读数位就是上面的环心数字。 */}
      {figure && !failed && (
        <div
          className="petball-caption"
          style={{
            left: clampX(center.x, 70),
            // 优先贴在主体下方，但**夹在窗内**（窗口矮，按半身高推会溢出被切）
            top: Math.min(center.y + half.h + 20, viewSize.h - 26)
          }}
          aria-hidden="true"
        >
          <span className={`petball-value${value.length > 5 ? ' small' : ''}`}>{value}</span>
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
            // 只可能是人物形态：ringBox 由 3D 场景的 hitRect 填，球形态没有场景，w 恒为 0
            borderRadius: 10
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
      {isStale(s ?? {}) && !failed && (
        // 可信度角标。**球形态也要有**（2026-09-27 复核补上）：ballLevel() 只看 status、
        // 不看 dataQuality，所以缓存/本机估算的数字在小环上是和权威数据一模一样的绿/琥珀色，
        // 看上去就是实时值。tooltip 里虽然写了「（缓存数据 · 14:03）」，可那要悬停才看得到 ——
        // 而「数字在骗人」正是最该一眼看出的场景。角标只在该出现时出现，不是装饰。
        <div
          className="petball-badge"
          // 人物形态贴右上肩侧。球形态窗口只有 56×56：环的 stroke 外缘在 r=24.5（圆心 28,28），
          // 空角沿 45° 对角线到盒角（距圆心 39.6）只有 15.1px，15px 的角标必然压弧或被
          // overflow:hidden 裁掉（实测 15px 落在 (37,5)-(52,20)，最近角距圆心仅 12.0）。
          // 所以球形态缩到 10px。注意是**正方形**：离圆心最近的是角不是边中点，半对角线
          // 5√2≈7.07，所以圆心要放到 24.5+7.07=31.57 才真正内切。百分比坐标跟着 viewBox 走。
          style={
            figure
              ? { left: clampX(center.x + half.w * 0.62, 8), top: center.y - half.h * 0.62 }
              : { left: '89.9%', top: '10.1%' }
          }
          aria-hidden="true"
        >
          <Icon name={s?.dataQuality === 'local' ? 'flask' : 'history'} size={figure ? 9 : 7} />
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
