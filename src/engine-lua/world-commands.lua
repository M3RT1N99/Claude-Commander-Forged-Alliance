-- =====================================================================
-- The engine part of the world view: Click -> Command.
--
-- NOTHING is decided here. The UI-Lua maintains the status ("what is it doing
-- next click?") in commandmode.lua; the engine QUESTIONS it, calculates the
-- Geometry and sends the command to the Sim. Then it reports it
-- executed command (commandmode.OnCommandIssued, commandmode.lua:146).
--
-- This Lua code was previously in TS template literals (`host.eval(\`…\`)`) —
-- forbidden (CLAUDE.md): no tool there sees it as Lua.
--
-- And he had a real mistake: the selection came back as a LUA TABLE, and
-- an EMPTY Lua table becomes `{}` in JS — not `[]`. `selection.length`
-- was then `undefined`, the test for 0 came to nothing, and the `for…of` threw
-- "selection is not iterable". That's why the queries here return JSON-TEXT
-- (LuaHost.pull), which becomes a real array in JS.
--
-- STANDARD LUA 5.4 (goes raw in host.eval, not through the FA transpiler).
-- =====================================================================

--- The selected entities as JSON — the same list as orders.lua and
--- construction.lua arbeiten (GetSelectedUnits).
--- What the click into the world means for EVERY unit - and that
--- it is not the worldview that decides, but the BLUEPRINT:
---
--- canMove RULEUCC_Move is in the CommandCaps -> Move command
--- isFactory the unit builds units -> COLLECTION POINT
---
--- A building does not have a RULEUCC_Move (uel0201 has it, ueb0101 does not). Become
--- Send movement orders to everyone anyway, allowing factories to pass through the area
--- drive - and the sim even teleported you to the click point
--- (motion.lua). The engine has its own binding for this:
--- `IssueFactoryRallyPoint(units, pos)` (sim_SimInits, Cfile:1008266).
function __uiSelectionJson()
  local sel = GetSelectedUnits()
  if not sel then return '[]' end
  local parts = {}
  for i, u in ipairs(sel) do
    local bp = u:GetBlueprint()
    -- The CommandCaps are under GENERAL, not at the top of the Blueprint
    -- (uel0001_unit.bp:787, and ui-globals.lua:433 reads it the same way). Who she
    -- searches at the top level, gets nil — and then no unit can
    -- run more because `canMove` is always false. That's exactly what happened.
    local caps = (bp.General and bp.General.CommandCaps) or {}
    -- And the second part: a FACTORY has RULEUCC_Move in its CommandCaps —
    -- That's exactly why a move command sets the COLLECTION POINT on it in the original.
    -- PHYSICS decides who can really drive: `MotionType`. One unit
    -- with RULEUMT_None has no drive (and no navigator in the sim).
    local immobile = bp.Physics.MotionType == 'RULEUMT_None'
    local canMove = caps.RULEUCC_Move == true and not immobile
    -- FACTORY is in the categories of the blueprint (ueb0101_unit.bp) — the same
    -- List from which the category system builds its expressions.
    local isFactory = false
    for _, c in ipairs(bp.Categories or {}) do
      if c == 'FACTORY' then isFactory = true end
    end
    -- RULEUCC_Repair: a right-click on an own unfinished structure resumes
    -- the build through the repair task (dispatch 0x14) — only units with
    -- the cap get the order.
    local canRepair = caps.RULEUCC_Repair == true
    parts[i] = '{"id":' .. tostring(u:GetEntityId())
      .. ',"army":' .. tostring(u:GetArmy())
      .. ',"canMove":' .. tostring(canMove)
      .. ',"canRepair":' .. tostring(canRepair)
      .. ',"isFactory":' .. tostring(isFactory)
      .. '}'
  end
  return '[' .. table.concat(parts, ',') .. ']'
end

--- The command mode as the original Lua runs it (commandmode.lua:109).
--- Return as JSON: { mode = 'build'|'order'|false, name = <string>|false }
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

--- The footprint mass of a blueprint (Footprint.SizeX/SizeZ).
--- The engine defaults pre-occupy every field (RUnitBlueprint-Ctor @0x51E480),
--- that's why the original Lua accesses it unchecked.
function __uiFootprintJson(blueprintId)
  local bp = __blueprints[blueprintId]
  if not bp then return 'null' end
  local sx = bp.Footprint.SizeX or 1
  local sz = bp.Footprint.SizeZ or 1
  return '[' .. tostring(sx) .. ',' .. tostring(sz) .. ']'
end

--- Report back the executed command (commandmode.lua:146). The Lua ended
--- then enter command mode (except when holding the shift key) and set the
--- Order buttons back.
---
--- The field layout is that of the engine: CommandType, Blueprint, Target.Position,
--- Clear (commandmode.lua:147-160).
function __uiCommandIssued(commandType, blueprint, x, y, z, clear)
  import('/lua/ui/game/commandmode.lua').OnCommandIssued({
    CommandType = commandType,
    Blueprint = blueprint or false,
    Target = { Position = { x, y, z } },
    Clear = clear == true,
  })
end
