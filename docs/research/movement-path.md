# agent8

## Summary
The FA engine cleanly separates movement into four layers: (1) a cell passability grid (1 cell = 1 world meter, from heightmap slope + water depth + terrain type blocking + structure occupancy bitmaps), (2) a hierarchical A* ("HaStar", cluster 8x8/32x32, one cluster map per footprint type) that provides cell paths, (3) a path navigator of waypoints selects/repaths, and (4) a steering layer (CAiSteeringImpl + CAiPathSpline + CUnitMotion) that integrates acceleration/braking/TurnRate/Elevation per tick (0.1 s) and makes unit avoidance via OBB collision prediction. All blueprint values ​​are in units/second or degrees/second and are scaled with fixed tick factors (0.1 / 0.01 / pi/180*0.1). Two core functions are NOT reconstructed in faf-re (CUnitMotion::CalcMoveCommon, COORDS_CanMoveAt, CAiPathSpline::Generate/Update only provisionally) - but all parameters, constants and auxiliary mathematics are available so that a replica can close the gap deterministically.

## Key Facts
- Sim laeuft mit 10 Ticks/s: MaxSpeed*0.1 = Meter/Tick, MaxAcceleration/MaxBrake/MaxSteerForce*0.01 = Meter/Tick^2, TurnRate/TurnFacingRate [Grad/s] * 0.0017453292 = Radiant/Tick (CAiPathSpline.cpp:26-28).
- path grid = heightmap cell grid, 1 cell = 1 world meter; Heights are uint16 with scaling 0.0078125 (=1/128) meters per unit (STIMap.cpp:1531).
- Passability per cell = bitmask EOccupancyCaps {LAND=1, SEABED=2, SUB=4, WATER=8, AIR=16, ORBIT=32}, calculated from Footprint(MaxSlope, MinWaterDepth, MaxWaterDepth, SizeX/Z) + Heightmap + TerrainType blocking + two structure bitmaps (terrainOccupation, waterOccupation).
- Slope test is NOT an angle: max. absolute height difference of neighboring heightmap samples (in meters) > MaxSlope => LAND|SEABED is omitted. Default MaxSlope of all land footprints = 0.75 (footprints.lua).
- Footprints are a global table from mohodata.scd:lua/footprints.lua (20 entries, e.g. Vehicle1x1 LAND MaxWaterDepth=0.05 MaxSlope=0.75); Blueprint-MotionType (RULEUMT_*) maps to caps and the engine uses FindFootprint to select the next largest entry with the same caps.
- Pathfinding is hierarchical A* (gpg::HaStar) with cluster sizes {1, 8, 32, 128} cells; PathTables builds ONE ClusterMap with numLevels=2 (=> Level 8x8 and 32x32) for each footprint type and updates it incrementally with frame budget.
- The actual A* runs in a per-Army PathQueue; The unit only provides callbacks via IPathTraveler: CanTraverseCell, IsInBounds, GetHeuristicCost (octile distance * 1.01), GetAnchorCell, IsGoalCandidateCell, GetPathcap (search budget per layer).
- Repath trigger in CAiPathNavigator: Target distance > mRepathDistanceThreshold (set to half remaining distance every time target changes), layer change, 30 ticks without position change, or explicit mRepathRequested; Retry delay 10 ticks, 3 failures => next escalation level, 3x3 => AIPATHNAVSTATE_Failed.
- Unit avoidance is prediction-based (no boids): CAiSteeringImpl collects neighbors in radius (size + path length*MaxSpeed*0.1 + braking distance v²/2a), simulates both path splines every 3 ticks forward and tests 2D OBB overlap (inflated length = SizeZ + braking distance).
- Collision response is discrete: COLLISIONTYPE_1 (collision predicted) => Resolution in None / 2 (avoidance target laterally, distance = SizeMax_A + SizeMax_B + 0.5) / 4 (new path) / 5 (peer should repath); 45° cone test (cos=0.707) decides whether to avoid or repath.
- There is NO physical pushing between units: CUnitMotion::mIsBeingPushed is only set by AddImpulse (weapon/death impulses); Blocking runs via occupancy bits + reservation bitmap (mOccupation) + evasive steering.
- Elevation/Layer: Land/Seabed => y = terrain height (SnapToGround averages 4 footprint corners and tilts the orientation to the surface normal); Water => y = water level; Sub => y = water level + elevation (negative); Air => y = surface + elevation. Hover uses SnapToGround with water floor + elevation offset.
- Ships do NOT have real draft: Draft is mapped via Footprint-MinWaterDepth (Water*: 1.5, Water3x3: 0.25) and the Meshoffset; Diving/surfacing is a separate state with a sinusoidal speed curve from Physics.DiveSurfaceSpeed*0.1.
- Turn radius limit for ships: ComputeSteeringSpeedCapFromParams limits the speed based on the turn radius (r = d²/(2*cross)); if r < TurnRadius, the speed is capped at TurnRate*r*0.5, otherwise at TurnRadius; RotateOnSpot units (bots) only start when heading alignment > 0.98, otherwise speed 0.
- Air: no pathfinding (CAiNavigatorAir flies directly to the goal), control via KMove/KMoveDamping damping, TurnSpeed/CombatTurnSpeed ​​(rad/s, per tick *0.1 clamped), LiftFactor for vertical force, BankFactor*(1-forward orientation)*Speed/StartTurnDistance for roll angle.
- Formations come from lua/formations.lua (lua.scd): entries {xOffset, -rowOffset, category, row, true}; the engine (CAiFormationInstance) scales them with mFormationUpdateScale, rotates them with the formation orientation, snaps them to free cells using FindSlotFor and regulates the formation speed (speed scale 0.85 basis, delta control ±5..+20%).

