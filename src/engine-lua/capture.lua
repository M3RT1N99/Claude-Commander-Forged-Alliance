-- =====================================================================
-- The capture task -- Moho::CUnitCaptureTask (AiUnitCapture.cpp,
-- Cfile:826337-827453): the dispatch constructor (826361-826459), TaskTick
-- (826579-827099), DoCallback (827100-827293) and the destructor
-- (827294-827453) -- behind UNITCOMMAND_Capture (DispatchTask 830696-830697,
-- under the off-by-one case label) and the Sim binding IssueCapture
-- (cfunc_IssueCaptureL 1011584-1011666, globals.lua).
--
-- A captor walks up to its target, marks both (Capturing / BeingCaptured),
-- prices the capture through the script's GetCaptureCosts (time, energy,
-- mass; unit.lua:2734-2743), consumes energy and mass at cost / time per
-- tick through a CEconRequest of its own (826936-826950; economy.ts) and
-- advances one step per capturer of the target per tick; at mCapTime the
-- target hears OnStopBeingCaptured and OnCaptured and the script transfers
-- it (unit.lua:555-620 -> simutils.lua TransferUnitsOwnership ->
-- ChangeUnitArmy, units.lua).
--
-- Not modelled, recorded rather than faked (docs/STATUS.md): the landing
-- spot beside the target's skirt (PrepareMove + ReserveOgridRect,
-- 826745-826776 -- the navigator goal is the target and the ground model
-- stops at its footprint), the build arm (PrepareArmToBuild 826831-826845,
-- 827355-827362), the recon blip as a target (826791-826805: the target
-- here is the unit itself), the dispatcher's AIRES result codes (the
-- command simply ends).
--
-- STANDARD LUA 5.4 (goes raw into host.eval).
-- =====================================================================

__captureTasks = __captureTasks or {} -- captor id -> task
local nextKey = 1

local function runScript(u, name, ...)
  local f = u and u[name]
  if type(f) ~= 'function' then return end
  local ok, err = pcall(f, u, ...)
  if not ok then WARN(name .. ': ' .. tostring(err)) end
end

local function isUnit(t) return t ~= nil and t.__isUnit == true end
local function gone(t) return t == nil or t.__destroyed == true end

local function footprintSize(u)
  local fp = (u.__bp and u.__bp.Footprint) or {}
  return math.max(fp.SizeX or 1, fp.SizeZ or 1)
end

-- The distance the task works with (826692-826716): the XZ distance of the
-- two positions minus the larger footprint side of each unit.
local function edgeDistance(u, t)
  local p, q = u.__pos, t.__pos
  local dx, dz = q[1] - p[1], q[3] - p[3]
  return math.sqrt(dx * dx + dz * dz) - footprintSize(u) - footprintSize(t)
end

local function isMobile(t)
  local mt = t.__bp and t.__bp.Physics and t.__bp.Physics.MotionType
  return mt ~= nil and mt ~= 'RULEUMT_None'
end

-- Unit::DecrementCapturers (Cfile:603EF0-603F2F): never below zero.
local function decrementCapturers(t)
  local n = t.__capturers or 0
  if n > 0 then t.__capturers = n - 1 end
end

-- CUnitCaptureTask::DoCallback (827100-827293). The start marks the target
-- BeingCaptured, counts one more capturer on it and runs
-- OnStartBeingCaptured(captor) on the target, OnStartCapture(target) on the
-- captor (827160-827175). The end -- only after a start, and only for a
-- target that is still a live unit not queued for deletion (827115-827130)
-- -- takes the capturer back, clears BeingCaptured once no capturer is left
-- (827144-827158) and runs OnFailedBeingCaptured(captor) on the target,
-- OnFailedCapture(target) on the captor (827170-827181). A captured target
-- is queued for deletion by then (units.lua __transferUnit), so a completed
-- capture fires no "failed" pair.
local function doCallback(task, start)
  if start == task.hasStarted then return end
  task.hasStarted = start
  local u = __units[task.captor]
  local t = __units[task.target]
  if start then
    -- The engine marks the target without a test (827160-827175; the
    -- Starting state has just checked it); the unit test here is the
    -- port's own guard for a target that vanished the same tick.
    if isUnit(t) then
      t:SetUnitState('BeingCaptured', true)
      t.__capturers = (t.__capturers or 0) + 1
      runScript(t, 'OnStartBeingCaptured', u)
    end
    runScript(u, 'OnStartCapture', t)
  elseif isUnit(t) and not gone(t) and not t.__dead and not t.__destroyQueued then
    decrementCapturers(t)
    if t:IsUnitState('BeingCaptured') and (t.__capturers or 0) == 0 then
      t:SetUnitState('BeingCaptured', false)
    end
    runScript(t, 'OnFailedBeingCaptured', u)
    runScript(u, 'OnFailedCapture', t)
  end
