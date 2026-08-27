# Kampf 1:1 — Projektile, Schaden, Tod, Wracks

**Builds on** [weapons.md](weapons.md) (fire cycle, volley FSM, aiming, blueprint fields) and
[damage-binary.md](damage-binary.md) (`SIM_Damage` chain). What is there will be here
**not repeated** — just corrected, supplemented and put into a building order.
Everything that comes from the IDA Decomp (`Cfile/ForgedAlliance.exe.c`) is new: weapons.md
came from faf-re, several details were inaccurate or missing there.

## 1. Overview — who does what

| step | Location | What |
|---|---|---|
| Find target | **Engine** | `CAcquireTargetTask::TaskTick` scans blips, calls `UnitWeapon::SetTarget` |
| Zielen | **Engine** | `CAimManipulator` dreht Turm, setzt `mCanFire` |
| Firing decision | **Engine** | `CFireWeaponTask::Dispatch` — Fire cycle, gates, then `RunScript("OnFire")` |
| volley, muzzle, shot | **Lua** | `defaultweapons.lua` FSM → `weapon:CreateProjectile(bone)` |
| Generate projectile | **Engine** | `UnitWeapon::CreateProjectile` → `PROJ_Create` → Lua-`OnCreate` |
| Flugbahn | **Engine** | `Projectile::MotionTick` (10 Hz) |
| Treffer erkennen | **Engine** | `Projectile::CheckCollision` → Lua-Filter → `RunScript("OnImpact")` |
| Schaden anrichten | **Lua** | `Projectile:OnImpact` → `DoDamage` → `Damage`/`DamageArea` |
| Calculate damage | **Engine** | `SIM_Damage` → Armor/Handicap → `RunScript("OnDamage")` |
| Die | **Lua** | `Unit:OnDamage` → `DoTakeDamage` → `self:Kill(...)` |
| trigger death | **Engine** | `Unit::Kill` → `RunScript("OnKilled")` |
| Explosion, wreck | **Lua** | `Unit:DeathThread` → `CreateWreckage` → `CreateProp` |

The Lua decides **nothing** about hits and trajectory — it is told them.
Conversely, the engine decides **nothing** about the amount of damage and wreckage value.

## 2. The fire cycle, documented in binary form

### 2a. `CFireWeaponTask::Dispatch` (@0x6D3DC0, Cfile:983912-983956)

```
if (mFireClock) --mFireClock;
if (!weapon->mEnabled)               return;
if (bp->mManualFire)                 return;
if (mFireClock == 0
    && unit->mFireState != FIRESTATE_HoldFire
    && CAiTarget::HasTarget(&weapon->mTarget)
    && UnitWeapon::CanAttackTarget(...)
    && UnitWeapon::CanFire(...)
    && UnitWeapon::CheckSilo(...)
    && !UnitWeapon::TargetIsTooClose(...)
    && !(bp->mCannotAttackGround && target.type == AITARGET_Ground))
{
    UnitWeapon::Fire(weapon);                     // <- der einzige Lua-Aufruf
    rof = attributes.mRateOfFire; if (rof < 0) rof = bp->mRateOfFire;
    mFireClock = (int)(10.0f / rof);              // TRUNKIERT, in Ticks
}
```

`UnitWeapon::Fire` (Cfile:985500-985608): Stun-Guard (`mStunTicks`), Statistik,
then `RunScript("OnFire")` + `++mShotsAtTarget`. **Nothing else** — no projectile.

The Sentinel pattern is confirmed in binary: the `CWeaponAttributes`-Ctor sets
`mRateOfFire = -1`, `mMaxRadius = -1`, `mDamageRadius = -1`, `mFiringTolerance = -1`
(Cfile:983289-983304) ⇒ **negative means “take the blueprint value”**.

### 2b. Zielerfassung — `CAcquireTargetTask::TaskTick` (@0x5D8D10, Cfile:792838ff)

- Check interval: `TargetCheckInterval * 10` ticks (Cfile:792841).
- Suchradius: `max(TrackingRadius · MaxRadius, MaxRadius)` (Cfile:793146-793156)
  — **a maximum**, not just the product: `TrackingRadius < 1` doesn't reduce anything.
- Candidates are the **Blips** of the unit (`unit->mBlipsInRange` or `GetBlipsInRange`,
  Cfile:793167-793169) — Target acquisition runs through the recon DB, not through raw entities.
