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

-- Entity::AdvanceCoords — advance every unit with a goal by one tick.
function __advanceMotion()
  for id, u in pairs(__units) do
    local goal = u.__goal
    local p = u.__pos

    -- DREH-ZIEL ohne Fahr-Ziel: die Unit steht und dreht sich zum Ziel — mit
    -- ihrer `Physics.TurnRate` (Grad/Sekunde), nicht sofort. Der Bauer sieht sein
    -- Gebaeude an, bevor er anfaengt (build.lua setzt __faceGoal).
    if not goal and u.__faceGoal and p then
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

    if goal and p then
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
      -- Nah genug: diesen Tick exakt auf dem Ziel ankommen.
      elseif dist <= math.max(speed, 0.05) then
        p[1] = goal[1]
        p[3] = goal[2]
        p[2] = GetSurfaceHeight(p[1], p[3])
        u.__goal = false
        u.__speed = 0
      else
        -- Turn toward the goal, at most turnRate this tick.
        local wanted = atan2(dx, dz)
        local diff = wanted - (u.__heading or 0)
        while diff > PI do diff = diff - 2 * PI end
        while diff < -PI do diff = diff + 2 * PI end
        local turn = m.turnRate
        if math.abs(diff) <= turn then
          u.__heading = wanted
          diff = 0
        else
          u.__heading = (u.__heading or 0) + (diff > 0 and turn or -turn)
          diff = diff - (diff > 0 and turn or -turn)
        end

        -- Speed cap from the turn circle: v = omega * r. A unit that still has
        -- to turn cannot drive faster than its turn radius allows, which is what
        -- TurnRadius (10 for the ACU) is for.
        local cap = m.maxSpeed
        if diff ~= 0 and m.turnRadius < math.huge then
          cap = math.min(cap, m.turnRate * m.turnRadius)
        end

        -- ROTATE-ON-SPOT (Bots, viele Experimentelle): erst drehen, dann fahren.
        -- ComputeSteeringSpeedCapFromParams (movement-path.md:174, CAiPathSpline):
        -- ist die Ausrichtung zum Ziel schlechter als align 0.98
        -- (dot(vorwaerts, richtung) < 0.98, ~11.4 Grad), ist die Geschwindigkeit
        -- 0 — die Einheit dreht sich auf der Stelle. Sonst faehrt sie mit
        -- vollem Speed an. Ohne das kurven Bots wie Autos statt sich zu drehen.
        if m.rotateOnSpot then
          local align = math.cos(diff) -- dot(vorwaerts, zielrichtung) in 2D
          if align < 0.98 then cap = 0 end
        end
        -- Stop exactly on the goal: kinematics, v = sqrt(2 * a * d).
        cap = math.min(cap, math.sqrt(2 * m.brake * dist))

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
