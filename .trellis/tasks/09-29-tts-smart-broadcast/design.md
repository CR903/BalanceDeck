# Design: TTS 集成与智能播报

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        App.tsx                              │
│  speakBalance · voiceTimer · confirmState · historyAppend    │
└───────────────┬─────────────────────────┬───────────────────┘
                │                         │
                ▼                         ▼
┌───────────────────────────────┐  ┌──────────────────────────┐
│  smartBroadcast.ts  (new)     │  │ history.ts (new)          │
│  · checkTriggers              │  │ · append / read / cap N   │
│  · mergeAndDedupe             │  │ · 均值/峰值/标准差        │
│  · buildText(simple|detail)   │  │ · 存 extras（明文，无密钥）│
└───────────────┬───────────────┘  └──────────────────────────┘
                │ 触发结果 {kind: 'urgent'|'routine', items[]}
                ▼
┌─────────────────────────────────────────────────────────────┐
│  speechOut.ts (new) — 统一播出口                             │
│  · tts path: fetch → ArrayBuffer → HTMLAudioElement          │
│  · system fallback: 复用 voice.ts speak()                    │
│  · 队列 / 打断 / 频率闸门                                     │
└───────────────┬─────────────────────────────────────────────┘
                │ IPC（仅必要项）
                ▼
┌─────────────────────────────────────────────────────────────┐
│  main: session autoplayPolicy + tts secret（加密 items）      │
└─────────────────────────────────────────────────────────────┘
```

## Technical Decisions

以下为技术侧决策，非产品决策，直接由证据推导。

### D1 · TTS 端点（已实测）

| 项 | 值 |
|---|---|
| 端点 | `https://voice.mytts.ccwu.cc/v1/audio/speech` |
| 方法/体 | `POST` JSON `{input, voice, speed, pitch, style}` |
| 响应 | `audio/mpeg`，实测 1.71s / 11376 bytes，MPEG ADTS layer III 48kbps 24kHz mono |
| DNS | 104.21.45.13（Cloudflare），**直连正常** |
| 旧域名 | `tts.chour903.workers.dev` → 解析到 `199.59.148.96`（Facebook 段），TLS 超时。**已弃用** |

按 `external-api-integration.md` §1/§2：此结论有真实请求为证（curl 非静态断言），且旧/新域名对比已实测。

### D2 · DNS：不内置绕过（决策 C）

域名已可直连，因此**不实现** DoH / 硬编码 IP。理由：Cloudflare 边缘 IP 会变，硬编码必然失效且维护脆弱；根因属部署侧，已由换域名解决。

应用侧只做**优雅降级**：连接失败 → 回退系统语音（可配置）+ 设置页显示「服务不可达」。保证用户日后换域名/换服务时故障可见，而非静默失效。

### D3 · 密钥存储：新增加密 IPC，禁止写 extras

`preload/index.ts:46-47` 只暴露 `getExtras`/`setExtras`（→ `extras`，**明文**）。`setKey`/`getKey`（→ `items`，safeStorage 加密）**未暴露**。

`state-management.md:208-217` 明确警告两命名空间互不相通、混用静默失败。故自定义 TTS 认证新增专用 IPC：

```ts
tts:setSecret(id, value) → 主进程 store.setKey('tts:secret:' + id, value)  // 加密
tts:getSecret(id)        → store.getKey('tts:secret:' + id)
```

**禁止**把 token 写入 `extras`。

### D4 · 音频播放：渲染进程 + 显式 autoplay 策略

选择渲染进程 `HTMLAudioElement`（不落主进程），理由：与既有 `window.speechSynthesis` 同进程，回退路径无需跨进程；且 `ArrayBuffer` 可直接喂给 `new Audio(URL.createObjectURL(blob))`。

**前置条件**：主进程设 `session.defaultSession.setAutoplayPolicy('no-user-gesture-required')`，否则 Chromium 自动播放策略会拦掉无用户手势的播报（余额预警恰恰是无人触发场景）。此为必需项，非优化项。

### D5 · 队列与打断