- `FindBestEnemy(weapon, blips, radius, turreted||slavedToBody)` → `UnitWeapon::SetTarget`.

`UnitWeapon::SetTarget` (Cfile:985364-985494): Zielwechsel ⇒ `RunScript("OnLostTarget")` /
`RunScript("OnGotTarget")` on the **Weapon**, `mShotsAtTarget = 0`, and the FireWeaponTask
is taken from the waiting stack (i.e. fires in the next tick).

### 2c. Lua chain to the weft

```
defaultweapons.lua:582   self:CreateProjectileAtMuzzle(muzzle)
defaultweapons.lua:107   → self:CreateProjectileForWeapon(muzzle)   (+ DetonatesAtTargetHeight, Flare, Audio.Fire)
weapon.lua:321           → local proj = self:CreateProjectile(bone)  ← ENGINE
weapon.lua:325           → proj:PassDamageData(self:GetDamageTable())
weapon.lua:284-318       GetDamageTable: Damage, DamageRadius, DamageType, DamageFriendly(default TRUE),
                         CollideFriendly(default false), DoTTime/DoTPulses, MetaImpact*, Buffs
Projectile.lua:415-427   PassDamageData kopiert genau diese 11 Felder nach self.DamageData
```

### 2d. `UnitWeapon::CreateProjectile` (@0x6D6820, Cfile:985613-985800)

New compared to weapons.md:

- **No `ProjectileId` ⇒ no error:** `gpg::Logf("%s:%s:CreateProjectile: no projectile
  blueprint, doing instahit instead.")` und `DoInstaHit(bone, 0.1, 1.0, ...)` (Cfile:985658-985675).
  The function then returns `nil` — `CreateProjectileAtMuzzle` checks for exactly that.
- Start orientation: `StraightDownOrdinance` ⇒ `(0,-1,0)`; otherwise
  `UseFiringSolutionInsteadOfAimBone` ⇒ `normalize(mAimingAt)`; otherwise the muzzle bone.
- `mFiringRandomness > 0` ⇒ two `FRandGaussian()` · Randomness · `DEG2RAD` on heading/pitch.
- `PROJ_Create(bp, transform, sim, army, launcher, damage, damageRadius, damageType, target, IgnoresAlly)`
  — `damage`/`damageRadius` from `mAttributes` (or Blueprint if < 0).
- `MuzzleVelocity != 0` ⇒ Speed ​​amount is overwritten; the distance for
  `GetMuzzleVelocity` is the **3D** distance muzzle→`CAiTarget::GetTargetPosGun`.
- Lebensdauer in **Ticks**: `mLifetimeEnd = curTick + (int)(ProjectileLifetime · 10)`, bzw.
  `(int)((MaxRadius / MuzzleVelocity) · ProjectileLifetimeUsesMultiplier · 10)`.
- `ReTargetOnMiss` ⇒ `TransmitProjectileImpactEvent`.

## 3. Projektil-Lifecycle

### 3a. Ctor (`Moho::Projectile::Projectile`, Cfile:943313-944010)

1. `mVelocity = 0`; `TurnRate`/`MaxSpeed`/`Acceleration` je mit **±Range**-Gleichverteilung.
2. **`mBallisticAcc = sim->mPhysConstants->mGravity · UseGravity`** (Cfile:943663-943668) —
   `UseGravity` is a bool (0/1) that simply **turns off** gravity.
3. `mLifetimeEnd = curTick + (int)((Lifetime ± LifeTimeRange) · 10)`.
4. `RunScript("OnPreCreate")`.
5. Geschwindigkeit: `RealisticOrdinance` ⇒ `velocity = launcher:GetVelocity() · 10`;
   **otherwise** `velocity = forward(launchOrient) · GetRandomInitialSpeed(bp)` (Cfile:943842-943854).
6. Layer `Air`/`Water` setzen (+ `OnLayerChange`), `SetMesh`.
7. `belowWater && DestroyOnWater` ⇒ immediately `Destroy()`, **otherwise**
   `RunScript("OnCreate", inWater)` (Cfile:943988) — the `inWater` argument, which
   `TDFGauss01_script.lua:OnCreate(self, inWater)` erwartet.

