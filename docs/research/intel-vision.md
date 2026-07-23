# agent4

## Summary
SupCom:FA's Intel system consists of two decoupled layers: (1) the SIM layer with per-army `CAiReconDBImpl`, which manages 8 counting Int8 coverage grids (`CIntelGrid`) and a blip tree (`ReconBlip` with per-army flags), and (2) the CLIENT layer with a quadtree (`VisionDB`) from vision circles that are rendered as 45-segment cylinders ("vision" effect) into a reveal mask. Visibility is NOT boolean per cell, but an Int8 refcount (AddCircle=+1 / SubtractCircle=-1), and detection runs via a 7-bit flag set `EReconFlags` (Radar/Sonar/Omni/LOSNow/LOSEver/KnownFake/MaybeDead) per (Blip × Army). The full recon tick runs round-robin: per sim tick only ONE army makes `ReconTick(dTicks=armyCount)`, all others only the cheap `ReconRefresh()`.

## Key Facts
- Grid resolution is hardwired into the CAiReconDBImpl-Ctor: Vision Grid = 2 world meters/cell, ALL others (Water, Radar, Sonar, Omni, RCI, SCI, VCI) = 4 world meters/cell; Grid Dims = (heightfield.width-1)/cellSize × (heightfield.height-1)/cellSize.
- CIntelGrid is an int8 COUNTER grid, not a bool: AddCircle=+1, SubtractCircle=-1 over the rasterized circular disk; IsVisible == (cell != 0). Radius is converted into cells using INTEGER DIVISION (radiusInCells = radius / gridSize) — Radar 115 → 28 cells, Vision 20 → 10 cells.
- Vision and water grids are ONLY created if fogOfWar=true; If FoW is off, GetNewReconFor/GetDetection immediately returns RECON_LOSNow (everything visible).
- Update clock of the Intel handles: CIntelPosHandle::UpdatePos only shifts the grid coverage if the movement is >= (radius * 0.333) OR >30 ticks have passed since the last update - otherwise nothing happens.
- Recon scheduling in Sim::Tick: reconTickIndex = mCurTick % armyCount; only this one army calls ReconTick(armyCount), all others ReconRefresh(). Full detection per army so only all armyCount ticks.
- EReconFlags: RECON_Radar=0x01, Sonar=0x02, Omni=0x04, LOSNow=0x08, LOSEver=0x10, KnownFake=0x20, MaybeDead=0x40. LOSEver|KnownFake (0x30) are STICKY — `newFlags |= (oldFlags & 0x30)` in UpdateBlip, are never deleted.
- The oldFlags parameter of all detect functions is a SENSE MASK (which senses to test), not a prestate — caller passes RECON_AnySense to check everything.
- Counter-Intel writes to the ENEMIES' grids: CIntelCounterHandle::AddViz iterates over all armies, skips its own ReconDB and calls AddCircle on their RCI/SCI/VCI grid. Omni beats EVERYTHING: ApplyReconCounters returns immediately if RECON_Omni is set.
- Ghost buildings: In ReconTick, units that are no longer detected are deleted (DeleteBlips) — UNLESS the blip has RECON_LOSEver and the unit is !IsMobile(); then it persists with UpdateBlips(unit, RECON_None). RefreshBlip overwrites Mesh/Health/FractionComplete ONLY with RECON_LOSNow → the ghost freezes the last known status.
- Jammer-Fake-Blips: Number = blueprint.Intel.JammerBlips (only if jamming toggle is active). Each fake blip gets an mJamOffset in ReconBlip-Ctor: random direction (2× Gauss, normalized in XZ) × (rand() × radius), radius = JamRadius.Min + rand*(Max-Min). ReconBlip::Refresh permanently adds this offset to the position.
- Fake blips are revealed as RECON_KnownFake as soon as: Omni detects them, LOSNow detects them, the source unit is gone/allied, or the blip position is outside the playable map radius.
- Client FoW has TWO grids per UserArmy: mExploredReconGrid (ever seen → terrain is drawn at all) and mFogReconGrid (currently visible). UserArmy::CanSeeCell(x,z,mask) checks own + allied grids with EReconGridMask {Explored=1, Fog=2}.
- FoW rendering is NOT a texture mask but geometry: VisionRenderer::Init builds a 45-segment cylinder (radius 1, y from -256 to +256, 92 verts / 540 indices) plus an instance vertex buffer (12288 instances of 12 bytes each = x,z,radius). Rendered using the D3D effect called "vision".
- Blueprint Intel fields (RUnitBlueprintIntel, exact order/offsets): VisionRadius, WaterVisionRadius, RadarRadius, SonarRadius, OmniRadius (uint32); RadarStealth, SonarStealth, Cloak, ShowIntelOnSelect (bool); RadarStealthFieldRadius, SonarStealthFieldRadius, CloakFieldRadius (uint32); JamRadius {Min,Max}; YammerBlips(uint8); SpoofRadius {Min,Max}.
- RULEUTC toggle bits (ERuleBPUnitToggleCaps, bit index = OnScriptBitSet/Clear argument): 0 Shield(1), 1 Weapon(2), 2 Jamming(4), 3 Intel(8), 4 Production(16), 5 Stealth(32), 6 Generic(64), 7 Special(128), 8 Cloak(256). ATTENTION: OnScriptBitSet = switch OFF, OnScriptBitClear = switch ON.

