# agent2

## Summary
FA's gameplay layer is **real Lua 5.0.1 (PUC-Rio) with GPG patched lexer** — confirmed via version string in bin/main.exe. The scripts use `#` as line comment (299/460 files), `!=` instead of `~=` (556x), `!` as `not` (26x), as well as Lua 5.0 semantics (`arg`-Varargs, `table.getn` 480x, `for k,v in t do` without pairs() 2039x). **This makes wasmoon (Lua 5.4) and fengari (5.3) unusable for 1:1 execution** — both already fail to parse practically every file. Clear recommendation: **embed Lua** (own Emscripten build of Lua 5.0.1 + 3 lexer patches), and only recreate the *engine* (`moho.*`, ~543 Sim bindings) in TypeScript - because you would have to write these bindings in the replication path anyway, while you also port 53k LOC Sim-Lua and mods + campaign + skirmish AI there permanently lose.

## Key Facts
- Engine Lua is Lua 5.0.1 (string '$Lua: Lua 5.0.1 Copyright (C) 1994-2003 Tecgraf, PUC-Rio' in bin/main.exe) — NOT 5.1/5.3/5.4.
- GPG patched the Lua lexer: '#' = line comment, '!=' = Not equal (556 occurrences vs. only 105x '~='), '!' = not (26x). Vanilla Lua 5.0 does NOT parse this — a custom build is also required for the embed path.
- wasmoon (5.4) and fengari (5.3) are excluded: in addition to the lexer extensions, the scripts use Lua 5.0-only semantics — 'arg'-Varargs (106x), table.getn (480x), 'for k,v in TBL do' without pairs() (2039x), math.mod (42x).
- Total scope of gamedata-Lua: 183,202 LOC (without comments) — AI 83,723 / UI+MAUI 46,255 / Sim core 28,658 / Unit scripts 13,473 / Projectiles+Effects+Props 6,309 / Campaign framework 4,784; plus 28,718 LOC map/campaign scripts under maps/.
- Engine<->Lua limit total: ~490 engine methods (moho.*) + ~410 engine globals + 183 on* callbacks; ONLY for the SIM this reduces to 339 methods + 204 globals = ~543 bindings.
- 36 engine-side base classes 'moho.<x>_methods'; ~15 of which are sim-relevant (unit_, weapon_, projectile_, prop_, shield_, entity_, aibrain_, platoon_, navigator_, blip_, attacker_, CollisionBeamEntity, ScriptTask_, aipersonality_, PathDebugger_).
- Two-tier archive layout: mohodata.scd (526KB, 91 files) = Engine SDK base (class.lua, Blueprints.lua, weapon.lua, defaultweapons.lua, Entity.lua); lua.scd (7.67 MB, 354 files) = game layer overlaying the base (e.g. lua/sim/Unit.lua: 3,757 B in mohodata vs. 142,533 B in lua.scd).
- Unit hierarchy: Unit (Class(moho.unit_methods), 246 methods, States Idle/Dead/Working) -> defaultunits.lua with 31 base classes (StructureUnit, FactoryUnit, AirFactoryUnit, LandFactoryUnit, SeaFactoryUnit, MobileUnit, AirUnit, LandUnit, SeaUnit, SubUnit, HoverLandUnit, WalkingLandUnit, ConstructionUnit, Shield*Unit, ...) -> ~28-30 derivatives per faction (T*/A*/C*/S*) = ~118 faction classes.
- Weapons: Weapon = Class(moho.weapon_methods) with 39 methods; DefaultProjectileWeapon/DefaultBeamWeapon/KamikazeWeapon/BareBonesWeapon as a state machine with 8 states (IdleState, RackSalvoChargeState, RackSalvoFireReadyState, RackSalvoFiringState, RackSalvoReloadState, WeaponUnpackingState, WeaponPackingState, DeadState).
- Unit scripts are only THINLY attached to the classes: 568 scripts, Ø 1,451 bytes, 61% (345) do NOT contain a single function of their own (only 'Class(TLandUnit){ Weapons = {...} }; TypeClass = X'); only 42 scripts >3 KB, 10 >8 KB (the ACUs: XSL0001 27.6 KB / URL0001 25.1 KB / UEL0001 22.2 KB / UAL0001 19.2 KB).
- Custom behavior in unit scripts focuses on: effects/emitters (72 scripts), threads (59), animations (45), state machines (43), enhancements/ACU upgrades (9).
- Campaign: There is NO lua/sim/Ops in FA. The framework is 8 files / 4,784 LOC: ScenarioFramework.lua (68 KB), SimObjectives.lua (63 KB), ScenarioPlatoonAI.lua (108 KB), ScenarioUtilities.lua (62 KB, in mohodata), TriggerManager.lua (60 KB), scenariotriggers.lua (16 KB), SinglePlayerLaunch.lua, cinematics.lua.
- Campaign content: 6 FA missions (X1CA_001..006) + tutorial, 59 Lua files / 1,605 KB — per mission one *_script.lua (~130 KB) plus several *_<m>ai.lua; plus 21 Coop maps (X1MP_*) and 21.6 MB *_save.lua (map unit/marker data).
- Mod system = monkeypatching via Lua: Mods provide 'hook/lua/<path>.lua', which runs after the base file in the same env and re-derives the class (original example schook/lua/sim/weapon.lua: 'local MohoWeapon = Weapon; Weapon = Class(MohoWeapon) { ... }'). Blueprints also know Replace/'Merge = true'/ModBlueprints() hook. Supporting mods 1:1 necessarily means running someone else's Lua.
- Determinism argument PRO Embedding: all clients run the same WASM-Lua build, so the table iteration order ('for k,v in t do') is identical across all clients - with a TS replica you would have to reproduce this order artificially, otherwise the lockstep would drift.

