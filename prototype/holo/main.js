// 全息球原型主进程：透明窗口 + 测量取证专用（可丢弃，不进主干）。
// 用法：npx electron prototype/holo [--skin=abyss|ember] [--still] [--measure-run] [--out=dir]
'use strict'

const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, ipcMain } = require('electron')

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    return m ? [m[1], m[2] ?? '1'] : []
  }).filter((x) => x.length),
)

const OUT = args.out ? path.resolve(args.out) : path.join(__dirname, '..', '..', '.trellis', 'tasks', '10-03-holo-sphere', 'research')
const SKIN = args.skin || 'abyss'
const STILL = 'still' in args ? '1' : ''
const MEASURE_RUN = 'measure-run' in args

let win = null

function query() {
  const q = { skin: SKIN }
  if (STILL) q.still = '1'
  if (MEASURE_RUN) q.autorun = '1'
  return q
}

async function createWindow() {
  win = new BrowserWindow({
    width: 232,
    height: 444,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // 渲染进程 console → 主进程 stdout（测量数据走这条通道）
  win.webContents.on('console-message', (_e, _level, message) => {
    console.log(`[renderer] ${message}`)
  })
  await win.loadFile(path.join(__dirname, 'index.html'), { query: query() })
}

ipcMain.on('holo-save-png', (e, { name, dataUrl }) => {
  try {
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64')
    fs.mkdirSync(OUT, { recursive: true })
    const p = path.join(OUT, name)
    fs.writeFileSync(p, buf)
    console.log(`[main] png saved: ${p}`)
    e.sender.send('holo-save-png-done', { ok: true, path: p })
  } catch (err) {
    console.log(`[main] png save failed: ${String(err)}`)
    e.sender.send('holo-save-png-done', { ok: false, error: String(err) })
  }
})

ipcMain.on('holo-measure-done', async (_e, payload) => {
  fs.mkdirSync(OUT, { recursive: true })
  // 主进程侧内存足迹（workingSet 求和，作显存/内存阈值的代理指标）
  try {
    const metrics = app.getAppMetrics()
    payload.procMemMB = +metrics.reduce((a, m) => a + (m.memory ? m.memory.workingSetSize : 0), 0).toFixed(0)
    payload.procMemMB = Math.round(payload.procMemMB / 1024)
  } catch (err) {
    payload.procMemMB = null
  }
  // 整窗截图（含 HUD 三卡；capturePage 返回设备像素，本机 DPR=2 即 464×888）
  try {
    const img = await win.capturePage()
    const wp = path.join(OUT, `holo-${payload.skin}${payload.still ? '-still' : ''}-window.png`)
    fs.writeFileSync(wp, img.toPNG())
    console.log(`[main] window shot saved: ${wp} (${img.getSize().width}x${img.getSize().height})`)
  } catch (err) {
    console.log(`[main] window shot failed: ${String(err)}`)
  }
  const p = path.join(OUT, `measure-${payload.skin}${payload.still ? '-still' : ''}.json`)
  fs.writeFileSync(p, JSON.stringify(payload, null, 2))
  console.log(`[main] measure saved: ${p}`)
  console.log(`[main] HOLO_RESULT ${JSON.stringify(payload.summary)}`)
  if (MEASURE_RUN) {
    setTimeout(() => app.quit(), 800)
  }
})

app.whenReady().then(() => {
  createWindow()
  // 兜底：measure-run 最多 40s 必退；交互模式不设限
  if (MEASURE_RUN) {
    setTimeout(() => {
      console.log('[main] timeout quit')
      app.quit()
    }, 40000)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
