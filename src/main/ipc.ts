import { ipcMain } from 'electron'
import {
  setCollapsed,
  getOverlay,
  dragStart,
  dragStop,
  setPetHitbox,
  petIgnoreState,
  setPetFigure,
  setAlwaysOnTopPref,
  petWindowState
} from './overlay'
import { refreshNow, currentState, resort, reconfigure, debugPush } from './scheduler'
import { setTrayIcon, trayInteractionMode } from './tray'
import { getAutostart, setAutostart, hasSystemLoginItem } from './autostart'
import { trayTitle } from '../shared/tray-text'
import { getKey, setKey, setExtra, getExtra } from './keystore'
import { assertNetAvailable, markNetResult } from './net'
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
import type { ProviderPatch, AddProviderPayload, ProvidersPayload, PetMenuModel } from '../shared/types'

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

/**
 * TTS 自定义服务的密钥存储键名；id 不合法时返回 null（调用方按"没这条配置"处理）。
 *
 * 为什么要单独一个函数：凭据只有两条路，且**两个命名空间互不相通** ——
 * `setKey`/`getKey` → `items`（safeStorage 加密落盘），
 * `setExtra`/`getExtra` → `extras`（明文，state-management.md:208-217）。
 * preload 只暴露了 getExtras/setExtras，所以自定义 TTS 的 token 只能从这里走；
 * 图省事写进 extras 就等于把 token 明文留在磁盘上，且混用两个命名空间是**静默失败**
 * （写进去读出来都是 null，界面只会显示"未配置"）。
 *
 * id 会被拼进存储键名，因此必须校验：只放行 `[A-Za-z0-9_-]` 且长度 1..64。
 * 渲染层是不可信输入（type-safety.md §D 逐字段复验），一个 `../` 或冒号就能往
 * keyspace 里塞脏键、或构造出与别的条目（实例 id 形如 `inst:xxx-yyy`）撞车的键名。
 * 校验后 id 内无冒号，拼出的键恒为 `tts:secret:` + 安全字符，与其它命名空间不可能相撞。
 */
function ttsSecretKey(id: unknown): string | null {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null
  return `tts:secret:${id}`
}

/**
 * 主进程发出一次 TTS 请求的超时（毫秒）。
 *
 * 与 `request.ts` 的采集默认值同为 12s —— 出网超时在本仓库只有一个数量级，
 * 别让播报这条链自己长出一个数。渲染层 `speechOut.ts` 另有一个 15s 的**看门超时**，
 * 那条守的不是 socket 而是 IPC 本身（invoke 永不结算会把 flush 的 draining 闩卡死），
 * 因此必须**大于**这里的值：小于它就等于把自己的超时当成了主进程的超时。
 */
const TTS_TIMEOUT_MS = 12_000

/**
 * 系统通知的档位全集。渲染层那份在 `renderer/src/systemNotify.ts`（`NOTIFY_LEVELS`）——
 * 两边没有共享模块（文件所有权不许新增 shared 文件），所以由
 * `scripts/test-system-notify.mjs` 静态比对两侧字面量，与 F5 对原因码的处理同套路。
 */
