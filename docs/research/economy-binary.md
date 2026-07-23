# Economic distribution — reconstructed directly from the binary (IDA)

**Source:** IDA decompilation from `func_ArmyProcessEconomy` @ **0x771B50**
(FAF-`ForgedAlliance.exe`). Not reconstructed in **faf-re** — the research
could only state "request/grant system; formulas missing." The actual
distribution algorithm is presented here, distilled into a specification (not
raw code).

Called from `CArmyImpl::OnTick` @ 0x6FFD70 (`func_ArmyProcessEconomy(mEconomy)`),
i.e. **once per army per tick**, after clearing the consumer accumulators.

## Data model

- `CEconomy` maintains an intrusive list `mConsumptionData` of **consumers**
  (each build/repair/consumption request of a unit).
- Per consumer: `mResources = {ENERGY, MASS}` (this tick requested) and
  a `granted` field (cumulates what has been granted so far).
- Army pools: `mResources` = **this tick's income**, `mTotals.mStored` =
  **stored supply**, `mTotals.mMaxStorage` = storage capacity (double).

## Algorithm (per tick)

### 1. Collect demand and split it into TWO categories
For each consumer, calculate `demand[res] = max(0, requested[res] - granted[res])`.
Then determine how many of the two resources it requires:
- requires **both** (E **and** M) → add to `demandBoth`
- requires **only one** → add to `demandSingle`

`totalDemand = demandBoth + demandSingle` (per resource).

### 2. Determine available pool
```
available[res] = mStored[res] + income[res] * (1 + handicap)
```
The **handicap multiplies the income** (balance option; 0 = none).

### 3. Primary Ratio (the S1 throttling)
```
r1 = 1.0 ; limitingRes = ENERGY
for res in {ENERGY, MASS}:
    if totalDemand[res] * r1 > available[res]:
        r1 = available[res] / totalDemand[res]
        limitingRes = res            # the scarcest resource
```
`r1` = min(1, smallest `available/totalDemand`). `limitingRes` is the
bottleneck resource.

### 4. Serve consumers requiring both resources and calculate the remainder
```
grantBoth[res] = demandBoth[res] * r1
leftover[res]  = max(0, available[res] - grantBoth[res])
```

### 5. Secondary Ratio (the S2 throttling, non-bottleneck resource only)
```
r2 = 1.0
for res != limitingRes:
    if demandSingle[res] * r2 > leftover[res]:
        r2 = leftover[res] / demandSingle[res]
```
Consumers that **need only the abundant** resource receive their own (higher)
ratio from the remainder; the other resource's bottleneck does not throttle
them.

### 6. Distribute (second loop via consumers)
```
for consumer:
    demand = max(0, requested - granted)
    if consumer does NOT need limitingRes:       # single consumer, non-bottleneck
        grant = demand * r2
    else:
        grant = demand * r1
    consumer.granted += grant        # <- mGranted; unit reads LimitingRate = granted/requested
    available        -= grant
```

### 7. Accounting, storage, and overflow
```
mTotals.mLastUseRequested = totalDemand
mTotals.mLastUseActual = amount actually granted
mTotals.mIncome           = income (this tick)
overflow[res] = max(0, available[res] - mMaxStorage[res]) # amount above storage capacity -> overflow
if mResourceSharing: distribute overflow to allies
mStored = min(available, mMaxStorage)
income = 0 # reset the accumulator for the next tick
```
All `mStored/mReclaimed` writes use `InterlockedCompareExchange`
(atomic, because stats are read in parallel).

## Consequence for our replica

Our current floating economy in [src/sim/simWorld.ts](../../src/sim/simWorld.ts)
is **too simple**: a global stall factor. The original uses:

1. **Per-consumer requests** instead of a sum drain.
2. **Two ratios** (r1 for consumers requiring both resources, r2 for
   single-resource consumers) — for example, pure energy consumers continue
   operating if only mass is scarce.
3. **`LimitingRate = granted/requested` per consumer** — the construction progress
   of a *single* building scales with *its* ratio, not with one
   army-wide value.
4. **Handicap multiplies income**, overflow = amount over `mMaxStorage`.

→ Reconstruct in Phase C: an `EconRequest` list per army and this 7-step tick.
Units consume through `LimitingRate`. Verification: 1 Energy Extractor +
1 mass-limited building → the energy consumer is permitted to run at full
capacity.

## Status: implemented

Implemented in [`Army.tick`](../../src/sim/simWorld.ts) as a 7-step tick
with an `EconRequest` list (maintenance for completed units and construction
sites), r1/r2, and `LimitingRate` per consumer. **Overflow sharing** (step 8)
distributes overflow with active `resourceSharing` via water filling in
ascending army order to allies with free storage (the remainder is lost); the
donor is always clamped at capacity. Verified in
[`scripts/verify-economy.ts`](../../scripts/verify-economy.ts): documentation
test case (mass bottleneck → dual-resource r1=0.5, pure-energy construction
r2=1), accounting, overflow clamping, sharing cases, and determinism.

## Correction: Production is NOT throttled

The previous assumption (an underpowered extractor produces less mass) is
**disproved by the binary** (`func_ArmyProcessEconomy` @0x771B50, read in
full):
the two-ratio distribution covers **only consumers** (`mConsumptionData`) —
passive production (`mResources`) is unconditional income and is never linked
to the grant ratio. `Unit::SetProductionActive` @0x6AAA90 only sets a flag;
it does not couple to the economy. `LimitingRate` applies **exclusively to
work** (build/repair/reclaim/capture through `Unit::ResourceConsumed` +0x53C),
never to production. The base engine has no "unpowered" production shutdown;
Lua drives Intel, shield, and stealth shutdown when energy is scarce, and this
does not affect mass production. → The current implementation is already 1:1;
the lock test in `verify-economy.ts` verifies this.

## Builder build rate: mechanics implemented

The real construction formula is implemented (`buildRequest` in `simWorld.ts`,
confirmed by the binary: `delta = buildRate/BuildTime · ratio · 0.1` per
builder, `CBuildTaskHelper::UpdateWorkProgress` @0x5f5f2c).
`SimUnit.buildTarget` and `issueBuild` assign a completed builder to a
construction site; multiple builders have an **additive** effect (assist),
range-gated through `Economy.MaxBuildDistance`. `BUILDER_RATE` remains only as
a fallback for construction sites with **no** assignment (keeping the Sandbox
executable runnable). Verified for timing, assist stacking, and range gating.

**Still open:** (1) a Sandbox construction command instead of direct spawning:
the builder should receive a command to move to the construction site
(`CUnitMobileBuildTask::Execute`'s approach state is **not** reconstructed in
the decomp; a static distance gate is currently a stand-in), then construct it
so the self-build fallback is no longer required. (2) factory roll-off,
`OnStartBuild`/`OnStopBeingBuilt` Lua callbacks, and adjacency buffs.
