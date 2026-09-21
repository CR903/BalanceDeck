// ═══════════════════════════════════════════════════════════════════════════════
// 数字人动作：目录（有哪些动作）+ 时长口径 + 调度（什么时候播）
//
// 纯函数模块（无 three / 无 DOM / 无 React），scripts/test-gesture.mjs 直接跑。
// 三层职责刻意分开，各自可单独推理与断言：
//   · GESTURES    目录：一个动作由若干**步**组成，每步 = 一段剪辑 + 一段程序化体态
//   · resolveStep 时长：剪辑时长 / 显式秒数 / 由步幅速度反算的走动时长（三种口径都在这里）
//   · stepPlan    调度：静息 → 抽一个**已就位**的动作 → 播完回静息；外部可插队
//
// 为什么"就位"要参与调度：动作剪辑是**懒加载**的（见 clips.ts / human.ts）。抽到一个还没
// 下载完的动作就播，会得到一段静止的站立 —— 宁可让它继续静息、1.2 秒后重抽。
//
// 走动为什么要按步幅速度反算时长：walk 剪辑自带根位移（实测一圈 ≈33 世界单位），场景抵消它、
// 自己驱动位移。若位移速度与剪辑步幅不一致，脚下就会打滑（"月球漫步"）—— 所以走动时长
// 只能由 strideSpeed 反算，不能手填秒数。
// ═══════════════════════════════════════════════════════════════════════════════

import type { HumanClip } from './clips'

export type GestureId =
  // 进出场（每位角色都有，长动作）
  | 'enter'
  | 'exit'
  // 交互与问候（外部触发）
  | 'wave'
  | 'clap'
  | 'drink'
  | 'talk'
  // 平时随机动作（≥5 个/角色，具体可用性由素材表决定）
  | 'lookAround'
  | 'stretch'
  | 'think'
  | 'fixHair'
  | 'rollHead'
  | 'shrug'
  | 'shakeArms'

// ─── 体态：程序化叠层 ─────────────────────────────────────────────────────────
/** 相对基准站位的体态偏移（世界单位 / 弧度） */
export interface Pose {
  /** 左右位置 */
  x: number
  /** 相对地面的抬升（负 = 下蹲） */
  y: number
  /** 偏航：0 = 面向镜头，+π/2 = 面向 +x（屏幕右方，即"向右走"） */
  yaw: number
  /** 前倾（正 = 向前/朝镜头） */
  lean: number
}

export const STILL: Pose = { x: 0, y: 0, yaw: 0, lean: 0 }

/** 场景口径的常量（由 rig.ts 与素材实测值算好后注入，动作目录不自己造数） */
export interface GestureCtx {
  /** 完全走出窗口所需的 |x|：可见半宽 + 人物半宽（两侧都出了才算"场外"） */
  offStageX: number
  /** 走动的自然速度（世界单位/秒）：walk 剪辑的根位移 ÷ 剪辑时长 */
  strideSpeed: number
}

/** 兜底口径：只在素材未就位时用（真值由 scene.ts 按 rig 注入） */
export const FALLBACK_CTX: GestureCtx = { offStageX: 34, strideSpeed: 27 }

/** 程序化体态：p ∈ [0,1] 是本步的进度 */
export type Motion = (p: number, ctx: GestureCtx) => Pose

const easeOutCubic = (p: number): number => 1 - Math.pow(1 - p, 3)
const easeInCubic = (p: number): number => p * p * p

/** 站着不动（动作全在剪辑里） */
export const mStill: Motion = () => STILL

/** 入场：从场外左侧走到中心，走的时候面朝行进方向 */
export const mWalkIn: Motion = (p, ctx) => ({
  x: -ctx.offStageX * (1 - easeOutCubic(p)),
  y: 0,
  yaw: Math.PI / 2,
  lean: 0.03
})

/** 退场：从中心走到场外右侧；起步 18% 内从正面转到行进方向（转身，不是横着滑） */
export const mWalkOut: Motion = (p, ctx) => ({
  x: ctx.offStageX * easeInCubic(p),
  y: 0,
  yaw: (Math.PI / 2) * Math.min(1, p / 0.18),
  lean: 0.03
})

