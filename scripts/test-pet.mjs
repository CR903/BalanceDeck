// shared/pet.ts 行为测试（纯函数，node 直接跑）
// 用法：node scripts/test-pet.mjs
//
// 数字助理的**身份模型**（养成体系已下线，见 shared/pet.ts 文件头）：
//   角色元数据、默认身份、序列化往返、宽容解析（旧数据的等级/亲密度字段一律忽略）、
//   旧角色 id 迁移。

import { loadTs } from './lib/load-ts.mjs'

const { PETS, decodePetState, defaultPetState, encodePetState, isPetId, normalizePetId, petMeta } =
  await loadTs('src/shared/pet.ts')

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
function ok(cond, label) {
  eq(!!cond, true, label)
}

const T0 = Date.parse('2026-09-14T10:00:00.000Z')

console.log('用例 1：默认身份与角色元数据')
const def = defaultPetState('aria', T0)
eq(def.id, 'aria', '默认角色')
eq(def.name, 'Aria', '默认名字取角色表')
eq(def.createdAt, T0, '记录选择时间')
eq(def.version, 1, '带版本号')
eq(Object.keys(def).sort(), ['createdAt', 'id', 'name', 'version'], '身份里没有养成字段')
eq(PETS.length, 2, '两位数字助理可选')
ok(
  PETS.every((p) => p.name && p.desc && p.trick),
  '每位都有名字 / 一句话设定 / 招牌动作'
)
ok(
  new Set(PETS.map((p) => p.trick)).size === PETS.length,
  '招牌动作两人不同'
)
eq(petMeta('ray').name, 'Ray', 'petMeta 按 id 取名')
eq(petMeta('不存在').id, PETS[0].id, '未知 id 回落到第一位')

console.log('用例 2：角色 id 归一化')
eq(normalizePetId('ray'), 'ray', '现役 id 原样返回')
eq(normalizePetId('dino'), 'aria', '早期自绘精灵迁到 aria')
eq(normalizePetId('slime'), 'aria', '早期自绘精灵迁到 aria')
for (const old of ['mochi', 'shiba', 'penguin', 'fox', 'panda', 'bunny', 'koala', 'tiger']) {
  eq(normalizePetId(old), 'aria', `已下线动物 ${old} 迁到 aria`)
}
eq(normalizePetId('不存在'), PETS[0].id, '未知值回落到第一只')
eq(normalizePetId(42), PETS[0].id, '非字符串回落到第一只')
eq(isPetId('aria'), true, 'isPetId 识别现役')
eq(isPetId('shiba'), false, 'isPetId 不认已下线角色')

console.log('用例 3：序列化往返')
const encoded = encodePetState(def)
eq(typeof encoded, 'string', '编码为字符串')
eq(decodePetState(encoded, T0).id, 'aria', '解码还原角色')
eq(decodePetState(encoded, T0).name, 'Aria', '解码还原名字')
eq(decodePetState(null), null, '空值 → null')
eq(decodePetState('not json'), null, '坏 JSON → null')
eq(decodePetState('{}', T0).id, 'aria', '缺字段用默认值兜底')
eq(decodePetState(JSON.stringify({ id: 'hacker', name: '   ' }), T0).id, 'aria', '非法角色回退')
eq(decodePetState(JSON.stringify({ id: 'dino' }), T0).id, 'aria', '旧角色 dino 迁移到 aria')
eq(decodePetState(JSON.stringify({ id: 'shiba' }), T0).id, 'aria', '已下线动物 shiba 迁移到 aria')
eq(decodePetState(JSON.stringify({ id: 'dino', name: 'x'.repeat(50) }), T0).name.length, 12, '名字截断 12 字')
eq(decodePetState(JSON.stringify({ name: '小助手' }), T0).name, '小助手', '自定义名字保留')

console.log('用例 4：旧数据的养成字段被忽略（升级路径）')
// 老版本存过 level/exp/affection/fullness/lastTickAt…：这里只取身份，其余不参与任何逻辑
const legacy = JSON.stringify({
  version: 1,
  id: 'dino',
  name: '老名字',
  level: 7,
  exp: 42,
  affection: 88,
  fullness: 12,
  lastTickAt: T0,
  lastPetAt: T0,
  lastFedAt: T0,
  createdAt: T0
})
const migrated = decodePetState(legacy, T0)
eq(migrated.id, 'aria', '旧角色迁到现役')
eq(migrated.name, '老名字', '自定义名字保住')
eq(migrated.createdAt, T0, '创建时间保住')
eq(Object.keys(migrated).sort(), ['createdAt', 'id', 'name', 'version'], '养成字段一个都不带过来')

console.log('用例 5：非法 createdAt 兜底')
eq(decodePetState(JSON.stringify({ id: 'ray', createdAt: NaN }), T0).createdAt, T0, 'NaN → 用当前时间')
eq(decodePetState(JSON.stringify({ id: 'ray', createdAt: 'x' }), T0).createdAt, T0, '非数字 → 用当前时间')
eq(decodePetState(JSON.stringify({ id: 'ray', createdAt: 123 }), T0).createdAt, 123, '合法数字保留')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
