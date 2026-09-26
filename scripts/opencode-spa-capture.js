// 现在有有效会话了 —— 打开新控制台的 Go 用量页，抓它**自己**发的所有网络请求。
// 目的：定位「5 小时 / 周 / 月 窗口 + percent + limit + 重置时间」这份数据
// 在新站是从哪个端点来的（`/console/api/usage/*` 只有用量聚合，没有配额窗口）。
// 用法：npx electron scripts/opencode-spa-capture.js
const { app, session, BrowserWindow } = require('electron')
const fs = require('fs')
const { join } = require('path')

app.setName('balancedeck')

app.whenReady().then(async () => {
  const file = join(app.getPath('userData'), 'secrets.bin')
  const wid = JSON.parse(fs.readFileSync(file, 'utf-8')).extras.opencodeWorkspaceId
  const url = `https://opencode.ai/console/workspace/${wid}/go`
  console.log('打开:', url.replace(wid, '<wid>'))

  const ses = session.fromPartition('persist:opencode-auth')
  const seen = []
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
  await sleep(10_000)

  console.log('\n=== 落地 URL（确认登录态）')
  console.log(' ', await win.webContents.executeJavaScript('location.href', true))

  console.log('\n=== 非静态资源的请求（去重）')
  const uniq = new Map()
  for (const r of seen) {
    if (['Image', 'Font', 'Stylesheet'].includes(r.type)) continue
    uniq.set(`${r.method} ${r.url}`, r)
  }
  for (const [k, r] of uniq) console.log(`  ${String(r.status).padEnd(4)} ${r.type.padEnd(10)} ${k.replace(wid, '<wid>')}`)

  console.log('\n=== 页面上的文字（找窗口标签与百分比）')
  const text = await win.webContents.executeJavaScript(
    `document.body.innerText.replace(/\\n{2,}/g,'\\n').slice(0, 1200)`,
    true
  )
  console.log(text)

  console.log('\n=== 展开所有可能的详情控件后，再看 DOM 结构')
  const dom = await win.webContents.executeJavaScript(
    `(() => {
      const slots = [...new Set([...document.querySelectorAll('[data-slot]')].map(e=>e.dataset.slot))]
      const btns = [...new Set([...document.querySelectorAll('button,[role=button]')]
        .map(b=>b.innerText.trim()).filter(Boolean))]
      const tables = [...document.querySelectorAll('table')].map(t=>t.innerText.replace(/\\s+/g,' ').slice(0,200))
      return JSON.stringify({ slots, btns: btns.slice(0,25), tableCount: tables.length, tables }, null, 2)
    })()`,
    true
  )
  console.log(dom)

  win.destroy()
  app.exit(0)
})
