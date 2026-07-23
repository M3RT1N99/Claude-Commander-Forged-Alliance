-- =====================================================================
-- THE SKELETON — in the SIM, not just in the renderer.
--
-- The engine also loads the model of a unit into the sim: hanging on the bones
-- Weapon turrets, muzzles, construction and effect bones. Without bone transform there
-- there is no starting point for a projectile — `weapon:CreateProjectile(muzzleBone)`
-- needs the world pose of this very bone.
--
-- Proven:
--   Entity:GetBoneDirection(nameOrIndex)  (cfunc_EntityGetBoneDirectionL,
--     Cfile:931469-931505) gets GetBoneWorldTransform(bone) and uses it to rotate the
--     Vector (0,0,1): the viewing direction of a bone is its +Z-AXIS.
--     Returns: three numbers (x, y, z), no vector object.
--   Entity:GetPosition([bone]) (Cfile:934579) — with bone the world position
--     this very bone.
--   Entity:IsValidBone(nameOrIndex, allowNil=false) (Cfile:931520ff).
--
-- The bones come from the SCM file (src/formats/scm.ts): per bone
-- Name, parent index (0-based, -1 = root), position RELATIVE TO PARENT and
-- Rotation as a quaternion (w, x, y, z).
--
-- LIMIT, which is honestly named here: we put together the REST POSE and
-- rotate with the heading of the unit. The engine also rotates tower and
-- Weapon bones over the aim manipulators - they are still dummies for us
-- (globals.lua). A gun turret fires from the resting position of its muzzle,
-- not from the targeted one. This is a known deviation, not a replica.
--
-- STANDARD-LUA 5.4 (geht roh in host.eval).
-- =====================================================================

-- bpId (small) -> { names = {...}, xform = { {pos={x,y,z}, rot={w,x,y,z}} }, index = { [name]=i } }
__unitBones = {}

-- Quaternion math (w, x, y, z) — same convention as the SCM file.
local function qmul(a, b)
  local aw, ax, ay, az = a[1], a[2], a[3], a[4]
  local bw, bx, by, bz = b[1], b[2], b[3], b[4]
  return {
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  }
end

--- Rotate a vector with a quaternion: v' = q * v * q^-1.
local function qrot(q, v)
  local w, x, y, z = q[1], q[2], q[3], q[4]
  local vx, vy, vz = v[1], v[2], v[3]
  -- t = 2 * (q_xyz x v)
  local tx = 2 * (y * vz - z * vy)
  local ty = 2 * (z * vx - x * vz)
  local tz = 2 * (x * vy - y * vx)
  return {
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  }
end

-- The engine page fills the skeleton bone by bone (scalars, none
-- Lua-Quelltext in TS): __beginBones -> __addBone* -> __finishBones.
local pending = nil

function __beginBones(bpId)
  pending = { id = string.lower(bpId), bones = {} }
end

function __addBone(name, parent, px, py, pz, qw, qx, qy, qz)
  if not pending then return end
  local n = #pending.bones + 1
  pending.bones[n] = {
    name = name,
    parent = parent,
    pos = { px, py, pz },
    rot = { qw, qx, qy, qz },
  }
end

