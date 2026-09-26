// 实测 `GET https://opencode.ai/zen/go/v1/usage` —— 打印 HTTP 状态与响应**结构**（键路径 + 类型），
// 不打印任何 key 明细。目的是回答：官方 API 现在通不通？里面有没有每模型明细？
// 用法：node scripts/probe-usage-api.mjs
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ENDPOINT = 'https://opencode.ai/zen/go/v1/usage'

/** 按 src/main/adapters/opencode.ts:readGoKey 的同样来源顺序取 key */
function resolveKey() {
  const out = []
  const dirs = []
  if (process.env.XDG_DATA_HOME) dirs.push(join(process.env.XDG_DATA_HOME, 'opencode'))
  dirs.push(join(homedir(), '.local', 'share', 'opencode'))
  for (const d of dirs) {
    const p = join(d, 'auth.json')
    if (!existsSync(p)) continue
    try {
      const auth = JSON.parse(readFileSync(p, 'utf-8'))
      for (const k of ['opencode-go', 'opencode']) {
        const key = auth[k]?.key
        if (key) out.push({ src: `${p}#${k}`, key })
      }
    } catch {
      /* skip */
    }
  }
  return out
}

/** 递归列键路径，值只给类型与长度 */
function shape(v, path = '', depth = 0, acc = []) {
  if (depth > 6) return acc
  if (Array.isArray(v)) {
    acc.push(`${path}[] len=${v.length}`)
    if (v.length) shape(v[0], `${path}[0]`, depth + 1, acc)
    return acc
  }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) shape(val, path ? `${path}.${k}` : k, depth + 1, acc)
    return acc
  }
  acc.push(`${path}: ${typeof v}${typeof v === 'string' ? ` len=${v.length}` : ''}`)
  return acc
}

const keys = resolveKey()
console.log(`=== 找到 key：${keys.length} 处`)
for (const { src } of keys) console.log(`  ${src}`)

if (!keys.length) {
  console.log('\n没有可用 key —— 官方 API 路径无法验证。')
  process.exit(0)
}

for (const { src, key } of keys) {
  console.log(`\n=== GET ${ENDPOINT}  (key 来自 ${src})`)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 20_000)
  let res
  let text
  try {
    res = await fetch(ENDPOINT, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: ac.signal
    })
    text = await res.text()
  } catch (e) {
    console.log(`  请求失败：${e.message}`)
    clearTimeout(timer)
    continue
  }
  clearTimeout(timer)
  console.log(`  HTTP ${res.status} ${res.statusText} | ${text.length} 字节`)
  let json
  try {
    json = JSON.parse(text)
  } catch {
    console.log(`  非 JSON：${text.slice(0, 300)}`)
    continue
  }
  console.log('  结构：')
  for (const line of shape(json)) console.log(`    ${line}`)
  // 每模型明细相关的键
  const s = JSON.stringify(json)
  for (const kw of ['model', 'breakdown', 'per_model', 'detail']) {
    if (new RegExp(kw, 'i').test(s)) console.log(`  ★ 含「${kw}」`)
  }
  // 顶层 usage 三个窗口原样打印（数字不敏感）
  const u = json.usage ?? json
  if (u && typeof u === 'object') {
    for (const [kind, w] of Object.entries(u)) {
      if (w && typeof w === 'object') console.log(`  usage.${kind} = ${JSON.stringify(w).slice(0, 200)}`)
    }
  }
}
