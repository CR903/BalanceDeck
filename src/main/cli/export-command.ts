import { existsSync, readFileSync, writeFileSync } from 'fs'
import { formatPercent } from '../../shared/percent'
import { staleLabel } from '../../shared/quality'
import { EXPORT_SCHEMA_VERSION, type ExportSnapshot, type ExportWindow } from './export-snapshot'

// ═══════════════════════════════════════════════════════════════════════════════
// `export` 子命令：参数解析 / 人类可读表格 / 读快照并渲染（纯逻辑，**不依赖 electron**）
//
// 与 export-snapshot.ts 的分工：那份是**契约**（AppState → JSON），这份是**通道**
// （argv → 文件 → stdout）。两者共用同一份数据，渲染方式不同而已。
//
// 装配（userData 路径、stdout、退出码）在 index.ts —— 与 store.ts/keystore.ts
// 同一形状：纯逻辑能被 loadTs 在纯 node 里加载，装配层才碰平台。
//
// ⚠ 本模块**不 import electron、不 import keystore**：CLI 绝不能碰凭据
//   （scripts/test-cli-export.mjs 有静态守卫钉着这条）。
// ═══════════════════════════════════════════════════════════════════════════════

/** 退出码语义：告诉脚本「发生了什么」，而不是让它猜 */
export const EXIT_OK = 0
export const EXIT_USAGE = 1
export const EXIT_NO_DATA = 2

export const USAGE = `用法：BalanceDeck export [--json] [--out <path>]

  --json       输出 JSON 到 stdout（供 tmux / 终端提示词等脚本消费）
  --out PATH   写到文件而不是 stdout
  （无参数）    人类可读的表格

数据来自常驻进程最近一次采集写下的快照文件 —— 本命令**不出网、不改任何状态**，
因此第一次使用前需要先启动一次 BalanceDeck。

退出码：0 成功 / 1 参数非法或写文件失败 / 2 没有导出文件或格式不认识`

export interface ExportArgs {
  json: boolean
  out: string | null
  /** 第一个非选项参数；非 null 时是未知命令 → 退出码 1（**不猜**用户想干什么） */
  unknown: string | null
  /** 参数缺值（`--out` 后面没有路径）→ 退出码 1 */
  missingValue: boolean
}

/**
 * 解析 `export` 子命令的参数。
 *
 * ⚠ 入参**必须已 slice 掉可执行文件、app 路径与子命令名**（开发态
 * `process.argv.slice(2)`，打包态 `slice(1)`；开发态 argv = `[electronBin, '.', 'export', …]`）。
 * 本仓既有的 `--smoke` 之类用的是 `includes`（不依赖偏移量）才躲过了这个坑，
 * 而子命令名 `export` 是位置敏感的，必须显式切片。
 */
export function parseExportArgs(argv: string[]): ExportArgs {
  let json = false
  let out: string | null = null
  let unknown: string | null = null
  let missingValue = false
  const args = Array.isArray(argv) ? argv : []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--json') {
      json = true
      continue
    }
    if (a === '--out') {
      const v = args[i + 1]
      // 下一个 token 是选项或根本不存在 = 缺值。不静默把下一个选项当路径吃掉
      if (typeof v !== 'string' || v.startsWith('-')) {
        missingValue = true
        continue
      }
      out = v
      i++
      continue
    }
    if (unknown === null) unknown = a
  }
  return { json, out, unknown, missingValue }
}

// ─── 人类可读表格 ───────────────────────────────────────────────────────────

/**
 * 百分比不可知时给绝对用量。
 *
 * ⚠ 刻意**不复用** `shared/tray-text.ts` 的 `compactAmount`：那是为了 1 行状态栏
 * 写的紧凑写法（k/M 缩写），CLI 表格有整行宽度，宁可给全精度。两者共用
 * `formatPercent` / `windowPercent`（百分比只有一个实现）。
 */
function amount(w: ExportWindow): string {
  const v = typeof w.used === 'number' && Number.isFinite(w.used) ? w.used : 0
  if (w.unit === 'usd') return `$${v.toFixed(2)}`
  if (w.unit === 'cny') return `¥${v.toFixed(2)}`
  if (w.unit === 'token') return `${Math.round(v)} tokens`
  if (w.unit === 'request') return `${Math.round(v)} 次`
  if (w.unit === 'percent') return formatPercent(v)
  return String(v)
}

/** 一个窗口的一行：百分比优先，不可知时给绝对用量（缺失值显示 —，不是 0%） */
function windowLine(w: ExportWindow): string {
  return w.percent != null ? `${w.name} ${formatPercent(w.percent)}` : `${w.name} ${amount(w)}`
}