## Details
## 1. Terrain-Passierbarkeit (Grid-Aufbau)

### Datenquellen
- **Heightmap** `CHeightField`: `uint16 data[width*height]`, world meter = `sample * 0.0078125f` (1/128). Grid is (mapSizeX+1) x (mapSizeZ+1) Samples; **one path cell = 1 world meter**, cell (x,z) is defined by the 4 samples (x,z),(x+1,z),(x,z+1),(x+1,z+1).
- **TerrainType grid** `mTerrainType` + `mBlocking[]` table → `STIMap::IsBlockingTerrain(z,x)` (STIMap.cpp:3481). Also returns true if x >= width-1 or z >= height-1 (border cells are blocked).
- **Water**: global level `mWaterElevation` (only ONE water level per map), `mWaterEnabled`; if off → substitute value `-10000.0f`.
- **COGrid** (moho/sim/COGrid.h) holds 3 BitArray2D:
  - `terrainOccupation` — ground cells occupied by buildings/props (caps LAND|SEABED|SUB)
  - `waterOccupation` — Wasser-Belegung (Caps WATER)
  - `mOccupation` — **mobile unit reservation bitmap** (Unit::ReserveOgridRect / CanReserveOgridRect)
  - `ExecuteOccupy/ReleaseOccupy` set/clear bits and call `Sim::mPathTables->DirtyClusters(rect)` → incremental cluster rebuild.

### Footprint (SFootprint, 16 Byte)
`mSizeX:u8, mSizeZ:u8, mOccupancyCaps:u8, mFlags:i8, mMaxSlope:f32, mMinWaterDepth:f32, mMaxWaterDepth:f32`
- Caps: LAND=0x1, SEABED=0x2, SUB=0x4, WATER=0x8, AIR=0x10, ORBIT=0x20, ANY=0xFF
- Flags: FPFLAG_IgnoreStructures=0x1 (Footprint ignores building occupancy — e.g. experimentals)
- Footprint origin cell from world position: `cell = round(worldPos - size*0.5)` (`SFootprint::ToCellPos`)
- Cell → World Center: `world = cell + size*0.5` (`COORDS_ToWorldPos`, Entity.cpp:8261)

### Caps calculation, 1x1 footprint (`STIMap::OccupancyCapsOfFootprintAt`, STIMap.cpp:3500)
```
if (x >= w-1 || z >= h-1 || IsBlockingTerrain) return 0
h00,h10,h01,h11 = 4 Height-Samples; minH, maxH
caps = footprint.mOccupancyCaps
if (MinWaterDepth > waterElev - maxH*SCALE)          caps &= ~(WATER|SUB|SEABED)
if (waterElev - minH*SCALE > MaxWaterDepth)          caps &= ~(LAND|SEABED)
if ((caps & (LAND|SEABED)) && MaxSlope != 0):
    maxDelta = max(|h11-h01|, |h11-h10|, |h01-h00|, |h10-h00|)   // NUR Kanten, keine Diagonalen
    if (maxDelta*SCALE > MaxSlope) caps &= ~(LAND|SEABED)
return caps
```
**Important:** "MaxSlope" is a **height difference in meters per cell**, not an angle. 0.75 corresponds to ~36.9°.

### Caps calculation, NxN footprint (`OCCUPY_MobileCheck`, STIMap.cpp:3996)
Identical, but across **all** samples in the rectangle `[x0..x0+sizeX] x [z0..z0+sizeZ]` (included!): min/max height globally, blocking test per cell, slope = max. neighbor difference along each row and each column.

### Occupancy-Filter (Strukturen) (`OCCUPY_Filter` / `OCCUPY_FootprintFits`, STIMap.cpp:4115/4153)
```
FootprintFits(grid, cell, fp, caps):
  if max(sizeX,sizeZ)==1: caps' = Filter(...)          // Einzelbit-Test
  else:
    if caps==OC_ANY: caps = OCCUPY_MobileCheck(fp, map, cell)
    if !(fp.mFlags & IgnoreStructures) && (caps & (LAND|SEABED)) && terrainOccupation.GetRectOr(cell, sizeX, sizeZ): caps &= ~(LAND|SEABED)
    if (caps & WATER) && waterOccupation.GetRectOr(...): caps &= ~WATER
  return caps  // 0 == unpassierbar
```
`OCCUPY_HoverFootprintFits` (STIMap.cpp:4197): calculates MobileCheck and deletes OC_SUB if the caller is on layer WATER.

### MotionType → Caps-Mapping (RUnitBlueprint.cpp:258)
| RULEUMT | Wert | Caps |
|---|---|---|
| None | 0 | 0x00 (Building: Caps = Physics.BuildOnLayerCaps) |
| Land | 1 | LAND |
| Air | 2 | AIR |
| Water | 3 | WATER |
| Biped | 4 | LAND |
| SurfacingSub | 5 | SUB\|WATER (0x0C) |
| Amphibious | 6 | LAND\|SEABED (0x03) |
| Hover | 7 | LAND\|WATER (0x09) |
| AmphibiousFloating | 8 | LAND\|WATER (0x09) |
| Special | 9 | 0x00 |

`RUnitBlueprintPhysics::ComputeDerivedQuantities` (RUnitBlueprint.cpp:707): sets MotionType=None if MaxSpeed==0; MaxSpeedReverse<0 → =MaxSpeed; AttackElevation==0 → =Elevation; CatchUpAcc==0 → max(MaxAcceleration, MaxBrake); SkirtSize >= Footprint Size; then resolves the next appropriate footprint via `RRuleGameRules::FindFootprint` (RRuleGameRules.cpp:2300): **same caps** and minimal `max(|dSizeX|,|dSizeZ|)`.

