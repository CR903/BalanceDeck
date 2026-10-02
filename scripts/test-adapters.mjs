// 供应商适配器「黄金样本」—— 第 0 步：冻结旧行为
// 用法：node scripts/test-adapters.mjs
//
// 目的：在把适配器收敛到「协议 + 采集引擎」之前，先把**今天的输出**冻结下来，
// 供一次性切换时机械验证新旧等价（见 docs/adr/0003-one-shot-protocol-cutover.md）。
//
// 本文件不改产品代码：
//   · electron 用 scripts/lib/electron-stub.mjs 替身（adapters/types.ts 已不再依赖它）
//   · 出网用**注入的 request 桩**（CollectContext.request），夹具按产品代码注释与
//     DESIGN.md §4 的实测记录手写 —— 这同时证明了 ADR-0001/0003 说的「接缝可替换」：
//     适配器不需要网络、不需要 electron 就能跑完整链路。
//   · 生产出网实现（src/main/request.ts）的契约在文件末尾 R 节单独验证。
//
// B1 收口后的结构：同一张声明表（adapters/protocols.ts）服务两种实例形态
//   ① 内置预设实例（builtin=true，source=官方接口）
//   ② 自定义实例（builtin=false，source=自定义接口）
// 两者对同一响应必须解析出同一个结果 —— 文件末尾 U 节逐条验证这一点。
// 代码实现的协议（MiniMax / opencode / claude / codex / copilot / qwen / volc）在 M、N 节。
//
// ✅ 身份与来路：声明式协议由工厂显式交给铸造（A~L 节逐条断言）；
//    代码适配器仍靠 collectAll 重盖，那一步在 S 节验证。
// ✅ 收口验收在 U 节：同一响应下内置实例与自定义实例的解析结果必须完全一致。
//    仍未覆盖的是**注册表一侧**：providers.ts / keystore.ts（凭据优先级、
//    buildAdapters 的路由、wrapForInstance 的实例绑定）—— 它们仍与 electron 绑在一起。
//
// ✅ 可信度已收口（ADR-0002）：错误 / 未配置快照不再声明来路（undefined），
//    ok 快照由 officialSnap / localSnap 显式盖章 —— 没有「省略即 official」的写法了。

import { loadTs, ELECTRON_STUB } from './lib/load-ts.mjs'

const alias = { electron: ELECTRON_STUB }

const { PROTOCOLS } = await loadTs('src/main/adapters/protocols.ts')
const { createProtocolAdapter } = await loadTs('src/main/adapters/protocol-adapter.ts')
const { minimaxAdapter } = await loadTs('src/main/adapters/minimax.ts')
const { officialSnap, errSnap: mintErr, identityOf } = await loadTs('src/main/adapters/engine.ts')

let pass = 0
let fail = 0

/**
 * 稳定序列化：对象键排序后再比较。
 * 本套件断言的是「内容」而不是键的插入顺序；同时保持 JSON 的语义 ——
 * 值为 undefined 的键会被省略（所以实现里的 `note: undefined` 不写成字段）。
 */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined)
    return `{${keys.sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'undefined'
}

function eq(actual, expected, label) {
  const a = stable(actual)
  const e = stable(expected)
  if (a === e) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}\n      实际: ${a}\n      期望: ${e}`)
  }
}

// ─── 走查开关：开发者机器上若开着强制离线，本套件会全线失败，先摘掉 ──────────────
delete process.env.BALANCEDECK_FORCE_OFFLINE

const KEY = 'sk-golden'
const NOW = new Date('2026-09-19T02:00:00.000Z')
const AT = NOW.toISOString()
const DS = 'https://api.deepseek.com'
const KIMI = 'https://api.moonshot.cn'
const ZHIPU = 'https://open.bigmodel.cn'
const SF = 'https://api.siliconflow.cn'
const MM = 'https://api.minimaxi.com'

function makeCtx({ key = KEY, extras = {}, request, onKey, onSetKey } = {}) {
  return {
    now: NOW,
    getKey: async (id) => {
      onKey?.(id)
      return key
    },
    getExtra: async (k) => (k in extras ? extras[k] : null),
    setKey: async (id, v) => {
      onSetKey?.(id, v)
    },
    request
  }
}

/**
 * request 桩：按 URL 精确匹配，未覆盖的 URL 直接抛错（避免测试静默走别的分支）。
 * 返回的 list 记录每次调用，用来断言适配器到底请求了什么。
 */
function makeRequest(routes) {
  const list = []
  return {
    list,
    request: async (req) => {
      list.push(callProject(req.url, req.headers ?? {}))
      const r = routes.find((x) => x.url === req.url)
      if (!r) throw new TypeError(`fetch failed（本套件未覆盖的 URL: ${req.url}）`)
      if (r.throw) throw new TypeError(r.throw)
      return { status: r.status ?? 200, text: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) }
    }
  }
}

function callProject(url, headers) {
  return {
    url,
    auth: headers.Authorization ?? headers.authorization ?? null,
    accept: headers.Accept ?? null
  }
}

/**
 * callProject 的「富投影」版：在原三字段之外**多记** method / body / contentType。
 *
 * 为什么要另起一个函数而**不是**给 callProject 加字段：
 * `inst.list` 的元素被 `expect.call` / `expect.calls` 做**全等**比较
 * （check() :196-197）。给 callProject 加键会让既有 A~U 段每一条请求断言变红 ——
 * 那不是「顺手」，是把既有套件的基线改了。既有投影一个字段都不动，
 * 依赖 POST 的适配器（Gemini / Antigravity / Codex 升级）改用这个版本。
 *
 * method 缺省投影成 'GET'：接缝把「不传 method」定义为 GET，适配器断言
 * 「我发的就是 POST」时不该关心调用方有没有显式写出来。
 */
function callProjectRich(req) {
  const headers = req.headers ?? {}
  const ctKey = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type')
  return {
    ...callProject(req.url, headers),
    method: req.method ?? 'GET',
    contentType: ctKey ? headers[ctKey] : null,
    body: req.body ?? null
  }
}

/**
 * 与 makeRequest 行为**完全相同**（同 URL 精确匹配、未覆盖即抛），只是 list 里记的是富投影。
 * ⚠️ 路由仍**只按 url 匹配**：匹配逻辑一旦引入 body，既有段会因桩行为变化而变红。
 *
 * ⚠️ **本函数已有消费者**：Gemini（V 段）是第一个使用者；Antigravity（X 段）/
 * Codex 升级（Y 段）各自在拼 CollectContext 时也用它，而不是复制一遍这段桩。
 * 未使用的代码会腐烂，所以 `scripts/test-seam.mjs` 的 S7f/S7g 钉住了它的两条
 * 不变量（记的是富投影 / 路由仍只按 URL 匹配）。**若将来决定删掉它，
 * 把那两条一并删掉** —— 别留一条永远绿的假护栏。
 */
function makeRichRequest(routes) {
  const list = []
  return {
    list,
    request: async (req) => {
      list.push(callProjectRich(req))
      const r = routes.find((x) => x.url === req.url)
      if (!r) throw new TypeError(`fetch failed（本套件未覆盖的 URL: ${req.url}）`)
      if (r.throw) throw new TypeError(r.throw)
      return { status: r.status ?? 200, text: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) }
    }
  }
}

/** 只冻结「界面与托盘消费得到」的字段；updatedAt 不单列（与 dataAt 同源） */
function project(s) {
  return {
    status: s.status,
    quality: s.dataQuality ?? null,
    kind: s.kind ?? null,
    builtin: s.builtin ?? null,
    mark: s.mark ?? null,
    source: s.source ?? null,
    plan: s.plan ?? null,
    dataAt: s.dataAt ?? null,
    windows: s.windows ?? [],
    detail: s.detail ?? null,
    failureReason: s.failureReason ?? null
  }
}

// snap() 的默认值：kind 恒为 'balance'、builtin 恒为 true、quality 恒为 'official'。
// 期望值一律走这几个构造器，保证字段集完整（漏字段会变成假失败）。
const DEFAULTS = {
  quality: 'official',
  kind: 'balance',
  builtin: true,
  // 适配器层还没有 mark：它由 collectAll 按适配器元数据补给（见 S 节）
  mark: null,
  source: null,
  plan: null,
  dataAt: AT
}
const ok = (body = {}) => ({ status: 'ok', windows: [], detail: null, failureReason: null, ...DEFAULTS, ...body })
/**
 * 某一节（协议 + 实例类型）的期望构造器。
 * 身份（mark/builtin）与 source 都按实例推导 —— 这正是收口后适配器层就该给出的东西；
 * 其余字段由各用例显式写出，不做任何推导。
 */
const expectFor = (protocol, builtin) => ({
  ok: (body = {}) => ok({ mark: protocol, builtin, source: builtin ? '官方接口' : '自定义接口', ...body }),
  err: (detail) => ({ ...err(detail), mark: protocol, builtin }),
  nodata: (detail) => ({ ...nodata(detail), mark: protocol, builtin })
})
/** 错误快照：**两条路径在适配器层完全相同**（自定义路径同样自称 builtin=true，见文末缺陷） */
const err = (detail) => ({
  status: 'error',
  mark: null,
  quality: null, // ADR-0002：错误快照没有可声明的来路，不再默认 official
  kind: 'balance',
  builtin: true,
  source: null,
  plan: null,
  dataAt: AT,
  windows: [],
  detail,
  failureReason: detail
})
/** 未配置快照（nodata 没有 failureReason） */
const nodata = (detail) => ({
  status: 'nodata',
  mark: null,
  quality: null,
  kind: 'balance',
  builtin: true,
  source: null,
  plan: null,
  dataAt: AT,
  windows: [],
  detail,
  failureReason: null
})

async function check(label, { adapter, key = KEY, extras = {}, routes, expect }) {
  const inst = makeRequest(routes)
  const keyIds = []
  const snap = await adapter.collect(
    makeCtx({ key, extras, request: inst.request, onKey: (id) => keyIds.push(id) })
  )
  eq(project(snap), expect.snap, label)
  if (expect.call) eq(inst.list, [expect.call], `${label} · 请求`)
  if (expect.calls) eq(inst.list, expect.calls, `${label} · 请求序列`)
  if (expect.keyIds) eq(keyIds, expect.keyIds, `${label} · 凭据查询 id`)
  return snap
}

/** 内置预设实例：presetId = 预设 id（迁移时 id 沿用预设 id），baseUrl 取协议默认 */
const instBuiltin = (protocol, over = {}) => ({
  id: protocol,
  name: protocol,
  presetId: protocol,
  protocol,
  kind: PROTOCOLS[protocol].kind,
  baseUrl: PROTOCOLS[protocol].defaultBaseUrl,
  builtin: true,
  enabled: true,
  createdAt: AT,
  ...over
})
/** 自定义实例：presetId 空串 = 自定义 */
const instCustom = (protocol, over = {}) => ({
  id: `inst-${protocol}`,
  name: `${protocol} 自定义`,
  presetId: '',
  protocol,
  kind: PROTOCOLS[protocol].kind,
  baseUrl: PROTOCOLS[protocol].defaultBaseUrl,
  builtin: false,
  enabled: true,
  createdAt: AT,
  ...over
})
/** 声明式适配器：内置实例 / 自定义实例走的是同一个工厂 */
const builtinOf = (protocol, over) => createProtocolAdapter(PROTOCOLS[protocol], instBuiltin(protocol, over))
const customOf = (protocol, over) => createProtocolAdapter(PROTOCOLS[protocol], instCustom(protocol, over))

