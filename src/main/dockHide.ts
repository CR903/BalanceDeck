// ═══════════════════════════════════════════════════════════════════════════════
// 悬浮球贴边自动隐藏：主进程状态机（计时器 + 动画步进）。
//
// 为什么是注入依赖而不是直接调 electron：overlay.ts 里的窗口/屏幕 API 在纯 node 里
// 不存在，而隐藏/唤出/取消的时序必须有单测盯着（scripts/test-dock-hide.mjs 经 loadTs
// 直接加载本模块）。electron 的部分（getBounds / setPosition / workArea / 持久化）
// 由 overlay.ts 在 bind 时注入，本模块只做决策与计时。
//
// 状态机（design.md）：
//   idle --(dragStop贴边 + 1000ms)--> hiding --(动画)--> hidden
//   hidden --(痕迹停留300ms / 点击)--> revealing --(动画)--> edge-visible
//   edge-visible --(离开球1500ms)--> hiding（重藏跳过1000ms，直接走隐藏动画）
//   any --(dragStart / 展开 / 显示器变化 / 开关关闭)--> idle（取消计时与动画并复位）
//
// 同一时刻最多一把计时器存活；动画期间拖拽计时器不启动（overlay 侧保证：dragStart
// 先调 onDragStart 取消动画，再读 bounds 起自己的计时器）。
// ═══════════════════════════════════════════════════════════════════════════════

import {
  HIDE_DWELL_MS,
  REHIDE_MS,
  REVEAL_DWELL_MS,
  detectEdge,
  hiddenBounds,
  peekHitbox,
  type DockEdge,
  type Rect,
  type WorkArea
} from '../shared/dock-hide'
import { ABSORB_TOTAL_MS, REVEAL_MS, fluidForPhase, type FluidPhase } from '../shared/fluid'

export type DockPhase = 'idle' | 'dwell-hide' | 'hiding' | 'hidden' | 'dwell-reveal' | 'revealing' | 'edge-visible' | 'dwell-rehide'

export interface DockPersisted {
  edge: DockEdge | null
  hidden: boolean
}

export interface DockHideDeps {
  /** 当前窗口 bounds（DIP） */
  getBounds: () => Rect
  /** 移动窗口（动画逐帧调它；overlay 侧已有 NaN 守卫模式） */
  setPosition: (x: number, y: number) => void
  /** 当前显示器的 workArea（贴边基准，与夹取同口径） */
  getWorkArea: () => WorkArea
  /** 是否允许隐藏：收起态 && 球形态 && 开关开（三者缺一即不参与） */
  isActive: () => boolean
  /** prefers-reduced-motion：命中则跳动画、留计时（PRD R5） */
  reducedMotion: () => boolean
  /** 隐藏态命中区覆盖：传 null = 恢复采信渲染层上报 */
  setPeekOverride: (rect: Rect | null) => void
  /** 隐藏态变化：主进程据此决定命中覆盖与渲染层通知（dock:hidden 通道） */
  onHiddenChange: (hidden: boolean) => void
  /** 持久化 dock 字段（overlay 侧写进 state.json） */
  onPersist: (dock: DockPersisted) => void
  /**
   * 流体相位推送（dock:fluid 通道）：渲染层只切 CSS 类、不算几何。
   * 可选依赖（单测不传也行）；映射唯一口径在 shared/fluid.fluidForPhase。
   */
  onFluidPhase?: (phase: FluidPhase, edge: DockEdge | null) => void
  /** 计时压缩（测试用）：BD_DOCK_FAST=1 时三把计时器压到 50ms，动画 1 帧 */
  fast?: () => boolean
}

function ms(base: number, fast: boolean): number {
  return fast ? Math.min(base, 50) : base
}

