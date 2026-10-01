import type { ProviderSnapshot, ProviderWindow, ProviderKind, Unit } from '../../shared/types'

// ═══════════════════════════════════════════════════════════════════════════════
// 采集接缝的**声明**部分：协议实现者能看到与必须提供的东西。
//
// 这个模块刻意不 import electron，也不 import net.ts —— 出网是注入的能力
// （见下面的 CollectRequest / CollectContext.request）。共享实现放在 ./engine。
// ═══════════════════════════════════════════════════════════════════════════════

/** 一次出网请求（引擎与各适配器只描述「要什么」，怎么做由上下文决定） */
export interface CollectRequest {
  url: string
  headers: Record<string, string>
  /** 超时毫秒；缺省 12s */
  timeoutMs?: number
  /** HTTP 方法；缺省 'GET'（不传与改动前逐字相同） */
  method?: 'GET' | 'POST'
  /**
   * 请求体 —— **已序列化**的字符串，接缝不决定序列化方式。
   *
   * 为什么是字符串而不是对象：同一个供应商的不同端点要不同的编码
   * （Gemini 的 token 刷新端点是 form-encoded，配额端点是 JSON）。
   * 若接缝自作聪明地 `JSON.stringify`，form 请求会被静默改成 JSON →
   * 服务端 400 → 适配器报「解析失败」，病因与症状隔了三层。序列化归调用方。
   *
   * 同理 Content-Type 归调用方：实现只在「有 body 且调用方未带 Content-Type」时
   * 补 `application/json`；自带就原样用（form-encoded 端点自己会带）。
   */
  body?: string
}

/** 出网结果：只保证原始文本，JSON 解析是引擎的便利（见 engine.readJson） */
export interface CollectResponse {
  status: number
  text: string
}

export interface CollectContext {
  now: Date
  /** 读取凭据（密钥链 → 环境变量回退），无凭据返回 null */
  getKey(providerId: string): Promise<string | null>
  getExtra(key: string): Promise<string | null>
  /** 回写凭据（仅用于自愈场景，如 cookie 被服务端轮换后静默更新） */
  setKey?(providerId: string, value: string): Promise<void>
  /**
   * 出网能力。生产实现见 src/main/request.ts（fetch + 超时 + 可达性记账），
   * 测试注入桩，因此适配器可以在纯 node 里跑完整链路。
   */
  request(req: CollectRequest): Promise<CollectResponse>
}

export interface ProviderAdapter {
  id: string
  name: string
  /** balance=直连余额 coding/token=套餐用量 */
  kind: ProviderKind
  /** 是否内置预设实例（UI 显示徽章用） */
  builtin: boolean
  /** 供应商图标 id（内置预设 id / 协议 id），卡片与托盘据此显示 logo */
  mark?: string
  collect(ctx: CollectContext): Promise<ProviderSnapshot>
}

export function fmtMoney(v: number, unit: Unit): string {
  const s = v >= 100 ? v.toFixed(0) : v.toFixed(2)
  return unit === 'cny' ? `¥${s}` : `$${s}`
}

/** 余额类通用窗口：单条"账户余额"窗口（limit 未知，仅展示金额） */
export function balanceWindow(amount: number, unit: Unit, note?: string): ProviderWindow {
  return { name: '账户余额', used: amount, unit, note }
}
