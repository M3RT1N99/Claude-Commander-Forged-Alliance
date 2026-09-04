__buildTasks = {}
__nextBuildTask = 1

-- Bau-Auftrag erteilen: Bauer baut die Baustelle. Ausser Reichweite laeuft er
-- erst hin (Approach ueber den Navigator).
--
-- `order` ist der Auftragsstring, den die Engine an OnStartBuild reicht:
-- 'MobileBuild' (ein Bauer setzt ein Gebaeude) oder 'FactoryBuild' (eine Fabrik
-- baut eine Einheit). Die Original-Lua unterscheidet danach — FactoryUnit
-- (defaultunits.lua:504-513) wechselt bei allem ausser 'Upgrade' in ihren
-- BuildingState und rollt die fertige Einheit anschliessend vom Hof.
--- Der AKTIVE Auftrag eines Bauers — der mit der kleinsten Nummer.
---
--- Ein Bauer arbeitet an EINEM Auftrag, nicht an allen gleichzeitig. Die Engine
--- fuehrt pro Unit eine BEFEHLS-WARTESCHLANGE (UNITCOMMAND_BuildMobile landet
--- darin, Shift haengt an, ohne Shift wird sie geleert). Ohne das baut die ACU
--- drei Gebaeude parallel — jedes mit voller Baurate, und die Kosten laufen aus
--- dem Ruder. Es gibt sie in FA nicht.
local function activeTask(builderId)
  local best, bestId = nil, nil
  for tid, task in pairs(__buildTasks) do
    if task.builder == builderId then
      if not bestId or tid < bestId then best, bestId = task, tid end
    end
  end
  return best, bestId
end

--- Hat ein Bauer einen laufenden oder wartenden Bau-Auftrag? Der Unit-Spiegel
--- meldet daraus „idle": im Original pflegt die Engine Idle-Sets am UserArmy
--- (Cfile:1352334-1352374) aus dem Task-Zustand — ein Bauer MIT Auftrag ist
--- nicht leerlaufend, auch wenn er gerade stillsteht.
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
    if task.builder == builderId and task.order == 'FactoryBuild' then
      -- A factory's command is removed with its queue (ClearCommandQueue on
      -- Stop / IssueClearCommands): the running CFactoryBuildTask goes the
      -- destructor way, not the graceful one.
      __abortFactoryBuild(tid, task)
    elseif task.builder == builderId then
      local t = __units[task.target]
      if task.started and b and not b.__dead then
        if t and not t.__dead then
          local ok, err = pcall(function() b:OnStopBuild(t, task.order) end)
          if not ok then WARN('OnStopBuild: ' .. tostring(err)) end
        end
        if b.__focusEntity == t then b.__focusEntity = nil end
        local okF, errF = pcall(function() b:OnFailedToBuild() end)
        if not okF then WARN('OnFailedToBuild: ' .. tostring(errF)) end
      end
      -- Only a site whose build NEVER began vanishes on abort: in the
      -- engine the structure does not exist before the task reached it —
      -- we spawn it at click time, so remove the placeholder to match. A
      -- begun site (__engineBorn) stays, keeps its progress, and dies
      -- through the decay path (Unit::OnTick, Cfile:952824-952840).
      if t and not t.__engineBorn and (t.__fraction or 1) <= 0 then t:Destroy() end
      if b then b.__workProgress = 0 end
      __buildTasks[tid] = nil
    end
  end
  if b then b.UnitBeingBuilt = nil end
end

--- The CFactoryBuildTask destructor (Cfile:818337-818390), reached when the
--- task's command leaves the queue (the head decreased to 0, Stop,
--- IssueClearCommands) or the dispatcher interrupts: mWorkProgress = 0
--- (818358) and, because the task is not complete, CBuildTaskHelper::
--- OnStopBuild(helper, 0) (818367): with the helper still building and the
--- factory alive it runs OnFailedToBuild on the FACTORY (815007 --
--- defaultunits.lua:560 sets FactoryBuildFailed and goes idle),
--- OnFailedToBeBuilt on the SITE (815018 -- unit.lua:1632: Destroy) and the
--- Lua OnStopBuild(site, order) (815022 -- FactoryUnit.OnStopBuild skips the
--- roll-off on FactoryBuildFailed, defaultunits.lua:518), then drops the
--- focus (815027-815055). No refund: the engine has none. The next factory
--- tick starts the new head (746591-746594).
function __abortFactoryBuild(tid, task)
  local b = __units[task.builder]
  local t = __units[task.target]
  if b then b.__workProgress = 0 end
  if task.started and b and not b.__dead then
    local okF, errF = pcall(function() b:OnFailedToBuild() end)
    if not okF then WARN('OnFailedToBuild: ' .. tostring(errF)) end
    if t and not t.__dead then
      local okS, errS = pcall(function() t:OnFailedToBeBuilt() end)
      if not okS then WARN('OnFailedToBeBuilt: ' .. tostring(errS)) end
    end
    if t then
      local ok, err = pcall(function() b:OnStopBuild(t, task.order) end)
      if not ok then WARN('OnStopBuild: ' .. tostring(err)) end
    end
    if b.__focusEntity == t then b.__focusEntity = nil end
  elseif t and not t.__engineBorn and (t.__fraction or 1) <= 0 then
    -- The site placeholder of a task that never started (spawned at the
    -- factory this beat): nothing existed yet in the engine.
    t:Destroy()
  end
  __buildTasks[tid] = nil
  if b then b.UnitBeingBuilt = nil end
