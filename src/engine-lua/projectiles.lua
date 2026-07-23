-- =====================================================================
-- PROJEKTILE — the engine page.
--
-- Division as in the original (docs/research/combat-projectiles.md §1):
--   Engine: generate, fly (Moho::Projectile::MotionTick), detect hits
--           (Projectile::CheckCollision), Einschlag melden (RunScript "OnImpact")
--   Lua: /lua/sim/Projectile.lua + the blueprint's <id>_script.lua —
--           Effekte, Schaden anrichten (DoDamage), Sound
--
-- The Lua decides NOTHING about trajectory and hits. She gets told them.
--
-- Belege (Cfile = IDA-Decomp):
--   PROJ_Create                       Cfile:946751-946800
--   Projectile::Projectile (Ctor)     Cfile:943313-944010
--   Projectile::MotionTick            Cfile:944040-944290   (dt = 0.1)
--   Projectile::Impact                Cfile:944692-944745   (OnImpact: 2 Args)
--   func_OnCollisionCheck             Cfile:945766-945830   (1 Arg, bool)
--   EImpactType                       Cfile:640486-640525
--   func_FindBlueprintScriptModule    Cfile:914189-914360
--
-- STANDARD LUA 5.4 (goes raw in host.eval, not through the FA transpiler).
-- =====================================================================

__projectiles = {}

-- EImpactType (Cfile:640486-640525) — the strings containing Projectile.lua:310-345
-- abfragt (ENT_GetImpactTypeString, Cfile:917363-917400).
local IMPACT_TERRAIN = 'Terrain'
local IMPACT_WATER = 'Water'
local IMPACT_AIR = 'Air'
local IMPACT_UNDERWATER = 'Underwater'
local IMPACT_UNIT = 'Unit'
local IMPACT_UNIT_AIR = 'UnitAir'
local IMPACT_UNIT_UNDERWATER = 'UnitUnderwater'

--- Which Lua class gets a blueprint (func_FindBlueprintScriptModule,
--- Cfile:914189-914360). For projectiles:
--- 1. Default: /lua/sim/projectile.lua, class "Projectile"
--- 2. bp.ScriptModule, otherwise from bp.Source: truncate to the LAST '_'
--- and append '_script.lua'
---      /projectiles/TDFGauss01/TDFGauss01_proj.bp
---        -> /projectiles/TDFGauss01/TDFGauss01_script.lua
--- 3. Class name: bp.ScriptClass, otherwise "TypeClass"
--- 4th file is missing -> default off (1)
local function projectileClass(bp)
  local path = bp.ScriptModule
  if not path or path == '' then
    local src = bp.Source or bp.BlueprintId or ''
    local cut = string.match(src, '^(.*)_[^_/]*$')
    if cut then path = cut .. '_script.lua' end
  end
  if path and exists(path) then
    local ok, mod = pcall(import, path)
    if ok and mod then
      local cls = mod[bp.ScriptClass or 'TypeClass']
      if cls then return cls end
    end
  end
  return import('/lua/sim/Projectile.lua').Projectile
end

--- Uniform distribution around an average (the Ctor draws TurnRate/MaxSpeed/
--- Acceleration/InitialSpeed je mit ±Range, Cfile:943520-943660).
local function jitter(mid, range)
  if not range or range == 0 then return mid or 0 end
  return (mid or 0) + (Random() * 2 - 1) * range
end