## Details
## 1. Structure & Layering

**Zwei Archive, zwei Schichten** (`lua.scd` überlagert `mohodata.scd`):

| Archive | Size | Files | role |
|---|---|---|---|
| `mohodata.scd` | 526 KB (489 KB entpackt) | 91 | Engine-SDK-Basis |
| `lua.scd` | 7.67 MB (7.21 MB unpacked) | 354 | Game Layer (overrides) |

Proof of superposition: `lua/sim/Unit.lua` exists in **both** — 3,757 B in mohodata (only `Class(moho.unit_methods)` with empty callback stubs) vs. **142,533 B** in lua.scd (the real game unit). Conversely, `lua/sim/weapon.lua` (19,922 B) and `lua/sim/defaultweapons.lua` (38,611 B) are **only** in mohodata — that's where the real weapon logic is.

### lua/system/* — core system (mohodata)
- **`class.lua` (13,273 B)** — complete custom OO system: `Class(Base1,Base2){...}` with multiple inheritance (`__bases`, `__spec`, `__index`), ambiguity bug in Diamond, plus **`State{...}` / `ChangeState()`**: States are classes that derive from the container class; `ChangeState` swaps the metatable of the *object*, kills the old `Main` thread, calls `OnExitState` → setmetatable → `OnEnterState` → forks `Main`. Also `ConvertCClassToLuaClass()` for Engine C classes.
- **`Blueprints.lua` (11,644 B)** — Pipeline: Engine scans `.bp` files → these call `UnitBlueprint()`/`PropBlueprint()`/`ProjectileBlueprint()`/`MeshBlueprint()`/`EmitterBlueprint()`/`BeamBlueprint()`/`TrailEmitterBlueprint()` → land in `original_blueprints[group][id]` → then `ModBlueprints(all_bps)` (mod hook) → engine registered final; The sim and user pages each get their own copy. Mod rules: same ID = replace; `Merge = true` = `table.merged`; Hooking `ModBlueprints()` = arbitrary manipulation.
- **`import.lua` (2,383 B)** — Module system: `import('/lua/x.lua')` creates an Env with `__index = _G` per module, cached in `__modules`, tracks dependencies (`used_by`) for hot reload (`dirty_module` on `__diskwatch`). **This is the hub for mod hooks.**
- Next: `trashbag.lua` (resource cleanup, `self.Trash:Add()`), `utils.lua`, `MultiEvent.lua`, `SingleEvent.lua`, `repr.lua`, `Localization.lua`, `saveload.lua`, `BuffBlueprints.lua`.

