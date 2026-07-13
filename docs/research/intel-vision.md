# agent4

## Summary
Das Intel-System von SupCom:FA besteht aus zwei entkoppelten Schichten: (1) der SIM-Schicht mit pro-Armee `CAiReconDBImpl`, die 8 zählende Int8-Coverage-Grids (`CIntelGrid`) und einen Blip-Baum (`ReconBlip` mit Per-Army-Flags) verwaltet, und (2) der CLIENT-Schicht mit einem Quadtree (`VisionDB`) aus Sichtkreisen, die als 45-Segment-Zylinder ("vision"-Effekt) in eine Reveal-Maske gerendert werden. Sichtbarkeit ist NICHT boolesch pro Zelle, sondern ein Int8-Refcount (AddCircle=+1 / SubtractCircle=-1), und Detection läuft über einen 7-Bit-Flagsatz `EReconFlags` (Radar/Sonar/Omni/LOSNow/LOSEver/KnownFake/MaybeDead) pro (Blip × Armee). Der volle Recon-Tick läuft round-robin: pro Sim-Tick macht nur EINE Armee `ReconTick(dTicks=armyCount)`, alle anderen nur das billige `ReconRefresh()`.

## Key Facts
- Gridauflösung ist fest verdrahtet im CAiReconDBImpl-Ctor: Vision-Grid = 2 Weltmeter/Zelle, ALLE anderen (Water, Radar, Sonar, Omni, RCI, SCI, VCI) = 4 Weltmeter/Zelle; Grid-Dims = (heightfield.width-1)/cellSize × (heightfield.height-1)/cellSize.
- CIntelGrid ist ein int8-COUNTER-Grid, kein Bool: AddCircle=+1, SubtractCircle=-1 über die rasterisierte Kreisscheibe; IsVisible == (cell != 0). Radius wird per GANZZAHLDIVISION in Zellen umgerechnet (radiusInCells = radius / gridSize) — Radar 115 → 28 Zellen, Vision 20 → 10 Zellen.
- Vision- und Water-Grid werden NUR angelegt wenn fogOfWar=true; ist FoW aus, liefert GetNewReconFor/GetDetection sofort RECON_LOSNow (alles sichtbar).
- Update-Takt der Intel-Handles: CIntelPosHandle::UpdatePos verschiebt die Grid-Coverage nur wenn die Bewegung >= (radius * 0.333) ist ODER >30 Ticks seit dem letzten Update vergangen sind — sonst passiert gar nichts.
- Recon-Scheduling in Sim::Tick: reconTickIndex = mCurTick % armyCount; nur diese eine Armee ruft ReconTick(armyCount), alle anderen ReconRefresh(). Volle Detection pro Armee also nur alle armyCount Ticks.
- EReconFlags: RECON_Radar=0x01, Sonar=0x02, Omni=0x04, LOSNow=0x08, LOSEver=0x10, KnownFake=0x20, MaybeDead=0x40. LOSEver|KnownFake (0x30) sind STICKY — `newFlags |= (oldFlags & 0x30)` in UpdateBlip, werden nie gelöscht.
- Der oldFlags-Parameter aller Detect-Funktionen ist eine SENSE-MASKE (welche Sinne getestet werden sollen), kein Vorzustand — Aufrufer übergeben RECON_AnySense um alles zu prüfen.
- Counter-Intel schreibt in die Grids der FEINDE: CIntelCounterHandle::AddViz iteriert alle Armeen, überspringt die eigene ReconDB und ruft AddCircle auf deren RCI/SCI/VCI-Grid. Omni schlägt ALLES: ApplyReconCounters returnt sofort wenn RECON_Omni gesetzt ist.
- Ghost-Gebäude: In ReconTick werden nicht mehr detektierte Units gelöscht (DeleteBlips) — AUSSER der Blip hat RECON_LOSEver und die Unit ist !IsMobile(); dann bleibt er mit UpdateBlips(unit, RECON_None) bestehen. RefreshBlip überschreibt Mesh/Health/FractionComplete NUR bei RECON_LOSNow → der Ghost friert den letzten bekannten Stand ein.
- Jammer-Fake-Blips: Anzahl = blueprint.Intel.JammerBlips (nur wenn Jamming-Toggle aktiv). Jeder Fake-Blip bekommt in ReconBlip-Ctor einen mJamOffset: zufällige Richtung (2× Gauss, normalisiert in XZ) × (rand() × radius), radius = JamRadius.Min + rand*(Max-Min). ReconBlip::Refresh addiert diesen Offset permanent auf die Position.
- Fake-Blips werden als RECON_KnownFake entlarvt sobald: Omni sie erfasst, LOSNow sie erfasst, die Quell-Unit weg/alliiert ist, oder die Blip-Position ausserhalb der spielbaren Map-Radius liegt.
- Client-FoW hat ZWEI Grids pro UserArmy: mExploredReconGrid (jemals gesehen → Terrain wird überhaupt gezeichnet) und mFogReconGrid (aktuell sichtbar). UserArmy::CanSeeCell(x,z,mask) prüft eigene + alliierte Grids mit EReconGridMask {Explored=1, Fog=2}.
- FoW-Rendering ist KEINE Textur-Maske sondern Geometrie: VisionRenderer::Init baut einen 45-Segment-Zylinder (Radius 1, y von -256 bis +256, 92 Verts / 540 Indices) plus einen Instanz-Vertexbuffer (12288 Instanzen à 12 Byte = x,z,radius). Gerendert mit dem D3D-Effekt namens "vision".
- Blueprint-Intel-Felder (RUnitBlueprintIntel, exakte Reihenfolge/Offsets): VisionRadius, WaterVisionRadius, RadarRadius, SonarRadius, OmniRadius (uint32); RadarStealth, SonarStealth, Cloak, ShowIntelOnSelect (bool); RadarStealthFieldRadius, SonarStealthFieldRadius, CloakFieldRadius (uint32); JamRadius {Min,Max}; JammerBlips (uint8); SpoofRadius {Min,Max}.
- RULEUTC-Toggle-Bits (ERuleBPUnitToggleCaps, Bit-Index = OnScriptBitSet/Clear-Argument): 0 Shield(1), 1 Weapon(2), 2 Jamming(4), 3 Intel(8), 4 Production(16), 5 Stealth(32), 6 Generic(64), 7 Special(128), 8 Cloak(256). ACHTUNG: OnScriptBitSet = AUSschalten, OnScriptBitClear = EINschalten.

