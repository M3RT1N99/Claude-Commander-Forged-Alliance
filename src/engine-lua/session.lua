-- Der Sitzungsaufbau — die Schritte, die `SetupSession()` und `BeginSession()`
-- im Original ausführen.
--
-- Bis hierher baute `src/sim/session.ts` ein erfundenes `ScenarioInfo` zusammen
-- und kopierte die Bündnisregel aus `scenarioutilities.lua:488-500` in
-- TypeScript nach. Das ist genau das, was CLAUDE.md verbietet: die Original-Lua
-- IST das Spiel. Also läuft sie jetzt.
--
-- Die echte Kette, aus dem Decompilat und der Original-Lua:
--
--   Moho::Sim::Create     doscript('/lua/simInit.lua')            Cfile:1071613
--   Moho::Sim::Setup      ScenarioInfo als Lua-Global setzen      Cfile:1071889
--                         SetupSession() rufen                    Cfile:1071898/1071906
--     siminit.lua:82        ScenarioInfo.Env = import('/lua/scenarioEnvironment.lua')
--     siminit.lua:92        doscript('/lua/dataInit.lua')
--     siminit.lua:93        doscript(ScenarioInfo.save, ScenarioInfo.Env)
--     siminit.lua:95        Scenario = ScenarioInfo.Env.Scenario
--     siminit.lua:98        doscript(ScenarioInfo.script, ScenarioInfo.Env)
--   Moho::Sim::CreateArmies                                       Cfile:1072015
--                         je Armee OnCreateArmyBrain(i+1, ...)    Cfile:1073457/1073479
--     schook simInit:47      ScenarioUtils.InitializeStartLocation(name)
--     schook simInit:48      SetPlans(name)
--     siminit.lua:122        InitializeArmyAI(name)
--   Moho::Sim::BeginSession                                       Cfile:1072090/1072097
--     siminit.lua:145       ScenarioInfo.Env.OnPopulate(ScenarioInfo)
--     siminit.lua:146       ScenarioInfo.Env.OnStart(ScenarioInfo)
--
-- NICHT gefahren wird `/lua/simInit.lua` selbst. Es stirbt vorher an
-- `/lua/globalinit.lua:14-24` → `lua/system/localization.lua:29-30`, weil
-- unser `DiskFindFiles` im Sim nur die registrierten Blueprints kennt und das
-- `pattern`-Argument ignoriert (`blueprints.lua:346`). Das ist ein eigener,
-- offener Punkt (docs/STATUS.md); bis dahin fährt diese Datei genau die
-- Schritte, die `SetupSession`/`BeginSession` täten — jeder mit seiner
-- Fundstelle.

-- `/noinitialunits` gibt es hier nicht; initialisiert, weil der strikte `_G`
-- aus config.lua sonst beim Lesen wirft.
__noInitialUnits = false

-- Die Schritte 4a/5a/6a stehen hier nicht mehr. `__loadScenario()`,
-- `__initArmyFromScenario(name)` und `__beginSession()` waren Nachbauten von
-- `SetupSession()` (siminit.lua:53-102), dem schook-`OnCreateArmyBrain`
-- (schook/lua/simInit.lua:45-51) und `BeginSession()` (siminit.lua:137-146).
-- Seit der Sim `/lua/simInit.lua` bootet, gibt es die Originale im VM, und
-- `src/sim/session.ts` ruft sie. Die Nachbauten liessen dabei aus, was ihnen
-- nicht aufgefallen war: die sieben `ScenarioInfo`-Untertabellen, `ArmyBrains`,
-- `ScenarioInfo.TriggerManager`, `InitializeArmyAI` je Armee und die
-- Team-/TeamLock-Auswertung am Ende von `BeginSession`.