end

--- The destructor (827294-827453): the focus entity and the target blip
--- released (827317-827345; an empty focus runs no OnAssignedFocusEntity),
--- the Capturing bit cleared and mWorkProgress zeroed (827349-827353),
--- DoCallback(false) (827354), the request deleted (827364-827376). The
--- move sub-task dies with the task.
function __captureAbort(unitId)
  local task = __captureTasks[unitId]
  if not task then return end
  __captureTasks[unitId] = nil
  local u = __units[unitId]
  if u then
    u.__focusEntity = nil
    u.__targetBlip = nil
    u:SetUnitState('Capturing', false)
    u.__workProgress = 0
    if task.moving and u.__goal then
      u.__goal = false
      u.__speed = 0
    end
  end
  doCallback(task, false)
  if task.key then __econClearBuildRequest(task.army, task.key) end
end

--- The dispatch constructor (826361-826459): the task on the command's
--- target, TASKSTATE_Preparing, the target as the captor's focus entity with
--- OnAssignedFocusEntity (826403-826411), the target blip (826422-826425).
function __captureStart(unitId, cmd)
  local u = __units[unitId]
  if not u then return false end
  __captureAbort(unitId)
  local t = __units[cmd.target]
  __captureTasks[unitId] = {
    captor = unitId, target = cmd.target, state = 'Preparing', hasStarted = false,
    capTime = 0, capProgress = 0, rateE = 0, rateM = 0, key = nil, army = u.__army or 1,
    moving = false,
  }
  u.__focusEntity = t
  if t then runScript(u, 'OnAssignedFocusEntity') end
  u.__targetBlip = nil
  return true
end

local function finish(unitId)
  __captureAbort(unitId)
  return true
end

