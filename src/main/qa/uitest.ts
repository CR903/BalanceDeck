// 设计走查 / UI 自动化测试 —— 从 src/main/index.ts 搬出来的 QA 工具。
//
// 这里的代码**不参与产品运行**：只有带 --shots / --uitest / --ballshot 等参数启动时才走到。
// 搬出来的原因见架构评审候选 C6：入口模块的接口是「启动应用」，而它此前 95% 是实现细节 ——
// 运行模式、截图走查、750 行 UI 断言全挤在一起，改启动流程时要在测试代码里翻。
// 纪律：新增断言请放在 uitest.ts，不要在 index.ts 里长回来。

// --uitest：UI 交互自动化（模拟点击/拖拽/刷新，断言窗口与 DOM 状态）。
// 结果以 JSON 打到 stdout；**当前不设置退出码** —— 失败与否由调用方解析 JSON 判断。
import { app, screen } from 'electron'
import { join } from 'path'
import { consumeDragFired } from '../ipc'
import { petHitboxDebug, petIgnoreState, petWindowState } from '../overlay'
import { BALL_VIEW, FIGURE_VIEW } from '../../shared/pet-view'
import { refreshNow } from '../scheduler'
import { demoSnapshot } from './fixtures'

export async function runUiTest(
  win: Electron.BrowserWindow,
  consoleErrors: string[]
): Promise<Record<string, string>> {
  const r: Record<string, string> = {}
  // 开机自启测试落在临时目录，避免在开发者机器上写入真实 LaunchAgent
  const autostartDir = join(app.getPath('temp'), 'balancedeck-uitest-autostart')
  process.env.BALANCEDECK_AUTOSTART_DIR = autostartDir
  const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))
  /**
   * 执行渲染层脚本。**失败不抛**：页面脚本抛错时 executeJavaScript 会 reject，
   * 若让它冒泡，整轮断言就永远打不出结果（表现为"卡死"，实际只是某一条挂了）。
   * 这里把错误记下来、返回 null，让调用方的断言自然变成 fail:xxx。
   */
  const execErrors: string[] = []
  const exec = async (js: string): Promise<unknown> => {
    try {
      return await win.webContents.executeJavaScript(js, true)
    } catch (e) {
      // 连**是哪段脚本**一起记下来：否则只剩一句 "Script failed to execute"，
      // 根本定位不到是哪一步（这次就为此白等过一轮 20 分钟）
      const msg = `${String(e).split('\n')[0].slice(0, 80)} ← ${js.replace(/\s+/g, ' ').slice(0, 90)}`
      execErrors.push(msg)
      if (process.env.BD_TRACE === '1') process.stdout.write(`[uitest] exec 失败: ${msg}\n`)
      return null
    }
  }
  const bounds = (): Electron.Rectangle => win.getBounds()
  /** 收起态窗口很小（圆环 56×56 / 人物 213×293），主体就在正中：点击 = 点命中层中心 */
  const ballCenterJs = `(()=>{
    const c=document.querySelector('.petball'); if(!c) return null
    const rc=c.getBoundingClientRect()
    return { x: rc.x + rc.width/2, y: rc.y + rc.height/2 }
  })()`
  const dotClickJs = (dx = 0, dy = 0): string => `(()=>{
    const b=document.querySelector('.petball-hit'); if(!b) return 'no-dot'
    const rc=b.getBoundingClientRect()
    const cx=rc.x+rc.width/2, cy=rc.y+rc.height/2
    const o={clientX:cx+${dx},clientY:cy+${dy},pointerId:7,bubbles:true,pointerType:'mouse',button:0,buttons:1}
    b.dispatchEvent(new PointerEvent('pointerdown',o))
    b.dispatchEvent(new PointerEvent('pointerup',{...o,buttons:0}))
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
  r.collapse = b1.width === BALL_VIEW.width && b1.height === BALL_VIEW.height ? 'ok' : `fail:${b1.width}x${b1.height}`
  r.dotDom = (await exec("!!document.querySelector('.petball') && !!document.querySelector('.petball-hit')"))
    ? 'ok'
    : 'fail'
  // 诊断串：球形态的读数在 2D 小圆环的环心（.dot-value），人物形态在下方胶囊（.petball-value）
  r.ballValue = String(
    await exec(
      "document.querySelector('.petball-fallback .dot-value')?.textContent ?? document.querySelector('.petball-value')?.textContent ?? ''"
    )
  )

  // 拖拽：>8px 判拖拽，不展开；窗口位置变化；随后圆点仍在
  const before = bounds()
  // 抓取点用真实光标与窗口位置换算：合成事件不会真的移动鼠标，这样窗口不会被甩走
  const cur = screen.getCursorScreenPoint()
  const grabX = cur.x - before.x
  const grabY = cur.y - before.y
  await exec(`(async()=>{
    const b=document.querySelector('.petball-hit'); if(!b) return
    const rc=b.getBoundingClientRect()
    const o={clientX:rc.x+${grabX},clientY:rc.y+${grabY},pointerId:8,bubbles:true,pointerType:'mouse',button:0,buttons:1}
    b.dispatchEvent(new PointerEvent('pointerdown',o))
    for(let i=1;i<=6;i++){
      b.dispatchEvent(new PointerEvent('pointermove',{...o,clientX:o.clientX+i*9,clientY:o.clientY}))
      await new Promise(res=>setTimeout(res,40))
    }
    b.dispatchEvent(new PointerEvent('pointerup',{...o,buttons:0}))
  })()`)
  await sleep(900)
  const after = bounds()
  r.dragNoExpand = (await exec("!!document.querySelector('.petball')")) ? 'ok' : 'fail:expanded'
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

  // 漂移回归：多轮开合后，收起态的球必须回到同一位置（旧版每轮右移 328px 直至出屏）
  await exec(footerClick('收起'))
  await sleep(700)
  const ballA = bounds()
  for (let i = 0; i < 2; i++) {
    await exec(dotClickJs())
    await sleep(700)
    await exec(footerClick('收起'))
    await sleep(700)
  }
  const ballB = bounds()
  r.noDrift =
    ballA.x === ballB.x && ballA.y === ballB.y
      ? 'ok'
      : `fail:(${ballA.x},${ballA.y})->(${ballB.x},${ballB.y})`
  await exec(dotClickJs())
  await sleep(800)
  r.logoBadge = (await exec("!!document.querySelector('.brand-badge img')")) ? 'ok' : 'fail:no-img'
  r.gridAfterRefresh = (await exec("!!document.querySelector('.pcard-grid') || !!document.querySelector('.empty-state')")) ? 'ok' : 'fail'

  // 刷新压力（标题栏 ⟳ 与底部主按钮两个入口）+ 收起再展开（假死回归）
  r.titleRefreshBtn = (await exec("!!document.querySelector('button[title=立即刷新]')")) ? 'ok' : 'fail:no-titlebar-refresh'
  await exec("document.querySelector('button[title=立即刷新]')?.click()")
  await exec('window.api.refreshNow(); window.api.refreshNow()')
  await sleep(2500)
  await exec(footerClick('收起'))
  await sleep(700)
  // 尺寸取常量而不是字面量：这里曾写死 200（球形态窗口宽），改成 2D 小圆环的 56 之后
  // 它会一直红 —— 而红的原因在断言里，看不出是断言过时了。
  r.refreshThenCollapse =
    bounds().width === BALL_VIEW.width ? 'ok' : `fail:${bounds().width}!=${BALL_VIEW.width}`
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
  //
  // 必须按 `.refresh-interval` 定位，**不能**按「第一个含 option value='10' 的 select」找：
  // 播报间隔（`.voice-interval`）也有 option `10`（10 分钟），而它在 DOM 里排在前面，
  // 那样会改到播报间隔去 —— 2026-09-26 实测踩过：intervalSaved/intervalFlash 双红而产品无 bug。
  const setRefreshInterval = (value: string) => exec(`(()=>{
      const sel=document.querySelector('.refresh-interval')
      if(!sel) return 'no-select'
      const setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set
      setter.call(sel,${JSON.stringify(value)})
      sel.dispatchEvent(new Event('change',{bubbles:true}))
      return 'set'
    })()`)
  const intervalSet = String(await setRefreshInterval('10'))
  await sleep(900)
  r.intervalSelect = intervalSet === 'set' ? 'ok' : `fail:${intervalSet}`
  r.intervalSaved = (await exec("window.api.getExtras(['refreshInterval']).then(e=>e.refreshInterval==='10')"))
    ? 'ok'
    : 'fail:not-saved'
  r.intervalFlash = (await exec("!!document.querySelector('.saved-flash')")) ? 'ok' : 'fail:no-flash' // 即改即存反馈
  r.intervalDiag = String(await exec("document.querySelector('.settings-foot')?.innerText?.slice(0,60) + ' | sel=' + [...document.querySelectorAll('select')].map(s=>s.value).join(',')"))
  // 还原默认（避免影响后续轮次）
  await setRefreshInterval('60')
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

  // 托盘交互模式：macOS 左键直接显隐面板（回归"点击状态栏只弹菜单"）
  const trayMode = String(await exec('window.api.debugTrayMode()'))
  r.trayMode =
    process.platform === 'darwin'
      ? trayMode === 'click-toggle'
        ? 'ok'
        : `fail:${trayMode}`
      : `skipped(${trayMode})`

  // 主面板余额显隐（眼睛按钮：打码 + 偏好持久化 + 可还原）
  const clickEye = (): Promise<unknown> =>
    exec(
      "[...document.querySelectorAll('.icon-btn')].find(b=>/余额/.test(b.title))?.click()"
    )
  const readHidden = async (): Promise<boolean> =>
    (await exec("window.api.getExtras(['ui:hideBalance']).then(e=>e['ui:hideBalance']==='1')")) === true
  const hasBalanceCard = (await exec("!!document.querySelector('.pcard.balance')")) === true
  const wasHidden = await readHidden()
  const flip = async (): Promise<{ hidden: boolean; masked: boolean }> => {
    await clickEye()
    await sleep(400)
    return {
      hidden: await readHidden(),
      masked: (await exec("!!document.querySelector('.pcard.balance .amount-hidden')")) === true
    }
  }
  const first = await flip()
  r.hideBalance =
    first.hidden === !wasHidden && (!hasBalanceCard || first.masked === first.hidden)
      ? 'ok'
      : `fail:${JSON.stringify(first)}`
  const back = await flip()
  r.hideBalanceRestore =
    back.hidden === wasHidden && (!hasBalanceCard || back.masked === back.hidden)
      ? 'ok'
      : `fail:${JSON.stringify(back)}`

  // 套餐卡：用量与限额必须同一行（回归"折行把卡片撑高"）——两段文字框竖直方向必须重叠
  r.planMetaOneLine = String(
    await exec(`(()=>{
      const card=[...document.querySelectorAll('.pcard.plan')].find(c=>c.querySelector('.pcard-limit'))
      if(!card) return 'skip:no-plan-limit'
      const a=card.querySelector('.pcard-amount'), b=card.querySelector('.pcard-limit')
      if(!a||!b) return 'skip:no-el'
      const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect()
      return ra.bottom>rb.top && rb.bottom>ra.top ? 'ok' : 'fail:wrap'
    })()`)
  )

  // 套餐卡：窗口切换（5H / W / M 胶囊）——点击第二个窗口必须生效并持久化，随后还原
  r.windowChips = String(
    await exec(`(async()=>{
      const card=[...document.querySelectorAll('.pcard.plan')].find(c=>c.querySelectorAll('.win-chip').length>1)
      if(!card) return 'skip:no-multi-window'
      const id=card.dataset.cardId
      const chips=()=>[...card.querySelectorAll('.win-chip')]
      const on=()=>chips().findIndex(c=>c.classList.contains('on'))
      const first=on()
      const target=first===0?1:0
      chips()[target].click()
      await new Promise(r=>setTimeout(r,450))
      const after=on()
      const saved=(await window.api.getExtras(['ui:cardWindow:'+id]))['ui:cardWindow:'+id]
      // 还原为最初选择，避免影响后续走查
      chips()[first].click()
      await new Promise(r=>setTimeout(r,350))
      const restored=on()
      return JSON.stringify({first,after,saved:!!saved,restored})
    })()`)
  )

  // ─── 宠物：设置页互动 + 收起态圆环／个性人物 + 鼠标穿透 ─────────────────────
  // 用户原本是否开着「桌面宠物」（'1' 才算开；默认关闭 = 3D 球形态）
  const petWasOn = (await exec("window.api.getExtras(['ui:pet']).then(e=>e['ui:pet']==='1')")) === true
  // 面板不再常驻宠物卡（用户要求）：确认已移除
  r.petCardRemoved = (await exec("!!document.querySelector('.pet-card')")) ? 'fail:still-there' : 'ok'

  // 设置页「数字助理」分区：选一位 / 改名 / 三个开关（养成互动已下线）
  await exec(footerClick('设置'))
  await sleep(700)
  r.petSection = (await exec("!!document.querySelector('.pet-sec') && document.querySelectorAll('.pet-chip').length === 2"))
    ? 'ok'
    : 'fail:no-section'
  // 角色缩略图由 3D 素材渲染（异步）：等它们出来
  for (let i = 0; i < 40; i++) {
    if ((await exec("document.querySelectorAll('.pet-chip img').length === 2")) === true) break
    await sleep(400)
  }
  r.petThumbs = (await exec("document.querySelectorAll('.pet-chip img').length === 2")) ? 'ok' : 'fail:no-thumbs'
  // 换一只：形象与默认名一起切换
  const petIdBefore = String(await exec("document.querySelector('.petball')?.dataset.pet ?? ''"))
  await exec(`[...document.querySelectorAll('.pet-chip')].find(c=>!c.classList.contains('on'))?.click()`)
  await sleep(600)
  r.petSwitch = (await exec("document.querySelector('.pet-chip.on')?.textContent?.length > 0")) ? 'ok' : 'fail'
  void petIdBefore

  // 桌面宠物开关：关掉 → 收起态退回 2D 圆点（无 WebGL）；再开回来
  /**
   * 点「个性人物」开关，并等到偏好真的落定。
   * 关闭时会先播**退场动作**（挥手告别 + 转身走出窗口）再收成球，所以不能只睡 500ms；
   * 展开态下没有 3D 场景（PetBall 未挂载）时立即生效，轮询自然也算得出。
   */
  const petSwitch = async (want: '1' | '0'): Promise<void> => {
    await exec("[...document.querySelectorAll('.pet-sec .switch')][0]?.click()")
    for (let i = 0; i < 30; i++) {
      const v = await exec("window.api.getExtras(['ui:pet']).then(e=>e['ui:pet']??'')")
      if ((want === '1' && v === '1') || (want === '0' && v === '0')) return
      await sleep(400)
    }
  }
  const gotoView = async (v: 'card' | 'settings' | 'collapse'): Promise<void> => {
    if (v === 'collapse') {
      await exec('window.api.collapse()')
      await sleep(1200)
      return
    }
    await exec('window.api.expand()')
    await sleep(700)
    if (v === 'settings') {
      await exec("[...document.querySelectorAll('.btn-secondary')].find(b=>b.textContent.includes('设置'))?.click()")
      await sleep(700)
    }
  }

  // 开关语义：默认未设置 = 球形态；点一次 → 开启桌面宠物（'1'）；再点 → 关闭（'0'）
  await petSwitch('1')
  r.petToggleSaved = (await exec("window.api.getExtras(['ui:pet']).then(e=>e['ui:pet']==='1')")) === true ? 'ok' : 'fail:not-saved'

  // ── 个性人物形态：窗口是竖版（尺寸见 shared/pet-view 的 FIGURE_VIEW），人物素材就位，穿透生效 ──
  await gotoView('collapse')
  r.petBallOn = (await exec("document.querySelector('.petball')?.dataset.figure === '1'")) ? 'ok' : 'fail:figure-off'
  r.petFigureWindow = bounds().width === FIGURE_VIEW.width && bounds().height === FIGURE_VIEW.height ? 'ok' : `fail:${bounds().width}x${bounds().height}`
  r.pet3dCanvas = (await exec("!!document.querySelector('.pet3d-canvas')")) ? 'ok' : 'fail:no-canvas'
  for (let i = 0; i < 30; i++) {
    if ((await exec('window.__bd_ball?.()?.petReady === true')) === true) break
    await sleep(300)
  }
  r.petModel = (await exec('window.__bd_ball?.()?.petReady === true')) ? 'ok' : 'fail:model-not-loaded'
  r.petSvgIdle = String(await exec("document.querySelector('.petball')?.dataset.pet ?? ''"))
  // 读数必须在**下方胶囊**里，不在环心 —— 人物形态没有 2D 小圆环，那个环心数字是球形态的东西
  r.petCenterValue = (await exec("!!document.querySelector('.petball-caption .petball-value')"))
    ? (await exec("!!document.querySelector('.petball-fallback')"))
      ? 'fail:2d-dot-in-figure'
      : 'ok'
    : 'fail:no-caption-value'
  // 人物形态的可见集里必须真的有**人物**：FBX 蒙皮网格（dump 里的节点名形如
  // f014_hipoly_81_bones_opacity，--ballshot 的 diag 实证）。同时球壳/装饰带/用量环那类
  // 球几何（Sphere/Torus/Tube）一条都不许剩。
  //
  // ⚠ 这一条 2026-09-27 重写过：原断言只有后半句（"可见集里没有球几何"），而球形态的
  // 3D 球被删干净后那条正则**永不可能命中** —— 它会恒绿，是一条假护栏（R7）。
  // 现在以前半句（人物真的在）为主、后半句为辅，合起来才既能证真也能防球几何复活。
  const figDump = (await exec('window.__bd_ball?.()?.dump ?? []')) as
    | { name: string; type: string; visible: boolean }[]
    | null
  const humanBits = (figDump ?? []).filter((m) => m.visible && /bones_opacity/.test(m.name))
  const ballBits = (figDump ?? []).filter((m) => m.visible && /Sphere|Torus|Tube/.test(m.type))
  r.petFigureOnly =
    humanBits.length > 0 && ballBits.length === 0
      ? 'ok'
      : `fail:human=${humanBits.length},ballBits=${ballBits.map((m) => m.type).join(',') || 'none'}`
  // 人物要占满竖版窗口（「脸得看得清」的诉求）：命中区与真实 ink box 双口径。
  // ⚠ 必须等它**静息**再量：人物现在会做动作（走动/张望/伸懒腰），侧身走动时投影自然窄得多，
  // 拿动作中的帧去量会得到一个跟"脸看不清"无关的小盒子。
  for (let i = 0; i < 50; i++) {
    const g = (await exec('window.__bd_ball?.()?.gesture ?? null')) as { cur: string | null } | null
    if (g && g.cur === null) break
    await sleep(300)
  }
  r.petFigureBig = String(
    await exec(`(()=>{const b=window.__bd_ball?.(); if(!b) return 'no-handle'
      const r=b.rect, ink=b.measure?.box
      return (r && ink && r.width>=140 && r.height>=190 && ink.width>=90 && ink.height>=150)
        ? 'ok' : 'fail:rect='+JSON.stringify(r&&[Math.round(r.width),Math.round(r.height)])+' ink='+JSON.stringify(ink&&[Math.round(ink.width),Math.round(ink.height)])})()`)
  )

  // ── 进出场动作：不是"配置对不对"，而是**人真的动了** ──
  // 体态 x 的极值由场景自己记录（靠台架 300ms 采样必然漏掉 1.2 秒的走动）：
  // 进场从场外左侧走来 → minX 明显为负；退场走出窗口右侧 → maxX 明显为正。
  const travel = (): { minX: number; maxX: number } => ({ minX: 0, maxX: 0 })
  let enterTravel = travel()
  for (let i = 0; i < 40; i++) {
    enterTravel = ((await exec('window.__bd_ball?.()?.travel ?? null')) as { minX: number; maxX: number } | null) ?? travel()
    if (enterTravel.minX < -10) break
    await sleep(300)
  }
  // 进场是"模型就位那一刻"自动播的（老代码在模型没加载完时就请求，实际从没被看到过）
  r.petEnterWalk = enterTravel.minX < -10 ? 'ok' : `fail:minX=${enterTravel.minX}`
  // 退场：收起态下主动驱动一次，人物必须往窗口外走
  // ⚠ fire-and-forget：playGesture 的 Promise 在动作播完才兑现，而 executeJavaScript 会 await 它
  await exec("void window.__bd_gesture?.('exit')")
  let exitMaxX = 0
  for (let i = 0; i < 30; i++) {
    const t = ((await exec('window.__bd_ball?.()?.travel ?? null')) as { maxX: number } | null) ?? { maxX: 0 }
    exitMaxX = t.maxX
    if (exitMaxX > 10) break
    await sleep(300)
  }
  r.petExitWalk = exitMaxX > 10 ? 'ok' : `fail:maxX=${exitMaxX}`

  // ── 动作编排：每位角色的随机动作池 ≥5、步幅速度来自剪辑、人物出现即进场 ──
  // 观感不可断言，但"编排"可以：池子、步速、进场是否真的播过。
  const gest = (await exec('window.__bd_ball?.()?.gesture ?? null')) as
    | { cur: string | null; step: number; planned: string | null; last: string | null; pool: string[] }
    | null
  r.petGesturePool = gest && gest.pool.length >= 5 ? 'ok' : `fail:${JSON.stringify(gest?.pool ?? null)}`
  const stride = (await exec('window.__bd_ball?.()?.stride ?? 0')) as number
  // 步幅速度由 walk 剪辑的根位移反算（实测 ≈27）；落在这个区间才算"真的量到了剪辑步幅"，
  // 而不是退化成按身高估计（退化时会 console.warn，也在 15–45 内，故同时看 rootMotion）
  r.petStride = stride >= 15 && stride <= 45 ? 'ok' : `fail:${stride}`
  // 置顶开关（默认开；关掉后主进程不再置顶；再开回来）
  const topDefault = (await exec('window.api.debugPetState()')) as { alwaysOnTop: boolean } | null
  r.petTopDefault = topDefault?.alwaysOnTop === true ? 'ok' : 'fail:default-off'
  const topOff = (await exec('window.api.debugSetTop(false)')) as { alwaysOnTop: boolean } | null
  r.petTopOff = topOff?.alwaysOnTop === false ? 'ok' : 'fail:still-on-top'
  const topOn = (await exec('window.api.debugSetTop(true)')) as { alwaysOnTop: boolean } | null
  r.petTopOn = topOn?.alwaysOnTop === true ? 'ok' : 'fail:cannot-restore'

  // 穿透机制：主进程光标轮询在跑（roaming = watchTimer 非空）+ 渲染层已上报命中区（hitbox 非空）
  const watch = petIgnoreState()
  const hb = petHitboxDebug()
  r.petPierce = watch.roaming && hb && hb.width > 20 ? 'ok' : `fail:roaming=${watch.roaming},hb=${JSON.stringify(hb)}`
  r.petCmdOk = watch.collapsed === true && bounds().width === FIGURE_VIEW.width ? 'ok' : `fail:${bounds().width}`
  // 收起态必须关掉原生窗口阴影（否则 macOS 会按窗口矩形投一层方框阴影，实机表现为"宠物外面有个四方形框"）
  r.petNoWindowShadow = watch.shadow === false ? 'ok' : 'fail:has-shadow'
  const ball = (await exec('window.__bd_ball?.() ?? null')) as
    | { rect: { x: number; y: number; width: number; height: number }; measure: { box: { width: number; height: number } } }
    | null
  r.petDiag = JSON.stringify({
    watch,
    hb: hb && { w: Math.round(hb.width), h: Math.round(hb.height) },
    rect: ball && { w: Math.round(ball.rect.width), h: Math.round(ball.rect.height) },
    ink: ball && { w: ball.measure.box.width, h: ball.measure.box.height },
    // 软化/卡顿现场证据：帧率与最长一帧间隔
    perf: (ball as { perf?: unknown } | null)?.perf ?? null,
    stride: (ball as { stride?: unknown } | null)?.stride ?? null,
    gesture: (ball as { gesture?: unknown } | null)?.gesture ?? null,
    // 动作解析占用主线程的毫秒数（人物"卡一下"的归因）
    clipParseMs: (ball as { clipParseMs?: unknown } | null)?.clipParseMs ?? null
  })

  // 右键菜单关掉之后不许残留"按下"状态（"宠物黏住光标乱跑"的回归）
  r.petNoStickyDrag = consumeDragFired() ? 'fail:drag-started' : 'ok'
  r.petStillCollapsed = bounds().width === FIGURE_VIEW.width ? 'ok' : `fail:${bounds().width}`
  // 人物形态下窗口高度也必须保持竖版（长按/右键都不许把窗口改回横向）
  r.petFigureHeightKept = bounds().height === FIGURE_VIEW.height ? 'ok' : `fail:${bounds().height}`

  // 右键菜单：原生菜单打开（Esc 关掉），期间不崩、渲染层仍存活
  await exec(`(()=>{
    const b=document.querySelector('.petball-hit'); if(!b) return
    const rc=b.getBoundingClientRect()
    b.dispatchEvent(new MouseEvent('contextmenu',{clientX:rc.x+rc.width/2,clientY:rc.y+rc.height/2,bubbles:true}))
  })()`)
  await sleep(900)
  r.petMenuOpened = win.isDestroyed() ? 'fail:destroyed' : 'ok'
  await exec(`(()=>{ document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})) })()`)
  await sleep(600)

  await gotoView('settings')
  await petSwitch('0')
  r.petToggleOff = (await exec("window.api.getExtras(['ui:pet']).then(e=>e['ui:pet']==='0')")) === true ? 'ok' : 'fail:not-saved'
  await gotoView('collapse')
  r.petBallOff = (await exec("document.querySelector('.petball')?.dataset.figure === '0'")) ? 'ok' : 'fail:figure-on'
  // 球形态**不该**冒出人物的自报家门泡泡（2026-09-27 用户反馈的 bug 的回归护栏）。
  //
  // 必须紧贴 `petBallOff` —— 上面那行读到 data-figure 翻成 0 的那一刻，PetBall 的
  // 自报家门 effect（依赖 [pet.id, figure]）刚好跑过，泡泡是**新生**的。此处离它
  // 不到一次 exec，稳。
  //
  // 别挪到收尾：曾经那版靠收尾处的 setExtras「触发」，实测是假的 —— 探针显示泡泡在
  // setExtras **之前**就在了，data-pet 也早就是 ray（uitest 前面点角色卡片换的，
  // App 只在挂载时读一次 extras，setExtras 根本推不进 React）。那一版真正生效的是
  // 「恰好落在 4.2s 存活期尾部」，删掉一行 IPC 就永真了。假护栏比没护栏更糟。
  r.petBallNoBubble = !(await exec("!!document.querySelector('.petball-bubble')"))
    ? 'ok'
    : `fail:bubble=${await exec("document.querySelector('.petball-bubble')?.innerText || ''")}`
  r.petBallWindow = bounds().width === BALL_VIEW.width && bounds().height === BALL_VIEW.height ? 'ok' : `fail:${bounds().width}x${bounds().height}`
  // 球形态是**纯 2D**：没有 canvas（不创建 WebGL 上下文），有 .petball-fallback 那枚 2D 小圆环。
  // 这一条 2026-09-27 反转过：原断言要求球形态**有** canvas（那时是 3D 球），与新设计正好相反。
  const ballCanvas = await exec("!!document.querySelector('.pet3d-canvas')")
  const ballDot = await exec("!!document.querySelector('.petball-fallback')")
  r.petBall3d =
    !ballCanvas && ballDot ? 'ok' : `fail:canvas=${!!ballCanvas},dot=${!!ballDot}`
  // 环可见 + 环心有读数：track 的 stroke 必须真的算出来（不是 SVG 默认的 none）。
  // 这修的是一个**已存在的 bug** —— 2026-09-27 之前 .dot-ring-track 全项目零规则，
  // 且两个 <circle> 都不写 stroke 属性（SVG 默认 none），所以 WebGL 失败时环是隐形的。
  //
  // 只查 track 不够（2026-09-27 复核）：轨道是 16% 透明度的灰，几乎看不见 ——
  // 「弧根本没画」时它照样成立。所以 fill 的 stroke 与 dasharray 都要查：
  // dasharray 承载弧长，为 0 就等于没画弧。
  const ringDom = String(
    await exec(`(()=>{
      const dot=document.querySelector('.petball-fallback')
      if(!dot) return 'fail:no-dot'
      const track=dot.querySelector('.dot-ring-track')
      if(!track) return 'fail:no-track'
      const fill=dot.querySelector('.dot-ring-fill')
      const value=dot.querySelector('.dot-value')
      const fs=fill?getComputedStyle(fill):null
      return JSON.stringify({
        track: getComputedStyle(track).stroke,
        fill: fs ? fs.stroke : 'no-fill',
        dash: fs ? fs.strokeDasharray : 'no-fill',
        value: value ? value.textContent : ''
      })
    })()`)
  )
  let trackStroke = 'none'
  let fillStroke = 'no-fill'
  let fillDash = 'no-fill'
  let ringValue = ''
  try {
    const d = JSON.parse(ringDom) as { track: string; fill: string; dash: string; value: string }
    trackStroke = d.track
    fillStroke = d.fill
    fillDash = d.dash
    ringValue = d.value
  } catch {
    // ringDom 是 fail:... —— 下面统一报出去
  }
  r.petBallCenterValue =
    ringDom.startsWith('fail:')
      ? ringDom
      : trackStroke !== 'none' &&
          trackStroke !== '' &&
          fillStroke !== 'none' &&
          fillStroke !== '' &&
          fillDash !== 'none' &&
          parseFloat(fillDash) > 0 &&
          ringValue !== ''
        ? 'ok'
        : `fail:track=${trackStroke},fill=${fillStroke},dash=${fillDash},value='${ringValue}'`
  r.petBallRingDiag = ringDom
  // 命中区（W7）：球形态的拖拽/点击靠 .petball-hit 的矩形，必须贴合 56×56 的环。
  // 之前没有任何断言守着它 —— 命中区一旦退回整窗（213×293）就是隐形的可点击区，
  // 用户会发现自己「点空处也算点到了宠物」。
  const hitRect = String(await exec(`(()=>{
      const h=document.querySelector('.petball-hit')
      if(!h) return 'fail:no-hit'
      const b=h.getBoundingClientRect()
      return JSON.stringify({w:Math.round(b.width),h:Math.round(b.height)})
    })()`))
  r.petBallHitRect =
    hitRect.startsWith('fail:')
      ? hitRect
      : (() => {
          try {
            const b = JSON.parse(hitRect) as { w: number; h: number }
            // 允许 2px 抖动：主进程按投影上报，浮点取整会差一两个像素
            return Math.abs(b.w - BALL_VIEW.width) <= 2 && Math.abs(b.h - BALL_VIEW.height) <= 2
              ? 'ok'
              : `fail:${b.w}x${b.h}`
          } catch {
            return `fail:unparsed=${hitRect}`
          }
        })()
  // 「显示用量环」（ui:petRing）不是死开关：关掉后 2D 环只剩轨道 + 中心数字。
  // 走**真实入口**（设置页那个开关的 onClick，与右键菜单同一个 togglePetRing）——
  // 不开测试专用钩子，也不用 setExtras 走后门（那只改存储，React 状态不会变，断言会假红）。
  const ringProbe = async (): Promise<{ fill: boolean; track: boolean; value: string } | string> =>
    ((await exec(`(()=>{
      const dot=document.querySelector('.petball-fallback')
      if(!dot) return 'no-dot'
      // 直接返回对象（executeJavaScript 会结构化克隆回来）；返回 JSON 字符串的话
      // 下面 typeof x !== 'string' 那道错误分支会把它误判成失败
      return {
        fill: !!dot.querySelector('.dot-ring-fill'),
        track: !!dot.querySelector('.dot-ring-track'),
        value: dot.querySelector('.dot-value')?.textContent ?? ''
      }
    })()`)) as { fill: boolean; track: boolean; value: string } | string)
  const flipRing = async (): Promise<void> => {
    await gotoView('settings')
    await exec(
      "[...document.querySelectorAll('.pet-sec .enable-row')].find(r=>r.textContent.includes('显示用量环'))?.querySelector('.switch')?.click()"
    )
    await sleep(500)
    await gotoView('collapse')
    await sleep(600)
  }
  const ringOn = await ringProbe()
  await flipRing()
  const ringOff = await ringProbe()
  await flipRing()
  const ringBack = await ringProbe()
  if (typeof ringOn !== 'string' && typeof ringOff !== 'string' && typeof ringBack !== 'string') {
    // ⚠ 「开着时必须有弧」这一条是**load-bearing 的**：只查「关掉后没有弧」的话，
    //   弧**永远不画**（或开关整个没接线）时它照样绿 —— 2026-09-27 故意弄坏一次时实测过。
    //   没有百分比读数（pct 为 null）时本来就不该有弧，所以只在读到百分号时要求它存在。
    const pctReading = /%/.test(ringOn.value)
    r.petRingToggle =
      ringOff.track &&
      !ringOff.fill &&
      ringOff.value === ringOn.value &&
      ringBack.fill === ringOn.fill &&
      (!pctReading || ringOn.fill)
        ? 'ok'
        : `fail:on=${JSON.stringify(ringOn)},off=${JSON.stringify(ringOff)},back=${JSON.stringify(ringBack)}`
  } else {
    r.petRingToggle = `fail:on=${ringOn},off=${ringOff},back=${ringBack}`
  }
  // 偏好真的落盘了吗（对齐 intervalSaved 的做法）：只验 DOM 的话，「开关改了内存里的
  // React state、忘了写 extras」也能一路绿 —— 而下次启动就恢复成默认，用户会以为开关坏了。
  const ringSaved = String(await exec("window.api.getExtras(['ui:petRing']).then(e=>e['ui:petRing']??'')"))
  r.petRingSaved = ringSaved === '1' ? 'ok' : `fail:ui:petRing=${ringSaved}`
  // 泡泡的回归护栏挪到了形态翻转处（见 petBallOff 紧后面那条），不在这里查：
  // 收尾时泡泡那 4.2s 存活期早就过了，那时候查是**永真**的 —— 实测只差一行 IPC 的
  // 耗时就会从「抓得到」翻成「抓不到」。此处留着记录，免得后来的人又把它挪回来。
  await exec(dotClickJs())
  await sleep(1000)
  r.petBallExpand = bounds().width > 300 ? 'ok' : `fail:${bounds().width}`

  // 还原用户的桌面宠物偏好（默认：关闭）
  if (petWasOn) {
    await exec(footerClick('设置'))
    await sleep(600)
    await petSwitch('1')
    await sleep(300)
    await exec(footerClick('返回'))
    await sleep(400)
  }
  // 开机自启：沙箱目录内往返（true → plist 落地且结构正确；false → 文件删除），不碰真实登录项
  const agentFile = join(autostartDir, 'dev.zhouri.balancedeck.plist')
  const autoOn = (await exec('window.api.setAutostart(true)')) === true
  const autoGet = (await exec('window.api.getAutostart()')) === true
  let plistOk = true
  if (process.platform === 'darwin') {
    const { existsSync, readFileSync, readdirSync } = await import('fs')
    const text = existsSync(agentFile) ? readFileSync(agentFile, 'utf-8') : ''
    const list = existsSync(autostartDir) ? readdirSync(autostartDir).join('|') : 'NO-DIR'
    plistOk =
      text.includes('<key>RunAtLoad</key>') &&
      text.includes('/usr/bin/open') &&
      text.includes('LimitLoadToSessionType') &&
      list === 'dev.zhouri.balancedeck.plist'
  }
  const autoOff = (await exec('window.api.setAutostart(false)')) === false
  // 关闭后状态必须真的为「关」（文件已删除）
  const autoFinalOff = (await exec('window.api.getAutostart()')) === false
  r.autostart =
    autoOn && autoGet && plistOk && autoOff && autoFinalOff
      ? 'ok'
      : `fail:on=${autoOn},get=${autoGet},plist=${plistOk},off=${autoOff},finalOff=${autoFinalOff}`

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
  r.execErrors = execErrors.length === 0 ? 'none' : execErrors.join(' | ').slice(0, 300)
  return r
}

