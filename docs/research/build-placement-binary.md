# Build-placement validity — from the binary

How the engine decides whether a structure may be built at a location (the
red/green ghost, and the authoritative placement check). All line numbers refer
to `Cfile/ForgedAlliance.exe.c`.

Entry point (Lua): `brain:CanBuildStructureAt(bp, loc)` →
`cfunc_CAiBrainCanBuildStructureAtL` (737074) → `Moho::CAiBrain::CanBuildStructureAt`
(726373). The player's ghost preview uses this same query. Its heart is
`func_LocationIsFree` (1044976, addr 0x720D90), which calls `OCCUPY_Check`
(709196, 0x565100).

## Grid constants

- **Cell size = 1 world unit = 1 heightfield quad.** All grid math indexes
  `heightField.data[x + z*width]` directly (709032, 708730).
- **Height decode:** `elev = rawU16 * 0.0078125` (= 1/128) (709035, 708758).
- **Layer bit enum `EOccupancyCaps`:** `OC_LAND=1, OC_SEABED=2, OC_SUB=4,
  OC_WATER=8, OC_AIR=0x10`; composite `OC_TERRAIN=7` (1045494, 1045526),
  `OC_ANY=~0` (sentinel "compute caps", 1044792).

## COGrid — the occupancy grid (ctor 1044616)

- Members: `mTerrainOccupation`, `mWaterOccupation`, `mOccupation` (all
  `gpg::BitArray2D`) + `mEntityOccupationManager`.
- **Dimensions = `(heightField.width − 1) × (heightField.height − 1)`**
  (1044625-1044630): one cell per heightmap quad.
- **One bit per cell per grid**, packed 32-per-int along Z: index
  `ptr[x + width*(z>>5)]`, bit `1 << (z&31)` (1044804, 1044816).
- **STAMP on placement — `COGrid::ExecuteOccupy(caps, rect)`** (1045489):
  `if caps & OC_TERRAIN(7) → FillRect(mTerrainOccupation, rect, 1)`;
  `if caps & OC_WATER(8) → FillRect(mWaterOccupation, rect, 1)`; then
  `PathQueue::DirtyClusters(rect)`. Reached via `Unit::ReserveOgridRect`
  (816453).
- **CLEAR on death — `ReleaseOccupy` / sub_721B30** (1045524): same rects,
  `FillRect(..., 0)`, masks `&7` terrain / `&8` water. Via `Unit::FreeOgridRect`
  (815914).

## OCCUPY_Check (709196) — ordered checks for a structure (`!IsMobile`)

1. `dest->layers = 0`; read `Footprint.OccupancyCaps`, `Footprint.SizeX/SizeZ`.
2. Snap top-left cell = `pos − Size*0.5`; `COORDS_ToWorldPos → dest->pos` (the
   snapped centre).
3. `GetSkirtRect(pos, bp)` → float skirt rect; **round to int cells** via
   `frndint` (floor x0/z0, ceil x1/z1) (709272-709295).
4. **Map-bounds:** fail (→ false) if
   `x0<0 || z0<0 || x1 > hf.width-1 || z1 > hf.height-1` (709292-709298).
   Out-of-bounds is *not buildable*.
5. **Flatness / slope:** if `!Physics.FlattenSkirt` → `OCCUPY_CheckAreaFlatness`
   (709124), else `OCCUPY_CheckEdgeFlatness` (708955). Both return min/max
   elevation over the skirt cells; `pass = (Physics.MaxGroundVariation >=
   (max − min))` (709188, 709114-709120). **Structures use
   `Physics.MaxGroundVariation`, not the footprint `MaxSlope`.** If not flat →
   `caps &= ~3` (drop LAND + SEABED).
6. **Water-layer gating** (`waterElev = mWaterEnabled ? mWaterElevation :
   −10000`):
   - `if waterElev > minElev → caps &= ~1` (drop LAND: lowest point submerged)
     (709313).
   - `if maxElev > (waterElev − Footprint.MinWaterDepth) → caps &= ~0xE` (drop
     SEABED|SUB|WATER: too shallow) (709315).
7. `if caps == 0 → false`. Else `dest->layers = caps`.
8. **Build restriction** `Physics.BuildRestriction` (709320):
   - `RULEUBR_OnMassDeposit` → require `DepositIsInArea(Mass, footprintRect)`
     (skipped under `/nomass`).
   - `RULEUBR_OnHydrocarbonDeposit` → require `DepositIsInArea(Hydrocarbon, …)`.
   - none → **must NOT** sit on a deposit: fail if a Mass or Hydrocarbon deposit
     lies in the skirt (709348-709356; the helper name is inverted — `true` =
     deposit present).
9. Return true. *(For structures, OCCUPY_Check does NOT consult the per-terrain-
   type `mBlocking` flag; that is mobile-only, in `OCCUPY_MobileCheck`
   708741.)*

## func_LocationIsFree (1044976) — occupancy layer

Signature `(bp, COGrid*, SCoordsVec2* pos, struct_Occupation* dest)`.

