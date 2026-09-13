// 诊断：用 opencode-auth 分区里的实时 cookie 请求控制台页面，判断 cookie 是否有效。
// 用法：npx electron scripts/opencode-console-fetch.js
const { app, session } = require('electron')

app.setName('balancedeck')

async function tryFetch(label, cookie, url) {
  try {
    const res = await fetch(url, { headers: { Cookie: cookie, Accept: 'text/html' }, redirect: 'manual' })
    const html = res.status === 200 ? await res.text() : ''
    const hasUsage = html.includes('usage-item')
    console.log(
      `  [${label}] HTTP ${res.status}` +
        (res.headers.get('location') ? ` → ${res.headers.get('location')}` : '') +
        (res.status === 200 ? ` | HTML ${html.length} | usage-item=${hasUsage}` : '')
    )
    return { ok: res.status === 200 && hasUsage, html }
  } catch (e) {
    console.log(`  [${label}] 请求失败: ${e.message}`)
    return { ok: false, html: '' }
  }
}

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:opencode-auth')
  const cookies = await ses.cookies.get({ domain: 'opencode.ai' })
  const auth = cookies.find((c) => c.name === 'auth')
  if (!auth) {
    console.log('分区内没有 auth cookie')
    return app.quit()
  }
  const cookie = `auth=${auth.value}; oc_locale=en`
  console.log('分区 auth cookie 长度:', auth.value.length)

  const wid = (await ses.cookies.get({})).length ? undefined : undefined
  // 从已保存 extras 读 workspace
  const fs = require('fs')
  const { join } = require('path')
  const file = join(app.getPath('userData'), 'secrets.bin')
  let workspaceId = ''
  try {
    workspaceId = JSON.parse(fs.readFileSync(file, 'utf-8')).extras?.opencodeWorkspaceId || ''
  } catch {}

  console.log('\n测试 1：workspace 用量页')
  await tryFetch('usage', cookie, `https://opencode.ai/workspace/${workspaceId}/go`)

  console.log('\n测试 2：控制台首页')
  const r2 = await tryFetch('home', cookie, 'https://opencode.ai/workspace')
  if (r2.html) {
    const wrks = [...new Set([...r2.html.matchAll(/wrk_[A-Za-z0-9]{8,}/g)].map((m) => m[0]))]
    console.log('    从首页提取到 workspace:', wrks.slice(0, 5).join(', ') || '(无)')
  }

  console.log('\n测试 3：不带 cookie（对照）')
  await tryFetch('no-cookie', '', `https://opencode.ai/workspace/${workspaceId}/go`)

  app.quit()
})
