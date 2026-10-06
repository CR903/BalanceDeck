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
import { demoSnapshot, column70Snapshot, wave40Snapshot } from './fixtures'
import { BALL_VIEW } from '../../shared/pet-view'

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
  // ─── 收起态：2D 小水球（唯一的形态）─────────────────
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

  // ① 小水球（56×56，纯 DOM，球内水体 + 环心读数）。
  await exec(collapseBtn)
  await settle(BALL_VIEW)
  await shoot('5-ball', { frames: 3 })
  // 波形对照（R1）：先推单家 40% 再循环换肤，五帧同一液面，波顶位置不同即振幅不同。
  // 拍完恢复演示数据（5l 及之后沿用原夹具，轮播行为不变）。
  await exec(`window.api.debugPush(${JSON.stringify(wave40Snapshot())}, false)`)
  await sleep(900)
  // 各皮肤下的小水球（水色/底色都走令牌，逐皮肤必须都对）
  for (const id of ['dark', 'minimal', 'candy', 'ink', 'aero']) {
    await exec(`window.api.setSkin('${id}')`)
    await sleep(1100)
    await shoot(`5c-ball-${id}`)
    // 波形自描述：A 层路径纵向极差 = 2×振幅（R1 各皮肤波形对拍，不靠像素猜）
    const waveRange = String(
      await exec(`(()=>{
        const w=document.querySelector('.fluid-wave-a');
        if(!w) return 'no-waves';
        const nums=[...((w.getAttribute('d')||'').match(/-?\\d+\\.?\\d*/g)||[])].map(Number);
        // Y 取奇数位；末尾两个是封口角（L 96 60 L -40 60 Z），不是波面，剔除
        const ys=nums.filter((_,i)=>i%2===1).slice(0,-2);
        if(ys.length<4) return 'bad-d';
        return JSON.stringify({n:ys.length,range:+(Math.max(...ys)-Math.min(...ys)).toFixed(2)});
      })()`)
    )
    process.stdout.write(`5c-wave: ${id} ${waveRange}\n`)
    // 形态探针（P6 环替代水体）：逐皮读「环显隐 / 水体显隐 / 弧长 dasharray /
    // 弧色 / 半径」，不靠像素猜。弧长那一项是本轮的核心取证 ——
    // 快照是单家 40%（wave40Snapshot），所以弧的 dasharray 必须是 40.xx。
    const formProbe = String(
      await exec(`(()=>{
        const dot=document.querySelector('.petball-fallback');
        if(!dot) return 'no-dot';
        const ring=dot.querySelector('.fluid-ring');
        const ringDisp=ring?getComputedStyle(ring).display:'?';
        const slosh=dot.querySelector('.slosh');
        const waterDisp=slosh?getComputedStyle(slosh).display:'(absent)';
        const arc=dot.querySelector('.ring-arc');
        const acs=arc?getComputedStyle(arc):null;
        const cs=arc?getComputedStyle(arc):null;
        const r=acs?acs.r:'?';
        // r 是 CSS 几何属性；Chromium 报 px
        const rNum=parseFloat(r);
        return JSON.stringify({
          ringDisplay:ringDisp, waterDisplay:waterDisp,
          arcR:r, arcSw:cs?cs.strokeWidth:'?', arcCap:cs?cs.strokeLinecap:'?',
          arcDash:arc?arc.getAttribute('stroke-dasharray'):'?',
          arcStroke:cs?cs.stroke:'?',
          ticksDisplay:dot.querySelector('.ring-ticks')?getComputedStyle(dot.querySelector('.ring-ticks')).display:'(absent)',
          segDisplay:dot.querySelector('.ring-seg')?getComputedStyle(dot.querySelector('.ring-seg')).display:'(absent)',
          innerDisplay:dot.querySelector('.ring-inner')?getComputedStyle(dot.querySelector('.ring-inner')).display:'(absent)',
          pathLength:arc?arc.getAttribute('pathLength'):'?',
          rNum
        });
      })()`)
    )
    process.stdout.write(`5c-form: ${id} ${formProbe}\n`)
  }
  await exec(`window.api.debugPush(${JSON.stringify(demoSnapshot())}, false)`)
  await sleep(900)
  // 倒水冲顶取帧（去雨后只剩冲顶峰 pour-top：呈现层冻结，不动状态机；
  // 此时候选供应商的切换计时照走，拍完 'off' 恢复。雨的 pour-mid 定帧随雨退役。）
  await exec(`window.__bd_fluid_freeze?.('pour-top')`)
  await sleep(600)
  await shoot('5m-pour-top')
  await exec(`window.__bd_fluid_freeze?.('off')`)

  // ③ 贴边自动隐藏走查（R4-5 原地变柱）：贴边停留 → 球 morph 成屏边水柱（窗口不动）→ 悬停唤出
  // ⚠ capturePage 拍的是窗口内容 —— 5g 证明"原地立柱渲染无损"（屏边 12px 温度计柱 + 柱内液位），
  //   命中区即柱体的证据在 uitest 的 bounds/column 断言（dockHide/petWaterColumn），不在 PNG 里。
  //   对着 5g 数像素说"只剩一条"就是 ballshot 教训的重演。解码验证见 check 报告。
  // 真光标冻结：走查机上鼠标若停在水柱上，2500ms 里足够唤回一次，截图就错过隐藏态
  await exec('window.api.debugDockFreeze(true)')
  await exec("window.api.debugDockEdge('left')")
  await sleep(2500) // 真实计时：1000ms 停留 + 300ms 隐藏动画
  await shoot('5g-dock-hidden')
  await exec('window.api.debugDockCursor(true)')
  await sleep(1500) // 真实计时：300ms 唤出停留 + 400ms morph 尾
  await shoot('5h-dock-revealed')
  // 流体三帧：拉伸中 / 桥接中 / 水渍 ——
  // __bd_fluid_freeze 把 goo 定在某一 morph 帧并暂停动画（呈现层冻结，不动状态机）。
  // capturePage 拍的是窗口内容：这三张证明 morph 帧的形状渲染无损。
  // 柱子与命中区同源的证据在 uitest 的 bounds 断言，不在 PNG 里。
  await exec(`window.__bd_fluid_freeze?.('stretch')`)
  await sleep(600)
  await shoot('5i-fluid-stretch')
  // 自描述探针（R3 整球吸入变形）：disc/bridge 定帧 transform 打到日志，
  // 拉丝与否看 matrix(sx)≠matrix(sy)，不靠像素猜（goo 开时颜色带漂移）。
  process.stdout.write(
    `5i-probe: ${String(
      await exec(`(()=>{
        const disc=document.querySelector('.fluid-disc');
        const br=document.querySelector('.fluid-bridge');
        return JSON.stringify({disc:disc?getComputedStyle(disc).transform:'?',
          bridge:br?getComputedStyle(br).transform:'?'});
      })()`)
    )}\n`
  )
  await exec(`window.__bd_fluid_freeze?.('bridge')`)
  await sleep(600)
  await shoot('5j-fluid-bridge')
  await exec(`window.__bd_fluid_freeze?.('stain')`)
  await sleep(600)
  await shoot('5k-fluid-stain')
  await exec(`window.__bd_fluid_freeze?.('off')`)
  // 温度计定量帧（10-04-edge-sip-column）：单供应商单窗口 70%（单家无轮播），
  // 贴边隐藏后柱高应为满管 70% —— AC 逐值对拍的实机点位。拍完恢复演示数据，
  // 后续 dock 走查沿用原夹具。
  await exec(`window.api.debugPush(${JSON.stringify(column70Snapshot())}, false)`)
  await sleep(900) // 等读数补间收尾（COUNTUP 600ms，见 uitest pushSettle）
  await exec('window.api.debugDockFreeze(true)')
  await exec("window.api.debugDockEdge('left')")
  await sleep(2500) // 真实计时：1000ms 停留 + 300ms 隐藏动画
  // 自描述探针：把渲染态打到日志（fixture 是否存活、柱高、波浪数），截图解码时不再猜供应商
  const columnProbe = String(
    await exec(`(()=>{
      const dot=document.querySelector('.petball-fallback');
      if(!dot) return 'no-dot';
      const fill=dot.querySelector('.fluid-column-fill');
      const fr=fill?fill.getBoundingClientRect():null;
      const fc=fill?getComputedStyle(fill):null;
      const pill=dot.querySelector('.fluid-pill');
      const pr=pill?pill.getBoundingClientRect():null;
      const pc=pill?getComputedStyle(pill):null;
      const goo=dot.querySelector('.petball-goo');
      const gc=goo?getComputedStyle(goo):null;
      const wv=dot.querySelector('.fluid-waves');
      return JSON.stringify({fluid:dot.dataset.fluid,edge:dot.dataset.edge,
        waves:dot.querySelectorAll('.fluid-wave').length,
        wavesOpacity:wv?getComputedStyle(wv).opacity:'?',
        fillH:fr?+fr.height.toFixed(1):-1,
        fillW:fr?+fr.width.toFixed(1):-1,
        fillBg:fc?.backgroundColor,fillOp:fc?.opacity,fillDisp:fc?.display,fillTf:fc?.transform,
        pillW:pr?+pr.width.toFixed(1):-1,pillH:pr?+pr.height.toFixed(1):-1,
        pillOp:pc?.opacity,pillTf:pc?.transform,
        gooFilter:gc?.filter?.slice(0,40),
        value:dot.querySelector('.dot-value')?.textContent ?? ''});
    })()`)
  )
  process.stdout.write(`5n-probe: ${columnProbe}\n`)
  await shoot('5n-column-70')
  await exec('window.api.debugDockCursor(true)')
  await sleep(1500)
  await exec('window.api.debugDockFreeze(false)')
  await exec(`window.api.debugPush(${JSON.stringify(demoSnapshot())}, false)`)
  await sleep(900)
  await exec('window.api.debugDockFreeze(false)')
  await exec('window.api.expand()')
  await sleep(700)

  // 右键菜单走查：原生菜单打开（Esc 关掉），期间不崩、渲染层仍存活。
  // 菜单本身是原生窗口，capturePage 抓不到它 —— 这张证明菜单弹出前后渲染层无损。
  await exec(`(()=>{
    const b=document.querySelector('.petball-hit'); if(!b) return
    const rc=b.getBoundingClientRect()
    b.dispatchEvent(new MouseEvent('contextmenu',{clientX:rc.x+rc.width/2,clientY:rc.y+rc.height/2,bubbles:true}))
  })()`)
  await sleep(900)
  await shoot('5e-ball-menu')
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
