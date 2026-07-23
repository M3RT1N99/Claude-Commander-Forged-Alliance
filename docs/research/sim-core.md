# agent9

## Summary
The sim core runs at a hardwired 10 ticks/s. `Sim::AdvanceBeat` is the one tick function: It empties the unit resource batteries, ticks all armies (including navigator/steering task stages), then the global task stages (commands→tasks), recon, effects, kill cleanup and finally commits all entity transforms (double-buffered). Commands are not executed directly: `IAiCommandDispatchImpl` sits as a permanent task on `mTaskStageA`, reads the queue header and pushes a specific `CCommandTask` (Move/Build/Reclaim/...) onto the task stack; the return value of `Execute()` controls the scheduling. The economy is a request/grant system: each consumer attaches a `CEconRequest` (requested per tick) to an army economy intrusive list, the engine enters `mGranted`, and consumers either use the ratio (`LimitingRate()` → build/repair) or wait for full coverage (capture/teleport/silo). Three central routines are NOT lifted in the decomp (Econ distribution, `DispatchQueuedCommand` switch, build task state machines) - but the formulas for them can be clearly reconstructed from Lua + the callers.

## Key Facts
- Tick rate is fixed 10 Hz: cfunc_GetSimTicksPerSecondL pushes hard 10.0; CEconomyEvent calculates durationSeconds*10; CSimDriver estimates simRate = (1000/medianDispatchMs)*0.1.
- Beat != Tick: mCurBeat always runs (network/dispatch, checksum period), mCurTick only when not paused and not GameOver (Sim.cpp:12001).
- Tick order: ClearBeatResourceAccumulators (all units) → per army OnTick (Eco-Cache, Stats, AI-Stages=Navigator/Steering) → TaskStageA (command dispatch + all unit tasks) → DiskWatcher → TaskStageB → Blips → Recon → Effects → FormationDB → KillCleanup → AdvanceCoords (Transform Commit) → Deletion Queue → Checksum.
- Task scheduler protocol (RunThreadUserFrameStep): Execute() returns -4=thread to the end of the list, -3=abort thread, -2=park thread (stage), -1=task finished/pop and parent immediately continues, 0=immediately again, 1=wait 1 tick, N>1=wait N-1 ticks.
- Commands are never executed directly: IAiCommandDispatchImpl (permanent task on mTaskStageA) takes the queue head and pushes a CCommandTask onto the task stack of the unit thread via DispatchQueuedCommand.
- Queue semantics: mCount>1 → decrement, head remains; Patrol/FormPatrol → rotate head to end (ring cue); Repeat queue only for BuildFactory (Count=MaxCount, rotate); Error (AiResult=2) → Rotate Patrol, otherwise remove head.
- Build drain (Lua Unit.lua:690-753 + game.lua:24): time = BuildTime/buildRate (according to BuildTimeModifier, min 0.1s); energy/mass = BuildCost* * (100+Modifier)/100 * BuildAdjMod, min 1 each; energy_rate = energy/time [per second]. Engine: request_pro_Tick = consumptionPerSecond * 0.1 (Unit.cpp:14722).
- Build progress per tick = (buildRate / BuildTime) * 0.1 * ResourceConsumed (CBuildTaskHelper.cpp:61-87) — i.e. full supply ⇒ build time = BuildTime/buildRate seconds.
- Assist stacking is purely additive: each helper has its own CBuildTaskHelper, its own CEconRequest and calls focus->Materialize(delta_i) per tick — the deltas add up, effective BuildRate = Σ buildRate_i.
- Reclaim: Ticks = max(BuildCostEnergy, BuildCostMass)/buildRate (Unit) or max(MassReclaim*mult, EnergyReclaim*mult)/buildRate (Prop); Credit = reclaimPerSecond * (appliedFractionDelta / reclaimRate) directly in economy->mResources and mTotals.mReclaimed.
- Capture: Ticks = max(1, ((BuildTime/buildRate)/2 * CaptureTimeMultiplier) * 10); Cost = Target's BuildCostEnergy, Mass = 0; Progress per tick += target->CaptorCount (only if granted >= rate) ⇒ N Captors ⇒ N times faster.
- Veterancy is KILL NUMBER based (not mass): thresholds from bp.Veteran.Level1..5, otherwise Game.VeteranDefault = {25,100,250,500,1000}; Buffs: MaxHealth Mult 1.1/1.2/1.3/1.4/1.5 (REPLACE, always recalculated from bp base value), Regen Add +2/+4/+6/+8/+10.
- Storage: one CEconStorage(mAmt={StorageEnergy,StorageMass}) per unit → Chng(+1) adds (int64!)amount to mTotals.mMaxStorage, Chng(-1) when destroying. mMaxStorage is uint64, no floats.
- All rates in SEconTotals (mIncome, mLastUseRequested, mLastUseActual, mReclaimed) are PER TICK; the UI multiplies by GetSimTicksPerSecond()=10 for display. mStored/mMaxStorage are absolute.
- Paused: Unit::SetPaused → Lua OnPaused → SetActiveConsumptionInactive → UpdateConsumptionValues ​​(Drain=0); CBuildTaskHelper then calls focus->Materialize(0.0f) — progress frozen, focus retained.
- GAPS in the decomp: (1) the Econ distribution routine (income collection + mGranted allocation + Unit::ResourceConsumed + Overflow) is completely missing, (2) DispatchQueuedCommand (FUN_00608EF0, the big Command→Task switch) is an empty stub, (3) CFactoryBuildTask::Execute / CUnitMobileBuildTask::Execute / Unit::Materialize / Sim::CreateUnit-Ctor are not lifted.

## Details
## 1. Sim-Tick: order, tick rate, beat semantics

### Tickrate
**Fixed 10 Hz, not configurable.** Evidence:
- `Sim.cpp:18260` `cfunc_GetSimTicksPerSecondL` pusht konstant `10.0`.
- `CEconomyEvent.cpp:1134` `mRemainingTicks = durationSeconds * 10.0f`.
- `Unit.cpp:14722` `newConsumption.energy = consumptionPerSecondEnergy * 0.1f`.
- `SimDriver.cpp` (ExecuteDispatchStepLocked): `simRateEstimate = (1000.0f / medianDispatchMs) * 0.1f` → 100 ms/Beat = Rate 1.0.

The "Game Speed" (+/-) only scales the *wall clock rate of the beats*, never the tick semantics. All Sim formulas are deterministic per tick.

### Beat vs. Tick
- `mCurBeat` (Sim.h:1111): Network/Dispatch step. Runs **always**, even when paused. Controls checksum period (`mCurBeat % checksumPeriod`), desync logs, the 128-entry checksum ring.
- `mCurTick` (Sim.h:1115): Simulation step. Is **only** incremented if `!mGameOver && (mPausedByCommandSource == -1 || mSingleStep)` (Sim.cpp:12001-12002).
- `mDidProcess` (+0x08FC): Latch, set in `AdvanceBeat`, cleared in `Sim::Sync`.

For a TS replica: One beat = one call to `advanceBeat()`; optionally a tick in there. Pause = beats work, ticks don't.

### Exact tick order (`Sim::AdvanceBeat`, Sim.cpp:11990-12098)

**Always (even paused):**
1. `Logf("beat %u")`, `RulesUpdateLuaState(mRules, mLuaState)`

**Only when Tick is running:**
2. `++mCurTick`
3. Optional Hintergrund-Pathfinding (`UpdatePaths`, ConVar-Budget)
4. **`ForEachAllArmyUnit` → `unit->ClearBeatResourceAccumulators()`** (all living units; zeroes `mBeatResourceAccumulators`)
5. **For each army: `CArmyImpl::OnTick()`** (CArmyImpl.cpp:1736)
   - `Stats->mItem->ClearChildren(1)`; `NoRushTicks--`
   - `SetCanSee(focusArmy)`
   - `CleanUpPlatoons()`
   - **`ProcessArmyEconomyTick(*this)`** ← *only cache copy* of `SEconTotals` into the Army fields (EnergyCurrent, IncomeEnergy10x, …). **No calculation!**
   - `Stats->Update()` (ab Tick > 10)
   - `InfluenceMap->Update()` — staggered: only if `ArmyId == mCurTick % 30`
   - UnitCap-Stats setzen
   - **`AiBrain->mAiThreadStage->UserFrame()`** ← Navigator tasks (movement/path)
   - **`AiBrain->mAttackerThreadStage->UserFrame()`** ← Steering-Tasks
   - `AiBrain->mReservedThreadStage->UserFrame()`
   - `ProcessArmyPathQueueBudget(PathFinder, budget=2500)`
