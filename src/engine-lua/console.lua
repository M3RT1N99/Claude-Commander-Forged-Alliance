-- =====================================================================
-- The engine's console: ConExecute and the ConVars.
--
-- 19 of the 37 options work in exactly this way (options.lua):
--
--     set = function(key, value, startup)
--         ConExecute("ui_KeyboardPanSpeed " .. value)
--     end
--
-- Behind this are real variables in the engine (Moho::TConVar<bool|int|float>,
-- e.g. E.g. `float Moho::ui_KeyboardPanSpeed = 90.0;`) that contains the C++ page in their
-- Loops reads — the WorldView queries ui_KeyboardPanSpeed ​​for each image,
-- the camera cam_ZoomAmount, the renderer shadow_Fidelity.
--
-- So far our ConExecute has only logged. That was each of these 19 options
-- a dummy: the controller moved, the value was saved — and
-- niemand las ihn je.
--
-- TWO THINGS not to advise:
--
--  1. The names are NOT case sensitive. options.lua writes `ren_Skydome`
--     and `ren_bloom`, the engine is called `Moho::ren_SkyDome` and
--     `Moho::ren_Bloom`. If you compare exactly, you lose exactly these two.
--  2. A console command is either a VARIABLE (name + value) or a
--     FUNCTION (CConFunc, e.g. WLD_IncreaseSimRate). A function that it at
--     doesn't exist to us, is reported ONCE - not swallowed up silently.
--
-- STANDARD LUA 5.4 (goes raw in host.eval, not through the FA transpiler).
-- =====================================================================

__conVars = {}
__conUnknown = {}
__uiConSink = false

-- The variables that the original Lua sets via ConExecute
-- (peek-lua --grep "ConExecute\()). All exist in the decomp as
-- Moho::TConVar or Moho::<name>.
local KNOWN_VARS = {
  'cam_ZoomAmount', 'cam_NearZoom', 'cam_PanSpeed',
  'ui_KeyboardPanSpeed', 'ui_KeyboardPanAccelerateMultiplier',
  'ui_KeyboardRotateSpeed', 'ui_KeyboardRotateAccelerateMultiplier',
  'ui_ScreenEdgeScrollView', 'ui_ArrowKeysScrollView', 'ui_SelectTolerance',
  'ui_AlwaysRenderStrategicIcons', 'ui_RenderUnitBars', 'ui_NisRenderIcons',
  'graphics_Fidelity', 'shadow_Fidelity', 'ren_MipSkipLevels',
  'ren_SkyDome', 'ren_Bloom', 'ren_Oblivion', 'ren_SelectBoxes',
  'SC_CameraScaleLOD', 'SC_VerticalSync', 'SC_AntiAliasingSamples',
  'SC_PrimaryAdapter', 'SC_SecondaryAdapter', 'SC_ToggleCursorClip',
  -- The range rings (gamemain.lua:519-523, worldview.lua). In the engine
  -- registriert: "range_RenderHighlighted", "range_RenderSelected",
  -- "range_RenderBuild", "range_Fill", "range_InnerThicknessCoeff",
  -- "range_OuterThicknessCoeff".
  'range_RenderHighlighted', 'range_RenderSelected', 'range_RenderBuild',
  'range_Fill', 'range_InnerThicknessCoeff', 'range_OuterThicknessCoeff',
}

-- START VALUES — only those that are USED in the decomp. A default that I
-- cannot be assigned, is not invented: the variable then starts without a value
-- and gets it when starting optionslogic.Apply(true), which includes every option
-- ihrem `set` durchlaeuft (Moho::OPTIONS_Apply, Cfile:1368338).
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
  graphics_Fidelity = 2,                         -- Cfile: int Moho::graphics_Fidelity = 2
  shadow_Fidelity = 2,                           -- Cfile: int Moho::shadow_Fidelity = 2
}

local function key(name)
  return string.lower(tostring(name))
end

for _, name in ipairs(KNOWN_VARS) do
  __conVars[key(name)] = { name = name, value = DEFAULTS[name] }
end

--- Read the value of a ConVar (also from TS, via __conGet).
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

--- ConExecute(cmd) — a console command as the engine knows it.
---
--- Examples from the original Lua:
---   ConExecute("ui_KeyboardPanSpeed 90")     -- Variable setzen
--- ConExecute("ren_Skydome true") -- (different case than Moho::ren_SkyDome!)
--- ConExecute("WLD_IncreaseSimRate") -- Function without argument
function ConExecute(cmd)
  if not cmd then return end
  local text = tostring(cmd)
  local name, rest = string.match(text, '^%s*(%S+)%s*(.*)$')
  if not name then return end
  rest = string.match(rest, '^(.-)%s*$') -- Empty space at the back

  -- UI_Lua <code>: "Run lua code in the appropriate UI lua state."
  -- (CConFunc_UI_Lua, Cfile:423593-423600). Almost every keymap action
  -- keyactions.lua runs over it (e.g. the Esc handler:
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

  local entry = __conVars[key(name)]
  if entry then
    local value = parseValue(rest)
    if value == nil then
      -- Variable without value: the engine outputs the current one. We do the same.
      LOG(entry.name .. ' = ' .. tostring(entry.value))
      return
    end
    entry.value = value
    -- Our engine is TypeScript: it has to know about the change
    -- (Camera, renderer, selection read these values).
    if __uiConSink then
      __uiConSink(entry.name, value)
    end
    return
  end

  -- No known value name -> a console FUNCTION (CConFunc). There are
  -- not yet with us. Report ONCE, don't swallow silently - otherwise you'll see
  -- no one knows which engine part is missing next.
  if not __conUnknown[key(name)] then
    __conUnknown[key(name)] = text
    WARN('ConExecute: "' .. text .. '" — dieser Konsolenbefehl fehlt noch')
  end
end

function ConExecuteSave(cmd)
  ConExecute(cmd)
end
