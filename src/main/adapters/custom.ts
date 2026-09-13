import type { ProviderAdapter } from './types'
import { getJson, snap, errSnap, noDataSnap, balanceWindow } from './types'
import type { ProviderSnapshot, ProviderWindow, ProviderInstance, Unit } from '../../shared/types'

// ═══════════════════════════════════════════════════════════════════════════════
// 自定义协议适配器
//
// 用户实例 =（名称 + 协议 + base URL + key），协议决定「查哪个端点、怎么解析」。
// 同一协议可被多个实例复用（可重复添加、随意删除）。
// ═══════════════════════════════════════════════════════════════════════════════

type HttpProbe = { url: string; headers: Record<string, string> }

interface ProbeCtx {
  baseUrl: string
  key: string
}

/** 在对象里按候选键名递归寻找数值字段（宽容解析，适配字段名多变的中转平台） */
function findNumber(obj: unknown, keys: string[], depth = 0): number | null {
  if (depth > 4 || obj === null || typeof obj !== 'object') return null
  const rec = obj as Record<string, unknown>
  for (const k of keys) {
    const v = rec[k]
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
    if (Number.isFinite(n)) return n
  }
  for (const v of Object.values(rec)) {
    const found = findNumber(v, keys, depth + 1)
    if (found !== null) return found
  }
  return null
}

