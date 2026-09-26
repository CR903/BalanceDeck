import {
  CONSOLE_ORIGIN,
  MODELS_PAGE_SIZE,
  MODELS_RANGES,
  USAGE_MODELS_PATH,
  USAGE_UNIT_SCALE,
  buildConsoleHeaders
} from './adapters/opencode-console-api'

// ═══════════════════════════════════════════════════════════════════════════════
// 控制台「每模型用量明细」
//
// 背景与历史：控制台最早把明细放在「显示详情」展开后的表格里。那张表不在 SSR HTML 里，
// 是点击后由客户端 RPC 拉的，于是当时的实现选择驱动一个隐藏窗口完成
// 「点击展开 → 读 DOM」（见 `design.md` 记录的判断：与其逆向私有 RPC，不如驱动用户手动做的事，
// 对站点改版更鲁棒）。
//
// **2026-09-26 那个判断被站点改版证伪了**：控制台重写为纯客户端 SPA，SSR 消失，
// DOM 换了一轮（实测 `[data-slot="usage-details-trigger"]` 与 `usage-item` 都不存在了，
// `npm run details:test` 耗时 21s 返回 `{}`）。而数据端点反而在公开 bundle 里
// 带着 OpenAPI 声明标了 stable。所以改成直接调接口，删掉整段 DOM 驱动。
//
// 端点：GET /console/api/usage/models?range=7d|30d&pageSize=N   （必需 x-org-id）
// 真实响应（2026-09-26 实测，已脱敏）：
//   { "items": [ { "model": "deepseek-flash", "provider": "opencode-go",
//                  "totalRequests": "4357", "totalInputTokens": "18089708",
//                  "totalOutputTokens": "3193794", "totalCacheReadTokens": "858154621",
//                  "totalCacheWrite5mTokens": "0", "totalCacheWrite1hTokens": "0",
//                  "totalCostMicroCents": "1180850167" } ],
//     "pageInfo": { … } }
//
// ⚠️ **它没有 per-model 的配额与百分比**（旧 DOM 版能从表头读到「每月配额」与 %）。
//    所以 `quotaUsd` / `percent` 这两个字段被删掉，而不是填 0 ——
//    填 0 会在界面上显示成「0% / $0」，那是撒谎。渲染层本来就支持缺省
//    （`DetailView.tsx` 对 undefined 显示「—」）。
//    反过来多了样东西：**服务端 tokens**（旧版 tokens 只能取本机 db，多设备不全）。
//
// ⚠️ **5 小时窗口没有明细**：端点 range 只有 24h / 7d / 30d，最小 24h 对不上 5 小时。
//    `MODELS_RANGES` 故意不映射 rolling —— 宁可该窗口不显示明细，
//    也不把 24h 的数据标成「5 小时」（`TASKS.md` 记过正是这类口径 bug）。
//
// 非阻塞：命中缓存直接返回；未命中时后台刷新并立即返回旧值（或 null）。
// 抓取要出网 + 分页，合理耗时；同步等待会拖慢采集周期。
// ═══════════════════════════════════════════════════════════════════════════════

const CACHE_TTL_MS = 5 * 60_000
const TIMEOUT_MS = 12_000

export interface ConsoleModelRow {
  model: string
  /** 服务端归一化的 provider（实测恒为 "opencode-go"） */
  provider: string
  /** 该范围内已用金额（USD） */
  usageUsd: number
  /**
   * token 总量，**来自服务端**（input + output + cache read + 5m/1h cache write）。
   * 旧版这里只能拼本机 db，所以多设备会漏；现在以服务端为准。
   */
  tokens: number
  /** 请求数（服务端口径） */
  requests: number
}

export type ConsoleDetails = Partial<Record<'weekly' | 'monthly', ConsoleModelRow[]>>

interface CacheEntry {
  at: number
  data: ConsoleDetails
}

