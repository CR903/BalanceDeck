# Implement: AC7 重复提醒直到确认

## 文件所有权

| 文件 | 动作 |
|---|---|
| `src/renderer/src/alertOrchestrate.ts` | 改：加 `PendingAlert` 状态机 |
| `src/renderer/src/App.tsx` | 改：接线轮询定时器 + 确认回调 |
| `src/renderer/src/PetBall.tsx` | 改：确认条（泡泡的**兄弟节点**） |
| `src/renderer/src/skins.css` | 改：确认条样式（复用 token，禁硬编码颜色） |
| `scripts/test-alert-orchestration.mjs` | 改：补 AC7 断言段 |

**严禁触碰**：`smartBroadcast.ts` / `history.ts` / `speechOut.ts` /
`VoiceReminderSection.tsx` / `SettingsView.tsx` / `main/*` / `preload/*` / 其他 `.mjs`。**不要 git commit。**

## Phase 1 · 纯函数（可测部分）

- [ ] **1.1** `alertOrchestrate.ts` 加 `PendingAlert` / `REPEAT_MS` / `AUTO_CONFIRM_MS`
- [ ] **1.2** `AlertContext` 加 `pending`，`Decision` 加 `nextPending` + `reason`
- [ ] **1.3** `evaluate` 实现三步（详见 design.md）：
  - [ ] 新命中优先 → 开新批次，`reason='new'`
  - [ ] 否则有到期批次 → 复用其 `text`，`lastSpokenAt = now`，`reason='repeat'`
  - [ ] 否则 `text = null`，`reason = null`
  - [ ] 收尾裁剪 pending：条件解除 / 超窗自动确认 / 已确认
- [ ] **1.4** 导出 `confirm(pending, now)` 与 `pendingCountdown(b, now)`
- [ ] **1.5** **既有断言全部补 `pending: []` 字段**（ctx 多了一个必填项）

## Phase 2 · 断言（AC1–AC9）

新增段 `L. 重复提醒直到确认`：

| AC | 断言要点 |
|---|---|
| AC1 | `now = T0 + REPEAT_MS` 且无新命中 → `reason='repeat'`，`text` 与首次相同 |
| AC2 | `confirm()` 之后 `pending` 为空 |
| AC3 | `now = T0 + AUTO_CONFIRM_MS` → 该批被裁掉，`text=null` |
| AC4 | 确认后条件仍成立，`text=null` |
| AC5 | 条件解除（余额恢复）→ pending 清空**且** `nextLatched` 不含该键；再越阈值 → `reason='new'` |
| AC6 | 余额 + 耗尽两批同时待确认，`confirm` 只清掉被点的那批 |
| AC7 | 重复播报**不走**频率闸门（闸门在 `speechOut`，此处只管该不该播）；断言 1 分钟内的第二次重复不发生 |
| AC8 | 内存态：pending 不进 extras（静态断言，grep 源码无 `setExtras`/`pending` 落盘） |
| AC9 | 待确认期间出现新命中 → `reason='new'` 且新批次 `firstSpokenAt = now` |

**关键边界**：AC5 与 AC4 相反 —— AC4 是「条件仍成立但已确认 → 不播」，AC5 是「条件解除后再成立 → 又播」。两条必须都有，否则容易只实现一半。

## Phase 3 · UI 接线

- [ ] **3.1** `App.tsx`：`alertCtxRef` 加 `pending`；`evaluateAlerts` 落 `nextPending`
- [ ] **3.2** `App.tsx`：自重排 30s 轮询定时器（依赖数组**只含 `[ttsOn]`**）
- [ ] **3.3** `App.tsx`：`onConfirmAlert` 回调 → `confirm()` → 立即重评估
- [ ] **3.4** `PetBall.tsx`：确认条为泡泡的**兄弟节点**，带 `role="status"` + 真 `<button>`；
      **禁止**放进 `aria-hidden="true"` 的 `.petball-bubble` 内
- [ ] **3.5** `skins.css`：确认条样式，全部用 token

## Phase 4 · 验证（强制）

- [ ] **4.1** `npm run typecheck` exit=0
- [ ] **4.2** `npm test` exit=0（既有 14 套件 + 补断言后仍全绿）
- [ ] **4.3** `npm run build` 无新增警告
- [ ] **4.4** **反向验证**（逐个注入，确认变红后恢复）：

| 注入 | 期望 |
|---|---|
| 自动确认窗口改成 1 分钟（< 重复间隔） | L 段红 —— 复现「AC7 沦为空功能」 |
| 条件解除时不丢 pending | AC5 红 |
| 裁剪时漏掉超窗确认 | AC3 红 |
| `confirm` 清掉全部批次而非指定的 | AC6 红 |
| 重复时重算 text（而非复用） | AC1 红 |
| 把确认条塞进 `.petball-bubble` 内 | 静态守卫红（`aria-hidden` 内的交互元素） |

- [ ] **4.5** 如实记录哪些变异抓不到（假护栏）→ 补测试

## 风险

| 风险 | 应对 |
|---|---|
| 既有断言全部要补 `pending` 字段 | Phase 1.5 一次性做完；补完先跑一次确认仍全绿 |
| 确认条破坏无障碍 | Phase 4.4 最后一条变异专门守它 |
| 30s 轮询与数据推送重复触发 | 两者都走 `evaluateAlerts`，天然幂等（锁存 + pending 双重门） |
