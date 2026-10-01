# P1-6 轻量 CLI / JSON 导出

## Goal

提供 `balancedeck export` 命令，输出各供应商的用量 / 余额 / 可信度 / 重置时间，
供 tmux、iStat、终端提示词等外部脚本接入，让 BalanceDeck 的数据**可编程访问**。

竞品依据：opencode-quota 的 `npx ... show` + JSON 导出；Claude-God / AI_Usage_Dashboard 的 CSV。
调研原文：`.trellis/tasks/10-01-p1-cli-export/research/p1-6-cli-export-research.md`

## Requirements

1. **双形态输出**：`--json` 输出 JSON 到 stdout（给脚本）；无参数时输出人类可读表格（给人看）。
   两者共用同一份 `buildSnapshot`——**数据源唯一**，只是渲染方式不同。
2. **`--out <path>`**：写到文件而非 stdout。
3. **零副作用**：CLI **只读**，不出网、不采集、不碰凭据、不碰历史存储。
   读不到导出文件时退出码 2 + 明确提示「请先启动一次 BalanceDeck」。
4. **数据诚实**：`dataQuality`（`official` / `cached` / `local`）必须出现在导出里，
   且是**结构化枚举**而非自由文案——脚本会据此判断能否信任这个数。
5. **隐私（契约层面）**：v1 **不导** `source` / `detail` / `failureReason` / `models` / `modelsByWindow`。
   前三个是自由文案，其中 `source` 含 **API key 尾 4 位**（`opencode.ts:198-202` 的 `keyTag`
   → `:780` → `:788` 进入 `ProviderSnapshot.source`）。这是**契约层面不导**，不是「暂时没做」。
6. **契约演进**：JSON 带 `schemaVersion`；外部脚本会长期依赖它，需要能判断「我认识这个版本吗」。
7. **缺失值纪律**：`limit` / `percent` / `resetAt` 的 `null` 保持 `null`（不填 0）——
   脚本会把 0 当成一个事实。
8. **退出码语义**：`0` 成功 / `1` 参数非法或写文件失败 / `2` 无导出文件或格式不认识。

## Constraints

- **不碰 `scheduler.ts`**：写盘点挂 `index.ts` 的 `pushState`（守住本任务的文件边界约定）
- **导出文件不进 `extras`**：`store.ts:92-97` 每次 `setExtra` 全量覆写整个文件；
  落 `userData/balance-export.json` 独立文件
- **`src/main/cli/**` 不 import `electron` / `keystore`**：保证可被 `loadTs` 在纯 node 加载、
  且 CLI 绝不碰凭据
- **契约放 `src/main/cli/`，不放 `src/shared/`**：`shared` 是主进程↔渲染层的契约层，
  渲染层永远看不到 CLI 契约

## Acceptance Criteria

- [ ] `npx electron . export --json` 输出合法 JSON、退出码 0
- [ ] `npx electron . export`（无 `--json`）输出人类可读表格、退出码 0
- [ ] 从未启动过应用（或删掉导出文件）时：退出码 2 + 明确提示先启动应用
- [ ] `--out <path>` 写出文件且内容与 stdout 一致；路径不可写时退出码 1 且**不静默改写 stdout**
- [ ] 导出字段**逐个断言不含** `source` / `detail` / `failureReason` / `models`
      （静态守卫 + 真实文件审计两条都要有）
- [ ] `dataQuality` 透传 `'official'` / `'cached'` / `'local'`
- [ ] `schemaVersion` / `generatedAt` / `offline` / `providers` 齐备；
      `schemaVersion` 不认识时退出码 2 且报出实际版本
- [ ] `limit` / `percent` / `resetAt` 的 `null` 保持 null
- [ ] 空快照（应用刚启动未采集完）→ `providers: []`、退出码 0（空数据是有效状态）
- [ ] 常驻进程按**内容哈希去重**（快照未变不写盘）
- [ ] CLI 全程**零网络请求**、零 `setKey` 调用
- [ ] 新增 `scripts/test-cli-export.mjs` 并接入 `npm test`
- [ ] `npm test` 与 `npm run typecheck` 通过
- [ ] 两个反验实测有效：加回 `source` → 隐私用例红；加 `import 'electron'` → 静态守卫红

## Notes

- **实现偏离（已实测记录）**：
  1. `app.argv` 在本仓锁定的 Electron 37.10.3 上是 **`undefined`**（探针实测：
     `app.argv.slice(…)` 直接 `TypeError`）→ 改用 `process.argv`，由 K9 静态断言钉住。
  2. `export` 分流落在 `whenReady` **内部第一句**而非之前 —— ES 模块体无法 `return`，
     真要在 ready 前跳过就得把整个组合根包进 `if/else`，而 research §3.4 trap ③
     已警告过模块体插入的坑。功能目标全部满足（不开窗口、不建托盘、不起 scheduler、
     `primePrefs()` 不执行）。「`app.getPath('userData')` 在 ready 前可用」这条实测结论仍然成立，已记入 spec。
- **未做（超出本任务文件范围，留给后续）**：`README` 的命令表没有 `export` 行；
  没有 `bin` 入口 —— 用户目前必须走完整路径或自己 alias（research §3.1 已记）。
- 设计推导见 `design.md` 的 D1–D7，执行清单见 `implement.md`。