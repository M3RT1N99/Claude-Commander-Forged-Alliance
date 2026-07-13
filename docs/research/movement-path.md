# agent8

## Summary
Die FA-Engine trennt Bewegung sauber in vier Schichten: (1) ein Zellen-Passierbarkeits-Grid (1 Zelle = 1 Weltmeter, aus Heightmap-Slope + Wassertiefe + TerrainType-Blocking + Struktur-Occupancy-Bitmaps), (2) einen hierarchischen A* ("HaStar", Cluster 8x8/32x32, eine ClusterMap pro Footprint-Typ) der Zellpfade liefert, (3) einen Path-Navigator der Wegpunkte auswaehlt/repatht, und (4) eine Steering-Schicht (CAiSteeringImpl + CAiPathSpline + CUnitMotion) die Beschleunigung/Bremsen/TurnRate/Elevation pro Tick (0.1 s) integriert und Unit-Ausweichen per OBB-Kollisionsvorhersage macht. Alle Blueprint-Werte sind in Einheiten/Sekunde bzw. Grad/Sekunde und werden mit festen Tick-Faktoren (0.1 / 0.01 / pi/180*0.1) skaliert. Zwei Kernfunktionen sind in faf-re NICHT rekonstruiert (CUnitMotion::CalcMoveCommon, COORDS_CanMoveAt, CAiPathSpline::Generate/Update nur provisorisch) — dafuer sind alle Parameter, Konstanten und Hilfsmathematik vorhanden, sodass ein Nachbau die Luecke deterministisch schliessen kann.

## Key Facts
- Sim laeuft mit 10 Ticks/s: MaxSpeed*0.1 = Meter/Tick, MaxAcceleration/MaxBrake/MaxSteerForce*0.01 = Meter/Tick^2, TurnRate/TurnFacingRate [Grad/s] * 0.0017453292 = Radiant/Tick (CAiPathSpline.cpp:26-28).
- Pfad-Grid = Heightmap-Zellgrid, 1 Zelle = 1 Weltmeter; Höhen sind uint16 mit Skalierung 0.0078125 (=1/128) Meter pro Einheit (STIMap.cpp:1531).
- Passierbarkeit pro Zelle = Bitmaske EOccupancyCaps {LAND=1, SEABED=2, SUB=4, WATER=8, AIR=16, ORBIT=32}, berechnet aus Footprint(MaxSlope, MinWaterDepth, MaxWaterDepth, SizeX/Z) + Heightmap + TerrainType-Blocking + zwei Struktur-Bitmaps (terrainOccupation, waterOccupation).
- Slope-Test ist KEIN Winkel: max. absolute Höhendifferenz benachbarter Heightmap-Samples (in Metern) > MaxSlope => LAND|SEABED entfällt. Standard-MaxSlope aller Land-Footprints = 0.75 (footprints.lua).
- Footprints sind eine globale Tabelle aus mohodata.scd:lua/footprints.lua (20 Einträge, z.B. Vehicle1x1 LAND MaxWaterDepth=0.05 MaxSlope=0.75); Blueprint-MotionType (RULEUMT_*) mappt auf Caps und die Engine wählt per FindFootprint den nächstgrößen Eintrag mit gleichen Caps.
- Pathfinding ist hierarchisches A* (gpg::HaStar) mit Cluster-Größen {1, 8, 32, 128} Zellen; PathTables baut pro Footprint-Typ EINE ClusterMap mit numLevels=2 (=> Level 8x8 und 32x32) und aktualisiert sie inkrementell mit Frame-Budget.
- Der eigentliche A* läuft in einer per-Army PathQueue; die Unit stellt über IPathTraveler nur Callbacks: CanTraverseCell, IsInBounds, GetHeuristicCost (Octile-Distanz * 1.01), GetAnchorCell, IsGoalCandidateCell, GetPathcap (Suchbudget pro Layer).
- Repath-Trigger im CAiPathNavigator: Zielabstand > mRepathDistanceThreshold (wird bei jedem Zielwechsel auf halben Restabstand gesetzt), Layerwechsel, 30 Ticks ohne Positionsänderung, oder explizites mRepathRequested; Retry-Delay 10 Ticks, 3 Fehlschläge => nächste Eskalationsstufe, 3x3 => AIPATHNAVSTATE_Failed.
- Unit-Avoidance ist Vorhersage-basiert (kein Boids): CAiSteeringImpl sammelt Nachbarn im Radius (Größe + Pfadlänge*MaxSpeed*0.1 + Bremsweg v²/2a), simuliert beide Pfad-Splines alle 3 Ticks vorwärts und testet 2D-OBB-Überlappung (aufgeblähte Länge = SizeZ + Bremsweg).
- Kollisionsreaktion ist diskret: COLLISIONTYPE_1 (Kollision vorhergesagt) => Auflösung in None / 2 (Ausweichziel seitlich, Abstand = SizeMax_A + SizeMax_B + 0.5) / 4 (Pfad neu) / 5 (Peer soll repathen); 45°-Kegel-Test (cos=0.707) entscheidet ob Ausweichen oder Repath.
- Es gibt KEIN physikalisches Pushing zwischen Einheiten: CUnitMotion::mIsBeingPushed wird nur durch AddImpulse (Waffen-/Todes-Impulse) gesetzt; Blockierung läuft über Occupancy-Bits + Reservierungs-Bitmap (mOccupation) + Ausweich-Steering.
- Elevation/Layer: Land/Seabed => y = Terrainhöhe (SnapToGround mittelt 4 Footprint-Ecken und kippt die Orientierung in die Flächennormale); Water => y = Wasserspiegel; Sub => y = Wasserspiegel + Elevation (negativ); Air => y = Oberfläche + Elevation. Hover benutzt SnapToGround mit Wasser-Floor + Elevation-Offset.
- Schiffe haben KEINEN echten Tiefgang: Draft wird über Footprint-MinWaterDepth (Water*: 1.5, Water3x3: 0.25) und den Meshoffset abgebildet; Tauchen/Auftauchen ist ein eigener Zustand mit sinusförmiger Geschwindigkeitskurve aus Physics.DiveSurfaceSpeed*0.1.
- Turn-Radius-Limit für Schiffe: ComputeSteeringSpeedCapFromParams begrenzt die Geschwindigkeit anhand des Kurvenradius (r = d²/(2*cross)); ist r < TurnRadius, wird die Speed auf TurnRate*r*0.5 gedeckelt, sonst auf TurnRadius; RotateOnSpot-Units (Bots) fahren erst bei Heading-Alignment > 0.98 an, sonst Speed 0.
- Luft: kein Pathfinding (CAiNavigatorAir fliegt direkt zum Goal), Steuerung über KMove/KMoveDamping-Dämpfung, TurnSpeed/CombatTurnSpeed (rad/s, pro Tick *0.1 geklemmt), LiftFactor für vertikale Kraft, BankFactor*(1-Vorwärtsausrichtung)*Speed/StartTurnDistance für Rollwinkel.
- Formationen kommen aus lua/formations.lua (lua.scd): Einträge {xOffset, -rowOffset, category, row, true}; die Engine (CAiFormationInstance) skaliert sie mit mFormationUpdateScale, rotiert sie mit der Formations-Orientierung, snappt sie per FindSlotFor auf freie Zellen und regelt die Formationsgeschwindigkeit (Speed-Scale 0.85 Basis, Delta-Regelung ±5..+20%).

