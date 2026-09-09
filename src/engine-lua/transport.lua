-- =====================================================================
-- The transport -- Moho::CAiTransportImpl and the three command tasks
-- behind UNITCOMMAND_TransportLoadUnits / TransportReverseLoadUnits /
-- TransportUnloadUnits (CUnitLoadUnits, CUnitCallTransport,
-- CUnitUnloadUnits), plus the Sim bindings IssueTransportLoad and
-- IssueTransportUnload.
--
-- Every value and every branch below is cited to Cfile/ForgedAlliance.exe.c.
-- Where the decompilation leaves a question open it is named as UNVERIFIED
-- at the site and in docs/STATUS.md, never guessed.
--
-- STANDARD LUA 5.4 (goes raw into host.eval).
-- =====================================================================

-- The two command caps the transport code tests (ERuleBPUnitCommandCaps,
-- registration order Cfile:656687-656689: RULEUCC_Transport is bit 8,
-- RULEUCC_CallTransport bit 9).
local RULEUCC_Transport = 0x100
local RULEUCC_CallTransport = 0x200

-- Moho::CAiTransportImpl per unit (Unit::mTransport). A unit owns one when
-- RULEUCC_Transport is in its command caps or it is a PODSTAGINGPLATFORM
-- (Unit ctor, Cfile:950494-950512); every other unit has none, and the
-- bindings error on them (GetCargo 972310, TransportDetachAllUnits 804858).
__transports = {}

-- The running tasks, unitId -> task table (kind = 'load' | 'call' | 'unload').
__transportTasks = {}

local function isMobile(u)
  local bp = u and u.__bp
  return u and not u.__immobile and bp and bp.Physics and bp.Physics.MotionType ~= 'RULEUMT_None'
end

local function inCategory(u, name)
  return EntityCategoryContains(categories[name], u)
end

local function unitLive(u)
  return u and not u.__dead and not u.__destroyed and not u.__destroyQueued
end

