# agent7

## Summary
Weapons/damage in SupCom:FA are divided into two parts: the **engine** (C++, faf-re) operates target acquisition, target tracking (aim manipulator), the firing cycle (`CFireWeaponTask`, tick-quantized) and the damage output; the **Lua layer** (mohodata.scd: `lua/sim/weapon.lua`, `lua/sim/defaultweapons.lua`) only implements the *Salvo state machine* (Racks/Muzzles/Reload/Charge/Unpack) and is clocked by the engine via `OnFire`. Key findings: RateOfFire is quantized as `fireClock = (int)(10 / RateOfFire)` **ticks** (10 Hz Sim), TrackingRadius is a **multiplier** of MaxRadius, `UseGravity` is **true** by default, gravity is `(0, -4.9, 0)`. Critical to the replication: **`SIM_Damage` is NOT reconstructed in the decomp** (stub) — but the `CDamage` payload has *no* falloff field, which structurally proves that the engine applies the full `Amount` to every entity selected by the method lane (no distance falloff); Distance dependence is recreated in FA in Lua using staggered rings (Nuke) or `ScalableRadiusAreaDoT`.

## Key Facts
- The core weapon lua is NOT in lua.scd, but in mohodata.scd: lua/sim/weapon.lua, lua/sim/defaultweapons.lua, lua/sim/DefaultDamage.lua, lua/sim/CollisionBeam.lua, lua/sim/DefaultProjectiles.lua; lua.scd only overwrites lua/sim/Projectile.lua (17 KB) compared to the mohodata stub (618 B).
- Fire clock is engine-side and tick-quantized: CFireWeaponTask::Execute() decrements per tick, fires at fireClock==0 and sets fireClock = (int)(10.0f / RateOfFire) — integer truncation, i.e. RateOfFire=3 gives 3 ticks = 0.30 s (effective 3.33/s), not 0.333 s.
- The engine only calls weapon:OnFire() in Lua; the entire salvo logic (RackBones/MuzzleBones, MuzzleSalvoSize/Delay, RackSalvoChargeTime/ReloadTime, Charge/Pack/Unpack) is the state machine in DefaultProjectileWeapon (IdleState -> RackSalvoCharge -> RackSalvoFireReady -> RackSalvoFiring -> RackSalvoReload).
- Range check is purely 2D (XZ plane, squared distance against MaxRadiusSq/MinRadiusSq) plus separate |dY| <= MaxHeightDiff Check plus HeadingArcRange — EvaluateTargetSolutionStatusGun returns TRS_Available / InsideMinRange / OutsideMaxRange / NoSolution.
- TrackingRadius is a MULTIPLER: Target acquisition range = TrackingRadius * MaxRadius (CAiAttackerImpl.cpp:1266); TargetCheckInterval becomes Ticks: frames = max(1, ceil(interval * 10)).
- FiringTolerance is in degrees and is checked per axis: |normalize(nextAngle - desiredAngle)| > FiringTolerance*DEG2RAD sets 'out of tolerance'; onTarget = no axis outside -> sets weapon->mCanFire and signals the task event.
- TurretYawSpeed/TurretPitchSpeed ​​are degrees/second and become radians/tick: slew = speed * DEG2RAD * 0.1 (kSlewScale); the angular steps are clamped to this slew per tick.
- Weapon-MuzzleVelocity overrides the projectile initial speed: velocity = normalize(launchDir) * GetMuzzleVelocity(dist, rng), with Gaussian jitter (MuzzleVelocityRandom) and short-range damping sqrt(dist/MuzzleVelocityReduceDistance).
- Projektil-Lebensdauer: ProjectileLifetime setzt absolut; ProjectileLifetimeUsesMultiplier setzt lifetime = (MaxRadius / MuzzleVelocity) * Multiplier (ueberschreibt).
- Projektil-Physics-Defaults (RProjectileBlueprint.cpp:98): UseGravity=1, CollideSurface=1, CollideEntity=1, VelocityAlign=1, LeadTarget=1, TrackTarget=0, Lifetime=15.0, InitialSpeed=1.0, TurnRate=0, MaxSpeed=0, Acceleration=0.
- Gravity is SPhysConstants = (0, -4.9, 0) units/s^2; ballistic angle via CalculateFiringPitch (High-/LowArc according to BallisticArc), guided projectiles use TrackTarget + TurnRate (degree/s) + MaxSpeed ​​+ Acceleration.
- SIM_Damage is an empty stub in the decomp (EngineUnrecoveredStubs.cpp:61) — the damage output itself is NOT reconstructed.
- The CDamage payload (CDamage.h) has NO falloff/curve field: only Method (SINGLE_TARGET/AREA_EFFECT/RING_EFFECT), MinMaxRadius, Origin, Amount, Type, DamageFriendly, DamageNeutral, DamageSelf, Vector — so structurally there is nothing to interpolate: full amount on each selected entity, no distance falloff.
- Damage formula (from the comment in lua/shield.lua, which explicitly refers to SimDamage.cpp DealDamage): effective = amount * GetArmorMult(damageType) * (1.0 - ArmyGetHandicap(army)) — first armor, then handicap.
- Armor-Multiplikatoren (lua/armordefinition.lua): Default/Normal/Light = Normal 1.0; Commander = Overcharge 0.033333, Deathnuke 0.05; Structure = Overcharge 0.066666, Deathnuke 0.01; Experimental = ExperimentalFootfall 0.0.
- Drei Lua-Schadens-Globals mit exakten Signaturen: Damage(instigator, origin, target, amount, type) [5 Args], DamageArea(instigator, origin, radius, amount, type, damageFriendly, [damageSelf]) [6-7], DamageRing(instigator, origin, minR, maxR, amount, type, damageFriendly, [damageSelf]) [7-8; minR < maxR erzwungen].
- Overkill: excessDamageRatio = -(preAdjHealth - amount) / maxHealth (only if negative); overkillRatio > 1.0 -> NO wreck (vaporized).
- Wreck values: mass = BuildCostMass * Wreckage.MassMult, energy = BuildCostEnergy * Wreckage.EnergyMult, then scaled by (1 - overkillRatio) * GetFractionComplete(); Wreckage HP = Defense.Health * Wreckage.HealthMult.
- Shield Absorption: OnGetDamageAbsorption returns min(shieldHealth, amount * ArmorMult * (1-Handicap)); PassOverkillDamage forwards the excess (amount*mult - shieldHealth, min 0) directly to the owner via DoTakeDamage (overspill).
- Shield regeneration: RegenStartThread waits ShieldRegenStartTime and then adds ShieldRegenRate every second; each hit kills the rain thread and restarts it. If HP<=0 -> DamageRechargeState: Shield gone, ChargingUp(ShieldRechargeTime), then full HP.
- Beam weapons (defaultBeamWeapon) do not produce projectiles: one CollisionBeam per MuzzleBone with CollisionCheckInterval = BeamCollisionDelay * 10 (ticks); BeamLifetime > 0 = pulsed, BeamLifetime == 0 = continuous beam (hold-fire watchdog). CollisionBeam.DoDamage without radius and without targetEntity makes DamageArea with radius 0.25.

## Details
## 0. Quellenlage / Architektur

**Zwei Ebenen, sauber getrennt:**

| level | Location | Responsibility |
|---|---|---|
| Engine (C++) | `faf-re/src/sdk/moho/` | Zielerfassung, Aim/Turret, Feuertakt (`fireClock`), Projektil-Spawn+Physik, Kollision, Schadensausbringung, Armor/Handicap |
| Lua Sim | `mohodata.scd` + `lua.scd` | Salven-Zustandsmaschine, Effekte, DoT, Nuke-Ringe, Schilde, Tod/Wrack |

**Important: The core weapon lua is in `mohodata.scd`, NOT `lua.scd`:**
- `mohodata.scd!lua/sim/weapon.lua` (19.9 KB) — Basisklasse `Weapon`
- `mohodata.scd!lua/sim/defaultweapons.lua` (38.6 KB) — `DefaultProjectileWeapon` (RackSalvo-FSM), `DefaultBeamWeapon`, `KamikazeWeapon`, `BareBonesWeapon`
- `mohodata.scd!lua/sim/DefaultDamage.lua` (2.0 KB) — `UnitDoTThread`, `AreaDoTThread`, `ScalableRadiusAreaDoT`
- `mohodata.scd!lua/sim/CollisionBeam.lua` (11.2 KB)
- `mohodata.scd!lua/sim/DefaultProjectiles.lua` (7.5 KB)
- `lua.scd!lua/sim/Projectile.lua` (17.4 KB) — **overwrites** the 618 byte stub in mohodata
- `lua.scd!lua/shield.lua`, `lua.scd!lua/wreckage.lua`, `lua.scd!lua/armordefinition.lua`, `lua.scd!lua/defaultexplosions.lua`, `lua.scd!lua/sim/Unit.lua`

Loading order: lua.scd wins against mohodata.scd with the same path.

---

## 1. Feuerzyklus

### 1a. Engine-Takt (autoritativ) — `CFireWeaponTask::Execute()`

Runs **every SIM tick (10 Hz)**:

```
if (fireClock != 0) --fireClock;
if (!weapon || !weapon->mEnabled)        return;   // deaktiviert
if (weapon->blueprint->ManualFire)       return;   // nur per Befehl

if (fireClock == 0
    && unit->FireState != HOLD_FIRE
    && weapon->mTarget.type != AITARGET_None)
{
    if (CanAttackTarget(weapon) && CheckSilo(weapon)
        && TargetIsTooClose(weapon) == TRS_Available)
    {
        if (!blueprint->CannotAttackGround || target.type != Ground) {
            weapon->RunScript("OnFire");     // <-- der EINZIGE Lua-Aufruf
            ++weapon->mShotsAtTarget;

            rof = attributes.mRateOfFire;            // Lua-Override
            if (rof < 0) rof = blueprint->RateOfFire; // sonst Blueprint
            if (rof > 0) fireClock = (int)(10.0f / rof);   // TRUNKIERT!
        }
    }
}
```

