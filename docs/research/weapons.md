# agent7

## Summary
Waffen/Schaden in SupCom:FA sind zweigeteilt: die **Engine** (C++, faf-re) betreibt Zielerfassung, Zielverfolgung (Aim-Manipulator), den Feuertakt (`CFireWeaponTask`, Tick-quantisiert) und die Schadensausbringung; die **Lua-Schicht** (mohodata.scd: `lua/sim/weapon.lua`, `lua/sim/defaultweapons.lua`) implementiert nur die *Salven-Zustandsmaschine* (Racks/Muzzles/Reload/Charge/Unpack) und wird von der Engine über `OnFire` getaktet. Zentrale Erkenntnisse: RateOfFire wird als `fireClock = (int)(10 / RateOfFire)` **Ticks** quantisiert (10 Hz Sim), TrackingRadius ist ein **Multiplikator** von MaxRadius, `UseGravity` ist per Default **true**, Gravitation ist `(0, -4.9, 0)`. Kritisch für den Nachbau: **`SIM_Damage` ist im Decomp NICHT rekonstruiert** (Stub) — aber die `CDamage`-Payload besitzt *kein* Falloff-Feld, was strukturell belegt, dass die Engine den vollen `Amount` auf jede vom Method-Lane selektierte Entity anwendet (kein Distanz-Falloff); Distanzabhängigkeit wird in FA in Lua durch gestaffelte Ringe (Nuke) bzw. `ScalableRadiusAreaDoT` nachgebaut.

## Key Facts
- Die Kern-Waffen-Lua liegt NICHT in lua.scd, sondern in mohodata.scd: lua/sim/weapon.lua, lua/sim/defaultweapons.lua, lua/sim/DefaultDamage.lua, lua/sim/CollisionBeam.lua, lua/sim/DefaultProjectiles.lua; lua.scd ueberschreibt nur lua/sim/Projectile.lua (17 KB) gegenueber dem mohodata-Stub (618 B).
- Feuertakt ist Engine-seitig und Tick-quantisiert: CFireWeaponTask::Execute() dekrementiert pro Tick, feuert bei fireClock==0 und setzt fireClock = (int)(10.0f / RateOfFire) — Ganzzahl-Trunkierung, d.h. RateOfFire=3 ergibt 3 Ticks = 0.30 s (effektiv 3.33/s), nicht 0.333 s.
- Die Engine ruft nur weapon:OnFire() im Lua auf; die gesamte Salven-Logik (RackBones/MuzzleBones, MuzzleSalvoSize/Delay, RackSalvoChargeTime/ReloadTime, Charge/Pack/Unpack) ist die Zustandsmaschine in DefaultProjectileWeapon (IdleState -> RackSalvoCharge -> RackSalvoFireReady -> RackSalvoFiring -> RackSalvoReload).
- Reichweitenpruefung ist rein 2D (XZ-Ebene, quadrierte Distanz gegen MaxRadiusSq/MinRadiusSq) plus separater |dY| <= MaxHeightDiff Check plus HeadingArcRange — EvaluateTargetSolutionStatusGun liefert TRS_Available / InsideMinRange / OutsideMaxRange / NoSolution.
- TrackingRadius ist ein MULTIPLIKATOR: Zielerfassungsreichweite = TrackingRadius * MaxRadius (CAiAttackerImpl.cpp:1266); TargetCheckInterval wird zu Ticks: frames = max(1, ceil(interval * 10)).
- FiringTolerance ist in Grad und wird pro Achse geprueft: |normalize(nextAngle - desiredAngle)| > FiringTolerance*DEG2RAD setzt 'ausserhalb Toleranz'; onTarget = keine Achse ausserhalb -> setzt weapon->mCanFire und signalisiert das Task-Event.
- TurretYawSpeed/TurretPitchSpeed sind Grad/Sekunde und werden zu Radiant/Tick: slew = speed * DEG2RAD * 0.1 (kSlewScale); die Winkelschritte werden pro Tick auf diesen Slew geklemmt.
- Weapon-MuzzleVelocity ueberschreibt die Projektil-InitialSpeed: velocity = normalize(launchDir) * GetMuzzleVelocity(dist, rng), mit Gauss-Jitter (MuzzleVelocityRandom) und Nahbereichs-Daempfung sqrt(dist/MuzzleVelocityReduceDistance).
- Projektil-Lebensdauer: ProjectileLifetime setzt absolut; ProjectileLifetimeUsesMultiplier setzt lifetime = (MaxRadius / MuzzleVelocity) * Multiplier (ueberschreibt).
- Projektil-Physics-Defaults (RProjectileBlueprint.cpp:98): UseGravity=1, CollideSurface=1, CollideEntity=1, VelocityAlign=1, LeadTarget=1, TrackTarget=0, Lifetime=15.0, InitialSpeed=1.0, TurnRate=0, MaxSpeed=0, Acceleration=0.
- Gravitation ist SPhysConstants = (0, -4.9, 0) Einheiten/s^2; ballistischer Winkel via CalculateFiringPitch (High-/LowArc nach BallisticArc), gelenkte Projektile nutzen TrackTarget + TurnRate (Grad/s) + MaxSpeed + Acceleration.
- SIM_Damage ist im Decomp ein leerer Stub (EngineUnrecoveredStubs.cpp:61) — die Schadensausbringung selbst ist NICHT rekonstruiert.
- Die CDamage-Payload (CDamage.h) hat KEIN Falloff-/Kurven-Feld: nur Method (SINGLE_TARGET/AREA_EFFECT/RING_EFFECT), MinMaxRadius, Origin, Amount, Type, DamageFriendly, DamageNeutral, DamageSelf, Vector — strukturell gibt es also nichts zu interpolieren: voller Amount auf jede selektierte Entity, kein Distanz-Falloff.
- Schadensformel (aus dem Kommentar in lua/shield.lua, der explizit auf SimDamage.cpp DealDamage verweist): effektiv = amount * GetArmorMult(damageType) * (1.0 - ArmyGetHandicap(army)) — erst Ruestung, dann Handicap.
- Armor-Multiplikatoren (lua/armordefinition.lua): Default/Normal/Light = Normal 1.0; Commander = Overcharge 0.033333, Deathnuke 0.05; Structure = Overcharge 0.066666, Deathnuke 0.01; Experimental = ExperimentalFootfall 0.0.
- Drei Lua-Schadens-Globals mit exakten Signaturen: Damage(instigator, origin, target, amount, type) [5 Args], DamageArea(instigator, origin, radius, amount, type, damageFriendly, [damageSelf]) [6-7], DamageRing(instigator, origin, minR, maxR, amount, type, damageFriendly, [damageSelf]) [7-8; minR < maxR erzwungen].
- Overkill: excessDamageRatio = -(preAdjHealth - amount) / maxHealth (nur wenn negativ); overkillRatio > 1.0 -> KEIN Wrack (vaporisiert).
- Wrack-Werte: mass = BuildCostMass * Wreckage.MassMult, energy = BuildCostEnergy * Wreckage.EnergyMult, dann skaliert mit (1 - overkillRatio) * GetFractionComplete(); Wrack-HP = Defense.Health * Wreckage.HealthMult.
- Schild-Absorption: OnGetDamageAbsorption gibt min(shieldHealth, amount * ArmorMult * (1-Handicap)) zurueck; PassOverkillDamage leitet den Ueberschuss (amount*mult - shieldHealth, min 0) direkt an den Owner via DoTakeDamage weiter (Overspill).
- Schild-Regeneration: RegenStartThread wartet ShieldRegenStartTime und addiert dann jede Sekunde ShieldRegenRate; jeder Treffer killt den Regen-Thread und startet ihn neu. Bei HP<=0 -> DamageRechargeState: Schild weg, ChargingUp(ShieldRechargeTime), dann volle HP.
- Beam-Waffen (DefaultBeamWeapon) erzeugen keine Projektile: pro MuzzleBone ein CollisionBeam mit CollisionCheckInterval = BeamCollisionDelay * 10 (Ticks); BeamLifetime > 0 = gepulst, BeamLifetime == 0 = Dauerstrahl (Hold-Fire-Watchdog). CollisionBeam.DoDamage ohne Radius und ohne targetEntity macht DamageArea mit Radius 0.25.

