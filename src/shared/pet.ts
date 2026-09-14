// ═══════════════════════════════════════════════════════════════════════════════
// 宠物精灵：状态模型与成长算法
//
// 纯函数（无 React / Electron 依赖），渲染层与单元测试共用：
//   · 惰性衰减：饱食度随时间下降、亲密度缓慢回落（不需要常驻定时器，读取时按时间差结算）
//   · 互动：撸一把（加亲密度/经验，带冷却）、喂食（加饱食度，吃饱会拒绝）
//   · 成长：经验 → 等级（升级所需经验随等级增长）
//   · 持久化：encode/decode 为单行 JSON，存 extras.ui:petState；导出/导入即数据迁移
//
// 角色全部为原创 Q 版精灵（无版权风险）；素材以 SVG 描述，见 renderer/PetSprites.tsx。
// ═══════════════════════════════════════════════════════════════════════════════

export type PetId = 'mochi' | 'shiba' | 'penguin' | 'dino' | 'slime'

export interface PetMeta {
  id: PetId
  /** 默认名字 */
  name: string
  /** 一句话设定（卡片展示） */
  desc: string
  /** 经典动作名（长按/撸一把时展示） */
  trick: string
}

export const PETS: PetMeta[] = [
  { id: 'mochi', name: '麻薯猫', desc: '软乎乎的三花猫，最爱蹭屏幕', trick: '歪头蹭蹭' },
  { id: 'shiba', name: '豆柴', desc: '热情的小柴犬，一叫就摇尾巴', trick: '甩尾转圈' },
  { id: 'penguin', name: '企鹅仔', desc: '肚子圆滚滚的打工企鹅', trick: '拍拍小翅膀' },
  { id: 'dino', name: '小恐龙', desc: '以为自己很凶的绿恐龙', trick: '嗷呜一声' },
  { id: 'slime', name: '果冻怪', desc: '透明果冻，弹起来会抖三抖', trick: '果冻弹跳' }
]

export function petMeta(id: PetId): PetMeta {
  return PETS.find((p) => p.id === id) ?? PETS[0]
}

export function isPetId(v: unknown): v is PetId {
  return typeof v === 'string' && PETS.some((p) => p.id === v)
}

export interface PetState {
  version: 1
  id: PetId
  name: string
  level: number
  /** 当前等级内已积累的经验 */
  exp: number
  /** 亲密度 0–100 */
  affection: number
  /** 饱食度 0–100 */
  fullness: number
  /** 上次衰减结算时间（epoch ms） */
  lastTickAt: number
  lastPetAt: number
  lastFedAt: number
  createdAt: number
}

/** 惰性衰减速率：每小时 */
export const PET_DECAY = {
  fullnessPerHour: 3,
  affectionPerHour: 0.8,
  /** 亲密度不会掉到该值以下（宠物始终爱你） */
  affectionFloor: 10
} as const

export const PET_COOLDOWN_MS = 5000
/** 饱食度高于此值拒绝投喂 */
export const PET_FEED_LIMIT = 95

/** 升级所需经验（本级）：随等级线性增长 */
export function expNeed(level: number): number {
  return 30 + Math.max(1, level) * 20
}

