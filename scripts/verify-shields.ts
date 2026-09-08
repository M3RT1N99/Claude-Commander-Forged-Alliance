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
import { spawnLuaUnit, loadProjectileBlueprints } from '../src/lua/unitFactory'
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

console.log('\n== The shield entity hangs on its owner and follows it ==')
{
  // shield.lua:50 `self:AttachBoneTo(-1, spec.Owner, -1)`: the shield's own
  // reference bone -1 (no blueprint -> the identity, GetBoneLocalTransform
  // Cfile:916286-916295) on the owner's collision centre (-1, Cfile:916203-
  // 916218). SetParentOffset(0, ShieldVerticalOffset, 0) (shield.lua:267) adds
  // nothing here (offset 0). Every beat the shield is recomputed from the
  // owner (Entity::TaskTick -> CalculateAttachedTransform, Cfile:916175-916190).
  type Vec3 = [number, number, number]
  const centre = (): Vec3 =>
    (host.eval(`local p = __boneWorld(__units[${u}], -1); return p[1] .. ',' .. p[2] .. ',' .. p[3]`) as string)
      .split(',')
      .map(Number) as Vec3
  const shieldPos = (): Vec3 =>
    (host.eval(`local p = __units[${u}].MyShield:GetPosition(); return p[1] .. ',' .. p[2] .. ',' .. p[3]`) as string)
      .split(',')
      .map(Number) as Vec3
  const same = (a: Vec3, b: Vec3): boolean => a.every((v, i) => Math.abs(v - (b[i] ?? Number.NaN)) < 1e-6)
  check(
    host.eval(`return __units[${u}].MyShield:GetParent() == __units[${u}]`) === true,
    'the shield entity reports its owner as GetParent()',
  )
  const c0 = centre()
  check(
    same(shieldPos(), c0),
    `the shield sits on the owner's collision centre (${c0.map((v) => v.toFixed(3)).join(', ')})`,
  )
  check(c0[1] > 20, `which is above the ground the owner stands on (y ${c0[1].toFixed(3)} > 20 -- SizeY/2 + CollisionOffsetY)`)
  host.eval(`IssueMove({ __units[${u}] }, { 130, 20, 100 })`)
  for (let i = 0; i < 15; i++) beat(engine)
  const c1 = centre()
  check(c1[0] > c0[0] + 1, `the owner moved (x ${c0[0].toFixed(2)} -> ${c1[0].toFixed(2)})`)
  check(
    same(shieldPos(), c1),
    `and the shield followed to (${c1.map((v) => v.toFixed(3)).join(', ')})`,
  )
  host.eval(`__units[${u}].MyShield:SetParentOffset(Vector(0, 2.5, 0))`)
  beat(engine)
  const c2 = centre()
  const s2 = shieldPos()
  check(
    Math.abs(s2[1] - (c2[1] + 2.5)) < 1e-6 && Math.abs(s2[0] - c2[0]) < 1e-6 && Math.abs(s2[2] - c2[2]) < 1e-6,
    `SetParentOffset(0, 2.5, 0) lifts it by 2.5 on the next beat (y ${s2[1].toFixed(3)} vs centre ${c2[1].toFixed(3)})`,
  )
}

