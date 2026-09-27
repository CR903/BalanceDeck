# Frontend Development Guidelines

> Conventions for the app code: renderer, shared layer, and the parts of `src/main/`
> that are not third-party integrations.
>
> Every claim in these files is cited to a real `file:line`. They describe **today's code**,
> including its inconsistencies — where two places do the same job differently, both are
> listed under "Known inconsistencies" rather than quietly normalised.

---

## Guidelines Index

| Guide | Description | Status |
|---|---|---|
| [Directory Structure](./directory-structure.md) | `src/main/adapters` layering, `qa/` closed set, scripts, gitignored asset dirs | ✅ 已填 |
| [Component Guidelines](./component-guidelines.md) | Component/props conventions, token-driven CSS, skins, the three severity spellings | ✅ 已填 |
| [Hook Guidelines](./hook-guidelines.md) | No custom hooks; effect cleanup, ref-mirror pattern, three.js lifecycle | ✅ 已填 |
| [State Management](./state-management.md) | No state library; lifting rules, the `extras` store, timers | ✅ 已填 |
| [Quality Guidelines](./quality-guidelines.md) | No linter; `tsc` + 9 assertion scripts + QA harness; review checklist | ✅ 已填 |
| [Type Safety](./type-safety.md) | tsconfig split, literal unions + `Record` tables, no validation lib, `as` conventions | ✅ 已填 |

Sister layer: [`../adapters/`](../adapters/index.md) — executable contract for the
opencode.ai console integration (endpoints, headers, error matrix, required tests).

---

## The four things that matter most

If you read nothing else, read these. Each has cost this project real time.

1. **`tsc` is the only type gate; there is no linter and no CI.** `npm run typecheck` is not
   part of `npm test`. Run both. → [`quality-guidelines.md`](./quality-guidelines.md)
2. **A missing value must stay missing.** Never fill an absent number with `0` or a
   plausible guess. `CONTEXT.md` requires data provenance to be explicitly declared, and
   ADR-0002 makes it structurally required. → [`type-safety.md`](./type-safety.md)
3. **Tests must load the real source.** `loadTs` exists for this. A test that inlines a copy
   of the implementation is a fake guard, and one has already drifted. After adding an
   assertion, break the behaviour and watch it fail. →
   [`quality-guidelines.md`](./quality-guidelines.md)
4. **There are no custom hooks and no state library.** The answer to duplication is a plain
   pure-function module, which is also directly unit-testable. →
   [`hook-guidelines.md`](./hook-guidelines.md) · [`state-management.md`](./state-management.md)

---

## Writing conventions (de facto, unenforced)

2-space indent · **no semicolons** · single quotes · ~110–120 col soft width ·
`// ─── section ───` banner comments with box-drawing rules · **Chinese comments and Chinese
commit messages** · `git log` uses conventional-commit prefixes (`fix(uitest):`, `feat(pet):`,
`refactor(main):`, `docs(task):`, `chore(task):`).

No tool checks any of this. Match the file you are editing.

---

**Language**: these files are written in English to match the pre-existing
`spec/guides/`. The project's product documents (`README.md`, `DESIGN.md`, `TASKS.md`,
`CONTEXT.md`) and its code comments are in Chinese — as is this spec layer's
`../adapters/opencode-console.md`, which is an inconsistency worth resolving in a future pass.
