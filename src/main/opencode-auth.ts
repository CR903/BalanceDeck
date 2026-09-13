import { BrowserWindow, session } from 'electron'
import type { Session } from 'electron'

// ═══════════════════════════════════════════════════════════════════════════════
// OpenCode 网页授权：内嵌浏览器窗口登录 → 自动抓取控制台 cookie + workspace id
//
// 流程：
//   1. 打开独立会话（非持久分区）的授权窗口，指向 opencode.ai 登录页
//   2. 用户在窗口内正常登录（支持 OAuth 弹窗）
//   3. 轮询该会话的 cookie：出现 auth 后继续解析 workspace id
//      - 优先从窗口 URL（/workspace/<wrk>/...）
//      - 其次从页面 HTML（控制台任何链接都含 wrk_）
//      - 兜底：用 cookie 直接请求控制台首页正则匹配
//   4. 拿到两者 → 关闭窗口、清空分区、返回结果（cookie 只回主进程，不进日志）
//
// 安全：分区非持久（内存态），抓取后立即 clearStorageData；
//      唯一的持久副本是 safeStorage 加密后的 secrets.bin。
// ═══════════════════════════════════════════════════════════════════════════════

const PARTITION = 'persist:opencode-auth' // 持久分区：登录一次后记住，再次授权免登录
const LOGIN_URL = 'https://opencode.ai/auth'
const POLL_MS = 900
const TIMEOUT_MS = 5 * 60_000

export interface OpencodeAuthResult {
  ok: boolean
  cookie?: string
  workspaceId?: string
  /** 用户可见的失败原因（绝不包含 cookie 内容） */
  error?: string
}

let authWin: BrowserWindow | null = null
let inflight: Promise<OpencodeAuthResult> | null = null

/** 当前是否有授权窗口在等待（渲染层用于显示状态） */
export function isOpencodeAuthRunning(): boolean {
  return !!authWin
}

/** 从任意 HTML 文本里找 workspace id（控制台链接形如 /workspace/wrk_xxx/go） */
function findWorkspaceId(text: string): string | null {
  const m = text.match(/wrk_[A-Za-z0-9]{8,}/)
  return m ? m[0] : null
}

/**
 * 把分区里的 cookie 拼成控制台请求头。
 * 只取 `opencode.ai` 域（排除 `auth.opencode.ai` 等子域），但**保留该域全部 cookie** ——
 * 浏览器就是全发的；只留 auth 会在站点新增依赖 cookie 时失效。
 */
function buildCookieHeader(cookies: { name: string; value: string; domain?: string }[]): string | null {
  const relevant = cookies.filter((c) => {
    const d = (c.domain || '').replace(/^\./, '')
    return d === 'opencode.ai' && !!c.name && !!c.value
  })
  if (!relevant.some((c) => c.name === 'auth')) return null
  return relevant.map((c) => `${c.name}=${c.value}`).join('; ')
}

/**
 * 验证 cookie 是否真的能读到用量页。
 * 必要性：登录过程中会短暂出现"中间态"cookie（长度/值都与最终态不同），
 * 存下来后请求会 302 到登录页 —— 必须验证通过才算成功。
 */
async function verifyCookie(cookie: string, workspaceId: string): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    const res = await fetch(`https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`, {
      headers: { Cookie: cookie, Accept: 'text/html' },
      redirect: 'manual',
      signal: ctrl.signal
    })
    clearTimeout(timer)
    if (res.status !== 200) return false
    const html = await res.text()
    return html.includes('usage-item')
  } catch {
    return false
  }
}

/** 兜底：带 cookie 请求控制台页面，从 HTML 里正则出 workspace id */
async function discoverWorkspace(cookie: string): Promise<string | null> {
  for (const url of ['https://opencode.ai/workspace', 'https://opencode.ai/dashboard', 'https://opencode.ai/']) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8000)
      const res = await fetch(url, {
        headers: { Cookie: cookie, Accept: 'text/html' },
        redirect: 'follow',
        signal: ctrl.signal
      })
      clearTimeout(timer)
      if (!res.ok) continue
      const id = findWorkspaceId(await res.text())
      if (id) return id
    } catch {
      // 试下一个
    }
  }
  return null
}

/**
 * 打开授权窗口，返回抓取结果。
 * 同一时刻只允许一个授权流程（重复调用返回同一个 Promise）。
 */
export function startOpencodeAuth(): Promise<OpencodeAuthResult> {
  if (inflight) {
    authWin?.focus()
    return inflight
  }
  inflight = runAuth().finally(() => {
    inflight = null
  })
  return inflight
}

/** 用户主动取消（渲染层「取消」按钮） */
export function cancelOpencodeAuth(): void {
  authWin?.close()
}

/**
 * 读取授权分区里的实时 cookie（拼接，不验证）。
 *
 * ⚠️ 为什么必须用分区而不是保存的那份：服务端会在**每次响应**轮换 session cookie
 * （iron-session 行为），保存下来的副本永远慢一步 → 下次请求必然被判失效。
 * 分区由浏览器会话自动跟随轮换，是唯一可靠的来源。
 */
