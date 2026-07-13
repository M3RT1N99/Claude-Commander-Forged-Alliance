-- === Engine: Sim-Zeit + kooperativer Thread-Scheduler ===
__gameTick = 0
local threads = {}
local nthreads = 0
__currentThread = false
local unpack = unpack or table.unpack

function GetSimTicksPerSecond() return 10 end
function SecondsPerTick() return 0.1 end
function GameTick() return __gameTick end
function GetGameTick() return __gameTick end
function GetGameTimeSeconds() return __gameTick * 0.1 end

-- Thread-OBJEKT wie in der Engine: cfunc_ForkThreadL (Cfile:592423-592526)
-- liefert kein rohes Handle, sondern m_threadObj — ein Objekt mit Methoden,
-- u. a. :Destroy(). Unit:ForkThread legt es in self.Trash, und der Original-
-- trashbag.lua (Zeile 21) weist alles ohne Destroy() zurueck. Ein blankes
-- table wie frueher ist also nicht "fast richtig", sondern schlicht falsch.
local ThreadMeta = {}
ThreadMeta.__index = ThreadMeta
function ThreadMeta:Destroy() self.dead = true end
function ThreadMeta:IsDestroyed() return self.dead == true end
function ThreadMeta:IsAlive()
    return not self.dead and coroutine.status(self.co) ~= 'dead'
end

local function newThread(fn)
    return setmetatable({ co = coroutine.create(fn), wait = 0 }, ThreadMeta)
end

-- ForkThread(fn, ...) -> Thread-Objekt. Läuft ab dem folgenden Tick.
function ForkThread(fn, ...)
    if type(fn) ~= 'function' then error('ForkThread: function expected', 2) end
    local t = newThread(fn)
    t.args = {...}
    t.nargs = select('#', ...)
    nthreads = nthreads + 1
    threads[nthreads] = t
    return t
end

-- __startThread(fn): erster Slice SOFORT (setzt Sofort-Zustand, z. B. Unit-
-- OnCreate), Rest als regulärer Thread. Ermöglicht WaitTicks/ForkThread in
-- OnCreate, ohne die synchrone Sofortwirkung zu verlieren. -> ok, err.
function __startThread(fn)
    local t = newThread(fn)
    __currentThread = t
    local ok, res = coroutine.resume(t.co)
    __currentThread = false
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

-- Unit:ForkThread ist Lua (unit.lua) und legt das Objekt in self.Trash — der
-- Trash ruft beim Aufraeumen :Destroy(), womit der Thread stirbt.

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
                __currentThread = false
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
