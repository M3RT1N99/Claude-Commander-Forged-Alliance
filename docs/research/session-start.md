# Session start 1:1 — from the lobby to the running map

How the original starts a skirmish session, and what else our engine does for it
owes. Receipts: `Cfile/ForgedAlliance.exe.c` (line numbers), original Lua
(`<datei>:<zeile>`).

## 1. Überblick

Today [src/main.ts](../../src/main.ts) parses the map itself (`_save.lua` → marker
`ARMY_1`, lines 413-432) and leaves the ACU via `spawnViaLua('uel0001')` (main.ts:483)
appear at this point. [src/sim/session.ts](../../src/sim/session.ts) builds
`ScenarioInfo` manually from a TS interface. Both are game logic in TS.

In the original, Lua does this. The engine does exactly four things:

1. It loads `/lua/simInit.lua` into the fresh sim state (Cfile:1071613).
2. She writes `ScenarioInfo` (the table from the `_scenario.lua` **plus**
   `ArmySetup`) as global in the sim (Cfile:1071886-1071889).
3. She calls `SetupSession()` (Cfile:1071898), creates the armies
   (`Sim::CreateArmies`, Cfile:1072015), calls `BeginSession()` (Cfile:1072090) and
   `Sim::PostInitialize` (Cfile:1072103).
4. It provides the `sim_SimInits` bindings that the Lua calls in the process.

**The card reads the Sim-Lua itself**: `SetupSession()` does
`doscript(ScenarioInfo.save, ScenarioInfo.Env)` (siminit.lua:93) and
`doscript(ScenarioInfo.script, …)` (siminit.lua:98). The marker tree is after that
`Scenario.MasterChain._MASTERCHAIN_.Markers` (scenarioutilities.lua:54).

## 2. Ablauf/Callchain

### 2.1 UI: Lobby → `LaunchSinglePlayerSession(sessionInfo)`

