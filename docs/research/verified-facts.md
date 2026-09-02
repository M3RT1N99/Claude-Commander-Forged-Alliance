# Verified facts — don’t reinvent them

*Outsourced from [CLAUDE.md](../../CLAUDE.md): here is what you bought with a lot of money
Detailed knowledge with evidence. The cross-cutting invariants (blueprint defaults,
class.lua semantics, separate economy switches, wasmoon-null) are still available
in CLAUDE.md. Before working on one of the topics: read the relevant section.*

## Economy (Details: [economy-binary.md](economy-binary.md))

- **Economy is sliding** (like SCFA, not like SC2): two ratios in
  `func_ArmyProcessEconomy` (@0x771B50). Production is unconditional income
  and is **never** linked to the grant ratio.
- **Production and consumption are separate switches** (`SetProductionActive` /
  `SetConsumptionActive`) — never one. Original `OnStopBeingBuilt` is calling
  `SetConsumptionActive(false)`; dies silently on a common flag
  Production of **each finished building**.
- **Unfinished units (`complete = false`) are invisible in the economy** —
  no storage, no production, no maintenance. A construction site is emerging
  `__spawnBuildSite`, not over `__spawnUnit`.
- **Startup resources** do NOT come from a constant. Every ACU forks in
  `OnStopBeingBuilt` your `GiveInitialResources` (`uel0001_script.lua:159`) and
  gives the army its own camp after `WaitTicks(5)`
  (`StorageEnergy = 4000`, `StorageMass = 650`).
- **Bearing** is created exclusively from `Storage*` of the units. The
  `SSTIArmyVariableData`-Ctor (@0x6FD390) startet mit `mStored = 0/0`,
  `mMaxStorage = 0/0`. (An additional “Socket 650/4000” would double the ACU.)

- **The brain economy getters deliver PER-TICK values** — raw field reads
  `CEconomy.mTotals` without scaling (GetEconomyIncome Cfile:739923, Usage =
  mLastUseActual Cfile:739997, Requested = mLastUseRequested Cfile:740071;
  Filling per tick ×0.1 in HandleResourceManagement Cfile:954011-954028).
  The original Lua calculates itself: defaultweapons.lua:970
  `GetEconomyIncome('ENERGY') * 10 # per tick to per seconds`; economy.lua:277
  multiplies the GetEconomyTotals fields with GetSimTicksPerSecond().
  The only ×10 factor in the binary is in the army STATS
  (Economy_Trend_*, Cfile:1107170) — never with the brain getters.
- **Mex stable (implemented):** Production scales with the limiting rate of the
  own consumption if the blueprint is NOT `Economy.NaturalProducer`
  hat (HandleResourceManagement Cfile:953938-953944 + 954011-954012;
  NaturalProducers only have ACUs/sACUs + uea0001/uea0003). The rate is this
  of the PREVIOUS economy tick (mConsumptionData is persistent) — exactly like this
  koppelt ArmyEconomy.tick (UnitEcon.lastRate).

## Construction (Details: [build-task-binary.md](build-task-binary.md))

- **Construction progress:** `delta = buildRate/BuildTime · ResourceConsumed · 0.1`
  (`CBuildTaskHelper::UpdateWorkProgress` @0x5f5f2c).
- **Raster-Snap** (`COORDS_GridSnap` @0x50B1E0, Cfile:641666-641686):
  `cell = trunc(p − size/2)`, back `+ size/2`, **height only after snap**
  (Cfile:641588). `size` are the integer `Footprint.SizeX/SizeZ` — not
  SkirtSize, not SelectionSize. A 5×5 building always sits on `x.5`.
- **Beat order is measurable** (`Sim::AdvanceBeat` @Cfile:1076363):
  Factory Queues → Build Demand → Economics → Apply Rate → Lua Threads →
  Movement. A unit is completed in phase 3; their **camp** only appears in the
  Economics tick of the **next** beat.

## Movement (Details: [movement-path.md](movement-path.md))

- **`MaxBrake == 0` / `MaxSteerForce == 0` means “take `MaxAcceleration`”**,
  not "can't brake/steer" (Cfile:942136-942147). The ACU has even
  no `MaxBrake` — if read incorrectly, that pins your speed to 0.
- Motion parameters are scaled **per tick** (`·0.1` Speed, `·0.01` Accel,
  `·0.0017453` deg/s → rad/Tick).

- **The Speed ​​Cap Cascade of Movement** (sub_699760 @0x699760,
  Cfile:942291-942328, called from CAiPathSpline::Generate 766232ff):
  RotateOnSpot ONLY applies below the speed threshold
  (`RotateOnSpotThreshold > |v|·10/MaxSpeed`, Default 0.5; Cfile:942301) —
  then stand until `dot(fwd, ziel) ≥ 0.98`, then full MaxSpeed. Otherwise
  Arch geometry: `r = dist²·0.5 / (dz·fwdX − fwdZ·dx)`; only curves TIGHTER
  as the TurnRadius throttle: `v = turnRate·|r|·0.5` (Cfile:942316-942321).
  Effective rotation rate = `max(turnRate, v/turnRadius)`, clamped to π
  (Cfile:766161-766163). Stop: `dist ≤ brake ? dist : sqrt(2·brake·dist)`
  (Cfile:766249-766262). Struct-Default TurnRadius = 5.0 (Cfile:656160).

## Units, weapons, skeleton (Details: [weapons.md](weapons.md))

