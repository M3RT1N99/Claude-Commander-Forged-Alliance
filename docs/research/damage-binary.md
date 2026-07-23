# Damage system — reconstructed directly from the binary (IDA)

**Source:** IDA decompilation from `ForgedAlliance.exe` (FAF build, IDB-MD5
`d27b16b5d9b1c0480dd92316b125448e`). These functions are not available in **faf-re
reconstructed** (`EngineUnrecoveredStubs.cpp:61`: `SIM_Damage` is a
No-Op-Stub) — research could only *guess* it from Lua comments.
Here's what the engine actually does.

Address verification (faf-re addresses exactly match this IDB):
`0x737E60` → `SIM_Damage`, `0x518870` → `RMeshBlueprintLOD::Init`,
`0x608EF0` → `IAiCommandDispatchImpl::DispatchTask`.

## Aufrufkette

| Address | Function |
| --- | --- |
| `0x737E60` | `SIM_Damage` — Dispatcher |
| `0x737680` | `SIM_DoDamageArea` |
| `0x737140` | `SIM_DoDamagePoint` — **the core formula** |
| `0x736E40` | Shield penalty per target |
| `0x736EB0` | `SIM_DoDamage` — Schild-Vorstufe |
| `0x6A9D60` | `Unit::ProcessArmorOnDamage` |

## 1. `SIM_Damage` (Dispatcher)

```
switch (damage.mMethod):
  0 SINGLE_TARGET -> nur wenn Ziel lebt: SIM_DoDamagePoint
  1 AREA_EFFECT   -> SIM_DoDamageArea
  2 RING_EFFECT   -> DoDamageRing
```

## 2. `SIM_DoDamageArea` — **no distance falloff (occupied)**

```
shields = SIM_DoDamage(...)          // Schilde zuerst; merkt sich Absorbiertes
entities = OGrid.ForAllEntities(Unit|Prop|Projectile|Entity, origin, radius)

for entity in entities:
    # Friendly Fire
    if !damage.mDamageFriendly and instigator and IsAlly(entity.army, instigator.army):
        continue
# NEW: Category immunity to area damage
    if entity.IsInCategory("NOSPLASHDAMAGE"):
        continue
    # Schild-Abzug (0x736E40): jedes Schild, dessen Collision-Primitive die
# Contains target position, subtracts its absorbed amount
amount = damage.mAmount - Σ shield.absorbed (for covering shields)
    if amount <= 0: continue

    d = copy(damage)
    d.mAmount = amount
d.mVector = entity.pos - damage.origin # Direction, NOT for falloff
    d.mTarget = entity
    SIM_DoDamagePoint(sim, d)
```

**Important:** There is **no distance attenuation**. Any entity in the radius
gets the **full** amount (minus the sign). The `mVector` is just that
Direction (for momentum/effects), it doesn't scale damage.

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

# Statistik: DamageStats_TotalDamageDealt / _TotalDamageReceived,
#            Units_TotalDamageDealt / Units_TotalDamageReceive

if amount > 0:
    target:OnDamage(instigator, amount, vector, type)  # Lua -> Health-Abzug
```

### `Unit::ProcessArmorOnDamage` (0x6A9D60)

```
if damageType in unit.mArmor (map<string,float>):
    return amount * unit.mArmor[damageType]
return amount                     # kein Eintrag = Faktor 1.0
```

## Corrections compared to the previous assumption

| Adopted so far (from Lua comment) | **Actually (Binary)** |
| --- | --- |
| `effektiv = amount * ArmorMult * (1 - Handicap)` | `effektiv = amount * ArmorMult / (1 + Handicap)` — **Division**, not `(1-h)` |
| Area damage without falloff (assumed) | ✅ confirmed — full amount to every entity in radius |
| — | **`NOSPLASHDAMAGE` category is immune to area damage** |
| — | Self-Damage: Projectile dissipates onto its launcher |
| — | `OnExtraDamageDealt` fires when armor increases damage ≥ 2× |
| — | Shield absorption is deducted **before** the single damage (not after) |

## Open (still to be removed from the binary)
- `SIM_DoDamage` (0x736EB0) — how exactly shields are collected/hit
- `DoDamageRing` — Ring-Variante (min/max-Radius)
- Health penalty/death: happens in Lua (`Unit.lua:OnDamage`), not in the engine