6. **`TickTaskStage(&mTaskStageA)`** ← **all unit command tasks run here** (IAiCommandDispatchImpl + Build/Reclaim/Capture/Move/Attack…)
7. `TickTaskStage(&mDiskWatcherTaskStage)`
8. `TickTaskStage(&mTaskStageB)`
9. `RefreshBlips()`
10. **Recon**: Round-Robin - exactly one army per tick makes `reconDb->ReconTick(armyCount)`, all others `ReconRefresh()` (index = `mCurTick % armyCount`)
11. `TickEffectManager(mEffectManager)`
12. `UpdateFormationDb(mFormationDB)`
13. **`ForEachAllArmyUnit` → if `NeedsKillCleanup()` → `KillCleanup()`**
14. *(missing sync filter packing pass — marked as TODO in decomp)*
15. **`for (entity : mCoordEntities) AdvanceCoords(entity)`** ← **Transform-Commit** (siehe unten)
16. Debug-Canvas-Swap; `mAdvancedThisTick = true`; `mSingleStep = false`

**Always (even paused):**
17. Deletion-Queue leeren (`RunQueuedDestroy`)
18. `PurgeDestroyedEffects`, `CleanupDecals`
19. Checksum if `mCurBeat % checksumPeriod == 0`
20. Debug-Overlays ticken
21. Lua-GC every 70 ticks (`lua_setgcthreshold(L, 0)`)

### AdvanceCoords = Double-Buffered Transform (Entity.cpp:4522)
```
prev  <- current
current <- pending
mVelocityScale <- mPendingVelocityScale
→ Position history, collision update (only if changed), Intel ForceUpdate
```
**Important for TS:** Motion/physics code writes to `PendingPosition`/`PendingOrientation` during the tick. Only `AdvanceCoords` at the end of the tick makes it the visible position. `Position`/`Orientation` are the status from the start of the tick during the tick. Only entities in the `mCoordEntities` intrusive list are processed (entities link themselves on when they move and off when Pos+Orient unchanged → Perf optimization).

### What is NOT in the tick
There is **no** explicit “weapons step” and **no** explicit “economy step” in `AdvanceBeat`. Weapons run as `CAcquireTargetTask`/`CFireWeaponTask` in task stages (via `AttachTaskToStage`, CAiAttackerImpl.cpp:430). The economy resolution is **not lifted** (see §4).

---

## 2. Entity/Unit Lifecycle

### Generate
- `Sim::CreateUnit(const SUnitConstructionParams&, bool doCallback)` (Sim.cpp:9929).
  - **Unit cap gate first:** if `!army->IgnoreUnitCap()` and `army->GetArmyUnitCostTotal() + bp->General.CapCost > army->GetUnitCap()` → `nullptr` + brain callback `"OnUnitCapLimitReached"`.
  - **The unit constructor (0x006A53F0) is NOT lifted.**
- `SUnitConstructionParams` (SUnitConstructionParams.h): `{ army, blueprint, transform, useLayerOverride, fixElevation, layer, linkSourceUnit, complete }`. `complete=true` ⇒ Unit starts ready (FractionCompleted=1), otherwise as a construction site.
- Lua `Unit:OnCreate` (Unit.lua:124): sets maintenance consumption/production from blueprint, vision radius, `VeteranLevel=0`, `MaintenanceConsumption=false`, `ActiveConsumption=false`, `Dead=false`, effect bags.

### Build / Finish
- Progress runs via `Entity::FractionCompleted` (Offset 0xD8).
- `Entity::UpdateFractionComplete(delta)` (Entity.cpp:3824): clamped to [0,1]; If the delta is positive, there is also an additional lower limit `Health/MaxHealth` (Health “holds” the progress).
- `Unit::Materialize(float)` is **not lifted** (only `Entity::Materialize` → 0, and `Prop::Materialize` → Reclaim). It must: update FractionCompleted, scale Health = MaxHealth * fraction, fire at 0→>0 `OnStartBeingBuilt`, fire at ==1 `OnStopBeingBuilt`, and probably consume `mConsumptionData->mGranted`.
- `Unit::IsBeingBuilt()` (Unit.cpp:12619).
- **OnStopBeingBuilt** (Lua Unit.lua:1528): SetupIntel, StopBeingBuiltEffects, Rocking on Water, LifeTime Thread, Sounds, `DisallowCollisions=false` (+ Health from Builder Percentage when upgrading!), HideLandBones, Idle Effects, **Create Shield** when `bp.Defense.Shield.ShieldSize > 0 && StartOn != false`, Perm Open Animation, Initialize movement effects/footfalls.
- `CUnitGetBuiltTask::Execute` (CUnitGetBuiltTask.cpp:21): waits in `TASKSTATE_Preparing` as long as `IsBeingBuilt()`; for Immobile → `-1` (task gone). Is the bottom task of each unit task thread (pushed in `AI_CreateCommandDispatch` immediately after dispatch).

### Destroy
`Unit::Kill(instigator, reason, excessDamageRatio)` (Unit.cpp:14358):
1. If already dead → return.
2. Lua `CheckCanBeKilled` — if false **and** within Playable-Rect (or no Commander) → cancel.
3. If in transport: detach, `excessDamageRatio = 10.0f` (⇒ **no wreck**).
4. **If `IsBeingBuilt() && WorkProgress < 0.5f` → `excessDamageRatio = 10.0f`** (half-finished buildings do not cause wreckage).
5. Lua `SetDead`, `Entity::Kill(...)`, **`mNeedsKillCleanup = true`** (will be processed in the next tick step 13).
6. Solve adjacency (`OnNotAdjacentTo` on both sides), detach transport occupants, `CommandQueue->ClearCommandQueue()`.
7. Lua `OnKilled(instigator, type, overkillRatio)`.
8. **Stats**: `massValue = bp.Economy.BuildCostMass` (× WorkProgress if under construction), analog Energy → `Units_MassValue_Lost` / for the opponent `Enemies_MassValue_Destroyed`, `Enemies_Killed`, `Enemies_Commanders_Destroyed`.

`Unit::KillCleanup()` (Unit.cpp:14531) — runs **delayed in tick**: deletes `AiCommandDispatch`, `AiAttacker`, `AiTransport`, `AiNavigator`, `AiSteering`, `AiBuilder`, `AiSiloBuild` and the `CommandQueue`. Order is important: first `AiAttacker->WeaponsOnDestroy()`, then delete dispatch (clears the task stack), then the rest.

`Unit::OnDestroy()` (Unit.cpp:14485) → final removal. Lua `OnDestroy` (Unit.lua:1244): Delete sync data, destroy the unit under construction at Factory, empty trash, `RemoveEconomyEvent` (teleport drain), `ChangeState(self, self.DeadState)`.

### Todes-Sequenz (Lua)
`OnKilled` → `ForkThread(DeathThread, overkillRatio, instigator)` (Unit.lua:1200):
`WaitSeconds(random(DestructionExplosionWaitDelayMin..Max))` → Destruction-Effekte → ggf. Death-Animation abwarten → **`CreateWreckage(overkillRatio)`** → Debris → `WaitSeconds(DeathThreadDestructionWaitTime)` → `Destroy()`.

### Wreck (Unit.lua:1076 `CreateWreckage`, 1090 `CreateWreckageProp`)
```
if overkillRatio > 1.0 → KEIN Wrack (vaporisiert)
if not bp.Wreckage.WreckageLayers[currentLayer] → kein Wrack

mass   = bp.Economy.BuildCostMass   * bp.Wreckage.MassMult      (z.B. 0.9)
energy = bp.Economy.BuildCostEnergy * bp.Wreckage.EnergyMult    (meist 0)
time   = bp.Wreckage.ReclaimTimeMultiplier (z.B. 1)

pos.y = TerrainHeight+TerrainTypeOffset (Land/Seabed) bzw. SurfaceHeight+Offset
prop = CreateProp(pos, bp.Wreckage.Blueprint)   -- default '/props/DefaultWreckage/DefaultWreckage_prop.bp'
prop:AddBoundedProp(mass)                        -- globales Wrack-Limit
prop:SetPropCollision('Box', ...)
prop:SetMaxReclaimValues(time, time, mass, energy)

-- Skalierung nach Overkill UND Baufortschritt:
mass   = (mass   - mass  *overkillRatio) * self:GetFractionComplete()
energy = (energy - energy*overkillRatio) * self:GetFractionComplete()
time   = time - time*overkillRatio
prop:SetReclaimValues(time, time, mass, energy)

prop:SetMaxHealth(bp.Defense.Health)
prop:SetHealth(self, bp.Defense.Health * bp.Wreckage.HealthMult)   -- z.B. 0.9
prop:SetMesh(bp.Display.MeshBlueprintWrecked)
TryCopyPose(self, prop, false)
prop.AssociatedBP = bp.BlueprintId -- for rebuild bonus
```

---

## 3. Command/Task System

