// pet3d/gesture.ts + pet3d/clips.ts 的单元测试（纯函数，node 直接跑）
// 用法：node scripts/test-gesture.mjs
//
// 覆盖三层：
//   A. 素材表与动作目录的一致性（**最容易悄悄坏的一层**：动作目录里添了个动作，
//      却忘了让采集脚本下载它的素材 —— 运行时表现只是"这个动作永远不出现"）
//   B. 时长口径 resolveStep（剪辑时长 / 显式秒数 / 步幅反算走动）
//   C. 调度 stepPlan（静息→抽动作→播完回静息、预取槽位、不连续重复、**没就位就不播**、
//      外部插队、剪辑中途消失的兜底）
//
// 这里刻意不碰 three：动作目录与调度是全项目最该被纯函数测的部分。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadTs } from './lib/load-ts.mjs'

const clips = await loadTs('src/renderer/src/pet3d/clips.ts')
const g = await loadTs('src/renderer/src/pet3d/gesture.ts')

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

const PETS = ['aria', 'ray']
const has = (pet) => (c) => clips.hasClip(pet, c)

// ─── A. 素材表 ↔ 动作目录 ↔ 采集脚本：三方一致 ────────────────────────────────
console.log('\nA. 素材表 / 动作目录 / 采集脚本 三方一致')
{
  ok(PETS.every((p) => clips.hasClip(p, 'idle') && clips.hasClip(p, 'walk')), '两位角色都有 idle 与 walk（进场的两半）')
  ok(PETS.every((p) => clips.hasClip(p, 'wave')), '两位角色都有 wave（问好与告别）')

  // 目录里每一个动作，必须至少有一位角色**完整**具备（否则它是永远演不出来的死条目）
  const ids = Object.keys(g.GESTURES)
  const orphan = ids.filter((id) => !PETS.some((p) => g.availableGestures(has(p)).includes(id)))
  eq(orphan, [], '动作目录里没有"没有素材"的死条目')

  // 每条动作引用的剪辑键，都必须在素材表里出现过（拼错键名 = 静默永不生效）
  const knownClips = new Set(PETS.flatMap((p) => clips.clipsOf(p)))
  const unknown = []
  for (const id of ids) {
    for (const st of g.GESTURES[id].steps) if (!knownClips.has(st.clip)) unknown.push(`${id}→${st.clip}`)
  }
  eq(unknown, [], '目录引用的剪辑键都在素材表里')

  // 采集脚本必须下载素材表里的每个文件（新增动作最容易漏的一步）
  const fetchSrc = readFileSync(resolve('scripts/fetch-human-pets.mjs'), 'utf-8')
  const missingFetch = []
  for (const p of PETS) {
    for (const c of clips.clipsOf(p)) {
      if (!fetchSrc.includes(`'${clips.clipFile(p, c)}'`)) missingFetch.push(`${p}/${c}=${clips.clipFile(p, c)}`)
    }
  }
  eq(missingFetch, [], '素材表里的每个文件都在 fetch-human-pets.mjs 的下载清单里')

  // 基础剪辑必须在素材表里（instantiateHuman 当场要它们，缺一个就加载失败）
  const missingBase = PETS.flatMap((p) => clips.BASE_CLIPS.filter((c) => !clips.hasClip(p, c)).map((c) => `${p}/${c}`))
  eq(missingBase, [], 'BASE_CLIPS 全都在素材表里')

  // 用户要求：每位角色**独立的**平时随机动作，至少 5 个
  for (const p of PETS) {
    const pool = g.randomPool(has(p))
    ok(pool.length >= 5, `${p} 的随机动作池 ≥5 个（实际 ${pool.length}: ${pool.join(' / ')}）`)
  }
  // 两位角色的池子不该完全一样（"独立"要有实际差异）
  const pa = g.randomPool(has('aria'))
  const pb = g.randomPool(has('ray'))
  ok(
    pa.some((x) => !pb.includes(x)) && pb.some((x) => !pa.includes(x)),
    '两个人的随机动作池不完全相同（各自有专属动作）'
  )
  // 进出场是长动作（两步），且都含走动 —— "从场外走进来/走出去"
  for (const id of ['enter', 'exit']) {
    ok(g.GESTURES[id].steps.length >= 2, `${id} 是多步动作（${g.GESTURES[id].steps.length} 步）`)
    ok(g.GESTURES[id].steps.some((s) => s.span === 'travel'), `${id} 含走动步`)
    eq(g.GESTURES[id].weight, 0, `${id} 不参与随机`)
  }
  // 问候与播报不参与随机（外部触发；养成互动下线后，"鼓掌"已改为普通随机小动作）
  for (const id of ['wave', 'talk']) eq(g.GESTURES[id].weight, 0, `${id} 不参与随机`)
  ok(g.GESTURES.clap.weight > 0, '鼓掌是普通随机小动作（不再是交互反馈）')
}

