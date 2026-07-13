# agent9

## Summary
Der Sim-Kern läuft mit fest verdrahteten 10 Ticks/s. `Sim::AdvanceBeat` ist die eine Tick-Funktion: Sie leert die Unit-Ressourcen-Akkus, tickt alle Armeen (inkl. Navigator-/Steering-Task-Stages), dann die globalen Task-Stages (Befehle→Tasks), Recon, Effekte, Kill-Cleanup und commitet zuletzt alle Entity-Transforms (double-buffered). Befehle werden nicht direkt ausgeführt: `IAiCommandDispatchImpl` sitzt als Dauer-Task auf `mTaskStageA`, liest den Queue-Kopf und pusht einen konkreten `CCommandTask` (Move/Build/Reclaim/...) auf den Task-Stack; der Rückgabewert von `Execute()` steuert das Scheduling. Die Wirtschaft ist ein Request/Grant-System: jeder Verbraucher hängt eine `CEconRequest` (requested pro Tick) in eine Intrusive-Liste der Armee-Ökonomie, die Engine trägt `mGranted` ein, und Konsumenten nutzen entweder die Ratio (`LimitingRate()` → Bau/Reparatur) oder warten auf volle Deckung (Capture/Teleport/Silo). Drei zentrale Routinen sind im Decomp NICHT geliftet (Econ-Verteilung, `DispatchQueuedCommand`-Switch, Build-Task-State-Machines) — die Formeln dafür sind aber aus Lua + den Aufrufern eindeutig rekonstruierbar.

## Key Facts
- Tickrate ist fix 10 Hz: cfunc_GetSimTicksPerSecondL pusht hart 10.0; CEconomyEvent rechnet durationSeconds*10; CSimDriver schätzt simRate = (1000/medianDispatchMs)*0.1.
- Beat != Tick: mCurBeat läuft immer (Netz/Dispatch, Checksum-Periode), mCurTick nur wenn nicht pausiert und nicht GameOver (Sim.cpp:12001).
- Tick-Reihenfolge: ClearBeatResourceAccumulators (alle Units) → pro Armee OnTick (Eco-Cache, Stats, AI-Stages=Navigator/Steering) → TaskStageA (Befehls-Dispatch + alle Unit-Tasks) → DiskWatcher → TaskStageB → Blips → Recon → Effekte → FormationDB → KillCleanup → AdvanceCoords (Transform-Commit) → Deletion-Queue → Checksum.
- Task-Scheduler-Protokoll (RunThreadUserFrameStep): Execute() liefert -4=Thread ans Listenende, -3=Thread abbrechen, -2=Thread parken (Stage), -1=Task fertig/poppen und Parent sofort weiter, 0=sofort nochmal, 1=1 Tick warten, N>1=N-1 Ticks warten.
- Befehle werden nie direkt ausgeführt: IAiCommandDispatchImpl (Dauer-Task auf mTaskStageA) nimmt den Queue-Kopf und pusht per DispatchQueuedCommand einen CCommandTask auf den Task-Stack des Unit-Threads.
- Queue-Semantik: mCount>1 → dekrementieren, Kopf bleibt; Patrol/FormPatrol → Kopf ans Ende rotieren (Ringqueue); Repeat-Queue nur für BuildFactory (Count=MaxCount, rotieren); Fehler (AiResult=2) → Patrol rotieren, sonst Kopf entfernen.
- Bau-Drain (Lua Unit.lua:690-753 + game.lua:24): time = BuildTime/buildRate (nach BuildTimeModifier, min 0.1s); energy/mass = BuildCost* * (100+Modifier)/100 * BuildAdjMod, jeweils min 1; energy_rate = energy/time [pro Sekunde]. Engine: request_pro_Tick = consumptionPerSecond * 0.1 (Unit.cpp:14722).
- Baufortschritt pro Tick = (buildRate / BuildTime) * 0.1 * ResourceConsumed (CBuildTaskHelper.cpp:61-87) — d.h. volle Versorgung ⇒ Bauzeit = BuildTime/buildRate Sekunden.
- Assist-Stacking ist rein additiv: jeder Helfer hat eigenen CBuildTaskHelper, eigene CEconRequest und ruft pro Tick focus->Materialize(delta_i) — die Deltas summieren sich, effektive BuildRate = Σ buildRate_i.
- Reclaim: Ticks = max(BuildCostEnergy, BuildCostMass)/buildRate (Unit) bzw. max(MassReclaim*mult, EnergyReclaim*mult)/buildRate (Prop); Gutschrift = reclaimPerSecond * (appliedFractionDelta / reclaimRate) direkt in economy->mResources und mTotals.mReclaimed.
- Capture: Ticks = max(1, ((BuildTime/buildRate)/2 * CaptureTimeMultiplier) * 10); Kosten = BuildCostEnergy des Ziels, Mass = 0; Fortschritt pro Tick += target->CaptorCount (nur wenn granted >= rate) ⇒ N Captors ⇒ N-fach schneller.
- Veterancy ist KILL-ZAHL-basiert (nicht Masse): Schwellen aus bp.Veteran.Level1..5, sonst Game.VeteranDefault = {25,100,250,500,1000}; Buffs: MaxHealth Mult 1.1/1.2/1.3/1.4/1.5 (REPLACE, immer aus bp-Basiswert neu berechnet), Regen Add +2/+4/+6/+8/+10.
- Storage: pro Unit ein CEconStorage(mAmt={StorageEnergy,StorageMass}) → Chng(+1) addiert (int64!)amount auf mTotals.mMaxStorage, Chng(-1) beim Zerstören. mMaxStorage ist uint64, keine Floats.
- Alle Raten in SEconTotals (mIncome, mLastUseRequested, mLastUseActual, mReclaimed) sind PRO TICK; die UI multipliziert mit GetSimTicksPerSecond()=10 für die Anzeige. mStored/mMaxStorage sind absolut.
- Paused: Unit::SetPaused → Lua OnPaused → SetActiveConsumptionInactive → UpdateConsumptionValues (Drain=0); CBuildTaskHelper ruft dann focus->Materialize(0.0f) — Fortschritt eingefroren, Fokus bleibt erhalten.
- LÜCKEN im Decomp: (1) die Econ-Verteilungsroutine (Income-Sammlung + mGranted-Vergabe + Unit::ResourceConsumed + Overflow) fehlt komplett, (2) DispatchQueuedCommand (FUN_00608EF0, der grosse Command→Task-Switch) ist ein leerer Stub, (3) CFactoryBuildTask::Execute / CUnitMobileBuildTask::Execute / Unit::Materialize / Sim::CreateUnit-Ctor sind nicht geliftet.

## Details
## 1. Sim-Tick: Reihenfolge, Tickrate, Beat-Semantik

### Tickrate
**Fix 10 Hz, nicht konfigurierbar.** Belege:
- `Sim.cpp:18260` `cfunc_GetSimTicksPerSecondL` pusht konstant `10.0`.
- `CEconomyEvent.cpp:1134` `mRemainingTicks = durationSeconds * 10.0f`.
- `Unit.cpp:14722` `newConsumption.energy = consumptionPerSecondEnergy * 0.1f`.
- `SimDriver.cpp` (ExecuteDispatchStepLocked): `simRateEstimate = (1000.0f / medianDispatchMs) * 0.1f` → 100 ms/Beat = Rate 1.0.

Die "Game Speed" (+/-) skaliert nur die *Wall-Clock-Rate der Beats*, nie die Tick-Semantik. Alle Sim-Formeln sind deterministisch pro Tick.

