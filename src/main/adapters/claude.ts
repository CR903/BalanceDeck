import { join } from 'path'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import type { ProviderAdapter, CollectContext } from './types'
import { errSnap, identityOf, localSnap, noDataSnap } from './engine'
import { planWindows, planModelRows, parseLimits } from './plan-utils'
import type { PlanLimits, PlanPoint } from './plan-utils'
import type { ProviderModelRow, ProviderSnapshot } from '../../shared/types'

// ═══════════════════════════════════════════════════════════════════════════════
// Claude Code 同步策略（统一模型）
//
// 无官方用量 API。唯一数据源：~/.claude/projects/**/*.jsonl 会话转录。
// 口径：只取 message.usage 非空的 assistant 行；
//       按 messageId|requestId|timestamp 去重；
//       cost 优先行内 costUSD，否则按模型单价表估算；
//       仅 claude-* 模型计入限额窗口（router 第三方模型不消耗订阅额度）。
//
// 窗口模型（与 OpenCode Go 统一）：
//   window = { used: cost$, limit: 限额$, unit: 'usd', percent: used/limit*100 }
//   percent 由本地 cost/限额 推算（无官方 API，精度受限于单价估算）。
//
// 限额默认值（Max 5x 社区估算）：5h $35 / 周 $140 / 月 $420
// 可通过 extras limits:claude = "5h,周,月" 覆盖。
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_LIMITS: PlanLimits = { fiveHour: 35, weekly: 140, monthly: 420 }

// 各档单价（$/MTok）：input / output / cache read / cache write
const PRICE_TIERS = {
  opus: { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  sonnet: { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { in: 0.8, out: 4, cacheRead: 0.08, cacheWrite: 1 }
}

function priceTier(model: string): (typeof PRICE_TIERS)[keyof typeof PRICE_TIERS] {
  const m = model.toLowerCase()
  if (m.includes('opus')) return PRICE_TIERS.opus
  if (m.includes('haiku')) return PRICE_TIERS.haiku
  return PRICE_TIERS.sonnet
}

function estimateCost(model: string, u: Usage): number {
  const p = priceTier(model)
  const M = 1_000_000
  return (
    (u.input_tokens ?? 0) * p.in / M +
    (u.output_tokens ?? 0) * p.out / M +
    (u.cache_read_input_tokens ?? 0) * p.cacheRead / M +
    (u.cache_creation_input_tokens ?? 0) * p.cacheWrite / M
  )
}

interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

interface Line {
  type?: string
  timestamp?: string
  costUSD?: number
  requestId?: string
  isSidechain?: boolean
  message?: { id?: string; model?: string; usage?: Usage }
}

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

function listJsonl(dir: string, out: string[], depth = 0): void {
  if (depth > 4 || !existsSync(dir)) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) listJsonl(p, out, depth + 1)
    else if (e.endsWith('.jsonl')) out.push(p)
  }
}

interface Stats {
  pts: PlanPoint[] // 仅 claude-* 模型（口径与限额一致）
  allPts: PlanPoint[] // 全部模型（明细表用）
  byModel: Map<string, { cost: number; tokens: number }>
}

// mtime 缓存：60s 刷新避免重复解析全量转录
const cache = new Map<string, { mtimeMs: number; pts: PlanPoint[]; allPts: PlanPoint[] }>()

function parseFile(path: string): { pts: PlanPoint[]; allPts: PlanPoint[] } | null {
  let mtimeMs = 0
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return null
  }
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === mtimeMs) return hit
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch {
    return null
  }
  const pts: PlanPoint[] = []
  const allPts: PlanPoint[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    if (!line) continue
    let d: Line
    try {
      d = JSON.parse(line) as Line
    } catch {
      continue
    }
    if (d.type !== 'assistant' || !d.message?.usage) continue
    const u = d.message.usage
    const tokens =
      (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    if (tokens <= 0) continue
    const t = d.timestamp ? Date.parse(d.timestamp) : 0
    if (!Number.isFinite(t) || t <= 0) continue
    const key = `${d.message.id ?? ''}|${d.requestId ?? ''}|${d.timestamp ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    const model = d.message.model ?? ''
    const cost = d.costUSD ?? estimateCost(model, u)
    const p: PlanPoint = { t, cost, tokens, model }
    allPts.push(p)
    if (model.toLowerCase().startsWith('claude')) pts.push(p)
  }
  pts.sort((a, b) => a.t - b.t)
  allPts.sort((a, b) => a.t - b.t)
  cache.set(path, { mtimeMs, pts, allPts })
  return { pts, allPts }
}

function loadAll(): Stats | null {
  const files: string[] = []
  listJsonl(join(claudeConfigDir(), 'projects'), files)
  if (files.length === 0) return null
  const pts: PlanPoint[] = []
  const allPts: PlanPoint[] = []
  const byModel = new Map<string, { cost: number; tokens: number }>()
  for (const f of files) {
    const r = parseFile(f)
    if (!r) continue
    pts.push(...r.pts)
    allPts.push(...r.allPts)
  }
  allPts.sort((a, b) => a.t - b.t)
  for (const p of allPts) {
    if (!p.model) continue
    const cur = byModel.get(p.model) ?? { cost: 0, tokens: 0 }
    cur.cost += p.cost
    cur.tokens += p.tokens
    byModel.set(p.model, cur)
  }
  return { pts, allPts, byModel }
}

// ─── 适配器主体 ─────────────────────────────────────────────────────────────

export const claudeAdapter: ProviderAdapter = {
  id: 'claude',
  name: 'Claude Code',
  kind: 'coding',
  builtin: true,

  async collect(ctx: CollectContext): Promise<ProviderSnapshot> {
    const nowMs = ctx.now.getTime()
    const stats = loadAll()
    if (!stats || stats.allPts.length === 0) {
      return noDataSnap(identityOf(this), '未找到 ~/.claude 会话转录（未安装或从未使用）', ctx)
    }
    if (stats.pts.length === 0) {
      return errSnap(
        identityOf(this),
        '转录中无 claude-* 模型用量（可能全部经 router 走第三方模型），无法估算订阅额度',
        ctx
      )
    }
    const limits = parseLimits(await ctx.getExtra('limits:claude'), DEFAULT_LIMITS)
    const models: ProviderModelRow[] = planModelRows(stats)
    const windows = planWindows(stats.pts, nowMs, limits)
    // 为每个窗口附加 percent（本地 cost/限额 推算），归一化到一位小数
    for (const w of windows) {
      if (w.limit && w.limit > 0) w.percent = Math.round((w.used / w.limit) * 1000) / 10
    }
    const top = models.slice(0, 3)
    const detailBits = [
      '本机转录估算（限额为社区预设，可在设置调整）',
      `30天模型花费 Top: ${top.map((m) => `${m.model} $${m.cost >= 100 ? m.cost.toFixed(0) : m.cost.toFixed(2)}`).join(' · ')}`
    ]
    // 来路是 local：Claude 没有官方额度接口，percent 由本机转录 + 社区预设限额推算
    // （ADR-0002：必须是铸造的必填输入，不能靠「省略即 official」混过去）
    return localSnap(
      {
        ...identityOf(this),
        plan: 'Pro/Max（估算）',
        windows,
        models,
        source: '本机转录',
        detail: detailBits.join(' · ')
      },
      ctx
    )
  }
}
