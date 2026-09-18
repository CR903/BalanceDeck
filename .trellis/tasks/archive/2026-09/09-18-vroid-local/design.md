# Design: local human pets (Rocketbox)

## Architecture and boundaries

New module `src/renderer/src/pet3d/human.ts` owns the rigged-human branch; the existing
unrigged branch (`models.ts` + whole-transform posing in `scene.ts:524-558`) is untouched.
`scene.ts` gains a per-pet-type pose driver switch: `PetId in {aria, ray}` → human driver,
else legacy driver. `walker.ts` is reused unchanged (position/facing/gait only).

```
scripts/fetch-human-pets.mjs ──▶ resources/human-pets/<id>/   main process              renderer (pet3d/)
  (gitignored, built by script;   model.fbx ───────────────▶ bd-asset:// protocol ──▶ human.ts (FBXLoader)
   MIT redistribution allowed,   textures/*.png (≤1024) ─same──▶ external-texture map
   same category as Kenney CC0)   anims/*.fbx ──same──▶ AnimationMixer clips, crossfaded by gait
  extraResources → app package     meta.json ──▶ Settings pet list ──▶ PetBall speech bubble (DOM)
  (offline; userData override dir supported later)
```

## Key decisions and trade-offs

1. **Runtime FBX, no pre-conversion.** No blender/fbx2gltf on this machine (verified);
   three r177 ships `FBXLoader`, so load `.fbx` directly. Trade-off: FBX parse cost at
   pet-switch time (~0.6MB model, acceptable) vs adding a conversion toolchain.
2. **Custom `bd-asset://` protocol** in main to serve `userData` files to the
   `file://` renderer (privileged, `userData/human-pets` root only). Rejected: base64
   data URLs (8x12.5MB TGAs would blow memory) and `webSecurity: false` (weakens app).
3. **TGA→PNG at acquisition, max 1024px.** Raw textures are ~116MB/avatar; converted
   + downscaled target < 25MB/pet. Rejected: shipping TGAs (three `TextureLoader`
   does not decode TGA; would need `TGALoader` + larger GPU upload).
4. **Same-skeleton retarget assumed, verified by spike.** Walk/wave clips come from the
   same Rocketbox family; spike must confirm bone-name match between avatar FBX and
   anim FBX. Fallback if mismatch: procedural greet (arm-wave via shoulder bone rotation
   + nod) — still meets R4 observably.
5. **Bubble is DOM, not WebGL.** Reuses toast position/style tokens; fed by the same
   snapshot the tray title uses. Honors `hideBalance` + quality badges (R5).

## Data flow and contracts

- Acquisition (one-off script, output committed to `userData` at runtime, never repo):
  download FBX + TGAs + 4-6 anim clips + preview PNG → convert textures → write `meta.json`.
- `human.ts` contract: `loadHumanTemplate(id) → { group, mixer, clips }`;
  `instantiateHuman(id, targetHeight)` mirrors `instantiatePet` normalization
  (foot at y=0, face +Z); scene drives `mixer.update(dt)` and crossfades by gait/action.
- Pet registry: extend `PetId` union in `src/shared/pet.ts:13`, `petMeta`, thumbnails
  (reuse `thumbnail.ts` temp-renderer pattern against `bd-asset://` URLs).

## Compatibility and migration

- Additive only: legacy `normalizePetId` falls back unknown→default, so old
  `ui:petState` never breaks. No migration needed.
- Soft-renderer path: skip 1024px textures → 512px variant if `softRenderer` (reuse
  existing detection); disable shadow-casting on human meshes there.
- Attribution: README third-party section + `assets` license note for Rocketbox MIT
  (same treatment as Kenney CC0 note).

## Operational / rollback

- Rollback: delete `userData/human-pets/<id>` → pet entry shows "素材缺失" and falls
  back to previous pet; never crash (same posture as `attachPet` catch in scene.ts).
- Size guard: acquisition script aborts if converted pet exceeds 40MB.