### Schichten
```
CTaskStage  (mTaskStageA / mDiskWatcherTaskStage / mTaskStageB / AiBrain-Stages)
  └─ TDatList<CTaskThread>   (mThreads = aktiv, mStagedThreads = geparkt)
       └─ CTaskThread { mTaskTop, mPendingFrames, mStaged }
            └─ CTask*-Stack via mSubtask  (Top = aktueller Task)
```
Per unit there is **one** `CTaskThread` on `mTaskStageA`, whose ground task is the `IAiCommandDispatchImpl` (IAiCommandDispatchImpl.cpp:446), above it the `CUnitGetBuiltTask`, above it the active command task.

### Scheduler (`CTaskStage::UserFrame`, CTaskThread.cpp:775 + `RunThreadUserFrameStep`, CTaskThread.cpp:430)
The thread list is run through per frame (with transfer to a `processed` list, merged back at the end - prevents endless loops with self-requeuing).

```
if (--mPendingFrames > 0) return 0;          // Thread is still sleeping
loop {
task = thread->mTaskTop;  if (!task) return -1;      // Thread empty → delete
  r = task->Execute();                                  // Exception → r = -3
  switch (r) {
    case -4: return -2;            // Thread ans Ende der Stage-Liste (yield)
    case -3: thread->Destroy(); return -1;
    case -2: thread->Stage();  return 0;   // parken bis Unstage/TaskResume
    case -1: /* Task fertig: aus Stack ziehen, ggf. delete */ continue;  // Parent SOFORT weiter
    case  0: thread->mPendingFrames = 0; if (staged) return 0; continue; // sofort nochmal
    case  1: thread->mPendingFrames = 1; return 0;      // 1 Tick warten
    default: thread->mPendingFrames = r - 1; return 0;  // N-1 Ticks warten
  }
}
```
A new task is simply created by `new CSomeTask(parentTask)` — the `CTask` ctor (CTask.cpp:407) pushes itself to `thread->mTaskTop`. The `CTask`-Dtor (CTask.cpp:375) pops cleanly out of the chain.

`CTask::TaskInterruptSubtasks()` (CTask.cpp:426): deletes all tasks **above** `this` in the stack.
`CTask::TaskResume(recursiveInterrupt, pendingFrames)` (CTask.cpp:454): `mPendingFrames = n; Unstage(); [TaskInterruptSubtasks()]`.

### CCommandTask (base of all unit tasks, CCommandTask.h)
Fields: `mUnit`, `mSim`, `mTaskState (ETaskState)`, `mDispatchResult (EAiResult*)`, `mLinkResult (EAiResult)`.
`ETaskState`: `Preparing=0, Waiting=1, Starting=2, Processing=3, Complete=4, 5..8`.
The child ctor `CCommandTask(CCommandTask* parent)` inherits Thread/Unit/Sim and **chains `mDispatchResult` to `&parent->mLinkResult`** — this is how a subtask reports its result upwards.
`EAiResult`: 0 = running/ok, 1 = successful/stopped, 2 = error/retarget.

### Command-Queue (`CUnitCommandQueue`, CUnitCommandQueue.h)
`msvc8::vector<WeakPtr<CUnitCommand>> mCommandVec` + `mCommandType` (head family) + `mNeedsRefresh`. Is a `Broadcaster<EUnitCommandQueueStatus>`.
API: `GetCurrentCommand/GetNextCommand/GetLastCommand/GetCommandInQueue(i)`, `InsertCommandToQueue(cmd,i)`, `AddCommandToQueue`, `RemoveFirstCommandFromQueue`, `MoveFirstCommandToBackOfQueue`, `MoveCommandToBackOfQueue`, `SetCommandCount(i,n)`, `SetCommandTarget(i,ent)`, `ClearCommandQueue`, `AbortActiveTask`.

**`AddCommandToQueue`** (CUnitCommandQueue.cpp:446) — Sonderfall Patrol:
If the new command is Patrol/FormPatrol **and** the queue head is also Patrol/FormPatrol and `size > 1`, **is inserted before** the element with the smallest `mInstanceSerial` (otherwise at the end). This leaves the patrol loop closed in the original order.

### Command → Task: the dispatcher (`IAiCommandDispatchImpl::TaskTick`, IAiCommandDispatchImpl.cpp:589)
```
tryDispatchHead():
  if (!unit || !queue) return 1                      // 1 Tick warten
  if (unit->IsBeingBuilt() || IsDead()
      || IsUnitState(Attached) || IsUnitState(BlockCommandQueue)) return 1
  if (queue->Finished()) return 1
  cmd = queue->GetCurrentCommand();  if (!cmd) return 1
  mState = 1; mLinkResult = 0;
  DispatchQueuedCommand(this, cmd)                   // pusht den konkreten Task
return 0 // continue immediately → Subtask is still running this tick

TaskTick():
  if (mState == 0) return tryDispatchHead()
  // sonst: der gepushte Task ist fertig, mLinkResult wurde gesetzt
  cmd = queue->GetCurrentCommand(); mState = 0
  if (!cmd) return tryDispatchHead()

  if (mLinkResult == 2) {                             // FEHLER / Retarget
      Patrol/FormPatrol ? queue->MoveFirstCommandToBackOfQueue()
                        : queue->RemoveFirstCommandFromQueue()
      return tryDispatchHead()
  }
if (cmd->mVarDat.mCount > 1) { // Factory quantity
      cmd->mVarDat.mCount--; cmd->mNeedsUpdate = true
      return tryDispatchHead()
  }
if (unit->RepeatQueueEnabled && cmd->type == BuildFactory) { // Repeat ONLY for factory building
      cmd->mVarDat.mCount = cmd->mVarDat.mMaxCount; cmd->mNeedsUpdate = true
      queue->MoveFirstCommandToBackOfQueue()
      return 1
  }
  if (cmd->type == Attack) {
      if (cmd->mTarget.targetType != AITARGET_Ground) { queue->RemoveFirstCommandFromQueue(); return tryDispatchHead() }
// Ground attack (attack move point) fails → treated like patrol
  } else if (cmd->type != Patrol && cmd->type != FormPatrol) {
      queue->RemoveFirstCommandFromQueue(); return tryDispatchHead()
  }
  // Patrol / FormPatrol / Ground-Attack: Ringqueue
  if (queue->GetNextCommand()) { CUnitCommand::FormRemoveUnit(unit, cmd); queue->MoveFirstCommandToBackOfQueue() }
  else                          queue->RemoveFirstCommandFromQueue()
  return tryDispatchHead()
```

**Queue-Events** (`IAiCommandDispatchImpl::OnEvent`, :473):
- `UCQS_CommandInserted` → `unit->UpdateSpeedThroughStatus()`
- Everything between `UCQS_Changed` (excl.) and `UCQS_NeedsRefresh` (incl.) → `mPendingFrames=0`, `Unstage()`, **`TaskInterruptSubtasks()`** (current task is aborted immediately), `mState = 0`.
This is the mechanism for "new command overwrites current command".

**⚠ `DispatchQueuedCommand` (FUN_00608EF0) is an empty stub in decomp** (IAiCommandDispatchImpl.cpp:398). The command→task switch must be reconstructed from the task classes.

### EUnitCommandType (SSTICommandIssueData.h:19-58) — complete
```
0 None, 1 Stop, 2 Move, 3 Dive, 4 FormMove,
5 BuildSiloTactical, 6 BuildSiloNuke, 7 BuildFactory, 8 BuildMobile, 9 BuildAssist,
10 Attack, 11 FormAttack, 12 Nuke, 13 Tactical, 14 Teleport, 15 Guard,
16 Patrol, 17 Ferry, 18 FormPatrol, 19 Reclaim, 20 Repair, 21 Capture,
22 TransportLoadUnits, 23 TransportReverseLoadUnits, 24 TransportUnloadUnits,
25 TransportUnloadSpecificUnits, 26 DetachFromTransport, 27 Upgrade, 28 Script,
29 AssistCommander, 30 KillSelf, 31 DestroySelf, 32 Sacrifice, 33 Pause,
34 OverCharge, 35 AggressiveMove, 36 FormAggressiveMove, 37 AssistMove,
38 SpecialAction, 39 Dock
```

### Task classes (moho/unit/tasks/, each `CCommandTask` derivatives)
`CUnitMoveTask`, `CUnitFormAndMoveTask`, `CUnitAttackTargetTask`, `CUnitMeleeAttackTargetTask`, `CUnitFireAtTask`, `CAcquireTargetTask`, `CFireWeaponTask`, `CUnitPatrolTask`, `CUnitGuardTask`, `CUnitAssistMoveTask`, `CUnitMobileBuildTask`, `CFactoryBuildTask`, `CUnitRepairTask`, `CUnitReclaimTask`, `CUnitCaptureTask`, `CUnitUpgradeTask`, `CUnitSacrificeTask`, `CUnitFerryTask`, `CUnitWaitForFerryTask`, `CUnitLoadUnits`, `CUnitUnloadUnits`, `CUnitCallTransport`, `CUnitCallLandTransport`, `CUnitCallAirStagingPlatform`, `CUnitCallTeleport`, `CUnitCarrierLand/Launch/Retrieve`, `CUnitRefuel`, `CUnitPodAssist`, `CUnitGetBuiltTask`.