-- CScriptObject::RunScript / RunScript_StrUnit: the Lua callback, its error
-- logged (the engine's CLuaTask text), never fatal for the task.
local function runScript(u, name, ...)
  local f = u and u[name]
  if type(f) ~= 'function' then return nil end
  local ok, res = pcall(f, u, ...)
  if not ok then
    WARN('Error running lua script: ' .. name .. ': ' .. tostring(res))
    return nil
  end
  return res
end

local function footprint(u)
  local fp = (u.__bp and u.__bp.Footprint) or {}
  return fp.SizeX or 1, fp.SizeZ or 1
end

-- COORDS_Orient(facing): the yaw quaternion (w, x, y, z) that turns +Z onto a
-- horizontal facing vector -- the same convention __boneWorld builds from the
-- heading (motion.lua: forward = sin/cos h).
local function orientFromFacing(fx, fz)
  if fx == 0 and fz == 0 then return { 1, 0, 0, 0 }, 0 end
  local h = math.atan(fx, fz)
  return { math.cos(h * 0.5), 0, math.sin(h * 0.5), 0 }, h
end

local function headingQuat(u)
  local h = u.__heading or 0
  return { math.cos(h * 0.5), 0, math.sin(h * 0.5), 0 }
end

-- === SetUpAttachPoints (Cfile:801771-801976) ===
--
-- Every bone of the skeleton, by substring of its name (strstr, case
-- sensitive): "Launchpoint" -> the launch list (the break out of the name
-- chain lands on the launch-list append, 801841-801846 / 801965-801968);
-- "Attachpoint_Spr" -> class 4 (or the generic list when the blueprint's
-- ClassGenericUpTo reaches 4); "Attachpoint_Lrg" -> class 3;
-- "Attachpoint_Med" -> class 2; a plain "Attachpoint" -> class 1;
-- "AttachSpecial" -> the special list. A bone matching none of them goes
-- nowhere (LABEL_57, 801961-801963). Each Attachpoint_* bone counts in
-- mAttachpoints (801883/801910/801934/801954), the special and launch bones
-- do not.
local function setUpAttachPoints(t, u)
  local s = __skeletonOf(u)
  local upTo = (u.__bp.Transport and u.__bp.Transport.ClassGenericUpTo) or 0
  for i, name in ipairs(s.names) do
    local x = s.xform[i]
    local point = { index = i - 1, localPos = { x.pos[1], x.pos[2], x.pos[3] }, distSq = 0 }
    local list
    if string.find(name, 'Launchpoint', 1, true) then
      list = t.launch
    elseif string.find(name, 'Attachpoint_Spr', 1, true) then
      t.attachpoints = t.attachpoints + 1
      list = upTo < 4 and t.class4 or t.generic
    elseif string.find(name, 'Attachpoint_Lrg', 1, true) then
      t.attachpoints = t.attachpoints + 1
      list = upTo < 3 and t.class3 or t.generic
    elseif string.find(name, 'Attachpoint_Med', 1, true) then
      t.attachpoints = t.attachpoints + 1
      list = upTo < 2 and t.class2 or t.generic
    elseif string.find(name, 'Attachpoint', 1, true) then
      t.attachpoints = t.attachpoints + 1
      list = upTo < 1 and t.class1 or t.generic
    elseif string.find(name, 'AttachSpecial', 1, true) then
      list = t.classS
    end
    if list then list[#list + 1] = point end
  end
end

--- The component of a unit, created on first use (AI_CreateTransport,
--- Cfile:804875-804882 -> the ctor 802459-802850: the lists, the pickup
--- info, mStagingPlatform from AIRSTAGINGPLATFORM/PODSTAGINGPLATFORM
--- (802790-802806), mTeleportation from TELEPORTATION (802807-802815)).
--- nil for a unit without one.
function __transportOf(u)
  if not u or not u.__isUnit or not u.__id then return nil end
  local t = __transports[u.__id]
  if t then return t end
  local caps = __ensureCommandCapMask(u)
  if (caps & RULEUCC_Transport) == 0 and not inCategory(u, 'PODSTAGINGPLATFORM') then return nil end
  t = {
    unit = u.__id,
    attachpoints = 0,
    generic = {}, class1 = {}, class2 = {}, class3 = {}, class4 = {}, classS = {}, launch = {},
    -- SAiReservedTransportBone: { unit, index (transport bone), hook (the
    -- passenger's own bone), bones (the covered bone indices) }.
    reserved = {},
    -- STransportPickUpInfo (mRes): position, orientation, the units waiting
    -- for this pickup, mHasSpace.
    pickup = { pos = { 0, 0, 0 }, ori = { 1, 0, 0, 0 }, facing = { 0, 0, 0 }, units = {}, hasSpace = false },
    stored = {},
    storedReserved = {},
    stagingPlatform = inCategory(u, 'AIRSTAGINGPLATFORM') or inCategory(u, 'PODSTAGINGPLATFORM'),
    teleporter = inCategory(u, 'TELEPORTATION'),
  }
  setUpAttachPoints(t, u)
  __transports[u.__id] = t
  return t
end

local function transportUnit(t) return __units[t.unit] end

-- GetBestAttachPoint (Cfile:802157-802180): the passenger's "AttachPoint"
-- bone; without one a flyer hangs by bone 0, everything else by -1 (the
-- collision centre).
local function bestAttachPoint(u)
  local i = __boneIndex(u, 'AttachPoint')
  if i then return i - 1 end
  if u.__bp and u.__bp.Air and u.__bp.Air.CanFly then return 0 end
  return -1
end

-- GetReservedBone (Cfile:802183-802200): the reservation of a unit.
local function reservedBone(t, u)
  for _, r in ipairs(t.reserved) do
    if r.unit == u.__id then return r end
  end
  return nil
end

-- IsBoneReserved (Cfile:802084-802114): any reservation covering one of the
-- bones.
local function isBoneReserved(t, bones)
  for _, r in ipairs(t.reserved) do
    for _, b in ipairs(r.bones) do
      for _, want in ipairs(bones) do
        if b == want then return true end
      end
    end
  end
  return false
end

-- GetClosestAttachPointsTo (Cfile:801983-802083): one point is its own
-- slot; a larger passenger takes the attachSize points of the class list
-- nearest to the hook bone (sorted by the squared distance of their
-- positions, func_SortAttachData 808592-808635), or nothing when the list
-- is too short. The engine reads GetBoneLocalTransform live (802011-802020);
-- this sim's skeleton is the rest pose, which is what the locator bones
-- carry. The engine's sort is unstable with no second key; the tie-break by
-- bone order here is a deterministic choice, UNVERIFIED against it.
local function closestAttachPointsTo(t, hookIndex, attachSize, list)
  if attachSize == 1 then return { hookIndex } end
  if #list < attachSize then return {} end
  local u = transportUnit(t)
  local s = __skeletonOf(u)
  local hook = s.xform[hookIndex + 1]
  local hp = hook and hook.pos or { 0, 0, 0 }
  local sorted = {}
  for i, p in ipairs(list) do
    local dx, dy, dz = p.localPos[1] - hp[1], p.localPos[2] - hp[2], p.localPos[3] - hp[3]
    sorted[i] = { index = p.index, distSq = dx * dx + dy * dy + dz * dz, order = i }
  end
  table.sort(sorted, function(a, b)
    if a.distSq == b.distSq then return a.order < b.order end
    return a.distSq < b.distSq
  end)
  local out = {}
  for i = 1, attachSize do out[i] = sorted[i].index end
  return out
end

-- TransportValidateType (Cfile:803430-803466): a staging platform takes only
-- AirClass blueprints; a transport takes everything but an AirClass
-- blueprint that is not itself TRANSPORTATION.
local function validateType(t, bp)
  local airClass = bp.Transport and bp.Transport.AirClass
  if t.stagingPlatform then return airClass == true end
  if not airClass then return true end
  local cats = {}
  for _, c in ipairs(bp.Categories or {}) do cats[c] = true end
  return cats.TRANSPORTATION == true
end

-- TransportFindAttachList (Cfile:803468-803522): the class list for a
-- passenger class above the blueprint's ClassGenericUpTo, else the generic
-- list; the attach size of that class; the hook candidates = the class-1
-- list, or the generic list when there are no class-1 points.
--
-- The decompiled case for class 4 runs on into the special case (803493-
-- 803506: the class-4 copy and size are overwritten by the special list and
-- ClassSAttachSize). It is ported as decompiled; whether that is the
-- shipped binary's behaviour or an artefact is UNVERIFIED, and no shipped
-- unit carries TransportClass 4 (docs/STATUS.md).
local function findAttachList(t, unitClass)
  local u = transportUnit(t)
  local tr = u.__bp.Transport or {}
  local upTo = tr.ClassGenericUpTo or 0
  local list, size = t.generic, 1
  if unitClass > upTo then
    if unitClass == 1 then
      list = t.class1
    elseif unitClass == 2 then
      list, size = t.class2, tr.Class2AttachSize or 0
    elseif unitClass == 3 then
      list, size = t.class3, tr.Class3AttachSize or 0
    elseif unitClass == 4 then
      list, size = t.classS, tr.ClassSAttachSize or 0
    else
      list = {}
    end
  end
  local hooks = (#t.class1 > 0) and t.class1 or t.generic
  return list, hooks, size
end

--- TransportCanCarryUnit (Cfile:803349-803428).
function __transportCanCarryUnit(t, u)
  if not u or not isMobile(u) then return false end
  local isAir = u.__bp and u.__bp.Air and u.__bp.Air.CanFly
  if t.stagingPlatform then
    if not isAir then return false end
  elseif isAir then
    return false
  end
  local me = transportUnit(t)
  if inCategory(u, 'COMMAND') and not inCategory(me, 'CANTRANSPORTCOMMANDER') then return false end
  local tr = me.__bp.Transport or {}
  local class = (u.__bp.Transport and u.__bp.Transport.TransportClass) or 1
  local upTo = tr.ClassGenericUpTo or 0
  if upTo >= class and #t.generic > 0 then return true end
  local n = (upTo == 0) and #t.class1 or #t.generic
  if class == 1 then return n > 0 end
  if class == 2 then
    local want = tr.Class2AttachSize or 0
    return want ~= 0 and n >= want
  end
  if class == 3 then
    local want = tr.Class3AttachSize or 0
    return want ~= 0 and n >= want
  end
  if class == 4 then
    -- The class-4 test is strictly greater (803414-803420), unlike 2 and 3.
    local want = tr.Class4AttachSize or 0
    return want ~= 0 and n > want
  end
  return false
end

--- TransportHasSpaceFor (Cfile:803523-803605): an unreserved slot of the
--- passenger's class.
function __transportHasSpaceFor(t, bp)
  if not validateType(t, bp) then return false end
  local class = (bp.Transport and bp.Transport.TransportClass) or 1
  local list, hooks, size = findAttachList(t, class)
  if #list == 0 then return false end
  size = math.max(1, size)
  for _, p in ipairs(list) do
    local bones = closestAttachPointsTo(t, p.index, size, hooks)
    if #bones > 0 and not isBoneReserved(t, bones) then return true end
  end
  return false
end

-- ReserveBone (Cfile:802115-802156): one SAiReservedTransportBone.
local function reserveBone(t, hook, u, index, bones)
  if #bones == 0 then return end
  t.reserved[#t.reserved + 1] = { unit = u.__id, index = index, hook = hook, bones = bones }
end

--- TransportAssignSlot (Cfile:803606-803718): a specific transport bone
--- (index >= 0) or the first free slot of the passenger's class.
function __transportAssignSlot(t, u, index)
  if not validateType(t, u.__bp) then return false end
  local hook = bestAttachPoint(u)
  local class = (u.__bp.Transport and u.__bp.Transport.TransportClass) or 1
  local list, hooks, size = findAttachList(t, class)
  if index and index >= 0 then
    local bones = closestAttachPointsTo(t, index, math.max(1, size), hooks)
    if #bones > 0 and not isBoneReserved(t, bones) then
      reserveBone(t, hook, u, index, bones)
      return true
    end
    return false
  end
  size = math.max(1, size)
  for _, p in ipairs(list) do
    local bones = closestAttachPointsTo(t, p.index, size, hooks)
    if #bones > 0 and not isBoneReserved(t, bones) then
      reserveBone(t, hook, u, p.index, bones)
      return true
    end
  end
  return false
end

-- TransportRemoveUnitReservation (Cfile:803163-803197): every reservation
-- of the unit (and every dangling one).
local function removeUnitReservation(t, u)
  local keep = {}
  for _, r in ipairs(t.reserved) do
    local owner = __units[r.unit]
    if owner and r.unit ~= u.__id then keep[#keep + 1] = r end
  end
  t.reserved = keep
end

-- TransportRemovePickupUnit (Cfile:803152-803162): out of the pickup list;
-- with the flag the reservation goes too.
local function removePickupUnit(t, u, andReservation)
  local list = t.pickup.units
  for i = #list, 1, -1 do
    if list[i] == u.__id then table.remove(list, i) end
  end
  if andReservation then removeUnitReservation(t, u) end
end

-- TransportAddPickupUnits (Cfile:803050-803151): the pickup point, its
-- facing -- the single passenger's own facing when the transport has one
-- attach point, else the direction from the transport to the point -- and
-- the waiting list; mHasSpace = 0 until the transport is in position.
local function addPickupUnits(t, units, px, pz)
  for _, id in ipairs(units) do
    local u = __units[id]
    if u then removePickupUnit(t, u, false) end
  end
  local me = transportUnit(t)
  local mp = me.__pos
  local fx, fz
  if t.attachpoints == 1 and #units == 1 then
    local u = __units[units[1]]
    local h = (u and u.__heading) or 0
    fx, fz = math.sin(h), math.cos(h)
  else
    local dx, dz = px - mp[1], pz - mp[3]
    local len = math.sqrt(dx * dx + dz * dz)
    if len <= 0.000001 then
      fx, fz = 0, 0
    else
      fx, fz = dx / len, dz / len
    end
  end
  t.pickup.facing = { fx, 0, fz }
  t.pickup.ori = orientFromFacing(fx, fz)
  t.pickup.pos = { px, mp[2], pz }
  for _, id in ipairs(units) do t.pickup.units[#t.pickup.units + 1] = id end
  t.pickup.hasSpace = false
end

local function pickupCount(t)
  local n = 0
  for _, id in ipairs(t.pickup.units) do
    local u = __units[id]
    if unitLive(u) then n = n + 1 end
  end
  return n
end

local function assignedForPickup(t, u)
  for _, id in ipairs(t.pickup.units) do
    if id == u.__id then return true end
  end
  return false
end

-- TransportIsReadyForUnit (Cfile:804101-804105).
local function readyForUnit(t, u)
  return t.pickup.hasSpace and assignedForPickup(t, u)
end

-- The cell of a world position for a footprint (SFootprint::ToCellPos:
-- floor(pos - size / 2)) and back to the world centre.
local function cellOf(u, x, z)
  local sx, sz = footprint(u)
  return math.floor(x - sx * 0.5), math.floor(z - sz * 0.5)
end
local function cellCentre(u, cx, cz)
  local sx, sz = footprint(u)
  return cx + sx * 0.5, cz + sz * 0.5
end

-- TransportGetPickupUnitPos (Cfile:803295-803342): the passenger's staging
-- cell -- the pickup point itself for a single-point transport, else the
-- reserved bone's rest offset rotated into the pickup orientation and
-- DOUBLED around the pickup point.
local function pickupUnitPos(t, u)
  local r = reservedBone(t, u)
  if not r then return nil end
  local p = t.pickup.pos
  if t.attachpoints == 1 then
    return cellOf(u, p[1], p[3])
  end
  local me = transportUnit(t)
  local x = __skeletonOf(me).xform[r.index + 1]
  local lp = (x and x.pos) or { 0, 0, 0 }
  local w = __qrot(t.pickup.ori, lp)
  return cellOf(u, p[1] + w[1] * 2.0, p[3] + w[3] * 2.0)
end

-- TransportGetAttachPosition (Cfile:804107-804162): the cell under the
-- reserved bone's current world position.
local function attachPosition(t, u)
  local r = reservedBone(t, u)
  if not r then return nil end
  local me = transportUnit(t)
  local wp = __boneWorld(me, r.index)
  return cellOf(u, wp[1], wp[3])
end

-- TransportGetAttachBonePosition / -Transform (Cfile:804175-804256).
local function attachBoneWorld(t, u)
  local r = reservedBone(t, u)
  local me = transportUnit(t)
  if not r then
    local p = me.__pos
    return { p[1], p[2], p[3] }, headingQuat(me)
  end
  return __boneWorld(me, r.index)
end

--- TransportGetLoadedUnits (Cfile:802994-803045): the attached units that
--- are not an UPGRADE, not Refueling and (with the flag) not stored.
function __transportLoadedUnits(t, excludeStored)
  local me = transportUnit(t)
  local out = {}
  for _, e in ipairs(me.__attachedEntities or {}) do
    if e.__isUnit and not inCategory(e, 'UPGRADE') and not (e.__unitStates and e.__unitStates.Refueling) then
      if not (excludeStored and t.stored[e.__id]) then out[#out + 1] = e end
    end
  end
  return out
end

-- AttachUnitToBone (Cfile:802200-802281): Entity::AttachTo with the
-- transport bone and the passenger's hook bone, the passenger out of the
-- pickup list, its move aborted, then OnTransportAttach(boneName, unit) on
-- the transport.
local function attachUnitToBone(t, boneIndex, u, hook)
  local me = transportUnit(t)
  __entityAttach(u, me, hook, boneIndex)
  removePickupUnit(t, u, false)
  u:GetNavigator():AbortMove()
  local name = __skeletonOf(me).names[boneIndex + 1]
  if name then runScript(me, 'OnTransportAttach', name, u) end
end

--- TransportAttachUnit (Cfile:803719-803744): a teleporter just clears the
--- pickup; otherwise the reserved bone takes the unit and mTransportedBy is
--- set.
function __transportAttachUnit(t, u)
  if t.teleporter then
    removePickupUnit(t, u, true)
    return true
  end
  local r = reservedBone(t, u)
  if not r then return false end
  attachUnitToBone(t, r.index, u, r.hook)
  u.__transportedBy = t.unit
  u:GetNavigator():AbortMove()
  return true
end

--- TransportDetachUnit (Cfile:803748-803863): the log lines for a unit that
--- is not attached here (the detach still runs), the footprint fit under an
--- airborne transport, Unit::DetachFrom WITHOUT skipBallistic (the drop),
--- the pickup and reservation cleared, mTransportedBy released,
--- OnTransportDetach(boneName, unit) on the transport, the move aborted.
function __transportDetachUnit(t, u)
  local me = transportUnit(t)
  if u.__attachParent ~= me then
    LOG('Transport attemping to detach unit that is not attached')
    LOG(string.format('Transport = %s, unit = %s', tostring(me.__bp.BlueprintId), tostring(u.__bp and u.__bp.BlueprintId)))
    if u.__dead then LOG('Attempted to detach a dead unit') end
  end
  if me.__layer == 'Air' then
    local p = u.__pos
    if not __footprintFitsAt(u, p[1], p[3]) then return false end
  end
  local boneIndex = u.__attachParentBone
  __entityDetach(u, false)
  removePickupUnit(t, u, true)
  u.__transportedBy = false
  local name = boneIndex and __skeletonOf(me).names[boneIndex + 1]
  if name then runScript(me, 'OnTransportDetach', name, u) end
  u:GetNavigator():AbortMove()
  return true
end

--- TransportDetachAllUnits (Cfile:803868-804094): every live attached unit
--- (an airborne transport releases only those whose footprint fits below,
--- unless destroySome); stored units die with the transport
--- (DestroyedOnTransport + Destroy); with destroySome each passenger dies
--- with 99 % (Kill by the transport, "Damage") -- a commander that cannot
--- be killed takes 10000 damage instead -- and the survivors are detached.
--- Returns the detached units.
function __transportDetachAllUnits(t, destroySome)
  local me = transportUnit(t)
  local toDetach, toDestroy = {}, {}
  for _, e in ipairs(me.__attachedEntities or {}) do
    if e.__isUnit and not e.__dead then
      local ok = destroySome or me.__layer ~= 'Air' or __footprintFitsAt(e, e.__pos[1], e.__pos[3])
      if ok then
        if t.stored[e.__id] then toDestroy[#toDestroy + 1] = e else toDetach[#toDetach + 1] = e end
      end
    end
  end
  local out = {}
  for _, e in ipairs(toDetach) do
    local detach = true
    if destroySome then
      -- The engine's own MT19937 stream is not reproduced; Random() draws
      -- the 99 % roll here (docs/STATUS.md).
      if Random() < 0.99 then
        local can = runScript(e, 'CheckCanBeKilled', me)
        if can ~= false then
          e:Kill(me, 'Damage', 0)
          detach = false
        elseif inCategory(e, 'COMMAND') and runScript(e, 'CheckCanTakeDamage') then
          runScript(e, 'OnDamage', me, 10000, { 0, 0, 0 }, 'Normal')
        end
      end
    end
    if detach then
      __transportDetachUnit(t, e)
      out[#out + 1] = e
    end
  end
  for _, e in ipairs(toDestroy) do
    runScript(e, 'DestroyedOnTransport')
    e:Destroy()
  end
  return out
end

--- TransportHasAvailableStorage (Cfile:804427-804433): stored + reserved
--- storage below the blueprint's StorageSlots.
function __transportHasAvailableStorage(t)
  local me = transportUnit(t)
  local slots = (me.__bp.Transport and me.__bp.Transport.StorageSlots) or 0
  local n = 0
  for _ in pairs(t.stored) do n = n + 1 end
  for _ in pairs(t.storedReserved) do n = n + 1 end
  return n < slots
end

--- TransportAddToStorage (Cfile:804308-804345): OnAddToStorage(transport) on
--- the unit, its reservation cleared, attached to the transport's own pose
--- (bones -1/-1), mTransportedBy, the stored set.
function __transportAddToStorage(t, u)
  local me = transportUnit(t)
  runScript(u, 'OnAddToStorage', me)
  t.storedReserved[u.__id] = nil
  removeUnitReservation(t, u)
  __entityAttach(u, me, -1, -1)
  u.__transportedBy = t.unit
  t.stored[u.__id] = true
end

-- =====================================================================
-- The tasks.
-- =====================================================================

local function setState(u, name, on)
  u.__unitStates = u.__unitStates or {}
  u.__unitStates[name] = on and true or nil
end

local function hasState(u, name)
  return (u.__unitStates and u.__unitStates[name]) == true
end

local function currentCommandId(id)
  local a = __orderActive[id]
  return a and a.cmdId or nil
end

-- The transport that a load command names for a passenger (DispatchTask
-- 830790-830866): the command's target, or -- for the reverse load, where
-- the passenger is its own target -- the first other unit of the command
-- set.
local function transportForPassenger(u, cmd)
  if cmd.target and cmd.target ~= u.__id then return __units[cmd.target] end
  for _, id in ipairs(cmd.set or {}) do
    if id ~= u.__id and __units[id] then return __units[id] end
  end
  return nil
end

-- NewCallTransportCommand (Cfile:822967-822990) / IssueCallLandTransportTask
-- (823518-823555): only a live unit with a transport component is a
-- transport; anything else is the warning and no task.
local function newCallTask(u, tr)
  if not tr or tr.__dead then return false end
  if not __transportOf(tr) then
    WARN(string.format('Attepted to call illegal transport %s', tostring(tr.__bp and tr.__bp.BlueprintId)))
    return false
  end
  __transportTasks[u.__id] = { kind = 'call', transport = tr.__id, state = 0, retries = 0, beamTime = 10.0, sleep = 0 }
  return true
end

-- CUnitLoadUnits ctor (Cfile:852325-852382): the passenger set, the
-- TransportLoading bit (0x100), OnStartTransportLoading.
local function newLoadTask(u, units)
  local t = __transportOf(u)
  if not t then return false end
  setState(u, 'TransportLoading', true)
  __transportTasks[u.__id] = { kind = 'load', units = units, tracked = units, state = 0, ticks = 0, result = false, usesBones = false, sleep = 0 }
  runScript(u, 'OnStartTransportLoading')
  return true
end

-- CUnitUnloadUnits ctor (Cfile:853241-853347): only the passengers this
-- transport carries stay in the set (v9b remembers that some requested unit
-- is carried at all), the TransportUnloading bit (0x200), the running move
-- aborted.
local function newUnloadTask(u, cmd, units)
  local t = __transportOf(u)
  if not t then return false end
  local set, anyCarried = {}, false
  for _, id in ipairs(units) do
    local p = __units[id]
    if p and not p.__dead and p ~= u and p.__transportedBy then
      anyCarried = true
      if p.__transportedBy == u.__id then set[#set + 1] = id end
    end
  end
  setState(u, 'TransportUnloading', true)
  __transportTasks[u.__id] = { kind = 'unload', units = set, anyCarried = anyCarried, state = 0, x = cmd.x, z = cmd.z, sleep = 0 }
  if isMobile(u) then u:GetNavigator():AbortMove() end
  return true
end

--- The dispatch of the three commands (DispatchTask, the labels one value
--- off, docs/research/command-dispatch-binary.md:49-62): TransportLoadUnits
--- (830700-830866), TransportReverseLoadUnits (830867-830945),
--- TransportUnloadUnits (830946-830991). Returns whether a task runs.
function __transportStartOrder(unitId, cmd)
  local u = __units[unitId]
  if not u then return false end
  if cmd.type == 'TransportLoad' then
    local target = __units[cmd.target]
    if target == u then
      -- The transport: the command set minus itself and minus every unit
      -- already carried (830808-830822); a carrier retrieves instead and a
      -- staging platform runs no load task (830825-830842).
      if inCategory(u, 'CARRIER') or inCategory(u, 'AIRSTAGINGPLATFORM') then return false end
      local set = {}
      for _, id in ipairs(cmd.set or {}) do
        local p = __units[id]
        if p and p ~= u and not p.__transportedBy then set[#set + 1] = id end
      end
      return newLoadTask(u, set)
    end
    if not target then return false end
    if inCategory(target, 'FERRYBEACON') or inCategory(target, 'CARRIER') or inCategory(target, 'AIRSTAGINGPLATFORM') or inCategory(target, 'TELEPORTATION') then
      -- The ferry, carrier, refuel and teleport tasks are not modelled
      -- (docs/STATUS.md): no task, the command completes.
      return false
    end
    return newCallTask(u, target)
  elseif cmd.type == 'TransportReverseLoad' then
    local target = __units[cmd.target]
    if target ~= u then
      if not __transportOf(u) or not target then return false end
      if inCategory(u, 'CARRIER') then return false end
      return newLoadTask(u, { target.__id })
    end
    local tr = transportForPassenger(u, cmd)
    if not tr then return false end
    if inCategory(tr, 'CARRIER') or inCategory(tr, 'AIRSTAGINGPLATFORM') or inCategory(tr, 'TELEPORTATION') then return false end
    return newCallTask(u, tr)
  elseif cmd.type == 'TransportUnload' then
    local t = __transportOf(u)
    if not t then return false end
    if #__transportLoadedUnits(t, false) == 0 then return false end
    return newUnloadTask(u, cmd, cmd.set or { unitId })
  end
  return false
end

-- CUnitLoadUnits dtor (Cfile:852391-852463): OnStopTransportLoading, the
-- bit cleared, the waiting formation dropped; on failure OnTransportAborted
-- and every tracked passenger's pickup released (after the 300-tick timeout
-- at once, otherwise only when it ended up carried by someone else) with
-- its move aborted.
local function endLoadTask(u, task)
  runScript(u, 'OnStopTransportLoading')
  setState(u, 'TransportLoading', nil)
  local t = __transportOf(u)
  if t and not task.result then
    runScript(u, 'OnTransportAborted')
    for _, id in ipairs(task.tracked) do
      local p = __units[id]
      if p then
        if task.ticks > 300 then removePickupUnit(t, p, true) end
        if p.__transportedBy ~= u.__id then
          if task.ticks <= 300 then removePickupUnit(t, p, true) end
          p:GetNavigator():AbortMove()
        end
      end
    end
  end
end

local function endCallTask(u, task)
  setState(u, 'WaitingForTransport', nil)
  setState(u, 'Teleporting', nil)
end

local function endUnloadTask(u, task)
  setState(u, 'TransportUnloading', nil)
end

--- The task of a unit ends (the command completed, was replaced or the unit
--- died): the destructor side effects.
function __transportAbort(unitId)
  local task = __transportTasks[unitId]
  if not task then return end
  __transportTasks[unitId] = nil
  local u = __units[unitId]
  if not u then return end
  if task.kind == 'load' then endLoadTask(u, task)
  elseif task.kind == 'call' then endCallTask(u, task)
  elseif task.kind == 'unload' then endUnloadTask(u, task) end
end

-- CUnitLoadUnits::DoTask (Cfile:852567-852996; the decompilation is
-- degraded there): the passengers by distance, a slot for each
-- (TransportAssignSlot), OnTransportFull when one gets none (852819), the
-- pickup at the passengers' average position (AddPickupUnits). The "uses
-- bones" flag (v17, 853082) is read as "at least one bone slot assigned" --
-- UNVERIFIED.
local function loadDoTask(u, task)
  local t = __transportOf(u)
  local me = u.__pos
  local cands = {}
  for _, id in ipairs(task.units) do
    local p = __units[id]
    if unitLive(p) and not p.__transportedBy then
      local dx, dz = p.__pos[1] - me[1], p.__pos[3] - me[3]
      cands[#cands + 1] = { id = id, d2 = dx * dx + dz * dz }
    end
  end
  table.sort(cands, function(a, b)
    if a.d2 == b.d2 then return a.id < b.id end
    return a.d2 < b.d2
  end)
  local assigned, full = {}, false
  for _, c in ipairs(cands) do
    local p = __units[c.id]
    if reservedBone(t, p) or __transportAssignSlot(t, p, -1) then
      assigned[#assigned + 1] = c.id
    else
      full = true
    end
  end
  if full then runScript(u, 'OnTransportFull') end
  if #assigned > 0 then
    task.usesBones = true
    local sx, sz = 0, 0
    for _, id in ipairs(assigned) do
      sx = sx + __units[id].__pos[1]
      sz = sz + __units[id].__pos[3]
    end
    task.avg = { sx / #assigned, sz / #assigned }
    addPickupUnits(t, assigned, task.avg[1], task.avg[2])
  else
    task.avg = { me[1], me[3] }
  end
end

-- CUnitLoadUnits::TaskTick (Cfile:852997-853213). Returns -1 (done), or the
-- ticks to wait.
local function loadTick(u, task)
  local t = __transportOf(u)
  if u.__layer == 'Seabed' then return -1 end
  if task.waitMove then
    if u.__goal then return 1 end
    task.waitMove = nil
  end
  local state = task.state
  if state == 0 then
    -- Preparing (853041-853075): every live, unattached passenger must be
    -- on the SAME command as the transport before the slots are handed out.
    if not hasState(u, 'AssistMoving') and not hasState(u, 'Ferrying') then
      local mine = currentCommandId(u.__id)
      for _, id in ipairs(task.units) do
        local p = __units[id]
        if unitLive(p) and not p.__beingBuilt and not hasState(p, 'Attached') and currentCommandId(id) ~= mine then
          return 1
        end
      end
    end
    loadDoTask(u, task)
    task.state = 1
    return 0
  elseif state == 1 then
    -- Waiting (853076-853124).
    if not isMobile(u) then
      task.state = 2
      return 1
    end
    if not task.usesBones and not __transportHasAvailableStorage(t) then return -1 end
    local isAir = u.__bp.Air and u.__bp.Air.CanFly
    if t.stagingPlatform or t.teleporter or not isAir then
      -- A ground transport, staging platform or teleporter stays put; the
      -- passengers come to it (853090-853103).
      if u.__goal then u:GetNavigator():AbortMove() end
      task.state = 2
      return 1
    end
    -- The air transport flies to its passengers (853104-853123):
    -- OnTransportOrdered, then a Land-layer move to the average pickup
    -- position -- unless it is already landed within GuardScanRadius of it
    -- -- facing the pickup direction.
    runScript(u, 'OnTransportOrdered')
    local avg = task.avg
    if u.__layer ~= 'Air' and not hasState(u, 'AssistMoving') then
      local dx, dz = u.__pos[1] - avg[1], u.__pos[3] - avg[2]
      local scan = (u.__bp.AI and u.__bp.AI.GuardScanRadius) or 0
      if math.sqrt(dx * dx + dz * dz) <= scan then
        task.state = 2
        return 1
      end
    end
    local cx, cz = cellOf(u, avg[1], avg[2])
    local wx, wz = cellCentre(u, cx, cz)
    u:GetNavigator():SetGoal({ wx, 0, wz })
    local f = t.pickup.facing
    if f[1] ~= 0 or f[3] ~= 0 then u.__faceGoal = { u.__pos[1] + f[1], u.__pos[3] + f[3] } end
    task.waitMove = true
    task.state = 2
    return 1
  elseif state == 2 then
    -- Starting (853125-853128): TransportAtPickupPosition -> mHasSpace.
    t.pickup.hasSpace = true
    task.state = 3
    return 1
  elseif state == 3 then
    -- Processing (853129-853168): a staging platform polls the pickup
    -- count every 10 ticks; a transport counts to the 300-tick timeout.
    if t.stagingPlatform then
      if pickupCount(t) > 0 then return 10 end
      task.state = 4
      return 1
    end
    task.ticks = task.ticks + 1
    if pickupCount(t) > 0 and task.ticks <= 300 then return 1 end
    -- TransportGetUnitsWaitingForPickup (the waiting formation, 802850-
    -- 802858) is empty here: no formation model (docs/STATUS.md).
    task.result = task.ticks <= 300
    return -1
  else
    -- Complete (853169-853204): the staging platform waits until nothing
    -- is loaded any more, then finishes.
    if #__transportLoadedUnits(t, true) > 0 then return 10 end
    task.result = true
    return -1
  end
end

-- Quaternion slerp (w, x, y, z) for the beam-up (func_QuatLERP,
-- Cfile:823240; whether it is a spherical or a normalised linear
-- interpolation is UNVERIFIED -- the two coincide for the small angles of a
-- ground unit turning under its transport).
local function slerp(a, b, f)
  local dot = a[1] * b[1] + a[2] * b[2] + a[3] * b[3] + a[4] * b[4]
  local bb = b
  if dot < 0 then
    dot = -dot
    bb = { -b[1], -b[2], -b[3], -b[4] }
  end
  local wa, wb
  if dot > 0.9995 then
    wa, wb = 1 - f, f
  else
    local theta = math.acos(dot)
    local s = math.sin(theta)
    wa, wb = math.sin((1 - f) * theta) / s, math.sin(f * theta) / s
  end
  local q = { wa * a[1] + wb * bb[1], wa * a[2] + wb * bb[2], wa * a[3] + wb * bb[3], wa * a[4] + wb * bb[4] }
  local n = math.sqrt(q[1] * q[1] + q[2] * q[2] + q[3] * q[3] + q[4] * q[4])
  if n > 0 then for i = 1, 4 do q[i] = q[i] / n end end
  return q
end

local function yawOf(q)
  local w, x, y, z = q[1], q[2], q[3], q[4]
  local fx = 2 * (x * z + w * y)
  local fz = 1 - 2 * (x * x + y * y)
  return math.atan(fx, fz)
end

-- CUnitCallTransport::TaskTick (Cfile:822991-823249).
local function callTick(u, task)
  local tr = __units[task.transport]
  if not tr or tr.__dead then return -1 end
  local t = __transportOf(tr)
  if not t then return -1 end
  -- The sync gate: once past Preparing the transport must stay
  -- TransportLoading (823090-823095).
  if task.state ~= 0 and not hasState(tr, 'TransportLoading') then return -1 end
  if task.waitMove then
    if u.__goal then return 1 end
    task.waitMove = nil
  end
  local state = task.state
  if state == 0 then
    -- Preparing (823096-823123): the transport loading, not holding, and on
    -- the same command (or assist-moving).
    if hasState(tr, 'TransportLoading') and not hasState(tr, 'HoldingPattern')
      and (currentCommandId(tr.__id) == currentCommandId(u.__id) or hasState(tr, 'AssistMoving')) then
      task.state = 1
      return 3
    end
    return 10
  elseif state == 1 then
    -- Waiting (823124-823147): assigned for this pickup, the
    -- WaitingForTransport bit, then the walk to the attach cell (ready) or
    -- the staging cell (not yet).
    if not assignedForPickup(t, u) then return -1 end
    setState(u, 'WaitingForTransport', true)
    local cx, cz
    if readyForUnit(t, u) then cx, cz = attachPosition(t, u) else cx, cz = pickupUnitPos(t, u) end
    if not cx then return -1 end
    task.state = 2
    local wx, wz = cellCentre(u, cx, cz)
    u:GetNavigator():SetGoal({ wx, 0, wz })
    task.waitMove = true
    return 1
  elseif state == 2 then
    -- Starting (823148-823181): within twice the TRANSPORT's footprint of
    -- the attach bone the beam-up begins; otherwise back to Waiting, five
    -- times at most.
    if not readyForUnit(t, u) then return 1 end
    local bp = attachBoneWorld(t, u)
    local dx, dz = u.__pos[1] - bp[1], u.__pos[3] - bp[3]
    local sx, sz = footprint(tr)
    if math.sqrt(dx * dx + dz * dz) <= math.max(sx, sz) * 2.0 then
      u:GetNavigator():AbortMove()
      u.__faceGoal = false
      task.trans1 = { pos = { u.__pos[1], u.__pos[2], u.__pos[3] }, rot = headingQuat(u) }
      local wp, wq = attachBoneWorld(t, u)
      task.trans2 = { pos = wp, rot = wq }
      local r = reservedBone(t, u)
      runScript(u, 'OnStartTransportBeamUp', tr, (r and r.index) or -1)
      setState(u, 'Teleporting', true)
      task.state = 3
      return 1
    end
    task.retries = task.retries + 1
    if task.retries > 5 then return -1 end
    task.state = 1
    return 0
  else
    -- Processing (823182-823249): mBeamupTime 10 -> 1, the pose eased
    -- from the start toward the live attach bone (its y less the unit's
    -- SizeY) with cos(t * pi * 0.1) * 0.5 + 0.5; at 1 the attach.
    if task.beamTime <= 1.0 then
      runScript(u, 'OnStopTransportBeamUp')
      setState(u, 'Teleporting', nil)
      setState(u, 'WaitingForTransport', nil)
      if __transportAttachUnit(t, u) then task.result = true end
      return -1
    end
    local f = math.cos(task.beamTime * math.pi * 0.1) * 0.5 + 0.5
    local wp, wq = attachBoneWorld(t, u)
    task.trans2 = { pos = { wp[1], wp[2] - ((u.__bp and u.__bp.SizeY) or 0), wp[3] }, rot = wq }
    local a, b = task.trans1, task.trans2
    u.__pos[1] = a.pos[1] + (b.pos[1] - a.pos[1]) * f
    u.__pos[2] = a.pos[2] + (b.pos[2] - a.pos[2]) * f
    u.__pos[3] = a.pos[3] + (b.pos[3] - a.pos[3]) * f
    local q = slerp(a.rot, b.rot, f)
    u.__heading = yawOf(q)
    u.__orient = { q[2], q[3], q[4], q[1] }
    task.beamTime = task.beamTime - 1.0
    return 1
  end
end

-- CUnitUnloadUnits::TaskTick (Cfile:853499-853809).
local function unloadTick(u, task)
  local t = __transportOf(u)
  local attached = u.__attachedEntities
  if not attached or #attached == 0 or (task.anyCarried and #task.units == 0) then return -1 end
  if task.waitMove then
    if u.__goal then return 1 end
    task.waitMove = nil
  end
  local state = task.state
  if state == 0 then
    -- Preparing (853563-853573): only a surfacing sub under water changes
    -- layer first; everyone else goes straight to Starting.
    task.state = 2
    return 0
  elseif state == 1 then
    task.state = 2
    return 0
  elseif state == 2 then
    -- Starting (853578-853588): the move to the drop point.
    if not t.stagingPlatform and isMobile(u) then
      u:GetNavigator():SetGoal({ task.x, 0, task.z })
      task.waitMove = true
    end
    task.state = 3
    return 0
  elseif state == 3 then
    -- Processing (853589-853801): the detach -- everyone when the
    -- requested set is empty, else each requested passenger.
    local dropped
    if #task.units == 0 then
      dropped = __transportDetachAllUnits(t, false)
    else
      dropped = {}
      for _, id in ipairs(task.units) do
        local p = __units[id]
        if p and __transportDetachUnit(t, p) then dropped[#dropped + 1] = p end
      end
    end
    local isAir = u.__bp.Air and u.__bp.Air.CanFly
    if not t.stagingPlatform and isAir then
      -- An air transport re-targets itself in the Air layer (853603-853611)
      -- and leaves the placement to the passengers' own fall.
      task.state = 4
      return 0
    end
    -- A ground transport or staging platform (853612-853800): each dropped
    -- unit is warped to a free cell beside the transport (HasMeleeSpace-
    -- AroundSmall/LargeTarget -> the first free cell here) and, for an
    -- immobile transport or a platform, ordered to the drop point.
    for _, p in ipairs(dropped) do
      if t.stagingPlatform then
        if p.__bp.Air and p.__bp.Air.CanFly then p.__ballisticDrop = nil end
      else
        local x, z = __freeSpotNear(p, u.__pos[1], u.__pos[3])
        p.__pos[1], p.__pos[3] = x, z
        p.__pos[2] = GetSurfaceHeight(x, z)
        p.__ballisticDrop = nil
        p.__heading = u.__heading or 0
      end
    end
    if t.stagingPlatform or not isMobile(u) then
      for _, p in ipairs(dropped) do
        __issueOrder(p.__id, { type = 'Move', x = task.x, z = task.z }, true)
      end
    end
    task.state = 4
    return 0
  else
    return -1
  end
end

--- One beat of a unit's transport task. Returns true when the task -- and
--- with it the command -- is complete.
function __transportOrderTick(unitId, cmd)
  local task = __transportTasks[unitId]
  local u = __units[unitId]
  if not task or not u then return true end
  if task.sleep and task.sleep > 0 then
    task.sleep = task.sleep - 1
    return false
  end
  local result
  for _ = 1, 8 do
    if task.kind == 'load' then result = loadTick(u, task)
    elseif task.kind == 'call' then result = callTick(u, task)
    else result = unloadTick(u, task) end
    if result ~= 0 then break end
  end
  if result == -1 then
    __transportAbort(unitId)
    return true
  end
  task.sleep = math.max(0, (result or 1) - 1)
  return false
end

-- =====================================================================
-- The user commands and the bindings.
-- =====================================================================

-- func_ProcessUnitCommand for UNITCOMMAND_TransportLoadUnits
-- (Cfile:1007144-1007253): a carried unit or a POD never; the transport
-- itself always; a passenger needs RULEUCC_CallTransport, a target that is
-- not on the seabed, a live, finished transport unit with a component that
-- can carry it -- else "OnTransportReject" on the target and no command.
-- The ferry beacon and factory targets take the ferry path (not modelled,
-- docs/STATUS.md) and are refused here.
local function validateLoad(u, target)
  if u.__transportedBy or inCategory(u, 'PODS') then return false end
  if not target then return true end
  if target ~= u and (__ensureCommandCapMask(u) & RULEUCC_CallTransport) == 0 then return false end
  if target.__layer == 'Seabed' then return false end
  if inCategory(target, 'FERRYBEACON') then return false end
  if inCategory(target, 'FACTORY') and not inCategory(target, 'AIRSTAGINGPLATFORM') and not inCategory(target, 'TELEPORTATION') then
    return false
  end
  if target.__dead or target.__beingBuilt then return false end
  local t = __transportOf(target)
  if not t then return false end
  if target == u or __transportCanCarryUnit(t, u) then return true end
  runScript(target, 'OnTransportReject')
  return false
end

local function issueTo(ids, cmdOf, clear)
  local cmdId = __nextCommand
  __nextCommand = __nextCommand + 1
  for _, id in ipairs(ids) do
    local cmd = cmdOf(id)
    cmd.cmdId = cmdId
    cmd.set = ids
    __issueOrder(id, cmd, clear)
  end
  return cmdId
end

--- The user's CallTransport click (HandleEvent, Cfile:1241799-1241870):
--- TransportLoadUnits with the transport as target to the passengers AND
--- the transport itself (unless it is a ferry beacon or an air staging
--- platform, or is a carrier); every unit validated on its own.
function __dispatchTransportLoad(unitIds, transportId, clear)
  local target = __units[transportId]
  if not target then return end
  local ids = {}
  for _, id in ipairs(unitIds) do
    local u = __units[id]
    if u and validateLoad(u, target) then ids[#ids + 1] = id end
  end
  local addTransport = (not inCategory(target, 'FERRYBEACON') and not inCategory(target, 'AIRSTAGINGPLATFORM'))
    or inCategory(target, 'CARRIER')
  if addTransport and validateLoad(target, target) then ids[#ids + 1] = transportId end
  if #ids == 0 then return end
  issueTo(ids, function() return { type = 'TransportLoad', target = transportId } end, clear)
end

-- Unit::IsIdleState for the reverse load's distance weight: no running
-- command and no move goal.
local function isIdle(u)
  return __orderActive[u.__id] == nil and not u.__goal
end

--- The user's Transport click on a unit (HandleEvent, Cfile:1241600-1241617):
--- TransportReverseLoadUnits with the unit as target. UNIT_IssueCommand
--- reshapes the set (sub_6EF660, Cfile:1006333-1006500): the closest
--- transport with space for the target -- an idle one counts half its
--- distance -- plus the target; then the reverse-load validation
--- (1007254-1007324): a carried unit or POD never, and a transport in the
--- set must be able to carry the target, else "OnTransportReject".
function __dispatchTransportReverseLoad(transportIds, targetId, clear)
  local target = __units[targetId]
  if not target or target.__dead or not isMobile(target) then return end
  local best, bestD
  for _, id in ipairs(transportIds) do
    local u = __units[id]
    if u and not u.__dead and not u.__beingBuilt
      and (inCategory(u, 'TRANSPORTATION') or inCategory(u, 'AIRSTAGINGPLATFORM') or inCategory(u, 'TELEPORTATION')) then
      local t = __transportOf(u)
      if t and __transportHasSpaceFor(t, target.__bp) then
        local dx, dz = u.__pos[1] - target.__pos[1], u.__pos[3] - target.__pos[3]
        local d = math.sqrt(dx * dx + dz * dz)
        if isIdle(u) then d = d * 0.5 end
        if not bestD or d < bestD then best, bestD = u, d end
      end
    end
  end
  if not best then return end
  local ids = {}
  for _, u in ipairs({ best, target }) do
    local ok = (isMobile(u) or inCategory(u, 'AIRSTAGINGPLATFORM')) and not u.__transportedBy and not inCategory(u, 'PODS')
    if ok then
      local t = __transportOf(best)
      if __transportCanCarryUnit(t, target) then
        if best.__layer ~= 'Seabed' then ids[#ids + 1] = u.__id end
      elseif best ~= u then
        runScript(best, 'OnTransportReject')
      end
    end
  end
  if #ids == 0 then return end
  issueTo(ids, function() return { type = 'TransportReverseLoad', target = targetId } end, clear)
end

-- func_ProcessUnitCommand for UNITCOMMAND_TransportUnloadUnits
-- (Cfile:1007325-1007334): not on the seabed, and a transport or a carried
-- unit.
local function validateUnload(u)
  if u.__layer == 'Seabed' then return false end
  return __transportOf(u) ~= nil or (u.__transportedBy and true or false)
end

--- The user's Transport click on the ground (HandleEvent, Cfile:1241640-
--- 1241665): TransportUnloadUnits with the point.
function __dispatchTransportUnload(unitIds, x, z, clear)
  local ids = {}
  for _, id in ipairs(unitIds) do
    local u = __units[id]
    if u and validateUnload(u) then ids[#ids + 1] = id end
  end
  if #ids == 0 then return end
  issueTo(ids, function() return { type = 'TransportUnload', x = x, z = z } end, clear)
end

local function issueArgs(name, want, ...)
  local n = select('#', ...)
  if n ~= want then
    error(string.format('%s\n  expected %d args, but got %d', name, want, n), 3)
  end
end

--- IssueTransportLoad(units, transport) -- cfunc_IssueTransportLoadL
--- (Cfile:1011850-1011985): two arguments, the transport a unit, every unit
--- that is attached to something or carried is the error, none at all the
--- other; the transport joins the set, the target is the transport, one
--- UNITCOMMAND_TransportLoadUnits through UNIT_IssueCommand with clear = 0,
--- no handle. ai/aiutilities.lua:1453 and scenarioplatoonai.lua:1979 load
--- their platoons with it.
function IssueTransportLoad(...)
  issueArgs('IssueTransportLoad', 2, ...)
  local units, transport = ...
  if type(transport) ~= 'table' or not transport.__id or not __units[transport.__id] then
    error("Expected a game object. (Did you call with '.' instead of ':'?)", 2)
  end
  if type(units) ~= 'table' then error('IssueTransportLoad: expected a table of units, got ' .. type(units), 2) end
  local ids = {}
  for _, u in ipairs(units) do
    if type(u) == 'table' and u.__id and __units[u.__id] then
      if u.__attachParent or u.__transportedBy then
        error('IssueTransportLoad: One or more units are already attached to something.', 2)
      end
      ids[#ids + 1] = u.__id
    end
  end
  if #ids == 0 then error("IssueTransportLoad: Couldn't find any units to load.", 2) end
  ids[#ids + 1] = transport.__id
  local set = {}
  for _, id in ipairs(ids) do
    if validateLoad(__units[id], transport) then set[#set + 1] = id end
  end
  if #set == 0 then return end
  issueTo(set, function() return { type = 'TransportLoad', target = transport.__id } end, false)
end

--- IssueTransportUnload(units, target) -- cfunc_IssueTransportUnloadL
--- (Cfile:1012005-1012090): two arguments, RULEUCC_Transport validated, the
--- target an entity or a Vec3 (CAiTarget::SetTarget) reduced to its
--- position (GetTargetPosGun), one UNITCOMMAND_TransportUnloadUnits with an
--- AITARGET_Ground target, clear = 0, no handle. platoon.lua:2462 and
--- scenarioframework.lua:1259 drop their cargo with it.
function IssueTransportUnload(...)
  issueArgs('IssueTransportUnload', 2, ...)
  local units, target = ...
  if type(units) ~= 'table' then error('IssueTransportUnload: expected a table of units, got ' .. type(units), 2) end
  local x, z
  if type(target) == 'table' then
    if target.__id and (__units[target.__id] or (__props and __props[target.__id])) then
      local e = __units[target.__id] or __props[target.__id]
      x, z = e.__pos[1], e.__pos[3]
    else
      x, z = target[1] or target.x, target[3] or target.z
    end
  else
    error(string.format('Invalid target set in IssueTransportUnload; expected an entity or a Vec3 but got a %s', type(target)), 2)
  end
  if type(x) ~= 'number' or type(z) ~= 'number' or x ~= x or z ~= z then
    error('IssueTransportUnload: Passed in an invalid target point.', 2)
  end
  local ids = {}
  for _, u in ipairs(units) do
    if type(u) == 'table' and u.__id and __units[u.__id]
      and (__ensureCommandCapMask(u) & RULEUCC_Transport) ~= 0 and validateUnload(u) then
      ids[#ids + 1] = u.__id
    end
  end
  if #ids == 0 then return end
  issueTo(ids, function() return { type = 'TransportUnload', x = x, z = z } end, false)
end