## Details
## 0. Quellenlage / Architektur

**Zwei Ebenen, sauber getrennt:**

| Ebene | Ort | Verantwortung |
|---|---|---|
| Engine (C++) | `faf-re/src/sdk/moho/` | Zielerfassung, Aim/Turret, Feuertakt (`fireClock`), Projektil-Spawn+Physik, Kollision, Schadensausbringung, Armor/Handicap |
| Lua Sim | `mohodata.scd` + `lua.scd` | Salven-Zustandsmaschine, Effekte, DoT, Nuke-Ringe, Schilde, Tod/Wrack |

**Wichtig: Die Kern-Waffen-Lua liegt in `mohodata.scd`, NICHT in `lua.scd`:**
- `mohodata.scd!lua/sim/weapon.lua` (19.9 KB) — Basisklasse `Weapon`
- `mohodata.scd!lua/sim/defaultweapons.lua` (38.6 KB) — `DefaultProjectileWeapon` (RackSalvo-FSM), `DefaultBeamWeapon`, `KamikazeWeapon`, `BareBonesWeapon`
- `mohodata.scd!lua/sim/DefaultDamage.lua` (2.0 KB) — `UnitDoTThread`, `AreaDoTThread`, `ScalableRadiusAreaDoT`
- `mohodata.scd!lua/sim/CollisionBeam.lua` (11.2 KB)
- `mohodata.scd!lua/sim/DefaultProjectiles.lua` (7.5 KB)
- `lua.scd!lua/sim/Projectile.lua` (17.4 KB) — **überschreibt** den 618-Byte-Stub in mohodata
- `lua.scd!lua/shield.lua`, `lua.scd!lua/wreckage.lua`, `lua.scd!lua/armordefinition.lua`, `lua.scd!lua/defaultexplosions.lua`, `lua.scd!lua/sim/Unit.lua`

Ladereihenfolge: lua.scd gewinnt gegen mohodata.scd bei gleichem Pfad.

---

## 1. Feuerzyklus

### 1a. Engine-Takt (autoritativ) — `CFireWeaponTask::Execute()`

Läuft **jeden Sim-Tick (10 Hz)**:

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
- Einheit: **Schuss pro Sekunde**
- Nachladezeit in Ticks: `N = floor(10 / RateOfFire)` — **Ganzzahl-Trunkierung**
- Periode = genau `N` Ticks (Feuern bei Tick T, wieder bei T+N)

| RateOfFire | N (Ticks) | reale Periode | effektive RoF |
|---|---|---|---|
| 1.0 | 10 | 1.000 s | 1.00/s |
| 2.0 | 5 | 0.500 s | 2.00/s |
| **3.0** | **3** | **0.300 s** | **3.33/s** (!) |
| **1.5** | **6** | **0.600 s** | **1.67/s** (!) |
| 0.5 | 20 | 2.000 s | 0.50/s |

Diese Quantisierung ist im Nachbau **zwingend** nachzubilden, sonst weichen alle DPS-Werte ab.

**Lua-Overrides:** `weapon:ChangeRateOfFire(v)` schreibt `CWeaponAttributes::mRateOfFire`. Ist der Wert `< 0`, gilt der Blueprint-Wert (Sentinel-Muster; gilt analog für MinRadius/MaxRadius/MaxHeightDiff/Damage/DamageRadius/FiringTolerance).

### 1b. Lua-Zustandsmaschine — `DefaultProjectileWeapon` (defaultweapons.lua)

Die Engine ruft nur `OnFire`. Alles Weitere ist FSM:

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

Zusätzliche Zweige: `WeaponUnpackingState` / `WeaponPackingState` (bei `WeaponUnpacks == true`), `DeadState`.

**`RackSalvoFiringState.Main` — der Kern (defaultweapons.lua:526-644):**

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

**Semantik der Salven-Parameter:**
- `MuzzleSalvoDelay == 0` → **alle** MuzzleBones des Racks feuern in einem Tick gleichzeitig (`MuzzleSalvoSize` wird ignoriert!)
- `MuzzleSalvoDelay > 0` → genau `MuzzleSalvoSize` Schüsse, mit `MuzzleSalvoDelay` Sekunden Pause dazwischen; `muzzleIndex` läuft zyklisch über die MuzzleBones (Wrap-Around, d.h. MuzzleSalvoSize kann > Anzahl Bones sein)
- `RackFireTogether == true` → die while-Schleife läuft über **alle** Racks in einem Durchgang
- sonst: pro `OnFire` feuert **genau ein Rack**, `CurrentRackSalvoNumber` wandert weiter (Rack-Round-Robin über mehrere OnFire-Zyklen)
- Rack-Reset: wenn `CurrentRackSalvoNumber > #RackBones` → zurück auf 1, dann `RackSalvoReloadTime` (falls > 0)
- `IdleState`: bei >1 Rack und `CurrentRackSalvoNumber > 1` wird `RackReloadTimeout` abgewartet, dann Reset auf Rack 1

**Validierungs-Constraints aus `OnCreate` (defaultweapons.lua:30-88) — im Nachbau übernehmen:**
- `(NumMuzzles - 1) * MuzzleSalvoDelay` muss `<= 1/RateOfFire` sein (sonst Fehler)
- `RackRecoilDistance != 0` **und** `MuzzleSalvoDelay != 0` ist verboten
- Recoil-Rückstellgeschwindigkeit (wenn nicht gesetzt):
  `RackRecoilReturnSpeed = |dist / ((1/RateOfFire) - MuzzleChargeDelay)| * 1.25`

**Interlock:** `RackSalvoFiringState` setzt `unit:SetBusy(true)`. `UnitWeapon::CanFire()` (Engine) prüft `IsUnitState(UNITSTATE_Busy)` → Waffe gilt als nicht feuerbereit, solange die Salve läuft. `NotExclusive = true` hebt das während der Waits auf. Ein `OnFire` während `RackSalvoFiringState` hat keinen Handler → fällt auf `Weapon.OnFire` zurück (nur Sound, kein Schuss).

