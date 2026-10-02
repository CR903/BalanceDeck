# Implement: Cursor 适配器

> ### 📌 基线（2026-10-02 实测，AC25 的对照基准 —— 直接引用，不必重测）
>
> 口径：数每个套件 stdout 里的 `✓` 标记数。**共 20 个套件 / 合计 1879 项。**
>
> | 套件 | 项数 | | 套件 | 项数 |
> |---|---|---|---|---|
> | percent | 21 | | trigger-engine | 146 |
> | ssr | 72 | | alert-orchestration | 240 |
> | quality | 32 | | system-notify | 73 |
> | tray | 98 | | usage-predict | 104 |
> | pet | 43 | | usage-store | 42 |
> | gesture | 58 | | usage-history | 72 |
> | **adapters** | **239** | | cli-export | 107 |
> | structure | 85 | | seam | 46 |
> | read-model | 118 | | resource | 37 |
> | voice | 49 | | **合计** | **1879** |
> | speech-out | 197 | | | |
>
> ⚠ **除 `adapters` 之外的 19 个套件，项数必须与上表逐个一致** —— 只允许 `adapters` 增长
> （W 段是纯追加）。任何一个其它套件变了，说明「纯增量」被破坏，**停下来查**。

## Ordered Checklist

### Phase 1: 写适配器 `src/main/adapters/cursor.ts`（新建，唯一新文件）

- [ ] **1.1** 文件头来源与许可声明 + 未文档化警告（照 `opencode-cookie.ts:22-23` 先例）：

  ```ts
  // 额度端点与凭据路径参考自 steipete/CodexBar docs/cursor.md（MIT）、
  // cbnsndwch/pacebar docs/providers/cursor（MIT）。本文件为独立重写实现，未复制任何函数体。
  // ⚠ 使用未文档化的 dashboard 接口（api2.cursor.sh），Cursor 可能随时改版失效。
  ```
  - [ ] ⚠ `wakamex/cursor-cli-usage`（NONE）与 `tddworks/ClaudeBar`（NONE）的**代码一行不看**，
        只用文档结论
- [ ] **1.2** 常量：`USAGE_URL`、三平台 `state.vscdb` 默认路径、`auth.json` 多候选路径
- [ ] **1.3** 导出 `cursorStateDb()`（认 `CURSOR_STATE_DB`）与 `cursorAuthJsonCandidates()`
      （认 `CURSOR_CONFIG_DIR` / `XDG_CONFIG_HOME`），以及 `readCursorToken()`
  - [ ] `ItemTable` 只查一行：`SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'`，
        **不 `SELECT *`**，不 `.all()` 整表（`state.vscdb` 可能数 GB）
  - [ ] 值解码：**先去 NUL 字节**（UTF-16LE BLOB 陷阱），再 `JSON.parse` 试探，失败当 raw 字符串
  - [ ] `node:sqlite` 照 `opencode.ts:122` 的动态 import 写法；`new DatabaseSync(path, { readOnly: true })`
  - [ ] WAL 失败（`SQLITE_CANTOPEN` / readonly 写 complaint）→ **catch 后直接回落 `auth.json`**，
        不重试、不碰 Cursor 目录
  - [ ] 同库顺带读 `cursorAuth/stripeMembershipType`（套餐名，零成本）；读不到不报错
  - [ ] ⚠ **不 import** `keychain` / `setKey`；**不新增** IPC（design.md D4 的反面清单）
- [ ] **1.4** JWT 最小解码：`Buffer.from(payload, 'base64url')` + `JSON.parse`，
      取 `exp`（**秒**，与 billingCycle 毫秒字符串分开处理，D10）
  - [ ] `exp` 已过 → `errSnap`「在 Cursor 中重新登录」，**直接返回不发请求**
  - [ ] 解不出 → `noDataSnap`（未配置，不是错误）
- [ ] **1.5** `collect(ctx)`：单 POST，headers 显式写全三项（D4），body `'{}'`
  - [ ] ⚠ `Authorization: Bearer` —— 注意 copilot 用的是 `token ` 前缀，Cursor 是 `Bearer`，别抄错
  - [ ] 用 `readJson` + 第 5 参 `{ method: 'POST', body: '{}' }`（D2，`engine.ts` 不许再动）
