import { ipcMain } from 'electron'
import { setCollapsed, getOverlay, dragStart, dragStop } from './overlay'
import { refreshNow, currentState, resort, reconfigure, debugPush } from './scheduler'
import { setTrayIcon, trayInteractionMode } from './tray'
import { getAutostart, setAutostart, hasSystemLoginItem } from './autostart'
import { trayTitle } from '../shared/tray-text'
import { getKey, setKey, setExtra, getExtra } from './keystore'
import { scanEnv } from './scanner'
import { listSkins, readSkinCss, openSkinMenu, setSkin, currentSkinId } from './skins'
import {
  listProviders,
  listCatalog,
  addInstance,
  removeInstance,
  setInstanceEnabled,
  setInstanceBaseUrl,
  setInstanceName,
  reorderInstances,
  listInstances
} from './providers'
import { startOpencodeAuth, cancelOpencodeAuth } from './opencode-auth'
import type { ProviderPatch, AddProviderPayload, ProvidersPayload } from '../shared/types'

// 测试观测点：dragStart 是否被触发过（--uitest 用）
let dragFired = false

/** 读取并复位拖拽触发标记（测试用） */
export function consumeDragFired(): boolean {
  const v = dragFired
  dragFired = false
  return v
}

/** 供应商列表 + 环境变量扫描提示 */
async function providersPayload(): Promise<ProvidersPayload> {
  const providers = await listProviders()
  const hits = scanEnv().map((h) => ({ providerId: h.providerId, source: h.source }))
  return { providers, scanHits: hits }
}

