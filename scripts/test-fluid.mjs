// shared/fluid.ts 行为测试（纯函数，node 直接跑）
// 用法：node scripts/test-fluid.mjs
//
// 悬浮球流体隐藏：时序常量/液位映射/水渍几何/相位映射（吸入/汇聚/水渍三元素与
// dock:fluid 通道的唯一口径。渲染层与主进程状态机共用同一实现，不各自硬编码）。

import { loadTs } from './lib/load-ts.mjs'

const fluid = await loadTs('src/shared/fluid.ts')
const dockHide = await loadTs('src/shared/dock-hide.ts')
const { peekHitbox } = dockHide
const {
  ABSORB_STRETCH_MS,
  ABSORB_MERGE_MS,
  ABSORB_SETTLE_MS,
  ABSORB_TOTAL_MS,
  REVEAL_MS,
  PILL_LEN,
  FLUID_PHASES,
  isFluidPhase,
  fluidForPhase,
  level,
  pillBox,
  waterColumn
} = fluid

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

console.log('用例 1：时序常量口径（PRD R5 + design Fluid 节）')
eq(ABSORB_STRETCH_MS, 150, '拉伸 150ms ease-out')
eq(ABSORB_MERGE_MS, 300, '桥接合并 300ms')
eq(ABSORB_SETTLE_MS, 80, 'pill 定形 + 微回弹 80ms')
eq(ABSORB_TOTAL_MS, 530, '吸入总 530ms（≈ PRD ~500ms）')
eq(ABSORB_TOTAL_MS, ABSORB_STRETCH_MS + ABSORB_MERGE_MS + ABSORB_SETTLE_MS, '总数 = 三段之和（不手算 530）')
eq(REVEAL_MS, 400, '汇聚反向 400ms')
ok(REVEAL_MS < ABSORB_TOTAL_MS, '汇聚快于吸入（退出更快，与滑入/滑出同方向）')
eq(PILL_LEN, 20, '水渍沿边沿约 20px')

console.log('用例 2：液位映射（clamp + 一位小数粒度，无浮点抖动）')
eq(level(0), 0, '0% → 0')
eq(level(100), 1, '100% → 1')
eq(level(10), 0.1, '10% → 0.1')
eq(level(13.7), 0.137, '13.7% → 0.137（与环心读数逐位一致）')
eq(level(50), 0.5, '50% → 0.5')
eq(level(-5), 0, '负数钳到 0')
eq(level(150), 1, '超 100 钳到 1')
eq(level(NaN), 0, 'NaN → 0（守卫，不是数据口径）')
eq(level(Infinity), 0, 'Infinity → 0')
eq(level('50'), 0, '非数字 → 0')
eq(level(undefined), 0, '缺失 → 0')
eq(level(33.35), 0.334, '33.35 → 0.334（一位小数粒度：33.35*10=333.5→334）')
ok(level(13.7) === level(13.7), '同样输入永远同样输出（CSS 高度不抖）')

console.log('用例 3：水渍几何（56×56 窗口局部坐标，沿边沿居中）')
eq(pillBox('left', { width: 56, height: 56 }), { x: 52, y: 18, width: 4, height: 20 }, '左：窗口右侧 4×20 居中')
eq(pillBox('right', { width: 56, height: 56 }), { x: 0, y: 18, width: 4, height: 20 }, '右：窗口左侧 4×20 居中')
eq(pillBox('top', { width: 56, height: 56 }), { x: 18, y: 52, width: 20, height: 4 }, '上：窗口底部 20×4 居中')
eq(pillBox('bottom', { width: 56, height: 56 }), { x: 18, y: 0, width: 20, height: 4 }, '下：窗口顶部 20×4 居中')
// 痕迹条同源：pill 的探出边与 dock-hide.peekHitbox 的痕迹条贴同一条边
{
  const shared = await loadTs('src/shared/dock-hide.ts')
  const left = pillBox('left', { width: 56, height: 56 })
  const peek = shared.peekHitbox('left', { width: 56, height: 56 })
  ok(left && left.x === peek.x && left.width === peek.width, '左：pill 探出边与痕迹条同源（x/width 一致）')
  const bottom = pillBox('bottom', { width: 56, height: 56 })
  const peekB = shared.peekHitbox('bottom', { width: 56, height: 56 })
  ok(bottom && bottom.y === peekB.y && bottom.height === peekB.height, '下：pill 探出边与痕迹条同源（y/height 一致）')
}

