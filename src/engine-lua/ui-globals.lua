-- =====================================================================
-- UI-VM globals (scr_UserInits).
--
-- The engine has TWO Lua states. A binding's `mPrevDef` says which one it goes
-- into (see docs/research/engine-api.md, generated from the decomp):
--
--   scr_CoreInits  70 bindings — both VMs
--   scr_UserInits 453 bindings — UI only   <- this file
--   sim_SimInits  626 bindings — Sim only
--
-- That is why the Sim has no _c_CreateCursor and the UI has no CreateUnit.
-- This file grows as the original UI Lua asks for more; nothing is added on
-- suspicion.
-- =====================================================================

-- Alle Engine-Globals dieser Datei werden ZUERST angelegt. Grund: config.lua:56
-- haengt eine Metatable an _G, die den Zugriff auf ein NICHT EXISTIERENDES
-- Global zum Fehler macht ("access to nonexistent global variable") — die
-- Original-Engine hat unsere Anti-Stub-Regel selbst eingebaut. Ein `if
-- __uiFrames then` auf einem nie zugewiesenen Global wuerde danach knallen.
__uiFrames = {}
__uiSessionActive = false
__uiSavePrefs = false
__uiSetCursorTexture = false
__uiDiskFindFiles = false
__uiOnSelectionChanged = false
__cursor = false
__prefs = {}

-- === Cursor (_c_CreateCursor, Cfile:1129627-1129631) ===
-- Registered as a <global> in scr_UserInits. cursor.lua:8 calls it in __init;
-- moho.cursor_methods (5 bindings) carries the methods.
function _c_CreateCursor(luaobj, spec)
  luaobj.__spec = spec
  return luaobj
end

function SetCursor(c)
  __cursor = c
  return c
end

-- === Preferences (GetPreference/SetPreference/SavePreferences) ===
-- The engine keeps them in the user profile; the browser keeps them in
-- localStorage. Keys are dotted paths ('profile.profiles', 'options.foo').
__prefs = {}

local function prefPath(key)
  local parts = {}
  for part in string.gmatch(tostring(key), '[^.]+') do
    parts[#parts + 1] = part
  end
  return parts
end

function GetPreference(key, default)
  local node = __prefs
  for _, part in ipairs(prefPath(key)) do
    if type(node) ~= 'table' then return default end
    node = node[part]
    if node == nil then return default end
  end
  return node
end

function SetPreference(key, value)
  local parts = prefPath(key)
  local node = __prefs
  for i = 1, #parts - 1 do
    if type(node[parts[i]]) ~= 'table' then node[parts[i]] = {} end
    node = node[parts[i]]
  end
  node[parts[#parts]] = value
  if __uiSavePrefs then __uiSavePrefs() end
end

function SavePreferences()
  if __uiSavePrefs then __uiSavePrefs() end
end

-- GetOptions(key): the engine's option store (video, sound, gameplay).
-- prefs.lua:44 reads 'primary_adapter' when it creates a profile.
function GetOptions(key)
  local opts = GetPreference('options')
  if not opts then return nil end
  if key == nil then return opts end
  return opts[key]
end

-- === Selektion ===
-- Die Auswahl lebt in der UI-VM (die Sim erfaehrt sie erst ueber ein Kommando).
-- uiutil.lua:103 raeumt sie beim Layout-Wechsel mit SelectUnits(nil) ab.
-- Das Picking (Maus -> Unit) liefert die Engine; das kommt mit Schritt 4.
__uiSelection = false

function SelectUnits(units)
  if type(units) ~= 'table' or table.getn(units) == 0 then
    __uiSelection = false
  else
    __uiSelection = units
  end
  if __uiOnSelectionChanged then __uiOnSelectionChanged(__uiSelection) end
end

function GetSelectedUnits()
  if not __uiSelection then return nil end
  return __uiSelection
end

function AddSelectUnits(units)
  if type(units) ~= 'table' then return end
  local cur = __uiSelection or {}
  for _, u in ipairs(units) do cur[table.getn(cur) + 1] = u end
  SelectUnits(cur)
end

-- === Audio / Sprache ===
-- Localization.lua:43 fragt, ob es fuer die Sprache vertonte Sprachausgabe gibt,
-- und setzt danach die Audio-Sprache. Ein Audio-System gibt es noch nicht — das
-- wird hier ehrlich gesagt, statt so zu tun.
__uiAudioLanguage = 'us'
function HasLocalizedVO(la) return false end
function AudioSetLanguage(la) __uiAudioLanguage = la end

-- === Console ===
-- ConExecute runs an engine console command ('ui_SelectTolerance 5.0' …).
-- There is no console yet — log it instead of pretending it ran.
function ConExecute(cmd)
  LOG('ConExecute (nicht ausgefuehrt): ' .. tostring(cmd))
end
function ConExecuteSave(cmd) ConExecute(cmd) end

-- === Session / Umgebung ===
function GetVersion() return 'CFA' end
function DebugFacilitiesEnabled() return false end
function SessionIsReplay() return false end
function SessionIsMultiplayer() return false end
function SessionIsActive() return __uiSessionActive == true end
function GetGameTimeSeconds() return (GameTick and GameTick() or 0) * 0.1 end
function HasCommandLineArg() return false end
function GetCommandLineArg() return nil end

-- === Frames ===
-- GetFrame(0) is the root of the UI tree. The frame itself only exists once
-- the maui substrate is built (docs/PLAN-UI.md, Schritt 2) — until then this
-- must FAIL rather than hand out a fake root that silently swallows controls.
function GetFrame(index)
  if not __uiFrames or not __uiFrames[index] then
    error('GetFrame(' .. tostring(index) .. '): kein maui-Frame — Substrat fehlt noch', 2)
  end
  return __uiFrames[index]
end
function GetNumRootFrames() return __uiFrames and #__uiFrames or 0 end
