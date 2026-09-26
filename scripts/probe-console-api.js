// 验证新版控制台的 JSON API 端点是否真实存在、认证方式是什么。
// 端点来自 SPA bundle 里 Effect HttpApi 的声明（带 OpenAPI 描述，标为稳定）：
//   GET /console/api/usage/summary     窗口汇总（5h/周/月 百分比）
//   GET /console/api/usage/cost-by-day 按天花费
//   GET /console/api/usage/models      每模型明细  ← 旧版 DOM 抓取要替代的就是它
//   GET /console/api/usage/users       按成员明细
// 只输出状态码与响应结构（键路径+类型），不打印任何值明文。
// 用法：npx electron scripts/probe-console-api.js
const { app, session } = require('electron')
const fs = require('fs')
const { join } = require('path')

app.setName('balancedeck')

const PATHS = [
  '/console/auth/session',
  '/console/api/usage/summary',
  '/console/api/usage/models',
  '/console/api/usage/cost-by-day',
  '/console/api/usage/users',
  '/console/api/usage/summary?range=7d',
  '/console/api/usage/models?range=30d',
  // 旧控制台路径对照
  '/workspace',
  '/auth'
]

/** 只列键路径与类型，不打印值 */
function shape(v, path = '', depth = 0, acc = []) {
  if (depth > 4) return acc
  if (Array.isArray(v)) {
    acc.push(`${path}[] len=${v.length}`)
    if (v.length) shape(v[0], `${path}[0]`, depth + 1, acc)
    return acc
  }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) shape(val, path ? `${path}.${k}` : k, depth + 1, acc)
    return acc
  }
  acc.push(`${path}: ${typeof v}`)
  return acc
}

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:opencode-auth')
  const cookies = (await ses.cookies.get({ domain: 'opencode.ai' })).filter(
    (c) => (c.domain || '').replace(/^\./, '') === 'opencode.ai' && c.value
  )
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  console.log(`带 ${cookies.length} 个 cookie（${cookies.map((c) => c.name).join(', ')}）\n`)

  for (const p of PATHS) {
    const url = `https://opencode.ai${p}`
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 15_000)
    try {
      const res = await fetch(url, {
        headers: { Cookie: cookie, Accept: 'application/json' },
        redirect: 'manual',
        signal: ac.signal
      })
      const loc = res.headers.get('location')
      const ct = res.headers.get('content-type') || ''
      const body = await res.text()
      let extra = ''
      if (ct.includes('json')) {
        try {
          const lines = shape(JSON.parse(body))
          extra = `\n      ${lines.slice(0, 14).join('\n      ')}`
        } catch {
          /* not json */
        }
      } else {
        extra = ` | ${body.slice(0, 60).replace(/\s+/g, ' ')}`
      }
      console.log(`  ${String(res.status).padEnd(4)} ${p}${loc ? ` → ${loc}` : ''} | ${ct.split(';')[0] || '?'}${extra}`)
    } catch (e) {
      console.log(`  ERR  ${p} — ${e.message}`)
    } finally {
      clearTimeout(timer)
    }
  }

  app.exit(0)
})
