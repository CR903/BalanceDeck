import { useEffect, useRef, useState } from 'react'
import { PETS, petMeta, type PetId, type PetState } from '../../shared/pet'
import { Icon } from './components'

// ═══════════════════════════════════════════════════════════════════════════════
// 设置页「数字助理」分区
//
// 定位是数字助理，不是宠物 —— 等级 / 经验 / 亲密度 / 饱食度 / 心情 / 撸一把 / 喂食
// 那一整套养成体系已下线（2026-09-21）。这里只剩：
//   · 选一位（Aria / Ray）与改名
//   · 一个开关：收起态形态（个性人物）
//
// 播报（开关 / 间隔 / 阈值 / 服务配置）已整体搬到「语音提醒」分区（VoiceReminderSection，
// 2026-09-29）。这里曾留着一条「定时播报 + 播报间隔」，在播报链路切到 TTS 之后它已经
// 没有任何执行方 —— 界面上能点、extras 也照写，但什么都不会发生。留着的唯一效果是让
// 用户以为设置生效了，故整条删掉。
//
// 音色性别也搬走了，而且**不是搬过去、是被删掉**：它曾是设置页里第二个「谁替我说话」的
// 开关，与这里的助理选择问的是同一个问题，两处迟早打架。系统语音的性别现在由本分区选的
// 助理现算（shared/pet.ts 的 petGender），ui:voiceGender 已下线（09-29-voice-settings-refactor）。
//
// 头像直接用采集期 preview.png（bd-asset 直显，不占 WebGL 上下文）。
// ═══════════════════════════════════════════════════════════════════════════════

export interface PetSectionProps {
  pet: PetState
  petOn: boolean
  onChangePet: (id: PetId) => void
  onRenamePet: (name: string) => void
  onTogglePetBall: (on: boolean) => void
}

export function PetSection({
  pet,
  petOn,
  onChangePet,
  onRenamePet,
  onTogglePetBall
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
