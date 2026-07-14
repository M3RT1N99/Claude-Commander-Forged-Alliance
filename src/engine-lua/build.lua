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
function __issueBuildTask(builderId, targetId, order)
  local b = __units[builderId]
  local t = __units[targetId]
  if not b or not t then return -1 end
  order = order or 'MobileBuild'
  local tid = __nextBuildTask
  __nextBuildTask = tid + 1
  __buildTasks[tid] = {
    builder = builderId, target = targetId, step = 0, blocked = false, order = order,
  }

  -- Approach: ausserhalb MaxBuildDistance zum Ziel laufen. Eine Fabrik baut in
  -- sich selbst — die laeuft nirgendwohin.
  if order ~= 'FactoryBuild' then
    local mbd = (b.__bp and b.__bp.Economy and b.__bp.Economy.MaxBuildDistance) or 0
    local bp = b.__pos or { 0, 0, 0 }
    local tp = t.__pos or { 0, 0, 0 }
    local dx = tp[1] - bp[1]
    local dz = tp[3] - bp[3]
    if mbd > 0 and math.sqrt(dx * dx + dz * dz) > mbd then
      b.__goal = { tp[1], tp[3] }
    end
  end

  -- Die Engine setzt UnitBeingBuilt, BEVOR sie OnStartBuild ruft:
  -- FactoryUnit.RollOffUnit (defaultunits.lua:570) liest genau dieses Feld.
  b.UnitBeingBuilt = t
  pcall(function() b:OnStartBuild(t, order) end)
  pcall(function() t:OnStartBeingBuilt(b, order) end)
  return tid
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
function __queueFactoryBuild(factoryId, bpId, count)
  local f = __units[factoryId]
  if not f then return false end
  f.__buildQueue = f.__buildQueue or {}
  local q = f.__buildQueue
  local n = table.getn(q)
  -- Gleicher Blueprint wie zuletzt? Dann stapeln (die UI zeigt Stapel, keine
  -- Einzelposten).
  if n > 0 and q[n].id == bpId then
    q[n].count = q[n].count + (count or 1)
  else
    q[n + 1] = { id = bpId, count = count or 1 }
  end
  return true
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
    local q = f.__buildQueue
    if q and table.getn(q) > 0 and not f.__beingBuilt and not isBuilding(id) then
      local item = q[1]
      local p = f.__pos or { 0, 0, 0 }
      local scriptPath = '/units/' .. item.id .. '/' .. item.id .. '_script.lua'
      local uid, err = __spawnBuildSite(scriptPath, item.id, p[1], p[2], p[3], f.__army or 1)
      if uid < 0 then
        WARN('Fabrik ' .. tostring(id) .. ' kann ' .. tostring(item.id) .. ' nicht bauen: ' .. tostring(err))
        table.remove(q, 1)
      else
        __issueBuildTask(id, uid, 'FactoryBuild')
        item.count = item.count - 1
        if item.count <= 0 then table.remove(q, 1) end
      end
    end
  end
end

-- Phase 1 (VOR dem Oekonomie-Tick): Sollschritt + Ressourcen-Bedarf anmelden.
function __buildCollect()
  for tid, task in pairs(__buildTasks) do
    local b = __units[task.builder]
    local t = __units[task.target]
    local army = (b and b.__army) or 1
    task.step = 0
    task.blocked = false
    if b and t and (t.__fraction or 1) < 1 then
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
        local bRate = (b.__bp and b.__bp.Economy and b.__bp.Economy.BuildRate) or 0
        local te = (t.__bp and t.__bp.Economy) or {}
        local bt = te.BuildTime or 1
        if bt < 1 then bt = 1 end
        local step = (bRate / bt) * 0.1
        local rest = 1 - (t.__fraction or 0)
        if step > rest then step = rest end
        task.step = step
        __econSetBuildRequest(army, tid, (te.BuildCostMass or 0) * step, (te.BuildCostEnergy or 0) * step)
      end
    else
      __econClearBuildRequest(army, tid)
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
    if b and t and task.step > 0 then
      local rate = __econBuildRate(army, tid)
      local f = (t.__fraction or 0) + task.step * rate
      if f > 1 then f = 1 end
      t.__fraction = f
      t.__health = t:GetMaxHealth() * f
      if f >= 1 then
        t.__beingBuilt = false
        __econSetComplete(army, task.target, true)
        -- Reihenfolge wie in der Engine: erst ist die Unit fertig, dann erfaehrt
        -- der Bauer davon. FactoryUnit.OnStopBuild rollt die Einheit vom Hof
        -- (defaultunits.lua:515-526) — sie muss dafuer schon leben.
        pcall(function() t:OnStopBeingBuilt(b, task.order) end)
        b.UnitBeingBuilt = t
        pcall(function() b:OnStopBuild(t, task.order) end)
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
    __econClearBuildRequest((b and b.__army) or 1, tid)
    __buildTasks[tid] = nil
  end
end

function __buildTaskCount()
  local n = 0
  for _ in pairs(__buildTasks) do n = n + 1 end
  return n
end
