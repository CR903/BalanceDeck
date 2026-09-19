import type { ProviderKind, ProviderInfo, ProviderInstance, CatalogEntry } from '../shared/types'
import { envExtraFor, envValueFor } from './scanner'
import type { Store } from './store'
import {
  SELECTABLE_PROTOCOLS,
  selectableProtocolById,
  type CatalogProtocol
} from './adapters/protocols'

// ═══════════════════════════════════════════════════════════════════════════════
// 供应商实例注册表
//
// 用户添加的供应商 = 实例（instance）。同一预设可重复添加（不同 key/中转站）。
//   内置实例：presetId = 预设 id（opencode/deepseek/…），协议 = 预设协议
//   自定义实例：presetId = ''，协议从 CUSTOM_PROTOCOLS 选择
//
// 存储：
//   extras.providerInstances        → JSON 数组（ProviderInstance[]）
//   extras.provider:<id>:baseUrl    → 覆盖默认 API 地址
//   extras.provider:<id>:name       → 覆盖显示名（历史兼容，实例内已有 name）
//   keys[<id>]                      → 凭据（safeStorage 加密）
//
// 旧模型（内置常驻 + enabled 开关）在首次读取时自动迁移为实例。
// ═══════════════════════════════════════════════════════════════════════════════

/** 内置预设（目录项模板） */
let store: Store | null = null

/** 由组合根在启动时调用一次；未配置时任何读写都会立刻抛错 */
export function configureProviders(s: Store): void {
  store = s
}

function db(): Store {
  if (!store) throw new Error('providers 未配置存储：引导时调用 configureProviders(keystoreStore)')
  return store
}

export interface BuiltinPreset {
  id: string
  name: string
  kind: ProviderKind
  protocol: string
  defaultBaseUrl: string
  keyHint?: string
  /** 凭据来自本机工具文件（无需手动配置） */
  localCredential?: boolean
  /** 仅可添加一次（本机文件型数据源，重复无意义） */
  singleton?: boolean
  envKeys?: string[]
  /** 额外凭据探测（本机文件 / 工具数据库等非环境变量来源） */
  probeCredential?: () => Promise<boolean> | boolean
}

export const BUILTIN_PRESETS: BuiltinPreset[] = [
  {
    id: 'opencode',
    name: 'OpenCode Go',
    kind: 'coding',
    protocol: 'opencode-go',
    defaultBaseUrl: 'https://opencode.ai',
    keyHint: 'sk-…（每行一个可配多账号）',
    probeCredential: async () => {
      const { readGoKey, hasDbCredentialKey } = await import('./adapters/opencode')
      return !!readGoKey() || (await hasDbCredentialKey())
    }
  },
  {
    id: 'claude',
    name: 'Claude Code',
    kind: 'coding',
    protocol: 'claude-code',
    defaultBaseUrl: '',
    localCredential: true,
    singleton: true
  },
  {
    id: 'codex',
    name: 'Codex',
    kind: 'coding',
    protocol: 'codex',
    defaultBaseUrl: '',
    localCredential: true,
    singleton: true
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    kind: 'coding',
    protocol: 'copilot',
    defaultBaseUrl: 'https://api.github.com',
    localCredential: true,
    singleton: true
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'balance',
    protocol: 'deepseek',
    defaultBaseUrl: 'https://api.deepseek.com',
    keyHint: 'sk-…（35 位）',
    envKeys: ['DEEPSEEK_API_KEY']
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    kind: 'balance',
    protocol: 'moonshot',
    defaultBaseUrl: 'https://api.moonshot.cn',
    keyHint: 'sk-…',
    envKeys: ['MOONSHOT_API_KEY', 'KIMI_API_KEY']
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    kind: 'balance',
    protocol: 'zhipu',
    defaultBaseUrl: 'https://open.bigmodel.cn',
    keyHint: 'id.secret',
    envKeys: ['ZHIPUAI_API_KEY', 'ZHIPU_API_KEY']
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    kind: 'balance',
    protocol: 'siliconflow',
    defaultBaseUrl: 'https://api.siliconflow.cn',
    keyHint: 'sk-…',
    envKeys: ['SILICONFLOW_API_KEY']
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    kind: 'token',
    protocol: 'minimax',
    defaultBaseUrl: 'https://api.minimaxi.com',
    keyHint: 'sk-…',
    envKeys: ['MINIMAX_API_KEY']
  },
  {
    id: 'qwen',
    name: '通义千问（百炼）',
    kind: 'balance',
    protocol: 'qwen-bss',
    defaultBaseUrl: 'https://business-api.aliyun.com',
    keyHint: 'AccessKeyId:AccessKeySecret'
  },
  {
    id: 'volc',
    name: '火山方舟',
    kind: 'balance',
    protocol: 'volc-billing',
    defaultBaseUrl: 'https://open.volcengineapi.com',
    keyHint: 'AccessKeyId:SecretAccessKey'
  }
]