end

--- Regeneration (Unit::OnTick, Cfile:952810-952817) — der ANDERE Zweig
--- derselben Anweisung, deren `else` unten den Bauplatz zerfallen laesst. Hier
--- stand bisher nur der `else`-Teil, obwohl der Kommentar den ganzen Bereich
--- zitierte:
---
---     if (!mIsBeingBuilt) {
---       if (maxHealth > health && GetAttributes1()->mRegenRate > 0.0)
---         AdjustHealth(this, this, mRegenRate * 0.1);
---     } else if (curTick - creationTick > 1) { … Zerfall … }
---
--- `RegenRate` ist also ein Wert PRO SEKUNDE, verteilt auf zehn Ticks. Er kommt
--- aus `Defense.RegenRate` des Blueprints und wird zur Laufzeit von
--- `SetRegenRate`/`RevertRegenRate` veraendert (Veteranenstufen, Buffs).
---
--- Der Weg ist `AdjustHealth`, nicht ein roher Schreibzugriff: das haelt die
--- 25%-Quantisierung von `OnHealthChanged` und den Toten-Waechter ein.
function __regenTick()
  for _, u in pairs(__units) do
    if not u.__beingBuilt and not u.__dead and not u.__destroyQueued then
      local rate = u.__regenRate or 0
      if rate > 0 then
        local max = u:GetMaxHealth()
        if max > (u.__health or 0) then
          u:SetHealth(u, (u.__health or 0) + rate * 0.1)
        end
      end
    end
  end
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
    -- Decay only when the site has NOT been materialized in the last tick: the
    -- engine resets mCreationTick on every Materialize (Cfile:953443), so an
    -- attended/stalled-but-attended site keeps its clock fresh. Fall back to the
    -- creation tick before the first materialize.
    if u.__beingBuilt and u.__engineBorn and not u.__dead and not u.__destroyQueued
      and (__gameTick - (u.__lastMaterializedTick or u.__spawnTick or 0)) > 1 then
      local e = (u.__bp and u.__bp.Economy) or {}
      local maxVal = math.max(e.BuildCostEnergy or 0, e.BuildCostMass or 0, e.BuildTime or 0)
      if maxVal > 0 then
        -- Materialize(-0.1 / mBuildTime) (Cfile:952836). For a NEGATIVE delta the
        -- fraction is clamped into [0,1] (Cfile:953450-953456) and health is
        -- ADJUSTED by maxHealth * delta (Cfile:953468) — never assigned, or the
        -- damage a site took would be undone every tick.
        local delta = -0.1 / maxVal
        local f = (u.__fraction or 0) + delta
        if f > 1 then f = 1 end
        if f < 0 then f = 0 end
        u.__fraction = f
        u:AdjustHealth(nil, u:GetMaxHealth() * delta)
        if (u.__health or 0) <= 0 then
          local ok, err = pcall(function() u:OnDecayed() end)
          if not ok then WARN('OnDecayed: ' .. tostring(err)) end
        end
      end
    end
  end
end

--- Alle Auftraege eines Bauers loeschen (kein Shift = neue Reihe). Ein neuer
--- Befehl ERSETZT die Arbeit — auch der laufende Bau bricht mit der vollen
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
  -- Some callers create the placeholder before the builder is known. Bind the
  -- site's one target callback at its first builder association, never once
  -- per helper task (Cfile:950553-950593).
  if t.__beingBuilt and not t.__startBeingBuilt then
    __startBuildSite(targetId, builderId, order)
  end

  local tid = __nextBuildTask
  __nextBuildTask = tid + 1
  __buildTasks[tid] = {
    builder = builderId, target = targetId, step = 0, blocked = false, order = order,
    started = false,
  }
  return tid
end

