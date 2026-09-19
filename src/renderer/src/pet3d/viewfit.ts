// ═══════════════════════════════════════════════════════════════════════════════
// 视口 → 可行漫游区反算（纯函数：无 three / 无 DOM 依赖，可单测）
//
// 现状：产品侧只用它的 sphereNdcHalf（命中区投影口径，见 scene.ts 的 updateHitRect）；
// fitRoamArea 暂无消费者（两种形态都不走动，见 scene.ts 头注释），留着是因为走动
// 可能在后续形态（随机动作 / 进出场）里复活 —— 删除是独立决定。
//
// 为什么反算：漫游边界只要写成硬编码的世界常量，就从那一刻起与窗口尺寸、形态、
// 相机参数脱钩 —— 任一变化都会让它失效（halfX:58 把球切成半圆的根因）。
//
// 投影口径只有一份：sphereNdcHalf()，scene.ts 的命中框同样调它。两处各写一份
// 正是「常量看着合理、渲染出来却出界」这类漂移的来源。
//
// 相机恒在 x=0 的平面内俯视 lookY（scene.ts 的机位形状），所以 NDC 可解析求出，
// 且与 three 的 Vector3.project() 逐点一致（scripts/test-viewfit.mjs 交叉核对）。
// ═══════════════════════════════════════════════════════════════════════════════

/** 极小窗口时的下限：宁可球略微出界，也不能让宠物冻死在原地 */
export const MIN_HALF_X = 12
export const MIN_HALF_Z = 6

/** 机位 + 视口：反算与投影共用的一组输入（不含漫游区自身） */
export interface Viewport {
  /** 竖直视场角（度，three PerspectiveCamera 的 fov 口径） */
  fovDeg: number
  camY: number
  camZ: number
  /** 相机注视点高度 = 球心高度 */
  lookY: number
  viewW: number
  viewH: number
}

/** 轮廓：一个包围球。用球是因为投影口径只有一份（sphereNdcHalf），换形状就等于换数学 */
export interface Silhouette {
  /** 包围球半径（世界单位） */
  radius: number
  /** 球心高度（世界 y） */
  centerY: number
}

export interface RoamFitInput extends Viewport {
  /**
   * 玻璃球壳与用量环外沿的轮廓（取两者较大者，不只 BALL_RADIUS）。
   * 它恒定停在 z=0、只随宠物左右平移（D4'）→ 它的可见性约束与宠物的 z 无关。
   */
  shell: Silhouette
  /**
   * 宠物本体的轮廓（按素材实测的包围球，偏保守）。
   * 它才是纵深侧的约束方：走到 z=±halfZ 时离镜头最近、投影最大，
   * 并反过来收紧 halfX（同一 z 上越靠边越容易出画面）。
   */
  body: Silhouette
  /**
   * 世界单位留白。球的投影按圆处理，但离画面中心越远真实轮廓越是被拉成横椭圆
   * （实测 320×230 贴边时算宽约 4.7% ≈ 7px），margin 就是用来吸收这个误差的；
   * aspect 越接近 1 越准，极端宽扁的画面误差会重新变大。
   */
  margin: number
  /** 期望纵深上限：视口允许更深时也不超过它（越大越「走近变大」明显） */
  depthBudget: number
}

/** 球投影到 NDC 的结果：中心 + 半跨幅（1 = 半屏） */
export interface SphereNdc {
  nx: number
  ny: number
  hx: number
  hy: number
}

/**
 * 世界半径 → NDC 半跨幅（scene.ts 命中框与漫游区反算的共同口径）：
 * 角半径 asin(r/dist) 除以半视角正切得竖直跨幅，水平按宽高比折算。
 */
export function sphereNdcHalf(
  dist: number,
  worldRadius: number,
  fovDeg: number,
  aspect: number
): { nx: number; ny: number } {
  const halfView = Math.tan((fovDeg * Math.PI) / 360)
  const angular = Math.asin(Math.min(0.99, worldRadius / dist))
  const ny = Math.tan(angular) / halfView
  return { nx: ny / aspect, ny }
}

/** 相机基向量在 y/z 上的分量 + 半视角正切（projectSphere 与 x 边界反算共用一份） */
function viewFrame(v: Viewport): { sin: number; cos: number; tanHalf: number; aspect: number } {
  const rise = v.camY - v.lookY
  const run = v.camZ
  const len = Math.hypot(rise, run) || 1
  return {
    // three 的 lookAt 里 +Z 指向相机后方，所以俯视角的正/余弦分别落在 y/z 上
    sin: rise / len,
    cos: run / len,
    tanHalf: Math.tan((v.fovDeg * Math.PI) / 360),
    aspect: v.viewW / v.viewH
  }
}