const cache = new Map<string, CacheEntry>()
/**
 * 在途请求 —— **按缓存键分开**，不是单一全局槽。
 *
 * 原来是一个模块级变量，而 `invalidateConsoleDetails()` 只清了 `cache`、没清它：
 * 自愈路径（换了 cookie）调 `fetchConsoleDetails` 时会看到旧 cookie 的请求仍在途，
 * 于是跳过新抓取，而 `hit` 刚被清掉 → 返回 null，明细空一轮，
 * 且旧结果最后被写进**旧键**的缓存。（2026-09-26 评审发现）
 */
const inflight = new Map<string, Promise<ConsoleDetails | null>>()

/**
 * 缓存键。
 *
 * 用 cookie 的**长度**做身份近似是当时的权宜之计（不把凭据本身塞进 Map key，
 * 免得它出现在调试输出里）。代价：会话轮换后若新 cookie 恰好等长，
 * 会拿到最多 5 分钟的旧数据。所以键里额外掺一个 cookie 首尾字符的短摘要。
 */
function cacheKey(workspaceId: string, cookie: string): string {
  const head = cookie.slice(0, 12)
  const tail = cookie.slice(-8)
  return `${workspaceId}|${cookie.length}|${head.length}${tail.length}`
}

const debugLog = (msg: string): void => {
  if (!process.env.BALANCEDECK_DEBUG) return
  void import('fs').then(({ appendFileSync }) =>
    appendFileSync('/tmp/balancedeck-details.log', `${new Date().toISOString()} ${msg}\n`)
  )
}

/** 字符串或数字都吃（端点把数字发成字符串，测试里可能用数字） */
function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v !== 'string') return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 解析 `usage/models` 响应。**纯函数**（可直接单测）。
 * 认不出的 item 键不会导致丢弃 —— 只取已知的四个数值字段。
 */
export function parseModelsResponse(body: unknown): ConsoleModelRow[] {
  if (!body || typeof body !== 'object') return []
  const items = (body as { items?: unknown }).items
  if (!Array.isArray(items)) return []
  const out: ConsoleModelRow[] = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const m = raw as Record<string, unknown>
    const model = typeof m.model === 'string' ? m.model.trim() : ''
    if (!model) continue
    out.push({
      model,
      provider: typeof m.provider === 'string' ? m.provider : '',
      usageUsd: num(m.totalCostMicroCents) / USAGE_UNIT_SCALE,
      tokens:
        num(m.totalInputTokens) +
        num(m.totalOutputTokens) +
        num(m.totalCacheReadTokens) +
        num(m.totalCacheWrite5mTokens) +
        num(m.totalCacheWrite1hTokens),
      requests: num(m.totalRequests)
    })
  }
  return out
}

/**
 * 抓一个 range 的明细。
 *
 * **串行 + 重试一次**，两个刻意的决定（都是 2026-09-26 实测踩出来的）：
 *
 * 1) 原来用 `Promise.all` 并发两个 range。实测会**间歇性有一个失败**（`fetch failed`，
 *    undici 的连接层错误），后果是整整一个窗口的明细静默消失 —— 而明细是"某个窗口
 *    突然没有模型表"这种用户看得见又说不清的问题。串行后没再复现。
 * 2) 单次失败重试一次再放弃：这些请求本身只要 ~1s，重试的代价远小于丢一窗数据。
 *
 * 失败返回 `[]`（明细是增强项，不该让整轮采集失败），但**必须留下日志** ——
 * 静默为空和"真的没有数据"在界面上长得一模一样。
 *
 * **刻意不走采集引擎的 `ctx.request`**，而用原生 fetch —— 这是有意的：
 * 引擎会做可达性记账，而明细是**增强项**，它挂掉绝不该让 opencode 被判成「离线」。
 * 窗口数据走 `opencode-cookie.ts`（经过引擎），明细走这里（不经过），
 * 两条路径的失败语义因此不同，是设计决定而非遗漏。
 *
 * ⚠️ **这一层目前没有自动化测试**（`test-ssr-parser` 只覆盖纯解析器）。
 * 2026-09-26 评审实测：把串行改回并发、或删掉重试，测试全绿。
 * 要覆盖得给原生 fetch 打桩；`test-adapters.mjs` 已有给 `ctx.request` 打桩的先例，
 * 但本模块刻意不用 `ctx.request`（见上），所以不能直接复用那个桩。
 */
