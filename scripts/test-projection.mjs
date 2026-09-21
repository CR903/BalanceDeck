// pet3d/projection.ts 的投影口径测试（纯函数 + three 交叉核对，node 直接跑）
// 用法：node scripts/test-projection.mjs
//
// 这个模块只剩一件事：世界半径 → NDC 半跨幅。命中区（点击穿透那块矩形）就靠它，
// 所以断言分两层：
//   · 解析式本身（角半径换算、aspect 折算、退化输入钳位、单调性）
//   · **与 three 的真实投影矩阵交叉核对** —— 解析式算出的跨幅，必须与"把球面轮廓点
//     用相机投影出来"落在同一个位置（这是唯一能证明公式没写错的证据）
//   · 球形态命中区的实数值（球在 200×210 窗口里的投影半径与居中）

import * as THREE from 'three'
import { loadTs } from './lib/load-ts.mjs'

const { sphereNdcHalf } = await loadTs('src/renderer/src/pet3d/projection.ts')
const rig = await loadTs('src/renderer/src/pet3d/rig.ts')

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

// ─── 1. 解析式 ───────────────────────────────────────────────────────────────
console.log('1. 解析式：世界半径 → NDC 跨幅')
{
  const near = sphereNdcHalf(100, 28, 35, 1.4)
  const far = sphereNdcHalf(200, 28, 35, 1.4)
  ok(near.ny > far.ny, '距离越远跨幅越小')
  ok(sphereNdcHalf(160, 28, 35, 1).ny > sphereNdcHalf(160, 14, 35, 1).ny, '半径越大跨幅越大')
  ok(sphereNdcHalf(160, 28, 20, 1).ny > sphereNdcHalf(160, 28, 50, 1).ny, '视场角越小跨幅越大')

  const square = sphereNdcHalf(160, 28, 35, 1)
  const wide = sphereNdcHalf(160, 28, 35, 2)
  ok(Math.abs(square.nx - square.ny) < 1e-9, 'aspect=1 时 nx === ny（正方形画面）')
  ok(Math.abs(wide.nx - wide.ny / 2) < 1e-9, 'aspect=2 时 nx === ny/2（水平占更少的 NDC）')

  // 角半径口径：ny = tan(asin(r/d)) / tan(fov/2)
  const d = 100
  const r = 28
  const fov = 35
  const expect = Math.tan(Math.asin(r / d)) / Math.tan((fov * Math.PI) / 360)
  ok(Math.abs(sphereNdcHalf(d, r, fov, 1).ny - expect) < 1e-12, 'ny 就是 tan(asin(r/d)) ÷ tan(fov/2)')

  // 退化输入：球贴到镜头上 / 比相机还近 → 钳在半屏，不返回 Infinity/NaN
  const degenerate = sphereNdcHalf(10, 28, 35, 1)
  ok(Number.isFinite(degenerate.ny) && Number.isFinite(degenerate.nx), '退化输入不返回 NaN/Infinity')
  eq(sphereNdcHalf(10, 28, 35, 1).ny, sphereNdcHalf(28, 28, 35, 1).ny, 'r/d ≥ 0.99 一律钳到同一档')
}