### Beat vs. Tick
- `mCurBeat` (Sim.h:1111): Netzwerk-/Dispatch-Schritt. Läuft **immer**, auch bei Pause. Steuert Checksum-Periode (`mCurBeat % checksumPeriod`), Desync-Logs, den 128-Einträge-Checksum-Ring.
- `mCurTick` (Sim.h:1115): Simulationsschritt. Wird **nur** inkrementiert wenn `!mGameOver && (mPausedByCommandSource == -1 || mSingleStep)` (Sim.cpp:12001-12002).
- `mDidProcess` (+0x08FC): Latch, in `AdvanceBeat` gesetzt, in `Sim::Sync` gelöscht.

Für einen TS-Nachbau: Ein Beat = ein Aufruf von `advanceBeat()`; darin optional ein Tick. Pause = Beats laufen, Ticks nicht.

### Exakte Tick-Reihenfolge (`Sim::AdvanceBeat`, Sim.cpp:11990–12098)

**Immer (auch pausiert):**
1. `Logf("beat %u")`, `RulesUpdateLuaState(mRules, mLuaState)`

**Nur wenn Tick läuft:**
2. `++mCurTick`
3. Optional Hintergrund-Pathfinding (`UpdatePaths`, ConVar-Budget)
4. **`ForEachAllArmyUnit` → `unit->ClearBeatResourceAccumulators()`** (alle lebenden Units; nullt `mBeatResourceAccumulators`)
5. **Für jede Armee: `CArmyImpl::OnTick()`** (CArmyImpl.cpp:1736)
   - `Stats->mItem->ClearChildren(1)`; `NoRushTicks--`
   - `SetCanSee(focusArmy)`
   - `CleanUpPlatoons()`
   - **`ProcessArmyEconomyTick(*this)`** ← *nur Cache-Kopie* von `SEconTotals` in die Army-Felder (EnergyCurrent, IncomeEnergy10x, …). **Keine Berechnung!**
   - `Stats->Update()` (ab Tick > 10)
   - `InfluenceMap->Update()` — gestaffelt: nur wenn `ArmyId == mCurTick % 30`
   - UnitCap-Stats setzen
   - **`AiBrain->mAiThreadStage->UserFrame()`** ← Navigator-Tasks (Bewegung/Pfad)
   - **`AiBrain->mAttackerThreadStage->UserFrame()`** ← Steering-Tasks
   - `AiBrain->mReservedThreadStage->UserFrame()`
   - `ProcessArmyPathQueueBudget(PathFinder, budget=2500)`
6. **`TickTaskStage(&mTaskStageA)`** ← **hier laufen alle Unit-Befehls-Tasks** (IAiCommandDispatchImpl + Build/Reclaim/Capture/Move/Attack…)
7. `TickTaskStage(&mDiskWatcherTaskStage)`
8. `TickTaskStage(&mTaskStageB)`
9. `RefreshBlips()`
10. **Recon**: Round-Robin — genau eine Armee pro Tick macht `reconDb->ReconTick(armyCount)`, alle anderen `ReconRefresh()` (Index = `mCurTick % armyCount`)
11. `TickEffectManager(mEffectManager)`
12. `UpdateFormationDb(mFormationDB)`
13. **`ForEachAllArmyUnit` → wenn `NeedsKillCleanup()` → `KillCleanup()`**
14. *(fehlende Sync-Filter-Packing-Pass — im Decomp als TODO markiert)*
15. **`for (entity : mCoordEntities) AdvanceCoords(entity)`** ← **Transform-Commit** (siehe unten)
16. Debug-Canvas-Swap; `mAdvancedThisTick = true`; `mSingleStep = false`

**Immer (auch pausiert):**
17. Deletion-Queue leeren (`RunQueuedDestroy`)
18. `PurgeDestroyedEffects`, `CleanupDecals`
19. Checksum wenn `mCurBeat % checksumPeriod == 0`
20. Debug-Overlays ticken
21. Lua-GC alle 70 Ticks (`lua_setgcthreshold(L, 0)`)

### AdvanceCoords = Double-Buffered Transform (Entity.cpp:4522)
```
prev  <- current
current <- pending
mVelocityScale <- mPendingVelocityScale
→ Positions-History, Collision-Update (nur bei Änderung), Intel-ForceUpdate
```
**Wichtig für TS:** Bewegungs-/Physik-Code schreibt während des Ticks in `PendingPosition`/`PendingOrientation`. Erst `AdvanceCoords` am Tick-Ende macht daraus die sichtbare Position. `Position`/`Orientation` sind während des Ticks der Stand vom Tick-Anfang. Nur Entities in der `mCoordEntities`-Intrusive-Liste werden verarbeitet (Entities linken sich selbst ein wenn sie sich bewegen und aus, wenn Pos+Orient unverändert → Perf-Optimierung).

### Was NICHT im Tick steht
Es gibt **keinen** expliziten "Waffen-Schritt" und **keinen** expliziten "Economy-Schritt" in `AdvanceBeat`. Waffen laufen als `CAcquireTargetTask`/`CFireWeaponTask` in Task-Stages (via `AttachTaskToStage`, CAiAttackerImpl.cpp:430). Die Economy-Auflösung ist **nicht geliftet** (siehe §4).

---

## 2. Entity/Unit-Lifecycle

### Erzeugen
- `Sim::CreateUnit(const SUnitConstructionParams&, bool doCallback)` (Sim.cpp:9929).
  - **Unit-Cap-Gate zuerst:** wenn `!army->IgnoreUnitCap()` und `army->GetArmyUnitCostTotal() + bp->General.CapCost > army->GetUnitCap()` → `nullptr` + Brain-Callback `"OnUnitCapLimitReached"`.
  - **Der Unit-Konstruktor (0x006A53F0) ist NICHT geliftet.**
- `SUnitConstructionParams` (SUnitConstructionParams.h): `{ army, blueprint, transform, useLayerOverride, fixElevation, layer, linkSourceUnit, complete }`. `complete=true` ⇒ Unit startet fertig (FractionCompleted=1), sonst als Baustelle.
- Lua `Unit:OnCreate` (Unit.lua:124): setzt Maintenance-Consumption/Production aus Blueprint, Vision-Radius, `VeteranLevel=0`, `MaintenanceConsumption=false`, `ActiveConsumption=false`, `Dead=false`, Effekt-Bags.

### Bauen / Fertigwerden
- Fortschritt läuft über `Entity::FractionCompleted` (Offset 0xD8).
- `Entity::UpdateFractionComplete(delta)` (Entity.cpp:3824): clamped auf [0,1]; bei positivem Delta zusätzlich Untergrenze `Health/MaxHealth` (Health "hält" den Fortschritt).
- `Unit::Materialize(float)` ist **nicht geliftet** (nur `Entity::Materialize` → 0, und `Prop::Materialize` → Reclaim). Es muss: FractionCompleted updaten, Health = MaxHealth * fraction skalieren, bei 0→>0 `OnStartBeingBuilt`, bei ==1 `OnStopBeingBuilt` feuern, und vermutlich `mConsumptionData->mGranted` konsumieren.
- `Unit::IsBeingBuilt()` (Unit.cpp:12619).
- **OnStopBeingBuilt** (Lua Unit.lua:1528): SetupIntel, StopBeingBuiltEffects, Rocking bei Water, LifeTime-Thread, Sounds, `DisallowCollisions=false` (+ Health vom Builder-Prozentsatz übernehmen bei Upgrades!), HideLandBones, Idle-Effekte, **Shield erzeugen** wenn `bp.Defense.Shield.ShieldSize > 0 && StartOn != false`, Perm-Open-Animation, Movement-Effekte/Footfalls initialisieren.
- `CUnitGetBuiltTask::Execute` (CUnitGetBuiltTask.cpp:21): wartet in `TASKSTATE_Preparing` solange `IsBeingBuilt()`; bei Immobil → `-1` (Task weg). Ist der Boden-Task jedes Unit-Task-Threads (wird in `AI_CreateCommandDispatch` direkt nach dem Dispatch gepusht).