Hang directly on the dispatcher (not via the switch): `IssueReclaimTask(CAiTarget)`, `IssueCarrierLandTask`, `IssueCallTeleportTask`, `IssueCallAirStagingPlatformTask`, `IssueCallLandTransportTask`, `IssueRefuelTask`, plus `Stop()` and `KillSelf()` (→ `unit->Kill(unit, "Damage", 0.0f)`).

### Formation
`CFormation` (CFormation.h) holds per command: `mStart`, `mFinish`, `mMousePos`, `mDirection{X,Y,Z,W}`, `mDirectionScale`, `mType`, `mBestFormation`, `mTravelFormation`, `mNumFormationScripts`, `mTimeLeft`, `mLastUpdate`, `mCurInstance (IFormationInstance*)` and an RB tree of slot nodes.
Form commands (`FormMove`, `FormAttack`, `FormPatrol`, `FormAggressiveMove`) share **one** `CFormation` instance per command; each unit gets a slot. `CUnitCommand::FormRemoveUnit(unit, cmd)` (called in the dispatcher) removes the unit from the formation when the command is rotated. The formation DB is updated per tick via `UpdateFormationDb(mFormationDB)` (Sim.cpp:12052). The specific slot layouts come from Lua Formation scripts (`mNumFormationScripts`).

---

## 4. Economy in detail

### Datenstrukturen
**Important:** `CEconomy` (CEconomy.h) and `CSimArmyEconomyInfo` (CSimArmyEconomyInfo.h) have **identical layout** — it's the same object, two views:
```
+0x00 Sim* mSim
+0x04 int32 mIndex
+0x08 SEconValue mResources          {float energy, mass}   ← Reclaim-Zufluss-Puffer
+0x10 SEconValue mPendingResources
+0x18 SEconTotals mTotals  (== CSimArmyEconomyInfo::economy)
        +0x18 SEconPair mStored            {ENERGY, MASS}   absolut
        +0x20 SEconPair mIncome                              PRO TICK
        +0x28 SEconPair mReclaimed                           PRO TICK
        +0x30 SEconPair mLastUseRequested                    PRO TICK
        +0x38 SEconPair mLastUseActual                       PRO TICK
        +0x40 SEconStoragePair mMaxStorage {uint64, uint64}  absolut, GANZZAHLIG
+0x50 CEconStorage* mExtraStorage    (== storageDelta)
+0x54 uint8 mResourceSharing         (== isResourceSharingEnabled)
+0x58 TDatListItem mConsumptionData  (== registrationNode)  ← Kopf der Request-Liste
```

**`CEconRequest`** (CEconomyEvent.h:50, 0x18 Bytes):
```
+0x00 TDatListItem mNode // mounted in economy->registrationNode
+0x08 SEconValue mRequested     // PRO TICK
+0x10 SEconValue mGranted       // PRO TICK zugeteilt (akkumulierender Pool!)

float LimitingRate() const {    // CEconomyEvent.cpp:1096
  r = 1.0
  if (requested.energy > 0) r = min(r, granted.energy / requested.energy)
  if (requested.mass   > 0) r = min(r, granted.mass   / requested.mass)
  return r
}
```

Each unit has exactly its own request: `Unit::mConsumptionData` (Unit.h:1768). In addition, tasks can create their own requests (capture, refuel repair, silo, CEconomyEvent/Teleport).

### Consumption registration (`Unit::SetConsumptionActive`, Unit.cpp:14716)
```cpp
newConsumption.energy = Attributes.consumptionPerSecondEnergy * 0.1f;   // → PRO TICK
newConsumption.mass   = Attributes.consumptionPerSecondMass   * 0.1f;

if (!mConsumptionData) { new CEconRequest, mount in economyInfo->registrationNode }

if (!ConsumptionActive) {
// REFUND of unused, accumulated grants to storage:
    economyInfo->economy.mStored.ENERGY += mConsumptionData->mGranted.energy;
    economyInfo->economy.mStored.MASS   += mConsumptionData->mGranted.mass;
    newConsumption = {0,0};
}
mConsumptionData->mRequested = newConsumption;
SharedEconomyRateEnergy/Mass = newConsumption;
→ Lua-Callback "OnConsumptionActive" / "OnConsumptionInActive"
```
**This refund is hard proof that `mGranted` is an accumulating pool** (no per-tick overwrite).

### The Drain Formulas (Lua — this is where all the logic lies!)

**`Game.GetConstructEconomyModel(builder, targetData)`** (lua/game.lua:24):
```lua
rate = builder:GetBuildRate()                  -- = UnitAttributes.buildRate
time   = targetData.BuildTime * (100 + builder.BuildTimeModifier or 0) * 0.01;  if time < 0.1 then time = 0.1
energy = targetData.BuildCostEnergy * (100 + builder.EnergyModifier or 0) * 0.01;  if energy < 0 then energy = 0
mass   = targetData.BuildCostMass   * (100 + builder.MassModifier   or 0) * 0.01;  if mass   < 0 then mass   = 0
return time/rate, energy, mass          -- ← time/rate ist SEKUNDEN
```
`targetData` = `bp.Economy` of a unit **or** a `Enhancement` section (same field names).

**`Unit:UpdateConsumptionValues()`** (lua/sim/Unit.lua:690) — is called for *every* change (construction start/end, toggle, buff, pause):
```lua
energy_rate, mass_rate = 0, 0

if self.ActiveConsumption then
    if self.WorkItem then                                  -- Enhancement
        time, energy, mass = Game.GetConstructEconomyModel(self, self.WorkItem)
    elseif focus and focus:IsUnitState('SiloBuildingAmmo') then   -- Silo-Assist
        time, energy, mass = focus:GetBuildCosts(focus.SiloProjectile)
        energy = (energy / focus:GetBuildRate()) * self:GetBuildRate()
        mass   = (mass   / focus:GetBuildRate()) * self:GetBuildRate()
    elseif focus then                                      -- normaler Bau/Reparatur/Assist
        time, energy, mass = self:GetBuildCosts(focus:GetBlueprint())   -- = GetConstructEconomyModel
    end
    energy = energy * (self.EnergyBuildAdjMod or 1);  if energy < 1 then energy = 1 end
    mass   = mass   * (self.MassBuildAdjMod   or 1);  if mass   < 1 then mass   = 1 end
    energy_rate = energy / time            -- PRO SEKUNDE
    mass_rate   = mass   / time
end

if self.MaintenanceConsumption then
    mai_energy = (self.EnergyMaintenanceConsumptionOverride or bp.Economy.MaintenanceConsumptionPerSecondEnergy or 0)
    mai_mass   = bp.Economy.MaintenanceConsumptionPerSecondMass or 0
    mai_energy = mai_energy * (100 + self.EnergyModifier) * (self.EnergyMaintAdjMod or 1) * 0.01
    mai_mass   = mai_mass   * (100 + self.MassModifier)   * (self.MassMaintAdjMod   or 1) * 0.01
    energy_rate = energy_rate + mai_energy
    mass_rate   = mass_rate   + mai_mass
end

energy_rate = math.max(energy_rate, bp.Economy.MinConsumptionPerSecondEnergy or 0)
mass_rate   = math.max(mass_rate,   bp.Economy.MinConsumptionPerSecondMass   or 0)

self:SetConsumptionPerSecondEnergy(energy_rate)     -- → UnitAttributes.consumptionPerSecondEnergy
self:SetConsumptionPerSecondMass(mass_rate)
self:SetConsumptionActive(energy_rate > 0 or mass_rate > 0)
```
**Kurzform:** `energy_rate [E/s] = BuildCostEnergy * buildRate / BuildTime` (nach Modifiern, min 1 absolut).
**Per Tick** (Engine): `× 0.1`.

**`Unit:UpdateProductionValues()`** (Unit.lua:755):
```lua
SetProductionPerSecondEnergy(bp.Economy.ProductionPerSecondEnergy * (self.EnergyProdAdjMod or 1))
SetProductionPerSecondMass  (bp.Economy.ProductionPerSecondMass   * (self.MassProdAdjMod   or 1))
```
(The AdjMods are the adjacency bonuses, see lua/sim/AdjacencyBuffs.lua.)

### Baufortschritt (`CBuildTaskHelper::UpdateWorkProgress`, CBuildTaskHelper.cpp:247)
```cpp
// ComputeBuildProgressDelta (CBuildTaskHelper.cpp:61):
timeToBuild = blueprint->Economy.BuildTime / builderAttributes.buildRate;   // Sekunden
delta = (1.0f / timeToBuild) * resourceConsumed * 0.1f;                     // 0.1 = 1 Tick
// == (buildRate / BuildTime) * 0.1 * resourceConsumed
```
with `resourceConsumed = Unit::ResourceConsumed` (Unit.h:1772, offset 0x53C) = the **fulfillment ratio** of the unit request (0..1). With full supply, construction takes exactly `BuildTime / buildRate` seconds.

