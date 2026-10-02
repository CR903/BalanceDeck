import { join } from 'path'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import type { ProviderAdapter, CollectContext } from './types'
import { errSnap, identityOf, noDataSnap, readJson, snap } from './engine'
import type { DataQuality, ProviderWindow, ProviderSnapshot } from '../../shared/types'

// ═══════════════════════════════════════════════════════════════════════════════
// Codex 同步策略（统一模型）
//
// 数据源（按优先级）：
//   ① wham/usage 主动查询（GET https://chatgpt.com/backend-api/wham/usage）
//      → 提供：percent (used_percent) + resetAt (reset_at unix 秒 → ISO)
//      凭据读 Codex CLI 自己的登录文件（只读不写）：$CODEX_HOME/auth.json →
//      CODEX_ACCESS_TOKEN 环境变量 → 设置页手动粘贴（优先级最低）
//      窗口名按服务端下发的 limit_window_seconds 映射（18000=5小时，604800=本周）
//   ② 服务端 rate_limits（随 rollout-*.jsonl 事件返回，与 ① 同一份服务端真值）
//      → 提供：percent (used_percent) + resetAt (resets_in_seconds → ISO)
//      primary = 5小时窗口，secondary = 本周窗口
//   ③ 本机 token 增量统计（兜底）
//      → 提供：token 数量（无官方限额，unit='token'）
//
// 服务端真值优先：① 成功直接返回，不再碰 jsonl；① 失败（401 除外）或无凭据时
// 走 ②③（今天的行为，一字不改）。唯一的例外是 401：凭据已死是确定性信号，
// 回退只会拿旧快照冒充 live 真值，必须直接报错让用户去跑 `codex login`。
//
// 窗口模型（与 OpenCode Go 统一）：
//   服务端：{ used: token估算, limit: 不限, unit: 'token', percent: used_percent }
//   本地：  { used: token数, limit: 不限, unit: 'token' }
// ═══════════════════════════════════════════════════════════════════════════════

const ENDPOINT_HINT = '服务端主动查询不可用（未登录 Codex CLI 或网络异常）'

const WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage'

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

// ─── wham/usage 主动查询（与 jsonl rate_limits 同一份服务端真值） ─────────────
//
// 夹具来源：CodexBar issue #2900 的 EDU 账号实测样本（检索 2026-10-01），
// 本机无 ChatGPT Plus/Pro 凭据可抓 —— 二手转录，不得标「实测」。

/** Codex CLI 的登录凭据文件（认 CODEX_HOME，与 codexHome() 同根） */
export function codexAuthFile(): string {
  return join(codexHome(), 'auth.json')
}

export interface CodexCreds {
  token: string
  accountId: string | null
  source: 'file' | 'env' | 'manual'
}

/** auth.json 里 tokens 的宽容读取：坏 JSON / 缺字段 → null（由调用方降级下一源） */
function readAuthFileCreds(): Omit<CodexCreds, 'source'> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(codexAuthFile(), 'utf-8'))
    const tokens = (parsed as { tokens?: unknown })?.tokens as { access_token?: unknown; account_id?: unknown } | undefined
    const token = typeof tokens?.access_token === 'string' && tokens.access_token.trim()
      ? tokens.access_token.trim()
      : null
    if (!token) return null
    const accountId = typeof tokens?.account_id === 'string' && tokens.account_id.trim()
      ? tokens.account_id.trim()
      : null
    return { token, accountId }
  } catch {
    return null
  }
}

/**
 * 凭据三源级联（只读，不写回 auth.json —— 那是 Codex CLI 的文件）：
 * $CODEX_HOME/auth.json → CODEX_ACCESS_TOKEN 环境变量 → 设置页手动粘贴（最低）。
 * account_id 缺失时照常返回（单 workspace 降级，请求时省略该头）。
 */
export async function readCodexCreds(
  getKey: (id: string) => Promise<string | null>,
  getExtra: (key: string) => Promise<string | null>
): Promise<CodexCreds | null> {
  const file = readAuthFileCreds()
  if (file) return { ...file, source: 'file' }
  const env = process.env.CODEX_ACCESS_TOKEN
  if (env && env.trim()) return { token: env.trim(), accountId: null, source: 'env' }
  let manual: string | null = null
  let accountId: string | null = null
  try {
    manual = await getKey('codex')
  } catch {
    manual = null
  }
  try {
    const extra = await getExtra('accountId:codex')
    if (extra && extra.trim()) accountId = extra.trim()
  } catch {
    // 无 accountId 照发（单 workspace 降级），不拦主路
  }
  if (manual && manual.trim()) return { token: manual.trim(), accountId, source: 'manual' }
  return null
}

interface WhamWindow {
  used_percent?: unknown
  limit_window_seconds?: unknown
  reset_at?: unknown
}

