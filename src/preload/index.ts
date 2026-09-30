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

  // ─── TTS 自定义服务密钥（加密存储，不走上面的 getExtras/setExtras）─────────
  /** 写入某个 TTS 服务的认证 token（空串 = 删除）；主进程落 items（密文），非 extras */
  setTtsSecret: (id: string, value: string): Promise<void> =>
    ipcRenderer.invoke('tts:setSecret', id, value),
  /**
   * 是否配置过认证 token。**只有布尔过进程**（FR6）：明文取回来给渲染层拼 Authorization
   * 头是本任务下线的旧行为 —— 请求已搬进主进程，拼头也归主进程。
   */
  ttsHasSecret: (id: string): Promise<boolean> => ipcRenderer.invoke('tts:hasSecret', id),

  // ─── TTS 出网（渲染层 CSP 禁止外连，播报只能从主进程走）───────────────────
  /**
   * 让主进程向用户配置的 TTS 服务发一次请求，回传**音频字节**。
   *
   * 失败 reject 一个 `message` 就是原因码的 Error（Electron IPC 只透传 message，
   * 所以码必须写进 message）：`TTS_UNREACHABLE`（DNS/连接/超时）、
   * `TTS_HTTP_<n>`（服务返回非 2xx）。渲染层 `speechOut.ts` 据此决定重不重试。
   */
  ttsSpeak: (req: { url: string; headers: Record<string, string>; body: string }): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('tts:speak', req),

  // ─── 系统通知（主进程弹；渲染层只送判定结果与文案）───────────────────────
  /**
   * 弹一条系统通知（macOS 通知中心 / Windows Toast）。
   *
   * 判定在渲染层的 systemNotify.ts（纯函数），弹出必须在主进程：`Notification` 是
   * 主进程 API。返回是否真的弹出去了 —— 载荷不合法（标题/正文为空、档位未知）或系统
   * 不支持时为 false，主进程只记一条日志不抛。
   *
   * ⚠ 载荷形状在这里**只写一份**：渲染层的 `window.api` 类型是从本文件推导的
   *   （api.d.ts 注释：preload 没实现的方法，渲染层连类型都没有），所以这一处与
   *   `NotifyPayload` 结构不兼容时 tsc 会当场报错，而不是等运行时静默失效。
   */
  notifyShow: (payload: {
    id: string
    name: string
    title: string
    body: string
    level: 'warn' | 'high' | 'reset'
  }): Promise<boolean> => ipcRenderer.invoke('notify:show', payload),

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
  /** 收起态形态：true = 个性人物（人物独立站着），false = 2D 小圆环 */
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
