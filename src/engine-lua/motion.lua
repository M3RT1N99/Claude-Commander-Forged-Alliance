-- =====================================================================
-- Land motion — the engine's ground movement.
--
-- All parameters come from the engine's motion-parameter setup
-- (Cfile:942105-942152). They are PER TICK, not per second:
--
--   turnRate    = bp.TurnRate       * turnMult  * 0.0017453292  (deg/s -> rad/tick)
--   maxSpeed    = bp.MaxSpeed       * speedMult * 0.1           (units/tick)
--   maxReverse  = bp.MaxSpeedReverse* speedMult * 0.1  (NOT modelled — reverse
--                 motion is a documented reduction, see motionParams)
--   maxAccel    = bp.MaxAcceleration* accMult   * 0.01          (units/tick^2)
--   maxBrake    = (bp.MaxBrake ~= 0      and bp.MaxBrake      or bp.MaxAcceleration) * accMult * 0.01
--   maxSteer    = (bp.MaxSteerForce ~= 0 and bp.MaxSteerForce or bp.MaxAcceleration) * accMult * 0.01
--   turnRadius  = bp.TurnRadius == 0 and inf or bp.TurnRadius / turnMult
--
-- Note the two zero-means-fallback rules: a MaxBrake or MaxSteerForce of 0
-- does NOT mean "cannot brake/steer", it means "use MaxAcceleration". The ACU
-- has no MaxBrake in its blueprint at all, so getting this wrong pins its
-- speed at zero forever.
-- =====================================================================

local PI = math.pi
local atan2 = math.atan2 or math.atan -- Lua 5.4 folds atan2 into atan(y, x)
local DEG_PER_SEC_TO_RAD_PER_TICK = 0.0017453292

-- unit:GetNavigator() — SetGoal/AbortMove/AtGoal/GetGoalPos, bound to the unit.
function __getNavigator(id)
  return {
    __id = id,
    -- SetGoal(pos, [layer]): the goal cell. A flyer's navigator hands the
    -- goal's position and layer to CUnitMotion::SetTarget (CAiNavigatorAir::
    -- SetGoal 755918-755958 -> SetTarget 755824-755841; air.lua), the layer
    -- LAYER_Air unless the goal names one (a transport's Land-layer flight
    -- to its passengers, CUnitLoadUnits 853120-853123).
    SetGoal = function(self, pos, layer)
      local u = __units[id]
      if u and pos then
        local x, z = pos[1] or pos.x or 0, pos[3] or pos.z or 0
        u.__goal = { x, z }
        if u.__bp and u.__bp.Air and u.__bp.Air.CanFly then __airSetTarget(u, x, nil, z, layer) end
      end
    end,
    -- AbortMove: a flyer's navigator stops the motion at the point a second
    -- ahead (CAiNavigatorAir::AbortMove 756062-756096 -> CUnitMotion::Stop).
    AbortMove = function(self)
      local u = __units[id]
      if u then
        u.__goal = false
        u.__speed = 0
        if u.__air then __airStop(u) end
      end
    end,
    AtGoal = function(self)
      local u = __units[id]
      return not (u and u.__goal)
    end,
    GetGoalPos = function(self)
      local u = __units[id]
      return u and (u.__goal and { u.__goal[1], 0, u.__goal[2] })
    end,
    -- SetSpeedThroughGoal(flag): "know whether to stop at final goal"
    -- (Cfile:756703). flag=1 -> the unit flows through the current goal cell at
    -- MaxSpeed (intermediate queued Move / any Patrol leg); flag=0 -> it brakes
    -- to a stop (the final leg). Drives the arrival/stop-cap gates below.
    SetSpeedThroughGoal = function(_, flag)
      local u = __units[id]
      if u then
        u.__speedThroughGoal = flag == 1 or flag == true
        -- CAiSteeringImpl::CalcAtTopSpeed sets CUnitMotion::mAlwaysUseTopSpeed
        -- (787876-787902); the speed-through flag is read as that here --
        -- UNVERIFIED that the steering's condition is the same
        -- (docs/STATUS.md).
        if u.__air then u.__air.alwaysUseTopSpeed = u.__speedThroughGoal end
      end
    end,
  }
end

