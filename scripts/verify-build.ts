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
import { bonesFromBlueprint, bootArchives } from './gameFiles'
import { installEngine } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { FLAT_TEST_TERRAIN, FLAT_TEST_MAP_SIZE } from '../src/sim/terrain'
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
for (const a of ['mohodata.scd', 'lua.scd', ...(await bootArchives())]) {
  const f = await NF.open(`${GAME}/gamedata/${a}`); openFiles.push(f)
  const z = await ZipArchive.open(f)
  for (const [k, e] of z.entries) if (k.endsWith('.lua')) files.set(k, await z.read(e))
}
const uf = await NF.open(`${GAME}/gamedata/units.scd`); openFiles.push(uf)
const uz = await ZipArchive.open(uf)
// Die Sim braucht auch das SKELETT der Unit: Waffentuerme und Muendungen
// haengen an Knochennamen (weapon.lua:67). Es kommt aus derselben SCM-Datei,
// die auch der Renderer liest.
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
// Flaches Testgelaende — EXPLIZIT, weil die Engine ohne Karte knallt (kein stiller 0-Wert).
setTerrainSource(host, FLAT_TEST_TERRAIN, FLAT_TEST_MAP_SIZE)
for (const id of ['uel0001', 'ueb1101']) {
  loadUnitBlueprint(host, id, bps.get(id)!)
  // Ohne Skelett kann keine Waffe aufgebaut werden (weapon.lua:67).
  setUnitBones(host, id, await bonesFromBlueprint(id, bps.get(id)!, readAsset, assetExists))
}

// Beat in Original-Reihenfolge: Bau-Bedarf → Ökonomie → Bau anwenden → Threads → Physik
const beat = (): void => {
  buildCollect(host)
  eco.tick()
  buildApply(host)
  simTick(host)
  motionTick(host)
}
const num = (e: string): number => Number(host.eval(`return ${e}`))

console.log('\n== ACU baut Energiegenerator (BuildRate 10, BuildTime 125) ==')
const acu = spawnLuaUnit(host, 'uel0001', { x: 10, y: 0, z: 10 }, 1)
const site = spawnBuildSite(host, 'ueb1101', { x: 14, y: 0, z: 10 }, 1) // 4 m entfernt (< MaxBuildDistance 10)
check(acu > 0 && site > 0, `ACU #${acu}, Baustelle #${site}`)
check(num(`__units[${site}].__fraction`) === 0, 'Baustelle startet unfertig (FractionComplete 0)')
check(host.eval(`return __units[${site}]:IsBeingBuilt()`) === true, 'IsBeingBuilt() = true')

const army = eco.army(1)
army.mass = 100000 // reichlich Ressourcen für den Voll-Bau
army.energy = 100000
eco.tick() // Einkommen wird erst im Tick berechnet
check(army.incomeEnergy === 20, `Einkommen vor Bau = ${army.incomeEnergy}/s (nur ACU; Baustelle traegt nichts bei)`)

const tid = issueBuildTask(host, acu, site)
check(tid > 0, `Bau-Auftrag erteilt (Task ${tid})`)

console.log('\n== Fortschritt: delta = BuildRate/BuildTime · rate · 0.1 = 0.008/Tick ==')
beat()
check(near(num(`__units[${site}].__fraction`), 0.008), `nach 1 Beat: fraction ${num(`__units[${site}].__fraction`).toFixed(4)} (erwartet 0.0080)`)
check(num(`__units[${site}].__health`) > 0, `Health waechst mit dem Bau: ${num(`__units[${site}].__health`).toFixed(1)}`)
// CBuildTaskHelper::SetFocus makes the site the builder's focus entity before
// OnStartBuild (Cfile:815090-815102); GetFocusUnit answers from it
// (cfunc_UnitGetFocusUnitL, Cfile:972698-972712) and unit.lua:698 needs it for
// the consumption model. GetFocusUnit was a silent no-op returning nil.
check(host.eval(`return __units[${acu}]:GetFocusUnit() == __units[${site}]`) === true, 'GetFocusUnit() is the site while the ACU builds it')
// Kosten: BuildCostEnergy 750 · BuildRate / BuildTime = 60/s -- and that
// figure is the BUILDER'S consumption request, set by the original Lua:
// UpdateConsumptionValues (unit.lua:697-745) prices GetFocusUnit()'s
// blueprint with GetBuildCosts and calls SetConsumptionPerSecondEnergy. The
// engine has no build request of its own (Unit::HandleResourceManagement,
// Cfile:953945-953965 -- the unit's mConsumptionData is the only consumer,
// and its LimitingRate feeds UpdateWorkProgress). This line used to expect
// 61: a TS-side build request (60) PLUS the Lua's floor of 1 (unit.lua:717,
// `energy = 1` when GetFocusUnit was a no-op and nothing could be priced) --
// two stand-ins that added up to a number nobody had derived.
check(near(army.expenseEnergy, 60, 0.5), `Energie-Ausgabe ${army.expenseEnergy.toFixed(1)}/s (the builder's own consumption request: 60)`)