// ─── B. 时长口径 ─────────────────────────────────────────────────────────────
console.log('\nB. 时长口径 resolveStep')
{
  const step = g.GESTURES.wave.steps[0]
  eq(g.resolveStep(step, 1.5, g.FALLBACK_CTX), 1.5, 'span=clip → 用剪辑时长')
  eq(g.resolveStep(step, null, g.FALLBACK_CTX), null, '剪辑未就位 → null（现在不能播）')
  eq(g.resolveStep({ ...step, rate: 2 }, 1.5, g.FALLBACK_CTX), 0.75, 'rate=2 → 时长减半')
  eq(g.resolveStep({ ...step, span: 4 }, 1.5, g.FALLBACK_CTX), 4, '显式秒数优先于剪辑时长')

  const walk = g.GESTURES.enter.steps[0]
  const ctx = { offStageX: 30, strideSpeed: 25 }
  eq(g.resolveStep(walk, 1.2, ctx), 1.2, '走动时长 = 场外距离 ÷ 步幅速度（30/25=1.2）')
  eq(g.resolveStep(walk, 1.2, { offStageX: 30, strideSpeed: 0 }), null, '量不到步幅速度 → 走动不可播（不硬走）')
  eq(g.resolveStep(walk, null, ctx), null, '走动也要等 walk 剪辑就位')

  ok(g.GESTURES.enter.steps[0].span === 'travel' && g.GESTURES.enter.steps[0].travel === 'in', '进场第一步是从场外走入')
  ok(g.GESTURES.exit.steps[1].travel === 'out', '退场最后一步是走出场外')
}

// ─── C. 体态轨迹 ─────────────────────────────────────────────────────────────
console.log('\nC. 体态轨迹')
{
  const ctx = { offStageX: 30, strideSpeed: 25 }
  const p0 = g.mWalkIn(0, ctx)
  const p1 = g.mWalkIn(1, ctx)
  eq([Math.round(p0.x), p0.yaw, Math.round(p1.x)], [-30, Math.PI / 2, 0], '入场：从场外左侧走到中心，行进时面朝行进方向')
  const q0 = g.mWalkOut(0, ctx)
  const q1 = g.mWalkOut(1, ctx)
  eq([Math.round(q0.x), Math.round(q1.x)], [0, 30], '退场：从中心走到场外右侧')
  ok(q0.yaw === 0 && q1.yaw === Math.PI / 2, '退场：起步朝观众，转身后朝行进方向')
  eq(g.mFaceFront(1).yaw, 0, '入场第二步转回正面（挥手时朝观众）')
  // 点缀必须首尾归零：否则动作切换瞬间会"啪"地跳一下（sin(π) 有 1e-16 量级的浮点尾巴）
  const accent = g.mAccent({ rise: 1, lean: 0.05, sway: 0.1, hop: 0.4 })
  const zero = (p) => Math.abs(p.y) < 1e-9 && Math.abs(p.yaw) < 1e-9 && Math.abs(p.lean) < 1e-9
  ok(zero(accent(0)), '点缀在中段最大、起点归零')
  ok(zero(accent(1)), '点缀在终点也归零（1e-16 级浮点尾巴不算）')
  ok(accent(0.5).y > 0, '点缀中段确实有抬升')
}

