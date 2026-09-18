// pet3d/walker.ts 行为测试（纯函数状态机，node 直接跑）
// 用法：node scripts/test-walker.mjs
//
// 覆盖：idle→walk 切换、朝目标前进、朝向翻转、贴边回头（目标点拉回区内）、
//       到达/超时回到 idle、漫游区硬边界、漫游区中途变小（夹回边上且不抖动）、
//       交互步态（撸一把/喂食/睡觉）的接管与恢复、
//       dt 上限（掉帧/休眠不大跳）、幂等性（不修改入参）。

import { loadTs } from './lib/load-ts.mjs'

const {
  DEFAULT_WALKER,
  initialWalker,
  pickTarget,
  setWalkerAction,
  stepWalker
} = await loadTs('src/renderer/src/pet3d/walker.ts')

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

const CFG = { area: { halfX: 50, halfZ: 10 }, speed: 20, idleSec: [1, 2], maxWalkSec: 3 }

// ─── 初始状态 ────────────────────────────────────────────────────────────────
const s0 = initialWalker(CFG)
eq([s0.x, s0.z, s0.gait], [0, 0, 'idle'], '初始：原点发呆')
ok(s0.waitFor >= 1 && s0.waitFor <= 2, '初始：等待时长落在 idleSec 区间')

// ─── idle → walk（dt 逐帧推进；单次 dt 被夹在 0.1s 内）──────────────────────
let s = stepWalker(s0, 0.1, CFG)
eq(s.gait, 'idle', 'idle 期间不走路')
for (let i = 0; i < 25 && s.gait === 'idle'; i++) s = stepWalker(s, 0.1, CFG)
eq(s.gait, 'walk', '等待结束后开始走')
ok(Math.abs(s.tx) <= 50 && Math.abs(s.tz) <= 10, '目标点在漫游区内')

// ─── 朝目标前进 ──────────────────────────────────────────────────────────────
let moving = { ...s, tx: 40, tz: 0, x: 0, z: 0, gait: 'walk', since: 0 }
for (let i = 0; i < 5; i++) moving = stepWalker(moving, 0.1, CFG)
ok(Math.abs(moving.x - 10) < 0.001, '按速度前进（20/s × 0.5s = 10）')
eq(moving.facing, 1, '向右走时朝右')

const back = stepWalker({ ...moving, tx: -40, gait: 'walk', since: 0 }, 0.1, CFG)
eq(back.facing, -1, '向左走时翻转朝向')

// ─── 到达 → 回到 idle 并重新计时 ─────────────────────────────────────────────
const arrived = stepWalker({ ...moving, tx: moving.x + 0.5, tz: moving.z, gait: 'walk', since: 0.2 }, 0.1, CFG)
eq(arrived.gait, 'idle', '到达目标后回到 idle')
ok(arrived.waitFor >= 1 && arrived.waitFor <= 2, '回到 idle 后重新随机等待')

// ─── 超时保护 ────────────────────────────────────────────────────────────────
const timeouted = stepWalker({ ...moving, tx: 1000, tz: 0, gait: 'walk', since: 9 }, 0.1, CFG)
eq(timeouted.gait, 'idle', '走路超时（maxWalkSec）强制回 idle')

// ─── 漫游区硬边界 ────────────────────────────────────────────────────────────
let edge = { x: 49, z: 9, facing: 1, gait: 'walk', since: 0, tx: 999, tz: 999, waitFor: 0 }
for (let i = 0; i < 40; i++) edge = stepWalker(edge, 0.1, CFG)
ok(Math.abs(edge.x) <= 50.0001 && Math.abs(edge.z) <= 10.0001, '不会走出漫游区')

