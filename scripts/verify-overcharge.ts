/**
 * The overcharge: UNITCOMMAND_OverCharge as the attack task pinned to the
 * OverChargeWeapon (CUnitAttackTargetTask with the overcharge flag,
 * Cfile:812610-812640, 813121-813506), IssueOverCharge (1008066-1008140)
 * and the original weapon scripts (uel0001_script.lua's OverCharge,
 * defaultweapons.lua's economy drain) through the original blueprints.
 *
 * A UEF ACU (uel0001: OverCharge, EnergyRequired 5000, MaxRadius 22,
 * Damage 12000, RateOfFire 0.3) against an enemy T2 tank (uel0202, 1500
 * health -- a hit of more than 1000 in one beat is the overcharge, the
 * ACU's gun does about 100): the binding, the pinned weapon and its
 * OnEnableWeapon, the target, the shot that kills the tank, the weapon
 * disabled and the overcharge paused afterwards, the drain for the next
 * shot (the first needs none: EnergyChargeForFirstShot = false), the
 * approach to a far target, the abort, an allied target refused, the
 * paused flag in the unit row.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-overcharge.ts
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
const host = await LuaHost.create(game.luaFiles, (level, msg) => {
  if (level === 'WARN') warnings.push(msg)
})
const engine = installEngine(host)
setTerrainSource(host, () => 20, FLAT_TEST_MAP_SIZE)
game.loadProjectiles(host)
game.loadProps(host)
await game.giveUnit(host, 'uel0001')
await game.giveUnit(host, 'uel0201')
await game.giveUnit(host, 'ueb1105')
await game.giveUnit(host, 'uel0202')

const posOf = (id: number): number[] => host.pull<number[]>(`__jsonVal(__units[${id}]:GetPosition())`)
const queueLen = (id: number): number => Number(host.eval(`local n = __orderActive[${id}] and 1 or 0 return n + #(__orders[${id}] or {})`))
const alive = (id: number): boolean => host.eval(`local u = __units[${id}] return u ~= nil and not u.__dead and not u.__destroyQueued`) === true
const errorOf = (code: string): string => {
  try {
    host.eval(code)
    return ''
  } catch (e) {
    return String((e as Error).message)
  }
}
const log = (): string[] => {
  const l = host.pull<unknown>(`__jsonVal(__ocLog)`)
  return Array.isArray(l) ? (l as string[]) : []
}
const stored = (): number => Number(host.eval(`return GetArmyBrain(1):GetEconomyStored('ENERGY')`))
const topUp = (): void => {
  host.eval(`GetArmyBrain(1):GiveResource('ENERGY', 2000) GetArmyBrain(1):GiveResource('MASS', 50)`)
}
const taskOf = (id: number): { state: string; moving: boolean } | null =>
  host.pull(`(function() local t = __overchargeTasks[${id}] if not t then return nil end return __jsonVal({ state = t.state, moving = t.moving }) end)()`)

// Army 1: the ACU and two energy storages (14000 energy with the ACU's 4000:
// the drain of 5000 needs a store, orders.lua:651 asks for more than
// EnergyRequired stored).
const acu = spawnLuaUnit(host, 'uel0001', { x: 60, y: 20, z: 60 }, 1)
spawnLuaUnit(host, 'ueb1105', { x: 30, y: 20, z: 30 }, 1)
spawnLuaUnit(host, 'ueb1105', { x: 34, y: 20, z: 30 }, 1)
beat(engine)
for (let i = 0; i < 12; i++) {
  topUp()
  beat(engine)
}
// The OverCharge weapon's hooks, logged.
host.eval(`
  __ocLog = {}
  local u = __units[${acu}]
  for _, w in ipairs(u.__weapons) do
    if w.__bp and w.__bp.OverChargeWeapon then
      __ocWeapon = w
      for _, name in ipairs({ 'OnEnableWeapon', 'OnDisableWeapon', 'OnFire', 'OnWeaponFired' }) do
        local base = w[name]
        w[name] = function(self, ...)
          __ocLog[#__ocLog + 1] = name
          if base then return base(self, ...) end
        end
      end
    end
  end
`)
const wEnabled = (): boolean => host.eval(`return __ocWeapon.__enabled ~= false`) === true

console.log('\n== IssueOverCharge: the binding (cfunc_IssueOverChargeL, Cfile:1008066-1008140) ==')
const tank = spawnLuaUnit(host, 'uel0202', { x: 75, y: 20, z: 60 }, 2)
const ownTank = spawnLuaUnit(host, 'uel0201', { x: 200, y: 20, z: 200 }, 1)
beat(engine)
{
  check(host.eval(`return __ocWeapon ~= nil and __ocWeapon.__bp.Label == 'OverCharge'`) === true, 'uel0001 carries the OverChargeWeapon "OverCharge" (uel0001_unit.bp:975-981)')
  check(!wEnabled(), 'the weapon is disabled at rest (uel0001_script.lua OnCreate: SetWeaponEnabled(false))')
  check(errorOf(`IssueOverCharge({ __units[${acu}] })`).includes('expected 2 args'), 'one argument is the arity error')
  check(errorOf(`IssueOverCharge({ __units[${acu}] }, 7)`).includes('Expected a game object'), 'a non-entity target is the SCR_FromLua_Entity error')
  host.eval(`IssueOverCharge({ __units[${ownTank}] }, __units[${tank}])`)
  check(queueLen(ownTank) === 0, 'a tank without RULEUCC_Overcharge gets no command (func_Validate_IssueCommand 1008107)')
  check(stored() > 5000, `the army stores more than EnergyRequired (${stored().toFixed(0)})`)
}

console.log('\n== The pinned weapon, the target, the drain and the shot (Cfile:812631-812640, 813216-813490) ==')
{
  const e0 = stored()
  host.eval(`IssueOverCharge({ __units[${acu}] }, __units[${tank}])`)
  beat(engine)
  check(queueLen(acu) === 1 && taskOf(acu) !== null, 'the ACU queues one OverCharge command with the task')
  check(log().includes('OnEnableWeapon') && wEnabled(), 'the constructor ran the pinned weapon\'s OnEnableWeapon (812640); the ACU script enabled it')
  let targeted = false
  let fired = false
  let beats = 0
  for (let i = 0; i < 120 && !fired; i++) {
    beat(engine)
    beats++
    if (host.eval(`return __ocWeapon.__target == __units[${tank}]`) === true) targeted = true
    fired = log().includes('OnFire')
  }
  check(targeted, 'the weapon took the target within its attack range (UnitWeapon::SetTarget 813431)')
  check(fired, `the task fired the weapon once it could (UnitWeapon::Fire 985600; ${beats} beats)`)
  // The first shot needs no drain (EnergyChargeForFirstShot = false ->
  // FirstShot, defaultweapons.lua:81-82, 133); the salvo state prices the
  // NEXT one after firing (615-617): 5000 over 5000 / 5000 s.
  let sawDrain = false
  let minStored = stored()
  let maxDrop = 0
  let hp = Number(host.eval(`return __units[${tank}].__health`))
  for (let i = 0; i < 30; i++) {
    beat(engine)
    if (host.eval(`return __ocWeapon.EconDrain ~= nil`) === true) sawDrain = true
    const s = stored()
    if (s < minStored) minStored = s
    const h = Number(host.eval(`local t = __units[${tank}] return (t and t.__health) or 0`))
    if (hp - h > maxDrop) maxDrop = hp - h
    hp = h
  }
  check(log().includes('OnWeaponFired'), 'the salvo state reported OnWeaponFired (defaultweapons.lua:619)')
  check(maxDrop >= 1000 && !alive(tank), `the overcharge hit took the T2 tank in one beat (${maxDrop.toFixed(0)} of 1500) and killed it (Damage 12000)`)
  check(sawDrain && e0 - minStored > 4000, `the drain for the next shot took about EnergyRequired 5000 from the store (${(e0 - minStored).toFixed(0)})`)
  check(log().includes('OnDisableWeapon') && !wEnabled(), 'the ACU disabled the weapon after the shot (uel0001_script.lua OnWeaponFired -> OnDisableWeapon)')
  check(host.eval(`return __units[${acu}]:IsOverchargePaused()`) === true, 'the overcharge is paused after the shot (PauseOvercharge, SetOverchargePaused true)')
  const rows = JSON.parse(host.eval(`return __readAllUnitsJson()`) as string) as Array<{ id: number; overchargePaused?: boolean }>
  check(rows.find((r) => r.id === acu)?.overchargePaused === true, 'the unit row carries overchargePaused for the user layer (IsOverchargePaused, orders.lua:663)')
  check(queueLen(acu) === 0 && taskOf(acu) === null, 'the command completed and the task is gone (813492-813494)')
  let unpaused = false
  for (let i = 0; i < 60 && !unpaused; i++) {
    beat(engine)
    unpaused = host.eval(`return __units[${acu}]:IsOverchargePaused()`) === false
  }
  check(unpaused, 'the pause ends after 1 / RateOfFire seconds (uel0001_script.lua PauseOvercharge)')
}

console.log('\n== A far target: the approach within MaxRadius (SetWeaponGoal, Cfile:812691-812720) ==')
{
  host.eval(`__ocLog = {}`)
  const far = spawnLuaUnit(host, 'uel0202', { x: 110, y: 20, z: 60 }, 2)
  beat(engine)
  for (let i = 0; i < 12; i++) {
    topUp()
    beat(engine)
  }
  const d0 = Math.hypot(posOf(acu)[0]! - 110, posOf(acu)[2]! - 60)
  host.eval(`IssueOverCharge({ __units[${acu}] }, __units[${far}])`)
  for (let i = 0; i < 5; i++) {
    topUp()
    beat(engine)
  }
  // A mobile target that leaves the goal by more than 10 during the
  // approach renews it (813393-813410): warp the tank 15 further.
  const g0 = host.pull<number[]>(`__jsonVal(__units[${acu}].__goal)`)
  host.eval(`Warp(__units[${far}], { 125, 20, 60 })`)
  beat(engine)
  const g1 = host.pull<number[]>(`__jsonVal(__units[${acu}].__goal)`)
  check(Array.isArray(g0) && Math.abs(g0[0]! - 110) < 1e-6 && Array.isArray(g1) && Math.abs(g1[0]! - 125) < 1e-6, `the goal followed the warped target (${g0?.[0]} -> ${g1?.[0]})`)
  let fired = false
  let beats = 0
  let dAtTarget = d0
  for (let i = 0; i < 400 && !fired; i++) {
    topUp()
    beat(engine)
    beats++
    if (host.eval(`return __ocWeapon.__target == __units[${far}]`) === true && dAtTarget === d0) {
      dAtTarget = Math.hypot(posOf(acu)[0]! - 125, posOf(acu)[2]! - 60)
    }
    fired = log().includes('OnFire')
  }
  check(d0 > 22 && dAtTarget < d0 && dAtTarget <= 22.5, `the ACU closed from ${d0.toFixed(1)} to within the weapon's MaxRadius 22 before the weapon took the target (${dAtTarget.toFixed(1)})`)
  check(fired, `it fired at the far target (${beats} beats)`)
  let maxDrop = 0
  let hp = Number(host.eval(`local t = __units[${far}] return (t and t.__health) or 0`))
  for (let i = 0; i < 30; i++) {
    beat(engine)
    const h = Number(host.eval(`local t = __units[${far}] return (t and t.__health) or 0`))
    if (hp - h > maxDrop) maxDrop = hp - h
    hp = h
  }
  check(maxDrop >= 1000 && !alive(far), `the far tank took the overcharge hit and died (${maxDrop.toFixed(0)} in one beat)`)
  for (let i = 0; i < 60 && host.eval(`return __units[${acu}]:IsOverchargePaused()`) === true; i++) beat(engine)
}

console.log('\n== The abort and the refusals (the destructor 813679-813725; the dispatch 831092-831095) ==')
{
  host.eval(`__ocLog = {}`)
  const far2 = spawnLuaUnit(host, 'uel0201', { x: 60, y: 20, z: 140 }, 2)
  beat(engine)
  host.eval(`IssueOverCharge({ __units[${acu}] }, __units[${far2}])`)
  for (let i = 0; i < 8; i++) {
    topUp()
    beat(engine)
  }
  const moving = taskOf(acu)?.moving === true && host.eval(`return __units[${acu}].__goal ~= false and __units[${acu}].__goal ~= nil`) === true
  host.eval(`IssueClearCommands({ __units[${acu}] })`)
  beat(engine)
  const l = log()
  check(moving && l.includes('OnEnableWeapon') && l.includes('OnDisableWeapon') && !l.includes('OnFire'), 'an abort on the way runs OnDisableWeapon on the pinned weapon without a shot (813699-813701)')
  check(!wEnabled() && taskOf(acu) === null && host.eval(`return __units[${acu}].__goal == false`) === true, 'the weapon is disabled again, the task gone, the move aborted (813709-813713)')
  check(alive(far2), 'the target lives')
  // An allied target: the dispatcher creates no task (831092-831095); the
  // command completes at once.
  host.eval(`__ocLog = {}`)
  host.eval(`SetAlliance(1, 2, 'Ally')`)
  host.eval(`IssueOverCharge({ __units[${acu}] }, __units[${far2}])`)
  beat(engine)
  beat(engine)
  check(queueLen(acu) === 0 && !log().includes('OnEnableWeapon') && alive(far2), 'an allied target: no task, no weapon enabled, the command over at once')
  host.eval(`SetAlliance(1, 2, 'Enemy')`)
  // The user's dispatch needs the RULEUCC_Overcharge cap (1007470-1007472).
  host.eval(`__dispatchOverCharge(${ownTank}, ${far2}, true)`)
  check(queueLen(ownTank) === 0, 'the user dispatch refuses a unit without the cap')
  host.eval(`__units[${far2}]:Destroy()`)
  beat(engine)
}

console.log('\n== What the sim reported ==')
const uniq = [...new Set(warnings.map((w) => w.split('\n')[0]?.slice(0, 120)))]
for (const w of uniq.slice(0, 14)) console.log(`  · ${w}`)
const luaErrors = uniq.filter((w) => w && /Error running lua script|attempt to|overcharge\.lua|OnEnableWeapon|OnDisableWeapon/i.test(w))
check(luaErrors.length === 0, `no Lua errors in the overcharge (${luaErrors.length})`)

console.log(failures === 0 ? '\nOVERCHARGE PASSED' : `\nOVERCHARGE: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