## Details
## 1. Terrain-Passierbarkeit (Grid-Aufbau)

### Datenquellen
- **Heightmap** `CHeightField`: `uint16 data[width*height]`, Weltmeter = `sample * 0.0078125f` (1/128). Grid ist (mapSizeX+1) x (mapSizeZ+1) Samples; **eine Pfad-Zelle = 1 Weltmeter**, Zelle (x,z) wird durch die 4 Samples (x,z),(x+1,z),(x,z+1),(x+1,z+1) definiert.
- **TerrainType-Grid** `mTerrainType` + `mBlocking[]`-Tabelle → `STIMap::IsBlockingTerrain(z,x)` (STIMap.cpp:3481). Liefert auch true bei x >= width-1 bzw. z >= height-1 (Randzellen sind blockiert).
- **Wasser**: globale Ebene `mWaterElevation` (nur EIN Wasserspiegel je Map), `mWaterEnabled`; wenn aus → Ersatzwert `-10000.0f`.
- **COGrid** (moho/sim/COGrid.h) hält 3 BitArray2D:
  - `terrainOccupation` — von Gebäuden/Props belegte Boden-Zellen (Caps LAND|SEABED|SUB)
  - `waterOccupation` — Wasser-Belegung (Caps WATER)
  - `mOccupation` — **Reservierungs-Bitmap für mobile Units** (Unit::ReserveOgridRect / CanReserveOgridRect)
  - `ExecuteOccupy/ReleaseOccupy` setzen/löschen Bits und rufen `Sim::mPathTables->DirtyClusters(rect)` → inkrementeller Cluster-Rebuild.

### Footprint (SFootprint, 16 Byte)
`mSizeX:u8, mSizeZ:u8, mOccupancyCaps:u8, mFlags:i8, mMaxSlope:f32, mMinWaterDepth:f32, mMaxWaterDepth:f32`
- Caps: LAND=0x1, SEABED=0x2, SUB=0x4, WATER=0x8, AIR=0x10, ORBIT=0x20, ANY=0xFF
- Flags: FPFLAG_IgnoreStructures=0x1 (Footprint ignoriert Gebäude-Occupancy — z.B. Experimentals)
- Footprint-Origin-Zelle aus Weltposition: `cell = round(worldPos - size*0.5)` (`SFootprint::ToCellPos`)
- Zelle → Welt-Mitte: `world = cell + size*0.5` (`COORDS_ToWorldPos`, Entity.cpp:8261)

### Caps-Berechnung, 1x1-Footprint (`STIMap::OccupancyCapsOfFootprintAt`, STIMap.cpp:3500)
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
**Wichtig:** "MaxSlope" ist eine **Höhendifferenz in Metern pro Zelle**, kein Winkel. 0.75 entspricht ~36.9°.

### Caps-Berechnung, NxN-Footprint (`OCCUPY_MobileCheck`, STIMap.cpp:3996)
Identisch, aber über **alle** Samples im Rechteck `[x0..x0+sizeX] x [z0..z0+sizeZ]` (inklusive!): min/max Höhe global, Blocking-Test je Zelle, Slope = max. Nachbardifferenz entlang jeder Zeile und jeder Spalte.

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
`OCCUPY_HoverFootprintFits` (STIMap.cpp:4197): berechnet MobileCheck und löscht OC_SUB, wenn der Aufrufer auf Layer WATER ist.

### MotionType → Caps-Mapping (RUnitBlueprint.cpp:258)
| RULEUMT | Wert | Caps |
|---|---|---|
| None | 0 | 0x00 (Gebäude: Caps = Physics.BuildOnLayerCaps) |
| Land | 1 | LAND |
| Air | 2 | AIR |
| Water | 3 | WATER |
| Biped | 4 | LAND |
| SurfacingSub | 5 | SUB\|WATER (0x0C) |
| Amphibious | 6 | LAND\|SEABED (0x03) |
| Hover | 7 | LAND\|WATER (0x09) |
| AmphibiousFloating | 8 | LAND\|WATER (0x09) |
| Special | 9 | 0x00 |

