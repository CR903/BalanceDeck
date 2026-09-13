import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { createOverlay, toggleOverlay, loadPersisted, getOverlay } from './overlay'
import { createTray, updateTray, currentTrayTitle, trayImageInfo } from './tray'
import { startScheduler, refreshNow, currentState, stopScheduler } from './scheduler'
import { registerIpc, consumeDragFired } from './ipc'
import type { AppState } from '../shared/types'

// --smoke：构建验证模式。采集一轮后把快照写到 stdout 并自动退出，不留常驻窗口。
const smoke = process.argv.includes('--smoke')
// --uitest：UI 交互自动化测试（模拟点击/拖拽/刷新，断言窗口与 DOM 状态）
const uitest = process.argv.includes('--uitest')
// --shots：设计走查截图（主页 / 详情 / 设置），产物在 /tmp/balancedeck-shots/
const shots = process.argv.includes('--shots')
// --details-test：控制台每模型明细抓取自检（一次性抓取并打印，用于排障）
const detailsTest = process.argv.includes('--details-test')

app.dock?.hide?.()

loadPersisted()
registerIpc()

function pushState(s: AppState): void {
  // ⚠️ 必须显式发给悬浮窗：控制台明细抓取会临时创建一个隐藏窗口，
  // 若用 BrowserWindow.getAllWindows()[0] 可能把状态推给隐藏窗口 → 界面永远停在骨架屏。
  getOverlay()?.webContents.send('state:snapshot', s)
}

app.whenReady().then(async () => {
  if (detailsTest) {
    void (async () => {
      const { getExtra } = await import('./keystore')
      const { fetchConsoleDetailsNow } = await import('./opencode-details')
      const wid = (await getExtra('opencodeWorkspaceId')) ?? process.env.OPENCODE_GO_WORKSPACE_ID ?? ''
      process.stdout.write(`workspaceId: ${wid ? wid.slice(0, 8) + '…' : '(未配置)'}\n`)
      const t0 = Date.now()
      const data = await fetchConsoleDetailsNow(wid)
      process.stdout.write(`抓取耗时: ${Date.now() - t0}ms | 结果: ${data ? JSON.stringify(Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])), null, 1) : 'null'}\n`)
      if (data?.monthly?.length) {
        process.stdout.write('monthly 前 3 行:\n')
        for (const r of data.monthly.slice(0, 3)) {
          process.stdout.write(`  ${r.model} | $${r.usageUsd} | $${r.quotaUsd} | ${r.percent}%\n`)
        }
      }
      app.quit()
    })()
    return
  }

  if (shots) {
    const win = createOverlay()
    // 预热控制台每模型明细缓存（否则首轮采集还没有明细，截图看不到表）
    try {
      const { getExtra } = await import('./keystore')
      const { fetchConsoleDetailsNow } = await import('./opencode-details')
      const wid = (await getExtra('opencodeWorkspaceId')) ?? ''
      if (wid) await fetchConsoleDetailsNow(wid)
    } catch {
      // 预热失败不影响截图
    }
    startScheduler(pushState, () => {})
    void runShots(win).then(() => app.quit())
    return
  }

  if (smoke || uitest) {
    // 冒烟/测试：建窗口（验证 preload/renderer 加载），采集后输出 JSON 退出
    const win = createOverlay()
    let preloadError = ''
    const consoleErrors: string[] = []
    win.webContents.on('preload-error', (_e, p, err) => {
      preloadError = `${p}: ${err}`
    })
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 3) consoleErrors.push(message.slice(0, 200))
    })
    createTray(toggleOverlay, refreshNow)
    // 托盘回调传真实 updateTray：让 smoke 能验证状态栏文案与图标链路
    startScheduler(pushState, updateTray)
    if (smoke) {
      let rendererRoot = -1
      // 采集等待时长可调（默认 6s；控制台每模型明细为后台抓取，验证时需要更久）
      const waitMs = Number(process.env.SMOKE_WAIT_MS ?? 6000)
      setTimeout(() => {
        win.webContents
          .executeJavaScript("document.getElementById('root')?.children.length ?? -1", true)
          .then((n) => {
            rendererRoot = n
          })
          .catch((e) => {
            preloadError = String(e)
          })
          .finally(() => {
            process.stdout.write(
              JSON.stringify(
                {
                  smoke: true,
                  rendererRoot,
                  preloadError,
                  tray: { title: currentTrayTitle(), ...trayImageInfo() },
                  state: currentState()
                },
                null,
                2
              )
            )
            app.quit()
          })
      }, waitMs)
      return
    }
    void runUiTest(win, consoleErrors).then((results) => {
      process.stdout.write(JSON.stringify({ uitest: true, consoleErrors, ...results }, null, 2))
      app.quit()
    })
    return
  }

  createOverlay()
  createTray(toggleOverlay, refreshNow)
  startScheduler(pushState, updateTray)
})

