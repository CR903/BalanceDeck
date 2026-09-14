import { useId } from 'react'
import type { PetId, PetMood } from '../../shared/pet'

// ═══════════════════════════════════════════════════════════════════════════════
// 宠物精灵（全部原创 · SVG 矢量 · 伪 3D 光影）
//
// 设计约定：
//   · viewBox 64×64，主体占 12–52，56px 圆点里也看得清
//   · 每只宠物的「圆柱感」由两层渐变完成：主体顶亮底暗 + 右上高光
//   · 动画只在 CSS（skins.css「宠物精灵」段）：呼吸 / 眨眼 / 跳跃 / 进食 / 摆动
//   · mood 决定五官（happy 弯眼笑、hungry 张嘴、lonely 八字眉），action 决定全身动作
// ═══════════════════════════════════════════════════════════════════════════════

export type PetAction = 'idle' | 'happy' | 'eat'

/** 表情：happy=弯眼笑 · fine=普通 · hungry=张嘴饿 · lonely=失落 */
export function PetStage({
  id,
  mood,
  action = 'idle',
  size = 44
}: {
  id: PetId
  mood: PetMood
  action?: PetAction
  size?: number
}): React.JSX.Element {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  return (
    <svg
      className={`pet pet--${action}`}
      data-mood={mood}
      data-pet={id}
      viewBox="0 0 64 64"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <defs>{shades(uid, id)}</defs>
      {body(id, uid, mood)}
      <Fx action={action} />
    </svg>
  )
}

/** 每只宠物的两层渐变（顶亮底暗 → 圆柱体积感） */
function shades(uid: string, id: PetId): React.JSX.Element {
  const palette: Record<PetId, [string, string, string]> = {
    mochi: ['#fff2dc', '#e9c08a', '#c98f4f'],
    shiba: ['#ffd9a0', '#e8a95f', '#c07a34'],
    penguin: ['#5b6b82', '#2c3a51', '#1b2437'],
    dino: ['#b6e58c', '#69b454', '#3f8a3a'],
    slime: ['#b9ecff', '#63b6ef', '#3a7fd0']
  }
  const [light, mid, dark] = palette[id]
  const bodyId = `${uid}-body`
  const backId = `${uid}-back`
  return (
    <>
      <linearGradient id={bodyId} x1="0" y1="0" x2="0.35" y2="1">
        <stop offset="0" stopColor={light} />
        <stop offset="0.55" stopColor={mid} />
        <stop offset="1" stopColor={dark} />
      </linearGradient>
      <linearGradient id={backId} x1="0" y1="0" x2="0.4" y2="1">
        <stop offset="0" stopColor={mid} />
        <stop offset="1" stopColor={dark} />
      </linearGradient>
      <radialGradient id={`${uid}-gloss`} cx="0.32" cy="0.22" r="0.5">
        <stop offset="0" stopColor="#fff" stopOpacity="0.85" />
        <stop offset="1" stopColor="#fff" stopOpacity="0" />
      </radialGradient>
    </>
  )
}

// ─── 五官（通用，坐标按各角色传入）───────────────────────────────────────────