**Blueprint defaults (binary, `RProjectileBlueprintPhysics`-Ctor, Cfile:653667-653712):**
`Lifetime 15`, `InitialSpeed 1`, `MaxSpeed 0`, `Acceleration 0`, `TurnRate 0`,
`CollideSurface 1`, `CollisionEntity 1`, `TrackTarget 0`, `VelocityAlign 1`, `StayUpright 0`,
`LeadTarget 1`, `StayUnderwater 0`, **`UseGravity 1`**, `DirectionY 1`, `DirectionXRange/ZRange 1.5`,
`DestroyOnWater 0`, `BounceVelDamp 0.5`, `MinBounceCount/MaxBounceCount 0`,
`RealisticOrdinance 0`, `StraightDownOrdinance 0`. Ausserdem `Economy.BuildTime = 10`,
`CollisionShape = None` (Cfile:653736-653741).

**The projectile blueprint does NOT have a `Defense` section** (`RProjectileBlueprintTypeInfo::AddFields`,
Cfile:654222-654240: only `DevStatus`, `Display`, `Economy`, `Physics` above the
`REntityBlueprint`-Basis). `Projectile.lua:75` liest trotzdem `bp.Defense.MaxHealth or 1` —
this **only** works thanks to the LuaPlus-`nil` metatable (`nil.MaxHealth` → `nil`) that we
already produce in [boot.lua](../../src/engine-lua/boot.lua). Without it, every projectile dies
in seinem eigenen `OnCreate`.

### 3b. `Projectile::MotionTick` (Cfile:944040-944290) — per tick, dt = 0.1

```
if (mImpactInterp >= 0) { Impact(); return; }       // Aufschlag wird im NAECHSTEN Tick aufgeloest
scale += mScaleVelocity * 0.1

if (!mTrackTarget) {
    v += mBallisticAcc * 0.1                        // Gravitation / SetBallisticAcceleration
    v += forward(orient) * mAcceleration * 0.1
    if (mVelocityAlign)                             // Mesh dreht sich zur Flugrichtung,
        orient = QuatFromVecRot(orient, v, mTurnRateDeg * 0.0017453292)   // begrenzt: deg/s -> rad/Tick
} else {
    UpdateTracking(&tran)                           // Lenkung: dreht orient zum Ziel
    v += forward(orient) * mAcceleration * 0.1
}
if (mMaxSpeed != 0) VecLimitLengthTo(v, mMaxSpeed)
if (mStayUpright)   orient = Orient(forward)

pos += (v_alt + v_neu) * 0.05                       // <<< TRAPEZ, nicht v_neu * 0.1
... LocalAngularVelocity (rad/s * 0.1), StayUnderwater-Klemmung ...
SetPendingTransform(tran); CheckCollision();
if (curTick >= mLifetimeEnd && mImpactInterp < 0) { // Lebensdauer abgelaufen
    mImpactInterp = 1.0; mImpactPosition = mLastTrans.pos;
    mImpactType = mBelowWater + 3;                  // 3 = Air, 4 = Underwater
}
```

**Zwei Korrekturen an weapons.md:**
1. The integration is **trapezoidal**: `pos += 0.5·(v_alt + v_neu)·0.1`. Naive Euler
   (`pos += v·0.1`) shifts any trajectory.
2. `TurnRate` (degree/s) does **not nothing** with `TrackTarget = false`: it limits how fast
   the mesh orientation adapts to the speed (`mTurnRateDeg · 0.0017453292`
   = deg*DEG2RAD*0.1 rad/tick). That's why TDFGauss01 has `TurnRate = 360`, even though it is unguided.

### 3c. `Projectile::CheckCollision` (@0x69D1D0) — **cannot be decompiled**

IDA fails because of this function (0xC9A bytes), so it is **not** in the cfile — exactly like that
`SIM_Damage` in faf-re was a stub. It can only be reconstructed via its call list
(`get_callees` @0x69d1d0):

`COGrid::GetEntityCollisionsInLine`, `Wm3::DistVector3Segment3f::GetSquared`,
`COGrid::ForAllEntitiesIterator`, `CHeightField::Intersection` + `GetElevation`,
`CColHitResult::PlaneIntersection`, `ENT_GetImpactType`, **`func_OnCollisionCheck`**,
`IArmy::IsEnemy`, `CAiTarget::GetEntity`, `Entity::SetCurrentLayer`, `CScriptObject::RunScript`.

From this it follows that it is a **sweeped route test** (last position → new position),
not a point test; Terrain comes from the heightfield, water from a plane section calculation;
the Lua filter is `self:OnCollisionCheck(other)` with **one** argument
(`func_OnCollisionCheck`, Cfile:945766-945830 — `Call_ObjScrobj_Bool`).

