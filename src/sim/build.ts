import type { LuaHost } from '../lua/host'
import BUILD_LUA from '../engine-lua/build.lua?raw'

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


/** Installiert das Bau-System (Bau-Tasks + Fortschritts-Fortschreibung). */
export function installBuild(host: LuaHost): void {
  host.eval(BUILD_LUA)
}

/**
 * Phase 0 des Beats: jede Fabrik mit Warteschlange setzt die nächste Einheit auf.
 * Muss VOR dem Sammeln laufen, sonst zahlt der neue Auftrag erst einen Beat
 * später.
 */
export function factoryTick(host: LuaHost): void {
  host.eval('__factoryTick()')
}

/** Phase 1 des Beats: Bau-Bedarf anmelden (vor dem Ökonomie-Tick). */
export function buildCollect(host: LuaHost): void {
  host.eval('__buildCollect()')
}

/**
 * Eine Einheit in die Bau-Warteschlange einer Fabrik legen — das, was
 * `IssueBlueprintCommand("UNITCOMMAND_BuildFactory", id, count)` in der Engine
 * auslöst (construction.lua:884).
 */
export function queueFactoryBuild(
  host: LuaHost,
  factoryId: number,
  blueprintId: string,
  count: number,
): boolean {
  return (
    host.eval(
      `return __queueFactoryBuild(${factoryId}, ${JSON.stringify(blueprintId)}, ${count})`,
    ) === true
  )
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
