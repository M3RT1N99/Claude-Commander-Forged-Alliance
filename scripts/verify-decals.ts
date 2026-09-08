// Splats and decals: CreateSplat / CreateDecal / CreateSplatOnBone (Sim
// only) build an SDecalInfo (Cfile:907248-907282, CDecal::CDecal
// 907293-907423) that the render thread turns into a CWldSplat or a
// CWldTerrainDecal (CDecalManager::AddDecals 1305857-1306038). The sim
// keeps a registry the renderer drains per beat -- adds and removals --
// and sweeps expired handles like CDecalBuffer (1112362-1112600).
//
//   npx tsx --import ./scripts/register-lua.mjs scripts/verify-decals.ts
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
const near = (a: number, b: number, eps = 1e-3): boolean => Math.abs(a - b) < eps

interface DecalRow {
  id: number
  x: number
  y: number
  z: number
  heading: number
  sx: number
  sz: number
  tex1: string
  tex2: string
  type: string
  lod: number
  expire: number
  army: number
  fidelity: number
  splat: boolean
  tick: number
}

const game = await GameFiles.open()
const host = await LuaHost.create(game.luaFiles, () => {})
const engine = installEngine(host)
setTerrainSource(host, () => 20, FLAT_TEST_MAP_SIZE)
await game.giveUnit(host, 'ueb1101')
const u = spawnLuaUnit(host, 'ueb1101', { x: 100, y: 20, z: 100 }, 1)
for (let i = 0; i < 4; i++) beat(engine)

const adds = (): DecalRow[] => host.pull<DecalRow[]>('__drainDecalAddsJson()')
const removals = (): number[] => host.pull<number[]>('__drainDecalRemovalsJson()')
const alive = (): number => Number(host.eval('local n = 0 for _ in pairs(__decals) do n = n + 1 end return n'))
const tick = (): number => Number(host.eval('return __gameTick'))
const err = (expression: string): string =>
  host.eval(`local ok, e = pcall(function() ${expression} end); return ok and '' or tostring(e)`) as string

console.log('\n== The tarmac: the original CreateTarmac lays two decals under a power generator ==')
{
  // Nothing before: a fresh sim has no decals queued.
  adds()
  removals()
  // aibrain.lua:459 / :469 call this for every FlattenSkirt structure it
  // places; defaultunits.lua:75-156 turns the blueprint's Tarmacs block
  // (ueb1101_unit.bp:71-87: Tar6x_01 albedo + normals, 6.4 x 6.4,
  // FadeOut 150, lifeTime 0) into CreateDecal calls with the types
  // 'Albedo' and 'Alpha Normals' (no Glow entry, so no third call).
  host.eval(`__units[${u}]:CreateTarmac(true, true, true, false, false)`)
  const rows = adds()
  check(rows.length === 2, `CreateTarmac queued two decals (${rows.length})`)
  const albedo = rows.find((r) => r.type === 'Albedo')
  const normals = rows.find((r) => r.type === 'Alpha Normals')
  check(albedo !== undefined && normals !== undefined, 'one Albedo and one Alpha Normals decal')
  check(
    albedo?.tex1 === '/env/common/decals/Tarmacs/Tar6x_01_albedo.dds',
    `the bare texture name resolves under /env/common/decals/ with .dds (CDecalManager::AddDecals, Cfile:1305895-1305930): ${albedo?.tex1}`,
  )
  check(normals?.tex1 === '/env/common/decals/Tarmacs/Tar6x_01_normals.dds', `the normals decal names its own texture (${normals?.tex1})`)
  check(albedo?.tex2 === '', `no second texture: '' stays '' (${JSON.stringify(albedo?.tex2)})`)
  check(game.exists('env/common/decals/tarmacs/tar6x_01_albedo.dds'), 'the resolved albedo file exists in the game files')
  check(near(albedo?.sx ?? 0, 6.4) && near(albedo?.sz ?? 0, 6.4), `size 6.4 x 6.4 from the Tarmacs block (${albedo?.sx} x ${albedo?.sz})`)
  check(albedo?.lod === 150, `lodParam 150 = FadeOut (${albedo?.lod})`)
  check(albedo?.expire === 0, `lifeTime 0 never expires (expire ${albedo?.expire})`)
  check(albedo?.army === 1 && albedo?.fidelity === 0, `army 1, fidelity 0 as passed (${albedo?.army}, ${albedo?.fidelity})`)
  check(albedo?.splat === false, 'a decal is not a splat')
  const deg = ((albedo?.heading ?? -1) / 0.01745)
  check([0, 90, 180, 270].some((d) => near(deg, d, 0.01)), `the orientation is one of the block's four (${deg.toFixed(2)} deg, defaultunits.lua:103-104)`)
  // CDecal::CDecal stores the footprint's corner (Cfile:907380-907400):
  // the corner plus half the rotated size is the unit's position again.
  const centre = (r: DecalRow | undefined): [number, number] => {
    if (!r) return [NaN, NaN]
    const c = Math.cos(r.heading)
    const s = Math.sin(r.heading)
    return [r.x + 0.5 * (r.sx * c + r.sz * s), r.z + 0.5 * (-r.sx * s + r.sz * c)]
  }
  const [cx, cz] = centre(albedo)
  check(near(cx, 100) && near(cz, 100), `the footprint is centred on the unit's position (corner ${albedo?.x}, ${albedo?.z} -> centre ${cx.toFixed(3)}, ${cz.toFixed(3)})`)
  check(!near(albedo?.x ?? 0, 100) || !near(albedo?.z ?? 0, 100), 'the stored position is the corner, not the centre')
  check(alive() === 2, `the registry holds the two (${alive()})`)
  check(adds().length === 0, 'the add queue is empty after draining')
  // DestroyTarmac (defaultunits.lua:159-167) destroys the handles:
  // cfunc_CDecalHandleDestroyL (Cfile:908061-908075) removes them from the
  // buffer; the render side gets them as removals.
  host.eval(`__units[${u}]:DestroyTarmac()`)
  const gone = removals().sort((a, b) => a - b)
  const ids = rows.map((r) => r.id).sort((a, b) => a - b)
  check(JSON.stringify(gone) === JSON.stringify(ids), `both handles reach the removal queue (${JSON.stringify(gone)})`)
  check(alive() === 0, 'the registry is empty again')
  check(removals().length === 0, 'the removal queue is empty after draining')
}

