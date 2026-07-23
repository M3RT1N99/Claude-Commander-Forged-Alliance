/**
 * Engine M5: Bauen über die Lua. Die ACU baut einen Energiegenerator —
 * Baustelle entsteht unfertig, wächst über die binär-verifizierte Formel
 * (delta = buildRate/BuildTime · LimitingRate · 0.1), zieht ihre Kosten über
 * die Zwei-Ratio-Ökonomie, und bei Fertigstellung feuert OnStopBeingBuilt und
 * die Produktion des Generators schaltet sich ein.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-build.ts
 */
import { open, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { LuaHost } from '../src/lua/host'
import { bonesFromBlueprint } from './gameFiles'
import { installEngine } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { FLAT_TEST_TERRAIN } from '../src/sim/terrain'
import { installUnitFactory, installBlueprintPipeline, loadUnitBlueprint, spawnLuaUnit, spawnBuildSite, setUnitBones } from '../src/lua/unitFactory'
import { installSimThreads, simTick } from '../src/lua/simThreads'
import { installMotion, motionTick } from '../src/sim/motion'
import { EconomyManager, installEconomy } from '../src/sim/economy'
import { installBuild, buildCollect, buildApply, issueBuildTask, buildTaskCount } from '../src/sim/build'

class NF implements RandomAccessFile {
  private constructor(private readonly fh: FileHandle, readonly size: number) {}
  static async open(p: string): Promise<NF> { const fh = await open(p, 'r'); return new NF(fh, (await fh.stat()).size) }
  async slice(s: number, e: number): Promise<ArrayBuffer> { const b = Buffer.alloc(e - s); await this.fh.read(b, 0, e - s, s); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
  close(): Promise<void> { return this.fh.close() }
}

const GAME = process.env.CFA_GAME_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'

const openFiles: NF[] = []
const files = new Map<string, Uint8Array>()
for (const a of ['mohodata.scd', 'lua.scd']) {
  const f = await NF.open(`${GAME}/gamedata/${a}`); openFiles.push(f)
  const z = await ZipArchive.open(f)
  for (const [k, e] of z.entries) if (k.endsWith('.lua')) files.set(k, await z.read(e))
}
const uf = await NF.open(`${GAME}/gamedata/units.scd`); openFiles.push(uf)
const uz = await ZipArchive.open(uf)
// The sim also needs the SKELETON of the unit: turrets and muzzles
// depend on bone names (weapon.lua:67). It comes from the same SCM file,
// which the renderer also reads.
const assetExists = (p: string): boolean => uz.get(p.toLowerCase()) != null
const readAsset = async (p: string): Promise<Uint8Array | null> => {
  const e = uz.get(p.toLowerCase())
  return e ? uz.read(e) : null
}
const bps = new Map<string, Uint8Array>()
for (const id of ['uel0001', 'ueb1101']) {
  files.set(`units/${id}/${id}_script.lua`, await uz.read(uz.get(`units/${id}/${id}_script.lua`)!))
  bps.set(id, await uz.read(uz.get(`units/${id}/${id}_unit.bp`)!))
}

let failures = 0
const check = (ok: boolean, label: string): void => { console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`); if (!ok) failures++ }
const near = (a: number, b: number, eps = 0.02): boolean => Math.abs(a - b) < eps

const host = await LuaHost.create(files, () => {})
const { economy: eco } = installEngine(host)
// Flat test area - EXPLICIT because the engine crashes without a map (no silent 0 value).
setTerrainSource(host, FLAT_TEST_TERRAIN)
for (const id of ['uel0001', 'ueb1101']) {
  loadUnitBlueprint(host, id, bps.get(id)!)
  // No weapon can be constructed without a skeleton (weapon.lua:67).
  setUnitBones(host, id, await bonesFromBlueprint(id, bps.get(id)!, readAsset, assetExists))
}

// Beat in original order: Build Needs → Economics → Apply Build → Threads → Physics
const beat = (): void => {
  buildCollect(host)
  eco.tick()
  buildApply(host)
  simTick(host)
  motionTick(host)
}
const num = (e: string): number => Number(host.eval(`return ${e}`))

console.log('\n== ACU builds energy generator (BuildRate 10, BuildTime 125) ==')
const acu = spawnLuaUnit(host, 'uel0001', { x: 10, y: 0, z: 10 }, 1)
const site = spawnBuildSite(host, 'ueb1101', { x: 14, y: 0, z: 10 }, 1) // 4 m entfernt (< MaxBuildDistance 10)
check(acu > 0 && site > 0, `ACU #${acu}, construction site #${site}`)
check(num(`__units[${site}].__fraction`) === 0, 'Construction site starts unfinished (FractionComplete 0)')
check(host.eval(`return __units[${site}]:IsBeingBuilt()`) === true, 'IsBeingBuilt() = true')

const army = eco.army(1)
army.mass = 100000 // plenty of resources for full construction
army.energy = 100000
eco.tick() // Income is only calculated in the tick
check(army.incomeEnergy === 20, `Income before construction = ${army.incomeEnergy}/s (ACU only; construction site contributes nothing)`)

const tid = issueBuildTask(host, acu, site)
check(tid > 0, `Construction order placed (task ${tid})`)

console.log('\n== Fortschritt: delta = BuildRate/BuildTime · rate · 0.1 = 0.008/Tick ==')
beat()
check(near(num(`__units[${site}].__fraction`), 0.008), `nach 1 Beat: fraction ${num(`__units[${site}].__fraction`).toFixed(4)} (erwartet 0.0080)`)
check(num(`__units[${site}].__health`) > 0, `Health grows with construction: ${num(`__units[${site}].__health`).toFixed(1)}`)
// Kosten: BuildCostEnergy 750 · 0.008 = 6/Tick → 60/s
check(near(army.expenseEnergy, 60, 1), `Energie-Ausgabe ${army.expenseEnergy.toFixed(1)}/s (750·0.008/Tick)`)

console.log('\n== Fertigstellung nach BuildTime/BuildRate = 12,5 s (125 Beats) ==')
for (let i = 0; i < 130; i++) beat()
check(near(num(`__units[${site}].__fraction`), 1, 1e-6), `done: fraction = ${num(`__units[${site}].__fraction`)}`)
check(host.eval(`return __units[${site}]:IsBeingBuilt()`) === false, 'IsBeingBuilt() = false nach Fertigstellung')
check(buildTaskCount(host) === 0, 'Construction task removed after completion')
check(army.incomeEnergy === 40, `Generator now produces: Income = ${army.incomeEnergy}/s (ACU 20 + Generator 20)`)
check(near(army.expenseEnergy, 0, 0.01), `no more construction consumption (${army.expenseEnergy.toFixed(2)}/s)`)

console.log('\n== Stall: scarce energy throttles construction (LimitingRate < 1) ==')
const site2 = spawnBuildSite(host, 'ueb1101', { x: 16, y: 0, z: 10 }, 1)
army.energy = 0 // leer; Einkommen 40/s = 4/Tick, Bedarf 6/Tick
issueBuildTask(host, acu, site2)
beat()
const f2 = num(`__units[${site2}].__fraction`)
check(f2 > 0 && f2 < 0.008, `throttled progress: ${f2.toFixed(5)} (< 0.008 at full rate)`)
check(army.energy >= 0, `Energie bleibt >= 0 (${army.energy.toFixed(2)})`)

console.log('\n== Range: Pawn outside MaxBuildDistance -> no progress, runs ==')
const far = spawnBuildSite(host, 'ueb1101', { x: 200, y: 0, z: 10 }, 1) // far away
army.energy = 100000
issueBuildTask(host, acu, far)
const fFar0 = num(`__units[${far}].__fraction`)
beat()
check(num(`__units[${far}].__fraction`) === fFar0, 'out of reach: no construction progress')
check(host.eval(`return __units[${acu}]:IsMoving()`) === true, 'Farmer runs to the goal (approach)')

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nBUILD BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
