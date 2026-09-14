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
import { ProviderMark } from './ProviderMark'
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
  onRemove
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
                    官方 API 只返回整数百分比（如 4%）。登录 OpenCode 控制台后可拿到一位小数（如 4.3%），
                    与控制台页面逐位一致。<b>不配置不影响使用</b>，只是精度为整数。
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

export function SettingsView({ onBack, onDataChanged }: { onBack: () => void; onDataChanged: () => void }): React.JSX.Element {
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
          <select value={refreshInterval} onChange={(e) => void changeInterval(e.target.value)}>
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
