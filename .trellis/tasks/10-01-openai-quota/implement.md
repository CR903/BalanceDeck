# Implement: OpenAI 额度（`codex.ts` 升级）

> ### 📌 基线（2026-10-02 实测，AC24 的对照基准 —— 直接引用，不必重测）
>
> 口径：数每个套件 stdout 里的 `✓` 标记数。**共 20 个套件 / 合计 2091 项。**
>
> | 套件 | 项数 | | 套件 | 项数 |
> |---|---|---|---|---|
> | percent | 21 | | trigger-engine | 146 |
> | ssr | 72 | | alert-orchestration | 240 |
> | quality | 32 | | system-notify | 73 |
> | tray | 98 | | usage-predict | 104 |
> | pet | 43 | | usage-store | 42 |
> | gesture | 58 | | usage-history | 72 |
> | **adapters** | **451** | | cli-export | 107 |
> | structure | 85 | | seam | 46 |
> | read-model | 118 | | resource | 37 |
> | voice | 49 | | **合计** | **2091** |
> | speech-out | 197 | | | |
>
> ⚠ **除 `adapters` 之外的 19 个套件，项数必须与上表逐个一致** —— 只允许 `adapters` 增长
> （Y 段是纯追加）。任何一个其它套件变了，说明改动越界，**停下来查**。

## Ordered Checklist

### Phase 1: 先冻结"今天"（方案 A 的安全带，没有这步不许动 `codex.ts`）

- [ ] **1.1** 在 `scripts/test-adapters.mjs` 尾部（X 段恢复块之后、汇总行之前）起 Y 段，
      先只写**无 auth 的两个 fixture**（`CODEX_HOME` 指空临时目录）：
  - [ ] sessions 有 rate_limits → 与今天逐字相同的 official 快照
       （windows/plan/source/detail 全等——先跑出现有行为的**逐字记录**，不要凭记忆写期望）
  - [ ] sessions 为空 → nodata（记录现有文案，后续改文案时此条会红，提醒同步改）
- [ ] **1.2** 跑通，确认 Y 段基线绿。这是"今天"的冻结照，后续任何改动都不能让它红
      （除非 prd 明确要求改文案——AC11 的文案更新除外，它红了是预期的）

### Phase 2: 升级 `src/main/adapters/codex.ts`（唯一产品代码文件）

- [ ] **2.1** 顶层注释更新：数据源优先级改成
      `① wham/usage 主动查询 → ② jsonl rate_limits → ③ 本机 token 统计`，
      并写清 401 例外（D2）。注释是后来人的第一份文档，别只改代码不改注释
- [ ] **2.2** 新增 `WHAM_URL` 常量 + `whamWindowName()` + `buildWhamWindows()` +
      `codexAuthFile()` + `readCodexCreds()`（design.md Contracts 形状）
  - [ ] ⚠ `readCodexCreds` 读文件全程 try/catch（ENOENT/坏 JSON/缺字段 → 下一源，
        不抛错——R5 低风险的处理）
  - [ ] ⚠ `getKey` 空串当无 token（别发 `Bearer ` 空请求）
  - [ ] ⚠ **无 `writeFile*`，无 `setKey` 调用**（AC15/AC18 守卫会查）
  - [ ] ⚠ 出网只走 `readJson`（AC18 守卫会查裸 `fetch(`）
- [ ] **2.3** `collect()` 开头插入 wham 分支（D2 形状），现有 jsonl 逻辑**整块下移、一字不改**
  - [ ] 200 + 可识别 → wham 快照直接返回（含 used 回填，D5）
  - [ ] 401 → errSnap（文案含 `codex login`；**return，不往下走**）
  - [ ] 其他 → 掉进现有逻辑（不加注释都行，代码形状自己会说话；但建议一行注释说明"回退"意图）
- [ ] **2.4** nodata 文案更新为提及两条路（AC11）：
      现有文案只说 sessions；升级后"无数据"意味着 wham 也不可用，文案必须诚实。
      ⚠ 改文案会让 Phase 1 冻住的那条红——这是**预期内**的红，同步更新期望即可

