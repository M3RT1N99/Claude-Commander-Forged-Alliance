-- =====================================================================
-- The air motion -- Moho::CUnitMotion::CalcMoveAir (Cfile:969188-970006)
-- and what it calls: ComputeAirControl (968961-969184), the winged and the
-- hover orientation (968384-968648, 968873-968960), CalcWingedLift
-- (967793-967834), GetElevation (967776-967791), ShouldHoverInsteadOfLand
-- (967749-967775), CalcAirMovementDampingFactor (967834-967887), the
-- terrain look-ahead (STIMap::LookAheadForMaxTerrain 859169-859220), the
-- landing spot (Unit::PrepareMove 857914-858170), the PhysBody integrator
-- (sub_697B00 940931-940964 / sub_6978D0 940860-940930, inlined at
-- 969950-969975), the ground collision (HandleGroundCollision 967589-967745,
-- sub_698350 941347-941440), the air navigator's target and arrival
-- (CAiNavigatorAir::SetTarget 755824-755841, CUnitMotion::SetTarget
-- 965091-965180, CUnitMotion::Stop 965024-965060, CUnitMotion::AtTarget
-- 965877-965925, CAiNavigatorAir::Dispatch 756132-756236).
--
-- A flyer is a rigid body: the controller turns the desired velocity into
-- a force and the desired pose into a torque, and the body integrates them
-- with dt = 0.1 s (969959-969975). Mass = AverageDensity * SizeX * SizeY *
-- SizeZ, the inverse inertia tensor 1 / (InertiaTensor * mass)
-- (CUnitMotion ctor 964840-964854).
--
-- Not modelled, recorded rather than faked (docs/STATUS.md): the combat
-- tactics (ComputeAirCombatTactics 967997-968379 -- every unit flies in
-- ACS_Normal), the circling orientation (968649-968870, a hover here), the
-- carrier events (UMCE_1/2, with the force law near a carrier
-- 969122-969149), formations (the top-speed clamp of Unit::UpdateInfoCache
-- 953176-953196), the terrain collision geometry (one point, the body,
-- stands for it; the per-point margin 967704-967709 with it), the ogrid
-- reservation and the skirt test of the landing spot, the playable-rect
-- clamp of the target, the dead body's random tumble (969915-969949).
-- CUnitMotion::SetMotionTurnEvent (965543-965546) is an empty function in
-- the engine: nothing to run.
--
-- Quaternions here are (w, x, y, z); the engine's Wm3::Quaternionf keeps
-- the scalar in its first member (the decompiled `orient.x`, proven by
-- VAxes3::VAxes3 618197-618221 and CalcHoverOrientation 968921-968933).
--
-- STANDARD LUA 5.4 (goes raw into host.eval).
-- =====================================================================

local PI = math.pi
local INF = math.huge
local DT = 0.1
-- SimConVar_AirLookAheadMult, the console variable the look-ahead reads
-- (969634, 969645): 1.0 (register_AirLookAheadMult_SimConVarDef 1953727).
local AIR_LOOK_AHEAD_MULT = 1.0

local function qmul(a, b) return __qmul(a, b) end
local function qrot(q, v) return __qrot(q, v) end
local function qconj(q) return { q[1], -q[2], -q[3], -q[4] } end

local function vlen(v) return math.sqrt(v[1] * v[1] + v[2] * v[2] + v[3] * v[3]) end
local function vnorm(v)
  local l = vlen(v)
  if l <= 0 then return { 0, 0, 0 }, 0 end
  return { v[1] / l, v[2] / l, v[3] / l }, l
end
local function vdot(a, b) return a[1] * b[1] + a[2] * b[2] + a[3] * b[3] end
local function vcross(a, b)
  return { a[2] * b[3] - a[3] * b[2], a[3] * b[1] - a[1] * b[3], a[1] * b[2] - a[2] * b[1] }
end

-- func_VecSetLengthS: the vector scaled to the length (a zero vector stays).
local function setLength(v, len)
  local n, l = vnorm(v)
  if l <= 0 then return { 0, 0, 0 } end
  return { n[1] * len, n[2] * len, n[3] * len }
end

-- The rotation matrix columns of a quaternion (VAxes3::VAxes3, 618197-618221):
-- vX right, vY up, vZ forward.
local function axesOf(q)
  local w, x, y, z = q[1], q[2], q[3], q[4]
  return {
    vX = { 1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y) },
    vY = { 2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x) },
    vZ = { 2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y) },
  }
end

-- VAxes3::OrthoNormalize (618267-618300): the right axis from up x forward,
-- normalised; the forward from right x up; the up axis is the primary.
local function orthoNormalize(a)
  a.vX = vnorm(vcross(a.vY, a.vZ))
  a.vY = vnorm(a.vY)
  a.vZ = vcross(a.vX, a.vY)
end

-- func_MatrixToQuat_0 (620045-620100): the quaternion of an orthonormal
-- basis (the columns vX, vY, vZ), Shoemake's method.
local function quatOfAxes(a)
  local m00, m10, m20 = a.vX[1], a.vX[2], a.vX[3]
  local m01, m11, m21 = a.vY[1], a.vY[2], a.vY[3]
  local m02, m12, m22 = a.vZ[1], a.vZ[2], a.vZ[3]
  local tr = m00 + m11 + m22
  local w, x, y, z
  if tr > 0 then
    local s = math.sqrt(tr + 1) * 2
    w = 0.25 * s
    x = (m21 - m12) / s
    y = (m02 - m20) / s
    z = (m10 - m01) / s
  elseif m00 > m11 and m00 > m22 then
    local s = math.sqrt(1 + m00 - m11 - m22) * 2
    w = (m21 - m12) / s
    x = 0.25 * s
    y = (m01 + m10) / s
    z = (m02 + m20) / s
  elseif m11 > m22 then
    local s = math.sqrt(1 + m11 - m00 - m22) * 2
    w = (m02 - m20) / s
    x = (m01 + m10) / s
    y = 0.25 * s
    z = (m12 + m21) / s
  else
    local s = math.sqrt(1 + m22 - m00 - m11) * 2
    w = (m10 - m01) / s
    x = (m02 + m20) / s
    y = (m12 + m21) / s
    z = 0.25 * s
  end
  return { w, x, y, z }
