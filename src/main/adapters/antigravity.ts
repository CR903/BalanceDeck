// 额度端点与响应形状参考自 robinebers/openusage docs/providers/antigravity.md（MIT）、
// steipete/CodexBar docs/antigravity.md（MIT）、usagebar 文档（MIT fork）。
// 本文件为独立重写实现，未复制任何函数体；aqua5230/usage（AGPL-3.0-only）的代码未读未用。
// ⚠ 使用未文档化的内部接口（cloudcode-pa v1internal），Google 可能随时改版失效。

import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { execFileSync } from 'node:child_process'
import type { ProviderAdapter, CollectContext } from './types'
import { errSnap, identityOf, noDataSnap, officialSnap, readJson } from './engine'
import type { ProviderWindow, ProviderSnapshot } from '../../shared/types'

// ═══════════════════════════════════════════════════════════════════════════════
// Google Antigravity 同步策略（统一模型）
//
// 数据源（Cloud Code v1internal，未公开文档化；两个独立逆向来源互证）：
//   ① POST <base>/v1internal:loadCodeAssist
//      body { metadata: { ideType: 'ANTIGRAVITY', platform, pluginType: 'GEMINI' } }
//      → tier（paidTier.name 优先，currentTier 对 Pro 账号也报 free-tier）+
//        cloudaicompanionProject（配额归属项目）
//   ② POST <base>/v1internal:retrieveUserQuotaSummary
//      body 恰好是 { project }（← 决定成败的字段；不带 project 会假报 100% 剩余，
//      见 usagebar docs/providers/antigravity.md 的明确警告）
//      → groups[] { displayName, buckets[] { bucketId, displayName, window,
//          resetTime, remainingFraction: 0–1 } }（2 池 × 2 窗口）
//   base 按序回退：daily → daily.sandbox → cloudcode-pa（只在抛错/超时时换 host；
//   HTTP 错误状态不换 —— 那是凭据/权限问题，换 host 没用还浪费请求）
//
// 凭据（三源级联，只读，不刷新不回写 —— Keychain 里是 Antigravity 自己的登录态，
// 写坏等于毁掉用户登录；access_token 过期就如实报重登录）：
//   ① macOS Keychain（security 只读）→ ② 旧 token 文件（纯 JSON 只读）→
//   ③ 设置页手动粘贴（ctx.getKey，优先级最低）
//
// 窗口模型：percent-only。官方只给 remainingFraction，没有绝对上限，所以不硬造 limit：
//   { name: '<组名> · <窗口>', used: 0, percent, unit: 'percent' }（一位小数）
// used 恒 0 是"无绝对值来源"，不是"没用过"（codex.ts:158 同款）；组名前缀是因为
// 两组各有 5h + weekly，裸窗口名会重名（design.md D7）。
//
// v1 不做：token 刷新（Q2 A）、IDE SQLite 凭据路径（Q3 A）、fetchAvailableModels
// 回退（只有 5h 口径，per-model 合并正是 oh-my-pi#9940 修掉的 bug）、本机对话库估算。
// ═══════════════════════════════════════════════════════════════════════════════

const BASE_URLS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com'
]
const LOAD_PATH = '/v1internal:loadCodeAssist'
const QUOTA_PATH = '/v1internal:retrieveUserQuotaSummary'
// 实例 baseUrl 覆盖对本适配器不适用：服务端地址固定三选一（无自建/中转概念），
// 设置页改地址不会改变出网目标；preset 的 defaultBaseUrl 仅满足 BuiltinPreset
// 字段要求（与 gemini/cursor 同例 —— 那两家同样硬编码 host）。

/** loadCodeAssist 的 metadata 常量（跟 IDE 发的一致，fixture 里冻住） */
const METADATA = { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }

/** User-Agent 用可识别自己的字符串，不伪装（401/403 时再考虑，见 D4） */
const USER_AGENT = 'BalanceDeck/1.0'

/** window 原值 → 中文标签；未知值原样透传（不写白名单 switch，给未来改版留路） */
const WINDOW_LABELS: Record<string, string> = { '5h': '5小时', weekly: '本周' }

interface AntigravityTier {
  id?: string
  name?: string
}

