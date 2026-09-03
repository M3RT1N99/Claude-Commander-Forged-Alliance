/**
 * CreateLightParticle / CreateLightParticleIntel against the engine
 * (cfunc_CreateLightParticleL Cfile:908818-908944, CEffectManagerImpl::
 * CreateLightParticle 905874-906033): the argument checks, the one-shot
 * spawn at the bone's world point, the texture default, the ramp gate and
 * the per-beat drain the browser consumes.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-light-particles.ts
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
const warnings: string[] = []
const host = await LuaHost.create(game.luaFiles, (level, message) => {
  if (level === 'WARN') warnings.push(message)
})
const engine = installEngine(host)
setTerrainSource(host, () => 20, FLAT_TEST_MAP_SIZE)
await game.giveUnit(host, 'uel0001')
const u = spawnLuaUnit(host, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
const err = (expression: string): string =>
  host.eval(`local ok, e = pcall(function() ${expression} end); return ok and '' or tostring(e)`) as string
const drain = (): unknown[] => JSON.parse(host.eval(`return __drainLightParticlesJson()`) as string) as unknown[]

console.log('\n== The binding checks its arguments like the engine ==')
drain()
check(err(`CreateLightParticle(__units[${u}], -2, 1, 2, 10, 'glow_03')`).includes('expected 7 args, but got 6'), 'six arguments is the arg-count error (Cfile:908832-908834)')
check(err(`CreateLightParticle(__units[${u}], -2, 1, 'x', 10, 'glow_03', 'ramp_flare_02')`).includes('number expected'), 'a non-number size is the type error (908871-908884)')
check(err(`CreateLightParticle(__units[${u}], 'NoSuchBone', 1, 2, 10, 'glow_03', 'ramp_flare_02')`).includes('Invalid bone name'), 'an unknown bone name is the engine error (908847)')
check(err(`CreateLightParticle(__units[${u}], -3, 1, 2, 10, 'glow_03', 'ramp_flare_02')`).includes('must be bettern -2'), 'the pseudo bones -1/-2 are admitted, -3 is not (ResolveBoneIndex with 1)')
check(drain().length === 0, 'none of the refused calls spawned anything')

console.log('\n== A light particle is spawned once, at the bone, only with a ramp ==')
host.eval(`CreateLightParticle(__units[${u}], -2, 1, 2.5, 12, 'glow_03', 'ramp_flare_02')`)
let lights = drain() as { x: number; y: number; z: number; size: number; life: number; tex: string; ramp: string; army: number; tick: number }[]
check(lights.length === 1, `one entry after one call (${lights.length})`)
const l = lights[0]
check(l !== undefined && l.x === 100 && l.y === 20 && l.z === 100, `at the entity's own point for bone -2 (${l?.x}, ${l?.y}, ${l?.z}) -- GetBoneWorldTransform, 908848`)
check(l !== undefined && l.size === 2.5 && l.life === 12, `size and lifetime raw (${l?.size}, ${l?.life}) -- mBeginSize = mEndSize = size, 906019-906020; mLifetime 905915`)
check(l !== undefined && l.tex === '/textures/particles/glow_03.dds' && l.ramp === '/textures/particles/ramp_flare_02.dds', `the names become /textures/particles/<name>.dds (${l?.tex}, ${l?.ramp})`)
check(l !== undefined && l.army === 1 && l.tick === Number(host.eval('return __gameTick')), 'army and the spawn tick travel with it')
check(drain().length === 0, 'the drain empties the list (a one-shot record, like the engine push into the buffer)')
host.eval(`CreateLightParticle(__units[${u}], -1, 1, 1, 5, 'glow_03', 'ramp_flare_02')`)
lights = drain() as typeof lights
check(lights.length === 1 && lights[0]!.y > 20, `bone -1 spawns at the collision centre (y ${lights[0]?.y})`)
host.eval(`CreateLightParticle(__units[${u}], -2, 1, 1, 5, '', 'ramp_flare_02')`)
lights = drain() as typeof lights
check(lights.length === 1 && lights[0]!.tex === '/textures/particles/beam_white_01.dds', 'an empty texture name falls back to beam_white_01.dds (905916-905928)')
host.eval(`CreateLightParticle(__units[${u}], -2, 1, 1, 5, 'glow_03', '')`)
host.eval(`CreateLightParticle(__units[${u}], -2, 1, 1, 5, 'glow_03', nil)`)
check(drain().length === 0, 'without a ramp nothing is spawned -- the push sits inside `if (ramp->_Mysize)` (905929-906023)')
host.eval(`CreateLightParticleIntel(__units[${u}], -2, 1, 1, 5, 'glow_03', 'ramp_flare_02')`)
check(drain().length === 1, 'the Intel variant spawns too (no recon model: always in sight here, docs/STATUS.md)')
beat(engine)
check(drain().length === 0, 'a beat does not resurrect drained entries')

host.close()
await game.close()
console.log(failures === 0 ? '\nLIGHT PARTICLES PASSED' : `\nLIGHT PARTICLES FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
