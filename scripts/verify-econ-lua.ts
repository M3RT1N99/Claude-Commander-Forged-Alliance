/**
 * Engine M3: Lua-getriebene Ökonomie. Eine über die Original-Klasse gespawnte
 * Unit klinkt beim Spawn ihre Blueprint-Ökonomie in die per-Armee-Engine-
 * Ökonomie ein; der Beat rechnet die Zwei-Ratio-Verteilung, und
 * `brain:GetEconomyStored(...)` liest das Ergebnis. Der Zwei-Ratio-Kern selbst
 * ist in verify-economy.ts abgedeckt — hier zählt die Lua-Anbindung.
 *
 * (Volle Struktur-OnCreate-Pfade wie Intel/Schild kommen in späteren
 * Meilensteinen; die ACU spawnt bereits vollständig über die Original-Klasse.)
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-econ-lua.ts
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
import { EconomyManager, installEconomy } from '../src/sim/economy'

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
const near = (a: number, b: number, eps = 0.2): boolean => Math.abs(a - b) < eps

const warnings: string[] = []
const host = await LuaHost.create(files, (level, msg) => { if (level === 'WARN') warnings.push(msg) })
const { economy: eco } = installEngine(host)
// Flat test area - EXPLICIT because the engine crashes without a map (no silent 0 value).
setTerrainSource(host, FLAT_TEST_TERRAIN)
loadUnitBlueprint(host, 'uel0001', acuBp)
setUnitBones(host, 'uel0001', await bonesFromBlueprint('uel0001', acuBp, readAsset, assetExists))

const beat = (): void => { eco.tick(); simTick(host) }

console.log('\n== ACU spawnen — registriert ihre Blueprint-Ökonomie (ProdE=20, ProdM=1) ==')
const acu = spawnLuaUnit(host, 'uel0001', { x: 128, y: 20, z: 128 }, 1)
check(acu > 0, `spawned, Unit #${acu}`)
const army = eco.army(1)
check(army.energy === 0 && army.mass === 0, `Army starts at 0/0 (SSTIArmyVariableData-Ctor)`)

console.log('\n== Bearing comes ONLY from the units (ACU: 4000 E / 650 M) ==')
beat()
check(army.maxEnergy === 4000, `maxEnergie = ${army.maxEnergy} (= ACU Economy.StorageEnergy)`)
check(army.maxMass === 650, `maxMasse = ${army.maxMass} (= ACU Economy.StorageMass)`)

console.log('\n== Starting supply: the ACU forks GiveInitialResources (uel0001_script.lua:159) ==')
// OnStopBeingBuilt -> ForkThread(GiveInitialResources) -> WaitTicks(5) ->
// brain:GiveResource('Energy', StorageEnergy) + ('Mass', StorageMass).
// No TS starting value: the original Lua gives the army its own camp.
for (let i = 0; i < 10; i++) beat()
check(army.energy === 4000, `Energy ${army.energy} = full storage (gifted by the ACU)`)
check(army.mass === 650, `Dimensions ${army.mass} = full bearing (gifted by the ACU)`)

console.log('\n== Income from the real blueprint ==')
check(army.incomeEnergy === 20, `Energy Income = ${army.incomeEnergy} (from Blueprint)`)
check(army.incomeMass === 1, `Mass Income = ${army.incomeMass} (from Blueprint)`)
// Empty the stock, then it grows with exactly the blueprint income.
army.energy = 0
for (let i = 0; i < 10; i++) beat()
check(near(army.energy, 20), `Energie nach 1 s ab 0: ${army.energy.toFixed(1)} (= 20/s)`)

console.log('\n== brain:GetEconomyStored / GetEconomyIncome (moho, reads live state) ==')
const brainE = Number(host.eval(`return __units[${acu}]:GetAIBrain():GetEconomyStored('ENERGY')`))
check(near(brainE, army.energy, 0.01), `GetEconomyStored('ENERGY') = ${brainE.toFixed(1)} == ${army.energy.toFixed(1)}`)
// PER TICK, not per second: GetEconomyIncome is a raw field read from
// CEconomy.mTotals (Cfile:739923), filled with ×0.1 per tick
// (HandleResourceManagement, Cfile:954011-954028). The key witness is this
// Original Lua itself: defaultweapons.lua:970 calculates
// `GetEconomyIncome('ENERGY') * 10 # per tick to per seconds`.
const brainInc = Number(host.eval(`return __units[${acu}]:GetAIBrain():GetEconomyIncome('ENERGY')`))
check(near(brainInc, 2.0, 0.001), `GetEconomyIncome('ENERGY') = ${brainInc} (per TICK: 20/s ÷ 10)`)
check(near(brainInc * 10, 20, 0.001), 'the defaultweapons calculation (×10) results in 20/s again')

console.log('\n== SetProductionActive(false): Einkommen stoppt ==')
host.eval(`__units[${acu}]:SetProductionActive(false)`)
beat()
check(army.incomeEnergy === 0, `Energie-Einkommen = ${army.incomeEnergy} nach Abschalten (0)`)
host.eval(`__units[${acu}]:SetProductionActive(true)`)
beat()
check(army.incomeEnergy === 20, `Income back = ${army.incomeEnergy} after switching on again`)

console.log('\n== Stable: Large consumer, stock stuck at 0 (no negative value) ==')
army.energy = 0
army.register(9999, { prodM: 0, prodE: 0, consM: 0, consE: 1000, storeM: 0, storeE: 0, complete: true, prodActive: true, consActive: true })
for (let i = 0; i < 3; i++) beat()
check(army.energy >= 0, `Energie bleibt >= 0 (${army.energy.toFixed(2)})`)
check(army.expenseEnergy > 0 && army.expenseEnergy <= army.incomeEnergy + 0.01, `Output throttled to income (${army.expenseEnergy.toFixed(1)}/s, LimitingRate < 1)`)

if (warnings.length > 0) {
  console.log(`\n${warnings.length} WARN (erste 3):`)
  for (const w of warnings.slice(0, 3)) console.log(`  ${w.slice(0, 110)}`)
}

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nECON-LUA BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