local function motionParams(u)
  local phys = (u.__bp and u.__bp.Physics) or {}
  local turnMult = u.__turnMult or 1
  local speedMult = u.__speedMult or 1
  local accMult = u.__accMult or 1

  local accel = (phys.MaxAcceleration or 0) * accMult * 0.01
  local brakeBp = phys.MaxBrake or 0
  local steerBp = phys.MaxSteerForce or 0
  local radiusBp = phys.TurnRadius or 0

  -- Reverse motion (Physics.MaxSpeedReverse / BackUpDistance, Cfile:766097-
  -- 766128, clamp mMaxReserveSpeed 942130-942133) is a DOCUMENTED REDUCTION: the
  -- navigator only ever drives forward, so a unit ordered to a nearby point
  -- behind it pivots and drives forward instead of backing up. Not modelled yet.
  -- A flyer's top speed is the blueprint's Air.MaxAirspeed, not Physics.
  -- MaxSpeed: Unit::UpdateInfoCache (953100-953198) takes mAir.mMaxAirSpeed *
  -- speedMult for a unit that can fly and mPhysics.mMaxSpeed * speedMult for
  -- every other (Cfile:953164-953174), and CalcMoveAir caps on the same
  -- product (968103). The blueprint pipeline already fills MaxAirspeed from
  -- MaxSpeed when it is 0 (blueprints.lua:294, Cfile:655934-655935). The
  -- engine also divides a loaded transport's top speed by
  -- CalcTransportLoadFactor (953174) -- not modelled (docs/STATUS.md).
  local air = (u.__bp and u.__bp.Air) or {}
  local canFly = air.CanFly == true
  local topSpeedBp = (canFly and (air.MaxAirspeed or 0)) or (phys.MaxSpeed or 0)
  local maxSpeed = topSpeedBp * speedMult * 0.1
  local turnRate = (phys.TurnRate or 0) * turnMult * DEG_PER_SEC_TO_RAD_PER_TICK
  -- A flyer never reaches this ground model: its tick is CalcMoveAir
  -- (air.lua __airStep); the top speed here only feeds the row's motion
  -- events for a flyer that is attached.
  return {
    turnRate = turnRate,
    maxSpeed = maxSpeed,
    -- Raw blueprint top speed for the RotateOnSpot speed gate, which the
    -- engine normalizes WITHOUT speedMult (Cfile:766083 |v|*10 / mMaxSpeed).
    maxSpeedBp = topSpeedBp,
    accel = accel,
    brake = (canFly and accel) or (brakeBp ~= 0 and brakeBp * accMult * 0.01) or accel,
    steer = (steerBp ~= 0 and steerBp * accMult * 0.01) or accel,
    turnRadius = (radiusBp ~= 0 and radiusBp / turnMult) or math.huge,
    rotateOnSpot = phys.RotateOnSpot == true,
    rotateOnSpotThreshold = phys.RotateOnSpotThreshold or 0.5,
  }
end

-- Dynamic unit blocking at the arrival cell. The engine NEVER pushes units
-- apart (movement-path.md §6: overlap is avoided through occupancy bits +
-- predictive steering, mIsBeingPushed only comes from AddImpulse); a cell
-- holding a standing unit simply is not enterable (COORDS_CanMoveAt
-- @0x720F70 — unrecovered in faf-re; the documented rebuild treats living,
-- non-attached units in the cell as blockers). Without this every factory
-- product parked on the SAME roll-off point (scene debug: 32/33 stacked).
local function footprintRadius(u)
  local fp = (u.__bp and u.__bp.Footprint) or {}
  local s = math.max(fp.SizeX or 0, fp.SizeZ or 0)
  if s <= 0 then s = 1 end
  return s * 0.5
end

-- The height a moving unit sits at. CAiPathSpline::Update (Cfile:765808-765823)
-- and ::Generate (Cfile:766391) branch on the blueprint's MotionType: ONLY
-- Water, AmphibiousFloating and Hover clamp UP to the water surface
-- (max(GetElevation, mWaterElevation) while mWaterEnabled); every other type —
-- Land, Biped, Amphibious, SurfacingSub, Air, Special — takes the RAW
-- heightfield elevation. An amphibious unit therefore WALKS THE SEABED, which
-- CUnitMotion::IsOnValidLayer confirms by accepting LAYER_Seabed for
-- RULEUMT_Amphibious only (Cfile:965960-965975).
-- Enum values: Cfile:656550-656583.
--
-- Using GetSurfaceHeight for everything was harmless only while the Sim never
-- learned the map's water level (__setWaterLevel had no caller, so the max()
-- was a no-op). It stopped being harmless the moment the water level arrived.
local FLOATS_ON_WATER = {
  RULEUMT_Water = true,
  RULEUMT_AmphibiousFloating = true,
  RULEUMT_Hover = true,
}
local function surfaceY(u, x, z)
  local mt = u.__bp and u.__bp.Physics and u.__bp.Physics.MotionType
  if FLOATS_ON_WATER[mt] then return GetSurfaceHeight(x, z) end
  -- A surfacing submarine sits at the water plus its depth (SnapToWater,
  -- Cfile:970979-971036; dive.lua): on the surface when surfaced, below
  -- it when submerged -- not on the seabed.
  if mt == 'RULEUMT_SurfacingSub' then return __diveSnapY(u, x, z) end
  return GetTerrainHeight(x, z)
end

