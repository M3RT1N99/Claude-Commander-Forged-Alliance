/**
 * Splash damage and AdjustHealth guards, verified against the decomp:
 *
 *   DamageArea/DamageRing spare a target that IsAlly to the instigator — allies
 *   of a DIFFERENT army too, not just the same army (func_DoDamageArea uses
 *   IArmy::IsAlly, Cfile:1063248-1063249). They ERROR on 0 damage / 0 radius
 *   instead of silently no-oping (cfunc_DamageAreaL, Cfile:1064381/1064383).
 *   Entity::AdjustHealth never heals a DEAD entity (Cfile:915988).
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-splash-damage.ts
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
const simHost = await LuaHost.create(game.luaFiles, () => {})
const engine = installEngine(simHost)
setTerrainSource(simHost, () => 20)
for (const id of ['uel0001']) await game.giveUnit(simHost, id)

const attacker = spawnLuaUnit(simHost, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
const target = spawnLuaUnit(simHost, 'uel0001', { x: 140, y: 20, z: 140 }, 2)
for (let i = 0; i < 8; i++) beat(engine)

const hp = (id: number): number => simHost.eval(`return __units[${id}].__health or 0`) as number
const splash = (): void => {
  // DamageArea centred on the target, radius 5 (only the target is in range),
  // damageFriendly = false, damageSelf = false.
  simHost.eval(`DamageArea(__units[${attacker}], { 140, 20, 140 }, 5, 500, 'Normal', false, false)`)
}

// ── Friendly filter uses IsAlly (different army, but allied) ──
console.log('\n== DamageArea spares an ALLY of a different army ==')
{
  simHost.eval(`SetAlliance(1, 2, 'Ally')`)
  const before = hp(target)
  splash()
  beat(engine)
  check(hp(target) === before, `allied army-2 target unharmed (${before} -> ${hp(target)})`)

  simHost.eval(`SetAlliance(1, 2, 'Enemy')`)
  const before2 = hp(target)
  splash()
  beat(engine)
  check(hp(target) < before2, `enemy army-2 target takes splash (${before2} -> ${hp(target)})`)
}

// ── Degenerate input errors instead of silently no-oping ──
console.log('\n== DamageArea/DamageRing error on 0 damage / 0 radius ==')
{
  const errs = (call: string): boolean =>
    simHost.eval(`return select(1, pcall(function() ${call} end)) == false`) as boolean
  check(errs(`DamageArea(__units[${attacker}], { 140, 20, 140 }, 5, 0, 'Normal', false)`), '0 damage -> error')
  check(errs(`DamageArea(__units[${attacker}], { 140, 20, 140 }, 0, 500, 'Normal', false)`), '0 radius -> error')
  check(errs(`DamageRing(__units[${attacker}], { 140, 20, 140 }, 0, 5, 500, 'Normal', false)`), '0 min radius -> error')
  check(errs(`DamageRing(__units[${attacker}], { 140, 20, 140 }, 2, 0, 500, 'Normal', false)`), '0 max radius -> error')
}

// ── AdjustHealth never heals a dead entity ──
console.log('\n== AdjustHealth: dead entity is not healed ==')
{
  const alive = simHost.eval(`
    local u = __units[${target}]
    u.__dead = false; u.__health = 100
    u:AdjustHealth(nil, 500)
    return u.__health
  `) as number
  check(alive > 100, `a live unit heals (100 -> ${alive})`)

  const dead = simHost.eval(`
    local u = __units[${target}]
    u.__dead = true; u.__health = 0
    u:AdjustHealth(nil, 500)
    return u.__health
  `) as number
  check(dead === 0, `a dead unit is not healed (stays ${dead})`)
}

console.log(failures === 0 ? '\nSPLASH/HEALTH PASSED' : `\nSPLASH/HEALTH FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
