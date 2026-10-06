// 环形进度（V1/V3/V5 环形态皮肤）的弧长口径 —— 纯函数模块
// （无 electron / 无 React / 无 DOM，与 skin-waves.ts 同纪律；node 单测经 loadTs 加载）。
//
// 为什么半径不在这里：三个环形态皮肤的半径/环宽逐皮不同（V1 22/4、V3 24/2.5、
// V5 21/6，原型 skin-applied.html 的 112 坐标系折半），它们是**皮肤令牌**
// （--ring-r / --ring-sw）。若把半径搬进本表，CSS 与 TS 就得各写一份几何 ——
// 同一元素两套数是本仓反复踩过的漂移源（disc-absorb 单套改 h/v 那次）。
//
// 解法是 SVG 的 pathLength：circle 上写 pathLength="100" 后，周长被归一化成 100，
// stroke-dasharray 的单位随之变成「百分比」而不是像素。于是：
//   · 弧长 ← 只有 fluidLevel 一个自变量（本模块，0..100）；
//   · 半径/环宽/端点 ← 全在 CSS 令牌（换皮改几何不动一行 TS）。
// 归一化带来的纪律：分段轨道（minimal 的缺口）也必须写在 0..100 空间里，
// 数值随半径缩放而变 —— 所以那条 pattern 只能待在 CSS（--ring-track-dash），
// 不在本模块（否则又变成两份半径派生值）。

/** circle 上的 pathLength：周长归一化到 100，dasharray 的单位即百分比 */
export const RING_DASH_SPACE = 100

/**
 * 弧长 dasharray：progress 0..1 → `"<百分比> 100"`。
 *
 * - 量化到 2 位小数（与 shared/fluid.level 的一位小数粒度同源：液位与弧长
 *   在同一次渲染里由同一个 fluidLvl 算出，不会出现"水位动了弧没动"）；
 * - 0 → `"0.00 100"`：不画弧而不是画一个 0 长度的 dash（后者在不同实现里
 *   会渲染成一个圆点，看着像"有进度"）；
 * - 越界/非有限输入钳到 [0,1]（与 shared/fluid.level、water-color 同一纪律：
 *   显示层只夹住，不替上游撒谎）；"未知"由调用方不渲染表达。
 */
export function ringDash(progress: unknown): string {
  const p = typeof progress === 'number' && Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0
  return `${(p * RING_DASH_SPACE).toFixed(2)} ${RING_DASH_SPACE}`
}