## Details
## 1. Sichtsystem — LoS vs Radar vs Sonar vs Omni

### Speicherung pro Armee
Jede Armee hat eine `CAiReconDBImpl` (`sdk/moho/ai/CAiReconDBImpl.h`) mit **8 Grids** (alle `boost::shared_ptr<CIntelGrid>`):

| Grid | Zellgröße | Zweck | Nur bei FoW? |
|---|---|---|---|
| `mVisionGrid` | **2** | LoS über Wasser/Land | **ja** |
| `mWaterGrid` | 4 | LoS unter Wasser | **ja** |
| `mRadarGrid` | 4 | Radar | nein |
| `mSonarGrid` | 4 | Sonar | nein |
| `mOmniGrid` | 4 | Omni | nein |
| `mRCIGrid` | 4 | Radar-Counter (Gegner-Stealthfeld) | nein |
| `mSCIGrid` | 4 | Sonar-Counter | nein |
| `mVCIGrid` | 4 | Vision-Counter (Cloak-Feld) | nein |

Ctor (`CAiReconDBImpl.cpp:1202-1212`):
```
mRadarGrid = MakeGrid(mMapData, 4);  // ... Sonar/Omni/RCI/SCI/VCI ebenfalls 4
if (fogOfWar) { mVisionGrid = MakeGrid(mMapData, 2); mWaterGrid = MakeGrid(mMapData, 4); }
```

### CIntelGrid — das Kernprimitiv (`sdk/moho/sim/CIntelGrid.cpp`)
- Felder: `STIMap* mMapData; int8_t* mGrid; uint32 mWidth, mHeight; <delayed-update-vector>; uint32 mGridSize;`
- Dims: `width = (heightField->width - 1) / cellSize`, analog height. Speicher = `width*height` Bytes, memset 0.
- **`Raster(pos, radiusInCells, doAdd)`**: `GridPos gp(pos, mGridSize)`; für `x` von `gp.x-r` bis `gp.x+r` (**halboffen**, `x < xMax`): `leg = (int)sqrt(r² - dx²)`, dann `z` von `gp.z-leg` bis `gp.z+leg` (**halboffen**): `mGrid[x + z*width] += (doAdd ? +1 : -1)`. Die halboffenen Grenzen erzeugen eine leicht asymmetrische Scheibe — für 1:1-Treue exakt so nachbauen.
- `AddCircle(pos, radius)` → `Raster(pos, radius / mGridSize, true)` — **Integer-Division!**
- `SubtractCircle` → `Raster(..., false)`
- `DelayedSubtractCircle(pos, radius)` → pusht `{pos, radius, mTicksTilUpdate=30}`; `Tick(dTicks)` dekrementiert und rastert bei `<=0` mit `-1`. **Hinweis: im Decomp gibt es keinen Aufrufer** — vermutlich für "Sicht bleibt nach Tod kurz stehen"; nicht rekonstruierbar aus dem vorliegenden Code.
- `IsVisible(x,z)` = bounds-check + `mGrid[z*mWidth + x] != 0`
- `IsVisible(Rect2i)` = Rect → Grid-Bounds (**floor** für min, **ceil** für max), true wenn IRGENDEINE Zelle != 0.

### Detection-Pipeline (pro Punkt)
`GetReconFlags(entity, pos, senseMask, belowWater)` (`CAiReconDBImpl.cpp:1915`):
1. `GetNewReconFor(...)` für die **eigene** Armee
2. Für jede Armee, die den Viewer in `Allies` hat: `MergeFlags(combined, ally->GetNewReconFor(...))` — **Allianz-Sicht wird ge-OR-t, aber die Counter-Intel des Viewers wird danach angewendet**
3. Wenn `combined == RECON_None` → früher Ausstieg
4. `ApplyReconCounters(entity, pos, combined)`

`GetNewReconFor` (`:1809`) — Reihenfolge exakt:
- **LOS**: wenn `mFogOfWar == 0 || mVisionGrid == null` → **sofort `RECON_LOSNow`** (kein FoW = alles sichtbar). Sonst, wenn Maske LOSNow enthält: Grid = `belowWater ? mWaterGrid : mVisionGrid`, `IsVisible(pos)` → LOSNow.
- **Sonar**: nur wenn `belowWater || UsesWaterSenseLane(entity->mCurrentLayer)` (Layer Seabed/Sub/Water) UND Maske Sonar UND `mSonarGrid->IsVisible(pos)`.
- **Radar**: nur wenn `!belowWater` UND Maske Radar UND `mRadarGrid->IsVisible(pos)`.
- **Omni**: Maske Omni UND `mOmniGrid->IsVisible(pos)`. (Keine Layer-Beschränkung.)

`ApplyReconCounters` (`:1864`) — **Omni überschreibt alles**:
```
if (flags & RECON_Omni) return flags;               // Omni ignoriert JEDE Counter-Intel
if (RCI-Grid sichtbar an pos)  flags &= ~RECON_Radar;   // fremdes Radar-Stealthfeld
if (SCI-Grid sichtbar an pos)  flags &= ~RECON_Sonar;
if (aktiver Cloak-Toggle der Unit || VCI-Grid sichtbar) flags &= ~RECON_LOSNow;
if (!(flags & RECON_LOSNow)) {                       // persönlicher Stealth wirkt NUR ausserhalb LOS
   if (unit.RadarStealth aktiv) flags &= ~RECON_Radar;
   if (unit.SonarStealth aktiv) flags &= ~RECON_Sonar;
}
```
Die Rect-Variante (`GetReconFlagsForRect` / `GetDetection` / `DoCounterDetection`, `:1962-2070`) ist strukturell identisch, nutzt aber `IsVisible(rect)` und `pingSense = isUnderwater ? Sonar : Radar` (nur EIN Ping-Sinn statt beider).