// ═══════════════════════════════════════════════════════════════════════════════
// A. DeepSeek · 内置适配器
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nA. DeepSeek · 内置实例（声明表 protocol=deepseek）')
const EA = expectFor('deepseek', true)


const DS_BODY = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '88.50', granted_balance: '10.00', topped_up_balance: '78.50' }]
}
const DS_ROUTE = { url: `${DS}/user/balance`, body: DS_BODY }
const DS_CALL = { url: `${DS}/user/balance`, auth: `Bearer ${KEY}`, accept: 'application/json' }
const DS_WINDOW = { name: '账户余额', used: 88.5, unit: 'cny', note: '赠送余额 ¥10.00' }
const DS_AUTH_OFFICIAL =
  '此 key 在官方 api.deepseek.com 无效：请到 platform.deepseek.com 重新生成完整 key（sk- 开头）；若使用中转/聚合平台，请在设置的 Base URL 中填写平台地址'
const DS_AUTH_MIRROR = '鉴权失败（401）：请核对该平台的 Key 与 Base URL'
const KIMI_AUTH_OFFICIAL =
  '鉴权失败（401）：此 key 在官方 api.moonshot.cn 无效；若使用中转平台，请在设置的 Base URL 中填写平台地址'

const dsBuiltin = await check('A1 正常响应：余额 + 赠送余额说明', {
  adapter: builtinOf('deepseek'),
  routes: [DS_ROUTE],
  expect: { snap: EA.ok({ source: '官方接口',  windows: [DS_WINDOW] }), call: DS_CALL }
})

await check('A2 is_available=false：追加「账户不可用」', {
  adapter: builtinOf('deepseek'),
  routes: [{ url: `${DS}/user/balance`, body: { ...DS_BODY, is_available: false } }],
  expect: { snap: EA.ok({ source: '官方接口',  windows: [{ ...DS_WINDOW, note: '赠送余额 ¥10.00 · 账户不可用' }] }) }
})

const ds401 = await check('A3 401（官方域名）：点名 platform.deepseek.com 与中转站指引', {
  adapter: builtinOf('deepseek'),
  routes: [{ url: `${DS}/user/balance`, status: 401, body: { error: 'unauthorized' } }],
  expect: {
    snap: EA.err(
      '此 key 在官方 api.deepseek.com 无效：请到 platform.deepseek.com 重新生成完整 key（sk- 开头）；若使用中转/聚合平台，请在设置的 Base URL 中填写平台地址'
    )
  }
})

await check('A4 401（中转 Base URL）：给平台核对指引，而不是官方公告', {
  adapter: builtinOf('deepseek', { baseUrl: 'https://mirror.example.com' }),
  routes: [{ url: 'https://mirror.example.com/user/balance', status: 401, body: {} }],
  expect: { snap: EA.err('鉴权失败（401）：请核对该平台的 Key 与 Base URL') }
})

await check('A5 HTTP 500', {
  adapter: builtinOf('deepseek'),
  routes: [{ url: `${DS}/user/balance`, status: 500, body: {} }],
  expect: { snap: EA.err('HTTP 500') }
})

await check('A6 响应格式未识别（缺 total_balance）', {
  adapter: builtinOf('deepseek'),
  routes: [{ url: `${DS}/user/balance`, body: { balance_infos: [{ currency: 'CNY' }] } }],
  expect: { snap: EA.err('响应格式未识别') }
})

await check('A7 网络类错误：包成「请求失败:」', {
  adapter: builtinOf('deepseek'),
  routes: [{ url: `${DS}/user/balance`, throw: 'fetch failed' }],
  expect: { snap: EA.err('请求失败: fetch failed') }
})

const dsNoKey = await check('A8 未配置 key：nodata 且点名环境变量', {
  adapter: builtinOf('deepseek'),
  key: null,
  routes: [],
  expect: { snap: EA.nodata('未配置 API Key（可在设置中填写或设 DEEPSEEK_API_KEY）'), calls: [] }
})

await check('A9 Base URL 结尾斜杠容错', {
  adapter: builtinOf('deepseek', { baseUrl: `${DS}/` }),
  routes: [DS_ROUTE],
  expect: { snap: EA.ok({ source: '官方接口',  windows: [DS_WINDOW] }), call: DS_CALL }
})

// ═══════════════════════════════════════════════════════════════════════════════
// B. DeepSeek · 自定义协议（厂商协议 id 也是 'deepseek'）
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nB. DeepSeek · 自定义实例（同一张声明表）')
const EB = expectFor('deepseek', false)


const dsCustom = customOf('deepseek')

const b1 = await check('B1 同一响应：说明文案是「官方接口」，没有赠送余额', {
  adapter: dsCustom,
  routes: [DS_ROUTE],
  expect: { snap: EB.ok({ windows: [DS_WINDOW] }), call: DS_CALL }
})

const b2 = await check('B2 401：自定义路径的通用文案', {
  adapter: dsCustom,
  routes: [{ url: `${DS}/user/balance`, status: 401, body: {} }],
  expect: { snap: EB.err(DS_AUTH_OFFICIAL) }
})

await check('B3 404：自定义路径独有', {
  adapter: dsCustom,
  routes: [{ url: `${DS}/user/balance`, status: 404, body: {} }],
  expect: { snap: EB.err('端点不存在（HTTP 404）：请核对该供应商的协议与 API 地址') }
})

await check('B4 HTTP 500', {
  adapter: dsCustom,
  routes: [{ url: `${DS}/user/balance`, status: 500, body: {} }],
  expect: { snap: EB.err('HTTP 500') }
})

await check('B5 响应格式未识别：附带响应预览', {
  adapter: dsCustom,
  routes: [{ url: `${DS}/user/balance`, body: { balance_infos: [{ currency: 'CNY' }] } }],
  expect: { snap: EB.err('响应格式未识别') }
})

const b6 = await check('B6 未配置 key', {
  adapter: dsCustom,
  key: null,
  routes: [],
  expect: { snap: EB.nodata('未配置 API Key（在设置中编辑该供应商）'), calls: [] }
})

// 只有 generic 允许空地址（其余协议的 defaultBaseUrl 兜底），故这条独立于 B 节的 deepseek 构造器
const E_GENERIC = expectFor('generic', false)
await check('B7 未配置 API 地址（generic 无默认地址）', {
  adapter: customOf('generic', { baseUrl: '' }),
  routes: [],
  expect: { snap: E_GENERIC.err('未配置 API 地址（在设置中编辑该供应商）'), calls: [] }
})

// ═══════════════════════════════════════════════════════════════════════════════
// C. Kimi (Moonshot) · 内置
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nC. Kimi / Moonshot · 内置实例（protocol=moonshot）')
const EC = expectFor('moonshot', true)


const KIMI_BODY = { code: 0, data: { available_balance: '42.10', voucher_balance: '5.00', total_balance: '47.10' } }
const KIMI_PATH = `${KIMI}/v1/users/me/balance`
const KIMI_CALL = { url: KIMI_PATH, auth: `Bearer ${KEY}`, accept: 'application/json' }
const KIMI_WINDOW = { name: '账户余额', used: 42.1, unit: 'cny', note: '代金券 ¥5.00' }

const kimiBuiltin = await check('C1 正常响应：可用余额 + 代金券说明', {
  adapter: builtinOf('moonshot'),
  routes: [{ url: KIMI_PATH, body: KIMI_BODY }],
  expect: { snap: EC.ok({ source: '官方接口',  windows: [KIMI_WINDOW] }), call: KIMI_CALL }
})

await check('C2 无代金券：note 整个字段省略（不是空串）', {
  adapter: builtinOf('moonshot'),
  routes: [{ url: KIMI_PATH, body: { data: { available_balance: '42.10', voucher_balance: '0' } } }],
  expect: { snap: EC.ok({ source: '官方接口',  windows: [{ name: '账户余额', used: 42.1, unit: 'cny' }] }) }
})

await check('C3 401（官方域名）', {
  adapter: builtinOf('moonshot'),
  routes: [{ url: KIMI_PATH, status: 401, body: {} }],
  expect: {
    snap: EC.err('鉴权失败（401）：此 key 在官方 api.moonshot.cn 无效；若使用中转平台，请在设置的 Base URL 中填写平台地址')
  }
})

await check('C4 401（中转 Base URL）', {
  adapter: builtinOf('moonshot', { baseUrl: 'https://mirror.example.com' }),
  routes: [{ url: 'https://mirror.example.com/v1/users/me/balance', status: 401, body: {} }],
  expect: { snap: EC.err('鉴权失败（401）：请核对该平台的 Key 与 Base URL') }
})

await check('C5 响应格式未识别', {
  adapter: builtinOf('moonshot'),
  routes: [{ url: KIMI_PATH, body: { data: {} } }],
  expect: { snap: EC.err('响应格式未识别') }
})

await check('C6 未配置 key：点名 MOONSHOT_API_KEY', {
  adapter: builtinOf('moonshot'),
  key: null,
  routes: [],
  expect: { snap: EC.nodata('未配置 API Key（可在设置中填写或设 MOONSHOT_API_KEY）'), calls: [] }
})

// ═══════════════════════════════════════════════════════════════════════════════
// D. Moonshot · 自定义协议
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nD. Moonshot · 自定义实例')
const ED = expectFor('moonshot', false)


const moonshotCustom = customOf('moonshot')

const d1 = await check('D1 同一响应：解析与说明文案都与内置一致', {
  adapter: moonshotCustom,
  routes: [{ url: KIMI_PATH, body: KIMI_BODY }],
  expect: { snap: ED.ok({ windows: [KIMI_WINDOW] }), call: KIMI_CALL }
})

await check('D2 401（官方域名）：收口后用 moonshot 自己的文案', {
  adapter: moonshotCustom,
  routes: [{ url: KIMI_PATH, status: 401, body: {} }],
  expect: { snap: ED.err(KIMI_AUTH_OFFICIAL) }
})

// ═══════════════════════════════════════════════════════════════════════════════
// ED. 智谱 GLM · 内置
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nE. 智谱 GLM · 内置实例（protocol=zhipu）')
const EE = expectFor('zhipu', true)


const ZHIPU_PATH = `${ZHIPU}/api/paas/v4/users/me/balance`
const ZHIPU_CALL = { url: ZHIPU_PATH, auth: `Bearer ${KEY}`, accept: 'application/json' }
const ZHIPU_BODY = { code: 200, data: { total_balance: '66.60' } }

const zhipuBuiltin = await check('E1 正常响应：宽容解析 total_balance + 社区验证说明', {
  adapter: builtinOf('zhipu'),
  routes: [{ url: ZHIPU_PATH, body: ZHIPU_BODY }],
  expect: {
    snap: EE.ok({ source: '官方接口',  windows: [{ name: '账户余额', used: 66.6, unit: 'cny', note: '端点为社区验证版本' }] }),
    call: ZHIPU_CALL
  }
})

await check('E2 401', {
  adapter: builtinOf('zhipu'),
  routes: [{ url: ZHIPU_PATH, status: 401, body: {} }],
  expect: { snap: EE.err('鉴权失败（401）：API Key 无效') }
})

