// 结构守卫：入口模块不许再长回去
// 用法：node scripts/test-structure.mjs
//
// 为什么需要：src/main/index.ts 曾经是 1441 行 —— 接口是「启动应用」，实现里却塞着
// 三个运行模式、截图走查和 750 行 UI 断言（架构评审候选 C6）。2026-09-19 把它们搬进
// src/main/qa/ 之后入口只剩 411 行。这个文件把那次收口的成果变成可执行的约定：
// 谁再把测试代码写回入口，`npm test` 就会红。
//
// 这里断言的是**结构与跨进程前提**而非行为，所以只做便宜的静态检查（读文件，不启动 electron）。
// A–D 守「不许长回去」，E 守「播报链路的主进程前提不许被静默拆掉」，
// F 守「TTS 请求必须留在主进程」—— CSP 逐字不变、渲染层不再 fetch、tts:speak 出口不缺。

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

/**
 * 取某个自定义属性在指定作用域块里的**值**（:root 或某个 [data-skin='x']）。
 *
 * ⚠ 为什么不能 `css.match(/\[data-skin='x'\]\s*\{([^{}]*)\}/)` 就完事（实测踩过）：
 *   同一皮肤在文件里有**多个块** —— minimal 有 :186 的主色块和 :3011 的流体块。
 *   非全局 match 只命中第一个，而那个块里根本没有要找的属性，于是恒「未找到」
 *   （第一次写成那样时，K11f3 两条都报"实际 未找到"，看着像规则缺失，其实是取错块）。
 *   所以遍历**所有**候选块，取命中的最后一个 —— 后写的赢，与 CSS 层叠一致。
 *   这与 declScopes 的分工：那边判「在哪些作用域**存在**」，这边读「**值**是多少」。
 */
