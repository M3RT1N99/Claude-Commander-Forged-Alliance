import type { LuaHost } from '../lua/host'
import MOTION_LUA from '../engine-lua/motion.lua?raw'

/**
 * Engine-Bewegung — der Navigator (`unit:GetNavigator():SetGoal`) + die
 * Physik-Fortschreibung (`Entity::AdvanceCoords`), die pro Sim-Beat NACH der
 * Thread-Stage läuft (Beat-Reihenfolge aus docs/research/engine-architecture.md).
 *
 * Wie der Scheduler ist dies ENGINE-Code, der im Lua-VM läuft (kein Spiel-
 * skript): so bleibt der Unit-Zustand (`__pos`/`__heading`) kohärent in Lua und
 * es gibt keine per-Unit-Round-Trips pro Tick. Die Bewegungswerte kommen aus
 * dem Blueprint (`Physics.MaxSpeed/TurnRate/MaxAcceleration/MaxBrake`).
 *
 * Determinismus: Lua-5.4-Zahlen sind Doubles (nicht f32). Für Single-Player
 * ausreichend; bit-exaktes Lockstep folgt mit Gleis A (Lua-5.0-WASM).
 */


/** Installs Navigator + physics update in Lua host. */
export function installMotion(host: LuaHost): void {
  host.eval(MOTION_LUA)
}

/** Physics step of a beat (after the thread stage). */
export function motionTick(host: LuaHost): void {
  host.eval('__advanceMotion()')
}
