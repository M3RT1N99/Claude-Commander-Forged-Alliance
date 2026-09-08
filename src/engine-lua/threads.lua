-- === Engine: Sim time + the cooperative thread scheduler ===
--
-- The scheduler mirrors `Moho::CTaskStage` / `CTaskThread` / `CLuaTask`. Every
-- rule below is read from the decompilation:
--
--   * `cfunc_ForkThreadL` (Cfile:592423-592526) creates a new Lua state (the
--     coroutine), a `CTaskThread` on the CURRENT stage and a `CLuaTask` on it,
--     pushes the function and its arguments and returns the state's thread
--     object. It does NOT run the first slice.
--   * `CTaskThread::CTaskThread` (Cfile:438783-438808) starts with
--     `mWaitTicks = 0` and appends the thread to the TAIL of `stage->mThreads`.
--   * `CTaskStage::DoFrame` (Cfile:439351-439395) pops threads off the HEAD of
--     `mThreads` until the list is EMPTY and ticks each one; the ticked threads
--     collect on a side list that is spliced back afterwards, in order. So a
--     thread forked during the frame -- appended to `mThreads` -- is ticked IN
--     THE SAME FRAME, after everything that was already queued. The same goes
--     for a thread that `ResumeThread` un-parks during the frame.
--   * `CTaskThread::DoTaskTick` (Cfile:438885-438950) PRE-decrements
--     `mWaitTicks` and returns while it is still > 0. Otherwise it runs the
--     task chain and stores the yielded count: 1 -> `mWaitTicks = 1`
--     (TASKSTATUS_Wait), N >= 2 -> `N - 1` (default), and 0 -> `mWaitTicks = 0`
--     and, for an un-parked thread, `continue`: the task is ticked AGAIN at
--     once, in the same call. `WaitTicks(0)` therefore does not wait at all.
--   * `CLuaTask::TaskTick` (Cfile:592150-592250) resumes the coroutine. A Lua
--     error is logged as `Error running lua script: %s` and ends the thread
--     (Cfile:592240-592247). A yield WITHOUT a value -- the coroutine returned,
--     or `coroutine.yield()` bare -- ends the thread silently (LUA_TNONE ->
--     `return -1`, Cfile:592208/592236). A yield that is not a number logs
--     `Invalid args to yield(); expected tick count` with a traceback and ends
--     the thread (Cfile:592226-592233); a NEGATIVE count logs `Invalid args to
--     yield(); tick count must be >=0` and ends it too (Cfile:592211-592222).
--     The count is read with `GetInteger`, which TRUNCATES toward zero.
--   * `SuspendCurrentThread` (Cfile:593022-593054) moves the thread to the
--     stage's parked list (`mStaged = 1`) and yields 1. `ResumeThread`
--     (Cfile:593082-593130) sets `mWaitTicks = 0` and moves a parked thread
--     back to the TAIL of `mThreads`. Both refuse the root state:
--     "Can't suspend/resume a thread that wasn't created with ForkThread."
--   * `KillThread` (Cfile:592555-592590) does nothing for nil, rejects any
--     other non-thread (`TypeError "thread"`), refuses the root state and
--     otherwise `CTaskThread::Destroy`s the thread -- which unlinks it at
--     once, so a thread killed before its turn in the frame never runs. The
--     running coroutine is not interrupted; it ends at its next yield.
--
-- The thread object: the engine returns the coroutine itself, and
-- `config.lua:29-35` gives every coroutine the metatable
-- `{ Destroy = KillThread }`. Here a thread is a table around the coroutine
-- with the same surface (`:Destroy()`); the original Lua only ever calls that
-- (`trashbag.lua:21` rejects anything without `Destroy`).

__gameTick = 0
__currentThread = false
local unpack = unpack or table.unpack
local pack = table.pack

