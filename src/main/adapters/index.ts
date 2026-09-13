import type { ProviderAdapter, CollectContext } from './types'
import type { ProviderSnapshot, ProviderInstance } from '../../shared/types'
import { listInstances } from '../providers'
import { opencodeAdapter } from './opencode'
import { deepseekAdapter } from './deepseek'
import { kimiAdapter } from './kimi'
import { zhipuAdapter } from './zhipu'
import { minimaxAdapter } from './minimax'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'
import { copilotAdapter } from './copilot'
import { siliconflowAdapter } from './siliconflow'
import { qwenAdapter } from './qwen'
import { volcAdapter } from './volc'
import { createCustomAdapter } from './custom'

/** 内置协议 → 适配器（基座，凭据按固定 id 读取，由 wrapForInstance 重定向到实例） */
export const BUILTIN_ADAPTERS: Record<string, ProviderAdapter> = {
  'opencode-go': opencodeAdapter,
  'claude-code': claudeAdapter,
  codex: codexAdapter,
  copilot: copilotAdapter,
  deepseek: deepseekAdapter,
  moonshot: kimiAdapter,
  zhipu: zhipuAdapter,
  minimax: minimaxAdapter,
  siliconflow: siliconflowAdapter,
  'qwen-bss': qwenAdapter,
  'volc-billing': volcAdapter
}

/**
 * 把内置基座适配器绑定到某个实例：
 *   - 凭据查找从「基座固定 id」重定向到「实例 id」（同一预设可多实例，各自 key）
 *   - baseUrl 覆盖读取实例配置
 *   - 快照 id/name 换成实例身份
 */
function wrapForInstance(base: ProviderAdapter, inst: ProviderInstance): ProviderAdapter {
  const baseId = base.id
  return {
    id: inst.id,
    name: inst.name,
    kind: inst.kind,
    builtin: inst.builtin,
    // 图标 key：内置用预设 id，自定义用协议 id
    mark: inst.presetId || inst.protocol,

    async collect(ctx: CollectContext): Promise<ProviderSnapshot> {
      const scoped: CollectContext = {
        now: ctx.now,
        getKey: async (id) => {
          // 基座请求自己的 id → 用实例凭据
          if (id === baseId) return ctx.getKey(inst.id)
          // OpenCode 多 Key 场景：实例 key 包装为单元素数组
          if (id === 'opencodeKeys') {
            const own = await ctx.getKey(inst.id)
            if (own) return JSON.stringify([own])
          }
          return ctx.getKey(id)
        },
        getExtra: async (k) => {
          // 基座读取 baseUrl:<baseId> → 实例覆盖优先
          if (k === `baseUrl:${baseId}`) {
            const override = await ctx.getExtra(`provider:${inst.id}:baseUrl`)
            if (override) return override
            if (inst.baseUrl && !inst.presetId) return inst.baseUrl
            return ctx.getExtra(k)
          }
          return ctx.getExtra(k)
        }
      }
      const s = await base.collect(scoped)
      return { ...s, id: inst.id, name: inst.name }
    }
  }
}

/**
 * 构建当前启用的适配器列表：按实例逐个生成。
 * 每轮采集动态求值，因此设置页的增删改即时生效。
 */
export async function buildAdapters(): Promise<ProviderAdapter[]> {
  const instances = await listInstances()
  const out: ProviderAdapter[] = []
  for (const inst of instances) {
    if (!inst.enabled) continue
    if (inst.builtin) {
      const base = BUILTIN_ADAPTERS[inst.protocol]
      if (base) {
        out.push(wrapForInstance(base, inst))
        continue
      }
    }
    out.push(createCustomAdapter(inst))
  }
  return out
}

/**
 * 并行采集全部适配器。
 * 单个供应商失败不影响其他（各自 catch 成 error 快照）。
 * 并行是必须的：用户可把刷新频率调到 10s，串行会被慢接口拖垮。
 */
export async function collectAll(adapters: ProviderAdapter[], ctx: CollectContext): Promise<ProviderSnapshot[]> {
  return Promise.all(
    adapters.map(async (a): Promise<ProviderSnapshot> => {
      try {
        const s = await a.collect(ctx)
        // 适配器元数据为准（snap() 的默认值仅为满足类型）
        return { ...s, kind: a.kind, builtin: a.builtin, mark: s.mark ?? a.mark }
      } catch (e) {
        return {
          id: a.id,
          name: a.name,
          kind: a.kind,
          builtin: a.builtin,
          mark: a.mark,
          status: 'error',
          detail: (e as Error).message,
          windows: [],
          dataAt: ctx.now.toISOString(),
          updatedAt: ctx.now.toISOString()
        }
      }
    })
  )
}
