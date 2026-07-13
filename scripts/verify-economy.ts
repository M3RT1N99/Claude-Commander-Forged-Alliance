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
    buildRate: 0,
    maxBuildDistance: 0,
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

// ── 5. Produktion ist bedingungslos (Engine koppelt sie NICHT an die Ratio) ──
// Binär belegt: func_ArmyProcessEconomy verteilt nur an Verbraucher; passive
// Produktion läuft bei Stall voll weiter. Dieser Test sichert die verifizierte
// Wahrheit ab — ein energie-gestallter Masse-Extraktor produziert VOLLE Masse.
console.log('\n== Produktion bedingungslos: Masse-Extraktor produziert bei Energie-Stall voll ==')
{
  const w = new SimWorld()
  w.spawn(stats({ massProduction: 2, energyConsumption: 2 }), 0, 0) // wie ueb1103
  const army = w.army(1)
  army.energy = 0 // harter Energie-Stall, kein Energieproduzent
  army.mass = 0
  w.tick()
  check(near(army.massIncome, 2), `massIncome = ${army.massIncome} trotz 0 Energie (Produktion bedingungslos)`)
  check(near(army.mass, 0.2), `Masse +0.2/Tick trotz ungewährter Maintenance: ${army.mass.toFixed(3)}`)
  check(near(army.energy, 0), `Energie bleibt 0 (Maintenance nicht gewährt, r1=0): ${army.energy.toFixed(3)}`)
  check(near(army.energyExpense, 0), `energyExpense = ${army.energyExpense} (nichts gewährt bei leerem Pool)`)
}

// ── 6. Overflow-Sharing: Waterfilling an Verbündete mit freiem Lager ──
console.log('\n== Overflow-Sharing: Waterfilling an Verbündete (aufsteigende Reihenfolge) ==')
{
  const w = new SimWorld()
  w.setAlliance(1, 2)
  w.setAlliance(1, 3) // Armee 1 ist mit 2 und 3 verbündet
  const a = w.army(1)
  const b = w.army(2)
  const c = w.army(3)
  a.resourceSharing = true
  a.mass = 1000 // Overflow = 1000 − 650 (Basis-Lager) = 350
  b.mass = 600 // freies Lager 50
  c.mass = 0 // freies Lager 650
  a.tick([], 1, w)
  check(near(b.incomeCarryMass, 50), `Ally 2 erhält min(share 175, room 50) = ${b.incomeCarryMass.toFixed(2)}`)
  check(near(c.incomeCarryMass, 300), `Ally 3 erhält Rest 300/1 = ${c.incomeCarryMass.toFixed(2)}`)
  check(near(a.mass, 650), `Geber klemmt auf Lagerkapazität: ${a.mass.toFixed(2)}`)
}

console.log('\n== Overflow ohne Sharing / volle Allys überspringen ==')
{
  // (a) kein Sharing → Overflow verloren, niemand bekommt etwas
  const w1 = new SimWorld()
  w1.setAlliance(1, 2)
  w1.army(1).resourceSharing = false
  w1.army(1).mass = 1000
  w1.army(1).tick([], 1, w1)
  check(near(w1.army(1).mass, 650), `ohne Sharing: Geber klemmt auf 650 (${w1.army(1).mass.toFixed(1)})`)
  check(near(w1.army(2).incomeCarryMass, 0), `ohne Sharing: Ally bekommt nichts (${w1.army(2).incomeCarryMass})`)

  // (b) voller Ally (beide Lanes) wird übersprungen, Rest fließt an den nächsten
  const w2 = new SimWorld()
  w2.setAlliance(1, 2)
  w2.setAlliance(1, 3)
  w2.army(1).resourceSharing = true
  w2.army(1).mass = 1000
  w2.army(2).mass = 650 // Lager voll (Masse) …
  w2.army(2).energy = 4000 // … und Energie → aus Filter entfernt
  w2.army(3).mass = 0
  w2.army(1).tick([], 1, w2)
  check(near(w2.army(2).incomeCarryMass, 0), `voller Ally 2 übersprungen (${w2.army(2).incomeCarryMass})`)
  check(near(w2.army(3).incomeCarryMass, 350), `Ally 3 erhält vollen Overflow 350 (${w2.army(3).incomeCarryMass.toFixed(1)})`)
}