--- Moho::PROJ_Create — put a projectile into the world.
---
--- launcher: the entity that shoots (unit or weapon -> its unit)
--- pos/quat: starting pose in the WORLD
--- speed: amount of the initial speed (nil = InitialSpeed ​​from the bp)
--- ignoresAlly: the projectile flies through ALLIES. PROJ_Create
--- gets it as a parameter (Cfile:946751); Entity:CreateProjectile passes
--- fixed 1 (Cfile:930895), the weapon's blueprint field IgnoresAlly (Default 1,
--- weapons.md:599). Here nil means: ignore (the engine default).
function __projCreate(launcher, bpId, pos, quat, speed, damage, damageRadius, damageType, target, ignoresAlly)
  local key = string.lower(tostring(bpId))
  local bp = __registered.Projectile[key]
  if not bp then
    -- Exactly what the engine reported (Cfile:930793) — not a silent failure.
    error('CreateProjectile: Invalid blueprint ' .. tostring(bpId), 2)
  end

  local phys = bp.Physics
  local cls = projectileClass(bp)
  local p = cls()

  local id = __nextUnitId
  __nextUnitId = id + 1

  p.__isProj = true
  p.__bp = bp
  p.__id = id
  p.__army = (launcher and launcher.__army) or 1
  p.__brain = launcher and launcher.__brain
  p.__launcher = launcher
  p.__pos = { pos[1], pos[2], pos[3] }
  p.__orient = { quat[1], quat[2], quat[3], quat[4] }
  p.__bones = { names = {}, xform = {}, index = {} }
  p.__health = 1
  p.__fraction = 1

  -- Flight parameters from the blueprint (the defaults are set by the engine
  -- Struct Ctor, see blueprints.lua __projDefaults).
  p.__turnRate = jitter(phys.TurnRate, phys.TurnRateRange)       -- GRAD/Sekunde
  p.__maxSpeed = jitter(phys.MaxSpeed, phys.MaxSpeedRange)
  p.__accel = jitter(phys.Acceleration, phys.AccelerationRange)
  p.__trackTarget = phys.TrackTarget == true
  p.__velocityAlign = phys.VelocityAlign ~= false
  p.__stayUpright = phys.StayUpright == true
  p.__collideSurface = phys.CollideSurface ~= false
  p.__collideEntity = phys.CollideEntity ~= false
  p.__destroyOnWater = phys.DestroyOnWater == true
  -- Fly over allies (PROJ_Create parameter, default 1). Without this
  -- Filter died every shot of a building ACU in their OWN construction site,
  -- which is right next to her - the enemy remained unharmed.
  p.__ignoresAlly = ignoresAlly ~= false
  p.__target = target
  p.__damage = damage or 0
  p.__damageRadius = damageRadius or 0
  p.__damageType = damageType or 'Normal'

  -- mBallisticAcc = Gravitation * UseGravity (Cfile:943663-943668). The
  -- Sim gravity constant: 4.9 world meters/s^2 (PhysConstants).
  p.__ballistic = { 0, (phys.UseGravity ~= false) and -__simGravity or 0, 0 }

  -- Lebensdauer in TICKS (Cfile:943680: curTick + (Lifetime ± Range) * 10).
  p.__lifetimeEnd = __gameTick + math.floor(jitter(phys.Lifetime, phys.LifetimeRange) * 10)

  -- Starting speed: Forward axis of the starting pose * InitialSpeed
  -- (Cfile:943842-943854).
  local v0 = speed
  if not v0 then v0 = jitter(phys.InitialSpeed, phys.InitialSpeedRange) end
  local fwd = __quatForward(p.__orient)
  p.__vel = { fwd[1] * v0, fwd[2] * v0, fwd[3] * v0 }

  p.__impactType = false
  p.Trash = TrashBag()
  __projectiles[id] = p

  -- OnPreCreate, then OnCreate(inWater) — ONE argument (Cfile:943988). Exactly that
  -- erwartet z. B. TDFGauss01_script.lua:OnCreate(self, inWater).
  local inWater = p.__pos[2] < __waterLevel()
  if inWater and p.__destroyOnWater then
    p:Destroy()
    return p
  end
  if p.OnPreCreate then pcall(function() p:OnPreCreate() end) end
  local ok, err = pcall(function() p:OnCreate(inWater) end)
  if not ok then WARN('Projektil ' .. tostring(bp.BlueprintId) .. ': OnCreate — ' .. tostring(err)) end
  return p
end

--- The water level of the map. Without map loaded: 0 (no water).
function __waterLevel()
  return __mapWaterLevel or 0
end

-- ---------------------------------------------------------------------
-- The Impact (Moho::Projectile::Impact, Cfile:944692-944745)
-- ---------------------------------------------------------------------
local function impact(p, kind, target)
  p.__impactType = false
  if p.__destroyed then return end
  local ok, err = pcall(function() p:OnImpact(kind, target) end)
  if not ok then
    WARN('Projektil OnImpact(' .. tostring(kind) .. ') — ' .. tostring(err))
    p:Destroy()
  end
end

