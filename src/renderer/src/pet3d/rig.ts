// ═══════════════════════════════════════════════════════════════════════════════
// 形态与机位常量：**唯一来源**
//
// 收起态有两种形态（见 FORMS），每种是一套机位 + 一组可见性：
//   · ball   悬浮球：玻璃球 + 球内底面上的角色（角色隐藏）→ 相机框住整颗球
//   · figure 个性人物：只有人物独立站在窗口中央（无球壳、无用量环）→ 相机框住人物
//
// 为什么单独成模块：这些数字被多处消费 —— scene.ts 建相机与装饰、projection.ts 的命中框
// 投影口径（它按这些常量反算球在窗口里的投影半径）。此前测试只能**用正则读 scene.ts 的源码
// 文本**来确认常量没漂移 —— 那正是「没有单一来源」的症状。现在两边 import 同一个模块。
//
// 单位：世界单位。球外径 56（球心 y = BALL_CENTER_Y），角色脚踩 GROUND_Y。
// ═══════════════════════════════════════════════════════════════════════════════

export const BALL_RADIUS = 28
export const BALL_CENTER_Y = BALL_RADIUS + 1.5

/** 球形态机位：把「球 + 球内角色」框进窗口，略俯视以露出球底与阴影 */
export const CAM_DISTANCE = 162
export const CAM_FOV = 35
/** 相机高出注视点多少（俯角的来源） */
export const CAM_PITCH = 34
/** 球形态相机高度（= 注视点 + 俯角） */
export const CAM_Y = BALL_CENTER_Y + CAM_PITCH

/** 人物在场景里的目标身高（世界单位）：细高体型，ballshot 核对 */
export const HUMAN_HEIGHT = 36

/** 球壳暗边直径 / 装饰带 / 用量环：三者外沿的包络就是球形态的轮廓半径 */
export const SHELL_EDGE_R = BALL_RADIUS * 1.028
export const BAND_R = BALL_RADIUS * 0.995
export const BAND_TUBE = 1.1
export const RING_R = BALL_RADIUS * 0.86
export const RING_TUBE = 1.9
export const RING_HALO_TUBE = RING_TUBE * 1.5

/**
 * 模型固有朝向修正：Max 系 FBX 转 Y-up 后若背对镜头，把该值改成 Math.PI 验证。
 * 刻意作为**常量偏移**给 scene.ts 的 heading 使用（而非写进实例旋转）：放 human.ts 会把
 * FBXLoader/SkeletonUtils 一起拖进主包（懒加载人物模块的主要动机就是避开它）。
 */
export const HUMAN_YAW = 0

// ─── 人物形态：地面、身高包络、机位 ───────────────────────────────────────────
/**
 * 角色脚踩的「地面」高度（世界 y）：球形态是球内底面（球心 - 半径 + 抬高量），
 * 人物形态沿用同一地面 —— 绝对高度不重要，相机按人物取景，两种形态共用一套地面几何。
 */
export const GROUND_Y = BALL_CENTER_Y - BALL_RADIUS + 7

/** 人物身体中点高度 = 人物形态的注视点（机位与命中框都取它） */
export const HUMAN_CENTER_Y = GROUND_Y + HUMAN_HEIGHT / 2

/**
 * 人物包围盒的水平半宽 / 半深（世界单位），**实测值**：
 * Rocketbox aria 25.2×36×6.3 → 半宽 12.6；ray 26.6×36×6.9 → 半宽 13.3。
 * 取两只里较大的那只（ray）再留一点余量 → 0.37 / 0.10；改素材后必须重测，别手调。
 */
export const HUMAN_HALF_W = HUMAN_HEIGHT * 0.37
export const HUMAN_HALF_D = HUMAN_HEIGHT * 0.1

/**
 * 人物占窗口高度的目标比例：0.68 下人物约 296px 高、头部约 40px —— 是球内形态（约 81px）
 * 的 3.7 倍，脸看得清，同时给脚下读数胶囊留出空隙（0.72 时胶囊会压到鞋面与接触阴影）。
 * 上限由头顶的两行泡泡（46px）决定：再高一档（0.76）泡泡顶边就会被窗口切掉。
 */
export const FIGURE_FILL = 0.68
/** 人物形态的俯角：比球形态平得多，否则脸是「低头看你」的俯视角度 */
export const FIGURE_CAM_PITCH = 12
/**
 * 人物形态相机距离（水平 run，不是斜距）：由「人物高度 ÷ 画面可见高度 = FIGURE_FILL」反算 ——
 * 可见高度 = 2·斜距·tan(fov/2)，斜距 = √(run² + pitch²)。
 */
export const FIGURE_CAM_Z = ((): number => {
  const d = HUMAN_HEIGHT / (FIGURE_FILL * 2 * Math.tan((CAM_FOV * Math.PI) / 360))
  return Math.sqrt(d * d - FIGURE_CAM_PITCH * FIGURE_CAM_PITCH)
})()

/** 收起态形态 */
export type PetForm = 'ball' | 'figure'

export interface FormRig {
  /** 相机水平距离 */
  camZ: number
  /** 相机高出注视点多少（俯角的来源） */
  pitch: number
  /** 注视点高度 */
  lookY: number
  /** 是否渲染球体装饰（球壳/暗边/高光/装饰带/用量环） */
  ball: boolean
  /** 脚下软阴影的铺开直径（世界单位）：球形态铺满球底，人物形态略宽于双脚 */
  shadowW: number
}

export const FORMS: Record<PetForm, FormRig> = {
  ball: {
    camZ: CAM_DISTANCE,
    pitch: CAM_PITCH,
    lookY: BALL_CENTER_Y,
    ball: true,
    shadowW: BALL_RADIUS * 1.5
  },
  figure: {
    camZ: FIGURE_CAM_Z,
    pitch: FIGURE_CAM_PITCH,
    lookY: HUMAN_CENTER_Y,
    ball: false,
    // 人物肩宽约 13 → 阴影略宽于双脚、明显窄于球底，才像「一个人站在地上」
    shadowW: HUMAN_HEIGHT * 0.44
  }
}
