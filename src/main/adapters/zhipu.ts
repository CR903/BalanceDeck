import type { ProviderAdapter } from './types'
import { getJson, errSnap, noDataSnap, snap, balanceWindow } from './types'
import type { ProviderSnapshot } from '../../shared/types'

// 智谱开放平台余额接口（社区验证）：GET https://open.bigmodel.cn/api/paas/v4/users/me/balance
// 认证：Authorization: Bearer <API Key>（格式 id.secret）
// 响应字段历史上随版本变化，这里做宽容解析：在 body / body.data 中寻找余额类数值字段。

const CANDIDATE_KEYS = ['balance', 'total_balance', 'available_balance', 'totalBalance', 'availableBalance']

function findNumber(obj: unknown, depth = 0): number | null {
  if (depth > 3 || obj === null || typeof obj !== 'object') return null
  const rec = obj as Record<string, unknown>
  for (const k of CANDIDATE_KEYS) {
    const v = rec[k]
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
    if (Number.isFinite(n)) return n
  }
  for (const v of Object.values(rec)) {
    const found = findNumber(v, depth + 1)
    if (found !== null) return found
  }
  return null
}

export const zhipuAdapter: ProviderAdapter = {
  id: 'zhipu',
  name: '智谱 GLM',
  kind: 'balance',
  builtin: true,

  async collect(ctx): Promise<ProviderSnapshot> {
    const key = await ctx.getKey(this.id)
    if (!key) return noDataSnap({ id: this.id, name: this.name }, '未配置 API Key（可在设置中填写或设 ZHIPUAI_API_KEY）', ctx)
    const base = (await ctx.getExtra('baseUrl:zhipu'))?.replace(/\/+$/, '') || 'https://open.bigmodel.cn'
    try {
      const { status, body } = await getJson(base + '/api/paas/v4/users/me/balance', {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json'
      })
      if (status === 401) return errSnap({ id: this.id, name: this.name }, '鉴权失败（401）：API Key 无效', ctx)
      if (status !== 200) return errSnap({ id: this.id, name: this.name }, `HTTP ${status}`, ctx)
      const n = findNumber(body)
      if (n === null) {
        const preview = typeof body === 'string' ? body : JSON.stringify(body).slice(0, 160)
        return errSnap({ id: this.id, name: this.name }, `响应格式未识别：${preview}`, ctx)
      }
      return snap({ id: this.id, name: this.name, windows: [balanceWindow(n, 'cny', '端点为社区验证版本')] }, ctx)
    } catch (e) {
      return errSnap({ id: this.id, name: this.name }, `请求失败: ${(e as Error).message}`, ctx)
    }
  }
}
