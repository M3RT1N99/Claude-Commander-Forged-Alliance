/**
 * Focused native-method contracts recovered from ForgedAlliance.exe:
 *
 * - UnitWeapon:WeaponHasTarget includes AITARGET_Ground, and CanFire accepts a
 *   valid ground target (Cfile:987310-987351, 987703-987737).
 * - Projectile:SetBallisticAcceleration has zero-, one-, and three-argument
 *   forms after self (Cfile:947528-947614).
 * - Unit:SetImmobile is a runtime state that pauses, but does not discard, the
 *   current movement goal (Cfile:974091-974128, 966248-966260).
 * - CollisionBeamEntity:SetBeamFx checks immediately by default, while Enable
 *   primes the next motion tick (Cfile:911180-911239, 911854-911901).
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-moho-sim-contracts.ts
 */
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { installMoho } from '../src/lua/moho'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { spawnLuaUnit } from '../src/lua/unitFactory'
import { GameFiles } from './gameFiles'
import { FLAT_TEST_MAP_SIZE } from '../src/sim/terrain'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
const bool = (host: LuaHost, expression: string): boolean =>
  host.eval(`return ${expression}`) === true
const num = (host: LuaHost, expression: string): number =>
  Number(host.eval(`return ${expression}`))

const game = await GameFiles.open()
const warnings: string[] = []
const host = await LuaHost.create(game.luaFiles, (level, message) => {
  if (level === 'WARN') warnings.push(message)
})
const engine = installEngine(host)
setTerrainSource(host, () => 20, FLAT_TEST_MAP_SIZE)

console.log('\n== UnitWeapon target predicate and ground CanFire ==')
host.eval(`
  local ProbeWeapon = Class(moho.weapon_methods) {}
  __contractWeapon = ProbeWeapon()
  __contractWeapon.__bp = {
    MaxRadius = 30,
    MinRadius = 1,
    CannotAttackGround = false,
  }
  __contractWeapon.__unit = { __pos = { 0, 20, 0 } }
  __contractWeapon.unit = __contractWeapon.__unit
  __contractWeapon.__enabled = true
  __contractWeapon:SetFireTargetLayerCaps('Land')
  __contractWeapon:SetTargetGround({ 10, 20, 0 })
`)
check(
  host.eval('return type(__contractWeapon.WeaponHasTarget)') === 'function',
  'the exported native name is WeaponHasTarget',
)
check(
  bool(host, '__contractWeapon.HasTarget == nil'),
  'the invented HasTarget alias is absent',
)
check(
  bool(host, '__contractWeapon:WeaponHasTarget()'),
  'a ground target counts as a target',
)
check(
  bool(host, '__contractWeapon:CanFire()'),
  'CanFire accepts an in-range ground target',
)
host.eval('__contractWeapon:SetTargetGround({ 40, 20, 0 })')
check(
  !bool(host, '__contractWeapon:CanFire()'),
  'CanFire still rejects a ground target outside MaxRadius',
)
host.eval('__contractWeapon:ResetTarget()')
check(
  !bool(host, '__contractWeapon:WeaponHasTarget()'),
  'ResetTarget returns the target type to AITARGET_None',
)

console.log('\n== UnitWeapon native CanFire gate chain ==')
host.eval(`
  local ProbeUnit = Class(moho.unit_methods) {}
  local ProbeWeapon = Class(moho.weapon_methods) {}
  function __resetCanFireProbe()
    local unit = ProbeUnit()
    unit.__pos = { 0, 10, 0 }
    unit.__heading = 0
    unit.__layer = 'Land'
    unit.__speed = 0
    unit.__bp = {
      Air = {
        CanFly = false,
        Winged = false,
        MaxAirspeed = 10,
        PredictAheadForBombDrop = 0,
      },
      AI = { NeedUnpack = false },
      Physics = { MotionType = 'RULEUMT_Land', MaxSpeed = 4 },
      Categories = {},
      Economy = { BuildRate = 10 },
    }

    local weapon = ProbeWeapon()
    weapon.__unit = unit
    weapon.unit = unit
    weapon.__enabled = true
    weapon.__canFire = true
    weapon.__bp = {
      MaxRadius = 30,
      MinRadius = 1,
      MaxHeightDiff = 5,
      HeadingArcCenter = 0,
      HeadingArcRange = 180,
      BombDropThreshold = 0,
      AboveWaterFireOnly = false,
      BelowWaterFireOnly = false,
      AutoInitiateAttackCommand = false,
      NeedToComputeBombDrop = false,
      CountedProjectile = false,
      NukeWeapon = false,
      CannotAttackGround = false,
    }
    weapon.__targetGround = { 0, 10, 10 }
    __canFireUnit = unit
    __canFireWeapon = weapon
  end
  __resetCanFireProbe()
`)
check(
  bool(host, '__canFireWeapon:SetEnabled(false) == __canFireWeapon'),
  'SetEnabled returns the weapon itself',
)
check(
  bool(host, '__canFireWeapon:CanFire()'),
  'disabled is not an extra gate in the public CanFire binding',
)
host.eval(`
  __canFireWeapon.__bp.CannotAttackGround = true
  __canFireWeapon.__targetGround = { 0, 10, 10 }
`)
check(
  bool(host, '__canFireWeapon:CanFire()'),
  'CannotAttackGround is handled by target assignment/fire task, not CanFire',
)