`RUnitBlueprintPhysics::ComputeDerivedQuantities` (RUnitBlueprint.cpp:707): setzt MotionType=None wenn MaxSpeed==0; MaxSpeedReverse<0 → =MaxSpeed; AttackElevation==0 → =Elevation; CatchUpAcc==0 → max(MaxAcceleration, MaxBrake); SkirtSize >= Footprint-Size; löst dann via `RRuleGameRules::FindFootprint` (RRuleGameRules.cpp:2300) den nächstpassenden Footprint auf: **gleiche Caps** und minimales `max(|dSizeX|,|dSizeZ|)`.

### Footprint-Tabelle (Ground Truth) — `mohodata.scd : lua/footprints.lua`
20 Einträge, u.a.:
- Vehicle1x1 / 2x2 / 5x5: LAND, MaxWaterDepth=0.05, MaxSlope=0.75 (5x5 mit IgnoreStructures)
- Amphibious1x1 / 3x3 / 6x6: LAND|SEABED, MaxWaterDepth=25, MaxSlope=0.75
- WaterLand1x1/2x2 (Hover): LAND|WATER, MaxWaterDepth=1, MinWaterDepth=0.1, MaxSlope=0.75; WaterLand3x3/5x5: MaxWaterDepth=5, MinWaterDepth=0
- SurfacingSub2x2/3x3/4x4/12x12: SUB|WATER, MinWaterDepth=1.5
- Water1x1/3x3/4x4/6x6/8x8/11x11: WATER, MinWaterDepth=1.5 (3x3: 0.25)

Kommentar in der Datei: **jeder Footprint-Spec erzeugt eine eigene Pfad-Datenstruktur über die ganze Map** — Anzahl klein halten. Das bestätigt: eine ClusterMap pro Footprint.

## 2. Pathfinding

### Struktur
- `PathTables(footprints, grid, w, h)` (PathTables.cpp:1326): pro Footprint eine `OccupySourceBinding{grid, footprint}` + eine `gpg::HaStar::ClusterMap(source, w, h, cache, numLevels=2, area={-1,-1,sizeX+1,sizeZ+1})`.
- `gpg::HaStar` (gpg/core/algorithms/Cluster.h/.cpp): **Hierarchical A***. Cluster-Größen pro Level: `{1, 8, 32, 128}` Zellen (log2 `{0,3,5,7}`). Mit numLevels=2 existieren Level 1 (8x8) und Level 2 (32x32). Map-Dimensionen werden auf Vielfache von 32 aufgerundet.
- Ein Cluster (`Cluster::Data`) speichert: `nodeCount:u8`, `Node{x:u8,z:u8}[n]` (Randübergangsknoten) und eine Dreiecksmatrix `Edge{cost:i8}[n*(n-1)/2]` (Index = `lhs + rhs*(rhs-1)/2`). Kantenkosten sind quantisiert: `QuantizeEdgeCost(a,b) = ceil(ln(a/b)*6)` → Bucket 0..31.
- `ClusterCache` dedupliziert identische Cluster-Payloads (Hash über OccupationData / SubclusterData) — auf typischen Maps gibt es nur wenige Dutzend verschiedene 8x8-Muster.
- Rohdaten je Cluster: `OccupationSource::GetOccupationData(x, z, out)` (PathTables.cpp:1251) baut **9 uint16-Spalten mit je 9 Bits**: für jedes (x,row) im 9x9-Fenster wird `OCCUPY_Filter(fp, grid, cell, OC_ANY)` ausgewertet; ist das Ergebnis 0, wird die Bitmaske `(widthMask << x) >> (sizeX-1)` ausgeblendet. Danach werden für Footprints mit sizeZ>1 die Zeilen per AND verodert (der Footprint muss auf allen Zeilen passen). => **Die Passierbarkeit ist bereits footprint-erodiert** (Footprint-Origin passt ⟺ Bit gesetzt).
- Inkrementeller Rebuild: `Sim::AdvanceBeat` → `PathTables::UpdateBackground(&budget)` → `ClusterMap::BackgroundWork(budget)` (nur wenn ConVar `path_background_update` an; Budget aus ConVar). `COGrid::ExecuteOccupy/ReleaseOccupy` → `DirtyClusters(rect)` → `ClusterMap::DirtyRect`.

### Suchanfrage (IPathTraveler / CAiPathFinder)
Der eigentliche A*-Loop lebt in `moho::PathQueue` (per Army, `CArmyImpl::PathFinder`); faf-re hat davon nur die Heap-/Bucket-Mechanik (`PathQueueWorkHeapEntry{totalCost, lane, handleIndex}`, Min-Heap sift-up/down + handle→index-Map). Die Unit-Seite ist vollständig:

`CAiPathFinder : IPathTraveler` (CAiPathFinder.h) Callbacks:
- `GetFootprint()` → normaler oder Alt-Footprint (FAVORSWATER-Units schalten unter Wasser auf Alt-Footprint um, CAiPathNavigator.cpp:UpdateWaterFavorAltFootprintMode)
- `IsInBounds(cell)` → innerhalb `mPlayableRect` mit Margin = max(sizeX,sizeZ) (außer Army.UseWholeMap)
- `CanTraverseCell(cell)` → IsInBounds && nicht in der Rect-Historie der letzten Suchen blockiert
- `GetHeuristicCost(cell)` → **Octile-Distanz** zum Goal-Rechteck: `dx,dz` = Abstand zum Rect; `max(dx,dz) + min(dx,dz)*0.41421354f`, dann `* 1.01f` (leicht inadmissible → schneller, leicht suboptimal)
- `IsGoalCandidateCell(cell)` → im äußeren Goal-Rect (`mPos1`) aber außerhalb des inneren Rects (`mPos2`) → **Ringziel** (z.B. "in Waffenreichweite von X")
- `ShouldSearchRect(rect)` → Cluster-Rect-Filter für die hierarchische Suche
- `GetPathcap()` → Suchbudget: Army.PathCapLand (MotionType==1), .PathCapSea (==3), sonst .PathCapBoth
- `OnPathAccepted/Rejected/Cancelled(SNavPath)` → Ergebnis ist `SNavPath` = Vektor von `SOCellPos{int16 x,z}`