function Face({
  ex1,
  ex2,
  ey,
  er,
  mx,
  my,
  mood,
  ink,
  blush
}: {
  ex1: number
  ex2: number
  ey: number
  er: number
  mx: number
  my: number
  mood: PetMood
  ink: string
  blush: string
}): React.JSX.Element {
  const happy = mood === 'happy'
  return (
    <>
      {happy ? (
        <>
          <path
            className="pet-eye"
            d={`M${ex1 - 3.4} ${ey + 1} q3.4 -4 6.8 0`}
            stroke={ink}
            strokeWidth="1.9"
            fill="none"
            strokeLinecap="round"
          />
          <path
            className="pet-eye"
            d={`M${ex2 - 3.4} ${ey + 1} q3.4 -4 6.8 0`}
            stroke={ink}
            strokeWidth="1.9"
            fill="none"
            strokeLinecap="round"
          />
        </>
      ) : (
        <>
          <ellipse className="pet-eye" cx={ex1} cy={ey} rx={er} ry={er * 1.14} fill={ink} />
          <ellipse className="pet-eye" cx={ex2} cy={ey} rx={er} ry={er * 1.14} fill={ink} />
          <circle cx={ex1 - er * 0.34} cy={ey - er * 0.42} r={er * 0.3} fill="#fff" opacity="0.9" />
          <circle cx={ex2 - er * 0.34} cy={ey - er * 0.42} r={er * 0.3} fill="#fff" opacity="0.9" />
          {mood === 'lonely' && (
            <>
              <path
                d={`M${ex1 - 3.2} ${ey - er - 2.4} l6 1.6`}
                stroke={ink}
                strokeWidth="1.5"
                strokeLinecap="round"
                opacity="0.8"
              />
              <path
                d={`M${ex2 + 3.2} ${ey - er - 2.4} l-6 1.6`}
                stroke={ink}
                strokeWidth="1.5"
                strokeLinecap="round"
                opacity="0.8"
              />
            </>
          )}
        </>
      )}
      {happy && (
        <path
          className="pet-mouth"
          d={`M${mx - 4.2} ${my} q4.2 4.4 8.4 0`}
          stroke={ink}
          strokeWidth="1.7"
          fill="none"
          strokeLinecap="round"
        />
      )}
      {mood === 'fine' && (
        <path
          className="pet-mouth"
          d={`M${mx - 2.6} ${my} q2.6 2.6 5.2 0`}
          stroke={ink}
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
        />
      )}
      {mood === 'hungry' && (
        <>
          <ellipse className="pet-mouth" cx={mx} cy={my + 1} rx="3" ry="3.8" fill={ink} opacity="0.85" />
          <ellipse className="pet-saliva" cx={mx + 5.4} cy={my - 1.6} rx="1.5" ry="2.2" fill="#8fd0ff" />
        </>
      )}
      {mood === 'lonely' && (
        <path
          className="pet-mouth"
          d={`M${mx - 3.6} ${my + 1.4} h7.2`}
          stroke={ink}
          strokeWidth="1.6"
          fill="none"
          strokeLinecap="round"
        />
      )}
      {blush && mood !== 'lonely' && (
        <>
          <ellipse cx={ex1 - 6.4} cy={ey + 5.2} rx="3" ry="1.9" fill={blush} opacity={happy ? 0.8 : 0.42} />
          <ellipse cx={ex2 + 6.4} cy={ey + 5.2} rx="3" ry="1.9" fill={blush} opacity={happy ? 0.8 : 0.42} />
        </>
      )}
    </>
  )
}

/** 互动特效：撸一把冒爱心，喂食冒碎屑 */
function Fx({ action }: { action: PetAction }): React.JSX.Element | null {
  if (action === 'happy') {
    return (
      <g className="pet-fx">
        <path className="pet-heart h1" d="M0 2.6C-1.4 0.2-5.6-0.2-5.6-2.8C-5.6-5-2.8-6 0-3.6C2.8-6 5.6-5 5.6-2.8C5.6-0.2 1.4 0.2 0 2.6Z" fill="#ff6b8b" />
        <path className="pet-heart h2" d="M0 2.6C-1.4 0.2-5.6-0.2-5.6-2.8C-5.6-5-2.8-6 0-3.6C2.8-6 5.6-5 5.6-2.8C5.6-0.2 1.4 0.2 0 2.6Z" fill="#ff9db3" />
        <path className="pet-heart h3" d="M0 2.6C-1.4 0.2-5.6-0.2-5.6-2.8C-5.6-5-2.8-6 0-3.6C2.8-6 5.6-5 5.6-2.8C5.6-0.2 1.4 0.2 0 2.6Z" fill="#ffc2cf" />
      </g>
    )
  }
  if (action === 'eat') {
    return (
      <g className="pet-fx">
        <circle className="pet-crumb c1" cx="46" cy="38" r="2.2" fill="#e8b06a" />
        <circle className="pet-crumb c2" cx="40" cy="45" r="1.6" fill="#f2c98d" />
      </g>
    )
  }
  return null
}

// ─── 五只原创精灵 ─────────────────────────────────────────────────────────────

