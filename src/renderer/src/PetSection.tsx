import { useEffect, useRef, useState } from 'react'
import { PETS, petMeta, type PetId, type PetState } from '../../shared/pet'
import { Icon } from './components'

// ═══════════════════════════════════════════════════════════════════════════════
// 设置页「数字助理」分区
//
// 定位是数字助理，不是宠物 —— 等级 / 经验 / 亲密度 / 饱食度 / 心情 / 撸一把 / 喂食
// 那一整套养成体系已下线（2026-09-21）。这里只剩：
//   · 选一位（Aria / Ray）与改名
//   · 三个开关：收起态形态（个性人物）、显示用量环、定时播报（含间隔）
//
// 头像直接用采集期 preview.png（bd-asset 直显，不占 WebGL 上下文）。
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
  onChangePet: (id: PetId) => void
  onRenamePet: (name: string) => void
  onTogglePetBall: (on: boolean) => void
  onTogglePetRing: (on: boolean) => void
  onToggleVoiceOn: (on: boolean) => void
  onSetVoiceEvery: (minutes: number) => void
}

export function PetSection({
  pet,
  petOn,
  petRing,
  voiceOn,
  voiceEvery,
  onChangePet,
  onRenamePet,
  onTogglePetBall,
  onTogglePetRing,
  onToggleVoiceOn,
  onSetVoiceEvery
}: PetSectionProps): React.JSX.Element {
  const meta = petMeta(pet.id)
  /** 角色头像（bd-asset 直显 preview.png） */
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(pet.name)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  useEffect(() => {
    let alive = true
    for (const p of PETS) {
      if (!alive) return
      setThumbs((prev) => ({ ...prev, [p.id]: `bd-asset://${p.id}/preview.png` }))
    }
    return () => {
      alive = false
    }
  }, [])

  const commitName = (): void => {
    const name = draft.trim().slice(0, 12)
    if (name && name !== pet.name) onRenamePet(name)
    setEditing(false)
  }

  return (
    <>
      <div className="section-title">数字助理</div>
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
            </div>
            <div className="pet-sec-mood">{meta.desc}</div>
          </div>
        </div>

        <div className="enable-row">
          <span>
            个性人物
            <em className="tag env">收起态</em>
          </span>
          <button
            type="button"
            className={'switch' + (petOn ? ' on' : '')}
            title={petOn ? '关闭后收起态是那个小圆环' : '开启后收起态是这个人，站在桌面上'}
            onClick={() => onTogglePetBall(!petOn)}
          >
            <span className="knob" />
          </button>
        </div>
        <div className="settings-note">
          {petOn
            ? '开启中：收起后是这个人站在桌面上（无球壳、无进度环），读数显示在脚下；出场会从窗口外走进来，平时会随机做几个小动作。单击展开、拖动移动、右键菜单。'
            : '关闭中：收起后是一个 56×56 的小圆环（环心一个数，不加载人物素材、不占显存）。'}
        </div>

        <div className="enable-row">
          <span>显示用量环</span>
          <button
            type="button"
            className={'switch' + (petRing ? ' on' : '')}
            title={petRing ? '关闭后圆环上不显示用量弧' : '开启后在圆环上显示用量弧（个性人物形态没有环）'}
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

        <div className="field-label pet-sec-label">换一位</div>
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
      </div>
    </>
  )
}
