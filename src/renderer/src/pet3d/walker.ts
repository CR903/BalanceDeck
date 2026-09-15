// ═══════════════════════════════════════════════════════════════════════════════
// 桌面漫游：纯函数状态机（无 React / 无 three 依赖，可单测）
//
// 宠物在「漫游区」（世界坐标 x/z 平面）里自主行走：
//   idle（发呆）──定时器到期──▶ walk（走向新目标点）──到达/超时──▶ idle
// 交互（撸一把 / 喂食 / 睡觉）优先级高于自主行为，由外部 override 驱动。
//
// 设计取舍：
//   · 位置是连续的，朝向只取左右（±1）——桌面宠物侧对镜头时看着像被压扁，
//     因此让它始终面向镜头平面，只按行走方向翻转，观感最稳。
//   · 目标点在漫游区内随机取点；走到边界附近时目标会向区内偏移（避免贴着边缘抖动）。
// ═══════════════════════════════════════════════════════════════════════════════

export type Gait = 'idle' | 'walk' | 'pet' | 'eat' | 'sleep' | 'wake'

/** 漫游区（世界坐标，x 左右 / z 纵深；宠物中心可到达的范围） */
export interface RoamArea {
  /** x 半宽 */
  halfX: number
  /** z 半深 */
  halfZ: number
}

export interface WalkerState {
  x: number
  z: number
  /** 朝向：1 = 向右，-1 = 向左 */
  facing: 1 | -1
  gait: Gait
  /** 当前步态已持续秒数 */
  since: number
  /** 目标点（gait === 'walk' 时有效） */
  tx: number
  tz: number
  /** 到下一次自主行为切换的剩余秒数 */
  waitFor: number
}

export interface WalkerConfig {
  area: RoamArea
  /** 行走速度（世界单位/秒） */
  speed: number
  /** idle 时长范围（秒） */
  idleSec: [number, number]
  /** 单次行走最长时长（秒），防止追不上目标时永远走 */
  maxWalkSec: number
}

export const DEFAULT_WALKER: WalkerConfig = {
  area: { halfX: 58, halfZ: 13 },
  speed: 26,
  idleSec: [1.6, 5.2],
  maxWalkSec: 4.5
}

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a)
}

/** 随机挑一个目标点；靠近边界时把目标拉回区内，避免贴边抖动 */
export function pickTarget(
  s: WalkerState,
  area: RoamArea
): { tx: number; tz: number } {
  const edgeX = Math.abs(s.x) > area.halfX * 0.72
  const edgeZ = Math.abs(s.z) > area.halfZ * 0.72
  // 贴边时把目标点取到对侧，形成「走回去」的自然行为
  const tx = edgeX ? -Math.sign(s.x) * rand(area.halfX * 0.2, area.halfX * 0.8) : rand(-area.halfX, area.halfX)
  const tz = edgeZ ? -Math.sign(s.z) * rand(0, area.halfZ * 0.6) : rand(-area.halfZ, area.halfZ)
  return { tx, tz }
}

export function initialWalker(cfg: WalkerConfig = DEFAULT_WALKER): WalkerState {
  return {
    x: 0,
    z: 0,
    facing: 1,
    gait: 'idle',
    since: 0,
    tx: 0,
    tz: 0,
    waitFor: rand(cfg.idleSec[0], cfg.idleSec[1])
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * 推进一步（dt 秒）。返回新状态（不修改入参）。
 * 调用方按 gait 驱动 3D 动画：idle 呼吸、walk 迈步、pet/eat 由交互触发。
 */
export function stepWalker(
  s: WalkerState,
  dt: number,
  cfg: WalkerConfig = DEFAULT_WALKER
): WalkerState {
  const d = Math.min(Math.max(dt, 0), 0.1) // 掉帧/休眠后不做大跳
  let { x, z, facing, gait, since, tx, tz, waitFor } = s
  since += d

  // 交互类步态由外部（setAction）控制结束，状态机不自动切换
  if (gait === 'pet' || gait === 'eat' || gait === 'sleep') {
    return { x, z, facing, gait, since, tx, tz, waitFor }
  }

  if (gait === 'walk') {
    const dx = tx - x
    const dz = tz - z
    const dist = Math.hypot(dx, dz)
    if (dist < 1.2 || since > cfg.maxWalkSec) {
      const t = pickTarget({ x, z, facing, gait, since, tx, tz, waitFor }, cfg.area)
      return {
        x,
        z,
        facing,
        gait: 'idle',
        since: 0,
        tx: t.tx,
        tz: t.tz,
        waitFor: rand(cfg.idleSec[0], cfg.idleSec[1])
      }
    }
    const step = cfg.speed * d
    x = clamp(x + (dx / dist) * step, -cfg.area.halfX, cfg.area.halfX)
    z = clamp(z + (dz / dist) * step, -cfg.area.halfZ, cfg.area.halfZ)
    if (Math.abs(dx) > 0.6) facing = dx > 0 ? 1 : -1
    return { x, z, facing, gait, since, tx, tz, waitFor }
  }

  // idle：等待计时结束 → 选点起走
  waitFor -= d
  if (waitFor <= 0) {
    const t = pickTarget(s, cfg.area)
    return { x, z, facing, gait: 'walk', since: 0, tx: t.tx, tz: t.tz, waitFor: 0 }
  }
  return { x, z, facing, gait, since, tx, tz, waitFor }
}

/** 外部交互：撸一把 / 喂食 / 睡觉（null = 回到自主行为） */
export function setWalkerAction(s: WalkerState, action: 'pet' | 'eat' | 'sleep' | null): WalkerState {
  if (action === null) {
    // 交互结束：原地回到 idle 发呆，重新计时
    return { ...s, gait: 'idle', since: 0, waitFor: rand(1.2, 3.2) }
  }
  return { ...s, gait: action, since: 0 }
}
