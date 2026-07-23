__units = {}
__nextUnitId = 1

-- NO more instance fallback. Missing engine methods are bad and bad
-- when called - that's exactly how it should be. The former field stub delivered for EVERYONE
-- unknown key a (truthy!) function; This became unit.lua:143
-- (self.FxDamage1Amount = self.FxDamage1Amount or damageamounts) the stub
-- FUNCTION assigned instead of the number. Instance FIELDS must remain nil.

-- Engine globals that Unit-OnCreate needs --------------------------------

-- TrashBag: Original from trashbag.lua, otherwise minimal replacement.
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

-- Sound{}: Blueprint DSL constructor -> return argument
Sound = Sound or function(t) return t end

-- Scenario: Sim-Global with the map data (markers). Minimally empty, so that
-- OnCreate paths such as GetMarkers() (scenarioutilities.lua) run without errors;
-- Real markers from the loaded map come later.
Scenario = Scenario or { MasterChain = { _MASTERCHAIN_ = { Markers = {} } }, Armies = {}, Props = {} }

-- categories / EntityCategory*: echt in engineGlobals.ts (Ausdrucksbaum über
-- the Blueprint Categories list), NOT here.

-- No brain/economy/navigator fallbacks here. installEconomy and installMotion
-- run earlier in the engine boot (see engine.ts) and define the real ones;
-- re-defining them here would clobber them — which silently zeroed the whole
-- economy exactly once. The engine is booted as a whole or not at all.

-- Weapons: the engine instantiates them from the blueprint, using the Lua
-- class from the unit script's Weapons table (keyed by the weapon Label).
-- Base class is Weapon from /lua/sim/Weapon.lua (Class(moho.weapon_methods)).
-- The skeleton for each blueprint is in bones.lua (__unitBones, __setBones above
-- __beginBones/__addBone/__finishBones) — with rest pose, not just names: without
-- Bone transform there is no muzzle position and therefore no projectile.

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

    -- And then the engine calls OnCreate — just like on the unit itself.
    --
    -- This is not a detail: DefaultProjectileWeapon.OnCreate ends with
    -- ChangeState(self, self.IdleState) (defaultweapons.lua:87), and only the
    -- IdleState starts the weapon's state machine. It ran without OnCreate
    -- not at all - until some later change of state triggered it.
    --
    -- Consequence: the overcharge of the ACU (IdleState.Main -> StartEconomyDrain,
    -- defaultweapons.lua:404) did not charge its 5000 energy at startup
    -- (where the starting supply covers them), but SOMETIME later - when the supply is empty
    -- Checkout. Then he demands 500 energy/tick and gets income at 2/tick
    -- a rate of 0.004, never finishes and starves every factory along the way.
    -- The order of the engine is the solution, not a special case.
    if w.OnCreate then w:OnCreate() end
  end
end

