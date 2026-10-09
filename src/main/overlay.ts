import { BrowserWindow, screen, app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { BALL_VIEW } from '../shared/pet-view'
import { createDockHide, type DockPersisted } from './dockHide'
import type { DockEdge } from '../shared/dock-hide'

// 常驻悬浮卡片：无边框、透明、置顶、不进任务栏，可收起成 2D 小水球。
// 位置持久化在 userData/state.json。
//
// 收起态是「主体 + 一圈留白」的窗口（尺寸见 shared/pet-view）：
//   · 只有主体可见（纯 DOM 渲染），其余像素完全透明；
//   · 主体以外的区域鼠标穿透（光标轮询 + setIgnoreMouseEvents），桌面上点得到下面的窗口；
//   · 用户拖动主体即拖动窗口（位置持久化）。
//
// 人物形态已下线（10-03-remove-human）：窗口恒 56×56，不再有形态分支。

const EXPANDED = { width: 384, height: 600 }
/** 收起态：2D 小水球（唯一的收起形态；56×56，全屏水体 + 环心一个数，无 WebGL） */
const COLLAPSED_BALL = BALL_VIEW
/** 是否总在最前（可关闭；关闭后不再悬浮于其他窗口之上） */
let alwaysOnTop = true

/** 收起态目标尺寸：恒为 2D 小水球（人物形态已下线，不再有形态分支） */
function collapsedTarget(): { width: number; height: number } {
  return COLLAPSED_BALL
}

/**
 * 读取并应用启动期偏好（是否置顶 + 贴边隐藏开关）。
 * 在 createOverlay 之前 await 一次，窗口就能按最终尺寸/层级直接创建，避免闪一下。
 *
 * 老用户迁移（10-03-remove-human）：`ui:pet === '1'`（曾开启个性人物）→ 写回 `'0'`。
 * 窗口本来就恒为 56×56（形态分支已删），这一写只是让磁盘上的旧偏好不再谎称人物形态，
 * 避免未来代码把残留值误读成形态。
 */
export async function primePrefs(): Promise<void> {
  try {
    const { getExtra, setExtra } = await import('./keystore')
    const pet = await getExtra('ui:pet')
    if (pet === '1') {
      try {
        await setExtra('ui:pet', '0')
      } catch {
        // 落盘失败不阻断启动：窗口恒为圆环，残留值无行为影响
      }
    }
    const top = await getExtra('ui:alwaysOnTop')
    alwaysOnTop = top !== '0'
    // ui:dockHide 缺省开：extras:get 对缺失键给 ''，判 !== '0'（R7）
    const dockPref = await getExtra('ui:dockHide')
    dockEnabled = dockPref !== '0'
  } catch {
    // 读不到就用默认值（置顶 + 贴边隐藏开）
  }
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

/** 测试观测点：置顶状态 */
export function petWindowState(): { alwaysOnTop: boolean } {
  return { alwaysOnTop }
}

/**
 * 当前收起态（渲染层启动时**主动拉**一份，见 App.tsx 的 getCollapsed）。
 *
 * ⚠ 为什么必须有这个拉取入口，而不是只靠 `syncCollapsedState()` 推送：
 *   推送发生在 `win.loadFile().then(...)`，此时渲染层的 React 还没跑到
 *   `useEffect` 里的 `onCollapsed` 订阅 —— 实测主进程 t=…625 发、渲染层 t=…698 才订，
 *   首帧的 `ui:collapsed` 必丢。丢了之后主进程按 56×56 建窗（收起态），
 *   渲染层却按默认 `collapsed=false` 画 384×600 展开卡片，用户只看到卡片
 *   左上角一个图标 —— 表现为「应用启动了但看不到界面」。
 *   推送保留（运行中的变更仍走它），启动期改为拉取：invoke 天然没有时序依赖。
 */
export function currentCollapsed(): boolean {
  return !!state.collapsed
}

/**
 * 把「启动期会被丢掉」的两项窗口态重推一遍。
 *
 * 与 `syncCollapsedState()` 同源，但触发点换成渲染层的 `ui:get-collapsed` 拉取 ——
 * 那一刻渲染层已挂载完 `onDockHidden` / `onDockFluid` 订阅（App.tsx 的这两个
 * effect 声明在发拉取的那个 effect 之前，同一次 commit 里先跑），推送不会落空。
 * `ui:collapsed` 不在这里重推：它由 `ui:get-collapsed` 的**返回值**带回，
 * 一条 invoke 就把首帧状态补齐，比「返回值 + 推送」两条通道竞争同一状态安全。
 */
export function resyncDockState(): void {
  safeSend('dock:hidden', dock.hidden())
  safeSend('dock:fluid', { phase: lastFluid.phase, edge: lastFluid.edge })
}

/** 贴边隐藏位移异常只记一次日志（窗口关闭/退出竞态时原生调用会抛） */
let dockMoveErrorLogged = false
/** 贴边自动隐藏开关（extras ui:dockHide，缺省开：值 !== '0' 即开，R7） */
let dockEnabled = true
/** prefers-reduced-motion（渲染层 matchMedia 上报）：命中则跳动画、留计时（R5） */
let reducedMotion = false
/** 隐藏态命中区覆盖（窗口局部坐标）：非 null 时不采信渲染层常规上报（跨层契约） */
let peekOverride: { x: number; y: number; width: number; height: number } | null = null
/**
 * 流体相位冻结（--uitest / --shots 用）：冻结期间主进程的 dock:fluid 推送被拦住，
 * 渲染层保持当前呈现相位 —— shots 据此摆拍拉伸/桥接/水渍三帧（复用 debug:dock-freeze 模式）。
 * 窗口位移与命中判定不受影响（只冻呈现相位，不冻状态机）。
 */
let fluidFrozen = false
/** 最后一次实际推送给渲染层的流体相位（--uitest 读数；冻结时保持旧值） */
let lastFluid: { phase: string; edge: DockEdge | null } = { phase: 'edge-visible', edge: null }

/**
 * 向渲染层推送（dock:hidden / dock:fluid / ui:collapsed）。
 *
 * 为什么不能裸 `win?.webContents.send`：渲染层 reload / GPU 崩溃恢复期间，
 * send 会抛 `Render frame was disposed` —— 而调用方一半在定时器回调里
 * （隐藏动画步进、morph 等待、唤出 morph 尾），抛出来就是主进程未捕获异常
 * （弹框并终止应用，正是本仓反复修的那一类拖拽定时器崩溃）。
 * 这里吞掉：推送的是**状态**不是事件 —— 启动由 syncCollapsedState 重推，
 * 运行中下一次 setPhase 也会重推，不丢状态。
 */
function safeSend(channel: string, payload: unknown): void {
  try {
    if (!win || win.webContents.isDestroyed()) return
    win.webContents.send(channel, payload)
  } catch {
    // reload / 崩溃恢复窗口：跳过这次推送
  }
}

/**
 * 贴边隐藏控制器（状态机 + 计时 + 动画，见 dockHide.ts）。
 * electron 依赖全部经这里注入 —— overlay 只做窗口/屏幕/持久化的转接，
 * 几何决策（边沿判定/隐藏偏移/痕迹命中区）仍归 shared/dock-hide.ts。
 */
const dock = createDockHide({
  getBounds: () =>
    win?.getBounds() ?? { x: 0, y: 0, width: BALL_VIEW.width, height: BALL_VIEW.height },
  setPosition: (x: number, y: number) => {
    // 744 崩溃的 choke 点：dockHide 的计时器链全部经这里动窗口。
    // undefined/NaN 不得进原生 setPosition（Electron 报 conversion failure
    // 直接弹主进程对话框）；窗口已销毁时原生调用会抛，也吞掉（只记一次）——
    // 状态机的 landed() 校验会发现没落位并自行 abort，不停在半态。
    if (!win || !Number.isFinite(x) || !Number.isFinite(y)) return
    try {
      applyingBounds = true
      win.setPosition(Math.round(x), Math.round(y))
    } catch (e) {
      if (!dockMoveErrorLogged) {
        dockMoveErrorLogged = true
        console.error('[overlay] 贴边隐藏位移异常（已忽略）:', e)
      }
    } finally {
      applyingBounds = false
    }
    // 注意：这里不写 state.x/state.y —— 隐藏动画逐帧走这一路，
    // 写了就是把屏外隐藏坐标当成用户位置持久化（R6：坐标只存贴边全可见位置）。
    // docked 全可见坐标由 dockHide 内部记，persist 经 onPersist 只写 dock 字段。
  },
  getWorkArea: () => {
    const b = win?.getBounds()
    const cx = (b?.x ?? 0) + (b?.width ?? BALL_VIEW.width) / 2
    const cy = (b?.y ?? 0) + (b?.height ?? BALL_VIEW.height) / 2
    // 按窗口中心挑显示器：与 snapBackToWorkArea 同一口径
    return screen.getDisplayNearestPoint({ x: cx, y: cy }).workArea
  },
  isActive: () => {
    if (!win || !state.collapsed || !dockEnabled) return false
    const b = win.getBounds()
    return b.width === BALL_VIEW.width && b.height === BALL_VIEW.height
  },
  reducedMotion: () => reducedMotion,
  setPeekOverride: (rect) => {
    peekOverride = rect
  },
  onHiddenChange: (hidden: boolean) => {
    safeSend('dock:hidden', hidden)
  },
  onFluidPhase: (phase, edge) => {
    // morph 期命中区取并集（球起始区 ∪ pill 区）：球形态命中区本就是整窗，
    // 并集 = 整窗 = 不覆盖（peekOverride 仍为 null，采信渲染层上报）。
    // 隐藏落定后 enterHidden 才覆盖为痕迹条，唤出开始即清除 —— morph 窗内天然全窗可点。
    if (fluidFrozen) return
    lastFluid = { phase, edge }
    safeSend('dock:fluid', { phase, edge })
  },
  onPersist: (d) => {
    state.dock = d
    persist()
  },
  fast: () => process.env.BD_DOCK_FAST === '1',
})

/** 贴边隐藏开关（设置页 + 右键菜单双入口，R7） */
export function setDockHideEnabled(on: boolean): void {
  const next = on !== false
  if (next === dockEnabled) return
  dockEnabled = next
  // 关闭 → 取消计时/动画、回到贴边全可见并清 hidden（回滚到现行行为）
  if (!next) dock.resetToVisible()
}

/** reduced-motion 上报（渲染层 matchMedia，R5） */
export function setReducedMotionPref(on: boolean): void {
  reducedMotion = on === true
}

/** 测试观测点：贴边隐藏状态（--uitest 用） */
export function dockDebugState(): { phase: string; edge: DockEdge | null; hidden: boolean; fluid: string; fluidEdge: DockEdge | null } {
  return { phase: dock.phase(), edge: dock.edge(), hidden: dock.hidden(), fluid: lastFluid.phase, fluidEdge: lastFluid.edge }
}

/** 测试驱动：把球摆到指定边沿并走真实 dragStop 路径（--uitest 用） */
export function dockTestToEdge(edge: DockEdge): { x: number; y: number } {
  if (!win) return { x: 0, y: 0 }
  // 先按 dragStart 语义复位（隐藏态下回到贴边全可见）：连续摆多边时，
  // 上一边可能还藏着，直接读隐藏坐标判边会判出 null、可重复调用就断了
  dock.onDragStart()
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const w = BALL_VIEW.width
  const h = BALL_VIEW.height
  const pos =
    edge === 'left'
      ? { x: wa.x, y: Math.round(wa.y + (wa.height - h) / 2) }
      : edge === 'right'
        ? { x: wa.x + wa.width - w, y: Math.round(wa.y + (wa.height - h) / 2) }
        : edge === 'top'
          ? { x: Math.round(wa.x + (wa.width - w) / 2), y: wa.y }
          : { x: Math.round(wa.x + (wa.width - w) / 2), y: wa.y + wa.height - h }
  applyingBounds = true
  // 744 崩溃同类：裸 win.setPosition 不得吃非有限数（守卫与注入的 setPosition 同口径）
  if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) win.setPosition(pos.x, pos.y)
  applyingBounds = false
  state.x = pos.x
  state.y = pos.y
  persist()
  dock.onDragStop()
  // 同步返回摆位坐标：fast 模式下 50ms 后窗口已经藏进去了，调用方事后读 bounds
  // 拿到的是隐藏坐标而非贴边全可见坐标（dockedX 竞态，曾让 dockHide 误红）
  return pos
}

/** 测试驱动：喂一次光标命中翻转（--uitest 用，不依赖真实鼠标位置） */
export function dockTestCursor(over: boolean): void {
  dock.onCursor(over)
}

/**
 * 测试冻结真光标翻转（--uitest dock 段用）。
 * 合成事件动不了真光标：窗口瞬移到真光标底下时会产生一次真翻转，50ms 的 fast 停留里
 * 它足以取消一次 dwell、或在痕迹条上直接唤回（sweep-top/dockReveal 曾因此误红）。
 * 冻结只拦 tick → 状态机这一路；穿透（setIgnoreMouseEvents）与 debug 喂送照常工作。
 * 真光标在解冻前后的位置不变时不补事件（tick 只在翻转瞬间调一次，本来就这样）。
 */
let dockCursorFrozen = false
export function dockTestFreezeCursor(frozen: boolean): void {
  dockCursorFrozen = frozen === true
}

/**
 * 测试冻结流体相位推送（--uitest dock 段 / --shots 取帧用）。
 * 冻结只拦 dock:fluid 这一路；状态机照常走（位移/命中/计时都不停），
 * 渲染层保持当前呈现相位供截图或断言。
 */
export function dockTestFreezeFluid(frozen: boolean): void {
  fluidFrozen = frozen === true
}

/** 痕迹点击（无 hover 设备）：直接滑出（R3） */
export function dockTapPeek(): void {
  dock.onTapPeek()
}

/** 收起态异步缩放到目标尺寸（恒 56×56） */
function resizeCollapsed(): void {
  if (!win || !state.collapsed) return
  // 先复位隐藏态（R5 取消条件），再按目标尺寸摆
  dock.resetToVisible()
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
  /** 贴边隐藏：贴边全可见坐标仍记 x/y，这里只记边与隐藏态（R6） */
  dock?: DockPersisted
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
    // 透明窗口，macOS 会按**窗口矩形**投一层方框阴影（不是圆角矩形的形状）。
    // ⚠ 2026-09-28 订正：这段注释原来把用户报的「球外面套一圈浅色方框」直接归给这一层
    //   （「实机表现为…」），那是**误诊 #2**，已被证伪 —— 真凶是 `.petball-fallback` 的
    //   outer box-shadow：窗口与元素同为 56×56，圆形阴影的光晕在窗口内、圆外的那四块
    //   留在画面上，把窗口四角填成方形。证据与「为什么不用原生阴影」是两件事，
    //   前者已改、后者仍然成立；详见 .trellis/tasks/09-28-dot-frame-label-carousel/design.md §9。
    hasShadow: !state.collapsed,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 后台节流必须关掉：这个窗口常态是「用户没在看它」，而 Chromium 对
      // 隐藏/非聚焦窗口的 setTimeout 会做 intensive throttling（1 分钟以上的
      // 定时器被降到最低频率）。定时播报的间隔是 1 小时，被节流后就无法保证
      // 「到点播报」——而且这个失败是静默的：定时器仍会触发，只是可能晚很多，
      // 界面上看不出任何异常。收起态小水球的数字动画走 rAF（切窗口时暂停重排），
      // 语音提醒走的是 setTimeout 自重排，且触发后要发网络请求，时序不能被压。
      backgroundThrottling: false
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
      // 隐藏动画/隐藏态的位置不是用户位置：不采纳（否则 state.x 存的是屏外隐藏坐标，
      // 下一次启动夹取就按错坐标来，R6）。用户拖拽走 dragTimer 自己的 state 更新，不走这里。
      const ph = dock.phase()
      if (ph === 'hidden' || ph === 'hiding' || ph === 'revealing' || ph === 'dwell-reveal') return
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

  // BD_DEBUG_RING=1：渲染层显示命中调试环（自检用，核对命中判定）
  const query = process.env.BD_DEBUG_RING === '1' ? { bddebug: '1' } : undefined
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = process.env.ELECTRON_RENDERER_URL + (query ? '?bddebug=1' : '')
    void win.loadURL(url).then(() => syncCollapsedState())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query }).then(() => syncCollapsedState())
  }
  // 启动恢复：持久化的隐藏态按当前 workArea 重算偏移（R6，多显示器断开重连不漂移）
  dock.restore(state.dock)
  return win
}