`ReconCanDetect(rect, y, oldFlags)`: `isUnderwater = (map.WaterEnabled ? map.WaterElevation : -10000.0f) > y`.

### Update-Takt
- **Handle-Ebene** (`CIntelPosHandle::UpdatePos`, `CIntelPosHandle.cpp:149`): Coverage wird nur neu gerastert wenn `distSq >= (radius*0.333)²` **oder** `curTick - mLastTickUpdated > 30`. Sonst nur Positionsspeicherung. → Bei kleinen Bewegungen passiert nichts; Grid-Churn ist begrenzt.
- `CIntel::Update(pos, tick)` (`CIntel.cpp:271`): für jedes der 9 Handles: wenn `mEnabled` und Position geändert → `SubViz(); mLastPos = pos; AddViz();` (Radius wird um den Aufruf herum gesichert/restauriert). Danach immer `mLastTickUpdated = tick`.
- **Sim-Ebene** (`Sim.cpp:12018-12049`): 
```
reconTickIndex = mCurTick % armyCount;
for i in armies: (i == reconTickIndex) ? reconDb->ReconTick(armyCount) : reconDb->ReconRefresh();
```
→ **Voller Recon-Tick pro Armee nur alle `armyCount` Ticks**, mit `dTicks = armyCount`. `ReconRefresh()` (jeden Tick, alle anderen Armeen) macht nur `RefreshBlip()` pro Blip (Mesh/Health/MaybeDead-Sync). Davor läuft global `RefreshBlips()` (Transform-Sync aller Blips).

---

## 2. Blips

### ReconBlip (`sdk/moho/sim/ReconBlip.h`, size 0x4D0, erbt `Entity`)
Ein Blip ist eine **echte Sim-Entity** (kein reines UI-Objekt) und wird per `CreateInterface` als Unit an den Client gepusht. Wichtige Felder:
- `WeakPtr<Unit> mCreator` (+0x270) — Quell-Unit
- `uint8 mDeleteWhenStale` (+0x278) — im Ctor: `sourceUnit->IsMobile() ? 1 : 0`
- `Wm3::Vec3f mJamOffset` (+0x27C)
- `SReconBlipUnitConstData mUnitConstDat` (+0x288) — enthält `mFake`
- `SReconBlipUnitVarData mUnitVarDat` (+0x298) — `mCustomName`, `mBlueprintState0/1`
- `msvc8::vector<SPerArmyReconInfo> mReconDat` (+0x4C0) — **ein Eintrag pro Armee**

### SPerArmyReconInfo (0x34 Bytes) — der Per-Armee-Zustand
```
uint8  mNeedsFlush;        // +0x00  "diese Armee trackt diesen Blip"
uint32 mReconFlags;        // +0x04  EReconFlags-Bitmaske
int32/RMeshBlueprint* mMeshTypeClassId / mStiMesh;  // +0x08
shared_ptr<RScmResource> mMesh;   // +0x0C
shared_ptr<CAniPose> mPriorPose;  // +0x14
shared_ptr<CAniPose> mPose;       // +0x1C
float mHealth;             // +0x24   <- eingefroren wenn kein LOSNow
float mMaxHealth;          // +0x28
float mFractionComplete;   // +0x2C
uint8 mMaybeDead;          // +0x30
```

### EReconFlags (`sdk/moho/ai/IAiReconDB.h:33`)
```
RECON_None=0x00, RECON_Radar=0x01, RECON_Sonar=0x02, RECON_Omni=0x04,
RECON_LOSNow=0x08, RECON_LOSEver=0x10, RECON_KnownFake=0x20, RECON_MaybeDead=0x40
RECON_RadarSonar = Radar|Sonar
RECON_AnyPing    = Radar|Sonar|Omni
RECON_Exposed    = Omni|LOSNow|LOSEver
RECON_AnySense   = Radar|Sonar|Omni|LOSNow
```
"Blip-Typen" gibt es nicht als Enum — der Darstellungstyp ergibt sich aus der Flag-Kombination pro Armee:
- nur `Radar`/`Sonar` → unbekannter Kontakt (roter Punkt, kein Modell)
- `Omni` → Typ bekannt, Modell sichtbar, aber ggf. kein LOS
- `LOSNow` → echte Unit, Live-Daten
- `LOSEver` ohne LOSNow → Ghost/letzter bekannter Stand
- `KnownFake` → als Jammer-Fake entlarvt
- `MaybeDead` → Quelle weg, Blip bleibt als Karteileiche

Query-API auf ReconBlip: `IsOnRadar(army)`, `IsOnSonar(army)`, `IsOnOmni(army)`, `IsSeenNow(army)` (LOSNow), `IsSeenEver(army)` (LOSEver), `IsKnownFake(army)`, `IsMaybeDead(army)`, `GetFlags(army)`.

### Wann wird ein Blip zur echten Unit
Es gibt **keinen Übergang Blip→Unit** — der Blip bleibt immer ein Blip. Was sich ändert, ist der Datengehalt in `RefreshBlip` (`CAiReconDBImpl.cpp:1555`):
```
if (flags & RECON_LOSNow) {           // NUR bei LOS werden echte Daten kopiert
    perArmy->mMeshTypeClassId = sourceUnit->mMeshTypeClassId;
    perArmy->mHealth = sourceUnit->Health;
    perArmy->mMaxHealth = sourceUnit->MaxHealth;
    perArmy->mFractionComplete = sourceUnit->FractionCompleted;
}
if (flags & RECON_AnySense) perArmy->mMaybeDead = sourceUnit->IsDead();
```
Und in `UpdateBlip` (`:1586`) wird bei LOSNow zusätzlich `mCustomName` kopiert und `RECON_LOSEver` gesetzt.

