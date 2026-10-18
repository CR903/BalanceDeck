# 实施计划：uitest 时序脆弱断言收口

## 0. 前置

- 依赖：无。
- 读：`prd.md` → `design.md` → `.trellis/spec/frontend/quality-guidelines.md`（无 linter/无 CI、断言脚本纪律、先弄坏一次）→ `docs/knowledge/agents/subagent-verify.md`（"先证明不是我引入的"复用手法）。
- 纪律：**只改测试与测试工具**，一行产品代码都不许动（若发现必须动，停下来写清理由再决定）。
- 跑法纪律：每轮 uitest 用**独立临时 `BD_USER_DATA`**，绝不用真实 userData（会与用户常驻实例抢 `secrets.bin` / `usage-history.json` / `state.json`）。

## 1. 有序清单

### 步骤 1：基线先行（先量，再修）

- [ ] 新增 `scripts/uitest-baseline.mjs`（`design.md` §4 形状；解析 stdout JSON；独立临时 userData；输出逐键通过率 / 翻转键 / 每轮耗时 / 失败诊断）。
- [ ] 给它一份**构造 JSON 的自检**：喂含已知翻转键的假数据 → 断言算出的通过率与翻转集合正确。
- [ ] 用当前代码跑 **3 轮**，把数字填进 `prd.md` 的 `<!-- BASELINE_TABLE -->`（逐键通过率 + 翻转键 + 耗时）。
- [ ] **G1**：基线表落地（这是修复前的对照物；没有它，"修好了"无法证明）。

### 步骤 2：轮询助手收敛

- [ ] 把既有 `waitFor`（`uitest.ts:1794`）收敛成唯一实现 `pollCheck(condJs, {mode, budgetMs, stepMs, diagJs})`（`design.md` §2 契约），提升到文件顶部，dock/岛段落改为调用它（**不许留两套**）。
- [ ] 断言 `absent` 等满预算、失败带 `diag` 两条纪律各有一条自检或至少一次手工验证。
- [ ] 跑一次 `--uitest`：既有键集合不变（AC9）。

### 步骤 3：按分类逐批改造（每批跑一次 uitest）

- [ ] 产出分类清单（39 处逐条：键名 + 行号 + ①/②/③ + 理由），写进日志「改了什么」节。
- [ ] 批次 A：设置页段（含 `intervalFlash` 这个最典型的坏例：`sleep(900)` → 查瞬时 `.saved-flash`）。
- [ ] 批次 B：卡片/详情页段（`.card`/`.pcard-grid`/`.dwin` 等）。
- [ ] 批次 C：岛/托盘/dock 段（把已有 `waitFor` 用法统一到 `pollCheck`，保持既有语义）。
- [ ] 批次 D：其余（语音提醒段、皮肤段、夹具段）。
- [ ] **G2**：分类清单逐条有行号；①类全部改完、③类全部改成"先等消失再断言"。

### 步骤 4：棘轮守卫

- [ ] `scripts/test-structure.mjs` 加整文件计数守卫（`design.md` §5；默认 `<= 0`，若②类无法归零则改为显式白名单 + 逐条理由）。
- [ ] 弄坏一次：加回一处瞬时判据 → 守卫红；还原 → 绿。
- [ ] **G3**：守卫先红后绿（实测记录）。

### 步骤 5：修复后 5 轮验证 + 产品竞态判定

- [ ] 跑 5 轮：**翻转键 = 0**，`intervalFlash` 5/5 `ok`，键总数与修复前相同（AC4/AC9）。
- [ ] 记录修复前后各 3 轮墙钟，确认 ≤ 现状 ×1.5（AC6）。
- [ ] 对每个曾观测 flaky 的键（`intervalFlash` / `dockSettings` / `grpUnknownBucket` / 岛上夹具簇 / 那次整轮挂死）做 `design.md` §7 的判定：**测试时序 bug 还是产品竞态**；产品竞态项给复现命令并写进「存疑」（AC5）。
- [ ] `npm run typecheck` + `npm test` 全绿（`qa/` 属 `tsconfig.node.json`）。

### 步骤 6：文档

- [ ] `docs/daily/2026-10-18_uitest-timing-hardening.md`（按 `docs/template.md`：起因/改了什么/设计取舍/取证(命令+原始输出)/护栏弄坏一次的红集/未完成-存疑/后续）。
- [ ] `docs/index.md` 加一行；`docs/knowledge/agents/uitest-timing.md` + `docs/knowledge/agents/index.md` 加行（P2 门禁）。
- [ ] 若 10-07 的遗留第①条因此可判（`.trend-*` 断言不存在这件事），在日志里点明，供 10-07 收尾时引用。

## 2. 验证命令

```bash
node scripts/uitest-baseline.mjs --runs 3          # 修复前基线
node scripts/uitest-baseline.mjs --runs 5          # 修复后（翻转键必须为 0）
npm run typecheck
npm test
node scripts/test-structure.mjs                    # 棘轮守卫
```

## 3. 审查门

- **G1（步骤 1 后）**：基线表落地，且基线脚本的构造自检通过 —— 数字不可信就不许往下走。
- **G2（步骤 3 后）**：分类清单逐条有行号；①③类改完。
- **G3（步骤 4 后）**：棘轮守卫先红后绿。
- **G4（步骤 5 后）**：5 轮翻转键 0 + 墙钟 ≤1.5× + 产品竞态判定表齐全。

## 4. 回滚点

| 回滚点 | 位置 | 影响 |
|---|---|---|
| R1 | 步骤 1 之后 | 基线脚本是纯新增，回滚不影响任何既有产物 |
| R2 | 步骤 2-3 之后 | `qa/uitest.ts` 单文件 revert 即回现状；棘轮守卫与基线脚本可独立保留 |
| R3 | 步骤 4 之后 | 守卫是 `test-structure.mjs` 的一段，独立 revert |

## 5. 完成后

- `trellis-check`（重点核查：①分类清单是否真逐条核对过 ②有没有用"加大 sleep"换绿 ③产品竞态是否被轮询掩盖）→ `trellis-update-spec`（把"断言必须等条件成立、不许单点取值"写进 `frontend/quality-guidelines.md`）→ commit → `/trellis:finish-work`。
