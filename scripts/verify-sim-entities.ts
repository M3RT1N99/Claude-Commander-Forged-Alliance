/**
 * Sim entity/effect bindings the original Lua calls during NORMAL play — a
 * missing one killed a real thread, silently.
 *
 *  - CreateSlaver (Cfile:877923): weapon.lua:101 slaves every rack bone to the
 *    turret pitch bone for a weapon with RackSlavedToTurret; without it that
 *    weapon's OnCreate died.
 *  - CreateStorageManip (Cfile:880155): the eight mass/energy storage scripts
 *    call it in OnStopBeingBuilt (ueb1106 etc.); without it their thread died.
 *  - CreateSplatOnBone (Cfile:908461): unit.lua lays tread marks with it.
 *  - GetEntityById / GetUnitById (Cfile:1077559/1077628): control groups and
 *    Ctrl-K self-destruct resolve ids with them.
 *  - GetMapSize (Cfile:1089710): AI base templates scale their radii with it.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-sim-entities.ts
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
const warnings: string[] = []
const host = await LuaHost.create(game.luaFiles, (level, msg) => {
  if (level === 'WARN') warnings.push(msg)
})
const engine = installEngine(host)
// A map extent so GetMapSize answers (setTerrainSource passes it through).
setTerrainSource(host, () => 20, { width: 256, height: 256 })
for (const id of ['uel0001', 'ual0104', 'ueb1106']) await game.giveUnit(host, id)

console.log('\n== The manipulator factories exist ==')
check(host.eval('return type(CreateSlaver)') === 'function', 'CreateSlaver (sim)')
check(host.eval('return type(CreateStorageManip)') === 'function', 'CreateStorageManip (sim)')
check(host.eval('return type(CreateSplatOnBone)') === 'function', 'CreateSplatOnBone (sim)')
check(host.eval('return type(GetEntityById)') === 'function', 'GetEntityById (sim)')
check(host.eval('return type(GetMapSize)') === 'function', 'GetMapSize (sim)')

console.log('\n== CreateSlaver carries the two bones + SetMaxRate ==')
{
  const u = spawnLuaUnit(host, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
  for (let i = 0; i < 4; i++) beat(engine)
  const r = String(
    host.eval(`
      local m = CreateSlaver(__units[${u}], 'turret', 'pitch')
      m:SetPrecedence(9)
      m:SetMaxRate(45)
      return tostring(m.__bone) .. '|' .. tostring(m.__srcBone) .. '|' .. tostring(m.__precedence) .. '|' .. tostring(m.__maxRate)
    `),
  )
  check(r === 'turret|pitch|9|45', `slaves turret<-pitch, keeps precedence and max rate (${r})`)
}

console.log('\n== A RackSlavedToTurret weapon builds without dying (ual0104) ==')
{
  const wagner = spawnLuaUnit(host, 'ual0104', { x: 120, y: 20, z: 120 }, 1)
  for (let i = 0; i < 6; i++) beat(engine)
  check(wagner > 0, `ual0104 spawned (id ${wagner})`)
  const slaverWarnings = warnings.filter((w) => /CreateSlaver|nil value.*CreateSlaver|attempt to call a nil value/i.test(w))
  check(
    slaverWarnings.length === 0,
    `no "call a nil value" in the weapon OnCreate (${slaverWarnings.slice(0, 1)})`,
  )
}

console.log('\n== A storage structure runs its OnStopBeingBuilt (ueb1106) ==')
{
  const store = spawnLuaUnit(host, 'ueb1106', { x: 140, y: 20, z: 140 }, 1)
  for (let i = 0; i < 8; i++) beat(engine)
  check(store > 0, `ueb1106 (mass storage) spawned (id ${store})`)
  const storeWarnings = warnings.filter((w) => /CreateStorageManip|attempt to call a nil/i.test(w))
  check(storeWarnings.length === 0, `no nil-value error in OnStopBeingBuilt (${storeWarnings.slice(0, 1)})`)
}

console.log('\n== CreateSplatOnBone lands a splat at the bone ==')
{
  const u = spawnLuaUnit(host, 'uel0001', { x: 200, y: 20, z: 200 }, 1)
  for (let i = 0; i < 4; i++) beat(engine)
  const ok = host.eval(`
    local ok = pcall(function()
      CreateSplatOnBone(__units[${u}], {0,0,0}, 0, '/textures/splat.dds', 2, 2, 100, 5, 1)
    end)
    return ok
  `)
  check(ok === true, 'CreateSplatOnBone(entity, offset, bone, ...) is callable and does not throw')
}

console.log('\n== GetEntityById / GetUnitById ==')
{
  const u = spawnLuaUnit(host, 'uel0001', { x: 260, y: 20, z: 260 }, 1)
  for (let i = 0; i < 2; i++) beat(engine)
  check(host.eval(`return GetEntityById(${u}) == __units[${u}]`) === true, `GetEntityById(${u}) finds the unit`)
  check(host.eval(`return GetUnitById(${u}) == __units[${u}]`) === true, 'GetUnitById finds the unit')
  check(host.eval(`return GetEntityById(999999) == nil`) === true, 'a missing id -> nil')
  check(host.eval(`return GetEntityById(tostring(${u})) == __units[${u}]`) === true, 'a string id works too (atoi)')
}

console.log('\n== GetMapSize ==')
{
  const size = String(host.eval('local x, z = GetMapSize() return x .. "," .. z'))
  check(size === '256,256', `GetMapSize() = ${size} (the map extent)`)
}

await game.close()
console.log(failures === 0 ? '\nSIM ENTITIES PASSED' : `\nSIM ENTITIES FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