console.log('用例 4：水渍几何守卫（坏输入回 null，不摆错位水渍）')
eq(pillBox('left', { width: NaN, height: 56 }), null, 'NaN 尺寸 → null')
eq(pillBox('left', { width: 0, height: 56 }), null, '零宽 → null')
eq(pillBox('left', { width: 56, height: 56 }, NaN), null, 'NaN 长度 → null')
eq(pillBox('left', { width: 56, height: 56 }, 20, -1), null, '负探出 → null')
eq(pillBox('left', { width: 56, height: 56 }, 60), null, '长度超窗高 → null（装不下）')
eq(pillBox('top', { width: 56, height: 56 }, 60), null, '长度超窗宽 → null')

console.log('用例 5：相位映射（DockPhase → FluidPhase，唯一口径）')
eq(fluidForPhase('hiding'), 'absorbing', 'hiding → absorbing（morph 中，位移未始）')
eq(fluidForPhase('hidden'), 'hidden', 'hidden → hidden（水渍态）')
eq(fluidForPhase('dwell-reveal'), 'hidden', 'dwell-reveal → hidden（还在痕迹上）')
eq(fluidForPhase('revealing'), 'revealing', 'revealing → revealing（已滑回，morph 中）')
eq(fluidForPhase('idle'), 'edge-visible', 'idle → edge-visible')
eq(fluidForPhase('dwell-hide'), 'edge-visible', 'dwell-hide → edge-visible（morph 还没开始）')
eq(fluidForPhase('edge-visible'), 'edge-visible', 'edge-visible → edge-visible')
eq(fluidForPhase('dwell-rehide'), 'edge-visible', 'dwell-rehide → edge-visible（球在全可见位）')
eq(fluidForPhase('bogus'), 'edge-visible', '未知相位 → edge-visible（默认画整球）')
eq(JSON.stringify(FLUID_PHASES), JSON.stringify(['edge-visible', 'absorbing', 'hidden', 'revealing']), '相位全集四项')
ok(isFluidPhase('absorbing') && !isFluidPhase('hiding') && !isFluidPhase(''), 'isFluidPhase 只认四相位')

console.log('用例 6：贴边水柱几何（10-03-holo-sphere 水满：水渍 pill 改为占满痕迹条的水柱）')
eq(waterColumn('left', { width: 56, height: 56 }), { x: 52, y: 0, width: 4, height: 56, vertical: true }, '左：4 宽 × 56 高竖柱（探出边贴右）')
eq(waterColumn('right', { width: 56, height: 56 }), { x: 0, y: 0, width: 4, height: 56, vertical: true }, '右：4 宽 × 56 高竖柱（探出边贴左）')
eq(waterColumn('top', { width: 56, height: 56 }), { x: 0, y: 52, width: 56, height: 4, vertical: false }, '上：56 宽 × 4 高横槽（探出边贴底）')
eq(waterColumn('bottom', { width: 56, height: 56 }), { x: 0, y: 0, width: 56, height: 4, vertical: false }, '下：56 宽 × 4 高横槽（探出边贴顶）')
// 水柱占满可见痕迹：与 peekHitbox 逐位一致（看得见的柱子整根可点，不存在半态）
for (const [e, name] of [['left', '左'], ['right', '右'], ['top', '上'], ['bottom', '下']]) {
  const col = waterColumn(e, { width: 56, height: 56 })
  const peek = peekHitbox(e, { width: 56, height: 56 })
  ok(col && col.x === peek.x && col.y === peek.y && col.width === peek.width && col.height === peek.height, `${name}：水柱与 peekHitbox 同源（命中区即柱体）`)
}
eq(waterColumn('left', { width: NaN, height: 56 }), null, 'NaN 尺寸 → null')
eq(waterColumn('left', { width: 0, height: 56 }), null, '零宽 → null')
eq(waterColumn('left', { width: 56, height: 56 }, -1), null, '负探出 → null')
eq(waterColumn('bogus', { width: 56, height: 56 }), null, '非法边 → null')

