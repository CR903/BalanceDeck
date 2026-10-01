// 采集接缝的 method / body 契约 —— src/main/request.ts + CollectRequest
// 用法：node scripts/test-seam.mjs
//
// 为什么单独一套：接缝是**全部协议与全部适配器的地基**。Gemini / Antigravity /
// Codex 三家的端点都是 POST + JSON body，其中 Gemini 的 `{ project }` 字段直接
// 决定请求能否成功。这个套件盯的是「接缝怎么把 method / body / Content-Type
// 交给 fetch」，以及两条不许越界的边界。
//
// 本套件加载**真源码**（loadTs + electron 替身），不内联副本 ——
// 见 quality-guidelines.md「不要把实现内联进测试」。
//
// ── 为什么不并进 test-adapters.mjs ──
// 那个文件是四家适配器任务共用的共享文件，改它要碰的行数与断言数都归零风险。
// 本套件独立成文件，本任务对共享文件的改动只有一处：**新增** callProjectRich /
// makeRichRequest，既有 callProject / makeRequest 一个字段都没动
// （由 test-adapters 的 166 项断言数不变证明）。
//
// ── 两条边界（越界了症状会离病因很远）──
//   ① 接缝**不决定序列化**：body 是已序列化的字符串。Gemini 的 token 刷新端点是
//      form-encoded、配额端点是 JSON；若接缝自动 JSON.stringify，form 请求被静默
//      改成 JSON → 服务端 400 → 适配器报「解析失败」。S4/S5 就是钉这一条。
//   ② Content-Type **归调用方**：只在「有 body 且没自带」时补 application/json。

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTs, ELECTRON_STUB } from './lib/load-ts.mjs'

