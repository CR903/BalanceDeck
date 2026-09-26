// OpenCode Go 适配器行为验证（用真实 DB + 真实 API 响应）
// 用法：node scripts/verify-opencode.mjs
// 目的：确认 5h/周/月 三个窗口的 percent / used / tokens 计算与官方口径一致

import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DB = join(homedir(), '.local/share/opencode/opencode.db')
const LIMITS = { rolling: 12, weekly: 30, monthly: 60 }
const SPANS = { rolling: 5 * 3600_000, weekly: 7 * 86400_000, monthly: 30 * 86400_000 }
const NAMES = { rolling: '5 小时', weekly: '本周', monthly: '本月' }

// ── 1. 读取本机用量（兼容两代 schema）──────────────────────────────────────
const db = new DatabaseSync(DB, { readOnly: true })
const nowMs = Date.now()
const sinceMs = nowMs - 31 * 86400_000
const pts = []
const seen = new Set()

function parsePoint(d) {
  const providerID = d.providerID ?? d.model?.providerID
  if (providerID !== 'opencode-go') return null
  const cost = d.cost ?? 0
  if (cost <= 0) return null
  const t = d.time?.created ?? 0
  if (t <= 0) return null
  const tk = d.tokens
  const tokens = (tk?.input ?? 0) + (tk?.output ?? 0) + (tk?.reasoning ?? 0) + (tk?.cache?.read ?? 0) + (tk?.cache?.write ?? 0)
  return { t, cost, tokens, model: d.modelID ?? d.model?.id ?? '' }
}

const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name))
console.log('detected tables:', [...tables].filter((t) => t === 'message' || t === 'session_message').join(', '))
if (tables.has('session_message')) {
  const rows = db.prepare(`SELECT data FROM session_message WHERE type='assistant' AND time_created > ?`).all(sinceMs)
  for (const row of rows) {
    try {
      const p = parsePoint(JSON.parse(row.data))
      if (!p) continue
      const k = `${p.t}|${p.cost}`
      if (seen.has(k)) continue
      seen.add(k)
      pts.push(p)
    } catch { /* skip */ }
  }
}
if (tables.has('message')) {
  const rows = db.prepare(`SELECT data FROM message WHERE time_created > ?`).all(sinceMs)
  for (const row of rows) {
    try {
      const p = parsePoint(JSON.parse(row.data))
      if (!p) continue
      const k = `${p.t}|${p.cost}`
      if (seen.has(k)) continue
      seen.add(k)
      pts.push(p)
    } catch { /* skip */ }
  }
}
db.close()
pts.sort((a, b) => a.t - b.t)
console.log(`本机 opencode-go 记录（31 天）：${pts.length} 条`)

// ── 2. 官方 API 响应样本 ────────────────────────────────────────────────────
// ⚠️ **这是硬编码的历史样本，不是实时响应。** 2026-09-26 起这段注释原写「（实测）」，
//    但脚本从不发请求 —— 曾据此误判「官方 API 正常」。2026-09-26 实测该端点是
//    403 `EntitlementError: OpenCode Go subscription required.`（key 无 Go 订阅权益）。
//    要看线上真实状态请跑 `node scripts/probe-usage-api.mjs`。
//    本脚本只验证一件事：本机 db 统计与「给定一组官方口径」时，计算逻辑是否自洽。
const API_SAMPLE_IS_HARDCODED = true
const api = {
  rolling: { status: 'ok', percent: 0, resetsAt: '2026-09-13T10:41:56.965Z' },
  weekly: { status: 'ok', percent: 48, resetsAt: '2026-09-14T00:00:00.965Z' },
  monthly: { status: 'ok', percent: 66, resetsAt: '2026-09-20T03:35:20.965Z' }
}

function sumInRange(startMs, endMs) {
  let cost = 0
  let tokens = 0
  let n = 0
  for (const p of pts) {
    if (p.t >= startMs && p.t < endMs) {
      cost += p.cost
      tokens += p.tokens
      n++
    }
  }
  return { cost, tokens, n }
}

// ── 3. 构造窗口（与 src/main/adapters/opencode.ts officialWindows 一致）────
console.log('\n窗口           percent   used(官方口径)      limit   本机tokens    本机cost   本机条数   reset')
for (const kind of ['rolling', 'weekly', 'monthly']) {
  const w = api[kind]
  const limit = LIMITS[kind]
  const pct = Math.max(0, Math.min(100, w.percent ?? 0))
  const used = (pct / 100) * limit
  const resetMs = Date.parse(w.resetsAt)
  const isIdle = kind === 'rolling' && pct === 0 && Math.abs(resetMs - nowMs - SPANS.rolling) < 60_000
  const r = sumInRange(resetMs - SPANS[kind], nowMs)
  const fmtT = r.tokens > 0 ? `${(r.tokens / 1e6).toFixed(2)}M` : '—'
  const reset = isIdle ? '(无活跃窗口)' : new Date(resetMs).toISOString()
  console.log(
    `${NAMES[kind].padEnd(8)}  ${String(pct).padStart(4)}%   $${used.toFixed(2).padStart(6)} / $${limit}   ` +
      `      ${fmtT.padStart(7)}   $${r.cost.toFixed(4).padStart(8)}   ${String(r.n).padStart(6)}   ${reset}`
  )
}

// ── 4. 与旧行为对比（错误示范：用本机 cost 当 used）─────────────────────────
console.log('\n旧行为（错误）：used 用本机 cost，会导致 percent 与金额自相矛盾')
for (const kind of ['rolling', 'weekly', 'monthly']) {
  const w = api[kind]
  const resetMs = Date.parse(w.resetsAt)
  const r = sumInRange(resetMs - SPANS[kind], nowMs)
  const pct = w.percent
  console.log(`  ${NAMES[kind]}: 显示 ${pct}% 但金额 $${r.cost.toFixed(2)}/$50 —— 自相矛盾`)
}

// ── 5. 每模型明细（本机 31 天）─────────────────────────────────────────────
console.log('\n每模型明细（本机 31 天 Top 6）：')
const byModel = new Map()
for (const p of pts) {
  const cur = byModel.get(p.model) ?? { cost: 0, tokens: 0 }
  cur.cost += p.cost
  cur.tokens += p.tokens
  byModel.set(p.model, cur)
}
;[...byModel.entries()]
  .sort((a, b) => b[1].cost - a[1].cost)
  .slice(0, 6)
  .forEach(([m, v]) => console.log(`  ${m.padEnd(32)} $${v.cost.toFixed(4).padStart(8)}  ${(v.tokens / 1e6).toFixed(1).padStart(7)}M tok`))

console.log(
  `\n✓ 计算自洽性验证完成（percent/used 取自上方${API_SAMPLE_IS_HARDCODED ? '硬编码历史样本' : '实时响应'}，` +
    'tokens 为本机口径）。本脚本不访问网络。'
)
