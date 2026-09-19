// shared/pet.ts 行为测试（纯函数，node 直接跑）
// 用法：node scripts/test-pet.mjs
//
// 覆盖：惰性衰减（含亲密度下限）、撸一把冷却、喂食上限、经验/升级、
//       序列化往返、导出/导入迁移文件、心情判定。

import { loadTs } from './lib/load-ts.mjs'

const {
  PETS,
  PET_DECAY,
  PET_COOLDOWN_MS,
  addExp,
  applyDecay,
  buildPetExport,
  decodePetState,
  defaultPetState,
  encodePetState,
  expNeed,
  feedOnce,
  parsePetImport,
  petMeta,
  petMood,
  petOnce,
  petVitality
} = await loadTs('src/shared/pet.ts')

let pass = 0
let fail = 0
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}\n      实际: ${a}\n      期望: ${e}`)
  }
}

const HOUR = 3_600_000
const T0 = Date.parse('2026-09-14T10:00:00.000Z')

console.log('用例 1：默认状态与角色元数据')
const def = defaultPetState('aria', T0)
eq(def.version, 1, '版本号 = 1')
eq(def.id, 'aria', '默认角色')
eq(def.level, 1, '初始等级 1')
eq(def.affection, 60, '初始亲密度 60')
eq(def.fullness, 70, '初始饱食度 70')
eq(petMeta('aria').name, 'Aria', '角色元数据（Aria）')
eq(petMeta('ray').name, 'Ray', '角色元数据（Ray）')
eq(petMeta('nope').id, 'aria', '未知角色回退到默认')

console.log('用例 2：惰性衰减（不足 1 分钟不结算）')
eq(applyDecay(def, T0 + 30_000).fullness, 70, '30 秒内不变')
const decayed = applyDecay(def, T0 + 10 * HOUR)
eq(Math.round(decayed.fullness), Math.round(70 - PET_DECAY.fullnessPerHour * 10), '10 小时饱食度按小时衰减')
eq(Math.round(decayed.affection), Math.round(60 - PET_DECAY.affectionPerHour * 10), '10 小时亲密度按小时衰减')
eq(decayed.lastTickAt, T0 + 10 * HOUR, '结算时间前移')
const drained = applyDecay({ ...def, affection: 12 }, T0 + 100 * HOUR)
eq(drained.affection, PET_DECAY.affectionFloor, '亲密度不会低于下限')
eq(drained.fullness, 0, '饱食度下限 0')
eq(applyDecay(def, T0 - 5 * HOUR).fullness, 70, '时间倒流不衰减（max 0）')

console.log('用例 3：撸一把（+亲密度 +经验，带冷却）')
const pet1 = petOnce(def, T0)
eq(pet1.ok, true, '首次撸一把成功')
eq(pet1.state.affection, 65, '亲密度 +5')
eq(pet1.state.exp, 3, '经验 +3')
const pet2 = petOnce(pet1.state, T0 + PET_COOLDOWN_MS - 1)
eq(pet2.ok, false, '冷却中失败')
eq(pet2.reason, 'cooldown', '失败原因是冷却')
eq(pet2.state.affection, 65, '冷却中不改状态')
eq(petOnce(pet1.state, T0 + PET_COOLDOWN_MS).ok, true, '冷却结束可再撸')
eq(petOnce({ ...def, affection: 99 }, T0).state.affection, 100, '亲密度封顶 100')

console.log('用例 4：喂食（+饱食度 +亲密度，吃饱拒绝）')
const fed = feedOnce(def, T0)
eq(fed.ok, true, '正常喂食成功')
eq(fed.state.fullness, 100, '饱食度 +30 并封顶 100')
eq(fed.state.affection, 63, '亲密度 +3')
const full = feedOnce({ ...def, fullness: 95 }, T0)
eq(full.ok, false, '饱食度达上限时拒绝')
eq(full.reason, 'full', '拒绝原因是吃饱')
eq(full.state.fullness, 95, '拒绝时不改状态')

console.log('用例 5：经验与升级')
eq(expNeed(1), 50, '1 级需 50 经验')
eq(expNeed(3), 90, '3 级需 90 经验')
const lv2 = addExp({ ...def, exp: 48 }, 2)
eq(lv2.state.level, 2, '刚好升级')
eq(lv2.state.exp, 0, '升级后经验清零（结余）')
eq(lv2.levelUps, 1, '升级次数 1')
const lv3 = addExp({ ...def, level: 1, exp: 0 }, 50 + 70 + 5)
eq(lv3.state.level, 3, '连续升到 3 级')
eq(lv3.levelUps, 2, '连续升级次数 2')
eq(lv3.state.exp, 5, '结余经验正确')

console.log('用例 6：心情与活力值')
eq(petMood({ ...def, fullness: 20 }), 'hungry', '饿 → hungry')
eq(petMood({ ...def, affection: 10 }), 'lonely', '缺爱 → lonely')
eq(petMood({ ...def, affection: 80, fullness: 80 }), 'happy', '状态好 → happy')
eq(petMood(def), 'fine', '默认 → fine')
eq(petVitality({ ...def, affection: 60, fullness: 80 }), 70, '活力值 = 两者均值')
eq(petVitality({ ...def, affection: 0, fullness: 100 }), 50, '边界活力值')

console.log('用例 7：序列化往返（extras 存储）')
const encoded = encodePetState(def)
eq(typeof encoded, 'string', '编码为字符串')
eq(decodePetState(encoded, T0).id, 'aria', '解码还原角色')
eq(decodePetState(encoded, T0).fullness, 70, '解码还原数值')
eq(decodePetState(null), null, '空值 → null')
eq(decodePetState('not json'), null, '坏 JSON → null')
eq(decodePetState('{}', T0).id, 'aria', '缺字段用默认值兜底')
eq(decodePetState(JSON.stringify({ id: 'hacker', level: 1000, affection: 999, name: '   ' }), T0).id, 'aria', '非法角色回退')
eq(decodePetState(JSON.stringify({ id: 'dino', level: 1000, affection: 999 }), T0).level, 99, '等级封顶 99')
eq(decodePetState(JSON.stringify({ id: 'dino' }), T0).id, 'aria', '旧角色 dino 迁移到 aria')
eq(decodePetState(JSON.stringify({ id: 'slime' }), T0).id, 'aria', '旧角色 slime 迁移到 aria')
// 已下线的 8 只 Q 版动物：养成进度不能丢，一律迁到现役数字人
eq(decodePetState(JSON.stringify({ id: 'shiba', level: 7 }), T0).id, 'aria', '下线动物 shiba 迁移到 aria')
eq(decodePetState(JSON.stringify({ id: 'shiba', level: 7 }), T0).level, 7, '迁移保留等级（不清零）')
eq(decodePetState(JSON.stringify({ id: '不存在' }), T0).id, PETS[0].id, '未知角色回落到第一只')
eq(decodePetState(JSON.stringify({ id: 'dino', affection: 999 }), T0).affection, 100, '亲密度封顶 100')
eq(decodePetState(JSON.stringify({ id: 'dino', name: 'x'.repeat(50) }), T0).name.length, 12, '名字截断 12 字')

console.log('用例 8：导出/导入（数据迁移）')
const file = buildPetExport(def, T0)
const parsedFile = JSON.parse(file)
eq(parsedFile.app, 'BalanceDeck', '导出文件带应用标识')
eq(parsedFile.kind, 'pet', '导出文件带类型标识')
eq(parsedFile.version, 1, '导出文件带版本号')
eq(typeof parsedFile.exportedAt, 'string', '导出时间 ISO 字符串')
eq(parsePetImport(file, T0).id, 'aria', '导入还原角色')
eq(parsePetImport(file, T0).fullness, 70, '导入还原数值')
eq(parsePetImport('{"kind":"other"}', T0), null, '非宠物文件 → null')
eq(parsePetImport('garbage', T0), null, '坏文件 → null')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
