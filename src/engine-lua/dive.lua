-- =====================================================================
-- The dive -- UNITCOMMAND_Dive of a surfacing submarine. The command is
-- no task: DispatchTask (Cfile:830531-830543, under the off-by-one case
-- label) flips the motion's target layer -- Water for a unit in the Sub
-- layer, Sub for any other -- through IAiCommandDispatchImpl::
-- SetNewTargetLayer (832195-832198) and CUnitMotion::SetNewTargetLayer
-- (965234-965274), and the command is instant (CommandIsInstant
-- 842857-842872): the dispatcher pops it the next tick (746616-746650),
-- the queue goes on while the boat still dives. The motion does the
-- rest: CalcMoveWater (971814-971860), the tick of every unit in the
-- Water or Sub layer (966296-966310), runs HandleDivingAndSurfacing
-- (971735-971812) after CalcMoveCommon and SnapToWater (970979-971036)
-- when the unit moved or dived. The Sim binding is IssueDive
-- (cfunc_IssueDiveL 1008189-1008260, globals.lua); the user's command
-- passes func_ProcessUnitCommand's SurfacingSub test (1006861-1006864).
--
-- Not modelled, recorded rather than faked (docs/STATUS.md): the attack
-- task's auto-surface (813228-813290), the transport unload's and the
-- carrier's surfacing (853573-853588, 828062-828072), SnapToWater's lift
-- over an occupied rect (970999-971011: the unit the boat rides).
--
-- STANDARD LUA 5.4 (goes raw into host.eval).
-- =====================================================================

local function hasState(u, s) return u:IsUnitState(s) end
local function setState(u, s, on) u:SetUnitState(s, on == true) end

function __isSurfacingSub(u)
  local mt = u.__bp and u.__bp.Physics and u.__bp.Physics.MotionType
  return mt == 'RULEUMT_SurfacingSub'
end

--- CUnitMotion::SetNewTargetLayer (965234-965274): from Sub to Water the
--- MovingUp bit (0x800, state 11) and the "Up" event (965247-965262);
--- from Water to Sub the MovingDown bit (0x400, state 10) and the "Down"
--- event (965268-965272); the motion's target layer takes the new one.
function __diveSetNewTargetLayer(u, newLayer)
  local old = u.__layer
  if old == 'Sub' then
    if newLayer == 'Water' then
      setState(u, 'MovingUp', true)
      __setMotionVertEvent(u, 'Up')
    end
  elseif old == 'Water' and newLayer == 'Sub' then
    setState(u, 'MovingDown', true)
    __setMotionVertEvent(u, 'Down')
  end
  u.__motionLayer = newLayer
end

--- HandleDivingAndSurfacing (971735-971812), once per tick for a unit in
--- the Water or Sub layer: nothing without a Physics.Elevation
--- (UnitAttributes.mElevation, 949113) or without MovingUp / MovingDown
--- (the diving speed 0); the depth is capped at terrain + 0.25 - water
--- (shallow water, at most 0); the speed is Physics.DiveSurfaceSpeed *
--- 0.1 per tick on a sine ramp over the depth reached, at least a tenth of
--- it (971767-971775); up: mSubElevation rises to 0, then the layer, the
--- bit and the "Top" event (971779-971791; the label UMVE_Bottom is
--- names[0] "Top", motion.lua); down: it sinks to the depth, then the
--- layer, the bit and the "Bottom" event (971796-971806). Returns whether
--- it moved (SnapToWater follows).
function __diveTick(u)
  local phys = (u.__bp and u.__bp.Physics) or {}
  local elevation = phys.Elevation or 0
  if elevation == 0 then return false end
  local up, down = hasState(u, 'MovingUp'), hasState(u, 'MovingDown')
  if not up and not down then
    u.__divingSpeed = 0
    return false
  end
  local p = u.__pos
  local terrain = GetTerrainHeight(p[1], p[3])
  local water = __mapWaterLevel or -10000
  local target = (terrain + 0.25) - water
  if target > 0 then target = 0 end
  if target > elevation then elevation = target end
  local sub = u.__subElevation or 0
  local v17 = math.abs(sub / elevation)
  local diveSpeed = (phys.DiveSurfaceSpeed or 1.0) * 0.1
  if v17 > 0.5 then v17 = 1.0 - v17 end
  local speed = diveSpeed * 0.1
  local ramp = math.sin(v17 * math.pi) * diveSpeed
  if speed <= ramp then speed = ramp end
  u.__divingSpeed = speed
  if up then
    local s = sub + speed
    if s > 0 then s = 0 end
    u.__subElevation = s
    if s == 0 then
      __setCurrentLayer(u, u.__motionLayer or 'Water')
      setState(u, 'MovingUp', nil)
      __setMotionVertEvent(u, 'Top')
      return true
    end
  elseif down then
    local s = sub - speed
    if s > elevation then elevation = s end
    u.__subElevation = elevation
    -- The decompiled test reads `mElevation >= mElevation` (971801): the
    -- local is a MAPDST split (971735, two versions of one stack slot) --
    -- the capped target on the left, the new mSubElevation on the right,
    -- so the test is "target >= depth", the depth reached, the mirror of
    -- the surfacing side's `== 0.0` (971783).
    if u.__subElevation <= ((target > (phys.Elevation or 0)) and target or (phys.Elevation or 0)) then
      __setCurrentLayer(u, u.__motionLayer or 'Sub')
      setState(u, 'MovingDown', nil)
      __setMotionVertEvent(u, 'Bottom')
    end
  end
  return true
end

--- SnapToWater (970979-971036): y = max(terrain + 0.25, water +
--- mSubElevation) (971021-971024); below the surface y is capped at the
--- water and mSubElevation follows (971025-971031). The lift over an
--- occupied rect (970999-971011) is not modelled.
function __diveSnapY(u, x, z)
  local terrain = GetTerrainHeight(x, z)
  local water = __mapWaterLevel or -10000
  local sub = u.__subElevation or 0
  local y = terrain + 0.25
  if water + sub > y then y = water + sub end
  if sub < 0 then
    if y > water then y = water end
    u.__subElevation = y - water
  end
  return y
end

--- The CUnitMotion constructor for a unit born in the Sub layer
--- (964891-964904): mSubElevation = Physics.Elevation and the "Bottom"
--- event with its callback (the label UMVE_Top with names[1]).
function __diveInitSpawn(u)
  if u.__layer == 'Sub' then
    u.__subElevation = (u.__bp and u.__bp.Physics and u.__bp.Physics.Elevation) or 0
    __setMotionVertEvent(u, 'Bottom')
  end
end

--- DispatchTask's UNITCOMMAND_Dive (830531-830543): the target layer
--- flips on the unit's current layer; instant -- `false` hands the queue
--- on (CommandIsInstant 842857-842872).
function __diveStart(unitId, cmd)
  local u = __units[unitId]
  if not u then return false end
  __diveSetNewTargetLayer(u, (u.__layer == 'Sub') and 'Water' or 'Sub')
  return false
end

--- The user's Dive (orders.lua:241-266 DiveOrderBehavior -> IssueCommand
--- 'Dive', clear = 1 by default, cfunc_IssueCommandL 1265527):
--- func_ProcessUnitCommand takes it for a RULEUMT_SurfacingSub only
--- (1006861-1006864).
function __dispatchDive(unitId, clear)
  local u = __units[unitId]
  if not u or not __isSurfacingSub(u) then return end
  __issueOrder(unitId, { type = 'Dive' }, clear)
end