host.eval(`__resetCanFireProbe(); __canFireUnit:SetBusy(true)`)
check(!bool(host, '__canFireWeapon:CanFire()'), 'UNITSTATE_Busy blocks CanFire')
host.eval(`__canFireUnit:SetBusy(false); __canFireUnit:SetStunned(0.19)`)
check(
  num(host, '__canFireUnit.__stunTicks') === 1 &&
    bool(host, '__canFireUnit:IsStunned()') &&
    !bool(host, '__canFireWeapon:CanFire()'),
  'SetStunned truncates seconds*10 and the nonzero counter blocks CanFire',
)

host.eval(`
  __resetCanFireProbe()
  __canFireUnit.__bp.Air.CanFly = true
`)
check(
  !bool(host, '__canFireWeapon:CanFire()'),
  'a CanFly unit outside LAYER_Air cannot fire',
)
host.eval(`__canFireUnit.__layer = 'Air'`)
check(bool(host, '__canFireWeapon:CanFire()'), 'the same flyer can fire in LAYER_Air')

host.eval(`
  __resetCanFireProbe()
  __canFireUnit.__bp.AI.NeedUnpack = true
  __canFireUnit.__immobile = false
`)
check(
  !bool(host, '__canFireWeapon:CanFire()'),
  'NeedUnpack requires UNITSTATE_Immobile',
)
host.eval(`__canFireUnit:SetImmobile(true)`)
check(bool(host, '__canFireWeapon:CanFire()'), 'an unpacked/immobile unit passes that gate')

host.eval(`
  __resetCanFireProbe()
  __setWaterLevel(10)
  __canFireWeapon.__bp.AboveWaterFireOnly = true
`)
check(
  !bool(host, '__canFireWeapon:CanFire()'),
  'AboveWaterFireOnly rejects a muzzle exactly at water elevation',
)
host.eval(`
  __canFireWeapon.__bp.AboveWaterFireOnly = false
  __canFireWeapon.__bp.BelowWaterFireOnly = true
`)
check(
  bool(host, '__canFireWeapon:CanFire()'),
  'BelowWaterFireOnly accepts equality with water elevation',
)
host.eval(`__canFireUnit.__pos[2] = 11`)
check(
  !bool(host, '__canFireWeapon:CanFire()'),
  'BelowWaterFireOnly rejects a muzzle strictly above the water',
)
host.eval(`__setWaterLevel(-10000)`)

host.eval(`
  __resetCanFireProbe()
  __setWaterLevel(25)
  __canFireWeapon:SetFireTargetLayerCaps('Land')
  __canFireWeapon:ResetTarget()
  __canFireWeapon:SetTargetGround({ 5, 20, 5 })
`)
check(
  !bool(host, '__canFireWeapon:WeaponHasTarget()'),
  'submerged terrain requires the Water target-layer cap',
)
host.eval(`
  __canFireWeapon:SetFireTargetLayerCaps('Water')
  __canFireWeapon:SetTargetGround({ 5, 20, 5 })
`)
check(
  bool(host, '__canFireWeapon:WeaponHasTarget()'),
  'the Water cap accepts submerged ground coordinates',
)
host.eval(`
  __canFireWeapon:ResetTarget()
  __canFireWeapon.__bp.IgnoreIfDisabled = true
  __canFireWeapon.__enabled = false
  __canFireWeapon:SetTargetGround({ 5, 20, 5 })
`)
check(
  !bool(host, '__canFireWeapon:WeaponHasTarget()'),
  'IgnoreIfDisabled also applies while assigning a ground target',
)
host.eval(`__setWaterLevel(-10000)`)

