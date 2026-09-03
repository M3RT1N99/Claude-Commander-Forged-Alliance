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
import { FLAT_TEST_MAP_SIZE } from '../src/sim/terrain'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const game = await GameFiles.open()
const host = await LuaHost.create(game.luaFiles, () => {})
const engine = installEngine(host)
setTerrainSource(host, () => 20, FLAT_TEST_MAP_SIZE)
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

console.log('\n== The unit\'s own restrictions: an ACU cannot build T2 until the enhancement ==')
// Unit:AddBuildRestriction / RemoveBuildRestriction / RestoreBuildRestrictions
// edit UnitAttributes::mRestrictionCategory, a SET of blueprints
// (Cfile:975286-975288, 975342-975344, 975399-975410). uel0001_script.lua:117
// restricts UEF * (BUILTBYTIER2COMMANDER + BUILTBYTIER3COMMANDER) when the ACU
// is done, and the T2 enhancement removes 'BUILTBYTIER2COMMANDER UEF' again
// (:334-335) -- a different expression than the one added, so only set
// arithmetic answers correctly. All three were silent no-ops.
for (const id of ['uel0001', 'ueb1101', 'ueb1201', 'ueb1301']) await game.giveUnit(host, id)
const acu = spawnLuaUnit(host, 'uel0001', { x: 150, y: 20, z: 150 }, 1)
const can = (bp: string): boolean => host.eval(`return __units[${acu}]:CanBuild('${bp}')`) === true
check(can('ueb1101'), 'the fresh ACU can build a T1 power generator')
check(!can('ueb1201'), 'but not the T2 mass extractor (BUILTBYTIER2COMMANDER, uel0001_script.lua:117)')
check(!can('ueb1301'), 'nor the T3 power generator (BUILTBYTIER3COMMANDER)')
check(host.eval(`return __isBuildRestricted(__units[${acu}], 'ueb1201')`) === true, 'the build path sees the same restriction')
host.eval(`__units[${acu}]:RemoveBuildRestriction(ParseEntityCategory('BUILTBYTIER2COMMANDER UEF'))`)
check(can('ueb1201'), "after RemoveBuildRestriction('BUILTBYTIER2COMMANDER UEF') the T2 extractor is buildable")
check(!can('ueb1301'), 'the T3 generator stays restricted -- set difference, not list removal')
host.eval(`__units[${acu}]:RestoreBuildRestrictions()`)
check(can('ueb1301'), 'RestoreBuildRestrictions empties the set')
check(host.eval(`return (pcall(function() __units[${acu}]:AddBuildRestriction() end))`) === false, 'AddBuildRestriction without a category throws')

console.log(failures === 0 ? '\nRESTRICTIONS PASSED' : `\nRESTRICTIONS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
