import { useEffect, useRef, useState } from 'react'
import { PETS, expNeed, isHumanPet, petMeta, petMood, type PetId, type PetState } from '../../shared/pet'
import { petThumbnail } from './pet3d/thumbnail'
import { Icon } from './components'
import type { PetActionResult } from '../../shared/pet'

// ═══════════════════════════════════════════════════════════════════════════════
// 设置页「宠物」分区
//
// 面板不再常驻宠物卡（主面板只放 KPI），宠物的一切管理都收在这里：
//   · 改名 / 换一只 / 桌面宠物开关（收起态是否以 3D 宠物形态出现）
//   · 成长数据（等级 / 亲密度 / 饱食度）与互动（撸一把 / 喂食）
//   · 数据迁移（导出 / 导入 JSON）
//
// 头像：Q 版走 3D 缩略图（thumbnail.ts 临时渲染一次后缓存），
// 真人系直接用采集期 preview.png（bd-asset 直显，不占 WebGL 上下文）。
// ═══════════════════════════════════════════════════════════════════════════════

export interface PetSectionProps {
  pet: PetState
  petOn: boolean
  /** 悬浮球是否显示用量环 */
  petRing: boolean
  onPet: () => PetActionResult
  onFeed: () => PetActionResult
  onChangePet: (id: PetId) => void
  onRenamePet: (name: string) => void
  onTogglePetBall: (on: boolean) => void
  onTogglePetRing: (on: boolean) => void
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
  onPet,
  onFeed,
  onChangePet,
  onRenamePet,
  onTogglePetBall,
  onTogglePetRing,
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
  // 真人系直接用采集期的 preview.png（bd-asset 协议直显，不占 WebGL 上下文）。
  useEffect(() => {
    let alive = true
    void (async () => {
      for (const p of PETS) {
        try {
          const url = isHumanPet(p.id) ? `bd-asset://${p.id}/preview.png` : await petThumbnail(p.id, 128)
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
            桌面宠物
            <em className="tag env">收起态</em>
          </span>
          <button
            type="button"
            className={'switch' + (petOn ? ' on' : '')}
            title={petOn ? '关闭后收起态只有悬浮球' : '开启后球里住着一只 3D 宠物'}
            onClick={() => onTogglePetBall(!petOn)}
          >
            <span className="knob" />
          </button>
        </div>
        <div className="settings-note">
          {petOn
            ? '开启中：收起后球里住着这只宠物，它会在球内走动、发呆、打盹；单击展开、拖动移动、长按撸一把、右键菜单。'
            : '关闭中：收起后是 3D 悬浮球（只有玻璃球与用量环，不加载角色模型）。'}
        </div>

        <div className="enable-row">
          <span>显示用量环</span>
          <button
            type="button"
            className={'switch' + (petRing ? ' on' : '')}
            title={petRing ? '关闭后只剩宠物，不显示 KPI' : '开启后在球上显示用量环'}
            onClick={() => onTogglePetRing(!petRing)}
          >
            <span className="knob" />
          </button>
        </div>

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
