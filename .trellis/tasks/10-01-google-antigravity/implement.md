# Implement: Google Antigravity 适配器

> ### 📌 基线（2026-10-02 实测，AC28 的对照基准 —— 直接引用，不必重测）
>
> 口径：数每个套件 stdout 里的 `✓` 标记数。**共 20 个套件 / 合计 1974 项。**
>
> | 套件 | 项数 | | 套件 | 项数 |
> |---|---|---|---|---|
> | percent | 21 | | trigger-engine | 146 |
> | ssr | 72 | | alert-orchestration | 240 |
> | quality | 32 | | system-notify | 73 |
> | tray | 98 | | usage-predict | 104 |
> | pet | 43 | | usage-store | 42 |
> | gesture | 58 | | usage-history | 72 |
> | **adapters** | **334** | | cli-export | 107 |
> | structure | 85 | | seam | 46 |
> | read-model | 118 | | resource | 37 |
> | voice | 49 | | **合计** | **1974** |
> | speech-out | 197 | | | |
>
> ⚠ **除 `adapters` 之外的 19 个套件，项数必须与上表逐个一致** —— 只允许 `adapters` 增长
> （X 段是纯追加）。任何一个其它套件变了，说明「纯增量」被破坏，**停下来查**。

## Ordered Checklist

### Phase 1: 写适配器 `src/main/adapters/antigravity.ts`（新建，唯一新文件）

- [ ] **1.1** 文件头来源、许可声明 + 未文档化警告（照 `opencode-cookie.ts:22-23` 先例）：

  ```ts
  // 额度端点与响应形状参考自 robinebers/openusage docs/providers/antigravity.md（MIT）、
  // steipete/CodexBar docs/antigravity.md（MIT）、usagebar 文档（MIT fork）。
  // 本文件为独立重写实现，未复制任何函数体；aqua5230/usage（AGPL-3.0-only）的代码未读未用。
  // ⚠ 使用未文档化的内部接口（cloudcode-pa v1internal），Google 可能随时改版失效。
  ```
  - [ ] ⚠ OAuth `client_id`/`client_secret` 字面量（`1071006060591…` / `GOCSPX-…`）
        **绝不进文件**（AGPL 来源，Q2 选 A 的硬线）
- [ ] **1.2** 常量：三 base URL（按序）、两端点名、`loadCodeAssist` 的 metadata 常量
- [ ] **1.3** 导出 `antigravityTokenFile()`（认 `ANTIGRAVITY_TOKEN_FILE`）与 `readAntigravityToken()`
  - [ ] Keychain：`execFile('security', ['find-generic-password','-a','antigravity','-s','gemini','-w'])`，
        **不走 shell**（无注入面）；`ANTIGRAVITY_KEYCHAIN` env 存在时用其值代替 exec（测试替身，
        注释写清不是正式功能）；非 darwin 直接跳过
  - [ ] 值解码：剥 `go-keyring-base64:` 前缀（base64 解后 parse）；`JSON.parse` 试探，
        形状 `{ token: { access_token, … } }`，取 `access_token`
  - [ ] 旧 token 文件纯 JSON 只读；`HOME` 重定向自然覆盖 `~/.gemini` 默认路径（Gemini 先例）
  - [ ] ⚠ **不 import** `setKey`；**不新增** IPC；email 不进 detail
- [ ] **1.4** `collect(ctx)`：`loadCodeAssist` → project + tier（`paidTier.name` 优先）
  - [ ] `currentTier` 为 `free-tier` 但 `paidTier` 有值 → plan 取后者（AC10 的 fixture 必须覆盖这条）
  - [ ] project 空 → `errSnap` **直接返回**，第二个请求不发（D6，请求序列长度断言锁死）
  - [ ] 用 `readJson` + 第 5 参 `{ method: 'POST', body }`（D2，`engine.ts` 不许动）
  - [ ] headers 显式写全：Bearer + `Content-Type: application/json` + 可识别 UA（D4，
        不伪装，不发 `Connect-Protocol-Version`）