await check('E3 响应格式未识别：附带响应预览', {
  adapter: builtinOf('zhipu'),
  routes: [{ url: ZHIPU_PATH, body: { code: 200, data: {} } }],
  expect: { snap: EE.err(`响应格式未识别：${JSON.stringify({ code: 200, data: {} }).slice(0, 160)}`) }
})

await check('E4 未配置 key：点名 ZHIPUAI_API_KEY', {
  adapter: builtinOf('zhipu'),
  key: null,
  routes: [],
  expect: { snap: EE.nodata('未配置 API Key（可在设置中填写或设 ZHIPUAI_API_KEY）'), calls: [] }
})

// 优先级探针：内置 CANDIDATE_KEYS 把 'balance' 排在 'total_balance' 前面
const ZHIPU_BOTH = { code: 200, data: { balance: '11.11', total_balance: '99.99' } }
const zhipuBothBuiltin = await check('E5 双字段探针：内置取 balance（11.11）', {
  adapter: builtinOf('zhipu'),
  routes: [{ url: ZHIPU_PATH, body: ZHIPU_BOTH }],
  expect: { snap: EE.ok({ source: '官方接口',  windows: [{ name: '账户余额', used: 11.11, unit: 'cny', note: '端点为社区验证版本' }] }) }
})

// ═══════════════════════════════════════════════════════════════════════════════
// F. 智谱 GLM · 自定义协议
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nF. 智谱 GLM · 自定义实例')
const EF = expectFor('zhipu', false)


const zhipuCustom = customOf('zhipu')

const f1 = await check('F1 同一响应：说明文案是「官方接口」', {
  adapter: zhipuCustom,
  routes: [{ url: ZHIPU_PATH, body: ZHIPU_BODY }],
  expect: {
    snap: EF.ok({ windows: [{ name: '账户余额', used: 66.6, unit: 'cny', note: '端点为社区验证版本' }] }),
    call: ZHIPU_CALL
  }
})

const f2 = await check('F2 双字段探针：收口后与内置取同一个数（balance → 11.11）', {
  adapter: zhipuCustom,
  routes: [{ url: ZHIPU_PATH, body: ZHIPU_BOTH }],
  expect: {
    snap: EF.ok({ windows: [{ name: '账户余额', used: 11.11, unit: 'cny', note: '端点为社区验证版本' }] })
  }
})

await check('F3 401：自定义路径的通用文案', {
  adapter: zhipuCustom,
  routes: [{ url: ZHIPU_PATH, status: 401, body: {} }],
  expect: { snap: EF.err('鉴权失败（HTTP 401）：请核对该供应商的 Key 与 API 地址') }
})

// ═══════════════════════════════════════════════════════════════════════════════
// G / H. 硅基流动
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nG. 硅基流动 · 内置实例（protocol=siliconflow）')
const EG = expectFor('siliconflow', true)


const SF_PATH = `${SF}/v1/user/info`
const SF_CALL = { url: SF_PATH, auth: `Bearer ${KEY}`, accept: 'application/json' }
const SF_BODY = { code: 200, data: { chargeBalance: '7.00', totalBalance: '120.50' } }
const SF_WINDOW = { name: '账户余额', used: 120.5, unit: 'cny', note: '官方接口' }

const sfBuiltin = await check('G1 正常响应：优先 totalBalance', {
  adapter: builtinOf('siliconflow'),
  routes: [{ url: SF_PATH, body: SF_BODY }],
  expect: { snap: EG.ok({ source: '官方接口',  windows: [SF_WINDOW] }), call: SF_CALL }
})

await check('G2 401', {
  adapter: builtinOf('siliconflow'),
  routes: [{ url: SF_PATH, status: 401, body: {} }],
  expect: { snap: EG.err('鉴权失败（401）：API Key 无效') }
})

await check('G3 响应格式未识别：附带响应预览', {
  adapter: builtinOf('siliconflow'),
  routes: [{ url: SF_PATH, body: { data: {} } }],
  expect: { snap: EG.err(`响应格式未识别：${JSON.stringify({ data: {} }).slice(0, 160)}`) }
})

console.log('\nH. 硅基流动 · 自定义实例')
const EH = expectFor('siliconflow', false)


const sfCustom = customOf('siliconflow')

const h1 = await check('H1 同一响应：与内置一致', {
  adapter: sfCustom,
  routes: [{ url: SF_PATH, body: SF_BODY }],
  expect: { snap: EH.ok({ windows: [SF_WINDOW] }), call: SF_CALL }
})

// ═══════════════════════════════════════════════════════════════════════════════
// I ~ L. 只在自定义协议里存在的四家
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nI. SiliconFlow 国际（protocol=siliconflow-intl）')
const EI = expectFor('siliconflow-intl', false)


await check('I1 无 currency 字段时按协议回落 USD', {
  adapter: customOf('siliconflow-intl'),
  routes: [{ url: 'https://api.siliconflow.com/v1/user/info', body: { data: { totalBalance: '30.00' } } }],
  expect: { snap: EI.ok({ windows: [{ name: '账户余额', used: 30, unit: 'usd', note: '官方接口' }] }) }
})

console.log('\nJ. OpenRouter（protocol=openrouter）')
const EJ = expectFor('openrouter', false)


await check('J1 额度减已用（total_credits - total_usage）', {
  adapter: customOf('openrouter'),
  routes: [{ url: 'https://openrouter.ai/api/v1/credits', body: { data: { total_credits: 50, total_usage: 12.5 } } }],
  expect: { snap: EJ.ok({ windows: [{ name: '账户余额', used: 37.5, unit: 'usd', note: '官方接口' }] }) }
})

console.log('\nK. OpenAI 计费（protocol=openai-billing）')
const EK = expectFor('openai-billing', false)


await check('K1 返回的是额度而非余额：used=0、limit=hard_limit_usd', {
  adapter: customOf('openai-billing'),
  routes: [{ url: 'https://api.openai.com/v1/dashboard/billing/subscription', body: { hard_limit_usd: 120 } }],
  expect: {
    snap: EK.ok({
      windows: [{ name: '账户额度', used: 0, limit: 120, unit: 'usd', note: '官方计费接口（不含已用量）' }]
    })
  }
})

console.log('\nL. 通用 JSON（protocol=generic）')
const EL = expectFor('generic', false)


await check('L1 用完整 URL，说明文案是「自定义接口」', {
  adapter: customOf('generic', { baseUrl: 'https://api.example.com/custom/balance' }),
  routes: [{ url: 'https://api.example.com/custom/balance', body: { data: { balance: '12.00', currency: 'CNY' } } }],
  expect: { snap: EL.ok({ windows: [{ name: '账户余额', used: 12, unit: 'cny', note: '自定义接口' }] }) }
})

// ═══════════════════════════════════════════════════════════════════════════════
// M. MiniMax · 内置（含旧平台备用端点）
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nM. MiniMax · 代码适配器（src/main/adapters/minimax.ts）')

// 代码适配器（基座）自己声明 kind/builtin，但**不声明 mark**：mark 是实例派生的，
// 由实例绑定层补（见 N 节）。这正是「身份必填」之后代码适配器该有的样子。
const EM = {
  ok: (body = {}) => ok({ kind: 'token', mark: null, ...body }),
  err: (detail) => ({ ...err(detail), kind: 'token', mark: null })
}

const MM_PATH = `${MM}/v1/token_plan/remains`
const MM_CALL = { url: MM_PATH, auth: `Bearer ${KEY}`, accept: 'application/json' }
const MM_BODY = { base_resp: { status_code: 0 }, total: 100, remain: 40 }
const MM_WINDOW = { name: 'Token Plan', used: 60, limit: 100, unit: 'request', note: '剩余 40' }

const mmBuiltin = await check('M1 主路径：total/remain → Token Plan 窗口 + plan 字段', {
  adapter: minimaxAdapter,
  extras: { 'baseUrl:minimax': MM },
  routes: [{ url: MM_PATH, body: MM_BODY }],
  expect: { snap: EM.ok({ plan: 'Token Plan', windows: [MM_WINDOW] }), call: MM_CALL }
})

await check('M2 401', {
  adapter: minimaxAdapter,
  extras: { 'baseUrl:minimax': MM },
  routes: [{ url: MM_PATH, status: 401, body: {} }],
  expect: { snap: EM.err('鉴权失败（401）：API Key 无效') }
})

await check('M3 主路径只给金额 → 余额窗口（无说明、无 plan）', {
  adapter: minimaxAdapter,
  extras: { 'baseUrl:minimax': MM },
  routes: [{ url: MM_PATH, body: { base_resp: { status_code: 0 }, money: '8.80' } }],
  expect: { snap: EM.ok({ windows: [{ name: '账户余额', used: 8.8, unit: 'cny' }] }) }
})

await check('M4 主路径无数据 + 有 groupId → 回落旧接口（两次请求）', {
  adapter: minimaxAdapter,
  extras: { 'baseUrl:minimax': MM, minimaxGroupId: 'g-1' },
  routes: [
    { url: MM_PATH, body: { base_resp: { status_code: 1, status_msg: 'no plan' } } },
    { url: `${MM}/v1/query_balance?group=g-1`, body: { money: '3.30' } }
  ],
  expect: {
    snap: EM.ok({ windows: [{ name: '账户余额', used: 3.3, unit: 'cny', note: '旧接口 query_balance' }] }),
    calls: [MM_CALL, { url: `${MM}/v1/query_balance?group=g-1`, auth: `Bearer ${KEY}`, accept: 'application/json' }]
  }
})

await check('M5 主路径无数据且无 groupId → 直接报错', {
  adapter: minimaxAdapter,
  extras: { 'baseUrl:minimax': MM },
  routes: [{ url: MM_PATH, body: { base_resp: { status_code: 1, status_msg: 'no plan' } } }],
  expect: { snap: EM.err('Token Plan 接口无可用数据') }
})

// ═══════════════════════════════════════════════════════════════════════════════
// N. 实例绑定（adapters/bind-instance.ts）与声明表边界
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nN. 实例绑定与声明表边界')

const { bindInstance } = await loadTs('src/main/adapters/bind-instance.ts')
const { opencodeAdapter } = await loadTs('src/main/adapters/opencode.ts')

/** 代码协议的实例（这些协议不在声明表里，实例字面量手写） */
const codeInst = (over) => ({
  id: 'inst-code',
  name: '代码协议实例',
  presetId: '',
  protocol: 'minimax',
  kind: 'token',
  baseUrl: MM,
  builtin: false,
  enabled: true,
  createdAt: AT,
  ...over
})

// N1：适配器字段上的身份（mark 是实例派生的：内置用预设 id、自定义用协议 id）
const ocBound = bindInstance(opencodeAdapter, codeInst({
  id: 'opencode', name: 'OpenCode Go', presetId: 'opencode', protocol: 'opencode-go',
  kind: 'coding', baseUrl: 'https://opencode.ai', builtin: true
}))
eq(
  { id: ocBound.id, name: ocBound.name, kind: ocBound.kind, builtin: ocBound.builtin, mark: ocBound.mark },
  { id: 'opencode', name: 'OpenCode Go', kind: 'coding', builtin: true, mark: 'opencode' },
  'N1 内置实例：mark = 预设 id（opencode），不是协议 id（opencode-go）'
)