console.log('\n== CreateSplat / CreateDecal: the arguments as the bindings parse them ==')
{
  const t0 = tick()
  // cfunc_CreateSplatL (Cfile:908309-908450): 8-9 args, fidelity defaults
  // to 1, texName2 and type are '' and isSplat = 1 -- and it returns
  // nothing (908425-908460); only CreateDecal hands out a handle.
  check(
    host.eval(`return select('#', CreateSplat({100, 20, 100}, 0.5, 'tank_treads_albedo', 3, 4, 100, 15, 1))`) === 0,
    'CreateSplat returns no value',
  )
  const [s] = adds()
  check(s !== undefined && s.splat === true, 'CreateSplat queues a splat')
  check(s?.tex1 === '/env/common/splats/tank_treads_albedo.dds', `the splat name resolves under /env/common/splats/ (${s?.tex1})`)
  check(game.exists('env/common/splats/tank_treads_albedo.dds'), 'the tread splat file exists in the game files')
  check(s?.tex2 === '' && s?.type === '', `a splat has no second texture and no type (${JSON.stringify(s?.tex2)}, ${JSON.stringify(s?.type)})`)
  check(near(s?.sx ?? 0, 3) && near(s?.sz ?? 0, 4) && s?.lod === 100, `size 3 x 4, lod 100 (${s?.sx} x ${s?.sz}, ${s?.lod})`)
  check(near(s?.heading ?? 0, 0.5), `heading as given (${s?.heading})`)
  check(s?.expire === t0 + 150, `expiry = duration * 10 + the current tick (CDecal::CDecal 907344-907360): ${s?.expire} vs ${t0 + 150}`)
  check(s?.fidelity === 1, `fidelity defaults to 1 (${s?.fidelity})`)
  check(s?.army === 1 && s?.tick === t0, `army and creation tick (${s?.army}, ${s?.tick})`)
  // 2.06 seconds: frndint gives 21, the value is below it, so one is taken
  // off again (907352-907356) -- the truncated 20 ticks, not the rounded 21.
  host.eval(`CreateSplat({10, 20, 10}, 0, 'scorch_001_albedo', 2, 2, 100, 2.06, 1)`)
  const [s2] = adds()
  check(s2?.expire === t0 + 20, `truncation, not rounding: 2.06 s -> 20 ticks (${s2?.expire} vs ${t0 + 20})`)
  // An absolute name (leading '/') is taken as is (AddDecals: FILE_HasUNC /
  // the leading separator, 1305895-1305930).
  host.eval(`__d3 = CreateDecal({50, 20, 50}, 0, '/env/Common/Splats/Scorch_002_albedo.dds', '', 'Albedo', 5, 5, 200, 0, 1)`)
  const [d3] = adds()
  check(d3?.tex1 === '/env/Common/Splats/Scorch_002_albedo.dds', `an absolute texture path stays as it is (${d3?.tex1})`)
  check(d3?.fidelity === 1 && d3?.type === 'Albedo', `CreateDecal: fidelity defaults to 1, the type string is kept (${d3?.fidelity}, ${d3?.type})`)
  check(host.eval(`return type(__d3) == 'table' and type(__d3.Destroy) == 'function'`) === true, 'CreateDecal returns a handle with Destroy (908270-908280)')
  check(alive() === 3, `three live handles (${alive()})`)
  // Wrong argument counts are the binding's errors.
  const e1 = err(`CreateSplat({0,0,0}, 0, 'x', 1, 1)`)
  check(e1.includes('expected between 8 and 9 args'), `CreateSplat with five arguments: ${e1.split('\n')[0]}`)
  const e2 = err(`CreateDecal({0,0,0}, 0, 'x', '', 'Albedo', 1, 1, 1)`)
  check(e2.includes('expected between 9 and 11 args'), `CreateDecal with eight arguments: ${e2.split('\n')[0]}`)
  // Destroy: the handle's only method (luadef_CDecalHandleDestroy, 908048).
  host.eval(`__d3:Destroy()`)
  check(JSON.stringify(removals()) === JSON.stringify([d3!.id]), 'Destroy on the handle queues its removal')
  check(alive() === 2, 'the destroyed handle left the registry')
  host.eval(`__d3:Destroy()`)
  check(removals().length === 0, 'a second Destroy is a no-op')
  // Expiry: the sweep drops the handle once the tick passes its expiry
  // (CDecalBuffer, 1112362-1112600); the renderer knew the tick already,
  // no removal message is sent.
  for (let i = 0; i < 21; i++) beat(engine)
  check(alive() === 1, `the 2.06 s splat expired with the sweep (${alive()} left)`)
  check(removals().length === 0, 'an expiry sends no removal (the renderer fades by the tick it was told)')
  for (let i = 0; i < 130; i++) beat(engine)
  check(alive() === 0, `the 15 s splat expired too (${alive()} left)`)
  // A decal handle outliving its record: Destroy after the sweep is a no-op.
  host.eval(`__d4 = CreateDecal({50, 20, 50}, 0, 'Crater01_albedo', '', 'Albedo', 5, 5, 200, 1, 1)`)
  adds()
  for (let i = 0; i < 11; i++) beat(engine)
  check(alive() === 0, 'the 1 s decal expired')
  host.eval(`__d4:Destroy()`)
  check(removals().length === 0, 'Destroy after expiry is a no-op')
}

