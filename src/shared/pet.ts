// ═══════════════════════════════════════════════════════════════════════════════
// 数字助理：身份模型（**不含养成数据**）
//
// 定位是「数字助理」，不是宠物 —— 等级 / 经验 / 亲密度 / 饱食度 / 心情 / 撸一把 / 喂食
// 那一整套养成体系已下线（2026-09-21，用户要求）。这里只剩**身份**：
// 选了哪一位（role）、叫什么名字、什么时候选的。
//
// 纯函数（无 React / Electron 依赖），渲染层与单元测试共用：
//   · 归一化：旧角色 id 迁到现役；未识别回落到第一位
//   · 持久化：encode/decode 为单行 JSON，存 extras.ui:petState（键名沿用，值已瘦身）
//
// 角色是 MIT 真人系骨骼模型（Microsoft Rocketbox，见 renderer/pet3d/human.ts），
// 动作编排见 renderer/pet3d/gesture.ts。
// ═══════════════════════════════════════════════════════════════════════════════

export type PetId = 'aria' | 'ray'

/**
 * 旧版角色 id → 现役角色。
 * 含早期自绘精灵（dino/slime）与已下线的 8 只 Q 版动物 —— 迁移只影响"选哪一位"，
 * 与养成无关（养成数据已不存在，见文件头）。
 */
export const LEGACY_PET_IDS: Record<string, PetId> = {
  dino: 'aria',
  slime: 'aria',
  mochi: 'aria',
  shiba: 'aria',
  penguin: 'aria',
  fox: 'aria',
  panda: 'aria',
  bunny: 'aria',
  koala: 'aria',
  tiger: 'aria'
}

export interface PetMeta {
  id: PetId
  /** 默认名字 */
  name: string
  /** 一句话设定（设置页与右键菜单展示） */
  desc: string
  /** 招牌小动作（鼠标停在头像上能看到）：两人**不一样** */
  trick: string
}

export const PETS: PetMeta[] = [
  { id: 'aria', name: 'Aria', desc: '干练的商务助理，汇报额度从不含糊', trick: '捋捋头发' },
  { id: 'ray', name: 'Ray', desc: '沉稳的商务助理，走路带风', trick: '耸耸肩' }
]

export function petMeta(id: PetId): PetMeta {
  return PETS.find((p) => p.id === id) ?? PETS[0]
}

export function isPetId(v: unknown): v is PetId {
  return typeof v === 'string' && PETS.some((p) => p.id === v)
}

/** 归一化角色 id：现役直接返回，旧版按 LEGACY_PET_IDS 迁移，未识别回落到第一只 */
export function normalizePetId(v: unknown): PetId {
  if (isPetId(v)) return v
  if (typeof v === 'string' && LEGACY_PET_IDS[v]) return LEGACY_PET_IDS[v]
  return PETS[0].id
}

/**
 * 系统语音的音色性别 —— **助理身份的一部分**，不是播报偏好。
 *
 * 为什么放这里：用户在设置页要回答的问题一直是「谁（哪个助理）替我说话」，
 * 而原来的实现要他对着「女声/男声」这个技术概念另选一次，两处各答一遍还会打架。
 * 现在性别由 `pet.id` 现算：换助理立刻生效，不必重启、也不必落盘。
 * （原先的 ui:voiceGender 已下线，见 09-29-voice-settings-refactor/design.md §4。）
 */
export type VoiceGender = 'female' | 'male'

export const PET_GENDER: Record<PetId, VoiceGender> = {
  aria: 'female',
  ray: 'male'
}

/** 助理对应的系统语音性别。未知 id 按 normalizePetId 归一，不抛（与本文件其它入口一致） */
export function petGender(id: PetId): VoiceGender {
  return PET_GENDER[normalizePetId(id)]
}

/** 数字助理的身份：选了谁、叫什么 */
export interface PetState {
  version: 1
  id: PetId
  name: string
  createdAt: number
}

export function defaultPetState(id: PetId = 'aria', now = Date.now()): PetState {
  return { version: 1, id, name: petMeta(id).name, createdAt: now }
}

/** 序列化（单行 JSON，存 extras） */
export function encodePetState(s: PetState): string {
  return JSON.stringify(s)
}

/**
 * 反序列化：宽容解析 + 字段兜底。
 * 旧版本存过等级/亲密度/饱食度等养成字段 —— 这里**只取身份**，其余一律忽略，
 * 于是升级后用户的"选了谁 + 叫什么"原样保留，养成数据静默作废（不再参与任何逻辑）。
 */
export function decodePetState(raw: string | null | undefined, now = Date.now()): PetState | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<PetState>
    if (!v || typeof v !== 'object') return null
    const id = normalizePetId(v.id)
    const base = defaultPetState(id, now)
    return {
      version: 1,
      id,
      name: typeof v.name === 'string' && v.name.trim() ? v.name.trim().slice(0, 12) : base.name,
      createdAt: typeof v.createdAt === 'number' && Number.isFinite(v.createdAt) ? v.createdAt : now
    }
  } catch {
    return null
  }
}
