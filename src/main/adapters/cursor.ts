// 额度端点与凭据路径参考自 steipete/CodexBar docs/cursor.md（MIT）、
// cbnsndwch/pacebar docs/providers/cursor（MIT）。本文件为独立重写实现，未复制任何函数体。
// ⚠ 使用未文档化的 dashboard 接口（api2.cursor.sh），Cursor 可能随时改版失效。

import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import type { ProviderAdapter, CollectContext } from './types'
import { errSnap, identityOf, noDataSnap, officialSnap, readJson } from './engine'
import type { ProviderWindow, ProviderSnapshot } from '../../shared/types'

// ═══════════════════════════════════════════════════════════════════════════════
// Cursor 同步策略（统一模型）
//
// 数据源（Connect RPC，未公开文档化）：
//   POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage
//   headers: Authorization: Bearer <jwt> + Content-Type: application/json +
//            Connect-Protocol-Version: 1
//   body: '{}'（Connect RPC 的空 message）
//   → planUsage.{includedSpend, remaining, limit}（单位：分）+
//     billingCycleStart/End（unix 毫秒字符串）+
//     spendLimitUsage.{individualLimit/Used, pooledLimit/Used, limitType}
//
// 凭据（三源级联，只读，不写 Cursor 的任何文件）：
//   ① state.vscdb 的 cursorAuth/accessToken（IDE 登录态，最鲜活）
//   ② CLI auth.json 的 accessToken（多候选路径试探）
//   ③ 设置页手动粘贴（ctx.getKey，优先级最低）
//   刷新权在 Cursor 自己手里：不实现 oauth/token 刷新、不做 setKey 回写、
//   不把 token 缓存进 items（缓存副本只会比 Cursor 维护的那份旧）。
//
// ⚠ percent 只用绝对值自算（includedSpend / limit），服务端下发的
//   totalPercentUsed / autoPercentUsed / apiPercentUsed 三个字段刻意不读 ——
//   Cursor 官方承认它们不等于 spend/limit，且 2026-08 出过连续 3 天冻结的事故
//   （用户实际已用 64.4%，字段显示 3.73%）。快照里不出现这三个键。
//
// 不变量（schema drift 的唯一探测器）：includedSpend + remaining === limit
//   （比较前不换算单位：三个值全是分，同单位直接加；展示时才 /100）。
// ═══════════════════════════════════════════════════════════════════════════════

export const CURSOR_USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage'

interface CursorPlanUsage {
  includedSpend?: unknown
  remaining?: unknown
  limit?: unknown
}

interface CursorSpendLimit {
  individualLimit?: unknown
  individualUsed?: unknown
  individualRemaining?: unknown
  pooledLimit?: unknown
  pooledUsed?: unknown
  pooledRemaining?: unknown
  limitType?: unknown
}

interface CursorUsageResponse {
  billingCycleStart?: unknown
  billingCycleEnd?: unknown
  planUsage?: CursorPlanUsage | null
  spendLimitUsage?: CursorSpendLimit | null
  isUnlimited?: unknown
}

// ─── 凭据发现 ─────────────────────────────────────────────────────────────────