/** 已知秒数保持与 jsonl 路径一字同名（同一口径就该同名）；未知秒数算术推导 */
function whamWindowName(limitSecs: number): string {
  if (limitSecs === 18000) return '5 小时'
  if (limitSecs === 604800) return '本周'
  if (Number.isInteger(limitSecs / 3600)) return `${limitSecs / 3600} 小时`
  if (Number.isInteger(limitSecs / 86400)) return `${limitSecs / 86400} 天`
  return `${limitSecs} 秒窗口`
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * wham 响应 → 服务端窗口（与 buildServerWindows 同形）。
 * used_percent 缺失的窗口直接跳过（"花了却显示 0%" 是撒谎）；
 * 两个窗口都不可识别 → null（调用方回退 jsonl，不是报错）。
 * used 用本机 sessions 同窗口求和回填（无 sessions 时为 0：有额度无本地量）。
 */
function buildWhamWindows(body: unknown, deltas: { t: number; delta: number }[], nowMs: number): ProviderWindow[] | null {
  const rateLimit = (body as { rate_limit?: unknown })?.rate_limit
  if (!rateLimit || typeof rateLimit !== 'object') return null
  const rl = rateLimit as { primary_window?: WhamWindow | null; secondary_window?: WhamWindow | null }
  const windows: ProviderWindow[] = []
  const positional: Array<[WhamWindow | null | undefined, string]> = [
    [rl.primary_window, '5 小时'],
    [rl.secondary_window, '本周']
  ]
  for (const [w, fallbackName] of positional) {
    if (!w || typeof w !== 'object') continue
    const percent = num(w.used_percent)
    if (percent === undefined) continue
    const secs = num(w.limit_window_seconds)
    const resetAt = num(w.reset_at)
    const win: ProviderWindow = {
      name: secs !== undefined ? whamWindowName(secs) : fallbackName,
      used: 0,
      unit: 'token',
      percent,
      note: '服务端真值'
    }
    if (resetAt !== undefined) {
      win.resetAt = new Date(resetAt * 1000).toISOString()
      if (secs !== undefined) win.used = sumSince(deltas, resetAt * 1000 - secs * 1000)
    } else if (secs !== undefined) {
      // 有窗口长度但无绝对重置点：退回"当前往前推一窗"估算起点
      win.used = sumSince(deltas, nowMs - secs * 1000)
    }
    windows.push(win)
  }
  return windows.length > 0 ? windows : null
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
    const me = identityOf(this)

    // ── 0. 本机 sessions 先读出来：wham 成功要拿它回填 used，失败要拿它回退 ──
    //     （下面两条路共用同一份读取结果；jsonl 的解析语义与今天逐字相同）
    const files: string[] = []
    listRollouts(join(codexHome(), 'sessions'), files)
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

    // ── 1. wham/usage 主动查询（有凭据才试；出网只走 readJson，可注入） ──
    const creds = await readCodexCreds((id) => ctx.getKey(id), (k) => ctx.getExtra(k)).catch(() => null)
    if (creds) {
      let res: { status: number; body: unknown } | null = null
      try {
        res = await readJson(ctx, WHAM_URL, {
          Authorization: `Bearer ${creds.token}`,
          ...(creds.accountId ? { 'ChatGPT-Account-Id': creds.accountId } : {}),
          Accept: 'application/json'
        })
      } catch {
        res = null // 断网等抛错 → 静默回退 jsonl（今天的行为）
      }
      if (res && res.status === 401) {
        // 凭据已死是确定性信号：回退只会拿旧快照冒充 live 真值，必须可见
        return errSnap(me, 'Codex 凭据已失效（HTTP 401）：请运行 `codex login` 重新登录', ctx)
      }
      if (res && res.status === 200) {
        const whamWindows = buildWhamWindows(res.body, deltas, nowMs)
        if (whamWindows) {
          return snap(
            'official',
            {
              ...me,
              plan: 'ChatGPT 订阅',
              windows: whamWindows,
              source: '服务端真值'
            },
            ctx
          )
        }
        // 形状认不出 → 静默回退 jsonl（端点改版不炸掉基本盘）
      }
      // 403 / 429 / 404 / 其他状态 → 静默回退下面的 jsonl 逻辑
    }

    // ── 2. 现有 jsonl 逻辑（无凭据，或 wham 不可用 —— 今天什么样还什么样） ──
    if (files.length === 0) {
      return noDataSnap(me, '未找到 ~/.codex/sessions 会话记录，且服务端额度不可查（未登录 Codex CLI 或网络异常）', ctx)
    }

    let windows: ProviderWindow[]
    let source: string
    /** 来路（ADR-0002）：服务端真值 = official；本机 token 统计 = local */
    let quality: DataQuality

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
      quality = 'official'
    } else if (deltas.length > 0) {
      // 本地 token 估算兜底
      windows = buildLocalWindows(deltas, nowMs)
      source = '本机估算'
      quality = 'local'
    } else {
      return errSnap(identityOf(this), '会话记录中无用量数据；' + ENDPOINT_HINT, ctx)
    }

    return snap(
      quality,
      {
        ...identityOf(this),
        plan: rl?.primary ? 'ChatGPT 订阅' : undefined,
        windows,
        source,
        detail: source === '本机估算' ? ENDPOINT_HINT + '；当前为本机 token 统计' : undefined
      },
      ctx
    )
  }
}