// N2：快照身份也换成实例的；N3：凭据查询被重定向到实例 id
const mmBound = bindInstance(minimaxAdapter, codeInst({ id: 'inst-mm', name: '自定义 MiniMax' }))
const n2 = await check('N2 绑定后快照的 kind/builtin/mark 都是实例的', {
  adapter: mmBound,
  routes: [{ url: MM_PATH, body: MM_BODY }],
  expect: {
    snap: EM.ok({ builtin: false, mark: 'minimax', plan: 'Token Plan', windows: [MM_WINDOW] }),
    call: MM_CALL,
    keyIds: ['inst-mm']
  }
})
// project() 只投影界面消费的字段，id/name 单独断言
eq({ id: n2.id, name: n2.name }, { id: 'inst-mm', name: '自定义 MiniMax' }, 'N2b 快照的 id/name 也换成实例身份')

// N4：setKey 必须透传 —— 基座回写凭据（cookie 自愈）依赖它
let wrote = null
const probeBase = {
  id: 'probe',
  name: 'Probe',
  kind: 'balance',
  builtin: true,
  collect: async (c) => {
    await c.setKey?.('probe', 'v')
    return officialSnap(identityOf(probeBase), c)
  }
}
const probeBound = bindInstance(probeBase, codeInst({ id: 'inst-p', protocol: 'probe' }))
await probeBound.collect(
  makeCtx({
    request: async () => ({ status: 200, text: '{}' }),
    onSetKey: (id, v) => (wrote = `${id}=${v}`)
  })
)
eq(wrote, 'probe=v', 'N4 setKey 透传：基座回写凭据能到达外层（旧实现漏了这一项，cookie 自愈失效）')

// N3b：opencodeKeys 特例 —— 通用绑定步骤里躺着一家供应商的私有键名（报告 C7/F8 记的就是它）。
// 断言它现在至少**被覆盖**：基座请求该键时，实例 key 被包装成单元素 JSON 数组。
let multiKeySeen = null
const multiKeyBase = {
  id: 'multi',
  name: 'Multi',
  kind: 'coding',
  builtin: true,
  collect: async (c) => {
    multiKeySeen = await c.getKey('opencodeKeys')
    return officialSnap(identityOf(multiKeyBase), c)
  }
}
await bindInstance(multiKeyBase, codeInst({ id: 'inst-oc', protocol: 'opencode-go' })).collect(
  makeCtx({ key: 'sk-own-key', request: async () => ({ status: 200, text: '{}' }) })
)
eq(multiKeySeen, '["sk-own-key"]', 'N3b opencodeKeys 特例：实例 key 被包装成单元素数组（多账号协议）')

// N5~N7：声明表边界 —— MiniMax 为什么留在代码侧
eq(PROTOCOLS.minimax, undefined, 'N5 MiniMax 不在声明表里（旧平台备用端点与 base_resp 无法声明）')
eq(typeof minimaxAdapter.collect, 'function', 'N6 MiniMax 仍由代码适配器实现（M 节验证其行为）')
eq(
  Object.keys(PROTOCOLS).length,
  8,
  'N7 声明表恰好 8 条：deepseek / moonshot / zhipu / siliconflow / siliconflow-intl / openrouter / openai-billing / generic'
)

// ═══════════════════════════════════════════════════════════════════════════════
// T. 存储与注册表（store.ts + providers.ts + buildAdapters 路由）
//    —— 这一块此前完全在回归网之外：keystore 绑着 electron，providers 又绑着 keystore
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nT. 存储、注册表与路由')

const { createStore } = await loadTs('src/main/store.ts')
const providers = await loadTs('src/main/providers.ts')
const { buildAdapters } = await loadTs('src/main/adapters/index.ts')

const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join: joinPath } = await import('node:path')

const tmp = mkdtempSync(joinPath(tmpdir(), 'bd-store-'))
/** 假加密：可逆的标记前缀，用来验证「磁盘上不出现明文」 */
const sealedCrypto = {
  available: () => true,
  encrypt: (plain) => 'SEALED:' + Buffer.from(plain, 'utf-8').toString('base64'),
  decrypt: (b64) => Buffer.from(b64.replace(/^SEALED:/, ''), 'base64').toString('utf-8')
}
const plainCrypto = { available: () => false, encrypt: () => '', decrypt: () => '' }

// ── 存储：往返与磁盘格式（version 1 与旧实现逐字兼容）──
const fileA = joinPath(tmp, 'secrets.bin')
const storeA = createStore({ filePath: () => fileA, crypto: sealedCrypto })
await storeA.setKey('deepseek', 'sk-secret-value')
eq(await storeA.getKey('deepseek'), 'sk-secret-value', 'T1 密文写入后能读回明文')
await storeA.setExtra('minimaxGroupId', 'g-42')
eq(await storeA.getExtra('minimaxGroupId'), 'g-42', 'T2 非敏感附加项明文往返')
{
  const raw = JSON.parse(readFileSync(fileA, 'utf-8'))
  eq(raw.version, 1, 'T3 磁盘格式版本为 1')
  eq(raw.extras.minimaxGroupId, 'g-42', 'T3b extras 明文存放')
  eq(readFileSync(fileA, 'utf-8').includes('sk-secret-value'), false, 'T3c 磁盘上不出现明文凭据')
}
await storeA.setKey('deepseek', '')
eq(await storeA.getKey('deepseek'), null, 'T4 写空串 = 删除该凭据')

const fileB = joinPath(tmp, 'fallback.bin')
const storeB = createStore({ filePath: () => fileB, crypto: plainCrypto })
await storeB.setKey('kimi', 'sk-fallback')
eq(await storeB.getKey('kimi'), 'sk-fallback', 'T5 加密不可用时走 plain: 兜底且仍能读回')
eq(readFileSync(fileB, 'utf-8').includes('plain:'), true, 'T5b 兜底条目带 plain: 前缀（便于识别）')

const fileC = joinPath(tmp, 'broken.bin')
writeFileSync(fileC, '{ 这不是 JSON', 'utf-8')
eq(
  await createStore({ filePath: () => fileC, crypto: sealedCrypto }).getExtra('anything'),
  null,
  'T6 文件损坏时重建为空而不是抛错'
)
writeFileSync(fileC, JSON.stringify({ version: 99, items: {} }), 'utf-8')
eq(
  await createStore({ filePath: () => fileC, crypto: sealedCrypto }).getKey('x'),
  null,
  'T6b 版本不符同样重建'
)

await storeA.setKey('zhipu', 'sk-restart')
eq(
  await createStore({ filePath: () => fileA, crypto: sealedCrypto }).getKey('zhipu'),
  'sk-restart',
  'T7 重新打开（模拟重启）后凭据仍在'
)

// ── 注册表：实例 CRUD ──
const regStore = createStore({ filePath: () => joinPath(tmp, 'registry.bin'), crypto: sealedCrypto })
providers.configureProviders(regStore)
// 显式写空表：否则会触发旧模型迁移，而迁移会探测真机文件（opencode auth.json / db）
await regStore.setExtra('providerInstances', '[]')

const ds1 = await providers.addInstance({ presetId: 'deepseek' })
eq(
  { presetId: ds1.presetId, protocol: ds1.protocol, kind: ds1.kind, builtin: ds1.builtin, baseUrl: ds1.baseUrl },
  { presetId: 'deepseek', protocol: 'deepseek', kind: 'balance', builtin: true, baseUrl: 'https://api.deepseek.com' },
  'T8 添加内置预设实例：身份与默认地址来自预设'
)
const ds2 = await providers.addInstance({ presetId: 'deepseek' })
eq(ds2.id !== ds1.id && ds2.presetId === 'deepseek', true, 'T9 同一预设可重复添加（各自 id、各自凭据）')

const customInst = await providers.addInstance({
  protocol: 'generic',
  name: '我的中转',
  baseUrl: 'https://x.test/v1/balance'
})
eq(
  {
    presetId: customInst.presetId,
    protocol: customInst.protocol,
    builtin: customInst.builtin,
    name: customInst.name,
    baseUrl: customInst.baseUrl
  },
  { presetId: '', protocol: 'generic', builtin: false, name: '我的中转', baseUrl: 'https://x.test/v1/balance' },
  'T10 添加自定义实例：presetId 空、builtin false'
)

const claudeInst = await providers.addInstance({ presetId: 'claude' })
const catalog = await providers.listCatalog()
eq(catalog.some((c) => c.key === 'preset:claude'), false, 'T11 已添加的 singleton 预设从目录消失')
eq(catalog.some((c) => c.key === 'preset:deepseek'), true, 'T11b 非 singleton 预设仍在目录里（可再加一条）')
eq(catalog.filter((c) => c.presetId === null).length, 9, 'T12 自定义协议目录 9 条（8 声明 + MiniMax）')

// ── 凭据来源优先级：saved > env > file > none ──
await regStore.setKey(ds1.id, 'sk-saved')
eq((await providers.instanceInfo(ds1)).credentialSource, 'saved', 'T13 设置里存了凭据 → saved')
const kimiInst = await providers.addInstance({ presetId: 'kimi' })
process.env.MOONSHOT_API_KEY = 'sk-from-env'
eq((await providers.instanceInfo(kimiInst)).credentialSource, 'env', 'T13b 其次环境变量 → env')
delete process.env.MOONSHOT_API_KEY
eq((await providers.instanceInfo(kimiInst)).credentialSource, 'none', 'T13c 都没有 → none')
eq((await providers.instanceInfo(claudeInst)).credentialSource, 'file', 'T13d 本机文件型数据源 → file')

// ── 排序与删除 ──
await providers.reorderInstances([customInst.id, ds1.id])
eq(
  (await providers.listInstances()).map((i) => i.id).slice(0, 2),
  [customInst.id, ds1.id],
  'T14 拖拽排序：顺序即优先级'
)
await regStore.setExtra(`provider:${ds1.id}:baseUrl`, 'https://old.test')
await providers.removeInstance(ds1.id)
eq(await regStore.getKey(ds1.id), null, 'T15 删除实例时连同凭据一起清掉')
eq(await regStore.getExtra(`provider:${ds1.id}:baseUrl`), null, 'T15b 连同该实例的 extras 一起清掉')
eq((await providers.listInstances()).some((i) => i.id === ds1.id), false, 'T15c 实例从注册表移除')

// ── 路由：声明表 → 协议工厂；否则 → 代码适配器；都没有 → 通用兜底 ──
const routeInst = (over) => ({
  presetId: '',
  kind: 'balance',
  baseUrl: '',
  builtin: false,
  enabled: true,
  createdAt: AT,
  ...over
})
const built = buildAdapters([
  routeInst({ id: 'i-ds', name: 'DeepSeek', presetId: 'deepseek', protocol: 'deepseek', builtin: true, baseUrl: DS }),
  routeInst({ id: 'i-mm', name: 'MiniMax', presetId: 'minimax', protocol: 'minimax', kind: 'token', builtin: true, baseUrl: MM }),
  routeInst({ id: 'i-mm2', name: '自定义 MiniMax', protocol: 'minimax', kind: 'token', baseUrl: MM }),
  routeInst({ id: 'i-odd', name: '未知协议', protocol: 'something-else', baseUrl: 'https://odd.test' }),
  routeInst({ id: 'i-off', name: '禁用的', presetId: 'deepseek', protocol: 'deepseek', builtin: true, baseUrl: DS, enabled: false })
])
eq(built.map((a) => a.id), ['i-ds', 'i-mm', 'i-mm2', 'i-odd'], 'T16 禁用实例被跳过，顺序与注册表一致')
eq(
  built.map((a) => ({ id: a.id, kind: a.kind, builtin: a.builtin, mark: a.mark })),
  [
    { id: 'i-ds', kind: 'balance', builtin: true, mark: 'deepseek' },
    { id: 'i-mm', kind: 'token', builtin: true, mark: 'minimax' },
    { id: 'i-mm2', kind: 'token', builtin: false, mark: 'minimax' },
    { id: 'i-odd', kind: 'balance', builtin: false, mark: 'something-else' }
  ],
  'T17 路由只按协议决定（声明表 / 代码适配器 / 通用兜底）'
)

