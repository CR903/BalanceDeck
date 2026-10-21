# 端：系统通知静默失效（macOS 权限层吞弹）

应用一切正常、系统把通知吞掉，症状与「提醒逻辑有 bug」无法从应用内区分 —— Electron 静默成功，
无任何感知通路。

## 症状指纹

- 「阈值提醒没弹」，但应用侧判定纯函数单测全绿、锁存/落盘配置全对；
- 主进程 `notify:show` 返回 `true`（`ipc.ts` 不抛错：try/catch 只兜 `isSupported()` 与构造抛错）；
-照样不弹、不报错、不加日志。
- 2026-10-21 实查：ncprefs flags 缺「允许通知」位，当天 15:58 的告警被 macOS 吞掉。

## 归因法（先应用层，后权限层）

1. 判定层跑单测（`node scripts/test-system-notify.mjs`，全绿即排除逻辑回归）；
2. `secrets.bin` extras 读 `ui:notifyOn` / `ui:notifyConfig`（排除配置被关/阈值被改）；
3. `usage-history.json` 看越线时刻的采集点是否连续（排除应用没在跑）；
4. 三层全绿后查权限层：`plutil -convert xml1 -o - ~/Library/Preferences/com.apple.ncprefs.plist`
   找 bundle-id 的 **flags，检查 bit28（0x10000000，macOS 15.x「允许通知」位）**：
   开启通知的应用（微信/iTerm2/VS Code）flags≈276832270，关闭的（Chrome/本文 app）flags≈8396814。
   ⚠ 社区旧解码「允许通知 = bit25」在当前 macOS 已过时，实测以 bit28 为准。

## 对策（应用内无探测 API，只能用户自验）

- 「测试通知」按钮走**真实链路**（`notifyShow(testNotifyPayload())`），不直接 `new Notification`；
- 按钮**不受功能开关约束**（挂在 `{notifyOn && …}` 之外，且 sat 在「开关关」的 uitest 状态下断言）；
- 反馈措辞写明「**发起 ≠ 已显示**」+ 系统设置路径（系统设置 → 通知 → BalanceDeck → 允许通知）；
- 成功反馈 3s 消失、失败不消失（与 `showTestNote` 同构），timer ref **独立**防互相顶掉计时。

锚：`src/renderer/src/App.tsx:935`（testNotify）、`systemNotify.ts:247`（testNotifyPayload）、
`scripts/test-system-notify.mjs` J 区。根因取证：
`.trellis/tasks/10-21-test-notify-and-hint/research/macos-notify-findings.md`。