### Sim classes
- `lua/sim/Entity.lua` (mohodata, 647 B): `Entity = Class(moho.entity_methods)` + `_c_CreateEntity(self,spec)` in `__init`.
- `lua/sim/Unit.lua` (lua.scd, **142,533 B, 246 methods**), States: `IdleState`, `DeadState`, `WorkingState`. Imports Entity, defaultexplosions, EffectTemplates, EffectUtilities, game, utilities, **shield**, **Buff**, AIUtils. Includes `SyncMeta` (Sim→UI sync table above `Sync.UnitData[id]`).
- `lua/defaultunits.lua` (lua.scd, **65.968 B, 121 Methoden**) — **31 Basisklassen**:
  - `Unit` → `StructureUnit` → `FactoryUnit` → `AirFactoryUnit` / `LandFactoryUnit` / `SeaFactoryUnit` / `QuantumGateUnit`
  - `StructureUnit` → `AirStagingPlatformUnit`, `ConcreteStructureUnit`, `EnergyCreationUnit`, `EnergyStorageUnit`, `MassCollectionUnit`, `MassFabricationUnit`, `MassStorageUnit`, `RadarUnit`, `RadarJammerUnit`, `SonarUnit`, `ShieldStructureUnit`, `TransportBeaconUnit`, `WallStructureUnit`
  - `Unit` → `MobileUnit` → `WalkingLandUnit`, `SubUnit`, `AirUnit`, `HoverLandUnit`, `LandUnit`, `ConstructionUnit`, `SeaUnit`; plus `ShieldHoverLandUnit`/`ShieldLandUnit`/`ShieldSeaUnit`
  - States hier: `IdleState`, `UpgradingState`, `BuildingState`, `RollingOffState`
- Faction layers: `terranunits.lua` (30 classes), `aeonunits.lua` (28), `cybranunits.lua` (28), `seraphimunits.lua` (28) — pure derivatives `T*`/`A*`/`C*`/`S*` + faction FX/build animations.
- `lua/sim/weapon.lua` (mohodata, 19.922 B): `Weapon = Class(moho.weapon_methods)`, **39 Methoden** (SetupTurret, Aim-Manipulatoren, GetDamageTable, CreateProjectileForWeapon, SetWeaponPriorities, Buff-Handling …).
- `lua/sim/defaultweapons.lua` (mohodata, 38.611 B): `DefaultProjectileWeapon`, `KamikazeWeapon`, `BareBonesWeapon`, `DefaultBeamWeapon` — **State-Machine mit 8 States**: `IdleState`, `RackSalvoChargeState`, `RackSalvoFireReadyState`, `RackSalvoFiringState`, `RackSalvoReloadState`, `WeaponUnpackingState`, `WeaponPackingState`, `DeadState`. Fraktions-Waffen: `terranweapons.lua`, `aeonweapons.lua`, `cybranweapons.lua`, `seraphimweapons.lua`.
- `lua/shield.lua` (17.454 B): `Shield = Class(moho.shield_methods, Entity)` → `UnitShield`, `AntiArtilleryShield`.
- `lua/sim/Buff.lua` (20,961 B) + `BuffDefinitions.lua`, `sim/AdjacencyBuffs.lua` (**60,459 B!**), `AdjacencyBuffFunctions.lua`, `CheatBuffs.lua`, `OpBuffDefinitions.lua` — buff system including adjacency bonuses.
- Projektile: `lua/sim/Projectile.lua` (17.416 B, `Class(moho.projectile_methods, Entity)`), `lua/sim/DefaultProjectiles.lua` (mohodata) mit `NullShell`, `EmitterProjectile`, `Single/MultiBeamProjectile`, `Single/MultiPolyTrailProjectile`, `Single/MultiCompositeEmitterProjectile`, `OnWaterEntryEmitterProjectile`; Fraktions-Projektile `aeon-/cybran-/terran-/seraphimprojectiles.lua` (30–37 KB je).
- `lua/defaultcollisionbeams.lua` (21,692 B): 16 beam classes (Ginsu, ParticleCannon, PhasonLaser, TractorClaw, OrbitalDeathLaser…).
- Effekte: `lua/EffectTemplates.lua` (**180.301 B** — reine Datentabellen), `EffectUtilities.lua` (56.566 B), `defaultexplosions.lua`.