## Details
## 1. Sichtsystem — LoS vs Radar vs Sonar vs Omni

### Storage per army
Each army has a `CAiReconDBImpl` (`sdk/moho/ai/CAiReconDBImpl.h`) with **8 grids** (all `boost::shared_ptr<CIntelGrid>`):

| Grid | Cell size | Purpose | Only at FoW? |
|---|---|---|---|
| `mVisionGrid` | **2** | LoS over water/land | **yes** |
| `mWaterGrid` | 4 | LoS underwater | **yes** |
| `mRadarGrid` | 4 | Radar | no |
| `mSonarGrid` | 4 | Sonar | no |
| `mOmniGrid` | 4 | Omni | no |
| `mRCIGrid` | 4 | Radar counter (enemy stealth field) | no |
| `mSCIGrid` | 4 | Sonar counter | no |
| `mVCIGrid` | 4 | Vision Counter (Cloak Field) | no |

Ctor (`CAiReconDBImpl.cpp:1202-1212`):
```
mRadarGrid = MakeGrid(mMapData, 4);  // ... Sonar/Omni/RCI/SCI/VCI ebenfalls 4
if (fogOfWar) { mVisionGrid = MakeGrid(mMapData, 2); mWaterGrid = MakeGrid(mMapData, 4); }
```

### CIntelGrid — the core primitive (`sdk/moho/sim/CIntelGrid.cpp`)
- Fields: `STIMap* mMapData; int8_t* mGrid; uint32 mWidth, mHeight; <delayed-update-vector>; uint32 mGridSize;`
- Dims: `width = (heightField->width - 1) / cellSize`, analog height. Speicher = `width*height` Bytes, memset 0.
- **`Raster(pos, radiusInCells, doAdd)`**: `GridPos gp(pos, mGridSize)`; for `x` from `gp.x-r` to `gp.x+r` (**half-open**, `x < xMax`): `leg = (int)sqrt(r² - dx²)`, then `z` from `gp.z-leg` to `gp.z+leg` (**half-open**): `mGrid[x + z*width] += (doAdd ? +1 : -1)`. The half-open borders create a slightly asymmetrical disc - recreate exactly like this for 1:1 fidelity.
- `AddCircle(pos, radius)` → `Raster(pos, radius / mGridSize, true)` — **Integer-Division!**
- `SubtractCircle` → `Raster(..., false)`
- `DelayedSubtractCircle(pos, radius)` → pushes `{pos, radius, mTicksTilUpdate=30}`; `Tick(dTicks)` decrements and rasters with `<=0` with `-1`. **Note: there is no caller in the decomp** — presumably for "Sight freezes briefly after death"; cannot be reconstructed from the present code.
- `IsVisible(x,z)` = bounds-check + `mGrid[z*mWidth + x] != 0`
- `IsVisible(Rect2i)` = Rect → Grid bounds (**floor** for min, **ceil** for max), true if ANY cell != 0.

### Detection pipeline (per point)
`GetReconFlags(entity, pos, senseMask, belowWater)` (`CAiReconDBImpl.cpp:1915`):
1. `GetNewReconFor(...)` for your **own** army
2. For each army that has the viewer in `Allies`: `MergeFlags(combined, ally->GetNewReconFor(...))` — **Alliance view is ORed, but the viewer's counter intel is applied afterwards**
3. If `combined == RECON_None` → early exit
4. `ApplyReconCounters(entity, pos, combined)`

`GetNewReconFor` (`:1809`) — exact order:
- **GO**: if `mFogOfWar == 0 || mVisionGrid == null` → **immediately `RECON_LOSNow`** (no FoW = everything visible). Otherwise, if mask contains LOSNow: Grid = `belowWater ? mWaterGrid : mVisionGrid`, `IsVisible(pos)` → LOSNow.
- **Sonar**: only if `belowWater || UsesWaterSenseLane(entity->mCurrentLayer)` (Layer Seabed/Sub/Water) AND Mask Sonar AND `mSonarGrid->IsVisible(pos)`.
- **Radar**: only if `!belowWater` AND mask radar AND `mRadarGrid->IsVisible(pos)`.
- **Omni**: Mask Omni AND `mOmniGrid->IsVisible(pos)`. (No layer limitation.)

