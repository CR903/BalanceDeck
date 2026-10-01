// 资源占用守卫：three.js 不进首屏 + 159MB 死重不再进包
// 用法：node scripts/test-resource.mjs
//
// 为什么需要这个文件
// ──────────────────
// `README.md:45-46` 曾写着「默认形态不加载 three.js」，而 `PetBall.tsx:11` 当时是**静态**
// import `./pet3d/scene` → `scene.ts:1` 静态 `import * as THREE from 'three'`：
// three.js 占入口 chunk 的 **76%**（1,298,574 B / 1,699,669 B），球形态照样解析它。
// 那句卖点是 commit 89d5f3b 加的，而**那一次提交里静态 import 就已经存在** —— 它从写下起
// 就不准确。把代码改成真的之后，这里把「不能改回去」钉成可执行的约定。
//
// 三条纪律（每条都对应一类真实退化）
//   ① 动态 import **和** manualChunks 缺一无效：只拆 chunk 不改 import 不改变解析时机
//      （实测拆包前后球形态 V8 堆 5.7 vs 5.4 MB），只改 import 不拆 chunk 则 vite 会把 three
//      并回入口 —— 两条都要守。
//   ② 动态 import 引入一个**新**失败模式（chunk 加载失败）。它的正确表现与 WebGL 失败
//      完全相同：退回 2D 圆环。少写那个 catch 就是白屏。
//   ③ `.tga` 与 `reyna-pilot/` 运行时**从不被读取** —— 这个前提一旦被推翻（有人改成真读
//      `.tga`），删掉它们就变成功能回归，所以前提本身也要有守卫。

import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf-8')

