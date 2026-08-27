# Feature Specification: Engine-fidelity fixes (audit round 1)

**Feature**: `001-engine-fidelity-fixes` | **Date**: 2026-08-24
**Status**: in progress (2 of 12 done)

## Why

The engine passes all 53 verification suites, yet the game still behaves
differently from Forged Alliance in places. A decomp-backed audit across seven
subsystems (economy, weapons/damage, motion, projectiles/effects, command
dispatch, UI/maui/sync, VM core) produced 33 candidate divergences; twelve were
put through adversarial verification against `Cfile/ForgedAlliance.exe.c` and
the original Lua, and ten were confirmed with primary-source evidence.

Two of them are not gameplay bugs but **measurement** bugs — the project could
not see its own gaps. Those come first, because every other number in this
backlog depends on them.

## Scope

In scope: the twelve verified divergences listed under *User stories*, each
with its decomp/Lua evidence and a runnable check.

Out of scope: the 21 candidate findings that were not adversarially verified
(recorded in `research.md` as a backlog, not as work); everything already
listed under "Known gaps" in [docs/STATUS.md](../../docs/STATUS.md); the AI
subsystem (`CAiBrain`/`CPlatoon` bindings), which
[docs/MASTERPLAN.md](../../docs/MASTERPLAN.md) schedules as its own phase.

## Success criteria

- **SC-001** Every user story below is closed by a check that fails before the
  fix and passes after it — no story is closed on inspection.
- **SC-002** `npx tsc --noEmit` and `npm test` (all suites) are green at every
  commit.
- **SC-003** Every changed value cites `Cfile:<line>` or `<lua path>:<line>` at
  the point of change. No new value without a source.
- **SC-004** The engine-coverage report reflects reality: the NO-OP column is
  non-zero wherever no-ops exist, and the totals include class bindings.

## User stories

Priority reflects blast radius: P1 = the project cannot measure itself,
P2 = visibly wrong gameplay, P3 = wrong in edge cases.

### US1 (P1) — The coverage audit can see class bindings ✅ DONE

`scripts/coverage-engine.ts` reported "398 bindings, 86 %, NO-OP 0" while 751
class bindings were never parsed at all: the class-line regex is `$`-anchored
and the repo checks out CRLF (`core.autocrlf=true`), so `.` never matched the
trailing `\r`. The section test also still read the pre-translation heading
`### Klassen` instead of `### Classes`.

**Verification**: `npx tsx --import ./scripts/register-lua.mjs scripts/coverage-engine.ts`
now reports 1149 bindings / 57 %, with 147 NO-OP and 342 FEHLT (the round's own
`SetTargetingPriorities` fix moved one binding from NO-OP to real).

### US2 (P1) — The two blueprint readers cannot drift apart ✅ DONE

`docs/STATUS.md` records the blueprint being read twice. The TS parser is a
pure projection everywhere except `blueprintPlacement()`, which had grown two
invented defaults: `Footprint.SizeX/SizeZ → 1` (the engine derives
`ceil(SizeX)`, Cfile:647164-647177) and `BuildOnLayerCaps → 0 bits` (the ctor
sets `LAYER_Land`, Cfile:656146-656172). 72 retail structures ship no
`Footprint` section, so the ghost's validity ran on a 1×1 footprint while the
snap used the real one.

**Verification**: `scripts/verify-ogrid.ts` now cross-checks TS placement
against the real `LoadBlueprints()` pipeline for all 374 structure blueprints;
any future disagreement is a test failure.

### US3 (P2) — `AIBrain:TakeResource` takes from storage and returns what it took

Aliased to a negative `GiveResource`: writes the income accumulator instead of
storage, never clamps to what is stored, and returns nothing. The engine takes
`min(requested, stored)`, writes back `max(0, stored - taken)` and returns the
amount taken. `simutils.lua:152-155` feeds that return straight into
`GiveResource`, so today a resource transfer sends `nil` and NaNs the
recipient's economy.

**Evidence**: Cfile:735162 (help string `taken = TakeResource(type,amount)`),
735173, 735238-735252, 735253-735263, 735264-735269; contrast Cfile:734991,
735044-735054. Ours: `src/engine-lua/moho.lua:1349`, `src/sim/economy.ts:287-294`.

### US4 (P2) — Shield absorption is per damage event, not per covered unit

`DamageArea` calls the point-damage path per unit, and each call consults the
covering dome again, so a dome absorbs the full hit N times and units under it
take nothing. The engine collects absorption **once** per damage event
(`SIM_DoDamage`), subtracts it per unit, and damages each dome once.

**Evidence**: Cfile:1062694-1062727 (`sub_736E40`), 1062730-1062869
(`SIM_DoDamage`), 1063171-1063400 (`func_DoDamageArea`), 1063263-1063268,
1063310-1063386. Ours: `src/engine-lua/damage.lua:150`, `:233`, `:257`.

### US5 (P2) — Target acquisition honours `TargetPriorities`

`SetTargetingPriorities` is a no-op and acquisition just picks the nearest
enemy. The engine gates candidates on the priority categories and lets the
lowest matching index win, with distance breaking ties inside a category.

