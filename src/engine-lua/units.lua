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
-- Das Skelett je Blueprint liegt in bones.lua (__unitBones, __setBones ueber
-- __beginBones/__addBone/__finishBones) — mit Ruhepose, nicht nur Namen: ohne
-- Knochen-Transform gibt es keine Muendungsposition und damit kein Projektil.

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
    -- UnitWeapon starts with no valid target layers. Weapon.OnCreate selects
    -- the blueprint mask for the unit's current layer.
    w.__fireTargetLayerCaps = 'None'
    u.__weapons[i] = w

    -- Und dann ruft die Engine OnCreate — genau wie auf der Unit selbst.
    --
    -- Das ist kein Detail: DefaultProjectileWeapon.OnCreate endet mit
    -- ChangeState(self, self.IdleState) (defaultweapons.lua:87), und erst der
    -- IdleState startet die Zustandsmaschine der Waffe. Ohne OnCreate lief sie
    -- gar nicht — bis irgendein spaeterer Zustandswechsel sie doch anwarf.
    --
    -- Folge: der Overcharge der ACU (IdleState.Main -> StartEconomyDrain,
    -- defaultweapons.lua:404) lud seine 5000 Energie nicht beim Start auf
    -- (wo der Startvorrat sie deckt), sondern IRGENDWANN spaeter — bei leerer
    -- Kasse. Dann fordert er 500 Energie/Tick, bekommt bei 2/Tick Einkommen
    -- eine Rate von 0.004, wird nie fertig und verhungert nebenbei jede Fabrik.
    -- Die Reihenfolge der Engine ist die Loesung, nicht ein Sonderfall.
    if w.OnCreate then w:OnCreate() end
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
  -- IsUnit(e) unterscheidet die Arten (Projektile haben auch ein Blueprint).
  u.__isUnit = true
  u.__bp = bp
  u.__id = id
  u.__army = army
  u.__brain = __getBrain(army)
  u.__pos = { x, y, z }
  -- The native unit supplies this legacy field before Weapon.OnCreate, which
  -- uses it to select FireTargetLayerCapsTable[unit.Layer]. Air blueprints
  -- begin in the Air layer; all other motion types start in this model's
  -- existing Land layer until layer transitions are simulated.
  u.Layer = ((bp.Physics or {}).MotionType == 'RULEUMT_Air') and 'Air' or 'Land'
  -- Das Skelett aus dem Modell (siehe __setBones). Es muss VOR OnCreate stehen:
  -- die Waffen pruefen ihre Turm-Knochen beim Aufbau (weapon.lua:67).
  u.__bones = __unitBones[string.lower(bpId)] or { names = {}, xform = {}, index = {} }
  u.__heading = 0
  u.__navigator = __getNavigator(id)
  -- echte Felder (nicht der wrapInstance-Stub) für die Physik-Fortschreibung
  u.__goal = false
  u.__speed = 0
  u.__health = (bp.Defense and bp.Defense.MaxHealth) or 0
  u.__fraction = 1
  -- Erstellungs-Tick: die Build-/Wreckage-Shader zaehlen ihr Alter darueber
  -- (mesh.fx: material.x = time - creationTime).
  u.__spawnTick = __gameTick or 0
  -- Engine-bereitgestellte Instanz-Felder (vor OnCreate vorhanden)
  u.Trash = TrashBag()
  __units[id] = u

  -- Install the command-cap bindings up front (seeded from the blueprint mask)
  -- so a script's OnCreate/OnStopBeingBuilt can already call AddCommandCap/
  -- RemoveCommandCap. Without this they hit the withNoops stub until the first
  -- readRow beat and the cap change is silently lost
  -- (globals.lua __ensureCommandCapMask; UnitAttributes init Cfile:949126).
  __ensureCommandCapMask(u)

  -- Blueprint-Ökonomie in die Engine-Ökonomie der Armee einklinken (Original:
  -- CEconomy im CArmyImpl; die Unit registriert Produktion/Unterhalt).
  local e = bp.Economy or {}
  __econRegister(army, id,
    e.ProductionPerSecondMass or 0, e.ProductionPerSecondEnergy or 0,
    e.MaintenanceConsumptionPerSecondMass or 0, e.MaintenanceConsumptionPerSecondEnergy or 0,
    e.StorageMass or 0, e.StorageEnergy or 0,
    -- NaturalProducer exempts the unit from the production throttle
    -- (mex stall, Cfile:953936-953944) — only ACUs/sACUs carry it.
    e.NaturalProducer == true)

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
    -- The engine tells an immobile unit and its neighbours about each other
    -- right after creation (Cfile:950616-950645).
    __notifyAdjacent(id)
  end
  return id, ''
