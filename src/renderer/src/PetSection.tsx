import { useEffect, useRef, useState } from 'react'
import { PETS, expNeed, petMeta, petMood, type PetId, type PetState } from '../../shared/pet'
import { Icon } from './components'
import type { PetActionResult } from '../../shared/pet'

// ═══════════════════════════════════════════════════════════════════════════════
// 设置页「宠物」分区
//
// 面板不再常驻宠物卡（主面板只放 KPI），宠物的一切管理都收在这里：
//   · 改名 / 换一只 / 个性人物开关（收起态是否以人物形态出现）
//   · 成长数据（等级 / 亲密度 / 饱食度）与互动（撸一把 / 喂食）
//   · 数据迁移（导出 / 导入 JSON）
//
// 头像：Q 版走 3D 缩略图（thumbnail.ts 临时渲染一次后缓存），
// 真人系直接用采集期 preview.png（bd-asset 直显，不占 WebGL 上下文）。
// ═══════════════════════════════════════════════════════════════════════════════

export interface PetSectionProps {
  pet: PetState
  petOn: boolean
  /** 悬浮球是否显示用量环（个性人物形态没有环，此项只影响球形态） */
  petRing: boolean
  /** 语音播报开关 */
  voiceOn: boolean
  /** 语音播报间隔（分钟） */
  voiceEvery: number
  onPet: () => PetActionResult
  onFeed: () => PetActionResult
  onChangePet: (id: PetId) => void
  onRenamePet: (name: string) => void
  onTogglePetBall: (on: boolean) => void
  onTogglePetRing: (on: boolean) => void
  onToggleVoiceOn: (on: boolean) => void
  onSetVoiceEvery: (minutes: number) => void
  onExportPet: () => Promise<'ok' | 'cancel' | 'fail'>
  onImportPet: () => Promise<'ok' | 'cancel' | 'fail'>
}

const MOOD_LABEL: Record<string, string> = {
  happy: '心情很好',
  fine: '还不错',
  hungry: '肚子饿了',
  lonely: '有点想你'
}

