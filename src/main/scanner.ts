import type { ScanHit } from '../shared/types'

// 凭据自动扫描（只读）：环境变量 → 常见工具配置。
// 扫描结果只返回"来源"信息；值本身运行时直接使用，不落盘、不回显。

const ENV_MAP: Record<string, string[]> = {
  deepseek: ['DEEPSEEK_API_KEY'],
  kimi: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  zhipu: ['ZHIPUAI_API_KEY', 'ZHIPU_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  siliconflow: ['SILICONFLOW_API_KEY'],
  opencodeCookie: ['OPENCODE_GO_COOKIE']
}

// AK/SK 型凭据：成对环境变量组合为 "AK:SK(:STS)" 单串存储
const AKSK_ENV: Record<string, { ak: string[]; sk: string[]; sts?: string[] }> = {
  qwen: {
    ak: ['ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_ID'],
    sk: ['ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'ALIYUN_ACCESS_KEY_SECRET'],
    sts: ['ALIBABA_CLOUD_SECURITY_TOKEN']
  },
  volc: {
    ak: ['VOLCENGINE_ACCESS_KEY', 'VOLCENGINE_ACCESSKEY', 'VOLC_ACCESSKEY'],
    sk: ['VOLCENGINE_SECRET_KEY', 'VOLCENGINE_SECRETKEY', 'VOLC_SECRETKEY']
  }
}

function akskValue(providerId: string): string | null {
  const spec = AKSK_ENV[providerId]
  if (!spec) return null
  const ak = spec.ak.map((n) => process.env[n]).find(Boolean)
  const sk = spec.sk.map((n) => process.env[n]).find(Boolean)
  if (!ak || !sk) return null
  const sts = spec.sts?.map((n) => process.env[n]).find(Boolean)
  return sts ? `${ak}:${sk}:${sts}` : `${ak}:${sk}`
}

const EXTRA_ENV: Record<string, string[]> = {
  minimaxGroupId: ['MINIMAX_GROUP_ID'],
  opencodeWorkspaceId: ['OPENCODE_GO_WORKSPACE_ID']
}

export function scanEnv(): ScanHit[] {
  const hits: ScanHit[] = []
  for (const [providerId, names] of Object.entries(ENV_MAP)) {
    for (const n of names) {
      if (process.env[n]) {
        hits.push({ providerId, source: `env:${n}` })
        break
      }
    }
  }
  for (const [providerId, spec] of Object.entries(AKSK_ENV)) {
    if (akskValue(providerId)) hits.push({ providerId, source: `env:${spec.ak[0]}+${spec.sk[0]}` })
  }
  for (const [extra, names] of Object.entries(EXTRA_ENV)) {
    for (const n of names) {
      if (process.env[n]) {
        hits.push({ providerId: `extra:${extra}`, source: `env:${n}` })
        break
      }
    }
  }
  return hits
}

export function envValueFor(providerId: string): string | null {
  const aksk = akskValue(providerId)
  if (aksk) return aksk
  for (const n of ENV_MAP[providerId] ?? []) {
    if (process.env[n]) return process.env[n] as string
  }
  return null
}

/**
 * 环境变量里是否有这家供应商的凭据（含 AK:SK 成对判定）。
 * 这是**唯一**的答案来源：预设不再各自维护一份 envKeys（那两张表曾经不一致 ——
 * qwen/volc 的 AK/SK 只存在于本模块，于是设置页显示「未配置」而采集时却能拿到凭据）。
 */
export function hasEnvCredential(providerId: string): boolean {
  return envValueFor(providerId) !== null
}

export function envExtraFor(key: string): string | null {
  for (const n of EXTRA_ENV[key] ?? []) {
    if (process.env[n]) return process.env[n] as string
  }
  return null
}