`ApplyReconCounters` (`:1864`) — **Omni overwrites everything**:
```
if (flags & RECON_Omni) return flags;               // Omni ignoriert JEDE Counter-Intel
if (RCI-Grid sichtbar an pos)  flags &= ~RECON_Radar;   // fremdes Radar-Stealthfeld
if (SCI-Grid sichtbar an pos)  flags &= ~RECON_Sonar;
if (aktiver Cloak-Toggle der Unit || VCI-Grid sichtbar) flags &= ~RECON_LOSNow;
if (!(flags & RECON_LOSNow)) { // personal stealth ONLY works outside LOS
   if (unit.RadarStealth aktiv) flags &= ~RECON_Radar;
   if (unit.SonarStealth aktiv) flags &= ~RECON_Sonar;
}
```
The Rect variant (`GetReconFlagsForRect` / `GetDetection` / `DoCounterDetection`, `:1962-2070`) is structurally identical, but uses `IsVisible(rect)` and `pingSense = isUnderwater ? Sonar : Radar` (only ONE ping sense instead of both).

`ReconCanDetect(rect, y, oldFlags)`: `isUnderwater = (map.WaterEnabled ? map.WaterElevation : -10000.0f) > y`.

### Update-Takt
- **Handle level** (`CIntelPosHandle::UpdatePos`, `CIntelPosHandle.cpp:149`): Coverage is only re-rasterized if `distSq >= (radius*0.333)²` **or** `curTick - mLastTickUpdated > 30`. Otherwise just position storage. → Nothing happens with small movements; Grid churn is limited.
- `CIntel::Update(pos, tick)` (`CIntel.cpp:271`): for each of the 9 handles: when `mEnabled` and position changed → `SubViz(); mLastPos = pos; AddViz();` (radius is saved/restored around the call). Then always `mLastTickUpdated = tick`.
- **Sim level** (`Sim.cpp:12018-12049`):
```
reconTickIndex = mCurTick % armyCount;
for i in armies: (i == reconTickIndex) ? reconDb->ReconTick(armyCount) : reconDb->ReconRefresh();
```
→ **Full recon tick per army only every `armyCount` ticks**, with `dTicks = armyCount`. `ReconRefresh()` (every tick, all other armies) only does `RefreshBlip()` per blip (Mesh/Health/MaybeDead sync). Before that, global `RefreshBlips()` (transform sync of all blips) runs.

---

## 2. Blips

### ReconBlip (`sdk/moho/sim/ReconBlip.h`, size 0x4D0, erbt `Entity`)
A blip is a **real sim entity** (not a pure UI object) and is pushed to the client as a unit via `CreateInterface`. Important fields:
- `WeakPtr<Unit> mCreator` (+0x270) — source unit
- `uint8 mDeleteWhenStale` (+0x278) — in the Ctor: `sourceUnit->IsMobile() ? 1 : 0`
- `Wm3::Vec3f mJamOffset` (+0x27C)
- `SReconBlipUnitConstData mUnitConstDat` (+0x288) — contains `mFake`
- `SReconBlipUnitVarData mUnitVarDat` (+0x298) — `mCustomName`, `mBlueprintState0/1`
- `msvc8::vector<SPerArmyReconInfo> mReconDat` (+0x4C0) — **one entry per army**

### SPerArmyReconInfo (0x34 bytes) — the per-army state
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
“Blip types” do not exist as an enum — the display type results from the flag combination per army:
- only `Radar`/`Sonar` → unknown contact (red dot, no model)
- `Omni` → Type known, model visible, but possibly no LOS
- `LOSNow` → real unit, live data
- `LOSEver` without LOSNow → Ghost/last known status
- `KnownFake` → exposed as a whining fake
- `MaybeDead` → Source gone, Blip remains as a file corpse

Query API on ReconBlip: `IsOnRadar(army)`, `IsOnSonar(army)`, `IsOnOmni(army)`, `IsSeenNow(army)` (LOSNow), `IsSeenEver(army)` (LOSEver), `IsKnownFake(army)`, `IsMaybeDead(army)`, `GetFlags(army)`.

### When does a blip become a real unit
There is **no Blip→Unit transition** — the blip always remains a blip. What changes is the data content in `RefreshBlip` (`CAiReconDBImpl.cpp:1555`):
```
if (flags & RECON_LOSNow) {           // NUR bei LOS werden echte Daten kopiert
    perArmy->mMeshTypeClassId = sourceUnit->mMeshTypeClassId;
    perArmy->mHealth = sourceUnit->Health;
    perArmy->mMaxHealth = sourceUnit->MaxHealth;
    perArmy->mFractionComplete = sourceUnit->FractionCompleted;
}
if (flags & RECON_AnySense) perArmy->mMaybeDead = sourceUnit->IsDead();
```
And in `UpdateBlip` (`:1586`) LOSNow also copies `mCustomName` and sets `RECON_LOSEver`.

