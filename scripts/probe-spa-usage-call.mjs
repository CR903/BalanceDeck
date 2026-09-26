// 在已抓下的 SPA bundle 里定位 API 调用点：打印 `/api/usage` 与 usage/export 附近的源码上下文。
// 用法：node scripts/probe-spa-usage-call.mjs
import { readFileSync } from 'node:fs'

const text = readFileSync('/tmp/spa-bundles.txt', 'utf-8')
const NEEDLES = ['"/api/usage"', '`/api/usage`', '/api/v2/usage/export', '/api/v1/usage/export', '/auth/session', 'breakdown']

for (const needle of NEEDLES) {
  let from = 0
  let hits = 0
  while (hits < 4) {
    const i = text.indexOf(needle, from)
    if (i < 0) break
    hits++
    const start = Math.max(0, i - 350)
    const chunk = text.slice(start, i + 550).replace(/\s+/g, ' ')
    console.log(`\n───── ${needle}  [第 ${hits} 处，偏移 ${i}] ─────`)
    console.log(chunk)
    from = i + needle.length
  }
  if (!hits) console.log(`\n───── ${needle} ───── 未找到`)
}
