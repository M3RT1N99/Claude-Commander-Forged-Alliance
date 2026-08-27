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
const near = (a: number, b: number, eps = 0.2): boolean => Math.abs(a - b) < eps

const warnings: string[] = []
const host = await LuaHost.create(files, (level, msg) => { if (level === 'WARN') warnings.push(msg) })
const { economy: eco } = installEngine(host)
// Flaches Testgelaende — EXPLIZIT, weil die Engine ohne Karte knallt (kein stiller 0-Wert).
setTerrainSource(host, FLAT_TEST_TERRAIN)
loadUnitBlueprint(host, 'uel0001', acuBp)
setUnitBones(host, 'uel0001', await bonesFromBlueprint('uel0001', acuBp, readAsset, assetExists))

const beat = (): void => { eco.tick(); simTick(host) }

console.log('\n== ACU spawnen — registriert ihre Blueprint-Ökonomie (ProdE=20, ProdM=1) ==')
const acu = spawnLuaUnit(host, 'uel0001', { x: 128, y: 20, z: 128 }, 1)
check(acu > 0, `gespawnt, Unit #${acu}`)
const army = eco.army(1)
check(army.energy === 0 && army.mass === 0, `Armee startet bei 0/0 (SSTIArmyVariableData-Ctor)`)

console.log('\n== Lager kommt AUSSCHLIESSLICH aus den Units (ACU: 4000 E / 650 M) ==')
beat()
check(army.maxEnergy === 4000, `maxEnergie = ${army.maxEnergy} (= ACU Economy.StorageEnergy)`)
check(army.maxMass === 650, `maxMasse = ${army.maxMass} (= ACU Economy.StorageMass)`)

console.log('\n== Startvorrat: die ACU forkt GiveInitialResources (uel0001_script.lua:159) ==')
// OnStopBeingBuilt -> ForkThread(GiveInitialResources) -> WaitTicks(5) ->
// brain:GiveResource('Energy', StorageEnergy) + ('Mass', StorageMass).
// Kein TS-Startwert: die Original-Lua schenkt der Armee ihr eigenes Lager.
for (let i = 0; i < 10; i++) beat()
check(army.energy === 4000, `Energie ${army.energy} = volles Lager (von der ACU geschenkt)`)
check(army.mass === 650, `Masse ${army.mass} = volles Lager (von der ACU geschenkt)`)

console.log('\n== Einkommen aus dem echten Blueprint ==')
check(army.incomeEnergy === 20, `Energie-Einkommen = ${army.incomeEnergy} (aus Blueprint)`)
check(army.incomeMass === 1, `Masse-Einkommen = ${army.incomeMass} (aus Blueprint)`)
// Vorrat leeren, dann wächst er mit genau dem Blueprint-Einkommen.
army.energy = 0
for (let i = 0; i < 10; i++) beat()
check(near(army.energy, 20), `Energie nach 1 s ab 0: ${army.energy.toFixed(1)} (= 20/s)`)

console.log('\n== brain:GetEconomyStored / GetEconomyIncome (moho, liest Live-Zustand) ==')
const brainE = Number(host.eval(`return __units[${acu}]:GetAIBrain():GetEconomyStored('ENERGY')`))
check(near(brainE, army.energy, 0.01), `GetEconomyStored('ENERGY') = ${brainE.toFixed(1)} == ${army.energy.toFixed(1)}`)
// PER TICK, nicht pro Sekunde: GetEconomyIncome ist ein roher Feld-Read aus
// CEconomy.mTotals (Cfile:739923), befüllt pro Tick mit ×0.1
// (HandleResourceManagement, Cfile:954011-954028). Der Kronzeuge ist die
// Original-Lua selbst: defaultweapons.lua:970 rechnet
// `GetEconomyIncome('ENERGY') * 10 # per tick to per seconds`.
const brainInc = Number(host.eval(`return __units[${acu}]:GetAIBrain():GetEconomyIncome('ENERGY')`))
check(near(brainInc, 2.0, 0.001), `GetEconomyIncome('ENERGY') = ${brainInc} (pro TICK: 20/s ÷ 10)`)
check(near(brainInc * 10, 20, 0.001), 'die defaultweapons-Rechnung (×10) ergibt wieder 20/s')

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

console.log('\n== GetResourceConsumed reports the REAL granted rate ==')
// mResourceConsumed is reset to 0 every tick (Cfile:953937) and set to
// CEconRequest::LimitingRate only while alive + consumption active + a request
// exists (Cfile:953945-953948). LimitingRate = 1.0 for an empty request,
// min(granted/requested) otherwise (Cfile:1107891-1107909). It used to return a
// flat 1, so nothing throttled during an energy stall.
const consumed = (): number =>
  Number(host.eval(`return __units[${acu}]:GetResourceConsumed()`))

