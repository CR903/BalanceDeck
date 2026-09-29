import { useState } from 'react'
import { Icon } from './components'
import {
  DEFAULT_TRIGGER_CONFIG,
  THRESHOLD_FIELD,
  TRIGGER_LEVEL,
  type ProviderOverride,
  type TriggerConfig
} from './smartBroadcast'

// ═══════════════════════════════════════════════════════════════════════════════
// 设置页「语音提醒」分区
//
// 纯展示 + 意图转发层：自己**不发请求、不读写 extras、不播音**，所有改动都经 props
// 回调交回 App 侧（存储走 ui:tts* 系列，密钥走主进程加密 IPC，见 design.md D3 / D6）。
// 服务是否可达也不在这里探测 —— 由 props 的 `unreachable` 告知。
//
// 阈值、单位、默认值取自父任务 09-29-tts-smart-broadcast 的 prd.md（决策表）与
// design.md（D1 端点 / D6 extras 键表）。
//
// ⚠ class 约定：本分区里**每个 select 都有独立 class**（vrs-preset / vrs-text-format /
// vrs-routine-interval），每个开关与数字输入也是（vrs-power / vrs-threshold / vrs-override /
// vrs-speed / vrs-history-cap）。`.voice-interval` 与 `.refresh-interval` 都含 option value="10"，
// 2026-09-26 踩过「第一个含某 option 的 select」定位抓错（qa/uitest.ts:470-472）。
// 其中 vrs-preset / vrs-url / vrs-voice / vrs-secret / vrs-endpoint / vrs-text-format /
// vrs-routine-interval 在 skins.css 里**没有规则** —— 外观由 .field 里的既有规则给，
// 这些 class 是给 --uitest 用的定位钩子（同 refresh-interval 的性质）。
// vrs-power 之所以必须有：智能播报开关与分区里另外 6 个开关共用 `.switch`，
// 没有专属 class 时只能靠「第几个」定位，而开关数量一改定位就悄悄指向别人。
// ═══════════════════════════════════════════════════════════════════════════════

// ─── TTS 服务预设（仅免费服务；付费服务不在 Out of Scope 之外的任何承诺里）────────

interface TtsPreset {
  label: string
  url: string
  /** 预设默认音色（仅在切到自定义时可改，故只作只读展示的参考） */
  voice: string
}

type TtsPresetId = 'mytts'

const TTS_PRESETS: Record<TtsPresetId, TtsPreset> = {
  mytts: {
    label: '免费 · Edge TTS（中文音色）',
    url: 'https://voice.mytts.ccwu.cc/v1/audio/speech',
    // ⚠ 必须与 speechOut 的 DEFAULT_TTS_CONFIG.voice **一致**（本表是预设的唯一定义处）。
    //   不一致的话，「选中这个预设」会顺带把音色从出厂默认换成另一个，用户没有任何提示 ——
    //   而预设分支里音色是**不显示**的（只有只读端点），那次切换等于偷偷换了个人在说话。
    voice: 'zh-CN-YunxiNeural'
  }
}

const TTS_PRESET_IDS: TtsPresetId[] = ['mytts']

/**
 * 下拉里「自定义服务」那一项的 value。
 *
 * ⚠ 必须是**非空**的稳定标识，不能是 `''`：`extras:get` 对**缺失的键**也返回 `''`
 *   （ipc.ts:198），所以拿 `''` 当「自定义」的值，用户一旦选了就再也存不回来 ——
 *   重启时读到的 `''` 与「没设过」完全同形，`setTtsPreset(raw || 'mytts')` 会把
 *   他翻回免费预设，而他的自定义地址还留在 `ui:ttsConfig.url` 里被静默使用。
 *   用一个显式的 `'custom'`，「自定义」与「没配过」才是两种状态。
 */
const TTS_CUSTOM = 'custom'

function ttsPreset(id: string): TtsPreset | null {
  // TTS_CUSTOM 不在表里，所以「自定义服务」天然落在这条的 else 上
  if (!Object.hasOwn(TTS_PRESETS, id)) return null
  return TTS_PRESETS[id as TtsPresetId]
}

/**
 * 预设对应的服务配置；非预设 id（自定义）返回 null。
 *
 * 导出给 App 侧：切到预设时**必须**把 url/voice 一起写进 `ui:ttsConfig`。否则界面上的
 * 只读端点（读的是本表）与真正发请求用的 `ui:ttsConfig.url` 会各说各话 —— 用户在
 * 「预设 / 自定义」之间来回切一次，就出现「界面写着免费服务，请求打向自定义地址」。
 */
