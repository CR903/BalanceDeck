import { join } from 'path'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import type { ProviderAdapter, CollectContext } from './types'
import { errSnap, noDataSnap, snap } from './types'
import type { ProviderWindow, ProviderSnapshot } from '../../shared/types'

// ═══════════════════════════════════════════════════════════════════════════════
// Codex 同步策略（统一模型）
//
// 数据源（按优先级）：
//   ① 服务端 rate_limits（随 rollout-*.jsonl 事件返回）
//      → 提供：percent (used_percent) + resetAt (resets_in_seconds → ISO)
//      primary = 5小时窗口，secondary = 本周窗口
//   ② 本机 token 增量统计（兜底）
//      → 提供：token 数量（无官方限额，unit='token'）
//
// 服务端真值优先：有 rate_limits.primary → 用它做 percent 窗口（与官方 /status 一致）；
// 全部回退到本地 token 统计时，percent 由 token 用量推算（限额未知，精度受限）。
//
// 窗口模型（与 OpenCode Go 统一）：
//   服务端：{ used: token估算, limit: 不限, unit: 'token', percent: used_percent }
//   本地：  { used: token数, limit: 不限, unit: 'token' }
// ═══════════════════════════════════════════════════════════════════════════════

const ENDPOINT_HINT = '服务端限额仅随请求返回，暂无法主动查询'

interface RolloutLine {
  type?: string
  timestamp?: number | string
  payload?: {
    type?: string
    info?: { total_token_usage?: { total_tokens?: number } }
    rate_limits?: {
      primary?: { used_percent?: number; resets_in_seconds?: number } | null
      secondary?: { used_percent?: number; resets_in_seconds?: number } | null
    }
  }
}

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

function listRollouts(dir: string, out: string[], depth = 0): void {
  if (depth > 5 || !existsSync(dir)) return
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
    if (st.isDirectory()) listRollouts(p, out, depth + 1)
    else if (e.startsWith('rollout-') && e.endsWith('.jsonl')) out.push(p)
  }
}

function lineTime(v: number | string | undefined): number {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : 0
  }
  return 0
}

interface FileData {
  deltas: { t: number; delta: number }[]
  rateLimits: {
    t: number
    primary?: { used_percent?: number; resets_in_seconds?: number } | null
    secondary?: { used_percent?: number; resets_in_seconds?: number } | null
  } | null
}

const cache = new Map<string, { mtimeMs: number; data: FileData }>()

function parseFile(path: string): FileData | null {
  let mtimeMs = 0
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return null
  }
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === mtimeMs) return hit.data
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch {
    return null
  }
  const deltas: { t: number; delta: number }[] = []
  let lastTokens: number | null = null
  let rateLimits: FileData['rateLimits'] = null
  for (const line of text.split('\n')) {
    if (!line) continue
    let d: RolloutLine
    try {
      d = JSON.parse(line) as RolloutLine
    } catch {
      continue
    }
    if (d.type !== 'event_msg' || d.payload?.type !== 'token_count') continue
    const t = lineTime(d.timestamp)
    const total = d.payload.info?.total_token_usage?.total_tokens
    if (typeof total === 'number' && t > 0) {
      if (lastTokens === null) {
        deltas.push({ t, delta: total })
      } else if (total > lastTokens) {
        deltas.push({ t, delta: total - lastTokens })
      }
      lastTokens = total
    }
    const rl = d.payload.rate_limits
    if (rl && (rl.primary || rl.secondary) && (!rateLimits || t >= rateLimits.t)) {
      rateLimits = { t, primary: rl.primary, secondary: rl.secondary }
    }
  }
  const data: FileData = { deltas, rateLimits }
  cache.set(path, { mtimeMs, data })
  return data
}

function sumSince(deltas: { t: number; delta: number }[], sinceMs: number): number {
  let s = 0
  for (const d of deltas) if (d.t >= sinceMs) s += d.delta
  return s
}

