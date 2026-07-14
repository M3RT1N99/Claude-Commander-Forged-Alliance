__units = {}
__nextUnitId = 1

-- KEIN Instanz-Fallback mehr. Fehlende Engine-Methoden sind nil und knallen
-- beim Aufruf — genau so soll es sein. Der frühere Feld-Stub lieferte für JEDEN
-- unbekannten Schlüssel eine (truthy!) Funktion; damit wurde in unit.lua:143
-- (self.FxDamage1Amount = self.FxDamage1Amount or damageamounts) die Stub-
-- FUNKTION statt der Zahl zugewiesen. Instanz-FELDER müssen nil bleiben.

-- Engine-Globals, die Unit-OnCreate braucht ------------------------------

-- TrashBag: Original aus trashbag.lua, sonst minimaler Ersatz.
do
  local ok, mod = pcall(import, '/lua/system/trashbag.lua')
  if ok and mod and mod.TrashBag then
    TrashBag = mod.TrashBag
  else
    TrashBag = Class() {
      Add = function(self, e) return e end,
      Destroy = function(self) end,
    }
  end
end

-- Sound{}: Blueprint-DSL-Konstruktor -> Argument zurueck
Sound = Sound or function(t) return t end

-- Scenario: Sim-Global mit den Kartendaten (Marker). Minimal leer, damit
-- OnCreate-Pfade wie GetMarkers() (scenarioutilities.lua) fehlerfrei laufen;
-- echte Marker aus der geladenen Karte kommen spaeter.
Scenario = Scenario or { MasterChain = { _MASTERCHAIN_ = { Markers = {} } }, Armies = {}, Props = {} }

-- categories / EntityCategory*: echt in engineGlobals.ts (Ausdrucksbaum über
-- die Blueprint-Categories-Liste), NICHT hier.

-- No brain/economy/navigator fallbacks here. installEconomy and installMotion
-- run earlier in the engine boot (see engine.ts) and define the real ones;
-- re-defining them here would clobber them — which silently zeroed the whole
-- economy exactly once. The engine is booted as a whole or not at all.

-- Weapons: the engine instantiates them from the blueprint, using the Lua
-- class from the unit script's Weapons table (keyed by the weapon Label).
-- Base class is Weapon from /lua/sim/Weapon.lua (Class(moho.weapon_methods)).
function __createWeapons(u, bp)
  u.__weapons = {}
  local list = bp.Weapon
  if not list then return end
  local BaseWeapon = import('/lua/sim/Weapon.lua').Weapon
  for i = 1, table.getn(list) do
    local wbp = list[i]
    local cls = BaseWeapon
    if u.Weapons and wbp.Label and u.Weapons[wbp.Label] then
      cls = u.Weapons[wbp.Label]
    end
    local w = cls(u)
    w.__bp = wbp
    w.__unit = u
    w.__index = i
    w.__army = u.__army
    w.__enabled = true
    u.__weapons[i] = w
  end
end

