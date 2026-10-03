import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ProvidersPayload,
  ProviderInfo,
  CatalogEntry,
  ProviderKind,
  AddProviderPayload,
  ProviderPatch
} from '../../shared/types'
import { Icon, IconButton } from './components'
import { UNGROUPED, groupNames } from './read-model'
import { ProviderMark } from './ProviderMark'
import { VoiceReminderSection, type VoiceReminderSectionProps } from './VoiceReminderSection'
import badgeIcon from './assets/icon.png?inline'

// 设置页：供应商实例管理（添加 / 编辑 / 启停 / 删除）+ 外观 + 刷新频率 + 系统。
//
// 供应商不是常驻列表：内置预设也从「添加提供方」目录里选择后才会出现，
// 且同一预设可重复添加（不同 key / 不同中转站）。

const KIND_LABEL: Record<ProviderKind, string> = {
  coding: 'Coding Plan',
  token: 'Token Plan',
  balance: '直连余额'
}

const KIND_ORDER: ProviderKind[] = ['coding', 'token', 'balance']

type EditDraft = {
  name: string
  key: string
  baseUrl: string
  cookie: string
  workspaceId: string
}

function credLabel(p: ProviderInfo): string {
  switch (p.credentialSource) {
    case 'saved':
      return '已保存'
    case 'env':
      return '环境变量'
    case 'file':
      return '本机配置'
    default:
      return '未配置'
  }
}

/** 状态点语义：灰=禁用；琥珀=已启用但未配置；绿=已启用且已配置 */
function dotLevel(p: ProviderInfo): string {
  if (!p.enabled) return 'lvl-muted'
  return p.credentialSource === 'none' ? 'lvl-warn' : 'lvl-ok'
}

