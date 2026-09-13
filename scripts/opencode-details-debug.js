// 诊断：隐藏窗口抓取控制台每模型明细（可加 --show 参数显示窗口）
const { app, session, BrowserWindow } = require('electron')
const fs = require('fs')
const { join } = require('path')

app.setName('balancedeck')
const SHOW = process.argv.includes('--show')

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:opencode-auth')
  const wid = JSON.parse(fs.readFileSync(join(app.getPath('userData'), 'secrets.bin'), 'utf-8')).extras?.opencodeWorkspaceId
  const url = `https://opencode.ai/workspace/${wid}/go`
  console.log('加载:', url, '| 可见:', SHOW)

  const win = new BrowserWindow({
    show: SHOW,
    width: 1100,
    height: 900,
    webPreferences: { partition: 'persist:opencode-auth', nodeIntegration: false, contextIsolation: true, offscreen: !SHOW }
  })

  await new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 25000)
    win.webContents.once('did-finish-load', () => {
      clearTimeout(t)
      resolve('ok')
    })
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      clearTimeout(t)
      console.log('加载失败:', code, desc)
      resolve('fail')
    })
    void win.loadURL(url)
  })

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  await sleep(2500)

  // 1) 页面基本结构
  const info = await win.webContents.executeJavaScript(
    `(() => ({
        items: document.querySelectorAll('[data-slot="usage-item"]').length,
        triggers: document.querySelectorAll('[data-slot="usage-details-trigger"]').length,
        labels: [...document.querySelectorAll('[data-slot="usage-label"]')].map(e => e.textContent.trim()),
        url: location.href
      }))()`,
    true
  )
  console.log('页面结构:', JSON.stringify(info))

  if (info.triggers > 0) {
    // 2) 点击第一个触发器并观察
    const afterClick = await win.webContents.executeJavaScript(
      `(async () => {
         const sleep = (ms) => new Promise(r => setTimeout(r, ms));
         const item = document.querySelector('[data-slot="usage-item"]');
         const trigger = item.querySelector('[data-slot="usage-details-trigger"]');
         trigger.click();
         await sleep(3000);
         const content = item.querySelector('[data-slot="usage-details-content"]');
         const table = content ? content.querySelector('table') : null;
         const rows = table ? [...table.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim())) : [];
         return {
           expanded: trigger.getAttribute('aria-expanded'),
           hasContent: !!content,
           hasTable: !!table,
           rowCount: rows.length,
           firstRows: rows.slice(0, 4),
           contentHTML: content ? content.innerHTML.slice(0, 500) : null
         };
       })()`,
      true
    )
    console.log('点击后:', JSON.stringify(afterClick, null, 2))
  } else {
    console.log('未找到触发器，页面可能未水合。HTML 片段:')
    const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML.slice(0, 800)', true)
    console.log(html)
  }

  win.destroy()
  app.quit()
})
