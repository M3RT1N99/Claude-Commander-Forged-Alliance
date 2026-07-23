# Engine core — from IDA decompilation (Cfile/ForgedAlliance.exe.c)

Basis for engine construction: **the engine loads/executes the original Lua, which
Lua IS the game.** Source: full decompilation with symbol names
(`Moho::` = Engine, `LuaPlus::` = Lua-5.0-Bindung). Zeilen = Cfile-Zeilen.

## 1. Lua-Global-Registrierung: `Moho::CScrLuaInitForm`

Any C function that Lua sees as global (ForkThread, WaitTicks,
EntityCategoryGetUnitList, …), is registered via a `CScrLuaInitForm`:

- `luadef_ForkThread.mMethodName = "ForkThread"`, `.mClassName = "<global>"`
  (:592409-592410) — name + class ("<global>" = free function).
- Registration chained in `Moho::scr_CoreInits.mForms` (:592407); the
  `register_*_LuaFuncDef` pointers are in a collection array (:53965-53974).
- The actual C-Impl is called `cfunc_<Name>` or `cfunc_<Name>L`
  (L variant gets the `LuaPlus::LuaState*`), e.g. E.g. `cfunc_ForkThread`
  (:592397) → `cfunc_ForkThreadL(*(LuaState**)(a1+68))`.

→ **Engine replica:** a registry that contains named C(TS) functions as Lua
Globals (or class methods) depend on the respective Lua state.

## 2. Sim-Thread-Scheduler: `Moho::CTaskThread` + `mWaitTicks`

The Sim-Lua deterministic coroutine execution (ForkThread/WaitTicks):

- Lua-`ForkThread(fn, args…)` → `cfunc_ForkThreadL` creates a task thread
  (Coroutine) on a stage; Threads hang in a linked list
  `stage->mThreads` (:438592-438594, 437095-437097).
- Pro Sim-Beat runs `Moho::CTaskThread::DoTaskTick(thrd)` (:438885):
  - `v1 = --thrd->mWaitTicks; if (v1 > 0) return` — still sleeping (:438899-438902).
  - otherwise `TaskTick(mTask)` (continue coroutine, :438912) and per status:
    - `TASKSTATUS_Wait` → `mWaitTicks = 1` (wait a tick, :438944)
    - default `n` → `mWaitTicks = n - 1` (**WaitTicks(n)**, :438947)
    - `TASKSTATUS_Done` → Subtask poppen, weiter (:438927-438936)
    - `TASKSTATUS_Abort` → `CTaskThread::Destroy` (:438921-438923)
    - `TASKSTATUS_Suspend` → `Stage(thrd)` (:438924-438926)
- `cfunc_KillThread`/`cfunc_ResumeThread` (:6225,6248) steuern Threads.

→ **Engine replica:** a sim scheduler that runs all Lua threads per 10 Hz beat
(wasmoon coroutines) goes through, `waitTicks` decrements and due
continues. `ForkThread`, `WaitTicks`, `WaitFor`, `KillThread` as Lua globals.
This replaces the missing tick in the current `LuaSim` (only `OnCreate`).

## 3. Scriptable objects: `Moho::CScriptObject`

Basis of all Lua-coupled Sim objects (Unit ultimately inherits from this):

- `CScriptObject::RunScript(filename, …)` (:11501-11502), `Call` (:11501),
  `RunScriptMultiRet` (:6154), `FindScript` (:6153),
  `CreateLuaObject`/`SetLuaObject` (:6149-6150) — the C→Lua call bridge.
- `Moho::SCR_CreateSimpleMetatable(obj, L)` (:6390) — creates the metatable,
  through which Lua sees the C methods of an object.
- `LogScriptWarning` (:6152) — Error path (explains the WARN outputs).

→ **Engine-Nachbau:** existiert im Ansatz (`src/lua/moho.ts` bindet
entity_methods/unit_methods via Metatable; `unitFactory.ts` instantiated).
Must align with the real CScriptObject model (Metatable based,
C-Callbacks OnCreate/OnTick/OnDamage über RunScript).

## Reference to the current repo

- `src/lua/host.ts` — Lua host (wasmoon). Missing: the sim beat + thread scheduler.
- `src/lua/moho.ts` — moho method stubs. Must grow to true API interface.
- `src/sim/simWorld.ts` — **parallel TS replica** (economy/movement); should
  REPLACED by the Lua-driven sim (see Memory
  "engine-first-not-hardcoded").

*(Expanded with 5-agent engine mapping results:
moho sim api scope, maui ui framework, game loop order,
Command dispatch, blueprint loading.)*
