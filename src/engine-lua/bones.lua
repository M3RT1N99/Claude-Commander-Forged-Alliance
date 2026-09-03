-- =====================================================================
-- DAS SKELETT — in der SIM, nicht nur im Renderer.
--
-- Die Engine laedt das Modell einer Unit auch in die Sim: an den Knochen haengen
-- Waffentuerme, MUENDUNGEN, Bau- und Effekt-Knochen. Ohne Knochen-Transform gibt
-- es keinen Startpunkt fuer ein Projektil — `weapon:CreateProjectile(muzzleBone)`
-- braucht die Weltpose genau dieses Knochens.
--
-- Belegt:
--   Entity:GetBoneDirection(nameOrIndex)  (cfunc_EntityGetBoneDirectionL,
--     Cfile:931469-931505) holt GetBoneWorldTransform(bone) und rotiert damit den
--     Vektor (0,0,1): die Blickrichtung eines Knochens ist seine +Z-ACHSE.
--     Rueckgabe: drei Zahlen (x, y, z), kein Vektor-Objekt.
--   Entity:GetPosition([bone]) (Cfile:934579) — mit Knochen die Weltposition
--     genau dieses Knochens.
--   Entity:IsValidBone(nameOrIndex, allowNil=false) (Cfile:931520ff).
--
-- Die Knochen kommen aus der SCM-Datei (src/formats/scm.ts): je Knochen
-- Name, Elternindex (0-basiert, -1 = Wurzel), Position RELATIV ZUM ELTERN und
-- Rotation als Quaternion (w, x, y, z).
--
-- GRENZE, die hier ehrlich benannt wird: wir setzen die RUHEPOSE zusammen und
-- drehen sie mit dem Heading der Unit. Die Engine dreht zusaetzlich Turm- und
-- Waffenknochen ueber die AimManipulatoren mit — die sind bei uns noch Attrappen
-- (globals.lua). Ein Geschuetzturm feuert also aus der Ruhepose seiner Muendung,
-- nicht aus der gezielten. Das ist eine bekannte Abweichung, kein Nachbau.
--
-- STANDARD-LUA 5.4 (geht roh in host.eval).
-- =====================================================================

-- bpId (klein) -> { names = {...}, xform = { {pos={x,y,z}, rot={w,x,y,z}} }, index = { [name]=i } }
__unitBones = {}

-- Quaternion-Mathematik (w, x, y, z) — dieselbe Konvention wie die SCM-Datei.
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

--- Einen Vektor mit einer Quaternion drehen: v' = q * v * q^-1.
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

