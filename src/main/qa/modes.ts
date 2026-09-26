import { createOverlay, toggleOverlay } from '../overlay'
import { createTray, updateTray, currentTrayTitle, trayImageInfo } from '../tray'
import { currentState, refreshNow, startScheduler } from '../scheduler'
import type { AppState } from '../../shared/types'
import { runShots } from './shots'
import { runUiTest } from './uitest'

// ═══════════════════════════════════════════════════════════════════════════════
// 各 QA 运行模式的一次性入口（--shots / --smoke / --uitest / --details-test）
//
// 入口模块只做「认参数 → 交给这里 → 退出」，因为它的接口是「启动应用」。
// 这些模式都要一个窗口、托盘与调度器，但输出与退出方式各不同，所以在这里收口。
//
// 结果契约：UI 断言以 JSON 打到 stdout，**不设置退出码** —— 失败与否由调用方解析；
// 谁要把它接进 CI，得先补退出码（见 scripts/test-structure.mjs 的说明）。
// ═══════════════════════════════════════════════════════════════════════════════

type PushFn = (s: AppState) => void

export interface TestApp {
  win: Electron.BrowserWindow
  /** 渲染层 level>=3 的 console 消息（断言里会检查是否为空） */
  consoleErrors: string[]
  preloadError: () => string
}

/** --smoke / --uitest 共用的启动：建窗口、收集渲染层错误、起托盘与调度 */
export function setupTestApp(onState: PushFn): TestApp {
  const win = createOverlay()
  let preloadError = ''
  const consoleErrors: string[] = []
  win.webContents.on('preload-error', (_e, p, err) => {
    preloadError = `${p}: ${err}`
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) {
      consoleErrors.push(message.slice(0, 200))
      // 测试期实时打印：出错时能立刻看到栈（否则要等整轮结束）
      if (process.env.BD_TRACE === '1') process.stdout.write(`[renderer:${level}] ${message.slice(0, 400)}\n`)
    }
  })
  createTray(toggleOverlay, refreshNow)
  // 托盘回调传真实 updateTray：让 smoke 能验证状态栏文案与图标链路
  startScheduler(onState, updateTray)
  return { win, consoleErrors, preloadError: () => preloadError }
}

/** --smoke：建窗口（验证 preload/renderer 加载），一轮采集后输出 JSON */
export function runSmoke(t: TestApp): Promise<void> {
  // 采集等待时长可调（默认 6s；控制台每模型明细为后台抓取，验证时需要更久）
  const waitMs = Number(process.env.SMOKE_WAIT_MS ?? 6000)
  return new Promise((resolve) => {
    setTimeout(() => {
      t.win.webContents
        .executeJavaScript("document.getElementById('root')?.children.length ?? -1", true)
        .then((n) => ({ rendererRoot: n as number, preloadError: t.preloadError() }))
        .catch((e) => ({ rendererRoot: -1, preloadError: String(e) }))
        .then(({ rendererRoot, preloadError }) => {
          process.stdout.write(
            JSON.stringify(
              {
                smoke: true,
                rendererRoot,
                preloadError,
                tray: { title: currentTrayTitle(), ...trayImageInfo() },
                state: currentState()
              },
              null,
              2
            )
          )
          resolve()
        })
    }, waitMs)
  })
}

/** --uitest：跑断言并输出 JSON（退出码由入口决定） */
export async function runUiTestAndReport(t: TestApp): Promise<void> {
  const results = await runUiTest(t.win, t.consoleErrors)
  process.stdout.write(JSON.stringify({ uitest: true, consoleErrors: t.consoleErrors, ...results }, null, 2))
}

/**
 * 解析诊断工具用的凭据 —— 与产品路径 `opencode.ts` 的 `resolveCookie` 同源：
 * 先读授权分区的实时 cookie，再退回**已保存**的。
 *
 * ⚠️ 保存的 cookie 必须用 `getKey` 而不是 `getExtra`：
 *    `setKey('opencodeCookie', …)` 写的是 `items`（加密），`getExtra` 读的是
 *    `extras`（明文）—— 两个互不相干的 map，用错会**永远拿到 null**，
 *    于是"明明授权过"却报缺少凭据。2026-09-26 踩过。
 */
async function resolveDiagnosticCred(): Promise<{ workspaceId: string; cookie: string; from: 'partition' | 'saved' | 'none' }> {
  const { getKey, getExtra } = await import('../keystore')
  const { readPartitionCookie } = await import('../opencode-auth')
  const workspaceId =
    (await getExtra('opencodeWorkspaceId')) ?? process.env.OPENCODE_GO_WORKSPACE_ID ?? ''
  const live = await readPartitionCookie()
  if (live) return { workspaceId, cookie: live, from: 'partition' }
  const saved = (await getKey('opencodeCookie')) ?? process.env.OPENCODE_GO_COOKIE ?? ''
  return { workspaceId, cookie: saved, from: saved ? 'saved' : 'none' }
}

/** --shots：设计走查截图（先预热控制台明细缓存，否则首轮采集还没有明细） */
export async function runShotsMode(onState: PushFn): Promise<void> {
  const win = createOverlay()
  try {
    const { fetchConsoleDetailsNow } = await import('../opencode-details')
    const cred = await resolveDiagnosticCred()
    if (cred.workspaceId && cred.cookie) await fetchConsoleDetailsNow(cred.workspaceId, cred.cookie)
  } catch {
    // 预热失败不影响截图
  }
  startScheduler(onState, () => {})
  await runShots(win)
}

/** --details-test：一次性抓取控制台每模型明细并打印（排障用，见 DESIGN.md §5） */
export async function runDetailsTest(): Promise<void> {
  const { fetchConsoleDetailsNow } = await import('../opencode-details')
  const cred = await resolveDiagnosticCred()
  const { workspaceId: wid, cookie, from } = cred
  process.stdout.write(`workspaceId: ${wid ? wid.slice(0, 8) + '…' : '(未配置)'}\n`)
  process.stdout.write(
    `cookie: ${{ partition: '授权分区（实时）', saved: '已保存值', none: '(未配置)' }[from]}\n`
  )
  if (!wid || !cookie) {
    process.stdout.write('缺少 workspace id 或 cookie —— 请先走一次「一键授权」\n')
    return
  }
  const t0 = Date.now()
  const data = await fetchConsoleDetailsNow(wid, cookie)
  process.stdout.write(
    `抓取耗时: ${Date.now() - t0}ms | 结果: ${
      data ? JSON.stringify(Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])), null, 1) : 'null'
    }\n`
  )
  for (const [kind, rows] of Object.entries(data ?? {})) {
    if (!rows.length) continue
    process.stdout.write(`${kind} 前 3 行（注意：只有已用量，接口不提供每模型配额与百分比）:\n`)
    for (const r of rows.slice(0, 3)) {
      process.stdout.write(`  ${r.model} | $${r.usageUsd.toFixed(4)} | ${r.tokens} tok | ${r.requests} 次\n`)
    }
  }
}