await check('T18 声明式实例走协议工厂（source 按实例身份）', {
  adapter: built[0],
  routes: [{ url: `${DS}/user/balance`, body: DS_BODY }],
  expect: { snap: EA.ok({ windows: [DS_WINDOW] }), call: DS_CALL }
})
await check('T19 代码协议实例走实例绑定（mark 取预设 id、source 留空）', {
  adapter: built[1],
  routes: [{ url: MM_PATH, body: MM_BODY }],
  expect: { snap: EM.ok({ mark: 'minimax', plan: 'Token Plan', windows: [MM_WINDOW] }), call: MM_CALL }
})
await check('T20 未知协议 → 通用宽容解析兜底（与旧 custom.ts 的 switch 默认分支一致）', {
  adapter: built[3],
  routes: [{ url: 'https://odd.test', body: { data: { balance: '5.00' } } }],
  expect: {
    snap: ok({
      mark: 'something-else',
      builtin: false,
      source: '自定义接口',
      windows: [{ name: '账户余额', used: 5, unit: 'cny', note: '自定义接口' }]
    }),
    call: { url: 'https://odd.test', auth: `Bearer ${KEY}`, accept: 'application/json' }
  }
})

// ── P1-4 多账户分组：注册表侧的归组 API（setInstanceGroup / sanitizeGroupId）──
//
// 为什么在这里：分组纯逻辑（groupNames / visibleIds / orderForDisplay）落在
// read-model.ts、由 test-read-model.mjs 守着；**注册表这一侧**（写盘 / 清洗 /
// 「无变化不写」守卫 / distinguishKey 的取值）只有本段能测 —— 它绑着 keystore，
// 纯 node 套件里唯一能拿到真 store 的地方就是 T 段的 regStore。
//
// 守的是三种「写错了不抛不红、只是功能悄悄没了」的形态：
//   · 去掉「无变化不写」守卫 → T21c 红（setExtra 是**无条件整文件重写**，一次按键一次全写）
//   · 去掉清洗 → T21a/b 红（控制字符会进 <option> 与 SVG；超长组名撑破标题栏）
//   · distinguishKey 写成裸 baseUrl → T21f 红（卡片名后缀从 host 退化成整条地址）
console.log('\nT-b. 多账户分组：归组写入（T21 · P1-4）')

const { sanitizeGroupId } = providers
eq(sanitizeGroupId('公司'), '公司', 'T21a 正常组名原样通过')
eq(sanitizeGroupId('  公司  '), '公司', 'T21b 两端空白被 trim（存进去的组名不带尾随空格）')
eq(sanitizeGroupId('公\n司\t'), '公司', 'T21c 控制字符被剥掉（\\n / \\t 会破坏 <option> 布局）')
eq(sanitizeGroupId('x'.repeat(40)).length, 32, 'T21d 超长组名截断到 32 字符')
// ⚠ 截断按 UTF-16 码元计数，emoji 占 2 个码元 —— 不补最后那道检查就会切出半个字符（U+FFFD）
eq(sanitizeGroupId('a'.repeat(31) + '😀'), 'a'.repeat(31), 'T21e 截断不切开代理对（不留半个 emoji）')
eq(sanitizeGroupId('😀😀'.repeat(20)).length, 32, 'T21e2 纯 emoji 组名也截到 32 码元且成对')

// 「无变化不写」：setExtra 是无条件整文件重写，所以守卫必须真的挡住重复写。
// 判据用**调用计数**（而不是比文件内容）—— 内容本来就没变，比内容是恒绿的门。
let setExtraCalls = 0
const realSetExtra = regStore.setExtra.bind(regStore)
regStore.setExtra = (...args) => {
  setExtraCalls++
  return realSetExtra(...args)
}
const grpInst = await providers.addInstance({ protocol: 'generic', name: '归组靶子' })
eq((await providers.listInstances()).find((i) => i.id === grpInst.id).groupId, '', 'T21f 新实例的 groupId 缺省为空串（.map() 归一化）')

setExtraCalls = 0
eq(await providers.setInstanceGroup(grpInst.id, '公司'), true, 'T21g 首次归组返回 true（有写入）')
eq(setExtraCalls, 1, 'T21g2 首次归组真的写了一次盘')
eq((await providers.listInstances()).find((i) => i.id === grpInst.id).groupId, '公司', 'T21h groupId 落盘后能读回')

setExtraCalls = 0
eq(await providers.setInstanceGroup(grpInst.id, '公司'), false, 'T21i 重复赋同一个组名返回 false')
eq(setExtraCalls, 0, 'T21i2 重复赋同一个组名**一次盘都不写**（守卫生效；否则是整文件重写）')
// 守卫要比的是**清洗后**的值：输入多带一个尾随空格时不该触发写盘
setExtraCalls = 0
eq(await providers.setInstanceGroup(grpInst.id, '  公司  '), false, 'T21j 只差空白也算无变化（清洗后再比）')
eq(setExtraCalls, 0, 'T21j2 只差空白不写盘')
setExtraCalls = 0
eq(await providers.setInstanceGroup(grpInst.id, ''), true, 'T21k 空串 = 移出分组（不是「无变化」）')
eq((await providers.listInstances()).find((i) => i.id === grpInst.id).groupId, '', 'T21k2 移出后读回空串')
eq(await providers.setInstanceGroup('不存在的实例', '公司'), false, 'T21l 未知实例 id 返回 false，不抛')
regStore.setExtra = realSetExtra

// distinguishKey：卡片名后缀的依据（ProviderInfo 层，ProviderSnapshot 刻意不加）
const dupA = await providers.addInstance({ protocol: 'generic', name: '同名', baseUrl: 'https://a.test/v1/balance' })
const dupB = await providers.addInstance({ protocol: 'generic', name: '同名', baseUrl: 'https://b.test:8443/v1' })
eq((await providers.instanceInfo(dupA)).distinguishKey, 'a.test', 'T21m distinguishKey 取 baseUrl 的 host')
eq((await providers.instanceInfo(dupB)).distinguishKey, 'b.test:8443', 'T21n 带端口也取对（正则切地址会在这里漏）')
eq(
  (await providers.instanceInfo(grpInst)).distinguishKey,
  '',
  'T21o baseUrl 为空 → 空串（读侧据此不加后缀，不造「(2)」假区分）'
)

rmSync(tmp, { recursive: true, force: true })

// ═══════════════════════════════════════════════════════════════════════════════
// 已收口的缺陷（留作防回归：谁把默认值加回去，这里就会红）
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n─── 已收口的缺陷（防回归）───')

eq(project(b2).builtin, false, 'D1 已收口：自定义实例的错误快照 builtin=false（协议工厂显式交身份给铸造）')
eq(project(b6).builtin, false, 'D2 已收口：自定义实例的 nodata 快照 builtin=false（同上）')
eq(project(mmBuiltin).kind, 'token', "D3 已收口：MiniMax 代码适配器自己声明 kind='token'（铸造不再有默认值）")
eq(project(ds401).quality, null, 'D4 错误快照不再声明来路（ADR-0002 已落地：undefined，不再是 official）')
eq(project(ds401).detail, project(ds401).failureReason, 'D5 错误快照把同一句话塞进 detail 与 failureReason 两个字段')

console.log('  D1~D3 全部收口：铸造要求 id/name/kind/builtin 必填，没有默认值可被误用。')
console.log('  collectAll 因此退化成纯扇出 —— S 节验证它不再改动任何身份字段。')

// ═══════════════════════════════════════════════════════════════════════════════
// R. 生产出网实现（src/main/request.ts）与可达性记账（src/main/net.ts）
//    —— 适配器用的是注入桩，这里补上「真实那一半」的契约
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nR. 生产出网实现 src/main/request.ts + 可达性记账 src/main/net.ts')

const { request } = await loadTs('src/main/request.ts', { alias })
const net = await loadTs('src/main/net.ts', { alias })

/** 临时替换 globalThis.fetch；返回 restore */
function withFetch(fn) {
  const prev = globalThis.fetch
  globalThis.fetch = fn
  return () => (globalThis.fetch = prev)
}

{
  const restore = withFetch(async () => ({ status: 200, ok: true, text: async () => '{"ok":true}' }))
  try {
    const res = await request({ url: 'https://x.test/a', headers: { A: '1' } })
    eq(res, { status: 200, text: '{"ok":true}' }, 'R1 返回原始响应文本（解析交给引擎）')
  } finally {
    restore()
  }
}

{
  const restore = withFetch(async () => ({ status: 503, ok: false, text: async () => 'busy' }))
  try {
    // 拿到响应就算网络通：4xx/5xx 不抛错，也不计入离线
    const res = await request({ url: 'https://x.test/a', headers: {} })
    eq(res, { status: 503, text: 'busy' }, 'R2 HTTP 5xx 原样返回，不抛错（凭据/服务问题不算离线）')
  } finally {
    restore()
  }
}

{
  const restore = withFetch(async () => {
    throw new TypeError('fetch failed')
  })
  let thrown = null
  try {
    await request({ url: 'https://x.test/a', headers: {} })
  } catch (e) {
    thrown = e
  } finally {
    restore()
  }
  eq(thrown?.message, 'fetch failed', 'R3 网络类错误向上抛（由适配器包成「请求失败:」）')
}

{
  // 超时：fetch 永不返回，只尊重 abort 信号
  const restore = withFetch(
    (_url, init) =>
      new Promise((_res, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        )
      })
  )
  let thrown = null
  try {
    await request({ url: 'https://x.test/slow', headers: {}, timeoutMs: 5 })
  } catch (e) {
    thrown = e
  } finally {
    restore()
  }
  eq(thrown?.name, 'AbortError', 'R4 超时由 AbortController 中断（默认 12s，可覆盖）')
}

// 记账：连续 2 次网络类失败且期间无成功 → 判定离线；一次成功即恢复
{
  const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
  eq(net.isOffline(), false, 'R5 初始未判定离线')
  net.markNetResult(false, abortErr)
  eq(net.isOffline(), false, 'R6 单次失败还不算离线（阈值是 2 次）')
  net.markNetResult(false, abortErr)
  eq(net.isOffline(), true, 'R7 连续 2 次网络类失败 → 离线')
  net.markNetResult(true)
  eq(net.isOffline(), false, 'R8 一次成功即恢复在线')
  net.markNetResult(false, new Error('HTTP 401 unauthorized'))
  net.markNetResult(false, new Error('HTTP 401 unauthorized'))
  eq(net.isOffline(), false, 'R9 凭据/服务类错误不计入离线（只有网络类才算）')
}

