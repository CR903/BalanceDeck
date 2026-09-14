import { Tray, Menu, nativeImage, app } from 'electron'
import { join } from 'path'
import type { ProviderSnapshot } from '../shared/types'
import { formatPercent, windowPercent } from '../shared/percent'
import { compactAmount, providerSummary, qualitySuffix, shortWindowLabel, trayTitle } from '../shared/tray-text'

// ═══════════════════════════════════════════════════════════════════════════════
// 托盘（状态栏）
//
// 标题文案与主供应商选择逻辑在 `src/shared/tray-text.ts`（纯函数、可测试）：
//   · 多窗口 → `5H 2.7% W 51.9% M 67.9%`（logo 由渲染层栅格化后送来）
//   · 单窗口余额 → `$12.34`
//   · 离线 / 缓存数据 → 前缀 ⚠
// ═══════════════════════════════════════════════════════════════════════════════

let tray: Tray | null = null
let toggleFn: () => void = () => {}
let currentIconKey = ''
let currentImage: Electron.NativeImage | null = null
let lastTitle = ''
let contextMenu: Menu | null = null
const iconCache = new Map<string, Electron.NativeImage>()

function defaultIconPath(): string {
  const name = process.platform === 'win32' ? 'tray.ico' : 'trayTemplate.png'
  const base = app.isPackaged ? join(process.resourcesPath, 'build') : join(__dirname, '../../build')
  return join(base, name)
}

export function createTray(onToggle: () => void, onRefresh: () => void): Tray {
  toggleFn = onToggle
  const icon = nativeImage.createFromPath(defaultIconPath())
  if (process.platform === 'darwin') {
    icon.setTemplateImage(true)
  }
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('BalanceDeck 余额板')
  // 左键点击 → 直接切换悬浮卡片显隐（这是菜单栏组件的核心操作）
  tray.on('click', () => toggleFn())
  if (process.platform === 'darwin') {
    // ⚠️ macOS 上 setContextMenu 会让菜单抢占左键点击（click 事件不再触发），
    // 表现为"点击状态栏只弹菜单、面板要再从菜单里点一次"。
    // 因此 macOS 只在右键时弹出菜单；左键保持显隐切换（见 rebuildMenu）。
    tray.on('right-click', () => {
      if (tray && contextMenu) tray.popUpContextMenu(contextMenu)
    })
  }
  rebuildMenu(onRefresh)
  return tray
}

function buildMenu(onRefresh: () => void): Menu {
  return Menu.buildFromTemplate([
    { label: '显示 / 隐藏悬浮卡片', click: () => toggleFn() },
    { label: '立即刷新', click: () => onRefresh() },
    { type: 'separator' },
    { label: '退出 BalanceDeck', click: () => app.quit() }
  ])
}

export function rebuildMenu(onRefresh: () => void): void {
  if (!tray) return
  contextMenu = buildMenu(onRefresh)
  // macOS 的菜单在右键时手动弹出，不调 setContextMenu（否则左键会被菜单吃掉）
  if (process.platform !== 'darwin') tray.setContextMenu(contextMenu)
}

/** 测试观测点：托盘交互模式（macOS 必须为 click-toggle，回归"点击不显隐"） */
export function trayInteractionMode(): 'click-toggle' | 'context-menu' {
  return process.platform === 'darwin' ? 'click-toggle' : 'context-menu'
}

/**
 * 托盘图标：渲染层用 canvas 把供应商 logo 画成 template PNG（黑 + alpha）后送来。
 * key 用于去重（同一供应商不重复设置，避免状态栏闪烁）。
 */
export function setTrayIcon(key: string, png1x: string, png2x: string): void {
  if (!tray) return
  if (!key) return
  if (key === currentIconKey) return
  currentIconKey = key
  const cached = iconCache.get(key)
  if (cached) {
    currentImage = cached
    tray.setImage(cached)
    return
  }
  const img = nativeImage.createEmpty()
  if (png1x) img.addRepresentation({ scaleFactor: 1, width: 22, height: 22, dataURL: png1x })
  if (png2x) img.addRepresentation({ scaleFactor: 2, width: 44, height: 44, dataURL: png2x })
  if (img.isEmpty()) {
    currentIconKey = ''
    return
  }
  if (process.platform === 'darwin') img.setTemplateImage(true)
  iconCache.set(key, img)
  currentImage = img
  tray.setImage(img)
}

export function updateTray(snapshots: ProviderSnapshot[], meta?: { offline?: boolean }): void {
  if (!tray) return
  const offline = !!meta?.offline
  if (process.platform === 'darwin') {
    lastTitle = trayTitle(snapshots, offline)
    tray.setTitle(lastTitle, { fontType: 'monospacedDigit' })
  }
  const lines: string[] = []
  for (const s of snapshots) {
    if (s.status === 'ok' && s.windows.length) {
      const detail =
        s.windows.length > 1
          ? s.windows
              .map((w) => {
                const p = windowPercent(w)
                return `${shortWindowLabel(w.name)} ${p != null ? formatPercent(p) : compactAmount(w)}`
              })
              .join('  ')
          : providerSummary(s)
      lines.push(`${s.name}${qualitySuffix(s)}: ${detail}`)
    } else if (s.status === 'error') {
      lines.push(`${s.name}: 出错（${s.degradedReason ?? s.detail ?? ''}）`)
    } else if (s.status === 'nodata') {
      lines.push(`${s.name}: 未配置`)
    } else {
      lines.push(`${s.name}: 无数据`)
    }
  }
  if (offline) lines.unshift('⚠ 网络不可用，显示的是最后一次成功获取的数据')
  tray.setToolTip(`BalanceDeck\n${lines.join('\n')}`)
}

/** 测试观测点：最近一次计算的托盘标题（渲染层读不到，只能由主进程回传） */
export function currentTrayTitle(): string {
  return lastTitle
}

/** 测试观测点：托盘图标状态（验证渲染层 → canvas → nativeImage 链路是否真的生效） */
export function trayImageInfo(): { empty: boolean; size: string; iconKey: string } {
  const img = currentImage
  return {
    empty: !img || img.isEmpty(),
    size: img ? `${img.getSize().width}x${img.getSize().height}` : '-',
    iconKey: currentIconKey
  }
}