end

-- === Creating units from Lua ===
--
-- CreateUnit(blueprint, army, tx, ty, tz, qx, qy, qz, qw, [layer])
-- (cfunc_CreateUnitL, Cfile:980268, help text Cfile:980258). The engine checks
-- the blueprint ("Unknown unit kind: %s", Cfile:980337) and the army index
-- ("Invalid army index; must be >= 1 and < %d", Cfile:980352), builds
-- SUnitConstructionParams(layer, pos, army, bp, creator = 0, complete = 1) from
-- them and calls Sim::CreateUnit — the unit comes into being COMPLETE, not as
-- a construction site (Cfile:980435-980444). It returns the unit; if creation
-- fails the engine throws "CreateUnit(%s) failed".
--
-- Callers in the original: effectutilities.lua:436 (SpawnBuildBots — the
-- Cybran build drones), scenarioframework, terranunits.lua (build pods).
local function spawnCreateUnit(blueprint, army, x, y, z, heading, who)
  local key = type(blueprint) == 'string' and string.lower(blueprint) or nil
  local bp = key and __registered and __registered.Unit[key]
  if not bp then error('Unknown unit kind: ' .. tostring(blueprint), 3) end
  if type(army) ~= 'number' or army < 1 then
    error('Invalid army index; must be >= 1 but got ' .. tostring(army), 3)
  end
  local scriptPath = bp.Script or ('/units/' .. key .. '/' .. key .. '_script.lua')
  local id, err = __spawnUnit(scriptPath, key, x, y, z, army, true)
  if id < 0 then error(who .. '(' .. tostring(blueprint) .. ') failed: ' .. tostring(err), 3) end
  local u = __units[id]
  u.__heading = heading or 0
  return u
end

--- The yaw from a quaternion (the engine hands out orientations as
--- quaternions, GetOrientation -> {x, y, z, w}).
local function headingFromQuat(qx, qy, qz, qw)
  qx, qy, qz, qw = qx or 0, qy or 0, qz or 0, qw or 1
  return math.atan(2 * (qw * qy + qx * qz), 1 - 2 * (qy * qy + qz * qz))
end

function CreateUnit(blueprint, army, tx, ty, tz, qx, qy, qz, qw, layer)
  return spawnCreateUnit(blueprint, army, tx, ty, tz, headingFromQuat(qx, qy, qz, qw), 'CreateUnit')
end

--- CreateUnitHPR(blueprint, army, x, y, z, pitch, yaw, roll) — Cfile:980475.
--- The same creation, only with Euler angles instead of a quaternion.
function CreateUnitHPR(blueprint, army, x, y, z, pitch, yaw, roll)
  return spawnCreateUnit(blueprint, army, x, y, z, yaw or 0, 'CreateUnitHPR')
end

--- CreateUnit2(blueprint, army, layer, x, z, heading) — Cfile:980637. The
--- height comes from the terrain (the signature has no y).
function CreateUnit2(blueprint, army, layer, x, z, heading)
  return spawnCreateUnit(blueprint, army, x, GetSurfaceHeight(x, z), z, heading, 'CreateUnit2')
end

-- === Adjacency (Moho::Unit::CollectAllOverlapping, Cfile:62d460) ===
--
-- When an immobile unit comes into being — created complete (Cfile:950616) or
-- finished by a build task (Materialize, Cfile:953548) — the engine collects
-- every overlapping structure and runs the Lua callback on BOTH sides:
--
--   new:OnAdjacentTo(other, new)      Cfile:953563
--   other:OnAdjacentTo(new,   new)    Cfile:953568
--
-- That is where FA's adjacency bonuses come from: StructureUnit.OnAdjacentTo
-- (defaultunits.lua:357) looks up bp.Adjacency in AdjacencyBuffs and applies
-- every buff of that table to the neighbour. Without the callback a power
-- generator next to a factory does nothing at all — one of the game's core
-- mechanics was missing.