console.log('\n== Fertigstellung nach BuildTime/BuildRate = 12,5 s (125 Beats) ==')
for (let i = 0; i < 130; i++) beat()
check(near(num(`__units[${site}].__fraction`), 1, 1e-6), `fertig: fraction = ${num(`__units[${site}].__fraction`)}`)
check(host.eval(`return __units[${site}]:IsBeingBuilt()`) === false, 'IsBeingBuilt() = false nach Fertigstellung')
check(buildTaskCount(host) === 0, 'Bau-Task nach Fertigstellung entfernt')
check(host.eval(`return __units[${acu}]:GetFocusUnit() == nil`) === true, 'and GetFocusUnit() is nil again after OnStopBuild (Cfile:815022-815030)')
check(army.incomeEnergy === 40, `Generator produziert jetzt: Einkommen = ${army.incomeEnergy}/s (ACU 20 + Generator 20)`)
check(near(army.expenseEnergy, 0, 0.01), `kein Bau-Verbrauch mehr (${army.expenseEnergy.toFixed(2)}/s)`)

console.log('\n== Stall: knappe Energie drosselt den Bau (LimitingRate < 1) ==')
const site2 = spawnBuildSite(host, 'ueb1101', { x: 16, y: 0, z: 10 }, 1)
army.energy = 0 // leer; Einkommen 40/s = 4/Tick, Bedarf 6/Tick
issueBuildTask(host, acu, site2)
beat()
const f2 = num(`__units[${site2}].__fraction`)
check(f2 > 0 && f2 < 0.008, `gedrosselter Fortschritt: ${f2.toFixed(5)} (< 0.008 bei voller Rate)`)
check(army.energy >= 0, `Energie bleibt >= 0 (${army.energy.toFixed(2)})`)

console.log('\n== Reichweite: Bauer ausser MaxBuildDistance -> kein Fortschritt, laeuft hin ==')
const far = spawnBuildSite(host, 'ueb1101', { x: 200, y: 0, z: 10 }, 1) // weit weg
army.energy = 100000
issueBuildTask(host, acu, far)
const fFar0 = num(`__units[${far}].__fraction`)
beat()
check(num(`__units[${far}].__fraction`) === fFar0, 'ausser Reichweite: kein Baufortschritt')
check(host.eval(`return __units[${acu}]:IsMoving()`) === true, 'Bauer laeuft zum Ziel (Approach)')

console.log('\n== Damage to a construction site SURVIVES the next build tick ==')
// Moho::Unit::Materialize (Cfile:953468) ADJUSTS health by maxHealth * delta;
// it does not assign maxHealth * fraction. Assigning healed away every hit a
// site took between ticks, so a construction site was effectively invulnerable
// while a builder worked on it. The positive-delta branch also raises the
// fraction to health/maxHealth (Cfile:953464-953465) — the fraction follows the
// health, never the reverse.
{
  // Own builder: the range test above walked `acu` off to x = 200.
  const acu2 = spawnLuaUnit(host, 'uel0001', { x: 300, y: 0, z: 300 }, 1)
  const site3 = spawnBuildSite(host, 'ueb1101', { x: 304, y: 0, z: 300 }, 1)
  army.mass = 100000
  army.energy = 100000
  issueBuildTask(host, acu2, site3)
  beat()
  const maxH = num(`__units[${site3}]:GetMaxHealth()`)
  const hBefore = num(`__units[${site3}].__health`)
  const fBefore = num(`__units[${site3}].__fraction`)
  check(hBefore > 0, `the site has health after one build beat (${hBefore.toFixed(1)})`)

  // Take a bite out of it, then let exactly one more build tick run.
  const bite = hBefore * 0.5
  host.eval(`__units[${site3}]:AdjustHealth(nil, ${-bite})`)
  const hDamaged = num(`__units[${site3}].__health`)
  check(near(hDamaged, hBefore - bite, 0.01), `damage lands (${hDamaged.toFixed(1)})`)
  beat()
  const hAfter = num(`__units[${site3}].__health`)
  const fAfter = num(`__units[${site3}].__fraction`)
  // One tick adds maxHealth * delta; the damage must still be missing. The
  // reference is an UNDAMAGED site at the same fraction — that is exactly what
  // the old `health = maxHealth * fraction` assignment produced.
  const expected = hDamaged + maxH * (fAfter - fBefore)
  check(
    hAfter < maxH * fAfter - 0.01,
    `the damage is still gone after the build tick (${hAfter.toFixed(1)} < undamaged ${(maxH * fAfter).toFixed(1)} at the same fraction)`,
  )
  check(
    near(hAfter, expected, Math.max(1, maxH * 0.001)),
    `health moved by the fraction delta, not to maxHealth*fraction (${hAfter.toFixed(1)}, want ~${expected.toFixed(1)})`,
  )
}

