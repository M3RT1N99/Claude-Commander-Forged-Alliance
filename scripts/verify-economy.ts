/**
 * Verifiziert die Engine-Ökonomie (src/sim/economy.ts) — die Zwei-Ratio-
 * Verteilung aus func_ArmyProcessEconomy (docs/research/economy-binary.md).
 * Reine Logik, keine Spieldateien. (Der frühere SimWorld-Nachbau wurde
 * entfernt; die Lua-Anbindung deckt verify-econ-lua.ts ab.)
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-economy.ts
 */
import { distribute, ArmyEconomy } from '../src/sim/economy'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
const near = (a: number, b: number, eps = 1e-3): boolean => Math.abs(a - b) < eps

// ── Zwei-Ratio: Masse-Engpass drosselt Doppel-, nicht Einzel-Verbraucher ──
console.log('\n== Zwei-Ratio-Verteilung (r1 Doppel, r2 Einzel) ==')
{
  const both = { mass: 10, energy: 10, rate: 1 } // braucht E und M
  const energyOnly = { mass: 0, energy: 10, rate: 1 } // braucht nur E
  // Masse knapp (5), Energie reichlich (1000)
  const { spentMass } = distribute(5, 1000, [both, energyOnly])
  check(near(both.rate, 0.5), `Doppel-Verbraucher r1 = ${both.rate.toFixed(3)} (Masse-Engpass 5/10)`)
  check(near(energyOnly.rate, 1), `Einzel-Energie-Verbraucher r2 = ${energyOnly.rate.toFixed(3)} (läuft voll)`)
  check(energyOnly.rate > both.rate, 'Einzel-Energie-Verbraucher läuft schneller als der masse-gedrosselte Doppel')
  check(near(spentMass, 5, 1e-2), `Masse-Ausgabe = ${spentMass.toFixed(2)} (nicht mehr als verfügbar)`)
}

// ── Produktion fließt ins Lager (Floating, gedeckelt) ──
console.log('\n== ArmyEconomy: Produktion akkumuliert bis Lagerkapazität ==')
{
  const a = new ArmyEconomy()
  // Wie die ACU: produziert 20 E/s UND bringt 4000 E Lager mit. Ohne Lager
  // gäbe es nichts zu speichern — die Armee selbst hat keinen Sockel
  // (SSTIArmyVariableData-Ctor: mMaxStorage = 0/0).
  a.register(1, { prodM: 0, prodE: 20, consM: 0, consE: 0, storeM: 0, storeE: 4000, complete: true, prodActive: true, consActive: true })
  const e0 = a.energy
  for (let i = 0; i < 10; i++) a.tick()
  check(near(a.energy, e0 + 20, 1e-1), `Energie ${a.energy.toFixed(1)} (Start ${e0} + 20 über 1 s)`)
  check(a.incomeEnergy === 20, `Einkommen = ${a.incomeEnergy}/s`)
  check(a.maxEnergy === 4000, `Lager = ${a.maxEnergy} (nur aus der Unit)`)

  // Ohne Lager-Unit: kein Lager, der Vorrat kann nicht wachsen.
  const b = new ArmyEconomy()
  b.register(1, { prodM: 0, prodE: 20, consM: 0, consE: 0, storeM: 0, storeE: 0, complete: true, prodActive: true, consActive: true })
  for (let i = 0; i < 10; i++) b.tick()
  check(b.energy === 0 && b.maxEnergy === 0, `ohne Lager-Unit: Vorrat ${b.energy}, Lager ${b.maxEnergy}`)
}

// ── Stall: hoher Verbrauch, Vorrat bleibt >= 0, Ausgabe gedrosselt ──
console.log('\n== Stall: Vorrat klemmt bei 0, LimitingRate < 1 ==')
{
  const a = new ArmyEconomy()
  a.energy = 0
  a.register(1, { prodM: 0, prodE: 20, consM: 0, consE: 0, storeM: 0, storeE: 0, complete: true, prodActive: true, consActive: true }) // 20/s Einkommen
  a.register(2, { prodM: 0, prodE: 0, consM: 0, consE: 1000, storeM: 0, storeE: 0, complete: true, prodActive: true, consActive: true }) // 1000/s Bedarf
  for (let i = 0; i < 5; i++) a.tick()
  check(a.energy >= 0, `Energie bleibt >= 0 (${a.energy.toFixed(2)})`)
  check(a.expenseEnergy > 0 && a.expenseEnergy <= a.incomeEnergy + 1e-2, `Ausgabe auf Einkommen gedrosselt (${a.expenseEnergy.toFixed(1)}/s)`)
}

// ── Determinismus ──
console.log('\n== Determinismus (float32, stabile Iteration) ==')
{
  const run = (): string => {
    const a = new ArmyEconomy()
    a.register(1, { prodM: 3, prodE: 25, consM: 0, consE: 2, storeM: 100, storeE: 200, complete: true, prodActive: true, consActive: true })
    for (let i = 0; i < 100; i++) a.tick()
    return `${a.mass}|${a.energy}`
  }
  check(run() === run(), `identische Läufe (${run()})`)
}

console.log(failures === 0 ? '\nECONOMY BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