**Energie:** `StartEconomyDrain` erzeugt `CreateEconomyEvent(unit, EnergyRequired, 0, max(0.1, EnergyRequired/EnergyDrainPerSecond))`. `RackSalvoFireReadyState` blockiert (`WeaponCanFire = false`) bis das Event fertig ist.

---

## 2. Aiming

### 2a. Turret-Setup (weapon.lua:53-150)

```lua
AimControl = CreateAimController(self, 'Default', TurretBoneYaw, TurretBonePitch, TurretBoneMuzzle)
AimControl:SetPrecedence(AimControlPrecedence or 10)
if STRUCTURE then AimControl:SetResetPoseTime(9999999) end   -- Türme bleiben stehen

turretyawmin,   turretyawmax   = TurretYaw   - TurretYawRange,   TurretYaw   + TurretYawRange
turretpitchmin, turretpitchmax = TurretPitch - TurretPitchRange, TurretPitch + TurretPitchRange
AimControl:SetFiringArc(yawmin, yawmax, TurretYawSpeed, pitchmin, pitchmax, TurretPitchSpeed)
```
- **`TurretYaw`/`TurretPitch` sind Mittelpunkte**, `*Range` ist die **Halbspanne** (nicht die Gesamtspanne!)
- `TurretDualManipulators` → 3 Manipulatoren (Torso/Right/Left); Left/Right bekommen `yawmin/12, yawmax/12`
- `RackSlavedToTurret` → `CreateSlaver(unit, RackBone, pitchBone)` mit `Precedence - 1`

### 2b. Slew-Umrechnung (CAimManipulator.cpp:1197-1206)

```cpp
// Lua-Grad -> Engine-Radiant/Tick
radiansArc.mHeadingMaxSlew = luaValue * DEG2RAD;          // 0.017453292
runtimeArc.mHeadingMaxSlew = radiansArc.mHeadingMaxSlew * 0.1f;   // kSlewScale
```
→ **`slewPerTick = TurretYawSpeed [deg/s] * DEG2RAD * 0.1`**. TurretYawSpeed ist also Grad **pro Sekunde**.

`SetFiringArc` speichert zentriert:
- `mMinHeading = NormalizeCenteredAngle(min, max)` (= Arc-Mitte)
- `mMaxHeading = |max - min| * 0.5` (= Halbspanne)

### 2c. Tracking-Schritt pro Tick (`CheckTracking`, CAimManipulator.cpp:1239-1327)

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

`Track()` (CAimManipulator.cpp:1386): `onTarget = !(result & OUTSIDE_TOLERANCE)` über beide Achsen. Dann:
```cpp
weapon->mCanFire = onTarget ? 1 : 0;    // nur wenn Label matcht (SetFireControl)
taskEvent->EventSetSignaled(onTarget);  // gibt CFireWeaponTask frei
```
`YawOnlyOnTarget = true` → Pitch wird bei der Toleranzprüfung übersprungen (Waffe feuert, sobald Yaw stimmt).

### 2d. Ziel-Vorhalt & ballistische Lösung (`Aim`, CAimManipulator.cpp:941-1106)

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

### 2e. Reichweite & Ziel-Lösung (`EvaluateTargetSolutionStatusGun`, UnitWeapon.cpp:496-560)

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
Nur `TRS_Available` erlaubt Feuern (CFireWeaponTask prüft `TargetIsTooClose(...) != TRS_Available`).

### 2f. Zielerfassung / Priorisierung

- **Erfassungsradius = `TrackingRadius * MaxRadius`** (CAiAttackerImpl.cpp:1256-1270) — TrackingRadius ist ein **Multiplikator**, kein absoluter Wert (z.B. UEL0201: 1.15 → 18 * 1.15 = 20.7)
- **Prüfintervall:** `frames = max(1, ceil(TargetCheckInterval * 10))` Ticks (CAiAttackerImpl.cpp:468-472); `NeedPrep` → fix 2 Frames
- **Prioritäten:** `TargetPriorities` (Liste von Kategorie-Strings) → `weapon:SetTargetingPriorities(parsedCategories)`. Die Engine iteriert die Liste **von Index 0 aufwärts** (0 = höchste Priorität) und bricht ab, sobald ein besserer Kandidat gefunden ist; bereits gesehene Ziele (`RECON_LOSEver`) werden bevorzugt (CAiAttackerImpl.cpp:1147-1170)
- **Filter:** `TargetRestrictOnlyAllow` / `TargetRestrictDisallow` (Kategorien) → `mCat1`/`mCat2`; `FireTargetLayerCapsTable[layer]` → `SetFireTargetLayerCaps` (Land/Water/Seabed/Air-Maske, wird bei Layer-Wechsel neu gesetzt, weapon.lua:347-359)
- Weitere Gates in `UnitWeapon::CanFire` (UnitWeapon.cpp:3172): Stun, `UNITSTATE_Busy`, Flieger nicht im Air-Layer, `NeedUnpack` ohne Immobile, `AboveWaterFireOnly`/`BelowWaterFireOnly` (Mündungshöhe vs. Wasserpegel), Bombenabwurf-Timing (`NeedToComputeBombDrop`, `BombDropThreshold`)

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

Felder (mit Defaults aus RProjectileBlueprint.cpp:98-143):

| Feld | Default | Bedeutung |
|---|---|---|
| `CollideSurface` | **1** | Kollidiert mit Terrain/Wasser |
| `CollideEntity` | **1** | Kollidiert mit Entities |
| `TrackTarget` | 0 | Gelenkt (verfolgt Ziel) |
| `VelocityAlign` | **1** | Mesh richtet sich nach Geschwindigkeit aus |
| `StayUpright` | 0 | |
| `LeadTarget` | **1** | Vorhalt |
| `StayUnderwater` | 0 | Torpedos |
| **`UseGravity`** | **1** | **Ballistik an (Default!)** |
| `DetonateAboveHeight` / `DetonateBelowHeight` | 0 / 0 | Airburst |
| **`TurnRate`** (+Range) | 0 | **Grad/s** Drehrate bei TrackTarget |
| **`Lifetime`** (+Range) | **15.0** | Sekunden |
| `InitialSpeed` (+Range) | 1.0 | wird von MuzzleVelocity überschrieben |
| `MaxSpeed` (+Range) | 0 | Kappung |
| `Acceleration` (+Range) | 0 | Einheiten/s² entlang Flugrichtung |
| `Position*` / `Direction*` (+Range) | 0 / (0,1,0), Range 1.5 | Spawn-Streuung |
| `RotationalVelocity` (+Range) | 0 | |
| `MaxZigZag` / `ZigZagFrequency` | 0 / 0 | Ausweichmanöver |
| `DestroyOnWater` | 0 | |
| `MinBounceCount` / `MaxBounceCount` / `BounceVelDamp` | 0 / 0 / 0.5 | Abpraller |
| `RealisticOrdinance` / `StraightDownOrdinance` | 0 / 0 | Bomben |