host.eval(`
  __resetCanFireProbe()
  __canFireWeapon.__canFire = false
`)
check(!bool(host, '__canFireWeapon:CanFire()'), 'mCanFire=false blocks the native gate')
host.eval(`__canFireWeapon.__canFire = true`)
check(bool(host, '__canFireWeapon:CanFire()'), 'mCanFire=true restores the gate')

host.eval(`
  __resetCanFireProbe()
  __canFireWeapon.__bp.CountedProjectile = true
  __canFireUnit.__bp.Categories = { 'SILO' }
`)
check(!bool(host, '__canFireWeapon:CanFire()'), 'an empty counted-projectile silo blocks fire')
host.eval(`__canFireUnit:GiveTacticalSiloAmmo(2)`)
check(bool(host, '__canFireWeapon:CanFire()'), 'stored tactical ammo opens the silo gate')
host.eval(`__canFireUnit:RemoveTacticalSiloAmmo(1)`)
check(
  num(host, '__canFireUnit:GetTacticalSiloAmmoCount()') === 1,
  'RemoveTacticalSiloAmmo consumes the requested storage count',
)
host.eval(`
  __canFireUnit.__bp.Categories = {}
  __canFireUnit.__tacticalSiloAmmo = 0
`)
check(
  bool(host, '__canFireWeapon:CanFire()'),
  'CountedProjectile without a SILO subsystem does not invent a storage gate',
)
host.eval(`
  __canFireUnit:GiveNukeSiloAmmo(2)
  __canFireUnit:RemoveNukeSiloAmmo(5)
`)
check(
  num(host, '__canFireUnit:GetNukeSiloAmmoCount()') === 0,
  'RemoveNukeSiloAmmo cannot reduce storage below zero',
)

host.eval(`
  __resetCanFireProbe()
  __canFireWeapon.__targetGround = { 0, 10, 30 }
`)
check(bool(host, '__canFireWeapon:CanFire()'), 'MaxRadius equality remains fireable')
host.eval(`__canFireWeapon.__targetGround = { 0, 10, 30.01 }`)
check(!bool(host, '__canFireWeapon:CanFire()'), 'strictly outside MaxRadius is rejected')
host.eval(`__canFireWeapon.__targetGround = { 0, 100, 3 }`)
check(
  bool(host, '__canFireWeapon:CanFire()'),
  'the runtime MaxHeightDiff starts at infinity, not at the blueprint value',
)
host.eval(`__canFireWeapon:ChangeMaxHeightDiff(5)`)
check(
  !bool(host, '__canFireWeapon:CanFire()'),
  'a finite ChangeMaxHeightDiff enables the vertical gate',
)
host.eval(`
  __canFireWeapon:ChangeMinRadius(-2)
  __canFireWeapon.__targetGround = { 0, 10, 2 }
`)
check(
  !bool(host, '__canFireWeapon:CanFire()'),
  'negative ChangeMinRadius is squared and equality is still too close',
)
host.eval(`__canFireWeapon.__targetGround = { 0, 14, 3 }; __canFireWeapon:ChangeMaxHeightDiff(-1)`)
check(
  bool(host, '__canFireWeapon:CanFire()'),
  'negative MaxHeightDiff falls back to the blueprint height window',
)
host.eval(`__canFireWeapon.__targetGround = { 0, 16, 3 }`)
check(!bool(host, '__canFireWeapon:CanFire()'), 'height beyond the blueprint fallback is rejected')

host.eval(`
  __resetCanFireProbe()
  __canFireWeapon.__bp.HeadingArcRange = 45
  __canFireWeapon.__targetGround = { 0, 10, 10 }
`)
check(bool(host, '__canFireWeapon:CanFire()'), 'a target in the heading arc is available')
host.eval(`__canFireWeapon.__targetGround = { 10, 10, 0 }`)
check(!bool(host, '__canFireWeapon:CanFire()'), 'a target outside the heading arc has no solution')

