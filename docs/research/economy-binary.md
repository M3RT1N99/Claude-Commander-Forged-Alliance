# Economic distribution — reconstructed directly from the binary (IDA)

**Source:** IDA decompilation from `func_ArmyProcessEconomy` @ **0x771B50**
(FAF-`ForgedAlliance.exe`). Not reconstructed in **faf-re** — the research
could only say "Request/Grant system, formulas missing". The real one is here
Distribution algorithm, distilled as a specification (not raw code).

Called from `CArmyImpl::OnTick` @ 0x6FFD70 (`func_ArmyProcessEconomy(mEconomy)`),
i.e. **once per army per tick**, after emptying the consumer batteries.

## Datenmodell

- `CEconomy` maintains an intrusive list `mConsumptionData` of **consumers**
  (each build/repair/consumption request of a unit).
- Per consumer: `mResources = {ENERGY, MASS}` (this tick requested) and
  a `granted` field (cumulates what has been granted so far).
- Army pools: `mResources` = **Income of this tick**, `mTotals.mStored` =
  **Vorrat/Lager**, `mTotals.mMaxStorage` = Lagerkapazität (double!).

## Algorithm (per tick)

### 1. Nachfrage sammeln, in ZWEI Kategorien trennen
For every consumer: `demand[res] = max(0, requested[res] - granted[res])`.
Then count how many of the two resources he needs:
- needs **both** (E **and** M) → sum in `demandBoth`
- needs **only one** → sum in `demandSingle`

`totalDemand = demandBoth + demandSingle` (je Ressource).

### 2. Verfügbaren Pool bestimmen
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
        limitingRes = res            # die knappste Ressource
```
`r1` = min(1, kleinstes `available/totalDemand`). `limitingRes` = Engpass.

### 4. „Beide"-Verbraucher bedienen, Rest berechnen
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
Consumers who **only need the abundant** resource get from the
Rest their own (higher) ratio - they are not affected by the bottleneck of others
Ressource ausgebremst.

### 6. Verteilen (zweite Schleife über Verbraucher)
```
for consumer:
    demand = max(0, requested - granted)
    if consumer braucht die limitingRes NICHT:   # Single-Consumer, Nicht-Engpass
        grant = demand * r2
    else:
        grant = demand * r1
    consumer.granted += grant        # <- mGranted; Unit liest LimitingRate = granted/requested
    available        -= grant
```

### 7. Buchhaltung + Lager/Overflow
```
mTotals.mLastUseRequested = totalDemand
mTotals.mLastUseActual    = tatsächlich gewährt
mTotals.mIncome           = income (dieser Tick)
overflow[res] = max(0, available[res] - mMaxStorage[res])   # über Lager -> Overflow
if mResourceSharing: overflow an Verbündete verteilen
mStored = min(available, mMaxStorage)
income  = 0                                                 # Akku für nächsten Tick zurücksetzen
```
All `mStored/mReclaimed` writes run over `InterlockedCompareExchange`
(atomic, because stats are read in parallel).

## Consequence for our replica

Our current floating economy in [src/sim/simWorld.ts](../../src/sim/simWorld.ts)
is **too simple**: a global stall factor. The original has:

1. **Per-consumer requests** instead of a sum drain.
2. **Two ratios** (r1 for double, r2 for single consumers) — thereby
   run e.g. B. pure energy consumers continue if only mass is missing.
3. **`LimitingRate = granted/requested` per consumer** — the construction progress
   of a *single* building scales with *its* ratio, not with one
   Armee-Globalwert.
4. **Handicap multipliziert Einkommen**, Overflow = Betrag über `mMaxStorage`.

→ Reconstruction in Phase C: `EconRequest` list per army, this 7-step tick,
Units consume via `LimitingRate`. Verification: 1 Energy Extractor +
1 mass-limited building → energy consumer is allowed to run at full capacity.

## Status: implemented

Implemented in [ZZPROTECT0ZZ](../../src/sim/simWorld.ts) as a 7-step tick
with `EconRequest` list (maintenance of finished units + construction sites), r1/r2 and
`LimitingRate` per consumer. **Overflow Sharing** (Step 8) distributed
Overflow with active `resourceSharing` via water filling in ascending order
Army order to allies with free camp (rest lost); Encoder is stuck
always at capacity. Verified in
[`scripts/verify-economy.ts`](../../scripts/verify-economy.ts): Doc-Prüffall
(mass bottleneck → double r1=0.5, pure energy construction r2=1), accounting,
Overflow clamping, sharing cases and determinism.

## Correction: Production is NOT throttled

Previous assumption (underpowered extractor produces less mass) is
**binär widerlegt** (`func_ArmyProcessEconomy` @0x771B50, vollständig gelesen):
the two-ratio distribution covers **only consumers** (`mConsumptionData`) —
passive production (`mResources`) is unconditional income and will never
linked to the grant ratio. `Unit::SetProductionActive` @0x6AAA90 only sets
a flag, not an economy coupling. The `LimitingRate` works **exclusively
Work** (Build/Repair/Reclaim/Capture via `Unit::ResourceConsumed` +0x53C),
never on production. There is an "unpowered" switch-off for production
Base engine not; Intel/Shield/Stealth shutdown when power is low
Lua driven and does not affect mass production. → The current impl is
here already 1:1; The lock test in verify-economy.ts ensures this.

## Builder-BuildRate: Mechanik umgesetzt

The real construction formula is built in (`buildRequest` in simWorld.ts, binary
bestätigt: `delta = buildRate/BuildTime · ratio · 0.1` je Bauer, CBuildTask
Helper::UpdateWorkProgress @0x5f5f2c). `SimUnit.buildTarget` + `issueBuild`
assign a completed builder to a construction site; several pawns have an **additive** effect
(Assist), Reichweite über `Economy.MaxBuildDistance` gegatet. `BUILDER_RATE`
only remains as a fallback for construction sites WITHOUT any assignment (holds the
Sandbox lauffähig). Verifiziert (Timing, Assist-Stacking, Reichweiten-Gate).

**Still open:** (1) Sandbox construction order instead of direct spawn - the farmer should be sent via
Run the command to the construction site (approach state CUnitMobileBuildTask::Execute is
NOT lifted in decomp; currently static distance gate as stand-in) and
then build it so that the self-build fallback is no longer necessary. (2) factory rolloff,
OnStartBuild/OnStopBeingBuilt-Lua-Callbacks, Adjacency-Buffs.