**Gravitation:** `SPhysConstants::mGravity = (0.0f, -4.9f, 0.0f)` (SPhysConstants.h:13) — Einheiten/s².
Pro Tick (dt = 0.1 s): `v += g * 0.1`, `pos += v * 0.1`. (Der Debug-Canvas nutzt `g * 0.01` = a·dt² und `v * 0.1` = v·dt — bestätigt dt = 0.1.)

**`BallisticAcceleration`** ist **kein Blueprint-Feld**, sondern ein Laufzeit-Vektor (`Projectile::mBallisticAcceleration`, Projectile.cpp:62/126, Offset 0x2BC), gesetzt aus Lua:
- `proj:SetBallisticAcceleration(y)` — Skalar = nur Y-Komponente
- `proj:SetBallisticAcceleration(x, y, z)` — voller Vektor

Belege aus dem Spiel-Lua: `self:SetBallisticAcceleration(0, -9.5, 0)`, `SetBallisticAcceleration(-0.5)`, `SetBallisticAcceleration(0, -89.92, 0)` (Bomben), `defaultexplosions.lua:319`: Debris mit `SetBallisticAcceleration(GetRandomFloat(-2,-3))`. Überschreibt/ersetzt die globale Gravitation für dieses Projektil.

**Projektil-Lua-API** (ProjectileLuaFunctionThunks.cpp:14-43) — komplett:
`GetLauncher`, `GetTrackingTarget`, `GetCurrentTargetPosition`, `SetNewTarget`, `SetNewTargetGround`, `SetLifetime`, `SetDamage`, `SetMaxSpeed`, `SetAcceleration`, `SetBallisticAcceleration`, `SetDestroyOnWater`, `SetTurnRate`, `GetCurrentSpeed`, `GetVelocity`, `SetVelocity`, `SetScaleVelocity`, `SetLocalAngularVelocity`, `SetCollision`, `SetCollideSurface`, `SetCollideEntity`, `StayUnderwater`, `TrackTarget`, `SetStayUpright`, `SetVelocityAlign`, `CreateChildProjectile`, `SetVelocityRandomUpVector`, `ChangeMaxZigZag`, `ChangeZigZagFrequency`, `ChangeDetonateAboveHeight`, `ChangeDetonateBelowHeight`

### 3c. Kollisionsmodell — drei getrennte Wege

**(A) Projektil** — Engine erkennt Treffer, ruft Lua-Filter, dann `Projectile:OnImpact(targetType, targetEntity)`.

Filterkette (alle müssen `true` liefern):
1. `Projectile:OnCollisionCheck(other)` (lua/sim/Projectile.lua:89-126):
   - `false` bei: TORPEDO↔TORPEDO, TORPEDO↔DIRECTFIRE, MISSILE↔MISSILE, MISSILE↔DIRECTFIRE, DIRECTFIRE↔MISSILE, **gleiche Army**
   - `false` wenn `other.Physics.HitAssignedTarget` und `other:GetTrackingTarget() != self`
   - `DoNotCollideList` beidseitig (Kategorien)
2. `Unit:OnCollisionCheck(other, firingWeapon)` (Unit.lua:972): bei gleicher Army → `other:GetCollideFriendly()` (= `DamageData.CollideFriendly`)
3. `Unit:OnCollisionCheckWeapon(firingWeapon)` (Unit.lua:1005): `CollideFriendly == false` + gleiche Army → `false`; `DoNotCollideList` der Waffe

`targetType` ∈ {`Unit`, `UnitAir`, `UnitUnderwater`, `Terrain`, `Water`, `Underwater`, `Air`, `Prop`, `Shield`, `Projectile`, `ProjectileUnderwater`}

`OnImpact` (Projectile.lua:259-356): `DoDamage` → `DoMetaImpact` → `DoUnitImpactBuffs` → Sound (`Audio['Impact'..targetType]` mit Fallback `Audio.Impact`) → Impact-FX + Terrain-FX → `OnImpactDestroy` (bzw. `ImpactTimeout` bei Terrain).

**(B) Beam** (`DefaultBeamWeapon`, defaultweapons.lua:785-995 + CollisionBeam.lua):
- Erzeugt **pro MuzzleBone** einen `CollisionBeam` bei `OnCreate` (kein Projektil!)
- `CollisionCheckInterval = BeamCollisionDelay * 10` (**Ticks**)
- `BeamLifetime > 0` → Puls-Strahl, `ForkThread(BeamLifetimeThread, BeamLifetime)` schaltet ab
- `BeamLifetime == 0` → **Dauerstrahl**; `WatchForHoldFire` prüft jede Sekunde `unit:GetFireState() == 1`
- `CollisionBeam:OnImpact` feuert nur, wenn sich das getroffene Objekt **ändert** (nicht jeden Tick)
- `CollisionBeam:DoDamage` (CollisionBeam.lua:67-96):
  ```lua
  dmgmod = product(self.Weapon.DamageModifiers)   -- multiplikativ
  damage = damageData.DamageAmount * dmgmod
  if radius > 0        → DamageArea(instigator, self:GetPosition(1), radius, damage, type, friendly)
  elseif targetEntity  → Damage(instigator, self:GetPosition(), targetEntity, damage, type)
  else                 → DamageArea(instigator, self:GetPosition(1), 0.25, damage, type, friendly)   -- Fallback!
  ```
  (`GetPosition(1)` = Endpunkt des Strahls)
- `MaximumBeamLength` im Weapon-Blueprint begrenzt die Strahllänge
- Energie-Gate: `EconomySupportsBeam()` → `energyStored < EnergyRequired && energyIncome < EnergyDrainPerSecond` → Strahl aus, zurück zu `IdleState`

**(C) SplashDamage** ist kein eigener Mechanismus — es ist schlicht `DamageArea` mit `DamageRadius > 0` in `Projectile:DoDamage`.

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

**DamageData wird beim Spawn übergeben** (`Weapon:GetDamageTable` → `proj:PassDamageData`, weapon.lua:284-345):
```lua
DamageRadius     = bp.DamageRadius + (self.DamageRadiusMod or 0)
DamageAmount     = bp.Damage       + (self.DamageMod or 0)
DamageType       = bp.DamageType
DamageFriendly   = bp.DamageFriendly  -- Default TRUE wenn nil!
CollideFriendly  = bp.CollideFriendly or false
DoTTime, DoTPulses, MetaImpactAmount, MetaImpactRadius, Buffs
```

### 4b. Die drei Schadens-Globals (exakte Signaturen aus CDamageLuaFunctionRegistrations.cpp)

```
Damage    (instigator, origin, target, amount, damageType)                              -- 5 Args
DamageArea(instigator, origin, radius, amount, damageType, damageFriendly [, damageSelf]) -- 6..7
DamageRing(instigator, origin, minRadius, maxRadius, amount, damageType, damageFriendly [, damageSelf]) -- 7..8
```
- `Damage`: `mMethod = CDamage_SINGLE_TARGET`, `mVector = target.Position - origin` (Trefferrichtung, geht in `OnDamage(vector)`)
- `DamageArea`: `mMethod = CDamage_AREA_EFFECT`, `mRadius`; Fehler bei `amount == 0` oder `radius == 0`
- `DamageRing`: `mMethod = CDamage_RING_EFFECT`, `mRadius = min`, `mMaxRadius = max`; erzwingt `min < max`
- `damageSelf` optional, Default `false`. `damageNeutral` ist im Payload vorhanden (Default 1), aber über die Lua-API nicht setzbar.

