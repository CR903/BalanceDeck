import type { ProviderKind, ProviderWindow, Unit } from '../../shared/types'
import { balanceWindow, fmtMoney } from './types'

// ═══════════════════════════════════════════════════════════════════════════════
// 协议声明表（ADR-0001：协议是唯一决定「查哪个端点、怎么解析」的东西）
//
// 一条声明 = 目录元数据（label/kind/defaultBaseUrl/hint，设置页「添加提供方」用）
//          + 端点事实（probe：路径或完整 URL）
//          + 读取函数（read：响应 → 窗口，纯函数，null 表示不可识别）
//          + 可选提示覆盖（authHint / unrecognizedHint / envKey）
//
// 内置预设实例与自定义实例解析到**同一张表**，因此同一家供应商只有一份实现。
// 声明表达不了的协议（请求签名、浏览器会话、本机文件、备用端点）仍走代码适配器，
// 见 ./index 的 CODE_ADAPTERS 与 ADR-0001 的 Considered Options。
//
// 文案纪律：这里的措辞逐字来自原来的内置适配器（ADR-0001「以内置为准」），
// 因为那些提示是用户排障时唯一的线索。改文案等于改产品行为，黄金样本会拦下来。
// ═══════════════════════════════════════════════════════════════════════════════

export interface ProtocolDecl {
  /** 协议 id（= 实例的 protocol 字段，也是 BLTIN_PRESETS 里写的那个） */
  id: string
  label: string
  kind: ProviderKind
  defaultBaseUrl: string
  /** 设置页「添加自定义提供方」时展示的说明 */
  hint: string
  /** 内置预设对应的环境变量名；用于「未配置 API Key」提示点名（自定义实例不适用） */
  envKey?: string
  /** 探测请求：给出相对路径（拼在 base 之后）或完整 URL（generic 用） */
  probe: (baseUrl: string) => { path: string } | { url: string }
  /** 读取响应 → 窗口；null = 响应不可识别 */
  read: (body: unknown) => ProviderWindow[] | null
  /** 401 的提示覆盖；返回 null 走默认。deepseek/kimi 用它区分官方域名与中转平台 */
  authHint?: (baseUrl: string) => string | null
  /** 「响应格式未识别」的完整文案覆盖；缺省为「响应格式未识别：<响应预览>」 */
  unrecognizedHint?: string
}

// ─── 宽容取值：字段名多变的中转平台靠它兜住 ─────────────────────────────────

const GENERIC_BALANCE_KEYS = [
  'total_balance',
  'totalBalance',
  'available_balance',
  'availableBalance',
  'AvailableAmount',
  'AvailableBalance',
  'balance',
  'Balance',
  'total_available',
  'credit',
  'credits',
  'remaining',
  'money'
]
const CURRENCY_KEYS = ['currency', 'Currency', 'unit', 'Unit']

/**
 * 递归查找候选键里的数值。
 * maxDepth 是**层数上限**（不是起始深度）：深度 > maxDepth 即停。
 * 各协议的上限沿用原实现 —— 内置 zhipu/siliconflow 是 3（4 层），
 * custom.ts 系的通用解析是 4（5 层）。同一个响应必须读出同一个数，别随手改。
 */
function findNumber(obj: unknown, keys: string[], maxDepth = 4, depth = 0): number | null {
  if (depth > maxDepth || obj === null || typeof obj !== 'object') return null
  const rec = obj as Record<string, unknown>
  for (const k of keys) {
    const v = rec[k]
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
    if (Number.isFinite(n)) return n
  }
  for (const v of Object.values(rec)) {
    const found = findNumber(v, keys, maxDepth, depth + 1)
    if (found !== null) return found
  }
  return null
}

