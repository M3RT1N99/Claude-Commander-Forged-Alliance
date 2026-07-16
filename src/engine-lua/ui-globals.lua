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
-- Weltpunkt -> Bildschirm. Das kann nur die 3D-Seite; sie haengt sich hier ein.
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
-- Es gibt MEHRERE: 'WorldCamera' (die Hauptansicht), 'MiniMap', 'CameraHead2'.
-- worldview.lua:593 holt sie ueber GetCamera(name), minimap.lua ueber ihren
-- eigenen Namen. Die Kamera selbst ist die 3D-Seite (TypeScript) — hier steht
-- der Zugriff, nicht die Rechnung.
__uiCameras = {}
__uiCameraBridge = false

--- GetCamera(name) — das Kamera-Objekt zu einem Namen (scr_UserInits).
function GetCamera(name)
  local key = tostring(name or 'WorldCamera')
  if not __uiCameras[key] then
    local cam = Class(moho.camera_methods) {}()
    cam.__name = key
    __uiCameras[key] = cam
  end
  return __uiCameras[key]
end

--- Die Bruecke zur 3D-Seite. Fehlt sie, wird NICHTS behauptet: eine Kamera, die
--- niemand rendert, hat auch keinen Zoom.
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

--- "UIZoomTo(units,[seconds])" (Cfile:1292715): die Hauptkamera faehrt auf die
--- Mitte der gegebenen Einheiten. gamemain.OnFirstUpdate zoomt so beim Start
--- auf die ACU; die Avatar-Icons springen damit zu ihrer Einheit.
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

--- avatars.lua:42 springt damit per Klick zum naechsten leerlaufenden Ingenieur.
function UISelectAndZoomTo(unit, seconds)
  if not unit then return end
  SelectUnits({ unit })
  UIZoomTo({ unit }, seconds)
end

-- GetCursor() (Cfile:1274426) — das aktuelle Cursor-Objekt. uimain.lua:23 setzt
-- es bei JEDEM Zustandswechsel neu; splash.lua:27/52 blendet es waehrend der
-- Filme aus. Vorher warf es aus der Fehl-Liste und riss den Splash mit.
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

-- Die Engine gibt eine KOPIE in die Lua, keine Referenz: cfunc_GetPreferenceL
-- ruft `Moho::SCR_Copy(&a1, v5, esi0)` (Cfile:1370179), cfunc_GetOptionsL
-- genauso (Cfile:1370017). Das ist kein Detail, sondern der Grund, warum
-- `Prefs.SetOption` ueberhaupt funktioniert:
--
--   SetOption holt sich mit optionslogic.GetCurrent() die Options-Tabelle,
--   aendert EINEN Wert darin und uebergibt sie an SetCurrent(). SetCurrent
--   vergleicht sie dann gegen GetCurrent() — und ruft `item.set` nur fuer die
--   Werte, die sich UNTERSCHEIDEN (optionslogic.lua:100-123).
--
-- Gaeben wir die lebende Tabelle heraus, waere die "alte" Tabelle dieselbe wie
-- die "neue": SetOption haette den Wert schon im Profil geaendert, der Vergleich
-- faende keinen Unterschied, und `set` liefe NIE. Die Option landete brav in den
-- Prefs — und wirkte trotzdem nichts.
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

-- Der Weg nach draussen: die Engine schreibt Game.prefs als LUA-QUELLTEXT
-- (nachgesehen in der Installation: `PreGameData = { CurrentMapDir = '...' }`).
-- __prefsSerialize() (prefs.lua) macht genau diesen Text; __uiSavePrefs legt ihn
-- ab (im Browser: localStorage). Ohne den Haken war SavePreferences() ein
-- Nullaufruf und jede Einstellung nach dem Neuladen weg.
function __prefsFlush()
  if __uiSavePrefs then
    __uiSavePrefs(__prefsSerialize())
  end
end

-- GetOptions(key): the engine's option store (video, sound, gameplay).
-- prefs.lua:44 reads 'primary_adapter' when it creates a profile.
-- GetOptions(key) — "obj GetOptions()" (Cfile:1369977), Rumpf:
-- CUserPrefs::LookupCurrentOption (Cfile:1370017). Es ist die Option des
-- AKTUELLEN PROFILS, nicht eine globale Tabelle: optionslogic.lua legt sie mit
-- `Prefs.SetToCurrentProfile('options', curOptions)` (Zeile 60) genau dort ab
-- und liest sie mit `Prefs.GetFromCurrentProfile('options')` (Zeile 48) wieder.
-- Wer stattdessen GetPreference('options') liest, sieht die Aenderung nie —
-- prefs.SetOption('mainmenu_bgmovie', false) verpuffte still, und das Menue
-- baute weiter seinen Film.
function GetOptions(key)
  local profile = GetPreference('profile')
  if not profile or not profile.current or not profile.profiles then return nil end
  local current = profile.profiles[profile.current]
  if not current or not current.options then return nil end
  -- Auch hier eine KOPIE (Moho::SCR_Copy, Cfile:1370017) — siehe GetPreference.
  if key == nil then return deepCopy(current.options) end
  return deepCopy(current.options[key])
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

-- Die UserUnit-Klasse der UI-VM (Cfile: 35 Bindungen). Sie ist KEINE moho-Klasse:
-- die Engine gibt der UI eigene Objekte. Global, damit der Engine-Abgleich
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
-- Der Spiegel meldet idle jetzt ECHT (units.lua readRow: kein Ziel, kein
-- Bau-Auftrag, keine Produktion) — nil ist hier ein Fehler, kein Idle.
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

-- SetCustomName: gamemain.OnFirstUpdate tauft die ACU auf den Spielernamen
-- (gamemain.lua:84); unitview.lua:205 zeigt ihn im Rollover. Der Name lebt in
-- der UI-Kopie — die Original-Engine synct ihn zusaetzlich in die Sim (spaeter,
-- mit dem UnitData-Sync).
function UserUnitMeta:SetCustomName(name) self.customName = name end
-- Die Bau-Warteschlange einer Fabrik: { { id = <blueprintId>, count = <n> }, ... }
-- (construction.lua:1620). Sie wird aus der Sim gespiegelt; leer heisst leer.
function UserUnitMeta:GetBuildQueue() return self.buildQueue or {} end

-- GetAttachedUnitsList(units): die transportierten/angedockten Einheiten der
-- Selektion (construction.lua:1630). Ohne Transporter in der Sim ist die Liste
-- leer — das ist eine Tatsache, keine Luecke.
function GetAttachedUnitsList(units)
  local out = {}
  for _, u in ipairs(units or {}) do
    for _, a in ipairs(u.attached or {}) do out[table.getn(out) + 1] = a end
  end
  return out
end