`ENT_GetImpactType(pos, entity, sim)` (@0x67B240, per IDA dekompiliert):

| | over water | under water |
|---|---|---|
| no entity | `Air` | `Underwater` |
| Unit | `Unit`, in the air layer `UnitAir` | `UnitUnderwater` |
| Projectile | `Projectile` | `ProjectileUnderwater` |
| Prop | `Prop` | `Underwater` |
| Schild (`id & 0xF0000000 == 0x40000000`) | `Shield` | `Shield` |

This function **does not** create `Terrain` and `Water` — they come from the heightfield/
Waterplane branch from `CheckCollision`.

`EImpactType` (Cfile:640486-640525): `Invalid 0, Terrain 1, Water 2, Air 3, Underwater 4,
Projectile 5, ProjectileUnderwater 6, Prop 7, Shield 8, Unit 9, UnitAir 10, UnitUnderwater 11`.
Strings: `ENT_GetImpactTypeString` (Cfile:917363-917400) — exactly the names that
`Projectile.lua:310-345` abfragt.

### 3d. `Projectile::Impact` (Cfile:944692-944745)

`RunScript_StrObj("OnImpact", ImpactTypeString, targetEntity)` — **zwei** Argumente. Danach
Statistics (`_Shots_Hit` / `_Shots_Missed` via `CAiTarget::ImpactDidHitEntity`).

Lua-Seite: `Projectile:OnImpact` (Projectile.lua:259-356) → `DoDamage` (173-192) → `DoMetaImpact`
→ `DoUnitImpactBuffs` → Sound `Audio['Impact'..targetType]` (Fallback `Audio.Impact`) → FX →
`ImpactTimeout` if `Terrain`, otherwise `OnImpactDestroy` (358-363).

## 4. Damage and death

`Damage(instigator, origin, target, amount, type)` — **5 arguments** (the help text
`"Damage(instigator, target, amount, damageType)"` is deprecated; `cfunc_DamageL` checks
`lua_gettop != 5`, Cfile:1064215). `mVector = target.pos − origin`; `amount == 0` ⇒ **Lua error**.
Rest of the chain: see [damage-binary.md](damage-binary.md) (`SIM_Damage` @0x737E60,
`effektiv = amount · ArmorMult / (1 + Handicap)`, no distance falloff, `NOSPLASHDAMAGE`).

Lua side: `Unit:OnDamage` (unit.lua:787-792) only fires if **`self.CanTakeDamage`** is set
is — that happens in `unit.lua:190` (`self:SetCanTakeDamage(true)`), and `SetCanTakeDamage` is
overridden in unit.lua:779 as **Lua** method. → `DoTakeDamage` (794-818) → `self:Kill(...)`.

**`Unit::Kill(instigator, type, overkillRatio)` (Cfile:951962-952180) is Engine:**
`RunScript("SetDead")` → `Entity::Kill` (setzt `mIsDead`, Cfile:916064-916086) → Command-Queue
empty → `RunScript_UnitOnKilled(instigator, type, overkillRatio)`. And a detail that you don't
can invent: **if the unit is under construction and `FractionComplete < 0.5`, `overkillRatio` becomes `10.0`
set** (Cfile:952126-952127) ⇒ a half-finished construction site never leaves a wreck.

`Entity::Destroy` (Cfile:916089-916115) is **deferred**: the entity ends up in
`sim->mDeletionQueue`; `RunScript("OnDestroy")` only runs when the data is actually deleted
(`Entity::OnDestroy`, Cfile:916143).

Death/wreckage in Lua: `Unit:OnKilled` (896-943) → `DeathThread` (1200-1242) → `CreateWreckage`
(1076-1146) — Formulas are completely in weapons.md §5.

## 5. Which Lua class gets a projectile?

`func_FindBlueprintScriptModule` (Cfile:914189-914360) — applies to Unit, Projectile **and** Prop:

1. Blueprint type ⇒ Default: `RUnitBlueprint` → `/lua/sim/unit.lua` / `"Unit"`,
   `RProjectileBlueprint` → `/lua/sim/projectile.lua` / `"Projectile"`,
   `RPropBlueprint` → `/lua/sim/prop.lua` / `"Prop"`.