function findString(obj: unknown, keys: string[], maxDepth = 4, depth = 0): string | null {
  if (depth > maxDepth || obj === null || typeof obj !== 'object') return null
  const rec = obj as Record<string, unknown>
  for (const k of keys) {
    const v = rec[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  for (const v of Object.values(rec)) {
    const found = findString(v, keys, maxDepth, depth + 1)
    if (found !== null) return found
  }
  return null
}

function moneyUnit(currency: string | null, fallback: Unit = 'cny'): Unit {
  const c = (currency ?? '').toUpperCase()
  if (c === 'USD' || c === '$') return 'usd'
  if (c === 'CNY' || c === 'RMB' || c === '¥') return 'cny'
  return fallback
}

// ═══════════════════════════════════════════════════════════════════════════════
// 声明
// ═══════════════════════════════════════════════════════════════════════════════

const DEEPSEEK = 'https://api.deepseek.com'
const MOONSHOT = 'https://api.moonshot.cn'

export const PROTOCOLS: Record<string, ProtocolDecl> = {
  // ── DeepSeek：余额 + 赠送余额说明 + 账户不可用警告（官方域名才给平台指引）──
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek 兼容',
    kind: 'balance',
    defaultBaseUrl: DEEPSEEK,
    hint: 'GET /user/balance → balance_infos[0].total_balance（多数中转平台兼容）',
    envKey: 'DEEPSEEK_API_KEY',
    probe: () => ({ path: '/user/balance' }),
    read: (body) => {
      const b = body as {
        is_available?: boolean
        balance_infos?: { currency?: string; total_balance?: string; granted_balance?: string }[]
      }
      const info = b?.balance_infos?.[0]
      const total = Number(info?.total_balance)
      if (!Number.isFinite(total)) return null
      const unit = info?.currency === 'USD' ? 'usd' : 'cny'
      const noteParts: string[] = []
      if (info?.granted_balance && Number(info.granted_balance) > 0) {
        noteParts.push(`赠送余额 ${fmtMoney(Number(info.granted_balance), unit)}`)
      }
      if (b.is_available === false) noteParts.push('账户不可用')
      return [balanceWindow(total, unit, noteParts.join(' · ') || undefined)]
    },
    authHint: (baseUrl) =>
      baseUrl.includes('api.deepseek.com')
        ? '此 key 在官方 api.deepseek.com 无效：请到 platform.deepseek.com 重新生成完整 key（sk- 开头）；若使用中转/聚合平台，请在设置的 Base URL 中填写平台地址'
        : '鉴权失败（401）：请核对该平台的 Key 与 Base URL',
    unrecognizedHint: '响应格式未识别'
  },

  // ── Moonshot / Kimi：可用余额 + 代金券说明 ──
  moonshot: {
    id: 'moonshot',
    label: 'Moonshot / Kimi 兼容',
    kind: 'balance',
    defaultBaseUrl: MOONSHOT,
    hint: 'GET /v1/users/me/balance → data.available_balance',
    envKey: 'MOONSHOT_API_KEY',
    probe: () => ({ path: '/v1/users/me/balance' }),
    read: (body) => {
      const b = body as { data?: { available_balance?: string | number; voucher_balance?: string | number } }
      const avail = Number(b?.data?.available_balance)
      if (!Number.isFinite(avail)) return null
      const voucher = Number(b?.data?.voucher_balance ?? 0)
      const note = voucher > 0 ? `代金券 ¥${voucher.toFixed(2)}` : undefined
      return [balanceWindow(avail, 'cny', note)]
    },
    authHint: (baseUrl) =>
      baseUrl.includes('api.moonshot.cn')
        ? '鉴权失败（401）：此 key 在官方 api.moonshot.cn 无效；若使用中转平台，请在设置的 Base URL 中填写平台地址'
        : '鉴权失败（401）：请核对该平台的 Key 与 Base URL',
    unrecognizedHint: '响应格式未识别'
  },

  // ── 智谱 GLM：端点为社区验证版本，字段名随版本变化，用内置的键序与深度 ──
  zhipu: {
    id: 'zhipu',
    label: '智谱 GLM 兼容',
    kind: 'balance',
    defaultBaseUrl: 'https://open.bigmodel.cn',
    hint: 'GET /api/paas/v4/users/me/balance（宽容解析余额字段）',
    envKey: 'ZHIPUAI_API_KEY',
    probe: () => ({ path: '/api/paas/v4/users/me/balance' }),
    read: (body) => {
      // 键序与递归深度沿用内置实现：同一个响应必须读出同一个数（黄金样本 E5 盯着这点）
      const n = findNumber(body, ['balance', 'total_balance', 'available_balance', 'totalBalance', 'availableBalance'], 3)
      if (n === null) return null
      return [balanceWindow(n, 'cny', '端点为社区验证版本')]
    }
  },

  // ── 硅基流动（国内）：优先 totalBalance ──
  siliconflow: {
    id: 'siliconflow',
    label: '硅基流动（国内）',
    kind: 'balance',
    defaultBaseUrl: 'https://api.siliconflow.cn',
    hint: 'GET /v1/user/info → data.totalBalance（CNY）',
    envKey: 'SILICONFLOW_API_KEY',
    probe: () => ({ path: '/v1/user/info' }),
    read: (body) => {
      const n = findNumber(body, ['totalBalance', 'balance', 'chargeBalance', 'available_balance', 'total_balance'], 3)
      if (n === null) return null
      return [balanceWindow(n, 'cny', '官方接口')]
    }
  },

  // ── 硅基流动（国际）：同一端点，缺 currency 时按 USD 回落 ──
  'siliconflow-intl': {
    id: 'siliconflow-intl',
    label: 'SiliconFlow（国际）',
    kind: 'balance',
    defaultBaseUrl: 'https://api.siliconflow.com',
    hint: 'GET /v1/user/info → data.totalBalance（USD）',
    probe: () => ({ path: '/v1/user/info' }),
    read: (body) => {
      const n = findNumber(body, GENERIC_BALANCE_KEYS)
      if (n === null) return null
      return [balanceWindow(n, moneyUnit(findString(body, CURRENCY_KEYS), 'usd'), '官方接口')]
    }
  },

  // ── OpenRouter：额度减已用 ──
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'balance',
    defaultBaseUrl: 'https://openrouter.ai',
    hint: 'GET /api/v1/credits → total_credits - total_usage（USD）',
    probe: () => ({ path: '/api/v1/credits' }),
    read: (body) => {
      const b = body as { data?: { total_credits?: number; total_usage?: number } }
      const credits = Number(b?.data?.total_credits)
      const used = Number(b?.data?.total_usage ?? 0)
      if (!Number.isFinite(credits)) return null
      return [balanceWindow(credits - used, 'usd', '官方接口')]
    }
  },

  // ── OpenAI 计费：返回的是额度而非余额（used 恒为 0）──
  'openai-billing': {
    id: 'openai-billing',
    label: 'OpenAI 计费',
    kind: 'balance',
    defaultBaseUrl: 'https://api.openai.com',
    hint: 'GET /v1/dashboard/billing/subscription + /usage（需老式 sk- key）',
    probe: () => ({ path: '/v1/dashboard/billing/subscription' }),
    read: (body) => {
      const b = body as { hard_limit_usd?: number; system_hard_limit_usd?: number }
      const limit = b?.hard_limit_usd ?? b?.system_hard_limit_usd
      if (!Number.isFinite(limit)) return null
      return [{ name: '账户额度', used: 0, limit: limit as number, unit: 'usd', note: '官方计费接口（不含已用量）' }]
    }
  },

  // ── 通用 JSON：用户填完整 URL，宽容找余额/用量字段 ──
  generic: {
    id: 'generic',
    label: '通用 JSON（宽容解析）',
    kind: 'balance',
    defaultBaseUrl: '',
    hint: 'GET 你填写的完整 URL（Bearer key），自动在响应里寻找余额/用量字段',
    probe: (baseUrl) => ({ url: baseUrl.trim() }),
    read: (body) => {
      const n = findNumber(body, GENERIC_BALANCE_KEYS)
      if (n === null) return null
      return [balanceWindow(n, moneyUnit(findString(body, CURRENCY_KEYS), 'cny'), '自定义接口')]
    }
  }
}