-- Von der Engine pro Beat: der Zustand einer Unit aus der Sim.
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

-- Die Bau-Warteschlange einer Fabrik aus der Sim spiegeln. Die Engine haelt sie
-- in der UI-Kopie der Unit; construction.lua liest sie ueber
-- SetCurrentFactoryForQueueDisplay und zeigt sie als Stapel an.
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

-- === Die Listen, aus denen die Avatar-Leiste lebt (rechts oben) ===
--
--   "table GetArmyAvatars() - return a table of avatar units for the army"
--   (mHelp, Cfile:1360874)
--
-- avatars.lua:658 baut daraus die anklickbaren Icons (die ACU!), gamemain.lua:79
-- gibt der ACU beim Start den Spielernamen. Ohne diese Listen bleibt die
-- Avatar-Leiste LEER — genau das war zu sehen.
--
-- Ein „Avatar" ist eine Unit der eigenen Armee in der Kategorie COMMAND
-- (der Kommandeur; bei Nomads/Sub-Commander mehr). Gefiltert wird ueber die
-- Kategorien des Blueprints — keine Sonderliste, keine geratene Auswahl.
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
  -- Das Kriterium der Engine (UserUnit-Ctor, Cfile:1362979-1362982): ein
  -- Avatar ist jede Unit mit bp.General.QuickSelectPriority > 0 (Ctor-Default
  -- 0, Cfile:656079 — in Vanilla setzen es nur die vier ACU-.bp auf 1).
  -- Einsortiert wird AUFSTEIGEND: vor dem ersten STRIKT groesseren Eintrag
  -- (Cfile:1352238-1352239); bei gleicher Prioritaet bleibt die
  -- Entstehungsreihenfolge — hier die Unit-ID (die Sim vergibt sie aufsteigend).
  local out = unitsOfFocusArmy(function(bp)
    return (bp.General.QuickSelectPriority or 0) > 0
  end)
  -- Bei leerer Liste liefert die Engine NIL, keine leere Tabelle
  -- (cfunc_GetArmyAvatarsL, Cfile:1360921: ohne Eintraege wird nichts
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

-- Leerlaufende Ingenieure/Fabriken (die zwei Knoepfe unter den Avataren).
-- „Idle" ist der Zustand, den die Sim meldet (u.idle).
function GetIdleEngineers()
  -- mIsEngineer (UserUnit-Ctor, Cfile:1362995-1363014): Kategorie ENGINEER,
  -- aber NICHT COMMAND, SCOUT oder UNTARGETABLE — sonst stuende die
  -- leerlaufende ACU mit in der Ingenieurs-Lasche.
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

-- "IsKeyDown(keyCode)" (mHelp Cfile:1141963; Rumpf 1141975-1142000): der
-- String wird per SCR_GetEnum in ein EMauiKeyCode aufgeloest und
-- MAUI_KeyIsDown gefragt. Die Original-UI fragt genau EINEN Namen: 'Shift'
-- (commandmode.lua:82 — haelt der Spieler Shift, bleibt der Befehls-Modus
-- nach dem ersten Befehl aktiv: die Bau-Warteschlange). Der Zustand kommt
-- aus den Browser-Tastatur-Events (gameUi.attachEvents -> __uiSetKeyDown);
-- headless ist keine Taste gedrueckt — auch das ist die Wahrheit.
__uiKeysDown = {}

function __uiSetKeyDown(name, down)
  __uiKeysDown[name] = down == true
end

function IsKeyDown(keyCode)
  return __uiKeysDown[keyCode] == true
end

-- "Validate a list of units" (mHelp, Cfile:1360576; Rumpf 1360596-1360650):
-- filtert eine Unit-Liste auf lebende UserUnits (nicht IsDead, nicht
-- DestroyQueued), Reihenfolge bleibt erhalten. Rueckgabe ist IMMER eine
-- Tabelle, auch leer (AssignNewTable + PushStack — anders als die
-- Avatar-Listen!); ohne Session nil (return 0, Cfile:1360604).
-- controlgroups.lua:102 (Strg-Gruppen) und selection.lua:82/132/165 filtern
-- damit tote Einheiten aus gemerkten Listen.
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

-- "Get a list of units assisting me" (mHelp, Cfile:1360671): die Guards der
-- gegebenen Units. orders.lua:932 fragt so die Drohnen einer
-- PODSTAGINGPLATFORM ab — und die UEF-ACU TRAEGT diese Kategorie
-- (uel0001_unit.bp:125); der Pfad laeuft also bei jeder ACU-Auswahl. Unsere
-- Sim fuehrt noch kein Guard/Assist-System: der Spiegel kennt keine
-- Assistenten, die leere Liste ist die WAHRE Antwort. Sobald die Sim Assist
-- lernt, muss der Spiegel die Guards hierher liefern.
function GetAssistingUnitsList(units)
  return {}
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
--
-- Bei LEERER Auswahl liefert die Engine LEERE TABELLEN, nicht nil: die beiden
-- AssignNewTable-Aufrufe (Cfile:1264740, :1264765) stehen HINTER der Schleife
-- ueber die Units und laufen deshalb immer. Wer hier nil zurueckgibt, toetet
-- orders.lua:891 (`for index, availOrder in availableOrders do`) bei jeder
-- Abwahl — und damit die ganze UI-VM.
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

-- === Die Naht zur Sim ===
--
-- Im Original schickt die Engine jeden Befehl der UI als ProcessInfo an den
-- SimDriver (cfunc_SetFireStateL: sSimDriver->ProcessInfo(entityId,
-- "SetFireState", value)) — die UI SETZT nichts, sie BITTET. Hier ist es
-- dieselbe Naht: eine Funktion, die die Engine setzt. Fehlt sie, KNALLT es —
-- ein Befehl, der still verpufft, ist schlimmer als gar keiner.
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

-- === SimCallback — Lua-Funktionen in der Sim aufrufen ===
--
-- mHelp woertlich (Cfile:1359123-1359128): "SimCallback(callback[,bool]):
-- Execute a lua function in sim. callback = { Func = function name (in the
-- SimCallbacks.lua module) to call, Args = Arguments as a lua object }. If
-- bool is specified and true, sends the current selection with the command."
--
-- Der Weg im Original (cfunc_SimCallbackL, Cfile:1359139-1359305): Args werden
-- SOFORT serialisiert (SCR_ToByteStream — ein Snapshot, keine Referenz;
-- Funktionen darin sind ein harter Fehler, CMarshaller Cfile:999128), die
-- Auswahl geht als Entity-ID-Set mit. Die Sim-Seite (Moho::Sim::LuaSimCallback,
-- Cfile:1076180-1076287) baut daraus Unit-Objekte (leeres Set -> nil) und ruft
-- import('/lua/SimCallbacks.lua').DoCallback(name, args, units).
__uiSimCallbackSink = false

-- Der Serialisierungs-Snapshot (SCR_ToByteStream): die Args werden zu einem
-- LUA-KONSTRUKTOR-Literal serialisiert (string.format('%q') escaped
-- Lua-sicher), das die Sim-VM beim Empfang auswertet — eine Kopie, keine
-- Referenz. Funktionen/Userdata knallen wie im Original ("Unable to marshal
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
    -- Cfile:1359229-1359231: Func muss ein String sein.
    error('SimCallback: callback.Func must be a string', 2)
  end
  if not __uiSimCallbackSink then
    error('SimCallback "' .. callback.Func .. '" hat keinen Weg in die Sim (__uiSimCallbackSink fehlt)', 2)
  end
  local ids = {}
  if addSelection == true then ids = idsOf(GetSelectedUnits()) end
  __uiSimCallbackSink(callback.Func, marshalArgs(callback.Args), ids)
end

-- === Befehle mit einem Blueprint als Ziel ===
--
-- IssueBlueprintCommand(command, blueprintId, count, clear) — construction.lua:884
-- schickt damit eine Einheit in die Warteschlange der ausgewaehlten Fabrik
-- ("UNITCOMMAND_BuildFactory"), oder ein Upgrade an ein Gebaeude
-- ("UNITCOMMAND_Upgrade", construction.lua:876). Eine POSITION gibt es hier
-- nicht — was platziert werden muss, laeuft ueber den Command-Mode.
--
-- Die UI fuehrt den Befehl nicht aus, sie schickt ihn: sendSim -> Engine -> Sim.
function IssueBlueprintCommand(command, blueprintId, count, clear)
  local sel = GetSelectedUnits()
  if not sel then return end
  sendSim(command, sel, { blueprint = blueprintId, count = count or 1, clear = clear == true })
end

-- === Die Armeen der Session ===
--
-- "armyInfo GetArmiesTable()" (scr_UserInits). Die UI liest daraus:
--   .armiesTable  Liste der Armeen (nickname, faction, color, iconColor, human …)
--   .focusArmy    welche Armee der Spieler sieht (1-basiert)
--   .numArmies
--
-- Nutzer: avatars.lua:30, chat.lua:1027, score.lua:193, createunit.lua:320,
-- worldview.lua:318 (`GetArmiesTable().focusArmy - 1` — die Ping-Owner sind
-- 0-basiert, die Tabelle 1-basiert).
--
-- Die Armeen kommen aus der SESSION (Szenario + Lobby), nicht aus der UI. Bis es
-- eine echte Session gibt, traegt sie die Engine-Seite hier ein (__uiSetArmies);
-- ohne Session ist die Liste LEER — das ist die Wahrheit, keine Attrappe.
--
-- Welche Felder je Armee drinstehen, steht NICHT zur Debatte — die Engine setzt
-- sie in cfunc_GetArmiesTableL (Cfile:1267023-1267111) einzeln:
--   name, nickname, faction, color, iconColor, showScore, civilian, human,
--   outOfGame, authorizedCommandSources
-- und oben numArmies + focusArmy (1-basiert; -1 bleibt -1).
--
-- WICHTIG: `faction` ist 0-BASIERT (mVarDat.mFaction). Die Lua rechnet ueberall
-- `faction + 1`, um in /lua/factions.lua zu indizieren (gamemain.lua:109,
-- orders.lua:675, avatars.lua:664). Wer hier 1..4 eintraegt, gibt jedem Spieler
-- die falsche Fraktion — still.
__uiArmies = {}
__uiFocusArmy = 1

function __uiSetArmies(armies, focusArmy)
  __uiArmies = armies or {}
  __uiFocusArmy = focusArmy or 1
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

-- === Die laufende Session ===
--
-- mHelp woertlich:
--   SessionGetScenarioInfo()  "Return the table of scenario info that was
--                              originally passed to the sim on launch."
--   SessionRequestPause()     "Pause the world simulation."
--   SessionResume()           "Resume the world simulation."
--   SessionIsPaused()         "Return true iff the session is paused."
--   SessionGetLocalCommandSource()  "Return the local command source. Returns 0
--                                    if the local client can't issue commands."
--
-- Die Szenario-Info ist GENAU die Tabelle, die beim Start an die Sim ging
-- (ScenarioInfo aus <map>_scenario.lua) — die Engine gibt sie unveraendert
-- zurueck. diplomacy.lua:34 greift ungeprueft auf `.Options.TeamLock` zu, also
-- muss sie da sein, sobald eine Session laeuft. Ohne Session: nil — die Wahrheit.
__uiScenarioInfo = false
__uiSessionPaused = false
__uiPauseSink = false
__uiCommandSources = {}
__uiLocalCommandSource = 0

--- Eine SESSION aufsetzen (was CWldSession beim Start tut).
---
--- Aufgerufen von der Engine-Seite mit denselben Angaben, die auch die Sim
--- bekommt (src/sim/session.ts) — die UI erfindet hier NICHTS, sie spiegelt die
--- Session. Ohne Session bleibt alles leer, und die Session-Globals knallen
--- genau wie im Original ("no active session.", Cfile:1330339).
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

--- Eine Armee eintragen. `faction` ist 1..4 (wie im ArmySetup der Sim); die
--- armiesTable traegt sie 0-basiert, weil die Engine das so tut.
--- Die Farbe kommt aus /lua/GameColors.lua (PlayerColors/ArmyColors) — der
--- Tabelle des Spiels, nicht aus der Luft.
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

--- Die Befehlsquellen (die Clients). Im Einzelspieler genau eine — der Spieler.
--- Die Engine liefert den lokalen Index 1-basiert, 0 wenn der Client nicht
--- befehligen darf (Cfile:1330618: `mLocalCmdSrc + 1`, 255 -> 0).
function __uiSessionSetCommandSources(name, localIndex)
  __uiCommandSources = { name }
  __uiLocalCommandSource = localIndex or 0
end

--- Welche Armee der Spieler sieht (1-basiert; -1 = Beobachter).
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

-- Pause ist ein Eingriff in die SIM, nicht in die UI: die Engine haelt die
-- WELT an (CWldSession::RequestPause). Ohne Session wirft die Engine
-- "SessionRequestPause(): no active session." — hier ebenso, statt still nichts
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

--- "Return a table of command sources." (mHelp). Ohne Session: Fehler.
function SessionGetCommandSourceNames()
  if not __uiScenarioInfo then error('SessionGetCommandSourceNames(): no active session.', 2) end
  return __uiCommandSources
end

--- "Return the local command source. Returns 0 if the local client can't issue
--- commands." — 1-basiert, NICHT die Armee.
function SessionGetLocalCommandSource()
  if not __uiScenarioInfo then error('SessionGetLocalCommandSource(): no active session.', 2) end
  return __uiLocalCommandSource
end

function SessionIsActive()
  return __uiScenarioInfo ~= false
end

-- === Neustart der Session ===
--
-- cfunc_RestartSessionL (Cfile:1263968-1263985): NUR wenn eine Session laeuft
-- UND sie restartbar ist (dasselbe Flag liefert SessionCanRestart,
-- Cfile:1330810-1330826), wird die Frame-Action auf CREATE_SESSION gesetzt —
-- der Haupt-Loop faehrt dann Teardown + Neustart mit den UNVERAENDERTEN
-- Session-Infos (func_DoPreload, Cfile:1320748-1320784). Sonst: No-Op, KEIN
-- Fehler. Die Engine-Seite haengt sich hier als __uiRestartSink ein; ohne
-- Sink ist die Session schlicht nicht restartbar (mCanRestart = false).
__uiRestartSink = false

function SessionCanRestart()
  return __uiScenarioInfo ~= false and __uiRestartSink ~= false
end

function RestartSession()
  if not SessionCanRestart() then return end
  __uiRestartSink()
end

-- === Die Clients der Session ===
--
-- Felder je Client aus cfunc_GetSessionClientsL (Cfile:1321886-1321957):
-- name, uid, connected, ping, quiet, local, authorizedCommandSources,
-- ejectedBy. Im Einzelspieler gibt es genau einen Client — den Spieler
-- (dieselbe Quelle wie SessionGetCommandSourceNames).
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
-- Cfile:1322062). Der Weg im Original (cfunc, Cfile:1322106-1322227):
--   * 1 Argument: alle Clients; (int, msg): EIN Client-Index (1-basiert,
--     validiert); (table, msg): Menge von Indizes — Indizes in die
--     GetSessionClients-Liste.
--   * msg wird SOFORT serialisiert (Snapshot! chat.lua:759 setzt msg.echo
--     erst NACH dem Senden — die zugestellte Kopie bleibt unberuehrt);
--     > 1024 Bytes serialisiert -> "Message too long." (Cfile:1322198-1322204).
--   * Zustellung ASYNCHRON (THREAD_InvokeAsync, Cfile:1320454): beim
--     naechsten Frame ruft func_ReceiveChat (Cfile:1263605-1263646)
--     gamemain.ReceiveChat(senderName, msgTable) — der Sender ist dabei,
--     wenn er in der Empfaengermaske steht (Loopback).
-- Chat laeuft auf der NETZSCHICHT (Client-Manager), nicht ueber Sim/Sync —
-- im Einzelspieler heisst das: komplett in dieser VM.
function SessionSendChatMessage(clientsOrMsg, msg)
  if not __uiScenarioInfo then error('GameSendChatMessage(): No active game.', 2) end
  local targets, message
  if msg == nil then
    message = clientsOrMsg
    targets = false -- alle
  else
    message = msg
    targets = clientsOrMsg
  end
  if type(message) ~= 'table' then error("Can't encode message.", 2) end

  -- Der Serialisierungs-Snapshot (SCR_ToByteStream): eine tiefe Kopie JETZT,
  -- mit Byte-Zaehlung als Naeherung der ByteStream-Groesse fuer die
  -- 1024er-Grenze (Cfile:1322198-1322204). Funktionen/Userdata knallen wie im
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
    localIncluded = true -- Maske (1 << N) - 1: alle, auch der Sender
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
    -- Die Kopie aus dem Snapshot zustellen — NICHT die Original-Tabelle.
    local nick = __uiCommandSources[__uiLocalCommandSource] or 'Player'
    ForkThread(function()
      WaitFrames(1)
      import('/lua/ui/game/gamemain.lua').ReceiveChat(nick, copy)
    end)
  end
end

-- === Der WldUIProvider — die Naht zwischen Welt-Laden und UI ===
--
-- InternalCreateWldUIProvider(self) (cfunc, Cfile:28934) baut den
-- CLuaWldUIProvider um das Lua-Objekt und registriert ihn als DEN Provider
-- (Moho::WLD_SetUIProvider, Cfile:29710). Die Engine ruft dann seine
-- Methoden per RunScript (Cfile:1295316-1295350): StartLoadingDialog beim
-- Weltstart (func_DoPreload, Cfile:1320770), UpdateLoadingDialog(elapsed)
-- pro Bild waehrend des Ladens, StopLoadingDialog nach dem ERSTEN Beat mit
-- Sync-Daten (DoInitializing, Cfile:1321067) — und erst DANACH
-- CreateGameInterface (= gamemain.CreateUI). gamemain.lua:225 haengt an
-- genau diesen Haken den Lade-Dialog und die InitialAnimations.
__uiWldProvider = false

function InternalCreateWldUIProvider(luaobj)
  __uiWldProvider = luaobj
end

-- "FlushEvents() -- flush mouse/keyboard events" (Cfile:1274567): leert die
-- Eingabe-Queue des UI-Managers (sub_84DA80). gamemain.lua:297 ruft es am Ende
-- von StopLoadingDialog, damit waehrend des Ladens gepufferte Klicks nicht ins
-- frische Spiel durchschlagen. Unsere Events laufen SYNCHRON (__mauiMouse
-- verarbeitet sofort, es gibt keine Queue) — geleert wird eine leere Queue.
function FlushEvents() end

--- "Return true iff the active session is a replay session." — wir spielen live.
function SessionIsReplay()
  return false
end

function SessionIsMultiplayer()
  return table.getn(__uiCommandSources) > 1
end

-- === Konsolen-Ausgabe ===
--
-- "handler AddConsoleOutputReciever(func(text))" / "RemoveConsoleOutputReciever(handler)"
-- (Schreibfehler im Original: "Reciever"). consoleecho.lua:35 haengt sich damit
-- an die Konsolenausgabe, um sie im Spiel einzublenden.
__uiConsoleReceivers = {}

function AddConsoleOutputReciever(func)
  table.insert(__uiConsoleReceivers, func)
  return func -- das Handle ist die Funktion selbst
end

function RemoveConsoleOutputReciever(handler)
  for i = table.getn(__uiConsoleReceivers), 1, -1 do
    if __uiConsoleReceivers[i] == handler then
      table.remove(__uiConsoleReceivers, i)
    end
  end
end

--- Eine Konsolenzeile an alle Empfaenger (die Engine ruft das bei jeder Ausgabe).
function __uiConsoleOutput(text)
  for _, func in ipairs(__uiConsoleReceivers) do
    pcall(func, text)
  end
end

-- === Befehle an die aktuelle Auswahl ===
--
-- mHelp woertlich:
--   IssueCommand(command, [string], [clear])                 Cfile: luadef_IssueCommand
--   IssueUnitCommand(unitList, command, [string], [clear])
--   IssueDockCommand(clear)
--
-- Das zweite Argument ist NICHT immer ein String: construction.lua:980 uebergibt
-- eine TABELLE (orderData mit TaskName/Enhancement) fuer ein ACU-Upgrade. Die
-- Engine reicht sie unveraendert an die Sim durch — also tun wir das auch, statt
-- sie zu einem String zu verbiegen.
-- "string GetUnitCommandFromCommandCap(string) - given a RULEUCC type command"
-- (mHelp, Cfile:1264832). Der Weg im Original (cfunc, Cfile:1264844-1264889):
-- Eingabe per REnumType::SetLexical parsen (case-insensitiv, Praefix optional,
-- Cfile:1381888-1381946), dann Moho::UnitCommandCapToCommandType
-- (Cfile:1242230-1242328), Rueckgabe per GetLexical — und EUnitCommandType
-- speichert seine Namen OHNE das "UNITCOMMAND_"-Praefix (mPrefix,
-- Cfile:696168-696248; Beweis: UICommandGraph::LoadPathParams setzt den
-- Praefix per STR_Printf("%s%s", ...) selbst davor, Cfile:1244372-1244378).
-- Der Stop-Knopf (orders.lua:205) steckt das Ergebnis direkt in IssueCommand —
-- dort parst SetLexical den Praefix-losen Namen genauso.
local CAP_TO_COMMAND = {
  -- Das VOLLSTAENDIGE Mapping aus func_UnitCommandCapToCommandType
  -- (Cfile:1242230-1242328); nicht gemappte Caps liefern 'None'.
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
    -- SetLexical wirft bei unbekannten Enum-Namen (Cfile:1381940-1381946).
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

-- "IssueDockCommand(clear)" — die Auswahl andocken (Traeger/Transport).
function IssueDockCommand(clear)
  local sel = GetSelectedUnits()
  if not sel then return end
  sendSim('UNITCOMMAND_Dock', sel, { clear = clear == true })
end

-- === Bau-Vorlagen ===
--
-- Die Engine haelt EINE aktive Vorlage (eine Liste aus Blueprint + Versatz), die
-- die Weltansicht beim naechsten Klick als Gruppe setzt. construction.lua:946
-- setzt sie, commandmode.lua:120 raeumt sie beim Abbruch weg.
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

-- === Befehls-Rueckmeldung in der Welt ===
--
-- AddCommandFeedbackBlip(spec, duration): die Engine setzt ein kurzlebiges Mesh
-- an die Zielposition (commandmode.lua:133-176 — Fahne, Fadenkreuz, Bau-Flagge).
-- Das Zeichnen ist Renderer-Arbeit; hier wird der Auftrag gefuehrt, damit der
-- Renderer ihn abholen kann. Erfunden wird nichts: Position, Mesh und Textur
-- kommen aus der Lua.
__uiBlips = {}

function AddCommandFeedbackBlip(spec, duration)
  __uiBlips[table.getn(__uiBlips) + 1] = { spec = spec, duration = duration }
end

-- Der Renderer holt die aufgelaufenen Blips ab (und leert die Liste).
function __uiTakeBlips()
  local out = __uiBlips
  __uiBlips = {}
  return out
end

-- === Klang ===
--
-- PlaySound(sound) nimmt genau das Sound{}-Objekt aus dem Blueprint
-- (bp.Audio.UISelection, selection.lua:5) — Bank + Cue. Die Ausgabe selbst ist
-- ein eigenes Engine-Teil (FMOD-Baenke in sounds.scd), das es noch nicht gibt.
--
-- Deshalb: die angeforderten Cues werden PROTOKOLLIERT und das Fehlen der
-- Ausgabe wird EINMAL laut gemeldet. Nichts wird erfunden, nichts wird
-- verschwiegen — und ein Test kann pruefen, dass die richtige Cue kam.
-- Die Signaturen kommen aus den mHelp-Strings der Decomp:
--
--   handle = PlaySound(sndParams, prepareOnly)   Cfile:1348030
--   StartSound(handle)                           Cfile:1348174
--   StopSound(handle, [immediate=false])         Cfile:1348237
--   bool = SoundIsPrepared(handle)               Cfile:1348102
--   PauseSound(categoryString, bPause)           Cfile:1347882  <- KATEGORIE,
--   PlayVoice(params, duck)                      Cfile:1348652     kein Handle
--
-- Das HANDLE ist der Punkt: main.lua:231-249 startet die Menuemusik und stoppt
-- sie ueber genau dieses Handle (`StopSound(musicHandle)` in StopMusic und
-- OnDestroy). Ohne Rueckgabewert haette StopSound nichts zu stoppen — die Musik
-- liefe im Menue ewig weiter, sobald es eine Ausgabe gibt.
__uiAudioSink = false
-- Stop-Naht: StopSound meldet die Handle-ID, damit die Ausgabe laufende
-- Quellen (Musik, Loops) wirklich beendet — nicht nur das Flag setzt.
__uiAudioStopSink = false
__uiNextSoundId = 1
__uiSoundsRequested = {}
local warnedNoAudio = false

-- EnableWorldSounds()/DisableWorldSounds() (Cfile:1348520-1348545, 0 Argumente):
-- der Schalter fuer die WELT-Gerausche (Waffen, Einheiten — nicht die UI-Cues).
-- gamemain.OnFirstUpdate() schaltet sie beim Spielstart an (gamemain.lua:78),
-- splash/NIS schalten sie aus. Echter Zustand; die Audio-Ausgabe liest ihn,
-- sobald es sie gibt.
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
    -- Ein Handle ist "prepared", sobald die Bank die Cue geladen hat. Wir laden
    -- nichts — also ist es das sofort. movie.lua:37-49 wartet darauf; ein ewiges
    -- false wuerde den Splash-Film blockieren.
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

-- PauseSound/PauseVoice arbeiten auf KATEGORIEN ("music", "voice", …), nicht auf
-- Handles — deshalb ein eigener Zustand.
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
-- Die Kategorien stehen in der Original-Lua: options.lua:700/729/735/745 setzt
-- "Global", "World", "Interface" und "Music". Der Wertebereich ist 0..1 — die
-- Option ist ein Regler 0..100 und teilt selbst durch 100 (options.lua:710).
--
-- Der Startwert ist 1.0, weil genau das die Option vorgibt (default = 100,
-- options.lua:697) und `set` beim Start SetVolume(value/100) ruft. Es ist keine
-- erfundene Zahl, sondern die, die die Original-Lua eine Zeile spaeter selbst
-- setzt. Ausgabe gibt es noch keine (M12) — der Zustand wird nur gefuehrt.
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

-- === Bau-Warteschlange der angezeigten Fabrik ===
--
-- cfunc_SetCurrentFactoryForQueueDisplayL (Cfile:1257038-1257087) merkt sich die
-- Unit als WeakPtr (sCurrentBuildFactory) und liefert die Warteschlange zurueck.
-- construction.lua:1764 haengt genau daran: `currentCommandQueue = SetCurrent...`,
-- und die Engine ruft bei jeder Aenderung construction.OnQueueChanged(newQueue).
--
-- Die Eintraege sind { id = <blueprintId>, count = <n> } (construction.lua:1620).
__uiQueueFactory = false
-- Die Kopie der zuletzt gemeldeten Queue (sCurrentBuildQueue der Engine) —
-- der Beat-Waechter vergleicht dagegen.
__uiQueueCopy = {}

function SetCurrentFactoryForQueueDisplay(unit)
  __uiQueueFactory = unit or false
  if not unit then return {} end
  local q = unit:GetBuildQueue()
  -- Die Engine kopiert die Queue SOFORT in sCurrentBuildQueue (Cfile:1257076,
  -- sub_837070) — sonst meldete der naechste Beat ein Geister-Update fuer die
  -- Anzeige, die construction.lua gerade selbst aufgebaut hat.
  __uiQueueCopy = q
  return q
end

function ClearCurrentFactoryForQueueDisplay()
  __uiQueueFactory = false
end

-- === Der Queue-Waechter (Moho::UI_FactoryCommandQueueHandlerBeat) ===
--
-- CUIManager::DoBeat ruft ihn pro Sim-Beat VOR UI_LuaBeat
-- (Cfile:1273907-1273911). Er vergleicht die Warteschlange der angezeigten
-- Fabrik STRUKTURELL (id + count je Eintrag) mit der Kopie und ruft bei
-- Aenderung gamemain.OnQueueChanged(neueQueue) (Cfile:1256936-1256950).
-- Ist KEINE Fabrik mehr angezeigt, aber die Kopie noch gefuellt, feuert
-- genau einmal OnQueueChanged(nil) (Cfile:1256928-1256932).
-- Der Vergleich muss strukturell sein: der Spiegel ersetzt die Tabelle jeden
-- Beat — ein Referenzvergleich meldete zehnmal pro Sekunde eine Aenderung.
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
-- Cfile:1257189-1257270) und "DecreaseBuildCountInQueue(queueIndex, count)"
-- (Cfile:1257301-1257380): wirken auf die AKTUELL angezeigte Queue
-- (sCurrentBuildQueue[index-1], 1-basiert aus der Lua), nur auf
-- UNITCOMMAND_BuildFactory-Eintraege (Cfile:1257258-1257263), und reichen an
-- den Sim-Driver durch (ISSUE_IncreaseCommandCount Cfile:1257266 bzw.
-- DecreaseCommandCount Cfile:1257378). construction.lua:895/988-990 haengt
-- Rechtsklick (weniger) und Linksklick (mehr) daran.
--
-- Bekannte Luecke (dokumentiert, kein Raten): das Original storniert ueber
-- das Kommando-System auch den GERADE LAUFENDEN Bau; unsere Sim hat den
-- laufenden Eintrag beim Aufsetzen bereits dekrementiert — ein Decrease auf
-- Position 1 bricht den aktiven Bau (noch) nicht ab.
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

-- === Script-Bits (die Umschalter einer Unit) ===
--
-- Schild an/aus, Waffe an/aus, Stealth, Produktion … stehen als BITMASKE auf der
-- Unit (mUnitVarDat.mScriptbits). cfunc_GetScriptBitL (Cfile:1360150ff) nimmt
-- eine Unit-Liste und einen BIT-INDEX (Argument 2 ist eine Zahl), ueberspringt
-- Units, die die passende ToggleCap nicht haben ((1 << bit) & mToggleCaps), und
-- liefert den Zustand.
--
-- Die Bit-Reihenfolge ist die Registrierungs-Reihenfolge der RULEUTC-Enums
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

-- ToggleScriptBit(units, bit, value) — die UI schickt den Wunsch an die Sim
-- (dort ruft er Unit:OnScriptBitSet/OnScriptBitClear, unit.lua:309/353).
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

-- === Pause (Produktion einer Fabrik/eines Bauers anhalten) ===
--
-- cfunc_GetIsPausedL (Cfile:1359337ff, Hilfetext: "Is anyone ins this list
-- builder paused?"): true, sobald EINE lebende Unit der Liste mIsPaused traegt.
-- cfunc_SetPausedL schickt den Wunsch an die Sim — die UI setzt nichts selbst.
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

-- === Die Uhr der UI-VM ===
--
-- Die UI-VM hat KEINEN Tick-Scheduler. `userinit.lua:13-21` (die Engine laedt
-- die Datei selbst) definiert:
--
--   WaitFrames = coroutine.yield
--   function WaitSeconds(n)
--       local later = CurrentTime() + n
--       WaitFrames(1)
--       while CurrentTime() < later do WaitFrames(1) end
--   end
--
-- Ein UI-Thread wartet also auf BILDER, und `WaitSeconds` pollt die echte Uhr.
-- Deshalb ueberschreibt die UI-VM hier das Tick-basierte WaitSeconds aus
-- threads.lua (das gilt nur in der Sim). __uiTime zaehlt __mauiFrame(delta) hoch.
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

-- === Extra-Select-Liste der Session ===
--
-- Moho::CWldSession haelt eine WeakSet<UserEntity> (Cfile:29945-29947), die die
-- UI ueber drei Globals fuellt: AddToSessionExtraSelectList /
-- RemoveFromSessionExtraSelectList / ClearSessionExtraSelectList
-- (Cfile:1361771-1361788). construction.lua:924 legt dort die angehaengten
-- Einheiten ab, die zusaetzlich markiert bleiben sollen; die Weltansicht liest
-- die Liste beim Zeichnen.
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
-- cfunc_GetFireStateL (@0x8BB500, Cfile:1359840-1359898) — genau dieser Ablauf:
--
--   state = 3                      -- Sentinel "noch keiner gesehen"
--   fuer jede lebende Unit MIT RULEUCC_RetaliateToggle (mCommandCaps & 0x20):
--     state == 3          -> state = fireState der Unit
--     state ~= fireState  -> state = -1   (gemischt)
--   state == 3 (keine passende Unit) -> -1
--
-- Das 0x20 ist kein Zufall: die RULEUCC-Enums werden in fester Reihenfolge
-- registriert (Cfile:656671-656719), Bit 5 ist RULEUCC_RetaliateToggle.
--
-- Die Zustaende sind 0 = ReturnFire, 1 = HoldFire, 2 = HoldGround
-- (orders.lua:419-421); der Ctor startet mit ReturnFire (Cfile:772277).
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

-- SetFireState(units, id) — orders.lua:526 uebergibt den STRING aus
-- retaliateStateInfo ('ReturnFire'/'HoldFire'/'HoldGround'). Die Engine schickt
-- ihn als ProcessInfo an die Sim (cfunc_SetFireStateL); dort ist er ein Befehl
-- an die Unit. Bis der Befehlsweg zur Sim steht, wird der Zustand in der
-- UI-Spiegelung gefuehrt — dieselbe Stelle, an der die Engine ihn auch haelt.
local FIRE_STATE_ID = { ReturnFire = 0, HoldFire = 1, HoldGround = 2 }

function SetFireState(units, id)
  local state = FIRE_STATE_ID[id]
  if state == nil then error('SetFireState: unbekannter Zustand ' .. tostring(id), 2) end
  for _, u in ipairs(units or {}) do
    if canRetaliate(u) then u.fireState = state end
  end
  sendSim('SetFireState', units, state)
end

-- ToggleFireState(units, currentFireState) — cfunc_ToggleFireStateL: eins
-- weiter in der Runde (orders.lua:588-593 reicht den aktuellen Zustand rein).
function ToggleFireState(units, current)
  local next = (tonumber(current) or -1) + 1
  if next > 2 or next < 0 then next = 0 end
  for _, u in ipairs(units or {}) do
    if canRetaliate(u) then u.fireState = next end
  end
  sendSim('SetFireState', units, next)
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
  -- Die Oeko-Felder kommen aus dem BLUEPRINT — derselben Quelle, aus der die
  -- Sim ihre Produktion/Unterhalt registriert (units.lua __econRegister). Eine
  -- Baustelle produziert nichts (Baustellen sind fuer die Oekonomie unsichtbar).
  local bp = __blueprints[u.blueprintId]
  local eco = (bp and bp.Economy) or {}
  local fertig = (u.workProgress or 1) >= 1
  __uiRollover = {
    userUnit = u,
    blueprintId = u.blueprintId,
    -- 0-BASIERT: unitview.lua:89-90 rechnet `info.armyIndex + 1` fuer
    -- GetFocusArmy()/armiesTable — genau wie die Engine ihre Armee-Indizes
    -- 0-basiert an die Rollover-Info gibt.
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

-- === Overlays (Ansichtsfilter der WorldView) ===
-- multifunction.lua:272 schaltet damit die Karten-Overlays um. Die WorldView
-- rendert sie; bis es sie gibt, ist das reiner Zustand — aber echter Zustand,
-- kein Schweigen.
__uiOverlayFilters = {}
__uiTeamColorMode = 'FactionColor'

-- MapBorderAdd(blueprintid) (Cfile:1269840) / MapBorderClear(): der dekorative
-- KARTENRAND der Weltansicht — WorldMesh-Blueprints aus dem Skin
-- (uiutil.lua:142-158, UpdateWorldBorderState; die Option heisst
-- 'world_border'). Echter Zustand; die 3D-Seite rendert die Meshes, sobald sie
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
-- Localization.lua:43 fragt, ob es fuer die Sprache vertonte Sprachausgabe gibt,
-- und setzt danach die Audio-Sprache. Ein Audio-System gibt es noch nicht — das
-- wird hier ehrlich gesagt, statt so zu tun.
__uiAudioLanguage = 'us'
function HasLocalizedVO(la) return false end
function AudioSetLanguage(la) __uiAudioLanguage = la end

-- === Console ===
-- ConExecute/ConExecuteSave stehen in console.lua — mit einer echten
-- ConVar-Tabelle. 19 der 37 Optionen wirken ueber genau diesen Weg.

-- === Front-End: Zustand, Einstiege, Daten ===
--
-- Es gibt genau EINE UI-VM fuer die ganze Anwendung (Moho::USER_GetLuaState ist
-- ein Singleton, Cfile:1368027). Splash, Hauptmenue, Lobby und Spiel-UI laufen
-- alle darin — was wechselt, ist nur der Zustand:
--
--   UIS_none=0  UIS_splash=1  UIS_frontend=2  UIS_game=3  UIS_lobby=4
--                                              (Cfile:1262301-1262311)
__uiState = 0
local UI_STATE_NAMES = { [0] = 'none', [1] = 'splash', [2] = 'frontend', [3] = 'game', [4] = 'lobby' }

-- GetCurrentUIState (Cfile:1265924) — borders.lua:101 fragt danach.
function GetCurrentUIState()
  return UI_STATE_NAMES[__uiState]
end

-- CUIManager::SetNewLuaState: Frames neu, Zustand setzen, dann SetupUI() aus
-- der Original-uimain.lua (Cfile:1273680). SetupUI laeuft bei JEDEM Wechsel neu
-- — der Cursor haengt daran (uimain.lua:22-25).
function __uiSetNewLuaState(state)
  __mauiResetFrames()
  __uiState = state
  import('/lua/ui/uimain.lua').SetupUI()
end

-- Die duennen Lua-Wrapper um UI_StartSplashScreens (Cfile:1262357) und
-- UI_StartFrontEnd (Cfile:1262476). mHelp: "kill current UI and start ...".
function EngineStartSplashScreens()
  __uiSetNewLuaState(1)
  import('/lua/ui/uimain.lua').StartSplashScreen()
end

function EngineStartFrontEndUI()
  __uiSetNewLuaState(2)
  import('/lua/ui/uimain.lua').StartFrontEndUI()
end

-- FrontEndData legt die Engine selbst in die UI-Globals (Cfile:1268751/1268831):
-- Kampagnen-Briefing, Replay-Dateiname, ausgewaehlte Karte. Get/Set sind nur
-- Tabellenzugriffe.
FrontEndData = {}
function GetFrontEndData(key) return FrontEndData[key] end
function SetFrontEndData(key, value) FrontEndData[key] = value end

-- ClearFrame (Cfile:1264066) — alle Kinder eines Root-Frames weg.
function ClearFrame(index)
  GetFrame(index or 0):ClearChildren()
end

-- FlushEvents (Cfile:1274594): "flush mouse/keyboard events". Nach dem Aufbau
-- des Menues (main.lua:992) sollen die Klicks, die waehrend des Ladens
-- aufgelaufen sind, NICHT nachtraeglich zuschlagen. Bei uns kommen die Events
-- einzeln aus dem DOM — es gibt keine Warteschlange, die zu leeren waere; der
-- laufende Dragger aber schon.
function FlushEvents()
  __mauiDragger = false
end

-- ExitApplication (Cfile:1263877): "request that the application shut down"
-- (main.lua:980, der Exit-Knopf).
function ExitApplication()
  __uiExitRequested = true
  LOG('ExitApplication')
end

-- WorldIsLoading: wahr zwischen DoPreload (StartLoadingDialog) und
-- DoInitializing (StopLoadingDialog) — gepflegt von der Provider-Kette
-- (ui-boot.lua). uimain.lua:120 (EscapeHandler) prueft es vor jedem ESC.
__uiWorldLoading = false

function WorldIsLoading()
  return __uiWorldLoading == true
end

-- === Keymap — der CUIKeyHandler der Engine ===
--
-- Die Engine fuehrt EINE Tastenzuordnung (Taste -> KONSOLENBEFEHL, kein
-- Lua-Call): CUIKeyHandler::AddKeyMapTable (Cfile:1259176-1259264) parst jeden
-- Schluessel mit IN_ParseKeyModifiers (Cfile:1259566-1259700: Split an '-',
-- der LETZTE Token ist der Tastenname aus der keyNames-Tabelle,
-- case-insensitiv; Modifier: Shift=0x80000000, Ctrl=0x40000000,
-- Alt=0x20000000) und liest vom Wert NUR value['action'] (Pflicht-String) und
-- value['keyRepeat'] (optional) — category/order ignoriert die Engine.
-- Ausgeloest wird die Aktion vom Key-Handler unten (__uiKeyMapExecute) ueber
-- Moho::CON_Execute (Cfile:1259059).
__uiKeyMap = {}      -- Roh-Tabelle (keyString -> action-Table), fuer Remove
__uiKeyNames = {}    -- VK (Zahl) -> Anzeigename (SetKeyNameTable)
__uiKeyVks = {}      -- lower(Name) -> VK
__uiKeyActions = {}  -- (VK + Modifier-Bits) -> Konsolenbefehl-String
__uiKeyRepeatOk = {} -- (VK + Modifier-Bits) -> true (Auto-Repeat erlaubt)

-- SetKeyNameTable (Cfile:1259403-1259473): keyNames mit HEX-VK-Strings
-- (STR_Xtoi); > 0xFF gibt eine Warnung und wird verworfen.
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

-- IN_ParseKeyModifiers (Cfile:1259566-1259700): liefert den uint-Schluessel
-- oder nil (unbekannte Taste/Modifier -> Warnung, wie die Engine).
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
      -- Die Engine liest value['action'] per GetString (Pflichtfeld).
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

-- Der KEY-HANDLER hinter dem maui-Dispatch (CUIKeyHandler::sub_838D10,
-- Cfile:1258983-1259080). Er laeuft, wenn __mauiKey('KeyDown', ...) false
-- lieferte ("skipped"). Ablauf woertlich:
--   1. Existiert IRGENDEIN Fokus-Control -> sofort Skip (Cfile:1259003-1259005)
--      — ein fokussiertes Edit schaltet ALLE Hotkeys ab.
--   2. Schluessel = VK | Modifier-Bits (Cfile:1259010-1259023).
--   3. Auto-Repeat nur, wenn der Schluessel keyRepeat erlaubt (Cfile:1259049).
--   4. Treffer -> CON_Execute(action) (Cfile:1259059).
--   5. Kein Treffer: Enter -> chat.ActivateChat (nur im Spiel,
--      Cfile:1263522-1263568), '~' (maui-Code 126) -> uimain.ToggleConsole
--      (Cfile:1262747-1262777).
-- Rueckgabe: true, wenn eine Aktion lief (die Browser-Seite unterdrueckt dann
-- das Standard-Verhalten).
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
    -- Fehler in Lua, die die Engine ruft, werden geloggt, nicht geworfen
    -- (RunScript -> gpg::Warnf) — sonst risse ein fehlendes Teil (z. B. das
    -- Edit-Control des Chats) den ganzen Tasten-Handler mit.
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
-- die Engine laedt beim UI-Boot SELBST keyNames.lua (SetKeyNameTable) und
-- keymapper.GetKeyMappings() -> AddKeyMapTable — sie wartet nicht darauf,
-- dass lobby.lua es tut.
function __uiInitKeyMap()
  SetKeyNameTable(import('/lua/keymap/keyNames.lua').keyNames)
  IN_AddKeyMapTable(import('/lua/keymap/keymapper.lua').GetKeyMappings())
end

-- === Session / Umgebung ===
-- GetVersion ist ein CORE-Global (Cfile:599401) und liefert die Version der
-- ENGINE, nicht die der Spieldaten: Moho::GetEngineVersion (@0x4D3D30) ist
-- schlicht `STR_Printf("%1.1f.%i", 1.5, 3764)` — einkompiliert. Die Engine hier
-- sind wir; also sagt der String, welche Engine laeuft. __engineVersion setzt
-- der Host aus der package.json (uiEngine.ts).
function GetVersion()
  return __engineVersion or 'unbekannt'
end
function DebugFacilitiesEnabled() return false end
-- SessionIsReplay/SessionIsMultiplayer/SessionIsActive sind WEITER OBEN
-- definiert (bei den Session-Globals). Hier standen stille Zweitfassungen,
-- die die echten ueberschatteten — SessionIsMultiplayer war dadurch immer
-- false, egal wie viele Befehlsquellen die Session hat.
-- === Die SPIELZEIT — sie kommt aus der SIM, nicht aus der UI-Uhr ===
--
-- Die UI hat ihre eigene Uhr (CurrentTime, Sekunden seit Start, 60 Hz Frames);
-- die SPIELZEIT zaehlt in Sim-Ticks (10 Hz) und steht still, wenn die Sim
-- pausiert. Die Engine-Seite meldet den Tick pro Beat (__uiSetGameTick).
--
--   "string GetGameTime()" — ein FORMATIERTER String (Cfile:1266614), die
--   Engine formatiert %H:%M:%S (wxTimeSpan::Format, Cfile:1266640). score.lua
--   zeigt ihn woertlich als Uhr oben rechts (score.lua:230).
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
-- the maui substrate is built (docs/PLAN-UI.md, Schritt 2) — until then this
-- must FAIL rather than hand out a fake root that silently swallows controls.
function GetFrame(index)
  if not __uiFrames or not __uiFrames[index] then
    error('GetFrame(' .. tostring(index) .. '): kein maui-Frame — Substrat fehlt noch', 2)
  end
  return __uiFrames[index]
end
-- Ein Head = ein Root-Frame; die Engine zaehlt ab 0 (Cfile:1273621, Schleife
-- ueber die Heads). `#__uiFrames` waere hier 0, weil der einzige Eintrag der
-- Index 0 ist — uimain.lua:61 (`GetNumRootFrames() > 1` → multihead.lua) haette
-- das nie gemerkt, ein spaeterer Multihead-Test schon.
function GetNumRootFrames()
  local n = 0
  while __uiFrames[n] do n = n + 1 end
  return n
end
