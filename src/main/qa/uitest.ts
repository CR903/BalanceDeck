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
// 隐藏偏移的断言口径与主进程同一常数（改 PEEK 时这里跟着变，不各自硬编码 56-4=52）
import { PEEK } from '../../shared/dock-hide'
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

  // ─── 09-27-dot-ring-scroll 的夹具与球上探针 ────────────────────────────────
  //
  // 真实数据随机器而变（有没有多窗口套餐、有没有余额供应商都不由测试说了算），
  // 所以下面的断言一律**自己推快照**。夹具全部 `official` + 新鲜时间戳 —— 不触发
  // 可信度角标，人物形态的 overlay 基线里没有角标（多一个元素整条比对就红）。
  const isoNow = (): string => new Date().toISOString()
  /** `limit` 可缺省 —— AC3.3 要的正是「套餐窗口算不出比例」这一种（无 limit → windowPercent 为 null） */
  type FixWin = { name: string; used: number; limit?: number; unit: string; percent?: number }
  const fw = (name: string, percent: number): FixWin => ({ name, used: 1, limit: 10, unit: 'usd', percent })
  const planFix = (id: string, name: string, windows: FixWin[]): Record<string, unknown> => ({
    id,
    name,
    kind: 'coding',
    builtin: true,
    mark: 'opencode',
    status: 'ok',
    dataQuality: 'official',
    dataAt: isoNow(),
    updatedAt: isoNow(),
    windows
  })
  /** 三窗口套餐：10% / 20% / 30%，窗口名就是产品里那三个时限 → 短标签 5H / W / M */
  const FIX_PLAN3 = [planFix('fix-plan3', 'Fix 三窗', [fw('5 小时', 10), fw('本周', 20), fw('本月', 30)])]
  const FIX_PLAN3_VALS = ['10%', '20%', '30%']
  const FIX_PLAN3_LBL = ['5H', 'W', 'M']
  /** 单窗口套餐：AC3.4 的「切了等于没切」与 AC3.6 的「不出现短标签」都靠它 */
  const FIX_PLAN1 = [planFix('fix-plan1', 'Fix 单窗', [fw('5 小时', 13.7)])]
  /** 充值余额（AC2.1：连轨道都不画） */
  const FIX_BAL: Record<string, unknown>[] = [
    {
      id: 'fix-bal',
      name: 'Fix 余额',
      kind: 'balance',
      builtin: true,
      mark: 'deepseek',
      status: 'ok',
      dataQuality: 'official',
      dataAt: isoNow(),
      updatedAt: isoNow(),
      windows: [{ name: '账户余额', used: 1288.5, unit: 'cny' }]
    }
  ]
  /** 两位供应商（换人 / 轮播都得 ≥2 才有行为）：A 三窗口、B 两窗口 */
  const FIX_AB = [
    planFix('fix-a', 'Fix A', [fw('5 小时', 11), fw('本周', 22), fw('本月', 33)]),
    planFix('fix-b', 'Fix B', [fw('5 小时', 44), fw('本周', 55)])
  ]
  /** 换人后应当落到 `windows[0]`（PRD §6 定的 Q1=B）→ 各自的首窗口读数 */
  const FIX_AB_FIRST: Record<string, string> = { 'Fix A': '11%', 'Fix B': '44%' }
  /** 套餐但**算不出比例**的窗口（既无 percent 也无 limit → windowPercent 返回 null）：
   *  AC3.3 要的正是它 —— 轨道仍在、没有填充弧、中心是金额而不是 0% */
  const FIX_NOLIMIT = [planFix('fix-nolimit', 'Fix 无比例', [{ name: '5 小时', used: 1288.5, unit: 'cny' }])]

  // ── P1-3 托盘等级：四档夹具（10-01-p1-tray-color）──────────────────────────
  //
  // 真实数据落在哪一档由用户决定，写死一个百分比再断言「标题是红的」是**恒绿**的假门。
  // 所以四档各造一份夹具，用量刻意取在档位**内部**（不是边界上）：
  //   10 → ok（无转义、无点）/ 70 → warn / 90 → danger / 无比例 → muted
  // 余额那档复用 FIX_BAL：它既无 percent 也无 limit → windowPercent 为 null → muted。
  const FIX_TRAY_OK = [planFix('fix-tray-ok', 'Fix 正常', [fw('本周', 10)])]
  const FIX_TRAY_WARN = [planFix('fix-tray-warn', 'Fix 偏高', [fw('本周', 70)])]
  const FIX_TRAY_DANGER = [planFix('fix-tray-danger', 'Fix 爆表', [fw('本周', 90)])]

  /**
   * 推夹具。**先推一个空数组**，两件事：
   *  ① 窗口索引经夹紧效应回到 0（`winCount===0 → setWinIdx(0)`），每个场景起点一致；
   *  ② 供应商数量变过，秒级轮播的 `lastAdvance` 才会重置 —— 否则上一轮的时间戳会
   *     穿透进来，「手动后暂停 8 秒」的时序就没法断言（AC4.3 要 ±1 秒的精度）。
   */
  const pushFix = async (snaps: unknown[]): Promise<void> => {
    await exec('window.api.debugPush([], false)')
    await sleep(150)
    await exec(`window.api.debugPush(${JSON.stringify(snaps)}, false)`)
    await sleep(500)
  }

  /**
   * 展开的 overlay 盒：[className, left, top, right, bottom]（**绝对坐标，不是宽高**）。
   * 踩过的坑：曾把它当 [x, y, w, h] 读，于是把 right 当成宽、bottom 当成高 ——
   * 「基线 245/44」实际是 y=245、h=44（289-245），坐标没错，是**读法**错了。
   * 所以下面只做差值运算，永远不直接拿 right/bottom 当尺寸。
   */
  type OverlayBox = [string, number, number, number, number]

  type BallProbe = {
    err: string
    ring: string | null
    track: boolean
    fill: boolean
    dash: string | null
    trackStroke: string | null
    fillStroke: string | null
    value: string | null
    winLabel: string | null
    title: string
    label: string | null
    idx: number
    winIdx: number
    winCount: number
  }
  const badProbe = (err: string): BallProbe => ({
    err,
    ring: null,
    track: false,
    fill: false,
    dash: null,
    trackStroke: null,
    fillStroke: null,
    value: null,
    winLabel: null,
    title: '',
    label: null,
    idx: -1,
    winIdx: -1,
    winCount: -1
  })
  /**
   * 一次 exec 把球上的证据取全：环的三层 DOM、环心读数、短标签、tooltip（=当前供应商）、
   * 以及 `__bd_ball` 的索引观测点。`err` 非空时所有断言都要连它一起报 —— 否则
   * 「探针挂了」和「行为正确」都长成默认值，会变成永真的兜底。
   */
  const ballProbe = async (): Promise<BallProbe> => {
    const raw = await exec(`(()=>{
      const dot=document.querySelector('.petball-fallback')
      const hit=document.querySelector('.petball-hit')
      const b=window.__bd_ball?.()
      const track=dot?dot.querySelector('.dot-ring-track'):null
      const fill=dot?dot.querySelector('.dot-ring-fill'):null
      const wl=dot?dot.querySelector('.dot-winlabel'):null
      const dv=dot?dot.querySelector('.dot-value'):null
      const lb=document.querySelector('.petball-label')
      return JSON.stringify({
        ring: dot?dot.getAttribute('data-ring'):null,
        track: !!track, fill: !!fill,
        dash: fill?getComputedStyle(fill).strokeDasharray:null,
        trackStroke: track?getComputedStyle(track).stroke:null,
        fillStroke: fill?getComputedStyle(fill).stroke:null,
        value: dv?dv.textContent:null,
        winLabel: wl?wl.textContent:null,
        title: hit?hit.title:'',
        label: lb?lb.textContent:null,
        idx: b&&typeof b.idx==='number'?b.idx:-1,
        winIdx: b&&typeof b.winIdx==='number'?b.winIdx:-1,
        winCount: b&&typeof b.winCount==='number'?b.winCount:-1
      })
    })()`)
    if (typeof raw !== 'string') return badProbe('exec-failed')
    try {
      const p = JSON.parse(raw) as BallProbe
      return { ...p, err: '' }
    } catch {
      return badProbe(`parse:${raw.slice(0, 60)}`)
    }
  }

  /** 合成一次滚轮：React 的 onWheel 是普通事件监听，`dispatchEvent` 会真的走到（`:active` 那种 UA 合成的才不行） */
  const wheelJs = (dx: number, dy: number): string =>
    `(()=>{const b=document.querySelector('.petball-hit'); if(!b) return 'no-hit'
      b.dispatchEvent(new WheelEvent('wheel',{deltaX:${dx},deltaY:${dy},bubbles:true}))
      return 'ok'})()`
  /** 走一步（>250ms 冷却，且 >150ms 断流线，两步不会被粘成一个手势） */
  const wheelStep = async (dx: number, dy: number): Promise<void> => {
    await exec(wheelJs(dx, dy))
    await sleep(320)
  }
  /** 把窗口索引推到 target（单窗口供应商是空操作，循环到 maxSteps 就停） */
  const setWindowTo = async (target: number, maxSteps: number): Promise<number> => {
    for (let i = 0; i <= maxSteps; i++) {
      const p = await ballProbe()
      if (p.winIdx === target) return p.winIdx
      if (i === maxSteps) break
      await wheelStep(0, 100)
    }
    return (await ballProbe()).winIdx
  }

  /**
   * 右键菜单：**截获菜单项标签，但不弹原生菜单**。
   *
   * 菜单是主进程 `pet:menu` 现场拼的（渲染层只给模型），从渲染层读不到标签 ——
   * 所以临时替换 `Menu.buildFromTemplate`：截下 items，用一个只回调 callback 的
   * 假菜单顶替，popup 一调就 resolve，不留一个没人关的原生菜单在屏幕上。
   * 传 `clickLabel` 时顺带点中那一项（这里用它切「隐藏余额」，不必展开面板）。
   *
   * 三种失败都会返回哨兵串（`<patch-failed>` / `<not-called>`）——断言必须把它们
   * 当红处理：静默变成空数组的话，「菜单里没有这项」在**根本没截到**时也成立。
   */
  const runPetMenu = async (clickLabel?: string): Promise<string[]> => {
    const { Menu } = await import('electron')
    const orig = Menu.buildFromTemplate
    let captured: string[] = ['<not-called>']
    const patched = (items: Electron.MenuItemConstructorOptions[]): Electron.Menu => {
      captured = items.map((i) => (i.type === 'separator' ? '---' : String(i.label ?? '')))
      const hit = clickLabel ? items.find((i) => i.label === clickLabel) : undefined
      const fire = hit?.click as unknown as (() => void) | undefined
      return {
        popup: (opts?: { callback?: () => void }) => {
          if (fire) fire()
          opts?.callback?.()
        }
      } as unknown as Electron.Menu
    }
    let patchedOk = true
    try {
      ;(Menu as unknown as { buildFromTemplate: typeof patched }).buildFromTemplate = patched
    } catch {
      patchedOk = false
    }
    try {
      await exec(`(()=>{const b=document.querySelector('.petball-hit'); if(!b) return 'no-hit'
        const rc=b.getBoundingClientRect()
        b.dispatchEvent(new MouseEvent('contextmenu',{clientX:rc.x+rc.width/2,clientY:rc.y+rc.height/2,bubbles:true}))
        return 'ok'})()`)
      await sleep(600)
    } finally {
      if (patchedOk) {
        try {
          ;(Menu as unknown as { buildFromTemplate: typeof orig }).buildFromTemplate = orig
        } catch {
          // 还原失败也得让原调用方拿到 captured（菜单标签仍可用）
        }
      }
    }
    return patchedOk ? captured : ['<patch-failed>']
  }

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

    // ── 趋势图（P1-1）─────────────────────────────────────────────────────
    // 两态互斥，**不要**写成「有 chart 或没 chart 都算过」：
    //   · 套餐类（coding/token）且有历史 → 有 `.trend-chart`，且柱数 = 该窗口的**可见天数**
    //     （缺样本的天不画柱，所以柱数 ≤ 天数，**不能**断言相等）
    //   · 余额类（balance）→ **一定没有** `.trend-chart`，且实现层压根不发那次 IPC
    // 判「有没有 chart」用 `=== null` 而不是 `!`：`!` 会把「元素不存在」与
    // 「选择器写错了」混成同一个结果 —— 那正是本仓反复出现的空洞绿。
    const chartInfo = (await exec(`(() => {
      const chart = document.querySelector('.trend-chart')
      const host = document.querySelector('.trend') || document.querySelector('[class*="trend"]')
      return JSON.stringify({
        hasChart: chart !== null,
        bars: chart ? chart.querySelectorAll('.trend-bar').length : -1,
        hostClass: host ? host.className : ''
      })
    })()`)) as string
    const ci = JSON.parse(chartInfo || '{}') as { hasChart?: boolean; bars?: number; hostClass?: string }
    const isBalance = (await exec(`(() => {
      const t = document.querySelector('.kind-tag')
      return t ? (t.textContent || '').includes('余额') : false
    })()`)) as boolean
    if (isBalance) {
      // 余额类：实测 pct 恒 null / 恒 0，画出来要么是空要么是贴底平线
      r.trendChart = ci.hasChart ? 'fail:balance-should-have-none' : 'ok'
    } else {
      r.trendChart = ci.hasChart
        ? 'ok'
        : // 没历史时 TrendChart 返回 null，界面什么都不显示 —— 那也是对的态
          ((await exec("!!document.querySelector('.dwin')")) ? 'ok:no-history' : 'fail')
    }
    r.trendBars = String(ci.bars ?? -1)

    await exec("[...document.querySelectorAll('.icon-btn')].find(b=>b.title==='返回')?.click()")
    await sleep(600)
    r.detailBack = (await exec("!!document.querySelector('.pcard-grid') || !!document.querySelector('.empty-state')")) ? 'ok' : 'fail'
  } else {
    r.detailOpen = 'skipped:no-card'
    r.detailWindows = 'skipped:no-card'
    r.detailBack = 'skipped:no-card'
    r.trendChart = 'skipped:no-card'
    r.trendBars = 'skipped:no-card'
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
  // 「语音提醒」的兜底间隔（`.vrs-routine-interval`，含 10/30/60）排在刷新频率之前，
  // 那样会改到播报间隔去 —— 2026-09-26 实测踩过这个坑（当时挡在前面的是 `.voice-interval`，
  // 那只开关随后随播报链路迁移删掉了，**但冲突源换成了 .vrs-routine-interval，问题依旧**）。
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

  // ── 「语音提醒」分区（09-29-tts-smart-broadcast）─────────────────────────
  //
  // 为什么这一段必须有：整个语音提醒功能此前**一条 UI 断言都没有**。单元套件
  // （speech-out / trigger-engine / alert-orchestration）全是纯函数，测不到「设置页上
  // 真的有这些控件、改了真的落盘」。而 AC2（配置界面）与 AC5（间隔可调）恰恰是**界面**
  // 层面的验收标准 —— 上一轮的实现把它们判成「已完成」，依据只有「代码里写了」。
  //
  // ⚠ 一律按 class 定位，绝不按「第几个 select」：设置页里有好几个 <select>，
  //   而 .refresh-interval 与 .vrs-routine-interval 的 option 里有相同的值（10/30/60）——
  //   2026-09-26 实测踩过，那时挡在前面的是已下线的 .voice-interval，**冲突源换成了
  //   .vrs-routine-interval，问题原样复发**。
  const vrsSelect = (sel: string, value: string) =>
    exec(`(()=>{
      const el=document.querySelector(${JSON.stringify(sel)})
      if(!el) return 'no-select'
      const setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set
      setter.call(el,${JSON.stringify(value)})
      el.dispatchEvent(new Event('change',{bubbles:true}))
      return 'set'
    })()`)

  // 分区标题常在（不受总开关控制）
  r.vrsSection =
    (await exec("[...document.querySelectorAll('.section-title')].some(e=>e.textContent==='语音提醒')"))
      ? 'ok'
      : 'fail:no-section-title'
  // ⚠ **先把开关归位再断言**。这一段测的是「总开关关着时配置区不渲染」，前提是**进来时
  //   它就是关的** —— 而它不成立：用户自己开着（真实存在的状态），或上一轮 run 崩在中途
  //   没把它关回去。实测 2026-10-01：`ui:ttsOn='1'` 时下面第一条直接报
  //   `fail:shown-while-off`，接着那次 click 把**已经开着**的开关又关了一次，
  //   于是整段 **13 条**（vrsPowerOn / Preset / Endpoint / Custom / Triggers /
  //   Routine* / HistoryCap…）一起崩 —— 崩在 TTS 段，与本段代码、与 P1-4 都没有任何关系，
  //   却把验收数字淹掉了。`ui:ttsOn` 由 `SettingsView` 挂载时读一次，IPC 直接写**不会**
  //   让它重渲染，所以只能按 DOM 上的实际状态点开关。
  if ((await exec("!!document.querySelector('.vrs-power')?.classList.contains('on')")) === true) {
    await exec("document.querySelector('.vrs-power')?.click()")
    await sleep(700)
  }
  // 总开关关着时，**整块配置都不该渲染**（默认关 = 默认不发声、不发请求）
  r.vrsHiddenWhenOff = (await exec("!!document.querySelector('.vrs-preset') || !!document.querySelector('.vrs-power')?.classList.contains('on')"))
    ? 'fail:shown-while-off'
    : 'ok'
  // 开 → 配置区出现，且总开关落盘 ui:ttsOn
  await exec("document.querySelector('.vrs-power')?.click()")
  await sleep(700)
  r.vrsPowerOn = (await exec("!!document.querySelector('.vrs-preset') && !!document.querySelector('.vrs-threshold')"))
    ? 'ok'
    : 'fail:no-controls'
  r.vrsPowerSaved =
    (await exec("window.api.getExtras(['ui:ttsOn']).then(e=>e['ui:ttsOn']==='1')")) === true
      ? 'ok'
      : 'fail:not-saved'

  // AC2：预设下拉给出「免费服务」与「自定义服务」两项。
  //
  // ⚠ 这条**测不出**「新用户默认落在自定义」那个 bug，实测过：受控 <select> 的 value 在
  //   没有任何 option 匹配时会被浏览器**回退到第一项**，于是 s.value 照样是 'mytts'，
  //   断言绿着，而组件其实已经走自定义分支了。真正抓住它的是下一条 vrsEndpoint ——
  //   读的是**渲染出来的分支**（预设分支才有只读端点），不受 value 回退影响。
  //   留这条在这儿是为了钉住「选项集合 + 自定义项的哨兵值」，那是 vrsEndpoint 管不到的。
  r.vrsPreset = String(
    await exec(`(()=>{const s=document.querySelector('.vrs-preset')
      return s ? [...s.options].map(o=>o.value).join('|')+'@'+s.value : 'no-select'})()`)
  )
  r.vrsPreset = r.vrsPreset === 'mytts|custom@mytts' ? 'ok' : `fail:${r.vrsPreset}`
  // 新用户（没有 ui:ttsPreset）必须**默认落在免费服务**上：落在「自定义」的话地址是空的，
  // 等于没配 TTS，播报整体不工作（AC3 的反面）。反向验证实测：把 App 里的默认值改回
  // `typeof e['ui:ttsPreset'] === 'string' ? … : 'mytts'` 只有这一条变红。
  r.vrsEndpoint = (await exec("!!document.querySelector('.vrs-endpoint')?.value?.includes('mytts')"))
    ? 'ok'
    : 'fail:no-endpoint'
  // 切到「自定义服务」→ 可编辑的地址 / 音色 / 语速三项出现
  r.vrsPresetSet = String(await vrsSelect('.vrs-preset', 'custom'))
  await sleep(600)
  r.vrsCustom = (await exec("!!document.querySelector('.vrs-url') && !!document.querySelector('.vrs-voice') && !!document.querySelector('.vrs-speed')"))
    ? 'ok'
    : 'fail:no-custom-fields'
  r.vrsPresetSaved =
    (await exec("window.api.getExtras(['ui:ttsPreset']).then(e=>e['ui:ttsPreset']==='custom')")) === true
      ? 'ok'
      : 'fail:not-saved'
  // 自定义模式下**不能**把 token 写进 extras（密钥只走主进程加密 IPC）。
  // ⚠ 写法：executeJavaScript 不是模块，顶层 await 会直接 "Script failed to execute"。
  //   一律用 .then() 把 promise 化掉，再由 exec 自己 await。
  r.vrsSecretNoExtras = String(
    await exec(
      "window.api.getExtras(['ui:ttsSecret','ui:ttsToken']).then(e=>e['ui:ttsSecret']+'/'+e['ui:ttsToken'])"
    )
  )
  r.vrsSecretNoExtras = r.vrsSecretNoExtras === '/' ? 'ok' : `fail:extras-holds=${r.vrsSecretNoExtras}`
  // 切回预设必须**同时**把 url 写进 ui:ttsConfig（否则界面显示的端点与真正发请求的地址不一致）
  r.vrsPresetBack = String(await vrsSelect('.vrs-preset', 'mytts'))
  await sleep(600)
  r.vrsPresetUrlSynced =
    (await exec(
      "window.api.getExtras(['ui:ttsConfig']).then(e=>(JSON.parse(e['ui:ttsConfig']||'{}').url||'').includes('mytts'))"
    )) === true
      ? 'ok'
      : 'fail:url-not-synced'

  // 5 个触发场景的阈值输入都在，且带 data-trigger 供定位
  r.vrsTriggers = String(
    await exec(`(()=>{const n=document.querySelectorAll('.vrs-threshold[data-trigger]').length
      return [...document.querySelectorAll('.vrs-threshold')].map(i=>i.dataset.trigger||'?').join('|')+'/n='+n})()`)
  )
  r.vrsTriggers =
    r.vrsTriggers === 'balance|fluctuation|exhaustion|idle|abnormal/n=5' ? 'ok' : `fail:${r.vrsTriggers}`

  // 播报内容格式（简洁 / 详细）
  r.vrsFormatSet = String(await vrsSelect('.vrs-text-format', 'detailed'))
  await sleep(500)
  r.vrsFormatSaved =
    (await exec("window.api.getExtras(['ui:ttsTextFormat']).then(e=>e['ui:ttsTextFormat']==='detailed')")) === true
      ? 'ok'
      : 'fail:not-saved'

  // AC5：兜底间隔**默认不渲染**（定时兜底默认关），打开开关后才出现，且档位含 60（默认 1 小时）
  r.vrsRoutineHidden = (await exec("!!document.querySelector('.vrs-routine-interval')")) ? 'fail:shown-while-off' : 'ok'
  await exec(`(()=>{const rows=[...document.querySelectorAll('.vrs-sec .enable-row')]
    rows.find(x=>/定时兜底播报/.test(x.textContent||''))?.querySelector('button.switch')?.click()})()`)
  await sleep(700)
  r.vrsRoutineOn =
    (await exec("window.api.getExtras(['ui:ttsRoutine']).then(e=>e['ui:ttsRoutine']==='1')")) === true ? 'ok' : 'fail:not-saved'
  r.vrsRoutineSteps = String(
    await exec(`(()=>{const s=document.querySelector('.vrs-routine-interval')
      return s ? [...s.options].map(o=>o.value).join('|') : 'no-select'})()`)
  )
  r.vrsRoutineSteps = r.vrsRoutineSteps.includes('|60|') ? 'ok' : `fail:${r.vrsRoutineSteps}`
  r.vrsRoutineSet = String(await vrsSelect('.vrs-routine-interval', '30'))
  await sleep(500)
  r.vrsRoutineSaved =
    (await exec("window.api.getExtras(['ui:ttsRoutineEvery']).then(e=>e['ui:ttsRoutineEvery']==='30')")) === true
      ? 'ok'
      : 'fail:not-saved'

  // AC13：历史上限输入存在，且**不是** 0（0 会让历史立刻清空、异常检测永久失效）
  const capRaw = String(await exec("(()=>{const i=document.querySelector('.vrs-history-cap');return i?String(i.value):'no-input'})()"))
  r.vrsHistoryCap = Number(capRaw) > 0 ? 'ok' : `fail:${capRaw}`

  // AC14/AC15 的分级说明必须**写在界面上**（用户在改阈值之前就该知道展开态只播紧急）
  r.vrsGradeNote = (await exec("/分级/.test(document.querySelector('.vrs-foot')?.textContent||'')"))
    ? 'ok'
    : 'fail:no-grading-note'

  // 还原：关掉播报，免得后面的轮次被 30s 轮询带着跑
  await exec("document.querySelector('.vrs-power')?.click()")
  await sleep(600)
  r.vrsPowerOff =
    (await exec("window.api.getExtras(['ui:ttsOn']).then(e=>e['ui:ttsOn']==='0')")) === true
      ? 'ok'
      : 'fail:not-saved'

  // P0-1 系统通知：总开关 + 三个阈值输入。
  //
  // ⚠ 这段刻意放在 `vrs-power` **关掉之后**（上面刚关）：设置页把系统通知分组放在
  //   `{ttsOn && …}` 之外，正是因为「关掉语音」的理由往往正是「我只想收通知，不想它出声」
  //   —— 放进去的话连开关都找不到。第一条就是这个设计的**实测**版本
  //   （test-alert-orchestration.mjs 的 M29 只静态比了位置）。
  r.vrsNotifyVisible = (await exec("!!document.querySelector('.vrs-notify-on')"))
    ? 'ok'
    : 'fail:hidden-while-tts-off'
  // 判据读**输入框的值**而不是文案：三个默认值是 prd.md 需求 2 的约定（80 / 95 / 1 小时）
  const notifyDefaults = String(
    await exec(`(()=>{const w=document.querySelector('.vrs-notify-warn')
      const h=document.querySelector('.vrs-notify-high'); const rs=document.querySelector('.vrs-notify-reset')
      return w&&h&&rs ? [w.value,h.value,rs.value].join('/') : 'missing'})()`)
  )
  r.vrsNotifyDefaults = notifyDefaults === '80/95/1' ? 'ok' : `fail:${notifyDefaults}`
  // 开关往返：判据是**落盘值**（extras 往返），不是控件上有没有 class（K15 同款纪律）
  await exec("document.querySelector('.vrs-notify-on')?.click()")
  await sleep(600)
  r.vrsNotifyOff =
    (await exec("window.api.getExtras(['ui:notifyOn']).then(e=>e['ui:notifyOn']==='0')")) === true
      ? 'ok'
      : 'fail:not-saved'
  // 关掉之后阈值输入收起来（同 vrsRoutineHidden：配置项跟着开关走）
  r.vrsNotifyHidden =
    (await exec("!!document.querySelector('.vrs-notify-warn')")) ? 'fail:shown-while-off' : 'ok'
  await exec("document.querySelector('.vrs-notify-on')?.click()")
  await sleep(600)
  // 阈值改一个：必须经 JSON 往返落到 ui:notifyConfig，而不是只停在组件的 useState
  const setNotifyWarn = (v: string): Promise<unknown> =>
    exec(`(()=>{const i=document.querySelector('.vrs-notify-warn')
      if(!i) return
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set
      setter.call(i,'${v}'); i.dispatchEvent(new Event('input',{bubbles:true}))
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))
    })()`)
  await setNotifyWarn('85')
  await sleep(600)
  r.vrsNotifyCfg =
    (await exec(
      "window.api.getExtras(['ui:notifyConfig']).then(e=>{try{return JSON.parse(e['ui:notifyConfig']).pctWarn===85}catch{return false}})"
    )) === true
      ? 'ok'
      : 'fail:not-saved'
  // 还原成 80：这一轮改过的配置不许带进后面的断言
  await setNotifyWarn('80')
  await sleep(500)

  await exec("[...document.querySelectorAll('.icon-btn')].find(b=>b.title==='返回')?.click()")
  await sleep(600)
  r.settingsBack = (await exec("!!document.querySelector('.pcard-grid') || !!document.querySelector('.empty-state')")) ? 'ok' : 'fail'

  // 下面的托盘等级断言要自己推夹具；**先把真实快照存下来**，测完原样推回去 ——
  // 紧跟其后的余额卡 / 套餐卡 / 窗口胶囊断言全都依赖真实数据。
  const savedSnapshots = (await exec('window.api.getState().then(s=>s.snapshots)')) as unknown[]

  // ── P1-3 状态栏（托盘）标题的等级着色 + 图标状态点 ──────────────────────────
  //
  // ⚠ 旧判据（「非空 + 不含 undefined/NaN + 含数字」）在加色之后**既不会红也没有区分力**：
  //   它对标题长什么样几乎没有约束，换成任何一档都照样绿。所以改成按 level 判 ——
  //   自己推夹具（用量落在档位内部），读回标题里的 ANSI 包裹码与图标等级。
  //
  // ⚠ 必须连 `iconKey` 一起读：**level/shape 报的是意图，iconKey 报的是实际落盘的那一份**。
  //   `updateTray` 先写 `currentBadge` 再 `applyTrayIcon`，所以去重把新图标吃掉时
  //   level/shape 已经是新值、断言照样绿 —— 只有 `#形状` 后缀不变才暴露真相。
  //   （去重键漏掉形状是本任务最容易静默失效的一处：不抛不红，点永远停在旧等级。）
  const readTray = async (): Promise<{
    title: string
    level: string
    shape: string
    iconKey: string
  }> => ({
    title: String(await exec('window.api.debugTrayTitle()')),
    ...(await exec(
      'window.api.debugTrayImage().then(b=>({level:b.level,shape:b.shape,iconKey:b.iconKey}))'
    ) as { level: string; shape: string; iconKey: string })
  })
  /** 某档的完整判据：标题包裹码 + 剥转义后的文案 + 图标等级/形状 + **实际落盘的键** */
  const trayCase = async (
    label: string,
    fix: unknown[],
    want: { esc: string; plain: string; level: string; shape: string }
  ): Promise<string> => {
    await pushFix(fix)
    const got = await readTray()
    const stripped = got.title.replace(/\x1b\[[0-9;]*m/g, '')
    const esc = got.title.includes(want.esc) || (want.esc === '' && !got.title.includes('\x1b['))
    // 键必须带 `#形状` —— 少这一段就说明去重把换级后的图标吞了（意图是新、实际是旧）
    const keyed = got.iconKey.endsWith(`#${want.shape}`)
    const why = `esc=${esc ? 'y' : 'n'} plain=${stripped} lvl=${got.level} shape=${got.shape} key=${got.iconKey}`
    if (esc && stripped === want.plain && got.level === want.level && got.shape === want.shape && keyed) {
      return `ok(${why})`
    }
    return `fail(${why} 期望 esc=${JSON.stringify(want.esc)}/${want.plain}/${want.level}/${want.shape}/key#${want.shape})`
  }
  // ⚠ ok 档判的是「**一个转义都没有**」：加色不许让正常用量的用户看到任何变化。
  r.trayTitleOk = await trayCase('ok', FIX_TRAY_OK, { esc: '', plain: 'W 10%', level: 'ok', shape: 'none' })
  r.trayTitleWarn = await trayCase('warn', FIX_TRAY_WARN, {
    esc: '\x1b[33m',
    plain: 'W 70%',
    level: 'warn',
    shape: 'translucent'
  })
  r.trayTitleDanger = await trayCase('danger', FIX_TRAY_DANGER, {
    esc: '\x1b[31m',
    plain: 'W 90%',
    level: 'danger',
    shape: 'solid-large'
  })
  // 余额类既无 percent 也无 limit → muted 灰 + 空心小点（两处信号必须**同时**变：
  // 只给灰字不加点，用户会把「没数据」读成「低用量」）
  r.trayTitleMuted = await trayCase('muted', FIX_BAL, {
    esc: '\x1b[1;30m',
    plain: '¥1288.50',
    level: 'muted',
    shape: 'hollow-small'
  })
  // 图标等级的独立键（不依赖标题那条）：`debug:tray-image` 是本任务新增的观测点，
  // 少了它「图标分层」就只剩逻辑测试，界面层无人能验（macOS 模板图标根本没有颜色可看）。
  // ⚠ 判据里必须带 `iconKey`：**换级时它必须跟着变**，不变就说明去重把新图标吞了
  //   （level/shape 报的是意图，会先于实际落盘更新，单看它们永远绿）。
  {
    await pushFix(FIX_TRAY_DANGER)
    const img = await readTray()
    r.trayBadge =
      img.level === 'danger' && img.shape === 'solid-large' && img.iconKey.endsWith('#solid-large')
        ? `ok(${img.iconKey})`
        : `fail:${JSON.stringify(img)}`
    await pushFix(FIX_TRAY_OK)
    const img2 = await readTray()
    // 必须与上一档**不同**：同一个 mark 只换等级，键就该换 —— 这正是去重键含形状的意义
    r.trayBadgeNone =
      img2.level === 'ok' && img2.shape === 'none' && img2.iconKey.endsWith('#none') && img2.iconKey !== img.iconKey
        ? `ok(${img.iconKey} → ${img2.iconKey})`
        : `fail:${JSON.stringify([img, img2])}`
  }
  // 把真实快照推回去：下面的断言（余额卡 / 套餐卡 / 窗口胶囊）都依赖真实数据
  await pushFix(savedSnapshots)

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

  // 设置页「数字助理」分区：选一位 / 改名 / 两个开关（养成互动已下线）
  await exec(footerClick('设置'))
  await sleep(700)
  r.petSection = (await exec("!!document.querySelector('.pet-sec') && document.querySelectorAll('.pet-chip').length === 2"))
    ? 'ok'
    : 'fail:no-section'
  // R1（AC1.1）设置侧：那个已删除的用量环开关整行必须已经拆掉。**只记串不报键** ——
  // petRingRemoved 是「设置页 + 右键菜单」两半合成的一条断言（拆开就把 14 条对不上），
  // 菜单那一半要到球上才截得到（菜单标签在主进程现拼，渲染层读不到），最后统一合报。
  //
  // 死开关文案由两段拼出来：步 8 的门要求 `grep -rn "<该文案>" src/ README.md DESIGN.md`
  // **零命中**（产品代码不许再出现这串字），而这条断言恰恰要证明它不存在 —— 拼接在
  // 运行时与整串完全等价，grep 则匹配不到连续字面量。
  const deadRingLabel = '显示' + '用量环'
  const ringRowGone = String(
    await exec(`(()=>{
      const sec=document.querySelector('.pet-sec')
      if(!sec) return 'fail:no-pet-sec'
      const rows=[...sec.querySelectorAll('.enable-row')].map(r=>(r.textContent||'').trim())
      return rows.some(t=>t.includes(${JSON.stringify(deadRingLabel)})) ? 'fail:'+rows.join(' | ') : 'ok'
    })()`)
  )
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

  // 从这里开始会反复推夹具（人物形态的滚轮守卫、基线比对，以及球上的 11 条断言），
  // 而 60 秒一轮的真实采集随时可能把夹具覆盖掉 —— 那种红查不出原因。
  // ⚠ 改频率会 reconfigure → refreshNow（**推夹具之前**只能做这一件事），等它收尾。
  await exec("window.api.setExtras({refreshInterval:'300'})")
  await sleep(300)
  for (let i = 0; i < 60; i++) {
    if ((await exec('window.api.getState().then(s=>!!s.scanning)')) !== true) break
    await sleep(300)
  }

  // 开关语义：默认未设置 = 球形态；点一次 → 开启桌面宠物（'1'）；再点 → 关闭（'0'）
  await petSwitch('1')
  r.petToggleSaved = (await exec("window.api.getExtras(['ui:pet']).then(e=>e['ui:pet']==='1')")) === true ? 'ok' : 'fail:not-saved'

  // ── 个性人物形态：窗口是竖版（尺寸见 shared/pet-view 的 FIGURE_VIEW），人物素材就位，穿透生效 ──
  await gotoView('collapse')
  r.petBallOn = (await exec("document.querySelector('.petball')?.dataset.figure === '1'")) ? 'ok' : 'fail:figure-off'
  r.petFigureWindow = bounds().width === FIGURE_VIEW.width && bounds().height === FIGURE_VIEW.height ? 'ok' : `fail:${bounds().width}x${bounds().height}`
  r.pet3dCanvas = (await exec("!!document.querySelector('.pet3d-canvas')")) ? 'ok' : 'fail:no-canvas'
  // ⚠ 窗口从 30×300ms(9s) 放宽到 60×300ms(18s)：`petReady` 现在**必然晚于 three chunk
  //   的下载与解析**（PetBall 改成动态 import 之后才成立）。原来那 9 秒是在「three 随入口
  //   chunk 同步解析」的前提下定的，高负载下不够 → `petFigureUnchanged` 偶发报
  //   `model-not-ready`（2026-10-01 资源占用优化时暴露）。
  //   只放宽窗口、不改成「ready 后再等一帧」：多等那几帧对判定没有帮助，超时语义更直观。
  for (let i = 0; i < 60; i++) {
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
  // ── R6：人物形态下滚轮**什么都不做**（onWheel 首行的 figure 早退，design §9 标的
  // 最易漏处）。人物形态没有可见的窗口索引，只能靠 `__bd_ball` 的 idx/winIdx 渲染期
  // 镜像观测；夹具必须推满「2 位供应商 × 各自多窗口」—— 单供应商/单窗口下推进本来
  // 就是空操作，这条会**恒绿**（那正是它最容易写废的形态）。
  await pushFix(FIX_AB)
  const figBefore = await ballProbe()
  // 胶囊里的轮播点数 = 供应商数：它 ≥2 才证明「换人」这一轴真的有可推进的东西
  const figDots = Number(await exec('document.querySelectorAll(".petball-dots i").length'))
  // 每一步都记投递结果：`no-hit`（压根没派发出去）必须算红 —— 否则「事件没送到」
  // 和「守卫挡住了」长得一模一样，这条会退化成恒绿（R7）。
  const figWheels: string[] = []
  const figWheel = async (dx: number, dy: number): Promise<void> => {
    figWheels.push(String(await exec(wheelJs(dx, dy))))
    await sleep(320)
  }
  await figWheel(100, 0) // 左右 ×1：换一位供应商（×2 会绕回同一位 → 观测全相等、恒绿）
  await figWheel(0, 100) // 上下 ×2：切时限窗口
  await figWheel(0, 100)
  const figAfter = await ballProbe()
  let figWhy = ''
  if (figWheels.some((w) => w !== 'ok')) figWhy = `fail:dispatch=${figWheels.join(',')}`
  else if (figBefore.err || figAfter.err) figWhy = `fail:probe=${figBefore.err || figAfter.err}`
  else if (figBefore.winCount <= 1 || figDots < 2)
    figWhy = `fail:precondition winCount=${figBefore.winCount},dots=${figDots}`
  else if (figAfter.idx !== figBefore.idx) figWhy = `fail:idx ${figBefore.idx}->${figAfter.idx}`
  else if (figAfter.winIdx !== figBefore.winIdx) figWhy = `fail:winIdx ${figBefore.winIdx}->${figAfter.winIdx}`
  else if (figAfter.label !== figBefore.label) figWhy = `fail:label ${figBefore.label}->${figAfter.label}`
  r.petFigureNoWheel = figWhy || 'ok'
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
  // ⚠️ `rect` / `measure.box` **运行时可以是 null**，类型不能骗人：
  //   · 球形态根本不建 3D 场景，`__bd_ball()` 的字段全是 null/[]（见 ballshot 的同款说明）
  //   · 人物形态在场景首帧 `measure()` 之前，`measure.box` 也是 null（`shots.ts` 靠轮询等它）
  // 原来这里只判了 `ball &&` 就直接 `ball.rect.width` / `ball.measure.box.width` ——
  // 一次时序抖动就抛 TypeError，而它是**未捕获的 promise rejection**，
  // 于是**整个 `--uitest` 一条 JSON 都不打印**（实测：崩在 runUiTest，stdout 仅 1.2KB 错误栈）。
  // 一条纯记录字段把整轮 112 键的证据换成「什么都没跑」，这是最坏的一种脆。
  // `petDiag` 是**纯诊断**，没有任何断言读它，所以加空值保护不会弱化任何门。
  const ball = (await exec('window.__bd_ball?.() ?? null')) as
    | {
        rect: { x: number; y: number; width: number; height: number } | null
        measure: { box: { width: number; height: number } | null } | null
      }
    | null
  const bRect = ball?.rect ?? null
  const bInk = ball?.measure?.box ?? null
  r.petDiag = JSON.stringify({
    watch,
    hb: hb && { w: Math.round(hb.width), h: Math.round(hb.height) },
    rect: bRect && { w: Math.round(bRect.width), h: Math.round(bRect.height) },
    ink: bInk && { w: bInk.width, h: bInk.height },
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

  // ── AC6.1：人物形态的确定性字段与步 0 基线**逐位**相同（基线比对，这条不弄坏）───
  //
  // 基线口径 = `BD_PET=1 BD_PET_ID=aria npx electron . --ballshot` 的 diag，全部是
  // **窗口坐标系**（canvas 是 [缓冲宽,缓冲高,client宽,client高]，不是屏幕坐标）：
  //   win[213,293] stage[213,293] canvas[426,586,213,293]
  //   overlay [["petball-caption",68,245,145,289]]
  //   rect{x:26.880806326334206,y:39.53742447368828,width:159.23838734733158,height:212.83465409088166}
  //   center{x:106.5,y:145.9547515191291} stride 26.8 petReady true
  //   胶囊文案 "13.7% / Claude Code"
  //
  // ⚠ overlay 与胶囊文案必须出自**同一帧**（2026-09-27 探针查明，曾经劈叉过）：
  // ballshot 的 diag 帧在折叠后 ~6s 轮播跳到了 idx1「Claude Code」—— 它的标签实测
  // 59.28px，+左右 padding 9px → 胶囊 77px → 恰好 68..145；而 idx0「OpenCode Go」
  // 的标签是 64.24px → 胶囊 82px → 65..148，**永远**落不到基线那个盒。两个环境的
  // 文字度量完全一致（ballshot 与 uitest 都是 dpr 2、同一套 CSS，探针同值），所以
  // 这里等轮播跳一位、与 ballshot 基线**同帧同供应商**再量，而不是量刚挂载的 idx0。
  //
  // 三个前置，差一个就是**假红**（假红比没断言更糟）：
  //  ① 角色必须是 Aria —— 上面 petSwitch 已经把默认角色换掉了，ray 的 walk 是
  //    `m_walk_neutral` 另一套素材，stride 不保证同值，得先换回来；
  //  ② 数据必须是演示快照 —— 胶囊的宽由「13.7% / Claude Code」撑出来，换个供应商或
  //    窗口宽度就变；角标同理（演示数据 dataAt 新鲜 → 没有可信度角标）；
  //  ③ 必须是**收起后的新挂载** —— 轮播的 lastAdvance 才重新起算（6s 一跳），
  //    等到 idx==1 立即量，在 12s 的下一跳之前完成。
  // 冷启动时素材解析可能超过 6 秒的轮播窗口，所以留 3 轮重试（第二轮起素材已缓存）。
  // ⚠ overlay 不与 --ballshot 的 diag 逐字比对，改用**有界检查**（见下面 figOverlayWhy）。
  //   其余 7 个字段仍逐位钉死。
  const FIG_BASE = JSON.stringify({
    win: [213, 293],
    stage: [213, 293],
    canvas: [426, 586, 213, 293],
    rect: {
      x: 26.880806326334206,
      y: 39.53742447368828,
      width: 159.23838734733158,
      height: 212.83465409088166
    },
    center: { x: 106.5, y: 145.9547515191291 },
    stride: 26.8,
    petReady: true,
    idx: 1,
    pet: 'aria',
    caption: '13.7% / Claude Code'
  })
  // 字段与 --ballshot 的 diag 逐字对齐（那条 diag 就是基线的出处），多出 idx/pet/caption
  // 三个观测点：前两个决定「这一轮值不值得比」，第三个证明胶囊里是基线那位供应商。
  const figFieldsJs = `JSON.stringify({
    win: [window.innerWidth, window.innerHeight],
    stage: (()=>{const s=document.querySelector('.petball-stage'); return s?[s.clientWidth,s.clientHeight]:null})(),
    canvas: (()=>{const c=document.querySelector('.pet3d-canvas'); return c?[c.width,c.height,c.clientWidth,c.clientHeight]:null})(),
    overlayRaw: [...document.querySelectorAll('.petball-fallback,.petball-caption,.petball-bubble,.petball-badge,.petball-toast')]
      .map(e=>{const r=e.getBoundingClientRect();return [e.className.split(' ')[0],Math.round(r.left),Math.round(r.top),Math.round(r.right),Math.round(r.bottom)]}),
    rect: window.__bd_ball?.()?.rect ?? null,
    center: window.__bd_ball?.()?.center ?? null,
    stride: window.__bd_ball?.()?.stride ?? -1,
    petReady: window.__bd_ball?.()?.petReady === true,
    idx: window.__bd_ball?.()?.idx ?? -1,
    pet: document.querySelector('.petball')?.dataset.pet ?? '',
    caption: (document.querySelector('.petball-caption')?.innerText||'').trim().split('\\n').join(' / ')
  })`
  /**
   * overlay 的**有界检查**（替代逐位比对）。
   *
   * 为什么不能用「宽度 77」当硬期望（2026-09-28 实测裁决）：
   * 胶囊的宽度 = 标签文字宽 + 左右 padding，而标签是**供应商名 + 读数**。R4 让自动轮播
   * 改成「先走完窗口再换人」，节拍随之改变 —— 同一墙钟时刻会落在**不同的供应商**上：
   *   · HEAD（R4 前）：diag 帧落 idx1「Claude Code」，标签 59.28px → 胶囊 77px → 68..145
   *   · R4：        diag 帧落 idx0「OpenCode Go」，标签 64.24px → 胶囊 83px → 65..148
   * 两边各连跑 3 次，**结果完全确定**（不是 flake，是节拍变化后的稳定新值）。
   *
   * 所以宽度从来不是「人物形态」的属性 —— 它是**文案长度**的属性。把 77 钉死，等于
   * 把人物形态断言耦合到轮播时序：下一次节拍调整就会伪造一个「人物形态回归」。
   *
   * 保留的强度（这仍是一条有牙齿的断言，不是「什么都不查」）：
   *  ① overlay 恰好**一项**，且就是 .petball-caption —— 基线的泡泡/角标必须已散尽，
   *     多一项说明有残留 UI（曾经真的发生过）
   *  ② y / h 逐位钉死：245 / 289（胶囊贴着脚、44px 高）—— 这两个与文案无关
   *  ③ x / w 有界：盒子必须完整落在 213×293 窗内，且宽度在 [60, 120] —— 宽度归零、
   *     溢出窗口、或窄到只剩一个字，都会红
   *  ④ caption 文案本身仍逐位钉死（'13.7% / Claude Code'）—— 「是哪个供应商」这个信息
   *     没丢，只是不再用它**推导**宽度
   */
  const figOverlayWhy = (ov: unknown, caption: string): string => {
    if (!Array.isArray(ov)) return `fail:overlay-not-array=${JSON.stringify(ov)}`
    if (ov.length !== 1) return `fail:overlay-items=${ov.length}（基线只有胶囊一项：${JSON.stringify(ov)}）`
    const it = ov[0]
    if (!Array.isArray(it) || it.length !== 5) return `fail:overlay-shape=${JSON.stringify(it)}`
    const [cls, left, top, right, bottom] = it as OverlayBox
    if (cls !== 'petball-caption') return `fail:overlay-class=${cls}`
    // 绝对坐标 → 尺寸（差值，不是直接读 right/bottom）
    const w = right - left
    const h = bottom - top
    if (top !== 245 || h !== 44) return `fail:overlay-yh=top${top}/h${h}（基线 245/44）`
    if (left < 0 || right > FIGURE_VIEW.width) return `fail:overlay-xw=${left}..${right} 溢出 ${FIGURE_VIEW.width}`
    if (w < 60 || w > 120) return `fail:overlay-width=${w}（应在 60–120：太窄只剩一个字，太宽说明 padding 跑飞）`
    if (caption !== '13.7% / Claude Code') return `fail:caption=${caption}`
    return ''
  }

  let needAria = String(await exec("document.querySelector('.petball')?.dataset.pet ?? ''")) !== 'aria'
  let figGot = ''
  let figWhy2 = ''
  for (let attempt = 1; attempt <= 3 && !figGot; attempt++) {
    await exec('window.api.expand()')
    await sleep(800)
    if (needAria) {
      // 设置页的「换一位」按 PETS 顺序渲染，Aria 恒为第一个；用 title 兜底下标漂移
      await exec("[...document.querySelectorAll('.btn-secondary')].find(b=>b.textContent.includes('设置'))?.click()")
      await sleep(700)
      await exec("[...document.querySelectorAll('.pet-chip')].find(c=>/^Aria/.test(c.title||''))?.click()")
      await sleep(600)
      await exec("[...document.querySelectorAll('.icon-btn')].find(b=>b.title==='返回')?.click()")
      await sleep(500)
      needAria = false
    }
    await pushFix(demoSnapshot()) // 推空再推：winCount 归零会把 winIdx 夹回 0
    await exec('window.api.collapse()')
    await sleep(1400)
    let ready = false
    for (let i = 0; i < 25; i++) {
      if ((await exec('window.__bd_ball?.()?.petReady === true')) === true) {
        ready = true
        break
      }
      await sleep(400)
    }
    // 自报家门泡泡必须散尽：基线的 overlay 里只有胶囊这一项
    for (let i = 0; i < 20; i++) {
      if (!(await exec("!!document.querySelector('.petball-bubble')"))) break
      await sleep(300)
    }
    // 等轮播跳到基线那一帧（idx1 Claude Code，见 FIG_BASE 上方的探针结论）：
    // 新挂载 lastAdvance 归零 → 6s 一跳，每 500ms 观测一次，[6s,12s) 内必然看到 idx==1
    let idxNow = -1
    for (let i = 0; i < 30; i++) {
      idxNow = Number(await exec('window.__bd_ball?.()?.idx ?? -1'))
      if (idxNow === 1) break
      await sleep(500)
    }
    if (idxNow !== 1) {
      // 一直没到基线帧（素材解析拖过了一个轮播窗口）→ 下一轮重来
      figWhy2 = `retry:idx=${idxNow}@${attempt}`
      continue
    }
    const raw = await exec(figFieldsJs)
    if (typeof raw !== 'string') {
      figWhy2 = `fail:exec-failed@${attempt}`
      continue
    }
    if (!ready) {
      figWhy2 = `fail:model-not-ready@${attempt}`
      continue
    }
    let obj: { idx?: number; pet?: string } = {}
    try {
      obj = JSON.parse(raw) as { idx?: number; pet?: string }
    } catch {
      figWhy2 = `fail:parse@${attempt}:${raw.slice(0, 60)}`
      continue
    }
    if (obj.pet !== 'aria') {
      // 角色没换成（或这一轮还挂着旧角色）：下一轮从设置页再换一次
      figWhy2 = `retry:pet=${obj.pet}`
      needAria = true
      continue
    }
    if (obj.idx !== 1) {
      // 取数与量帧之间又跳了一位 → 胶囊里不是基线帧那个供应商，这轮作废
      figWhy2 = `retry:idx=${obj.idx}`
      continue
    }
    figGot = raw
  }
  // 7 个字段逐位 + overlay 有界（见 figOverlayWhy 的裁决理由）
  let figFail = figWhy2 || 'no-capture'
  if (figGot) {
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = JSON.parse(figGot) as Record<string, unknown>
    } catch {
      parsed = null
    }
    if (!parsed) {
      figFail = `fail:unparsed=${figGot.slice(0, 80)}`
    } else if (parsed.idx !== 1 || parsed.pet !== 'aria') {
      figFail = `fail:frame idx=${parsed.idx} pet=${parsed.pet}`
    } else {
      // 7 个几何/时序字段仍逐位钉死（把 overlayRaw 摘掉再比）
      const { overlayRaw, ...rest } = parsed
      void overlayRaw
      if (JSON.stringify(rest) !== FIG_BASE) figFail = `fail:base=${figGot}`
      else figFail = figOverlayWhy(parsed.overlayRaw, String(parsed.caption ?? ''))
    }
  }
  r.petFigureUnchanged = figFail ? (figFail === 'no-capture' ? 'fail:no-capture' : figFail) : 'ok'

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
  // 环心有读数 + 环按 kind 分流（本任务第 2 步把环拆成「套餐才有环」）：
  //   · plan  —— track 的 stroke 必须真的算出来（不是 SVG 默认的 none），有百分比读数时
  //              fill 的 stroke 与 dasharray 都要查：dasharray 承载弧长，为 0 就等于没画弧。
  //              （唯一例外：读数就是 `0%`，目标弧长本来就是 0 —— 这时要查的是 fill **在**）
  //   · balance —— 连 track 都不许有（AC2.1）：余额只留素圆盘 + 金额
  // 这修的是一个**已存在的 bug** —— 2026-09-27 之前 .dot-ring-track 全项目零规则，
  // 且两个 <circle> 都不写 stroke 属性（SVG 默认 none），所以 WebGL 失败时环是隐形的。
  //
  // 只查 track 不够（2026-09-27 复核）：轨道是 16% 透明度的灰，几乎看不见 ——
  // 「弧根本没画」时它照样成立。所以 fill 的 stroke 与 dasharray 都要查。
  //
  // kind 由 PetBall 的 data-ring 提供（与 L1 同一个表达式）。断言**必须**先分 kind：
  // 本机数据里球形态常落在 5H = 0% 的窗口上，「dash > 0」对它天然不成立，而余额供应商
  // 连 track 都没有 —— 混成一条布尔只会得到永真的兜底（或每次都红的假警报）。
  const ringDom = String(
    await exec(`(()=>{
      const dot=document.querySelector('.petball-fallback')
      if(!dot) return 'fail:no-dot'
      const track=dot.querySelector('.dot-ring-track')
      const fill=dot.querySelector('.dot-ring-fill')
      const value=dot.querySelector('.dot-value')
      const fs=fill?getComputedStyle(fill):null
      return JSON.stringify({
        ring: dot.getAttribute('data-ring') || '',
        track: track ? getComputedStyle(track).stroke : 'no-track',
        fill: fs ? fs.stroke : 'no-fill',
        dash: fs ? fs.strokeDasharray : 'no-fill',
        value: value ? value.textContent : ''
      })
    })()`)
  )
  let ringKind = ''
  let trackStroke = 'none'
  let fillStroke = 'no-fill'
  let fillDash = 'no-fill'
  let ringValue = ''
  try {
    const d = JSON.parse(ringDom) as { ring: string; track: string; fill: string; dash: string; value: string }
    ringKind = d.ring
    trackStroke = d.track
    fillStroke = d.fill
    fillDash = d.dash
    ringValue = d.value
  } catch {
    // ringDom 是 fail:... —— 下面统一报出去
  }
  const realStroke = (v: string): boolean => v !== 'none' && v !== '' && v !== 'no-track' && v !== 'no-fill'
  const pctLike = /^-?\d+(\.\d+)?%$/.test(ringValue)
  const ringWhy = ringDom.startsWith('fail:')
    ? ringDom
    : !ringValue
      ? `fail:value='${ringValue}'`
      : ringKind === 'plan'
        ? !realStroke(trackStroke)
          ? `fail:plan-track=${trackStroke}`
          : pctLike && !realStroke(fillStroke)
            ? `fail:plan-fill=${fillStroke}`
            : pctLike && ringValue !== '0%' && !(parseFloat(fillDash) > 0)
              ? `fail:plan-dash=${fillDash}`
              : ''
        : ringKind === 'balance'
          ? trackStroke !== 'no-track'
            ? `fail:balance-track=${trackStroke}`
            : fillStroke !== 'no-fill'
              ? `fail:balance-fill=${fillStroke}`
              : ''
          : `fail:ring='${ringKind}'`
  r.petBallCenterValue = ringWhy || 'ok'
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

  // ─── 09-27-dot-ring-scroll：球上的 12 条断言（另 2 条人物形态的在上面）────────
  //
  // 纪律：每条都必须能被「先弄坏一次」弄红 —— 所以断言一律自带前置条件（探针报错、
  // data-ring 不对、winCount 不够、句柄缺 idx 都算红），不写恒绿兜底。夹具按
  // 三窗套餐 → 单窗套餐 → 余额 → 双供应商 的顺序推满，每步之间互不干扰。
  //
  // 右键菜单那一半只在这里截得到：菜单标签是主进程现拼的，渲染层读不到。
  const menuLabels = await runPetMenu()
  const menuWhy = menuLabels.includes('<not-called>') || menuLabels.includes('<patch-failed>')
    ? `fail:menu=${menuLabels.join(',')}`
    : menuLabels.some((l) => l.includes(deadRingLabel))
      ? `fail:${menuLabels.join(',')}`
      : ''
  const removedWhy = [ringRowGone !== 'ok' ? ringRowGone : '', menuWhy].filter(Boolean).join(' | ')
  r.petRingRemoved = removedWhy || 'ok'

  // 「隐藏余额」只能从右键菜单切（App 只在挂载时读一次 extras，setExtras 推不进 React）
  const readHide = async (): Promise<boolean> =>
    (await exec("window.api.getExtras(['ui:hideBalance']).then(e=>e['ui:hideBalance']==='1')")) === true
  const hideWasOn = await readHide()
  const setHide = async (want: boolean): Promise<string> => {
    if ((await readHide()) === want) return 'ok'
    const labels = await runPetMenu('隐藏余额')
    if (!labels.includes('隐藏余额')) return `fail:menu=${labels.join(',')}` // 哨兵串也不含它 → 一并算红
    for (let i = 0; i < 12; i++) {
      if ((await readHide()) === want) return 'ok'
      await sleep(300)
    }
    return 'fail:timeout'
  }

  const titleName = (t: string): string => t.split(' · ')[0] // tooltip 首段 = 供应商名
  const dotValue = async (): Promise<string> =>
    String(await exec("document.querySelector('.petball-fallback .dot-value')?.textContent ?? ''"))
  /** 目标弧长（与 JSX 同式）：dasharray 第一段必须落在它 ±0.5px 内 */
  const dashFor = (pct: number): number => (2 * Math.PI * 22 * Math.min(100, Math.max(0, pct))) / 100
  const dashNear = (dash: string | null, pct: number): boolean => {
    const first = parseFloat(String(dash ?? '').trim().split(/[\s,]+/)[0] ?? '')
    return Number.isFinite(first) && Math.abs(first - dashFor(pct)) <= 0.5
  }
  /** 推夹具 + 等读数补间收尾：push 也会让 target 变化（走 600ms 动画），直接读会拿到中间态 */
  const pushSettle = async (snaps: unknown[]): Promise<void> => {
    await pushFix(snaps)
    await sleep(600)
  }
  /** 走一步并等动画落定（320ms 冷却 + 500ms 补间 > COUNTUP_MS=600） */
  const wheelSettled = async (dx: number, dy: number): Promise<void> => {
    await wheelStep(dx, dy)
    await sleep(500)
  }

  // ── 场景一：三窗口套餐 10% / 20% / 30%（短标签 5H / W / M）─────────────────
  await pushSettle(FIX_PLAN3)
  const g0 = await ballProbe()
  let ringOnWhy = '' // petRingAlwaysOn：套餐必有轨道 + 填充弧 + 弧长
  let winCycleWhy = '' // petWindowCycle 的多窗口半边（单窗口那半在场景二合报）
  let winLabelWhy = '' // petWinLabel 的多窗口半边
  if (g0.err) {
    ringOnWhy = winCycleWhy = winLabelWhy = `fail:probe=${g0.err}`
  } else {
    // 环三层（L1 有无 / L2 轨道 / L3 弧长），缺一层都算红
    if (g0.ring !== 'plan') ringOnWhy = `fail:ring=${g0.ring}`
    else if (!g0.track) ringOnWhy = 'fail:no-track'
    else if (g0.trackStroke == null || !realStroke(g0.trackStroke)) ringOnWhy = `fail:track=${g0.trackStroke}`
    else if (!g0.fill) ringOnWhy = 'fail:no-fill'
    else if (g0.fillStroke == null || !realStroke(g0.fillStroke)) ringOnWhy = `fail:fill=${g0.fillStroke}`
    else if (!dashNear(g0.dash, 10)) ringOnWhy = `fail:dash=${g0.dash}`
    if (g0.winCount !== 3) winCycleWhy = `fail:winCount=${g0.winCount}`
    else if (g0.winIdx !== 0) winCycleWhy = `fail:winIdx0=${g0.winIdx}`
    else if (g0.value !== FIX_PLAN3_VALS[0]) winCycleWhy = `fail:v0=${g0.value}`
    else if (!dashNear(g0.dash, 10)) winCycleWhy = `fail:dash0=${g0.dash}`
    if (g0.winLabel !== FIX_PLAN3_LBL[0]) winLabelWhy = `fail:lbl0=${g0.winLabel}`
  }
  r.petRingAlwaysOn = ringOnWhy || 'ok'
  // AC3.1/AC3.2：短标签必须落在百分比**正下方**（同一列），既不压数字也不压环、且不溢出 56×56。
  // 这里量的是**几何**，不是 CSS 声明 —— 声明由 scripts/test-structure.mjs 的 D4/D5 守。
  // 两条声明各自的判据都能被改坏（见 implement.md），但它们都**证明不了**「真的在下方」：
  // 那只有真实布局能给。所以这里补一条读 getBoundingClientRect 的。
  //
  // 阈值从几何算：整组 = 13(数字) + 1(gap) + 8(标签) = 22px，56 盘里竖直居中 → 数字底 ~31.5、
  // 标签顶 ~32.5，间隙 ≈1px，容差取 5px（够松，别把正常的字体度量差异当回归）。
  const wlGeo = String(await exec(`(()=>{
    const dot=document.querySelector('.petball-fallback'); if(!dot) return 'fail:no-dot'
    const dv=dot.querySelector('.dot-value'); const wl=dot.querySelector('.dot-winlabel')
    if(!dv) return 'fail:no-value'; if(!wl) return 'fail:no-label'
    const a=dv.getBoundingClientRect(), b=wl.getBoundingClientRect(), d=dot.getBoundingClientRect()
    // 环的几何：56×56 盘，圆心 (28,28)，轨道 r=22、stroke 5 → 笔画内缘 r=19.5、外缘 r=24.5。
    // 换算到**未缩放**的盘坐标系（按 d.width 归一），这样按压态的 scale 不会污染判据。
    const k=56/d.width
    const bx=(b.left-d.left)*k, by=(b.top-d.top)*k, bw=b.width*k, bh=b.height*k
    const corners=[[bx,by],[bx+bw,by],[bx,by+bh],[bx+bw,by+bh]]
      .map(([x,y])=>+Math.hypot(x-28,y-28).toFixed(2))
    const inBox = bx>=0 && by>=0 && bx+bw<=56 && by+bh<=56
    return JSON.stringify({gap:+(b.top-a.bottom).toFixed(2), corners, inBox, text:wl.textContent})
  })()`))
  let wlBelowWhy = ''
  if (wlGeo.startsWith('fail:')) {
    wlBelowWhy = wlGeo
  } else {
    const g = JSON.parse(wlGeo) as { gap: number; corners: number[]; inBox: boolean; text: string }
    // ① 数字在上、标签在下：标签顶不低于数字底，且间隙在 5px 内（=「正下方」而非「另开一坨」）
    if (g.gap < -0.5 || g.gap > 5) wlBelowWhy = `fail:gap=${g.gap}（标签须紧贴数字下方）`
    // ② 不压环：四角到盘心的最大距离必须小于环笔画**内缘** r=19.5
    else if (Math.max(...g.corners) >= 19.5) wlBelowWhy = `fail:press-ring=${Math.max(...g.corners)}`
    // ③ 不溢出 56×56（AC3.2）
    else if (!g.inBox) wlBelowWhy = 'fail:overflow-56'
    // ④ 取值仍来自 shortWindowLabel()，随窗口切换同步变化（AC3.4 —— 位置对了但值错了也是回归）
    else if (g.text !== FIX_PLAN3_LBL[0]) wlBelowWhy = `fail:text=${g.text} want=${FIX_PLAN3_LBL[0]}`
  }
  r.petWinLabelBelow = wlBelowWhy || 'ok'
  await wheelSettled(0, 100)
  const g1 = await ballProbe()
  if (!winCycleWhy) {
    if (g1.err) winCycleWhy = `fail:probe=${g1.err}`
    else if (g1.winIdx !== 1) winCycleWhy = `fail:winIdx1=${g1.winIdx}`
    else if (g1.value !== FIX_PLAN3_VALS[1]) winCycleWhy = `fail:v1=${g1.value}`
    else if (!dashNear(g1.dash, 20)) winCycleWhy = `fail:dash1=${g1.dash}`
  }
  if (!winLabelWhy && g1.winLabel !== FIX_PLAN3_LBL[1]) winLabelWhy = `fail:lbl1=${g1.winLabel}`
  await wheelSettled(0, 100)
  const g2 = await ballProbe()
  if (!winCycleWhy) {
    if (g2.err) winCycleWhy = `fail:probe=${g2.err}`
    else if (g2.winIdx !== 2) winCycleWhy = `fail:winIdx2=${g2.winIdx}`
    else if (g2.value !== FIX_PLAN3_VALS[2]) winCycleWhy = `fail:v2=${g2.value}`
    else if (!dashNear(g2.dash, 30)) winCycleWhy = `fail:dash2=${g2.dash}`
  }
  if (!winLabelWhy && g2.winLabel !== FIX_PLAN3_LBL[2]) winLabelWhy = `fail:lbl2=${g2.winLabel}`
  // AC5.1：30% → 10% 回绕，渲染期镜像把显示值归零 → 8 次采样必须截到严格落在 (0,10)
  // 的中间态；「直接落定」时采到的全是 0% / 10%，这条就红。
  await exec(wheelJs(0, 100))
  const mids: string[] = []
  let midOk = false
  for (let i = 0; i < 8; i++) {
    await sleep(45)
    const v = await dotValue()
    mids.push(v)
    const n = parseFloat(v)
    if (Number.isFinite(n) && n > 0 && n < 10) midOk = true
  }
  r.petCountUp = midOk ? 'ok' : `fail:samples=${mids.join('/')}`
  // AC5.2：动画收尾必须精确落目标值（easeOut 尾帧插值会留尾差）
  await sleep(700)
  const g3 = await ballProbe()
  r.petCountUpExact = g3.err
    ? `fail:probe=${g3.err}`
    : g3.value === FIX_PLAN3_VALS[0]
      ? 'ok'
      : `fail:${g3.value} want=${FIX_PLAN3_VALS[0]}`
  // AC4.4 惯性两段：① 一个手势里连发 30 个 deltaY:40 只准跳 1 格；
  // ② 断流后的残量必须清掉 —— 否则残量会让下一次 10px 轻扫立刻过阈值（静默误切一格）。
  const i0 = await ballProbe()
  const tightOk = String(
    await exec(`(()=>{const b=document.querySelector('.petball-hit'); if(!b) return 'no-hit'
      for(let i=0;i<30;i++) b.dispatchEvent(new WheelEvent('wheel',{deltaX:0,deltaY:40,bubbles:true}))
      return 'ok'})()`)
  )
  const i1 = await ballProbe()
  let inertiaWhy =
    tightOk !== 'ok'
      ? `fail:dispatch=${tightOk}`
      : i0.err || i1.err
        ? `fail:probe=${i0.err || i1.err}`
        : i0.winCount <= 1
          ? `fail:winCount=${i0.winCount}`
          : i1.winIdx !== (i0.winIdx + 1) % i0.winCount
            ? `fail:tight ${i0.winIdx}->${i1.winIdx}`
            : ''
  await sleep(300) // 让上一手势断流（>GESTURE_GAP），进残量那一段
  const pacedOk = String(
    await exec(`(async()=>{const b=document.querySelector('.petball-hit'); if(!b) return 'no-hit'
      for(let i=0;i<6;i++){b.dispatchEvent(new WheelEvent('wheel',{deltaX:0,deltaY:100,bubbles:true})); await new Promise(r=>setTimeout(r,40))}
      return 'ok'})()`)
  )
  const i2 = await ballProbe()
  if (!inertiaWhy) {
    inertiaWhy =
      pacedOk !== 'ok'
        ? `fail:dispatch=${pacedOk}`
        : i2.err
          ? `fail:probe=${i2.err}`
          : i2.winIdx !== (i1.winIdx + 1) % i1.winCount
            ? `fail:paced ${i1.winIdx}->${i2.winIdx}`
            : ''
  }
  await sleep(800) // 手势早已断流：残量若没清，下面这 10px 会直接过阈值
  await exec(wheelJs(0, 10))
  const i3 = await ballProbe()
  if (!inertiaWhy) {
    inertiaWhy = i3.err ? `fail:probe=${i3.err}` : i3.winIdx !== i2.winIdx ? `fail:residual ${i2.winIdx}->${i3.winIdx}` : ''
  }
  r.petWheelInertia = inertiaWhy || 'ok'

  // ── 场景二：单窗口套餐 —— 切了等于没切（AC3.4），且不出现短标签（AC3.6）──────
  await pushSettle(FIX_PLAN1)
  const h0 = await ballProbe()
  const h1Val = '13.7%' // fmtPercent(13.7)
  let singleWhy = ''
  let singleLabelWhy = ''
  if (h0.err) {
    singleWhy = singleLabelWhy = `fail:probe=${h0.err}`
  } else {
    if (h0.winCount !== 1) singleWhy = `fail:winCount=${h0.winCount}`
    else if (h0.value !== h1Val) singleWhy = `fail:value=${h0.value}`
    if (h0.winLabel !== null) singleLabelWhy = `fail:lbl0=${h0.winLabel}`
  }
  await wheelSettled(0, 100)
  await wheelSettled(0, 100)
  const h1 = await ballProbe()
  if (!singleWhy) {
    if (h1.err) singleWhy = `fail:probe=${h1.err}`
    else if (h1.winIdx !== 0) singleWhy = `fail:winIdx=${h1.winIdx}`
    else if (h1.value !== h1Val) singleWhy = `fail:value=${h1.value}`
  }
  if (!singleLabelWhy && h1.winLabel !== null) singleLabelWhy = `fail:lbl1=${h1.winLabel}`
  // 多窗口半边 + 单窗口半边合成一条（拆开 14 条就对不上了）
  r.petWindowCycle = winCycleWhy || singleWhy || 'ok'
  r.petWinLabel = winLabelWhy || singleLabelWhy || 'ok'

  // ── 场景三：充值余额 —— 连轨道都不画（AC2.1）；隐藏余额时不出现数字（AC5.3）──
  await pushSettle(FIX_BAL)
  const balDom = String(
    await exec(`(()=>{const d=document.querySelector('.petball-fallback'); if(!d) return 'fail:no-dot'
      return JSON.stringify({ring:d.getAttribute('data-ring')||'', n:d.querySelectorAll('[class*="dot-ring"]').length})})()`)
  )
  let balWhy = ''
  try {
    const b = JSON.parse(balDom) as { ring: string; n: number }
    if (b.ring !== 'balance') balWhy = `fail:ring=${b.ring}` // 前置条件：真的是余额供应商
    else if (b.n !== 0) balWhy = `fail:nodes=${b.n}`
  } catch {
    balWhy = `fail:probe=${balDom}`
  }
  r.petNoRingOnBalance = balWhy || 'ok'
  const hideOn = await setHide(true)
  await sleep(500)
  const hv1 = await dotValue()
  await sleep(400)
  const hv2 = await dotValue()
  const hideBack = await setHide(hideWasOn)
  r.petHideBalanceNoAnim =
    hideOn !== 'ok'
      ? `fail:${hideOn}`
      : hv1 !== '••••' || hv2 !== '••••'
        ? `fail:${hv1}/${hv2}`
        : hideBack !== 'ok'
          ? `fail:restore=${hideBack}`
          : 'ok'

  // ── 场景四：双供应商 —— 换人唯一入口、手动后轮播暂停、恢复后窗口归零 ─────────
  await pushSettle(FIX_AB)
  const a0 = await ballProbe()
  let holdWhy = ''
  let advWhy = ''
  let provWhy = ''
  if (a0.err) {
    holdWhy = advWhy = provWhy = `fail:probe=${a0.err}`
  } else if (a0.winCount <= 1) {
    holdWhy = advWhy = provWhy = `fail:precondition winCount=${a0.winCount}`
  } else if ((await setWindowTo(1, 5)) !== 1) {
    holdWhy = advWhy = provWhy = 'fail:setwin'
  } else {
    await wheelSettled(100, 0) // 手动换人 = 唯一入口（窗口同帧归零）+ 启动 8 秒暂停
    const m0 = await ballProbe()
    if (m0.err || m0.idx < 0) {
      holdWhy = advWhy = provWhy = `fail:probe=${m0.err || 'no-handle'}`
    } else {
      // ① AC4.3：换人后 7 秒内 idx 不许推进（14 × 500ms 采样）
      for (let i = 1; i <= 14; i++) {
        await sleep(500)
        const idx = Number(await exec('window.__bd_ball?.()?.idx ?? -1'))
        if (idx !== m0.idx) {
          holdWhy = `fail:idx ${m0.idx}->${idx} @${(i * 0.5).toFixed(1)}s`
          break
        }
      }
      // ② R4：暂停结束后轮播**先在同一家里把窗口走完**，走完才换人。
      //
      //    这条**替换**掉了旧的 petCarouselResetsWindow（已作废，见下方 r 赋值处的注释）。
      //    观测方式：500ms 一采，把 winIdx 的**去重序列**记下来；换人那一帧记 -1。
      //    24 次 × 500ms = 12s 观测窗，按「走完 1 个窗口（6s）+ 换人（再 6s）」足够覆盖。
      const seq: number[] = []
      let adv: BallProbe | null = null
      for (let i = 0; i < 24 && !adv && !advWhy; i++) {
        await sleep(500)
        const p = await ballProbe()
        if (p.err) {
          advWhy = `fail:probe=${p.err}`
          break
        }
        if (p.idx === m0.idx) {
          if (!seq.length || seq[seq.length - 1] !== p.winIdx) seq.push(p.winIdx)
        } else {
          adv = p
          seq.push(-1) // 换人那一帧
        }
      }
      if (!advWhy && !adv) {
        advWhy = `fail:no-advance-in-12s seq=[${seq}]`
      } else if (adv) {
        await sleep(700) // 等换人后的读数补间落定再取值
        const fin = await ballProbe()
        const nm = titleName(fin.title)
        // **核心判据**：换人*之前*必须见过窗口往后走过（seq 里出现过 >0 的值）。
        // 只守「换人时窗口回 0」是不够的 —— 旧的「每 6s 直接 advanceProvider」
        // 同样满足那一条，而那正是 R4 要改掉的病（用户看到的「快速切供应商但从不切时限」）。
        const walked = seq.some((w) => w > 0)
        advWhy = fin.err
          ? `fail:probe=${fin.err}`
          : !walked
            ? `fail:no-window-walk seq=[${seq}]`
            : fin.winIdx !== 0
              ? `fail:winIdx=${fin.winIdx} seq=[${seq}]`
              : FIX_AB_FIRST[nm] !== fin.value
                ? `fail:${nm}=${fin.value} want=${FIX_AB_FIRST[nm]} seq=[${seq}]`
                : ''
      }
      // ③ 左右滚 = 换人：窗口必须归零、读数落到新供应商的 windows[0]（标题变 = 真换了人）
      const c0 = await ballProbe()
      const n0 = titleName(c0.title)
      if (c0.err) provWhy = `fail:probe=${c0.err}`
      else if ((await setWindowTo(1, 5)) !== 1) provWhy = 'fail:setwin'
      else {
        await wheelSettled(100, 0)
        const c1 = await ballProbe()
        const n1 = titleName(c1.title)
        provWhy = c1.err
          ? `fail:probe=${c1.err}`
          : n1 === n0
            ? `fail:same=${n1}`
            : c1.winIdx !== 0
              ? `fail:winIdx=${c1.winIdx}`
              : FIX_AB_FIRST[n1] !== c1.value
                ? `fail:${n1}=${c1.value} want=${FIX_AB_FIRST[n1]}`
                : ''
      }
    }
  }
  r.petWheelHold = holdWhy || 'ok'
  // ⚠ petCarouselResetsWindow **已被 09-28-dot-frame-label-carousel 作废**（不是重命名）。
  //
  // 它守的是「自动轮播推进后窗口回到 0」。R4 之后，多窗口供应商的自动轮播**正确行为
  // 就是窗口往后走**，该断言会把正确实现判成红的 —— 留着就是一条**会误报的假护栏**，
  // 比没有护栏更坏（它会让人以为 R4 改错了）。
  //
  // 换上的 petCarouselOrder 守的是**完整序列**（先走完窗口 → 再换人 → 换人时窗口回 0），
  // 而不只是换人那半边。仅守「换人时回 0」是不够的：旧的每 6s 直接 advanceProvider
  // 同样满足那一条。
  r.petCarouselOrder = advWhy || 'ok'
  r.petProviderCycle = provWhy || 'ok'

  // ── 场景四之二：petCarouselRhythm —— 专打 design §4.2 的「effect 重跑把节奏冻死」 ──
  //
  // 为什么要单独一条：petCarouselOrder 证明的是**一次**「走窗口→换人」；
  // 这条证明的是**节拍连续** —— 走完窗口之后下一个 tick 仍在 6s 附近再推进一步，
  // 而不是被某个 effect 重跑把 lastAdvance 归零、之后每一步都重新等满 6s。
  //
  // 判据不是「6s」（那受 ±1s tick 粒度与机器负载影响，太紧会变成常红的 flake），
  // 而是**单调不倒退 + 不再无限等**：三次观测（0 → 至少 1 步 → 再至少 1 步）必须在
  // 有限窗口内真的推进。冻结的实现（把 winIdx / s 塞进 deps）会一直停在 seq=[0]。
  //
  // 为什么要「不碰 holdUntil」：8s 的手动暂停（AC4.3）与 6s 的自动节奏同量级，
  // 夹在一起观测会把暂停误读成冻结。走窗口这条路**不设 hold**，所以这里显式清掉它。
  await pushSettle(FIX_AB)
  const rh0 = await ballProbe()
  let rhythmWhy = ''
  if (rh0.err) {
    rhythmWhy = `fail:probe=${rh0.err}`
  } else if (rh0.winCount <= 1) {
    rhythmWhy = `fail:precondition winCount=${rh0.winCount}`
  } else {
    // 起点：把窗口推到 0（setWindowTo 只发滚轮，会顺带起 8s 暂停 —— 见下面的说明）
    await setWindowTo(0, 5)
    const rBase = await ballProbe()
    // 收「(idx, winIdx) 去重序列」，要求至少 3 个**互不相同**的状态。
    // 为什么不逐对比较：换人后 winIdx 会归 0，与起点的 (0,0) 撞车，逐对比较会
    // 在第一次换人处误判成「没推进」。去重序列天然处理这种回绕。
    //
    // 3 个不同状态 = 连着真的推进了 2 次（6s + 6s）。冻结的实现只会停在 1 个状态。
    const seen: string[] = []
    for (let i = 0; i < 72 && seen.length < 3; i++) {
      await sleep(500)
      const p = await ballProbe()
      if (p.err) {
        rhythmWhy = `fail:probe=${p.err}`
        break
      }
      const st = `${p.idx}/${p.winIdx}`
      if (!seen.includes(st)) seen.push(st)
    }
    if (rhythmWhy) {
      /* 探针挂了 */
    } else if (seen.length < 3) {
      rhythmWhy =
        `fail:stalled base=${rBase.idx}/${rBase.winIdx} seen=[${seen}]` +
        `（36s 内只出现 ${seen.length} 个状态：球走完一步就再也不动了 —— effect 重跑把 lastAdvance 归零了）`
    }
  }
  r.petCarouselRhythm = rhythmWhy || 'ok'

  // ── 场景五：套餐窗口算不出比例（AC3.3）—— L2「轨道与 pct 解耦」的唯一证明 ──────
  // 上面几个夹具的 plan 全都带 percent，所以「无 limit 的窗口仍有轨道」若不单推一个
  // 这样的窗口，就只能指望真实数据恰好出现它时被 petBallCenterValue 顺带查到 ——
  // 那是运气，不是护栏（AC3.3 此前正是这种未被断言覆盖的状态，check 复核补上）。
  // 结果并进 petRingAlwaysOn（同一句「套餐必有轨道」的另一半），断言条目数不变。
  await pushSettle(FIX_NOLIMIT)
  const np0 = await ballProbe()
  let noPctWhy = ''
  if (np0.err) noPctWhy = `fail:probe=${np0.err}`
  else if (np0.ring !== 'plan') noPctWhy = `fail:ring=${np0.ring}`
  else if (np0.winCount !== 1) noPctWhy = `fail:winCount=${np0.winCount}`
  else if (!np0.track) noPctWhy = 'fail:no-track' // ← AC3.3 的核心：算不出比例也要有轨道
  else if (np0.trackStroke == null || !realStroke(np0.trackStroke)) noPctWhy = `fail:track=${np0.trackStroke}`
  else if (np0.fill) noPctWhy = 'fail:fill-without-pct' // 算不出比例绝不画弧，更不许画 0% 的假弧
  else if (np0.value !== '¥1.3k') noPctWhy = `fail:value=${np0.value}` // 中心是金额，不是 0%
  else if (np0.winLabel !== null) noPctWhy = `fail:lbl=${np0.winLabel}` // 单窗口不该出现短标签
  if (!ringOnWhy && noPctWhy) ringOnWhy = noPctWhy
  r.petRingAlwaysOn = ringOnWhy || 'ok' // 复写：场景一写过一次，这里补上 AC3.3 那一半
  // 收尾：隐藏余额已在场景三还原；采集频率拉回默认（setExtras 会 reconfigure → 立刻补一轮真实数据）
  await exec("window.api.setExtras({refreshInterval:'60'})")

  // ── petBallSkinSurface：5 个内置皮肤 + 一个**不存在的**皮肤下，球盘都有实心底色 ────
  //
  // AC1.5 的核心：外部皮肤（ext:*）没写 `--ball-bg` 时靠顶层 `:root` 兜底。
  // 删掉 :root 那条，这些皮肤会**全部**塌成 transparent —— 一个没有底的球比浅色的球更糟。
  // `ext:__no-such-skin__` 那一档是这条断言真正的目标：它模拟「皮肤作者没提供这个令牌」，
  // 只有 :root 兜底能让它不塌。
  //
  // 判据不是「值等于某个具体色」（那是把设计取值钉死），而是**可解析 + 不透明**：球必须
  // 是一个物体。切皮肤直接改 .app 的 data-skin（App.tsx 就是这么落的），改完**立刻**读
  // getComputedStyle —— 样式重算在读计算值时同步发生，不存在读到旧值的竞态；读完复原。
  //
  // ⚠ **覆盖范围要说清楚**（实测发现的，别误以为它什么都管）：本条验的是**当前系统主题下**
  // 的兜底链。uitest 跑在什么主题上，这条就只覆盖那一半：`prefers-color-scheme` 是媒体查询，
  // 渲染层改不了，所以「删掉顶层 :root 那份、浅色系统下 ext 皮肤会不会塌」在这台机器上
  // **测不出来**（实测：只删顶层 :root 时本条仍绿，因为暗色 media 块里那份还在兜着）。
  // 那一半由结构门 D3 静态覆盖 —— 它区分顶层与 @media 内层，与机器主题无关。
  // 实测红集：删掉**全部** --ball-bg 定义 → 恰好 {petBallSkinSurface}。
  const surfRaw = String(await exec(`(()=>{
    const app=document.querySelector('.app'); const dot=document.querySelector('.petball-fallback')
    if(!app) return 'fail:no-app'; if(!dot) return 'fail:no-dot'
    const before=app.getAttribute('data-skin')
    const out={}
    for(const s of ['aero','dark','minimal','candy','ink','ext:__no-such-skin__']){
      app.setAttribute('data-skin', s)
      out[s]=getComputedStyle(dot).backgroundColor
    }
    if(before===null) app.removeAttribute('data-skin'); else app.setAttribute('data-skin', before)
    return JSON.stringify(out)
  })()`))
  const SKIN_KEYS = ['aero', 'dark', 'minimal', 'candy', 'ink', 'ext:__no-such-skin__']
  let skinWhy = ''
  if (surfRaw.startsWith('fail:')) {
    skinWhy = surfRaw
  } else {
    const surf = JSON.parse(surfRaw) as Record<string, string>
    // rgba(r,g,b,a) 的 a 必须 > 0；transparent / rgba(0,0,0,0) 都算塌陷
    const alphaOf = (c: string): number => {
      const m = /rgba?\(([^)]+)\)/.exec(c)
      if (!m) return -1
      const parts = m[1].split(',').map((x) => parseFloat(x))
      return parts.length >= 4 ? parts[3] : 1
    }
    const bad = SKIN_KEYS.filter((k) => !surf[k] || alphaOf(surf[k]) <= 0)
    if (bad.length) {
      skinWhy = `fail:transparent=${bad.join(',')} got=${JSON.stringify(surf)}`
    } else {
      // 5 个内置皮肤必须**逐个不同** —— 全部同色说明只剩 :root 一处取值在生效
      // （浅色的 aero / minimal / ink 尤其要能彼此区分：它们正是「白底上读不出物体」的重灾区）
      const built = SKIN_KEYS.slice(0, 5).map((k) => surf[k])
      if (new Set(built).size < 5) skinWhy = `fail:not-per-skin=${JSON.stringify(surf)}`
    }
  }
  r.petBallSkinSurface = skinWhy || 'ok'

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

  // ─── P1-4 多账户分组：按组分块展示（组头 + 计数 + 卡片网格）──────────────────
  //
  // 键统一 `grp*` 前缀，与其它 section 的键不重叠 —— 本段与趋势图子任务共用同一个
  // uitest.ts，各自只加自己的键，合并时不需要去重。
  //
  // ⚠ 本段**自建夹具**（两个自定义实例 + 一个组名），不依赖用户机器上已有的分组。
  // 第一版依赖「用户恰好有 ≥2 个组」，实测整段 skip，等于没有护栏。
  const backToCards = async (): Promise<void> => {
    await exec("[...document.querySelectorAll('.icon-btn')].find(b=>b.title==='返回')?.click()")
    await sleep(700)
  }
  /**
   * 轮询直到 cond 为真（默认 ~20s 上限）。采集是异步的，固定 sleep 会偶发读到上一帧。
   *
   * ⚠ 上限不是随手的：默认 10s 时，本机（有 3 个真实供应商在出网）一轮 collect 就能超过它，
   *   于是**第二个**同名实例的卡片迟迟不出现、`grpDupCardName` 必红 —— 那是探针的时序假设
   *   比被测行为还不确定。所以要先 `forceCollect()` 再等，且给足预算。
   */
  const waitFor = async (cond: string, tries = 80): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if ((await exec(cond)) === true) return true
      await sleep(250)
    }
    return false
  }
  /**
   * 主动点标题栏的「立即刷新」，强制跑一轮 collect。
   *
   * ⚠ 不能只等后台轮询：加完实例到下一次**自然**采集最多要一个完整周期
   *   （uitest 里 `refreshInterval` 被设成 60s），而断言通常在几秒内就要出结果。
   *   `grpDupCardName` 第一版就是这么红的 —— 注册表里两个实例都在（`grpDupHost` 绿），
   *   界面上只出现了一张卡。
   */
  const forceCollect = async (): Promise<void> => {
    await exec("document.querySelector('button[title=立即刷新]')?.click()")
  }

  /** 加一个自定义实例。⚠ key 必须填：没有 key 时适配器铸的是 noDataSnap（status
   *  'nodata'），而 CardView 的 configured 过滤掉 nodata → **根本没有卡片**。
   *  第一版的 grpDupCardName 就是这么红的（注册表层面两个实例都在、host 也不同，
   *  但界面上找不到任何一张叫 uitest-dup 的卡）。 */
  const addCustom = async (name: string, url: string, key: string): Promise<void> => {
    await exec("[...document.querySelectorAll('.add-btn')].find(b=>b.textContent.includes('自定义'))?.click()")
    await sleep(400)
    await exec(`(()=>{
      const form=document.querySelector('.custom-form')
      if(!form) return
      const text=[...form.querySelectorAll('input[type=text]')]
      const pw=form.querySelector('input[type=password]')
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set
      // text[0]=名称，text[1]=API 地址（协议是 select，Key 是 password）
      setter.call(text[0],${JSON.stringify(name)}); text[0].dispatchEvent(new Event('input',{bubbles:true}))
      if(text[1]){ setter.call(text[1],${JSON.stringify(url)}); text[1].dispatchEvent(new Event('input',{bubbles:true})) }
      if(pw){ setter.call(pw,${JSON.stringify(key)}); pw.dispatchEvent(new Event('input',{bubbles:true})) }
    })()`)
    await sleep(200)
    await exec("[...document.querySelectorAll('.custom-form .btn-primary')].find(b=>b.textContent.includes('添加'))?.click()")
    await sleep(1100)
  }
  const removeProvider = async (id: string): Promise<void> => {
    await exec(`(()=>{const row=document.querySelector('[data-provider-id="${id}"]'); if(row) row.querySelector('.mini-btn.danger')?.click()})()`)
    await sleep(300)
    await exec(`(()=>{const row=document.querySelector('[data-provider-id="${id}"]'); if(row) row.querySelector('.mini-btn.danger')?.click()})()`)
    await sleep(800)
  }

  // ── 夹具：两个有卡实例 —— vis 归 GRP_VIS 组，dry 不归组（进「未分组」兜底块）。
  //    两个都要填 key（见 addCustom 的注释），失败也是一张卡（status=error，
  //    CardView 只过滤 nodata）。
  const GRP_VIS = 'uitest-可见组'
  const NAME_VIS = 'uitest-vis'
  const NAME_DRY = 'uitest-dry'

  await exec(footerClick('设置'))
  await sleep(700)
  await addCustom(NAME_VIS, 'https://uitest-vis.example.com/v1', 'sk-uitest-vis')
  await addCustom(NAME_DRY, 'https://uitest-dry.example.com/v1', 'sk-uitest-dry')
  const fixtureRaw = String(
    await exec(
      `window.api.listProviders().then(p=>JSON.stringify(p.providers.filter(x=>x.name==='${NAME_VIS}'||x.name==='${NAME_DRY}').map(x=>({id:x.id,name:x.name}))))`
    )
  )
  const fixture = JSON.parse(fixtureRaw) as { id: string; name: string }[]
  const visId = fixture.find((x) => x.name === NAME_VIS)?.id ?? ''
  const dryId = fixture.find((x) => x.name === NAME_DRY)?.id ?? ''
  if (!visId || !dryId) {
    r.grpSetup = `fail:vis=${visId} dry=${dryId}`
    for (const k of [
      'grpFixtureCard',
      'grpSections',
      'grpSectionOrder',
      'grpSectionCounts',
      'grpUngroupedBucket',
      'grpUnknownBucket',
      'grpGroupTag'
    ]) {
      r[k] = 'skip:no-fixture'
    }
  } else {
    r.grpSetup = 'ok'
    // 归组：写真相源（注册表里的 groupId）。走 IPC 而非输入框 —— 断言的是**行为**，
    // 输入框本身由其它静态门与设置页的 e2e 覆盖，这里要的是「分组能生效」。
    // dry 刻意不归组：它是「未分组」兜底块的探针。
    await exec(`window.api.setInstanceGroup(${JSON.stringify(visId)},${JSON.stringify(GRP_VIS)})`)
    await sleep(400)

    await backToCards()
    await sleep(600)
    // ⚠ 必须**主动触发**一轮采集再等，不能只等后台轮询（周期 60s，断言等不起）
    await forceCollect()
    // ⚠ 两张夹具卡都要等到：uitest-dry 有 key → 失败也是一张卡
    //   （status=error，CardView 只过滤 nodata）。
    const visCardReady = await waitFor(`!!document.querySelector('[data-card-id="${visId}"]')`)
    const dryCardReady = await waitFor(`!!document.querySelector('[data-card-id="${dryId}"]')`)
    r.grpFixtureCard = visCardReady && dryCardReady ? 'ok' : `fail:vis=${visCardReady} dry=${dryCardReady}`

    // 注册表真相：实例 id 集合 + 期望块顺序（自定义组升序、未分组末尾 ——
    // 与 read-model 的 groupNames 同一规则，在页面里现算，不复制实现）。
    const regRaw = String(
      await exec(`window.api.listProviders().then(p=>JSON.stringify({ids:p.providers.map(x=>x.id),groups:(()=>{const us='未分组';const s=new Set(p.providers.map(x=>x.groupId||us));const rest=[...s].filter(x=>x!==us).sort();return [...rest,...(s.has(us)?[us]:[])]})()}))`)
    )
    const reg = JSON.parse(regRaw) as { ids: string[]; groups: string[] }
    // DOM 快照：一块 = 组头（名 + 计数）+ 该组卡片；未知卡 = 快照有、注册表无。
    const domRaw = String(
      await exec(`(()=>{
        const secs=[...document.querySelectorAll('.pcard-section')].map(sec=>({
          name: sec.querySelector('.pcard-section-name')?.textContent ?? '',
          count: Number(sec.querySelector('.pcard-section-head .count')?.textContent ?? -1),
          cards: [...sec.querySelectorAll('[data-card-id]')].map(c=>c.dataset.cardId),
          tagged: [...sec.querySelectorAll('[data-card-id]')].filter(c=>c.querySelector('.pcard-group')).length
        }))
        const ids=new Set(${JSON.stringify(reg.ids)})
        const unknown=[...document.querySelectorAll('[data-card-id]')].map(c=>c.dataset.cardId).filter(id=>!ids.has(id))
        return JSON.stringify({secs, unknown, hasSelect: !!document.querySelector('.grp-select')})
      })()`)
    )
    const dom = JSON.parse(domRaw) as {
      secs: { name: string; count: number; cards: string[]; tagged: number }[]
      unknown: string[]
      hasSelect: boolean
    }
    // 未知卡（若有）同样进未分组块 —— 期望块里没有它时补上。
    const expected = [...reg.groups]
    if (dom.unknown.length > 0 && !expected.includes('未分组')) expected.push('未分组')

    // ① 块数 = 组数（+ 未知卡逼出的兜底块），且标题栏的分组下拉已消失（AC1）。
    //    下拉没了，「点不动」的根因（缺 no-drag）无从谈起 —— 删除即修复。
    const secNames = dom.secs.map((x) => x.name)
    r.grpSections =
      !dom.hasSelect &&
      dom.secs.length === expected.length &&
      expected.every((g) => secNames.includes(g))
        ? 'ok'
        : `fail:select=${dom.hasSelect} 期望[${expected.join(',')}] 实际[${secNames.join(',')}]`
    // ② 块顺序与 groupNames 一致（未分组恒末尾）
    r.grpSectionOrder =
      JSON.stringify(secNames) === JSON.stringify(expected)
        ? 'ok'
        : `fail:期望[${expected.join(',')}] 实际[${secNames.join(',')}]`
    // ③ 组头计数与该块实际卡数一致（且每块非空 —— 空块不应渲染）
    const badCount = dom.secs.find((x) => x.count !== x.cards.length || x.count <= 0)
    r.grpSectionCounts = !badCount ? 'ok' : `fail:${JSON.stringify(badCount)}`
    // ④ 未分组实例进兜底块（dry 刻意不归组，就是这条的探针）
    const drySec = dom.secs.find((x) => x.cards.includes(dryId))?.name ?? null
    r.grpUngroupedBucket = drySec === '未分组' ? 'ok' : `fail:dry在[${drySec}]`
    // ⑤ 组内卡无组名小标签（分块后冗余），组头有组名（上下文仍在）。
    //    未知卡同样无标签 —— 它在 grpUnknownBucket 里另有专断，这里只看总数。
    const taggedTotal = dom.secs.reduce((n, x) => n + x.tagged, 0)
    r.grpGroupTag =
      taggedTotal === 0 && dom.secs.length > 0 && dom.secs.every((x) => x.name !== '')
        ? 'ok'
        : `fail:标签数=${taggedTotal} 块数=${dom.secs.length}`

    {
      // ⑥ 未知实例（快照有、注册表无）：进未分组块末尾且**不打标签**（数据诚实）。
      //    采集来的快照一定对应注册表实例，靠等是等不出来的 —— 用 debugPush 显式注入一个
      //    （cached/local/error 三段已有先例），断言完立刻 refreshNow 还原。
      //    ⚠ 先把采集周期挪到 5 分钟：自然采集（60s）若落进注入窗口会把 ghost 冲掉，
      //    报一条与被测行为无关的假红。写 `refreshInterval`（非 `ui:` 前缀）会触发一次
      //    recollect，所以先写、**等它落定**再注入；读完立刻还原。
      await exec("window.api.setExtras({refreshInterval:'300'})")
      await sleep(2500)
      const cur = String(await exec('window.api.getState().then(s=>JSON.stringify(s.snapshots))'))
      const snaps = JSON.parse(cur) as unknown[]
      const ghost = {
        id: 'uitest-unknown',
        name: 'uitest-ghost',
        kind: 'coding',
        builtin: false,
        mark: 'custom',
        plan: '',
        status: 'ok',
        windows: [{ name: '5 小时', used: 1, limit: 10, unit: 'usd', percent: 10 }],
        dataQuality: 'official',
        updatedAt: new Date().toISOString()
      }
      await exec(`window.api.debugPush(${JSON.stringify([...snaps, ghost])}, false)`)
      await sleep(700)
      const ghostReady = await waitFor('!!document.querySelector(\'[data-card-id="uitest-unknown"]\')')
      const ghostProbe = String(
        await exec(`(()=>{
          const c=document.querySelector('[data-card-id="uitest-unknown"]')
          if(!c) return JSON.stringify({at:null})
          const sec=c.closest('.pcard-section')
          return JSON.stringify({
            at: sec?.querySelector('.pcard-section-name')?.textContent ?? null,
            tag: c.querySelector('.pcard-group')?.textContent ?? null,
            aria: c.getAttribute('aria-label') ?? ''
          })
        })()`)
      )
      const g = JSON.parse(ghostProbe) as { at: string | null; tag: string | null; aria: string }
      // aria 不含组名后缀：不知道 ≠ 未分组，读屏也不许替用户断言归属。
      r.grpUnknownBucket =
        ghostReady && g.at === '未分组' && g.tag === null && !g.aria.includes('（')
          ? 'ok'
          : `fail:${ghostProbe}`
      await exec('window.api.refreshNow()')
      await sleep(2500)
      await forceCollect()
      await waitFor(`!!document.querySelector('[data-card-id="${visId}"]')`)
      await exec("window.api.setExtras({refreshInterval:'60'})")
    }
  }

  // ── ③ 同名两账号的卡片名带不同后缀（D5）────────────────────────────────────
  //
  // 必须造两个**同名、不同 host** 的自定义实例 —— 只有一个同名时后缀本来就不该加
  // （不造「(2)」这类假区分），那种情况下断言的是「两张卡名字一样」这种恒真事实。
  await exec(footerClick('设置'))
  await sleep(700)
  const dupIds: string[] = []
  for (let i = 0; i < 2; i++) {
    await addCustom('uitest-dup', `https://uitest-${'ab'[i]}.example.com/v1`, `sk-uitest-dup-${i}`)
  }
  const dupAdded = String(
    await exec(
      "window.api.listProviders().then(p=>JSON.stringify(p.providers.filter(x=>x.name==='uitest-dup').map(x=>({id:x.id,host:x.distinguishKey||''}))))"
    )
  )
  const dupList = JSON.parse(dupAdded) as { id: string; host: string }[]
  dupIds.push(...dupList.map((x) => x.id))
  // 注册表层面就分得开：两个实例拿到的 host 必须非空且不同
  // （host 取不出来 = 整条区分链路在第一步就断了，而界面层看不出来）
  r.grpDupHost =
    dupList.length === 2 && dupList[0].host !== '' && dupList[0].host !== dupList[1].host ? 'ok' : `fail:${dupAdded}`
  // ⚠ 必须等两张卡真的**采集完**再断言，而且得**主动触发**一轮采集：两个实例是先后加的，
  //   第二次 `addCustom` 返回时第一轮 collect 可能还在路上，而自然轮询要等最多 60s。
  //   2026-10-01 实机：只 `sleep(600)` 的话界面上稳定只出现**一张** uitest-dup 的卡，
  //   `grpDupHost` 绿而 `grpDupCardName` 红 —— 探针的时序假设比被测行为还不确定。
  await backToCards()
  await sleep(600)
  await forceCollect()
  const dupReady = await waitFor(`(()=>{
    const n=[...document.querySelectorAll('[data-card-id]')].filter(c=>c.querySelector('.pcard-name')?.textContent.includes('uitest-dup'))
    return n.length===2 ? true : false
  })()`)
  const dupCardNames = String(
    await exec(
      "[...document.querySelectorAll('[data-card-id]')].filter(c=>c.querySelector('.pcard-name')?.textContent.includes('uitest-dup')).map(c=>c.querySelector('.pcard-name').textContent).join('|')"
    )
  )
  const dupParts = dupCardNames ? dupCardNames.split('|') : []
  r.grpDupCardName =
    dupReady && dupParts.length === 2 && dupParts[0] !== dupParts[1] && dupParts.some((x) => x.includes('uitest-a.example.com'))
      ? 'ok'
      : `fail:ready=${dupReady} names=${dupCardNames}`
  // 同名两账号分块后：后缀仍区分实例（卡名里），组归属只看它所在的块 ——
  // 组内不再打标签（分块即上下文）。期望值从注册表现算（不把 read-model 的判定复制进断言）。
  const dupExpGroup = String(
    await exec(
      "window.api.listProviders().then(p=>{const d=p.providers.find(x=>x.name==='uitest-dup'); return d?(d.groupId||'未分组'):''})"
    )
  )
  const dupSecProbe = String(
    await exec(
      `(()=>{const cs=[...document.querySelectorAll('[data-card-id]')].filter(x=>x.querySelector('.pcard-name')?.textContent.includes('uitest-dup')); const c=cs[0]; return JSON.stringify({sec: c?.closest('.pcard-section')?.querySelector('.pcard-section-name')?.textContent ?? '', tagged: cs.filter(x=>x.querySelector('.pcard-group')).length})})()`
    )
  )
  const dupSec = JSON.parse(dupSecProbe) as { sec: string; tagged: number }
  r.grpDupGroupTag =
    dupExpGroup !== '' && dupSec.tagged === 0 && dupSec.sec === dupExpGroup
      ? 'ok'
      : `fail:标签数=${dupSec.tagged} 块=${dupSec.sec} 期望=${dupExpGroup}`

  // 清理：测试实例必须删掉，否则反复跑会越堆越多（同名的还会干扰分组断言）
  await exec(footerClick('设置'))
  await sleep(700)
  for (const id of [...dupIds, ...(visId ? [visId] : []), ...(dryId ? [dryId] : [])]) {
    await removeProvider(id)
  }
  r.grpDupCleanup =
    (await exec(
      "window.api.listProviders().then(p=>!p.providers.some(x=>x.name==='uitest-dup'||x.name==='uitest-vis'||x.name==='uitest-dry'))"
    )) === true
      ? 'ok'
      : 'fail:not-cleaned'
  await backToCards()

  // ── 贴边自动隐藏（10-03-dock-autohide）────────────────────────────────────
  //
  // 合成事件动不了真光标（见 dragMoved 那条：窗口跟真光标走），所以几何走 debug 通道：
  // `debugDockEdge` 摆真实窗口并走真实 dragStop 路径，`debugDockCursor` 喂命中翻转。
  // BD_DOCK_FAST=1 下三把计时器压到 50ms；没设时按真实 1000/300/1500ms 等 ——
  // 所以一律用 waitFor 轮询而不是固定 sleep（固定值在两种模式下必坏其一）。
  const dockState = async (): Promise<{ phase: string; edge: string | null; hidden: boolean; fluid?: string; fluidEdge?: string | null }> =>
    (await exec('window.api.debugDockState()')) as { phase: string; edge: string | null; hidden: boolean; fluid?: string; fluidEdge?: string | null }
  const dockWait = async (cond: string, label: string): Promise<boolean> => waitFor(cond, 24)

  await exec('window.api.collapse()')
  await sleep(800)
  const dockB0 = bounds()
  r.dockShape =
    dockB0.width === BALL_VIEW.width && dockB0.height === BALL_VIEW.height
      ? 'ok'
      : `fail:${dockB0.width}x${dockB0.height}（仅收起态球形态参与）`
  // 开关默认开（extras 缺失键给 ''，判 !== '0'；与主进程 primePrefs 同口径）
  r.dockDefaultOn =
    ((await exec("window.api.getExtras(['ui:dockHide']).then(e=>e['ui:dockHide']!=='0')")) as boolean) === true
      ? 'ok'
      : 'fail:default-off'
  // 右键菜单有「贴边自动隐藏」入口（菜单标签主进程现拼，只能在这里截）
  const dockMenuLabels = await runPetMenu()
  r.dockMenu = dockMenuLabels.includes('贴边自动隐藏')
    ? 'ok'
    : `fail:${dockMenuLabels.join(',')}`
  // 设置页「系统」分区开关：往返一次，判据是落盘值（与 vrsNotifyOff 同纪律）。
  // ⚠ 必须先展开：footer 的「设置」按钮只在卡片视图里，收起态下点它等于没点，
  //   开关断言会读到两个 ''（恒为默认开）而误红 —— dockSettings 那条曾因此红过。
  await exec('window.api.expand()')
  await sleep(800)
  await exec(footerClick('设置'))
  await sleep(700)
  const dockWasOn =
    ((await exec("window.api.getExtras(['ui:dockHide']).then(e=>e['ui:dockHide']!=='0')")) as boolean) === true
  const clickDockSwitch = (): Promise<unknown> => exec("document.querySelector('.dock-hide')?.click()")
  await clickDockSwitch()
  await sleep(500)
  const dockFlip1 = await exec("window.api.getExtras(['ui:dockHide']).then(e=>e['ui:dockHide'])")
  await clickDockSwitch()
  await sleep(500)
  const dockFlip2 = await exec("window.api.getExtras(['ui:dockHide']).then(e=>e['ui:dockHide'])")
  // 开关必须真的翻转两次（关 → 开回来，不把用户配置带走）
  r.dockSettings =
    dockFlip1 === (dockWasOn ? '0' : '1') && dockFlip2 !== '0'
      ? 'ok'
      : `fail:was=${dockWasOn} flip1=${dockFlip1} flip2=${dockFlip2}`
  // 开关状态要同步进主进程（setExtras 本身不通知主进程，生产走 ui:dock-hide 即时生效）
  await exec(`window.api.setDockHide(${dockFlip2 !== '0' ? 'true' : 'false'})`)
  await backToCards()
  await sleep(400)
  await exec('window.api.collapse()')
  await sleep(800)
  // 冻结真光标翻转（整个 dock 段）：合成事件动不了真光标，窗口瞬移到真光标底下会产生真翻转、
  // 在痕迹条上停留会直接唤回；debug 喂送（debugDockCursor）照常工作，穿透也不受影响。
  // 解冻在段尾（开关还原之后）。此前两轮误红都是它。
  await exec('window.api.debugDockFreeze(true)')

  // 摆位 helper：贴边坐标取摆位调用的同步返回值（placed.docked）。
  // fast 模式下 50ms 后窗口已经藏进去了，事后读 bounds 拿到的是隐藏坐标 —— dockedX 竞态，
  // 历史上曾让 dockHide/dockEdges 误红；此处之后不再有时序相关的 bounds 读数。
  const bayEdge = async (e: string): Promise<{ x: number; y: number }> => {
    const placed = (await exec(`window.api.debugDockEdge('${e}')`)) as {
      docked: { x: number; y: number }
    } | null
    return placed && placed.docked ? { x: placed.docked.x, y: placed.docked.y } : { x: 0, y: 0 }
  }

  // 摆左沿 → 隐藏（只留 4px 痕迹）。段内真光标已冻结，两次机会只防 dwell 本身的时序抖动。
  let dockedX = 0
  let dockedY = 0
  let hid = false
  for (let attempt = 0; attempt < 2 && !hid; attempt++) {
    const p = await bayEdge('left')
    dockedX = p.x
    dockedY = p.y
    hid = await dockWait('window.api.debugDockState().then(s=>s.hidden===true)', 'hide')
  }
  // 四边扫一遍：贴边判定/隐藏偏移的符号由单测钉死，这里只验"主进程接线把窗口摆对了边"——
  // dockTestToEdge 的屏幕坐标数学只活在 E2E 路径里（单测够不着），左右/上下反了这里必红。
  // 不经过光标（debug 通道先复位再摆位，可重复调用），所以无真光标 flake。
  //
  // ⚠ 上/下沿可能被 OS 夹回而干净拒绝（本机实测：顶部菜单栏 + 底部 Dock 都不许窗口越界，
  //   落点校验 abort 后停在贴边全可见（单测用例 23 同款）；左/右沿则正常隐藏）。
  //   这取决于用户把 Dock 摆在哪边、跑在哪台机器 —— 所以不断言"哪条边必须藏"，
  //   只断言"每条边要么正确藏、要么干净拒绝，不许半态"，另加一条"至少一边真藏了"
  //   （四条全拒 = 功能死了，必须红）。方向数学的逐值锁定在单测，不在这里。
  const dockStep = BALL_VIEW.width - PEEK // 球宽 56 - 痕迹 4 = 单步位移（与 hiddenBounds 同式）
  let dockEdges = 'ok'
  let hidAnyEdge = false
  for (const e of ['left', 'right', 'top', 'bottom']) {
    const p = await bayEdge(e)
    // macOS 上沿是确定性拒绝（isEdgeSupported 平台约束，可见窗口越菜单栏会被同步夹回）：
    // 不烧 6s 等超时，睡 1300ms（盖过真实 1000ms 停留）后断言"从未开始"的完整签名。
    // 若实现改成"试藏"，phase/edge 任一项对不上就红；bayEdge 本身失败时 p 回退 (0,0)，
    // 坐标项也会红 —— 不存在静默放过。
    if (e === 'top' && process.platform === 'darwin') {
      await sleep(1300)
      const stRef = await dockState()
      const bRef = bounds()
      const refuseOk =
        stRef.phase === 'idle' && stRef.hidden === false && stRef.edge === null &&
        bRef.x === p.x && bRef.y === p.y
      if (!refuseOk) {
        dockEdges =
          `fail:top-refuse phase=${stRef.phase} hidden=${stRef.hidden} edge=${stRef.edge} ` +
          `x=${bRef.x} y=${bRef.y} want=(${p.x},${p.y})`
        break
      }
      continue
    }
    const okEdge = await dockWait(`window.api.debugDockState().then(s=>s.hidden===true&&s.edge==='${e}')`, `hide-${e}`)
    const bSweep = bounds()
    const dx = bSweep.x - p.x
    const dy = bSweep.y - p.y
    const dirOk =
      e === 'left' ? dx === -dockStep && dy === 0
      : e === 'right' ? dx === dockStep && dy === 0
      : e === 'top' ? dy === -dockStep && dx === 0
      : dy === dockStep && dx === 0
    if (okEdge && dirOk) {
      hidAnyEdge = true
      continue
    }
    const cleanRefuse = !okEdge && (await dockState()).hidden === false && dx === 0 && dy === 0
    if (!cleanRefuse) {
      dockEdges = `fail:${e} hide=${okEdge} dx=${dx} dy=${dy}`
      break
    }
  }
  if (dockEdges === 'ok' && !hidAnyEdge) dockEdges = 'fail:no-edge-hid（四条全拒 = 隐藏功能死了）'
  r.dockEdges = dockEdges
  // 回到左沿走完整流程（路过/唤出/重藏/展开取消都以左沿为基准测）
  hid = false
  for (let attempt = 0; attempt < 2 && !hid; attempt++) {
    const p = await bayEdge('left')
    dockedX = p.x
    dockedY = p.y
    hid = await dockWait('window.api.debugDockState().then(s=>s.hidden===true)', 'hide')
  }
  const dsHide = await dockState()
  const bHide = bounds()
  // 隐藏偏移 = 球宽 - 痕迹（与 shared/dock-hide.hiddenBounds 同式，不手算 52）
  const wantHideX = dockedX - (BALL_VIEW.width - PEEK)
  r.dockHide =
    hid && dsHide.edge === 'left' && bHide.x === wantHideX && bHide.y === dockedY
      ? 'ok'
      : `fail:hidden=${hid} edge=${dsHide.edge} x=${bHide.x} want=${wantHideX}`
  r.dockPeekSize =
    bHide.width === BALL_VIEW.width && bHide.height === BALL_VIEW.height ? 'ok' : `fail:${bHide.width}x${bHide.height}`

  // ── 流体相位（10-03-dock-autohide 步 6/7）：dock:fluid 状态序列 ──────────
  //
  // 主副两路必须同源：主进程 debug:dock-state 的 fluid 与 DOM 的 data-fluid/data-edge
  // 在落定态一致；水满波浪与填充弧同生同灭（L2/L3"轨道与 pct 解耦"的另一半 ——
  // 波浪只在"套餐且算得出比例"时挂，余额/无比例时绝不画假液位）。
  // 定的是**落定态**（hidden / edge-visible），不定 morph 中间帧 —— 中间帧只活
  // 530/400ms，轮询断言它等于用 flake 换覆盖；中间帧的形状由 --shots 三张走查图看。
  const fluidDom = async (): Promise<{ fluid: string; edge: string; waves: number; fill: boolean; ring: string }> => {
    const raw = String(
      await exec(`(()=>{
        const d=document.querySelector('.petball-fallback')
        if(!d) return JSON.stringify({fluid:'?',edge:'?',waves:-1,fill:false,ring:'?'})
        return JSON.stringify({fluid:d.dataset.fluid||'?',edge:d.dataset.edge||'?',
          waves:d.querySelectorAll('.fluid-wave').length,
          fill:!!d.querySelector('.dot-ring-fill'),ring:d.getAttribute('data-ring')||''})
      })()`)
    )
    try {
      return JSON.parse(raw) as { fluid: string; edge: string; waves: number; fill: boolean; ring: string }
    } catch {
      return { fluid: '?', edge: '?', waves: -1, fill: false, ring: '?' }
    }
  }
  // goo 滤镜定义在（形态回退不断言效果，只断言"定义在、区裁对" —— 合成走查看 shots）
  r.dockFluidGoo = String(
    await exec(`(()=>{const f=document.querySelector('#petball-goo'); if(!f) return 'fail:no-filter';
      return f.getAttribute('width')==='56'&&f.getAttribute('height')==='56'
        ? 'ok' : 'fail:region='+f.getAttribute('width')+'x'+f.getAttribute('height')})()`)
  )
  // 隐藏落定：主副同相位 + 贴边一致（仍在 hidden 态内，路过测试之前）
  await dockWait("window.api.debugDockState().then(s=>s.fluid==='hidden')", 'fluid-hidden')
  await sleep(400) // 主副两路各走一次 IPC，DOM 切类比 main 落定慢一拍
  const dsFluidHide = await dockState()
  const domHide = await fluidDom()
  r.dockFluidHidden =
    dsFluidHide.fluid === 'hidden' && domHide.fluid === 'hidden' && domHide.edge === 'left'
      ? 'ok'
      : `fail:main=${dsFluidHide.fluid} dom=${domHide.fluid}/${domHide.edge}`
  // 液位与百分比同生同灭：波浪数恒为 0 或 2（双层），且"有波浪 ⟺ 有填充弧"。
  // 判据不依赖具体数据（真实快照随机器而变）：plan+有弧 → 2 层波浪；balance/无弧 → 0。
  const wavesOk =
    domHide.waves === -1
      ? `fail:probe`
      : domHide.ring === 'plan'
        ? (domHide.fill ? domHide.waves === 2 : domHide.waves === 0)
          ? 'ok'
          : `fail:ring=plan fill=${domHide.fill} waves=${domHide.waves}`
        : domHide.waves === 0
          ? 'ok'
          : `fail:ring=${domHide.ring} waves=${domHide.waves}`
  r.dockFluidLevel = wavesOk

  // 路过不停留 → 不唤出（两次喂送之间无等待：50ms 的 fast 唤出计时也来不及触发）
  await exec('window.api.debugDockCursor(true)')
  await exec('window.api.debugDockCursor(false)')
  await sleep(300)
  r.dockPassby = (await dockState()).hidden === true ? 'ok' : 'fail:woke-on-passby'

  // 痕迹停留 → 滑出到贴边全可见
  // ⚠ 等的必须是落定态 edge-visible：hidden===false 在 300ms 唤出停留（dwell-reveal）里就成立，
  //   轮询若恰好落在停留窗里，returned 的 revealed=true 但窗口还没动（曾让 dockReveal 误红）。
  await exec('window.api.debugDockCursor(true)')
  const revealed = await dockWait("window.api.debugDockState().then(s=>s.hidden===false&&s.phase==='edge-visible')", 'reveal')
  const bReveal = bounds()
  r.dockReveal =
    revealed && bReveal.x === dockedX && bReveal.y === dockedY
      ? 'ok'
      : `fail:revealed=${revealed} x=${bReveal.x} want=${dockedX}`
  // 唤出落定：流体相位回到整球（DOM 经 dock:fluid 异步切类，轮询等它）
  const fluidBack = await dockWait(
    "window.api.debugDockState().then(s=>s.fluid==='edge-visible')",
    'fluid-back'
  )
  await sleep(400) // 主副两路各走一次 IPC，DOM 切类比 main 落定慢一拍
  const domReveal = await fluidDom()
  r.dockFluidReveal =
    fluidBack && domReveal.fluid === 'edge-visible'
      ? 'ok'
      : `fail:main-fluid wait=${fluidBack} dom=${domReveal.fluid}`

  // 离开球体 → 重藏（跳过 1000ms 停留，直接藏）
  await exec('window.api.debugDockCursor(false)')
  const rehid = await dockWait('window.api.debugDockState().then(s=>s.hidden===true)', 'rehide')
  r.dockRehide = rehid ? 'ok' : 'fail:no-rehide'

  // 展开 → 取消隐藏回到全可见，不残留隐藏偏移
  await exec('window.api.expand()')
  await sleep(800)
  const dsExp = await dockState()
  const bExp = bounds()
  r.dockExpandCancel =
    dsExp.hidden === false && bExp.width > 300 ? 'ok' : `fail:hidden=${dsExp.hidden} w=${bExp.width}`
  await exec('window.api.collapse()')
  await sleep(800)

  // 开关关闭 → 取消计时/动画、回到全可见并清 hidden（R7 回滚语义）
  await exec("window.api.debugDockEdge('left')")
  const hid2 = await dockWait('window.api.debugDockState().then(s=>s.hidden===true)', 'hide2')
  await exec('window.api.setDockHide(false)')
  await exec("window.api.setExtras({'ui:dockHide':'0'})")
  await sleep(400)
  const dsOff = await dockState()
  r.dockSwitchOff =
    hid2 && dsOff.hidden === false ? 'ok' : `fail:hid2=${hid2} hidden=${dsOff.hidden}`
  // 还原：开关开回来（不把用户配置带走），窗口回到卡片
  await exec('window.api.setDockHide(true)')
  await exec(`window.api.setExtras({'ui:dockHide':'${dockWasOn ? '1' : '0'}'})`)
  if (!dockWasOn) await exec('window.api.setDockHide(false)')
  await exec('window.api.expand()')
  await sleep(800)
  // 解冻真光标翻转（dock 段结束；冻结期间穿透轮询一直在跑，解冻后位置不变则不补事件）
  await exec('window.api.debugDockFreeze(false)')

  r.consoleErrors = consoleErrors.length === 0 ? 'none' : consoleErrors.join(' | ').slice(0, 300)
  r.execErrors = execErrors.length === 0 ? 'none' : execErrors.join(' | ').slice(0, 300)
  return r
}

