import type { ProviderAdapter, CollectContext } from './types'
import { getJson, errSnap, noDataSnap, snap, balanceWindow, fmtMoney } from './types'
import type { ProviderSnapshot } from '../../shared/types'

// DeepSeek 官方余额接口：GET https://api.deepseek.com/user/balance
// 响应：{ is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }

export const deepseekAdapter: ProviderAdapter = {
  id: 'deepseek',
  name: 'DeepSeek',
  kind: 'balance',
  builtin: true,

  async collect(ctx: CollectContext): Promise<ProviderSnapshot> {
    const key = await ctx.getKey(this.id)
    if (!key) return noDataSnap({ id: this.id, name: this.name }, '未配置 API Key（可在设置中填写或设 DEEPSEEK_API_KEY）', ctx)
    const base = (await ctx.getExtra('baseUrl:deepseek'))?.replace(/\/+$/, '') || 'https://api.deepseek.com'
    try {
      const { status, body } = await getJson(base + '/user/balance', {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json'
      })
      if (status === 401) {
        const hint = base.includes('api.deepseek.com')
          ? '此 key 在官方 api.deepseek.com 无效：请到 platform.deepseek.com 重新生成完整 key（sk- 开头）；若使用中转/聚合平台，请在设置的 Base URL 中填写平台地址'
          : '鉴权失败（401）：请核对该平台的 Key 与 Base URL'
        return errSnap({ id: this.id, name: this.name }, hint, ctx)
      }
      if (status !== 200) return errSnap({ id: this.id, name: this.name }, `HTTP ${status}`, ctx)
      const b = body as { is_available?: boolean; balance_infos?: { currency?: string; total_balance?: string; granted_balance?: string }[] }
      const info = b.balance_infos?.[0]
      const total = Number(info?.total_balance)
      if (!Number.isFinite(total)) return errSnap({ id: this.id, name: this.name }, '响应格式未识别', ctx)
      const unit = info?.currency === 'USD' ? 'usd' : 'cny'
      const noteParts: string[] = []
      if (info?.granted_balance && Number(info.granted_balance) > 0) noteParts.push(`赠送余额 ${fmtMoney(Number(info.granted_balance), unit)}`)
      if (b.is_available === false) noteParts.push('账户不可用')
      return snap({ id: this.id, name: this.name, windows: [balanceWindow(total, unit, noteParts.join(' · ') || undefined)] }, ctx)
    } catch (e) {
      return errSnap({ id: this.id, name: this.name }, `请求失败: ${(e as Error).message}`, ctx)
    }
  }
}
