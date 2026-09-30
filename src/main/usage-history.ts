import { app } from 'electron'
import { join } from 'path'
import { createUsageStore } from './usageStore'

// ═══════════════════════════════════════════════════════════════════════════════
// 用量历史快照的**生产装配**：文件路径在这里注入，electron 只出现在本文件
//
// 为什么单独一个装配层（与 keystore.ts 同一形状）：纯逻辑（格式 / 切天 / 裁剪 / 损坏重建）
// 都在 ./usageStore 里可被单元测试经 loadTs 加载，而 `app.getPath('userData')`
// 必须在 **app ready 之后**才拿得到 —— 静态导入先于模块体求值，提前算会把路径
// 钉在默认 userData 上，那在 --uitest / BD_USER_DATA 覆盖下就是错的位置。
// 所以这里用 `() => join(app.getPath('userData'), …)` 把求值推迟到真正用的时候。
// ═══════════════════════════════════════════════════════════════════════════════

export const usageHistoryStore = createUsageStore({
  filePath: () => join(app.getPath('userData'), 'usage-history.json')
})