console.log('\n== Materialize raises the fraction to health/maxHealth, not the reverse ==')
// The positive-delta branch of Moho::Unit::Materialize (Cfile:953458-953466):
//   v4 = min(fraction + delta, 1); if (health / maxHealth > v4) v4 = health / maxHealth
// The health is read BEFORE this tick's AdjustHealth, so an OVER-healed site
// (health/maxH above fraction+delta) pulls the fraction UP to match. Note this
// makes "fraction >= health/maxHealth" NOT an engine invariant: the same tick
// then adds maxH*delta on top, ending with health/maxH = fAfter + delta.
{
  const acu3 = spawnLuaUnit(host, 'uel0001', { x: 340, y: 0, z: 300 }, 1)
  const site4 = spawnBuildSite(host, 'ueb1101', { x: 344, y: 0, z: 300 }, 1)
  army.mass = 100000
  army.energy = 100000
  issueBuildTask(host, acu3, site4)
  beat()
  const maxH4 = num(`__units[${site4}]:GetMaxHealth()`)
  const fPre = num(`__units[${site4}].__fraction`)

  // Heal it well ABOVE maxH * fraction — that is what drives the branch.
  const target = maxH4 * (fPre + 0.20)
  host.eval(`__units[${site4}]:AdjustHealth(nil, ${target - num(`__units[${site4}].__health`)})`)
  const hPre = num(`__units[${site4}].__health`)
  const ratioPre = hPre / maxH4
  check(ratioPre > fPre + 0.1, `site healed above its fraction (${ratioPre.toFixed(4)} vs ${fPre.toFixed(4)})`)

  beat()
  const fPost = num(`__units[${site4}].__fraction`)
  // Without the branch the fraction would be fPre + delta (~fPre + 0.008).
  check(
    fPost > fPre + 0.1,
    `the fraction jumped to the pre-tick health ratio, not fPre+delta (${fPost.toFixed(4)}, fPre+delta ~ ${(fPre + 0.008).toFixed(4)})`,
  )
  check(
    near(fPost, ratioPre, 0.02),
    `and it equals health/maxHealth read BEFORE the tick (${fPost.toFixed(4)} vs ${ratioPre.toFixed(4)})`,
  )
}

console.log('\n== Decay ADJUSTS health too — damage on an abandoned site survives ==')
// __decayTick mirrors Materialize(-0.1 / maxVal) (Cfile:952836) and must ADJUST
// by maxHealth * delta (Cfile:953468), not assign maxHealth * fraction. With the
// assign form a decaying site healed its damage away on every decay tick.
{
  const orphan = spawnBuildSite(host, 'ueb1101', { x: 380, y: 0, z: 300 }, 1)
  // Give it a start: build it up a bit, then abandon it (no build task at all).
  const acu4 = spawnLuaUnit(host, 'uel0001', { x: 376, y: 0, z: 300 }, 1)
  army.mass = 100000
  army.energy = 100000
  const tidO = issueBuildTask(host, acu4, orphan)
  for (let i = 0; i < 20; i++) beat()
  host.eval(`__abortBuildTasks(${acu4})`)
  void tidO
  const maxHO = num(`__units[${orphan}]:GetMaxHealth()`)
  const e = `(__units[${orphan}].__bp.Economy or {})`
  const maxVal = num(`math.max(${e}.BuildCostEnergy or 0, ${e}.BuildCostMass or 0, ${e}.BuildTime or 0)`)
  const step = maxHO * (0.1 / maxVal)

  // Decay only starts once the site has NOT been materialized for more than one
  // tick (build.lua: the engine resets mCreationTick on every Materialize,
  // Cfile:953443). Let that gate open first, so the beat we measure really is a
  // decay beat.
  // This suite's local beat() does not run the decay phase (the engine runs it
  // inside Unit::OnTick, Cfile:952824-952840); call it explicitly.
  const decayBeat = (): void => {
    beat()
    host.eval('__decayTick()')
  }
  const fBeforeDecay = num(`__units[${orphan}].__fraction`)
  for (let i = 0; i < 3; i++) decayBeat()
  check(
    num(`__units[${orphan}].__fraction`) < fBeforeDecay,
    `the abandoned site is decaying (${fBeforeDecay.toFixed(4)} -> ${num(`__units[${orphan}].__fraction`).toFixed(4)})`,
  )

  // Damage it, then let exactly one decay tick run.
  host.eval(`__units[${orphan}]:AdjustHealth(nil, ${-num(`__units[${orphan}].__health`) * 0.5})`)
  const hDam = num(`__units[${orphan}].__health`)
  const fDam = num(`__units[${orphan}].__fraction`)
  check(hDam < maxHO * fDam - 0.01, `abandoned site is damaged below maxH*fraction (${hDam.toFixed(2)} < ${(maxHO * fDam).toFixed(2)})`)

  decayBeat()
  const hDec = num(`__units[${orphan}].__health`)
  check(
    near(hDec, hDam - step, Math.max(0.05, step * 0.05)),
    `decay subtracted maxH*delta from the DAMAGED health (${hDec.toFixed(2)}, want ~${(hDam - step).toFixed(2)}) — not maxH*fraction (${(maxHO * num(`__units[${orphan}].__fraction`)).toFixed(2)})`,
  )
}

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nBUILD BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
