# App.tsx 播报编排层测试

## Goal

把 `App.tsx` 中的播报编排逻辑抽成可测纯函数并补齐测试，堵住「3 个致命 bug 有 2 个出在测不到的代码」这个覆盖缺口。

## Background

父任务 `09-29-tts-smart-broadcast` 的盲审发现 3 个致命 bug，其中 2 个位于 `App.tsx` 的 `evaluateAlerts`：

1. **判定时序颠倒** —— 先记历史再判触发，导致「相邻两次采样之差」恒为 0，波动场景静默失效
2. **AC9 未实现** —— 每 60s 数据推送重播同一句
3. **按供应商覆盖双重失效** —— `perProvider: undefined` 丢弃 + 读法/写法不一致

盲审自己承认：**`App.tsx` 无自动化测试**，现有 M1/M2 断言是在引擎层模拟调用方时序，不是真的加载 `App.tsx`。仓库没有 React 测试设施。

**可行性已核实**（本轮读码确认）：`evaluateAlerts`（`App.tsx:512-548`）内部几乎不依赖 React —— 只读 `alertCtxRef.current` 与 `persistHistory`。6 步编排逻辑可整体抽出为纯函数，用**现有 `scripts/test-*.mjs` 断言风格**覆盖，无需引入 vitest/RTL 等新依赖。

## Requirements

### 功能需求

- **FR1**：抽出 `src/renderer/src/alertOrchestrate.ts`，承载 `evaluateAlerts` 的全部决策逻辑
  - 输入：一份不可变的 `AlertContext`（snapshots / history / config / triggerOn / format / hideBalance / muted / collapsed / latched / historyCap / now）
  - 输出：`{ text, urgent, nextHistory, nextLatched } | null`（`null` = 本轮不播）
  - **纯函数**：无 `Date.now()`、无 `setExtras`、无 ref 读取
- **FR2**：`App.tsx` 的 `evaluateAlerts` 改为薄封装：组装 ctx → 调纯函数 → 按结果落副作用（`persistHistory` / `speakOut`）
- **FR3**：新增 `scripts/test-alert-orchestrate.mjs`，接入 `npm test`

### 测试需求（必须覆盖 3 个历史致命 bug）

- **T1 时序**：断言 `checkTriggers` 收到的 `history` 是**上一轮**采样，本轮采样不提前入参
- **T2 锁存**：条件持续成立时第二轮返回 `null`（AC9）
- **T3 覆盖**：`perProvider` 生效 —— 引擎收到带覆盖的 config，且 App 写出的覆盖键与引擎读的一致
- **T4 分级**：展开态只放行 urgent（AC15），收起态放行全部
- **T5 锁存与分级交互**：展开态被挡下的例行项**不**锁存（收起后仍能播）
- **T6 缺失值**：`balance: null` 不触发余额预警
- **T7 历史封顶**：cap 生效
- **T8 空输入**：`snapshots: []` 返回 `null`

### 非功能需求

- **NFR1**：不引入任何新依赖（沿用 `loadTs` + 纯 node 断言）
- **NFR2**：测试必须加载**真实源码**（`quality-guidelines.md` 明令禁止内联副本）
- **NFR3**：抽出后 `App.tsx` 的 `evaluateAlerts` 行数显著减少，不引入新的 React 依赖
- **NFR4**：必须反向验证（故意改坏纯函数，确认对应测试变红）

## Acceptance Criteria

- [ ] **AC1**：`alertOrchestrate.ts` 为纯函数，`App.tsx` 内不再出现 `Date.now()` 参与编排决策
- [ ] **AC2**：T1–T8 全部有对应断言
- [ ] **AC3**：3 个历史致命 bug 各有至少 1 条**能在其复发时变红**的断言
- [ ] **AC4**：反向验证通过（注入 3 个历史 bug 全部变红）
- [ ] **AC5**：`npm run typecheck` exit=0
- [ ] **AC6**：`npm test` exit=0，且新套件已接入链
- [ ] **AC7**：无新增依赖（`package.json` 只增 test 脚本）
- [ ] **AC8**：`App.tsx` 行为不变 —— 抽离是重构，不得改变播报结果

## Risks

| 风险 | 应对 |
|------|------|
| 抽离时改变行为 | 先补测试（针对现状）再抽离；抽离后测试必须仍绿 |
| `alertCtxRef` 的 ref 镜像语义丢失 | 纯函数接收显式 ctx 快照，保持「不闭包」的原约定 |
| 未来 AC7 的确认状态机也要可测 | 纯函数的返回结构留出 `pending` 扩展位（不在本任务实现） |

## Notes

- 本任务是兄弟任务 `09-29-ac7-repeat-until-confirmed` 的**前置依赖**：AC7 的确认状态机需要落在同一个可测边界内
- 依据 `state-management.md`：本项目无自定义 hook、无状态库，答案就是「抽纯函数模块」—— 抽离方向与项目既有约定一致
