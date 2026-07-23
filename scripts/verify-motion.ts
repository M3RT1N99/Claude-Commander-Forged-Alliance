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
import { bonesFromBlueprint } from './gameFiles'
import { installEngine } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { FLAT_TEST_TERRAIN } from '../src/sim/terrain'
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
for (const archive of ['mohodata.scd', 'lua.scd']) {
  const file = await NodeFile.open(`${GAME}/gamedata/${archive}`)
  openFiles.push(file)
  const zip = await ZipArchive.open(file)
  for (const [key, entry] of zip.entries) if (key.endsWith('.lua')) files.set(key, await zip.read(entry))
}
const unitsFile = await NodeFile.open(`${GAME}/gamedata/units.scd`)
openFiles.push(unitsFile)
const unitsZip = await ZipArchive.open(unitsFile)
// The sim also needs the SKELETON of the unit: turrets and muzzles
// depend on bone names (weapon.lua:67). It comes from the same SCM file,
// which the renderer also reads.
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
// Flat test area - EXPLICIT because the engine crashes without a map (no silent 0 value).
setTerrainSource(host, FLAT_TEST_TERRAIN)
loadUnitBlueprint(host, 'uel0001', acuBp)
setUnitBones(host, 'uel0001', await bonesFromBlueprint('uel0001', acuBp, readAsset, assetExists))

const beat = (): void => { simTick(host); motionTick(host) }
const maxSpeed = num(host, "(__registered.Unit['uel0001'].Physics and __registered.Unit['uel0001'].Physics.MaxSpeed) or 0")

console.log('\n== Spawn ACU (mobile), set target 12 m to the east ==')
const id = spawnLuaUnit(host, 'uel0001', { x: 128, y: 20, z: 128 }, 1)
check(id > 0, `gespawnt #${id}, Physics.MaxSpeed = ${maxSpeed}`)
const x0 = num(host, `__units[${id}].__pos[1]`)
host.eval(`__units[${id}]:GetNavigator():SetGoal({ 140, 20, 128 })`)
check(bool(host, `__units[${id}].__goal ~= nil`), 'Goal set (SetGoal)')

console.log('\n== Moves towards target == per beat')
for (let i = 0; i < 10; i++) beat()
const x1 = num(host, `__units[${id}].__pos[1]`)
check(x1 > x0 + 0.1, `nach 10 Beats östlicher: x ${x1.toFixed(2)} > Start ${x0.toFixed(2)}`)
check(bool(host, `__units[${id}]:IsMoving()`), 'IsMoving() = true while driving')
check(num(host, `select(1, __units[${id}]:GetVelocity())`) > 0.01, 'GetVelocity() > 0 while driving')

console.log('\n== Arrives at the target (target radius), stops ==')
for (let i = 0; i < 400; i++) {
  beat()
  if (host.eval(`return not __units[${id}].__goal`) === true) break
}
const xf = num(host, `__units[${id}].__pos[1]`)
const zf = num(host, `__units[${id}].__pos[3]`)
check(Math.abs(xf - 140) < 1.5, `at the destination: x ${xf.toFixed(2)} ≈ 140`)
check(Math.abs(zf - 128) < 1.5, `Spur gehalten: z ${zf.toFixed(2)} ≈ 128`)
check(host.eval(`return not __units[${id}].__goal`) === true, 'Goal achieved → Goal emptied')
check(!bool(host, `__units[${id}]:IsMoving()`), 'IsMoving() = false nach Ankunft')

console.log('\n== The speed cap cascade (sub_699760 @0x699760, Cfile:942291-942328) ==')
// (a) Target exactly 90° to the side at distance d: the arc-circle has r = d/2 —
// if it is below the TurnRadius, the cap is turnRate·|r|·0.5 (GATE 2).
{
  const kid = spawnLuaUnit(host, 'uel0001', { x: 200, y: 20, z: 200 }, 1)
  // ACU-TurnRadius from the blueprint — target sideways (Heading 0 = +Z, target +X).
  const bpRadius = num(host, `__units[${kid}].__bp.Physics.TurnRadius`)
  const d = Math.min(bpRadius, 4) // r = d/2 < TurnRadius → Gate greift sicher
  host.eval(`__units[${kid}]:GetNavigator():SetGoal({ ${200 + d}, 20, 200 })`)
  beat()
  beat()
  const v = num(host, `__units[${kid}].__speed or 0`)
  const turnRateTick = num(host, `(__units[${kid}].__bp.Physics.TurnRate or 0) * 0.0017453292`)
  const capErwartet = turnRateTick * (d / 2) * 0.5
  check(
    v <= capErwartet + 1e-6,
    `(a) 90° target in ${d} m: v=${v.toFixed(4)} ≤ turnRate·(d/2)·0.5 = ${capErwartet.toFixed(4)} m/tick`,
  )
  host.eval(`__units[${kid}]:GetNavigator():AbortMove()`)
}
// (b) Aim exactly straight ahead: |r| = 0 → no arc cap, full start-up.
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
console.log('\n== Occupied arrival cell: no stacks ==')
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
    `Both stand, ${dist.toFixed(2)} m apart (occupancy instead of stack)`,
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