--- Einen Auftrag anfangen: hinlaufen, sich AUSRICHTEN, OnStartBuild rufen.
--- Passiert erst, wenn der Auftrag an der Reihe ist (siehe __buildTick).
local function startTask(task, tid)
  local b = __units[task.builder]
  local t = __units[task.target]
  if not b or not t then return end
  task.started = true

  -- Die Engine setzt UnitBeingBuilt, BEVOR sie OnStartBuild ruft:
  -- FactoryUnit.RollOffUnit (defaultunits.lua:570) liest genau dieses Feld.
  b.UnitBeingBuilt = t
  -- CBuildTaskHelper::SetFocus (Cfile:815090-815102): the target becomes the
  -- builder's focus entity, the script hears OnAssignedFocusEntity, and only
  -- then OnStartBuild. GetFocusUnit answers from that field (unit.lua:698).
  b.__focusEntity = t
  if b.OnAssignedFocusEntity then
    local okF, errF = pcall(function() b:OnAssignedFocusEntity() end)
    if not okF then WARN('OnAssignedFocusEntity: ' .. tostring(errF)) end
  end
  local ok, err = pcall(function() b:OnStartBuild(t, task.order) end)
  if not ok then WARN('OnStartBuild: ' .. tostring(err)) end
end

--- CBuildTaskHelper::OnStopBuild ends with the builder's focus entity
--- unlinked (Cfile:815022-815030): after OnStopBuild there is no focus.
local function clearFocus(b, t)
  if b and b.__focusEntity == t then b.__focusEntity = nil end
end

--- Pro Beat: der Bauer geht zu seinem aktiven Auftrag und DREHT SICH ZU IHM.
---
--- `Economy.NeedToFaceTargetToBuild` (Blueprint) sagt, dass der Bauer das Ziel
--- ansehen muss — die ACU tut das im Original sichtbar, bevor der Bau-Strahl
--- kommt. Auch ohne das Flag richtet die Engine den Bauer aus; sein Bau-Arm
--- haengt an einem Knochen, der auf das Ziel zeigt.
local function approach(task)
  local b = __units[task.builder]
  local t = __units[task.target]
  -- Neither a factory build nor an upgrade has an approach: the site sits ON
  -- the builder (CUnitUpgradeTask skips the navigator branch for immobile
  -- units entirely, Cfile:817246-817259).
  if not b or not t or task.order == 'FactoryBuild' or task.order == 'Upgrade' then return end

  local mbd = (b.__bp and b.__bp.Economy and b.__bp.Economy.MaxBuildDistance) or 0
  local bp = b.__pos or { 0, 0, 0 }
  local tp = t.__pos or { 0, 0, 0 }
  local dx = tp[1] - bp[1]
  local dz = tp[3] - bp[3]
  local dist = math.sqrt(dx * dx + dz * dz)

  if mbd > 0 and dist > mbd then
    -- Noch zu weit weg: hinlaufen (die Bewegung macht motion.lua).
    b.__goal = { tp[1], tp[3] }
    b.__faceGoal = false
  elseif b.__goal and mbd > 0 and dist <= mbd then
    -- IN Reichweite angekommen: das Fahrziel LOESCHEN. Es zeigte aufs
    -- ZENTRUM der Baustelle — ohne diesen Stopp fuhr motion.lua den Bauer
    -- exakt dorthin weiter, und die ACU stand mitten IM Gebaeude
    -- (Szene-Debug: ACU und Fabrik auf identischer Position).
    b.__goal = false
    b.__speed = 0
    b.__faceGoal = { tp[1], tp[3] }
  elseif not b.__goal and dist > 0.01 then
    -- In Reichweite: stehen bleiben und sich zum Ziel DREHEN.
    --
    -- Nicht mit `b.__heading = atan2(...)`: das drehte die Unit in NULL Zeit.
    -- Eine Einheit dreht mit ihrer `Physics.TurnRate` (Grad/Sekunde) — genau die
    -- Rate, mit der sie auch beim Fahren einlenkt. Deshalb bekommt sie hier nur
    -- ein DREH-ZIEL; abgearbeitet wird es in motion.lua, mit derselben
    -- Winkelgeschwindigkeit wie jede andere Drehung.
    b.__faceGoal = { tp[1], tp[3] }
  end
end

-- Is the builder close enough to actually start the build? A factory build and
-- an upgrade sit ON the builder (no approach). For a MobileBuild the engine
-- emits OnStartBuild only from CBuildTaskHelper::SetFocus, reached in
-- TASKSTATE_Processing AFTER navigation completes and the builder is within
-- MaxBuildDistance (Cfile:816481-816487 returns while still too far) — never
-- during the walk.
local function inBuildRange(task)
  local b = __units[task.builder]
  local t = __units[task.target]
  if not b or not t then return false end
  if task.order == 'FactoryBuild' or task.order == 'Upgrade' then return true end
  local mbd = (b.__bp and b.__bp.Economy and b.__bp.Economy.MaxBuildDistance) or 0
  if mbd <= 0 then return true end
  local bp = b.__pos or { 0, 0, 0 }
  local tp = t.__pos or { 0, 0, 0 }
  local dx = tp[1] - bp[1]
  local dz = tp[3] - bp[3]
  return math.sqrt(dx * dx + dz * dz) <= mbd