### Pfadverfolgung & Repath (CAiPathNavigator, CAiPathNavigator.cpp)
State: Idle/Failed/Thinking/PathEvent3(=Vollsuche läuft)/PathEvent4(=Fortsetzungssuche)/HasPath/FollowingLeader.
- `RequestPath(mode)` mode∈{1=Initial, 2=Repath, 3=Leader/Attacking}: Anchor = aktuelle Zelle, Goal setzen, QueueSearch, State=PathEvent3.
- `UpdateCurrentPosition(pos)` je Tick:
  1. Countdown/Retry-Delays herunterzählen
  2. Vorderste Pfadzellen konsumieren solange die zweite näher ist als die erste
  3. Wenn Pfadende erreicht → Idle (Erfolg)
  4. `TryAdvanceTargetPoint()`: sucht den **weitesten direkt erreichbaren** Pfadknoten (Index bis `min(pathSize-1, max(10, firstReachable))`, Kandidaten > 50 Zellen Distanz werden übersprungen); Erreichbarkeit = `CanPathCellTransition` (Occupancy-Check am Zielknoten) && `CanReachCellFromCurrent`. Das ist die **Pfadglättung** (String-Pulling).
  5. Repath-Bedingungen: `mRepathDistanceThreshold < dist(current,target)` (Threshold wird bei jedem Zielwechsel auf `dist*0.5` gesetzt → wenn man sich vom Ziel entfernt statt zu nähern) ODER `mRepathRequested` ODER `mNoProgressTickCount > 30` (30 Ticks = 3 s ohne Positionsänderung) ODER Layerwechsel (`ReadUnitLayerToken`).
  6. Fehler-Eskalation in `OnEvent`: leeres Ergebnis → `mPathRetryDelayFrames=10`, nach 3 Fehlversuchen `mNoForwardDistanceFailCount++`, nach 3 davon → Failed.
- `RequestContinuationPath(2|3)`: kurze Nachsuche vom aktuellen Pfadkopf; Ergebnis wird **vorne** an den bestehenden Pfad geprepended (`PrependCells`).
- Pro Unit gibt es Tick-Buckets `entityId % 7` und `% 13` (Lastverteilung der Repath-Checks).

`CAiNavigatorLand::Execute()` (CAiNavigatorLand.cpp:509, ein CTask pro Tick):
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
`CAiNavigatorAir::Execute()` (CAiNavigatorAir.cpp:438): **kein Pathfinding**. Ziel = nächster Punkt des Goal-Rects (Perimeter-Suche), Motion fliegt direkt hin; Erfolg wenn `UnitMotion->AtTarget()` und Zielzelle == Goalzelle.

## 3. Bewegungsintegration (exakt)

### Skalierung (CAiPathSpline.cpp:26-28) — **Tick = 0.1 s**
```
kSpeedScalePerTick        = 0.1        // MaxSpeed [m/s]  -> m/Tick
kAccelerationScalePerTick = 0.01       // MaxAccel [m/s^2]-> m/Tick^2
kDegreesToSteeringRadiansPerTick = 0.0017453292   // = pi/180 * 0.1  => TurnRate ist Grad/SEKUNDE
```

### SteeringParams (CAiPathSpline.h:88, ctor CAiPathSpline.cpp:57) — das Parameterpaket der Integration
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
(Die z-Negierung ist die interne "Steering-2D-Ebene"; konsistent durchziehen.)

### Speed-Cap aus Kurvenradius (`ComputeSteeringSpeedCapFromParams`, CAiPathSpline.cpp:~253)
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
=> **Schiffe** (großer TurnRadius) werden in engen Kurven automatisch langsamer; das ist der komplette "TurnRadius bei Schiffen"-Mechanismus.

### Heading-Rotation (`RotateDirectionTowardTargetLimited`, CAiPathSpline.cpp:~305)
Dreht die aktuelle XZ-Richtung um höchstens `maxTurnRadians` (= mTurnRate pro Tick) zur Zielrichtung; sin() über Polynom-Approx `((a²*0.00761 - 0.16605)*a² + 1)*a`, cos() exakt. Vorzeichen aus dem 2D-Kreuzprodukt. Länge des Quellvektors bleibt erhalten.

### Lokale Bewegungs-Spline (CAiPathSpline::Generate/Update)
Konzept (in faf-re nur provisorisch geliftet, aber Funktionsvertrag klar):
- `Generate(unit, destination, pathType, allowContinuation)` erzeugt aus dem aktuellen Zustand (Pos, Heading, Velocity, ggf. `SContinueInfo` der letzten Generation) eine Kette von `CPathPoint{position, direction, state}` — **ein Knoten pro Sim-Tick**, indem die Bewegung mit den SteeringParams vorwärts simuliert wird (Speed-Cap → Beschleunigen/Bremsen → Heading drehen → Position integrieren).
- `Update(unit, mode)` (mode 3/4) verlängert/erneuert die Spline ohne neues Ziel.
- `mCurrentNodeIndex` läuft mit; `CUnitMotion::mNextWaypoint/mFollowingWaypoint` zeigen auf Knoten i und i+1 (`SetSplineData`).
- `EPathPointState PPS_*` markiert u.a. Stop-Knoten (PPS_1 → `ProcessCommonMotionState` schaltet auf "Stopping").
- **Nachbau-Empfehlung**: Genau diese Vorwärtssimulation implementieren — sie ist zugleich die Grundlage der Kollisionsvorhersage (die Splines beider Units werden verglichen).

