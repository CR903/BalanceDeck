import type { ProviderAdapter } from './types'
import { getJson, errSnap, noDataSnap, snap } from './types'
import type { ProviderSnapshot } from '../../shared/types'

// 硅基流动用户信息接口：GET https://api.siliconflow.cn/v1/user/info（Bearer key）
// 返回 data.balance / data.chargeBalance / data.totalBalance（字符串，CNY）。

const CANDIDATE_KEYS = ['totalBalance', 'balance', 'chargeBalance', 'available_balance', 'total_balance']

function findBalance(obj: unknown, depth = 0): number | null {
  if (depth > 3 || obj === null || typeof obj !== 'object') return null
  const rec = obj as Record<string, unknown>
  for (const k of CANDIDATE_KEYS) {
    const v = rec[k]
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
    if (Number.isFinite(n)) return n
  }
  for (const v of Object.values(rec)) {
    const found = findBalance(v, depth + 1)
    if (found !== null) return found
  }
  return null
}

export const siliconflowAdapter: ProviderAdapter = {
  id: 'siliconflow',
  name: '硅基流动',
  kind: 'balance',
  builtin: true,

  async collect(ctx): Promise<ProviderSnapshot> {
    const key = await ctx.getKey(this.id)
    if (!key) return noDataSnap({ id: this.id, name: this.name }, '未配置 API Key（可在设置中填写或设 SILICONFLOW_API_KEY）', ctx)
    const base = (await ctx.getExtra('baseUrl:siliconflow'))?.replace(/\/+$/, '') || 'https://api.siliconflow.cn'
    try {
      const { status, body } = await getJson(base + '/v1/user/info', {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json'
      })
      if (status === 401) return errSnap({ id: this.id, name: this.name }, '鉴权失败（401）：API Key 无效', ctx)
      if (status !== 200) return errSnap({ id: this.id, name: this.name }, `HTTP ${status}`, ctx)
      const n = findBalance(body)
      if (n === null) {
        const preview = typeof body === 'string' ? body : JSON.stringify(body).slice(0, 160)
        return errSnap({ id: this.id, name: this.name }, `响应格式未识别：${preview}`, ctx)
      }
      return snap({ id: this.id, name: this.name, windows: [{ name: '账户余额', used: n, unit: 'cny', note: '官方接口' }] }, ctx)
    } catch (e) {
      return errSnap({ id: this.id, name: this.name }, `请求失败: ${(e as Error).message}`, ctx)
    }
  }
}
