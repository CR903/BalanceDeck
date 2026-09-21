import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppState,
  SkinInfo,
  ProvidersPayload,
  ProviderPatch,
  AddProviderPayload,
  CatalogEntry,
  OpencodeAuthResponse,
  PetMenuModel,
  PetHitbox
} from '../shared/types'

const api = {
  getState: (): Promise<AppState> => ipcRenderer.invoke('state:get'),
  onState: (cb: (s: AppState) => void): (() => void) => {
    const l = (_e: unknown, s: AppState): void => cb(s)
    ipcRenderer.on('state:snapshot', l)
    return () => ipcRenderer.removeListener('state:snapshot', l)
  },
  collapse: (): void => ipcRenderer.send('ui:collapse'),
  expand: (): void => ipcRenderer.send('ui:expand'),
  dragStart: (grab?: { x: number; y: number }): void => ipcRenderer.send('ui:drag-start', grab),
  dragEnd: (): void => ipcRenderer.send('ui:drag-end'),
  debugDragState: (): Promise<boolean> => ipcRenderer.invoke('debug:drag-state'),
  refreshNow: (): Promise<void> => ipcRenderer.invoke('ui:refresh'),
  onCollapsed: (cb: (c: boolean) => void): (() => void) => {
    const l = (_e: unknown, c: boolean): void => cb(c)
    ipcRenderer.on('ui:collapsed', l)
    return () => ipcRenderer.removeListener('ui:collapsed', l)
  },

  // ─── 供应商实例管理 ────────────────────────────────────────────────────────
  listProviders: (): Promise<ProvidersPayload> => ipcRenderer.invoke('providers:list'),
  listCatalog: (): Promise<CatalogEntry[]> => ipcRenderer.invoke('providers:catalog'),
  updateProvider: (patch: ProviderPatch): Promise<ProvidersPayload> =>
    ipcRenderer.invoke('providers:update', patch),
  addProvider: (p: AddProviderPayload): Promise<ProvidersPayload> => ipcRenderer.invoke('providers:add', p),
  removeProvider: (id: string): Promise<ProvidersPayload> => ipcRenderer.invoke('providers:remove', id),
  reorderProviders: (ids: string[]): Promise<ProvidersPayload> => ipcRenderer.invoke('providers:reorder', ids),
  setTrayIcon: (key: string, png1x: string, png2x: string): void =>
    ipcRenderer.send('tray:icon', key, png1x, png2x),
  startOpencodeAuth: (): Promise<OpencodeAuthResponse> => ipcRenderer.invoke('opencode:auth'),
  cancelOpencodeAuth: (): void => ipcRenderer.send('opencode:auth-cancel'),
  openOpencodeConsole: (): Promise<void> => ipcRenderer.invoke('opencode:open-console'),
  getExtras: (keys: string[]): Promise<Record<string, string>> => ipcRenderer.invoke('extras:get', keys),
  setExtras: (patch: Record<string, string>): Promise<void> => ipcRenderer.invoke('extras:set', patch),

  // ─── 测试观测点（仅 --uitest 时主进程侧注册）──────────────────────────────
  debugPush: (snapshots: unknown, offline?: boolean): Promise<void> =>
    ipcRenderer.invoke('debug:push', snapshots, offline === true),
  debugTrayTitle: (): Promise<string> => ipcRenderer.invoke('debug:tray-title'),
  /** 托盘交互模式：macOS 应为 click-toggle（左键直接显隐，右键菜单） */
  debugTrayMode: (): Promise<string> => ipcRenderer.invoke('debug:tray-mode'),

  // ─── 皮肤 ──────────────────────────────────────────────────────────────────
  listSkins: (): Promise<SkinInfo[]> => ipcRenderer.invoke('skins:list'),
  getSkinCss: (id: string): Promise<string | null> => ipcRenderer.invoke('skins:css', id),
  currentSkin: (): Promise<string> => ipcRenderer.invoke('skins:current'),
  openSkinMenu: (): void => ipcRenderer.send('skins:openMenu'),
  setSkin: (id: string): void => ipcRenderer.send('skins:set', id),
  onSkin: (cb: (id: string) => void): (() => void) => {
    const l = (_e: unknown, id: string): void => cb(id)
    ipcRenderer.on('ui:skin', l)
    return () => ipcRenderer.removeListener('ui:skin', l)
  },

  // ─── 系统 ──────────────────────────────────────────────────────────────────
  getAutostart: (): Promise<boolean> => ipcRenderer.invoke('autostart:get'),
  setAutostart: (open: boolean): Promise<boolean> => ipcRenderer.invoke('autostart:set', open),
  /** 系统登录项里是否残留本应用（本开关无法移除，需用户手动清理） */
  hasForeignLoginItem: (): Promise<boolean> => ipcRenderer.invoke('autostart:foreign'),

  // ─── 收起态 3D 悬浮物（球 / 个性人物）──────────────────────────────────────
  /** 右键菜单：把菜单模型交给主进程弹原生菜单，回传选中项 id（未选中返回 null） */
  petMenu: (model: PetMenuModel): Promise<string | null> => ipcRenderer.invoke('pet:menu', model),
  /** 收起态形态：true = 个性人物（人物独立站着），false = 3D 悬浮球 */
  setPetFigure: (figure: boolean): void => ipcRenderer.send('pet:mode', figure === true),
  /** 总在最前开关 */
  setAlwaysOnTop: (on: boolean): void => ipcRenderer.send('ui:always-on-top', on !== false),
  /** 命中框（窗口内 CSS 像素）：主体以外的区域由主进程设为鼠标穿透 */
  setPetHitbox: (rect: PetHitbox): void => ipcRenderer.send('pet:hitbox', rect),
  /** 测试观测点：穿透/光标轮询状态（仅测试模式注册） */
  debugPetState: (): Promise<{
    ignore: boolean
    collapsed: boolean
    /** 光标轮询是否在跑（= 收起态） */
    roaming: boolean
    shadow: boolean
    figure: boolean
    alwaysOnTop: boolean
  }> =>
    ipcRenderer.invoke('debug:pet-state'),
  /** 测试观测点：设置置顶（仅测试模式注册） */
  debugSetTop: (on: boolean): Promise<{ figure: boolean; alwaysOnTop: boolean }> =>
    ipcRenderer.invoke('debug:set-top', on),
  /** 光标是否悬停在球上（主进程轮询回传） */
  onPetCursor: (cb: (over: boolean) => void): (() => void) => {
    const l = (_e: unknown, over: boolean): void => cb(over)
    ipcRenderer.on('pet:cursor', l)
    return () => ipcRenderer.removeListener('pet:cursor', l)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