2. `ScriptModule` = `bp.ScriptModule`, or if empty: `bp.Source` to the **last** `_`
   truncate and append `_script.lua`.
   `/projectiles/TDFGauss01/TDFGauss01_proj.bp` → `/projectiles/TDFGauss01/TDFGauss01_script.lua`.
3. Class name = `bp.ScriptClass`, otherwise **`"TypeClass"`**.
4. If the file does not exist ⇒ Default off (1).

A projectile's blueprint ID is the **full lowercase path with `.bp`**
(`SetBackwardsCompatId`, blueprints.lua:104-107) — exactly the string in `Weapon.ProjectileId`.
`ProjectileBlueprint(bp)` → `StoreBlueprint('Projectile', bp)` → `RegisterProjectileBlueprint`
(blueprints.lua:259-262, 313) — so the pipeline is already there, the only thing missing is that
`/projectiles/**/*_proj.bp` ends up in `__bpFiles` at all.

## 6. Missing engine bindings (≈65)

| Name | Semantics (evidence) | Who needs it |
|---|---|---|
| **`moho.projectile_methods`** (30) | `SetVelocity`, `SetBallisticAcceleration`, `SetLifetime`, `SetTurnRate`, `TrackTarget`, `SetDamage`, `GetLauncher`, `CreateChildProjectile`, `SetCollideSurface/Entity`, … (engine-api.md, class `Projectile`) | `Projectile.lua`, each `*_script.lua` |
| `Entity:CreateProjectile(bp,[o],[d])` | Cfile:930705ff — Direction from `RandomDirection(bp)`, Speed ​​= `InitialSpeed ± Range`, Damage 0, Type `'Normal'` | `defaultexplosions.lua` (Debris) |
| `Entity:CreateProjectileAtBone(bp,bone)` | Cfile:930934ff, as above but on the bone | Effects |
| `UnitWeapon:CreateProjectile(muzzle)` | Cfile:985613 — **the** shot | `weapon.lua:322` |
| `UnitWeapon:SetTargetEntity/SetTargetGround/ResetTarget` | Cfile:986717/986800/986905 | `Unit:SetTarget`, commands |
| `UnitWeapon:GetCurrentTargetPos` | Cfile:987621 | `defaultweapons.lua:114` |
| `UnitWeapon:FireWeapon()` | Cfile:987369 — manuelles Feuern | `DoDeathWeapon` (`FireOnDeath`) |
| `UnitWeapon:GetFireClockPct` | Cfile:988512-988531: `1 − mFireClock / (10/RoF)` | `RenderFireClock` |
| `UnitWeapon:DoInstaHit` | Cfile:987034 — Fallback without ProjectileId | Engine internal |
| `Entity:Kill(instigator,type,overkill)` | Cfile:951962 (implemented, moho.lua:175) | `unit.lua:812` |
| `Entity:SetCollisionShape(shape,cx,cy,cz,size)` | Cfile:934167 | `unit.lua`, `Prop` |
| `Entity:GetPosition([bone])` | Cfile:934579 — **We are missing bone argument** | `CollisionBeam:GetPosition(1)` |
| `Entity:GetBoneDirection(name)` | Cfile:931458 | Weapons, Effects |
| `Unit:GetArmorMult(type)` / `AlterArmor` | Cfile:972450 / 972372 | `shield.lua:101`, damage formula |
| `Unit:GetAttacker`, `SetBusy`, `IsUnitState('Busy')` | Salvo interlock | `defaultweapons.lua:526` |
| `moho.prop_methods.AddBoundedProp` | engine-api.md, class `Prop` | `unit.lua:1112` |
| **Globals:** `Damage`, `DamageArea`, `DamageRing`, `MetaImpact` | Cfile:1064181/1064294/1064409/1064536 | `Projectile:DoDamage`, `DefaultDamage.lua` |
| `CreateProp`, `CreatePropHPR`, `SplitProp`, `TryCopyPose` | Cfile:1015366ff | `CreateWreckageProp` |
| `Random([min,]max)` | Cfile:758FB0 — 0 Args = float[0,1) | `GetRandomFloat` ⇒ **`DeathThread` dies immediately without** |
| `IsProjectile`, `IsProp`, `IsCollisionBeam` | Cfile:1091691ff | Kollisionsfilter |
| `GetEntityById`, `GetUnitById`, `GetEntitiesInRect`, `GetUnitsInRect` | Target/area search | Target acquisition, `DamageArea` |
| `ArmyGetHandicap`, `OkayToMessWithArmy` | Schadensformel | `shield.lua:102` |

