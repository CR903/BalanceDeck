# Design: 语音设置重构与播报故障修复

## 1. 三个缺陷的因果链

这是本设计的核心：**缺陷 2 是缺陷 1 的后果**，只修其一不能解决用户看到的现象。

```
某次 TTS 调用失败
   │
   ▼ onTtsFailed
unreachable = true  ─────────────────────────┐
   │                                          │
   │ 之后每次播报都进 playOne                 │
   ▼                                          │
allowCall() 返回 false（1 次/分钟）            │
   │                                          │
   ▼                                          │
静默 return ← 用户看不到任何反馈 ──────────────┘
   │
   ▼ onTtsOk 永远不会被调用
unreachable 永久为真
```

## 2. 修法：把「测试播报」与「定时播报」分成两条路

关键认识 —— 频率闸门要保护的是**配额**，不是用户的主动操作。所以不该在公共路径上设闸，而该在**触发源**上设。

| | 触发源 | 是否受闸门约束 | 理由 |
|---|---|---|---|
| 定时/预警播报 | `alertOrchestrate` → `enqueue` | **是** | 无人值守，必须限流 |
| 测试播报 | 设置页按钮 | **否** | 用户主动，一分钟点 10 次也是他自己的选择 |

```ts
export interface SpeechItem { text: string; urgent: boolean; bill: boolean }
// bill = 是否计入配额。定时/预警 true，测试 false
```

`playOne` 里 `if (item.bill && !allowCall(Date.now())) return`。

**为什么不在 `flush` 上加参数**：`flush` 已被 drain 复用，按 item 标记更贴合「谁产生的播报谁决定是否计费」的语义，也不必把 flag 传遍 `FlushOptions`。

**不受约束 ≠ 无保护**：`MAX_PENDING` 队列上限与 `stopAll` 仍然生效，测试播报只是不占配额、不被静默丢弃。

## 3. 不可达状态自愈

不能靠「下一次播报碰运气」—— 缺陷 2 证明这条路不通。

```ts
// App.tsx：unreachable 置位后启动退避探测
const PROBE_DELAYS = [5_000, 15_000, 60_000, 300_000]   // 5s/15s/1min/5min
```

- 置位时开始排程，每个延迟后发一次**静默探测**（不发声、只验连通性）
- 探测成功 → `unreachable = false`，停止排程
- 探测仍失败 → 继续下一个延迟，用尽后停止（不无限重试）
- 新一次真实失败 → 重新开始排程

探测复用 `speechOut` 的请求函数但**不 enqueue**，因此不播声、不计配额。

## 4. 性别完全由助理决定

```
pet.id ──► aria → 'female'
       └─► ray  → 'male'
```

- 映射表放 `shared/pet.ts`（性别是**助理身份**的一部分，不是播报偏好）
- `AlertContext.gender` 由 `alertCtxRef` 每轮从 `pet.id` 现算，**不进 extras**
- 切换助理即时生效，因为每轮现算而非持久化
- `ui:voiceGender` 下线：不再读，也不再写（键留在 extras 里不动）

> **实现期修正（本轮 review 记录）**：本节初稿写的是「读取一次做迁移（`female`/`male` 映射到
> 对应助理念初始）」，与本文 §7 兼容表的「不再读取」自相矛盾。**以 §7 为准 —— 不做迁移**。
> 理由：性别是**助理念**的属性，反推「用户选了男声 ⇒ 他大概想要 Ray」是在用一个废弃的语音
> 偏好去改写他的助理身份（连名字和形象一起换），副作用比它想解决的问题大得多；而「读取时
> 现算」本身也不需要迁移。`test-speech-out.mjs` 的 P9 钉的就是「不读不写」。

> 这正是上一轮被还原的那段 `changePet` 写 `ui:voiceGender` 的逻辑 —— 现在改成**读取时现算**，而不是**切换时改写用户偏好**。副作用更小，且不再有「覆盖用户显式选择」的问题（因为没有显式选择了）。

## 5. 音色与风格

`TtsConfig` 扩两个字段，`requestAudioBlob` 停止硬编码：

```ts
export interface TtsConfig {
  url: string
  voice: string
  speed: number
  style: string      // 新增：目前硬编码 'general'，用户选择根本发不出去
  authHeader?: Record<string, string>
}
```

**音色/风格清单**放在 `shared/tts-preset.ts`（渲染层与测试共用，纯数据无逻辑）：

```ts
export interface TtsVoice { id: string; label: string; gender: 'female' | 'male'; trait: string }
export const TTS_VOICES: TtsVoice[]        // 21 条，抄自服务页面，不臆造
export interface TtsStyle { id: string; label: string }
export const TTS_STYLES: TtsStyle[]        // 11 条
```

`label` 形如「晓晓（女声·温柔）」，`gender` 让 UI 能按性别分组，`trait` 是性格描述。

音色下拉按性别分组（`<optgroup>`），因为用户真正在做的是「配一个男/女角色」——这与助理选择的心智模型一致。

## 6. 文案

| 场景 | 旧 | 新 |
|---|---|---|
| 不可达 | 「服务当前不可达。播报会按下面的设置回退到系统语音」 | 「连不上语音服务，提醒暂时只能用系统自带的声音念。检查网络，或换个服务地址再试。」 |
| 测试失败 | 无提示 | 「没播出来：{原因}。检查服务地址是否正确，或点上面的『测试播报』再试。」 |
| 测试成功 | 无反馈 | 「试听正常」+ 自动消失 |

原则：**说人话 + 给下一步**。禁出现「回退」「通路」「unreachable」这类实现术语。

## 7. 兼容与迁移

| 旧状态 | 新行为 |
|---|---|
| `ui:voiceGender = 'female'` | 不再读取；播报性别由当前助理决定 |
| `ui:ttsConfig` 无 `style` | 读取时补 `'general'`（已是默认值，行为不变） |
| 未配 TTS 服务 | 不变（AC3：不播报） |
| 选了测试播报 | 从此不受闸门限制（用户感知不到「以前被拦」） |

## 8. 取舍

- **不做**：给测试播报单独一套闸门。用户主动点击无需限流，加了反而又要解释「为什么我点了没反应」
- **不做**：不可达提示加「重试」按钮。自动探测已经在了，按钮是冗余交互
- **代价**：`SpeechItem` 多一个字段，队列里混着计费与不计费两种条目 —— 换来「谁产生谁计费」的清晰语义
- **代价**：`ui:voiceGender` 下线后，老用户若曾手动选过与助理相反的性别，行为会变。这是有意的（用户已裁定性别由助理决定），且升级前无法两全