Weiterer Ablauf in `UpdateWorkProgress`:
- **Paused** (`ownerUnit->IsPaused`): `WorkProgress = focus->FractionCompleted`, then `focus->Materialize(0.0f)` → Progress frozen, focus/task remain. Return true (finished) only if not Repairing and Fraction ≥ 1.
- **Silo-Modus** (`mIsSilo`): `perSecond = ownerUnit->mConsumptionData->mRequested * resourceConsumed` → `focus->AiSiloBuild->SiloAssistWithResource(perSecond)`.
- **Enhancing** (`focus->IsUnitState(UNITSTATE_Enhancing)`): `tickDelta = (1/(WorkItemBuildTime/buildRate)) * resourceConsumed * 0.1`; `focus:SetLuaValue("WorkProgress", min(1, prog + tickDelta))`.
- **Shield Assist** (`focus->IsInCategory("SHIELD")`): `shield->AdjustHealth(null, (shieldRegenRate*0.1 * buildRate) / RegenAssistMult)`; if the shield unit itself is damaged: `RegenAssistMult *= 2` **and** `buildProgressDelta *= 0.5` (repair and shield charging share the service).
- **Fuel Assist** (`FuelUseTime > 0 && FuelRatio < 1`): `fuelTickDelta = (FuelRechargeRate/FuelUseTime) * 0.1`; if damaged: `fuelTickDelta *= 0.5` and `buildProgressDelta *= 0.5`.
- Then `focus->Materialize(resourceConsumed != 0 ? buildProgressDelta : 0)`.
- **Repair Action** (`mActionName == "Repair"` and target no longer under construction): `WorkProgress = focus->Health / focus->MaxHealth`; finished when 1.0 (+ Fuel==1 or Shield full).
- **Progress callbacks**: when exceeding 0.25 / 0.5 / 0.75 → `OnBuildProgress` (builder) + `OnBeingBuiltProgress` (target).

### Assist-Stacking
**Additive, without special logic.** Each helper:
- has an **own** `CUnitRepairTask`/`CUnitMobileBuildTask` with **own** `CBuildTaskHelper` and **own** `Unit::mConsumptionData`,
- calculates its drain from **its** `buildRate` (`GetConstructEconomyModel(self, focusBP)`),
- calls `focus->Materialize(delta_i)` with **its** `delta_i = buildRate_i / BuildTime * 0.1 * ratio_i` per tick.

⇒ Effective build rate = `Σ buildRate_i`, effective drain = `Σ (BuildCost * buildRate_i / BuildTime)`. Costs per unit of progress remain constant.
Assisting Engineers inherit the target's WorkItem: `CUnitRepairTask.cpp:136` calls Lua `InheritWork`; `Unit.lua:1680` to `OnStartBuild`: `if order == 'Repair' and unitBeingBuilt.WorkItem != self.WorkItem then self:InheritWork(unitBeingBuilt) end`.

### Reclaim (`CUnitReclaimTask.cpp`)
Cost (`QueryReclaimCosts`, :141): calls Lua `GetReclaimCosts(target)` → (timeSeconds, energy, mass); then
```cpp
reclaimTime = max(1.0f, timeSeconds * 10.0f)     // TICKS
```
**Lua `Unit:GetReclaimCosts`** (Unit.lua:2699, target is unit):
```lua
mtime = target_bp.Economy.BuildCostEnergy / self:GetBuildRate()   -- (Namensvertauschung im Original!)
etime = target_bp.Economy.BuildCostMass   / self:GetBuildRate()
time  = max(mtime, etime) * (self.ReclaimTimeMultiplier or 1)
return time/10, target_bp.Economy.BuildCostEnergy, target_bp.Economy.BuildCostMass
```
⇒ **Ticks = max(BuildCostEnergy, BuildCostMass) / buildRate**; Yield = 100% of BuildCostMass **and** BuildCostEnergy.

**Lua `Prop:GetReclaimCosts`** (Prop.lua:153, target is wreck):
```lua
mtime = self.ReclaimTimeMassMult   * (self.MassReclaim   / reclaimer:GetBuildRate())
etime = self.ReclaimTimeEnergyMult * (self.EnergyReclaim / reclaimer:GetBuildRate())
time  = max(mtime, etime)
return time/10, self.EnergyReclaim, self.MassReclaim
```

Engine per tick (TASKSTATE_Processing/Complete, :711-796):
```cpp
reclaimRate       = 1.0f / reclaimTime;         // Fraction pro Tick
mReclaimRate      = -reclaimRate;
mReclaimPerSecond.energy = max(reclaimEnergy,0) * reclaimRate;   // (actually PER TICK)
mReclaimPerSecond.mass   = max(reclaimMass,  0) * reclaimRate;

// jeden Tick:
limitingRate        = mConsumptionData->LimitingRate();
appliedFractionDelta = target->Materialize(mReclaimRate * limitingRate);
// for unit goals, additionally link Health to FractionCompleted:
clamped = min(target->FractionCompleted, target->Health/target->MaxHealth);
if (target->MaxHealth * clamped != target->Health) target->SetHealth(target->MaxHealth * clamped);
unit->WorkProgress = 1.0f - target->FractionCompleted;

AwardReclaimedResources(unit, appliedFractionDelta, mReclaimRate, mReclaimPerSecond);   // :191
  → multiplier = appliedFractionDelta / reclaimRate
  → economy->mResources.energy      += reclaimPerSecond.energy * multiplier
  → economy->mResources.mass        += reclaimPerSecond.mass   * multiplier
  → economy->mTotals.mReclaimed.*   += dito
```
**Paused special case for props** (:781): `mReclaimRate = -1e-8f`, `mReclaimPerSecond = {0,0}` → Wreck remains "in progress", but no progress/yield.
**Starting phase** (TASKSTATE_Starting, :681): Reclaim begins with a health penalty `MaxHealth/reclaimTime (+ regenRate*0.1)`; If the health is below, the target is immediately transformed into a wreck using `RunScriptCreateWreckageProp(0.0f)` + `Destroy()` and the wreck is set as a new target.
Termination condition: `contactDistance > bp.Economy.MaxBuildDistance` (for Patrol: `max(MaxBuildDistance, bp.AI.GuardScanRadius)`).

### Repair
No dedicated drain path: `CUnitRepairTask` has a `CBuildTaskHelper` with `mActionName = "Repair"`. The drain comes from `UpdateConsumptionValues` (focus available ⇒ `GetBuildCosts(focus:GetBlueprint())` ⇒ **same rate as new building**). Progress goes through `focus->Materialize(delta)` → `UpdateFractionComplete` → Health follows the fraction. Done when `Health == MaxHealth` (+ Fuel/Shield full).

### Capture (`CUnitCaptureTask.cpp`)
**Lua `Unit:GetCaptureCosts`** (Unit.lua:2734):
```lua
time   = ((target_bp.Economy.BuildTime or 10) / self:GetBuildRate()) / 2 * (self.CaptureTimeMultiplier or 1)
energy = target_bp.Economy.BuildCostEnergy or 100
return time, energy, 0        -- Mass = 0!
```
Engine (:454-523):
```cpp
mCaptureTime += (int)max(1.0f, timeSeconds * 10.0f);           // TICKS
// + add again for EVERY attached entity (transport occupants etc.).
energyCost = Σ energy; massCost = Σ mass;   (beide auf ≥0 geklemmt)
mCaptureRate = { energyCost / mCaptureTime, massCost / mCaptureTime };   // PRO TICK
→ eigene CEconRequest anlegen

// pro Tick (TASKSTATE_Processing, :509):
if (granted.energy >= mCaptureRate.energy && granted.mass >= mCaptureRate.mass) {
    granted = TakeGrantedResourcesAndReset(mConsumptionData);      // Pool leeren
    unit->mBeatResourceAccumulators.resourcesSpent* += granted.*;
    mCaptureProgress = min(mCaptureProgress + targetUnit->CaptorCount, mCaptureTime);
    unit->WorkProgress = mCaptureProgress / mCaptureTime;
}
```
⇒ **All-or-nothing per tick, but grants accumulate** ⇒ at 50% supply, capture takes twice as long.
⇒ `+= CaptorCount`: N simultaneous captors ⇒ each task progresses N-fold ⇒ linearly faster.
Completion: `OnStopCapture` (Captor), `OnStopBeingCaptured` + `OnCaptured` (Target).

