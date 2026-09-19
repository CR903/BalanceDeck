import { createHash, createHmac } from 'crypto'
import type { ProviderAdapter } from './types'
import { errSnap, identityOf, noDataSnap, officialSnap, readJson } from './engine'
import type { ProviderSnapshot } from '../../shared/types'

// 火山引擎账户余额：费用中心 OpenAPI QueryBalanceAccount。
//   GET https://open.volcengineapi.com/?Action=QueryBalanceAccount&Version=2022-01-01
//   签名：HMAC-SHA256（volcengine V4），service=billing，region=cn-north-1。
// 凭据：主/子账号 AccessKey（权限含"查询账户余额"）。设置中格式："AccessKeyId:SecretAccessKey"。
// 响应字段历史多变，做宽容解析（Result/Data 下寻找余额类字段）。

const HOST = 'open.volcengineapi.com'
const REGION = 'cn-north-1'
const SERVICE = 'billing'

/** volcengine 规范化编码（safe = A-Za-z0-9-_.~） */
function volcEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

export interface VolcCred {
  ak: string
  sk: string
}

export function parseVolcCred(raw: string): VolcCred | null {
  const parts = raw.split(':').map((s) => s.trim())
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return { ak: parts[0], sk: parts[1] }
}

/** 组装带签名的请求 URL（GET，无 body） */
export function signVolcUrl(cred: VolcCred, action: string, version: string, now = new Date()): string {
  const query = `Action=${volcEncode(action)}&Version=${volcEncode(version)}`
  const bodyHash = createHash('sha256').update('').digest('hex')
  const xDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '') // YYYYMMDDTHHMMSSZ
  const date = xDate.slice(0, 8)
  const canonicalHeaders =
    `content-type:application/x-www-form-urlencoded; charset=utf-8\n` + `host:${HOST}\n` + `x-content-sha256:${bodyHash}\n` + `x-date:${xDate}`
  const signedHeaders = 'content-type;host;x-content-sha256;x-date'
  const canonicalRequest = ['GET', '/', query, canonicalHeaders, signedHeaders, bodyHash].join('\n')
  const credentialScope = `${date}/${REGION}/${SERVICE}/request`
  const stringToSign = ['HMAC-SHA256', xDate, credentialScope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n')
  const hmac = (key: Buffer | string, v: string): Buffer => createHmac('sha256', key).update(v).digest()
  const kDate = hmac(cred.sk, date)
  const kRegion = hmac(kDate, REGION)
  const kService = hmac(kRegion, SERVICE)
  const kSigning = hmac(kService, 'request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')
  const authorization = `HMAC-Credential=${cred.ak}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return `https://${HOST}/?${query}&Signature=${volcEncode(authorization)}`
}

const CANDIDATE_KEYS = ['Balance', 'AvailableBalance', 'TotalBalance', 'CashBalance', 'AvailableAmount']

function findAmount(obj: unknown, depth = 0): { amount: number; currency?: string } | null {
  if (depth > 4 || obj === null || typeof obj !== 'object') return null
  const rec = obj as Record<string, unknown>
  for (const k of CANDIDATE_KEYS) {
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

export const volcAdapter: ProviderAdapter = {
  id: 'volc',
  name: '火山方舟',
  kind: 'balance',
  builtin: true,

  async collect(ctx): Promise<ProviderSnapshot> {
    const raw = await ctx.getKey(this.id)
    if (!raw) {
      return noDataSnap(identityOf(this), '未配置 AccessKey（格式 AK:SK，或设 VOLCENGINE_ACCESS_KEY/SECRET_KEY）', ctx)
    }
    const cred = parseVolcCred(raw)
    if (!cred) {
      return errSnap(identityOf(this), '凭据格式错误：应为 AccessKeyId:SecretAccessKey（冒号分隔）', ctx)
    }
    try {
      const { status, body } = await readJson(ctx, signVolcUrl(cred, 'QueryBalanceAccount', '2022-01-01'), { Accept: 'application/json' })
      if (status !== 200) return errSnap(identityOf(this), `HTTP ${status}`, ctx)
      const rec = body as Record<string, unknown>
      const meta = rec?.['ResponseMetadata'] as Record<string, unknown> | undefined
      if (meta && meta['Error']) {
        const err = meta['Error'] as Record<string, unknown>
        return errSnap(
          identityOf(this),
          `API ${String(err['Code'] ?? '')}：${String(err['Message'] ?? '未知错误')}（需费用中心只读权限）`,
          ctx
        )
      }
      const found = findAmount(rec?.['Result'] ?? rec?.['Data'] ?? body)
      if (!found) {
        const preview = typeof body === 'string' ? body : JSON.stringify(body).slice(0, 160)
        return errSnap(identityOf(this), `响应格式未识别：${preview}`, ctx)
      }
      return officialSnap({
        ...identityOf(this),
        windows: [{ name: '账户余额', used: found.amount, unit: 'cny', note: 'Billing 官方接口' }]
      }, ctx)
    } catch (e) {
      return errSnap(identityOf(this), `请求失败: ${(e as Error).message}`, ctx)
    }
  }
}
