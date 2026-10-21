# provider 适配器协议（main）

适用：新增 provider、改采集逻辑、排查「某个供应商拉不到账」。
核心观念：**出网是注入的能力；快照只有一条铸造路；路由按实例声明自动完成。**

## 统一接口

- 接口在 `src/main/adapters/types.ts:52` `ProviderAdapter`：`id / name / kind('balance'|'coding'|'token') / builtin / mark?` + `collect(ctx): Promise<ProviderSnapshot>`。kind 语义见 `src/shared/types.ts:11`。
- `CollectContext`（types.ts:38）= `{ now, getKey(id), getExtra(key), setKey?(id,value), request(CollectRequest) }`——**凭据与出网都是注入的**，适配器不 import electron / `net.ts`。
- `CollectRequest.body` 是**已序列化字符串**（types.ts:29，注释钉死）：form-encoded vs JSON 的序列化归调用方，**接缝不许 JSON.stringify**（重复序列化会把单位口径搞乱）。

## 快照铸造（engine.ts）——唯一产出点

- `src/main/adapters/engine.ts` 的 `snap`(:49)/`officialSnap`(:66)/`localSnap`(:70)/`errSnap`(:77)/`noDataSnap`(:87)。文件头三条纪律：
  1. **铸造是唯一产出快照的地方**（不许在适配器里手拼对象）；
  2. 身份必填（ADR-0001，无默认值）；
  3. 可信度 `dataQuality` 必填，错误/无数据显式传 `undefined`（ADR-0002，**不许默认成 official**）。
- 万能出网便利 `readJson(ctx,url,headers,timeoutMs=12_000,opts)`（engine.ts:96）：JSON 解析失败把原文截 200 字塞进 `body`，供适配器生成「响应格式未识别：<预览>」。

## 三级路由与并行采集

- 声明式协议工厂 `protocol-adapter.ts:40 createProtocolAdapter(decl, inst)`：取 key → Base URL 三级（extras `provider:<id>:baseUrl` 覆盖 → `inst.baseUrl` → `decl.defaultBaseUrl`，:60-61）→ `decl.probe(baseUrl)` → `readJson` → 401/403/404 状态映射（:26）→ `decl.read(body)` 铸窗口。协议表在 `protocols.ts`。
- 代码适配器是**单例基座**，靠 `bind-instance.ts:26 bindInstance(base, inst)` 绑实例，只做三件事：凭据查找重定向到实例 id、Base URL 覆盖、快照身份重盖。⚠️ 特例：`setKey` **必须透传**（cookie 自愈靠它，:52 注释记录了漏传导致自愈失效的坑）。
- 路由 `index.ts:47 buildAdapters(instances)` 纯函数三级：`protocolById` 命中 → 协议工厂；`CODE_ADAPTERS`(:27，opencode/claude-code/codex/copilot/cursor/gemini/antigravity/minimax/qwen/volc) → `bindInstance`；都没有 → `PROTOCOLS.generic` 兜底。
- 调度 `collect.ts:22 collectAll`：`Promise.all` 扇出 + **每适配器单独 catch**（单个失败铸成 `errSnap`，不 fail-fast）。并行是必须的——刷新频率可到 10s，串行会被慢接口拖垮。

## 折算口径

- 单位体系 `src/shared/types.ts:3 Unit = 'usd'|'cny'|'token'|'request'|'percent'`；`ProviderWindow` 的 `percent` 是官方直报比例，UI 优先用它而非 used/limit 推算（types.ts:35）。
- 换算三处：OpenCode 微美分 `USAGE_UNIT_SCALE = 1e8`（opencode-console-api.ts:139，除法在 opencode.ts:368/411/464）；Claude 本机估算 `PRICE_TIERS`（claude.ts:31）+ `estimateCost`(:44)；订阅窗口通用算法 `plan-utils.ts`（`parseLimits`:37 / `planWindows`:50）。
- **展示归一化统一走 `src/shared/percent.ts` 的 `windowPercent`**：适配器里的 `Math.round(x*10)/10`（claude.ts 等多处）是**采集侧原始 percent 生成**，与展示侧归一化是分工不是重复（详见 [../common/ architecture：shared-pure-model](../../common/architecture/shared-pure-model.md)）。

## opencode 四件套分工

| 文件 | 管什么 |
|---|---|
| `opencode.ts` | 装配 + 三层数源优先级：官方 API `GET /zen/go/v1/usage`（多 key 轮换 :645-668）→ 控制台 cookie → 本机 opencode.db。**百分比+重置时间永远以官方为准，不用本机推算**；`fetchExtraCredit` 失败返回 undefined（不显示 0，:605） |
| `opencode-cookie.ts` | cookie 会话读控制台配额窗口（`fetchUsageViaCookie`/`parseGoStatus`、`WINDOW_SPANS`:48） |
| `opencode-console-api.ts` | 端点与协议常量（`CONSOLE_ORIGIN`:26、`buildConsoleHeaders`:169 含 `x-org-id`、`classifyConsoleStatus`:182） |
| `opencode-local.ts` + `local-scan-host.ts` + `local-scan-worker.ts` | 本机 db 扫描口径唯一来源（SQL 投影/rowid 增量/变更探测，`createLocalScanner`:413）；全量扫描搬 worker 的契约见 [worker-offload](../guides/worker-offload.md)——worker 只 import host 的**类型**，不许复制第二份投影 SQL |

## 新增 provider 最小步骤

1. **键式余额接口（声明式）**：只改 `protocols.ts` 一张表——目录元数据与采集声明同源（`providers.ts:183-186` re-export `SELECTABLE_PROTOCOLS`），无需写代码。
2. **代码型**：① 新建 `src/main/adapters/<name>.ts` 导出 `ProviderAdapter`（基座按协议 id 固定读凭据）；② 登记 `index.ts:27 CODE_ADAPTERS`；③ `providers.ts:54 BUILTIN_PRESETS` 加预设条目（kind/protocol/defaultBaseUrl/keyHint；本机文件型加 `localCredential`/`singleton`/`probeCredential`）。
3. **编排层不登记任何东西**：路由/绑定/并行采集自动完成，渲染目录 `listCatalog`（providers.ts:194）自动出现。

## 验证

`npm run test:adapters`（采集引擎 + request/net/store 契约）、`npm run test:seam`（接缝契约：body 序列化纪律）。