// The 1000/s consumer registered above is still stalling the army.
host.eval(`__units[${acu}]:SetConsumptionPerSecondEnergy(500)`)
host.eval(`__units[${acu}]:SetConsumptionActive(true)`)
army.energy = 0
for (let i = 0; i < 3; i++) beat()
const stalledRate = consumed()
check(stalledRate > 0 && stalledRate < 1, `during a stall the rate is partial (${stalledRate.toFixed(3)})`)

// Consumption switched off -> 0, not 1 (idle is not "fully supplied").
host.eval(`__units[${acu}]:SetConsumptionActive(false)`)
beat()
check(consumed() === 0, `consumption off reports 0 (${consumed()})`)

// Plenty of supply and a live request -> full rate.
host.eval(`__units[${acu}]:SetConsumptionActive(true)`)
army.remove(9999)
army.energy = 100000
for (let i = 0; i < 3; i++) beat()
check(near(consumed(), 1, 0.001), `with supply to spare the rate is 1 (${consumed().toFixed(3)})`)

// No request at all -> LimitingRate of an empty request = 1.
host.eval(`__units[${acu}]:SetConsumptionPerSecondEnergy(0)`)
beat()
check(consumed() === 1, `an empty request reports 1 (${consumed()})`)

console.log('\n== TakeResource drains STORAGE, clamps, and returns what it took ==')
// cfunc_CAiBrainTakeResourceL (Cfile:735173-735270) is a different function
// from GiveResource, not its mirror: it works on mTotals.mStored instead of the
// income accumulator, takes min(requested, stored), writes back
// max(0, stored - taken) and returns the taken amount (help string
// "taken = TakeResource(type,amount)", Cfile:735162).
const takeCall = (res: string, amount: number): number =>
  Number(host.eval(`return __units[${acu}]:GetAIBrain():TakeResource('${res}', ${amount})`))
army.mass = 500
const took = takeCall('MASS', 200)
check(took === 200, `it RETURNS the taken amount (got ${took}, want 200)`)
check(army.mass === 300, `and storage dropped immediately, not next beat (${army.mass}, want 300)`)

const tookAll = takeCall('MASS', 1000)
check(tookAll === 300, `a request larger than storage takes only what is there (${tookAll}, want 300)`)
check(army.mass === 0, `storage lands at 0, never negative (${army.mass})`)

// The simutils.lua:152-155 shape: massTaken = from:TakeResource(...) ->
// to:GiveResource('Mass', massTaken). With TakeResource returning nil this fed
// `undefined` into the accumulator and NaN'd the recipient's whole economy.
army.mass = 400
const moved = takeCall('MASS', 250)
host.eval(`__units[${acu}]:GetAIBrain():GiveResource('MASS', ${moved})`)
beat()
check(Number.isFinite(army.mass), `the give-back stays a finite number (${army.mass})`)
// 400 + one beat of the ACU's own 1 mass/s production (0.1). The point of the
// check is that nothing is LOST or NaN'd in the round trip.
check(near(army.mass, 400.1, 0.01), `take-then-give conserves the total (${army.mass.toFixed(2)}, want 400 + one beat of ACU income)`)

// A take does NOT touch the income accumulator (that is GiveResource's target,
// Cfile:735044-735053) — income must stay the blueprint's 20/s.
army.energy = 1000
takeCall('ENERGY', 100)
beat()
check(army.incomeEnergy === 20, `a take leaves income untouched (${army.incomeEnergy}/s, want 20)`)

// LAST: this kills the ACU, so nothing below may depend on it.
console.log('\n== A dead unit stops producing and consuming immediately ==')
// Unit::HandleResourceManagement gates BOTH halves on IsDead: consumption at
// Cfile:953945, production at Cfile:953968. Entity::Kill sets mIsDead
// (Cfile:916084) and the DeathThread then runs for several beats
// (unit.lua:1200-1241) — so waiting for OnDestroy let a dead producer keep
// paying out the whole time.
{
  host.eval(`__units[${acu}]:SetConsumptionPerSecondEnergy(0)`)
  army.energy = 100000
  beat()
  check(army.incomeEnergy === 20, `the living ACU produces 20/s (${army.incomeEnergy})`)

  host.eval(`__units[${acu}]:Kill()`)
  check(host.eval(`return __units[${acu}].__dead == true`) === true, 'the ACU is dead')
  check(
    host.eval(`return __units[${acu}].__destroyed ~= true`) === true,
    'but not destroyed yet — the DeathThread is still running',
  )
  beat()
  check(army.incomeEnergy === 0, `its production stops in the same beat (${army.incomeEnergy}/s, want 0)`)
  check(
    Number(host.eval(`return __units[${acu}]:GetResourceConsumed()`)) === 0,
    `and GetResourceConsumed reports 0 for it (${host.eval(`return __units[${acu}]:GetResourceConsumed()`)})`,
  )
}

if (warnings.length > 0) {
  console.log(`\n${warnings.length} WARN (erste 3):`)
  for (const w of warnings.slice(0, 3)) console.log(`  ${w.slice(0, 110)}`)
}

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nECON-LUA BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