function findString(obj: unknown, keys: string[], depth = 0): string | null {
  if (depth > 4 || obj === null || typeof obj !== 'object') return null
  const rec = obj as Record<string, unknown>
  for (const k of keys) {
    const v = rec[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  for (const v of Object.values(rec)) {
    const found = findString(v, keys, depth + 1)
    if (found !== null) return found
  }
  return null
}

const BALANCE_KEYS = [
  'total_balance',
  'totalBalance',
  'available_balance',
  'availableBalance',
  'AvailableAmount',
  'AvailableBalance',
  'balance',
  'Balance',
  'total_available',
  'credit',
  'credits',
  'remaining',
  'money'
]
const CURRENCY_KEYS = ['currency', 'Currency', 'unit', 'Unit']

function moneyUnit(currency: string | null, fallback: Unit = 'cny'): Unit {
  const c = (currency ?? '').toUpperCase()
  if (c === 'USD' || c === '$') return 'usd'
  if (c === 'CNY' || c === 'RMB' || c === '¥') return 'cny'
  return fallback
}

/** 各协议的探测请求构造 */
function buildProbe(protocol: string, ctx: ProbeCtx): HttpProbe {
  const base = ctx.baseUrl.replace(/\/+$/, '')
  const auth = { Authorization: `Bearer ${ctx.key}`, Accept: 'application/json' }
  switch (protocol) {
    case 'deepseek':
      return { url: `${base}/user/balance`, headers: auth }
    case 'moonshot':
      return { url: `${base}/v1/users/me/balance`, headers: auth }
    case 'zhipu':
      return { url: `${base}/api/paas/v4/users/me/balance`, headers: auth }
    case 'siliconflow':
    case 'siliconflow-intl':
      return { url: `${base}/v1/user/info`, headers: auth }
    case 'openrouter':
      return { url: `${base}/api/v1/credits`, headers: auth }
    case 'openai-billing':
      return { url: `${base}/v1/dashboard/billing/subscription`, headers: auth }
    case 'minimax':
      return { url: `${base}/v1/token_plan/remains`, headers: auth }
    case 'generic':
    default:
      return { url: ctx.baseUrl.trim(), headers: auth }
  }
}

/** 各协议把响应解析为窗口；返回 null 表示响应不可识别 */
function parseProbe(protocol: string, status: number, body: unknown): ProviderWindow[] | null {
  if (status !== 200) return null
  switch (protocol) {
    case 'deepseek': {
      const b = body as { balance_infos?: { currency?: string; total_balance?: string }[] }
      const info = b?.balance_infos?.[0]
      const total = Number(info?.total_balance)
      if (!Number.isFinite(total)) return null
      return [balanceWindow(total, moneyUnit(info?.currency ?? null), '官方接口')]
    }
    case 'moonshot': {
      const b = body as { data?: { available_balance?: string | number; voucher_balance?: string | number } }
      const avail = Number(b?.data?.available_balance)
      if (!Number.isFinite(avail)) return null
      const voucher = Number(b?.data?.voucher_balance ?? 0)
      const note = voucher > 0 ? `代金券 ¥${voucher.toFixed(2)}` : undefined
      return [balanceWindow(avail, 'cny', note)]
    }
    case 'openrouter': {
      const b = body as { data?: { total_credits?: number; total_usage?: number } }
      const credits = Number(b?.data?.total_credits)
      const used = Number(b?.data?.total_usage ?? 0)
      if (!Number.isFinite(credits)) return null
      return [balanceWindow(credits - used, 'usd', '官方接口')]
    }
    case 'openai-billing': {
      const b = body as { hard_limit_usd?: number; system_hard_limit_usd?: number }
      const limit = b?.hard_limit_usd ?? b?.system_hard_limit_usd
      if (!Number.isFinite(limit)) return null
      return [{ name: '账户额度', used: 0, limit: limit as number, unit: 'usd', note: '官方计费接口（不含已用量）' }]
    }
    case 'minimax': {
      const b = body as { base_resp?: { status_code?: number; status_msg?: string } }
      if (b?.base_resp && b.base_resp.status_code !== 0 && b.base_resp.status_code !== undefined) return null
      const total = findNumber(body, ['total', 'total_amount', 'quota'])
      const remain = findNumber(body, ['remain', 'remains', 'remaining', 'available'])
      if (total !== null && remain !== null && total > 0) {
        return [{ name: 'Token Plan', used: total - remain, limit: total, unit: 'request', note: `剩余 ${remain}` }]
      }
      const money = findNumber(body, ['money', 'balance'])
      if (money !== null) return [balanceWindow(money, 'cny', '官方接口')]
      return null
    }
    case 'zhipu':
    case 'siliconflow':
    case 'siliconflow-intl':
    case 'generic':
    default: {
      const n = findNumber(body, BALANCE_KEYS)
      if (n === null) return null
      const currency = findString(body, CURRENCY_KEYS)
      const fallback: Unit = protocol === 'siliconflow-intl' ? 'usd' : 'cny'
      return [balanceWindow(n, moneyUnit(currency, fallback), protocol === 'generic' ? '自定义接口' : '官方接口')]
    }
  }
}

/** 协议是否需要 base URL（generic 用完整 URL，仍视为必填） */
export function protocolNeedsBaseUrl(_protocol: string): boolean {
  return true
}

/** 从实例创建自定义协议适配器 */
export function createCustomAdapter(def: ProviderInstance): ProviderAdapter {
  return {
    id: def.id,
    name: def.name,
    kind: def.kind,
    builtin: false,
    mark: def.protocol,

    async collect(ctx): Promise<ProviderSnapshot> {
      const key = await ctx.getKey(def.id)
      if (!key) {
        return noDataSnap({ id: def.id, name: def.name }, '未配置 API Key（在设置中编辑该供应商）', ctx)
      }
      const baseUrl = def.baseUrl || (await ctx.getExtra(`provider:${def.id}:baseUrl`))
      if (!baseUrl) {
        return errSnap({ id: def.id, name: def.name }, '未配置 API 地址（在设置中编辑该供应商）', ctx)
      }
      const probe = buildProbe(def.protocol, { baseUrl, key })
      try {
        const { status, body } = await getJson(probe.url, probe.headers)
        if (status === 401 || status === 403) {
          return errSnap({ id: def.id, name: def.name }, `鉴权失败（HTTP ${status}）：请核对该供应商的 Key 与 API 地址`, ctx)
        }
        if (status === 404) {
          return errSnap({ id: def.id, name: def.name }, `端点不存在（HTTP 404）：请核对该供应商的协议与 API 地址`, ctx)
        }
        if (status !== 200) {
          return errSnap({ id: def.id, name: def.name }, `HTTP ${status}`, ctx)
        }
        const windows = parseProbe(def.protocol, status, body)
        if (!windows) {
          const preview = typeof body === 'string' ? body : JSON.stringify(body).slice(0, 160)
          return errSnap({ id: def.id, name: def.name }, `响应格式未识别：${preview}`, ctx)
        }
        return snap(
          { id: def.id, name: def.name, kind: def.kind, builtin: false, windows, source: '自定义接口' },
          ctx
        )
      } catch (e) {
        return errSnap({ id: def.id, name: def.name }, `请求失败: ${(e as Error).message}`, ctx)
      }
    }
  }
}
