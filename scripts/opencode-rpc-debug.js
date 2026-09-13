// 诊断：拦截页面里的 _server RPC 调用，看请求/响应细节
const { app, session, BrowserWindow } = require('electron')
const fs = require('fs')
const { join } = require('path')

app.setName('balancedeck')

app.whenReady().then(async () => {
  const wid = JSON.parse(fs.readFileSync(join(app.getPath('userData'), 'secrets.bin'), 'utf-8')).extras?.opencodeWorkspaceId
  const url = `https://opencode.ai/workspace/${wid}/go`

  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 900,
    webPreferences: { partition: 'persist:opencode-auth', nodeIntegration: false, contextIsolation: true, offscreen: true }
  })

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`[console:${level}]`, message.slice(0, 300))
  })

  await new Promise((resolve) => {
    const t = setTimeout(resolve, 25000)
    win.webContents.once('did-finish-load', () => {
      clearTimeout(t)
      resolve()
    })
    void win.loadURL(url)
  })
  await new Promise((r) => setTimeout(r, 2500))

  // 注入 fetch 拦截器（在页面上下文，能在点击前生效）
  await win.webContents.executeJavaScript(
    `(() => {
       if (window.__rpcPatched) return 'already';
       window.__rpcPatched = true;
       window.__rpcLog = [];
       const orig = window.fetch;
       window.fetch = async function (...args) {
         const [input, init] = args;
         const u = typeof input === 'string' ? input : (input && input.url) || '';
         const isServer = u.includes('_server');
         const res = await orig.apply(this, args);
         if (isServer) {
           let body = '';
           try { body = (await res.clone().text()).slice(0, 600); } catch {}
           window.__rpcLog.push({
             url: u,
             serverId: init && init.headers ? (init.headers['X-Server-Id'] || '') : '',
             status: res.status,
             contentType: res.headers.get('content-type') || '',
             body
           });
         }
         return res;
       };
       return 'patched';
     })()`,
    true
  )

  // 点击「每月用量」的详情触发器
  await win.webContents.executeJavaScript(
    `(async () => {
       const sleep = (ms) => new Promise(r => setTimeout(r, ms));
       const items = [...document.querySelectorAll('[data-slot="usage-item"]')];
       const monthly = items.find(i => (i.querySelector('[data-slot="usage-label"]')?.textContent || '').includes('每月'));
       const trigger = monthly?.querySelector('[data-slot="usage-details-trigger"]');
       if (trigger) trigger.click();
       await sleep(4000);
       return true;
     })()`,
    true
  )

  const log = await win.webContents.executeJavaScript('JSON.stringify(window.__rpcLog || [])', true)
  console.log('\n=== _server RPC 调用记录 ===')
  console.log(JSON.stringify(JSON.parse(log), null, 2).slice(0, 2500))

  const state = await win.webContents.executeJavaScript(
    `(() => {
       const items = [...document.querySelectorAll('[data-slot="usage-item"]')];
       const monthly = items.find(i => (i.querySelector('[data-slot="usage-label"]')?.textContent || '').includes('每月'));
       return {
         expanded: monthly?.querySelector('[data-slot="usage-details-trigger"]')?.getAttribute('aria-expanded'),
         hasContent: !!monthly?.querySelector('[data-slot="usage-details-content"]'),
         text: monthly?.textContent?.slice(0, 300)
       };
     })()`,
    true
  )
  console.log('\n=== 展开状态 ===')
  console.log(JSON.stringify(state, null, 2))

  win.destroy()
  app.quit()
})