/** 走到位后转回正面（入场第二步：站定挥手时朝观众） */
export const mFaceFront: Motion = (p) => ({
  ...STILL,
  yaw: (Math.PI / 2) * (1 - Math.min(1, p / 0.28))
})

/**
 * 在剪辑之上叠一点身体起伏：首尾归零、中段最大（bump）——
 * 不归零就会在动作切换的瞬间看到"啪"地跳一下。
 */
export function mAccent(a: { rise?: number; lean?: number; sway?: number; hop?: number }): Motion {
  return (p) => {
    const bump = Math.sin(Math.PI * p)
    return {
      x: 0,
      y: (a.rise ?? 0) * bump + (a.hop ? Math.abs(Math.sin(Math.PI * p * 2)) * a.hop : 0),
      yaw: (a.sway ?? 0) * Math.sin(2 * Math.PI * p),
      lean: (a.lean ?? 0) * bump
    }
  }
}

// ─── 目录 ─────────────────────────────────────────────────────────────────────
/**
 * 时长口径：
 *   · 'clip'   —— 用剪辑自身时长（一次性动作：挥手/鼓掌/喝水…）
 *   · 'travel' —— 用「场外距离 ÷ 步幅速度」反算（走动用循环剪辑，没有"结束"这回事）
 *   · number   —— 显式秒数（剪辑比该动作长/短时的裁剪）
 */
export type Span = 'clip' | 'travel' | number

export interface Step {
  clip: HumanClip
  span: Span
  /** 走动方向：'in' 从场外走进来 / 'out' 走出场外（两者都朝 +x 走） */
  travel?: 'in' | 'out'
  /** 剪辑倍速（>1 更快）；默认 1 */
  rate?: number
  motion: Motion
  /** 一句话说明（台架日志与文档用） */
  label: string
}

export interface Gesture {
  id: GestureId
  label: string
  steps: Step[]
  /** 随机池权重；0 = 不参与随机（进出场、交互、问候） */
  weight: number
}

export const GESTURES: Record<GestureId, Gesture> = {
  // ── 进出场：用户要求「每个人要有独立的进出场动作」 ──
  enter: {
    id: 'enter',
    label: '进场',
    weight: 0,
    steps: [
      { clip: 'walk', span: 'travel', travel: 'in', motion: mWalkIn, label: '从场外走入' },
      { clip: 'wave', span: 'clip', motion: mFaceFront, label: '站定挥手' }
    ]
  },
  exit: {
    id: 'exit',
    label: '退场',
    weight: 0,
    steps: [
      { clip: 'wave', span: 'clip', motion: mStill, label: '挥手告别' },
      { clip: 'walk', span: 'travel', travel: 'out', motion: mWalkOut, label: '转身走出场' }
    ]
  },
  // ── 交互（外部触发：问候 / 撸一把 / 喂食 / 播报） ──
  wave: {
    id: 'wave',
    label: '打招呼',
    weight: 0,
    steps: [{ clip: 'wave', span: 'clip', motion: mStill, label: '挥手' }]
  },
  clap: {
    id: 'clap',
    label: '鼓掌',
    weight: 0,
    steps: [{ clip: 'clap', span: 'clip', motion: mAccent({ hop: 0.35 }), label: '鼓掌' }]
  },
  drink: {
    id: 'drink',
    label: '喝口水',
    weight: 0,
    steps: [{ clip: 'drink', span: 'clip', motion: mStill, label: '喝水' }]
  },
  talk: {
    id: 'talk',
    label: '比划着说话',
    weight: 0,
    steps: [{ clip: 'talk', span: 'clip', motion: mStill, label: '讲话' }]
  },
  // ── 平时随机动作：每位角色至少 5 个（可用性由 clips.ts 的素材表裁剪） ──
  lookAround: {
    id: 'lookAround',
    label: '东张西望',
    weight: 3,
    steps: [{ clip: 'lookAround', span: 'clip', motion: mStill, label: '张望' }]
  },
  stretch: {
    id: 'stretch',
    label: '伸个懒腰',
    weight: 2,
    steps: [{ clip: 'stretch', span: 'clip', motion: mAccent({ rise: 0.9, lean: -0.04 }), label: '伸展' }]
  },
  think: {
    id: 'think',
    label: '若有所思',
    weight: 2,
    steps: [{ clip: 'think', span: 'clip', motion: mAccent({ lean: 0.05 }), label: '思考' }]
  },
  fixHair: {
    id: 'fixHair',
    label: '捋捋头发',
    weight: 2,
    steps: [{ clip: 'fixHair', span: 'clip', motion: mStill, label: '整理仪容' }]
  },
  rollHead: {
    id: 'rollHead',
    label: '活动下脖子',
    weight: 2,
    steps: [{ clip: 'rollHead', span: 'clip', motion: mAccent({ sway: 0.05 }), label: '转脖子' }]
  },
  shrug: {
    id: 'shrug',
    label: '耸耸肩',
    weight: 2,
    steps: [{ clip: 'shrug', span: 'clip', motion: mStill, label: '耸肩' }]
  },
  shakeArms: {
    id: 'shakeArms',
    label: '甩甩手',
    weight: 2,
    steps: [{ clip: 'shakeArms', span: 'clip', motion: mStill, label: '甩手' }]
  }
}

