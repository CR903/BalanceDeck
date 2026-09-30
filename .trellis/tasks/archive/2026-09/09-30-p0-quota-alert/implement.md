# Implement: P0-1 额度阈值提醒与系统通知

## Ordered Checklist

### Phase 1: 纯函数模块 systemNotify.ts

- [ ] **1.1** 新建 `src/renderer/src/systemNotify.ts`
  - [ ] `NotifyConfig` / `DEFAULT_NOTIFY_CONFIG`（`pctWarn:80` / `pctHigh:95` / `resetSoonHours:1`）
  - [ ] `NotifyPayload` 类型（`id` / `name` / `title` / `body` / `level: 'warn'|'high'|'reset'`）
  - [ ] `resolveNotifyConfig(raw)`：读取处校验（有限正数、`pctHigh > pctWarn`，脏值回退默认）
  - [ ] `checkNotify(snapshots, cfg, now)`：每供应商最多一条，取最严重 level；`status !== 'ok'` 或无窗口跳过
  - [ ] `buildNotifyBody(s, level)`：文案含窗口名 + 百分比；复用 `shared/quality.ts` 的 `staleLabel` 追加 `⚠ 缓存数据` / `⚠ 本机估算`
  - [ ] `notifyKey(payload)` = `'notify:' + id + ':' + level`
  - [ ] `freshNotifies(payloads, latched)` / `notifyLatchKeys(payloads)`（与 `freshHits` / `latchKeys` 同构）

### Phase 2: alertOrchestrate.ts 扩展

- [ ] **2.1** 扩展 `AlertContext`：增加 `notifyConfig: NotifyConfig`、`notifyLatched: Iterable<string>`
- [ ] **2.2** 扩展 `Decision`：增加 `notify: NotifyPayload | null`、`nextNotifyLatched: Set<string>`
- [ ] **2.3** `evaluate(ctx)` 在 TTS 编排之后：
  - [ ] 对 `ctx.snapshots` 跑 `checkNotify`（用 `ctx.notifyConfig`、`ctx.now`）
  - [ ] 用 `freshNotifies(payloads, ctx.notifyLatched)` 去重
  - [ ] `Decision.notify` = 去重后的最高优先级一条（或 null）
  - [ ] `Decision.nextNotifyLatched` = `notifyLatchKeys`(去重后的 payloads)（引用语义与 `nextLatched` 一致）
  - [ ] 整轮无快照（返回 null）时 `notify` / `nextNotifyLatched` 不产生

### Phase 3: 主进程 + preload IPC

- [ ] **3.1** `src/main/ipc.ts` 新增 `ipcMain.handle('notify:show', …)`
  - [ ] 校验 payload：`title` / `body` 非空字符串、`level ∈ {'warn','high','reset'}`、`id` / `name` 字符串
  - [ ] `new Notification({ title, body, silent: false }).show()`
  - [ ] 校验失败返回 `false` 并 `console.warn`，不抛异常
- [ ] **3.2** `src/preload/index.ts` 暴露 `notifyShow(payload): Promise<void>`（`ipcRenderer.invoke('notify:show', payload)`）
- [ ] **3.3** `src/renderer/src/api.d.ts` 增加 `notifyShow` 类型

### Phase 4: App.tsx 接线

- [ ] **4.1** 新增 extras 键读取：
  - [ ] `ui:notifyOn`（`'1'` / `'0'`，默认开）
  - [ ] `ui:notifyConfig`（JSON，经 `resolveNotifyConfig` 校验）
- [ ] **4.2** 新增 `notifyLatchedRef`（`useRef<Set<string>>`），在 `evaluateAlerts` 中：
  - [ ] 将 `notifyConfig` 与 `notifyLatched` 传入 `AlertContext`
  - [ ] 取回 `d.nextNotifyLatched` 更新 ref
  - [ ] 若 `d.notify !== null && notifyOn` → `window.api.notifyShow({ id, name, title, body, level })`
  - [ ] 在「供应商列表 / 配置变更」时重置 `notifyLatchedRef`（与 `alertLatchRef` 同一处）
- [ ] **4.3** 保存配置：设置页回调写入 `ui:notifyOn` / `ui:notifyConfig`

### Phase 5: 设置页 UI

- [ ] **5.1** `VoiceReminderSection.tsx` 新增「系统通知」分组
  - [ ] 总开关（class `vrs-notify-on`）
  - [ ] 三个数字输入：提醒阈值（`vrs-notify-warn`，默认 80）、强提醒阈值（`vrs-notify-high`，默认 95）、重置前小时数（`vrs-notify-reset`，默认 1）
  - [ ] 文案说明「系统通知与语音播报互相独立」
  - [ ] 阈值校验：`pctHigh > pctWarn`，非法时禁用保存并提示

### Phase 6: 测试

- [ ] **6.1** 新建 `scripts/test-system-notify.mjs`
  - [ ] 覆盖 design.md Tests Required 第 1-7 条
- [ ] **6.2** 扩展 `scripts/test-alert-orchestration.mjs`
  - [ ] 覆盖 `Decision.notify` / `nextNotifyLatched`（第 8-9 条）
- [ ] **6.3** `package.json` 增加 `test:system-notify` 并接入 `npm test` 链
- [ ] **6.4** 跑 `npm test` 与 `npm run typecheck` 全绿
- [ ] **6.5** `npm run shots`（或 `electron . --uitest`）走查设置页「系统通知」分组可见可配

## Review Gates

- [ ] `npm test` 通过（含新增 `test:system-notify`）
- [ ] `npm run typecheck` 通过
- [ ] 手动冒烟：在设置页开启系统通知 → 把 `pctWarn` 临时调低触发一次通知 → 确认 macOS/Windows 弹出、去重生效（不重复弹）
- [ ] `trellis-check` 子代理对照 prd.md 验收标准逐条复核

## Rollback

- 纯增量功能：`ui:notifyOn` 默认开，用户可一键关闭；代码层面删除 `systemNotify.ts` 及相关接线即可回退，无数据迁移。