local function blockedAt(u, x, z)
  -- The occupancy grid is per layer (EOccupancyCaps, the layer bits the
  -- footprint fit tests -- OCCUPY_MobileCheck / OCCUPY_FootprintFits,
  -- Cfile:970296-970303): a unit in the Air layer occupies no ground cell
  -- and is blocked by none,
  -- and an attached unit (a transport's cargo, a factory's site) is not on
  -- the grid at all -- the Attached motion state has no position of its own
  -- (966205-966229).
  if u.__layer == 'Air' or (u.__bp and u.__bp.Air and u.__bp.Air.CanFly) then return false end
  local myR = footprintRadius(u)
  for _, other in pairs(__units) do
    if other ~= u and not other.__dead and not other.__destroyQueued
      and not other.__goal and not other.__attachParent and other.__layer ~= 'Air'
      and (other.__bp and other.__bp.Physics
        and other.__bp.Physics.MotionType ~= 'RULEUMT_None' or false) then
      local op = other.__pos
      if op then
        local r = myR + footprintRadius(other)
        local ddx, ddz = op[1] - x, op[3] - z
        if ddx * ddx + ddz * ddz < r * r then return true end
      end
    end
  end
  return false
end

-- First free ogrid cell around the target (1 m grid — the same raster
-- COORDS_GridSnap uses), scanned ring by ring, deterministic.
local function freeSpotNear(u, x, z)
  for ring = 1, 8 do
    for ix = -ring, ring do
      for iz = -ring, ring do
        if math.max(math.abs(ix), math.abs(iz)) == ring then
          local cx, cz = x + ix, z + iz
          if not blockedAt(u, cx, cz) then return cx, cz end
        end
      end
    end
  end
  return x, z
end
__freeSpotNear = freeSpotNear

--- SFootprint::FitsAt for the transport's drop check (TransportDetachUnit,
--- Cfile:803767-803776) and OCCUPY_FootprintFits for the ballistic landing
--- (CalcMoveBallistic 970296-970303): the occupancy grid under the unit's
--- footprint at (x, z). This motion model has no ogrid: the STRUCTURES
--- standing there are the blockers (a structure's footprint is on the grid
--- from its placement on). Whether an idle mobile unit's reservation
--- (Unit::ReserveOgridRect) is on that grid at the moment a dropped unit
--- lands is UNVERIFIED -- it is not counted here, so a drop onto standing
--- units is not a kill (docs/STATUS.md).
function __footprintFitsAt(u, x, z)
  local myR = footprintRadius(u)
  for _, other in pairs(__units) do
    if other ~= u and not other.__dead and not other.__destroyQueued
      and not other.__attachParent and other.__layer ~= 'Air'
      and (other.__bp and other.__bp.Physics and other.__bp.Physics.MotionType == 'RULEUMT_None' or false) then
      local op = other.__pos
      if op then
        local r = myR + footprintRadius(other)
        local ddx, ddz = op[1] - x, op[3] - z
        if ddx * ddx + ddz * ddz < r * r then return false end
      end
    end
  end
  return true
end

-- Entity::AdvanceCoords — advance every unit with a goal by one tick.
-- =====================================================================
-- Motion events -- CUnitMotion::mHorzEvent / mVertEvent and the callbacks
-- OnMotionHorzEventChange / OnMotionVertEventChange that unit.lua:2133-2265
-- turns into the start/stop sounds, the ambient move loops, the movement
-- effects and the weapons' notifications.
--
-- Names: horzMotionEvent_names { Cruise, TopSpeed, Stopping, Stopped }
-- (Cfile:421837); vertMotionEvent_names { Top, Bottom, Up } (Cfile:421838),
-- with Down and Hover as the further literals the engine passes and
-- unit.lua:2213-2221 compares. A fresh CUnitMotion starts with Stopped /
-- Bottom (Cfile:964772-964773).
-- =====================================================================

local function motionCallback(u, name, new, old)
  local f = u[name]
  if type(f) ~= 'function' then return end
  local ok, err = pcall(f, u, new, old)
  if not ok then WARN(name .. ': ' .. tostring(err)) end
end

--- CUnitMotion::SetMotionHorzEvent (Cfile:965503-965520): the callback fires
--- on a change only. On Stopped the engine also refreshes the unit's intel
--- (Entity::UpdateIntel, 965518-965519); there is no intel model here
--- (docs/STATUS.md).
function __setMotionHorzEvent(u, ev)
  local old = u.__horzEvent or 'Stopped'
  if old == ev then return end
  u.__horzEvent = ev
  motionCallback(u, 'OnMotionHorzEventChange', ev, old)
end