-- Spawn unit: instantiate original script class + OnCreate ----------
function __spawnUnit(scriptPath, bpId, x, y, z, army, complete)
  local bp = __registered.Unit[bpId]
  if not bp then return -1, 'blueprint not registered: ' .. tostring(bpId) end
  local mod = import(scriptPath)
  local cls = mod.TypeClass
  if not cls then return -1, 'script has no TypeClass: ' .. scriptPath end

  local u = cls()
  local id = __nextUnitId
  __nextUnitId = id + 1
  -- IsUnit(e) distinguishes the types (projectiles also have a blueprint).
  u.__isUnit = true
  u.__bp = bp
  u.__id = id
  u.__army = army
  u.__brain = __getBrain(army)
  u.__pos = { x, y, z }
  -- The skeleton from the model (see __setBones). It must be BEFORE OnCreate:
  -- the weapons test their turret bones during construction (weapon.lua:67).
  u.__bones = __unitBones[string.lower(bpId)] or { names = {}, xform = {}, index = {} }
  u.__heading = 0
  u.__navigator = __getNavigator(id)
  -- real fields (not the wrapInstance stub) for the physics update
  u.__goal = false
  u.__speed = 0
  u.__health = (bp.Defense and bp.Defense.MaxHealth) or 0
  u.__fraction = 1
  -- Build tick: the build/wreckage shaders count their age above this
  -- (mesh.fx: material.x = time - creationTime).
  u.__spawnTick = __gameTick or 0
  -- Engine-provided instance fields (exists before OnCreate)
  u.Trash = TrashBag()
  __units[id] = u

  -- Integrate blueprint economics into the army's engine economics (original:
  -- CEconomy in CARmyImpl; the unit registers production/maintenance).
  local e = bp.Economy or {}
  __econRegister(army, id,
    e.ProductionPerSecondMass or 0, e.ProductionPerSecondEnergy or 0,
    e.MaintenanceConsumptionPerSecondMass or 0, e.MaintenanceConsumptionPerSecondEnergy or 0,
    e.StorageMass or 0, e.StorageEnergy or 0,
    -- NaturalProducer exempts the unit from the production throttle
    -- (mex stall, Cfile:953936-953944) — only ACUs/sACUs carry it.
    e.NaturalProducer == true)

  -- OnPreCreate BEFORE OnCreate — this is how the engine calls it (Cfile: OnPreCreate
  -- @943748, then OnCreate @944007). This is where self.Sync (SyncMeta) is created,
  -- self.Trash and self.EventCallbacks; without this step run later
  -- e.g. B. DoUnitCallbacks (unit.lua:2815) into the void.
  local okPre, errPre = pcall(function() u:OnPreCreate() end)
  if not okPre then return id, tostring(errPre) end

  -- The engine creates one weapon object per bp.Weapon entry and binds it to
  -- the Lua class the unit script declared under that weapon's Label
  -- (uel0001_script.lua:25 declares Weapons with RightZephyr = Class(...)).
  -- GetWeapon(i) hands that object back; wep:GetBlueprint() is bp.Weapon[i].
  local okW, errW = pcall(function() __createWeapons(u, bp) end)
  if not okW then return id, tostring(errW) end

  -- OnCreate runs as a thread (original: unit logic is cooperative). The first
  -- Slice runs immediately (immediate state); WaitTicks/ForkThread in it run on
  -- the following beats. Fallback without scheduler: direct pcall.
  local ok, err
  if __startThread then
    ok, err = __startThread(function() u:OnCreate() end)
  else
    ok, err = pcall(function() u:OnCreate() end)
  end
  if not ok then return id, tostring(err) end

  -- Completely placed units (card starting units) are received directly from the engine
  -- OnStopBeingBuilt — so every ACU there forks GiveInitialResources and the
  -- Army receives its starting supplies. Construction sites only get this
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

-- Construction site: like __spawnUnit, but UNFINISHED (FractionComplete 0, Health 0,
-- IsBeingBuilt) — without OnStopBeingBuilt. Production/maintenance remains inactive
-- until completion.
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

-- Completion of a construction site: the engine sets the status and then calls
-- OnStopBeingBuilt on the unit (original chain; buildings switch theirs there
-- Production stops, factories their construction caps, etc.).
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

-- Read all units in one call (one eval per beat for the renderer/worker).
-- ONE state image of a unit. There used to be two — __readUnit without
-- fraction/moving, __readAllUnits without mesh. Two images of the same thing
-- are guaranteed to diverge; Whoever reads which one is decided by chance.
-- The unit's active order for the command graph (UICommandGraph draws
-- order lines + waypoint markers per UNITCOMMAND_*, params from
-- commandgraphparams.lua).
local function activeOrder(id, u)
  local target = __attackOrders and __attackOrders[id]
  if target then
    local t = __units[target]
    if t and t.__pos then return 'Attack', t.__pos[1], t.__pos[3] end
  end
  for _, task in pairs(__buildTasks or {}) do
    if task.builder == id then
      local t = __units[task.target]
      if t and t.__pos then
        -- BuildMobile and Repair share the engineering colors; the repair
        -- waypoint texture is the BuildMobile one (commandgraphparams:140-144).
        return (task.order == 'Repair') and 'Repair' or 'BuildMobile', t.__pos[1], t.__pos[3]
      end
    end
  end
  if u.__goal then return 'Move', u.__goal[1], u.__goal[2] end
  return nil
end

