// --ballshot：只拍收起态（默认球形态 = 2D 小圆环；BD_PET=1 是个性人物的 3D 场景），十几秒出图。
//
// 环境变量开关（见 README 脚本表）：BD_PET=1 宠物形态 / BD_PETS=1 逐只角色 /
// BD_PET_ID=<id> 指定角色 / BD_FAKE_DATA=0 不注入演示数据。
// ⚠ BD_ONLY / BD_ISOLATE / BD_DEBUG_RING 读 3D 场景（window.__bd_ball），**仅人物形态有效**；
//   球形态下会打一行说明而不是静默无效。
//
// 注：函数体保留了它当年在 app.whenReady 回调里的缩进（块内含多行模板串，
// 统一去缩进会改到被注入代码的内容 —— 缩进不影响语义，就不动它了）。
import { app } from 'electron'
import { demoSnapshot } from './fixtures'
import { createOverlay } from '../overlay'
import { setCollapsed } from '../overlay'

export async function runBallshot(): Promise<void> {
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
    // BD_PET=1：确保「个性人物」形态开启后再收起（默认拍球形态）
    // BD_PET_ID=<id>：顺带在设置页换成指定角色（只换一只；逐只请用多次调用，见 BD_PETS 的上下文限制）
    const PET_IDS = ['aria', 'ray']
    const pickPet = process.env.BD_PET_ID ?? ''
    const wantPet = process.env.BD_PET === '1' || pickPet !== ''
    const openSettings = `[...document.querySelectorAll('.btn-secondary')].find(b=>b.textContent.includes('设置'))?.click()`
    const back = `[...document.querySelectorAll('.icon-btn')].find(b=>b.title==='返回')?.click()`
    const collapse = `[...document.querySelectorAll('.btn-secondary')].find(b=>b.textContent.includes('收起'))?.click()`
    // 开关按相邻文本定位（该分区还会继续加开关，下标必然漂移），且只在未开启时点一次：
    // 它是 toggle，无条件 click 在 ui:pet 已持久化为 '1' 的机器上会反向关掉人物形态 → 拍到球。
    // ⚠ 文案改过一次（桌面宠物 → 个性人物），这里必须跟着改：匹配不到就永远拍球形态。
    const petRow = `[...document.querySelectorAll('.pet-sec .enable-row')].find(r=>r.textContent.includes('个性人物'))`
    const petFormOn = `(() => { const r=${petRow}; return !!(r && r.querySelector('.switch') && r.querySelector('.switch').classList.contains('on')) })()`
    const petFormEnable = `(()=>{const r=${petRow}; const s=r?.querySelector('.switch'); if(s&&!s.classList.contains('on')){s.click(); console.log('宠物开关已打开')}else{console.log('开关状态:',s?.classList.contains('on')?'已开':'未找到')}})()`
    if (wantPet) {
      await win.webContents.executeJavaScript('window.api.expand()', true)
      await new Promise((r) => setTimeout(r, 800))
      await win.webContents.executeJavaScript(openSettings, true)
      await new Promise((r) => setTimeout(r, 1500))
      await win.webContents.executeJavaScript(petFormEnable, true)
      await new Promise((r) => setTimeout(r, 600))
      const on = await win.webContents.executeJavaScript(petFormOn, true)
      process.stdout.write('petFormOn: ' + String(on) + '\n')
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
    // ─── 下面这几个开关都读 window.__bd_ball()（3D 场景）→ **仅人物形态有效** ───
    // 球形态 2026-09-27 回到 2D 小圆环，不再创建场景，__bd_ball() 的字段全是 null/[]。
    // 静默无效的开关是最坏的形态（用的人只会以为它坏了），所以每个都在球形态下打一行说明。
    const hasScene = (await win.webContents.executeJavaScript(
      '!!(window.__bd_ball?.()?.petReady === true)',
      true
    )) as boolean
    const needScene = (name: string): void => {
      if (!hasScene) {
        process.stdout.write(
          `⚠ BD_${name} 需要 3D 场景，球形态下没有（球形态是 2D 小圆环，见 PetBall 的守卫）。` +
            `加 BD_PET=1 走人物形态。\n`
        )
      }
    }
    // BD_ONLY=<名字子串>：只留下匹配的物体、其余全隐藏，用来单独量某个物体的 ink box。
    // 为什么需要：人物形态的整景 ink box 里人物与地面阴影混在一起，配 BD_ONLY=<人物网格名> 才量得到人物本体。
    const only = process.env.BD_ONLY
    if (only !== undefined) {
      needScene('ONLY')
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
               // 球形态的 2D 小圆环是 56×56 窗口里的唯一内容，也列进来核对它没被切
               overlay: [...document.querySelectorAll('.petball-fallback,.petball-caption,.petball-bubble,.petball-badge,.petball-toast')]
                 .map(e=>{const r=e.getBoundingClientRect();return [e.className.split(' ')[0],Math.round(r.left),Math.round(r.top),Math.round(r.right),Math.round(r.bottom)]}),
               ball: window.__bd_ball?.() ?? null
             })`,
            true
          )
        ) +
        '\n'
    )
    // BD_TOGGLE=1：快速验证「个性人物」开关与形态切换
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
      needScene('ISOLATE')
      if (!hasScene) {
        process.stdout.write('  （跳过：没有场景可逐个隔离）\n')
      } else {
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
        (hasScene ? '' : '⚠ petInfo 需要 3D 场景（球形态下字段全为 null/[]，加 BD_PET=1 走人物形态）\n') +
          'petInfo: ' +
          String(await win.webContents.executeJavaScript('JSON.stringify(window.__bd_ball?.() ?? null)', true)) +
          '\n'
      )
    }
    // BD_PETS=1：逐只角色各拍一张（核对 3D 素材观感）
    if (process.env.BD_PETS === '1') {
      const ids = ['aria', 'ray']
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
      const { setSkin } = await import('../skins')
      for (const id of ['dark', 'minimal', 'candy', 'ink', 'aero']) {
        await setSkin(id)
        await new Promise((r) => setTimeout(r, 1400))
        await shot(`ball-skin-${id}`)
      }
    }
    {
      const { petIgnoreState } = await import('../overlay')
      process.stdout.write('ballState: ' + JSON.stringify(petIgnoreState()) + '\n')
    }
    if (process.env.BD_DEBUG_RING === '1') {
      needScene('DEBUG_RING')
      process.stdout.write(
        'ballDiag: ' + String(await win.webContents.executeJavaScript('JSON.stringify(window.__bd_ball?.() ?? null)', true)) + '\n'
      )
    }
    app.quit()
    return
}