- [ ] **1.5** base URL 回退（D9）：只在 `ctx.request` 抛错/超时时换 host 重发**同一请求**；
      401/403/429 不换。实现为循环而非递归（host 列表短，循环更直读）。
- [ ] **1.6** `parseQuotaSummary` 纯函数（D5）：三 groups 位置、三 fraction 写法；
      值域外跳过；resetTime 非法则省略；全灭返回 null
  - [ ] ⚠ `window` 未知值原样透传（AC20），不要写白名单 switch（值域只见过 5h/weekly，
        白名单等于给未来改版埋雷）
- [ ] **1.7** 窗口组装（D7）：`${group} · ${windowLabel}`，`used: 0`，无 `limit` 字段，
      percent 自算一位小数，`note` = bucket displayName
  - [ ] ⚠ `used` 恒 0 是"无源"，不是"没用过"——注释写清（codex.ts:158 同款，抄注释语气）
- [ ] **1.8** 降级纪律：成功 `officialSnap`（`source: 'Antigravity 接口'`）；
      所有失败 `dataQuality === undefined`；**不写 `degradedReason`**；`local` 永不出现

### Phase 2: 注册与图标

- [ ] **2.1** `src/main/adapters/index.ts` 的 `CODE_ADAPTERS` 加 `'antigravity': antigravityAdapter` + import
- [ ] **2.2** `src/main/providers.ts` 的 `BUILTIN_PRESETS` 加一条（照 copilot 形状）：
      `id: 'antigravity'`、`protocol: 'antigravity'`、`kind: 'coding'`、
      `defaultBaseUrl: 'https://daily-cloudcode-pa.googleapis.com'`、
      `localCredential: true`、`singleton: true`、**无 `keyHint`**
  - [ ] ⚠ preset id **必须** == protocol id == `'antigravity'`（D3）
  - [ ] ⚠ 改完**立刻**跑 `node scripts/test-adapters.mjs` 看 T 段有没有新红
        （Gemini/Cursor 已证明加条目安全，但每加一条都要重验一次）
- [ ] **2.3** `scripts/gen-provider-icons.mjs` 的 `MARKS` 加
      `antigravity: { icon: 'simple-icons:google', color: '' }`，然后**跑脚本**
  - [ ] ⚠ `simple-icons:antigravity` 实测 404，用 google "G" 是已确认决定（prd Q6），
        不要临场换成别的没验证过的图标名
  - [ ] ⚠ `provider-icons.ts` 的 diff 应**只有新增一个键**。整文件重排 → 停，查脚本行为
  - [ ] ⚠ **不手改 `provider-icons.ts`**（生成物）

### Phase 3: X 段测试（`scripts/test-adapters.mjs`）

- [ ] **3.1** 落笔前再跑一次确认仍是「失败 0 项」
- [ ] **3.2** 插入位置：**W 段恢复块之后、汇总行（现 `:2294`）之前**，作为最后一段
  - [ ] ⚠ **只追加，既有 A~W 段与汇总行一行不改**（`X` 已锁定；字母撞车会让两段互相覆盖，
        且表现为「某段没跑到」而非报错）
  - [ ] N7（`PROTOCOLS.length === 8`）**不许动**
- [ ] **3.3** 段首用 `makeRichRequest(routes)`（接缝任务留下的；V/W 已验证可用）
  - [ ] 另起 X 专用检查器（照抄 `checkCursor` 形状，命名如 `checkAntigravity` ——
        各段检查器不互用是既有纪律）
  - [ ] ⚠ 布尔断言用 `vok`（V 段已有，不要另起名字——Gemini 的教训）
  - [ ] ⚠ env 恢复块照抄 W 段形状（存/恢复/删临时目录三件套，一个不少）；
        `ANTIGRAVITY_KEYCHAIN` / `ANTIGRAVITY_TOKEN_FILE` / `HOME` 全恢复
- [ ] **3.4** fixture 常量 + 来源注释：样本按 oh-my-pi #9940 真实 JSON（2026-08）与
      quotas crate live fixture（2026-07-14）手写重造，**逐字标注来源与检索日期，
      不得标「实测」**（`external-api-integration.md` Step 2）
  - [ ] 三 nesting fixture 必须断言**完全同结果**（AC12 的冻结语义）
