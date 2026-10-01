# Implement: P1-6 轻量 CLI / JSON 导出

## Ordered Checklist

### Phase 1: 纯逻辑 export-snapshot.ts

- [x] **1.1** 新建 `src/main/cli/export-snapshot.ts`（**不 import electron**）
  - [x] `EXPORT_SCHEMA_VERSION = 1`（另加 `EXPORT_FILE_NAME`，读写两侧共用一个常量）
  - [x] `ExportSnapshot` / `ExportProvider` / `ExportWindow` 三个类型
  - [x] `buildSnapshot(state: AppState, now: number): ExportSnapshot`
  - [x] ⚠ **刻意不导**：`source` / `detail` / `failureReason` / `models` / `modelsByWindow`
        （`source` 含 API key 尾 4 位 —— `opencode.ts:198-202`；其余是自由文案）
        → 实际还多排除了 `degradedReason` / `mark` / `plan`（同属自由文案/展示元数据）
  - [x] `dataQuality` 作为**结构化枚举字符串**透传（`'official'|'cached'|'local'`）
  - [x] `limit` / `percent` / `resetAt` 的 `null` **保持 null**（不填 0）
        → `percent` 走 `shared/percent` 的 `windowPercent`（官方不给时回退 used/limit）
- [x] **1.2** 纯度：`buildSnapshot` **不修改入参** `AppState`

### Phase 2: 纯逻辑 export-command.ts

- [x] **2.1** 同目录新建 `src/main/cli/export-command.ts`（**不 import electron / keystore**）
  - [x] `parseExportArgs(argv)`：`--json` / `--out <path>` / 未知命令 / 参数缺值
        → `ExportArgs` 比 design.md 的草图多一个 `missingValue`：缺值与「没有 --out」
        是两件事（`--out` 和 `--json` 都要能被区分），草图的三字段表达不了
  - [x] `renderTable(snap)`：人类可读表格，含供应商名、窗口、百分比、cached 标注
        → 可信度标注**调 `shared/quality` 的 `staleLabel`**，不写第二份判断
  - [x] 顺带 `parseExportedSnapshot(raw)`：导出文件的格式校验（「不认识的版本」是状态不是崩溃）
- [x] **2.2** 退出码语义：`0` 成功 / `1` 参数非法或写文件失败 / `2` 没有导出文件或格式不认识

### Phase 3: 常驻进程写导出

- [x] **3.1** 新建 `src/main/cli/export-writer.ts`
  - [x] 落盘 `userData/balance-export.json` —— ⚠ **不是 extras**
        （`store.ts:92-97` 全量覆写；`test-usage-store.mjs` 的机制守卫钉着这条）
        → 路径**由调用方惰性注入**（`filePath: () => …`，与 `usage-history.ts` 同一形状），
        所以本文件也不 import electron
  - [x] **按内容哈希去重**：快照没变就不写盘（常驻应用每 60s 推一次状态，
        不去重就是每天 1440 次写盘）
        → 哈希**刻意排除 `generatedAt`**（它每次推送都变；算进去等于没有去重）
  - [x] 写失败只记日志、**不抛**（导出是增值功能，不能拖垮采集）
- [x] **3.2** `src/main/index.ts`：在 `pushState` 里挂 `exportWriter.maybeWrite(s, Date.now())`
  - [x] ⚠ **只改 index.ts，不碰 `scheduler.ts`**（守住父任务 prd 的冲突约定；
        `test-cli-export.mjs` K11 反向钉住：scheduler 不许 import `cli/`）
  - [x] `.gitignore` **无需改动** —— 导出文件只落在 `app.getPath('userData')`
        （`~/Library/Application Support/balancedeck/`），仓库里永远不会出现这个文件。
        先例：`usage-history.json` 同样不在 `.gitignore` 里。