end

-- === Die Bau-Warteschlange einer Fabrik ===
--
-- IssueBlueprintCommand("UNITCOMMAND_BuildFactory", id, count) legt in der Engine
-- Eintraege in die Warteschlange der Fabrik. Die Fabrik arbeitet sie ab: eine
-- Einheit nach der anderen, jede als ganz normale Baustelle mit dem Auftrag
-- 'FactoryBuild'. Die Original-Lua sieht davon nur OnStartBuild/OnStopBuild.
--
-- Die Eintraege haben die Form { id = <blueprintId>, count = <n> } — dieselbe,
-- die die UI erwartet (construction.lua:1620).
-- Category FACTORY test (bp.Categories carries 'FACTORY'), mirrors the local
-- isFactory in globals.lua:1541.
local function isFactoryUnit(u)
  local bp = u and u.__bp
  for _, category in ipairs((bp and bp.Categories) or {}) do
    if category == 'FACTORY' then return true end
  end
  return false
end

function __queueFactoryBuild(factoryId, bpId, count)
  local f = __units[factoryId]
  if not f then return false end
  -- The engine issues the BuildFactory queue command ONLY to selected units in
  -- category FACTORY (cfunc_IssueBlueprintCommandL: IsInCategory('FACTORY'),
  -- Cfile:1265854-1265856; non-factory units are skipped). Without this gate a
  -- non-factory unit that somehow receives the command would get a phantom
  -- __buildQueue and __factoryTick would produce units at its own position.
  if not isFactoryUnit(f) then return false end
  f.__buildQueue = f.__buildQueue or {}
  local q = f.__buildQueue
  -- ONE UNITCOMMAND_BuildFactory command per unit: the binding loops
  -- ISSUE_Command `count` times (Cfile:1265867-1265872), every command with
  -- its own count of 1. The stacks the construction panel shows are the
  -- user side's merge of consecutive same-blueprint commands (sub_835DF0,
  -- Cfile:1256786-1256813) -- see __factoryQueueDisplay.
  for _ = 1, (count or 1) do
    q[table.getn(q) + 1] = { id = bpId, count = 1 }
  end
  return true
end

--- The queue as the construction panel sees it (sCurrentBuildQueue,
--- sub_835DF0, Cfile:1256786-1256813): walked front to back, every
--- BuildFactory command whose blueprint equals the previous item's is merged
--- into that item -- the count accumulated, the command kept in the item's
--- list. Returns { { id, count, cmds = { command, ... } }, ... }.
function __factoryQueueGroups(q)
  local groups = {}
  for _, cmd in ipairs(q or {}) do
    local last = groups[table.getn(groups)]
    if last and last.id == cmd.id then
      last.count = last.count + (cmd.count or 1)
      last.cmds[table.getn(last.cmds) + 1] = cmd
    else
      groups[table.getn(groups) + 1] = { id = cmd.id, count = cmd.count or 1, cmds = { cmd } }
    end
  end
  return groups
end

