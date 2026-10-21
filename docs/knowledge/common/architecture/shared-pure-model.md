# shared 纯函数层：单一真相源（common）

适用：新增/修改任何「两端都要用」的常量、换算、文案前先读。
核心观念：**凡是被两端消费的判断，只许在 shared 实现一份；测试不许内联副本。**

## 纯度约束

`src/shared/` 每个模块头部都写着**不 import electron / 不碰 DOM**（最典型 levels.ts:8-9）。这让它们可以被 node 直测：`scripts/lib/load-ts.mjs` 是把 TS 转成可加载模块的公共桩，测试通过它加载**真源码**。

## 单一真相源地图

| 模块 | 它是什么的唯一出处 | 有测试门钉住 |
|---|---|---|
| `levels.ts:14 levelOfPercent` | 阈值 **85% danger / 60% warn** 全仓唯一处（:17-18），注释明言「把判定搬回第二处即红」 | test-structure.mjs:1183/1192、test-tray.mjs:333/343 |
| `percent.ts windowPercent` | 百分比换算/格式化唯一实现（percent 优先 → used/limit 回退 → clamp 0-100） | test:percent |
| `water-color.ts` | 水体插值 + 皮肤锚点解析（CSS 变量名序列只在这） | test:fluid |
| `fluid.ts` / `dock-hide.ts` | 吸入/倒水时序、dock 吸附阈值与缓动唯一出处 | test:fluid / test:dock-hide（钉死几何只活在 island.css，test-fluid.mjs:71-76） |
| `tray-text.ts` | 托盘/卡片头部文案唯一拼装层（本身是 percent 的**消费方**，:2 导入 formatPercent） | test:tray |
| `pet-view.ts` | 宠物窗口几何尺寸唯一来源（main overlay 与 renderer 共用） | test:island-clip |
| `usage-predict.ts:114 PREDICT_KEYS` | 主进程写、渲染层读共用的采样键名 | — |
| `types.ts` | IPC 双端数据形状唯一契约（preload/index.ts:13-14 直接转发给 renderer） | — |
| `quality.ts applyCachePolicy` | 缓存策略与 official/local/cached 质量标注语义唯一处 | test:quality |

## 两个历史教训（别再犯）

1. **阈值曾经是渲染层私有事实**——`renderer/format.ts` 原来自持判据，主进程拿不到会「同一用量两个颜色（卡片橙、托盘绿）」；修复即搬进 shared/levels.ts，`format.ts` 变成**转发层**（format.ts:57 re-export，「转发折中」可保留但不得再实现逻辑）。
2. **测试内联副本漂移事故**——`scripts/test-percent.mjs:19-34` 是 shared/percent 的内联等价实现（注释自认"保持同步"），至少三处测试文件点名它漂移过一次（test-system-notify.mjs:13-14、test-trigger-engine.mjs:9、test-usage-history.mjs:13-14）。**此后新测试一律 `load-ts.mjs` 加载真源码，不许再内联副本**（test-dock-hide.mjs:11 明言）。

## 允许存在的"重复"（不是违规）

- `tray-text.ts` / `format.ts` 对 percent 的 import 是**消费**，不是复刻。
- 各 adapter 内的 `Math.round(x*10)/10`（claude.ts:31 等）是**采集侧原始 percent 生成**，与 shared 的**展示侧归一化**分工明确（见 [adapter-protocol](../../main/architecture/adapter-protocol.md)）。

## 参考

- 同主题部署纪律：改 shared 后必须跑受影响的 `npm run test:*`（映射见 [uitest-command-map](../../agents/guides/uitest-command-map.md)）。