export function PetSection({
  pet,
  petOn,
  petRing,
  voiceOn,
  voiceEvery,
  onPet,
  onFeed,
  onChangePet,
  onRenamePet,
  onTogglePetBall,
  onTogglePetRing,
  onToggleVoiceOn,
  onSetVoiceEvery,
  onExportPet,
  onImportPet
}: PetSectionProps): React.JSX.Element {
  const meta = petMeta(pet.id)
  /** 角色缩略图（3D 素材渲染一次后缓存，换角色无需重新渲染） */
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(pet.name)
  const [notice, setNotice] = useState('')
  const noticeTimer = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  // 逐只渲染缩略图（串行：一次只占一个 WebGL 上下文，渲染完即释放）。
  // 缩略图用采集期的 preview.png（bd-asset 协议直显，不占 WebGL 上下文）。
  useEffect(() => {
    let alive = true
    void (async () => {
      for (const p of PETS) {
        try {
          const url = `bd-asset://${p.id}/preview.png`
          if (!alive) return
          setThumbs((prev) => ({ ...prev, [p.id]: url }))
        } catch {
          // 单只失败不影响其它角色（显示占位）
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    },
    []
  )

  const flash = (msg: string): void => {
    setNotice(msg)
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(''), 2200)
  }

  const commitName = (): void => {
    const name = draft.trim().slice(0, 12)
    if (name && name !== pet.name) onRenamePet(name)
    setEditing(false)
  }

  const act = (r: PetActionResult, okMsg: string): void => {
    if (!r.ok) {
      flash(r.reason === 'full' ? '已经吃饱啦' : '让我缓一下…')
      return
    }
    flash(r.levelUps > 0 ? `升级！Lv.${pet.level + r.levelUps}` : okMsg)
  }

  const exportNow = async (): Promise<void> => {
    const r = await onExportPet()
    flash(r === 'ok' ? '已导出' : r === 'cancel' ? '已取消' : '导出失败')
  }
  const importNow = async (): Promise<void> => {
    const r = await onImportPet()
    flash(r === 'ok' ? '已导入' : r === 'cancel' ? '已取消' : '文件格式不对')
  }

  const expMax = expNeed(pet.level)

  return (
    <>
      <div className="section-title">宠物</div>
      <div className="pet-sec">
        <div className="pet-sec-main">
          <span className="pet-avatar" title={`${meta.name} · ${meta.trick}`}>
            {thumbs[pet.id] ? (
              <img src={thumbs[pet.id]} alt={meta.name} draggable={false} />
            ) : (
              <span className="pet-avatar-ph" />
            )}
          </span>
          <div className="pet-stats">
            <div className="pet-name-row">
              {editing ? (
                <input
                  ref={inputRef}
                  className="pet-name-input"
                  value={draft}
                  maxLength={12}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitName}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitName()
                    if (e.key === 'Escape') setEditing(false)
                  }}
                />
              ) : (
                <>
                  <span className="pet-name">{pet.name}</span>
                  <button
                    type="button"
                    className="pet-rename"
                    title="改名"
                    onClick={() => {
                      setDraft(pet.name)
                      setEditing(true)
                    }}
                  >
                    <Icon name="edit" size={12} />
                  </button>
                </>
              )}
              <span className="pet-lv">Lv.{pet.level}</span>
            </div>
            <div className="pet-exp" title={`经验 ${pet.exp}/${expMax}`}>
              <span style={{ width: `${Math.min(100, (pet.exp / expMax) * 100)}%` }} />
            </div>
            <div className="pet-sec-mood">{MOOD_LABEL[petMood(pet)] ?? ''}</div>
          </div>
        </div>

        <div className="pet-vitals">
          <Vital label="亲密度" value={pet.affection} cls="bond" />
          <Vital label="饱食度" value={pet.fullness} cls="food" />
        </div>

        <div className="pet-actions">
          <button type="button" className="btn-secondary" onClick={() => act(onPet(), '好舒服～')}>
            <Icon name="heart" size={13} />
            撸一把
          </button>
          <button type="button" className="btn-secondary" onClick={() => act(onFeed(), '吃得很香')}>
            <Icon name="plus" size={13} />
            喂食
          </button>
        </div>

        <div className="enable-row">
          <span>
            个性人物
            <em className="tag env">收起态</em>
          </span>
          <button
            type="button"
            className={'switch' + (petOn ? ' on' : '')}
            title={petOn ? '关闭后收起态只有悬浮球' : '开启后收起态是这个人，站在桌面上'}
            onClick={() => onTogglePetBall(!petOn)}
          >
            <span className="knob" />
          </button>
        </div>
        <div className="settings-note">
          {petOn
            ? '开启中：收起后是这个人站在桌面上（无球壳、无进度环），读数显示在脚下；单击展开、拖动移动、长按撸一把、右键菜单。'
            : '关闭中：收起后是 3D 悬浮球（玻璃球 + 用量环，不加载人物素材）。'}
        </div>

        <div className="enable-row">
          <span>显示用量环</span>
          <button
            type="button"
            className={'switch' + (petRing ? ' on' : '')}
            title={petRing ? '关闭后球上不显示 KPI 环' : '开启后在球上显示用量环（个性人物形态没有环）'}
            onClick={() => onTogglePetRing(!petRing)}
          >
            <span className="knob" />
          </button>
        </div>

        <div className="enable-row">
          <span>
            定时播报
            <em className="tag env">系统语音</em>
          </span>
          <button
            type="button"
            className={'switch' + (voiceOn ? ' on' : '')}
            title={voiceOn ? '关闭后不再播报' : '开启后按间隔播报焦点供应商余额与用量'}
            onClick={() => onToggleVoiceOn(!voiceOn)}
          >
            <span className="knob" />
          </button>
        </div>

        {voiceOn && (
          <div className="enable-row">
            <span>播报间隔</span>
            <select
              value={voiceEvery}
              onChange={(e) => onSetVoiceEvery(parseInt(e.target.value, 10))}
              className="voice-interval"
            >
              <option value={1}>1 分钟</option>
              <option value={3}>3 分钟</option>
              <option value={5}>5 分钟</option>
              <option value={10}>10 分钟</option>
              <option value={15}>15 分钟</option>
              <option value={30}>30 分钟</option>
              <option value={60}>60 分钟</option>
            </select>
          </div>
        )}

        <div className="field-label pet-sec-label">换一只（保留等级与亲密度）</div>
        <div className="pet-chips">
          {PETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={'pet-chip' + (p.id === pet.id ? ' on' : '')}
              title={`${p.name} · ${p.desc}`}
              onClick={() => {
                if (p.id !== pet.id) onChangePet(p.id)
              }}
            >
              {thumbs[p.id] ? (
                <img src={thumbs[p.id]} alt={p.name} draggable={false} />
              ) : (
                <span className="pet-chip-ph" />
              )}
              <span>{p.name}</span>
            </button>
          ))}
        </div>

        <div className="pet-actions">
          <button type="button" className="btn-secondary" onClick={() => void exportNow()}>
            <Icon name="download" size={13} />
            导出数据
          </button>
          <button type="button" className="btn-secondary" onClick={() => void importNow()}>
            <Icon name="upload" size={13} />
            导入数据
          </button>
        </div>
        <div className="pet-sec-foot">{notice || '养成数据只存在本机（导出为 JSON 可换机迁移）'}</div>
      </div>
    </>
  )
}

function Vital({ label, value, cls }: { label: string; value: number; cls: string }): React.JSX.Element {
  return (
    <div className="pet-stat">
      <span className="pet-stat-label">{label}</span>
      <span className={`pet-bar ${cls}`}>
        <b style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </span>
      <em className="pet-stat-value">{Math.round(value)}</em>
    </div>
  )
}
