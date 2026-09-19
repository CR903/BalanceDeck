import type { ProviderAdapter, CollectContext } from './types'
import { errSnap, identityOf } from './engine'
import type { ProviderSnapshot } from '../../shared/types'

// ═══════════════════════════════════════════════════════════════════════════════
// 并行采集：纯扇出 + 失败隔离
//
// 刻意与 ./index 分开 —— index 还 import ../providers（→ keystore → electron），
// 而这里只依赖接缝声明与引擎，因此可以在纯 node 里被单元测试加载
// （回归覆盖见 scripts/test-adapters.mjs 的 S 节）。
//
// 这里**不再重盖任何字段**：身份与来路都由适配器自己声明（铸造必填，ADR-0001/0002）——
// 声明式协议由协议工厂盖章，代码适配器由实例绑定层（./bind-instance）盖章。
// 扇出只负责「都跑一遍、谁挂了兜成错误快照」，不再替别人补身份。
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 并行采集全部适配器。
 * 单个供应商失败不影响其他（各自 catch 成 error 快照）。
 * 并行是必须的：用户可把刷新频率调到 10s，串行会被慢接口拖垮。
 */
export async function collectAll(
  adapters: ProviderAdapter[],
  ctx: CollectContext
): Promise<ProviderSnapshot[]> {
  return Promise.all(
    adapters.map(async (a): Promise<ProviderSnapshot> => {
      try {
        return await a.collect(ctx)
      } catch (e) {
        // a 已是绑定过实例身份的适配器（工厂产物或实例绑定产物），直接取它的身份
        return errSnap(identityOf(a), (e as Error).message, ctx)
      }
    })
  )
}
