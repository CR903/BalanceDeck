import type { ProviderAdapter, CollectContext } from './types'
import { errSnap } from './engine'
import type { ProviderInstance } from '../../shared/types'
import { opencodeAdapter } from './opencode'
import { minimaxAdapter } from './minimax'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'
import { copilotAdapter } from './copilot'
import { cursorAdapter } from './cursor'
import { geminiAdapter } from './gemini'
import { antigravityAdapter } from './antigravity'
import { qwenAdapter } from './qwen'
import { volcAdapter } from './volc'
import { PROTOCOLS, protocolById } from './protocols'
import { createProtocolAdapter } from './protocol-adapter'
import { bindInstance } from './bind-instance'

/**
 * 代码实现的协议（声明表达不了的那些）：
 *   · 请求签名：qwen-bss（阿里云 RPC 签名）、volc-billing（火山签名）
 *   · 浏览器会话 / 本机文件：opencode-go、claude-code、codex、copilot、cursor、antigravity
 *   · 备用端点与平台状态码：minimax（Token Plan 失败回落旧接口 query_balance）
 *
 * 其余 8 个协议走 ./protocols 的声明（ADR-0001）。
 * 基座适配器按固定 id 读凭据，由 ./bind-instance 重定向到实例。
 */
export const CODE_ADAPTERS: Record<string, ProviderAdapter> = {
  'opencode-go': opencodeAdapter,
  'claude-code': claudeAdapter,
  codex: codexAdapter,
  copilot: copilotAdapter,
  cursor: cursorAdapter,
  gemini: geminiAdapter,
  antigravity: antigravityAdapter,
  minimax: minimaxAdapter,
  'qwen-bss': qwenAdapter,
  'volc-billing': volcAdapter
}

/**
 * 由实例列表构建适配器：纯函数（读注册表是 scheduler 的事）。
 * 这样路由逻辑不依赖 electron、也不依赖存储，可以直接被单元测试驱动。
 *
 * 路由只按**协议**决定，不再看实例是不是内置（ADR-0001）：
 *   声明表命中 → 同一个协议工厂；否则 → 代码适配器；两者都没有 → 通用宽容解析兜底。
 */
export function buildAdapters(instances: ProviderInstance[]): ProviderAdapter[] {
  const out: ProviderAdapter[] = []
  for (const inst of instances) {
    if (!inst.enabled) continue
    const decl = protocolById(inst.protocol)
    if (decl) {
      out.push(createProtocolAdapter(decl, inst))
      continue
    }
    const base = CODE_ADAPTERS[inst.protocol]
    if (base) {
      out.push(bindInstance(base, inst))
      continue
    }
    // 未知协议（历史数据）→ 通用宽容解析，与旧实现 custom.ts 的 switch 默认分支一致
    out.push(createProtocolAdapter(PROTOCOLS.generic, inst))
  }
  return out
}

/**
 * 并行采集见 ./collect —— 刻意分开，好让那一步不依赖本模块的 ../providers。
 * 这里再导出一次，保持调用方（scheduler）的 import 不变。
 */
export { collectAll } from './collect'
