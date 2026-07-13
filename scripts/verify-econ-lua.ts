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
 *   npx tsx scripts/verify-econ-lua.ts
 */
import { open, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { LuaHost } from '../src/lua/host'
import { installMoho } from '../src/lua/moho'
import { installUnitFactory, installBlueprintPipeline, loadUnitBlueprint, spawnLuaUnit } from '../src/lua/unitFactory'
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
host.loadGlobal('/lua/system/utils.lua')
installMoho(host)
installBlueprintPipeline(host)
installUnitFactory(host)
installSimThreads(host)
const eco = new EconomyManager()
installEconomy(host, eco)
host.installStubTrap(() => {})
loadUnitBlueprint(host, 'uel0001', acuBp)

const beat = (): void => { eco.tick(); simTick(host) }

console.log('\n== ACU spawnen — registriert ihre Blueprint-Ökonomie (ProdE=20, ProdM=1) ==')
const acu = spawnLuaUnit(host, 'uel0001', { x: 128, y: 20, z: 128 }, 1)
check(acu > 0, `gespawnt, Unit #${acu}`)
const army = eco.army(1)
const e0 = army.energy
const m0 = army.mass

console.log('\n== 10 Beats: Vorrat wächst über die echten Blueprint-Werte ==')
for (let i = 0; i < 10; i++) beat()
check(near(army.energy, e0 + 20), `Energie ${army.energy.toFixed(1)} (Start ${e0} + 20: ACU 20/s über 1 s)`)
check(near(army.mass, m0 + 1), `Masse ${army.mass.toFixed(1)} (Start ${m0} + 1: ACU 1/s)`)
check(army.incomeEnergy === 20, `Energie-Einkommen = ${army.incomeEnergy} (aus Blueprint)`)
check(army.incomeMass === 1, `Masse-Einkommen = ${army.incomeMass} (aus Blueprint)`)

console.log('\n== brain:GetEconomyStored / GetEconomyIncome (moho, liest Live-Zustand) ==')
const brainE = Number(host.eval(`return __units[${acu}]:GetAIBrain():GetEconomyStored('ENERGY')`))
check(near(brainE, army.energy, 0.01), `GetEconomyStored('ENERGY') = ${brainE.toFixed(1)} == ${army.energy.toFixed(1)}`)
const brainInc = Number(host.eval(`return __units[${acu}]:GetAIBrain():GetEconomyIncome('ENERGY')`))
check(brainInc === 20, `GetEconomyIncome('ENERGY') = ${brainInc}`)

console.log('\n== SetProductionActive(false): Einkommen stoppt ==')
host.eval(`__units[${acu}]:SetProductionActive(false)`)
beat()
check(army.incomeEnergy === 0, `Energie-Einkommen = ${army.incomeEnergy} nach Abschalten (0)`)
host.eval(`__units[${acu}]:SetProductionActive(true)`)
beat()
check(army.incomeEnergy === 20, `Einkommen zurück = ${army.incomeEnergy} nach Wiederanschalten`)

console.log('\n== Stall: Groß-Verbraucher, Vorrat klemmt bei 0 (kein negativer Wert) ==')
army.energy = 0
army.register(9999, { prodM: 0, prodE: 0, consM: 0, consE: 1000, storeM: 0, storeE: 0, complete: true, prodActive: true, consActive: true })
for (let i = 0; i < 3; i++) beat()
check(army.energy >= 0, `Energie bleibt >= 0 (${army.energy.toFixed(2)})`)
check(army.expenseEnergy > 0 && army.expenseEnergy <= army.incomeEnergy + 0.01, `Ausgabe auf Einkommen gedrosselt (${army.expenseEnergy.toFixed(1)}/s, LimitingRate < 1)`)

if (warnings.length > 0) {
  console.log(`\n${warnings.length} WARN (erste 3):`)
  for (const w of warnings.slice(0, 3)) console.log(`  ${w.slice(0, 110)}`)
}

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nECON-LUA BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