const alias = { electron: ELECTRON_STUB }
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}`)
  }
}

// ─── 走查开关：开发者机器上若开着强制离线，本套件会全线失败，先摘掉 ──────────────
delete process.env.BALANCEDECK_FORCE_OFFLINE

const { request } = await loadTs('src/main/request.ts', { alias })

/**
 * 临时替换 globalThis.fetch，把**实参**（url + init）交给 fn。
 * 断言的是接缝真正交给 fetch 的东西 —— 不是接缝自己的内部变量。
 */
function withFetch(fn) {
  const prev = globalThis.fetch
  globalThis.fetch = fn
  return () => {
    globalThis.fetch = prev
  }
}

/** 发一次请求并取回 fetch 收到的 init；用完自动还原 */
async function captureInit(req) {
  let init = null
  let url = null
  const restore = withFetch(async (u, i) => {
    url = u
    init = i
    return { status: 200, ok: true, text: async () => '{}' }
  })
  try {
    await request(req)
  } finally {
    restore()
  }
  return { url, init }
}

// ═══════════════════════════════════════════════════════════════════════════════
// S1. 缺省行为逐字不变（不传 method / body 仍是 GET 且无体）
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nS1. 缺省（不传 method / body）—— 与本任务改动前逐字相同')

{
  const { url, init } = await captureInit({ url: 'https://x.test/a', headers: { A: '1' } })
  eq(url, 'https://x.test/a', 'S1a URL 原样交给 fetch')
  eq(init.method, 'GET', 'S1b 不传 method → 发 GET（缺省行为未变）')
  eq(init.body, undefined, 'S1c 不传 body → 无请求体')
  // ⚠ 无体请求**不该**补 Content-Type：补了会让某些服务端把 GET 当成有体请求
  ok(!Object.keys(init.headers).some((k) => k.toLowerCase() === 'content-type'), 'S1d 无 body → 不补 Content-Type')
}

{
  const { init } = await captureInit({ url: 'https://x.test/a', headers: { A: '1' }, timeoutMs: 5000 })
  eq(init.method, 'GET', 'S1e 只传 timeoutMs 仍是 GET（既有 2 个调用点就是这个形状）')
  eq(init.body, undefined, 'S1f 只传 timeoutMs 也无体')
}

// ═══════════════════════════════════════════════════════════════════════════════
// S2. 显式 GET
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nS2. 显式 method: GET —— 与不传等价')

{
  const { init } = await captureInit({ url: 'https://x.test/a', headers: {}, method: 'GET' })
  eq(init.method, 'GET', 'S2a 显式 GET 按 GET 发')
  eq(init.body, undefined, 'S2b 显式 GET 且无 body → 无体')
  ok(!Object.keys(init.headers).some((k) => k.toLowerCase() === 'content-type'), 'S2c 显式 GET 无 body → 不补 Content-Type')
}

// ═══════════════════════════════════════════════════════════════════════════════
// S3. POST 无 body
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nS3. method: POST 且无 body')

{
  const { init } = await captureInit({ url: 'https://x.test/v1internal:retrieveUserQuota', headers: {}, method: 'POST' })
  eq(init.method, 'POST', 'S3a POST 按 POST 发')
  eq(init.body, undefined, 'S3b POST 无 body → 无体（不凭空造一个空串体）')
  ok(!Object.keys(init.headers).some((k) => k.toLowerCase() === 'content-type'), 'S3c POST 无 body → 不补 Content-Type（无体不需要）')
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4. POST + JSON body —— 接缝补 Content-Type
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nS4. POST + JSON body —— 调用方未带 Content-Type 时接缝补 application/json')

const GEMINI_PROJECT = 'gen-lang-client-abc123'
const geminiBody = JSON.stringify({ project: GEMINI_PROJECT })

{
  const { init } = await captureInit({
    url: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
    headers: { Authorization: 'Bearer ya29.fake', Accept: 'application/json' },
    method: 'POST',
    body: geminiBody
  })
  eq(init.method, 'POST', 'S4a POST 按 POST 发')
  eq(init.body, geminiBody, 'S4b body **原样**到达 fetch（接缝不碰内容，一个字节都不改）')
  eq(init.headers['Content-Type'], 'application/json', 'S4c 有 body 且没自带 → 补 application/json')
  eq(init.headers.Authorization, 'Bearer ya29.fake', 'S4d 既有请求头原样保留')
}

// S4g/S4h：补 Content-Type 时**不能就地改调用方的 headers 对象**。
// 为什么单列：withContentType 若写成 `headers['Content-Type'] = …; return headers`
// （少一个 `{...}` 的"简化"），功能断言**全部照绿**，但调用方（适配器持有的
// 常量头对象）从此永久多出一个 Content-Type —— 下一个复用同一对象的请求就会
// 带着上一次补的头发出去，且症状出现在别的端点上（病因与症状隔了一个适配器）。
// 实测：把 `{ ...headers, … }` 改成就地赋值，本套件**零红**，只有 S4g/S4h 能钉住。
{
  const callerHeaders = { Authorization: 'Bearer ya29.fake' }
  const { init } = await captureInit({
    url: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
    headers: callerHeaders,
    method: 'POST',
    body: geminiBody
  })
  ok(!('Content-Type' in callerHeaders), 'S4g 有 body 时接缝**不修改**调用方传入的 headers 对象（就地改会跨调用污染）')
  ok(init.headers !== callerHeaders, 'S4h 有 body 时交给 fetch 的是 headers 的副本（补头不落到调用方的引用上）')
}

{
  // ⚠ 空 body 字符串是「有 body」（调用方显式给了），所以仍算需要 Content-Type
  const { init } = await captureInit({ url: 'https://x.test/a', headers: {}, method: 'POST', body: '' })
  eq(init.body, '', 'S4e 空串 body 原样透传（不被当成「没给 body」丢成 undefined）')
  eq(init.headers['Content-Type'], 'application/json', 'S4f 空串 body 也算有 body → 补 Content-Type')
}

// ═══════════════════════════════════════════════════════════════════════════════
// S5. POST + form body —— 调用方自带 Content-Type，接缝不得覆盖
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nS5. POST + form-encoded body —— 自带 Content-Type 时**不覆盖**')

const FORM_CT = 'application/x-www-form-urlencoded'
const formBody = 'grant_type=refresh_token&refresh_token=fake-value&client_id=fake-id'

{
  const { init } = await captureInit({
    url: 'https://oauth2.googleapis.com/token',
    headers: { 'Content-Type': FORM_CT },
    method: 'POST',
    body: formBody
  })
  eq(init.body, formBody, 'S5a form body 原样到达 fetch')
  // ⭐ 这一条是 D2 的核心：接缝若「聪明地」补/改 Content-Type，Gemini 刷 token 会被服务端 400
  eq(init.headers['Content-Type'], FORM_CT, 'S5b 自带 form Content-Type 时不被覆盖（form 编码必须生效）')
}

{
  // 头名大小写：调用方写小写 content-type 也算「自带」，否则会被补成两份同义头
  const { init } = await captureInit({
    url: 'https://oauth2.googleapis.com/token',
    headers: { 'content-type': FORM_CT },
    method: 'POST',
    body: formBody
  })
  eq(init.headers['content-type'], FORM_CT, 'S5c 小写 content-type 也算自带（大小写不敏感地判）')
  const ctCount = Object.keys(init.headers).filter((k) => k.toLowerCase() === 'content-type').length
  eq(ctCount, 1, 'S5d 只存在一个 Content-Type（没被补成两份同义头）')
}

// ═══════════════════════════════════════════════════════════════════════════════
// S6. 静态守卫 —— 这些字段不许被删/被改回去
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nS6. 静态守卫（类型与实现的形状）')

const typesSrc = readFileSync(resolve(ROOT, 'src/main/adapters/types.ts'), 'utf8')
const reqSrc = readFileSync(resolve(ROOT, 'src/main/request.ts'), 'utf8')

// 剥掉注释再匹配：否则「types.ts 里写着 method」可能在注释里通过，
// 而真实接口删掉了 —— 这正是 quality-guidelines 记录的「断言注释里的文字」。
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}
const typesCode = stripComments(typesSrc)

// S6a 前置：先证明 CollectRequest 这段真的被找到了，否则下面几条会空洞通过
const collectReqBody = /export interface CollectRequest \{([\s\S]*?)\n\}/.exec(typesCode)?.[1] ?? null
ok(collectReqBody != null, 'S6a 前置：找得到 CollectRequest 的声明（下面的守卫不能空洞通过）')

if (collectReqBody != null) {
  ok(/^\s*method\?:\s*'GET'\s*\|\s*'POST'\s*$/m.test(collectReqBody), 'S6b method 是**可选**且是字面量联合 \'GET\' | \'POST\'（不是 string）')
  ok(/^\s*body\?:\s*string\s*$/m.test(collectReqBody), 'S6c body 是**可选**的 string（已序列化，不是对象）')
  ok(/^\s*url:\s*string\s*$/m.test(collectReqBody), 'S6d url 仍是必填（既有字段没被动过）')
  ok(/^\s*headers:\s*Record<string,\s*string>\s*$/m.test(collectReqBody), 'S6e headers 仍是必填 Record<string, string>')
}

// ⭐ D4 的核心守卫：fetch 必须读 req.method。
// 为什么是静态断言：把 method 改回硬编码 'GET' 时，上面 S1b/S2a/S3a 三条会红，
// 但**如果**有人同时改测试，动态断言就跟着一起绿了；静态断言钉的是「实现里必须读它」。
ok(/req\.method/.test(stripComments(reqSrc)), "S6f request.ts 的实现读了 req.method（钉住 D4：不能硬编码 'GET'）")
ok(/fetch\(\s*req\.url\s*,/.test(stripComments(reqSrc)), 'S6g fetch 仍是 fetch(req.url, …) 形态（没有别的地址来源）')
// S6h 必须挡住**任何**形式的对 body 再序列化，而不只是某一种写法。
// 实测教训（两次收窄都失败）：先写成 `/JSON\.stringify\(\s*req\.body/`，注入
// `JSON.stringify({ raw: req.body })` 没红；改成「fetch 调用那一行里不许有
// JSON.stringify」，把注入挪到上一行**照样**没红 —— 作用域收窄的静态门会被
// 换行绕过。最后落到正确的表述：**整个接缝实现里不该出现 JSON.stringify**。
// 这个模块的职责只有 assertNetAvailable / AbortController / fetch / 记账，
// 它没有任何需要自己序列化东西的理由，所以「一次都不许出现」是站得住的恒真前提。
const reqCode = stripComments(reqSrc)
const stringifySites = [...reqCode.matchAll(/JSON\.stringify/g)].length
eq(stringifySites, 0, 'S6h 整个 request.ts 里 JSON.stringify 出现 0 次（序列化归调用方；实测收窄两次都被换行绕过）')
ok(/req\.body/.test(stripComments(reqSrc)), 'S6i 实现把 req.body 交给 fetch（body 不是声明了却没用）')

// ═══════════════════════════════════════════════════════════════════════════════
// S7. 测试桩的富投影（test-adapters.mjs 的 callProjectRich）
//    —— 依赖 POST 的适配器靠它断言「我发的 body 里 { project } 是对的」
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nS7. 测试桩记录 method / body')

const adaptersSrc = readFileSync(resolve(ROOT, 'scripts/test-adapters.mjs'), 'utf8')
const adaptersCode = stripComments(adaptersSrc)

ok(/function callProjectRich\s*\(/.test(adaptersCode), 'S7a callProjectRich 存在（依赖 POST 的适配器用这个）')
// D3 的核心：既有投影的返回形状必须**只**有原三字段 —— 加键会让既有段全等断言变红
const legacyCall = /function callProject\(([^)]*)\)\s*\{([\s\S]*?)\n\}/.exec(adaptersCode)
ok(legacyCall != null, 'S7b 前置：找得到既有 callProject')
if (legacyCall != null) {
  const keys = [...legacyCall[2].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*[:,]/gm)].map((m) => m[1])
  eq(keys.sort(), ['accept', 'auth', 'url'], 'S7c 既有 callProject 的键仍是 url/auth/accept 三条（一个都没加）')
}
ok(/req\.method\s*\?\?\s*'GET'/.test(adaptersCode), 'S7d 富投影把「不传 method」记成 GET（适配器断言 POST 时不必关心显式与否）')
ok(/req\.body\s*\?\?\s*null/.test(adaptersCode), 'S7e 富投影把「不传 body」记成 null（而不是 undefined 键）')

// S7f/S7g：makeRichRequest 目前**还没有消费者**（留给 Gemini / Antigravity /
// Codex 升级三家的 V/W/Y 段）。未使用的代码最容易悄悄腐烂 —— 三个月后没人知道
// 它记的是哪一版投影、路由还按不按 URL 匹配。所以这两条是它的防锈条款：
// 若哪天决定删掉它，把这两条一并删掉即可（别留着一条永远绿的假护栏）。
const richReq = /function makeRichRequest\(([^)]*)\)\s*\{([\s\S]*?)\n\}/.exec(adaptersCode)
// ⚠ 前置里的长度上限不是随手加的：`[\s\S]*?\n\}` 这个切片靠「函数体收尾的 `}`
// 落在第 0 列」才收得住。一旦哪天有人把这个函数挪进别的作用域（收尾 `}` 带上缩进），
// 切片会一路吞到文件末尾，下面两条就会去检查**别的**函数的 routes.find 然后照绿 ——
// 也就是 spec 里点名的「假护栏」。给一个长度地板，超了就说切片失效了。
ok(richReq != null && richReq[2].length > 0 && richReq[2].length < 1200,
  'S7f 前置：找得到 makeRichRequest，且切片收得住（长度 0 或失控吞到文件末尾时下面的守卫会空洞通过）')
if (richReq != null) {
  ok(/list\.push\(\s*callProjectRich\(\s*req\s*\)\s*\)/.test(richReq[2]),
    'S7f makeRichRequest 记的是**富投影**（callProjectRich），不是既有三字段投影')
  // ⭐ 路由仍**只按 URL 精确匹配**：一旦引入 body 匹配，既有段会因为桩行为
  // 变化而变红，而那正是「纯增量、零影响」这条承诺的破裂点。
  // 实测：只改 makeRichRequest 里的这一行 → 本条红；既有 test-adapters 仍 166 绿
  // （所以这条断言是唯一能看见它的地方）。
  const findLine = /routes\.find\(([^\n]*)\)/.exec(richReq[2])?.[1] ?? null
  ok(findLine != null && /x\.url\s*===\s*req\.url/.test(findLine) && !/body/.test(findLine),
    'S7g makeRichRequest 的路由匹配仍只按 URL（把 body 引进匹配会让既有段变红）')
}

// ═══════════════════════════════════════════════════════════════════════════════
// S8. POST 的错误处理必须与 GET 逐字一致（design.md 的 Validation & Error Matrix）
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nS8. POST 的非 2xx 与超时 —— 与 GET 一样「返回 status/text，由适配器判」')

{
  // 非 2xx **不抛**：fetch 只在网络层失败时 reject，HTTP 状态码由适配器自己判
  // （403 的 SECURITY_POLICY_VIOLATED、400 的 invalid_grant 都要能被适配器分别处理）
  const restore = withFetch(async () => ({
    status: 403,
    ok: false,
    text: async () => '{"error":"SECURITY_POLICY_VIOLATED"}'
  }))
  let res = null
  let threw = null
  try {
    res = await request({ url: 'https://x.test/quota', headers: {}, method: 'POST', body: '{"project":"p"}' })
  } catch (e) {
    threw = e
  } finally {
    restore()
  }
  ok(threw === null, 'S8a POST 返回 403 不抛错（状态码交给适配器判，不是接缝抛）')
  eq(res?.status, 403, 'S8b 原样把 status 交给适配器')
  eq(res?.text, '{"error":"SECURITY_POLICY_VIOLATED"}', 'S8c 原样把响应体交给适配器（区分得了 403 与 400）')
}

{
  // 超时：AbortController 与 method 无关（同一次 fetch 调用），但「POST 也走得到
  // 这条路」值得钉 —— 哪天有人给 POST 单独开一条实现分支，超时会被悄悄丢掉，
  // 而症状是「POST 偶发挂死」，不像超时问题。
  const restore = withFetch(
    (_u, i) =>
      new Promise((_res, rej) => {
        i.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
  )
  let threw = null
  const t0 = Date.now()
  try {
    await request({ url: 'https://x.test/hang', headers: {}, method: 'POST', body: '{"project":"p"}', timeoutMs: 40 })
  } catch (e) {
    threw = e
  } finally {
    restore()
  }
  const elapsed = Date.now() - t0
  ok(threw?.name === 'AbortError', 'S8d POST 挂住时按 timeoutMs 中止（AbortError，记账走 markNetResult(false) 那条 catch）')
  ok(elapsed < 5000, `S8e timeoutMs 被尊重（${elapsed}ms < 5000ms，没退回缺省 12s）`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// 汇总
// ═══════════════════════════════════════════════════════════════════════════════
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)