console.log('\n== CreateSplatOnBone: the bone position plus the rotated offset ==')
{
  // unit.lua:2648-2649 gives the argument order (entity, offset, bone,
  // texture, sizeX, sizeZ, lodParam, duration, army); the binding takes
  // exactly nine (Cfile:908500-908502), fidelity is 1 (908573).
  check(
    host.eval(`return select('#', CreateSplatOnBone(__units[${u}], {0, 0, 2}, 0, 'tank_treads_albedo', 1.5, 2, 130, 15, 1))`) === 0,
    'CreateSplatOnBone returns no value (908610-908637)',
  )
  const [b] = adds()
  check(b !== undefined && b.splat === true && b.fidelity === 1, 'a splat with fidelity 1')
  // The generator faces heading 0: +Z offset lands at z + 2; the stored
  // corner plus half the size is that point.
  const bc = b ? [b.x + 0.5 * (b.sx * Math.cos(b.heading) + b.sz * Math.sin(b.heading)), b.z + 0.5 * (-b.sx * Math.sin(b.heading) + b.sz * Math.cos(b.heading))] : [NaN, NaN]
  check(near(bc[0]!, 100, 0.05) && near(bc[1]!, 102, 0.05), `centred on the bone plus the offset (${bc[0]?.toFixed(3)}, ${bc[1]?.toFixed(3)})`)
  check(b?.lod === 130 && near(b?.sx ?? 0, 1.5) && near(b?.sz ?? 0, 2), `lod 130, size 1.5 x 2 (${b?.lod}, ${b?.sx} x ${b?.sz})`)
  const e = err(`CreateSplatOnBone(__units[${u}], {0,0,0}, 0, 'x', 1, 1, 1, 1)`)
  check(e.includes('expected 9 args'), `eight arguments are refused: ${e.split('\n')[0]}`)
}

console.log('\n== The old path is gone: no splat rides the emitter list ==')
{
  host.eval(`CreateSplat({100, 20, 100}, 0, 'tank_treads_albedo', 3, 4, 100, 15, 1)`)
  adds()
  const emitters = host.pull<{ bp: string }[]>('__readAllEmittersJson()')
  check(!emitters.some((e) => /tank_treads/.test(e.bp)), 'a splat is not an emitter row')
}

console.log(failures === 0 ? '\nDECALS PASSED' : `\nDECALS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