## 2. How close are unit scripts to the classes? — **Very thin.**

568 `*_script.lua` in `units.scd`, together only **804.8 KB / 13,473 LOC**, Ø **1,451 bytes**.

| bucket | Number |
|---|---|
| ≤ 1 KB (rein deklarativ) | 362 (64%) |
| 1–3 KB | 164 |
| 3–8 KB | 32 |
| > 8 KB (schweres Custom) | 10 |
| **0 own functions** | **345 (61%)** |

Typical script (`units/UEL0201/UEL0201_script.lua`, 683 B) is completely declarative:
```
local TLandUnit = import('/lua/terranunits.lua').TLandUnit
local TDFGaussCannonWeapon = import('/lua/terranweapons.lua').TDFGaussCannonWeapon
UEL0201 = Class(TLandUnit) { Weapons = { MainGun = Class(TDFGaussCannonWeapon) {} }, }
TypeClass = UEL0201
```
`TypeClass` is the export that the engine reads. So the script only selects **base class + weapon classes**; all behavior comes from `defaultunits.lua` / `<faction>units.lua` / `defaultweapons.lua`, all values ​​from `_unit.bp`.

What the scripts that *do* have code do: effects/emitters (72), threads `ForkThread`/`WaitSeconds` (59), animations `PlayAnim`/`CreateAnimator` (45), own state machines (43), enhancements/ACU upgrades (9). The 10 heavy ones are practically only the commanders: `XSL0001` 27.6 KB, `URL0001` 25.1 KB, `UEL0001` 22.2 KB, `UAL0001` 19.2 KB, then `URL0301`/`XSL0301` (SACUs), `URL0402`, `XRL0403`, `UEL0301`, `UAL0301`.

Next to it: 568 `*_unit.bp` (4.5 MB) with all numerical values.

## 3. Engine↔Lua-Grenze (Umfang)

**Engine → Lua (Callbacks):** **183 distinkte `On*`-Handler** im Korpus definiert — u.a. `OnPreCreate`, `OnCreate`, `OnStartBeingBuilt`, `OnStopBeingBuilt`, `OnDamage`, `OnKilled`, `OnDestroy`, `OnCollisionCheck`, `OnCollisionCheckWeapon`, `OnImpact`, `OnMotionHorzEventChange`/`Vert`/`Turn`, `OnLayerChange`, `OnTerrainTypeChange`, `OnAdjacentTo`/`OnNotAdjacentTo`, `OnStartBuild`/`OnStopBuild`, `OnStartReclaim`/`OnStopReclaim`, `OnStartCapture`/`OnStopCapture`, `OnTransportAttach`/`OnTransportDetach`, `OnVeteranLevel`, `OnShieldEnabled`/`OnShieldDisabled`, `OnNukeLaunched`, `OnIntelEnabled`/`OnIntelDisabled`, `OnEnterState`/`OnExitState`, `OnAnimationFinished`, `OnWeaponFired`, `OnGotTarget`/`OnLostTarget`, `OnRunOutOfFuel`, `OnEnterWater`/`OnExitWater`, `OnTeleportUnit`, …

**Lua → Engine:**

| Area | Total | **Sim only** |
|---|---|---|
| Methods on Engine Objects (`moho.*`) | **490** | **339** |
| Global Engine Features | **410** | **204** |
| **Summe** | **900** | **≈ 543** |
| Engine-Basisklassen `moho.<x>_methods` | **36** | **≈ 15** |

(Determined: all `:Method(` calls or capitalized globals in the entire corpus minus everything that is defined somewhere in Lua.)

Meistgenutzte Engine-Methoden: `GetBlueprint` (742x), `GetArmy` (426), `Hide` (227), `SetNeedsFrameUpdate` (225), `SetTurnRate` (199), `SetAlpha` (187), `Show`, `SetSpeed`, `SetTargetSpeed`, `SetRate`, `SetGoal`, `SetVelocity`, `BeenDestroyed`, `IsUnitState`, `CreateProjectile`, `PlayAnim`, `GetCurrentLayer`, `HideBone`, `SetCollisionShape`, `TrackTarget`, `PlaySound`, `SetMesh` …