host.eval(`
  __resetCanFireProbe()
  __canFireUnit.__layer = 'Air'
  __canFireUnit.__bp.Air.CanFly = true
  __canFireUnit.__bp.Air.Winged = true
  __canFireWeapon.__bp.AutoInitiateAttackCommand = true
  __canFireUnit.__speed = 0.24
`)
check(
  !bool(host, '__canFireWeapon:CanFire()'),
  'winged AutoInitiate weapons require 25 percent of MaxAirspeed',
)
host.eval(`__canFireUnit.__speed = 0.25`)
check(bool(host, '__canFireWeapon:CanFire()'), 'the winged speed threshold is inclusive')

host.eval(`
  __resetCanFireProbe()
  __canFireUnit.__pos = { 0, 20, 0 }
  __canFireUnit.__layer = 'Air'
  __canFireUnit.__bp.Air.CanFly = true
  __canFireUnit.__bp.Air.Winged = true
  __canFireUnit.__speed = 0.25
  __canFireWeapon.__bp.MaxHeightDiff = 100
  __canFireWeapon.__bp.NeedToComputeBombDrop = true
  __canFireWeapon.__targetGround = { 0, 0, 10 }
`)
check(
  !bool(host, '__canFireWeapon:CanFire()'),
  'bomb-drop weapons require UNITSTATE_MakingAttackRun',
)
host.eval(`__canFireUnit.__makingAttackRun = true`)
check(bool(host, '__canFireWeapon:CanFire()'), 'the calculated bomb release point can open CanFire')
host.eval(`__canFireWeapon.__bp.BombDropThreshold = 10`)
check(
  !bool(host, '__canFireWeapon:CanFire()'),
  'BombDropThreshold closes the too-late release window',
)

host.eval(`
  __resetCanFireProbe()
  __canFireUnit:SetSpeedMult(0.5)
  __canFireUnit:SetAccMult(0.25)
  __canFireUnit:SetTurnMult(0.75)
  __canFireUnit:SetBuildRate(4)
`)
check(
  bool(
    host,
    '__canFireUnit.__speedMult == 0.5 and __canFireUnit.__accMult == 0.25 and ' +
      '__canFireUnit.__turnMult == 0.75',
  ),
  'runtime motion multiplier setters update the fields consumed by motion.lua',
)
check(num(host, '__canFireUnit:GetBuildRate()') === 4, 'SetBuildRate overrides the blueprint rate')
host.eval(`__canFireUnit:SetBuildRate(-2)`)
check(num(host, '__canFireUnit:GetBuildRate()') === 0, 'SetBuildRate clamps negative values to zero')
check(bool(host, '__canFireUnit:IsCapturable()'), 'units are capturable by default')
host.eval(`__canFireUnit:SetCapturable(false)`)
check(!bool(host, '__canFireUnit:IsCapturable()'), 'SetCapturable updates IsCapturable')

console.log('\n== Projectile:SetBallisticAcceleration overloads ==')
host.eval(`
  __contractProjectile = {}
  __setBallistic = moho.projectile_methods.SetBallisticAcceleration
  __ballisticReturnsSelf = __setBallistic(__contractProjectile) == __contractProjectile
`)
check(bool(host, '__ballisticReturnsSelf'), 'zero-argument form returns the projectile')
check(
  Math.abs(num(host, '__contractProjectile.__ballistic[2] + __simGravity')) < 1e-9,
  'zero-argument form restores the global gravity vector',
)
host.eval('__setBallistic(__contractProjectile, -2.5)')
check(
  bool(
    host,
    '__contractProjectile.__ballistic[1] == 0 and ' +
      '__contractProjectile.__ballistic[2] == -2.5 and ' +
      '__contractProjectile.__ballistic[3] == 0',
  ),
  'one argument sets only vertical acceleration',
)
host.eval('__setBallistic(__contractProjectile, 1.25, -9.5, 3.75)')
check(
  bool(
    host,
    '__contractProjectile.__ballistic[1] == 1.25 and ' +
      '__contractProjectile.__ballistic[2] == -9.5 and ' +
      '__contractProjectile.__ballistic[3] == 3.75',
  ),
  'three arguments preserve the full acceleration vector',
)
check(
  !bool(host, 'pcall(__setBallistic, __contractProjectile, 1, 2)'),
  'an unsupported argument count raises an error',
)

