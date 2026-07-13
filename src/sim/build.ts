import type { LuaHost } from '../lua/host'

/**
 * Engine-Bausystem — der Bau-Task (Original: `CBuildTaskHelper`).
 *
 * Binär verifiziert (CBuildTaskHelper::UpdateWorkProgress @0x5f5f2c):
 *   delta = buildRate / BuildTime · LimitingRate · 0.1
 * Der Bauer meldet pro Tick seinen Ressourcen-Bedarf (BuildCost · step) als
 * Verbraucher in der Armee-Ökonomie an; die gewährte `LimitingRate` skaliert
 * Fortschritt UND Verbrauch gleichermaßen (Kosten pro Fortschrittseinheit
 * bleiben invariant). Bei Fertigstellung feuern die Original-Lua-Callbacks
 * `OnStopBeingBuilt`/`OnStopBuild`.
 *
 * Beat-Reihenfolge (wie Army::OnTick → Tasks):
 *   buildCollect → economy.tick (Zwei-Ratio) → buildApply → Threads → Physik
 */

const BUILD_LUA = `
__buildTasks = {}
__nextBuildTask = 1

-- Bau-Auftrag erteilen: Bauer baut die Baustelle. Ausser Reichweite laeuft er
-- erst hin (Approach ueber den Navigator).
function __issueBuildTask(builderId, targetId)
  local b = __units[builderId]
  local t = __units[targetId]
  if not b or not t then return -1 end
  local tid = __nextBuildTask
  __nextBuildTask = tid + 1
  __buildTasks[tid] = { builder = builderId, target = targetId, step = 0, blocked = false }

  -- Approach: ausserhalb MaxBuildDistance zum Ziel laufen
  local mbd = (b.__bp and b.__bp.Economy and b.__bp.Economy.MaxBuildDistance) or 0
  local bp = b.__pos or { 0, 0, 0 }
  local tp = t.__pos or { 0, 0, 0 }
  local dx = tp[1] - bp[1]
  local dz = tp[3] - bp[3]
  if mbd > 0 and math.sqrt(dx * dx + dz * dz) > mbd then
    b.__goal = { tp[1], tp[3] }
  end

  pcall(function() b:OnStartBuild(t, 'MobileBuild') end)
  pcall(function() t:OnStartBeingBuilt(b, 'MobileBuild') end)
  return tid
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
        pcall(function() t:OnStopBeingBuilt(b, 'MobileBuild') end)
        pcall(function() b:OnStopBuild(t) end)
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
`

/** Installiert das Bau-System (Bau-Tasks + Fortschritts-Fortschreibung). */
export function installBuild(host: LuaHost): void {
  host.eval(BUILD_LUA)
}

/** Phase 1 des Beats: Bau-Bedarf anmelden (vor dem Ökonomie-Tick). */
export function buildCollect(host: LuaHost): void {
  host.eval('__buildCollect()')
}

/** Phase 2 des Beats: gewährte Rate anwenden (nach dem Ökonomie-Tick). */
export function buildApply(host: LuaHost): void {
  host.eval('__buildApply()')
}

/** Erteilt einen Bau-Auftrag; liefert die Task-ID (oder -1). */
export function issueBuildTask(host: LuaHost, builderId: number, targetId: number): number {
  return Number(host.eval(`return __issueBuildTask(${builderId}, ${targetId})`))
}

/** Anzahl offener Bau-Aufgaben. */
export function buildTaskCount(host: LuaHost): number {
  return Number(host.eval('return __buildTaskCount()'))
}
