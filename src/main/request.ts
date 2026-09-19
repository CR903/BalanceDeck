import { assertNetAvailable, markNetResult } from './net'
import type { CollectRequest, CollectResponse } from './adapters/types'

// ═══════════════════════════════════════════════════════════════════════════════
// 生产环境的出网实现 —— CollectContext.request 的真实适配器
//
// 只有这个模块（以及它 import 的 net.ts）依赖 electron。采集引擎与各适配器都不依赖：
// 它们从上下文拿能力，因此可以在纯 node 里被单元测试加载并注入桩。
//
// 这里同时保留原来的两件事：
//   · 超时（默认 12s，AbortController）—— 与历史 getJson 一致
//   · 网络可达性记账（markNetResult）—— scheduler 的 isOffline() 靠它判断离线
// ═══════════════════════════════════════════════════════════════════════════════

/** 出网并返回原始响应文本；失败（DNS/连接/超时）会抛出并计入离线判定 */
export async function request(req: CollectRequest): Promise<CollectResponse> {
  assertNetAvailable()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 12000)
  try {
    const res = await fetch(req.url, { headers: req.headers, signal: ctrl.signal })
    markNetResult(true)
    return { status: res.status, text: await res.text() }
  } catch (e) {
    markNetResult(false, e)
    throw e
  } finally {
    clearTimeout(timer)
  }
}