-- `SecondsPerTick` is scr_CoreInits and lives in BOTH VMs; `GetGameTick` is
-- sim_SimInits. `GameTick` and `GetSimTicksPerSecond` are scr_UserInits
-- (engine-api.md): they used to sit here and thereby in the Sim, where the
-- original does not have them. The UI has its own bodies in `ui-globals.lua`
-- (on `__uiGameTick`, not on the Sim tick). `scripts/check-vm-separation.ts`
-- pins that.
function SecondsPerTick() return 0.1 end
function GetGameTick() return __gameTick end
function GetGameTimeSeconds() return __gameTick * 0.1 end

local ThreadMeta = {}
ThreadMeta.__index = ThreadMeta
function ThreadMeta:Destroy() self.dead = true end
function ThreadMeta:IsDestroyed() return self.dead == true end
function ThreadMeta:IsAlive()
    return not self.dead and coroutine.status(self.co) ~= 'dead'
end

-- The run queue: `stage->mThreads`. A slot holds a thread or `false` -- the
-- hole a thread leaves when `ResumeThread` moves it to the tail. Holes and
-- dead threads are swept after every frame.
local threads = {}
local nthreads = 0

local function enqueue(t)
    nthreads = nthreads + 1
    threads[nthreads] = t
    t.slot = nthreads
end

local function newThread(fn)
    return setmetatable({ co = coroutine.create(fn), wait = 0 }, ThreadMeta)
end

-- Runs one slice of `t` and applies the result the way `CLuaTask::TaskTick`
-- and `CTaskThread::DoTaskTick` do. Returns true while the thread lives on.
-- `res` is the packed result of `coroutine.resume`.
local function settle(t, res)
    if not res[1] then
        -- gpg::Warnf("Error running lua script: %s", ...) (Cfile:592246)
        WARN('Error running lua script: ' .. tostring(res[2]))
        return false
    end
    if coroutine.status(t.co) == 'dead' then return false end
    -- No value on the stack: LUA_TNONE -> -1 -> the task is done (Cfile:592208).
    if res.n < 2 then return false end
    local v = res[2]
    if type(v) ~= 'number' then
        WARN(debug.traceback(t.co, 'Invalid args to yield(); expected tick count'))
        return false
    end
    -- GetInteger truncates toward zero (a C cast), it does not floor.
    if v >= 0 then v = math.floor(v) else v = math.ceil(v) end
    if v < 0 then
        WARN(debug.traceback(t.co, 'Invalid args to yield(); tick count must be >=0'))
        return false
    end
    -- DoTaskTick: 1 -> mWaitTicks = 1; N >= 2 -> N - 1; 0 -> 0 (Cfile:438938-438948).
    if v >= 2 then v = v - 1 end
    t.wait = v
    return true
end

-- One `DoTaskTick` for a due thread: resume, settle, and -- for a yield of 0
-- on an un-parked thread -- resume again at once (`continue`, Cfile:438938-438942).
local function tick(t)
    local prev = __currentThread
    repeat
        __currentThread = t
        local res
        if t.args then
            local a, n = t.args, t.nargs
            t.args = nil
            res = pack(coroutine.resume(t.co, unpack(a, 1, n)))
        else
            res = pack(coroutine.resume(t.co))
        end
        __currentThread = prev
        if not settle(t, res) then
            t.dead = true
            return
        end
    until t.wait ~= 0 or t.suspended or t.dead
end

-- ForkThread(fn, ...) -> thread object. The first slice runs in the current
-- frame if one is running (see DoFrame above), otherwise in the next.
function ForkThread(fn, ...)
    if type(fn) ~= 'function' then error("ForkThread: first argument isn't a function", 2) end
    local t = newThread(fn)
    t.args = pack(...)
    t.nargs = t.args.n
    enqueue(t)
    return t
end

-- __startThread(fn): first slice IMMEDIATELY (sets immediate state, e.g. Unit
-- OnCreate), then continues as a regular thread. Allows WaitTicks/ForkThread
-- in OnCreate without losing the synchronous immediate effect. -> ok, err.
-- The engine runs OnCreate in the root state, where a yield is an error; this
-- is a tolerance, not engine behaviour.
function __startThread(fn)
    local t = newThread(fn)
    local prev = __currentThread
    __currentThread = t
    local res = pack(coroutine.resume(t.co))
    __currentThread = prev
    if not res[1] then return false, res[2] end
    if settle(t, res) then enqueue(t) end
    return true