- **Unit lifecycle:** `OnPreCreate` (@943748) → `OnCreate` (@944007) → at
  manufactured units `OnStopBeingBuilt`. Without `OnPreCreate` there is none
  `self.Sync`, no `self.Trash`, no `EventCallbacks`.
- **The sim has the SKELETON of the unit**, not just the renderer.
  `weapon.lua:67` checks tower bones over `Unit:ValidateBone` (unit.lua:2751);
  Mouths, construction and effect bones also depend on names. The bones
  come from the same `.scm` as in the renderer (`__setBones`,
  [scripts/gameFiles.ts](../../scripts/gameFiles.ts)). Without a skeleton breaks
  already `Weapon:OnCreate`.
- **The engine calls `OnCreate` on EVERY weapon.**
  `DefaultProjectileWeapon.OnCreate` endet mit
  `ChangeState(self, self.IdleState)` (defaultweapons.lua:87) — only the
  IdleState starts the state machine. The Overcharge loaded without the call
  the ACU (IdleState.Main → `StartEconomyDrain`, defaultweapons.lua:404).
  5000 energy sometime later when the cash register is empty - rate 0.004, never finished,
  and every factory starves to death. **Order is semantics.**
- **fire control** (`GetFireState` @0x8BB500): Sentinel 3 → first unit **with**
  `RULEUCC_RetaliateToggle` (bit 5 of the CommandCaps, Cfile:656671-656719).
  the state, deviation ⇒ −1 (mixed). Values: 0 = ReturnFire, 1 = HoldFire,
  2 = HoldGround; Ctor startet mit ReturnFire (Cfile:772277).

## Blueprints

- **Struct Defaults:** the engine reads a `.bp` into a typed struct whose
  Ctor (`Moho::RUnitBlueprint` @0x51E480) **every field** preassigned
  (`Defense.Shield.ShieldSize = 0`, `Intel.VisionRadius = 10`,
  `Economy.BuildRate = 1` …). The Lua sees the reflected struct — **any
  Field always exists**. That's why `Unit.lua` acts unchecked
  `bp.Defense.Shield.ShieldSize` zu.
- **`Sound{}`** is the only DSL constructor in the `.bp` files (3445×).
  If it is missing, the blueprint evaluation stops in the middle - and the bp ends up
  half finished under the key `'null'`.
- **Field names in `.bp` are those of the PARSER, not the internal members.**
  `AddField_*` registriert sie (Projektil-Physics Cfile:653990-654175, Waffe
  Cfile:658290-658520). Two cases where the `.bp` value would otherwise never be read
  becomes: `CollideEntity` (not `CollisionEntity` — the member is called
  `mCollisionEntity`) and `BounceVelDamp` (not `BounceVelocityDamping`). A
  Projectile with `CollideEntity = false` (Nukes, Strat missiles) would otherwise fly into the
  first unit flown over. The weapon struct defaults (23 float=0, 26
  bool=false, 7 string="") are mandatory: `weapon.lua:287` calculates without checking
  `bp.DamageRadius + …`, and the ACU weapon does not set `DamageRadius`.

- **Wreckage and construction meshes are created by the LUA, not the engine:**
  `lua/system/blueprints.lua:187` (`ExtractWreckageBlueprint`) copies this
  Mesh BP of each unit to `<meshid>_wreck` (ShaderName `Wreckage`, SpecularName
  `/env/common/props/wreckage_noise.dds`; Alpha-Shader → `BlackenedNormalMappedAlpha`)
  and sets `bp.Display.MeshBlueprintWrecked`; `:210`
  (`ExtractBuildMeshBlueprint`) analog `<meshid>_build` (Shader
  `<Faction>Build`, SecondaryName BuildSpecular, Seraphim + Lookup) →
  `bp.Display.BuildMeshBlueprint`. Both are running in our real one
  `LoadBlueprints()` chain automatically with. The string exists in binary
  `MeshBlueprintWrecked` NOT (IDA string search: `CreateWreckageProp` only).

## Wrecks (mesh.fx technique Wreckage — the REAL shader)

- **WreckageVS_HighFidelity (mesh.fx:1153-1203) DENTS the mesh:** after the
  World Transformation `nvert = normalize(worldPos)`, `s = nvert.x * 0.15`
  (HLSL truncates `float s = float3*0.15` to .x), `r = length(worldPos)`,
  `phi = frac(0.01 * length(row3))` (row3 = translation of the bone world matrix →
  phase per location); then `pos.x += sin(14.5*r*nvert.z + phi)*s`,
  `pos.y += cos(10.8*r*nvert.x + phi)*s`, `pos.z += sin(20.5*r*nvert.y + phi)*s`.
  `depth.y = material.x` = **Erstellungszeit** (Sekunden).
- **WreckagePS (mesh.fx:2334-2356):** Albedo of the unit; Noise Specular with
  `texcoord.x += frac(0.01*creationTime)`, `.y -= frac(...)`, then `* 5.15`
  gesampelt. `color = albedo * ComputeLight(dLN, 1)` — **Wracks empfangen
  no shadows** (original comment: artifacts); then
  `spec.g < 0.22 ? color *= (albedo + spec.r + spec.a) * spec.b * 2.5
  : color *= spec.b * 2`. No team color, no Phong; Alpha = glowMinimum
  (mesh.fx:57 = 0.010). Cull CW.