### CUnitMotion (moho/unit/CUnitMotion.h) — der Integrator
- `CalcMoveLand(transform, &dist)` → `CalcMoveCommon` (**in faf-re STUB**, EngineMethodStubs2.cpp:63) → `FindIntersectingRaisedPlatform()` → `SnapToGround()` → `ProcessCommonMotionState()`
- `CalcMoveWater(transform)` → `CalcMoveCommon` → `HandleDivingAndSurfacing()` → `SnapToWater()` → `ProcessCommonMotionState()`
- `ProcessCommonMotionState(ok)` (CUnitMotion.cpp:1744): Horz-Event-Statemachine
  - `!ok` → Stopped
  - `speed > formationTopSpeed * 0.08` → TopSpeed
  - sonst: near-target (`moveSpeedMult*MaxSpeed > dist`) oder nächster Splineknoten==PPS_1 → Stopping, sonst Cruising
  - Events feuern Lua-Callbacks `OnMotionHorzEventChange` / `OnMotionVertEventChange` / `OnMotionStateChange`
- `SnapToGround` (CUnitMotion.cpp:2387): 4 Ecken (±sizeX/2, ±sizeZ/2, rotiert) samplen, `pos.y = Mittelwert`; Normale aus den beiden Diagonalen; `StandUpright` → Normale = (0,1,0); `StandUpright||SinkLower` → `pos.y -= (maxH-minH)*0.25`; **Hover**: Sample-Elevation berücksichtigt Wasserspiegel (Floor) und `pos.y += Elevation`, Normale wird um Roll-Hack-Vektoren ergänzt. Abschluss: `COORDS_Tilt(orient, normal)`.
- `SnapToWater` (CUnitMotion.cpp:2338): `y = max(terrain+0.25, waterElev + mSubElevation)`; bei `mSubElevation<0` (getaucht) auf Wasserspiegel geklemmt; Tilt aus `CalcRollHack()`.
- `CalcRollHack()` (CUnitMotion.cpp:2277): Feder-Dämpfer für Rückstoß/Roll: `recoil *= (1 - RollDamping)`; `roll += recoil`; `recoil -= roll*RollStability`; beim Tauchen/Auftauchen zusätzlich Nick um `divingSpeed*4`, geglättet mit 0.25/0.75.
- `AddImpulse(imp, ballistic)` (CUnitMotion.cpp:1228): Air → direkt auf PhysBody; sonst `v = imp + v*0.5`, Speed auf `formationTopSpeed*0.2` geklemmt, `mIsBeingPushed = true`, `mProcessSurfaceCollision = true`. Bei `ballistic` → Layer=Air, MotionState=Ballistic, zufälliger Drehimpuls.
- `TransitionBetweenLayers` (CUnitMotion.cpp:1919): lineare Interpolation Pos + NLerp Orientierung über `Physics.LayerTransitionDuration * 10` Ticks.

### Tauchen/Auftauchen (`HandleDivingAndSurfacing`, CUnitMotion.cpp:1831)
```
diveDepthLimit = attr.spawnElevationOffset (= Physics.Elevation, negativ)
surfaceLimit   = min(0, terrain+0.25 - waterElev);  diveDepthLimit = max(diveDepthLimit, surfaceLimit)
phase = |subElev / diveDepthLimit|; if (phase > 0.5) phase = 1-phase
base  = Physics.DiveSurfaceSpeed * 0.1
divingSpeed = max(base*0.1, sin(phase*pi) * base)      // sanfte Ein-/Ausblendung
MovingUp:   subElev = min(0, subElev + divingSpeed); bei 0   -> Layer setzen, State löschen, VertEvent None
MovingDown: subElev = max(limit, subElev - divingSpeed); bei limit -> Layer setzen, VertEvent Top
```

## 4. Luft

`RUnitBlueprintAir` (RUnitBlueprint.h:338): CanFly, Winged, FlyInWater, AutoLandTime, MaxAirspeed, MinAirspeed, TurnSpeed, CombatTurnSpeed, StartTurnDistance, TightTurnMultiplier, SustainedTurnThreshold, LiftFactor, BankFactor, BankForward, EngageDistance, BreakOffTrigger/Distance, **KMove, KMoveDamping, KLift, KLiftDamping, KTurn, KTurnDamping, KRoll, KRollDamping**, Circling*, HoverOverAttack, TransportHoverHeight, PredictAheadForBombDrop.
Defaults in `RUnitBlueprint::OnInitBlueprint` (RUnitBlueprint.cpp:802): MotionType==Air → CanFly=1; MaxAirspeed==0 → =Physics.MaxSpeed; MinAirspeed==0 → =MaxAirspeed; StartTurnDistance==0 → `mSizeZ * 3`.

- **Dämpfung** `CalcAirMovementDampingFactor` (CUnitMotion.cpp:1944): Kategorie TARGETCHASER → 1.0; sonst `speed = min(|movement|, formationTopSpeed)`, `denom = max(1, speed)`; `topSpeed <= denom` → KMove; sonst `min(topSpeed/denom, KMoveDamping)`.
- **Auftrieb** `CalcWingedLift(maxLift, wingFactor)` (CUnitMotion.cpp:1622): `lift = (wingFactor - 0.5) * Air.LiftFactor`; wenn `lift <= 0` und `targetElev*0.5 > curElev` → `targetElev*0.5 - curElev` (Notauftrieb); wenn `maxLift <= lift` → maxLift.
- **Kurven/Banking** `CalcWingedOrientation` (CUnitMotion.cpp:2042):
  - `limitedSpeed = min(|controlXZ|, formationTopSpeed)`; unter `StartTurnDistance` (und nicht guarding/combat) wird ein Fallback-Vektor benutzt
  - Kraft = `refVector * limitedSpeed`, im Nicht-CombatTurn zusätzlich mit `max(0.5, alignment)` skaliert
  - Drehung: `turnDelta = atan2(sel) - atan2(ref)`, auf ±pi normiert, geklemmt auf `maxTurnSpeed * 0.1` mit `maxTurnSpeed = (combatState==CombatTurn) ? CombatTurnSpeed : TurnSpeed` → **TurnSpeed ist rad/s**
  - Roll: `bias = elevationScale * (1 - forwardAlignment) * BankFactor * min(speed/StartTurnDistance, 0.5|1.0) * sign`; im NormalTurn wird `forwardAlignment^8` und `BankFactor*10` verwendet; Up-Vektor aus Roll-Bias + Wing-Projektion, dann normalisiert.
