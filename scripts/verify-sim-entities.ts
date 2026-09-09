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
 *  - CreateBeamEntityToEntity (Cfile:890531): the experimental phason laser
 *    (defaultcollisionbeams.lua:325) draws its beam with it.
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

console.log('\n== CreateBeamEntityToEntity: a beam between two bones ==')
{
  const u = spawnLuaUnit(host, 'uel0001', { x: 300, y: 20, z: 300 }, 1)
  for (let i = 0; i < 2; i++) beat(engine)
  // The beam carries both endpoints; __readAllEmittersJson writes x2/y2/z2 for
  // the far end (the impact bone).
  const r = String(
    host.eval(`
      local e = CreateBeamEntityToEntity(__units[${u}], 0, __units[${u}], 1, 1, '/effects/emitters/test_beam_emit.bp')
      return tostring(e.__other == __units[${u}]) .. '|' .. tostring(e.__otherBone) .. '|' .. tostring(e.__spec)
    `),
  )
  check(
    r === 'true|1|/effects/emitters/test_beam_emit.bp',
    `the beam runs bone 0 -> bone 1 and carries its blueprint (${r})`,
  )
}

console.log('\n== GetMapSize ==')
{
  const size = String(host.eval('local x, z = GetMapSize() return x .. "," .. z'))
  check(size === '256,256', `GetMapSize() = ${size} (the map extent)`)
}

