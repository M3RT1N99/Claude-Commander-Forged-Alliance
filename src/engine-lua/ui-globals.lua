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
__blueprints = {}
__uiUnits = {}
__uiRollover = false
__uiOverlayFilters = {}
__uiTeamColorMode = 'FactionColor'
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

-- =====================================================================
-- UserUnit — die Sicht der UI auf eine Unit.
--
-- Das ist NICHT die Sim-Unit. Die Engine haelt clientseitig eine gespiegelte
-- Struktur (UserUnit::mUnitVarDat, gefuellt von UserUnit::UpdateUnitData
-- @0x8C0750, Cfile:1363724) und veroeffentlicht 36 Methoden darauf
-- (Cfile:1364828-1367242). Die UI ruft davon nur eine Handvoll — der Rest der
-- Daten kommt als Plain-Feld aus der Rollover-Info.
--
-- Gefuettert wird das pro Sim-Beat aus dem Worker-Snapshot.
-- =====================================================================
__uiUnits = {}

local UserUnitMeta = {}
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
function UserUnitMeta:IsIdle() return self.idle ~= false end
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

-- Von der Engine pro Beat: der Zustand einer Unit aus der Sim.
function __uiSetUnit(id, blueprintId, army, x, y, z, health, maxHealth, workProgress, idle)
  local u = __uiUnits[id]
  if not u then
    u = setmetatable({ id = id }, UserUnitMeta)
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

function __uiRemoveUnit(id)
  local u = __uiUnits[id]
  if u then u.dead = true end
  __uiUnits[id] = nil
end

-- === Selektion ===
--
-- ACHTUNG: GetSelectedUnits() liefert bei LEERER Auswahl `nil`, nicht `{}`
-- (Cfile:1361395: lua_pushnil). Die gesamte Original-UI prueft mit
-- `if GetSelectedUnits() then` (construction.lua:1891, orders.lua:1250,
-- buildmode.lua:50). Ein leeres Table waere hier still falsch.
__uiSelection = false

function GetSelectedUnits()
  if not __uiSelection or table.getn(__uiSelection) == 0 then return nil end
  return __uiSelection
end

-- SelectUnits(nil) heisst "alles abwaehlen" (uiutil.lua:103) und ist legal.
-- Rueckgabe: die akzeptierten Units (Cfile:1361553).
function SelectUnits(units)
  local old = __uiSelection or {}
  local new = {}
  if type(units) == 'table' then
    for _, u in ipairs(units) do
      if not u:IsDead() then new[table.getn(new) + 1] = u end
    end
  end
  __uiSelection = new

  -- Die Engine benachrichtigt die UI ueber den SelectionListener
  -- (Moho::SelectionListener::Receive @0x869060, Cfile:1294170), der
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

-- added/removed berechnen und gamemain.OnSelectionChanged rufen — genau das,
-- was CWldSession::SetSelection (Cfile:1329207) vor dem Ueberschreiben tut.
function __uiNotifySelectionChanged(old, new)
  -- Der SelectionListener existiert im Original nur WAEHREND einer Sitzung
  -- (die Engine registriert ihn beim Session-Start). Vorher gibt es keine
  -- Empfaenger: SetupUI ruft ueber SetCurrentLayout ein SelectUnits(nil)
  -- (uiutil.lua:103), und das wuerde sonst gamemain.OnSelectionChanged
  -- ausloesen, bevor das Order-Panel ueberhaupt gebaut ist
  -- (orders.lua:1087 greift dann auf ein nil-Grid zu).
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

-- Die Engine waehlt aus: Maus-Picking liefert die Unit-Ids, die UI-VM macht
-- daraus UserUnits und ruft SelectUnits.
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
-- GetEconomyTotals() liefert genau die fuenf Tabellen, die economy.lua:271-275
-- liest, jeweils mit den Schluesseln MASS und ENERGY.
--
-- WICHTIG: die Werte sind PRO TICK, nicht pro Sekunde — economy.lua:277-279
-- multipliziert sie selbst mit GetSimTicksPerSecond(). Wer hier Werte pro
-- Sekunde einspeist, zeigt das Zehnfache an.
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

-- Von der Engine pro Sim-Beat gefuettert (der Worker schickt den Zustand).
function __uiSetEconomy(maxM, maxE, storedM, storedE, incM, incE, reqM, reqE, useM, useE)
  local e = __uiEcon
  e.maxStorage.MASS = maxM
  e.maxStorage.ENERGY = maxE
  e.stored.MASS = storedM
  e.stored.ENERGY = storedE
  -- pro Tick (die Sim rechnet in Einheiten pro Sekunde)
  e.income.MASS = incM * 0.1
  e.income.ENERGY = incE * 0.1
  e.lastUseRequested.MASS = reqM * 0.1
  e.lastUseRequested.ENERGY = reqE * 0.1
  e.lastUseActual.MASS = useM * 0.1
  e.lastUseActual.ENERGY = useE * 0.1
end

-- === Kommando-Daten der Selektion ===
--
-- GetUnitCommandData(unitSet) -> orders, toggles, buildableCategories
-- (Cfile:1264504-1264646). Die Engine verrechnet pro Unit die
-- CommandCaps/ToggleCaps und die vorkompilierte Bau-Kategorie aus dem
-- Blueprint (bp.Economy.BuildableCategory) und akkumuliert ueber die Selektion
-- als VEREINIGUNG (EntityCategory::Add).
--
-- orders/toggles sind ARRAYS von Cap-Strings — orders.lua:891 iteriert sie
-- mit `for index, availOrder in availableOrders do`.
function GetUnitCommandData(units)
  if type(units) ~= 'table' or table.getn(units) == 0 then return end

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

-- GetRolloverInfo(): die Unit unter dem Mauszeiger (unitview.lua liest daraus
-- die meisten Werte als Plain-Felder, nicht ueber UserUnit-Methoden).
function GetRolloverInfo()
  return __uiRollover or nil
end

function __uiSetRollover(id)
  local u = id and __uiUnits[id]
  if not u then
    __uiRollover = false
    return
  end
  __uiRollover = {
    userUnit = u,
    blueprintId = u.blueprintId,
    armyIndex = u.army,
    health = u.health,
    maxHealth = u.maxHealth,
    shieldRatio = u.shieldRatio or 0,
    fuelRatio = u.fuelRatio or -1,
    workProgress = u.workProgress or 0,
    kills = 0,
    customName = u.customName,
  }
end

-- === Overlays (Ansichtsfilter der WorldView) ===
-- multifunction.lua:272 schaltet damit die Karten-Overlays um. Die WorldView
-- rendert sie; bis es sie gibt, ist das reiner Zustand — aber echter Zustand,
-- kein Schweigen.
__uiOverlayFilters = {}
__uiTeamColorMode = 'FactionColor'

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