**Evidence**: Cfile:791970-792233 (`FindBestEnemy`, gate at 792176),
984183-984185 (ctor leaves `mTargetPriorities` empty), 988316-988366 (the only
writer). Ours: `src/engine-lua/moho.lua` (weapon table), `weapons.lua:223-234`.

### US6 (P2) — Construction and decay adjust health by the delta

Both paths **assign** `maxHealth × fraction`, so any damage a construction site
takes is healed away on the next tick. `Moho::Unit::Materialize` adjusts by
`maxHealth × delta` and lets the fraction follow the health, never the reverse.

**Evidence**: Cfile:953442-953468 (esp. 953464-953465, 953468), 952820-952839.
Ours: `src/engine-lua/build.lua:522`, `:95-99`.

### US7 (P2) — Water impacts report `Water`, not `Terrain`

Surface collision uses `GetSurfaceHeight`, which is already
`max(elevation, waterElevation)`, so every water impact resolves as terrain.
The engine tests the water plane and the raw heightfield separately. The map's
water elevation also never reaches the Sim.

**Evidence**: Cfile ~640489-640525 (`IMPACT_Terrain=1`, `IMPACT_Water=2`),
917362-917405, ~1089855-1089876, 722370; `docs/research/combat-projectiles.md`
§3c. Ours: `src/engine-lua/projectiles.lua:280`.

### US8 (P2) — `Stop` clears a factory's build queue

The production queue **is** part of the `CUnitCommandQueue`; `ClearCommandQueue`
removes every entry without exception. Ours leaves `__buildQueue` untouched.

**Evidence**: Cfile:1005371-1005399, 1007554-1007575, 1007874-1007889,
1255059-1255063. Ours: `src/engine-lua/globals.lua:1875-1887`.
Note: the fix belongs on the clear path, not on `IssueStop` — see `plan.md`.

### US9 (P2) — A dying factory stops producing

The engine's dispatch gate is `!IsBeingBuilt && !IsDead && !Attached &&
!BlockCommandQueue`; ours omits `!IsDead`, so a killed factory keeps spawning
queued units throughout its multi-beat `DeathThread`.

**Evidence**: Cfile:746563-746598 (gate at 746583-746586);
`lua/defaultunits.lua:683-688`, `lua/sim/unit.lua:1200-1241`, `:1259-1263`.
Ours: `src/engine-lua/build.lua:346`, `:418`.

### US10 (P2) — Global mouse-click handlers receive their event

The engine calls `uimain.OnMouseButtonPress` on every `ButtonPress`/`ButtonDClick`
**before** the event reaches the topmost control. Ours never calls it, so every
`AddOnMouseClickedFunc` registration is dead — open dropdowns do not close, the
firestate popup does not collapse.

**Evidence**: Cfile:1147533-1147557 (sole xref to `OnMouseButtonPress` at
1147549), 1147524-1147531, 1147575-1147581; `lua/ui/uimain.lua:165-192`.
Ours: `src/engine-lua/maui.lua:1171`.

### US11 (P3) — Keyboard focus follows `MAUI_SetKeyboardFocus` only

A click on another control wrongly clears the focus. The two callbacks are
**different** and easy to swap — the vtable offsets settle it:

| Path | vtable | slot | callback |
| --- | --- | --- | --- |
| click on another control (`func_OnMouseMove`, `(*v29)[8].mPrev`) | +64 | 16 `LosingKeyboardFocus` | `OnLoseKeyboardFocus` |
| `MAUI_SetKeyboardFocus` (`mPrev[-1].mNext[8].mNext`) | +68 | 17 `OnKeyboardFocusChange` | `OnKeyboardFocusChange` |

So a click elsewhere notifies the **current** focus control with
`OnLoseKeyboardFocus` and leaves `Maui_CurrentFocusControl` **unchanged**; only
`MAUI_SetKeyboardFocus` writes the focus, and it notifies the **old** control
with `OnKeyboardFocusChange` after the new one is assigned — nothing is called
on the control that gains focus. Our callback names were already right; only
the focus *clearing* was wrong.

**Evidence**: Cfile:1147524-1147532, 396337-396366 (vtable layout),
1124565-1124578, 1141557-1141596. Ours: `src/engine-lua/maui.lua:1167-1176`,
`moho.lua:1504-1510`.

### US12 (P3) — `Unit:GetResourceConsumed` reports the real granted rate

Returns a placeholder `1`, so shields never brown out, intel never shuts down
and upgrades never throttle during an energy stall. The engine resets it to 0
each tick and sets it to `CEconRequest::LimitingRate` while consumption is
active. The per-consumer rate already exists in `economy.ts`; it is simply not
bridged.

**Evidence**: Cfile:976943, 953937, 953945-953948, 1107891-1107909. Ours:
`src/engine-lua/moho.lua:834`, `src/sim/economy.ts:259`.
Related known gap: the Mex stall entry in `docs/STATUS.md`.

## Not reproducible today (recorded, not scheduled)

Two findings were **refuted** on observability — the divergence is real in the
code but cannot occur in a running session:

- `Physics.RealisticOrdinance` momentum: no such projectile can be created in
  this build.
- One further finding failed the same observability test (see `research.md`).

They stay here so a later reader does not re-discover them as new.
