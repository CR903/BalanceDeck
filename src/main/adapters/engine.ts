import type { DataQuality, ProviderKind, ProviderSnapshot } from '../../shared/types'
import type { CollectContext } from './types'

// ═══════════════════════════════════════════════════════════════════════════════
// 采集引擎（第 1 步：线上那一半 + 铸造）
//
// 这个模块**不 import electron**，也不 import net.ts —— 出网能力由 CollectContext
// 注入（生产实现在 src/main/request.ts，测试桩在 scripts/test-adapters.mjs）。
// 那是适配器能被单元测试加载的前提（见 docs/adr/0003 的背景）。
//
// 三条纪律：
//   1. 铸造（snap / errSnap / noDataSnap）是**唯一**产出快照的地方。
//   2. **身份必填**（ADR-0001）：id / name / kind / builtin 由调用方写明，
//      没有默认值可被误用 —— 否则自定义实例的错误快照会自称「内置」。
//   3. **可信度必填**（ADR-0002）：ok 路径显式声明来路；错误 / 无数据快照
//      显式传 undefined（没有可声明的来路），不允许默认成 official。
//
// mark 是例外，它是**实例派生**的元数据（内置用预设 id、自定义用协议 id）：
// 声明式工厂知道实例所以直接给；代码适配器由实例绑定层（./bind-instance）补齐。
// ═══════════════════════════════════════════════════════════════════════════════

/** 官方接口的来路标注；本机估算等其它来源由各自适配器声明 */
export const OFFICIAL: DataQuality = 'official'

/** 快照的身份部分：铸造的必填输入（ProviderAdapter 结构上就满足它） */
export interface Identity {
  id: string
  name: string
  kind: ProviderKind
  builtin: boolean
  /** 图标 key（实例派生，可后补） */
  mark?: string
}

/** 从适配器取出身份（复制一份，避免把 collect 之类的成员带进快照） */
export function identityOf(a: Identity): Identity {
  return { id: a.id, name: a.name, kind: a.kind, builtin: a.builtin, mark: a.mark }
}

export type MintBase = Omit<
  Partial<ProviderSnapshot>,
  'dataQuality' | 'id' | 'name' | 'kind' | 'builtin' | 'mark'
> &
  Identity

/**
 * 铸造一个快照。身份与可信度都必须由调用方写明（见文件头三条纪律）。
 */
export function snap(
  quality: DataQuality | undefined,
  base: MintBase,
  ctx: CollectContext
): ProviderSnapshot {
  const at = ctx.now.toISOString()
  return {
    status: 'ok',
    windows: [],
    ...base,
    dataQuality: quality,
    dataAt: base.dataAt ?? at,
    updatedAt: at
  }
}

/** 官方接口实时数据（HTTP 协议声明的默认来路） */
export const officialSnap = (base: MintBase, ctx: CollectContext): ProviderSnapshot =>
  snap(OFFICIAL, base, ctx)

/** 本机估算（官方不可达或本就没有官方接口，口径不同） */
export const localSnap = (base: MintBase, ctx: CollectContext): ProviderSnapshot =>
  snap('local', base, ctx)

/**
 * 错误快照。quality 显式留空 —— 「本轮没拿到数据」没有来路可声明，
 * 旧实现让它默认成 official（ADR-0002 记录的那个谎言）。
 */
export function errSnap(identity: Identity, message: string, ctx: CollectContext): ProviderSnapshot {
  return {
    ...snap(undefined, identity, ctx),
    status: 'error',
    detail: message,
    failureReason: message
  }
}

/** 未配置快照（用户还没填凭据，不是错误） */
export function noDataSnap(identity: Identity, detail: string, ctx: CollectContext): ProviderSnapshot {
  return { ...snap(undefined, identity, ctx), status: 'nodata', detail }
}

/**
 * 出网 + JSON 解析（历史上是 types.ts 里的 getJson）。
 * 出网走注入的能力，因此测试可以给桩；解析失败时把原文截断放进 body，
 * 供各适配器生成「响应格式未识别：<预览>」这类提示。
 */
export async function readJson(
  ctx: CollectContext,
  url: string,
  headers: Record<string, string>,
  timeoutMs = 12000
): Promise<{ status: number; body: unknown }> {
  const res = await ctx.request({ url, headers, timeoutMs })
  const text = res.text
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text.slice(0, 200)
  }
  return { status: res.status, body }
}
