// 端点常量与响应字段名参考自 google-gemini/gemini-cli（Apache-2.0, Google LLC）
// 与 rarf/hermes-quota-plugin（MIT）。本文件为独立重写实现，未复制任何函数体。

import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import type { ProviderAdapter, CollectContext } from './types'
import { errSnap, identityOf, noDataSnap, officialSnap, readJson } from './engine'
import type { ProviderWindow, ProviderSnapshot } from '../../shared/types'

// ═══════════════════════════════════════════════════════════════════════════════
// Gemini Code Assist 同步策略（统一模型）
//
// 数据源（Gemini CLI 官方客户端自己在用的端点族，未公开文档化）：
//   ① POST https://oauth2.googleapis.com/token（仅 access_token 过期时）
//      Content-Type: application/x-www-form-urlencoded（⚠ 不是 JSON）
//   ② POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist
//      body { metadata: { ideType, platform, pluginType: 'GEMINI' } }
//      → tier（paidTier 优先）+ cloudaicompanionProject（配额归属项目）
//   ③ POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
//      body 恰好是 { project }（← 决定成败的字段，缺了服务端直接拒）
//      → buckets[] { modelId, tokenType, remainingFraction: 0–1, resetTime }
//
// 凭据（只读，不回写 keystore —— client_id/secret 本来就在那个文件里，
// 搬进 secrets.bin 等于把 Gemini CLI 的长效凭据存两份）：
//   $GEMINI_CLI_HOME/oauth_creds.json → ~/.gemini/oauth_creds.json →
//   $GOOGLE_APPLICATION_CREDENTIALS → ~/.config/gcloud/application_default_credentials.json
//
// 窗口模型：percent-only。官方只给 remainingFraction，没有可靠的绝对上限
// （remainingAmount 只在部分时刻给，100% 时省略），所以不硬造 limit：
//   { name: modelId, used: percent, percent, unit: 'percent' }（一位小数）
// 只保留 tokenType === 'REQUESTS' 的桶 —— 这是「配额池读数」，不是「还能发多少请求」。
//
// 范围：只做 Code Assist Standard / Enterprise。免费 / Pro / Ultra 档 Google 已于
// 2026-06-18 关停（Login with Google 选项已移除），命中即给退役文案走 errSnap。
// ═══════════════════════════════════════════════════════════════════════════════

const CODE_ASSIST_HOST = 'https://cloudcode-pa.googleapis.com'
const LOAD_ENDPOINT = `${CODE_ASSIST_HOST}/v1internal:loadCodeAssist`
const QUOTA_ENDPOINT = `${CODE_ASSIST_HOST}/v1internal:retrieveUserQuota`
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

const FORM_CT = 'application/x-www-form-urlencoded'
const JSON_CT = 'application/json'

/** loadCodeAssist 的 metadata 常量（跟官方 setup.ts 一致，fixture 里冻住） */
const METADATA = { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }

interface GeminiCreds {
  access_token?: string
  refresh_token?: string
  /** google-auth-library 约定是 epoch 毫秒（未在本机文件核对，解析时防 NaN） */
  expiry_date?: number | string
  client_id?: string
  client_secret?: string
}

interface GeminiTier {
  id?: string
  name?: string
}

interface IneligibleTier {
  tierId?: string
  reasonMessage?: string
}

interface LoadCodeAssistResponse {
  currentTier?: GeminiTier | null
  paidTier?: GeminiTier | null
  allowedTiers?: GeminiTier[] | null
  ineligibleTiers?: IneligibleTier[] | null
  /** 配额归属项目 id —— 为空说明该账号没绑 Code Assist 许可 */
  cloudaicompanionProject?: string | null
}

interface BucketInfo {
  /** int64 字符串；100% 时 Google 会省略（只看 remainingFraction） */
  remainingAmount?: string
  /** 0–1，1 = 100% 剩余；缺失的桶直接跳过（不产 NaN） */
  remainingFraction?: number
  /** RFC3339；缺失时 resetAt 整个字段省略 */
  resetTime?: string
  tokenType?: string
  modelId?: string
}

interface RetrieveUserQuotaResponse {
  /** 官方类型定义里的键 */
  buckets?: BucketInfo[]
  /** 第三方实现里见过的键（与官方矛盾），只作宽容回落 */
  quota?: BucketInfo[]
}

/** Gemini CLI 的全局目录（认 GEMINI_CLI_HOME，与 CLAUDE_CONFIG_DIR / CODEX_HOME 同一惯例） */
export function geminiHome(): string {
  return process.env.GEMINI_CLI_HOME || join(homedir(), '.gemini')
}

/** 文件内容能用才算命中：有 refresh_token 或 access_token 任一即可 */
function usableCreds(v: unknown): GeminiCreds | null {
  if (!v || typeof v !== 'object') return null
  const c = v as GeminiCreds
  if (typeof c.refresh_token === 'string' && c.refresh_token) return c
  if (typeof c.access_token === 'string' && c.access_token) return c
  // service_account 等形状（既无 refresh_token 也无 access_token）：
  // 不是「坏文件」，只是这条路走不通 —— 返回 null 继续试下一条，不报错
  return null
}