### Blip-Lifecycle in ReconTick (`:1277`)
1. Go through orphan blips (`mTempBlips`): delete if blip army allies OR detectable via LOSNow.
2. Map blips: source unit dead/gone? → if **not** fake: `ClearPerArmyRecon`. If fake: delete if allied/LOS visible, otherwise set `RECON_MaybeDead` and move to `mTempBlips`. Delete node from the map.
3. For **each** enemy unit (non-allied, `DestroyQueued()==false`, in category `VISIBLETORECON`):
   - `detectFlags = ReconCanDetect(unit, unit.pos, RECON_AnySense)`
   - `detectFlags != None`: no blip present → `AppendPendingNewBlip`; otherwise `UpdateBlips(...)`
   - `detectFlags == None` and blip exists: **ghost rule** — if `(flags & RECON_LOSEver) && !unit->IsMobile()` → `UpdateBlips(unit, RECON_None, ...)` (blip remains); otherwise `DeleteBlips(unit)`
4. `GenerateNewBlips(pending)` → `FindOrCreateBlip` (recycles existing blip with matching `IsFake()` and `mNeedsFlush==0`) + `UpdateBlip` + `InsertMapNode`.
5. `TickAllReconGrids(dTicks)`.

`ReconBlip::DestroyIfUnused()`: deleted if source gone/fake AND **no** `mNeedsFlush` is set in any army.
`ReconBlip::UpdateVisibility()`: `mVisibilityState = (focusArmy != -1 && mReconDat[focusArmy].mNeedsFlush != 0)`.

Intel events: `CheckIntelEvents(blip, old, new)` diffed and fires `OnIntelChange` per Sinn (LOSNow, Radar, Sonar, Omni) into the Army script.

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
`CIntelToggleState = { uint8 present; uint8 enabled; }` — `present` comes from the blueprint, `enabled` from the toggle bit.

