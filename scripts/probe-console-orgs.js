// 探针：新控制台里「列出我所属的 org/workspace」该打哪个端点。
// 用现有（已失效的）cookie 探：401 = 端点存在只是要鉴权，404 = 路径不存在。
// 目的：让 workspace 发现不再靠猜路径（现有三条 /workspace、/dashboard、/ 实测全废）。
// 用法：npx electron scripts/probe-console-orgs.js
const { app, session } = require('electron')
const fs = require('fs')
const { join } = require('path')

app.setName('balancedeck')

const CANDIDATES = [
  '/console/api/orgs',
  '/console/api/org',
  '/console/api/user',
  '/console/api/session',
  '/console/api/me',
  '/console/api/auth/session',
  '/console/api/members',
  '/console/api/service-accounts'
]

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:opencode-auth')
  const cookies = (await ses.cookies.get({ domain: 'opencode.ai' })).filter(
    (c) => (c.domain || '').replace(/^\./, '') === 'opencode.ai' && c.value
  )
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ')

  const file = join(app.getPath('userData'), 'secrets.bin')
  const wid = JSON.parse(fs.readFileSync(file, 'utf-8')).extras?.opencodeWorkspaceId || ''

  console.log('=== 带 cookie + x-org-id（两种前缀各试一次）')
  for (const p of CANDIDATES) {
    const url = `https://opencode.ai${p}`
    const results = []
    for (const header of [wid, 'org_probe', '']) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 12_000)
      const headers = { Cookie: cookie, Accept: 'application/json' }
      if (header) headers['x-org-id'] = header
      try {
        const res = await fetch(url, { headers, redirect: 'manual', signal: ac.signal })
        results.push(`${res.status}${res.status === 404 ? '(无此路径)' : res.status === 401 ? '(需鉴权)' : ''}`)
      } catch (e) {
        results.push(`ERR:${e.name}`)
      } finally {
        clearTimeout(timer)
      }
    }
    console.log(`  ${p.padEnd(34)} → ${results.join(' / ')}`)
  }

  console.log('\n含义：401 = 端点存在（只差有效会话），404 = 路径不存在。')
  app.exit(0)
})
