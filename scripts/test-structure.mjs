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

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
