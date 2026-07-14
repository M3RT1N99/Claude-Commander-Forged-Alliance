# Kampf 1:1 — Projektile, Schaden, Tod, Wracks

**Baut auf** [weapons.md](weapons.md) (Feuertakt, Salven-FSM, Aiming, Blueprint-Felder) und
[damage-binary.md](damage-binary.md) (`SIM_Damage`-Kette) auf. Was dort steht, wird hier
**nicht wiederholt** — nur korrigiert, ergänzt und in eine Bau-Reihenfolge gebracht.
Neu ist alles, was hier aus der IDA-Decomp (`Cfile/ForgedAlliance.exe.c`) kommt: weapons.md
stammte aus faf-re, mehrere Details waren dort ungenau oder fehlten.

## 1. Überblick — wer macht was

| Schritt | Ort | Was |
|---|---|---|
| Ziel finden | **Engine** | `CAcquireTargetTask::TaskTick` scannt Blips, ruft `UnitWeapon::SetTarget` |
| Zielen | **Engine** | `CAimManipulator` dreht Turm, setzt `mCanFire` |
| Feuern-Entscheidung | **Engine** | `CFireWeaponTask::Dispatch` — Feuertakt, Gates, dann `RunScript("OnFire")` |
| Salve, Mündung, Schuss | **Lua** | `defaultweapons.lua` FSM → `weapon:CreateProjectile(bone)` |
| Projektil erzeugen | **Engine** | `UnitWeapon::CreateProjectile` → `PROJ_Create` → Lua-`OnCreate` |
| Flugbahn | **Engine** | `Projectile::MotionTick` (10 Hz) |
| Treffer erkennen | **Engine** | `Projectile::CheckCollision` → Lua-Filter → `RunScript("OnImpact")` |
| Schaden anrichten | **Lua** | `Projectile:OnImpact` → `DoDamage` → `Damage`/`DamageArea` |
| Schaden verrechnen | **Engine** | `SIM_Damage` → Rüstung/Handicap → `RunScript("OnDamage")` |
| Sterben | **Lua** | `Unit:OnDamage` → `DoTakeDamage` → `self:Kill(...)` |
| Tod auslösen | **Engine** | `Unit::Kill` → `RunScript("OnKilled")` |
| Explosion, Wrack | **Lua** | `Unit:DeathThread` → `CreateWreckage` → `CreateProp` |

Die Lua entscheidet **nichts** über Treffer und Flugbahn — sie bekommt sie mitgeteilt.
Umgekehrt entscheidet die Engine **nichts** über Schadensmenge und Wrackwert.

## 2. Der Feuerzyklus, binär belegt

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
dann `RunScript("OnFire")` + `++mShotsAtTarget`. **Sonst nichts** — kein Projektil.

Das Sentinel-Muster ist binär bestätigt: der `CWeaponAttributes`-Ctor setzt
`mRateOfFire = -1`, `mMaxRadius = -1`, `mDamageRadius = -1`, `mFiringTolerance = -1`
(Cfile:983289-983304) ⇒ **negativ heißt „nimm den Blueprint-Wert"**.

### 2b. Zielerfassung — `CAcquireTargetTask::TaskTick` (@0x5D8D10, Cfile:792838ff)

- Prüfintervall: `TargetCheckInterval * 10` Ticks (Cfile:792841).
- Suchradius: `max(TrackingRadius · MaxRadius, MaxRadius)` (Cfile:793146-793156)
  — **ein Maximum**, nicht bloß das Produkt: `TrackingRadius < 1` verkleinert nichts.
- Kandidaten sind die **Blips** der Unit (`unit->mBlipsInRange` bzw. `GetBlipsInRange`,
  Cfile:793167-793169) — Zielerfassung läuft über die Aufklärungs-DB, nicht über rohe Entities.
- `FindBestEnemy(weapon, blips, radius, turreted||slavedToBody)` → `UnitWeapon::SetTarget`.

`UnitWeapon::SetTarget` (Cfile:985364-985494): Zielwechsel ⇒ `RunScript("OnLostTarget")` /
`RunScript("OnGotTarget")` auf der **Waffe**, `mShotsAtTarget = 0`, und der FireWeaponTask
wird aus dem Wartestapel geholt (feuert also im nächsten Tick).