Meistgenutzte Engine-Globals: `EntityCategoryContains` (277x), `Random` (218), `CreateAttachedEmitter` (204), `LOG`, `CreateRotator` (124), `PlaySound`, `KillThread`, `ParseEntityCategory` (91), `WaitTicks` (86), `CreateEmitterAtEntity`, `VDist2`, `Vector`, `CreateAnimator`, `IssueClearCommands`, `DamageArea` (54), `EntityCategoryFilterDown`, `CreateSlider`, `CreateDecal`, `Warp`, `CreateLightParticle`, `GetSurfaceHeight`, `DamageRing`, `IssueMove`, `TrashBag`, `AttachBeamEntityToEntity`, `SimCallback`, `GetGameTimeSeconds` …

Sim relevant `moho` classes: `unit_methods`, `weapon_methods`, `projectile_methods`, `prop_methods`, `shield_methods`, `entity_methods`, `aibrain_methods`, `platoon_methods`, `navigator_methods`, `blip_methods`, `attacker_methods`, `CollisionBeamEntity`, `ScriptTask_Methods`, `aipersonality_methods`, `PathDebugger_methods`. The rest (`control_`, `bitmap_`, `text_`, `edit_`, `group_`, `lobby_`, `cursor_` …) is UI/MAUI.

## 4. Kampagne

**There is no `lua/sim/Ops` in FA** (verified: no hit in lua.scd/mohodata.scd/mods.scd/schook.scd). The campaign framework lies flat in `lua/`:

| File | Size |
|---|---|
| `lua/ScenarioPlatoonAI.lua` | 108.459 B |
| `lua/ScenarioFramework.lua` | 68.018 B |
| `lua/SimObjectives.lua` | 63.160 B |
| `lua/sim/ScenarioUtilities.lua` (mohodata) | 62.027 B |
| `lua/TriggerManager.lua` | 60.192 B |
| `lua/scenariotriggers.lua` | 15.940 B |
| `lua/SinglePlayerLaunch.lua` | 11.362 B |
| `lua/TauntManager.lua`, `lua/cinematics.lua` | 12,3 / 6,2 KB |

Total framework: **8 files / 4,784 LOC** — manageable.

**Contents:** 6 FA missions `X1CA_001..006` + `X1CA_TUT`, together **59 Lua files / 1,605 KB**. Per mission: a `X1CA_00N_script.lua` (~131 KB!), a `_operation.lua`, a `_scenario.lua`, `_strings.lua` (64 KB texts) and 3-5 mission AI files (`_m1orderai.lua` 37.7 KB, `_m4seraphimai.lua` 22.4 KB ...). Plus 21 coop maps (`X1MP_*`, 28 files / 20 KB) and 80 skirmish maps (`SCMP_*`, 61 KB). Separately: **61 `*_save.lua` with 21.6 MB** Map data (units, markers, armies) — pure data tables, but executed as Lua.

Total map/campaign lua: **28,718 LOC**.

## 5. Mod system (crucial for the recommendation)

Two ways, both **requiring running foreign Lua code**:
1. **Blueprint level** (declarative, portable): ID-Replace, `Merge = true`, or `ModBlueprints(all_bps)`-Hook.
2. **Script Hooks** (Code, NOT portable): Mod puts `hook/lua/<originalpfad>.lua`; the file runs after the original in the same module env and re-derives the class. Original receipt — `schook/lua/sim/weapon.lua` from `schook.scd`:
   ```
   local MohoWeapon = Weapon
   Weapon = Class(MohoWeapon) { GetDamageTable = function(self) ... end, }
   ```
   This is monkeypatching via `Class()` + the `import.lua` env. `schook.scd` itself uses exactly this mechanism for 8 files (`sim/weapon.lua`, `simInit.lua`, `SimSync.lua`, `UserSync.lua`, `maui/window.lua` …). Mod management: `lua/mods.lua` (15,749 B, mohodata) with `GetGameMods()`, `GetUiMods()`, `GetCampaignMods()`, `GetDependencies()`.

