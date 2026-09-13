import { createHmac, randomUUID } from 'crypto'
import type { ProviderAdapter } from './types'
import { getJson, errSnap, noDataSnap, snap } from './types'
import type { ProviderSnapshot } from '../../shared/types'

// 通义千问（阿里云百炼）余额：阿里云 BSS OpenAPI QueryAccountBalance（RPC 风格 GET 签名）。
// 凭据建议使用只读 RAM 子账号 AccessKey（权限：AliyunBSSReadOnlyAccess）。
// 设置中凭据格式："AccessKeyId:AccessKeySecret"（或 "AK:SK:SecurityToken"）。
// 响应：{ Code: "Success", Data: { AvailableAmount, Currency } }。

const BSS_ENDPOINT = 'https://business-api.aliyun.com'

/** 阿里云 POP 编码（RFC3986，但 * 不转义、~ 转义） */
function popEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~')
}

export interface AliCred {
  ak: string
  sk: string
  sts?: string
}

export function parseAliCred(raw: string): AliCred | null {
  const parts = raw.split(':').map((s) => s.trim())
  if (parts.length < 2 || !parts[0] || !parts[1]) return null
  return { ak: parts[0], sk: parts[1], sts: parts[2] || undefined }
}

/** 组装带签名的 BSS RPC GET URL */
export function signBssUrl(cred: AliCred, action: string, version: string, now = new Date()): string {
  const params: Record<string, string> = {
    Action: action,
    Format: 'JSON',
    Version: version,
    AccessKeyId: cred.ak,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: randomUUID(),
    Timestamp: now.toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
  if (cred.sts) params['SecurityToken'] = cred.sts
  const canon = Object.keys(params)
    .sort()
    .map((k) => `${popEncode(k)}=${popEncode(params[k])}`)
    .join('&')
  const stringToSign = `GET&${popEncode('/')}&${popEncode(canon)}`
  const signature = createHmac('sha1', cred.sk + '&').update(stringToSign).digest('base64')
  return `${BSS_ENDPOINT}/?${canon}&Signature=${popEncode(signature)}`
}

function findAmount(obj: unknown, depth = 0): { amount: number; currency?: string } | null {
  if (depth > 4 || obj === null || typeof obj !== 'object') return null
  const rec = obj as Record<string, unknown>
  for (const k of ['AvailableAmount', 'AvailableBalance', 'TotalBalance', 'Balance']) {
    const v = rec[k]
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
    if (Number.isFinite(n)) return { amount: n, currency: typeof rec['Currency'] === 'string' ? rec['Currency'] : undefined }
  }
  for (const v of Object.values(rec)) {
    const found = findAmount(v, depth + 1)
    if (found !== null) return found
  }
  return null
}

export const qwenAdapter: ProviderAdapter = {
  id: 'qwen',
  name: '通义千问',
  kind: 'balance',
  builtin: true,

  async collect(ctx): Promise<ProviderSnapshot> {
    const raw = await ctx.getKey(this.id)
    if (!raw) {
      return noDataSnap(
        { id: this.id, name: this.name },
        '未配置 AccessKey（格式 AK:SK，建议只读 RAM 子账号；或设 ALIBABA_CLOUD_ACCESS_KEY_ID/SECRET）',
        ctx
      )
    }
    const cred = parseAliCred(raw)
    if (!cred) {
      return errSnap({ id: this.id, name: this.name }, '凭据格式错误：应为 AccessKeyId:AccessKeySecret（冒号分隔）', ctx)
    }
    try {
      const { status, body } = await getJson(signBssUrl(cred, 'QueryAccountBalance', '2017-12-14'), { Accept: 'application/json' })
      if (status !== 200) return errSnap({ id: this.id, name: this.name }, `HTTP ${status}`, ctx)
      const rec = body as Record<string, unknown>
      if (rec && typeof rec.Code === 'string' && rec.Code !== 'Success') {
        const msg = typeof rec.Message === 'string' ? rec.Message : ''
        return errSnap(
          { id: this.id, name: this.name },
          `BSS ${rec.Code}${msg ? '：' + msg : ''}（需 AliyunBSSReadOnlyAccess 权限）`,
          ctx
        )
      }
      const found = findAmount(rec?.['Data'] ?? body)
      if (!found) {
        const preview = typeof body === 'string' ? body : JSON.stringify(body).slice(0, 160)
        return errSnap({ id: this.id, name: this.name }, `响应格式未识别：${preview}`, ctx)
      }
      return snap({
        id: this.id,
        name: this.name,
        windows: [{ name: '账户余额', used: found.amount, unit: 'cny', note: 'BSS 官方接口' }]
      }, ctx)
    } catch (e) {
      return errSnap({ id: this.id, name: this.name }, `请求失败: ${(e as Error).message}`, ctx)
    }
  }
}
