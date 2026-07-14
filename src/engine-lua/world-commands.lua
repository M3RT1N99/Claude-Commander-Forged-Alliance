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
function __uiSelectionJson()
  local sel = GetSelectedUnits()
  if not sel then return '[]' end
  local parts = {}
  for i, u in ipairs(sel) do
    parts[i] = '{"id":' .. tostring(u:GetEntityId()) .. ',"army":' .. tostring(u:GetArmy()) .. '}'
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
