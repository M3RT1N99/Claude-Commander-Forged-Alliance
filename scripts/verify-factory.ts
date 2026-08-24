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
  Number(host.eval(`return table.getn(__units[${factory}].__buildQueue) > 0 and __units[${factory}].__buildQueue[1].count or 0`)) === 2,
  'Die Warteschlange steht noch auf 2 — die BAUENDE Einheit bleibt gezaehlt ' +
    '(die Engine dekrementiert die BuildFactory-Command erst bei COMPLETION, ' +
    'Cfile:838029), also zeigt die Anzeige die echte Reststueckzahl',
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
// COMPLETION decrements the queue (Cfile:838029: count>1 -> DecreaseCount(1)):
// 2 -> 1 now that the first tank is done, so the second still waits at count 1.
check(
  Number(host.eval(`return table.getn(__units[${factory}].__buildQueue) > 0 and __units[${factory}].__buildQueue[1].count or 0`)) === 1,
  'Nach der Fertigstellung steht die Warteschlange auf 1 (Dekrement bei COMPLETION)',
)
check(engine.economy.army(1).mass < massBefore, `Masse bezahlt: ${massBefore.toFixed(0)} → ${engine.economy.army(1).mass.toFixed(0)}`)

// FactoryUnit.OnStopBuild → RollOffUnit → IssueMove: der Panzer bekommt ein Ziel.
// Das ist der Beweis, dass die ORIGINAL-Lua den Befehl gegeben hat — die Engine
// setzt hier von sich aus keine Bewegung.
check(
  host.eval(`return __units[${tank1}].__goal ~= nil and __units[${tank1}].__goal ~= false`) === true,
  'Er hat ein Bewegungsziel (FactoryUnit.RollOffUnit → IssueMove, defaultunits.lua:571)',
)

// While the finished tank is still leaving the build pad the factory is BUSY
// and its queue is BLOCKED: FinishBuildThread sets SetBusy(true) +
// SetBlockCommandQueue(true) (defaultunits.lua:529-530), RolloffBody holds both
// until IsCommandDone(MoveCommand) reports the unit is clear
// (defaultunits.lua:643-649). Only then may the next unit come into being —
// otherwise it would grow INSIDE the one rolling off.
const countTanks = (): number =>
  Number(
    host.eval(`
      local n = 0
      for _, u in pairs(__units) do
        if u.__bp and u.__bp.BlueprintId == 'uel0101' then n = n + 1 end
      end
      return n
    `),
  )
for (let i = 0; i < 3; i++) beat(engine)
check(
  host.eval(`return __units[${factory}].__busy == true`) === true,
  'the factory is BUSY while the tank rolls off (SetBusy, defaultunits.lua:529)',
)
check(countTanks() === 1, 'and it starts NO second tank during that time')

// Wait for the roll-off: RolloffBody checks every 0.5 s (WaitSeconds), then IdleState.
let rollTicks = 0
while (host.eval(`return __units[${factory}].__busy == true`) === true && rollTicks < 300) {
  beat(engine)
  rollTicks++
}
check(rollTicks < 300, `the tank is clear after ${rollTicks} beats (RolloffBody → IdleState)`)
for (let i = 0; i < 3; i++) beat(engine)
const tanks = countTanks()
check(tanks === 2, `then the factory starts the second tank (${tanks} tanks)`)

// === Rally point ===
//
// The finished unit INHERITS its factory's commands (sub_5FA340,
// Cfile:818487-818600). The rally point is such a command:
// IssueFactoryRallyPoint puts a UNITCOMMAND_Move into the factory's command
// list (Cfile:1008346). Without that inheritance every unit stopped on the
// roll-off point and piled up there.
console.log('\n== Rally point: the new unit drives there ==')
{
  host.eval(`__units[${factory}]:SetRallyPoint({ 160, 20, 170 })`)
  const tank2 = Number(
    host.eval(`
      local newest = 0
      for id, u in pairs(__units) do
        if u.__bp and u.__bp.BlueprintId == 'uel0101' and id > newest then newest = id end
      end
      return newest
    `),
  )
  let t = 0
  while (t < 3000 && readLuaUnit(host, tank2)!.fraction < 1) {
    beat(engine)
    t++
  }
  // One beat after completion: RollOffUnit issued the roll-off command, the
  // rally point waits behind it in the queue.
  beat(engine)
  const queued = host.eval(`
    local n = 0
    for _, c in ipairs(__orders[${tank2}] or {}) do n = n + 1 end
    return n .. '|' .. tostring(__orderActive[${tank2}] ~= nil)
  `)
  check(queued === '1|true', `roll-off running, rally point queued behind it (${queued})`)
  let m = 0
  while (m < 2000 && host.eval(`return __orderActive[${tank2}] ~= nil`) === true) {
    beat(engine)
    m++
  }
  const end = readLuaUnit(host, tank2)!
  check(
    Math.hypot(end.x - 160, end.z - 170) < 3,
    `it stands on the rally point 160/170 (${end.x.toFixed(1)}/${end.z.toFixed(1)}, after ${m} beats)`,
  )
}

// === Queue edited mid-build: completion drains the task's OWN command ===
//
// The engine decrements the specific command the CFactoryBuildTask was built
// from (DecreaseCount(1, v18), Cfile:838029), NOT a positional head. Reorder the
// queue while a unit builds and the completing unit must still drain ITS item.
console.log('\n== Queue edited mid-build: the right item is drained ==')
for (let i = 0; i < 40 && host.eval(`return __units[${factory}].__busy == true`) === true; i++) beat(engine)
queueFactoryBuild(host, factory, 'uel0101', 2)
beat(engine) // __factoryTick spawns the first tank from the (only) stack
const midTank = Number(
  host.eval(`
    local newest = 0
    for id, u in pairs(__units) do
      if u.__bp and u.__bp.BlueprintId == 'uel0101' and (u.__fraction or 1) < 1 and id > newest then newest = id end
    end
    return newest
  `),
)
check(midTank > 0, `a tank is building from the stack (id ${midTank})`)
// Slip a foreign stack in FRONT of the building one — now q[1] is NOT the item
// the running task was built from.
host.eval(`table.insert(__units[${factory}].__buildQueue, 1, { id = 'ZZFOREIGN', count = 5 })`)
let mb = 0
while (readLuaUnit(host, midTank)!.fraction < 1 && mb < 3000) {
  beat(engine)
  mb++
}
check(readLuaUnit(host, midTank)!.fraction >= 1, `the tank finished (${mb} beats)`)
check(
  Number(host.eval(`return __units[${factory}].__buildQueue[1].count`)) === 5,
  'the foreign stack at q[1] is UNTOUCHED (completion drained its own item by identity, not q[1])',
)
check(
  Number(
    host.eval(`
      for _, it in ipairs(__units[${factory}].__buildQueue) do
        if it.id == 'uel0101' then return it.count end
      end
      return -1
    `),
  ) === 1,
  'the tank stack it WAS building dropped 2 -> 1',
)
host.eval(`
  local q = __units[${factory}].__buildQueue
  for i = table.getn(q), 1, -1 do if q[i].id == 'ZZFOREIGN' then table.remove(q, i) end end
`)

const badWarnings = warnings.filter((w) => !/effectutilities|Emitter|Animator|Sound/i.test(w))
if (badWarnings.length > 0) {
  console.log(`\n  (${badWarnings.length} WARN aus der Sim, erste 3:)`)
  for (const w of badWarnings.slice(0, 3)) console.log(`    ${w.slice(0, 140)}`)
}

host.close()
await game.close()
console.log(failures === 0 ? '\nFABRIK BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