export function presetConfig(id: string): { url: string; voice: string } | null {
  const p = ttsPreset(id)
  return p ? { url: p.url, voice: p.voice } : null
}

// ─── 触发场景 ─────────────────────────────────────────────────────────────────
// 场景名直接取自 smartBroadcast 的 TriggerKind（与引擎共用一份，不另写一份 5 个字符串）。

type TriggerKind = keyof typeof THRESHOLD_FIELD

interface TriggerState {
  on: boolean
  /** 阈值；单位见 TRIGGER_META */
  value: number
}

interface TriggerMeta {
  label: string
  /** 阈值单位（元 / % / 小时 / 倍） */
  unit: string
  min: number
  max: number
  step: number
}

/**
 * 只放**输入范围**。默认值与分级都不在这里写：
 *
 *   · 默认值 → defOf()（读 DEFAULT_TRIGGER_CONFIG）
 *   · 分级 → TRIGGER_LEVEL（引擎那张表）
 *
 * 这两样各写一份就一定会漂：写坏过一次的是异常倍数（界面写 3、引擎写 2）——用户看到的
 * 默认值和实际生效值不是同一个数，而这种漂移在类型层面完全无声。
 */
const TRIGGER_META: Record<TriggerKind, TriggerMeta> = {
  balance: { label: '余额预警', unit: '元', min: 0.1, max: 100000, step: 1 },
  fluctuation: { label: '用量波动', unit: '元', min: 0.1, max: 100000, step: 1 },
  exhaustion: { label: '用量即将耗尽', unit: '%', min: 1, max: 100, step: 1 },
  idle: { label: '长时间未使用', unit: '小时', min: 1, max: 720, step: 1 },
  abnormal: { label: '异常使用模式', unit: '倍', min: 1, max: 100, step: 0.5 }
}

const TRIGGER_ORDER: TriggerKind[] = ['balance', 'fluctuation', 'exhaustion', 'idle', 'abnormal']

/** 该场景的默认阈值 —— 直接取引擎的默认值，不复述 */
function defOf(kind: TriggerKind): number {
  return DEFAULT_TRIGGER_CONFIG[THRESHOLD_FIELD[kind]]
}

/** true = 例行（仅收起态播报）；false = 紧急（任何状态都播）—— 父 PRD「播报分级规则」 */
function routineOf(kind: TriggerKind): boolean {
  return TRIGGER_LEVEL[kind] === 'routine'
}

/**
 * 读一个触发配置。记录由 extras 反序列化而来，键可能缺失 / 值可能非法 ——
 * 缺失与非法都回退到默认，而不是让它变成 NaN 流进阈值比较。
 */
function triggerOf(triggers: Record<string, TriggerState>, kind: TriggerKind): TriggerState {
  const raw = triggers[kind]
  if (!raw) return { on: false, value: defOf(kind) }
  return {
    on: raw.on === true,
    value: Number.isFinite(raw.value) ? raw.value : defOf(kind)
  }
}

/**
 * 读一个覆盖值；null = 继承全局。
 *
 * ⚠ 必须按**阈值字段名**取（THRESHOLD_FIELD[kind]），不能直接用场景名：覆盖表由 App 的
 * changeOverride 按字段名写（ui:ttsTriggers.perProvider 里存的是 `balanceLow`），
 * 用场景名去取会永远读到 undefined —— 用户填了覆盖，界面显示「继承」、引擎也用全局值，
 * 两头都不出错，只有结果是「没生效」。
 */
