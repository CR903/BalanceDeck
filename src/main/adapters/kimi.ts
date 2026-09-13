import type { ProviderAdapter } from './types'
import { getJson, errSnap, noDataSnap, snap, balanceWindow } from './types'
import type { ProviderSnapshot } from '../../shared/types'

// Kimi (Moonshot) 官方余额接口：GET https://api.moonshot.cn/v1/users/me/balance
// 响应：{ code, data: { available_balance, voucher_balance, total_balance } }（单位：元）

export const kimiAdapter: ProviderAdapter = {
  id: 'kimi',
  name: 'Kimi (Moonshot)',
  kind: 'balance',
  builtin: true,

  async collect(ctx): Promise<ProviderSnapshot> {
    const key = await ctx.getKey(this.id)
    if (!key) return noDataSnap({ id: this.id, name: this.name }, '未配置 API Key（可在设置中填写或设 MOONSHOT_API_KEY）', ctx)
    const base = (await ctx.getExtra('baseUrl:kimi'))?.replace(/\/+$/, '') || 'https://api.moonshot.cn'
    try {
      const { status, body } = await getJson(base + '/v1/users/me/balance', {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json'
      })
      if (status === 401) {
        const hint = base.includes('api.moonshot.cn')
          ? `鉴权失败（401）：此 key 在官方 api.moonshot.cn 无效；若使用中转平台，请在设置的 Base URL 中填写平台地址`
          : `鉴权失败（401）：请核对该平台的 Key 与 Base URL`
        return errSnap({ id: this.id, name: this.name }, hint, ctx)
      }
      if (status !== 200) return errSnap({ id: this.id, name: this.name }, `HTTP ${status}`, ctx)
      const b = body as { code?: number; data?: { available_balance?: string | number; voucher_balance?: string | number } }
      const avail = Number(b.data?.available_balance)
      if (!Number.isFinite(avail)) return errSnap({ id: this.id, name: this.name }, '响应格式未识别', ctx)
      const voucher = Number(b.data?.voucher_balance ?? 0)
      const note = voucher > 0 ? `代金券 ¥${voucher.toFixed(2)}` : undefined
      return snap({ id: this.id, name: this.name, windows: [balanceWindow(avail, 'cny', note)] }, ctx)
    } catch (e) {
      return errSnap({ id: this.id, name: this.name }, `请求失败: ${(e as Error).message}`, ctx)
    }
  }
}
