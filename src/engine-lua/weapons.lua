-- =====================================================================
-- WEAPONS — the two engine tasks per weapon.
--
-- The engine attaches two tasks to EVERY weapon (CAiAttackerImpl::CreateWeapon,
-- Cfile:791794-791828) — but only if `ManualFire == false`:
--
--   CAcquireTargetTask::TaskTick  (Cfile:792838)  sucht Ziele
--       Rhythm: every ceil(TargetCheckInterval * 10) ticks
--   CFireWeaponTask::Dispatch (Cfile:983912) times the firing
--       Rhythm: EVERY tick
--
-- What the engine does NOT do: shoot. `UnitWeapon::Fire` (Cfile:985500)
-- calls `RunScript("OnFire")` — and nothing more. The Lua takes the shot in hers
-- Salven-Zustandsmaschine (defaultweapons.lua RackSalvoFiringState:582 ->
-- CreateProjectileAtMuzzle). Whoever creates a projectile here has the volleys,
-- Muzzles, reload times and effects of the original have been ignored.
--
-- STANDARD-LUA 5.4.
-- =====================================================================

--- Set the target of a weapon (Moho::UnitWeapon::SetTarget, Cfile:985364-985494).
---
--- The callbacks depend on the EDGE, not on the call:
--- no target -> target calls OnGotTarget (Cfile:985494)
--- Target -> no target calls OnLostTarget (Cfile:985364)
--- Both on the WEAPON. Whoever fires OnGotTarget with every tick starts it
--- Salvo FSM new every tick - the weapon would never fire.
function __weaponSetTarget(w, target, groundPos)
  local had = (w.__target ~= nil) or (w.__targetGround ~= nil)
  local has = (target ~= nil) or (groundPos ~= nil)

  w.__target = target
  w.__targetGround = groundPos

  if has and not had then
    w.__shotsAtTarget = 0
    if w.OnGotTarget then
      local ok, err = pcall(function() w:OnGotTarget() end)
      if not ok then WARN('OnGotTarget: ' .. tostring(err)) end
    end
  elseif had and not has then
    if w.OnLostTarget then
      local ok, err = pcall(function() w:OnLostTarget() end)
      if not ok then WARN('OnLostTarget: ' .. tostring(err)) end
    end
  end
end

