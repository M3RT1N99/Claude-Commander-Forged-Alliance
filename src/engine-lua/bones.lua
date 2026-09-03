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

--- ENTSCR_ResolveBoneIndex (Cfile:936279-936330) for HideBone/ShowBone:
--- returns the 1-based index, or nil for the pseudo bones -1/-2 (allowed
--- when `disallowPseudo` is 0, and the callers then do nothing). A number
--- outside [-2, boneCount) and an unknown name are the engine's errors.
local function resolveBoneArg(e, bone, what)
  local s = __skeletonOf(e)
  local count = #s.names
  if type(bone) == 'number' then
    if bone ~= math.floor(bone) then error("bad argument #1 to '" .. what .. "' (integer expected)", 3) end
    if bone < -2 or bone >= count then
      error(string.format('Invalid bone index of %d; must be bettern %d (inclusive) and %d (exclusive)', bone, -2, count), 3)
    end
    if bone < 0 then return nil end
    return bone + 1
  end
  if type(bone) == 'string' then
    local i = s.index[string.lower(bone)]
    if not i then error(string.format('Invalid bone name "%s".', bone), 3) end
    return i
  end
  error("bad argument #1 to '" .. what .. "' (bone name or index expected)", 3)
end

--- HideBone/ShowBone: CAniPoseBone::mVisible, over the subtree when
--- `affectChildren` (SetVisibleRecur, Cfile:981590-981596).
function __setBoneVisible(e, bone, affectChildren, visible)
  local i = resolveBoneArg(e, bone, visible and 'ShowBone' or 'HideBone')
  if not i then return end
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