1. `OCCUPY_Check(...)` (above) — else return false.
2. Compute integer footprint rect from `dest->pos` and `Footprint.SizeX/SizeZ`
   (1045001-1045010): `x0 = (int16)(pos.x − SizeX*0.5)`, `z0 = (int16)(pos.z −
   SizeZ*0.5)`, `x1 = x0+SizeX`, `z1 = z0+SizeZ` (truncation, not round — matches
   `COORDS_GridSnap`).
3. **Mobile path** (`bp.IsMobile`, not structures): clear layer bits where the
   footprint overlaps occupancy; return `layers != 0`.
4. **Structure path:**
   - `SkirtRect = GetSkirtRect(occupation.pos, bp)`.
   - `if !RectFreeOfUnits(SkirtRect, poi)` — note `RectFreeOfUnits` returns
     **true when a blocking immobile unit overlaps** (1044670; returns 1 on
     overlap), so this branch runs when **no** structure skirt overlaps:
     - `if layers&3 && GetRectNeg(footprintRect, mTerrainOccupation) → layers &=
       ~3` (1045035)
     - `if layers&8 && GetRectNeg(footprintRect, mWaterOccupation) → layers &=
       ~8` (1045037)
     - return `layers != 0`.
   - If a structure skirt overlaps → return false (1045043).

**Per-cell "occupied" test = `GetRectOr`** (1380805): occupied if for any cell
`(1 << (z&31)) & ptr[x + width*(z>>5)]` is set. `disallowNegative = 1` ⇒ any
part **out of grid bounds also counts as occupied / not-free** (returns 1,
1380834). `GetRectNeg` forwards to `GetRectOr` (1044610).

## CanBuildStructureAt wrapper extras (726373)

Order:
(a) `func_LocationIsFree` (grid + terrain + skirt-vs-structure).
(b) If it fails **and** an `alliance` filter is passed, an alliance-based
    override scans `STRUCTURE` units in the skirt via `GetUnitsAroundPoint`
    (726440-726471). **Skipped for the player ghost** (alliance `ALLIANCE_None`).
(c) On success, a final skirt-overlap sweep `func_GatherUnmarkedUnitsInBox` +
    `Rect2f::Overlaps(skirt, otherUnit.skirt)` rejects if any non-ignored unit's
    skirt overlaps (726490-726527).
(d) Also rejects against pending `mBuildStructurePositions` reservations whose
    skirts overlap (726534-726656).

## Blueprint fields consumed (paths confirmed against real `.bp`)

- **Footprint (`SFootprint`):** structures use inline `Footprint = { SizeX,
  SizeZ }` (uab0101:213 `SizeX=5, SizeZ=5`); the table may also carry
  `OccupancyCaps / MinWaterDepth / MaxWaterDepth / MaxSlope / Flags`. Mobile
  units resolve these from named entries in `lua/footprints.lua`. Flag
  `FPFLAG_IgnoreStructures` skips the terrain-occupation test (1044843).
- **Physics.SkirtSizeX / SkirtSizeZ, SkirtOffsetX / SkirtOffsetZ** —
  `GetSkirtRect` (656013-656042): if `SkirtSize == 0` the skirt falls back to
  the footprint span; else `x0 = floor(pos.x − SizeX*0.5) + SkirtOffsetX`, `x1 =
  x0 + SkirtSizeX` (same for Z). Real: uab0101 `SkirtSizeX/Z = 8, SkirtOffsetX/Z
  = −1.5`.
- **Physics.MaxGroundVariation** — slope tolerance for structures (709117,
  709188).
- **Physics.FlattenSkirt** — selects area- vs edge-flatness (709299).
- **Physics.BuildOnLayerCaps** — table `{ LAYER_Land, LAYER_Seabed, LAYER_Sub,
  LAYER_Water, LAYER_Air = bool }` (uab0101:261-265) → packed bitmask
  (LAND1/SEABED2/SUB4/WATER8/AIR16); AND-gated by the terrain/water results in
  OCCUPY_Check (709300).
- **Physics.BuildRestriction** (`RULEUBR_*`) — deposit requirement (709320).
- **Footprint.MinWaterDepth / MaxWaterDepth** — water-depth gating (709315;
  mobile also MaxWaterDepth 708762).
- Map inputs: `STIMap.mHeightField` (elevation, bounds), `mWaterEnabled`,
  `mWaterElevation`, `mTerrainType` + `mBlocking` (mobile only), deposits.

## Line index

func_LocationIsFree **1044976**; OCCUPY_Check **709196**;
OCCUPY_CheckAreaFlatness **709124**; OCCUPY_CheckEdgeFlatness **708955**;
OCCUPY_MobileCheck **708648**; OCCUPY_FootprintFits **1044826**;
GetSkirtRect **655998**; GetFootprintRect **656048**; RectFreeOfUnits
**1044670**; COGrid ctor **1044616**; ExecuteOccupy **1045489**;
ReleaseOccupy (sub_721B30) **1045524**; GetRectOr **1380805**; GetRectNeg
**1044610**; CanBuildStructureAt **726373**; Lua binding **737074**.
Blueprints: `lua/footprints.lua` (mohodata.scd), `units/uab0101/uab0101_unit.bp`.