### CEconomyEvent (Teleport-Drain, generischer Lua-Drain) — `CEconomyEvent.cpp`
`CreateEconomyEvent(unit, energy, mass, timeInSeconds, [callback])`:
```cpp
mRemainingTicks = max(1, (int)(durationSeconds * 10.0f));  mTotalTicks = mRemainingTicks;
mRequestedPerTick = { energy / mRemainingTicks, mass / mRemainingTicks };
→ eigene CEconRequest in economy->registrationNode
```
`ProcessTick()` (:1241): if `granted >= requestedPerTick` → deduct grants, `mRemainingTicks--`, progress callback `(1 - remaining/total)`, if 0 → delete request + signal event.
Dtor deletes the request and zeros `SharedEconomyRate*`.

### Storage (`CEconStorage.cpp:374`)
```cpp
int64 CEconStorage::Chng(int32 direction) {          // direction = +1 / -1
  for lane in {ENERGY, MASS}:
     result = (int64)mAmt[lane] * direction;         // ← Float → int64 TRUNKIERUNG
     mEconomy->mTotals.mMaxStorage[lane] += (uint64)result;
}
CEconStorage(amount, economy) : mEconomy(economy), mAmt(amount) { Chng(+1); }
int64 ChangeAmt(amount) { Chng(-1); mAmt = amount; return Chng(+1); }
```
During construction, each unit registers a `CEconStorage` with `{bp.Economy.StorageEnergy, bp.Economy.StorageMass}`; when destroying `Chng(-1)`.
`mMaxStorage` is **uint64 / integer** — no decimal places.
Cheat reference `Sim::BlingBling` (Sim.cpp:11069) shows the access path.

### Paused state
- `Unit::SetPaused(bool)` (Unit.cpp:14625): only allowed if `commandCapsMask & RULEUCC_Pause (0x20000)` or `toggleCapsMask & RULEUTC_GenericToggle (0x40)`. Sets `IsPaused`, fires Lua `OnPaused`/`OnUnpaused`, `MarkNeedsSyncGameData()`.
- Lua `Unit:OnPaused` (Unit.lua:397): `SetActiveConsumptionInactive()` → `UpdateConsumptionValues()` → `energy_rate = 0` (maintenance/min only) → `SetConsumptionActive(false)` → **accumulated grants will be refunded to `mStored`**.
- Lua `Unit:OnUnpaused` (:402): only if `IsUnitState('Building'|'Upgrading'|'Repairing')` → `SetActiveConsumptionActive()`.
- `CBuildTaskHelper::UpdateWorkProgress` (:255): at `IsPaused` → `focus->Materialize(0.0f)`, progress frozen, task continues running.
- Separately: `OnProductionPaused`/`OnProductionUnpaused` (Unit.lua:660) for toggle buildings → `SetMaintenanceConsumptionInactive` + `SetProductionActive(false)`.

### Build-Gate
`Unit::CanStartBuilding(energyCost, massCost)` (Unit.cpp:12407):
```cpp
if (mStored.ENERGY > 0.001 && mStored.MASS > 0.001) return true;         // Speicher da → immer ok
return (energyCost <= 0 || mIncome.ENERGY >= 0.001)
&& (massCost <= 0 || mIncome.MASS >= 0.001);                     // otherwise: income required
```

### ⚠ The distribution routine is missing in the decomp
There is **no** lifted function that **writes** `mIncome`, `mLastUseRequested`, `mLastUseActual`, `mGranted` or `Unit::ResourceConsumed`. However, the semantics can be clearly derived from the consumers:
```
pro Tick, pro Armee:
1. income = Σ over all units with ProductionActive: productionPerSecond{E,M} * 0.1
     mTotals.mIncome = income
  2. available = mStored + income + mResources (Reclaim-Puffer)  → mResources danach nullen
3. requested = Σ via request list (registrationNode): req->mRequested
     mTotals.mLastUseRequested = requested
  4. ratio_E = clamp(available.E / requested.E, 0, 1)   (analog Mass; requested==0 → ratio 1)
5. for each request: req->mGranted += req->mRequested * ratio // ACCUMULATIVE!
     actual = Σ (req->mRequested * ratio)
     mTotals.mLastUseActual = actual
6. for each unit: unit->ResourceConsumed = unit->mConsumptionData->LimitingRate()
7. mStored = clamp(mStored + income - actual, 0, mMaxStorage) // Surplus = OVERFLOW, expires
```
**Evidence for accumulation semantics** (no per-tick overwrite):
- `Unit::SetConsumptionActive(false)` refunds `mGranted` to `mStored` (Unit.cpp:14747) — only useful for a maintained pool.
- `TakeGrantedResourcesAndReset()` (CEconomyEvent.cpp:736) exists and is used by Capture/EconomyEvent/Silo/Staging-Repair — only useful if every tick is not overwritten anyway.
- Capture/EconomyEvent gate on `granted >= requested` and would **never** progress with overwrite under brownout (wrong), with accumulation they progress proportionally slower (correct).
**Overflow:** no compensation for allies. `mResourceSharing` (+0x54) is a pure flag; the sharing logic has not been lifted either. Any excess over `mMaxStorage` expires (no field available for this).

---

## 5. Fabriken

### Construction task
`CFactoryBuildTask : CCommandTask` (CFactoryBuildTask.h), fields:
`mDispatch`, `mBlueprint`, **`mBuildHelper (CBuildTaskHelper)`**, `mRallyPointUnit (WeakPtr<Unit>)`, `mBuildCount`, `mHasCommand`, `mCommand (WeakPtr<CUnitCommand>)`.
`Create(dispatchTask, blueprint, command, rallyPointUnit)`, `InheritCommandsTo(builtUnit)` (transfers pending commands from the factory to the built unit — this is how factory waypoints/command defaults work).
**`CFactoryBuildTask::Execute` (0x005FA790) is NOT lifted.**

### Cue quantity
Located in `CUnitCommand::mVarDat.mCount` / `mMaxCount`. The dispatcher (IAiCommandDispatchImpl.cpp:639) decrements `mCount` per finished unit; The command is only removed with `mCount == 1`. **Repeat build** (`unit->RepeatQueueEnabled`, set via `Unit::SetRepeatQueue`, Unit.cpp:14653 → Lua `OnStartRepeatQueue`/`OnStopRepeatQueue`) is implemented **exclusively** for `UNITCOMMAND_BuildFactory`: `mCount = mMaxCount`, rotate command to the end of the queue.
UI side: `CUnitCommandQueue::SetCommandCount(index, count)`; Count 0 ⇒ Remove command.

### Rolloff / Wartepunkte (lua/defaultunits.lua, `FactoryUnit`)
State machine via `ChangeState`:
```
OnStartBuild (:504):
    ChangeBlinkingLights('Yellow'); BuildingUnit = true
    if order != 'Upgrade' → ChangeState(self, self.BuildingState)
    FactoryBuildFailed = false

BuildingState.Main (:663):
    DetachAll(bp.Display.BuildAttachBone)
unitBeingBuilt:AttachBoneTo(-2, self, bone) -- Unit is attached to the build bone
    CreateBuildRotator()                             -- dreht den Bone Richtung Rally
    StartBuildFx(unitBuilding)

OnStopBuild (:515):
    if !FactoryBuildFailed:
        if not AIR(unitBeingBuilt) → RollOffUnit()   -- Land/See: Move-Befehl RAUS
        StopBuildFx(); ForkThread(FinishBuildThread, unitBeingBuilt, order)
    BuildingUnit = false

FinishBuildThread (:528):
    SetBusy(true); SetBlockCommandQueue(true)        -- ← blockiert den Dispatcher!
    if bp.Display.AnimationFinishBuildLand and LAND(unit):
        RollOffAnim = CreateAnimator(self):PlayAnim(...); WaitTicks(1); WaitFor(RollOffAnim)
    unitBeingBuilt:DetachFrom(true)
    DetachAll(BuildAttachBone); DestroyBuildRotator()
    if order != 'Upgrade' → ChangeState(self, self.RollingOffState)
    else                  → SetBusy(false); SetBlockCommandQueue(false)

RollingOffState.Main → RolloffBody (:638):
    SetBusy(true); SetBlockCommandQueue(true); PlayFxRollOff()
    while unitBeingBuilt lebt and MoveCommand and not IsCommandDone(MoveCommand):
        WaitSeconds(0.5)                             -- warten bis Unit die Fabrik verlassen hat
    MoveCommand = nil; PlayFxRollOffEnd()
    SetBusy(false); SetBlockCommandQueue(false)
    ChangeState(self, self.IdleState)

IdleState.Main → Lights 'Green', SetBusy(false), SetBlockCommandQueue(false), DestroyBuildRotator()
```

