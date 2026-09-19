// ═══════════════════════════════════════════════════════════════════════════════
// 机位与轮廓常量：**唯一来源**
//
// 为什么单独成模块：这些数字同时被三处消费 ——
//   · scene.ts 建相机、球壳、装饰带、用量环，并按它们把「球 + 球内角色」框进窗口
//   · viewfit.fitRoamArea() 反算漫游边界（C1 球壳不越界、C2 宠物在四角也完整可见）
//   · scripts/test-viewfit.mjs 复算投影验证上面两条约束
//
// 此前测试只能**用正则读 scene.ts 的源码文本**来确认常量没漂移 —— 那正是「没有单一来源」
// 的症状。现在两边 import 同一个模块，漂移在结构上不再可能；那 14 条恒真式断言已随之删除。
//
// 单位：世界单位。球外径 56（球心 y = BALL_CENTER_Y），角色脚踩球内底面。
// ═══════════════════════════════════════════════════════════════════════════════

export const BALL_RADIUS = 28
export const BALL_CENTER_Y = BALL_RADIUS + 1.5

/** 相机：把「球 + 球内角色」框进窗口，略俯视以露出球底与阴影 */
export const CAM_DISTANCE = 162
export const CAM_FOV = 35
/** 相机高出注视点多少（俯角的来源） */
export const CAM_PITCH = 34
/** 相机高度（= 注视点 + 俯角） */
export const CAM_Y = BALL_CENTER_Y + CAM_PITCH

/** 真人系角色在球内的目标高度（世界单位）：细高体型，比 Q 版高一截，ballshot 核对 */
export const HUMAN_HEIGHT = 36

/** 球壳暗边直径 / 装饰带 / 用量环：三者外沿的包络就是反算用的轮廓半径 */
export const SHELL_EDGE_R = BALL_RADIUS * 1.028
export const BAND_R = BALL_RADIUS * 0.995
export const BAND_TUBE = 1.1
export const RING_R = BALL_RADIUS * 0.86
export const RING_TUBE = 1.9
export const RING_HALO_TUBE = RING_TUBE * 1.5

/** 反算漫游边界用的轮廓半径：球壳暗边 / 装饰带 / 用量环外沿的最大者（不只 BALL_RADIUS） */
export const SILHOUETTE_R = Math.max(SHELL_EDGE_R, BAND_R + BAND_TUBE, RING_R + RING_HALO_TUBE)

/**
 * 反算留白（世界单位）：轮廓球的投影按圆处理，但离画面中心越远真实轮廓越是被拉成横椭圆，
 * 实测 320×230 贴边时算宽约 4.7%（≈7px 出界）；4 单位刚好吸收掉该误差。
 */
export const ROAM_FIT_MARGIN = 4

/**
 * 纵深预算（R9）：球壳停在 z=0 后宠物可以朝镜头方向走 28 个单位，
 * 透视缩放跨度 √(34²+(162−28)²) ↔ √(34²+(162+28)²) ≈ 1.40×（≥1.35× 目标）。
 */
export const ROAM_DEPTH_BUDGET = 28