end

-- `WaitTicks = coroutine.yield` is the Sim's own definition (siminit.lua:35);
-- the UI's `WaitFrames` is the same (userinit.lua:13). The count goes to the
-- engine unchanged -- a bare `WaitTicks()` ends the thread, see above.
WaitTicks = coroutine.yield

-- siminit.lua:37-40, verbatim: the fractional count is passed on and the
-- engine's GetInteger truncates it. Do NOT round here.
function WaitSeconds(n)
    local ticks = math.max(1, n * 10)
    WaitTicks(ticks)
end

local function isThread(t)
    return getmetatable(t) == ThreadMeta
end

-- KillThread(t): nil is ignored (LUA_TNIL, Cfile:592571); anything else that
-- is not a thread is a type error -- `false` included.
function KillThread(t)
    if t == nil then return end
    if not isThread(t) then error("bad argument #1 to 'KillThread' (thread expected)", 2) end
    t.dead = true
end

-- Unit:ForkThread is Lua (unit.lua) and puts the object in self.Trash -- when
-- cleared, Trash calls :Destroy(), which kills the thread.

-- The engine answers with the calling state's own thread object even from the
-- root state (Cfile:593179-593190); there `KillThread`/`ResumeThread` then
-- refuse it. Outside a thread this returns `false`, and the same two calls
-- refuse that as "not a thread".
function CurrentThread()
    return __currentThread
end

-- SuspendCurrentThread(): park the thread until ResumeThread (Cfile:593022-593054).
function SuspendCurrentThread()
    local t = __currentThread
    if not t then error("Can't suspend a thread that wasn't created with ForkThread.", 2) end
    t.suspended = true
    coroutine.yield(1)
end

-- ResumeThread(t): `mWaitTicks = 0`, and a parked thread goes back to the
-- TAIL of the run queue (Cfile:593112-593124) -- so it runs after everything
-- already queued, in the current frame if one is running.
function ResumeThread(t)
    if not isThread(t) then error("Can't resume a thread that wasn't created with ForkThread.", 2) end
    if t.dead then return end
    t.wait = 0
    if t.suspended then
        t.suspended = false
        threads[t.slot] = false
        enqueue(t)
    end
end

-- One frame of the stage (Moho::CTaskStage::DoFrame). The bound is read on
-- every pass: threads queued DURING the frame run in it.
function __simAdvanceThreads()
    local i = 1
    while i <= nthreads do
        local t = threads[i]
        if t and not t.dead and not t.suspended then
            if coroutine.status(t.co) == 'dead' then
                t.dead = true
            else
                t.wait = t.wait - 1 -- --mWaitTicks (Cfile:438898)
                if t.wait <= 0 then tick(t) end
            end
        end
        i = i + 1
    end
    -- Sweep holes and dead threads, keeping the order.
    local w = 0
    for j = 1, nthreads do
        local t = threads[j]
        if t and not t.dead and coroutine.status(t.co) ~= 'dead' then
            w = w + 1
            threads[w] = t
            t.slot = w
        end
    end
    for j = w + 1, nthreads do threads[j] = nil end
    nthreads = w
end

-- A sim tick (engine Sim::AdvanceBeat -- here: time + threads).
function __simTick()
    __gameTick = __gameTick + 1
    -- The decal buffer's sweep runs with the tick (CDecalBuffer, Cfile:1112362).
    -- globals.lua provides it; the scheduler suite loads SimThreads alone.
    local sweep = rawget(_G, '__decalSweep')
    if sweep then sweep() end
    __simAdvanceThreads()
end

function __threadCount()
    local n = 0
    for j = 1, nthreads do
        local t = threads[j]
        if t and not t.dead then n = n + 1 end
    end
    return n
end