### 2c. Lua-Kette bis zum Schuss

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

Neu gegenüber weapons.md:

- **Kein `ProjectileId` ⇒ kein Fehler:** `gpg::Logf("%s:%s:CreateProjectile: no projectile
  blueprint, doing instahit instead.")` und `DoInstaHit(bone, 0.1, 1.0, ...)` (Cfile:985658-985675).
  Die Funktion gibt dann `nil` zurück — `CreateProjectileAtMuzzle` prüft genau darauf.
- Startorientierung: `StraightDownOrdinance` ⇒ `(0,-1,0)`; sonst
  `UseFiringSolutionInsteadOfAimBone` ⇒ `normalize(mAimingAt)`; sonst der Mündungsknochen.
- `mFiringRandomness > 0` ⇒ zwei `FRandGaussian()` · Randomness · `DEG2RAD` auf Heading/Pitch.
- `PROJ_Create(bp, transform, sim, army, launcher, damage, damageRadius, damageType, target, IgnoresAlly)`
  — `damage`/`damageRadius` aus `mAttributes` (bzw. Blueprint bei < 0).
- `MuzzleVelocity != 0` ⇒ Betrag der Geschwindigkeit wird überschrieben; die Distanz für
  `GetMuzzleVelocity` ist die **3D**-Distanz Mündung→`CAiTarget::GetTargetPosGun`.
- Lebensdauer in **Ticks**: `mLifetimeEnd = curTick + (int)(ProjectileLifetime · 10)`, bzw.
  `(int)((MaxRadius / MuzzleVelocity) · ProjectileLifetimeUsesMultiplier · 10)`.
- `ReTargetOnMiss` ⇒ `TransmitProjectileImpactEvent`.

## 3. Projektil-Lifecycle

### 3a. Ctor (`Moho::Projectile::Projectile`, Cfile:943313-944010)

1. `mVelocity = 0`; `TurnRate`/`MaxSpeed`/`Acceleration` je mit **±Range**-Gleichverteilung.
2. **`mBallisticAcc = sim->mPhysConstants->mGravity · UseGravity`** (Cfile:943663-943668) —
   `UseGravity` ist ein bool (0/1), das die Gravitation schlicht **ausschaltet**.
3. `mLifetimeEnd = curTick + (int)((Lifetime ± LifeTimeRange) · 10)`.
4. `RunScript("OnPreCreate")`.
5. Geschwindigkeit: `RealisticOrdinance` ⇒ `velocity = launcher:GetVelocity() · 10`;
   **sonst** `velocity = forward(launchOrient) · GetRandomInitialSpeed(bp)` (Cfile:943842-943854).
6. Layer `Air`/`Water` setzen (+ `OnLayerChange`), `SetMesh`.
7. `belowWater && DestroyOnWater` ⇒ sofort `Destroy()`, **sonst**
   `RunScript("OnCreate", inWater)` (Cfile:943988) — das `inWater`-Argument, das
   `TDFGauss01_script.lua:OnCreate(self, inWater)` erwartet.

**Blueprint-Defaults (binär, `RProjectileBlueprintPhysics`-Ctor, Cfile:653667-653712):**
`Lifetime 15`, `InitialSpeed 1`, `MaxSpeed 0`, `Acceleration 0`, `TurnRate 0`,
`CollideSurface 1`, `CollisionEntity 1`, `TrackTarget 0`, `VelocityAlign 1`, `StayUpright 0`,
`LeadTarget 1`, `StayUnderwater 0`, **`UseGravity 1`**, `DirectionY 1`, `DirectionXRange/ZRange 1.5`,
`DestroyOnWater 0`, `BounceVelDamp 0.5`, `MinBounceCount/MaxBounceCount 0`,
`RealisticOrdinance 0`, `StraightDownOrdinance 0`. Ausserdem `Economy.BuildTime = 10`,
`CollisionShape = None` (Cfile:653736-653741).

