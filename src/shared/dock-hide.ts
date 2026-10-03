// ═══════════════════════════════════════════════════════════════════════════════
// 悬浮球贴边自动隐藏：几何纯函数（主进程、单测共用同一实现）。
//
// 本模块是纯函数（不依赖 electron / DOM / React），因此主进程的状态机
// （src/main/dockHide.ts）与单元测试（scripts/test-dock-hide.mjs）共用同一实现。
// 渲染层不算几何 —— 隐藏态的命中区由主进程按这里的 peekHitbox 覆盖。
//
// 口径（与 overlay.ts 同源）：
//   · 贴边基准是显示器的 workArea（非全屏 bounds），与 snapBackToWorkArea 一致；
//   · 隐藏偏移每次按当前 workArea 重算，显示器变化不漂移；
//   · 坐标仍存贴边全可见位置，state.json 只多记 {edge, hidden}。
// ═══════════════════════════════════════════════════════════════════════════════

/** 贴边判定阈值：窗口边与工作区边距离 ≤ 8px 算贴边（PRD R1/R4） */
export const EDGE_THRESHOLD = 8
/** 痕迹宽度：隐藏后留在屏幕内的可见条（PRD R2） */
export const PEEK = 4
/** 贴边停留多久才隐藏（PRD R1，防误触） */
export const HIDE_DWELL_MS = 1000
/** 痕迹区停留多久才滑出（PRD R3，防路过抖动） */
export const REVEAL_DWELL_MS = 300
/** 滑出后光标离开球体多久重新隐藏（PRD R3，去抖） */
export const REHIDE_MS = 1500
/** 隐藏动画时长（PRD R5：250–350ms ease-out） */
export const HIDE_ANIM_MS = 300
/** 唤出动画时长（PRD R5：退出更快，180–220ms） */
export const REVEAL_ANIM_MS = 200
/** 动画步进节拍（16ms/帧，与拖拽轮询同频，互斥） */
export const ANIM_FRAME_MS = 16

export type DockEdge = 'left' | 'right' | 'top' | 'bottom'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

function finiteRect(b: Rect): boolean {
  return Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.width) && Number.isFinite(b.height)
}

function finiteWa(wa: WorkArea): boolean {
  return Number.isFinite(wa.x) && Number.isFinite(wa.y) && Number.isFinite(wa.width) && Number.isFinite(wa.height)
}

/**
 * 判定窗口贴在哪条边上（dragStop 收回之后调，bounds 已是严格工作区内的全可见位置）。
 *
 * 角落同时贴两边时取距离最近的一边；距离平局按左/右/上/下顺序确定性选择（PRD R4）。
 * 窗口比工作区大（小屏负区间）→ 不贴边，返回 null。
 * 非有限数 → null（沿 overlay 既有 NaN 守卫模式）。
 */
export function detectEdge(bounds: Rect, wa: WorkArea): DockEdge | null {
  if (!finiteRect(bounds) || !finiteWa(wa)) return null
  if (!(bounds.width > 0) || !(bounds.height > 0)) return null
  if (bounds.width > wa.width || bounds.height > wa.height) return null
  const dist: { edge: DockEdge; d: number }[] = [
    { edge: 'left', d: bounds.x - wa.x },
    { edge: 'right', d: wa.x + wa.width - (bounds.x + bounds.width) },
    { edge: 'top', d: bounds.y - wa.y },
    { edge: 'bottom', d: wa.y + wa.height - (bounds.y + bounds.height) }
  ]
  // 数组顺序即平局优先级：左/右/上/下。取最小距离，且必须 ≤ 阈值。
  let best: DockEdge | null = null
  let bestD = EDGE_THRESHOLD + 1
  for (const c of dist) {
    if (!Number.isFinite(c.d)) return null
    // 负距离（窗口探出工作区）不算贴边 —— dragStop 收回后不应出现，出现了也不隐藏
    if (c.d < 0) continue
    if (c.d < bestD) {
      bestD = c.d
      best = c.edge
    }
  }
  return bestD <= EDGE_THRESHOLD ? best : null
}

/**
 * 按贴边全可见位置算出隐藏位置（窗口向贴边方向滑出屏幕外，只留 PEEK 痕迹）。
 * 例：左贴边 → 窗口右缘留在 wa.x + PEEK 处。
 *
 * 非法输入（非法边 / 非有限 docked）回 null —— 调用方不得移动窗口
 * （undefined 进 setPosition 会直接崩主进程，见 10-03-dock-autohide 744 崩溃；
 * 这里回 null 让调用方走"不动 + idle" 的 fail-closed 路，不抛也不藏）。
 */
export function hiddenBounds(docked: Rect, edge: DockEdge, peek: number = PEEK): Rect | null {
  if (!docked || !finiteRect(docked)) return null
  if (edge !== 'left' && edge !== 'right' && edge !== 'top' && edge !== 'bottom') return null
  const p = Number.isFinite(peek) && peek >= 0 ? peek : PEEK
  switch (edge) {
    case 'left':
      return { ...docked, x: Math.round(docked.x - (docked.width - p)) }
    case 'right':
      return { ...docked, x: Math.round(docked.x + (docked.width - p)) }
    case 'top':
      return { ...docked, y: Math.round(docked.y - (docked.height - p)) }
    case 'bottom':
      return { ...docked, y: Math.round(docked.y + (docked.height - p)) }
    default:
      return null
  }
}

/**
 * 隐藏态的命中区覆盖（窗口局部坐标，DIP）。
 * 主进程以它为准，不采信渲染层常规上报（跨层契约：与隐藏偏移同源）。
 *
 * 非法输入（非法边 / 非有限非正尺寸）回 null —— 调用方跳过覆盖、
 * 保持整窗可点（fail-open：绝不造出"看得见点不着"的半态）。
 */
export function peekHitbox(edge: DockEdge, size: { width: number; height: number }, peek: number = PEEK): Rect | null {
  const w = size?.width
  const h = size?.height
  if (!Number.isFinite(w) || !Number.isFinite(h) || !(w > 0) || !(h > 0)) return null
  if (edge !== 'left' && edge !== 'right' && edge !== 'top' && edge !== 'bottom') return null
  const p = Number.isFinite(peek) && peek >= 0 ? peek : PEEK
  switch (edge) {
    case 'left':
      return { x: w - p, y: 0, width: p, height: h }
    case 'right':
      return { x: 0, y: 0, width: p, height: h }
    case 'top':
      return { x: 0, y: h - p, width: w, height: p }
    case 'bottom':
      return { x: 0, y: 0, width: w, height: p }
    default:
      return null
  }
}

/** easeOutCubic：隐藏/唤出动画共用（PRD R5） */
export function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t))
  return 1 - (1 - c) ** 3
}

/** 动画插值：from → to 按 eased 进度逐帧位置（调用方按 ANIM_FRAME_MS 步进） */
export function animBounds(from: Rect, to: Rect, t: number): Rect {
  const e = easeOutCubic(t)
  return {
    x: Math.round(from.x + (to.x - from.x) * e),
    y: Math.round(from.y + (to.y - from.y) * e),
    width: from.width,
    height: from.height
  }
}