### 4c. DamageRadius-Falloff — WICHTIGER BEFUND

**`SIM_Damage` ist im faf-re-Decomp NICHT rekonstruiert** — leerer Stub:
`faf-re/src/sdk/moho/EngineUnrecoveredStubs.cpp:61`:
```cpp
void SIM_Damage(class moho::Sim *, class moho::CDamage const &) {}
```

**Aber:** die `CDamage`-Payload (CDamage.h:75-89, `sizeof == 0x8C`) enthält **kein einziges Falloff-, Kurven- oder Min-Damage-Feld**:
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
Reflektierte Felder (CDamage.cpp:466-477): `Method, MinMaxRadius, Origin, Amount, Type, DamageFriendly, DamageNeutral, DamageSelf, Vector`.

→ **Schlussfolgerung (strukturell belegt):** Es gibt engine-seitig **keinen Distanz-Falloff**. Die Engine selektiert Entities nach `mMethod` (Punkt / Kugel `radius` / Annulus `[radius, maxRadius]`) und wendet auf jede den **vollen `mAmount`** an. Ein Falloff wäre parameterlos nicht darstellbar.

**Distanzabhängigkeit wird in FA stattdessen in Lua modelliert:**
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
   Inner- und Outer-Ring laufen als **zwei parallele Threads**. Defaults (weapon.lua:330-340):
   `NukeInnerRingDamage=2000, Radius=30, Ticks=24, TotalTime=24`;
   `NukeOuterRingDamage=10, Radius=40, Ticks=20, TotalTime=10`.
   → Einheit bei r=10: 1× Inner-Puls (2000) + 1× Outer-Puls (10). Einheit bei r=35: nur Outer (10). Harter Cutoff bei 30, kein weicher Falloff.
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
   Aufruf mit `pulseTime = DoTTime / DoTPulses`, `damage` = **voller** Betrag **pro Puls** (nicht geteilt!).

### 4d. Armor / DamageType / Handicap

`lua/shield.lua:100-108` dokumentiert die Engine-Formel explizit (Kommentar: *"See SimDamage.cpp (DealDamage function) for how this should work"*):
```lua
amount = amount * self.Owner:GetArmorMult(type)
amount = amount * (1.0 - ArmyGetHandicap(self:GetArmy()))
```
→ **`effektiv = amount * ArmorMult(ArmorType, DamageType) * (1 - Handicap)`** — erst Rüstung, dann Handicap.

`lua/armordefinition.lua` (vollständig, 6 Einträge):
| ArmorType | Multiplikatoren |
|---|---|
| `Default` | `Normal 1.0` |
| `Normal` | `Normal 1.0` |
| `Light` | `Normal 1.0` |
| `Commander` | `Normal 1.0`, `Overcharge 0.033333`, `Deathnuke 0.05` |
| `Structure` | `Normal 1.0`, `Overcharge 0.066666`, `Deathnuke 0.01` |
| `Experimental` | `ExperimentalFootfall 0.0` |

Nicht gelistete DamageTypes → Multiplikator 1.0. Unit-Blueprint: `Defense.ArmorType`.
Engine-API: `Unit:GetArmorMult(damageType)`, `Unit:AlterArmor(...)`.

Bekannte DamageTypes im Spiel-Lua: `Normal`, `Overcharge`, `Deathnuke`, `ExperimentalFootfall`, `Fire`, `Force`, `Reclaimed`, `TreeForce`, `TreeFire`, `Nuke`.

### 4e. Friendly Fire

Zwei **unabhängige** Flags:
- **`CollideFriendly`** (Weapon-BP, Default `false`) — entscheidet, ob das Projektil mit Verbündeten/Eigenen überhaupt **kollidiert** (Filter in `Unit:OnCollisionCheckWeapon`, `Shield:OnCollisionCheckWeapon`, `Projectile:OnCollisionCheck`)
- **`DamageFriendly`** (Weapon-BP, **Default `true`** wenn nil! weapon.lua:291-293) — entscheidet, ob `DamageArea`/`DamageRing` Verbündete **schädigen**
- **`DamageSelf`** (Default `false`) — schädigt den Instigator selbst
- `IgnoresAlly` (Weapon-BP, Default **1**) — Engine-Flag, an `PROJ_Create` durchgereicht

`Projectile:OnCollisionCheck` blockt Kollision bei **gleicher Army** hart (Zeile 97), unabhängig von CollideFriendly — der Friendly-Collide-Pfad läuft über `Unit:OnCollisionCheck` → `other:GetCollideFriendly()`.

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

Projektile haben dieselbe Logik (`Projectile:DoTakeDamage`, Projectile.lua:143-166) mit `Defense.MaxHealth` (Default 10) — relevant für Anti-Missile/Flares.

---

## 5. Tod: OnKilled, Explosion, Wrack

### 5a. `Unit:OnKilled(instigator, type, overkillRatio)` (Unit.lua:896-943)

Reihenfolge:
1. `self.Dead = true`
2. Sound: `HoverKilledOnWater` / `AmphibiousFloatingKilledOnLand` / `Killed`
3. Factory → in Bau befindliche Einheit `Kill()`
4. `PlayDeathAnimation` → `ForkThread(PlayAnimationThread, 'AnimationDeath')` + `SetCollisionShape('None')`
5. `OnKilledVO()`, `DoUnitCallbacks('OnKilled')`, `DestroyTopSpeedEffects()`
6. `instigator:OnKilledUnit(self)` → dort `CheckVeteranLevel()` (Veteranen-Zählung beim **Killer**)
7. `DoDeathWeapon()` (wenn `DeathWeaponEnabled != false`)
8. `DisableShield()`, `DisableUnitIntel()`
9. `ForkThread(self.DeathThread, overkillRatio, instigator)`

**`DoDeathWeapon`** (Unit.lua:956-970): sucht Weapon mit `Label == 'DeathWeapon'`:
- `FireOnDeath == true` → `SetWeaponEnabledByLabel('DeathWeapon', true)` + `:Fire()` (volle Waffen-Pipeline)
- sonst → `ForkThread(DeathWeaponDamageThread, DamageRadius, Damage, DamageType, DamageFriendly)`:
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
Klassen-Defaults (Unit.lua:64-72): `PlayDestructionEffects=true`, `PlayEndAnimDestructionEffects=true`, `ShowUnitDestructionDebris=true`, `DestructionExplosionWaitDelayMin=0`, `DestructionExplosionWaitDelayMax=0.5`, `DeathThreadDestructionWaitTime=0`.

### 5c. Explosion (`defaultexplosions.lua`)