### Phase 3: Y 段剩余断言（AC1–AC20，AC10/AC11 已在 Phase 1 覆盖）

- [ ] **3.1** fixture：`CODEX_HOME` 指临时目录，内放假 `auth.json`
     （`tokens.access_token: 'fake-jwt-for-tests'`，`account_id: 'fake-account-id'`，
      **明显假**，红线）+ 可选 sessions 目录
  - [ ] ⚠ 段末 try/finally 恢复 `CODEX_HOME`（照抄 X 段恢复块形状，一个不少）
  - [ ] ⚠ fixture 注释标注来源（CodexBar#2900 形状，2026-10-01 转录）+ "未在本机实测"
- [ ] **3.2** 检查器：Y 专用（照抄 `checkCursor`/`checkAntigravity` 形状，不互用）；
      请求投影用 `makeRichRequest`（接缝任务留下的；V/W/X 已验证可用）；
      布尔断言用 `vok`（不另起名字）
- [ ] **3.3** 断言清单（每条真断言，AC1–AC9/AC12–AC20）：
  - [ ] ⭐ **AC6**：401 fixture + sessions 有 rate_limits → **仍然 errSnap**
        （"有旧数据也不回退"的冻结测试，D2 最锋利的一条）
  - [ ] ⭐ **AC2**：请求全等断言 URL + method GET + 双头（多一个少一个都红，D8）
  - [ ] AC4：86400 fixture → `'24 小时'`（未知秒数推导的冻结测试）
  - [ ] AC14：`JSON.stringify(snap)` 不含 `'fake-jwt'`/`'fake-account'`（行为级泄漏守卫）
- [ ] **3.4** 静态守卫（design.md Tests Required 4），**每条都要前置断言**
      （先断言找得到那段源码，否则负向断言空洞通过——三家攒下的教训）

### Phase 4: 收尾验证

- [ ] **4.1** `npm test` → **除 `adapters` 外 19 套件与基线逐个一致**（AC24，逐套件列对照表）
- [ ] **4.2** `npm run typecheck` → clean
- [ ] **4.3** `node scripts/test-structure.mjs` → E5/F6 仍绿（无新 IPC）
- [ ] **4.4** **改动面核对**：`git diff --stat` 产品代码应**只有** `codex.ts`；
      `git status` 无新文件（方案 A 不新增文件——多出任何新文件都是越界）
- [ ] **4.5** `git diff -- src/main/adapters/protocols.ts` → **空**（AC21）
- [ ] **4.6** **两个必做反验**，实际跑并给实测红集：
  - [ ] ① 删掉 `ChatGPT-Account-Id` 头 → Y 段必须红
  - [ ] ② 让 collect 跳过 wham（永远走 jsonl）→ wham happy-path 断言必须红
  - [ ] 跑完恢复，复跑确认全绿

## Review Gates

- [ ] `npm test` 通过，且 **19 套件断言数 == 基线**（逐套件对照表写进报告）
- [ ] `npm run typecheck` 通过
- [ ] `protocols.ts` 零改动；N7 仍绿；无新增注册/预设/图标改动
- [ ] `test-adapters.mjs` 既有行零改动（`git diff` 只应是纯新增块 + `codex.ts` 修改）
- [ ] 零 UI 改动（`src/renderer/**` 零 diff）
- [ ] 两个反验的实测红集
- [ ] `trellis-check` 对照 prd.md 的 **28 条 AC** 逐条复核

## Rollback

| 改动 | 回滚 |
|---|---|
| `codex.ts` 升级 | `git checkout -- src/main/adapters/codex.ts`（单文件，Y 段冻结照会红——
先删 Y 段再回滚，或接受红了再删段；顺序：删段 → 回滚 → 全绿确认） |
| Y 段 | 删掉插入的整块（纯追加，删除即复原） |
| 临时目录 env | 段末已恢复；若泄漏就 `delete process.env.CODEX_HOME` |

⚠ 方案 A 的回滚是"单文件 + 一段"，比三家都轻。但注意顺序依赖：
先回滚 `codex.ts` 会让 Y 段红（期望的是新行为）——这是**正确**的红，
证明测试真在盯新代码；再删 Y 段，全绿。