### Footprint Table (Ground Truth) — `mohodata.scd : lua/footprints.lua`
20 entries, including:
- Vehicle1x1 / 2x2 / 5x5: LAND, MaxWaterDepth=0.05, MaxSlope=0.75 (5x5 mit IgnoreStructures)
- Amphibious1x1 / 3x3 / 6x6: LAND|SEABED, MaxWaterDepth=25, MaxSlope=0.75
- WaterLand1x1/2x2 (Hover): LAND|WATER, MaxWaterDepth=1, MinWaterDepth=0.1, MaxSlope=0.75; WaterLand3x3/5x5: MaxWaterDepth=5, MinWaterDepth=0
- SurfacingSub2x2/3x3/4x4/12x12: SUB|WATER, MinWaterDepth=1.5
- Water1x1/3x3/4x4/6x6/8x8/11x11: WATER, MinWaterDepth=1.5 (3x3: 0.25)

Comment in the file: **each footprint spec creates its own path data structure across the entire map** — keep the number small. This confirms: one ClusterMap per footprint.

## 2. Pathfinding

### Structure
- `PathTables(footprints, grid, w, h)` (PathTables.cpp:1326): one `OccupySourceBinding{grid, footprint}` + one `gpg::HaStar::ClusterMap(source, w, h, cache, numLevels=2, area={-1,-1,sizeX+1,sizeZ+1})` per footprint.
- `gpg::HaStar` (gpg/core/algorithms/Cluster.h/.cpp): **Hierarchical A***. Cluster sizes per level: `{1, 8, 32, 128}` cells (log2 `{0,3,5,7}`). With numLevels=2 there are Level 1 (8x8) and Level 2 (32x32). Map dimensions are rounded up to multiples of 32.
- A cluster (`Cluster::Data`) stores: `nodeCount:u8`, `Node{x:u8,z:u8}[n]` (edge ​​transition nodes) and a triangular matrix `Edge{cost:i8}[n*(n-1)/2]` (index = `lhs + rhs*(rhs-1)/2`). Edge costs are quantized: `QuantizeEdgeCost(a,b) = ceil(ln(a/b)*6)` → Bucket 0..31.
- `ClusterCache` deduplicates identical cluster payloads (hash over OccupationData / SubclusterData) — on typical maps there are only a few dozen different 8x8 patterns.
- Raw data per cluster: `OccupationSource::GetOccupationData(x, z, out)` (PathTables.cpp:1251) builds **9 uint16 columns with 9 bits each**: `OCCUPY_Filter(fp, grid, cell, OC_ANY)` is evaluated for each (x,row) in the 9x9 window; if the result is 0, the bit mask `(widthMask << x) >> (sizeX-1)` is hidden. Then, for footprints with sizeZ>1, the lines are ORed using AND (the footprint must fit on all lines). => **The passability is already footprint-eroded** (footprint origin matches ⟺ bit set).
- Incremental rebuild: `Sim::AdvanceBeat` → `PathTables::UpdateBackground(&budget)` → `ClusterMap::BackgroundWork(budget)` (only if ConVar `path_background_update` on; budget from ConVar). `COGrid::ExecuteOccupy/ReleaseOccupy` → `DirtyClusters(rect)` → `ClusterMap::DirtyRect`.

### Suchanfrage (IPathTraveler / CAiPathFinder)
The actual A* loop lives in `moho::PathQueue` (per Army, `CArmyImpl::PathFinder`); faf-re only has the heap/bucket mechanics (`PathQueueWorkHeapEntry{totalCost, lane, handleIndex}`, min-heap sift-up/down + handle→index map). The unit page is complete:

`CAiPathFinder : IPathTraveler` (CAiPathFinder.h) Callbacks:
- `GetFootprint()` → normal or alt footprint (FAVORSWATER units switch to alt footprint underwater, CAiPathNavigator.cpp:UpdateWaterFavorAltFootprintMode)
- `IsInBounds(cell)` → within `mPlayableRect` with Margin = max(sizeX,sizeZ) (except Army.UseWholeMap)
- `CanTraverseCell(cell)` → IsInBounds && not blocked in rect history of recent searches
- `GetHeuristicCost(cell)` → **Octile distance** to goal rectangle: `dx,dz` = distance to rect; `max(dx,dz) + min(dx,dz)*0.41421354f`, then `* 1.01f` (slightly inadmissible → faster, slightly suboptimal)
- `IsGoalCandidateCell(cell)` → in the outer goal rect (`mPos1`) but outside the inner rect (`mPos2`) → **ring target** (e.g. "within weapon range of X")
- `ShouldSearchRect(rect)` → Cluster rect filter for hierarchical search
- `GetPathcap()` → Search budget: Army.PathCapLand (MotionType==1), .PathCapSea (==3), otherwise .PathCapBoth
- `OnPathAccepted/Rejected/Cancelled(SNavPath)` → Result is `SNavPath` = vector of `SOCellPos{int16 x,z}`

