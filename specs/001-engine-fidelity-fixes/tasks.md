---
description: "Tasks — engine-fidelity fixes (audit round 1)"
---

# Tasks: Engine-fidelity fixes (audit round 1)

**Input**: [spec.md](spec.md), [research.md](research.md)

Every task names its evidence and the check that proves it (constitution
Principles II and V). A task without both is not a task.

Run scripts as:
`npx tsx --import ./scripts/register-lua.mjs scripts/verify-<x>.ts`

---

## Phase 1: Measurement (Blocking) ✅ DONE

Nothing else in this list can be trusted while the project cannot see its own
gaps.

- [x] T001 Normalise CRLF when reading `docs/research/engine-api.md` and fix the
      stale `### Klassen` heading test in `scripts/coverage-engine.ts` — the
      `$`-anchored class regex never matched a trailing `\r` on a
      `core.autocrlf=true` checkout, so 751 class bindings were silently
      dropped and the NO-OP column read 0.
      *Verified by*: `scripts/coverage-engine.ts` now reports 1149 bindings /
      61 % (698/147/304) — after ALSO completing the class map, which scored
      238 methods from 32 classes blind. Both earlier figures (398 / 86 % and
      1149 / 57 %) are void.
- [x] T002 Derive `Footprint.SizeX/SizeZ` as `ceil(SizeX/SizeZ)` and default
      `BuildOnLayerCaps` to `LAYER_Land` in `src/sim/ogrid.ts`
      `blueprintPlacement()` — evidence Cfile:647164-647177 (struct field
      `AddField_uchar` Cfile:642465) and Cfile:656146-656172, both mirrored in
      `src/engine-lua/blueprints.lua:243-247` / `:112`.
      *Verified by*: `scripts/verify-ogrid.ts`.
- [x] T003 Cross-check every structure blueprint's TS placement against the real
      `LoadBlueprints()` pipeline in `scripts/verify-ogrid.ts`, so a future
      drift between the two readers is a test failure rather than a surprise.
      *Verified by*: `scripts/verify-ogrid.ts` — 374 structures compared, 0
      mismatches.

**Checkpoint**: reached. The inventory is honest and the two blueprint readers
are pinned to each other.

---

## Phase 2: Sim correctness (P2)

Order within the phase is free except where a dependency is named.

### US3 — `AIBrain:TakeResource`

- [x] T004 Add `take(res, amount)` to `ArmyEconomy` in `src/sim/economy.ts`
      next to `give()`: `min(requested, stored)`, write back
      `max(0, stored - taken)`, return the amount taken — evidence
      Cfile:735173, 735238-735252, 735253-735263, 735264-735269. Add **no**
      clamp the engine does not have.
- [x] T005 Register `__econTake` next to `__econGive` (`src/sim/economy.ts`)
      and point `TakeResource` at it in `src/engine-lua/moho.lua:1349`,
      returning the taken amount — help string Cfile:735162.
- [x] T006 Extend `scripts/verify-econ-lua.ts`: a take larger than storage
      returns only what was stored, storage lands at 0 and never negative, and
      a `GiveResource(TakeResource(...))` round-trip (the `simutils.lua:152-155`
      shape) conserves the total.
      *Verified by*: `scripts/verify-econ-lua.ts`, `scripts/verify-economy.ts`.
      asserts: it RETURNS the taken amount
      asserts: a request larger than storage takes only what is there

### US4 — shield absorption per damage event

- [x] T007 Reduce `damagePoint` in `src/engine-lua/damage.lua:150-155` to the
      target's own shield; `func_DoDamagePoint` (Cfile:1062873-1063170) has no
      shield code.
- [x] T008 Add `collectAbsorption(origin, radius, amount, damageType, inst,
      damageFriendly)` = `SIM_DoDamage` (Cfile:1062730-1062869): one pass over
      the shield list, skip a dome containing `origin` (`r - 0.1`,
      Cfile:1062800-1062802), skip allied domes unless `damageFriendly`
      (Cfile:1062775-1062795), skip non-intersecting spheres
      (Cfile:1062810-1062821).
