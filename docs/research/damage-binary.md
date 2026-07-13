# Schadenssystem — direkt aus dem Binary rekonstruiert (IDA)

**Quelle:** IDA-Dekompilat von `ForgedAlliance.exe` (FAF-Build, IDB-MD5
`d27b16b5d9b1c0480dd92316b125448e`). Diese Funktionen sind in **faf-re nicht
rekonstruiert** (`EngineUnrecoveredStubs.cpp:61`: `SIM_Damage` ist ein
No-Op-Stub) — die Recherche konnte sie nur aus Lua-Kommentaren *erraten*.
Hier steht, was die Engine wirklich tut.

Adress-Verifikation (faf-re-Adressen treffen diese IDB exakt):
`0x737E60` → `SIM_Damage`, `0x518870` → `RMeshBlueprintLOD::Init`,
`0x608EF0` → `IAiCommandDispatchImpl::DispatchTask`.

## Aufrufkette

| Adresse | Funktion |
| --- | --- |
| `0x737E60` | `SIM_Damage` — Dispatcher |
| `0x737680` | `SIM_DoDamageArea` |
| `0x737140` | `SIM_DoDamagePoint` — **die Kernformel** |
| `0x736E40` | Schild-Abzug pro Ziel |
| `0x736EB0` | `SIM_DoDamage` — Schild-Vorstufe |
| `0x6A9D60` | `Unit::ProcessArmorOnDamage` |

## 1. `SIM_Damage` (Dispatcher)

```
switch (damage.mMethod):
  0 SINGLE_TARGET -> nur wenn Ziel lebt: SIM_DoDamagePoint
  1 AREA_EFFECT   -> SIM_DoDamageArea
  2 RING_EFFECT   -> DoDamageRing
```

## 2. `SIM_DoDamageArea` — **kein Distanz-Falloff (belegt)**

```
shields = SIM_DoDamage(...)          // Schilde zuerst; merkt sich Absorbiertes
entities = OGrid.ForAllEntities(Unit|Prop|Projectile|Entity, origin, radius)

for entity in entities:
    # Friendly Fire
    if !damage.mDamageFriendly and instigator and IsAlly(entity.army, instigator.army):
        continue
    # NEU: Kategorie-Immunität gegen Flächenschaden
    if entity.IsInCategory("NOSPLASHDAMAGE"):
        continue
    # Schild-Abzug (0x736E40): jedes Schild, dessen Collision-Primitive die
    # Zielposition enthält, zieht seinen absorbierten Betrag ab
    amount = damage.mAmount - Σ shield.absorbed  (für deckende Schilde)
    if amount <= 0: continue

    d = copy(damage)
    d.mAmount = amount
    d.mVector = entity.pos - damage.origin      # Richtung, NICHT für Falloff
    d.mTarget = entity
    SIM_DoDamagePoint(sim, d)
```

**Wichtig:** Es gibt **keinerlei Abstandsdämpfung**. Jede Entity im Radius
bekommt den **vollen** Betrag (abzüglich Schild). Der `mVector` ist nur die
Richtung (für Impuls/Effekte), er skaliert den Schaden nicht.

## 3. `SIM_DoDamagePoint` — die Kernformel

```
if damage.mAmount == 0: return

# Selbstschaden verhindern (Projektil -> Launcher auflösen)
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

## Korrekturen gegenüber der bisherigen Annahme

| Bisher angenommen (aus Lua-Kommentar) | **Tatsächlich (Binary)** |
| --- | --- |
| `effektiv = amount * ArmorMult * (1 - Handicap)` | `effektiv = amount * ArmorMult / (1 + Handicap)` — **Division**, nicht `(1-h)` |
| Flächenschaden ohne Falloff (vermutet) | ✅ bestätigt — voller Betrag an jede Entity im Radius |
| — | **`NOSPLASHDAMAGE`-Kategorie ist immun gegen Flächenschaden** |
| — | Selbstschaden: Projektil wird auf seinen Launcher aufgelöst |
| — | `OnExtraDamageDealt` feuert, wenn Rüstung den Schaden ≥ 2× verstärkt |
| — | Schild-Absorption wird **vor** dem Einzelschaden abgezogen (nicht danach) |

## Offen (noch aus dem Binary zu holen)
- `SIM_DoDamage` (0x736EB0) — wie genau Schilde gesammelt/getroffen werden
- `DoDamageRing` — Ring-Variante (min/max-Radius)
- Health-Abzug/Tod: passiert in Lua (`Unit.lua:OnDamage`), nicht in der Engine
