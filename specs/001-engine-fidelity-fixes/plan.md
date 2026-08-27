# Implementation Plan: Engine-fidelity fixes (audit round 1)

**Feature**: `001-engine-fidelity-fixes` | **Date**: 2026-08-24 | **Spec**: [spec.md](spec.md)

## Summary

Twelve verified divergences between this engine and Forged Alliance, each
pinned to the decompilation or the original Lua. Two are measurement defects
(the coverage audit could not see class bindings; the two blueprint readers
could drift silently) and are done. The remaining ten are behaviour: economy
(`TakeResource`, `GetResourceConsumed`), damage (shield absorption), weapons
(target priorities), build (health adjustment, dying factory, `Stop`),
projectiles/motion (water), and maui (global click handler, keyboard focus).

The approach is uniform: reproduce the engine's algorithm at the layer that
already owns it, cite the decomp at the point of change, and close each story
with a suite that fails before the change.

## Technical Context

**Layer**: engine Lua (`src/engine-lua/*.lua`) for nine stories; engine TS
(`src/sim/economy.ts`, `src/sim/ogrid.ts`, `scripts/coverage-engine.ts`) where
the calculation already lives there. No game logic moves into TS.

**Original behavior lives in**: `Moho::CAiBrain::TakeResource`,
`Moho::SIM_DoDamage` / `func_DoDamageArea`, `FindBestEnemy`,
`Moho::Unit::Materialize`, `IAiCommandDispatchImpl::TaskTick`,
`CUnitCommandQueue::ClearCommandQueue`, `Moho::Unit::HandleResourceManagement`,
`CAiPathSpline::Update/Generate`, `func_OnMouseMove`,
`MAUI_SetKeyboardFocus`, `RUnitBlueprint::OnInitBlueprint`. Consumers in
`lua/simutils.lua`, `lua/sim/weapon.lua`, `lua/defaultunits.lua`,
`lua/sim/unit.lua`, `lua/ui/uimain.lua`.

**Sim VM / UI VM**: US3-US9 and US12 are Sim-only bindings; US10 and US11 are
UI-only (`scr_UserInits`). No binding crosses VMs — see
`docs/research/engine-api.md`.

**Verification**: `scripts/verify-econ-lua.ts`, `verify-economy.ts`,
`verify-shields.ts`, `verify-splash-damage.ts`, `verify-combat.ts`,
`verify-build.ts`, `verify-factory.ts`, `verify-command-chain.ts`,
`verify-motion.ts`, `verify-ogrid.ts`, `verify-maui.ts`,
`verify-maui-control-state.ts`, `verify-ui-panels.ts`, plus
`scripts/coverage-engine.ts` as the standing inventory. Full gate:
`npx tsc --noEmit` + `npm test`.

**Assets required**: the retail archives already used by the suites
(`units.scd`, `lua.scd`, `mohodata.scd`, `projectiles.scd`); a map with water
for US7.

**Constraints**: 10 Hz sim beat; lockstep determinism (float32, stable
iteration — `verify-economy.ts` asserts it); no new value without a source.

## Evidence Base

Per-story citations live in [spec.md](spec.md); this table records the
*classes* of evidence and what remains open.

| Claim about original behavior | Source | Reference |
| --- | --- | --- |
| Economy: take vs. give, granted rate | 1 (decomp) | Cfile:735162-735269, 734991-735054, 953937-953948, 1107891-1107909 |
| Damage: absorption collected once per event | 1 | Cfile:1062694-1063400 |
| Weapons: priority-ranked acquisition | 1 | Cfile:791970-792233, 984183-984185, 988316-988366 |
| Build: `Materialize` adjusts health | 1 | Cfile:953442-953468, 952820-952839 |
| Dispatch: `!IsDead` gate, `ClearCommandQueue` | 1 | Cfile:746563-746598, 1005371-1005399, 1007874-1007889 |
| Motion/projectiles: water plane vs. heightfield | 1 | Cfile:765809, 766391, 656550-656581, ~1089855-1089876 |
| maui: uimain hook, focus ownership | 1 | Cfile:1147524-1147581, 1141557-1141596, 396337-396366 |
| Blueprint struct defaults + footprint ceil | 1 | Cfile:642465, 647164-647177, 656146-656172 |
| Consumers of all of the above | 2 (original Lua) | `simutils.lua:147-156`, `weapon.lua:26/364-385`, `defaultunits.lua:683-688`, `unit.lua:1200-1263`, `uimain.lua:165-192`, `combo.lua:289`, `orders.lua:539` |