export function registerIpc(): void {
  ipcMain.handle('debug:drag-state', () => consumeDragFired())
  ipcMain.handle('state:get', () => currentState())

  ipcMain.on('ui:collapse', () => {
    dragStop()
    setCollapsed(true)
  })
  ipcMain.on('ui:expand', () => {
    dragStop()
    setCollapsed(false)
  })
  ipcMain.on('ui:drag-start', () => {
    dragFired = true
    dragStart()
  })
  ipcMain.on('ui:drag-end', () => dragStop())

  ipcMain.handle('ui:refresh', async () => {
    refreshNow()
  })

  // ─── 供应商实例管理 ────────────────────────────────────────────────────────

  ipcMain.handle('providers:list', () => providersPayload())

  ipcMain.handle('providers:catalog', () => listCatalog())

  ipcMain.handle('providers:update', async (_e, patch: ProviderPatch) => {
    if (!patch || typeof patch.id !== 'string' || !patch.id) return providersPayload()
    const id = patch.id
    if (typeof patch.enabled === 'boolean') {
      await setInstanceEnabled(id, patch.enabled)
    }
    if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) {
      await setInstanceBaseUrl(id, patch.baseUrl.trim())
    }
    if (typeof patch.name === 'string' && patch.name.trim()) {
      await setInstanceName(id, patch.name.trim())
    }
    if (patch.clearKey) {
      await setKey(id, '')
    } else if (typeof patch.key === 'string' && patch.key.trim()) {
      await setKey(id, patch.key.trim())
    }
    // OpenCode 控制台 cookie（全局凭据，用于获取与控制台一致的小数精度）
    if (typeof patch.cookie === 'string' && patch.cookie.trim()) {
      const { normalizeCookie } = await import('./adapters/opencode-cookie')
      const normalized = normalizeCookie(patch.cookie)
      if (normalized) await setKey('opencodeCookie', normalized)
    }
    if (typeof patch.workspaceId === 'string' && patch.workspaceId.trim()) {
      await setExtra('opencodeWorkspaceId', patch.workspaceId.trim())
    }
    refreshNow()
    return providersPayload()
  })

  ipcMain.handle('providers:add', async (_e, p: AddProviderPayload) => {
    const presetId = typeof p?.presetId === 'string' && p.presetId ? p.presetId : undefined
    const protocol = typeof p?.protocol === 'string' && p.protocol ? p.protocol : undefined
    if (!presetId && !protocol) return providersPayload()
    const inst = await addInstance({
      presetId,
      protocol,
      name: typeof p?.name === 'string' ? p.name : undefined,
      baseUrl: typeof p?.baseUrl === 'string' ? p.baseUrl : undefined
    })
    if (typeof p?.key === 'string' && p.key.trim()) {
      await setKey(inst.id, p.key.trim())
    }
    refreshNow()
    return providersPayload()
  })

  ipcMain.handle('providers:remove', async (_e, id: string) => {
    if (typeof id !== 'string' || !id) return providersPayload()
    await removeInstance(id)
    refreshNow()
    return providersPayload()
  })

  // 拖拽排序：持久化顺序并立即重排已推送的快照（无需重新采集）
  ipcMain.handle('providers:reorder', async (_e, ids: string[]) => {
    if (Array.isArray(ids) && ids.every((x) => typeof x === 'string')) {
      const changed = await reorderInstances(ids)
      if (changed) resort(ids)
    }
    return providersPayload()
  })

  // ─── OpenCode 网页授权（内嵌浏览器登录 → 自动抓取 cookie + workspace id）──

  ipcMain.handle('opencode:auth', async () => {
    const r = await startOpencodeAuth()
    if (!r.ok || !r.cookie || !r.workspaceId) {
      return { ok: false, error: r.error ?? '登录未完成' }
    }
    const { normalizeCookie } = await import('./adapters/opencode-cookie')
    const normalized = normalizeCookie(r.cookie)
    if (!normalized) return { ok: false, error: 'Cookie 格式无效，请重试' }
    await setKey('opencodeCookie', normalized)
    await setExtra('opencodeWorkspaceId', r.workspaceId)
    refreshNow()
    return { ok: true, workspaceId: r.workspaceId, providers: await providersPayload() }
  })

  ipcMain.on('opencode:auth-cancel', () => cancelOpencodeAuth())

  // 在系统默认浏览器中打开控制台用量页（方便用户手动复制 cookie）
  ipcMain.handle('opencode:open-console', async () => {
    const { shell } = await import('electron')
    const wid = (await getExtra('opencodeWorkspaceId')) ?? process.env.OPENCODE_GO_WORKSPACE_ID ?? ''
    const url = wid ? `https://opencode.ai/workspace/${wid}/go` : 'https://opencode.ai/auth'
    await shell.openExternal(url)
  })

  // ─── 通用偏好（皮肤 / 刷新频率等非敏感 extras）────────────────────────────

  ipcMain.handle('extras:get', async (_e, keys: string[]) => {
    const out: Record<string, string> = {}
    for (const k of Array.isArray(keys) ? keys : []) {
      out[k] = (await getExtra(k)) ?? ''
    }
    return out
  })

  ipcMain.handle('extras:set', async (_e, patch: Record<string, string>) => {
    let touchedInterval = false
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (typeof v === 'string') await setExtra(k, v.trim())
      if (k === 'refreshInterval' || k === 'interval:plan' || k === 'interval:balance') touchedInterval = true
    }
    // 频率变更需重排定时器（否则最长要等一整轮才生效）
    if (touchedInterval) reconfigure()
    // 纯界面偏好（ui:*，如隐藏余额）不触发采集，避免无畏的网络请求
    else if (!Object.keys(patch ?? {}).every((k) => k.startsWith('ui:'))) refreshNow()
  })

  // ─── 托盘图标（渲染层栅格化的供应商 logo，template PNG）────────────────────

  ipcMain.on('tray:icon', (_e, key: string, png1x: string, png2x: string) => {
    if (typeof key === 'string') setTrayIcon(key, String(png1x ?? ''), String(png2x ?? ''))
  })

  // ─── 皮肤 ──────────────────────────────────────────────────────────────────

  ipcMain.handle('skins:list', () => listSkins())
  ipcMain.handle('skins:css', (_e, id: string) => readSkinCss(id))
  ipcMain.handle('skins:current', () => currentSkinId())
  ipcMain.on('skins:openMenu', () => openSkinMenu())
  ipcMain.on('skins:set', (_e, id: string) => {
    if (typeof id === 'string' && id) void setSkin(id)
  })

  // ─── 开机自启（macOS 走 LaunchAgent，Windows 走 LoginItem API）──────────────

  ipcMain.handle('autostart:get', () => getAutostart())
  ipcMain.handle('autostart:set', (_e, open: boolean) => setAutostart(!!open))
  // 系统里是否有本开关管不到的旧登录项（提示用户手动清理）
  ipcMain.handle('autostart:foreign', () => hasSystemLoginItem())

  // ─── 宠物数据迁移（本地文件读写，仅在用户显式点击时触发）────────────────────

  ipcMain.handle('pet:export', async (_e, payload: string) => {
    const { dialog } = await import('electron')
    const { writeFileSync } = await import('fs')
    const opts: Electron.SaveDialogOptions = {
      title: '导出宠物数据',
      defaultPath: 'balancedeck-pet.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    }
    const win = getOverlay()
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return { ok: false, canceled: true }
    try {
      writeFileSync(r.filePath, String(payload ?? ''), 'utf-8')
      return { ok: true, path: r.filePath }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('pet:import', async () => {
    const { dialog } = await import('electron')
    const { readFileSync } = await import('fs')
    const opts: Electron.OpenDialogOptions = {
      title: '导入宠物数据',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    }
    const win = getOverlay()
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths?.[0]) return { ok: false, canceled: true }
    try {
      return { ok: true, text: readFileSync(r.filePaths[0], 'utf-8') }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // ─── 测试观测点（仅 --uitest 注册；生产运行时不暴露任何注入能力）──────────

  if (process.argv.includes('--uitest') || process.argv.includes('--shots')) {
    // 注入受控快照，用于验证"缓存 / 本机估算 / 出错"等降级渲染分支
    ipcMain.handle('debug:push', (_e, snapshots: unknown, offline: unknown) => {
      if (Array.isArray(snapshots)) debugPush(snapshots as never, offline === true)
    })
    // 托盘标题在渲染层不可见，只能由主进程回传（验证状态栏文案）
    ipcMain.handle('debug:tray-title', () => trayTitle(currentState().snapshots, !!currentState().offline))
    // 托盘交互模式：macOS 必须是 click-toggle（左键直接显隐；右键才弹菜单）
    ipcMain.handle('debug:tray-mode', () => trayInteractionMode())
  }

  // 渲染进程申请打开设置视图时，确保窗口处于展开态（由 renderer 直接切视图）
  ipcMain.on('settings:openView', () => {
    getOverlay()?.webContents.send('ui:open-settings')
  })
}