### Pfadverfolgung & Repath (CAiPathNavigator, CAiPathNavigator.cpp)
State: Idle/Failed/Thinking/PathEvent3(=full search in progress)/PathEvent4(=continuation search)/HasPath/FollowingLeader.
- `RequestPath(mode)` mode∈{1=Initial, 2=Repath, 3=Leader/Attacking}: Anchor = aktuelle Zelle, Goal setzen, QueueSearch, State=PathEvent3.
- `UpdateCurrentPosition(pos)` je Tick:
1. Countdown/Retry delays
  2. Frontmost path cells consume as long as the second is closer than the first
  3. When path end is reached → Idle (success)
  4. `TryAdvanceTargetPoint()`: searches for the **furthest directly accessible** path node (index up to `min(pathSize-1, max(10, firstReachable))`, candidates > 50 cells distance are skipped); Reachability = `CanPathCellTransition` (occupancy check at the target node) && `CanReachCellFromCurrent`. This is **path smoothing** (string pulling).
  5. Repath conditions: `mRepathDistanceThreshold < dist(current,target)` (threshold is set to `dist*0.5` every time you change target → when moving away from the target instead of approaching) OR `mRepathRequested` OR `mNoProgressTickCount > 30` (30 ticks = 3 s without changing position) OR layer change (`ReadUnitLayerToken`).
  6. Error escalation in `OnEvent`: empty result → `mPathRetryDelayFrames=10`, after 3 failed attempts `mNoForwardDistanceFailCount++`, after 3 of them → Failed.
- `RequestContinuationPath(2|3)`: short search from the current path head; The result is prepended **at the front** to the existing path (`PrependCells`).
- There are tick buckets `entityId % 7` and `% 13` per unit (load distribution of the repath checks).

`CAiNavigatorLand::Execute()` (CAiNavigatorLand.cpp:509, one CTask per tick):
```
pathNav->UpdateCurrentPosition(unit.pos)
target = pathNav->GetTargetPos()
if (state != Thinking && target != steering->GetWaypoint()):
    steering->UseTopSpeed(pathNav->IsCellInGoal(targetCell))
    steering->CalcAtTopSpeed2(pathNav->mLastPathNodeIndex < 0)
    steering->SetWaypoints(&target, 1)      // immer NUR 1 Wegpunkt
    status = Steering
if (state <= Failed): steering->Stop(); MakeIdle(); dispatch(Succeeded|Failed)
```
`CAiNavigatorAir::Execute()` (CAiNavigatorAir.cpp:438): **no pathfinding**. Target = next point of the goal rect (perimeter search), motion flies directly there; Success if `UnitMotion->AtTarget()` and target cell == goal cell.

## 3. Bewegungsintegration (exakt)

### Skalierung (CAiPathSpline.cpp:26-28) — **Tick = 0.1 s**
```
kSpeedScalePerTick        = 0.1        // MaxSpeed [m/s]  -> m/Tick
kAccelerationScalePerTick = 0.01       // MaxAccel [m/s^2]-> m/Tick^2
kDegreesToSteeringRadiansPerTick = 0.0017453292   // = pi/180 * 0.1  => TurnRate ist Grad/SEKUNDE
```

### SteeringParams (CAiPathSpline.h:88, ctor CAiPathSpline.cpp:57) — the integration parameter package
```
mTurnRate        = Physics.TurnRate        * attr.turnMult * 0.0017453292   // rad/Tick
mTurnFacingRate  = Physics.TurnFacingRate  * attr.turnMult * 0.0017453292
mMaxSpeed        = min(Physics.MaxSpeed, speedLimit)        * attr.moveSpeedMult * 0.1
mMaxReverseSpeed = min(Physics.MaxSpeedReverse, speedLimit) * attr.moveSpeedMult * 0.1
mMaxAcceleration = Physics.MaxAcceleration * attr.accelerationMult * 0.01
mMaxBrake        = (Physics.MaxBrake != 0 ? Physics.MaxBrake : Physics.MaxAcceleration) * attr.accelerationMult * 0.01
mMaxSteer        = (Physics.MaxSteerForce != 0 ? MaxSteerForce : MaxAcceleration) * attr.accelerationMult * 0.01
mInvTurnRadius   = (Physics.TurnRadius == 0) ? +inf : Physics.TurnRadius / attr.turnMult
mRotateOnSpot, mRotateOnSpotThreshold  aus Physics
mDeltaX = dst.x - src.x ;  mDeltaZ = -(dst.z - src.z) ;  mForwardXZ = normalize(fwd.x, -fwd.z)
```
(The z negation is the internal "steering 2D plane"; follow through consistently.)

### Speed ​​cap from curve radius (`ComputeSteeringSpeedCapFromParams`, CAiPathSpline.cpp:~253)
```
if (RotateOnSpot && RotateOnSpotThreshold > distanceGate):
    align = dot(forwardXZ, normalize(delta))
    return (align < 0.98) ? 0.0 : mMaxSpeed          // Bots: erst drehen, dann fahren
cross = deltaZ*forward.x - forward.y*deltaX
r     = (cross == 0) ? 0 : (distanceSq * 0.5) / cross   // Kreisradius durch aktuelle Pos + Ziel
if (|r| < TurnRadius):  return (|r| == 0) ? mMaxSpeed : mTurnRate * |r| * 0.5
if (TurnRadius < 0):    return 0
return TurnRadius
```
=> **Ships** (large turn radius) automatically slow down in tight turns; this is the complete "TurnRadius for Ships" mechanism.

### Heading-Rotation (`RotateDirectionTowardTargetLimited`, CAiPathSpline.cpp:~305)
Rotates the current XZ direction by a maximum of `maxTurnRadians` (= mTurnRate per tick) to the target direction; sin() via polynomial approximation `((a²*0.00761 - 0.16605)*a² + 1)*a`, cos() exactly. Sign from the 2D cross product. Length of the source vector is retained.