Ctor from Blueprint (`CIntel.cpp:193`):
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
if (army->GetReconDB() == this->mReconDB) continue;   // skip your own army
   grid = (mType==RadarStealthField) ? reconDB->ReconGetRCIGrid()
        : (mType==SonarStealthField) ? reconDB->ReconGetSCIGrid()
        : (mType==CloakField)        ? reconDB->ReconGetVCIGrid() : null;
   grid->AddCircle(mLastPos, mRadius);   // bzw. SubtractCircle
}
```
**Important for replication:** Stealth/Cloak fields are not a query time check, but are actively gridded into the RCI/SCI/VCI grids of ALL other armies. This can be simplified if you only have 2 armies, but not if you have n armies.

Guard: `AddViz`/`SubViz` do nothing if `mEnabled==0 || mRadius==0`.

### Jamming / Fake-Blips
- Number: `GetActiveJammerBlipCount(unit)` (`CAiReconDBImpl.cpp:872`) = `blueprint.Intel.JammerBlips`, **but only if `intel->HasActiveJamming()`** (`mJamming.present && mJamming.enabled`), otherwise 0.
- `UpdateBlips` (`:1688`) keeps the fake number exactly: excess fakes → `DeleteBlip`; missing → `AppendPendingNewBlip(pending, unit, fake=1, detectedFlags)`.
- `ComputeJamOffset(unit, sim)` (`ReconBlip.cpp:674`) — **once in the Ctor**, then fixed:
```
range      = max(0, JamRadius.max - JamRadius.min)
radiusStep = (uint32)((uint64)range * rng.NextUInt32() >> 32)
radius     = (float)(JamRadius.min + radiusStep)
dir        = normalize(Vec3(rng.FRandGaussian(), 0, rng.FRandGaussian()))   // nur XZ
scale      = ToUnitFloat(rng.NextUInt32()) * radius
offset     = dir * scale
```
- `ReconBlip::Refresh()` adds `mJamOffset` to position AND PendingPosition of the source unit → the fake blip moves rigidly offset.
- **Debunking** (`UpdateBlip`, `:1631`): `RECON_KnownFake` is set if `RECON_Omni` OR `RECON_LOSNow` is set OR no source unit exists OR the source is allied OR the blip position is outside the playable map radius (`IsWithinPlayableMapRadius(map, blip->Position, max(footprint.X, footprint.Z), useWholeMap)` == false).
- `Spoof` is present in the blueprint struct (`SpoofRadius {Min,Max}`), but is not used in **any** vanilla FA blueprint (0 hits across all `*_unit.bp`) — dead feature.

### RULEUTC-Toggles
`ERuleBPUnitToggleCaps` (`RUnitBlueprintCapabilityEnums.h:37`):
```
RULEUTC_ShieldToggle=1, WeaponToggle=2, JammingToggle=4, IntelToggle=8,
ProductionToggle=16, StealthToggle=32, GenericToggle=64, SpecialToggle=128, CloakToggle=256
```
Bit index (= argument of `OnScriptBitSet/Clear`) = 0..8 in this order.

**Attention inversion** (`lua/sim/Unit.lua:309`): `OnScriptBitSet(bit)` = Feature **OFF**, `OnScriptBitClear(bit)` = Feature **ON**.
- bit 2 (Jamming): Clear → `EnableUnitIntel('Jammer')`; Set → `DisableUnitIntel('Jammer')`
- bit 3 (Intel): Clear → Enable of Radar, RadarStealth, RadarStealthField, SonarStealth, SonarStealthField, Sonar, Omni, Cloak, CloakField, Spoof, Jammer. Set → Disable same + additional `'Radar'`.
- bit 5 (Stealth): only RadarStealth, RadarStealthField, SonarStealth, SonarStealthField
- bit 8 (Cloak): only `'Cloak'`
All four also call `SetMaintenanceConsumptionActive/Inactive()` + ambient sound.

### Lua-Intel-API (Refcount-basiert!)
`lua/sim/Unit.lua:1759ff`:
- `SetupIntel()`: `EnableIntel('Vision')` always; then `IntelDisables = {Radar=1, Sonar=1, Omni=1, RadarStealth=1, SonarStealth=1, RadarStealthField=1, SonarStealthField=1, Cloak=1, CloakField=1, Spoof=1, Jammer=1}` and `EnableUnitIntel(nil)` → all down to 0 which turns them on.
- `DisableUnitIntel(t)` / `EnableUnitIntel(t)` are **counters**: Engine-`DisableIntel`/`EnableIntel` only fires on 0↔1 transition. Multiple sources (toggle, power failure) can be disabled independently.
- `EnableUnitIntel` also switches on `WaterVision` if Layer ∈ {Seabed, Sub, Water}.
- `IntelWatchThread`: every 0.5 s `GetResourceConsumed()`; once `< 1` → `DisableUnitIntel(nil)`, wait `bp.Intel.ReactivateTime or 10` seconds, then `EnableUnitIntel(nil)`. Only runs if `ShouldWatchIntel()` (not `FreeIntel`, `Economy.MaintenanceConsumptionPerSecondEnergy > 0` and at least one Intel field set).

### Eintel IDs — CONTRADICTION IN DECOMP (important!)
`sdk/moho/unit/core/EIntelTypeInfo.h:10` (Reflection registered, for Lua string→ID):
```
None=0, Vision=1, WaterVision=2, Radar=3, Sonar=4, Omni=5,
RadarStealthField=6, SonarStealthField=7, CloakField=8, Jammer=9,
Spoof=10, Cloak=11, RadarStealth=12, SonarStealth=13
```
But `CIntel::InitIntel` switch (`CIntel.cpp:440`) has: `case 9 → mJamming`, **`case 11 → mSpoof`**, **`case 12 → mSonarStealth`**, **`case 13 → mRadarStealth`**, and **no case 10**. This contradicts the header at 10-13 (Spoof/Cloak swapped, RadarStealth/SonarStealth swapped) and Cloak has no case at all.
→ **Recommendation for the replica: Dispatch via the NAME, not the number.** The numerical IDs are only relevant for save game compatibility, which you don't need anyway. Take the name list from `EIntelTypeInfo` as canonical.

---

## 4. Fog of War Rendering

**Not a texture mask in the classic sense — it's stencil/mask geometry.**

### Client-Grids (`sdk/moho/sim/UserArmy.h`)
`UserArmy` (= view on `SSTIArmyConstantData`, filled via `CArmyImpl::CopyConstantDataToUserArmy`) holds 8 `shared_ptr<CIntelGrid>`:
`mExploredReconGrid, mFogReconGrid, mWaterReconGrid, mRadarReconGrid, mSonarReconGrid, mOmniReconGrid, mRciReconGrid, mSciReconGrid`
```
enum class EReconGridMask : uint8 { None=0, Explored=1, Fog=2, Both=3 };
bool CanSeeCell(x, z, mask) const;    // 0x008B17F0
bool CanSeePoint(worldPos, mask) const; // 0x008B22B0 -> GridPos(pos, exploredGrid->mGridSize) -> CanSeeCell
```
`CanSeeCell` (`UserArmy.cpp:1441`):
- no `mExploredReconGrid` or `RenderFogOfWarEnabled()==false` → **true** (all visible)
- `Explored` bit and `exploredGrid->IsVisible(x,z)` → true
- `Fog` bit and `mFogReconGrid->IsVisible(x,z)` → true
- otherwise iterate over all allied `UserArmy` and check their explored/fog grids

**Zwei-Stufen-Fog:**
- `mExploredReconGrid` = ever revealed → terrain is rendered at all (otherwise black/shroud)
- `mFogReconGrid` = currently in sight → full brightness (otherwise darkened/gray)

`TerrainRectVisibleForFocusArmy` (`CWldMap.cpp:1453`) uses exactly this for terrain dirty rect culling: rect is only synchronized when `exploredGrid->IsVisible(rect) || fogGrid->IsVisible(rect)` (or an ally sees it).

> **Gap:** Where `mExploredReconGrid`/`mFogReconGrid` are **filled** (AddCircle calls), is not restored in decomp — only the propagation (`CArmyImpl.cpp:1989`) and query. But the semantics are clear: Explored only accumulates (never SubtractCircle), Fog follows the current vision coverage.

### Reveal-Geometrie: VisionDB + VisionRenderer
`VisionDB` (`sdk/moho/vision/VisionDB.h/.cpp`, **client-side**, size 0x24) — Quadtree from perspective circles:
- `Init(width, height)`: Root node = circle around `(w/2, h/2)` with `radius = 2 * sqrt((w/2)² + (h/2)²)`; then `GenerateQuadTree(root, halfSize, level=0, maxLevel=1)` → **only 1 subdivision level** (4 quadrants NW/SW/NE/SE), each with `radius = halbe Diagonale` of the subrectangle.
- `Pool::PooledNode` (0x28): `mParent, mContained, mNext, uint8 mIsReal, uint8 mVis, EntryCircle mPrevCircle {x,y,radius}, EntryCircle mCurCircle`. Pool allocated in blocks of 500.
- `Handle::Update(next, previous, radius, visible)`: writes `mVis`, `mPrevCircle`, `mCurCircle` and **reparentet** into the tree when the containment condition no longer applies. Prev+Cur are both saved → interpolation/smear between sim ticks.

Erzeugt in `UserEntity::Update` (`UserEntity.cpp:639`):
```
if (!RenderFogOfWarEnabled() || !mSession) return;
visionRange = GetVisionRange(mVariableData);
if (visionRange != 0 && !mVisionHandle) mVisionHandle = session->visionDb.NewHandle(zero, zero);
if (!mVisionHandle || IsUserUnit()) return;
alliedVisibility = IsVisionEnabled(varData) && focusArmy->IsAlly(mArmy->mArmyIndex);
mVisionHandle->Update(curPos.xz, lastPos.xz, (float)visionRange, alliedVisibility);
```

`VisionRenderer` (`sdk/moho/render/VisionRenderer.cpp`) builds the reveal geometry:
- **45 Segmente**, `angleStep = 0.13962634` (= 2π/45)
- **92 Vertices**: 45 oben (`cos(a), +256, sin(a)`), 45 unten (`cos(a), -256, sin(a)`), + 2 Center-Verts (Index 90 = `(0,+256,0)`, Index 91 = `(0,-256,0)`)
- **540 Indices**: 45×6 for the coat (2 Tris/Segment) + 45×6 for the two caps
- → i.e. a **unit cylinder** (radius 1, y ∈ [-256, +256]), which is scaled/shifted per instance with (x, z, radius).
- Instanz-Vertexbuffer: `width_=12288, height_=12, type_=3, usage_=2` → 12288 Instanzen à 12 Byte (3 floats)
- Shader: `D3D_GetDevice()->GetResources()->FindEffect("vision")` (`VisionRenderer.cpp:34`)

**Replica in WebGL/Three.js:** Render the instanced cylinder (or more simply: instanced quad/disc) into an offscreen R8 texture (additive or stencil), then calculate it as a reveal mask in the terrain shader against the explored mask. The cylinder with y ∈ [-256, +256] is only there to penetrate arbitrary terrain heights — for a top-down mask render, a flat circle is sufficient.

### Last known status of buildings (revisibility)
Completely SIM side (see §2):
1. `ReconTick`: Unit no longer detected + Blip has `RECON_LOSEver` + `!unit->IsMobile()` → Blip survives with `UpdateBlips(unit, RECON_None, ...)`.
2. `UpdateBlip`: `newFlags |= (oldFlags & 0x30)` → `LOSEver` and `KnownFake` remain sticky.
3. `RefreshBlip`: Mesh/Health/MaxHealth/FractionComplete are **only** updated with `RECON_LOSNow` → the Ghost retains construction progress, HP bars and model status from the last visual contact.
4. Mobile Units (`mDeleteWhenStale = IsMobile()`) → `DeleteBlips`, no ghost.
5. If visible again: `RECON_LOSNow` comes back → `RefreshBlip` overwrites all fields with live data.

---

## 5. Blueprint fields

### RUnitBlueprintIntel (`sdk/moho/resource/blueprints/RUnitBlueprint.h:306`) — exact binary structure
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

### Lua keys actually used in vanilla FA (scan over all `units/*/*_unit.bp` in units.scd, with number of hits)
| Key | #BPs | Engine field? |
|---|---|---|
| `VisionRadius` | 391 | ja |
| `WaterVisionRadius` | 71 | ja |
| `SonarRadius` | 67 | ja |
| `RadarRadius` | 57 | ja |
| `ShowIntelOnSelect` | 24 | ja |
| `ReactivateTime` | 19 | **no — Lua only** (`IntelWatchThread`) |
| `OmniRadius` | 17 | ja |
| `RadarStealth` | 15 | ja |
| `SonarStealth` | 9 | ja |
| `FreeIntel` | 8 | **no — Lua only** (`ShouldWatchIntel`) |
| `JamRadius {Min,Max}` | 7 | ja |
| `JammerBlips` | 7 | ja |
| `RadarStealthFieldRadius` | 7 | ja |
| `SonarStealthFieldRadius` | 7 | ja |
| `Cloak` | 4 | ja |
| `RemoteViewingRadius` | 2 | **no — only Lua** (Eye of Rhianne) |
| `RadarStealthField` | 1 | **no — only Lua** (redundant bool) |
| `VisionRadiusOnDeath` / `IntelDurationOnDeath` | 1 | **no — only Lua** |
| `MinVisionRadius` / `MaxVisionRadius` | 1 | **no — only Lua** |
| `StealthWaitTime` | 1 | **no — only Lua** |
| `SpoofRadius` | **0** | yes, but unused |

### Concrete examples (verified from units.scd)
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

### Only 7 jammer units in vanilla FA
`UEL0301, UES0103, XEL0209, XRA0305, XSC9002, XSC9010, XSC9011`
### Only 4 cloak units
`URL0001, URL0101, URL0301, XSL0101`

---

## Minimal-Nachbau-Checkliste
1. `IntelGrid` class: `Int8Array`, `mGridSize`, `addCircle/subtractCircle/isVisible(x,z)/isVisible(rect)/tick(dTicks)` — grid loop exactly half-open, radius via integer division into cells.
2. 8 grids per army with cell sizes 2 (vision) / 4 (rest). Vision+Water only at FoW.
3. `IntelHandle` per unit sense with `enabled`, `radius`, `lastPos`, `lastTickUpdated`; Motion threshold `radius*0.333` or 30 ticks.
4. Counter handles grid into the RCI/SCI/VCI grids of **all other** armies.
5. `ReconTick` round-robin (`tick % armyCount`), `ReconRefresh` for the rest.
6. Blips with `SPerArmyReconInfo[armyCount]`, sticky `LOSEver|KnownFake` (0x30), ghost rule for `!IsMobile()`.
7. Detection: LOS → Sonar (water layer only) → Radar (non-underwater only) → Omni; then Ally-Merge; then counter with omni bypass.
8. FoW rendering: instanced discs into a reveal texture; two channels (Explored accumulating, Fog current).

## Refs
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/CIntelGrid.h — CIntelGrid-Layout (0x24), SDelayedSubVizInfo (0x14)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/CIntelGrid.cpp:454 — Ctor: width=(heightField->width-1)/cellSize
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/CIntelGrid.cpp:579-602 — AddCircle/SubtractCircle/DelayedSubtractCircle (30 Ticks)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/CIntelGrid.cpp:657 — Raster() (halboffene Kreisscheibe, +/-1)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/CIntelGrid.cpp:488-574 — IsVisible(x,z) / IsVisible(Rect2i) (floor/ceil)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/ai/CAiReconDBImpl.h:516-533 — 8 Grid-Slots + mFogOfWar + mVisibleToReconCategory
- C:/Users/Marti/Documents/02Projects/faf/Draiget/faf-re/src/sdk/moho/ai/CAiReconDBImpl.cpp:1202-1212 — Grid sizes: Vision=2, all others=4
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/ai/CAiReconDBImpl.cpp:1277 — ReconTick (Blip-Lifecycle, Ghost-Regel Zeile 1366-1378)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/ai/CAiReconDBImpl.cpp:1555 — RefreshBlip (data only with RECON_LOSNow)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/ai/CAiReconDBImpl.cpp:1586 — UpdateBlip (sticky 0x30, KnownFake-Entlarvung)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/ai/CAiReconDBImpl.cpp:1688 — UpdateBlips (fake blip count comparison)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/ai/CAiReconDBImpl.cpp:1809 — GetNewReconFor (LOS/Sonar/Radar/Omni)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/ai/CAiReconDBImpl.cpp:1864 — ApplyReconCounters (Omni-Bypass, stealth only outside LOS)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/ai/CAiReconDBImpl.cpp:1915/1962/2009/2054 — GetReconFlags / GetReconFlagsForRect / GetDetection / DoCounterDetection
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/ai/CAiReconDBImpl.cpp:872 — GetActiveJammerBlipCount
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/ai/IAiReconDB.h:33 — EReconFlags
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/ReconBlip.h:44-117 — SPerArmyReconInfo (0x34)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/ReconBlip.h:184-500 — ReconBlip (0x4D0), IsOnRadar/IsOnSonar/IsOnOmni/IsSeenEver/IsKnownFake
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/ReconBlip.cpp:674 — ComputeJamOffset (Gauss-Richtung + JamRadius Min/Max)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/ReconBlip.cpp:1474 — ReconBlip::Refresh (mJamOffset-Addition)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/ReconBlip.cpp:1513/1789 — DestroyIfUnused / UpdateVisibility (mNeedsFlush)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/entity/intel/CIntel.h:43-183 — CIntel (0x30): 9 Handles + 5 Toggles
- C:/Users/Marti/Documents/02Projects/faf/Draiget/faf-re/src/sdk/moho/entity/intel/CIntel.cpp:193 — Ctor from Blueprint; :271 update; :420 InitIntel switch (CONTRADICTION to Eintel at 10-13)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/entity/intel/CIntelCounterHandle.h:20 — EIntelCounter (RadarStealthField=1, SonarStealthField=2, CloakField=8)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/entity/intel/CIntelCounterHandle.cpp:102-157 — ApplyCounterIntelToReconGrid / ApplyCounterIntelToForeignArmies
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/entity/intel/CIntelPosHandle.cpp:149 — UpdatePos (Schwelle radius*0.333 / 30 Ticks)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/entity/EntityPositionWatchEntry.h — mLastPos/mRadius/mLastTickUpdated/mEnabled (0x1C)
- C:/Users/Marti/Documents/02Projects/faf/Draiget/faf-re/src/sdk/moho/unit/core/EIntelTypeInfo.h:10 — EIntel enum (canonical names/IDs)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/Sim.cpp:12018-12049 — Recon-Round-Robin (mCurTick % armyCount)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/UserArmy.h:25-86 — EReconGridMask + 8 Client-Grids (Explored/Fog/...)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/UserArmy.cpp:1441 — CanSeeCell (Explored/Fog + Ally-Merge)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/CWldMap.cpp:1453 — TerrainRectVisibleForFocusArmy
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/sim/CArmyImpl.cpp:1980-1998 — CopyConstantDataToUserArmy (Grid-Handoff Sim→Client)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/vision/VisionDB.h + VisionDB.cpp:554/584/683 — Quadtree Init/GenerateQuadTree(maxLevel=1)/Handle::Update
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/render/VisionRenderer.cpp:20-26,80-189 — 45-Segment-Zylinder, 92 Verts / 540 Indices, Effekt "vision", 12288 Instanzen
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/entity/UserEntity.cpp:639 — VisionDB handle per entity (alliedVisibility)
- C:/Users/Marti/Documents/02Projekte/faf/Draiget/faf-re/src/sdk/moho/resource/blueprints/RUnitBlueprint.h:306 — RUnitBlueprintIntel (exact offsets)
- C:/Users/Marti/Documents/02Projects/faf/Draiget/faf-re/src/sdk/moho/resource/blueprints/RUnitBlueprintCapabilityEnums.h:37 — ERuleBPUnitToggleCaps (RULEUTC_*)
- gamedata/mohodata.scd :: lua/sim/Blip.lua — Blip = Class(moho.blip_methods) (DestroyHooks only)
- gamedata/mohodata.scd :: lua/sim/VizMarker.lua — InitIntel(army,'Omni'|'Radar'|'Vision'|'WaterVision',radius) + EnableIntel
- gamedata/lua.scd :: lua/sim/Unit.lua:309-397 — OnScriptBitSet/OnScriptBitClear (toggle bits 0-8, inverted)
- gamedata/lua.scd :: lua/sim/Unit.lua:1759-1915 — SetupIntel / DisableUnitIntel / EnableUnitIntel (Refcount) / ShouldWatchIntel / IntelWatchThread
- gamedata/units.scd :: units/UAB3101, UAL0101, XSB3201, URL0306, URL0101, XSL0101, UEL0301, XRA0305, XSL0301 (_unit.bp) — real Intel tables