/** 表格渲染：每家一行，含窗口百分比 + 可信度标注。cached / local 必须看得见 */
export function renderTable(snap: ExportSnapshot): string {
  const lines: string[] = []
  const head = `BalanceDeck 导出 · ${snap.generatedAt} · ${snap.offline ? '离线' : '在线'} · 格式 v${snap.schemaVersion}`
  lines.push(head)

  const providers = Array.isArray(snap.providers) ? snap.providers : []
  if (providers.length === 0) {
    lines.push('')
    lines.push('  （暂无数据：应用可能刚启动还没采完，或还没配置任何供应商）')
    return lines.join('\n')
  }

  const nameW = Math.max(...providers.map((p) => String(p.name ?? '').length))
  const kindW = Math.max(...providers.map((p) => String(p.kind ?? '').length))
  for (const p of providers) {
    const windows = (Array.isArray(p.windows) ? p.windows : []).map(windowLine).join('  ·  ')
    const q = staleLabel({ dataQuality: p.dataQuality })
    const status = p.status && p.status !== 'ok' ? `（状态 ${p.status}）` : ''
    const name = String(p.name ?? '').padEnd(nameW)
    const kind = String(p.kind ?? '').padEnd(kindW)
    lines.push(`  ${name}  ${kind}  ${windows}${status}${q ? `  [${q}]` : ''}`.trimEnd())
  }
  return lines.join('\n')
}

// ─── 读快照 + 渲染 ──────────────────────────────────────────────────────────

export type ParsedExport = { ok: true; snap: ExportSnapshot } | { ok: false; reason: string }

/**
 * 校验并解析导出文件内容。
 *
 * 「格式不认识」是一条**明确状态**而不是解析崩溃：外部脚本会长期依赖这份 JSON，
 * 遇到未来的 schemaVersion 时要能说清「我认识吗」，而不是崩在半路。
 */
export function parseExportedSnapshot(raw: string): ParsedExport {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return { ok: false, reason: '不是合法 JSON' }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, reason: '顶层不是对象' }
  const o = v as Record<string, unknown>
  if (o.schemaVersion !== EXPORT_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `schemaVersion=${JSON.stringify(o.schemaVersion ?? null)}（本机只认 ${EXPORT_SCHEMA_VERSION}）`
    }
  }
  if (!Array.isArray(o.providers)) return { ok: false, reason: 'providers 不是数组' }
  const bad = o.providers.findIndex((x) => !x || typeof x !== 'object' || Array.isArray(x))
  if (bad >= 0) return { ok: false, reason: `providers[${bad}] 不是对象` }
  return { ok: true, snap: o as unknown as ExportSnapshot }
}

export interface ExportRunOptions {
  /** 参数**不含**子命令名与可执行文件（见 parseExportArgs 的说明） */
  argv: string[]
  /** 导出文件路径（惰性求值，与 usage-history.ts 同一形状） */
  filePath: () => string
  now: number
}

export interface ExportRunResult {
  code: number
  /** stdout 文本（含结尾换行）；`--out` 档为空串 —— 脚本可以安静地重定向 */
  out: string
  /** stderr 文本（用法 / 失败原因） */
  err: string
}

/**
 * 跑一次 `export`。**不抛异常**：所有失败都变成退出码 + 一句人话，
 * 抛栈对脚本没用（tmux 状态栏里没人能看栈）。
 */
export function runExportCommand(opts: ExportRunOptions): ExportRunResult {
  const args = parseExportArgs(opts.argv)
  if (args.unknown !== null) {
    return { code: EXIT_USAGE, out: '', err: `不认识的参数：${args.unknown}\n\n${USAGE}` }
  }
  if (args.missingValue) {
    return { code: EXIT_USAGE, out: '', err: `--out 后面缺少文件路径\n\n${USAGE}` }
  }

  const file = opts.filePath()
  let raw: string
  try {
    if (!existsSync(file)) {
      return {
        code: EXIT_NO_DATA,
        out: '',
        err: `还没有导出文件（${file}）。\n请先启动一次 BalanceDeck —— 它采集之后会写出一份快照，本命令只读它。`
      }
    }
    raw = readFileSync(file, 'utf-8')
  } catch (e) {
    return { code: EXIT_NO_DATA, out: '', err: `读不到导出文件（${file}）：${(e as Error).message}` }
  }

  const parsed = parseExportedSnapshot(raw)
  if (!parsed.ok) {
    return {
      code: EXIT_NO_DATA,
      out: '',
      err: `导出文件格式不认识（${file}）：${parsed.reason}。\n升级 BalanceDeck 后重试。`
    }
  }

  // 空快照（应用刚启动还没采完）是**有效状态**：providers: [] + 退出码 0，不该报错
  const text = args.json ? JSON.stringify(parsed.snap, null, 2) : renderTable(parsed.snap)
  if (args.out === null) return { code: EXIT_OK, out: `${text}\n`, err: '' }

  try {
    // 不 mkdir -p：静默创建目录树是意外行为，写不了就报错退出。
    // ⚠ 用户**显式**要求写文件时失败必须让用户知道 —— 这与「常驻进程周期写失败
    //   只记日志」不矛盾：那一条说的是不该让采集跟着坏
    writeFileSync(args.out, `${text}\n`, 'utf-8')
  } catch (e) {
    return { code: EXIT_USAGE, out: '', err: `写不进 ${args.out}：${(e as Error).message}` }
  }
  return { code: EXIT_OK, out: '', err: '' }
}