let pass = 0
let fail = 0
function ok(cond, label) {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}`)
  }
}
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

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nA. PetBall 的 ./pet3d/scene 必须是动态 import（改回静态 = three 回到首屏）')

const petball = read('src/renderer/src/PetBall.tsx')

// 先剥掉 `import type` —— 那类语句被 esbuild 整条擦掉，不产生运行时代码，
// 留着它是**故意的**（Pet3dHandle 只是个类型）。不剥会把正确写法误判成违规。
const noTypeImports = petball.replace(/^\s*import\s+type\s+[^\n]*\n/gm, '')

// 提到 './pet3d/scene' 的每一行（含行号，好定位）
const sceneRefs = noTypeImports
  .split('\n')
  .map((line, i) => [i + 1, line])
  .filter(([, line]) => line.includes("'./pet3d/scene'"))

// ⚠ 前置断言：不先确认「这段源码找得到」，下面的负向断言就是永真的（quality-guidelines.md
//   §「一条负向断言需要前置条件」）。sceneRefs 为空说明代码被搬走了，不是「没有静态导入」。
ok(sceneRefs.length > 0, `A1 前置：PetBall.tsx 里找得到 './pet3d/scene' 的引用（${sceneRefs.length} 处）`)
const offenders = sceneRefs.filter(([, line]) => !/import\(\s*'\.\/pet3d\/scene'\s*\)/.test(line))
eq(
  offenders.map(([n]) => n),
  [],
  "A2 每一处 './pet3d/scene' 都是 import(...) 动态形式（顶层静态 import 会把 three 打回首屏）"
)
ok(
  /import type \{[^}]*Pet3dHandle[^}]*\} from '\.\/pet3d\/scene'/.test(petball),
  'A3 Pet3dHandle 走 import type（类型导入被整条擦掉，不产生运行时代码）'
)
// ⚠ 只断言「这行存在」是不够的：守卫被挪到建场景**之后**它照样为绿，而那正是它要拦的回归。
// 所以钉的是**位置**（必须早于动态 import，也就是早于 three 的解析时机）。
const guardAt = petball.search(/\n\s*if \(!figure\) return/)
const dynIdx = petball.indexOf("import('./pet3d/scene')")
ok(
  guardAt >= 0 && dynIdx > guardAt,
  'A4 球形态的 return 早于动态 import（守卫存在但被挪到建场景之后就失效 = 球形态也会建 WebGL 上下文）'
)

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nB. 动态 import 的失败兜底（D5：不许白屏）')

// 取 effect 体：从动态 import 那一行到依赖数组 `}, [figure])`。
// 两端都必须找得到，否则下面所有判断都在空气里跑。
const dynAt = petball.indexOf("import('./pet3d/scene')")
const effEndAt = petball.indexOf('}, [figure])', dynAt)
ok(dynAt > 0 && effEndAt > dynAt, `B1 前置：能取到 3D effect 的源码区间（${dynAt} → ${effEndAt}）`)
const eff = dynAt > 0 && effEndAt > dynAt ? petball.slice(dynAt, effEndAt) : ''

const catchAt = eff.indexOf('.catch(')
ok(catchAt > 0, 'B2 effect 上有 .catch（动态 import 会失败：chunk 缺失 / 文件缺失 / 网络不可达）')

// ⚠ B3/B4 的坐标必须是**整个文件**而不是 `eff` 切片：`eff` 从 import 那一行起，
// 于是「在 import 之前多报了一次 ready」这种回归根本落不进切片里，断言照样为绿
// （已实测：把 setReady(true) 提回 import 之前，B3/B4 仍是绿的 —— 那正是 D5①要拦的）。
// 语义钉死为：**全文件第一处 setReady(true) 必须落在 .then 与 .catch 之间**。
// ⚠ 全文件坐标：eff 是 petball 的切片，相对索引必须 + dynAt 换算成绝对位置，
// 否则 B4 会拿「切片内的 catch」去比「全文件的 ready」，两个坐标系混用必然误判。
const thenAt = dynAt + eff.indexOf('.then(')
const catchAtAbs = dynAt + catchAt
const readyAt = petball.indexOf('setReady(true)')
ok(
  thenAt > dynAt && readyAt > thenAt,
  'B3 全文件第一处 setReady(true) 落在 .then 之后（import 还没回来就报 ready = 命中区按不存在的场景算投影）'
)
ok(catchAt > 0 && readyAt < catchAtAbs, 'B4 setReady(true) 不在 .catch 里（失败路径不得报 ready）')

const catchBody = catchAt > 0 ? eff.slice(catchAt) : ''
ok(catchBody.includes('setFailed(true)'), 'B5 chunk 加载失败复用既有的 2D 圆环兜底（缺这句就是白屏，而不是退回 2D）')
ok(
  catchBody.includes('[pet3d]') && /console\.(error|warn)/.test(catchBody),
  'B6 失败分支留了日志（静默失败会让下一次排查无从下手）')
const webglCatch = /catch \(e\) \{[\s\S]{0,400}?setFailed\(true\)/.test(eff)
ok(webglCatch, 'B7 WebGL 初始化失败的兜底仍在（老显卡/驱动异常 → 退回 2D）')

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nC. manualChunks：three 本体固定成独立 chunk（D4：与动态 import 缺一无效）')

const viteCfg = read('electron.vite.config.ts')
ok(viteCfg.includes('manualChunks'), 'C1 electron.vite.config.ts 里有 manualChunks')
const threeChunkAt = viteCfg.indexOf("node_modules/three")
ok(threeChunkAt > 0, 'C2 manualChunks 覆盖 node_modules/three')
ok(threeChunkAt > viteCfg.indexOf('manualChunks'), 'C3 node_modules/three 写在 manualChunks **之内**（不是配置块外的另一处）')
ok(
  /renderer:\s*\{[\s\S]*build:\s*\{[\s\S]*rollupOptions/.test(viteCfg),
  'C4 rollupOptions 挂在 renderer 下（挂到 main/preload 不影响渲染层产物）'
)

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nD. 打包产物：from/to 不能动，但死重不许进包（D2 + D1）')

// 剥掉整行注释再判 —— 本文件自己在 electron-builder.yml 里解释 filter 的注释里就写着
// `*.tga` 与 `reyna-pilot/`；不剥的话下面两条断言读到的是注释而非配置（这条坑在本仓库
// 已经踩过三次，见 quality-guidelines.md §「不要断言注释里的文字」）。
const yml = read('electron-builder.yml').replace(/^\s*#.*$/gm, '')
ok(yml.includes('from: resources/human-pets'), 'D1 extraResources 仍从 resources/human-pets 取')
ok(yml.includes('to: human-pets'), 'D2 落点仍是 human-pets（main/human-assets.ts:31 靠 process.resourcesPath/human-pets 寻址）')
ok(yml.includes("'!**/*.tga'"), 'D3 filter 排掉 *.tga（128.0 MB，运行时从不被读取）')
ok(yml.includes("'!reyna-pilot/**'"), 'D4 filter 排掉 reyna-pilot/（31.0 MB，全仓库零引用）')
ok(yml.includes("'**/*'"), 'D5 filter 以 \'**/*\' 开头（electron-builder 的 filter 是覆盖语义，不写这一条会只留下两条排除项、什么都不打进去）')
// ⚠ D6 钉的是**归属**而不是「filter 出现在 from 之后」：后者在「filter 被挪到另一条
// extraResources 条目」时可能仍然为绿（只要那条条目排在前一条后面）。这里把 yml 从
// human-pets 那条截到「下一条 - from:」或「extraResources 的下一个顶层键」为止，
// 要求 filter 落在这段**之内**。human-pets 当前是最后一条 → 边界取下一个顶层键。
const hpAt = yml.indexOf('- from: resources/human-pets')
let hpEnd = yml.indexOf('\n  - from:', hpAt + 1)
if (hpEnd <= hpAt) {
  // 最后一条：下一处顶格（无缩进）的 `key:` 就是 extraResources 的结束
  const rest = yml.slice(hpAt)
  const m = rest.slice(1).match(/\n[a-zA-Z][^\n]*:/)
  hpEnd = m ? hpAt + 1 + m.index : yml.length
}
const hpEntry = hpAt >= 0 ? yml.slice(hpAt, hpEnd) : ''
ok(
  hpAt >= 0 && hpEnd > hpAt && hpEntry.includes('filter:'),
  'D6 filter 就在 human-pets 那一条 extraResources 里（挪到别的条目 = 死重照旧进包）'
)

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nE. 采集脚本：转完即删源 .tga（D1 第一道防线 + D3 不动 PETS 列表）')

const fetchSrc = read('scripts/fetch-human-pets.mjs')
ok(fetchSrc.includes('sweepConvertedTga'), 'E1 fetch-human-pets.mjs 里有清理 .tga 的函数')
ok(/unlinkSync\(/.test(fetchSrc), 'E2 清理靠 unlinkSync 真删文件（不是只排除出体积统计）')
// ⚠ 定义行 `function sweepConvertedTga(` 本身也含 `sweepConvertedTga(` —— 直接
// indexOf/matchAll 会把它算成「调用点」。下面先把定义摘掉，剩下的才是真调用点。
const defRe = /function\s+sweepConvertedTga\s*\([^)]*\)\s*\{/
const defAt = fetchSrc.search(defRe)
ok(defAt >= 0, 'E0 前置：能定位到 sweepConvertedTga 的函数定义')
const noDef = defAt >= 0 ? fetchSrc.replace(defRe, '') : ''
const calls = [...noDef.matchAll(/sweepConvertedTga\(/g)]
ok(calls.length >= 2, `E3 sweepConvertedTga 有 ≥2 个真实调用点（短路前一处 + 转完一处；实测 ${calls.length}）`)

// 「素材早已齐」的机器也必须能清 —— 清理点必须在幂等短路**之前**。
// ⚠ 这条曾经是空壳：旧写法拿 indexOf('sweepConvertedTga(') 当调用点，而它命中的是**函数定义**
//   （定义在 main() 之前，永远早于短路点）—— 把真调用点挪到短路之后它照样为绿（已实测）。
const cachedAt = noDef.indexOf('human-pets cached')
const firstCall = noDef.indexOf('sweepConvertedTga(')
ok(
  defAt >= 0 && cachedAt > 0 && firstCall > 0 && firstCall < cachedAt,
  'E4 清理点在「human-pets cached」短路之前（否则已齐的机器打一行 cached 就退出，128MB 死重永远留着）'
)
// 只删「同名 .png 已就位」的：转换失败那一张要留着给下一轮重下
ok(
  /existsSync\(join\(dir, name\.replace\(\/\\\.tga\$\/i, '\.png'\)\)\)/.test(fetchSrc),
  'E5 只删同名 .png 已经在的（删掉未转换的源文件 = 下一轮要重下几十 MB）'
)
// D3：PETS 列表决定下载哪些模型，与删源文件是两件事。动它属于行为变更。
const petsBlock = fetchSrc.slice(fetchSrc.indexOf('const PETS = ['), fetchSrc.indexOf('const ANIM_DIRS'))
const petIds = [...petsBlock.matchAll(/^\s*id: '([^']+)'/gm)].map((m) => m[1])
eq(petIds, ['aria', 'ray'], 'E6 PETS 列表仍是 aria / ray（reyna-pilot 不在采集清单里 —— 删它是人工决定，不是把它加进下载名单）')
ok(
  petIds.every((id) => id !== 'reyna' && id !== 'reyna-pilot'),
  'E7 PETS 里没有 reyna / reyna-pilot（reyna-pilot/ 不可由 fetch:humans 重建，加进去等于让脚本去下 31MB 没人用的 GLB）'
)

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nF. 删除 .tga 的前提：运行时确实不读它（前提被推翻 = 功能回归）')

const humanTs = read('src/renderer/src/pet3d/human.ts')
ok(
  /replace\(\/\\\.tga\$\/i, '\.png'\)/.test(humanTs),
  'F1 pet3d/human.ts 把 FBX 里的 *.tga 按 basename 重定向到 textures/*.png（运行时取不到 .tga）'
)
const assetsTs = read('src/main/human-assets.ts')
ok(assetsTs.includes('const MIME'), 'F2 前置：human-assets.ts 有 MIME 表')
ok(!/"'\.tga'|\.tga':/.test(assetsTs), 'F3 MIME 表里没有 .tga（bd-asset:// 这条路径从设计上就不服务它）')

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nG. 磁盘实测（resources/ 是 gitignored，前置不成立时跳过而不是空过）')

const humanPets = join(ROOT, 'resources', 'human-pets')
if (!existsSync(humanPets)) {
  // 前置不成立时**照实说跳过**。直接写 !existsSync(join(ROOT,'resources','human-pets','reyna-pilot'))
  // 会在没跑过 npm run fetch:humans 的机器上永远为绿 —— 那是永真的假护栏。
  pass++
  console.log('  ✓ G 前置未满足（resources/human-pets 未拉取）→ 磁盘侧断言跳过，请先 npm run fetch:humans')
} else {
  const { readdirSync, statSync } = await import('node:fs')
  const walk = (d, out = []) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p, out)
      else out.push(p)
    }
    return out
  }
  const all = walk(humanPets)
  const byExt = {}
  let total = 0
  for (const p of all) {
    const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase()
    const s = statSync(p).size
    byExt[ext] = (byExt[ext] ?? 0) + s
    total += s
  }
  const mb = (b) => (b / 1048576).toFixed(1)
  ok(
    !all.some((p) => p.toLowerCase().endsWith('.tga')),
    `G1 磁盘上没有 .tga（实测 ${(mb(byExt.tga ?? 0))} MB；两条清理路径任一生效即为真）`
  )
  ok(
    !existsSync(join(humanPets, 'reyna-pilot')),
    'G2 磁盘上没有 reyna-pilot/（实测 ' + mb(0) + ' MB 已清；它不在 PETS 里，删了 fetch:humans 不会重建）'
  )
  // 12 张贴图 + 24 个 FBX 是运行时真读的，删多了就是功能回归
  eq(byExt.png ? all.filter((p) => p.toLowerCase().endsWith('.png')).length : 0, 12, 'G3 12 张 .png 全在（5 贴图/人 × 2 + 2 张 preview.png）')
  eq(all.filter((p) => p.toLowerCase().endsWith('.fbx')).length, 24, 'G4 24 个 .fbx 全在（每人 1 模型 + 10 动作 + 富余）')
  ok(total < 80 * 1048576, `G5 human-pets 总体积 ${mb(total)} MB（基线 221 MB / 死重 159 MB；>80MB 说明没清干净）`)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
