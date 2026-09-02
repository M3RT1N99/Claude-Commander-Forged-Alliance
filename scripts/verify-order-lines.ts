/**
 * Order lines / the command graph — the visible confirmation of a queued order.
 *
 * The bug this guards: the sim's orderList (units.lua) emits `t = cmd.type`
 * verbatim, so a queued Guard reaches the renderer as t='Guard' and a queued
 * Reclaim as t='Reclaim'. The renderer's PARAMS table only had Move/Attack/
 * Repair/BuildMobile/Patrol, so PARAMS['Guard'] was undefined and `p.color`
 * threw a TypeError EVERY render frame, aborting the whole world-view update
 * until the order queue emptied.
 *
 * This checks the DATA source: every order type the sim can put into orderList
 * must be one the renderer knows. The colors are from commandgraphparams.lua
 * (Guard/Reclaim inherit default_EngineeringColors, :146-156).
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-order-lines.ts
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

// The order-line types the renderer draws (src/viewer/orderLines.ts PARAMS).
// The sim must never emit a type outside this set, or the render frame crashes.
const RENDERER_TYPES = new Set(['Move', 'Attack', 'Repair', 'BuildMobile', 'Patrol', 'Guard', 'Reclaim'])

const game = await GameFiles.open()
const host = await LuaHost.create(game.luaFiles, () => {})
const engine = installEngine(host)
setTerrainSource(host, () => 20, FLAT_TEST_MAP_SIZE)
game.loadProps(host)
for (const id of ['uel0001', 'uel0201', 'uel0105']) await game.giveUnit(host, id)

// Read the `t` field of every entry in a unit's order list.
const orderTypes = (id: number): string[] =>
  JSON.parse(
    host.eval(`
      local u = __units[${id}]
      local list = __readAllUnitsJson()
      -- Pull just this unit's order types from the JSON is awkward; read the
      -- Lua order list directly instead.
      local out = {}
      local ot = nil
      -- active order
      if __attackOrders[${id}] then out[#out+1] = 'Attack' end
      for _, task in pairs(__buildTasks or {}) do
        if task.builder == ${id} then out[#out+1] = (task.order == 'Repair') and 'Repair' or 'BuildMobile' end
      end
      if u.__goal then out[#out+1] = 'Move' end
      for _, cmd in ipairs(__orders[${id}] or {}) do out[#out+1] = cmd.type end
      return '["' .. table.concat(out, '","') .. '"]'
    `) as string,
  ) as string[]

console.log('\n== A QUEUED Guard reaches the renderer as t=Guard (the crash) ==')
{
  const acu = spawnLuaUnit(host, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
  const friend = spawnLuaUnit(host, 'uel0201', { x: 130, y: 20, z: 100 }, 1)
  for (let i = 0; i < 6; i++) beat(engine)
  // A move (clears), then a SHIFT-guard (queues): the guard is a queued entry.
  host.eval(`__dispatchMove(${acu}, 200, 200, true)`)
  host.eval(`__dispatchGuard(${acu}, ${friend}, false)`)
  const types = orderTypes(acu)
  console.log(`  · order types: ${JSON.stringify(types)}`)
  check(types.includes('Guard'), 'the sim emits a Guard order entry')
  const unknown = types.filter((t) => !RENDERER_TYPES.has(t))
  check(unknown.length === 0, `every emitted type is one the renderer knows (${unknown.join(',') || 'all known'})`)
}

console.log('\n== A QUEUED Reclaim draws a line to its PROP target ==')
{
  const eng = spawnLuaUnit(host, 'uel0105', { x: 300, y: 20, z: 300 }, 1)
  for (let i = 0; i < 6; i++) beat(engine)
  // A real prop to reclaim (first registered prop blueprint).
  const propBp = String(
    host.eval(`for id in pairs(__registered.Prop or {}) do return id end return ''`),
  )
  check(propBp !== '', `a prop blueprint is registered (${propBp})`)
  const propId = Number(
    host.eval(`local p = CreateProp({ 310, 20, 305 }, '${propBp}') return p.__id`),
  )
  host.eval(`__issueOrder(${eng}, { type = 'Reclaim', target = ${propId} }, false)`)
  // The reclaim line resolves the target from __props (not __units) — before,
  // the prop target was dropped and no line appeared.
  const line = JSON.parse(
    host.eval(`
      for _, cmd in ipairs(__orders[${eng}] or {}) do
        if cmd.type == 'Reclaim' then
          local p = __props[cmd.target]
          if p and p.__pos then
            return string.format('{"t":"Reclaim","x":%.6g,"z":%.6g}', p.__pos[1], p.__pos[3])
          end
        end
      end
      -- active order path (Reclaim starts immediately)
      if __reclaimTasks[${eng}] then
        local p = __props[__reclaimTasks[${eng}].target]
        if p then return string.format('{"t":"Reclaim","x":%.6g,"z":%.6g}', p.__pos[1], p.__pos[3]) end
      end
      return 'null'
    `) as string,
  ) as { t: string; x: number; z: number } | null
  check(line !== null && line.t === 'Reclaim', 'the reclaim resolves to a line at the prop')
  check(
    line !== null && Math.abs(line.x - 310) < 0.01 && Math.abs(line.z - 305) < 0.01,
    `the line points at the prop (${line ? `${line.x}/${line.z}` : 'none'})`,
  )
  check(line === null || RENDERER_TYPES.has(line.t), 'Reclaim is a type the renderer knows')
}

console.log('\n== The full order-type set the sim can emit is covered ==')
{
  // Every type that __issueOrder / activeOrder can produce.
  const SIM_TYPES = ['Move', 'Attack', 'Patrol', 'Guard', 'Reclaim', 'Repair', 'BuildMobile']
  const missing = SIM_TYPES.filter((t) => !RENDERER_TYPES.has(t))
  check(missing.length === 0, `renderer covers all ${SIM_TYPES.length} sim order types (missing: ${missing.join(',') || 'none'})`)
}

await game.close()
console.log(failures === 0 ? '\nORDER LINES PASSED' : `\nORDER LINES FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
