# Bau-Task-Ablauf — aus Binary + faf-re

Quellen: `CBuildTaskHelper::UpdateWorkProgress` (faf-re rekonstruiert,
0x5F5BF0) + `ComputeBuildProgressDelta` (faf-re) + `Unit::Materialize`
(IDA @ 0x6A9F40, in faf-re als Lücke markiert). Als Spezifikation destilliert.

Jeder Bauhelfer (Ingenieur/Fabrik/ACU beim Bauen, Assist, Reclaim, Repair)
hält einen `CBuildTaskHelper` mit `mFocus` (das Bauobjekt), `mFractionComplete`,
`mActionName`. Pro Tick ruft der Task `UpdateWorkProgress()`; Rückgabe `true`
= Task fertig.

## Bau-Fortschritt pro Tick (Kernformel)

```
resourceConsumed = builder.ResourceConsumed   # = LimitingRate (0..1) aus der Econ-Verteilung
timeToBuild      = focus.BuildTime / builder.buildRate     # Sekunden bei voller Versorgung
delta            = (1 / timeToBuild) * resourceConsumed * 0.1
                 = (builder.buildRate / focus.BuildTime) * resourceConsumed * 0.1
```
`0.1` = Sekunden pro Tick (10 Hz). Bei voller Versorgung (`resourceConsumed=1`)
dauert der Bau also exakt `BuildTime / buildRate` Sekunden. Die
`resourceConsumed`-Ratio kommt **pro Bauwerk** aus der zweistufigen
Econ-Verteilung ([economy-binary.md](economy-binary.md)) — das ist der
FA-Stall: knappe Ressourcen verlangsamen jeden Bau anteilig.

## `Unit::Materialize(delta)` — was der Delta bewirkt

```
if delta > 0:   # Bauen
    FractionComplete = clamp(FractionComplete + delta, health/maxHealth, 1.0)
    AdjustHealth(maxHealth * delta)          # HP wächst proportional zum Baufortschritt
elif delta <= 0:  # z.B. Pause -> Materialize(0): nur Clamp, kein Fortschritt
    FractionComplete = clamp(FractionComplete, 0, 1)

if wasBeingBuilt and FractionComplete == 1.0:   # FERTIG
    IsBeingBuilt = false
    focus:OnStopBeingBuilt(builder, layerName)   # Lua-Callback
    # Armee-Statistik: Units_Active++, Units_History++, Units_BeingBuilt--,
    #                  Units_MassValue_Built, Units_EnergyValue_Built
    if !IsMobile:                                 # Gebäude
        for each overlappendes Gebäude:
            self:OnAdjacentTo(other); other:OnAdjacentTo(self)   # Adjacency-Buffs!
```

**Wichtige Befunde:**
- **HP wachsen linear mit dem Baufortschritt** (`maxHealth * delta` je Tick) —
  nicht erst am Ende. Deckt sich mit unserer Übergangslösung.
- **Fertigstellung ruft `OnStopBeingBuilt` in Lua** — dort läuft das
  unit-spezifische Verhalten (Intel an, Animation, Effekte).
- **Adjacency**: Sobald ein Gebäude fertig ist, feuert `OnAdjacentTo` für alle
  überlappenden Nachbarn → das ist der Einstieg für Adjacency-Buffs
  (`AdjacencyBuffs.lua`, 59 KB).

## Sonderfälle in `UpdateWorkProgress` (alle im Original)

| Fall | Verhalten |
| --- | --- |
| **Pausiert** | `Materialize(0)` — Fokus behalten, Fortschritt einfroren; WorkProgress spiegelt Fokus |
| **Enhancement** (Upgrade) | Fortschritt über Lua `WorkProgress`/`WorkItemBuildTime`, gleiche Delta-Formel |
| **Silo** (Nuke/TML-Munition) | `SiloAssistWithResource(requested * resourceConsumed)` |
| **Schild bauen/reparieren** | zusätzlich `AdjustHealth(regenRate*buildRate / RegenAssistMult)`; beschädigt → `regenAssistMult*2`, `delta*0.5` |
| **Fuel** (Air) | `FuelRatio += (FuelRechargeRate/FuelUseTime)*0.1`; beschädigt → halbe Rate |
| **Repair** | `WorkProgress = focus.Health/MaxHealth`; fertig wenn HP voll (+ Fuel/Schild voll) |
| **Progress-Bänder** | überschreitet der Fortschritt eine Schwelle → `OnBuildProgress`/`OnBeingBuiltProgress` in Lua |

## Für den Nachbau (Phase C)
- `resourceConsumed` = `LimitingRate` des Bauwerks aus der Econ-Verteilung —
  **beide Systeme greifen ineinander**, deshalb zusammen bauen.
- `Materialize` in TS: FractionComplete + HP-Kopplung + `OnStopBeingBuilt`-
  Lua-Callback + Adjacency-Scan.
- Verifikation: Bauzeit bei voller Versorgung == `BuildTime/buildRate` s;
  bei Masse-Stall verlangsamt sich *nur* der masseabhängige Bau.