end

-- The rotation vector to a quaternion (func_VecToQuatB, called at
-- 940911-940916; the helper has no decompiled body): the exponential map;
-- whether the engine's helper approximates for small angles is UNVERIFIED.
local function quatOfRotVec(v)
  local n, angle = vnorm(v)
  if angle <= 1e-9 then return { 1, 0, 0, 0 } end
  local s = math.sin(angle * 0.5)
  return { math.cos(angle * 0.5), n[1] * s, n[2] * s, n[3] * s }
end

-- sub_6C1070 (970515-970572): a quaternion to axis and angle -- the
-- normalised imaginary part and 2 * acos(w); nothing for a null rotation.
local function axisAngle(q)
  local v = { q[2], q[3], q[4] }
  local n, l = vnorm(v)
  if l * l <= 1e-6 then return { 1, 0, 0 }, 0 end
  local w = q[1]
  if w >= 1 then return n, 0 end
  -- w <= -1 gives `four` * 2.0 = 8.0 (970538, 970553; four = 4.0, 1971522)
  -- -- unreachable for a unit quaternion, whose imaginary part is null
  -- there and returns above.
  if w <= -1 then return n, 8.0 end
  return n, 2 * math.acos(w)
end

local function yawQuat(h) return { math.cos(h * 0.5), 0, math.sin(h * 0.5), 0 } end
local function yawOf(q)
  local f = axesOf(q).vZ
  return math.atan(f[1], f[3])
end

-- quat_45deg2 (1953658-1953676): the +90 degree turn about Y that makes the
-- right vector of a forward.
local QUAT_RIGHT = { math.cos(PI * 0.25), 0, math.sin(PI * 0.25), 0 }

local function bpOf(u) return u.__bp or {} end
local function airOf(u) return bpOf(u).Air or {} end
local function physOf(u) return bpOf(u).Physics or {} end
local function hasState(u, name) return (u.__unitStates and u.__unitStates[name]) == true end
local function setState(u, name, on)
  u.__unitStates = u.__unitStates or {}
  u.__unitStates[name] = on and true or nil
end
local function inCategory(u, name) return EntityCategoryContains(categories[name], u) end

local function waterLevel()
  return __mapWaterLevel or -10000
end

-- CHeightField::GetElevation, clamped to the water surface unless the
-- blueprint flies in water (CalcMoveAir 969412-969429).
local function surfaceUnder(u, x, z)
  local h = GetTerrainHeight(x, z)
  if airOf(u).FlyInWater then return h end
  local w = waterLevel()
  if w > h then return w end
  return h
end

-- STIMap::LookAheadForMaxTerrain (859169-859220): from one unit ahead the
-- highest cell of the heightfield block that the look-ahead's tier covers
-- (the tier from the map size and from half the distance, at least 1;
-- CHeightField::GetTierBoundsUWord 525225-525290), water-clamped unless
-- the unit flies in water; below one unit the plain elevation.
local function msb(n)
  local b = -1
  while n > 0 do n = n >> 1 b = b + 1 end
  return b
end
local function lookAheadForMaxTerrain(u, x, z, lookahead)
  local flyInWater = airOf(u).FlyInWater
  if lookahead >= 1.0 then
    local w, h = __mapSizeX or 256, __mapSizeZ or 256
    local v7 = math.min(w - 1, h - 1)
    local tier = math.min(msb(v7 - 1) + 1, msb(math.floor(lookahead * 0.5)) + 1)
    if tier < 1 then tier = 1 end
    local cx, cz = math.floor(x), math.floor(z)
    local top = __terrainMaxTier(tier, cx >> tier, cz >> tier)
    if flyInWater then return top end
    local wl = waterLevel()
    if wl > top then return wl end
    return top
  end
  return surfaceUnder(u, x, z)
end

-- The per-unit motion state (the CUnitMotion fields the air tick uses), made
-- on first use. The random cruise offset is drawn once per aircraft that is
-- not a POD, from +-SimConVar_RandomElevationOffset (1.0, Cfile:1953447)
-- through the sim's random stream (964906-964948; the engine's own
-- MT19937 sequence is not reproduced).
local function initAir(u)
  local st = u.__air
  if st then return st end
  local bp = bpOf(u)
  local sx, sy, sz = bp.SizeX or 1, bp.SizeY or 1, bp.SizeZ or 1
  local mass = (bp.AverageDensity or 0.49) * sx * sy * sz
  local ix, iy, iz = bp.InertiaTensorX or 0, bp.InertiaTensorY or 0, bp.InertiaTensorZ or 0
  if ix * iy * iz == 0 then
    -- RUnitBlueprint's derivation (647192-647199): a box.
    ix = (sz * sz + sy * sy) / 12
    iy = (sz * sz + sx * sx) / 12
    iz = (sy * sy + sx * sx) / 12
  end
  local p = u.__pos or { 0, 0, 0 }
  local q = yawQuat(u.__heading or 0)
  local off = { bp.CollisionOffsetX or 0, (bp.CollisionOffsetY or 0), bp.CollisionOffsetZ or 0 }
  local rp = qrot(q, off)
  st = {
    body = {
      pos = { p[1] + rp[1], p[2] + rp[2], p[3] + rp[3] },
      orient = q,
      vel = { 0, 0, 0 },
      impulse = { 0, 0, 0 },
      mass = mass > 0 and mass or 1,
      invInertia = { 1 / (ix * mass), 1 / (iy * mass), 1 / (iz * mass) },
      gravity = { 0, -__simGravity, 0 },
      offset = off,
    },
    target = { p[1], p[2], p[3] },
    layer = nil,
    height = INF,
    carrierEvent = 0,
    -- EAirCombatState: ACS_Normal is 0 (the ctor 964785); the numbers of
    -- the other states are read off the comparisons below (<=
    -- ACS_NormalTurn, == ACS_CombatTurn) -- UNVERIFIED as values, and never
    -- set here (no combat tactics).
    combatState = 0,
    curElevation = 0,
    targetElevation = surfaceUnder(u, p[1], p[3]),
    newElevation = 0,
    randomElevation = 0,
    preparationTick = 0,
    alwaysUseTopSpeed = false,
    prevVel = { 0, 0, 0 },
    stopped = false,
    force = { 0, 0, 0 },
    torque = { 0, 0, 0 },
  }
  if not inCategory(u, 'POD') then
    st.randomElevation = (Random() * 2 - 1) * 1.0
  end
  u.__air = st
  return st
