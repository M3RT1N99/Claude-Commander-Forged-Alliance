/**
 * Verifiziert die Zwei-Ratio-Floating-Economy in src/sim/simWorld.ts gegen
 * den binär-verifizierten Algorithmus (func_ArmyProcessEconomy @0x771B50,
 * docs/research/economy-binary.md). Reine Sim-Logik, keine Spieldateien.
 *
 *   npx tsx scripts/verify-economy.ts
 */
import { SimWorld, type UnitStats } from '../src/sim/simWorld'

const SIM_DT = 0.1

/** UnitStats mit neutralen Defaults; nur die relevanten Felder überschreiben. */
function stats(over: Partial<UnitStats>): UnitStats {
  return {
    blueprintId: 'test',
    maxSpeed: 0,
    turnRate: 0,
    acceleration: 0,
    brake: 0,
    arriveRadius: 0.5,
    maxHealth: 1000,
    massProduction: 0,
    energyProduction: 0,
    massConsumption: 0,
    energyConsumption: 0,
    massStorage: 0,
    energyStorage: 0,
    buildCostMass: 0,
    buildCostEnergy: 0,
    buildTime: 1,
    ...over,
  }
}

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
const near = (a: number, b: number, eps = 1e-4): boolean => Math.abs(a - b) < eps

// ── 1. Zwei-Ratio-Split: Masse ist Engpass, reiner Energie-Bau läuft voll ──
console.log('\n== Zwei-Ratio: Masse-Engpass drosselt Doppel-, nicht Einzel-Verbraucher ==')
{
  const w = new SimWorld()
  // Doppel-Verbraucher: braucht Masse UND Energie (buildTime 10 → step 0.1/Tick,
  // per-Tick-Nachfrage: Masse 10, Energie 10)
  const both = w.spawn(stats({ buildCostMass: 100, buildCostEnergy: 100, buildTime: 10 }), 0, 0)
  both.buildProgress = 0
  both.health = 0
  // Einzel-Verbraucher: braucht NUR Energie (per-Tick-Nachfrage: Energie 10)
  const energyOnly = w.spawn(stats({ buildCostMass: 0, buildCostEnergy: 100, buildTime: 10 }), 0, 0)
  energyOnly.buildProgress = 0
  energyOnly.health = 0

  const army = w.army(1)
  army.mass = 5 // knapp (Nachfrage 10 → r1 = 0.5)
  army.energy = 1000 // reichlich

  w.tick()

  check(near(both.buildProgress, 0.05), `Doppel-Bau: r1=0.5 → Fortschritt ${both.buildProgress.toFixed(4)} (erwartet 0.0500)`)
  check(near(energyOnly.buildProgress, 0.1), `Energie-Bau: r2=1 → Fortschritt ${energyOnly.buildProgress.toFixed(4)} (erwartet 0.1000)`)
  check(
    energyOnly.buildProgress > both.buildProgress,
    'Einzel-Energie-Verbraucher läuft schneller als der masse-gedrosselte Doppel-Verbraucher',
  )
  // Buchhaltung: Ausgabe = tatsächlich gewährt (mLastUseActual), pro Sekunde
  check(near(army.massExpense, 50, 1e-2), `massExpense = ${army.massExpense.toFixed(2)}/s (gewährt 5/Tick → 50/s)`)
  check(near(army.energyExpense, 150, 1e-2), `energyExpense = ${army.energyExpense.toFixed(2)}/s (gewährt 15/Tick → 150/s)`)
  check(army.mass >= 0 && army.energy >= 0, `Vorrat nie negativ (M ${army.mass.toFixed(2)}, E ${army.energy.toFixed(2)})`)
}

// ── 2. Reiner Produzent akkumuliert bis zur Lagerkapazität ──
console.log('\n== Produktion fließt ins Lager (Floating, gedeckelt) ==')
{
  const w = new SimWorld()
  w.spawn(stats({ energyProduction: 20 }), 0, 0) // fertiger Energiegenerator (+20/s)
  const army = w.army(1)
  const startEnergy = army.energy // 400
  w.tick()
  check(near(army.energyIncome, 20), `energyIncome = ${army.energyIncome} (Produktion 20/s)`)
  check(near(army.energy, startEnergy + 20 * SIM_DT, 1e-2), `Energie +2/Tick: ${army.energy.toFixed(2)} (erwartet ${(startEnergy + 2).toFixed(2)})`)
  for (let i = 0; i < 9; i++) w.tick() // insgesamt 10 Ticks = 1 s
  check(near(army.energy, startEnergy + 20 * 1, 1e-1), `nach 1 s: ${army.energy.toFixed(2)} (erwartet ${(startEnergy + 20).toFixed(2)})`)
}

// ── 3. Harter Stall: Lager bleibt in [0, Kapazität], nie negativ/Overflow ──
console.log('\n== Harter Stall: Vorrat bleibt in [0, Lagerkapazität] ==')
{
  const w = new SimWorld()
  // riesiger Bau mit winzigem Vorrat → dauerhafte Drosselung
  const big = w.spawn(stats({ buildCostMass: 100000, buildCostEnergy: 100000, buildTime: 1 }), 0, 0)
  big.buildProgress = 0
  big.health = 0
  const army = w.army(1)
  let ok = true
  for (let i = 0; i < 50; i++) {
    w.tick()
    if (army.mass < 0 || army.energy < 0) ok = false
    if (army.mass > army.massStorage + 1e-3 || army.energy > army.energyStorage + 1e-3) ok = false
  }
  check(ok, `50 Ticks: Vorrat stets in Grenzen (M ${army.mass.toFixed(1)}/${army.massStorage}, E ${army.energy.toFixed(1)}/${army.energyStorage})`)
  check(big.buildProgress > 0 && big.buildProgress < 1, `Bau macht Teilfortschritt trotz Stall: ${big.buildProgress.toFixed(4)}`)
}

// ── 4. Determinismus: zwei identische Läufe ergeben bit-gleiche Zustände ──
console.log('\n== Determinismus: identische Läufe → identischer Endzustand ==')
{
  const run = (): string => {
    const w = new SimWorld()
    const u = w.spawn(stats({ buildCostMass: 500, buildCostEnergy: 800, buildTime: 20, maxHealth: 3000 }), 0, 0)
    u.buildProgress = 0
    u.health = 0
    w.spawn(stats({ massProduction: 3, energyProduction: 25 }), 0, 0)
    for (let i = 0; i < 100; i++) w.tick()
    const a = w.army(1)
    return `${u.buildProgress}|${u.health}|${a.mass}|${a.energy}`
  }
  check(run() === run(), `Endzustände identisch (${run()})`)
}

console.log(failures === 0 ? '\nECONOMY BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
