# 提醒链路（frontend）：阈值 → 锁存 → 通知/TTS

适用：改语音播报/系统通知、排查「提醒不响 / 重复响 / 不该响的响了」。
核心观念：**编排收口在一个纯函数；TTS 与通知各有独立阈值与锁存；系统通知与 TTS 出网都只在 main 发。**

## 两套阈值体系（都是 shared 唯一真相，但互不相干）

- **视觉分级**（卡片/托盘/岛）：`src/shared/levels.ts:14 levelOfPercent`，≥85 danger / ≥60 warn。
- **提醒判定**：**不用** `levelOfPercent`——TTS 用 `smartBroadcast.ts` 的 `TriggerConfig`（5 场景：balance/fluctuation/exhaustion/idle/abnormal，`TRIGGER_LEVEL`:89），通知用 `systemNotify.ts` 的 `NotifyConfig`（3 档：warn>80% / high>95% / reset<1小时）。总量率取自 `read-model.maxPercent`。

## 完整通路

```
采集推送 main pushState → App.tsx:984 onState
   ▼
evaluateAlerts (App.tsx:744-767)
   ① 数据变化时评估 (useEffect [ttsOn, notifyOn, snapshots], :808-812)
   ② 30s 到期重复评估 (ALERT_TICK_MS, :820-841 —— AC7 重复提醒)
   ▼
alertOrchestrate.evaluate(ctx)   ← 纯函数，收口一切编排（alertOrchestrate.ts:165-260）
   ├─ checkTriggers (smartBroadcast.ts:187)   TTS 判定+文案
   ├─ freshHits/hitKey (:251/:265)            TTS 锁存去重（Key = "id kind"）
   ├─ mergeHits (:293)                        同轮多命中合 1 条
   ├─ appendPoint (history.ts, alertOrchestrate.ts:173-184)
   │     ⚠️ 顺序承重：判定用**上一轮** hist，否则 adjacent diff 恒 0
   └─ checkNotify (systemNotify.ts:195)       通知判定
         ├─ freshNotifies/notifyKey (:270/:283)  通知锁存
         └─ worstNotify (:294)                   同轮多供应商只出最重 1 条
   ▼ Decision { text, urgent, notify, nextLatched, nextNotifyLatched, … }
```

出口：
- **通知**：`App.tsx:752 window.api.notifyShow(d.notify)` → main `ipc.ts:374-397 'notify:show'` → `new Notification(...)`（:394）。**Notification 只在 main 发**——渲染层 `systemNotify.ts:1-15` 明确「渲染层只判定不弹」。
- **TTS**：`App.tsx:765 speakOut(d.text, urgent, bill)` → `speechOut.flush`（speechOut.ts:318）→ **频率闸门 `allowCall`**（:125，1/分 · 10/时，`bill` 决定是否计入）→ `playOne`(:372) → `speakViaTts`(:421) → `requestAudioBlob`(:500，2 次重试，401/403=TtsAuthError 不重试) → `audio.play()`；失败按配置回退 `speakViaSystem`(:486，声调/选声逻辑在 voice.ts)。

## 跨进程边界（三件事都别在渲染层做）

1. **系统通知的弹**：main 独占（见上）。
2. **TTS 的出网**：CSP `connect-src 'self'` 导致渲染层 fetch 不出网（speechOut.ts:11-15 注释）——`speechOut` 的 HTTP 走 `window.api.ttsSpeak` IPC → main `tts:speak`；页面只管播 Blob。token 明文不进渲染层（App.tsx:222-228，`ttsHasSecret` 只知道有没有）。
3. **macOS 权限层吞弹**的应用内区分手段（真实链路测试按钮）见 [system-notify-silent-failure](../troubleshooting/system-notify-silent-failure.md)。

## 锁存都是内存态

`notifyLatchRef`（App.tsx:195）、`alertLatchRef`（:605）——**重启即清空**，不落盘。若要「重启后不再重复提醒」需新增持久化时要考虑这条。

## 验证

`npm run test:trigger-engine`（播报触发纯函数）、`npm run test:alert-orchestration`（编排+配置静态协调）、`npm run test:speech-out`（播出口契约）、`npm run test:system-notify`（notify payload 钉死）。
