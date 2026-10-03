// --ballshot：只拍收起态 2D 小圆环，十几秒出图。
//
// 人物形态已下线（10-03-remove-human）：BD_PET / BD_PET_ID / BD_PETS / BD_ONLY /
// BD_ISOLATE / BD_TOGGLE / BD_DEBUG_RING / BD_SETTINGS 全部退役 —— 它们都读 3D 场景
// （window.__bd_ball 的 petReady/dump/gesture），而收起态不再创建场景。
// 传了这些变量只会打一行说明，不静默拍错图。
//
// 环境变量开关：BD_FAKE_DATA=0 不注入演示数据；BD_SKIP_COLLAPSE=1 不收起；
// BD_SKINS=1 逐皮肤各拍一张。
import { app } from 'electron'
import { demoSnapshot } from './fixtures'
import { createOverlay } from '../overlay'
import { setCollapsed } from '../overlay'

const RETIRED = ['BD_PET', 'BD_PET_ID', 'BD_PETS', 'BD_ONLY', 'BD_ISOLATE', 'BD_TOGGLE', 'BD_DEBUG_RING', 'BD_SETTINGS']

export async function runBallshot(): Promise<void> {
    // 兜底：无论如何退出（离线环境下采集可能长时间阻塞）
    setTimeout(() => app.quit(), 60_000)
    const win = createOverlay()
    // 渲染层报错要看得到
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) process.stdout.write(`[renderer:${level}] ${message.slice(0, 300)}\n`)
    })
    for (const k of RETIRED) {
      if (process.env[k] !== undefined) {
        process.stdout.write(`⚠ ${k} 已随人物形态下线（10-03-remove-human），本次忽略，只拍 2D 小圆环。\n`)
      }
    }
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
    if (process.env.BD_SKIP_COLLAPSE !== '1') {
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
    await shot('ball', 3)
    process.stdout.write(
      'diag: ' +
        String(
          await win.webContents.executeJavaScript(
            `JSON.stringify({
               win: [window.innerWidth, window.innerHeight],
               stage: (()=>{const s=document.querySelector('.petball-stage'); return s?[s.clientWidth,s.clientHeight]:null})(),
               // 覆盖层实际占位（R8）：任一元素越出窗口就是被 .petball 的 overflow:hidden 切了
               // 2D 小圆环是 56×56 窗口里的唯一内容，也列进来核对它没被切
               // .petball-confirm 是最容易越界的一个
               overlay: [...document.querySelectorAll('.petball-fallback,.petball-bubble,.petball-confirm,.petball-badge,.petball-toast')]
                 .map(e=>{const r=e.getBoundingClientRect();return [e.className.split(' ')[0],Math.round(r.left),Math.round(r.top),Math.round(r.right),Math.round(r.bottom)]}),
               ball: window.__bd_ball?.() ?? null
             })`,
            true
          )
        ) +
        '\n'
    )
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
    app.quit()
    return
}
