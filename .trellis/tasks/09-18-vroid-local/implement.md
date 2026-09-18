# Implement: local human pets (Rocketbox)

## Ordered checklist

- [x] 0. Spike — DONE 2026-09-19: Bip01 parses (82 bones), walk/wave bind all but
  2 harmless helpers, sips TGA→PNG works. Procedural fallback not needed.
- [x] 1. Acquisition script + run — DONE 2026-09-19: picks `Business_Female_01`→`aria`,
  `Business_Male_02`→`ray`; aria 15.7MB / ray 15.4MB into gitignored `resources/human-pets/`.
- [x] 2. Main bd-asset:// protocol + CSP + extraResources + predist hooks — DONE.
- [x] 3. `shared/pet.ts`: `aria`/`ray` + `isHumanPet` guard — DONE, unit tests green.
- [x] 4. `pet3d/human.ts` bone branch — DONE, ballshot verified.
- [x] 5. `scene.ts` driver switch + mixer crossfade — DONE, ballshot verified.
- [x] 6. Bubble component (greet/90s/petLongPress) — DONE, greet verified in shots.
- [x] 7. Settings list/select/preview.png thumbnails — DONE.
- [x] 8. README attribution — DONE.
- [x] 9. Full validation: `npm test` ✓ (187 green) · uitest 78/78 ✓ · shots ✓ (10/10 pets).
- [ ] 2. Main: `bd-asset://` protocol rooted at `userData/human-pets`; CSP allow.
- [ ] 3. `shared/pet.ts`: extend `PetId` with `aria`/`ray`, `petMeta` (names/assistant copy).
- [ ] 4. `pet3d/human.ts`: `loadHumanTemplate`/`instantiateHuman` + mixer/clip crossfade.
- [ ] 5. `scene.ts`: pose-driver switch (human vs legacy), `mixer.update(dt)`,
  gait→clip mapping (walk/idle), action→wave hookup, human reframing (taller than 26u cube).
- [ ] 6. Bubble: `PetBall` speech-bubble component (90s interval, greet hook, hideBalance,
  quality badges); keep legacy toast for built-ins or unify if trivially safe.
- [ ] 7. Settings: list/select/thumbnail `aria`/`ray`; missing-asset fallback to prior pet.
- [ ] 8. README third-party素材 + LICENSE note (Rocketbox MIT).

## Validation commands

- `npm run typecheck`
- `npm test` (must include `test:pet` 64 + `test:walker` 24 green)
- `electron . --ballshot` with `BD_PET=1` for each new pet (visual check)
- pet uitest subset (long-press, menu, no-sticky-drag) + full `npm run uitest` before finish

## Risky files / rollback points

- `src/renderer/src/pet3d/scene.ts` — pose switch; rollback = gate human branch behind
  `hasHumanModel(id)` so legacy path is byte-identical when off.
- `src/shared/pet.ts` — union extension; rollback = revert + `normalizePetId` fallback.
- `src/main/*` protocol registration — rollback = remove scheme; humans show 缺失 fallback.
- Commit after step 1 (assets tooling) and after step 5 (rendering) at latest.

## Follow-up checks before `task.py start`

- [ ] Spike result recorded (bone match yes/no; texture path chosen).
- [ ] Exact 2 avatar IDs fixed (preview-checked).
- [ ] `implement.jsonl` / `check.jsonl` curated (sub-agent dispatch only; inline skips).
