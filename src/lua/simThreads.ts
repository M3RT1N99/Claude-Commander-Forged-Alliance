import type { LuaHost } from './host'
import SCHEDULER_LUA from '../engine-lua/threads.lua?raw'

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


/** Installs the thread scheduler + time globals into the Lua host. */
export function installSimThreads(host: LuaHost): void {
  host.eval(SCHEDULER_LUA)
}

/** A Sim-Tick: advances the game time and summarizes Lua threads that are due. */
export function simTick(host: LuaHost): void {
  host.eval('__simTick()')
}

/** Aktueller Sim-Tick (`__gameTick`). */
export function currentTick(host: LuaHost): number {
  return Number(host.eval('return __gameTick')) || 0
}

/** Number of active Lua threads. */
export function threadCount(host: LuaHost): number {
  return Number(host.eval('return __threadCount()')) || 0
}
