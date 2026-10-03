// ═══════════════════════════════════════════════════════════════════════════════
// 悬浮球流体隐藏：纯函数（时序常量 + 液位映射 + 水渍几何 + 相位映射）。
//
// 本模块是纯函数（不依赖 electron / DOM / React），因此主进程的状态机
// （src/main/dockHide.ts）、渲染层（PetBall.tsx 的波浪/水渍定位）与单元测试
// （scripts/test-fluid.mjs）共用同一实现。几何口径与 src/shared/dock-hide.ts
// 同源（PEEK 痕迹宽度、56×56 球窗），边类型直接复用 DockEdge，不自立第二份。
//
// 口径（PRD R5/R9 + design Fluid 节）：
//   · 吸入总 ~530ms（拉伸 150 ease-out → 桥接合并 300 → pill 定形 + 微回弹 80）；
//   · 汇聚反向 ~400ms；窗口滑出/滑入仍走主进程既有步进（300ms / 200ms），
//     morph 与位移串行不重叠；
//   · 液位 = percent（与 percent.ts 的一位小数归一化同粒度，无浮点抖动）；
//   · 水渍 pill 沿边沿约 20px × 探出 PEEK（4px），居中，圆角水滴形（圆角归 CSS）。
// ═══════════════════════════════════════════════════════════════════════════════

import type { DockEdge } from './dock-hide'
import { PEEK } from './dock-hide'

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
/** 水渍 pill 沿边沿的长度（约 20px，PRD R2） */
export const PILL_LEN = 20

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
 *   hidden / dwell-reveal → hidden（水渍态，波浪暂停）；
 *   revealing → revealing（窗口已滑回，morph 进行中）；
 *   其余（idle / dwell-hide / edge-visible / dwell-rehide）→ edge-visible
 *   （球全可见：等待隐藏时 morph 还没开始，重藏等待时球也在全可见位置）。
 *
 * 未知字符串回 edge-visible（渲染层默认画整球，不凭空变水渍）。
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
 *     调用方只在 `pct != null`（isPlan 且算得出比例）时挂波浪，
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

/**
 * 水渍 pill 在窗口局部坐标里的矩形（渲染层只按它摆，不自己算几何）。
 * pill 贴在贴边侧、沿边沿居中：左贴边 → 窗口右侧一条 `PEEK × PILL_LEN`。
 *
 * 非法输入（非有限数 / 非正尺寸 / 非正 len·peek）回 null —— 调用方回退到
 * dock-hide.ts 的 peekHitbox 痕迹条（同源的另一半），不凭空摆一个错位水渍。
 */
export function pillBox(
  edge: DockEdge,
  size: Size,
  len: number = PILL_LEN,
  peek: number = PEEK
): { x: number; y: number; width: number; height: number } | null {
  const w = size?.width
  const h = size?.height
  if (!Number.isFinite(w) || !Number.isFinite(h) || !(w > 0) || !(h > 0)) return null
  if (!Number.isFinite(len) || !(len > 0) || !Number.isFinite(peek) || !(peek > 0)) return null
  if (len > (edge === 'left' || edge === 'right' ? h : w)) return null
  switch (edge) {
    case 'left':
      return { x: w - peek, y: (h - len) / 2, width: peek, height: len }
    case 'right':
      return { x: 0, y: (h - len) / 2, width: peek, height: len }
    case 'top':
      return { x: (w - len) / 2, y: h - peek, width: len, height: peek }
    case 'bottom':
      return { x: (w - len) / 2, y: 0, width: len, height: peek }
  }
}

/**
 * 贴边水柱（10-03-holo-sphere 水满 pivot：隐藏态的水渍 pill 改为水柱）。
 *
 * 水柱占满整条可见痕迹 —— 几何与 dock-hide.ts 的 peekHitbox **逐位一致**
 * （左右边：PEEK 宽 × 满高竖柱；上下边：满宽 × PEEK 高横槽），柱内液高/液宽 =
 * 同一 fluidLevel(pct)，柱顶一条小波浪（渲染层），水色同样跟 `lvl`。
 * 命中区仍是主进程按 peekHitbox 覆盖的那一条：看得见的柱子整根可点，
 * 不存在「柱子宽、能点的窄」的半态。
 *
 * 为什么另起一个函数而不是让渲染层直接调 peekHitbox：方向是视图才需要的
 * 信息（竖柱的液高从底起、横槽的液宽从左起，CSS 按 `vertical` 分两套摆），
 * 而「柱子占满痕迹」这句口径要有单测钉住 —— 钉在共用实现上，不钉在 CSS 声明上。
 *
 * 非法输入回 null（与 pillBox 同纪律）：调用方回退到「不画柱子只留命中区」，
 * 不凭空摆一个错位水柱。
 */
export interface WaterColumn {
  x: number
  y: number
  width: number
  height: number
  /** true = 左右边的竖柱（液高从底起）；false = 上下边的横槽（液宽从左起） */
  vertical: boolean
}

export function waterColumn(
  edge: DockEdge,
  size: Size,
  peek: number = PEEK
): WaterColumn | null {
  const w = size?.width
  const h = size?.height
  if (!Number.isFinite(w) || !Number.isFinite(h) || !(w > 0) || !(h > 0)) return null
  if (!Number.isFinite(peek) || !(peek > 0)) return null
  switch (edge) {
    case 'left':
      return { x: w - peek, y: 0, width: peek, height: h, vertical: true }
    case 'right':
      return { x: 0, y: 0, width: peek, height: h, vertical: true }
    case 'top':
      return { x: 0, y: h - peek, width: w, height: peek, vertical: false }
    case 'bottom':
      return { x: 0, y: 0, width: w, height: peek, vertical: false }
  }
  return null
}
