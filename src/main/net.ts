import { net } from 'electron'
import { isNetworkError } from '../shared/quality'

// ═══════════════════════════════════════════════════════════════════════════════
// 网络可用性探测
//
// 目的：断网时**不能**把"上次的数值 / 本机估算"当作实时数据展示给用户。
//
// 判定来源（任一成立即视为离线）：
//   ① 系统级：`net.isOnline()` 为 false（macOS 走 SCNetworkReachability，断网/飞行模式可立即感知）
//   ② 观测级：最近连续 N 次网络请求全部以"网络类错误"失败，且期间没有任何成功响应
//
// 注意：HTTP 4xx/5xx **不算**离线（网络是通的，只是凭据/服务问题），
// 只有 fetch 抛错（DNS/连接/超时）才计入。
// ═══════════════════════════════════════════════════════════════════════════════

/** 网络错误分类见 `src/shared/quality.ts`（纯函数，可与单元测试共用） */
export { isNetworkError }

let failStreak = 0
let lastOkAt = 0
let lastFailAt = 0
const startedAt = Date.now()

/**
 * 排障开关：`BALANCEDECK_FORCE_OFFLINE=1`（或毫秒数，表示启动后 N 毫秒开始）时，
 * 所有出网请求立即以"网络不可达"失败 —— 用于端到端验证离线路径
 * （缓存标注、本机估算标注、托盘 ⚠、界面提示），无需真的拔网线。
 */
export function forcedOffline(): boolean {
  const v = process.env.BALANCEDECK_FORCE_OFFLINE
  if (!v) return false
  if (v === '1' || v === 'true') return true
  const ms = Number(v)
  return Number.isFinite(ms) && Date.now() - startedAt >= ms
}

/** 出网请求前调用：强制离线时抛网络类错误（并计入离线判定） */
export function assertNetAvailable(): void {
  if (!forcedOffline()) return
  const e = new TypeError('fetch failed（BALANCEDECK_FORCE_OFFLINE）')
  markNetResult(false, e)
  throw e
}

/** 记录一次网络请求结果（成功含 HTTP 4xx/5xx：拿到响应即说明网络通） */
export function markNetResult(ok: boolean, err?: unknown): void {
  if (ok) {
    failStreak = 0
    lastOkAt = Date.now()
    return
  }
  if (!isNetworkError(err)) return
  failStreak += 1
  lastFailAt = Date.now()
}

/** 当前是否判定为离线 */
export function isOffline(): boolean {
  if (forcedOffline()) return true
  try {
    if (!net.isOnline()) return true
  } catch {
    // net 模块在 app ready 前不可用：忽略
  }
  // 连续 2 次以上网络错误、且期间无任何成功响应 → 视为离线
  return failStreak >= 2 && lastFailAt > lastOkAt
}

