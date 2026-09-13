import { BrowserWindow, screen, app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

// 常驻悬浮卡片：无边框、透明、置顶、不进任务栏，可收起成小圆点。
// 位置持久化在 userData/state.json。

const EXPANDED = { width: 384, height: 600 }
const COLLAPSED = { width: 56, height: 56 }

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
  const w = (state.collapsed ? COLLAPSED : EXPANDED).width
  const h = (state.collapsed ? COLLAPSED : EXPANDED).height
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
    // macOS 的窗口阴影跟随内容 alpha 形状（透明窗口下即圆角/圆形本身）
    hasShadow: true,
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
  win.setAlwaysOnTop(true, 'floating')
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
      if (!applyingBounds && b.width > COLLAPSED.width) dotAnchor = { x: b.x, y: b.y }
      persist()
    }
  })
  win.on('closed', () => {
    win = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL).then(() => syncCollapsedState())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html')).then(() => syncCollapsedState())
  }
  return win
}

/** 窗口尺寸与渲染层状态同步：加载完成后把持久化的收起态推给渲染层 */
function syncCollapsedState(): void {
  win?.webContents.send('ui:collapsed', !!state.collapsed)
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
    const target = state.collapsed ? COLLAPSED : EXPANDED
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
  const b = win.getBounds()
  const target = collapsed ? COLLAPSED : EXPANDED
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
  win.setBounds({ x: nx, y: ny, width: target.width, height: target.height })
  applyingBounds = false
  win.setResizable(false)
  state.x = nx
  state.y = ny
  persist()
  win.webContents.send('ui:collapsed', collapsed)
}

// —— 小圆点拖拽：主进程以光标位置追踪移动窗口（CSS drag-region 会吞掉 click，不可用）——
let dragTimer: NodeJS.Timeout | null = null
let dragOffset = { x: 0, y: 0 }

export function dragStart(): void {
  if (!win || dragTimer) return
  const cursor = screen.getCursorScreenPoint()
  const b = win.getBounds()
  dragOffset = { x: cursor.x - b.x, y: cursor.y - b.y }
  dragTimer = setInterval(() => {
    if (!win) {
      dragStop()
      return
    }
    const c = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(c)
    const wa = display.workArea
    const nx = Math.min(Math.max(c.x - dragOffset.x, wa.x - 40), wa.x + wa.width - 8)
    const ny = Math.min(Math.max(c.y - dragOffset.y, wa.y - 8), wa.y + wa.height - 40)
    win.setPosition(nx, ny)
    state.x = nx
    state.y = ny
  }, 16)
}

export function dragStop(): void {
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = null
    persist()
  }
}
