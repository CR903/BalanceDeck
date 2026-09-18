import { app, BrowserWindow, screen } from 'electron'
import { join } from 'path'
import {
  createOverlay,
  toggleOverlay,
  loadPersisted,
  getOverlay,
  setCollapsed,
  petIgnoreState,
  petHitboxDebug,
  primePrefs
} from './overlay'
import { createTray, updateTray, currentTrayTitle, trayImageInfo } from './tray'
import { syncAutostart } from './autostart'
import { startScheduler, refreshNow, currentState, stopScheduler } from './scheduler'
import { registerIpc, consumeDragFired } from './ipc'
import { registerHumanAssetScheme, setupHumanAssetProtocol } from './human-assets'
import type { AppState } from '../shared/types'

// --smoke：构建验证模式。采集一轮后把快照写到 stdout 并自动退出，不留常驻窗口。
const smoke = process.argv.includes('--smoke')
// --uitest：UI 交互自动化测试（模拟点击/拖拽/刷新，断言窗口与 DOM 状态）
const uitest = process.argv.includes('--uitest')
// --shots：设计走查截图（主页 / 详情 / 设置），产物在 /tmp/balancedeck-shots/
const shots = process.argv.includes('--shots')
// --details-test：控制台每模型明细抓取自检（一次性抓取并打印，用于排障）
const detailsTest = process.argv.includes('--details-test')

// 受限环境下跑自检：某些沙箱里 Chromium 的 GPU 进程起不来（表现为启动即 SIGTRAP）。
// BD_SANDBOX_OFF=1 会关掉进程沙箱并允许软件 WebGL —— **仅用于开发/CI 自检**，
// 用户正常启动应用时不走这条分支。
// 自检用 userData 覆盖：受限环境里 ~/Library/Application Support 不可写，
// BD_USER_DATA=<目录> 可把状态文件（state.json / secrets.bin / skins）落到指定位置。
if (process.env.BD_USER_DATA) app.setPath('userData', process.env.BD_USER_DATA)

if (process.env.BD_SANDBOX_OFF === '1') {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.commandLine.appendSwitch('enable-unsafe-swiftshader')
}

app.dock?.hide?.()

// bd-asset:// 特权 scheme 必须在 ready 前注册（真人系宠物素材用）
registerHumanAssetScheme()

loadPersisted()
registerIpc()

function pushState(s: AppState): void {
  // ⚠️ 必须显式发给悬浮窗：控制台明细抓取会临时创建一个隐藏窗口，
  // 若用 BrowserWindow.getAllWindows()[0] 可能把状态推给隐藏窗口 → 界面永远停在骨架屏。
  getOverlay()?.webContents.send('state:snapshot', s)
}