app.on('window-all-closed', () => {
  // 悬浮组件常驻：不因窗口关闭退出（托盘仍在）
  if (smoke) app.quit()
})

app.on('before-quit', () => {
  stopScheduler()
})

// —— 设计走查截图 ——
async function runShots(win: Electron.BrowserWindow): Promise<void> {
  const { mkdirSync, writeFileSync } = await import('fs')
  const { setSkin } = await import('./skins')
  const OUT = '/tmp/balancedeck-shots'
  mkdirSync(OUT, { recursive: true })
  // 默认皮肤 aero（走查用），避免历史皮肤干扰
  await setSkin('aero')
  const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))
  const exec = (js: string): Promise<unknown> => win.webContents.executeJavaScript(js, true)
  const shoot = async (name: string, rect?: { x: number; y: number; width: number; height: number }): Promise<void> => {
    const img = rect ? await win.webContents.capturePage(rect) : await win.webContents.capturePage()
    writeFileSync(`${OUT}/${name}.png`, img.toPNG())
    process.stdout.write(`shot: ${name}\n`)
  }

  await sleep(6500)
  // 走查"断网/缓存"形态时需要一个真实快照做底模
  await exec('window.api.getState().then((s) => { window.__bd_state_snapshot = s.snapshots })')
  await exec('window.api.expand()')
  await sleep(900)
  await shoot('1-card')
  await shoot('1-corner', { x: 0, y: 0, width: 80, height: 80 })
  if (await exec("!!document.querySelector('.pcard')")) {
    await exec("document.querySelector('.pcard')?.click()")
    await sleep(800)
    await shoot('2-detail')
    // 展开第一个窗口的「显示详情」，截取每模型表（控制台口径）
    await exec("document.querySelector('.dwin-toggle')?.click()")
    await sleep(700)
    await exec("document.querySelector('.wmodels')?.scrollIntoView({ block: 'center' })")
    await sleep(500)
    await shoot('2b-detail-models')
    await exec("[...document.querySelectorAll('.icon-btn')].find(b=>b.title==='返回')?.click()")
    await sleep(600)
  }
  await exec("[...document.querySelectorAll('.btn-secondary')].find(b=>b.textContent.includes('设置'))?.click()")
  await sleep(900)
  await shoot('3-settings')
  // 添加提供方目录（含供应商 logo，走查图标可读性）
  await exec("[...document.querySelectorAll('.add-btn')].find(b=>b.textContent.includes('添加提供方'))?.click()")
  await sleep(600)
  await exec("document.querySelector('.picker')?.scrollIntoView({block:'center'})")
  await sleep(400)
  await shoot('3b-settings-picker')
  await exec("[...document.querySelectorAll('.add-btn')].find(b=>b.textContent.includes('添加提供方'))?.click()")
  await sleep(400)

  await exec("document.querySelector('.settings-body')?.scrollTo(0, 99999)")
  await sleep(500)
  await exec("[...document.querySelectorAll('.add-btn')].find(b=>b.textContent.includes('自定义'))?.click()")
  await sleep(700)
  await exec("document.querySelector('.custom-form')?.scrollIntoView({block:'center'})")
  await sleep(500)
  await shoot('4-settings-custom')

  // 高级设置（OpenCode 控制台精度增强）
  await exec("document.querySelector('.custom-form .btn-secondary')?.click()")
  await sleep(400)
  await exec("document.querySelector('[data-provider-id] .mini-btn')?.click()")
  await sleep(700)
  await exec("document.querySelector('.advanced-head')?.click()")
  await sleep(600)
  await exec("document.querySelector('.advanced')?.scrollIntoView({block:'center'})")
  await sleep(500)
  await shoot('6-settings-advanced')
  // 收起态圆点
  await exec("[...document.querySelectorAll('.icon-btn')].find(b=>b.title==='返回')?.click()")
  await sleep(500)
  await exec("[...document.querySelectorAll('.btn-secondary')].find(b=>b.textContent.includes('收起'))?.click()")
  await sleep(1200)
  await shoot('5-dot')

  // 断网 / 缓存态（数据诚实性的设计走查）：注入 cached 快照 + offline
  await exec('window.api.expand()')
  await sleep(700)
  await exec(
    `window.api.debugPush(
      window.__bd_state_snapshot.map((s) => ({ ...s, dataQuality: 'cached', dataAt: new Date(Date.now() - 8 * 60000).toISOString(), degradedReason: '官方接口不可达（fetch failed）' })),
      true
    )`
  )
  await sleep(700)
  await shoot('7-offline-cards')

  // 拖拽排序预览（走查：被拖卡片抬起跟手 + 其余卡片让位，且 DOM 顺序不变）
  // 等采集空闲：采集完成后会推送新快照重建卡片，拖到一半会失效
  for (let i = 0; i < 40; i++) {
    if (!(await exec('window.api.getState().then(s=>!!s.scanning)'))) break
    await sleep(250)
  }
  await sleep(600)
  await exec(`(async()=>{
    const cards=[...document.querySelectorAll('[data-card-id]')]
    if(cards.length<2) return
    const a=cards[0], b=cards[1]
    const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect()
    const base={pointerId:31,bubbles:true,pointerType:'mouse',button:0,isPrimary:true}
    const at=(x,y)=>({...base,clientX:x,clientY:y})
    a.dispatchEvent(new PointerEvent('pointerdown',at(ra.x+40,ra.y+40)))
    for(let i=1;i<=6;i++){
      window.dispatchEvent(new PointerEvent('pointermove',at(ra.x+40+(rb.x-ra.x)*i/6,ra.y+40+(rb.y-ra.y)*i/6)))
      await new Promise(r=>setTimeout(r,30))
    }
  })()`)
  await sleep(500)
  process.stdout.write(
    'dragProbe: ' +
      String(
        await exec(
          "[...document.querySelectorAll('[data-card-id]')].map(c=>c.dataset.cardId+':t='+(c.style.transform||'-')+':cs='+getComputedStyle(c).transform).join(' | ')"
        )
      ) +
      '\n'
  )
  await shoot('8-drag-preview')
  await exec("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
  await sleep(500)
  await shoot('8b-drag-cancelled')
  await exec("document.querySelector('[data-card-id]')?.click()")
  await sleep(800)
  await shoot('7b-offline-detail')
}