- **The sim path is pure original Lua** (unit.lua:1076-1146): OnKilled →
  DeathThread → `CreateWreckage` (Gate: `bp.Wreckage.WreckageLayers[layer]`) →
  `CreateWreckageProp`: `CreateProp(pos, bp.Wreckage.Blueprint)` +
  `SetMesh(Display.MeshBlueprintWrecked)` + `SetScale(Display.UniformScale)` +
  `SetOrientation` + `TryCopyPose` + `prop.AssociatedBP = <unit-bp-id>`.

## Damage, Death, Health (Details: [combat-projectiles.md](combat-projectiles.md), [damage-binary.md](damage-binary.md))

- **`SetHealth` quantized with FLOOR, not commercially.** The engine calculates
  `frndint(ratio*4)` with the correction `if (x < round(x)) −1` (Cfile:916030-916037)
  — that is exactly `floor(x)` for positive x. `OnHealthChanged(neu, alt)` fires
  only if the **25% quantized** portion changes; that's what they depend on
  Damage smoker (unit.lua:820-823). With `+0.5` (round-half-up) it fires
  12.5/37.5/… limits a tad too early.
- **Kill order: `OnKilled` FIRST, KILLS AFTER.** `cfunc_EntityKillL` calls
  first `Unit::Kill` (which fires OnKilled internally, Cfile:936149), then the
  KILLS counter on the Instigator (Cfile:936183). `CheckVeteranLevel` reads
  `GetStat('KILLS',0).Value + 1` (unit.lua:3139) — the `+1` applies exactly, **because**
  the current kill has not yet been counted. If you count beforehand, the unit increases
  one kill too early. **BENIGN** targets (wrecks) do not count (Cfile:936164).
- **`Kill`:** Construction site with `FractionComplete < 0.5` → `excessDamageRatio = 10.0`
  (Cfile:952122) ⇒ in the Lua **no wreck** (unit.lua:1079: `overkill > 1`).
- **`TargetCheckInterval` is converted to ticks using CEIL** (`round(x·10) +
  (x·10 > round)`, min 1; Cfile:792904-792908), `fireClock = (int)(10/RoF)`
  (Trunkierung, Cfile:983956). Suchradius = `max(MaxRadius, TrackingRadius·MaxRadius)`
  — a maximum, no product (Cfile:793125).

## UI (Details: [ui-complete.md](ui-complete.md))

- **Fonts:** `lua/skins/skins.lua:22-26` requires "Arial" and
  "Zeroes Three" — both as TTF in `<GameDir>/fonts`. Sizing text controls
  to `FontAscent + FontDescent` and `TextAdvance` (text.lua:39/47) →
  real TTF metric ([src/formats/ttf.ts](../../src/formats/ttf.ts)), same
  File rendered using `FontFace`. The **full name** (nameID 4) is the
  Key: `ARIAL.TTF` and `ARIALBD.TTF` both have the “Arial” family.
- **`/lua/usersync.lua` belongs in the UI VM** (counterpart to `/lua/simsync.lua`;
  no Lua file loads it, the engine does). It brings `Sync`, `UnitData`,
  `OnSync()` — without `UnitData`, orders.lua:909 fails the first selection.

- **The session in the UI VM:** `GetArmiesTable()` (cfunc_GetArmiesTableL,
  Cfile:1267023-1267111) liefert `{ numArmies, focusArmy (1-basiert),
  armiesTable }`; je Armee genau: `name, nickname, faction, color, iconColor,
  showScore, civilian, human, outOfGame, authorizedCommandSources`.
  **`faction` is 0-based** — the Lua calculates `faction + 1` everywhere
  (gamemain.lua:109, orders.lua:675, avatars.lua:664). `SessionGetScenarioInfo()`
  returns the table that went to the sim at startup (`.Options` will
read unchecked: tabs.lua:21, diplomacy.lua:34).
  `SessionGetLocalCommandSource()` is the **Client** index (1-based; 0 = allowed
  not command, Cfile:1330618), **not** the army. Without a session, everyone throws
  Session-Globals „…(): no active session." (Cfile:1330339).
- **`SessionRequestPause`/`SessionResume` stop the SIM**
  (CWldSession::RequestPause) — the UI continues to run (own VM, own
  Frame-Takt).
- **The world launch runs via the WldUIProvider** (`InternalCreateWldUIProvider`
  → `WLD_SetUIProvider`, Cfile:29710): `func_DoPreload` (Cfile:1320735) ruft
  `StartGameUI` + `provider:StartLoadingDialog()`; `DoInitializing`
  (Cfile:1321030-1321090) calls `StartGameUI` AGAIN (SetNewLuaState clears the
  Root frames - the loading dialog disappears), then `StopLoadingDialog()`
  (Fraktionsbild, 1,5-s-Fade, `ForkThread(InitialAnimations)` —
  gamemain.lua:253-263 displays score/economy/avatars/tabs) and FIRST
  THEN `CreateGameInterface` (= gamemain.CreateUI). Error in OnFrame
  don't throw in the engine: RunScript catches them and logs
  (`gpg::Warnf 'Error running %s script in %s: %s'`, Cfile:590672).
- **`currentScores` does NOT have a producer in the vanilla 3599 dataset:**
  `CollectCurrentScores`/`SyncCurrentScores` (aibrain.lua:59/334) forkt
  nobody — neither a Lua file (grep via lua.scd/mohodata.scd: just that
  Definitions) nor the engine (the only aibrain import is
  `func_LoadAiBrain`, Cfile:724474, for class only; `GetArmyScore`
  returns 0 values, Cfile:1267147). The score panel's points column remains
  1:1 EMPTY; Living numbers would be an additional decision (FAF behavior).