--- The ENGINE's skirt rect (Moho::RUnitBlueprint::GetSkirtRect, Cfile:51ec50).
--- NOT the same as the Lua one in unit.lua:240: the engine TRUNCATES the lower
--- corner to whole ogrids (grid alignment) and falls back to the footprint when
--- a skirt size is 0.
local function skirtRect(u)
  local bp = u.__bp or {}
  local fp = bp.Footprint or {}
  local phys = bp.Physics or {}
  local p = u.__pos or { 0, 0, 0 }
  local fpX = fp.SizeX or 0
  local fpZ = fp.SizeZ or 0
  -- (int) truncates toward zero; map coordinates are positive.
  local xLower = math.floor(p[1] - fpX * 0.5)
  local zLower = math.floor(p[3] - fpZ * 0.5)
  local x0, x1, z0, z1
  if (phys.SkirtSizeX or 0) == 0 then
    x0, x1 = xLower, xLower + fpX
  else
    x0 = xLower + (phys.SkirtOffsetX or 0)
    x1 = x0 + phys.SkirtSizeX
  end
  if (phys.SkirtSizeZ or 0) == 0 then
    z0, z1 = zLower, zLower + fpZ
  else
    z0 = zLower + (phys.SkirtOffsetZ or 0)
    z1 = z0 + phys.SkirtSizeZ
  end
  return x0, z0, x1, z1
end

--- Moho::Unit::OverlapsWith (Cfile:62d2b0) — two skirts count as adjacent when
--- they TOUCH on one axis (edge distance < 1 ogrid) and one of them CONTAINS
--- the other on the other axis. That containment rule is why FA's adjacency is
--- so picky about alignment.
local function overlapsWith(a, b)
  local ax0, az0, ax1, az1 = skirtRect(a)
  local bx0, bz0, bx1, bz1 = skirtRect(b)
  local touchX = math.abs(ax0 - bx1) < 1 or math.abs(ax1 - bx0) < 1
  if not touchX then
    -- Not touching along X: then they must touch along Z and overlap in X.
    local touchZ = math.abs(az0 - bz1) < 1 or math.abs(az1 - bz0) < 1
    if not touchZ then return false end
    if ax0 >= bx0 and bx1 >= ax1 then return true end
    if bx0 >= ax0 and ax1 >= bx1 then return true end
    return false
  end
  -- Touching along X: they must contain each other along Z.
  if az0 >= bz0 and bz1 >= az1 then return true end
  if bz0 >= az0 and az1 >= bz1 then return true end
  return false
end

local function immobile(u)
  return ((u.__bp and u.__bp.Physics and u.__bp.Physics.MotionType) or 'RULEUMT_None') == 'RULEUMT_None'
end

--- Every structure of the same army whose skirt overlaps this one's.
--- Filter per Cfile:62d56a-62d5be: alive, IMMOBILE, SAME ARMY, not itself,
--- same layer, within 20 ogrids, and OverlapsWith.
local function overlappingNeighbours(id, u)
  local out = {}
  local p = u.__pos or { 0, 0, 0 }
  for oid, o in pairs(__units) do
    if oid ~= id and not o.__dead and not o.__destroyQueued and immobile(o)
      and (o.__army or 1) == (u.__army or 1) and o.Layer == u.Layer then
      local q = o.__pos or { 0, 0, 0 }
      local dx, dz = q[1] - p[1], q[3] - p[3]
      -- The engine's spatial query uses a 20 ogrid radius (Cfile:62d4f9).
      if dx * dx + dz * dz <= 400 and overlapsWith(u, o) then
        out[table.getn(out) + 1] = o
      end
    end
  end
  return out
end

