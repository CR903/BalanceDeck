import type { ProviderAdapter } from './types'
import { getJson, errSnap, noDataSnap, snap, balanceWindow } from './types'
import type { ProviderWindow, ProviderSnapshot } from '../../shared/types'

// MiniMax 余额查询：
// 1) 新平台 Token Plan：GET https://api.minimaxi.com/v1/token_plan/remains（Bearer key）
// 2) 旧平台按量余额：GET https://api.minimax.chat/v1/query_balance?group=<groupId>（Bearer key + group_id）
// 两个响应均做宽容解析；新平台失败自动回退旧接口（配置了 group id 时）。

function firstNumber(obj: unknown, keys: string[], depth = 0): number | null {
  if (depth > 4 || obj === null || typeof obj !== 'object') return null
  const rec = obj as Record<string, unknown>
  for (const k of keys) {
    const v = rec[k]
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
    if (Number.isFinite(n)) return n
  }
  for (const v of Object.values(rec)) {
    const f = firstNumber(v, keys, depth + 1)
    if (f !== null) return f
  }
  return null
}

function baseErr(body: unknown): string | null {
  const b = body as { base_resp?: { status_code?: number; status_msg?: string } } | null
  if (b?.base_resp && b.base_resp.status_code !== 0 && b.base_resp.status_code !== undefined) {
    return b.base_resp.status_msg ?? `status_code=${b.base_resp.status_code}`
  }
  return null
}

export const minimaxAdapter: ProviderAdapter = {
  id: 'minimax',
  name: 'MiniMax',
  kind: 'token',
  builtin: true,

  async collect(ctx): Promise<ProviderSnapshot> {
    const key = await ctx.getKey(this.id)
    if (!key) return noDataSnap({ id: this.id, name: this.name }, '未配置 API Key（可在设置中填写或设 MINIMAX_API_KEY）', ctx)
    const base = (await ctx.getExtra('baseUrl:minimax'))?.replace(/\/+$/, '') || 'https://api.minimaxi.com'
    const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' }
    const fallback = async (msg: string): Promise<ProviderSnapshot> => {
      const groupId = await ctx.getExtra('minimaxGroupId')
      if (!groupId) return errSnap({ id: this.id, name: this.name }, msg, ctx)
      try {
        const { status, body } = await getJson(`${base}/v1/query_balance?group=${encodeURIComponent(groupId)}`, headers)
        if (status !== 200) return errSnap({ id: this.id, name: this.name }, `${msg}；旧接口 HTTP ${status}`, ctx)
        const be = baseErr(body)
        if (be) return errSnap({ id: this.id, name: this.name }, `${msg}；旧接口: ${be}`, ctx)
        const money = firstNumber(body, ['money', 'balance', 'total_balance'])
        if (money === null) return errSnap({ id: this.id, name: this.name }, `${msg}；旧接口响应格式未识别`, ctx)
        const windows: ProviderWindow[] = [balanceWindow(money, 'cny', '旧接口 query_balance')]
        return snap({ id: this.id, name: this.name, windows }, ctx)
      } catch (e) {
        return errSnap({ id: this.id, name: this.name }, `${msg}；旧接口请求失败: ${(e as Error).message}`, ctx)
      }
    }
    try {
      const { status, body } = await getJson(`${base}/v1/token_plan/remains`, headers)
      if (status === 200) {
        const be = baseErr(body)
        if (!be) {
          const total = firstNumber(body, ['total', 'total_amount', 'quota'])
          const remain = firstNumber(body, ['remain', 'remains', 'remaining', 'available'])
          if (total !== null && remain !== null && total > 0) {
            const windows: ProviderWindow[] = [
              {
                name: 'Token Plan',
                used: total - remain,
                limit: total,
                unit: 'request',
                note: `剩余 ${remain}`
              }
            ]
            return snap({ id: this.id, name: this.name, plan: 'Token Plan', windows }, ctx)
          }
          const money = firstNumber(body, ['money', 'balance'])
          if (money !== null) return snap({ id: this.id, name: this.name, windows: [balanceWindow(money, 'cny')] }, ctx)
        }
      } else if (status === 401) {
        return errSnap({ id: this.id, name: this.name }, '鉴权失败（401）：API Key 无效', ctx)
      }
      return fallback('Token Plan 接口无可用数据')
    } catch (e) {
      return fallback(`Token Plan 请求失败: ${(e as Error).message}`)
    }
  }
}
