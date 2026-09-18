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
| `09-18-vroid-local` | Import 2 user VRM files as new pets: walk, greet, balance bubble | planning |
| `09-18-vroid-hub` | OAuth VRoid Hub account to list/download user characters automatically | planned (after local) |

Ordering: Hub child depends on the local VRM rendering pipeline from the local child;
that ordering is recorded in the Hub child's `prd.md`.

## Cross-child acceptance criteria

- [ ] Both VRoid pets selectable in Settings pet section alongside the existing 8.
- [ ] Each VRoid pet walks in the roam area, plays a greeting, and shows balance bubbles.
- [ ] Existing 8 pets keep working unchanged (no regression in `test:pet`, `test:walker`, uitest pet cases).
- [ ] No credentials or model files leak into the repo; user models cached under `userData`.

## Out of scope (parent level)

- Removing/replacing the existing 8 built-in pets (deferred decision).
- A third VRoid character (deferred until first 2 land).
