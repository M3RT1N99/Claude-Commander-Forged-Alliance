__buildTasks = {}
__nextBuildTask = 1

-- Place construction order: Farmer builds the construction site. He runs out of reach
-- first (approach via the navigator).
--
-- `order` is the order string that the engine passes to OnStartBuild:
-- 'MobileBuild' (a farmer builds a building) or 'FactoryBuild' (a factory
-- builds a unit). The original Lua differentiates after that — FactoryUnit
-- (defaultunits.lua:504-513) switches to theirs for everything except 'Upgrade'
-- BuildingState and then rolls the finished unit off the yard.
--- A pawn's ACTIVE order — the one with the smallest number.
---
--- A farmer works on ONE order, not all at the same time. The engine
--- maintains a COMMAND QUEUE per unit (UNITCOMMAND_BuildMobile lands
--- in it, Shift is attached, without Shift it is emptied). Without this the ACU will build
--- three buildings in parallel - each at full construction rate, and the costs are phased out
--- the rudder. They don't exist in FA.
local function activeTask(builderId)
  local best, bestId = nil, nil
  for tid, task in pairs(__buildTasks) do
    if task.builder == builderId then
      if not bestId or tid < bestId then best, bestId = task, tid end
    end
  end
  return best, bestId
end

--- Does a farmer have an ongoing or pending construction contract? The unit mirror
--- reports "idle": in the original, the engine maintains idle sets on the UserArmy
--- (Cfile:1352334-1352374) from the task state — a pawn WITH task is
--- does not run empty, even when it is standing still.
function __builderBusy(builderId)
  for _, task in pairs(__buildTasks) do
    if task.builder == builderId then return true end
  end
  return false
end

--- Abort every build task of a builder — the graceful task-end path of the
--- engine (CUnitMobileBuildTask end, Cfile:815890-815915): the helper runs
--- ONLY the Lua OnStopBuild(target, order) on the builder
--- (OnStopBuild(helper, 1) -> Cfile:815022), and because the task did not
--- reach its success state the task additionally runs OnFailedToBuild on
--- the BUILDER (Cfile:815911 — harmless: callbacks/consumption/sound,
--- unit.lua:1716). OnFailedToBeBuilt (which DESTROYS the site,
--- unit.lua:1632) belongs to the destructor emergency path only
--- (OnStopBuild(helper, 0), Cfile:814888) and must NOT run here — the
--- site stays with its progress and decays (__decayTick).
function __abortBuildTasks(builderId)
  local b = __units[builderId]
  for tid, task in pairs(__buildTasks) do
    if task.builder == builderId then
      local t = __units[task.target]
      if task.started and b and not b.__dead then
        if t and not t.__dead then
          pcall(function() b:OnStopBuild(t, task.order) end)
        end
        pcall(function() b:OnFailedToBuild() end)
      end
      -- Only a site whose build NEVER began vanishes on abort: in the
      -- engine the structure does not exist before the task reached it —
      -- we spawn it at click time, so remove the placeholder to match. A
      -- started site (__engineBorn) stays, keeps its progress, and dies
      -- through the decay path (Unit::OnTick, Cfile:952824-952840).
      if t and not t.__engineBorn and (t.__fraction or 1) <= 0 then t:Destroy() end
      __econClearBuildRequest((b and b.__army) or 1, tid)
      __buildTasks[tid] = nil
    end
  end
  if b then b.UnitBeingBuilt = nil end
end

--- Site decay (Unit::OnTick, Cfile:952808-952840): every unit that is
--- still being built loses 0.1 / max(BuildCostEnergy, BuildCostMass,
--- BuildTime) of its build fraction PER TICK, starting 2 ticks after
--- creation — even while a builder works against it. Health follows the
--- fraction (Materialize); at health <= 0 the engine runs OnDecayed and
--- unit.lua:551 destroys the unit.
function __decayTick()
  for id, u in pairs(__units) do
    -- __engineBorn: our click-time placeholder does not exist in the engine
    -- until OnStartBuild ran (startTask) — only from then on it decays.
    if u.__beingBuilt and u.__engineBorn and not u.__dead and not u.__destroyQueued
      and (__gameTick - (u.__spawnTick or 0)) > 1 then
      local e = (u.__bp and u.__bp.Economy) or {}
      local maxVal = math.max(e.BuildCostEnergy or 0, e.BuildCostMass or 0, e.BuildTime or 0)
      if maxVal > 0 then
        local f = (u.__fraction or 0) - 0.1 / maxVal
        u.__fraction = f
        u.__health = u:GetMaxHealth() * f
        if u.__health <= 0 then
          local ok, err = pcall(function() u:OnDecayed() end)
          if not ok then WARN('OnDecayed: ' .. tostring(err)) end
        end
      end
    end
  end