**RateOfFire-Semantik — exakt:**
- Unit: **shots per second**
- Nachladezeit in Ticks: `N = floor(10 / RateOfFire)` — **Ganzzahl-Trunkierung**
- Period = exactly `N` ticks (firing at tick T, again at T+N)

| RateOfFire | N (Ticks) | reale Periode | effektive RoF |
|---|---|---|---|
| 1.0 | 10 | 1.000 s | 1.00/s |
| 2.0 | 5 | 0.500 s | 2.00/s |
| **3.0** | **3** | **0.300 s** | **3.33/s** (!) |
| **1.5** | **6** | **0.600 s** | **1.67/s** (!) |
| 0.5 | 20 | 2.000 s | 0.50/s |

This quantization must be reproduced in the replica, otherwise all DPS values ​​will differ.

**Lua overrides:** `weapon:ChangeRateOfFire(v)` writes `CWeaponAttributes::mRateOfFire`. If the value is `< 0`, the blueprint value applies (Sentinel pattern; applies analogously to MinRadius/MaxRadius/MaxHeightDiff/Damage/DamageRadius/FiringTolerance).

### 1b. Lua-Zustandsmaschine — `DefaultProjectileWeapon` (defaultweapons.lua)

The engine just calls `OnFire`. Everything else is FSM:

```
                 OnGotTarget / OnFire
IdleState ─────────────────────────────► RackSalvoChargeState   (wenn RackSalvoChargeTime > 0)
    │                                          │ WaitSeconds(RackSalvoChargeTime)
    │                                          ▼
    │                              RackSalvoFiresAfterCharge?
    │                                   ja │        │ nein
    │                                      ▼        ▼
    └──────────────────────────► RackSalvoFireReadyState
                                           │ OnFire (wenn WeaponCanFire)
                                           ▼
                                  RackSalvoFiringState
                                           │
                        RackSalvoReloadTime > 0 ? ──► RackSalvoReloadState ──► (Ziel? Charge/Ready : Idle)
                                           └────────► RackSalvoFireReadyState
```

Additional branches: `WeaponUnpackingState` / `WeaponPackingState` (at `WeaponUnpacks == true`), `DeadState`.

**`RackSalvoFiringState.Main` — the core (defaultweapons.lua:526-644):**

```lua
self.unit:SetBusy(true)
self:DestroyRecoilManips()
numRackFiring = self.CurrentRackSalvoNumber
if bp.RackFireTogether then numRackFiring = table.getsize(bp.RackBones) end

if bp.RenderFireClock and bp.RateOfFire > 0 then
    ForkThread(RenderClockThread, 1 / bp.RateOfFire)   -- UI-Uhr
end

while self.CurrentRackSalvoNumber <= numRackFiring and not self.HaltFireOrdered do
    rackInfo = bp.RackBones[self.CurrentRackSalvoNumber]

    numMuzzlesFiring = bp.MuzzleSalvoSize
    if bp.MuzzleSalvoDelay == 0 then
        numMuzzlesFiring = table.getn(rackInfo.MuzzleBones)   -- ALLE gleichzeitig
    end

    muzzleIndex = 1
    for i = 1, numMuzzlesFiring do
        muzzle = rackInfo.MuzzleBones[muzzleIndex]
        if rackInfo.HideMuzzle then self.unit:ShowBone(muzzle, true) end

        if bp.MuzzleChargeDelay > 0 then
            PlayFxMuzzleChargeSequence(muzzle)
            WaitSeconds(bp.MuzzleChargeDelay)
        end

        PlayFxMuzzleSequence(muzzle)
        if rackInfo.HideMuzzle then self.unit:HideBone(muzzle, true) end

        self:CreateProjectileAtMuzzle(muzzle)          -- <<< SCHUSS

        if bp.CountedProjectile then                    -- Silo-Munition
            if bp.NukeWeapon then self.unit:RemoveNukeSiloAmmo(1)
            else                  self.unit:RemoveTacticalSiloAmmo(1) end
        end

        muzzleIndex = muzzleIndex + 1
        if muzzleIndex > table.getn(rackInfo.MuzzleBones) then muzzleIndex = 1 end  -- WRAP

        if bp.MuzzleSalvoDelay > 0 then WaitSeconds(bp.MuzzleSalvoDelay) end
    end

    self:PlayFxRackReloadSequence()      -- Recoil, CameraShake, ShipRock
    if self.CurrentRackSalvoNumber <= table.getn(bp.RackBones) then
        self.CurrentRackSalvoNumber = self.CurrentRackSalvoNumber + 1
    end
end
```

**Semantics of Salvo parameters:**
- `MuzzleSalvoDelay == 0` → **all** MuzzleBones of the rack fire in one tick at the same time (`MuzzleSalvoSize` is ignored!)
- `MuzzleSalvoDelay > 0` → exactly `MuzzleSalvoSize` shots, with `MuzzleSalvoDelay` seconds pause in between; `muzzleIndex` runs cyclically over the MuzzleBones (wrap-around, i.e. MuzzleSalvoSize can be > number of bones)
- `RackFireTogether == true` → the while loop runs over **all** racks in one pass
- otherwise: **exactly one rack** fires per `OnFire`, `CurrentRackSalvoNumber` moves on (rack round robin over several on-fire cycles)
- Rack reset: if `CurrentRackSalvoNumber > #RackBones` → back to 1, then `RackSalvoReloadTime` (if > 0)
- `IdleState`: with >1 rack and `CurrentRackSalvoNumber > 1`, wait for `RackReloadTimeout`, then reset on rack 1

**Validation constraints from `OnCreate` (defaultweapons.lua:30-88) - adopt in the replica:**
- `(NumMuzzles - 1) * MuzzleSalvoDelay` must be `<= 1/RateOfFire` (otherwise error)
- `RackRecoilDistance != 0` **and** `MuzzleSalvoDelay != 0` is prohibited
- Recoil reset speed (if not set):
  `RackRecoilReturnSpeed = |dist / ((1/RateOfFire) - MuzzleChargeDelay)| * 1.25`

**Interlock:** `RackSalvoFiringState` sets `unit:SetBusy(true)`. `UnitWeapon::CanFire()` (Engine) checks `IsUnitState(UNITSTATE_Busy)` → Weapon is considered not ready to fire as long as the volley is ongoing. `NotExclusive = true` cancels this during waits. A `OnFire` during `RackSalvoFiringState` has no handler → falls back to `Weapon.OnFire` (sound only, no shot).

**Energy:** `StartEconomyDrain` creates `CreateEconomyEvent(unit, EnergyRequired, 0, max(0.1, EnergyRequired/EnergyDrainPerSecond))`. `RackSalvoFireReadyState` blocks (`WeaponCanFire = false`) until the event is finished.

---

## 2. Aiming

### 2a. Turret-Setup (weapon.lua:53-150)

```lua
AimControl = CreateAimController(self, 'Default', TurretBoneYaw, TurretBonePitch, TurretBoneMuzzle)
AimControl:SetPrecedence(AimControlPrecedence or 10)
if STRUCTURE then AimControl:SetResetPoseTime(9999999) end -- Towers remain stationary

turretyawmin,   turretyawmax   = TurretYaw   - TurretYawRange,   TurretYaw   + TurretYawRange
turretpitchmin, turretpitchmax = TurretPitch - TurretPitchRange, TurretPitch + TurretPitchRange
AimControl:SetFiringArc(yawmin, yawmax, TurretYawSpeed, pitchmin, pitchmax, TurretPitchSpeed)
```
- **`TurretYaw`/`TurretPitch` are midpoints**, `*Range` is the **half span** (not the full span!)
- `TurretDualManipulators` → 3 Manipulatoren (Torso/Right/Left); Left/Right bekommen `yawmin/12, yawmax/12`
- `RackSlavedToTurret` → `CreateSlaver(unit, RackBone, pitchBone)` with `Precedence - 1`

### 2b. Slew-Umrechnung (CAimManipulator.cpp:1197-1206)

```cpp
// Lua-Grad -> Engine-Radiant/Tick
radiansArc.mHeadingMaxSlew = luaValue * DEG2RAD;          // 0.017453292
runtimeArc.mHeadingMaxSlew = radiansArc.mHeadingMaxSlew * 0.1f;   // kSlewScale
```
→ **`slewPerTick = TurretYawSpeed [deg/s] * DEG2RAD * 0.1`**. So TurretYawSpeed ​​is degrees **per second**.
Verified in the decompilation: `cfunc_CAimManipulatorSetFiringArcL` multiplies all six arguments by
0.017453292 (Cfile:862766-862790) and then the two slews by 0.1 (Cfile:862796-862802) before
`CAimManipulator::SetFiringArc` stores them unchanged (Cfile:861886-861920); `CheckTracking` caps
the per-tick step to that value (Cfile:861838-861842), and `CAniActor::UpdateManipulators` runs once
per `Unit::MotionTick` (Cfile:869201-869237).

`SetFiringArc` speichert zentriert:
- `mMinHeading = NormalizeCenteredAngle(min, max)` (= Arc-Mitte)
- `mMaxHeading = |max - min| * 0.5` (= Halbspanne)

### 2c. Tracking step per tick (`CheckTracking`, CAimManipulator.cpp:1239-1327)

```cpp
// Ziel in Bone-lokalen Raum
transformedTarget = conj(bone.compositeOrient) * targetDirection;

// Soll-Winkel
if (HEADING) desiredAngle = atan2(t.x, t.z) + mHeadingOffset;
else         desiredAngle = minAngleCenter - ComputePitchRadians(pitchSpaceTarget);

// Arc-Klemmung
if (maxAngleHalfRange < PI) {
    c = clamp(NormalizeAngle(desiredAngle - center), -halfRange, +halfRange);
    laneDelta = (c + center) - currentAngle;
} else {
    laneDelta = NormalizeAngle(desiredAngle - currentAngle);
}

// Slew-Klemmung
step = clamp(laneDelta, -maxSlew, +maxSlew);
nextAngle = NormalizeAngle(currentAngle + step);

// Bewegungs-Flag (fuer OnStartTracking/OnStopTracking)
if (HEADING && |laneDelta| > 0.001) result |= HEADING_MOTION;

// TOLERANZ
if (!(PITCH && YawOnlyOnTarget)) {
    if (|NormalizeAngle(nextAngle - desiredAngle)| > tolerance) result |= OUTSIDE_TOLERANCE;
}
```
mit `tolerance = FiringTolerance [Grad] * DEG2RAD` (Default `FiringTolerance = 0.01`).

