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
  // 缺省 'GET'：不传 method 的调用点与本改动前逐字相同（缺省行为由既有 18 个套件证明）
  const method = req.method ?? 'GET'
  // Content-Type 归调用方：只在「有 body 且调用方未带」时补 JSON。
  // 自带就原样用 —— form-encoded 端点（Gemini 刷 token）带自己的头，不能被改。
  const headers = withContentType(req.headers, req.body)
  try {
    const res = await fetch(req.url, { method, headers, body: req.body, signal: ctrl.signal })
    markNetResult(true)
    return { status: res.status, text: await res.text() }
  } catch (e) {
    markNetResult(false, e)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/**
 * body 与 Content-Type 的配套规则（唯一允许的补齐，别再加别的智能行为）：
 *   · 无 body          → 不碰 headers（无体请求不需要 Content-Type）
 *   · 有 body + 自带    → 原样返回（form-encoded 端点靠这条生效）
 *   · 有 body + 没自带  → 补 application/json
 * 头名大小写不敏感地判「自带」，否则调用方写 `content-type` 会被补成两份。
 */
function withContentType(headers: Record<string, string>, body: string | undefined): Record<string, string> {
  if (body === undefined) return headers
  const has = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')
  if (has) return headers
  return { ...headers, 'Content-Type': 'application/json' }
}