-- The FULL order list for the command graph: the active order first, then
-- the queued commands (__orders FIFO) with entity targets resolved to
-- their CURRENT position — the original graph tracks entity targets live
-- (DirtyCommandGraph re-tesselation).
local function orderList(id, u)
  local out = nil
  local ot, ox, oz = activeOrder(id, u)
  if ot then out = { { t = ot, x = ox, z = oz } } end
  for _, cmd in ipairs((__orders and __orders[id]) or {}) do
    local x, z
    if cmd.type == 'Move' then
      x, z = cmd.x, cmd.z
    else
      local t = __units[cmd.target]
      if t and t.__pos then x, z = t.__pos[1], t.__pos[3] end
    end
    if x then
      out = out or {}
      out[#out + 1] = { t = cmd.type, x = x, z = z }
    end
  end
  return out
end

-- Turret bone angles for the renderer (CAimManipulator state, advanced in
-- weapons.lua aimTick): yaw/pitch relative to the rest pose per aim bone.
local function readTurrets(u)
  local out = nil
  for _, w in ipairs(u.__weapons or {}) do
    local aim = w.__aim
    if aim and not aim.__destroyed and aim.__yawBone
      and (math.abs(aim.__yaw or 0) > 0.0001 or math.abs(aim.__pitch or 0) > 0.0001) then
      out = out or {}
      out[#out + 1] = {
        b = aim.__yawBone, y = aim.__yaw or 0,
        pb = aim.__pitchBone, p = aim.__pitch or 0,
      }
    end
  end
  return out
end

local function readRow(id, u)
  local p = u.__pos or { 0, 0, 0 }
  local moving = (u.__goal ~= nil and u.__goal ~= false)
  return {
    orders = orderList(id, u),
    turrets = readTurrets(u),
    id = id,
    name = (u.__bp and u.__bp.BlueprintId) or '?',
    x = p[1], y = p[2], z = p[3],
    heading = u.__heading or 0,
    health = u.__health or 0,
    maxHealth = u:GetMaxHealth(),
    moving = moving,
    fraction = u.__fraction or 1,
    born = u.__spawnTick or 0,
    mesh = u.__meshBp,
    army = u.__army or 1,
    -- "idle" in the sense of the engine (the idle sets on UserArmy, Cfile:1352334-1352374,
    -- are maintained from the TASK state): no movement target, no running
    -- or waiting construction order, no factory production - and a CONSTRUCTION SITE
    -- is not idle, it is not even in operation yet. A building one
    -- Engineer stands still and is still NOT idle.
    idle = not moving
      and (u.__fraction or 1) >= 1
      and not __builderBusy(id)
      and (u.__buildQueue == nil or u.__buildQueue[1] == nil),
    -- A factory's build queue ({ id, count }) — the UI displays it
    -- (construction.lua:1620), so it belongs to the status that the sim reports.
    buildQueue = u.__buildQueue or {},
  }
end

-- The unit state as a JSON STRING.
--
-- The same trap as with the Maui snapshot: a return value from Lua to JS remains
-- hangs in the wasmoon registry and is never collected. The worker reads it
-- Condition TEN TIMES PER SECOND — the Sim VM would slowly but surely fill up.
-- That's why Lua passes a string to a JS function (LuaHost.pull) instead
-- to return a table.
local function jstr(s)
  s = tostring(s)
  s = string.gsub(s, '\\', '\\\\')
  s = string.gsub(s, '"', '\\"')
  return '"' .. s .. '"'
end

local function jnum(v)
  return string.format('%.6g', v or 0)
end

function __readAllUnitsJson()
  local parts = {}
  local n = 0
  for id, u in pairs(__units) do
    local r = readRow(id, u)
    local q = {}
    for i, item in ipairs(r.buildQueue) do
      q[i] = '{"id":' .. jstr(item.id) .. ',"count":' .. jnum(item.count) .. '}'
    end
    n = n + 1
    parts[n] = '{"id":' .. jnum(r.id)
      .. ',"name":' .. jstr(r.name)
      .. ',"x":' .. jnum(r.x) .. ',"y":' .. jnum(r.y) .. ',"z":' .. jnum(r.z)
      .. ',"heading":' .. jnum(r.heading)
      .. ',"health":' .. jnum(r.health)
      .. ',"maxHealth":' .. jnum(r.maxHealth)
      .. ',"moving":' .. tostring(r.moving)
      .. ',"fraction":' .. jnum(r.fraction)
      .. ',"born":' .. jnum(r.born)
      .. (function()
        -- The whole command queue (head first) for the command graph;
        -- 'order' stays as the head alias for existing consumers.
        if not r.orders then return '' end
        local os = {}
        for oi, o in ipairs(r.orders) do
          os[oi] = '{"t":' .. jstr(o.t) .. ',"x":' .. jnum(o.x) .. ',"z":' .. jnum(o.z) .. '}'
        end
        return ',"order":' .. os[1] .. ',"orders":[' .. table.concat(os, ',') .. ']'
      end)()
      .. (function()
        if not r.turrets then return '' end
        local ts = {}
        for ti, t in ipairs(r.turrets) do
          ts[ti] = '{"b":' .. jstr(t.b) .. ',"y":' .. jnum(t.y)
            .. (t.pb and (',"pb":' .. jstr(t.pb) .. ',"p":' .. jnum(t.p)) or '')
            .. '}'
        end
        return ',"turrets":[' .. table.concat(ts, ',') .. ']'
      end)()
      .. ',"army":' .. jnum(r.army)
      .. ',"idle":' .. tostring(r.idle)
      .. ',"buildQueue":[' .. table.concat(q, ',') .. ']'
      .. '}'
  end
  return '[' .. table.concat(parts, ',') .. ']'
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