### Lokale Bewegungs-Spline (CAiPathSpline::Generate/Update)
Concept (in faf-re only provisionally lifted, but functional contract clear):
- `Generate(unit, destination, pathType, allowContinuation)` creates a chain of `CPathPoint{position, direction, state}` from the current state (Pos, Heading, Velocity, possibly `SContinueInfo` of the last generation) — **one node per Sim-Tick** by simulating the movement forward with the SteeringParams (Speed-Cap → Accelerate/Brake → Rotate Heading → Integrate Position).
- `Update(unit, mode)` (mode 3/4) extends/renews the spline without a new target.
- `mCurrentNodeIndex` runs with it; `CUnitMotion::mNextWaypoint/mFollowingWaypoint` point to node i and i+1 (`SetSplineData`).
- `EPathPointState PPS_*` marks, among other things, stop nodes (PPS_1 → `ProcessCommonMotionState` switches to "Stopping").
- **Reproduction recommendation**: Implement exactly this forward simulation - it is also the basis for collision prediction (the splines of both units are compared).

### CUnitMotion (moho/unit/CUnitMotion.h) — the integrator
- `CalcMoveLand(transform, &dist)` → `CalcMoveCommon` (**in faf-re STUB**, EngineMethodStubs2.cpp:63) → `FindIntersectingRaisedPlatform()` → `SnapToGround()` → `ProcessCommonMotionState()`
- `CalcMoveWater(transform)` → `CalcMoveCommon` → `HandleDivingAndSurfacing()` → `SnapToWater()` → `ProcessCommonMotionState()`
- `ProcessCommonMotionState(ok)` (CUnitMotion.cpp:1744): Horz-Event-Statemachine
  - `!ok` → Stopped
  - `speed > formationTopSpeed * 0.08` → TopSpeed
  - otherwise: near-target (`moveSpeedMult*MaxSpeed > dist`) or next spline node==PPS_1 → Stopping, otherwise cruising
  - Events feuern Lua-Callbacks `OnMotionHorzEventChange` / `OnMotionVertEventChange` / `OnMotionStateChange`
- `SnapToGround` (CUnitMotion.cpp:2387): sample 4 corners (±sizeX/2, ±sizeZ/2, rotated), `pos.y = Mittelwert`; Normal from the two diagonals; `StandUpright` → Normal = (0,1,0); `StandUpright||SinkLower` → `pos.y -= (maxH-minH)*0.25`; **Hover**: Sample elevation takes water level (floor) and `pos.y += Elevation` into account, normal is supplemented by roll hack vectors. Degree: `COORDS_Tilt(orient, normal)`.
- `SnapToWater` (CUnitMotion.cpp:2338): `y = max(terrain+0.25, waterElev + mSubElevation)`; with `mSubElevation<0` (submerged) clamped to water level; Tilt from `CalcRollHack()`.
- `CalcRollHack()` (CUnitMotion.cpp:2277): Spring-damper for recoil/roll: `recoil *= (1 - RollDamping)`; `roll += recoil`; `recoil -= roll*RollStability`; when diving/surfacing, additional nick by `divingSpeed*4`, smoothed with 0.25/0.75.
- `AddImpulse(imp, ballistic)` (CUnitMotion.cpp:1228): Air → directly on PhysBody; otherwise `v = imp + v*0.5`, speed clamped to `formationTopSpeed*0.2`, `mIsBeingPushed = true`, `mProcessSurfaceCollision = true`. At `ballistic` → Layer=Air, MotionState=Ballistic, random angular momentum.
- `TransitionBetweenLayers` (CUnitMotion.cpp:1919): linear interpolation Pos + NLerp orientation via `Physics.LayerTransitionDuration * 10` ticks.

### Tauchen/Auftauchen (`HandleDivingAndSurfacing`, CUnitMotion.cpp:1831)
```
diveDepthLimit = attr.spawnElevationOffset (= Physics.Elevation, negativ)
surfaceLimit   = min(0, terrain+0.25 - waterElev);  diveDepthLimit = max(diveDepthLimit, surfaceLimit)
phase = |subElev / diveDepthLimit|; if (phase > 0.5) phase = 1-phase
base  = Physics.DiveSurfaceSpeed * 0.1
divingSpeed = max(base*0.1, sin(phase*pi) * base)      // sanfte Ein-/Ausblendung
MovingUp: subElev = min(0, subElev + divingSpeed); at 0 -> set layer, delete state, VertEvent None
MovingDown: subElev = max(limit, subElev - divingSpeed); bei limit -> Layer setzen, VertEvent Top
```

## 4. Luft

`RUnitBlueprintAir` (RUnitBlueprint.h:338): CanFly, Winged, FlyInWater, AutoLandTime, MaxAirspeed, MinAirspeed, TurnSpeed, CombatTurnSpeed, StartTurnDistance, TightTurnMultiplier, SustainedTurnThreshold, LiftFactor, BankFactor, BankForward, EngageDistance, BreakOffTrigger/Distance, **KMove, KMoveDamping, KLift, KLiftDamping, KTurn, KTurnDamping, KRoll, KRollDamping**, Circling*, HoverOverAttack, TransportHoverHeight, PredictAheadForBombDrop.
Defaults in `RUnitBlueprint::OnInitBlueprint` (RUnitBlueprint.cpp:802): MotionType==Air → CanFly=1; MaxAirspeed==0 → =Physics.MaxSpeed; MinAirspeed==0 → =MaxAirspeed; StartTurnDistance==0 → `mSizeZ * 3`.

