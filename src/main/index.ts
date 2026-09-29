import { app } from 'electron'
import { registerIpc } from './ipc'
import { keystoreStore } from './keystore'
import { configureProviders } from './providers'
import { createOverlay, getOverlay, loadPersisted, petIgnoreState, primePrefs, setCollapsed, toggleOverlay } from './overlay'
import { createTray, updateTray, currentTrayTitle, trayImageInfo } from './tray'
import { syncAutostart } from './autostart'
import { startScheduler, refreshNow, currentState, stopScheduler } from './scheduler'
import { registerHumanAssetScheme, setupHumanAssetProtocol } from './human-assets'
import type { AppState } from '../shared/types'

// QA 工具（--shots / --uitest）不参与产品运行，见 ./qa —— 入口只负责分派
import { runBallshot } from './qa/ballshot'
import { runDetailsTest, runShotsMode, runSmoke, runUiTestAndReport, setupTestApp } from './qa/modes'
// --smoke：构建验证模式。采集一轮后把快照写到 stdout 并自动退出，不留常驻窗口。
const smoke = process.argv.includes('--smoke')
// --uitest：UI 交互自动化测试（模拟点击/拖拽/刷新，断言窗口与 DOM 状态）
const uitest = process.argv.includes('--uitest')
// --shots：设计走查截图（主页 / 详情 / 设置），产物在 /tmp/balancedeck-shots/
const shots = process.argv.includes('--shots')
// --details-test：控制台每模型明细抓取自检（一次性抓取并打印，用于排障）
const detailsTest = process.argv.includes('--details-test')

// 受限环境下跑自检：某些沙箱里 Chromium 的 GPU 进程起不来（表现为启动即 SIGTRAP）。
// BD_SANDBOX_OFF=1 会关掉进程沙箱并允许软件 WebGL —— **仅用于开发/CI 自检**，
// 用户正常启动应用时不走这条分支。
// 自检用 userData 覆盖：受限环境里 ~/Library/Application Support 不可写，
// BD_USER_DATA=<目录> 可把状态文件（state.json / secrets.bin / skins）落到指定位置。
if (process.env.BD_USER_DATA) app.setPath('userData', process.env.BD_USER_DATA)

if (process.env.BD_SANDBOX_OFF === '1') {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.commandLine.appendSwitch('enable-unsafe-swiftshader')
}

// ── 允许无用户手势的音频播放（必需项，不是优化）──────────────────────────────
//
// 余额预警 / 用量波动这类播报恰恰发生在**用户不在电脑前**的时候：人没盯屏、没有
// 点击、窗口静置。在浏览器那边这正是 autoplay 策略拦人的场景 —— `audio.play()`
// 被拒后只是一次 promise rejection，不抛错、不出声，现场完全查不出来。
// TTS 返回的是一段 MP3，渲染层只能用 <audio> 播（design.md D4），所以这条策略是
// 整条播报链路的**前置条件**。
//
// ⚠ 为什么是命令行开关而不是 `session.defaultSession.setAutoplayPolicy(...)`
// （design.md D4 的原文写法）：**那个方法不存在**。Electron 37 的类型里 autoplay
// 只有两个入口 —— `webPreferences.autoplayPolicy`（建窗时逐窗设置，而窗口在
// ./overlay 的 createOverlay 里，不归本文件管）和 Chromium 的 `--autoplay-policy`
// 开关。`Session` 与 `WebContents` 上都没有 setAutoplayPolicy，硬写只能靠 `as` 骗过
// tsc，运行时炸。开关是它的全局等价物：一次设置，对**所有** webContents 生效，
// 悬浮窗、--smoke/--uitest/--shots 的 QA 窗口、内嵌登录窗（opencode-auth 另建的
// 隐藏窗口，webPreferences 与主窗不同）都覆盖到 —— 逐窗设置会漏掉后面这两个。
//
// 位置：必须在 app ready **之前**（Chromium 在浏览器进程初始化时读这批开关，
// 当 ready 之后再 append 已经来不及），故与上面的 sandbox 开关放在一起。
// 失败不阻断启动：appendSwitch 对未知开关静默忽略，拼错的后果只是回到默认策略
// （Electron 的 webPreferences 默认本就是 no-user-gesture-required），而不是应用起不来。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

app.dock?.hide?.()

// bd-asset:// 特权 scheme 必须在 ready 前注册（数字人素材用）
registerHumanAssetScheme()

loadPersisted()
// 组合根注入：供应商注册表的存储（纯逻辑在 ./store，electron 只在 keystore 里）
// 必须在 registerIpc 之前 —— 否则任何 providers:* 调用都会因未配置而抛错。
configureProviders(keystoreStore)
registerIpc()

function pushState(s: AppState): void {
  // ⚠️ 必须显式发给悬浮窗：控制台明细抓取会临时创建一个隐藏窗口，
  // 若用 BrowserWindow.getAllWindows()[0] 可能把状态推给隐藏窗口 → 界面永远停在骨架屏。
  getOverlay()?.webContents.send('state:snapshot', s)
}

app.whenReady().then(async () => {
  // 数字人素材协议（bd-asset://human-pets…，缺失时渲染层回落，不阻塞启动）
  setupHumanAssetProtocol()
  // 先读偏好：收起态形态（球/个性人物）与是否置顶，窗口按最终形态一次成型
  await primePrefs()

  // ── QA 运行模式：入口只做分派，实现在 ./qa ──────────────────────────────
  if (detailsTest) {
    await runDetailsTest()
    app.quit()
    return
  }

  // --ballshot：只拍收起态（默认球形态 = 2D 小圆环；BD_PET=1 是个性人物），见 ./qa/ballshot
  if (process.argv.includes('--ballshot')) {
    await runBallshot()
    return
  }

  if (shots) {
    await runShotsMode(pushState)
    app.quit()
    return
  }

  if (smoke || uitest) {
    const t = setupTestApp(pushState)
    if (smoke) await runSmoke(t)
    else await runUiTestAndReport(t)
    app.quit()
    return
  }

  // ── 正常启动 ────────────────────────────────────────────────────────────
  createOverlay()
  createTray(toggleOverlay, refreshNow)
  startScheduler(pushState, updateTray)
  // 已开启开机自启时，用当前 .app 路径重写登录项（应用被移动过的自愈）
  syncAutostart()
})

app.on('window-all-closed', () => {
  // 悬浮组件常驻：不因窗口关闭退出（托盘仍在）
  if (smoke) app.quit()
})

app.on('before-quit', () => {
  stopScheduler()
})

// —— 设计走查截图 ——