`Track()` (CAimManipulator.cpp:1386): `onTarget = !(result & OUTSIDE_TOLERANCE)` over both axes. Then:
```cpp
weapon->mCanFire = onTarget ? 1 : 0;    // nur wenn Label matcht (SetFireControl)
// Verified: stricmp(UnitWeapon::GetLabel(), manip->mLabel) == 0 (Cfile:862060-862085);
// the weapon label starts as "Default" (ctor, Cfile:984161), SetFireControl replaces it
// (Cfile:987460), IsFireControl is the same stricmp (Cfile:987526). weapon.lua:78-87
// creates Torso/Right/Left for TurretDualManipulators and hands fire control to 'Right'.
taskEvent->EventSetSignaled(onTarget);  // gibt CFireWeaponTask frei
```
`YawOnlyOnTarget = true` → Pitch is skipped during the tolerance check (weapon fires as soon as Yaw is correct).

### 2d. Target advance & ballistic solution (`Aim`, CAimManipulator.cpp:941-1106)

```
muzzlePos = boneWorldTransform.pos; if (unit mobil) muzzlePos += unit.velocity
predictedImpact = targetPos + targetVelocity          // 1 Tick Basis-Vorhalt

horizDist = |muzzlePos.xz - predictedImpact.xz|
projectileSpeed = (MuzzleVelocityReduceDistance <= horizDist)
                ? MuzzleVelocity
                : sqrt(horizDist / MuzzleVelocityReduceDistance) * MuzzleVelocity

if (weapon.LeadTarget && target ist Entity) {
    scaledVel = targetVelocity * 10          // Tick -> Sekunde
    if (proj.TrackTarget)      PredictInterceptPointConstantSpeed(..., proj.MaxSpeed, ...)
    else if (proj.UseGravity)  PredictInterceptPointFromForwardVelocity(...)   // 10 Iterationen
    else                       PredictInterceptPointConstantSpeed(..., projectileSpeed, ...)
}

if (!proj.TrackTarget && proj.UseGravity) {
    CalculateFiringPitch(&highArc, muzzlePos, predictedImpact, physConst, projectileSpeed, &lowArc)
    arc = (weapon.BallisticArc == RULEUBA_HighArc) ? highArc : lowArc
    CalculateFiringDirection(&aimDir, predictedImpact, muzzlePos, arc)
} else {
    aimDir = normalize(predictedImpact - muzzlePos)   // direkt
}
```

**`CalculateFiringPitch` (CAimManipulator.cpp:647-677) — exakte Formel:**
```
d  = |target.xz - muzzle.xz|                       // Horizontaldistanz
dy = target.y - muzzle.y
k  = -(d * d * g_y) / (2 * v * v)                  // g_y = -4.9
disc = d*d - 4 * (dy + k) * k
if (disc < 0) return false                          // unerreichbar
highArc = -atan2((sqrt(disc) + d) / (2k), 1)
lowArc  = -atan2((d - sqrt(disc)) / (2k), 1)
```
**`CalculateFiringDirection` (CAimManipulator.cpp:686-707):**
```
dir.xz = normalize(from.xz - to.xz) * cos(pitch)    // Achtung: from/to Reihenfolge
dir.y  = -sin(pitch)
```

### 2e. Range & Target Solution (`EvaluateTargetSolutionStatusGun`, UnitWeapon.cpp:496-560)

```cpp
distSq = (target.x - unit.x)^2 + (target.z - unit.z)^2;   // NUR XZ, 2D!

if (distSq >  mMaxRadiusSq) return TRS_OutsideMaxRange;
if (distSq <= mMinRadiusSq) return TRS_InsideMinRange;    // <= , nicht <

if (|target.y - unit.y| > MaxHeightDiff) return TRS_OutsideMaxRange;

if (HeadingArcRange < 180.0f) {
    targetHeading = atan2(target.x - muzzle.x, target.z - muzzle.z);
    unitHeading   = atan2(forward.x, forward.z);
    delta = NormalizeSigned(targetHeading - unitHeading - HeadingArcCenter*DEG2RAD);
    if (|delta| > HeadingArcRange*DEG2RAD) return TRS_NoSolution;
}
return TRS_Available;
```
Only `TRS_Available` allows firing (CFireWeaponTask checks `TargetIsTooClose(...) != TRS_Available`).

### 2f. Zielerfassung / Priorisierung

- **Detection Radius = `TrackingRadius * MaxRadius`** (CAiAttackerImpl.cpp:1256-1270) — TrackingRadius is a **multiplier**, not an absolute value (e.g. UEL0201: 1.15 → 18 * 1.15 = 20.7)
- **Check Interval:** `frames = max(1, ceil(TargetCheckInterval * 10))` Ticks (CAiAttackerImpl.cpp:468-472); `NeedPrep` → fix 2 frames.
  Verified: `CAcquireTargetTask::TaskTick` computes it (Cfile:792900-792908) and RETURNS `frames + 1`
  (Cfile:792912, 793226); `DoTaskTick` stores `frames` (Cfile:438947) and pre-decrements every tick
  (Cfile:438898). The rhythm is the task's own: its `CTaskThread` starts at `mWaitTicks = 0`
  (Cfile:438797), so the FIRST check is the weapon's first tick, then every `frames` ticks -- not
  the multiples of `frames` on the game clock.
- **Priorities:** `TargetPriorities` (list of category strings) → `weapon:SetTargetingPriorities(parsedCategories)`. The engine iterates the list **from index 0 up** (0 = highest priority) and stops as soon as a better candidate is found; Already seen targets (`RECON_LOSEver`) are given priority (CAiAttackerImpl.cpp:1147-1170)
- **Filter:** `TargetRestrictOnlyAllow` / `TargetRestrictDisallow` (categories) → `mCat1`/`mCat2`; `FireTargetLayerCapsTable[layer]` → `SetFireTargetLayerCaps` (Land/Water/Seabed/Air mask, is reset when changing layers, weapon.lua:347-359)
- More gates in `UnitWeapon::CanFire` (UnitWeapon.cpp:3172): Stun, `UNITSTATE_Busy`, flyer not in the air layer, `NeedUnpack` without immobile, `AboveWaterFireOnly`/`BelowWaterFireOnly` (muzzle height vs. water level), bomb drop timing (`NeedToComputeBombDrop`, `BombDropThreshold`)

---

## 3. Projektil-Physik

### 3a. Spawn (`UnitWeapon::CreateProjectile`, UnitWeapon.cpp:3666-3759)

```cpp
launchTransform = unit->GetBoneWorldTransform(muzzleBone);

if (proj.StraightDownOrdinance)           launchTransform.orient = Orient({0,-1,0});
else if (weapon.UseFiringSolutionInsteadOfAimBone) launchTransform.orient = Orient(normalize(mAimingAt));

if (mFiringRandomness > 0) {              // Streuung, in GRAD
    pitchJitter   = rng.FRandGaussian() * mFiringRandomness * DEG2RAD;
    headingJitter = rng.FRandGaussian() * mFiringRandomness * DEG2RAD;
    launchTransform.orient = Orient(headingJitter, pitchJitter) * launchTransform.orient;
}

proj = PROJ_Create(sim, projBp, army, unit, launchTransform,
                   damage, damageRadius, damageType, target, IgnoresAlly);

// MuzzleVelocity ueberschreibt Projektil-InitialSpeed:
if (weapon.MuzzleVelocity != 0) {
    dist = |launchPos - targetPos|;                        // 3D!
    v = weapon.GetMuzzleVelocity(dist, rng);
    proj.velocity = normalize(proj.velocity) * v;
}

if (weapon.ProjectileLifetime > 0) proj->SetLifetime(weapon.ProjectileLifetime);
if (weapon.ProjectileLifetimeUsesMultiplier > 0 && weapon.MuzzleVelocity > 0)
    proj->SetLifetime((weapon.MaxRadius / weapon.MuzzleVelocity) * weapon.ProjectileLifetimeUsesMultiplier);
```

**`GetMuzzleVelocity` (RUnitBlueprint.cpp:1126-1138):**
```cpp
v = MuzzleVelocity;
if (MuzzleVelocityRandom != 0) v += rng.FRandGaussian() * MuzzleVelocityRandom;
if (MuzzleVelocityReduceDistance > targetDistance)
    return v * sqrt(targetDistance / MuzzleVelocityReduceDistance);   // Nahbereichs-Daempfung
return v;
```

Beispiel UEL0201 (T1-Panzer): MaxRadius 18, MuzzleVelocity 25, Mult 1.15 → Lifetime = 18/25 * 1.15 = **0.828 s**.

### 3b. Projektil-Blueprint (`RProjectileBlueprintPhysics`, RProjectileBlueprint.h:52-92)

Fields (with defaults from RProjectileBlueprint.cpp:98-143):