- **Damping** `CalcAirMovementDampingFactor` (CUnitMotion.cpp:1944): Category TARGETCHASER → 1.0; otherwise `speed = min(|movement|, formationTopSpeed)`, `denom = max(1, speed)`; `topSpeed <= denom` → KMove; otherwise `min(topSpeed/denom, KMoveDamping)`.
- **Boost** `CalcWingedLift(maxLift, wingFactor)` (CUnitMotion.cpp:1622): `lift = (wingFactor - 0.5) * Air.LiftFactor`; if `lift <= 0` and `targetElev*0.5 > curElev` → `targetElev*0.5 - curElev` (emergency buoyancy); if `maxLift <= lift` → maxLift.
- **Kurven/Banking** `CalcWingedOrientation` (CUnitMotion.cpp:2042):
  - `limitedSpeed = min(|controlXZ|, formationTopSpeed)`; under `StartTurnDistance` (and not guarding/combat) a fallback vector is used
  - Power = `refVector * limitedSpeed`, additionally scaled with `max(0.5, alignment)` in non-CombatTurn
  - Rotation: `turnDelta = atan2(sel) - atan2(ref)`, standardized to ±pi, clamped to `maxTurnSpeed * 0.1` with `maxTurnSpeed = (combatState==CombatTurn) ? CombatTurnSpeed : TurnSpeed` → **TurnSpeed ​​is rad/s**
  - Roll: `bias = elevationScale * (1 - forwardAlignment) * BankFactor * min(speed/StartTurnDistance, 0.5|1.0) * sign`; in NormalTurn `forwardAlignment^8` and `BankFactor*10` are used; Up vector from roll bias + wing projection, then normalized.
- **Hover Orientation** `CalcHoverOrientation` (CUnitMotion.cpp:2224): `up = (v - vPrev) * (BankFactor * min(curElev/Elevation, 1)) - gravity*0.1`; with `BankForward==0` the forward component of the acceleration is projected out (lateral banking only).
- **Target altitude** `CalcDesiredTargetElevation` (CUnitMotion.cpp:1988): Target in the air → `targetUnit.Physics.Elevation + terrain`, at least `Elevation*0.5 + terrain`; otherwise `terrain + (combatState==1 ? AttackElevation : Elevation)`. `GetElevation()` takes into account carrier mode (`mHeight`, factor 0.25) and `mRandomElevation`.
- **Landing/Takeoff**: `ShouldHoverInsteadOfLand()` (TransportHoverHeight>0 and Transport is loading/has cargo → do not land); Landing itself runs via layer transition (`TransitionBetweenLayers`, `LayerChangeOffsetHeight`, `LayerTransitionDuration`) and `UNITSTATE_MovingDown/MovingUp`.
- **Flight Control** (`CAiSteeringImpl::FlyToNextWaypoint`, CAiSteeringImpl.cpp:1534): no spline, only `MotionSetTarget(motion, snappedWaypoint, zero, LAYER_None)`; "reached" if `|delta|² <= airTolerance²` (ConVar, Fallback 1.0).

## 5. Marine

- No real depth. Ships are located at `y = waterElevation` (COORDS_ToWorldPos / CalcSpawnElevation, IUnit.cpp:120: LAYER_Water → water level). The "Draft" is purely the **Footprint-MinWaterDepth** (1.5 for most water footprints, 0.25 for Water3x3 = small boats), which prevents ships from entering shallow water.
- Submarines: LAYER_Sub → `y = waterElevation + Physics.Elevation` (elevation negative). SurfacingSubs switch between SUB and WATER via `SetNewTargetLayer` + Dive/Surface curve.
- `mIsNaval` controls a special rule in evasion (`MarkSecondarySteeringForRepath`): Naval units signal other Naval units COLLISIONTYPE_5 (Repath), Land↔Naval does not.

## 6. Kollision / Blocking / Pushing

### Statische Belegung
- Buildings/Props: `Unit::ExecuteOccupyGround` → `ApplyOccupancyRect` writes to `terrainOccupation` (Caps LAND|SEABED|SUB) and/or `waterOccupation` (WATER). Rectangle from `Physics.OccupyRects` (if defined, with CenterOffset/HalfSize, rounded with floor(v+0.5)) otherwise from Footprint. `ReleaseOccupyGround` inverse. Both dirty-marked the clusters.
- Skirt (`SkirtSizeX/Z`, `SkirtOffsetX/Z`, `FlattenSkirt`, `MaxGroundVariation`) only affects building site inspection (`OCCUPY_Check`, `OCCUPY_CheckAreaFlatness`, `OCCUPY_CheckEdgeFlatness`), not pathing.

### Dynamische Reservierung
- `COGrid::mOccupation` is the third bitmap: `Unit::ReserveOgridRect(rect)` / `FreeOgridRect()` / `CanReserveOgridRect(rect)` (Unit.cpp:14054-14105). Used, among other things, for melee target cells and cell slots (`IsMeleeCandidateCellNavigable`).
- `COORDS_CanMoveAt(cell, grid, unit, disallowAttached, ignoreUnit)` (0x00720F70) checks dynamic unit blocking — **not reconstructed in faf-re** (EngineUnrecoveredStubs.cpp:44). Replica: Get entities in the cell rectangle via the EntityOccupationManager and evaluate live, non-attached, non-ignored units as blockers.
- `EntityOccupationManager` (COGrid.h): Broadphase buckets of **4x4 world meters**, separate bucket arrays for unit/prop/entity; `GatherUnmarkedUnitsInRect`, `GetEntityCollisionsInLine`, `CollectEntitiesInBox`, `ForAllEntitiesIterator(sphere)` (for weapons/AoE).