**Das Projektil-Blueprint hat KEINE `Defense`-Sektion** (`RProjectileBlueprintTypeInfo::AddFields`,
Cfile:654222-654240: nur `DevStatus`, `Display`, `Economy`, `Physics` über der
`REntityBlueprint`-Basis). `Projectile.lua:75` liest trotzdem `bp.Defense.MaxHealth or 1` —
das funktioniert **nur** dank der LuaPlus-`nil`-Metatable (`nil.MaxHealth` → `nil`), die wir
in [boot.lua](../../src/engine-lua/boot.lua) schon herstellen. Ohne sie stirbt jedes Projektil
in seinem eigenen `OnCreate`.

### 3b. `Projectile::MotionTick` (Cfile:944040-944290) — pro Tick, dt = 0.1

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
1. Die Integration ist **trapezförmig**: `pos += 0.5·(v_alt + v_neu)·0.1`. Naives Euler
   (`pos += v·0.1`) verschiebt jede Flugbahn.
2. `TurnRate` (Grad/s) tut bei `TrackTarget = false` **nicht nichts**: es begrenzt, wie schnell
   sich die Mesh-Orientierung an die Geschwindigkeit anpasst (`mTurnRateDeg · 0.0017453292`
   = deg·DEG2RAD·0.1 rad/Tick). Darum hat TDFGauss01 `TurnRate = 360`, obwohl es ungelenkt ist.

### 3c. `Projectile::CheckCollision` (@0x69D1D0) — **nicht dekompilierbar**

IDA scheitert an dieser Funktion (0xC9A Bytes), sie steht deshalb **nicht** im Cfile — genau wie
`SIM_Damage` in faf-re ein Stub war. Rekonstruierbar ist sie nur über ihre Aufrufliste
(`get_callees` @0x69d1d0):

`COGrid::GetEntityCollisionsInLine`, `Wm3::DistVector3Segment3f::GetSquared`,
`COGrid::ForAllEntitiesIterator`, `CHeightField::Intersection` + `GetElevation`,
`CColHitResult::PlaneIntersection`, `ENT_GetImpactType`, **`func_OnCollisionCheck`**,
`IArmy::IsEnemy`, `CAiTarget::GetEntity`, `Entity::SetCurrentLayer`, `CScriptObject::RunScript`.

Daraus folgt gesichert: es ist ein **gesweepter Strecken-Test** (letzte Position → neue Position),
nicht ein Punkttest; Terrain kommt aus dem Heightfield, Wasser aus einer Ebenen-Schnittrechnung;
der Lua-Filter ist `self:OnCollisionCheck(other)` mit **einem** Argument
(`func_OnCollisionCheck`, Cfile:945766-945830 — `Call_ObjScrobj_Bool`).

`ENT_GetImpactType(pos, entity, sim)` (@0x67B240, per IDA dekompiliert):

| | über Wasser | unter Wasser |
|---|---|---|
| keine Entity | `Air` | `Underwater` |
| Unit | `Unit`, im Air-Layer `UnitAir` | `UnitUnderwater` |
| Projectile | `Projectile` | `ProjectileUnderwater` |
| Prop | `Prop` | `Underwater` |
| Schild (`id & 0xF0000000 == 0x40000000`) | `Shield` | `Shield` |

`Terrain` und `Water` erzeugt diese Funktion **nicht** — die kommen aus dem Heightfield-/
Wasserebenen-Zweig von `CheckCollision`.

`EImpactType` (Cfile:640486-640525): `Invalid 0, Terrain 1, Water 2, Air 3, Underwater 4,
Projectile 5, ProjectileUnderwater 6, Prop 7, Shield 8, Unit 9, UnitAir 10, UnitUnderwater 11`.
Strings: `ENT_GetImpactTypeString` (Cfile:917363-917400) — exakt die Namen, die
`Projectile.lua:310-345` abfragt.

### 3d. `Projectile::Impact` (Cfile:944692-944745)

`RunScript_StrObj("OnImpact", ImpactTypeString, targetEntity)` — **zwei** Argumente. Danach
Statistik (`_Shots_Hit` / `_Shots_Missed` über `CAiTarget::ImpactDidHitEntity`).

Lua-Seite: `Projectile:OnImpact` (Projectile.lua:259-356) → `DoDamage` (173-192) → `DoMetaImpact`
→ `DoUnitImpactBuffs` → Sound `Audio['Impact'..targetType]` (Fallback `Audio.Impact`) → FX →
`ImpactTimeout` bei `Terrain`, sonst `OnImpactDestroy` (358-363).

