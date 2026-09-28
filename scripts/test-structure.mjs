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

// ─── D. 09-28-dot-frame-label-carousel：球表面令牌化 + 标签下移 ────────────
//
// 这里**不能裸 grep**，三个坑都真实发生过（写门之前逐个踩过）：
//
//  ① 注释。`.petball-fallback` 块里现在有一条注释，解释「这里原来有
//     backdrop-filter、为什么删」（它履行不了注释宣称的职责，留着是会骗人的注释）。
//     而 PRD AC1.3 的字面表述是「块内 grep backdrop-filter 0 命中」——照字面写出来的门
//     **永远为红**。判据必须是**生效声明**，不是「文件里出现过这个词」。
//     注释本身要留着：删它换门变绿 = 把本任务最值钱的一条知识扔了。
//  ② 行数。AC1.1 写的是 `grep -A14`，而 `background: var(--ball-bg)` 在选择器下方
//     **第 18 行** —— 够不到，那条门会变成永真的假护栏（永远「没借 --bg」）。
//  ③ 首次出现。`.petball-fallback` 的**首个命中**是 :root 里的一条注释（skins.css:35），
//     同尾选择器还有 `.petball.no3d:has(.petball-hit:active) .petball-fallback`
//     （按压态，不是底盘）。按「字符串首次出现」取块，取到的既不是注释也不是底盘。
//
// 所以顺序固定为：剥注释 → 按**完整选择器**定位 → 配平花括号取整块 → 再判声明。
const css = read('src/renderer/src/skins.css').replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * 按**完整选择器**取一条规则的声明体；定位不到就返回 null（绝不返回半个块 ——
 * 半块会让「没找到 backdrop-filter」这种检查变成永真）。
 *
 * 为什么要求「完整」：`.petball.no3d .petball-fallback` 不匹配
 * `.petball.no3d:has(...) .petball-fallback`（按压态那条），也不匹配注释里的提及。
 */
function ruleBody(src, selector) {
  let from = 0
  for (;;) {
    const at = src.indexOf(selector, from)
    if (at < 0) return null
    from = at + selector.length
    // 选择器必须「整条」就是它：从上一条规则边界（} 或 ;）到此处只允许是空白
    let head = at - 1
    while (head >= 0 && src[head] !== '}' && src[head] !== ';') head--
    if (src.slice(head + 1, at).trim() !== '') continue
    // 紧跟的必须是 {（`:root,` 这种逗号续行交给下面的 declScopes 处理）
    let i = at + selector.length
    while (i < src.length && /\s/.test(src[i])) i++
    if (src[i] !== '{') continue
    // 配平花括号取整块。含嵌套块（@media 里的规则）时不算「平面声明块」，返回 null
    let depth = 0
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') depth++
      else if (src[j] === '}' && --depth === 0) {
        const body = src.slice(i + 1, j)
        return body.includes('{') ? null : body
      }
    }
    return null
  }
}

/** 把声明体解析成 { prop: value }。值可跨行（body 的 font-family 就是两行） */
function decls(body) {
  const out = {}
  if (body == null) return out
  for (const piece of body.split(';')) {
    const i = piece.indexOf(':')
    if (i < 0) continue
    const p = piece.slice(0, i).trim()
    if (p && !p.includes('{')) out[p] = piece.slice(i + 1).replace(/\s+/g, ' ').trim()
  }
  return out
}

/**
 * 某个自定义属性在**哪些皮肤作用域**里被声明了。
 * 选择器列表（`:root,\n[data-skin='aero']`）拆成多个作用域。
 *
 * ⚠ 必须区分**顶层**与 **`@media` 内层**，否则这条门是假的（已实测踩过）：
 * 暗色覆盖块的选择器是 `@media (prefers-color-scheme: dark) { :root, [data-skin='aero'] {…} }`
 * —— 它**又声明了一次 :root**。只判「某个作用域里出现过」，那么把顶层
 * `:root` 的 `--ball-rim` 删掉之后，暗色块里的那份仍让 :root 显得「有定义」，
 * 门照样绿 —— 而外部皮肤（ext:*）在**浅色**系统上恰恰只吃得到顶层那份，
 * 那才是 AC1.5 真正依赖的兜底。内层的键因此带 `@media` 后缀，不计入顶层集合。
 */
