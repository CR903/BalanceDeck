import { useEffect, useRef, useState } from 'react'
import type { PetAction } from './PetSprites'
import { PetStage } from './PetSprites'
import { expNeed, petMeta, petMood, PETS, type PetId, type PetState } from '../../shared/pet'
import { Icon } from './components'

// 宠物精灵卡片（主面板）：展示 + 互动中心
//   · 撸一把 / 喂食：即时动画 + 状态变化（结果由 App 的处理器返回，这里只负责提示文案）
//   · 换一只：内置原创精灵轮换（保留成长进度，只换形象）
//   · 导出 / 导入：宠物数据本地 JSON 迁移
// 设计：小尺寸下信息优先 —— 形象 + 等级 + 两条状态条 + 三个动作按钮。

export interface PetActionResult {
  ok: boolean
  reason?: 'cooldown' | 'full'
  /** 本次互动触发的升级次数（>0 时提示用户） */
  levelUps?: number
}

export function PetCard({
  pet,
  petOn,
  action,
  collapsed,
  onPet,
  onFeed,
  onChangePet,
  onRename,
  onToggleDot,
  onToggleCollapsed,
  onExport,
  onImport
}: {
  pet: PetState
  petOn: boolean
  action: PetAction
  collapsed: boolean
  onPet: () => PetActionResult
  onFeed: () => PetActionResult
  onChangePet: (id: PetId) => void
  onRename: (name: string) => void
  onToggleDot: (on: boolean) => void
  onToggleCollapsed: () => void
  onExport: () => Promise<string>
  onImport: () => Promise<string>
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(pet.name)
  const [notice, setNotice] = useState('')
  const noticeTimer = useRef<number | null>(null)

  useEffect(() => {
    setDraft(pet.name)
  }, [pet.name])
  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    },
    []
  )

  const flash = (text: string): void => {
    setNotice(text)
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(''), 2200)
  }

  const meta = petMeta(pet.id)
  const expPct = Math.round((pet.exp / expNeed(pet.level)) * 100)

  const petNow = (): void => {
    const r = onPet()
    if (!r.ok) {
      flash('刚撸过，让它缓一缓～')
      return
    }
    flash(r.levelUps ? `升级到 Lv.${pet.level + r.levelUps} 啦！` : `${meta.name}蹭了蹭你`)
  }
  const feedNow = (): void => {
    const r = onFeed()
    if (!r.ok) {
      flash('已经吃饱啦，过会儿再喂')
      return
    }
    flash(r.levelUps ? `升级到 Lv.${pet.level + r.levelUps} 啦！` : `${meta.name}吃得很香`)
  }
  const cyclePet = (): void => {
    const i = PETS.findIndex((p) => p.id === pet.id)
    const next = PETS[(i + 1 + PETS.length) % PETS.length]
    onChangePet(next.id)
    flash(`换成 ${next.name} 啦`)
  }
  const commitName = (): void => {
    setEditing(false)
    const name = draft.trim()
    if (name && name !== pet.name) onRename(name)
  }
  const exportNow = async (): Promise<void> => {
    const r = await onExport()
    flash(r === 'cancel' ? '已取消导出' : r === 'ok' ? '宠物数据已导出' : '导出失败')
  }
  const importNow = async (): Promise<void> => {
    const r = await onImport()
    flash(r === 'cancel' ? '已取消导入' : r === 'ok' ? '宠物数据已导入' : '导入失败：文件格式不对')
  }

  return (
    <section className={`pet-card${collapsed ? ' collapsed' : ''}`}>
      <div className="pet-card-head">
        <span className="pet-card-title">宠物精灵</span>
        {!collapsed && <span className="pet-card-mood">Lv.{pet.level} · {meta.trick}</span>}
        <span className="pet-card-head-actions">
          {!collapsed && (
            <>
              <button type="button" className="mini-btn" title="导出宠物数据（迁移）" onClick={() => void exportNow()}>
                导出
              </button>
              <button type="button" className="mini-btn" title="导入宠物数据（迁移）" onClick={() => void importNow()}>
                导入
              </button>
            </>
          )}
          <button
            type="button"
            className="mini-btn pet-collapse"
            title={collapsed ? '展开宠物卡片' : '收起宠物卡片'}
            onClick={onToggleCollapsed}
          >
            <Icon name="chevron" size={12} />
          </button>
        </span>
      </div>
      {!collapsed && (
        <>
          <div className="pet-card-main">
            <span className="pet-avatar" title={`${meta.name} · ${meta.trick}`}>
              <PetStage id={pet.id} mood={petMood(pet)} action={action} size={56} />
            </span>
            <div className="pet-stats">
              <div className="pet-name-row">
                {editing ? (
                  <input
                    className="pet-name-input"
                    value={draft}
                    maxLength={12}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitName}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitName()
                      if (e.key === 'Escape') {
                        setEditing(false)
                        setDraft(pet.name)
                      }
                    }}
                  />
                ) : (
                  <>
                    <span className="pet-name">{pet.name}</span>
                    <button type="button" className="pet-rename" title="改名" onClick={() => setEditing(true)}>
                      <Icon name="edit" size={11} />
                    </button>
                  </>
                )}
                <span className="pet-lv">Lv.{pet.level}</span>
              </div>
              <div className="pet-exp" title={`经验 ${pet.exp}/${expNeed(pet.level)}`}>
                <span style={{ width: `${Math.min(100, expPct)}%` }} />
              </div>
              <Stat label="亲密度" value={pet.affection} cls="bond" />
              <Stat label="饱食度" value={pet.fullness} cls="food" />
            </div>
          </div>
          <div className="pet-actions">
            <button type="button" className="btn-secondary" onClick={petNow}>
              撸一把
            </button>
            <button type="button" className="btn-secondary" onClick={feedNow}>
              喂食
            </button>
            <button type="button" className="btn-secondary" onClick={cyclePet}>
              换一只
            </button>
            <button
              type="button"
              className={'switch pet-dot-switch' + (petOn ? ' on' : '')}
              title={petOn ? '圆点不再显示宠物' : '圆点显示宠物'}
              onClick={() => onToggleDot(!petOn)}
            >
              <span className="knob" />
            </button>
          </div>
          <div className="pet-card-foot">{notice || (petOn ? '长按圆点也能撸一把' : '打开右侧开关，宠物会出现在收起的小圆点里')}</div>
        </>
      )}
    </section>
  )
}

function Stat({ label, value, cls }: { label: string; value: number; cls: string }): React.JSX.Element {
  return (
    <div className="pet-stat">
      <span className="pet-stat-label">{label}</span>
      <span className={`pet-bar ${cls}`}>
        <b style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </span>
      <em className="pet-stat-value">{Math.round(value)}</em>
    </div>
  )
}