console.log('\n== Sharing-Determinismus ==')
{
  const run = (): string => {
    const w = new SimWorld()
    w.setAlliance(1, 2)
    w.setAlliance(1, 3)
    w.army(1).resourceSharing = true
    w.army(1).mass = 1000
    w.army(2).mass = 600
    w.army(1).tick([], 1, w)
    return `${w.army(2).incomeCarryMass}|${w.army(3).incomeCarryMass}|${w.army(1).mass}`
  }
  check(run() === run(), `identische Sharing-Läufe (${run()})`)
}

// ── 7. Echte Builder-BuildRate: Fortschritt = buildRate/BuildTime, additiv ──
// Binär: delta = buildRate/BuildTime · ratio · 0.1 je Bauer (CBuildTaskHelper::
// UpdateWorkProgress @0x5f5f2c); mehrere Bauer auf dasselbe Ziel wirken additiv.
console.log('\n== Builder-BuildRate: Timing, Assist-Stacking, Reichweiten-Gate ==')
{
  const w = new SimWorld()
  const target = w.spawn(stats({ buildCostMass: 100, buildCostEnergy: 200, buildTime: 100, maxHealth: 1000 }), 0, 0)
  target.buildProgress = 0
  target.health = 0
  const builder = w.spawn(stats({ buildRate: 10 }), 0, 0) // fertig, in Reichweite
  const army = w.army(1)
  army.mass = 100000
  army.energy = 100000
  w.issueBuild(builder, target)

  w.tick() // step = 10/100*0.1 = 0.01
  check(near(target.buildProgress, 0.01), `1 Bauer: Fortschritt ${target.buildProgress.toFixed(4)} (erwartet 0.0100)`)
  check(near(target.health, 10), `Health ${target.health.toFixed(1)} = maxHealth·progress (erwartet 10)`)
  check(near(army.massExpense, 10, 1e-2), `massExpense ${army.massExpense.toFixed(2)}/s (100·0.01/Tick → 10/s)`)
  check(near(army.energyExpense, 20, 1e-2), `energyExpense ${army.energyExpense.toFixed(2)}/s (200·0.01/Tick → 20/s)`)

  for (let i = 0; i < 99; i++) w.tick() // gesamt 100 Ticks = BuildTime/buildRate = 10 s
  check(near(target.buildProgress, 1), `nach 100 Ticks fertig: ${target.buildProgress.toFixed(4)}`)
  const massBefore = army.mass
  w.tick()
  check(near(army.mass, massBefore), 'nach Fertigstellung kein weiterer Drain')
}
{
  // Assist-Stacking: zwei Bauer (Rate 10) → effektive Rate 20 (additiv)
  const w = new SimWorld()
  const target = w.spawn(stats({ buildCostMass: 100, buildCostEnergy: 200, buildTime: 100, maxHealth: 1000 }), 0, 0)
  target.buildProgress = 0
  target.health = 0
  const b1 = w.spawn(stats({ buildRate: 10 }), 0, 0)
  const b2 = w.spawn(stats({ buildRate: 10 }), 0, 0)
  const army = w.army(1)
  army.mass = 100000
  army.energy = 100000
  w.issueBuild(b1, target)
  w.issueBuild(b2, target)
  w.tick()
  check(near(target.buildProgress, 0.02), `2 Bauer additiv: Fortschritt ${target.buildProgress.toFixed(4)} (erwartet 0.0200)`)
  check(near(army.massExpense, 20, 1e-2), `massExpense ${army.massExpense.toFixed(2)}/s (2× → 20/s)`)
}
{
  // Reichweiten-Gate: Bauer außerhalb MaxBuildDistance trägt NICHT bei
  const w = new SimWorld()
  const target = w.spawn(stats({ buildCostMass: 100, buildCostEnergy: 200, buildTime: 100, maxHealth: 1000 }), 0, 0)
  target.buildProgress = 0
  target.health = 0
  const farBuilder = w.spawn(stats({ buildRate: 10, maxBuildDistance: 5 }), 10, 0) // Distanz 10 > 5
  const army = w.army(1)
  army.mass = 100000
  army.energy = 100000
  w.issueBuild(farBuilder, target)
  w.tick()
  check(target.buildProgress === 0, `außer Reichweite: kein Fortschritt (${target.buildProgress})`)
  check(near(army.massExpense, 0), `außer Reichweite: kein Drain (${army.massExpense})`)
}

console.log(failures === 0 ? '\nECONOMY BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