| field | Default | Meaning |
|---|---|---|
| `CollideSurface` | **1** | Kollidiert mit Terrain/Wasser |
| `CollideEntity` | **1** | Kollidiert mit Entities |
| `TrackTarget` | 0 | Directed (pursues goal) |
| `VelocityAlign` | **1** | Mesh aligns with speed |
| `StayUpright` | 0 | |
| `LeadTarget` | **1** | Vorhalt |
| `StayUnderwater` | 0 | Torpedos |
| **`UseGravity`** | **1** | **Ballistik an (Default!)** |
| `DetonateAboveHeight` / `DetonateBelowHeight` | 0 / 0 | Airburst |
| **`TurnRate`** (+Range) | 0 | **Degrees/s** Rotation rate at TrackTarget |
| **`Lifetime`** (+Range) | **15.0** | Sekunden |
| `InitialSpeed` (+Range) | 1.0 | is overwritten by MuzzleVelocity |
| `MaxSpeed` (+Range) | 0 | Kappung |
| `Acceleration` (+Range) | 0 | Units/s² along flight direction |
| `Position*` / `Direction*` (+Range) | 0 / (0,1,0), Range 1.5 | Spawn-Streuung |
| `RotationalVelocity` (+Range) | 0 | |
| `MaxZigZag` / `ZigZagFrequency` | 0 / 0 | Evasive maneuvers |
| `DestroyOnWater` | 0 | |
| `MinBounceCount` / `MaxBounceCount` / `BounceVelDamp` | 0 / 0 / 0.5 | Abpraller |
| `RealisticOrdinance` / `StraightDownOrdinance` | 0 / 0 | Bomben |

**Gravity:** `SPhysConstants::mGravity = (0.0f, -4.9f, 0.0f)` (SPhysConstants.h:13) — Units/s².
Per tick (dt = 0.1 s): `v += g * 0.1`, `pos += v * 0.1`. (The debug canvas uses `g * 0.01` = a dt² and `v * 0.1` = v dt — confirms dt = 0.1.)

**`BallisticAcceleration`** is **not a blueprint field**, but a runtime vector (`Projectile::mBallisticAcceleration`, Projectile.cpp:62/126, offset 0x2BC), set from Lua:
- `proj:SetBallisticAcceleration(y)` — Scalar = Y component only
- `proj:SetBallisticAcceleration(x, y, z)` — voller Vektor

Evidence from the game Lua: `self:SetBallisticAcceleration(0, -9.5, 0)`, `SetBallisticAcceleration(-0.5)`, `SetBallisticAcceleration(0, -89.92, 0)` (bombs), `defaultexplosions.lua:319`: Debris with `SetBallisticAcceleration(GetRandomFloat(-2,-3))`. Overrides/replaces the global gravity for this projectile.

**Projektil-Lua-API** (ProjectileLuaFunctionThunks.cpp:14-43) — komplett:
`GetLauncher`, `GetTrackingTarget`, `GetCurrentTargetPosition`, `SetNewTarget`, `SetNewTargetGround`, `SetLifetime`, `SetDamage`, `SetMaxSpeed`, `SetAcceleration`, `SetBallisticAcceleration`, `SetDestroyOnWater`, `SetTurnRate`, `GetCurrentSpeed`, `GetVelocity`, `SetVelocity`, `SetScaleVelocity`, `SetLocalAngularVelocity`, `SetCollision`, `SetCollideSurface`, `SetCollideEntity`, `StayUnderwater`, `TrackTarget`, `SetStayUpright`, `SetVelocityAlign`, `CreateChildProjectile`, `SetVelocityRandomUpVector`, `ChangeMaxZigZag`, `ChangeZigZagFrequency`, `ChangeDetonateAboveHeight`, `ChangeDetonateBelowHeight`

### 3c. Kollisionsmodell — drei getrennte Wege

**(A) Projectile** — Engine detects hit, calls Lua filter, then `Projectile:OnImpact(targetType, targetEntity)`.

Filter chain (all must supply `true`):
1. `Projectile:OnCollisionCheck(other)` (lua/sim/Projectile.lua:89-126):
   - `false` at: TORPEDO↔TORPEDO, TORPEDO↔DIRECTFIRE, MISSILE↔MISSILE, MISSILE↔DIRECTFIRE, DIRECTFIRE↔MISSILE, **same army**
   - `false` if `other.Physics.HitAssignedTarget` and `other:GetTrackingTarget() != self`
   - `DoNotCollideList` beidseitig (Kategorien)
2. `Unit:OnCollisionCheck(other, firingWeapon)` (Unit.lua:972): with the same army → `other:GetCollideFriendly()` (= `DamageData.CollideFriendly`)
3. `Unit:OnCollisionCheckWeapon(firingWeapon)` (Unit.lua:1005): `CollideFriendly == false` + same army → `false`; `DoNotCollideList` of the weapon

`targetType` ∈ {`Unit`, `UnitAir`, `UnitUnderwater`, `Terrain`, `Water`, `Underwater`, `Air`, `Prop`, `Shield`, `Projectile`, `ProjectileUnderwater`}

`OnImpact` (Projectile.lua:259-356): `DoDamage` → `DoMetaImpact` → `DoUnitImpactBuffs` → Sound (`Audio['Impact'..targetType]` with fallback `Audio.Impact`) → Impact-FX + Terrain-FX → `OnImpactDestroy` (or `ImpactTimeout` for terrain).

**(B) Beam** (`DefaultBeamWeapon`, defaultweapons.lua:785-995 + CollisionBeam.lua):
- Generates **per MuzzleBone** a `CollisionBeam` at `OnCreate` (not a projectile!)
- `CollisionCheckInterval = BeamCollisionDelay * 10` (**Ticks**)
- `BeamLifetime > 0` → pulse beam, `ForkThread(BeamLifetimeThread, BeamLifetime)` switches off
- `BeamLifetime == 0` → **continuous beam**; `WatchForHoldFire` checks `unit:GetFireState() == 1` every second
- `CollisionBeam:OnImpact` only fires when the object hit **changes** (not every tick)
- `CollisionBeam:DoDamage` (CollisionBeam.lua:67-96):
  ```lua
  dmgmod = product(self.Weapon.DamageModifiers)   -- multiplikativ
  damage = damageData.DamageAmount * dmgmod
  if radius > 0        → DamageArea(instigator, self:GetPosition(1), radius, damage, type, friendly)
  elseif targetEntity  → Damage(instigator, self:GetPosition(), targetEntity, damage, type)
  else                 → DamageArea(instigator, self:GetPosition(1), 0.25, damage, type, friendly)   -- Fallback!
  ```
  (`GetPosition(1)` = end point of the beam)
- `MaximumBeamLength` in the weapon blueprint limits the beam length
- Energy gate: `EconomySupportsBeam()` → `energyStored < EnergyRequired && energyIncome < EnergyDrainPerSecond` → beam off, back to `IdleState`

**(C) SplashDamage** is not a separate mechanism — it is simply `DamageArea` with `DamageRadius > 0` in `Projectile:DoDamage`.

---

## 4. Schaden

### 4a. DoDamage-Kette (Projectile.lua:173-192)

```lua
DoDamage = function(self, instigator, damageData, targetEntity)
    local damage = damageData.DamageAmount
    if damage and damage > 0 then
        local radius = damageData.DamageRadius
        if radius and radius > 0 then
            if not damageData.DoTTime or damageData.DoTTime <= 0 then
                DamageArea(instigator, self:GetPosition(), radius, damage,
                           damageData.DamageType, damageData.DamageFriendly,
                           damageData.DamageSelf or false)
            else
                ForkThread(AreaDoTThread, instigator, self:GetPosition(),
                           damageData.DoTPulses or 1,
                           damageData.DoTTime / (damageData.DoTPulses or 1),
                           radius, damage, damageData.DamageType, damageData.DamageFriendly)
            end
        elseif damageData.DamageAmount and targetEntity then
            if not damageData.DoTTime or damageData.DoTTime <= 0 then
                Damage(instigator, self:GetPosition(), targetEntity,
                       damageData.DamageAmount, damageData.DamageType)
            else
                ForkThread(UnitDoTThread, instigator, targetEntity, ...)
            end
        end
    end
end
```
`instigator` = `self:GetLauncher()`, Fallback `self` (Projectile.lua:264-267).

**DamageData is passed at spawn** (`Weapon:GetDamageTable` → `proj:PassDamageData`, weapon.lua:284-345):
```lua
DamageRadius     = bp.DamageRadius + (self.DamageRadiusMod or 0)
DamageAmount     = bp.Damage       + (self.DamageMod or 0)
DamageType       = bp.DamageType
DamageFriendly   = bp.DamageFriendly  -- Default TRUE wenn nil!
CollideFriendly  = bp.CollideFriendly or false
DoTTime, DoTPulses, MetaImpactAmount, MetaImpactRadius, Buffs
```

### 4b. The three damage globals (exact signatures from CDamageLuaFunctionRegistrations.cpp)

```
Damage    (instigator, origin, target, amount, damageType)                              -- 5 Args
DamageArea(instigator, origin, radius, amount, damageType, damageFriendly [, damageSelf]) -- 6..7
DamageRing(instigator, origin, minRadius, maxRadius, amount, damageType, damageFriendly [, damageSelf]) -- 7..8
```
- `Damage`: `mMethod = CDamage_SINGLE_TARGET`, `mVector = target.Position - origin` (Trefferrichtung, geht in `OnDamage(vector)`)
- `DamageArea`: `mMethod = CDamage_AREA_EFFECT`, `mRadius`; Error with `amount == 0` or `radius == 0`
- `DamageRing`: `mMethod = CDamage_RING_EFFECT`, `mRadius = min`, `mMaxRadius = max`; erzwingt `min < max`
- `damageSelf` optional, default `false`. `damageNeutral` is present in the payload (default 1), but cannot be set via the Lua API.

### 4c. DamageRadius-Falloff — WICHTIGER BEFUND

**`SIM_Damage` is NOT reconstructed in faf-re-decomp** — empty stub:
`faf-re/src/sdk/moho/EngineUnrecoveredStubs.cpp:61`:
```cpp
void SIM_Damage(class moho::Sim *, class moho::CDamage const &) {}
```