--- Die Startinformationen der Karte. Im Original liest die LOBBY die
--- `_scenario.lua` und reicht sie als Launch-Info an die Engine, die daraus
--- `ScenarioInfo` baut (Cfile:1071853-1071889). Wir haben keine Lobby, also
--- liest die Sitzung dieselbe Datei — aber mit `doscript` in eine eigene
--- Umgebung, nicht mit einem Parser.
---
--- Ergaenzt wird nur, was die Karte beisteuert; `type`, `Options` und
--- `ArmySetup` bleiben, wie die Sitzung sie gesetzt hat.
function __mergeScenarioFile(path)
  -- Die `_scenario.lua` benutzt dieselben Konstruktoren wie die `_save.lua`
  -- (`STRING()` in SCMP_009_scenario.lua:35), also muss `/lua/dataInit.lua`
  -- auch hier schon gelaufen sein — es definiert sie (datainit.lua:3-34).
  -- Zweimal laden schadet nicht: die Datei setzt nur Funktionen.
  doscript('/lua/dataInit.lua')
  -- Die Umgebung braucht `_G` als Rueckfall, sonst sieht die Datei die eben
  -- definierten Konstruktoren nicht. Genau das macht `import` fuer
  -- `scenarioEnvironment.lua` auch — deshalb funktioniert `doscript(save, Env)`
  -- (siminit.lua:93) ueberhaupt.
  local env = setmetatable({}, { __index = _G })
  doscript(path, env)
  local si = env.ScenarioInfo
  if not si then
    error('__mergeScenarioFile: ' .. tostring(path) .. ' definiert kein ScenarioInfo', 2)
  end
  for k, v in pairs(si) do
    if ScenarioInfo[k] == nil then ScenarioInfo[k] = v end
  end
  return si.save, si.script
end

--- Der Standard-Optionssatz. `defaultOptions` steht im Original an
--- `lua/singleplayerlaunch.lua:123-135`; die Lobby hat ihren eigenen
--- (`lua/ui/lobby/autolobby.lua:28-40`). Sie unterscheiden sich in genau einem
--- Punkt, der hier zaehlt: `CheatsEnabled` ist beim Kommandozeilen-Start
--- `'true'` (singleplayerlaunch.lua:133), in der Lobby `'false'`
--- (autolobby.lua:32). Ein Skirmish ohne Lobby ist kein Cheat-Lauf, also gilt
--- der Lobby-Wert — und beide Fundstellen stehen hier, damit die Wahl sichtbar
--- und umkehrbar ist.
---
--- Ohne diese Tabelle sind `Options.PrebuiltUnits` (scenarioutilities.lua:340)
--- und `Options.CivilianAlliance` (:440) schlicht nil, und die Original-Lua
--- nimmt stillschweigend den jeweils anderen Zweig.
function __defaultScenarioOptions()
  return {
    FogOfWar = 'explored',
    NoRushOption = 'Off',
    PrebuiltUnits = 'Off',
    Difficulty = 2,
    DoNotShareUnitCap = true,
    Timeouts = -1,
    GameSpeed = 'normal',
    UnitCap = '500',
    Victory = 'sandbox',
    CheatsEnabled = 'false',
    CivilianAlliance = 'enemy',
  }
end

--- Das GERÜST für den kartenlosen Fall.
---
--- Ohne Karte gibt es kein `Scenario` — und das ist richtig: im echten Spiel
--- setzt es ausschliesslich `SetupSession` aus der geladenen Karte
--- (siminit.lua:95). Aber die Sandbox und die meisten Suiten fahren ohne Karte,
--- und die Original-Lua greift trotzdem darauf zu: `MassCollectionUnit.OnCreate`
--- ruft `ScenarioUtils.GetMarkers()` (defaultunits.lua:776), um zu sehen, ob der
--- Extraktor auf einem Massepunkt steht. Ohne `Scenario` wirft `pairs(nil)`.
---
--- Genau dieselbe leere Tabelle stand bis eben in `units.lua` — als
--- bedingungsloses Global im PRODUKTIONSPFAD. Das war der Fehler: auch eine
--- echte Sitzung, die das Laden vergisst, las dann still `{}`, und
--- `InitializeArmies()` übersprang jede Armee, ohne dass etwas fehlschlug.
---
--- Der Unterschied ist nicht kosmetisch: hier wird es NUR gesetzt, wenn es
--- ausdrücklich keine Karte gibt. Mit Karte kommt es aus der Karte, und wer das
--- Laden vergisst, bekommt den strikten `_G`-Fehler statt einer Lüge.
function __harnessScenario()
  Scenario = { MasterChain = { _MASTERCHAIN_ = { Markers = {} } }, Armies = {}, Props = {} }