### Blip-Lifecycle in ReconTick (`:1277`)
1. Orphan-Blips (`mTempBlips`) durchgehen: löschen wenn Blip-Armee alliiert ODER per LOSNow detektierbar.
2. Map-Blips: Quell-Unit tot/weg? → wenn **kein** Fake: `ClearPerArmyRecon`. Wenn Fake: löschen falls alliiert/LOS-sichtbar, sonst `RECON_MaybeDead` setzen und in `mTempBlips` schieben. Node aus der Map löschen.
3. Für **jede** feindliche Unit (nicht alliiert, `DestroyQueued()==false`, in Kategorie `VISIBLETORECON`):
   - `detectFlags = ReconCanDetect(unit, unit.pos, RECON_AnySense)`
   - `detectFlags != None`: kein Blip vorhanden → `AppendPendingNewBlip`; sonst `UpdateBlips(...)`
   - `detectFlags == None` und Blip existiert: **Ghost-Regel** — wenn `(flags & RECON_LOSEver) && !unit->IsMobile()` → `UpdateBlips(unit, RECON_None, ...)` (Blip bleibt); sonst `DeleteBlips(unit)`
4. `GenerateNewBlips(pending)` → `FindOrCreateBlip` (recycelt bestehenden Blip mit passendem `IsFake()` und `mNeedsFlush==0`) + `UpdateBlip` + `InsertMapNode`.
5. `TickAllReconGrids(dTicks)`.

`ReconBlip::DestroyIfUnused()`: löscht sich, wenn Quelle weg/fake UND **kein** `mNeedsFlush` in irgendeiner Armee gesetzt ist.
`ReconBlip::UpdateVisibility()`: `mVisibilityState = (focusArmy != -1 && mReconDat[focusArmy].mNeedsFlush != 0)`.

Intel-Events: `CheckIntelEvents(blip, old, new)` diffed und feuert `OnIntelChange` per Sinn (LOSNow, Radar, Sonar, Omni) ins Army-Script.

---

## 3. Stealth / Cloak / Jamming

### CIntel (`sdk/moho/entity/intel/CIntel.h`, size 0x30, an Entity+0x1D8)
9 Handles + 5 Toggles:
```
CIntelPosHandle* mVisionGrid, mWaterGrid, mRadarGrid, mSonarGrid, mOmniGrid;   // +0x00..0x10
CIntelCounterHandle* mRCIGrid, mSCIGrid, mVCIGrid;                              // +0x14..0x1C
CIntelPosHandle* mReservedGrid;                                                 // +0x20 (ungenutzt)
CIntelToggleState mJamming, mCloak, mSpoof, mSonarStealth, mRadarStealth;      // +0x24..0x2C
```
`CIntelToggleState = { uint8 present; uint8 enabled; }` — `present` kommt aus dem Blueprint, `enabled` aus dem Toggle-Bit.

Ctor aus Blueprint (`CIntel.cpp:193`):
```
VisionRadius!=0            -> InitIntel(1,...)
WaterVisionRadius!=0       -> InitIntel(2,...)
RadarRadius!=0             -> InitIntel(3,...)
SonarRadius!=0             -> InitIntel(4,...)
OmniRadius!=0              -> InitIntel(5,...)
RadarStealthFieldRadius!=0 -> InitIntel(6,...)   // CIntelCounterHandle(INTELCOUNTER_RadarStealthField)
SonarStealthFieldRadius!=0 -> InitIntel(7,...)   // INTELCOUNTER_SonarStealthField
CloakFieldRadius!=0        -> InitIntel(8,...)   // INTELCOUNTER_CloakField
mJamming.present      = (JammerBlips != 0 && JamRadius.max != 0)
mCloak.present        = (Cloak != 0)
mSpoof.present        = (SpoofRadius.max != 0)
mSonarStealth.present = (SonarStealth != 0)
mRadarStealth.present = (RadarStealth != 0)
```

### EIntelCounter (`CIntelCounterHandle.h:20`)
`INTELCOUNTER_None=0, RadarStealthField=1, SonarStealthField=2, CloakField=8`

### Counter-Intel schreibt in FEINDE-Grids
`CIntelCounterHandle::AddViz/SubViz` (`CIntelCounterHandle.cpp:357/372`) → `ApplyCounterIntelToForeignArmies`:
```
for (army : sim->mArmiesList) {
   if (army->GetReconDB() == this->mReconDB) continue;   // eigene Armee überspringen
   grid = (mType==RadarStealthField) ? reconDB->ReconGetRCIGrid()
        : (mType==SonarStealthField) ? reconDB->ReconGetSCIGrid()
        : (mType==CloakField)        ? reconDB->ReconGetVCIGrid() : null;
   grid->AddCircle(mLastPos, mRadius);   // bzw. SubtractCircle
}
```
**Wichtig für den Nachbau:** Stealth-/Cloak-Felder sind keine Abfrage-Zeit-Prüfung, sondern werden aktiv in die RCI/SCI/VCI-Grids ALLER anderen Armeen gerastert. Bei nur 2 Armeen kann man das vereinfachen, bei n Armeen nicht.

Guard: `AddViz`/`SubViz` machen nichts wenn `mEnabled==0 || mRadius==0`.