**But:** the `CDamage` payload (CDamage.h:75-89, `sizeof == 0x8C`) contains **not a single falloff, curve, or min-damage field**:
```
+0x34 CDamageMethod mMethod        // SINGLE_TARGET=0 | AREA_EFFECT=1 | RING_EFFECT=2
+0x48 float mRadius                \_ reflektiert als SMinMax<float> "MinMaxRadius"
+0x4C float mMaxRadius             /
+0x50 Vec3f mOrigin
+0x5C float mAmount
+0x60 string mType
+0x7C uint8 mDamageFriendly
+0x7D uint8 mDamageNeutral
+0x7E uint8 mDamageSelf
+0x80 Vec3f mVector
```
Reflected fields (CDamage.cpp:466-477): `Method, MinMaxRadius, Origin, Amount, Type, DamageFriendly, DamageNeutral, DamageSelf, Vector`.

→ **Conclusion (structurally proven):** There is **no distance falloff** on the engine side. The engine selects entities by `mMethod` (point / sphere `radius` / annulus `[radius, maxRadius]`) and applies the **full `mAmount`** to each. A falloff would not be possible without parameters.

**Distance dependency is modeled in FA in Lua instead:**
1. **Nuke-Ringe** (gestaffelte, disjunkte Annuli — corpus/aeonprojectiles-Nuke, Zeilen 213156-213192):
   ```lua
   ringWidth  = NukeOuterRingRadius / NukeOuterRingTicks
   tickLength = NukeOuterRingTotalTime / NukeOuterRingTicks
   DamageArea(launcher, pos, ringWidth, NukeOuterRingDamage, 'Normal', true, true)
   WaitSeconds(tickLength)
   for i = 2, NukeOuterRingTicks do
       DamageRing(launcher, pos, ringWidth*(i-1), ringWidth*i, NukeOuterRingDamage, type, true, true)
       WaitSeconds(tickLength)
   end
   ```
   Inner and outer ring run as **two parallel threads**. Defaults (weapon.lua:330-340):
   `NukeInnerRingDamage=2000, Radius=30, Ticks=24, TotalTime=24`;
   `NukeOuterRingDamage=10, Radius=40, Ticks=20, TotalTime=10`.
   → Unit at r=10: 1× inner pulse (2000) + 1× outer pulse (10). Unit at r=35: Outer (10) only. Hard cutoff at 30, no soft falloff.
2. **`ScalableRadiusAreaDoT`** (DefaultDamage.lua:34-55) — linear schrumpfender Radius:
   ```lua
   reductionScalar = (StartRadius - EndRadius) * Frequency / (Duration - Frequency)
   duration = floor(Duration / Frequency)
   for i = 1, duration do
       DamageArea(entity, position, radius, Damage, Type, DamageFriendly)
       radius = radius - reductionScalar
       WaitSeconds(Frequency)
   end
   ```
3. **DoT** (DefaultDamage.lua:11-27):
   ```lua
   UnitDoTThread: for i=1,pulses do Damage(instigator, unit:GetPosition(), unit, damage, damType); WaitSeconds(pulseTime) end
   AreaDoTThread: for i=1,pulses do DamageArea(instigator, position, radius, damage, damType, friendly); WaitSeconds(pulseTime) end
   ```
   Call with `pulseTime = DoTTime / DoTPulses`, `damage` = **full** amount **per pulse** (not divided!).

### 4d. Armor / DamageType / Handicap

`lua/shield.lua:100-108` documents the engine formula explicitly (comment: *"See SimDamage.cpp (DealDamage function) for how this should work"*):
```lua
amount = amount * self.Owner:GetArmorMult(type)
amount = amount * (1.0 - ArmyGetHandicap(self:GetArmy()))
```
→ **`effektiv = amount * ArmorMult(ArmorType, DamageType) * (1 - Handicap)`** — first armor, then handicap.

`lua/armordefinition.lua` (complete, 6 entries):
| ArmorType | Multiplikatoren |
|---|---|
| `Default` | `Normal 1.0` |
| `Normal` | `Normal 1.0` |
| `Light` | `Normal 1.0` |
| `Commander` | `Normal 1.0`, `Overcharge 0.033333`, `Deathnuke 0.05` |
| `Structure` | `Normal 1.0`, `Overcharge 0.066666`, `Deathnuke 0.01` |
| `Experimental` | `ExperimentalFootfall 0.0` |

Unlisted DamageTypes → Multiplier 1.0. Unit blueprint: `Defense.ArmorType`.
Engine API: `Unit:GetArmorMult(damageType)`, `Unit:AlterArmor(...)`.

Known DamageTypes in the game Lua: `Normal`, `Overcharge`, `Deathnuke`, `ExperimentalFootfall`, `Fire`, `Force`, `Reclaimed`, `TreeForce`, `TreeFire`, `Nuke`.

### 4e. Friendly Fire

Two **independent** flags:
- **`CollideFriendly`** (Weapon-BP, default `false`) — decides whether the projectile **collides** with allies/own (filters in `Unit:OnCollisionCheckWeapon`, `Shield:OnCollisionCheckWeapon`, `Projectile:OnCollisionCheck`)
- **`DamageFriendly`** (Weapon-BP, **Default `true`** if nil! weapon.lua:291-293) — decides whether `DamageArea`/`DamageRing` **damage** allies
- **`DamageSelf`** (Default `false`) — damages the Instigator itself
- `IgnoresAlly` (Weapon-BP, Default **1**) — Engine-Flag, an `PROJ_Create` durchgereicht

`Projectile:OnCollisionCheck` blocks collision hard with **same army** (line 97), regardless of CollideFriendly — the friendly collision path runs via `Unit:OnCollisionCheck` → `other:GetCollideFriendly()`.

### 4f. Overkill

`Unit:DoTakeDamage` (Unit.lua:794-818):
```lua
preAdjHealth = self:GetHealth()
self:AdjustHealth(instigator, -amount)
if self:GetHealth() <= 0 then
    if damageType == 'Reclaimed' then
        self:Destroy()                       -- kein Tod-Event, kein Wrack
    else
        excessDamageRatio = 0.0
        excess = preAdjHealth - amount        -- negativ bei Overkill
        if excess < 0 and maxHealth > 0 then
            excessDamageRatio = -excess / maxHealth
        end
        self:Kill(instigator, damageType, excessDamageRatio)
    end
end
```
→ **`overkillRatio = max(0, (amount - preAdjHealth) / maxHealth)`**

Projectiles have the same logic (`Projectile:DoTakeDamage`, Projectile.lua:143-166) with `Defense.MaxHealth` (default 10) — relevant for Anti-Missile/Flares.

---

## 5. Tod: OnKilled, Explosion, Wrack

### 5a. `Unit:OnKilled(instigator, type, overkillRatio)` (Unit.lua:896-943)

Sequence:
1. `self.Dead = true`
2. Sound: `HoverKilledOnWater` / `AmphibiousFloatingKilledOnLand` / `Killed`
3. Factory → unit under construction `Kill()`
4. `PlayDeathAnimation` → `ForkThread(PlayAnimationThread, 'AnimationDeath')` + `SetCollisionShape('None')`
5. `OnKilledVO()`, `DoUnitCallbacks('OnKilled')`, `DestroyTopSpeedEffects()`
6. `instigator:OnKilledUnit(self)` → there `CheckVeteranLevel()` (veteran count at **Killer**)
7. `DoDeathWeapon()` (if `DeathWeaponEnabled != false`)
8. `DisableShield()`, `DisableUnitIntel()`
9. `ForkThread(self.DeathThread, overkillRatio, instigator)`

**`DoDeathWeapon`** (Unit.lua:956-970): searches weapon with `Label == 'DeathWeapon'`:
- `FireOnDeath == true` → `SetWeaponEnabledByLabel('DeathWeapon', true)` + `:Fire()` (volle Waffen-Pipeline)
- otherwise → `ForkThread(DeathWeaponDamageThread, DamageRadius, Damage, DamageType, DamageFriendly)`:
  ```lua
  WaitSeconds(0.1)
  DamageArea(self, self:GetPosition(), damageRadius or 1, damage or 1, damageType or 'Normal', damageFriendly or false)
  ```

### 5b. `Unit:DeathThread(overkillRatio, instigator)` (Unit.lua:1200-1242)

```lua
WaitSeconds(GetRandomFloat(DestructionExplosionWaitDelayMin, DestructionExplosionWaitDelayMax))  -- 0 .. 0.5 (Defaults)
DestroyAllDamageEffects()
if PlayDestructionEffects then CreateDestructionEffects(self, overkillRatio) end   -- explosion.CreateScalableUnitExplosion
if DeathAnimManip then
    WaitFor(DeathAnimManip)
    if PlayDestructionEffects and PlayEndAnimDestructionEffects then CreateDestructionEffects(...) end
end
CreateWreckage(overkillRatio)                                    -- <<< WRACK
if ShowUnitDestructionDebris and overkillRatio then
    if     overkillRatio <= 1 then CreateUnitDestructionDebris(true, true, false)
    elseif overkillRatio <= 2 then CreateUnitDestructionDebris(true, true, false)
    elseif overkillRatio <= 3 then CreateUnitDestructionDebris(true, true, true)
    else                           CreateUnitDestructionDebris(true, true, true)   -- VAPORIZED
    end
end
WaitSeconds(DeathThreadDestructionWaitTime)                     -- Default 0
PlayUnitSound('Destroyed')
self:Destroy()
```
Class defaults (Unit.lua:64-72): `PlayDestructionEffects=true`, `PlayEndAnimDestructionEffects=true`, `ShowUnitDestructionDebris=true`, `DestructionExplosionWaitDelayMin=0`, `DestructionExplosionWaitDelayMax=0.5`, `DeathThreadDestructionWaitTime=0`.

### 5c. Explosion (`defaultexplosions.lua`)