--- Dissolve the resting pose into SPACE (chain to the root).
--- Parent indexes are 0-based (-1 = root), the Lua list is 1-based.
---
--- The SCM is built in MODEL units; it comes into the world
--- `Display.UniformScale` of the blueprint (uel0001: 0.105, uel0201: 0.07 — the
--- Renderer scales its mesh with exactly this value). Without the scaling it sat
--- the ACU muzzle 10 meters AHEAD and 12 ABOVE the unit - each shot
--- arose somewhere in the void and fell into the ground in front of the target due to gravity
--- Floor. The blueprint is already registered when setting bones
--- (giveUnit/prepare load the bp first, then the skeleton).
function __finishBones()
  if not pending then return end
  local bones = pending.bones
  local names, xform, index = {}, {}, {}
  local resolve

  local bp = __registered and __registered.Unit and __registered.Unit[pending.id]
  local scale = (bp and bp.Display and bp.Display.UniformScale) or 1

  resolve = function(i)
    if xform[i] then return xform[i] end
    local b = bones[i]
    local pi = (b.parent or -1) + 1
    if pi >= 1 and bones[pi] and pi ~= i then
      local p = resolve(pi)
      local rp = qrot(p.rot, b.pos)
      xform[i] = {
        pos = { p.pos[1] + rp[1], p.pos[2] + rp[2], p.pos[3] + rp[3] },
        rot = qmul(p.rot, b.rot),
      }
    else
      xform[i] = { pos = { b.pos[1], b.pos[2], b.pos[3] }, rot = b.rot }
    end
    return xform[i]
  end

  for i, b in ipairs(bones) do
    names[i] = b.name
    index[string.lower(b.name)] = i
    resolve(i)
  end
  -- Scale AFTER dissolving (the relative chain remains consistent,
  -- Rotations are scaling-free).
  if scale ~= 1 then
    for _, x in pairs(xform) do
      x.pos[1] = x.pos[1] * scale
      x.pos[2] = x.pos[2] * scale
      x.pos[3] = x.pos[3] * scale
    end
  end
  __unitBones[pending.id] = { names = names, xform = xform, index = index }
  pending = nil
end

--- The skeleton of an entity (or an empty one if no model is loaded).
function __skeletonOf(e)
  local s = e.__bones
  if type(s) == 'table' and s.names then return s end
  return { names = {}, xform = {}, index = {} }
end

--- Bones -> 1-based index. The engine takes name OR index (0-based:
--- GetBoneName(i) starts at 0, ENTSCR_ResolveBoneIndex).
function __boneIndex(e, bone)
  if bone == nil then return nil end
  local s = __skeletonOf(e)
  if type(bone) == 'number' then
    local i = bone + 1
    if s.xform[i] then return i end
    return nil
  end
  return s.index[string.lower(tostring(bone))]
end

--- The WORLD POSE of a bone: resting pose in the model room, rotated with the heading
--- the unit, moved to its position.
--- Returns pos {x,y,z}, red {w,x,y,z}. Boneless: the pose of the entity itself
--- (the engine does this with bone index -2, Cfile:930866).
function __boneWorld(e, bone)
  -- CollisionBeam entities have TWO virtual bones (GetBoneCount = 2,
  -- Cfile:16624): Bone 0 = Strahlanfang (Muendung), Bone 1 = Treffpunkt.
  -- CollisionBeam.lua attaches its FX exactly to it (CreateAttachedEmitter
  -- self,0/1) and reads GetPosition(1) for the damage.
  if e.__beamBones then
    local i = bone
    if i == nil or i == -1 or i == -2 then i = 0 end
    local b = e.__beamBones[i + 1] or e.__beamBones[1]
    return { b[1], b[2], b[3] }, e.__beamOrient or { 1, 0, 0, 0 }
  end
  local p = e.__pos or { 0, 0, 0 }
  local h = e.__heading or 0
  -- Heading is a rotation around the Y-axis (motion.lua: forward = sin/cos h).
  local hq = { math.cos(h * 0.5), 0, math.sin(h * 0.5), 0 }

  local i = __boneIndex(e, bone)
  if not i then
    return { p[1] or 0, p[2] or 0, p[3] or 0 }, hq
  end

  local x = __skeletonOf(e).xform[i]
  local wp = qrot(hq, x.pos)
  return { (p[1] or 0) + wp[1], (p[2] or 0) + wp[2], (p[3] or 0) + wp[3] }, qmul(hq, x.rot)
end

--- The +Z axis of a quaternion — what GetBoneDirection returns.
function __quatForward(q)
  return qrot(q, { 0, 0, 1 })
end

__qmul = qmul
__qrot = qrot