interface LoadCodeAssistResponse {
  currentTier?: AntigravityTier | null
  paidTier?: AntigravityTier | null
  /** 配额归属项目 id —— 为空说明拿不到归属，这时绝不报数字（假 100% 陷阱） */
  cloudaicompanionProject?: string | null
}

// ─── 凭据发现 ─────────────────────────────────────────────────────────────────

/** 旧 token 文件路径（认 ANTIGRAVITY_TOKEN_FILE；HOME 重定向自然覆盖默认路径） */
export function antigravityTokenFile(): string {
  return (
    process.env.ANTIGRAVITY_TOKEN_FILE ??
    join(homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  )
}

/** Keychain / token 文件都是这个形状：{ token: { access_token, … } } */
function accessTokenOf(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null
  const o = v as { token?: unknown; access_token?: unknown }
  const inner = o.token && typeof o.token === 'object'
    ? (o.token as { access_token?: unknown }).access_token
    : undefined
  const cand = inner ?? o.access_token
  return typeof cand === 'string' && cand ? cand : null
}

/** Keychain 值解码：剥 go-keyring-base64: 前缀（base64 解后 parse），再取 access_token */
function parseKeychainValue(raw: string): string | null {
  let text = raw.trim()
  if (!text) return null
  const PREFIX = 'go-keyring-base64:'
  if (text.startsWith(PREFIX)) {
    try {
      text = Buffer.from(text.slice(PREFIX.length).trim(), 'base64').toString('utf-8')
    } catch {
      return null
    }
  }
  try {
    return accessTokenOf(JSON.parse(text))
  } catch {
    return null
  }
}

function readKeychainRaw(): string | null {
  // ANTIGRAVITY_KEYCHAIN 是测试替身，不是正式功能：设了就用它的值代替 execFile，
  // 别把它当第二凭据源宣传（design.md D10）。
  if (process.env.ANTIGRAVITY_KEYCHAIN !== undefined) return process.env.ANTIGRAVITY_KEYCHAIN
  if (process.platform !== 'darwin') return null
  try {
    // 只读，不走 shell（无注入面）；条目不存在即非 0 退出，由 catch 跳过
    const out = execFileSync('security', ['find-generic-password', '-a', 'antigravity', '-s', 'gemini', '-w'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return typeof out === 'string' ? out : null
  } catch {
    return null
  }
}

/**
 * 凭据三源级联（只读）：macOS Keychain → 旧 token 文件。
 * 逐个 try/catch（ENOENT 安全），失败即跳过下一个来源；手动粘贴不在这里，由 collect 兜底。
 */
export function readAntigravityToken(): { token: string; source: 'keychain' | 'file' } | null {
  const raw = readKeychainRaw()
  if (raw !== null) {
    const t = parseKeychainValue(raw)
    if (t) return { token: t, source: 'keychain' }
  }
  try {
    const p = antigravityTokenFile()
    if (!existsSync(p)) return null
    const t = accessTokenOf(JSON.parse(readFileSync(p, 'utf-8')))
    if (t) return { token: t, source: 'file' }
  } catch {
    // 继续走手动粘贴兜底
  }
  return null
}

// ─── 小工具 ───────────────────────────────────────────────────────────────────

/** plan 取 paidTier.name 优先于 currentTier.name；都没有才留空（不编造） */
function tierName(loaded: LoadCodeAssistResponse): string | undefined {
  const t = loaded.paidTier ?? loaded.currentTier
  if (!t) return undefined
  if (typeof t.name === 'string' && t.name) return t.name
  return undefined
}

function safeText(body: unknown): string {
  try {
    return typeof body === 'string' ? body : JSON.stringify(body ?? '')
  } catch {
    return ''
  }
}

/** 403 透传的 reason 候选（服务端把原因放在这几个位置） */
function reasonOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const o = body as { reason?: unknown; error?: unknown }
  const e = (o.error && typeof o.error === 'object' ? o.error : {}) as {
    reason?: unknown
    status?: unknown
    message?: unknown
  }
  for (const cand of [o.reason, e.reason, e.status, e.message]) {
    if (typeof cand === 'string' && cand.trim()) return cand.trim()
  }
  return null
}

/**
 * 429 的 Retry-After：接缝只回传 status + body，没有响应头可读，
 * 所以只认 body 里同名字段；没有就走基础文案（不编造秒数）。
 */
function retryAfterOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const o = body as { retryAfter?: unknown; retry_after?: unknown }
  for (const cand of [o.retryAfter, o.retry_after]) {
    const s = typeof cand === 'number' ? String(cand) : typeof cand === 'string' ? cand.trim() : ''
    if (s) return s
  }
  return null
}

function previewOf(body: unknown): string {
  return safeText(body).slice(0, 160)
}

// ─── 响应解析（纯函数，plan-utils 模式） ──────────────────────────────────────

function groupsOf(body: unknown): unknown[] | null {
  if (!body || typeof body !== 'object') return null
  const o = body as { groups?: unknown; response?: unknown; summary?: unknown }
  if (Array.isArray(o.groups)) return o.groups
  if (o.response && typeof o.response === 'object') {
    const g = (o.response as { groups?: unknown }).groups
    if (Array.isArray(g)) return g
  }
  if (o.summary && typeof o.summary === 'object') {
    const g = (o.summary as { groups?: unknown }).groups
    if (Array.isArray(g)) return g
  }
  return null
}

function fractionOf(b: {
  remainingFraction?: unknown
  remaining_fraction?: unknown
  remaining?: unknown
}): number | undefined {
  if (typeof b.remainingFraction === 'number') return b.remainingFraction
  if (typeof b.remaining_fraction === 'number') return b.remaining_fraction
  const r = b.remaining
  if (r && typeof r === 'object') {
    const ro = r as { case?: unknown; value?: unknown }
    // case-value 写法：只有 case 恰好是 remainingFraction 时才取 value
    if (ro.case === 'remainingFraction' && typeof ro.value === 'number') return ro.value
  }
  return undefined
}

/**
 * quota 响应 → 窗口数组；形状不可识别或无可用 bucket 时返回 null。
 * 宽容只在"形状"（三种 groups 位置、三种 fraction 写法），不在"值"：
 * fraction 不在 0..1 直接跳过该 bucket（不 clamp 成 0/100 —— 那是撒谎）。
 */
export function parseQuotaSummary(body: unknown): ProviderWindow[] | null {
  const groups = groupsOf(body)
  if (!groups) return null
  const windows: ProviderWindow[] = []
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue
    const gg = g as { displayName?: unknown; buckets?: unknown }
    // 组名用服务端原文，不发明映射；没有名字的组跳过（起不出诚实的名字）
    if (typeof gg.displayName !== 'string' || !gg.displayName) continue
    if (!Array.isArray(gg.buckets)) continue
    for (const b of gg.buckets) {
      if (!b || typeof b !== 'object') continue
      const bb = b as {
        displayName?: unknown
        window?: unknown
        resetTime?: unknown
        remainingFraction?: unknown
        remaining_fraction?: unknown
        remaining?: unknown
      }
      if (typeof bb.window !== 'string' || !bb.window) continue
      const frac = fractionOf(bb)
      if (typeof frac !== 'number' || !Number.isFinite(frac) || frac < 0 || frac > 1) continue
      const w: ProviderWindow = {
        name: `${gg.displayName} · ${WINDOW_LABELS[bb.window] ?? bb.window}`,
        // used 恒 0 是"无绝对值来源"，不是"没用过"（codex.ts:158 同款）
        used: 0,
        unit: 'percent',
        percent: Math.round((1 - frac) * 100 * 10) / 10,
        note: typeof bb.displayName === 'string' && bb.displayName ? bb.displayName : undefined
      }
      // resetTime 非法 → resetAt 整个字段省略（不写 null）
      if (typeof bb.resetTime === 'string' && bb.resetTime && Number.isFinite(Date.parse(bb.resetTime))) {
        w.resetAt = bb.resetTime
      }
      windows.push(w)
    }
  }
  return windows.length > 0 ? windows : null
}

