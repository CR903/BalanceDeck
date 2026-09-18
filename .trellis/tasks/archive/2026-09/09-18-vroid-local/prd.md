# Local human pets: walk, greet, balance bubble

## Goal

Add 2 free realistic-human pets (Microsoft Rocketbox, MIT) to the desktop-pet roster
as AI-assistant characters that walk in the roam area, play a greeting, and periodically
announce balance in a speech bubble. User value: a personal, human assistant presence
instead of only generic built-in animals — with zero crafting effort from the user.

## Background

- Source decision confirmed by user (2026-09-19): Microsoft Rocketbox over Avaturn
  (needs selfie/account) and VRoid Hub sync (parked in sibling child `09-18-vroid-hub`).
- License verified 2026-09-19 via GitHub API: `spdx_id: MIT` on
  `microsoft/Microsoft-Rocketbox` (default branch `master`).
- Asset layout verified via GitHub API: `Assets/Avatars/Adults/<Name>/{Export/<Name>.fbx
  (~0.6MB), Textures/*.tga (8x12.5MB + opacity 16MB), <Name>.png preview}`.
- Animation clips verified: `f_/m_walk_neutral*`, `f_/m_idle_breathe*`, `f_/m_wave_01/02`,
  `f_/m_idle_neutral*` under `Assets/Animations/all_animations_max_motextr_{xy,static}`.
- Codebase facts: built-in pets are unrigged GLB chunks (`src/renderer/src/pet3d/models.ts:23-32`);
  roam selection is a repo-independent pure state machine (`src/renderer/src/pet3d/walker.ts:92-137`);
  humanoid pose needs bone animation, not the whole-transform posing in
  `src/renderer/src/pet3d/scene.ts:524-558`; current bubble is a 1.6s toast
  (`src/renderer/src/PetBall.tsx:95,120-128,530`; `src/renderer/src/skins.css:1597`);
  `PetId` is a closed 8-member union (`src/shared/pet.ts:13`).

## Requirements

- R1: Ship 2 Rocketbox humans (1 female + 1 male, assistant-styled; exact IDs picked
  at implementation from preview PNGs, defaults `Female_Adult_01` + `Male_Adult_01`).
- R2: New `PetId`s (`aria` female, `ray` male); selectable in Settings alongside the 8 built-ins.
- R3: Walk: reuse `walker.ts` for x/z selection; play `walk_neutral` clip while gait is walk.
- R4: Greet: `wave_01` clip + "你好" bubble on pet switch and on long-press (existing 0.62s stroke).
- R5: Balance bubble: DOM speech bubble with main-provider summary every 90s while pet
  is visible; honors `hideBalance` and cached/local honesty labeling; max 2 lines.
- R6: Assets live under `userData/human-pets/<id>/` (model + converted PNG textures +
  anim clips + `meta.json` with source URL + MIT note); nothing user-sourced in repo.
- R7: No regression: existing 8 pets, `test:pet`, `test:walker`, pet uitest cases all green.

## Acceptance criteria

- [ ] Both human pets selectable, correctly framed inside the glass ball.
- [ ] Walk observed in roam area: clip playing, in-bounds, ball follows as today.
- [ ] Greet plays wave + bubble on switch and on long-press.
- [ ] Balance bubble appears on interval with correct honesty labeling; hidden when
  `hideBalance` is on (for amounts; percents unaffected, same rule as cards).
- [ ] Cold start with no network still renders pets from `userData` cache.
- [ ] Existing 8 pets unaffected; full `npm test` + pet uitest cases pass.

## Out of scope

- VRoid Hub OAuth sync (sibling child `09-18-vroid-hub`, parked).
- Facial blendshape speech, full animation set (only walk/idle/wave/talk-neutral).
- Removing any built-in pet; third human; Avaturn/selfie avatars.

## Open questions

- None blocking. Interaction defaults (R4/R5 triggers) go to final approval as proposed.