-- Unit spawnen: Original-Script-Klasse instanziieren + OnCreate ----------
function __spawnUnit(scriptPath, bpId, x, y, z, army, complete)
  local bp = __registered.Unit[bpId]
  if not bp then return -1, 'blueprint not registered: ' .. tostring(bpId) end
  local mod = import(scriptPath)
  local cls = mod.TypeClass
  if not cls then return -1, 'script has no TypeClass: ' .. scriptPath end

  local u = cls()
  local id = __nextUnitId
  __nextUnitId = id + 1
  u.__bp = bp
  u.__id = id
  u.__army = army
  u.__brain = __getBrain(army)
  u.__pos = { x, y, z }
  u.__heading = 0
  u.__navigator = __getNavigator(id)
  -- echte Felder (nicht der wrapInstance-Stub) für die Physik-Fortschreibung
  u.__goal = false
  u.__speed = 0
  u.__health = (bp.Defense and bp.Defense.MaxHealth) or 0
  u.__fraction = 1
  -- Engine-bereitgestellte Instanz-Felder (vor OnCreate vorhanden)
  u.Trash = TrashBag()
  __units[id] = u

  -- Blueprint-Ökonomie in die Engine-Ökonomie der Armee einklinken (Original:
  -- CEconomy im CArmyImpl; die Unit registriert Produktion/Unterhalt).
  local e = bp.Economy or {}
  __econRegister(army, id,
    e.ProductionPerSecondMass or 0, e.ProductionPerSecondEnergy or 0,
    e.MaintenanceConsumptionPerSecondMass or 0, e.MaintenanceConsumptionPerSecondEnergy or 0,
    e.StorageMass or 0, e.StorageEnergy or 0)

  -- OnPreCreate VOR OnCreate — so ruft es die Engine (Cfile: OnPreCreate
  -- @943748, danach OnCreate @944007). Dort entstehen self.Sync (SyncMeta),
  -- self.Trash und self.EventCallbacks; ohne diesen Schritt laufen spaeter
  -- z. B. DoUnitCallbacks (unit.lua:2815) ins Leere.
  local okPre, errPre = pcall(function() u:OnPreCreate() end)
  if not okPre then return id, tostring(errPre) end

  -- The engine creates one weapon object per bp.Weapon entry and binds it to
  -- the Lua class the unit script declared under that weapon's Label
  -- (uel0001_script.lua:25 declares Weapons with RightZephyr = Class(...)).
  -- GetWeapon(i) hands that object back; wep:GetBlueprint() is bp.Weapon[i].
  local okW, errW = pcall(function() __createWeapons(u, bp) end)
  if not okW then return id, tostring(errW) end

  -- OnCreate läuft als Thread (Original: Unit-Logik ist kooperativ). Der erste
  -- Slice läuft sofort (Sofort-Zustand); WaitTicks/ForkThread darin laufen auf
  -- den folgenden Beats weiter. Fallback ohne Scheduler: direkter pcall.
  local ok, err
  if __startThread then
    ok, err = __startThread(function() u:OnCreate() end)
  else
    ok, err = pcall(function() u:OnCreate() end)
  end
  if not ok then return id, tostring(err) end

  -- Fertig platzierte Units (Karten-Startunits) bekommen von der Engine direkt
  -- OnStopBeingBuilt — daher forkt jede ACU dort GiveInitialResources und die
  -- Armee erhaelt ihren Startvorrat. Baustellen bekommen das erst bei
  -- Fertigstellung (siehe __finishUnit).
  if complete ~= false then
    local ok2, err2
    if __startThread then
      ok2, err2 = __startThread(function() u:OnStopBeingBuilt(nil, u:GetCurrentLayer()) end)
    else
      ok2, err2 = pcall(function() u:OnStopBeingBuilt(nil, u:GetCurrentLayer()) end)
    end
    if not ok2 then return id, tostring(err2) end
  end
  return id, ''
end

-- Baustelle: wie __spawnUnit, aber UNFERTIG (FractionComplete 0, Health 0,
-- IsBeingBuilt) — ohne OnStopBeingBuilt. Produktion/Unterhalt bleiben inaktiv
-- bis zur Fertigstellung.
function __spawnBuildSite(scriptPath, bpId, x, y, z, army)
  local id, err = __spawnUnit(scriptPath, bpId, x, y, z, army, false)
  if id < 0 then return id, err end
  local u = __units[id]
  u.__fraction = 0
  u.__health = 0
  u.__beingBuilt = true
  __econSetComplete(army, id, false)
  return id, err
end

-- Fertigstellung einer Baustelle: die Engine setzt den Zustand und ruft dann
-- OnStopBeingBuilt auf der Unit (Original-Kette; dort schalten Gebaeude ihre
-- Produktion ein, Fabriken ihre Bau-Caps usw.).
function __finishUnit(id, builderId)
  local u = __units[id]
  if not u then return false, 'unknown unit ' .. tostring(id) end
  u.__fraction = 1
  u.__beingBuilt = false
  u.__health = u:GetMaxHealth()
  __econSetComplete(u.__army or 1, id, true)
  local builder = builderId and __units[builderId] or nil
  local ok, err
  if __startThread then
    ok, err = __startThread(function() u:OnStopBeingBuilt(builder, u:GetCurrentLayer()) end)
  else
    ok, err = pcall(function() u:OnStopBeingBuilt(builder, u:GetCurrentLayer()) end)
  end
  return ok, (ok and '' or tostring(err))
end

-- Alle Units in einem Aufruf lesen (ein Eval pro Beat für den Renderer/Worker).
-- EIN Zustandsabbild einer Unit. Frueher gab es zwei — __readUnit ohne
-- fraction/moving, __readAllUnits ohne mesh. Zwei Abbilder derselben Sache
-- laufen garantiert auseinander; wer dann welches liest, entscheidet der Zufall.
local function readRow(id, u)
  local p = u.__pos or { 0, 0, 0 }
  return {
    id = id,
    name = (u.__bp and u.__bp.BlueprintId) or '?',
    x = p[1], y = p[2], z = p[3],
    heading = u.__heading or 0,
    health = u.__health or 0,
    maxHealth = u:GetMaxHealth(),
    moving = (u.__goal ~= nil and u.__goal ~= false),
    fraction = u.__fraction or 1,
    mesh = u.__meshBp,
  }
end

function __readAllUnits()
  local out = {}
  local n = 0
  for id, u in pairs(__units) do
    n = n + 1
    out[n] = readRow(id, u)
  end
  return out
end

function __readUnit(id)
  local u = __units[id]
  if not u then return nil end
  return readRow(id, u)
end
