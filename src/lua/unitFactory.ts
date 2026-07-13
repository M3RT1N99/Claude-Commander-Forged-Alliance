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
  u.__brain = {}
  u.__pos = { x, y, z }
  u.__heading = 0
  u.__health = (bp.Defense and bp.Defense.MaxHealth) or 0
  u.__fraction = 1
  -- Engine-bereitgestellte Instanz-Felder (vor OnCreate vorhanden)
  u.Trash = TrashBag()
  __units[id] = u

  local ok, err = pcall(function() u:OnCreate() end)
  return id, (ok and '' or tostring(err))
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

let setupDone = false

export function installUnitFactory(host: LuaHost): void {
  if (setupDone) return
  host.eval(SETUP_LUA)
  setupDone = true
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