function body(id: PetId, uid: string, mood: PetMood): React.JSX.Element {
  const b = `url(#${uid}-body)`
  const back = `url(#${uid}-back)`
  switch (id) {
    case 'mochi':
      return (
        <g className="pet-body">
          <path
            className="pet-appendage"
            d="M47 50 Q60 47 56 34"
            stroke={back}
            strokeWidth="5.4"
            fill="none"
            strokeLinecap="round"
          />
          <ellipse cx="32" cy="49" rx="16" ry="11.5" fill={b} />
          <path d="M15 22 L17.5 7.5 L30 18.5 Z" fill={b} />
          <path d="M49 22 L46.5 7.5 L34 18.5 Z" fill={b} />
          <path d="M19 18.5 L20.5 11.5 L26.5 17.5 Z" fill="#f7b6c2" opacity="0.9" />
          <path d="M45 18.5 L43.5 11.5 L37.5 17.5 Z" fill="#f7b6c2" opacity="0.9" />
          <ellipse cx="32" cy="31" rx="19" ry="16.5" fill={b} />
          <ellipse cx="32" cy="36" rx="12.5" ry="9" fill="#fff8ec" opacity="0.85" />
          <path d="M30.4 34.6 h3.2 l-1.6 1.8 z" fill="#ef8b9d" />
          <Face ex1={25} ex2={39} ey={30.5} er={2.9} mx={32} my={38} mood={mood} ink="#43342a" blush="#f39aa6" />
          <rect x="45" y="14" width="9" height="5" rx="2.5" fill="none" />
        </g>
      )
    case 'shiba':
      return (
        <g className="pet-body">
          <path
            className="pet-appendage"
            d="M45 50 Q59 46 54 33"
            stroke={back}
            strokeWidth="5.6"
            fill="none"
            strokeLinecap="round"
          />
          <ellipse cx="32" cy="49" rx="16.5" ry="11.5" fill={b} />
          <path d="M14.5 24 L16 8.5 L29 19.5 Z" fill={back} />
          <path d="M49.5 24 L48 8.5 L35 19.5 Z" fill={back} />
          <ellipse cx="32" cy="31" rx="18.5" ry="16.5" fill={b} />
          <ellipse cx="32" cy="37" rx="11.5" ry="8.6" fill="#fff6e6" opacity="0.95" />
          <path d="M30.5 33.6 h3 l-1.5 1.8 z" fill="#4a3a2c" />
          <Face ex1={25} ex2={39} ey={29.5} er={2.8} mx={32} my={38} mood={mood} ink="#4a3a2c" blush="#f2a08a" />
        </g>
      )
    case 'penguin':
      return (
        <g className="pet-body">
          <ellipse cx="32" cy="48" rx="15" ry="11" fill={back} />
          <ellipse cx="32" cy="49.5" rx="10.5" ry="8" fill="#f4f8ff" />
          <ellipse cx="32" cy="30" rx="17" ry="16" fill={b} />
          <ellipse cx="32" cy="33.5" rx="10.5" ry="9.5" fill="#f4f8ff" />
          <path d="M29.4 32 h5.2 l-2.6 3.4 z" fill="#ffab3d" />
          <path className="pet-wing" d="M15.5 30 q-4.5 8 -0.5 14 q4 -2 5.5 -8 z" fill={back} />
          <path className="pet-wing" d="M48.5 30 q4.5 8 0.5 14 q-4 -2 -5.5 -8 z" fill={back} />
          <Face ex1={25.5} ex2={38.5} ey={27.5} er={2.7} mx={32} my={39} mood={mood} ink="#22304a" blush="#7fb3f2" />
          <path d="M24 58 h6 l-2.4 -5 h-3.4 z" fill="#ffab3d" />
          <path d="M34 58 h6 l-2.4 -5 h-3.4 z" fill="#ffab3d" />
        </g>
      )
    case 'dino':
      return (
        <g className="pet-body">
          <path
            className="pet-appendage"
            d="M46 50 Q61 50 57 38"
            stroke={back}
            strokeWidth="6"
            fill="none"
            strokeLinecap="round"
          />
          <path d="M44 24 l4 -7 l4 6 z" fill="#e6f6c8" />
          <path d="M19 22 l3 -6.6 l4 5.8 z" fill="#e6f6c8" />
          <ellipse cx="32" cy="49" rx="16.5" ry="11.5" fill={b} />
          <ellipse cx="32" cy="31" rx="18.5" ry="16" fill={b} />
          <ellipse cx="32" cy="37" rx="11.5" ry="8.4" fill="#eef8d8" opacity="0.9" />
          <path className="pet-appendage" d="M18 38 q-6 0 -6.6 -5" stroke={back} strokeWidth="4.4" fill="none" strokeLinecap="round" />
          <path className="pet-appendage" d="M46 38 q6 0 6.6 -5" stroke={back} strokeWidth="4.4" fill="none" strokeLinecap="round" />
          <Face ex1={25} ex2={39} ey={29.5} er={2.9} mx={32} my={38} mood={mood} ink="#2f4a26" blush="#8fd07a" />
          {mood === 'happy' && <path d="M35.6 41.4 l1.6 2.6 l1.6 -2.6 z" fill="#fff" />}
        </g>
      )
    case 'slime':
    default:
      return (
        <g className="pet-body">
          <path
            d="M12 52 q-4 -12 4 -22 q6 -8 16 -8 q10 0 16 8 q8 10 4 22 q-2 5 -8 5 h-24 q-6 0 -8 -5 z"
            fill={b}
          />
          <ellipse cx="26" cy="30" rx="8" ry="4.6" fill="#fff" opacity="0.5" />
          <circle cx="38" cy="27" r="2.6" fill="#fff" opacity="0.55" />
          <ellipse cx="32" cy="49" rx="19" ry="6" fill="#fff" opacity="0.14" />
          <Face ex1={25.5} ex2={38.5} ey={34} er={2.9} mx={32} my={42} mood={mood} ink="#2b4c78" blush="#8fd6ff" />
        </g>
      )
  }
}
