import { Tray, Menu, nativeImage, app } from 'electron'
import { join } from 'path'
import type { ProviderSnapshot } from '../shared/types'
import { formatPercent, windowPercent } from '../shared/percent'
import { compactAmount, providerSummary, qualitySuffix, shortWindowLabel, trayTitle } from '../shared/tray-text'
import type { Level } from '../shared/levels'
import { badgeOf, paintBadge, trayIconKey, trayLevel, type BadgeShape } from './tray-badge'

// ═══════════════════════════════════════════════════════════════════════════════
// 托盘（状态栏）
//
// 标题文案与主供应商选择逻辑在 `src/shared/tray-text.ts`（纯函数、可测试）：
//   · 多窗口 → `5H 2.7% W 51.9% M 67.9%`（logo 由渲染层栅格化后送来）
//   · 单窗口余额 → `$12.34`
//   · 离线 / 缓存数据 → 前缀 ⚠
// 等级信号有两处，判的是同一个数（见 shared/levels.ts）：
//   · macOS 标题文字的 ANSI 颜色（8 色，无橙）
//   · 图标右下角的状态点（灰度分层；Windows 没有标题，这是它唯一的信号载体）
// ═══════════════════════════════════════════════════════════════════════════════

let tray: Tray | null = null
let toggleFn: () => void = () => {}
let currentIconKey = ''
let currentImage: Electron.NativeImage | null = null
let lastTitle = ''
let contextMenu: Menu | null = null
const iconCache = new Map<string, Electron.NativeImage>()

/** 渲染层送来的最新一份原始 PNG（等级变化时要拿它重画，不能只留 nativeImage） */
let pendingIcon: { key: string; png1x: string; png2x: string } | null = null
/** 当前等级与它对应的状态点形状（形状由 updateTray 推进，观测点要报等级本身） */
let currentLevel: Level = 'ok'
let currentBadge: BadgeShape = 'none'
/** 真正落到托盘上的那份 = `${原始key}#${形状}`，两个都没变才跳过（避免状态栏闪烁） */
let appliedIconKey = ''

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
 *
 * ⚠ 去重键必须**把状态点形状并进去**：等级变了但 logo 还是同一个 mark，
 *   只按原始 key 去重会把换级后的图标整个吞掉（状态点永远停在旧等级）。
 *   所以原始 key 与形状分开记，形状由 updateTray 推进 —— 谁先到都能收敛。
 */
export function setTrayIcon(key: string, png1x: string, png2x: string): void {
  if (!tray) return
  if (!key) return
  if (key !== currentIconKey) {
    currentIconKey = key
    pendingIcon = { key, png1x, png2x }
  }
  applyTrayIcon()
}

/** 状态点叠到 logo 上：返回加了点的 BGRA 位图（template 图标只有 alpha 生效） */
function badgeBuffer(dataURL: string, size: number, shape: BadgeShape): Buffer | null {
  const base = nativeImage.createFromDataURL(dataURL)
  if (base.isEmpty()) return null
  const bgra = base.resize({ width: size, height: size, quality: 'best' }).toBitmap()
  if (bgra.length < size * size * 4) return null
  if (!paintBadge(bgra, size, shape)) return null
  return bgra
}

/**
 * 把 pendingIcon 按当前等级画好并设到托盘上。原始 key 与形状**任一**变了才动手。
 * 两份 representation（1x 22 / 2x 44）各自从自己的 dataURL 出发 ——
 * 走 nativeImage.resize 会从高分那份缩下来，logo 会糊。
 */
function applyTrayIcon(): void {
  if (!tray || !pendingIcon) return
  const cacheKey = trayIconKey(pendingIcon.key, currentBadge)
  if (cacheKey === appliedIconKey) return
  const cached = iconCache.get(cacheKey)
  if (cached) {
    currentImage = cached
    appliedIconKey = cacheKey
    tray.setImage(cached)
    return
  }
  // 'none'（ok 档）走原路径：同一个对象、同一份字节 —— 正常用量不该看到任何变化
  const plain = nativeImage.createEmpty()
  if (pendingIcon.png1x) {
    plain.addRepresentation({ scaleFactor: 1, width: 22, height: 22, dataURL: pendingIcon.png1x })
  }
  if (pendingIcon.png2x) {
    plain.addRepresentation({ scaleFactor: 2, width: 44, height: 44, dataURL: pendingIcon.png2x })
  }
  if (plain.isEmpty()) {
    currentIconKey = ''
    pendingIcon = null
    return
  }
  let img = plain
  if (currentBadge !== 'none') {
    const marked = nativeImage.createEmpty()
    let ok = false
    const reps: [number, number, string][] = [[1, 22, pendingIcon.png1x], [2, 44, pendingIcon.png2x]]
    for (const [scaleFactor, size, dataURL] of reps) {
      if (!dataURL) continue
      const buf = badgeBuffer(dataURL, size, currentBadge)
      if (!buf) continue
      marked.addRepresentation({ scaleFactor, width: size, height: size, buffer: buf })
      ok = true
    }
    // 画失败就退回未加点的图：状态点是增值信号，logo 本体才是主体
    if (ok && !marked.isEmpty()) img = marked
  }
  if (process.platform === 'darwin') img.setTemplateImage(true)
  iconCache.set(cacheKey, img)
  currentImage = img
  appliedIconKey = cacheKey
  tray.setImage(img)
}

export function updateTray(snapshots: ProviderSnapshot[], meta?: { offline?: boolean }): void {
  if (!tray) return
  const offline = !!meta?.offline
  if (process.platform === 'darwin') {
    lastTitle = trayTitle(snapshots, offline)
    tray.setTitle(lastTitle, { fontType: 'monospacedDigit' })
  }
  // 状态点跟着标题判同一个等级（两处信号不允许一个红一个绿）
  const nextLevel = trayLevel(snapshots)
  const nextBadge = badgeOf(nextLevel)
  // ⚠ `currentLevel` 无条件更新：`trayBadgeInfo()` 报的就是它，写在条件里的话
  //   一旦有人让两个等级共用一个形状（badgeOf 不再单射），观测点就会开始报过期值。
  //   `applyTrayIcon` 只在形状真的变了时才动手 —— 它自己按 appliedIconKey 去重。
  currentLevel = nextLevel
  if (nextBadge !== currentBadge) {
    currentBadge = nextBadge
    applyTrayIcon()
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

/**
 * 测试观测点：图标等级与状态点形状。
 *
 * 为什么单开一条通道（`trayImageInfo` 只被 --smoke 用）：图标分层是本任务的核心交付物，
 * 模板图标的颜色在 macOS 上**根本不可见**（RGB 被系统丢弃），等级只能靠这个返回值
 * 证明真的落到图上了 —— 少了它就只剩「逻辑测了、界面没人验证」。
 * `iconKey` 带 `#形状` 后缀：换级时它必须变，不变就说明去重把新图标吞了。
 */
export function trayBadgeInfo(): { level: Level; shape: BadgeShape; iconKey: string } {
  return { level: currentLevel, shape: currentBadge, iconKey: appliedIconKey }
}
