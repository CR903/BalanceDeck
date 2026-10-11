// 研究探针：live 探测新版 opencode 控制台端点（不打印任何明文凭据/金额明细，只看结构）。
// 用法：npx electron scripts/probe-console-live.js
const { app, session, safeStorage } = require('electron')
const { join } = require('path')
const os = require('os')
const fs = require('fs')

const ORIGIN = 'https://opencode.ai/console'

// 必须以 balancedeck 身份运行：safeStorage 密钥与 partition 都挂在 app 名下
app.setName('balancedeck')
app.setPath('userData', join(os.homedir(), 'Library', 'Application Support', 'balancedeck'))

function readSaved() {
  const p = join(os.homedir(), 'Library', 'Application Support', 'balancedeck', 'secrets.bin')
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
    const items = data.items || {}
    const extras = data.extras || {}
    const dec = (v) => (v.startsWith('plain:') ? Buffer.from(v.slice(6), 'base64').toString('utf-8') : safeStorage.decryptString(Buffer.from(v, 'base64')))
    let cookie = ''
    let wid = extras.opencodeWorkspaceId || ''
    const ids = []
    for (const [id, v] of Object.entries(items)) {
      try {
        const plain = dec(v)
        ids.push(`${id}(len=${plain.length},auth=${/auth=/.test(plain)})`)
        if (id === 'opencodeCookie' || /auth=/.test(plain)) cookie = plain
      } catch (e) { ids.push(`${id}(解密失败:${e.message})`) }
    }
    return { cookie, wid, ids, extras: Object.keys(extras) }
  } catch (e) {
    return { cookie: '', wid: '', err: e.message }
  }
}

async function getLiveCookie() {
  try {
    const ses = session.fromPartition('persist:opencode-auth')
    const cookies = await ses.cookies.get({ domain: 'opencode.ai' })
    console.log('partition 全部 cookie: ' + cookies.map((c) => `${c.name}@${c.domain}`).join(', '))
    const rel = cookies.filter((c) => (c.domain || '').replace(/^\./, '') === 'opencode.ai' && c.name && c.value)
    if (!rel.some((c) => c.name === 'auth')) return null
    return rel.map((c) => `${c.name}=${c.value}`).join('; ')
  } catch (e) {
    return { err: e.message }
  }
}

function shape(v, path = '', depth = 0, acc = []) {
  if (depth > 5) return acc
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

async function hit(name, url, headers) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 12000)
    const res = await fetch(url, { headers, signal: ctrl.signal })
    const text = await res.text()
    clearTimeout(t)
    let json = null
    try { json = JSON.parse(text) } catch { /* non-json */ }
    console.log(`\n[${name}] GET ${url.replace(ORIGIN, '')}`)
    console.log(`  HTTP ${res.status} | ${text.length}B`)
    if (res.status === 200 && json) {
      for (const line of shape(json)) console.log(`    ${line}`)
    } else {
      console.log('    body(前120): ' + text.slice(0, 120).replace(/\s+/g, ' '))
    }
  } catch (e) {
    console.log(`\n[${name}] GET ${url.replace(ORIGIN, '')}`)
    console.log('  请求失败: ' + e.message)
  }
}

app.whenReady().then(async () => {
  const saved = readSaved()
  const live = await getLiveCookie()
  let cookie = saved.cookie
  let wid = saved.wid
  let src = 'saved(secrets.bin)'
  if (typeof live === 'string' && live) { cookie = live; src = 'partition(实时)' }
  else if (live && live.err) console.log('partition 读取失败（可能被运行中实例占用）: ' + live.err)

  console.log('凭据来源: ' + src)
  console.log('secrets items: ' + (saved.ids || []).join(', '))
  console.log('secrets extras keys: ' + (saved.extras || []).join(', '))
  console.log('workspaceId: ' + (wid ? wid.slice(0, 8) + '…(' + wid.length + ')' : '(无)'))
  console.log('cookie: ' + (cookie ? '长度 ' + cookie.length : '(无)'))
  if (!cookie) { app.quit(); return }

  const H = (orgId) => {
    const h = { Cookie: cookie, Accept: 'application/json' }
    if (orgId) h['x-org-id'] = orgId
    return h
  }

  // /api/orgs 里翻出 org id（若 extras 里没有）
  if (!wid) {
    try {
      const r = await fetch(`${ORIGIN}/api/orgs`, { headers: H() })
      const t = await r.text()
      const m = t.match(/(?:org_|wrk_)[A-Za-z0-9_-]{8,}/)
      console.log(`/api/orgs → HTTP ${r.status}` + (m ? ` 发现 id ${m[0].slice(0, 8)}…` : ''))
      if (m) wid = m[0]
    } catch (e) { console.log('/api/orgs 失败: ' + e.message) }
  }

  console.log('\n──────── 探测开始 ────────')
  await hit('usage/summary 7d', `${ORIGIN}/api/usage/summary?range=7d`, H(wid))
  await hit('usage/models 7d', `${ORIGIN}/api/usage/models?range=7d&page=1&pageSize=50`, H(wid))
  await hit('usage/models 24h', `${ORIGIN}/api/usage/models?range=24h&page=1&pageSize=50`, H(wid))
  await hit('usage/models since(5h前)', `${ORIGIN}/api/usage/models?range=24h&since=${encodeURIComponent(new Date(Date.now() - 5 * 3600e3).toISOString())}&page=1&pageSize=50`, H(wid))
  await hit('cost-by-day 7d day', `${ORIGIN}/api/usage/cost-by-day?range=7d&bucket=day`, H(wid))
  await hit('cost-by-day 24h hour', `${ORIGIN}/api/usage/cost-by-day?range=24h&bucket=hour`, H(wid))
  await hit('cost-by-day 24h hour since(5h前)', `${ORIGIN}/api/usage/cost-by-day?range=24h&bucket=hour&since=${encodeURIComponent(new Date(Date.now() - 5 * 3600e3).toISOString())}`, H(wid))
  await hit('cost-by-day 30d day', `${ORIGIN}/api/usage/cost-by-day?range=30d&bucket=day`, H(wid))
  await hit('usage/users 7d', `${ORIGIN}/api/usage/users?range=7d&page=1&pageSize=50`, H(wid))
  await hit('go/status (legacy)', `${ORIGIN}/api/go/status`, H(wid))
  await hit('internal orgs/:id/go/status', `${ORIGIN}/api/internal/orgs/${wid}/go/status`, H(wid))
  await hit('billing/status', `${ORIGIN}/api/billing/status`, H(wid))
  await hit('billing/account', `${ORIGIN}/api/billing/account`, H(wid))
  await hit('budgets/org', `${ORIGIN}/api/budgets/org`, H(wid))
  await hit('providers/opencode', `${ORIGIN}/api/providers/opencode`, H(wid))
  await hit('me/user', `${ORIGIN}/api/user`, H(wid))
  console.log('\n──────── 探测结束 ────────')
  app.quit()
})