/**
 * 可添加为自定义实例的协议目录（设置页「添加自定义提供方」）。
 *
 * 8 条声明式协议 + MiniMax：后者带旧平台备用端点（`/v1/query_balance`）与 `base_resp`
 * 语义，声明表达不了，因此留作代码适配器（见 ./index 的 CODE_ADAPTERS）。
 * 目录元数据只此一份，providers.listCatalog 直接消费它。
 */
export interface CatalogProtocol {
  id: string
  label: string
  kind: ProviderKind
  defaultBaseUrl: string
  hint: string
}

export const SELECTABLE_PROTOCOLS: CatalogProtocol[] = [
  PROTOCOLS.deepseek,
  PROTOCOLS.moonshot,
  PROTOCOLS.zhipu,
  PROTOCOLS.siliconflow,
  PROTOCOLS['siliconflow-intl'],
  PROTOCOLS.openrouter,
  PROTOCOLS['openai-billing'],
  {
    id: 'minimax',
    label: 'MiniMax Token Plan',
    kind: 'token',
    defaultBaseUrl: 'https://api.minimaxi.com',
    hint: 'GET /v1/token_plan/remains → total / remain'
  },
  PROTOCOLS.generic
]

export function selectableProtocolById(id: string): CatalogProtocol | undefined {
  return SELECTABLE_PROTOCOLS.find((p) => p.id === id)
}

export function protocolById(id: string): ProtocolDecl | undefined {
  return Object.prototype.hasOwnProperty.call(PROTOCOLS, id) ? PROTOCOLS[id] : undefined
}