const NOTIFY_LEVELS = ['warn', 'high', 'reset']

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
  // 拖拽起点：渲染层给出抓取点（球在窗口内的位置），避免拖动时球跳到光标中心
  ipcMain.on('ui:drag-start', (_e, grab?: { x: number; y: number }) => {
    dragFired = true
    dragStart(grab && typeof grab.x === 'number' && typeof grab.y === 'number' ? grab : undefined)
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
  //
  // 2026-09-26：控制台重写为纯客户端 SPA，旧的 `/workspace/<wid>/go` 已 302 到登录页、
  // `/auth` 也只是 302 到 `/console/login`。两个分支都要跟着搬到 `/console` 形状。
  ipcMain.handle('opencode:open-console', async () => {
    const { shell } = await import('electron')
    const { CONSOLE_ORIGIN } = await import('./adapters/opencode-console-api')
    const wid = (await getExtra('opencodeWorkspaceId')) ?? process.env.OPENCODE_GO_WORKSPACE_ID ?? ''
    const url = wid ? `${CONSOLE_ORIGIN}/workspace/${wid}/go` : `${CONSOLE_ORIGIN}/login`
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

  // ─── TTS 自定义服务密钥（走加密 items；⛔ 禁止写 extras）────────────────────
  //
  // 紧挨着上面的 extras 段放，是为了留住这条对照：**不是所有偏好都能进 extras**。
  // URL / 音色 / 开关这些是偏好（`ui:ttsConfig` 等，落 extras）；token 是凭据，
  // 落 items（safeStorage 加密）。键名构造与 id 校验见 ttsSecretKey()。

  // 写 token。value 为空串 = 删除（setKey('') 本身就是删除，store.ts:70-71，
  // 所以"清空输入框"不需要额外分支）。id 不合法则静默忽略，不抛错也不回写。
  ipcMain.handle('tts:setSecret', async (_e, id: string, value: string) => {
    const key = ttsSecretKey(id)
    if (!key) return
    await setKey(key, typeof value === 'string' ? value.trim() : '')
  })

  // ─── TTS 播报请求（主进程出网 + token 收口）────────────────────────────────
  //
  // 为什么播报也走主进程：渲染层 CSP `connect-src 'self' data: blob: bd-asset:` 拦住一切
  // 外部 fetch（index.html，红线不许改），所以 speechOut.ts 里的 fetch 从未到过网络 ——
  // 这也是父任务三轮「实测」全错的根因（curl 不受 CSP 约束）。这里照 request.ts 的
  // **模式**（AbortController 超时 + markNetResult 记账）重写一个专用 handler，而不是
  // 复用 request()：后者强制 res.text()，音频是二进制，text() 会损坏。
  //
  // 失败分类（原因码跨 IPC 传递的机制：不靠 Error.name —— Electron 只透传 message）：
  //   · DNS / 连接 / 超时      → Error('TTS_UNREACHABLE')     渲染层置不可达 + 排自愈探测
  //   · 服务返回非 2xx          → Error(`TTS_HTTP_${status}`)  401/403 不重试，其余重试 1 次
  // 码的**字面量在渲染层 speechOut.ts 与这里**各有一份，但由 test-structure.mjs F5 静态
  // 钉住两侧一致 —— 这是「没有共享模块」下防止两份漂移的既有做法（与 E3/E5 同套路）。
  // 文件所有权（implement.md）不许新增 shared 文件，故不抽共享常量。

  // 读 token 的 `tts:getSecret` **已随本次任务下线**（2026-09-29 `09-29-tts-request-to-main`）。
  //
  // 它存在的理由是「给渲染层的 fetch 拼 Authorization 头」，而那正是本任务要修的架构错位：
  // 渲染层 CSP 根本不让 fetch 出网，拿到明文也拼不出一个到得了网络的请求。请求搬进主进程
  // 之后，token 的读与拼头都在这里完成（见下面的 `tts:speak`），渲染层只需要知道
  // **有没有**配置过 —— 那由 `tts:hasSecret` 回一个布尔。
  //
  // ⚠ 别以「只是少一次 IPC 往返」为由把它加回来：明文一旦跨进渲染层，FR6
  //   「token 全程留在主进程」就没有结构上的保证，只剩「现在这版没读」。
  //   门禁：test-structure.mjs E5（preload 无 getTtsSecret）+ F6（渲染层无明文通道）。

  // 有没有已存的 token（返回布尔，**不返回明文**）：渲染层只需知道「有没有」，
  // 拿明文回去只会让 PRD FR6「明文不再进渲染层内存」落空。
  ipcMain.handle('tts:hasSecret', async (_e, id: unknown) => {
    const key = ttsSecretKey(id)
    if (!key) return false
    return (await getKey(key)) != null
  })

  // 主进程发出 TTS 请求并回传音频字节。token 由主进程自己拼 Authorization 头，
  // 渲染层只传 url / headers / body，绝不带 token 过来（token 根本不在渲染层内存里）。
  //
  // **认证头以主进程为准**：渲染层传来的 Authorization 一律丢弃（大小写不敏感）。
  // 否则「token 收口」只是一句没有机制的话 —— 任何一段渲染层代码都能塞一个自己的
  // 头进来，而没有 token 的用户（免费服务）会被它悄悄带上一个假身份。
  ipcMain.handle('tts:speak', async (_e, req: unknown): Promise<ArrayBuffer> => {
    const r = (req ?? {}) as { url?: unknown; headers?: unknown; body?: unknown }
    const url = typeof r.url === 'string' ? r.url : ''
    // 只放行 http/https：主进程 fetch 能打任意 scheme，『file:』『javascript:』必须在这里
    // 挡住（渲染层是不可信输入，type-safety.md §D 逐字段复验）。这是防御纵深 ——
    // 正常配置的地址恒为 http(s)。
    if (!/^https?:\/\//i.test(url)) throw new Error('TTS_UNREACHABLE')

    const headers: Record<string, string> = {}
    if (r.headers && typeof r.headers === 'object') {
      for (const [k, v] of Object.entries(r.headers as Record<string, unknown>)) {
        if (typeof v === 'string' && k.toLowerCase() !== 'authorization') headers[k] = v
      }
    }
    // token 收口：这里拼，渲染层永远不用知道明文（FR6 / design.md token 收口）
    const tokenKey = ttsSecretKey('default')
    const token = tokenKey ? await getKey(tokenKey) : null
    if (token) headers['Authorization'] = `Bearer ${token}`

    const body = typeof r.body === 'string' ? r.body : ''

    assertNetAvailable()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TTS_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal })
      // 拿到了响应（含 4xx/5xx）就说明网络通 —— 与 request.ts 同一判定口径
      markNetResult(true)
    } catch (e) {
      // DNS / 连接 / 超时全部归为「不可达」；401/403 是拿到了响应，走下面的 HTTP 分支
      markNetResult(false, e)
      throw new Error('TTS_UNREACHABLE')
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw new Error(`TTS_HTTP_${res.status}`)
    return await res.arrayBuffer()
  })

  // ─── 系统通知（macOS 通知中心 / Windows Toast）───────────────────────────
  //
  // 判定与文案都在渲染层（systemNotify.ts 纯函数），主进程只负责**弹出**：
  // Notification 是主进程 API，渲染层拿不到，而渲染层也压根不该自己拼通知（可测性）。
  //
  // ⚠ payload **逐字段复验**（type-safety §D）：渲染层是信任边界之外的一条通道，
  //   手改 preload 或被注入的代码都能往这里塞任意字符串，而通知标题会直接出现在
  //   操作系统的通知中心里 —— 等于一个任它写的内容投放通道。所以只放行非空字符串，
  //   且档位必须在 NOTIFY_LEVELS 内；不合法就**返回 false 且只记一条日志**，绝不抛异常
  //   （抛出去会变成渲染层一个未处理的 rejection，而用户只看到「没通知」）。
  ipcMain.handle('notify:show', async (_e, payload: unknown): Promise<boolean> => {
    const p = (payload ?? {}) as {
      title?: unknown
      body?: unknown
      level?: unknown
    }
    const title = typeof p.title === 'string' ? p.title.trim() : ''
    const body = typeof p.body === 'string' ? p.body.trim() : ''
    if (!title || !body || typeof p.level !== 'string' || !NOTIFY_LEVELS.includes(p.level)) {
      console.warn('[notify] payload 不合法（title/body 为空或档位未知），已忽略')
      return false
    }
    try {
      const { Notification } = await import('electron')
      // Linux 无通知守护进程 / 未授权时 isSupported() 为 false：直接构造会抛，
      // 而那正是「提醒静默失效」最难查的一种形态
      if (!Notification.isSupported()) {
        console.warn('[notify] 当前系统不支持应用通知（已跳过）')
        return false
      }
      new Notification({ title, body, silent: false }).show()
      return true
    } catch (e) {
      console.warn('[notify] 通知弹出失败：', e)
      return false
    }
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

  // ─── 悬浮球（数字助理 / 球形态）：原生右键菜单 + 鼠标穿透命中框 ─────────────
  //
  // 菜单模型由渲染层给出（它才是助理身份的唯一持有者），主进程只负责渲染原生菜单
  // 并回传选中项 id；动效、落盘、皮肤等业务动作仍在渲染层执行。

  ipcMain.handle('pet:menu', (_e, model: PetMenuModel): Promise<string | null> => {
    return new Promise((resolve) => {
      void (async () => {
        const { Menu } = await import('electron')
        const m: PetMenuModel = {
          title: String(model?.title ?? ''),
          status: String(model?.status ?? ''),
          pets: Array.isArray(model?.pets) ? model.pets : [],
          alwaysOnTop: model?.alwaysOnTop !== false,
          hideBalance: model?.hideBalance === true
        }
        let picked: string | null = null
        const items: Electron.MenuItemConstructorOptions[] = [
          { label: m.title || '数字助理', enabled: false },
          ...(m.status ? [{ label: m.status, enabled: false } as Electron.MenuItemConstructorOptions] : []),
          { type: 'separator' },
          { label: '换一位', enabled: false },
          ...m.pets.map(
            (p): Electron.MenuItemConstructorOptions => ({
              label: p.name,
              type: 'radio',
              checked: p.checked,
              click: () => (picked = `pet:${p.id}`)
            })
          ),
          { label: '改名…', click: () => (picked = 'rename') },
          { type: 'separator' },
          { label: '总在最前', type: 'checkbox', checked: m.alwaysOnTop, click: () => (picked = 'toggle-top') },
          { label: '隐藏余额', type: 'checkbox', checked: m.hideBalance, click: () => (picked = 'toggle-balance') },
          { type: 'separator' },
          { label: '展开面板', click: () => (picked = 'expand') },
          {
            label: '设置…',
            click: () => {
              picked = 'settings'
            }
          }
        ]
        // 菜单关闭后回传选中项（无论是否选中都 resolve，避免渲染层 await 悬挂）
        Menu.buildFromTemplate(items).popup({
          window: getOverlay() ?? undefined,
          callback: () => resolve(picked)
        })
      })()
    })
  })

  // 收起态形态：球（默认） ↔ 个性人物（人物独立站着，窗口更大）
  ipcMain.on('pet:mode', (_e, figure: unknown) => setPetFigure(figure === true))

  // 总在最前：关闭后窗口不再悬浮于其它窗口之上
  ipcMain.on('ui:always-on-top', (_e, on: unknown) => setAlwaysOnTopPref(on !== false))

  ipcMain.on('pet:hitbox', (_e, rect: { x: number; y: number; width: number; height: number } | null) => {
    if (!rect || typeof rect.x !== 'number' || typeof rect.y !== 'number') {
      setPetHitbox(null)
      return
    }
    setPetHitbox({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
  })


  // ─── 测试观测点（仅 --uitest 注册；生产运行时不暴露任何注入能力）──────────

  if (
    process.argv.includes('--uitest') ||
    process.argv.includes('--shots') ||
    process.argv.includes('--ballshot')
  ) {
    // 注入受控快照，用于验证"缓存 / 本机估算 / 出错"等降级渲染分支
    ipcMain.handle('debug:push', (_e, snapshots: unknown, offline: unknown) => {
      if (Array.isArray(snapshots)) debugPush(snapshots as never, offline === true)
    })
    // 托盘标题在渲染层不可见，只能由主进程回传（验证状态栏文案）
    ipcMain.handle('debug:tray-title', () => trayTitle(currentState().snapshots, !!currentState().offline))
    // 托盘交互模式：macOS 必须是 click-toggle（左键直接显隐；右键才弹菜单）
    ipcMain.handle('debug:tray-mode', () => trayInteractionMode())
    // 穿透状态 / 收起态 / 漫游轮询是否在跑（验证球外区域可点到桌面）
    ipcMain.handle('debug:pet-state', () => ({ ...petIgnoreState(), ...petWindowState() }))
    // 设置置顶偏好（uitest 用；生产走渲染层 UI）
    ipcMain.handle('debug:set-top', (_e, on: unknown) => {
      setAlwaysOnTopPref(on !== false)
      return petWindowState()
    })
  }
}