// ─── 贴边回头：目标点取到对侧 ────────────────────────────────────────────────
const t = pickTarget({ x: 48, z: 0, facing: 1, gait: 'idle', since: 0, tx: 0, tz: 0, waitFor: 0 }, CFG.area)
ok(t.tx < 0, '贴右边界时目标点取到左侧（形成回头行为）')
const tIn = pickTarget({ x: 0, z: 0, facing: 1, gait: 'idle', since: 0, tx: 0, tz: 0, waitFor: 0 }, CFG.area)
ok(Math.abs(tIn.tx) <= 50, '区中心时目标点仍在区内')

// ─── 交互步态接管 ────────────────────────────────────────────────────────────
const petting = setWalkerAction({ ...moving, gait: 'walk' }, 'pet')
eq(petting.gait, 'pet', '撸一把接管步态')
const stillPetting = stepWalker(petting, 1, CFG)
eq([stillPetting.gait, stillPetting.x, stillPetting.z], ['pet', petting.x, petting.z], '交互期间不自主移动')
const resumed = setWalkerAction(stillPetting, null)
eq(resumed.gait, 'idle', '交互结束后回到 idle')
ok(resumed.waitFor > 0, '交互结束后重新等待')

for (const g of ['eat', 'sleep']) {
  eq(setWalkerAction(s0, g).gait, g, `${g} 步态可设置`)
}

// ─── dt 上限：掉帧/休眠后不做大跳 ────────────────────────────────────────────
const bigStep = stepWalker({ ...moving, x: 0, z: 0, tx: 40, tz: 0, gait: 'walk', since: 0 }, 10, CFG)
ok(Math.abs(bigStep.x) <= 2.0001, 'dt 被夹到 0.1s（一帧最多走 speed×0.1）')

// ─── 幂等：不修改入参 ────────────────────────────────────────────────────────
const before = { ...moving }
stepWalker(moving, 0.2, CFG)
eq(moving, before, 'stepWalker 不修改入参')

// ─── 漫游区变小（视口反算改了 area）：先夹回再走 ─────────────────────────────
{
  const outside = { x: 90, z: 40, facing: 1, gait: 'idle', since: 0, tx: 0, tz: 0, waitFor: 5 }
  const shrunk = stepWalker(outside, 0.016, CFG)
  eq([shrunk.x, shrunk.z], [50, 10], 'idle 时越界位置被夹回可行区边上')

  const pushOut = { x: 90, z: 40, facing: 1, gait: 'walk', since: 0, tx: 90, tz: 40, waitFor: 0 }
  let pinned = pushOut
  for (let i = 0; i < 30; i++) pinned = stepWalker(pinned, 0.05, CFG)
  eq([pinned.x, pinned.z], [50, 10], '目标在区外时贴着边停住（不来回抖）')

  let walkIn = { ...pinned, gait: 'walk', tx: -40, tz: -8, since: 0 }
  for (let i = 0; i < 10; i++) walkIn = stepWalker(walkIn, 0.1, CFG)
  ok(walkIn.x < 50 && walkIn.z < 10, '区内目标立刻能从边上走回来')

  let ro = { x: 0, z: 0, facing: 1, gait: 'idle', since: 0, tx: 0, tz: 0, waitFor: 0.01 }
  let targetsIn = true
  for (let i = 0; i < 400; i++) {
    ro = stepWalker(ro, 0.1, CFG)
    if (Math.abs(ro.tx) > CFG.area.halfX + 0.0001 || Math.abs(ro.tz) > CFG.area.halfZ + 0.0001) targetsIn = false
  }
  ok(targetsIn, '长时间随机走：目标点始终落在可行区内（area 变小也不会选出不可达目标）')
  ok(Math.abs(ro.x) <= 50.0001 && Math.abs(ro.z) <= 10.0001, '长时间随机走不会走出可行区')
}

// ─── 默认配置可用 ────────────────────────────────────────────────────────────
const d = stepWalker(initialWalker(), 0.05)
ok(d.x === 0 && d.gait === 'idle', '默认配置下正常推进')
ok(DEFAULT_WALKER.speed > 0 && DEFAULT_WALKER.area.halfX > 0, '默认配置自洽')

console.log(`\nwalker: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