function ProviderRow({
  p,
  editing,
  draft,
  advancedOpen,
  authState,
  authMsg,
  onAdvanced,
  onAuth,
  onOpenConsole,
  onStartEdit,
  onCancelEdit,
  onDraft,
  onSave,
  onToggle,
  onRemove,
  muted,
  onToggleVoice,
  groupSuggestions,
  draftGroup,
  setDraftGroup,
  onSetGroup
}: {
  p: ProviderInfo
  editing: boolean
  draft: EditDraft
  advancedOpen: boolean
  authState: 'idle' | 'waiting' | 'ok'
  authMsg: string
  onAdvanced: (open: boolean) => void
  onAuth: () => void
  onOpenConsole: () => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onDraft: (patch: Partial<EditDraft>) => void
  onSave: () => void
  onToggle: () => void
  onRemove: () => void
  /** 该供应商是否已静音（不参与语音播报） */
  muted: boolean
  onToggleVoice: () => void
  /** 全部组名（datalist 的建议项；用户也可以直接输入新组名） */
  groupSuggestions: string[]
  /** 归组输入框的草稿（实例 id → 正在敲的组名）。父组件持有：草稿必须活过列表重排 */
  draftGroup: Record<string, string>
  setDraftGroup: (fn: (d: Record<string, string>) => Record<string, string>) => void
  onSetGroup: (groupId: string) => void
}): React.JSX.Element {
  const [confirmRemove, setConfirmRemove] = useState(false)
  return (
    <div
      className={'prow' + (editing ? ' editing' : '') + (p.enabled ? '' : ' off')}
      data-provider-id={p.id}
    >
      <div className="prow-main">
        <div className="prow-head">
          <span className={'dot ' + dotLevel(p)} aria-hidden="true" />
          <ProviderMark mark={p.presetId || p.protocol} size={24} />
          <span className="prow-name" title={p.name}>
            {p.name}
          </span>
          {p.builtin ? <span className="tag-builtin">内置</span> : <span className="tag-custom">自定义</span>}
          <span className="prow-actions">
            <button
              type="button"
              className={'mini-btn' + (muted ? ' muted' : '')}
              onClick={onToggleVoice}
              title={muted ? '已静音：不参与语音播报（点击恢复）' : '参与语音播报（点击静音）'}
            >
              <Icon name={muted ? 'volumeOff' : 'volume'} size={13} />
            </button>
            <button type="button" className="mini-btn" onClick={onStartEdit} title="编辑">
              <Icon name="edit" size={13} />
              编辑
            </button>
            {confirmRemove ? (
              <>
                <button
                  type="button"
                  className="mini-btn danger"
                  data-confirm="1"
                  title="再次点击确认删除"
                  onClick={onRemove}
                >
                  <Icon name="trash" size={13} />
                  确认删除
                </button>
                <button type="button" className="mini-btn" onClick={() => setConfirmRemove(false)}>
                  取消
                </button>
              </>
            ) : (
              <button
                type="button"
                className="mini-btn danger"
                title="删除"
                onClick={() => setConfirmRemove(true)}
              >
                <Icon name="trash" size={13} />
                删除
              </button>
            )}
          </span>
        </div>
        <div className="prow-sub">
          {KIND_LABEL[p.kind]} · {credLabel(p)}
          {p.baseUrl && <span className="prow-url"> · {p.baseUrl.replace(/^https?:\/\//, '')}</span>}
        </div>
        {/* 归组：分组是**用户自由标签**，所以控件必须能直接**输入**新组名，而不只是
            在已有组里挑。用 `<input list>` + `<datalist>`：既有下拉建议，又能自由输入，
            一个控件同时满足两者。

            ⚠ 不用 `<select>`：空串在 select 里**不能**当「未分组」的哨兵 ——
              受控 select 找不到匹配项会静默回落到第一个选项，于是「未分组」与
              「新建分组」都表达不出来（state-management.md 记过这个坑）。
            ⚠ 组名不建注册表（design.md D2）：删掉最后一组成员，那个组自然消失。 */}
        <label className="prow-group">
          <span className="field-label">分组</span>
          <input
            className="grp-input"
            type="text"
            list={`grp-list-${p.id}`}
            value={draftGroup[p.id] ?? p.groupId ?? ''}
            placeholder={UNGROUPED}
            title="分组：主页卡片按组聚合显示，可用标题栏的下拉只显示某一组。留空 = 未分组（不影响采集）"
            onChange={(e) => setDraftGroup((d) => ({ ...d, [p.id]: e.target.value }))}
            onBlur={(e) => void onSetGroup(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
          <datalist id={`grp-list-${p.id}`}>
            {groupSuggestions.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>
      </div>

      {editing && (
        <div className="prow-form">
          <label className="field">
            <span className="field-label">名称</span>
            <input
              type="text"
              value={draft.name}
              placeholder={p.name}
              onChange={(e) => onDraft({ name: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">
              凭据
              {p.credentialSource === 'saved' && <em className="tag saved">已保存（留空保持不变）</em>}
              {p.credentialSource === 'env' && <em className="tag env">环境变量</em>}
              {p.credentialSource === 'file' && <em className="tag env">本机配置自动读取</em>}
            </span>
            <input
              type="password"
              value={draft.key}
              placeholder={p.keyHint ?? (p.credentialSource === 'none' ? '未配置' : '已配置（输入可替换）')}
              onChange={(e) => onDraft({ key: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">API 地址</span>
            <input
              type="text"
              value={draft.baseUrl}
              placeholder={p.baseUrl || '留空使用默认'}
              onChange={(e) => onDraft({ baseUrl: e.target.value })}
            />
          </label>

          {p.supportsCookie && (
            <div className="advanced">
              <button
                type="button"
                className={'advanced-head' + (advancedOpen ? ' open' : '')}
                onClick={() => onAdvanced(!advancedOpen)}
              >
                <Icon name="chevron" size={14} />
                <span>高级设置 · 控制台精度增强</span>
                <em className="tag env">{p.cookieHint ? '已配置' : '可选'}</em>
              </button>
              {advancedOpen && (
                <div className="advanced-body">
                  <div className="advanced-note">
                    官方 API 只返回整数百分比（如 4%）。登录 OpenCode 控制台后能拿到
                    <b>服务端下发的限额</b>与<b>精确已用量</b>（如 $5.0588 / 一位小数 16.9%），
                    不用再从百分比反算。
                    <b>不配置也能用</b>，但会退回本机 opencode.db 估算 ——
                    那是<b>另一种口径</b>（本机记录、只覆盖这台机器），不只是精度变粗。
                  </div>
                  <div className="auth-row">
                    <button
                      type="button"
                      className="btn-secondary auth-primary"
                      onClick={onAuth}
                      disabled={authState === 'waiting'}
                      title="打开登录窗口，登录后自动获取 Cookie 与 Workspace ID"
                    >
                      <Icon name="lightning" size={14} />
                      {authState === 'waiting' ? '等待登录…' : '一键授权'}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={onOpenConsole}
                      title="在系统默认浏览器中打开控制台（手动复制 Cookie 用）"
                    >
                      打开控制台
                    </button>
                  </div>
                  {authMsg && <div className={'auth-msg' + (authState === 'ok' ? ' ok' : '')}>{authMsg}</div>}
                  <label className="field">
                    <span className="field-label">
                      控制台 Cookie
                      {p.cookieHint && <em className="tag env">{p.cookieHint}</em>}
                    </span>
                    <input
                      type="password"
                      value={draft.cookie}
                      placeholder="也可从浏览器手动复制（含 auth=…）"
                      onChange={(e) => onDraft({ cookie: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Workspace ID</span>
                    <input
                      type="text"
                      value={draft.workspaceId}
                      placeholder="wrk_01XXXXXXXX…（控制台 URL 中的 workspace 段）"
                      onChange={(e) => onDraft({ workspaceId: e.target.value })}
                    />
                  </label>
                </div>
              )}
            </div>
          )}

          <div className="prow-form-actions">
            <button type="button" className="btn-secondary" onClick={onCancelEdit}>
              取消
            </button>
            <button type="button" className="btn-primary sm" onClick={onSave}>
              <Icon name="check" size={14} />
              保存
            </button>
            <span className="spacer" />
            <button
              type="button"
              className={'switch' + (p.enabled ? ' on' : '')}
              title={p.enabled ? '点击禁用' : '点击启用'}
              onClick={onToggle}
            >
              <span className="knob" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function SettingsView({
  onBack,
  onDataChanged,
  voiceMuted,
  onToggleVoice,
  alwaysTop,
  onToggleAlwaysTop,
  dockHide,
  onToggleDockHide,
  ...sectionProps
}: {
  onBack: () => void
  onDataChanged: () => void
  /** 已静音的供应商 id（不参与语音播报） */
  voiceMuted: string[]
  onToggleVoice: (id: string) => void
  /** 悬浮球是否总在最前（ui:alwaysOnTop） */
  alwaysTop: boolean
  onToggleAlwaysTop: (on: boolean) => void
  /** 贴边自动隐藏（ui:dockHide，默认开） */
  dockHide: boolean
  onToggleDockHide: (on: boolean) => void
  // 语音提醒分区的 props 用 rest 透传：少传任何一个仍是编译错误；
  // TS 不对 JSX 的变量展开做多余属性检查，分区取自己那份即可。
  //
  // ⚠ 这里**没有**语音性别开关：系统语音回退固定用女声（App 的 DEFAULT_VOICE_GENDER），
  //   设置页不再提供第二处开关 —— 同一个问题问两遍，两处迟早会打架。
} & VoiceReminderSectionProps): React.JSX.Element {
  const [payload, setPayload] = useState<ProvidersPayload | null>(null)
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<EditDraft>({ name: '', key: '', baseUrl: '', cookie: '', workspaceId: '' })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [customProtocol, setCustomProtocol] = useState<string | null>(null)
  const [custom, setCustom] = useState<{ name: string; baseUrl: string; key: string }>({ name: '', baseUrl: '', key: '' })
  const [busy, setBusy] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const flashTimer = useRef<number | null>(null)
  /** 高级设置（控制台精度增强）折叠态：默认关闭 */
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [authState, setAuthState] = useState<'idle' | 'waiting' | 'ok'>('idle')
  const [authMsg, setAuthMsg] = useState('')
  /**
   * 归组输入框的**草稿**（实例 id → 用户正在敲的组名）。
   *
   * 为什么不直接 `value={p.groupId}`：受控输入框里每次按键都会立刻触发一次
   * `setInstanceGroup` → 每次按键一次 `setExtra` → **整文件重写 secrets.bin**（store.ts）。
   * 草稿 + onBlur 提交 = 一次编辑只写一次盘。
   */
  const [draftGroup, setDraftGroup] = useState<Record<string, string>>({})

  // 外观 / 频率 / 系统
  const [skin, setSkin] = useState('aero')
  const [skins, setSkins] = useState<{ id: string; name: string; builtin: boolean }[]>([])
  const [refreshInterval, setRefreshInterval] = useState('60')
  const [autostart, setAutostart] = useState(false)
  /** 系统登录项里残留的本应用（旧版本遗留，本开关管不到） */
  const [foreignLoginItem, setForeignLoginItem] = useState(false)

  const refresh = useCallback(async () => {
    const [p, cat, ex] = await Promise.all([
      window.api.listProviders(),
      window.api.listCatalog(),
      window.api.getExtras(['skin', 'refreshInterval', 'interval:plan'])
    ])
    setPayload(p)
    setCatalog(cat)
    setSkin(ex['skin'] || 'aero')
    // 兼容旧版本的双频率设置：迁移到期单一 refreshInterval
    setRefreshInterval(ex['refreshInterval'] || ex['interval:plan'] || '60')
    await window.api.listSkins().then(setSkins)
    await window.api.getAutostart().then(setAutostart)
    await window.api.hasForeignLoginItem().then(setForeignLoginItem)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const flash = (): void => {
    setSavedFlash(true)
    // ⚠️ 必须清掉上一次的计时器：连续两次操作时，旧计时器会把新的"已保存"提前熄掉
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setSavedFlash(false), 1600)
  }
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    },
    []
  )

  const startEdit = (p: ProviderInfo): void => {
    setEditingId(p.id)
    setDraft({ name: p.name, key: '', baseUrl: '', cookie: '', workspaceId: '' })
    setAdvancedOpen(false)
    setAuthState('idle')
    setAuthMsg('')
  }

  /** 一键授权：内嵌登录窗口 → 自动抓取 cookie + workspace id 并保存 */
  const runAuth = async (): Promise<void> => {
    setAuthState('waiting')
    setAuthMsg('请在打开的窗口中登录 OpenCode 账号…')
    try {
      const r = await window.api.startOpencodeAuth()
      if (r.ok && r.providers) {
        setPayload(r.providers)
        setAuthState('ok')
        setAuthMsg(`授权成功，已启用控制台精度（workspace ${r.workspaceId}）`)
        onDataChanged()
      } else {
        setAuthState('idle')
        setAuthMsg(r.error ?? '授权未完成')
      }
    } catch (e) {
      setAuthState('idle')
      setAuthMsg(`授权失败：${(e as Error).message}`)
    }
  }

  const saveEdit = async (id: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const patch: ProviderPatch = { id }
      if (draft.name.trim()) patch.name = draft.name.trim()
      if (draft.baseUrl.trim()) patch.baseUrl = draft.baseUrl.trim()
      if (draft.key.trim()) patch.key = draft.key.trim()
      if (draft.cookie.trim()) patch.cookie = draft.cookie.trim()
      if (draft.workspaceId.trim()) patch.workspaceId = draft.workspaceId.trim()
      const next = await window.api.updateProvider(patch)
      setPayload(next)
      setEditingId(null)
      onDataChanged()
      flash()
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (p: ProviderInfo): Promise<void> => {
    const next = await window.api.updateProvider({ id: p.id, enabled: !p.enabled })
    setPayload(next)
    onDataChanged()
  }

  /** 归组：写回主进程注册表（groupId 的唯一真相源在那里），响应体即最新列表 */
  const setGroup = async (p: ProviderInfo, groupId: string): Promise<void> => {
    const next = await window.api.setInstanceGroup(p.id, groupId)
    setPayload(next)
    onDataChanged()
    flash()
  }

  const remove = async (p: ProviderInfo): Promise<void> => {
    const next = await window.api.removeProvider(p.id)
    setPayload(next)
    if (editingId === p.id) setEditingId(null)
    onDataChanged()
    flash()
  }

  /** 添加内置预设实例 → 立即打开编辑表单填 key */
  const addPreset = async (entry: CatalogEntry): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const next = await window.api.addProvider({ presetId: entry.presetId ?? undefined })
      setPayload(next)
      setPickerOpen(false)
      setCatalog(await window.api.listCatalog())
      onDataChanged()
      // 自动进入编辑态，方便填写凭据
      const added = next.providers[next.providers.length - 1]
      if (added) {
        setEditingId(added.id)
        setDraft({ name: '', key: '', baseUrl: '', cookie: '', workspaceId: '' })
      }
    } finally {
      setBusy(false)
    }
  }

  /** 选择自定义协议 → 打开表单 */
  const startCustom = (entry: CatalogEntry): void => {
    setPickerOpen(false)
    setCustomProtocol(entry.protocol)
    setCustom({ name: '', baseUrl: entry.defaultBaseUrl, key: '' })
  }

  const submitCustom = async (): Promise<void> => {
    if (busy || !customProtocol) return
    setBusy(true)
    try {
      const p: AddProviderPayload = {
        protocol: customProtocol,
        name: custom.name.trim(),
        baseUrl: custom.baseUrl.trim(),
        key: custom.key.trim()
      }
      const next = await window.api.addProvider(p)
      setPayload(next)
      setCatalog(await window.api.listCatalog())
      setCustomProtocol(null)
      setCustom({ name: '', baseUrl: '', key: '' })
      onDataChanged()
      flash()
    } finally {
      setBusy(false)
    }
  }

  const savePrefs = async (): Promise<void> => {
    await window.api.setExtras({ refreshInterval })
    onDataChanged()
    flash()
  }

  /** 刷新频率即改即存（并立即生效，无需等下一轮） */
  const changeInterval = async (value: string): Promise<void> => {
    setRefreshInterval(value)
    await window.api.setExtras({ refreshInterval: value })
    onDataChanged()
    flash()
  }

  const grouped = useMemo(() => {
    if (!payload) return []
    const out: { kind: ProviderKind; items: ProviderInfo[] }[] = []
    for (const kind of KIND_ORDER) {
      const items = payload.providers.filter((p) => p.kind === kind)
      if (items.length) out.push({ kind, items })
    }
    return out
  }, [payload])

  /**
   * 全部组名（含「未分组」兜底）。
   *
   * ⚠ 组名不是独立存储的：它就是 `groupId` 字段取值集合的去重结果（design.md D2），
   *   所以这个列表永远与实例列表一致 —— 删除最后一个成员，那个组自然消失。
   */
  const allGroups = useMemo(
    () => groupNames(payload?.providers ?? []),
    [payload]
  )

  const presetEntries = useMemo(() => catalog.filter((c) => c.presetId), [catalog])
  const protocolEntries = useMemo(() => catalog.filter((c) => !c.presetId), [catalog])
  const activeCustom = customProtocol ? protocolEntries.find((e) => e.protocol === customProtocol) : undefined

  return (
    <div className="card settings">
      <header className="titlebar">
        <span className="brand-badge">
          <img src={badgeIcon} alt="" draggable={false} />
        </span>
        <span className="title-text">
          <span className="brand">设置</span>
        </span>
        <IconButton name="close" title="返回" onClick={onBack} />
      </header>

      <div className="body-scroll settings-body">
        <div className="section-title">供应商</div>

        {/* 分组只决定主页卡片的**分块聚合**：组是显示层的归类，不影响采集、
            托盘与提醒（它们永远覆盖全部账户）。 */}
        <div className="grp-note">
          分组用于主页卡片按块聚合显示。
          <b>分组只影响列表分块</b>：全部账户仍会正常采集，托盘与提醒仍覆盖全部账户。
        </div>

        {grouped.length === 0 && (
          <div className="prow-empty">还没有添加供应商，从下方「添加提供方」开始</div>
        )}

        {grouped.map(({ kind, items }) => (
          <div key={kind} className="provider-group">
            <div className="group-label">{KIND_LABEL[kind]}</div>
            {items.map((p) => (
              <ProviderRow
                key={p.id}
                p={p}
                editing={editingId === p.id}
                draft={draft}
                advancedOpen={advancedOpen}
                authState={authState}
                authMsg={authMsg}
                onAdvanced={setAdvancedOpen}
                onAuth={() => void runAuth()}
                onOpenConsole={() => void window.api.openOpencodeConsole()}
                onStartEdit={() => (editingId === p.id ? setEditingId(null) : startEdit(p))}
                onCancelEdit={() => setEditingId(null)}
                onDraft={(patch) => setDraft((d) => ({ ...d, ...patch }))}
                onSave={() => void saveEdit(p.id)}
                onToggle={() => void toggle(p)}
                onRemove={() => void remove(p)}
                muted={voiceMuted.includes(p.id)}
                onToggleVoice={() => onToggleVoice(p.id)}
                groupSuggestions={allGroups}
                draftGroup={draftGroup}
                setDraftGroup={setDraftGroup}
                onSetGroup={(g) => void setGroup(p, g)}
              />
            ))}
          </div>
        ))}

        <div className="add-row">
          <button type="button" className="add-btn" onClick={() => setPickerOpen((v) => !v)}>
            <Icon name="plus" size={15} />
            添加提供方
          </button>
          <button
            type="button"
            className="add-btn"
            onClick={() => {
              setPickerOpen(false)
              setCustomProtocol(protocolEntries[0]?.protocol ?? null)
              setCustom({ name: '', baseUrl: protocolEntries[0]?.defaultBaseUrl ?? '', key: '' })
            }}
          >
            <Icon name="plus" size={15} />
            添加自定义提供方
          </button>
        </div>

        {pickerOpen && (
          <div className="picker">
            <div className="picker-hint">常用供应商（获取余额/用量的方式特殊，已内置适配）</div>
            {presetEntries.length === 0 && <div className="picker-empty">全部内置供应商都已添加</div>}
            {presetEntries.map((e) => (
              <button key={e.key} type="button" className="picker-item" onClick={() => void addPreset(e)}>
                <ProviderMark mark={e.presetId ?? e.protocol} size={22} />
                <span className="picker-name">{e.label}</span>
                <span className="picker-kind">{KIND_LABEL[e.kind]}</span>
                <Icon name="plus" size={14} />
              </button>
            ))}
            <div className="picker-hint" style={{ marginTop: 6 }}>
              自定义协议（同一协议可添加多个，例如多个中转平台）
            </div>
            {protocolEntries.map((e) => (
              <button key={e.key} type="button" className="picker-item" onClick={() => startCustom(e)}>
                <ProviderMark mark={e.protocol} size={22} />
                <span className="picker-name">{e.label}</span>
                <span className="picker-kind">{KIND_LABEL[e.kind]}</span>
                <Icon name="plus" size={14} />
              </button>
            ))}
          </div>
        )}

        {customProtocol && (
          <div className="picker custom-form">
            <div className="picker-hint">自定义供应商：{activeCustom?.hint}</div>
            <label className="field">
              <span className="field-label">名称（随意填写）</span>
              <input
                type="text"
                value={custom.name}
                placeholder={`例如：${activeCustom?.label ?? '我的中转'}`}
                onChange={(e) => setCustom((c) => ({ ...c, name: e.target.value }))}
              />
            </label>
            <label className="field">
              <span className="field-label">协议</span>
              <select
                value={customProtocol}
                onChange={(e) => {
                  const id = e.target.value
                  setCustomProtocol(id)
                  const entry = protocolEntries.find((x) => x.protocol === id)
                  setCustom((c) => ({ ...c, baseUrl: entry?.defaultBaseUrl ?? c.baseUrl }))
                }}
              >
                {protocolEntries.map((e) => (
                  <option key={e.key} value={e.protocol}>
                    {e.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">
                API 地址
                {customProtocol === 'generic' && (
                  <em className="tag env">填完整 URL，例如 https://api.example.com/v1/balance</em>
                )}
              </span>
              <input
                type="text"
                value={custom.baseUrl}
                placeholder={activeCustom?.defaultBaseUrl || 'https://…'}
                onChange={(e) => setCustom((c) => ({ ...c, baseUrl: e.target.value }))}
              />
            </label>
            <label className="field">
              <span className="field-label">API Key</span>
              <input
                type="password"
                value={custom.key}
                placeholder="sk-…"
                onChange={(e) => setCustom((c) => ({ ...c, key: e.target.value }))}
              />
            </label>
            <div className="prow-form-actions">
              <button type="button" className="btn-secondary" onClick={() => setCustomProtocol(null)}>
                取消
              </button>
              <button type="button" className="btn-primary sm" onClick={() => void submitCustom()}>
                <Icon name="plus" size={14} />
                添加
              </button>
            </div>
          </div>
        )}

        <VoiceReminderSection {...sectionProps} />

        <div className="section-title">外观</div>
        <label className="field">
          <span className="field-label">皮肤（卡片上右键也可快速切换；外部皮肤放入 userData/skins 即自动发现）</span>
          <select
            value={skin}
            onChange={(e) => {
              setSkin(e.target.value)
              window.api.setSkin(e.target.value)
            }}
          >
            {skins.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        <div className="section-title">刷新频率</div>
        <label className="field">
          <span className="field-label">
            所有供应商统一频率
            <em className="tag env">10 秒 – 5 分钟</em>
          </span>
          <select
            className="refresh-interval"
            value={refreshInterval}
            onChange={(e) => void changeInterval(e.target.value)}
          >
            <option value="10">10 秒（最灵敏）</option>
            <option value="15">15 秒</option>
            <option value="30">30 秒</option>
            <option value="60">1 分钟（推荐）</option>
            <option value="120">2 分钟</option>
            <option value="300">5 分钟（最省流量）</option>
          </select>
        </label>
        <div className="settings-note">
          界面上的百分比是账户实时用量，刷新越频繁越及时；余额类接口多数有频控，建议不低于 30 秒。
        </div>

        <div className="section-title">系统</div>
        <div className="enable-row">
          <span>
            悬浮球总在最前
            <em className="tag env">置顶</em>
          </span>
          <button
            type="button"
            className={'switch' + (alwaysTop ? ' on' : '')}
            title={alwaysTop ? '关闭后不再悬浮于其它窗口之上' : '开启后始终显示在最前面'}
            onClick={() => onToggleAlwaysTop(!alwaysTop)}
          >
            <span className="knob" />
          </button>
        </div>
        <div className="enable-row">
          <span>
            贴边自动隐藏
            <em className="tag env">贴边 1 秒后只留一条痕迹</em>
          </span>
          <button
            type="button"
            className={'switch dock-hide' + (dockHide ? ' on' : '')}
            title={dockHide ? '关闭后悬浮球不再自动隐藏' : '开启后拖到屏幕边缘会滑入边框、悬停痕迹可唤出'}
            onClick={() => onToggleDockHide(!dockHide)}
          >
            <span className="knob" />
          </button>
        </div>
        <div className="enable-row">
          <span>开机自启</span>
          <button
            type="button"
            className={'switch' + (autostart ? ' on' : '')}
            title={autostart ? '点击关闭' : '点击开启'}
            onClick={() => void window.api.setAutostart(!autostart).then(setAutostart)}
          >
            <span className="knob" />
          </button>
        </div>
        {foreignLoginItem && (
          <div className="settings-note warn">
            系统「登录项」里还残留着本应用（多来自旧版本），本开关无法移除它。请到
            「系统偏好设置 → 用户与群组 → 登录项」中手动删除，否则仍会开机启动。
          </div>
        )}
        {payload?.scanHits && payload.scanHits.length > 0 && (
          <div className="scan-hits">
            <div className="field-label">环境变量扫描</div>
            {payload.scanHits.map((h, i) => (
              <div key={i} className="scan-hit">
                · {h.source}
              </div>
            ))}
          </div>
        )}

        <div className="settings-foot">
          {savedFlash && (
            <div className="saved-flash">
              <Icon name="check" size={14} />
              已保存
            </div>
          )}
          <div className="settings-note">
            设置即改即存。凭据加密存入系统密钥链（Keychain / DPAPI），本应用不做任何上传。
          </div>
        </div>
      </div>
    </div>
  )
}
