// 诊断：用已保存的 OpenCode cookie 抓取控制台页面，看看到底发生了什么。
// 只输出结构信息与掩码，不打印 cookie 明文。
// 用法：npx electron scripts/opencode-cookie-debug.js
const { app, safeStorage } = require('electron')
const { join } = require('path')
const fs = require('fs')

app.setName('balancedeck') // 与主应用一致，才能解密同一钥匙串条目

app.whenReady().then(async () => {
  const file = join(app.getPath('userData'), 'secrets.bin')
  if (!fs.existsSync(file)) {
    console.log('未找到 secrets.bin:', file)
    return app.quit()
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const enc = data.items?.opencodeCookie
  if (!enc) {
    console.log('未保存 opencodeCookie')
    return app.quit()
  }

  let cookie
  try {
    cookie = enc.startsWith('plain:')
      ? Buffer.from(enc.slice(6), 'base64').toString('utf-8')
      : safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch (e) {
    console.log('解密失败:', e.message)
    return app.quit()
  }

  const wid = data.extras?.opencodeWorkspaceId
  console.log('cookie 形态:', cookie.slice(0, 5) + '…' + cookie.slice(-4), '| 长度', cookie.length)
  console.log('cookie 段:', cookie.split(';').map((s) => s.trim().split('=')[0]).join(', '))
  console.log('workspaceId:', wid ? wid.slice(0, 8) + '…' + wid.slice(-4) : '(未保存)')

  const url = `https://opencode.ai/workspace/${wid}/go`
  console.log('\n请求:', url)
  try {
    const res = await fetch(url, { headers: { Cookie: cookie, Accept: 'text/html' }, redirect: 'manual' })
    console.log('HTTP', res.status, '| location:', res.headers.get('location') || '(无)')
    const html = await res.text()
    console.log('HTML 长度:', html.length)
    console.log('含 usage-item:', html.includes('usage-item'))
    console.log('含 usage-value:', html.includes('usage-value'))
    console.log('含 login/auth 关键字:', /sign in|log in|登录|OpenAuth/i.test(html))
    // 打印标题与若干 data-slot 名称，帮助判断页面结构
    const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]
    console.log('title:', title || '(无)')
    const slots = [...new Set([...html.matchAll(/data-slot="([^"]+)"/g)].map((m) => m[1]))]
    console.log('data-slot 列表:', slots.slice(0, 25).join(', ') || '(无)')
    if (!html.includes('usage-item')) {
      console.log('\n--- HTML 片段（前 600 字符，去除多余空白）---')
      console.log(html.slice(0, 600).replace(/\s+/g, ' '))
    }
  } catch (e) {
    console.log('请求失败:', e.message)
  }
  app.quit()
})
