-- =====================================================================
-- Land motion — the engine's ground movement.
--
-- All parameters come from the engine's motion-parameter setup
-- (Cfile:942105-942152). They are PER TICK, not per second:
--
--   turnRate    = bp.TurnRate       * turnMult  * 0.0017453292  (deg/s -> rad/tick)
--   maxSpeed    = bp.MaxSpeed       * speedMult * 0.1           (units/tick)
--   maxReverse  = bp.MaxSpeedReverse* speedMult * 0.1
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
    SetGoal = function(self, pos)
      local u = __units[id]
      if u and pos then u.__goal = { pos[1] or pos.x or 0, pos[3] or pos.z or 0 } end
    end,
    AbortMove = function(self)
      local u = __units[id]
      if u then
        u.__goal = false
        u.__speed = 0
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
    SetSpeedThroughGoal = function() end,
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

  return {
    turnRate = (phys.TurnRate or 0) * turnMult * DEG_PER_SEC_TO_RAD_PER_TICK,
    maxSpeed = (phys.MaxSpeed or 0) * speedMult * 0.1,
    accel = accel,
    brake = (brakeBp ~= 0 and brakeBp * accMult * 0.01) or accel,
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

local function blockedAt(u, x, z)
  local myR = footprintRadius(u)
  for _, other in pairs(__units) do
    if other ~= u and not other.__dead and not other.__destroyQueued
      and not other.__goal and (other.__bp and other.__bp.Physics
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

-- Entity::AdvanceCoords — advance every unit with a goal by one tick.
function __advanceMotion()
  for id, u in pairs(__units) do
    -- Unit::MotionTick decrements positive stun durations before delegating to
    -- CUnitMotion. A value of 1 therefore blocks the weapon stage of this beat
    -- but reaches zero before movement; negative values never count down.
    local stunTicks = u.__stunTicks or 0
    if stunTicks > 0 then u.__stunTicks = stunTicks - 1 end
    local stunned = (u.__stunTicks or 0) ~= 0
    local goal = u.__goal
    local p = u.__pos

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

    if goal and p and (u:IsUnitState('Immobile') or stunned) then
      -- SetImmobile is a runtime UNITSTATE bit. The native motion task waits
      -- while it or the stun counter is set and keeps its waypoint, so clearing
      -- the gate resumes the same order instead of discarding it.
      u.__speed = 0
    elseif goal and p then
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
      -- Nah genug: diesen Tick exakt auf dem Ziel ankommen — außer eine
      -- STEHENDE Unit belegt die Zelle: dann zur nächsten freien Zelle
      -- weiterfahren (Occupancy statt Pushing, movement-path.md §6).
      elseif dist <= math.max(speed, 0.05) then
        if blockedAt(u, goal[1], goal[2]) then
          local nx, nz = freeSpotNear(u, goal[1], goal[2])
          if nx ~= goal[1] or nz ~= goal[2] then
            u.__goal = { nx, nz }
          else
            -- No free cell in reach: stop where we are.
            u.__goal = false
            u.__speed = 0
          end
        else
          p[1] = goal[1]
          p[3] = goal[2]
          p[2] = GetSurfaceHeight(p[1], p[3])
          u.__goal = false
          u.__speed = 0
        end
      else
        -- Heading/Forward VOM TICK-ANFANG: die Cap-Kaskade der Engine rechnet
        -- gegen die Ausrichtung VOR der Drehung (CAiPathSpline::Generate).
        local h0 = u.__heading or 0
        local fwdX = math.sin(h0)
        local fwdZ = math.cos(h0)
        local speedFrac = speed / m.maxSpeed -- Cfile:766083: |v|*10 / MaxSpeed

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
        -- Brems-Ticks exakt die Restdistanz, sonst v = sqrt(2*brake*dist).
        local stopCap = (dist <= m.brake) and dist or math.sqrt(2 * m.brake * dist)
        if stopCap < cap then cap = stopCap end

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
        p[2] = GetSurfaceHeight(p[1], p[3])
      end
    end
  end
end