end

--- Delete all orders of a pawn (no shift = new row). A new one
--- Order REPLACES the work — the current construction also breaks with the full one
--- Abbruch-Kette ab.
function __clearBuildQueue(builderId)
  __abortBuildTasks(builderId)
end

function __issueBuildTask(builderId, targetId, order, clear)
  local b = __units[builderId]
  local t = __units[targetId]
  if not b or not t then return -1 end
  order = order or 'MobileBuild'
  if clear then __clearBuildQueue(builderId) end

  local tid = __nextBuildTask
  __nextBuildTask = tid + 1
  __buildTasks[tid] = {
    builder = builderId, target = targetId, step = 0, blocked = false, order = order,
    started = false,
  }
  return tid
end

--- Start a job: walk there, ALIGN, call OnStartBuild.
--- Only happens when it is the order's turn (see __buildTick).
local function startTask(task, tid)
  local b = __units[task.builder]
  local t = __units[task.target]
  if not b or not t then return end
  task.started = true

  -- The engine sets UnitBeingBuilt BEFORE calling OnStartBuild:
  -- FactoryUnit.RollOffUnit (defaultunits.lua:570) reads exactly this field.
  b.UnitBeingBuilt = t
  pcall(function() b:OnStartBuild(t, task.order) end)
  pcall(function() t:OnStartBeingBuilt(b, task.order) end)
end

--- Per Beat: the pawn goes to his active order and TURNS TOWARDS IT.
---
--- `Economy.NeedToFaceTargetToBuild` (Blueprint) says that the pawn is the target
--- must be viewed - the ACU does this in the original visible before the construction beam
--- comes. Even without the flag, the engine aligns the pawn; his construction arm
--- hangs on a bone that points to the target.
local function approach(task)
  local b = __units[task.builder]
  local t = __units[task.target]
  if not b or not t or task.order == 'FactoryBuild' then return end

  local mbd = (b.__bp and b.__bp.Economy and b.__bp.Economy.MaxBuildDistance) or 0
  local bp = b.__pos or { 0, 0, 0 }
  local tp = t.__pos or { 0, 0, 0 }
  local dx = tp[1] - bp[1]
  local dz = tp[3] - bp[3]
  local dist = math.sqrt(dx * dx + dz * dz)

  if mbd > 0 and dist > mbd then
    -- Still too far away: run there (the movement makes motion.lua).
    b.__goal = { tp[1], tp[3] }
    b.__faceGoal = false
  elseif b.__goal and mbd > 0 and dist <= mbd then
    -- Arrived within reach: DELETE the destination. It pointed
    -- CENTER of the construction site — without this stop, motion.lua drove the farmer
    -- exactly there, and the ACU was in the middle of the building
    -- (Scene debug: ACU and factory in identical position).
    b.__goal = false
    b.__speed = 0
    b.__faceGoal = { tp[1], tp[3] }
  elseif not b.__goal and dist > 0.01 then
    -- Within reach: stand still and TURN towards the target.
    --
    -- Not with `b.__heading = atan2(...)`: that turned the unit in ZERO time.
    -- A unit rotates at its `Physics.TurnRate` (degrees/second) — exactly that
    -- Rate at which it also turns while driving. That's why she only gets here
    -- a ROTATE TARGET; It is processed in motion.lua, with the same
    -- Angular velocity like any other rotation.
    b.__faceGoal = { tp[1], tp[3] }
  end
end

-- === The construction queue of a factory ===
--
-- IssueBlueprintCommand("UNITCOMMAND_BuildFactory", id, count) puts in the engine
-- Entries in the factory queue. The factory processes them: one
-- Unit after unit, each as a normal construction site with the order
-- 'FactoryBuild'. The original Lua only sees OnStartBuild/OnStopBuild.
--
-- The entries have the form { id = <blueprintId>, count = <n> } — the same,
-- that the UI expects (construction.lua:1620).
function __queueFactoryBuild(factoryId, bpId, count)
  local f = __units[factoryId]
  if not f then return false end
  f.__buildQueue = f.__buildQueue or {}
  local q = f.__buildQueue
  local n = table.getn(q)
  -- Same blueprint as last? Then stack (the UI shows stack, none
  -- Einzelposten).
  if n > 0 and q[n].id == bpId then
    q[n].count = q[n].count + (count or 1)
  else
    q[n + 1] = { id = bpId, count = count or 1 }
  end
  return true
