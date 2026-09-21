// 设计走查 / UI 自动化测试 —— 从 src/main/index.ts 搬出来的 QA 工具。
//
// 这里的代码**不参与产品运行**：只有带 --shots / --uitest / --ballshot 等参数启动时才走到。
// 搬出来的原因见架构评审候选 C6：入口模块的接口是「启动应用」，而它此前 95% 是实现细节 ——
// 运行模式、截图走查、750 行 UI 断言全挤在一起，改启动流程时要在测试代码里翻。
// 纪律：新增断言请放在 uitest.ts，不要在 index.ts 里长回来。

// --shots：设计走查截图（主页 / 详情 / 设置 / 各皮肤 / 3D 悬浮球 / 断网缓存态）。
// 产物在 /tmp/balancedeck-shots/。
import { app } from 'electron'
import { join } from 'path'
import { demoSnapshot } from './fixtures'

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
  // ─── 收起态：3D 悬浮球（默认形态）／个性人物（可选形态）─────────────────────
  const openSettings = "[...document.querySelectorAll('.btn-secondary')].find(b=>b.textContent.includes('设置'))?.click()"
  const backBtn = "[...document.querySelectorAll('.icon-btn')].find(b=>b.title==='返回')?.click()"
  const collapseBtn = "[...document.querySelectorAll('.btn-secondary')].find(b=>b.textContent.includes('收起'))?.click()"
  /** 点「个性人物」开关（.pet-sec 里第 1 个开关；文案变了这里要跟着改） */
  const petToggle = "[...document.querySelectorAll('.pet-sec .switch')][0]?.click()"
  /** 驱动一次动作（长按撸一把已随养成体系下线，这里改成直接点名一个动作做观感走查） */
  const gesture = (id: string): string => `void window.__bd_gesture?.('${id}')`

  await exec(backBtn)
  await sleep(500)
  // 设置页「数字助理」分区特写（头像 / 一句话设定 / 三个开关 / 换一位）
  await exec(openSettings)
  await sleep(700)
  await exec("document.querySelector('.pet-sec')?.scrollIntoView({block:'center'})")
  await sleep(4500) // 等角色缩略图渲染完（软渲染器上要几秒）
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

  // ② 个性人物形态：出场走入 + 站定挥手 + 右键菜单
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
  // 鼓掌（原"撸一把"的反馈动作，现在是普通随机小动作）做一张动作走查。
  // 不能固定睡：这条剪辑是**按需加载**的（首次要解析几百毫秒），睡着了还在站桩。
  await exec(gesture('clap'))
  for (let i = 0; i < 15; i++) {
    const g = (await exec('window.__bd_ball?.()?.gesture ?? null')) as { cur: string | null } | null
    if (g?.cur === 'clap') break
    await sleep(250)
  }
  await sleep(700) // 进到动作中段再拍（起手几帧还在垂手）
  await shoot('5d-pet-happy')
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

  // 逐位角色各拍一张（3D 素材观感）
  const species = ['aria', 'ray']
  for (let i = 0; i < species.length; i++) {
    await exec('window.api.expand()')
    await sleep(700)
    await exec(openSettings)
    await sleep(700)
    await exec(`document.querySelectorAll('.pet-chip')[${[0, 1][i]}]?.click()`)
    await sleep(500)
    await exec(backBtn)
    await sleep(400)
    await exec(collapseBtn)
    // ⚠ 必须等到 petReady：收起会重建场景，未缓存过的角色要解析 5 个 FBX
    //   （软渲染器上远超固定等待），拍早了就是一张只有脚下阴影的空画布。
    let ready = false
    for (let w = 0; w < 25; w++) {
      if ((await exec('window.__bd_ball?.()?.petReady === true')) === true) {
        ready = true
        break
      }
      await sleep(400)
    }
    if (!ready) console.log(`[shots] ${species[i]} 未就位（拍到的可能是空画布）`)
    await sleep(900) // 模型就位后再等一拍，让 idle 剪辑进入循环
    await shoot(`5f-pet-${species[i]}`)
  }

  // 还原：关掉个性人物（默认球形态），回到卡片视图
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
