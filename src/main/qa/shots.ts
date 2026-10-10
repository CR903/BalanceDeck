// 设计走查 / UI 自动化测试 —— 从 src/main/index.ts 搬出来的 QA 工具。
//
// 这里的代码**不参与产品运行**：只有带 --shots / --uitest / --ballshot 等参数启动时才走到。
// 搬出来的原因见架构评审候选 C6：入口模块的接口是「启动应用」，而它此前 95% 是实现细节 ——
// 运行模式、截图走查、750 行 UI 断言全挤在一起，改启动流程时要在测试代码里翻。
// 纪律：新增断言请放在 uitest.ts，不要在 index.ts 里长回来。

// --shots：设计走查截图（主页 / 详情 / 设置 / 各皮肤的收起态 / 断网缓存态）。
// 产物在 /tmp/balancedeck-shots/。
import { app } from 'electron'
import { join } from 'path'
import { demoSnapshot } from './fixtures'
import { ISLAND_VIEW } from '../../shared/pet-view'

export async function runShots(win: Electron.BrowserWindow): Promise<void> {
  const { mkdirSync, writeFileSync } = await import('fs')
  const { setSkin } = await import('../skins')
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
  // ─── 收起态：顶部灵动岛（唯一的形态）─────────────────
  const backBtn = "[...document.querySelectorAll('.icon-btn')].find(b=>b.title==='返回')?.click()"
  const collapseBtn = "[...document.querySelectorAll('.btn-secondary')].find(b=>b.textContent.includes('收起'))?.click()"
  /**
   * 收起/展开后等画面**真的可以拍**再按快门。两个条件缺一不可：
   *   · 窗口尺寸已经落到目标值（setBounds 是异步的，改尺寸后合成器要重画一帧）
   *   · 再等**两帧真正合成**。capturePage 抓的是**合成结果**，measure 式的
   *     缓冲检查在这里不适用（纯 DOM，无 WebGL 缓冲可读）。
   * 少了这一步，收起后的第一张就是空的（实测 5-ball-1 只有泡泡；同组第 2 帧正常）。
   */
  const settle = async (expect?: { width: number; height: number }): Promise<void> => {
    if (expect) {
      for (let i = 0; i < 40; i++) {
        const b = win.getBounds()
        if (b.width === expect.width && b.height === expect.height) break
        await sleep(150)
      }
    }
    await sleep(600)
    // 再等**两帧真正合成**。
    await exec('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))')
  }

  await exec(backBtn)
  await sleep(500)

  // ─── 收起态：顶部灵动岛（10-10-dynamic-island）─────────────────
  await exec(collapseBtn)
  await settle(ISLAND_VIEW)
  await shoot('5-island', { frames: 3 })
  // 岛自描述探针：形态 / 家数 / combos kind（截图解码时不再猜供应商）
  process.stdout.write(
    `5-probe: ${String(
      await exec(`(()=>{
        const body=document.querySelector('.isl-body');
        if(!body) return 'no-island';
        return JSON.stringify({
          mode:body.getAttribute('data-island'),
          combos:[...body.querySelectorAll('.isl-combo')].map(c=>c.getAttribute('data-supplier')+':'+c.getAttribute('data-kind')+'/'+c.getAttribute('data-lvl')),
          strip:(()=>{const s=body.querySelector('.isl-strip'); const r=s?s.getBoundingClientRect():null; return r?Math.round(r.width)+'x'+Math.round(r.height):'?'})()
        });
      })()`)
    )}\n`
  )
  // ② 展开态：单击岛身 pop 出 2 列卡片（只读：窗口行 名 · % · 倒计时 + 余额金额）
  const islTap = `(()=>{const b=document.querySelector('.isl-hit'); if(!b) return 'no-island'
    const rc=b.getBoundingClientRect()
    const o={clientX:rc.x+rc.width/2,clientY:rc.y+10,pointerId:7,bubbles:true,pointerType:'mouse',button:0,buttons:1}
    b.dispatchEvent(new PointerEvent('pointerdown',o))
    b.dispatchEvent(new PointerEvent('pointerup',{...o,buttons:0}))
    return 'sent'})()`
  await exec(islTap)
  await sleep(800)
  process.stdout.write(
    `5o-probe: ${String(
      await exec(`(()=>{
        const g=document.querySelector('.isl-grid'); if(!g) return 'no-grid';
        return JSON.stringify({
          cells:[...g.querySelectorAll('.isl-cell')].map(c=>c.getAttribute('data-supplier')+':'+c.getAttribute('data-kind')),
          wins:[...g.querySelectorAll('.isl-win')].map(w=>w.textContent).slice(0,3),
          bigs:[...g.querySelectorAll('.isl-big')].map(b=>b.textContent)
        });
      })()`)
    )}\n`
  )
  await shoot('5-island-open')
  // 再点一次收起展开态
  await exec(islTap)
  await sleep(600)
  // 旧流体取帧钩子保留位（J4b：shots 经 __bd_fluid_freeze 取帧；岛无 morph，off 即复位语义）
  await exec(`window.__bd_fluid_freeze?.('off')`)

  // ③ 隐藏态走查（AC5）：贴边停留 → 岛缩成 mini-pill（窗口不动）→ 点击唤出
  // ⚠ capturePage 拍的是窗口内容 —— 5g 证明"原位收缩渲染无损"（顶部窄条 + 等级点），
  //   命中区即 pill 的证据在 uitest 的 dockHide/islandPill 断言，不在 PNG 里。
  // 真光标冻结：走查机上鼠标若停在 pill 上，2500ms 里足够唤回一次，截图就错过隐藏态
  await exec('window.api.debugDockFreeze(true)')
  await exec("window.api.debugDockEdge('top')")
  await sleep(2500) // 真实计时：1000ms 停留 + 300ms 隐藏动画
  await shoot('5g-dock-hidden')
  process.stdout.write(
    `5g-probe: ${String(
      await exec(`(()=>{
        const pill=document.querySelector('.isl-pill'); if(!pill) return 'no-pillar';
        const r=pill.getBoundingClientRect();
        return JSON.stringify({
          mode:document.querySelector('.isl-body')?.getAttribute('data-island'),
          pillW:Math.round(r.width), pillH:Math.round(r.height),
          dots:[...pill.querySelectorAll('.isl-dot')].length
        });
      })()`)
    )}\n`
  )
  await exec('window.api.debugDockCursor(true)')
  await sleep(1500) // 真实计时：300ms 唤出停留 + 400ms morph 尾
  await shoot('5h-dock-revealed')
  await exec('window.api.debugDockFreeze(false)')
  await exec(`window.api.debugPush(${JSON.stringify(demoSnapshot())}, false)`)
  await sleep(900)
  await exec('window.api.expand()')
  await sleep(700)

  // 右键菜单走查：原生菜单打开（Esc 关掉），期间不崩、渲染层仍存活。
  // 菜单本身是原生窗口，capturePage 抓不到它 —— 这张证明菜单弹出前后渲染层无损。
  // 先收起（菜单挂在岛上），拍完回卡片视图。
  await exec(collapseBtn)
  await settle(ISLAND_VIEW)
  await exec(`(()=>{
    const b=document.querySelector('.isl-hit'); if(!b) return
    const rc=b.getBoundingClientRect()
    b.dispatchEvent(new MouseEvent('contextmenu',{clientX:rc.x+rc.width/2,clientY:rc.y+10,bubbles:true}))
  })()`)
  await sleep(900)
  await shoot('5e-island-menu')
  await exec("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
  await sleep(500)

  // 回到卡片视图
  await exec('window.api.expand()')
  await sleep(700)
  // 回到卡片视图
  await exec('window.api.expand()')
  await sleep(700)

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
