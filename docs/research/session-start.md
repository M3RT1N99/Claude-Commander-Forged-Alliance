# Session-Start 1:1 — von der Lobby zur laufenden Karte

Wie das Original eine Skirmish-Session startet, und was unsere Engine dafür noch
schuldet. Belege: `Cfile/ForgedAlliance.exe.c` (Zeilennummern), Original-Lua
(`<datei>:<zeile>`).

## 1. Überblick

Heute parst [src/main.ts](../../src/main.ts) die Karte selbst (`_save.lua` → Marker
`ARMY_1`, Zeile 413-432) und lässt die ACU per `spawnViaLua('uel0001')` (main.ts:483)
an diesem Punkt erscheinen. [src/sim/session.ts](../../src/sim/session.ts) baut
`ScenarioInfo` von Hand aus einem TS-Interface. Beides ist Spiellogik in TS.

Im Original macht das die Lua. Die Engine tut genau vier Dinge:

1. Sie lädt `/lua/simInit.lua` in den frischen Sim-State (Cfile:1071613).
2. Sie schreibt `ScenarioInfo` (die Tabelle aus dem `_scenario.lua` **plus**
   `ArmySetup`) als Global in die Sim (Cfile:1071886-1071889).
3. Sie ruft `SetupSession()` (Cfile:1071898), erzeugt die Armeen
   (`Sim::CreateArmies`, Cfile:1072015), ruft `BeginSession()` (Cfile:1072090) und
   `Sim::PostInitialize` (Cfile:1072103).
4. Sie stellt die `sim_SimInits`-Bindungen bereit, die die Lua dabei aufruft.

**Die Karte liest die Sim-Lua selbst**: `SetupSession()` macht
`doscript(ScenarioInfo.save, ScenarioInfo.Env)` (siminit.lua:93) und
`doscript(ScenarioInfo.script, …)` (siminit.lua:98). Der Marker-Baum ist danach
`Scenario.MasterChain._MASTERCHAIN_.Markers` (scenarioutilities.lua:54).

## 2. Ablauf/Callchain

### 2.1 UI: Lobby → `LaunchSinglePlayerSession(sessionInfo)`

