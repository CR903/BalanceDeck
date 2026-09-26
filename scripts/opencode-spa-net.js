// 探针：在真实窗口里水合新版控制台 SPA，**抓它自己发的网络请求**。
// 目的是找出「SPA 从哪个 JSON 端点取用量」—— 如果有端点，就可以带 cookie 直接调，
// 比解析 DOM 稳健得多（SPA 改版只改 DOM 不改 API）。
// 只输出 URL 与状态码，不打印 cookie / 响应体明文。
// 用法：npx electron scripts/opencode-spa-net.js
const { app, session, BrowserWindow } = require('electron')
const fs = require('fs')
const { join } = require('path')

app.setName('balancedeck')

const seen = []

app.whenReady().then(async () => {
  const file = join(app.getPath('userData'), 'secrets.bin')
  const wid = JSON.parse(fs.readFileSync(file, 'utf-8')).extras?.opencodeWorkspaceId
  const url = `https://opencode.ai/console/workspace/${wid}/go`
  console.log('打开:', url.replace(wid, '<wid>'))

  const ses = session.fromPartition('persist:opencode-auth')

  // 钩住所有请求：SPA 起来后要记录它自己发什么
  ses.webRequest.onCompleted({ urls: ['*://opencode.ai/*'] }, (d) => {
    seen.push({ url: d.url, status: d.statusCode, type: d.resourceType, method: d.method })
  })

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 950,
    webPreferences: { partition: 'persist:opencode-auth', nodeIntegration: false, contextIsolation: true, offscreen: true }
  })
  await win.loadURL(url)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  await sleep(9000)

  console.log('\n=== 页面实际落地 URL（确认登录态）')
  console.log(' ', await win.webContents.executeJavaScript('location.href', true))

  console.log('\n=== 浏览器观测到的请求（去重，只留非静态资源）')
  const uniq = new Map()
  for (const r of seen) {
    if (r.type === 'Image' || r.type === 'Font' || r.type === 'Stylesheet') continue
    uniq.set(`${r.method} ${r.url}`, r)
  }
  for (const [k, r] of uniq) {
    console.log(`  ${String(r.status).padEnd(4)} ${r.type.padEnd(10)} ${k}`)
  }

  console.log('\n=== performance 资源条目里的 XHR/fetch（同源）')
  const perf = await win.webContents.executeJavaScript(
    `JSON.stringify(performance.getEntriesByType('resource')
       .map(e=>e.name)
       .filter(n=>n.includes('/api/')||n.includes('zen')||n.includes('usage')||n.includes('rpc')||n.includes('trpc')||n.includes('/go')))`,
    true
  )
  console.log(' ', perf)

  console.log('\n=== 水合后的 DOM 结构（找表格 / 展开控件）')
  const dom = await win.webContents.executeJavaScript(
    `(() => {
      const slots = [...new Set([...document.querySelectorAll('[data-slot]')].map(e=>e.dataset.slot))]
      const tables = [...document.querySelectorAll('table')].map(t=>t.innerText.replace(/\\s+/g,' ').slice(0,160))
      const buttons = [...new Set([...document.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(Boolean))].slice(0,30)
      const heads = [...new Set([...document.querySelectorAll('h1,h2,h3,h4')].map(h=>h.innerText.trim()))].slice(0,20)
      return JSON.stringify({ slots, tableCount: tables.length, tables, buttons, heads,
        bodyLen: document.body.innerText.length,
        bodyHead: document.body.innerText.replace(/\\s+/g,' ').slice(0,400) }, null, 2)
    })()`,
    true
  )
  console.log(dom)

  win.destroy()
  app.exit(0)
})