console.log('\n== The dome meshes: SetMesh, SetDrawScale, SetVizTo*, the registry the renderer draws ==')
{
  // The UEF T2 shield generator's dome (ueb4301_unit.bp:52-62): Mesh
  // /effects/entities/Shield01/Shield01_mesh (ShaderName ShieldUEF), MeshZ
  // Shield01z_mesh (ShieldFill), ShieldSize 44, ShieldVerticalOffset -6.
  // Both mesh blueprints are MeshBlueprint files of effects.scd; the real
  // LoadBlueprints pipeline registers them under their long id
  // (lua/system/blueprints.lua:114-121, 240-244).
  loadProjectileBlueprints(host, [
    'effects/entities/Shield01/Shield01_mesh.bp',
    'effects/entities/Shield01/Shield01z_mesh.bp',
  ])
  check(
    host.eval(`return __registered.Mesh['/effects/entities/shield01/shield01_mesh'] ~= nil and __registered.Mesh['/effects/entities/shield01/shield01z_mesh'] ~= nil`) === true,
    'the two dome mesh blueprints are registered under their long ids',
  )
  const err = (expression: string): string =>
    host.eval(`local ok, e = pcall(function() ${expression} end); return ok and '' or tostring(e)`) as string
  const rows = (): { id: number; bp: string; x: number; y: number; z: number; scale: number; hp: number; army: number; viz: { focus: string; allies: string; enemies: string; neutrals: string } }[] =>
    JSON.parse(host.eval('return __readMeshEntitiesJson()') as string) as ReturnType<typeof rows>
  check(rows().length === 0, 'before any SetMesh the registry is empty')
  // The shield of the generator, recreated on the ACU with the generator's
  // mesh spec (Unit:CreateShield destroys the old one first, unit.lua).
  host.eval(`__units[${u}]:CreateShield({
    ShieldMaxHealth = 250, ShieldRechargeTime = 2, ShieldEnergyDrainRechargeTime = 2,
    ShieldRegenRate = 20, ShieldRegenStartTime = 1, ShieldSize = 44,
    ShieldVerticalOffset = -6, PassOverkillDamage = false,
    MaintenanceConsumptionPerSecondEnergy = 500,
    Mesh = '/effects/entities/Shield01/Shield01_mesh',
    MeshZ = '/effects/entities/Shield01/Shield01z_mesh',
  })`)
  // The shield's OnState thread (shield.lua:59 ChangeState) creates the meshes
  // on its first slice, i.e. on the next beat -- give it a few.
  for (let i = 0; i < 40 && !shieldOn(); i++) beat(engine)
  for (let i = 0; i < 5; i++) beat(engine)
  check(shieldOn(), 'the recreated shield is up')
  const meshes = host.eval(`
    local s = __units[${u}].MyShield
    return tostring(s.__meshBp) .. '|' .. tostring(s.MeshZ and s.MeshZ.__meshBp) .. '|' .. tostring(s.__drawScale) .. '|' .. tostring(s.MeshZ and s.MeshZ.__drawScale)
      .. '|' .. tostring(s.MeshZ and s.MeshZ:GetParent() == __units[${u}])
  `)
  check(
    meshes === '/effects/entities/shield01/shield01_mesh|/effects/entities/shield01/shield01z_mesh|44|44|true',
    `CreateShieldMesh (shield.lua:263-283): the dome mesh on the shield, the depth shell on MeshZ, both at draw scale 44, MeshZ attached to the owner (${meshes})`,
  )
  let r = rows()
  const dome = r.find((e) => e.bp === '/effects/entities/shield01/shield01_mesh')
  const shell = r.find((e) => e.bp === '/effects/entities/shield01/shield01z_mesh')
  check(r.length === 2 && dome !== undefined && shell !== undefined, `the registry lists the dome and the shell (${r.length} rows)`)
  // shield.lua:45-48 sets the shield's own modes in OnCreate: FocusPlayer
  // Always, Enemies Intel, Allies Always, Neutrals Intel (over the entity
  // defaults Always/Always/Intel/Always, Cfile:914515-914518, 914882-914883).
  check(
    dome !== undefined && dome.scale === 44 && dome.hp === 1 && dome.army === 1
      && dome.viz.focus === 'Always' && dome.viz.allies === 'Always' && dome.viz.enemies === 'Intel' && dome.viz.neutrals === 'Intel',
    `the dome row: scale 44, full health, army 1, shield.lua:45-48's modes Always/Always/Intel/Intel (${JSON.stringify(dome)})`,
  )
  const fresh = host.eval(`
    local e = import('/lua/sim/Entity.lua').Entity {}
    e:SetMesh('/effects/entities/Shield01/Shield01_mesh')
    local viz = nil
    for id, m in pairs(__meshEntities) do if m == e then viz = (m.__vizFocus or 'Always') .. '/' .. (m.__vizAllies or 'Always') .. '/' .. (m.__vizEnemies or 'Intel') .. '/' .. (m.__vizNeutrals or 'Always') end end
    e:Destroy()
    return viz
  `)
  check(fresh === 'Always/Always/Intel/Always', `a fresh entity carries the engine defaults Always/Always/Intel/Always (Cfile:914515-914518, StandardInit 914882-914883) (${fresh})`)
  check(
    shell !== undefined && shell.viz.focus === 'Always' && shell.viz.allies === 'Always' && shell.viz.enemies === 'Intel' && shell.viz.neutrals === 'Intel',
    `the shell row carries shield.lua:278-281's modes Always/Always/Intel/Intel (${JSON.stringify(shell?.viz)})`,
  )
  // SetParentOffset(0, ShieldVerticalOffset, 0): both hang 6 below the owner's
  // collision centre (shield.lua:267/276).
  const centreY = Number(host.eval(`local p = __boneWorld(__units[${u}], -1); return p[2]`))
  check(
    dome !== undefined && shell !== undefined && Math.abs(dome.y - (centreY - 6)) < 1e-6 && Math.abs(shell.y - (centreY - 6)) < 1e-6,
    `both sit ShieldVerticalOffset -6 below the collision centre (${dome?.y.toFixed(3)} / ${shell?.y.toFixed(3)} vs centre ${centreY.toFixed(3)})`,
  )
  // PARAM_FRACTIONHEALTH: the row's hp is the shield's health fraction.
  damage(100)
  r = rows()
  const hurt = r.find((e) => e.bp === '/effects/entities/shield01/shield01_mesh')
  check(hurt !== undefined && Math.abs(hurt.hp - 0.6) < 1e-6, `after 100 damage the dome row reports the health fraction 0.6 (${hurt?.hp})`)
  // The engine's argument checks.
  check(err(`__units[${u}].MyShield:SetMesh()`).includes('expected between 2 and 3 args, but got 1'), 'SetMesh without a name is the arg-count error (Cfile:935050-935051)')
  check(err(`__units[${u}].MyShield:SetMesh(5)`).includes('string expected'), 'SetMesh with a number is the type error (935070-935071)')
  host.eval(`__units[${u}].MyShield:SetMesh('/no/such/mesh')`)
  check(
    host.eval(`return __units[${u}].MyShield.__meshBp`) === '/effects/entities/shield01/shield01_mesh',
    'an unknown mesh on an entity WITH a mesh only warns and keeps the old one (Entity::SetMesh 916817-916823)',
  )
  check(
    err(`local e = import('/lua/sim/Entity.lua').Entity {}; e:SetMesh('/no/such/mesh')`).includes('SetMesh failed with /no/such/mesh'),
    'an unknown mesh on an entity WITHOUT one is the error "SetMesh failed with" (935092-935101)',
  )
  check(err(`__units[${u}].MyShield:SetDrawScale()`).includes('expected 2 args, but got 1'), 'SetDrawScale without a size is the arg-count error (935143-935144)')
  check(err(`__units[${u}].MyShield:SetDrawScale('x')`).includes('number expected'), 'SetDrawScale with a string is the type error (935155-935156)')
  const bad = err(`__units[${u}].MyShield:SetVizToEnemies('Sometimes')`)
  check(bad.includes('Invalid enum value Sometimes') && bad.includes('Always') && bad.includes('Intel'), `an unknown visibility mode is the enum error with the options (${bad.split('\n')[0]})`)
  host.eval(`__units[${u}].MyShield:SetVizToEnemies('Never')`)
  check(rows().find((e) => e.bp === '/effects/entities/shield01/shield01_mesh')?.viz.enemies === 'Never', 'SetVizToEnemies(Never) reaches the row')
  // The shield goes down: RemoveShield (shield.lua:253-261) clears the mesh
  // and destroys MeshZ -- the registry empties (the shell a beat later, once
  // the deletion queue ran).
  damage(500)
  check(!shieldOn(), 'the dome is down after 500 damage')
  beat(engine)
  check(rows().length === 0, 'RemoveShield emptied the registry (SetMesh("") on the dome, MeshZ destroyed)')
  // The destroyed shell must leave the registry TABLE too, not only the
  // rows: an energy-stalled shield cycles up and down every few seconds
  // (a new MeshZ per cycle), and a registry that keeps the dead ones grows
  // without bound.
  const registrySize = (): number => Number(host.eval('local n = 0 for _ in pairs(__meshEntities) do n = n + 1 end return n'))
  check(registrySize() === 0, `the destroyed shell was pruned from the registry table (${registrySize()} entries left)`)
  // The suites' blueprint payload (GameFiles.loadProjectiles) must carry the
  // mesh blueprints that live beside the unit blueprints: the ACU's
  // PhaseShield (uel0001_unit.bp Enhancements) is a units/**_mesh.bp, and
  // Unit:SetMesh('/units/uel0001/UEL0001_PhaseShield_mesh') fails without it.
  game.loadProjectiles(host)
  check(
    host.eval(`return __registered.Mesh['/units/uel0001/uel0001_phaseshield_mesh'] ~= nil`) === true,
    'the ACU phase shield mesh blueprint (units/**_mesh.bp) is registered by the suite payload',
  )
}