function overrideOf(
  overrides: Record<string, ProviderOverride>,
  providerId: string,
  kind: TriggerKind
): number | null {
  const v = overrides[providerId]?.[THRESHOLD_FIELD[kind]]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// ─── 其余固定值 ───────────────────────────────────────────────────────────────

type TextFormat = 'simple' | 'detailed'

const TEXT_FORMAT_LABEL: Record<TextFormat, string> = {
  simple: '简洁（仅余额）',
  detailed: '详细（余额 + 用量 + 供应商）'
}

/** 测试播报的示例句，逐字取自父 PRD「简洁模式 / 详细模式」两行 */
const SAMPLE_TEXT: Record<TextFormat, string> = {
  simple: '余额不足，当前余额 50 元',
  detailed: 'OpenCode Go 余额不足，当前余额 50 元，使用率 80%'
}

/** 定时兜底间隔档位（分钟）。默认 60（父 PRD「默认播报间隔：每 1 小时」） */
const ROUTINE_STEPS: [number, string][] = [
  [5, '5 分钟'],
  [10, '10 分钟'],
  [15, '15 分钟'],
  [30, '30 分钟'],
  [60, '1 小时'],
  [120, '2 小时'],
  [180, '3 小时'],
  [360, '6 小时'],
  [720, '12 小时'],
  [1440, '24 小时']
]

// 默认值（语速 1、历史上限 100）由 App 侧持有；这里只管输入范围
const SPEED_RANGE = { min: 0.5, max: 2, step: 0.1 }
const HISTORY_CAP_RANGE = { min: 10, max: 1000, step: 10 }

// ─── 数字输入 ─────────────────────────────────────────────────────────────────

/**
 * 带草稿的数字输入：失焦 / 回车提交，提交时 clamp 到 [min, max]。
 *
 *  为什么需要草稿：直接受控一个 number prop 时，「全选 → 键 0 → 键 5」会在第一个键
 * 就被 clamp 回 min（10 变 1），第二个键就成了 15 —— 用户永远打不出 10 以外的两位数。
 * 草稿把中间态留在输入框里，提交时才落到 props。
 *
 *  非数字（留空 / 字母）**不提交**，保留原值；value 为 null 时表示「继承全局」。
 */
function NumInput({
  value,
  min,
  max,
  step = 1,
  placeholder,
  className,
  providerId,
  trigger,
  onCommit
}: {
  /** 当前值；null = 无值（覆盖场景的「继承」） */
  value: number | null
  min: number
  max: number
  step?: number
  placeholder?: string
  /** 必填：每只数字输入都要有自己可被 uitest 唯一选中的 class（`vrs-num` 之外那个） */
  className: string
  providerId?: string
  trigger?: string
  onCommit: (n: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')

  const commit = (): void => {
    const raw = draft.trim()
    setDraft('')
    if (raw === '') return
    const n = Number(raw)
    if (!Number.isFinite(n)) return
    onCommit(Math.min(max, Math.max(min, n)))
  }

  return (
    <input
      // 两个 class 各司其职：vrs-num 管外观（共用一条规则），className 管定位
      className={'vrs-num ' + className}
      type="number"
      min={min}
      max={max}
      step={step}
      data-provider-id={providerId}
      data-trigger={trigger}
      value={draft !== '' ? draft : value == null ? '' : String(value)}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
    />
  )
}

// ─── 分区本体 ─────────────────────────────────────────────────────────────────

export interface VoiceReminderSectionProps {
  /** 智能播报总开关（ui:ttsOn） */
  ttsOn: boolean
  onToggleTts: (on: boolean) => void
  /** TTS 服务预设 id；空串 = 自定义 */
  servicePreset: string
  onChangePreset: (id: string) => void
  ttsUrl: string
  onChangeUrl: (url: string) => void
  ttsVoice: string
  onChangeVoice: (v: string) => void
  /** 语速倍数，默认 1 */
  ttsSpeed: number
  onChangeSpeed: (n: number) => void
  /** 是否已存过认证 token（主进程加密存储，明文不回传渲染层） */
  hasSecret: boolean
  onSetSecret: (v: string) => void
  /** 用当前配置播一句示例；播放由 App 侧完成 */
  onTestSpeak: (text: string) => void

  /** 5 个触发场景的开关与阈值（ui:ttsTriggers） */
  triggers: Record<string, TriggerState>
  onChangeTrigger: (kind: string, patch: { on?: boolean; value?: number }) => void
  /** 按供应商的阈值覆盖：providerId → 阈值字段名 → 阈值；缺键 = 继承全局 */
  overrides: Record<string, ProviderOverride>
  /** value 传 null = 取消覆盖，回到继承 */
  onChangeOverride: (providerId: string, kind: string, value: number | null) => void

  /** 播报内容格式（ui:ttsTextFormat） */
  textFormat: TextFormat
  onChangeTextFormat: (f: TextFormat) => void
  /** 视觉通知（ui:ttsVisual） */
  visual: boolean
  onToggleVisual: (on: boolean) => void
  /** 网络 TTS 不可用时回退到系统语音（ui:ttsFallback） */
  fallback: boolean
  onToggleFallback: (on: boolean) => void
  /** 定时兜底播报 */
  routineOn: boolean
  onToggleRoutine: (on: boolean) => void
  /** 兜底间隔（分钟），默认 60 */
  routineMinutes: number
  onChangeRoutineMinutes: (n: number) => void
  /** 历史快照条数上限（ui:ttsHistoryCap），默认 100 */
  historyCap: number
  onChangeHistoryCap: (n: number) => void

  /** 上一次 TTS 调用是否失败（由 App 侧判定，本组件不自己探测） */
  unreachable: boolean
  /** 已静音的供应商 id（不参与语音播报） */
  mutedProviders: string[]
  /** 供应商 id / 显示名，用于按供应商覆盖 */
  providerNames: { id: string; name: string }[]
}

export function VoiceReminderSection({
  ttsOn,
  onToggleTts,
  servicePreset,
  onChangePreset,
  ttsUrl,
  onChangeUrl,
  ttsVoice,
  onChangeVoice,
  ttsSpeed,
  onChangeSpeed,
  hasSecret,
  onSetSecret,
  onTestSpeak,
  triggers,
  onChangeTrigger,
  overrides,
  onChangeOverride,
  textFormat,
  onChangeTextFormat,
  visual,
  onToggleVisual,
  fallback,
  onToggleFallback,
  routineOn,
  onToggleRoutine,
  routineMinutes,
  onChangeRoutineMinutes,
  historyCap,
  onChangeHistoryCap,
  unreachable,
  mutedProviders,
  providerNames
}: VoiceReminderSectionProps): React.JSX.Element {
  /** 按供应商覆盖折叠态：默认收起（5 场景 × N 供应商，不该默认铺满设置页） */
  const [overrideOpen, setOverrideOpen] = useState(false)
  /** 认证 token 草稿：只往上传，不从主进程读回明文 */
  const [secretDraft, setSecretDraft] = useState('')

  const preset = ttsPreset(servicePreset)
  const overrideCount = providerNames.reduce(
    (n, p) => n + TRIGGER_ORDER.filter((k) => overrideOf(overrides, p.id, k) != null).length,
    0
  )
  /** 存档值若不在档位表里（手工改过 / 旧配置），补一条出来，避免 select 显示空白 */
  const routineOffLadder = !ROUTINE_STEPS.some(([v]) => v === routineMinutes)

  const commitSecret = (): void => {
    const v = secretDraft.trim()
    setSecretDraft('')
    // 契约里没有「清除」入口（onSetSecret 只收值），空值一律不提交
    if (v) onSetSecret(v)
  }

  return (
    <>
      <div className="section-title">语音提醒</div>
      <div className="vrs-sec">
        <div className="enable-row">
          <span>
            智能播报
            <em className="tag env">TTS</em>
          </span>
          <button
            type="button"
            className={'switch vrs-power' + (ttsOn ? ' on' : '')}
            title={ttsOn ? '关闭后不再播报' : '开启后按触发条件播报余额与用量'}
            onClick={() => onToggleTts(!ttsOn)}
          >
            <span className="knob" />
          </button>
        </div>

        {unreachable && (
          <div className="settings-note warn vrs-warn">
            上一次调用语音服务失败，<b>服务当前不可达</b>。播报会按下面的设置回退到系统语音；
            换端点或稍后点「测试播报」验证连通性。
          </div>
        )}

        {ttsOn && (
          <>
            {/* ── A. TTS 服务 ── */}
            <label className="field">
              <span className="field-label">
                语音服务
                <em className="tag env">预设 / 自定义</em>
              </span>
              <select
                className="vrs-preset"
                value={servicePreset}
                onChange={(e) => onChangePreset(e.target.value)}
              >
                {TTS_PRESET_IDS.map((id) => (
                  <option key={id} value={id}>
                    {TTS_PRESETS[id].label}
                  </option>
                ))}
                <option value={TTS_CUSTOM}>自定义服务</option>
              </select>
            </label>

            {preset ? (
              <label className="field">
                <span className="field-label">
                  接口地址
                  <em className="tag env">预设只读</em>
                </span>
                <input className="vrs-endpoint" type="text" value={preset.url} readOnly />
              </label>
            ) : (
              <>
                <label className="field">
                  <span className="field-label">
                    接口地址
                    <em className="tag env">POST · 返回 audio/*</em>
                  </span>
                  <input
                    className="vrs-url"
                    type="text"
                    value={ttsUrl}
                    placeholder="https://…/v1/audio/speech"
                    onChange={(e) => onChangeUrl(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field-label">
                    音色
                    <em className="tag env">Edge 音色名</em>
                  </span>
                  <input
                    className="vrs-voice"
                    type="text"
                    value={ttsVoice}
                    placeholder={TTS_PRESETS.mytts.voice}
                    onChange={(e) => onChangeVoice(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field-label">
                    语速
                    <em className="tag env">0.5 – 2.0 倍</em>
                  </span>
                  <NumInput
                    className="vrs-speed"
                    value={ttsSpeed}
                    min={SPEED_RANGE.min}
                    max={SPEED_RANGE.max}
                    step={SPEED_RANGE.step}
                    onCommit={onChangeSpeed}
                  />
                </label>
              </>
            )}

            <label className="field">
              <span className="field-label">
                认证 Token
                {hasSecret ? <em className="tag saved">已加密保存</em> : <em className="tag env">可留空</em>}
              </span>
              <input
                className="vrs-secret"
                type="password"
                value={secretDraft}
                placeholder={hasSecret ? '已保存（输入可替换，留空不变）' : '免费服务无需填写'}
                onChange={(e) => setSecretDraft(e.target.value)}
                onBlur={commitSecret}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitSecret()
                }}
              />
            </label>
            <div className="vrs-actions">
              <button
                type="button"
                className="btn-secondary vrs-test"
                title="用当前配置播报一句示例，确认端点 / 音色 / 语速可用"
                onClick={() => onTestSpeak(SAMPLE_TEXT[textFormat])}
              >
                <Icon name="volume" size={14} />
                测试播报
              </button>
              <span className="vrs-sample">示例：{SAMPLE_TEXT[textFormat]}</span>
            </div>

            {/* ── B. 触发条件 ── */}
            <div className="field-label vrs-sub">触发条件（阈值单位见每行标注）</div>
            {TRIGGER_ORDER.map((kind) => {
              const meta = TRIGGER_META[kind]
              const cur = triggerOf(triggers, kind)
              return (
                <div key={kind} className="enable-row">
                  <span>
                    {meta.label}
                    <em className="tag env">{meta.unit}</em>
                    <em className={'tag ' + (routineOf(kind) ? 'env' : 'saved')}>
                      {routineOf(kind) ? '例行' : '紧急'}
                    </em>
                  </span>
                  <span className="vrs-ctl">
                    <NumInput
                      className="vrs-threshold"
                      value={cur.value}
                      min={meta.min}
                      max={meta.max}
                      step={meta.step}
                      trigger={kind}
                      onCommit={(n) => onChangeTrigger(kind, { value: n })}
                    />
                    <button
                      type="button"
                      className={'switch' + (cur.on ? ' on' : '')}
                      title={
                        cur.on
                          ? `已开启：${meta.label}（${cur.value} ${meta.unit}）`
                          : `已关闭：${meta.label}`
                      }
                      onClick={() => onChangeTrigger(kind, { on: !cur.on })}
                    >
                      <span className="knob" />
                    </button>
                  </span>
                </div>
              )
            })}

            {/* ── C. 按供应商覆盖 ── */}
            <div className="advanced">
              <button
                type="button"
                className={'advanced-head' + (overrideOpen ? ' open' : '')}
                onClick={() => setOverrideOpen(!overrideOpen)}
              >
                <Icon name="chevron" size={14} />
                <span>按供应商覆盖阈值</span>
                <em className="tag env">{overrideCount ? `${overrideCount} 项已覆盖` : '默认继承'}</em>
              </button>
              {overrideOpen && (
                <div className="advanced-body">
                  <div className="advanced-note">
                    留空 = <b>继承全局</b>；填数字 = 只覆盖<b>这一家</b>的阈值，其余供应商不受影响。
                    已静音的供应商不参与播报（下面的「已静音」标记），给它设覆盖不会有声音。
                  </div>
                  {providerNames.length === 0 && <div className="prow-empty">还没有供应商可覆盖</div>}
                  {providerNames.map((p) => {
                    const own = TRIGGER_ORDER.filter((k) => overrideOf(overrides, p.id, k) != null).length
                    return (
                      <div key={p.id} className="vrs-ovr-group" data-provider-id={p.id}>
                        <div className="field-label">
                          {p.name}
                          {own > 0 && <em className="tag saved">{own} 项已覆盖</em>}
                          {mutedProviders.includes(p.id) && <em className="tag env">已静音</em>}
                        </div>
                        {TRIGGER_ORDER.map((kind) => {
                          const meta = TRIGGER_META[kind]
                          const ov = overrideOf(overrides, p.id, kind)
                          return (
                            <div key={kind} className="enable-row vrs-ovr-row">
                              <span>
                                {meta.label}
                                <em className="tag env">{meta.unit}</em>
                              </span>
                              <span className="vrs-ovr-ctl">
                                <NumInput
                                  className="vrs-override"
                                  value={ov}
                                  min={meta.min}
                                  max={meta.max}
                                  step={meta.step}
                                  placeholder="继承"
                                  providerId={p.id}
                                  trigger={kind}
                                  onCommit={(n) => onChangeOverride(p.id, kind, n)}
                                />
                                <button
                                  type="button"
                                  className="mini-btn vrs-ovr-reset"
                                  disabled={ov == null}
                                  title="取消覆盖，恢复继承全局"
                                  onClick={() => onChangeOverride(p.id, kind, null)}
                                >
                                  <Icon name="refresh" size={12} />
                                </button>
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* ── D. 其他开关 ── */}
            <div className="field-label vrs-sub">播报方式</div>
            <label className="field">
              <span className="field-label">播报内容格式</span>
              <select
                className="vrs-text-format"
                value={textFormat}
                onChange={(e) => onChangeTextFormat(e.target.value as TextFormat)}
              >
                <option value="simple">{TEXT_FORMAT_LABEL.simple}</option>
                <option value="detailed">{TEXT_FORMAT_LABEL.detailed}</option>
              </select>
            </label>

            <div className="enable-row">
              <span>
                视觉通知
                <em className="tag env">静默时给提示</em>
              </span>
              <button
                type="button"
                className={'switch' + (visual ? ' on' : '')}
                title={visual ? '关闭后只出声，不显示文字提示' : '开启后除播报外还显示视觉提示'}
                onClick={() => onToggleVisual(!visual)}
              >
                <span className="knob" />
              </button>
            </div>

            <div className="enable-row">
              <span>
                回退到系统语音
                <em className="tag env">网络失败时</em>
              </span>
              <button
                type="button"
                className={'switch' + (fallback ? ' on' : '')}
                title={fallback ? '关闭后网络失败即静默，不出声' : '开启后网络失败改用系统语音（音色因系统而异）'}
                onClick={() => onToggleFallback(!fallback)}
              >
                <span className="knob" />
              </button>
            </div>

            <div className="enable-row">
              <span>
                定时兜底播报
                <em className="tag env">例行</em>
              </span>
              <button
                type="button"
                className={'switch' + (routineOn ? ' on' : '')}
                title={routineOn ? '关闭后只在触发条件命中时播报' : '开启后无论条件如何都按间隔播报一次'}
                onClick={() => onToggleRoutine(!routineOn)}
              >
                <span className="knob" />
              </button>
            </div>

            {routineOn && (
              <div className="enable-row">
                <span>兜底间隔</span>
                <select
                  className="vrs-routine-interval"
                  value={routineMinutes}
                  onChange={(e) => onChangeRoutineMinutes(parseInt(e.target.value, 10))}
                >
                  {ROUTINE_STEPS.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                  {routineOffLadder && <option value={routineMinutes}>{routineMinutes} 分钟（当前值）</option>}
                </select>
              </div>
            )}

            <label className="field">
              <span className="field-label">
                播报历史条数上限
                <em className="tag env">10 – 1000 条</em>
              </span>
              <NumInput
                className="vrs-history-cap"
                value={historyCap}
                min={HISTORY_CAP_RANGE.min}
                max={HISTORY_CAP_RANGE.max}
                step={HISTORY_CAP_RANGE.step}
                onCommit={onChangeHistoryCap}
              />
            </label>
          </>
        )}

        <div className="settings-note vrs-foot">
          播报分级：余额预警 / 用量波动 / 用量耗尽在面板展开时也会播；
          定时兜底 / 长时间未使用 / 异常模式只在收起态播。密钥加密存入系统密钥链，不写进普通设置。
        </div>
      </div>
    </>
  )
}