// ─── 适配器主体 ─────────────────────────────────────────────────────────────

export const antigravityAdapter: ProviderAdapter = {
  id: 'antigravity',
  name: 'Google Antigravity',
  kind: 'coding',
  builtin: true,

  async collect(ctx: CollectContext): Promise<ProviderSnapshot> {
    const me = identityOf(this)

    // ── 1. 凭据：本机登录态优先，手动粘贴兜底（优先级最低） ──
    const found = readAntigravityToken()
    let token = found ? found.token : null
    let via: 'keychain' | 'file' | 'manual' | null = found ? found.source : null
    if (!token) {
      let manual: string | null = null
      try {
        manual = await ctx.getKey(me.id)
      } catch {
        manual = null
      }
      if (manual && manual.trim()) {
        token = manual.trim()
        via = 'manual'
      }
    }
    if (!token) {
      return noDataSnap(me, '未找到 Antigravity 凭据（请先在 Antigravity 或 agy 中登录一次）', ctx)
    }

    // 三个头显式写全（测试桩不模拟接缝自动补，不显写就是假覆盖）；
    // 不发 Connect-Protocol-Version（该头只见于本机 LS 文档，Cloud Code 无证据要求它）。
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': USER_AGENT
    }

    // 按序换 host 重发**同一个**请求：只在抛错/超时时换，
    // HTTP 错误状态直接返回（那是凭据/权限问题，换 host 没用）。
    const postEachHost = async (path: string, body: string): Promise<{ status: number; body: unknown }> => {
      let lastErr: unknown = null
      for (const base of BASE_URLS) {
        try {
          return await readJson(ctx, `${base}${path}`, headers, 12000, { method: 'POST', body })
        } catch (e) {
          lastErr = e
        }
      }
      throw lastErr
    }
    const httpErr = (status: number, body: unknown): ProviderSnapshot => {
      if (status === 401) {
        return errSnap(me, 'Antigravity 凭据已失效（HTTP 401）：请在 Antigravity 中重新登录', ctx)
      }
      if (status === 403) {
        const text = safeText(body)
        if (text.includes('SUBSCRIPTION_REQUIRED')) {
          return errSnap(me, '当前账号无有效 Antigravity 订阅（免费档可能不提供额度接口）', ctx)
        }
        if (text.includes('VALIDATION_REQUIRED')) {
          return errSnap(me, 'Google 账号需完成验证（VALIDATION_REQUIRED）：请按 Google 提示完成验证后重试', ctx)
        }
        const reason = reasonOf(body)
        return errSnap(me, reason ? `Antigravity 接口拒绝访问（HTTP 403）：${reason}` : 'HTTP 403', ctx)
      }
      if (status === 429) {
        const ra = retryAfterOf(body)
        return errSnap(
          me,
          ra
            ? `Antigravity 配额接口限流（HTTP 429，${ra} 秒后重试）：稍后将自动重试`
            : 'Antigravity 配额接口限流（HTTP 429）：稍后将自动重试',
          ctx
        )
      }
      return errSnap(me, `HTTP ${status}`, ctx)
    }

    // ── 2. loadCodeAssist：tier + 配额归属项目 ──
    let la: { status: number; body: unknown }
    try {
      la = await postEachHost(LOAD_PATH, JSON.stringify({ metadata: METADATA }))
    } catch (e) {
      return errSnap(me, `请求失败: ${(e as Error).message}`, ctx)
    }
    if (la.status !== 200) return httpErr(la.status, la.body)
    const loaded = (la.body ?? {}) as LoadCodeAssistResponse
    const project = typeof loaded.cloudaicompanionProject === 'string' ? loaded.cloudaicompanionProject.trim() : ''
    // project 缺失直接截停，第二个请求不发（假 100% 陷阱，design.md D6）
    if (!project) {
      return errSnap(
        me,
        '服务端未返回配额归属项目（loadCodeAssist 未给出 cloudaicompanionProject）：为避免假 100% 剩余，本轮不报数字',
        ctx
      )
    }

    // ── 3. retrieveUserQuotaSummary：body 恰好是 { project } ──
    let q: { status: number; body: unknown }
    try {
      q = await postEachHost(QUOTA_PATH, JSON.stringify({ project }))
    } catch (e) {
      return errSnap(me, `请求失败: ${(e as Error).message}`, ctx)
    }
    if (q.status !== 200) return httpErr(q.status, q.body)
    const windows = parseQuotaSummary(q.body)
    if (!windows) {
      return errSnap(me, `响应格式未识别：${previewOf(q.body)}`, ctx)
    }
    const detail =
      via === 'keychain'
        ? '本机登录态自动读取（Keychain）'
        : via === 'file'
          ? '本机登录态自动读取（token 文件）'
          : '手动配置的凭据'
    return officialSnap({ ...me, plan: tierName(loaded), windows, source: 'Antigravity 接口', detail }, ctx)
  }
}