--- Tell a freshly completed structure and its neighbours about each other
--- (Cfile:953563/953568). The second argument is the TRIGGERING unit in both
--- calls — the one that just came into being.
function __notifyAdjacent(id)
  local u = __units[id]
  if not u or u.__dead or u.__destroyQueued or not immobile(u) then return end
  for _, o in ipairs(overlappingNeighbours(id, u)) do
    local ok, err = pcall(function() u:OnAdjacentTo(o, u) end)
    if not ok then WARN('OnAdjacentTo: ' .. tostring(err)) end
    local ok2, err2 = pcall(function() o:OnAdjacentTo(u, u) end)
    if not ok2 then WARN('OnAdjacentTo: ' .. tostring(err2)) end
  end
end

--- The counterpart when a structure DIES (Cfile:952133-952162): if it is
--- immobile and was NOT still under construction, both sides get
--- `OnNotAdjacentTo(other)` — one argument, not two (defaultunits.lua:372).
--- That is what REMOVES the adjacency buffs again; without it a destroyed
--- power generator kept boosting its neighbour forever.
function __notifyNotAdjacent(id)
  local u = __units[id]
  if not u or not immobile(u) or u.__beingBuilt then return end
  for _, o in ipairs(overlappingNeighbours(id, u)) do
    local ok, err = pcall(function() u:OnNotAdjacentTo(o) end)
    if not ok then WARN('OnNotAdjacentTo: ' .. tostring(err)) end
    local ok2, err2 = pcall(function() o:OnNotAdjacentTo(u) end)
    if not ok2 then WARN('OnNotAdjacentTo: ' .. tostring(err2)) end
  end
end

-- Baustelle: wie __spawnUnit, aber UNFERTIG (FractionComplete 0, Health 0,
-- IsBeingBuilt) — ohne OnStopBeingBuilt. Produktion/Unterhalt bleiben inaktiv
-- bis zur Fertigstellung.
function __spawnBuildSite(scriptPath, bpId, x, y, z, army, builderId, order)
  local id, err = __spawnUnit(scriptPath, bpId, x, y, z, army, false)
  if id < 0 then return id, err end
  local u = __units[id]
  u.__fraction = 0
  u.__health = 0
  u.__beingBuilt = true
  __econSetComplete(army, id, false)
  if builderId then __startBuildSite(id, builderId, order) end
  return id, err
end

--- Unit::Materialize calls the target callback once when the construction site
--- is created (Cfile:950553-950593). Later helpers receive only OnStartBuild.
function __startBuildSite(id, builderId, order)
  local u = __units[id]
  local builder = __units[builderId]
  if not u or not builder or u.__startBeingBuilt then return false end
  u.__startBeingBuilt = true
  pcall(function() u:OnStartBeingBuilt(builder, order or 'MobileBuild') end)
  return true
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
  -- Materialize runs the adjacency scan once the unit is complete
  -- (Cfile:953548-953576).
  __notifyAdjacent(id)
  return ok, (ok and '' or tostring(err))
end

