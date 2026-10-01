# Implement: P1-6 轻量 CLI / JSON 导出

## Ordered Checklist

### Phase 1: 纯逻辑 export-snapshot.ts

- [ ] **1.1** 新建 `src/main/cli/export-snapshot.ts`（**不 import electron**）
  - [ ] `EXPORT_SCHEMA_VERSION = 1`
  - [ ] `ExportSnapshot` / `ExportProvider` / `ExportWindow` 三个类型
  - [ ] `buildSnapshot(state: AppState, now: number): ExportSnapshot`
  - [ ] ⚠ **刻意不导**：`source` / `detail` / `failureReason` / `models` / `modelsByWindow`
        （`source` 含 API key 尾 4 位 —— `opencode.ts:198-202`；其余是自由文案）
  - [ ] `dataQuality` 作为**结构化枚举字符串**透传（`'official'|'cached'|'local'`）
  - [ ] `limit` / `percent` / `resetAt` 的 `null` **保持 null**（不填 0）
- [ ] **1.2** 纯度：`buildSnapshot` **不修改入参** `AppState`

### Phase 2: 纯逻辑 export-command.ts

- [ ] **2.1** 同目录新建 `src/main/cli/export-command.ts`（**不 import electron / keystore**）
  - [ ] `parseExportArgs(argv)`：`--json` / `--out <path>` / 未知命令 / 参数缺值
  - [ ] `renderTable(snap)`：人类可读表格，含供应商名、窗口、百分比、cached 标注
- [ ] **2.2** 退出码语义：`0` 成功 / `1` 参数非法或写文件失败 / `2` 没有导出文件或格式不认识

### Phase 3: 常驻进程写导出

- [ ] **3.1** 新建 `src/main/cli/export-writer.ts`
  - [ ] 落盘 `userData/balance-export.json` —— ⚠ **不是 extras**
        （`store.ts:92-97` 全量覆写；`test-usage-store.mjs` 的机制守卫钉着这条）
  - [ ] **按内容哈希去重**：快照没变就不写盘（常驻应用每 60s 推一次状态，
        不去重就是每天 1440 次写盘）
  - [ ] 写失败只记日志、**不抛**（导出是增值功能，不能拖垮采集）
- [ ] **3.2** `src/main/index.ts`：在 `pushState`（`index.ts:71`）里挂 `maybeWriteExport(state)`
  - [ ] ⚠ **只改 index.ts，不碰 `scheduler.ts`**（守住父任务 prd 的冲突约定）
  - [ ] 加 `[userDataDir]/balance-export.json` 到 `.gitignore` 之类该有的忽略位置
- [ ] **3.3** `src/main/index.ts`：argv 分流
  - [ ] `const argv = app.argv.slice(app.isPackaged ? 1 : 2)` —— ⚠ **实测值**：开发态
        argv = `[electronBin, ".", "export", "--json"]`，所以开发态要 slice(2)
  - [ ] `export` 分支：**在 app ready 之前**分流（它不开窗口，且实测
        `app.getPath('userData')` 在 ready 前可用）
  - [ ] 跑 `runExportCommand` → 写 stdout → `app.exit(code)`

### Phase 4: 测试

- [ ] **4.1** 新建 `scripts/test-cli-export.mjs`（`loadTs` 加载真源码，纯 node）
  - [ ] 覆盖 design.md Tests Required 第 1–7 条
  - [ ] 第 2 条的「**不含**四个字段」要**逐个 key 断言**（D4 的守卫）
  - [ ] 第 6 条的三条静态守卫（不 import electron / 不 import keystore / 不写 extras）
- [ ] **4.2** `package.json` 加 `test:cli-export` 并接入 `test` 链
  - ⚠ 若其它子任务也在改 `package.json`，合并时**统一接一次**（父任务 prd 的冲突表）

### Phase 5: spec

- [ ] **5.1** Phase 3.3 记录三条实测结论：
  - `app.getPath('userData')` **ready 前可用**（仓库既有注释的理由「static import 先于模块体求值」才是对的）
  - `scheduler.currentState()` **跨进程读不到**（无 `requestSingleInstanceLock`）
  - `ProviderSnapshot.source` 含 **API key 尾 4 位** —— 任何导出/日志都不该带它

## Review Gates

- [ ] `npm test` 通过（含新增 `test-cli-export.mjs`）
- [ ] `npm run typecheck` 通过
- [ ] **实机验证**：`npm run build` 后跑 `npx electron . export --json` → 输出合法 JSON、退出码 0
- [ ] **实机验证**：从未启动过应用（或删掉导出文件）时 → 退出码 2 + 明确提示
- [ ] **实机验证**：`npx electron . export`（无 `--json`）→ 人类可读表格
- [ ] **反验**：把 `buildSnapshot` 里加回 `source` 字段 → 4.1 第 2 条必须报红
- [ ] **反验**：给 `src/main/cli/export-command.ts` 加 `import 'electron'` → 4.1 第 6 条必须报红
- [ ] `trellis-check` 对照 prd.md 验收标准逐条复核

## Rollback

- **纯增量**：删掉 `index.ts` 的 `maybeWriteExport` 挂载即停止写文件；
  CLI 命令本身报「未知命令」（argv 分流删掉即可）。
- ⚠ **已写出的 `balance-export.json` 需要手工删** —— 它在 userData 里，
  里面是**已经脱敏过的**用量数据（不含凭据），留着无害但会一直存在。
- 不改动任何持久化键（导出走独立文件），因此**无数据迁移风险**。