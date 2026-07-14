/**
 * Die Fabrik produziert — über die Original-`FactoryUnit` (defaultunits.lua:422).
 *
 * Geprüft wird, dass die Engine der Fabrik genau das liefert, was sie erwartet,
 * und sonst nichts entscheidet:
 *
 *   __queueFactoryBuild(fabrik, 'uel0101', 2)     Warteschlange (IssueBlueprintCommand)
 *   __factoryTick()                               setzt die naechste Einheit auf
 *     → Baustelle AN der Fabrik (Sim::CreateUnit, beingBuilt = 1)
 *     → fabrik:OnStartBuild(unit, 'FactoryBuild') → FactoryUnit.BuildingState
 *   Beats                                         Fortschritt = BuildRate/BuildTime · Rate · 0.1
 *     → unit:OnStopBeingBuilt(fabrik, 'FactoryBuild')
 *     → fabrik:OnStopBuild(unit, 'FactoryBuild')  → RollOffUnit → IssueMove
 *
 * Die Zahlen kommen aus den Blueprints (uel0101: BuildTime, BuildCostMass), die
 * Reihenfolge aus der Decomp. Nichts davon steht in TypeScript.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-factory.ts
 */
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { spawnLuaUnit, readLuaUnit } from '../src/lua/unitFactory'
import { GameFiles } from './gameFiles'
import { queueFactoryBuild } from '../src/sim/build'


let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const game = await GameFiles.open()
const files = game.luaFiles

const warnings: string[] = []
const host = await LuaHost.create(files, (level, msg) => {
  if (level === 'WARN') warnings.push(msg)
})
const engine = installEngine(host)
setTerrainSource(host, () => 20)
// Blueprint UND Skelett — beides braucht die Sim, bevor die erste Unit entsteht.
for (const id of ['uel0001', 'ueb0101', 'uel0101']) await game.giveUnit(host, id)

console.log('\n== Fabrik + ACU stehen ==')
// Die ACU liefert der Armee ihren Startvorrat (GiveInitialResources); ohne
// Vorrat baut die Fabrik nichts — das ist keine Testkulisse, das ist das Spiel.
const acu = spawnLuaUnit(host, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
const factory = spawnLuaUnit(host, 'ueb0101', { x: 120, y: 20, z: 120 }, 1)
for (let i = 0; i < 8; i++) beat(engine)
check(acu > 0 && factory > 0, `ACU (${acu}) und Fabrik (${factory}) über die Original-Klassen`)
check(
  host.eval(`return __units[${factory}].BuildingState ~= nil`) === true,
  'Die Fabrik IST eine FactoryUnit (sie hat den BuildingState aus defaultunits.lua)',
)

console.log('\n== Warteschlange: zwei Panzer ==')
check(queueFactoryBuild(host, factory, 'uel0101', 2), '__queueFactoryBuild(uel0101, 2)')
check(
  Number(host.eval(`return __units[${factory}].__buildQueue[1].count`)) === 2,
  'Die Warteschlange trägt { id = uel0101, count = 2 } (Form aus construction.lua:1620)',
)

// Ein Beat: __factoryTick setzt die erste Einheit auf.
beat(engine)
const tank1 = Number(
  host.eval(`
    for id, u in pairs(__units) do
      if u.__bp and u.__bp.BlueprintId == 'uel0101' then return id end
    end
    return 0
  `),
)
check(tank1 > 0, `Die Fabrik hat den ersten Panzer aufgesetzt (id ${tank1})`)
const t0 = readLuaUnit(host, tank1)
check(t0 !== null && t0.fraction < 1, `Er ist eine Baustelle (${((t0?.fraction ?? 0) * 100).toFixed(0)} %)`)
check(
  Math.abs((t0?.x ?? 0) - 120) < 0.01 && Math.abs((t0?.z ?? 0) - 120) < 0.01,
  'Er entsteht AN der Fabrik (120, 120)',
)
check(
  Number(host.eval(`return table.getn(__units[${factory}].__buildQueue) > 0 and __units[${factory}].__buildQueue[1].count or 0`)) === 1,
  'Die Warteschlange steht noch auf 1 (der zweite Panzer wartet)',
)

console.log('\n== Der Panzer wird gebaut und rollt vom Hof ==')
const massBefore = engine.economy.army(1).mass
let ticks = 0
while (readLuaUnit(host, tank1)!.fraction < 1 && ticks < 3000) {
  beat(engine)
  ticks++
}
const t1 = readLuaUnit(host, tank1)!
check(t1.fraction >= 1, `Panzer fertig nach ${ticks} Beats (${(ticks / 10).toFixed(1)} s)`)
check(t1.health === t1.maxHealth, `Volles Leben: ${t1.health}`)
check(engine.economy.army(1).mass < massBefore, `Masse bezahlt: ${massBefore.toFixed(0)} → ${engine.economy.army(1).mass.toFixed(0)}`)

// FactoryUnit.OnStopBuild → RollOffUnit → IssueMove: der Panzer bekommt ein Ziel.
// Das ist der Beweis, dass die ORIGINAL-Lua den Befehl gegeben hat — die Engine
// setzt hier von sich aus keine Bewegung.
check(
  host.eval(`return __units[${tank1}].__goal ~= nil and __units[${tank1}].__goal ~= false`) === true,
  'Er hat ein Bewegungsziel (FactoryUnit.RollOffUnit → IssueMove, defaultunits.lua:571)',
)

// Und die Fabrik nimmt sich den zweiten Panzer.
for (let i = 0; i < 3; i++) beat(engine)
const tanks = Number(
  host.eval(`
    local n = 0
    for _, u in pairs(__units) do
      if u.__bp and u.__bp.BlueprintId == 'uel0101' then n = n + 1 end
    end
    return n
  `),
)
check(tanks === 2, `Die Fabrik hat den zweiten Panzer aufgesetzt (${tanks} Panzer)`)

const badWarnings = warnings.filter((w) => !/effectutilities|Emitter|Animator|Sound/i.test(w))
if (badWarnings.length > 0) {
  console.log(`\n  (${badWarnings.length} WARN aus der Sim, erste 3:)`)
  for (const w of badWarnings.slice(0, 3)) console.log(`    ${w.slice(0, 140)}`)
}

host.close()
await game.close()
console.log(failures === 0 ? '\nFABRIK BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