-- ---------------------------------------------------------------------
-- Collision (Projectile::CheckCollision, @0x69D1D0 — NOT decompilable).
--
-- What is secured (call list of the function): a SWEEPED route test of
-- the old to the new position (COGrid::GetEntityCollisionsInLine +
-- Wm3::DistVector3Segment3f::GetSquared), terrain from the heightfield
-- (CHeightField::Intersection), and the Lua filter self:OnCollisionCheck(other)
-- with ONE argument.
--
-- ASSUMPTION, expressly stated: we check the distance between the route and the center point
-- the bounding radius of the unit (from SizeX/SizeY/SizeZ). Whether the engine
-- Collision volume (box/sphere) is not occupied
-- (docs/research/combat-projectiles.md §9).
-- ---------------------------------------------------------------------
--- The collision sphere of a unit: center point = BODY CENTER (feet + SizeY/2),
--- Radius from the collision box SizeX/Y/Z (world meter, uel0001: 1/2/0.7).
---
--- The focus is not cosmetic: `u.__pos` are the FEET of unity.
--- A shot that flies past at body height was further from the feet
--- removed as the radius - point-blank shots went "through" the unit.
--- (The engine sweeps against the collision volume, CheckCollision is @0x69D1D0
--- cannot be decompiled - the sphere around the center of the body is the named one
--- Naeherung, combat-projectiles.md §9.)
function __unitCollision(u)
  local bp = u.__bp
  local sy = bp.SizeY or 1
  local r = math.max(bp.SizeX or 1, bp.SizeZ or 1, sy) * 0.5
  local p = u.__pos
  return { p[1], p[2] + sy * 0.5, p[3] }, math.max(r, 0.5)
end

--- Squared distance point <-> distance.
local function distSqSegment(a, b, c)
  local abx, aby, abz = b[1] - a[1], b[2] - a[2], b[3] - a[3]
  local acx, acy, acz = c[1] - a[1], c[2] - a[2], c[3] - a[3]
  local len = abx * abx + aby * aby + abz * abz
  local t = 0
  if len > 0 then
    t = (acx * abx + acy * aby + acz * abz) / len
    if t < 0 then t = 0 elseif t > 1 then t = 1 end
  end
  local dx = acx - abx * t
  local dy = acy - aby * t
  local dz = acz - abz * t
  return dx * dx + dy * dy + dz * dz
end

--- Does the projectile hit anything on its way from `from` to `to`?
--- Returns type of impact + entity hit (or nil).
local function checkCollision(p, from, to)
  -- 1. Entities. The engine asks the Lua BEFORE the collision: OnCollisionCheck.
  if p.__collideEntity then
    -- VERBUENDETE ueberfliegen: PROJ_Create bekommt `ignoresAlly` (Default 1,
    -- Cfile:930895; Weapon Blueprint IgnoresAlly, weapons.md:599). Only if the
    -- DamageData ausdruecklich CollideFriendly sagt (weapon.lua:294, Default
    -- false; the engine asks Projectile.lua:407 GetCollideFriendly), collides
    -- the projectile with its own units.
    local hitsAllies = not p.__ignoresAlly
      or (p.DamageData and p.DamageData.CollideFriendly == true)
    local army = p.__army

    for id, u in pairs(__units) do
      if not u.__destroyed and u ~= p.__launcher
        and (hitsAllies or not IsAlly(u.__army, army)) then
        local center, r = __unitCollision(u)
        if distSqSegment(from, to, center) <= r * r then
          -- The Lua filter (func_OnCollisionCheck, Cfile:945766): is asked
          -- the TARGET UNIT — unit.lua:972 OnCollisionCheck(self, other,
          -- firingWeapon): DisallowCollisions, Ally -> GetCollideFriendly,
          -- DoNotCollideList on both sides. projectile:OnCollisionCheck is the
          -- PROJECTIL-versus-PROJECTIL defense (projectile.lua:89-105 checks
          -- other:GetTrackingTarget — only projectiles have that) and is allowed here
          -- NOT run: his MISSILE x DIRECTFIRE rule would let any missile
          -- ignore any DIRECTFIRE tank. (The shooter's weapon
          -- does not carry our projectile with us - nil; the hull 972-1000 reads
          -- firing weapon not.)
          local pass = true
          if u.OnCollisionCheck then
            local ok, res = pcall(function() return u:OnCollisionCheck(p, nil) end)
            if ok then pass = res ~= false end
          end
          if pass then
            local under = u.__pos[2] < __waterLevel()
            local kind = IMPACT_UNIT
            if under then kind = IMPACT_UNIT_UNDERWATER
            elseif u.__layer == 'Air' then kind = IMPACT_UNIT_AIR end
            return kind, u
          end
        end
      end
    end
  end

  -- 2. Soil/Water. Terrain comes from the heightfield, water from the plain.
  if p.__collideSurface then
    local ground = GetSurfaceHeight(to[1], to[3])
    if to[2] <= ground then return IMPACT_TERRAIN, nil end
    local water = __waterLevel()
    if water > 0 and from[2] > water and to[2] <= water then
      return IMPACT_WATER, nil
    end
  end
  return nil, nil