/** 静息用哪段剪辑（`plan.cur === null` 时播它，循环） */
export const REST_CLIP: HumanClip = 'idle'

/**
 * 这位角色可用的随机动作池：目录 ∩ 素材表。
 * 「每个人有独立的平时随机动作」就落在这一行 —— 池子是数据的产物，不是写死的名单。
 */
export function randomPool(has: (clip: HumanClip) => boolean): GestureId[] {
  return (Object.keys(GESTURES) as GestureId[]).filter(
    (id) => GESTURES[id].weight > 0 && GESTURES[id].steps.every((s) => has(s.clip))
  )
}

/** 这位角色的全部可用动作（含进出场与交互）：每步的剪辑都在素材表里 */
export function availableGestures(has: (clip: HumanClip) => boolean): GestureId[] {
  return (Object.keys(GESTURES) as GestureId[]).filter((id) => GESTURES[id].steps.every((s) => has(s.clip)))
}

// ─── 时长口径 ─────────────────────────────────────────────────────────────────
/**
 * 这一步该持续多少秒？返回 null = **现在还不能播**（剪辑未就位）。
 * 这一条同时兜住三种"没料"的情形：剪辑没加载、走动却没有步幅速度、步数越界。
 */
export function resolveStep(step: Step, clipSeconds: number | null, ctx: GestureCtx): number | null {
  if (clipSeconds == null) return null
  const rate = step.rate ?? 1
  if (step.span === 'clip') return clipSeconds / rate
  if (step.span === 'travel') {
    if (!(ctx.strideSpeed > 0) || !(ctx.offStageX > 0)) return null
    return ctx.offStageX / (ctx.strideSpeed * rate)
  }
  return step.span / rate
}

// ─── 调度 ─────────────────────────────────────────────────────────────────────
/** 静息时长范围（秒）：桌面伴侣的节奏 —— 一直在动会吵，一动不动像贴图 */
export const DWELL_SEC: [number, number] = [5, 11]
/** 抽到的动作还没就位时的重试间隔（秒） */
export const RETRY_SEC = 1.2

export interface GesturePlan {
  /** 当前动作；null = 静息 */
  cur: GestureId | null
  /** 当前第几步 */
  step: number
  /** 当前步已播秒数 */
  since: number
  /** 静息时：距离下一次抽动作的秒数 */
  waitFor: number
  /**
   * 静息期间**已经选好**的下一个动作：场景据此在后台预取它的剪辑。
   * 为什么不能等倒计时结束才抽：剪辑是懒加载的，抽完立刻开播只会播成"站着不动"。
   * 提前一整个静息时长（5–11 秒）去加载，开播时它必然就位。
   */
  planned: GestureId | null
  /** 上一次播完的动作（随机时不连续重复同一个） */
  last: GestureId | null
}

export interface GestureEnv {
  /** 该动作该步的时长（秒）；null = 现在还不能播 */
  stepSeconds: (id: GestureId, step: number) => number | null
  /** 可用的随机动作池（randomPool 的产物） */
  pool: GestureId[]
  weightOf: (id: GestureId) => number
  rand: () => number
}