### Unit Dodge (CAiSteeringImpl.cpp)
1. `CheckCollisions()` (line 1352): Skip if dead/under construction/LAYER_Sub. `CollectCollisionCandidates` (line 648):
   - Suchradius `ComputeCollisionQueryRadius` = `max(sizeX,sizeZ) + pathNodeCount*MaxSpeed*0.1 + MaxSpeed²/(2*MaxAcceleration)`
   - Filter: only mobile, live, non-attached units with steering; Candidates with `pathType == PT_2` (already an alternative path) are skipped
   - Same layer + owner does NOT have higher priority → "deferred" (the other one avoids), otherwise "preferred"
2. `PredictCollisionForSteerings(a,b)` (line 554): runs both splines in **3-tick steps** (`pathStep += 3`), speed = node difference, and tests `UnitsWillCollide`; the closest hit is saved as `SCollisionInfo{type=1, pos, unit, tickGate}`.
3. `UnitsWillCollide` (line 317): Braking distance `lead = (|v|*10)² / (2*MaxAcceleration)` (0 for `ignoreBraking`, i.e. same formation and no one attacks); inflated length = `mSizeZ + lead`; Preliminary test over distance, then **2D OBB overlap** (SAT over 4 axes). OBB: Center = pos + forward*lead, Extents = `((sizeX+sizeZ)*0.25, inflatedLength*0.5)`.
4. `ResolvePossibleCollisionState` (line 704) if `sim.tick >= tickGate`:
   - Opponent is air → his motion gets `SetTarget(ownPos, LAYER_Air)` (dodge upwards), own state = None
   - Opponent is standing (v==0) or no real approach → None
   - `dot(dirToOther, otherHeading) <= 0.707` (not in the 45° cone) → **COLLISIONTYPE_4** = recalculate path
   - otherwise: mark peer if necessary COLLISIONTYPE_5; Evasion direction `ComputeAvoidanceDirection` (Base = opponent heading, averaged with own for strong alignment; lateral vector perpendicular to it, side over cross product, **inverted in the same formation**); Target = `probePos + avoidDir * (maxExtent_A + maxExtent_B + 0.5)` → **COLLISIONTYPE_2**
5. `ProcessSplineMovement` (line 1387) applies: Type 2 → `MotionSetTarget(avoidTarget)` + `UpdatePath(2, avoidTarget)`; Type 3 → Navigator Repath; Type 4/5 → `UpdatePath(4, dest)`; Type None → Restore original target.
6. `mIsBeingPushed` (only set by AddImpulse): Steering stops, waits until `|v| < MaxSpeed*0.01`, then new path.

**There is no continuous pushing of units.** Overlap is avoided by prediction + evasion + occupancy, not resolved by impulses.

## 7. Formationen

- Forms come from Lua: `lua.scd : lua/formations.lua`. `AttackFormation`/`GrowthFormation` (others: Block, Circle, Guard) get the unit list, categorize it (Land/Air/Sea/Sub) and fill `FormationPos` with entries `{ xPos*spacing, -formationLength*spacing, categoryTable[group], formationLength, true }`. Row widths are block tables with `LineBreak`/`RowBreak` spacing; Column order via `GetColSpot` (alternating from the center to the outside). Naval uses spacing 1.5.
- `PickBestTravelFormationIndex(typeName, dist)` → 0 for AirFormations otherwise 1; `PickBestFinalFormationIndex` → -1.
- Engine (`CAiFormationInstance`, moho/ai/CAiFormationInstance.cpp):
  - `GetFormationPosition` (line 3852): `world = formationCenter + (offsetX,offsetZ) [+ dynamicOffset]` → `FindSlotFor()` snaps to a free/passable cell (uses `COORDS_CanMoveAt`).
  - `ComputeRunScriptOffset` (Zeile 3816): Offset * `mFormationUpdateScale`, rotiert mit `mOrientation` (Formationsrichtung), skaliert mit `(mMaxUnitSlotCount + 2)`.
  - `GetAdjustedFormationPosition` (Zeile 3916): Weltpos → Footprint-Origin-Zelle (`round(pos - size*0.5)`).
  - `CalcFormationSpeed` (line 4300): base speedscale **0.85**; if the unit follows the leader and a `speedAnchor` exists: `delta = (speedBandLow - speedAnchor) * (CanFly ? 1.5 : 4.0)`, clamped to [-5, +20], `scale = 1 + delta*0.1` (i.e. 0.5x .. 3.0x). Return = `laneEntry->preferredSpeed` as speed limit → goes into SteeringParams as `speedLimit`.
  - `mIsInFormation` / `FollowingLeader()` / `IgnoreFormation()` control whether the path navigator follows the leader (State FollowingLeader) instead of pathing itself.

## 8. Gaps in faf-re (to be consciously recreated)

| Function | Address | Status |
|---|---|---|
| `CUnitMotion::CalcMoveCommon` | 0x006C1E20 | **Stub** (EngineMethodStubs2.cpp:63) — the actual land/water integration step |
| `COORDS_CanMoveAt` | 0x00720F70 | **Stub** (EngineUnrecoveredStubs.cpp:44) — dynamic unit blocking |
| `CAiPathSpline::Generate` / `::Update` | 0x005B2FF0 / 0x005B26C0 | provisorischer Lift, TODO-Kommentar im Code |
| A* core loop in `PathQueue` | 0x00765B20 ff. | only heap/bucket mechanics reconstructed |
| Top Level Motion Tick Dispatcher | — | not reconstructed (calls CalcMoveLand/Water/Air) |