app.whenReady().then(async () => {
  // 真人系宠物素材协议（bd-asset://human-pets…，缺失时渲染层回落，不阻塞启动）
  setupHumanAssetProtocol()
  // 先读偏好：收起态形态（球/桌面宠物）与是否置顶，窗口按最终形态一次成型
  await primePrefs()

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

  // --ballshot：只拍收起态 3D 悬浮球（含命中环），迭代 3D 观感时用，十几秒出图
  if (process.argv.includes('--ballshot')) {
    // 兜底：无论如何退出（离线环境下采集可能长时间阻塞；逐只拍摄需要更久）
    setTimeout(() => app.quit(), process.env.BD_PETS === '1' ? 240_000 : 60_000)
    const win = createOverlay()
    // 渲染层报错要看得到（模型解析/贴图/着色器问题都在这里暴露）
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) process.stdout.write(`[renderer:${level}] ${message.slice(0, 300)}\n`)
    })
    await new Promise((r) => setTimeout(r, 9000))
    // 注入演示数据：让用量环/数值有真实形态（拍出来才看得出设计）
    if (process.env.BD_FAKE_DATA !== '0') {
      try {
        await win.webContents.executeJavaScript(
          `window.api.debugPush(${JSON.stringify(demoSnapshot())}, false)`,
          true
        )
      } catch (e) {
        process.stdout.write('fakeData failed: ' + String(e) + '\n')
      }
      await new Promise((r) => setTimeout(r, 1200))
    }
    // BD_PET=1：确保「桌面宠物」形态开启后再收起（默认拍球形态）
    // BD_PET_ID=<id>：顺带在设置页换成指定角色（只换一只；逐只请用多次调用，见 BD_PETS 的上下文限制）
    const PET_IDS = ['mochi', 'shiba', 'penguin', 'fox', 'panda', 'bunny', 'koala', 'tiger', 'aria', 'ray']
    const pickPet = process.env.BD_PET_ID ?? ''
    const wantPet = process.env.BD_PET === '1' || pickPet !== ''
    const openSettings = `[...document.querySelectorAll('.btn-secondary')].find(b=>b.textContent.includes('设置'))?.click()`
    const back = `[...document.querySelectorAll('.icon-btn')].find(b=>b.title==='返回')?.click()`
    const collapse = `[...document.querySelectorAll('.btn-secondary')].find(b=>b.textContent.includes('收起'))?.click()`
    // 开关按相邻文本定位（该分区还会继续加开关，下标必然漂移），且只在未开启时点一次：
    // 它是 toggle，无条件 click 在 ui:pet 已持久化为 '1' 的机器上会反向关掉宠物形态 → 拍到球。
    const petRow = `[...document.querySelectorAll('.pet-sec .enable-row')].find(r=>r.textContent.includes('桌面宠物'))`
    const petFormOn = `!!(${petRow})?.querySelector('.switch')?.classList.contains('on')`
    const petFormEnable = `(()=>{const s=${petRow}?.querySelector('.switch'); if(s&&!s.classList.contains('on'))s.click()})()`
    if (wantPet) {
      await win.webContents.executeJavaScript('window.api.expand()', true)
      await new Promise((r) => setTimeout(r, 800))
      await win.webContents.executeJavaScript(openSettings, true)
      await new Promise((r) => setTimeout(r, 800))
      await win.webContents.executeJavaScript(petFormEnable, true)
      await new Promise((r) => setTimeout(r, 600))
      process.stdout.write('petFormOn: ' + String(await win.webContents.executeJavaScript(petFormOn, true)) + '\n')
      if (pickPet) {
        const idx = PET_IDS.indexOf(pickPet)
        if (idx < 0) {
          process.stdout.write(`BD_PET_ID 不在角色表里：${pickPet}\n`)
        } else {
          await win.webContents.executeJavaScript(
            `document.querySelectorAll('.pet-chip')[${idx}]?.click()`,
            true
          )
          await new Promise((r) => setTimeout(r, 600))
          const onIdx = await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('.pet-chip')].findIndex(c=>c.classList.contains('on'))`,
            true
          )
          process.stdout.write(
            `petChipOn: ${String(onIdx)} (want ${idx}=${pickPet})${onIdx === idx ? '' : '  ⚠ 未切换成功'}\n`
          )
        }
      }
      await win.webContents.executeJavaScript(back, true)
      await new Promise((r) => setTimeout(r, 600))
      await win.webContents.executeJavaScript(collapse, true)
      await new Promise((r) => setTimeout(r, 1600))
    } else if (process.env.BD_SKIP_COLLAPSE !== '1') {
      setCollapsed(true)
    }
    await new Promise((r) => setTimeout(r, 4500))
    const { mkdirSync, writeFileSync } = await import('fs')
    mkdirSync('/tmp/balancedeck-shots', { recursive: true })
    const shot = async (name: string, n = 1): Promise<void> => {
      for (let i = 0; i < n; i++) {
        const img = await win.webContents.capturePage()
        writeFileSync(`/tmp/balancedeck-shots/${name}${n > 1 ? '-' + (i + 1) : ''}.png`, img.toPNG())
        if (i < n - 1) await new Promise((r) => setTimeout(r, 900))
      }
      process.stdout.write(`shot: ${name}\n`)
    }
    // 宠物形态必须等到模型就位再拍：换角色时场景会重建，固定等待会拍到空画布
    if (wantPet) {
      for (let w = 0; w < 25; w++) {
        const ready = await win.webContents.executeJavaScript(
          'window.__bd_ball?.()?.petReady === true',
          true
        )
        if (ready) break
        await new Promise((r) => setTimeout(r, 400))
      }
    }
    // BD_PIN_POS=<x>,<z>：把宠物钉到指定世界坐标再拍（定点核对最坏位置：角落 / z 两端）。
    // 越界值会被漫游状态机夹进可行区，diag 里的 walker/roamArea 可核对是否真的钉到位。
    const pinPos = process.env.BD_PIN_POS
    if (pinPos !== undefined && wantPet) {
      const [px, pz] = pinPos.split(',').map(Number)
      if (Number.isFinite(px) && Number.isFinite(pz)) {
        await win.webContents.executeJavaScript(`window.__bd_pin?.(${px}, ${pz})`, true)
        process.stdout.write(`pin: (${px}, ${pz})\n`)
        await new Promise((r) => setTimeout(r, 800)) // 等球壳 x 跟随与偏航平滑收敛
      } else {
        process.stdout.write(`BD_PIN_POS 需要 "<x>,<z>"（世界单位），收到：${pinPos}\n`)
      }
    }
    // BD_ONLY=<名字子串>：只留下匹配的物体、其余全隐藏，用来单独量某个物体的 ink box。
    // 为什么需要：整景的 ink box 被玻璃球壳主导（球壳固定 z=0 → 尺寸恒定），宠物的透视缩放
    // 在里面只剩几个像素，量不出 R9 的缩放跨度；配 BD_ONLY=<宠物网格名> 才量得到宠物本体。
    const only = process.env.BD_ONLY
    if (only !== undefined) {
      const n = await win.webContents.executeJavaScript(
        `(()=>{const b=window.__bd_ball?.();if(!b)return -1;let k=0;
           b.dump.forEach((d,i)=>{if(!d.name.toLowerCase().includes(${JSON.stringify(
             (only || '').toLowerCase()
           )})){window.__bd_hide(i,false);k++}});return k})()`,
        true
      )
      process.stdout.write(`only: "${only}"（隐藏 ${String(n)} 个物体）\n`)
      await new Promise((r) => setTimeout(r, 350))
    }
    await shot(wantPet ? 'pet' : 'ball', 3)
    process.stdout.write(
      'diag: ' +
        String(
          await win.webContents.executeJavaScript(
            `JSON.stringify({
               win: [window.innerWidth, window.innerHeight],
               stage: (()=>{const s=document.querySelector('.petball-stage'); return s?[s.clientWidth,s.clientHeight]:null})(),
               canvas: (()=>{const c=document.querySelector('.pet3d-canvas'); return c?[c.width,c.height,c.clientWidth,c.clientHeight]:null})(),
               // 覆盖层实际占位（R8）：任一元素越出窗口就是被 .petball 的 overflow:hidden 切了
               overlay: [...document.querySelectorAll('.petball-caption,.petball-bubble,.petball-badge,.petball-toast,.petball-center-value')]
                 .map(e=>{const r=e.getBoundingClientRect();return [e.className.split(' ')[0],Math.round(r.left),Math.round(r.top),Math.round(r.right),Math.round(r.bottom)]}),
               ball: window.__bd_ball?.() ?? null
             })`,
            true
          )
        ) +
        '\n'
    )
    // BD_TOGGLE=1：快速验证「桌面宠物」开关与形态切换
    if (process.env.BD_TOGGLE === '1') {
      await win.webContents.executeJavaScript('window.api.expand()', true)
      await new Promise((r) => setTimeout(r, 800))
      await win.webContents.executeJavaScript(openSettings, true)
      await new Promise((r) => setTimeout(r, 1200))
      process.stdout.write(
        'switches: ' +
          String(await win.webContents.executeJavaScript("document.querySelectorAll('.pet-sec .switch').length", true)) +
          ' pet=' +
          String(await win.webContents.executeJavaScript("window.api.getExtras(['ui:pet']).then(e=>e['ui:pet'])", true)) +
          '\n'
      )
      await win.webContents.executeJavaScript("[...document.querySelectorAll('.pet-sec .switch')][0]?.click()", true)
      await new Promise((r) => setTimeout(r, 1200))
      process.stdout.write(
        'after click: pet=' +
          String(await win.webContents.executeJavaScript("window.api.getExtras(['ui:pet']).then(e=>e['ui:pet'])", true)) +
          ' switchOn=' +
          String(await win.webContents.executeJavaScript("document.querySelectorAll('.pet-sec .switch')[0]?.classList.contains('on')", true)) +
          '\n'
      )
    }
    // BD_ISOLATE=1：逐个隐藏场景物体各拍一张（定位"多出来的东西"）
    if (process.env.BD_ISOLATE === '1') {
      const n = Number(
        await win.webContents.executeJavaScript('window.__bd_ball().dump.length', true)
      )
      for (let i = 0; i < n; i++) {
        await win.webContents.executeJavaScript(`window.__bd_hide(${i}, false)`, true)
        await new Promise((r) => setTimeout(r, 350))
        const img = await win.webContents.capturePage()
        writeFileSync(`/tmp/balancedeck-shots/iso-${i}.png`, img.toPNG())
        await win.webContents.executeJavaScript(`window.__bd_hide(${i}, true)`, true)
        process.stdout.write(`iso-${i}\n`)
      }
    }
    // BD_SETTINGS=1：拍设置页宠物分区（核对 3D 缩略图）
    if (process.env.BD_SETTINGS === '1') {
      await win.webContents.executeJavaScript('window.api.expand()', true)
      await new Promise((r) => setTimeout(r, 700))
      await win.webContents.executeJavaScript(openSettings, true)
      await new Promise((r) => setTimeout(r, 900))
      await win.webContents.executeJavaScript("document.querySelector('.pet-sec')?.scrollIntoView({block:'center'})", true)
      await new Promise((r) => setTimeout(r, 4200))
      await shot('settings-pet')
      process.stdout.write(
        'petInfo: ' +
          String(await win.webContents.executeJavaScript('JSON.stringify(window.__bd_ball?.() ?? null)', true)) +
          '\n'
      )
    }
    // BD_PETS=1：逐只角色各拍一张（核对 3D 素材观感）
    if (process.env.BD_PETS === '1') {
      const ids = ['mochi', 'shiba', 'penguin', 'fox', 'panda', 'bunny', 'koala', 'tiger', 'aria', 'ray']
      for (let i = 0; i < ids.length; i++) {
        await win.webContents.executeJavaScript('window.api.expand()', true)
        await new Promise((r) => setTimeout(r, 700))
        await win.webContents.executeJavaScript(openSettings, true)
        await new Promise((r) => setTimeout(r, 600))
        await win.webContents.executeJavaScript(
          `document.querySelectorAll('.pet-chip')[${i}]?.click()`,
          true
        )
        await new Promise((r) => setTimeout(r, 400))
        await win.webContents.executeJavaScript(back, true)
        await new Promise((r) => setTimeout(r, 400))
        await win.webContents.executeJavaScript(collapse, true)
        // 真人系要解析 5 个 FBX（模型+4 段动作），软件渲染下比 Q 版慢：
        // 等到 petReady 才拍，否则拍到"模型还在路上"的空球
        for (let w = 0; w < 25; w++) {
          const ready = await win.webContents.executeJavaScript(
            'window.__bd_ball?.()?.petReady === true',
            true
          )
          if (ready) break
          await new Promise((r) => setTimeout(r, 400))
        }
        await shot(`pet-${ids[i]}`)
      }
    }
    if (process.env.BD_SKINS === '1') {
      const { setSkin } = await import('./skins')
      for (const id of ['dark', 'minimal', 'candy', 'ink', 'aero']) {
        await setSkin(id)
        await new Promise((r) => setTimeout(r, 1400))
        await shot(`ball-skin-${id}`)
      }
    }
    {
      const { petIgnoreState } = await import('./overlay')
      process.stdout.write('ballState: ' + JSON.stringify(petIgnoreState()) + '\n')
    }
    if (process.env.BD_DEBUG_RING === '1') {
      process.stdout.write(
        'ballDiag: ' + String(await win.webContents.executeJavaScript('JSON.stringify(window.__bd_ball?.() ?? null)', true)) + '\n'
      )
    }
    app.quit()
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
      if (level >= 3) {
        consoleErrors.push(message.slice(0, 200))
        // 测试期实时打印：出错时能立刻看到栈（否则要等整轮结束）
        if (process.env.BD_TRACE === '1') process.stdout.write(`[renderer:${level}] ${message.slice(0, 400)}\n`)
      }
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
  // 已开启开机自启时，用当前 .app 路径重写登录项（应用被移动过的自愈）
  syncAutostart()
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
  const shoot = async (
    name: string,
    opts: { rect?: { x: number; y: number; width: number; height: number }; frames?: number } = {}
  ): Promise<void> => {
    const frames = Math.max(1, opts.frames ?? 1)
    for (let i = 0; i < frames; i++) {
      const img = opts.rect ? await win.webContents.capturePage(opts.rect) : await win.webContents.capturePage()
      writeFileSync(`${OUT}/${name}${frames > 1 ? '-' + (i + 1) : ''}.png`, img.toPNG())
      if (i < frames - 1) await sleep(900)
    }
    process.stdout.write(`shot: ${name}\n`)
  }

  await sleep(6500)
  // 走查"断网/缓存"形态时需要一个真实快照做底模
  await exec('window.api.getState().then((s) => { window.__bd_state_snapshot = s.snapshots })')
  // 记录宠物圆点偏好：走查会临时开启，结束时还原
  const petWasOn = (await exec("window.api.getExtras(['ui:pet']).then(e=>e['ui:pet']==='1')")) === true
  await exec('window.api.expand()')
  await sleep(900)
  await shoot('1-card')
  await shoot('1-corner', { rect: { x: 0, y: 0, width: 80, height: 80 } })
  // 余额显隐（点击眼睛 → 打码；再点还原）
  await exec("[...document.querySelectorAll('.icon-btn')].find(b=>/余额/.test(b.title))?.click()")
  await sleep(500)
  await shoot('1b-card-hide-balance')
  await exec("[...document.querySelectorAll('.icon-btn')].find(b=>/余额/.test(b.title))?.click()")
  await sleep(400)
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
  // 系统区（开机自启开关 + 残留登录项警示）
  await shoot('3c-settings-system')
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
  // ─── 收起态：3D 悬浮球（默认形态）／桌面宠物（可选形态）─────────────────────
  const openSettings = "[...document.querySelectorAll('.btn-secondary')].find(b=>b.textContent.includes('设置'))?.click()"
  const backBtn = "[...document.querySelectorAll('.icon-btn')].find(b=>b.title==='返回')?.click()"
  const collapseBtn = "[...document.querySelectorAll('.btn-secondary')].find(b=>b.textContent.includes('收起'))?.click()"
  /** 点「桌面宠物」开关（.pet-sec 里第 1 个开关） */
  const petToggle = "[...document.querySelectorAll('.pet-sec .switch')][0]?.click()"
  const longPress = (down: boolean): string => `(()=>{
    const b=document.querySelector('.petball-hit'); if(!b) return
    const rc=b.getBoundingClientRect()
    const o={clientX:rc.x+rc.width/2,clientY:rc.y+rc.height/2,pointerId:11,bubbles:true,pointerType:'mouse',button:0,buttons:${down ? 1 : 0}}
    b.dispatchEvent(new PointerEvent('${down ? 'pointerdown' : 'pointerup'}',o))
  })()`

  await exec(backBtn)
  await sleep(500)
  // 设置页宠物分区特写（3D 缩略图 / 养成数据 / 两个开关 / 数据迁移）
  await exec(openSettings)
  await sleep(700)
  await exec("document.querySelector('.pet-sec')?.scrollIntoView({block:'center'})")
  await sleep(4500) // 等 8 张 3D 缩略图渲染完（软渲染器上要几秒）
  await shoot('4b-settings-pet')
  await exec(backBtn)
  await sleep(500)

  // ① 球形态（默认）：球 + 用量环 + 环心数值
  await exec(collapseBtn)
  await sleep(1800)
  await shoot('5-ball', { frames: 3 })
  // 各皮肤下的球体（回归"只有毛玻璃皮肤有立体效果"）
  for (const id of ['dark', 'minimal', 'candy', 'ink', 'aero']) {
    await exec(`window.api.setSkin('${id}')`)
    await sleep(1100)
    await shoot(`5c-ball-${id}`)
  }

  // ② 桌面宠物形态：球内角色会走动 + 长按撸一把 + 右键菜单
  await exec('window.api.expand()')
  await sleep(700)
  await exec(openSettings)
  await sleep(600)
  await exec(petToggle)
  await sleep(400)
  await exec(backBtn)
  await sleep(400)
  await exec(collapseBtn)
  await sleep(2000)
  await shoot('5b-pet', { frames: 2 })
  await exec(longPress(true))
  await sleep(900)
  await shoot('5d-pet-happy')
  await exec(longPress(false))
  await sleep(400)
  await exec(`(()=>{
    const b=document.querySelector('.petball-hit'); if(!b) return
    const rc=b.getBoundingClientRect()
    b.dispatchEvent(new MouseEvent('contextmenu',{clientX:rc.x+rc.width/2,clientY:rc.y+rc.height/2,bubbles:true}))
  })()`)
  await sleep(900)
  await shoot('5e-pet-menu')
  await exec("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
  await sleep(500)

  // 逐只角色各拍一张（3D 素材观感）
  const species = ['shiba', 'penguin', 'fox', 'panda']
  for (let i = 0; i < species.length; i++) {
    await exec('window.api.expand()')
    await sleep(700)
    await exec(openSettings)
    await sleep(700)
    await exec(`document.querySelectorAll('.pet-chip')[${[1, 2, 3, 4][i]}]?.click()`)
    await sleep(500)
    await exec(backBtn)
    await sleep(400)
    await exec(collapseBtn)
    await sleep(1800)
    await shoot(`5f-pet-${species[i]}`)
  }

  // 还原：关掉桌面宠物（默认球形态），回到卡片视图
  await exec('window.api.expand()')
  await sleep(700)
  await exec(openSettings)
  await sleep(700)
  await exec(petToggle)
  await sleep(400)
  await exec(backBtn)
  await sleep(500)

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

  // README/宣传用演示图：注入干净示例数据（不含真实账户信息），拍一张主面板全貌
  await exec("document.querySelector('.detail .icon-btn')?.click()")
  await sleep(500)
  await exec(`window.api.debugPush(${JSON.stringify(demoSnapshot())}, false)`)
  await sleep(900)
  await shoot('9-demo')
}

/** 演示数据（README 截图用：金额/百分比均为编造） */
function demoSnapshot(): unknown[] {
  const iso = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString()
  const nowIso = new Date().toISOString()
  const base = { builtin: true, dataQuality: 'official', dataAt: nowIso, updatedAt: nowIso }
  return [
    {
      ...base,
      id: 'demo-opencode',
      name: 'OpenCode Go',
      kind: 'coding',
      mark: 'opencode',
      plan: 'Go 套餐',
      status: 'ok',
      source: '控制台（精确） + 官方 API',
      windows: [
        { name: '5 小时', used: 0.62, limit: 12, unit: 'usd', percent: 5.2, resetAt: iso(3.4) },
        { name: '本周', used: 9.9, limit: 30, unit: 'usd', percent: 33, resetAt: iso(52) },
        { name: '本月', used: 24.6, limit: 60, unit: 'usd', percent: 41, resetAt: iso(210) }
      ]
    },
    {
      ...base,
      id: 'demo-claude',
      name: 'Claude Code',
      kind: 'coding',
      mark: 'claude',
      plan: 'Max',
      status: 'ok',
      source: '本机统计',
      windows: [{ name: '5 小时', used: 3.42, limit: 25, unit: 'usd', percent: 13.7, resetAt: iso(2.1) }]
    },
    {
      ...base,
      id: 'demo-deepseek',
      name: 'DeepSeek',
      kind: 'balance',
      mark: 'deepseek',
      status: 'ok',
      source: '官方 API',
      windows: [{ name: '账户余额', used: 1288.5, unit: 'cny' }]
    }
  ]
}

// —— UI 交互自动化测试 ——
async function runUiTest(
  win: Electron.BrowserWindow,
  consoleErrors: string[]
): Promise<Record<string, string>> {
  const r: Record<string, string> = {}
  // 开机自启测试落在临时目录，避免在开发者机器上写入真实 LaunchAgent
  const autostartDir = join(app.getPath('temp'), 'balancedeck-uitest-autostart')
  process.env.BALANCEDECK_AUTOSTART_DIR = autostartDir
  const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))
  const exec = (js: string): Promise<unknown> => win.webContents.executeJavaScript(js, true)
  const bounds = (): Electron.Rectangle => win.getBounds()
  /** 收起态的窗口是 320×230 漫游区，球在正中：点击 = 点命中层中心 */
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
  r.collapse = b1.width === 200 && b1.height === 210 ? 'ok' : `fail:${b1.width}x${b1.height}`
  r.dotDom = (await exec("!!document.querySelector('.petball') && !!document.querySelector('.petball-hit')"))
    ? 'ok'
    : 'fail'
  r.ball3d = (await exec("!!document.querySelector('.pet3d-canvas')")) ? 'ok' : 'fail:no-canvas'
  r.ballValue = String(await exec("document.querySelector('.petball-value')?.textContent ?? ''"))

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
  r.refreshThenCollapse = bounds().width === 200 ? 'ok' : `fail:${bounds().width}`
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

  // ─── 宠物：设置页互动 + 3D 悬浮球（桌面宠物）+ 鼠标穿透 ─────────────────────
  const { getExtra } = await import('./keystore')
  const readPet = async (): Promise<{ affection: number; fullness: number; level: number }> => {
    const fallback = { affection: 60, fullness: 70, level: 1 }
    const raw = await getExtra('ui:petState')
    if (!raw) return fallback
    try {
      const v = JSON.parse(raw) as Partial<{ affection: number; fullness: number; level: number }>
      return {
        affection: typeof v.affection === 'number' ? v.affection : fallback.affection,
        fullness: typeof v.fullness === 'number' ? v.fullness : fallback.fullness,
        level: typeof v.level === 'number' ? v.level : fallback.level
      }
    } catch {
      return fallback
    }
  }
  // 用户原本是否开着「桌面宠物」（'1' 才算开；默认关闭 = 3D 球形态）
  const petWasOn = (await exec("window.api.getExtras(['ui:pet']).then(e=>e['ui:pet']==='1')")) === true
  // 面板不再常驻宠物卡（用户要求）：确认已移除
  r.petCardRemoved = (await exec("!!document.querySelector('.pet-card')")) ? 'fail:still-there' : 'ok'

  // 设置页宠物分区：撸一把 / 喂食 / 换一只 / 桌面宠物开关
  await exec(footerClick('设置'))
  await sleep(700)
  r.petSection = (await exec("!!document.querySelector('.pet-sec') && document.querySelectorAll('.pet-chip').length === 10"))
    ? 'ok'
    : 'fail:no-section'
  // 角色缩略图由 3D 素材渲染（异步）：等它们出来
  for (let i = 0; i < 40; i++) {
    if ((await exec("document.querySelectorAll('.pet-chip img').length === 10")) === true) break
    await sleep(400)
  }
  r.petThumbs = (await exec("document.querySelectorAll('.pet-chip img').length === 10")) ? 'ok' : 'fail:no-thumbs'
  const clickPetAction = (label: string): Promise<unknown> =>
    exec(
      `[...document.querySelectorAll('.pet-sec .pet-actions .btn-secondary')].find(b=>b.textContent.includes('${label}'))?.click()`
    )
  const beforePet = await readPet()
  await clickPetAction('撸一把')
  await sleep(900)
  const afterPet = await readPet()
  r.petStroke =
    afterPet.affection > beforePet.affection || beforePet.affection >= 100
      ? 'ok'
      : `fail:${beforePet.affection}->${afterPet.affection}`
  const beforeFeed = await readPet()
  await clickPetAction('喂食')
  await sleep(900)
  const afterFeed = await readPet()
  const fullBefore = beforeFeed.fullness >= 95
  r.petFeed = fullBefore
    ? afterFeed.fullness === beforeFeed.fullness
      ? 'ok(refused)'
      : 'fail:not-refused'
    : afterFeed.fullness > beforeFeed.fullness
      ? 'ok'
      : `fail:${beforeFeed.fullness}->${afterFeed.fullness}`

  // 换一只：形象与默认名一起切换
  const petIdBefore = String(await exec("document.querySelector('.petball')?.dataset.pet ?? ''"))
  await exec(`[...document.querySelectorAll('.pet-chip')].find(c=>!c.classList.contains('on'))?.click()`)
  await sleep(600)
  r.petSwitch = (await exec("document.querySelector('.pet-chip.on')?.textContent?.length > 0")) ? 'ok' : 'fail'
  void petIdBefore

  // 桌面宠物开关：关掉 → 收起态退回 2D 圆点（无 WebGL）；再开回来
  const petSwitch = async (): Promise<void> => {
    await exec("[...document.querySelectorAll('.pet-sec .switch')][0]?.click()")
    await sleep(500)
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
  await petSwitch()
  r.petToggleSaved = (await exec("window.api.getExtras(['ui:pet']).then(e=>e['ui:pet']==='1')")) === true ? 'ok' : 'fail:not-saved'

  // ── 桌面宠物形态：窗口是漫游区（320×230），角色素材就位，穿透生效 ──
  await gotoView('collapse')
  r.petBallOn = (await exec("document.querySelector('.petball')?.dataset.roam === '1'")) ? 'ok' : 'fail:roam-off'
  r.petRoamWindow = bounds().width === 320 && bounds().height === 230 ? 'ok' : `fail:${bounds().width}x${bounds().height}`
  r.pet3dCanvas = (await exec("!!document.querySelector('.pet3d-canvas')")) ? 'ok' : 'fail:no-canvas'
  for (let i = 0; i < 30; i++) {
    if ((await exec('window.__bd_ball?.()?.petReady === true')) === true) break
    await sleep(300)
  }
  r.petModel = (await exec('window.__bd_ball?.()?.petReady === true')) ? 'ok' : 'fail:model-not-loaded'
  r.petSvgIdle = String(await exec("document.querySelector('.petball')?.dataset.pet ?? ''"))
  r.petCenterValue = (await exec("!!document.querySelector('.petball-center-value')"))
    ? 'fail:should-be-caption'
    : 'ok'

  // 置顶开关（默认开；关掉后主进程不再置顶；再开回来）
  const topDefault = (await exec('window.api.debugPetState()')) as { alwaysOnTop: boolean } | null
  r.petTopDefault = topDefault?.alwaysOnTop === true ? 'ok' : 'fail:default-off'
  const topOff = (await exec('window.api.debugSetTop(false)')) as { alwaysOnTop: boolean } | null
  r.petTopOff = topOff?.alwaysOnTop === false ? 'ok' : 'fail:still-on-top'
  const topOn = (await exec('window.api.debugSetTop(true)')) as { alwaysOnTop: boolean } | null
  r.petTopOn = topOn?.alwaysOnTop === true ? 'ok' : 'fail:cannot-restore'

  // 穿透机制：主进程轮询在跑（roaming）+ 渲染层已上报命中框（hitbox 非空）
  const watch = petIgnoreState()
  const hb = petHitboxDebug()
  r.petPierce = watch.roaming && hb && hb.width > 20 ? 'ok' : `fail:roaming=${watch.roaming},hb=${JSON.stringify(hb)}`
  r.petCmdOk = watch.collapsed === true && bounds().width === 320 ? 'ok' : `fail:${bounds().width}`
  // 收起态必须关掉原生窗口阴影（否则 macOS 会按窗口矩形投一层方框阴影，实机表现为"宠物外面有个四方形框"）
  r.petNoWindowShadow = watch.shadow === false ? 'ok' : 'fail:has-shadow'
  const ball = (await exec('window.__bd_ball?.() ?? null')) as
    | { rect: { x: number; y: number; width: number; height: number }; measure: { box: { width: number; height: number } } }
    | null
  r.petDiag = JSON.stringify({
    watch,
    hb: hb && { w: Math.round(hb.width), h: Math.round(hb.height) },
    rect: ball && { w: Math.round(ball.rect.width), h: Math.round(ball.rect.height) },
    ink: ball && { w: ball.measure.box.width, h: ball.measure.box.height }
  })

  // 长按撸一把：亲密度上升、播放开心动作，且**不展开面板**
  await sleep(5400) // 越过互动冷却（5s）
  const affBefore = (await readPet()).affection
  await exec(`(async()=>{
    const b=document.querySelector('.petball-hit'); if(!b) return
    const rc=b.getBoundingClientRect()
    const o={clientX:rc.x+rc.width/2,clientY:rc.y+rc.height/2,pointerId:31,bubbles:true,pointerType:'mouse',button:0,buttons:1}
    b.dispatchEvent(new PointerEvent('pointerdown',o))
    await new Promise(r=>setTimeout(r,780))
    b.dispatchEvent(new PointerEvent('pointerup',{...o,buttons:0}))
  })()`)
  await sleep(600)
  const affAfter = (await readPet()).affection
  const stillCollapsedAfterHold = bounds().width === 320
  r.petLongPress =
    stillCollapsedAfterHold && affAfter > affBefore
      ? 'ok'
      : `fail:${stillCollapsedAfterHold ? '' : 'expanded'}:${affBefore}->${affAfter}`
  r.petToast = (await exec("!!document.querySelector('.petball-toast')")) ? 'ok' : 'fail:no-toast'

  // 回归：右键（含菜单被点开后关闭）不得让宠物进入"黏住光标"的假拖拽状态
  //   —— 现象是菜单关掉后移动鼠标，窗口跟着光标乱跑，直到再点一次宠物才释放
  consumeDragFired()
  await exec(`(async()=>{
    const b=document.querySelector('.petball-hit'); if(!b) return
    const rc=b.getBoundingClientRect()
    const cx=rc.x+rc.width/2, cy=rc.y+rc.height/2
    const right={clientX:cx,clientY:cy,pointerId:21,bubbles:true,pointerType:'mouse',button:2,buttons:2}
    b.dispatchEvent(new PointerEvent('pointerdown',right))
    b.dispatchEvent(new MouseEvent('contextmenu',{clientX:cx,clientY:cy,bubbles:true}))
    await new Promise(r=>setTimeout(r,200))
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))
    await new Promise(r=>setTimeout(r,300))
    // 菜单关闭后：无按键移动鼠标（buttons=0），绝不允许触发拖拽
    for(let i=1;i<=5;i++){
      b.dispatchEvent(new PointerEvent('pointermove',{clientX:cx+i*20,clientY:cy,pointerId:21,bubbles:true,pointerType:'mouse',button:-1,buttons:0}))
      await new Promise(r=>setTimeout(r,40))
    }
  })()`)
  await sleep(600)
  r.petNoStickyDrag = consumeDragFired() ? 'fail:drag-started' : 'ok'
  r.petStillCollapsed = bounds().width === 320 ? 'ok' : `fail:${bounds().width}`

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
  await petSwitch()
  r.petToggleOff = (await exec("window.api.getExtras(['ui:pet']).then(e=>e['ui:pet']==='0')")) === true ? 'ok' : 'fail:not-saved'
  await gotoView('collapse')
  r.petBallOff = (await exec("document.querySelector('.petball')?.dataset.roam === '0'")) ? 'ok' : 'fail:roam-on'
  r.petBallWindow = bounds().width === 200 && bounds().height === 210 ? 'ok' : `fail:${bounds().width}x${bounds().height}`
  r.petBall3d =
    (await exec("!!document.querySelector('.pet3d-canvas')")) &&
    !(await exec("!!document.querySelector('.petball-fallback')"))
      ? 'ok'
      : 'fail:no-canvas'
  // 球形态：数值回到环心（宠物形态才放球下方胶囊）
  r.petBallCenterValue = (await exec("!!document.querySelector('.petball-center-value')")) ? 'ok' : 'fail:no-center-value'
  await exec(dotClickJs())
  await sleep(1000)
  r.petBallExpand = bounds().width > 300 ? 'ok' : `fail:${bounds().width}`

  // 还原用户的桌面宠物偏好（默认：关闭）
  if (petWasOn) {
    await exec(footerClick('设置'))
    await sleep(600)
    await petSwitch()
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
  return r
}
