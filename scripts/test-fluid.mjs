// shared/fluid.ts 行为测试（纯函数，node 直接跑）
// 用法：node scripts/test-fluid.mjs
//
// 隐藏相位与液位：时序常量/液位映射/mini-pill 命中区/相位映射（吸入/汇聚两段
// morph 与 dock:fluid 通道的唯一口径。渲染层与主进程状态机共用同一实现，
// 不各自硬编码；隐藏态几何归 shared/dock-hide.ts 的 mini-pill，不归这里 ——
// 旧 waterColumn（屏边温度计水柱）已随水球退役，用例 3/4 改钉 pill）。

import { loadTs } from './lib/load-ts.mjs'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const fluid = await loadTs('src/shared/fluid.ts')
const dockHide = await loadTs('src/shared/dock-hide.ts')
const { peekHitbox } = dockHide
const {
  ABSORB_STRETCH_MS,
  ABSORB_MERGE_MS,
  ABSORB_SETTLE_MS,
  ABSORB_TOTAL_MS,
  REVEAL_MS,
  FLUID_PHASES,
  isFluidPhase,
  fluidForPhase,
  level
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
ok(REVEAL_MS < ABSORB_TOTAL_MS, '汇聚快于吸入（退出更快，与 morph 方向同向）')

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

console.log('用例 3：隐藏命中区即 mini-pill（10-10-dynamic-island R6：peekHitbox 直出顶部 pill）')
eq(dockHide.MINI_PILL_W, 132, 'pill 宽 132px（窄条 + 各家等级点放得下）')
eq(dockHide.MINI_PILL_H, 26, 'pill 高 26px（细条不抢视觉）')
eq(peekHitbox('top', { width: 560, height: 480 }), { x: 214, y: 0, width: 132, height: 26 }, '岛窗 560×480：132×26 顶部居中（(560-132)/2=214）')
eq(peekHitbox('left', { width: 560, height: 480 }), { x: 214, y: 0, width: 132, height: 26 }, '岛只吸顶：左沿同样收成顶部 pill')
eq(peekHitbox('right', { width: 560, height: 480 }), { x: 214, y: 0, width: 132, height: 26 }, '右沿同样收成顶部 pill')
eq(peekHitbox('bottom', { width: 560, height: 480 }), { x: 214, y: 0, width: 132, height: 26 }, '下沿同样收成顶部 pill')
// 窄窗夹紧（fail-open 的一部分）：窗口比 pill 窄时按窗口收，不凭空摆错位 pill
eq(peekHitbox('top', { width: 100, height: 480 }), { x: 0, y: 0, width: 100, height: 26 }, '窄窗：宽按窗口夹紧（x=0）')
eq(peekHitbox('top', { width: 560, height: 20 }), { x: 214, y: 0, width: 132, height: 20 }, '矮窗：高按窗口夹紧')
eq(peekHitbox('left', { width: NaN, height: 480 }), null, 'NaN 尺寸 → null')
eq(peekHitbox('left', { width: 0, height: 480 }), null, '零宽 → null')
eq(peekHitbox('bogus', { width: 560, height: 480 }), null, '非法边 → null')

console.log('用例 4：pill 几何守卫（坏输入回 null，不摆错位 pill）')
eq(peekHitbox('left', null), null, 'null 尺寸 → null')
eq(peekHitbox('up', { width: 560, height: 480 }), null, '非法边 → null（不是 undefined）')

console.log('用例 5：相位映射（DockPhase → FluidPhase，唯一口径）')
eq(fluidForPhase('hiding'), 'absorbing', 'hiding → absorbing（morph 中）')
eq(fluidForPhase('hidden'), 'hidden', 'hidden → hidden（隐藏态）')
eq(fluidForPhase('dwell-reveal'), 'hidden', 'dwell-reveal → hidden（唤出停留仍算隐藏）')
eq(fluidForPhase('revealing'), 'revealing', 'revealing → revealing（morph 尾中）')
eq(fluidForPhase('idle'), 'edge-visible', 'idle → edge-visible')
eq(fluidForPhase('dwell-hide'), 'edge-visible', 'dwell-hide → edge-visible（morph 还没开始）')
eq(fluidForPhase('edge-visible'), 'edge-visible', 'edge-visible → edge-visible')
eq(fluidForPhase('dwell-rehide'), 'edge-visible', 'dwell-rehide → edge-visible（重藏等待时岛在全可见位）')
eq(fluidForPhase('bogus'), 'edge-visible', '未知相位 → edge-visible（默认画全可见岛）')
eq(JSON.stringify(FLUID_PHASES), JSON.stringify(['edge-visible', 'absorbing', 'hidden', 'revealing']), '相位全集四项')
ok(isFluidPhase('absorbing') && !isFluidPhase('hiding') && !isFluidPhase(''), 'isFluidPhase 只认四相位')

console.log('用例 6：水色连续插值（10-04-water-color-by-usage：阈值处命中等级色，段间连续）')
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
eq(seen, ['--ball-ok', '--ok', '--ball-warn', '--warn', '--ball-danger', '--danger', '--ball-accent', '--accent'], 'getter 按 CSS 变量名取值（球级 --ball-* 优先，缺省回落页面级 --*；与 getComputedStyle 同口径）')
ok(resolved != null && resolved.dangerDeep.every((v, i) => v < resolved.danger[i]), '三锚点解析 + dangerDeep 自动压暗')
eq(water.resolveWaterAnchors(() => ''), null, '全缺 → null（整套回退，不给半套）')
eq(water.resolveWaterAnchors((n) => (n === '--warn' ? 'oops' : skin[n])), null, '一锚坏 → null')
eq(JSON.stringify(water.defaultWaterAnchors().ok), JSON.stringify([48, 209, 88]), '缺省锚点 = aero 三色')
// R4-6 accent：独立回退（不参与插值，缺了只影响余额水，不连累用量水）
eq(JSON.stringify(water.defaultWaterAnchors().accent), JSON.stringify([10, 132, 255]), '缺省 accent = aero #0a84ff')
const noAccent = water.resolveWaterAnchors((n) => (n === '--accent' ? '' : skin[n]))
ok(noAccent != null && JSON.stringify(noAccent.accent) === JSON.stringify([10, 132, 255]), '缺 accent → 回退色，不整套 null')
const withAccent = water.resolveWaterAnchors((n) => (n === '--accent' ? '#8b5cf6' : skin[n]))
eq(withAccent && withAccent.accent, [139, 92, 246], 'accent 正常解析（candy 紫）')
eq(withAccent && water.rgbStr(withAccent.accent), 'rgb(139, 92, 246)', '余额水色 = accent 实色（不插值）')
// B5：球级锚点 --ball-* 优先，页面级 --* 兜底（ink 的深墨盘上，页面级纸色发泥，
// 球级是「同一语义在深盘上要亮的版本」）。
{
  const ballInk = {
    '--ok': '#4f7a3a', '--warn': '#b07d20', '--danger': '#a63b2f', '--accent': '#8a6d3b',
    '--ball-ok': '#5cc86a', '--ball-warn': '#ffab3d', '--ball-danger': '#ff5f45', '--ball-accent': '#ffb84d'
  }
  const inkResolved = water.resolveWaterAnchors((n) => ballInk[n] ?? '')
  ok(inkResolved != null, 'ink 球级锚点齐全（球级优先 → 整套解析成功）')
  eq(inkResolved && inkResolved.ok, [0x5c, 0xc8, 0x6a], 'ink --ball-ok 优先于 --ok（不是纸色发泥）')
  eq(inkResolved && inkResolved.warn, [0xff, 0xab, 0x3d], 'ink --ball-warn 优先于 --warn')
  eq(inkResolved && inkResolved.danger, [0xff, 0x5f, 0x45], 'ink --ball-danger 优先于 --danger')
  eq(inkResolved && inkResolved.accent, [0xff, 0xb8, 0x4d], 'ink --ball-accent 优先于 --accent（余额弧不发暗）')
  // 页面级 --ok 未被覆盖（同值 = 卡片/柱内液仍在读页面级）：
  eq(inkResolved && water.waterColor(37.5, inkResolved), 'rgb(194, 182, 78)', 'ink 37.5% 水色 = --ball-ok 与 --ball-warn 的插值（t=37.5/60，落在绿-琥珀中段）')
}
// --ball-* 未声明（getComputedStyle 返回空串）→ 完全回落页面级（其余四皮与任务前逐值相同）
eq(
  JSON.stringify(water.resolveWaterAnchors((n) => skin[n] ?? '')?.ok),
  JSON.stringify([0x30, 0xd1, 0x58]),
  '球级缺失 → 页面级兜底（aero 值 = 任务前值，其余四皮零回归）'
)

console.log('用例 7：倒水入场时序（10-04-pour-in-slosh：三段串行 ≈ AC 2.5s 内结束）')
eq(fluid.POUR_FILL_MS, 600, '灌入 600ms ease-in')
eq(fluid.POUR_TOP_MS, 250, '冲顶 250ms（接灌入尾）')
eq(fluid.POUR_SLOSH_MS, 1600, '荡漾 1600ms（接冲顶尾）')
eq(fluid.POUR_TOTAL_MS, 2450, '总 2450ms（≤ AC 2.5s，播完 JS 摘 data-pour）')
eq(fluid.POUR_TOTAL_MS, fluid.POUR_FILL_MS + fluid.POUR_TOP_MS + fluid.POUR_SLOSH_MS, '总数 = 三段之和（不手算 2450）')
ok(fluid.POUR_TOTAL_MS < 2600 && fluid.POUR_TOTAL_MS > fluid.ABSORB_TOTAL_MS, '入场比吸入 morph 长（存在感优先于克制，G1 结论）')

console.log('用例 8：各皮肤波形表（R1：逐皮肤振幅/波长 + CSS 漂移距离跨钉）')
const skinWaves = await loadTs('src/renderer/src/skin-waves.ts')
const SKINS9 = ['aero', 'dark', 'minimal', 'candy', 'ink']
const table = Object.fromEntries(SKINS9.map((s) => [s, skinWaves.skinWaves(s)]))
// 未知皮肤（含 ext:*)回默认（不断裂；回退值与 aero 同源，不手写第二份数字）
eq(JSON.stringify(skinWaves.skinWaves('ext:foo')), JSON.stringify(skinWaves.defaultWaves()), 'ext 未知皮肤 → 默认波形')
eq(JSON.stringify(skinWaves.skinWaves('aero')), JSON.stringify(skinWaves.defaultWaves()), 'aero 即默认波形')
eq(JSON.stringify(skinWaves.skinWaves('')), JSON.stringify(skinWaves.defaultWaves()), '空 id → 默认波形')
// 每皮肤振幅 A>B>C 递减（能量向大层集中）+ 波长为正
for (const s of SKINS9) {
  const t = table[s]
  ok(t.a.A > t.b.A && t.b.A > t.c.A, `${s} 振幅递减（${t.a.A}>${t.b.A}>${t.c.A}）`)
  ok(t.a.L > 0 && t.b.L > 0 && t.c.L > 0, `${s} 波长为正`)
}
// 皮肤之间真不一样（A 层振幅至少三档 distinct，否则"换皮如换汤"）
const distinctA = new Set(SKINS9.map((s) => table[s].a.A))
ok(distinctA.size >= 3, `A 层振幅 ${distinctA.size} 档 distinct（aero/minimal/candy 必须拉开）`)
// CSS --wave-len-* 与表中 L 逐值相等（漂移距离恒 = 波长整数倍，无缝循环不断裂）。
// 只认裸皮肤块 `[data-skin='x'] { … }`（disc 背景等后代规则另起块，不在此口径内）。
const skinCss9 = readFileSync(resolve(ROOT, 'src/renderer/src/skins.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
for (const s of SKINS9) {
  for (const [layer, key] of [['a', 'a'], ['b', 'b'], ['c', 'c']]) {
    const re = new RegExp(`\\[data-skin='${s}'\\] \\{[^}]*?--wave-len-${layer}:\\s*([\\d.]+)px`)
    const m = skinCss9.match(re)
    eq(m && Number(m[1]), table[s][key].L, `${s} --wave-len-${layer} == 表中 L（${table[s][key].L}）`)
  }
}

// 用例 9b：环形进度的弧长口径（P6 环形态皮肤）。半径在 CSS 令牌里，本表只钉"周长归一化"
// 这一个数学 —— pathLength=100 让 dasharray 的单位变成百分比，于是 --ring-r 逐皮可换而
// 弧长比例不变。若哪天有人把 pathLength 去掉，这条表的输出仍是绿的（CSS 侧会错），
// 所以配套的静态断言在 test-structure 的 K11f（pathLength 必须带）。
console.log('用例 9b：环形进度弧长（P6：pathLength 归一化 + 钳制 + 端点精确命中）')
const rings = await loadTs('src/renderer/src/skin-rings.ts')
const { ringDash, RING_DASH_SPACE } = rings
eq(RING_DASH_SPACE, 100, '归一化空间 = 100（dasharray 的单位是百分比，不是像素）')
eq(ringDash(0), '0.00 100', '0% → 不画弧（"0.00 100" 而不是 0 长度 dash，后者会渲染成圆点）')
eq(ringDash(1), '100.00 100', '100% → 满圈')
eq(ringDash(0.41), '41.00 100', '41% → 41% 弧长（原型 41% 用量的那一格）')
// 量化粒度 2 位小数：与 shared/fluid.level 的一位小数同源，弧与水位不会一格动一格不动
eq(ringDash(0.415), '41.50 100', '0.415 → 两位小数（不是 41.499999…）')
// 端点精确：1/3 不该出现 33.33…0001 这种尾巴（同一输入永远同一输出）
eq(ringDash(1 / 3), ringDash(1 / 3), '同一输入两次调用恒等（无逐帧抖动）')
// 钳制与非法输入：与 fluid.level / waterColor 同一纪律（只夹住，不替上游撒谎）
eq(ringDash(-0.2), '0.00 100', '负数钳到 0')
eq(ringDash(1.4), '100.00 100', '超 1 钳到 1')
eq(ringDash(NaN), '0.00 100', 'NaN → 0（未知由调用方不渲染表达）')
eq(ringDash('0.5'), '0.00 100', '非数字 → 0（不是 50 —— 字符串不该被当数字）')
// 单调：弧长随进度单调不减（"环不随读数变"的反面）。
// 比数值不比字符串 —— "9.00 100" > "100.00 100" 在字典序下成立，那是这条门自己的错。
const dashNum = (s) => Number.parseFloat(s)
ok(
  [0, 0.25, 0.5, 0.75, 1].every((p, i, a) => i === 0 || dashNum(ringDash(p)) > dashNum(ringDash(a[i - 1]))),
  '弧长随进度严格单调递增（按数值比，不按字符串字典序）'
)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