function buildLocalWindows(deltas: { t: number; delta: number }[], nowMs: number): ProviderWindow[] {
  let blkStart = deltas[0].t
  for (const d of deltas) if (d.t >= blkStart + 5 * 3600_000) blkStart = d.t
  const hasBlock = nowMs < blkStart + 5 * 3600_000
  return [
    {
      name: '5 小时',
      used: hasBlock ? sumSince(deltas, blkStart) : 0,
      unit: 'token',
      note: hasBlock ? '本机估算' : '当前无活跃窗口'
    },
    { name: '本周（7天）', used: sumSince(deltas, nowMs - 7 * 86400_000), unit: 'token', note: '本机估算' },
    { name: '本月', used: sumSince(deltas, nowMs - 30 * 86400_000), unit: 'token', note: '本机估算' }
  ]
}

function buildServerWindows(rl: FileData['rateLimits'], nowMs: number): ProviderWindow[] {
  const windows: ProviderWindow[] = []
  if (rl?.primary && typeof rl.primary.used_percent === 'number') {
    windows.push({
      name: '5 小时',
      used: 0,
      unit: 'token',
      percent: rl.primary.used_percent,
      resetAt: rl.primary.resets_in_seconds
        ? new Date(nowMs + rl.primary.resets_in_seconds * 1000).toISOString()
        : undefined,
      note: '服务端真值'
    })
  }
  if (rl?.secondary && typeof rl.secondary.used_percent === 'number') {
    windows.push({
      name: '本周',
      used: 0,
      unit: 'token',
      percent: rl.secondary.used_percent,
      resetAt: rl.secondary.resets_in_seconds
        ? new Date(nowMs + rl.secondary.resets_in_seconds * 1000).toISOString()
        : undefined,
      note: '服务端真值'
    })
  }
  return windows
}

// ─── 适配器主体 ─────────────────────────────────────────────────────────────

export const codexAdapter: ProviderAdapter = {
  id: 'codex',
  name: 'Codex',
  kind: 'coding',
  builtin: true,

  async collect(ctx: CollectContext): Promise<ProviderSnapshot> {
    const nowMs = ctx.now.getTime()
    const files: string[] = []
    listRollouts(join(codexHome(), 'sessions'), files)
    if (files.length === 0) {
      return noDataSnap({ id: this.id, name: this.name }, '未找到 ~/.codex/sessions 会话记录（未安装或从未使用）', ctx)
    }
    // 只解析最近修改的 5 个会话
    const recent = files
      .map((f) => {
        try {
          return { f, m: statSync(f).mtimeMs }
        } catch {
          return null
        }
      })
      .filter((x): x is { f: string; m: number } => x !== null)
      .sort((a, b) => b.m - a.m)
      .slice(0, 5)
    const deltas: { t: number; delta: number }[] = []
    let rl: FileData['rateLimits'] = null
    for (const { f } of recent) {
      const parsed = parseFile(f)
      if (!parsed) continue
      deltas.push(...parsed.deltas)
      if (parsed.rateLimits && (!rl || parsed.rateLimits.t > rl.t)) rl = parsed.rateLimits
    }
    deltas.sort((a, b) => a.t - b.t)

    let windows: ProviderWindow[]
    let source: string

    if (rl?.primary && typeof rl.primary.used_percent === 'number') {
      // 服务端真值路径：percent 作为精度层，token 用量从本地补充
      windows = buildServerWindows(rl, nowMs)
      // 用本地 token delta 填充服务端窗口的 used（非必须，但显示更丰富）
      const fiveH = windows.find((w) => w.name === '5 小时')
      if (fiveH && fiveH.resetAt) {
        const resetMs = new Date(fiveH.resetAt).getTime()
        const blkStart = resetMs - 5 * 3600_000
        fiveH.used = sumSince(deltas, blkStart)
      }
      const week = windows.find((w) => w.name === '本周')
      if (week) week.used = sumSince(deltas, nowMs - 7 * 86400_000)
      source = '服务端真值'
    } else if (deltas.length > 0) {
      // 本地 token 估算兜底
      windows = buildLocalWindows(deltas, nowMs)
      source = '本机估算'
    } else {
      return errSnap({ id: this.id, name: this.name }, '会话记录中无用量数据；' + ENDPOINT_HINT, ctx)
    }

    return snap(
      {
        id: this.id,
        name: this.name,
        plan: rl?.primary ? 'ChatGPT 订阅' : undefined,
        windows,
        source,
        detail: source === '本机估算' ? ENDPOINT_HINT + '；当前为本机 token 统计' : undefined
      },
      ctx
    )
  }
}