| 场景 | 行为 |
|---|---|
| 同一轮多场景触发 | **合并为一条**播报（AC12），不逐条念 |
| 紧急打断例行 | 紧急触发时 `audio.pause()` 并清空队列 |
| 播报进行中再次触发 | 排队，串行播放 |
| 播报时长 > 触发间隔 | 跳过新触发（不叠加），记日志 |

`stopVoice()` 必须同时 `speechSynthesis.cancel()` 与 `audio.pause()`，否则 TTS 音频无法停止。

### D6 · extras 键与副作用

`ipc.ts:191-193`：**非 `ui:` 前缀的写入会触发一次全量重新采集**。所有新键必须 `ui:` 前缀，否则每次切换开关都发网络请求。

| Key | 编码 | 说明 |
|---|---|---|
| `ui:ttsConfig` | JSON | 服务配置（URL/音色/语速），**不含密钥** |
| `ui:ttsOn` | `'1'` / `'0'` | 沿用多数派拼写（`ui:hideBalance` 用 `'1'/''`，此处不跟随） |
| `ui:ttsFallback` | `'1'` / `'0'` | 回退系统语音 |
| `ui:ttsVisual` | `'1'` / `'0'` | 视觉通知 |
| `ui:ttsTextFormat` | `'simple'` / `'detailed'` | 播报内容格式 |
| `ui:ttsTriggers` | JSON | 5 个场景开关 + 阈值 + 按供应商覆盖 |
| `ui:ttsHistory` | JSON | 历史快照（上限 N，默认 100） |
| `ui:ttsHistoryCap` | `String(N)` | 历史条数上限 |

读取处一律**重新校验**（`state-management.md:178-180`）：阈值 clamp 到正数、格式白名单校验、历史数组长度裁剪。

### D7 · 定时器契约

`state-management.md:199-202` 明确：播报定时器依赖数组**不得增加第四个依赖**，否则每次切换都会立即播报一次。所有新配置（音色、格式、阈值）必须走 `speakCtxRef` 镜像读取，与现有 `speakBalance` 一致。

> 注：`state-management.md:196` 记录的是 `setInterval`，工作区已改为自重排 `setTimeout`。本任务沿用工作区版本，并同步修正 spec。

### D8 · 历史数据

存 `ui:ttsHistory`（明文，不含密钥），每次刷新追加一条：

```ts
interface HistoryPoint { t: number; id: string; balance: number | null; percent: number | null }
```

- 上限 N（默认 100），超出丢弃最旧
- **数据不足（< 10 条）时异常检测不触发**（宁漏不误报）
- 缺失值保持 `null`，**不得填 0**（`type-safety.md`：缺失值必须保持缺失）

### D9 · voice.ts 处置

保留为系统语音回退路径，`voiceGender` 关键词扩充一并保留（回退路径仍需性别匹配）。不推倒重来。

## Out of Scope

- DoH / 硬编码 IP 兜底
- 流式 TTS
- 多语言
- 付费服务预设


## Data Flow

### 1. TTS 服务调用

```
用户开启播报
    │
    ▼
检查 TTS 服务配置
    │
    ├── 未配置 → 不播报
    │
    └── 已配置 → 检查频率限制
                    │
                    ├── 超过限制 → 跳过本次播报
                    │
                    └── 未超过 → 调用 TTS API
                                    │
                                    ├── 成功 → 播放音频
                                    │
                                    └── 失败 → 回退到系统语音（可配置）
```

### 2. 智能播报触发

```
定时器触发（默认 1 小时）
    │
    ▼
检查触发条件
    │
    ├── 余额预警：余额 < 阈值（默认 10 元）
    ├── 用量波动：单次增长 > 阈值（默认 10 元）
    ├── 用量即将耗尽：使用率 > 90%
    ├── 长时间未使用：超过 24 小时无使用
    └── 异常使用模式：超过历史平均值 × 倍数
    │
    ▼
任一条件满足 → 生成播报内容 → 调用 TTS 服务
    │
    ▼
显示确认按钮 + 倒计时（1 分钟）
    │
    ├── 用户点击确认 → 停止重复
    └── 倒计时结束 → 自动确认 → 停止重复
```

