-- =====================================================================
-- The engine console: ConExecute and the ConVars.
--
-- 19 of the 37 options act through exactly this path (options.lua):
--
--     set = function(key, value, startup)
--         ConExecute("ui_KeyboardPanSpeed " .. value)
--     end
--
-- Behind them sit real engine variables (Moho::TConVar<bool|int|float>, e.g.
-- `float Moho::ui_KeyboardPanSpeed = 90.0;`) that the C++ side reads in its
-- loops — the WorldView asks for ui_KeyboardPanSpeed every frame, the camera
-- for cam_ZoomAmount, the renderer for shadow_Fidelity.
--
-- Until now our ConExecute only logged. That made every one of those 19 options
-- a sham: the slider moved, the value was stored — and nobody ever read it.
--
-- TWO THINGS you must not guess:
--
--  1. The names are NOT case-sensitive. options.lua writes `ren_Skydome` and
--     `ren_bloom`, the engine calls them `Moho::ren_SkyDome` and
--     `Moho::ren_Bloom`. An exact compare loses exactly those two.
--  2. A console command is either a VARIABLE (name + value) or a FUNCTION
--     (CConFunc, e.g. WLD_IncreaseSimRate). A function we do not have is
--     reported ONCE — not silently swallowed.
--
-- STANDARD LUA 5.4 (goes raw into host.eval, not through the FA transpiler).
-- =====================================================================

__conVars = {}
__conUnknown = {}
__uiConSink = false

-- The variables the original Lua sets through ConExecute
-- (peek-lua --grep "ConExecute\("). All exist in the decomp as
-- Moho::TConVar or Moho::<name>.
local KNOWN_VARS = {
  'cam_ZoomAmount', 'cam_NearZoom', 'cam_PanSpeed',
  'ui_KeyboardPanSpeed', 'ui_KeyboardPanAccelerateMultiplier',
  'ui_KeyboardRotateSpeed', 'ui_KeyboardRotateAccelerateMultiplier',
  'ui_ScreenEdgeScrollView', 'ui_ArrowKeysScrollView', 'ui_SelectTolerance',
  'ui_AlwaysRenderStrategicIcons', 'ui_RenderUnitBars', 'ui_NisRenderIcons',
  'ui_RenderIcons', 'ui_ForceLifbarsOnEnemy',
  'graphics_Fidelity', 'shadow_Fidelity', 'ren_MipSkipLevels',
  'ren_SkyDome', 'ren_Bloom', 'ren_Oblivion', 'ren_SelectBoxes',
  'SC_CameraScaleLOD', 'SC_VerticalSync', 'SC_AntiAliasingSamples',
  'SC_PrimaryAdapter', 'SC_SecondaryAdapter', 'SC_ToggleCursorClip',
  -- The range rings (gamemain.lua:519-523, worldview.lua). Registered in the
  -- engine as "range_RenderHighlighted", "range_RenderSelected",
  -- "range_RenderBuild", "range_Fill", "range_InnerThicknessCoeff",
  -- "range_OuterThicknessCoeff".
  'range_RenderHighlighted', 'range_RenderSelected', 'range_RenderBuild',
  'range_Fill', 'range_InnerThicknessCoeff', 'range_OuterThicknessCoeff',
  -- The camera shake multiplier (func_CameraImplUpdateShake, Cfile:1148690).
  'cam_ShakeMult',
}

-- DEFAULTS — only the ones the decomp PROVES. A default I cannot back with
-- evidence is not invented: the variable then starts without a value and gets
-- it at startup from optionslogic.Apply(true), which runs every option through
-- its `set` (Moho::OPTIONS_Apply, Cfile:1368338).
local DEFAULTS = {
  cam_ZoomAmount = 0.40000001,                   -- Cfile:421825
  cam_NearZoom = 5.0,                            -- Cfile: float Moho::cam_NearZoom = 5.0
  cam_PanSpeed = 1.0,                            -- Cfile: float Moho::cam_PanSpeed = 1.0
  ui_KeyboardPanSpeed = 90.0,                    -- Cfile:421739
  ui_KeyboardPanAccelerateMultiplier = 4.0,      -- Cfile:421740
  ui_KeyboardRotateSpeed = 10.0,                 -- Cfile:421741
  ui_KeyboardRotateAccelerateMultiplier = 2.0,   -- Cfile:421742
  ui_ScreenEdgeScrollView = true,                -- Cfile:421730
  ui_SelectTolerance = 4.0,                      -- Cfile:421734
  ui_RenderUnitBars = true,                      -- Cfile:421748
  ui_NisRenderIcons = true,                      -- Cfile:421760
  ui_RenderIcons = true,                         -- Cfile:421748
  ui_ForceLifbarsOnEnemy = false,                -- Cfile:1285062
  graphics_Fidelity = 2,                         -- Cfile: int Moho::graphics_Fidelity = 2
  shadow_Fidelity = 2,                           -- Cfile: int Moho::shadow_Fidelity = 2
  cam_ShakeMult = 1.0,                           -- Cfile:421830
}

