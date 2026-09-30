# Design: TTS 播报无声修复

## 边界与契约

### 改动点

| 文件 | 改动 | 风险 |
|---|---|---|
| `src/renderer/index.html` | CSP 加 `media-src 'self' blob:` | 红线，但只新增、不外连 |
| `src/renderer/src/speechOut.ts` | `playElement` 失败路径改 reject；`speakViaTts` 包装 `TTS_PLAYBACK` 原因 | 改错误契约，ripple 到 `playOne`/`onTtsFailed` |
| `scripts/test-structure.mjs` | 新增 F 守卫：`media-src` 含 `blob:` | F1（`connect-src` 锁）不动 |
| `scripts/test-speech-out.mjs` | 新增播放失败四路径断言 | 复用 FakeAudio 的 onerror/play-reject 能力 |

### 不改的

- `connect-src` / `default-src` / `script-src` / `img-src` / `style-src` 逐字不动。
- `playElement` 的 `active` 抢占 / 打断语义不变（打断仍 resolve，不是失败）。
- `requestAudioBlob` 的重试/401 不重试/原因码映射一行不动。
- `onTtsFailed` / `onTtsOk` 的调用点（`App.tsx`）不动——契约不变，只是 `onTtsFailed` 现在能真触发了。

## 数据流（修复后）

```
requestAudioBlob(text)          // 经 window.api.ttsSpeak → 主进程 → 字节回渲染层
  └─ Blob
URL.createObjectURL(blob)       // blob: URL
  └─ new Audio(url)
       └─ playElement(el)       // ★改：onerror/play-reject → reject(包装 TTS_PLAYBACK)
            ├─ onended          → resolve()           → speakViaTts resolve → onTtsOk（试听正常）
            ├─ 被打断            → resolve()           → 同上（打断不是失败）
            ├─ onerror          → reject(TTS_PLAYBACK)→ speakViaTts throw
            └─ play() rejected  → reject(TTS_PLAYBACK)→ 同上
                                                          ↓ playOne catch
                                                          ├─ onTtsFailed(TTS_PLAYBACK: …)
                                                          └─ fallback? speakViaSystem : return
```

## 关键决策

### D1：`media-src` 为什么放 `'self' blob:` 而不是只 `blob:`

`'self'` 保留是防御性的：万一未来有 `<audio src="./local.wav">` 之类的同源本地音频，不被这条改动误伤。`blob:` 是本次必须放的。不放 `data:`（音频不需要 data URL 内联，避免给将来埋「整段音频内联进 HTML」的口子）。不放 `http`/`https`/`*`——那才是真正破红线的外连。

### D2：为什么用 `TTS_PLAYBACK` 前缀而不是新 reason 对象

`onTtsFailed` 现签名是 `(reason: string) => void`，调用方（`App.tsx:614`）直接把 reason 拼进 `没播出来：${reason}`。改签名要动调用方、动测试、动 `ProbeEvent` 类型。前缀方案零侵入：`describeError(e)` 前拼 `TTS_PLAYBACK:`，调用方零改，测试用 `startsWith` 判别。代价是 reason 是字符串约定而非类型——可接受，与既有的 `TTS_UNREACHABLE` / `TTS_HTTP_*` 同族（都是字符串前缀约定）。

### D3：probe 语义的副作用（已接受）

真实播报（`bill=true`）播放失败 → `onTtsFailed` → `stepProbe('fail', reason)` → 探测指示器翻「不可达」。严格说服务是可达的（字节回来了），只是播放层坏。但：
1. 本任务同时修了 CSP，播放层不再因 CSP 坏；
2. 剩下能触发该路径的是解码错误等罕见情形；
3. 此时用户的确没听到播报，标 fail 不算误导。

不为此引入「probe 区分网络失败与播放失败」——那是 scope creep，留作未来改进。在 spec 里记一笔。

### D4：测试播报（bill=false）播放失败时的回退

`ctx.fallback` 是用户设置。若开着回退，测试播报播放失败会：显示「没播出来：TTS_PLAYBACK: …」**并**念系统语音。略矛盾（在测 TTS 却听到系统语音），但失败文案已说明，且本任务修了 CSP 后该路径基本不触发。不为它特判 `bill` 抑制回退——会割裂 `playOne` 的统一回退语义。

### D5：`speakViaTts` 的 finally 必须仍释放

改 reject 后，`speakViaTts` 的 `try { playElement } finally { revokeObjectURL }` 结构保留——`finally` 在 throw 时仍执行，blob URL 不泄漏。AC7 钉死。

## 反向验证清单（commit 前跑）

每条单独 mutate，确认对应断言变红、其余不动：

1. CSP 去掉 `media-src` → AC1/AC8 红
2. CSP 把 `blob:` 换成 `data:` → AC10 红
3. `playElement` onerror 仍 resolve → AC3/AC4/AC6 红
4. `playElement` onended reject → AC3（onended 路径）红
5. `playElement` 打断 reject → AC3（打断路径）红
6. `speakViaTts` 不包装 `TTS_PLAYBACK` → AC5 红
7. `finally` 移到 `try` 外 / 删掉 → AC7 红
8. F 守卫改成只判 `media-src` 存在（不验 `blob:`）→ 反验断言失守

## 不在本任务范围

- probe 指示器区分「网络失败」与「播放失败」（D3 副作用，未来改进）。
- 测试播报抑制系统语音回退（D4，割裂语义，不做）。
- 真机 AC2 验收（需用户点「测试播报」，本环境无法代替）。