- **The factory queue indicator drives the engine, not the Lua:**
  `CUIManager::DoBeat` calls FIRST per sim beat
  `UI_FactoryCommandQueueHandlerBeat` (Cfile:1256904-1256990: struktureller
  Comparison against `sCurrentBuildQueue`, if changed
  `gamemain.OnQueueChanged(neu)`; Factory gone → once `OnQueueChanged(nil)`),
  THEN `UI_LuaBeat` (Cfile:1273907-1273911).
  `SetCurrentFactoryForQueueDisplay` copies the queue immediately (Cfile:1257076).
- **Avatare/Idle:** Avatar = `bp.General.QuickSelectPriority > 0`
  (UserUnit-Ctor Cfile:1362979; Struct-Default 0, Cfile:656079), aufsteigend
  sorted (Cfile:1352238). `mIsEngineer` = ENGINEER **without**
  COMMAND/SCOUT/UNTARGETABLE (Cfile:1362995-1363014). The lists are included
  empty **nil**, not an empty table (Cfile:1360921) — avatars.lua:666 checks
  `if avatars then`. The UEF-ACU carries PODSTAGINGPLATFORM
  (uel0001_unit.bp:125) — orders.lua:923-932 runs on every ACU selection and
  braucht `GetAssistingUnitsList` (Cfile:1360671).

- **`GetUnitCommandFromCommandCap`** (Cfile:1264844) provides the
  EUnitCommandType names **WITHOUT** `UNITCOMMAND_` prefix (`'Stop'`,
  `'OverCharge'` — capital C, Cfile:696219): the enum stores the names
  gestrippt (`mPrefix`, Cfile:696168-696248; Beweis:
  `UICommandGraph::LoadPathParams` sets the prefix per
  `STR_Printf("%s%s",…)` itself before that, Cfile:1244372-1244378). input
case-insensitive, prefix optional (SetLexical, Cfile:1381888-1381946).
Full mapping: func_UnitCommandCapToCommandType
  (Cfile:1242230-1242328); RetaliateToggle/Dock/Script/Invalid → `'None'`.
- **`SimCallback`** (Cfile:1359139-1359305): Args are serialized IMMEDIATELY
  (Snapshot; Functions → “Unable to marshal lua function", Cfile:999128),
  Selected as an entity ID set by the LOCKSTEP command stream
  (MSGOP_LuaSimCallback). Sim page (Cfile:1076180-1076287): IDs → Table
  of Sim-Units (only existing ones; empty set → **nil**), then
  `import('/lua/SimCallbacks.lua').DoCallback(name, args, units)`.
- **`SessionSendChatMessage`** (Cfile:1322106-1322227) runs over the
  NETWORK LAYER (Client Manager), not Sim/Sync: Receivers are 1-based
  **Client Indexes** (same list as `GetSessionClients`, fields
  Cfile:1321886-1321957: name/uid/connected/ping/quiet/local/
  authorizedCommandSources/ejectedBy); msg sofort serialisiert (Snapshot —
  chat.lua:759 only sets `msg.echo` AFTER sending), > 1024 bytes →
  „Message too long."; Zustellung ASYNCHRON (THREAD_InvokeAsync,
  Cfile:1320454) an `gamemain.ReceiveChat(senderName, msgTable)`.
- **`RestartSession`** (Cfile:1263968-1263985): No-Op without restartable
  Session (Flag = `SessionCanRestart()`, Cfile:1330810); otherwise frame action
  CREATE_SESSION → Teardown + restart with the UNCHANGED session info
  (func_DoPreload, Cfile:1320748-1320784) — no lobby detour.
- **Boot vulnerability found:** `repr` is a global from `/lua/system/repr.lua`
  (globalinit.lua:19, right after utils.lua) — the sim VM didn't load it, and
  `simcallbacks.lua:18` died because of `repr == nil` instead of "No callback named...".
- **`GetUnitCommandData(units)` (cfunc, Cfile:1264504-1264815)** returns
  `orders, toggles, buildableCategories`. The third value is **always** an
  EntityCategory object, **never nil** — even for an empty selection the two
  AssignNewTable calls (Cfile:1264740/:1264765) plus `func_NewEntityCategory` run
  after the unit loop and it does `return 3` (Cfile:1264788-1264808). The
  buildable category accumulates across the selection as an **INTERSECTION**
  (`BVIntSet::IntersectWith`, Cfile:1264719: the first builder copies, each
  further one intersects; per unit it also subtracts already-queued categories,
  Cfile:1264659-1264712) — **not a union**. So the build menu shows only what ALL
  selected units can build; a non-builder in the selection empties it.
- **`GetEconomyTotals()` returns SIX subtables** (Cfile:1264359-1264364):
  `stored, income, reclaimed, lastUseRequested, lastUseActual, maxStorage`, each
  keyed MASS/ENERGY, copied raw per tick (`qmemcpy 0x38`). `reclaimed` is the
  third pair (`mTotals.mReclaimed`); reclaim is written to **two** places —
  storage AND this counter (CUnitReclaimTask, Cfile:848614-848639) — and is
  **not** folded into income. The UI economy.lua reads only five of them.