end
__airInit = initAir

-- Unit::UpdateInfoCache (953100-953198, run every tick from Unit::OnTick
-- 952785): a flyer's top speed is Air.MaxAirspeed * speedMult /
-- CalcTransportLoadFactor (953164-953174); the formation clamp that
-- follows (953176-953196) is not modelled.
local function topSpeedOf(u)
  local mult = u.__speedMult or 1
  return (airOf(u).MaxAirspeed or 0) * mult / __transportLoadFactor(u)
end

-- Unit::CalcTransportLoadFactor (952480-952513): 1 without a transport
-- component; otherwise mTransportLoadFactor -- computed when it is below
-- 0 as (cargo mass + own mass) / own mass, written only for a positive own
-- mass (952497-952512), and cached. The field starts at -1 (the Unit ctor
-- 949682) and is reset to -1 by AttachTo / DetachFrom of the unit that is
-- attached (954392 / 954415: the cargo's own field, motion.lua), never by
-- a load on the transport's field. A transport's factor is therefore the
-- one of its first tick -- 1, no cargo yet -- for as long as the transport
-- is not itself attached and released: the retail engine does not slow a
-- loaded transport (docs/research/verified-facts.md).
function __transportLoadFactor(u)
  if not (__transportOf and __transportOf(u)) then return 1.0 end
  local cached = u.__transportLoadFactor or -1
  if cached < 0 then
    local bp = bpOf(u)
    local myMass = (bp.AverageDensity or 0.49) * (bp.SizeZ or 1) * (bp.SizeY or 1) * (bp.SizeX or 1)
    if myMass > 0 then
      local children = 0
      for _, e in ipairs(u.__attachedEntities or {}) do
        if e.__isUnit and e.__bp then
          local b = e.__bp
          children = children + (b.AverageDensity or 0.49) * (b.SizeZ or 1) * (b.SizeY or 1) * (b.SizeX or 1)
        end
      end
      cached = (children + myMass) / myMass
      u.__transportLoadFactor = cached
    end
  end
  return cached
end

-- CUnitMotion::ShouldHoverInsteadOfLand (967749-967775).
local function shouldHoverInsteadOfLand(u)
  if (airOf(u).TransportHoverHeight or 0) <= 0 then return false end
  if hasState(u, 'TransportLoading') then return true end
  local t = __transportOf and __transportOf(u)
  if t and #__transportLoadedUnits(t, false) > 0 then return true end
  return false
end

-- CUnitMotion::GetElevation (967776-967791): the cruise elevation --
-- Physics.Elevation plus the random offset; under a carrier event the
-- pinned height or a quarter of it.
local function getElevation(u, st)
  local elev = physOf(u).Elevation or 0
  if st.carrierEvent ~= 1 then return elev + st.randomElevation end
  if st.height == INF then return elev * 0.25 end
  if st.height <= u.__pos[2] then return elev * 0.25 end
  return st.height - st.targetElevation
end

-- CUnitMotion::CalcWingedLift (967793-967834): the vertical desire of a
-- winged unit -- (up.y - 0.5) * LiftFactor, a climb back to half the cruise
-- elevation when banked past the lift, the caller's cap otherwise.
local function calcWingedLift(u, st, max, upY)
  local targetElev = getElevation(u, st)
  local lift = (upY - 0.5) * (airOf(u).LiftFactor or 5)
  if lift <= 0 then
    local v8 = targetElev * 0.5
    if v8 > st.curElevation then return v8 - st.curElevation end
  elseif max <= lift then
    return max
  end
  return lift
end

-- CUnitMotion::CalcAirMovementDampingFactor (967834-967887).
local function dampingFactor(u, st, desired)
  if inCategory(u, 'TARGETCHASER') then return 1.0 end
  local air = airOf(u)
  local kMove = air.KMove or 1
  local topSpeed = st.topSpeed
  local speed = math.min(vlen(desired), topSpeed)
  local denom = math.max(speed, 1.0)
  if topSpeed <= denom then return kMove end
  local r = topSpeed / denom
  local cap = air.KMoveDamping or 1
  if r > cap then return cap end
  return r
end

-- CUnitMotion::CalcHoverOrientation (968873-968960): the up axis leans
-- with the change of velocity since the last tick (its component along the
-- body's forward removed unless BankForward), scaled by BankFactor and the
-- height fraction, less gravity * 0.1; the forward is the desired one.
local function calcHoverOrientation(u, st, desiredForward)
  local body = st.body
  local air = airOf(u)
  local rel = { body.vel[1] - st.prevVel[1], body.vel[2] - st.prevVel[2], body.vel[3] - st.prevVel[3] }
  if not air.BankForward then
    local fwd = axesOf(body.orient).vZ
    local l2 = vdot(fwd, fwd)
    if l2 > 0 then
      local k = vdot(fwd, rel) / l2
      rel = { rel[1] - fwd[1] * k, rel[2] - fwd[2] * k, rel[3] - fwd[3] * k }
    end
  end
  local elev = physOf(u).Elevation or 0
  local ratio = elev > 0 and math.min(st.curElevation / elev, 1.0) or 1.0
  local bank = (air.BankFactor or 0.5) * ratio
  local g = body.gravity
  return {
    vX = { 1, 0, 0 },
    vY = { rel[1] * bank - g[1] * 0.1, rel[2] * bank - g[2] * 0.1, rel[3] * bank - g[3] * 0.1 },
    vZ = { desiredForward[1], desiredForward[2], desiredForward[3] },
  }
end

-- CUnitMotion::CalcWingedOrientation (968384-968648).
--   forward: the unit's forward in the XZ plane (a1); desired: the desired
--   velocity (a3); desiredNorm: its direction (a4); desiredXZ: its XZ part (a5).
-- Returns the axes, the velocity the controller chases (a7) and the turn
-- multiplier (unchanged in ACS_Normal).
local function calcWingedOrientation(u, st, forward, desired, desiredNorm, desiredXZ, turnMult, upY)
  local air = airOf(u)
  local phys = physOf(u)
  local right = qrot(QUAT_RIGHT, forward)
  local topSpeed = st.topSpeed
  local v53 = math.sqrt(desired[1] * desired[1] + desired[3] * desired[3])
  local v54 = math.min(v53, topSpeed)
  local startTurn = air.StartTurnDistance or 0
  local v52 = startTurn > v54
  local guarding = hasState(u, 'Guarding')
  local v57, out
  if not v52 or guarding or st.combatState ~= 0 then
    v57 = { desiredNorm[1], desiredNorm[2], desiredNorm[3] }
    out = { forward[1] * v54, forward[2] * v54, forward[3] * v54 }
    if st.combatState <= 3 then
      local v25 = vdot(desiredNorm, forward)
      local v27 = math.max(0.5, v25)
      local v28 = v27
      if guarding and v52 then
        local v26 = 0.5
        if startTurn > 0 and v54 / startTurn > 0.5 then v26 = v54 / startTurn end
        if v26 <= v27 then v28 = v26 end
      end
      out = { out[1] * v28, out[2] * v28, out[3] * v28 }
    end
    out[2] = calcWingedLift(u, st, desired[2], upY)
  else
    v57 = { desiredXZ[1], desiredXZ[2], desiredXZ[3] }
    out = { desired[1], desired[2], desired[3] }
  end
  -- The desired heading in the XZ plane.
  local dirXZ, a3a = vnorm({ v57[1], 0, v57[3] })
  local Y, z = dirXZ[1], dirXZ[3]
  if a3a <= 0 then Y, z = 0, 0 end
  local a7a = (vdot(right, v57) >= 0) and 1.0 or -1.0
  local delta = math.atan(Y, z) - math.atan(forward[1], forward[3])
  if delta > PI then delta = delta - 2 * PI elseif delta < -PI then delta = delta + 2 * PI end
  local turnSpeed = (st.combatState == 2) and (air.CombatTurnSpeed or 1) or (air.TurnSpeed or 1)
  local step = turnSpeed * 0.1
  local a3c = delta
  if a3c > step then a3c = step end
  if a3c < -step then a3c = -step end
  -- The forward the controller chases: the current forward turned by the
  -- per-tick step, taken a whole second ahead (a3c * 10, half-angle * 0.5).
  local a5a = a3c * 10.0 * 0.5
  local turnQ = { math.cos(a5a), 0, math.sin(a5a), 0 }
  -- Only x and z take the turned forward; y stays the desired direction's
  -- (968576-968579), and the whole is normalised -- the nose pitches with
  -- the climb, and the bank below leans by that y.
  local rot = qrot(turnQ, forward)
  local newFwd = vnorm({ rot[1], v57[2], rot[3] })
  -- The bank.
  local v37 = v52 and 0.5 or 1.0
  local a3d = v37
  if startTurn > 0 and v54 / startTurn <= v37 then a3d = v54 / startTurn end
  local bankFactor = air.BankFactor or 0.5
  local v38 = Y * forward[1] + z * forward[3]
  if st.combatState == 3 then
    v38 = (v38 * v38) * (v38 * v38) * ((v38 * v38) * (v38 * v38))
    bankFactor = bankFactor * 10.0
  end
  local v75 = 1.0 - math.max(0, v38)
  local v40 = 1.0
  if hasState(u, 'MovingDown') and (phys.Elevation or 0) > 0 then v40 = st.curElevation / phys.Elevation end
  local a3h = v40 * v75 * bankFactor * a3d * a7a
  local v42 = newFwd[2] * a3d
  local lean = { Y * v42, 0, z * v42 }
  local newRight = qrot(QUAT_RIGHT, newFwd)
  local up = vnorm({ a3h * newRight[1] - lean[1], 1.0 + a3h * newRight[2] - lean[2], a3h * newRight[3] - lean[3] })
  local axes = { vX = { 1, 0, 0 }, vY = up, vZ = newFwd }
  if st.combatState == 2 then
    turnMult = turnMult + (air.TightTurnMultiplier or 1) * v75
  elseif st.combatState == 1 or st.combatState == 3 then
    turnMult = turnMult + v75
  end
  return axes, out, turnMult
end

-- CUnitMotion::ComputeAirControl (968961-969184): the desired pose from the
-- winged or the hover orientation, the torque from the pose error (P) and
-- the angular momentum (D), the force from the desired velocity (KMove) and
-- the damping factor, the lift from KLift/KLiftDamping, gravity
-- pre-compensated, everything scaled by the mass; the torque into the
-- world frame through the inertia tensor.
local function computeAirControl(u, st, desired, forward, upY)
  local air = airOf(u)
  local body = st.body
  local lf = __transportLoadFactor(u)
  local turnMult = (air.KTurn or 3) / lf
  local roll = (air.KRoll or 3) / lf
  local lift = (air.KLift or 1) / lf
  local desiredNorm = vnorm(desired)
  local desiredXZ = { desired[1], 0, desired[3] }
  local v67 = { desired[1], desired[2], desired[3] }
  local axes
  local winged = air.Winged == true
  if (not winged or st.carrierEvent == 2)
    and (not hasState(u, 'Guarding') or hasState(u, 'Moving') or hasState(u, 'Ferrying')
      or hasState(u, 'Attacking') or hasState(u, 'Building') or hasState(u, 'Repairing')) then
    -- The circling orientation (a focus entity under work, or an attack
    -- target) is the hover here: no target model (docs/STATUS.md). The
    -- force law near a carrier (UMCE_2, 969122-969149) is not run either:
    -- carrierEvent never becomes 2 here.
    axes = calcHoverOrientation(u, st, desiredXZ)
    st.v41 = 0
  else
    axes, v67, turnMult = calcWingedOrientation(u, st, forward, desired, desiredNorm, desiredXZ, turnMult, upY)
  end
  orthoNormalize(axes)
  local qDesired = quatOfAxes(axes)
  -- The rotation from the body's pose to the desired one in the BODY frame
  -- (conj(mOrientation) * desired, the product terms at 969082-969098),
  -- the frame the angular momentum below is in; the shortest way.
  local delta = qmul(qconj(body.orient), qDesired)
  if delta[1] < 0 then delta = { -delta[1], -delta[2], -delta[3], -delta[4] } end
  local axis, angle = axisAngle(delta)
  local v59 = { axis[1] * angle, axis[2] * angle, axis[3] * angle }
  -- The angular momentum in the body frame, negated (969111-969120).
  local local_ = qrot(qconj(body.orient), body.impulse)
  local dest = { -body.invInertia[1] * local_[1], -body.invInertia[2] * local_[2], -body.invInertia[3] * local_[3] }
  local v61 = dampingFactor(u, st, desired)
  local kMove = air.KMove or 1
  local vel = body.vel
  local fx = v67[1] * kMove + (-vel[1]) * v61
  local fy = (air.KLiftDamping or 1) * (-vel[2]) + v67[2] * lift
  local fz = v67[3] * kMove + (-vel[3]) * v61
  local kTurnD = air.KTurnDamping or 3
  local torque = {
    dest[1] * kTurnD + v59[1] * turnMult,
    dest[2] * kTurnD + v59[2] * turnMult,
    (air.KRollDamping or 3) * dest[3] + v59[3] * roll,
  }
  local g = body.gravity
  local mass = body.mass
  st.force = { (fx - g[1]) * mass, (fy - g[2]) * mass, (fz - g[3]) * mass }
  local inertial = { torque[1] / body.invInertia[1], torque[2] / body.invInertia[2], torque[3] / body.invInertia[3] }
  st.torque = qrot(body.orient, inertial)
end

-- sub_6978D0 (940860-940930): the angular integration -- the impulse gains
-- torque * dt (940867-940870), the trapezoid of the old and the new
-- impulse over the tick ((new + old) * dt * 0.5, 940871-940875) in the body
-- frame times the inverse inertia is the rotation of the tick
-- (940891-940896), applied as a body-local quaternion (940897-940906).
local function integrateAngular(body, torque, dt)
  local old = body.impulse
  local new = { old[1] + torque[1] * dt, old[2] + torque[2] * dt, old[3] + torque[3] * dt }
  body.impulse = new
  local half = dt * 0.5
  local avg = { (new[1] + old[1]) * half, (new[2] + old[2]) * half, (new[3] + old[3]) * half }
  local local_ = qrot(qconj(body.orient), avg)
  local rot = { body.invInertia[1] * local_[1], body.invInertia[2] * local_[2], body.invInertia[3] * local_[3] }
  local q = qmul(body.orient, quatOfRotVec(rot))
  local n = math.sqrt(q[1] * q[1] + q[2] * q[2] + q[3] * q[3] + q[4] * q[4])
  if n > 0 then q = { q[1] / n, q[2] / n, q[3] / n, q[4] / n } end
  body.orient = q
end

-- SPhysBody::GetImpulse (941106-941130): the body's angular velocity in
-- the world, R * I^-1 * R^T * L -- the angular impulse in the body's
-- axes, scaled by the inverse inertia, back into the world.
local function bodyAngVel(body)
  local axes = axesOf(body.orient)
  local L = body.impulse
  local lx = body.invInertia[1] * vdot(L, axes.vX)
  local ly = body.invInertia[2] * vdot(L, axes.vY)
  local lz = body.invInertia[3] * vdot(L, axes.vZ)
  return {
    lx * axes.vX[1] + ly * axes.vY[1] + lz * axes.vZ[1],
    lx * axes.vX[2] + ly * axes.vY[2] + lz * axes.vZ[2],
    lx * axes.vX[3] + ly * axes.vY[3] + lz * axes.vZ[3],
  }
end

-- The linear step inlined in CalcMoveAir (969959-969973): semi-implicit
-- Euler on the velocity with gravity, the trapezoid on the position.
local function integrateLinear(body, force, dt)
  local a = dt / body.mass
  local g = body.gravity
  local old = body.vel
  local new = { old[1] + force[1] * a + g[1] * dt, old[2] + force[2] * a + g[2] * dt, old[3] + force[3] * a + g[3] * dt }
  body.vel = new
  body.pos = {
    body.pos[1] + (new[1] + old[1]) * 0.5 * dt,
    body.pos[2] + (new[2] + old[2]) * 0.5 * dt,
    body.pos[3] + (new[3] + old[3]) * 0.5 * dt,
  }
end

-- HandleGroundCollision (967589-967745) with sub_698350 (941347-941443):
-- the terrain collision geometry's points against the heightfield, and
-- for the colliding points that move down the impulse that stops them,
-- damped by 0.9, and the lift by the deepest penetration. One point stands
-- for the geometry here: the entity's own position, without the per-point
-- margin (Elevation + the point's w - bp+780, 967704-967709;
-- docs/STATUS.md). True when a point touches the ground or, for a unit
-- that does not fly in water, the water.
local function handleGroundCollision(u, st)
  local bp = bpOf(u)
  local body = st.body
  local limit = math.max(bp.SizeY or 1, bp.SizeZ or 1) * 2.0
  if st.curElevation > limit then return false end
  local off = qrot(body.orient, body.offset)
  local px, py, pz = body.pos[1] - off[1], body.pos[2] - off[2], body.pos[3] - off[3]
  local ground = GetTerrainHeight(px, pz)
  local hit = false
  if py <= ground then
    hit = true
    -- sub_698350 (941347-941443) for the one point: its lever arm r from
    -- the body's centre (941397-941400), its velocity v + w x r with the
    -- angular velocity of GetImpulse (941403-941405); when it moves down
    -- (941406) the linear impulse -v/2 and the angular impulse
    -- r x (-m v/2) go on the body (941421-941436; the mass is the body's
    -- second float there, v2[1] -- UNVERIFIED as a struct offset, read as
    -- mMass because the angular impulse of a linear impulse is r x m dv),
    -- both damped by 0.9 (941427-941429, 941437-941439), and the body is
    -- lifted by the deepest penetration (941442). A point that already
    -- moves up leaves the body where it is.
    local r = { -off[1], -off[2], -off[3] }
    local w = bodyAngVel(body)
    local v = body.vel
    local vp = {
      v[1] + w[2] * r[3] - w[3] * r[2],
      v[2] + w[3] * r[1] - w[1] * r[3],
      v[3] + w[1] * r[2] - w[2] * r[1],
    }
    if vp[2] < 0 then
      local lin = { -vp[1] * 0.5, -vp[2] * 0.5, -vp[3] * 0.5 }
      local ang = vcross(r, lin)
      body.impulse = {
        (body.impulse[1] + body.mass * ang[1]) * 0.9,
        (body.impulse[2] + body.mass * ang[2]) * 0.9,
        (body.impulse[3] + body.mass * ang[3]) * 0.9,
      }
      body.vel = { (v[1] + lin[1]) * 0.9, (v[2] + lin[2]) * 0.9, (v[3] + lin[3]) * 0.9 }
      body.pos[2] = body.pos[2] + (ground - py)
    end
  end
  local water = false
  if not airOf(u).FlyInWater then water = waterLevel() >= py end
  return hit or water
end
__airGroundCollision = handleGroundCollision

-- Unit::PrepareMove for a flyer (857914-858267): a square footprint of the
-- larger side, the land cap, plus the water cap when a CANLANDONWATER
-- unit's target lies under water (858041-858049: decided once, from the
-- target -- a water cell fits only then), the target cell itself when it
-- fits (858060-858103), else the perimeter of rings in steps of twice the
-- footprint (858104-858225): every fitting cell of a ring is collected and
-- the one nearest the unit's own position wins (858230-858256), 900
-- candidates at most (858135). The fit is __footprintFitsAt plus the
-- water rule; the ogrid reservation (CanReserveOgridRect) and the skirt
-- test are not modelled. Returns the landing position or nil.
local function prepareMove(u, tx, tz)
  local bp = bpOf(u)
  local fp = bp.Footprint or {}
  local size = math.max(fp.SizeX or 1, fp.SizeZ or 1, 1)
  local waterCap = inCategory(u, 'CANLANDONWATER') and waterLevel() > GetTerrainHeight(tx, tz)
  local function fits(x, z)
    if x < 0 or z < 0 or x >= (__mapSizeX or 256) or z >= (__mapSizeZ or 256) then return false end
    if not waterCap and waterLevel() > GetTerrainHeight(x, z) then return false end
    return __footprintFitsAt(u, x, z)
  end
  if fits(tx, tz) then return tx, tz end
  local step = 2 * size
  local tried = 0
  local p = u.__pos
  for ring = 1, 30 do
    local bestX, bestZ, bestD
    for ix = -ring, ring do
      for iz = -ring, ring do
        if math.max(math.abs(ix), math.abs(iz)) == ring then
          tried = tried + 1
          if tried > 900 then return nil end
          local x, z = tx + ix * step, tz + iz * step
          if fits(x, z) then
            local dx, dz = x - p[1], z - p[3]
            local d = dx * dx + dz * dz
            if bestD == nil or d < bestD then bestX, bestZ, bestD = x, z, d end
          end
        end
      end
    end
    if bestD ~= nil then return bestX, bestZ end
  end
  return nil
end

-- The layer name of the motion's target layer.
local function unitLayer(u) return u.__layer end

-- === The navigator side ===

--- CAiNavigatorAir::SetTarget (755824-755841) + CUnitMotion::SetTarget
--- (965091-965180): the target position and layer -- LAYER_None becomes
--- Air for a flyer in the navigator (755838-755841; CUnitMotion::SetTarget
--- itself keeps mLayer on LAYER_None, 965149) -- mPreparationTick when
--- nothing is queued, MovingUp/MovingDown cleared. The playable-rect clamp
--- is not modelled.
function __airSetTarget(u, x, y, z, layer)
  local st = initAir(u)
  st.stopped = false
  st.target = { x, y or GetSurfaceHeight(x, z), z }
  if layer == nil or layer == 'None' then layer = 'Air' end
  st.layer = layer
  if not (__orders and __orders[u.__id] and __orders[u.__id][1]) and not (__orderActive and __orderActive[u.__id]) then
    st.preparationTick = __gameTick or 0
  end
  setState(u, 'MovingUp', nil)
  setState(u, 'MovingDown', nil)
end

--- CAiNavigatorAir::AbortMove for a flyer (756062-756096): the stop point
--- is Unit::PredictAheadBomb(unit, 1.0) (858914-858975) -- the per-tick
--- velocity (Entity::GetVelocity 915398-915413) followed for prec * 10
--- steps, turned every step by the yaw of GetImpulse's y * 0.1 (the
--- body's angular velocity in the world, 941106-941130;
--- func_EulerRollToQuat 717842-717855: the half-angle about the up
--- axis), the last fractional step scaled, y left as it is -- and
--- CUnitMotion::Stop (965024-965077) makes it the target, the layer Air
--- unless loading, unloading or ferrying (965033-965040), the waypoint
--- cleared.
function __airStop(u)
  local st = initAir(u)
  st.stopped = true
  if not hasState(u, 'TransportUnloading') and not hasState(u, 'TransportLoading') and not hasState(u, 'Ferrying') then
    st.layer = 'Air'
  end
  local p = u.__pos
  local body = st.body
  local v = { body.vel[1] * DT, body.vel[2] * DT, body.vel[3] * DT }
  local half = bodyAngVel(body)[2] * 0.1 * 0.5
  local q = { math.cos(half), 0, math.sin(half), 0 }
  local x, z = p[1], p[3]
  local n = 1.0 * 10.0
  while n > 0 do
    v = qrot(q, v)
    local sx, sz = v[1], v[3]
    if n <= 1.0 then sx, sz = sx * n, sz * n end
    x, z = x + sx, z + sz
    n = n - 1.0
  end
  st.target = { x, p[2], z }