## 4. Schaden und Tod

`Damage(instigator, origin, target, amount, type)` — **5 Argumente** (der Hilfetext
`"Damage(instigator, target, amount, damageType)"` ist veraltet; `cfunc_DamageL` prüft
`lua_gettop != 5`, Cfile:1064215). `mVector = target.pos − origin`; `amount == 0` ⇒ **Lua-Fehler**.
Rest der Kette: siehe [damage-binary.md](damage-binary.md) (`SIM_Damage` @0x737E60,
`effektiv = amount · ArmorMult / (1 + Handicap)`, kein Distanz-Falloff, `NOSPLASHDAMAGE`).

Lua-Seite: `Unit:OnDamage` (unit.lua:787-792) feuert nur, wenn **`self.CanTakeDamage`** gesetzt
ist — das passiert in `unit.lua:190` (`self:SetCanTakeDamage(true)`), und `SetCanTakeDamage` ist
in unit.lua:779 als **Lua**-Methode überschrieben. → `DoTakeDamage` (794-818) → `self:Kill(...)`.

**`Unit::Kill(instigator, type, overkillRatio)` (Cfile:951962-952180) ist Engine:**
`RunScript("SetDead")` → `Entity::Kill` (setzt `mIsDead`, Cfile:916064-916086) → Command-Queue
leeren → `RunScript_UnitOnKilled(instigator, type, overkillRatio)`. Und ein Detail, das man nicht
erfinden kann: **ist die Unit im Bau und `FractionComplete < 0.5`, wird `overkillRatio` auf `10.0`
gesetzt** (Cfile:952126-952127) ⇒ eine halbfertige Baustelle hinterlässt nie ein Wrack.

`Entity::Destroy` (Cfile:916089-916115) ist **aufgeschoben**: die Entity landet in
`sim->mDeletionQueue`; `RunScript("OnDestroy")` läuft erst beim echten Löschen
(`Entity::OnDestroy`, Cfile:916143).

Tod/Wrack in Lua: `Unit:OnKilled` (896-943) → `DeathThread` (1200-1242) → `CreateWreckage`
(1076-1146) — Formeln stehen vollständig in weapons.md §5.

## 5. Welche Lua-Klasse bekommt ein Projektil?

`func_FindBlueprintScriptModule` (Cfile:914189-914360) — gilt für Unit, Projectile **und** Prop:

1. Blueprint-Typ ⇒ Default: `RUnitBlueprint` → `/lua/sim/unit.lua` / `"Unit"`,
   `RProjectileBlueprint` → `/lua/sim/projectile.lua` / `"Projectile"`,
   `RPropBlueprint` → `/lua/sim/prop.lua` / `"Prop"`.
2. `ScriptModule` = `bp.ScriptModule`, oder falls leer: `bp.Source` bis zum **letzten** `_`
   abschneiden und `_script.lua` anhängen.
   `/projectiles/TDFGauss01/TDFGauss01_proj.bp` → `/projectiles/TDFGauss01/TDFGauss01_script.lua`.
3. Klassenname = `bp.ScriptClass`, sonst **`"TypeClass"`**.
4. Existiert die Datei nicht ⇒ Default aus (1).

Die Blueprint-ID eines Projektils ist der **volle kleingeschriebene Pfad mit `.bp`**
(`SetBackwardsCompatId`, blueprints.lua:104-107) — genau der String in `Weapon.ProjectileId`.
`ProjectileBlueprint(bp)` → `StoreBlueprint('Projectile', bp)` → `RegisterProjectileBlueprint`
(blueprints.lua:259-262, 313) — die Pipeline steht also schon, es fehlt nur, dass
`/projectiles/**/*_proj.bp` überhaupt in `__bpFiles` landet.

## 6. Fehlende Engine-Bindungen (≈65)

