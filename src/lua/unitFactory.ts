import type { LuaHost } from './host'

/**
 * Spawnt Units über die Original-Lua-Klassen und exponiert ihren Zustand für
 * Renderer/Sim. Eine Unit entsteht wie in der Engine:
 *   `units/<id>/<id>_script.lua` setzt `TypeClass = <Klasse>` (leitet von den
 *   Fraktions-/Default-Klassen bis `moho.unit_methods` ab). Wir instanziieren
 *   TypeClass, setzen den Engine-Zustand (Blueprint, Position, Health) und
 *   rufen `OnCreate` — reines Original-Verhalten.
 *
 * Der Zustand liegt in Instanz-Feldern (`self.__pos` etc., siehe moho.ts).
 * `readUnit` liefert einen flachen Snapshot für die TS-Seite.
 */

export interface LuaUnitState {
  id: number
  name: string
  x: number
  y: number
  z: number
  heading: number
  health: number
  maxHealth: number
  /** Mesh-Blueprint-ID, falls das Skript SetMesh gerufen hat */
  mesh: string | null
}

const SETUP_LUA = `
__units = {}
__nextUnitId = 1
__missingMethods = {}
local __missingStub = function() end

-- Instanz-Fallback: nicht implementierte Engine-Methoden werden zu
-- aufgezeichneten No-Op-Stubs. Klassen-Methoden (inkl. moho-Overrides) haben
-- Vorrang; getmetatable(u) bleibt die Klasse (__metatable), damit die
-- Klassen-Semantik intakt bleibt.
local function wrapInstance(u)
  local cls = getmetatable(u)
  setmetatable(u, {
    __metatable = cls,
    __index = function(_, k)
      local v = cls[k]
      if v ~= nil then return v end
      if type(k) == 'string' then __missingMethods[k] = true end
      return __missingStub
    end,
    __newindex = function(t, k, val) rawset(t, k, val) end,
  })
  return u
end

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

-- categories: FAs magisches Global; categories.X liefert ein EntityCategory,
-- das +/-/* unterstuetzt. Fuer den Lifecycle reicht, dass die Ausdruecke
-- fehlerfrei evaluieren (echtes Category-Matching kommt spaeter).
local __catMeta
__catMeta = {
  __add = function() return setmetatable({}, __catMeta) end,
  __sub = function() return setmetatable({}, __catMeta) end,
  __mul = function() return setmetatable({}, __catMeta) end,
}
categories = setmetatable({}, {
  __index = function(t, k)
    local c = setmetatable({ __cat = k }, __catMeta)
    rawset(t, k, c)
    return c
  end,
})

-- Brain + Economy-Hooks: echte Default-Funktionen (installEconomy
-- überschreibt sie). Als echte Globals werden sie NICHT vom Stub-Trap als
-- Identitätsfunktion geschattet — sonst würde z. B. __getBrain(army) die Zahl
-- army liefern und self:GetAIBrain() eine Zahl statt einer Tabelle sein.
__brains = {}
function __getBrain(army)
  local b = __brains[army]
  if not b then
    b = { __army = army, GetArmyIndex = function() return army end }
    __brains[army] = b
  end
  return b
end
function __econRegister() end
function __econSetActive() end
-- Default-Navigator (installMotion überschreibt ihn); echt definiert, damit der
-- Stub-Trap ihn nicht zur Identität (Zahl) macht.
function __getNavigator(id)
  return {
    SetGoal = function() end, AbortMove = function() end,
    AtGoal = function() return true end, GetGoalPos = function() end,
  }
end

-- Unit spawnen: Original-Script-Klasse instanziieren + OnCreate ----------
function __spawnUnit(scriptPath, bpId, x, y, z, army)
  local bp = __registered.Unit[bpId]
  if not bp then return -1, 'blueprint not registered: ' .. tostring(bpId) end
  local mod = import(scriptPath)
  local cls = mod.TypeClass
  if not cls then return -1, 'script has no TypeClass: ' .. scriptPath end

  local u = wrapInstance(cls())
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

  -- OnCreate läuft als Thread (Original: Unit-Logik ist kooperativ). Der erste
  -- Slice läuft sofort (Sofort-Zustand); WaitTicks/ForkThread darin laufen auf
  -- den folgenden Beats weiter. Fallback ohne Scheduler: direkter pcall.
  local ok, err
  if __startThread then
    ok, err = __startThread(function() u:OnCreate() end)
  else
    ok, err = pcall(function() u:OnCreate() end)
  end
  return id, (ok and '' or tostring(err))
end

-- Alle Units in einem Aufruf lesen (ein Eval pro Beat für den Renderer/Worker).
function __readAllUnits()
  local out = {}
  local n = 0
  for id, u in pairs(__units) do
    local p = u.__pos or { 0, 0, 0 }
    n = n + 1
    out[n] = {
      id = id,
      name = (u.__bp and u.__bp.BlueprintId) or '?',
      x = p[1], y = p[2], z = p[3],
      heading = u.__heading or 0,
      health = u.__health or 0,
      maxHealth = u:GetMaxHealth(),
      moving = (u.__goal ~= nil and u.__goal ~= false),
    }
  end
  return out
end

function __readUnit(id)
  local u = __units[id]
  if not u then return nil end
  local p = u.__pos or { 0, 0, 0 }
  return {
    id = id,
    name = (u.__bp and u.__bp.BlueprintId) or '?',
    x = p[1], y = p[2], z = p[3],
    heading = u.__heading or 0,
    health = u.__health or 0,
    maxHealth = u:GetMaxHealth(),
    mesh = u.__meshBp,
  }
end
`

