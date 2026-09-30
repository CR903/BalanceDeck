# TTS 播报无声：CSP media-src 缺失 + playElement 吞播放失败

## Goal

修复「测试播报提示成功但没有声音」：上一批 TTS 请求迁移到主进程（`4c70640`）后字节已经能回到渲染层，但 `<audio>` 加载 `blob:` URL 被 CSP 拦死，且 `playElement` 把播放失败吞成 resolve，使 `onTtsOk` 永远触发——成功提示与真实出声之间没有因果关系。

## Background（为什么前几轮没发现）

- 旧链路里 `connect-src` 把 `fetch` 拦在更前面，请求从未成功，永远走 `onTtsFailed`，Bug 2 没机会暴露。
- 请求搬进主进程后请求通了，Bug 1（CSP 漏 `media-src`）浮上来，Bug 2 立刻把它伪装成「成功」。
- 两个 bug 是同一现象的两层，必须一起修：只修 Bug 1，Bug 2 仍会在未来某次播放失败时撒谎；只修 Bug 2，Bug 1 会如实报「没播出来」但依然没声音。

## Requirements

### 功能需求

- **FR1**：`src/renderer/index.html` 的 CSP 新增 `media-src 'self' blob:`，放行本地 blob 音频（与 `img-src` 允许 `blob:` 同理，不外连）。
- **FR2**：`playElement`（`speechOut.ts:438`）在 `onerror` 或 `play()` 被拒时 `reject`；`onended` 与被打断仍 `resolve`。
- **FR3**：`speakViaTts` 把播放失败抛上去，使 `playOne` 走 `onTtsFailed` 而不是 `onTtsOk`。
- **FR4**：播放失败的原因串带 `TTS_PLAYBACK` 前缀，与请求失败（`TTS_UNREACHABLE` / `TTS_HTTP_*` / `TTS_AUTH`）可区分。
- **FR5**：测试播报（`bill=false`）播放失败时显示「没播出来：…」，不再显示「试听正常」。
- **FR6**：真实播报（`bill=true`）播放失败仍按既有回退策略走系统语音（`opts.fallback` 为真时）。

### 非功能需求

- **NFR1**：CSP 红线只**新增** `media-src 'self' blob:`，`connect-src` / `default-src` / `script-src` / `img-src` / `style-src` 逐字不动。
- **NFR2**：不引入新依赖，不新增外部网络出口。
- **NFR3**：`playElement` 的「打断不抛、失败才抛」语义保持——被新播报打断不是失败（既有 `active` 抢占逻辑不变）。
- **NFR4**：测试断言只读真实源文件（`loadTs`），不内联副本；不删既有断言。

### 约束

- `media-src 'self' blob:` 只放行 `blob:`（主进程已收到的本地字节），不放 `data:`（音频不需要 data URL 内联）。
- `playElement` 改 reject 后，`speakViaTts` 的 `finally` 释放 blob URL 必须仍执行（不能因为抛错而泄漏）。
- 真实播报播放失败 → `stepProbe('fail', …)` 会把探测状态翻成 fail。这在「服务可达但播放层坏」时会把指示器标成「不可达」，属可接受副作用（本任务同时修了 CSP，播放层不再会因 CSP 坏；仅解码错误等罕见路径会触发，且此时用户的确没听到播报，标 fail 不算误导）。见 design.md「probe 语义」。

## Acceptance Criteria

- [ ] **AC1**：`index.html` CSP 含 `media-src 'self' blob:`，其余指令逐字不变。
- [ ] **AC2**：点「测试播报」能听到声音（真机验收，本环境无法代替）。
- [ ] **AC3**：`playElement` 在 `onerror`/`play()` 被拒时 reject，`onended`/打断仍 resolve（单测覆盖四条路径）。
- [ ] **AC4**：播放失败时 `onTtsFailed` 触发、`onTtsOk` 不触发（单测覆盖）。
- [ ] **AC5**：播放失败原因串以 `TTS_PLAYBACK` 开头（单测覆盖）。
- [ ] **AC6**：测试播报播放失败显示「没播出来」，不再显示「试听正常」（单测覆盖）。
- [ ] **AC7**：`speakViaTts` 抛错时 blob URL 仍被 `revokeObjectURL` 释放（单测覆盖，无泄漏）。
- [ ] **AC8**：`test-structure.mjs` F1（`connect-src` 逐字锁）仍绿；新增 F 守卫：`media-src` 含 `blob:`。
- [ ] **AC9**：7 套测试全绿，typecheck 与 build 通过。
- [ ] **AC10**：CSP 改动不外连——`media-src` 只含 `'self' blob:`，不含 `http`/`https`/`*`。

## Notes

- 根因定位证据：CSP 无 `media-src` → 回落 `default-src 'self'`；`img-src` 显式列 `blob:` 证明 `default-src` 管不到 `blob:`，故 `<audio>` 的 blob URL 被拦。
- `playElement` 现契约（`speechOut.ts:438` 注释）："结束/失败/被打断都会 resolve（失败不重试，只记日志）"——这是 Bug 2 的源头，本次改契约。
- F1 守卫（`test-structure.mjs:471`）只锁 `connect-src`，加 `media-src` 不破它。
