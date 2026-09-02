/**
 * Self-destruct (Ctrl+K): the UI fires SimCallback ToggleSelfDestruct
 * (confirmunitdestroy.lua:24), the sim runs lua/selfdestruct.lua — a 5-second
 * countdown then Kill, toggled off if fired again while counting down. The gate
 * is OkayToMessWithArmy (cfunc_OkayToMessWithArmyL, Cfile:1026233): only the
 * local player's (focus) army may be self-destructed.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-selfdestruct.ts
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
await game.giveUnit(host, 'uel0201')

const fire = (id: number): void => {
  host.eval(`__simCallback('ToggleSelfDestruct', { units = { ${id} }, owner = 1 }, { ${id} })`)
}
const alive = (id: number): boolean =>
  host.eval(`return __units[${id}] ~= nil and not (__units[${id}].__dead)`) === true

console.log('== OkayToMessWithArmy (Cfile:1026233) ==')
check(host.eval('return OkayToMessWithArmy(1)') === true, 'focus army (1) is commandable')
check(host.eval('return OkayToMessWithArmy(2)') === false, 'a non-focus army is NOT commandable')

console.log('== self-destruct: 5-second countdown then Kill ==')
const a = spawnLuaUnit(host, 'uel0201', { x: 100, y: 20, z: 100 }, 1)
fire(a)
check(
  host.eval(`local u=__units[${a}]; return u and u.SelfDestructThread ~= nil and u.SelfDestructThread ~= false`) === true,
  'firing starts the SelfDestructThread',
)
for (let i = 0; i < 48; i++) beat(engine)
check(alive(a), 'still alive at 4.8 s (before the 5 s mark)')
for (let i = 0; i < 6; i++) beat(engine)
check(!alive(a), 'dead just after 5 s')

console.log('== toggle off: a second press cancels the countdown ==')
const b = spawnLuaUnit(host, 'uel0201', { x: 120, y: 20, z: 120 }, 1)
fire(b)
fire(b)
for (let i = 0; i < 60; i++) beat(engine)
check(alive(b), 'unit survives 6 s after a toggle-off')

console.log('== an enemy army unit is not self-destructible by the player ==')
const c = spawnLuaUnit(host, 'uel0201', { x: 140, y: 20, z: 140 }, 2)
host.eval(`__simCallback('ToggleSelfDestruct', { units = { ${c} }, owner = 1 }, { ${c} })`)
for (let i = 0; i < 60; i++) beat(engine)
check(alive(c), 'an army-2 unit ignores a player self-destruct (OkayToMessWithArmy)')

host.close()
await game.close()
console.log(failures === 0 ? '\nSELF-DESTRUCT PASSED' : `\nSELF-DESTRUCT FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