```lua
scale = GetAverageBoundingXZRadius(unit) = (SizeX + SizeZ) * 0.5
volume = GetUnitVolume(unit)
BoundingXYZRadius = (SizeX + SizeY + SizeZ) * 0.333
```
`_CreateScalableUnitExplosion` (Zeile 125-184):
- `scale < 0.5` → `ExplosionEffectsSml01`
- `scale > 4`   → `ExplosionEffectsLrg01`, `ShakeTimeModifier = 1.0`, `ShakeMaxMul = 0.25`
- otherwise → `ExplosionEffectsMed01`
- Layer `Water` → additional environmental FX
- `CreateFlash(obj, -1, scale, army)` → `CreateLightParticle(..., GetRandomFloat(6,10) * scale, GetRandomFloat(10.5,14.5), 'glow_03', 'ramp_flare_02')`
- Layer `Land`: `scale > 1.2` → `CreateScorchMarkDecal` (size `scale*3`), otherwise `CreateScorchMarkSplat` (size `scale*4`); Lifetime `GetRandomFloat(300,600)`, LOD `GetRandomFloat(200,350)`
- `CreateDebrisProjectiles(obj, BoundingXYZRadius, Dimensions)`:
  `partamounts = GetRandomInt(1 + volume*5, volume*10)`, Projektile `/effects/entities/DebrisMisc04/...`
- **Camera Shake:** `obj:ShakeCamera(30 * scale, scale * ShakeMaxMul, 0, 0.5 + ShakeTimeModifier)`

### 5d. Wreck — exact values

`Unit:CreateWreckage(overkillRatio)` (Unit.lua:1076-1088):
```lua
if overkillRatio and overkillRatio > 1.0 then return end          -- VAPORISIERT: kein Wrack
if bp.Wreckage.WreckageLayers[self:GetCurrentLayer()] then self:CreateWreckageProp(overkillRatio) end
```

`Unit:CreateWreckageProp(overkillRatio)` (Unit.lua:1090-1146):
```lua
mass   = bp.Economy.BuildCostMass   * (bp.Wreckage.MassMult   or 0)
energy = bp.Economy.BuildCostEnergy * (bp.Wreckage.EnergyMult or 0)
time   = (bp.Wreckage.ReclaimTimeMultiplier or 1)

pos = self:GetPosition()
if layer == 'Seabed' or layer == 'Land' then pos.y = GetTerrainHeight(x,z) + GetTerrainTypeOffset(x,z)
else                                         pos.y = GetSurfaceHeight(x,z) + GetTerrainTypeOffset(x,z) end

prop = CreateProp(pos, bp.Wreckage.Blueprint)
prop:AddBoundedProp(mass)                       -- begrenzte Wrack-Anzahl (Perf)
prop:SetScale(bp.Display.UniformScale)
prop:SetOrientation(self:GetOrientation(), true)
prop:SetPropCollision('Box', CollisionOffsetX, CollisionOffsetY, CollisionOffsetZ,
                      SizeX*0.5, SizeY*0.5, SizeZ*0.5)
prop:SetMaxReclaimValues(time, time, mass, energy)

-- Overkill- und Bauzustands-Skalierung:
mass   = (mass   - (mass   * (overkillRatio or 1))) * self:GetFractionComplete()
energy = (energy - (energy * (overkillRatio or 1))) * self:GetFractionComplete()
time   =  time   - (time   * (overkillRatio or 1))

prop:SetReclaimValues(time, time, mass, energy)
prop:SetMaxHealth(bp.Defense.Health)
prop:SetHealth(self, bp.Defense.Health * (bp.Wreckage.HealthMult or 1))
if not bp.Wreckage.UseCustomMesh then prop:SetMesh(bp.Display.MeshBlueprintWrecked) end
TryCopyPose(self, prop, false)
prop.AssociatedBP = bp.BlueprintId
explosion.CreateWreckageEffects(self, prop)
```
→ **`reclaimMass = BuildCostMass * MassMult * (1 - overkillRatio) * fractionComplete`**
(Attention: `overkillRatio or 1` — with `nil` everything becomes 0! Only a *set* ratio < 1 leaves mass left.)

Beispiel UEL0201: `MassMult = 0.9`, `EnergyMult = 0`, `HealthMult = 0.9`, `ReclaimTimeMultiplier = 1`, Blueprint `/props/DefaultWreckage/DefaultWreckage_prop.bp`, `WreckageLayers = { Land = true, Air = false, ... }`.

`Wreckage:DoTakeDamage` (lua/wreckage.lua:21-41) — Wrack-Reclaim skaliert mit Rest-HP:
```lua
healthRatio = health / maxHealth
SetReclaimValues(MaxReclaimTimeMassMult * healthRatio, MaxReclaimTimeEnergyMult * healthRatio,
                 MaxMassReclaim * healthRatio, MaxEnergyReclaim * healthRatio)
if health <= 0 then self:Destroy() end
```
`Wreckage:OnCollisionCheck` → `false` for units (units drive through wrecks).

---

## 6. Schilde (`lua/shield.lua`)

Three classes: `Shield` (Bubble), `UnitShield` (Personal, Box Collision, Mesh Swap on Owner), `AntiArtilleryShield`.

### 6a. Spec / Defaults (from `Unit:CreateShield`, Unit.lua:3252-3279)

```lua
Size                          = bpShield.ShieldSize                    or 10
ShieldMaxHealth               = bpShield.ShieldMaxHealth               or 250
ShieldRechargeTime            = bpShield.ShieldRechargeTime            or 10
ShieldEnergyDrainRechargeTime = bpShield.ShieldEnergyDrainRechargeTime or 10
ShieldVerticalOffset          = bpShield.ShieldVerticalOffset          or -1
ShieldRegenRate               = bpShield.ShieldRegenRate               or 1
ShieldRegenStartTime          = bpShield.ShieldRegenStartTime          or 5
PassOverkillDamage            = bpShield.PassOverkillDamage            or false
```
(`CreatePersonalShield`: `PassOverkillDamage = bpShield.PassOverkillDamage != false` → **Default true**; Collision-Box = `SizeX/Y/Z * 0.75`)

### 6b. Absorption + Overspill

```lua
OnGetDamageAbsorption = function(self, instigator, amount, type)      -- shield.lua:100-108
    amount = amount * self.Owner:GetArmorMult(type)
    amount = amount * (1.0 - ArmyGetHandicap(self:GetArmy()))
    return math.min(self:GetHealth(), amount)
end

GetOverkill = function(self, instigator, amount, type)                -- shield.lua:132-144
    amount = amount * self.Owner:GetArmorMult(type)
    amount = amount * (1.0 - ArmyGetHandicap(self:GetArmy()))
    return math.max(0, amount - self:GetHealth())
end

OnDamage = function(self, instigator, amount, vector, type)           -- shield.lua:146-178
    local absorbed = self:OnGetDamageAbsorption(instigator, amount, type)
    if self.PassOverkillDamage then
        local overkill = self:GetOverkill(instigator, amount, type)
        if self.Owner and IsUnit(self.Owner) and overkill > 0 then
            self.Owner:DoTakeDamage(instigator, overkill, vector, type)   -- OVERSPILL an Owner
        end
    end
    self:AdjustHealth(instigator, -absorbed)
    self:UpdateShieldRatio(-1)
    if self.RegenThread then KillThread(self.RegenThread); self.RegenThread = nil end
    if self:GetHealth() <= 0 then
        ChangeState(self, self.DamageRechargeState)
    elseif self.OffHealth < 0 then
        ForkThread(self.CreateImpactEffect, self, vector)
        if self.RegenRate > 0 then
            self.RegenThread = ForkThread(self.RegenStartThread, self)
            self.Owner.Trash:Add(self.RegenThread)
        end
    end
end
```
Important: According to the comment, `OnGetDamageAbsorption` is called **by the engine** to calculate the spillover to units *under* the shield — the engine subtracts the return value from the damage it deals to the units below. `PassOverkillDamage` is the *additional* Lua path to the shield owner.

### 6c. Regeneration

```lua
RegenStartThread = function(self)              -- shield.lua:180-190
    WaitSeconds(self.RegenStartTime)
    while self:GetHealth() < self:GetMaxHealth() do
        self:AdjustHealth(self.Owner, self.RegenRate)   -- pro Sekunde
        self:UpdateShieldRatio(-1)
        WaitSeconds(1)
    end
end
```
→ `ShieldRegenRate` = HP **per second**, only starts `ShieldRegenStartTime` seconds after the **last** hit (each hit kills the thread and restarts it).

### 6d. Zustandsmaschine

- **`OnState`**: `CreateShieldMesh()` (Sphere Collision `Size/2`), `Owner:OnShieldEnabled()`; Infinite loop checks every tick `Owner:GetResourceConsumed()`; if `fraction != 1` **and** `EconomyStored('ENERGY') <= 0` two ticks in a row → `EnergyDrainRechargeState`. When switching on again after off: `ChargingUp(0, ShieldEnergyDrainRechargeTime)`.
- **`DamageRechargeState`** (HP shot to 0): `RemoveShield()` → `ChargingUp(0, ShieldRechargeTime)` → `SetHealth(MaxHealth)` (full HP!) → `OnState`
- **`EnergyDrainRechargeState`** (energy empty): `RemoveShield()` → `ChargingUp(0, ShieldEnergyDrainRechargeTime)` → `OnState` (or `OffState` if in transport)
- **`OffState`** (manually off): Kill rain thread, `OffHealth = GetHealth()`, `RemoveShield()`, `Owner:OnShieldDisabled()`
- **`ChargingUp(curProgress, time)`** — charging bar, progressing with actual energy consumption:
  ```lua
  while curProgress < time do
      curProgress = math.min(curProgress + (Owner:GetResourceConsumed() / 10), time)
      self:UpdateShieldRatio(curProgress / time)
      WaitTicks(1)
  end
  ```
  → at full energy (`GetResourceConsumed() == 1`) it takes exactly `time` seconds.

### 6e. Kollisionsfilter