**Unresolved**:

- `FlattenSkirt` edge-flatness (`OCCUPY_CheckEdgeFlatness`, Cfile:708955) —
  register aliasing on the centre reference is ambiguous; `ogrid.ts` documents
  the area-flatness proxy in place. Not touched by this feature.
- `Physics.BuildRestriction` deposit markers are not loaded, so restricted
  buildings answer `'unknown'`. Pre-existing and deliberate.
- The 19 backlog candidates in [research.md](research.md) have **no** verified
  evidence yet and license no code change.

## Constitution Check

| # | Gate | Verdict | Notes |
| --- | --- | --- | --- |
| I | No game logic in TS | **PASS** | Nine stories change engine Lua. The three TS changes are engine calculation (`ArmyEconomy.take` = `CAiBrain::TakeResource`; `blueprintPlacement` = the blueprint ctor) or tooling (`coverage-engine.ts`). No `lua/sim`/`lua/ui` behaviour is recreated. |
| II | Every value is sourced | **PASS** | Each task carries `Cfile:<line>` or `<lua path>:<line>`. T004 explicitly forbids adding a clamp the engine does not have. Two invented defaults (`Footprint → 1`, `BuildOnLayerCaps → 0`) are removed by T002. |
| III | Fails loudly | **PASS** | T024 drops the `or 1` fallback rather than keeping a placeholder. No new no-op is introduced. |
| IV | One boot path, two VMs | **PASS** | No change to `installEngine()` / `installUiEngine()` ordering. Sim-only and UI-only bindings stay in their VM. |
| V | Runnable verification | **PASS** | Every story names an existing suite plus the case to add. T003 turns the blueprint-reader invariant itself into a test. |

**Complexity Tracking**: empty — no gate is violated.

## Project Structure

```text
specs/001-engine-fidelity-fixes/
├── spec.md        # the twelve stories with evidence
├── plan.md        # this file
├── research.md    # refuted findings, the water dependency, the 19-item backlog
└── tasks.md       # T001-T039
```

Source touched:

```text
src/engine-lua/    damage.lua, weapons.lua, build.lua, globals.lua,
                   moho.lua, maui.lua, motion.lua, projectiles.lua
src/sim/           economy.ts, ogrid.ts, luaSimWorker.ts
src/               main.ts (water elevation into the boot message)
scripts/           coverage-engine.ts + the verify-* suites named per task
```

**Structure Decision**: the fixes sit where the engine already owns the
behaviour. `moho.lua` holds the binding surface, so every C++ binding
correction lands there; `economy.ts` and `ogrid.ts` hold engine *calculation*
that the Sim consumes, so the two economy/placement corrections land there
rather than being re-expressed in Lua.

## Sequencing

1. **Phase 1 (done)** — measurement. Without it the inventory lies.
2. **Phase 2** — Sim correctness. US3, US5, US6, US9, US12 are independent.
   US8 shares the dispatch area with US9. **US7 must ship with the motion
   layer branch (T026 + T027 together)** or land/amphibious units start
   floating.
3. **Phase 3** — UI. Independent of Phase 2.
4. **Phase 4** — close-out: full gate, `docs/STATUS.md`, `verified-facts.md`,
   and the two stale no-op claims the un-blinded audit exposed.
