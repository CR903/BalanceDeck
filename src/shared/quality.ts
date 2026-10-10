import type { ProviderSnapshot } from './types'

// ═══════════════════════════════════════════════════════════════════════════════
// 数据可信度（诚实原则）
//
// 背景：断网时如果把"本机估算 / 上次的数值"当作实时官方数据展示，会误导用户
// （实测：断网后 opencode 退回本机 opencode.db 统计，百分比与官方口径不同）。
//
// 约定：
//   official — 官方/权威源实时数据
//   local    — 官方不可达，退回本机估算（口径不同）
//   cached   — 本轮刷新失败，展示上次官方数据（已过期）
// 后两者必须显式标注，且 cached 有 24 小时上限（避免"僵尸数据"）。
//
// 本模块是纯函数（不依赖 electron），因此主进程、渲染层与单元测试共用同一实现。
// ═══════════════════════════════════════════════════════════════════════════════

/** 最后有效值的最长保留时间：超过则宁可不展示 */
export const MAX_CACHE_AGE = 24 * 3600_000

/**
 * 供应商分两类：**套餐**（`coding` / `token`）与**充值余额**（`balance`）。
 * 卡片、详情页与收起态灵动岛的「挂不挂水 / 叫它余额还是套餐」都由这一个判定说了算
 * —— 抽到 shared 就是为了让「卡片说是余额、球说是套餐」这类劈叉在结构上不可能发生
 * （2026-09-27 前 CardView:557 与收起态各写一份 `kind === 'balance'`）。
 */
export const isPlan = (s: { kind: string }): boolean => s.kind !== 'balance'

/**
 * 「最后有效值」策略：本轮降级时沿用上次官方数据，但必须打上 cached 标记。
 *
 * 不缓存的情况：
 *   · 上次是 local（本机估算不是权威数据，没有缓存价值）
 *   · 本轮是 nodata（用户可能刚清空凭据，应如实显示"未配置"）
 *   · 上次数据超过 MAX_CACHE_AGE
 */
export function applyCachePolicy(
  prev: ProviderSnapshot | undefined,
  next: ProviderSnapshot,
  now = Date.now()
): ProviderSnapshot {
  if (!prev || prev.windows.length === 0) return next
  if ((prev.dataQuality ?? 'official') === 'local') return next
  const degraded =
    next.status === 'error' || next.dataQuality === 'local' || (next.status === 'ok' && next.windows.length === 0)
  if (!degraded) return next

  const at = prev.dataAt ?? prev.updatedAt
  const age = now - Date.parse(at)
  if (!Number.isFinite(age) || age > MAX_CACHE_AGE) return next

  return {
    ...prev,
    dataQuality: 'cached',
    dataAt: at,
    degradedReason:
      next.failureReason ?? next.degradedReason ?? next.detail ?? (next.status === 'error' ? '刷新失败' : '暂不可用')
  }
}

/** 数据实际对应时间（cached 时 = 上次成功采集时间） */
export function dataTime(s: { dataAt?: string; updatedAt?: string }): string | undefined {
  return s.dataAt ?? s.updatedAt
}

/** 是否非官方实时数据（缓存 / 本机估算） */
export function isStale(s: { dataQuality?: string }): boolean {
  return s.dataQuality === 'cached' || s.dataQuality === 'local'
}

/** 可信度徽章文案；官方数据返回空串 */
export function staleLabel(s: { dataQuality?: string }): string {
  if (s.dataQuality === 'cached') return '缓存'
  if (s.dataQuality === 'local') return '本机'
  return ''
}

// ─── 网络错误分类（判断"离线"用；HTTP 4xx/5xx 不算离线）────────────────────

type NetError = Error & { code?: string; cause?: { code?: string } }

/** 是否属于"网络不可达"类错误（凭据/服务端错误不算） */
export function isNetworkError(e: unknown): boolean {
  if (!e) return false
  const err = e as NetError
  if (err.name === 'AbortError') return true // 我方超时（12s 无响应）
  const code = err.code ?? err.cause?.code ?? ''
  if (/^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ECONNRESET|ETIMEDOUT|EPIPE|ENETDOWN)$/.test(code)) {
    return true
  }
  const msg = `${err.message ?? ''} ${err.cause?.code ?? ''}`.toLowerCase()
  return /fetch failed|network|enotfound|eai_again|econnrefused|enetunreach|timeout|socket hang up|offline/.test(msg)
}
