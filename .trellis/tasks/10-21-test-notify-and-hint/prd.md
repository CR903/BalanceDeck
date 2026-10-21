# 系统通知测试按钮与失效引导

## 背景与问题

2026-10-21 排查实锤：BalanceDeck 的系统通知在用户 macOS 里是关闭的（`com.apple.ncprefs.plist`
flags 缺「允许通知」位），而 Electron 的 `Notification` 在权限被系统关掉时**静默失败**——
不抛错、无回调、应用无感知。叠加应用侧「恰好一次」锁存（弹过即记键，条件持续期间不重试），
形成最难查的静默失效形态：用户以为收到了提醒，实际一条都没到。

Electron 没有应用内 API 探测 macOS 的通知授权状态，所以只能靠**用户自验**：
给一个「测试通知」按钮 + 一条「没收到就去系统设置开权限」的引导。

## Goal

让用户能一眼确认「这条系统通知链路通不通」，不通时有明确的下一步指引。

## Requirements

1. 设置页「系统通知」分区（VoiceReminderSection 的 E 区，`ui:notifyOn` 开关下方）加一个
   **「测试通知」按钮**：点击后走真实链路（渲染层拼 payload → `notify:show` IPC → 主进程
   `new Notification().show()`），弹出标题「BalanceDeck 测试通知」。
   - 走真实链路而不是直接 `new Notification`：测的就是用户真正会走的那条路，包括 IPC 与
     主进程校验。
   - 不受 `ui:notifyOn` 开关约束：测试按钮必须在开关关闭时也能用（否则没法验证「开了开关
     却不弹」的场景）。
2. 按钮点击后给**可见反馈**：通知调用完成后，在按钮旁显示「已发起通知（若未看到，去
   系统设置 → 通知 → BalanceDeck 打开允许通知）」的提示，3 秒后消失（与「测试播报」的
   showTestNote 同族交互）。因为 macOS 静默失败无法被应用探测，反馈措辞必须把
   「发起 ≠ 已显示」讲清楚。
3. 「系统通知」分区文案补一句**常驻引导**（不在 `{ttsOn && …}` 之内，与 E 区同层）：提示
   macOS 用户若从未收到过通知，先去系统设置 → 通知 → BalanceDeck 检查「允许通知」。

## Acceptance Criteria

- [ ] AC1 点击「测试通知」后，macOS 通知中心出现标题「BalanceDeck 测试通知」的横幅
      （前提：系统通知权限已开启）。
- [ ] AC2 系统通知权限被关闭时，点击按钮不报错、不抛异常，应用给出「若未看到请检查
      系统设置」的可见提示（不静默）。
- [ ] AC3 「测试通知」在 `ui:notifyOn` 关闭时仍可点击、仍会发起通知。
- [ ] AC4 设置页「系统通知」分区有常驻的系统设置引导文案。
- [ ] AC5 测试通知的 payload 与真实提醒同构（title/body/level 合法，能过 `notify:show`
      的逐字段校验），并在其结果为 false（isSupported=false / 校验拒绝）时把原因写进
      可见反馈。
- [ ] AC6 现有测试全绿：`npm run test:system-notify`（或对应 scripts 套件）与 UI 测试
      （`uitest` 相关断言不回退）。

## Out of Scope

- 不做应用内探测 macOS 通知授权状态（Electron 无 API，不做 hack）。
- 不动锁存/去重逻辑与阈值判定（上一任务刚验收过，2026-10-21 排查结论是逻辑正确）。
- 不改 Windows/Linux 的行为差异（复用现有 notify:show 已覆盖）。

## Notes

- 排查结论（含 ncprefs flags 解码法）已沉淀 mnemon（insight imp5）与本 PRD。
- 本机 macOS 15.7.7；「允许通知」位 = flags bit28（bit25 旧解码已过时）。