| Name | Semantik (Beleg) | Wer braucht es |
|---|---|---|
| **`moho.projectile_methods`** (30) | `SetVelocity`, `SetBallisticAcceleration`, `SetLifetime`, `SetTurnRate`, `TrackTarget`, `SetDamage`, `GetLauncher`, `CreateChildProjectile`, `SetCollideSurface/Entity`, … (engine-api.md, Klasse `Projectile`) | `Projectile.lua`, jedes `*_script.lua` |
| `Entity:CreateProjectile(bp,[o],[d])` | Cfile:930705ff — Richtung aus `RandomDirection(bp)`, Speed = `InitialSpeed ± Range`, Damage 0, Typ `'Normal'` | `defaultexplosions.lua` (Debris) |
| `Entity:CreateProjectileAtBone(bp,bone)` | Cfile:930934ff, wie oben aber am Knochen | Effekte |
| `UnitWeapon:CreateProjectile(muzzle)` | Cfile:985613 — **der** Schuss | `weapon.lua:322` |
| `UnitWeapon:SetTargetEntity/SetTargetGround/ResetTarget` | Cfile:986717/986800/986905 | `Unit:SetTarget`, Kommandos |
| `UnitWeapon:GetCurrentTargetPos` | Cfile:987621 | `defaultweapons.lua:114` |
| `UnitWeapon:FireWeapon()` | Cfile:987369 — manuelles Feuern | `DoDeathWeapon` (`FireOnDeath`) |
| `UnitWeapon:GetFireClockPct` | Cfile:988512-988531: `1 − mFireClock / (10/RoF)` | `RenderFireClock` |
| `UnitWeapon:DoInstaHit` | Cfile:987034 — Fallback ohne ProjectileId | Engine-intern |
| `Entity:Kill(instigator,type,overkill)` | Cfile:951962 (**heute No-Op!**) | `unit.lua:812` |
| `Entity:SetCollisionShape(shape,cx,cy,cz,size)` | Cfile:934167 | `unit.lua`, `Prop` |
| `Entity:GetPosition([bone])` | Cfile:934579 — **Bone-Argument fehlt uns** | `CollisionBeam:GetPosition(1)` |
| `Entity:GetBoneDirection(name)` | Cfile:931458 | Waffen, Effekte |
| `Unit:GetArmorMult(type)` / `AlterArmor` | Cfile:972450 / 972372 | `shield.lua:101`, Schadensformel |
| `Unit:GetAttacker`, `SetBusy`, `IsUnitState('Busy')` | Salven-Interlock | `defaultweapons.lua:526` |
| `moho.prop_methods.AddBoundedProp` | engine-api.md, Klasse `Prop` | `unit.lua:1112` |
| **Globals:** `Damage`, `DamageArea`, `DamageRing`, `MetaImpact` | Cfile:1064181/1064294/1064409/1064536 | `Projectile:DoDamage`, `DefaultDamage.lua` |
| `CreateProp`, `CreatePropHPR`, `SplitProp`, `TryCopyPose` | Cfile:1015366ff | `CreateWreckageProp` |
| `Random([min,]max)` | Cfile:758FB0 — 0 Args = float [0,1) | `GetRandomFloat` ⇒ **`DeathThread` stirbt sofort ohne** |
| `IsProjectile`, `IsProp`, `IsCollisionBeam` | Cfile:1091691ff | Kollisionsfilter |
| `GetEntityById`, `GetUnitById`, `GetEntitiesInRect`, `GetUnitsInRect` | Ziel-/Flächensuche | Zielerfassung, `DamageArea` |
| `ArmyGetHandicap`, `OkayToMessWithArmy` | Schadensformel | `shield.lua:102` |

**Falsch, nicht nur fehlend:** `IsAlly(a,b)` / `IsEnemy(a,b)` in
[globals.lua:42-43](../../src/engine-lua/globals.lua) vergleichen bloss Armee-Indizes
(`a == b`). Ohne echte Allianz-Tabelle ist jeder Kollisions- und Friendly-Fire-Filter geraten.

## 7. Ist-Stand unserer Engine

**Da:** die Waffen-Objekte selbst ([units.lua:54-88](../../src/engine-lua/units.lua)) — pro
`bp.Weapon`-Eintrag eine Instanz der Original-Klasse, mit `OnCreate` ⇒ die Zustandsmaschine aus
`defaultweapons.lua` läuft. Skelett-Namen (`__setBones`), `class.lua`, Blueprint-Pipeline,
Ökonomie, Threads.