- [ ] **3.5** 断言清单照 prd.md 的 **AC5–AC25** 逐条写，每条都要真断言
  - [ ] ⭐ **AC9**： quota 请求 body **恰好**是 `{"project": PROJECT}`（`callProjectRich` 全投影得到）
  - [ ] ⭐ **AC11**：project 为空时**请求序列长度为 1**（D6 的冻结测试，防静默撒谎）
  - [ ] ⭐ **AC19**：四窗口名互异（D7 偏离的冻结测试）
  - [ ] AC24：**每一条**失败路径都断言 `dataQuality === undefined`
- [ ] **3.6** 静态守卫（design.md Tests Required 3），**每条都要前置断言**
      （先断言找得到那段源码，否则负向断言「匹配不到就不成立」而**空洞通过**）：
  - [ ] `antigravity.ts` 用 `method: 'POST'`（改回 GET 必须红）
  - [ ] quota 请求 body 含 `project`（删掉必须红）
  - [ ] 未调用 `setKey`、未 import `setKey`（**精确到写操作**；`security` 只读 exec 不 ban，
        ban 错会逼后来人绕开守卫——design.md D10 的警告）
  - [ ] `PROTOCOLS.antigravity === undefined`（锁住不走声明表）
  - [ ] `1071006060591` 与 `GOCSPX-` 在 `antigravity.ts` **零出现**（AGPL 字面量硬线）

### Phase 4: 收尾验证

- [ ] **4.1** `npm test` → **除 `adapters` 外 19 套件与基线逐个一致**（AC28，逐套件列对照表）
- [ ] **4.2** `npm run typecheck` → clean
- [ ] **4.3** `node scripts/test-structure.mjs` → E5/F6 仍绿
- [ ] **4.4** **零 UI 改动核对**：`git diff --stat -- src/renderer/` 应**只有** `provider-icons.ts`
- [ ] **4.5** `git diff -- src/main/adapters/protocols.ts` → **空**（AC26）；
      `git diff -- src/main/adapters/engine.ts` → **空**
- [ ] **4.6** **Electron 里实测一次 `security` execFile**（research 遗留未验证项）：
      打包后/开发模式 Electron 主进程里 `execFile('security', [...])` 读不到条目时
      返回码非 0 且被 catch 跳过（行为不断言值，只断言"不崩"）
- [ ] **4.7** **两个必做反验**，实际跑并给实测红集：
  - [ ] ① `method: 'POST'` 改回 GET → X 段必须红
  - [ ] ② quota 请求 body 删掉 `project` → X 段必须红
  - [ ] 跑完恢复，复跑确认全绿

## Review Gates

- [ ] `npm test` 通过，且 **19 套件断言数 == 基线**（逐套件对照表写进报告）
- [ ] `npm run typecheck` 通过
- [ ] `protocols.ts` 与 `engine.ts` 零改动；N7 仍绿
- [ ] `test-adapters.mjs` 既有行零改动（`git diff` 只应是纯新增块）
- [ ] 零 UI 改动（除生成的 `provider-icons.ts`）
- [ ] Electron 内 `security` exec 行为实测
- [ ] 两个反验的实测红集
- [ ] `trellis-check` 对照 prd.md 的 **32 条 AC** 逐条复核

## Rollback

| 改动 | 回滚 |
|---|---|
| `antigravity.ts` + `CODE_ADAPTERS` 注册 | 删文件 + 删注册行 |
| `BUILTIN_PRESETS` 条目 | 删该条 |
| `gen-provider-icons.mjs` 的 `antigravity` 键 | 删该键后**重跑脚本**（不要手改生成物） |
| X 段 | 删掉插入的整块（纯追加，删除即复原） |
| 临时目录 env | 段末已恢复；若泄漏就删对应 env 变量 |

⚠ 回滚 `gen-provider-icons` 时**必须重跑脚本**（三家定下的纪律：手改生成物会让
下一个人跑脚本时 diff 突然冒出一个键，很难查）。
