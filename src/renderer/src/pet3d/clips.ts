// ═══════════════════════════════════════════════════════════════════════════════
// 数字人素材目录表：**逻辑剪辑键 → 素材文件名**（纯数据，无 three / 无 DOM）
//
// 为什么单独成模块：这张表同时被三处消费 ——
//   · human.ts 按它决定「加载哪个 FBX」
//   · gesture.ts 的动作目录按它判断「这位角色有没有这个动作」
//   · scripts/test-gesture.mjs 断言「目录里的每个动作都有素材」「每位角色 ≥5 个随机动作」
//     「表里的文件都在采集脚本的下载清单里」—— 三条都只需要读这张表，不需要 three。
//
// 素材：Microsoft Rocketbox（MIT），`npm run fetch:humans` 拉到 gitignored 的
// resources/human-pets/<id>/anims/<name>.fbx。**每位角色各挑各的**：
// 动作库有 f_/m_ 两套同构素材，但池子不是简单对称 —— aria 有拨头发/转脖子，ray 有耸肩/甩手。
// ═══════════════════════════════════════════════════════════════════════════════

import type { PetId } from '../../../shared/pet'

/** 逻辑剪辑键（与素材文件名解耦：目录表说"要拨头发"，表说 aria 对应哪个文件） */
export type HumanClip =
  // 基础：instantiateHuman 当场就要（决定"人物多快出现"）
  | 'idle'
  | 'walk'
  | 'wave'
  | 'talk'
  // 平时随机动作与交互反应：按需懒加载
  | 'lookAround'
  | 'stretch'
  | 'think'
  | 'fixHair'
  | 'rollHead'
  | 'clap'
  | 'shrug'
  | 'shakeArms'

/**
 * 基础剪辑：加载模型时一并解析。只留**出场那一刻就要用**的三条 ——
 * 静息姿态（idle）+ 进场走动（walk）+ 站定挥手（wave）。
 * 'talk' 不在其中：它只在 90 秒一次的余额播报里用，而它那条素材有 4.77MB
 * （比另外三条加起来还大）—— 放在基础集里等于让每次出场都白等它。
 */
export const BASE_CLIPS: HumanClip[] = ['idle', 'walk', 'wave']

/** 逻辑键 → 素材文件名（缺键 = 这位角色没有这个动作，动作目录会自动跳过它） */
export const CLIPS: Record<PetId, Partial<Record<HumanClip, string>>> = {
  aria: {
    walk: 'f_walk_neutral',
    idle: 'f_idle_breathe_01',
    wave: 'f_wave_01',
    talk: 'f_gestic_talk_neutral_01',
    lookAround: 'f_idle_look_around_01',
    stretch: 'f_idle_stretch_arms_01',
    think: 'f_gestic_thoughtful_01',
    fixHair: 'f_idle_touch_hair_01',
    rollHead: 'f_idle_roll_head_01',
    clap: 'f_claphands_01'
  },
  ray: {
    walk: 'm_walk_neutral',
    idle: 'm_idle_breathe_01',
    wave: 'm_wave_01',
    talk: 'm_gestic_talk_neutral_01',
    lookAround: 'm_idle_look_around_01',
    stretch: 'm_idle_stretch_arms_01',
    think: 'm_gestic_thoughtful_01',
    shrug: 'm_gestic_shrug_01',
    shakeArms: 'm_idle_shake_arms_01',
    clap: 'm_claphands_01'
  }
}

/** 素材文件名（未收录 = undefined，调用方据此跳过） */
export function clipFile(id: PetId, clip: HumanClip): string | undefined {
  return CLIPS[id][clip]
}

/** 这位角色拥有的全部剪辑键（动作目录按它裁剪随机池） */
export function clipsOf(id: PetId): HumanClip[] {
  return Object.keys(CLIPS[id]) as HumanClip[]
}

/** 这位角色有没有这个动作 */
export function hasClip(id: PetId, clip: HumanClip): boolean {
  return typeof CLIPS[id][clip] === 'string'
}
