/**
 * Unit reclaim: a builder reclaiming a live UNIT target (a being-built enemy
 * structure), not just a prop. The engine issues Reclaim (dispatch 0x13,
 * CUnitReclaimTask) when a selection cannot attack a reclaimable enemy
 * (Cfile:1240271); the target's cost comes from its blueprint (unit.lua:2705-
 * 2713) and the reclaimer is credited the invested mass while the target drains.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-reclaim.ts
 */
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { spawnLuaUnit, spawnBuildSite } from '../src/lua/unitFactory'
import { GameFiles } from './gameFiles'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const game = await GameFiles.open()
const host = await LuaHost.create(game.luaFiles, () => {})
const engine = installEngine(host)
setTerrainSource(host, () => 20)
for (const id of ['uel0001', 'ueb0101']) await game.giveUnit(host, id)

// The ACU (army 1, a reclaimer with a build rate) and a being-built enemy
// structure (army 2) three metres away — inside MaxBuildDistance.
const acu = spawnLuaUnit(host, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
const target = spawnBuildSite(host, 'ueb0101', { x: 103, y: 20, z: 100 }, 2)
// Half-built so there is invested mass to reclaim (a fresh site is at 0).
host.eval(`__units[${target}].__fraction = 0.5`)
for (let i = 0; i < 8; i++) beat(engine)

const frac0 = Number(host.eval(`return __units[${target}].__fraction or 1`))
check(target > 0 && frac0 < 1, `enemy structure is a being-built site (fraction ${frac0.toFixed(2)})`)
// Empty most of the starting storage so the reclaim credit is not capped
// against a full store (the ACU spawns with a full mass reserve).
host.eval(`__getBrain(1):GiveResource('MASS', -600)`)
const mass0 = Number(host.eval(`return __getBrain(1):GetEconomyStored('MASS')`))

// The reclaim command that the world-click fallback issues on a non-attackable
// reclaimable enemy: __dispatchReclaim with a UNIT id target.
host.eval(`__dispatchReclaim(${acu}, ${target}, true)`)
check(
  host.eval(`return __reclaimTasks[${acu}] ~= nil`) === true,
  'a reclaim task is started against the unit target (not rejected as a non-prop)',
)

// Run it to completion.
let destroyed = false
for (let i = 0; i < 400; i++) {
  beat(engine)
  if (host.eval(`return __units[${target}] == nil or __units[${target}].__dead == true or __units[${target}].__destroyQueued == true`) === true) {
    destroyed = true
    break
  }
}
const frac1 = Number(host.eval(`return (__units[${target}] and (__units[${target}].__fraction or 1)) or 0`))
check(frac1 < frac0, `reclaim drained the target's fraction (${frac0.toFixed(2)} -> ${frac1.toFixed(2)})`)
check(destroyed, 'the fully-reclaimed unit is destroyed')
const mass1 = Number(host.eval(`return __getBrain(1):GetEconomyStored('MASS')`))
check(mass1 > mass0, `the reclaimer's army is credited mass (${mass0.toFixed(0)} -> ${mass1.toFixed(0)})`)

host.close()
await game.close()
console.log(failures === 0 ? '\nRECLAIM PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
