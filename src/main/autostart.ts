import { app } from 'electron'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

// ═══════════════════════════════════════════════════════════════════════════════
// 开机自启
//
//   Windows — Electron LoginItem API（注册表 Run 键，稳定可靠）。
//   macOS   — LaunchAgent plist（~/Library/LaunchAgents/dev.zhouri.balancedeck.plist）。
//
// ⚠️ 为什么 macOS 不用 app.setLoginItemSettings：
//   实测（macOS 12.7.6 + Electron 37.10.3）该 API 完全不写入系统 BTM 数据库 ——
//   set { openAtLogin } 之后 get 仍返回旧值、backgrounditems.btm 毫秒级不变，
//   表现为开关点了没反应 / 永远关不掉旧登录项。原因是 Electron 在 macOS <13 走的
//   LSSharedFileList 老接口与系统 BTM 已脱节。
//   LaunchAgent 由 launchd 在登录时自动加载，不依赖代码签名与系统登录项 API，
//   macOS 12 及以上通用（Homebrew services 同款机制）。
//
// 实现细节：
//   · 以「plist 文件是否存在」作为唯一状态源（不混用 Electron API，避免旧条目干扰判断）。
//   · 用 /usr/bin/open -a <App>.app 启动：走 LaunchServices，已运行则激活而不开新实例。
//   · 关闭时额外调用一次 setLoginItemSettings(openAtLogin:false) 兜底清理历史版本
//     留下的 Electron 旧格式登录项（macOS 13+ 上该调用有效；macOS 12 上是空操作）。
// ═══════════════════════════════════════════════════════════════════════════════

const LABEL = 'dev.zhouri.balancedeck'
const isMac = process.platform === 'darwin'

/** 测试可覆盖：BALANCEDECK_AUTOSTART_DIR 指向临时目录，避免 uitest 污染真实登录项 */
function agentPath(): string {
  const dir = process.env.BALANCEDECK_AUTOSTART_DIR || join(app.getPath('home'), 'Library', 'LaunchAgents')
  return join(dir, `${LABEL}.plist`)
}

/** .app 包路径（exe = <App>/Contents/MacOS/<name>，往上三级） */
function bundlePath(): string {
  return dirname(dirname(dirname(app.getPath('exe'))))
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function plistXml(args: string[]): string {
  const lines = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${lines}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
`
}

/** 当前是否已开启开机自启 */
export function getAutostart(): boolean {
  if (!isMac) return app.getLoginItemSettings().openAtLogin
  return existsSync(agentPath())
}

/**
 * macOS：系统登录项里是否还存在「不由本开关控制」的本应用条目。
 * 典型场景：旧版本用 Electron API 注册的登录项（macOS 12 上 API 失效，删不掉），
 * 或用户手动把应用加进了「登录项」。UI 据此提示用户手动清理。
 */
export function hasSystemLoginItem(): boolean {
  if (!isMac) return false
  try {
    return app.getLoginItemSettings().openAtLogin
  } catch {
    return false
  }
}

/**
 * 启动自愈：应用被移动过（例如从 dist/ 拖进 /Applications）时，
 * 登录项里的旧路径会失效 —— 已开启则用当前路径重写一次。
 */
export function syncAutostart(): void {
  if (!isMac) return
  if (existsSync(agentPath())) setAutostart(true)
}

/** 设置开机自启，返回设置后的真实状态（以文件/系统实际状态为准，不乐观返回） */
export function setAutostart(open: boolean): boolean {
  if (!isMac) {
    app.setLoginItemSettings({ openAtLogin: open })
    return app.getLoginItemSettings().openAtLogin
  }

  // 兜底：清理历史版本用 Electron API 注册的旧格式登录项（macOS 13+ 有效）
  try {
    app.setLoginItemSettings({ openAtLogin: false })
  } catch {
    // 忽略：仅尽力清理
  }

  if (!open) {
    try {
      rmSync(agentPath(), { force: true })
    } catch {
      // 删除失败时以文件实际状态为准
    }
    return existsSync(agentPath())
  }

  // 打包后用 `open -a <.app>`；开发态（Electron.app 跑项目目录）附上项目路径
  const args = app.isPackaged
    ? ['/usr/bin/open', '-a', bundlePath()]
    : ['/usr/bin/open', '-a', bundlePath(), '--args', app.getAppPath()]
  try {
    mkdirSync(dirname(agentPath()), { recursive: true })
    writeFileSync(agentPath(), plistXml(args), 'utf-8')
  } catch {
    // 磁盘/权限异常：保持关闭
  }
  return existsSync(agentPath())
}