`LaunchSinglePlayerSession` ist eine **UI-VM**-Bindung (`scr_UserInits`,
Cfile:1321740; Hilfetext: *„LaunchSinglePlayerSession(sessionInfo) -- launch a new
single player session."*). Sie nimmt **eine** Tabelle und reicht sie an
`Moho::WLD_SetupSessionInfo` (Cfile:1321385) weiter. Gelesene Felder — mehr gibt es
nicht:

| Feld | Beleg |
|---|---|
| `scenarioInfo` (Tabelle → serialisiert) | Cfile:1321432 |
| `scenarioMods` | Cfile:1321444 |
| `teamInfo` (Array, ein Eintrag je Armee) | Cfile:1321455 |
| `RandomSeed` (fehlt ⇒ Systemzeit) | Cfile:1321475 |
| `scenarioInfo.map` (Pfad der `.scmap`) | Cfile:1321529 |
| `createReplay` | Cfile:1321539 |
| `playerName` | Cfile:1321545 |

Der **Skirmish-Bauplan** für diese Tabelle steht komplett in
`SinglePlayerLaunch.lua:228-295` (`SetupCommandLineSkirmish`) — das ist der ehrliche
Weg ohne Netzwerk-Lobby:

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

`LoadScenario` (maputil.lua:21-30) ist selbst nur `doscript('/lua/dataInit.lua', env)`
+ `doscript(scenName, env)` — `dataInit.lua` (34 Zeilen) liefert die DSL-Konstruktoren
`BOOLEAN/INTEGER/FLOAT/VECTOR2/VECTOR3/RECTANGLE/STRING/GROUP`, die in `_scenario.lua`
und `_save.lua` stehen. Die Engine macht dasselbe in
`Moho::WLD_LoadScenarioInfo` (Cfile:1320686-1320693).

Die volle Netzwerk-Lobby (`lobby.lua`) ist dafür **nicht** nötig: sie geht über
`lobbyComm:LaunchGame(gameInfo)` (lobby.lua:879) und die `CLobby`-Engine-Klasse — auch
im Single-Player (lobby.lua:882: `if singlePlayer … LaunchGame()`).

### 2.2 Der Sim-Boot: `Moho::Sim::Setup` (Cfile:1071723)

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

**Merke:** `SetupSession()` läuft, **bevor** eine einzige Armee existiert;
`BeginSession()`, **nachdem** alle Armeen/Brains da sind, aber **bevor** es Units gibt
(siminit.lua:133-135 sagt es genau so).

### 2.3 `Sim::CreateArmies` (Cfile:1073404)

Je Armee `i` (0-basiert):

- `func_SimArmyAlloc(sim, i, launchInfo[i], ArmySetup-LuaObject[i], Options, isFocus)`
  - `GenerateArmyStart(army)` — **zuerst eine ZUFÄLLIGE Startposition**
    (Cfile:1017228; Impl 1017961: `x = rand·(width−1)`, `z = rand·(height−1)`)
  - liest aus dem `ArmySetup`-Eintrag: `ArmyName` (:1017245), `PlayerName` (:1017253),
    `Civilian` (:1017261), `Human`/`AIPersonality` (:1017268),
    `ArmyColor`/`PlayerColor` (−1, :1017275/:1017281),
    **`Faction` → `mFaction = Faction − 1`** (:1017289)
  - aus `ScenarioInfo.Options`: `FogOfWar` (:1017363), `UnitCap` (:1017631),
    `NoRushOption` (:1017642) + `ScenarioInfo.norushradius` (:1017683)
- danach ruft die Engine **Lua**: `OnCreateArmyBrain(i+1, brain, ArmyName, PlayerName)`
  (Cfile:1073457-1073545; `Call_IntBrainStr2`)

`brain:GetFactionIndex()` gibt `mFaction + 1` zurück (Cfile:733604) — also 1-basiert,
direkt als Index in `factions.lua`.

### 2.4 Der Hook, der alles zusammenhält: `/schook`

`bin/SupComDataPath.lua` (Spielverzeichnis, kein Archiv):

```lua
mount_dir(InitFileDir .. '\\..\\gamedata\\*.scd', '/')
mount_dir(InitFileDir .. '\\..', '/')
hook = { '/schook' }
```

Die Engine liest `hook` (Cfile:505923-505936 → `Moho::SCR_AddHookDirectory`) und hängt
bei **jedem** Skript-Load zusätzlich `<hookdir>..<pfad>` an (Cfile:595822-595866;
Logzeile `"Hooked %s with %s"`). `schook.scd` enthält genau 8 Dateien:

```
schook/lua/globalinit.lua   schook/lua/sessioninit.lua  schook/lua/siminit.lua
schook/lua/simsync.lua      schook/lua/usersync.lua     schook/lua/userinit.lua
schook/lua/maui/window.lua  schook/lua/sim/weapon.lua
```

**`schook/lua/siminit.lua` ist der fehlende halbe Session-Start** — ohne ihn gibt es
weder Ressourcen-Vorkommen noch Startpositionen:

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

`CreateProps()`/`CreateResources()` werden **nirgends sonst** aufgerufen — in
`lua.scd`/`mohodata.scd`/`units.scd` und in den Karten-Skripten kommen sie nicht vor.

### 2.5 Startposition, ACU, Ressourcen — die Lua-Kette

```lua
-- scenarioutilities.lua:1026
function InitializeStartLocation(strArmy)
    local start = GetMarker(strArmy)                       -- Marker 'ARMY_1' … 'ARMY_8'
    if start then SetArmyStart(strArmy, start.position[1], start.position[3])
    else          GenerateArmyStart(strArmy) end
end
```

`SetArmyStart` nimmt nur **x und z** (Hilfetext `"army, x, z"`, Cfile:1024479).

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
`mComplete = 1` (Cfile:1025269). Die Höhe setzt der Unit-Ctor.

`ShouldCreateInitialArmyUnits()` ist schlicht `not CFG_GetArgOption("/noinitialunits")`
(Cfile:1024331) — also normalerweise `true`.

**Ressourcen-Vorkommen** (`CreateResources()`, scenarioutilities.lua:371) — genau das,
was uns fehlt, und der Grund, warum unsere erfundenen Ringe falsch waren:

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

Also: **ein Splat mit der Original-Textur + ein Prop-Modell**, kein Ring. Die Marker im
`_save.lua` sehen so aus (SCMP_009: 108× `type='Mass'`, 8× `'Hydrocarbon'`, alle mit
`resource = BOOLEAN(true)`, `size = FLOAT(1.0)`, `amount = FLOAT(100.0)`).

`CreateResourceDeposit(type, x, y, z, size)` (Cfile:687675) → `AddDepositPoint`
(Cfile:686680): Rechteck = `trunc(x − size/2) … +size`, `trunc(z − size/2) … +size`,
als **int16-Zellen**. Ein Mass-Punkt ist also genau **eine 1×1-Zelle** — dasselbe
Raster, auf das der Massenextraktor schnappt (`COORDS_GridSnap`, siehe CLAUDE.md).

### 2.6 `BeginSession()` (siminit.lua:137) und `PostInitialize`

- `LocGlobals.PlayerName = ArmyBrains[GetFocusArmy()].Nickname` (:141)
- `ScenarioInfo.Env.OnPopulate(ScenarioInfo)` → **das Karten-Skript**
  (`SCMP_009_script.lua`: `ScenarioUtils.InitializeArmies()`), dann `OnStart` (:145-146).
  Default-Implementierungen: `scenarioEnvironment.lua:15/19` (leer).
- Teams aus `ScenarioInfo.ArmySetup[*].Team > 1` → `SetAlliance(a,b,"Ally")` (:150-202)
- `ScenarioInfo.Options.RestrictedCategories` → `AddBuildRestriction` (:166-192)
- Effekt-Marker (`type == 'Effect'`) → `Entity()` + `CreateEmitterAtBone` (:205-219)
- `Sim::PostInitialize` (Cfile:1073487): nur wenn `Options.PrebuiltUnits == 'On'` →
  je nicht-ziviler Armee Lua-`InitializePrebuiltUnits(armyName)` (siminit.lua:128)

Am Dateiende von `simInit.lua` (Zeile 232) steht **auf Top-Level**
`Prefetcher = CreatePrefetchSet()` — die Bindung muss existieren, sonst lädt die Datei
gar nicht.

## 3. Fehlende Engine-Bindungen

Abgeglichen gegen [engine-api.md](engine-api.md) (`sim_SimInits`) und den Ist-Stand in
`src/engine-lua/*.lua`. „Da" = bereits implementiert.

| Bindung | Semantik (Decomp) | Beleg | Braucht |
|---|---|---|---|
| `ListArmies` | Array der Armee-Namen, 1-basiert | Cfile:1024373 (Sim) | siminit.lua:188, scenarioutilities.lua:438 |
| `SetArmyStart(army, x, z)` | `army.mVarDat.mArmystart = {x,z}` (2D!) | Cfile:1024490, Hilfe `"army, x, z"` | scenarioutilities.lua:1029 |
| `GenerateArmyStart(army)` | Zufalls-Start `rand·(w−1)`, `rand·(h−1)` | Cfile:1017961 | scenarioutilities.lua:1031 |
| `brain:GetArmyStartPos()` | liefert `mArmystart` (x, z) | Cfile:1016481 | aibrain.lua:438, CreateInitialArmyUnit |
| `CreateInitialArmyUnit(army, bpId)` | Unit an `GetArmyStartPos()`, `y = 0`, complete | Cfile:1025200 | scenarioutilities.lua:338 |
| `ShouldCreateInitialArmyUnits()` | `not /noinitialunits` ⇒ `true` | Cfile:1024331 | scenarioutilities.lua:442 |
| `CreateResourceDeposit(t,x,y,z,size)` | Deposit-Rechteck `trunc(p−size/2)+size` | Cfile:687675, 686680 | scenarioutilities.lua:375 |
| `CreatePropHPR(bp,x,y,z,h,p,r)` | Prop mit Euler-Winkeln | `luadef_CreateProp` Cfile:1015362 | scenarioutilities.lua:360/388/398 |
| `CreateProp(bp, pos)` | dito, ohne Rotation | Sim-Global (engine-api.md) | Wracks, Reclaim |
| `CreateUnitHPR(bp,army,x,y,z,h,p,r)` | benannte Karten-Unit | Sim-Global | scenarioutilities.lua:204 |
| `SetAlliance(a, b, 'Ally'\|'Enemy'\|'Neutral')` | Allianz-Bitset beider Armeen | Sim-Global | siminit.lua:198, scenarioutilities.lua:493 |
| `SetArmyPlans(army, plans)` | AI-Plan-String | Sim-Global | scenarioutilities.lua:1037 |
| `InitializeArmyAI(name)` | Engine legt AI-Threads an | Sim-Global | siminit.lua:122 |
| `SetIgnoreArmyUnitCap(idx, bool)` | Unit-Cap kurz aushebeln | Sim-Global | scenarioutilities.lua:201/232 |
| `Random([a,b])` | Sim-RNG (Mersenne, deterministisch!) | Sim-Global | scenarioutilities.lua:391 |
| `CreatePrefetchSet()` | `CPrefetchSet` mit `Reset`/`Update` | Core-Global | **simInit.lua:232 (Top-Level!)** |
| `Warp(entity, pos)` | Entity hart versetzen | Sim-Global | siminit.lua:212 |
| `OrientFromDir(dir)` | Richtung → Quaternion | Core-Global | siminit.lua:213 |
| `AddBuildRestriction(idx, cats)` | Kategorie-Sperre je Armee | Sim-Global | siminit.lua:190 |
| `ArmyInitializePrebuiltUnits(name)` | Vorgebaute Basis | Cfile:1024702 | siminit.lua:129 |
| `SetArmyFactionIndex(army, i)` | **0-basiert** (`mFaction`) | Cfile:1017289 (Gegenstück) | scenarioutilities.lua:541 (Kampagne) |
| `SetArmyColorIndex` / `SetArmyAIPersonality` | Farbe / Persönlichkeit | Sim-Globals | scenarioutilities.lua:550/554 |
| `SetArmyUnitCap` / `GetArmyUnitCap` | Unit-Cap | Sim-Globals | simutils.lua:201 |
| `SetAlliedVictory`, `SetArmyOutOfGame`, `ArmyIsOutOfGame`, `EndGame`, `IsGameOver` | Siegbedingungen | Sim-Globals | `/lua/victory.lua` (schook:27) |
| `GetMapSize()` | Kartengröße in Zellen | Sim-Global | GenerateArmyStart, AI |
| `SetPlayableRect` / `SetIgnorePlayableRect` | Spielfeldgrenze | Sim-Globals | Optionen |

Unit-Methoden derselben Kette (moho `unit_methods`): `SetCustomName`, `HideBone`,
`CreateTarmac`, `PlayCommanderWarpInEffect` (uel0001_script.lua), `CreateWreckageProp`.
Brain-Methoden: `MakePlatoon`, `AssignUnitsToPlatoon`, `SetCurrentPlan`.

**UI-Seite** (`scr_UserInits`, alle noch in
[ui-globals-missing.lua](../../src/engine-lua/ui-globals-missing.lua)):
`LaunchSinglePlayerSession` (Z. 36), `SessionGetScenarioInfo` (Z. 41),
`GetArmiesTable` (Z. 22), `PrefetchSession` (Z. 38), `WorldIsLoading`/`WorldIsPlaying`
(Z. 48), `SetFrontEndData`/`GetFrontEndData` (Z. 24/44).

## 4. Ist-Stand

**Was schon da ist**

- Alle `.scd` sind gemountet, **auch `schook.scd`** — `/schook/lua/siminit.lua` liegt
  bereits im VFS ([src/vfs/vfs.ts](../../src/vfs/vfs.ts):46, [scripts/gameFiles.ts](../../scripts/gameFiles.ts):86).
  Es wird nur nie geladen.
- `doscript(name, env)` mit Environment-Parameter: [boot.lua](../../src/engine-lua/boot.lua):70 —
  genau das, was `SetupSession()` für `_save.lua` braucht.
- `import`, `class.lua`, `utils.lua`, `SimSync.lua`, `terrainTypes.lua`:
  [engine.ts](../../src/lua/engine.ts):62-77.
- Brains als echte `AIBrain`-Klasse: `__createBrain` ([brain.lua](../../src/engine-lua/brain.lua)).
- `GetArmyBrain`, `SetArmyEconomy`, `GetFocusArmy`, `IsAlly/IsEnemy`, `CreateSplat`,
  `CreateDecal`, `_c_CreateEntity`, `EntityCategoryContains`
  ([globals.lua](../../src/engine-lua/globals.lua)).
- `brain:GetFactionIndex()` liefert `__faction` (moho.lua:307) — Wert stimmt (1-basiert).

**Was fehlt oder falsch ist**

1. **Kein Hook-Mechanismus.** `doscript`/`import` laden nur die Basis-Datei. `/schook`
   existiert nicht als Konzept ⇒ `CreateProps`, `CreateResources`,
   `InitializeStartLocation`, `SetPlans`, Victory und Scores laufen nie.
2. **`/lua/simInit.lua` wird nie geladen.** `engine.ts` lädt `SimSync.lua` direkt und
   ruft `ResetSyncTable()` selbst — beides macht sonst `SetupSession()`
   (siminit.lua:45/100). `SetupSession`, `BeginSession`, `OnCreateArmyBrain`,
   `InitializePrebuiltUnits` existieren in unserer Sim schlicht nicht.
3. **`ScenarioInfo` ist erfunden**, nicht deserialisiert:
   [session.ts](../../src/sim/session.ts):61-72 baut ein Mini-Table mit
   `type/map/Options={}/ArmySetup`. Es fehlen `save`, `script`, `Env`, `Options`,
   `norushradius`, `Configurations` — und `ArmySetup` hat kein `Team`, `PlayerName`,
   `ArmyColor`, `StartSpot`. `BeginSession` (siminit.lua:150) liest `army.Team`.
4. **`/maps` ist nicht im VFS.** `GameVfs.mount` mountet ausschließlich
   `gamedata/*.scd` ([vfs.ts](../../src/vfs/vfs.ts):27-28) — obwohl der Kommentar
   daneben `bin/SupComDataPath.lua` korrekt zitiert („mountet /mods und /maps VOR
   gamedata"). `main.ts` liest die Karte über einen separaten `DirectorySource`
   (main.ts:305/413). Solange `_save.lua` nicht als `/maps/<x>/<x>_save.lua` im
   LuaHost-VFS liegt, kann `SetupSession()` es nicht `doscript`en.
5. **`/lua/dataInit.lua` wird nie geladen** — ohne `VECTOR3`/`GROUP`/`STRING` ist jedes
   `_save.lua` unlesbar (und der strenge `_G` aus `config.lua:51` würde korrekt knallen).
6. **Die ACU wird von TS gespawnt** (main.ts:483) statt von
   `CreateInitialArmyGroup` → `CreateInitialArmyUnit`. Deshalb gibt es auch kein
   `HideBone(0)` + `PlayCommanderWarpInEffect` (der Warp-In-Effekt).
7. **Keine Ressourcen-Vorkommen in der Sim.** `CSimResources` hat kein Gegenstück; ein
   Massenextraktor kann folglich nicht prüfen, ob er auf einem Deposit steht.

## 5. Bau-Reihenfolge

Jeder Schritt ist einzeln rot/grün prüfbar. Verify-Suiten laufen mit
`npx tsx --import ./scripts/register-lua.mjs scripts/verify-<x>.ts`.

**Schritt 1 — `/maps` in den VFS.** `GameVfs.mount` und `GameFiles.open` zusätzlich
`maps/<ordner>/*.lua` aufnehmen (Priorität VOR `gamedata`, wie `SupComDataPath.lua`),
und der Worker bekommt sie im `boot`-Payload.
*Verifikation:* `host.hasFile('/maps/SCMP_009/SCMP_009_save.lua')` und
`doscript('/lua/dataInit.lua', env); doscript('/maps/…_save.lua', env)` ⇒
`env.Scenario.MasterChain._MASTERCHAIN_.Markers.ARMY_1.position` = `{672.5, 18.6797, 346.5}`.

**Schritt 2 — Hook-Dirs in `boot.lua`.** `doscript`/`__runGlobal`: nach der Basisdatei
für jedes `hookDir` in `{'/schook'}` prüfen, ob `<hookDir><pfad>` existiert, und **im
selben Environment** nachladen (Cfile:595822-595866). Log `Hooked %s with %s` wie das
Original.
*Verifikation:* eine Mini-Suite lädt `/lua/simInit.lua` und prüft, dass `BeginSession`
danach die **gehookte** Fassung ist (z. B. `ScenarioUtils.CreateResources` wird
aufgerufen — mit einem Zähler-Spion auf `CreateResourceDeposit`).

**Schritt 3 — echter SimInit-Boot.** `installEngine()`: statt `SimSync.lua` +
`ResetSyncTable()` von Hand → `host.loadGlobal('/lua/simInit.lua')` (lädt `globalInit`,
`SimSync`, definiert `SetupSession`/`BeginSession`/`OnCreateArmyBrain`). Dafür müssen
`CreatePrefetchSet` und `__active_mods` existieren (simInit.lua:33/232).
`session.ts` publiziert nur noch `ScenarioInfo` (aus dem echten `_scenario.lua` +
`teamInfo` nach dem Muster `SetupCommandLineSkirmish`) und ruft `SetupSession()`.
*Verifikation:* `scripts/verify-session-start.ts` — nach `SetupSession()` gilt
`Scenario ~= nil`, `ScenarioInfo.Env ~= nil`, `table.getn(GetMarkers()) > 0`.

**Schritt 4 — `CreateArmies` als Engine-Schritt.** Je Armee: Brain anlegen, Start
zufällig setzen (`GenerateArmyStart`), dann `OnCreateArmyBrain(i, brain, ArmyName,
PlayerName)` **aus der Engine** rufen. Bindungen: `ListArmies`, `SetArmyStart`,
`GenerateArmyStart`, `brain:GetArmyStartPos`, `SetArmyPlans`, `InitializeArmyAI`.
*Verifikation:* `ArmyBrains[1].Name == 'ARMY_1'`, `ArmyBrains[1].Nickname == 'Player'`,
`ArmyBrains[1]:GetArmyStartPos()` = `672.5, 346.5` (Marker aus SCMP_009 — der Beweis,
dass `InitializeStartLocation` aus dem Hook lief).

**Schritt 5 — `BeginSession()` spawnt die Startarmee.** Bindungen:
`ShouldCreateInitialArmyUnits`, `CreateInitialArmyUnit`, `SetIgnoreArmyUnitCap`,
`SetAlliance`, `Random`. `CreateInitialArmyUnit` geht über den vorhandenen
`__spawnUnit`-Pfad (komplett, `y` aus `GetSurfaceHeight`).
*Verifikation:* `BeginSession()` ⇒ genau 1 Unit je nicht-ziviler Armee, Blueprint =
`Factions[faction].InitialUnit`, Position == Marker `ARMY_n`. Browser: Karte laden,
ACU steht auf dem Startpunkt — **ohne** `?luaspawn`.

**Schritt 6 — Ressourcen und Props.** `CreateResourceDeposit` (Deposit-Rechteck in
einer `SimResources`-Liste + Abfrage `IsDepositAtPoint` für den Extraktor-Bau),
`CreatePropHPR`, `CreateSplat` mit der echten `mass_marker.dds`.
*Verifikation:* SCMP_009 ⇒ **116 Deposits** (108 `Mass`, 8 `Hydrocarbon`), Mass-Rechteck
1×1 auf ganzen Zellen. Browser: die Original-Splats + `massDeposit01_prop.bp` statt
erfundener Ringe.

Erst danach lohnt sich der UI-Weg (`LaunchSinglePlayerSession` als echte Bindung, die
den Worker mit `sessionInfo` bootet) — die Sim muss vorher stehen.

## 6. Offene Fragen

1. **Woher kommt `info->mProps`?** " Sim Setup 7" (Cfile:1072049-1072081) erzeugt Props
   per `PROP_Create` aus einem Vektor, der schon in der `LaunchInfo` steckt — parallel
   zu `ScenarioUtils.CreateProps()` aus dem schook-Hook (`Scenario['Props']`). Zwei
   Quellen. Vermutlich ist der C++-Pfad für gespeicherte Spiele/Replays; **nicht
   verifiziert.** Für den Skirmish-Start reicht der Lua-Pfad (bei SCMP_009 ist
   `Scenario.Props` ohnehin leer).
2. **Gilt der Hook-Mechanismus auch für `import()`?** Belegt ist er in der Funktion um
   Cfile:595822 (Datei suchen → alle Hook-Treffer sammeln). Ob `SCR_Import` denselben
   Weg nimmt oder nur `SCR_LuaDoScript`, habe ich nicht nachgewiesen. Für unseren Fall
   irrelevant (alle 8 schook-Dateien werden per `doscript` geladen), für Mods später
   nicht.
3. **`SetArmyStart` hat kein `y`.** Die ACU wird mit `pos.y = 0.0` konstruiert
   (Cfile:1025261). Setzt der `Unit`-Ctor die Höhe aus dem Heightfield, oder tut es der
   erste Motion-Tick? Nicht nachgesehen.
4. **Ohne welche `ScenarioInfo.Options` bricht was?** `func_SimArmyAlloc` liest
   `FogOfWar`, `UnitCap`, `NoRushOption`; `InitializeArmies` liest `CivilianAlliance`;
   `CreateInitialArmyGroup` liest `PrebuiltUnits`. Der strenge `_G` aus `config.lua:51`
   gilt nicht für Tabellenfelder, `Options.X` ist also einfach `nil` — aber
   `defaultOptions` (SinglePlayerLaunch.lua:123-135) ist die belegte Vorlage und sollte
   1:1 übernommen werden.
5. **`Random` muss deterministisch sein** (Mersenne-Twister, `mInitSeed` aus
   `sessionInfo.RandomSeed`, Cfile:1071820). Unser `Random` gibt es noch nicht — wenn
   es `Math.random` wird, ist die Sim nicht mehr reproduzierbar. Welche Konsequenz das
   für Replays hat, ist hier offen.