/** 凭据发现：4 条路径按序尝试，逐个 try/catch（ENOENT 安全），全部未命中返回 null */
export function readGeminiCreds(): GeminiCreds | null {
  const candidates: string[] = [join(geminiHome(), 'oauth_creds.json')]
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) candidates.push(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  candidates.push(join(homedir(), '.config', 'gcloud', 'application_default_credentials.json'))
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue
      const creds = usableCreds(JSON.parse(readFileSync(p, 'utf-8')))
      if (creds) return creds
    } catch {
      // 继续尝试下一个路径（文件不存在 / 损坏都不抛）
    }
  }
  return null
}

/** access_token 仍有效则直接返回；否则返回 null（由调用方走刷新流程） */
function validAccessToken(c: GeminiCreds): string | null {
  if (typeof c.access_token !== 'string' || !c.access_token) return null
  const exp = Number(c.expiry_date)
  // expiry_date 缺失或非数字 → 有效期不可信，按过期处理（宁可多刷一次）
  if (!Number.isFinite(exp)) return null
  return Date.now() < exp - 30_000 ? c.access_token : null
}

/** token 刷新失败里最要紧的一条：400 + invalid_grant（⚠ 不是 401，别判错地方） */
function saysInvalidGrant(body: unknown): boolean {
  try {
    const text = typeof body === 'string' ? body : JSON.stringify(body ?? '')
    return text.includes('invalid_grant')
  } catch {
    return false
  }
}

const TIER_NAMES: Record<string, string> = {
  'standard-tier': 'Standard',
  'enterprise-tier': 'Enterprise',
  'legacy-tier': 'Legacy'
}

/** plan 取 paidTier.name 优先于 currentTier.name；都没有才回落 id */
function tierName(loaded: LoadCodeAssistResponse): string | undefined {
  const t = loaded.paidTier ?? loaded.currentTier
  if (!t) return undefined
  if (typeof t.name === 'string' && t.name) return t.name
  if (typeof t.id === 'string' && t.id) return TIER_NAMES[t.id] ?? t.id
  return undefined
}

/**
 * 403 的两条可操作分支（⚠ 不照抄 gemini-cli「假装 standard-tier」的做法）。
 * 返回文案则命中，返回 null 则调用方走通用凭据失效文案。
 */
function denyReason(body: unknown, status: number): string | null {
  if (status !== 403) return null
  let text = ''
  try {
    text = typeof body === 'string' ? body : JSON.stringify(body ?? '')
  } catch {
    text = ''
  }
  if (text.includes('SECURITY_POLICY_VIOLATED')) {
    return '请求被 VPC 服务边界拦截（SECURITY_POLICY_VIOLATED）：请联系管理员放行，或切换网络后重试'
  }
  const proj = (body as { cloudaicompanionProject?: unknown } | null)?.cloudaicompanionProject
  if (proj === 'cloudshell-gca' || text.includes('cloudshell-gca')) {
    return '默认 Cloud Shell 项目无 Code Assist 许可（cloudshell-gca）：请执行 gcloud config set project <你的项目ID> 后重试'
  }
  return null
}

/**
 * 免费档退役（终态：数据源 2026-06-18 永久消失）。
 * currentTier.id 与 ineligibleTiers 两条都判；reasonMessage 未验证过，直接回显 Google 原文。
 */
function retiredReason(loaded: LoadCodeAssistResponse): string | null {
  const free = loaded.currentTier?.id === 'free-tier'
  const inelig = Array.isArray(loaded.ineligibleTiers)
    ? loaded.ineligibleTiers.find((t) => t?.tierId === 'free-tier')
    : undefined
  if (!free && !inelig) return null
  const echo =
    typeof inelig?.reasonMessage === 'string' && inelig.reasonMessage ? `（${inelig.reasonMessage}）` : ''
  return `Google 已于 2026-06-18 关停 Code Assist 个人免费档 / AI Pro / Ultra（Login with Google 已移除），本账号无可查额度${echo}：如需继续使用请绑定 Workspace Code Assist Standard / Enterprise 许可`
}

// ─── 适配器主体 ─────────────────────────────────────────────────────────────

