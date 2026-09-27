// ═══════════════════════════════════════════════════════════════════════════════
// 人物形态的机位与地面常量：**唯一来源**
//
// 收起态的球形态 2026-09-27 回到 2D 小圆环（shared/pet-view 的 BALL_VIEW），
// 不再建 3D 场景 —— 于是这里曾有的第二套机位（球形态的 CAM_* / 壳体 / 装饰带 / 用量环
// 那 9 个常量）与 FORMS.ball 一并删除。剩下的都只服务人物形态。
//
// 为什么仍然单独成模块：FIGURE_CAM_Z 由「人物占画面高度」反算，被 scene.ts 的相机、
// 命中框与走查共用。此前测试只能**用正则读 scene.ts 的源码文本**来确认常量没漂移 ——
// 那正是「没有单一来源」的症状。
//
// 单位：世界单位，角色脚踩 GROUND_Y。
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 以下两个是**球时代留下的刻度**，现在只作为地面高度的输入（GROUND_Y = 二者之差 + 抬高量）
 * 与地面承接面/软阴影贴图的尺寸。名字里的「BALL」已经没有球了，改名会波及 GROUND_Y
 * 的推导链；留着但不再当球半径用。
 */
export const BALL_RADIUS = 28
export const BALL_CENTER_Y = BALL_RADIUS + 1.5

export const CAM_FOV = 35

/** 人物在场景里的目标身高（世界单位）：细高体型，ballshot 核对 */
export const HUMAN_HEIGHT = 36

/**
 * 模型固有朝向修正：Max 系 FBX 转 Y-up 后若背对镜头，把该值改成 Math.PI 验证。
 * 刻意作为**常量偏移**给 scene.ts 的 heading 使用（而非写进实例旋转）：放 human.ts 会把
 * FBXLoader/SkeletonUtils 一起拖进主包（懒加载人物模块的主要动机就是避开它）。
 */
export const HUMAN_YAW = 0

// ─── 人物形态：地面、身高包络、机位 ───────────────────────────────────────────
/**
 * 角色脚踩的「地面」高度（世界 y）：沿用球内底面的高度（球心 - 半径 + 抬高量）。
 * 绝对高度不重要，相机按人物取景；这段推导里的 BALL_* 只是刻度（见文件头）。
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
 * 人物占窗口高度的目标比例：0.68 下人物约 296px 高、头部约 40px，脸看得清，
 * 同时给脚下读数胶囊留出空隙（0.72 时胶囊会压到鞋面与接触阴影）。
 * 上限由头顶的两行泡泡（46px）决定：再高一档（0.76）泡泡顶边就会被窗口切掉。
 */
export const FIGURE_FILL = 0.68
/** 人物形态的俯角：太小就会变成「低头看你」的俯视角度 */
export const FIGURE_CAM_PITCH = 12
/**
 * 人物形态机位：相机水平距离由「人物高度 ÷ 画面可见高度 = FIGURE_FILL」反算 ——
 * 可见高度 = 2·斜距·tan(fov/2)，斜距 = √(run² + pitch²)。
 */
export const FIGURE_CAM_Z = ((): number => {
  const d = HUMAN_HEIGHT / (FIGURE_FILL * 2 * Math.tan((CAM_FOV * Math.PI) / 360))
  return Math.sqrt(d * d - FIGURE_CAM_PITCH * FIGURE_CAM_PITCH)
})()

/**
 * 收起态的 3D 形态。**只有人物形态**了 —— 球形态是 2D 小圆环，不建场景（PetBall 的守卫）。
 * 它是 `FORMS` 的键类型：将来若再加一种要建 3D 场景的形态，往这个联合里加一个成员、
 * 往 `FORMS` 里加一项即可，`Record` 会强制补齐。
 */
export type PetForm = 'figure'

export interface FormRig {
  /** 相机水平距离 */
  camZ: number
  /** 相机高出注视点多少（俯角的来源） */
  pitch: number
  /** 注视点高度 */
  lookY: number
  /** 脚下软阴影的铺开直径（世界单位）：略宽于双脚、明显窄于球底，才像「一个人站在地上」 */
  shadowW: number
}

export const FORMS: Record<PetForm, FormRig> = {
  figure: {
    camZ: FIGURE_CAM_Z,
    pitch: FIGURE_CAM_PITCH,
    lookY: HUMAN_CENTER_Y,
    shadowW: HUMAN_HEIGHT * 0.44
  }
}