end

-- ---------------------------------------------------------------------
-- Moho::Projectile::MotionTick (Cfile:944040-944290) — per tick, dt = 0.1 s.
--
-- Two things not to advise:
--   * the integration is TRAPEZOERMIG: pos += (v_old + v_new) * 0.05
--     (Cfile:944219-944228). Naive Euler shifts every trajectory.
--   * TurnRate is DEGREES/second and also works WITHOUT TrackTarget: it limits,
--     how quickly the orientation adapts to the speed
--     (mTurnRateDeg * 0.0017453292 = deg * pi/180 * 0.1 rad/Tick).
-- ---------------------------------------------------------------------
local DEG_PER_SEC_TO_RAD_PER_TICK = 0.0017453292

--- Rotate a quaternion to the direction of flight, at most `maxAngle` per tick.
local function alignToVelocity(q, v, maxAngle)
  local len = math.sqrt(v[1] * v[1] + v[2] * v[2] + v[3] * v[3])
  if len < 1e-6 then return q end
  local want = __orientFromDir({ v[1] / len, v[2] / len, v[3] / len })
  if maxAngle <= 0 then return want end
  -- Angle between the quaternions (dot -> cos(theta/2)).
  local dot = q[1] * want[1] + q[2] * want[2] + q[3] * want[3] + q[4] * want[4]
  if dot < 0 then
    want = { -want[1], -want[2], -want[3], -want[4] }
    dot = -dot
  end
  if dot > 0.9999 then return want end
  local theta = 2 * math.acos(math.min(1, dot))
  if theta <= maxAngle then return want end
  -- Slerp mit t = maxAngle / theta.
  local t = maxAngle / theta
  local sinT = math.sin(theta * 0.5)
  local a = math.sin((1 - t) * theta * 0.5) / sinT
  local b = math.sin(t * theta * 0.5) / sinT
  return {
    q[1] * a + want[1] * b, q[2] * a + want[2] * b,
    q[3] * a + want[3] * b, q[4] * a + want[4] * b,
  }
end

-- ---------------------------------------------------------------------
-- GUIDED AMMO — Moho::Projectile::UpdateTracking (@944367) with the
-- Quaternion helpers of the engine (all documented, docs/research/
-- verified-facts.md "Gelenkte Munition"):
--   QuatCrossAdd (@0x44F880): the rotation v1 -> v2 (half angle quat).
--   RotateQuatByAngle (@0x4EB740): limits a delta quat to `rads`;
--     If the target is CLOSER than the limit, it remains unchanged.
--   QuatFromVecRot (@0x69AA50): forward from the Quat, build Delta,
--     limit, then PRE-multiplied (quat = delta * quat).
-- ---------------------------------------------------------------------
local function quatCrossAdd(v1x, v1y, v1z, v2x, v2y, v2z)
  local l1 = math.sqrt(v1x * v1x + v1y * v1y + v1z * v1z)
  local l2 = math.sqrt(v2x * v2x + v2y * v2y + v2z * v2z)
  if l1 > 1e-9 then v1x, v1y, v1z = v1x / l1, v1y / l1, v1z / l1 end
  if l2 > 1e-9 then v2x, v2y, v2z = v2x / l2, v2y / l2, v2z / l2 end
  local ax, ay, az = v1x + v2x, v1y + v2y, v1z + v2z
  local al = math.sqrt(ax * ax + ay * ay + az * az)
  if al <= 1e-9 then return { 0, v1x, v1y, v1z } end -- antiparallel (occupied)
  ax, ay, az = ax / al, ay / al, az / al
  return {
    ax * v1x + ay * v1y + az * v1z, -- w = dot(half, v1)
    v1y * az - v1z * ay,            -- xyz = cross(v1, half)
    v1z * ax - v1x * az,
    v1x * ay - v1y * ax,
  }