export function dwell(env: GestureEnv): number {
  const [a, b] = DWELL_SEC
  return a + env.rand() * (b - a)
}

export function initialPlan(env: GestureEnv): GesturePlan {
  return { cur: null, step: 0, since: 0, waitFor: dwell(env), planned: pickGesture(env, null), last: null }
}

/** 加权随机（避开刚播过的那个）；权重全为 0 时返回 null */
export function pickGesture(env: GestureEnv, last: GestureId | null): GestureId | null {
  const cands = env.pool.filter((id) => id !== last || env.pool.length === 1)
  const total = cands.reduce((s, id) => s + Math.max(0, env.weightOf(id)), 0)
  if (total <= 0) return null
  let r = env.rand() * total
  for (const id of cands) {
    r -= Math.max(0, env.weightOf(id))
    if (r <= 0) return id
  }
  return cands[cands.length - 1] ?? null
}

/** 外部插队（进场/退场/问候/交互）：立刻从头播，静息计时保留 */
export function playNow(plan: GesturePlan, id: GestureId): GesturePlan {
  return { cur: id, step: 0, since: 0, waitFor: plan.waitFor, planned: plan.planned, last: plan.last }
}

/** 回到静息（动作播完 / 被外部打断）：顺手把下一个动作选好，让场景开始预取 */
export function toRest(plan: GesturePlan, env: GestureEnv, last: GestureId | null = plan.last): GesturePlan {
  return { cur: null, step: 0, since: 0, waitFor: dwell(env), planned: pickGesture(env, last), last }
}

export function isPlaying(plan: GesturePlan): boolean {
  return plan.cur !== null
}

export function stepPlan(plan: GesturePlan, dt: number, env: GestureEnv): GesturePlan {
  const d = Math.min(Math.max(dt, 0), 0.25) // 掉帧/休眠后不做大跳
  if (plan.cur === null) {
    // ① 先确保有一个"已选好"的下一个动作（预取的起点）
    const planned = plan.planned ?? pickGesture(env, plan.last)
    const waitFor = plan.waitFor - d
    if (waitFor > 0) return { ...plan, planned, waitFor }
    // ② 到点了：只播**此刻就位**的动作；没就位就继续等它（不换、不空播）
    if (planned && env.stepSeconds(planned, 0) != null) {
      return { cur: planned, step: 0, since: 0, waitFor: 0, planned: null, last: plan.last }
    }
    return { ...plan, planned, waitFor: RETRY_SEC }
  }
  const dur = env.stepSeconds(plan.cur, plan.step)
  // 剪辑在中途消失（换角色/加载失败）→ 回静息，不空转
  if (dur == null) return toRest(plan, env, plan.cur)
  const since = plan.since + d
  if (since < dur) return { ...plan, since }
  const next = plan.step + 1
  if (next < GESTURES[plan.cur].steps.length) return { ...plan, step: next, since: 0 }
  return toRest(plan, env, plan.cur)
}

export interface PlanFrame {
  id: GestureId
  step: number
  clip: HumanClip
  /** 本步进度 0–1 */
  p: number
  /** 本步总时长（秒） */
  seconds: number
}

/** 当前该播哪段剪辑、进度多少；null = 静息（播 REST_CLIP，体态归零） */
export function frameOf(plan: GesturePlan, env: GestureEnv): PlanFrame | null {
  if (plan.cur === null) return null
  const seconds = env.stepSeconds(plan.cur, plan.step)
  if (seconds == null || !(seconds > 0)) return null
  const step = GESTURES[plan.cur].steps[plan.step]
  if (!step) return null
  return {
    id: plan.cur,
    step: plan.step,
    clip: step.clip,
    p: Math.min(1, Math.max(0, plan.since / seconds)),
    seconds
  }
}

/** 当前体态；静息时归零（动作都在剪辑里） */
export function poseOf(plan: GesturePlan, env: GestureEnv, ctx: GestureCtx): Pose {
  const f = frameOf(plan, env)
  if (!f) return STILL
  return GESTURES[f.id].steps[f.step].motion(f.p, ctx)
}
