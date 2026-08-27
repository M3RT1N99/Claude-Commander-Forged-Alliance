/**
 * Build restrictions (the lobby "Restricted Units" option; AddBuildRestriction /
 * RemoveBuildRestriction, siminit.lua:190). The restriction category lives per
 * army (globals.lua __armyBuildRestrictions) and is enforced by Unit::CanBuild
 * (faf-re Unit.cpp:12386). This checks the PRIMARY build path: a factory drops a
 * restricted unit from its queue instead of producing it, and builds it again
 * once the restriction is removed.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-restrictions.ts
 */
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { spawnLuaUnit } from '../src/lua/unitFactory'
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
for (const id of ['ueb0101', 'uel0201']) await game.giveUnit(host, id) // T1 land factory + T1 tank
const factory = spawnLuaUnit(host, 'ueb0101', { x: 100, y: 20, z: 100 }, 1)
for (let i = 0; i < 8; i++) beat(engine)

const TANK = 'uel0201'
const queueTank = (): void => {
  host.eval(`__units[${factory}].__buildQueue = { { id = '${TANK}', count = 1 } }`)
}
const queueEmpty = (): boolean => host.eval(`return __units[${factory}].__buildQueue[1] == nil`) as boolean
const tankSiteExists = (): boolean =>
  host.eval(
    `for _,u in pairs(__units) do if u.__beingBuilt and string.lower(tostring(u.__bp.BlueprintId)) == '${TANK}' then return true end end return false`,
  ) as boolean

// TECH1 restricted -> the T1 tank must not be produced.
console.log('\n== A TECH1 restriction blocks the primary build path ==')
host.eval(`AddBuildRestriction(1, 'TECH1')`)
queueTank()
beat(engine)
check(!tankSiteExists(), 'a restricted (TECH1) tank is NOT built')
check(queueEmpty(), 'the restricted item is dropped from the factory queue')

// Remove the restriction -> the same tank builds.
console.log('\n== Removing the restriction lets it build again ==')
host.eval(`RemoveBuildRestriction(1, 'TECH1')`)
queueTank()
beat(engine)
check(tankSiteExists(), 'after RemoveBuildRestriction the tank is produced')

console.log(failures === 0 ? '\nRESTRICTIONS PASSED' : `\nRESTRICTIONS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