- **`IN_ParseKeyModifiers` (Cfile:1259566-1259700):** tokens split on `-` are
  **prepended** (Cfile:1261100-1261138), so the vector reverses and `start[0]` =
  the **last** written token = the key name; the rest are modifiers with bits
  Shift=0x80000000, Ctrl=0x40000000, Alt=0x20000000 (Cfile:1259641/54/67). (The
  faf-re reconstruction had this reversed — the raw decomp is authoritative.)
- **`SetCurrentFactoryForQueueDisplay(unit)` returns nil for an empty/absent
  queue** (`AssignNil`, Cfile:1257091), never an empty table — construction.lua:1655
  branches `if currentCommandQueue then SetQueueGrid else ClearQueueGrid`.
- **`GetUnitCommandFromCommandCap(cap)` never throws on an unknown cap:** the
  cfunc ignores SetLexical's return (Cfile:1264874), the enum stays RULEUCC_None,
  and `UnitCommandCapToCommandType` yields `'None'` (Cfile:1242230-1242328). Only
  a non-string arg is a TypeError.
- **`SelectUnits`/`AddSelectUnits` (Cfile:1361484-1361655)** filter IsDead **and
  DestroyQueued**, keep only `IsSelectable()` units, and substitute a selectable
  transport/dock parent (category TRANSPORTATION) for a non-selectable unit
  (Cfile:1361497-1361534). The apply itself is `CWldSession::SetSelection`.
- **The UI→sim command seam crosses as strings only because of `CMarshaller`:**
  ProcessInfoPair carries (int entityId, string key, string value)
  (Cfile:998503/997049). SetFireState sends the lexical string ('ReturnFire'/…),
  ToggleScriptBit a decimal bit string, SetPaused "true"/"false" — an
  int→string→int round-trip forced by the network protocol, not semantics.
  `ToggleScriptBit` also guards: it dispatches only when the unit's actual bit ==
  the passed curState (Cfile:1360311); `cfunc_SetPausedL` = "Pause builders in
  this list" (per-unit mIsPaused, halts production — distinct from the whole-world
  `SessionRequestPause`).
- **`Unit:TestCommandCaps` in the engine tests the blueprint's TOGGLE caps**
  (mGeneral.mToggleCaps, Cfile:975662-975663) — an apparent copy/paste quirk for
  a "CommandCaps" test. UnitAttributes seeds the runtime command mask from
  `bp.General.CommandCaps` (Cfile:949126); AddCommandCap `|= bit` (Cfile:975473),
  RemoveCommandCap `&= ~bit` (Cfile:975542), RestoreCommandCaps resets to blueprint.