**Incorrect, not just missing:** `IsAlly(a,b)` / `IsEnemy(a,b)` in
[globals.lua:42-43](../../src/engine-lua/globals.lua) vergleichen bloss Armee-Indizes
(`a == b`). Without a real alliance table, any collision and friendly fire filter is out of the question.

## 7. Current status of our engine

> **HISTORICAL (superseded 2026-08-25).** This section is the snapshot from
> *before* the combat system existed and is kept only to show what the gap list
> looked like then. Nearly every "missing" item below has since been built:
> weapons acquire targets and fire, projectiles load and impact, `Kill`
> (moho.lua:175) and `GetArmorMult` (moho.lua:443) have real bodies, and
> `moho.projectile_methods` is a real class. For the current picture use
> [docs/STATUS.md](../STATUS.md) and the coverage report
> (`npx tsx --import ./scripts/register-lua.mjs scripts/coverage-engine.ts`),
> which was itself blind to every class binding until 2026-08-24.

**There:** the weapon objects themselves ([units.lua:54-88](../../src/engine-lua/units.lua)) — per
`bp.Weapon` entry is an instance of the original class, with `OnCreate` ⇒ the state machine
`defaultweapons.lua` is running. Skeleton names (`__setBones`), `class.lua`, blueprint pipeline,
Economics, threads.

**Missing completely:**
- **No one ever gives a weapon a target.** No `SetTarget`, no `OnGotTarget`, no `OnFire`
  throughout the tree (`grep -rn "OnFire\|__target" src/` finds nothing outside of moho.lua).
  The FSM has been in `IdleState` since the first tick.
- **No firing cycle.** `beat()` ([engine.ts:91-108](../../src/lua/engine.ts)) has six phases —
  none of these are weapon or projectile phases.
- **`moho.projectile_methods` does not exist** → the Auto-Vivifier in
  [moho.lua:530-536](../../src/engine-lua/moho.lua) returns an **empty class**. `Projectile.lua`
  So loads, and every method call is a silent `nil` access.
- ~~`Kill` is a no-op~~ — **false since `ffdc879` (2026-07-15)**: `moho.lua:175`
  runs the real CheckCanBeKilled → SetDead → OnKilled chain.
- ~~`GetArmorMult` is a no-op~~ — **false since `ffdc879`**: `moho.lua:443`
  delegates to `__armorMult` (armordefinition.lua, damage.lua:56).
- Projectile blueprints never load: `loadUnitBlueprint`
  ([unitFactory.ts:50](../../src/lua/unitFactory.ts)) only knows `units/<id>/<id>_unit.bp`.
- `__bpDefaults` ([blueprints.lua:16-73](../../src/engine-lua/blueprints.lua)) has **none
  `Weapon` and no `Projectile` section**. `weapon.lua:287` calculates
  `weaponBlueprint.DamageRadius + 0` — with a `.bp` without a `DamageRadius` it cracks.
- Bone-**Transforms** fehlen. `scm.ts` liest `position`/`rotation`/`parent` je Bone
  ([scm.ts:36-43](../../src/formats/scm.ts)), but `__setBones` only puts **names** into the sim.
  Without muzzle world position, there is no starting point for a projectile.

## 8. Construction sequence (smallest honestly testable steps)

1. **Load projectile blueprints.** `/projectiles/**/*_proj.bp` into `__bpFiles`, `LoadBlueprints()`.
   *Verify:* `__registered.Projectile['/projectiles/tdfgauss01/tdfgauss01_proj.bp']` exists and
   hat `Physics.InitialSpeed == 12`, `Physics.TurnRate == 360`.
2. **Blueprint defaults** for `Projectile` (Ctor Cfile:653667-653712) and `Weapon` in
   `blueprints.lua`. *Verify:* a `.bp` without `UseGravity` delivers `true`, without `Lifetime` delivers `15`.
3. **Bone transforms into the sim.** `__setBones` expand to include rest pose (pos/quat/parent);
   Implement `GetPosition(bone)` and `GetBoneDirection(bone)`.
   *Verify:* Muzzle bone `Turret_Muzzle` of UEL0201 is at heading 0 at a known location
   Offset-Position; nach `SetHeading(π/2)` entsprechend rotiert.
