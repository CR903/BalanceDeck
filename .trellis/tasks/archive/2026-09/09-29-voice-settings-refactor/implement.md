# Implement: 语音设置重构与播报故障修复

## 文件所有权

| 文件 | 动作 |
|---|---|
| `src/renderer/src/speechOut.ts` | 改：`SpeechItem.bill`；`TtsConfig.style`；停止硬编码 style |
| `src/renderer/src/VoiceReminderSection.tsx` | 改：音色/风格下拉；文案；测试播报标记不计费 |
| `src/renderer/src/SettingsView.tsx` | 改：删除性别下拉及其 props |
| `src/renderer/src/App.tsx` | 改：性别现算；不可达退避探测；测试播报不计费 |
| `src/shared/pet.ts` | 改：加 `petGender` 映射 |
| `src/shared/tts-preset.ts` | 新建：21 音色 + 11 风格纯数据 |
| `src/renderer/src/skins.css` | 改：音色下拉分组样式（复用 token） |
| `scripts/test-speech-out.mjs` | 改：补计费断言 |
| `scripts/test-voice.mjs` | 改：补 petGender 映射断言 |

**严禁触碰**：`alertOrchestrate.ts` / `smartBroadcast.ts` / `history.ts` / `PetBall.tsx` / `main/*` / `preload/*` / 其他 `.mjs`。**不要 git commit。**

## Phase 1 · 缺陷修复（先做，风险最高、价值最直接）

- [ ] **1.1** `SpeechItem` 加 `bill: boolean`；`playOne` 改为 `if (item.bill && !allowCall(...)) return`
- [ ] **1.2** `enqueue`/`speakOut` 透传 `bill`；App 的定时与预警路径传 `true`，测试播报传 `false`
- [ ] **1.3** **确认测试播报走的是 `speakOut` 而非别的路径**（读 `App.tsx` 的 `testSpeak` 再动手）
- [ ] **1.4** 不可达退避探测：置位后排程 `5s/15s/1min/5min`，成功即清除；用尽停止
- [ ] **1.5** 探测复用请求函数但**不 enqueue**（不发声、不计费）

## Phase 2 · 性别改造

- [ ] **2.1** `shared/pet.ts` 加 `petGender(id): 'female' | 'male'`
- [ ] **2.2** `App.tsx`：`alertCtxRef.gender` 每轮从 `pet.id` 现算，删除 `voiceGender` state
- [ ] **2.3** `SettingsView.tsx` 删除「语音播报音色」下拉、`voiceGender` / `onSetVoiceGender` props
- [ ] **2.4** `ui:voiceGender` 停止读写（确认无残留引用）

## Phase 3 · 音色与风格

- [ ] **3.1** 新建 `src/shared/tts-preset.ts`：21 音色 + 11 风格，抄自服务页面
- [ ] **3.2** `TtsConfig` 加 `style`；`requestAudioBlob` 用 `config.style` 而非硬编码 `'general'`
- [ ] **3.3** 读取旧 `ui:ttsConfig` 时补 `style` 默认值（无 `style` 的老配置不崩）
- [ ] **3.4** UI：音色下拉按性别 `<optgroup>` 分组；风格下拉
- [ ] **3.5** 切换预设时同步 `voice` + `style`（沿用已有的 `presetConfig` 同步机制）

## Phase 4 · 文案

- [ ] **4.1** 不可达提示改口语化 + 给下一步
- [ ] **4.2** 测试播报成功/失败都要有反馈（成功「试听正常」并自动消失；失败说明原因 + 下一步）
- [ ] **4.3** 全仓 grep 确认无「回退」「通路」等术语残留于用户可见文案

## Phase 5 · 测试（必须覆盖三个缺陷的复发）

| 缺陷 | 断言要点 |
|---|---|
| 缺陷 1 | `bill: false` 的 item 在 1 分钟内连续 3 次 → 3 次都通过闸门；`bill: true` 仍被拦（AC5 + AC6 同时守） |
| 缺陷 2 | 失败置位后，探测成功 → `unreachable` 转 false；退避用尽后不再重试 |
| 缺陷 3 | 文案断言：不含实现术语，且含「检查」类行动词 |
| 性别 | `petGender('aria')='female'` / `petGender('ray')='male'` |
| 风格 | `config.style` 真的进了请求体（不是硬编码 `'general'`） |

## Phase 6 · 验证（强制）

- [ ] **6.1** `npm run typecheck` exit=0
- [ ] **6.2** `npm test` exit=0
- [ ] **6.3** `npm run build` 无新增警告
- [ ] **6.4** **反向验证**：

| 注入 | 期望 |
|---|---|
| `item.bill` 恒为 true（测试播报又被拦） | 缺陷 1 断言红 |
| 去掉探测（unreachable 永不清） | 缺陷 2 断言红 |
| `style` 改回硬编码 `'general'` | 风格断言红 |
| `petGender` 两个都返回 `'female'` | 性别断言红 |

- [ ] **6.5** 如实记录抓不到的变异

## 风险

| 风险 | 应对 |
|---|---|
| 测试播报实际不走 `speakOut` | Phase 1.3 先读代码确认 |
| 退避探测与 30s 轮询叠加放大请求 | 探测排程用独立 ref，且用尽即停；必要时在设计里加合并 |
| 删 `voiceGender` 波及多处 props | Phase 2 一次性做完，typecheck 兜底 |
| 音色清单抄错 | 数据来自已抓取的服务页面，不臆造；断言校验条目数与男女分布 |
