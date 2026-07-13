# Wirtschafts-Verteilung — direkt aus dem Binary rekonstruiert (IDA)

**Quelle:** IDA-Dekompilat von `func_ArmyProcessEconomy` @ **0x771B50**
(FAF-`ForgedAlliance.exe`). In **faf-re nicht rekonstruiert** — die Recherche
konnte nur sagen „Request/Grant-System, Formeln fehlen". Hier steht der echte
Verteilungsalgorithmus, als Spezifikation destilliert (kein Rohcode).

Aufgerufen aus `CArmyImpl::OnTick` @ 0x6FFD70 (`func_ArmyProcessEconomy(mEconomy)`),
also **einmal pro Armee pro Tick**, nach dem Leeren der Verbraucher-Akkus.

## Datenmodell

- `CEconomy` hält eine intrusive Liste `mConsumptionData` von **Verbrauchern**
  (jeder Bau-/Reparatur-/Verbrauchs-Request eines Units).
- Pro Verbraucher: `mResources = {ENERGY, MASS}` (diesen Tick angefordert) und
  ein `granted`-Feld (kumuliert das bisher Gewährte).
- Armee-Pools: `mResources` = **Einkommen dieses Ticks**, `mTotals.mStored` =
  **Vorrat/Lager**, `mTotals.mMaxStorage` = Lagerkapazität (double!).

## Algorithmus (pro Tick)

### 1. Nachfrage sammeln, in ZWEI Kategorien trennen
Für jeden Verbraucher: `demand[res] = max(0, requested[res] - granted[res])`.
Dann zählen, wie viele der beiden Ressourcen er braucht:
- braucht **beide** (E **und** M) → Summe in `demandBoth`
- braucht **nur eine** → Summe in `demandSingle`

`totalDemand = demandBoth + demandSingle` (je Ressource).

### 2. Verfügbaren Pool bestimmen
```
available[res] = mStored[res] + income[res] * (1 + handicap)
```
Das **Handicap multipliziert das Einkommen** (Balance-Option; 0 = keins).

### 3. Primäre Ratio (die S1-Drosselung)
```
r1 = 1.0 ; limitingRes = ENERGY
for res in {ENERGY, MASS}:
    if totalDemand[res] * r1 > available[res]:
        r1 = available[res] / totalDemand[res]
        limitingRes = res            # die knappste Ressource
```
`r1` = min(1, kleinstes `available/totalDemand`). `limitingRes` = Engpass.

### 4. „Beide"-Verbraucher bedienen, Rest berechnen
```
grantBoth[res] = demandBoth[res] * r1
leftover[res]  = max(0, available[res] - grantBoth[res])
```

### 5. Sekundäre Ratio (die S2-Drosselung, nur Nicht-Engpass-Ressource)
```
r2 = 1.0
for res != limitingRes:
    if demandSingle[res] * r2 > leftover[res]:
        r2 = leftover[res] / demandSingle[res]
```
Verbraucher, die **nur die reichliche** Ressource brauchen, bekommen aus dem
Rest eine eigene (höhere) Ratio — sie werden nicht vom Engpass der anderen
Ressource ausgebremst.

### 6. Verteilen (zweite Schleife über Verbraucher)
```
for consumer:
    demand = max(0, requested - granted)
    if consumer braucht die limitingRes NICHT:   # Single-Consumer, Nicht-Engpass
        grant = demand * r2
    else:
        grant = demand * r1
    consumer.granted += grant        # <- mGranted; Unit liest LimitingRate = granted/requested
    available        -= grant
```

### 7. Buchhaltung + Lager/Overflow
```
mTotals.mLastUseRequested = totalDemand
mTotals.mLastUseActual    = tatsächlich gewährt
mTotals.mIncome           = income (dieser Tick)
overflow[res] = max(0, available[res] - mMaxStorage[res])   # über Lager -> Overflow
if mResourceSharing: overflow an Verbündete verteilen
mStored = min(available, mMaxStorage)
income  = 0                                                 # Akku für nächsten Tick zurücksetzen
```
Alle `mStored/mReclaimed`-Writes laufen über `InterlockedCompareExchange`
(atomar, weil Stats parallel gelesen werden).

