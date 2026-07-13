/**
 * Engine M4: Bewegung über den Navigator. Eine über die Original-Klasse
 * gespawnte mobile Unit (ACU = TWalkingLandUnit) bekommt via
 * `GetNavigator():SetGoal(...)` ein Ziel; die Physik-Fortschreibung
 * (__advanceMotion, Entity::AdvanceCoords) bewegt sie pro Beat mit den
 * Blueprint-Werten (MaxSpeed/TurnRate/Accel) dorthin.
 *
 *   npx tsx scripts/verify-motion.ts
 */
import { open, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { LuaHost } from '../src/lua/host'
import { installMoho } from '../src/lua/moho'
import { installUnitFactory, installBlueprintPipeline, loadUnitBlueprint, spawnLuaUnit } from '../src/lua/unitFactory'
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
for (const archive of ['mohodata.scd', 'lua.scd']) {
  const file = await NodeFile.open(`${GAME}/gamedata/${archive}`)
  openFiles.push(file)
  const zip = await ZipArchive.open(file)
  for (const [key, entry] of zip.entries) if (key.endsWith('.lua')) files.set(key, await zip.read(entry))
}
const unitsFile = await NodeFile.open(`${GAME}/gamedata/units.scd`)
openFiles.push(unitsFile)
const unitsZip = await ZipArchive.open(unitsFile)
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
host.loadGlobal('/lua/system/utils.lua')
installMoho(host)
installBlueprintPipeline(host)
installUnitFactory(host)
installSimThreads(host)
installMotion(host)
host.installStubTrap(() => {})
loadUnitBlueprint(host, 'uel0001', acuBp)

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

if (warnings.length > 0) {
  console.log(`\n${warnings.length} WARN (erste 3):`)
  for (const w of warnings.slice(0, 3)) console.log(`  ${w.slice(0, 110)}`)
}

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nMOTION BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