**Consequence:** A pure TS replica cannot in principle load script mods - they are Lua, which is programmed exactly against `Class`, `import`, `Weapon`, `Unit` and the `moho.*` signatures.

## 6. Aufwandsvergleich & Empfehlung

### Way A — **Embed Lua** (recommended)
**Steps:**
1. **Own Lua build → WASM.** wasmoon/fengari are down (5.4/5.3). Vanilla Lua 5.0.1 (~13k LOC C, small, well understood) with 3 lexer patches in `llex.c`: `#` as line comment, `!=` → `TK_NE`, `!` → `TK_NOT`. The original scripts then parse **unchanged**. Emscripten build. Effort: ~1–2 weeks including JS bridge.
2. **`moho.*` bindings in TypeScript**: ~543 sim functions (339 methods + 204 globals) — this is the actual work, but **exactly as necessary in the replica path**, because these are physics, pathfinding, collision, economy tick, animations, emitters, rendering.
3. Tighten the Sim-Init chain: `globalInit.lua` → `SessionInit.lua` → `simInit.lua` → `Blueprints.lua` pipeline → `import.lua`.

**What you get for free:** 28,658 LOC Sim Core, 13,473 LOC Unit Scripts, 6,309 LOC Projectiles/Effects, 4,784 LOC Campaign Framework, **83,723 LOC Skirmish AI**, 28,718 LOC Campaign/Map Scripts — **and all mods**. Balance and behavior are 1:1 by design because it's *the same code*.

### Way B — **Recreate in TypeScript**
- You **still** have to build the 543 engine bindings (they are the engine).
- **Additionally**: ~53,200 LOC Sim-Lua port to TS (Unit 246 methods, default units 121, Weapon 39 + 8-state machine, shields, buffs incl. 60 KB adjacency, 4 faction layers, 568 unit scripts, 16 beam classes, projectile hierarchy).
- Plus replicate your own `Class`/`State` system with multiple inheritance.
- Plus 83,723 LOC AI and 28,718 LOC campaign, if they ever come.
- **Mods: dauerhaft verloren.**
- Every subtle behavior deviation (rounding, iteration order, tick semantics) is its own bug.

**Path B is a true superset of Path A.** Path A is strictly less work *and* delivers more.

### Zusatzargument: Determinismus
`for k,v in t do` (2,039 occurrences) iterates in Lua 5.0 hash order. If all clients are running the same WASM-Lua build, this order is **identical** across all clients → Lockstep holds. With a TS replica, you would have to artificially reproduce the iteration order or convert every affected point to deterministic sorting - otherwise the simulation would drift.

### Hybrid pitfall to avoid
"wasmoon + Transpiler 5.0→5.4" seems tempting, but is the worst option: you need a complete Lua 5.0 parser (for `#`, `!=`, `!`, `arg`, `table.getn`, `math.mod`), you have to `for k,v in t do` → `pairs(t)` rewrites and thus gives you **exactly the iteration order divergence** that breaks the lockstep - and you would also have to chase mods through the transpiler at loading time. The patch to Lua 5.0.1 is significantly smaller and semantically exact.

### Recommended order
1. Lua 5.0.1+Patches → WASM, boot `import`/`Class`/`Blueprints`, load a blueprint.
2. `moho.entity_methods` + `moho.unit_methods` minimal (Position, Bones, Health, GetBlueprint) → first unit appears and is controlled by original Lua.
3. Expand bindings incrementally according to usage frequency (list above according to call count) — `GetBlueprint`/`GetArmy`/`Hide`/`SetNeedsFrameUpdate` first.
4. Weapon-Bindings + `CreateProjectile` → Kampf.
5. AI and campaign are then added without any further porting work.