/** IDE 登录态数据库（认 CURSOR_STATE_DB，测试注入缝） */
export function cursorStateDb(): string {
  if (process.env.CURSOR_STATE_DB) return process.env.CURSOR_STATE_DB
  const home = homedir()
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    return join(base, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config')
  return join(xdg, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

/** CLI auth.json 多候选路径（上游三方分歧，逐个试探；CURSOR_CONFIG_DIR 可覆盖） */
export function cursorAuthJsonCandidates(): string[] {
  const out: string[] = []
  if (process.env.CURSOR_CONFIG_DIR) out.push(join(process.env.CURSOR_CONFIG_DIR, 'auth.json'))
  if (process.env.XDG_CONFIG_HOME) out.push(join(process.env.XDG_CONFIG_HOME, 'cursor', 'auth.json'))
  out.push(join(homedir(), '.cursor', 'auth.json'))
  if (process.platform === 'darwin') {
    out.push(join(homedir(), 'Library', 'Application Support', 'cursor', 'auth.json'))
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    out.push(join(process.env.APPDATA, 'Cursor', 'auth.json'))
  }
  return out
}

/**
 * state.vscdb 的值是 VS Code 式全局存储：字符串常被再包一层 JSON
 * （如 `"eyJ…"`）；token 也可能是 UTF-16LE BLOB 落盘（CodexBar 实证：
 * BOM-less ASCII UTF-16LE，不先识别就会留下交错的 NUL 字节）。
 * BLOB 先按 UTF-16LE 试探（奇位全零即认），否则按 UTF-8；再去 NUL、
 * 再 JSON 试探，失败则当 raw 字符串 —— 各种形态都认。
 */
function looksUtf16Le(u: Uint8Array): boolean {
  if (u.length === 0 || u.length % 2 !== 0) return false
  for (let i = 1; i < u.length; i += 2) {
    if (u[i] !== 0) return false
  }
  return true
}

function coerceText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') return raw
  if (raw instanceof Uint8Array) {
    return looksUtf16Le(raw) ? Buffer.from(raw).toString('utf16le') : Buffer.from(raw).toString('utf-8')
  }
  return String(raw)
}

function decodeStoreValue(raw: unknown): string | null {
  let s = coerceText(raw)
  if (!s) return null
  s = s.replace(/\0/g, '').trim()
  if (!s) return null
  try {
    const v: unknown = JSON.parse(s)
    if (typeof v === 'string') {
      const t = v.replace(/\0/g, '').trim()
      return t || null
    }
    if (v && typeof v === 'object') {
      const t = (v as { accessToken?: unknown }).accessToken
      if (typeof t === 'string' && t.replace(/\0/g, '').trim()) return t.replace(/\0/g, '').trim()
    }
    return s
  } catch {
    return s
  }
}

interface VscdbHit {
  token: string | null
  plan: string | undefined
}

/** 从 state.vscdb 只读一条 accessToken（+ 顺带读套餐名，零成本） */
async function readVscdb(): Promise<VscdbHit | null> {
  const dbPath = cursorStateDb()
  if (!existsSync(dbPath)) return null
  // 照 opencode.ts 的动态 import 写法：只在真需要时加载
  const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
    DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => {
      prepare(sql: string): {
        get(...params: unknown[]): Record<string, unknown> | undefined
      }
      close(): void
    }
  }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const get = (key: string): string | null => {
      const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key)
      const v = row ? (row as { value?: unknown }).value : undefined
      return decodeStoreValue(v)
    }
    const token = get('cursorAuth/accessToken')
    if (!token) return null
    const membership = get('cursorAuth/stripeMembershipType')
    return { token, plan: membership ? titleCase(membership) : undefined }
  } finally {
    db.close()
  }
}

/** CLI auth.json：纯 JSON，取 accessToken（兼容 access_token 拼写） */
function readAuthJsonFile(path: string): string | null {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
  if (typeof parsed === 'string') return parsed.trim() || null
  if (parsed && typeof parsed === 'object') {
    const o = parsed as { accessToken?: unknown; access_token?: unknown }
    for (const k of [o.accessToken, o.access_token]) {
      if (typeof k === 'string' && k.trim()) return k.trim()
    }
  }
  return null
}

export interface CursorCredential {
  token: string
  source: 'vscdb' | 'auth.json'
  plan?: string
}

/**
 * 凭据三源级联（只读）：state.vscdb → CLI auth.json。
 * SQLite 只读失败（活跃 WAL 等）→ catch 后直接回落 auth.json，
 * 绝不重试、绝不碰 Cursor 的目录。手动粘贴不在这里，由 collect 兜底。
 */
export async function readCursorToken(): Promise<CursorCredential | null> {
  try {
    const hit = await readVscdb()
    if (hit && hit.token) return { token: hit.token, source: 'vscdb', plan: hit.plan }
  } catch {
    // WAL 锁定等只读失败 → 直接回落 auth.json
  }
  for (const p of cursorAuthJsonCandidates()) {
    try {
      if (!existsSync(p)) continue
      const token = readAuthJsonFile(p)
      if (token) return { token, source: 'auth.json' }
    } catch {
      // 继续试下一个候选路径
    }
  }
  return null
}

// ─── JWT 最小解码（只取 exp，不过期不断言签名） ───────────────────────────────

/** JWT payload 的 exp（秒）→ 毫秒；解不出返回 null（由调用方按「未配置」处理） */
function jwtExpMs(token: string): number | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as { exp?: unknown }
    const exp = typeof payload.exp === 'number' ? payload.exp : Number(payload.exp)
    if (!Number.isFinite(exp)) return null
    return exp * 1000
  } catch {
    return null
  }
}

// ─── 小工具 ───────────────────────────────────────────────────────────────────

function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** unix 毫秒（字符串或数字）→ ISO；非法时整个字段省略 */
function msToIso(v: unknown): string | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined
  const t = Number(v)
  if (!Number.isFinite(t) || t <= 0) return undefined
  const iso = new Date(t).toISOString()
  return iso
}

function previewOf(body: unknown): string {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return text.slice(0, 160)
}

// ─── 适配器主体 ─────────────────────────────────────────────────────────────

