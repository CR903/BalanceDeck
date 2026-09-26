// 一次性诊断：判断 opencode 控制台详情抓取失效的**原因**。
//  - 授权分区的 cookie 是否还在 / 是否过期
//  - `/workspace/<wid>/go` 现在跳到哪里
//  - 换几个新路径形状试探，看是「登录态没了」还是「URL 搬家了」
// 只输出 cookie 名与过期时间，不打印值。
// 用法：npx electron scripts/opencode-probe-auth.js
const { app, session } = require('electron')
const fs = require('fs')
const { join } = require('path')

app.setName('balancedeck')

const CANDIDATES = [
  (w) => `https://opencode.ai/workspace/${w}/go`,
  (w) => `https://opencode.ai/console/workspace/${w}/go`,
  (w) => 'https://opencode.ai/console',
  (w) => 'https://opencode.ai/console/login',
]

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:opencode-auth')
  const raw = (await ses.cookies.get({ domain: 'opencode.ai' })).filter(
    (c) => (c.domain || '').replace(/^\./, '') === 'opencode.ai' && c.value
  )
  const now = Date.now() / 1000
  console.log(`=== cookie（${raw.length} 条，只列名/过期）`)
  for (const c of raw) {
    const expired = c.expirationDate !== undefined && c.expirationDate < now
    console.log(
      `  ${c.name.padEnd(28)} ${expired ? '已过期' : '有效'}  ${c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : 'session'}`
    )
  }
  const cookie = raw.map((c) => `${c.name}=${c.value}`).join('; ')
  console.log(`  有 auth cookie: ${raw.some((c) => c.name === 'auth')}`)

  const file = join(app.getPath('userData'), 'secrets.bin')
  const wid = JSON.parse(fs.readFileSync(file, 'utf-8')).extras?.opencodeWorkspaceId
  console.log(`\n=== workspaceId: ${wid || '(未保存)'}`)

  console.log('\n=== 用 cookie 直连（redirect: manual，看首跳）')
  for (const mk of CANDIDATES) {
    const url = mk(wid)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 15000)
    try {
      const res = await fetch(url, {
        headers: { Cookie: cookie, Accept: 'text/html' },
        redirect: 'manual',
        signal: ac.signal
      })
      const loc = res.headers.get('location')
      let note = ''
      if (res.status < 300 || res.status >= 400) {
        const body = await res.text()
        const slots = new Set([...body.matchAll(/data-slot="([^"]+)"/g)].map((m) => m[1]))
        note = ` | ${body.length} 字符 | data-slot ${slots.size} 个${slots.size ? ': ' + [...slots].slice(0, 6).join(',') : ''}`
        if (/每月配额|Monthly quota/i.test(body)) note += ' | ★含「每月配额」'
      }
      console.log(`  ${res.status} ${url.replace(wid, '<wid>')}${loc ? ' → ' + loc : ''}${note}`)
    } catch (e) {
      console.log(`  ERR ${url.replace(wid, '<wid>')} — ${e.message}`)
    } finally {
      clearTimeout(timer)
    }
  }

  app.exit(0)
})