### Jamming / Fake-Blips
- Anzahl: `GetActiveJammerBlipCount(unit)` (`CAiReconDBImpl.cpp:872`) = `blueprint.Intel.JammerBlips`, **aber nur wenn `intel->HasActiveJamming()`** (`mJamming.present && mJamming.enabled`), sonst 0.
- `UpdateBlips` (`:1688`) hält die Fake-Anzahl exakt: überzählige Fakes → `DeleteBlip`; fehlende → `AppendPendingNewBlip(pending, unit, fake=1, detectedFlags)`.
- `ComputeJamOffset(unit, sim)` (`ReconBlip.cpp:674`) — **einmalig im Ctor**, danach fix:
```
range      = max(0, JamRadius.max - JamRadius.min)
radiusStep = (uint32)((uint64)range * rng.NextUInt32() >> 32)
radius     = (float)(JamRadius.min + radiusStep)
dir        = normalize(Vec3(rng.FRandGaussian(), 0, rng.FRandGaussian()))   // nur XZ
scale      = ToUnitFloat(rng.NextUInt32()) * radius
offset     = dir * scale
```
- `ReconBlip::Refresh()` addiert `mJamOffset` auf Position UND PendingPosition der Quell-Unit → der Fake-Blip bewegt sich starr mitversetzt.
- **Entlarvung** (`UpdateBlip`, `:1631`): `RECON_KnownFake` wird gesetzt wenn `RECON_Omni` ODER `RECON_LOSNow` gesetzt ist ODER keine Quell-Unit existiert ODER die Quelle alliiert ist ODER die Blip-Position ausserhalb des spielbaren Map-Radius liegt (`IsWithinPlayableMapRadius(map, blip->Position, max(footprint.X, footprint.Z), useWholeMap)` == false).
- `Spoof` ist im Blueprint-Struct vorhanden (`SpoofRadius {Min,Max}`), wird aber in **keinem** Vanilla-FA-Blueprint verwendet (0 Treffer über alle `*_unit.bp`) — totes Feature.

### RULEUTC-Toggles
`ERuleBPUnitToggleCaps` (`RUnitBlueprintCapabilityEnums.h:37`):
```
RULEUTC_ShieldToggle=1, WeaponToggle=2, JammingToggle=4, IntelToggle=8,
ProductionToggle=16, StealthToggle=32, GenericToggle=64, SpecialToggle=128, CloakToggle=256
```
Bit-Index (= Argument von `OnScriptBitSet/Clear`) = 0..8 in dieser Reihenfolge.

**Achtung Invertierung** (`lua/sim/Unit.lua:309`): `OnScriptBitSet(bit)` = Feature **AUS**, `OnScriptBitClear(bit)` = Feature **AN**.
- bit 2 (Jamming): Clear → `EnableUnitIntel('Jammer')`; Set → `DisableUnitIntel('Jammer')`
- bit 3 (Intel): Clear → Enable von Radar, RadarStealth, RadarStealthField, SonarStealth, SonarStealthField, Sonar, Omni, Cloak, CloakField, Spoof, Jammer. Set → Disable derselben + zusätzlich `'Radar'`.
- bit 5 (Stealth): nur RadarStealth, RadarStealthField, SonarStealth, SonarStealthField
- bit 8 (Cloak): nur `'Cloak'`
Alle vier rufen zusätzlich `SetMaintenanceConsumptionActive/Inactive()` + Ambient-Sound.

### Lua-Intel-API (Refcount-basiert!)
`lua/sim/Unit.lua:1759ff`:
- `SetupIntel()`: `EnableIntel('Vision')` immer; dann `IntelDisables = {Radar=1, Sonar=1, Omni=1, RadarStealth=1, SonarStealth=1, RadarStealthField=1, SonarStealthField=1, Cloak=1, CloakField=1, Spoof=1, Jammer=1}` und `EnableUnitIntel(nil)` → alle auf 0 herunter, was sie einschaltet.
- `DisableUnitIntel(t)` / `EnableUnitIntel(t)` sind **Zähler**: Engine-`DisableIntel`/`EnableIntel` feuert nur beim 0↔1-Übergang. Mehrere Quellen (Toggle, Energieausfall) können unabhängig disablen.
- `EnableUnitIntel` schaltet zusätzlich `WaterVision` ein wenn Layer ∈ {Seabed, Sub, Water}.
- `IntelWatchThread`: alle 0.5 s `GetResourceConsumed()`; sobald `< 1` → `DisableUnitIntel(nil)`, warte `bp.Intel.ReactivateTime or 10` Sekunden, dann `EnableUnitIntel(nil)`. Läuft nur wenn `ShouldWatchIntel()` (nicht `FreeIntel`, `Economy.MaintenanceConsumptionPerSecondEnergy > 0` und mindestens ein Intel-Feld gesetzt).

### EIntel-IDs — WIDERSPRUCH IM DECOMP (wichtig!)
`sdk/moho/unit/core/EIntelTypeInfo.h:10` (Reflection-registriert, für Lua-String→ID):
```
None=0, Vision=1, WaterVision=2, Radar=3, Sonar=4, Omni=5,
RadarStealthField=6, SonarStealthField=7, CloakField=8, Jammer=9,
Spoof=10, Cloak=11, RadarStealth=12, SonarStealth=13
```
`CIntel::InitIntel`-Switch (`CIntel.cpp:440`) hat aber: `case 9 → mJamming`, **`case 11 → mSpoof`**, **`case 12 → mSonarStealth`**, **`case 13 → mRadarStealth`**, und **kein case 10**. Das widerspricht dem Header bei 10–13 (Spoof/Cloak vertauscht, RadarStealth/SonarStealth vertauscht) und Cloak hat gar keinen Case.
→ **Empfehlung für den Nachbau: Dispatch über den NAMEN, nicht über die Zahl.** Die numerischen IDs sind nur für Savegame-Kompatibilität relevant, die du ohnehin nicht brauchst. Nimm die Namensliste aus `EIntelTypeInfo` als kanonisch.

---

## 4. Fog of War Rendering

**Keine Textur-Maske im klassischen Sinn — es ist Stencil-/Mask-Geometrie.**