/** 窗口尺寸与渲染层状态同步：加载完成后把持久化的收起态推给渲染层 */
function syncCollapsedState(): void {
  safeSend('ui:collapsed', !!state.collapsed)
  // 启动恢复成隐藏态时渲染层刚挂载（dockHidden 默认 false）：把它推准，
  // 否则痕迹上的单击会走展开而不是唤出
  safeSend('dock:hidden', dock.hidden())
  // 流体相位同理：刚挂载的渲染层默认 edge-visible，隐藏恢复后必须推成 hidden，
  // 否则首帧画整球、一帧后才跳水渍（启动闪一下）
  safeSend('dock:fluid', { phase: lastFluid.phase, edge: lastFluid.edge })
  // 冷启动就是收起态时，穿透轮询要在这里补上（setCollapsed 不会被调用）
  if (state.collapsed) setPetCursorWatch(true)
}

// —— 多显示器容错：显示器断开/分辨率变化导致窗口不可见时，拉回主屏工作区 ——
let displaysWatched = false
function watchDisplays(): void {
  if (displaysWatched) return
  displaysWatched = true
  const reposition = (): void => {
    // 显示器变化先取消隐藏计时与动画，再按现有口径回正（R1/R5 取消条件 + R6 重算偏移）
    dock.onDisplayChange()
    const b = win?.getBounds()
    if (!win || !b) return
    const visible = screen.getAllDisplays().some((d) => {
      const wa = d.workArea
      return b.x + b.width > wa.x && b.x < wa.x + wa.width && b.y + b.height > wa.y && b.y < wa.y + wa.height
    })
    if (visible) return
    // 窗口已漂出所有工作区（多半是旧屏的贴边/隐藏坐标）：先清隐藏态 —— 否则 docked 仍指旧屏，
    // 下一次唤出会把窗口飞回去；再夹回主屏，最后按新位置重判（若恰在边沿，重新起 1000ms 停留，
    // 不替用户直接藏；展开态/开关关闭时 onDragStop 内部直接清掉）。
    dock.resetToVisible()
    const wa = screen.getPrimaryDisplay().workArea
    const target = state.collapsed ? collapsedTarget() : EXPANDED
    const nb = win.getBounds()
    const nx = clampToWorkArea(nb.x, wa.x, wa.x + wa.width - target.width)
    const ny = clampToWorkArea(nb.y, wa.y, wa.y + wa.height - target.height)
    applyingBounds = true
    win.setBounds({ x: Math.round(nx), y: Math.round(ny), width: target.width, height: target.height })
    applyingBounds = false
    state.x = nx
    state.y = ny
    persist()
    dock.onDragStop()
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

/**
 * 把窗口整体收回工作区（与 setCollapsed / resizeCollapsed / watchDisplays 同一口径）。
 * 按窗口中心挑显示器：拖拽出来的窗口常横跨屏幕边界，按左上角会选错屏。
 */
function snapBackToWorkArea(): void {
  if (!win) return
  const b = win.getBounds()
  const wa = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }).workArea
  const nx = Math.round(clampToWorkArea(b.x, wa.x, wa.x + wa.width - b.width))
  const ny = Math.round(clampToWorkArea(b.y, wa.y, wa.y + wa.height - b.height))
  if (nx === b.x && ny === b.y) return
  // 744 崩溃同类：裸 win.setPosition 不得吃非有限数（与注入的 setPosition 同口径）
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return
  applyingBounds = true
  win.setPosition(nx, ny)
  applyingBounds = false
  state.x = nx
  state.y = ny
}

