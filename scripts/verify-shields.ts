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

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
const near = (a: number, b: number, eps = 1e-3): boolean => Math.abs(a - b) < eps

const game = await GameFiles.open()
const host = await LuaHost.create(game.luaFiles, () => {})
const engine = installEngine(host)
setTerrainSource(host, () => 20)
await game.giveUnit(host, 'uel0001')
const u = spawnLuaUnit(host, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
for (let i = 0; i < 8; i++) beat(engine)

const shieldHp = (): number => host.eval(`local s=__units[${u}].MyShield; return s and s:GetHealth() or -1`) as number
const unitHp = (): number => host.eval(`return __units[${u}].__health`) as number
const ratio = (): number => host.eval(`return __units[${u}].__shieldRatio or -1`) as number
const shieldOn = (): boolean => host.eval(`local s=__units[${u}].MyShield; return (s and s:IsOn()) == true`) as boolean
const uiRatio = (): number =>
  host.eval(`for _,r in ipairs(__readAllUnits()) do if r.id==${u} then return r.shieldRatio end end return -1`) as number
const damage = (amt: number): void => host.eval(`Damage(nil, {100,20,100}, __units[${u}], ${amt}, 'Normal')`)

// Create a shield on the unit — the original Unit:CreateShield path (normally
// read from bp.Defense.Shield; here an explicit spec).
host.eval(`__units[${u}]:CreateShield({
  ShieldMaxHealth = 250, ShieldRechargeTime = 2, ShieldEnergyDrainRechargeTime = 2,
  ShieldRegenRate = 20, ShieldRegenStartTime = 1, ShieldSize = 10,
  ShieldVerticalOffset = 0, PassOverkillDamage = false,
})`)
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

console.log(failures === 0 ? '\nSHIELDS PASSED' : `\nSHIELDS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
