# Damage system — reconstructed directly from the binary (IDA)

**Source:** IDA decompilation from `ForgedAlliance.exe` (FAF build, IDB-MD5
`d27b16b5d9b1c0480dd92316b125448e`). These functions are not reconstructed in
**faf-re** (`EngineUnrecoveredStubs.cpp:61`: `SIM_Damage` is a no-op stub), so
research could only *guess* their behavior from Lua comments. Here is what the
engine actually does.

Address verification (faf-re addresses exactly match this IDB):
`0x737E60` → `SIM_Damage`, `0x518870` → `RMeshBlueprintLOD::Init`,
`0x608EF0` → `IAiCommandDispatchImpl::DispatchTask`.

## Call chain

| Address | Function |
| --- | --- |
| `0x737E60` | `SIM_Damage` — dispatcher |
| `0x737680` | `SIM_DoDamageArea` |
| `0x737140` | `SIM_DoDamagePoint` — **the core formula** |
| `0x736E40` | shield deduction per target |
| `0x736EB0` | `SIM_DoDamage` — shield preprocessing |
| `0x6A9D60` | `Unit::ProcessArmorOnDamage` |

## 1. `SIM_Damage` (Dispatcher)

```
switch (damage.mMethod):
  0 SINGLE_TARGET -> only if the target is alive: SIM_DoDamagePoint
  1 AREA_EFFECT   -> SIM_DoDamageArea
  2 RING_EFFECT   -> DoDamageRing
```

## 2. `SIM_DoDamageArea` — **no distance falloff (verified)**

```
shields = SIM_DoDamage(...)          // shields first; records absorbed amounts
entities = OGrid.ForAllEntities(Unit|Prop|Projectile|Entity, origin, radius)

for entity in entities:
    # Friendly Fire
    if !damage.mDamageFriendly and instigator and IsAlly(entity.army, instigator.army):
        continue
    # Category immunity to area damage
    if entity.IsInCategory("NOSPLASHDAMAGE"):
        continue
    # Shield deduction (0x736E40): for every shield whose collision primitive
    # contains the target position, subtract its absorbed amount
    amount = damage.mAmount - Σ shield.absorbed (for covering shields)
    if amount <= 0: continue

    d = copy(damage)
    d.mAmount = amount
    d.mVector = entity.pos - damage.origin # direction, NOT for falloff
    d.mTarget = entity
    SIM_DoDamagePoint(sim, d)
```

**Important:** There is **no distance attenuation**. Any entity in the radius
gets the **full** amount (minus shields). The `mVector` is only a direction
(for momentum/effects); it does not scale damage.

## 3. `SIM_DoDamagePoint` — the core formula

```
if damage.mAmount == 0: return

# Prevent self-damage (projectile -> resolve launcher)
if !damage.mDamageSelf:
    inst = damage.mInstigator
    if inst is Projectile: inst = inst.launcher
    if inst == target: return

if target is Unit:
    armored  = Unit::ProcessArmorOnDamage(target, damage.mAmount, damage.mType)
    handicap = target.army.mHasHandicap ? target.army.mHandicap : 0.0
    amount   = armored / (1.0 + handicap)          # ← DIVISION!
    ratio    = amount / damage.mAmount

    if amount > 0 and instigator has army:
        target:OnDamageBy(instigatorArmyIndex + 1)     # Lua
    if ratio >= 2.0:
        target:OnExtraDamageDealt(damage.mType)        # Lua
else:
    amount = damage.mAmount

# Statistics: DamageStats_TotalDamageDealt / _TotalDamageReceived,
#            Units_TotalDamageDealt / Units_TotalDamageReceive

if amount > 0:
    target:OnDamage(instigator, amount, vector, type)  # Lua -> health reduction
```

### `Unit::ProcessArmorOnDamage` (0x6A9D60)

```
if damageType in unit.mArmor (map<string,float>):
    return amount * unit.mArmor[damageType]
return amount                     # no entry = factor 1.0
```

## Corrections compared to the previous assumption

| Previously assumed (from Lua comments) | **Actually (binary)** |
| --- | --- |
| `effektiv = amount * ArmorMult * (1 - Handicap)` | `effektiv = amount * ArmorMult / (1 + Handicap)` — **Division**, not `(1-h)` |
| Area damage without falloff (assumed) | ✅ confirmed — full amount to every entity in the radius |
| — | **`NOSPLASHDAMAGE` category is immune to area damage** |
| — | Self-damage: projectile resolves to its launcher |
| — | `OnExtraDamageDealt` fires when armor amplifies damage by ≥ 2× |
| — | Shield absorption is deducted **before** single-target damage (not after) |

## Open (still to be extracted from the binary)
- `SIM_DoDamage` (0x736EB0) — exactly how shields are collected and hit
- `DoDamageRing` — ring variant (minimum/maximum radius)
- Health reduction/death: happens in Lua (`Unit.lua:OnDamage`), not in the engine
