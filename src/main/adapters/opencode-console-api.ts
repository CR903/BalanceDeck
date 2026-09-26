// ═══════════════════════════════════════════════════════════════════════════════
// 新版 opencode 控制台的端点与请求头 —— **唯一来源**
//
// 背景（2026-09-26 实测）：控制台已重写为纯客户端 SPA，旧的
//   `GET /workspace/<wrk>/go` → 302 `/console/login`，页面只剩 1565 字符空壳、
//   0 个 `data-slot`。靠解析 SSR HTML 的 `data-slot="usage-item"` 拿用量的路子
//   （`opencode-cookie.ts`）和靠驱动窗口点「显示详情」的路子（`opencode-details.ts`）
//   同时失效 —— 后者的注释曾论证"驱动 DOM 比逆向 RPC 鲁棒"，这次改版把它证伪了：
//   改版把 DOM 一起换了，而数据 API 反倒在公开 bundle 里声明并标了 stable。
//
// 端点来自 SPA 的公开 bundle（`/console/assets/index-*.js`，无需登录即可取）里的
// Effect HttpApi 声明，每个操作都带 OpenAPI 描述：
//   class usage extends HttpApi("usage")
//     .add("summary",     "/summary",     …)
//     .add("cost-by-day", "/cost-by-day", …)
//     .add("models",      "/models",      …)
//     .add("users",       "/users",       …)
//     .prefix("/api/usage")
// 站点改版时重挖：`node scripts/probe-spa-bundle.mjs`
//
// ⚠️ 现有 `auth` cookie **不被新控制台接受**（`GET /console/auth/session` → 401），
//    必须重新走 `LOGIN_URL` 授权。这是 `opencode-auth.ts` 存在的原因。
// ═══════════════════════════════════════════════════════════════════════════════

/** 控制台站点根 */
export const CONSOLE_ORIGIN = 'https://opencode.ai/console'

/** 登录页（旧的 `https://opencode.ai/auth` 现在只是 302 到这里） */
export const LOGIN_PATH = '/login'

/** 列出当前用户所属的 org/workspace —— workspace 发现的兜底来源 */
export const ORGS_PATH = '/api/orgs'

/** 窗口汇总：5 小时 / 周 / 月 的百分比与重置时间 */
export const USAGE_SUMMARY_PATH = '/api/usage/summary'

/** 每模型用量明细（`range` 取自 bundle 声明的枚举 `24h | 7d | 30d`） */
export const USAGE_MODELS_PATH = '/api/usage/models'

/** 明细默认时间范围。旧控制台的明细表按「每月配额」组织，30d 最接近原口径。 */
export const MODELS_RANGE = '30d'

/**
 * 组织/工作区 id 通过**请求头**传递，不是路径段
 * （bundle 里 `Pg="x-org-id"`，且它在 CORS 允许头白名单里）。
 */
export const ORG_ID_HEADER = 'x-org-id'

/**
 * 合法 id 前缀：`/^(org_|wrk_)/`。
 * 控制台正把 workspace 改名叫 org，两种前缀并存 —— 新站可能发 `org_`，
 * 老 workspace 仍是 `wrk_`，所以两种都要认。
 */
export const ORG_ID_RE = /(?:org_|wrk_)[A-Za-z0-9_-]{8,}/

/** 抓 cookie 时按 id 形状取出 workspace id（页面 URL / HTML / API 响应通用） */
export function findOrgId(text: string): string | null {
  const m = text.match(ORG_ID_RE)
  return m ? m[0] : null
}

/**
 * 拼控制台请求头。
 *
 * `x-org-id` 只在有 id 时给 —— 端点里有「不带 org 也能列」的（如 `/api/orgs`），
 * 也有「必须带 org 才能定位数据」的（如 `/api/usage/*`），别无脑附带。
 */
export function buildConsoleHeaders(
  cookie: string,
  orgId?: string | null,
  accept = 'application/json'
): Record<string, string> {
  const headers: Record<string, string> = { Cookie: cookie, Accept: accept }
  if (orgId) headers[ORG_ID_HEADER] = orgId
  return headers
}

/** 401 = 会话无效/过期（要用户重新授权）；403 = 有会话但无权限。两者提示语不同。 */
export type ConsoleAuthFailure = 'unauthorized' | 'forbidden' | null

export function classifyConsoleStatus(status: number): ConsoleAuthFailure {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  return null
}

/** 把 401/403 转成**可操作**的中文提示。
 *  旧文案是笼统的「cookie 已过期或无效」，用户看不出该做什么 —— 站点改版后
 *  更要把"要你去点一次授权"和"这条路暂时不通"分开。 */
export function consoleAuthMessage(kind: ConsoleAuthFailure): string | null {
  if (kind === 'unauthorized') {
    return '控制台会话无效：控制台已改版，需重新点「一键授权」登录 opencode.ai/console'
  }
  if (kind === 'forbidden') return '控制台会话有效但无权访问该工作区'
  return null
}
