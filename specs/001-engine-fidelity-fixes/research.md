# Research — audit round 1

**Method**: seven parallel finders, one per engine subsystem, each required to
cite `Cfile/ForgedAlliance.exe.c` or original Lua for the *original* behaviour
and our file:line for the deviation. Findings already listed under "Known gaps"
in `docs/STATUS.md` or fixed in the last 15 commits were excluded up front.
33 candidates came back; the 12 highest-ranked went through an adversarial
verifier whose default verdict was REFUTED. 10 confirmed, 2 refuted.

## Confirmed → user stories

US3–US12 in [spec.md](spec.md) carry the evidence per finding. US1 and US2 come
from a second, separate audit that checked two external review claims about this
repo (blueprint double-parse, auto-vivifier masking).

## Refuted — real in the code, inert in a session

| Finding | Why refuted |
| --- | --- |
| `motion.lua:295` clamps unit Y up to the water surface for **every** motion type. The engine clamps only `RULEUMT_Water`, `AmphibiousFloating`, `Hover` (Cfile:765809, 766391; enum Cfile:656550-656581; `IsOnValidLayer` Cfile:965960-965975 accepts `LAYER_Seabed` for `Amphibious` only). | `__mapWaterLevel` is initialised to `-10000` (globals.lua:436) and `__setWaterLevel` (globals.lua:437) **has no caller in `src/`**. The map's water elevation lives only on the main thread (`main.ts:584-586`) and never crosses into the Sim, so `GetSurfaceHeight == GetTerrainHeight` and the clamp is a no-op today. |
| `projectiles.lua:144` ignores `Physics.RealisticOrdinance` (bombs get `InitialSpeed` instead of the launcher's momentum). Engine: Cfile:943759-943855, 985762-985773; 13 vanilla projectiles set the flag. | No `RealisticOrdinance` projectile can be created in this build at all. |

> **⚠ Dependency — read before starting US7.** US7 wires the map's water
> elevation into the Sim. That is exactly the missing piece that keeps the
> motion finding above inert. **Fixing US7 activates a latent motion bug**:
> land, biped, amphibious and surfacing-sub units would start floating on the
> water surface instead of walking the seabed. The motion layer branch must
> land in the same change as US7, not after it.
> Correct rule, already recorded in `docs/research/movement-path.md:18`:
> Land/Seabed → terrain height; Water → water level; Hover → SnapToGround with
> a water floor.

## Recorded deviations (introduced knowingly, with their reason)

| Where | Deviation | Why |
| --- | --- | --- |
| `src/engine-lua/weapons.lua` (target acquisition) | With an **empty** `mTargetPriorities` we fall back to nearest-enemy. The engine selects **nothing**: the whole candidate loop sits inside `if Size(mTargetPriorities)` (Cfile:792176). | Every retail weapon gets its list from `bp.TargetPriorities` via `weapon.lua:364-385`, and 337 blueprints carry one — but our weapon set-up path does not guarantee `SetWeaponPriorities()` ran for every unit yet. A silent "never shoots" would be worse than a documented approximation. Remove the fallback once a suite proves every spawned weapon has its list. |
| `src/engine-lua/damage.lua` `damagePoint` | A **direct point hit** on a unit standing under a foreign dome is absorbed by that dome (one dome, first match). `func_DoDamagePoint` (Cfile:1062873-1063170) has no shield code at all. | In the engine the projectile physically collides with the shield entity, so a direct hit never reaches the unit. We do not model projectile-vs-shield collision; this branch is the stand-in. Area damage does **not** use it (`fromArea`), because there the absorption is collected once per event. |

## Corrections to the round-1 verifier

Two evidence claims from the adversarial pass did not survive a direct read and
were corrected while implementing:

- **Focus callbacks were swapped.** The verifier said a click elsewhere calls
  `OnKeyboardFocusChange` (vtable +68). It calls **`LosingKeyboardFocus`**:
  `(*v29)[8].mPrev` is byte offset **64** = slot 16 (`TDatListItem` is 8 bytes;
  `.mPrev` adds 0), and slot 16 is `LosingKeyboardFocus` →
  `RunScript "OnLoseKeyboardFocus"` (vtable Cfile:396337-396366, binding
  Cfile:1124565-1124570). `MAUI_SetKeyboardFocus` is the one that uses +68 =
  `OnKeyboardFocusChange`, on the **old** control (Cfile:1141582). Our existing
  callback name was therefore already right; only the focus *clearing* was wrong.
- **`GetResourceConsumed` for an idle unit is 0, not 1.** Confirmed against
  `unit.lua:748-752`, which turns consumption off exactly when both rates are
  zero — so "inactive" and "no request" are the same state in practice, and the
  engine leaves `mResourceConsumed` at its per-tick reset of 0 (Cfile:953937).

## Backlog — candidates that were NOT adversarially verified

Recorded so they are not re-discovered as new. **None of these is established
knowledge**: each still needs its own verification pass before any code changes.

| # | Sev | Where | Candidate divergence |
| --- | --- | --- | --- |
| B1 | high | `src/engine-lua/maui.lua:1101` | `ItemList` has no engine-side event handling — rows never clickable, wheel never scrolls |
| B2 | high | `src/lua/engine.ts:78` | Veterancy buffs never registered: `/lua/sim/BuffDefinitions.lua` is never loaded into the Sim VM |
| B3 | high | `src/engine-lua/globals.lua:1782` | Patrol engagement picks any enemy in `GuardScanRadius`, ignoring whether a weapon can target it |
| B4 | med | `src/engine-lua/moho.lua:1181` | `FiringRandomness` never applied — every shot pinpoint accurate |
| B5 | med | `src/engine-lua/damage.lua:233` | `DamageArea`/`DamageRing` test the unit's origin point instead of its collision volume |
| B6 | med | `src/engine-lua/moho.lua:1442` | `Control:Destroy` runs `OnDestroy` after the children and never unlinks from the parent |
| B7 | med | `src/engine-lua/projectiles.lua:388` | `UpdateTracking`: `StayUnderwater` goal clamp applied before the lead prediction, then overwritten |
| B8 | med | `src/engine-lua/build.lua:589` | A build/repair task ending because its target died is dropped silently — no `OnStopBuild`, no `OnFailedToBuild` |
| B9 | med | `src/engine-lua/motion.lua:283` | Integrator is scalar-along-heading; `MaxSteerForce` computed and never used — units corner on rails |
| B10 | med | `src/engine-lua/motion.lua:34` | `Navigator:AbortMove()` leaves the speed-through-goal flag set; the next non-Move approach never brakes |
| B11 | med | `src/engine-lua/threads.lua:106` | `ForkThread`/`ResumeThread` run their first slice one tick late |
| B12 | med | `src/engine-lua/compat.lua:15` | `for k,v in <nil> do` is a silent zero-iteration loop; FA raises "attempt to loop over a nil value" |
| B13 | med | `src/lua/engine.ts:63` | Sim VM never loads `/lua/system/config.lua`: no strict `_G`, no `iscallable`, `math.random` is not `Random` |
| B14 | low | `src/sim/economy.ts:402` | `SetArmyEconomy` overwrites storage instead of adding to the income accumulator |
| B15 | low | `src/sim/economy.ts:208` | Unit storage counts toward max storage even when production is inactive |
| B16 | low | `src/engine-lua/weapons.lua:280` | Aim manipulator gates firing by identity instead of the weapon's fire-control label |
| B17 | low | `src/engine-lua/projectiles.lua:445` | `__orientFromDir` is a minimal-arc swing, not `COORDS_Orient` — `StayUpright` projectiles keep a roll |
| B18 | low | `src/effects/emitterRuntime.ts:218` | Emitter `Lifetime = 0` emits forever instead of never (extra `life > 0` guard) |
| B19 | low | `src/engine-lua/blueprints.lua:249` | `RegisterUnitBlueprint` skips `RUnitBlueprintPhysics::ComputeDerivedQuantities` (skirt clamp, `MaxSpeedReverse`, `CatchUpAcc`, `BackUpDistance`, `AttackElevation`) |

B13 is worth an early look: `config.lua` is what CLAUDE.md names as the source
of the strict `_G`, the `Thread` object and `iscallable`. If the Sim VM really
never loads it, several downstream assumptions in this document rest on a
weaker VM than the UI one.

## What the un-blinded coverage report now says

`scripts/coverage-engine.ts` reports **1149 bindings / 61 %**:

| | ECHT | NO-OP | FEHLT |
| --- | ---: | ---: | ---: |
| total | 698 | 147 | 304 |

**Two earlier figures in this file were wrong and are superseded.** "398 / 86 %"
was measured while the class-line regex parsed no class binding at all. The
replacement "1149 / 57 %, 659/148/342" was *also* wrong twice over: the NO-OP
count was read off a stale run (147, not 148), and `methodenStand` returned
`FEHLT` for every class outside a 19-entry map — 238 methods across 32 classes
scored blind. Completing the map (manipulators via one shared `ManipMeta`,
`CollisionBeamEntity`, `CMauiLuaDragger`) moved **38 methods** to ECHT.
`CPlatoon`, `CAiPersonality`, `CLobby`, `CUIWorldMesh`, `ReconBlip`, `IEffect`
and `CDamage` were checked individually and genuinely do not exist — `FEHLT` is
correct for them.

Largest gaps: `Unit` (54 open), `CPlatoon` (49, AI phase), `CAiBrain` (48, AI
phase), Sim-Globals (47), `CAiPersonality` (35), `Entity` (27), `CLobby` (18).
The AI classes are a scheduled phase in `docs/MASTERPLAN.md`, not a defect;
`Unit`, `Entity` and Sim-Globals are the honest remainder.