### Client-Grids (`sdk/moho/sim/UserArmy.h`)
`UserArmy` (= View auf `SSTIArmyConstantData`, per `CArmyImpl::CopyConstantDataToUserArmy` befüllt) hält 8 `shared_ptr<CIntelGrid>`:
`mExploredReconGrid, mFogReconGrid, mWaterReconGrid, mRadarReconGrid, mSonarReconGrid, mOmniReconGrid, mRciReconGrid, mSciReconGrid`
```
enum class EReconGridMask : uint8 { None=0, Explored=1, Fog=2, Both=3 };
bool CanSeeCell(x, z, mask) const;    // 0x008B17F0
bool CanSeePoint(worldPos, mask) const; // 0x008B22B0 -> GridPos(pos, exploredGrid->mGridSize) -> CanSeeCell
```
`CanSeeCell` (`UserArmy.cpp:1441`):
- kein `mExploredReconGrid` oder `RenderFogOfWarEnabled()==false` → **true** (alles sichtbar)
- `Explored`-Bit und `exploredGrid->IsVisible(x,z)` → true
- `Fog`-Bit und `mFogReconGrid->IsVisible(x,z)` → true
- sonst iteriere alle alliierten `UserArmy` und prüfe deren Explored/Fog-Grids

**Zwei-Stufen-Fog:**
- `mExploredReconGrid` = jemals aufgedeckt → Terrain wird überhaupt gerendert (sonst schwarz/Shroud)
- `mFogReconGrid` = aktuell in Sicht → volle Helligkeit (sonst abgedunkelt/grau)

`TerrainRectVisibleForFocusArmy` (`CWldMap.cpp:1453`) nutzt genau das für Terrain-Dirty-Rect-Culling: Rect wird nur synchronisiert wenn `exploredGrid->IsVisible(rect) || fogGrid->IsVisible(rect)` (oder ein Ally das sieht).

> **Lücke:** Wo `mExploredReconGrid`/`mFogReconGrid` **befüllt** werden (AddCircle-Aufrufe), ist im Decomp nicht wiederhergestellt — nur die Weitergabe (`CArmyImpl.cpp:1989`) und die Abfrage. Semantik ist aber eindeutig: Explored akkumuliert nur (nie SubtractCircle), Fog folgt der aktuellen Vision-Coverage.

### Reveal-Geometrie: VisionDB + VisionRenderer
`VisionDB` (`sdk/moho/vision/VisionDB.h/.cpp`, **client-seitig**, size 0x24) — Quadtree aus Sichtkreisen:
- `Init(width, height)`: Root-Node = Kreis um `(w/2, h/2)` mit `radius = 2 * sqrt((w/2)² + (h/2)²)`; dann `GenerateQuadTree(root, halfSize, level=0, maxLevel=1)` → **nur 1 Unterteilungsebene** (4 Quadranten NW/SW/NE/SE), jeder mit `radius = halbe Diagonale` des Subrechtecks.
- `Pool::PooledNode` (0x28): `mParent, mContained, mNext, uint8 mIsReal, uint8 mVis, EntryCircle mPrevCircle {x,y,radius}, EntryCircle mCurCircle`. Pool allokiert in 500er-Blöcken.
- `Handle::Update(next, previous, radius, visible)`: schreibt `mVis`, `mPrevCircle`, `mCurCircle` und **reparentet** in den Baum wenn die Containment-Bedingung nicht mehr gilt. Prev+Cur werden beide gespeichert → Interpolation/Smear zwischen Sim-Ticks.

Erzeugt in `UserEntity::Update` (`UserEntity.cpp:639`):
```
if (!RenderFogOfWarEnabled() || !mSession) return;
visionRange = GetVisionRange(mVariableData);
if (visionRange != 0 && !mVisionHandle) mVisionHandle = session->visionDb.NewHandle(zero, zero);
if (!mVisionHandle || IsUserUnit()) return;
alliedVisibility = IsVisionEnabled(varData) && focusArmy->IsAlly(mArmy->mArmyIndex);
mVisionHandle->Update(curPos.xz, lastPos.xz, (float)visionRange, alliedVisibility);
```

`VisionRenderer` (`sdk/moho/render/VisionRenderer.cpp`) baut die Reveal-Geometrie:
- **45 Segmente**, `angleStep = 0.13962634` (= 2π/45)
- **92 Vertices**: 45 oben (`cos(a), +256, sin(a)`), 45 unten (`cos(a), -256, sin(a)`), + 2 Center-Verts (Index 90 = `(0,+256,0)`, Index 91 = `(0,-256,0)`)
- **540 Indices**: 45×6 für den Mantel (2 Tris/Segment) + 45×6 für die beiden Kappen
- → also ein **Einheitszylinder** (Radius 1, y ∈ [-256, +256]), der pro Instanz mit (x, z, radius) skaliert/verschoben wird
- Instanz-Vertexbuffer: `width_=12288, height_=12, type_=3, usage_=2` → 12288 Instanzen à 12 Byte (3 floats)
- Shader: `D3D_GetDevice()->GetResources()->FindEffect("vision")` (`VisionRenderer.cpp:34`)

**Nachbau in WebGL/Three.js:** Instanced Cylinder (oder simpler: instanced Quad/Disc) in eine Offscreen-R8-Textur rendern (additiv oder Stencil), dann als Reveal-Maske im Terrain-Shader gegen die Explored-Maske verrechnen. Der Zylinder mit y ∈ [-256, +256] ist nur da, um beliebige Terrainhöhen zu durchdringen — bei einem Top-Down-Maskenrender genügt ein flacher Kreis.

### Letzter bekannter Stand von Gebäuden (Wiedersichtbarkeit)
Vollständig sim-seitig (siehe §2):
1. `ReconTick`: Unit nicht mehr detektiert + Blip hat `RECON_LOSEver` + `!unit->IsMobile()` → Blip überlebt mit `UpdateBlips(unit, RECON_None, ...)`.
2. `UpdateBlip`: `newFlags |= (oldFlags & 0x30)` → `LOSEver` und `KnownFake` bleiben sticky.
3. `RefreshBlip`: Mesh/Health/MaxHealth/FractionComplete werden **nur** bei `RECON_LOSNow` aktualisiert → der Ghost behält Baufortschritt, HP-Balken und Modellzustand vom letzten Sichtkontakt.
4. Mobile Units (`mDeleteWhenStale = IsMobile()`) → `DeleteBlips`, kein Ghost.
5. Bei Wiedersichtbarkeit: `RECON_LOSNow` kommt zurück → `RefreshBlip` überschreibt alle Felder mit Live-Daten.