- **`GetSelectedUnits` returns a FRESH table, and the selection is a SET.**
  cfunc_GetSelectedUnitsL AssignNewTable + fills a brand-new table each call
  (Cfile:1361355-1361388) — mutating it never touches `CWldSession::mSelection`, so
  a UI mirror must return a *copy*, not the live list (else shift-add callers alias
  it and gamemain's `isOldSelection` skips the selection sound + rallypoint).
  `SelectUnits` stores via `WeakSet_UserEntity::Add` (Cfile:1361502→1153912), which
  keeps each entity at most once → dedupe by id.
- **The command graph draws the EXECUTING head with its own command type.**
  UICommandGraph::CreateMeshes walks the whole command queue *including* the
  running head (Cfile:1247191), and LoadPathParams builds one node per
  EUnitCommandType 0..39 (Cfile:1244312) — so an active Patrol/Reclaim/Guard keeps
  its own waypoint texture. Reconstructing the head's type from live physics
  (goal/target) mislabels it (Patrol→Move, Reclaim→none).
- **A factory's BuildFactory count decrements on COMPLETION, not on spawn.**
  When a factory-built unit finishes: `if count <= 1` RemoveCommandFromQueue else
  `DecreaseCount(1)`, and only *then* the next CFactoryBuildTask starts
  (Cfile:838029/838062) — the in-progress unit stays counted, so the displayed
  queue shows the true remaining count. The command is issued only to selected
  units in category FACTORY (`IsInCategory('FACTORY')`, Cfile:1265854-1265856);
  non-factory units are skipped.
- **World sounds vs UI cues are separate switches.**
  `Moho::CUserSoundManager::StopAllSounds` (Cfile:1346492) destroys every entity
  loop and every live IXACTCue — nothing keeps playing. `EnableWorldSounds`/
  `DisableWorldSounds` store an enable byte (Cfile:1346188/1348520) that gates the
  *world* sounds (weapon fire, unit ambient loops) — score.lua:220 mutes them at
  the score screen — while UI cues run through a separate path and stay audible.

## Guided ammunition (projectile tracking — decomp + faf-re, all documented)

- **Move-Tick** (Cfile:944100-944260): WITHOUT tracking `v += BallisticAcc·0.1`,
  then `v += Forward(orient)·(Acceleration·0.1)`; VelocityAlign rotates the
  Orientierung per `QuatFromVecRot(orient, v, TurnRateDeg·0.0017453292)`
  (= TurnRate·0.1 Grad/Tick in rad). MIT Tracking (`bp.Physics.TrackTarget`,
  Struct-Default 0, Cfile:653698): `UpdateTracking` rotates the NOSE, then
  `v += Forward·Accel·0.1` (no BallisticAcc). `MaxSpeed≠0` clamps |v|.
  Position += (v_alt + v_neu)·0.05 (Trapez!).
- **UpdateTracking** (@944367): Target = GetTargetPosGun; Goal lost →
  RunScript `OnLostTarget` + TrackTarget=0 (flies to last target position
  further, flag v207). LeadTarget (mLeadTarget & MaxSpeed>0, entity target):
  TWO-STEP provision — t1=|target−pos|/(MaxSpeed·0.1)… (iterates 2×
  about the target speed). ZigZag (MaxZigZag>0 & Frequency>0): all
  f(Frequency) Ticks neue FRand(−max,+max)-Offsets je Achse, skaliert mit
  min(dist/MaxZigZag, 1), terrain clamp GetElevation+0.5. In the end
  `QuatFromVecRot(orient, richtungZumZiel, TurnRateDeg·0.0017453292)`;
  VelocityAlign setzt v = Forward·|v| (func_VecSetLength).
- **QuatFromVecRot** (@0x69AA50, faf-re QuaternionMath.cpp:531): forward =
  Z column of the quat; `delta = QuatCrossAdd(forward, ziel)`;
  `RotateQuatByAngle(delta, rads)`; `quat = delta·quat` (PRE-multiply).
- **QuatCrossAdd(v1,v2)** (@0x44F880, faf-re Sim.cpp:8759): half =
  normalize(norm(v1)+norm(v2)); w = dot(half,v1), xyz = cross(v1, half)
  — the rotation v1→v2. Antiparallel (|half|=0): (0, v1).
- **RotateQuatByAngle(q, rads)** (@0x4EB740, faf-re QuaternionMath.cpp:481):
  limits the DELTA to rads: if sin²(θ/2)=|q.xyz|² ≤ sin²(rads/2) →
  UNCHANGED (target closer than limit → full rotation); otherwise q =
  (cos(rads/2), axis·±sin(rads/2)) (Vorzeichen folgt w<0). rads/2 ≥ π/2 →
unchanged.

## Effects/Particles (Source: effects/particle.fx from effects.scd, 1332 lines — the REAL shader)

- **Partikel-Vertexshader (WorldVS):** `t = time - birth`; `alpha = t/lifetime`
  (= Ramp-U!); Position without drag `P0 + V·t + 0.5·A·t²`, with drag
  `(dz·A − dy·V)·(e^(−dx·t) − 1) + dy·A·t + P0`; Rotation
  `rot = Pos.w + Vel.w·t` rotates the ±1 quad; Billboard about
`InverseViewMatrix[0/1]` (Flat: World-X/Z); Size `Size.x + Size.y·t`.
  Frame animation: `frame = floor(framerate·t)`, U at `framesize·frame`
  delay; TexOffset.z/x select the texture line, TexOffset.y the
  Ramp-Zeile (mTex1 = {alpha, rampOffset}).
- **Pixelshader:** `Partikeltextur(mTex0) × Ramptextur(mTex1)`; REFRACT
  offsets the background by `0.005·(2·texel.rg − 1)`.
- **Blend-States (AlphaState je Technique-Suffix):**
  MODULATEINVERSE = Zero/InvSrcColor · MODULATE2XINVERSE =
  InvDestColor/InvSrcColor · ADD = SrcAlpha/One · ALPHABLEND =
  SrcAlpha/InvSrcAlpha (RGB only) · PREMODALPHA = One/InvSrcAlpha (RGB only).
  Depth: Test Less ON, **Write OFF**; Cull None. Technique families:
  TRamp[Animate][Align|AlignToBone|Flat]_<BLEND>, TLight, TBeam_One/TwoTexture,
  TTrail (TrailVS: Ribbon across the viewing direction, `cross((0,0,1), dirView)`,
  V from `(startTime − originTime)/lifetime · repeatRate`).
- **Emitter transport with us:** the sim reports live emitters per beat
World position (`__readAllEmittersJson`, globals.lua; owner+bones above
  `__boneWorld`) → Worker → `LuaSimClient.allEmitters()`.

## Lua-Host

- **FA-Lua does NOT fail when comparing across type boundaries.** The engine has
  `luaV_lessthan` (Cfile:1442257) and `luaV_lessequal` (Cfile:1442275) patched:
  for unequal types they provide the comparison of the **type tags**
  (nil=0, boolean=1, number=3, string=4, table=5, function=6, userdata=7) instead
  "attempt to compare number with nil". The original UI expects this:
  diplomacy.lua:24 appends `Items` to the boolean `false`, replacing line 107
  `parent` through a control (where `Items` is nil), and line 123 asks
  `table.getsize(parent.Items) > 0` — `nil > 0` is simply `false` in FA.
  Replicated via `__lt`/`__le` on the type metatables
  ([boot.lua](../../src/engine-lua/boot.lua)).
- **wasmoon: a JS function may NEVER return `null`** — wasmoon checks
  `typeof target !== 'object'` and then accesses `target.then`
  (dist/index.js:1020-1026); for `null`, `typeof` is "object", the VM dies
  deep in strange Lua. `LuaHost.setGlobal` therefore converts `null → undefined`.
- **`class.lua` copies base class fields to derived class** (no
  `__index` fallback). A method name may appear in **exactly one**
  moho name list: `GetHealth` was in ENTITY_NAMES *and* UNIT_NAMES —
  the no-op on the unit overshadowed the real implementation, every unit
  meldete 0 HP.
- **The thread scheduler sleeps `max(1, N-1)` ticks for `WaitTicks(N)`, not N.**
  `WaitTicks = coroutine.yield` (raw count) and `WaitSeconds(n) =
  WaitTicks(max(1, n*10))` with the fractional value passed straight to yield
  (siminit.lua:35-40). The engine reads the yield with `GetInteger` — which
  TRUNCATES (CLuaTask::TaskTick, Cfile:592180) — then `CTaskThread::DoTaskTick`
  (Cfile:438898) stores `mWaitTicks = v4-1` for a count v4>=2 (default) and `1`
  for v4==1 (TASKSTATUS_Wait), PRE-decrements each frame (`--mWaitTicks`) and runs
  when `<= 0`. So `WaitTicks(1)` and `WaitTicks(2)` both resume after 1 tick, and
  `WaitTicks(N)` after N-1. Storing the raw count resumed every WaitTicks(N>=2) /
  WaitSeconds **one tick late** — the mistake baked into an early scheduler test.
  Implemented in `settle` ([threads.lua](../../src/engine-lua/threads.lua)).
- **A thread forked during a frame runs in that frame.** `CTaskStage::DoFrame`
  (Cfile:439351-439395) drains `mThreads` until it is empty, and the
  constructor appends the new thread to its tail with `mWaitTicks = 0`
  (Cfile:438783-438808). The child therefore runs after every thread that was
  already queued, in the same tick -- not the next one. `ResumeThread` appends
  a parked thread the same way (Cfile:593112-593124). And `WaitTicks(0)` does
  not wait: `TASKSTATUS_0` re-ticks an un-parked thread at once
  (Cfile:438938-438942). The old scheduler had a snapshot bound and a check
  that asserted the wrong order; `verify-simthreads.ts` now pins the engine's.

## Shadows (H7 groundwork — mesh.fx, read and verified, not yet built)

- **ComputeShadow (mesh.fx:459-545):** `ComputeShadowStandard` compares
  `shadowCoords.z > tex2D(shadowSampler, xy/w).r + shadowBias` -> shadow 0,
  else 1. `ComputeShadowPCF` averages 5 taps (offsets: (-t/2,0), (0,-t/2),
  (-t,0), (+t,0), (0,+t) with t = 1/shadowSize) comparing
  `depth + shadowBias > shadowCoords.z - 0.001`. `ComputeShadow(coords,
  hiDefFiltering)` picks PCF only when `hiDefFiltering && shadowBlur`.
  Everything sits behind `#ifdef SELF_SHADOW` (without it: 1.0).
- **Shadow texcoord (NormalMappedVS :951, EffectVertexNormalLoFiVS
  :1517-1523):** `mShadow = mul(position, ShadowMatrix); x = (x+w)*0.5;
  y = (-y+w)*0.5; z -= 0.01` (epsilon in the VS).
- **Terrain receives** via `tex2D(ShadowSampler, mShadow.xy).g`
  (TerrainAlbedoXP :760) or `ComputeShadow` inside CalculateLighting
  (:373); terrain does not cast through the mesh depth path.
- **Casters:** every mesh technique with STAGE_DEPTH in its renderStage
  and a `depthTechnique` annotation ('Depth' for solid units,
  'DepthClip' for alpha-tested foliage/props, 'SeraphimBuildDepth' for
  the growing Seraphim site).
- **Build plan:** light ortho camera over the map AABB along the scmap
  sun direction, depth RT, depth-twin meshes sharing geometry +
  bone-uniform references (instanced props share the instanceMatrix
  attribute), then the ComputeShadow term in terrain/unit/prop/decal
  shaders behind a define.

## Engine-fidelity round, August 2026 (spec 001)

Twelve divergences pinned against the decompilation and fixed; each is covered
by a suite. The facts worth remembering:

- **`CAiBrain::TakeResource` is not a negative `GiveResource`.** It works on
  `mTotals.mStored`, takes `min(requested, stored)`, writes back
  `max(0, stored - taken)` and **returns the amount taken** — the help string
  says so: `"taken = TakeResource(type,amount)"` (Cfile:735162, body
  735173-735270). `GiveResource` instead accumulates into `mResources`, the
  per-beat income accumulator, and returns nothing (Cfile:734991-735054).
  `simutils.lua:152-155` pipes the return straight into `GiveResource`, so
  losing it NaN'd the recipient's economy.
- **Shield absorption is collected once per damage EVENT, not per target.**
  `func_DoDamageArea` calls `SIM_DoDamage` once (Cfile:1063221) to record each
  eligible dome's `OnGetDamageAbsorption`, subtracts the total of the domes
  containing each entity (`sub_736E40`, Cfile:1062715), skips entities whose
  remainder is `<= 0` (Cfile:1063264), and damages every dome exactly once with
  what it absorbed (Cfile:1063310-1063386). A dome is skipped when the damage
  ORIGIN lies inside it at `radius - 0.1` (Cfile:1062800). `shield.lua:96-99`
  states the contract in the original's own words.
  `func_DoDamagePoint` (Cfile:1062873-1063170) contains **no shield code at
  all** — a direct hit is stopped by projectile-vs-shield collision instead.
- **`FindBestEnemy` ranks by priority, not distance** (Cfile:791970-792233).
  The lowest matching `mTargetPriorities` index wins outright
  (Cfile:792190-792191); distance only breaks ties inside a category
  (Cfile:792203). The whole selection sits inside
  `if Size(mTargetPriorities)` (Cfile:792176), so a candidate matching no listed
  category is not a target — most weapons end their list with `ALLUNITS`.
  `SetTargetingPriorities` (Cfile:988316-988366) is the only writer; the ctor
  leaves the vector empty (Cfile:984183-984185).
- **`Unit::Materialize` ADJUSTS health, it never assigns it.**
  `AdjustHealth(0, mMaxHealth * delta)` (Cfile:953468); for a positive delta the
  fraction is first raised to `health / maxHealth` (Cfile:953464-953465) — the
  fraction follows the health, never the reverse. Assigning
  `maxHealth * fraction` healed away every hit a construction site took.
- **`mResourceConsumed` is 0 unless consumption is active.** Reset to 0 every
  tick (Cfile:953937) and set to `CEconRequest::LimitingRate` only while
  `!IsDead && mConsumptionIsActive && mConsumptionData` (Cfile:953945-953948).
  `LimitingRate` is `1.0` for an empty request and `min(granted / requested)`
  otherwise (Cfile:1107891-1107909). `unit.lua:748-752` turns consumption off
  exactly when both rates are zero, so "idle" really does report 0 — and
  shield.lua's recharge (`ChargingUp`, shield.lua:288) stalls forever on an
  owner with no drain. That is why the ACU's shield enhancement sets
  `SetEnergyMaintenanceConsumptionOverride` (uel0001_script.lua:314/326).
- **The dispatch gate has four conditions**, not three:
  `!IsBeingBuilt && !IsDead && !Attached && !BlockCommandQueue`
  (`IAiCommandDispatchImpl::TaskTick`, Cfile:746583-746586). Death is not
  instant — `DeathThread` runs for several beats (unit.lua:1200-1241).
- **A factory's production queue IS its command queue.** The entries are
  `UNITCOMMAND_BuildFactory` commands in `mUnit->mCommandQueue`
  (Cfile:838000-838062), and `ClearCommandQueue` removes every command without
  exception (Cfile:1005371-1005399). `IssueStop` and `IssueClearCommands` are
  **different**: `IssueStop` appends a Stop with `clear = 0` (Cfile:1007952)
  whose whole effect is `CAiAttackerImpl::Stop` + `SiloStopBuild`
  (Cfile:831239-831256); `IssueClearCommands` clears (Cfile:1007874-1007889).
  The UI's Stop button is the clear case (`ISSUE_Command(..., 1)`,
  Cfile:1255059-1255063).
