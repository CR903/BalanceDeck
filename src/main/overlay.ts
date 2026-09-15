import { BrowserWindow, screen, app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

// 常驻悬浮卡片：无边框、透明、置顶、不进任务栏，可收起成 3D 桌面宠物球。
// 位置持久化在 userData/state.json。
//
// 收起态不是「56px 小圆点窗口」，而是一块 320×230 的漫游区：
//   · 球是唯一的可见物（WebGL 渲染），球以外的像素完全透明；
//   · 球以外的区域鼠标穿透（光标轮询 + setIgnoreMouseEvents），桌面上点得到下面的窗口；
//   · 角色在这块区域内自主走动，用户拖动球即拖动窗口（位置持久化）。

const EXPANDED = { width: 384, height: 600 }
/** 收起态：3D 悬浮球（默认形态；球 + 数值胶囊，窗口贴合球体） */
const COLLAPSED_BALL = { width: 200, height: 210 }
/** 收起态：3D 桌面宠物（开启后球内角色会在漫游区里走动，需要更大的活动空间） */
const COLLAPSED_ROAM = { width: 320, height: 230 }

/** 当前收起态是否为「桌面宠物」形态（由 preferences 决定，见 primePrefs） */
let petRoam = false
/** 是否总在最前（可关闭；关闭后不再悬浮于其他窗口之上） */
let alwaysOnTop = true

/** 收起态目标尺寸：球形态 / 桌面宠物形态 */
function collapsedTarget(): { width: number; height: number } {
  return petRoam ? COLLAPSED_ROAM : COLLAPSED_BALL
}

/**
 * 读取并应用启动期偏好（收起态形态 + 是否置顶）。
 * 在 createOverlay 之前 await 一次，窗口就能按最终尺寸/层级直接创建，避免闪一下。
 */
export async function primePrefs(): Promise<void> {
  try {
    const { getExtra } = await import('./keystore')
    const pet = await getExtra('ui:pet')
    petRoam = pet === '1'
    const top = await getExtra('ui:alwaysOnTop')
    alwaysOnTop = top !== '0'
  } catch {
    // 读不到就用默认值（球形态 + 置顶）
  }
}

/** 切换收起态形态（渲染层在「桌面宠物」开关变化时调用） */
export function setPetMode(roam: boolean): void {
  if (roam === petRoam) return
  petRoam = roam
  if (win && state.collapsed) resizeCollapsed()
}

/** 总在最前开关（关闭后窗口不再悬浮于其它窗口之上） */
export function setAlwaysOnTopPref(on: boolean): void {
  alwaysOnTop = on
  applyAlwaysOnTop()
}

function applyAlwaysOnTop(): void {
  if (!win) return
  // 'floating' 层级：高于普通窗口但低于系统面板/输入法
  win.setAlwaysOnTop(alwaysOnTop, alwaysOnTop ? 'floating' : 'normal')
}

/** 测试观测点：当前形态与置顶状态 */
export function petWindowState(): { roam: boolean; alwaysOnTop: boolean } {
  return { roam: petRoam, alwaysOnTop }
}

/** 收起态异步缩放到当前形态的目标尺寸 */
function resizeCollapsed(): void {
  if (!win || !state.collapsed) return
  const b = win.getBounds()
  const target = collapsedTarget()
  const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea
  const nx = clampToWorkArea(b.x, wa.x, wa.x + wa.width - target.width)
  const ny = clampToWorkArea(b.y, wa.y, wa.y + wa.height - target.height)
  win.setResizable(true)
  applyingBounds = true
  win.setBounds({ x: Math.round(nx), y: Math.round(ny), width: target.width, height: target.height })
  applyingBounds = false
  win.setResizable(false)
  state.x = nx
  state.y = ny
  persist()
}


interface PersistedState {
  x?: number
  y?: number
  collapsed?: boolean
}

let state: PersistedState = {}
let win: BrowserWindow | null = null

function statePath(): string {
  return join(app.getPath('userData'), 'state.json')
}

export function loadPersisted(): void {
  try {
    if (existsSync(statePath())) state = JSON.parse(readFileSync(statePath(), 'utf-8')) as PersistedState
  } catch {
    state = {}
  }
}

function persist(): void {
  try {
    writeFileSync(statePath(), JSON.stringify(state), 'utf-8')
  } catch {
    // 忽略持久化失败
  }
}

export function createOverlay(): BrowserWindow {
  const primary = screen.getPrimaryDisplay()
  const wa = primary.workArea
  const collapsedSize = collapsedTarget()
  const w = (state.collapsed ? collapsedSize : EXPANDED).width
  const h = (state.collapsed ? collapsedSize : EXPANDED).height
  // 历史持久化位置可能已漂出屏幕（旧版开合漂移），启动时夹回可视区
  const x = clampToWorkArea(state.x ?? wa.x + wa.width - w - 16, wa.x, wa.x + wa.width - w)
  const y = clampToWorkArea(state.y ?? wa.y + wa.height - h - 16, wa.y, wa.y + wa.height - h)

  win = new BrowserWindow({
    width: w,
    height: h,
    x,
    y,
    frame: false,
    // 全平台透明：圆角/圆形由 CSS 形状决定，窗口矩形不参与绘制。
    // （此前 macOS 用非透明窗口 + 原生 vibrancy，窗口矩形会在卡片/圆点四角
    //   露出磨砂底与一条发丝边，即"透明角 + 白线"。改为 CSS backdrop-filter 后，
    //   形状外区域完全透明，圆角干净。）
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    // 原生窗口阴影：展开态（圆角卡片）打开；收起态关闭 —— 收起态是 GPU 合成的
    // 透明窗口，macOS 会按**窗口矩形**投一层方框阴影（实机表现为「宠物外面有个四方形框」），
    // 球的立体感由场景内的接触阴影负责。
    hasShadow: !state.collapsed,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  applyAlwaysOnTop()
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
  }
  watchDisplays()
  win.on('moved', () => {
    const b = win?.getBounds()
    if (b) {
      state.x = b.x
      state.y = b.y
      // 展开态下用户拖动卡片后，圆点锚点跟随卡片左上角（收起时圆点出现在卡片原位）
      // 展开态拖动卡片时记录锚点：收起时球出现在卡片原位
      if (!applyingBounds && b.width > collapsedTarget().width) dotAnchor = { x: b.x, y: b.y }
      persist()
    }
  })
  win.on('closed', () => {
    win = null
  })

  // BD_DEBUG_RING=1：渲染层显示命中环（自检用，核对球体投影与点击穿透判定）
  const query = process.env.BD_DEBUG_RING === '1' ? { bddebug: '1' } : undefined
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = process.env.ELECTRON_RENDERER_URL + (query ? '?bddebug=1' : '')
    void win.loadURL(url).then(() => syncCollapsedState())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query }).then(() => syncCollapsedState())
  }
  return win
}