export const cursorAdapter: ProviderAdapter = {
  id: 'cursor',
  name: 'Cursor',
  kind: 'coding',
  builtin: true,

  async collect(ctx: CollectContext): Promise<ProviderSnapshot> {
    const me = identityOf(this)

    // ── 1. 凭据：本机文件优先，手动粘贴兜底（优先级最低） ──
    const found = await readCursorToken().catch(() => null)
    let token = found ? found.token : null
    let plan = found ? found.plan : undefined
    let via: 'vscdb' | 'auth.json' | 'manual' | null = found ? found.source : null
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
      return noDataSnap(
        me,
        `未找到 Cursor 凭据（请先在 Cursor 中登录；已查找 ${cursorStateDb()} 与 auth.json）`,
        ctx
      )
    }
    if (via === 'manual') {
      // 手动粘贴的 token 没有同库可读的套餐名，保持 plan 缺省
      plan = undefined
    }

    // ── 2. JWT 本地过期判定：过期直接返回，不发请求 ──
    const expMs = jwtExpMs(token)
    if (expMs === null && token.split('.').length < 2) {
      return noDataSnap(me, 'Cursor 凭据格式无法识别（请在 Cursor 中重新登录后重试）', ctx)
    }
    if (expMs !== null && expMs <= ctx.now.getTime()) {
      return errSnap(me, 'Cursor 登录已过期：请在 Cursor 中重新登录后重试', ctx)
    }

    // ── 3. 单 POST 取服务端真值 ──
    let res: { status: number; body: unknown }
    try {
      res = await readJson(
        ctx,
        CURSOR_USAGE_URL,
        {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1'
        },
        12000,
        { method: 'POST', body: '{}' }
      )
    } catch (e) {
      return errSnap(me, `请求失败: ${(e as Error).message}`, ctx)
    }
    if (res.status === 401 || res.status === 403) {
      return errSnap(me, `Cursor 会话已失效（HTTP ${res.status}）：请在 Cursor 中重新登录后重试`, ctx)
    }
    if (res.status === 429) {
      return errSnap(me, 'Cursor 接口限流（HTTP 429）：稍后将自动重试', ctx)
    }
    if (res.status !== 200) return errSnap(me, `HTTP ${res.status}`, ctx)

    // ── 4. 窗口组装（美元主窗口 + 按需预算；子池 v1 不展示） ──
    const b = (res.body ?? {}) as CursorUsageResponse
    const detail =
      via === 'vscdb'
        ? '本机配置自动读取（state.vscdb）'
        : via === 'auth.json'
          ? '本机配置自动读取（auth.json）'
          : '手动配置的凭据'
    if (b.isUnlimited === true) {
      return officialSnap(
        {
          ...me,
          plan,
          windows: [{ name: '本月套餐', used: 0, unit: 'usd', note: '当前套餐不限量' }],
          source: '官方接口',
          detail
        },
        ctx
      )
    }
    const pu = b.planUsage
    if (!pu || typeof pu !== 'object') {
      // 团队/企业形状与垃圾形状都缺 planUsage：同一句话同时满足
      // 「明确不支持团队口径」与「附带原文预览」，不从人话里正则数字
      return errSnap(me, `响应格式未识别：缺少 planUsage（团队/企业账号口径暂不支持）：${previewOf(res.body)}`, ctx)
    }
    const included = num(pu.includedSpend)
    const remaining = num(pu.remaining)
    const limit = num(pu.limit)
    if (included === undefined || remaining === undefined || limit === undefined) {
      return errSnap(me, `响应格式未识别：${previewOf(res.body)}`, ctx)
    }
    if (!(limit > 0)) {
      return errSnap(me, `响应格式未识别：limit 非正（${limit}），无法计算百分比`, ctx)
    }
    if (included + remaining !== limit) {
      return errSnap(me, `响应格式未识别：includedSpend(${included}) + remaining(${remaining}) ≠ limit(${limit})`, ctx)
    }
    const percent = Math.round((included / limit) * 100 * 10) / 10
    const resetAt = msToIso(b.billingCycleEnd)
    const main: ProviderWindow = {
      name: '本月套餐',
      used: included / 100,
      limit: limit / 100,
      unit: 'usd',
      percent,
      note: '官方接口'
    }
    if (resetAt) main.resetAt = resetAt
    const windows: ProviderWindow[] = [main]

    const slu = b.spendLimitUsage
    if (slu && typeof slu === 'object') {
      const team = slu.limitType === 'team'
      const odLimit = num(team ? slu.pooledLimit : slu.individualLimit)
      if (odLimit !== undefined && odLimit > 0) {
        const odUsed = num(team ? slu.pooledUsed : slu.individualUsed)
        const odRemain = num(team ? slu.pooledRemaining : slu.individualRemaining)
        const od = odUsed ?? (odRemain !== undefined ? odLimit - odRemain : undefined)
        if (od !== undefined) {
          windows.push({
            name: '按需预算',
            used: od / 100,
            limit: odLimit / 100,
            unit: 'usd',
            percent: Math.round((od / odLimit) * 100 * 10) / 10,
            note: '官方接口'
          })
        }
      }
    }
    return officialSnap({ ...me, plan, windows, source: '官方接口', detail }, ctx)
  }
}