- **Unit height branches by motion type.** Only `RULEUMT_Water`,
  `AmphibiousFloating` and `Hover` clamp up to the water surface
  (`CAiPathSpline::Update` Cfile:765808-765823, `::Generate` Cfile:766391);
  Land, Biped, Amphibious, SurfacingSub take the raw heightfield — an
  amphibious unit **walks the seabed**, confirmed by `IsOnValidLayer` accepting
  `LAYER_Seabed` for `RULEUMT_Amphibious` only (Cfile:965960-965975).
  Enum: None=0, Land=1, Air=2, Water=3, Biped=4, SurfacingSub=5, Amphibious=6,
  Hover=7, AmphibiousFloating=8, Special=9 (Cfile:656550-656583).
- **Projectile surface collision needs the RAW heightfield.**
  `GetSurfaceHeight` is already `max(elevation, waterElevation)`
  (Cfile:1089855-1089876), so testing terrain with it made every water impact
  report `Terrain`. The water plane and the heightfield are separate tests
  (`CColHitResult::PlaneIntersection` Cfile:722370 vs `CHeightField::Intersection`).
  The gate is `mWaterEnabled`, i.e. water level `> -10000` — absent water is
  exactly `-10000` (Cfile:857506-857510), **not** "level <= 0".
- **maui focus: two different callbacks, and a click does not steal focus.**
  A `ButtonPress`/`ButtonDClick` on another control calls vtable offset **64**
  = slot 16 = `LosingKeyboardFocus` → `RunScript "OnLoseKeyboardFocus"` on the
  CURRENT focus control and leaves `Maui_CurrentFocusControl` untouched
  (Cfile:1147524-1147531; vtable Cfile:396337-396366; binding
  Cfile:1124565-1124570). Only `MAUI_SetKeyboardFocus` writes the focus, and it
  uses offset **68** = slot 17 = `OnKeyboardFocusChange` on the OLD control,
  after the new one is assigned (Cfile:1141557-1141596). Nothing is called on
  the control that gains focus.
- **`uimain.OnMouseButtonPress` is an engine call, not a Lua convention.** On
  every `ButtonPress`/`ButtonDClick` the engine builds a FRESH table with only
  `Type`, `x`, `y` (lowercase, Cfile:1147543-1147545), imports
  `/lua/ui/uimain.lua` and calls it (Cfile:1147534-1147558, sole xref at
  1147549) — **before** `PostEvent` delivers the event to the topmost control
  (Cfile:1147582). `uimain.lua:167-177` fans it out to every
  `AddOnMouseClickedFunc`; combo.lua:289 and orders.lua:539 depend on it.
- **Blueprint `Footprint` defaults are derived, not 1.** The fields are `uchar`
  struct members defaulting to 0 (Cfile:642465); `RUnitBlueprint::OnInitBlueprint`
  raises a 0 to `ceil(SizeX/SizeZ)` (Cfile:647164-647177). 72 retail structures
  ship no `Footprint` section at all. `Physics.BuildOnLayerCaps` likewise
  defaults to the `LAYER_Land` bit (Cfile:656146-656172).