- [x] **3.3** `src/main/index.ts`：argv 分流
  - [x] `const cliArgv = process.argv.slice(app.isPackaged ? 1 : 2)` —— ⚠ **实测修正**：
        偏移量与草图一致（开发态 argv = `[electronBin, ".", "export", "--json"]`，
        所以开发态 slice(2)），但数据源**必须是 `process.argv` 而非 `app.argv`** ——
        本机 Electron 37.10.3 实测 `app.argv === undefined`，照文档写会在启动时 TypeError
  - [x] `export` 分支：放在 `whenReady` 回调的**第一个语句**（早于 `primePrefs()`、
        `createOverlay` / `createTray` / `startScheduler`）—— 不开窗口、不建托盘、不起调度器
        > ⚠ 与草稿「在 app ready 之前分流」有出入，理由记录在
        > `.trellis/spec/frontend/directory-structure.md` 的 `src/main/cli/` 一节：
        > ES 模块体**不能 `return`**，真正「ready 之前」就得把整个组合根包进 `if/else`；
        > 而 research §3.4 陷阱③ 本就建议不要插队到模块体。功能目标（不开窗、不起调度器、
        > 不读凭据）已全部达成。`app.getPath('userData')` ready 前可用这一点仍然成立且已记录。
  - [x] 跑 `runExportCommand` → 写 stdout/stderr → `app.exit(code)`

### Phase 4: 测试

- [x] **4.1** 新建 `scripts/test-cli-export.mjs`（`loadTs` 加载真源码，纯 node）
  - [x] 覆盖 design.md Tests Required 第 1–7 条（A–K 共 11 节）
  - [x] 第 2 条的「**不含**四个字段」**逐个 key 断言**（D4 的守卫，另加 2 条内容断言）
  - [x] 第 6 条的三条静态守卫（K2 不 import electron / K3 不碰凭据 / K4 不走 extras）
        → 另加 K5/K6 复用 shared 的单一实现、K7 写盘点在 pushState、K11 不碰 scheduler
  - [x] 夹具**故意带隐私样本**（`source` 含 key 尾 4 位、`failureReason` 含 GitHub 用户名）
- [x] **4.2** `package.json` 加 `test:cli-export` 并接入 `test` 链
  - 用 `edit` 精确匹配两行（`test:usage-store` 之后加脚本、`test` 链尾加 `&& npm run test:cli-export`），
    未重排 scripts 块。并行子任务若也改了这两处，合并时**保留双方**。

### Phase 5: spec

- [x] **5.1** 记录三条实测结论（落在
  `.trellis/spec/frontend/directory-structure.md` 的 **`src/main/cli/` 一节**）
  - [x] `app.getPath('userData')` **ready 前可用**（仓库既有注释的理由「static import 先于
        模块体求值」才是对的）
  - [x] `scheduler.currentState()` **跨进程读不到**（无 `requestSingleInstanceLock`）
  - [x] `ProviderSnapshot.source` 含 **API key 尾 4 位** —— 任何导出/日志都不该带它
  - [x] 追加第四条实测：`app.argv` 在本机 Electron 37.10.3 里是 `undefined`

## Review Gates

- [x] `npm test` 通过（含新增 `test-cli-export.mjs`）
- [x] `npm run typecheck` 通过
- [x] **实机验证**：`npm run build` 后跑 `npx electron . export --json` → 输出合法 JSON、退出码 0
- [x] **实机验证**：从未启动过应用（或删掉导出文件）时 → 退出码 2 + 明确提示
- [x] **实机验证**：`npx electron . export`（无 `--json`）→ 人类可读表格
- [x] **反验 ①**：把 `source: s.source` 加回 `buildSnapshot` → **实测红集 3 条**（C1/C2/C4，
      全部落在 C 节声明的隐私目标集内，无外溢）；恢复后 107/0 绿
- [x] **反验 ②**：给 `export-command.ts` 加 `import { app } from 'electron'` → **实测红集 1 条**
      （K2）；恢复后 107/0 绿
- [ ] `trellis-check` 对照 prd.md 验收标准逐条复核（主会话负责）

## Rollback

- **纯增量**：删掉 `index.ts` 里 `pushState` 的 `exportWriter.maybeWrite(...)` 一行即停止写文件；
  CLI 命令本身报「不认识的参数」（argv 分流删掉即可）。
- ⚠ **已写出的 `balance-export.json` 需要手工删** —— 它在 userData 里，
  里面是**已经脱敏过的**用量数据（不含凭据），留着无害但会一直存在。
- 不改动任何持久化键（导出走独立文件），因此**无数据迁移风险**。