// pet3d/viewfit.ts 的视口反算测试（纯函数，node 直接跑）
// 用法：node scripts/test-viewfit.mjs
//
// 覆盖（步骤 3 起为两条约束的契约）：
//   C1 球壳（固定 z=0）在 (±halfX, 0) 不越界；C2 宠物在四角 (±halfX, ±halfZ) 与
//   z 两端 (0, ±halfZ) 不越界（viewfit 口径 + three 实际投影双重复算）、
//   求解的极大性（再大一点就越界）、下限保护、depthBudget 生效、
//   等比放大窗口→世界边界不变、纵深与横向的耦合方向、退化输入、机位常量未与 scene.ts 漂移。
//
// 期望值一律由 fitRoamArea 的输出**回代投影**反推，不写手算魔数 —— 魔数会随着
// 相机/形态的调整悄悄失效（那正是 halfX:58 的成因）。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as THREE from 'three'
import { loadTs } from './lib/load-ts.mjs'

const { MIN_HALF_X, MIN_HALF_Z, fitRoamArea, projectSphere, sphereNdcHalf } = await loadTs(
  'src/renderer/src/pet3d/viewfit.ts'
)

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

// ─── 机位与轮廓常量（与 scene.ts 一致；下面第 1 组断言核对没有漂移）────────────
const BALL_RADIUS = 28
const BALL_CENTER_Y = BALL_RADIUS + 1.5
const SHELL = { radius: Math.max(BALL_RADIUS * 1.028, BALL_RADIUS * 0.995 + 1.1, BALL_RADIUS * 0.86 + 1.9 * 1.5), centerY: BALL_CENTER_Y }
/**
 * 宠物轮廓：与运行时 bodySilhouette() 同口径 —— 归一化后**实际世界包围盒**的对角线/2 + y 中点。
 * 实测（node 复刻 instantiateHuman 的克隆+归一化，36 世界单位身高）：
 *   aria 25.2×36×6.3 → r=22.19   ray 26.6×36×6.9 → r=22.65（取较大者）
 * 中心 y：脚点 8.5 + 身高一半 ≈ 26.5（运行时 dump 实测 27）。改素材/改身高后要重测，别手调。
 */
const BODY = { radius: 22.65, centerY: 26.5 }
const SCENE = {
  fovDeg: 35,
  camY: BALL_CENTER_Y + 34, // BALL_CENTER_Y + CAM_PITCH
  camZ: 162,
  lookY: BALL_CENTER_Y, // 相机注视点 = 球心高度
  margin: 4,
  depthBudget: 28
}
const view = (viewW, viewH) => ({
  ...SCENE,
  viewW,
  viewH,
  shell: { ...SHELL },
  body: { ...BODY }
})
/** 含留白的轮廓（回代投影用的实际检查半径） */
const shellOf = (o) => ({ ...o.shell, radius: o.shell.radius + o.margin })
const bodyOf = (o) => ({ ...o.body, radius: o.body.radius + o.margin })
const inNdc = (o, s, x, z) => {
  const p = projectSphere(o, x, s.centerY, z, s.radius)
  return Math.abs(p.nx) + p.hx <= 1 + 1e-9 && Math.abs(p.ny) + p.hy <= 1 + 1e-9
}
const EPS = 1e-6

// 用 three 的真实投影复算：轮廓球心 NDC 由 Vector3.project 得出，跨幅用共用口径换算
function ndcBox(v, s, x, z) {
  const cam = new THREE.PerspectiveCamera(v.fovDeg, v.viewW / v.viewH, 1, 2000)
  cam.position.set(0, v.camY, v.camZ)
  cam.lookAt(0, v.lookY, 0)
  cam.updateMatrixWorld(true)
  const c = new THREE.Vector3(x, s.centerY, z)
  const p = c.clone().project(cam)
  const dist = cam.position.distanceTo(c)
  const { nx, ny } = sphereNdcHalf(dist, s.radius, v.fovDeg, v.viewW / v.viewH)
  return { left: p.x - nx, right: p.x + nx, bottom: p.y - ny, top: p.y + ny }
}