end

local function rotateQuatByAngle(q, rads)
  local half = math.abs(rads * 0.5)
  if half >= 1.5707964 then return q end
  local qw, qx, qy, qz = q[1], q[2], q[3], q[4]
  local sinHalf = math.sin(half)
  local axisSq = qx * qx + qy * qy + qz * qz
  -- Target closer than the limit -> Delta remains (full rotation).
  if axisSq <= sinHalf * sinHalf then return q end
  if qw < 0 then sinHalf = -sinHalf end
  local al = math.sqrt(axisSq)
  return { math.cos(half), qx / al * sinHalf, qy / al * sinHalf, qz / al * sinHalf }
end

local function quatFromVecRot(q, rx, ry, rz, rads)
  local f = __quatForward(q)
  local d = rotateQuatByAngle(quatCrossAdd(f[1], f[2], f[3], rx, ry, rz), rads)
  -- PRE-multiply: neu = delta * alt.
  local dw, dx, dy, dz = d[1], d[2], d[3], d[4]
  local ow, ox, oy, oz = q[1], q[2], q[3], q[4]
  return {
    ow * dw - ox * dx - oy * dy - oz * dz,
    dw * ox + dx * ow + dy * oz - dz * oy,
    dw * oy - dx * oz + dy * ow + dz * ox,
    dw * oz + dx * oy - dy * ox + dz * ow,
  }
end

--- UpdateTracking (@944367): Get target position (center of body), while dead
--- Target ONLostTarget ONCE and continue flying to the last position;
--- Lead retention in two steps; the nose turns at most
--- TurnRate·0.1 degrees per tick; VelocityAlign puts v on the new nose.
--- (Still open as documented: ZigZag and StayUnderwater — no vanilla
--- Projectile of our test paths uses them; they follow with their own evidence test.)
local function updateTracking(p)
  local tgt = p.__target
  if tgt and not tgt.__destroyed and not tgt.__destroyQueued then
    local mitte = __unitCollision(tgt)
    -- Target speed from the REAL position difference of the last one
    -- Ticks (in the original GetVelocity from the Motion state).
    local prev = p.__tgtPrev
    if prev then
      p.__tgtVel = {
        (mitte[1] - prev[1]) * 10,
        (mitte[2] - prev[2]) * 10,
        (mitte[3] - prev[3]) * 10,
      }
    end
    p.__tgtPrev = mitte
    p.__goalPos = mitte
  elseif p.__trackTarget then
    -- Target lost: RunScript('OnLostTarget') + TrackTarget off (@944379).
    if p.OnLostTarget then p:OnLostTarget() end
    p.__trackTarget = false
    p.__tgtVel = nil
  end
  local goal = p.__goalPos
  if not goal then return end

  local gx, gy, gz = goal[1], goal[2], goal[3]
  -- Lead retention (@944470-944500): two-step via the
  -- Zielgeschwindigkeit, Zeitmass = Distanz / (MaxSpeed·0.1) Ticks.
  local tv = p.__tgtVel
  if p.__leadTarget and tv and p.__maxSpeed and p.__maxSpeed > 0 then
    local pos = p.__pos
    local speedProTick = p.__maxSpeed * 0.1
    for _ = 1, 2 do
      local dx, dy, dz = gx - pos[1], gy - pos[2], gz - pos[3]
      local ticks = math.sqrt(dx * dx + dy * dy + dz * dz) / speedProTick
      gx = goal[1] + tv[1] * 0.1 * ticks
      gy = goal[2] + tv[2] * 0.1 * ticks
      gz = goal[3] + tv[3] * 0.1 * ticks
    end
  end

  local pos = p.__pos
  p.__orient = quatFromVecRot(
    p.__orient,
    gx - pos[1], gy - pos[2], gz - pos[3],
    (p.__turnRate or 0) * DEG_PER_SEC_TO_RAD_PER_TICK
  )
  if p.__velocityAlign then
    -- func_VecSetLength: v = Forward · |v| (@944660-944676).
    local v = p.__vel
    local len = math.sqrt(v[1] * v[1] + v[2] * v[2] + v[3] * v[3])
    local f = __quatForward(p.__orient)
    v[1], v[2], v[3] = f[1] * len, f[2] * len, f[3] * len
  end
