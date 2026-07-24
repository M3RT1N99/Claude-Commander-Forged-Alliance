/**
 * Adjacency — `Moho::Unit::CollectAllOverlapping` (Cfile:62d460) and
 * `Moho::Unit::OverlapsWith` (Cfile:62d2b0).
 *
 * When an immobile unit comes into being, the engine collects every
 * overlapping structure of the SAME ARMY within 20 ogrids and runs the Lua
 * callback on both sides (Cfile:953563/953568):
 *
 *   new:OnAdjacentTo(other, new)
 *   other:OnAdjacentTo(new, new)
 *
 * That callback IS the adjacency bonus: StructureUnit.OnAdjacentTo
 * (defaultunits.lua:357) applies every buff of `AdjacencyBuffs[bp.Adjacency]`
 * to the neighbour. It never fired before, so a power generator next to a
 * factory did nothing — one of FA's core mechanics was missing.
 *
 * The suite also guards the footprint the skirt rect is built from: the engine
 * fills `Footprint.SizeX` with ceil(SizeX) when the blueprint leaves it at 0
 * (Cfile:647164-647177); with 0 there every skirt sat half a footprint off.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-adjacency.ts
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
setTerrainSource(host, () => 20)
for (const id of ['uel0001', 'ueb1101', 'ueb0101']) await game.giveUnit(host, id)

console.log('\n== The footprint the engine derives (Cfile:647164-647177) ==')
{
  const fp = String(
    host.eval(`
      local bp = __registered.Unit['ueb1101']
      return bp.SizeX .. '|' .. bp.Footprint.SizeX .. '|' .. bp.Footprint.SizeZ
    `),
  )
  check(fp === '0.6|1|1', `ueb1101 SizeX 0.6 -> Footprint 1x1 (${fp})`)
  const fac = String(
    host.eval(`
      local bp = __registered.Unit['ueb0101']
      return bp.SizeX .. '|' .. bp.Footprint.SizeX
    `),
  )
  console.log(`  · ueb0101 SizeX/Footprint = ${fac}`)
}

console.log('\n== The skirt rect (Cfile:51ec50) ==')
{
  const pgen = spawnLuaUnit(host, 'ueb1101', { x: 100, y: 20, z: 100 }, 1)
  for (let i = 0; i < 4; i++) beat(engine)
  // SkirtOffset -0.5, SkirtSize 2, Footprint 1 -> lower corner 100 - 0.5 = 99.5
  // truncated to 99, plus the offset -0.5 = 98.5 .. 100.5 in the ENGINE
  // variant; the Lua variant (unit.lua:240) does not truncate.
  const rect = (
    host.eval(
      `local a,b,c,d = __units[${pgen}]:GetSkirtRect() return string.format('%d,%d,%d,%d', a, b, c, d)`,
    ) as string
  )
  check(rect === '99,99,101,101', `unit.lua GetSkirtRect = ${rect} (Footprint now 1, not 0)`)
}

console.log('\n== A power generator next to a factory (defaultunits.lua:357) ==')
{
  // The factory's skirt: SkirtOffsetX/Z and SkirtSizeX/Z from its blueprint.
  const fac = spawnLuaUnit(host, 'ueb0101', { x: 200, y: 20, z: 200 }, 1)
  for (let i = 0; i < 6; i++) beat(engine)
  const facRect = String(
    host.eval(`local a,b,c,d = __units[${fac}]:GetSkirtRect() return a..','..b..','..c..','..d`),
  )
  console.log(`  · factory skirt: ${facRect}`)
  const [fx0, fz0, fx1] = facRect.split(',').map(Number) as [number, number, number, number]

  // Put the generator so its skirt touches the factory's left edge and its Z
  // range sits INSIDE the factory's (the engine demands containment on the
  // other axis, Cfile:62d42b).
  const gx = fx0 - 1
  const gz = fz0 + 2
  const pg = spawnLuaUnit(host, 'ueb1101', { x: gx, y: 20, z: gz }, 1)
  for (let i = 0; i < 6; i++) beat(engine)
  const pgRect = String(
    host.eval(`local a,b,c,d = __units[${pg}]:GetSkirtRect() return a..','..b..','..c..','..d`),
  )
  console.log(`  · generator skirt: ${pgRect} (factory x0 = ${fx0}, x1 = ${fx1})`)

  check(
    host.eval(`return __units[${pg}].__bp.Adjacency`) === 'T1PowerGeneratorAdjacencyBuffs',
    `ueb1101 carries Adjacency = ${host.eval(`return tostring(__units[${pg}].__bp.Adjacency)`)}`,
  )

  // OnAdjacentTo has run on both sides -> the factory carries the buffs.
  const buffs = String(
    host.eval(`
      local u = __units[${fac}]
      if not u.Buffs or not u.Buffs.BuffTable then return 'NO BUFF TABLE' end
      local names = {}
      for buffType, entries in pairs(u.Buffs.BuffTable) do
        for name in pairs(entries) do names[#names + 1] = name end
      end
      table.sort(names)
      return table.concat(names, ',')
    `),
  )
  check(buffs !== 'NO BUFF TABLE', 'the factory has a buff table (unit.lua OnPreCreate)')
  check(
    buffs.includes('EnergyBuildBonus') || buffs.includes('Energy'),
    `and it received the generator's adjacency buffs: ${buffs || '(none)'}`,
  )

  const adjacencyWarnings = warnings.filter((w) => /OnAdjacentTo|Buff/i.test(w))
  check(
    adjacencyWarnings.length === 0,
    `no error in the adjacency chain (${adjacencyWarnings.slice(0, 2).join(' | ')})`,
  )
}

console.log('\n== Not adjacent: too far away, or the wrong army ==')
{
  const far1 = spawnLuaUnit(host, 'ueb0101', { x: 400, y: 20, z: 400 }, 1)
  const far2 = spawnLuaUnit(host, 'ueb1101', { x: 460, y: 20, z: 400 }, 1)
  for (let i = 0; i < 6; i++) beat(engine)
  const buffs = String(
    host.eval(`
      local u = __units[${far1}]
      local n = 0
      for _, entries in pairs((u.Buffs or {}).BuffTable or {}) do
        for _ in pairs(entries) do n = n + 1 end
      end
      return tostring(n)
    `),
  )
  check(buffs === '0', `60 ogrids apart -> no buffs (${buffs}), unit ${far2} ignored`)

  // Same spot, but a different army: the engine requires the SAME army
  // (Cfile:62d5ae).
  const enemyFac = spawnLuaUnit(host, 'ueb0101', { x: 600, y: 20, z: 600 }, 2)
  for (let i = 0; i < 4; i++) beat(engine)
  const facRect = String(
    host.eval(`local a,b,c,d = __units[${enemyFac}]:GetSkirtRect() return a..','..b..','..c..','..d`),
  )
  const [ex0, ez0] = facRect.split(',').map(Number) as [number, number, number, number]
  spawnLuaUnit(host, 'ueb1101', { x: ex0 - 1, y: 20, z: ez0 + 2 }, 1)
  for (let i = 0; i < 6; i++) beat(engine)
  const enemyBuffs = String(
    host.eval(`
      local u = __units[${enemyFac}]
      local n = 0
      for _, entries in pairs((u.Buffs or {}).BuffTable or {}) do
        for _ in pairs(entries) do n = n + 1 end
      end
      return tostring(n)
    `),
  )
  check(enemyBuffs === '0', `an enemy generator gives no bonus (${enemyBuffs} buffs)`)
}

await game.close()
console.log(failures === 0 ? '\nADJACENCY PASSED' : `\nADJACENCY FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
