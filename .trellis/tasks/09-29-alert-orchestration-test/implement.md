# Implement: alertOrchestrate 纯函数边界

## 顺序清单

**关键：测试先行。** 先针对「现状逻辑」写测试并确认它能抓住 3 个历史 bug，再抽离。若先抽离再写测试，就失去了「抽离是重构、行为不变」的证据。

### Phase 1 · 回归基线（先立靶子）

- [ ] **1.1** 新建 `scripts/test-alert-orchestration.test-helpers.mjs`（或直接写在测试脚本内）
  - 用 `loadTs` 加载**真实**的 `smartBroadcast.ts` / `history.ts`（照 `scripts/test-read-model.mjs` 的写法）
  - 构造 `ProviderSnapshot` 夹具工厂：`okSnap(id, { balance, percent })`、`badSnap(id, status)`
  - **禁止**内联 `freshHits`/`latchKeys`/`mergeHits` 的副本
- [ ] **1.2** 写 T1 时序断言
  - 第一轮：history=[] → 记入 p1
  - 第二轮：history=[p1] 且余额比 p1 低 30 元 → **必须**命中 fluctuation
  - 反向锚点：若实现把本轮 p2 提前并入传给 `checkTriggers` 的 history，波动恒为 0，此断言变红
- [ ] **1.3** 写 T2 锁存断言
  - 同一余额连续两轮 → 第二轮 `nextLatched` 含该键；再喂同样的 `latched` → 返回 `null`
- [ ] **1.4** 写 T3 覆盖断言
  - `config.perProvider = { x: { balanceLow: 999 } }` → 余额 5 元**不**触发
  - 不带覆盖 → 触发
- [ ] **1.5** 写 T4/T5 分级与交互
  - `collapsed: false` + 仅有 routine 命中 → `null`
  - `collapsed: false` + routine 命中 → `nextLatched` **不含**该键（收起后仍能播）
- [ ] **1.6** 写 T6/T7/T8（缺失值 / cap / 空输入）
- [ ] **1.7** 确认此时测试**故意红**（因为 `alertOrchestrate.ts` 还不存在）—— 这是靶子立成的证据

### Phase 2 · 抽离

- [ ] **2.1** 新建 `src/renderer/src/alertOrchestrate.ts`
  - 按 design.md 的契约导出 `AlertContext` / `Decision` / `evaluate`
  - 严格照 `App.tsx:512-548` 的 6 步顺序搬移，**不优化、不改语义**
  - `now` 由参数传入，禁止 `Date.now()`
- [ ] **2.2** 改 `App.tsx` 的 `evaluateAlerts` 为薄封装
  - 组装 ctx（读 `alertCtxRef.current` + `Date.now()`）→ 调 `evaluate` → 落副作用
  - `persistHistory(d.nextHistory)` 仅在 `nextHistory !== ctx.history` 时调用
  - `alertLatchRef.current = d.nextLatched`
- [ ] **2.3** 跑测试，**必须转绿**（此时靶子证明行为未变）

### Phase 3 · 接线与验证

- [ ] **3.1** `package.json` 增 `test:alert-orchestrate` 并接入 `test` 链（**只能加这两处**）
- [ ] **3.2** 跑全量：
  ```bash
  npm run typecheck        # exit 0
  npm test                 # exit 0
  npm run build            # 无警告
  ```

### Phase 4 · 反向验证（必做，规范强制）

- [ ] **4.1** 注入 3 个历史 bug，确认各自变红：
  - 把 `evaluate` 改成「先 appendPoint 再 checkTriggers」→ T1 红
  - 让 `nextLatched` 取 `hits` 而非 `speakable` → T5 红
  - 把 `ctx.config.perProvider` 清空 → T3 红
- [ ] **4.2** 全部恢复后再跑一次，确认绿
- [ ] **4.3** 如实记录：是否有断言抓不到（假护栏）→ 补测试

## 你独占的文件

- 新建 `src/renderer/src/alertOrchestrate.ts`
- 新建 `scripts/test-alert-orchestration.mjs`
- 改 `src/renderer/src/App.tsx`（**只改 `evaluateAlerts` 及其调用**，其余不动）

**严禁触碰**：`speechOut.ts` / `smartBroadcast.ts` / `history.ts` / `VoiceReminderSection.tsx` / `SettingsView.tsx` / `PetBall.tsx` / `main/*` / `preload/*` / 其他 `.mjs` 测试。**不要 git commit。**

## 风险与回滚

| 风险 | 缓解 |
|------|------|
| 抽离改变行为 | Phase 1 先立靶子；Phase 2 转绿是行为不变的证据 |
| 破坏定时器契约 | `App.tsx` 侧仍走 ref 镜像，纯函数不闭包捕获 |
| 改动面扩散 | 文件所有权严格限定；`App.tsx` 只允许改 `evaluateAlerts` |

回滚点：`App.tsx` 的 `evaluateAlerts` 是唯一调用点，异常时直接 `git checkout` 该函数。
