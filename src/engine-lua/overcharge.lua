-- =====================================================================
-- The overcharge -- UNITCOMMAND_OverCharge is CUnitAttackTargetTask
-- (AiUnitAttack.cpp) pinned to the unit's OverChargeWeapon: DispatchTask
-- (Cfile:831092-831098, under the off-by-one case label) creates the attack
-- task with the overcharge flag for an entity target that is not allied;
-- the constructor (812610-812640) picks the first weapon whose blueprint
-- has OverChargeWeapon, keeps it as mWeapon and runs its OnEnableWeapon.
-- With a pinned weapon TaskTick (813121-813506) never asks the attacker for
-- a weapon (813216-813218): Waiting approaches the target -- Update
-- (812845-813013) sets the goal within the MaxRadius of the attacker's
-- target weapon, the first weapon that can attack the target
-- (GetTargetWeapon 791305-791320; SetWeaponGoal 812691-812720) --,
-- Processing renews the goal of a target that moved (813397-813410) and
-- sets the pinned weapon's target once it is within that weapon's attack
-- range (TargetIsWithinWeaponAttackRange 791447-791460: enabled,
-- CanAttackTarget, the range solution; then UnitWeapon::SetTarget 813431),
-- Complete waits for the script's CanWeaponFire (813474-813475),
-- re-approaches a mobile unit that moved (813477-813483) and fires the
-- weapon once it is enabled and UnitWeapon::CanFire holds (813485-813490:
-- UnitWeapon::Fire = RunScript "OnFire" and one more shot at the target,
-- 985600-985602), and the fifth state ends the task after the navigator's
-- abort (813493-813495, sub_5F3420). The destructor (813679-813725) runs
-- OnDisableWeapon on the pinned weapon and aborts the move. The Sim
-- binding is IssueOverCharge (cfunc_IssueOverChargeL 1008066-1008140,
-- globals.lua).
--
-- The energy is the script's: DefaultProjectileWeapon.StartEconomyDrain
-- (defaultweapons.lua:132-147) prices EnergyRequired over EnergyRequired /
-- EnergyDrainPerSecond seconds as an economy event and
-- RackSalvoFireReadyState waits for it with WeaponCanFire false
-- (487-494); the ACU's OverCharge weapon disables itself after the shot
-- and pauses through SetOverchargePaused (uel0001_script.lua:52-75).
--
-- Not modelled, recorded rather than faked (docs/STATUS.md): the
-- coordinating command of the attack task (the formation is none on this
-- path, 831097), the "too close" back-off (Starting, 813302-813360), the
-- attack angle facing (813498-813525), the Attacking unit state of the
-- task, the fit test of a renewed goal (func_UnitWontFitAt 813404). The
-- `mWeapon->v93` flag of the re-approach (813479) is not read: taken as
-- clear (UNVERIFIED).
--
-- STANDARD LUA 5.4 (goes raw into host.eval).
-- =====================================================================

__overchargeTasks = __overchargeTasks or {} -- unit id -> task

local function runScript(o, name, ...)
  local f = o and o[name]
  if type(f) ~= 'function' then return end
  local ok, err = pcall(f, o, ...)
  if not ok then WARN(name .. ': ' .. tostring(err)) end
end

local function gone(t) return t == nil or t.__destroyed == true or t.__dead == true or t.__destroyQueued == true end

-- The first weapon whose blueprint has OverChargeWeapon (812631-812639).
local function overchargeWeapon(u)
  for _, w in ipairs(u.__weapons or {}) do
    if not w.__destroyed and w.__bp and w.__bp.OverChargeWeapon then return w end
  end
  return nil
end

local function isMobile(u)
  local mt = u.__bp and u.__bp.Physics and u.__bp.Physics.MotionType
  return mt ~= nil and mt ~= 'RULEUMT_None'
end

-- CAiAttackerImpl::GetTargetWeapon (791305-791320): the first weapon that
-- can attack the target -- the approach (Update 812965-812970) goes by its
-- MaxRadius, not the pinned weapon's.
local function targetWeapon(u, t)
  if u.__beingBuilt then return nil end
  for _, w in ipairs(u.__weapons or {}) do
    if not w.__destroyed and __weaponCanTarget(w, u, t) then return w end
  end
  return nil
end

-- Update (812845-813013) with SetWeaponGoal (812691-812720): the goal
-- within the target weapon's MaxRadius of the target; the ground model
-- stops within it. Returns whether a goal was set.
local function approach(task, u, t)
  local w = targetWeapon(u, t) or task.weapon
  local p, q = u.__pos, t.__pos
  local dx, dz = q[1] - p[1], q[3] - p[3]
  local range = (w and (w.__maxRadius or (w.__bp and w.__bp.MaxRadius))) or 0
  task.goalPos = { q[1], q[3] }
  if math.sqrt(dx * dx + dz * dz) > range then
    u.__goal = { q[1], q[3] }
    u.__faceGoal = false
    task.moving = true
    return true
  end
  return false
end

--- The destructor (813679-813725): OnDisableWeapon on the pinned weapon
--- (813699-813701), the attacker stopped, the move aborted (813709-813713).
function __overchargeAbort(unitId)
  local task = __overchargeTasks[unitId]
  if not task then return end
  __overchargeTasks[unitId] = nil
  local u = __units[unitId]
  if task.weapon and not task.weapon.__destroyed then runScript(task.weapon, 'OnDisableWeapon') end
  if u and task.moving and u.__goal then
    u.__goal = false
    u.__speed = 0
  end