export function createDockHide(deps: DockHideDeps): {
  phase: () => DockPhase
  edge: () => DockEdge | null
  hidden: () => boolean
  /** dragStop 收回后调：贴边则起隐藏计时（R1） */
  onDragStop: () => void
  /** dragStart 头调：取消一切并复位到贴边全可见（与拖拽计时器互斥） */
  onDragStart: () => void
  /** 光标命中翻转时调（tickCursorWatch 的 over 变化）：驱动唤出/重藏/取消 */
  onCursor: (over: boolean) => void
  /** 痕迹点击（无 hover 设备）：直接滑出（R3） */
  onTapPeek: () => void
  /** 展开 / 开关关闭 / 收起态变化时调：取消一切并回到全可见 */
  resetToVisible: () => void
  /** 显示器变化时调：取消计时与动画，按当前 workArea 重算隐藏偏移 */
  onDisplayChange: () => void
  /** 启动恢复：按持久化的 dock 字段重算隐藏偏移并应用 */
  restore: (saved: DockPersisted | undefined) => void
} {
  let phase: DockPhase = 'idle'
  let edge: DockEdge | null = null
  /** 贴边全可见位置（隐藏偏移的计算基准；persist 存的也是它） */
  let docked: Rect | null = null
  let timer: NodeJS.Timeout | null = null
  /**
   * 动画期间的光标翻转（追球的手常在这 300ms 里扑空，tick 只在翻转瞬间调一次 onCursor，
   * 动画相里会被现在的 switch 吞掉）：记下最新值，动画落定再消费。null = 动画期间无翻转。
   */
  let pendingOver: boolean | null = null
  /** 定时器回调异常只记一次日志（沿 overlay 拖拽/光标轮询的 log-once 模式，避免刷屏） */
  let dockErrorLogged = false

  function noteDockError(where: string, e: unknown): void {
    if (dockErrorLogged) return
    dockErrorLogged = true
    console.error(`[dockHide] ${where} 异常（已复位到 idle，不崩主进程）:`, e)
  }

  const isFast = (): boolean => {
    try {
      return deps.fast ? deps.fast() : false
    } catch {
      return false
    }
  }

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  /**
   * 注入依赖的安全读法：窗口关闭/显示器动荡时 electron API 可能抛
   * （Object has been destroyed）或吐非有限数 —— 同步调和定时器回调
   * 都走这里，失败给安全默认值，不把异常抛给调用方。
   * isActive 失败即"不参与隐藏"（不动窗口永远比藏错安全）。
   */
  function safeBounds(): Rect | null {
    try {
      const b = deps.getBounds()
      if (b && Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.width) && Number.isFinite(b.height)) {
        return { ...b }
      }
      return null
    } catch {
      return null
    }
  }

  function safeActive(): boolean {
    try {
      return deps.isActive() === true
    } catch {
      return false
    }
  }

  function safeArea(): WorkArea | null {
    try {
      const wa = deps.getWorkArea()
      if (wa && Number.isFinite(wa.x) && Number.isFinite(wa.y) && Number.isFinite(wa.width) && Number.isFinite(wa.height)) {
        return { ...wa }
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * 定时器回调的异常兜底：744 崩溃就是 Timeout 回调里未捕获异常
   * （setPosition 拿到 undefined）弹了主进程对话框。本模块四个定时器
   * 回调（arm 计时、morph 等待、morph 尾、动画步进）全部经这里恢复：
   * 停掉一切计时，尽力回到 idle —— 相位说可见时窗口必是全可见，
   * 绝不停在"相位说藏了、窗口在半路"的半态。
   */
  function recoverToIdle(where: string, e: unknown): void {
    noteDockError(where, e)
    clearTimer()
    try {
      setPhase('idle')
      persist()
    } catch {
      // 复位本身也不该再抛：吞掉，计时器已停，不会再动窗口
    }
  }

  /**
   * 设一个带异常兜底的计时器（arm / morph 等待 / morph 尾共用）。
   * fire 里任何异常（窗口已关、屏幕 API 瞬态失败）都走 recoverToIdle，
   * 不抛给 Node 计时器（抛出去就是主进程未捕获异常对话框）。
   */
  function later(delayMs: number, fn: () => void, where: string): void {
    clearTimer()
    timer = setTimeout(() => {
      timer = null
      try {
        fn()
      } catch (e) {
        recoverToIdle(where, e)
      }
    }, delayMs)
  }

  function persist(): void {
    deps.onPersist({ edge, hidden: phase === 'hidden' })
  }

  /**
   * 相位唯一出口：所有 `phase = …` 都走这里（直接赋值不许出现在别处，见 test-structure J2）。
   * 赋值即推送流体相位（dock:fluid），渲染层的 morph 与窗口位移因此天然串行：
   * hiding → absorbing 先播，位移随后；revealing 则是位移先落定、morph 尾随后。
   */
  function emitFluid(): void {
    try {
      deps.onFluidPhase?.(fluidForPhase(phase), edge)
    } catch {
      // 推送失败不影响状态机（渲染层订阅断了，窗口行为必须照常）
    }
  }

  function setPhase(p: DockPhase): void {
    phase = p
    emitFluid()
  }

  function arm(delayMs: number, next: DockPhase, fire: () => void): void {
    setPhase(next)
    later(delayMs, fire, `arm:${next}`)
  }

  /** 原地落定（R4-5：窗口不再滑出，落定 = 相位切换 + 命中覆盖 + 通知）。
   * reduced-motion / fast 下同样直接落定（本就无位移可跳）。 */
  function settleHidden(): void {
    setPhase('hidden')
    enterHidden()
  }

  /** 进入隐藏态：覆盖命中区为顶部 mini-pill，通知渲染层，持久化 */
  function enterHidden(): void {
    const b = safeBounds()
    if (edge && b) {
      // peekHitbox 回 null（非法边/尺寸）→ 跳过覆盖、保持整窗可点
      // （fail-open：绝不造出"看得见点不着"的半态）
      const box = peekHitbox(edge, { width: b.width, height: b.height })
      if (box) deps.setPeekOverride(box)
    }
    deps.onHiddenChange(true)
    persist()
    // morph 期间光标已到柱上（pendingOver）：直接起唤出停留，不让用户再wiggle一次鼠标
    const po = pendingOver
    pendingOver = null
    if (po === true && deps.isActive()) arm(ms(REVEAL_DWELL_MS, isFast()), 'dwell-reveal', startRevealing)
  }

  function startHiding(): void {
    if (!docked || !edge) {
      setPhase('idle')
      persist()
      return
    }
    pendingOver = null
    // R4-5 原地变柱：窗口不动，只播吸入 morph（absorbing CSS 530ms）再进 hidden。
    // morph 等待走 timer 槽 —— dragStart / reset / 显示器变化都会清掉它（取消语义不变）。
    // reduced-motion / fast 跳 morph 等待（旧路），但相位照常经过 hiding
    // （流体序列 edge-visible → absorbing → hidden 不断，单测用例 25 钉住）。
    if (!deps.reducedMotion() && !isFast()) {
      setPhase('hiding')
      later(
        ABSORB_TOTAL_MS,
        () => {
          // 等待期间被取消（phase 已不在 hiding）则不继续
          if (phase !== 'hiding') return
          settleHidden()
        },
        'absorb-wait'
      )
      return
    }
    setPhase('hiding')
    later(
      0,
      () => {
        if (phase !== 'hiding') return
        settleHidden()
      },
      'absorb-skip'
    )
  }

  function startRevealing(): void {
    if (!docked) {
      setPhase('idle')
      persist()
      return
    }
    pendingOver = null
    deps.setPeekOverride(null)
    deps.onHiddenChange(false)
    // R4-5：无位移可滑，直接播汇聚 morph 尾（revealing CSS 400ms）。
    // morph 尾期间 phase 仍是 revealing → 光标翻转记入 pendingOver，尾后消费。
    // reduced-motion / fast 跳 morph 等待（旧路），但相位照常经过 revealing。
    if (!deps.reducedMotion() && !isFast()) {
      setPhase('revealing')
      later(
        REVEAL_MS,
        () => {
          if (phase !== 'revealing') return
          setPhase('edge-visible')
          persist()
          // morph 尾期间光标已离开（pendingOver）：直接起重藏停留，不等下一次翻转
          const po = pendingOver
          pendingOver = null
          if (po === false) arm(ms(REHIDE_MS, isFast()), 'dwell-rehide', startHiding)
        },
        'reveal-tail'
      )
      return
    }
    setPhase('revealing')
    later(
      0,
      () => {
        if (phase !== 'revealing') return
        setPhase('edge-visible')
        persist()
        // 唤出期间光标已离开（pendingOver）：直接起重藏停留，不等下一次翻转
        const po = pendingOver
        pendingOver = null
        if (po === false) arm(ms(REHIDE_MS, isFast()), 'dwell-rehide', startHiding)
      },
      'reveal-skip'
    )
  }

  return {
    phase: () => phase,
    edge: () => edge,
    hidden: () => phase === 'hidden',

    onDragStop() {
      clearTimer()
      pendingOver = null
      // bounds/workArea 读不到（窗口关闭中、屏幕 API 瞬态）→ 按"不参与"处理：
      // 不动窗口、不起计时（不动永远比藏错安全）
      const b = safeBounds()
      const wa = safeArea()
      if (!safeActive() || !b || !wa) {
        edge = null
        docked = null
        setPhase('idle')
        persist()
        return
      }
      const e = detectEdge(b, wa)
      // 不贴边 → 不参与（R4-5 起无平台禁藏边：窗口不动，无菜单栏夹取问题）
      if (!e) {
        edge = null
        docked = null
        setPhase('idle')
        persist()
        return
      }
      edge = e
      docked = { ...b }
      persist()
      arm(ms(HIDE_DWELL_MS, isFast()), 'dwell-hide', startHiding)
    },

    onDragStart() {
      // 隐藏态下被抓住：先回贴边全可见位置，再让拖拽按全可见位置算偏移
      // （overlay 侧在本函数返回后才读 bounds 起自己的计时器）。
      pendingOver = null
      if ((phase === 'hidden' || phase === 'dwell-reveal' || phase === 'revealing') && docked) {
        const d = { ...docked }
        clearTimer()
        deps.setPeekOverride(null)
        deps.onHiddenChange(false)
        if (Number.isFinite(d.x) && Number.isFinite(d.y)) deps.setPosition(Math.round(d.x), Math.round(d.y))
      } else {
        clearTimer()
        if (phase === 'hidden') {
          deps.setPeekOverride(null)
          deps.onHiddenChange(false)
        }
      }
      setPhase('idle')
      persist()
    },

    onCursor(over: boolean) {
      if (!safeActive()) return
      // 动画相里的翻转：tick 只在翻转瞬间调一次，这里直接吞掉的话，追球的手会扑空
      // （隐藏播到一半进入痕迹 → 落定也不唤出；滑出播到一半离开 → 落定也不重藏）。
      // 记下最新值，动画落定（enterHidden / startRevealing 的 done 回调）再消费。
      if (phase === 'hiding' || phase === 'revealing') {
        pendingOver = over
        return
      }
      if (phase === 'dwell-hide') {
        // R1：隐藏计时期间光标进入球体 → 取消（用户还抓着球看）
        if (over) {
          clearTimer()
          setPhase('idle')
          persist()
        }
        return
      }
      if (phase === 'hidden') {
        if (over) arm(ms(REVEAL_DWELL_MS, isFast()), 'dwell-reveal', startRevealing)
        return
      }
      if (phase === 'dwell-reveal') {
        // 路过不停留：痕迹区停留不够 300ms 就离开 → 不唤出（R3 防抖）
        if (!over) {
          clearTimer()
          setPhase('hidden')
          persist()
        }
        return
      }
      if (phase === 'edge-visible') {
        // 滑出后光标离开球体 1500ms（去抖）且仍在边沿 → 重藏（跳过 1000ms，直接藏）
        if (!over) arm(ms(REHIDE_MS, isFast()), 'dwell-rehide', startHiding)
        return
      }
      if (phase === 'dwell-rehide') {
        // 重藏计时期间光标回来 → 取消重藏，留在全可见
        if (over) {
          clearTimer()
          setPhase('edge-visible')
          persist()
        }
        return
      }
    },

    onTapPeek() {
      if (phase !== 'hidden' && phase !== 'dwell-reveal') return
      clearTimer()
      startRevealing()
    },

    resetToVisible() {
      // 展开 / 开关关闭：取消计时与动画、回到贴边全可见、清 hidden（R7）
      clearTimer()
      pendingOver = null
      if ((phase === 'hidden' || phase === 'dwell-reveal' || phase === 'revealing') && docked) {
        const d = { ...docked }
        if (Number.isFinite(d.x) && Number.isFinite(d.y)) deps.setPosition(Math.round(d.x), Math.round(d.y))
      }
      deps.setPeekOverride(null)
      if (phase === 'hidden' || phase === 'dwell-reveal' || phase === 'revealing') deps.onHiddenChange(false)
      setPhase('idle')
      persist()
    },

    onDisplayChange() {
      // 显示器变化：取消计时与动画；隐藏态按当前 workArea 重算偏移，不漂出可视区（R6）
      clearTimer()
      pendingOver = null
      if (!safeActive()) {
        edge = null
        docked = null
        setPhase('idle')
        persist()
        return
      }
      if (phase === 'hidden' && edge && docked) {
        const cur = safeBounds()
        const to = hiddenBounds(docked, edge)
        // 窗口还在上次算出的隐藏位置（±1px 容差，防显示缩放取整抖动）→ 原地重算偏移即可
        // （任一读不到/算不出 → 按"已不在隐藏位置"走下面重判分支，不飞回去）
        const unmoved =
          cur !== null &&
          to !== null &&
          Math.abs(cur.x - to.x) <= 1 &&
          Math.abs(cur.y - to.y) <= 1
        if (unmoved && to) {
          if (Number.isFinite(to.x) && Number.isFinite(to.y)) deps.setPosition(Math.round(to.x), Math.round(to.y))
          const b = safeBounds()
          if (b) {
            const box = peekHitbox(edge, { width: b.width, height: b.height })
            if (box) deps.setPeekOverride(box)
          }
          persist()
          return
        }
        // 窗口已不在隐藏位置（overlay 在 display-removed 后把它夹回了可视区）：
        // 旧 docked 已失效，清覆盖并按当前位置重判（R6）——绝不能按旧坐标飞回去。
        deps.setPeekOverride(null)
        deps.onHiddenChange(false)
      }
      // 正在等隐藏/唤出的计时被取消后回到 idle：显示器都变了，不替用户做决定。
      // 若动画播到一半（窗口停在半路），先落回贴边全可见再定相，避免"相位说可见、窗口在半路"。
      if (phase !== 'idle' && phase !== 'edge-visible') {
        if ((phase === 'hiding' || phase === 'revealing') && docked) {
          const d = { ...docked }
          if (Number.isFinite(d.x) && Number.isFinite(d.y)) deps.setPosition(Math.round(d.x), Math.round(d.y))
        }
        // 按当前位置重判贴边并刷新 docked（旧坐标可能已不在新工作区边上）——
        // 下一次隐藏必须重新走 dragStop + 1000ms 停留（R1 取消语义），不能沿用旧记忆直接藏。
        // bounds/workArea 读不到 → 按不贴边（旧记忆清掉，不藏）。
        const b = safeBounds()
        const wa = safeArea()
        const e2 = b && wa ? detectEdge(b, wa) : null
        edge = e2
        docked = edge && b ? { ...b } : null
        setPhase('idle')
        persist()
      }
    },

    restore(saved: DockPersisted | undefined) {
      clearTimer()
      pendingOver = null
      const e = saved?.edge
      const wantHidden = saved?.hidden === true
      if (!wantHidden || (e !== 'left' && e !== 'right' && e !== 'top' && e !== 'bottom')) {
        edge = e === 'left' || e === 'right' || e === 'top' || e === 'bottom' ? e : null
        setPhase('idle')
        persist()
        return
      }
      if (!safeActive()) {
        edge = e
        setPhase('idle')
        persist()
        return
      }
      // 启动恢复：按当前 bounds 重判贴边（持久化坐标可能已随工作区变化被夹回别处）。
      // 只有仍在边沿才恢复隐藏 —— 显示器拔掉后窗口被夹回屏幕中间时若还按旧 edge 藏，
      // 岛是全可见的、命中区却只有 mini-pill 条（看得见点不着）。R6：不漂出可视区优先于记住隐藏态。
      // （到这里 isActive 必为真：false 的情况上面已 return。）
      // bounds 读不到 → 按全可见启动（不动窗口，不藏）。
      const b = safeBounds()
      const wa = safeArea()
      if (!b || !wa) {
        edge = e
        setPhase('idle')
        persist()
        return
      }
      const now = detectEdge(b, wa)
      if (!now) {
        edge = null
        docked = null
        pendingOver = null
        setPhase('idle')
        persist()
        return
      }
      edge = now
      docked = { ...b }
      const to = hiddenBounds(docked, edge)
      if (!to) {
        edge = null
        docked = null
        setPhase('idle')
        persist()
        return
      }
      if (Number.isFinite(to.x) && Number.isFinite(to.y)) deps.setPosition(Math.round(to.x), Math.round(to.y))
      setPhase('hidden')
      enterHidden()
    }
  }
}
