// 定位「Go 页的窗口配额数据」从哪个端点来。
// 手段：打开新控制台 → 点导航里的「Go」→ 抓这一步新增的 xhr。
// 为什么需要：`/console/api/usage/*` 三个端点实测**只有用量聚合**
// （totalCostMicroCents / tokens / services），没有 percent / limit / resetsAt，
// 而余额板主显示要的正是 5 小时 / 周 / 月 的百分比与重置时间。
// 用法：npx electron scripts/opencode-go-page-capture.js
const { app, session, BrowserWindow } = require('electron')
const fs = require('fs')
const { join } = require('path')

app.setName('balancedeck')

app.whenReady().then(async () => {
  const file = join(app.getPath('userData'), 'secrets.bin')
  const wid = JSON.parse(fs.readFileSync(file, 'utf-8')).extras.opencodeWorkspaceId
  const ses = session.fromPartition('persist:opencode-auth')

  const seen = []
  ses.webRequest.onCompleted({ urls: ['*://opencode.ai/*'] }, (d) => {
    if (['Image', 'Font', 'Stylesheet', 'Script'].includes(d.resourceType)) return
    seen.push({ url: d.url, status: d.statusCode, type: d.resourceType })
  })

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 950,
    webPreferences: { partition: 'persist:opencode-auth', nodeIntegration: false, contextIsolation: true, offscreen: true }
  })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  await win.loadURL(`https://opencode.ai/console/${wid}`)
  await sleep(8000)
  console.log('起点:', await win.webContents.executeJavaScript('location.href', true))

  // 点导航里的「Go」
  const clicked = await win.webContents.executeJavaScript(
    `(() => {
      const el = [...document.querySelectorAll('a,button,[role=button]')]
        .find(e => e.innerText.trim() === 'Go')
      if (!el) return 'not-found'
      el.click()
      return 'clicked:' + (el.getAttribute('href') || el.tagName)
    })()`,
    true
  )
  console.log('点 Go:', clicked)
  await sleep(200)
  seen.length = 0 // 只看点进去之后新增的
  await sleep(9000)

  console.log('\n=== 点进 Go 之后的请求')
  const uniq = new Map()
  for (const r of seen) uniq.set(r.url, r)
  for (const [u, r] of uniq) console.log(`  ${String(r.status).padEnd(4)} ${r.type.padEnd(6)} ${u.replace(wid, '<wid>')}`)

  console.log('\n=== Go 页文字')
  console.log(await win.webContents.executeJavaScript(`document.body.innerText.replace(/\\n{2,}/g,'\\n').slice(0, 1500)`, true))

  console.log('\n=== Go 页 DOM 线索')
  console.log(
    await win.webContents.executeJavaScript(
      `(() => {
        const slots = [...new Set([...document.querySelectorAll('[data-slot]')].map(e=>e.dataset.slot))]
        const tables = [...document.querySelectorAll('table')].map(t=>t.innerText.replace(/\\s+/g,' ').slice(0,300))
        const btns = [...new Set([...document.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(Boolean))]
        return JSON.stringify({ slots, tableCount: tables.length, tables, btns: btns.slice(0,20) }, null, 2)
      })()`,
      true
    )
  )

  win.destroy()
  app.exit(0)
})