---

## 5. Blueprint-Felder

### RUnitBlueprintIntel (`sdk/moho/resource/blueprints/RUnitBlueprint.h:306`) — exakte Binärstruktur
```
uint32  VisionRadius;             // +0x00
uint32  WaterVisionRadius;        // +0x04
uint32  RadarRadius;              // +0x08
uint32  SonarRadius;              // +0x0C
uint32  OmniRadius;               // +0x10
uint8   RadarStealth;             // +0x14
uint8   SonarStealth;             // +0x15
uint8   Cloak;                    // +0x16
uint8   ShowIntelOnSelect;        // +0x17
uint32  RadarStealthFieldRadius;  // +0x18
uint32  SonarStealthFieldRadius;  // +0x1C
uint32  CloakFieldRadius;         // +0x20
SMinMax<uint32> JamRadius;        // +0x24  {min, max}
uint8   JammerBlips;              // +0x2C
uint8   pad[3];                   // +0x2D
SMinMax<uint32> SpoofRadius;      // +0x30  {min, max}
```

### Tatsächlich in Vanilla-FA verwendete Lua-Keys (Scan über alle `units/*/*_unit.bp` in units.scd, mit Trefferzahl)
| Key | #BPs | Engine-Feld? |
|---|---|---|
| `VisionRadius` | 391 | ja |
| `WaterVisionRadius` | 71 | ja |
| `SonarRadius` | 67 | ja |
| `RadarRadius` | 57 | ja |
| `ShowIntelOnSelect` | 24 | ja |
| `ReactivateTime` | 19 | **nein — nur Lua** (`IntelWatchThread`) |
| `OmniRadius` | 17 | ja |
| `RadarStealth` | 15 | ja |
| `SonarStealth` | 9 | ja |
| `FreeIntel` | 8 | **nein — nur Lua** (`ShouldWatchIntel`) |
| `JamRadius {Min,Max}` | 7 | ja |
| `JammerBlips` | 7 | ja |
| `RadarStealthFieldRadius` | 7 | ja |
| `SonarStealthFieldRadius` | 7 | ja |
| `Cloak` | 4 | ja |
| `RemoteViewingRadius` | 2 | **nein — nur Lua** (Eye of Rhianne) |
| `RadarStealthField` | 1 | **nein — nur Lua** (redundantes Bool) |
| `VisionRadiusOnDeath` / `IntelDurationOnDeath` | 1 | **nein — nur Lua** |
| `MinVisionRadius` / `MaxVisionRadius` | 1 | **nein — nur Lua** |
| `StealthWaitTime` | 1 | **nein — nur Lua** |
| `SpoofRadius` | **0** | ja, aber ungenutzt |

### Konkrete Beispiele (verifiziert aus units.scd)
```lua
-- UAB3101 (Aeon T1 Radar)
Intel = { RadarRadius = 115, ReactivateTime = 5, ShowIntelOnSelect = true, VisionRadius = 20 }
-- UAL0101 (Aeon T1 Scout)
Intel = { RadarRadius = 50, VisionRadius = 24 }
-- XSB3201 (Seraphim T2 Radar)
Intel = { RadarRadius = 200, ReactivateTime = 5, ShowIntelOnSelect = true, VisionRadius = 25 }
-- URL0306 (Cybran Mobile Stealth Field)
Intel = { RadarStealth = true, RadarStealthField = true, RadarStealthFieldRadius = 18,
          SonarStealthFieldRadius = 18, VisionRadius = 16 }
-- URL0101 (Cybran T1 Scout) + ToggleCaps { RULEUTC_CloakToggle = true }
Intel = { Cloak = true, RadarRadius = 45, VisionRadius = 24 }
-- XSL0101 (Seraphim T1 Scout)
Intel = { Cloak = true, RadarRadius = 40, RadarStealth = true, StealthWaitTime = 1, VisionRadius = 24 }
-- UEL0301 (UEF Titan? — Jammer) 
Intel = { FreeIntel = false, JamRadius = {Max=26, Min=26}, JammerBlips = 10,
          OmniRadius = 16, VisionRadius = 26, WaterVisionRadius = 26 }
-- XRA0305 (Cybran Jammer-Gunship) + ToggleCaps { RULEUTC_JammingToggle = true }
Intel = { JamRadius = {Max=40, Min=10}, JammerBlips = 4, VisionRadius = 32 }
-- XSL0301 (Seraphim ACU?) 
Intel = { FreeIntel = true, OmniRadius = 16, VisionRadius = 26, WaterVisionRadius = 26 }
```

### Nur 7 Jammer-Units in Vanilla FA
`UEL0301, UES0103, XEL0209, XRA0305, XSC9002, XSC9010, XSC9011`
### Nur 4 Cloak-Units
`URL0001, URL0101, URL0301, XSL0101`

---

## Minimal-Nachbau-Checkliste
1. `IntelGrid`-Klasse: `Int8Array`, `mGridSize`, `addCircle/subtractCircle/isVisible(x,z)/isVisible(rect)/tick(dTicks)` — Raster-Loop exakt halboffen, Radius per Integer-Division in Zellen.
2. Pro Armee 8 Grids mit den Zellgrößen 2 (Vision) / 4 (Rest). Vision+Water nur bei FoW.
3. `IntelHandle` pro Unit-Sinn mit `enabled`, `radius`, `lastPos`, `lastTickUpdated`; Bewegungsschwelle `radius*0.333` bzw. 30 Ticks.
4. Counter-Handles rastern in die RCI/SCI/VCI-Grids **aller anderen** Armeen.
5. `ReconTick` round-robin (`tick % armyCount`), `ReconRefresh` für den Rest.
6. Blips mit `SPerArmyReconInfo[armyCount]`, sticky `LOSEver|KnownFake` (0x30), Ghost-Regel für `!IsMobile()`.
7. Detection: LOS → Sonar (nur Wasser-Layer) → Radar (nur nicht-unterwasser) → Omni; dann Ally-Merge; dann Counter mit Omni-Bypass.
8. FoW-Rendering: instanced Discs in eine Reveal-Textur; zwei Kanäle (Explored akkumulierend, Fog aktuell).