// ─── 2. 与 three 的真实投影交叉核对 ──────────────────────────────────────────
console.log('2. 与 three 的投影矩阵交叉核对（解析式 vs 真实投影）')
{
  const W = 320
  const H = 440
  const fov = rig.CAM_FOV
  const camera = new THREE.PerspectiveCamera(fov, W / H, 1, 2000)
  camera.position.set(0, rig.CAM_Y, rig.CAM_DISTANCE)
  camera.lookAt(0, rig.BALL_CENTER_Y, 0)
  camera.updateMatrixWorld(true)

  const center = new THREE.Vector3(0, rig.BALL_CENTER_Y, 0)
  const dist = camera.position.distanceTo(center)
  const half = sphereNdcHalf(dist, rig.BALL_RADIUS, fov, W / H)
  const ndcCenter = center.clone().project(camera)

  /**
   * 球面轮廓点：从相机看，切点 T = C + √(d²−r²)·(cosθ·ê + sinθ·û)，θ = asin(r/d)。
   * û 取"相机上方向去掉了 ê 分量"——对无滚转的相机，这就是画面竖直方向，
   * 于是 T 与球心的 NDC 差应该正好是 (0, ±ny)。
   */
  const tangent = (u) => {
    const e = center.clone().sub(camera.position).normalize()
    const theta = Math.asin(rig.BALL_RADIUS / dist)
    const base = camera.position.clone().addScaledVector(e, Math.sqrt(dist * dist - rig.BALL_RADIUS ** 2))
    const w = new THREE.Vector3()
    // 在 (e, u) 张成的平面里转 θ
    w.copy(e).multiplyScalar(Math.cos(theta)).addScaledVector(u, Math.sin(theta))
    return base.copy(camera.position).addScaledVector(w, Math.sqrt(dist * dist - rig.BALL_RADIUS ** 2))
  }

  const up = new THREE.Vector3(0, 1, 0)
  const e = center.clone().sub(camera.position).normalize()
  const camUp = up.clone().addScaledVector(e, -up.dot(e)).normalize()
  const camRight = new THREE.Vector3().crossVectors(e, camUp).normalize().negate()

  const top = tangent(camUp).project(camera)
  const right = tangent(camRight).project(camera)
  ok(
    Math.abs(Math.abs(top.y - ndcCenter.y) - half.ny) < 1e-6,
    `轮廓点投影的竖直跨幅 == 解析式（${Math.abs(top.y - ndcCenter.y).toFixed(6)} vs ${half.ny.toFixed(6)}）`
  )
  ok(
    Math.abs(Math.abs(right.x - ndcCenter.x) - half.nx) < 1e-6,
    `轮廓点投影的水平跨幅 == 解析式（${Math.abs(right.x - ndcCenter.x).toFixed(6)} vs ${half.nx.toFixed(6)}）`
  )
  ok(Math.abs(ndcCenter.x) < 1e-9, '球固定在 x=0 → 投影中心水平居中（覆盖层锚点不漂）')
}

// ─── 3. 球形态命中区的实数值 ─────────────────────────────────────────────────
console.log('3. 球形态命中区（200×210 窗口里的实数值）')
{
  const W = 200
  const H = 210
  const center = new THREE.Vector3(0, rig.BALL_CENTER_Y, 0)
  const camera = new THREE.PerspectiveCamera(rig.CAM_FOV, W / H, 1, 2000)
  camera.position.set(0, rig.CAM_Y, rig.CAM_DISTANCE)
  camera.lookAt(0, rig.BALL_CENTER_Y, 0)
  camera.updateMatrixWorld(true)
  const dist = camera.position.distanceTo(center)
  const { ny } = sphereNdcHalf(dist, rig.BALL_RADIUS, rig.CAM_FOV, W / H)
  // scene.ts 的球形态命中区就是这么算的：半径 = ny × 半屏高 × 0.98（留一点余量）
  const r = ny * (H / 2) * 0.98
  const v = center.clone().project(camera)
  const rect = {
    x: (v.x + 1) / 2 * W - r,
    y: (1 - v.y) / 2 * H - r,
    width: r * 2,
    height: r * 2
  }
  ok(Math.abs(rect.width - 112) < 1.5, `球投影直径 ≈112px（实际 ${rect.width.toFixed(1)}）`)
  ok(Math.abs(rect.x + rect.width / 2 - W / 2) < 0.5, '命中区水平居中于窗口')
  ok(Math.abs(rect.y + rect.height / 2 - H / 2) < 0.5, '命中区垂直居中于窗口')
  ok(rect.x > 0 && rect.y > 0 && rect.x + rect.width < W, '命中区完整落在窗口内（贴边不切）')
}

console.log(`\nprojection: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