export async function readPartitionCookie(): Promise<string | null> {
  try {
    const ses = session.fromPartition(PARTITION)
    return buildCookieHeader(await ses.cookies.get({ domain: 'opencode.ai' }))
  } catch {
    return null
  }
}

/**
 * 读取授权分区里的实时 cookie 并验证。
 * 用途：已保存的 cookie 可能因服务端轮换而失效；只要授权窗口的会话还在，
 * 就能静默刷新，无需用户重新登录。
 */
export async function readLiveCookie(workspaceId: string): Promise<string | null> {
  if (!workspaceId) return null
  try {
    const cookie = await readPartitionCookie()
    if (!cookie) return null
    return (await verifyCookie(cookie, workspaceId)) ? cookie : null
  } catch {
    return null
  }
}

async function runAuth(): Promise<OpencodeAuthResult> {
  const ses: Session = session.fromPartition(PARTITION)

  return new Promise<OpencodeAuthResult>((resolve) => {
    let settled = false
    let poll: NodeJS.Timeout | null = null
    let timeout: NodeJS.Timeout | null = null
    let scanning = false
    let discoveredWorkspace = ''

    // 注意：不清空分区 —— 持久会话让"已登录过"的用户下次授权秒过
    const cleanup = async (): Promise<void> => {
      if (poll) clearInterval(poll)
      if (timeout) clearTimeout(timeout)
      poll = null
      timeout = null
      const w = authWin
      authWin = null
      try {
        if (w && !w.isDestroyed()) w.close()
      } catch {
        // 忽略
      }
    }

    const finish = (r: OpencodeAuthResult): void => {
      if (settled) return
      settled = true
      void cleanup().then(() => resolve(r))
    }

    try {
      authWin = new BrowserWindow({
        width: 520,
        height: 760,
        title: '登录 OpenCode',
        autoHideMenuBar: true,
        minimizable: false,
        maximizable: false,
        webPreferences: {
          partition: PARTITION,
          nodeIntegration: false,
          contextIsolation: true,
          // 登录页可能用 OAuth 弹窗，允许新窗口并复用同一分区
          webSecurity: true
        }
      })
    } catch (e) {
      finish({ ok: false, error: `无法打开授权窗口：${(e as Error).message}` })
      return
    }

    const win = authWin

    // OAuth 弹窗（GitHub / Google）：允许，并同样纳入 URL 观察
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\/([a-z0-9-]+\.)?(opencode\.ai|github\.com|accounts\.google\.com|google\.com)/i.test(url)) {
        return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true } }
      }
      return { action: 'deny' }
    })

    // 从当前窗口 URL 抓 workspace id
    const noteUrl = (url: string): void => {
      const id = findWorkspaceId(url)
      if (id) discoveredWorkspace = id
    }
    win.webContents.on('did-navigate', (_e, url) => noteUrl(url))
    win.webContents.on('did-navigate-in-page', (_e, url) => noteUrl(url))

    win.on('closed', () => {
      if (!settled) finish({ ok: false, error: '已取消登录' })
    })

    // 轮询：cookie 出现后尝试凑齐 cookie + workspace，然后收工
    const scan = async (): Promise<void> => {
      if (settled || scanning) return
      scanning = true
      try {
        const cookies = await ses.cookies.get({ domain: 'opencode.ai' })
        const cookie = buildCookieHeader(cookies)
        if (!cookie) return

        // workspace 来源 ①：窗口 URL（含 OAuth 弹窗所在窗口）
        if (!discoveredWorkspace) {
          for (const w of BrowserWindow.getAllWindows()) {
            if (w.isDestroyed()) continue
            noteUrl(w.webContents.getURL())
          }
        }
        // workspace 来源 ②：页面 HTML（登录后落地页通常含控制台链接）
        if (!discoveredWorkspace && win && !win.isDestroyed()) {
          try {
            const html = (await win.webContents.executeJavaScript('document.documentElement.innerHTML', true)) as string
            discoveredWorkspace = findWorkspaceId(html) ?? ''
          } catch {
            // 页面尚未就绪
          }
        }
        // workspace 来源 ③：带 cookie 请求控制台首页
        if (!discoveredWorkspace) {
          discoveredWorkspace = (await discoverWorkspace(cookie)) ?? ''
        }

        if (discoveredWorkspace) {
          // 关键：验证 cookie 真能读到用量页才收工（登录过程会出现中间态 cookie）
          if (await verifyCookie(cookie, discoveredWorkspace)) {
            finish({ ok: true, cookie, workspaceId: discoveredWorkspace })
          }
          // 验证失败则继续轮询，等最终态 cookie
        }
      } catch {
        // 忽略单轮错误
      } finally {
        scanning = false
      }
    }

    poll = setInterval(() => void scan(), POLL_MS)
    timeout = setTimeout(() => finish({ ok: false, error: '登录超时（5 分钟）' }), TIMEOUT_MS)

    void win.loadURL(LOGIN_URL).catch(() => {
      finish({ ok: false, error: '无法访问 opencode.ai（检查网络）' })
    })
  })
}
