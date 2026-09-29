# Implement: TTS 集成与智能播报

## Ordered Checklist

### Phase 1: Core TTS Service

- [ ] **1.1** 创建 `src/renderer/src/ttsService.ts`
  - [ ] 实现 `speakWithTTS(text, options)` — 调用免费 TTS API 并播放音频
  - [ ] 实现 `checkRateLimit()` — 检查应用级频率限制（每分钟 1 次，每小时 10 次）
  - [ ] 实现 `getTTSConfig()` / `setTTSConfig(config)` — 读写 TTS 服务配置
  - [ ] 实现回退到系统语音的逻辑（可配置）
  - [ ] 处理 DNS 污染问题（使用 `--resolve` 或 DNS-over-HTTPS）

- [ ] **1.2** 创建 `scripts/test-tts-service.mjs`
  - [ ] 测试 TTS API 调用
  - [ ] 测试频率限制逻辑
  - [ ] 测试回退到系统语音

### Phase 2: Smart Broadcast Trigger

- [ ] **2.1** 创建 `src/renderer/src/smartBroadcast.ts`
  - [ ] 实现 `checkTriggers(snapshots, config)` — 检测 5 个触发条件
  - [ ] 实现 `generateBroadcastText(snapshot, triggerType, format)` — 生成播报内容
  - [ ] 实现 `getThresholdConfig(providerId?)` — 获取阈值配置（全局 + 按供应商）
  - [ ] 实现异常使用模式检测（基于平均值/峰值/标准差）

- [ ] **2.2** 创建 `scripts/test-smart-broadcast.mjs`
  - [ ] 测试余额预警触发
  - [ ] 测试用量波动触发
  - [ ] 测试用量即将耗尽触发
  - [ ] 测试长时间未使用触发
  - [ ] 测试异常使用模式触发
  - [ ] 测试播报内容生成（简洁/详细模式）

### Phase 3: Settings UI

- [ ] **3.1** 创建 `src/renderer/src/VoiceReminderSection.tsx`
  - [ ] TTS 服务配置（下拉选择 + 表单）
  - [ ] 触发条件配置（开关 + 阈值输入）
  - [ ] 播报内容格式配置（简洁/详细选择）
  - [ ] 视觉通知配置（开关）
  - [ ] 回退策略配置（开关）
  - [ ] 频率限制显示

- [ ] **3.2** 修改 `src/renderer/src/SettingsView.tsx`
  - [ ] 添加 `VoiceReminderSection` 组件
  - [ ] 传递相关 props 和回调

### Phase 4: App.tsx Integration

- [ ] **4.1** 修改 `src/renderer/src/App.tsx`
  - [ ] 添加 `ttsConfig` 状态和持久化
  - [ ] 添加 `triggerConfig` 状态和持久化
  - [ ] 修改 `speakBalance` 使用 TTS 服务
  - [ ] 添加确认机制（点击确认 + 倒计时 1 分钟）
  - [ ] 添加频率限制检查
  - [ ] 添加视觉通知（可配置）

### Phase 5: Testing & Validation

- [ ] **5.1** 运行单元测试
  - [ ] `npm test` — 所有现有测试通过
  - [ ] `node scripts/test-tts-service.mjs` — TTS 服务测试通过
  - [ ] `node scripts/test-smart-broadcast.mjs` — 智能播报测试通过

- [ ] **5.2** 运行类型检查
  - [ ] `npm run typecheck` — 无类型错误

- [ ] **5.3** 手动测试
  - [ ] TTS 服务配置界面正常显示
  - [ ] 触发条件配置正常保存
  - [ ] 播报内容格式切换正常
  - [ ] 确认机制工作正常
  - [ ] 频率限制生效
  - [ ] 回退到系统语音工作正常

## Validation Commands

```bash
# 类型检查
npm run typecheck

# 单元测试
npm test

# TTS 服务测试
node scripts/test-tts-service.mjs

# 智能播报测试
node scripts/test-smart-broadcast.mjs

# 构建
npm run build
```

## Risky Files

| 文件 | 风险 | 回滚策略 |
|------|------|----------|
| `src/renderer/src/App.tsx` | 修改现有播报逻辑 | 保留系统语音作为回退 |
| `src/renderer/src/SettingsView.tsx` | 添加新组件 | 独立分区，不影响现有功能 |
| `src/renderer/src/voice.ts` | 保留作为回退 | 不修改，仅扩展 |

## Rollback Plan

1. **TTS 服务不可用** — 用户可关闭 TTS 服务，回退到系统语音
2. **触发条件误报** — 用户可调整阈值或关闭特定触发条件
3. **频率限制过严** — 用户可调整频率限制配置
4. **完整回滚** — 关闭 TTS 服务开关，完全回退到原有系统语音播报

## Follow-up Checks

- [ ] 确认 TTS API 在生产环境可访问
- [ ] 确认 DNS 污染问题已解决
- [ ] 确认频率限制不会导致用户投诉
- [ ] 确认确认机制不会过于打扰用户