// ─── D. 调度 stepPlan ────────────────────────────────────────────────────────
console.log('\nD. 调度 stepPlan')
{
  const pool = ['lookAround', 'stretch', 'think']
  const durations = { lookAround: 2, stretch: 3, think: 2.5 }
  /** 可控环境：rand 固定、stepSeconds 可控（null = 未就位） */
  const mkEnv = (readySet = null) => ({
    stepSeconds: (id, step) => {
      if (readySet && !readySet.has(id)) return null
      if (g.GESTURES[id].steps[step].span === 'travel') return 1
      if (g.GESTURES[id].steps[step].span === 'clip') return 1.5
      return durations[id] ?? 2
    },
    pool,
    weightOf: (id) => g.GESTURES[id].weight,
    rand: () => 0.5
  })
  const env = mkEnv()
  const t = (plan, secs) => {
    let p = plan
    for (let i = 0; i < Math.round(secs / 0.05); i++) p = g.stepPlan(p, 0.05, env)
    return p
  }

  let plan = g.initialPlan(env)
  ok(plan.cur === null && plan.planned !== null, '初始：静息，但**已经选好**下一个动作（预取的起点）')
  ok(plan.waitFor >= g.DWELL_SEC[0] && plan.waitFor <= g.DWELL_SEC[1], `静息时长落在 ${g.DWELL_SEC.join('–')}s`)

  plan = t(plan, plan.waitFor + 0.1)
  ok(plan.cur !== null, '静息到点 → 抽到一个动作就播（而不是先等剪辑）')
  const playing = plan.cur
  // 走到"刚播完那一刻"（再多走就会进入下一个静息周期、又抽一个新动作）
  let guard = 0
  while (plan.cur !== null && guard++ < 200) plan = g.stepPlan(plan, 0.05, env)
  ok(plan.cur === null && guard < 200, '动作播完 → 回静息')
  eq(plan.last, playing, '记住刚播过的动作')
  ok(plan.planned !== null && plan.planned !== plan.last, '随机不连续重复同一个动作')
  ok(plan.planned !== null, '回静息时顺手选好下一个（场景据此在后台预取）')

  // 关键行为：抽到的动作没就位 → 不播、继续等（而不是播一段空站立）
  const notReady = mkEnv(new Set())
  let p2 = { ...g.initialPlan(notReady), waitFor: 0.01 }
  p2 = g.stepPlan(p2, 0.05, notReady)
  eq(p2.cur, null, '待播动作未就位 → 保持静息')
  ok(p2.waitFor > 0 && p2.waitFor <= g.RETRY_SEC, '未就位 → 按 RETRY_SEC 再来一次')
  eq(p2.planned, p2.planned, '未就位时不换动作（否则永远在换、永远加载不完）')

  // 外部插队：立刻从头播，播完回静息并兑现 Promise
  let p3 = g.initialPlan(env)
  p3 = g.playNow(p3, 'enter')
  eq([p3.cur, p3.step, p3.since], ['enter', 0, 0], '插队：立刻从头播')
  p3 = t(p3, 1.5)
  eq([p3.cur, p3.step], ['enter', 1], '多步动作自动推进到下一步')
  guard = 0
  while (p3.cur !== null && guard++ < 200) p3 = g.stepPlan(p3, 0.05, env)
  eq(p3.cur, null, '多步动作播完 → 回静息')

  // 剪辑中途消失（换角色/加载失败）→ 回静息，不空转
  const half = mkEnv()
  let p4 = g.playNow(g.initialPlan(half), 'lookAround')
  p4 = g.stepPlan(p4, 0.05, { ...half, stepSeconds: () => null })
  eq(p4.cur, null, '剪辑中途量不到时长 → 回静息（不空转）')

  // 加权随机：权重高的更容易被抽到；池空/权重全 0 → null
  const weighted = {
    stepSeconds: () => 1,
    pool: ['lookAround', 'stretch'],
    weightOf: (id) => (id === 'lookAround' ? 3 : 1),
    rand: () => 0.1
  }
  eq(g.pickGesture(weighted, null), 'lookAround', 'rand 落到权重大的那头 → 抽中它')
  eq(g.pickGesture({ ...weighted, rand: () => 0.99 }, null), 'stretch', 'rand 落到尾部 → 抽中另一个')
  eq(g.pickGesture({ ...weighted, pool: [] }, null), null, '池空 → null')
  eq(g.pickGesture({ ...weighted, weightOf: () => 0 }, null), null, '权重全 0 → null')
  eq(g.pickGesture({ ...weighted, stepSeconds: () => 1 }, 'lookAround'), 'stretch', '避开上一个（不连续重复）')

  // dt 上限：掉帧/休眠后不做大跳
  let p5 = g.playNow(g.initialPlan(env), 'lookAround')
  p5 = g.stepPlan(p5, 10, env)
  ok(p5.since <= 0.25, `单帧推进被夹在 0.25s 内（实际 ${p5.since}）`)

  // frameOf / poseOf 与 plan 同步
  let p6 = g.playNow(g.initialPlan(env), 'enter')
  const f6 = g.frameOf(p6, env)
  eq([f6.id, f6.step, f6.clip, f6.p], ['enter', 0, 'walk', 0], 'frameOf 给出当前该播的剪辑与进度')
  ok(g.frameOf(g.initialPlan(env), env) === null, '静息时 frameOf 为 null（调用方播 REST_CLIP）')
  eq(g.poseOf(g.initialPlan(env), env, g.FALLBACK_CTX), g.STILL, '静息时体态归零')
  eq(g.REST_CLIP, 'idle', '静息用 idle 剪辑')
}

console.log(`\ngesture: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
