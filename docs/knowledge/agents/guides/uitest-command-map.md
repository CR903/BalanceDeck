# QA 命令映射（agents）

适用：跑测试前挑对脚本——本仓是 electron 窗口/托盘应用，多数测试不是 CI 退出码形态，选错脚本会「以为没测」。
断言本身的纪律（等条件成立等）见 [uitest-timing](../guides/uitest-timing.md)，本篇只管「哪个命令测哪里」。

## 三种内建模式（electron 启动的形态级验证）

入口分派在 `src/main/index.ts`：

| 模式 | 命令 | 测什么 | 退出码 |
|---|---|---|---|
| smoke | `npm run smoke`（`--smoke`, :146-151） | 建窗 + preload/renderer 加载验证，`SMOKE_WAIT_MS`(默认 6s) 后输出 `{rendererRoot, preloadError, tray, state}` JSON 到 stdout | ✅ 有 |
| uitest | `npm run uitest`（`--uitest`, :146-151） | 跑全 UI 断言（`src/main/qa/uitest.ts`），JSON 出 stdout | ⚠️ 不设退出码（modes.ts:14-15）——判 pass 要看输出里的 failures |
| shots | `npm run shots`（`--shots`, :140-143 → `qa/shots.ts`） | 设计走查截图，产物 `/tmp/balancedeck-shots/` | — |
| ballshot | `--ballshot`（:135-137） | 只拍收起态水球 | — |

三模式共用 `modes.ts:28-46 setupTestApp`（建窗 + 收集 preload-error / level≥3 console 错误 + 起托盘与调度器），`ballshot.ts` 是它的同伴。

## test:* 纯函数脚本映射（node 直测 shared/纯逻辑层）

| 脚本 | 被测目标 |
|---|---|
| `test:percent` / `test:quality` | shared/percent（⚠️ 内联副本，历史漂移案主犯）/ shared/quality |
| `test:ssr` | main/opencode-details.ts（loadTs 加载真源码） |
| `test:tray` | shared/tray-text + shared/levels + main/tray-badge |
| `test:adapters` / `test:seam` | 采集引擎 + request/net/store / CollectRequest 接缝契约 |
| `test:structure` | 结构门禁（静态断言 30+ 文件的分层/单源约束，改架构必跑） |
| `test:read-model` | renderer/read-model.ts |
| `test:voice` / `test:speech-out` / `test:trigger-engine` / `test:alert-orchestration` / `test:system-notify` | 提醒链路四件套 + notify payload 钉死 |
| `test:usage-store` / `test:usage-history` | 落盘 store（含「不得 import extras」负向断言） |
| `test:collect-loop` / `test:deadline` | 采集控制流 / 轮次 deadline |
| `test:dock-hide` / `test:fluid` / `test:island-clip` / `test:series-view` | shared 几何/时序/聚合 |
| `test:cli-export` / `test:local-scan` / `test:local-scan-host` | cli 导出 / 本机扫描 worker 三件套 |

公共设施：`scripts/lib/load-ts.mjs`（TS → 可加载模块的桩，**新增测试必须走它，不许内联实现副本**）。

## 挑脚本的口诀

- 改 `src/shared/**` → 跑它对应的 `test:<模块>` + `test:structure`（单源门禁）。
- 改 `src/main/**` → 对应纯逻辑脚本 + `npm run smoke`（预加载/建窗冒烟）。
- 改 UI 行为/时序 → `test:structure` 不够，跑 `npm run uitest`（注意**没退出码**，读 JSON 输出）+ 必要时 `npm run shots` 目视。
- 断言写法：只许「等条件成立」，一个轮询原语 `pollCheck`（uitest.ts:78-120）；注入夹具前先 `waitIdle`(:131) 让在飞采集轮落完。

## 参考

- 谓词断言纪律全文：[uitest-timing](../guides/uitest-timing.md)；子代理「已完成」对账：[subagent-verify](../best-practices/subagent-verify.md)。
