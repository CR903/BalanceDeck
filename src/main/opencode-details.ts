import { BrowserWindow, session } from 'electron'
import type { UsageWindowKind } from './adapters/opencode-cookie'

// ═══════════════════════════════════════════════════════════════════════════════
// 控制台「每模型用量明细」抓取
//
// 背景：控制台用量页的每个窗口都有「显示详情」，展开后是一张
//   模型 | 每月用量(US$) | 每月配额(US$) | %
// 表。该表**不在 SSR HTML 里**，是点击后由客户端 RPC（SolidStart server function，
// 自定义 seroval 编码）拉取的。与其逆向其私有 RPC 协议，不如直接驱动一个隐藏窗口
// 完成「点击展开 → 读取 DOM」—— 这正是用户手动做的事，对站点改版更鲁棒。
//
// 复用授权分区（persist:opencode-auth），因此无需再登录。
// 结果按 workspace 缓存（明细变化慢，避免频繁开窗）。
// ═══════════════════════════════════════════════════════════════════════════════

const PARTITION = 'persist:opencode-auth'
const CACHE_TTL_MS = 5 * 60_000
const LOAD_TIMEOUT_MS = 25_000

export interface ConsoleModelRow {
  model: string
  /** 该窗口内已用金额（USD） */
  usageUsd: number
  /** 该模型的配额（USD） */
  quotaUsd: number
  /** 官方百分比 */
  percent: number
}

export type ConsoleDetails = Partial<Record<UsageWindowKind, ConsoleModelRow[]>>

interface CacheEntry {
  at: number
  data: ConsoleDetails
}

const cache = new Map<string, CacheEntry>()
let inflight: Promise<ConsoleDetails | null> | null = null

/**
 * 页面内执行的抓取脚本：逐个展开「显示详情」并读取表格。
 *
 * 三个关键点（逐一实测踩坑）：
 *  1. 三个窗口共享一个 expanded 状态 → 必须逐个展开。
 *  2. 展开后的 `usage-details-content` 渲染在**根级**（不在 usage-item 内），
 *     所以要在 document 上取；用表头文字（含"每月用量"等）确认归属。
 *  3. 水合前点击会被丢弃 → 先留出稳定期，且点击后轮询确认。
 *  4. 窗口标签里的空格可能是 NBSP → 用 \\s 匹配而非普通空格。
 */
const EXTRACT_JS = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && !document.querySelector('[data-slot="usage-details-trigger"]'); i++) await sleep(250);
  await sleep(3000);

  const MATCH = {
    rolling: /rolling|滚动|5\\s*-?\\s*hour|5\\s*小时/i,
    weekly: /weekly|每周/i,
    monthly: /monthly|每月/i
  };
  const kindOf = (label) => {
    const l = label || '';
    if (MATCH.rolling.test(l)) return 'rolling';
    if (MATCH.weekly.test(l)) return 'weekly';
    if (MATCH.monthly.test(l)) return 'monthly';
    return null;
  };
  const itemsOf = () => [...document.querySelectorAll('[data-slot="usage-item"]')];
  const itemFor = (kind) => itemsOf().find((it) => kindOf(it.querySelector('[data-slot="usage-label"]')?.textContent) === kind);

  const readRows = (content) => {
    const out = [];
    for (const tr of content.querySelectorAll('tbody tr')) {
      if (tr.getAttribute('data-slot') === 'usage-total') continue;
      const tds = [...tr.querySelectorAll('td')].map((td) => td.textContent.trim());
      if (tds.length < 4) continue;
      out.push({ model: tds[0], usage: tds[1], quota: tds[2], percent: tds[3] });
    }
    return out;
  };

  const out = {};
  for (const kind of ['rolling', 'weekly', 'monthly']) {
    const item = itemFor(kind);
    if (!item) continue;

    // 点一次即止（重复点会收起）
    item.querySelector('[data-slot="usage-details-trigger"]')?.click();

    // 等根级内容出现，且表头匹配当前窗口
    let rows = [];
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      const content = document.querySelector('[data-slot="usage-details-content"]');
      if (!content) continue;
      const header = content.querySelector('thead')?.textContent || '';
      if (!MATCH[kind].test(header)) continue;
      rows = readRows(content);
      if (rows.length) break;
    }
    out[kind] = rows;
  }
  return out;
})()`

/** 解析 "US$8.7316" / "29.1%" 之类的展示文本 */
function parseMoney(text: string | undefined): number {
  if (!text) return 0
  const m = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
  return m ? Number(m[0]) : 0
}

function parsePercentText(text: string | undefined): number {
  if (!text) return 0
  const m = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
  return m ? Number(m[0]) : 0
}

/** 抓取一次明细（不带缓存） */
async function scrape(workspaceId: string): Promise<ConsoleDetails | null> {
  const ses = session.fromPartition(PARTITION)
  const cookies = (await ses.cookies.get({ domain: 'opencode.ai' })).filter(
    (c) => (c.domain || '').replace(/^\./, '') === 'opencode.ai' && c.value
  )
  if (!cookies.some((c) => c.name === 'auth')) return null

  let win: BrowserWindow | null = null
  try {
    win = new BrowserWindow({
      show: false,
      width: 1100,
      height: 900,
      webPreferences: { partition: PARTITION, nodeIntegration: false, contextIsolation: true, offscreen: true }
    })
    const url = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`
    const loaded = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), LOAD_TIMEOUT_MS)
      win!.webContents.once('did-finish-load', () => {
        clearTimeout(timer)
        resolve(true)
      })
      win!.webContents.once('did-fail-load', () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
    void win.loadURL(url)
    if (!(await loaded)) return null

    const raw = (await win.webContents.executeJavaScript(EXTRACT_JS, true)) as
      | (Record<string, { model: string; usage: string; quota: string; percent: string }[]> & { error?: string })
      | null
    if (!raw || raw.error) return null

    const out: ConsoleDetails = {}
    for (const kind of ['rolling', 'weekly', 'monthly'] as UsageWindowKind[]) {
      const rows = raw[kind]
      if (!Array.isArray(rows)) continue
      out[kind] = rows
        .map((r) => ({
          model: (r.model || '').trim(),
          usageUsd: parseMoney(r.usage),
          quotaUsd: parseMoney(r.quota),
          percent: parsePercentText(r.percent)
        }))
        .filter((r) => r.model)
    }
    return out
  } catch {
    return null
  } finally {
    try {
      if (win && !win.isDestroyed()) win.destroy()
    } catch {
      // 忽略
    }
  }
}

