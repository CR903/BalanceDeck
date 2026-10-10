// ═══════════════════════════════════════════════════════════════════════════════
// 隐藏相位与液位映射：纯函数（时序常量 + 液位映射 + 相位映射）。
//
// 本模块是纯函数（不依赖 electron / DOM / React），因此主进程的状态机
// （src/main/dockHide.ts）、渲染层与单元测试（scripts/test-fluid.mjs）共用同一实现。
// 隐藏态命中区几何归 src/shared/dock-hide.ts（mini-pill），不归这里 ——
// 旧 waterColumn（屏边温度计水柱）已随水球退役（10-10-dynamic-island R4）。
//
// 口径（PRD R5/R9 + design Fluid 节）：
//   · 吸入总 ~530ms（拉伸 150 ease-out → 桥接合并 300 → pill 定形 + 微回弹 80）；
//   · 汇聚反向 ~400ms；窗口不再滑出屏幕（原地收缩，位移步进退役）；
//   · 液位 = percent（与 percent.ts 的一位小数归一化同粒度，无浮点抖动）。
// ═══════════════════════════════════════════════════════════════════════════════

/** 吸入拉伸段：球体向贴边侧拉伸成液桥起手（150ms ease-out，PRD R5） */
export const ABSORB_STRETCH_MS = 150
/** 吸入合并段：液桥长大连通、球体收缩汇入（300ms，PRD R5） */
export const ABSORB_MERGE_MS = 300
/** 吸入定形段：pill 定形 + 微回弹（80ms，PRD R5） */
export const ABSORB_SETTLE_MS = 80
/** 吸入 morph 总时长（150 + 300 + 80 = 530 ≈ PRD R5 的 ~500ms） */
export const ABSORB_TOTAL_MS = ABSORB_STRETCH_MS + ABSORB_MERGE_MS + ABSORB_SETTLE_MS
/** 汇聚 morph 总时长（反向 400ms，PRD R5） */
export const REVEAL_MS = 400
/** 倒水入场①灌入段：整水体从球顶之上倒进来（600ms ease-in，10-04-pour-in-slosh） */
export const POUR_FILL_MS = 600
/** 倒水入场②冲顶段：整球 overshoot + 高光闪峰（250ms，接灌入尾段） */
export const POUR_TOP_MS = 250
/** 倒水入场③荡漾段：slosh 包裹层衰减（1600ms，接冲顶尾段） */
export const POUR_SLOSH_MS = 1600
/** 倒水入场总时长（600 + 250 + 1600 = 2450 ≈ AC 的 2.5s 内结束；播完 JS 摘 data-pour） */
export const POUR_TOTAL_MS = POUR_FILL_MS + POUR_TOP_MS + POUR_SLOSH_MS

/** 流体相位（dock:fluid 通道推送，渲染层只切 CSS 类、不算几何） */
export type FluidPhase = 'edge-visible' | 'absorbing' | 'hidden' | 'revealing'

export const FLUID_PHASES: FluidPhase[] = ['edge-visible', 'absorbing', 'hidden', 'revealing']

export function isFluidPhase(v: unknown): v is FluidPhase {
  return v === 'edge-visible' || v === 'absorbing' || v === 'hidden' || v === 'revealing'
}

/**
 * 主进程 DockPhase → 流体相位（唯一映射，dockHide.ts 与单测共用）。
 *
 *   hiding → absorbing（morph 进行中，窗口位移尚未开始）；
 *   hidden / dwell-reveal → hidden（隐藏态，mini-pill）；
 *   revealing → revealing（窗口已滑回，morph 进行中）；
 *   其余（idle / dwell-hide / edge-visible / dwell-rehide）→ edge-visible
 *   （岛全可见：等待隐藏时 morph 还没开始，重藏等待时岛也在全可见位置）。
 *
 * 未知字符串回 edge-visible（渲染层默认画全可见岛，不凭空变隐藏痕迹）。
 */
export function fluidForPhase(phase: string): FluidPhase {
  if (phase === 'hiding') return 'absorbing'
  if (phase === 'hidden' || phase === 'dwell-reveal') return 'hidden'
  if (phase === 'revealing') return 'revealing'
  return 'edge-visible'
}

/**
 * 液位映射：percent（0–100）→ 液面高度比（0–1）。
 *
 *   · clamp 到 0–100（越界是上游口径错位，显示层不替它撒谎，只夹住）；
 *   · 按一位小数粒度量化（与 shared/percent.ts 的归一化同粒度）：
 *     `Math.round(p * 10) / 1000` —— 13.7 → 0.137，与环心读数逐位一致，
 *     且同样的输入永远得到同样的输出（CSS 高度不因浮点尘逐帧抖动）；
 *   · 非有限输入（NaN / Infinity / 非数字）回 0：这是守卫，不是数据口径 ——
 *     调用方只在有水时挂波浪（套餐 isPlan 且算得出比例 / 余额满水），
 *     level 永远拿不到"未知"，这里的 0 只是让非法输入画不出离谱液面。
 */
export function level(percent: unknown): number {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 0
  const c = Math.min(100, Math.max(0, percent))
  return Math.round(c * 10) / 1000
}

export interface Size {
  width: number
  height: number
}
