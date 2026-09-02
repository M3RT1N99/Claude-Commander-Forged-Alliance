/**
 * Shields (Defense.Shield). The shield LOGIC is the original /lua/shield.lua — a
 * ChangeState state machine that runs on our scheduler. The engine supplies the
 * shield entity (_c_CreateShield) and routes damage through it (damage.lua, the
 * shield-sphere subtraction Cfile:1062695): a unit with an ACTIVE shield takes
 * hits on the shield first; when depleted the shield goes down and recharges
 * (ShieldRechargeTime); partial damage regenerates (ShieldRegenRate). The
 * strength ratio syncs to the UI (SetShieldRatio -> readRow -> GetShieldRatio).
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-shields.ts
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
const near = (a: number, b: number, eps = 1e-3): boolean => Math.abs(a - b) < eps

const game = await GameFiles.open()
const host = await LuaHost.create(game.luaFiles, () => {})
const engine = installEngine(host)
setTerrainSource(host, () => 20, FLAT_TEST_MAP_SIZE)
await game.giveUnit(host, 'uel0001')
const u = spawnLuaUnit(host, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
for (let i = 0; i < 8; i++) beat(engine)

const shieldHp = (): number => host.eval(`local s=__units[${u}].MyShield; return s and s:GetHealth() or -1`) as number
const unitHp = (): number => host.eval(`return __units[${u}].__health`) as number
const ratio = (): number => host.eval(`return __units[${u}].__shieldRatio or -1`) as number
const shieldOn = (): boolean => host.eval(`local s=__units[${u}].MyShield; return (s and s:IsOn()) == true`) as boolean
const uiRatio = (): number =>
  host.eval(`for _,r in ipairs(__readAllUnits()) do if r.id==${u} then return r.shieldRatio end end return -1`) as number
const damage = (amt: number): void => {
  host.eval(`Damage(nil, {100,20,100}, __units[${u}], ${amt}, 'Normal')`)
}

// Create a shield on the unit — the original Unit:CreateShield path (normally
// read from bp.Defense.Shield; here an explicit spec).
//
// The three calls together are the ACU's real ShieldGeneratorField enhancement
// (uel0001_script.lua:325-327): CreateShield, then the maintenance drain, then
// SetMaintenanceConsumptionActive. The drain is NOT decoration — shield.lua
// drives its recharge off `Owner:GetResourceConsumed()` (shield.lua:288
// ChargingUp advances by fraction/10 per tick, shield.lua:335 drops the shield
// when the fraction is not 1 and storage is empty). A unit with no consumption
// reports 0 there (mResourceConsumed is only set while mConsumptionIsActive,
// Cfile:953945; unit.lua:748-752 turns consumption off exactly when the rates
// are zero), so a shield on a drain-less owner would never come back up.
// MaintenanceConsumptionPerSecondEnergy 500 is the blueprint's own value
// (uel0001_unit.bp:563).
host.eval(`__units[${u}]:CreateShield({
  ShieldMaxHealth = 250, ShieldRechargeTime = 2, ShieldEnergyDrainRechargeTime = 2,
  ShieldRegenRate = 20, ShieldRegenStartTime = 1, ShieldSize = 10,
  ShieldVerticalOffset = 0, PassOverkillDamage = false,
  MaintenanceConsumptionPerSecondEnergy = 500,
})`)
host.eval(`__units[${u}]:SetEnergyMaintenanceConsumptionOverride(500)`)
host.eval(`__units[${u}]:SetMaintenanceConsumptionActive()`)
// Enough energy that the drain is always fully granted (fraction == 1).
engine.economy.army(1).energy = 1e6
beat(engine)

console.log('\n== The shield comes up at full strength ==')
const fullHp = unitHp()
check(shieldHp() === 250, `shield at ShieldMaxHealth (${shieldHp()})`)
check(shieldOn(), 'shield is on')
check(near(ratio(), 1), `shield ratio 1.0 (${ratio()})`)
check(near(uiRatio(), 1), `UI mirror ratio 1.0 (${uiRatio()})`)

console.log('\n== The shield absorbs, the unit is untouched ==')
damage(100)
beat(engine)
check(shieldHp() === 150, `shield 250 -> ${shieldHp()} (absorbed 100)`)
check(unitHp() === fullHp, `unit health untouched (${unitHp()})`)
check(near(ratio(), 0.6), `ratio 0.6 (${ratio()})`)
check(near(uiRatio(), 0.6), `UI mirror ratio 0.6 (${uiRatio()})`)

console.log('\n== Depleting the shield drops it; overkill is lost (no pass) ==')
damage(200) // shield has 150, absorbs 150, drops to 0; 50 overkill discarded
beat(engine)
check(shieldHp() <= 0, `shield depleted (${shieldHp()})`)
check(!shieldOn(), 'shield is down')
check(unitHp() === fullHp, `unit still untouched — no overkill pass (${unitHp()})`)

console.log('\n== A down shield lets damage through to the unit ==')
damage(100)
beat(engine)
check(unitHp() < fullHp, `unit now takes damage (${fullHp} -> ${unitHp()})`)

console.log('\n== The shield recharges after ShieldRechargeTime ==')
for (let i = 0; i < 26; i++) beat(engine) // 2 s recharge = 20 beats, plus margin
check(shieldHp() === 250, `shield back to full (${shieldHp()})`)
check(shieldOn(), 'shield is on again')

console.log('\n== Partial damage regenerates (ShieldRegenRate) ==')
damage(100) // 250 -> 150
beat(engine)
const before = shieldHp()
for (let i = 0; i < 15; i++) beat(engine) // RegenStartTime 1 s + ~0.5 s regen at 20/s
check(shieldHp() > before, `shield regenerates ${before} -> ${shieldHp()}`)

console.log('\n== Bubble shield: a unit under the generator dome is protected ==')
// u's shield sits at (100,100) with ShieldSize 10 and is up (recharged above).
const hpOf = (id: number): number =>
  Number(host.eval(`local x=__units[${id}]; return x and (x.__health or 0) or -1`))
const covered = spawnLuaUnit(host, 'uel0001', { x: 105, y: 20, z: 100 }, 1) // dist 5 < 10 -> under the dome
const outside = spawnLuaUnit(host, 'uel0001', { x: 124, y: 20, z: 100 }, 1) // dist 24 > 10 -> outside
const coveredHp0 = hpOf(covered)
const outsideHp0 = hpOf(outside)
const domeHp0 = shieldHp()
// Damage the covered unit from a point OUTSIDE the dome (origin dist 100 > 10).
host.eval(`Damage(nil, { 200, 20, 100 }, __units[${covered}], 60, 'Normal')`)
check(shieldOn(), "the generator's dome is up")
check(hpOf(covered) === coveredHp0, `a unit under the dome takes no damage (${coveredHp0} -> ${hpOf(covered)})`)
check(shieldHp() < domeHp0, `the covering dome lost health instead (${domeHp0} -> ${shieldHp()})`)
// A unit OUTSIDE the dome takes the hit directly.
host.eval(`Damage(nil, { 200, 20, 100 }, __units[${outside}], 60, 'Normal')`)
check(hpOf(outside) < outsideHp0, `a unit outside the dome takes the hit (${outsideHp0} -> ${hpOf(outside)})`)

console.log('\n== Splash: the dome absorbs ONCE per damage event, not once per unit ==')
// func_DoDamageArea collects the absorption a single time via SIM_DoDamage
// (Cfile:1063221), subtracts it per entity with sub_736E40 (Cfile:1063263) and
// damages each dome exactly once with what it absorbed (Cfile:1063310-1063386).
// Consulting the dome per covered unit drained it N-fold and left every unit
// untouched — that was the bug.
{
  // Let it regenerate a bit; the exact level does not matter, only that the
  // dome is up and has more health than one absorption.
  for (let i = 0; i < 40; i++) beat(engine)
  const domeBefore = shieldHp()
  check(shieldOn() && domeBefore > 60, `dome is up with room to absorb (${domeBefore})`)

  // Three more units under the dome (u itself is the generator at 100/100).
  const under: number[] = []
  for (const dz of [3, 4, 5]) {
    under.push(spawnLuaUnit(host, 'uel0001', { x: 100, y: 20, z: 100 + dz }, 1))
  }
  beat(engine)
  const hpBefore = under.map((id) => hpOf(id))

  // One splash from OUTSIDE the dome. Amount 60 < dome health, so the dome
  // absorbs the whole 60 exactly once and every covered unit takes nothing.
  host.eval(`DamageArea(nil, { 115, 20, 100 }, 30, 60, 'Normal', true)`)
  beat(engine)

  const drained = domeBefore - shieldHp()
  check(
    Math.abs(drained - 60) < 0.51,
    `the dome lost ONE absorption (${drained.toFixed(1)}, want ~60 — not ${60 * under.length} for ${under.length} units)`,
  )
  under.forEach((id, i) => {
    check(hpOf(id) === hpBefore[i], `covered unit ${i + 1} took nothing (${hpBefore[i]} -> ${hpOf(id)})`)
  })

  // And when the splash exceeds what the dome can absorb, the remainder reaches
  // the units: reduced = amount - absorbed (Cfile:1063263-1063264).
  const domeHp = shieldHp()
  const over = domeHp + 100
  const hpBefore2 = under.map((id) => hpOf(id))
  host.eval(`DamageArea(nil, { 115, 20, 100 }, 30, ${over}, 'Normal', true)`)
  beat(engine)
  under.forEach((id, i) => {
    const was = hpBefore2[i]! // i indexes the map() of `under` itself
    check(hpOf(id) < was, `covered unit ${i + 1} takes the remainder once the dome is exceeded (${was} -> ${hpOf(id)})`)
  })
}

console.log('\n== Splash on a unit that owns the shield: it takes the remainder too ==')
// The absorbing dome belongs to the VICTIM here. func_DoDamageArea subtracts the
// recorded absorption once (sub_736E40, Cfile:1063263) and only skips the entity
// when the remainder is <= 0 (Cfile:1063264); the dome itself is damaged exactly
// once, in the separate second loop (Cfile:1063310-1063386).
// Consulting `target.MyShield` again inside the per-entity damage would swallow
// that remainder a second time AND charge the dome twice — func_DoDamagePoint
// (Cfile:1062873-1063170) contains no shield code at all.
{
  // Fresh generator + shield, so this block does not depend on what is left above.
  const owner = spawnLuaUnit(host, 'uel0001', { x: 400, y: 20, z: 400 }, 1)
  for (let i = 0; i < 8; i++) beat(engine)
  host.eval(`__units[${owner}]:CreateShield({
    ShieldMaxHealth = 200, ShieldRechargeTime = 2, ShieldEnergyDrainRechargeTime = 2,
    ShieldRegenRate = 0, ShieldRegenStartTime = 1, ShieldSize = 10,
    ShieldVerticalOffset = 0, PassOverkillDamage = false,
    MaintenanceConsumptionPerSecondEnergy = 500,
  })`)
  host.eval(`__units[${owner}]:SetEnergyMaintenanceConsumptionOverride(500)`)
  host.eval(`__units[${owner}]:SetMaintenanceConsumptionActive()`)
  engine.economy.army(1).energy = 1e6
  beat(engine)

  const domeHp = Number(host.eval(`local s=__units[${owner}].MyShield; return s and s:GetHealth() or -1`))
  check(domeHp === 200, `the owner's dome is up at 200 (${domeHp})`)
  // ShieldRegenRate 0 above: the dome cannot move on its own, so the drop we
  // measure is exactly the absorption.
  //
  // Und die UNIT-Regeneration ebenfalls aus: `Unit::OnTick` heilt jede Einheit
  // unter ihrem Maximum um `Defense.RegenRate * 0.1` pro Tick
  // (Cfile:952810-952817). Der Beat zwischen Schaden und Messung heilte 1 Leben
  // zurueck, und die Differenz war 149 statt 150 — nicht der Schild war falsch,
  // sondern die Messung mass zwei Dinge auf einmal.
  host.eval(`__units[${owner}].__regenRate = 0`)
  const hp0 = hpOf(owner)
  const splash = domeHp + 150

  // Origin OUTSIDE the dome (dist 15 > 10) but inside the splash radius.
  host.eval(`DamageArea(nil, { 415, 20, 400 }, 30, ${splash}, 'Normal', true)`)
  beat(engine)

  const domeAfter = Number(host.eval(`local s=__units[${owner}].MyShield; return s and s:GetHealth() or -1`))
  check(domeAfter === 0, `the dome is drained exactly once, to 0 (${domeAfter})`)
  check(
    hpOf(owner) < hp0,
    `the shield OWNER takes the remainder (${hp0} -> ${hpOf(owner)}, splash ${splash} vs dome 200)`,
  )
  check(
    Math.abs((hp0 - hpOf(owner)) - 150) < 0.01,
    `and it is exactly amount - absorbed = 150 (${(hp0 - hpOf(owner)).toFixed(2)})`,
  )
}

console.log(failures === 0 ? '\nSHIELDS PASSED' : `\nSHIELDS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