## Refs
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/CIntelGrid.h — CIntelGrid-Layout (0x24), SDelayedSubVizInfo (0x14)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/CIntelGrid.cpp:454 — Ctor: width=(heightField->width-1)/cellSize
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/CIntelGrid.cpp:579-602 — AddCircle/SubtractCircle/DelayedSubtractCircle (30 Ticks)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/CIntelGrid.cpp:657 — Raster() (halboffene Kreisscheibe, +/-1)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/CIntelGrid.cpp:488-574 — IsVisible(x,z) / IsVisible(Rect2i) (floor/ceil)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/ai/CAiReconDBImpl.h:516-533 — 8 Grid-Slots + mFogOfWar + mVisibleToReconCategory
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/ai/CAiReconDBImpl.cpp:1202-1212 — Gridgrößen: Vision=2, alle anderen=4
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/ai/CAiReconDBImpl.cpp:1277 — ReconTick (Blip-Lifecycle, Ghost-Regel Zeile 1366-1378)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/ai/CAiReconDBImpl.cpp:1555 — RefreshBlip (Daten nur bei RECON_LOSNow)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/ai/CAiReconDBImpl.cpp:1586 — UpdateBlip (sticky 0x30, KnownFake-Entlarvung)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/ai/CAiReconDBImpl.cpp:1688 — UpdateBlips (Fake-Blip-Anzahl-Abgleich)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/ai/CAiReconDBImpl.cpp:1809 — GetNewReconFor (LOS/Sonar/Radar/Omni)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/ai/CAiReconDBImpl.cpp:1864 — ApplyReconCounters (Omni-Bypass, Stealth nur ausserhalb LOS)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/ai/CAiReconDBImpl.cpp:1915/1962/2009/2054 — GetReconFlags / GetReconFlagsForRect / GetDetection / DoCounterDetection
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/ai/CAiReconDBImpl.cpp:872 — GetActiveJammerBlipCount
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/ai/IAiReconDB.h:33 — EReconFlags
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/ReconBlip.h:44-117 — SPerArmyReconInfo (0x34)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/ReconBlip.h:184-500 — ReconBlip (0x4D0), IsOnRadar/IsOnSonar/IsOnOmni/IsSeenEver/IsKnownFake
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/ReconBlip.cpp:674 — ComputeJamOffset (Gauss-Richtung + JamRadius Min/Max)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/ReconBlip.cpp:1474 — ReconBlip::Refresh (mJamOffset-Addition)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/ReconBlip.cpp:1513/1789 — DestroyIfUnused / UpdateVisibility (mNeedsFlush)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/entity/intel/CIntel.h:43-183 — CIntel (0x30): 9 Handles + 5 Toggles
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/entity/intel/CIntel.cpp:193 — Ctor aus Blueprint; :271 Update; :420 InitIntel-Switch (WIDERSPRUCH zu EIntel bei 10-13)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/entity/intel/CIntelCounterHandle.h:20 — EIntelCounter (RadarStealthField=1, SonarStealthField=2, CloakField=8)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/entity/intel/CIntelCounterHandle.cpp:102-157 — ApplyCounterIntelToReconGrid / ApplyCounterIntelToForeignArmies
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/entity/intel/CIntelPosHandle.cpp:149 — UpdatePos (Schwelle radius*0.333 / 30 Ticks)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/entity/EntityPositionWatchEntry.h — mLastPos/mRadius/mLastTickUpdated/mEnabled (0x1C)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/unit/core/EIntelTypeInfo.h:10 — EIntel-Enum (kanonische Namen/IDs)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/Sim.cpp:12018-12049 — Recon-Round-Robin (mCurTick % armyCount)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/UserArmy.h:25-86 — EReconGridMask + 8 Client-Grids (Explored/Fog/...)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/UserArmy.cpp:1441 — CanSeeCell (Explored/Fog + Ally-Merge)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/CWldMap.cpp:1453 — TerrainRectVisibleForFocusArmy
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/CArmyImpl.cpp:1980-1998 — CopyConstantDataToUserArmy (Grid-Handoff Sim→Client)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/vision/VisionDB.h + VisionDB.cpp:554/584/683 — Quadtree Init/GenerateQuadTree(maxLevel=1)/Handle::Update
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/render/VisionRenderer.cpp:20-26,80-189 — 45-Segment-Zylinder, 92 Verts / 540 Indices, Effekt "vision", 12288 Instanzen
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/entity/UserEntity.cpp:639 — VisionDB-Handle pro Entity (alliedVisibility)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/resource/blueprints/RUnitBlueprint.h:306 — RUnitBlueprintIntel (exakte Offsets)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/resource/blueprints/RUnitBlueprintCapabilityEnums.h:37 — ERuleBPUnitToggleCaps (RULEUTC_*)
- gamedata/mohodata.scd :: lua/sim/Blip.lua — Blip = Class(moho.blip_methods) (nur DestroyHooks)
- gamedata/mohodata.scd :: lua/sim/VizMarker.lua — InitIntel(army,'Omni'|'Radar'|'Vision'|'WaterVision',radius) + EnableIntel
- gamedata/lua.scd :: lua/sim/Unit.lua:309-397 — OnScriptBitSet/OnScriptBitClear (Toggle-Bits 0-8, invertiert)
- gamedata/lua.scd :: lua/sim/Unit.lua:1759-1915 — SetupIntel / DisableUnitIntel / EnableUnitIntel (Refcount) / ShouldWatchIntel / IntelWatchThread
- gamedata/units.scd :: units/UAB3101, UAL0101, XSB3201, URL0306, URL0101, XSL0101, UEL0301, XRA0305, XSL0301 (_unit.bp) — reale Intel-Tabellen