// ═══════════════════════════════════════════════════════════════════════════════
// S. 并行采集与身份重盖（src/main/adapters/collect.ts）
//    —— 收口 D1~D3：适配器层的默认身份在这里被按适配器元数据改回真相
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nS. 并行采集 + 身份重盖（adapters/collect.ts）')

const { collectAll } = await loadTs('src/main/adapters/collect.ts')

// 传一个「一旦被调用就失败」的 request：假适配器不该碰网络
const offCtx = makeCtx({
  request: async () => {
    throw new Error('S 节的假适配器不应发起请求')
  }
})

/** 自定义实例：collect 走错误路径（铸造默认 builtin=true，必须被重盖） */
const fakeCustomErr = {
  id: 'inst-x',
  name: '自定义中转',
  kind: 'balance',
  builtin: false,
  mark: 'deepseek',
  collect: async (c) => mintErr(identityOf(fakeCustomErr), '鉴权失败（HTTP 401）', c)
}
/** 内置 Token 套餐：适配器声明 kind='token'，铸造默认却是 'balance' */
const fakeBuiltinToken = {
  id: 'minimax',
  name: 'MiniMax',
  kind: 'token',
  builtin: true,
  mark: 'minimax',
  collect: async (c) => officialSnap(identityOf(fakeBuiltinToken), c)
}
/** 直接抛异常的适配器：由 collectAll 兜成错误快照 */
const fakeThrows = {
  id: 'boom',
  name: '炸了的适配器',
  kind: 'coding',
  builtin: false,
  collect: async () => {
    throw new Error('内部异常')
  }
}

const collected = await collectAll([fakeCustomErr, fakeBuiltinToken, fakeThrows], offCtx)

eq(collected.length, 3, 'S1 三个适配器都有结果（单个失败不影响其他）')
eq(
  [collected[0].id, collected[1].id, collected[2].id],
  ['inst-x', 'minimax', 'boom'],
  'S2 结果顺序与传入顺序一致'
)
eq(project(collected[0]).builtin, false, 'S3 collectAll 不改身份：适配器声明的 builtin=false 原样保留')
eq(project(collected[0]).quality, null, 'S4 错误快照没有来路（ADR-0002）')
eq(project(collected[0]).status, 'error', 'S5 错误状态保持')
eq(project(collected[0]).mark, 'deepseek', 'S6 mark 取适配器元数据')
eq(project(collected[1]).kind, 'token', "S7 collectAll 不改身份：适配器声明的 kind='token' 原样保留")
eq(project(collected[1]).quality, 'official', 'S8 ok 快照的来路由适配器显式声明（不再是省略得来）')
eq(project(collected[2]).status, 'error', 'S9 抛异常的适配器被兜成错误快照')
eq(project(collected[2]).builtin, false, 'S10 抛异常路径：兜底快照取适配器自己的身份（builtin=false）')
eq(project(collected[2]).detail, '内部异常', 'S11 异常消息进入 detail 与 failureReason')
eq(project(collected[2]).failureReason, '内部异常', 'S12 failureReason 与 detail 一致')

const withOwnMark = {
  id: 'm1',
  name: 'M1',
  kind: 'balance',
  builtin: true,
  mark: 'from-adapter',
  collect: async (c) => officialSnap({ ...identityOf(withOwnMark), mark: 'from-snapshot' }, c)
}
eq((await collectAll([withOwnMark], offCtx))[0].mark, 'from-snapshot', 'S13 快照自带 mark 时优先（s.mark ?? a.mark）')

// ═══════════════════════════════════════════════════════════════════════════════
// 收口验收：同一响应、内置实例与自定义实例必须**解析出同一个结果**
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n─── 收口验收：同一响应下两条实例路径的一致性 ───')

// 只看「从响应里解析出来的东西」：status / quality / windows / detail。
// source / builtin / mark 本来就该按实例身份不同（内置=官方接口，自定义=自定义接口）。
const PARSED_FIELDS = ['status', 'quality', 'windows', 'detail']
function parsedDiff(a, b) {
  const pa = project(a)
  const pb = project(b)
  return PARSED_FIELDS.filter((k) => JSON.stringify(pa[k]) !== JSON.stringify(pb[k]))
}

const PAIRS = [
  ['DeepSeek 正常响应', dsBuiltin, b1],
  ['DeepSeek 双字段探针', dsBuiltin, b1],
  ['Kimi 正常响应', kimiBuiltin, d1],
  ['智谱 正常响应', zhipuBuiltin, f1],
  ['智谱 双字段探针', zhipuBothBuiltin, f2],
  ['硅基流动 正常响应', sfBuiltin, h1]
]

for (const [vendor, a, b] of PAIRS) {
  eq(parsedDiff(a, b), [], `U ${vendor}：内置与自定义解析结果一致`)
}

// 身份与来路按实例推导 —— 这正是旧实现做不到的那件事
eq(project(dsBuiltin).source, '官方接口', 'U7 内置实例：source = 官方接口')
eq(project(b1).source, '自定义接口', 'U8 自定义实例：source = 自定义接口')
eq(project(dsBuiltin).mark, 'deepseek', 'U9 内置实例 mark = 预设 id')
eq(project(b1).mark, 'deepseek', 'U10 自定义实例 mark = 协议 id（同一协议 id，故与上面同值）')
eq(project(dsBuiltin).builtin, true, 'U11 内置实例 builtin = true')
eq(project(b1).builtin, false, 'U12 自定义实例 builtin = false')
eq({ id: b1.id, name: b1.name }, { id: 'inst-deepseek', name: 'deepseek 自定义' }, 'U12b 快照 id/name 取实例身份')

// 未配置凭据的文案仍按实例身份区分（内置点名环境变量，自定义给编辑指引）
eq(
  project(dsNoKey).detail,
  '未配置 API Key（可在设置中填写或设 DEEPSEEK_API_KEY）',
  'U13 内置实例的未配置提示点名环境变量'
)
eq(project(b6).detail, '未配置 API Key（在设置中编辑该供应商）', 'U14 自定义实例给编辑指引')

// ═══════════════════════════════════════════════════════════════════════════════
// V. Gemini Code Assist（代码适配器 · src/main/adapters/gemini.ts）
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nV. Gemini Code Assist（代码适配器）')

// ── V 段夹具 ─────────────────────────────────────────────────────────────────
// 来源：字段名与类型逐字取自 google-gemini/gemini-cli（Apache-2.0）
//   packages/core/src/code_assist/types.ts 的 BucketInfo / LoadCodeAssistResponse
// 单桶样本取自 gemini-cli issue #27363 的真实返回（100% 时 remainingAmount 被省略）
// ⚠️ 「quota」作为数组键的写法来自第三方实现（hermes-quota-plugin, MIT），
//    与官方类型定义矛盾 —— 作为宽容回落的兼容夹具，非官方契约。
// ⚠️ 凭据字面量红线（keystore.ts:6）：下面全是明显假的占位，不得换成真值。

const { geminiAdapter, geminiHome } = await loadTs('src/main/adapters/gemini.ts')

const GEMINI_HOST = 'https://cloudcode-pa.googleapis.com'
const GEMINI_LOAD = `${GEMINI_HOST}/v1internal:loadCodeAssist`
const GEMINI_QUOTA = `${GEMINI_HOST}/v1internal:retrieveUserQuota`
const GEMINI_TOKEN = 'https://oauth2.googleapis.com/token'
const GEMINI_PROJECT = 'gen-lang-client-abc123' // 形状仿 cloudaicompanionProject
const GEMINI_FAKE_AT = 'ya29.fake-access-token-for-tests'
const GEMINI_FAKE_RT = 'fake-refresh-token-for-tests'
const GEMINI_FAKE_CREDS = {
  access_token: GEMINI_FAKE_AT,
  refresh_token: GEMINI_FAKE_RT,
  expiry_date: Date.now() + 3600_000,
  client_id: 'fake-client-id-for-tests',
  client_secret: 'fake-client-secret-for-tests'
}
const GEMINI_REFRESHED_AT = 'ya29.refreshed-access-token-for-tests'

const GEMINI_LOAD_BODY = JSON.stringify({
  metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }
})
const GEMINI_QUOTA_BODY = JSON.stringify({ project: GEMINI_PROJECT })
const GEMINI_AUTH = `Bearer ${GEMINI_FAKE_AT}`
const V_LOAD_CALL = {
  url: GEMINI_LOAD,
  auth: GEMINI_AUTH,
  accept: 'application/json',
  method: 'POST',
  contentType: 'application/json',
  body: GEMINI_LOAD_BODY
}
const V_QUOTA_CALL = {
  url: GEMINI_QUOTA,
  auth: GEMINI_AUTH,
  accept: 'application/json',
  method: 'POST',
  contentType: 'application/json',
  body: GEMINI_QUOTA_BODY
}

/** loadCodeAssist：Standard 档 + 已绑定配额项目（happy path） */
const GEMINI_LOAD_OK = {
  currentTier: { id: 'standard-tier', name: 'Standard', isDefault: true, hasOnboardedPreviously: true },
  allowedTiers: [{ id: 'standard-tier', name: 'Standard', isDefault: true }],
  ineligibleTiers: null,
  cloudaicompanionProject: GEMINI_PROJECT
}

/** retrieveUserQuota：真实样本（100%，remainingAmount 缺失） */
const GEMINI_BUCKET_FULL = {
  resetTime: '2026-05-23T02:48:06Z',
  tokenType: 'REQUESTS',
  modelId: 'gemini-3.1-pro-preview',
  remainingFraction: 1
}
const gBucket = (modelId, frac, resetTime) => ({ resetTime, tokenType: 'REQUESTS', modelId, remainingFraction: frac })
const V_WIN_FULL = {
  name: 'gemini-3.1-pro-preview',
  used: 0,
  percent: 0,
  unit: 'percent',
  resetAt: '2026-05-23T02:48:06Z',
  note: '官方配额接口'
}

// 代码适配器自己声明 kind，但不声明 mark（实例绑定层补，见 N 节）
const gemOk = (body = {}) => ok({ kind: 'coding', mark: null, ...body })
const gemErr = (detail) => ({ ...err(detail), kind: 'coding' })
const gemNodata = (detail) => ({ ...nodata(detail), kind: 'coding' })

/** V 段专用的检查器：走 makeRichRequest（富投影，断言得了 method / body） */
async function checkRich(label, { adapter, routes, expect }) {
  const inst = makeRichRequest(routes)
  const snap = await adapter.collect(makeCtx({ request: inst.request }))
  eq(project(snap), expect.snap, label)
  if (expect.call) eq(inst.list, [expect.call], `${label} · 请求`)
  if (expect.calls) eq(inst.list, expect.calls, `${label} · 请求序列`)
  return { snap, list: inst.list }
}

/**
 * V 段的布尔断言。本文件已有的 `ok` 是快照构造器（`ok(body)`），不是断言 ——
 * 直接拿它当断言会静默构造一个快照对象然后丢掉（不断言、不计数、不打印）。
 * 所以这里另起 `vok`（与 test-seam.mjs 的 ok 同形）。
 */