export function defaultPetState(id: PetId = 'mochi', now = Date.now()): PetState {
  return {
    version: 1,
    id,
    name: petMeta(id).name,
    level: 1,
    exp: 0,
    affection: 60,
    fullness: 70,
    lastTickAt: now,
    lastPetAt: 0,
    lastFedAt: 0,
    createdAt: now
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** 惰性衰减：按距上次结算的时间差扣减饱食度/亲密度（只减不结算时间戳，重复调用幂等） */
export function applyDecay(s: PetState, now: number): PetState {
  const elapsedMs = Math.max(0, now - s.lastTickAt)
  if (elapsedMs < 60_000) return s
  const hours = elapsedMs / 3_600_000
  return {
    ...s,
    affection: clamp(s.affection - PET_DECAY.affectionPerHour * hours, PET_DECAY.affectionFloor, 100),
    fullness: clamp(s.fullness - PET_DECAY.fullnessPerHour * hours, 0, 100),
    lastTickAt: now
  }
}

/** 加经验并按需升级；返回升级次数（UI 用来播升级动画） */
export function addExp(s: PetState, amount: number): { state: PetState; levelUps: number } {
  let exp = s.exp + Math.max(0, amount)
  let level = s.level
  let levelUps = 0
  while (exp >= expNeed(level) && level < 99) {
    exp -= expNeed(level)
    level += 1
    levelUps += 1
  }
  return { state: { ...s, exp, level }, levelUps }
}

/** 撸一把：+亲密度 +经验；冷却中返回 ok:false */
export function petOnce(s: PetState, now: number): { state: PetState; ok: boolean; reason?: 'cooldown' } {
  if (now - s.lastPetAt < PET_COOLDOWN_MS) return { state: s, ok: false, reason: 'cooldown' }
  const withExp = addExp(s, 3)
  return {
    state: {
      ...withExp.state,
      affection: clamp(s.affection + 5, 0, 100),
      lastPetAt: now,
      lastTickAt: now
    },
    ok: true
  }
}

/** 喂食：+饱食度 +亲密度 +经验；吃饱了会拒绝 */
export function feedOnce(s: PetState, now: number): { state: PetState; ok: boolean; reason?: 'full' } {
  if (s.fullness >= PET_FEED_LIMIT) return { state: s, ok: false, reason: 'full' }
  const withExp = addExp(s, 4)
  return {
    state: {
      ...withExp.state,
      fullness: clamp(s.fullness + 30, 0, 100),
      affection: clamp(s.affection + 3, 0, 100),
      lastFedAt: now,
      lastTickAt: now
    },
    ok: true
  }
}

/** 综合心情（喂食/亲密度/等级 → 表情） */
export type PetMood = 'happy' | 'fine' | 'hungry' | 'lonely'

export function petMood(s: PetState): PetMood {
  if (s.fullness < 30) return 'hungry'
  if (s.affection < 30) return 'lonely'
  if (s.affection >= 75 && s.fullness >= 50) return 'happy'
  return 'fine'
}

/** 宠物整体状态（0–100），用于卡片上的状态条颜色 */
export function petVitality(s: PetState): number {
  return Math.round((s.affection + s.fullness) / 2)
}

/** 序列化（单行 JSON，存 extras） */
export function encodePetState(s: PetState): string {
  return JSON.stringify(s)
}

/** 反序列化：宽容解析 + 字段兜底（导入外部文件时防脏数据） */
export function decodePetState(raw: string | null | undefined, now = Date.now()): PetState | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<PetState>
    if (!v || typeof v !== 'object') return null
    const id = isPetId(v.id) ? v.id : 'mochi'
    const base = defaultPetState(id, now)
    const num = (x: unknown, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback)
    return {
      version: 1,
      id,
      name: typeof v.name === 'string' && v.name.trim() ? v.name.trim().slice(0, 12) : base.name,
      level: clamp(Math.round(num(v.level, 1)), 1, 99),
      exp: Math.max(0, Math.round(num(v.exp, 0))),
      affection: clamp(num(v.affection, base.affection), 0, 100),
      fullness: clamp(num(v.fullness, base.fullness), 0, 100),
      lastTickAt: num(v.lastTickAt, now),
      lastPetAt: num(v.lastPetAt, 0),
      lastFedAt: num(v.lastFedAt, 0),
      createdAt: num(v.createdAt, now)
    }
  } catch {
    return null
  }
}

/** 迁移文件包装（导出/导入共用，便于以后扩展） */
export interface PetExportFile {
  app: 'BalanceDeck'
  kind: 'pet'
  version: 1
  exportedAt: string
  state: PetState
}

export function buildPetExport(s: PetState, now = Date.now()): string {
  const file: PetExportFile = {
    app: 'BalanceDeck',
    kind: 'pet',
    version: 1,
    exportedAt: new Date(now).toISOString(),
    state: s
  }
  return JSON.stringify(file, null, 2)
}

export function parsePetImport(text: string, now = Date.now()): PetState | null {
  try {
    const v = JSON.parse(text) as Partial<PetExportFile>
    if (!v || v.kind !== 'pet') return null
    return decodePetState(JSON.stringify(v.state), now)
  } catch {
    return null
  }
}