// —— UI 交互自动化测试 ——
async function runUiTest(
  win: Electron.BrowserWindow,
  consoleErrors: string[]
): Promise<Record<string, string>> {
  const r: Record<string, string> = {}
  const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))
  const exec = (js: string): Promise<unknown> => win.webContents.executeJavaScript(js, true)
  const bounds = (): Electron.Rectangle => win.getBounds()
  const dotClickJs = (px = 20): string => `(()=>{
    const b=document.querySelector('.dot-btn'); if(!b) return 'no-dot'
    const rc=b.getBoundingClientRect()
    const o={clientX:rc.x+${px},clientY:rc.y+${px},pointerId:7,bubbles:true,pointerType:'mouse',button:0}
    b.dispatchEvent(new PointerEvent('pointerdown',o))
    b.dispatchEvent(new PointerEvent('pointerup',o))
    return 'sent'
  })()`

  // 等首轮采集真正拿到数据（API + 本地库解析 + 控制台 cookie，最长 30s）
  for (let i = 0; i < 60; i++) {
    const n = (await exec('window.api.getState().then(s=>s.snapshots.length)')) as number
    if (n > 0) break
    await sleep(500)
  }
  await sleep(600)
  r.snapDiag = String(
    await exec('window.api.getState().then(s=>s.snapshots.map(x=>x.name+":"+x.status+"/w"+x.windows.length).join(", ")+" | scanning="+s.scanning+" | offline="+s.offline)')
  )
  // 归零：强制展开（历史持久化可能是收起态）
  await exec('window.api.expand()')
  await sleep(900)
  r.card = (await exec("!!document.querySelector('.card .titlebar')")) ? 'ok' : 'fail:no-card'
  r.cardGrid = (await exec("!!document.querySelector('.pcard-grid') || !!document.querySelector('.empty-state')")) ? 'ok' : 'fail:no-grid'

  // 卡片点击 → 详情（div 卡片：onClick 打开）
  const hasCard = (await exec("!!document.querySelector('[data-card-id]')")) as boolean
  if (hasCard) {
    await exec("document.querySelector('[data-card-id]')?.click()")
    await sleep(700)
    r.detailOpen = (await exec("!!document.querySelector('.card.detail')")) ? 'ok' : 'fail'
    r.detailWindows = (await exec("!!document.querySelector('.dwin') || !!document.querySelector('.empty-state')")) ? 'ok' : 'fail'
    await exec("[...document.querySelectorAll('.icon-btn')].find(b=>b.title==='返回')?.click()")
    await sleep(600)
    r.detailBack = (await exec("!!document.querySelector('.pcard-grid') || !!document.querySelector('.empty-state')")) ? 'ok' : 'fail'
  } else {
    r.detailOpen = 'skipped:no-card'
    r.detailWindows = 'skipped:no-card'
    r.detailBack = 'skipped:no-card'
  }

  // 收起（底部按钮区）
  const footerClick = (label: string): string =>
    `[...document.querySelectorAll('.btn-secondary')].find(b=>b.textContent.includes('${label}'))?.click()??'no-btn'`

  r.footerBtns = String(await exec(`JSON.stringify([...document.querySelectorAll('.btn-secondary')].map(b=>b.textContent))`))
  await exec(footerClick('收起'))
  await sleep(900)
  const b1 = bounds()
  r.collapse = b1.width <= 60 && b1.height <= 60 ? 'ok' : `fail:${b1.width}x${b1.height}`
  r.dotDom = (await exec("!!document.querySelector('.dot-btn')")) ? 'ok' : 'fail'

  // 拖拽：>8px 判拖拽，不展开；窗口位置变化；随后圆点仍在
  const before = bounds()
  await exec(`(async()=>{
    const b=document.querySelector('.dot-btn'); if(!b) return
    const rc=b.getBoundingClientRect()
    const o={clientX:rc.x+10,clientY:rc.y+10,pointerId:8,bubbles:true,pointerType:'mouse',button:0}
    b.dispatchEvent(new PointerEvent('pointerdown',o))
    for(let i=1;i<=6;i++){
      b.dispatchEvent(new PointerEvent('pointermove',{...o,clientX:rc.x+10+i*9,clientY:rc.y+10}))
      await new Promise(res=>setTimeout(res,40))
    }
    b.dispatchEvent(new PointerEvent('pointerup',o))
  })()`)
  await sleep(900)
  const after = bounds()
  r.dragNoExpand = (await exec("!!document.querySelector('.dot-btn')")) ? 'ok' : 'fail:expanded'
  r.dragMoved = after.x !== before.x || after.y !== before.y ? 'ok' : 'no-real-cursor-move'
  r.dragFired = consumeDragFired() ? 'ok' : 'fail'

  // 圆点点击 → 展开（bug1 回归，放在拖拽之后验证拖拽不卡死点击）
  await exec(dotClickJs())
  await sleep(900)
  const b2 = bounds()
  r.dotClickExpand = b2.width > 300 ? 'ok' : `fail:${b2.width}x${b2.height}`
  r.cardBack = (await exec("!!document.querySelector('.pcard-grid') || !!document.querySelector('.empty-state')")) ? 'ok' : 'fail'

  // 拖拽后再点击仍能展开（假死回归）
  await exec(dotClickJs())
  await sleep(900)
  r.reClickExpand = bounds().width > 300 ? 'ok' : 'fail'

  // 圆点漂移回归：收起→展开→收起→展开 两轮循环后，展开态位置必须回到原位
  const d0 = bounds()
  for (let i = 0; i < 2; i++) {
    await exec(footerClick('收起'))
    await sleep(600)
    await exec(dotClickJs())
    await sleep(800)
  }
  const d2 = bounds()
  r.noDrift =
    d2.x === d0.x && d2.y === d0.y ? 'ok' : `fail:(${d0.x},${d0.y})->(${d2.x},${d2.y})`
  r.logoBadge = (await exec("!!document.querySelector('.brand-badge img')")) ? 'ok' : 'fail:no-img'
  r.gridAfterRefresh = (await exec("!!document.querySelector('.pcard-grid') || !!document.querySelector('.empty-state')")) ? 'ok' : 'fail'

  // 刷新压力（标题栏 ⟳ 与底部主按钮两个入口）+ 收起再展开（假死回归）
  r.titleRefreshBtn = (await exec("!!document.querySelector('button[title=立即刷新]')")) ? 'ok' : 'fail:no-titlebar-refresh'
  await exec("document.querySelector('button[title=立即刷新]')?.click()")
  await exec('window.api.refreshNow(); window.api.refreshNow()')
  await sleep(2500)
  await exec(footerClick('收起'))
  await sleep(700)
  r.refreshThenCollapse = bounds().width <= 60 ? 'ok' : `fail:${bounds().width}`
  await exec(dotClickJs())
  await sleep(900)
  r.refreshThenExpand = bounds().width > 300 ? 'ok' : 'fail'

  // 设置：打开 → 供应商列表存在 → 添加自定义供应商 → 删除 → 偏好保存 → 返回
  await exec(footerClick('设置'))
  await sleep(700)
  r.settingsOpen = (await exec("!!document.querySelector('.settings')")) ? 'ok' : 'fail'
  r.settingsProviders = (await exec("!!document.querySelector('.prow')")) ? 'ok' : 'fail:no-prow'
  r.settingsAddBtns = (await exec("document.querySelectorAll('.add-btn').length === 2")) ? 'ok' : 'fail'

  // 添加内置供应商（目录选择 → 生成实例 → 删除）
  await exec("[...document.querySelectorAll('.add-btn')].find(b=>b.textContent.includes('添加提供方'))?.click()")
  await sleep(600)
  const pickerOpen = (await exec("!!document.querySelector('.picker .picker-item')")) as boolean
  if (pickerOpen) {
    const beforeIds = (await exec("[...document.querySelectorAll('.prow')].map(r=>r.dataset.providerId)")) as string[]
    await exec("document.querySelector('.picker .picker-item')?.click()")
    await sleep(1200)
    const afterIds = (await exec("[...document.querySelectorAll('.prow')].map(r=>r.dataset.providerId)")) as string[]
    const addedId = afterIds.find((x) => !beforeIds.includes(x))
    r.settingsAddPreset = addedId ? 'ok' : `fail:${beforeIds.length}->${afterIds.length}`
    // 新增实例自动进入编辑态：先取消
    await exec("[...document.querySelectorAll('.prow.editing .btn-secondary')].find(b=>b.textContent.includes('取消'))?.click()")
    await sleep(400)
    // 按 id 精确删除刚添加的实例
    if (addedId) {
      await exec(`document.querySelector('[data-provider-id="${addedId}"] .mini-btn.danger')?.click()`)
      await sleep(300)
      await exec(`document.querySelector('[data-provider-id="${addedId}"] .mini-btn.danger')?.click()`)
      await sleep(1000)
      const finalIds = (await exec("[...document.querySelectorAll('.prow')].map(r=>r.dataset.providerId)")) as string[]
      r.settingsRemovePreset = finalIds.includes(addedId) ? 'fail:still-there' : 'ok'
    } else {
      r.settingsRemovePreset = 'skipped'
    }
  } else {
    r.settingsAddPreset = 'fail:no-picker'
    r.settingsRemovePreset = 'fail:no-picker'
  }

  // 添加自定义供应商（打开表单 → 填名称 → 添加 → 二次确认删除）
  await exec("[...document.querySelectorAll('.add-btn')].find(b=>b.textContent.includes('自定义'))?.click()")
  await sleep(400)
  const customFormOpen = (await exec("!!document.querySelector('.custom-form')")) as boolean
  if (customFormOpen) {
    await exec(`(()=>{
      const inp=document.querySelector('.custom-form input[type=text]')
      if(!inp) return
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set
      setter.call(inp,'uitest-provider')
      inp.dispatchEvent(new Event('input',{bubbles:true}))
    })()`)
    await sleep(200)
    await exec("[...document.querySelectorAll('.custom-form .btn-primary')].find(b=>b.textContent.includes('添加'))?.click()")
    await sleep(1000)
    r.settingsAddCustom = (await exec("document.body.innerText.includes('uitest-provider')")) ? 'ok' : 'fail:not-added'
    await exec(`(()=>{
      const row=[...document.querySelectorAll('.prow')].find(r=>r.textContent.includes('uitest-provider'))
      row?.querySelector('.mini-btn.danger')?.click()
    })()`)
    await sleep(300)
    await exec(`(()=>{
      const row=[...document.querySelectorAll('.prow')].find(r=>r.textContent.includes('uitest-provider'))
      row?.querySelector('.mini-btn.danger')?.click()
    })()`)
    await sleep(900)
    r.settingsRemoveCustom = (await exec("!document.body.innerText.includes('uitest-provider')")) ? 'ok' : 'fail:not-removed'
  } else {
    r.settingsAddCustom = 'fail:no-form'
    r.settingsRemoveCustom = 'fail:no-form'
  }

  // 刷新频率：单一入口（10 秒 – 5 分钟），即改即存并立即生效
  const intervalSet = String(
    await exec(`(()=>{
      const sel=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value==='10'))
      if(!sel) return 'no-select'
      const setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set
      setter.call(sel,'10')
      sel.dispatchEvent(new Event('change',{bubbles:true}))
      return 'set'
    })()`)
  )
  await sleep(900)
  r.intervalSelect = intervalSet === 'set' ? 'ok' : `fail:${intervalSet}`
  r.intervalSaved = (await exec("window.api.getExtras(['refreshInterval']).then(e=>e.refreshInterval==='10')"))
    ? 'ok'
    : 'fail:not-saved'
  r.intervalFlash = (await exec("!!document.querySelector('.saved-flash')")) ? 'ok' : 'fail:no-flash' // 即改即存反馈
  r.intervalDiag = String(await exec("document.querySelector('.settings-foot')?.innerText?.slice(0,60) + ' | sel=' + [...document.querySelectorAll('select')].map(s=>s.value).join(',')"))
  // 还原默认（避免影响后续轮次）
  await exec(`(()=>{
    const sel=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value==='10'))
    const setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set
    setter.call(sel,'60')
    sel.dispatchEvent(new Event('change',{bubbles:true}))
  })()`)
  await sleep(600)
  r.settingsSave = consoleErrors.length === 0 ? 'ok' : `console-errors:${consoleErrors.length}`
  await exec("[...document.querySelectorAll('.icon-btn')].find(b=>b.title==='返回')?.click()")
  await sleep(600)
  r.settingsBack = (await exec("!!document.querySelector('.pcard-grid') || !!document.querySelector('.empty-state')")) ? 'ok' : 'fail'

  // 状态栏（托盘）标题：多时限窗口应平铺展示（如 `5H 4% W 52% M 68%`）
  const trayTitle = String(await exec('window.api.debugTrayTitle()'))
  r.trayTitle =
    !trayTitle || (!/undefined|NaN/.test(trayTitle) && /[0-9]/.test(trayTitle))
      ? `ok(${trayTitle})`
      : `fail:${trayTitle}`

  // 数据诚实：注入"缓存 / 本机估算 / 出错"验证降级渲染（真实数据难复现）
  const fakeSnap = (quality: string): string =>
    JSON.stringify([
      {
        id: 'fake-provider',
        name: 'Fake Provider',
        kind: 'coding',
        builtin: true,
        mark: 'opencode',
        plan: 'Go 套餐',
        status: quality === 'error' ? 'error' : 'ok',
        detail: quality === 'error' ? 'fetch failed（模拟断网）' : undefined,
        windows: quality === 'error' ? [] : [{ name: '5 小时', used: 6, limit: 12, unit: 'usd', percent: 50 }],
        dataQuality: quality,
        dataAt: new Date(Date.now() - 300_000).toISOString(),
        degradedReason:
          quality === 'local'
            ? '官方数据不可用 · 当前为本机估算，与官方百分比口径不同'
            : quality === 'cached'
              ? 'fetch failed'
              : undefined,
        updatedAt: new Date(Date.now() - 300_000).toISOString()
      }
    ])
  // 等待当前采集结束再注入（否则真实采集的结果会覆盖注入状态）
  const waitIdle = async (): Promise<void> => {
    for (let i = 0; i < 60; i++) {
      if (!(await exec('window.api.getState().then(s=>!!s.scanning)'))) return
      await sleep(250)
    }
  }
  await waitIdle()
  await exec(`window.api.debugPush(${fakeSnap('cached')}, true)`)
  await sleep(600)
  const cachedDom = String(
    await exec(
      "[...document.querySelectorAll('.pcard')].map(e=>e.className).join('|') + ' :: ' + (document.body.innerText||'').slice(0,140).split(String.fromCharCode(10)).join(' ')"
    )
  )
  r.cachedCard = (await exec("!!document.querySelector('.pcard.stale') && !!document.querySelector('.qchip.cached')"))
    ? 'ok'
    : `fail:no-badge[${cachedDom}]`
  r.offlineBanner = (await exec("document.querySelector('.status-line')?.textContent?.includes('离线')"))
    ? 'ok'
    : 'fail:no-offline-text'
  await exec("document.querySelector('[data-card-id]')?.click()")
  await sleep(600)
  r.cachedBanner = (await exec("!!document.querySelector('.qbanner.cached') && !!document.querySelector('.qbanner-retry')"))
    ? 'ok'
    : 'fail:no-banner'
  await exec("[...document.querySelectorAll('.icon-btn')].find(b=>b.title==='返回')?.click()")
  await sleep(500)
  await waitIdle()
  await exec(`window.api.debugPush(${fakeSnap('local')}, false)`)
  await sleep(500)
  r.localChip = (await exec("!!document.querySelector('.qchip.local')")) ? 'ok' : 'fail:no-chip'
  await waitIdle()
  await exec(`window.api.debugPush(${fakeSnap('error')}, false)`)
  await sleep(500)
  r.errorState = (await exec("document.querySelector('.status-line')?.textContent?.includes('出错')")) ? 'ok' : 'fail'
  await exec('window.api.refreshNow()')
  await sleep(2500)

  // ─── 拖拽排序 ─────────────────────────────────────────────────────────────
  // 回归两个实机 bug：
  //   ① 拖拽**期间不得改动 DOM 顺序**（否则布局在指针下反复变化 → 卡片左右闪动）
  //   ② 松手必须落位（曾出现卡片悬在半空不落位的"页面错乱"）
  // 等真实数据恢复（前面的可信度注入只有 1 张卡）
  for (let i = 0; i < 40; i++) {
    if ((await exec("document.querySelectorAll('[data-card-id]').length >= 2")) === true) break
    await sleep(400)
  }
  const orderBeforeDrag = (await exec(
    'window.api.listProviders().then(p=>p.providers.filter(x=>x.enabled).map(x=>x.id))'
  )) as string[]
  const dragProbe = String(
    await exec(`(async()=>{
      const cards=[...document.querySelectorAll('[data-card-id]')]
      if(cards.length<2) return 'skip:need-2-cards'
      const orderBefore=[...document.querySelectorAll('[data-card-id]')].map(c=>c.dataset.cardId)
      const a=cards[0], b=cards[1]
      const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect()
      const base={pointerId:21,bubbles:true,pointerType:'mouse',button:0,isPrimary:true}
      const at=(x,y)=>({...base,clientX:x,clientY:y})
      a.dispatchEvent(new PointerEvent('pointerdown',at(ra.x+20,ra.y+20)))
      for(let i=1;i<=6;i++){
        window.dispatchEvent(new PointerEvent('pointermove',at(ra.x+20+(rb.x-ra.x)*i/6,ra.y+20+(rb.y-ra.y)*i/6)))
        await new Promise(r=>setTimeout(r,25))
      }
      // 在目标槽位附近来回抖动：旧实现会在这里反复重排（闪动）
      for(let i=0;i<12;i++){
        window.dispatchEvent(new PointerEvent('pointermove',at(rb.x+20+(i%2?5:-5), rb.y+20+(i%2?5:-5))))
        await new Promise(r=>setTimeout(r,16))
      }
      const during=[...document.querySelectorAll('[data-card-id]')].map(c=>c.dataset.cardId)
      // 计算后 transform 必须真的生效（曾因 card-in 动画 fill-mode:both 被永久覆盖）
      const all=[...document.querySelectorAll('[data-card-id]')]
      const applied=all.filter(c=>getComputedStyle(c).transform!=='none').length
      const previews=all.filter(c=>c.style.transform).length
      window.dispatchEvent(new PointerEvent('pointerup',at(rb.x+20,rb.y+20)))
      await new Promise(r=>setTimeout(r,600))
      const after=[...document.querySelectorAll('[data-card-id]')].map(c=>c.dataset.cardId)
      return JSON.stringify({orderBefore,during,previews,applied,after})
    })()`)
  )
  if (dragProbe.startsWith('skip')) {
    r.dragReorder = dragProbe
    r.dragNoFlicker = dragProbe
    r.dragSettles = dragProbe
  } else {
    const p = JSON.parse(dragProbe) as {
      orderBefore: string[]
      during: string[]
      previews: number
      applied: number
      after: string[]
    }
    r.dragReorder = p.after[0] === p.orderBefore[1] && p.after[1] === p.orderBefore[0] ? 'ok' : `fail:${p.after}`
    r.dragNoFlicker = p.during.join(',') === p.orderBefore.join(',') ? 'ok' : `fail:拖拽中顺序被改动 ${p.during}`
    r.dragSettles = p.after.join(',') === p.orderBefore.join(',') ? 'fail:未落位' : 'ok'
    r.dragPreviewShift = p.applied >= 2 ? 'ok' : `fail:让位位移未生效(${p.applied}/${p.previews})`
    const regOrder = (await exec(
      'window.api.listProviders().then(p=>p.providers.filter(x=>x.enabled).map(x=>x.id))'
    )) as string[]
    r.dragPersist = regOrder[0] === p.after[0] && regOrder[1] === p.after[1] ? 'ok' : `fail:${regOrder}!=${p.after}`
    // Escape 取消拖拽：不应改动顺序、不应留下悬空卡片
    const escProbe = String(
      await exec(`(async()=>{
        const c=[...document.querySelectorAll('[data-card-id]')]
        const before=[...document.querySelectorAll('[data-card-id]')].map(x=>x.dataset.cardId)
        const a=c[0], b=c[1]
        const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect()
        const base={pointerId:22,bubbles:true,pointerType:'mouse',button:0,isPrimary:true}
        const at=(x,y)=>({...base,clientX:x,clientY:y})
        a.dispatchEvent(new PointerEvent('pointerdown',at(ra.x+20,ra.y+20)))
        window.dispatchEvent(new PointerEvent('pointermove',at(rb.x+20,rb.y+20)))
        await new Promise(r=>setTimeout(r,80))
        window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))
        await new Promise(r=>setTimeout(r,400))
        const after=[...document.querySelectorAll('[data-card-id]')].map(x=>x.dataset.cardId)
        const floating=[...document.querySelectorAll('[data-card-id]')].filter(x=>x.style.transform).length
        return JSON.stringify({before,after,floating})
      })()`)
    )
    const e = JSON.parse(escProbe) as { before: string[]; after: string[]; floating: number }
    r.dragEscapeCancel = e.before.join(',') === e.after.join(',') && e.floating === 0 ? 'ok' : `fail:${escProbe}`
    // 还原测试前的顺序（避免反复跑测试把用户排序打乱）
    await exec(`window.api.reorderProviders(${JSON.stringify(orderBeforeDrag)})`)
    await sleep(400)
  }

  // ─── 设置：供应商增删（删除二次确认）＋ 刷新频率（单一入口、即改即存）─────
  await exec(footerClick('设置'))
  await sleep(700)
  r.settingsOpen = (await exec("!!document.querySelector('.settings')")) ? 'ok' : 'fail'
  r.settingsProviders = (await exec("!!document.querySelector('.prow')")) ? 'ok' : 'fail:no-prow'
  r.settingsIcons = (await exec("document.querySelectorAll('.prow .pmark').length > 0")) ? 'ok' : 'fail:no-mark'
  r.settingsAddBtns = (await exec("document.querySelectorAll('.add-btn').length === 2")) ? 'ok' : 'fail'

  // 添加内置供应商（目录选择 → 生成实例 → 二次确认删除）
  await exec("[...document.querySelectorAll('.add-btn')].find(b=>b.textContent.includes('添加提供方'))?.click()")
  await sleep(600)
  const pickerOpen1 = (await exec("!!document.querySelector('.picker .picker-item')")) as boolean
  if (pickerOpen1) {
    const beforeIds = (await exec("[...document.querySelectorAll('.prow')].map(r=>r.dataset.providerId)")) as string[]
    await exec("document.querySelector('.picker .picker-item')?.click()")
    await sleep(1200)
    const afterIds = (await exec("[...document.querySelectorAll('.prow')].map(r=>r.dataset.providerId)")) as string[]
    const addedId = afterIds.find((x) => !beforeIds.includes(x))
    r.settingsAddPreset = addedId ? 'ok' : `fail:${beforeIds.length}->${afterIds.length}`
    // 新增实例自动进入编辑态：先取消
    await exec("[...document.querySelectorAll('.prow.editing .btn-secondary')].find(b=>b.textContent.includes('取消'))?.click()")
    await sleep(400)
    if (addedId) {
      // 删除需二次确认（防误删凭据）
      await exec(`document.querySelector('[data-provider-id="${addedId}"] .mini-btn.danger')?.click()`)
      await sleep(300)
      r.settingsDeleteConfirm = (await exec(
        `!!document.querySelector('[data-provider-id="${addedId}"] .mini-btn.danger[data-confirm="1"]')`
      ))
        ? 'ok'
        : 'fail:no-confirm-step'
      await exec(`document.querySelector('[data-provider-id="${addedId}"] .mini-btn.danger')?.click()`)
      await sleep(1000)
      const finalIds = (await exec("[...document.querySelectorAll('.prow')].map(r=>r.dataset.providerId)")) as string[]
      r.settingsRemovePreset = finalIds.includes(addedId) ? 'fail:still-there' : 'ok'
    } else {
      r.settingsDeleteConfirm = 'skipped'
      r.settingsRemovePreset = 'skipped'
    }
  } else {
    r.settingsAddPreset = 'fail:no-picker'
    r.settingsRemovePreset = 'fail:no-picker'
    r.settingsDeleteConfirm = 'fail:no-picker'
  }

  r.consoleErrors = consoleErrors.length === 0 ? 'none' : consoleErrors.join(' | ').slice(0, 300)
  return r
}