## Refs
- C:\Program Files (x86)\Steam\steamapps\common\Supreme Commander Forged Alliance\bin\main.exe (16.714.240 B) — enthält '$Lua: Lua 5.0.1 Copyright (C) 1994-2003 Tecgraf, PUC-Rio'
- C:\Program Files (x86)\Steam\steamapps\common\Supreme Commander Forged Alliance\bin\MohoEngine.dll (9.827.584 B)
- gamedata/lua.scd (7,671,907 B; 354 ​​Lua files, 7.21 MB unpacked) — game layers
- gamedata/mohodata.scd (526,529 B; 91 files, 489 KB) — Engine SDK base
- gamedata/units.scd (1,114,843,505 B) — 568 *_script.lua (804.8 KB) + 568 *_unit.bp (4.5 MB)
- gamedata/schook.scd (25,568 B) — 8 hook files; Evidence of mod monkey patching
- gamedata/mods.scd (1.239.705 B)
- mohodata.scd :: lua/system/class.lua (13,273 B) — Class()/State()/ChangeState(), multiple inheritance
- mohodata.scd :: lua/system/Blueprints.lua (11,644 B) — Blueprint pipeline + ModBlueprints()/Merge
- mohodata.scd :: lua/system/import.lua (2,383 B) — module env, dependency tracking, hot reload
- mohodata.scd :: lua/sim/Unit.lua (3.757 B) — Base Stub Class(moho.unit_methods)
- mohodata.scd :: lua/sim/Entity.lua (647 B) — Class(moho.entity_methods)
- mohodata.scd :: lua/sim/weapon.lua (19.922 B, 39 Methoden)
- mohodata.scd :: lua/sim/defaultweapons.lua (38.611 B) — 8-State-Waffen-FSM
- mohodata.scd :: lua/sim/DefaultProjectiles.lua (7.453 B)
- mohodata.scd :: lua/sim/CollisionBeam.lua (11.227 B)
- mohodata.scd :: lua/sim/ScenarioUtilities.lua (62.027 B)
- mohodata.scd :: lua/mods.lua (15.749 B) — GetGameMods/GetUiMods/GetCampaignMods
- mohodata.scd :: lua/simInit.lua (9.510 B)
- mohodata.scd :: lua/system/trashbag.lua (1.221 B)
- lua.scd :: lua/sim/Unit.lua (142,533 B, 246 methods, states Idle/Dead/Working)
- lua.scd :: lua/defaultunits.lua (65.968 B, 31 Basisklassen, 121 Methoden)
- lua.scd :: lua/terranunits.lua (29.457 B) / seraphimunits.lua (28.549) / cybranunits.lua (21.194) / aeonunits.lua (11.829)
- lua.scd :: lua/shield.lua (17.454 B) — Shield/UnitShield/AntiArtilleryShield
- lua.scd :: lua/sim/Buff.lua (20.961 B) + lua/sim/AdjacencyBuffs.lua (60.459 B)
- lua.scd :: lua/sim/Projectile.lua (17.416 B)
- lua.scd :: lua/defaultcollisionbeams.lua (21,692 B) — 16 beam classes
- lua.scd :: lua/EffectTemplates.lua (180.301 B) + lua/EffectUtilities.lua (56.566 B)
- lua.scd :: lua/aibrain.lua (169.471 B) + lua/platoon.lua (130.780 B) + lua/basetemplates.lua (1.166.619 B) — Skirmish-KI
- lua.scd :: lua/ScenarioPlatoonAI.lua (108.459 B), lua/ScenarioFramework.lua (68.018 B), lua/SimObjectives.lua (63.160 B), lua/TriggerManager.lua (60.192 B)
- schook.scd :: schook/lua/sim/weapon.lua (2.154 B) — Hook-Pattern 'local MohoWeapon = Weapon; Weapon = Class(MohoWeapon){...}'
- units.scd :: units/UEL0201/UEL0201_script.lua (683 B) — typical declarative unit script
- units.scd :: units/XSL0001/XSL0001_script.lua (27,639 B) — largest unit script (Seraphim ACU)
- maps/X1CA_001/ — X1CA_001_script.lua (131.389 B), _m1orderai.lua (37.740 B), _strings.lua (64.603 B), _save.lua (2.343.934 B)
- maps/ — 61 maps: 6 campaign (X1CA_001..006) + tutorial + 21 coop (X1MP_*) + 80 SCMP skirmish lua; Map-Lua total 28,718 LOC
