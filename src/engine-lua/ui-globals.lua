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

-- All engine globals in this file are created FIRST. Reason: config.lua:56
-- appends a metatable to _G that allows access to a NON-EXISTENT
-- Global makes a mistake (“access to nonexistent global variable”) — the
-- Original engine built in our anti-stub rule itself. An 'if
-- __uiFrames then` on a never assigned global would pop afterwards.
__uiFrames = {}
__uiSessionActive = false
__uiSavePrefs = false
__uiSetCursorTexture = false
__uiDiskFindFiles = false
__uiOnSelectionChanged = false
__blueprints = {}
__uiUnits = {}
__uiRollover = false
__uiOverlayFilters = {}
__uiTeamColorMode = 'FactionColor'
__cursor = false
__prefs = {}
-- World point -> screen. Only the 3D side can do that; she gets stuck here.
__uiWorldProject = false

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

-- === Kameras ===
--
-- There are SEVERAL: 'WorldCamera' (the main view), 'MiniMap', 'CameraHead2'.
-- worldview.lua:593 gets it via GetCamera(name), minimap.lua via yours
-- own name. The camera itself is the 3D page (TypeScript) — it says here
-- the access, not the bill.
__uiCameras = {}
__uiCameraBridge = false

--- GetCamera(name) — the camera object to a name (scr_UserInits).
function GetCamera(name)
  local key = tostring(name or 'WorldCamera')
  if not __uiCameras[key] then
    local cam = Class(moho.camera_methods) {}()
    cam.__name = key
    __uiCameras[key] = cam
  end
  return __uiCameras[key]
end

--- The bridge to the 3D page. If it is missing, NOTHING is claimed: a camera that
--- no one renders, no zoom either.
function __uiCameraGet(name, what)
  if not __uiCameraBridge then return nil end
  return __uiCameraBridge('get', name, what)
end

function __uiCameraSet(name, what, value, seconds)
  if not __uiCameraBridge then return end
  __uiCameraBridge('set', name, what, value, seconds)
end

function __uiCameraMove(name, pos, hpr, zoom, seconds)
  if not __uiCameraBridge then return end
  __uiCameraBridge('move', name, pos, hpr, zoom, seconds)
end

--- "UIZoomTo(units,[seconds])" (Cfile:1292715): the main camera moves to the
--- Center of the given units. gamemain.OnFirstUpdate zooms at startup like this
--- to the ACU; The avatar icons then jump to their unit.
function UIZoomTo(units, seconds)
  local n, cx, cy, cz = 0, 0, 0, 0
  for _, u in ipairs(units or {}) do
    local p = u.GetPosition and u:GetPosition()
    if p then
      cx, cy, cz = cx + (p[1] or 0), cy + (p[2] or 0), cz + (p[3] or 0)
      n = n + 1
    end
  end
  if n == 0 then return end
  __uiCameraMove('WorldCamera', { cx / n, cy / n, cz / n }, nil, nil, seconds)
end

--- avatars.lua:42 jumps to the next idle engineer with a click.
function UISelectAndZoomTo(unit, seconds)
  if not unit then return end
  SelectUnits({ unit })
  UIZoomTo({ unit }, seconds)
end

-- GetCursor() (Cfile:1274426) — the current cursor object. uimain.lua:23 sets
-- it new at EVERY change of state; splash.lua:27/52 blinds it during the
-- films out. Previously it threw it out of the miss list and took the splash with it.
function GetCursor()
  return __cursor or nil
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

-- The engine gives a COPY to the Lua, not a reference: cfunc_GetPreferenceL
-- ruft `Moho::SCR_Copy(&a1, v5, esi0)` (Cfile:1370179), cfunc_GetOptionsL
-- exactly the same (Cfile:1370017). This is not a detail, but the reason why
-- `Prefs.SetOption` ueberhaupt funktioniert:
--
--   SetOption gets the options table with optionslogic.GetCurrent(),
--   changes ONE value in it and passes it to SetCurrent(). SetCurrent
--   then compares them against GetCurrent() — and calls `item.set` only for those
--   Values ​​that DIFFER (optionslogic.lua:100-123).
--
-- If we published the living table, the "old" table would be the same as
-- the "new": SetOption would have already changed the value in the profile, the comparison
-- I couldn't find any difference and `set` would NEVER work. The option landed dutifully in the
-- Prefs - and still had no effect.
local function deepCopy(value)
  if type(value) ~= 'table' then return value end
  local out = {}
  for k, v in pairs(value) do
    out[k] = deepCopy(v)
  end
  return out
end

function GetPreference(key, default)
  local node = __prefs
  for _, part in ipairs(prefPath(key)) do
    if type(node) ~= 'table' then return default end
    node = node[part]
    if node == nil then return default end
  end
  return deepCopy(node)
end

function SetPreference(key, value)
  local parts = prefPath(key)
  local node = __prefs
  for i = 1, #parts - 1 do
    if type(node[parts[i]]) ~= 'table' then node[parts[i]] = {} end
    node = node[parts[i]]
  end
  node[parts[#parts]] = value
  __prefsFlush()
end

function SavePreferences()
  __prefsFlush()
end

-- The way out: the engine writes Game.prefs as LUA SOURCE TEXT
-- (checked in the installation: `PreGameData = { CurrentMapDir = '...' }`).
-- __prefsSerialize() (prefs.lua) does exactly this text; __uiSavePrefs sets it
-- (in the browser: localStorage). Without the catch, SavePreferences() was a
-- Zero call and every setting gone after reload.
function __prefsFlush()
  if __uiSavePrefs then
    __uiSavePrefs(__prefsSerialize())
  end
end

-- GetOptions(key): the engine's option store (video, sound, gameplay).
-- prefs.lua:44 reads 'primary_adapter' when it creates a profile.
-- GetOptions(key) — "obj GetOptions()" (Cfile:1369977), Rumpf:
-- CUserPrefs::LookupCurrentOption (Cfile:1370017). It is the option of
-- CURRENT PROFILE, not a global table: optionslogic.lua includes it
-- `Prefs.SetToCurrentProfile('options', curOptions)` (line 60) right there
-- and reads it again with `Prefs.GetFromCurrentProfile('options')` (line 48).
-- If you read GetPreference('options') instead, you'll never see the change —
-- prefs.SetOption('mainmenu_bgmovie', false) fizzled out silently, and the menu
-- baute weiter seinen Film.
function GetOptions(key)
  local profile = GetPreference('profile')
  if not profile or not profile.current or not profile.profiles then return nil end
  local current = profile.profiles[profile.current]
  if not current or not current.options then return nil end
  -- Here too a COPY (Moho::SCR_Copy, Cfile:1370017) — see GetPreference.
  if key == nil then return deepCopy(current.options) end
  return deepCopy(current.options[key])
end

-- =====================================================================
-- UserUnit — the UI's view of a unit.
--
-- This is NOT the sim unit. The engine maintains a mirrored one on the client side
-- Structure (UserUnit::mUnitVarDat, filled by UserUnit::UpdateUnitData
-- @0x8C0750, Cfile:1363724) and publishes 36 methods on it
-- (Cfile:1364828-1367242). The UI only calls a handful of them - the rest of them
-- Data comes as a plain field from the rollover info.
--
-- This is fed per Sim beat from the worker snapshot.
-- =====================================================================
__uiUnits = {}

-- The UserUnit class of the UI VM (Cfile: 35 bindings). She is NOT a moho class:
-- the engine gives the UI its own objects. Global, so that the engine comparison
-- (scripts/coverage-engine.ts) sie pruefen kann.
__userUnitMethods = {}
local UserUnitMeta = __userUnitMethods
UserUnitMeta.__index = UserUnitMeta

function UserUnitMeta:GetEntityId() return self.id end
function UserUnitMeta:GetUnitId() return self.blueprintId end
function UserUnitMeta:GetArmy() return self.army end
function UserUnitMeta:GetBlueprint() return __blueprints[self.blueprintId] end
function UserUnitMeta:GetHealth() return self.health end
function UserUnitMeta:GetMaxHealth() return self.maxHealth end
function UserUnitMeta:GetPosition() return { self.x, self.y, self.z } end
function UserUnitMeta:GetFuelRatio() return self.fuelRatio or -1 end
function UserUnitMeta:GetShieldRatio() return self.shieldRatio or 0 end
function UserUnitMeta:GetWorkProgress() return self.workProgress or 0 end
function UserUnitMeta:IsDead() return self.dead == true end
-- The mirror now reports idle REAL (units.lua readRow: no target, none
-- Construction order, no production) — nil is an error here, not an idle.
function UserUnitMeta:IsIdle() return self.idle == true end
function UserUnitMeta:IsStunned() return false end
function UserUnitMeta:IsAutoMode() return false end
function UserUnitMeta:IsAutoSurfaceMode() return false end
function UserUnitMeta:IsRepeatQueue() return false end
function UserUnitMeta:IsOverchargePaused() return false end
function UserUnitMeta:GetBuildRate() return self.buildRate or 0 end
function UserUnitMeta:GetCustomName() return self.customName end
function UserUnitMeta:GetFocus() return nil end
function UserUnitMeta:GetGuardedEntity() return nil end
function UserUnitMeta:GetCreator() return nil end
function UserUnitMeta:GetCommandQueue() return self.commandQueue or {} end
function UserUnitMeta:GetSelectionSets() return {} end
function UserUnitMeta:HasSelectionSet() return false end
function UserUnitMeta:GetFootPrintSize()
  local bp = self:GetBlueprint()
  if not bp then return 1 end
  return math.max(bp.Footprint.SizeX or 1, bp.Footprint.SizeZ or 1)
end
function UserUnitMeta:IsInCategory(cat)
  return EntityCategoryContains(categories[cat] or cat, self:GetBlueprint())
end

function UserUnitMeta:GetFireState() return self.fireState or 0 end

-- SetCustomName: gamemain.OnFirstUpdate names the ACU with the player name
-- (gamemain.lua:84); unitview.lua:205 shows it in rollover. The name lives on
-- the UI copy — the original engine also syncs it into the sim (later,
-- with the UnitData sync).
function UserUnitMeta:SetCustomName(name) self.customName = name end
-- The build queue of a factory: { { id = <blueprintId>, count = <n> }, ... }
-- (construction.lua:1620). It is mirrored out of the sim; empty means empty.
function UserUnitMeta:GetBuildQueue() return self.buildQueue or {} end

-- GetAttachedUnitsList(units): the transported/docked units of the
-- Selection (construction.lua:1630). Without transporters in the sim is the list
-- empty - that is a fact, not a gap.
function GetAttachedUnitsList(units)
  local out = {}
  for _, u in ipairs(units or {}) do
    for _, a in ipairs(u.attached or {}) do out[table.getn(out) + 1] = a end
  end
  return out
end

-- From the engine per beat: the state of a unit from the sim.
function __uiSetUnit(id, blueprintId, army, x, y, z, health, maxHealth, workProgress, idle)
  local u = __uiUnits[id]
  if not u then
    -- SUnitVarDat-Ctor (Cfile:772277): mFireState = FIRESTATE_ReturnFire (0).
    u = setmetatable({ id = id, fireState = 0 }, UserUnitMeta)
    __uiUnits[id] = u
  end
  u.blueprintId = blueprintId
  u.army = army
  u.x = x
  u.y = y
  u.z = z
  u.health = health
  u.maxHealth = maxHealth
  u.workProgress = workProgress
  u.idle = idle
  u.dead = false
end

-- Mirror the construction queue of a factory in the sim. The engine holds them
-- in the UI copy of the unit; construction.lua reads it over
-- SetCurrentFactoryForQueueDisplay and display them as a stack.
function __uiSetBuildQueue(id, items)
  local u = __uiUnits[id]
  if not u then return end
  u.buildQueue = items or {}
end

function __uiRemoveUnit(id)
  local u = __uiUnits[id]
  if u then u.dead = true end
  __uiUnits[id] = nil
end

-- === The lists from which the avatar bar lives (top right) ===
--
--   "table GetArmyAvatars() - return a table of avatar units for the army"
--   (mHelp, Cfile:1360874)
--
-- avatars.lua:658 uses this to build the clickable icons (the ACU!), gamemain.lua:79
-- gives the ACU the player name when starting. Without these lists, that remains
-- Avatar bar EMPTY — that's exactly what I saw.
--
-- An "avatar" is a unit of your own army in the COMMAND category
-- (the commander; with Nomads/Sub-Commander more). Filtering is done via the
-- Blueprint categories — no special list, no advised selection.
local function unitsOfFocusArmy(pred)
  local out = {}
  for _, u in pairs(__uiUnits) do
    if not u.dead and u.army == __uiFocusArmy then
      local bp = __blueprints[u.blueprintId]
      if bp and pred(bp, u) then out[table.getn(out) + 1] = u end
    end
  end
  if table.getn(out) == 0 then return nil end
  return out
end

local function hasCategory(bp, want)
  for _, c in ipairs(bp.Categories or {}) do
    if c == want then return true end
  end
  return false
end

function GetArmyAvatars()
  -- The criterion of the engine (UserUnit-Ctor, Cfile:1362979-1362982): a
  -- Avatar is any unit with bp.General.QuickSelectPriority > 0 (Ctor-Default
  -- 0, Cfile:656079 — in vanilla only the four ACU-.bp set it to 1).
  -- The sorting is ASCROWING: before the first STRICTLY larger entry
  -- (Cfile:1352238-1352239); with the same priority it remains
  -- Order of creation - here the unit ID (the Sim assigns it in ascending order).
  local out = unitsOfFocusArmy(function(bp)
    return (bp.General.QuickSelectPriority or 0) > 0
  end)
  -- If the list is empty, the engine returns NIL, not an empty table
  -- (cfunc_GetArmyAvatarsL, Cfile:1360921: nothing works without entries
  -- gepusht) — avatars.lua:666 prueft `if avatars then`.
  if not out then return nil end
  table.sort(out, function(a, b)
    local pa = (__blueprints[a.blueprintId].General.QuickSelectPriority) or 0
    local pb = (__blueprints[b.blueprintId].General.QuickSelectPriority) or 0
    if pa ~= pb then return pa < pb end
    return a.id < b.id
  end)
  return out
end

-- Idle engineers/factories (the two buttons under the avatars).
-- "Idle" is the state that the sim reports (u.idle).
function GetIdleEngineers()
  -- mIsEngineer (UserUnit-Ctor, Cfile:1362995-1363014): Kategorie ENGINEER,
  -- but NOT COMMAND, SCOUT or UNTARGETABLE - otherwise they would be there
  -- idling ACU in the engineering tab.
  return unitsOfFocusArmy(function(bp, u)
    return u.idle == true and hasCategory(bp, 'ENGINEER')
      and not hasCategory(bp, 'COMMAND')
      and not hasCategory(bp, 'SCOUT')
      and not hasCategory(bp, 'UNTARGETABLE')
  end)
end

function GetIdleFactories()
  return unitsOfFocusArmy(function(bp, u)
    return u.idle == true and hasCategory(bp, 'FACTORY')
  end)
end

-- "IsKeyDown(keyCode)" (mHelp Cfile:1141963; Body 1141975-1142000): the
-- String is resolved into an EMauiKeyCode using SCR_GetEnum and
-- MAUI_KeyIsDown asked. The original UI asks for exactly ONE name: 'Shift'
-- (commandmode.lua:82 — if the player holds Shift, the command mode remains
-- active after the first command: the build queue). The condition comes
-- from the browser keyboard events (gameUi.attachEvents -> __uiSetKeyDown);
-- headless, no key is pressed - that is also the truth.
__uiKeysDown = {}

function __uiSetKeyDown(name, down)
  __uiKeysDown[name] = down == true
end

function IsKeyDown(keyCode)
  return __uiKeysDown[keyCode] == true
end

-- "Validate a list of units" (mHelp, Cfile:1360576; Body 1360596-1360650):
-- filters a unit list for live UserUnits (not IsDead, not
-- DestroyQueued), order is preserved. There is ALWAYS a return
-- Table, also empty (AssignNewTable + PushStack — different than that
-- Avatar lists!); without session nil (return 0, Cfile:1360604).
-- Filter controlgroups.lua:102 (ctrl groups) and selection.lua:82/132/165
-- thus dead units from saved lists.
function ValidateUnitsList(units)
  if not __uiScenarioInfo then return nil end
  local out = {}
  if type(units) == 'table' then
    for _, u in ipairs(units) do
      if type(u) == 'table' and u.id and __uiUnits[u.id] and not u.dead then
        out[table.getn(out) + 1] = u
      end
    end
  end
  return out
end

-- "Get a list of units assisting me" (mHelp, Cfile:1360671): the Guards of the
-- given units. orders.lua:932 asks one of the drones
-- PODSTAGING PLATFORM - and the UEF-ACU CARRIES this category
-- (uel0001_unit.bp:125); So the path runs with every ACU selection. Our
-- Sim does not yet have a guard/assist system: the mirror does not know one
-- Wizards, the empty list is the TRUE answer. As soon as the Sim Assist
-- learns, the mirror has to deliver the guards here.
function GetAssistingUnitsList(units)
  return {}
end

-- === Selektion ===
--
-- ATTENTION: GetSelectedUnits() returns `nil`, not `{}`, if the selection is EMPTY
-- (Cfile:1361395: lua_pushnil). The entire original UI also checks
-- `if GetSelectedUnits() then` (construction.lua:1891, orders.lua:1250,
-- buildmode.lua:50). An empty table would be wrong here.
__uiSelection = false

function GetSelectedUnits()
  if not __uiSelection or table.getn(__uiSelection) == 0 then return nil end
  return __uiSelection
end

-- SelectUnits(nil) means "deselect everything" (uiutil.lua:103) and is legal.
-- Return: the accepted units (Cfile:1361553).
function SelectUnits(units)
  local old = __uiSelection or {}
  local new = {}
  if type(units) == 'table' then
    for _, u in ipairs(units) do
      if not u:IsDead() then new[table.getn(new) + 1] = u end
    end
  end
  __uiSelection = new

  -- The engine notifies the UI via the SelectionListener
  -- (Moho::SelectionListener::Receive @0x869060, Cfile:1294170), the
  -- gamemain.OnSelectionChanged(old, new, added, removed) ruft.
  __uiNotifySelectionChanged(old, new)
  return new
end

function AddSelectUnits(units)
  if type(units) ~= 'table' then return end
  local cur = {}
  for _, u in ipairs(__uiSelection or {}) do cur[table.getn(cur) + 1] = u end
  for _, u in ipairs(units) do cur[table.getn(cur) + 1] = u end
  SelectUnits(cur)
end

-- calculate added/removed and call gamemain.OnSelectionChanged — exactly what
-- what CWldSession::SetSelection (Cfile:1329207) does before overwriting.
function __uiNotifySelectionChanged(old, new)
  -- The SelectionListener originally only exists DURING a session
  -- (the engine registers it when the session starts). There is none before
  -- Receiver: SetupUI calls SelectUnits(nil) via SetCurrentLayout
  -- (uiutil.lua:103), and that would otherwise be gamemain.OnSelectionChanged
  -- trigger before the order panel is even built
  -- (orders.lua:1087 then accesses a nil grid).
  if not __uiSessionActive then return end

  local inOld = {}
  for _, u in ipairs(old) do inOld[u.id] = true end
  local inNew = {}
  for _, u in ipairs(new) do inNew[u.id] = true end

  local added, removed = {}, {}
  for _, u in ipairs(new) do
    if not inOld[u.id] then added[table.getn(added) + 1] = u end
  end
  for _, u in ipairs(old) do
    if not inNew[u.id] then removed[table.getn(removed) + 1] = u end
  end

  local ok, gm = pcall(import, '/lua/ui/game/gamemain.lua')
  if ok and gm and gm.OnSelectionChanged then
    gm.OnSelectionChanged(old, new, added, removed)
  end
end

-- The engine selects: Mouse picking provides the unit IDs that UI-VM does
-- from it UserUnits and calls SelectUnits.
function __uiSelectByIds(ids)
  local units = {}
  for _, id in ipairs(ids or {}) do
    local u = __uiUnits[id]
    if u then units[table.getn(units) + 1] = u end
  end
  SelectUnits(units)
  return table.getn(units)
end

-- === Oekonomie (Sim -> UI) ===
-- GetEconomyTotals() returns exactly the five tables that economy.lua:271-275
-- reads, each with the keys MASS and ENERGY.
--
-- IMPORTANT: the values ​​are PER TICK, not per second — economy.lua:277-279
-- multiplies it itself with GetSimTicksPerSecond(). Anyone here values ​​pro
-- second, shows ten times as much.
__uiEcon = {
  maxStorage = { MASS = 0, ENERGY = 0 },
  stored = { MASS = 0, ENERGY = 0 },
  income = { MASS = 0, ENERGY = 0 },
  lastUseRequested = { MASS = 0, ENERGY = 0 },
  lastUseActual = { MASS = 0, ENERGY = 0 },
}

function GetEconomyTotals()
  return __uiEcon
end

function GetSimTicksPerSecond()
  return 10
end

-- Fed by the engine per sim beat (the worker sends the state).
function __uiSetEconomy(maxM, maxE, storedM, storedE, incM, incE, reqM, reqE, useM, useE)
  local e = __uiEcon
  e.maxStorage.MASS = maxM
  e.maxStorage.ENERGY = maxE
  e.stored.MASS = storedM
  e.stored.ENERGY = storedE
  -- per tick (the sim calculates in units per second)
  e.income.MASS = incM * 0.1
  e.income.ENERGY = incE * 0.1
  e.lastUseRequested.MASS = reqM * 0.1
  e.lastUseRequested.ENERGY = reqE * 0.1
  e.lastUseActual.MASS = useM * 0.1
  e.lastUseActual.ENERGY = useE * 0.1
end

-- === Command data of the selection ===
--
-- GetUnitCommandData(unitSet) -> orders, toggles, buildableCategories
-- (Cfile:1264504-1264646). The engine charges per unit
-- CommandCaps/ToggleCaps and the precompiled build category from the
-- Blueprint (bp.Economy.BuildableCategory) and accumulates via selection
-- as ASSOCIATION (EntityCategory::Add).
--
-- orders/toggles are ARRAYS of cap strings — orders.lua:891 iterates over them
-- mit `for index, availOrder in availableOrders do`.
--
-- If you select EMPTY, the engine returns EMPTY TABLES, not nil: the two
-- AssignNewTable calls (Cfile:1264740, :1264765) are BEHIND the loop
-- via the units and therefore always run. Anyone who gives nothing back here kills
-- orders.lua:891 (`for index, availOrder in availableOrders do`) for everyone
-- Deselection — and with it the entire UI VM.
function GetUnitCommandData(units)
  if type(units) ~= 'table' or table.getn(units) == 0 then return {}, {}, nil end

  local orderSet, toggleSet = {}, {}
  local cats = nil

  for _, u in ipairs(units) do
    local bp = u:GetBlueprint()
    if bp then
      for cap, on in pairs((bp.General and bp.General.CommandCaps) or {}) do
        if on then orderSet[cap] = true end
      end
      for cap, on in pairs((bp.General and bp.General.ToggleCaps) or {}) do
        if on then toggleSet[cap] = true end
      end
      local buildable = bp.Economy and bp.Economy.BuildableCategory
      if buildable then
        for _, expr in ipairs(buildable) do
          local c = ParseEntityCategory(expr)
          if cats then cats = cats + c else cats = c end
        end
      end
    end
  end

  local orders, toggles = {}, {}
  for cap in pairs(orderSet) do orders[table.getn(orders) + 1] = cap end
  for cap in pairs(toggleSet) do toggles[table.getn(toggles) + 1] = cap end
  table.sort(orders)
  table.sort(toggles)
  return orders, toggles, cats
end

-- === The seam to the sim ===
--
-- In the original, the engine sends every UI command to the UI as ProcessInfo
-- SimDriver (cfunc_SetFireStateL: sSimDriver->ProcessInfo(entityId,
-- "SetFireState", value)) — the UI doesn't SET anything, it ASKS. Here it is
-- the same seam: a function that the engine sets. If it's missing, it BANGS -
-- an order that fizzles out quietly is worse than none at all.
__uiSimCommand = false

local function idsOf(units)
  local ids = {}
  for _, u in ipairs(units or {}) do ids[table.getn(ids) + 1] = u:GetEntityId() end
  return ids
end

local function sendSim(name, units, value)
  if not __uiSimCommand then
    error('Befehl "' .. name .. '" hat keinen Weg in die Sim (__uiSimCommand fehlt)', 2)
  end
  __uiSimCommand(name, idsOf(units), value)
end

-- === SimCallback — calling Lua functions in the sim ===
--
-- mHelp woertlich (Cfile:1359123-1359128): "SimCallback(callback[,bool]):
-- Execute a lua function in sim. callback = { Func = function name (in the
-- SimCallbacks.lua module) to call, Args = Arguments as a lua object }. If
-- bool is specified and true, sends the current selection with the command."
--
-- The way in the original (cfunc_SimCallbackL, Cfile:1359139-1359305): Become Args
-- IMMEDIATELY serialized (SCR_ToByteStream — a snapshot, not a reference;
-- Functions in it are a hard bug, CMarshaller Cfile:999128), the
-- Selection is included as an entity ID set. The Sim page (Moho::Sim::LuaSimCallback,
-- Cfile:1076180-1076287) builds unit objects (empty set -> nil) and calls
-- import('/lua/SimCallbacks.lua').DoCallback(name, args, units).
__uiSimCallbackSink = false

-- The serialization snapshot (SCR_ToByteStream): the args become one
-- LUA-KONSTRUKTOR-Literal serialisiert (string.format('%q') escaped
-- Lua-safe) that the Sim VM evaluates upon receipt — one copy, none
-- Reference. Functions/user data pop like in the original ("Unable to marshal
-- lua function", CMarshaller Cfile:999128).
local function marshalArgs(v, depth)
  local t = type(v)
  if t == 'number' then return string.format('%.9g', v) end
  if t == 'string' then return string.format('%q', v) end
  if t == 'boolean' then return tostring(v) end
  if t == 'nil' then return 'nil' end
  if t == 'table' then
    if (depth or 0) > 16 then error('Unable to marshal: table too deep', 0) end
    local parts, i = {}, 0
    for k, val in pairs(v) do
      local kt = type(k)
      local key
      if kt == 'string' then
        key = string.format('%q', k)
      elseif kt == 'number' then
        key = string.format('%.9g', k)
      elseif kt == 'boolean' then
        key = tostring(k)
      else
        error('Unable to marshal lua ' .. kt .. ' key', 0)
      end
      i = i + 1
      parts[i] = '[' .. key .. ']=' .. marshalArgs(val, (depth or 0) + 1)
    end
    return '{' .. table.concat(parts, ',') .. '}'
  end
  error('Unable to marshal lua ' .. t, 0)
end

function SimCallback(callback, addSelection)
  if type(callback) ~= 'table' or type(callback.Func) ~= 'string' then
    -- Cfile:1359229-1359231: Func must be a string.
    error('SimCallback: callback.Func must be a string', 2)
  end
  if not __uiSimCallbackSink then
    error('SimCallback "' .. callback.Func .. '" hat keinen Weg in die Sim (__uiSimCallbackSink fehlt)', 2)
  end
  local ids = {}
  if addSelection == true then ids = idsOf(GetSelectedUnits()) end
  __uiSimCallbackSink(callback.Func, marshalArgs(callback.Args), ids)
end

-- === Commands with a blueprint as a target ===
--
-- IssueBlueprintCommand(command, blueprintId, count, clear) — construction.lua:884
-- This sends a unit into the queue of the selected factory
-- ("UNITCOMMAND_BuildFactory"), or an upgrade to a building
-- ("UNITCOMMAND_Upgrade", construction.lua:876). There is a POSITION here
-- not - what needs to be placed runs via command mode.
--
-- The UI doesn't execute the command, it sends it: sendSim -> Engine -> Sim.
function IssueBlueprintCommand(command, blueprintId, count, clear)
  local sel = GetSelectedUnits()
  if not sel then return end
  sendSim(command, sel, { blueprint = blueprintId, count = count or 1, clear = clear == true })
end

-- === The armies of the session ===
--
-- "armyInfo GetArmiesTable()" (scr_UserInits). The UI reads from this:
--   .armiesTable List of armies (nickname, faction, color, iconColor, human …)
--   .focusArmy which army the player sees (1-based)
--   .numArmies
--
-- Nutzer: avatars.lua:30, chat.lua:1027, score.lua:193, createunit.lua:320,
-- worldview.lua:318 (`GetArmiesTable().focusArmy - 1` — who are the ping owners
-- 0-based, the table 1-based).
--
-- The armies come from the SESSION (scenario + lobby), not from the UI. Until it
-- If there is a real session, the engine page enters it here (__uiSetArmies);
-- without a session the list is EMPTY — that's the truth, not a dummy.
--
-- Which fields there are for each army is NOT up for debate - the engine sets
-- sie in cfunc_GetArmiesTableL (Cfile:1267023-1267111) einzeln:
--   name, nickname, faction, color, iconColor, showScore, civilian, human,
--   outOfGame, authorizedCommandSources
-- and above numArmies + focusArmy (1-based; -1 remains -1).
--
-- IMPORTANT: `faction` is 0-BASED (mVarDat.mFaction). The Lua calculates everywhere
-- `faction + 1` to index in /lua/factions.lua (gamemain.lua:109,
-- orders.lua:675, avatars.lua:664). Whoever enters 1..4 here gives every player
-- the wrong faction — silent.
__uiArmies = {}
__uiFocusArmy = 1

function __uiSetArmies(armies, focusArmy)
  __uiArmies = armies or {}
  __uiFocusArmy = focusArmy or 1
end

-- === Alliances (UI mirror) ===
-- The sim's per-army sets (ArmyVariableData: allies/enemies/neutrals,
-- Cfile:772178/790221) reach the UI VM via serialization
-- (SSTIArmyVariableData, Cfile:551270); here the session fill writes the
-- same state. Every army is ally of itself (ctor, Cfile:1017297).
__uiAlliances = {}

local function __uiAllianceRow(a)
  local row = __uiAlliances[a]
  if not row then
    row = { allies = { [a] = true }, enemies = {}, neutrals = {} }
    __uiAlliances[a] = row
  end
  return row
end

--- Resolve an army argument like user ARMY_FromLuaState
--- (Cfile:1358407-1358490): 1-based index or case-insensitive name.
local function __uiResolveArmy(x)
  if type(x) == 'number' then
    if x <= 0 then error(string.format('Invalid army %d. (Use a 1-based index)', x)) end
    if not __uiArmies[x] then error(string.format('Invalid army %d', x)) end
    return x
  end
  if type(x) == 'string' then
    local lx = string.lower(x)
    for i, a in pairs(__uiArmies) do
      if a.name and string.lower(a.name) == lx then return i end
    end
    error('Unknown army: ' .. x)
  end
  error('Unexpected type for army object')
end

function __uiSetAlliance(a, b, state)
  for _, pair in pairs({ { a, b }, { b, a } }) do
    local row = __uiAllianceRow(pair[1])
    row.allies[pair[2]] = nil
    row.enemies[pair[2]] = nil
    row.neutrals[pair[2]] = nil
    if state == 'Ally' then row.allies[pair[2]] = true
    elseif state == 'Enemy' then row.enemies[pair[2]] = true
    else row.neutrals[pair[2]] = true end
  end
end

--- IsAlly/IsEnemy/IsNeutral (scr_UserInits, Cfile:1361954-1362085):
--- without a session the engine returns no value (Cfile:1361983).
function IsAlly(a, b)
  if table.getn(__uiArmies) == 0 then return end
  return __uiAllianceRow(__uiResolveArmy(a)).allies[__uiResolveArmy(b)] == true
end

function IsEnemy(a, b)
  if table.getn(__uiArmies) == 0 then return end
  return __uiAllianceRow(__uiResolveArmy(a)).enemies[__uiResolveArmy(b)] == true
end

function IsNeutral(a, b)
  if table.getn(__uiArmies) == 0 then return end
  return __uiAllianceRow(__uiResolveArmy(a)).neutrals[__uiResolveArmy(b)] == true
end

function GetArmiesTable()
  return {
    armiesTable = __uiArmies,
    focusArmy = __uiFocusArmy,
    numArmies = table.getn(__uiArmies),
  }
end

function GetFocusArmy()
  return __uiFocusArmy
end

function SetFocusArmy(index)
  __uiFocusArmy = index
end

-- === The current session ===
--
-- mHelp woertlich:
--   SessionGetScenarioInfo() "Return the table of scenario info that was
--                              originally passed to the sim on launch."
--   SessionRequestPause() "Pause the world simulation."
--   SessionResume() "Resume the world simulation."
--   SessionIsPaused()         "Return true iff the session is paused."
--   SessionGetLocalCommandSource()  "Return the local command source. Returns 0
--                                    if the local client can't issue commands."
--
-- The scenario info is EXACTLY the table that went to the sim at startup
-- (ScenarioInfo from <map>_scenario.lua) — the engine returns it unchanged
-- back. diplomacy.lua:34 accesses `.Options.TeamLock` unchecked, so
-- it has to be there as soon as a session is running. Without session: nil - the truth.
__uiScenarioInfo = false
__uiSessionPaused = false
__uiPauseSink = false
__uiCommandSources = {}
__uiLocalCommandSource = 0

--- Set up a SESSION (which CWldSession does at startup).
---
--- Accessed from the engine page with the same information as the sim
--- gets (src/sim/session.ts) — the UI doesn't invent ANYTHING here, it mirrors it
--- session. Without a session everything remains empty and the session globals pop
--- exactly as in the original ("no active session.", Cfile:1330339).
function __uiSessionBegin(sessionType, mapPath, mapName)
  __uiArmies = {}
  __uiFocusArmy = 1
  __uiCommandSources = {}
  __uiLocalCommandSource = 0
  __uiSessionPaused = false
  __uiScenarioInfo = {
    type = sessionType or 'skirmish',
    map = mapPath or '',
    name = mapName or '',
    Options = {},
    ArmySetup = {},
  }
end

--- Enlist an army. `faction` is 1..4 (as in the Sim's ArmySetup); the
--- armiesTable carries them 0-based because that's what the engine does.
--- The color comes from /lua/GameColors.lua (PlayerColors/ArmyColors) — the
--- Table of the game, not from the air.
function __uiSessionAddArmy(index, name, nickname, faction, human)
  local colors = import('/lua/GameColors.lua').GameColors
  __uiArmies[index] = {
    name = name,
    nickname = nickname or name,
    faction = faction - 1,
    color = colors.PlayerColors[index] or colors.UnidentifiedColor,
    iconColor = colors.ArmyColors[index] or colors.UnidentifiedColor,
    showScore = true,
    civilian = false,
    human = human == true,
    outOfGame = false,
    authorizedCommandSources = { 1 },
  }
  __uiScenarioInfo.ArmySetup[name] = {
    ArmyIndex = index,
    ArmyName = name,
    Human = human == true,
    Civilian = false,
    Faction = faction,
    AIPersonality = '',
  }
end

--- The command sources (the clients). In single player, exactly one - the player.
--- The engine provides the local index 1-based, 0 if the client does not
--- befehligen darf (Cfile:1330618: `mLocalCmdSrc + 1`, 255 -> 0).
function __uiSessionSetCommandSources(name, localIndex)
  __uiCommandSources = { name }
  __uiLocalCommandSource = localIndex or 0
end

--- Which army the player sees (1-based; -1 = observer).
function __uiSessionSetFocusArmy(index)
  __uiFocusArmy = index or 1
end

function __uiSessionSetOption(key, value)
  if __uiScenarioInfo then __uiScenarioInfo.Options[key] = value end
end

function SessionGetScenarioInfo()
  return __uiScenarioInfo or nil
end

function SessionIsPaused()
  return __uiSessionPaused == true
end

-- Pause is an intervention in the SIM, not in the UI: the engine holds it
-- WORLD (CWldSession::RequestPause). Without a session the engine throws
-- "SessionRequestPause(): no active session." - here too, instead of still nothing
-- zu tun.
function SessionRequestPause()
  if not __uiScenarioInfo then error('SessionRequestPause(): no active session.', 2) end
  if not __uiPauseSink then
    error('SessionRequestPause: kein Weg in die Sim (__uiPauseSink fehlt)', 2)
  end
  __uiSessionPaused = true
  __uiPauseSink(true)
end

function SessionResume()
  if not __uiScenarioInfo then error('SessionResume(): no active session.', 2) end
  if not __uiPauseSink then
    error('SessionResume: kein Weg in die Sim (__uiPauseSink fehlt)', 2)
  end
  __uiSessionPaused = false
  __uiPauseSink(false)
end

--- "Return a table of command sources." (mHelp). Without session: error.
function SessionGetCommandSourceNames()
  if not __uiScenarioInfo then error('SessionGetCommandSourceNames(): no active session.', 2) end
  return __uiCommandSources
end

--- "Return the local command source. Returns 0 if the local client can't issue
--- commands." — 1-based, NOT the army.
function SessionGetLocalCommandSource()
  if not __uiScenarioInfo then error('SessionGetLocalCommandSource(): no active session.', 2) end
  return __uiLocalCommandSource
end

function SessionIsActive()
  return __uiScenarioInfo ~= false
end

-- === Restart the session ===
--
-- cfunc_RestartSessionL (Cfile:1263968-1263985): ONLY if a session is running
-- AND it is restartable (the same flag provides SessionCanRestart,
-- Cfile:1330810-1330826), the frame action is set to CREATE_SESSION —
-- the main loop then runs teardown + restart with the UNCHANGED ones
-- Session info (func_DoPreload, Cfile:1320748-1320784). Otherwise: No-Op, NONE
-- Mistake. The engine page hangs here as __uiRestartSink; without
-- The session simply cannot be restarted (mCanRestart = false).
__uiRestartSink = false

function SessionCanRestart()
  return __uiScenarioInfo ~= false and __uiRestartSink ~= false
end

function RestartSession()
  if not SessionCanRestart() then return end
  __uiRestartSink()
end

-- === The clients of the session ===
--
-- Fields per client from cfunc_GetSessionClientsL (Cfile:1321886-1321957):
-- name, uid, connected, ping, quiet, local, authorizedCommandSources,
-- ejectedBy. In single player there is exactly one client - the player
-- (same source as SessionGetCommandSourceNames).
function GetSessionClients()
  if not __uiScenarioInfo then error('GetSessionClients(): no active session.', 2) end
  local clients = {}
  for i, name in ipairs(__uiCommandSources) do
    clients[i] = {
      name = name,
      uid = i,
      connected = true,
      ping = 0,
      quiet = 0,
      ['local'] = (i == __uiLocalCommandSource),
      authorizedCommandSources = { i },
      ejectedBy = {},
    }
  end
  return clients
end

-- === Chat ===
--
-- "SessionSendChatMessage([client-or-clients,] message)" (mHelp,
-- Cfile:1322062). The path in the original (cfunc, Cfile:1322106-1322227):
--   * 1 argument: all clients; (int, msg): A client index (1-based,
--     validated); (table, msg): Set of indexes — indexes in the
--     GetSessionClients-Liste.
--   * msg will be serialized IMMEDIATELY (Snapshot! chat.lua:759 sets msg.echo
--     only AFTER sending - the delivered copy remains untouched);
--     > 1024 Bytes serialisiert -> "Message too long." (Cfile:1322198-1322204).
--   * Zustellung ASYNCHRON (THREAD_InvokeAsync, Cfile:1320454): beim
--     naechsten Frame ruft func_ReceiveChat (Cfile:1263605-1263646)
--     gamemain.ReceiveChat(senderName, msgTable) — the sender is present,
--     if it is in the receiver mask (loopback).
-- Chat runs on the NETWORK LAYER (client manager), not via Sim/Sync —
-- In single player this means: completely in this VM.
function SessionSendChatMessage(clientsOrMsg, msg)
  if not __uiScenarioInfo then error('GameSendChatMessage(): No active game.', 2) end
  local targets, message
  if msg == nil then
    message = clientsOrMsg
    targets = false -- all
  else
    message = msg
    targets = clientsOrMsg
  end
  if type(message) ~= 'table' then error("Can't encode message.", 2) end

  -- The serialization snapshot (SCR_ToByteStream): a deep copy NOW,
  -- with byte counting as an approximation of the ByteStream size for the
  -- 1024 limit (Cfile:1322198-1322204). Functions/Userdata pop as in
  -- Original ("Can't encode message.").
  local function snapshot(v, bytes, depth)
    local t = type(v)
    if t == 'number' then return v, bytes + 8 end
    if t == 'string' then return v, bytes + string.len(v) + 4 end
    if t == 'boolean' or t == 'nil' then return v, bytes + 1 end
    if t == 'table' then
      if depth > 16 then error("Can't encode message.", 0) end
      local out = {}
      bytes = bytes + 8
      for k, val in pairs(v) do
        local kc, vc
        kc, bytes = snapshot(k, bytes, depth + 1)
        vc, bytes = snapshot(val, bytes, depth + 1)
        out[kc] = vc
      end
      return out, bytes
    end
    error("Can't encode message.", 0)
  end
  local ok, copy, size = pcall(snapshot, message, 0, 0)
  if not ok then error("Can't encode message.", 2) end
  if size > 1024 then error('Message too long.', 2) end

  local n = table.getn(__uiCommandSources)
  local localIncluded = false
  if targets == false then
    localIncluded = true -- Mask (1 << N) - 1: all, including the transmitter
  elseif type(targets) == 'number' then
    if targets < 1 or targets > n then
      error('Invalid client index ' .. tostring(targets), 2)
    end
    localIncluded = (targets == __uiLocalCommandSource)
  elseif type(targets) == 'table' then
    for _, idx in ipairs(targets) do
      if type(idx) ~= 'number' then
        error('Invalid value for client-or-clients argument', 2)
      end
      if idx < 1 or idx > n then
        error('Invalid client index ' .. tostring(idx), 2)
      end
      if idx == __uiLocalCommandSource then localIncluded = true end
    end
  else
    error('Invalid value for client-or-clients argument', 2)
  end

  if localIncluded then
    -- Deliver the copy from the snapshot — NOT the original table.
    local nick = __uiCommandSources[__uiLocalCommandSource] or 'Player'
    ForkThread(function()
      WaitFrames(1)
      import('/lua/ui/game/gamemain.lua').ReceiveChat(nick, copy)
    end)
  end
end

-- === The WldUIProvider — the seam between world loading and UI ===
--
-- InternalCreateWldUIProvider(self) (cfunc, Cfile:28934) builds the
-- CLuaWldUIProvider around the Lua object and registers it as the provider
-- (Moho::WLD_SetUIProvider, Cfile:29710). The engine then calls its
-- Methoden per RunScript (Cfile:1295316-1295350): StartLoadingDialog beim
-- Weltstart (func_DoPreload, Cfile:1320770), UpdateLoadingDialog(elapsed)
-- per image while loading, StopLoadingDialog after the FIRST beat with
-- Sync data (DoInitializing, Cfile:1321067) — and only AFTER
-- CreateGameInterface (= gamemain.CreateUI). gamemain.lua:225 haengt an
-- exactly this hook the loading dialog and the InitialAnimations.
__uiWldProvider = false

function InternalCreateWldUIProvider(luaobj)
  __uiWldProvider = luaobj
end

-- "FlushEvents() -- flush mouse/keyboard events" (Cfile:1274567): flushes the
-- UI Manager input queue (sub_84DA80). gamemain.lua:297 is what it calls at the end
-- of StopLoadingDialog, so that clicks buffered during loading are not saved
-- break through fresh game. Our events run SYNCHRONOUSLY (__mauiMouse
-- processed immediately, there is no queue) — an empty queue is emptied.
function FlushEvents() end

--- "Return true if the active session is a replay session." — we play live.
function SessionIsReplay()
  return false
end

function SessionIsMultiplayer()
  return table.getn(__uiCommandSources) > 1
end

-- === Konsolen-Ausgabe ===
--
-- "handler AddConsoleOutputReciever(func(text))" / "RemoveConsoleOutputReciever(handler)"
-- (Mispelling in the original: “Reciever”). consoleecho.lua:35 depends on this
-- to the console output to display in-game.
__uiConsoleReceivers = {}

function AddConsoleOutputReciever(func)
  table.insert(__uiConsoleReceivers, func)
  return func -- the handle is the function itself
end

function RemoveConsoleOutputReciever(handler)
  for i = table.getn(__uiConsoleReceivers), 1, -1 do
    if __uiConsoleReceivers[i] == handler then
      table.remove(__uiConsoleReceivers, i)
    end
  end
end

--- A console line to all recipients (the engine calls this with every output).
function __uiConsoleOutput(text)
  for _, func in ipairs(__uiConsoleReceivers) do
    pcall(func, text)
  end
end

-- === Commands to the current selection ===
--
-- mHelp woertlich:
--   IssueCommand(command, [string], [clear])                 Cfile: luadef_IssueCommand
--   IssueUnitCommand(unitList, command, [string], [clear])
--   IssueDockCommand(clear)
--
-- The second argument is NOT always a string: construction.lua:980 passes
-- a TABLE (orderData with TaskName/Enhancement) for an ACU upgrade. The
-- Engine passes it on to the sim unchanged - so we do that too, instead
-- to bend them into a string.
-- "string GetUnitCommandFromCommandCap(string) - given a RULEUCC type command"
-- (mHelp, Cfile:1264832). The path in the original (cfunc, Cfile:1264844-1264889):
-- Parse input via REnumType::SetLexical (case-insensitive, prefix optional,
-- Cfile:1381888-1381946), then Moho::UnitCommandCapToCommandType
-- (Cfile:1242230-1242328), returned via GetLexical and EUnitCommandType
-- stores its names WITHOUT the "UNITCOMMAND_" prefix (mPrefix,
-- Cfile:696168-696248; Proof: UICommandGraph::LoadPathParams sets the
-- Praefix per STR_Printf("%s%s", ...) selbst davor, Cfile:1244372-1244378).
-- The stop button (orders.lua:205) puts the result directly into IssueCommand —
-- There, SetLexical parses the prefix-less name in the same way.
local CAP_TO_COMMAND = {
  -- The FULL mapping from func_UnitCommandCapToCommandType
  -- (Cfile:1242230-1242328); unmapped caps return 'None'.
  move = 'Move', stop = 'Stop', attack = 'Attack', guard = 'Guard',
  patrol = 'Patrol', retaliatetoggle = 'None', repair = 'Repair',
  capture = 'Capture', transport = 'TransportUnloadUnits',
  calltransport = 'TransportLoadUnits', nuke = 'Nuke', tactical = 'Tactical',
  teleport = 'Teleport', ferry = 'Ferry', silobuildtactical = 'BuildSiloTactical',
  silobuildnuke = 'BuildSiloNuke', sacrifice = 'Sacrifice', pause = 'Pause',
  overcharge = 'OverCharge', dive = 'Dive', reclaim = 'Reclaim',
  specialaction = 'SpecialAction', dock = 'None', script = 'None',
  invalid = 'None',
}

function GetUnitCommandFromCommandCap(cap)
  if type(cap) ~= 'string' then
    error('GetUnitCommandFromCommandCap: string erwartet', 2)
  end
  local key = string.gsub(string.lower(cap), '^ruleucc_', '')
  local cmd = CAP_TO_COMMAND[key]
  if not cmd then
    -- SetLexical throws for unknown enum names (Cfile:1381940-1381946).
    error('GetUnitCommandFromCommandCap: unbekannter Command-Cap "' .. cap .. '"', 2)
  end
  return cmd
end

function IssueCommand(command, data, clear)
  local sel = GetSelectedUnits()
  if not sel then return end
  sendSim(command, sel, { data = data, clear = clear == true })
end

function IssueUnitCommand(unitList, command, data, clear)
  sendSim(command, unitList or {}, { data = data, clear = clear == true })
end

-- "IssueDockCommand(clear)" — dock the selection (carrier/transport).
function IssueDockCommand(clear)
  local sel = GetSelectedUnits()
  if not sel then return end
  sendSim('UNITCOMMAND_Dock', sel, { clear = clear == true })
end

-- === Construction templates ===
--
-- The engine keeps ONE active template (a list of blueprint + offset) that
-- sets the world view as a group with the next click. construction.lua:946
-- sets it, commandmode.lua:120 clears it away when canceling.
__uiBuildTemplate = false

function SetActiveBuildTemplate(template)
  __uiBuildTemplate = template or false
end

function GetActiveBuildTemplate()
  return __uiBuildTemplate or nil
end

function ClearBuildTemplates()
  __uiBuildTemplate = false
end

-- === Command feedback in the world ===
--
-- AddCommandFeedbackBlip(spec, duration): the engine sets a short-lived mesh
-- to the target position (commandmode.lua:133-176 — flag, crosshairs, construction flag).
-- Drawing is renderer work; The order is carried out here so that the
-- Renderer can pick it up. Nothing is invented: position, mesh and texture
-- come from the Lua.
__uiBlips = {}
-- Push sink to the renderer (flat args — wasmoon-friendly); false until
-- the browser connects, then the queue path below stays for headless runs.
__uiBlipSink = false

function AddCommandFeedbackBlip(spec, duration)
  if __uiBlipSink then
    local p = spec.Position or {}
    __uiBlipSink(
      spec.MeshName or '',
      spec.BlueprintID or '',
      spec.TextureName or '',
      spec.ShaderName or 'CommandFeedback',
      spec.UniformScale or 1,
      p[1] or 0, p[2] or 0, p[3] or 0,
      duration or 0.7)
  else
    __uiBlips[table.getn(__uiBlips) + 1] = { spec = spec, duration = duration }
  end
end

-- The renderer fetches the accumulated blips (and empties the list).
function __uiTakeBlips()
  local out = __uiBlips
  __uiBlips = {}
  return out
end

-- === Klang ===
--
-- PlaySound(sound) takes exactly the Sound{} object from the blueprint
-- (bp.Audio.UISelection, selection.lua:5) — Bank + Cue. The output itself is
-- a separate engine part (FMOD banks in sounds.scd), which does not yet exist.
--
-- Therefore: the requested cues are LOGGED and the absence of them
-- Output is reported loudly ONCE. Nothing is invented, nothing becomes
-- secretive - and a test can check that the right cue came.
-- The signatures come from the Decomp mHelp strings:
--
--   handle = PlaySound(sndParams, prepareOnly)   Cfile:1348030
--   StartSound(handle)                           Cfile:1348174
--   StopSound(handle, [immediate=false])         Cfile:1348237
--   bool = SoundIsPrepared(handle)               Cfile:1348102
--   PauseSound(categoryString, bPause)           Cfile:1347882  <- KATEGORIE,
--   PlayVoice(params, duck) Cfile:1348652 no handle
--
-- The HANDLE is the point: main.lua:231-249 starts the menu music and stops
-- them via this exact handle (`StopSound(musicHandle)` in StopMusic and
-- OnDestroy). Without a return value, StopSound would have nothing to stop - the music
-- the menu would continue forever as soon as there was an output.
__uiAudioSink = false
-- Stop seam: StopSound reports the handle ID so that the output is ongoing
-- Sources (music, loops) actually stop - not just set the flag.
__uiAudioStopSink = false
__uiNextSoundId = 1
__uiSoundsRequested = {}
local warnedNoAudio = false

-- EnableWorldSounds()/DisableWorldSounds() (Cfile:1348520-1348545, 0 Argumente):
-- the switch for the WORLD sounds (weapons, units — not the UI cues).
-- gamemain.OnFirstUpdate() switches it on when the game starts (gamemain.lua:78),
-- Turn splash/NIS off. Real condition; the audio output reads it,
-- as soon as they exist.
__uiWorldSounds = false

function EnableWorldSounds()
  __uiWorldSounds = true
end

function DisableWorldSounds()
  __uiWorldSounds = false
end

local function newHandle(params, kind)
  local h = {
    Bank = params.Bank,
    Cue = params.Cue,
    kind = kind,
    id = __uiNextSoundId,
    -- A handle is "prepared" as soon as the bank has loaded the cue. We load
    -- nothing — so that's it immediately. movie.lua:37-49 is waiting for it; an eternal one
    -- false would block the splash movie.
    prepared = true,
    playing = false,
    stopped = false,
  }
  __uiNextSoundId = __uiNextSoundId + 1
  __uiSoundsRequested[table.getn(__uiSoundsRequested) + 1] = h
  return h
end

function StartSound(handle)
  if not handle then return end
  handle.playing = true
  handle.stopped = false
  if __uiAudioSink then
    __uiAudioSink(handle.Bank, handle.Cue, handle.id)
  elseif not warnedNoAudio then
    warnedNoAudio = true
    WARN('Audio: keine Ausgabe angeschlossen — Cues werden nur protokolliert (__uiSoundsRequested)')
  end
end

function PlaySound(sound, prepareOnly)
  if not sound then return end
  local h = newHandle(sound, 'sound')
  if not prepareOnly then StartSound(h) end
  return h
end

function PlayVoice(params, duck)
  if not params then return end
  local h = newHandle(params, 'voice')
  h.duck = duck
  StartSound(h)
  return h
end

function SoundIsPrepared(handle)
  return handle ~= nil and handle.prepared == true
end

function StopSound(handle, immediate)
  if not handle then return end
  handle.playing = false
  handle.stopped = true
  handle.immediate = immediate == true
  if __uiAudioStopSink then __uiAudioStopSink(handle.id) end
end

function StopAllSounds()
  for _, h in ipairs(__uiSoundsRequested) do
    h.playing = false
    h.stopped = true
  end
end

-- PauseSound/PauseVoice work on CATEGORIES (“music”, “voice”, …), not on
-- Handles — therefore a separate state.
__uiSoundCategoriesPaused = {}
function PauseSound(category, bPause)
  __uiSoundCategoriesPaused[category] = bPause == true
end
function PauseVoice(category, bPause)
  PauseSound(category, bPause)
end

-- === Lautstaerken ===
--
--   float GetVolume(category)      Cfile:1348388
--   SetVolume(category, volume)    Cfile:1348320
--   SetMovieVolume(volume): 0.0 - 2.0   Cfile:1302838
--   GetMovieVolume()                    Cfile:1302900
--
-- The categories are in the original Lua: options.lua:700/729/735/745 sets
-- "Global", "World", "Interface" and "Music". The range of values ​​is 0..1 — the
-- Option is a controller 0..100 and divides itself by 100 (options.lua:710).
--
-- The starting value is 1.0 because that is exactly what the option specifies (default = 100,
-- options.lua:697) and `set` calls SetVolume(value/100) at startup. There is none
-- invented number, but the one that the original Lua itself a line later
-- sets. There is no output yet (M12) — the status is only maintained.
__uiVolumes = { Global = 1.0, World = 1.0, Interface = 1.0, Music = 1.0 }
__uiMovieVolume = 1.0

function SetVolume(category, volume)
  __uiVolumes[category] = volume
end

function GetVolume(category)
  local v = __uiVolumes[category]
  if v == nil then return 1.0 end
  return v
end

function SetMovieVolume(volume)
  __uiMovieVolume = volume
end

function GetMovieVolume()
  return __uiMovieVolume
end

-- === Construction queue of the displayed factory ===
--
-- cfunc_SetCurrentFactoryForQueueDisplayL (Cfile:1257038-1257087) remembers the
-- Unit as WeakPtr (sCurrentBuildFactory) and returns the queue.
-- construction.lua:1764 depends on exactly this: `currentCommandQueue = SetCurrent...`,
-- and the engine calls construction.OnQueueChanged(newQueue) with every change.
--
-- The entries are { id = <blueprintId>, count = <n> } (construction.lua:1620).
__uiQueueFactory = false
-- The copy of the last reported queue (engine's sCurrentBuildQueue) —
-- the Beat Watcher compares against this.
__uiQueueCopy = {}

function SetCurrentFactoryForQueueDisplay(unit)
  __uiQueueFactory = unit or false
  if not unit then return {} end
  local q = unit:GetBuildQueue()
  -- The engine IMMEDIATELY copies the queue to sCurrentBuildQueue (Cfile:1257076,
  -- sub_837070) — otherwise the next beat reported a ghost update for them
  -- Ad that construction.lua just built himself.
  __uiQueueCopy = q
  return q
end

function ClearCurrentFactoryForQueueDisplay()
  __uiQueueFactory = false
end

-- === The queue guard (Moho::UI_FactoryCommandQueueHandlerBeat) ===
--
-- CUIManager::DoBeat calls it per sim beat BEFORE UI_LuaBeat
-- (Cfile:1273907-1273911). It compares the queue of those displayed
-- Factory STRUCTURAL (id + count per entry) with the copy and calls
-- Aenderung gamemain.OnQueueChanged(neueQueue) (Cfile:1256936-1256950).
-- If NO factory is displayed anymore, but the copy is still filled, fires
-- exactly once OnQueueChanged(nil) (Cfile:1256928-1256932).
-- The comparison must be structural: the mirror replaces the table every
-- Beat - a reference comparison reported a change ten times per second.
local function queueEqual(a, b)
  if #a ~= #b then return false end
  for i = 1, #a do
    if a[i].id ~= b[i].id or a[i].count ~= b[i].count then return false end
  end
  return true
end

function __uiFactoryQueueBeat()
  local f = __uiQueueFactory
  if f and not f.dead then
    local q = f:GetBuildQueue()
    if not queueEqual(q, __uiQueueCopy) then
      __uiQueueCopy = q
      import('/lua/ui/game/gamemain.lua').OnQueueChanged(q)
    end
  elseif __uiQueueCopy[1] ~= nil then
    __uiQueueCopy = {}
    import('/lua/ui/game/gamemain.lua').OnQueueChanged(nil)
  end
end

-- "IncreaseBuildCountInQueue(queueIndex, count)" (cfunc,
-- Cfile:1257189-1257270) and "DecreaseBuildCountInQueue(queueIndex, count)"
-- (Cfile:1257301-1257380): affect the CURRENTLY displayed queue
-- (sCurrentBuildQueue[index-1], 1-based from Lua), only on
-- UNITCOMMAND_BuildFactory entries (Cfile:1257258-1257263), and range
-- the sim driver (ISSUE_IncreaseCommandCount Cfile:1257266 or
-- DecreaseCommandCount Cfile:1257378). construction.lua:895/988-990 haengt
-- Right click (less) and left click (more) on it.
--
-- Known gap (documented, no guessing): the original canceled via
-- the command system also supports the STRAIGHT RUNNING construction; our sim has it
-- Current entry is already decremented when it is set up - a Decrease occurs
-- Position 1 does not abort the active construction (yet).
local function adjustQueueCount(name, queueIndex, count)
  local f = __uiQueueFactory
  if not f or f.dead then return end
  __uiSimCommand(name, { f.id }, { index = queueIndex, count = count or 1 })
end

function IncreaseBuildCountInQueue(queueIndex, count)
  adjustQueueCount('ISSUE_IncreaseCommandCount', queueIndex, count)
end

function DecreaseBuildCountInQueue(queueIndex, count)
  adjustQueueCount('ISSUE_DecreaseCommandCount', queueIndex, count)
end

-- === Script bits (the toggles of a unit) ===
--
-- Shield on/off, weapon on/off, stealth, production... are listed as BITMASK on the
-- Unit (mUnitVarDat.mScriptbits). cfunc_GetScriptBitL (Cfile:1360150ff) takes
-- a unit list and a BIT INDEX (argument 2 is a number), skips
-- Units that do not have the appropriate ToggleCap ((1 << bit) & mToggleCaps), and
-- provides the status.
--
-- The bit order is the registration order of the RULEUTC enums
-- (Cfile:656794-656810):
--   0 ShieldToggle  1 WeaponToggle  2 JammingToggle  3 IntelToggle
--   4 ProductionToggle  5 StealthToggle  6 GenericToggle  7 SpecialToggle
--   8 CloakToggle
local TOGGLE_CAPS = {
  [0] = 'RULEUTC_ShieldToggle',
  [1] = 'RULEUTC_WeaponToggle',
  [2] = 'RULEUTC_JammingToggle',
  [3] = 'RULEUTC_IntelToggle',
  [4] = 'RULEUTC_ProductionToggle',
  [5] = 'RULEUTC_StealthToggle',
  [6] = 'RULEUTC_GenericToggle',
  [7] = 'RULEUTC_SpecialToggle',
  [8] = 'RULEUTC_CloakToggle',
}

local function hasToggleCap(u, bit)
  local cap = TOGGLE_CAPS[bit]
  if not cap then return false end
  local bp = u:GetBlueprint()
  local caps = bp and bp.General and bp.General.ToggleCaps
  return caps ~= nil and caps[cap] == true
end

local function bitSet(bits, bit)
  return math.floor((bits or 0) / (2 ^ bit)) % 2 == 1
end

function GetScriptBit(units, bit)
  for _, u in ipairs(units or {}) do
    if not u:IsDead() and hasToggleCap(u, bit) then
      if bitSet(u.scriptBits or 0, bit) then return true end
    end
  end
  return false
end

-- ToggleScriptBit(units, bit, value) — the UI sends the request to the Sim
-- (there it calls Unit:OnScriptBitSet/OnScriptBitClear, unit.lua:309/353).
function ToggleScriptBit(units, bit, value)
  local on = value == true
  for _, u in ipairs(units or {}) do
    if hasToggleCap(u, bit) then
      local bits = u.scriptBits or 0
      if on ~= bitSet(bits, bit) then
        u.scriptBits = on and (bits + 2 ^ bit) or (bits - 2 ^ bit)
      end
    end
  end
  sendSim('ToggleScriptBit', units, { bit = bit, value = on })
end

-- === Pause (Stop production of a factory/farmer) ===
--
-- cfunc_GetIsPausedL (Cfile:1359337ff, Hilfetext: "Is anyone ins this list
-- builder paused?"): true as soon as ONE living unit in the list has mIsPaused.
-- cfunc_SetPausedL sends the request to the sim — the UI doesn't set anything itself.
function GetIsPaused(units)
  for _, u in ipairs(units or {}) do
    if not u:IsDead() and u.paused == true then return true end
  end
  return false
end

function SetPaused(units, paused)
  for _, u in ipairs(units or {}) do
    if not u:IsDead() then u.paused = paused == true end
  end
  sendSim('SetPaused', units, paused == true)
end

-- === The UI VM clock ===
--
-- The UI VM does NOT have a tick scheduler. `userinit.lua:13-21` (the engine is loading
-- the file itself) defines:
--
--   WaitFrames = coroutine.yield
--   function WaitSeconds(n)
--       local later = CurrentTime() + n
--       WaitFrames(1)
--       while CurrentTime() < later do WaitFrames(1) end
--   end
--
-- So a UI thread waits for IMAGES, and `WaitSeconds` polls the real clock.
-- That's why the UI VM overwrites the tick-based WaitSeconds here
-- threads.lua (this only applies in the sim). __uiTime increments __mauiFrame(delta).
function CurrentTime()
  return __uiTime
end

function WaitFrames(n)
  coroutine.yield(n or 1)
end

function WaitSeconds(n)
  local later = CurrentTime() + (n or 0)
  WaitFrames(1)
  while CurrentTime() < later do
    WaitFrames(1)
  end
end

-- === Session extra select list ===
--
-- Moho::CWldSession holds a WeakSet<UserEntity> (Cfile:29945-29947) which is the
-- UI filled with three globals: AddToSessionExtraSelectList /
-- RemoveFromSessionExtraSelectList / ClearSessionExtraSelectList
-- (Cfile:1361771-1361788). construction.lua:924 puts the attached ones there
-- units that should also remain marked; the world view reads
-- the list while drawing.
__uiExtraSelect = {}

function AddToSessionExtraSelectList(unit)
  if unit then __uiExtraSelect[unit:GetEntityId()] = unit end
end

function RemoveFromSessionExtraSelectList(unit)
  if unit then __uiExtraSelect[unit:GetEntityId()] = nil end
end

function ClearSessionExtraSelectList()
  __uiExtraSelect = {}
end

-- === Feuerhaltung (Retaliate-Button) ===
--
-- cfunc_GetFireStateL (@0x8BB500, Cfile:1359840-1359898) — exactly this process:
--
--   state = 3 -- Sentinel "no one has seen it yet"
--   for every living unit WITH RULEUCC_RetaliateToggle (mCommandCaps & 0x20):
--     state == 3 -> state = fireState of the unit
--     state ~= fireState  -> state = -1   (gemischt)
--   state == 3 (no suitable unit) -> -1
--
-- The 0x20 is not a coincidence: the RULEUCC enums are in a fixed order
-- registered (Cfile:656671-656719), bit 5 is RULEUCC_RetaliateToggle.
--
-- The states are 0 = ReturnFire, 1 = HoldFire, 2 = HoldGround
-- (orders.lua:419-421); the Ctor starts with ReturnFire (Cfile:772277).
local RETALIATE_CAP = 'RULEUCC_RetaliateToggle'

local function canRetaliate(u)
  local bp = u:GetBlueprint()
  local caps = bp and bp.General and bp.General.CommandCaps
  return caps ~= nil and caps[RETALIATE_CAP] == true
end

function GetFireState(units)
  if type(units) ~= 'table' then return -1 end
  local state = 3
  for _, u in ipairs(units) do
    if not u:IsDead() and canRetaliate(u) then
      if state == 3 then
        state = u:GetFireState()
      elseif state ~= u:GetFireState() then
        state = -1
      end
    end
  end
  if state == 3 then return -1 end
  return state
end

-- SetFireState(units, id) — orders.lua:526 returns the STRING
-- retaliateStateInfo('ReturnFire'/'HoldFire'/'HoldGround'). The engine sends
-- it as ProcessInfo to the Sim (cfunc_SetFireStateL); there it is a command
-- to the unit. Until the command path to the SIM is established, the state will be in the
-- UI mirroring — the same place where the engine holds it.
local FIRE_STATE_ID = { ReturnFire = 0, HoldFire = 1, HoldGround = 2 }

function SetFireState(units, id)
  local state = FIRE_STATE_ID[id]
  if state == nil then error('SetFireState: unbekannter Zustand ' .. tostring(id), 2) end
  for _, u in ipairs(units or {}) do
    if canRetaliate(u) then u.fireState = state end
  end
  sendSim('SetFireState', units, state)
end

-- ToggleFireState(units, currentFireState) — cfunc_ToggleFireStateL: one
-- further in the round (orders.lua:588-593 passes the current status).
function ToggleFireState(units, current)
  local next = (tonumber(current) or -1) + 1
  if next > 2 or next < 0 then next = 0 end
  for _, u in ipairs(units or {}) do
    if canRetaliate(u) then u.fireState = next end
  end
  sendSim('SetFireState', units, next)
end

-- GetRolloverInfo(): the unit under the mouse pointer (unitview.lua reads from it
-- most values ​​as plain fields, not via UserUnit methods).
function GetRolloverInfo()
  return __uiRollover or nil
end

function __uiSetRollover(id)
  local u = id and __uiUnits[id]
  if not u then
    __uiRollover = false
    return
  end
  -- The organic fields come from the BLUEPRINT - the same source from which the
  -- Sim registers their production/maintenance (units.lua __econRegister). One
  -- Construction sites produce nothing (construction sites are invisible to the economy).
  local bp = __blueprints[u.blueprintId]
  local eco = (bp and bp.Economy) or {}
  local fertig = (u.workProgress or 1) >= 1
  __uiRollover = {
    userUnit = u,
    blueprintId = u.blueprintId,
    -- 0-BASED: unitview.lua:89-90 calculates `info.armyIndex + 1` for
    -- GetFocusArmy()/armiesTable — just like the engine does its army indexes
    -- 0-based to which rollover info is given.
    armyIndex = (u.army or 1) - 1,
    health = u.health,
    maxHealth = u.maxHealth,
    shieldRatio = u.shieldRatio or 0,
    fuelRatio = u.fuelRatio or -1,
    workProgress = u.workProgress or 0,
    kills = 0,
    customName = u.customName,
    massProduced = fertig and (eco.ProductionPerSecondMass or 0) or 0,
    massRequested = fertig and (eco.MaintenanceConsumptionPerSecondMass or 0) or 0,
    energyProduced = fertig and (eco.ProductionPerSecondEnergy or 0) or 0,
    energyRequested = fertig and (eco.MaintenanceConsumptionPerSecondEnergy or 0) or 0,
  }
end

-- === Overlays (WorldView view filter) ===
-- multifunction.lua:272 switches the map overlays. The WorldView
-- renders them; Until it exists, it is a pure state - but a real state,
-- no silence.
__uiOverlayFilters = {}
__uiTeamColorMode = 'FactionColor'

-- MapBorderAdd(blueprintid) (Cfile:1269840) / MapBorderClear(): the decorative one
-- Worldview MAP EDGE — WorldMesh blueprints from the skin
-- (uiutil.lua:142-158, UpdateWorldBorderState; the option is called
-- 'world_border'). Real condition; the 3D page renders the meshes as soon as they are
-- WorldMesh kann.
__uiMapBorders = {}

function MapBorderAdd(blueprintId)
  __uiMapBorders[table.getn(__uiMapBorders) + 1] = blueprintId
end

function MapBorderClear()
  __uiMapBorders = {}
end

function SetOverlayFilter(filter) __uiOverlayFilters = { filter } end
function SetOverlayFilters(filters) __uiOverlayFilters = filters or {} end
function SetOverlayFilterEnabled() end
function RenderOverlayEconomy(on) __uiOverlayFilters.economy = on == true end
function RenderOverlayIntel(on) __uiOverlayFilters.intel = on == true end
function RenderOverlayMilitary(on) __uiOverlayFilters.military = on == true end
function TeamColorMode(mode)
  if mode ~= nil then __uiTeamColorMode = mode end
  return __uiTeamColorMode
end

-- === Audio / Sprache ===
-- Localization.lua:43 asks whether there is voice output set to music for the language,
-- and then sets the audio language. There is no audio system yet - that
-- is being told honestly here instead of pretending.
__uiAudioLanguage = 'us'
function HasLocalizedVO(la) return false end
function AudioSetLanguage(la) __uiAudioLanguage = la end

-- === Console ===
-- ConExecute/ConExecuteSave are in console.lua — with a real one
-- ConVar table. 19 of the 37 options work exactly this way.

-- === Front-end: status, entries, data ===
--
-- There is exactly ONE UI VM for the entire application (Moho::USER_GetLuaState is
-- a singleton, Cfile:1368027). Splash, main menu, lobby and game UI are running
-- everyone in it - what changes is only the state:
--
--   UIS_none=0  UIS_splash=1  UIS_frontend=2  UIS_game=3  UIS_lobby=4
--                                              (Cfile:1262301-1262311)
__uiState = 0
local UI_STATE_NAMES = { [0] = 'none', [1] = 'splash', [2] = 'frontend', [3] = 'game', [4] = 'lobby' }

-- GetCurrentUIState (Cfile:1265924) — borders.lua:101 fragt danach.
function GetCurrentUIState()
  return UI_STATE_NAMES[__uiState]
end

-- CUIManager::SetNewLuaState: New frames, set state, then SetupUI()
-- the Original-uimain.lua (Cfile:1273680). SetupUI restarts with EVERY change
-- — the cursor is attached to it (uimain.lua:22-25).
function __uiSetNewLuaState(state)
  __mauiResetFrames()
  __uiState = state
  import('/lua/ui/uimain.lua').SetupUI()
end

-- The thin Lua wrappers around UI_StartSplashScreens (Cfile:1262357) and
-- UI_StartFrontEnd (Cfile:1262476). mHelp: "kill current UI and start ...".
function EngineStartSplashScreens()
  __uiSetNewLuaState(1)
  import('/lua/ui/uimain.lua').StartSplashScreen()
end

function EngineStartFrontEndUI()
  __uiSetNewLuaState(2)
  import('/lua/ui/uimain.lua').StartFrontEndUI()
end

-- FrontEndData puts the engine itself in the UI globals (Cfile:1268751/1268831):
-- Campaign briefing, replay file name, selected map. Get/Set are only
-- Tabellenzugriffe.
FrontEndData = {}
function GetFrontEndData(key) return FrontEndData[key] end
function SetFrontEndData(key, value) FrontEndData[key] = value end

-- ClearFrame (Cfile:1264066) — all children of a root frame gone.
function ClearFrame(index)
  GetFrame(index or 0):ClearChildren()
end

-- FlushEvents (Cfile:1274594): "flush mouse/keyboard events". After construction
-- of the menu (main.lua:992) should be the clicks that occur during loading
-- have accrued, DO NOT add them later. The events come to us
-- individually from the DOM — there is no queue to empty; the
-- but running draggers do.
function FlushEvents()
  __mauiDragger = false
end

-- ExitApplication (Cfile:1263877): "request that the application shut down"
-- (main.lua:980, the exit button).
function ExitApplication()
  __uiExitRequested = true
  LOG('ExitApplication')
end

-- === Category volumes (SetVolume/GetVolume) ===
--
-- CUserSoundManager::SetVolume (Cfile:1346194, @0x8AAF60) resets the Duck
-- variable and forwards the RAW float to every AudioEngine instance —
-- and if none exists it simply caches (no error). AudioEngine::SetVolume
-- (Cfile:603714) stores the float in a map; GetVolume NEVER reads back
-- from XACT, only from that cache, insert-default 1.0
-- (Cfile:605038-605065). options.lua:700-779 drives it with 0..1
-- (Master='Global', FX='World'+'Interface', Music='Music').
__uiVolumeSink = false
__uiVolumes = {}

function SetVolume(category, volume)
  __uiVolumes[category] = volume
  if __uiVolumeSink then __uiVolumeSink(category, volume) end
end

function GetVolume(category)
  local v = __uiVolumes[category]
  if v == nil then
    v = 1.0
    __uiVolumes[category] = v
  end
  return v
end

-- WorldIsLoading: true between DoPreload(StartLoadingDialog) and
-- DoInitializing (StopLoadingDialog) — maintained by the provider chain
-- (ui-boot.lua). uimain.lua:120 (EscapeHandler) checks it before every ESC.
__uiWorldLoading = false

function WorldIsLoading()
  return __uiWorldLoading == true
end

-- === Keymap — the CUIKeyHandler of the engine ===
--
-- The engine has ONE key mapping (key -> CONSOLE COMMAND, no
-- Lua call): CUIKeyHandler::AddKeyMapTable (Cfile:1259176-1259264) parses each
-- Schluessel mit IN_ParseKeyModifiers (Cfile:1259566-1259700: Split an '-',
-- the LAST token is the key name from the keyNames table,
-- case-insensitiv; Modifier: Shift=0x80000000, Ctrl=0x40000000,
-- Alt=0x20000000) and reads from the value ONLY value['action'] (mandatory string) and
-- value['keyRepeat'] (optional) — category/order ignores the engine.
-- The action is triggered by the key handler below (__uiKeyMapExecute).
-- Moho::CON_Execute (Cfile:1259059).
__uiKeyMap = {}      -- Raw table (keyString -> action table), for Remove
__uiKeyNames = {}    -- VK (Zahl) -> Anzeigename (SetKeyNameTable)
__uiKeyVks = {}      -- lower(name) -> VK
__uiKeyActions = {}  -- (VK + Modifier-Bits) -> Konsolenbefehl-String
__uiKeyRepeatOk = {} -- (VK + Modifier-Bits) -> true (Auto-Repeat erlaubt)

-- SetKeyNameTable (Cfile:1259403-1259473): keyNames mit HEX-VK-Strings
-- (STR_Xtoi); > 0xFF gives a warning and is discarded.
function SetKeyNameTable(names)
  __uiKeyNames = {}
  __uiKeyVks = {}
  for hex, name in pairs(names or {}) do
    local vk = tonumber(hex, 16)
    if vk and vk <= 0xFF then
      __uiKeyNames[vk] = name
      __uiKeyVks[string.lower(name)] = vk
    else
      WARN('SetKeyNameTable: key code out of range: ' .. tostring(hex))
    end
  end
end

-- IN_ParseKeyModifiers (Cfile:1259566-1259700): returns the uint key
-- or nil (unknown key/modifier -> warning, like the engine).
local function parseKeyString(s)
  local tokens = {}
  for token in string.gmatch(tostring(s), '[^-]+') do
    tokens[#tokens + 1] = token
  end
  if #tokens == 0 then return nil end
  local keyName = tokens[#tokens]
  local vk = __uiKeyVks[string.lower(keyName)]
  if not vk then
    WARN('Key map contains unrecognized key string: ' .. tostring(s))
    return nil
  end
  local key = vk
  for i = 1, #tokens - 1 do
    local m = string.lower(tokens[i])
    if m == 'shift' then
      key = key + 0x80000000
    elseif m == 'ctrl' then
      key = key + 0x40000000
    elseif m == 'alt' then
      key = key + 0x20000000
    else
      WARN('Key map contains unrecognized modifier string: ' .. tostring(tokens[i]))
    end
  end
  return key
end

function IN_AddKeyMapTable(map)
  for keyStr, action in pairs(map or {}) do
    __uiKeyMap[keyStr] = action
    local keyInt = parseKeyString(keyStr)
    if keyInt then
      -- The engine reads value['action'] via GetString (required).
      local act = type(action) == 'table' and action.action or nil
      if type(act) == 'string' then
        __uiKeyActions[keyInt] = act
        if type(action) == 'table' and action.keyRepeat == true then
          __uiKeyRepeatOk[keyInt] = true
        else
          __uiKeyRepeatOk[keyInt] = nil
        end
      else
        WARN('Key map entry without action string: ' .. tostring(keyStr))
      end
    end
  end
end

function IN_RemoveKeyMapTable(map)
  for keyStr, _ in pairs(map or {}) do
    __uiKeyMap[keyStr] = nil
    local keyInt = parseKeyString(keyStr)
    if keyInt then
      __uiKeyActions[keyInt] = nil
      __uiKeyRepeatOk[keyInt] = nil
    end
  end
end

function IN_ClearKeyMap()
  __uiKeyMap = {}
  __uiKeyActions = {}
  __uiKeyRepeatOk = {}
end

-- The KEY HANDLER behind the maui dispatch (CUIKeyHandler::sub_838D10,
-- Cfile:1258983-1259080). It runs if __mauiKey('KeyDown', ...) is false
-- lieferte ("skipped"). Ablauf woertlich:
--   1. Existiert IRGENDEIN Fokus-Control -> sofort Skip (Cfile:1259003-1259005)
--      — a focused edit turns off ALL hotkeys.
--   2. Schluessel = VK | Modifier-Bits (Cfile:1259010-1259023).
--   3. Auto-repeat only if the key allows keyRepeat (Cfile:1259049).
--   4. Treffer -> CON_Execute(action) (Cfile:1259059).
--   5. No hit: Enter -> chat.ActivateChat (only in game,
--      Cfile:1263522-1263568), '~' (maui-Code 126) -> uimain.ToggleConsole
--      (Cfile:1262747-1262777).
-- Return: true if an action ran (the browser page then suppresses it
-- the standard behavior).
function __uiKeyMapExecute(vk, shift, ctrl, alt, isRepeat, mauiCode)
  if __mauiFocus and not __mauiFocus.__destroyed then return false end
  local key = vk
  if shift then key = key + 0x80000000 end
  if ctrl then key = key + 0x40000000 end
  if alt then key = key + 0x20000000 end
  if isRepeat and not __uiKeyRepeatOk[key] then return false end
  local action = __uiKeyActions[key]
  if action then
    ConExecute(action)
    return true
  end
  if mauiCode == 13 and GetCurrentUIState() == 'game' then
    -- Errors in Lua that the engine calls are logged, not thrown
    -- (RunScript -> gpg::Warnf) — otherwise a missing part would break (e.g. this
    -- Edit control of the chat) includes the entire key handler.
    local ok, err = pcall(function()
      import('/lua/ui/game/chat.lua').ActivateChat({
        Shift = shift or nil, Ctrl = ctrl or nil, Alt = alt or nil,
      })
    end)
    if not ok then WARN('ActivateChat: ' .. tostring(err)) end
    return true
  end
  if mauiCode == 126 then
    local ok, err = pcall(function()
      import('/lua/ui/uimain.lua').ToggleConsole()
    end)
    if not ok then WARN('ToggleConsole: ' .. tostring(err)) end
    return true
  end
  return false
end

-- IN_InitKeyHandler / CUIKeyHandler::LoadKeyMappings (Cfile:1259476-1259528):
-- the engine loads ITSELF keyNames.lua (SetKeyNameTable) when UI boots and
-- keymapper.GetKeyMappings() -> AddKeyMapTable — it doesn't wait for
-- that lobby.lua does it.
function __uiInitKeyMap()
  SetKeyNameTable(import('/lua/keymap/keyNames.lua').keyNames)
  IN_AddKeyMapTable(import('/lua/keymap/keymapper.lua').GetKeyMappings())
end

-- === Session / Umgebung ===
-- GetVersion is a CORE global (Cfile:599401) and returns the version of the
-- ENGINE, not the game data: Moho::GetEngineVersion (@0x4D3D30) is
-- simply `STR_Printf("%1.1f.%i", 1.5, 3764)` — compiled in. The engine here
-- are we; So the string says which engine is running. __engineVersion sets
-- the host from the package.json (uiEngine.ts).
function GetVersion()
  return __engineVersion or 'unbekannt'
end
function DebugFacilitiesEnabled() return false end
-- SessionIsReplay/SessionIsMultiplayer/SessionIsActive are WAY UP
-- defined (in the session globals). There were silent second versions here,
-- which overshadowed the real ones - SessionIsMultiplayer was always there
-- false, no matter how many command sources the session has.
-- === The PLAYTIME — it comes from the SIM, not the UI clock ===
--
-- The UI has its own clock (CurrentTime, seconds since start, 60 Hz frames);
-- the PLAYTIME counts in Sim ticks (10 Hz) and stands still when the Sim
-- paused. The engine side reports the tick per beat (__uiSetGameTick).
--
--   "string GetGameTime()" — a FORMATTED string (Cfile:1266614) that
--   Engine formatiert %H:%M:%S (wxTimeSpan::Format, Cfile:1266640). score.lua
--   literally shows it as a clock at the top right (score.lua:230).
__uiGameTick = 0
function __uiSetGameTick(t) __uiGameTick = t or 0 end
function GameTick() return __uiGameTick end
function GameTime() return __uiGameTick * 0.1 end
function GetGameTimeSeconds() return __uiGameTick * 0.1 end
function GetGameTime()
  local s = math.floor(__uiGameTick * 0.1)
  return string.format('%02d:%02d:%02d', math.floor(s / 3600), math.floor((s % 3600) / 60), s % 60)
end
function HasCommandLineArg() return false end
function GetCommandLineArg() return nil end

-- === Frames ===
-- GetFrame(0) is the root of the UI tree. The frame itself only exists once
-- the maui substrate is built (docs/PLAN-UI.md, step 2) — until then this
-- must FAIL rather than hand out a fake root that silently swallows controls.
function GetFrame(index)
  if not __uiFrames or not __uiFrames[index] then
    error('GetFrame(' .. tostring(index) .. '): kein maui-Frame — Substrat fehlt noch', 2)
  end
  return __uiFrames[index]
end
-- One head = one root frame; the engine counts from 0 (Cfile:1273621, loop
-- about the heads). `#__uiFrames` would be 0 here because the only entry is the
-- Index 0 is — uimain.lua:61 (`GetNumRootFrames() > 1` → multihead.lua).
-- Never noticed that, a later multihead test did.
function GetNumRootFrames()
  local n = 0
  while __uiFrames[n] do n = n + 1 end
  return n
end