end

--- A quaternion whose +Z axis points in the direction of `d` (COORDS_Orient).
function __orientFromDir(d)
  local dx, dy, dz = d[1], d[2], d[3]
  -- Rotation from (0,0,1) to d.
  local dot = dz -- (0,0,1) . d
  if dot > 0.999999 then return { 1, 0, 0, 0 } end
  if dot < -0.999999 then return { 0, 0, 1, 0 } end -- 180 degrees around Y
  -- Achse = (0,0,1) x d
  local ax, ay = -dy, dx
  local w = 1 + dot
  local n = math.sqrt(ax * ax + ay * ay + w * w)
  return { w / n, ax / n, ay / n, 0 }
end

function __projectileTick()
  for id, p in pairs(__projectiles) do
    if p.__destroyed then
      __projectiles[id] = nil
    elseif p.__impactType then
      -- The impact is resolved in the NEXT tick (mImpactInterp >= 0,
      -- Cfile:944110-944116).
      local kind, target = p.__impactType, p.__impactTarget
      p.__impactTarget = nil
      impact(p, kind, target)
    else
      local v = p.__vel
      local vOld = { v[1], v[2], v[3] }

      if not p.__trackTarget then
        v[1] = v[1] + p.__ballistic[1] * 0.1
        v[2] = v[2] + p.__ballistic[2] * 0.1
        v[3] = v[3] + p.__ballistic[3] * 0.1
      else
        -- GUIDED: the nose turns towards the target (UpdateTracking @944367),
        -- then the projectile accelerates along the nose — the
        -- Tracking branch does NOT have ballistic acceleration
        -- (Cfile:944155-944211).
        updateTracking(p)
      end
      -- Acceleration along its own axis.
      if p.__accel ~= 0 then
        local f = __quatForward(p.__orient)
        v[1] = v[1] + f[1] * p.__accel * 0.1
        v[2] = v[2] + f[2] * p.__accel * 0.1
        v[3] = v[3] + f[3] * p.__accel * 0.1
      end
      if p.__velocityAlign then
        p.__orient = alignToVelocity(
          p.__orient, v, (p.__turnRate or 0) * DEG_PER_SEC_TO_RAD_PER_TICK
        )
      end
      if p.__maxSpeed and p.__maxSpeed ~= 0 then
        local len = math.sqrt(v[1] * v[1] + v[2] * v[2] + v[3] * v[3])
        if len > p.__maxSpeed then
          local s = p.__maxSpeed / len
          v[1], v[2], v[3] = v[1] * s, v[2] * s, v[3] * s
        end
      end

      -- TRAPEZ (Cfile:944219-944228).
      local from = { p.__pos[1], p.__pos[2], p.__pos[3] }
      local to = {
        from[1] + (vOld[1] + v[1]) * 0.05,
        from[2] + (vOld[2] + v[2]) * 0.05,
        from[3] + (vOld[3] + v[3]) * 0.05,
      }

      local kind, target = checkCollision(p, from, to)
      p.__pos = to
      if kind then
        p.__impactType = kind
        p.__impactTarget = target
        p.__pos = to
      elseif __gameTick >= p.__lifetimeEnd then
        -- Lebensdauer abgelaufen: Air bzw. Underwater (Cfile:944284-944289).
        p.__impactType = (to[2] < __waterLevel()) and IMPACT_UNDERWATER or IMPACT_AIR
      end
    end
  end
end

--- The state of all projectiles as JSON — the renderer draws them.
--- (No return value according to JS: a Lua table would remain in the wasmoon registry
--- hang, see units.lua.)
function __readAllProjectilesJson()
  local parts = {}
  local n = 0
  for id, p in pairs(__projectiles) do
    if not p.__destroyed then
      n = n + 1
      local pos = p.__pos
      local q = p.__orient
      parts[n] = string.format(
        '{"id":%d,"bp":%q,"x":%.6g,"y":%.6g,"z":%.6g,"qw":%.6g,"qx":%.6g,"qy":%.6g,"qz":%.6g}',
        id, tostring(p.__bp.BlueprintId), pos[1], pos[2], pos[3], q[1], q[2], q[3], q[4]
      )
    end
  end
  return '[' .. table.concat(parts, ',') .. ']'
end