/**
 * 读取控制台每模型明细。
 *
 * **非阻塞**：命中缓存直接返回；未命中/过期时触发后台刷新并立即返回旧值（或 null）。
 * 原因：抓取需要开隐藏窗口 + 页面水合 + 点击展开，耗时 5–15s；
 * 若同步等待会拖慢首屏，甚至让整个采集周期超时。
 * 下一轮采集（60s 后）即可拿到后台刷新的结果。
 */
export function fetchConsoleDetails(workspaceId: string): ConsoleDetails | null {
  if (!workspaceId) return null
  const hit = cache.get(workspaceId)
  const fresh = hit && Date.now() - hit.at < CACHE_TTL_MS
  if (process.env.BALANCEDECK_DEBUG) {
    void import('fs').then(({ appendFileSync }) =>
      appendFileSync('/tmp/balancedeck-details.log', `fetch wid=${workspaceId.slice(0, 8)} hit=${hit ? (hit.data.monthly?.length ?? 0) : 'none'} fresh=${!!fresh} inflight=${!!inflight}\n`)
    )
  }
  if (!fresh && !inflight) {
    inflight = scrape(workspaceId)
      .then((data) => {
        if (process.env.BALANCEDECK_DEBUG) {
          void import('fs').then(({ appendFileSync }) =>
            appendFileSync('/tmp/balancedeck-details.log', `scrape done: ${data ? Object.entries(data).map(([k, v]) => `${k}=${v.length}`).join(',') : 'null'}\n`)
          )
        }
        if (data) cache.set(workspaceId, { at: Date.now(), data })
        return data
      })
      .catch((e) => {
        if (process.env.BALANCEDECK_DEBUG) {
          void import('fs').then(({ appendFileSync }) =>
            appendFileSync('/tmp/balancedeck-details.log', `scrape error: ${(e as Error).message}\n`)
          )
        }
        return null
      })
      .finally(() => {
        inflight = null
      })
  }
  return hit?.data ?? null
}

/** 显式抓取一次并写入缓存（预热/诊断用，不用于采集路径） */
export async function fetchConsoleDetailsNow(workspaceId: string): Promise<ConsoleDetails | null> {
  if (!workspaceId) return null
  const data = await scrape(workspaceId)
  if (data) cache.set(workspaceId, { at: Date.now(), data })
  return data
}

/** 清除缓存（凭据变更后调用） */
export function invalidateConsoleDetails(): void {
  cache.clear()
}