--- CUnitMotion::SetMotionVertEvent (Cfile:965524-965538). The value is
--- the index into vertMotionEvent_names { "Top", "Bottom", "Up", "Down",
--- "Hover" } (421838); the decompilation's enum LABELS UMVE_Top and
--- UMVE_Bottom are swapped against that table (UMVE_Top is paired with
--- names[1] "Bottom" at 964895-964903, 965780-965787, 966164-966171),
--- so a `UMVE_Top` in the decompiled code is the string "Bottom" and a
--- `UMVE_Bottom` the string "Top" -- unit.lua:2216 plays "Landed" on
--- 'Bottom'. The ctor's UMVE_Bottom (964773) is therefore "Top".
function __setMotionVertEvent(u, ev)
  local old = u.__vertEvent or 'Top'
  if old == ev then return end
  u.__vertEvent = ev
  motionCallback(u, 'OnMotionVertEventChange', ev, old)
end

--- CUnitMotion::ProcessCommonMotionState (Cfile:971451-971510), run at the
--- end of every land, hover and water tick with CalcMoveCommon's result:
---   not moving                         -> Stopped
---   |velocity| >  mTopSpeed * 0.08      -> TopSpeed   (|v| is the per-tick
---                                          displacement -- the engine scales
---                                          it by 10 against MaxSpeed,
---                                          Cfile:766083 -- and mTopSpeed the
---                                          blueprint MaxSpeed * speed mult per
---                                          second, 953172: 80 % of top speed)
---   otherwise, when not Stopped and the target is closer than one second
---   of travel (MaxSpeed * speed mult)  -> Stopping
---   otherwise                          -> Cruise
--- The engine's second Stopping condition -- the next waypoint being a
--- PPS_1 point (971469-971470) -- is not modelled: PPS_1 is the state the
--- path spline gives its own start point (765664) and its meaning for the
--- NEXT waypoint is unresolved.
local function processCommonMotionState(u, moving)
  if not moving then
    __setMotionHorzEvent(u, 'Stopped')
    return
  end
  local m = motionParams(u)
  local speed = u.__speed or 0
  if speed > m.maxSpeed * 0.8 then
    __setMotionHorzEvent(u, 'TopSpeed')
    return
  end
  local dist = 0
  local goal, p = u.__goal, u.__pos
  if goal and p then
    local dx, dz = goal[1] - p[1], goal[2] - p[3]
    dist = math.sqrt(dx * dx + dz * dz)
  end
  if (u.__horzEvent or 'Stopped') ~= 'Stopped' and dist < m.maxSpeed * 10 then
    __setMotionHorzEvent(u, 'Stopping')
  else
    __setMotionHorzEvent(u, 'Cruise')
  end
end

