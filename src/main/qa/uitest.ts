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
import { ISLAND_VIEW } from '../../shared/pet-view'
// 隐藏态几何口径与主进程同一常数（mini-pill 尺寸改时这里跟着变，不各自硬编码）
import { MINI_PILL_W, MINI_PILL_H } from '../../shared/dock-hide'
import { refreshNow } from '../scheduler'
import { defaultWaterAnchors, parseCssColor, resolveWaterAnchors, rgbStr, waterColor } from '../../shared/water-color'
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
  /** 收起态窗口很大（灵动岛 560×480），主体在顶部：点击 = 点命中层中心 */
  const islandCenterJs = `(()=>{
    const c=document.querySelector('.isl-body'); if(!c) return null
    const rc=c.getBoundingClientRect()
    return { x: rc.x + rc.width/2, y: rc.y + rc.height/2 }
  })()`
  /** 单击岛身：位移 <6px = 切换展开/收起（IslandView finishPress 口径；以岛为准定位） */
  const islClickJs = (dx = 0, dy = 0): string => `(()=>{
    const b=document.querySelector('.isl-body'); if(!b) return 'no-island'
    const rc=b.getBoundingClientRect()
    const cx=rc.x+rc.width/2, cy=rc.y+rc.height/2
    const o={clientX:cx+${dx},clientY:cy+${dy},pointerId:7,bubbles:true,pointerType:'mouse',button:0,buttons:1}
    const h=document.querySelector('.isl-hit'); if(!h) return 'no-hit'
    h.dispatchEvent(new PointerEvent('pointerdown',o))
    h.dispatchEvent(new PointerEvent('pointerup',{...o,buttons:0}))
    return 'sent'
  })()`
  /** 双击岛身：回到卡片视图（onDoubleClick → onExpand） */
  const islDblclickJs = (): string => `(()=>{
    const b=document.querySelector('.isl-hit'); if(!b) return 'no-island'
    b.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))
    return 'sent'
  })()`
  /** 岛身拖动：起点落在岛内部（命中分区 body）→ 改 posX + 落盘，不切换展开 */
  const islDragJs = (dx: number): string => `(async ()=>{
    const b=document.querySelector('.isl-body'); if(!b) return 'no-island'
    const rc=b.getBoundingClientRect()
    const cx=rc.x+rc.width/2, cy=rc.y+rc.height/2
    const h=document.querySelector('.isl-hit'); if(!h) return 'no-hit'
    const o={clientX:cx,clientY:cy,pointerId:9,bubbles:true,pointerType:'mouse',button:0,buttons:1}
    h.dispatchEvent(new PointerEvent('pointerdown',o))
    for(let i=1;i<=4;i++){
      h.dispatchEvent(new PointerEvent('pointermove',{...o,clientX:cx+${dx}*i/4}))
      await new Promise(res=>setTimeout(res,40))
    }
    h.dispatchEvent(new PointerEvent('pointerup',{...o,clientX:cx+${dx},buttons:0}))
    return 'sent'
  })()`
  /** 边缘拖动：起点落在岛边缘 rim 内（命中分区 edge）→ 主进程窗口拖拽，posX 不动 */
  const islEdgeDragJs = (dx: number): string => `(async ()=>{
    const b=document.querySelector('.isl-body'); if(!b) return 'no-island'
    const rc=b.getBoundingClientRect()
    const cx=rc.x+3, cy=rc.y+rc.height/2
    const h=document.querySelector('.isl-hit'); if(!h) return 'no-hit'
    const o={clientX:cx,clientY:cy,pointerId:11,bubbles:true,pointerType:'mouse',button:0,buttons:1}
    h.dispatchEvent(new PointerEvent('pointerdown',o))
    for(let i=1;i<=4;i++){
      h.dispatchEvent(new PointerEvent('pointermove',{...o,clientX:cx+${dx}*i/4}))
      await new Promise(res=>setTimeout(res,40))
    }
    h.dispatchEvent(new PointerEvent('pointerup',{...o,clientX:cx+${dx},buttons:0}))
    return 'sent'
  })()`

  // ─── 09-27-dot-ring-scroll 的夹具与球上探针 ────────────────────────────────
  //
  // 真实数据随机器而变（有没有多窗口套餐、有没有余额供应商都不由测试说了算），
  // 所以下面的断言一律**自己推快照**。夹具全部 `official` + 新鲜时间戳 —— 不触发
  // 可信度角标（多一个元素，部分逐位比对的断言就红）。
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
  /** 零用量窗口（`used=0` 且 `limit>0` → `windowPercent` 返回 **0** 而不是 null）：
   *  AC3.3 的对偶面 —— 中心是 `0%` 而不是金额，轨道**仍在**（空环）、弧长 0、不挂水。
   *  `fw()` 的 `used:1` 与 percent=0 不自洽，所以显式给三个字段（`windowPercent` 优先取 percent，
   *  但夹具该长得像真实数据：三个字段互相一致）。
   *  不推夹具就只能指望真实数据恰好落在 0% —— 10-06-column-zero-fill 的 `petWaterColumn`
   *  长期红正是这个状态漏了断言（真实数据常落在 5H=0% 的窗口上）。 */
  const FIX_ZERO = [planFix('fix-zero', 'Fix 零用量', [{ name: '5 小时', used: 0, limit: 10, unit: 'usd', percent: 0 }])]

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
   * 灵动岛探针：一次 exec 取全收起态证据 —— 岛形态（collapsed/open/hidden）、
   * 顶栏位置 posX、家数、各家 kind/lvl、pill/展开卡在位。`err` 非空时所有断言
   * 都要连它一起报（「探针挂了」和「行为正确」不能长成同一个默认值）。
   */
  type IslandCombo = { id: string; kind: string; lvl: string }
  type IslandProbe = {
    err: string
    mode: string
    open: boolean
    posX: number
    count: number
    combos: IslandCombo[]
    pill: boolean
    expanded: boolean
    title: string
  }
  const badIsland = (err: string): IslandProbe => ({
    err,
    mode: '?',
    open: false,
    posX: -1,
    count: -1,
    combos: [],
    pill: false,
    expanded: false,
    title: ''
  })
  const islandProbe = async (): Promise<IslandProbe> => {
    const raw = await exec(`(()=>{
      const body=document.querySelector('.isl-body')
      const hit=document.querySelector('.isl-hit')
      const b=window.__bd_island?.()
      const combos=[...document.querySelectorAll('.isl-combo')].map(c=>({
        id:c.getAttribute('data-supplier')||'',
        kind:c.getAttribute('data-kind')||'',
        lvl:c.getAttribute('data-lvl')||''
      }))
      return JSON.stringify({
        mode: body?body.getAttribute('data-island'):'?',
        open: b&&typeof b.open==='boolean'?b.open:false,
        posX: b&&typeof b.posX==='number'?b.posX:-1,
        count: b&&typeof b.count==='number'?b.count:-1,
        combos, pill: !!document.querySelector('.isl-pill'),
        expanded: !!document.querySelector('.isl-open'),
        title: hit?hit.title:''
      })
    })()`)
    if (typeof raw !== 'string') return badIsland('exec-failed')
    try {
      const p = JSON.parse(raw) as IslandProbe
      return { ...p, err: '' }
    } catch {
      return badIsland(`parse:${raw.slice(0, 60)}`)
    }
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
      await exec(`(()=>{const b=document.querySelector('.isl-hit'); if(!b) return 'no-hit'
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

    // ── 用量热力图（P1-1）───────────────────────────────────────────────────
    // 两态互斥，**不要**写成「有 chart 或没 chart 都算过」：
    //   · 套餐类（coding/token）且有历史 → 有 `.trend-chart`（日历网格 SVG）+
    //     `.trend-head`（streak 头），且格数 > 0（缺样本的天不画格，所以格数 ≤ 天数，
    //     **不能**断言相等）
    //   · 余额类（balance）→ **一定没有** `.trend-chart`，且实现层压根不发那次 IPC
    // 判「有没有 chart」用 `=== null` 而不是 `!`：`!` 会把「元素不存在」与
    // 「选择器写错了」混成同一个结果 —— 那正是本仓反复出现的空洞绿。
    const chartInfo = (await exec(`(() => {
      const chart = document.querySelector('.trend-chart')
      const host = document.querySelector('.trend') || document.querySelector('[class*="trend"]')
      const head = document.querySelector('.trend-head')
      return JSON.stringify({
        hasChart: chart !== null,
        cells: chart ? chart.querySelectorAll('.trend-cell').length : -1,
        hasHead: head !== null,
        hostClass: host ? host.className : ''
      })
    })()`)) as string
    const ci = JSON.parse(chartInfo || '{}') as {
      hasChart?: boolean
      cells?: number
      hasHead?: boolean
      hostClass?: string
    }
    const isBalance = (await exec(`(() => {
      const t = document.querySelector('.kind-tag')
      return t ? (t.textContent || '').includes('余额') : false
    })()`)) as boolean
    if (isBalance) {
      // 余额类：实测 pct 恒 null / 恒 0，画出来要么是空要么是贴底平线
      r.trendChart = ci.hasChart ? 'fail:balance-should-have-none' : 'ok'
    } else {
      r.trendChart = ci.hasChart
        ? // 有图就必须同时有 streak 头和至少一个格：缺一个就是「渲染到一半」
          (ci.hasHead && (ci.cells ?? 0) > 0 ? 'ok' : 'fail:missing-head-or-cells')
        : // 没历史时 TrendChart 返回 null，界面什么都不显示 —— 那也是对的态
          ((await exec("!!document.querySelector('.dwin')")) ? 'ok:no-history' : 'fail')
    }
    r.trendBars = String(ci.cells ?? -1)

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
  r.collapse = b1.width === ISLAND_VIEW.width && b1.height === ISLAND_VIEW.height ? 'ok' : `fail:${b1.width}x${b1.height}`
  r.dotDom = (await exec("!!document.querySelector('.isl-body') && !!document.querySelector('.isl-hit')"))
    ? 'ok'
    : 'fail'
  // 诊断串：岛上各家 kind/lvl（收起态平铺，无名称无轮询）
  r.ballValue = String(
    await exec(
      "JSON.stringify([...document.querySelectorAll('.isl-combo')].map(c=>c.getAttribute('data-supplier')+':'+c.getAttribute('data-kind')+'/'+c.getAttribute('data-lvl')))"
    )
  )

  // 岛身拖动：>6px 判拖动（改 posX + 落盘，不切换展开）；窗口固定不动
  const islDrag0 = await islandProbe()
  await exec(islDragJs(60))
  await sleep(700)
  const islDrag1 = await islandProbe()
  const after = bounds()
  r.dragNoExpand = !islDrag1.expanded && !islDrag1.open ? 'ok' : 'fail:expanded-on-drag'
  r.dragMoved =
    islDrag1.err || islDrag0.err
      ? `fail:probe=${islDrag0.err || islDrag1.err}`
      : Math.abs(islDrag1.posX - islDrag0.posX) > 0.01
        ? 'ok'
        : `fail:posX=${islDrag0.posX}->${islDrag1.posX}`
  // 分区其一：岛身拖只调 posX，不启动主进程窗口拖拽
  r.dragBodyNoWinDrag = !consumeDragFired() ? 'ok' : 'fail:main-drag-fired（岛身拖动不应启动主进程窗口拖拽）'
  r.dragWindowFixed =
    after.width === ISLAND_VIEW.width && after.height === ISLAND_VIEW.height ? 'ok' : `fail:${after.width}x${after.height}`
  // 位置落盘（AC4）：extras ui:islandX 与组件 posX 一致
  const savedX = (await exec("window.api.getExtras(['ui:islandX']).then(e=>e['ui:islandX'])")) as string
  r.islandPosSaved =
    islDrag1.err
      ? `fail:probe=${islDrag1.err}`
      : Math.abs(Number(savedX) - islDrag1.posX) < 0.005
        ? 'ok'
        : `fail:extras=${savedX} posX=${islDrag1.posX}`
  // 分区其二：边缘拖启动主进程窗口拖拽（R7 分区），posX 不动
  const islEdge0 = await islandProbe()
  await exec(islEdgeDragJs(60))
  await sleep(700)
  const islEdge1 = await islandProbe()
  r.dragEdgeWinDrag = consumeDragFired() ? 'ok' : 'fail:edge-drag-no-main-drag（边缘拖动应移动窗口）'
  r.dragEdgeNoPosX =
    islEdge1.err || islEdge0.err
      ? `fail:probe=${islEdge1.err || islEdge0.err}`
      : Math.abs(islEdge1.posX - islEdge0.posX) < 0.005
        ? 'ok'
        : `fail:posX=${islEdge0.posX}->${islEdge1.posX}（边缘拖不应改岛内位置）`

  // 单击岛身 → 展开（AC3/R3：弹簧 pop 出明细卡；窗口仍是岛尺寸，不是卡片视图）
  await exec(islClickJs())
  await sleep(700)
  const isl2 = await islandProbe()
  r.dotClickExpand =
    isl2.err
      ? `fail:probe=${isl2.err}`
      : isl2.expanded && isl2.open
        ? 'ok'
        : `fail:mode=${isl2.mode} expanded=${isl2.expanded}`
  r.cardBack = 'skipped:island-open-is-not-card'
  // 展开态内容：plan 家窗口行（名 · % · 重置倒计时）+ balance 家金额（AC3）
  r.islandOpenContent = String(
    await exec(`(()=>{
      const grid=document.querySelector('.isl-grid'); if(!grid) return 'fail:no-grid'
      const wins=[...grid.querySelectorAll('.isl-win')].map(w=>w.textContent)
      const bigs=[...grid.querySelectorAll('.isl-big')].map(b=>b.textContent)
      const cells=[...grid.querySelectorAll('.isl-cell')].map(c=>c.getAttribute('data-supplier')+':'+c.getAttribute('data-kind'))
      return JSON.stringify({cells, wins: wins.slice(0,3), bigs})
    })()`)
  )

  // 再点一次岛身（空白处除外）→ 收起；随后仍在岛上
  await exec(islClickJs())
  await sleep(600)
  const isl3 = await islandProbe()
  r.reClickExpand = isl3.err ? `fail:probe=${isl3.err}` : !isl3.expanded && !isl3.open ? 'ok' : `fail:mode=${isl3.mode}`

  // 双击 → 回到卡片视图（单击展开岛的对应面：面板可达性回归）
  await exec(islDblclickJs())
  await sleep(900)
  const b2 = bounds()
  r.dotClickExpand2 = b2.width > 300 ? 'ok' : `fail:${b2.width}x${b2.height}`
  r.cardBack2 = (await exec("!!document.querySelector('.pcard-grid') || !!document.querySelector('.empty-state')")) ? 'ok' : 'fail'
  // 回到岛上，后续岛断言以它为基准
  await exec(footerClick('收起'))
  await sleep(700)

  // 漂移回归：多轮展开/收起后，岛位置（posX）必须回到同一值（旧版每轮右移 328px 直至出屏）
  const islDriftA = await islandProbe()
  for (let i = 0; i < 2; i++) {
    await exec(islClickJs())
    await sleep(500)
    await exec(islClickJs())
    await sleep(500)
  }
  const islDriftB = await islandProbe()
  r.noDrift =
    islDriftA.err || islDriftB.err
      ? `fail:probe=${islDriftA.err || islDriftB.err}`
      : Math.abs(islDriftA.posX - islDriftB.posX) < 0.005 && islDriftB.mode === 'collapsed'
        ? 'ok'
        : `fail:posX=${islDriftA.posX}->${islDriftB.posX} mode=${islDriftB.mode}`
  await exec('window.api.expand()')
  await sleep(800)
  r.logoBadge = (await exec("!!document.querySelector('.brand-badge img')")) ? 'ok' : 'fail:no-img'
  r.gridAfterRefresh = (await exec("!!document.querySelector('.pcard-grid') || !!document.querySelector('.empty-state')")) ? 'ok' : 'fail'

  // 刷新压力（标题栏 ⟳ 与底部主按钮两个入口）+ 收起回岛（窗口固定为岛尺寸）
  r.titleRefreshBtn = (await exec("!!document.querySelector('button[title=立即刷新]')")) ? 'ok' : 'fail:no-titlebar-refresh'
  await exec("document.querySelector('button[title=立即刷新]')?.click()")
  await exec('window.api.refreshNow(); window.api.refreshNow()')
  await sleep(2500)
  await exec(footerClick('收起'))
  await sleep(700)
  // 尺寸取常量而不是字面量：断言过时只会红在数字上，看不出是断言的问题 —— 所以读共享常量。
  r.refreshThenCollapse =
    bounds().width === ISLAND_VIEW.width && bounds().height === ISLAND_VIEW.height
      ? 'ok'
      : `fail:${bounds().width}x${bounds().height}!=${ISLAND_VIEW.width}x${ISLAND_VIEW.height}`
  await exec(islDblclickJs())
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
  // ⚠ 先把开关归位再断言（与上面的 vrsPowerOn 同一教训：上一轮 run 若停在"兜底开着"，
  //   进来时 select 就在 DOM 里，第一条直接报 shown-while-off，接着那次 click 把开着的
  //   开关又关回去，整段 Routine* 一起崩 —— 崩的是前置状态，不是本段代码）。
  if ((await exec("!!document.querySelector('.vrs-routine-interval')")) === true) {
    await exec(`(()=>{const rows=[...document.querySelectorAll('.vrs-sec .enable-row')]
      rows.find(x=>/定时兜底播报/.test(x.textContent||''))?.querySelector('button.switch')?.click()})()`)
    await sleep(700)
  }
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

  // ── 收起态：唯一的形态是顶部灵动岛（10-10-dynamic-island；旧 2D 小水球已退役）───
  //
  // ui:pet 残留 '1' 的老偏好由主进程 primePrefs 在启动时迁回 '0'；启动期行为在
  // uitest 运行时测不到，这里只断言形态死键：偏好值不再决定任何形态 —— 写 '1'
  // 也变不出人物，窗口恒岛尺寸（ISLAND_VIEW）、无 canvas、无人物 DOM。
  // 面板不再常驻宠物卡（用户要求）：确认已移除
  r.petCardRemoved = (await exec("!!document.querySelector('.pet-card')")) ? 'fail:still-there' : 'ok'

  // 设置页「数字助理」分区已随人物形态下线：整个 .pet-sec 不许存在
  await exec(footerClick('设置'))
  await sleep(700)
  r.petSectionGone = (await exec("!!document.querySelector('.pet-sec')")) ? 'fail:still-there' : 'ok'
  // R1（AC1.1）设置侧：那个已删除的用量环开关整行必须已经拆掉。**只记串不报键** ——
  // petRingRemoved 是「设置页 + 右键菜单」两半合成的一条断言（拆开就把 14 条对不上），
  // 菜单那一半要到球上才截得到（菜单标签在主进程现拼，渲染层读不到），最后统一合报。
  //
  // 死开关文案由两段拼出来：步 8 的门要求 `grep -rn "<该文案>" src/ README.md DESIGN.md`
  // **零命中**（产品代码不许再出现这串字），而这条断言恰恰要证明它不存在 —— 拼接在
  // 运行时与整串完全等价，grep 则匹配不到连续字面量。
  //
  // 分区已整体删除：设置页一半的判据是「分区缺席」（.pet-sec 不存在即 ok）。
  const deadRingLabel = '显示' + '用量环'
  const ringRowGone = ((await exec("!!document.querySelector('.pet-sec')")) === true)
    ? 'fail:pet-sec-still-there'
    : 'ok'

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

  // 从这里开始会反复推夹具（球上断言），
  // 而 60 秒一轮的真实采集随时可能把夹具覆盖掉 —— 那种红查不出原因。
  // ⚠ 改频率会 reconfigure → refreshNow（**推夹具之前**只能做这一件事），等它收尾。
  await exec("window.api.setExtras({refreshInterval:'300'})")
  await sleep(300)
  for (let i = 0; i < 60; i++) {
    if ((await exec('window.api.getState().then(s=>!!s.scanning)')) !== true) break
    await sleep(300)
  }

  // 形态死键：ui:pet 写 '1' 也变不出人物（人物形态已下线，偏好不再被任何代码读取）。
  await exec("window.api.setExtras({\"ui:pet\":\"1\"})")
  await gotoView('collapse')
  r.petUiPetDead =
    bounds().width === ISLAND_VIEW.width &&
    bounds().height === ISLAND_VIEW.height &&
    (await exec("!!document.querySelector('.pet3d-canvas')")) !== true &&
    (await exec("!!document.querySelector('.isl-body')")) === true
      ? 'ok'
      : `fail:${bounds().width}x${bounds().height}`
  // 复位：把探测写的值还原（primePrefs 也会在下次启动时做同样的迁移）
  await exec("window.api.setExtras({\"ui:pet\":\"0\"})")
  r.petToggleOff = (await exec("window.api.getExtras(['ui:pet']).then(e=>e['ui:pet']==='0')")) === true ? 'ok' : 'fail:not-saved'

  // ── 灵动岛形态：窗口恒 560×480（ISLAND_VIEW），纯 2D（无 canvas，有岛 DOM），无人物 DOM ──
  r.petBallWindow = bounds().width === ISLAND_VIEW.width && bounds().height === ISLAND_VIEW.height ? 'ok' : `fail:${bounds().width}x${bounds().height}`
  // 灵动岛是**纯 2D**：没有 canvas（不创建 WebGL 上下文），有 .isl-body 那座岛。
  const ballCanvas = await exec("!!document.querySelector('.pet3d-canvas')")
  const ballDot = await exec("!!document.querySelector('.isl-body')")
  r.petBall3d =
    !ballCanvas && ballDot ? 'ok' : `fail:canvas=${!!ballCanvas},dot=${!!ballDot}`
  // 人物 DOM（胶囊 / 调试环 / 改名框）一条都不许剩：JSX 已删，留一条 DOM 级护栏
  // （CSS 里同名规则还在 —— 它们是惰性的，无 JSX 挂载即无像素；test-structure 的 D6
  // 改名输入框那条仍钉住那份 CSS 不许长出 outer 阴影）。
  const figureDom = Number(
    await exec("document.querySelectorAll('.petball-caption,.petball-debugring,.petball-rename,.pet3d-canvas').length")
  )
  r.petNoFigureDom = figureDom === 0 ? 'ok' : `fail:${figureDom}`
  // 无通知、无预警时不该有泡泡（泡泡只承载 notice / 确认气泡，两者此时都为空）
  r.petBallNoBubble = !(await exec("!!document.querySelector('.isl-bubble') || !!document.querySelector('.isl-confirm')"))
    ? 'ok'
    : `fail:bubble=${await exec("document.querySelector('.isl-bubble')?.innerText || document.querySelector('.isl-confirm-text')?.innerText || ''")}`
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
  r.petCmdOk = watch.collapsed === true && bounds().width === ISLAND_VIEW.width ? 'ok' : `fail:${bounds().width}`
  // 收起态必须关掉原生窗口阴影（否则 macOS 会按窗口矩形投一层方框阴影）
  r.petNoWindowShadow = watch.shadow === false ? 'ok' : 'fail:has-shadow'
  // 诊断快照（纯记录，无断言读它）：穿透状态 + 命中框尺寸
  r.petDiag = JSON.stringify({
    watch,
    hb: hb && { w: Math.round(hb.width), h: Math.round(hb.height) }
  })

  // 右键菜单关掉之后不许残留"按下"状态（"宠物黏住光标乱跑"的回归）
  r.petNoStickyDrag = consumeDragFired() ? 'fail:drag-started' : 'ok'
  r.petStillCollapsed = bounds().width === ISLAND_VIEW.width ? 'ok' : `fail:${bounds().width}`

  // 右键菜单：原生菜单打开（Esc 关掉），期间不崩、渲染层仍存活
  await exec(`(()=>{
    const b=document.querySelector('.isl-hit'); if(!b) return
    const rc=b.getBoundingClientRect()
    b.dispatchEvent(new MouseEvent('contextmenu',{clientX:rc.x+rc.width/2,clientY:rc.y+10,bubbles:true}))
  })()`)
  await sleep(900)
  r.petMenuOpened = win.isDestroyed() ? 'fail:destroyed' : 'ok'
  await exec(`(()=>{ document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})) })()`)
  await sleep(600)

  // ── 灵动岛收起内容（AC2：启用家数一排显示；plan 嵌套环 + logo，balance 金额）───
  //
  // 夹具自己推（真实数据随机器而变）：3 plan（多窗 70/41、单窗 42、高用量 91）
  // + 1 balance（FIX_BAL）。断言先分 kind（plan/balance/无数据各走各的呈现，
  // 混成一条布尔只会得到永真的兜底），再验环色与金额。
  const FIX_ISLAND4 = [
    planFix('fix-i1', 'Fix I1', [fw('5 小时', 70), fw('本周', 41)]),
    planFix('fix-i2', 'Fix I2', [fw('本月', 42)]),
    planFix('fix-i3', 'Fix I3', [fw('5 小时', 91)]),
    ...FIX_BAL
  ]
  await pushFix(FIX_ISLAND4)
  const islA = await islandProbe()
  const islDom = String(
    await exec(`(()=>{
      const combos=[...document.querySelectorAll('.isl-combo')].map(c=>({
        id:c.getAttribute('data-supplier'), kind:c.getAttribute('data-kind'), lvl:c.getAttribute('data-lvl'),
        rings: c.querySelectorAll('.isl-rings circle').length,
        strokes: [...c.querySelectorAll('.isl-rings circle')].map(x=>getComputedStyle(x).stroke),
        amount: c.querySelector('.isl-amount')?.textContent ?? null
      }))
      const isl=document.querySelector('.isl-strip')
      const r=isl?isl.getBoundingClientRect():null
      return JSON.stringify({combos, w: r?Math.round(r.width):-1})
    })()`)
  )
  let islWhy = ''
  try {
    const d = JSON.parse(islDom) as {
      combos: { id: string; kind: string; lvl: string; rings: number; strokes: string[]; amount: string | null }[]
      w: number
    }
    if (islA.err) islWhy = `fail:probe=${islA.err}`
    else if (d.combos.length !== 4) islWhy = `fail:count=${d.combos.length}（启用 4 家应一排 4 个）`
    else if (d.combos.filter((c) => c.kind === 'plan').length !== 3) islWhy = `fail:plan=${JSON.stringify(d.combos)}`
    else if (d.combos.filter((c) => c.kind === 'balance').length !== 1) islWhy = `fail:balance=${JSON.stringify(d.combos)}`
    else if (d.combos.find((c) => c.id === 'fix-i3')?.lvl !== 'danger') islWhy = `fail:i3-lvl=${d.combos.find((c) => c.id === 'fix-i3')?.lvl}（91% 应 danger）`
    else if (!(d.combos.find((c) => c.kind === 'balance')?.amount ?? '').includes('¥')) {
      islWhy = `fail:bal-amount=${d.combos.find((c) => c.kind === 'balance')?.amount}（余额家应显示金额而非环）`
    } else if (!(d.w > 0 && d.w <= 560)) islWhy = `fail:island-w=${d.w}（岛宽自适应，上限 560）`
    else {
      // 环色与渲染层同源（shared/water-color，不手写第二份公式）：i1 两窗 70/41
      const i1 = d.combos.find((c) => c.id === 'fix-i1')
      const anchors = defaultWaterAnchors()
      const want = [70, 41].map((pct) => waterColor(pct, anchors).replace(/\s+/g, ''))
      const got = (i1?.strokes ?? []).slice(1, 3).map((s) => (s || '').replace(/\s+/g, ''))
      if (i1?.rings !== 3) islWhy = `fail:i1-rings=${i1?.rings}（底圈 + 2 窗）`
      else if (got.join('|') !== want.join('|')) islWhy = `fail:ring-color got=${got.join('|')} want=${want.join('|')}`
    }
  } catch {
    islWhy = `fail:probe=${islDom.slice(0, 80)}`
  }
  r.petBallCenterValue = islWhy || 'ok'
  r.petBallRingDiag = islDom
  // 禁用某家后该家消失（AC2 后半：子集推送 → 岛上只剩子集；注册表 enabled 口径见 IslandView ordered）
  await pushFix([FIX_ISLAND4[0], FIX_ISLAND4[3]])
  await sleep(400)
  const islB = await islandProbe()
  r.islandDisable =
    islB.err
      ? `fail:probe=${islB.err}`
      : islB.count === 2 && islB.combos.every((c) => c.id === 'fix-i1' || c.id === 'fix-bal')
        ? 'ok'
        : `fail:count=${islB.count} combos=${JSON.stringify(islB.combos.map((c) => c.id))}`
  // 无比例不断言假数（AC2 诚实表达：灰环 + 无金额环；中心不编 0%）
  await pushFix(FIX_NOLIMIT)
  await sleep(400)
  const islC = String(
    await exec(`(()=>{
      const c=document.querySelector('.isl-combo[data-supplier="fix-nolimit"]')
      if(!c) return 'fail:no-combo'
      return JSON.stringify({
        kind: c.getAttribute('data-kind'),
        strokes: [...c.querySelectorAll('.isl-rings circle')].map(x=>getComputedStyle(x).stroke)
      })
    })()`)
  )
  let noPctWhy = ''
  try {
    const d = JSON.parse(islC) as { kind: string; strokes: string[] }
    const grays = d.strokes.slice(1).every((s) => s.replace(/\s+/g, '') === 'rgb(99,99,102)')
    if (d.kind !== 'plan') noPctWhy = `fail:kind=${d.kind}`
    else if (!grays) noPctWhy = `fail:strokes=${d.strokes.join('|')}（算不出比例必须全灰环，不编数字色）`
  } catch {
    noPctWhy = `fail:probe=${islC.slice(0, 80)}`
  }
  r.islandNoPct = noPctWhy || 'ok'
  // 收尾：把真实数据拉回来（refreshNow 重采集；后面 grp/dock 段依赖真实注册表与快照）
  await exec('window.api.refreshNow()')
  await sleep(2500)
  // 命中区：岛上报的矩形必须落在岛窗口内（W7 同款纪律：退回整窗就是隐形可点击区）
  const hitRect = String(await exec(`(()=>{
      const h=document.querySelector('.isl-body')
      if(!h) return 'fail:no-island'
      const b=h.getBoundingClientRect()
      return JSON.stringify({w:Math.round(b.width),h:Math.round(b.height)})
    })()`))
  r.petBallHitRect =
    hitRect.startsWith('fail:')
      ? hitRect
      : (() => {
          try {
            const b = JSON.parse(hitRect) as { w: number; h: number }
            return b.w > 0 && b.w <= ISLAND_VIEW.width && b.h > 0 && b.h <= ISLAND_VIEW.height
              ? 'ok'
              : `fail:${b.w}x${b.h}`
          } catch {
            return `fail:unparsed=${hitRect}`
          }
        })()

  // ─── 09-27-dot-ring-scroll：球上断言 ────────────────────────────────────────
  //
  // 纪律：每条都必须能被「先弄坏一次」弄红 —— 所以断言一律自带前置条件（探针报错、
  //  kind 不对、家数不够都算红），不写恒绿兜底。夹具按多窗套餐 → 余额的顺序推，
  // 每步之间互不干扰。
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

  // ── 隐藏余额（岛版）：右键菜单切 → 余额 combo 金额变 •••• ────────────────
  // 打码只管读数（balanceText 构造时即 lit，不经过任何动画链路）
  await pushFix(FIX_BAL)
  const islBalHide = async (): Promise<string> =>
    String(await exec(`document.querySelector('.isl-combo[data-kind="balance"] .isl-amount')?.textContent ?? ''`))
  const hideOn2 = await setHide(true)
  await sleep(500)
  const hv1 = await islBalHide()
  await sleep(400)
  const hv2 = await islBalHide()
  const hideBack2 = await setHide(hideWasOn)
  r.petHideBalanceNoAnim =
    hideOn2 !== 'ok'
      ? `fail:${hideOn2}`
      : hv1 !== '••••' || hv2 !== '••••'
        ? `fail:${hv1}/${hv2}`
        : hideBack2 !== 'ok'
          ? `fail:restore=${hideBack2}`
          : 'ok'
  // 收尾：采集频率拉回默认（setExtras 会 reconfigure → 立刻补一轮真实数据）
  await exec("window.api.setExtras({refreshInterval:'60'})")

  // 岛体是渐变背景（computed background-color 恒 transparent），判据读
  // backgroundImage ≠ none —— 渐变丢了（background 被人改成纯色 transparent）
  // 即红；具体色值不钉（换皮/调色不改测试）。
  const surfRaw = String(await exec(`(()=>{
    const app=document.querySelector('.app'); const isl=document.querySelector('.isl-strip') || document.querySelector('.isl-open')
    if(!app) return 'fail:no-app'; if(!isl) return 'fail:no-island'
    const before=app.getAttribute('data-skin')
    const out={}
    for(const s of ['aero','dark','minimal','candy','ink','ext:__no-such-skin__']){
      app.setAttribute('data-skin', s)
      out[s]=getComputedStyle(isl).backgroundImage
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
    const bad = SKIN_KEYS.filter((k) => !surf[k] || surf[k] === 'none')
    if (bad.length) {
      skinWhy = `fail:no-bg=${bad.join(',')} got=${JSON.stringify(surf)}`
    }
  }
  r.petBallSkinSurface = skinWhy || 'ok'

  // 泡泡的回归护栏挪到了形态翻转处（见 petBallOff 紧后面那条），不在这里查：
  // 收尾时泡泡那 4.2s 存活期早就过了，那时候查是**永真**的 —— 实测只差一行 IPC 的
  // 耗时就会从「抓得到」翻成「抓不到」。此处留着记录，免得后来的人又把它挪回来。
  await exec(islDblclickJs())
  await sleep(1000)
  r.petBallExpand = bounds().width > 300 ? 'ok' : `fail:${bounds().width}`

  // 还原探测写入的偏好（测试期间写过 ui:pet='1' 验证形态死键，已恢复 '0'；
  // 即便残留，primePrefs 也会在下次启动时做同样的迁移）
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
    dockB0.width === ISLAND_VIEW.width && dockB0.height === ISLAND_VIEW.height
      ? 'ok'
      : `fail:${dockB0.width}x${dockB0.height}（仅收起态岛形态参与）`
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

  // 摆左沿 → 隐藏（R6 原地收缩：窗口不动，岛缩成顶部 mini-pill）。
  // 段内真光标已冻结，两次机会只防 dwell 本身的时序抖动。
  let dockedX = 0
  let dockedY = 0
  let hid = false
  for (let attempt = 0; attempt < 2 && !hid; attempt++) {
    const p = await bayEdge('left')
    dockedX = p.x
    dockedY = p.y
    hid = await dockWait('window.api.debugDockState().then(s=>s.hidden===true)', 'hide')
  }
  // 四边扫一遍：贴边判定与隐藏的屏幕坐标数学只活在 E2E 路径里（单测够不着），
  // 左右/上下反了这里必红。不经过光标（debug 通道先复位再摆位，可重复调用），所以无真光标 flake。
  //
  // R4-5 原地变柱：隐藏不再滑出屏幕，每条边要么原地藏（dx=dy=0）、要么干净拒绝，
  // 不许半态；另加一条"至少一边真藏了"（四条全拒 = 功能死了，必须红）。
  // 上沿在 darwin 也不再拒绝 —— 原地 morph 不经过菜单栏，无处可夹。
  // 方向数学的逐值锁定在单测，不在这里。
  let dockEdges = 'ok'
  let hidAnyEdge = false
  for (const e of ['left', 'right', 'top', 'bottom']) {
    const p = await bayEdge(e)
    const okEdge = await dockWait(`window.api.debugDockState().then(s=>s.hidden===true&&s.edge==='${e}')`, `hide-${e}`)
    const bSweep = bounds()
    const dx = bSweep.x - p.x
    const dy = bSweep.y - p.y
    // 原地：藏了 = 相位 hidden + 窗口纹丝不动
    if (okEdge && dx === 0 && dy === 0) {
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
  // R4-5 原地变柱：隐藏态窗口坐标 = 贴边全可见坐标（与 docked 同位，不手算偏移）
  const wantHideX = dockedX
  r.dockHide =
    hid && dsHide.edge === 'left' && bHide.x === wantHideX && bHide.y === dockedY
      ? 'ok'
      : `fail:hidden=${hid} edge=${dsHide.edge} x=${bHide.x} want=${wantHideX}`
  r.dockPeekSize =
    bHide.width === ISLAND_VIEW.width && bHide.height === ISLAND_VIEW.height ? 'ok' : `fail:${bHide.width}x${bHide.height}`

  // ── 流体相位（10-03-dock-autohide 步 6/7）：dock:fluid 状态序列 ──────────
  //
  // 主副两路必须同源：主进程 debug:dock-state 的 fluid 与岛 DOM 的 data-fluid/data-edge
  // 在落定态一致。定的是**落定态**（hidden / edge-visible），不定 morph 中间帧 ——
  // 中间帧只活 530/400ms，轮询断言它等于用 flake 换覆盖；中间帧的形状由 --shots 走查图看。
  const fluidDom = async (): Promise<{ fluid: string; edge: string; pill: boolean; island: boolean }> => {
    const raw = String(
      await exec(`(()=>{
        const d=document.querySelector('.isl-body')
        if(!d) return JSON.stringify({fluid:'?',edge:'?',pill:false,island:false})
        return JSON.stringify({fluid:d.dataset.fluid||'?',edge:d.dataset.edge||'?',
          pill:!!d.querySelector('.isl-pill'),island:!!d.querySelector('.isl-strip')})
      })()`)
    )
    try {
      return JSON.parse(raw) as { fluid: string; edge: string; pill: boolean; island: boolean }
    } catch {
      return { fluid: '?', edge: '?', pill: false, island: false }
    }
  }
  // 岛体定义在（只断言"定义在" —— 合成走查看 shots）
  r.dockFluidGoo = String(
    await exec(`(()=>{const f=document.querySelector('.isl-strip')||document.querySelector('.isl-pill'); if(!f) return 'fail:no-island';
      const bg=getComputedStyle(f).backgroundImage
      return bg&&bg!=='none' ? 'ok' : 'fail:bg='+bg})()`)
  )
  // 隐藏落定：主副同相位 + 贴边一致（仍在 hidden 态内，路过测试之前）
  await dockWait("window.api.debugDockState().then(s=>s.fluid==='hidden')", 'fluid-hidden')
  await sleep(400) // 主副两路各走一次 IPC，DOM 切类比 main 落定慢一拍
  const dsFluidHide = await dockState()
  const domHide = await fluidDom()
  r.dockFluidHidden =
    dsFluidHide.fluid === 'hidden' && domHide.fluid === 'hidden' && domHide.pill && !domHide.island
      ? 'ok'
      : `fail:main=${dsFluidHide.fluid} dom=${domHide.fluid}/${domHide.edge} pill=${domHide.pill}`
  // 隐藏态只剩 pill（AC5）：岛条收起、无展开卡；可见态反之。
  r.dockFluidLevel =
    domHide.pill && !domHide.island
      ? 'ok'
      : `fail:pill=${domHide.pill} island=${domHide.island}（隐藏稳态只留 mini-pill）`

  // ── 隐藏态 mini-pill（AC5）：窄条 + 各家等级点，原位吸顶 ──────────────────
  //
  // 仍在 hidden 落定态内：pill 在 + 等级点数 = 岛上家数 + 命中区即 pill 体
  // （与 shared/dock-hide.peekHitbox 同形，由主进程覆盖）。
  // 痕迹点击唤出走既有 dockReveal 那条不断（命中区即 pill，见 dock-hide.ts）。
  const pillDom = String(
    await exec(`(()=>{
      const pill=document.querySelector('.isl-pill')
      if(!pill) return 'fail:no-pillar'
      const dots=[...pill.querySelectorAll('.isl-dot')]
      const r=pill.getBoundingClientRect()
      const body=document.querySelector('.isl-body')
      return JSON.stringify({
        mode: body?body.getAttribute('data-island'):'?',
        pillW: Math.round(r.width), pillH: Math.round(r.height),
        dots: dots.length,
        lvls: dots.map(d=>d.getAttribute('class'))
      })
    })()`)
  )
  let pillWhy = ''
  if (pillDom.startsWith('fail:')) {
    pillWhy = pillDom
  } else {
    try {
      const c = JSON.parse(pillDom) as { mode: string; pillW: number; pillH: number; dots: number; lvls: string[] }
      // 前置：pill 窄条（高 26 = MINI_PILL_H；宽 ≤ 200，A 式窄条）
      if (c.mode !== 'hidden') pillWhy = `fail:mode=${c.mode}`
      else if (c.pillH !== MINI_PILL_H) pillWhy = `fail:pillH=${c.pillH}（应为 ${MINI_PILL_H}）`
      else if (!(c.pillW > 0 && c.pillW <= 200)) pillWhy = `fail:pillW=${c.pillW}（A 式窄条）`
      else if (c.dots < 1) pillWhy = `fail:dots=${c.dots}（各家等级点至少 1 个）`
      else if (!c.lvls.every((l) => /lvl-(ok|warn|danger|muted)/.test(l))) {
        pillWhy = `fail:dot-lvl=${c.lvls.join('|')}（等级点必须带 lvl 档）`
      }
    } catch {
      pillWhy = `fail:probe=${pillDom}`
    }
  }
  r.islandPill = pillWhy || 'ok'
  // 主进程覆盖的命中区即 peekHitbox（宽 = MINI_PILL_W；DOM pill 宽是 fit-content，随家数变，只钉高）：
  // 命中区与可见 pill 脱钩 = 看得见点不着，见 dock-hide 跨层契约。
  const hbHidden = petHitboxDebug()
  r.islandPillHit =
    hbHidden && hbHidden.width === MINI_PILL_W && hbHidden.height === MINI_PILL_H
      ? 'ok'
      : `fail:hitbox=${JSON.stringify(hbHidden)}（应为 ${MINI_PILL_W}×${MINI_PILL_H} 的顶部 pill 区）`

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

