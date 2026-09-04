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
-- The FULL cap bit table, same values as the Sim's (globals.lua, faf-re
-- Unit.cpp:8675-8813). A partial mirror here silently reports `false` for
-- every missing cap — that is exactly how canReclaim broke: the UI mask
-- never contained RULEUCC_Reclaim, so the ACU "could not" reclaim.
local COMMAND_CAP_BITS = {
  RULEUCC_Move = 0x1,
  RULEUCC_Stop = 0x2,
  RULEUCC_Attack = 0x4,
  RULEUCC_Guard = 0x8,
  RULEUCC_Patrol = 0x10,
  RULEUCC_RetaliateToggle = 0x20,
  RULEUCC_Repair = 0x40,
  RULEUCC_Capture = 0x80,
  RULEUCC_Transport = 0x100,
  RULEUCC_CallTransport = 0x200,
  RULEUCC_Nuke = 0x400,
  RULEUCC_Tactical = 0x800,
  RULEUCC_Teleport = 0x1000,
  RULEUCC_Ferry = 0x2000,
  RULEUCC_SiloBuildTactical = 0x4000,
  RULEUCC_SiloBuildNuke = 0x8000,
  RULEUCC_Sacrifice = 0x10000,
  RULEUCC_Pause = 0x20000,
  RULEUCC_Overcharge = 0x40000,
  RULEUCC_Dive = 0x80000,
  RULEUCC_Reclaim = 0x100000,
  RULEUCC_SpecialAction = 0x200000,
  RULEUCC_Dock = 0x400000,
  RULEUCC_Script = 0x800000,
}

local function blueprintCommandCapMask(bp)
  local mask = 0
  local caps = bp.General and bp.General.CommandCaps
  for cap, bit in pairs(COMMAND_CAP_BITS) do
    if caps and caps[cap] == true then mask = mask | bit end
  end
  return mask
end

-- The UI mirror keeps the same mutable UnitAttributes command-cap mask as the
-- Sim. A blueprint initializes a new mirror once; subsequent synchronization
-- or cap mutations replace this field without changing the blueprint.
local function uiCommandCapMask(u, bp)
  if u.__commandCapMask == nil then u.__commandCapMask = blueprintCommandCapMask(bp) end
  return u.__commandCapMask
end

local function hasCommandCap(mask, cap)
  local bit = COMMAND_CAP_BITS[cap]
  return bit ~= nil and (mask & bit) == bit
end

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
    local commandCapMask = uiCommandCapMask(u, bp)
    -- Und der zweite Teil: eine FABRIK hat RULEUCC_Move in ihren CommandCaps —
    -- genau deshalb setzt ein Move-Befehl auf sie im Original den SAMMELPUNKT.
    -- Wer wirklich fahren kann, entscheidet die PHYSIK: `MotionType`. Eine Unit
    -- mit RULEUMT_None hat keinen Antrieb (und in der Sim keinen Navigator).
    local immobile = bp.Physics.MotionType == 'RULEUMT_None'
    local canMove = hasCommandCap(commandCapMask, 'RULEUCC_Move') and not immobile
    -- FACTORY steht in den Categories des Blueprints (ueb0101_unit.bp) — dieselbe
    -- Liste, aus der das Kategorie-System seine Ausdruecke baut.
    local isFactory = false
    for _, c in ipairs(bp.Categories or {}) do
      if c == 'FACTORY' then isFactory = true end
    end
    -- RULEUCC_Repair: a right-click on an own unfinished structure resumes
    -- the build through the repair task (dispatch 0x14) — only units with
    -- the cap get the order.
    local canRepair = hasCommandCap(commandCapMask, 'RULEUCC_Repair')
    -- IssueAttack filters by RULEUCC_Attack before creating a command
    -- (Cfile:1009211). The attack task then requires an attacker weapon that
    -- can accept the target (Cfile:813212). The UI has the blueprint view, so
    -- it can reject selections with no possible weapon before crossing to Sim.
    local canAttack = false
    local canAttackGround = false
    if hasCommandCap(commandCapMask, 'RULEUCC_Attack') then
      for _, weapon in ipairs(bp.Weapon or {}) do
        canAttack = true
        if not weapon.CannotAttackGround then canAttackGround = true end
      end
    end
    -- Entity guard is target-dependent: compatible stationary factories remain
    -- eligible, while the caller filters point guard through canMove.
    local canGuard = hasCommandCap(commandCapMask, 'RULEUCC_Guard')
    -- RULEUCC_Reclaim: engineers and ACUs may drain wrecks/map props
    -- (dispatch 0x13, CUnitReclaimTask) — the cap gates the click.
    local canReclaim = hasCommandCap(commandCapMask, 'RULEUCC_Reclaim')
    parts[i] = '{"id":' .. tostring(u:GetEntityId())
      .. ',"army":' .. tostring(u:GetArmy())
      .. ',"canMove":' .. tostring(canMove)
      .. ',"canRepair":' .. tostring(canRepair)
      .. ',"canAttack":' .. tostring(canAttack)
      .. ',"canAttackGround":' .. tostring(canAttackGround)
      .. ',"canGuard":' .. tostring(canGuard)
      .. ',"canReclaim":' .. tostring(canReclaim)
      .. ',"isFactory":' .. tostring(isFactory)
      -- IsMobile: the click handler splits the selection by it (sub_81EB20,
      -- Cfile:1239941-1240011) -- immobile units get FACTORY commands.
      .. ',"isMobile":' .. tostring(not immobile)
      .. '}'
  end
  return '[' .. table.concat(parts, ',') .. ']'