- **Hover-Orientierung** `CalcHoverOrientation` (CUnitMotion.cpp:2224): `up = (v - vPrev) * (BankFactor * min(curElev/Elevation, 1)) - gravity*0.1`; bei `BankForward==0` wird die Vorwärtskomponente der Beschleunigung herausprojiziert (nur seitliches Banking).
- **Zielhöhe** `CalcDesiredTargetElevation` (CUnitMotion.cpp:1988): Ziel in der Luft → `targetUnit.Physics.Elevation + terrain`, mind. `Elevation*0.5 + terrain`; sonst `terrain + (combatState==1 ? AttackElevation : Elevation)`. `GetElevation()` berücksichtigt Carrier-Modus (`mHeight`, Faktor 0.25) und `mRandomElevation`.
- **Landen/Starten**: `ShouldHoverInsteadOfLand()` (TransportHoverHeight>0 und Transport lädt / hat Fracht → nicht landen); Landen selbst läuft über Layer-Transition (`TransitionBetweenLayers`, `LayerChangeOffsetHeight`, `LayerTransitionDuration`) und `UNITSTATE_MovingDown/MovingUp`.
- **Flugsteuerung** (`CAiSteeringImpl::FlyToNextWaypoint`, CAiSteeringImpl.cpp:1534): kein Spline, nur `MotionSetTarget(motion, snappedWaypoint, zero, LAYER_None)`; "erreicht" wenn `|delta|² <= airTolerance²` (ConVar, Fallback 1.0).

## 5. Marine

- Kein echter Tiefgang. Schiffe liegen auf `y = waterElevation` (COORDS_ToWorldPos / CalcSpawnElevation, IUnit.cpp:120: LAYER_Water → Wasserspiegel). Der "Draft" ist rein die **Footprint-MinWaterDepth** (1.5 für die meisten Water-Footprints, 0.25 für Water3x3 = kleine Boote), die verhindert, dass Schiffe in flaches Wasser pathen.
- U-Boote: LAYER_Sub → `y = waterElevation + Physics.Elevation` (Elevation negativ). SurfacingSubs wechseln zwischen SUB und WATER via `SetNewTargetLayer` + Dive/Surface-Kurve.
- `mIsNaval` steuert eine Sonderregel im Ausweichen (`MarkSecondarySteeringForRepath`): Naval-Units signalisieren anderen Naval-Units COLLISIONTYPE_5 (Repath), Land↔Naval nicht.

## 6. Kollision / Blocking / Pushing

### Statische Belegung
- Gebäude/Props: `Unit::ExecuteOccupyGround` → `ApplyOccupancyRect` schreibt in `terrainOccupation` (Caps LAND|SEABED|SUB) und/oder `waterOccupation` (WATER). Rechteck aus `Physics.OccupyRects` (falls definiert, mit CenterOffset/HalfSize, gerundet mit floor(v+0.5)) sonst aus Footprint. `ReleaseOccupyGround` invers. Beides dirty-marked die Cluster.
- Skirt (`SkirtSizeX/Z`, `SkirtOffsetX/Z`, `FlattenSkirt`, `MaxGroundVariation`) betrifft nur Bauplatz-Prüfung (`OCCUPY_Check`, `OCCUPY_CheckAreaFlatness`, `OCCUPY_CheckEdgeFlatness`), nicht das Pathing.

### Dynamische Reservierung
- `COGrid::mOccupation` ist die dritte Bitmap: `Unit::ReserveOgridRect(rect)` / `FreeOgridRect()` / `CanReserveOgridRect(rect)` (Unit.cpp:14054-14105). Wird u.a. für Nahkampf-Zielzellen und Zellslots benutzt (`IsMeleeCandidateCellNavigable`).
- `COORDS_CanMoveAt(cell, grid, unit, disallowAttached, ignoreUnit)` (0x00720F70) prüft dynamisches Unit-Blocking — **in faf-re nicht rekonstruiert** (EngineUnrecoveredStubs.cpp:44). Nachbau: Entities im Zell-Rechteck über den EntityOccupationManager holen und lebende, nicht-attached, nicht-ignorierte Units als Blocker werten.
- `EntityOccupationManager` (COGrid.h): Broadphase-Buckets à **4x4 Weltmeter**, getrennte Bucket-Arrays für Unit/Prop/Entity; `GatherUnmarkedUnitsInRect`, `GetEntityCollisionsInLine`, `CollectEntitiesInBox`, `ForAllEntitiesIterator(sphere)` (für Waffen/AoE).

### Unit-Ausweichen (CAiSteeringImpl.cpp)
1. `CheckCollisions()` (Zeile 1352): Skip wenn tot/im Bau/LAYER_Sub. `CollectCollisionCandidates` (Zeile 648):
   - Suchradius `ComputeCollisionQueryRadius` = `max(sizeX,sizeZ) + pathNodeCount*MaxSpeed*0.1 + MaxSpeed²/(2*MaxAcceleration)`
   - Filter: nur mobile, lebende, nicht-attached Units mit Steering; Kandidaten mit `pathType == PT_2` (bereits Ausweichpfad) werden übersprungen
   - Gleicher Layer + Owner hat NICHT höhere Priorität → "deferred" (der Andere weicht aus), sonst "preferred"