All the necessary parameters (SteeringParams, speed cap formula, turn limiter, occupancy predicates, heuristics) are fully available - the replica can deterministically assemble these functions from the building blocks.

## Refs
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\SFootprint.h (SFootprint, EOccupancyCaps, EFootprintFlags)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\STIMap.cpp:3481 (IsBlockingTerrain), :3500 (OccupancyCapsOfFootprintAt 1x1), :3996 (OCCUPY_MobileCheck NxN), :4115 (OCCUPY_Filter), :4153 (OCCUPY_FootprintFits), :4197 (OCCUPY_HoverFootprintFits), :1531 (kHeightWordScale=0.0078125)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\COGrid.h (COGrid: terrainOccupation/waterOccupation/mOccupation, EntityOccupationManager 4x4-Buckets)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\COGrid.cpp:697 (ExecuteOccupy), :723 (ReleaseOccupy -> DirtyClusters)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\path\PathTables.cpp:1251 (OccupySourceBinding::GetOccupationData, 9x9 masks), :1326 (PathTables ctor: 1 ClusterMap per footprint, numLevels=2), :1421 (UpdateBackground), :1444 (DirtyClusters)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\gpg\core\algorithms\Cluster.h (HaStar: Cluster/Subcluster/ClusterMap/ClusterCache, QuantizeEdgeCost)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\gpg\core\algorithms\Cluster.cpp:105-108 (kClusterSizeByLevel {1,8,32,128}), :4528 (ClusterMap ctor), :4614 (ClusterRect)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\path\IPathTraveler.h (Traveler-Callback-Interface)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\ai\CAiPathFinder.h / .cpp:711 (SetUnit), :839 (CanTraverseCell), :859 (IsInBounds), :899 (GetHeuristicCost Octile*1.01), :1006 (GetPathcap)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\ai\CAiPathNavigator.h / .cpp:1148 (RequestPath), :1188 (RequestContinuationPath), :1275 (TryAdvanceTargetPoint), :1332 (UpdateCurrentPosition/Repath logic), :529 (CanOccupyTargetCell)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\ai\CAiNavigatorLand.cpp:509 (Execute -> Steering)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\ai\CAiNavigatorAir.cpp:438 (Execute, no pathfinding), :488 (BuildGoalWorldPos)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\ai\CAiSteeringImpl.cpp:229 (ComputeBrakingLeadDistance), :254 (BuildCollisionObb2D), :317 (UnitsWillCollide), :554 (PredictCollisionForSteerings), :648 (CollectCollisionCandidates), :704 (ResolvePossibleCollisionState), :1352 (CheckCollisions), :1387 (ProcessSplineMovement), :1494 (DriveToNextWaypoint), :1534 (FlyToNextWaypoint), :1562 (Execute)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\ai\CAiPathSpline.h (SteeringParams, CPathPoint, SContinueInfo, ECollisionType)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\ai\CAiPathSpline.cpp:26-30 (Tick-Konstanten), :57 (SteeringParams ctor), :253 (ComputeSteeringSpeedCapFromParams), :305 (RotateDirectionTowardTargetLimited), :1329 (Update, provisorisch), :1368 (Generate, provisorisch)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\CUnitMotion.h (fields + private integrator methods)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\CUnitMotion.cpp:51-69 (Constants), :1228 (AddImpulse), :1594 (GetElevation), :1622 (CalcWingedLift), :1674 (CalcMoveLand), :1706 (CalcMoveWater), :1744 (ProcessCommonMotionState), :1831 (HandleDivingAndSurfacing), :1919 (TransitionBetweenLayers), :1944 (CalcAirMovementDampingFactor), :1988 (CalcDesiredTargetElevation), :2042 (CalcWingedOrientation), :2224 (CalcHoverOrientation), :2277 (CalcRollHack), :2338 (SnapToWater), :2387 (SnapToGround)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\EngineMethodStubs2.cpp:63 (CalcMoveCommon = STUB)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\EngineUnrecoveredStubs.cpp:44 (COORDS_CanMoveAt = STUB)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\resource\blueprints\RUnitBlueprint.h:106 (ERuleBPUnitMovementType RULEUMT_*), :214 (RUnitBlueprintPhysics), :338 (RUnitBlueprintAir)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\resource\blueprints\RUnitBlueprint.cpp:258 (MotionType->Caps table), :707 (ComputeDerivedQuantities), :802 (OnInitBlueprint Air-Defaults)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\RRuleGameRules.cpp:2300 (FindFootprint: gleiche Caps, min max(|dx|,|dz|))
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\entity\Entity.cpp:8240 (COORDS_Elevation), :8261 (COORDS_ToWorldPos cell->world)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\core\Unit.cpp:14054 (ReserveOgridRect), :14085 (CanReserveOgridRect), :14019 (ReleaseOccupyGround), :2395 (IsMeleeCandidateCellNavigable)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\core\IUnit.cpp:120 (CalcSpawnElevation per layer)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\ai\CAiFormationInstance.cpp:3816 (ComputeRunScriptOffset), :3852 (GetFormationPosition), :3916 (GetAdjustedFormationPosition), :4300 (CalcFormationSpeed)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\Sim.cpp:7423 (UpdatePaths), :12005 (AdvanceBeat -> PathTables::UpdateBackground mit ConVar-Budget)
- gamedata\mohodata.scd :: lua/footprints.lua (global footprint table: 20 SpecFootprints)
- gamedata\lua.scd :: lua/formations.lua (AttackFormation/GrowthFormation, BlockBuilderLand:837, GetColSpot:914, BlockBuilderAir:937, FormationPos-Format)
