import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import type { ProviderAdapter, CollectContext } from './types'
import { getJson, errSnap, noDataSnap, snap } from './types'
import type { ProviderWindow, ProviderSnapshot } from '../../shared/types'

// ═══════════════════════════════════════════════════════════════════════════════
// GitHub Copilot 同步策略（统一模型）
//
// 官方内部接口：
//   GET https://api.github.com/copilot_internal/v2/user
//   Authorization: token <ghu_…>、Editor-Version: vscode/1.96.2
//   凭据：~/.config/github-copilot/apps.json
//
// 响应 quota_snapshots.{premium_interactions,chat,completions}：
//   entitlement（本月总量）/ remaining（剩余）/ unlimited（无限）/
//   percent_remaining（百分比，若有）/ quota_reset_date（月重置日）
//
// 窗口模型（与 OpenCode Go 统一）：
//   { used: 已用次数, limit: entitlement, unit: 'token',
//     percent: percent_remaining ? (100 - percent_remaining) : used/limit*100,
//     resetAt: 重置日 }
//
// Copilot 按次计费（非 USD），用 'token' 统一渲染逻辑（进度条 / 数字格式一致）。
// 无限量套餐（unlimited=true）单独处理：used=0，无 percent，UI 显示"不限量"。
// ═══════════════════════════════════════════════════════════════════════════════

const USER_ENDPOINT = 'https://api.github.com/copilot_internal/v2/user'
const EDITOR_VERSION = 'vscode/1.96.2'

interface CopilotApps {
  [app: string]: { oauth_token?: string; user?: string; expires_on_timestamp?: string }
}

interface QuotaSnapshot {
  entitlement?: number
  remaining?: number
  unlimited?: boolean
  percent_remaining?: number
}

interface CopilotUser {
  copilot_plan?: string
  quota_reset_date?: string
  quota_snapshots?: Record<string, QuotaSnapshot>
}

export function readCopilotToken(): { token: string; user?: string } | null {
  const candidates: string[] = []
  if (process.env.XDG_CONFIG_HOME) candidates.push(join(process.env.XDG_CONFIG_HOME, 'github-copilot', 'apps.json'))
  candidates.push(join(homedir(), '.config', 'github-copilot', 'apps.json'))
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'github-copilot', 'apps.json'))
  }
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue
      const apps = JSON.parse(readFileSync(p, 'utf-8')) as CopilotApps
      for (const entry of Object.values(apps)) {
        if (entry.oauth_token?.startsWith('ghu_')) {
          return { token: entry.oauth_token, user: entry.user }
        }
      }
    } catch {
      // 继续尝试下一个路径
    }
  }
  return null
}

const SNAPSHOT_NAMES: [string, string][] = [
  ['premium_interactions', '高级请求'],
  ['chat', 'Chat'],
  ['completions', '补全']
]

function fmtDateReset(dateStr: string | undefined, now: number): string | undefined {
  if (!dateStr) return undefined
  const t = Date.parse(dateStr)
  if (!Number.isFinite(t)) return undefined
  return new Date(t + 24 * 3600_000 - 1).toISOString() // 重置日当天结束
}

// ─── 适配器主体 ─────────────────────────────────────────────────────────────

export const copilotAdapter: ProviderAdapter = {
  id: 'copilot',
  name: 'GitHub Copilot',
  kind: 'coding',
  builtin: true,

  async collect(ctx: CollectContext): Promise<ProviderSnapshot> {
    const cred = readCopilotToken()
    if (!cred) {
      return noDataSnap(
        { id: this.id, name: this.name },
        '未找到 Copilot 凭据（在 VS Code 登录 Copilot 后自动发现）',
        ctx
      )
    }
    try {
      const { status, body } = await getJson(
        USER_ENDPOINT,
        {
          Authorization: `token ${cred.token}`,
          'Editor-Version': EDITOR_VERSION,
          'Editor-Plugin-Version': 'copilot-chat/0.28.0',
          'User-Agent': 'GitHubCopilotChat/0.28.0',
          Accept: 'application/json'
        },
        12000
      )
      if (status === 401 || status === 403) {
        return errSnap(
          { id: this.id, name: this.name },
          '凭据失效（HTTP ' + status + '）：在 VS Code 中重新登录 Copilot 即可',
          ctx
        )
      }
      if (status !== 200) return errSnap({ id: this.id, name: this.name }, `HTTP ${status}`, ctx)
      const u = body as CopilotUser
      const snapshots = u.quota_snapshots
      if (!snapshots) {
        const preview = typeof body === 'string' ? body : JSON.stringify(body).slice(0, 160)
        return errSnap({ id: this.id, name: this.name }, `响应格式未识别：${preview}`, ctx)
      }
      const windows: ProviderWindow[] = []
      const resetAt = fmtDateReset(u.quota_reset_date, ctx.now.getTime())
      for (const [key, name] of SNAPSHOT_NAMES) {
        const s = snapshots[key]
        if (!s || s.unlimited) continue
        const entitlement = s.entitlement ?? 0
        const remaining = s.remaining ?? 0
        if (entitlement <= 0) continue
        const used = Math.max(0, entitlement - remaining)
        // percent：优先用 API 的 percent_remaining 推算，否则用 used/limit；归一化到一位小数
        const apiPct = typeof s.percent_remaining === 'number' ? 100 - s.percent_remaining : undefined
        const rawPct = apiPct ?? (entitlement > 0 ? (used / entitlement) * 100 : undefined)
        windows.push({
          name,
          used,
          limit: entitlement,
          unit: 'token',
          percent: rawPct == null ? undefined : Math.round(rawPct * 10) / 10,
          resetAt,
          note: '官方接口'
        })
      }
      if (windows.length === 0) {
        windows.push({ name: '配额', used: 0, unit: 'token', note: '当前套餐不限量或无配额数据' })
      }
      return snap(
        {
          id: this.id,
          name: this.name,
          plan: u.copilot_plan,
          windows,
          source: '官方接口',
          detail: cred.user ? `账号 ${cred.user}` : undefined
        },
        ctx
      )
    } catch (e) {
      return errSnap({ id: this.id, name: this.name }, `请求失败: ${(e as Error).message}`, ctx)
    }
  }
}