2. `PredictCollisionForSteerings(a,b)` (Zeile 554): läuft beide Splines in **3-Tick-Schritten** ab (`pathStep += 3`), Geschwindigkeit = Knotendifferenz, und testet `UnitsWillCollide`; der nächstliegende Treffer wird als `SCollisionInfo{type=1, pos, unit, tickGate}` gespeichert.
3. `UnitsWillCollide` (Zeile 317): Bremsweg `lead = (|v|*10)² / (2*MaxAcceleration)` (0 bei `ignoreBraking`, d.h. gleiche Formation und keiner attackiert); aufgeblähte Länge = `mSizeZ + lead`; Vorabtest über Distanz, dann **2D-OBB-Überlappung** (SAT über 4 Achsen). OBB: Center = pos + forward*lead, Extents = `((sizeX+sizeZ)*0.25, inflatedLength*0.5)`.
4. `ResolvePossibleCollisionState` (Zeile 704), wenn `sim.tick >= tickGate`:
   - Gegner ist Luft → dessen Motion bekommt `SetTarget(ownPos, LAYER_Air)` (ausweichen nach oben), eigener State = None
   - Gegner steht (v==0) oder keine echte Annäherung → None
   - `dot(dirToOther, otherHeading) <= 0.707` (nicht im 45°-Kegel) → **COLLISIONTYPE_4** = Pfad neu berechnen
   - sonst: Peer ggf. COLLISIONTYPE_5 markieren; Ausweichrichtung `ComputeAvoidanceDirection` (Basis = Gegner-Heading, bei starker Ausrichtung gemittelt mit eigenem; Lateralvektor senkrecht dazu, Seite über Kreuzprodukt, **in gleicher Formation invertiert**); Ziel = `probePos + avoidDir * (maxExtent_A + maxExtent_B + 0.5)` → **COLLISIONTYPE_2**
5. `ProcessSplineMovement` (Zeile 1387) wendet an: Typ 2 → `MotionSetTarget(avoidTarget)` + `UpdatePath(2, avoidTarget)`; Typ 3 → Navigator-Repath; Typ 4/5 → `UpdatePath(4, dest)`; Typ None → Originalziel wiederherstellen.
6. `mIsBeingPushed` (nur durch AddImpulse gesetzt): Steering stoppt, wartet bis `|v| < MaxSpeed*0.01`, dann Pfad neu.

**Es gibt kein kontinuierliches Auseinanderdrücken (Pushing) von Units.** Überlappung wird durch Vorhersage + Ausweichen + Occupancy vermieden, nicht durch Impulse aufgelöst.

## 7. Formationen

- Formen kommen aus Lua: `lua.scd : lua/formations.lua`. `AttackFormation`/`GrowthFormation` (weitere: Block, Circle, Guard) bekommen die Unit-Liste, kategorisieren sie (Land/Air/Sea/Sub) und füllen `FormationPos` mit Einträgen `{ xPos*spacing, -formationLength*spacing, categoryTable[group], formationLength, true }`. Reihenbreiten sind Blocktabellen mit `LineBreak`/`RowBreak`-Abständen; Spaltenreihenfolge über `GetColSpot` (von der Mitte nach außen alternierend). Naval nutzt spacing 1.5.
- `PickBestTravelFormationIndex(typeName, dist)` → 0 für AirFormations sonst 1; `PickBestFinalFormationIndex` → -1.
- Engine (`CAiFormationInstance`, moho/ai/CAiFormationInstance.cpp):
  - `GetFormationPosition` (Zeile 3852): `world = formationCenter + (offsetX,offsetZ) [+ dynamicOffset]` → `FindSlotFor()` snappt auf eine freie/passierbare Zelle (nutzt `COORDS_CanMoveAt`).
  - `ComputeRunScriptOffset` (Zeile 3816): Offset * `mFormationUpdateScale`, rotiert mit `mOrientation` (Formationsrichtung), skaliert mit `(mMaxUnitSlotCount + 2)`.
  - `GetAdjustedFormationPosition` (Zeile 3916): Weltpos → Footprint-Origin-Zelle (`round(pos - size*0.5)`).
  - `CalcFormationSpeed` (Zeile 4300): Basis-Speedscale **0.85**; wenn die Unit dem Leader folgt und ein `speedAnchor` existiert: `delta = (speedBandLow - speedAnchor) * (CanFly ? 1.5 : 4.0)`, geklemmt auf [-5, +20], `scale = 1 + delta*0.1` (also 0.5x .. 3.0x). Rückgabe = `laneEntry->preferredSpeed` als Speed-Limit → geht als `speedLimit` in SteeringParams.
  - `mIsInFormation` / `FollowingLeader()` / `IgnoreFormation()` steuern, ob der Path-Navigator dem Leader folgt (State FollowingLeader) statt selbst zu pathen.

## 8. Lücken in faf-re (bewusst nachzubauen)

| Funktion | Adresse | Status |
|---|---|---|
| `CUnitMotion::CalcMoveCommon` | 0x006C1E20 | **Stub** (EngineMethodStubs2.cpp:63) — der eigentliche Land/Wasser-Integrationsschritt |
| `COORDS_CanMoveAt` | 0x00720F70 | **Stub** (EngineUnrecoveredStubs.cpp:44) — dynamisches Unit-Blocking |
| `CAiPathSpline::Generate` / `::Update` | 0x005B2FF0 / 0x005B26C0 | provisorischer Lift, TODO-Kommentar im Code |
| A*-Kernschleife in `PathQueue` | 0x00765B20 ff. | nur Heap-/Bucket-Mechanik rekonstruiert |
| Top-Level Motion-Tick-Dispatcher | — | nicht rekonstruiert (ruft CalcMoveLand/Water/Air) |