end

--- DispatchTask's UNITCOMMAND_OverCharge (831092-831098): an entity target
--- that is not allied gets the attack task with the overcharge flag; any
--- other target leaves the command without a task -- it completes at once
--- (`false` hands the queue on). The constructor (812610-812640): the
--- pinned weapon and its OnEnableWeapon.
function __overchargeStart(unitId, cmd)
  local u = __units[unitId]
  if not u then return false end
  __overchargeAbort(unitId)
  local t = __units[cmd.target]
  if not t or t.__destroyed then return false end
  if IsAlly(t.__army or 1, u.__army or 1) then return false end
  local w = overchargeWeapon(u)
  __overchargeTasks[unitId] = { unit = unitId, target = cmd.target, weapon = w, state = 'Preparing', moving = false }
  if w then runScript(w, 'OnEnableWeapon') end
  return true
end

local function finish(unitId)
  __overchargeAbort(unitId)
  return true
end

-- TargetIsWithinWeaponAttackRange (791447-791460): the unit not being
-- built, the weapon enabled, CanAttackTarget and the range solution.
local function withinWeaponRange(u, w, t)
  if u.__beingBuilt or not w or w.__enabled == false then return false end
  if not __weaponCanTarget(w, u, t) then return false end
  return __weaponTargetSolution(w, t.__pos)
end

--- TaskTick (813121-813506) for the pinned weapon; true ends the command.
function __overchargeOrderTick(unitId, cmd)
  local task = __overchargeTasks[unitId]
  local u = __units[unitId]
  if not task or not u then return true end
  local t = __units[task.target]
  local w = task.weapon
  -- No weapon to pin and no other way to attack (813263-813264): the task
  -- ends. A target that is gone ends it too (the attacker events; the
  -- port's attack orders do the same).
  if not w or w.__destroyed or gone(t) then return finish(unitId) end
  -- The pinned weapon aims like any other (the aim manipulators run for a
  -- manual-fire weapon too; the weapon tick skips it, weapons.lua).
  __weaponAimTick(w, u)
  local st = task.state
  if st == 'Preparing' then
    -- (813266-813275): no coordinating command here.
    task.state = 'Waiting'
    return false
  elseif st == 'Waiting' then
    -- (813277-813299): a mobile unit updates its goal (Update) and goes to
    -- Processing; an immobile one straight to Complete.
    if isMobile(u) then
      approach(task, u, t)
      task.state = 'Processing'
    else
      task.state = 'Complete'
    end
    task.lastPos = { u.__pos[1], u.__pos[3] }
    return false
  elseif st == 'Processing' then
    -- (813376-813436): not yet within the pinned weapon's attack range ->
    -- keep moving: the goal renewed when the navigator went idle
    -- (813391-813392) or, for a mobile target, when it left the goal by
    -- more than 10 (2 for a flyer; 813393-813410); within it -> the
    -- weapon takes the target (UnitWeapon::SetTarget 813431) and the task
    -- is Complete.
    if not withinWeaponRange(u, w, t) then
      if not u.__goal then
        approach(task, u, t)
      elseif isMobile(t) and task.goalPos then
        local gx, gz = task.goalPos[1], task.goalPos[2]
        local mx, mz = t.__pos[1] - gx, t.__pos[3] - gz
        local limit = (u.__bp and u.__bp.Air and u.__bp.Air.CanFly) and 2.0 or 10.0
        if math.sqrt(mx * mx + mz * mz) > limit then approach(task, u, t) end
      end
      task.lastPos = { u.__pos[1], u.__pos[3] }
      return false
    end
    if u.__goal then
      u.__goal = false
      u.__speed = 0
    end
    task.moving = false
    __weaponSetTarget(w, t, nil)
    task.state = 'Complete'
    task.lastPos = { u.__pos[1], u.__pos[3] }
    return false
  elseif st == 'Complete' then
    -- (813471-813490): the script's CanWeaponFire gates (813474-813475;
    -- the economy drain of the weapon FSM keeps it false,
    -- defaultweapons.lua:487-494); a mobile unit whose position changed
    -- since the last tick goes back to Processing through Update
    -- (813477-813483; the `mWeapon->v93` flag is taken as clear); an
    -- enabled weapon that can fire fires once: UnitWeapon::Fire =
    -- RunScript "OnFire" (985600) and one more shot at the target (985602).
    local canOk, can = pcall(w.CanWeaponFire, w)
    if canOk and can == false then
      task.lastPos = { u.__pos[1], u.__pos[3] }
      return false
    end
    local lp = task.lastPos
    local moved = lp ~= nil and (lp[1] ~= u.__pos[1] or lp[2] ~= u.__pos[3])
    task.lastPos = { u.__pos[1], u.__pos[3] }
    if moved and isMobile(u) then
      approach(task, u, t)
      task.state = 'Processing'
      return false
    end
    if w.__enabled ~= false and __weaponUnitCanFire(w) then
      runScript(w, 'OnFire')
      w.__shotsAtTarget = (w.__shotsAtTarget or 0) + 1
      task.state = 'Fired'
    end
    return false
  elseif st == 'Fired' then
    -- (813493-813495): the navigator's abort, the task ends (-1).
    if u.__goal then
      u.__goal = false
      u.__speed = 0
    end
    return finish(unitId)
  end
  return true
end
