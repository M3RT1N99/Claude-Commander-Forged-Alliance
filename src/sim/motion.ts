import type { LuaHost } from '../lua/host'

/**
 * Engine-Bewegung — der Navigator (`unit:GetNavigator():SetGoal`) + die
 * Physik-Fortschreibung (`Entity::AdvanceCoords`), die pro Sim-Beat NACH der
 * Thread-Stage läuft (Beat-Reihenfolge aus docs/research/engine-architecture.md).
 *
 * Wie der Scheduler ist dies ENGINE-Code, der im Lua-VM läuft (kein Spiel-
 * skript): so bleibt der Unit-Zustand (`__pos`/`__heading`) kohärent in Lua und
 * es gibt keine per-Unit-Round-Trips pro Tick. Die Bewegungswerte kommen aus
 * dem Blueprint (`Physics.MaxSpeed/TurnRate/MaxAcceleration/MaxBrake`).
 *
 * Determinismus: Lua-5.4-Zahlen sind Doubles (nicht f32). Für Single-Player
 * ausreichend; bit-exaktes Lockstep folgt mit Gleis A (Lua-5.0-WASM).
 */

const MOTION_LUA = `
local DT = 0.1
local PI = math.pi
local atan2 = math.atan2 or math.atan  -- Lua 5.4: math.atan(y, x)

-- unit:GetNavigator() — SetGoal/AbortMove/AtGoal/GetGoalPos, an die Unit gebunden.
function __getNavigator(id)
  return {
    __id = id,
    SetGoal = function(self, pos)
      local u = __units[id]
      if u and pos then u.__goal = { pos[1] or pos.x or 0, pos[3] or pos.z or 0 } end
    end,
    AbortMove = function(self) local u = __units[id]; if u then u.__goal = false; u.__speed = 0 end end,
    AtGoal = function(self) local u = __units[id]; return not (u and u.__goal) end,
    GetGoalPos = function(self) local u = __units[id]; return u and (u.__goal and { u.__goal[1], 0, u.__goal[2] }) end,
    SetSpeedThroughGoal = function() end,
  }
end

-- Entity::AdvanceCoords: alle Units mit Ziel eine Tick-Länge bewegen.
function __advanceMotion()
  for id, u in pairs(__units) do
    local goal = u.__goal
    local p = u.__pos
    if goal and p then
      local phys = (u.__bp and u.__bp.Physics) or {}
      local maxSpeed = phys.MaxSpeed or 0
      local turnRate = phys.TurnRate or 90
      local accel = phys.MaxAcceleration or 2
      local brake = phys.MaxBrake or accel
      local fp = (u.__bp and u.__bp.Footprint) or {}
      local arrive = math.max(fp.SizeX or 1, fp.SizeZ or 1) / 2 + 0.15
      local dx = goal[1] - p[1]
      local dz = goal[2] - p[3]
      local dist = math.sqrt(dx * dx + dz * dz)
      local speed = u.__speed or 0
      if dist <= arrive or maxSpeed <= 0 then
        u.__goal = false
        u.__speed = 0
      else
        -- Drehung zum Ziel mit TurnRate
        local wanted = atan2(dx, dz)
        local diff = wanted - (u.__heading or 0)
        while diff > PI do diff = diff - 2 * PI end
        while diff < -PI do diff = diff + 2 * PI end
        local maxTurn = turnRate * PI / 180 * DT
        if math.abs(diff) <= maxTurn then u.__heading = wanted
        else u.__heading = (u.__heading or 0) + (diff > 0 and maxTurn or -maxTurn) end
        -- Zielgeschwindigkeit: voll wenn ausgerichtet, gedrosselt in der Kurve;
        -- vor dem Ziel bremsweggenau (v = sqrt(2·b·d))
        local aligned = math.abs(diff) < PI / 3
        local brakeLimit = math.sqrt(2 * brake * dist)
        local targetSpeed = math.min(aligned and maxSpeed or maxSpeed * 0.4, brakeLimit)
        local dv = targetSpeed - speed
        local maxA = accel * DT
        local maxB = brake * DT
        if dv > maxA then speed = speed + maxA
        elseif dv < -maxB then speed = speed - maxB
        else speed = targetSpeed end
        u.__speed = speed
        if speed > 0 then
          p[1] = p[1] + math.sin(u.__heading) * speed * DT
          p[3] = p[3] + math.cos(u.__heading) * speed * DT
        end
      end
    end
  end
end
`

/** Installiert Navigator + Physik-Fortschreibung im Lua-Host. */
export function installMotion(host: LuaHost): void {
  host.eval(MOTION_LUA)
}

/** Physik-Schritt eines Beats (nach der Thread-Stage). */
export function motionTick(host: LuaHost): void {
  host.eval('__advanceMotion()')
}
