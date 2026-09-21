// ═══════════════════════════════════════════════════════════════════════════════
// 投影口径：世界尺寸 → NDC（**只有一份**）
//
// 为什么单独成模块：命中区（点击穿透那块矩形）与走查核对必须用同一份换算 ——
// 两处各写一份正是「常量看着合理、屏幕上却对不上」这类漂移的来源。
// scene.ts 的 updateHitRect（球形态）调它，scripts/test-projection.mjs 用 three 的
// 真实投影矩阵交叉核对它。
//
// 历史：这个模块原叫 viewfit.ts，主体是「视口 → 可行漫游区反算」（fitRoamArea）。
// 收起态两种形态都不再自主走动后，那部分连同 walker.ts 一起删除了（2026-09-21），
// 只留下这一份仍在服役的投影口径。
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 世界半径 → NDC 半跨幅。
 *
 * 角半径 asin(r/dist) 除以半视角正切得竖直跨幅，水平按宽高比折算：
 * 球在屏幕上的投影是一个圆，而 NDC 的 x/y 刻度不同（差一个 aspect）。
 *
 * @param dist        相机到球心的距离（斜距，不是某个轴上的分量）
 * @param worldRadius 球半径（世界单位）
 * @param fovDeg      竖直视场角（three PerspectiveCamera 的 fov 口径）
 * @param aspect      视口宽高比
 */
export function sphereNdcHalf(
  dist: number,
  worldRadius: number,
  fovDeg: number,
  aspect: number
): { nx: number; ny: number } {
  const halfView = Math.tan((fovDeg * Math.PI) / 360)
  // 0.99 兜住"球比相机还近"的退化输入：asin 在 ≥1 处发散，钳住后跨幅退化为半个画面
  const angular = Math.asin(Math.min(0.99, Math.max(0, worldRadius / dist)))
  const ny = Math.tan(angular) / halfView
  return { nx: ny / aspect, ny }
}