Alle dafür nötigen Parameter (SteeringParams, Speed-Cap-Formel, Turn-Limiter, Occupancy-Prädikate, Heuristik) sind vollständig vorhanden — der Nachbau kann diese Funktionen aus den Bausteinen deterministisch zusammensetzen.

## Refs
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\SFootprint.h (SFootprint, EOccupancyCaps, EFootprintFlags)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\STIMap.cpp:3481 (IsBlockingTerrain), :3500 (OccupancyCapsOfFootprintAt 1x1), :3996 (OCCUPY_MobileCheck NxN), :4115 (OCCUPY_Filter), :4153 (OCCUPY_FootprintFits), :4197 (OCCUPY_HoverFootprintFits), :1531 (kHeightWordScale=0.0078125)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\COGrid.h (COGrid: terrainOccupation/waterOccupation/mOccupation, EntityOccupationManager 4x4-Buckets)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\COGrid.cpp:697 (ExecuteOccupy), :723 (ReleaseOccupy -> DirtyClusters)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\path\PathTables.cpp:1251 (OccupySourceBinding::GetOccupationData, 9x9-Masken), :1326 (PathTables ctor: 1 ClusterMap pro Footprint, numLevels=2), :1421 (UpdateBackground), :1444 (DirtyClusters)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\gpg\core\algorithms\Cluster.h (HaStar: Cluster/Subcluster/ClusterMap/ClusterCache, QuantizeEdgeCost)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\gpg\core\algorithms\Cluster.cpp:105-108 (kClusterSizeByLevel {1,8,32,128}), :4528 (ClusterMap ctor), :4614 (ClusterRect)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\path\IPathTraveler.h (Traveler-Callback-Interface)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\ai\CAiPathFinder.h / .cpp:711 (SetUnit), :839 (CanTraverseCell), :859 (IsInBounds), :899 (GetHeuristicCost Octile*1.01), :1006 (GetPathcap)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\ai\CAiPathNavigator.h / .cpp:1148 (RequestPath), :1188 (RequestContinuationPath), :1275 (TryAdvanceTargetPoint), :1332 (UpdateCurrentPosition/Repath-Logik), :529 (CanOccupyTargetCell)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\ai\CAiNavigatorLand.cpp:509 (Execute -> Steering)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\ai\CAiNavigatorAir.cpp:438 (Execute, kein Pathfinding), :488 (BuildGoalWorldPos)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\ai\CAiSteeringImpl.cpp:229 (ComputeBrakingLeadDistance), :254 (BuildCollisionObb2D), :317 (UnitsWillCollide), :554 (PredictCollisionForSteerings), :648 (CollectCollisionCandidates), :704 (ResolvePossibleCollisionState), :1352 (CheckCollisions), :1387 (ProcessSplineMovement), :1494 (DriveToNextWaypoint), :1534 (FlyToNextWaypoint), :1562 (Execute)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\ai\CAiPathSpline.h (SteeringParams, CPathPoint, SContinueInfo, ECollisionType)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\ai\CAiPathSpline.cpp:26-30 (Tick-Konstanten), :57 (SteeringParams ctor), :253 (ComputeSteeringSpeedCapFromParams), :305 (RotateDirectionTowardTargetLimited), :1329 (Update, provisorisch), :1368 (Generate, provisorisch)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\CUnitMotion.h (Felder + private Integrator-Methoden)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\CUnitMotion.cpp:51-69 (Konstanten), :1228 (AddImpulse), :1594 (GetElevation), :1622 (CalcWingedLift), :1674 (CalcMoveLand), :1706 (CalcMoveWater), :1744 (ProcessCommonMotionState), :1831 (HandleDivingAndSurfacing), :1919 (TransitionBetweenLayers), :1944 (CalcAirMovementDampingFactor), :1988 (CalcDesiredTargetElevation), :2042 (CalcWingedOrientation), :2224 (CalcHoverOrientation), :2277 (CalcRollHack), :2338 (SnapToWater), :2387 (SnapToGround)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\EngineMethodStubs2.cpp:63 (CalcMoveCommon = STUB)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\EngineUnrecoveredStubs.cpp:44 (COORDS_CanMoveAt = STUB)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\resource\blueprints\RUnitBlueprint.h:106 (ERuleBPUnitMovementType RULEUMT_*), :214 (RUnitBlueprintPhysics), :338 (RUnitBlueprintAir)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\resource\blueprints\RUnitBlueprint.cpp:258 (MotionType->Caps-Tabelle), :707 (ComputeDerivedQuantities), :802 (OnInitBlueprint Air-Defaults)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\RRuleGameRules.cpp:2300 (FindFootprint: gleiche Caps, min max(|dx|,|dz|))
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\entity\Entity.cpp:8240 (COORDS_Elevation), :8261 (COORDS_ToWorldPos cell->world)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\core\Unit.cpp:14054 (ReserveOgridRect), :14085 (CanReserveOgridRect), :14019 (ReleaseOccupyGround), :2395 (IsMeleeCandidateCellNavigable)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\unit\core\IUnit.cpp:120 (CalcSpawnElevation je Layer)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\ai\CAiFormationInstance.cpp:3816 (ComputeRunScriptOffset), :3852 (GetFormationPosition), :3916 (GetAdjustedFormationPosition), :4300 (CalcFormationSpeed)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\Sim.cpp:7423 (UpdatePaths), :12005 (AdvanceBeat -> PathTables::UpdateBackground mit ConVar-Budget)
- gamedata\mohodata.scd :: lua/footprints.lua (globale Footprint-Tabelle: 20 SpecFootprints)
- gamedata\lua.scd :: lua/formations.lua (AttackFormation/GrowthFormation, BlockBuilderLand:837, GetColSpot:914, BlockBuilderAir:937, FormationPos-Format)