/** 窗口尺寸与渲染层状态同步：加载完成后把持久化的收起态推给渲染层 */
function syncCollapsedState(): void {
  win?.webContents.send('ui:collapsed', !!state.collapsed)
  // 冷启动就是收起态时，穿透轮询要在这里补上（setCollapsed 不会被调用）
  if (state.collapsed) setPetCursorWatch(true)
}

// —— 多显示器容错：显示器断开/分辨率变化导致窗口不可见时，拉回主屏工作区 ——
let displaysWatched = false
function watchDisplays(): void {
  if (displaysWatched) return
  displaysWatched = true
  const reposition = (): void => {
    const b = win?.getBounds()
    if (!win || !b) return
    const visible = screen.getAllDisplays().some((d) => {
      const wa = d.workArea
      return b.x + b.width > wa.x && b.x < wa.x + wa.width && b.y + b.height > wa.y && b.y < wa.y + wa.height
    })
    if (visible) return
    const wa = screen.getPrimaryDisplay().workArea
    const target = state.collapsed ? collapsedTarget() : EXPANDED
    win.setBounds({
      x: clampToWorkArea(b.x, wa.x, wa.x + wa.width - target.width),
      y: clampToWorkArea(b.y, wa.y, wa.y + wa.height - target.height),
      width: target.width,
      height: target.height
    })
  }
  screen.on('display-removed', reposition)
  screen.on('display-metrics-changed', reposition)
}

export function getOverlay(): BrowserWindow | null {
  return win
}

export function toggleOverlay(): void {
  if (!win) return
  if (win.isVisible()) win.hide()
  else win.show()
}

