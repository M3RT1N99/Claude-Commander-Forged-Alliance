/**
 * Engine M4: Bewegung über den Navigator. Eine über die Original-Klasse
 * gespawnte mobile Unit (ACU = TWalkingLandUnit) bekommt via
 * `GetNavigator():SetGoal(...)` ein Ziel; die Physik-Fortschreibung
 * (__advanceMotion, Entity::AdvanceCoords) bewegt sie pro Beat mit den
 * Blueprint-Werten (MaxSpeed/TurnRate/Accel) dorthin.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-motion.ts
 */
import { open, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { LuaHost } from '../src/lua/host'
import { bonesFromBlueprint, bootArchives } from './gameFiles'
import { installEngine } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { FLAT_TEST_TERRAIN, FLAT_TEST_MAP_SIZE } from '../src/sim/terrain'
import { installUnitFactory, installBlueprintPipeline, loadUnitBlueprint, spawnLuaUnit, setUnitBones } from '../src/lua/unitFactory'
import { installSimThreads, simTick } from '../src/lua/simThreads'
import { installMotion, motionTick } from '../src/sim/motion'

class NodeFile implements RandomAccessFile {
  private constructor(private readonly fh: FileHandle, readonly size: number) {}
  static async open(p: string): Promise<NodeFile> {
    const fh = await open(p, 'r'); return new NodeFile(fh, (await fh.stat()).size)
  }
  async slice(s: number, e: number): Promise<ArrayBuffer> {
    const b = Buffer.alloc(e - s); await this.fh.read(b, 0, e - s, s)
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  }
  close(): Promise<void> { return this.fh.close() }
}

const GAME =
  process.env.CFA_GAME_DIR ??
  'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'

const files = new Map<string, Uint8Array>()
const openFiles: NodeFile[] = []
for (const archive of ['mohodata.scd', 'lua.scd', ...(await bootArchives())]) {
  const file = await NodeFile.open(`${GAME}/gamedata/${archive}`)
  openFiles.push(file)
  const zip = await ZipArchive.open(file)
  for (const [key, entry] of zip.entries) if (key.endsWith('.lua')) files.set(key, await zip.read(entry))
}
const unitsFile = await NodeFile.open(`${GAME}/gamedata/units.scd`)
openFiles.push(unitsFile)
const unitsZip = await ZipArchive.open(unitsFile)
// Die Sim braucht auch das SKELETT der Unit: Waffentuerme und Muendungen
// haengen an Knochennamen (weapon.lua:67). Es kommt aus derselben SCM-Datei,
// die auch der Renderer liest.
const assetExists = (p: string): boolean => unitsZip.get(p.toLowerCase()) != null
const readAsset = async (p: string): Promise<Uint8Array | null> => {
  const e = unitsZip.get(p.toLowerCase())
  return e ? unitsZip.read(e) : null
}
files.set('units/uel0001/uel0001_script.lua', await unitsZip.read(unitsZip.get('units/uel0001/uel0001_script.lua')!))
const acuBp = await unitsZip.read(unitsZip.get('units/uel0001/uel0001_unit.bp')!)

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
const num = (h: LuaHost, e: string): number => Number(h.eval(`return ${e}`))
const bool = (h: LuaHost, e: string): boolean => h.eval(`return ${e}`) === true

const warnings: string[] = []
const host = await LuaHost.create(files, (level, msg) => { if (level === 'WARN') warnings.push(msg) })
installEngine(host)
// Flaches Testgelaende — EXPLIZIT, weil die Engine ohne Karte knallt (kein stiller 0-Wert).
setTerrainSource(host, FLAT_TEST_TERRAIN, FLAT_TEST_MAP_SIZE)
loadUnitBlueprint(host, 'uel0001', acuBp)
setUnitBones(host, 'uel0001', await bonesFromBlueprint('uel0001', acuBp, readAsset, assetExists))

const beat = (): void => { simTick(host); motionTick(host) }
const maxSpeed = num(host, "(__registered.Unit['uel0001'].Physics and __registered.Unit['uel0001'].Physics.MaxSpeed) or 0")

console.log('\n== ACU spawnen (mobil), Ziel 12 m nach Osten setzen ==')
const id = spawnLuaUnit(host, 'uel0001', { x: 128, y: 20, z: 128 }, 1)
check(id > 0, `gespawnt #${id}, Physics.MaxSpeed = ${maxSpeed}`)
const x0 = num(host, `__units[${id}].__pos[1]`)
host.eval(`__units[${id}]:GetNavigator():SetGoal({ 140, 20, 128 })`)
check(bool(host, `__units[${id}].__goal ~= nil`), 'Ziel gesetzt (SetGoal)')

console.log('\n== Bewegt sich pro Beat Richtung Ziel ==')
for (let i = 0; i < 10; i++) beat()
const x1 = num(host, `__units[${id}].__pos[1]`)
check(x1 > x0 + 0.1, `nach 10 Beats östlicher: x ${x1.toFixed(2)} > Start ${x0.toFixed(2)}`)
check(bool(host, `__units[${id}]:IsMoving()`), 'IsMoving() = true während der Fahrt')
check(num(host, `select(1, __units[${id}]:GetVelocity())`) > 0.01, 'GetVelocity() > 0 während der Fahrt')

console.log('\n== Kommt am Ziel an (Zielradius), stoppt ==')
for (let i = 0; i < 400; i++) {
  beat()
  if (host.eval(`return not __units[${id}].__goal`) === true) break
}
const xf = num(host, `__units[${id}].__pos[1]`)
const zf = num(host, `__units[${id}].__pos[3]`)
check(Math.abs(xf - 140) < 1.5, `am Ziel: x ${xf.toFixed(2)} ≈ 140`)
check(Math.abs(zf - 128) < 1.5, `Spur gehalten: z ${zf.toFixed(2)} ≈ 128`)
check(host.eval(`return not __units[${id}].__goal`) === true, 'Ziel erreicht → Goal geleert')
check(!bool(host, `__units[${id}]:IsMoving()`), 'IsMoving() = false nach Ankunft')

console.log('\n== Die Speed-Cap-Kaskade (sub_699760 @0x699760, Cfile:942291-942328) ==')
// (a) Ziel exakt 90° seitlich in Distanz d: der Bogen-Kreis hat r = d/2 —
// liegt er unter dem TurnRadius, ist der Cap turnRate·|r|·0.5 (GATE 2).
{
  const kid = spawnLuaUnit(host, 'uel0001', { x: 200, y: 20, z: 200 }, 1)
  // ACU-TurnRadius aus dem Blueprint — Ziel seitlich (Heading 0 = +Z, Ziel +X).
  const bpRadius = num(host, `__units[${kid}].__bp.Physics.TurnRadius`)
  const d = Math.min(bpRadius, 4) // r = d/2 < TurnRadius → Gate greift sicher
  host.eval(`__units[${kid}]:GetNavigator():SetGoal({ ${200 + d}, 20, 200 })`)
  // MIT VOLLER FAHRT hinein. Vorher stand hier nur `beat(); beat()` und danach
  // `v <= cap` — nach zwei Beats begrenzt aber die BESCHLEUNIGUNG auf 2·accel,
  // und das liegt weit unter dem Cap. Die Zeile war damit wahr, ob das Gate
  // greift oder nicht: eine Prüfung, die nicht scheitern kann.
  //
  // Von der Höchstgeschwindigkeit aus ist das Cap die bindende Schranke, und
  // die Prüfung wird eine GLEICHHEIT statt einer Schranke.
  const maxSpeed = num(host, `__units[${kid}].__bp.Physics.MaxSpeed or 0`)
  host.eval(`__units[${kid}].__speed = ${maxSpeed}`)
  for (let i = 0; i < 12; i++) beat()
  const vBogen = num(host, `__units[${kid}].__speed or 0`)
  const turnRateTick = num(host, `(__units[${kid}].__bp.Physics.TurnRate or 0) * 0.0017453292`)
  const capErwartet = turnRateTick * (d / 2) * 0.5

  // GEGENPROBE: dieselbe Einheit, dieselbe Anfangsgeschwindigkeit, Ziel
  // GERADEAUS. Ohne Bogen gibt es kein Cap — greift GATE 2, muss der Bogen-Lauf
  // langsamer sein.
  const gid = spawnLuaUnit(host, 'uel0001', { x: 260, y: 20, z: 200 }, 1)
  host.eval(`__units[${gid}]:GetNavigator():SetGoal({ 260, 20, 400 })`)
  host.eval(`__units[${gid}].__speed = ${maxSpeed}`)
  for (let i = 0; i < 12; i++) beat()
  const vGerade = num(host, `__units[${gid}].__speed or 0`)
  host.eval(`__units[${gid}]:GetNavigator():AbortMove()`)

  // OFFENER BEFUND — hier steht mit Absicht KEINE Behauptung.
  //
  // Gemessen (uel0001, MaxSpeed 1.7, MaxBrake 0, TurnRate 90): der 90°-Lauf auf
  // 4 m, der 90°-Lauf auf 200 m und der Lauf geradeaus ergeben Tick für Tick
  // DIESELBE Kurve — 1.683, 1.666, 1.649, … also −1 % je Tick, unabhängig vom
  // Bogen. GATE 2 (`sub_699760`, Cfile:942313-942321) ist bei uns also nicht
  // wirksam, und was die Geschwindigkeit stattdessen abbaut, ist ungeklärt.
  //
  // Vorher stand hier `check(v <= cap)` nach zwei Beats AUS DEM STAND. Da
  // begrenzt die Beschleunigung auf 2·accel, weit unter dem Cap — die Zeile war
  // wahr, ob das Gate greift oder nicht, und hat den Befund elf Monate lang
  // zugedeckt. Sie ist entfernt; die Zahlen stehen im Protokoll, und der Punkt
  // steht in docs/STATUS.md. Eine Behauptung kommt zurück, wenn das
  // Bewegungsmodell geklärt ist.
  console.log(
    `       (a) OFFEN: Bogen ${vBogen.toFixed(3)} vs. geradeaus ${vGerade.toFixed(3)} ` +
      `(Cap wäre ${capErwartet.toFixed(3)}) — GATE 2 ist nicht wirksam, siehe docs/STATUS.md`,
  )
  host.eval(`__units[${kid}]:GetNavigator():AbortMove()`)
}
// (b) Ziel exakt geradeaus: |r| = 0 → kein Bogen-Cap, voller Anlauf.
{
  const kid = spawnLuaUnit(host, 'uel0001', { x: 220, y: 20, z: 200 }, 1)
  host.eval(`__units[${kid}]:GetNavigator():SetGoal({ 220, 20, 260 })`)
  const accel = num(host, `(__units[${kid}].__bp.Physics.MaxAcceleration or 0) * 0.01`)
  beat()
  const v1 = num(host, `__units[${kid}].__speed or 0`)
  check(Math.abs(v1 - accel) < 1e-6, `(b) geradeaus: erster Tick beschleunigt voll (v=${v1.toFixed(4)} = accel/Tick)`)
  host.eval(`__units[${kid}]:GetNavigator():AbortMove()`)
}

// Occupancy at arrival (movement-path.md §6: no pushing — a standing unit
// blocks its cell, the arriving one stops on the next free ogrid cell).
// Without this, factory products stacked on the same roll-off point.
console.log('\n== Belegte Ankunftszelle: keine Stapel ==')
{
  const a = spawnLuaUnit(host, 'uel0001', { x: 300, y: 20, z: 300 }, 1)
  const b = spawnLuaUnit(host, 'uel0001', { x: 310, y: 20, z: 300 }, 1)
  host.eval(`__units[${a}]:GetNavigator():SetGoal({ 305, 20, 320 })`)
  host.eval(`__units[${b}]:GetNavigator():SetGoal({ 305, 20, 320 })`)
  for (let t = 0; t < 200; t++) beat()
  const dist = num(
    host,
    `(function()
      local pa = __units[${a}].__pos
      local pb = __units[${b}].__pos
      local dx, dz = pa[1] - pb[1], pa[3] - pb[3]
      return math.sqrt(dx * dx + dz * dz)
    end)()`,
  )
  const stehen = host.eval(
    `return __units[${a}].__goal == false and __units[${b}].__goal == false`,
  )
  check(
    stehen === true && dist >= 0.9,
    `Beide stehen, ${dist.toFixed(2)} m auseinander (Occupancy statt Stapel)`,
  )
}

console.log('\n== Wasser: nur Water/AmphibiousFloating/Hover schwimmen oben ==')
// CAiPathSpline::Update (Cfile:765808-765823) / ::Generate (Cfile:766391):
// genau diese drei MotionTypes klemmen die Hoehe auf max(Gelaende, Wasser);
// alle anderen — Land, Biped, Amphibious, SurfacingSub — nehmen die ROHE
// Gelaendehoehe. Ein Amphibium LAEUFT deshalb auf dem Seeboden, was
// CUnitMotion::IsOnValidLayer bestaetigt (LAYER_Seabed nur fuer Amphibious,
// Cfile:965960-965975). Enum: Cfile:656550-656583.
{
  // ZUERST die BRUECKE selbst: der Wasserspiegel der Karte erreicht die Sim ueber
  // setTerrainSource (main.ts -> LuaSimClient -> Worker-Boot/Reset ->
  // engineGlobals). Vorher hatte `__setWaterLevel` GAR KEINEN Aufrufer, und
  // genau das war die Luecke — nicht nur die Lua-Regel dahinter. Ohne Wasser
  // steht exakt -10000 (Entity::GetStartingLayer, Cfile:857506-857510).
  setTerrainSource(host, FLAT_TEST_TERRAIN, { width: 256, height: 256 })
  check(
    num(host, '__waterLevel()') === -10000,
    `ohne waterElevation bleibt der Sim-Wasserspiegel -10000 (${num(host, '__waterLevel()')})`,
  )
  setTerrainSource(host, FLAT_TEST_TERRAIN, { width: 256, height: 256, waterElevation: 30 })
  check(
    num(host, '__waterLevel()') === 30,
    `setTerrainSource reicht den Wasserspiegel der Karte durch (${num(host, '__waterLevel()')})`,
  )

  // FLAT_TEST_TERRAIN liefert 0; Wasser darueber auf 30. Die Trennung ist damit
  // eindeutig: Seeboden 0, Wasseroberflaeche 30.
  host.eval(`__setWaterLevel(30)`)
  await (async (): Promise<void> => {
    // Script UND Blueprint UND Skelett — eine Unit braucht alle drei.
    host.addFile(
      'units/ual0101/ual0101_script.lua',
      await unitsZip.read(unitsZip.get('units/ual0101/ual0101_script.lua')!),
    )
    const hoverBp = await unitsZip.read(unitsZip.get('units/ual0101/ual0101_unit.bp')!)
    loadUnitBlueprint(host, 'ual0101', hoverBp)
    setUnitBones(host, 'ual0101', await bonesFromBlueprint('ual0101', hoverBp, readAsset, assetExists))
  })()

  const yOf = (uid: number): number => Number(host.eval(`return __units[${uid}].__pos[2]`))
  const drive = (uid: number, x: number, z: number): void => {
    host.eval(`__units[${uid}]:GetNavigator():SetGoal({ ${x}, 0, ${z} })`)
    for (let i = 0; i < 12; i++) {
      simTick(host)
      motionTick(host)
    }
  }

  // uel0001 ist RULEUMT_Amphibious (uel0001_unit.bp:851) -> Seeboden.
  const walker = spawnLuaUnit(host, 'uel0001', { x: 400, y: 20, z: 400 }, 1)
  drive(walker, 406, 400)
  check(
    Math.abs(yOf(walker)) < 0.01,
    `ein Amphibium bleibt auf dem Seeboden (y=${yOf(walker).toFixed(2)}, Gelaende 0, Wasser 30)`,
  )

  // ual0101 ist RULEUMT_Hover (ual0101_unit.bp:216) -> Wasseroberflaeche.
  const hover = spawnLuaUnit(host, 'ual0101', { x: 440, y: 20, z: 400 }, 1)
  drive(hover, 446, 400)
  check(
    Math.abs(yOf(hover) - 30) < 0.01,
    `ein Hover faehrt auf der Wasseroberflaeche (y=${yOf(hover).toFixed(2)}, Wasser 30)`,
  )

  // Ohne Wasser (-10000) faellt beides auf die Gelaendehoehe zurueck.
  host.eval(`__setWaterLevel(nil)`)
  drive(hover, 452, 400)
  check(
    Math.abs(yOf(hover)) < 0.01,
    `ohne Wasser faehrt auch der Hover auf dem Gelaende (y=${yOf(hover).toFixed(2)})`,
  )
}

console.log('\n== Eine getoetete Einheit faehrt nicht weiter ==')
// CUnitMotion::CalcMoveLand (Cfile:971696-971704), ::CalcMoveWater
// (Cfile:971825-971826) und ::CalcMoveHover (Cfile:971533-971534) beginnen alle
// mit `if (IsDead(mUnit)) { result = 0; }` — eine tote Einheit rechnet GAR keine
// Bewegung. Der Tod ist dabei nicht sofort: DeathThread laeuft ueber mehrere
// Beats (unit.lua:1200-1241).
{
  const posOf = (uid: number): [number, number] => [
    num(host, `__units[${uid}].__pos[1]`),
    num(host, `__units[${uid}].__pos[3]`),
  ]

  // Kontrolle: eine LEBENDE Einheit mit demselben Ziel faehrt wirklich los.
  const alive = spawnLuaUnit(host, 'uel0001', { x: 500, y: 20, z: 500 }, 1)
  host.eval(`__units[${alive}]:GetNavigator():SetGoal({ 520, 0, 500 })`)
  const [ax0] = posOf(alive)
  for (let i = 0; i < 10; i++) beat()
  const [ax1] = posOf(alive)
  check(ax1 > ax0 + 0.1, `Kontrolle: die lebende Einheit faehrt los (${ax0.toFixed(2)} -> ${ax1.toFixed(2)})`)

  const doomed = spawnLuaUnit(host, 'uel0001', { x: 540, y: 20, z: 500 }, 1)
  host.eval(`__units[${doomed}]:GetNavigator():SetGoal({ 560, 0, 500 })`)
  host.eval(`__units[${doomed}]:Kill()`)
  check(host.eval(`return __units[${doomed}].__dead == true`) === true, 'die Einheit ist tot')
  check(host.eval(`return __units[${doomed}].__goal ~= false`) === true, 'ihr Ziel steht noch (die Engine verwirft es nicht)')
  const [dx0, dz0] = posOf(doomed)
  for (let i = 0; i < 10; i++) beat()
  const [dx1, dz1] = posOf(doomed)
  check(
    Math.abs(dx1 - dx0) < 1e-6 && Math.abs(dz1 - dz0) < 1e-6,
    `sie bewegt sich keinen Millimeter (${dx0.toFixed(3)}/${dz0.toFixed(3)} -> ${dx1.toFixed(3)}/${dz1.toFixed(3)})`,
  )
  check(num(host, `__units[${doomed}].__speed or 0`) === 0, 'und ihre Geschwindigkeit ist 0')

  // Und der BEFEHLS-Pfad: dispatch laeuft nur solange !IsDead
  // (IAiCommandDispatchImpl::TaskTick, Cfile:746583-746586). Der laufende
  // Befehl wird also weder vorangetrieben noch abgeschlossen noch entfernt —
  // die Warteschlange bleibt unangetastet, bis __destroyed sie aufraeumt.
  // SetGoal allein reicht dafuer NICHT: es schreibt nur u.__goal und fuellt
  // __orders/__orderActive nie, der Zweig waere also nie betreten worden.
  const queued = spawnLuaUnit(host, 'uel0001', { x: 580, y: 20, z: 500 }, 1)
  host.eval(`__dispatchMove(${queued}, 600, 500, true)`)
  host.eval(`__dispatchMove(${queued}, 620, 500, false)`)
  check(
    host.eval(`return __orderActive[${queued}] ~= nil`) === true,
    'Kontrolle: der Move-Befehl ist ueber den Dispatch-Pfad aktiv',
  )
  const queuedLen = (): number => num(host, `table.getn(__orders[${queued}] or {})`)
  const activeCmd = (): string => String(host.eval(`return tostring(__orderActive[${queued}])`))
  const lenBefore = queuedLen()
  const cmdBefore = activeCmd()
  host.eval(`__units[${queued}]:Kill()`)
  for (let i = 0; i < 15; i++) beat()
  check(
    activeCmd() === cmdBefore,
    'der laufende Befehl wird nicht abgeschlossen und nicht ersetzt',
  )
  check(
    queuedLen() === lenBefore,
    `die Warteschlange bleibt unveraendert (${lenBefore} -> ${queuedLen()})`,
  )
}

if (warnings.length > 0) {
  console.log(`\n${warnings.length} WARN (erste 3):`)
  for (const w of warnings.slice(0, 3)) console.log(`  ${w.slice(0, 110)}`)
}

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nMOTION BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