```lua
Shield:OnCollisionCheck(other)                          -- shield.lua:223-239
    if other:GetArmy() == -1 then return false end
    if EntityCategoryContains(categories.STRATEGIC, other)
       and EntityCategoryContains(categories.MISSILE, other) then
        return false                                    -- Nukes durchdringen Schilde!
    end
    if other:GetBlueprint().Physics.CollideFriendlyShield then return true end
    return IsEnemy(self:GetArmy(), other:GetArmy())

Shield:OnCollisionCheckWeapon(firingWeapon)             -- shield.lua:112-130
    if weaponBP.CollideFriendly == false and not IsEnemy(...) then return false end
    DoNotCollideList-Check
    return true

AntiArtilleryShield:OnCollisionCheck(other)             -- shield.lua:519-533
    -- nur wenn other.DamageData.ArtilleryShieldBlocks == true UND Feind
AntiArtilleryShield:OnCollisionCheckWeapon(firingWeapon)
    -- nur wenn weaponBP.ArtilleryShieldBlocks == true
```

---

## 7. Concrete reference blueprints (for verification)

**UEL0201 (UEF T1 tank), Weapon `MainGun`** (`units.scd!units/UEL0201/UEL0201_unit.bp`):
```
Damage = 24, DamageRadius = 0, DamageType = 'Normal', CollideFriendly = false
RateOfFire = 1                        -> fireClock = 10 Ticks = 1.00 s
MaxRadius = 18, MinRadius = (default 1)
MuzzleVelocity = 25, ProjectileLifetimeUsesMultiplier = 1.15  -> Lifetime = 0.828 s
MuzzleSalvoSize = 1, MuzzleSalvoDelay = 0
RackBones = { { RackBone = 'Turret_Barrel', MuzzleBones = { 'Turret_Muzzle' } } }
RackRecoilDistance = -2, RackReloadTimeout = 10
RackSalvoChargeTime = 0, RackSalvoReloadTime = 0, RackSalvoSize = 1
Turreted = true, TurretYaw = 0, TurretYawRange = 180, TurretYawSpeed = 100
                 TurretPitch = 0, TurretPitchRange = 45, TurretPitchSpeed = 60
FiringTolerance = 2, TrackingRadius = 1.15, TargetCheckInterval = 0.5
BallisticArc = 'RULEUBA_LowArc', ProjectileId = '/projectiles/TDFGauss01/TDFGauss01_proj.bp'
FireTargetLayerCapsTable = { Land = 'Land|Water|Seabed', Water = 'Land|Water|Seabed' }
TargetRestrictDisallow = 'UNTARGETABLE', AboveWaterTargetsOnly = true
Defense.ArmorType = 'Normal'
Wreckage = { MassMult = 0.9, EnergyMult = 0, HealthMult = 0.9, ReclaimTimeMultiplier = 1 }
```
Derived: detection radius = 1.15 * 18 = 20.7; Yaw Slew = 100 * DEG2RAD * 0.1 = 0.1745 rad/tick (10°/tick); Tolerance = 2° ; Target recheck every ceil(0.5*10) = 5 ticks.

**TDFGauss01 (ballistisch)** (`projectiles.scd`):
```
Physics = { Acceleration = 0, DestroyOnWater = false, InitialSpeed = 12, MaxSpeed = 0,
            TurnRate = 360, VelocityAlign = true }     -- UseGravity fehlt -> Default TRUE
Categories = { 'UEF', 'PROJECTILE', 'DIRECTFIRE' }
```
(InitialSpeed ​​12 is overwritten by MuzzleVelocity 25.)

**AIFGuidedMissile01 (gelenkt)** (`projectiles.scd`):
```
Physics = { Acceleration = 5, DestroyOnWater = true, InitialSpeed = 15, LeadTarget = false,
            Lifetime = 10, MaxSpeed = 35, TrackTarget = true, TurnRate = 150,
            UseGravity = false, VelocityAlign = true }
Categories = { 'AEON', 'PROJECTILE', 'MISSILE' }
```

---

## 8. What exactly is needed for the replica - checklist

1. **Sim Tick = 10 Hz.** Keep all weapon times in ticks.
2. **`fireClock = floor(10 / RateOfFire)`** — not `1/RateOfFire` in seconds!
3. Engine calls **only `OnFire`**; the salvo FSM is Lua and runs in parallel with `WaitSeconds`/`WaitTicks`.
4. **`SetBusy` interlock** between FSM and `UnitWeapon::CanFire` (+ `NotExclusive` exception).
5. `MuzzleSalvoDelay == 0` → fire **all** MuzzleBones; `MuzzleSalvoSize` ignored.
6. Rack round robin via OnFire cycles; `RackFireTogether` as an exception.
7. Turret: `TurretYaw`/`TurretPitch` = **Mitte**, `*Range` = **Halbspanne**; Slew = `deg/s * DEG2RAD * 0.1` rad/Tick.
8. `FiringTolerance` in **degrees**, per axis; `YawOnlyOnTarget` skips pitch.
9. Reichweite: **2D-XZ** + `MaxHeightDiff` + `HeadingArcRange`.
10. `TrackingRadius` is **Multiplier** of MaxRadius.
11. `UseGravity` **Default true**; Gravitation `(0, -4.9, 0)`; Ballistik-Winkel via `CalculateFiringPitch` (High/Low je `BallisticArc`).
12. `MuzzleVelocity` overrides `InitialSpeed`; Gaussian jitter + `sqrt(d/reduceDist)` attenuation.
13. `ProjectileLifetimeUsesMultiplier` → `(MaxRadius / MuzzleVelocity) * mult`.
14. **Damage: NO range falloff.** Full `Amount` on everything in the radius/ring. Falloff only through staggered rings / ScalableRadiusAreaDoT in Lua.
15. `effektiv = amount * ArmorMult(ArmorType, DamageType) * (1 - Handicap)`.
16. `DamageFriendly` Default **true**, `CollideFriendly` Default **false** — zwei getrennte Konzepte.
17. `overkillRatio = max(0, (amount - preAdjHealth) / maxHealth)`; `> 1.0` → no wreck.
18. Wrack-Reclaim = `BuildCostMass * MassMult * (1 - overkillRatio) * fractionComplete`.
19. Shield: Absorption `min(hp, amount*mult)`, overspill only with `PassOverkillDamage`; Rain starts `RegenStartTime` after **last** hit; after breakthrough **full** HP after `ShieldRechargeTime`.
20. STRATEGIC+MISSILE (Nukes) generally penetrate shields.

**Known gap:** The exact entity selection in `SIM_Damage` (which collision volumes are considered "in the radius" — center point vs. box/sphere intersection) cannot be reconstructed. Sphere vs collision volume overlap is recommended for replication (consistent with `PointInShape` usage in `CDamage.cpp:160-171` and the `SetPropCollision`/`SetCollisionShape` model: `COLSHAPE_Box` / `COLSHAPE_Sphere`).

