import type { LuaHost } from './host'

/**
 * Sim-Thread-Scheduler + Zeit-Globals — Engine-Primitiv (Gegenstück zu
 * `Moho::CTaskStage`/`CTaskThread` + `ForkThread`/`WaitTicks`).
 *
 * Aus der Dekompilation (docs/research/engine-core.md): Unit-/AI-Logik läuft
 * NICHT als pro-Tick-Callback, sondern als kooperative Lua-Coroutinen. Ein
 * `ForkThread(fn, …)` erzeugt einen Thread; pro Sim-Tick resümiert
 * `CTaskThread::DoTaskTick` fällige Threads und dekrementiert `mWaitTicks`
 * (`WaitTicks(n)` = n Ticks schlafen). `OnCreate` selbst läuft als Thread —
 * ohne diesen Scheduler bleibt eine gespawnte Unit nach `OnCreate` stehen.
 *
 * Hier über native Lua-Coroutinen (wasmoon): `ForkThread` legt eine Coroutine
 * in eine Thread-Liste; `WaitTicks` = `coroutine.yield(n)`; `__simTick()`
 * (von der TS-Engine pro 10-Hz-Beat gerufen) rückt die Zeit vor und resümiert
 * die fälligen Threads (`Sim::AdvanceBeat`, vereinfacht auf Zeit + Threads).
 */

const SCHEDULER_LUA = `
-- === Engine: Sim-Zeit + kooperativer Thread-Scheduler ===
__gameTick = 0
local threads = {}
local nthreads = 0
__currentThread = nil
local unpack = unpack or table.unpack

function GetSimTicksPerSecond() return 10 end
function SecondsPerTick() return 0.1 end
function GameTick() return __gameTick end
function GetGameTick() return __gameTick end
function GetGameTimeSeconds() return __gameTick * 0.1 end

-- ForkThread(fn, ...) -> Thread-Handle. Läuft ab dem folgenden Tick.
function ForkThread(fn, ...)
    if type(fn) ~= 'function' then error('ForkThread: function expected', 2) end
    local t = { co = coroutine.create(fn), wait = 0, args = {...}, nargs = select('#', ...) }
    nthreads = nthreads + 1
    threads[nthreads] = t
    return t
end

-- __startThread(fn): erster Slice SOFORT (setzt Sofort-Zustand, z. B. Unit-
-- OnCreate), Rest als regulärer Thread. Ermöglicht WaitTicks/ForkThread in
-- OnCreate, ohne die synchrone Sofortwirkung zu verlieren. -> ok, err.
function __startThread(fn)
    local t = { co = coroutine.create(fn), wait = 0 }
    __currentThread = t
    local ok, res = coroutine.resume(t.co)
    __currentThread = nil
    if not ok then return false, res end
    if coroutine.status(t.co) ~= 'dead' then
        if res == -1 then t.suspended = true else t.wait = tonumber(res) or 1 end
        nthreads = nthreads + 1
        threads[nthreads] = t
    end
    return true
end

-- WaitTicks(n): aktuellen Thread n Ticks schlafen legen (coroutine.yield).
function WaitTicks(n)
    coroutine.yield(n or 1)
end

function WaitSeconds(s)
    coroutine.yield(math.floor((s or 0) * 10 + 0.5))
end

function KillThread(t)
    if t then t.dead = true end
end

function CurrentThread()
    return __currentThread
end

-- SuspendCurrentThread(): schläft unbegrenzt bis ResumeThread.
function SuspendCurrentThread()
    coroutine.yield(-1)
end

function ResumeThread(t)
    if t then t.wait = 0; t.suspended = false end
end

-- Resümiert alle fälligen Threads (Moho::CTaskStage::DoFrame).
function __simAdvanceThreads()
    local n = nthreads
    for i = 1, n do
        local t = threads[i]
        if t.dead or coroutine.status(t.co) == 'dead' then
            t.remove = true
        elseif not t.suspended then
            t.wait = t.wait - 1
            if t.wait <= 0 then
                __currentThread = t
                local ok, res
                if t.args then
                    ok, res = coroutine.resume(t.co, unpack(t.args, 1, t.nargs))
                    t.args = nil
                else
                    ok, res = coroutine.resume(t.co)
                end
                __currentThread = nil
                if not ok then
                    WARN('ForkThread-Fehler: ' .. tostring(res))
                    t.remove = true
                elseif coroutine.status(t.co) == 'dead' then
                    t.remove = true
                elseif res == -1 then
                    t.suspended = true
                else
                    t.wait = tonumber(res) or 1
                end
            end
        end
    end
    -- Tote Threads entfernen, Reihenfolge stabil (neue Forks bleiben erhalten).
    local w = 0
    for j = 1, nthreads do
        local t = threads[j]
        if not t.remove then
            w = w + 1
            threads[w] = t
        end
    end
    for j = w + 1, nthreads do threads[j] = nil end
    nthreads = w
end

-- Ein Sim-Tick (Engine Sim::AdvanceBeat — hier: Zeit + Threads).
function __simTick()
    __gameTick = __gameTick + 1
    __simAdvanceThreads()
end

function __threadCount() return nthreads end
`

/** Installiert den Thread-Scheduler + die Zeit-Globals in den Lua-Host. */
export function installSimThreads(host: LuaHost): void {
  host.eval(SCHEDULER_LUA)
}

/** Ein Sim-Tick: rückt die Spielzeit vor und resümiert fällige Lua-Threads. */
export function simTick(host: LuaHost): void {
  host.eval('__simTick()')
}

/** Aktueller Sim-Tick (`__gameTick`). */
export function currentTick(host: LuaHost): number {
  return Number(host.eval('return __gameTick')) || 0
}

/** Anzahl aktiver Lua-Threads. */
export function threadCount(host: LuaHost): number {
  return Number(host.eval('return __threadCount()')) || 0
}