- [x] T009 Call it once in `DamageArea` (`damage.lua:233`) and `DamageRing`
      (`:257`); per unit subtract the absorption of every dome covering it
      (`sub_736E40`, Cfile:1062715), skip when `reduced <= 0`
      (Cfile:1063264), and damage each dome exactly once
      (Cfile:1063310-1063386).
- [x] T010 Extend `scripts/verify-shields.ts`: N units under one dome drain it
      once, not N times; a unit under a dome whose absorption is partial takes
      the remainder; and a unit that OWNS the absorbing dome takes
      `amount - absorbed` rather than nothing (that last case caught a real
      regression — `damagePoint` was still consulting `target.MyShield` on the
      area path and swallowing the remainder a second time).
      *Verified by*: `scripts/verify-shields.ts`.
      asserts: the dome lost ONE absorption
      asserts: the shield OWNER takes the remainder
      (`verify-splash-damage.ts` was named here originally but has no shield
      coverage at all and was never extended — corrected.)

### US5 — target priorities

- [x] T011 Implement `SetTargetingPriorities` in the `weapon` table of
      `src/engine-lua/moho.lua` (before `withNoops` fills the name) — store the
      parsed categories; it is the only writer of `mTargetPriorities`
      (Cfile:988316-988366; ctor leaves it empty, Cfile:984183-984185).
- [x] T012 Rank candidates in `src/engine-lua/weapons.lua:223-234` by lowest
      matching priority index, distance only breaking ties inside a category —
      `FindBestEnemy` gate at Cfile:792176, `SET_BEST` at 792196-792201.
- [x] T013 Extend `scripts/verify-combat.ts`: with a priority list the weapon
      picks the far high-priority target over the near low-priority one, and
      falls back to nearest when the list is empty.
      *Verified by*: `scripts/verify-combat.ts`.
      asserts: it takes the FAR tank over the near generator
      asserts: without priorities the nearest wins again

### US6 — construction/decay adjust health

- [x] T014 In `src/engine-lua/build.lua:518-522` compute the fraction delta,
      raise the fraction to `health/maxHealth` on a positive delta
      (Cfile:953464-953465), then `AdjustHealth(nil, maxH * delta)`
      (Cfile:953468) instead of assigning health.
- [x] T015 Same shape in `__decayTick` (`build.lua:95-99`) with
      `delta = -0.1 / maxVal` (Cfile:952836).
- [x] T016 Extend `scripts/verify-build.ts`: damage a construction site, run a
      build tick, assert the damage is still there (today it is healed away).
      *Verified by*: `scripts/verify-build.ts`, `scripts/verify-combat.ts`.
      asserts: the damage is still gone after the build tick
      asserts: decay subtracted maxH*delta from the DAMAGED health

### US9 — a dying factory stops producing

- [x] T017 Add `not f.__dead and not f.__destroyQueued` to the dispatch gate in
      `src/engine-lua/build.lua:346` — engine gate `!IsBeingBuilt && !IsDead &&
      !Attached && !BlockCommandQueue`, Cfile:746583-746586.
- [x] T018 Treat a dead builder like a paused one in `build.lua:418` so its
      running task stops paying and progressing during the `DeathThread`.
- [x] T019 Add to `scripts/verify-factory.ts`: a killed factory with a
      non-empty queue spawns nothing during its `DeathThread`.
      *Verified by*: `scripts/verify-factory.ts`, `scripts/verify-build.ts`.
      asserts: it starts no unit while dying

### US8 — `Stop` clears the factory queue

- [x] T020 Clear `u.__buildQueue` on the **clear** path in
      `src/engine-lua/globals.lua:1875-1887` — the production entries are
      `UNITCOMMAND_BuildFactory` commands inside the same `CUnitCommandQueue`
      that `ClearCommandQueue` wipes (Cfile:1005371-1005399, 838000-838062).
- [x] T021 Split `IssueClearCommands` from `IssueStop` (done 2026-09-04).
      `IssueStop` calls `UNIT_IssueCommand(..., UNITCOMMAND_Stop, clear = 0)`
      (Cfile:1007945-1007952) — it APPENDS a Stop command whose entire effect is
      `CAiAttackerImpl::Stop` + `SiloStopBuild`
      (`IAiCommandDispatchImpl::Stop`, Cfile:831239-831256); it does not touch
      the queue, the build tasks or the movement goal.
      `IssueClearCommands` calls `ClearCommandQueue` per unit plus
      `CAiAttackerImpl::Stop` (Cfile:1007874-1007890) — that stays
      `__dispatchStop`. `globals.lua` now appends `{ type = 'Stop' }` with
      clear = false and `__startOrder` runs the dispatcher's Stop when it
      reaches the head (the attacker target cleared, complete at once).
      *Verified by*: `scripts/verify-combat.ts`.
      asserts: IssueStop queues a Stop BEHIND the running Move
      asserts: on an idle unit the Stop dispatches at once
