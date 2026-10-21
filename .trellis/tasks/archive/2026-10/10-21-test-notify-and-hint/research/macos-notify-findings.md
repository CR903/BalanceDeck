# macOS 系统通知排查结论（2026-10-21）

## 症状

用户报告：昨天（10-19）用量 80% 未弹系统通知。

## 排查证据链

1. **提醒逻辑层正确**：`src/renderer/src/systemNotify.ts` 判定纯函数 73 项测试全过
   （`node scripts/test-system-notify.mjs`）。
2. **本机配置正常**：`secrets.bin` extras 里 `ui:notifyOn=1`、
   `ui:notifyConfig={pctWarn:50,pctHigh:80,resetSoonHours:1}`、`ui:ttsOn=0`（语音关，不影响通知）。
3. **昨天应用在正常采集**：`usage-history.json` 中 inst:mu0kzo5p-enpbu 的「本月」窗口
   15:58 达 80.5%（越过 pctHigh=80，应弹「用量告警」），此后持续 >80 到 100，采集点
   全程无断档（约 15 分钟一点，夜里睡眠有长档，正常）。
4. **根因在系统层**：`~/Library/Preferences/com.apple.ncprefs.plist` 中
   `dev.zhouri.balancedeck` 的 `flags = 8396814` —— **bit28（0x10000000，「允许通知」位）= 0**。

### ncprefs flags 解码（macOS 15.7.7 实测）

| flags | 通知状态 | 本机样本 |
|---|---|---|
| 276832270（含 bit28） | ✅ 允许 | 微信、iTerm2、VS Code、飞书、WPS、Docker |
| 8396814（无 bit28） | ❌ 关闭 | Chrome、TablePlus、IntelliJ CE、**BalanceDeck** |

⚠ 社区旧解码（osquery 2020 gist）说「允许通知 = bit25」，在当前 macOS 上已过时，
**实测以 bit28 为准**（微信 flags = 8396814 + 2^28）。

## 机制：为什么应用毫无感知

- Electron 主进程 `new Notification().show()` 在 macOS 用户关闭通知权限时**静默失败**：
  不抛错、不回调、无日志（`ipc.ts` 的 try/catch 只兜 isSupported() 与构造抛错两种）。
- 应用侧「恰好一次」锁存（systemNotify.ts D3 / alertOrchestrate.ts ⑥）把该键记为
  「弹过」，条件持续成立期间永不重试 —— 弹了被系统吞 ≠ 没弹，但应用当它弹过了。
- Electron **没有应用内 API** 探测 macOS 通知授权状态 → 只能靠用户自验。

## 用户侧修复

系统设置 → 通知 → BalanceDeck → 打开「允许通知」。

## 对本任务的约束

- 加「测试通知」按钮走真实链路（notify:show IPC），让用户能自验链路通不通。
- 因为「发起 ≠ 已显示」无法被应用探测，反馈文案必须把系统设置引导写出来。
- **不得**动锁存/阈值判定 —— 排查已证明逻辑正确。