end

--- CUnitMotion::AtTarget (965877-965925): on the target layer, within
--- 0.25 (or a quarter of the top speed when always at top speed; not a
--- quarter for a winged unit), or parked (Hover, or Top with a pinned
--- height).
function __airAtTarget(u)
  local st = initAir(u)
  if st.layer and unitLayer(u) ~= st.layer then return false end
  local p = u.__pos
  local dx, dz = st.target[1] - p[1], st.target[3] - p[3]
  local dist = math.sqrt(dx * dx + dz * dz)
  local v5 = 0.25
  if st.alwaysUseTopSpeed then
    local v8 = (airOf(u).MaxAirspeed or 0) * (u.__speedMult or 1)
    if not airOf(u).Winged then v8 = v8 * 0.25 end
    if v8 > 0.25 then v5 = v8 end
  end
  if v5 < dist then
    local ev = u.__vertEvent or 'Bottom'
    if ev ~= 'Hover' and (ev ~= 'Top' or st.height == INF) then return false end
  end
  return true
end

-- === CalcMoveAir ===

--- One tick of a flyer (CalcMoveAir 969188-970006). The unit's pose is
--- read from and written back to __pos / __orient / __heading.
function __airStep(u)
  local st = initAir(u)
  local body = st.body
  local bp = bpOf(u)
  local air = airOf(u)
  local phys = physOf(u)
  st.topSpeed = topSpeedOf(u)
  -- Unit::MotionTick (966189-966202): mPreparationTick is 0 while a command
  -- is queued and the tick the unit became idle otherwise -- the
  -- AutoLandTime countdown starts from there.
  local id = u.__id
  if (__orderActive and __orderActive[id]) or (__orders and __orders[id] and __orders[id][1]) then
    st.preparationTick = 0
  elseif st.preparationTick == 0 then
    st.preparationTick = __gameTick or 0
  end
  -- mAlwaysUseTopSpeed: the steering's CalcAtTopSpeed (787876-787902) sets
  -- it; a winged unit cannot hover, so it is read as always at top speed
  -- here, a hover flyer through the speed-through flag -- which condition
  -- the steering really tests is UNVERIFIED (docs/STATUS.md).
  st.alwaysUseTopSpeed = air.Winged == true or u.__speedThroughGoal == true
  -- The body from the entity's transform (969397-969411).
  local q = u.__orient and { u.__orient[4], u.__orient[1], u.__orient[2], u.__orient[3] } or yawQuat(u.__heading or 0)
  body.orient = q
  local off = qrot(q, body.offset)
  local p = u.__pos
  body.pos = { p[1] + off[1], p[2] + off[2], p[3] + off[3] }
  local axes = axesOf(q)
  local forward = vnorm({ axes.vZ[1], 0, axes.vZ[3] })
  local upY = axes.vY[2]
  -- Entity::GetVelocity (915398-915413) is the per-tick displacement
  -- (mCurTransform - mLastTransform, times mCurImpactSomething = 1.0,
  -- 914881; Unit::GetVelocity takes that path in the Air layer,
  -- 953299-953306): the body's m/s velocity times dt. The event thresholds
  -- below (969841, 969852) compare it with the m/s top speed as the engine
  -- does (AbortMove multiplies the same velocity by 10 for m/s, 756086).
  local v148 = math.sqrt(body.vel[1] * body.vel[1] + body.vel[3] * body.vel[3]) * DT
  local surface = surfaceUnder(u, p[1], p[3])
  -- The steering toward the target (969430-969451).
  local a4 = { st.target[1] - p[1], 0, st.target[3] - p[3] }
  local a3 = math.sqrt(a4[1] * a4[1] + a4[3] * a4[3])
  local topSpeed = st.alwaysUseTopSpeed and st.topSpeed or math.min(a3, st.topSpeed)
  a4 = setLength(a4, topSpeed)
  local v139 = false
  local dead = u.__dead or u.__destroyQueued
  if not dead or (unitLayer(u) ~= 'Air' and not shouldHoverInsteadOfLand(u)) then
    if a3 <= (air.StartTurnDistance or 0) or st.carrierEvent == 2 then
      -- The landing preparation (969456-969606).
      v139 = st.layer ~= nil and st.layer ~= 'Air'
      local autoLand = math.floor((air.AutoLandTime or 0) * 10.0)
      if not v139 and st.preparationTick > 0 and autoLand > 0 and (__gameTick or 0) > autoLand + st.preparationTick then
        if st.height == INF then
          local lx, lz = prepareMove(u, st.target[1], st.target[3])
          if lx then
            setState(u, 'CannotFindPlaceToLand', nil)
            st.target = { lx, st.target[2], lz }
            v139 = true
            if GetTerrainHeight(lx, lz) <= waterLevel() then st.layer = 'Water' else st.layer = 'Land' end
          else
            st.preparationTick = __gameTick or 0
            setState(u, 'CannotFindPlaceToLand', true)
          end
        else
          setState(u, 'CannotFindPlaceToLand', nil)
          v139 = true
          st.layer = 'Land'
        end
      end
      if v139 then
        setState(u, 'MovingDown', true)
        if st.height == INF then
          if shouldHoverInsteadOfLand(u) or u.__vertEvent == 'Hover' then
            st.newElevation = air.TransportHoverHeight or 0
          elseif a3 < 0.5 or u.__vertEvent == 'Top' then
            st.newElevation = 0.0
          else
            st.newElevation = getElevation(u, st) * 0.5
          end
        else
          st.newElevation = st.height - surface
        end
      else
        st.newElevation = getElevation(u, st)
        setState(u, 'MovingUp', nil)
      end
    else
      st.newElevation = getElevation(u, st)
      setState(u, 'MovingUp', nil)
      setState(u, 'MovingDown', nil)
      setState(u, 'CannotFindPlaceToLand', nil)
    end
    -- The terrain look-ahead (969629-969659) and the target elevation
    -- (969660-969677).
    local v143 = math.min((u.__speedMult or 1) * (air.MaxAirspeed or 0) * 5.0, a3)
    local look = lookAheadForMaxTerrain(u, p[1], p[3], v143 * AIR_LOOK_AHEAD_MULT)
    local v77 = math.max(0, look - p[2])
    if v77 > (air.LiftFactor or 5) and v143 > 1.0 then
      local v144 = v143 * 0.5
      local look2 = lookAheadForMaxTerrain(u, p[1], p[3], v144 * AIR_LOOK_AHEAD_MULT) * 1.5
      local v80 = math.max(0, look2 - p[2])
      local v82 = math.max(0.2, (v144 - v80) / v144)
      a4[1] = a4[1] * (v82 * v82)
      a4[3] = a4[3] * (v82 * v82)
    end
    local v85 = (air.LiftFactor or 5) * 0.1
    if st.targetElevation > look and not v139 then v85 = v85 * 0.5 end
    local v89 = (st.targetElevation + v85 <= look) and (st.targetElevation + v85) or look
    if st.targetElevation - v85 > v89 then v89 = st.targetElevation - v85 end
    st.targetElevation = v89
    st.curElevation = p[2] - surface
    a4[2] = (v89 + st.newElevation) - p[2]
    -- The descent while landing (969678-969702).
    if v139 and a4[2] < 0 then
      if inCategory(u, 'TRANSPORTATION') then
        if a4[2] > -3.0 then a4[2] = -3.0 end
      else
        local half = a4[2] * 0.5
        if half <= -0.25 then a4[2] = half else a4[2] = -0.25 end
      end
    end
    -- The landed and the parked (969704-969775).
    if st.combatState == 0 then
      if v139 and (st.newElevation == 0 or st.height ~= INF or shouldHoverInsteadOfLand(u)) then
        if a3 < 0.5 and ((st.curElevation - st.newElevation) < 0.1 or unitLayer(u) == st.layer) then
          __setCurrentLayer(u, st.layer)
          setState(u, 'MovingUp', nil)
          setState(u, 'MovingDown', nil)
          if not shouldHoverInsteadOfLand(u) then
            __setMotionVertEvent(u, 'Top')
            st.target = { p[1], p[2], p[3] }
            st.prevVel = body.vel
            body.vel = { 0, 0, 0 }
            body.impulse = { 0, 0, 0 }
            u.__speed = 0
            return
          end
          __setMotionVertEvent(u, 'Hover')
        end
      else
        local ev = u.__vertEvent or 'Bottom'
        if ev == 'Top' or ev == 'Hover' then setState(u, 'MovingUp', true) end
        if st.newElevation > 0 and st.newElevation * 0.5 > st.curElevation then
          if st.topSpeed * 0.08 > vlen(body.vel) then
            local v106 = math.min(st.curElevation / st.newElevation, 1.0)
            a4[1] = a4[1] * v106
            a4[3] = a4[3] * v106
          end
        end
      end
    end
    setState(u, 'MakingAttackRun', nil)
    -- No attacker target model: ACS_Normal (969780-969799).
    st.combatState = 0
    computeAirControl(u, st, a4, forward, upY)
    -- The vertical and horizontal motion events (969825-969887).
    if hasState(u, 'MovingDown') then
      __setMotionVertEvent(u, 'Down')
    elseif hasState(u, 'MovingUp') then
      __setMotionVertEvent(u, 'Up')
    elseif (u.__vertEvent or 'Bottom') ~= 'Hover' then
      __setMotionVertEvent(u, 'Bottom')
    end
    local horz
    if a3 > (air.StartTurnDistance or 0) or st.alwaysUseTopSpeed then
      horz = (v148 > st.topSpeed * 0.08) and 'TopSpeed' or 'Cruise'
    elseif st.combatState == 0 then
      horz = (st.topSpeed * 0.005 <= v148) and 'Stopping' or 'Stopped'
    else
      horz = 'Cruise'
    end
    __setMotionHorzEvent(u, horz)
  else
    -- A dead body in the air (969888-969949): the Air layer, UMS_Ballistic,
    -- no force; the random tumble is not modelled. This is the body's last
    -- CalcMoveAir tick: from the next one the motion tick dispatches on
    -- UMS_Ballistic (966250-966253) to CalcMoveBallistic (the hand-over
    -- after the readback below).
    __setCurrentLayer(u, 'Air')
    if u.__motionState ~= 'Ballistic' then __airMotionState(u, 'Ballistic') end
    st.force = { 0, 0, 0 }
    st.torque = { 0, 0, 0 }
  end
  -- The integration (969950-969975).
  st.prevVel = body.vel
  integrateLinear(body, st.force, DT)
  integrateAngular(body, st.torque, DT)
  -- The ground (969977-969996).
  if handleGroundCollision(u, st) and v139 and a3 < 0.5 then
    __setCurrentLayer(u, st.layer)
  elseif (u.__vertEvent or 'Bottom') ~= 'Hover' and not dead then
    __setCurrentLayer(u, 'Air')
  end
  -- The pose back to the entity (sub_697750 940807-940824).
  local ox, oy, oz = p[1], p[2], p[3]
  local off2 = qrot(body.orient, body.offset)
  p[1], p[2], p[3] = body.pos[1] - off2[1], body.pos[2] - off2[2], body.pos[3] - off2[3]
  u.__orient = { body.orient[2], body.orient[3], body.orient[4], body.orient[1] }
  u.__heading = yawOf(body.orient)
  u.__speed = vlen(body.vel) * DT
  if dead and u.__motionState == 'Ballistic' and not u.__ballisticDrop then
    -- The hand-over to CalcMoveBallistic (motion.lua __ballisticStep): it
    -- continues from Unit::GetVelocity, this tick's displacement
    -- (970106-970115), to the surface, OnImpact and UMS_Crashed
    -- (970344-970356).
    u.__ballisticDrop = { v = { p[1] - ox, p[2] - oy, p[3] - oz } }
  end
  -- The arrival (CAiNavigatorAir::Dispatch 756178-756200): at the target
  -- and on its cell, the goal is done.
  if u.__goal and __airAtTarget(u) then
    local gx, gz = u.__goal[1], u.__goal[2]
    if math.abs(gx - st.target[1]) < 1 and math.abs(gz - st.target[3]) < 1 then u.__goal = false end
  end
end
