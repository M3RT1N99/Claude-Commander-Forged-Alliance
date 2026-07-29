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

-- Thread OBJECT as in the engine: cfunc_ForkThreadL (Cfile:592423-592526)
-- returns not a raw handle but m_threadObj — an object with methods including
-- :Destroy(). Unit:ForkThread puts it in self.Trash, and original trashbag.lua
-- (line 21) rejects everything without Destroy(). A plain table, as used
-- before, is not "almost correct" but simply wrong.
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

-- Convert a coroutine yield into the wait the engine STORES (CTaskThread::
-- DoTaskTick, Cfile:438898): the yield is read with GetInteger (truncated to an
-- integer, must be >= 0), then a count v>=2 is stored as v-1 (default case) and
-- v==1 as 1 (TASKSTATUS_Wait). Combined with the per-tick PRE-decrement in
-- __simAdvanceThreads (--mWaitTicks; run when <= 0), WaitTicks(N) sleeps
-- max(1, N-1) ticks -- one fewer than storing the raw count, so WaitTicks(N>=2)
-- and WaitSeconds resume on the engine's tick instead of one late.
local function waitFromYield(res)
    local v = math.floor(tonumber(res) or 1) -- GetInteger truncates the yield
    if v >= 2 then return v - 1 end
    return v -- 0 -> 0, 1 -> 1
end

-- ForkThread(fn, ...) -> Thread object. Runs from the next tick onward.
function ForkThread(fn, ...)
    if type(fn) ~= 'function' then error('ForkThread: function expected', 2) end
    local t = newThread(fn)
    t.args = {...}
    t.nargs = select('#', ...)
    nthreads = nthreads + 1
    threads[nthreads] = t
    return t
end

-- __startThread(fn): first slice IMMEDIATELY (sets immediate state, e.g. Unit
-- OnCreate), then continues as a regular thread. Allows WaitTicks/ForkThread
-- in OnCreate without losing the synchronous immediate effect. -> ok, err.
function __startThread(fn)
    local t = newThread(fn)
    __currentThread = t
    local ok, res = coroutine.resume(t.co)
    __currentThread = false
    if not ok then return false, res end
    if coroutine.status(t.co) ~= 'dead' then
        if res == -1 then t.suspended = true else t.wait = waitFromYield(res) end
        nthreads = nthreads + 1
        threads[nthreads] = t
    end
    return true
end

-- WaitTicks(n): put the current thread to sleep for n ticks (coroutine.yield).
function WaitTicks(n)
    coroutine.yield(n or 1)
end

-- WaitSeconds(n) = WaitTicks(max(1, n*10)) with the fractional value passed
-- straight to yield (original siminit.lua:37-40); the engine's GetInteger then
-- TRUNCATES it (CLuaTask::TaskTick, Cfile:592180). Do NOT round here.
function WaitSeconds(s)
    coroutine.yield(math.max(1, (s or 0) * 10))
end

function KillThread(t)
    if t then t.dead = true end
end

-- Unit:ForkThread is Lua (unit.lua) and puts the object in self.Trash — when
-- cleared, Trash calls :Destroy(), which kills the thread.

function CurrentThread()
    return __currentThread
end

-- SuspendCurrentThread(): sleeps indefinitely until ResumeThread.
function SuspendCurrentThread()
    coroutine.yield(-1)
end

function ResumeThread(t)
    if t then t.wait = 0; t.suspended = false end
end

-- Resumes all due threads (Moho::CTaskStage::DoFrame).
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
                    t.wait = waitFromYield(res)
                end
            end
        end
    end
    -- Remove dead threads, preserving order (new forks remain).
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

-- A sim tick (engine Sim::AdvanceBeat — here: time + threads).
function __simTick()
    __gameTick = __gameTick + 1
    __simAdvanceThreads()
end

function __threadCount() return nthreads end