async function fetchRange(cookie: string, orgId: string, range: string): Promise<ConsoleModelRow[]> {
  const url =
    `${CONSOLE_ORIGIN}${USAGE_MODELS_PATH}` +
    `?range=${encodeURIComponent(range)}&page=1&pageSize=${MODELS_PAGE_SIZE}`
  let lastErr = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(url, { headers: buildConsoleHeaders(cookie, orgId), signal: ctrl.signal })
      if (res.status !== 200) {
        // 401/403 是稳定的（会话问题），重试没有意义
        if (res.status < 500 && res.status !== 429) {
          debugLog(`models range=${range} -> HTTP ${res.status}，不重试（会话/参数问题）`)
          return []
        }
        lastErr = `HTTP ${res.status}`
      } else {
        const rows = parseModelsResponse(JSON.parse(await res.text()))
        debugLog(
          `models range=${range} -> ${rows.length} 行${rows[0] ? `，首行=${rows[0].model} $${rows[0].usageUsd.toFixed(4)}` : '（空）'}`
        )
        return rows
      }
    } catch (e) {
      lastErr = (e as Error).message
    } finally {
      clearTimeout(timer)
    }
    if (attempt === 1) debugLog(`models range=${range} 第 1 次失败（${lastErr}），重试`)
  }
  debugLog(`models range=${range} 重试后仍失败：${lastErr} —— 该窗口明细将缺失`)
  return []
}

async function scrape(cookie: string, orgId: string): Promise<ConsoleDetails | null> {
  if (!cookie || !orgId) return null
  const out: ConsoleDetails = {}
  // 串行，见 fetchRange 的注释
  out.weekly = await fetchRange(cookie, orgId, MODELS_RANGES.weekly)
  out.monthly = await fetchRange(cookie, orgId, MODELS_RANGES.monthly)
  debugLog(
    `scrape 完成: weekly=${out.weekly.length} monthly=${out.monthly.length}` +
      (out.weekly.length && out.monthly.length ? '' : ' ← 有窗口缺失，看上面的失败日志')
  )
  if (!out.weekly.length) delete out.weekly
  if (!out.monthly.length) delete out.monthly
  return out
}

/**
 * 读控制台每模型明细（按 workspace+会话缓存）。
 *
 * **非阻塞**：命中缓存直接返回；未命中/过期时触发后台刷新并立即返回旧值（或 null）。
 */
export function fetchConsoleDetails(workspaceId: string, cookie: string): ConsoleDetails | null {
  if (!workspaceId || !cookie) return null
  const key = cacheKey(workspaceId, cookie)
  const hit = cache.get(key)
  const fresh = hit && Date.now() - hit.at < CACHE_TTL_MS
  debugLog(
    `fetch wid=${workspaceId.slice(0, 8)} hit=${hit ? Object.entries(hit.data).map(([k, v]) => `${k}=${v.length}`).join(',') || '空' : 'none'} fresh=${!!fresh} inflight=${inflight.has(key)}`
  )
  if (!fresh && !inflight.has(key)) {
    const task = scrape(cookie, workspaceId)
      .then((data) => {
        if (data) cache.set(key, { at: Date.now(), data })
        return data
      })
      .finally(() => {
        inflight.delete(key)
      })
    inflight.set(key, task)
  }
  return hit?.data ?? null
}

/** 显式抓取一次并写入缓存（预热/诊断用，不用于采集路径） */
export async function fetchConsoleDetailsNow(
  workspaceId: string,
  cookie: string
): Promise<ConsoleDetails | null> {
  if (!workspaceId || !cookie) return null
  const data = await scrape(cookie, workspaceId)
  if (data) cache.set(cacheKey(workspaceId, cookie), { at: Date.now(), data })
  return data
}

/** 清除缓存（凭据变更后调用）。在途请求也一并丢弃，不让旧 cookie 的结果回填。 */
export function invalidateConsoleDetails(): void {
  cache.clear()
  inflight.clear()
}
