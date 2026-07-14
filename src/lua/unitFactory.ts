import type { LuaHost } from './host'
import SETUP_LUA from '../engine-lua/units.lua?raw'
import BLUEPRINTS_LUA from '../engine-lua/blueprints.lua?raw'

/**
 * Spawnt Units über die Original-Lua-Klassen und exponiert ihren Zustand für
 * Renderer/Sim. Eine Unit entsteht wie in der Engine:
 *   `units/<id>/<id>_script.lua` setzt `TypeClass = <Klasse>` (leitet von den
 *   Fraktions-/Default-Klassen bis `moho.unit_methods` ab). Wir instanziieren
 *   TypeClass, setzen den Engine-Zustand (Blueprint, Position, Health) und
 *   rufen `OnCreate` — reines Original-Verhalten.
 *
 * Der Zustand liegt in Instanz-Feldern (`self.__pos` etc., siehe moho.ts).
 * `readUnit` liefert einen flachen Snapshot für die TS-Seite.
 */

export interface LuaUnitState {
  id: number
  name: string
  x: number
  y: number
  z: number
  heading: number
  health: number
  maxHealth: number
  /** Mesh-Blueprint-ID, falls das Skript SetMesh gerufen hat */
  mesh: string | null
}


export function installUnitFactory(host: LuaHost): void {
  host.eval(SETUP_LUA)
}

/**
 * Richtet die Original-Blueprint-Pipeline ein (Collectors, DiskFindFiles über
 * `__bpFiles`, `Blueprints.lua`). Danach registriert `loadUnitBlueprint`
 * einzelne Blueprints über die echte `LoadBlueprints()`.
 */
export function installBlueprintPipeline(host: LuaHost): void {
  host.eval(BLUEPRINTS_LUA)
  host.loadGlobal('/lua/system/Blueprints.lua')
}

/**
 * Registriert ein einzelnes Unit-Blueprint über die echte Pipeline
 * (`LoadBlueprints`), sofern noch nicht geschehen. `bpBytes` = Inhalt der
 * `units/<id>/<id>_unit.bp`.
 */
export function loadUnitBlueprint(host: LuaHost, id: string, bpBytes: Uint8Array): void {
  const already = host.eval(`return __registered.Unit['${id.toLowerCase()}'] ~= nil`)
  if (already === true) return
  const path = `units/${id}/${id}_unit.bp`
  host.addFile(path, bpBytes)
  host.eval(`__bpFiles = { '/${path}' }; LoadBlueprints()`)
}

/** Spawnt eine Unit über ihre Original-Klasse; liefert Unit-ID oder wirft. */
/**
 * Das Skelett eines Blueprints in die Sim geben.
 *
 * Die Engine lädt das Modell einer Unit auch in der SIM, nicht nur im Renderer:
 * Waffentürme (`weapon.lua:67`), Mündungen, Bau- und Effekt-Knochen hängen alle
 * an Knochennamen, und `Unit:ValidateBone` (unit.lua:2751) fragt sie ab. Ohne
 * Skelett bricht schon `Weapon:OnCreate` ab — und damit die halbe Unit.
 */
export function setUnitBones(host: LuaHost, blueprintId: string, bones: string[]): void {
  const list = bones.map((b) => JSON.stringify(b)).join(',')
  host.eval(`__setBones(${JSON.stringify(blueprintId)}, { ${list} })`)
}

export function spawnLuaUnit(
  host: LuaHost,
  blueprintId: string,
  pos: { x: number; y: number; z: number },
  army = 1,
): number {
  const scriptPath = `/units/${blueprintId}/${blueprintId}_script.lua`
  const res = host.eval(
    `local id, err = __spawnUnit(${JSON.stringify(scriptPath)}, ${JSON.stringify(
      blueprintId,
    )}, ${pos.x}, ${pos.y}, ${pos.z}, ${army}); return { id = id, err = err }`,
  ) as { id: number; err: string }
  if (res.err) throw new Error(`spawn ${blueprintId}: ${res.err}`)
  return res.id
}

/**
 * Spawnt eine UNFERTIGE Baustelle (FractionComplete 0, IsBeingBuilt) über die
 * Original-Klasse; Produktion/Unterhalt bleiben bis zur Fertigstellung aus.
 */
export function spawnBuildSite(
  host: LuaHost,
  blueprintId: string,
  pos: { x: number; y: number; z: number },
  army = 1,
): number {
  const scriptPath = `/units/${blueprintId}/${blueprintId}_script.lua`
  const res = host.eval(
    `local id, err = __spawnBuildSite(${JSON.stringify(scriptPath)}, ${JSON.stringify(
      blueprintId,
    )}, ${pos.x}, ${pos.y}, ${pos.z}, ${army}); return { id = id, err = err }`,
  ) as { id: number; err: string }
  if (res.err) throw new Error(`build-site ${blueprintId}: ${res.err}`)
  return res.id
}

/** Liest den aktuellen Zustand einer gespawnten Lua-Unit. */
export function readLuaUnit(host: LuaHost, id: number): LuaUnitState | null {
  return host.eval(`return __readUnit(${id})`) as LuaUnitState | null
}
