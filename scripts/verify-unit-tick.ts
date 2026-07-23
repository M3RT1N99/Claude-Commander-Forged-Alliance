/**
 * Engine M2: eine über die Original-Klasse gespawnte Unit läuft pro Sim-Beat.
 * OnCreate läuft als Thread; ein ForkThread liest pro Tick den Unit-Zustand
 * über die moho-Methoden — getrieben vom Engine-Beat (__simTick).
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-unit-tick.ts
 */
import { open, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { LuaHost } from '../src/lua/host'
import { bonesFromBlueprint } from './gameFiles'
import { installEngine } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { FLAT_TEST_TERRAIN } from '../src/sim/terrain'
import { installUnitFactory, installBlueprintPipeline, loadUnitBlueprint, spawnLuaUnit, readLuaUnit, setUnitBones } from '../src/lua/unitFactory'
import { installSimThreads, simTick, currentTick } from '../src/lua/simThreads'

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
const uel0001bp = await unitsZip.read(unitsZip.get('units/uel0001/uel0001_unit.bp')!)

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
const num = (h: LuaHost, e: string): number => Number(h.eval(`return ${e}`))

const warnings: string[] = []
const host = await LuaHost.create(files, (level, msg) => { if (level === 'WARN') warnings.push(msg) })
installEngine(host)
// Flat test area - EXPLICIT because the engine crashes without a map (no silent 0 value).
setTerrainSource(host, FLAT_TEST_TERRAIN)
loadUnitBlueprint(host, 'uel0001', uel0001bp)
setUnitBones(host, 'uel0001', await bonesFromBlueprint('uel0001', uel0001bp, readAsset, assetExists))

console.log('\n== Spawn ACU via original class (OnCreate as thread) ==')
const id = spawnLuaUnit(host, 'uel0001', { x: 128, y: 20, z: 128 }, 1)
check(id > 0, `spawned, unit ID ${id}`)
const state = readLuaUnit(host, id)
check(state?.maxHealth === 12000, `maxHealth = ${state?.maxHealth} (from original bp)`)
check(typeof state?.health === 'number' && state.health > 0, `health = ${state?.health} (immediate status set)`)
check(currentTick(host) === 0, `Start tick = ${currentTick(host)} (no beat yet)`)

console.log('\n== Unit thread runs per beat, reads live state via moho ==')
// Monitor thread (stands for cooperative unit logic): reads every tick
// GetHealth() of the spawned unit via the moho-unit method.
host.eval(`mon = 0; monHealth = -1; local u = __units[${id}]
  ForkThread(function() while true do mon = mon + 1; monHealth = u:GetHealth(); WaitTicks(1) end end)`)
for (let i = 0; i < 5; i++) simTick(host)
check(num(host, 'mon') === 5, `Monitor lief 5×: mon = ${num(host, 'mon')}`)
check(num(host, 'monHealth') === 12000, `las Live-Health über moho: ${num(host, 'monHealth')} (12000)`)
check(currentTick(host) === 5, `Tick = ${currentTick(host)} nach 5 Beats`)

console.log('\n== Unit survives the beats (readable further) ==')
const state2 = readLuaUnit(host, id)
check(state2?.maxHealth === 12000, `Unit readable after 5 beats, maxHealth ${state2?.maxHealth}`)

if (warnings.length > 0) {
  console.log(`\n${warnings.length} WARN (erste 4):`)
  for (const w of warnings.slice(0, 4)) console.log(`  ${w.slice(0, 110)}`)
}

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nUNIT-TICK BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