export function installUnitFactory(host: LuaHost): void {
  host.eval(SETUP_LUA)
}

/**
 * Richtet die Original-Blueprint-Pipeline ein (Collectors, DiskFindFiles über
 * `__bpFiles`, `Blueprints.lua`). Danach registriert `loadUnitBlueprint`
 * einzelne Blueprints über die echte `LoadBlueprints()`.
 */
export function installBlueprintPipeline(host: LuaHost): void {
  host.eval(`
    __active_mods = {}
    __registered = { Unit={}, Mesh={}, Prop={}, Projectile={}, Emitter={}, TrailEmitter={}, Beam={} }
    local function collector(g) return function(bp) __registered[g][bp.BlueprintId or '?'] = bp end end
    -- Unit-Blueprints: Default-Sektionen ergaenzen (Engine-Nachbearbeitung).
    -- Unit.lua greift ungeprueft auf bp.Intel/... zu; nicht alle .bp haben sie.
    function RegisterUnitBlueprint(bp)
      bp.Intel = bp.Intel or {}
      __registered.Unit[bp.BlueprintId or '?'] = bp
    end
    RegisterMeshBlueprint=collector('Mesh')
    RegisterPropBlueprint=collector('Prop'); RegisterProjectileBlueprint=collector('Projectile')
    RegisterEmitterBlueprint=collector('Emitter'); RegisterTrailEmitterBlueprint=collector('TrailEmitter')
    RegisterBeamBlueprint=collector('Beam')
    function BlueprintLoaderUpdateProgress() end
    __bpFiles = {}
    function DiskFindFiles(dir, pattern)
      local out = {}
      for _, f in ipairs(__bpFiles) do
        if string.find(f, dir, 1, true) == 1 then out[#out+1] = f end
      end
      return out
    end
  `)
  host.loadGlobal('/lua/system/Blueprints.lua')
}

/**
 * Registriert ein einzelnes Unit-Blueprint über die echte Pipeline
 * (`LoadBlueprints`), sofern noch nicht geschehen. `bpBytes` = Inhalt der
 * `units/<id>/<id>_unit.bp`.
 */
export function loadUnitBlueprint(host: LuaHost, id: string, bpBytes: Uint8Array): void {
  const already = host.eval(`return __registered.Unit['${id.toLowerCase()}'] ~= nil`)
  if (already === true) return
  const path = `units/${id}/${id}_unit.bp`
  host.addFile(path, bpBytes)
  host.eval(`__bpFiles = { '/${path}' }; LoadBlueprints()`)
}

/** Spawnt eine Unit über ihre Original-Klasse; liefert Unit-ID oder wirft. */
export function spawnLuaUnit(
  host: LuaHost,
  blueprintId: string,
  pos: { x: number; y: number; z: number },
  army = 1,
): number {
  const scriptPath = `/units/${blueprintId}/${blueprintId}_script.lua`
  const res = host.eval(
    `local id, err = __spawnUnit(${JSON.stringify(scriptPath)}, ${JSON.stringify(
      blueprintId,
    )}, ${pos.x}, ${pos.y}, ${pos.z}, ${army}); return { id = id, err = err }`,
  ) as { id: number; err: string }
  if (res.err) throw new Error(`spawn ${blueprintId}: ${res.err}`)
  return res.id
}

/** Liest den aktuellen Zustand einer gespawnten Lua-Unit. */
export function readLuaUnit(host: LuaHost, id: number): LuaUnitState | null {
  return host.eval(`return __readUnit(${id})`) as LuaUnitState | null
}