console.log('用例 7：水色连续插值（10-04-water-color-by-usage：阈值处命中等级色，段间连续）')
const water = await loadTs('src/shared/water-color.ts')
const A = water.defaultWaterAnchors()
// 端点精确命中锚点色（阈值处与卡片/托盘逐位同色：60→warn / 85→danger）
eq(water.waterColor(0, A), water.rgbStr(A.ok), '0% = ok 锚点')
eq(water.waterColor(60, A), water.rgbStr(A.warn), '60% = warn 锚点（阈值命中）')
eq(water.waterColor(85, A), water.rgbStr(A.danger), '85% = danger 锚点（阈值命中）')
eq(water.waterColor(100, A), water.rgbStr(A.dangerDeep), '100% = dangerDeep 锚点')
// 段间连续：中点既不是起点也不是终点（非跳变的三档能过，跳变过不了）
for (const [pct, lo, hi] of [[30, 'ok', 'warn'], [70, 'warn', 'danger'], [92, 'danger', 'dangerDeep']]) {
  const mid = water.waterColor(pct, A)
  ok(mid !== water.rgbStr(A[lo]) && mid !== water.rgbStr(A[hi]), `${pct}% 介于 ${lo}→${hi} 之间（${mid}）`)
}
// 钳制与非法输入（与 fluid.level 同纪律：只夹住，不抛、不透明）
eq(water.waterColor(-5, A), water.waterColor(0, A), '负数钳到 0')
eq(water.waterColor(150, A), water.waterColor(100, A), '超 100 钳到 100')
eq(water.waterColor(NaN, A), water.waterColor(0, A), 'NaN → 0（未知由调用方不渲染表达）')
eq(water.waterColor('60', A), water.waterColor(0, A), '非数字 → 0')
ok(/^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/.test(water.waterColor(37.5, A)), '输出恒为 opaque rgb()（小数 pct 不抖出非法格式）')
// 解析与锚点组装
eq(water.parseCssColor('#ff9f0a'), [255, 159, 10], '#rrggbb 解析')
eq(water.parseCssColor('#fff'), [255, 255, 255], '#rgb 解析')
eq(water.parseCssColor('rgb(48, 209, 88)'), [48, 209, 88], 'rgb() 解析')
eq(water.parseCssColor('rgba(48, 209, 88, 0.5)'), [48, 209, 88], 'rgba() 取通道（水体恒不透明）')
eq(water.parseCssColor('transparent'), null, '关键字 → null')
eq(water.parseCssColor(''), null, '空串 → null')
eq(water.shade([255, 159, 10], 1), [255, 159, 10], 'shade 系数 1 恒等')
const skin = { '--ok': '#30d158', '--warn': '#ff9f0a', '--danger': '#ff453a' }
const seen = []
const resolved = water.resolveWaterAnchors((n) => {
  seen.push(n)
  return skin[n] ?? ''
})
eq(seen, ['--ok', '--warn', '--danger'], 'getter 按 CSS 变量名取值（与 getPropertyValue 同口径）')
ok(resolved != null && resolved.dangerDeep.every((v, i) => v < resolved.danger[i]), '三锚点解析 + dangerDeep 自动压暗')
eq(water.resolveWaterAnchors(() => ''), null, '全缺 → null（整套回退，不给半套）')
eq(water.resolveWaterAnchors((n) => (n === '--warn' ? 'oops' : skin[n])), null, '一锚坏 → null')
eq(JSON.stringify(water.defaultWaterAnchors().ok), JSON.stringify([48, 209, 88]), '缺省锚点 = aero 三色')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
