import type { ProviderSnapshot, ProviderWindow, ProviderKind, Unit } from '../../shared/types'
import { markNetResult, assertNetAvailable } from '../net'

export interface CollectContext {
  now: Date
  /** 读取凭据（密钥链 → 环境变量回退），无凭据返回 null */
  getKey(providerId: string): Promise<string | null>
  getExtra(key: string): Promise<string | null>
  /** 回写凭据（仅用于自愈场景，如 cookie 被服务端轮换后静默更新） */
  setKey?(providerId: string, value: string): Promise<void>
}

export interface ProviderAdapter {
  id: string
  name: string
  /** balance=直连余额 coding/token=套餐用量 */
  kind: ProviderKind
  /** 是否内置预设实例（UI 显示徽章用） */
  builtin: boolean
  /** 供应商图标 id（内置预设 id / 协议 id），卡片与托盘据此显示 logo */
  mark?: string
  collect(ctx: CollectContext): Promise<ProviderSnapshot>
}

export function snap(
  base: Pick<ProviderSnapshot, 'id' | 'name'> & Partial<ProviderSnapshot>,
  ctx: CollectContext
): ProviderSnapshot {
  const at = ctx.now.toISOString()
  return {
    status: 'ok',
    windows: [],
    // kind/builtin 由 collectAll 按适配器元数据覆盖，这里的默认值仅满足类型
    kind: 'balance',
    builtin: true,
    updatedAt: at,
    // 默认视为官方数据；降级路径（本机估算/缓存）需显式覆盖并给出原因
    dataQuality: 'official',
    dataAt: at,
    ...base
  }
}

export function errSnap(
  base: Pick<ProviderSnapshot, 'id' | 'name'>,
  message: string,
  ctx: CollectContext
): ProviderSnapshot {
  return snap({ ...base, status: 'error', detail: message, failureReason: message }, ctx)
}

export function noDataSnap(
  base: Pick<ProviderSnapshot, 'id' | 'name'>,
  detail: string,
  ctx: CollectContext
): ProviderSnapshot {
  return snap({ ...base, status: 'nodata', detail }, ctx)
}

/** 带 fetch 超时的 GET，统一 JSON 解析（同时向网络探测器反馈可达性） */
export async function getJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 12000
): Promise<{ status: number; body: unknown }> {
  assertNetAvailable()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal })
    markNetResult(true)
    const text = await res.text()
    let body: unknown = null
    try {
      body = JSON.parse(text)
    } catch {
      body = text.slice(0, 200)
    }
    return { status: res.status, body }
  } catch (e) {
    markNetResult(false, e)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

export function fmtMoney(v: number, unit: Unit): string {
  const s = v >= 100 ? v.toFixed(0) : v.toFixed(2)
  return unit === 'cny' ? `¥${s}` : `$${s}`
}

/** 余额类通用窗口：单条"账户余额"窗口（limit 未知，仅展示金额） */
export function balanceWindow(amount: number, unit: Unit, note?: string): ProviderWindow {
  return { name: '账户余额', used: amount, unit, note }
}