function __advanceMotion()
  for id, u in pairs(__units) do
    -- Unit::MotionTick decrements positive stun durations before delegating to
    -- CUnitMotion. A value of 1 therefore blocks the weapon stage of this beat
    -- but reaches zero before movement; negative values never count down.
    local stunTicks = u.__stunTicks or 0
    if stunTicks > 0 then u.__stunTicks = stunTicks - 1 end
    local stunned = (u.__stunTicks or 0) ~= 0
    -- Entity::TaskTick opens with the texture scroller (Cfile:916174-916176),
    -- before the attach follow and the motion of this tick.
    __scrollerTick(u)
    -- UMS_Attached (CUnitMotion tick, Cfile:966205-966229): no velocity, the
    -- position is the follow (__attachFollowTick after this loop); the layer
    -- follows the parent's — except under a unit that is building this one
    -- (GetFocusEntity == self), which keeps its own layer.
    if u.__attachParent then
      u.__speed = 0
      local par = u.__attachParent
      if par.__layer and not (par.__isUnit and par.__focusEntity == u) then
        __setCurrentLayer(u, par.__layer)
      end
      goto continue
    end
    -- UMS_Ballistic (CUnitMotion tick, Cfile:966250-966253): the fall of a
    -- released unit until the surface lands it (__ballisticStep below).
    if u.__ballisticDrop then
      __ballisticStep(u)
      goto continue
    end
    -- A unit that can fly takes CalcMoveAir (the tick's default branch for
    -- mAir.mCanFly, Cfile:966254-966261; an Immobile or stunned flyer only
    -- reports Stopped; a crashed body lies still, 966252-966253).
    if u.__bp and u.__bp.Air and u.__bp.Air.CanFly then
      if u.__motionState == 'Crashed' then goto continue end
      if u.__immobile or stunned then
        __setMotionHorzEvent(u, 'Stopped')
        goto continue
      end
      __airStep(u)
      goto continue
    end
    local goal = u.__goal
    local p = u.__pos
    -- CalcMoveCommon's result: whether a move was computed this tick
    -- (Cfile:971040-971352 -- 0 while being built (971044), in a layer
    -- transition (971048), off every valid layer (971211-971218) or when the
    -- computed velocity is zero (971329-971338: a unit that has just arrived
    -- or has no path); 1 after a move). It feeds ProcessCommonMotionState at
    -- the end of the tick (971718, 971575).
    local moving = false
    -- A released unit is put back on its surface before it moves again:
    -- NotifyDetached sets mProcessSurfaceCollision (Cfile:965870), and the
    -- next CalcMoveLand snaps the unit to the ground for it
    -- (FindIntersectingRaisedPlatform + SnapToGround, then the flag is
    -- cleared, Cfile:971709-971716; CalcMoveHover likewise, 971573-971575).
    if u.__snapToSurface and p then
      u.__snapToSurface = nil
      p[2] = surfaceY(u, p[1], p[3])
    end

    -- DREH-ZIEL ohne Fahr-Ziel: die Unit steht und dreht sich zum Ziel — mit
    -- ihrer `Physics.TurnRate` (Grad/Sekunde), nicht sofort. Der Bauer sieht sein
    -- Gebaeude an, bevor er anfaengt (build.lua setzt __faceGoal).
    if not stunned and not goal and u.__faceGoal and p then
      local f = u.__faceGoal
      local m = motionParams(u)
      local wanted = atan2(f[1] - p[1], f[2] - p[3])
      local diff = wanted - (u.__heading or 0)
      while diff > PI do diff = diff - 2 * PI end
      while diff < -PI do diff = diff + 2 * PI end
      local turn = m.turnRate
      if turn <= 0 or math.abs(diff) <= turn then
        u.__heading = wanted
        u.__faceGoal = false
      else
        u.__heading = (u.__heading or 0) + (diff > 0 and turn or -turn)
      end
    end

    -- A live stunned or immobile unit still runs CalcMoveCommon in the engine
    -- (Cfile:966266-966274): its residual velocity brakes over a few ticks and
    -- the motion events follow that braking before Stopped. This model stops
    -- such a unit at once, so it reports Stopped at once (docs/STATUS.md).
    if goal and p and (u.__dead or u.__destroyQueued or u:IsUnitState('Immobile') or stunned) then
      -- A DEAD unit computes no movement at all: CUnitMotion::CalcMoveLand
      -- (Cfile:971696-971704), ::CalcMoveWater (Cfile:971825-971826) and
      -- ::CalcMoveHover (Cfile:971533-971534) each open with
      -- `if (IsDead(mUnit)) { result = 0; }` and skip CalcMoveCommon entirely.
      -- Death is not instant here either — DeathThread runs for several beats
      -- (unit.lua:1200-1241) — so without this a killed unit kept driving to its
      -- goal for the whole death sequence.
      --
      -- SetImmobile is a runtime UNITSTATE bit. The native motion task waits
      -- while it or the stun counter is set and keeps its waypoint, so clearing
      -- the gate resumes the same order instead of discarding it. The same
      -- shape is right for death: the goal stays, the unit simply stops.
      u.__speed = 0
    elseif goal and p then
      moving = true
      local m = motionParams(u)
      local dx = goal[1] - p[1]
      local dz = goal[2] - p[3]
      local dist = math.sqrt(dx * dx + dz * dz)
      local speed = u.__speed or 0

      -- UNBEWEGLICH (MaxSpeed 0): kein Ziel, keine Bewegung. Punkt.
      --
      -- Vorher stand hier `if m.maxSpeed <= 0 or dist <= ...` — und der Zweig
      -- SETZT die Position auf das Ziel. Ein Gebaeude ist damit bei jedem
      -- Bewegungsbefehl an den Klickpunkt TELEPORTIERT. Eine Einheit ohne
      -- Antrieb bewegt sich nicht; sie rutscht auch nicht „schnell" ans Ziel.
      if m.maxSpeed <= 0 then
        u.__goal = false
        u.__speed = 0
        moving = false
      -- Nah genug: diesen Tick exakt auf dem Ziel ankommen — außer eine
      -- STEHENDE Unit belegt die Zelle: dann zur nächsten freien Zelle
      -- weiterfahren (Occupancy statt Pushing, movement-path.md §6).
      elseif dist <= math.max(speed, 0.05) then
        if blockedAt(u, goal[1], goal[2]) then
          local nx, nz = freeSpotNear(u, goal[1], goal[2])
          if nx ~= goal[1] or nz ~= goal[2] then
            u.__goal = { nx, nz }
          else
            -- No free cell in reach: stop where we are (zero velocity, so
            -- CalcMoveCommon would return 0: not moving).
            u.__goal = false
            u.__speed = 0
            moving = false
          end
        else
          p[1] = goal[1]
          p[3] = goal[2]
          p[2] = surfaceY(u, p[1], p[3])
          u.__goal = false
          -- Keep the momentum through an intermediate/patrol goal (speed-through);
          -- only a final goal brakes to 0 (the order system re-issues the next
          -- leg, so the unit flows on without a full stop).
          if not u.__speedThroughGoal then
            u.__speed = 0
            -- Arrived with zero velocity: CalcMoveCommon returns 0 for that
            -- (971329-971338), so this tick already reports Stopped.
            moving = false
          end
        end
      else
        -- Heading/Forward VOM TICK-ANFANG: die Cap-Kaskade der Engine rechnet
        -- gegen die Ausrichtung VOR der Drehung (CAiPathSpline::Generate).
        local h0 = u.__heading or 0
        local fwdX = math.sin(h0)
        local fwdZ = math.cos(h0)
        -- Cfile:766083: |v|*10 / MaxSpeed, normalized by the RAW blueprint
        -- MaxSpeed (NOT the speedMult-scaled per-tick maxSpeed), so a speed-
        -- buffed/debuffed RotateOnSpot unit trips the gate at the right fraction.
        local speedFrac = (m.maxSpeedBp > 0) and (speed * 10 / m.maxSpeedBp) or 0

        -- Turn toward the goal. Effektive Drehrate = max(turnRate,
        -- v / turnRadius), auf PI geklemmt (Cfile:766161-766163 + 942169-942170):
        -- eine schnelle Einheit darf ihren TurnRadius-Kreis mit omega = v/r
        -- halten, auch ueber die nominelle TurnRate hinaus (Schiffe).
        local wanted = atan2(dx, dz)
        local diff = wanted - h0
        while diff > PI do diff = diff - 2 * PI end
        while diff < -PI do diff = diff + 2 * PI end
        local turn = m.turnRate
        if m.turnRadius > 0 and m.turnRadius < math.huge then
          local omega = speed / m.turnRadius
          if omega > turn then turn = omega end
        end
        if turn > PI then turn = PI end
        if math.abs(diff) <= turn then
          u.__heading = wanted
        else
          u.__heading = h0 + (diff > 0 and turn or -turn)
        end

        -- Die Speed-Cap-Kaskade der Engine, 1:1 (sub_699760 @0x699760,
        -- Cfile:942291-942328; gerufen aus CAiPathSpline::Generate 766232ff):
        local cap
        if m.rotateOnSpot and m.rotateOnSpotThreshold > speedFrac then
          -- GATE 1 (942301): RotateOnSpot NUR unterhalb der Speed-Schwelle
          -- (Default 50 % MaxSpeed). align = dot(normalize(ziel), forward)
          -- mit dem Heading vor der Drehung (942303-942306): schlechter als
          -- 0.98 (~11.5 Grad) -> stehen und drehen; sonst voller MaxSpeed
          -- (der Bogen-Cap wird uebersprungen, 942307-942308).
          local align = (dx * fwdX + dz * fwdZ) / dist
          cap = (align < 0.98) and 0 or m.maxSpeed
        else
          -- Bogen-Geometrie (942310-942314): der Kreis durch Position und
          -- Ziel, tangential zum Heading. cross = dz*fwd.x - fwd.z*dx;
          -- r = dist^2 * 0.5 / cross.
          local cross = dz * fwdX - fwdZ * dx
          local absR = 0
          if cross ~= 0 then absR = math.abs((dist * dist) * 0.5 / cross) end
          if absR < m.turnRadius then
            -- GATE 2 (942316-942321): nur Kurven ENGER als der TurnRadius
            -- drosseln — v = turnRate * |r| * 0.5.
            cap = (absR == 0) and m.maxSpeed or (m.turnRate * absR * 0.5)
          else
            -- weiter Bogen: turnRadius wirkt nach der min-Klemme wie
            -- "kein Cap" (942315/942327).
            cap = m.turnRadius
          end
        end
        if cap > m.maxSpeed then cap = m.maxSpeed end

        -- Anhalte-Kinematik (Cfile:766249-766262): innerhalb eines
        -- Brems-Ticks exakt die Restdistanz, sonst v = sqrt(2*brake*dist). The
        -- engine applies this only on a STOP path (PT_0, Cfile:766249); a
        -- speed-through goal (intermediate Move / patrol leg) skips it and holds
        -- MaxSpeed, so the unit does not brake at every queued waypoint.
        if not u.__speedThroughGoal then
          local stopCap = (dist <= m.brake) and dist or math.sqrt(2 * m.brake * dist)
          if stopCap < cap then cap = stopCap end
        end

        local dv = cap - speed
        if dv > m.accel then speed = speed + m.accel
        elseif dv < -m.brake then speed = speed - m.brake
        else speed = cap end
        if speed < 0 then speed = 0 end

        u.__speed = speed
        p[1] = p[1] + math.sin(u.__heading) * speed
        p[3] = p[3] + math.cos(u.__heading) * speed
        -- A land unit follows the ground. Without this the sim drives at height
        -- 0 through the hills while the renderer paints something else — the
        -- two positions drift apart in Y forever.
        p[2] = surfaceY(u, p[1], p[3])
      end
    end
    -- CalcMoveWater (Cfile:971814-971860): after CalcMoveCommon a surfacing
    -- submarine runs HandleDivingAndSurfacing (971826, dive.lua), and
    -- SnapToWater follows a move or a dive step (971849-971854).
    if __isSurfacingSub(u) and p then
      local dived = __diveTick(u)
      if dived or moving then p[2] = surfaceY(u, p[1], p[3]) end
    end
    -- CUnitMotion::ProcessCommonMotionState closes every land, hover and
    -- water tick (Cfile:971718, 971575, 971856).
    processCommonMotionState(u, moving)
    ::continue::
  end
  -- Attached entities follow their parents once everyone has moved (their
  -- task ticks wait for the parent's, Cfile:916183-916184).
  __attachFollowTick()
end

-- =====================================================================
-- Attachment on the unit side — what Unit::AttachTo / Unit::DetachFrom add
-- to the entity bookkeeping in bones.lua.
-- =====================================================================

--- Entity::SetCurrentLayer (Cfile:917202-917222): OnLayerChange(new, old)
--- when the layer actually changes.
function __setCurrentLayer(u, layer)
  local old = u.__layer
  u.__layer = layer
  u.Layer = layer
  if old ~= layer and type(u.OnLayerChange) == 'function' then
    local ok, err = pcall(u.OnLayerChange, u, layer, old)
    if not ok then WARN('OnLayerChange: ' .. tostring(err)) end
  end
end

--- CUnitMotion::SetMotionState: OnMotionStateChange(new, old) when it changes.
--- The names are Moho::MotionStates — 'None' (the constructor value,
--- Cfile:964771), 'Attached' [1], 'Ballistic' [2] (Cfile:965759/965830).
local function setMotionState(u, state)
  local old = u.__motionState or 'None'
  if old == state then return end
  u.__motionState = state
  if type(u.OnMotionStateChange) == 'function' then
    local ok, err = pcall(u.OnMotionStateChange, u, state, old)
    if not ok then WARN('OnMotionStateChange: ' .. tostring(err)) end
  end
end
__airMotionState = setMotionState

--- Unit::AttachTo after Entity::AttachTo succeeded (Cfile:954378-954392):
--- CUnitMotion::NotifyAttached (Cfile:965746-965793) and the Attached state
--- bit (UNITSTATEMASK_Attached, 954389); mTransportLoadFactor = -1 (954391).
---
--- The engine gates NotifyAttached and the bit on a virtual predicate of the
--- unit (slot 0x30 of the IUnit vtable, 954384) whose identity the
--- decompilation does not resolve (that vtable is not listed) -- UNVERIFIED;
--- both are applied to every unit here. NotifyAttached also forces the
--- horizontal motion event to Stopped and the vertical one to "Bottom"
--- (the label UMVE_Top with names[1], 965780-965787 -- see
--- __setMotionVertEvent), with their callbacks (965760-965785; the
--- UpdateIntel on Stopped has no intel model here).
function __unitOnAttached(u)
  setMotionState(u, 'Attached')
  __setMotionHorzEvent(u, 'Stopped')
  __setMotionVertEvent(u, 'Bottom')
  u.__unitStates = u.__unitStates or {}
  u.__unitStates.Attached = true
  u.__transportLoadFactor = -1
end

--- Before Unit::DetachFrom: nothing is refused. NotifyDetached
--- (Cfile:965794-965870) puts a live non-flying unit into UMS_Ballistic and
--- LAYER_Air unless skipBallistic; the fall is __ballisticStep below.
function __unitCheckDetach(u, skipBallistic)
end

--- Unit::DetachFrom after Entity::DetachFrom (Cfile:954394-954427):
--- NotifyDetached (965794-965870) -- UMS_Ballistic and the Air layer for a
--- live non-flying unit without skipBallistic (965830-965848: the drop,
--- landed by __ballisticStep), motion state None for a flying unit or with
--- skipBallistic (965855-965863), the Air layer for a flying unit without
--- skipBallistic (965838-965848), mProcessSurfaceCollision (965870); then
--- the Attached bit is cleared (954404), mTransportLoadFactor reset and
--- mTransportedBy released (954406-954425). The engine gates NotifyDetached
--- and the bit on the same unit predicate as Unit::AttachTo (954405-954409,
--- UNVERIFIED which -- see __unitOnAttached); both run for every unit here.
--- NotifyDetached also sets a steering target one unit behind the parent's
--- facing (SetTarget, 965803-965816); this motion model has no such target,
--- and a navigator goal the unit had before the attach survives the detach.
--- A DEAD unit (or one queued for deletion) is released in place and keeps
--- its layer: FinishBuildThread skips `DetachFrom(true)` for a dead site
--- (defaultunits.lua:539-542) and releases it with `DetachAll(bone)` while
--- its DeathThread runs, and Entity::OnDestroy detaches at the end of the
--- beat (916158) with no ballistic tick in between; the engine's dead-body
--- drop (OnImpact + UMS_Crashed, 970344-970356) is not run for them here
--- (docs/STATUS.md).
function __unitOnDetached(u, par, skipBallistic)
  local canFly = u.__bp and u.__bp.Air and u.__bp.Air.CanFly
  if not canFly and not skipBallistic and not u.__dead and not u.__destroyQueued then
    setMotionState(u, 'Ballistic')
    __setCurrentLayer(u, 'Air')
    -- The velocity the fall starts with is the unit's own (GetVelocity,
    -- 970015); an attached unit has none in this model.
    u.__ballisticDrop = { v = { 0, 0, 0 } }
    u.__goal = false
    u.__speed = 0
  else
    setMotionState(u, 'None')
    if canFly and not skipBallistic then __setCurrentLayer(u, 'Air') end
    u.__snapToSurface = true
  end
  if u.__unitStates then u.__unitStates.Attached = nil end
  u.__transportLoadFactor = -1
  u.__transportedBy = false