## Konsequenz für unseren Nachbau

Unsere aktuelle Floating Economy in [src/sim/simWorld.ts](../../src/sim/simWorld.ts)
ist **zu simpel**: ein globaler Stall-Faktor. Das Original hat:

1. **Pro-Verbraucher-Requests** statt eines Summen-Drains.
2. **Zwei Ratios** (r1 für Doppel-, r2 für Einzel-Verbraucher) — dadurch
   laufen z. B. reine Energie-Verbraucher weiter, wenn nur Masse fehlt.
3. **`LimitingRate = granted/requested` pro Verbraucher** — der Baufortschritt
   eines *einzelnen* Bauwerks skaliert mit *seiner* Ratio, nicht mit einem
   Armee-Globalwert.
4. **Handicap multipliziert Einkommen**, Overflow = Betrag über `mMaxStorage`.

→ Umbau in Phase C: `EconRequest`-Liste pro Armee, dieser 7-Schritt-Tick,
Units konsumieren über `LimitingRate`. Verifikation: 1 Energie-Extraktor +
1 masse-limitierter Bau → Energie-Verbraucher darf voll laufen.

## Status: umgesetzt

Implementiert in [`Army.tick`](../../src/sim/simWorld.ts) als 7-Schritt-Tick
mit `EconRequest`-Liste (Unterhalt fertiger Units + Baustellen), r1/r2 und
`LimitingRate` pro Verbraucher. **Overflow-Sharing** (Schritt 8) verteilt
Overflow bei aktivem `resourceSharing` per Waterfilling in aufsteigender
Armee-Reihenfolge an Verbündete mit freiem Lager (Rest verloren); Geber klemmt
immer auf Kapazität. Verifiziert in
[`scripts/verify-economy.ts`](../../scripts/verify-economy.ts): Doc-Prüffall
(Masse-Engpass → Doppel r1=0.5, reiner Energie-Bau r2=1), Buchhaltung,
Overflow-Klemmung, Sharing-Fälle und Determinismus.

## Korrektur: Produktion wird NICHT gedrosselt

Frühere Annahme (unterversorgter Extraktor produziert weniger Masse) ist
**binär widerlegt** (`func_ArmyProcessEconomy` @0x771B50, vollständig gelesen):
die Zwei-Ratio-Verteilung fasst **nur Verbraucher** (`mConsumptionData`) an —
passive Produktion (`mResources`) ist bedingungsloses Einkommen und wird nie
an die Grant-Ratio gekoppelt. `Unit::SetProductionActive` @0x6AAA90 setzt nur
ein Flag, keine Economy-Kopplung. Die `LimitingRate` wirkt **ausschließlich auf
Arbeit** (Bau/Reparatur/Reclaim/Capture über `Unit::ResourceConsumed` +0x53C),
nie auf Produktion. Einen „unpowered"-Abschalter für Produktion gibt es im
Base-Engine nicht; Intel/Schild/Stealth-Abschaltung bei Energiemangel ist
Lua-getrieben und betrifft die Masse-Produktion nicht. → Die aktuelle Impl ist
hier bereits 1:1; der Lock-Test in verify-economy.ts sichert das ab.

**Noch offen:** echte Builder-Zuordnung statt `BUILDER_RATE` — Formel binär
bestätigt (`delta = buildRate/BuildTime · ResourceConsumed · 0.1` je Bauer,
additiv über alle auf dasselbe Ziel gerichteten Bauer, CBuildTaskHelper::
UpdateWorkProgress @0x5f5f2c). Braucht Bauer→Ziel-Zuordnung (`issueBuild`) +
Sandbox-Bauauftrag-Verdrahtung, damit Baustellen sich nicht mehr selbst bauen.