## Components

### 1. `src/renderer/src/ttsService.ts` (new)

TTS 服务集成模块：
- `speakWithTTS(text, options)` — 调用 TTS API 并播放
- `checkRateLimit()` — 检查频率限制
- `getTTSConfig()` — 获取 TTS 服务配置
- `setTTSConfig(config)` — 保存 TTS 服务配置

**TTS API 调用（端点见 D1）：**
```typescript
const res = await fetch(cfg.url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...authHeaders },
  body: JSON.stringify({ input: text, voice: cfg.voice, speed: cfg.speed, pitch: '0', style: 'general' })
})
if (!res.ok) throw new Error(`TTS ${res.status}`)   // 失败必须显式抛，回退路径依赖它
const audio = new Audio(URL.createObjectURL(await res.blob()))
```

> `external-api-integration.md` §7：同 host 串行 + 一次重试，401/403 不重试。本任务播报为串行队列，天然满足串行要求。

### 2. `src/renderer/src/smartBroadcast.ts` (new)

智能播报触发模块：
- `checkTriggers(snapshots, config)` — 检查触发条件
- `generateBroadcastText(snapshot, triggerType, format)` — 生成播报内容
- `getThresholdConfig(providerId?)` — 获取阈值配置

**触发条件检测：**
```typescript
interface TriggerConfig {
  balanceThreshold: number;      // 余额预警阈值（元）
  fluctuationThreshold: number;  // 用量波动阈值（元）
  exhaustionThreshold: number;   // 用量耗尽阈值（%）
  idleThreshold: number;         // 长时间未使用阈值（小时）
  abnormalMultiplier: number;    // 异常使用倍数
}

type TriggerType = 'balance' | 'fluctuation' | 'exhaustion' | 'idle' | 'abnormal';
```

### 3. `src/renderer/src/VoiceReminderSection.tsx` (new)

语音提醒设置分区组件：
- TTS 服务配置（下拉选择 + 表单）
- 触发条件配置（开关 + 阈值）
- 播报内容格式配置（简洁/详细）
- 视觉通知配置（开关）
- 回退策略配置（开关）

### 4. `src/renderer/src/App.tsx` (modified)

修改内容：
- 添加 `ttsConfig` 状态
- 添加 `triggerConfig` 状态
- 修改 `speakBalance` 函数使用 TTS 服务
- 添加确认机制逻辑
- 添加频率限制检查

### 5. `src/renderer/src/SettingsView.tsx` (modified)

修改内容：
- 添加 `VoiceReminderSection` 组件
- 传递相关 props

## Data Persistence

见 **D6** 的键表。所有键 `ui:` 前缀（避免 `ipc.ts:191-193` 的重新采集副作用），密钥走 D3 的加密 IPC，不落 `extras`。

旧键迁移：`ui:voiceOn` → `ui:ttsOn`（保留读 `ui:voiceOn` 兼容旧配置）。

## Rate Limiting

```typescript
const RATE_LIMIT = { MAX_PER_MINUTE: 1, MAX_PER_HOUR: 10 }
```

滑动窗口为 `speechOut` 内存态，**不持久化**（重启后重置，避免陈旧窗口影响当日限额判断）。

## Error Handling

| 场景 | 处理方式 |
|------|----------|
| TTS API 超时 | 回退到系统语音（可配置） |
| TTS API 返回错误 | 回退到系统语音（可配置） |
| 网络断开 | 回退到系统语音（可配置） |
| 频率限制 | 跳过本次播报，记录日志 |
| 音频播放失败 | 记录日志，不重试 |

## Migration

1. 保留现有 `voice.ts` 作为系统语音回退
2. 新增 `ttsService.ts` 作为主要 TTS 服务
3. 新增 `smartBroadcast.ts` 作为触发检测
4. 在 `SettingsView.tsx` 中新增 `VoiceReminderSection`
5. 修改 `App.tsx` 中的播报逻辑

## Rollback

- 保留现有系统语音播报功能
- 用户可关闭 TTS 服务，回退到系统语音
- 配置独立存储，不影响现有设置