- [ ] **1.6** 不变量 + 窗口组装（D6/D7）：
  - [ ] 同单位（分）直接比较 `includedSpend + remaining === limit`，**比较前不换算**（浮点假 drift）
  - [ ] 展示才 `/100`；percent 自算一位小数（`Math.round(x * 10) / 10`，与 copilot/gemini 同式）
  - [ ] 快照里**不出现** `totalPercentUsed` / `autoPercentUsed` / `apiPercentUsed` 任一键
  - [ ] `spendLimitUsage.individualLimit > 0` → 第二窗口；`limitType === 'team'` → pooled 口径
  - [ ] 无 `planUsage` → `errSnap`（Q5，不正则人话）；`isUnlimited` → 无 limit 窗口
- [ ] **1.7** 降级纪律：成功 `officialSnap`；所有失败 `dataQuality === undefined`；
      **不写 `degradedReason`**；`local` 永不出现；`detail` 回显服务端原文不自己编

### Phase 2: 注册与图标

- [ ] **2.1** `src/main/adapters/index.ts` 的 `CODE_ADAPTERS` 加 `'cursor': cursorAdapter` + import
- [ ] **2.2** `src/main/providers.ts` 的 `BUILTIN_PRESETS` 加一条（照 copilot `:86-93` 形状）：
      `id: 'cursor'`、`protocol: 'cursor'`、`kind: 'coding'`、
      `defaultBaseUrl: 'https://api2.cursor.sh'`、`localCredential: true`、`singleton: true`、**无 `keyHint`**
  - [ ] ⚠ preset id **必须** == protocol id == `'cursor'`（D3）
  - [ ] ⚠ 改完**立刻**跑 `node scripts/test-adapters.mjs` 看 T 段有没有新红
        （Gemini 已证明加条目安全，但每加一条都要重验一次）
- [ ] **2.3** `scripts/gen-provider-icons.mjs` 的 `MARKS` 加
      `cursor: { icon: 'simple-icons:cursor', color: '' }`，然后**跑脚本**
  - [ ] ⚠ `provider-icons.ts` 的 diff 应**只有新增一个键**。整文件重排 → 停，查脚本行为
  - [ ] ⚠ **不手改 `provider-icons.ts`**（生成物）

### Phase 3: W 段测试（`scripts/test-adapters.mjs`）

- [ ] **3.1** 落笔前再跑一次确认仍是「失败 0 项」
- [ ] **3.2** 插入位置：**V 段恢复块之后、`:1800` 汇总行之前**，作为最后一段
  - [ ] ⚠ **只追加，既有 A~V 段与汇总行一行不改**（`V` 已被占，Cursor 用 `W`；
        字母撞车会让两段互相覆盖，且表现为「某段没跑到」而非报错）
  - [ ] `:800` 的 N7（`PROTOCOLS.length === 8`）**不许动**
- [ ] **3.3** 段首用 `makeRichRequest(routes)`（接缝任务留下的；V 段已验证可用）
  - [ ] 另起 W 专用检查器（照抄 `checkRich` 形状，命名如 `checkCursor` ——
        `checkRich` 注释写明是 "V 段专用"，不要复用 V 的名字）
  - [ ] ⚠ **吸取 Gemini 的教训**：`ok` 是快照构造器不是断言，布尔断言用 `vok`
       （V 段 `:1362-1364` 有注释说明，直接复用 `vok`，不要另起名字）
  - [ ] ⚠ 临时目录真实建库：`node:sqlite` 建 `ItemTable(key TEXT, value TEXT)` + 假 JWT；
        `CURSOR_STATE_DB` 指过去；段末 try/finally 恢复 env（照抄 V 段 `:1790-1799` 恢复块形状）
  - [ ] ⚠ 假 JWT 用 `{"alg":"none"}` + base64url 自造 payload，**明显假**（红线）
- [ ] **3.4** fixture 常量 + 来源注释：样本取自 PaceBar 文档 + 官方论坛 2026-08-12 贴文
      （两个独立来源互证），**逐字标注来源与检索日期，不得标「实测」**
     （`external-api-integration.md` Step 2）
  - [ ] 论坛样本：`includedSpend 23222 / remaining 16778 / limit 40000`（Pro→Ultra 形态均可构造）
