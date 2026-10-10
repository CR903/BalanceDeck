// 灵动岛边缘裁剪修复（10-10-island-clip-fix）回归套件：宽度感知钳制
// 用法：node scripts/test-island-clip.mjs
//
// 修前：posX 只按比例钳 [0.08, 0.92]，不看岛宽 —— 岛宽随家数变（fit-content，
// 上限 528px），靠边时 center ± islandW/2 伸出 560 窗口被裁（harness 实测
// posX=0.821 右溢 142px）。修后：clampIslandPos 用实测岛宽把中心钳在
// [islandW/2+8, hostW-islandW/2-8] 内（与 legacy 界取交，极窄岛退化现行行为），
// 加载/拖拽/落盘三处同走这一函数。
//
// 加载的是**真实源码**（loadTs 打包 src/shared/pet-view.ts），不内联实现副本。

import { loadTs } from './lib/load-ts.mjs'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8')

const shared = await loadTs('src/shared/pet-view.ts')
const { ISLAND_VIEW, ISLAND_EDGE_PX, ISLAND_POS_MIN, ISLAND_POS_MAX, clampIslandPos } = shared

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
/** 断言 posX 下岛矩形完全落在窗口内（AC1 的算术形式：left>=8 且 right<=hostW-8） */
function inside(posX, islandW, hostW = ISLAND_VIEW.width) {
  const cx = clampIslandPos(posX, islandW, hostW)
  const left = cx * hostW - islandW / 2
  const right = cx * hostW + islandW / 2
  return left >= ISLAND_EDGE_PX - 1e-9 && right <= hostW - ISLAND_EDGE_PX + 1e-9
}

console.log('用例 1：常量口径（窗口宽取 ISLAND_VIEW，不硬编码 560）')
eq(ISLAND_VIEW.width, 560, '岛窗口宽 560（ISLAND_VIEW 口径）')
eq(ISLAND_EDGE_PX, 8, '贴边留白 8px')
eq(ISLAND_POS_MIN, 0.08, 'legacy 下界 0.08（退化目标）')
eq(ISLAND_POS_MAX, 0.92, 'legacy 上界 0.92（退化目标）')
eq(typeof clampIslandPos, 'function', 'clampIslandPos 导出（修前没有，缺了即红）')

console.log('用例 2：居中默认渲染与修前一致（AC2 的算术形式）')
eq(clampIslandPos(0.5, 284), 0.5, '典型岛宽 284px 下 0.5 不动')
eq(clampIslandPos(0.5, 120), 0.5, '窄岛 120px 下 0.5 不动')
eq(clampIslandPos(0.5, 528), 0.5, '最宽 528px 下 0.5 不动')

console.log('用例 3：两端钳制（AC1 的算术形式，harness 实测 284px 岛）')
ok(inside(0, 284), 'posX=0 → 左边距 ≥8px（修前左溢 142px 量级）')
ok(inside(1, 284), 'posX=1 → 右边距 ≥8px（修前 posX=0.821 已右溢 142px）')
ok(inside(0, 528), 'posX=0 + 最宽岛 → 仍在窗内')
ok(inside(1, 528), 'posX=1 + 最宽岛 → 仍在窗内')
eq(
  clampIslandPos(1, 284),
  (ISLAND_VIEW.width - 284 / 2 - ISLAND_EDGE_PX) / ISLAND_VIEW.width,
  '右钳制值 = (560 - 142 - 8)/560（宽度感知，不是 0.92）'
)
eq(
  clampIslandPos(0, 284),
  (284 / 2 + ISLAND_EDGE_PX) / ISLAND_VIEW.width,
  '左钳制值 = (142 + 8)/560（宽度感知，不是 0.08）'
)

console.log('用例 4：极窄岛退化为现行行为（PRD R1 括号）')
eq(clampIslandPos(0, 0), ISLAND_POS_MIN, '岛宽 0（未测到）→ legacy 下界')
eq(clampIslandPos(1, 0), ISLAND_POS_MAX, '岛宽 0（未测到）→ legacy 上界')
eq(clampIslandPos(0.02, NaN), ISLAND_POS_MIN, '岛宽 NaN → legacy 下界')
eq(clampIslandPos(0, 40), ISLAND_POS_MIN, '极窄岛 40px（宽度界 0.059 < 0.08）→ legacy 下界')
eq(clampIslandPos(1, 40), ISLAND_POS_MAX, '极窄岛 40px → legacy 上界')

console.log('用例 5：拖拽映射（R2：dx 折中心 px，分母仍是窗口宽，落盘经同一钳制）')
// 60px 右拖（uitest 沿用行程）：0.5 + 60/560 = 0.607，岛宽 284 下不受钳制影响
eq(clampIslandPos(0.5 + 60 / ISLAND_VIEW.width, 284), 0.5 + 60 / ISLAND_VIEW.width, '小行程拖拽不被钳制改写（uitest dragMoved 前提）')
// 大行程右拖到头：0.5 + 400/560 = 1.214 → 落到右宽度界，且与直接给 1 同值（幂等）
eq(
  clampIslandPos(0.5 + 400 / ISLAND_VIEW.width, 284),
  clampIslandPos(1, 284),
  '拖过头与直接给 1 同值（钳制幂等，落盘即此值）'
)
ok(inside(0.5 + 400 / ISLAND_VIEW.width, 284), '拖过头后岛仍在窗内')

console.log('用例 6：非法输入守卫（沿 dock-hide 非法几何模式）')
eq(clampIslandPos(NaN, 284), 0.5, 'NaN 输入 → 居中（不抛、不落盘 NaN）')
eq(clampIslandPos(Infinity, 284), 0.5, 'Infinity → 居中')
ok(
  Number.isFinite(clampIslandPos(0.7, -50)) && Number.isFinite(clampIslandPos(0.7, 1e9)),
  '负宽/超宽 → 有限值（永不出现 NaN 落盘）'
)

console.log('用例 7：调用点口径（IslandView 三处同走 clampIslandPos，无字面 560）')
{
  const src = read('src/renderer/src/IslandView.tsx').replace(/\/\*[\s\S]*?\*\//g, '')
  ok(src.length > 0, '前置：IslandView.tsx 读得到（不能空洞通过）')
  ok(/clampIslandPos/.test(src), 'IslandView 引用 clampIslandPos（裸 Math.min/max 钳制即红）')
  const uses = src.match(/clampIslandPos\(/g) || []
  ok(uses.length >= 3, `加载/拖拽/落盘三处调用（实际 ${uses.length} 处，少了即红）`)
  ok(!/:\s*560|560\s*[-/]/.test(src), 'IslandView 无字面 560 算术（窗口宽走 ISLAND_VIEW）')
  ok(/bodyRef\.current\?\.clientWidth/.test(src), '读 bodyRef.clientWidth 实测岛宽（估算/写死即红）')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
