/**
 * The texture scrollers (CTextureScroller, Cfile:1110823-1111068) against the
 * engine: the four bindings (cfunc_EntityAdd*ScrollerL, Cfile:935407-935760),
 * Entity::AddScroller's freeze/reset rules, and the three tick modes --
 * thread (motion derived), manual and ping-pong -- plus the real chain from
 * the motion events through unit.lua's CreateTreads (unit.lua:2621-2624).
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-scrollers.ts
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
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps

const game = await GameFiles.open()
const warnings: string[] = []
const host = await LuaHost.create(game.luaFiles, (level, message) => {
  if (level === 'WARN') warnings.push(message)
})
const engine = installEngine(host)
setTerrainSource(host, () => 20, FLAT_TEST_MAP_SIZE)
await game.giveUnit(host, 'uel0001')
await game.giveUnit(host, 'uel0201')

const scroll = (id: number): number[] =>
  (host.eval(`local r = __scrollerRow(__units[${id}]); return r and (r[1] .. ',' .. r[2] .. ',' .. r[3] .. ',' .. r[4]) or ''`) as string)
    .split(',')
    .map(Number)
const scrollerType = (id: number): string =>
  host.eval(`local sc = __units[${id}].__scroller; return sc and sc.spec.type or 'nil'`) as string
const posZ = (id: number): number => Number(host.eval(`return __units[${id}].__pos[3]`))
const err = (expression: string): string =>
  host.eval(`local ok, e = pcall(function() ${expression} end); return ok and '' or tostring(e)`) as string

console.log('\n== The bindings check their arguments like the engine ==')
{
  const u = spawnLuaUnit(host, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
  check(err(`__units[${u}]:AddThreadScroller(1.0)`).includes('expected 3 args, but got 2'), 'AddThreadScroller with one number is the arg-count error (Cfile:935509-935510)')
  check(err(`__units[${u}]:AddManualScroller(1, 'x')`).includes('number expected but got string'), 'AddManualScroller with a string is the type error (935437-935439)')
  check(err(`__units[${u}]:AddPingPongScroller(1, 2, 3)`).includes('expected 9 args, but got 4'), 'AddPingPongScroller with three numbers is the arg-count error (935604-935605)')
  check(err(`__units[${u}]:RemoveScroller(1)`).includes('expected 1 args, but got 2'), 'RemoveScroller with an argument is the arg-count error (935748-935749)')
  check(host.eval(`return __scrollerRow(__units[${u}]) == nil`) === true, 'a unit without a scroller has no scroll row (no CTextureScroller yet)')
}

console.log('\n== The thread scroller follows the motion: both treads scroll by distance * scrollMult ==')
{
  // The ACU faces +z at spawn (heading 0) and drives straight north, so
  // both tread points move the same distance.
  const u = spawnLuaUnit(host, 'uel0001', { x: 200, y: 20, z: 100 }, 1)
  host.eval(`__units[${u}]:AddThreadScroller(1.0, 0.2)`)
  const s0 = scroll(u)
  check(s0.length === 4 && s0.every((v) => v === 0), 'a fresh scroller starts at zero (CTextureScroller ctor 913851-913855, entity data 700652)')
  beat(engine)
  check(scroll(u).every((v) => v === 0), 'standing still scrolls nothing (the tick compares the transforms, 1110911)')
  host.eval(`__units[${u}]:GetNavigator():SetGoal({ 200, 20, 160 })`)
  for (let i = 0; i < 2; i++) beat(engine)
  // The original Lua's own bookkeeping: a unit whose movement effects have no
  // treads calls RemoveScroller on its first Cruise (unit.lua:2476-2479).
  check(scrollerType(u) === 'None', "the ACU's movement effects removed the scroller on the first Cruise (unit.lua:2479) -- the freeze rule")
  const preStep = Number(host.eval(`return __units[${u}].__speed`))
  host.eval(`__units[${u}]:AddThreadScroller(1.0, 0.2)`)
  const zAdd = posZ(u)
  for (let i = 0; i < 20; i++) beat(engine)
  const moved = posZ(u) - zAdd
  const s = scroll(u)
  check(moved > 1, `the unit drove north ${moved.toFixed(3)} m since the scroller was added`)
  // The scroller ticks BEFORE the motion of its tick (Entity::TaskTick,
  // 916177-916179, then MotionTick) and compares the entity's current
  // transform with its previous one: it has scrolled the distance up to the
  // previous tick (this tick's step is still ahead of it), and its first
  // tick already covered the step before the scroller existed.
  const lastStep = Number(host.eval(`return __units[${u}].__speed`))
  const expected = (moved - lastStep + preStep) * 0.2
  check(near(s[2]!, expected, 1e-4) && near(s[3]!, expected, 1e-4), `both treads scrolled (distance - this tick's step) * 0.2 = ${expected.toFixed(4)} (x ${s[2]!.toFixed(4)}, y ${s[3]!.toFixed(4)})`)
  check(s[0]! < s[2]! && near(s[2]! - s[0]!, Number(host.eval(`return __units[${u}].__speed`)) * 0.2, 1e-6), "mScroll1 lags mScroll2 by this tick's increment (the interpolation pair, 1110932-1110933)")
  // A turn: the outer tread scrolls more than the inner one.
  host.eval(`__units[${u}]:GetNavigator():SetGoal({ 240, 20, __units[${u}].__pos[3] })`)
  const before = scroll(u)
  for (let i = 0; i < 6; i++) beat(engine)
  const after = scroll(u)
  const dx = after[2]! - before[2]!
  const dy = after[3]! - before[3]!
  check(Math.abs(dx - dy) > 1e-4, `turning east scrolls the treads unequally (+side ${dx.toFixed(4)}, -side ${dy.toFixed(4)})`)
  // RemoveScroller freezes the scroll.
  host.eval(`__units[${u}]:RemoveScroller()`)
  const frozen = scroll(u)
  check(near(frozen[0]!, frozen[2]!) && near(frozen[1]!, frozen[3]!), 'RemoveScroller sets mScroll2 = mScroll1 (Entity::AddScroller, 1110838-1110840)')
  for (let i = 0; i < 5; i++) beat(engine)
  const still = scroll(u)
  check(near(still[2]!, frozen[2]!) && near(still[3]!, frozen[3]!), 'and the scroll stays put while the unit keeps driving (Tick: default -> return)')
}

console.log('\n== The manual scroller adds its speeds every tick ==')
{
  const u = spawnLuaUnit(host, 'uel0001', { x: 300, y: 20, z: 100 }, 1)
  host.eval(`__units[${u}]:AddManualScroller(0.05, -0.02)`)
  for (let i = 0; i < 4; i++) beat(engine)
  const s = scroll(u)
  check(near(s[2]!, 0.2) && near(s[3]!, -0.08) && near(s[0]!, 0.15) && near(s[1]!, -0.06), `after four ticks mScroll2 = (0.2, -0.08), mScroll1 one step behind (${s.map((v) => v.toFixed(3)).join(', ')}) (1110901-1110908)`)
}

console.log('\n== The ping-pong scroller dwells floor(speed * 10) ticks per side ==')
{
  const u = spawnLuaUnit(host, 'uel0001', { x: 400, y: 20, z: 100 }, 1)
  host.eval(`__units[${u}]:AddPingPongScroller(1, 0.3, 2, 0.5, 10, 0.2, 20, 0.2)`)
  beat(engine)
  let s = scroll(u)
  check(s[2] === 1 && s[3] === 10 && s[0] === 1 && s[1] === 10, `the first tick flips both channels to ping (${s.join(',')}) -- AddScroller zeroes dir and countdown (1110831-1110836)`)
  beat(engine)
  beat(engine)
  s = scroll(u)
  check(s[2] === 1 && s[3] === 20, `channel 2 (dwell 0.2 s = 2 ticks) is on pong after two more ticks, channel 1 (0.3 s = 3) still on ping (${s.join(',')})`)
  beat(engine)
  s = scroll(u)
  check(s[2] === 2 && s[3] === 20, `channel 1 flips to pong on its third tick (${s.join(',')})`)
  for (let i = 0; i < 5; i++) beat(engine)
  s = scroll(u)
  check(s[2] === 1, `channel 1 returns to ping after the pong dwell of 0.5 s = 5 ticks (${s.join(',')})`)
}

console.log('\n== The real chain: a driving tank hangs its treads on the scroller (unit.lua CreateTreads) ==')
{
  // uel0201_unit.bp:94-96: Display.MovementEffects.Land.Treads { ScrollTreads
  // = true, ScrollMultiplier = 0.75 }. The motion event Stopped -> Cruise runs
  // unit.lua's UpdateMovementEffectsOnMotionEventChange -> CreateMovementEffects
  // -> CreateTreads -> AddThreadScroller(1.0, 0.75) (unit.lua:2621-2624).
  const tank = spawnLuaUnit(host, 'uel0201', { x: 500, y: 20, z: 100 }, 1)
  for (let i = 0; i < 3; i++) beat(engine)
  check(host.eval(`return __scrollerRow(__units[${tank}]) == nil`) === true, 'a parked tank has no scroller yet')
  // Straight ahead (+z, the spawn heading): no turn, equal treads.
  host.eval(`__units[${tank}]:GetNavigator():SetGoal({ 500, 20, 150 })`)
  for (let i = 0; i < 15; i++) beat(engine)
  check(
    host.eval(`local sc = __units[${tank}].__scroller; return sc ~= nil and sc.spec.type == 'Thread' and sc.spec.sideDist == 1 and sc.spec.scrollMult == 0.75`) === true,
    "driving created the thread scroller from the blueprint's Treads table (ScrollMultiplier 0.75)",
  )
  const moved = posZ(tank) - 100
  const s = scroll(tank)
  check(s[2]! > 0 && near(s[2]!, s[3]!, 1e-6), `and both treads have scrolled ${s[2]!.toFixed(3)} for ${moved.toFixed(3)} m driven`)
  // The sync row carries the pair for the renderer.
  const row = host.eval(`for _, r in ipairs(__readAllUnits()) do if r.id == ${tank} then return r.scroll and (r.scroll[1] .. ',' .. r.scroll[3]) or 'none' end end return 'missing'`) as string
  check(row !== 'none' && row !== 'missing', `the unit row carries the scroll pair (${row})`)
  const json = host.eval(`return __readAllUnitsJson()`) as string
  check(json.includes('"scroll":['), 'and the JSON row serialises it for the renderer')
}

host.close()
await game.close()
console.log(failures === 0 ? '\nSCROLLERS PASSED' : `\nSCROLLERS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
