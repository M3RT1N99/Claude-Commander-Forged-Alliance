/**
 * GOLDEN MASTER — ein fester Ablauf, ein Fingerabdruck, eine eingecheckte Zahl.
 *
 * Die 56 Suiten prüfen JEWEILS eine Sache, die jemand vorher bedacht hat. Genau
 * daran sind in dieser Woche zwei echte Regressionen vorbeigelaufen:
 *
 *   * beschildete Einheiten nahmen null Flächenschaden (`damagePoint` fragte die
 *     eigene Kuppel ein zweites Mal ab), und
 *   * Schüsse an einer Küste meldeten `Water` statt `Terrain`.
 *
 * Beide standen hinter einem grünen Gate, weil keine Suite genau diese Frage
 * stellte. Die Regression aus `4a37b2f` (Kuppeln machten jede Einheit darunter
 * unverwundbar) überlebte auf demselben Weg einen ganzen Monat.
 *
 * Dieser Test stellt keine Frage. Er fährt einen festen Ablauf — Ökonomie, Bau,
 * Fabrik, Bewegung, Kampf, Flächenschaden — und bildet über den Endzustand einen
 * Hash. Der erwartete Hash liegt in `scripts/fixtures/goldenmaster.json`.
 *
 * **Das Material ist nicht ausgedacht:** es ist `__readAllUnitsJson()`, also
 * exakt der Block, den die Sim zehnmal pro Sekunde an die UI schickt
 * (`units.lua:846`) — Position, Kurs, Leben, Baufortschritt, Feuerzustand,
 * Command-Caps, Schild-Verhältnis, Aufträge, Türme, Bauschlange —, dazu die acht
 * Ökonomie-Summen je Armee. Was das Spiel sieht, sieht dieser Test.
 *
 * Der JSON-Schreiber quantisiert Gleitkomma mit `%.6g` und Bitmasken exakt mit
 * `%d` (`units.lua:830-843`). Das ist genau die richtige Toleranz: empfindlich
 * genug für jede Verhaltensänderung, grob genug, dass das letzte Bit einer
 * Plattform nicht als Befund durchgeht. `pairs()` hat keine feste Reihenfolge,
 * deshalb wird nach Id sortiert, bevor gehasht wird.
 *
 * **Jede** Verhaltensänderung wird damit rot — auch eine, an die niemand gedacht
 * hat. Das ist der Punkt: der Test weiß nicht, was RICHTIG ist, nur was ANDERS
 * ist. War die Änderung Absicht, wird der Hash mit dem Commit nachgezogen, der
 * sie verursacht — und die Commit-Nachricht sagt warum.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-goldenmaster.ts
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-goldenmaster.ts --update
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-goldenmaster.ts --dump
 *
 * `--dump` schreibt das gehashte Material nach `scripts/fixtures/goldenmaster.txt`.
 * Ein roter Hash ohne Diff waere nutzlos: wer ihn sieht, laesst `--dump` auf
 * beiden Staenden laufen und vergleicht die zwei Dateien Zeile fuer Zeile.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { spawnLuaUnit, spawnBuildSite } from '../src/lua/unitFactory'
import { issueBuildTask, queueFactoryBuild } from '../src/sim/build'
import { GameFiles } from './gameFiles'

const update = process.argv.includes('--update')
const dump = process.argv.includes('--dump')
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'goldenmaster.json')

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const game = await GameFiles.open()
const luaErrors: string[] = []
const host = await LuaHost.create(game.luaFiles, (level, msg) => {
  if (level === 'WARN' && /Fehler|error/i.test(msg)) luaErrors.push(msg)
})
const engine = installEngine(host)
// Flaches Testgelände ohne Wasser: der Ablauf soll von der Karte unabhängig
// sein, sonst misst der Hash die Karte statt die Engine.
setTerrainSource(host, () => 20, { width: 512, height: 512 })

for (const id of ['uel0001', 'ueb0101', 'ueb1101', 'uel0201', 'uel0101']) {
  await game.giveUnit(host, id)
}
// Ohne Projektil- und Prop-Blueprints fällt der Kampfabschnitt still aus — dann
// hätte der Hash nur so getan, als decke er den Kampf ab.
const nProj = game.loadProjectiles(host)
const nProps = game.loadProps(host)
check(nProj > 250 && nProps >= 1, `${nProj} Projektil- und ${nProps} Prop-Blueprints geladen`)

// --- Der feste Ablauf -------------------------------------------------------
// Bewusst breit: was hier NICHT vorkommt, kann der Hash auch nicht schützen.
console.log('\n== Fester Ablauf ==')

// Startvorrat über das echte Engine-Global, das auch die Szenario-Skripte
// benutzen (economy.ts:491) — keine direkt gesetzten TS-Felder.
host.eval('SetArmyEconomy(1, 4000, 100000)')

const acu = spawnLuaUnit(host, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
for (let i = 0; i < 10; i++) beat(engine)

// Bau: die ACU zieht einen Generator hoch (Baufortschritt, Verbrauch, Übergabe)
const site = spawnBuildSite(host, 'ueb1101', { x: 108, y: 20, z: 100 }, 1)
issueBuildTask(host, acu, site)
for (let i = 0; i < 60; i++) beat(engine)

// Fabrik: Warteschlange, Produktion, Abrollen (Dispatch + Motion)
const fab = spawnLuaUnit(host, 'ueb0101', { x: 130, y: 20, z: 130 }, 1)
queueFactoryBuild(host, fab, 'uel0101', 2)
for (let i = 0; i < 200; i++) beat(engine)

// Bewegung: ein Panzer fährt ein festes Ziel an
const laeufer = spawnLuaUnit(host, 'uel0201', { x: 200, y: 20, z: 200 }, 1)
host.eval(`__dispatchMove(${laeufer}, 230, 200, true)`)
for (let i = 0; i < 80; i++) beat(engine)

// Kampf: zwei Panzer, Zielerfassung, Schuss, Flug, Treffer, Schaden.
//
// 60 Beats, nicht 300: bei 300 vernichten sich zwei gleiche T1-Panzer
// gegenseitig (nachgemessen — der Endzustand enthielt danach KEINEN der beiden).
// Dann trägt der Fingerabdruck keinen einzigen kampfbeschädigten Gesundheitswert
// — also ausgerechnet die Zahl nicht, an der die Schild-Regression hing. Mit 60
// Beats überleben beide sichtbar angeschlagen, und ihre Gesundheit steht im Hash.
const eigener = spawnLuaUnit(host, 'uel0201', { x: 300, y: 20, z: 300 }, 1)
const feind = spawnLuaUnit(host, 'uel0201', { x: 300, y: 20, z: 312 }, 2)
for (let i = 0; i < 60; i++) beat(engine)

// Flächenschaden mit Abfall auf die beiden Angeschlagenen: der eine steht im
// Zentrum, der andere am Rand des Radius.
host.eval(`DamageArea(nil, { 300, 20, 300 }, 14, 60, 'Normal', true)`)
for (let i = 0; i < 5; i++) beat(engine)

// Schildkuppel unter Flächenschaden — der Weg, auf dem in dieser Woche der
// Doppelabzug saß und auf dem `4a37b2f` einen Monat lang jede Einheit unter der
// Kuppel unverwundbar machte. Die Spec ist die aus `verify-shields.ts`, deren
// Werte auf `uel0001_unit.bp:563` und die ACU-Erweiterung
// `uel0001_script.lua:325-327` zurückgehen; `ShieldRegenRate = 0`, damit die
// Kuppel sich nicht selbst bewegt und der Endwert die reine Absorption ist.
const schirmer = spawnLuaUnit(host, 'uel0001', { x: 400, y: 20, z: 400 }, 1)
const gedeckt = spawnLuaUnit(host, 'uel0201', { x: 405, y: 20, z: 400 }, 1)
for (let i = 0; i < 8; i++) beat(engine)
host.eval(`__units[${schirmer}]:CreateShield({
  ShieldMaxHealth = 200, ShieldRechargeTime = 2, ShieldEnergyDrainRechargeTime = 2,
  ShieldRegenRate = 0, ShieldRegenStartTime = 1, ShieldSize = 10,
  ShieldVerticalOffset = 0, PassOverkillDamage = false,
  MaintenanceConsumptionPerSecondEnergy = 500,
})`)
host.eval(`__units[${schirmer}]:SetEnergyMaintenanceConsumptionOverride(500)`)
host.eval(`__units[${schirmer}]:SetMaintenanceConsumptionActive()`)
beat(engine)
// Ursprung AUSSERHALB der Kuppel (Abstand 15 > ShieldSize 10), aber im Radius:
// die Kuppel nimmt 200, der Rest erreicht Besitzer und gedeckte Einheit.
host.eval(`DamageArea(nil, { 415, 20, 400 }, 30, 350, 'Normal', true)`)
for (let i = 0; i < 15; i++) beat(engine)

check(
  acu > 0 && site > 0 && fab > 0 && laeufer > 0 && eigener > 0 && feind > 0
    && schirmer > 0 && gedeckt > 0,
  'Ablauf gelaufen (ACU, Baustelle, Fabrik, Läufer, zwei Kämpfer, Kuppel + Gedeckter)',
)
check(luaErrors.length === 0, `keine Lua-Fehler im Ablauf${luaErrors[0] ? `: ${luaErrors[0]}` : ''}`)

// --- Der Fingerabdruck ------------------------------------------------------
interface Row {
  id: number
  [k: string]: unknown
}
const rows = JSON.parse(String(host.eval('return __readAllUnitsJson()'))) as Row[]
rows.sort((a, b) => a.id - b.id)
// Schlüssel sortiert serialisieren: der Hash hängt am WERT, nicht daran, in
// welcher Reihenfolge der Schreiber die Felder ausgibt.
const stable = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(stable)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, stable(o[k])]))
  }
  return v
}

const eco = [1, 2]
  .map((a) => {
    const e = engine.economy.army(a)
    return [
      e.mass, e.energy, e.maxMass, e.maxEnergy,
      e.incomeMass, e.incomeEnergy, e.expenseMass, e.expenseEnergy,
    ]
      .map((x) => x.toPrecision(6))
      .join('|')
  })
  .map((s, i) => `army${i + 1}|${s}`)
  .join('\n')

const material = `${eco}\n--\n${JSON.stringify(stable(rows))}`
const hash = createHash('sha256').update(material).digest('hex').slice(0, 32)

if (dump) {
  const out = fixture.replace(/\.json$/, '.txt')
  writeFileSync(out, `${material}\n`)
  console.log(`\n  Material nach ${out} geschrieben`)
}

console.log('\n== Fingerabdruck ==')
console.log(`  ${rows.length} Einheiten im Endzustand, ${material.length} Zeichen Material`)
console.log(`  ${hash}`)

interface Fixture {
  hash: string
  units: number
  material: number
  note: string
}

// Ein leerer oder winziger Zustand darf NIE als „unverändert" durchgehen: fällt
// der Ablauf komplett aus, ist das ein Befund, kein bestandener Test.
check(rows.length >= 8, `mindestens 8 Einheiten im Endzustand (sind ${rows.length})`)

if (update || !existsSync(fixture)) {
  mkdirSync(dirname(fixture), { recursive: true })
  const f: Fixture = {
    hash,
    units: rows.length,
    material: material.length,
    note:
      'Endzustand eines festen Ablaufs (Ökonomie, Bau, Fabrik, Bewegung, Kampf, '
      + 'Flächenschaden), gehasht über __readAllUnitsJson() plus die acht '
      + 'Ökonomie-Summen je Armee. Ändert sich der Hash, hat sich das VERHALTEN '
      + 'der Sim geändert — absichtlich oder nicht. Nur zusammen mit dem Commit '
      + 'nachziehen, der die Änderung erklärt (--update).',
  }
  writeFileSync(fixture, `${JSON.stringify(f, null, 2)}\n`)
  console.log(`  ${update ? 'Hash NEU GESETZT' : 'Hash angelegt'}`)
} else {
  const f = JSON.parse(readFileSync(fixture, 'utf-8')) as Fixture
  check(rows.length === f.units, `${rows.length} Einheiten (erwartet ${f.units})`)
  check(
    hash === f.hash,
    hash === f.hash
      ? `Fingerabdruck unverändert (${hash})`
      : `Fingerabdruck GEÄNDERT: ${hash} statt ${f.hash} — die Sim verhält sich anders. `
        + 'Was sich geändert hat, zeigt --dump (auf beiden Ständen laufen lassen und '
        + 'die zwei .txt vergleichen). War es Absicht: --update und im Commit begründen.',
  )
}

host.close()
await game.close()
console.log(failures === 0 ? '\nGOLDEN MASTER BESTANDEN' : `\nGOLDEN MASTER: ${failures} FEHLER`)
process.exit(failures === 0 ? 0 : 1)