**`RollOffUnit`** (:568) / **`CalculateRollOffPoint`** (:574):
```lua
bp = self:GetBlueprint().Physics.RollOffPoints     -- Liste von {X,Y,Z,UnitSpin}
px,py,pz = self:GetPosition()
vectorObj = self:GetRallyPoint()                   -- Wegpunkt (Default: eigene Position + Offset)
-- choose the RollOffPoint that is closest to the Rally Point:
for k,v in bp: distance = VDist2(vectorObj[1], vectorObj[3], v.X+px, v.Z+pz)
               if distance < lowest → bpKey = k
spin = unitBeingBuilt.bp.Display.ForcedBuildSpin or bp[bpKey].UnitSpin
fx,fy,fz = bp[bpKey].X+px, bp[bpKey].Y+py, bp[bpKey].Z+pz
→ self.MoveCommand = IssueMove({unitBeingBuilt}, Vector(fx,fy,fz))
```
The Rally Point (`GetRallyPoint`) therefore determines **both**: the rotator alignment during construction (`CreateBuildRotator` uses `spin`) **and** which RollOff point is used. `mRallyPointUnit` in `CFactoryBuildTask` is the rally target carrier.

**`SetBlockCommandQueue(true)`** sets `UNITSTATE_BlockCommandQueue` — the dispatcher (`tryDispatchHead`) then refuses any new command. This prevents the factory from building the next unit before the current one has left the construction platform.

**AIR factories** do not roll off (`if not EntityCategoryContains(categories.AIR, ...)`), the unit flies straight away.
`OnFailedToBuild` (:560): `FactoryBuildFailed = true`, Rotator/Fx gone, `ChangeState(IdleState)`.
`OnKilled` (:683): `self.UnitBeingBuilt:Destroy()`.

---

## 6. Veterancy

**Retail FA is KILL NUMBER based** (not mass value based — this is a FAF change).

**Schwellen** (`lua/game.lua:11`):
```lua
VeteranDefault = { Level1 = 25, Level2 = 100, Level3 = 250, Level4 = 500, Level5 = 1000 }
```
Is **overwritten** per unit by the blueprint, e.g. UEL0201 (Medium Tank):
```lua
Veteran = { Level1 = 3, Level2 = 6, Level3 = 9, Level4 = 12, Level5 = 15 }
```

**Ablauf:**
- `Unit:OnKilled(instigator, ...)` → `instigator:OnKilledUnit(self)` (Unit.lua:934)
- `OnKilledUnit` → `self:CheckVeteranLevel()` (Unit.lua:952)
- `CheckVeteranLevel` (Unit.lua:3131):
```lua
bp = self:GetBlueprint().Veteran or Game.VeteranDefault
unitKills = self:GetStat('KILLS', 0).Value + 1          -- +1, weil die Engine-Stat noch nicht aktualisiert ist
if self.VeteranLevel == table.getsize(bp) then return end   -- schon max
nextLvl = self.VeteranLevel + 1
if unitKills >= bp['Level'..nextLvl] then self:SetVeteranLevel(nextLvl) end
```
- `AddKills(n)` (Unit.lua:3084) for script kills: sets the KILLS stat and if necessary increases **several** levels at once in a `while` loop.
- `SetVeterancy(level)` (Unit.lua:3109): Convenience setter, goes over `AddKills(threshold)`.

**`SetVeteranLevel(level)`** (Unit.lua:3154):
```lua
self.VeteranLevel = level
for bType in {'Regen', 'Health'}:  Buff.ApplyBuff(self, 'Veterancy'..bType..level)
-- Blueprint-Overrides:
for bType, bData in bp.Buffs:
    for lName, lValue in bData:
        if lName == 'Level'..level:
            buffName = self:CreateVeterancyBuff(lName, lValue, bType)   -- 'Damage' → false (kein Buff)
            Buff.ApplyBuff(self, buffName)
self:GetAIBrain():OnBrainUnitVeterancyLevel(self, level)
self:DoUnitCallbacks('OnVeteran')
```

**Default-Buffs** (`lua/sim/BuffDefinitions.lua`):
| Level | VeterancyHealth (MaxHealth) | VeterancyRegen (Regen) |
|---|---|---|
| 1 | Add 0, **Mult 1.1** | **Add +2**, Mult 1 |
| 2 | Mult 1.2 | Add +4 |
| 3 | Mult 1.3 | Add +6 |
| 4 | Mult 1.4 | Add +8 |
| 5 | Mult 1.5 | Add +10 |

Beide: `BuffType = 'VETERANCYHEALTH'` / `'VETERANCYREGEN'`, **`Stacks = 'REPLACE'`**, `Duration = -1`.
`REPLACE` ⇒ Level 3 replaces Level 2 (not cumulative), but the value is **always recalculated from the Blueprint base value**:

**`BuffCalculate(unit, buffName, affectType, initialVal)`** (lua/sim/Buff.lua):
```lua
adds = Σ (v.Add * v.Count);   mults = Π (v.Mult ^ v.Count)
returnVal = (initialVal + adds) * mults
clamp auf [lowestFloor, highestCeil] falls gesetzt
```
Anwendung (Buff.lua:206ff):
```lua
-- MaxHealth:
val = BuffCalculate(unit, buffName, 'MaxHealth', bp.Defense.MaxHealth)   -- IMMER vom bp-Basiswert!
oldmax = unit:GetMaxHealth()
unit:SetMaxHealth(val)
if val > oldmax then unit:AdjustHealth(unit, val - oldmax)               -- Differenz wird GEHEILT
else unit:SetHealth(unit, math.min(unit:GetHealth(), unit:GetMaxHealth())) end

-- Regen:
val = BuffCalculate(unit, buffName, 'Regen', bp.Defense.RegenRate)
unit:SetRegenRate(val)     -- → UnitAttributes.regenRate (Unit.cpp:6097), HP pro SEKUNDE
```
⇒ Vet advancement heals the unit by the MaxHealth increase.
⇒ `regenRate` is HP/second; the engine applies `regenRate * 0.1` per tick (indirectly evidenced in CUnitReclaimTask.cpp:683 and CBuildTaskHelper.cpp:344).
⇒ `CreateVeterancyBuff` with `buffType == 'Damage'` returns `false` ⇒ **Damage bonuses from Veterancy are disabled in Retail FA** (the weapon buff loop is commented out, Unit.lua:3168-3172).

---

## Reference values ​​from blueprints (verified)
| Unit | BuildRate | BuildTime | CostE | CostM | Storage E/M |
|---|---|---|---|---|---|
| UEL0001 (ACU) | 10 | 60000 | 5000000 | 18000 | 4000 / 650 |
| UEL0105 (T1 Engi) | 5 | 260 | 260 | 52 | 0 / 10 |
| UEB0101 (T1 Land Fac) | 20 | 300 | 2100 | 240 | 0 / 80 |
| UEB0301 (T3 Land HQ) | 60 | 8400 | 28350 | 3150 | 0 / 320 |
| UEL0201 (Medium Tank) | – | 280 | 266 | 56 | – |
| UEB1103 (Mass Ext T1) | 10 | 60 | 360 | 36 | ProdM=2, MaintE=2 |
| UEB1101 (Power T1) | – | 125 | 750 | 75 | ProdE=20 |

Sample: T1 factory builds medium tank → `280/20 = 14 s`; Drain `266*20/280 = 19 E/s`, `56*20/280 = 4 M/s`. ✔
ACU-Enhancements setzen `NewBuildRate` (z.B. 30 / 90) → `SetBuildRate`.

---

## Critical gaps in the decomp (to be written for the reconstruction yourself)
1. **Econ distribution**: no lifted function writes `mIncome`/`mGranted`/`ResourceConsumed`/`mLastUseActual`. Semantics reconstructed above; the accumulation vs. overwrite point is the only true degree of freedom (evidence clear for **accumulation**).
2. **`DispatchQueuedCommand` (FUN_00608EF0)** — IAiCommandDispatchImpl.cpp:398 is an empty stub. The Command→Task switch must be built from the task list + `EUnitCommandType`.
3. **`CFactoryBuildTask::Execute` (0x005FA790)** and **`CUnitMobileBuildTask::Execute`** — only Ctor/Dtor/Serialize lifted. Can be derived from `CBuildTaskHelper` + the Dtor cleanup paths (`UnitStateMask &= ~kUnitStateBuildingMask`, `mBuildHelper.OnStopBuild(true)`, `FreeOgridRect()`, dispatch result 1 for `TASKSTATE_5`, otherwise 2 + Lua `OnFailedToBuild`).
4. **`Unit::Materialize`** (override missing; only `Entity::Materialize`→0 and `Prop::Materialize` there) and **Unit-Ctor (0x006A53F0)** in `Sim::CreateUnit`.
5. `Sim::AdvanceBeat` is missing a sync filter packing pass (marked as TODO in the decomp, Sim.cpp:12060) — irrelevant for a replica without netcode.

