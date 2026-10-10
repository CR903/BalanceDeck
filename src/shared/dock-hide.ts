// ═══════════════════════════════════════════════════════════════════════════════
// 顶部灵动岛的贴边自动隐藏：几何纯函数（主进程、单测共用同一实现）。
//
// 本模块是纯函数（不依赖 electron / DOM / React），因此主进程的状态机
// （src/main/dockHide.ts）与单元测试（scripts/test-dock-hide.mjs）共用同一实现。
// 隐藏态的命中区是渲染层 reportHit 上报的 pill 实测矩形 —— 主进程不再覆盖
// （10-10-island-mini-tune R3：渲染的 pill 跟 posX 走、宽 fit-content，
//   居中 132×26 覆盖三处全对不上 → 点 pill 必穿透）。
//
// 口径（与 overlay.ts 同源）：
//   · 贴边基准是显示器的 workArea（非全屏 bounds），与 snapBackToWorkArea 一致；
//   · 隐藏偏移每次按当前 workArea 重算，显示器变化不漂移；
//   · 坐标仍存贴边全可见位置，state.json 只多记 {edge, hidden}。
//
// 10-10-dynamic-island：可见态是顶部灵动岛（全供应商），隐藏态是 A 式 mini-pill
// （窄条 + 各家等级点，顶部原位收缩，不贴边；几何只活在 island.css，
//   本模块不再备第二个数 —— 10-10-island-mini-tune R3）。
// ═══════════════════════════════════════════════════════════════════════════════

/** 贴边判定阈值：窗口边与工作区边距离 ≤ 8px 算贴边（PRD R1/R4） */
export const EDGE_THRESHOLD = 8
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
 * 隐藏位置（原地收缩）：窗口不再滑出屏幕，原地不动 —— 返回 docked 本身。
 * "隐藏"的是岛形态（渲染层收缩成顶部 mini-pill），不是窗口位置。
 *
 * 保留函数（调用方/单测入口不变）：docked 非法仍回 null，调用方走"不动 + idle"。
 * （undefined 进 setPosition 会直接崩主进程，见 10-03-dock-autohide 744 崩溃。）
 */
export function hiddenBounds(docked: Rect, edge: DockEdge): Rect | null {
  if (!docked || !finiteRect(docked)) return null
  if (edge !== 'left' && edge !== 'right' && edge !== 'top' && edge !== 'bottom') return null
  return { ...docked }
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