// ─── 1. 机位常量与 scene.ts 同源 ─────────────────────────────────────────────
const sceneSrc = readFileSync(resolve('src/renderer/src/pet3d/scene.ts'), 'utf-8')
const literal = (re, label) => ok(re.test(sceneSrc), `scene.ts 常量未漂移：${label}`)
literal(/const BALL_RADIUS = 28\b/, 'BALL_RADIUS 28')
literal(/const CAM_FOV = 35\b/, 'CAM_FOV 35')
literal(/const CAM_DISTANCE = 162\b/, 'CAM_DISTANCE 162')
literal(/const CAM_PITCH = 34\b/, 'CAM_PITCH 34')
literal(/const BALL_CENTER_Y = BALL_RADIUS \+ 1\.5\b/, 'BALL_CENTER_Y')
literal(/const SHELL_EDGE_R = BALL_RADIUS \* 1\.028\b/, 'SHELL_EDGE_R 1.028')
literal(/const BAND_R = BALL_RADIUS \* 0\.995\b/, 'BAND_R 0.995')
literal(/const BAND_TUBE = 1\.1\b/, 'BAND_TUBE 1.1')
literal(/const RING_R = BALL_RADIUS \* 0\.86\b/, 'RING_R 0.86')
literal(/const RING_TUBE = 1\.9\b/, 'RING_TUBE 1.9')
literal(/const RING_HALO_TUBE = RING_TUBE \* 1\.5\b/, 'RING_HALO_TUBE')
literal(/const ROAM_FIT_MARGIN = 4\b/, 'ROAM_FIT_MARGIN 4')
literal(/const ROAM_DEPTH_BUDGET = 28\b/, 'ROAM_DEPTH_BUDGET 28（R9 目标 halfZ≈28）')
literal(/const HUMAN_HEIGHT = 36\b/, 'HUMAN_HEIGHT 36')
// R7（D4'）：球壳与用量环只跟 x、不跟 z —— 写回 z 跟随即回归
ok(!/shellGroup\.position\.z\s*[-+]?=/.test(sceneSrc), 'R7：shellGroup 不再跟随 z')
ok(!/ringGroup\.position\.z\s*[-+]?=/.test(sceneSrc), 'R7：ringGroup 不再跟随 z（与壳保持同步）')
// R10：偏航写 petGroup（绕自身原点），不写归一化层 petHolder
ok(/petGroup\.rotation\.y \+=/.test(sceneSrc), 'R10：偏航写在 petGroup')
ok(!/petHolder\.rotation.*\.y\s*[-+]?=[^=]/.test(sceneSrc.replace(/petHolder\.rotation\.set\(/g, '')), 'R10：不写 petHolder 的 yaw（归一化层）')
// 禁止手工缩放（走近变大必须来自透视本身）
ok(!/petHolder\.scale\.setScalar\(/.test(sceneSrc), 'R9：没有对 petHolder 的归一化层加手工缩放')
// 位置只由 walker 驱动：剪辑自带的根位移（Bip01 的 position 曲线，实测 walk ≈33 世界单位/循环）
// 必须每帧抵消，否则宠物会滑出反算出的可行区
ok(/human\.cancelRootMotion\(\)/.test(sceneSrc), 'R9：抵消剪辑自带根位移（滑步回归的护栏）')

// ─── 2. 反算结果回代：球在 (±halfX, 0)、宠物在四角与 z 两端，全部不越界 ────────
// expect：'fits' = 视口装得下轮廓，必须不越界；'floor' = 装不下，下限保护接管（允许略微出界）
const SIZES = [
  ['320×230（当前宠物形态）', 320, 230, 'fits'],
  ['460×340（已作废的加高方案，仅留作 aspect 对照）', 460, 340, 'fits'],
  ['200×210（球形态）', 200, 210, 'fits'],
  ['800×120（极端宽扁 aspect）', 800, 120, 'fits'],
  ['120×800（极端瘦高 aspect）', 120, 800, 'floor'],
  ['64×48（系统缩到极小）', 64, 48, 'fits']
]
for (const [name, w, h, expect] of SIZES) {
  const o = view(w, h)
  const a = fitRoamArea(o)
  const shell = shellOf(o)
  const body = bodyOf(o)
  // 回代检查：C1 球壳 z=0 两侧 + C2 宠物四角、z 两端（x=0）与 (±halfX, 0)
  let worst = 0
  const probe = (s, x, z) => {
    const p = projectSphere(o, x, s.centerY, z, s.radius)
    worst = Math.max(worst, Math.abs(p.nx) + p.hx, Math.abs(p.ny) + p.hy)
  }
  for (const sx of [1, -1]) {
    probe(shell, sx * a.halfX, 0)
    for (const sz of [1, -1]) {
      probe(body, sx * a.halfX, sz * a.halfZ) // 四角
      probe(body, 0, sz * a.halfZ) // z 两端
    }
  }
  const floored = a.halfX <= MIN_HALF_X + EPS || a.halfZ <= MIN_HALF_Z + EPS
  console.log(`  · ${name}: halfX=${a.halfX.toFixed(2)} halfZ=${a.halfZ.toFixed(2)} 最坏回代 NDC=${worst.toFixed(4)}`)
  if (expect === 'fits') {
    ok(!floored, `${name}：视口装得下轮廓，未触发下限`)
    ok(worst <= 1 + 1e-6, `${name}：四角与 z 两端回代不越界（viewfit 口径）`)
    let threeOk = true
    for (const sx of [1, -1]) {
      for (const sz of [1, -1]) {
        for (const [s, x, z] of [
          [shell, sx * a.halfX, 0],
          [body, sx * a.halfX, sz * a.halfZ]
        ]) {
          const b = ndcBox(o, s, x, z)
          if (b.left < -1 - EPS || b.right > 1 + EPS || b.bottom < -1 - EPS || b.top > 1 + EPS) threeOk = false
        }
      }
    }
    ok(threeOk, `${name}：回代不越界（three 实际投影复算）`)
  } else {
    ok(floored, `${name}：视口装不下 → 下限保护接管（宁可不裁宠物，也不让它冻死）`)
    ok(worst > 1, `${name}：出界量由下限决定（最坏 NDC=${worst.toFixed(2)}），不是 NaN`)
  }
  ok(a.halfX >= MIN_HALF_X - EPS && a.halfZ >= MIN_HALF_Z - EPS, `${name}：下限保护生效`)
  ok(Number.isFinite(a.halfX) && Number.isFinite(a.halfZ), `${name}：结果为有限数`)
}

// ─── 3. 极大性：再多走一点就越界（求的是「最大可行」而不是随手给的小值）────────
for (const [name, w, h] of SIZES) {
  const o = view(w, h)
  const a = fitRoamArea(o)
  const shell = shellOf(o)
  const body = bodyOf(o)
  const over = (x, z) => !inNdc(o, shell, x, 0) || !inNdc(o, body, x, z)
  const slackX = a.halfX > MIN_HALF_X + 1
  const slackZ = a.halfZ > MIN_HALF_Z + 1 && a.halfZ < SCENE.depthBudget - 1
  if (slackX) ok(over(a.halfX + 1, a.halfZ), `${name}：halfX 再外扩 1 单位即越界（${a.halfX.toFixed(2)}）`)
  else console.log(`  - ${name}：halfX 已被下限/视口夹住，跳过极大性检查`)
  if (slackZ) ok(over(a.halfX, a.halfZ + 1), `${name}：halfZ 再外扩 1 单位即越界（${a.halfZ.toFixed(2)}）`)
  else console.log(`  - ${name}：halfZ 由 depthBudget/下限决定，跳过极大性检查`)
}

// ─── 4. 旧的硬编码 halfX:58 在宠物形态下必然被裁（反算存在的理由）──────────────
{
  const o = view(320, 230)
  const shell = shellOf(o)
  const spill = Math.abs(projectSphere(o, 58, shell.centerY, 0, shell.radius).nx) + projectSphere(o, 58, shell.centerY, 0, shell.radius).hx
  console.log(`  · 旧常量 halfX=58（球壳在 z=0）横向占到 NDC ${spill.toFixed(3)}（>1 即出界）`)
  ok(spill > 1, '旧 halfX=58 会被窗口裁切')
  const fitted = fitRoamArea(o)
  ok(fitted.halfX < 58, `反算把 halfX 从 58 收到 ${fitted.halfX.toFixed(2)}`)
}

// ─── 5. 320×230 下的 R9 目标：halfZ 拿满预算 28、halfX 不塌、缩放跨度 ≥1.35× ──
{
  const o = view(320, 230)
  const a = fitRoamArea(o)
  ok(Math.abs(a.halfZ - 28) < 0.5, `halfZ 拿满纵深预算（${a.halfZ.toFixed(2)} ≈ 28）`)
  ok(a.halfX >= 20, `halfX 不因纵深收紧塌掉（${a.halfX.toFixed(2)} ≥ 20）`)
  // 透视缩放跨度：同一 x 上最近/最远两端的相机距离比（≈ 屏幕尺寸比）
  const near = Math.hypot(SCENE.camY - BODY.centerY, SCENE.camZ - a.halfZ)
  const far = Math.hypot(SCENE.camY - BODY.centerY, SCENE.camZ + a.halfZ)
  const span = far / near
  console.log(`  · 320×230 实测反算：halfX=${a.halfX.toFixed(2)} halfZ=${a.halfZ.toFixed(2)} 缩放跨度=${span.toFixed(3)}×`)
  ok(span >= 1.35, `缩放跨度 ≥1.35×（${span.toFixed(2)}×，R9 目标）`)
}

// ─── 6. 纵深与横向耦合 + depthBudget：预算越深，横向越紧 ──────────────────────
{
  const shallow = fitRoamArea({ ...view(320, 230), depthBudget: 9 })
  const deep = fitRoamArea({ ...view(320, 230), depthBudget: 200 })
  ok(shallow.halfZ <= 9 + EPS, `depthBudget 上限生效（halfZ=${shallow.halfZ.toFixed(2)} ≤ 9）`)
  ok(deep.halfZ > 28, `同样的窗口给足预算就能走得更深（halfZ=${deep.halfZ.toFixed(2)}）`)
  ok(shallow.halfX >= deep.halfX - EPS, `z 越大宠物离镜头越近越大 → 可用 x 越小（${shallow.halfX.toFixed(2)} ≥ ${deep.halfX.toFixed(2)}）`)
  console.log(`  · 耦合：halfZ ${deep.halfZ.toFixed(1)} ↔ halfX ${deep.halfX.toFixed(1)}；halfZ ${shallow.halfZ.toFixed(1)} ↔ halfX ${shallow.halfX.toFixed(1)}`)
}

// ─── 7. 世界单位边界只由 fov / aspect 决定（放大窗口 ≠ 放大可行区）────────────
{
  const base = fitRoamArea(view(320, 230))
  const scaled = fitRoamArea(view(640, 460))
  ok(
    Math.abs(scaled.halfX - base.halfX) < 1e-6 && Math.abs(scaled.halfZ - base.halfZ) < 1e-6,
    '等比放大窗口：世界边界不变（竖直角视野没变，变的只是像素大小）'
  )
  const wide = fitRoamArea(view(320, 200))
  const tall = fitRoamArea(view(320, 280))
  ok(wide.halfX > base.halfX, `aspect 更大 → 横向更宽（${wide.halfX.toFixed(2)} > ${base.halfX.toFixed(2)}）`)
  ok(tall.halfX < base.halfX, `aspect 更小 → 横向更窄（${tall.halfX.toFixed(2)} < ${base.halfX.toFixed(2)}）`)
  ok(Math.abs(tall.halfZ - base.halfZ) < 1e-6 && Math.abs(wide.halfZ - base.halfZ) < 1e-6, '纵深边界与 aspect 无关')
}

// ─── 8. 退化输入不炸（0/负尺寸、预算大到穿过相机）────────────────────────────
{
  for (const [w, h] of [
    [0, 0],
    [1, 1],
    [320, 0]
  ]) {
    const a = fitRoamArea(view(w, h))
    ok(a.halfX >= MIN_HALF_X && a.halfZ >= MIN_HALF_Z, `${w}×${h}：退化尺寸退回下限且不 NaN`)
  }
  const through = fitRoamArea({ ...view(900, 700), depthBudget: 900 })
  ok(Number.isFinite(through.halfX) && Number.isFinite(through.halfZ), '预算大到能穿过相机平面时仍收敛（不 NaN）')
  const behind = projectSphere(view(320, 230), 0, SCENE.lookY, SCENE.camZ + 400, 28)
  ok(!Number.isFinite(behind.nx), '轮廓球心落到相机后方时判为不可见（不返回 NaN）')
}

// ─── 9. 投影口径本身：越远越小、水平按 aspect 折算 ────────────────────────────
{
  const near = sphereNdcHalf(100, 28, 35, 1.4)
  const far = sphereNdcHalf(200, 28, 35, 1.4)
  ok(near.ny > far.ny, '距离越远投影跨幅越小')
  const square = sphereNdcHalf(160, 28, 35, 1)
  const wide = sphereNdcHalf(160, 28, 35, 2)
  ok(Math.abs(square.nx - square.ny) < 1e-9, 'aspect=1 时 nx === ny（正方形画面）')
  ok(Math.abs(wide.nx - wide.ny / 2) < 1e-9, 'aspect=2 时 nx === ny/2（水平占更少的 NDC）')
  // 反算与命中框共用同一份换算：球的像素半径 = hy × 半屏高
  const o = view(320, 230)
  const e = projectSphere(o, 0, BALL_CENTER_Y, 0, BALL_RADIUS)
  const ref = sphereNdcHalf(Math.hypot(o.camY - BALL_CENTER_Y, o.camZ), BALL_RADIUS, o.fovDeg, 320 / 230)
  ok(Math.abs(e.hy - ref.ny) < 1e-9 && Math.abs(e.hx - ref.nx) < 1e-9, 'projectSphere 的跨幅 == sphereNdcHalf')
  // 球壳固定在 z=0 时，球心的竖直 NDC 恒为 0（相机俯角正好看在该高度）→ 覆盖层 y 锚点稳定
  ok(Math.abs(e.ny) < 1e-9, '球壳停在 z=0 → 球心投影恒在画面竖直中心（覆盖层锚点不漂）')
}

console.log(`\nviewfit: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