// 展开前的圆点位置：收起时精确还原到原位，杜绝开合漂移
let dotAnchor: { x: number; y: number } | null = null
// 程序化 setBounds 期间为 true：此时触发的 moved 不更新圆点锚点
let applyingBounds = false

export function setCollapsed(collapsed: boolean): void {
  if (!win) return
  // 展开/收起切换先取消隐藏计时与动画、不残留隐藏偏移（R1/R5 取消条件）——
  // 必须在读 bounds 之前：隐藏态下读到的是屏外隐藏坐标，圆点锚点/展开原点都会跟着错。
  dock.resetToVisible()
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
  safeSend('ui:collapsed', collapsed)
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
  // 动画与拖拽互斥：先取消隐藏计时/动画并复位到贴边全可见，再按全可见位置算拖拽偏移
  dock.onDragStart()
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
      // 故意比工作区宽松（首提交起就是这样）：贴边拖时不让窗口顶到"看不见的墙"，
      // 抓取点也能推到画面外。落位由 dragStop 的 snapBackToWorkArea 收回严格区内。
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
    // 拖拽中的宽松夹取只服务于手感：松手后必须回到严格工作区内，
    // 否则球会停在屏幕外被切掉（R11，与其他路径同一口径）
    snapBackToWorkArea()
    persist()
  }
  grabPoint = null
  // 隐藏逻辑接在收回之后：贴边则起 1000ms 隐藏计时（R1；展开态/开关关闭时内部直接清掉）
  dock.onDragStop()
}