```lua
scale = GetAverageBoundingXZRadius(unit) = (SizeX + SizeZ) * 0.5
volume = GetUnitVolume(unit)
BoundingXYZRadius = (SizeX + SizeY + SizeZ) * 0.333
```
`_CreateScalableUnitExplosion` (Zeile 125-184):
- `scale < 0.5` → `ExplosionEffectsSml01`
- `scale > 4`   → `ExplosionEffectsLrg01`, `ShakeTimeModifier = 1.0`, `ShakeMaxMul = 0.25`
- sonst          → `ExplosionEffectsMed01`
- Layer `Water` → zusätzliche Environmental-FX
- `CreateFlash(obj, -1, scale, army)` → `CreateLightParticle(..., GetRandomFloat(6,10) * scale, GetRandomFloat(10.5,14.5), 'glow_03', 'ramp_flare_02')`
- Layer `Land`: `scale > 1.2` → `CreateScorchMarkDecal` (Größe `scale*3`), sonst `CreateScorchMarkSplat` (Größe `scale*4`); Lifetime `GetRandomFloat(300,600)`, LOD `GetRandomFloat(200,350)`
- `CreateDebrisProjectiles(obj, BoundingXYZRadius, Dimensions)`:
  `partamounts = GetRandomInt(1 + volume*5, volume*10)`, Projektile `/effects/entities/DebrisMisc04/...`
- **Camera Shake:** `obj:ShakeCamera(30 * scale, scale * ShakeMaxMul, 0, 0.5 + ShakeTimeModifier)`

### 5d. Wrack — exakte Werte

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
(Achtung: `overkillRatio or 1` — bei `nil` wird alles 0! Nur ein *gesetzter* Ratio < 1 lässt Masse übrig.)

Beispiel UEL0201: `MassMult = 0.9`, `EnergyMult = 0`, `HealthMult = 0.9`, `ReclaimTimeMultiplier = 1`, Blueprint `/props/DefaultWreckage/DefaultWreckage_prop.bp`, `WreckageLayers = { Land = true, Air = false, ... }`.

`Wreckage:DoTakeDamage` (lua/wreckage.lua:21-41) — Wrack-Reclaim skaliert mit Rest-HP:
```lua
healthRatio = health / maxHealth
SetReclaimValues(MaxReclaimTimeMassMult * healthRatio, MaxReclaimTimeEnergyMult * healthRatio,
                 MaxMassReclaim * healthRatio, MaxEnergyReclaim * healthRatio)
if health <= 0 then self:Destroy() end
```
`Wreckage:OnCollisionCheck` → `false` für Units (Einheiten fahren durch Wracks).

---

## 6. Schilde (`lua/shield.lua`)

Drei Klassen: `Shield` (Bubble), `UnitShield` (Personal, Box-Collision, Mesh-Swap am Owner), `AntiArtilleryShield`.

### 6a. Spec / Defaults (aus `Unit:CreateShield`, Unit.lua:3252-3279)

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
Wichtig: `OnGetDamageAbsorption` wird laut Kommentar **von der Engine** aufgerufen, um den Spillover auf Einheiten *unter* dem Schild zu berechnen — die Engine zieht den Rückgabewert vom Schaden ab, den sie den darunterliegenden Units zufügt. `PassOverkillDamage` ist der *zusätzliche* Lua-Pfad an den Schild-Owner.

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
→ `ShieldRegenRate` = HP **pro Sekunde**, startet erst `ShieldRegenStartTime` Sekunden nach dem **letzten** Treffer (jeder Treffer killt den Thread und startet ihn neu).

### 6d. Zustandsmaschine

- **`OnState`**: `CreateShieldMesh()` (Sphere-Collision `Size/2`), `Owner:OnShieldEnabled()`; Endlosschleife prüft jeden Tick `Owner:GetResourceConsumed()`; wenn `fraction != 1` **und** `EconomyStored('ENERGY') <= 0` zwei Ticks in Folge → `EnergyDrainRechargeState`. Bei Wiedereinschalten nach Off: `ChargingUp(0, ShieldEnergyDrainRechargeTime)`.
- **`DamageRechargeState`** (HP auf 0 geschossen): `RemoveShield()` → `ChargingUp(0, ShieldRechargeTime)` → `SetHealth(MaxHealth)` (volle HP!) → `OnState`
- **`EnergyDrainRechargeState`** (Energie leer): `RemoveShield()` → `ChargingUp(0, ShieldEnergyDrainRechargeTime)` → `OnState` (bzw. `OffState` wenn auf Transport)
- **`OffState`** (manuell aus): Regen-Thread killen, `OffHealth = GetHealth()`, `RemoveShield()`, `Owner:OnShieldDisabled()`
- **`ChargingUp(curProgress, time)`** — Ladebalken, fortschreitend mit tatsächlichem Energieverbrauch:
  ```lua
  while curProgress < time do
      curProgress = math.min(curProgress + (Owner:GetResourceConsumed() / 10), time)
      self:UpdateShieldRatio(curProgress / time)
      WaitTicks(1)
  end
  ```
  → bei voller Energie (`GetResourceConsumed() == 1`) dauert es exakt `time` Sekunden.

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

## 7. Konkrete Referenz-Blueprints (für Verifikation)

**UEL0201 (UEF T1-Panzer), Weapon `MainGun`** (`units.scd!units/UEL0201/UEL0201_unit.bp`):
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
Abgeleitet: Erfassungsradius = 1.15 * 18 = 20.7; Yaw-Slew = 100 * DEG2RAD * 0.1 = 0.1745 rad/Tick (10°/Tick); Toleranz = 2° ; Target-Recheck alle ceil(0.5*10) = 5 Ticks.

**TDFGauss01 (ballistisch)** (`projectiles.scd`):
```
Physics = { Acceleration = 0, DestroyOnWater = false, InitialSpeed = 12, MaxSpeed = 0,
            TurnRate = 360, VelocityAlign = true }     -- UseGravity fehlt -> Default TRUE
Categories = { 'UEF', 'PROJECTILE', 'DIRECTFIRE' }
```
(InitialSpeed 12 wird von MuzzleVelocity 25 überschrieben.)

**AIFGuidedMissile01 (gelenkt)** (`projectiles.scd`):
```
Physics = { Acceleration = 5, DestroyOnWater = true, InitialSpeed = 15, LeadTarget = false,
            Lifetime = 10, MaxSpeed = 35, TrackTarget = true, TurnRate = 150,
            UseGravity = false, VelocityAlign = true }
Categories = { 'AEON', 'PROJECTILE', 'MISSILE' }
```

---

## 8. Was für den Nachbau exakt gebraucht wird — Checkliste