export function presetById(id: string): BuiltinPreset | undefined {
  return BUILTIN_PRESETS.find((b) => b.id === id)
}

// 协议目录与采集声明**同源**（ADR-0001）：新增或修改协议只改
// src/main/adapters/protocols.ts 一张表，目录元数据不再各写一份。
export type CustomProtocol = CatalogProtocol
export const CUSTOM_PROTOCOLS: CustomProtocol[] = SELECTABLE_PROTOCOLS
export const customProtocolById = selectableProtocolById

/**
 * 「添加提供方」选择列表：
 *   内置预设（获取方式特殊且常用）+ 自定义协议模板。
 * singleton 预设已添加过则不再出现。
 */
export async function listCatalog(): Promise<CatalogEntry[]> {
  const instances = await listInstances()
  const usedPresets = new Set(instances.map((i) => i.presetId).filter(Boolean))
  const out: CatalogEntry[] = []
  for (const p of BUILTIN_PRESETS) {
    if (p.singleton && usedPresets.has(p.id)) continue
    out.push({
      key: `preset:${p.id}`,
      label: p.name,
      kind: p.kind,
      protocol: p.protocol,
      defaultBaseUrl: p.defaultBaseUrl,
      presetId: p.id,
      keyHint: p.keyHint,
      singleton: p.singleton
    })
  }
  for (const c of CUSTOM_PROTOCOLS) {
    out.push({
      key: `protocol:${c.id}`,
      label: c.label,
      kind: c.kind,
      protocol: c.id,
      defaultBaseUrl: c.defaultBaseUrl,
      presetId: null,
      hint: c.hint
    })
  }
  return out
}

// ─── 实例读写 ───────────────────────────────────────────────────────────────

function isInstance(x: unknown): x is ProviderInstance {
  return (
    !!x &&
    typeof x === 'object' &&
    typeof (x as ProviderInstance).id === 'string' &&
    typeof (x as ProviderInstance).name === 'string' &&
    typeof (x as ProviderInstance).protocol === 'string'
  )
}

/** 读取实例列表；首次运行时从旧模型迁移 */
export async function listInstances(): Promise<ProviderInstance[]> {
  const raw = await db().getExtra('providerInstances')
  if (raw === null) {
    const migrated = await migrateLegacy()
    await saveInstances(migrated)
    return migrated
  }
  try {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter(isInstance).map((i) => ({ ...i, enabled: i.enabled !== false }))
  } catch {
    return []
  }
}

async function saveInstances(list: ProviderInstance[]): Promise<void> {
  await db().setExtra('providerInstances', JSON.stringify(list))
}

/** 旧模型迁移：把"已启用且已配置"的内置供应商转为实例（保留原 id，凭据无需迁移） */
async function migrateLegacy(): Promise<ProviderInstance[]> {
  const out: ProviderInstance[] = []
  for (const p of BUILTIN_PRESETS) {
    const enabledFlag = (await db().getExtra(`provider:${p.id}:enabled`)) ?? (await db().getExtra(`enabled:${p.id}`)) ?? '1'
    if (enabledFlag === '0') continue

    const saved = await db().getKey(p.id)
    const fromEnv = (p.envKeys ?? []).some((n) => !!process.env[n])
    let fromProbe = false
    if (!saved && !fromEnv && p.probeCredential) {
      try {
        fromProbe = await p.probeCredential()
      } catch {
        fromProbe = false
      }
    }
    // 仅迁移"有凭据"的（新模型里未配置的不再常驻显示）
    if (!saved && !fromEnv && !fromProbe && !p.localCredential) continue

    out.push({
      id: p.id,
      name: p.name,
      presetId: p.id,
      protocol: p.protocol,
      kind: p.kind,
      baseUrl: (await db().getExtra(`provider:${p.id}:baseUrl`)) ?? (await db().getExtra(`baseUrl:${p.id}`)) ?? p.defaultBaseUrl,
      builtin: true,
      enabled: true,
      createdAt: Date.now()
    })
  }
  return out
}

