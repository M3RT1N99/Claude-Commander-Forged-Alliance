# Build task flow — from the binary and faf-re

Sources: `CBuildTaskHelper::UpdateWorkProgress` (reconstructed in faf-re,
0x5F5BF0), `ComputeBuildProgressDelta` (faf-re), and `Unit::Materialize`
(IDA @ 0x6A9F40, marked as a gap in faf-re). Distilled into a specification.

Every construction participant—an engineer, factory, or ACU building,
assisting, reclaiming, or repairing—holds a `CBuildTaskHelper` with `mFocus`
(the building object), `mFractionComplete`, and `mActionName`. The task calls
`UpdateWorkProgress()` once per tick; a `true` return value means the task is
complete.

## Construction progress per tick (core formula)

```
resourceConsumed = builder.ResourceConsumed   # LimitingRate (0..1) from the economic distribution
timeToBuild      = focus.BuildTime / builder.buildRate     # seconds at full supply
delta            = (1 / timeToBuild) * resourceConsumed * 0.1
                 = (builder.buildRate / focus.BuildTime) * resourceConsumed * 0.1
```
`0.1` = seconds per tick (10 Hz). At full supply (`resourceConsumed=1`),
construction takes exactly `BuildTime / buildRate` seconds. The
`resourceConsumed` ratio comes **per building** from the two-stage
economic distribution ([economy-binary.md](economy-binary.md)) — this is an
FA invariant: scarce resources slow every construction proportionally.

## `Unit::Materialize(delta)` — what the delta does

```
if delta > 0:   # constructing
    FractionComplete = clamp(FractionComplete + delta, health/maxHealth, 1.0)
    AdjustHealth(maxHealth * delta) # HP grows proportionally to construction progress
elif delta <= 0:  # e.g. paused -> Materialize(0): clamp only, no progress
    FractionComplete = clamp(FractionComplete, 0, 1)

if wasBeingBuilt and FractionComplete == 1.0:   # complete
    IsBeingBuilt = false
    focus:OnStopBeingBuilt(builder, layerName)   # Lua callback
    # Army statistics: Units_Active++, Units_History++, Units_BeingBuilt--,
    #                  Units_MassValue_Built, Units_EnergyValue_Built
    if !IsMobile: # Building
        for each overlapping building:
            self:OnAdjacentTo(other); other:OnAdjacentTo(self)   # adjacency buffs
```

**Important findings:**
- **HP increases linearly with construction progress** (`maxHealth * delta` per tick) —
  not just at the end. Consistent with our interim solution.
- **Completion calls `OnStopBeingBuilt` in Lua** — that callback performs
  unit-specific behavior (enabling Intel, animation, and effects).
- **Adjacency**: As soon as a building is finished, `OnAdjacentTo` fires for all
  overlapping neighbors → this is the entry point for adjacency buffs
  (`AdjacencyBuffs.lua`, 59 KB).

## Special cases in `UpdateWorkProgress` (all in the original)

| case | behavior |
| --- | --- |
| **Paused** | `Materialize(0)` — retain the focus, freeze progress; `WorkProgress` mirrors the focus |
| **Enhancement** (Upgrade) | Progress via Lua `WorkProgress`/`WorkItemBuildTime`, same delta formula |
| **Silo** (nuclear/TML ammunition) | `SiloAssistWithResource(requested * resourceConsumed)` |
| **Build/Repair Shield** | additionally `AdjustHealth(regenRate*buildRate / RegenAssistMult)`; damaged → `regenAssistMult*2`, `delta*0.5` |
| **Fuel** (Air) | `FuelRatio += (FuelRechargeRate/FuelUseTime)*0.1`; damaged → half rate |
| **Repair** | `WorkProgress = focus.Health/MaxHealth`; done when HP full (+ fuel/shield full) |
| **Progress thresholds** | if progress exceeds a threshold → `OnBuildProgress`/`OnBeingBuiltProgress` in Lua |

## For reconstruction (Phase C)
- `resourceConsumed` = `LimitingRate` of the structure from the Econ distribution —
  **both systems interlock**, so build them together.
- `Materialize` in TS: `FractionComplete` and HP coupling, the
  `OnStopBeingBuilt` Lua callback, and an adjacency scan.
- Verification: Construction time with full supply == `BuildTime/buildRate` s;
  with a mass stall, *only* mass-dependent construction slows down.