function vok(cond, label) {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}`)
  }
}

// 凭据注入：GEMINI_CLI_HOME 指向临时目录（与 CLAUDE_CONFIG_DIR / CODEX_HOME 同一惯例）。
// HOME 一并指向临时目录，否则 ~/.config/gcloud 的 ADC 真文件会污染「无凭据」断言。
// V 段是文件最后一段，改 env 不影响任何既有段；段末恢复原值。
const GEMINI_TMP = mkdtempSync(joinPath(tmpdir(), 'bd-gemini-'))
const GEMINI_EMPTY = mkdtempSync(joinPath(tmpdir(), 'bd-gemini-empty-'))
writeFileSync(joinPath(GEMINI_TMP, 'oauth_creds.json'), JSON.stringify(GEMINI_FAKE_CREDS))
const savedGeminiHome = process.env.GEMINI_CLI_HOME
const savedHome = process.env.HOME
const savedGac = process.env.GOOGLE_APPLICATION_CREDENTIALS
process.env.GEMINI_CLI_HOME = GEMINI_TMP
process.env.HOME = GEMINI_TMP
delete process.env.GOOGLE_APPLICATION_CREDENTIALS

eq(geminiHome(), GEMINI_TMP, 'V0 GEMINI_CLI_HOME 被识别（与 CLAUDE_CONFIG_DIR / CODEX_HOME 同一惯例）')

const v1 = await checkRich('V1 happy path：单桶 100% → percent 0', {
  adapter: geminiAdapter,
  routes: [{ url: GEMINI_LOAD, body: GEMINI_LOAD_OK }, { url: GEMINI_QUOTA, body: { buckets: [GEMINI_BUCKET_FULL] } }],
  expect: {
    snap: gemOk({ source: '官方接口', plan: 'Standard', windows: [V_WIN_FULL] }),
    calls: [V_LOAD_CALL, V_QUOTA_CALL]
  }
})
eq(v1.snap.dataQuality, 'official', 'V1b 成功时 dataQuality === official')
vok(v1.snap.degradedReason === undefined, 'V1c 适配器不写 degradedReason（那是 applyCachePolicy 的活）')
vok(v1.snap.windows.every((w) => !('limit' in w)), 'V1d 不硬造 limit（窗口只有 percent）')
eq(
  v1.list.map((c) => c.url),
  [GEMINI_LOAD, GEMINI_QUOTA],
  'V1e access_token 有效时不发刷新请求（序列恰好两步）'
)
vok(!v1.list[0].auth.startsWith('token '), 'V1f 业务请求是 Bearer 前缀，不带 copilot 式的 token 前缀')

await checkRich('V2 remainingFraction 0.965 → percent 3.5（一位小数）', {
  adapter: geminiAdapter,
  routes: [
    { url: GEMINI_LOAD, body: GEMINI_LOAD_OK },
    { url: GEMINI_QUOTA, body: { buckets: [gBucket('gemini-3.1-pro-preview', 0.965, '2026-05-23T02:48:06Z')] } }
  ],
  expect: {
    snap: gemOk({
      source: '官方接口',
      plan: 'Standard',
      windows: [
        {
          name: 'gemini-3.1-pro-preview',
          used: 3.5,
          percent: 3.5,
          unit: 'percent',
          resetAt: '2026-05-23T02:48:06Z',
          note: '官方配额接口'
        }
      ]
    }),
    calls: [V_LOAD_CALL, V_QUOTA_CALL]
  }
})

const v3 = await checkRich('V3 多桶各成一个窗口，非 REQUESTS 桶被过滤', {
  adapter: geminiAdapter,
  routes: [
    { url: GEMINI_LOAD, body: GEMINI_LOAD_OK },
    {
      url: GEMINI_QUOTA,
      body: {
        buckets: [
          gBucket('gemini-3.1-pro-preview', 0.5, '2026-05-23T02:48:06Z'),
          { resetTime: '2026-05-23T02:48:06Z', tokenType: 'INPUT_TOKENS', modelId: 'gemini-3.1-pro-preview', remainingFraction: 0.1 },
          gBucket('gemini-3.1-flash-preview', 0.8, '2026-05-23T02:48:06Z')
        ]
      }
    }
  ],
  expect: {
    snap: gemOk({
      source: '官方接口',
      plan: 'Standard',
      windows: [
        { name: 'gemini-3.1-pro-preview', used: 50, percent: 50, unit: 'percent', resetAt: '2026-05-23T02:48:06Z', note: '官方配额接口' },
        { name: 'gemini-3.1-flash-preview', used: 20, percent: 20, unit: 'percent', resetAt: '2026-05-23T02:48:06Z', note: '官方配额接口' }
      ]
    }),
    calls: [V_LOAD_CALL, V_QUOTA_CALL]
  }
})
eq(
  v3.snap.windows.map((w) => w.name),
  ['gemini-3.1-pro-preview', 'gemini-3.1-flash-preview'],
  'V3b 每桶一个窗口，name === modelId'
)

await checkRich('V4 数组键是 quota（而非 buckets）时也能解析（宽容回落）', {
  adapter: geminiAdapter,
  routes: [{ url: GEMINI_LOAD, body: GEMINI_LOAD_OK }, { url: GEMINI_QUOTA, body: { quota: [GEMINI_BUCKET_FULL] } }],
  expect: {
    snap: gemOk({ source: '官方接口', plan: 'Standard', windows: [V_WIN_FULL] }),
    calls: [V_LOAD_CALL, V_QUOTA_CALL]
  }
})

const v5 = await checkRich('V5 remainingFraction 缺失的桶被跳过，不产生 NaN', {
  adapter: geminiAdapter,
  routes: [
    { url: GEMINI_LOAD, body: GEMINI_LOAD_OK },
    {
      url: GEMINI_QUOTA,
      body: { buckets: [{ resetTime: '2026-05-23T02:48:06Z', tokenType: 'REQUESTS', modelId: 'ghost-model' }, GEMINI_BUCKET_FULL] }
    }
  ],
  expect: {
    snap: gemOk({ source: '官方接口', plan: 'Standard', windows: [V_WIN_FULL] }),
    calls: [V_LOAD_CALL, V_QUOTA_CALL]
  }
})
vok(
  v5.snap.windows.every((w) => Number.isFinite(w.percent)),
  'V5b 没有 NaN percent'
)

const v6 = await checkRich('V6 resetTime 缺失时 resetAt 字段整个不存在（不是 null）', {
  adapter: geminiAdapter,
  routes: [
    { url: GEMINI_LOAD, body: GEMINI_LOAD_OK },
    { url: GEMINI_QUOTA, body: { buckets: [{ tokenType: 'REQUESTS', modelId: 'gemini-3.1-pro-preview', remainingFraction: 0.5 }] } }
  ],
  expect: {
    snap: gemOk({
      source: '官方接口',
      plan: 'Standard',
      windows: [{ name: 'gemini-3.1-pro-preview', used: 50, percent: 50, unit: 'percent', note: '官方配额接口' }]
    }),
    calls: [V_LOAD_CALL, V_QUOTA_CALL]
  }
})
vok(!('resetAt' in v6.snap.windows[0]), 'V6b resetAt 键整个不存在（stable 会吞 undefined，所以直接查键）')

await checkRich('V7 空 buckets → errSnap（不是 ok + 空窗口）', {
  adapter: geminiAdapter,
  routes: [{ url: GEMINI_LOAD, body: GEMINI_LOAD_OK }, { url: GEMINI_QUOTA, body: { buckets: [] } }],
  expect: {
    snap: gemErr('官方接口未返回可用的 REQUESTS 配额桶（当前无可查额度）'),
    calls: [V_LOAD_CALL, V_QUOTA_CALL]
  }
})

const V8_BODY = { somethingElse: 1 }
await checkRich('V8 响应格式未识别：附带 160 字符预览', {
  adapter: geminiAdapter,
  routes: [{ url: GEMINI_LOAD, body: GEMINI_LOAD_OK }, { url: GEMINI_QUOTA, body: V8_BODY }],
  expect: {
    snap: gemErr(`响应格式未识别：${JSON.stringify(V8_BODY).slice(0, 160)}`),
    calls: [V_LOAD_CALL, V_QUOTA_CALL]
  }
})

// V9：凭据 4 条路径全未命中 → noDataSnap（GEMINI_CLI_HOME 与 HOME 都指向空目录）
process.env.GEMINI_CLI_HOME = GEMINI_EMPTY
process.env.HOME = GEMINI_EMPTY
const v9 = await checkRich('V9 未配置：noDataSnap 且点名 gemini 登录入口', {
  adapter: geminiAdapter,
  routes: [],
  expect: {
    snap: gemNodata('未找到 Gemini 凭据（先运行 gemini 登录，或配置 gcloud ADC）'),
    calls: []
  }
})
eq(v9.snap.dataQuality, undefined, 'V9b 失败路径 dataQuality 必须是 undefined（ADR-0002）')
process.env.GEMINI_CLI_HOME = GEMINI_TMP
process.env.HOME = GEMINI_TMP

// V9c：$GOOGLE_APPLICATION_CREDENTIALS 次选路径 + 路径顺序（前者优先）
const GAC_FILE = joinPath(GEMINI_TMP, 'adc.json')
writeFileSync(GAC_FILE, JSON.stringify({ ...GEMINI_FAKE_CREDS, access_token: 'ya29.gac-should-lose' }))
process.env.GOOGLE_APPLICATION_CREDENTIALS = GAC_FILE
const v9c = await checkRich('V9c 两条路径都有凭据时 $GEMINI_CLI_HOME 优先', {
  adapter: geminiAdapter,
  routes: [{ url: GEMINI_LOAD, body: GEMINI_LOAD_OK }, { url: GEMINI_QUOTA, body: { buckets: [GEMINI_BUCKET_FULL] } }],
  expect: {
    snap: gemOk({ source: '官方接口', plan: 'Standard', windows: [V_WIN_FULL] }),
    calls: [V_LOAD_CALL, V_QUOTA_CALL]
  }
})
eq(v9c.list[0].auth, GEMINI_AUTH, 'V9c2 赢的是 GEMINI_CLI_HOME 那份凭据')
process.env.GEMINI_CLI_HOME = GEMINI_EMPTY
await checkRich('V9d 主路径缺失时 $GOOGLE_APPLICATION_CREDENTIALS 兜底', {
  adapter: geminiAdapter,
  routes: [
    { url: GEMINI_LOAD, body: GEMINI_LOAD_OK },
    { url: GEMINI_QUOTA, body: { buckets: [GEMINI_BUCKET_FULL] } }
  ],
  expect: {
    snap: gemOk({ source: '官方接口', plan: 'Standard', windows: [V_WIN_FULL] }),
    calls: [
      { ...V_LOAD_CALL, auth: 'Bearer ya29.gac-should-lose' },
      { ...V_QUOTA_CALL, auth: 'Bearer ya29.gac-should-lose' }
    ]
  }
})
process.env.GEMINI_CLI_HOME = GEMINI_TMP
delete process.env.GOOGLE_APPLICATION_CREDENTIALS

// V10：access_token 过期 → 先 form-encoded 刷新，再走正常两步
writeFileSync(
  joinPath(GEMINI_TMP, 'oauth_creds.json'),
  JSON.stringify({ ...GEMINI_FAKE_CREDS, access_token: 'ya29.expired', expiry_date: Date.now() - 3600_000 })
)
const V_TOKEN_BODY =
  `grant_type=refresh_token&refresh_token=${encodeURIComponent(GEMINI_FAKE_RT)}` +
  `&client_id=${encodeURIComponent('fake-client-id-for-tests')}` +
  `&client_secret=${encodeURIComponent('fake-client-secret-for-tests')}`
const V_TOKEN_CALL = {
  url: GEMINI_TOKEN,
  auth: null,
  accept: 'application/json',
  method: 'POST',
  contentType: 'application/x-www-form-urlencoded',
  body: V_TOKEN_BODY
}
const V_LOAD_CALL_R = { ...V_LOAD_CALL, auth: `Bearer ${GEMINI_REFRESHED_AT}` }
const V_QUOTA_CALL_R = { ...V_QUOTA_CALL, auth: `Bearer ${GEMINI_REFRESHED_AT}` }
await checkRich('V10 access_token 过期时先刷新（form-encoded）再取配额', {
  adapter: geminiAdapter,
  routes: [
    { url: GEMINI_TOKEN, body: { access_token: GEMINI_REFRESHED_AT, expires_in: 3599, token_type: 'Bearer' } },
    { url: GEMINI_LOAD, body: GEMINI_LOAD_OK },
    { url: GEMINI_QUOTA, body: { buckets: [GEMINI_BUCKET_FULL] } }
  ],
  expect: {
    snap: gemOk({ source: '官方接口', plan: 'Standard', windows: [V_WIN_FULL] }),
    calls: [V_TOKEN_CALL, V_LOAD_CALL_R, V_QUOTA_CALL_R]
  }
})

await checkRich('V11 token 端点 400 + invalid_grant → refresh token 被吊销（不是 401）', {
  adapter: geminiAdapter,
  routes: [{ url: GEMINI_TOKEN, status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }],
  expect: {
    snap: gemErr('Gemini 凭据已失效（refresh token 被吊销）：请重新运行 gemini 登录'),
    call: V_TOKEN_CALL
  }
})
// 恢复有效凭据文件（后面各条不再走刷新分支）
writeFileSync(joinPath(GEMINI_TMP, 'oauth_creds.json'), JSON.stringify(GEMINI_FAKE_CREDS))

const v12 = await checkRich('V12 loadCodeAssist 401 → 重新登录', {
  adapter: geminiAdapter,
  routes: [{ url: GEMINI_LOAD, status: 401, body: { error: 'unauthorized' } }],
  expect: {
    snap: gemErr('凭据失效（HTTP 401）：请重新运行 gemini 登录'),
    call: V_LOAD_CALL
  }
})
vok(v12.snap.degradedReason === undefined, 'V12b 错误路径也不写 degradedReason')

await checkRich('V13 retrieveUserQuota 403 → 重新登录', {
  adapter: geminiAdapter,
  routes: [{ url: GEMINI_LOAD, body: GEMINI_LOAD_OK }, { url: GEMINI_QUOTA, status: 403, body: {} }],
  expect: {
    snap: gemErr('凭据失效（HTTP 403）：请重新运行 gemini 登录'),
    calls: [V_LOAD_CALL, V_QUOTA_CALL]
  }
})

await checkRich('V14 403 + SECURITY_POLICY_VIOLATED → 点名 VPC 服务边界', {
  adapter: geminiAdapter,
  routes: [
    {
      url: GEMINI_LOAD,
      status: 403,
      body: { error: { code: 403, message: 'Request is prohibited by organization policy', details: [{ reason: 'SECURITY_POLICY_VIOLATED' }] } }
    }
  ],
  expect: {
    snap: gemErr('请求被 VPC 服务边界拦截（SECURITY_POLICY_VIOLATED）：请联系管理员放行，或切换网络后重试'),
    call: V_LOAD_CALL
  }
})

await checkRich('V15 403 + cloudshell-gca → 给 gcloud config 指引', {
  adapter: geminiAdapter,
  routes: [{ url: GEMINI_LOAD, status: 403, body: { cloudaicompanionProject: 'cloudshell-gca' } }],
  expect: {
    snap: gemErr('默认 Cloud Shell 项目无 Code Assist 许可（cloudshell-gca）：请执行 gcloud config set project <你的项目ID> 后重试'),
    call: V_LOAD_CALL
  }
})

await checkRich('V16 loadCodeAssist 200 但配额归属项目缺失 → 未绑定许可', {
  adapter: geminiAdapter,
  routes: [
    {
      url: GEMINI_LOAD,
      body: { currentTier: { id: 'standard-tier', name: 'Standard' }, cloudaicompanionProject: null }
    }
  ],
  expect: {
    snap: gemErr('服务端未返回配额归属项目（该账号未绑定 Code Assist Standard / Enterprise 许可）'),
    call: V_LOAD_CALL
  }
})

const v17 = await checkRich('V17 免费档退役（currentTier）：errSnap + 2026-06-18 文案', {
  adapter: geminiAdapter,
  routes: [
    {
      url: GEMINI_LOAD,
      body: { currentTier: { id: 'free-tier', name: 'Free' }, cloudaicompanionProject: GEMINI_PROJECT }
    }
  ],
  expect: {
    snap: gemErr(
      'Google 已于 2026-06-18 关停 Code Assist 个人免费档 / AI Pro / Ultra（Login with Google 已移除），本账号无可查额度：如需继续使用请绑定 Workspace Code Assist Standard / Enterprise 许可'
    ),
    call: V_LOAD_CALL
  }
})
vok(v17.snap.detail.includes('2026-06-18'), 'V17b 退役文案含 2026-06-18（终态，不是含糊的「无数据」）')

const v18 = await checkRich('V18 免费档退役（ineligibleTiers）：回显 Google 原文', {
  adapter: geminiAdapter,
  routes: [
    {
      url: GEMINI_LOAD,
      body: {
        currentTier: { id: 'standard-tier', name: 'Standard' },
        ineligibleTiers: [{ tierId: 'free-tier', reasonMessage: 'Google AI Pro is no longer supported' }],
        cloudaicompanionProject: GEMINI_PROJECT
      }
    }
  ],
  expect: {
    snap: gemErr(
      'Google 已于 2026-06-18 关停 Code Assist 个人免费档 / AI Pro / Ultra（Login with Google 已移除），本账号无可查额度（Google AI Pro is no longer supported）：如需继续使用请绑定 Workspace Code Assist Standard / Enterprise 许可'
    ),
    call: V_LOAD_CALL
  }
})
vok(v18.snap.detail.includes('2026-06-18'), 'V18b 退役文案含 2026-06-18')

await checkRich('V19 paidTier 存在时 plan 取 paidTier.name', {
  adapter: geminiAdapter,
  routes: [
    {
      url: GEMINI_LOAD,
      body: {
        currentTier: { id: 'standard-tier', name: 'Standard' },
        paidTier: { id: 'enterprise-tier', name: 'Enterprise' },
        cloudaicompanionProject: GEMINI_PROJECT
      }
    },
    { url: GEMINI_QUOTA, body: { buckets: [GEMINI_BUCKET_FULL] } }
  ],
  expect: {
    snap: gemOk({ source: '官方接口', plan: 'Enterprise', windows: [V_WIN_FULL] }),
    calls: [V_LOAD_CALL, V_QUOTA_CALL]
  }
})

await checkRich('V20 loadCodeAssist HTTP 500', {
  adapter: geminiAdapter,
  routes: [{ url: GEMINI_LOAD, status: 500, body: {} }],
  expect: { snap: gemErr('HTTP 500'), call: V_LOAD_CALL }
})

await checkRich('V21 网络类错误：包成「请求失败:」', {
  adapter: geminiAdapter,
  routes: [{ url: GEMINI_LOAD, throw: 'fetch failed' }],
  expect: { snap: gemErr('请求失败: fetch failed'), call: V_LOAD_CALL }
})

// ── 注册与目录（AC1–AC4 的静态侧）──
const { CODE_ADAPTERS: V_CODE_ADAPTERS } = await loadTs('src/main/adapters/index.ts')
// ⚠ loadTs 每次重新求值模块：这里拿到的 CODE_ADAPTERS.gemini 与 V 段直载的
// geminiAdapter 是两个求值产物，判引用相等恒假 —— 只能判注册字段。
vok(V_CODE_ADAPTERS.gemini?.id === 'gemini', 'V22 前置：CODE_ADAPTERS 里找得到 gemini')
eq(
  { id: V_CODE_ADAPTERS.gemini?.id, kind: V_CODE_ADAPTERS.gemini?.kind, builtin: V_CODE_ADAPTERS.gemini?.builtin },
  { id: 'gemini', kind: 'coding', builtin: true },
  'V22 CODE_ADAPTERS 注册了 gemini（与适配器自声明的身份一致）'
)
eq(
  (({ id, name, kind, protocol, localCredential, singleton }) => ({ id, name, kind, protocol, localCredential, singleton }))(
    providers.presetById('gemini')
  ),
  { id: 'gemini', name: 'Gemini Code Assist', kind: 'coding', protocol: 'gemini', localCredential: true, singleton: true },
  'V23 BUILTIN_PRESETS 有 gemini 条目（coding + 本机凭据 + 单例）'
)
vok(!('keyHint' in providers.presetById('gemini')), 'V23b gemini 预设无 keyHint（本机文件型三家一致）')
eq(geminiAdapter.kind, 'coding', 'V24 kind === coding（订阅制 + 限额 + 重置时间）')
eq(geminiAdapter.id, 'gemini', 'V24b preset id == protocol id == mark == gemini（自定义实例才拿得到 logo）')

// ── 静态守卫（每条先有前置，否则负向断言会空洞通过）──
const geminiSrc = readFileSync(new URL('../src/main/adapters/gemini.ts', import.meta.url), 'utf8')
const geminiCode = geminiSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
vok(geminiCode.length > 0, 'VSG0 前置：读得到 gemini.ts 去注释源码')
vok(
  /loadCodeAssist/.test(geminiCode) && /retrieveUserQuota/.test(geminiCode) && /oauth2\.googleapis\.com\/token/.test(geminiCode),
  'VSG1 前置：三个端点常量都在源码里（下面的守卫不能空洞通过）'
)
vok(
  (geminiCode.match(/method:\s*'POST'/g) ?? []).length >= 3,
  'VSG2 三个端点都走 method POST（改回 GET 即红）'
)
vok(
  /JSON\.stringify\(\{\s*project\s*\}\)/.test(geminiCode),
  'VSG3 retrieveUserQuota 的 body 恰好是 { project }（删掉即红）'
)
vok(!/keychain|setKey/.test(geminiCode), 'VSG4 未 import keychain / setKey（不回写凭据）')
vok(
  /application\/x-www-form-urlencoded/.test(geminiCode),
  'VSG5 token 刷新是 form-encoded（不是 JSON）'
)
vok(/Authorization:\s*`Bearer /.test(geminiCode), 'VSG6 业务请求用 Bearer 前缀（不带 copilot 式的 token 前缀）')

// 恢复环境（V 段改过的全部 env 还原；临时目录删掉）
if (savedGeminiHome === undefined) delete process.env.GEMINI_CLI_HOME
else process.env.GEMINI_CLI_HOME = savedGeminiHome
if (savedHome === undefined) delete process.env.HOME
else process.env.HOME = savedHome
if (savedGac === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS
else process.env.GOOGLE_APPLICATION_CREDENTIALS = savedGac
rmSync(GEMINI_TMP, { recursive: true, force: true })
rmSync(GEMINI_EMPTY, { recursive: true, force: true })

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