export async function addInstance(payload: {
  presetId?: string
  protocol?: string
  name?: string
  baseUrl?: string
}): Promise<ProviderInstance> {
  const list = await listInstances()

  const preset = payload.presetId ? presetById(payload.presetId) : undefined
  const protocol = preset?.protocol ?? payload.protocol ?? 'generic'
  const custom = customProtocolById(protocol)

  const instance: ProviderInstance = {
    id: `inst:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: (payload.name ?? '').trim() || preset?.name || custom?.label || '自定义供应商',
    presetId: preset?.id ?? '',
    protocol,
    kind: preset?.kind ?? custom?.kind ?? 'balance',
    baseUrl: (payload.baseUrl ?? '').trim() || preset?.defaultBaseUrl || custom?.defaultBaseUrl || '',
    builtin: !!preset,
    enabled: true,
    createdAt: Date.now()
  }
  list.push(instance)
  await saveInstances(list)
  return instance
}

export async function removeInstance(id: string): Promise<boolean> {
  const list = await listInstances()
  const next = list.filter((i) => i.id !== id)
  if (next.length === list.length) return false
  await saveInstances(next)
  // 清理关联配置与凭据
  await db().setExtra(`provider:${id}:baseUrl`, '')
  await db().setExtra(`provider:${id}:name`, '')
  await db().setKey(id, '')
  return true
}

export async function setInstanceEnabled(id: string, enabled: boolean): Promise<boolean> {
  const list = await listInstances()
  const inst = list.find((i) => i.id === id)
  if (!inst) return false
  inst.enabled = enabled
  await saveInstances(list)
  return true
}

export async function setInstanceBaseUrl(id: string, baseUrl: string): Promise<boolean> {
  const list = await listInstances()
  const inst = list.find((i) => i.id === id)
  if (!inst) return false
  inst.baseUrl = baseUrl.trim()
  await saveInstances(list)
  return true
}

export async function setInstanceName(id: string, name: string): Promise<boolean> {
  const list = await listInstances()
  const inst = list.find((i) => i.id === id)
  if (!inst) return false
  inst.name = name.trim()
  await saveInstances(list)
  return true
}

/**
 * 按给定 id 顺序重排实例（卡片拖拽排序）。
 * 未出现在 ids 里的实例保持相对顺序追加到末尾（防御：渲染层可能拿到过期列表）。
 */
export async function reorderInstances(ids: string[]): Promise<boolean> {
  const list = await listInstances()
  const rank = new Map(ids.map((id, i) => [id, i]))
  const next = [...list].sort((a, b) => {
    const ra = rank.get(a.id)
    const rb = rank.get(b.id)
    if (ra === undefined && rb === undefined) return 0
    if (ra === undefined) return 1
    if (rb === undefined) return -1
    return ra - rb
  })
  if (next.every((x, i) => x.id === list[i]?.id)) return false
  await saveInstances(next)
  return true
}

// ─── ProviderInfo 组装 ──────────────────────────────────────────────────────

export async function instanceInfo(inst: ProviderInstance): Promise<ProviderInfo> {
  const preset = inst.presetId ? presetById(inst.presetId) : undefined
  const protocol = inst.protocol
  const custom = preset ? undefined : customProtocolById(protocol)

  let credentialSource: ProviderInfo['credentialSource'] = 'none'
  const saved = await db().getKey(inst.id)
  if (saved) credentialSource = 'saved'
  else if (preset?.envKeys?.some((n) => !!process.env[n])) credentialSource = 'env'
  else if (preset?.localCredential) credentialSource = 'file'
  else if (preset?.probeCredential) {
    try {
      if (await preset.probeCredential()) credentialSource = 'file'
    } catch {
      // 探测失败按未配置处理
    }
  }

  // OpenCode 协议支持控制台 cookie（百分比精度从整数提升到一位小数）
  const supportsCookie = protocol === 'opencode-go'
  // 环境变量名统一由 scanner 的表拥有（这里曾内联读 process.env，与那张表重复）
  const cookie = supportsCookie
    ? ((await db().getKey('opencodeCookie')) ?? envValueFor('opencodeCookie') ?? '')
    : ''
  const workspaceId = supportsCookie
    ? ((await db().getExtra('opencodeWorkspaceId')) ?? envExtraFor('opencodeWorkspaceId') ?? '')
    : ''

  return {
    id: inst.id,
    name: inst.name,
    kind: inst.kind,
    builtin: inst.builtin,
    enabled: inst.enabled,
    credentialSource,
    protocol,
    baseUrl: inst.baseUrl,
    presetId: inst.presetId,
    createdAt: inst.createdAt,
    keyHint: preset?.keyHint ?? (custom ? 'sk-…' : undefined),
    supportsCookie,
    cookieHint:
      supportsCookie && cookie
        ? `已配置·${cookie.slice(-4)}${workspaceId ? '' : '（缺 Workspace ID）'}`
        : supportsCookie && workspaceId
          ? '待填 Cookie'
          : undefined
  }
}

export async function listProviders(): Promise<ProviderInfo[]> {
  const out: ProviderInfo[] = []
  for (const inst of await listInstances()) out.push(await instanceInfo(inst))
  return out
}