## Refs
- mohodata.scd!lua/sim/defaultweapons.lua:30-88 — DefaultProjectileWeapon.OnCreate: Validierung, NumMuzzles, RackRecoilReturnSpeed-Formel
- mohodata.scd!lua/sim/defaultweapons.lua:383-445 — IdleState (RackReloadTimeout, OnGotTarget/OnFire-Verzweigung)
- mohodata.scd!lua/sim/defaultweapons.lua:447-508 — RackSalvoChargeState + RackSalvoFireReadyState (EconDrain-Gate)
- mohodata.scd!lua/sim/defaultweapons.lua:510-658 — RackSalvoFiringState.Main: the complete salvo loop (MuzzleSalvoSize/Delay, Rack-Wrap, CountedProjectile, HaltFire)
- mohodata.scd!lua/sim/defaultweapons.lua:660-690 — RackSalvoReloadState
- mohodata.scd!lua/sim/defaultweapons.lua:692-751 — WeaponUnpackingState / WeaponPackingState
- mohodata.scd!lua/sim/defaultweapons.lua:763-782 — KamikazeWeapon, BareBonesWeapon
- mohodata.scd!lua/sim/defaultweapons.lua:785-995 — DefaultBeamWeapon (BeamCollisionDelay*10, BeamLifetime, EconomySupportsBeam)
- mohodata.scd!lua/sim/weapon.lua:53-150 — SetupTurret: TurretYaw/Pitch Min-Max, SetFiringArc, RackSlavedToTurret
- mohodata.scd!lua/sim/weapon.lua:284-345 — GetDamageTable + CreateProjectileForWeapon (Nuke-Ring-Defaults)
- mohodata.scd!lua/sim/weapon.lua:347-359 — SetValidTargetsForCurrentLayer / FireTargetLayerCapsTable
- mohodata.scd!lua/sim/weapon.lua:364-385 — SetWeaponPriorities / SetTargetingPriorities
- mohodata.scd!lua/sim/DefaultDamage.lua:11-27 — UnitDoTThread, AreaDoTThread
- mohodata.scd!lua/sim/DefaultDamage.lua:34-55 — ScalableRadiusAreaDoT (reductionScalar-Formel)
- mohodata.scd!lua/sim/CollisionBeam.lua:67-96 — CollisionBeam.DoDamage (DamageModifiers, 0.25-Fallback-Radius)
- mohodata.scd!lua/sim/CollisionBeam.lua:186-251 — CollisionBeam.OnImpact (Impact-Typen)
- lua.scd!lua/sim/Projectile.lua:89-126 — OnCollisionCheck (TORPEDO/MISSILE/DIRECTFIRE-Matrix, DoNotCollideList)
- lua.scd!lua/sim/Projectile.lua:143-166 — DoTakeDamage (Projektil-Overkill)
- lua.scd!lua/sim/Projectile.lua:173-192 — DoDamage (DamageArea vs Damage, DoT-Verzweigung)
- lua.scd!lua/sim/Projectile.lua:259-356 — OnImpact (targetType-Liste, Effekt-Auswahl, ImpactTimeout)
- lua.scd!lua/sim/Projectile.lua:415-427 — PassDamageData (DamageData fields)
- lua.scd!lua/sim/Projectile.lua:453-462 — OnLostTarget (OnLostTargetLifetime, Default 0.5)
- lua.scd!lua/sim/Unit.lua:64-72 — Destruction defaults (DestructionExplosionWaitDelayMin/Max, DeathThreadDestructionWaitTime)
- lua.scd!lua/sim/Unit.lua:794-818 — DoTakeDamage + excessDamageRatio (overkill formula)
- lua.scd!lua/sim/Unit.lua:896-943 — OnKilled (full order)
- lua.scd!lua/sim/Unit.lua:956-970 — DoDeathWeapon (FireOnDeath vs DeathWeaponDamageThread)
- lua.scd!lua/sim/Unit.lua:972-1029 — OnCollisionCheck / OnCollisionCheckWeapon (CollideFriendly, DoNotCollideList)
- lua.scd!lua/sim/Unit.lua:1076-1146 — CreateWreckage / CreateWreckageProp (all wreck formulas)
- lua.scd!lua/sim/Unit.lua:1195-1198 — DeathWeaponDamageThread (WaitSeconds 0.1 + DamageArea)
- lua.scd!lua/sim/Unit.lua:1200-1242 — DeathThread (explosion, wreck, debris after overkillRatio)
- lua.scd!lua/sim/Unit.lua:3252-3341 — CreateShield / CreatePersonalShield / CreateAntiArtilleryShield (all shield defaults)
- lua.scd!lua/shield.lua:100-108 — OnGetDamageAbsorption (Armor*Handicap formula, reference to SimDamage.cpp DealDamage)
- lua.scd!lua/shield.lua:132-144 — GetOverkill
- lua.scd!lua/shield.lua:146-190 — OnDamage + RegenStartThread (Overspill, Regen-Neustart)
- lua.scd!lua/shield.lua:223-239 — OnCollisionCheck (Nuke-Durchdringung)
- lua.scd!lua/shield.lua:286-412 — ChargingUp + OnState/OffState/DamageRechargeState/EnergyDrainRechargeState
- lua.scd!lua/shield.lua:496-534 — AntiArtilleryShield (ArtilleryShieldBlocks)
- lua.scd!lua/armordefinition.lua:14-59 — full Armor/DamageType multiplier table
- lua.scd!lua/wreckage.lua:21-49 — Wreckage.DoTakeDamage (Reclaim skaliert mit HP), OnCollisionCheck
- lua.scd!lua/defaultexplosions.lua:40-48 — GetAverageBoundingXZRadius / XYZRadius
- lua.scd!lua/defaultexplosions.lua:125-184 — _CreateScalableUnitExplosion (Scale-Schwellen, ShakeCamera, Scorch)
- lua.scd!lua/defaultexplosions.lua:277-287 — CreateDebrisProjectiles (partamounts-Formel)
- lua.scd!lua/defaultexplosions.lua:249-272 — CreateWreckageEffects
- faf-re/src/sdk/moho/unit/tasks/CFireWeaponTask.cpp:228-268 — Execute(): THE fire rate, fireClock = (int)(10.0f/RateOfFire)
- faf-re/src/sdk/moho/unit/tasks/CFireWeaponTask.cpp:151-159 — FireWeapon(): RunScript("OnFire") + ++mShotsAtTarget
- faf-re/src/sdk/moho/unit/core/CWeaponAttributes.h:24-38 — CWeaponAttributes layout (Lua overrides, <0 = blueprint fallback)
- faf-re/src/sdk/moho/unit/core/UnitWeapon.h:58-64 — ESolutionStatus (Available/InsideMinRange/NoSolution/OutsideMaxRange)
- faf-re/src/sdk/moho/unit/core/UnitWeapon.h:331-358 — UnitWeapon layout (mCanFire, mFiringRandomness, mTargetPriorities, mAimingAt)
- faf-re/src/sdk/moho/unit/core/UnitWeapon.cpp:496-560 — EvaluateTargetSolutionStatusGun: 2D XZ range, MaxHeightDiff, HeadingArc
- faf-re/src/sdk/moho/unit/core/UnitWeapon.cpp:3172-3284 — UnitWeapon::CanFire (Stun/Busy/Layer/AboveWater/BombDrop-Gates)
- faf-re/src/sdk/moho/unit/core/UnitWeapon.cpp:3346-3357 — CheckSilo (CountedProjectile)
- faf-re/src/sdk/moho/unit/core/UnitWeapon.cpp:3366-3409 — CanAttackTarget (FireTargetLayerCaps, CannotAttackGround)
- faf-re/src/sdk/moho/unit/core/UnitWeapon.cpp:3666-3759 — CreateProjectile: FiringRandomness jitter, MuzzleVelocity override, ProjectileLifetimeUsesMultiplier
- faf-re/src/sdk/moho/ai/CAimManipulator.cpp:523-582 — PredictInterceptPointConstantSpeed (Lead-Polynom 0.00761/0.16605)
- faf-re/src/sdk/moho/ai/CAimManipulator.cpp:591-638 — PredictInterceptPointFromForwardVelocity (10 Iterationen)
- faf-re/src/sdk/moho/ai/CAimManipulator.cpp:647-677 — CalculateFiringPitch (High/Low-Arc-Formel)
- faf-re/src/sdk/moho/ai/CAimManipulator.cpp:686-707 — CalculateFiringDirection
- faf-re/src/sdk/moho/ai/CAimManipulator.cpp:835-932 — AimManip: mOnTarget -> weapon->mCanFire + EventSetSignaled; TargetCheckInterval*10
- faf-re/src/sdk/moho/ai/CAimManipulator.cpp:941-1106 — Aim(): MuzzleVelocityReduceDistance, LeadTarget, BallisticArc-Auswahl
- faf-re/src/sdk/moho/ai/CAimManipulator.cpp:1180-1229 — SetFiringArc: Grad->Radiant, kSlewScale = 0.1 (rad/Tick)
- faf-re/src/sdk/moho/ai/CAimManipulator.cpp:1239-1327 — CheckTracking: Arc-Klemmung, Slew-Klemmung, FiringTolerance-Pruefung, YawOnlyOnTarget
- faf-re/src/sdk/moho/ai/CAimManipulator.cpp:1386-1472 — Track(): onTarget aggregation via heading+pitch
- faf-re/src/sdk/moho/ai/CAiAttackerImpl.cpp:459-473 — TargetCheckInterval -> ceil(interval*10) Frames, NeedPrep=2
- faf-re/src/sdk/moho/ai/CAiAttackerImpl.cpp:1143-1170 — Target prioritization (mTargetPriorities iteration, RECON_LOSEver preference)
- faf-re/src/sdk/moho/ai/CAiAttackerImpl.cpp:1256-1274 — Erfassungsreichweite = TrackingRadius * MaxRadius
- faf-re/src/sdk/moho/sim/CDamage.h:17-22 — CDamageMethod (SINGLE_TARGET / AREA_EFFECT / RING_EFFECT)
- faf-re/src/sdk/moho/sim/CDamage.h:75-103 — CDamage layout: NO falloff field (proof of 'no distance falloff')
- faf-re/src/sdk/moho/sim/CDamage.cpp:466-477 — CDamageTypeInfo::AddFields (reflected fields, confirmed payload)
- faf-re/src/sdk/moho/sim/CDamageLuaFunctionRegistrations.cpp:159-215 — cfunc_DamageL: Damage(instigator, origin, target, amount, type)
- faf-re/src/sdk/moho/sim/CDamageLuaFunctionRegistrations.cpp:265-332 — cfunc_DamageAreaL: DamageArea(..., damageFriendly, [damageSelf])
- faf-re/src/sdk/moho/sim/CDamageLuaFunctionRegistrations.cpp:382-461 — cfunc_DamageRingL: DamageRing(..., minR, maxR, ...), erzwingt minR < maxR
- faf-re/src/sdk/moho/EngineUnrecoveredStubs.cpp:61 — SIM_Damage is an EMPTY STUB (falloff math not reconstructed)
- faf-re/src/sdk/moho/sim/SPhysConstants.h:13 — Gravitation = (0.0f, -4.9f, 0.0f)
- faf-re/src/sdk/moho/resource/blueprints/RUnitBlueprint.h:531-647 — RUnitBlueprintWeapon: complete weapon blueprint schema
- faf-re/src/sdk/moho/resource/blueprints/RUnitBlueprint.cpp:1015-1086 — RUnitBlueprintWeapon defaults (FiringTolerance 0.01, MaxHeightDiff inf, RateOfFire 1.0, TrackingRadius 1.0, HeadingArcRange 180, IgnoresAlly 1, LeadTarget 1, TargetCheckInterval 3.0)
- faf-re/src/sdk/moho/resource/blueprints/RUnitBlueprint.cpp:1125-1138 — GetMuzzleVelocity (Gauss jitter + sqrt short-range attenuation)
- faf-re/src/sdk/moho/resource/blueprints/RProjectileBlueprint.h:52-92 — RProjectileBlueprintPhysics: complete projectile schematic
- faf-re/src/sdk/moho/resource/blueprints/RProjectileBlueprint.cpp:98-143 — Projectile defaults (UseGravity=1, Lifetime=15, CollideSurface/Entity=1, VelocityAlign=1, LeadTarget=1)
- faf-re/src/sdk/moho/projectile/Projectile.cpp:48-80 — Projectile-Runtime (mBallisticAcceleration, mTurnRateDegrees, mMaxSpeed, mLifetimeEnd)
- faf-re/src/sdk/moho/projectile/ProjectileLuaFunctionThunks.cpp:14-43 — vollstaendige Projektil-Lua-API (SetBallisticAcceleration, SetTurnRate, TrackTarget, ...)
- faf-re/src/sdk/moho/collision/ECollisionShape.h:9-14 — COLSHAPE_None / Box / Sphere
- units.scd!units/UEL0201/UEL0201_unit.bp — Reference weapon blueprint (MainGun) + wreckage values
- projectiles.scd!projectiles/TDFGauss01/TDFGauss01_proj.bp — Referenz ballistisches Projektil
- projectiles.scd!projectiles/AIFGuidedMissile01/AIFGuidedMissile01_proj.bp — Referenz gelenktes Projektil (TrackTarget/TurnRate/MaxSpeed/Acceleration)