- [ ] **3.5** 断言清单照 prd.md 的 **AC5–AC24** 逐条写，每条都要真断言
  - [ ] ⭐ **AC9**：请求序列断言 URL + method + body + 三个头（`callProjectRich` 全投影得到）
  - [ ] ⭐ **AC11**：快照 windows 里无服务端 percent 任一键（`'totalPercentUsed' in w === false`，
        查 raw snap——`stable()` 会吞 undefined，要像 Gemini 的 V1d 那样绕开投影查）
  - [ ] ⭐ **AC13**：`includedSpend + remaining !== limit` → `errSnap`（构造一组加总不等的 fixture）
  - [ ] AC19：**每一条**失败路径都断言 `dataQuality === undefined`
  - [ ] AC23：WAL 只读失败的回落——用**不存在的子目录**或**无权限文件**触发真实失败路径，
        不要 mock `DatabaseSync`（mock 会测到自己的 mock）
- [ ] **3.6** 静态守卫（design.md Tests Required 3），**每条都要前置断言**
      （先断言找得到那段源码，否则负向断言「匹配不到就不成立」而**空洞通过**——
      Gemini 的 E4/B3 教训）：
  - [ ] `cursor.ts` 用 `method: 'POST'`（改回 GET 必须红）
  - [ ] percent 自算（改读 `totalPercentUsed` 必须红）
  - [ ] 未调用 `setKey`（锁住不自愈）
  - [ ] `PROTOCOLS.cursor === undefined`（锁住不走声明表）

### Phase 4: 收尾验证

- [ ] **4.1** `npm test` → **除 `adapters` 外 19 套件与基线逐个一致**（AC25，逐套件列对照表）
- [ ] **4.2** `npm run typecheck` → clean
- [ ] **4.3** `node scripts/test-structure.mjs` → E5/F6 仍绿
- [ ] **4.4** **零 UI 改动核对**：`git diff --stat -- src/renderer/` 应**只有** `provider-icons.ts`
- [ ] **4.5** `git diff -- src/main/adapters/protocols.ts` → **空**（AC21）
- [ ] **4.6** **Electron 里实测一次 `node:sqlite`**（research 遗留未验证项）：
      打包后/开发模式 Electron 里 `new DatabaseSync` 只读打开真实或临时库，
      确认可用（opencode.ts 在用，但 Cursor 是第二个使用者，路径不同要亲验）
- [ ] **4.7** **两个必做反验**，实际跑并给实测红集：
  - [ ] ① `method: 'POST'` 改回 GET → W 段必须红
  - [ ] ② percent 改读 `totalPercentUsed` → 快照/不变量断言必须红
  - [ ] 跑完恢复，复跑确认全绿

## Review Gates

- [ ] `npm test` 通过，且 **19 套件断言数 == 基线**（逐套件对照表写进报告）
- [ ] `npm run typecheck` 通过
- [ ] `protocols.ts` 零改动；N7 仍绿
- [ ] `test-adapters.mjs` 既有行零改动（`git diff` 只应是纯新增块）
- [ ] 零 UI 改动（除生成的 `provider-icons.ts`）
- [ ] Electron 内 `node:sqlite` 实测可用
- [ ] 两个反验的实测红集
- [ ] `trellis-check` 对照 prd.md 的 **29 条 AC** 逐条复核

## Rollback

| 改动 | 回滚 |
|---|---|
| `cursor.ts` + `CODE_ADAPTERS` 注册 | 删文件 + 删注册行 |
| `BUILTIN_PRESETS` 条目 | 删该条 |
| `gen-provider-icons.mjs` 的 `cursor` 键 | 删该键后**重跑脚本**（不要手改生成物） |
| W 段 | 删掉插入的整块（纯追加，删除即复原） |
| 临时目录 env | 段末已恢复；若泄漏就 `delete process.env.CURSOR_STATE_DB` |

⚠ 回滚 `gen-provider-icons` 时**必须重跑脚本**（Gemini 任务定下的纪律：手改生成物会让
下一个人跑脚本时 diff 突然冒出一个键，很难查）。