--- The merged stacks ({ id, count }) for the unit row (construction.lua
--- reads them as the factory's queue display).
function __factoryQueueDisplay(u)
  local out = {}
  for i, g in ipairs(__factoryQueueGroups(u.__buildQueue)) do
    out[i] = { id = g.id, count = g.count }
  end
  return out
end

--- The running FactoryBuild task of a factory, if any.
local function runningFactoryTask(factoryId)
  for tid, task in pairs(__buildTasks) do
    if task.builder == factoryId and task.order == 'FactoryBuild' then return tid, task end
  end
  return nil
end

--- A queue entry edited from the construction panel (1-based index into the
--- MERGED display, construction.lua:895/988-990).
---
--- Decrease (cfunc_DecreaseBuildCountInQueueL, Cfile:1257301-1257395): the
--- binding walks the item's commands from the NEWEST backwards and sends
--- Sim::DecreaseCommandCount for each until the requested count is used up
--- (1257350-1257390). CUnitCommand::DecreaseCount (1007719-1007775) clamps
--- at 0 and, at 0, removes the command from the unit's queue
--- (RemoveCommandFromQueue, 1005104-1005155). Removing the HEAD broadcasts
--- UCQS_NeedsRefresh (1005110-1005117), which the dispatcher answers by
--- interrupting its running task (IAiCommandDispatchImpl::OnEvent
--- 746664-746706, TaskInterruptSubtasks 438613-438636) -- the
--- CFactoryBuildTask destructor path below; the next TaskTick dispatches
--- the new head (746591-746594).
---
--- Increase (cfunc_IncreaseBuildCountInQueueL, 1257188-1257270 ->
--- ISSUE_IncreaseCommandCount 1351002-1351150): one FRESH BuildFactory
--- command per requested unit through ISSUE_Command (1351091-1351112),
--- appended at the back of the queue -- no count is bumped.
function __adjustFactoryQueue(factoryId, index, delta)
  local f = __units[factoryId]
  if not f or not f.__buildQueue then return end
  local q = f.__buildQueue
  local group = __factoryQueueGroups(q)[index]
  if not group then return end
  if delta > 0 then
    for _ = 1, delta do
      q[table.getn(q) + 1] = { id = group.id, count = 1 }
    end
    return
  end
  local remaining = -delta
  local tid, task = runningFactoryTask(factoryId)
  for i = table.getn(group.cmds), 1, -1 do
    if remaining <= 0 then break end
    local cmd = group.cmds[i]
    local take = math.min(remaining, cmd.count or 1)
    cmd.count = (cmd.count or 1) - take
    remaining = remaining - take
    if cmd.count <= 0 then
      for k = table.getn(q), 1, -1 do
        if q[k] == cmd then table.remove(q, k); break end
      end
      if task and task.__factoryItem == cmd then
        __abortFactoryBuild(tid, task)
        task = nil
      end
    end
  end
end

-- === Structure upgrade (Moho::CUnitUpgradeTask, Cfile:816981/817198) ===
--
-- An upgrade is NOT a special path: the engine creates the same
-- CBuildTaskHelper as for any other build, only with the helper name "Upgrade"
-- (ctor Cfile:816992) — and that name IS the `order` string OnStartBuild and
-- OnStopBuild receive in Lua (defaultunits.lua:223 switches into the
-- UpgradingState on exactly that).
--
-- TaskTick (Cfile:817276-817300) creates the successor with
-- SUnitConstructionParams(layer, GetPosition(), army, targetBlueprint, builder)
-- — at the position, in the layer and in the army of the old building, with the
-- old building as its builder. Then:
--   * old building:  mUnitStates |= 0x40  -> UNITSTATE_Upgrading (6)
--                    (ctor Cfile:817000), mWorkProgress = 0
--   * new building:  mUnitStates |= 0x20 (HIDWORD) -> UNITSTATE_BeingUpgraded
--                    (37, Cfile:817320)
--   * SetFocusEntity: the successor is the old building's focus entity
--                     (Cfile:817310; the destructor clears it again)
-- IsUnitState derives both states from the tasks (moho.lua), so they hold for
-- exactly as long as the task lives.
function __issueUpgrade(unitId, bpId)
  local u = __units[unitId]
  if not u then return -1, 'unknown unit ' .. tostring(unitId) end
  if u.__dead or u.__destroyQueued then return -1, 'unit is dead' end
  -- A second upgrade command on the same building fizzles out — not an error:
  -- UNIT_IssueCommand only appends it to the queue (clear = 0, Cfile:1011353),
  -- and it becomes a task only once it reaches the head of that queue. By then
  -- the building has destroyed itself (defaultunits.lua:267).
  -- Return -2 = "nothing to do" (as opposed to -1 = error).
  for _, task in pairs(__buildTasks) do
    if task.builder == unitId and task.order == 'Upgrade' then return -2, 'already upgrading' end
  end
  local target = bpId
  if not target or target == '' then
    target = u.__bp and u.__bp.General and u.__bp.General.UpgradesTo
  end
  if not target or target == '' then
    return -1, tostring(u.__bp and u.__bp.BlueprintId) .. ' has no General.UpgradesTo'
  end
  if __isBuildRestricted(u, target) then return -1, target .. ' is build-restricted' end
  local p = u.__pos or { 0, 0, 0 }
  local scriptPath = '/units/' .. target .. '/' .. target .. '_script.lua'
  local uid, err = __spawnBuildSite(scriptPath, target, p[1], p[2], p[3], u.__army or 1, unitId, 'Upgrade')
  if uid < 0 then return uid, err end
  local t = __units[uid]
  -- Same heading as its predecessor — the successor stands exactly where the
  -- old building stood (SUnitConstructionParams takes the builder's transform).
  t.__heading = u.__heading or 0
  -- Cfile:817310: the successor becomes the old building's focus entity, so
  -- Unit:GetFocusUnit() answers "what am I working on" during the upgrade.
  u:SetFocusEntity(t)
  __issueBuildTask(unitId, uid, 'Upgrade')
  return uid, ''
end

-- Laeuft an dieser Unit gerade ein Bau-Auftrag?
local function isBuilding(id)
  for _, task in pairs(__buildTasks) do
    if task.builder == id then return true end
  end
  return false
end

-- Pro Beat VOR dem Sammeln: jede Fabrik mit Warteschlange und ohne laufenden
-- Auftrag setzt die naechste Einheit auf. Die Engine erzeugt sie an der Fabrik
-- (Sim::CreateUnit, beingBuilt = 1) — der Rest ist derselbe Bau-Task wie ueberall.
function __factoryTick()
  for id, f in pairs(__units) do
    -- CAiBuilderImpl::OnTick housekeeping of the factory command list
    -- (Cfile:751344-751458): dead transport targets out, an empty list gets
    -- the blueprint's initial rally point back.
    if not f.__dead and not f.__destroyQueued then __factoryCommandTick(f) end
    local q = f.__buildQueue
    -- A paused factory (SetPaused) starts no new unit from its queue
    -- (cfunc_SetPausedL: mIsPaused halts production).
    -- SetBusy / SetBlockCommandQueue (defaultunits.lua:529/639, FinishBuildThread
    -- and RolloffBody): while the finished unit is still leaving the build pad
    -- the factory is busy and its queue is blocked — the next unit must NOT
    -- start on top of the one rolling off.
    -- !IsDead is the second of the four conditions in the engine's dispatch gate
    -- (IAiCommandDispatchImpl::TaskTick, Cfile:746583-746586: !IsBeingBuilt &&
    -- !IsDead && !Attached && !BlockCommandQueue). Without it a killed factory
    -- keeps starting queued units throughout its multi-beat DeathThread
    -- (unit.lua:1200-1241), while the original destroys what it was building
    -- (defaultunits.lua:683-688, unit.lua:1259-1263).
    if q and table.getn(q) > 0 and not f.__beingBuilt and not isBuilding(id) and not f.__paused
      and not f.__busy and not f.__blockCommandQueue
      and not f.__dead and not f.__destroyQueued then
      local item = q[1]
      if __isBuildRestricted(f, item.id) then
        -- A build-restricted unit is never produced (Unit::CanBuild, the army
        -- deny-list from AddBuildRestriction). Drop it rather than spawn it.
        WARN('Factory ' .. tostring(id) .. ': ' .. tostring(item.id) .. ' is build-restricted')
        table.remove(q, 1)
      else
        local p = f.__pos or { 0, 0, 0 }
        local scriptPath = '/units/' .. item.id .. '/' .. item.id .. '_script.lua'
        local uid, err = __spawnBuildSite(
          scriptPath, item.id, p[1], p[2], p[3], f.__army or 1, id, 'FactoryBuild'
        )
        if uid < 0 then
          WARN('Fabrik ' .. tostring(id) .. ' kann ' .. tostring(item.id) .. ' nicht bauen: ' .. tostring(err))
          table.remove(q, 1)
        else
          -- A factory-built unit inherits the factory's fire state (the engine
          -- copies SetFireState(child, factory.mFireState) at creation), so a
          -- factory set to HoldFire produces HoldFire units, not ReturnFire.
          local child = __units[uid]
          if child then child.__fireState = f.__fireState or 0 end
          local ftid = __issueBuildTask(id, uid, 'FactoryBuild')
          -- Bind the task to the exact queue item it was built from (the engine
          -- decrements the task's OWN command, DecreaseCount(1, v18), Cfile:838029
          -- — not a positional head). If the queue is edited mid-build
          -- (__adjustFactoryQueue shifts q[1] away), completion must still drain
          -- THIS item, resolved by identity.
          if ftid and ftid >= 0 and __buildTasks[ftid] then
            __buildTasks[ftid].__factoryItem = item
          end
          -- Do NOT decrement the queue count here. The engine decrements the
          -- BuildFactory command count only on COMPLETION (Cfile:838029: if
          -- count <= 1 RemoveCommandFromQueue, else DecreaseCount(1); only THEN
          -- does the next CFactoryBuildTask start at Cfile:838062), so the
          -- in-progress unit stays counted and the displayed queue shows the true
          -- remaining count. The `not isBuilding(id)` gate above already stops a
          -- re-spawn of this same head while the task runs; the decrement happens
          -- in the FactoryBuild completion path (__buildApply).
        end
      end
    end
  end
end

-- Phase 1 (VOR dem Oekonomie-Tick): Sollschritt + Ressourcen-Bedarf anmelden.
--
-- NUR DER AKTIVE Auftrag jedes Bauers arbeitet — die uebrigen warten in der
-- Warteschlange (Shift-Bau). Und der Bauer laeuft zu seinem Ziel bzw. dreht sich
-- zu ihm, bevor der erste Baufortschritt entsteht.
function __buildCollect()
  -- Erst die Warteschlange abarbeiten: je Bauer den aktiven Auftrag anstossen.
  local aktiv = {}
  for _, task in pairs(__buildTasks) do
    local a, atid = activeTask(task.builder)
    if a and atid then
      aktiv[atid] = true
      approach(a)
      -- OnStartBuild fires on ARRIVAL, not during the walk: SetFocus (and thus
      -- RunScript_OnStartBuild, Cfile:815102) is reached only once the builder
      -- is within MaxBuildDistance. FactoryBuild/Upgrade sit on the builder.
      if not a.started and inBuildRange(a) then startTask(a, atid) end
    end
  end

  for tid, task in pairs(__buildTasks) do
    local b = __units[task.builder]
    local t = __units[task.target]
    local army = (b and b.__army) or 1
    task.step = 0
    task.blocked = false
    if not aktiv[tid] or (b and (b.__paused == true or b.__dead or b.__destroyQueued)) then
      -- Still waiting in the queue, the builder is paused (SetPaused,
      -- cfunc_SetPausedL), or the builder is DEAD and running its DeathThread —
      -- same dispatch gate as the factory above (!IsDead, Cfile:746584). Costs
      -- nothing, does nothing; the task itself is dropped once the unit leaves
      -- __units.
      task.blocked = true
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
        -- Attended this tick (builder in range): the engine resets the decay
        -- clock on EVERY Materialize, including the delta==0 econ-stall path
        -- (Cfile:953443-953444 runs before the `a2 != 0` body), so an attended
        -- site — even a stalled one — never decays. This runs before the econ
        -- tick, so it covers a build that will get rate 0 this beat too.
        if not repairOnly then t.__lastMaterializedTick = __gameTick or 0 end
        -- The task reads UnitAttributes::mBuildRate, which SetBuildRate mutates;
        -- it is not permanently tied to the blueprint value.
        local bRate = b:GetBuildRate()
        local te = (t.__bp and t.__bp.Economy) or {}
        local bt = te.BuildTime or 1
        -- The engine divides by BuildTime unclamped (Cfile:815339); the Lua
        -- consumption model floors it at 0.1 (game.lua:38). Use 0.1, not 1 —
        -- the old floor of 1 ran a BuildTime in (0.1,1) up to ~10x too slow.
        if bt < 0.1 then bt = 0.1 end
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
        -- The COST is not registered here. The engine has no build request of
        -- its own: the builder's consumption request IS the build's demand.
        -- unit.lua:697-745 (UpdateConsumptionValues) reads GetFocusUnit(),
        -- prices the focus blueprint through GetBuildCosts and sets the rate
        -- with SetConsumptionPerSecondEnergy/Mass; Unit::HandleResourceManagement
        -- takes `perSecond x LimitingRate` from the army and stores that
        -- LimitingRate as mResourceConsumed (Cfile:953945-953965), which
        -- UpdateWorkProgress then multiplies into the delta. While GetFocusUnit
        -- was a no-op the Lua could not price anything and a TS-side request
        -- stood in for it; with both alive every build was charged twice.
      end
    end
  end
end

-- Phase 2 (NACH dem Oekonomie-Tick): gewaehrte LimitingRate anwenden.
function __buildApply()
  local done = {}
  local n = 0
  for tid, task in pairs(__buildTasks) do
    local b = __units[task.builder]
    local t = __units[task.target]
    local army = (b and b.__army) or 1
    if b and t and task.step > 0 and (t.__fraction or 1) >= 1 and task.order == 'Repair' then
      -- HP repair of a finished unit: Materialize only raises health
      -- (AdjustHealth, Cfile:953468); FractionComplete stays 1
      -- (Cfile:953455-953466) and OnStopBeingBuilt never re-fires
      -- (Cfile:953470-953476). Done when health == max (Cfile:815498):
      -- only the builder's OnStopBuild fires (unit.lua:1704).
      local rate = b:GetResourceConsumed() -- mResourceConsumed of the BUILDER (Cfile:953945-953948), see __buildCollect
      local maxH = t:GetMaxHealth()
      local h = (t.__health or 0) + maxH * task.step * rate
      if h > maxH then h = maxH end
      t.__health = h
      -- HP repair: the builder's WorkProgress is the target's health ratio
      -- (Cfile:815496).
      b.__workProgress = maxH > 0 and (h / maxH) or 0
      if h >= maxH then
        b.UnitBeingBuilt = t
        local okS, errS = pcall(function() b:OnStopBuild(t, task.order) end)
        if not okS then WARN('OnStopBuild: ' .. tostring(errS)) end
        clearFocus(b, t)
        n = n + 1
        done[n] = tid
      end
    elseif b and t and task.step > 0 then
      local rate = b:GetResourceConsumed() -- mResourceConsumed of the BUILDER (Cfile:953945-953948), see __buildCollect
      local oldFrac = t.__fraction or 0
      local maxH = t:GetMaxHealth()
      local delta = task.step * rate
      local f = oldFrac + delta
      if f > 1 then f = 1 end
      if f < 0 then f = 0 end
      -- Moho::Unit::Materialize, positive-delta branch (Cfile:953458-953466):
      -- the fraction is raised to health/maxHealth when that is higher — the
      -- fraction FOLLOWS the health, never the other way round. Health is read
      -- BEFORE this tick's adjustment.
      if delta > 0 and maxH > 0 then
        local hr = (t.__health or 0) / maxH
        if hr > f then f = hr end
      end
      t.__fraction = f
      -- Cfile:953468: AdjustHealth(0, maxHealth * delta) — ADJUSTED by the
      -- delta, not assigned to maxHealth * fraction. Assigning healed away any
      -- damage the construction site had taken since the last tick.
      t:AdjustHealth(nil, maxH * delta)
      -- Construction: the builder's WorkProgress IS the site's fraction
      -- (Cfile:815480-815482) — that is the value the UI shows
      -- (construction.lua:380 GetWorkProgress).
      b.__workProgress = f
      -- Quarter/half/three-quarter progress callbacks: OnBuildProgress on the
      -- builder, OnBeingBuiltProgress on the site, fired when the fraction
      -- crosses 0.25/0.5/0.75 this tick (Cfile:815458-815476, pre vs post
      -- fraction).
      for _, thr in ipairs({ 0.25, 0.5, 0.75 }) do
        if oldFrac < thr and f >= thr then
          if b.OnBuildProgress then pcall(function() b:OnBuildProgress(t, oldFrac, f) end) end
          if t.OnBeingBuiltProgress then pcall(function() t:OnBeingBuiltProgress(b, oldFrac, f) end) end
          break
        end
      end
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
          local okB, errB = pcall(function() t:OnStopBeingBuilt(b, t:GetCurrentLayer()) end)
          if not okB then WARN('OnStopBeingBuilt: ' .. tostring(errB)) end
          -- Materialize scans for adjacent structures the moment the unit is
          -- complete and runs OnAdjacentTo on both sides (Cfile:953548-953576).
          -- This is where FA's adjacency bonuses come from.
          __notifyAdjacent(task.target)
        end
        b.UnitBeingBuilt = t
        local okS, errS = pcall(function() b:OnStopBuild(t, task.order) end)
        if not okS then WARN('OnStopBuild: ' .. tostring(errS)) end
        clearFocus(b, t)
        -- The finished unit INHERITS its factory's command list
        -- (CFactoryBuildTask::InheritCommandsTo, Cfile:818487-818600), called
        -- after the completed build's OnStopBuild (818844-818966): every
        -- command of the factory goes into the new unit's queue; only
        -- TransportLoadUnits is skipped for AIR/NAVAL units. The rally point
        -- IS such a command (a UNITCOMMAND_Move in the list, Cfile:1008346),
        -- so it lands BEHIND the roll-off command RollOffUnit just issued
        -- (defaultunits.lua:571): off the pad first, then to the rally point.
        if task.order == 'FactoryBuild' then
          __inheritFactoryCommands(task.builder, task.target)
        end
        -- Now the produced unit is counted OUT of the factory's queue — the
        -- engine decrements the task's OWN BuildFactory command on completion
        -- (Cfile:838029: count <= 1 removes it, else DecreaseCount(1)). Drain the
        -- exact item this task was built from (task.__factoryItem), resolved by
        -- identity so a queue edited mid-build (__adjustFactoryQueue) does not
        -- drain the wrong stack. Repeat-build (Cfile:838042) is not modelled — a
        -- drained queue simply empties.
        if task.order == 'FactoryBuild' and task.__factoryItem then
          local item = task.__factoryItem
          item.count = item.count - 1
          if item.count <= 0 and b.__buildQueue then
            for i = table.getn(b.__buildQueue), 1, -1 do
              if b.__buildQueue[i] == item then table.remove(b.__buildQueue, i); break end
            end
          end
        end
        n = n + 1
        done[n] = tid
      end
    elseif not (task.blocked and b and t) then
      -- ungueltig oder fertig -> Task entfernen; ausser Reichweite bleibt er
      n = n + 1
      done[n] = tid
    end
  end
  for i = 1, n do
    local tid = done[i]
    local task = __buildTasks[tid]
    local b = task and __units[task.builder]
    -- Every build task resets the builder's WorkProgress when it ends
    -- (task destructors, Cfile:814889/817002/817050/818358/819000).
    if b then b.__workProgress = 0 end
    __buildTasks[tid] = nil
  end
end

function __buildTaskCount()
  local n = 0
  for _ in pairs(__buildTasks) do n = n + 1 end
  return n
end