4. **`moho.projectile_methods` + `__spawnProjectile`** (new file `src/engine-lua/projectiles.lua`,
   Class resolution according to §5), plus `Entity:CreateProjectile*` and `UnitWeapon:CreateProjectile`.
   *Verify:* `weapon:CreateProjectile('Turret_Muzzle')` returns an instance of `TDFGauss01`
   (not `Projectile`), `GetLauncher()` is the unit, `DamageData.DamageAmount == 24`.
5. **`__projectileTick()`** — `MotionTick` according to §3b (trapezoidal integration!), collision as
   swept route test against units (collision volume from `SizeX/Y/Z`) and terrain;
   `OnCollisionCheck` filter; `mImpactType` according to the table in §3c; `Impact()` in the following tick.
   As **Phase 5 in `beat()`**, after `motionTick`.
   *Verify:* Projektil mit `UseGravity`, `v = 25`, waagerecht abgefeuert — Position nach 5 Ticks
   analytically against the trapezoid formula; Impact on terrain delivers `OnImpact('Terrain', nil)`.
6. **`Damage` / `DamageArea` / `DamageRing`** nach damage-binary.md (`ArmorMult / (1+Handicap)`,
   no falloff), `Unit:GetArmorMult`, `Random`.
   *Verify:* `Damage(a, pos, b, 24, 'Normal')` draws 24 HP; `'Overcharge'` vs `ArmorType =
   'Commander'` zieht `24 · 0.033333`.
7. **`Entity:Kill` + `OnKilled`.** Including the `FractionComplete < 0.5 ⇒ overkill 10.0` rule.
   *Verify:* Unit at 0 HP ⇒ `OnKilled` with correct `overkillRatio`, `DeathThread` starts.
8. **Target Acquisition + Fire Cycle** (`__weaponTick`): Blip replacement = units of the enemy army in the radius
   `max(TrackingRadius·MaxRadius, MaxRadius)`, all `TargetCheckInterval·10` ticks;
   `SetTarget` ⇒ `OnGotTarget`; `mFireClock = (int)(10/RoF)` ⇒ `OnFire`.
   *Verify (the target):* **`scripts/verify-combat.ts`** — two UEL0201, Army 1 and 2, 15
   World meter distance, `beat()` in the loop. Expected: `OnFire` in the first tick after
   Target acquisition, then exactly every **10 ticks** (RoF 1); one `TDFGauss01` per shot; Flight time
   ≈ 15/25/0.1 = 6 ticks; Target loses **24 HP** per hit; after `ceil(MaxHealth/24)` hits
   `OnKilled`; Wrack-Prop mit `mass = BuildCostMass · 0.9 · (1 − overkill)`.
9. **Wreck** (`CreateProp`, `moho.prop_methods`, `/lua/sim/prop.lua`) — only when 8 is green.
10. **Later:** Shields, Beams (`CollisionBeamEntity`, 6 bindings), DoT, Nuke Rings, Flares.

## 9. Offene Fragen

- **`Projectile::CheckCollision` (@0x69D1D0) cannot be decompiled.** It remains unclear: it is used against
  the collision volume (`CollisionShape` Box/Sphere from `SizeX/Y/Z`) or against one
  Bounding radius checked? `Wm3::DistVector3Segment3f::GetSquared` sets “distance route↔point
  against radius" is close - it has not been proven. **Don't guess, but explicitly as an assumption during construction
  markieren.**
- Where does `Unit:OnCollisionCheck(other, firingWeapon)` come from with **two** arguments?
  `func_OnCollisionCheck` (Cfile:945766) only passes one; the second argument dives in
  `Unit.lua:972`. Probably a different call path (Ram collision Unit↔Unit).
- `TrackTarget` steering: `Projectile::UpdateTracking` (Cfile:944367-944680) is decompiled, but
  not yet evaluated (lead retention via `mMaxSpeed`, ZigZag). Only necessary for rockets.
- `RUnitBlueprintWeapon`-Ctor cannot be found as a separate function in the cfile; the
  Weapon blueprint defaults are currently only available via faf-re in weapons.md
  (`FiringTolerance 0.01`, `RateOfFire 1.0`, `TrackingRadius 1.0`, `TargetCheckInterval 3.0`,
  `HeadingArcRange 180`, `IgnoresAlly 1`). Binary cross-check before adopting in `blueprints.lua`.
- Blips: our sim has no recon DB. Target detection via `mBlipsInRange` (§2b) allows
  initially only replace themselves with "all units of the enemy army within the radius" - that's a conscious one
  Deviation, not a replica.
