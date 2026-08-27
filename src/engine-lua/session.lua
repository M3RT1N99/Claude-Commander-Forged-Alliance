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

--- Schritt 4a: was `SetupSession()` an der Szenariodatei tut
--- (siminit.lua:82-98). Braucht `ScenarioInfo.save` und `.script`.
---
--- Die Reihenfolge ist nicht beliebig: `_save.lua` besteht ausschliesslich aus
--- `GROUP()`/`VECTOR3()`/`STRING()`-Aufrufen, die `/lua/dataInit.lua` erst
--- definiert (datainit.lua:3-34). Ohne den ersten Schritt ist die Karte ein
--- Haufen nicht existierender Globals.
function __loadScenario()
  if not (ScenarioInfo and ScenarioInfo.save and ScenarioInfo.script) then
    error('__loadScenario: ScenarioInfo.save/.script fehlen — die Engine setzt '
      .. 'sie aus der Sitzung (Cfile:1071853-1071889)', 2)
  end
  doscript('/lua/dataInit.lua')
  ScenarioInfo.Env = import('/lua/scenarioEnvironment.lua')
  doscript(ScenarioInfo.save, ScenarioInfo.Env)
  Scenario = ScenarioInfo.Env.Scenario
  doscript(ScenarioInfo.script, ScenarioInfo.Env)
end

--- Schritt 5a je Armee — der Rumpf des schook-`OnCreateArmyBrain`
--- (schook/lua/simInit.lua:45-51, siminit.lua:113-126).
---
--- `InitializeStartLocation` (scenarioutilities.lua:1026-1033) liest den Marker
--- `ARMY_<n>` aus der eben geladenen Karte und ruft `SetArmyStart`; fehlt er,
--- greift `GenerateArmyStart`. Das muss VOR `OnPopulate` laufen, weil
--- `CreateInitialArmyUnit` die Startposition liest, statt eine zu bekommen
--- (Cfile:1025236-1025270).
function __initArmyFromScenario(name)
  local su = import('/lua/sim/ScenarioUtilities.lua')
  su.InitializeStartLocation(name)
  su.SetPlans(name)
  InitializeArmyAI(name)
end

--- Schritt 6a: `BeginSession()` (siminit.lua:145).
---
--- Gerufen wird NICHT `InitializeArmies()` direkt. Welche Funktion läuft,
--- entscheidet das Kartenskript: `doscript(ScenarioInfo.script, ...)` hat
--- `OnPopulate` in die Umgebung geschrieben und damit den No-op-Standard aus
--- `scenarioenvironment.lua:15-17` überschrieben. Für SCMP_009 ist das
--- `ScenarioUtils.InitializeArmies()` (SCMP_009_script.lua:3-5) — für eine
--- andere Karte etwas anderes, und genau darum darf hier nichts fest verdrahtet
--- sein.
function __beginSession()
  if not (ScenarioInfo and ScenarioInfo.Env) then
    error('__beginSession: __loadScenario() muss vorher gelaufen sein', 2)
  end
  if ScenarioInfo.Env.OnPopulate then ScenarioInfo.Env.OnPopulate(ScenarioInfo) end
  if ScenarioInfo.Env.OnStart then ScenarioInfo.Env.OnStart(ScenarioInfo) end
end

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