/** 把 v 夹回 [lo, hi]（lo > hi 时取 lo，防止小屏负区间） */
function clampToWorkArea(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi))
}

// 展开前的圆点位置：收起时精确还原到原位，杜绝开合漂移
let dotAnchor: { x: number; y: number } | null = null
// 程序化 setBounds 期间为 true：此时触发的 moved 不更新圆点锚点
let applyingBounds = false

export function setCollapsed(collapsed: boolean): void {
  if (!win) return
  state.collapsed = collapsed
  persist()
  // 收起态才开穿透轮询（球以外点击到桌面）；展开面板必须整体可点，立即停掉
  setPetCursorWatch(collapsed)
  const b = win.getBounds()
  const target = collapsed ? collapsedTarget() : EXPANDED
  const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y })
  const wa = display.workArea
  let nx: number, ny: number
  if (collapsed) {
    // 圆点还原到展开前记录的位置；无记录时以卡片左上角为准
    const ax = dotAnchor?.x ?? b.x
    const ay = dotAnchor?.y ?? b.y
    nx = clampToWorkArea(ax, wa.x, wa.x + wa.width - target.width)
    ny = clampToWorkArea(ay, wa.y, wa.y + wa.height - target.height)
  } else {
    // 记住圆点位置；卡片从圆点处展开，越界（屏幕右/下边缘）时夹回工作区
    dotAnchor = { x: b.x, y: b.y }
    nx = clampToWorkArea(b.x, wa.x, wa.x + wa.width - target.width)
    ny = clampToWorkArea(b.y, wa.y, wa.y + wa.height - target.height)
  }
  win.setResizable(true)
  applyingBounds = true
  win.setBounds({ x: Math.round(nx), y: Math.round(ny), width: target.width, height: target.height })
  applyingBounds = false
  win.setResizable(false)
  // 窗口阴影：收起态关（否则 GPU 合成内容会被投一层方框阴影），展开态开（卡片圆角阴影）
  win.setHasShadow(!collapsed)
  state.x = nx
  state.y = ny
  persist()
  win.webContents.send('ui:collapsed', collapsed)
}

// —— 小圆点拖拽：主进程以光标位置追踪移动窗口（CSS drag-region 会吞掉 click，不可用）——
let dragTimer: NodeJS.Timeout | null = null
let dragOffset = { x: 0, y: 0 }
/** 抓取点（窗口内坐标）：拖动时保持该点跟着光标，球不会跳到光标中心 */
let grabPoint: { x: number; y: number } | null = null
/** 拖拽帧异常只记一次日志，避免刷屏 */
let dragErrorLogged = false

export function dragStart(grab?: { x: number; y: number }): void {
  if (!win || dragTimer) return
  const cursor = screen.getCursorScreenPoint()
  const b = win.getBounds()
  // ⚠️ grab 来自渲染层的指针坐标：必须是有限数（NaN 会让 setPosition 抛
  //    "conversion failure"，在定时器里抛出会直接崩掉主进程 —— 已在实机出现过）
  const usable = grab && Number.isFinite(grab.x) && Number.isFinite(grab.y)
  grabPoint = usable ? grab : null
  dragOffset = usable ? { x: grab.x, y: grab.y } : { x: cursor.x - b.x, y: cursor.y - b.y }
  if (!Number.isFinite(dragOffset.x) || !Number.isFinite(dragOffset.y)) {
    dragOffset = { x: 0, y: 0 }
  }
  dragTimer = setInterval(() => {
    // 定时器回调里任何异常都不该终止应用：整段包起来，异常只记录一次
    try {
      if (!win) {
        dragStop()
        return
      }
      const c = screen.getCursorScreenPoint()
      if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) return
      const display = screen.getDisplayNearestPoint(c)
      const wa = display.workArea
      const nx = Math.min(Math.max(c.x - dragOffset.x, wa.x - 40), wa.x + wa.width - 8)
      const ny = Math.min(Math.max(c.y - dragOffset.y, wa.y - 8), wa.y + wa.height - 40)
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) return
      win.setPosition(Math.round(nx), Math.round(ny))
      state.x = nx
      state.y = ny
    } catch (e) {
      if (!dragErrorLogged) {
        dragErrorLogged = true
        console.error('[overlay] 拖拽帧异常（已忽略）:', e)
      }
    }
  }, 16)
}