console.log('\n== The personal shield: the owner\'s mesh swaps to the OwnerShieldMesh and back ==')
{
  // The ACU's Personal Shield Generator enhancement (uel0001_script.lua:311-
  // 315): CreatePersonalShield with the enhancement's own block
  // (uel0001_unit.bp:527-545), then the maintenance drain. UnitShield
  // (shield.lua:420-494) swaps the OWNER's mesh: CreateShieldMesh :476-479
  // `Owner:SetMesh(OwnerShieldMesh, true)`, RemoveShield :481-484 back to
  // Display.MeshBlueprint. The mesh blueprint is a units/**_mesh.bp of the
  // boot payload (registered by game.loadProjectiles above).
  const u2 = spawnLuaUnit(host, 'uel0001', { x: 120, y: 20, z: 120 }, 1)
  for (let i = 0; i < 4; i++) beat(engine)
  const meshOf = (): string => host.eval(`return tostring(__units[${u2}].__meshBp)`) as string
  const rowMesh = (): string | undefined => {
    const rows = host.pull<{ id: number; mesh?: string }[]>('__readAllUnitsJson()')
    const row = rows.find((r) => r.id === u2)
    // No row at all is not "the field is absent": fail here, not vacuously.
    if (!row) throw new Error(`unit ${u2} has no row in __readAllUnitsJson()`)
    return row.mesh
  }
  check(meshOf() === '/units/uel0001/uel0001_mesh', `a fresh unit carries its Display.MeshBlueprint (${meshOf()})`)
  check(rowMesh() === undefined, 'the unit row omits the mesh while it is the blueprint one')
  host.eval(`__units[${u2}]:CreatePersonalShield({
    OwnerShieldMesh = '/units/uel0001/UEL0001_PhaseShield_mesh', PersonalShield = true,
    ImpactEffects = 'UEFShieldHit01', ShieldMaxHealth = 24000, ShieldRechargeTime = 140,
    ShieldEnergyDrainRechargeTime = 5, ShieldRegenRate = 35, ShieldRegenStartTime = 1,
    ShieldSize = 3, ShieldVerticalOffset = 0, MaintenanceConsumptionPerSecondEnergy = 250,
  })
  __units[${u2}]:SetEnergyMaintenanceConsumptionOverride(250)
  __units[${u2}]:SetMaintenanceConsumptionActive()`)
  for (let i = 0; i < 6; i++) beat(engine)
  const shieldUp = (): boolean => host.eval(`local s = __units[${u2}].MyShield; return (s and s:IsOn()) == true`) as boolean
  check(shieldUp(), 'the personal shield is up')
  check(meshOf() === '/units/uel0001/uel0001_phaseshield_mesh', `the owner's mesh is the OwnerShieldMesh, lowercased (${meshOf()})`)
  check(rowMesh() === '/units/uel0001/uel0001_phaseshield_mesh', `the unit row carries the swapped mesh id (${rowMesh()})`)
  check(
    host.eval(`return __registered.Mesh['/units/uel0001/uel0001_phaseshield_mesh'].LODs[1].ShaderName`) === 'PhaseShield',
    'the swapped mesh blueprint names the PhaseShield technique (uel0001_phaseshield_mesh.bp)',
  )
  // Shield down by damage: RemoveShield puts Display.MeshBlueprint back
  // (shield.lua:483) -- the row drops the field again.
  host.eval(`Damage(nil, {120,20,120}, __units[${u2}], 30000, 'Normal')`)
  for (let i = 0; i < 3; i++) beat(engine)
  check(!shieldUp(), 'the personal shield is down after 30000 damage')
  check(meshOf() === '/units/uel0001/uel0001_mesh', `the owner's mesh is the blueprint one again (${meshOf()})`)
  check(rowMesh() === undefined, 'the unit row omits the mesh again')
  // SetMesh('') on a unit: no mesh at all (Entity::SetMesh :916809-916812,
  // mMesh = 0) -- the row says '' so the renderer hides the body.
  host.eval(`__units[${u2}]:SetMesh('')`)
  check(rowMesh() === '', `SetMesh('') on a unit reaches the row as '' (${JSON.stringify(rowMesh())})`)
}

console.log(failures === 0 ? '\nSHIELDS PASSED' : `\nSHIELDS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