end

--- Change a queue entry by `delta` (1-based index) — the end of the sim
--- from Increase/DecreaseBuildCountInQueue (Moho::ISSUE_IncreaseCommandCount
--- Cfile:1257266 / DecreaseCommandCount Cfile:1257378). The counter falls on
--- 0 or below, the entry disappears.
function __adjustFactoryQueue(factoryId, index, delta)
  local f = __units[factoryId]
  if not f or not f.__buildQueue then return end
  local item = f.__buildQueue[index]
  if not item then return end
  item.count = item.count + delta
  if item.count <= 0 then table.remove(f.__buildQueue, index) end
end

-- Is there a construction contract currently underway on this unit?
local function isBuilding(id)
  for _, task in pairs(__buildTasks) do
    if task.builder == id then return true end
  end
  return false
end

-- Pro Beat BEFORE collecting: any factory with a queue and without a running one
-- Order sets up the next unit. The engine creates them at the factory
-- (Sim::CreateUnit, beingBuilt = 1) — the rest is the same build task as everywhere else.
function __factoryTick()
  for id, f in pairs(__units) do
    local q = f.__buildQueue
    if q and table.getn(q) > 0 and not f.__beingBuilt and not isBuilding(id) then
      local item = q[1]
      local p = f.__pos or { 0, 0, 0 }
      local scriptPath = '/units/' .. item.id .. '/' .. item.id .. '_script.lua'
      local uid, err = __spawnBuildSite(scriptPath, item.id, p[1], p[2], p[3], f.__army or 1)
      if uid < 0 then
        WARN('Fabrik ' .. tostring(id) .. ' kann ' .. tostring(item.id) .. ' don't build: ' .. tostring(err))
        table.remove(q, 1)
      else
        __issueBuildTask(id, uid, 'FactoryBuild')
        item.count = item.count - 1
        if item.count <= 0 then table.remove(q, 1) end
      end
    end
  end
end

-- Phase 1 (BEFORE the economic tick): Report target step + resource requirements.
--
-- ONLY THE ACTIVE order of each pawn works - the rest wait in the
-- Queue (shift construction). And the pawn runs to its goal or turns
-- to him before the first construction progress takes place.
function __buildCollect()
  -- First process the queue: trigger the active order for each farmer.
  local aktiv = {}
  for _, task in pairs(__buildTasks) do
    local a, atid = activeTask(task.builder)
    if a and atid then
      aktiv[atid] = true
      approach(a)
      if not a.started then startTask(a, atid) end
    end
  end

  for tid, task in pairs(__buildTasks) do
    local b = __units[task.builder]
    local t = __units[task.target]
    local army = (b and b.__army) or 1
    task.step = 0
    task.blocked = false
    if not aktiv[tid] then
      -- Still waiting in the queue: costs nothing, does nothing.
      task.blocked = true
      __econClearBuildRequest(army, tid)
    elseif b and t
      and ((t.__fraction or 1) < 1
        or (task.order == 'Repair' and (t.__health or 0) < t:GetMaxHealth())) then
      -- Reichweiten-Gate (Economy.MaxBuildDistance)
      local mbd = (b.__bp and b.__bp.Economy and b.__bp.Economy.MaxBuildDistance) or 0
      local bp = b.__pos or { 0, 0, 0 }
      local tp = t.__pos or { 0, 0, 0 }
      local dx = tp[1] - bp[1]
      local dz = tp[3] - bp[3]
      local dist = math.sqrt(dx * dx + dz * dz)
      if mbd > 0 and dist > mbd then
        task.blocked = true
        __econClearBuildRequest(army, tid)
      else
        -- HP repair of a FINISHED unit runs the same helper, but only
        -- health rises (Materialize -> AdjustHealth, Cfile:953468); the
        -- decay clock applies to construction sites only (Cfile:952808).
        local repairOnly = (t.__fraction or 1) >= 1
        -- The build REALLY begins: builder in range, progress will flow. In
        -- the engine the structure only comes into being here (the build
        -- task creates it on arrival) — our click-time spawn is a
        -- placeholder. The decay clock (Unit::OnTick, mCreationTick,
        -- Cfile:952821-952823) starts NOW; without this gate a fresh 0%
        -- site died of decay during the builder's approach.
        if not repairOnly and not t.__engineBorn then
          t.__engineBorn = true
          t.__spawnTick = __gameTick or 0
        end
        local bRate = (b.__bp and b.__bp.Economy and b.__bp.Economy.BuildRate) or 0
        local te = (t.__bp and t.__bp.Economy) or {}
        local bt = te.BuildTime or 1
        if bt < 1 then bt = 1 end
        -- delta = BuildRate / BuildTime per second (Cfile:815339+815342),
        -- clamped to what is left (fraction or health fraction).
        local step = (bRate / bt) * 0.1
        local rest
        if repairOnly then
          rest = 1 - (t.__health or 0) / t:GetMaxHealth()
        else
          rest = 1 - (t.__fraction or 0)
        end
        if step > rest then step = rest end
        task.step = step
        -- HP repair pays the FULL build cost rate in both resources
        -- (unit.lua:712-726: GetBuildCosts of the focus blueprint).
        __econSetBuildRequest(army, tid, (te.BuildCostMass or 0) * step, (te.BuildCostEnergy or 0) * step)
      end
    else
      __econClearBuildRequest(army, tid)
    end
  end
end

-- Phase 2 (AFTER the economy tick): apply the granted limiting rate.
function __buildApply()
  local done = {}
  local n = 0
  for tid, task in pairs(__buildTasks) do
    local b = __units[task.builder]
    local t = __units[task.target]
    local army = (b and b.__army) or 1
    if b and t and task.step > 0 and (t.__fraction or 1) >= 1 and task.order == 'Repair' then
      -- HP repair of a finished unit: Materialize only increases health
      -- (AdjustHealth, Cfile:953468); FractionComplete stays 1
      -- (Cfile:953455-953466) and OnStopBeingBuilt never re-fires
      -- (Cfile:953470-953476). Done when health == max (Cfile:815498):
      -- only the builder's OnStopBuild fires (unit.lua:1704).
      local rate = __econBuildRate(army, tid)
      local maxH = t:GetMaxHealth()
      local h = (t.__health or 0) + maxH * task.step * rate
      if h > maxH then h = maxH end
      t.__health = h
      if h >= maxH then
        b.UnitBeingBuilt = t
        pcall(function() b:OnStopBuild(t, task.order) end)
        n = n + 1
        done[n] = tid
      end
    elseif b and t and task.step > 0 then
      local rate = __econBuildRate(army, tid)
      local f = (t.__fraction or 0) + task.step * rate
      if f > 1 then f = 1 end
      t.__fraction = f
      t.__health = t:GetMaxHealth() * f
      if f >= 1 then
        -- With several builders on one site every task finishes here, but
        -- the TARGET gets OnStopBeingBuilt exactly once — the engine guards
        -- with the helper's mBeingBuilt flag (Cfile:815003). Every builder
        -- still gets its own OnStopBuild (its task ends).
        local wasBeingBuilt = t.__beingBuilt
        t.__beingBuilt = false
        __econSetComplete(army, task.target, true)
        -- Engine order: the unit is complete first, then the builder learns
        -- about it. FactoryUnit.OnStopBuild rolls the unit off the factory
        -- (defaultunits.lua:515-526) — it must already be alive for that.
        if wasBeingBuilt then
          pcall(function() t:OnStopBeingBuilt(b, task.order) end)
        end
        b.UnitBeingBuilt = t
        pcall(function() b:OnStopBuild(t, task.order) end)
        n = n + 1
        done[n] = tid
      end
    elseif not (task.blocked and b and t) then
      -- invalid or finished -> remove task; he remains out of reach
      n = n + 1
      done[n] = tid
    end
  end
  for i = 1, n do
    local tid = done[i]
    local task = __buildTasks[tid]
    local b = task and __units[task.builder]
    __econClearBuildRequest((b and b.__army) or 1, tid)
    __buildTasks[tid] = nil
  end
end

function __buildTaskCount()
  local n = 0
  for _ in pairs(__buildTasks) do n = n + 1 end
  return n
end