**Fehlt komplett:**
- **Niemand gibt einer Waffe je ein Ziel.** Kein `SetTarget`, kein `OnGotTarget`, kein `OnFire`
  im ganzen Baum (`grep -rn "OnFire\|__target" src/` findet nichts ausserhalb von moho.lua).
  Die FSM steht seit dem ersten Tick im `IdleState`.
- **Kein Feuertakt.** `beat()` ([engine.ts:91-108](../../src/lua/engine.ts)) hat sechs Phasen —
  keine davon ist eine Waffen- oder Projektil-Phase.
- **`moho.projectile_methods` existiert nicht** → der Auto-Vivifier in
  [moho.lua:530-536](../../src/engine-lua/moho.lua) liefert eine **leere Klasse**. `Projectile.lua`
  lädt also, und jeder Methodenaufruf ist ein stiller `nil`-Zugriff.
- **`Kill` ist ein No-Op** (ENTITY_NAMES in moho.lua:53). `DoTakeDamage` ruft es — nichts stirbt.
- **`GetArmorMult` ist ein No-Op** (UNIT_NAMES, moho.lua:138) → liefert `nil` → `shield.lua:101`
  rechnet `amount * nil`.
- Projektil-Blueprints werden nie geladen: `loadUnitBlueprint`
  ([unitFactory.ts:50](../../src/lua/unitFactory.ts)) kennt nur `units/<id>/<id>_unit.bp`.
- `__bpDefaults` ([blueprints.lua:16-73](../../src/engine-lua/blueprints.lua)) hat **keine
  `Weapon`- und keine `Projectile`-Sektion**. `weapon.lua:287` rechnet
  `weaponBlueprint.DamageRadius + 0` — bei einem `.bp` ohne `DamageRadius` knallt das.
- Bone-**Transforms** fehlen. `scm.ts` liest `position`/`rotation`/`parent` je Bone
  ([scm.ts:36-43](../../src/formats/scm.ts)), aber `__setBones` gibt nur **Namen** in die Sim.
  Ohne Mündungs-Weltposition gibt es keinen Startpunkt für ein Projektil.

## 8. Bau-Reihenfolge (kleinste ehrlich testbare Schritte)

1. **Projektil-Blueprints laden.** `/projectiles/**/*_proj.bp` in `__bpFiles`, `LoadBlueprints()`.
   *Verify:* `__registered.Projectile['/projectiles/tdfgauss01/tdfgauss01_proj.bp']` existiert und
   hat `Physics.InitialSpeed == 12`, `Physics.TurnRate == 360`.
2. **Blueprint-Defaults** für `Projectile` (Ctor Cfile:653667-653712) und `Weapon` in
   `blueprints.lua`. *Verify:* ein `.bp` ohne `UseGravity` liefert `true`, ohne `Lifetime` liefert `15`.
3. **Bone-Transforms in die Sim.** `__setBones` um Rest-Pose (pos/quat/parent) erweitern;
   `GetPosition(bone)` und `GetBoneDirection(bone)` implementieren.
   *Verify:* Mündungsknochen `Turret_Muzzle` von UEL0201 liegt bei Heading 0 an einer bekannten
   Offset-Position; nach `SetHeading(π/2)` entsprechend rotiert.
4. **`moho.projectile_methods` + `__spawnProjectile`** (neue Datei `src/engine-lua/projectiles.lua`,
   Klassenauflösung nach §5), plus `Entity:CreateProjectile*` und `UnitWeapon:CreateProjectile`.
   *Verify:* `weapon:CreateProjectile('Turret_Muzzle')` liefert eine Instanz von `TDFGauss01`
   (nicht `Projectile`), `GetLauncher()` ist die Unit, `DamageData.DamageAmount == 24`.
5. **`__projectileTick()`** — `MotionTick` nach §3b (Trapez-Integration!), Kollision als
   gesweepter Strecken-Test gegen Units (Kollisionsvolumen aus `SizeX/Y/Z`) und Terrain;
   `OnCollisionCheck`-Filter; `mImpactType` nach der Tabelle in §3c; `Impact()` im Folgetick.
   Als **Phase 5 in `beat()`**, nach `motionTick`.
   *Verify:* Projektil mit `UseGravity`, `v = 25`, waagerecht abgefeuert — Position nach 5 Ticks
   analytisch gegen die Trapez-Formel; Aufschlag auf Terrain liefert `OnImpact('Terrain', nil)`.
