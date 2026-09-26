// 静态分析新版控制台的 JS bundle —— 挖出它自己用的 API 路径。
// 不需要登录：bundle 是公开静态资源。目的是判断「有没有 JSON 端点可以带 cookie 直接调」，
// 而不是被迫去解析 DOM。用法：node scripts/probe-spa-bundle.mjs
import { writeFileSync } from 'node:fs'

const BASE = 'https://opencode.ai'
const entry = '/console/assets/index-DAIXky7V.js'

const ac = new AbortController()
const timer = setTimeout(() => ac.abort(), 25_000)
const res = await fetch(BASE + entry, { signal: ac.signal })
clearTimeout(timer)
console.log(`${entry} → HTTP ${res.status}, ${(await res.clone().text()).length} 字节`)

/** 从入口 bundle 里找出它 import 的其它 chunk */
const text0 = await res.text()
const chunks = [...new Set([...text0.matchAll(/["'`]\/console\/assets\/([A-Za-z0-9_.-]+\.js)["'`]/g)].map((m) => m[1]))]
console.log(`入口引用 chunk：${chunks.length} 个`)

const bodies = new Map([[entry.split('/').pop(), text0]])
for (const c of chunks) {
  const ac2 = new AbortController()
  const t2 = setTimeout(() => ac2.abort(), 20_000)
  try {
    const r2 = await fetch(`${BASE}/console/assets/${c}`, { signal: ac2.signal })
    bodies.set(c, await r2.text())
  } catch (e) {
    bodies.set(c, `/* fetch failed: ${e.message} */`)
  } finally {
    clearTimeout(t2)
  }
}
console.log(`已抓取 ${bodies.size} 个 bundle，合计 ${[...bodies.values()].reduce((a, b) => a + b.length, 0)} 字节\n`)

const all = [...bodies.entries()].map(([n, b]) => [n, b])
const PATTERNS = [
  [/["'`]\/console\/api\/[A-Za-z0-9_\-/${}.[\]]+["'`]/g, '显式 /console/api/*'],
  [/["'`]\/api\/[A-Za-z0-9_\-/${}.[\]]+["'`]/g, '显式 /api/*'],
  [/["'`](\/zen\/[A-Za-z0-9_\-/${}.[\]]+)["'`]/g, '显式 /zen/*'],
  [/["'`]([A-Za-z0-9_\-]+)\/([A-Za-z0-9_\-/]+usage[A-Za-z0-9_\-]*)["'`]/gi, '含 usage 的路径片段']
]

const hits = new Map()
for (const [name, body] of all) {
  for (const [re, label] of PATTERNS) {
    for (const m of body.matchAll(re)) {
      const k = `${label}  ${m[0]}`
      if (!hits.has(k)) hits.set(k, new Set())
      hits.get(k).add(name)
    }
  }
}
console.log(`=== 命中的 API 路径（${hits.size} 条）`)
for (const [k, files] of [...hits].sort()) {
  console.log(`  ${k}`)
  console.log(`      ← ${[...files].join(', ')}`)
}

console.log('\n=== 关键词出现次数（判断有没有每模型明细这类能力）')
for (const kw of [
  'usage', 'breakdown', 'per_model', 'perModel', 'detail', 'models', 'quota',
  'spend', 'limits', 'authorizations', 'auth/session', 'EntitlementError'
]) {
  let n = 0
  const where = new Set()
  for (const [name, body] of all) {
    const c = (body.match(new RegExp(kw, 'g')) || []).length
    if (c) {
      n += c
      where.add(name)
    }
  }
  if (n) console.log(`  ${kw.padEnd(20)} ${String(n).padStart(4)} 次  ← ${[...where].slice(0, 3).join(', ')}`)
}

writeFileSync('/tmp/spa-bundles.txt', all.map(([n, b]) => `===== ${n} =====\n${b}`).join('\n\n'))
console.log('\n全部 bundle 已存 /tmp/spa-bundles.txt')