-- Die Engine-Seite fuellt das Skelett Knochen fuer Knochen (Skalare, kein
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

--- Die Ruhepose in den WELTRAUM aufloesen (Kette bis zur Wurzel).
--- Elternindizes sind 0-basiert (-1 = Wurzel), die Lua-Liste ist 1-basiert.
---
--- Die SCM ist in MODELL-Einheiten gebaut; in die Welt kommt sie ueber
--- `Display.UniformScale` des Blueprints (uel0001: 0.105, uel0201: 0.07 — der
--- Renderer skaliert sein Mesh mit genau diesem Wert). Ohne die Skalierung sass
--- die ACU-Muendung 10 Weltmeter VOR und 12 UEBER der Einheit — jeder Schuss
--- entstand irgendwo im Nichts und fiel per Gravitation vor dem Ziel in den
--- Boden. Der Blueprint ist beim Knochen-Setzen bereits registriert
--- (giveUnit/prepare laden erst das bp, dann das Skelett).
function __finishBones()
  if not pending then return end
  local bones = pending.bones
  local names, xform, index, parent = {}, {}, {}, {}
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
    -- 1-based parent index, false for a root -- HideBone/ShowBone with
    -- affectChildren walk the subtree (CAniPoseBone::SetVisibleRecur).
    local pi = (b.parent or -1) + 1
    parent[i] = (pi >= 1 and pi ~= i and bones[pi] ~= nil) and pi or false
    resolve(i)
  end
  -- NACH dem Aufloesen skalieren (die relative Kette bleibt dabei konsistent,
  -- Rotationen sind skalierungsfrei).
  if scale ~= 1 then
    for _, x in pairs(xform) do
      x.pos[1] = x.pos[1] * scale
      x.pos[2] = x.pos[2] * scale
      x.pos[3] = x.pos[3] * scale
    end
  end
  __unitBones[pending.id] = { names = names, xform = xform, index = index, parent = parent }
  pending = nil
end

--- The 1-based indices of every bone below `i` (children, grandchildren, ...),
--- in index order. Empty when the skeleton has no parent table (a bare
--- entity) or the bone has no children.
function __boneDescendants(e, i)
  local s = __skeletonOf(e)
  local parent = s.parent
  local out = {}
  if not parent then return out end
  local below = { [i] = true }
  for j = 1, #s.names do
    local p = parent[j]
    if p and below[p] then
      below[j] = true
      out[#out + 1] = j
    end
  end
  return out
end

--- Das Skelett einer Entity (oder ein leeres, wenn kein Modell geladen ist).
function __skeletonOf(e)
  local s = e.__bones
  if type(s) == 'table' and s.names then return s end
  return { names = {}, xform = {}, index = {} }
end

--- Knochen -> 1-basierter Index. Die Engine nimmt Namen ODER Index (0-basiert:
--- GetBoneName(i) beginnt bei 0, ENTSCR_ResolveBoneIndex).
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

--- The collision centre of a blueprint in model space — the engine's pseudo
--- bone -1 (GetBoneWorldTransform Cfile:916203-916210, GetBoneLocalTransform
--- Cfile:916264-916284). The blueprint pipeline fills these fields for units;
--- a blueprint of another kind may lack them.
local function collisionCentre(bp)
  return {
    bp.CollisionOffsetX or 0,
    (bp.SizeY or 0) * 0.5 + (bp.CollisionOffsetY or 0),
    bp.CollisionOffsetZ or 0,
  }
end

--- Die WELTPOSE eines Knochens: Ruhepose im Modellraum, gedreht mit dem Heading
--- der Unit, verschoben an ihre Position.
--- Liefert pos {x,y,z}, rot {w,x,y,z}. Ohne Knochen: die Pose der Entity selbst
--- (das tut die Engine mit Bone-Index -2, Cfile:930866).
function __boneWorld(e, bone)
  -- CollisionBeam-Entities haben ZWEI virtuelle Knochen (GetBoneCount = 2,
  -- Cfile:16624): Bone 0 = Strahlanfang (Muendung), Bone 1 = Treffpunkt.
  -- CollisionBeam.lua haengt seine FX genau daran (CreateAttachedEmitter
  -- self,0/1) und liest GetPosition(1) fuer den Schaden.
  if e.__beamBones then
    local i = bone
    if i == nil or i == -1 or i == -2 then i = 0 end
    local b = e.__beamBones[i + 1] or e.__beamBones[1]
    return { b[1], b[2], b[3] }, e.__beamOrient or { 1, 0, 0, 0 }
  end
  local p = e.__pos or { 0, 0, 0 }
  local h = e.__heading or 0
  -- Heading ist eine Drehung um die Y-Achse (motion.lua: vorwaerts = sin/cos h).
  local hq = { math.cos(h * 0.5), 0, math.sin(h * 0.5), 0 }

  -- GetBoneWorldTransform(-1) (Cfile:916203-916218): the collision centre,
  -- rotated with the entity and added to its position. -2 (and anything
  -- without a bone) is the entity's own pose (Cfile:916219-916222).
  if bone == -1 and e.__bp then
    local wp = qrot(hq, collisionCentre(e.__bp))
    return { (p[1] or 0) + wp[1], (p[2] or 0) + wp[2], (p[3] or 0) + wp[3] }, hq
  end
  local i = __boneIndex(e, bone)
  if not i then
    return { p[1] or 0, p[2] or 0, p[3] or 0 }, hq
  end

  local x = __skeletonOf(e).xform[i]
  local wp = qrot(hq, x.pos)
  return { (p[1] or 0) + wp[1], (p[2] or 0) + wp[2], (p[3] or 0) + wp[3] }, qmul(hq, x.rot)
end

--- Die +Z-Achse einer Quaternion — was GetBoneDirection zurueckgibt.
function __quatForward(q)
  return qrot(q, { 0, 0, 1 })
end

--- ENTSCR_ResolveBoneIndex (Cfile:936279-936330): the 0-based engine index of
--- a bone given by name or number. A number is range-checked against
--- [min, boneCount) where min is -2 when the caller allows the pseudo bones
--- (third argument 1: AttachTo/AttachBoneTo, Cfile:931924/932035/932045) and
--- 0 when it does not (HideBone/ShowBone Cfile:981522/981598, DetachAll
--- Cfile:932312). An index outside that range and an unknown name are the
--- engine's errors, with its texts.
local function resolveBoneArg(e, bone, what, allowPseudo)
  local s = __skeletonOf(e)
  local count = #s.names
  local min = allowPseudo and -2 or 0
  if type(bone) == 'number' then
    if bone ~= math.floor(bone) then error("bad argument #1 to '" .. what .. "' (integer expected)", 3) end
    if bone < min or bone >= count then
      error(string.format('Invalid bone index of %d; must be bettern %d (inclusive) and %d (exclusive)', bone, min, count), 3)
    end
    return bone
  end
  if type(bone) == 'string' then
    local i = s.index[string.lower(bone)]
    if not i then error(string.format('Invalid bone name "%s".', bone), 3) end
    return i - 1
  end
  error("bad argument #1 to '" .. what .. "' (bone name or index expected)", 3)
end
__resolveBoneArg = resolveBoneArg

--- HideBone/ShowBone: CAniPoseBone::mVisible, over the subtree when
--- `affectChildren` (SetVisibleRecur, Cfile:981590-981596).
function __setBoneVisible(e, bone, affectChildren, visible)
  -- HideBone/ShowBone resolve with 0 (Cfile:981522/981598): no pseudo bones.
  local i = resolveBoneArg(e, bone, visible and 'ShowBone' or 'HideBone', false) + 1
  e.__hiddenBones = e.__hiddenBones or {}
  local hidden = e.__hiddenBones
  hidden[i] = (not visible) or nil
  if affectChildren then
    for _, j in ipairs(__boneDescendants(e, i)) do hidden[j] = (not visible) or nil end
  end
end

--- The hidden bones of an entity by NAME, sorted -- what the renderer needs.
function __hiddenBoneNames(e)
  local hidden = e.__hiddenBones
  if not hidden then return nil end
  local names = __skeletonOf(e).names
  local out = {}
  for i in pairs(hidden) do
    if names[i] then out[#out + 1] = names[i] end
  end
  if out[1] == nil then return nil end
  table.sort(out)
  return out
end

__qmul = qmul
__qrot = qrot

-- =====================================================================
-- ATTACHMENT — SEntAttachInfo and Entity::AttachTo (Cfile:915773-915924)
--
-- An entity carries ONE parent link (mAttachInfo: mEnt = the parent, mBone =
-- the PARENT bone, v3 = the entity's OWN reference bone, mParentOrientation =
-- the offset SetParentOffset writes) and the list of entities attached to it
-- (mAttachedEntities). The AttachTo binding builds the info with own bone 0
-- and the parent bone (Cfile:931936: sub_5E3B50(..., 0, bone)), AttachBoneTo
-- with the given own bone (Cfile:932049). Defaults: no parent, both bones -1
-- (Cfile:914497-914500).
--
-- The transform of an attached entity is not stored — its task recomputes it
-- every tick (Entity::TaskTick, Cfile:916175-916190): once the parent has
-- ticked, SetPendingTransform(CalculateAttachedTransform()). That transform
-- (Cfile:916355-916377) is parentBoneWorld o parentOffset o inverse(ownBone):
-- the own reference bone lands on the parent bone. GetBoneLocalTransform
-- (Cfile:916242-916296) yields the bone's rest pose in model space for a real
-- bone (it inverts the stored SAniSkelBone::ori, which is the inverse rest
-- pose -- docs/FORMATS.md), the collision centre for -1, the identity for -2
-- or without a skeleton; sub_676850 (Cfile:913683-913740) then composes the
-- parent side with the INVERSE of that local transform.
-- =====================================================================

-- The follow list: every attached entity, child -> true.
__attachedEntities = {}

local function identityOffset() return { pos = { 0, 0, 0 }, rot = { 1, 0, 0, 0 } } end
local function qconj(q) return { q[1], -q[2], -q[3], -q[4] } end

--- The heading (rotation about +Y) of a (w, x, y, z) quaternion — the inverse
--- of the `hq` that __boneWorld builds from a heading.
local function yawOf(q)
  local w, x, y, z = q[1], q[2], q[3], q[4]
  return math.atan(2 * (w * y + x * z), 1 - 2 * (y * y + z * z))
end

--- The own reference bone in model space (pos, rot) — GetBoneLocalTransform
--- before the engine's inversion; __attachedTransform inverts it.
local function ownBoneLocal(e, raw)
  if raw >= 0 then
    local x = __skeletonOf(e).xform[raw + 1]
    if x then return x.pos, x.rot end
  elseif raw == -1 and e.__bp then
    return collisionCentre(e.__bp), { 1, 0, 0, 0 }
  end
  return { 0, 0, 0 }, { 1, 0, 0, 0 }
end

--- The blueprint name the attach error prints (str_empty without one).
function __bpName(e)
  return (e.__bp and e.__bp.BlueprintId) or ''
end

--- SCR_FromLua_Entity for an argument that must be an entity. The engine's
--- own text for a wrong argument is not reproduced here.
function __checkEntityArg(v, what)
  if type(v) ~= 'table' or v.__id == nil then
    error("bad argument to '" .. what .. "' (entity expected)", 3)
  end
end

--- CalculateAttachedTransform: the world pose an attached entity takes.
--- Returns pos {x,y,z}, rot {w,x,y,z}.
function __attachedTransform(e)
  local par = e.__attachParent
  local tp, tq = __boneWorld(par, e.__attachParentBone)
  -- Compose(mParentOrientation, parentBoneWorld) (Cfile:916373): the offset
  -- lives in the parent bone's frame.
  local off = e.__attachOffset
  local op = qrot(tq, off.pos)
  local ap = { tp[1] + op[1], tp[2] + op[2], tp[3] + op[3] }
  local aq = qmul(tq, off.rot)
  -- ... o inverse(own bone): the W with W o R = A.
  local rp, rq = ownBoneLocal(e, e.__attachSelfBone)
  local wq = qmul(aq, qconj(rq))
  local wp = qrot(wq, rp)
  return { ap[1] - wp[1], ap[2] - wp[2], ap[3] - wp[3] }, wq
end

--- One entity's follow for this tick (Entity::TaskTick). The parent's own
--- follow runs first — the engine delays the child until its parent has
--- ticked (mLastTickProcessed, Cfile:916183-916184).
function __attachFollow(e)
  local par = e.__attachParent
  if not par or e.__destroyed then return end
  if e.__attachTick == __gameTick then return end
  e.__attachTick = __gameTick
  if par.__attachParent then __attachFollow(par) end
  local p, q = __attachedTransform(e)
  local cur = e.__pos
  if cur then cur[1], cur[2], cur[3] = p[1], p[2], p[3] else e.__pos = p end
  e.__heading = yawOf(q)
  -- Entities keep __orient as (x, y, z, w) (GetOrientation); projectiles keep
  -- theirs as (w, x, y, z) -- no original script attaches a projectile, so
  -- that case is not handled here.
  e.__orient = { q[2], q[3], q[4], q[1] }
end

--- All attached entities follow their parents (the entity task stage of the
--- beat, after the parents moved).
function __attachFollowTick()
  for e in pairs(__attachedEntities) do __attachFollow(e) end
end

--- Entity::AttachTo (Cfile:915773-915880). False when this entity already
--- has a parent (915797-915798), when the parent chain leads back to it
--- (915800-915818) or when it is already in the parent's list (915820-915836).
--- On success the entity joins the list (915838-915860), its task thread is
--- woken (mWaitTicks = 0, 915862-915878 -- its TaskTick runs in the same
--- frame, after the parent's) and the attach info is stored (915879).
function __attachTo(e, par, selfBone, parentBone)
  if e.__attachParent then return false end
  local a = par
  while a do
    if a == e then return false end
    a = a.__attachParent or nil
  end
  local list = par.__attachedEntities or {}
  for _, c in ipairs(list) do
    if c == e then return false end
  end
  list[#list + 1] = e
  par.__attachedEntities = list
  e.__attachParent = par
  e.__attachParentBone = parentBone
  e.__attachSelfBone = selfBone
  e.__attachOffset = identityOffset()
  __attachedEntities[e] = true
  -- Follow at once (the woken task) and again in this beat's follow stage
  -- after the parent moved -- the engine's TaskTick waits for the parent's
  -- tick (916183-916184), so the child ends the attach beat on the parent's
  -- post-motion pose.
  e.__attachTick = nil
  __attachFollow(e)
  e.__attachTick = nil
  return true
end

--- Entity::DetachFrom (Cfile:915924-915950): out of the parent's list, the
--- attach info back to its defaults. False when the entity is not in that list.
function __detachFrom(e, par)
  local list = par.__attachedEntities
  local at
  for i, c in ipairs(list or {}) do
    if c == e then at = i break end
  end
  if not at then return false end
  table.remove(list, at)
  e.__attachParent = false
  e.__attachParentBone = -1
  e.__attachSelfBone = -1
  e.__attachOffset = identityOffset()
  __attachedEntities[e] = nil
  return true
end

--- The virtual AttachTo: Entity::AttachTo, then for a unit what Unit::AttachTo
--- adds (Cfile:954378-954392, motion.lua).
function __entityAttach(e, par, selfBone, parentBone)
  if not __attachTo(e, par, selfBone, parentBone) then return false end
  if e.__isUnit then __unitOnAttached(e) end
  return true
end

--- The virtual DetachFrom (Unit::DetachFrom, Cfile:954394-954427, wraps
--- Entity::DetachFrom with CUnitMotion::NotifyDetached). Returns whether the
--- entity was attached.
function __entityDetach(e, skipBallistic)
  local par = e.__attachParent
  if not par then return false end
  if e.__isUnit then __unitCheckDetach(e, skipBallistic) end
  if not __detachFrom(e, par) then return false end
  if e.__isUnit then __unitOnDetached(e, par, skipBallistic) end
  return true
end

local function callback(target, name, arg)
  local f = target[name]
  if type(f) ~= 'function' then return end
  local ok, err = pcall(f, target, arg)
  if not ok then WARN(name .. ': ' .. tostring(err)) end
end

--- Entity::Kill (Cfile:916064-916084): the parent hears OnAttachedKilled(e),
--- every attached entity OnParentKilled(e) — before mIsDead is set.
function __attachNotifyKilled(e)
  local par = e.__attachParent
  if par then callback(par, 'OnAttachedKilled', e) end
  for _, c in ipairs(e.__attachedEntities or {}) do callback(c, 'OnParentKilled', e) end
end

--- Entity::OnDestroy after the Lua OnDestroy (Cfile:916143-916162): the
--- parent hears OnAttachedDestroyed(e), the entity detaches, every attached
--- entity hears OnParentDestroyed(e).
function __attachOnDestroyed(e)
  local par = e.__attachParent
  if par then
    callback(par, 'OnAttachedDestroyed', e)
    -- The engine calls the virtual DetachFrom(parent, false) here
    -- (Cfile:916158); for a unit that is Unit::DetachFrom with its state
    -- bookkeeping (motion.lua __unitDetachedOnDestroy).
    __detachFrom(e, par)
    if e.__isUnit then __unitDetachedOnDestroy(e) end
  end
  local list = e.__attachedEntities
  if list then
    local copy = {}
    for i, c in ipairs(list) do copy[i] = c end
    for _, c in ipairs(copy) do callback(c, 'OnParentDestroyed', e) end
    -- The children's parent link is a weak reference (SEntAttachInfo::mEnt,
    -- Cfile:915896-915912) that clears with the parent. An attached UNIT then
    -- finds no parent in UMS_Attached and starts a ballistic drop
    -- (Cfile:966231-966238); that drop is not implemented (docs/STATUS.md) —
    -- the unit is released where it is and lands on its next motion tick.
    for _, c in ipairs(copy) do
      c.__attachParent = false
      c.__attachParentBone = -1
      c.__attachSelfBone = -1
      c.__attachOffset = identityOffset()
      __attachedEntities[c] = nil
      if c.__isUnit then __unitParentLost(c) end
    end
    e.__attachedEntities = nil
  end
end

-- =====================================================================
-- TEXTURE SCROLLERS -- CTextureScroller (Cfile:1110823-1111068)
--
-- An entity owns at most one scroller (Entity::mScroller); the four bindings
-- AddThreadScroller / AddManualScroller / AddPingPongScroller / RemoveScroller
-- (Cfile:935407-935760) create it on first use and hand it an SScroller
-- through Entity::AddScroller (1110823-1110842): the spec is copied, a
-- PingPong spec zeroes its directions and countdowns, a None spec (Remove)
-- freezes the scroll (mScroll2 = mScroll1). The scroll itself is the
-- entity's mVarDat.mScroll1/mScroll2 (a pair for interpolation), part of
-- the per-entity sync (701559-701562, 701700-701703); the user side copies
-- it to the mesh instance (1358126-1358133) and the shader scrolls the tread
-- bands of the UV layout (effects/mesh.fx:438-452, unit.vert.glsl).
--
-- CTextureScroller::Tick runs from Entity::TaskTick every tick, first thing
-- (916174-916176), before the attach follow and MotionTick:
--   PingPong (1110851-1110900): two channels with a countdown each; at zero
--     the channel flips and reloads floor(speed * 10) ticks of the side it
--     enters; when any channel flipped, mScroll1 = mScroll2 = the current
--     (ping or pong) values.
--   Manual (1110901-1110908): mScroll1 = mScroll2; mScroll2 += (speed1, speed2).
--   MotionDerived / thread (1110909-1111064): when the position changed since
--     the last transform, the points at +/- sideDist along the local X axis
--     are moved with the entity; each point's displacement projected on the
--     averaged forward axis, times scrollMult, is added to mScroll2.x (the
--     + side, 1111061) and mScroll2.y (the - side, 1111062 -- its term v37
--     carries the multiplier inside, 1111051-1111058); mScroll1 takes the
--     old mScroll2.
-- =====================================================================

--- Entity::AddScroller.
function __scrollerSet(e, spec)
  local sc = e.__scroller
  if not sc then
    -- A fresh scroller and a fresh entity both start at zero
    -- (CTextureScroller ctor 913851-913855; entity variable data 700652).
    sc = { s1x = 0, s1y = 0, s2x = 0, s2y = 0 }
    e.__scroller = sc
  end
  sc.spec = spec
  if spec.type == 'PingPong' then
    sc.dir = { false, false }
    sc.count = { 0, 0 }
  elseif spec.type == 'None' then
    sc.s2x, sc.s2y = sc.s1x, sc.s1y
  end
end

--- The entity's scroll pair for the sync row, or nil without a scroller.
function __scrollerRow(e)
  local sc = e.__scroller
  if not sc then return nil end
  return { sc.s1x, sc.s1y, sc.s2x, sc.s2y }
end

--- CTextureScroller::Tick for one entity, plus the entity's own record of
--- its previous transform (mVarDat.mLastTransform), which the thread
--- scroller compares against -- kept for every entity, scroller or not, so
--- a scroller created mid-motion sees the last step like the engine's does.
function __scrollerTick(e)
  local p = e.__pos or { 0, 0, 0 }
  local h = e.__heading or 0
  local lp, lh = e.__lastPos, e.__lastHeading
  e.__lastPos = { p[1], p[2], p[3] }
  e.__lastHeading = h
  local sc = e.__scroller
  if not sc then return end
  local spec = sc.spec
  local t = spec.type
  if t == 'PingPong' then
    local flipped = false
    for i = 1, 2 do
      sc.count[i] = sc.count[i] - 1
      if sc.count[i] <= 0 then
        flipped = true
        sc.dir[i] = not sc.dir[i]
        local dwell = sc.dir[i] and spec.pingSpeed[i] or spec.pongSpeed[i]
        sc.count[i] = math.floor(dwell * 10)
      end
    end
    if flipped then
      local x = sc.dir[1] and spec.ping[1] or spec.pong[1]
      local y = sc.dir[2] and spec.ping[2] or spec.pong[2]
      sc.s1x, sc.s1y, sc.s2x, sc.s2y = x, y, x, y
    end
  elseif t == 'Manual' then
    sc.s1x, sc.s1y = sc.s2x, sc.s2y
    sc.s2x = sc.s2x + spec.speed1
    sc.s2y = sc.s2y + spec.speed2
  elseif t == 'Thread' then
    if lp and (p[1] ~= lp[1] or p[2] ~= lp[2] or p[3] ~= lp[3]) then
      local d = spec.sideDist
      -- The local X axis (right) and forward of a yaw-only pose, as
      -- __boneWorld builds it: forward = (sin h, 0, cos h).
      local rx, rz = math.cos(h), -math.sin(h)
      local lrx, lrz = math.cos(lh), -math.sin(lh)
      local fx = (math.sin(h) + math.sin(lh)) * 0.5
      local fz = (math.cos(h) + math.cos(lh)) * 0.5
      local dpx, dpz = p[1] - lp[1], p[3] - lp[3]
      local ax, az = dpx + d * (rx - lrx), dpz + d * (rz - lrz)
      local bx, bz = dpx - d * (rx - lrx), dpz - d * (rz - lrz)
      sc.s1x, sc.s1y = sc.s2x, sc.s2y
      sc.s2x = sc.s2x + (ax * fx + az * fz) * spec.scrollMult
      sc.s2y = sc.s2y + (bx * fx + bz * fz) * spec.scrollMult
    end
  end
end
