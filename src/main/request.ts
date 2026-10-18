import { assertNetAvailable, markNetResult } from './net'
import type { CollectRequest, CollectResponse } from './adapters/types'

// ═══════════════════════════════════════════════════════════════════════════════
// 生产环境的出网实现 —— CollectContext.request 的真实适配器
//
// 只有这个模块（以及它 import 的 net.ts）依赖 electron。采集引擎与各适配器都不依赖：
// 它们从上下文拿能力，因此可以在纯 node 里被单元测试加载并注入桩。
//
// 这里同时保留原来的两件事：
//   · 超时（默认 12s）—— 与历史 getJson 一致
//   · 网络可达性记账（markNetResult）—— scheduler 的 isOffline() 靠它判断离线
//
// 2026-10-18 加固（任务 10-18-sync-collect-watchdog，R3）：
//   `AbortController` 只对**已经进入 fetch 状态机**的请求有效。真机取证显示卡在
//   建连前阶段（DNS / TCP connect）的请求既不被 abort 打断，也不体现在任何记账上
//   （lsof 零连接、线程 99.4% 采样陷在 select()）—— 于是「一轮采集」可以永不返回。
//   所以超时必须有**两条**路：abort（让底层连接尽快被放弃）+ 竞速（即使 abort
//   管不到也必须在 timeoutMs 量级内返回失败）。两者都要，不是二选一。
// ═══════════════════════════════════════════════════════════════════════════════

/** 出网并返回原始响应文本；失败（DNS/连接/超时）会抛出并计入离线判定 */
export async function request(req: CollectRequest): Promise<CollectResponse> {
  assertNetAvailable()
  const ms = req.timeoutMs ?? 12000
  const ctrl = new AbortController()
  /**
   * 竞速已判负之后，**迟到**的响应不得再改可达性记账。
   *
   * 真实污染：一次超时把 failStreak 推到 2（判定离线）之后，原请求若在几十秒后
   * 悄悄成功，会把 failStreak 清零 —— 离线判定被一个「其实已经超时的请求」推翻，
   * 而用户看到的界面是「离线横幅闪了一下又没了」。
   */
  let decided = false
  /** 复用既有 `AbortError` 这个名字，而不是新增 TimeoutError：`shared/quality.ts` 的
   *  `isNetworkError` 已把 `name === 'AbortError'` 判为网络类错误（语义完全等价），
   *  新增一个名字就得同时改分类器与它的测试，白白扩大面。 */
  const abortErr = (): Error => {
    const e = new Error(`请求超时（${ms}ms）`)
    e.name = 'AbortError'
    return e
  }
  // 缺省 'GET'：不传 method 的调用点与本改动前逐字相同（缺省行为由既有 18 个套件证明）
  const method = req.method ?? 'GET'
  // Content-Type 归调用方：只在「有 body 且调用方未带」时补 JSON。
  // 自带就原样用 —— form-encoded 端点（Gemini 刷 token）带自己的头，不能被改。
  const headers = withContentType(req.headers, req.body)
  const abortTimer = setTimeout(() => ctrl.abort(), ms)
  let raceTimer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      (async (): Promise<CollectResponse> => {
        const res = await fetch(req.url, { method, headers, body: req.body, signal: ctrl.signal })
        if (!decided) markNetResult(true)
        return { status: res.status, text: await res.text() }
      })(),
      new Promise<never>((_res, rej) => {
        raceTimer = setTimeout(() => {
          ctrl.abort()
          rej(abortErr())
        }, ms)
      })
    ])
  } catch (e) {
    if (!decided) markNetResult(false, e)
    throw e
  } finally {
    decided = true
    clearTimeout(abortTimer)
    if (raceTimer) clearTimeout(raceTimer)
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