local function key(name)
  return string.lower(tostring(name))
end

for _, name in ipairs(KNOWN_VARS) do
  __conVars[key(name)] = { name = name, value = DEFAULTS[name] }
end

--- Read a ConVar's value (also from TS, via __conGet).
function __conGet(name)
  local entry = __conVars[key(name)]
  if not entry then return nil end
  return entry.value
end

local function parseValue(text)
  if text == nil or text == '' then return nil end
  local lower = string.lower(text)
  if lower == 'true' then return true end
  if lower == 'false' then return false end
  local n = tonumber(text)
  if n then return n end
  return text
end

--- ConExecute(cmd) — a console command, as the engine knows it.
---
--- Examples from the original Lua:
---   ConExecute("ui_KeyboardPanSpeed 90")     -- set a variable
---   ConExecute("ren_Skydome true")           -- (different case than Moho::ren_SkyDome!)
---   ConExecute("WLD_IncreaseSimRate")        -- function without an argument
function ConExecute(cmd)
  if not cmd then return end
  local text = tostring(cmd)
  local name, rest = string.match(text, '^%s*(%S+)%s*(.*)$')
  if not name then return end
  rest = string.match(rest, '^(.-)%s*$') -- Leerraum hinten weg

  -- UI_Lua <code>: "Run lua code in the appropriate UI lua state."
  -- (CConFunc_UI_Lua, Cfile:423593-423600). Almost every keymap action from
  -- keyactions.lua runs through it (e.g. the Esc handler:
  -- 'UI_Lua import("/lua/ui/uimain.lua").EscapeHandler()').
  if string.lower(name) == 'ui_lua' then
    local chunk, err = (loadstring or load)(rest, 'UI_Lua')
    if not chunk then
      WARN('UI_Lua: ' .. tostring(err))
      return
    end
    local ok, callErr = pcall(chunk)
    if not ok then WARN('UI_Lua: ' .. tostring(callErr)) end
    return
  end

  -- StartCommandMode <mode> <name> (CConFunc, Cfile:423450;
  -- CON_StartCommandMode Cfile:1255125-1255261): most keymap actions use it
  -- (keyactions.lua:194-200, e.g. 'StartCommandMode order RULEUCC_Attack').
  -- Issuing the SAME mode+name again toggles the command mode OFF (the
  -- stricmp pair against UI_GetCommandMode), otherwise it starts.
  if string.lower(name) == 'startcommandmode' then
    local mode, orderName = string.match(rest, '^(%S+)%s+(%S+)$')
    if not mode then
      WARN('StartCommandMode: expected "<mode> <name>", got "' .. tostring(rest) .. '"')
      return
    end
    local cm = import('/lua/ui/game/commandmode.lua')
    local cur = cm.GetCommandMode()
    if cur[1] == mode and type(cur[2]) == 'table' and cur[2].name == orderName then
      cm.EndCommandMode(true)
    else
      cm.StartCommandMode(mode, { name = orderName })
    end
    return
  end

  -- IssueCommand <cmd> (CConFunc func_ConFunc_IssueCommand, Cfile:1255032):
  -- maps the argument to a UNITCOMMAND_* and issues it to the current
  -- selection. The keymap drives it — 'stop' = 'IssueCommand Stop'
  -- (keyactions.lua:204), 'dive' etc. The engine's cases are Stop, Pause, Dive,
  -- SiloBuildTactical, SiloBuildNuke. This runs through the SAME UI-global
  -- IssueCommand the Stop button uses (sendSim -> the world dispatcher), so
  -- Stop works; Pause/Dive/Silo reach the dispatcher's honest "not wired" log
  -- (their sim tasks do not exist yet).
  if string.lower(name) == 'issuecommand' then
    local arg = string.match(rest, '^(%S+)')
    if not arg then
      WARN('IssueCommand: expected a command name, got "' .. tostring(rest) .. '"')
      return
    end
    -- Stop, Pause and Dive clear the queue (Cfile:1255061/1255071/1255081,
    -- ISSUE_Command(..., 1)); only the two silo builds append
    -- (Cfile:1255091/1255101, ISSUE_Command(..., 0)).
    local lower = string.lower(arg)
    local clear = not (lower == 'silobuildtactical' or lower == 'silobuildnuke')
    IssueCommand('UNITCOMMAND_' .. arg, nil, clear)
    return
  end

  -- === The UI console functions ===
  --
  -- Every one of them is a thin bridge into the ORIGINAL UI Lua in the engine
  -- too: CON_UI_MakeSelectionSet calls selection.lua AddCurrentSelectionSet
  -- (Cfile:834b6d/834b89), CON_UI_ApplySelectionSet calls ApplySelectionSet
  -- (Cfile:1255995), CON_UI_ToggleGamePanels calls gamemain.lua HideGameUI with
  -- NO argument (Cfile:1255891/1255893), CON_UI_RotateSkin/RotateLayout call
  -- uiutil.lua RotateSkin/RotateLayout with the direction string
  -- (Cfile:1255792/1255840). The keymap drives them: defaultkeymap.lua binds
  -- Ctrl+1..0 to UI_MakeSelectionSet and 1..0 to UI_ApplySelectionSet
  -- (keyactions.lua:26-46).
  local lower = string.lower(name)
  if lower == 'ui_makeselectionset' or lower == 'ui_applyselectionset' then
    if rest == '' then
      -- Same wording as the engine (Cfile:834c0d / 1255a0d).
      LOG('USAGE: ' .. name .. ' [name]')
      return
    end
    local selection = import('/lua/ui/game/selection.lua')
    if lower == 'ui_makeselectionset' then
      selection.AddCurrentSelectionSet(rest)
    else
      selection.ApplySelectionSet(rest)
    end
    return
  end

  if lower == 'ui_togglegamepanels' then
    import('/lua/ui/game/gamemain.lua').HideGameUI()
    return
  end

  if lower == 'ui_rotateskin' or lower == 'ui_rotatelayout' then
    local uiutil = import('/lua/ui/uiutil.lua')
    if lower == 'ui_rotateskin' then uiutil.RotateSkin(rest) else uiutil.RotateLayout(rest) end
    return
  end

  -- These two the ENGINE does itself (they never enter Lua): the selection is
  -- session state, so they live next to the rest of the selection code in
  -- ui-globals.lua.
  if lower == 'ui_expandcurrentselection' then
    __uiExpandCurrentSelection()
    return
  end
  if lower == 'ui_selectbycategory' then
    __uiSelectByCategory(rest)
    return
  end

  local entry = __conVars[key(name)]
  if entry then
    local value = parseValue(rest)
    if value == nil then
      -- No value given. For a BOOL ConVar the engine TOGGLES it and prints
      -- "toggled %s is now %s" (the TConVar<bool>::Execute specialization,
      -- Cfile:453672) — that is how the Alt+L 'toggle_lifebars' hotkey
      -- (keyactions.lua, action 'UI_RenderUnitBars') flips the bars. For a
      -- numeric/string ConVar the engine just prints the current value.
      if type(entry.value) == 'boolean' then
        entry.value = not entry.value
        if __uiConSink then
          __uiConSink(entry.name, entry.value)
        end
        LOG('toggled ' .. entry.name .. ' is now ' .. tostring(entry.value))
      else
        LOG(entry.name .. ' = ' .. tostring(entry.value))
      end
      return
    end
    entry.value = value
    -- Our engine is TypeScript: it has to learn about the change (the camera,
    -- renderer and selection read these values).
    if __uiConSink then
      __uiConSink(entry.name, value)
    end
    return
  end

  -- No known variable name -> a console FUNCTION (CConFunc). We do not have it
  -- yet. Report it ONCE, do not swallow it silently — otherwise nobody sees
  -- which engine part is missing next.
  if not __conUnknown[key(name)] then
    __conUnknown[key(name)] = text
    WARN('ConExecute: "' .. text .. '" — this console command is still missing')
  end
end

function ConExecuteSave(cmd)
  ConExecute(cmd)
end