--- TaskTick (826579-827099), once per beat while the command is active;
--- true ends the command (the engine's -1).
function __captureOrderTick(unitId, cmd)
  local task = __captureTasks[unitId]
  local u = __units[unitId]
  if not task or not u then return true end
  local t = __units[task.target]
  -- The preamble (826629-826650): a target that is gone, or a unit that is
  -- not capturable (UnitAttributes.mCapturable, Unit:SetCapturable), ends
  -- the task with OnStopCapture on the captor -- with the CAPTOR as the
  -- argument (826721 passes &mUnit, the same pointer DoCallback hands the
  -- target as "captor"; the Complete state passes the target, 827077).
  if gone(t) or (isUnit(t) and not t:IsCapturable()) then
    runScript(u, 'OnStopCapture', u)
    return finish(unitId)
  end
  -- (826651-826690): a target without an army, in the Air layer (the
  -- mVarDat.mLayer == 16 test) or allied with the captor ends the task
  -- without a word (AIRES_2).
  if isUnit(t) and (t.__army == nil or t.__layer == 'Air' or IsAlly(u.__army or 1, t.__army)) then
    return finish(unitId)
  end
  local dist = edgeDistance(u, t)
  -- A mobile target that is already being captured and more than 10 away
  -- (826717-826729; the "mobile" is the target's vtable slot 4, read as
  -- IsMobile -- UNVERIFIED).
  if isMobile(t) and t:IsUnitState('BeingCaptured') and dist > 10 then
    return finish(unitId)
  end
  local st = task.state
  if st == 'Preparing' then
    -- (826733-826782): more than 5 away, the captor moves beside the target
    -- (PrepareMove, ReserveOgridRect, NewMoveTask); the goal is the target
    -- here and the ground model stops at its footprint.
    if dist > 5 then
      u.__goal = { t.__pos[1], t.__pos[3] }
      u.__faceGoal = false
      task.moving = true
    end
    task.state = 'Waiting'
    return false
  elseif st == 'Waiting' then
    -- The move sub-task runs first; the task's own tick resumes when it is
    -- done (the goal reached or blocked, or the unit within the 5).
    if task.moving then
      if dist <= 5 then
        u.__goal = false
        u.__speed = 0
        task.moving = false
      elseif u.__goal then
        return false
      else
        task.moving = false
      end
    end
    -- (826784-826790)
    if dist > 10 then return finish(unitId) end
    -- (826806-826830): the target must be a live unit not queued for
    -- deletion, or the task ends without a callback.
    if not isUnit(t) or t.__dead or t.__destroyQueued then return finish(unitId) end
    -- PrepareArmToBuild at the target's bone -1 (826831-826845): no build
    -- arm model here. Then the Capturing bit (826847-826849).
    u:SetUnitState('Capturing', true)
    task.state = 'Starting'
    return false
  elseif st == 'Starting' then
    -- (826851-826935): the captor's GetCaptureCosts(target) -- three
    -- numbers or the warning and the end; the time in ticks (x 10, at
    -- least 1, truncated into mCapTime), plus the same for every attached
    -- unit of the target that is not being built; energy and mass summed
    -- and clamped at 0; the per-tick rates are cost / mCapTime.
    local ok, time, energy, mass = pcall(u.GetCaptureCosts, u, t)
    if not ok or type(time) ~= 'number' or type(energy) ~= 'number' or type(mass) ~= 'number' then
      WARN('Failed to get valid capture costs from the target')
      return finish(unitId)
    end
    task.capTime = math.floor(task.capTime + math.max(1, time * 10))
    for _, e in ipairs(t.__attachedEntities or {}) do
      if isUnit(e) and not e:IsBeingBuilt() then
        local ok2, t2, e2, m2 = pcall(u.GetCaptureCosts, u, e)
        if ok2 and type(t2) == 'number' and type(e2) == 'number' and type(m2) == 'number' then
          task.capTime = math.floor(task.capTime + math.max(1, t2 * 10))
          energy = energy + e2
          mass = mass + m2
        end
      end
    end
    if energy < 0 then energy = 0 end
    if mass < 0 then mass = 0 end
    task.rateE = energy / task.capTime
    task.rateM = mass / task.capTime
    -- The task's own CEconRequest at that rate (826936-826950).
    task.key = -(700000 + nextKey)
    nextKey = nextKey + 1
    __econSetBuildRequest(task.army, task.key, task.rateM, task.rateE)
    doCallback(task, true)
    task.state = 'Processing'
    return false
  elseif st == 'Processing' then
    -- (826956-826990): once the request holds a tick's rate of both
    -- resources they are taken (sub_773740) into mResourcesSpent and the
    -- progress advances by the target's capturer count, capped at
    -- mCapTime; mWorkProgress is the fraction. Below mCapTime the task
    -- continues (1). The economy keeps 32-bit floats: a tick's grant may
    -- sit a rounding below the rate, so the compare allows one part in a
    -- million.
    local gE = __econRequestGranted(task.army, task.key, 'ENERGY')
    local gM = __econRequestGranted(task.army, task.key, 'MASS')
    if gE >= task.rateE * (1 - 1e-6) and gM >= task.rateM * (1 - 1e-6) then
      __econRequestTake(task.army, task.key)
      u.__spentEnergy = (u.__spentEnergy or 0) + gE
      u.__spentMass = (u.__spentMass or 0) + gM
      local prog = task.capProgress + (t.__capturers or 0)
      if prog > task.capTime then prog = task.capTime end
      task.capProgress = prog
      u.__workProgress = prog / task.capTime
    end
    if task.capProgress < task.capTime then return false end
    task.state = 'Complete'
    return false
  elseif st == 'Complete' then
    -- (826992-827005): OnStopCapture(target) on the captor, then
    -- OnStopBeingCaptured(captor) and OnCaptured(captor) on the target; the
    -- task ends (-1) and its destructor follows.
    runScript(u, 'OnStopCapture', t)
    runScript(t, 'OnStopBeingCaptured', u)
    runScript(t, 'OnCaptured', u)
    return finish(unitId)
  end
  return true
end