/** 球心在 (x, centerY, z)、半径 radius 的球 → NDC 中心与半跨幅 */
export function projectSphere(
  v: Viewport,
  x: number,
  centerY: number,
  z: number,
  radius: number
): SphereNdc {
  const { sin, cos, tanHalf, aspect } = viewFrame(v)
  const dy = centerY - v.camY
  const dz = z - v.camZ
  const depth = -(dy * sin + dz * cos)
  if (!(depth > 0) || !Number.isFinite(aspect) || aspect <= 0) {
    // 球跑到相机后方/相机上，或视口退化（0 宽）→ 判为不可见，让二分收敛到下限
    return { nx: Infinity, ny: Infinity, hx: 0, hy: 0 }
  }
  const { nx: hx, ny: hy } = sphereNdcHalf(Math.hypot(x, -dy, dz), radius, v.fovDeg, aspect)
  return {
    nx: x / (depth * tanHalf * aspect),
    ny: (dy * cos - dz * sin) / (depth * tanHalf),
    hx,
    hy
  }
}

/** 轮廓球完整落在画面内？ */
function inView(p: SphereNdc): boolean {
  return Math.abs(p.nx) + p.hx <= 1 && Math.abs(p.ny) + p.hy <= 1
}

/** 单调递减（越远越不可行）的谓词，二分求仍然可行的最大值 */
function bisectMax(fits: (v: number) => boolean, lo: number, hi: number): number {
  if (fits(hi)) return hi
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) lo = mid
    else hi = mid
  }
  return lo
}

/**
 * 反算可行漫游区（两条独立约束，投影数学只有 sphereNdcHalf 一份）：
 *   C1 球壳（含用量环/装饰带外沿）：恒定停在 z=0、只随宠物左右平移（R7）
 *      → 它在 (±halfX, 0) 处必须完整可见，决定 halfX 的一个上界。
 *   C2 宠物本体：走到 (±halfX, ±halfZ) 的**任意组合**处必须完整可见
 *      → 近镜头侧投影最大，决定 halfZ 的上界并反过来收紧 halfX。
 *
 * 求解顺序不能反：相机恒在 x=0 的平面内俯视，所以竖直 NDC 与 x 无关（只有 z 的函数），
 * 先二分出「竖直仍完整」的最大 halfZ（与 depthBudget 取小），再在该 halfZ 的两侧
 * 二分 halfX。两者的耦合（z 越大宠物离镜头越近越大 → 可用 x 越小）就体现在第二步。
 *
 * 下限保护只在窗口小到装不下时接管（宁可球略微出界，也不让宠物冻死）。
 */
export function fitRoamArea(o: RoamFitInput): { halfX: number; halfZ: number } {
  const fits = (s: Silhouette, ax: number, az: number): boolean =>
    inView(projectSphere(o, ax, s.centerY, az, s.radius + o.margin))
  // C2 的竖直分量：对 x 不敏感，取 x=0、z=±az（近镜头侧投影最大，远侧更松也一并检验）
  const halfZ = bisectMax((az) => fits(o.body, 0, az) && fits(o.body, 0, -az), 0, Math.max(o.depthBudget, 0))
  // C1+C2 的横向分量：二分上界 = 「中心已贴到画面左右缘」的世界半宽 depth·tanHalf·aspect
  // （nx 对 x 是线性的，depth 与 x 无关，故该处必然不可行）
  const { sin, cos, tanHalf, aspect } = viewFrame(o)
  const edgeX = (s: Silhouette, z: number): number => {
    const depth = -((s.centerY - o.camY) * sin + (z - o.camZ) * cos)
    return depth > 0 ? tanHalf * aspect * depth : 0
  }
  const upperX = Math.min(edgeX(o.shell, 0), edgeX(o.body, halfZ), edgeX(o.body, -halfZ))
  const halfX = bisectMax(
    (ax) => fits(o.shell, ax, 0) && fits(o.body, ax, halfZ) && fits(o.body, ax, -halfZ),
    0,
    Number.isFinite(upperX) ? upperX : 0
  )
  return {
    halfX: Math.max(MIN_HALF_X, halfX),
    halfZ: Math.max(MIN_HALF_Z, halfZ)
  }
}