6. **`Damage` / `DamageArea` / `DamageRing`** nach damage-binary.md (`ArmorMult / (1+Handicap)`,
   kein Falloff), `Unit:GetArmorMult`, `Random`.
   *Verify:* `Damage(a, pos, b, 24, 'Normal')` zieht 24 HP; `'Overcharge'` gegen `ArmorType =
   'Commander'` zieht `24 · 0.033333`.
7. **`Entity:Kill` + `OnKilled`.** Inklusive der `FractionComplete < 0.5 ⇒ overkill 10.0`-Regel.
   *Verify:* Unit auf 0 HP ⇒ `OnKilled` mit korrektem `overkillRatio`, `DeathThread` läuft an.
8. **Zielerfassung + Feuertakt** (`__weaponTick`): Blip-Ersatz = Units der Feind-Armee im Radius
   `max(TrackingRadius·MaxRadius, MaxRadius)`, alle `TargetCheckInterval·10` Ticks;
   `SetTarget` ⇒ `OnGotTarget`; `mFireClock = (int)(10/RoF)` ⇒ `OnFire`.
   *Verify (die Zielmarke):* **`scripts/verify-combat.ts`** — zwei UEL0201, Armee 1 und 2, 15
   Weltmeter Abstand, `beat()` in der Schleife. Erwartet: `OnFire` im ersten Tick nach
   Zielerfassung, danach exakt alle **10 Ticks** (RoF 1); je Schuss ein `TDFGauss01`; Flugzeit
   ≈ 15/25/0.1 = 6 Ticks; Ziel verliert **24 HP** pro Treffer; nach `ceil(MaxHealth/24)` Treffern
   `OnKilled`; Wrack-Prop mit `mass = BuildCostMass · 0.9 · (1 − overkill)`.
9. **Wrack** (`CreateProp`, `moho.prop_methods`, `/lua/sim/prop.lua`) — erst wenn 8 grün ist.
10. **Später:** Schilde, Beams (`CollisionBeamEntity`, 6 Bindungen), DoT, Nuke-Ringe, Flares.

## 9. Offene Fragen

- **`Projectile::CheckCollision` (@0x69D1D0) ist nicht dekompilierbar.** Unklar bleibt: Wird gegen
  das Kollisionsvolumen (`CollisionShape` Box/Sphere aus `SizeX/Y/Z`) oder gegen einen
  Bounding-Radius geprüft? `Wm3::DistVector3Segment3f::GetSquared` legt „Abstand Strecke↔Punkt
  gegen Radius" nahe — belegt ist es nicht. **Nicht raten, sondern beim Bau explizit als Annahme
  markieren.**
- Wo kommt `Unit:OnCollisionCheck(other, firingWeapon)` mit **zwei** Argumenten her?
  `func_OnCollisionCheck` (Cfile:945766) übergibt nur eines; das zweite Argument taucht in
  `Unit.lua:972` auf. Vermutlich ein anderer Aufrufpfad (Ram-Kollision Unit↔Unit).
- `TrackTarget`-Lenkung: `Projectile::UpdateTracking` (Cfile:944367-944680) ist dekompiliert, aber
  noch nicht ausgewertet (Lead-Vorhalt über `mMaxSpeed`, ZigZag). Nötig erst für Raketen.
- `RUnitBlueprintWeapon`-Ctor ist im Cfile nicht als eigene Funktion auffindbar; die
  Weapon-Blueprint-Defaults stehen bisher nur über faf-re in weapons.md
  (`FiringTolerance 0.01`, `RateOfFire 1.0`, `TrackingRadius 1.0`, `TargetCheckInterval 3.0`,
  `HeadingArcRange 180`, `IgnoresAlly 1`). Vor der Übernahme in `blueprints.lua` binär gegenprüfen.
- Blips: unsere Sim hat keine Aufklärungs-DB. Die Zielerfassung über `mBlipsInRange` (§2b) lässt
  sich vorerst nur durch „alle Units der Feind-Armee im Radius" ersetzen — das ist eine bewusste
  Abweichung, kein Nachbau.