- [x] T022 Extend `scripts/verify-factory.ts`: Stop on a producing factory
      empties the queue and cancels the in-progress unit.
      *Verified by*: `scripts/verify-factory.ts`, `scripts/verify-command-chain.ts`.
      asserts: Stop wipes the production queue
      asserts: the control factory started a unit

### US12 — `GetResourceConsumed`

- [x] T023 Expose the per-consumer granted rate that `src/sim/economy.ts:259`
      already computes: `resourceConsumed(id)` returning 0 when consumption is
      inactive (Cfile:953937/953945), 1 for an empty request
      (`LimitingRate`, Cfile:1107897) and `lastRate` otherwise.
- [x] T024 Bridge it as `__econResourceConsumed` and replace the placeholder in
      `src/engine-lua/moho.lua:834`, dropping the `or 1` fallback — it also
      masks a legitimate 0 (Cfile:976943).
- [x] T025 Extend `scripts/verify-econ-lua.ts`: during an energy stall a
      consumer reports a rate < 1; idle reports 0.
      *Verified by*: `scripts/verify-econ-lua.ts`, `scripts/verify-shields.ts`.
      asserts: during a stall the rate is partial
      asserts: consumption off reports 0

### US7 — water impacts (⚠ paired with the motion layer branch)

- [x] T026 **Read [research.md](research.md) "Dependency" first.** Wire the
      map's water elevation into the Sim: carry `hasWater ? elevation :
      undefined` (`src/main.ts:584`) in the boot/reset worker message and call
      `__setWaterLevel(...)` next to `setTerrainSource` in
      `src/sim/luaSimWorker.ts:171` and `:309`.
- [x] T027 **In the same change**: branch unit elevation by motion type in
      `src/engine-lua/motion.lua:205` and `:295` — only `RULEUMT_Water`,
      `AmphibiousFloating` and `Hover` clamp to the water surface
      (Cfile:765809, 766391; enum Cfile:656550-656581). Without this, T026
      makes every land/amphibious unit float.
- [x] T028 In `src/engine-lua/projectiles.lua:279-286` test the water plane
      first (`water > -10000`, i.e. `mWaterEnabled`, not `water > 0`) and use
      the **raw** heightfield for terrain — `GetSurfaceHeight` is already
      `max(elevation, water)` (Cfile ~1089855-1089876).
- [x] T029 Extend `scripts/verify-combat.ts` and `scripts/verify-motion.ts`: a
      projectile hitting water reports `Water`; a land unit crossing shallow
      water stays on the seabed while a hover unit rides the surface.
      *Verified by*: `scripts/verify-combat.ts`, `scripts/verify-motion.ts`,
      asserts: over water the impact is Water
      asserts: water below the ground (island/coast) still reports Terrain
      `scripts/verify-ogrid.ts`.

---

## Phase 3: UI correctness

### US10 — `uimain.OnMouseButtonPress`

- [x] T030 In `src/engine-lua/maui.lua` `__mauiMouse`, between the focus block
      (ends :1176) and `__mauiDispatch` (:1181), call
      `import('/lua/ui/uimain.lua').OnMouseButtonPress({ Type = evType, x = x,
      y = y })` on `ButtonPress`/`ButtonDClick` — a **fresh** table with
      lowercase `x`/`y` and no modifiers (Cfile:1147533-1147557, sole xref at
      1147549). Unconditional: not gated on `hit`, `handled`, or an active
      dragger.
- [x] T031 Extend `scripts/verify-ui-panels.ts`: a handler registered through
      the real `uimain.AddOnMouseClickedFunc` fires exactly once per
      `ButtonPress`/`ButtonDClick`, receives a table carrying ONLY `Type`/`x`/`y`
      (lowercase), fires whether or not a control was hit, and does not fire on
      `ButtonRelease`.
      *Verified by*: `scripts/verify-ui-panels.ts`.
      asserts: der Haken feuert genau einmal
      asserts: ein ButtonRelease loest ihn NICHT aus
      **Not proven**: that `combo.lua:289` closes its dropdown and
      `orders.lua:539` collapses the firestate popup — those are the real
      consumers, but the check exercises the fan-out through a synthetic
      handler, not those two modules. Worth a follow-up.

### US11 — keyboard focus

- [x] T032 In `src/engine-lua/maui.lua` call **`OnLoseKeyboardFocus`** on the
      **current** focus control and leave `__mauiFocus` unchanged — a click
      elsewhere does not withdraw focus. The mouse path uses vtable offset
      **+64 = slot 16 = `LosingKeyboardFocus`** (`(*v29)[8].mPrev`,
      Cfile:1147524-1147531; vtable Cfile:396337-396366; binding
      Cfile:1124565-1124570), and only `MAUI_SetKeyboardFocus` writes the focus
      (Cfile:1141557-1141596).
- [x] T033 In `src/engine-lua/moho.lua` `AcquireKeyboardFocus`: assign the new
      focus FIRST, then notify the **old** control with
      **`OnKeyboardFocusChange`** — vtable offset **+68 = slot 17**
      (`mPrev[-1].mNext[8].mNext`, Cfile:1141575/1141582). Nothing is called on
      the control that gains focus, and there is no `old ~= self` guard
      (`mapselect.lua:233/251/254` re-acquires on the focused control).
      ⚠ The two callbacks are easy to swap — see the table in
      [spec.md](spec.md) US11 before touching this.
- [x] T034 Cover it in `scripts/verify-maui.ts` (NOT
      `verify-maui-control-state.ts`, which has no focus coverage): counters on
      both controls assert that a click elsewhere fires `OnLoseKeyboardFocus`
      once and keeps the focus; that `AcquireKeyboardFocus` fires
      `OnKeyboardFocusChange` on the OLD control only; and that re-acquiring on
      the already-focused control still notifies it.
      *Verified by*: `scripts/verify-maui.ts`.
      asserts: Der Fokus bleibt dabei bestehen
      asserts: das ALTE Control bekommt OnKeyboardFocusChange

---

## Phase 4: Close-out

- [x] T035 Full gate: `npx tsc --noEmit` **and** `npm test` (all suites) green.
      check: none — this task IS the gate; it is its own evidence.
      T036-T038 are documentation corrections. They have no runnable check
      today: nothing compares a claim in `docs/STATUS.md` against the code.
      That gap is itself a planned item (a STATUS-claim checker); until it
      exists, these are recorded here as unverified by construction rather
      than counted as proven.
- [x] T036 Update `docs/STATUS.md`: the suite count in the status paragraph
      says 29, the repo has 53; move what is now done out of "Known gaps" and
      add the newly exposed ones (the coverage figures, the `__setWaterLevel`
      gap if T026 is deferred).
- [x] T037 Record newly established detail knowledge in
      `docs/research/verified-facts.md` with evidence references.
- [x] T038 Fix the stale no-op claims the un-blinded audit exposed:
      `docs/PLAN-1ZU1.md:485` and `docs/research/combat-projectiles.md:301-302`
      still describe `Kill` and `GetArmorMult` as no-ops; both have real bodies.
- [ ] T039 [P] One commit per verified fix, English message: what and why.

---

## Dependencies

- Phase 1 blocks everything — it is done.
- **T026 and T027 must land together.** T026 alone activates a latent motion
  bug (see [research.md](research.md)).
- T020/T021 (US8) touch the same dispatch area as T017/T018 (US9) — do not run
  them as parallel `[P]` tasks.
- T007-T009 (US4) all edit `damage.lua`; sequential.
- US3, US5, US10, US11 touch disjoint files and may proceed in parallel.

## Notes

- A failing suite after one of these corrections is a **finding**, not a
  regression — but no commit lands with an unexplained red suite: fix it, or
  record it in `docs/STATUS.md` as an accepted finding in the same commit.
- 19 further candidates are in [research.md](research.md) as a backlog. They are
  **not** established knowledge; each needs its own verification pass first.