### Zerstören
`Unit::Kill(instigator, reason, excessDamageRatio)` (Unit.cpp:14358):
1. Wenn schon tot → return.
2. Lua `CheckCanBeKilled` — wenn false **und** innerhalb Playable-Rect (bzw. kein Commander) → abbrechen.
3. Wenn im Transport: detach, `excessDamageRatio = 10.0f` (⇒ **kein Wrack**).
4. **Wenn `IsBeingBuilt() && WorkProgress < 0.5f` → `excessDamageRatio = 10.0f`** (halbfertige Bauten geben kein Wrack).
5. Lua `SetDead`, `Entity::Kill(...)`, **`mNeedsKillCleanup = true`** (wird im nächsten Tick-Schritt 13 abgearbeitet).
6. Adjacency lösen (`OnNotAdjacentTo` beidseitig), Transport-Insassen detachen, `CommandQueue->ClearCommandQueue()`.
7. Lua `OnKilled(instigator, type, overkillRatio)`.
8. **Stats**: `massValue = bp.Economy.BuildCostMass` (× WorkProgress wenn im Bau), analog Energy → `Units_MassValue_Lost` / beim Gegner `Enemies_MassValue_Destroyed`, `Enemies_Killed`, `Enemies_Commanders_Destroyed`.

`Unit::KillCleanup()` (Unit.cpp:14531) — läuft **verzögert im Tick**: löscht `AiCommandDispatch`, `AiAttacker`, `AiTransport`, `AiNavigator`, `AiSteering`, `AiBuilder`, `AiSiloBuild` und die `CommandQueue`. Reihenfolge ist wichtig: erst `AiAttacker->WeaponsOnDestroy()`, dann Dispatch löschen (räumt den Task-Stack ab), dann der Rest.

`Unit::OnDestroy()` (Unit.cpp:14485) → finales Entfernen. Lua `OnDestroy` (Unit.lua:1244): Sync-Daten löschen, bei Factory das im Bau befindliche Unit zerstören, Trash entleeren, `RemoveEconomyEvent` (Teleport-Drain), `ChangeState(self, self.DeadState)`.

### Todes-Sequenz (Lua)
`OnKilled` → `ForkThread(DeathThread, overkillRatio, instigator)` (Unit.lua:1200):
`WaitSeconds(random(DestructionExplosionWaitDelayMin..Max))` → Destruction-Effekte → ggf. Death-Animation abwarten → **`CreateWreckage(overkillRatio)`** → Debris → `WaitSeconds(DeathThreadDestructionWaitTime)` → `Destroy()`.

### Wrack (Unit.lua:1076 `CreateWreckage`, 1090 `CreateWreckageProp`)
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
prop.AssociatedBP = bp.BlueprintId               -- für Rebuild-Bonus
```

---

## 3. Befehls-/Task-System

### Schichten
```
CTaskStage  (mTaskStageA / mDiskWatcherTaskStage / mTaskStageB / AiBrain-Stages)
  └─ TDatList<CTaskThread>   (mThreads = aktiv, mStagedThreads = geparkt)
       └─ CTaskThread { mTaskTop, mPendingFrames, mStaged }
            └─ CTask*-Stack via mSubtask  (Top = aktueller Task)
