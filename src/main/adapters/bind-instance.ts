import type { ProviderAdapter, CollectContext } from './types'
import type { ProviderInstance, ProviderSnapshot } from '../../shared/types'
import { identityOf, type Identity } from './engine'

// ═══════════════════════════════════════════════════════════════════════════════
// 实例绑定：把「代码实现的基础适配器」绑定到某个供应商实例
//
// 代码适配器（opencode / claude / codex / copilot / minimax / qwen / volc）的基座只知道
// 自己的协议 id，不知道用户添加的是哪一条实例。这里补上三件事：
//   1. 凭据查找从「基座固定 id」重定向到「实例 id」（同一预设可多实例，各自 key）
//   2. Base URL 覆盖读取实例配置
//   3. 快照身份换成实例身份（id/name/kind/builtin/mark）—— 铸造要求的身份必须为真，
//      所以这一步在**快照**上重盖，而不只是在适配器字段上
//
// 单独成模块而不是留在 ./index：index 还要 import ../providers（→ electron），
// 而这里只依赖接缝声明与引擎 —— 于是实例绑定也能进单元测试（黄金样本 N 节）。
// ═══════════════════════════════════════════════════════════════════════════════

export function bindInstance(base: ProviderAdapter, inst: ProviderInstance): ProviderAdapter {
  const baseId = base.id
  const identity: Identity = {
    id: inst.id,
    name: inst.name,
    kind: inst.kind,
    builtin: inst.builtin,
    // 图标 key：内置用预设 id，自定义用协议 id
    mark: inst.presetId || inst.protocol
  }

  return {
    ...identity,

    async collect(ctx: CollectContext): Promise<ProviderSnapshot> {
      const scoped: CollectContext = {
        now: ctx.now,
        // 出网能力原样透传：绑定实例身份不该碰「怎么出网」
        request: ctx.request,
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
        },
        // setKey 必须透传：cookie 自愈（opencode.ts 里服务端轮换后静默回写）靠它。
        // 旧实现漏了这一项，于是自愈代码在任何代码适配器上都不执行。
        setKey: ctx.setKey
      }
      const s = await base.collect(scoped)
      // 身份以实例为准（基座不知道用户加的是哪一条实例）
      return { ...s, ...identityOf(identity) }
    }
  }
}
