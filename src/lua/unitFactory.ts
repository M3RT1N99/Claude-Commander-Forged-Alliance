import type { LuaHost } from './host'
import type { ScmBone } from '../formats/scm'
import SETUP_LUA from '../engine-lua/units.lua?raw'
import BONES_LUA from '../engine-lua/bones.lua?raw'
import BLUEPRINTS_LUA from '../engine-lua/blueprints.lua?raw'

/**
 * Spawnt Units über die Original-Lua-Klassen und exponiert ihren Zustand für
 * Renderer/Sim. Eine Unit entsteht wie in der Engine:
 *   `units/<id>/<id>_script.lua` setzt `TypeClass = <Class>` (leitet von den
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
  /** Mesh blueprint ID if the script called SetMesh */
  mesh: string | null
}


export function installUnitFactory(host: LuaHost): void {
  // The skeleton first: units.lua puts the resting pose on the unit when spawning
  // (u.__bones), and the weapons are already checking their turret bones in OnCreate.
  host.eval(BONES_LUA)
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

/**
 * Alle PROJEKTIL-Blueprints registrieren — über dieselbe Original-Pipeline
 * (`LoadBlueprints()`), die auch die Units nimmt.
 *
 * Sie müssen VOR dem ersten Schuss da sein: eine Waffe ruft mitten im Tick
 * `unit:CreateProjectile(bp.ProjectileId, …)` (weapon.lua:321), und die Engine
 * schlägt den Blueprint in ihrer Map nach — kein Treffer heißt in der Engine
 * „CreateProjectile: Invalid blueprint %s" (Cfile:930793), not “load
 * just after".
 *
 * Die BlueprintId ist der volle kleingeschriebene Pfad MIT `.bp`
 * (SetBackwardsCompatId, Blueprints.lua:104-107) — genau der String, der in
 * `Weapon.ProjectileId` steht.
 *
 * `paths` sind VFS-Pfade ohne führenden Slash (`projectiles/x/x_proj.bp`); die
 * Dateien müssen bereits im Host liegen (der Sim-Worker lädt sie beim Boot).
 * Liefert die Anzahl registrierter Projektil-Blueprints.
 */
export function loadProjectileBlueprints(host: LuaHost, paths: string[]): number {
  const list = paths.map((p) => `'/${p}'`).join(',')
  host.eval(`__bpFiles = { ${list} }; LoadBlueprints()`)
  return Number(host.eval('local n = 0 for _ in pairs(__registered.Projectile) do n = n + 1 end return n'))
}

/** Spawns a unit via its original class; returns unit ID or throws. */
/**
 * Das Skelett eines Blueprints in die Sim geben.
 *
 * Die Engine lädt das Modell einer Unit auch in der SIM, nicht nur im Renderer:
 * Waffentürme (`weapon.lua:67`), Mündungen, Bau- und Effekt-Knochen hängen alle
 * an Knochennamen, und `Unit:ValidateBone` (unit.lua:2751) fragt sie ab. Ohne
 * Skelett bricht schon `Weapon:OnCreate` ab — und damit die halbe Unit.
 */
export function setUnitBones(host: LuaHost, blueprintId: string, bones: SimBone[]): void {
  host.call('__beginBones', blueprintId)
  for (const b of bones) {
    host.call(
      '__addBone',
      b.name,
      b.parent,
      b.position[0],
      b.position[1],
      b.position[2],
      b.rotation[0],
      b.rotation[1],
      b.rotation[2],
      b.rotation[3],
    )
  }
  host.call('__finishBones')
}

/**
 * Ein Knochen, wie ihn die Sim braucht: Name, Elternindex (0-basiert, -1 =
 * Wurzel), Position RELATIV ZUM ELTERN und Rotation als Quaternion (w,x,y,z) —
 * genau die Felder, die in der SCM stehen (src/formats/scm.ts).
 *
 * Nur der Name reicht NICHT: ohne Ruhepose gibt es keine Weltposition der
 * Mündung, und ohne die kein Startpunkt für ein Projektil.
 */
export interface SimBone {
  name: string
  parent: number
  position: [number, number, number]
  rotation: [number, number, number, number]
}

/** The skeleton from a parsed SCM into the form the sim needs. */
export function toSimBones(model: { bones: ScmBone[] }): SimBone[] {
  return model.bones.map((b) => ({
    name: b.name,
    parent: b.parent,
    position: b.position,
    rotation: b.rotation,
  }))
}

/**
 * Die PROP-Blueprints (Wracks: `/props/**.bp`). `Unit:CreateWreckageProp`
 * (unit.lua:1105) ruft `CreateProp(pos, bp.Wreckage.Blueprint)` — ohne
 * registrierten Prop-Blueprint gibt es kein Wrack.
 */
export function loadPropBlueprints(host: LuaHost, paths: string[]): number {
  const list = paths.map((p) => `'/${p}'`).join(',')
  host.eval(`__bpFiles = { ${list} }; LoadBlueprints()`)
  return Number(host.eval('local n = 0 for _ in pairs(__registered.Prop) do n = n + 1 end return n'))
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

/** Reads the current state of a spawned Lua unit. */
export function readLuaUnit(host: LuaHost, id: number): LuaUnitState | null {
  return host.eval(`return __readUnit(${id})`) as LuaUnitState | null
}