export function dragStop(): void {
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = null
    persist()
  }
  grabPoint = null
}

// ═══════════════════════════════════════════════════════════════════════════════
// 收起态：3D 宠物球的鼠标穿透
//
// 窗口是一块 320×230 的透明矩形，只有球的位置应该接收鼠标。渲染层把球的
// 命中框（窗口内 CSS 像素）发过来，这里以光标轮询判断命中：
//   · 命中 → setIgnoreMouseEvents(false)，球可点/可拖/可右键；
//   · 未命中 → setIgnoreMouseEvents(true, { forward: true })，事件穿透到桌面。
// 轮询只在「收起态」运行，展开面板时立即停止（卡片本身要完整接收鼠标）。
// ═══════════════════════════════════════════════════════════════════════════════

let hitbox: { x: number; y: number; width: number; height: number } | null = null
let watchTimer: NodeJS.Timeout | null = null
let cursorOver = false
/** 光标轮询异常只记一次日志 */
let cursorErrorLogged = false
/** 测试观测点：穿透状态（--uitest / --shots 用） */
let lastIgnore = false

export function setPetHitbox(rect: { x: number; y: number; width: number; height: number } | null): void {
  hitbox = rect && rect.width > 0 && rect.height > 0 ? rect : null
}

/** 命中判定：窗口内 CSS 像素坐标 → 屏幕坐标（窗口无边框，加上窗口位置即可） */
function cursorInsideBall(cursor: Electron.Point, b: Electron.Rectangle): boolean {
  if (!hitbox) return false
  // Electron 的 getBounds / 光标点与渲染层 CSS 像素同为 DIP，直接相减即可
  const x = cursor.x - b.x
  const y = cursor.y - b.y
  const pad = 3
  return x >= hitbox.x - pad && x <= hitbox.x + hitbox.width + pad && y >= hitbox.y - pad && y <= hitbox.y + hitbox.height + pad
}

function tickCursorWatch(): void {
  if (!win) return
  try {
    const b = win.getBounds()
    const cursor = screen.getCursorScreenPoint()
    if (!Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) return
    const over = cursorInsideBall(cursor, b)
    if (over !== cursorOver) {
      cursorOver = over
      win.webContents.send('pet:cursor', over)
    }
    const ignore = !over
    if (ignore !== lastIgnore) {
      lastIgnore = ignore
      // forward: true —— 穿透时仍把 move 事件转给本窗口，便于悬停判断与悬停反馈
      win.setIgnoreMouseEvents(ignore, { forward: true })
    }
  } catch (e) {
    if (!cursorErrorLogged) {
      cursorErrorLogged = true
      console.error('[overlay] 光标轮询异常（已忽略）:', e)
    }
  }
}

/** 开始/停止光标轮询（仅收起态运行；顺带把窗口层级顶一下，避免被新窗口盖住） */
export function setPetCursorWatch(on: boolean): void {
  if (on) {
    if (watchTimer) return
    // 出屏/被盖住时重新置顶（透明窗口下用户最容易遇到「球不见了」；用户关了置顶则不动）
    if (alwaysOnTop) win?.setAlwaysOnTop(true, 'floating')
    watchTimer = setInterval(tickCursorWatch, 90)
    tickCursorWatch()
  } else {
    if (watchTimer) {
      clearInterval(watchTimer)
      watchTimer = null
    }
    hitbox = null
    cursorOver = false
    if (lastIgnore) {
      lastIgnore = false
      win?.setIgnoreMouseEvents(false)
    }
  }
}

/** 测试观测点：当前命中框（窗口内 CSS 像素） */
export function petHitboxDebug(): { x: number; y: number; width: number; height: number } | null {
  return hitbox
}

/** 测试观测点：穿透状态 + 窗口是否处于收起态 + 原生窗口阴影（收起态必须关，否则会露方框） */
export function petIgnoreState(): {
  ignore: boolean
  collapsed: boolean
  roaming: boolean
  shadow: boolean
} {
  return {
    ignore: lastIgnore,
    collapsed: !!state.collapsed,
    roaming: watchTimer !== null,
    shadow: win?.hasShadow() ?? false
  }
}