## Refs
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\sim\Sim.cpp:11990 — Sim::AdvanceBeat (complete tick order, lines 11990-12098)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\Sim.cpp:18260 — cfunc_GetSimTicksPerSecondL (Tickrate = 10.0 fix)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\Sim.cpp:8411 — Sim::Sync (mDidProcess-Latch)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\sim\Sim.cpp:9929 — Sim::CreateUnit (Unit Cap Gate; Ctor NOT lifted)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\sim\Sim.cpp:18020 — cfunc_GetEconomyTotalsL (Lua shape from SEconTotals)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\Sim.h:1111 — mCurBeat / mCurTick / mTaskStageA,B
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\sim\CArmyImpl.cpp:1736 — CARmyImpl::OnTick (Army Tick Order)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\sim\CArmyImpl.cpp:1024 — ProcessArmyEconomyTick (cache copy only!)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\CSimArmyEconomyInfo.h — SEconTotals/SEconPair/SEconStoragePair Layout
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\CEconomy.h:76 — CEconomy-Layout (identisch mit CSimArmyEconomyInfo)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\sim\CEconStorage.cpp:374 — CEconStorage::Chng (MaxStorage as int64)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\misc\CEconomyEvent.h:50 — CEconRequest {mNode, mRequested, mGranted}
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\misc\CEconomyEvent.cpp:1096 — CEconRequest::LimitingRate
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\misc\CEconomyEvent.cpp:1241 — CEconomyEvent::ProcessTick (all-or-nothing + TakeGrantedResourcesAndReset)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\misc\CEconomyEvent.cpp:1121 — CEconomyEvent-Ctor (durationSeconds*10 → Ticks)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\task\CTaskThread.cpp:430 — RunThreadUserFrameStep (Task-Return-Code-Protokoll -4..N)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\task\CTaskThread.cpp:775 — CTaskStage::UserFrame
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\task\CTaskThread.cpp:706 — CTaskThread::Stage / :722 Unstage
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\task\CTask.cpp:375 — CTask::~CTask / :407 Ctor (Task-Stack-Push) / :426 TaskInterruptSubtasks / :454 TaskResume
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\task\CTask.h:14 — ETaskState-Enum
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\task\CCommandTask.h:88 — CCommandTask fields (mTaskState, mDispatchResult, mLinkResult)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\ai\IAiCommandDispatchImpl.cpp:589 — IAiCommandDispatchImpl::TaskTick (Queue-Semantik: Count/Patrol/Repeat)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\ai\IAiCommandDispatchImpl.cpp:473 — OnEvent (TaskInterruptSubtasks on queue change)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\ai\IAiCommandDispatchImpl.cpp:398 — DispatchQueuedCommand (EMPTY STUB — FUN_00608EF0 not lifted)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\ai\IAiCommandDispatchImpl.cpp:415 — AI_CreateCommandDispatch (Dispatch + CUnitGetBuiltTask on mTaskStageA)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\command\SSTICommandIssueData.h:19 — EUnitCommandType (0..39 complete)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\unit\CUnitCommandQueue.cpp:446 — AddCommandToQueue (Patrol ring queue insert)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\unit\CUnitCommandQueue.h:27 — Queue API + Layout
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\unit\tasks\CBuildTaskHelper.cpp:61 — ComputeBuildProgressDelta = (1/(BuildTime/buildRate)) * resourceConsumed * 0.1
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\unit\tasks\CBuildTaskHelper.cpp:247 — UpdateWorkProgress (Paused/Silo/Enhancing/Shield/Fuel/Repair/Progress-Bands)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\unit\tasks\CUnitReclaimTask.cpp:141 — QueryReclaimCosts (timeSeconds*10 → Ticks, min 1)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\unit\tasks\CUnitReclaimTask.cpp:191 — AwardReclaimedResources
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\unit\tasks\CUnitReclaimTask.cpp:681 — Reclaim start (health deduction, wreck generation) / :711 Processing / :751 Complete
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\unit\tasks\CUnitCaptureTask.cpp:454 — Capture costs (ticks, rate) / :509 Processing (CaptorCount stacking)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\unit\tasks\CFactoryBuildTask.h:117 — Fields (mBuildHelper, mRallyPointUnit, mBuildCount) + InheritCommandsTo
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\unit\tasks\CUnitMobileBuildTask.cpp:213 — Dtor (cleanup/error path; Execute NOT lifted)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\unit\tasks\CUnitGetBuiltTask.cpp:21 — Execute (bottom task of each unit thread)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\unit\tasks\CUnitRepairTask.cpp:136 — InheritWork (Assist inherits WorkItem)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\unit\core\Unit.cpp:14716 — Unit::SetConsumptionActive (perSecond*0.1; grant refund if deactivated)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\unit\core\Unit.cpp:14358 — Unit::Kill (Wreck-Gating, Stats, mNeedsKillCleanup)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\unit\core\Unit.cpp:14531 — Unit::KillCleanup / :14485 Unit::OnDestroy
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\unit\core\Unit.cpp:14625 — Unit::SetPaused / :14653 SetRepeatQueue
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\unit\core\Unit.cpp:12407 — Unit::CanStartBuilding (construction gate)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\unit\core\Unit.h:1736 — Unit layout: mBeatResourceAccumulators(0x2E8), SharedEconomyRate*(0x2F8), mNeedsKillCleanup(0x524), mConsumptionData(0x534), ResourceConsumed(0x53C)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\unit\core\UnitAttributes.h:33 — buildRate(0x58), consumptionPerSecond*(0x48/0x4C), productionPerSecond*(0x50/0x54), regenRate(0x5C)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\entity\Entity.cpp:3824 — Entity::UpdateFractionComplete (Health-Floor)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\entity\Entity.cpp:4522 — Entity::AdvanceCoords (Double-Buffer-Transform-Commit)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\entity\Prop.cpp:501 — Prop::Materialize (Reclaim-Fraction, OnReclaimed)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\CFormation.h:12 — CFormation-Layout (Slots, Direction, TravelFormation)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\SimDriver.cpp — CSimDriver::ExecuteDispatchStepLocked (simRate = 1000/ms * 0.1)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\unit\CUnitMotion.cpp:2466 — CUnitMotion::ProcessFuelLevels (Air Staging Repair with own CEconRequest)
- lua.scd → lua/game.lua:11 — Game.VeteranDefault {25,100,250,500,1000}
- lua.scd → lua/game.lua:24 — Game.GetConstructEconomyModel (time/rate, energy, mass)
- lua.scd → lua/sim/Unit.lua:124 — Unit:OnCreate
- lua.scd → lua/sim/Unit.lua:690 — Unit:UpdateConsumptionValues ​​(the central drain formula)
- lua.scd → lua/sim/Unit.lua:755 — Unit:UpdateProductionValues
- lua.scd → lua/sim/Unit.lua:896 — Unit:OnKilled / :1200 DeathThread / :1244 OnDestroy
- lua.scd → lua/sim/Unit.lua:1076 — Unit:CreateWreckage / :1090 CreateWreckageProp (wreck formulas)
- lua.scd → lua/sim/Unit.lua:1528 — Unit:OnStopBeingBuilt
- lua.scd → lua/sim/Unit.lua:2689 GetBuildCosts / :2699 GetReclaimCosts / :2723 GetRebuildBonus (0.5) / :2734 GetCaptureCosts
- lua.scd → lua/sim/Unit.lua:3084-3242 — AddKills / CheckVeteranLevel / SetVeteranLevel / CreateVeterancyBuff
- lua.scd → lua/sim/Unit.lua:397 OnPaused / :402 OnUnpaused / :660 OnProductionPaused
- lua.scd → lua/sim/Prop.lua:153 — Prop:GetReclaimCosts / :116 SetReclaimValues / :123 SetMaxReclaimValues
- lua.scd → lua/sim/BuffDefinitions.lua:15-157 — VeterancyHealth1-5 (Mult 1.1-1.5), VeterancyRegen1-5 (Add 2-10)
- lua.scd → lua/sim/Buff.lua:206 (MaxHealth-Anwendung) + BuffCalculate ((val+adds)*mults)
- lua.scd → lua/defaultunits.lua:422-689 — FactoryUnit (OnStartBuild, FinishBuildThread, RollOffUnit, CalculateRollOffPoint, BuildingState/RollingOffState/IdleState)
- lua.scd → lua/ui/game/economy.lua:253-300 — simFrequency = GetSimTicksPerSecond(); all rates are per tick
- units.scd → units/UEL0201/UEL0201_unit.bp — Economy{BuildCostEnergy=266,BuildCostMass=56,BuildTime=280}, Veteran{3,6,9,12,15}, Wreckage{MassMult=0.9,HealthMult=0.9}
- units.scd → units/UEB0101/UEB0101_unit.bp — Economy{BuildRate=20,BuildTime=300,StorageMass=80}
- units.scd → units/UEL0001/UEL0001_unit.bp — ACU: BuildRate=10, StorageEnergy=4000, StorageMass=650, Enhancements with NewBuildRate
- units.scd → units/UEL0105/UEL0105_unit.bp — T1 Engineer: BuildRate=5, MaxBuildDistance=5