end

--- The unit part of the detach that Entity::OnDestroy performs on a dying
--- attached unit (the virtual DetachFrom(parent, false), Cfile:916158 ->
--- Unit::DetachFrom 954394-954427): the Attached bit is cleared,
--- mTransportLoadFactor reset, mTransportedBy released. NotifyDetached's
--- Ballistic/Air callbacks on the entity being deleted belong to the drop
--- that is not implemented and are not fired.
function __unitDetachedOnDestroy(u)
  u.__motionState = 'None'
  u.__ballisticDrop = nil
  if u.__unitStates then u.__unitStates.Attached = nil end
  u.__transportLoadFactor = -1
  u.__transportedBy = false
end

--- CUnitMotion::CalcMoveBallistic (Cfile:970009-970420), the tick of
--- UMS_Ballistic: the velocity gains the sim gravity (mGravity * 0.01 per
--- tick, 970111-970115), the unit moves along it, and the segment from the
--- old to the new position is cut with the surface (STIMap::
--- SurfaceIntersection 970248; an amphibious unit -- RULEUMT_Amphibious,
--- 970244 -- takes the heightfield alone and walks the seabed). Landing puts
--- the unit into the layer of the surface -- Land, Water, or Seabed for the
--- amphibious unit under water (970270-970310) -- with OnLayerChange; a
--- layer change that leaves the footprint blocked kills the unit
--- (970296-970332: Kill without instigator or type). A live unit then goes
--- to UMS_None (970336-970343), a dead one hears OnImpact("Terrain"|"Water")
--- and goes to UMS_Crashed (970344-970356). Not modelled: the tumble of the
--- falling body (the PhysBody orientation, 970038-970060), the playable-
--- rect and upright checks of the kill (970325-970331), and the layer test
--- of the footprint (a land unit landing on water survives here).
function __ballisticStep(u)
  local b = u.__ballisticDrop
  local p = u.__pos
  if not b or not p then return end
  local v = b.v
  v[2] = v[2] - __simGravity * 0.01
  local nx, ny, nz = p[1] + v[1], p[2] + v[2], p[3] + v[3]
  local mt = u.__bp and u.__bp.Physics and u.__bp.Physics.MotionType
  local terrain = GetTerrainHeight(nx, nz)
  local water = __mapWaterLevel or -10000
  local surface = (mt == 'RULEUMT_Amphibious') and terrain or math.max(terrain, water)
  if ny > surface then
    p[1], p[2], p[3] = nx, ny, nz
    return
  end
  p[1], p[2], p[3] = nx, surface, nz
  local layer
  if water >= surface then
    layer = (mt == 'RULEUMT_Amphibious') and 'Seabed' or 'Water'
  else
    layer = 'Land'
  end
  local old = u.__layer
  __setCurrentLayer(u, layer)
  u.__ballisticDrop = nil
  u.__speed = 0
  if old ~= layer and not u.__dead and not __footprintFitsAt(u, p[1], p[3]) then
    u:Kill(nil, '', 0)
  end
  if u.__dead then
    if type(u.OnImpact) == 'function' then
      local ok, err = pcall(u.OnImpact, u, layer == 'Land' and 'Terrain' or 'Water')
      if not ok then WARN('OnImpact: ' .. tostring(err)) end
    end
    setMotionState(u, 'Crashed')
  else
    setMotionState(u, 'None')
  end
end

--- An attached unit whose parent was destroyed (the CUnitMotion tick with an
--- empty attach link, Cfile:966231-966238): the engine drops it (Ballistic,
--- Air layer, surface collision). Without the drop the unit is released in
--- place and lands on its next motion tick; the Attached bit stays set, as
--- in the engine (only Unit::DetachFrom clears it, 954404).
function __unitParentLost(u)
  setMotionState(u, 'None')
  u.__snapToSurface = true
end
