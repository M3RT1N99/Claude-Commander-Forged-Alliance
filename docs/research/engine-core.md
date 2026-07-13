# Engine-Kern — aus der IDA-Dekompilation (Cfile/ForgedAlliance.exe.c)

Grundlage für den Engine-Bau: **die Engine lädt/führt die Original-Lua aus, die
Lua IST das Spiel.** Quelle: vollständige Dekompilation mit Symbolnamen
(`Moho::` = Engine, `LuaPlus::` = Lua-5.0-Bindung). Zeilen = Cfile-Zeilen.

## 1. Lua-Global-Registrierung: `Moho::CScrLuaInitForm`

Jede C-Funktion, die die Lua als Global sieht (ForkThread, WaitTicks,
EntityCategoryGetUnitList, …), wird über ein `CScrLuaInitForm` registriert:

- `luadef_ForkThread.mMethodName = "ForkThread"`, `.mClassName = "<global>"`
  (:592409-592410) — Name + Klasse ("<global>" = freie Funktion).
- Registrierung verkettet in `Moho::scr_CoreInits.mForms` (:592407); die
  `register_*_LuaFuncDef`-Zeiger stehen in einem Sammel-Array (:53965-53974).
- Die eigentliche C-Impl heißt `cfunc_<Name>` bzw. `cfunc_<Name>L`
  (L-Variante bekommt den `LuaPlus::LuaState*`), z. B. `cfunc_ForkThread`
  (:592397) → `cfunc_ForkThreadL(*(LuaState**)(a1+68))`.

→ **Engine-Nachbau:** eine Registry, die benannte C(TS)-Funktionen als Lua-
Globals (bzw. Klassenmethoden) in den jeweiligen Lua-State hängt.

## 2. Sim-Thread-Scheduler: `Moho::CTaskThread` + `mWaitTicks`

Die deterministische Coroutine-Ausführung des Sim-Lua (ForkThread/WaitTicks):

- Lua-`ForkThread(fn, args…)` → `cfunc_ForkThreadL` erzeugt einen Task-Thread
  (Coroutine) auf einer Stage; Threads hängen in einer verketteten Liste
  `stage->mThreads` (:438592-438594, 437095-437097).
- Pro Sim-Beat läuft `Moho::CTaskThread::DoTaskTick(thrd)` (:438885):
  - `v1 = --thrd->mWaitTicks; if (v1 > 0) return` — schläft noch (:438899-438902).
  - sonst `TaskTick(mTask)` (Coroutine fortsetzen, :438912) und je Status:
    - `TASKSTATUS_Wait` → `mWaitTicks = 1` (ein Tick warten, :438944)
    - default `n` → `mWaitTicks = n - 1` (**WaitTicks(n)**, :438947)
    - `TASKSTATUS_Done` → Subtask poppen, weiter (:438927-438936)
    - `TASKSTATUS_Abort` → `CTaskThread::Destroy` (:438921-438923)
    - `TASKSTATUS_Suspend` → `Stage(thrd)` (:438924-438926)
- `cfunc_KillThread`/`cfunc_ResumeThread` (:6225,6248) steuern Threads.

→ **Engine-Nachbau:** ein Sim-Scheduler, der pro 10-Hz-Beat alle Lua-Threads
(wasmoon-Coroutinen) durchgeht, `waitTicks` dekrementiert und fällige
fortsetzt. `ForkThread`, `WaitTicks`, `WaitFor`, `KillThread` als Lua-Globals.
Das ersetzt den fehlenden Tick im aktuellen `LuaSim` (nur `OnCreate`).

## 3. Skriptbare Objekte: `Moho::CScriptObject`

Basis aller Lua-gekoppelten Sim-Objekte (Unit erbt letztlich hierüber):

- `CScriptObject::RunScript(filename, …)` (:11501-11502), `Call` (:11501),
  `RunScriptMultiRet` (:6154), `FindScript` (:6153),
  `CreateLuaObject`/`SetLuaObject` (:6149-6150) — die C→Lua-Aufrufbrücke.
- `Moho::SCR_CreateSimpleMetatable(obj, L)` (:6390) — erzeugt die Metatable,
  über die Lua die C-Methoden eines Objekts sieht.
- `LogScriptWarning` (:6152) — Fehlerpfad (erklärt die WARN-Ausgaben).

→ **Engine-Nachbau:** existiert im Ansatz (`src/lua/moho.ts` bindet
entity_methods/unit_methods via Metatable; `unitFactory.ts` instanziiert).
Muss auf das echte CScriptObject-Modell ausgerichtet werden (Metatable-basiert,
C-Callbacks OnCreate/OnTick/OnDamage über RunScript).

## Bezug zum aktuellen Repo

- `src/lua/host.ts` — Lua-Host (wasmoon). Fehlt: der Sim-Beat + Thread-Scheduler.
- `src/lua/moho.ts` — moho-Methoden-Stubs. Muss zur echten API-Oberfläche wachsen.
- `src/sim/simWorld.ts` — **paralleler TS-Nachbau** (Ökonomie/Bewegung); soll
  durch die Lua-getriebene Sim ERSETZT werden (siehe Memory
  „engine-first-nicht-hardcoden").

*(Wird mit den Ergebnissen der 5-Agenten-Engine-Kartierung erweitert:
moho-Sim-API-Umfang, maui-UI-Framework, Game-Loop-Reihenfolge,
Command-Dispatch, Blueprint-Laden.)*
