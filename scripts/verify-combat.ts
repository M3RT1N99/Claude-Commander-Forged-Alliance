/**
 * M8 — DER KAMPF, über die Original-Lua.
 *
 * Zwei T1-Panzer (UEL0201), Armee 1 gegen Armee 2, 15 Weltmeter auseinander.
 * Danach nur noch `beat()`. Alles andere macht das Spiel selbst:
 *
 *   __weaponTick()            Zielerfassung (CAcquireTargetTask, Cfile:792838)
 *     → Weapon:OnGotTarget()  defaultweapons.lua:413 → RackSalvoFireReadyState
 *   __weaponTick()            Feuertakt (CFireWeaponTask, Cfile:983912)
 *     → Weapon:OnFire()       → RackSalvoFiringState (defaultweapons.lua:510)
 *       → CreateProjectileAtMuzzle → weapon:CreateProjectile(bone)  [ENGINE]
 *         → PassDamageData(GetDamageTable())    (weapon.lua:325)
 *   __projectileTick()        Flug (Projectile::MotionTick, Trapez-Integration)
 *     → OnImpact('Unit', ziel) → Projectile:DoDamage → Damage(...)   [ENGINE]
 *       → ziel:OnDamage → DoTakeDamage → AdjustHealth → Kill
 *         → OnKilled → DeathThread → CreateWreckage → CreateProp    [ENGINE]
 *
 * Die Zahlen stehen im Blueprint (uel0201: Damage 24, RateOfFire 1,
 * MaxRadius 18, MuzzleVelocity 25, ProjectileId TDFGauss01), die Reihenfolge in
 * der Decomp. Keine davon steht in TypeScript.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-combat.ts
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

console.log('\n== Blueprints: Projektile und Wracks ==')
const nProj = game.loadProjectiles(host)
const nProps = game.loadProps(host)
check(nProj > 250, `${nProj} Projektil-Blueprints über die echte Pipeline`)
check(nProps >= 1, `${nProps} Prop-Blueprint(s) (DefaultWreckage)`)

// Die BlueprintId ist der volle kleingeschriebene PFAD mit .bp
// (SetBackwardsCompatId, Blueprints.lua:104-107) — genau der String, der in
// Weapon.ProjectileId steht.
const gauss = '/projectiles/tdfgauss01/tdfgauss01_proj.bp'
check(
  host.eval(`return __registered.Projectile['${gauss}'] ~= nil`) === true,
  'TDFGauss01 ist registriert (BlueprintId = kleingeschriebener Pfad)',
)
check(
  Number(host.eval(`return __registered.Projectile['${gauss}'].Physics.InitialSpeed`)) === 12,
  'InitialSpeed = 12 (aus der .bp, nicht geraten)',
)
// Struct-Defaults der Engine (RProjectileBlueprintPhysics-Ctor, Cfile:653667):
// die .bp von TDFGauss01 hat kein UseGravity und kein Lifetime.
check(
  host.eval(`return __registered.Projectile['${gauss}'].Physics.UseGravity`) === true,
  'UseGravity = true kommt aus dem Struct-Default (die .bp sagt nichts dazu)',
)
check(
  Number(host.eval(`return __registered.Projectile['${gauss}'].Physics.Lifetime`)) === 15,
  'Lifetime = 15 (Struct-Default)',
)

console.log('\n== Zwei Panzer, zwei Armeen ==')
for (const id of ['uel0201']) await game.giveUnit(host, id)
const a = spawnLuaUnit(host, 'uel0201', { x: 100, y: 20, z: 100 }, 1)
const b = spawnLuaUnit(host, 'uel0201', { x: 100, y: 20, z: 115 }, 2)
check(a > 0 && b > 0, `Panzer ${a} (Armee 1) und ${b} (Armee 2), 15 Meter auseinander`)

// Das Skelett ist da — und die Mündung sitzt NICHT im Ursprung der Unit.
const muzzle = host.eval(`
  local u = __units[${a}]
  local p = u:GetPosition('Turret_Muzzle')
  return string.format('%.2f %.2f %.2f', p[1], p[2], p[3])
`) as string
check(
  muzzle !== '100.00 20.00 100.00',
  `Mündungsknochen 'Turret_Muzzle' hat eine eigene Weltpose: ${muzzle}`,
)

console.log('\n== Die Waffe findet ihr Ziel (CAcquireTargetTask) ==')
// TargetCheckInterval 0.5 -> alle 5 Ticks; MaxRadius 18 > 15 Meter Abstand.
let gotTarget = -1
for (let t = 0; t < 10 && gotTarget < 0; t++) {
  beat(engine)
  if (host.eval(`return __units[${a}]:GetWeapon(1):GetCurrentTarget() ~= nil`) === true) {
    gotTarget = t
  }
}
check(gotTarget >= 0, `Die Waffe hat nach ${gotTarget + 1} Beats ein Ziel (TargetCheckInterval 0.5)`)
check(
  host.eval(`return __units[${a}]:GetWeapon(1):GetCurrentTarget():GetEntityId() == ${b}`) === true,
  'und zwar den Panzer der FEIND-Armee',
)

console.log('\n== Der Schuss (OnFire → RackSalvoFiringState → CreateProjectile) ==')
let projSeen = 0
for (let t = 0; t < 12 && projSeen === 0; t++) {
  beat(engine)
  projSeen = Number(host.eval('local n = 0 for _ in pairs(__projectiles) do n = n + 1 end return n'))
}
check(projSeen > 0, `${projSeen} Projektil(e) in der Luft`)
const projClass = host.eval(`
  for _, p in pairs(__projectiles) do
    return tostring(p.__bp.BlueprintId)
  end
  return 'keins'
`) as string
check(projClass === gauss, `Es ist ein TDFGauss01 — der Blueprint der Waffe (${projClass})`)
check(
  Number(host.eval(`
    for _, p in pairs(__projectiles) do return p.DamageData.DamageAmount end
    return -1
  `)) === 24,
  'Es trägt DamageAmount 24 (weapon.lua:325 PassDamageData → uel0201_unit.bp:211)',
)

console.log('\n== Der Treffer: 24 Schaden pro Kugel ==')
const maxHp = Number(host.eval(`return __units[${b}]:GetMaxHealth()`))
let hp = maxHp
for (let t = 0; t < 20 && hp === maxHp; t++) {
  beat(engine)
  hp = Number(host.eval(`return __units[${b}] and __units[${b}]:GetHealth() or 0`))
}
check(hp === maxHp - 24, `Das Ziel verliert genau 24 HP (${maxHp} → ${hp})`)

console.log('\n== Bis zum Tod: OnKilled, DeathThread, Wrack ==')
// MaxHealth 260 / 24 = 11 Treffer. Bei RateOfFire 1 (alle 10 Ticks) plus
// Flugzeit reichen 150 Beats mit Reserve.
let killed = false
let killedAt = -1
for (let t = 0; t < 200 && !killed; t++) {
  beat(engine)
  if (host.eval(`return __units[${b}] == nil or __units[${b}].__dead == true`) === true) {
    killed = true
    killedAt = t
  }
}
check(killed, `Der Panzer stirbt (nach ${killedAt + 1} weiteren Beats, ${maxHp} HP / 24 Schaden)`)

// Der Todes-Thread laeuft als Coroutine weiter: Explosion, Wrack, Destroy.
for (let t = 0; t < 60; t++) beat(engine)
const props = Number(host.eval('local n = 0 for _ in pairs(__props) do n = n + 1 end return n'))
check(props >= 1, `${props} Wrack-Prop auf dem Feld (Unit:CreateWreckage → CreateProp)`)
const wreck = host.eval(`
  for _, p in pairs(__props) do return tostring(p.__bp.BlueprintId) end
  return 'keins'
`) as string
check(
  wreck.indexOf('wreckage') >= 0,
  `Es ist das DefaultWreckage-Prop aus dem Blueprint der Unit (${wreck})`,
)

console.log('\n== Was die Sim dabei gemeldet hat ==')
const uniq = [...new Set(warnings.map((w) => w.split('\n')[0]?.slice(0, 110)))]
for (const w of uniq.slice(0, 12)) console.log(`  · ${w}`)

console.log(failures === 0 ? '\nKAMPF BESTANDEN' : `\nKAMPF: ${failures} FEHLER`)
await game.close()
process.exit(failures === 0 ? 0 : 1)