function tokenInScope(prop, scope) {
  const re =
    scope === 'root'
      ? /:root[^{}]*\{([^{}]*)\}/g
      : new RegExp(`\\[data-skin='${scope}'\\]\\s*\\{([^{}]*)\\}`, 'g')
  const rx = new RegExp(`${prop}\\s*:\\s*([^;]+)`)
  let m
  let hit = null
  while ((m = re.exec(css))) {
    const v = (m[1].match(rx) || [])[1]
    if (v != null) hit = v.trim()
  }
  return hit
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

// D6 宠物窗口内**不许有 outer box-shadow**（AC5.1/AC5.3）。
// 守的正是「球外面套一圈浅色方框」的真凶：元素尺寸 = 窗口尺寸时外阴影无处容放却被绘制 ——
// 圆形的光晕被窗口裁成方形，**窗口内、元素外**的那几块（四个角）留在画面上（design.md §9）。
//
// ⚠ 本门只管辖**这一类**元素：**尺寸等于（或大于）宠物窗口**的那些。判据的成立依赖这个前提，
//   扩大到窗口内普通元素就是假红了 —— `.petball-caption` 就有合法的 outer
//   `0 2px 10px`（胶囊要靠投影在任何壁纸上读得清），它 max-width 140px 装在 213×293 的
//   人物窗口里，从不等于窗口。展开态 384×600 里的 `.pcard`/`.hero`/`.dot`/`.btn`/
//   `.knob`/`:focus` **也不在本门内，但理由不是「被 padding 内缩」** —— 实测 `.pcard` 的
//   右边框离窗口边只剩 14px，`.pcard.dragging` 的 36+30px 阴影确实被窗口边界裁掉了。
//   真正让展开态安全的是 `.card` 自己：`width/height:100%` + `border-radius:16px` +
//   `overflow:hidden` + **无 own box-shadow**，把后代所有墨迹溢出裁进圆角矩形
//   （像素证据：右缘 alpha 轮廓对称收口，圆角矩形之外 0 像素带 alpha）。
//   ⚠ 所以展开态的护栏该加在 `.card` 上，而不是在每条阴影上 —— 那条门**目前不存在**，
//   详见 design.md §9.8 与 spec 的 component-guidelines.md。
//
// ⚠ 为什么不能简单 `includes('inset')`：底座原来那条是
// `inset …, inset …, 0 6px 18px rgba(0,0,0,0.28)` —— 「含 inset」照样绿。
// 必须**逐层**判，且「层」要按**顶层逗号**切：`rgba(0,0,0,0.28)` 与
// `color-mix(in srgb, var(--ok) 18%, transparent)` 里都有逗号，按 `,` 裸切会把
// `var(--ok) 18%` 切成一个「层」，那条并不以 inset 开头 → 假红。
function shadowLayers(value) {
  const out = []
  let depth = 0
  let cur = ''
  for (const c of value) {
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

const PET_WINDOW_FULLBLEED = [
  ['.petball.no3d .petball-fallback', '球盘：56×56 = 球形态窗口 56×56（BALL_VIEW）'],
  ['.petball.no3d:has(.petball-hit:active) .petball-fallback', '球盘按压态：同一元素、同一尺寸'],
  ['.petball-rename input', '改名输入框：168×28 却活在 56×56 窗口里，20px 光晕照样铺满'],
  ['.petball-hit', '命中层：inset:0 = 整块窗口'],
  // P2 玻璃罩与 P4 预览气泡同样是 56×56 窗口纪律的管辖对象：
  //   · ::after 是 inset:0 全覆盖 fallback 的玻璃层，本体无阴影（写 outer 同样被裁方）；
  //   · .fluid-peek 是 inset:0 的整球预览，阴影全 inset（两层 inset，见规则本体）。
  // 判据与上表同一条（body != null + outer 0 层）：无阴影的 0 层同样合规，
  // 有人加上 outer 即红 —— 补的是"名单不全"的机器门空洞，不是新纪律。
  ['.petball.no3d .petball-fallback::after', '玻璃罩：inset:0 全覆盖球盘，本体无阴影'],
  // P6 环形进度层：56×56 = 球形态窗口，与球盘同尺寸（写 outer shadow 同样被裁成方框）。
  // 这层**本来就没有阴影**（立体感全在 ::after 与 inset 上），列进来是补"名单不全"的
  // 机器门空洞：有人给环加 glow 用 outer shadow，这条立刻红。
  ['.petball.no3d .fluid-ring', '环形进度层：56×56 = 整块窗口，弧的立体感不许用 outer shadow'],
  ['.petball.no3d .fluid-peek', '预览气泡：inset:0 = 整块窗口，阴影全 inset'],
  // ⚠ 曾经把 `.petball-debugring` 也列进来，理由写的是「按投影上报的外接框 = 整个窗口」——
  //   **那条理由是假的**（`PetBall.tsx:812` 写明它只可能是人物形态：ringBox 由 3D 场景的
  //   hitRect 填，球形态 w 恒为 0，所以它在 56×56 窗口里**根本不存在**）。人物形态下它也
  //   只是 213×293 里的一圈虚线，尺寸远小于窗口，不满足本门的成立前提。
  //   留着就是「注释宣称了一个代码不具备的性质」—— 与本任务修的正是同一类错。已移出。
  //   批次 13 曾对它跑过「加 outer shadow → 红」（说明门当时有牙齿）；移出是因为
  //   **前提不成立**，不是因为它不响 —— 记录在此，别为了「多一条门」把它加回来。
]
// 逐个独立判，理由写进标签 —— 一次红集要能指出是哪个选择器出的问题。
// `body != null` 前置与 D2/D5 同一条纪律：选择器改名/删掉时 `outer.length === 0` 会
// **空洞地通过**（块根本没取到 ≠ 规则里真的没有），必须一起红。
for (const [sel, why] of PET_WINDOW_FULLBLEED) {
  const body = ruleBody(css, sel)
  const layers = shadowLayers(decls(body)['box-shadow'] || '')
  const outer = layers.filter((l) => !/^inset\b/.test(l))
  ok(
    body != null && outer.length === 0,
    `D6 no-outer-shadow ${sel} 没有 outer box-shadow（${why}；共 ${layers.length} 层，非 inset ${outer.length} 层：${outer.join(' / ') || '无'}）`
  )
}

// 球盘的**正向**要求（AC5.3）：立体感由 CSS inset 阴影提供，所以层数必须 > 0。
// ⚠ 这条不能推广到整张表：改名输入框的**正确终态就是 0 层**（一个投影都不许有），
//   对它要求「层数 > 0」等于逼着人把阴影写回去。只对「本该有 inset 立体感」的元素提。
const fbLayers = shadowLayers(fb['box-shadow'] || '')
ok(
  fallbackBody != null && fbLayers.length > 0,
  `D6 inset-3d 球盘的立体感由 inset 阴影提供，box-shadow 至少 1 层（实际 ${fbLayers.length} 层）`
)

// ─── E. 语音播报链路的主进程前提（09-29-tts-smart-broadcast）────────────────
//
// 这四条**改坏了不会抛、不会红、界面上看不出任何异常** —— 它们各自只让「某次播报
// 静默地没发生」，而那正是 TTS 这个功能最典型的失败形态。因此必须有守卫把它们钉住。
//
// 2026-09-29 集成复核实测：把这四条逐一破坏（见每条的「破坏即红」），**改动前全套件
// 一个都不红**。「盲审 49 条断言全绿」那次的教训在跨进程这一层重演了一次：
// 渲染层的套件再多，也照不到主进程的一个 webPreferences 字段上。

// 剥掉注释再判：这几条判的是**生效配置**，不是「文件里出现过这个词」。
// overlay.ts 的 webPreferences 上方就有 7 行解释为什么必须关节流，那段注释里
// 「后台节流」「节流」都出现了 —— 裸 grep 门永远是绿的。
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

console.log('\nE. 语音播报链路的主进程前提')

const overlaySrc = stripComments(read('src/main/overlay.ts'))
ok(overlaySrc.length > 0, 'E0 前置：overlay.ts 读得到（下面的负向断言不能空洞通过）')
ok(
  /backgroundThrottling:\s*false/.test(overlaySrc),
  'E1 no-background-throttling 悬浮窗关掉后台节流（否则 1 小时定时器被 Chromium 压成「一小时之后的某个时刻」，且完全静默）'
)

// autoplay 策略：Chromium 在浏览器进程初始化时读这批开关，ready 之后再 append 已经来不及
const indexCode = stripComments(index)
const autoplayAt = indexCode.indexOf("appendSwitch('autoplay-policy'")
const readyAt = indexCode.indexOf('app.whenReady()')
ok(autoplayAt >= 0, 'E2 autoplay-policy 开关存在（无人手势的 audio.play() 否则只是一次 promise rejection，不出声、查不出）')
ok(
  autoplayAt >= 0 && readyAt >= 0 && autoplayAt < readyAt,
  `E2b autoplay-policy 开关在 app.whenReady() **之前**（实测 ${autoplayAt} vs ${readyAt}；晚一步就静默失效）`
)

// 密钥：必须走 keystore 的 items 命名空间（safeStorage 加密），⛔ 不能走 extras（明文）
const ipcSrc = stripComments(read('src/main/ipc.ts'))
/** 取 `ipcMain.handle('<channel>'` 起到该 handler 收尾 `\n  })` 为止的源码 */
function handlerBody(src, channel) {
  const from = src.indexOf(`ipcMain.handle('${channel}'`)
  if (from < 0) return null
  const end = src.indexOf('\n  })', from)
  return end < 0 ? null : src.slice(from, end)
}
const setSecretBody = handlerBody(ipcSrc, 'tts:setSecret')
const hasSecretBody = handlerBody(ipcSrc, 'tts:hasSecret')
ok(setSecretBody != null, 'E3a 取得到 tts:setSecret 的 handler')
ok(
  hasSecretBody != null,
  'E3b 取得到 tts:hasSecret 的 handler（渲染层只问「有没有」；tts:getSecret 已随本次任务下线）'
)
ok(
  setSecretBody != null && /\bsetKey\(/.test(setSecretBody),
  'E3 tts:setSecret 走 setKey（items · safeStorage 加密落盘）'
)
ok(
  setSecretBody != null && !/\bsetExtra\(/.test(setSecretBody),
  'E3b tts:setSecret 不碰 setExtra（extras 是明文 —— 破坏即红：把 setKey 改成 setExtra）'
)
// 这条原先是「tts:getSecret 走 getKey」。取明文的通道本身没了，于是断言的**对象**换成
// 剩下那个读取方 —— 判据（必须走 items，不能混进 extras，混用是静默失败恒为 null）
// 一模一样地保留着，只是主体换了。
ok(
  hasSecretBody != null && /\bgetKey\(/.test(hasSecretBody) && !/\bgetExtra\(/.test(hasSecretBody),
  'E3c tts:hasSecret 走 getKey（与 setKey 同一命名空间；混用两个命名空间是静默失败，恒为 false）'
)
ok(
  handlerBody(ipcSrc, 'tts:getSecret') === null,
  'E3d tts:getSecret handler 已删除（明文不再出主进程，FR6 —— 加回来即红）'
)
ok(
  /function ttsSecretKey\(/.test(ipcSrc) && /\^\[A-Za-z0-9_-\]\{1,64\}\$/.test(ipcSrc),
  'E4 密钥键名拼装前校验 id（冒号会撞上 `tts:secret:` 命名空间前缀）'
)

// preload 必须走**专用**通道，不能顺手复用 getExtras/setExtras（那两个只碰 extras）
// 写侧带返回类型标注（`(id: string, value: string): Promise<void> =>`），所以箭头前用 `[^=]*`
// 而不是 `\([^)]*\)` —— 后者在 `): Promise<void>` 这个 `: Promise` 处就断了。
const preloadSrc = read('src/preload/index.ts')
ok(
  /setTtsSecret:[^=]*=>[\s\S]{0,120}?invoke\('tts:setSecret'/.test(preloadSrc) &&
    /ttsHasSecret:[^=]*=>[\s\S]{0,120}?invoke\('tts:hasSecret'/.test(preloadSrc),
  'E5 preload 暴露专用的 setTtsSecret / ttsHasSecret（不经过 getExtras / setExtras）'
)
// 读取明文的通道必须**关掉**，而不只是「现在没人调」。`setTtsSecret:` 同时作为前置 ——
// preload 被清空时它一起红，负向断言才不会空洞通过。
ok(
  /setTtsSecret:/.test(preloadSrc) && !/getTtsSecret\s*:/.test(preloadSrc),
  'E5b preload 不再暴露 getTtsSecret（FR6 明文读取通道关闭 —— 加回来即红）'
)

// 渲染层：token 明文落盘走不了 extras，**读取通道在本次任务里整个关掉了**
const appSrc2 = read('src/renderer/src/App.tsx')
const appCode = stripComments(appSrc2)
const extrasWrites = appSrc2.match(/setExtras\(\s*\{[^}]*\}/g) || []
ok(extrasWrites.length > 0, 'E6a 前置：App 里确实有 setExtras 调用（下面的负向断言不能空洞通过）')
ok(
  !extrasWrites.some((c) => /ttsSecret|ttsToken|token|secret/i.test(c)),
  'E6 TTS token 不经 setExtras 落盘（破坏即红：把 setTtsSecret 换成 setExtras）'
)

// （09-29-tts-request-to-main 收口）旧版这条判的是「明文只许待在 ref 里」，现在 ref
// 本身也没了：请求搬进主进程后，拼 Authorization 头归 `tts:speak`，渲染层拿明文没有
// 任何用途，只剩一个泄漏面。
// ⚠ 判据要先剥注释：App.tsx 里 `ttsSecretRef` 这几个字仍在，但只在解释「为什么删」的注释中。
ok(
  appCode.length > 0 && /\bsetTtsSecret\(/.test(appCode),
  'E7a 前置：剥注释后 App 仍在（且写 token 的那条路还在）—— 下面的负向断言不能空洞通过'
)
ok(
  !/ttsSecretRef|getTtsSecret|tts:getSecret|Bearer/.test(appCode),
  'E7 渲染层不持有 token 明文（无 ttsSecretRef / 无读取通道 / 不拼 Bearer —— 重新持有即红）'
)
ok(
  /ttsSecretRef/.test(appSrc2) && !/ttsSecretRef/.test(appCode),
  'E7c 但注释里留着「为什么删掉明文通道」—— 删掉理由就等于删掉这条决策'
)
ok(
  /setTtsHasSecret\(!!s\)|setTtsHasSecret\(!!v\)/.test(appSrc2),
  'E7b state 里只有「有没有」这一个布尔，明文不进 state'
)

// D6：ipc.ts:191-193 —— 非 `ui:` 前缀的 extras 写入会触发一次全量重新采集。
// 播报这一族键（ui:tts*）全部是界面偏好，少一个前缀就等于每次切开关发一轮网络请求。
const appExtrasKeys = [...appSrc2.matchAll(/setExtras\(\s*\{\s*'([^']+)'/g)].map((m) => m[1])
const nonUi = appExtrasKeys.filter((k) => !k.startsWith('ui:'))
ok(appExtrasKeys.length > 0, 'E8a 前置：解析出了 App 写的 extras 键（下面的负向断言不能空洞通过）')
ok(
  nonUi.length === 0,
  `E8 extras 键全部 ui: 前缀（非 ui: 的写入会触发全量重新采集，越界键：${nonUi.join(', ') || '无'}）`
)

// ─── F. TTS 请求迁移到主进程（09-29-tts-request-to-main）────────────────────
//
// 渲染层 CSP `connect-src 'self' data: blob: bd-asset:` 是红线（PRD AC3 / FR5），
// 它禁止渲染层外连 —— 所以曾经写在 speechOut.ts 里的 `fetch` **一次都没到过网络**，
// 父任务三轮「实测」全是 curl 打服务端验的（curl 不受 CSP 约束，验不到浏览器行为）。
// 这一段把迁移钉死：CSP 不许改、渲染层不许再有 fetch、请求必须从主进程 tts:speak 出去。
//
// ⚠ 全部先剥注释再判。ipc.ts 的段落注释里就写着 `AbortController`、`connect-src`、
//   `TTS_UNREACHABLE`，裸 grep 会得到一条永远为绿的假护栏（quality-guidelines §D 的
//   三个坑：注释里的词、窗口太短、首次命中落在注释上）。

console.log('\nF. TTS 请求迁移到主进程（09-29-tts-request-to-main）')

// F1 · CSP 逐字锁死（AC3）。判据是**生效声明**的完整值，不是「文件里出现过 connect-src」
const cspHtml = read('src/renderer/index.html')
ok(cspHtml.includes('Content-Security-Policy'), 'F0 前置：index.html 里还有 CSP（没有就谈不上改没改）')
const cspHit = /connect-src([^"]*)/.exec(cspHtml)
ok(
  cspHit != null && cspHit[1].trim() === "'self' data: blob: bd-asset:",
  `F1 connect-src 逐字未改（AC3 红线；实际 ${JSON.stringify(cspHit ? cspHit[1].trim() : '未找到')}）`
)
// F1b · media-src 必须含 blob: 且不外连（09-30-tts-playback-fix）。
// TTS 字节经主进程 IPC 回渲染层后用 <audio> 播放 blob: URL，缺这条会被 CSP 拦死、无声。
// 判据从 CSP content 属性值里取（不是全文 grep）—— 注释里也会出现 media-src 字样，
// 裸 grep 会先命中注释（spec quality-guidelines §D 的「注释里的词」坑，这里造成假红）。
const cspContentAttr = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]*)"/.exec(cspHtml)
const cspValue = cspContentAttr ? cspContentAttr[1] : ''
const mediaHit = /media-src([^;]*)/.exec(cspValue)
ok(
  mediaHit != null && mediaHit[1].includes('blob:') && !/\bhttps?\b|\*/.test(mediaHit[1]),
  `F1b media-src 含 blob: 且不外连（实际 ${JSON.stringify(mediaHit ? mediaHit[1].trim() : '未找到')}）`
)
ok(
  mediaHit != null && mediaHit[1].trim() === "'self' blob:",
  `F1c media-src 字面为 'self' blob:（防止写成 data: 或塞别的源；实际 ${JSON.stringify(mediaHit ? mediaHit[1].trim() : '未找到')}）`
)

// F2 · 渲染层不再出网。正向前置必须先立起来 —— 文件被清空时负向断言会空洞通过
const speechCode = stripComments(read('src/renderer/src/speechOut.ts'))
ok(speechCode.length > 0, 'F2a 前置：speechOut.ts 剥注释后非空（下面的负向断言不能空洞通过）')
ok(
  /window\.api\.ttsSpeak\(/.test(speechCode),
  'F2b 前置：渲染层真的在调 window.api.ttsSpeak（判据有对象，不是「没 fetch 就算赢」）'
)
ok(
  !/fetch\s*\(/.test(speechCode),
  'F2 speechOut 不再调 fetch（改回 fetch 即红 —— CSP 会拦住它，请求到不了网络）'
)

// F3 · 主进程出口的形状。D4/D8/D9b 的主体在本次任务里从渲染层搬到了这里
const speakBody = handlerBody(ipcSrc, 'tts:speak')
ok(speakBody != null, 'F3a 前置：取得到 tts:speak 的 handler（IPC 存在性；下面几条不能空洞通过）')
ok(/method:\s*'POST'/.test(speakBody || ''), 'D4 方法 POST（由主进程定，渲染层不再指定）')
ok(
  /new AbortController\(\)/.test(speakBody || '') && /signal:\s*ctrl\.signal/.test(speakBody || ''),
  'D8 带 AbortSignal（socket 在主进程，渲染层不持有）'
)
ok(
  /setTimeout\(\(\) => ctrl\.abort\(\), TTS_TIMEOUT_MS\)/.test(speakBody || ''),
  'D9b 主进程超时定时器调 ctrl.abort()（12s，与 request.ts 同一数量级）'
)
ok(/markNetResult\(/.test(speakBody || ''), 'F3c 拿到响应就记账（与 adapters 同一离线判定口径）')
ok(
  /'TTS_UNREACHABLE'/.test(speakBody || '') && /TTS_HTTP_\$\{res\.status\}/.test(speakBody || ''),
  'F3d 两种原因码都在（DNS/连接/超时与非 2xx 可区分 —— AC4 的「可辨识原因」）'
)

// F3e · 渲染层传来的 Authorization 必须被丢弃。这是「token 收口」的**唯一机制** ——
// 没有它，收口就只是一句注释：任何渲染层代码都能塞一个自己的头进来，免费用户会被
// 悄悄带上假身份。删掉那个 toLowerCase 判断不会让任何功能失败，所以只能静态钉。
// 判据要同时看「在过滤」和「过滤的是认证头」—— 只查 `toLowerCase` 会放过别的字段过滤。
ok(
  /k\.toLowerCase\(\)\s*!==\s*'authorization'/.test(speakBody || '') ||
    /toLowerCase\(\)\s*!==\s*'authorization'/.test(ipcSrc),
  'F3e 主进程丢弃渲染层传来的 Authorization（大小写不敏感；删掉即红 —— 收口没有别的机制兜着）'
)
ok(
  /if\s*\(\s*token\s*\)\s*headers\[['"]Authorization['"]\]\s*=/.test(speakBody || ''),
  'F3e2 有 token 才由主进程自己拼 Authorization（没有 token 的用户不许被带上认证头）'
)

// F4 · preload 必须把出口暴露出去；F5 · 原因码两侧字面量一致（没有共享常量，只能静态钉）
ok(
  /ttsSpeak:[^=]*=>[\s\S]{0,200}?invoke\('tts:speak'/.test(preloadSrc),
  'F4 preload 暴露 ttsSpeak（渲染层连类型都是从 preload 推导的，没有它就编译不过）'
)
ok(
  speechCode.includes('TTS_UNREACHABLE') && ipcSrc.includes('TTS_UNREACHABLE'),
  'F5 TTS_UNREACHABLE 两侧字面量一致（ipc.ts 抛 / speechOut 认）'
)
ok(
  speechCode.includes('TTS_HTTP_') && ipcSrc.includes('TTS_HTTP_'),
  'F5b TTS_HTTP_ 两侧字面量一致（形状一变，401 不重试就静默失效）'
)

// F6 · 整个渲染层都不许有 token 明文通道（比 E7 的单文件范围大一档）
const rendererFiles = readdirSync(resolve(ROOT, 'src/renderer/src'))
  .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
ok(rendererFiles.length > 0, 'F6a 前置：扫到了渲染层源文件（一个都没扫到时负向断言会空洞通过）')
// ⚠ 判据必须覆盖**通道名**与**头名**两类：
//   · 通道名（ttsSecretRef / getTtsSecret）—— 别人重新开一条读明文的路
//   · 头名（Authorization / Bearer）—— 通道改个名（如 secretRef）照样能拿到明文，
//     此时唯一能认出「渲染层又在自己拼认证头」的信号就是这个头本身。
// 只查通道名的话，`secretRef.current` + `Authorization` 这种换名写法会静默通过 ——
// 而 design 的收口契约是「渲染层根本不该知道怎么拼这个头」，不是「换个变量名就不算」。
const stripped = rendererFiles.map((f) => stripComments(read(`src/renderer/src/${f}`)))
const tokenHits = rendererFiles.filter((f, i) =>
  /ttsSecretRef|getTtsSecret|tts:getSecret/.test(stripped[i])
)
ok(
  tokenHits.length === 0,
  `F6 整个渲染层都没有 token 明文读取通道（FR6；越界文件：${tokenHits.join(', ') || '无'}）`
)
// 前置：渲染层剥注释后确实有内容（文件被清空时负向断言会空洞通过）
ok(stripped.some((c) => c.length > 0), 'F6a2 前置：渲染层剥注释后非空')
const headerHits = rendererFiles.filter((f, i) => /\bAuthorization\b|\bBearer\b/.test(stripped[i]))
ok(
  headerHits.length === 0,
  `F6b 渲染层不自己拼认证头（收口在主进程 tts:speak；越界文件：${headerHits.join(', ') || '无'}）`
)

// ─── G. 跨进程分级的单一出处（10-01-p1-tray-color）──────────────────────────
//
// 85/60 是全 UI 唯一的百分比分级阈值。托盘要上色就得复用它，而主进程够不到
// renderer/format.ts —— 于是判据搬进了 src/shared/levels.ts，format.ts 变成转发口。
//
// 下面两条守的是**搬完之后**的两条边界，都是「改坏了不抛、界面看着也正常」的失败形态：
//   · 阈值被复制回第二处 → 同屏出现两套判断（用量 62% 时卡片橙、托盘绿）
//   · levels.ts 引入 electron / DOM → 纯 node 套件加载不了，测试全红但产品无恙
//     （反过来更糟：为了让纯函数能加载而把 electron 摘掉，模块在主进程里反而不能用了）
console.log('\nG. 跨进程分级的单一出处')

const stripTsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const levelsPath = 'src/shared/levels.ts'
/** 逐字比对两个数组（与 ok 分开：这类断言的失败信息必须带出实际值） */
function eq2(actual, expected, label) {
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
ok(existsSync(resolve(ROOT, levelsPath)), `G0 ${levelsPath} 存在（下面的断言有对象）`)
const levelsBody = stripTsComments(read(levelsPath))
ok(levelsBody.length > 0, 'G0b 剥注释后非空（负向断言不能空洞通过）')
ok(!/\belectron\b|\bdocument\.|window\.|navigator\./.test(levelsBody), 'G1 levels.ts 是纯模块（无 electron / DOM）')
ok(
  !/from '.*\/(main|renderer)\//.test(levelsBody),
  'G1b levels.ts 不 import 主进程 / 渲染层（src/shared/ 是单向的跨进程层）'
)
// water-color.ts 同为跨进程纯模块（渲染层内联消费 + 主进程 uitest 算期望 + node 单测直 load）：
// DOM 胶水（读 .app 令牌）归调用方，不进 shared —— shared 里出现 document/window 即红。
const waterColorBody = stripTsComments(read('src/shared/water-color.ts'))
ok(
  waterColorBody.length > 0 &&
    !/\belectron\b|\bdocument\.|window\.|navigator\.|getComputedStyle/.test(waterColorBody),
  'G1c water-color.ts 是纯模块（无 electron / DOM；阈值锚点同源但阈值本身仍只归 levels.ts）'
)

// 阈值字面量只允许出现在 levels.ts 一处。判据扫全仓的**生效代码**（先剥注释）——
// 注释里写「≥85% 危险」是文档，裸 grep 会把它算成第二处。
const sharedFiles = readdirSync(resolve(ROOT, 'src/shared')).filter((f) => f.endsWith('.ts'))
const rendererTs = readdirSync(resolve(ROOT, 'src/renderer/src')).filter(
  (f) => f.endsWith('.ts') || f.endsWith('.tsx')
)
const mainTs = readdirSync(resolve(ROOT, 'src/main')).filter((f) => f.endsWith('.ts'))
const preloadTs = readdirSync(resolve(ROOT, 'src/preload')).filter((f) => f.endsWith('.ts'))
const scanned = [
  ...sharedFiles.map((f) => `src/shared/${f}`),
  ...rendererTs.map((f) => `src/renderer/src/${f}`),
  ...mainTs.map((f) => `src/main/${f}`),
  ...preloadTs.map((f) => `src/preload/${f}`)
]
ok(scanned.length > 0, `G2a 前置：扫到了源文件（${scanned.length} 个；一个都没扫到时负向断言会空洞通过）`)
const dupThreshold = scanned.filter((f) => {
  const code = stripTsComments(read(f))
  return /pct\s*>=\s*85\b/.test(code) || /pct\s*>=\s*60\b/.test(code)
})
eq2(dupThreshold, [levelsPath], 'G2 85 / 60 阈值只在 shared/levels.ts 一处（卡片与托盘不许同屏打架）')

// 渲染层的消费者必须继续经 format.ts 转发口取等级。format.ts 自己豁免（它就是那道口）。
const rendererConsumers = rendererTs.filter((f) =>
  /\blevelOfPercent\b/.test(read(`src/renderer/src/${f}`))
)
ok(rendererConsumers.length > 0, `G3a 前置：渲染层确实在用 levelOfPercent（${rendererConsumers.length} 个文件）`)
const bypass = rendererConsumers.filter(
  (f) => f !== 'format.ts' && /from '.*shared\/levels'/.test(read(`src/renderer/src/${f}`))
)
eq2(bypass, [], 'G3 渲染层消费者仍经 format.ts 取等级（绕过转发口就会出现两条会分叉的 import 路径）')

// ─── H. 托盘 debug 通道的生产隔离 ─────────────────────────────────────────────
//
// P1-3 加了 `debug:tray-image`（回传图标等级 / 形状 / 实际落盘键）。它是**注入能力**：
// 生产运行时不暴露，否则渲染层就能推夹具改掉菜单栏显示。
// 判据是注册语句必须落在 `--uitest / --shots / --ballshot` 那个 if 之内 ——
// 「channel 名出现在文件里」不等于「它在门里」。
// ⚠ 剥注释后再判：ipc.ts 的注释里就写着 `debug:tray-image` 这行字。
// ⚠ 匹配串**不带右括号**：源码是 `ipcMain.handle('x', () => …)`，引号后跟的是逗号。
//   写成 `handle('x')` 一条都匹配不上 —— 「门内没有」于是恒真、「门内都有」于是恒假，
//   两条同时变成废门（第一版就是这么写的，靠 H1 对照物才发现）。
console.log('\nH. 托盘 debug 通道的生产隔离')

const ipcCode = stripTsComments(read('src/main/ipc.ts'))
const debugTrayChannels = [...ipcCode.matchAll(/ipcMain\.handle\('(debug:tray-[a-z]+)'/g)].map(
  (m) => m[1]
)
ok(debugTrayChannels.length > 0, `H0 前置：ipc.ts 里有托盘 debug 通道（${debugTrayChannels.join(', ')}）`)
// 门 = 最后一个 `process.argv.includes('--uitest')` 起的区间。lastIndexOf 是刻意的：
// 这几个 flag 在本仓别处也出现过（index.ts 的分派），只有最后一个才是注册门。
const gateAt = ipcCode.lastIndexOf("process.argv.includes('--uitest')")
ok(gateAt >= 0, 'H0b 前置：找得到 QA flag 门（找不到时下面两条会空洞通过）')
const insideGate = ipcCode.slice(gateAt)
const outsideGate = ipcCode.slice(0, gateAt)
const isReg = (c) => `ipcMain.handle('${c}'`
// 对照物：门内本来就该找得到这些通道。少了它，上面两条在匹配串写错时照样「全绿」。
eq2(
  debugTrayChannels.filter((c) => insideGate.includes(isReg(c))),
  debugTrayChannels,
  'H1 对照：托盘 debug 通道都在 QA 门内（证明匹配串写对了，不是空洞通过）'
)
eq2(
  debugTrayChannels.filter((c) => outsideGate.includes(isReg(c))),
  [],
  'H2 门之外没有第二处注册（生产运行时不暴露注入能力）'
)
// preload 暴露了通道但主进程没注册 → 渲染层调用 reject。两侧必须一起变。
const preloadCode = stripTsComments(read('src/preload/index.ts'))
const preloadTray = [...preloadCode.matchAll(/invoke\('(debug:tray-[a-z]+)'/g)].map((m) => m[1])
ok(preloadTray.length > 0, `H3a 前置：preload 暴露了托盘 debug 通道（${preloadTray.join(', ')}）`)
eq2(
  preloadTray.filter((c) => !debugTrayChannels.includes(c)),
  [],
  'H3 preload 暴露的托盘 debug 通道都有主进程 handler（否则渲染层 await 会 reject）'
)

// ─── I. 贴边自动隐藏（10-03-dock-autohide）───────────────────────────────────
//
// 几何唯一来源是 shared/dock-hide.ts（主进程状态机与单测共用）；overlay.ts 只做
// 转接（三个调用点：dragStop 尾 / dragStart 头 / 显示器重定位处）。
// 隐藏态命中区覆盖为屏边水柱 —— 渲染层常规上报在隐藏态下不被采信（跨层契约）。
console.log('\nI. 贴边自动隐藏的单一几何来源')

const DOCK_SHARED = 'src/shared/dock-hide.ts'
const DOCK_MAIN = 'src/main/dockHide.ts'
const FLUID_SHARED = 'src/shared/fluid.ts'
ok(existsSync(resolve(ROOT, DOCK_SHARED)), `I0a 前置：${DOCK_SHARED} 存在`)
ok(existsSync(resolve(ROOT, DOCK_MAIN)), `I0b 前置：${DOCK_MAIN} 存在`)
ok(existsSync(resolve(ROOT, FLUID_SHARED)), `I0a2 前置：${FLUID_SHARED} 存在`)
const dockSharedBody = stripTsComments(read(DOCK_SHARED))
const dockMainBody = stripTsComments(read(DOCK_MAIN))
const fluidSharedBody = stripTsComments(read(FLUID_SHARED))
ok(dockSharedBody.length > 0 && dockMainBody.length > 0, 'I0c 前置：两模块剥注释后非空（负向断言不能空洞通过）')
ok(
  !/\belectron\b|\bdocument\.|window\.|navigator\./.test(dockSharedBody),
  'I1 几何模块是纯函数（无 electron / DOM —— 主进程与单测共用同一实现）'
)
ok(
  !/\belectron\b/.test(dockMainBody),
  'I1b 状态机不直接 import electron（窗口/屏幕经 overlay 注入，否则单测加载不了）'
)
// 阈值与柱宽的数值字面量只允许出现在几何模块一处（两处各写一个 8/12 必然漂移）。
// fluid.ts 是几何的共同拥有者（水柱与命中区同源）：它可以**引用**，
// 但不许自立第二个数 —— 下一条 I2c 单独钉住它，扫描时先排除。
const dockScanned = [
  ...sharedFiles.map((f) => `src/shared/${f}`),
  ...mainTs.map((f) => `src/main/${f}`)
].filter((f) => f !== DOCK_SHARED && f !== DOCK_MAIN && f !== FLUID_SHARED)
const dupDock = dockScanned.filter((f) => {
  const code = stripTsComments(read(f))
  return /EDGE_THRESHOLD|COLUMN_W(?![A-Z_])/.test(code)
})
eq2(dupDock, [], 'I2 EDGE_THRESHOLD / COLUMN_W 只在几何模块命名（别处硬编码 8/12 会漂移）')
ok(
  /from '\.\/dock-hide'/.test(fluidSharedBody) &&
    !/(const|let)\s+(EDGE_THRESHOLD|COLUMN_W|HIDE_DWELL_MS|REVEAL_DWELL_MS|REHIDE_MS)\s*=/.test(fluidSharedBody),
  'I2c 流体模块经 shared/dock-hide 取几何常量（引用不断、不自立第二个数）'
)
ok(
  !/\belectron\b|\bdocument\.|window\.|navigator\./.test(fluidSharedBody),
  'I2d 流体模块是纯函数（无 electron / DOM —— 主进程、渲染层与单测共用同一实现）'
)
ok(
  /from '\.\.\/shared\/dock-hide'/.test(dockMainBody) &&
    !/(const|let)\s+(EDGE_THRESHOLD|COLUMN_W|HIDE_DWELL_MS|REVEAL_DWELL_MS|REHIDE_MS)\s*=/.test(dockMainBody),
  'I2b 状态机经 shared/dock-hide 取常量（不自立第二个数）'
)
// overlay 的三个调用点都在（删掉任何一处，隐藏/取消/显示器路径就静默少一条）
const overlayCode = stripTsComments(read('src/main/overlay.ts'))
ok(/dock\.onDragStop\(\)/.test(overlayCode), 'I3a dragStop 尾调 dock.onDragStop（贴边起计时）')
ok(/dock\.onDragStart\(\)/.test(overlayCode), 'I3b dragStart 头调 dock.onDragStart（与拖拽计时器互斥）')
ok(/dock\.onDisplayChange\(\)/.test(overlayCode), 'I3c 显示器重定位处调 dock.onDisplayChange（重算偏移）')
ok(/dock\.resetToVisible\(\)/.test(overlayCode), 'I3d 展开/收起切换调 dock.resetToVisible（不残留隐藏偏移）')
ok(/function tickCursorWatch/.test(overlayCode), 'I3e 前置：找得到 tickCursorWatch（下面的调用形状断言不能空洞通过）')
ok(
  /cursorInsideHit\(cursor,\s*b,\s*peekOverride/.test(overlayCode),
  'I3e 命中决策点以水柱覆盖为准（调用形状，不是"某处出现过"——petHitboxDebug 那个只是 debug 读数，删掉这里必须红）'
)
// ─── J. 流体隐藏的单一口径（10-03-dock-autohide 步 5/6/7）───────────────────
//
// goo 三元素 + 液位 + 相位映射各自只能有一处真相源：
//   · 时序/液位/水渍几何/相位映射归 shared/fluid.ts（I2c/I2d 已守住它的纯度与引用）；
//   · 状态机只许经 setPhase 改相位（改了就推 dock:fluid，不存在"变了没推"的分支）；
//   · 渲染层只消费（切类 + 读 level），不自立第二套数；
//   · CSS 的降级（hidden 暂停波浪 / reduced-motion 跳 morph）必须真实存在，不是注释。
console.log('\nJ. 流体隐藏的单一口径')

// J1 · 相位唯一出口：直接写 `phase = '…'` 的只能是 0 处（setPhase 里的 `phase = p` 不匹配这条）。
// 漏网的直接赋值 = "变了没推 dock:fluid" 的分支，渲染层会停在旧 morph 帧。
const directPhaseAssign = (dockMainBody.match(/^\s*phase = '/gm) || []).length
eq2(directPhaseAssign, 0, 'J1 状态机改相位只走 setPhase（直接赋值 0 处 —— 赋值即推送，无静默分支）')
ok(/function setPhase\(/.test(dockMainBody) && /emitFluid\(\)/.test(dockMainBody) &&
  /phase = p\s*\n\s*emitFluid\(\)/.test(dockMainBody),
  'J1b 前置：setPhase 内赋值即推送（删掉那行调用就红 —— J1 只数直接赋值，看不见"走了 setPhase 但没推"）')

// J2 · 渲染层消费 fluid，不自立第二套数
const petBallSrc = read('src/renderer/src/PetBall.tsx')
const petBallCode = stripTsComments(petBallSrc)
ok(/from '\.\.\/\.\.\/shared\/fluid'/.test(petBallCode), 'J2a 前置：PetBall 真的 import shared/fluid')
ok(/fluidLevel\(/.test(petBallCode), 'J2 液位经 shared/fluid.level（不用内联公式）')
ok(!/(const|let)\s+(ABSORB_|REVEAL_MS|PILL_LEN|POUR_)\s*=/.test(petBallCode),
  'J2b 渲染层不自立时序/水渍常量（时序唯一口径在 shared/fluid.ts）')
ok(/data-fluid=/.test(petBallCode) && /data-edge=/.test(petBallCode),
  'J2c 相位与贴边落在 DOM 属性上（--uitest 不靠猜样式读状态）')

// J3 · CSS 的三条降级必须真实存在（剥注释后判生效声明，不是"注释里写过"）
const skinCss = read('src/renderer/src/skins.css').replace(/\/\*[\s\S]*?\*\//g, '')
ok(/\.petball-goo\s*\{[^}]*filter:\s*url\(#petball-goo\)/.test(skinCss),
  'J3a goo 容器挂滤镜（不挂 elaborate 的 morph 全是散的）')
ok(/\[data-fluid='hidden'\][^{]*\.fluid-wave[^}]*animation-play-state:\s*paused/.test(skinCss),
  'J3b hidden 态暂停波浪（PRD R9 —— 一直转等于在柱上烧电；必须判作用域规则，裸判 paused 会被别处兜底）')
ok(/prefers-reduced-motion/.test(skinCss) && /\.fluid-bridge/.test(skinCss),
  'J3c reduced-motion 下跳 morph（PRD R5 —— 只降级 motion，不降级 dwell 计时）')

// J4 · E2E 覆盖存在（uitest 状态序列 + shots 取帧），不是"写了代码没断言"
const uitestCode = stripTsComments(read('src/main/qa/uitest.ts'))
const shotsCode = stripTsComments(read('src/main/qa/shots.ts'))
ok(/dockFluid/.test(uitestCode), 'J4a 前置：uitest 真的有 dockFluid 断言键')
ok(/__bd_fluid_freeze|dataset\.fluid|data-fluid/.test(uitestCode), 'J4 uitest 读流体相位（状态序列不断就等于没测 morph）')
ok(/__bd_fluid_freeze/.test(shotsCode), 'J4b shots 经 __bd_fluid_freeze 取拉伸/桥接/水渍三帧')
ok(
  /shared\/water-color/.test(uitestCode) && /waterColor\(pct/.test(uitestCode),
  'J4c uitest 水色期望经 shared/water-color 算（与渲染层同源，不手写第二份公式）'
)

// J5 · 推送不抛：dock 通道一律走 safeSend（reload / GPU 崩溃恢复时裸 send 会抛
// `Render frame was disposed`，而调用方一半在定时器回调里 —— 抛出来就是主进程
// 未捕获异常。--shots 实机抓到过一次，见 overlay safeSend 注释）。
ok(!/webContents\.send\('dock:/.test(overlayCode),
  'J5 dock 通道没有裸 webContents.send（定时器回调里抛 = 主进程崩溃，必须走 safeSend）')
ok(/safeSend\('dock:hidden'/.test(overlayCode) && /safeSend\('dock:fluid'/.test(overlayCode),
  'J5b 前置：safeSend 真的在推 dock:hidden 与 dock:fluid（J5 不是空洞通过）')

// debug:dock-* 与托盘 debug 通道同一隔离级别：门内才有，生产不暴露
const dockDebugChannels = [...ipcCode.matchAll(/ipcMain\.handle\('(debug:dock-[a-z-]+)'/g)].map((m) => m[1])
eq2(
  dockDebugChannels.filter((c) => insideGate.includes(isReg(c))),
  dockDebugChannels.length > 0 ? dockDebugChannels : ['__missing__'],
  'H4 对照：贴边隐藏 debug 通道都在 QA 门内（证明匹配串写对了，不是空洞通过）'
)
eq2(
  dockDebugChannels.filter((c) => outsideGate.includes(isReg(c))),
  [],
  'H4b 门之外没有第二处注册（生产运行时不暴露注入能力）'
)

// ─── K. 全屏水满（10-03-holo-sphere 水满 pivot）──────────────────────────────
//
// 外圈进度环退役后，进度唯一载体是球内水体 + 隐藏态水柱。有三件事改坏了不抛、
// 界面上看着也正常：① 环的 CSS/JSX 删了一半（零规则的类名 = 隐形环，2026-09-27
// 踩过）；② 水柱 CSS 与 shared/fluid.waterColumn 各写一套数（看着有柱子但点不中，
// 与命中区脱钩）；③ 新增的水体令牌某皮肤没写（那套皮肤的水退化，截图上只觉得
// 「颜色不对」，而外部皮肤没写时直接没高光）。
console.log('\nK. 全屏水满')

const petBallWater = stripTsComments(read('src/renderer/src/PetBall.tsx'))
ok(petBallWater.length > 0, 'K0 前置：PetBall.tsx 剥注释后非空（下面的负向断言不能空洞通过）')
ok(css.length > 0, 'K0 前置：skins.css 剥注释后非空')

// K1 · 进度环真的退役了（CSS 与 JSX 两半都删，不留零规则的类名）。
//     ⚠ data-ring 探针不在此列：它是 plan/balance 的 kind 探针，不是环（见 PetBall 注释）。
ok(!/dot-ring/.test(css), 'K1a skins.css 里没有 dot-ring（轨道/填充弧规则一并退役）')
ok(
  !/dot-ring-track|dot-ring-fill|className="dot-ring/.test(petBallWater),
  'K1b PetBall.tsx 里没有 dot-ring 的 SVG/类名（data-ring kind 探针不算环）'
)

// K2 · 三层波 + 液面高光线都在 DOM 上（缺一层就是「少画一层」的静默降级）。
ok(
  /fluid-wave-a/.test(petBallWater) && /fluid-wave-c/.test(petBallWater) && /fluid-surface/.test(petBallWater),
  'K2a 三层波（a/b/c）+ 液面高光线都在 JSX 里'
)
ok(/waveLine\(/.test(petBallWater), 'K2b 高光线经 waveLine 构造（与 A 层同参数，不是手写第二份路径）')
ok(
  /fluid-drift-c/.test(css) && /column-drift/.test(css),
  'K2c 第三层位移 + 水柱波浪位移的关键帧都在（只挂类名不写关键帧 = 静止的假波浪）'
)
// K2d · 位移距离必须是各自波长的整数倍（R1 后走变量：keyframes 只写 var，
//     具体像素由 --wave-len-* 给 —— :root 默认 28/36/18 见 K9a，逐皮肤同步见 test-fluid 用例 9）。
//     A=1×len-a / B=1×len-b（反向）/ C=2×len-c；柱顶小波浪周期 4px 走 -4（固定形状，不变量化）。
//     ⚠ 按块切片再取数：跨 `@keyframes` 边界贪过去会读到下一块的数，删掉整块照样绿。
const kfBlock = (name) => {
  const start = css.indexOf(`@keyframes ${name}`)
  if (start < 0) return null
  const cuts = [css.indexOf('@keyframes', start + 1), css.indexOf('@media', start + 1)].filter((i) => i > 0)
  return css.slice(start, cuts.length ? Math.min(...cuts) : undefined)
}
for (const [name, expr] of [
  ['fluid-drift-a', 'calc(var(--wave-len-a) * -1)'],
  ['fluid-drift-b', 'calc(var(--wave-len-b) * -1)'],
  ['fluid-drift-c', 'calc(var(--wave-len-c) * -2)'],
  ['column-drift', 'translateX(-4px)']
]) {
  const block = kfBlock(name)
  ok(block != null && block.includes(expr), `K2d ${name} 位移经 ${expr}（波长整数倍，不断裂）`)
}

// K3 · 水体令牌：顶层 :root + 5 个内置皮肤逐个有定义（与 D3 的 --ball-bg 同纪律：
//     缺顶层 :root，外部皮肤在浅色系统上直接没高光/没深度罩）。
for (const prop of ['--water-foam', '--water-deep']) {
  const scopes = declScopes(prop)
  const missing = ['root', ...SKINS].filter((s) => !scopes.has(s))
  ok(
    missing.length === 0,
    `K3 ${prop} 在顶层 :root + 5 个皮肤都有（缺 ${missing.join(',') || '无'}；实得 ${[...scopes].sort().join(',')}）`
  )
}
// 水色仍跟 lvl（不是令牌写死某一级的颜色）：.fluid-wave 吃 --ok，各 lvl 覆写还在。
const waveBody = decls(ruleBody(css, '.petball.no3d .fluid-wave'))
ok(
  waveBody != null && /var\(\s*--ok\s*\)/.test(waveBody.fill || ''),
  `K3b 水体主层 fill 是 var(--ok)（实际 ${JSON.stringify(waveBody?.fill || '未找到')}）`
)
ok(
  ruleBody(css, '.petball.no3d.lvl-warn .fluid-wave') != null &&
    ruleBody(css, '.petball.no3d.lvl-danger .fluid-wave') != null &&
    ruleBody(css, '.petball.no3d.lvl-muted .fluid-wave') != null,
  'K3c lvl-warn/danger/muted 的水色覆写都在（删掉一级，那一级的水就恒绿）'
)
// K3d · 连续水色（10-04-water-color-by-usage）：三层波 fill 与柱内液 background
// 走内联 water（waterColor(pct) 插值），K3b/K3c 的 CSS 留作兜底 —— 内联被删时
// 水退回三档而不是透明/无色（删内联不断裂的证明见 K3b/K3c 仍绿）。
ok(
  /from '\.\.\/\.\.\/shared\/water-color'/.test(petBallWater) && /waterColor\(pct/.test(petBallWater),
  'K3d PetBall 经 shared/water-color 的 waterColor(pct) 算水色（不手写第二份插值）'
)
ok(
  /className="fluid-wave fluid-wave-a"[^>]*style=\{\{\s*fill:\s*water/.test(petBallWater) &&
    /className="fluid-column-fill"[^]*background:\s*water/.test(petBallWater),
  'K3d 三层波 fill + 柱内液 background 都绑内联 water（少绑一处，那处的水就恒三档）'
)

// K7 · 倒水入场（R4-1 雨滴）：data-pour 三段 + 取帧 + 降级，缺一件都算半态
ok(/data-pour=/.test(petBallCode), 'K7a 重播信号落在 data-pour 属性上（--shots 不靠猜样式读状态）')
ok(
  /POUR_TOTAL_MS/.test(petBallCode) && /className="slosh"/.test(petBallWater),
  'K7b 摘属性计时经 shared POUR_TOTAL_MS + 荡漾有独立 .slosh 位移层（不复用波浪 svg 本体）'
)
ok(
  /pour-drop/.test(css) && /pour-trickle/.test(css) && /pour-splash/.test(css) && /pour-top/.test(css) && /pour-slosh/.test(css) && /pour-flash/.test(css),
  'K7c 雨滴/壁流/触水/冲顶/荡漾/闪峰六段 keyframes 都在（少一段，入场就缺一拍）'
)
ok(
  !/@keyframes pour-fill\s*\{/.test(css) && !/@keyframes pour-stream\s*\{/.test(css),
  'K7c2 整坨 pour-fill 与单条 pour-stream 已删（同一目标多套雨是漂移源，R4-1 只留雨滴）'
)
ok(
  /\[data-pour='in'\][^{]*\.pour-drop[^}]*pour-drop/.test(css) &&
    /\[data-pour='in'\][^{]*\.pour-trickle[^}]*pour-trickle/.test(css) &&
    /\[data-pour='in'\][^{]*\.pour-splash[^}]*pour-splash/.test(css) &&
    /\[data-pour='in'\][^{]*\.slosh[^}]*pour-slosh/.test(css),
  'K7d 四段动画挂在 data-pour 上（属性摘掉即无入场；落距/落点按 surfaceY 内联，不读死位置）'
)
ok(
  /\.slosh\s*\{[^}]*position:\s*absolute/.test(css) &&
    /\.pour-clip\s*\{[^}]*clip-path:\s*circle\(27px/.test(css),
  'K7e 位移层抽离布局 + 雨裁进水盘圆（r=27 与 svg clip 同口径，不画出界）'
)
ok(
  /className={`pour-drop/.test(petBallWater) &&
    /POUR_DROPS\.map/.test(petBallWater) &&
    /className="pour-splash"/.test(petBallWater) &&
    /className="pour-trickle/.test(petBallWater) &&
    /pourSurfaceY - 6/.test(petBallWater) &&
    /waterAnchors\.accent/.test(petBallWater),
  'K7e2 雨滴按表渲染 + 触水落点跟液面（pourSurfaceY 内联：套餐真实液面、余额钳 24 没入水中）+ 壁 trickle 两条 + 余额水走 accent'
)
ok(
  /POUR_DROPS/.test(petBallCode) && /from '\.\/skin-waves'/.test(petBallCode),
  'K7e3 雨滴表经 ./skin-waves 的 POUR_DROPS（不手写第二份落位）'
)
ok(
  /pour-mid/.test(petBallCode) &&
    /\[data-freeze='pour-mid'\][^{]*\.pour-drop/.test(css) &&
    /\[data-freeze='pour-top'\]/.test(css),
  'K7f 取帧钩子认 pour-mid/pour-top + CSS 有对应定帧（--shots 5l/5m 不拍空；mid 定在雨滴半空）'
)
ok(
  /prefers-reduced-motion/.test(petBallCode),
  'K7g reduced-motion 下不挂 data-pour（JS 门控，直接终态）'
)
{
  // K7h · 雨在 goo 容器之外（R4-1 取证：容器 goo 滤镜把 3px 雨滴糊成无色条，
  // DOM 全对但像素无色）。断法：goo 开标签与 pour-clip 开标签之间的 <div / </div
  // 必须配平（配平 = pour-clip 在 goo 闭标签之后，不嵌套；顺序同时保证雨画在水上）。
  const src = petBallWater
  const gooOpen = src.indexOf('className="petball-goo"')
  const clipOpen = src.indexOf('className="pour-clip"')
  const seg = gooOpen >= 0 && clipOpen > gooOpen ? src.slice(gooOpen, clipOpen) : ''
  // 自闭合 <div … /> 不算 open（fluid-disc / fluid-bridge 就是自闭合，不减会误报嵌套）
  const opens = (seg.match(/<div[\s>]/g) || []).length - (seg.match(/<div[^>]*\/>/g) || []).length
  const closes = (seg.match(/<\/div>/g) || []).length
  ok(
    seg !== '' && opens === closes,
    `K7h pour-clip 不在 goo 容器内（div 配平 ${opens}/${closes}；嵌套会被 goo blur 吃掉）`
  )
}

// K8 · 贴边吸溜水柱温度计（10-04-edge-sip-column）：吸走 + 灌满 + 活柱，缺一件都算半态
ok(
  /\[data-fluid='absorbing'\][^{]*\.fluid-waves[^}]*waves-drain/.test(css),
  'K8a 吸入时球内水下沉流向贴边（drain 是 waves 唯一的位移动画，无冲突）'
)
ok(
  /bridge-absorb-h/.test(css) &&
    /bridge-absorb-v/.test(css) &&
    !/@keyframes bridge-absorb\s*\{/.test(css),
  'K8b 液桥按边拉宽成流道（横/纵两套，旧单套 bridge-absorb 已删，不留第二套 morph）'
)
ok(
  /\[data-fluid='absorbing'\][^{]*\.fluid-column-fill[^}]*column-rise/.test(css),
  'K8c 吸入时柱从空灌到满（位移演灌满，高度恒 = fluidLvl，见 K8f）'
)
// K8d · hidden 保持柱顶波动荡：hidden 暂停名单里必须没有 column（有 = 柱子冻住，违背"里面也是水在动荡"）。
// 负向断言的非空洞由 J3b/K5a 兜底（hidden 规则被整个删掉时它们先红）。
{
  const hi = css.indexOf("[data-fluid='hidden']")
  const seg = css.slice(hi, hi + 600).split('paused')[0]
  ok(hi >= 0 && !/fluid-column-wave/.test(seg), 'K8d hidden 只停球内波，柱顶波不在暂停名单里')
}
ok(
  /\.doc-hidden[^{]*\.fluid-column-wave[^}]*paused/.test(css),
  'K8d2 页面不可见时柱顶波仍暂停（省电：没人看的动画不烧，hidden 的"活着"只给看得见的屏）'
)
ok(
  /className="fluid-ticks"/.test(petBallWater) &&
    /column-fill:not\(:empty\)/.test(css) &&
    /fluid-pill::after/.test(css),
  'K8e 温度计三件套：管壁刻度 JSX + 液头弯月（空槽不画假液头）+ 管壁侧光 CSS'
)
// K8m · P4 悬停 peek（原型 D 区口径）：柱上停留冒完整波浪预览气泡，不唤出。
//   · 只在 hidden 下挂（球态 hover 不冒第二颗球）；
//   · pointer-events:none（预览不拦截点击，单击仍是唤出，不误触）；
//   · 显现延迟 250ms < REVEAL_DWELL_MS(300)（与唤出计时同源，预览先到，唤出仍靠点击）。
ok(
  /className="fluid-peek"/.test(petBallWater) &&
    /className="fluid-peek-value"/.test(petBallWater) &&
    /className="fluid-peek-drop/.test(petBallWater),
  'K8m1 peek 气泡 JSX 在（波浪 + 落雨 + 读数，不另起取数，都复用本次渲染的 waveA/water/shownText）'
)
{
  // K8m1b · peek 与柱顶波/shimmer 同条件（fluidLvl > 0）：空槽 hover 不冒球，不造假水位。
  // 断法与 K8k1b 同一配平模式（K7h 那套）：peek 的类名必须落在条件块内 ——
  // 条件被删（最近的条件在 peek 之前根本不存在）或 peek 被搬出块（配平块不含 marker），都红。
  const peekBlock = condBlock(petBallWater, 'className="fluid-peek"', 'fluidLvl > 0')
  ok(
    peekBlock != null && peekBlock.includes('className="fluid-peek"'),
    'K8m1b peek 气泡包在 fluidLvl > 0 条件块内（无水挂预览即红；删条件即红）'
  )
  // K8m1c · peek 不另起取数：波形/水色/读数复用本次渲染的 waveA/water/shownText。
  ok(
    peekBlock != null &&
      peekBlock.includes('d={waveA}') &&
      peekBlock.includes('fill: water') &&
      peekBlock.includes('{shownText}'),
    'K8m1c peek 复用 waveA/water/shownText（d={waveA}、fill: water、{shownText}；另起取数即红）'
  )
}
ok(
  /:has\(\.petball-hit:hover\)[^{]*\.fluid-peek/.test(css) &&
    /\[data-fluid='hidden'\][^{]*\.fluid-peek/.test(css) &&
    /\.fluid-peek[^}]*pointer-events:\s*none/.test(css),
  'K8m2 peek 经 hit-hover + hidden 双门显现（球态不冒；预览不吃指针）'
)
ok(
  /\.fluid-peek[^}]*transition-delay:\s*250ms/.test(css) &&
    /data-freeze='peek'/.test(css) &&
    /'peek'/.test(petBallCode),
  'K8m3 peek 显现延迟 250ms（< REVEAL_DWELL_MS）+ 取帧 peek 态（--shots 像素对拍）+ freeze 钩子认 peek'
)
// K8m4 · 预览先到、唤出靠点击：peek 显现延迟必须 < REVEAL_DWELL_MS。
// 跨模块算术门（CSS transition-delay vs shared/dock-hide.ts，与
// test-alert-orchestration.mjs L33 同模式 —— 两处各写一个数必然漂移，
// 单测把不等式钉住；改任一侧的数都要过这一关）。
{
  const dwellSrc = stripTsComments(read('src/shared/dock-hide.ts'))
  const dwellMs = Number(/REVEAL_DWELL_MS\s*=\s*(\d+)/.exec(dwellSrc)?.[1])
  const peekCss = decls(ruleBody(css, '.petball.no3d .fluid-peek'))
  const delayMs = Number(/(\d+)\s*ms/.exec(peekCss['transition-delay'] || '')?.[1])
  ok(
    Number.isFinite(dwellMs) && dwellMs > 0,
    `K8m4a 前置：读得到 REVEAL_DWELL_MS（实际 ${String(dwellMs)}）`
  )
  ok(
    peekCss['transition-delay'] != null && Number.isFinite(delayMs),
    `K8m4b 前置：读得到 peek transition-delay（实际 ${peekCss['transition-delay'] || '未找到'}）`
  )
  ok(
    Number.isFinite(dwellMs) && Number.isFinite(delayMs) && delayMs < dwellMs,
    `K8m4 peek 显现延迟 ${String(delayMs)}ms < REVEAL_DWELL_MS ${String(dwellMs)}ms（预览先到，唤出仍只靠点击）`
  )
}
// K8d3 · P3 皮肤落地：hidden 下深色后浪（foam）也暂停 —— 球内四层（A/B/C/后浪）
// 照停，柱顶波 + 液光流保持动画（K8d 只许柱顶活，球内全停）。
ok(
  /\[data-fluid='hidden'\][^{]*\.fluid-foam[^}]*animation-play-state:\s*paused/.test(css),
  'K8d3 hidden 态暂停深色后浪（球内四层照停；柱顶波不在名单里，见 K8d）'
)
// K8j · P3 柱顶浪按天气走：柱顶小波的时长读 --wave-speed-a（逐皮肤各异，
// 写死 1.6s 等于五皮同浪；位移仍是固定 -4px，见 K2d）。
ok(
  /\.fluid-column-wave svg[^}]*var\(--wave-speed-a\)/.test(css),
  'K8j 柱顶小波时长走 --wave-speed-a（振幅/速度逐皮肤不同）'
)
// K8k · P3 液内高光漂移（原型 cshim 口径）：柱内液光流 JSX + CSS + 上下漂移关键帧
// 都在；hidden 下保持动画（柱顶活的第二半），页面不可见/降级时停。
ok(
  /className="fluid-shimmer"/.test(petBallWater),
  'K8k1 液光流在 JSX 里（与柱顶波同条件挂载，空槽不造假光）'
)
// K8k1b · 液光流与柱顶波**同条件**挂载（fluidLvl > 0）：只断存在不断条件，
// 把光搬出条件（空槽挂假光）照样绿 —— 标签与机制对不上的永真兜底（见 K7h 配平模式）。
// 断法：从 marker 往回找最近的 `{fluidLvl > 0`，配平花括号取整块，波与光必须在同一块内。
function condBlock(src, marker, cond) {
  const mi = src.indexOf(marker)
  if (mi < 0) return null
  const open = src.lastIndexOf(`{${cond}`, mi)
  if (open < 0) return null
  let depth = 0
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') {
      depth--
      if (depth === 0) return src.slice(open, j + 1)
    }
  }
  return null
}
{
  const waveBlock = condBlock(petBallWater, 'className="fluid-column-wave"', 'fluidLvl > 0')
  ok(
    waveBlock != null && waveBlock.includes('className="fluid-shimmer"'),
    'K8k1b 液光流与柱顶波在同一 fluidLvl > 0 条件块内（光搬出条件即红；删条件即红）'
  )
}
ok(
  /\.fluid-shimmer[^}]*var\(--slosh-dur\)/.test(css) && /@keyframes column-shimmer/.test(css),
  'K8k2 液光流 CSS 走 --slosh-dur（逐皮肤天气速度）+ column-shimmer 关键帧在'
)
ok(
  /\(fluidLvl \* 100\)\.toFixed\(1\)/.test(petBallCode),
  'K8f 柱内液高 = fluidLvl 逐值绑定（隐藏态水柱液高与球内液位同一出处，逐值对拍的结构侧）'
)
ok(
  /\[data-fluid='hidden'\][^{]*\.fluid-waves[^}]*opacity:\s*0/.test(css),
  'K8g 隐藏稳态球内水不可见（屏上只剩温度计柱，水位诚实）'
)
ok(
  /\[data-fluid='hidden'\][^{]*\.petball-goo[^}]*filter:\s*none/.test(css),
  'K8h 隐藏稳态关 goo 滤镜（无可融合形状；离屏 SVG 滤镜子树画不出，5n 取证）'
)
ok(
  /\[data-fluid='hidden'\][^{]*\{[^}]*background:\s*transparent/.test(css) &&
    /\[data-fluid='hidden'\][^{]*\.dot-value[^}]*opacity:\s*0/.test(css) &&
    /\.dot-provider[^}]*opacity:\s*0\s*!important/.test(css) &&
    /\.petball-fallback\[data-fluid='hidden'\]::after[^}]*opacity:\s*0/.test(css),
  'K10c 隐藏稳态藏底盘与读数（原地变柱只留水柱；旧滑出靠离屏遮丑，新口径必须显式藏；mark 内联 opacity 须 !important 盖；玻璃罩 ::after 同门 opacity 0，否则顶光残影=球幽灵）'
)
ok(
  /disc-absorb-h/.test(css) &&
    /disc-absorb-v/.test(css) &&
    !/@keyframes disc-absorb\s*\{/.test(css),
  'K8i 球盘按边拉丝吸入（横/纵两套，R3 整球变形；旧刚性缩小单套已删）'
)

// K9 · 皮肤水效性格（10-04-skin-fluid-redesign）：变量全覆盖 + 球面各异 + 高光同步
// 速度/透明度 6 变量：:root 默认 + 5 皮肤逐个覆盖（minimal 也有自己的值 —— 静与淡本身即性格）。
// declScopes 与 K3 同口径（顶层 :root + 5 皮肤，缺一个，那个皮肤的水就与其他皮肤同速）。
for (const prop of [
  '--wave-speed-a',
  '--wave-speed-b',
  '--wave-speed-c',
  '--wave-opacity-a',
  '--wave-opacity-b',
  '--wave-opacity-c',
  '--wave-len-a',
  '--wave-len-b',
  '--wave-len-c'
]) {
  const scopes = declScopes(prop)
  const missing = ['root', ...SKINS].filter((s) => !scopes.has(s))
  ok(
    missing.length === 0,
    `K9a ${prop} 在顶层 :root + 5 个皮肤都有（缺 ${missing.join(',') || '无'}）`
  )
}
ok(
  /\[data-skin='ink'\][^{]*\.fluid-wave-c[^}]*display:\s*none/.test(css),
  'K9b ink 只开两层水（留白；C 层 display:none，不是 opacity 0 —— 占位层仍耗合成）'
)
for (const skin of SKINS) {
  ok(
    new RegExp(`\\[data-skin='${skin}'\\][^{]*\\.fluid-disc[^}]*background:`).test(css),
    `K9c ${skin} 球面 background 整组覆盖（质感各异，不共用默认盘）`
  )
}
ok(
  /\.fluid-surface[^}]*var\(--wave-speed-a\)/.test(css) &&
    /\.fluid-foam[^}]*var\(--wave-speed-a\)/.test(css),
  'K9d 高光线与泡沫带都与 A 层读同一速度变量（写死数字会慢慢错开，高光/泡沫脱离波峰）'
)
ok(
  !/fluid-drift|wave-speed|wave-opacity/.test(petBallCode),
  'K9e 波动数学不出 JS（时长/透明度/漂移距离全在 CSS；JS 只给液面高度 + 按皮肤选波形）'
)
ok(
  /from '\.\/skin-waves'/.test(petBallWater) && /skinWaves\(skinId\)/.test(petBallWater),
  'K9f 波形逐皮肤取表（R1；ext 回退默认，不断裂）'
)
ok(
  /waveBand\(surfaceY/.test(petBallWater) && /className="fluid-foam"/.test(petBallWater),
  'K9g 泡沫带经 waveBand 与 A 同参数构造（不是手写第二份路径；冒头盖进泡沫里）'
)
// K9h · 天气变量全覆盖（R4-4）：:root 默认 + 5 皮肤逐个覆盖（与 K9a 同口径）。
for (const prop of ['--drop-w', '--drop-speed', '--splash-s', '--slosh-amp', '--slosh-dur']) {
  const scopes = declScopes(prop)
  const missing = ['root', ...SKINS].filter((s) => !scopes.has(s))
  ok(
    missing.length === 0,
    `K9h ${prop} 在顶层 :root + 5 个皮肤都有（缺 ${missing.join(',') || '无'}）`
  )
}
ok(
  /pour-slosh[^}]*var\(--slosh-amp\)/.test(css) && /pour-slosh[^}]*var\(--slosh-dur\)/.test(css),
  'K9i 荡漾幅度与时长走变量（每皮不同性格；写死数字等于五皮同浪）'
)
// K9j · 每皮雨滴数不同（R4-4）：minimal 3 / ink 4 / aero 5 / dark 6 / candy 7 全开。
// nth-child 藏尾，顺序即重要度（POUR_DROPS 表注释）；splash 与雨滴同进退。
for (const [skin, keep] of [['minimal', 3], ['ink', 4], ['aero', 5], ['dark', 6]]) {
  ok(
    new RegExp(`\\[data-skin='${skin}'\\][^{]*\\.pour-drop:nth-child\\(n\\+${keep + 1}\\)`).test(css),
    `K9j ${skin} 留前 ${keep} 滴（nth-child 藏尾）`
  )
}

// K10 · 稳态无溢出（R4-2）：::after 深度罩与 goo 输出都裁进 r=27 水盘圆。
// 底缘 1px 环就是"波浪超出球体"的真凶（5-ball 像素取证）；morph 态不裁（桥要出圆）。
ok(
  /\.fluid-waves::after[^}]*inset:\s*1px/.test(css),
  'K10a 深度罩 inset:1px（r=27，与 svg clip 圆同口径，不多出 1px 环）'
)
ok(
  /\[data-fluid='edge-visible'\]:not\(\[data-freeze\]\)[^{]*\.petball-goo[^}]*clip-path:\s*circle\(27px/.test(css),
  'K10b 稳态 goo 裁进圆（morph/freeze 不裁：桥要出圆、取帧要看全貌）'
)

// ─── K11 · 球体外观四皮互不相同（P6：环**替代**水体，不共存）────────────────
//
// 用户 2026-10-05 拍板：进度环替代球内水体（不共存，避免同一数字双重编码）。
// 四皮分配（原型 skin-applied.html 的 V1/V3/V5/V6 四段，112 坐标折半到 56）：
//   aero    = V6 潮汐水位蓝 → 水体（唯一编码，本轮只复核）
//   dark    = V1 余烬橙环   → 24 粒刻度圈 + 粗进度弧
//   candy   = V3 极速双环   → 外环进度 + 内装饰细环
//   minimal = V5 柠檬分段环 → 3 段粗弧带缺口，缺口兼刻度
//   ink     = 保留现状（水体；与 aero 同形态但不同波性格，一眼可辨靠水效）
//
// 为什么这几条必须存在（不是"为覆盖率写门"）：
//   · 形态靠 --water-display / --ring-display 两个**令牌**表达，不靠 JS 分支。
//     删掉任一个 → 该皮退回 :root 缺省（= 水体），于是"三皮环形态"塌成两皮，
//     而**界面上完全看不出报错**（只是长得像 aero 了）。逐皮断言是唯一能红的网。
//   · 弧长必须绑 fluidLvl（唯一数据口径）。写成 CSS 里的固定 dasharray = 进度与
//     图形脱钩 —— 环永远满圈或永远空圈，而柱内液高仍在动，两个数字互相矛盾。
//   · 环必须随 disc 收尽（hidden 稳态只剩柱）。漏了就是"球收走了、环留在屏边"，
//     与 R4-5 原地变柱的整个前提相反（5g 取帧能拍到）。
for (const [skin, form] of [
  ['aero', 'water'],
  ['dark', 'ring'],
  ['candy', 'ring'],
  ['minimal', 'ring'],
  ['ink', 'water']
]) {
  const scopes = declScopes('--water-display')
  ok(
    scopes.has(skin),
    `K11a ${skin} 显式声明 --water-display（形态靠令牌：缺声明 → 静默退回 :root 水体）`
  )
  const ringScopes = declScopes('--ring-display')
  ok(
    ringScopes.has(skin),
    `K11a ${skin} 显式声明 --ring-display（同上；两个令牌必须成对，逐皮各判一次）`
  )
  // 取值方向：形态是"二选一"，两个令牌必须互补 —— 两个都 block（水+环共存 =
  // 同一数字画两遍）或两个都 none（什么都没有）都是错的。
  const wantWater = form === 'water'
  const readToken = (prop, s) => {
    // 只认裸皮肤块 `[data-skin='x'] { … }`（与 test-fluid 用例 9 同口径）
    const m = css.match(new RegExp(`\\[data-skin='${s}'\\] \\{[^}]*?${prop}:\\s*([a-z]+)`))
    return m ? m[1] : null
  }
  const w = readToken('--water-display', skin)
  const r = readToken('--ring-display', skin)
  ok(
    w === (wantWater ? 'block' : 'none') && r === (wantWater ? 'none' : 'block'),
    `K11b ${skin} 形态 = ${form}（--water-display=${w} / --ring-display=${r}；必须互补，不共存）`
  )
}
// 环几何令牌：:root 兜底 + 三个环形态皮逐个覆盖（半径/线宽/端点/特色层）。
// 缺 :root 那套 → 外部皮肤写 --ring-display: block 时拿到 var(--ring-r) 空值，
// 环的 r 无效 = 半径 0 = 环整个消失（Chromium 里 r: var(--环) 解析失败即不画）。
for (const prop of ['--ring-r', '--ring-sw', '--ring-cap', '--ring-track']) {
  const scopes = declScopes(prop)
  const missing = ['root', ...SKINS].filter((s) => !scopes.has(s))
  ok(
    missing.length === 0,
    `K11c ${prop} 在顶层 :root + 5 个皮肤都有（缺 ${missing.join(',') || '无'}）`
  )
}
for (const [skin, prop] of [
  ['dark', '--ring-ticks-dash'],
  ['minimal', '--ring-seg-dash'],
  ['candy', '--ring-inner-c']
]) {
  ok(
    declScopes(prop).has(skin),
    `K11d ${skin} 定义 ${prop}（V1 刻度 / V5 分段 / V3 内环各皮特色，缺它 = 三皮长得一样）`
  )
}
// K11c2 · 形态子令牌**成对存在**（2026-10-06 check P6 minor-3）
//
// K11c 只覆盖 4 个通用几何令牌（--ring-r/sw/cap/track），而每个**特色形态**还有
// 一组配套子令牌：刻度圈（display/dash/c/sw/r）、分段环（display/dash）、
// 内装饰环（display/c/sw/r）。这组此前无任何存在性门：
// 摘掉 dark 的 --ring-ticks-r 或 candy 的 --ring-inner-sw，红 0。
//
// 断法不是「逐个令牌查存在」——那会漏判「整套形态只声明了一半」（比如刻度圈
// display:block 了却没给 dash，那一圈就是**实心整圈**，不是刻度）。
// 而是按**形态成组**判：某一层在某个皮下 display:block，那么它该层的**每一个**
// 子令牌都必须在这个皮下有声明（几何值走 :root 兜底不算 —— 那正是穿帮的来源：
// 半径 22 兜底给到 r=25 的刻度圈上，圈就跑到环外去了）。
for (const [feature, props] of [
  ['ticks', ['--ring-ticks-display', '--ring-ticks-dash', '--ring-ticks-c', '--ring-ticks-sw', '--ring-ticks-r']],
  ['seg', ['--ring-seg-display', '--ring-seg-dash', '--ring-seg-c']],
  ['inner', ['--ring-inner-display', '--ring-inner-c', '--ring-inner-sw', '--ring-inner-r']]
]) {
  const displayProp = `--ring-${feature}-display`
  // 哪些皮开了这层？（display:block）
  const owners = SKINS.filter((s) => (tokenInScope(displayProp, s) || '') === 'block')
  ok(
    owners.length > 0,
    `K11c2 ${feature} 层至少有一皮开启（实得 ${owners.join(',') || '无'}；全关 = 这个形态根本没实现）`
  )
  for (const s of SKINS) {
    // 开了这层的皮：该层子令牌必须**逐个**在本皮声明
    if ((tokenInScope(displayProp, s) || '') !== 'block') continue
    const missing = props.filter((p) => !declScopes(p).has(s))
    ok(
      missing.length === 0,
      `K11c2 ${s} 开了 --ring-${feature}-display，其 ${props.length} 个子令牌在本皮齐全（缺 ${missing.join(', ') || '无'}）`
    )
  }
  // :root 必须给全套兜底（外部皮肤 ext:* 只吃得到顶层那份）
  const rootMissing = props.filter((p) => !declScopes(p).has('root'))
  ok(
    rootMissing.length === 0,
    `K11c2 ${feature} 层全套子令牌在顶层 :root 有兜底（缺 ${rootMissing.join(', ') || '无'}）`
  )
}
// 弧长绑 fluidLevel（唯一数据口径）：JSX 里 strokeDasharray 必须来自 ringDash(fluidLvl)。
// 内联 dasharray 而不是 CSS 固定值 —— CSS 那条路做不到"每帧随读数变"。
// 弧长必须来自 fluidLvl。ringSvg 是个纯函数（参数 lvl），所以这条门断的是
// **两处调用点都传 fluidLvl** —— 传别的数（比如 pct 原值、surfaceY）就红。
// 内联 dasharray 而不是 CSS 固定值：CSS 那条路做不到"每帧随读数变"。
{
  // 只取**调用点**：`{ringSvg(` —— 函数签名 `ringSvg(lvl: number, …)` 不带花括号前缀
  const calls = (petBallWater.match(/\{ringSvg\(\s*([A-Za-z0-9_.]+)/g) || []).map((s) => s.match(/\(\s*([A-Za-z0-9_.]+)/)[1])
  const wired = /strokeDasharray=\{ringDash\(lvl\)\}/.test(petBallWater)
  ok(
    calls.length >= 2 && calls.every((a) => a === 'fluidLvl') && wired,
    `K11e 弧长 = ringDash(fluidLvl) 且两处调用点都传 fluidLvl（实得 ${calls.join(' / ') || '无'}；本体的环与 peek 预览的环同源）`
  )
}
ok(
  /ringDash/.test(petBallCode) && /from '\.\/skin-rings'/.test(petBallCode),
  "K11e 前置：PetBall 真的经 skin-rings 的 ringDash 取弧长（不是自己拼字符串）"
)
// 归一化空间：没有 pathLength，dasharray 的单位是像素，那么 --ring-r 一改半径
// 弧长比例就错（22px 与 24px 半径下同一个 "41" 画出不同的百分比）。ringSvg 里
// 四个 circle 走 RING_DASH_SPACE(=100)，刻度圈走 96（24 粒 × 4）。
{
  const start = petBallWater.indexOf('function ringSvg')
  const seg = start >= 0 ? petBallWater.slice(start, petBallWater.indexOf('\n}', start) + 2) : ''
  const spaceN = (seg.match(/pathLength=\{RING_DASH_SPACE\}/g) || []).length
  const ticksN = (seg.match(/pathLength=\{96\}/g) || []).length
  const bare = (seg.match(/<circle(?![^>]*pathLength)/g) || []).length
  ok(
    seg !== '' && spaceN === 4 && ticksN === 1 && bare === 0,
    `K11f ringSvg 的 5 个 circle 全带 pathLength 归一化（RING_DASH_SPACE×${spaceN}/4 + 刻度圈 96×${ticksN}，裸 circle ${bare} 个）`
  )
}
// K11f2 · 跨 TS/CSS 自洽：pathLength 与 dash 周期必须凑出整数粒数（2026-10-06 check P6 M3）
//
// **这是「几何不许进 TS」纪律的唯一泄漏点**：刻度圈的周长归一化写在 TS 里
// （PetBall.tsx 的 `pathLength={96}`），缺口 pattern 写在 CSS 里
// （--ring-ticks-dash: 0.7 3.3）。两者单独都合法，合起来才有意义：
// dasharray 的单位是 pathLength 空间，一个 pattern 周期 = pathLength/周期数 粒。
// 改任一侧而不改另一侧 → 刻度圈画出 34 粒或 12 粒，界面上看不出报错，
// K11f 那种「数一数有几个 pathLength」的断言照样全绿（实测 0.7 3.3 → 0.7 2.3 双绿）。
//
// 为什么锁 24：原型 skin-applied.html 的 .v1 .ticks 是
// `repeating-conic-gradient(… 0deg 2deg, transparent 2deg 15deg)` —— 15° 一粒 = 360/15 = 24。
{
  const ticksPathLength = (() => {
    const m = petBallWater.match(/className="ring-ticks"[\s\S]{0,120}?pathLength=\{(\d+(?:\.\d+)?)\}/)
    return m ? Number(m[1]) : null
  })()
  const rootTickDash = tokenInScope('--ring-ticks-dash', 'root')
  const norm = (v) => (v == null ? null : v.trim().split(/\s+/).map(Number))
  const darkDash = norm(tokenInScope('--ring-ticks-dash', 'dark'))
  const rootNums = norm(rootTickDash)
  const period = rootNums ? rootNums.reduce((a, b) => a + b, 0) : null
  const ticks = period && ticksPathLength ? ticksPathLength / period : null
  ok(
    ticksPathLength != null && rootNums != null && period != null,
    `K11f2 前置：读得到 TS 的 pathLength（${ticksPathLength}）与 CSS 的 --ring-ticks-dash（${rootTickDash}）`
  )
  ok(
    ticks != null && Number.isInteger(ticks) && ticks === 24,
    `K11f2 刻度粒数 = pathLength(${ticksPathLength}) / dash 周期(${period}) = ${ticks}，必须是整数 24（原型 15°/粒 × 360；非整数 = 画不出接缝的圈）`
  )
  ok(
    darkDash != null && rootNums != null &&
      darkDash.reduce((a, b) => a + b, 0) === period,
    `K11f2 dark 的 --ring-ticks-dash 与 :root 兜底同周期（${(darkDash || []).join(' ')} vs ${(rootNums || []).join(' ')}；否则刻度数逐皮漂移，K11f 的 24 粒只对 :root 成立）`
  )
}
// 环随 disc 收尽（hidden 稳态只剩柱；absorbing/revealing 走同一套 disc 关键帧）。
// K11f3 · --ring-seg-dash 的**取值**（不只是存在性）（2026-10-06 check P6 M4）
//
// K11d 只断 minimal 声明了 --ring-seg-dash，断不了「声明了但值是编的」：
// 变异 `22.7 6.1 22.7 6.1 22.7 83.4` → `30 10 30 10 10 10` 双绿。
// 真相源是原型 skin-applied.html V5 的
//   stroke-dasharray="60 16 60 16 60 220"（112 坐标系，r=42，周长 C=2π·42≈263.89）
// 折到 pathLength=100 空间：60/C*100=22.7、16/C*100=6.1、220/C*100=83.4 —— 与现值逐位吻合。
// 这里把折算在门里**重算一遍**（不是抄一个魔数）：改了周长或 pattern，断言自己会红。
{
  const PROTO_R = 42
  const PROTO_DASH = [60, 16, 60, 16, 60, 220]
  const C = 2 * Math.PI * PROTO_R
  const folded = PROTO_DASH.map((v) => (v / C) * 100).map((v) => v.toFixed(1))
  // 取值同样走 tokenInScope（同 K11f2 的理由：同皮肤有多个块，不能只取第一个）。
  const segAt = (scope) => tokenInScope('--ring-seg-dash', scope) || ''
  const want = folded.join(' ')
  const gotRoot = segAt('root')
  const gotMinimal = segAt('minimal')
  ok(
    gotRoot === want,
    `K11f3 :root 的 --ring-seg-dash = 原型折算值 ${want}（实际 ${gotRoot || '未找到'}）`
  )
  ok(
    gotMinimal === want,
    `K11f3 minimal 的 --ring-seg-dash = 原型折算值 ${want}（实际 ${gotMinimal || '未找到'}；V5 柠檬分段环 3 段 + 缺口兼刻度）`
  )
  ok(
    folded.length === 6 && folded.filter((_, i) => i % 2 === 0).length === 3,
    `K11f3 原型 pattern 是 3 段弧 + 3 段缺口（${folded.join(' ')}）`
  )
}
//
/**
 * 找出「phase 作用域下、选择器列表里同时含 anchor 与 .fluid-ring」的那条规则，
 * 返回 {body, sel, reduced, at}（选哪条由 where 定）。
 *
 * `where` 是**互斥认人**的关键（'top' vs 'reduced'，见下）：
 *   - 'top'     → 只认顶层规则（morph 那条）
 *   - 'reduced' → 只认 `@media (prefers-reduced-motion: reduce)` 内层的规则（降级态那条）
 *   传别的值 → 抛错（防止有人顺手传个新值得到一条永不匹配 → 恒红的门）。
 *
 * 为什么不能用一条正则（实测踩过两次）：
 *   ① `[data-fluid='hidden'] … .fluid-ring … scale(0)` 会匹配到文件尾
 *      `@media (prefers-reduced-motion: reduce)` 里的**另一条**同形状规则
 *      （降级态也要收环）。把 morph 那条里的 .fluid-ring 删掉，断言照样全绿
 *      —— 假绿集 = 3。
 *   ② 按 @media 切段也不可靠：本文件有 **4 处** prefers-reduced-motion 块，
 *      morph 那条藏在第 2 处之前，切哪一刀都躲不开（切第一处 → morph 段被整段切掉，
 *      恒红；切最后一处 → ②照旧）。
 * 所以改成按**选择器列表的内容 + 所在层**认人：morph 那条在顶层、降级态那条在
 * reduced-motion 内层，两者形状几乎一样，只能靠 at-rule 内外来区分。
 * ⚠ 这也是 K11g2 曾经是空断言的根因：它写的是
 *   `@media (prefers-reduced-motion: reduce)[\s\S]*?\[data-fluid='hidden'\]…scale(0)`，
 *   `[\s\S]*?` 从**第一处** reduced-motion 块一路吞到文件尾的 morph 段，
 *   于是判的其实是 morph 那条 —— 删掉降级态段里的 .fluid-ring 仍红 0（实测）。
 */
function phaseRingRule(phase, anchor, bodyMust, where = 'top') {
  if (where !== 'top' && where !== 'reduced') {
    throw new Error(`phaseRingRule: where 只认 'top' / 'reduced'，收到 ${JSON.stringify(where)}（新值会让门恒红或恒绿）`)
  }
  const re = new RegExp(`\\[data-fluid='${phase}'\\]`, 'g')
  let m
  while ((m = re.exec(css))) {
    const brace = css.indexOf('{', m.index)
    if (brace < 0) continue
    // 选择器列表：从这条 data-fluid 往回退到规则边界（} 或 ;），往前看到 {
    let head = m.index - 1
    while (head >= 0 && css[head] !== '}' && css[head] !== ';') head--
    const sel = css.slice(head + 1, brace)
    if (!/\.fluid-ring\b/.test(sel) || !anchor.test(sel)) continue
    // ⚠ 跳过 at-rule 内层的同名规则（最要紧的一条）：文件尾
    // `@media (prefers-reduced-motion: reduce)` 里那条降级态 hidden 规则
    // 也是「disc + ring + scale(0)」，形状与 morph 那条几乎一样 —— 认不准就会
    // 由它代答（实测：morph 那条删掉 .fluid-ring，三条断言仍全绿，假绿集 = 3）。
    // 判法同 declScopes：维护开括号栈，栈里出现 at-rule 即内层。
    //
    // ⚠ 栈要扫到 `m.index`（本规则自己的头），**不能**扫到回退出来的 `head`：
    //   head 指向的是**上一条规则的那个 `}`**，把它排除在扫描外就等于少弹一次栈，
    //   于是 `@keyframes pill-absorb {` 永远留在栈里 → 每条规则都被误判成
    //   「在 keyframes 内层」→ K11g 三条恒红（实测踩过，另一方向的假红）。
    const stack = []
    for (let i = 0; i <= m.index; i++) {
      const c = css[i]
      if (c === '{') {
        let s = i - 1
        while (s >= 0 && css[s] !== '}' && css[s] !== ';') s--
        stack.push(css.slice(s + 1, i))
      } else if (c === '}' && i < m.index) stack.pop()
    }
    const inReduced = stack.some((h) => /^\s*@media\s*\(prefers-reduced-motion/.test(h))
    const inOtherAt = stack.some((h) => /^\s*@/.test(h))
    // 互斥认人：'top' 只认顶层，'reduced' 只认 reduced-motion 内层。
    // 两者都不许由对方代答 —— 这正是 K11g2 曾经恒绿的原因。
    if (where === 'top' ? inOtherAt : !inReduced) continue
    let depth = 0
    for (let j = brace; j < css.length; j++) {
      if (css[j] === '{') depth++
      else if (css[j] === '}' && --depth === 0) {
        const body = css.slice(brace + 1, j)
        if (body.includes('{')) continue // 嵌套块不是平面声明块
        if (bodyMust && !bodyMust.test(body)) continue
        return { body, sel: sel.trim(), reduced: inReduced, at: inOtherAt }
      }
    }
  }
  return null
}
/** 只要声明体（多数门只判声明）；找不到返回 null */
function phaseRingBody(phase, anchor, bodyMust, where = 'top') {
  const r = phaseRingRule(phase, anchor, bodyMust, where)
  return r ? r.body : null
}

for (const [phase, bodyMust, why] of [
  ['hidden', /scale\(0\)/, '环随 disc 收尽（hidden 稳态只剩柱，不留在屏边）'],
  ['revealing', /disc-reveal/, '环随 disc 回弹（disc-reveal 与 disc 同一关键帧）']
]) {
  const b = phaseRingBody(phase, /\.fluid-disc\b/, bodyMust)
  ok(b != null, `K11g [data-fluid='${phase}'] 的水渍态名单含 .fluid-ring（${why}）`)
}
ok(
  phaseRingBody('absorbing', /\.fluid-disc\b/, /disc-absorb-h/) != null &&
    phaseRingBody('absorbing', /\.fluid-disc\b/, /disc-absorb-v/) != null,
  'K11g absorbing 名单含 .fluid-ring 且 h/v 两套齐全（环随球盘一起被吸入，不另写 morph）'
)
// reduced-motion 降级态：环也要收（不收 = 球不动而环还留在屏边）。
// ⚠ 断法是 phaseRingBody(..., 'reduced')，**不是**一条跨文件的正则：
//   旧写法 `@media (prefers-reduced-motion: reduce)[\s\S]*?\[data-fluid='hidden'\]…scale(0)`
//   里那个 [\s\S]*? 从**第一处** reduced-motion 块一路吞到文件尾的 morph 段，
//   于是判的其实是 morph 那条 —— 删掉降级态段里的 .fluid-ring 仍红 0（实测）。
// 现在 K11g（'top'）与 K11g2（'reduced'）各认各的层，互不冒充（变异双向可红）。
const reducedRule = phaseRingRule('hidden', /\.fluid-disc\b/, /scale\(0\)/, 'reduced')
ok(
  reducedRule != null,
  'K11g2 reduced-motion 下降级态也把环收尽（直接显隐，不是半截动画；判的是 at-rule 内层那条，不是 morph 那条）'
)
// ⚠ 把「判到的确实在 reduced-motion 里」显式断出来：where 参数是**可被悄悄改掉**的，
//   把 'reduced' 改成 'top' 后 K11g2 会去判 morph 那条 —— 而 morph 那条同样存在，
//   于是门照样绿、K11g2 实际已失效（实测：这么改，红 0）。这条把语义钉死。
//   ⚠ 这里只断 reduced，**不要**顺带断 !at：降级那条本来就该在 at-rule 内层，
//   at 是「在任意 at-rule 内」的意思，拿它当反条件会把这条门变成恒红（试过）。
ok(
  reducedRule != null && reducedRule.reduced === true,
  `K11g2c K11g2 判到的那条真的在 @media (prefers-reduced-motion) 内层（${reducedRule ? reducedRule.sel.replace(/\s+/g, ' ').slice(0, 90) : '未找到'}）`
)
// 反向对照：morph 那条**必须**在顶层且不在降级层。两条合起来 = 两个不同的源码位置，
// 谁也代答不了谁。
const morphRule = phaseRingRule('hidden', /\.fluid-disc\b/, /scale\(0\)/, 'top')
ok(
  morphRule != null && morphRule.reduced === false,
  `K11g2d 对照：morph 的 hidden 规则在顶层、不在降级层（${morphRule ? morphRule.sel.replace(/\s+/g, ' ').slice(0, 90) : '未找到'}）`
)
// ⚠ 这里**不再**补一条「降级块里同时出现 .fluid-ring 与 scale(0)」的整块扫描：
//   它与 K11g2 判同一件事，且更弱 —— 降级块里另有 `animation: none` 那条名单也含
//   .fluid-ring，所以删掉 hidden 规则里的 .fluid-ring 时它照样绿（实测红 0）。
//   停不停得下来是另一条事实，由 K11m 独立守（animation 那半，见下）。
// 环不吃 goo 滤镜：goo 容器只融合形状，2px 的弧经 stdDeviation=4 会被 blur 吃掉
// （与雨/读数同一取证结论：5l「DOM 全对但像素无色」）。断法同 K7h：goo 开标签与
// fluid-ring 开标签之间的 <div / </div 必须配平（配平 = 环在 goo 闭标签之后）。
{
  const gooOpen = petBallWater.indexOf('className="petball-goo"')
  const ringOpen = petBallWater.indexOf('className="fluid-ring"')
  const seg = gooOpen >= 0 && ringOpen > gooOpen ? petBallWater.slice(gooOpen, ringOpen) : ''
  const opens = (seg.match(/<div[\s>]/g) || []).length - (seg.match(/<div[^>]*\/>/g) || []).length
  const closes = (seg.match(/<\/div>/g) || []).length
  ok(
    seg !== '' && opens === closes,
    `K11h .fluid-ring 不在 .petball-goo 容器内（div 配平 ${opens}/${closes}；嵌套会被 goo blur 吃掉）`
  )
}
// 环形态皮不挂水/雨：display 走 --water-display（不是 opacity 0 —— 与 K9b 同纪律）。
ok(
  /\.slosh\s*\{[^}]*display:\s*var\(--water-display/.test(css) &&
    /\.pour-clip\s*\{[^}]*display:\s*var\(--water-display/.test(css),
  'K11i 球内水体与倒水雨的显隐走 --water-display（环形态皮整体退场，不留雨打空盘）'
)
// peek 跟随本体形态：预览不能与本体不同形（P4 的口径是"预览完整形态"）。
ok(
  /\.fluid-peek-ring\s*\{[^}]*display:\s*var\(--ring-display/.test(css) &&
    /\.fluid-peek-wave[^{]*\{[^}]*display:\s*var\(--water-display/.test(css),
  'K11j peek 预览跟随本体形态（环皮预览环、水体皮预览波；两者都是 display 不是 opacity）'
)
// K11m · reduced-motion 的 animation:none 必须真的压过 morph 段（2026-10-06 check P6 M1）
//
// **实测过的缺陷**：降级段写 `.petball.no3d .fluid-ring { animation: none }` = (0,3,0)，
// 而 morph 段给同元素挂动画的是 `[data-edge][data-fluid='absorbing']` 那一族 = (0,6,0)。
// 后者胜出 → reducedMotion=true 时 ring.animationName 实测仍是 `disc-absorb-h`
// （disc 同理；那是既有行为，不是 P6 引入的，但注释宣称的能力就该兑现）。
// 修法是 !important（文件尾 .pet/.pet * 已有同款先例）。
//
// 为什么门要自己算 specificity 而不是只 grep `!important`：
//   只断「降级段里有 !important」是**弱门** —— 把 !important 加到一条无关的
//   声明上（哪怕降级块里另一个选择器）它照样绿。这里改成：把降级段那条规则
//   与**所有**给 .fluid-ring/.fluid-disc 挂 animation 的非降级规则逐对比特，
//   要求降级侧要么带 !important，要么 specificity 严格更高。任一条竞争规则
//   都能单独把这条门打红。
function specificity(sel) {
  const s = sel.trim()
  // 去伪类参数里的内容，避免 :not(.a) 被数成两个 class
  const noArgs = s.replace(/\([^)]*\)/g, ' ')
  // ⚠ 伪类那一项写的是 ::?[\w-]+（**方括号**）。第一版误写成 ::?[-w]+ ——
  //   那是字符类 [-w]，只含「连字符」和字母 w，于是 `:root` / `:hover` 都被数成 0，
  //   伪类完全不计。当前 K11m 的几条选择器里没有伪类，所以门照样绿 —— 典型的
  //   「错得不影响这批输入」的潜伏错误。K11m0 那条自检就是为它立的。
  return [
    (noArgs.match(/#[-\w]+/g) || []).length,
    (noArgs.match(/\.[-\w]+|\[[^\]]*\]|::?[\w-]+/g) || []).length,
    (noArgs.match(/(?:^|[\s>+~])[a-z][-\w]*/g) || []).length
  ]
}
// K11m0 · specificity 计算器的自检（先证明尺子本身是准的，再拿它量别人）
// 少算伪类会让「靠伪类提权压过降级段」的那条规则被误判成压不过 ——
// 尺子不准比没尺子更糟：门会一直红或一直绿，且没人知道为什么。
{
  const cases = [
    [':root', [0, 1, 0]],
    ['.fluid-ring', [0, 1, 0]],
    ['.petball.no3d .petball-fallback[data-fluid=\'hidden\'] .fluid-ring', [0, 5, 0]],
    ['.a:hover', [0, 2, 0]],
    ['.a:not(.b)', [0, 2, 0]], // 参数里的 .b 要去掉，只数 :not 与 .a
    ['#x .y', [1, 1, 0]]
  ]
  const wrong = cases.filter(([sel, want]) => specificity(sel).join() !== want.join()).map(([sel, want]) => `${sel} 应 ${want} 实 ${specificity(sel)}`)
  ok(
    wrong.length === 0,
    `K11m0 specificity 尺子准（含伪类/属性/id/去参数；不对的：${wrong.join(' | ') || '无'}）`
  )
}
const specCmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
const specStr = (s) => `(${s.join(',')})`

/**
 * 扫出样式表里**每一条选择器**（顶层与 at-rule 内层都算，@keyframes 的百分比步不算），
 * 连带它的声明体、所在层与 specificity。
 *
 * 为什么不用 ruleBody：那条只认「整条就是它」的顶层规则，取不到
 * `[data-edge][data-fluid=…]` 那种多段选择器，也取不到 at-rule 内层的
 * （ruleBody 遇嵌套块直接返回 null —— 见它自己的注释）。
 * 一次全扫，多条门共用（K11m 比 specificity、K11n 断 freeze 名单）。
 *
 * ⚠ 开括号栈必须**增量**维护（从上次位置往前推），不能每条规则都从头重扫一遍：
 *   从头重扫是 O(规则数 × 文件长) = O(n²)，实测把本文件从 0.25s 拖到 0.6s ——
 *   一个「便宜静态检查」的脚本不该有这种平方项（这里 4400 行已翻倍，再长一倍就 4 倍）。
 */
function scanSelectors() {
  const out = []
  const re = /([^{}]+)\{/g
  const stack = []
  let pos = 0
  let m
  while ((m = re.exec(css))) {
    const head = m[1]
    // 把栈从 pos 推进到本规则头（单调前进，总代价 O(n)）
    for (let i = pos; i < m.index; i++) {
      const c = css[i]
      if (c === '{') {
        let s = i - 1
        while (s >= 0 && css[s] !== '}' && css[s] !== ';') s--
        stack.push(css.slice(s + 1, i))
      } else if (c === '}') {
        stack.pop()
      }
    }
    pos = m.index
    if (/^\s*[\d.]+%/.test(head)) continue // @keyframes 的 0% / 100% 步
    let depth = 0
    let end = -1
    for (let j = m.index + m[0].length - 1; j < css.length; j++) {
      if (css[j] === '{') depth++
      else if (css[j] === '}' && --depth === 0) { end = j; break }
    }
    if (end < 0) continue
    const body = css.slice(m.index + m[0].length, end)
    if (body.includes('{')) continue // 嵌套块不是平面声明块
    const reduced = stack.some((h) => /^\s*@media\s*\(prefers-reduced-motion/.test(h))
    const atRule = stack.some((h) => /^\s*@/.test(h))
    for (const sel of head.split(',').map((x) => x.trim()).filter(Boolean)) {
      out.push({ sel, body, spec: specificity(sel), reduced, atRule })
    }
  }
  return out
}
const ALL_SELECTORS = scanSelectors()

/** 列出「给 target 挂 animation:」的规则：{sel, spec, important, reduced, value} */
function animationRules(target) {
  return ALL_SELECTORS
    .filter((r) => new RegExp(`\\.${target}\\b`).test(r.sel) && /\banimation\s*:/.test(r.body))
    .map((r) => {
      const am = r.body.match(/\banimation\s*:\s*([^;}]+)/)
      return {
        ...r,
        important: /!important/.test(am ? am[1] : ''),
        value: (am ? am[1] : '').replace('!important', '').trim()
      }
    })
}
for (const target of ['fluid-ring', 'fluid-disc']) {
  const rules = animationRules(target)
  const reducedOff = rules.filter((r) => r.reduced && r.value === 'none')
  const competitors = rules.filter((r) => !r.reduced && r.value !== 'none')
  // 前置：降级段与竞争段都非空（否则下面的循环是空转 = 恒绿）
  ok(
    reducedOff.length > 0 && competitors.length > 0,
    `K11m 前置 ${target}：降级段有 animation:none（${reducedOff.length} 条）、非降级段有挂动画的规则（${competitors.length} 条）`
  )
  ok(
    reducedOff.length > 0,
    `K11m ${target} 的 reduced-motion 段真的写了 animation: none（${reducedOff.length} 条）`
  )
  // 逐条竞争规则比：任一条能赢 = 降级形同虚设
  const losers = []
  for (const c of competitors) {
    const beaten = reducedOff.some((r) => r.important || specCmp(r.spec, c.spec) > 0)
    if (!beaten) losers.push(`${c.sel} ${specStr(c.spec)}`)
  }
  ok(
    reducedOff.length > 0 && losers.length === 0,
    `K11m ${target} 的降级 animation:none 压得过全部 ${competitors.length} 条 morph 规则（压不过的：${losers.join(' | ') || '无'}；!important 或 specificity 更高）`
  )
}
// K11n · 取帧冻结的停表名单与定帧 transform 名单都要含 .fluid-ring（2026-10-06 check P6 M2）
//
// **实测过的缺陷（两处，不止报告里写的那一处）**：
//   ① 停表名单（`[data-freeze] … animation: none`）里有 .fluid-disc、没有 .fluid-ring。
//      morph 段给 ring 挂的 disc-absorb-h/v 仍在跑，而**运行中的 animation 会盖掉
//      静态 transform** —— 实测（headless Chromium 最小复现）：freeze='stretch' 下
//      ring 的 computed transform 是动画中段的 matrix，不是 freeze 规则里那个
//      scale(1.4, 0.7)。于是「球被拉成液线、环还圆满 56px」的错帧正是这条漏项造成的。
//   ② 四条定帧 transform 规则（stretch / stretch 纵向 / bridge / stain）里虽然
//      写了 .fluid-ring，但当时无门 —— 摘掉任一条的红 0。
//
// 逐个 phase 断言，不合并成一条：合并的话「stretch 缺了但 bridge 在」会被平均掉。
const freezeRules = ALL_SELECTORS.filter((r) => /data-freeze/.test(r.sel))
const freezeRingRules = freezeRules.filter((r) => /\.fluid-ring\b/.test(r.sel))
// ① 停表名单（无值 [data-freeze]）必须有 .fluid-ring
{
  const pauseRing = freezeRules.filter((r) => /\.fluid-ring\b/.test(r.sel) && /\[data-freeze\](?!=)/.test(r.sel))
  const pauseBody = pauseRing.find((r) => /\banimation\s*:\s*none/.test(r.body))
  ok(
    pauseBody != null,
    `K11n freeze 停表名单含 .fluid-ring（animation:none；命中 ${pauseRing.length} 条选中器${pauseBody ? '' : '，其中没有 animation:none'}）`
  )
}
// ② 每个定帧 phase：凡是给 .fluid-disc 定了帧 transform 的规则，.fluid-ring 必须在同一条里。
//    断法是「disc 在 ⇒ ring 也在」——只断 ring 存在会被无关的 ring 规则顶包。
for (const phase of ['stretch', 'bridge', 'stain']) {
  const selRe = new RegExp(`\\[data-freeze='${phase}'\\]`)
  const at = (cls, vertical) =>
    freezeRules.filter(
      (r) => selRe.test(r.sel) && new RegExp(`\\.${cls}\\b`).test(r.sel) && (vertical ? /data-edge=/.test(r.sel) : !/data-edge=/.test(r.sel))
    ).length
  const d = at('fluid-disc', false)
  const r0 = at('fluid-ring', false)
  const vd = at('fluid-disc', true)
  const vr = at('fluid-ring', true)
  ok(
    d > 0 && d === r0 && vd === vr,
    `K11n freeze='${phase}' 的 disc/ring 定帧名单等长（横 ${d}/${r0}；纵向 ${vd}/${vr}）`
  )
}
// 定帧 transform 名单（带 phase 值的那些）每条都要真给 transform。
// 不把停表名单那条（animation:none，本就不该有 transform）混进来算。
const freezeFrameRing = freezeRingRules.filter((r) => /\[data-freeze='[^']+'\]/.test(r.sel))
ok(
  freezeFrameRing.length >= 4 && freezeFrameRing.every((r) => /transform\s*:/.test(r.body)),
  `K11n freeze 定帧规则里的 .fluid-ring 每条都给了 transform 且覆盖 ≥4 处（实际 ${freezeFrameRing.length} 条，其中带 transform 的 ${freezeFrameRing.filter((r) => /transform\s*:/.test(r.body)).length} 条）`
)
// K11n2 · freeze 停表名单的 animation:none 必须**真压过**全部非降级 morph animation 规则
// （2026-10-06 用户决定：freeze 提权封死；disc 与 ring 一并真停）
//
// **实测过的缺陷**：停表名单是 `[data-freeze]` 无值那一族 = (0,5,0)，morph 段给同元素
// 挂动画的是 `[data-edge][data-fluid='absorbing']` 那一族 = (0,6,0)。后者胜出，于是
// `data-freeze` 与 `data-fluid='absorbing']` **共存**时 disc/ring 的 animation 照跑 ——
// 而运行中的 animation 会盖掉静态 transform，所以下面四条 freeze 定帧 transform
// （stretch / bridge / stain）在这两个相位共存时**根本没生效**，5i/5j/5k 拍到的是
// 动画中段的 matrix，不是定帧那一帧。这不是"少停一张表"，是取帧机制本身失效。
//
// 修法是 !important（与 K11m 降级段同款，文件尾 .pet/.pet * 已有先例）。
//
// **为什么不复用 K11m 那条门**：K11m 判的是 `reduced` 层的降级段，停表名单在顶层、
// 且是**另一条**规则。两条门共用同一个比法（逐条比比特 + !important 兜底），但认人不同。
//
// ⚠ 逐个目标（disc / ring）各判一次，不合并：morph 段给两者的选择器列表高度重合，
//   "disc 被压过就当 ring 也被压过"在名单被拆开时会假绿。
for (const target of ['fluid-disc', 'fluid-ring']) {
  const rules = animationRules(target)
  // 停表名单 = 带 [data-freeze]（**无值**）且真的写了 animation:none 的那些。
  // 带值的（='stretch' 等）是定帧 transform 规则，本就不该有 animation，不算竞争者。
  const pause = rules.filter((r) => /\[data-freeze\](?!=)/.test(r.sel) && r.value === 'none')
  const competitors = rules.filter((r) => !r.reduced && r.value !== 'none')
  ok(
    pause.length > 0 && competitors.length > 0,
    `K11n2 前置 ${target}：停表名单有 animation:none（${pause.length} 条）、非降级段有挂动画的规则（${competitors.length} 条；任一为 0 下面就是空转 = 恒绿）`
  )
  const losers = []
  for (const c of competitors) {
    // 任一条竞争规则压过停表名单 = 定帧 transform 失效 = 停表形同虚设
    const beaten = pause.some((r) => r.important || specCmp(r.spec, c.spec) > 0)
    if (!beaten) losers.push(`${c.sel} ${specStr(c.spec)}`)
  }
  ok(
    pause.length > 0 && losers.length === 0,
    `K11n2 ${target} 的 freeze 停表 animation:none 压得过全部 ${competitors.length} 条非降级 morph 规则（压不过的：${losers.join(' | ') || '无'}；!important 或 specificity 更高）`
  )
}
// 弧色不写死等级色：CSS 里 .ring-arc 的兜底是 var(--ok) + lvl-* 覆写，
// 真值走内联 water（连续插值）。若有人把 --warn/--danger 的硬编码色值搬进
// .ring-arc 的 stroke，弧就不再随等级连续变化（会在阈值处跳变）。
const arcDecls = decls(ruleBody(css, '.petball.no3d .ring-arc'))
ok(
  arcDecls.stroke != null && /var\(\s*--ok\s*\)/.test(arcDecls.stroke),
  `K11k .ring-arc 的兜底 stroke 是 var(--ok)（实际 ${JSON.stringify(arcDecls.stroke || '未找到')}；真值走内联 water）`
)
for (const lvl of ['warn', 'danger', 'muted']) {
  ok(
    ruleBody(css, `.petball.no3d.lvl-${lvl} .ring-arc`) != null,
    `K11k lvl-${lvl} 的弧色覆写都在（删掉一级，那一级的弧就恒绿）`
  )
}
// K11p · 身份色不得由语义色推导（2026-10-06 用户决定：minimal 环找回柠檬身份色）
//
// **实测过的缺陷（两处，都不是"画错颜色"而是"认不出是哪款皮"）**：
//   minimal 的 `--ring-track` 写成 `color-mix(in srgb, var(--ok) 22%, transparent)`，
//   而 minimal 的 --ok 是绿 #1a9e4b —— 于是 V5「柠檬分段环」三个部件（轨道/分段/弧）
//   全是语义绿，一点身份色都不剩，跟原型（轨道 `rgba(190,255,60,.22)` 柠檬）不是同一款皮。
//   candy 的 `--ring-track` / `--ring-inner-c` 同病（--ok #22b573）。
//
// **为什么用"不是 color-mix(var(--ok))"当判据，而不是"等于某个色值"**：
//   逐皮钉死具体 hex 会把"调色"变成改测试（换皮就得改门），而这条要守的是**一条纪律** ——
//   身份色是皮肤自己的长相，等级色是数据的读数，两者被绑在一起时，等级一变身份就变。
//   所以只断"有没有从 --ok 推导"，具体值留给逐像素取帧验收。K11k 断另一半（弧必须走等级令牌）。
//
// ⚠ 逐令牌断言而不是合并成一条：合并的话"轨道干净了但分段还是绿的"会被平均掉 ——
//   而"轨道柠檬、分段还是绿"正是本次要消灭的半吊子形态。
const RING_IDENTITY_SKINS = ['dark', 'candy', 'minimal']
const RING_IDENTITY_TOKENS = ['--ring-track', '--ring-ticks-c', '--ring-seg-c', '--ring-inner-c']
const OK_DERIVED = /color-mix\([^;]*var\(\s*--ok\s*\)/
for (const skin of RING_IDENTITY_SKINS) {
  const declared = RING_IDENTITY_TOKENS.filter((t) => declScopes(t).has(skin))
  // 前置：这层没有身份色令牌 = 下面的循环空转 = 恒绿（负断言必须有前置，section D 的纪律）
  ok(
    declared.length > 0,
    `K11p 前置 ${skin} 至少声明一个身份色令牌（实得 ${declared.join(',') || '无'}；一个都没有 = 下面循环空转）`
  )
  for (const t of declared) {
    const v = tokenInScope(t, skin) || ''
    ok(
      !OK_DERIVED.test(v),
      `K11p ${skin} 的 ${t} 不是 --ok 的混色（实际 ${JSON.stringify(v)}；身份色由语义色推导 = 一眼认不出是哪款皮）`
    )
  }
}
// K11p2 · 令牌干净**还不够**：`.ring-seg` 上不得有 lvl-* 的 stroke 覆写。
// 少了这半条，一条 `.petball.no3d.lvl-warn .ring-seg { stroke: var(--warn) }` 就能把
// 分段重新拽回等级色，而 K11p 照样全绿 —— 正是本次要消灭的「轨道柠檬、分段还是绿」。
// 这与 quality 文档「不要在注释里承诺代码没有的能力」同一类：令牌那层的纪律，
// 拦不住覆写那层的漂移。
{
  const segStroke = ALL_SELECTORS.filter((r) => /\.ring-seg\b/.test(r.sel) && /\bstroke\s*:/.test(r.body))
  const offenders = segStroke.filter((r) => /lvl-/.test(r.sel) || /var\(\s*--(warn|danger|ok)\s*\)/.test(r.body))
  ok(
    segStroke.length === 1 && offenders.length === 0,
    `K11p2 .ring-seg 的 stroke 只由 --ring-seg-c 一处给（实得 ${segStroke.length} 条 stroke 规则，被等级色拽走的 ${offenders.length} 条：${offenders.map((r) => r.sel.replace(/\s+/g, ' ').slice(0, 70)).join(' | ') || '无'}）`
  )
  const base = segStroke[0] ? segStroke[0].body : ''
  ok(
    /stroke\s*:\s*var\(\s*--ring-seg-c\s*\)/.test(base),
    `K11p2 .ring-seg 的 stroke 取自 --ring-seg-c（实际 ${JSON.stringify((base.match(/\bstroke\s*:\s*[^;}]+/) || [])[0] || '未找到')}；直接写 var(--ok) 就是身份=等级）`
  )
}

// K4 · 水柱几何（R4-5 原地变柱）：CSS 的四条边规则与 shared/fluid.waterColumn 同形
//     （竖柱 12×56 / 横槽 56×12；12 = shared/dock-hide.COLUMN_W，56 = shared/pet-view.BALL_VIEW），
//     且贴边侧（左沿柱在左，不在右 —— 与旧滑出 peek 侧反号）。
//     纯函数那半边的数由 scripts/test-fluid.mjs 用例 3 钉死，这里钉 CSS 这半边 ——
//     两边各写一套数是「看着有柱子但点不中」的成因（与命中区 peekHitbox 脱钩）。
for (const [edge, want] of [
  ['left', '12px/56px'],
  ['right', '12px/56px'],
  ['top', '56px/12px'],
  ['bottom', '56px/12px']
]) {
  const body = decls(ruleBody(css, `.petball.no3d .petball-fallback[data-edge='${edge}'] .fluid-pill`))
  const got = `${body.width || '?'}/${body.height || '?'}`
  ok(body.width != null && got === want, `K4 水柱 ${edge} 边 ${got}（应为 ${want}，与 waterColumn 同形）`)
}
// K4d · 柱在屏边侧（R4-5 方向回归网）：左沿 left:0（不是 right:0），右沿 right:0，
// 上沿 top:0，下沿 bottom:0 —— 摆错边等于柱子悬空在窗中。
for (const [edge, prop] of [['left', 'left'], ['right', 'right'], ['top', 'top'], ['bottom', 'bottom']]) {
  const body = decls(ruleBody(css, `.petball.no3d .petball-fallback[data-edge='${edge}'] .fluid-pill`))
  ok(body != null && String(body[prop] || '') === '0', `K4d ${edge} 沿柱贴 ${prop}:0（屏边侧）`)
}
// 柱内液与柱顶波浪的 DOM+CSS 都在（缺一个，柱子就是空槽/静槽）。
ok(/fluid-column-fill/.test(petBallWater) && /fluid-column-wave/.test(petBallWater), 'K4b 柱内液 + 柱顶波浪在 JSX 里')
ok(
  ruleBody(css, '.petball.no3d .fluid-column-fill') != null &&
    ruleBody(css, '.petball.no3d .fluid-column-wave svg') != null,
  'K4c 柱内液 + 柱顶波浪的 CSS 规则都在'
)
// K4e · 柱内液圆角与槽同值（方形 fill 底顶着圆角槽 = 底部尖耳朵；方形 fill 顶 +
// 圆形弯月相交 = 顶部两侧掐出尖。上下全圆与 pill 同半径，弯月圆与圆顶融为连续胶囊；
// 横槽的短边同为 12px，同一半径两向通用，不另起值）。
{
  const pillR = decls(ruleBody(css, '.petball.no3d .fluid-pill'))['border-radius']
  const fillR = decls(ruleBody(css, '.petball.no3d .fluid-column-fill'))['border-radius']
  ok(
    pillR != null && fillR != null && fillR === pillR,
    `K4e 柱内液圆角与槽同值（pill ${pillR || '缺'}/fill ${fillR || '缺'}，不等=尖耳朵回归）`
  )
}

// K5 · 三处暂停都在（hidden 相位 / 页面不可见 / reduced-motion），不是注释。
ok(
  /\[data-fluid='hidden'\][^{]*\.fluid-wave[^}]*animation-play-state:\s*paused/.test(css),
  'K5a hidden 态暂停波浪（J3b 的形状，作用域规则，不是裸 paused）'
)
ok(
  /\.petball-fallback\.doc-hidden[^{]*\.fluid-wave[^}]*animation-play-state:\s*paused/.test(css),
  'K5b 页面不可见（doc-hidden）暂停波浪（PetBall 的 visibilitychange 挂类，CSS 生效）'
)
ok(/docHidden \? ' doc-hidden'/.test(petBallWater), 'K5c 前置：PetBall 真的挂 doc-hidden 类（K5b 不是空洞通过）')
const reducedChunks = css.split('@media (prefers-reduced-motion: reduce)').slice(1)
ok(
  reducedChunks.length > 0 && reducedChunks.some((c) => c.includes('.fluid-bridge') && c.includes('.fluid-surface')),
  'K5d reduced-motion 块里 morph 与水面波浪一起降级（只降一半 = 半动半静）'
)

// K6 · 全屏水体的液位映射：clip 圆 r=27（几乎占满 56 盘）+ 液面公式。
//     液位 = fluidLevel(pct) 那一半由 test-fluid 钉，这里只钉视图这半的两个数。
ok(/id="fluid-clip"[\s\S]{0,120}r="27"/.test(petBallWater), 'K6a 水体 clip 圆 r=27（全屏水，不是 r=17 的小圆）')
ok(/55 - fluidLvl \* 54/.test(petBallWater), 'K6b 液面公式 55 - level×54（顶 1 / 底 55，与 r=27 的圆同口径）')

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