console.log('\n== Unit:SetImmobile pauses and resumes one movement order ==')
await game.giveUnit(host, 'uel0001')
// Ein Panzer hat GAR KEINE ToggleCaps im Blueprint — der saubere Negativfall
// für das Script-Bit-Tor weiter unten.
await game.giveUnit(host, 'uel0201')
const mover = spawnLuaUnit(host, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
host.eval(`__units[${mover}]:GetNavigator():SetGoal({ 125, 20, 100 })`)
for (let i = 0; i < 8; i++) beat(engine)
const movingX = num(host, `__units[${mover}].__pos[1]`)
host.eval(`__units[${mover}]:SetImmobile(true)`)
const frozenX = num(host, `__units[${mover}].__pos[1]`)
for (let i = 0; i < 10; i++) beat(engine)
const stillX = num(host, `__units[${mover}].__pos[1]`)
check(movingX > 100, `the control unit was moving before the gate (x=${movingX.toFixed(3)})`)
check(
  bool(host, `__units[${mover}]:IsUnitState('Immobile')`),
  'SetImmobile(true) is visible through IsUnitState',
)
check(
  Math.abs(stillX - frozenX) < 1e-9,
  `position remains fixed while immobile (x=${stillX.toFixed(3)})`,
)
check(
  bool(host, `__units[${mover}].__goal ~= false and __units[${mover}].__goal ~= nil`),
  'the paused movement goal is retained',
)
host.eval(`__units[${mover}]:SetImmobile(false)`)
check(
  !bool(host, `__units[${mover}]:IsUnitState('Immobile')`),
  'SetImmobile(false) clears the runtime state',
)
for (let i = 0; i < 10; i++) beat(engine)
const resumedX = num(host, `__units[${mover}].__pos[1]`)
check(
  resumedX > stillX + 0.01,
  `clearing the state resumes the same order (x=${stillX.toFixed(3)} -> ${resumedX.toFixed(3)})`,
)

console.log('\n== Unit stun duration and motion gate ==')
host.eval(`
  __units[${mover}]:GetNavigator():SetGoal({ 150, 20, 100 })
  __units[${mover}]:SetStunned(0.2)
`)
const stunStartX = num(host, `__units[${mover}].__pos[1]`)
beat(engine)
const stunHeldX = num(host, `__units[${mover}].__pos[1]`)
check(
  Math.abs(stunHeldX - stunStartX) < 1e-9 &&
    bool(host, `__units[${mover}]:IsStunned()`),
  'the first motion tick decrements 2 to 1 and keeps the movement goal paused',
)
beat(engine)
const stunReleasedX = num(host, `__units[${mover}].__pos[1]`)
check(
  stunReleasedX > stunHeldX && !bool(host, `__units[${mover}]:IsStunned()`),
  'the second motion tick reaches zero and resumes the retained goal',
)
host.eval(`__units[${mover}]:SetStunned(-0.15)`)
const negativeStunX = num(host, `__units[${mover}].__pos[1]`)
beat(engine)
check(
  num(host, `__units[${mover}].__stunTicks`) === -1 &&
    bool(host, `__units[${mover}]:IsStunned()`) &&
    Math.abs(num(host, `__units[${mover}].__pos[1]`) - negativeStunX) < 1e-9,
  'negative durations truncate toward zero and remain stunned, like the native counter',
)
host.eval(`__units[${mover}]:SetStunned(0)`)

console.log('\n== CollisionBeam immediate and next-tick checks ==')
const shooter = spawnLuaUnit(host, 'uel0001', { x: 400, y: 20, z: 400 }, 1)
const victim = spawnLuaUnit(host, 'uel0001', { x: 410, y: 20, z: 400 }, 2)
host.eval(`
  local ProbeBeam = Class(moho.CollisionBeamEntity) {
    OnEnable = function(self)
      if self.__explicitFalse then
        self:SetBeamFx({}, false)
      else
        self:SetBeamFx({})
      end
    end,
    OnImpact = function(self, kind, target)
      self.__probeHits = (self.__probeHits or 0) + 1
      self.__probeKind = kind
      self.__probeTarget = target
    end,
  }
  local weapon = {
    unit = __units[${shooter}],
    __unit = __units[${shooter}],
    __bp = { MaxRadius = 30, MaximumBeamLength = 30, IgnoresAlly = true },
    __target = __units[${victim}],
  }
  setmetatable(weapon, { __index = moho.weapon_methods })

  __defaultBeam = ProbeBeam {
    Weapon = weapon,
    OtherBone = 0,
    CollisionCheckInterval = 25,
  }
  __defaultBeam:Enable()

  __delayedBeam = ProbeBeam {
    Weapon = weapon,
    OtherBone = 0,
    CollisionCheckInterval = 25,
  }
  __delayedBeam.__explicitFalse = true
  __delayedBeam:Enable()
`)
check(
  num(host, '__defaultBeam.__probeHits or 0') === 1 &&
    bool(host, `__defaultBeam.__probeTarget == __units[${victim}]`),
  'omitted collideOnStart defaults to an immediate collision check',
)
check(
  num(host, '__delayedBeam.__probeHits or 0') === 0,
  'an explicit collideOnStart=false suppresses only the immediate check',
)
check(
  num(host, '__delayedBeam.__intervalCount') === 25,
  'Enable primes the interval counter',
)
host.eval('__beamTick()')
check(
  num(host, '__delayedBeam.__probeHits or 0') === 1 &&
    bool(host, `__delayedBeam.__probeTarget == __units[${victim}]`),
  'the first enabled beam tick checks without waiting one full interval',
)
host.eval('for i = 1, 25 do __beamTick() end')
check(
  num(host, '__delayedBeam.__intervalCount') === 25,
  'after reset, 25 ticks advance the native pre-increment counter without checking',
)
host.eval('__beamTick()')
check(
  num(host, '__delayedBeam.__intervalCount') === 0,
  'the recurring collision check runs on interval + 1 ticks',
)
check(
  num(host, '__delayedBeam.__probeHits or 0') === 2,
  'an unchanged target receives OnImpact again on the recurring collision check',
)

const targetedWarnings = warnings.filter((message) =>
  /WeaponHasTarget|SetBallisticAcceleration|SetImmobile|CollisionBeam/i.test(message),
)
check(
  targetedWarnings.length === 0,
  `no targeted engine warnings (${targetedWarnings.slice(0, 1).join('')})`,
)

// ── Intel: a type InitIntel never created cannot be enabled ─────────────────
//
// CIntel::InitIntel (Cfile:1103700-1103913) is what brings an intel type into
// existence: a grid for Radar/Sonar/Vision/Omni, or a "has" byte for the pure
// switches Jammer/Cloak/RadarStealth/SonarStealth (Cfile:1103907-1103908).
//
// So EnableIntel on a type that was never initialised does NOTHING:
// cfunc_EntityEnableIntelL skips the write when the "has" byte is missing
// (Cfile:933447) and likewise when there is no grid (Cfile:933452-933453).
// IsIntelEnabled reads in the same order — first "has", then "enabled"
// (Cfile:933356-933369).
//
// Before this, EnableIntel created the slot itself, so anything could be
// switched on, including a type the unit does not have.
console.log('\n== Intel: erst InitIntel, dann EnableIntel (Cfile:933447) ==')
{
  const u = spawnLuaUnit(host, 'uel0001', { x: 300, y: 20, z: 300 }, 1)
  const ev = (code: string): unknown => host.eval(`local u = __units[${u}] ${code}`)

  // Never initialised: enabling must not take.
  ev(`u:EnableIntel('Radar')`)
  check(
    ev(`return u:IsIntelEnabled('Radar')`) === false,
    'EnableIntel ohne InitIntel schaltet NICHT ein',
  )

  // Initialised: now it takes, and it survives a disable/enable round trip.
  ev(`u:InitIntel(1, 'Radar', 30)`)
  check(ev(`return u:IsIntelEnabled('Radar')`) === false, 'InitIntel allein schaltet nichts ein')
  ev(`u:EnableIntel('Radar')`)
  check(ev(`return u:IsIntelEnabled('Radar')`) === true, 'nach InitIntel schaltet EnableIntel ein')
  ev(`u:DisableIntel('Radar')`)
  check(ev(`return u:IsIntelEnabled('Radar')`) === false, 'und DisableIntel wieder aus')

  // A different, still uninitialised type stays untouched — proving the "has"
  // bit is per type and not a single flag on the unit.
  check(
    ev(`u:EnableIntel('Omni') return u:IsIntelEnabled('Omni')`) === false,
    'ein anderer, nicht initialisierter Typ bleibt aus (das Bit gilt je Typ)',
  )
  // The radius is a separate channel and must survive all of it.
  check(Number(ev(`return u:GetIntelRadius('Radar')`)) === 30, 'der Radius bleibt 30')
}

// ── Script bits are gated on the RUNTIME toggle-cap mask ────────────────────
//
// Moho::Unit::ToggleScriptBit checks first: `if ((1 << bit) &
// GetAttributes1(this)->mToggleCaps)` (Cfile:951398). Not in the mask means
// nothing happens at all — no flip, no callback. SetScriptBit does no work
// itself; it converts the cap string to an index and delegates
// (Cfile:974910-974925), which is why the gate sits in one place here too.
//
// It has to be the RUNTIME mask, not TestToggleCaps: that one deliberately
// tests the immutable blueprint field (Cfile:975885-975932), while enhancements
// ADD caps at runtime (ual0001_script.lua:261 calls AddToggleCap). Gating on
// the blueprint would make every enhancement inert.
console.log('\n== Script-Bits gegen die Laufzeit-Maske (Cfile:951398) ==')
{
  // A tank has no toggle caps at all — the perfect negative case.
  const tank = spawnLuaUnit(host, 'uel0201', { x: 340, y: 20, z: 340 }, 1)
  const t = (code: string): unknown => host.eval(`local u = __units[${tank}] ${code}`)
  check(
    Number(t(`return __ensureToggleCapMask(u)`)) === 0,
    'uel0201 hat keine ToggleCaps im Blueprint',
  )
  t(`u:SetScriptBit('RULEUTC_ShieldToggle', true)`)
  check(
    t(`return u:GetScriptBit(0)`) === false,
    'ohne Cap schaltet SetScriptBit NICHT (die Engine tut dort gar nichts)',
  )
  // The callback must not have fired either — "nothing happens" is the claim.
  t(`u.OnScriptBitSet = function(self, b) self.__sah = b end`)
  t(`u:ToggleScriptBit(0)`)
  check(t(`return u.__sah == nil`) === true, 'und OnScriptBitSet wurde nicht gerufen')

  // Now give it the cap at runtime, the way an enhancement does. The blueprint
  // is untouched, so TestToggleCaps must still say no — that is the whole point
  // of using the runtime mask instead.
  t(`u:AddToggleCap('RULEUTC_ShieldToggle')`)
  check(
    t(`return u:TestToggleCaps('RULEUTC_ShieldToggle')`) === false,
    'TestToggleCaps prüft weiter das Blueprint (Cfile:975885) und sagt nein',
  )
  t(`u:SetScriptBit('RULEUTC_ShieldToggle', true)`)
  check(t(`return u:GetScriptBit(0)`) === true, 'mit der Laufzeit-Cap schaltet es')
  check(Number(t(`return u.__sah`)) === 0, 'und OnScriptBitSet kam mit Bit 0')

  // Removing the cap again freezes the bit where it is.
  t(`u:RemoveToggleCap('RULEUTC_ShieldToggle') u:SetScriptBit('RULEUTC_ShieldToggle', false)`)
  check(t(`return u:GetScriptBit(0)`) === true, 'ohne Cap lässt es sich auch nicht mehr ausschalten')
}

// ── moho is handed over in the retail C shape ────────────────
//
// globalInit.lua:27-29 states it in prose: "Classes exported from the engine
// are in the 'moho' table. But they aren't full classes yet, just lists of
// exported methods and base classes." Plain tables, methods under string
// keys, base classes in the ARRAY part, no metatable — that is what
// ConvertCClassToLuaClass (class.lua:387-406) consumes: it recurses over
// ipairs(cclass) and converts IN PLACE.
//
// moho.lua used to publish finished Class(base)(spec) objects instead. That is
// why the retail /lua/simInit.lua died at class.lua:273: on the reload Class is
// a NEW table, the getmetatable(cclass)==Class short-circuit (class.lua:389)
// misses, and the conversion runs a second time over a table whose old Class
// metatable carries the __newindex guard.
console.log()
console.log('== Entity:SetScale und Entity:SetHealth halten die Vertraege der Bindung ==')
{
  const id = spawnLuaUnit(host, 'uel0201', { x: 380, y: 20, z: 380 }, 1)
  const e = (code: string): unknown => host.eval(`local u = __units[${id}] ${code}`)
  // `cfunc_EntitySetScaleL` gibt die Entity zurueck (PushStack + return 1,
  // Cfile:935374-935375) — ohne das laeuft jede Kette ins Leere.
  check(e('return u:SetScale(2) == u') === true, 'SetScale gibt self zurueck (Cfile:935374)')
  check(
    String(e(`u:SetScale(1, 2, 3) return string.format('%g,%g,%g', u.__scale[1], u.__scale[2], u.__scale[3])`)) === '1,2,3',
    'die Vier-Argument-Form setzt alle drei Achsen',
  )
  // Und sie WIRFT bei drei Argumenten (lua_gettop != 4 && != 2, Cfile:935304).
  check(
    e(`return (pcall(function() u:SetScale(1, 2) end))`) === false,
    'drei Argumente werfen — sonst entstuende eine Skalierung mit nil in z',
  )

  // `SetHealth` ist die abgeleitete Bindung: delta = argument - mHealth, dann
  // `AdjustHealth` (Cfile:932968-932971). Und `AdjustHealth` laesst eine TOTE
  // Entity nicht heilen (Cfile:915983-915987).
  const maxHp = Number(e('return u:GetMaxHealth()'))
  e(`u:SetHealth(nil, ${maxHp / 2})`)
  check(Number(e('return u:GetHealth()')) === maxHp / 2, 'SetHealth setzt auf einem lebenden Ziel')
  e('u.__dead = true')
  e(`u:SetHealth(nil, ${maxHp})`)
  check(
    Number(e('return u:GetHealth()')) === maxHp / 2,
    'auf einer TOTEN Entity tut ein positives Delta nichts (Cfile:915987)',
  )
  e(`u:SetHealth(nil, ${maxHp / 4})`)
  check(
    Number(e('return u:GetHealth()')) === maxHp / 4,
    'ein negatives Delta geht auch auf einer toten Entity durch',
  )
}

console.log('\n== moho kommt in der Retail-C-Form (globalInit.lua:27-34) ==')
{
  // Measured on a BARE host — installMoho and nothing else. After the boot the
  // handover shape is gone: globalInit.lua:31-34 has already converted it in
  // place, so it can only be observed before that point.
  //
  // The earlier version of this block asserted `__bases[1] == entity_methods`
  // and `getmetatable(entity_methods) == Class` on the booted host. Both hold
  // for the old `Class(base)(spec)` publication too, so the block was green no
  // matter what moho.lua handed over — a check that could not fail.
  const bare = await LuaHost.create(game.luaFiles)
  installMoho(bare)
  check(
    bool(bare, `getmetatable(moho.unit_methods) == nil`),
    'unit_methods traegt keine Metatabelle — eine Methodenliste, keine Klasse',
  )
  check(
    bool(bare, `rawget(moho.unit_methods, 1) == moho.entity_methods`),
    'die Basisklasse steht im ARRAY-Teil (genau das liest ipairs(cclass), class.lua:397)',
  )
  check(
    bool(bare, `rawget(moho.unit_methods, 'GetEntityId') == nil
      and type(rawget(moho.entity_methods, 'GetEntityId')) == 'function'`),
    'und noch nichts ist geerbt — GetEntityId liegt allein in entity_methods',
  )
  bare.close()

  // Und auf dem gebooteten Host hat die Retail-Umwandlung stattgefunden:
  // echte Klassen, mit tragender Vererbung.
  check(
    bool(host, `getmetatable(moho.entity_methods) == Class`),
    'nach dem Boot IST entity_methods eine Klasse (globalInit.lua hat umgewandelt)',
  )
  check(
    host.eval(`return type(moho.unit_methods.GetEntityId)`) === 'function',
    'und die Vererbung traegt (GetEntityId kommt jetzt von entity_methods)',
  )
  // Zweimal umwandeln muss folgenlos sein, nicht ein Fehler — class.lua:389
  // kurzschliesst auf getmetatable(cclass) == Class.
  check(
    bool(host, `(pcall(ConvertCClassToLuaClass, moho.unit_methods))`),
    'ein zweiter ConvertCClassToLuaClass ist folgenlos (class.lua:389 greift)',
  )
  check(
    host.eval(`return type(moho.unit_methods.GetEntityId)`) === 'function',
    'und die Klasse ist danach unversehrt',
  )
}

host.close()
await game.close()
console.log(
  failures === 0
    ? '\nMOHO SIM CONTRACTS PASSED'
    : `\nMOHO SIM CONTRACTS FAILED (${failures})`,
)
process.exit(failures === 0 ? 0 : 1)