function declScopes(prop) {
  const scopes = new Set()
  const re = new RegExp(`(^|[;{\\s])${prop}\\s*:`, 'g')
  let m
  while ((m = re.exec(css))) {
    // 从头扫到这条声明，维护开括号栈：栈顶是最近那条规则头，任一层是 at-rule 即视为内层
    const stack = []
    for (let i = 0; i < m.index; i++) {
      const c = css[i]
      if (c === '{') {
        let s = i - 1
        while (s >= 0 && css[s] !== '}' && css[s] !== ';') s--
        stack.push({ head: css.slice(s + 1, i), atRule: /^\s*@/.test(css.slice(s + 1, i)) })
      } else if (c === '}') {
        stack.pop()
      }
    }
    const suffix = stack.some((f) => f.atRule) ? '@media' : ''
    for (const f of stack) {
      if (f.atRule) continue
      if (/:root/.test(f.head)) scopes.add(`root${suffix}`)
      for (const hit of f.head.matchAll(/\[data-skin='([^']+)'\]/g)) scopes.add(`${hit[1]}${suffix}`)
    }
  }
  return scopes
}

console.log('\nD. 球表面令牌化 + 短标签下移（09-28）')

// 骨架必须真的找得到 —— 找错块时下面五条会集体永真，所以先立一条会红的
const FALLBACK = '.petball.no3d .petball-fallback'
const WINLABEL = '.petball.no3d .dot-winlabel'
const fallbackBody = ruleBody(css, FALLBACK)
const winlabelBody = ruleBody(css, WINLABEL)
ok(fallbackBody != null, `D0 按选择器取到 ${FALLBACK} 的整块（剥注释 + 配平花括号）`)
ok(winlabelBody != null, `D0 按选择器取到 ${WINLABEL} 的整块`)

const fb = decls(fallbackBody)
const wl = decls(winlabelBody)

// D1 底盘改用球自己的令牌。判据用「有没有引用 --bg 这个令牌」而不是
// 「有没有 var(--bg) 这串字面量」——后者漏掉 calc()/var 嵌套等写法。
ok(
  /(^|[\s;{])var\(\s*--ball-bg\s*\)/.test(fallbackBody || ''),
  `D1 ball-surface-token 底盘是 var(--ball-bg)（实际 ${JSON.stringify(fb.background || '未找到')}）`
)
ok(
  fallbackBody != null && !/(^|[^\w-])--bg(?![\w-])/.test(fallbackBody),
  'D1 ball-surface-token 生效声明里不再引用页面级的 --bg'
)

// D2 删掉 backdrop-filter（含 -webkit-）。注释已被剥掉，这里判的是**生效声明**。
// ⚠ 负向判据一律带 `block != null` 前置：块没取到时 `includes` 会**空洞地通过**，
//   那和「规则里真的没有」是两件事，必须一起红。
ok(
  fallbackBody != null && !fallbackBody.includes('backdrop-filter'),
  'D2 ball-no-backdrop-filter 生效声明里没有 backdrop-filter / -webkit-backdrop-filter'
)

// D3 顶层 :root 兜底 + 5 个内置皮肤逐个有定义。少了顶层 :root 那一项，外部皮肤（ext:*）
//     在**浅色**系统上没写这个令牌时球会变成**完全透明**——一个没有底的球比浅色的球更糟
//     （AC1.5）。`@media (prefers-color-scheme: dark)` 里那份 :root 不算（见 declScopes）。
const ballBgScopes = declScopes('--ball-bg')
const ballRimScopes = declScopes('--ball-rim')
const SKINS = ['aero', 'dark', 'minimal', 'candy', 'ink']
const missingBg = ['root', ...SKINS].filter((s) => !ballBgScopes.has(s))
const missingRim = ['root', ...SKINS].filter((s) => !ballRimScopes.has(s))
ok(
  missingBg.length === 0,
  `D3 ball-bg-defined-per-skin --ball-bg 在顶层 :root + 5 个皮肤都有（缺 ${missingBg.join(',') || '无'}；实得 ${[...ballBgScopes].sort().join(',')}）`
)
ok(
  missingRim.length === 0,
  `D3 ball-bg-defined-per-skin --ball-rim 在顶层 :root + 5 个皮肤都有（缺 ${missingRim.join(',') || '无'}）`
)

// D4 短标签换字体观感 + 更小（AC3.3）。判据是「解析后不是 body 那一套栈」。
//    ⚠ 「字面量 ≠ body 的 stack」这个写法本身是**假护栏**（已实测踩过）：
//    `font-family: inherit` 与 body 的 stack 字面量当然不同，但**解析结果完全相同**
//    —— 正是 AC3.3 要防的那个回归。所以 inherit 必须单列一条判据。
const wlFont = wl['font-family'] || ''
const bodyFont = decls(ruleBody(css, 'body'))['font-family'] || ''
ok(
  Boolean(wlFont) && wlFont !== 'inherit' && wlFont !== bodyFont,
  `D4 winlabel-mono 短标签声明了独立字体栈，且不是 inherit / 也不是 body 的 stack（实际 ${JSON.stringify(wlFont || '未找到')}）`
)
const wlSize = parseFloat(wl['font-size'] || '')
ok(
  Number.isFinite(wlSize) && wlSize <= 9,
  `D4 winlabel-mono 短标签字号 ≤ 9px（实际 ${wl['font-size'] || '未找到'}）`
)

// D5 下移后不再需要绝对定位。absolute 会把它踢出 grid 行流、重新压回角落。
ok(
  winlabelBody != null && !/^(absolute|fixed)$/.test(wl.position || ''),
  `D5 winlabel-not-absolute 短标签不在流外（position: ${wl.position || '未设置'}）`
)

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
