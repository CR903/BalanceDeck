# Implement: TTS 播报无声修复

## 执行清单（按序）

### 1. CSP 加 media-src
- [ ] `src/renderer/index.html`：CSP `content` 末尾加 `media-src 'self' blob:`（插在 `connect-src` 之前、紧跟 `img-src` 之后——CSP 指令顺序无功能影响，`connect-src` 的值逐字不动）。
- [ ] 不动其余任何字符。

### 2. playElement 改契约
- [ ] `src/renderer/src/speechOut.ts:438` `playElement`：`onerror` 与 `play()` 被拒时改 `reject(new Error('TTS_PLAYBACK: ' + describeError(e)))`；`onended` 与被打断仍 `resolve()`。
- [ ] `settle()` 拆成 `settleResolve()` / `settleReject(err)`，或保持单一 settle 但带 ok 标志——选哪个看改完哪个更清楚，**不引入新公共 API**。
- [ ] 注释（438 行那条"结束/失败/被打断都会 resolve"）改写为新契约。

### 3. speakViaTts 包装原因
- [ ] `speakViaTts`（421 行）：`playElement` reject 时，错误已是 `TTS_PLAYBACK: …` 前缀（在 playElement 里拼，speakViaTts 只透传）。
- [ ] `finally { revokeObjectURL }` 保留。
- [ ] 不在 speakViaTts 里二次包装——前缀在 playElement 拼一次即可，避免 `TTS_PLAYBACK: TTS_PLAYBACK: …`。

### 4. test-structure.mjs F 守卫
- [ ] F1（`connect-src` 逐字锁）不动。
- [ ] F1b 新增：`media-src` 命中且值含 `blob:`，且不含 `http`/`https`/`*`。
- [ ] 断言失败信息按既有风格（`F1b media-src 含 blob: 且不外连（实际 …）`）。

### 5. test-speech-out.mjs 播放失败四路径
- [ ] 复用 `FakeAudio`，扩展：支持 `autoError`（构造后异步 `onerror?.()`）与 `autoPlayReject`（`play()` 返回 `Promise.reject`）。
- [ ] 新增 L 段或扩展 M 段，断言：
  - `onerror` → `onTtsFailed` 触发、`onTtsOk` 不触发、reason 以 `TTS_PLAYBACK` 开头（AC3/AC4/AC5/AC6）
  - `play()` reject → 同上
  - `onended`（正常）→ `onTtsOk` 触发（AC3 onended 路径）
  - 被打断 → `onTtsOk` 不触发且不报失败（AC3 打断路径）——复用既有打断测试设施
  - `revokeObjectURL` 配平在播放失败路径仍成立（AC7）

### 6. 验证
- [ ] `node scripts/test-structure.mjs`
- [ ] `node scripts/test-speech-out.mjs`
- [ ] 全套：`for s in scripts/test-*.mjs; do node "$s" || break; done`
- [ ] `npx tsc --noEmit`
- [ ] `npm run build`
- [ ] 反向验证清单 D3 的 8 条 mutate

### 7. 提交
- [ ] 6 个文件（index.html / speechOut.ts / test-structure.mjs / test-speech-out.mjs + 可能的 spec 笔记）。
- [ ] commit message 按 `commit-message.md` 规范。

## 回滚点

- 单次提交即可回滚：`git revert <sha>`。
- CSP 改动是单行，回滚无依赖。
- `playElement` 契约改动的 ripple 仅限 `speakViaTts`/`playOne`，回滚该文件即恢复。

## Review Gates

- 改完步骤 1-3 后先跑 `test-structure.mjs` + `test-speech-out.mjs`，红就停下。
- 步骤 4-5 的断言加完前不提交。
- 反向验证全部红在预期断言上才提交。