```
Pro Unit gibt es **einen** `CTaskThread` auf `mTaskStageA`, dessen Boden-Task der `IAiCommandDispatchImpl` ist (IAiCommandDispatchImpl.cpp:446), darüber der `CUnitGetBuiltTask`, darüber der jeweils aktive Befehls-Task.

### Scheduler (`CTaskStage::UserFrame`, CTaskThread.cpp:775 + `RunThreadUserFrameStep`, CTaskThread.cpp:430)
Pro Frame wird die Thread-Liste durchlaufen (mit Umhängen in eine `processed`-Liste, am Ende zurückgemergt — verhindert Endlosschleifen bei Selbst-Requeue).

```
if (--mPendingFrames > 0) return 0;          // Thread schläft noch
loop {
  task = thread->mTaskTop;  if (!task) return -1;      // Thread leer → löschen
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
Ein neuer Task wird einfach durch `new CSomeTask(parentTask)` erzeugt — der `CTask`-Ctor (CTask.cpp:407) pusht sich selbst auf `thread->mTaskTop`. Der `CTask`-Dtor (CTask.cpp:375) poppt sich sauber aus der Kette.

`CTask::TaskInterruptSubtasks()` (CTask.cpp:426): löscht alle Tasks **über** `this` im Stack.
`CTask::TaskResume(recursiveInterrupt, pendingFrames)` (CTask.cpp:454): `mPendingFrames = n; Unstage(); [TaskInterruptSubtasks()]`.

### CCommandTask (Basis aller Unit-Tasks, CCommandTask.h)
Felder: `mUnit`, `mSim`, `mTaskState (ETaskState)`, `mDispatchResult (EAiResult*)`, `mLinkResult (EAiResult)`.
`ETaskState`: `Preparing=0, Waiting=1, Starting=2, Processing=3, Complete=4, 5..8`.
Der Child-Ctor `CCommandTask(CCommandTask* parent)` erbt Thread/Unit/Sim und **verkettet `mDispatchResult` auf `&parent->mLinkResult`** — so meldet ein Subtask sein Ergebnis nach oben.
`EAiResult`: 0 = laufend/ok, 1 = erfolgreich/gestoppt, 2 = Fehler/Retarget.

### Command-Queue (`CUnitCommandQueue`, CUnitCommandQueue.h)
`msvc8::vector<WeakPtr<CUnitCommand>> mCommandVec` + `mCommandType` (Familie des Kopfes) + `mNeedsRefresh`. Ist ein `Broadcaster<EUnitCommandQueueStatus>`.
API: `GetCurrentCommand/GetNextCommand/GetLastCommand/GetCommandInQueue(i)`, `InsertCommandToQueue(cmd,i)`, `AddCommandToQueue`, `RemoveFirstCommandFromQueue`, `MoveFirstCommandToBackOfQueue`, `MoveCommandToBackOfQueue`, `SetCommandCount(i,n)`, `SetCommandTarget(i,ent)`, `ClearCommandQueue`, `AbortActiveTask`.

**`AddCommandToQueue`** (CUnitCommandQueue.cpp:446) — Sonderfall Patrol:
Wenn der neue Befehl Patrol/FormPatrol ist **und** der Queue-Kopf ebenfalls Patrol/FormPatrol ist und `size > 1`, wird **vor** dem Element mit der kleinsten `mInstanceSerial` eingefügt (sonst ans Ende). Damit bleibt die Patrouillen-Schleife in der ursprünglichen Reihenfolge geschlossen.

### Command → Task: der Dispatcher (`IAiCommandDispatchImpl::TaskTick`, IAiCommandDispatchImpl.cpp:589)
```
tryDispatchHead():
  if (!unit || !queue) return 1                      // 1 Tick warten
  if (unit->IsBeingBuilt() || IsDead()
      || IsUnitState(Attached) || IsUnitState(BlockCommandQueue)) return 1
  if (queue->Finished()) return 1
  cmd = queue->GetCurrentCommand();  if (!cmd) return 1
  mState = 1; mLinkResult = 0;
  DispatchQueuedCommand(this, cmd)                   // pusht den konkreten Task
  return 0                                            // sofort weiter → Subtask läuft noch diesen Tick

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
  if (cmd->mVarDat.mCount > 1) {                      // Fabrik-Stückzahl
      cmd->mVarDat.mCount--; cmd->mNeedsUpdate = true
      return tryDispatchHead()
  }
  if (unit->RepeatQueueEnabled && cmd->type == BuildFactory) {   // Repeat NUR für Fabrik-Bau
      cmd->mVarDat.mCount = cmd->mVarDat.mMaxCount; cmd->mNeedsUpdate = true
      queue->MoveFirstCommandToBackOfQueue()
      return 1
  }
  if (cmd->type == Attack) {
      if (cmd->mTarget.targetType != AITARGET_Ground) { queue->RemoveFirstCommandFromQueue(); return tryDispatchHead() }
      // Ground-Attack (Attack-Move-Punkt) fällt durch → wie Patrol behandelt
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
- Alles zwischen `UCQS_Changed` (exkl.) und `UCQS_NeedsRefresh` (inkl.) → `mPendingFrames=0`, `Unstage()`, **`TaskInterruptSubtasks()`** (aktueller Task wird sofort abgebrochen), `mState = 0`.
Das ist der Mechanismus für "neuer Befehl überschreibt laufenden Befehl".

**⚠ `DispatchQueuedCommand` (FUN_00608EF0) ist im Decomp ein leerer Stub** (IAiCommandDispatchImpl.cpp:398). Der Befehls→Task-Switch muss aus den Task-Klassen rekonstruiert werden.

### EUnitCommandType (SSTICommandIssueData.h:19-58) — vollständig
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

### Task-Klassen (moho/unit/tasks/, jeweils `CCommandTask`-Ableitungen)
`CUnitMoveTask`, `CUnitFormAndMoveTask`, `CUnitAttackTargetTask`, `CUnitMeleeAttackTargetTask`, `CUnitFireAtTask`, `CAcquireTargetTask`, `CFireWeaponTask`, `CUnitPatrolTask`, `CUnitGuardTask`, `CUnitAssistMoveTask`, `CUnitMobileBuildTask`, `CFactoryBuildTask`, `CUnitRepairTask`, `CUnitReclaimTask`, `CUnitCaptureTask`, `CUnitUpgradeTask`, `CUnitSacrificeTask`, `CUnitFerryTask`, `CUnitWaitForFerryTask`, `CUnitLoadUnits`, `CUnitUnloadUnits`, `CUnitCallTransport`, `CUnitCallLandTransport`, `CUnitCallAirStagingPlatform`, `CUnitCallTeleport`, `CUnitCarrierLand/Launch/Retrieve`, `CUnitRefuel`, `CUnitPodAssist`, `CUnitGetBuiltTask`.

Direkt am Dispatcher (nicht über den Switch) hängen: `IssueReclaimTask(CAiTarget)`, `IssueCarrierLandTask`, `IssueCallTeleportTask`, `IssueCallAirStagingPlatformTask`, `IssueCallLandTransportTask`, `IssueRefuelTask`, plus `Stop()` und `KillSelf()` (→ `unit->Kill(unit, "Damage", 0.0f)`).

### Formation
`CFormation` (CFormation.h) hält pro Befehl: `mStart`, `mFinish`, `mMousePos`, `mDirection{X,Y,Z,W}`, `mDirectionScale`, `mType`, `mBestFormation`, `mTravelFormation`, `mNumFormationScripts`, `mTimeLeft`, `mLastUpdate`, `mCurInstance (IFormationInstance*)` und einen RB-Baum von Slot-Nodes.
Form-Befehle (`FormMove`, `FormAttack`, `FormPatrol`, `FormAggressiveMove`) teilen sich **eine** `CFormation`-Instanz pro Befehl; jede Unit bekommt einen Slot. `CUnitCommand::FormRemoveUnit(unit, cmd)` (im Dispatcher aufgerufen) entfernt die Unit aus der Formation, wenn der Befehl rotiert wird. Der Formation-DB wird pro Tick über `UpdateFormationDb(mFormationDB)` aktualisiert (Sim.cpp:12052). Die konkreten Slot-Layouts kommen aus Lua-Formation-Skripten (`mNumFormationScripts`).

---

## 4. Wirtschaft im Detail

### Datenstrukturen
**Wichtig:** `CEconomy` (CEconomy.h) und `CSimArmyEconomyInfo` (CSimArmyEconomyInfo.h) haben **identisches Layout** — es ist dasselbe Objekt, zwei Views:
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
+0x00 TDatListItem mNode        // in economy->registrationNode eingehängt
+0x08 SEconValue mRequested     // PRO TICK
+0x10 SEconValue mGranted       // PRO TICK zugeteilt (akkumulierender Pool!)

float LimitingRate() const {    // CEconomyEvent.cpp:1096
  r = 1.0
  if (requested.energy > 0) r = min(r, granted.energy / requested.energy)
  if (requested.mass   > 0) r = min(r, granted.mass   / requested.mass)
  return r
}
```

Jede Unit hat genau eine eigene Request: `Unit::mConsumptionData` (Unit.h:1768). Zusätzlich können Tasks eigene Requests anlegen (Capture, Refuel-Repair, Silo, CEconomyEvent/Teleport).

### Verbrauchs-Registrierung (`Unit::SetConsumptionActive`, Unit.cpp:14716)
```cpp
newConsumption.energy = Attributes.consumptionPerSecondEnergy * 0.1f;   // → PRO TICK
newConsumption.mass   = Attributes.consumptionPerSecondMass   * 0.1f;

if (!mConsumptionData) { neue CEconRequest, in economyInfo->registrationNode einhängen }

if (!ConsumptionActive) {
    // RÜCKERSTATTUNG nicht verbrauchter, angesammelter Grants an den Speicher:
    economyInfo->economy.mStored.ENERGY += mConsumptionData->mGranted.energy;
    economyInfo->economy.mStored.MASS   += mConsumptionData->mGranted.mass;
    newConsumption = {0,0};
}
mConsumptionData->mRequested = newConsumption;
SharedEconomyRateEnergy/Mass = newConsumption;
→ Lua-Callback "OnConsumptionActive" / "OnConsumptionInActive"
```
**Diese Rückerstattung ist der harte Beweis, dass `mGranted` ein akkumulierender Pool ist** (kein Per-Tick-Overwrite).

### Die Drain-Formeln (Lua — hier liegt die ganze Logik!)

**`Game.GetConstructEconomyModel(builder, targetData)`** (lua/game.lua:24):
```lua
rate = builder:GetBuildRate()                  -- = UnitAttributes.buildRate
time   = targetData.BuildTime * (100 + builder.BuildTimeModifier or 0) * 0.01;  if time < 0.1 then time = 0.1
energy = targetData.BuildCostEnergy * (100 + builder.EnergyModifier or 0) * 0.01;  if energy < 0 then energy = 0
mass   = targetData.BuildCostMass   * (100 + builder.MassModifier   or 0) * 0.01;  if mass   < 0 then mass   = 0
return time/rate, energy, mass          -- ← time/rate ist SEKUNDEN
```
`targetData` = `bp.Economy` einer Unit **oder** eine `Enhancement`-Section (gleiche Feldnamen).

**`Unit:UpdateConsumptionValues()`** (lua/sim/Unit.lua:690) — wird bei *jeder* Änderung gerufen (Baustart/-ende, Toggle, Buff, Pause):
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
**Pro Tick** (Engine): `× 0.1`.

**`Unit:UpdateProductionValues()`** (Unit.lua:755):
```lua
SetProductionPerSecondEnergy(bp.Economy.ProductionPerSecondEnergy * (self.EnergyProdAdjMod or 1))
SetProductionPerSecondMass  (bp.Economy.ProductionPerSecondMass   * (self.MassProdAdjMod   or 1))
```
(Die AdjMods sind die Adjacency-Boni, siehe lua/sim/AdjacencyBuffs.lua.)

### Baufortschritt (`CBuildTaskHelper::UpdateWorkProgress`, CBuildTaskHelper.cpp:247)
```cpp
// ComputeBuildProgressDelta (CBuildTaskHelper.cpp:61):
timeToBuild = blueprint->Economy.BuildTime / builderAttributes.buildRate;   // Sekunden
delta = (1.0f / timeToBuild) * resourceConsumed * 0.1f;                     // 0.1 = 1 Tick
// == (buildRate / BuildTime) * 0.1 * resourceConsumed
```
mit `resourceConsumed = Unit::ResourceConsumed` (Unit.h:1772, Offset 0x53C) = die **Erfüllungs-Ratio** der Unit-Request (0..1). Bei voller Versorgung dauert der Bau exakt `BuildTime / buildRate` Sekunden.

Weiterer Ablauf in `UpdateWorkProgress`:
- **Paused** (`ownerUnit->IsPaused`): `WorkProgress = focus->FractionCompleted`, dann `focus->Materialize(0.0f)` → Fortschritt eingefroren, Fokus/Task bleiben. Return true (fertig) nur wenn nicht Repairing und Fraction ≥ 1.
- **Silo-Modus** (`mIsSilo`): `perSecond = ownerUnit->mConsumptionData->mRequested * resourceConsumed` → `focus->AiSiloBuild->SiloAssistWithResource(perSecond)`.
- **Enhancing** (`focus->IsUnitState(UNITSTATE_Enhancing)`): `tickDelta = (1/(WorkItemBuildTime/buildRate)) * resourceConsumed * 0.1`; `focus:SetLuaValue("WorkProgress", min(1, prog + tickDelta))`.
- **Shield-Assist** (`focus->IsInCategory("SHIELD")`): `shield->AdjustHealth(null, (shieldRegenRate*0.1 * buildRate) / RegenAssistMult)`; wenn das Shield-Unit selbst beschädigt ist: `RegenAssistMult *= 2` **und** `buildProgressDelta *= 0.5` (Reparatur und Shield-Laden teilen sich die Leistung).
- **Fuel-Assist** (`FuelUseTime > 0 && FuelRatio < 1`): `fuelTickDelta = (FuelRechargeRate/FuelUseTime) * 0.1`; wenn beschädigt: `fuelTickDelta *= 0.5` und `buildProgressDelta *= 0.5`.
- Dann `focus->Materialize(resourceConsumed != 0 ? buildProgressDelta : 0)`.
- **Repair-Action** (`mActionName == "Repair"` und Ziel nicht mehr im Bau): `WorkProgress = focus->Health / focus->MaxHealth`; fertig wenn 1.0 (+ Fuel==1 bzw. Shield voll).
- **Progress-Callbacks**: bei Überschreiten von 0.25 / 0.5 / 0.75 → `OnBuildProgress` (Builder) + `OnBeingBuiltProgress` (Ziel).

### Assist-Stacking
**Additiv, ohne Sonderlogik.** Jeder Helfer:
- hat einen **eigenen** `CUnitRepairTask`/`CUnitMobileBuildTask` mit **eigenem** `CBuildTaskHelper` und **eigener** `Unit::mConsumptionData`,
- berechnet seinen Drain aus **seiner** `buildRate` (`GetConstructEconomyModel(self, focusBP)`),
- ruft pro Tick `focus->Materialize(delta_i)` mit **seinem** `delta_i = buildRate_i / BuildTime * 0.1 * ratio_i`.

⇒ Effektive Baurate = `Σ buildRate_i`, effektiver Drain = `Σ (BuildCost * buildRate_i / BuildTime)`. Kosten pro Fortschrittseinheit bleiben konstant.
Assistierende Engineers erben das WorkItem des Ziels: `CUnitRepairTask.cpp:136` ruft Lua `InheritWork`; `Unit.lua:1680` in `OnStartBuild`: `if order == 'Repair' and unitBeingBuilt.WorkItem != self.WorkItem then self:InheritWork(unitBeingBuilt) end`.

### Reclaim (`CUnitReclaimTask.cpp`)
Kosten (`QueryReclaimCosts`, :141): ruft Lua `GetReclaimCosts(target)` → (timeSeconds, energy, mass); dann
```cpp
reclaimTime = max(1.0f, timeSeconds * 10.0f)     // TICKS
```
**Lua `Unit:GetReclaimCosts`** (Unit.lua:2699, Ziel ist Unit):
```lua
mtime = target_bp.Economy.BuildCostEnergy / self:GetBuildRate()   -- (Namensvertauschung im Original!)
etime = target_bp.Economy.BuildCostMass   / self:GetBuildRate()
time  = max(mtime, etime) * (self.ReclaimTimeMultiplier or 1)
return time/10, target_bp.Economy.BuildCostEnergy, target_bp.Economy.BuildCostMass
```
⇒ **Ticks = max(BuildCostEnergy, BuildCostMass) / buildRate**; Ertrag = 100 % von BuildCostMass **und** BuildCostEnergy.

**Lua `Prop:GetReclaimCosts`** (Prop.lua:153, Ziel ist Wrack):
```lua
mtime = self.ReclaimTimeMassMult   * (self.MassReclaim   / reclaimer:GetBuildRate())
etime = self.ReclaimTimeEnergyMult * (self.EnergyReclaim / reclaimer:GetBuildRate())
time  = max(mtime, etime)
return time/10, self.EnergyReclaim, self.MassReclaim
```

Engine pro Tick (TASKSTATE_Processing/Complete, :711-796):
```cpp
reclaimRate       = 1.0f / reclaimTime;         // Fraction pro Tick
mReclaimRate      = -reclaimRate;
mReclaimPerSecond.energy = max(reclaimEnergy,0) * reclaimRate;   // (tatsächlich PRO TICK)
mReclaimPerSecond.mass   = max(reclaimMass,  0) * reclaimRate;

// jeden Tick:
limitingRate        = mConsumptionData->LimitingRate();
appliedFractionDelta = target->Materialize(mReclaimRate * limitingRate);
// bei Unit-Zielen zusätzlich Health an FractionCompleted koppeln:
clamped = min(target->FractionCompleted, target->Health/target->MaxHealth);
if (target->MaxHealth * clamped != target->Health) target->SetHealth(target->MaxHealth * clamped);
unit->WorkProgress = 1.0f - target->FractionCompleted;

AwardReclaimedResources(unit, appliedFractionDelta, mReclaimRate, mReclaimPerSecond);   // :191
  → multiplier = appliedFractionDelta / reclaimRate
  → economy->mResources.energy      += reclaimPerSecond.energy * multiplier
  → economy->mResources.mass        += reclaimPerSecond.mass   * multiplier
  → economy->mTotals.mReclaimed.*   += dito
```
**Paused-Sonderfall bei Props** (:781): `mReclaimRate = -1e-8f`, `mReclaimPerSecond = {0,0}` → Wrack bleibt "in Arbeit", aber kein Fortschritt/Ertrag.
**Startphase** (TASKSTATE_Starting, :681): Reclaim beginnt mit einem Health-Abzug `MaxHealth/reclaimTime (+ regenRate*0.1)`; ist die Health darunter, wird das Ziel sofort per `RunScriptCreateWreckageProp(0.0f)` + `Destroy()` in ein Wrack verwandelt und das Wrack als neues Ziel gesetzt.
Abbruchbedingung: `contactDistance > bp.Economy.MaxBuildDistance` (bei Patrol: `max(MaxBuildDistance, bp.AI.GuardScanRadius)`).

### Repair
Kein eigener Drain-Pfad: `CUnitRepairTask` hat einen `CBuildTaskHelper` mit `mActionName = "Repair"`. Der Drain kommt aus `UpdateConsumptionValues` (focus vorhanden ⇒ `GetBuildCosts(focus:GetBlueprint())` ⇒ **gleiche Rate wie Neubau**). Der Fortschritt geht über `focus->Materialize(delta)` → `UpdateFractionComplete` → Health folgt der Fraction. Fertig, wenn `Health == MaxHealth` (+ Fuel/Shield voll).

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
// + für JEDE angehängte Entity (Transportinsassen etc.) nochmal dazu
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
⇒ **All-or-nothing pro Tick, aber Grants akkumulieren** ⇒ bei 50 % Versorgung dauert Capture doppelt so lange.
⇒ `+= CaptorCount`: N gleichzeitige Captors ⇒ jeder Task schreitet N-fach voran ⇒ linear schneller.
Abschluss: `OnStopCapture` (Captor), `OnStopBeingCaptured` + `OnCaptured` (Ziel).

### CEconomyEvent (Teleport-Drain, generischer Lua-Drain) — `CEconomyEvent.cpp`
`CreateEconomyEvent(unit, energy, mass, timeInSeconds, [callback])`:
```cpp
mRemainingTicks = max(1, (int)(durationSeconds * 10.0f));  mTotalTicks = mRemainingTicks;
mRequestedPerTick = { energy / mRemainingTicks, mass / mRemainingTicks };
→ eigene CEconRequest in economy->registrationNode
```
`ProcessTick()` (:1241): wenn `granted >= requestedPerTick` → Grants abziehen, `mRemainingTicks--`, Progress-Callback `(1 - remaining/total)`, bei 0 → Request löschen + Event signalisieren.
Dtor löscht die Request und nullt `SharedEconomyRate*`.

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
Jede Unit registriert beim Bau eine `CEconStorage` mit `{bp.Economy.StorageEnergy, bp.Economy.StorageMass}`; beim Zerstören `Chng(-1)`.
`mMaxStorage` ist **uint64 / ganzzahlig** — keine Nachkommastellen.
Cheat-Referenz `Sim::BlingBling` (Sim.cpp:11069) zeigt den Zugriffspfad.

### Paused-Zustand
- `Unit::SetPaused(bool)` (Unit.cpp:14625): nur erlaubt wenn `commandCapsMask & RULEUCC_Pause (0x20000)` oder `toggleCapsMask & RULEUTC_GenericToggle (0x40)`. Setzt `IsPaused`, feuert Lua `OnPaused`/`OnUnpaused`, `MarkNeedsSyncGameData()`.
- Lua `Unit:OnPaused` (Unit.lua:397): `SetActiveConsumptionInactive()` → `UpdateConsumptionValues()` → `energy_rate = 0` (nur noch Maintenance/Min) → `SetConsumptionActive(false)` → **angesammelte Grants werden an `mStored` zurückerstattet**.
- Lua `Unit:OnUnpaused` (:402): nur wenn `IsUnitState('Building'|'Upgrading'|'Repairing')` → `SetActiveConsumptionActive()`.
- `CBuildTaskHelper::UpdateWorkProgress` (:255): bei `IsPaused` → `focus->Materialize(0.0f)`, Fortschritt eingefroren, Task läuft weiter.
- Separat davon: `OnProductionPaused`/`OnProductionUnpaused` (Unit.lua:660) für Toggle-Gebäude → `SetMaintenanceConsumptionInactive` + `SetProductionActive(false)`.

### Build-Gate
`Unit::CanStartBuilding(energyCost, massCost)` (Unit.cpp:12407):
```cpp
if (mStored.ENERGY > 0.001 && mStored.MASS > 0.001) return true;         // Speicher da → immer ok
return (energyCost <= 0 || mIncome.ENERGY >= 0.001)
    && (massCost   <= 0 || mIncome.MASS   >= 0.001);                     // sonst: Einkommen nötig
```

### ⚠ Die Verteilungsroutine fehlt im Decomp
Es gibt **keine** geliftete Funktion, die `mIncome`, `mLastUseRequested`, `mLastUseActual`, `mGranted` oder `Unit::ResourceConsumed` **schreibt**. Aus den Konsumenten lässt sich die Semantik aber eindeutig ableiten:
```
pro Tick, pro Armee:
  1. income   = Σ über alle Units mit ProductionActive: productionPerSecond{E,M} * 0.1
     mTotals.mIncome = income
  2. available = mStored + income + mResources (Reclaim-Puffer)  → mResources danach nullen
  3. requested = Σ über Request-Liste (registrationNode): req->mRequested
     mTotals.mLastUseRequested = requested
  4. ratio_E = clamp(available.E / requested.E, 0, 1)   (analog Mass; requested==0 → ratio 1)
  5. für jede Request:  req->mGranted += req->mRequested * ratio    // AKKUMULIEREND!
     actual = Σ (req->mRequested * ratio)
     mTotals.mLastUseActual = actual
  6. für jede Unit: unit->ResourceConsumed = unit->mConsumptionData->LimitingRate()
  7. mStored = clamp(mStored + income - actual, 0, mMaxStorage)   // Überschuss = OVERFLOW, verfällt
```
**Belege für die Akkumulations-Semantik** (kein Per-Tick-Overwrite):
- `Unit::SetConsumptionActive(false)` erstattet `mGranted` an `mStored` zurück (Unit.cpp:14747) — nur sinnvoll bei einem gehaltenen Pool.
- `TakeGrantedResourcesAndReset()` (CEconomyEvent.cpp:736) existiert und wird von Capture/EconomyEvent/Silo/Staging-Repair benutzt — nur sinnvoll wenn nicht ohnehin jeden Tick überschrieben wird.
- Capture/EconomyEvent gaten auf `granted >= requested` und würden bei Overwrite unter Brownout **nie** vorankommen (falsch), bei Akkumulation kommen sie proportional langsamer voran (korrekt).
**Overflow:** kein Ausgleich zu Verbündeten. `mResourceSharing` (+0x54) ist ein reines Flag; die Sharing-Logik ist ebenfalls nicht geliftet. Überschuss über `mMaxStorage` verfällt (kein Feld dafür vorhanden).

---

## 5. Fabriken

### Bau-Task
`CFactoryBuildTask : CCommandTask` (CFactoryBuildTask.h), Felder:
`mDispatch`, `mBlueprint`, **`mBuildHelper (CBuildTaskHelper)`**, `mRallyPointUnit (WeakPtr<Unit>)`, `mBuildCount`, `mHasCommand`, `mCommand (WeakPtr<CUnitCommand>)`.
`Create(dispatchTask, blueprint, command, rallyPointUnit)`, `InheritCommandsTo(builtUnit)` (überträgt anstehende Befehle von der Fabrik auf die gebaute Unit — so funktionieren Fabrik-Wegpunkte/Befehlsvorgaben).
**`CFactoryBuildTask::Execute` (0x005FA790) ist NICHT geliftet.**

### Queue-Stückzahl
Steckt in `CUnitCommand::mVarDat.mCount` / `mMaxCount`. Der Dispatcher (IAiCommandDispatchImpl.cpp:639) dekrementiert `mCount` pro fertigem Unit; erst bei `mCount == 1` wird der Befehl entfernt. **Repeat-Build** (`unit->RepeatQueueEnabled`, gesetzt via `Unit::SetRepeatQueue`, Unit.cpp:14653 → Lua `OnStartRepeatQueue`/`OnStopRepeatQueue`) ist **ausschließlich** für `UNITCOMMAND_BuildFactory` implementiert: `mCount = mMaxCount`, Befehl ans Queue-Ende rotieren.
UI-seitig: `CUnitCommandQueue::SetCommandCount(index, count)`; Count 0 ⇒ Befehl entfernen.

### Rolloff / Wartepunkte (lua/defaultunits.lua, `FactoryUnit`)
Zustandsmaschine über `ChangeState`:
```
OnStartBuild (:504):
    ChangeBlinkingLights('Yellow'); BuildingUnit = true
    if order != 'Upgrade' → ChangeState(self, self.BuildingState)
    FactoryBuildFailed = false

BuildingState.Main (:663):
    DetachAll(bp.Display.BuildAttachBone)
    unitBeingBuilt:AttachBoneTo(-2, self, bone)     -- Unit hängt am Bau-Bone
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
-- wähle den RollOffPoint, der dem Rally-Point am nächsten liegt:
for k,v in bp: distance = VDist2(vectorObj[1], vectorObj[3], v.X+px, v.Z+pz)
               if distance < lowest → bpKey = k
spin = unitBeingBuilt.bp.Display.ForcedBuildSpin or bp[bpKey].UnitSpin
fx,fy,fz = bp[bpKey].X+px, bp[bpKey].Y+py, bp[bpKey].Z+pz
→ self.MoveCommand = IssueMove({unitBeingBuilt}, Vector(fx,fy,fz))
```
Der Rally-Point (`GetRallyPoint`) bestimmt also **beide**: die Rotator-Ausrichtung während des Baus (`CreateBuildRotator` nutzt `spin`) **und** welcher RollOff-Punkt genommen wird. `mRallyPointUnit` im `CFactoryBuildTask` ist der Rally-Ziel-Träger.

**`SetBlockCommandQueue(true)`** setzt `UNITSTATE_BlockCommandQueue` — der Dispatcher (`tryDispatchHead`) verweigert dann jeden neuen Befehl. So wird verhindert, dass die Fabrik das nächste Unit baut, bevor das aktuelle die Bau-Plattform verlassen hat.

**AIR-Fabriken** rollen nicht ab (`if not EntityCategoryContains(categories.AIR, ...)`), die Einheit fliegt direkt los.
`OnFailedToBuild` (:560): `FactoryBuildFailed = true`, Rotator/Fx weg, `ChangeState(IdleState)`.
`OnKilled` (:683): `self.UnitBeingBuilt:Destroy()`.

---

## 6. Veterancy

**Retail-FA ist KILL-ZAHL-basiert** (nicht massenwert-basiert — das ist eine FAF-Änderung).

**Schwellen** (`lua/game.lua:11`):
```lua
VeteranDefault = { Level1 = 25, Level2 = 100, Level3 = 250, Level4 = 500, Level5 = 1000 }
```
Wird pro Unit vom Blueprint **überschrieben**, z.B. UEL0201 (Medium Tank):
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
- `AddKills(n)` (Unit.lua:3084) für Skript-Kills: setzt die KILLS-Stat und steigt in einer `while`-Schleife ggf. **mehrere** Level auf einmal.
- `SetVeterancy(level)` (Unit.lua:3109): Bequemlichkeits-Setter, geht über `AddKills(threshold)`.

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
`REPLACE` ⇒ Level 3 ersetzt Level 2 (nicht kumulativ), aber der Wert wird **immer aus dem Blueprint-Basiswert neu berechnet**:

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
⇒ Vet-Aufstieg heilt die Unit um den MaxHealth-Zuwachs.
⇒ `regenRate` ist HP/Sekunde; die Engine wendet `regenRate * 0.1` pro Tick an (indirekt belegt in CUnitReclaimTask.cpp:683 und CBuildTaskHelper.cpp:344).
⇒ `CreateVeterancyBuff` mit `buffType == 'Damage'` gibt `false` zurück ⇒ **Schadensboni durch Veterancy sind in Retail-FA deaktiviert** (der Weapon-Buff-Loop ist auskommentiert, Unit.lua:3168-3172).

---

## Referenzwerte aus Blueprints (verifiziert)
| Unit | BuildRate | BuildTime | CostE | CostM | Storage E/M |
|---|---|---|---|---|---|
| UEL0001 (ACU) | 10 | 60000 | 5000000 | 18000 | 4000 / 650 |
| UEL0105 (T1 Engi) | 5 | 260 | 260 | 52 | 0 / 10 |
| UEB0101 (T1 Land Fac) | 20 | 300 | 2100 | 240 | 0 / 80 |
| UEB0301 (T3 Land HQ) | 60 | 8400 | 28350 | 3150 | 0 / 320 |
| UEL0201 (Medium Tank) | – | 280 | 266 | 56 | – |
| UEB1103 (Mass Ext T1) | 10 | 60 | 360 | 36 | ProdM=2, MaintE=2 |
| UEB1101 (Power T1) | – | 125 | 750 | 75 | ProdE=20 |

Probe: T1-Fabrik baut Medium Tank → `280/20 = 14 s`; Drain `266*20/280 = 19 E/s`, `56*20/280 = 4 M/s`. ✔
ACU-Enhancements setzen `NewBuildRate` (z.B. 30 / 90) → `SetBuildRate`.

---

## Kritische Lücken im Decomp (für den Nachbau selbst zu schreiben)
1. **Econ-Verteilung**: keine geliftete Funktion schreibt `mIncome`/`mGranted`/`ResourceConsumed`/`mLastUseActual`. Semantik oben rekonstruiert; der Akkumulations- vs. Overwrite-Punkt ist der einzige echte Freiheitsgrad (Beweislage klar für **Akkumulation**).
2. **`DispatchQueuedCommand` (FUN_00608EF0)** — IAiCommandDispatchImpl.cpp:398 ist ein leerer Stub. Der Command→Task-Switch muss aus der Task-Liste + `EUnitCommandType` gebaut werden.
3. **`CFactoryBuildTask::Execute` (0x005FA790)** und **`CUnitMobileBuildTask::Execute`** — nur Ctor/Dtor/Serialize geliftet. Ableitbar aus `CBuildTaskHelper` + den Dtor-Aufräumpfaden (`UnitStateMask &= ~kUnitStateBuildingMask`, `mBuildHelper.OnStopBuild(true)`, `FreeOgridRect()`, Dispatch-Result 1 bei `TASKSTATE_5`, sonst 2 + Lua `OnFailedToBuild`).
4. **`Unit::Materialize`** (Override fehlt; nur `Entity::Materialize`→0 und `Prop::Materialize` da) und **Unit-Ctor (0x006A53F0)** in `Sim::CreateUnit`.
5. `Sim::AdvanceBeat` fehlt ein Sync-Filter-Packing-Pass (im Decomp als TODO markiert, Sim.cpp:12060) — für einen Nachbau ohne Netcode irrelevant.

## Refs
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\Sim.cpp:11990 — Sim::AdvanceBeat (komplette Tick-Reihenfolge, Zeilen 11990-12098)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\Sim.cpp:18260 — cfunc_GetSimTicksPerSecondL (Tickrate = 10.0 fix)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\Sim.cpp:8411 — Sim::Sync (mDidProcess-Latch)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\Sim.cpp:9929 — Sim::CreateUnit (Unit-Cap-Gate; Ctor NICHT geliftet)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\Sim.cpp:18020 — cfunc_GetEconomyTotalsL (Lua-Shape von SEconTotals)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\Sim.h:1111 — mCurBeat / mCurTick / mTaskStageA,B
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\CArmyImpl.cpp:1736 — CArmyImpl::OnTick (Armee-Tick-Reihenfolge)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\CArmyImpl.cpp:1024 — ProcessArmyEconomyTick (nur Cache-Kopie!)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\CSimArmyEconomyInfo.h — SEconTotals/SEconPair/SEconStoragePair Layout
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\CEconomy.h:76 — CEconomy-Layout (identisch mit CSimArmyEconomyInfo)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\CEconStorage.cpp:374 — CEconStorage::Chng (MaxStorage als int64)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\misc\CEconomyEvent.h:50 — CEconRequest {mNode, mRequested, mGranted}
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\misc\CEconomyEvent.cpp:1096 — CEconRequest::LimitingRate
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\misc\CEconomyEvent.cpp:1241 — CEconomyEvent::ProcessTick (all-or-nothing + TakeGrantedResourcesAndReset)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\misc\CEconomyEvent.cpp:1121 — CEconomyEvent-Ctor (durationSeconds*10 → Ticks)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\task\CTaskThread.cpp:430 — RunThreadUserFrameStep (Task-Return-Code-Protokoll -4..N)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\task\CTaskThread.cpp:775 — CTaskStage::UserFrame
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\task\CTaskThread.cpp:706 — CTaskThread::Stage / :722 Unstage
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\task\CTask.cpp:375 — CTask::~CTask / :407 Ctor (Task-Stack-Push) / :426 TaskInterruptSubtasks / :454 TaskResume
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\task\CTask.h:14 — ETaskState-Enum
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\task\CCommandTask.h:88 — CCommandTask-Felder (mTaskState, mDispatchResult, mLinkResult)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\ai\IAiCommandDispatchImpl.cpp:589 — IAiCommandDispatchImpl::TaskTick (Queue-Semantik: Count/Patrol/Repeat)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\ai\IAiCommandDispatchImpl.cpp:473 — OnEvent (TaskInterruptSubtasks bei Queue-Änderung)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\ai\IAiCommandDispatchImpl.cpp:398 — DispatchQueuedCommand (LEERER STUB — FUN_00608EF0 nicht geliftet)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\ai\IAiCommandDispatchImpl.cpp:415 — AI_CreateCommandDispatch (Dispatch + CUnitGetBuiltTask auf mTaskStageA)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\command\SSTICommandIssueData.h:19 — EUnitCommandType (0..39 vollständig)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\CUnitCommandQueue.cpp:446 — AddCommandToQueue (Patrol-Ringqueue-Einfügung)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\CUnitCommandQueue.h:27 — Queue-API + Layout
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\tasks\CBuildTaskHelper.cpp:61 — ComputeBuildProgressDelta = (1/(BuildTime/buildRate)) * resourceConsumed * 0.1
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\tasks\CBuildTaskHelper.cpp:247 — UpdateWorkProgress (Paused/Silo/Enhancing/Shield/Fuel/Repair/Progress-Bands)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\tasks\CUnitReclaimTask.cpp:141 — QueryReclaimCosts (timeSeconds*10 → Ticks, min 1)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\tasks\CUnitReclaimTask.cpp:191 — AwardReclaimedResources
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\tasks\CUnitReclaimTask.cpp:681 — Reclaim-Start (Health-Abzug, Wrack-Erzeugung) / :711 Processing / :751 Complete
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\tasks\CUnitCaptureTask.cpp:454 — Capture-Kosten (Ticks, Rate) / :509 Processing (CaptorCount-Stacking)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\tasks\CFactoryBuildTask.h:117 — Felder (mBuildHelper, mRallyPointUnit, mBuildCount) + InheritCommandsTo
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\tasks\CUnitMobileBuildTask.cpp:213 — Dtor (Aufräum-/Fehlerpfad; Execute NICHT geliftet)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\tasks\CUnitGetBuiltTask.cpp:21 — Execute (Boden-Task jedes Unit-Threads)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\tasks\CUnitRepairTask.cpp:136 — InheritWork (Assist erbt WorkItem)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\core\Unit.cpp:14716 — Unit::SetConsumptionActive (perSecond*0.1; Grant-Rückerstattung bei Deaktivierung)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\core\Unit.cpp:14358 — Unit::Kill (Wrack-Gating, Stats, mNeedsKillCleanup)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\core\Unit.cpp:14531 — Unit::KillCleanup / :14485 Unit::OnDestroy
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\core\Unit.cpp:14625 — Unit::SetPaused / :14653 SetRepeatQueue
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\core\Unit.cpp:12407 — Unit::CanStartBuilding (Bau-Gate)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\core\Unit.h:1736 — Unit-Layout: mBeatResourceAccumulators(0x2E8), SharedEconomyRate*(0x2F8), mNeedsKillCleanup(0x524), mConsumptionData(0x534), ResourceConsumed(0x53C)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\core\UnitAttributes.h:33 — buildRate(0x58), consumptionPerSecond*(0x48/0x4C), productionPerSecond*(0x50/0x54), regenRate(0x5C)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\entity\Entity.cpp:3824 — Entity::UpdateFractionComplete (Health-Floor)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\entity\Entity.cpp:4522 — Entity::AdvanceCoords (Double-Buffer-Transform-Commit)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\entity\Prop.cpp:501 — Prop::Materialize (Reclaim-Fraction, OnReclaimed)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\CFormation.h:12 — CFormation-Layout (Slots, Direction, TravelFormation)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\SimDriver.cpp — CSimDriver::ExecuteDispatchStepLocked (simRate = 1000/ms * 0.1)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\CUnitMotion.cpp:2466 — CUnitMotion::ProcessFuelLevels (Air-Staging-Repair mit eigener CEconRequest)
- lua.scd → lua/game.lua:11 — Game.VeteranDefault {25,100,250,500,1000}
- lua.scd → lua/game.lua:24 — Game.GetConstructEconomyModel (time/rate, energy, mass)
- lua.scd → lua/sim/Unit.lua:124 — Unit:OnCreate
- lua.scd → lua/sim/Unit.lua:690 — Unit:UpdateConsumptionValues (die zentrale Drain-Formel)
- lua.scd → lua/sim/Unit.lua:755 — Unit:UpdateProductionValues
- lua.scd → lua/sim/Unit.lua:896 — Unit:OnKilled / :1200 DeathThread / :1244 OnDestroy
- lua.scd → lua/sim/Unit.lua:1076 — Unit:CreateWreckage / :1090 CreateWreckageProp (Wrack-Formeln)
- lua.scd → lua/sim/Unit.lua:1528 — Unit:OnStopBeingBuilt
- lua.scd → lua/sim/Unit.lua:2689 GetBuildCosts / :2699 GetReclaimCosts / :2723 GetRebuildBonus (0.5) / :2734 GetCaptureCosts
- lua.scd → lua/sim/Unit.lua:3084-3242 — AddKills / CheckVeteranLevel / SetVeteranLevel / CreateVeterancyBuff
- lua.scd → lua/sim/Unit.lua:397 OnPaused / :402 OnUnpaused / :660 OnProductionPaused
- lua.scd → lua/sim/Prop.lua:153 — Prop:GetReclaimCosts / :116 SetReclaimValues / :123 SetMaxReclaimValues
- lua.scd → lua/sim/BuffDefinitions.lua:15-157 — VeterancyHealth1-5 (Mult 1.1-1.5), VeterancyRegen1-5 (Add 2-10)
- lua.scd → lua/sim/Buff.lua:206 (MaxHealth-Anwendung) + BuffCalculate ((val+adds)*mults)
- lua.scd → lua/defaultunits.lua:422-689 — FactoryUnit (OnStartBuild, FinishBuildThread, RollOffUnit, CalculateRollOffPoint, BuildingState/RollingOffState/IdleState)
- lua.scd → lua/ui/game/economy.lua:253-300 — simFrequency = GetSimTicksPerSecond(); alle Raten sind pro Tick
- units.scd → units/UEL0201/UEL0201_unit.bp — Economy{BuildCostEnergy=266,BuildCostMass=56,BuildTime=280}, Veteran{3,6,9,12,15}, Wreckage{MassMult=0.9,HealthMult=0.9}
- units.scd → units/UEB0101/UEB0101_unit.bp — Economy{BuildRate=20,BuildTime=300,StorageMass=80}
- units.scd → units/UEL0001/UEL0001_unit.bp — ACU: BuildRate=10, StorageEnergy=4000, StorageMass=650, Enhancements mit NewBuildRate
- units.scd → units/UEL0105/UEL0105_unit.bp — T1-Engineer: BuildRate=5, MaxBuildDistance=5
