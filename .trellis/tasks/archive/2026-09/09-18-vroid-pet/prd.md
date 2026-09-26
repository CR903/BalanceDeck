# VRoid pet companion (parent)

## Goal

Bring the user's own VRoid characters into BalanceDeck as desktop pets that walk around,
greet, and announce balance via speech bubbles. User value: the pet feels personal
instead of a generic built-in animal.

## Source requirements (from user, 2026-09-18, pivoted 2026-09-19, confirmed)

- Original: VRoid account with 3 uploaded characters; do 2 first. User could not
  find a Hub download entry, and has no time to craft characters manually.
- Pivoted + confirmed: agent sources 2 free realistic-human models (Rocketbox, MIT).
  Picks (preview-checked 2026-09-19): `Business_Female_01` → pet `aria`,
  `Business_Male_02` → pet `ray`. Business attire = assistant look.
- "VRoid auto-create" does not exist (no generative feature; bundled samples are
  anime-style). VRoid Hub OAuth stays parked in sibling child `09-18-vroid-hub`.
- Verified candidates (2026-09-19, via repo README/API + vendor pages), user confirmed Rocketbox.
  Spike (2026-09-19, Node + three r177 FBXLoader): 82-bone Bip01 skeleton parses;
  walk/wave clips bind 100% except non-deforming helpers (`Bip01_Footsteps`,
  `MotionExtractionHelper`, safely ignored); sips converts TGA→PNG with zero installs.
  - Microsoft Rocketbox (`github.com/microsoft/Microsoft-Rocketbox`): 115 rigged
    realistic avatars, MIT license since 12/2020, 417 compatible animations,
    facial blendshapes/ARKit shapes included. Ships FBX (Unity/Unreal-oriented),
    so agent converts FBX→glb. Zero user effort. RECOMMENDED.
  - Avaturn (`avaturn.me`): selfie-based realistic avatars, file export offered —
    but needs the user's selfie + account (possibly paid tier); conflicts with
    "no time". Fallback only if user wants their own face.
  - Ready Player Me: known `.glb`, free, semi-realistic/stylized (not truly
    realistic); docs unreachable from this network (cert error), unverified.
- Additive scope unchanged: 2 new pets alongside the existing 8 built-ins.

## Child-task map

| Child | Deliverable | Status |
|---|---|---|
| `09-18-vroid-local` | 导入并渲染真人助理 Aria / Ray | ✅ 已归档 |
| `09-18-vroid-hub` | OAuth VRoid Hub 账号自动列出/下载用户角色 | 🚧 保留为独立任务（已从本父任务解绑） |

Hub 子任务在归档时从本父任务解绑，因为它**不再依赖**本地渲染管线之外的东西
（管线已就绪），且它的需求至今未探索（PRD 仍全是 TBD），留着当子任务会让人误以为
它排在什么确定的位置上。要做时以独立任务重启。

## Cross-child acceptance criteria

交付时（2026-09-19，2026-09-26 核对）全部满足，但**表述已被后续重构改写**，
下面按现状重述：

- [x] 两位真人助理可在设置页选择 —— 但已**不再**「与现有 8 只并列」：
      8 只 Q 版动物在 `0f70602` 下线，`pet3d/` 现在只有 Aria / Ray（`0f70602`）。
- [x] 每位助理有进出场动作、平时随机动作池、余额/用量播报 —— 但**不再「在漫游区走动」**：
      漫游机制在 `b5f93c8` / `4f85487` 下线，改为「点球走出 → 动作编排 → 走回」
      （`pet3d/clips.ts` / `gesture.ts`，`a0def59`）。
- [x] 既有形态无回归：`test:pet` / `test:gesture` / `test:projection` / `--uitest` 82 项全绿。
      （原 AC 里的 `test:walker` 已随漫游机制删除。）
- [x] 素材与凭据不进仓库：`resources/` 在 `.gitignore`，走 `bd-asset://` + `extraResources`。

## Out of scope (parent level)

- 第三位角色（仍未做）。
- 素材源替换 —— 已由 `09-18-human-realism` 覆盖。
