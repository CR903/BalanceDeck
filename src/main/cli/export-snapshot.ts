import { windowPercent } from '../../shared/percent'
import type { AppState, ProviderWindow } from '../../shared/types'

// ═══════════════════════════════════════════════════════════════════════════════
// CLI 导出契约（纯逻辑，**不依赖 electron**）
//
// 这份 JSON 是给**外部脚本**看的（tmux 状态栏 / iStat / 终端提示词）。契约的双方是
// 「常驻进程 ↔ 外部脚本」，渲染层永远看不到它 —— 所以契约放 src/main/cli/ 而不是
// src/shared/（后者是主进程 ↔ 渲染层的契约层，`directory-structure.md` 已如此定位）。
//
// 三条纪律：
//   1. **只导结构化字段。** source / detail / failureReason / models 一律不导 ——
//      `source` 里带着 API key 的尾 4 位（opencode.ts 的 keyTag 拼进去的），而
//      `detail` / `failureReason` 是可能含响应体预览与 GitHub 用户名的自由文案。
//      stdout 会进 tmux 配置、shell history、日志、截图，传播面比屏幕大得多。
//      这不是「暂时没做」，是**契约层面不导**：将来加字段要重新过一次隐私评估。
//   2. **缺失值保持缺失。** limit / percent / resetAt 的 null 就是 null，绝不填 0
//      （CONTEXT.md 诚实原则 / ADR-0002）。脚本拿到 0 会以为「一点没用」。
//   3. **dataQuality 是搬运不是判断。** 它由 adapters/engine 在铸造快照时盖章，
//      导出层不许自己推导一版第二判断。
//
// buildSnapshot 不读自己的钟（now 一律由调用方传入），因此可被
// scripts/test-cli-export.mjs 经 loadTs 在纯 node 里加载并直接单测。
// ═══════════════════════════════════════════════════════════════════════════════

/** 导出格式版本。外部脚本会长期依赖这份 JSON，带版本号才能判「我认识它吗」 */
export const EXPORT_SCHEMA_VERSION = 1

/** 落盘文件名（常驻进程写、CLI 读，同一个文件）。落在 userData 下，**不走 extras** */
export const EXPORT_FILE_NAME = 'balance-export.json'

export interface ExportWindow {
  name: string
  used: number
  /** 限额未知 = null（余额类供应商），**不是 0** */
  limit: number | null
  unit: string
  /** 不可知 = null（percent.ts 要求 limit > 0 才能推算），**不是 0** */
  percent: number | null
  /** 供应商没给重置时间 = null，**不是空串** */
  resetAt: string | null
}

export interface ExportProvider {
  id: string
  name: string
  kind: string
  status: string
  /** 结构化枚举 'official' | 'cached' | 'local'；缺省按 official 处理 */
  dataQuality: string
  updatedAt: string
  windows: ExportWindow[]
}

export interface ExportSnapshot {
  schemaVersion: number
  generatedAt: string
  offline: boolean
  providers: ExportProvider[]
}

// ⚠ 刻意**不含**：source / detail / failureReason / degradedReason /
//   models / modelsByWindow / mark / plan（见上方纪律 1）

/** 一条 ISO 时刻的规范化：脏值落成空串，不去猜、不造时间 */
function isoOrEmpty(v: string | undefined): string {
  return typeof v === 'string' ? v : ''
}

/** 一个窗口的对外形状。只搬结构化字段，note / tokens 不导（自由文案与明细） */
function toExportWindow(w: ProviderWindow): ExportWindow {
  return {
    name: w.name,
    used: w.used,
    // ⚠ 0 也是「限额未知」的一种写法（types.ts:18），所以判据是有限数而不是 truthy
    limit: typeof w.limit === 'number' && Number.isFinite(w.limit) ? w.limit : null,
    unit: w.unit,
    // percent 必须走 windowPercent：官方常常不给 w.percent，此时要回退 used/limit，
    // 且不可知时返回 null —— 直接透传 w.percent 会在两种情况下都给出错误的数
    percent: windowPercent(w),
    resetAt: typeof w.resetAt === 'string' && w.resetAt ? w.resetAt : null
  }
}

/**
 * AppState → 导出快照。**纯函数**：不改入参、不读自己的钟、不碰 electron。
 * 空快照（应用刚启动还没采完）是合法输入，导出 providers: [] 与退出码 0。
 */
export function buildSnapshot(state: AppState, now: number): ExportSnapshot {
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    // AppState.offline 缺省即 false（types.ts:151）。不自己重算 —— net.ts 的 isOffline
    // 有「连续 2 次网络错误」阈值语义，在 CLI 的短生命周期里重算必然得到不同答案
    offline: state?.offline === true,
    providers: (state?.snapshots ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      status: s.status,
      // types.ts:77「缺省 official」；quality.ts:43 也用同一个回落口径
      dataQuality: s.dataQuality ?? 'official',
      updatedAt: isoOrEmpty(s.updatedAt),
      windows: (s.windows ?? []).map(toExportWindow)
    }))
  }
}