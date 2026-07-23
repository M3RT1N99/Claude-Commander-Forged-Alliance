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
