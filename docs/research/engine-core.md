# Engine core — from IDA decompilation (Cfile/ForgedAlliance.exe.c)

The basis for building the engine is this: **the engine loads and executes the
original Lua; Lua IS the game.** Source: the complete decompilation with symbol
names (`Moho::` = engine, `LuaPlus::` = Lua 5.0 binding). Line references refer
to Cfile.

## 1. Lua global registration: `Moho::CScrLuaInitForm`

Every C function Lua sees as a global (ForkThread, WaitTicks,
EntityCategoryGetUnitList, …) is registered through a `CScrLuaInitForm`:

- `luadef_ForkThread.mMethodName = "ForkThread"`, `.mClassName = "<global>"`
  (:592409-592410) — name and class (`"<global>"` means a free function).
- Registration is chained through `Moho::scr_CoreInits.mForms` (:592407); the
  `register_*_LuaFuncDef` pointers are stored in a collection array
  (:53965-53974).
- The actual C implementation is called `cfunc_<Name>` or `cfunc_<Name>L`
  (the `L` variant receives the `LuaPlus::LuaState*`), for example
  `cfunc_ForkThread` (:592397) →
  `cfunc_ForkThreadL(*(LuaState**)(a1+68))`.

→ **Engine implementation:** provide a registry that attaches named C/TS
functions as Lua globals or class methods to the appropriate Lua state.

## 2. Sim thread scheduler: `Moho::CTaskThread` + `mWaitTicks`

The deterministic coroutine execution for Sim Lua (ForkThread/WaitTicks):

- Lua `ForkThread(fn, args…)` → `cfunc_ForkThreadL` creates a task thread
  (coroutine) on a stage. Threads are held in the linked list
  `stage->mThreads` (:438592-438594, 437095-437097).
- Every Sim beat runs `Moho::CTaskThread::DoTaskTick(thrd)` (:438885):
  - `v1 = --thrd->mWaitTicks; if (v1 > 0) return` — the thread is still
    sleeping (:438899-438902).
  - Otherwise, call `TaskTick(mTask)` to continue the coroutine (:438912), then
    handle its status:
    - `TASKSTATUS_Wait` → `mWaitTicks = 1` (wait one tick, :438944)
    - default `n` → `mWaitTicks = n - 1` (**WaitTicks(n)**, :438947)
    - `TASKSTATUS_Done` → pop the subtask and continue (:438927-438936)
    - `TASKSTATUS_Abort` → `CTaskThread::Destroy` (:438921-438923)
    - `TASKSTATUS_Suspend` → `Stage(thrd)` (:438924-438926)
- `cfunc_KillThread`/`cfunc_ResumeThread` (:6225,6248) control threads.
- **`CTaskStage::DoFrame` (:439351-439395) drains the list.** It pops threads
  off the head of `mThreads` until the list is EMPTY and ticks each; the ticked
  threads collect on a side list that is spliced back in order. The constructor
  appends a new thread to the tail with `mWaitTicks = 0` (:438783-438808), so a
  thread forked DURING the frame is ticked in that same frame, after everything
  already queued -- and so is a parked thread that `ResumeThread` appends
  (:593112-593124). Our scheduler used a snapshot bound and ran forks one tick
  late; fixed in `threads.lua`, pinned by `verify-simthreads.ts`.
- **A yield of 0 does not wait.** `TASKSTATUS_0` stores `mWaitTicks = 0` and,
  for an un-parked thread, `continue`s the tick loop (:438938-438942): the
  coroutine is resumed again in the same call. This is also how `WaitFor`
  (which yields 0 after pushing its wait task, :592990-592993) gets the wait
  task executed at once.
- **`CLuaTask::TaskTick` (:592150-592250) texts.** A Lua error: `Error running
  lua script: %s` (:592246), and the thread ends. A yield without a value ends
  the thread silently (LUA_TNONE -> -1, :592208/:592236). A non-number yield:
  `Invalid args to yield(); expected tick count` (:592230); a negative one:
  `Invalid args to yield(); tick count must be >=0` (:592216) -- both with a
  traceback, both end the thread. The count is read with `GetInteger`, a
  truncating cast.
- **`KillThread` (:592555-592590)** ignores nil, rejects any other non-thread
  with `TypeError "thread"` (`false` included -- the original always guards
  with `if x then`), refuses the root state and otherwise unlinks the thread
  at once.

→ **Engine implementation:** a Sim scheduler that traverses all Lua threads
(wasmoon coroutines) on every 10 Hz beat, decrements `waitTicks`, and resumes
threads that are due. Expose `ForkThread`, `WaitTicks`, `WaitFor`, and
`KillThread` as Lua globals. This replaces the missing tick in the current
`LuaSim` (which only runs `OnCreate`).

## 3. Scriptable objects: `Moho::CScriptObject`

The base of every Lua-coupled Sim object (which Unit ultimately inherits from):

- `CScriptObject::RunScript(filename, …)` (:11501-11502), `Call` (:11501),
  `RunScriptMultiRet` (:6154), `FindScript` (:6153), and
  `CreateLuaObject`/`SetLuaObject` (:6149-6150) form the C→Lua call bridge.
- `Moho::SCR_CreateSimpleMetatable(obj, L)` (:6390) creates the metatable
  through which Lua sees an object's C methods.
- `LogScriptWarning` (:6152) is the error path, explaining the WARN output.

→ **Engine implementation:** the foundation exists in `src/lua/moho.ts`, which
binds `entity_methods`/`unit_methods` through a metatable, and `unitFactory.ts`,
which instantiates them. It must be aligned with the real `CScriptObject` model:
metatable-based C callbacks such as OnCreate/OnTick/OnDamage invoked through
RunScript.

## Reference to the current repository

- `src/lua/host.ts` — Lua host (wasmoon). Missing: the Sim beat and thread scheduler.
- `src/lua/moho.ts` — moho method stubs. It must grow into the real API surface.
- `src/sim/simWorld.ts` — a **parallel TypeScript replica** for economy and
  movement; it must be REPLACED by the Lua-driven Sim (see memory
  `engine-first-nicht-hardcoden`).

*(Expanded with findings from the five-agent engine mapping: moho Sim API scope,
maui UI framework, game-loop order, command dispatch, and blueprint loading.)*