--- DoInstaHit (Cfile:987034): a weapon without ProjectileId hits IMMEDIATELY.
--- The engine logs literally (“no projectile blueprint, doing instahit
--- instead", Cfile:985669).
function __weaponInstaHit(w)
  local bp = w.__bp or {}
  local t = w.__target
  if not t or not t.__pos then return end
  local u = w.__unit
  local p = t.__pos
  Damage(u, u.__pos, t, (bp.Damage or 0), bp.DamageType or 'Normal')
end

--- The sim's fire sound (the sim has no output — the UI VM does).
__simSounds = {}
function __simSoundRequested(cue)
  __simSounds[table.getn(__simSounds) + 1] = cue
end

-- ---------------------------------------------------------------------
-- Zielerfassung — CAcquireTargetTask::TaskTick (Cfile:792838-793228)
--
-- The search radius is a MAXIMUM, not a product:
--   radius = max(MaxRadius, TrackingRadius * MaxRadius)   (Cfile:793125-793132)
-- So TrackingRadius < 1 doesn't shrink anything.
--
-- DEVIATION, expressly named: the engine searches in the BLIPS of the unit
-- (mBlipsInRange — the reconnaissance DB, Cfile:793167). Our sim doesn't have one yet
-- Enlightenment; we take all living units of the enemy army in the radius. The
-- is a conscious deviation, not a replica (combat-projectiles.md §9).
-- ---------------------------------------------------------------------
local function canTarget(w, u, target)
  if target.__destroyQueued or target.__dead then return false end
  if target.__army == u.__army then return false end
  if target.__beingBuilt then return false end
  return true
end

local function acquireTarget(w, u)
  local bp = w.__bp or {}
  -- HoldFire (1) DELETES the target (Cfile:793085-793097).
  if (u.__fireState or 0) == 1 then
    __weaponSetTarget(w, nil, nil)
    return
  end
  if u.__beingBuilt then return end
  if w.__enabled == false then return end

  local maxRadius = w.__maxRadius or bp.MaxRadius or 0
  if maxRadius <= 0 then return end
  local radius = math.max(maxRadius, (bp.TrackingRadius or 1) * maxRadius)

  -- An ATTACK COMMAND (CAttackTargetTask sets the target via the
  -- AiAttacker on the weapons) has priority over free target search -
  -- As soon as the command target is within the search radius, the weapon fires at it.
  local forcedId = __attackOrders[u.__id]
  if forcedId then
    local ft = __units[forcedId]
    if ft and canTarget(w, u, ft) then
      local p, q = u.__pos, ft.__pos
      local dx, dz = q[1] - p[1], q[3] - p[3]
      if dx * dx + dz * dz <= radius * radius then
        __weaponSetTarget(w, ft, nil)
        return
      end
    end
  end

  -- If the old target is still there and is within range, it (the engine
  -- checks it via CanAttackTarget, Cfile:793034).
  local cur = w.__target
  if cur and canTarget(w, u, cur) then
    local p, q = u.__pos, cur.__pos
    local dx, dz = q[1] - p[1], q[3] - p[3]
    if dx * dx + dz * dz <= radius * radius then return end
  end

  local best, bestDist = nil, radius * radius
  for _, other in pairs(__units) do
    if canTarget(w, u, other) then
      local p, q = u.__pos, other.__pos
      local dx, dz = q[1] - p[1], q[3] - p[3]
      local d2 = dx * dx + dz * dz
      if d2 <= bestDist then
        best, bestDist = other, d2
      end
    end
  end
  __weaponSetTarget(w, best, nil)
end

-- ---------------------------------------------------------------------
-- Turret aiming — CAimManipulator::CheckTracking/Track (weapons.md par. 2c,
-- CAimManipulator.cpp:1239-1327/1386). Per tick the turret slews toward the
-- target direction (slew = TurretYawSpeed * DEG2RAD * 0.1, arc-clamped to
-- center ± half range) and the weapon may only FIRE while both axes are
-- within FiringTolerance (weapon->mCanFire = onTarget). Angles live in the
-- UNIT frame relative to the rest pose; the renderer applies them to the
-- yaw/pitch bones. Idle turrets keep their pose (structures never reset,
-- weapon.lua:94 SetResetPoseTime 9999999; the mobile reset timer is a
-- documented gap).
-- ---------------------------------------------------------------------
local function normalizeAngle(a)
  while a > math.pi do a = a - 2 * math.pi end
  while a < -math.pi do a = a + 2 * math.pi end
  return a
end

local function aimAxis(current, wanted, center, range, slew)
  -- Arc clamp (2c): c = clamp(normalize(desired - center), -half, +half);
  -- laneDelta = (c + center) - current, then slew-clamped.
  local delta
  if range and range < math.pi then
    local c = normalizeAngle(wanted - center)
    if c > range then c = range elseif c < -range then c = -range end
    delta = normalizeAngle((c + center) - current)
  else
    delta = normalizeAngle(wanted - current)
  end
  local step = delta
  if slew and slew > 0 then
    if step > slew then step = slew elseif step < -slew then step = -slew end
  end
  return normalizeAngle(current + step), normalizeAngle(current + step - wanted)
end

local function aimTick(w, u)
  local aim = w.__aim
  if not aim or aim.__destroyed then return end
  local t = w.__target
  local tp = nil
  if t and not t.__dead and not t.__destroyQueued then
    tp = __unitCollision(t)
  elseif w.__targetGround then
    tp = w.__targetGround
  end
  if not tp then
    aim.__onTarget = false
    return
  end
  local bp = w.__bp or {}
  local p = u.__pos or { 0, 0, 0 }
  local dx, dy, dz = tp[1] - p[1], tp[2] - (p[2] or 0), tp[3] - p[3]
  -- Desired yaw in the UNIT frame (world bearing minus unit heading).
  local wantedYaw = normalizeAngle(math.atan(dx, dz) - (u.__heading or 0))
  local dxz = math.sqrt(dx * dx + dz * dz)
  local wantedPitch = math.atan(dy, dxz)

  local tol = (bp.FiringTolerance or 0.01) * 0.017453292
  local yaw, yawErr = aimAxis(aim.__yaw or 0, wantedYaw,
    aim.__yawCenter or 0, aim.__yawRange, aim.__yawSlew)
  aim.__yaw = yaw
  local onTarget = math.abs(yawErr) <= tol
  if aim.__pitchBone then
    local pitch, pitchErr = aimAxis(aim.__pitch or 0, wantedPitch,
      aim.__pitchCenter or 0, aim.__pitchRange, aim.__pitchSlew)
    aim.__pitch = pitch
    if not bp.YawOnlyOnTarget and math.abs(pitchErr) > tol then onTarget = false end
  end
  aim.__onTarget = onTarget
end

-- ---------------------------------------------------------------------
-- Feuertakt — CFireWeaponTask::Dispatch (Cfile:983912-983959)
--
--   if (mFireClock) --mFireClock;
--   ... Gates ...
--   UnitWeapon::Fire()                 -> RunScript("OnFire")
--   mFireClock = (int)(10.0f / rof);   <- TRUNKIERT, in Ticks
--
-- RateOfFire 1 means: every 10 ticks = every second.
-- ---------------------------------------------------------------------
local function fireTick(w, u)
  if (w.__fireClock or 0) > 0 then
    w.__fireClock = w.__fireClock - 1
  end
  if w.__enabled == false then return end

  local bp = w.__bp or {}
  if bp.ManualFire then return end
  if (w.__fireClock or 0) > 0 then return end
  if (u.__fireState or 0) == 1 then return end -- HoldFire
  -- The fire gate (weapon->mCanFire, CAimManipulator::Track): a turreted
  -- weapon only fires while its aim is within FiringTolerance.
  if w.__aim and not w.__aim.__destroyed and not w.__aim.__onTarget then return end
  if not w.__target and not w.__targetGround then return end
  if u.__beingBuilt then return end

  -- Reichweite: CanAttackTarget (Cfile:983938). MinRadius sperrt zu nahe Ziele
  -- (TargetIsTooClose, Cfile:983942).
  local t = w.__target
  if t then
    if t.__destroyQueued or t.__dead then
      __weaponSetTarget(w, nil, nil)
      return
    end
    local p, q = u.__pos, t.__pos
    local dx, dz = q[1] - p[1], q[3] - p[3]
    local d2 = dx * dx + dz * dz
    local maxR = w.__maxRadius or bp.MaxRadius or 0
    local minR = w.__minRadius or bp.MinRadius or 0
    if d2 > maxR * maxR then return end
    if minR > 0 and d2 < minR * minR then return end
  end

  -- And now the Lua: OnFire starts the Salvo state machine.
  if w.OnFire then
    local ok, err = pcall(function() w:OnFire() end)
    if not ok then WARN('OnFire: ' .. tostring(err)) end
  end
  w.__shotsAtTarget = (w.__shotsAtTarget or 0) + 1

  local rof = w.__rateOfFire or bp.RateOfFire or 1
  if rof <= 0 then rof = 1 end
  w.__fireClock = math.floor(10 / rof)
end

-- ---------------------------------------------------------------------
-- CollisionBeam-Tick (Moho::CollisionBeamEntity::MotionTick @911386 +
-- CheckCollision): the interval counter counts per tick; he reaches
-- CollisionCheckInterval, the engine casts the beam from the muzzle
-- along their line of sight and calls out when the person hit CHANGES
-- OnImpact(type, entity) — the damage is done by the Lua (CollisionBeam.lua:186).
-- The maximum beam length is the weapon range (bp.MaxRadius) —
-- DERIVED (CheckCollision is not decompileable); a beam shoots
-- never further than his weapon can reach.
-- ---------------------------------------------------------------------
local function beamCast(beam)
  local w = beam.Weapon
  local u = w and w.unit
  if not u or u.__destroyQueued or u.__dead then return end
  local start, rot = __boneWorld(u, beam.__muzzleBone)
  -- The beam direction: in the original, the turret aiming directs the muzzle
  -- on target; our towers don't turn (yet) - so the cast aims like that
  -- the projectile shot at the center of the body of the CURRENT weapon target
  -- (same target semantics as fireTick). Without a goal: muzzle line of sight.
  local dir
  local aimZiel = w.__target
  if aimZiel and not aimZiel.__destroyed and not aimZiel.__destroyQueued then
    local c = __unitCollision(aimZiel)
    local dx = c[1] - start[1]
    local dy = c[2] - start[2]
    local dz = c[3] - start[3]
    local l = math.sqrt(dx * dx + dy * dy + dz * dz)
    if l > 0.001 then dir = { dx / l, dy / l, dz / l } end
  end
  dir = dir or __quatForward(rot)
  local maxLen = (w.__bp and w.__bp.MaxRadius) or 30
  beam.__beamBones[1] = { start[1], start[2], start[3] }
  beam.__beamOrient = rot

  -- Next hit along the beam: Ray bullet against all enemy units
  -- (the same body sphere as the projectile collision, __unitCollision).
  local bestT = maxLen
  local bestUnit = nil
  for _, ziel in pairs(__units) do
    if not ziel.__destroyed and not ziel.__destroyQueued and ziel ~= u
      and not IsAlly(ziel.__army, beam.__army) then
      local c, r = __unitCollision(ziel)
      local ox = c[1] - start[1]
      local oy = c[2] - start[2]
      local oz = c[3] - start[3]
      local t = ox * dir[1] + oy * dir[2] + oz * dir[3]
      if t > 0 and t < bestT + r then
        local px = start[1] + dir[1] * t
        local py = start[2] + dir[2] * t
        local pz = start[3] + dir[3] * t
        local d2 = (px - c[1]) ^ 2 + (py - c[2]) ^ 2 + (pz - c[3]) ^ 2
        if d2 <= r * r then
          local hitT = t - math.sqrt(r * r - d2)
          if hitT >= 0 and hitT < bestT then
            bestT = hitT
            bestUnit = ziel
          end
        end
      end
    end
  end

  -- Terrain: March in 1m increments until the beam dips below the ground.
  local terrainT = nil
  if not bestUnit or bestT > 1 then
    local schritt = 1
    local t = schritt
    while t < bestT do
      local y = start[2] + dir[2] * t
      local g = GetSurfaceHeight(start[1] + dir[1] * t, start[3] + dir[3] * t)
      if y <= g then terrainT = t break end
      t = t + schritt
    end
  end

  local impactType, impactEntity, endT
  if terrainT and terrainT < bestT then
    impactType, impactEntity, endT = 'Terrain', nil, terrainT
  elseif bestUnit then
    impactType, impactEntity, endT = 'Unit', bestUnit, bestT
  else
    impactType, impactEntity, endT = 'Air', nil, maxLen
  end
  beam.__beamBones[2] = {
    start[1] + dir[1] * endT,
    start[2] + dir[2] * endT,
    start[3] + dir[3] * endT,
  }

  -- OnImpact ONLY when the person hit changes (CollisionBeam.lua:182-185:
  -- "only executes this function when the thing it is touching changes").
  local kennung = impactType .. ':' .. tostring(impactEntity and impactEntity.__id or '')
  if kennung ~= beam.__lastImpact then
    beam.__lastImpact = kennung
    if beam.OnImpact then
      local ok, err = pcall(function() beam:OnImpact(impactType, impactEntity) end)
      if not ok then WARN('CollisionBeam OnImpact: ' .. tostring(err)) end
    end
  end
end

function __beamTick()
  local lebend = {}
  for _, beam in ipairs(__collisionBeams) do
    local u = beam.Weapon and beam.Weapon.unit
    if not beam.__destroyed and not beam.__destroyQueued and u and not u.__destroyed then
      lebend[#lebend + 1] = beam
      if beam.__enabled then
        -- Bone 0 follows the mouth EVERY tick; the collision check is running
        -- in the interval (MotionTick @911410: Counter, then CheckCollision).
        beam.__intervalCount = beam.__intervalCount + 1
        if beam.__intervalCount >= beam.__interval then
          beam.__intervalCount = 0
          local ok, err = pcall(function() beamCast(beam) end)
          if not ok then WARN('CollisionBeam: ' .. tostring(err)) end
        end
      end
    end
  end
  __collisionBeams = lebend
end

--- One weapon tick for all units. Runs BEFORE the thread stage because that
--- Salvo FSM uses the Lua coroutines: OnFire sets the state, and the
--- Thread-Scheduler laeuft ihn im selben Beat weiter.
function __weaponTick()
  -- Command queue head advance FIRST (TaskTick pops finished commands and
  -- starts the next, sim-core.md:211-252), then the attack orders.
  __ordersTick()
  -- Attack orders FIRST (CATtackTargetTask runs before the weapon tasks):
  -- they control movement within range, target acquisition below
  -- then prefers the command target.
  __attackTick()
  for _, u in pairs(__units) do
    if not u.__destroyQueued and not u.__dead and u.__weapons then
      for _, w in ipairs(u.__weapons) do
        if not w.__destroyed then
          local bp = w.__bp or {}
          if not bp.ManualFire then
            -- Zielsuche im Rhythmus TargetCheckInterval * 10 Ticks, aufgerundet
            -- mit CEIL (Cfile:792904-792908: `round(x) + (x>round(x))` = ceil,
            -- Minimum 1). With round-half-up we checked a tick at x.4x
            -- oft.
            local interval = math.max(1, math.ceil((bp.TargetCheckInterval or 3.0) * 10))
            if (__gameTick % interval) == 0 then
              local ok, err = pcall(function() acquireTarget(w, u) end)
              if not ok then WARN('Zielerfassung: ' .. tostring(err)) end
            end
            local okA, errA = pcall(function() aimTick(w, u) end)
            if not okA then WARN('Turret aim: ' .. tostring(errA)) end
            local ok, err = pcall(function() fireTick(w, u) end)
            if not ok then WARN('Feuertakt: ' .. tostring(err)) end
          end
        end
      end
    end
  end
  -- The continuous beams tick with the same beat (CollisionBeamEntity::MotionTick
  -- runs in the same sim stage as the weapon tasks).
  __beamTick()
end
