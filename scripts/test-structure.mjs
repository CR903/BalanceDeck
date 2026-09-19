// 结构守卫：入口模块不许再长回去
// 用法：node scripts/test-structure.mjs
//
// 为什么需要：src/main/index.ts 曾经是 1441 行 —— 接口是「启动应用」，实现里却塞着
// 三个运行模式、截图走查和 750 行 UI 断言（架构评审候选 C6）。2026-09-19 把它们搬进
// src/main/qa/ 之后入口只剩 411 行。这个文件把那次收口的成果变成可执行的约定：
// 谁再把测试代码写回入口，`npm test` 就会红。
//
// 这里断言的是**结构**而非行为，所以只做便宜的静态检查（读文件，不启动 electron）。

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

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

const INDEX = 'src/main/index.ts'
const index = read(INDEX)
const lines = index.split('\n').length

console.log('\nA. 入口模块只负责启动与分派')

ok(lines <= 500, `A1 ${INDEX} 不超过 500 行（当前 ${lines} 行）`)
ok(!/executeJavaScript/.test(index), 'A2 入口里没有 executeJavaScript（UI 驱动属于 qa/）')
ok(!/^\s*(async )?function run(UiTest|Shots)/m.test(index), 'A3 入口里没有 runUiTest / runShots 定义')
ok(/'--uitest'|'--shots'/.test(index), 'A4 入口仍认得 --uitest / --shots 参数（只做分派）')

console.log('\nB. QA 工具各归其位')

for (const f of ['src/main/qa/fixtures.ts', 'src/main/qa/shots.ts', 'src/main/qa/uitest.ts', 'src/main/qa/ballshot.ts', 'src/main/qa/modes.ts']) {
  ok(existsSync(resolve(ROOT, f)), `B ${f} 存在`)
}
const qaFiles = readdirSync(resolve(ROOT, 'src/main/qa')).sort()
ok(
  qaFiles.join(',') === 'ballshot.ts,fixtures.ts,modes.ts,shots.ts,uitest.ts',
  `B4 src/main/qa/ 只放这五样（当前 ${qaFiles.join(', ')}）`
)
const qa = read('src/main/qa/uitest.ts')
ok(!/^import .*from '\.\/(skins|keystore|ipc|scheduler|overlay)'/m.test(qa), 'B5 qa/ 里不残留错误的相对路径')

console.log('\nC. QA 工具不被产品代码引用')

// 渲染层与共享层不该知道 qa/ 的存在（它是主进程内的测试工具）
const productFiles = [
  ...readdirSync(resolve(ROOT, 'src/renderer/src')).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx')),
  ...readdirSync(resolve(ROOT, 'src/shared')).filter((f) => f.endsWith('.ts'))
]
const leaking = productFiles.filter((f) => {
  const dir = f.endsWith('.ts') && existsSync(resolve(ROOT, 'src/shared', f)) ? 'src/shared' : 'src/renderer/src'
  return /from '.*\/qa\//.test(read(`${dir}/${f}`))
})
ok(leaking.length === 0, `C1 渲染层 / 共享层不 import qa/（越界文件：${leaking.join(', ') || '无'}）`)

// 主进程里只有入口可以引用 qa/（fixtures 例外：--ballshot 分支要用它）
const mainFiles = readdirSync(resolve(ROOT, 'src/main'))
  .filter((f) => f.endsWith('.ts'))
  .filter((f) => !f.startsWith('index.'))
const mainLeaking = mainFiles.filter((f) => /from '\.\/qa\//.test(read(`src/main/${f}`)))
ok(mainLeaking.length === 0, `C2 主进程其余模块不 import qa/（越界文件：${mainLeaking.join(', ') || '无'}）`)

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