// ═══════════════════════════════════════════════════════════════════════════════
// 收起态 2D 主体的鼠标穿透
//
// 窗口是一块透明小窗（尺寸见 shared/pet-view），只有主体的位置应该接收鼠标。渲染层把主体
// 的命中区（窗口内 CSS 像素）发过来，这里以光标轮询判断命中：
//   · 命中 → setIgnoreMouseEvents(false)，主体可点/可拖/可右键；
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
function cursorInsideHit(
  cursor: Electron.Point,
  b: Electron.Rectangle,
  box: { x: number; y: number; width: number; height: number } | null
): boolean {
  if (!box) return false
  // Electron 的 getBounds / 光标点与渲染层 CSS 像素同为 DIP，直接相减即可
  const x = cursor.x - b.x
  const y = cursor.y - b.y
  // pad=3：命中区是渲染层按投影/量出来的浮点矩形，取整后边缘会差一两个像素；
  // 不留这点余量的话，贴着环边点会时灵时不灵。宁可多 3px 也不漏 —— 多出来的部分
  // 本来就在环的透明边距里，点下去仍然展开。
  const pad = 3
  return x >= box.x - pad && x <= box.x + box.width + pad && y >= box.y - pad && y <= box.y + box.height + pad
}

function tickCursorWatch(): void {
  if (!win) return
  try {
    const b = win.getBounds()
    const cursor = screen.getCursorScreenPoint()
    if (!Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) return
    // 隐藏态下不采信渲染层常规上报，以痕迹条覆盖值为准（跨层契约：与隐藏偏移同源）
    const over = cursorInsideHit(cursor, b, peekOverride ?? hitbox)
    if (over !== cursorOver) {
      cursorOver = over
      win.webContents.send('pet:cursor', over)
      // 唤出/重藏/取消的计时都消费这次翻转（进入球体取消隐藏计时、痕迹停留唤出……）
      // uitest dock 段冻结时拦住（真光标停在痕迹条上会直接唤回，见 dockTestFreezeCursor）
      if (!dockCursorFrozen) dock.onCursor(over)
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

/** 测试观测点：当前命中框（窗口内 CSS 像素；隐藏态下为痕迹条覆盖值） */
export function petHitboxDebug(): { x: number; y: number; width: number; height: number } | null {
  return peekOverride ?? hitbox
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
