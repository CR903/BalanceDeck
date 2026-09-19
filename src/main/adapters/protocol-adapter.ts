import type { ProviderAdapter, CollectContext } from './types'
import type { ProviderInstance, ProviderSnapshot } from '../../shared/types'
import { errSnap, noDataSnap, officialSnap, readJson } from './engine'
import type { ProtocolDecl } from './protocols'

// ═══════════════════════════════════════════════════════════════════════════════
// 协议声明 → 适配器（内置预设实例与自定义实例走的是同一个工厂）
//
// 这里只有一份「键ed 余额接口」的实现：
//   取凭据 → 定 Base URL → 探测 → 出网（注入的能力）→ 状态映射 → 读取 → 铸造
//
// 与旧实现的两处刻意差异（ADR-0001「以内置为准」）：
//   1. 身份（kind/builtin/mark）由本工厂显式交给铸造，不再依赖铸造的默认值 ——
//      因此自定义实例的错误快照不会再自称「内置」（黄金样本 D1/D2 由此收口）。
//   2. source 按实例身份推导：内置 = 官方接口，自定义 = 自定义接口（用户已确认的收口原则）。
// ═══════════════════════════════════════════════════════════════════════════════

/** 未配置凭据：内置实例点名环境变量；自定义实例给编辑指引 */
function missingKeyMessage(decl: ProtocolDecl, builtin: boolean): string {
  return builtin && decl.envKey
    ? `未配置 API Key（可在设置中填写或设 ${decl.envKey}）`
    : '未配置 API Key（在设置中编辑该供应商）'
}

/** 鉴权失败：声明可覆盖 401 文案（区分官方域名 / 中转平台）；403 与其余走通用文案 */
function authFailedMessage(
  decl: ProtocolDecl,
  status: number,
  baseUrl: string,
  builtin: boolean
): string {
  if (status === 401 && decl.authHint) {
    const hint = decl.authHint(baseUrl)
    if (hint) return hint
  }
  if (builtin && status === 401) return '鉴权失败（401）：API Key 无效'
  return `鉴权失败（HTTP ${status}）：请核对该供应商的 Key 与 API 地址`
}

export function createProtocolAdapter(decl: ProtocolDecl, inst: ProviderInstance): ProviderAdapter {
  // 身份一次算好：快照的每一处出口都带上它，不留默认值可被误用
  const identity = {
    id: inst.id,
    name: inst.name,
    kind: inst.kind,
    builtin: inst.builtin,
    // 图标 key：内置用预设 id，自定义用协议 id
    mark: inst.presetId || inst.protocol
  }

  return {
    ...identity,

    async collect(ctx: CollectContext): Promise<ProviderSnapshot> {
      const key = await ctx.getKey(inst.id)
      if (!key) return noDataSnap(identity, missingKeyMessage(decl, inst.builtin), ctx)

      // Base URL 三级：遗留 extras 覆盖 → 实例字段（设置页写的就是它）→ 协议默认。
      // 旧实现把实例字段只用于自定义实例，导致「改内置供应商的 Base URL 不生效」。
      const override = await ctx.getExtra(`provider:${inst.id}:baseUrl`)
      const baseUrl = (override || inst.baseUrl || decl.defaultBaseUrl).replace(/\/+$/, '')
      if (!baseUrl) return errSnap(identity, '未配置 API 地址（在设置中编辑该供应商）', ctx)

      const probe = decl.probe(baseUrl)
      const url = 'path' in probe ? baseUrl + probe.path : probe.url.trim()
      if (!url) return errSnap(identity, '未配置 API 地址（在设置中编辑该供应商）', ctx)

      try {
        const { status, body } = await readJson(ctx, url, {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json'
        })
        if (status === 401 || status === 403) {
          return errSnap(identity, authFailedMessage(decl, status, baseUrl, inst.builtin), ctx)
        }
        // 自定义实例多一条 404 指引：地址填错是最常见的失败（内置实例保持 HTTP 404）
        if (status === 404 && !inst.builtin) {
          return errSnap(identity, '端点不存在（HTTP 404）：请核对该供应商的协议与 API 地址', ctx)
        }
        if (status !== 200) return errSnap(identity, `HTTP ${status}`, ctx)

        const windows = decl.read(body)
        if (!windows) {
          const preview = typeof body === 'string' ? body : JSON.stringify(body).slice(0, 160)
          return errSnap(identity, decl.unrecognizedHint ?? `响应格式未识别：${preview}`, ctx)
        }
        return officialSnap(
          { ...identity, windows, source: inst.builtin ? '官方接口' : '自定义接口' },
          ctx
        )
      } catch (e) {
        return errSnap(identity, `请求失败: ${(e as Error).message}`, ctx)
      }
    }
  }
}