1. **Sim-Tick = 10 Hz.** Alle Waffenzeiten in Ticks führen.
2. **`fireClock = floor(10 / RateOfFire)`** — nicht `1/RateOfFire` in Sekunden!
3. Engine ruft **nur `OnFire`**; die Salven-FSM ist Lua und läuft mit `WaitSeconds`/`WaitTicks` parallel.
4. **`SetBusy`-Interlock** zwischen FSM und `UnitWeapon::CanFire` (+ `NotExclusive`-Ausnahme).
5. `MuzzleSalvoDelay == 0` → **alle** MuzzleBones feuern; `MuzzleSalvoSize` ignoriert.
6. Rack-Round-Robin über OnFire-Zyklen; `RackFireTogether` als Ausnahme.
7. Turret: `TurretYaw`/`TurretPitch` = **Mitte**, `*Range` = **Halbspanne**; Slew = `deg/s * DEG2RAD * 0.1` rad/Tick.
8. `FiringTolerance` in **Grad**, pro Achse; `YawOnlyOnTarget` überspringt Pitch.
9. Reichweite: **2D-XZ** + `MaxHeightDiff` + `HeadingArcRange`.
10. `TrackingRadius` ist **Multiplikator** von MaxRadius.
11. `UseGravity` **Default true**; Gravitation `(0, -4.9, 0)`; Ballistik-Winkel via `CalculateFiringPitch` (High/Low je `BallisticArc`).
12. `MuzzleVelocity` überschreibt `InitialSpeed`; Gauss-Jitter + `sqrt(d/reduceDist)`-Dämpfung.
13. `ProjectileLifetimeUsesMultiplier` → `(MaxRadius / MuzzleVelocity) * mult`.
14. **Schaden: KEIN Distanz-Falloff.** Voller `Amount` auf alles im Radius/Ring. Falloff nur durch gestaffelte Ringe / ScalableRadiusAreaDoT in Lua.
15. `effektiv = amount * ArmorMult(ArmorType, DamageType) * (1 - Handicap)`.
16. `DamageFriendly` Default **true**, `CollideFriendly` Default **false** — zwei getrennte Konzepte.
17. `overkillRatio = max(0, (amount - preAdjHealth) / maxHealth)`; `> 1.0` → kein Wrack.
18. Wrack-Reclaim = `BuildCostMass * MassMult * (1 - overkillRatio) * fractionComplete`.
19. Schild: Absorption `min(hp, amount*mult)`, Overspill nur bei `PassOverkillDamage`; Regen startet `RegenStartTime` nach **letztem** Treffer; nach Durchbruch **volle** HP nach `ShieldRechargeTime`.
20. STRATEGIC+MISSILE (Nukes) durchdringen Schilde grundsätzlich.

**Bekannte Lücke:** Die genaue Entity-Selektion in `SIM_Damage` (welche Kollisionsvolumina als "im Radius" gelten — Mittelpunkt vs. Box/Sphere-Überschneidung) ist nicht rekonstruierbar. Für den Nachbau empfiehlt sich Sphere-vs-Collision-Volume-Überschneidung (konsistent mit `PointInShape`-Nutzung in `CDamage.cpp:160-171` und dem `SetPropCollision`/`SetCollisionShape`-Modell: `COLSHAPE_Box` / `COLSHAPE_Sphere`).