console.log('\n== IEffect parameters: SetEmitterParam / SetEmitterCurveParam / ResizeEmitterCurve / SetBeamParam ==')
{
  // The six IEffect methods (sim only): SetEmitterParam and SetBeamParam
  // share one body that resolves the name against EEmitterParam resp.
  // EBeamParam and writes mParams[index] (Cfile:907419-907472, the
  // wrappers 907507/907556 want 3 arguments); ScaleEmitter is
  // SetFloatParam(18 = SCALE) (907605-907643); OffsetEmitter adds to the
  // POSITION slots (907918-907968); SetEmitterCurveParam installs a
  // single-key curve {0, height, size} (907794-907909); ResizeEmitterCurve
  // rescales the current curve's key times to the new range
  // (907678-907770, sub_515090 649104-649136). The emitter blueprint gives
  // ResizeEmitterCurve its source curve.
  game.loadProjectiles(host)
  const u = spawnLuaUnit(host, 'uel0001', { x: 340, y: 20, z: 340 }, 1)
  beat(engine)
  const err = (expression: string): string =>
    host.eval(`local ok, e = pcall(function() ${expression} end); return ok and '' or tostring(e)`) as string
  host.eval(`__fx = CreateEmitterOnEntity(__units[${u}], 1, '/effects/emitters/destruction_explosion_fire_plume_02_emit.bp')`)
  // defaultexplosions.lua:341-342 (chained calls return the effect).
  check(
    host.eval(`return __fx:SetEmitterParam('REPEATTIME', 15):SetEmitterParam('LIFETIME', 15) == __fx`) === true,
    'SetEmitterParam returns the effect (chaining)',
  )
  // effectutilities.lua:516 / unit.lua:2603: POSITION_Z is the same slot
  // OffsetEmitter accumulates on.
  host.eval(`__fx:SetEmitterParam('POSITION_Z', 0.45):OffsetEmitter(0, 0, 0.1):ScaleEmitter(2)`)
  // effectutilities.lua:355: a constant curve with a spread.
  host.eval(`__fx:SetEmitterCurveParam('X_POSITION_CURVE', 0, 3)`)
  // The blueprint's EmitRateCurve spans XRange 20; resized to 40 ticks
  // every key time doubles.
  const before = host.pull<{ XRange: number; Keys: { x: number; y: number; z: number }[] }>(
    `__jsonVal(__registered.Emitter['/effects/emitters/destruction_explosion_fire_plume_02_emit.bp'].EmitRateCurve)`,
  )
  host.eval(`__fx:ResizeEmitterCurve('EMITRATE_CURVE', 40)`)
  interface FxRow {
    id: number
    bp: string
    scale: number
    ox?: number
    oy?: number
    oz?: number
    params?: Record<string, number>
    curves?: Record<string, { XRange: number; Keys: [number, number, number][] }>
  }
  const row = (): FxRow | undefined =>
    host.pull<FxRow[]>('__readAllEmittersJson()').find((r) => r.bp.includes('fire_plume_02'))
  const r = row()
  check(r !== undefined, 'the emitter has a row')
  check(r?.params?.REPEATTIME === 15 && r?.params?.LIFETIME === 15, `REPEATTIME/LIFETIME reach the row (${JSON.stringify(r?.params)})`)
  check(Math.abs((r?.oz ?? 0) - 0.55) < 1e-6, `POSITION_Z 0.45 plus OffsetEmitter 0.1 = oz 0.55 (${r?.oz})`)
  check(r?.scale === 2, `ScaleEmitter is the SCALE slot (${r?.scale})`)
  check(
    JSON.stringify(r?.curves?.XPosCurve?.Keys) === JSON.stringify([[0, 0, 3]]),
    `SetEmitterCurveParam installs the single key {0, height, size} (${JSON.stringify(r?.curves?.XPosCurve)})`,
  )
  const resized = r?.curves?.EmitRateCurve
  check(
    resized !== undefined &&
      resized.XRange === 40 &&
      resized.Keys.length === before.Keys.length &&
      resized.Keys.every((k, i) => Math.abs(k[0] - before.Keys[i]!.x * (40 / before.XRange)) < 1e-4 && k[1] === before.Keys[i]!.y),
    `ResizeEmitterCurve scales the key times by 40 / ${before.XRange} and keeps the values (${JSON.stringify(resized?.Keys.slice(0, 2))} from ${JSON.stringify(before.Keys.slice(0, 2))})`,
  )
  // SetEmitterParam('SCALE') is the same slot as ScaleEmitter.
  host.eval(`__fx:SetEmitterParam('SCALE', 3)`)
  check(row()?.scale === 3, 'SetEmitterParam SCALE writes the ScaleEmitter slot')
  // The engine's errors: an unknown name, the argument counts.
  const e1 = err(`__fx:SetEmitterParam('FOO', 1)`)
  check(e1.includes('Invalid Effect Parameter FOO'), `unknown parameter: ${e1.split('\n')[0]}`)
  const e2 = err(`__fx:SetEmitterCurveParam('FOO', 0, 1)`)
  check(e2.includes('Invalid Emitter Curve Parameter FOO'), `unknown curve: ${e2.split('\n')[0]}`)
  const e3 = err(`__fx:SetEmitterParam('LIFETIME')`)
  check(e3.includes('expected 3 args'), `SetEmitterParam wants three arguments: ${e3.split('\n')[0]}`)
  const e4 = err(`__fx:OffsetEmitter(1, 2)`)
  check(e4.includes('expected 4 args'), `OffsetEmitter wants four: ${e4.split('\n')[0]}`)
  const e5 = err(`__fx:ResizeEmitterCurve('EMITRATE_CURVE')`)
  check(e5.includes('expected 3 args'), `ResizeEmitterCurve wants three: ${e5.split('\n')[0]}`)
  // Case-insensitive names (sub_8D9FD0, 1382386-1382398).
  check(err(`__fx:SetEmitterParam('lifetime', 12)`) === '' && row()?.params?.LIFETIME === 12, 'the name lookup ignores case')
  // SetBeamParam on a beam effect: the EBeamParam table.
  host.eval(`__beam = CreateBeamEmitterOnEntity(__units[${u}], -1, 1, '/effects/emitters/aeon_build_beam_01_emit.bp'); __beam:SetBeamParam('THICKNESS', 0.5)`)
  const b = host.pull<FxRow[]>('__readAllEmittersJson()').find((x) => x.bp.includes('aeon_build_beam_01'))
  check((b as { beam?: Record<string, number> } | undefined)?.beam?.THICKNESS === 0.5, `SetBeamParam reaches the row (${JSON.stringify((b as { beam?: unknown } | undefined)?.beam)})`)
  const e6 = err(`__beam:SetBeamParam('FOO', 1)`)
  check(e6.includes('Invalid Effect Parameter FOO'), `unknown beam parameter: ${e6.split('\n')[0]}`)
}

await game.close()
console.log(failures === 0 ? '\nSIM ENTITIES PASSED' : `\nSIM ENTITIES FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
