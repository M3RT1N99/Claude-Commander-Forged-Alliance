-- =====================================================================
-- Der Engine-Teil der Weltansicht: Klick -> Befehl.
--
-- Hier wird NICHTS entschieden. Die UI-Lua haelt den Zustand ("was tut der
-- naechste Klick?") in commandmode.lua; die Engine FRAGT ihn ab, rechnet die
-- Geometrie und schickt den Befehl an die Sim. Danach meldet sie den
-- ausgefuehrten Befehl zurueck (commandmode.OnCommandIssued, commandmode.lua:146).
--
-- Dieser Lua-Code stand vorher in TS-Template-Literalen (`host.eval(\`…\`)`) —
-- verboten (CLAUDE.md): dort sieht ihn kein Werkzeug als Lua.
--
-- Und er hatte einen echten Fehler: die Auswahl kam als LUA-TABELLE zurueck, und
-- eine LEERE Lua-Tabelle wird in JS zu `{}` — nicht zu `[]`. `selection.length`
-- war dann `undefined`, die Pruefung auf 0 lief ins Leere, und der `for…of` warf
-- "selection is not iterable". Deshalb geben die Abfragen hier JSON-TEXT zurueck
-- (LuaHost.pull), der in JS ein echtes Array wird.
--
-- STANDARD-LUA 5.4 (geht roh in host.eval, nicht durch den FA-Transpiler).
-- =====================================================================

--- Die ausgewaehlten Einheiten als JSON — dieselbe Liste, mit der orders.lua und
--- construction.lua arbeiten (GetSelectedUnits).
--- Dazu, was der Klick in die Welt fuer JEDE Einheit bedeutet — und das
--- entscheidet nicht die Weltansicht, sondern der BLUEPRINT:
---
---   canMove    RULEUCC_Move steht in den CommandCaps  -> Bewegungsbefehl
---   isFactory  die Einheit baut Einheiten             -> SAMMELPUNKT
---
--- Ein Gebaeude hat kein RULEUCC_Move (uel0201 hat es, ueb0101 nicht). Wer den
--- Bewegungsbefehl trotzdem an alle schickt, laesst Fabriken durch die Gegend
--- fahren — und die Sim hat sie bis eben sogar an den Klickpunkt teleportiert
--- (motion.lua). Die Engine hat dafuer eine eigene Bindung:
--- `IssueFactoryRallyPoint(units, pos)` (sim_SimInits, Cfile:1008266).
function __uiSelectionJson()
  local sel = GetSelectedUnits()
  if not sel then return '[]' end
  local parts = {}
  for i, u in ipairs(sel) do
    local bp = u:GetBlueprint()
    -- Die CommandCaps stehen unter GENERAL, nicht oben im Blueprint
    -- (uel0001_unit.bp:787, und ui-globals.lua:433 liest sie genauso). Wer sie
    -- auf der obersten Ebene sucht, bekommt nil — und dann kann keine Einheit
    -- mehr laufen, weil `canMove` immer false ist. Genau so passiert.
    local caps = (bp.General and bp.General.CommandCaps) or {}
    -- Und der zweite Teil: eine FABRIK hat RULEUCC_Move in ihren CommandCaps —
    -- genau deshalb setzt ein Move-Befehl auf sie im Original den SAMMELPUNKT.
    -- Wer wirklich fahren kann, entscheidet die PHYSIK: `MotionType`. Eine Unit
    -- mit RULEUMT_None hat keinen Antrieb (und in der Sim keinen Navigator).
    local immobile = bp.Physics.MotionType == 'RULEUMT_None'
    local canMove = caps.RULEUCC_Move == true and not immobile
    -- FACTORY steht in den Categories des Blueprints (ueb0101_unit.bp) — dieselbe
    -- Liste, aus der das Kategorie-System seine Ausdruecke baut.
    local isFactory = false
    for _, c in ipairs(bp.Categories or {}) do
      if c == 'FACTORY' then isFactory = true end
    end
    parts[i] = '{"id":' .. tostring(u:GetEntityId())
      .. ',"army":' .. tostring(u:GetArmy())
      .. ',"canMove":' .. tostring(canMove)
      .. ',"isFactory":' .. tostring(isFactory)
      .. '}'
  end
  return '[' .. table.concat(parts, ',') .. ']'
end

--- Der Command-Mode, wie die Original-Lua ihn fuehrt (commandmode.lua:109).
--- Rueckgabe als JSON: { mode = 'build'|'order'|false, name = <string>|false }
function __uiCommandModeJson()
  local cm = import('/lua/ui/game/commandmode.lua').GetCommandMode()
  local mode = cm[1]
  local name = cm[2] and cm[2].name
  local function str(v)
    if not v then return 'false' end
    return '"' .. tostring(v) .. '"'
  end
  return '{"mode":' .. str(mode) .. ',"name":' .. str(name) .. '}'
end

--- Die Footprint-Masse eines Blueprints (Footprint.SizeX/SizeZ).
--- Die Engine-Defaults belegen jedes Feld vor (RUnitBlueprint-Ctor @0x51E480),
--- deshalb greift die Original-Lua ungeprueft darauf zu.
function __uiFootprintJson(blueprintId)
  local bp = __blueprints[blueprintId]
  if not bp then return 'null' end
  local sx = bp.Footprint.SizeX or 1
  local sz = bp.Footprint.SizeZ or 1
  return '[' .. tostring(sx) .. ',' .. tostring(sz) .. ']'
end

--- Den ausgefuehrten Befehl zurueckmelden (commandmode.lua:146). Die Lua beendet
--- daraufhin den Command-Mode (ausser bei gehaltener Shift-Taste) und setzt die
--- Order-Buttons zurueck.
---
--- Das Feld-Layout ist das der Engine: CommandType, Blueprint, Target.Position,
--- Clear (commandmode.lua:147-160).
function __uiCommandIssued(commandType, blueprint, x, y, z, clear)
  import('/lua/ui/game/commandmode.lua').OnCommandIssued({
    CommandType = commandType,
    Blueprint = blueprint or false,
    Target = { Position = { x, y, z } },
    Clear = clear == true,
  })
end