end

--- Welche Unit-Blueprints der Sitzungsstart erzeugen kann.
---
--- Die Engine braucht so eine Liste nicht: `__blueprints` ist mit JEDEM
--- Blueprint gefuellt, bevor `simInit.lua` ueberhaupt laeuft (siminit.lua:8).
--- Im Browser geht das nicht mit: die Sim braucht zu jeder Einheit auch ihr
--- SKELETT, und das kommt aus dem Modell — 78 MB `_lod0.scm` fuer 580
--- Einheiten. Der Worker fragt deshalb genau das ab, was DIESER Sitzungsstart
--- benennen kann, und holt sich die Nutzlast dafuer, bevor `BeginSession()`
--- laeuft. Alles darueber hinaus scheitert weiterhin laut („Unknown unit kind",
--- units.lua), nicht still — das ist der Unterschied zu einem Stub.
---
--- Zwei Quellen, beide die, aus denen das Original liest:
---   * `factions.lua` `Factions[i].InitialUnit` — was `CreateInitialArmyGroup`
---     spawnt, wenn die Karte keine INITIAL-Gruppe hat
---     (scenarioutilities.lua:336-338).
---   * jeder UNIT-Knoten unter `Scenario.Armies[<armee>].Units` — die Gruppen
---     der Karte selbst (scenarioutilities.lua:279/287, `CreateArmySubGroup`
---     laeuft denselben Baum ab).
local function sammleGruppe(knoten, raus)
  if type(knoten) ~= 'table' then return end
  if type(knoten.type) == 'string' and knoten.type ~= 'GROUP' then
    raus[string.lower(knoten.type)] = true
  end
  if type(knoten.Units) == 'table' then
    for _, kind in pairs(knoten.Units) do sammleGruppe(kind, raus) end
  end
end

function __sessionInitialUnits()
  local raus = {}
  local factions = import('/lua/factions.lua').Factions
  for _, setup in pairs((ScenarioInfo and ScenarioInfo.ArmySetup) or {}) do
    local f = factions[setup.Faction]
    if f and f.InitialUnit then raus[string.lower(f.InitialUnit)] = true end
    local armee = Scenario and Scenario.Armies and Scenario.Armies[setup.ArmyName]
    if armee then sammleGruppe(armee.Units, raus) end
  end
  local liste = {}
  for id in pairs(raus) do liste[#liste + 1] = id end
  table.sort(liste)
  return liste
end

--- Dieselbe Liste als JSON — der Weg ueber die wasmoon-Grenze
--- (`LuaHost.pull`), weil eine zurueckgegebene Lua-Tabelle in der Registry
--- haengen bleibt.
function __sessionInitialUnitsJson()
  local teile = {}
  for _, id in ipairs(__sessionInitialUnits()) do
    teile[#teile + 1] = '"' .. id .. '"'
  end
  return '[' .. table.concat(teile, ',') .. ']'
end

--- Die Startposition einer Armee als JSON — derselbe Weg ueber die
--- wasmoon-Grenze wie `__sessionInitialUnitsJson`, weil `LuaHost.pull` einen
--- AUSDRUCK auswertet und `local x, z = ...` keiner ist.
---
--- `brain:GetArmyStartPos()` liefert zwei Zahlen, x und z
--- (cfunc_CAiBrainGetArmyStartPosL, Cfile:735971-735976); geschrieben hat sie
--- `InitializeStartLocation` aus dem Marker der Karte
--- (scenarioutilities.lua:1026-1033).
function __armyStartPosJson(index)
  local x, z = ArmyBrains[index]:GetArmyStartPos()
  return '[' .. x .. ',' .. z .. ']'
end