`LaunchSinglePlayerSession` is a **UI-VM** binding (`scr_UserInits`,
Cfile:1321740; Hilfetext: *„LaunchSinglePlayerSession(sessionInfo) -- launch a new
single player session."*). She takes **a** table and hands it over
`Moho::WLD_SetupSessionInfo` (Cfile:1321385). Fields read — there are more
not:

| field | receipt |
|---|---|
| `scenarioInfo` (table → serialized) | Cfile:1321432 |
| `scenarioMods` | Cfile:1321444 |
| `teamInfo` (array, one entry per army) | Cfile:1321455 |
| `RandomSeed` (missing ⇒ system time) | Cfile:1321475 |
| `scenarioInfo.map` (Path of `.scmap`) | Cfile:1321529 |
| `createReplay` | Cfile:1321539 |
| `playerName` | Cfile:1321545 |

The **Skirmish blueprint** for this table is completely in
`SinglePlayerLaunch.lua:228-295` (`SetupCommandLineSkirmish`) — this is the honest one
Way without network lobby:

```lua
scenario   = import('/lua/ui/maputil.lua').LoadScenario('/maps/SCMP_009/SCMP_009_scenario.lua')
scenario.Options = GetCommandLineOptions()                 -- defaultOptions, SPL:123-135
sessionInfo.scenarioInfo = scenario
sessionInfo.teamInfo[i]  = LobbyComm.GetDefaultPlayerOptions(name)  -- lobbycomm.lua:29
   -- Team, PlayerColor, ArmyColor, StartSpot, Ready, Faction, PlayerName,
   -- AIPersonality, Human, Civilian  … + .ArmyName = armies[i]
armies = scenario.Configurations.standard.teams[1].armies  -- SPL:259
extras = MapUtils.GetExtraArmies(scenario)                 -- SPL:280 → NEUTRAL_CIVILIAN
LaunchSinglePlayerSession(sessionInfo)                     -- SPL:323
```

`LoadScenario` (maputil.lua:21-30) is itself just `doscript('/lua/dataInit.lua', env)`
+ `doscript(scenName, env)` — `dataInit.lua` (34 lines) provides the DSL constructors
`BOOLEAN/INTEGER/FLOAT/VECTOR2/VECTOR3/RECTANGLE/STRING/GROUP`, which is in `_scenario.lua`
and `_save.lua`. The engine does the same in
`Moho::WLD_LoadScenarioInfo` (Cfile:1320686-1320693).

The full network lobby (`lobby.lua`) is **not** necessary for this: it goes over
`lobbyComm:LaunchGame(gameInfo)` (lobby.lua:879) and the `CLobby` engine class — too
im Single-Player (lobby.lua:882: `if singlePlayer … LaunchGame()`).

### 2.2 The Sim Boot: `Moho::Sim::Setup` (Cfile:1071723)

```
Moho::Sim::Sim
  SCR_LuaDoScript(mLuaState, "/lua/simInit.lua")          Cfile:1071613
  SCR_LuaDoScript(mLuaState, "/lua/system/saveload.lua")  Cfile:1071622
Moho::Sim::Setup(info)                                    Cfile:1071723
  " Sim Setup 1"   Cfile:1071788   Random-Seed, PhysConstants (Gravitation −4.9)
  " Sim Setup 2"   Cfile:1071850   ScenarioInfo aus info->mScenarioInfo deserialisieren;
                                   je Armee ArmySetup[ArmyName] = teamInfo[i],
                                   dazu ArmySetup[…].ArmyIndex = i (1-basiert!)  :1071871
                                   _G.ScenarioInfo = <tabelle>                   :1071889
  " Sim Setup 3"   Cfile:1071895   SetupSession()   ← Lua                        :1071898
                                   CSimResources (mDeposits = leer)              :1071935
                                   ScenarioInfo.Options merken                   :1071947
  " Sim Setup 4"   Cfile:1071958   EntityDB, CommandDB, EffectManager
  " Sim Setup 5"   Cfile:1072012   Sim::CreateArmies(...)                        :1072015
  " Sim Setup 7"   Cfile:1072049   Props aus info->mProps via PROP_Create        :1072071
                                   (übersprungen bei /noprops; " NUM PROPS = %d")
  " Sim Setup 8"   Cfile:1072086   BeginSession()   ← Lua                        :1072090
                                   Sim::PostInitialize(Options)                  :1072103
```

**Note:** `SetupSession()` runs **before** a single army exists;
`BeginSession()`, **after** all armies/brains are there, but **before** there are units
(siminit.lua:133-135 says it exactly like that).

### 2.3 `Sim::CreateArmies` (Cfile:1073404)

Je Armee `i` (0-basiert):

- `func_SimArmyAlloc(sim, i, launchInfo[i], ArmySetup-LuaObject[i], Options, isFocus)`
  - `GenerateArmyStart(army)` — **first a RANDOM starting position**
    (Cfile:1017228; Impl 1017961: `x = rand·(width−1)`, `z = rand·(height−1)`)
  - reads from the `ArmySetup` entry: `ArmyName` (:1017245), `PlayerName` (:1017253),
    `Civilian` (:1017261), `Human`/`AIPersonality` (:1017268),
    `ArmyColor`/`PlayerColor` (−1, :1017275/:1017281),
    **`Faction` → `mFaction = Faction − 1`** (:1017289)
  - from `ScenarioInfo.Options`: `FogOfWar` (:1017363), `UnitCap` (:1017631),
    `NoRushOption` (:1017642) + `ScenarioInfo.norushradius` (:1017683)
- then the engine **Lua** calls: `OnCreateArmyBrain(i+1, brain, ArmyName, PlayerName)`
  (Cfile:1073457-1073545; `Call_IntBrainStr2`)

`brain:GetFactionIndex()` returns `mFaction + 1` (Cfile:733604) — so 1-based,
directly as an index in `factions.lua`.

### 2.4 The hook that holds everything together: `/schook`

`bin/SupComDataPath.lua` (game directory, not an archive):

```lua
mount_dir(InitFileDir .. '\\..\\gamedata\\*.scd', '/')
mount_dir(InitFileDir .. '\\..', '/')
hook = { '/schook' }
```

The engine reads `hook` (Cfile:505923-505936 → `Moho::SCR_AddHookDirectory`) and hangs
with **every** script load additionally `<hookdir>..<pfad>` (Cfile:595822-595866;
Log line `"Hooked %s with %s"`). `schook.scd` contains exactly 8 files:

```
schook/lua/globalinit.lua   schook/lua/sessioninit.lua  schook/lua/siminit.lua
schook/lua/simsync.lua      schook/lua/usersync.lua     schook/lua/userinit.lua
schook/lua/maui/window.lua  schook/lua/sim/weapon.lua
```

**`schook/lua/siminit.lua` is the missing half session start** — without it there is
neither resource occurrences nor starting positions:

```lua
local baseBeginSession = BeginSession
function BeginSession()
    ScenarioUtils.CreateProps()          -- schook/lua/siminit.lua:17
    ScenarioUtils.CreateResources()      -- :18
    baseBeginSession()                   -- :20
    ForkThread(import('/lua/aibrain.lua').CollectCurrentScores)   -- :23
    ForkThread(import('/lua/aibrain.lua').SyncCurrentScores)      -- :24
    ForkThread(import('/lua/victory.lua').CheckVictory, ScenarioInfo) -- :27
end

local baseOnCreateArmyBrain = OnCreateArmyBrain
function OnCreateArmyBrain(index, brain, name, nickname)
    ScenarioUtils.InitializeStartLocation(name)   -- :47   ← DIE Startposition
    ScenarioUtils.SetPlans(name)                  -- :48
    baseOnCreateArmyBrain(index,brain,name,nickname)
end
```

`CreateProps()`/`CreateResources()` are not called **anywhere else** — in
`lua.scd`/`mohodata.scd`/`units.scd` and they do not appear in the map scripts.

### 2.5 Starting position, ACU, resources — the Lua chain

```lua
-- scenarioutilities.lua:1026
function InitializeStartLocation(strArmy)
    local start = GetMarker(strArmy)                       -- Marker 'ARMY_1' … 'ARMY_8'
    if start then SetArmyStart(strArmy, start.position[1], start.position[3])
    else          GenerateArmyStart(strArmy) end
end
```

`SetArmyStart` only takes **x and z** (help text `"army, x, z"`, Cfile:1024479).

```lua
-- scenarioutilities.lua:436  InitializeArmies()   ← das ruft das Karten-Skript
for iArmy, strArmy in ListArmies() do
    SetArmyEconomy(strArmy, Scenario.Armies[strArmy].Economy.mass, …energy)   -- :456
    if (not civ and ShouldCreateInitialArmyUnits()) or (civ and civOpt != 'removed') then
        tblGroups[strArmy], cdrUnit = CreateInitialArmyGroup(strArmy, not civ)  -- :469
        cdrUnit:SetCustomName(ArmyBrains[iArmy].Nickname)                       -- :471
    end
    -- WRECKAGE-Gruppe → unit:CreateWreckageProp(0); unit:Destroy()             -- :475-482
    SetAlliance(iArmy, iEnemy, 'Enemy' | 'Neutral')                             -- :488-500
end

-- scenarioutilities.lua:331
function CreateInitialArmyGroup(strArmy, createCommander)
    local tblGroup = CreateArmyGroup(strArmy, 'INITIAL')   -- bei SCMP-Karten LEER
    if createCommander and (tblGroup == nil or 0 == table.getn(tblGroup)) then
        local factionIndex   = GetArmyBrain(strArmy):GetFactionIndex()
        local initialUnitName = import('/lua/factions.lua').Factions[factionIndex].InitialUnit
        cdrUnit = CreateInitialArmyUnit(strArmy, initialUnitName)  -- 'uel0001' etc.
        if ScenarioInfo.Options['PrebuiltUnits'] == 'Off' then
            cdrUnit:HideBone(0, true)
            ForkThread(CommanderWarpDelay, cdrUnit, 3)  -- :PlayCommanderWarpInEffect nach 3 s
        end
    end
end
```

`CreateInitialArmyUnit(army, bpId)` (Cfile:1025200): Position = `army:GetArmyStartPos()`
(x,z), **`pos.y = 0.0`** (Cfile:1025261), Orientierung = Identität,
`mComplete = 1` (Cfile:1025269). The height is set by the unit controller.

`ShouldCreateInitialArmyUnits()` is simply `not CFG_GetArgOption("/noinitialunits")`
(Cfile:1024331) — usually `true`.

**Resource Deposit** (`CreateResources()`, scenarioutilities.lua:371) — exactly what
what we are missing, and the reason why our invented rings were wrong:

```lua
for i, tblData in GetMarkers() do
    if tblData.resource then
        CreateResourceDeposit(tblData.type, pos[1], pos[2], pos[3], tblData.size)
        if tblData.type == "Mass" then
            albedo = "/env/common/splats/mass_marker.dds";  sx, sz, lod = 2, 2, 100
            CreatePropHPR('/env/common/props/massDeposit01_prop.bp', pos…, Random(0,360),0,0)
        else
            albedo = "/env/common/splats/hydrocarbon_marker.dds"; sx, sz, lod = 6, 6, 200
            CreatePropHPR('/env/common/props/hydrocarbonDeposit01_prop.bp', …)
        end
        CreateSplat(tblData.position, 0, albedo, sx, sz, lod, 0, -1, 0)   -- :419
    end
end
```

So: **a splat with the original texture + a prop model**, not a ring. The markers in
`_save.lua` look like this (SCMP_009: 108× `type='Mass'`, 8× `'Hydrocarbon'`, all with
`resource = BOOLEAN(true)`, `size = FLOAT(1.0)`, `amount = FLOAT(100.0)`).

`CreateResourceDeposit(type, x, y, z, size)` (Cfile:687675) → `AddDepositPoint`
(Cfile:686680): Rechteck = `trunc(x − size/2) … +size`, `trunc(z − size/2) … +size`,
as **int16 cells**. So a measure point is exactly **a 1×1 cell** — the same thing
Grid that the mass extractor snaps to (`COORDS_GridSnap`, see CLAUDE.md).

### 2.6 `BeginSession()` (siminit.lua:137) and `PostInitialize`

- `LocGlobals.PlayerName = ArmyBrains[GetFocusArmy()].Nickname` (:141)
- `ScenarioInfo.Env.OnPopulate(ScenarioInfo)` → **the map script**
  (`SCMP_009_script.lua`: `ScenarioUtils.InitializeArmies()`), then `OnStart` (:145-146).
  Default-Implementierungen: `scenarioEnvironment.lua:15/19` (leer).
- Teams from `ScenarioInfo.ArmySetup[*].Team > 1` → `SetAlliance(a,b,"Ally")` (:150-202)
- `ScenarioInfo.Options.RestrictedCategories` → `AddBuildRestriction` (:166-192)
- Effekt-Marker (`type == 'Effect'`) → `Entity()` + `CreateEmitterAtBone` (:205-219)
- `Sim::PostInitialize` (Cfile:1073487): only if `Options.PrebuiltUnits == 'On'` →
  each non-civilian army Lua-`InitializePrebuiltUnits(armyName)` (siminit.lua:128)

At the end of the file of `simInit.lua` (line 232) there is **at top level**
`Prefetcher = CreatePrefetchSet()` — the binding must exist, otherwise the file will load
not at all.

## 3. Missing engine bindings

Compared against [engine-api.md](engine-api.md) (`sim_SimInits`) and the current status in
`src/engine-lua/*.lua`. “There” = already implemented.

| Bindung | Semantik (Decomp) | Beleg | Braucht |
|---|---|---|---|
| `ListArmies` | Array of army names, 1-based | Cfile:1024373 (Sim) | siminit.lua:188, scenarioutilities.lua:438 |
| `SetArmyStart(army, x, z)` | `army.mVarDat.mArmystart = {x,z}` (2D!) | Cfile:1024490, Hilfe `"army, x, z"` | scenarioutilities.lua:1029 |
| `GenerateArmyStart(army)` | Zufalls-Start `rand·(w−1)`, `rand·(h−1)` | Cfile:1017961 | scenarioutilities.lua:1031 |
| `brain:GetArmyStartPos()` | liefert `mArmystart` (x, z) | Cfile:1016481 | aibrain.lua:438, CreateInitialArmyUnit |
| `CreateInitialArmyUnit(army, bpId)` | Unit an `GetArmyStartPos()`, `y = 0`, complete | Cfile:1025200 | scenarioutilities.lua:338 |
| `ShouldCreateInitialArmyUnits()` | `not /noinitialunits` ⇒ `true` | Cfile:1024331 | scenarioutilities.lua:442 |
| `CreateResourceDeposit(t,x,y,z,size)` | Deposit-Rechteck `trunc(p−size/2)+size` | Cfile:687675, 686680 | scenarioutilities.lua:375 |
| `CreatePropHPR(bp,x,y,z,h,p,r)` | Prop mit Euler-Winkeln | `luadef_CreateProp` Cfile:1015362 | scenarioutilities.lua:360/388/398 |
| `CreateProp(bp, pos)` | ditto, without rotation | Sim Global (engine-api.md) | Wrecks, Reclaim |
| `CreateUnitHPR(bp,army,x,y,z,h,p,r)` | named card unit | Sim Global | scenarioutilities.lua:204 |
| `SetAlliance(a, b, 'Ally'\|'Enemy'\|'Neutral')` | Allianz-Bitset beider Armeen | Sim-Global | siminit.lua:198, scenarioutilities.lua:493 |
| `SetArmyPlans(army, plans)` | AI-Plan-String | Sim-Global | scenarioutilities.lua:1037 |
| `InitializeArmyAI(name)` | Engine creates AI threads | Sim Global | siminit.lua:122 |
| `SetIgnoreArmyUnitCap(idx, bool)` | Briefly lever out the unit cap | Sim Global | scenarioutilities.lua:201/232 |
| `Random([a,b])` | Sim-RNG (Mersenne, deterministisch!) | Sim-Global | scenarioutilities.lua:391 |
| `CreatePrefetchSet()` | `CPrefetchSet` mit `Reset`/`Update` | Core-Global | **simInit.lua:232 (Top-Level!)** |
| `Warp(entity, pos)` | Entity hart versetzen | Sim-Global | siminit.lua:212 |
| `OrientFromDir(dir)` | Richtung → Quaternion | Core-Global | siminit.lua:213 |
| `AddBuildRestriction(idx, cats)` | Kategorie-Sperre je Armee | Sim-Global | siminit.lua:190 |
| `ArmyInitializePrebuiltUnits(name)` | Pre-built base | Cfile:1024702 | siminit.lua:129 |
| `SetArmyFactionIndex(army, i)` | **0-basiert** (`mFaction`) | Cfile:1017289 (Gegenstück) | scenarioutilities.lua:541 (Kampagne) |
| `SetArmyColorIndex` / `SetArmyAIPersonality` | Farbe / Persönlichkeit | Sim-Globals | scenarioutilities.lua:550/554 |
| `SetArmyUnitCap` / `GetArmyUnitCap` | Unit cap | Sim Globals | simutils.lua:201 |
| `SetAlliedVictory`, `SetArmyOutOfGame`, `ArmyIsOutOfGame`, `EndGame`, `IsGameOver` | Siegbedingungen | Sim-Globals | `/lua/victory.lua` (schook:27) |
| `GetMapSize()` | Kartengröße in Zellen | Sim-Global | GenerateArmyStart, AI |
| `SetPlayableRect` / `SetIgnorePlayableRect` | Spielfeldgrenze | Sim-Globals | Optionen |

Unit methods of the same chain (moho `unit_methods`): `SetCustomName`, `HideBone`,
`CreateTarmac`, `PlayCommanderWarpInEffect` (uel0001_script.lua), `CreateWreckageProp`.
Brain-Methoden: `MakePlatoon`, `AssignUnitsToPlatoon`, `SetCurrentPlan`.

**UI page** (`scr_UserInits`, all still in
[ui-globals-missing.lua](../../src/engine-lua/ui-globals-missing.lua)):
`LaunchSinglePlayerSession` (Z. 36), `SessionGetScenarioInfo` (Z. 41),
`GetArmiesTable` (Z. 22), `PrefetchSession` (Z. 38), `WorldIsLoading`/`WorldIsPlaying`
(Z. 48), `SetFrontEndData`/`GetFrontEndData` (Z. 24/44).

## 4. Current status

**What's already there**

- All `.scd` are mounted, **also `schook.scd`** — `/schook/lua/siminit.lua` is located
  already in the VFS ([src/vfs/vfs.ts](../../src/vfs/vfs.ts):46, [scripts/gameFiles.ts](../../scripts/gameFiles.ts):86).
  It just never loads.
- `doscript(name, env)` with environment parameter: [boot.lua](../../src/engine-lua/boot.lua):70 —
  exactly what `SetupSession()` needs for `_save.lua`.
- `import`, `class.lua`, `utils.lua`, `SimSync.lua`, `terrainTypes.lua`:
  [engine.ts](../../src/lua/engine.ts):62-77.
- Brains as a real `AIBrain` class: `__createBrain` ([brain.lua](../../src/engine-lua/brain.lua)).
- `GetArmyBrain`, `SetArmyEconomy`, `GetFocusArmy`, `IsAlly/IsEnemy`, `CreateSplat`,
  `CreateDecal`, `_c_CreateEntity`, `EntityCategoryContains`
  ([globals.lua](../../src/engine-lua/globals.lua)).
- `brain:GetFactionIndex()` liefert `__faction` (moho.lua:307) — Wert stimmt (1-basiert).

**What is missing or incorrect**

1. **No hook mechanism.** `doscript`/`import` only load the base file. `/schook`
   does not exist as a concept ⇒ `CreateProps`, `CreateResources`,
   `InitializeStartLocation`, `SetPlans`, Victory and Scores never run.
2. **`/lua/simInit.lua` is never loaded.** `engine.ts` loads `SimSync.lua` directly and
   calls `ResetSyncTable()` itself — otherwise `SetupSession()` does both
   (siminit.lua:45/100). `SetupSession`, `BeginSession`, `OnCreateArmyBrain`,
   `InitializePrebuiltUnits` simply does not exist in our sim.
3. **`ScenarioInfo` is fictional**, not deserialized:
   [session.ts](../../src/sim/session.ts):61-72 builds a mini table
   `type/map/Options={}/ArmySetup`. Es fehlen `save`, `script`, `Env`, `Options`,
   `norushradius`, `Configurations` — and `ArmySetup` has no `Team`, `PlayerName`,
   `ArmyColor`, `StartSpot`. `BeginSession` (siminit.lua:150) liest `army.Team`.
4. **`/maps` is not in the VFS.** `GameVfs.mount` mounts exclusively
   `gamedata/*.scd` ([vfs.ts](../../src/vfs/vfs.ts):27-28) — although the comment
   next to it, `bin/SupComDataPath.lua` is correctly quoted (“mounts /mods and /maps BEFORE
   gamedata"). `main.ts` reads the card via a separate `DirectorySource`
   (main.ts:305/413). As long as `_save.lua` is not listed as `/maps/<x>/<x>_save.lua`
   LuaHost-VFS, `SetupSession()` cannot `doscript`.
5. **`/lua/dataInit.lua` is never loaded** — without `VECTOR3`/`GROUP`/`STRING` each is
   `_save.lua` unreadable (and the strict `_G` from `config.lua:51` would pop correctly).
6. **The ACU is spawned by TS** (main.ts:483) instead of
   `CreateInitialArmyGroup` → `CreateInitialArmyUnit`. That's why there isn't one
   `HideBone(0)` + `PlayCommanderWarpInEffect` (the warp-in effect).
7. **No resource deposits in the sim.** `CSimResources` has no counterpart; a
   As a result, mass extractor cannot check whether it is on a deposit.

## 5. Construction order

Each step can be checked individually in red/green. Verify suites run with it
`npx tsx --import ./scripts/register-lua.mjs scripts/verify-<x>.ts`.

**Step 1 — `/maps` in the VFS.** `GameVfs.mount` and `GameFiles.open` additionally
Record `maps/<ordner>/*.lua` (priority BEFORE `gamedata`, like `SupComDataPath.lua`),
and the worker gets it in the `boot` payload.
*Verification:* `host.hasFile('/maps/SCMP_009/SCMP_009_save.lua')` and
`doscript('/lua/dataInit.lua', env); doscript('/maps/…_save.lua', env)` ⇒
`env.Scenario.MasterChain._MASTERCHAIN_.Markers.ARMY_1.position` = `{672.5, 18.6797, 346.5}`.

**Step 2 — Hook dirs into `boot.lua`.** `doscript`/`__runGlobal`: after the base file
for each `hookDir` in `{'/schook'}` check whether `<hookDir><pfad>` exists, and **im
Reload the same environment** (Cfile:595822-595866). Log `Hooked %s with %s` like that
Original.
*Verification:* a mini-suite loads `/lua/simInit.lua` and checks that `BeginSession`
then the **hooked** version is (e.g. `ScenarioUtils.CreateResources`
called — with a counter spy on `CreateResourceDeposit`).

**Step 3 — real SimInit boot.** `installEngine()`: instead of `SimSync.lua` +
`ResetSyncTable()` by hand → `host.loadGlobal('/lua/simInit.lua')` (loads `globalInit`,
`SimSync`, definiert `SetupSession`/`BeginSession`/`OnCreateArmyBrain`). Dafür müssen
`CreatePrefetchSet` and `__active_mods` exist (simInit.lua:33/232).
`session.ts` only publishes `ScenarioInfo` (from the real `_scenario.lua` +
`teamInfo` according to the pattern `SetupCommandLineSkirmish`) and calls `SetupSession()`.
*Verification:* `scripts/verify-session-start.ts` — valid after `SetupSession()`
`Scenario ~= nil`, `ScenarioInfo.Env ~= nil`, `table.getn(GetMarkers()) > 0`.

**Step 4 — `CreateArmies` as engine step.** Per army: Create brain, start
set randomly (`GenerateArmyStart`), then `OnCreateArmyBrain(i, brain, ArmyName,
PlayerName)` **aus der Engine** rufen. Bindungen: `ListArmies`, `SetArmyStart`,
`GenerateArmyStart`, `brain:GetArmyStartPos`, `SetArmyPlans`, `InitializeArmyAI`.
*Verification:* `ArmyBrains[1].Name == 'ARMY_1'`, `ArmyBrains[1].Nickname == 'Player'`,
`ArmyBrains[1]:GetArmyStartPos()` = `672.5, 346.5` (marker from SCMP_009 — the proof
that `InitializeStartLocation` ran out of the hook).

**Step 5 — `BeginSession()` spawns the starting army.** Bindings:
`ShouldCreateInitialArmyUnits`, `CreateInitialArmyUnit`, `SetIgnoreArmyUnitCap`,
`SetAlliance`, `Random`. `CreateInitialArmyUnit` goes over the existing one
`__spawnUnit` path (complete, `y` from `GetSurfaceHeight`).
*Verification:* `BeginSession()` ⇒ exactly 1 unit per non-civilian army, blueprint =
`Factions[faction].InitialUnit`, position == marker `ARMY_n`. Browser: load map,
ACU is at the starting point — **without** `?luaspawn`.

**Step 6 — Resources and Props.** `CreateResourceDeposit` (Deposit rectangle in
a `SimResources` list + query `IsDepositAtPoint` for extractor construction),
`CreatePropHPR`, `CreateSplat` with the real `mass_marker.dds`.
*Verifikation:* SCMP_009 ⇒ **116 Deposits** (108 `Mass`, 8 `Hydrocarbon`), Mass-Rechteck
1×1 on whole cells. Browser: the original Splats + `massDeposit01_prop.bp` instead
erfundener Ringe.

Only then is it worth taking the UI route (`LaunchSinglePlayerSession` as a real binding).
boots the worker with `sessionInfo`) — the sim must be installed beforehand.

## 6. Offene Fragen

1. **Where does `info->mProps` come from?** "Sim Setup 7" (Cfile:1072049-1072081) generates props
   via `PROP_Create` from a vector that is already in the `LaunchInfo` - in parallel
   to `ScenarioUtils.CreateProps()` from the schook hook (`Scenario['Props']`). Two
   Sources. Presumably the C++ path is for saved games/replays; **not
   verified.** The Lua path is sufficient for the skirmish start (at SCMP_009 is
   `Scenario.Props` ohnehin leer).
2. **Does the hook mechanism also apply to `import()`?** It is used in the function
   Cfile:595822 (find file → collect all hook hits). Whether `SCR_Import` the same
   I haven't proven that it takes away or just `SCR_LuaDoScript`. For our case
   irrelevant (all 8 schook files are loaded via `doscript`), for mods later
   not.
3. **`SetArmyStart` does not have `y`.** The ACU is designed with `pos.y = 0.0`
   (Cfile:1025261). Does the `Unit`-Ctor set the height from the heightfield, or does it
   first motion tick? Didn't check.
4. **Without which `ScenarioInfo.Options` what breaks?** `func_SimArmyAlloc` reads
   `FogOfWar`, `UnitCap`, `NoRushOption`; `InitializeArmies` liest `CivilianAlliance`;
   `CreateInitialArmyGroup` reads `PrebuiltUnits`. The strict `_G` from `config.lua:51`
   does not apply to table fields, so `Options.X` is simply `nil` — but
   `defaultOptions` (SinglePlayerLaunch.lua:123-135) is the occupied template and should
   be adopted 1:1.
5. **`Random` must be deterministic** (Mersenne-Twister, `mInitSeed` off
   `sessionInfo.RandomSeed`, Cfile:1071820). Our `Random` doesn't exist yet - if it does
   If it becomes `Math.random`, the sim can no longer be reproduced. What consequence is that?
   for replays is open here.