export const geminiAdapter: ProviderAdapter = {
  id: 'gemini',
  name: 'Gemini Code Assist',
  kind: 'coding',
  builtin: true,

  async collect(ctx: CollectContext): Promise<ProviderSnapshot> {
    const me = identityOf(this)
    const creds = readGeminiCreds()
    if (!creds) {
      return noDataSnap(me, '未找到 Gemini 凭据（先运行 gemini 登录，或配置 gcloud ADC）', ctx)
    }

    // ── 1. access_token：有效则直接用，不新增无谓出网 ──
    let token = validAccessToken(creds)
    if (!token) {
      if (!creds.refresh_token) {
        return errSnap(me, 'Gemini 凭据不完整（无可用 access_token 也无 refresh_token）：请重新运行 gemini 登录', ctx)
      }
      const form =
        `grant_type=refresh_token&refresh_token=${encodeURIComponent(creds.refresh_token)}` +
        `&client_id=${encodeURIComponent(creds.client_id ?? '')}` +
        `&client_secret=${encodeURIComponent(creds.client_secret ?? '')}`
      let tr: { status: number; body: unknown }
      try {
        tr = await readJson(
          ctx,
          TOKEN_ENDPOINT,
          { 'Content-Type': FORM_CT, Accept: JSON_CT },
          12000,
          { method: 'POST', body: form }
        )
      } catch (e) {
        return errSnap(me, `请求失败: ${(e as Error).message}`, ctx)
      }
      if (tr.status === 400 && saysInvalidGrant(tr.body)) {
        return errSnap(me, 'Gemini 凭据已失效（refresh token 被吊销）：请重新运行 gemini 登录', ctx)
      }
      if (tr.status !== 200) return errSnap(me, `HTTP ${tr.status}`, ctx)
      const fresh = (tr.body as { access_token?: unknown } | null)?.access_token
      if (typeof fresh !== 'string' || !fresh) {
        const preview = typeof tr.body === 'string' ? tr.body : JSON.stringify(tr.body).slice(0, 160)
        return errSnap(me, `响应格式未识别：${preview}`, ctx)
      }
      token = fresh
    }

    const auth = { Authorization: `Bearer ${token}`, Accept: JSON_CT, 'Content-Type': JSON_CT }

    // ── 2. loadCodeAssist：tier + 配额归属项目 ──
    let la: { status: number; body: unknown }
    try {
      la = await readJson(ctx, LOAD_ENDPOINT, auth, 12000, {
        method: 'POST',
        body: JSON.stringify({ metadata: METADATA })
      })
    } catch (e) {
      return errSnap(me, `请求失败: ${(e as Error).message}`, ctx)
    }
    if (la.status === 401 || la.status === 403) {
      return errSnap(me, denyReason(la.body, la.status) ?? `凭据失效（HTTP ${la.status}）：请重新运行 gemini 登录`, ctx)
    }
    if (la.status !== 200) return errSnap(me, `HTTP ${la.status}`, ctx)
    const loaded = (la.body ?? {}) as LoadCodeAssistResponse

    // ── 3. 免费档退役 → errSnap（failureReason 能透出到托盘；ok + 空窗口做不到） ──
    const retired = retiredReason(loaded)
    if (retired) return errSnap(me, retired, ctx)

    const project = typeof loaded.cloudaicompanionProject === 'string' ? loaded.cloudaicompanionProject : ''
    if (!project) {
      return errSnap(me, '服务端未返回配额归属项目（该账号未绑定 Code Assist Standard / Enterprise 许可）', ctx)
    }

    // ── 4. retrieveUserQuota：body 恰好是 { project } ──
    let q: { status: number; body: unknown }
    try {
      q = await readJson(ctx, QUOTA_ENDPOINT, auth, 12000, {
        method: 'POST',
        body: JSON.stringify({ project })
      })
    } catch (e) {
      return errSnap(me, `请求失败: ${(e as Error).message}`, ctx)
    }
    if (q.status === 401 || q.status === 403) {
      return errSnap(me, denyReason(q.body, q.status) ?? `凭据失效（HTTP ${q.status}）：请重新运行 gemini 登录`, ctx)
    }
    if (q.status !== 200) return errSnap(me, `HTTP ${q.status}`, ctx)
    const qb = (q.body ?? {}) as RetrieveUserQuotaResponse
    const buckets = Array.isArray(qb.buckets) ? qb.buckets : Array.isArray(qb.quota) ? qb.quota : null
    if (!buckets) {
      const preview = typeof q.body === 'string' ? q.body : JSON.stringify(q.body).slice(0, 160)
      return errSnap(me, `响应格式未识别：${preview}`, ctx)
    }

    // ── 5. 窗口：只保留 REQUESTS 桶；percent-only，不硬造 limit ──
    const windows: ProviderWindow[] = []
    for (const b of buckets) {
      if (!b || typeof b !== 'object') continue
      if (b.tokenType !== 'REQUESTS') continue
      if (typeof b.remainingFraction !== 'number' || !Number.isFinite(b.remainingFraction)) continue
      const pct = Math.round((1 - b.remainingFraction) * 100 * 10) / 10
      const w: ProviderWindow = {
        name: typeof b.modelId === 'string' && b.modelId ? b.modelId : '配额',
        used: pct,
        percent: pct,
        unit: 'percent',
        note: '官方配额接口'
      }
      // resetTime 缺失 → resetAt 整个字段省略（不写 null）
      if (typeof b.resetTime === 'string' && b.resetTime && Number.isFinite(Date.parse(b.resetTime))) {
        w.resetAt = b.resetTime
      }
      windows.push(w)
    }
    if (windows.length === 0) {
      return errSnap(me, '官方接口未返回可用的 REQUESTS 配额桶（当前无可查额度）', ctx)
    }
    return officialSnap({ ...me, plan: tierName(loaded), windows, source: '官方接口' }, ctx)
  }
}
