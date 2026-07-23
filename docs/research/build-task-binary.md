# Build task flow — from Binary + faf-re

Quellen: `CBuildTaskHelper::UpdateWorkProgress` (faf-re rekonstruiert,
0x5F5BF0) + `ComputeBuildProgressDelta` (faf-re) + `Unit::Materialize`
(IDA @ 0x6A9F40, marked as gap in faf-re). Distilled as specification.

Any construction assistant (engineer/factory/ACU during construction, assist, reclaim, repair)
holds a `CBuildTaskHelper` with `mFocus` (the building object), `mFractionComplete`,
`mActionName`. The task calls `UpdateWorkProgress()` per tick; Return `true`
= Task completed.

## Construction progress per tick (core formula)

```
resourceConsumed = builder.ResourceConsumed   # = LimitingRate (0..1) aus der Econ-Verteilung
timeToBuild      = focus.BuildTime / builder.buildRate     # Sekunden bei voller Versorgung
delta            = (1 / timeToBuild) * resourceConsumed * 0.1
                 = (builder.buildRate / focus.BuildTime) * resourceConsumed * 0.1
```
`0.1` = seconds per tick (10 Hz). At full supply (`resourceConsumed=1`)
So construction takes exactly `BuildTime / buildRate` seconds. The
`resourceConsumed` ratio comes **per building** from the two-stage
Econ distribution ([economy-binary.md](economy-binary.md)) — this is the one
FA stable: scarce resources slow down every construction proportionately.

## `Unit::Materialize(delta)` — what the delta does

```
if delta > 0:   # Bauen
    FractionComplete = clamp(FractionComplete + delta, health/maxHealth, 1.0)
AdjustHealth(maxHealth * delta) # HP grows proportionally to construction progress
elif delta <= 0:  # z.B. Pause -> Materialize(0): nur Clamp, kein Fortschritt
    FractionComplete = clamp(FractionComplete, 0, 1)

if wasBeingBuilt and FractionComplete == 1.0:   # FERTIG
    IsBeingBuilt = false
    focus:OnStopBeingBuilt(builder, layerName)   # Lua-Callback
    # Armee-Statistik: Units_Active++, Units_History++, Units_BeingBuilt--,
    #                  Units_MassValue_Built, Units_EnergyValue_Built
if !IsMobile: # Building
for each overlapping building:
            self:OnAdjacentTo(other); other:OnAdjacentTo(self)   # Adjacency-Buffs!
```

**Wichtige Befunde:**
- **HP grow linearly with construction progress** (`maxHealth * delta` per tick) —
  not just at the end. Consistent with our interim solution.
- **Completion calls `OnStopBeingBuilt` in Lua** — that's where it works
  unit-specific behavior (Intel on, animation, effects).
- **Adjacency**: As soon as a building is finished, `OnAdjacentTo` fires for everyone
  overlapping neighbors → this is the entry point for adjacency buffs
  (`AdjacencyBuffs.lua`, 59 KB).

## Special cases in `UpdateWorkProgress` (all in the original)

| case | behavior |
| --- | --- |
| **Pausiert** | `Materialize(0)` — Fokus behalten, Fortschritt einfroren; WorkProgress spiegelt Fokus |
| **Enhancement** (Upgrade) | Progress via Lua `WorkProgress`/`WorkItemBuildTime`, same delta formula |
| **Silo** (Nuke/TML-Munition) | `SiloAssistWithResource(requested * resourceConsumed)` |
| **Build/Repair Shield** | additionally `AdjustHealth(regenRate*buildRate / RegenAssistMult)`; damaged → `regenAssistMult*2`, `delta*0.5` |
| **Fuel** (Air) | `FuelRatio += (FuelRechargeRate/FuelUseTime)*0.1`; damaged → half rate |
| **Repair** | `WorkProgress = focus.Health/MaxHealth`; done when HP full (+ fuel/shield full) |
| **Progress Tapes** | if the progress exceeds a threshold → `OnBuildProgress`/`OnBeingBuiltProgress` in Lua |

## For reconstruction (Phase C)
- `resourceConsumed` = `LimitingRate` of the structure from the Econ distribution —
  **both systems interlock**, so build them together.
- `Materialize` in TS: FractionComplete + HP-Kopplung + `OnStopBeingBuilt`-
  Lua-Callback + Adjacency-Scan.
- Verification: Construction time with full supply == `BuildTime/buildRate` s;
  With mass stall, *only* the mass-dependent construction slows down.