## Refs
- mohodata.scd!lua/sim/defaultweapons.lua:30-88 — DefaultProjectileWeapon.OnCreate: Validierung, NumMuzzles, RackRecoilReturnSpeed-Formel
- mohodata.scd!lua/sim/defaultweapons.lua:383-445 — IdleState (RackReloadTimeout, OnGotTarget/OnFire-Verzweigung)
- mohodata.scd!lua/sim/defaultweapons.lua:447-508 — RackSalvoChargeState + RackSalvoFireReadyState (EconDrain-Gate)
- mohodata.scd!lua/sim/defaultweapons.lua:510-658 — RackSalvoFiringState.Main: die komplette Salven-Schleife (MuzzleSalvoSize/Delay, Rack-Wrap, CountedProjectile, HaltFire)
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
- lua.scd!lua/sim/Projectile.lua:415-427 — PassDamageData (DamageData-Felder)
- lua.scd!lua/sim/Projectile.lua:453-462 — OnLostTarget (OnLostTargetLifetime, Default 0.5)
- lua.scd!lua/sim/Unit.lua:64-72 — Destruction-Defaults (DestructionExplosionWaitDelayMin/Max, DeathThreadDestructionWaitTime)
- lua.scd!lua/sim/Unit.lua:794-818 — DoTakeDamage + excessDamageRatio (Overkill-Formel)
- lua.scd!lua/sim/Unit.lua:896-943 — OnKilled (vollstaendige Reihenfolge)
- lua.scd!lua/sim/Unit.lua:956-970 — DoDeathWeapon (FireOnDeath vs DeathWeaponDamageThread)
- lua.scd!lua/sim/Unit.lua:972-1029 — OnCollisionCheck / OnCollisionCheckWeapon (CollideFriendly, DoNotCollideList)
- lua.scd!lua/sim/Unit.lua:1076-1146 — CreateWreckage / CreateWreckageProp (alle Wrack-Formeln)
- lua.scd!lua/sim/Unit.lua:1195-1198 — DeathWeaponDamageThread (WaitSeconds 0.1 + DamageArea)
- lua.scd!lua/sim/Unit.lua:1200-1242 — DeathThread (Explosion, Wrack, Debris nach overkillRatio)
- lua.scd!lua/sim/Unit.lua:3252-3341 — CreateShield / CreatePersonalShield / CreateAntiArtilleryShield (alle Schild-Defaults)
- lua.scd!lua/shield.lua:100-108 — OnGetDamageAbsorption (Armor*Handicap-Formel, Verweis auf SimDamage.cpp DealDamage)
- lua.scd!lua/shield.lua:132-144 — GetOverkill
- lua.scd!lua/shield.lua:146-190 — OnDamage + RegenStartThread (Overspill, Regen-Neustart)
- lua.scd!lua/shield.lua:223-239 — OnCollisionCheck (Nuke-Durchdringung)
- lua.scd!lua/shield.lua:286-412 — ChargingUp + OnState/OffState/DamageRechargeState/EnergyDrainRechargeState
- lua.scd!lua/shield.lua:496-534 — AntiArtilleryShield (ArtilleryShieldBlocks)
- lua.scd!lua/armordefinition.lua:14-59 — vollstaendige Armor/DamageType-Multiplikator-Tabelle
- lua.scd!lua/wreckage.lua:21-49 — Wreckage.DoTakeDamage (Reclaim skaliert mit HP), OnCollisionCheck
- lua.scd!lua/defaultexplosions.lua:40-48 — GetAverageBoundingXZRadius / XYZRadius
- lua.scd!lua/defaultexplosions.lua:125-184 — _CreateScalableUnitExplosion (Scale-Schwellen, ShakeCamera, Scorch)
- lua.scd!lua/defaultexplosions.lua:277-287 — CreateDebrisProjectiles (partamounts-Formel)
- lua.scd!lua/defaultexplosions.lua:249-272 — CreateWreckageEffects
- faf-re/src/sdk/moho/unit/tasks/CFireWeaponTask.cpp:228-268 — Execute(): DER Feuertakt, fireClock = (int)(10.0f/RateOfFire)
- faf-re/src/sdk/moho/unit/tasks/CFireWeaponTask.cpp:151-159 — FireWeapon(): RunScript("OnFire") + ++mShotsAtTarget
- faf-re/src/sdk/moho/unit/core/CWeaponAttributes.h:24-38 — CWeaponAttributes-Layout (Lua-Overrides, <0 = Blueprint-Fallback)
- faf-re/src/sdk/moho/unit/core/UnitWeapon.h:58-64 — ESolutionStatus (Available/InsideMinRange/NoSolution/OutsideMaxRange)
- faf-re/src/sdk/moho/unit/core/UnitWeapon.h:331-358 — UnitWeapon-Layout (mCanFire, mFiringRandomness, mTargetPriorities, mAimingAt)
- faf-re/src/sdk/moho/unit/core/UnitWeapon.cpp:496-560 — EvaluateTargetSolutionStatusGun: 2D-XZ-Reichweite, MaxHeightDiff, HeadingArc
- faf-re/src/sdk/moho/unit/core/UnitWeapon.cpp:3172-3284 — UnitWeapon::CanFire (Stun/Busy/Layer/AboveWater/BombDrop-Gates)
- faf-re/src/sdk/moho/unit/core/UnitWeapon.cpp:3346-3357 — CheckSilo (CountedProjectile)
- faf-re/src/sdk/moho/unit/core/UnitWeapon.cpp:3366-3409 — CanAttackTarget (FireTargetLayerCaps, CannotAttackGround)
- faf-re/src/sdk/moho/unit/core/UnitWeapon.cpp:3666-3759 — CreateProjectile: FiringRandomness-Jitter, MuzzleVelocity-Override, ProjectileLifetimeUsesMultiplier
- faf-re/src/sdk/moho/ai/CAimManipulator.cpp:523-582 — PredictInterceptPointConstantSpeed (Lead-Polynom 0.00761/0.16605)
- faf-re/src/sdk/moho/ai/CAimManipulator.cpp:591-638 — PredictInterceptPointFromForwardVelocity (10 Iterationen)
- faf-re/src/sdk/moho/ai/CAimManipulator.cpp:647-677 — CalculateFiringPitch (High/Low-Arc-Formel)
- faf-re/src/sdk/moho/ai/CAimManipulator.cpp:686-707 — CalculateFiringDirection
- faf-re/src/sdk/moho/ai/CAimManipulator.cpp:835-932 — AimManip: mOnTarget -> weapon->mCanFire + EventSetSignaled; TargetCheckInterval*10
- faf-re/src/sdk/moho/ai/CAimManipulator.cpp:941-1106 — Aim(): MuzzleVelocityReduceDistance, LeadTarget, BallisticArc-Auswahl
- faf-re/src/sdk/moho/ai/CAimManipulator.cpp:1180-1229 — SetFiringArc: Grad->Radiant, kSlewScale = 0.1 (rad/Tick)
- faf-re/src/sdk/moho/ai/CAimManipulator.cpp:1239-1327 — CheckTracking: Arc-Klemmung, Slew-Klemmung, FiringTolerance-Pruefung, YawOnlyOnTarget
- faf-re/src/sdk/moho/ai/CAimManipulator.cpp:1386-1472 — Track(): onTarget-Aggregation ueber Heading+Pitch
- faf-re/src/sdk/moho/ai/CAiAttackerImpl.cpp:459-473 — TargetCheckInterval -> ceil(interval*10) Frames, NeedPrep=2
- faf-re/src/sdk/moho/ai/CAiAttackerImpl.cpp:1143-1170 — Ziel-Priorisierung (mTargetPriorities-Iteration, RECON_LOSEver-Bevorzugung)
- faf-re/src/sdk/moho/ai/CAiAttackerImpl.cpp:1256-1274 — Erfassungsreichweite = TrackingRadius * MaxRadius
- faf-re/src/sdk/moho/sim/CDamage.h:17-22 — CDamageMethod (SINGLE_TARGET / AREA_EFFECT / RING_EFFECT)
- faf-re/src/sdk/moho/sim/CDamage.h:75-103 — CDamage-Layout: KEIN Falloff-Feld (Beleg fuer 'kein Distanz-Falloff')
- faf-re/src/sdk/moho/sim/CDamage.cpp:466-477 — CDamageTypeInfo::AddFields (reflektierte Felder, bestaetigt Payload)
- faf-re/src/sdk/moho/sim/CDamageLuaFunctionRegistrations.cpp:159-215 — cfunc_DamageL: Damage(instigator, origin, target, amount, type)
- faf-re/src/sdk/moho/sim/CDamageLuaFunctionRegistrations.cpp:265-332 — cfunc_DamageAreaL: DamageArea(..., damageFriendly, [damageSelf])
- faf-re/src/sdk/moho/sim/CDamageLuaFunctionRegistrations.cpp:382-461 — cfunc_DamageRingL: DamageRing(..., minR, maxR, ...), erzwingt minR < maxR
- faf-re/src/sdk/moho/EngineUnrecoveredStubs.cpp:61 — SIM_Damage ist ein LEERER STUB (Falloff-Math nicht rekonstruiert)
- faf-re/src/sdk/moho/sim/SPhysConstants.h:13 — Gravitation = (0.0f, -4.9f, 0.0f)
- faf-re/src/sdk/moho/resource/blueprints/RUnitBlueprint.h:531-647 — RUnitBlueprintWeapon: vollstaendiges Weapon-Blueprint-Schema
- faf-re/src/sdk/moho/resource/blueprints/RUnitBlueprint.cpp:1015-1086 — RUnitBlueprintWeapon-Defaults (FiringTolerance 0.01, MaxHeightDiff inf, RateOfFire 1.0, TrackingRadius 1.0, HeadingArcRange 180, IgnoresAlly 1, LeadTarget 1, TargetCheckInterval 3.0)
- faf-re/src/sdk/moho/resource/blueprints/RUnitBlueprint.cpp:1125-1138 — GetMuzzleVelocity (Gauss-Jitter + sqrt-Nahbereichsdaempfung)
- faf-re/src/sdk/moho/resource/blueprints/RProjectileBlueprint.h:52-92 — RProjectileBlueprintPhysics: vollstaendiges Projektil-Schema
- faf-re/src/sdk/moho/resource/blueprints/RProjectileBlueprint.cpp:98-143 — Projektil-Defaults (UseGravity=1, Lifetime=15, CollideSurface/Entity=1, VelocityAlign=1, LeadTarget=1)
- faf-re/src/sdk/moho/projectile/Projectile.cpp:48-80 — Projectile-Runtime (mBallisticAcceleration, mTurnRateDegrees, mMaxSpeed, mLifetimeEnd)
- faf-re/src/sdk/moho/projectile/ProjectileLuaFunctionThunks.cpp:14-43 — vollstaendige Projektil-Lua-API (SetBallisticAcceleration, SetTurnRate, TrackTarget, ...)
- faf-re/src/sdk/moho/collision/ECollisionShape.h:9-14 — COLSHAPE_None / Box / Sphere
- units.scd!units/UEL0201/UEL0201_unit.bp — Referenz-Weaponblueprint (MainGun) + Wreckage-Werte
- projectiles.scd!projectiles/TDFGauss01/TDFGauss01_proj.bp — Referenz ballistisches Projektil
- projectiles.scd!projectiles/AIFGuidedMissile01/AIFGuidedMissile01_proj.bp — Referenz gelenktes Projektil (TrackTarget/TurnRate/MaxSpeed/Acceleration)