-- Alle Units in einem Aufruf lesen (ein Eval pro Beat für den Renderer/Worker).
-- EIN Zustandsabbild einer Unit. Frueher gab es zwei — __readUnit ohne
-- fraction/moving, __readAllUnits ohne mesh. Zwei Abbilder derselben Sache
-- laufen garantiert auseinander; wer dann welches liest, entscheidet der Zufall.
-- The unit's active order for the command graph (UICommandGraph draws
-- order lines + waypoint markers per UNITCOMMAND_*, params from
-- commandgraphparams.lua).
local function activeOrder(id, u)
  local target = __attackOrders and __attackOrders[id]
  if target then
    if type(target) == 'table' then
      -- Ground attack: the position IS the target (AITARGET_Ground).
      return 'Attack', target[1], target[3]
    end
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
    if cmd.type == 'Move' or cmd.type == 'Patrol' then
      x, z = cmd.x, cmd.z
    elseif cmd.gx then
      x, z = cmd.gx, cmd.gz -- queued ground attack
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
    -- Fire state mirror for the user side (SUnitVarDat.mFireState is part of
    -- the per-unit sync block, ctor Cfile:772277). The sim itself never
    -- changes it — only the SetFireState user command does.
    fireState = u.__fireState or 0,
    -- The guarded unit id (mUnit->mGuardedUnit, task-synced Cfile:839316) —
    -- feeds GetGuardedEntity/GetAssistingUnitsList in the user mirror.
    guard = u.__guardedUnit or 0,
    -- The effective command-cap mask (UnitAttributes::commandCapsMask:
    -- blueprint-initialized, mutated by Add/RemoveCommandCap, faf-re
    -- Unit.cpp:8675-8813). Synced per beat so the UI mirror follows
    -- runtime cap changes instead of freezing at the blueprint state.
    caps = __ensureCommandCapMask(u),
    -- Shield strength ratio (0..1), fed by shield.lua UpdateShieldRatio ->
    -- Unit:SetShieldRatio (moho). The UI mirror shows it (GetShieldRatio; the
    -- rollover shield bar, unitview.lua).
    shieldRatio = u.__shieldRatio or 0,
    -- WorkProgress (mUnitVarDat.mWorkProgress): what this unit is working on,
    -- written by the build task every tick (Cfile:815482) and by Lua for
    -- enhancements (unit.lua:3579). The UI shows exactly this
    -- (construction.lua:380 GetWorkProgress) — for an upgrading structure it is
    -- the progress of its successor.
    workProgress = u.__workProgress or 0,
    -- UNITSTATE_BeingUpgraded (37) — the successor growing on top of a
    -- structure. The drag box skips it (Cfile:1290062), so the box keeps
    -- selecting the working original.
    beingUpgraded = u:IsUnitState('BeingUpgraded'),
    born = u.__spawnTick or 0,
    mesh = u.__meshBp,
    army = u.__army or 1,
    -- Death mirror: a unit lingers in __units through its multi-beat death
    -- sequence (Kill -> OnKilled thread -> Destroy), so readRow still sends it.
    -- Without this flag __uiSetUnit marks it alive (u.dead = false) and
    -- SelectUnits/avatars/ValidateUnitsList would keep a dying unit selectable —
    -- the engine excludes IsDead AND DestroyQueued (Cfile:1361497-1361498).
    dead = (u.__dead == true) or (u.__destroyQueued == true),
    -- „idle" im Sinn der Engine (die Idle-Sets am UserArmy, Cfile:1352334-1352374,
    -- werden aus dem TASK-Zustand gepflegt): kein Bewegungsziel, kein laufender
    -- oder wartender Bau-Auftrag, keine Fabrik-Produktion — und eine BAUSTELLE
    -- ist nicht leerlaufend, sie ist noch gar nicht in Betrieb. Ein bauender
    -- Ingenieur steht still und ist trotzdem NICHT idle.
    idle = not moving
      and (u.__fraction or 1) >= 1
      and not __builderBusy(id)
      and (u.__buildQueue == nil or u.__buildQueue[1] == nil),
    -- Die Bau-Warteschlange einer Fabrik ({ id, count }) — die UI zeigt sie an
    -- (construction.lua:1620), also gehoert sie in den Zustand, den die Sim meldet.
    buildQueue = u.__buildQueue or {},
  }
end

-- Der Unit-Zustand als JSON-STRING.
--
-- Dieselbe Falle wie beim maui-Snapshot: ein Rueckgabewert aus Lua nach JS bleibt
-- im wasmoon-Registry haengen und wird nie eingesammelt. Der Worker liest den
-- Zustand ZEHNMAL PRO SEKUNDE — die Sim-VM wuerde langsam aber sicher volllaufen.
-- Deshalb uebergibt Lua einen String an eine JS-Funktion (LuaHost.pull), statt
-- eine Tabelle zurueckzugeben.
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
      .. ',"fireState":' .. jnum(r.fireState)
      .. ',"guard":' .. jnum(r.guard)
      .. ',"caps":' .. jnum(r.caps)
      .. ',"dead":' .. tostring(r.dead)
      .. ',"shieldRatio":' .. jnum(r.shieldRatio)
      .. ',"workProgress":' .. jnum(r.workProgress)
      .. ',"beingUpgraded":' .. tostring(r.beingUpgraded)
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