end

--- Der Command-Mode, wie die Original-Lua ihn fuehrt (commandmode.lua:109).
--- Rueckgabe als JSON: { mode = 'build'|'order'|false, name = <string>|false }
-- Command-mode cursor (worldview.lua:131-181 OnUpdateCursor): the world control
-- swaps the mouse cursor to the mode's SKIN cursor (skins.lua:170ff, a dedicated
-- animated cursor texture, NOT the order-button icon). Our worldview is a render
-- stub, so we drive the same mapping here each frame; GetCursor():SetTexture
-- (cursor.lua) forks the frame animation and pushes each frame through
-- SetNewTexture -> __uiSetCursorTexture (moho.lua:1300) to the DOM cursor.
__uiCursorId = false
function __uiUpdateCursor()
  local cur = GetCursor()
  if not cur or not cur.SetTexture then return end
  local cm = import('/lua/ui/game/commandmode.lua').GetCommandMode()
  local mode = cm and cm[1]
  local data = cm and cm[2]
  local id
  if mode == 'order' and data and data.name then
    id = data.name -- RULEUCC_* -> skins.cursors[RULEUCC_*]
  elseif mode == 'build' or mode == 'buildanchored' then
    id = 'BUILD'
  elseif mode then
    id = 'RULEUCC_Invalid'
  else
    id = false
  end
  -- Only touch the cursor when the mode changes, or the animation thread would
  -- be re-forked every frame (worldview.lua only sets it on a real change).
  if id == __uiCursorId then return end
  __uiCursorId = id
  if id then
    -- UIUtil.GetCursor returns the cursor def UNPACKED (texture, hotspotX,
    -- hotspotY, numFrames, fps — uiutil.lua:347), exactly what SetTexture wants;
    -- worldview.lua wraps it in a table then unpacks, we pass it straight
    -- through. SetTexture forks the frame animation and pushes each frame to the
    -- DOM bridge (cursor.lua _filename.OnDirty -> SetNewTexture).
    local tex, hx, hy, frames, fps = import('/lua/ui/uiutil.lua').GetCursor(id)
    if tex then cur:SetTexture(tex, hx, hy, frames, fps) end
  else
    if cur.Reset then cur:Reset() elseif cur.ResetToDefault then cur:ResetToDefault() end
    -- No default arrow texture is defined, so clear the DOM cursor explicitly.
    if __uiSetCursorTexture then __uiSetCursorTexture('', 0, 0) end
  end
end

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
