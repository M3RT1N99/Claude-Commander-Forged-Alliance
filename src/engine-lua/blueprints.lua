__active_mods = {}
__registered = { Unit={}, Mesh={}, Prop={}, Projectile={}, Emitter={}, TrailEmitter={}, Beam={} }
local function collector(g) return function(bp) __registered[g][bp.BlueprintId or '?'] = bp end end
-- Blueprint-Defaults: die Engine liest ein .bp NICHT in eine rohe Tabelle,
-- sondern in ein getyptes Struct (Moho::RUnitBlueprint). Dessen Ctor
-- (@0x51E480, Cfile ~655645, plus die Sub-Ctors fuer Physics/Economy/AI)
-- initialisiert JEDES Feld mit einem Default; die Lua sieht das
-- reflektierte Struct. Darum darf Unit.lua ungeprueft auf
-- bp.Defense.Shield.ShieldSize (unit.lua:1572) oder bp.Footprint.SizeX
-- (unit.lua:243) zugreifen, obwohl die .bp-Datei diese Sektionen gar nicht
-- enthaelt. Werte 1:1 aus den Ctors — nichts geschaetzt.
__bpDefaults = {
  -- REntityBlueprint ctor (Cfile:646969-646979): the body of every unit --
  -- density and size for the mass, the inertia tensor (0 = derived from the
  -- size below, 647192-647199), the collision offset.
  AverageDensity = 0.49,
  SizeX = 1.0, SizeY = 1.0, SizeZ = 1.0,
  InertiaTensorX = 0.0, InertiaTensorY = 0.0, InertiaTensorZ = 0.0,
  CollisionOffsetX = 0.0, CollisionOffsetY = 0.0, CollisionOffsetZ = 0.0,
  -- Die Upgrade-Felder sind KEINE leeren Strings: der Ctor setzt sie auf den
  -- String "none" (Cfile:656076-656077, func_StringInitFilename("none", ...));
  -- nur UpgradesTo startet leer (str_empty, Cfile:656075).
  --
  -- Das ist kein Detail: construction.lua:863 fragt
  --   elseif blueprint.General.UpgradesFromBase != "none" then
  --       ... elseif blueprint.General.UpgradesFromBase == unitBp.General.UpgradesFromBase then
  --           performUpgrade = true
  -- Fehlt der Default, sind BEIDE Seiten nil — nil == nil ist wahr, und die UI
  -- haelt JEDES Gebaeude fuer ein Upgrade der ausgewaehlten Unit. Der Klick aufs
  -- Bau-Icon schickte dann ein UNITCOMMAND_Upgrade an die Sim, statt den
  -- Bau-Modus zu starten — nichts liess sich mehr bauen.
  General = {
    UpgradesFrom = 'none',
    UpgradesFromBase = 'none',
    UpgradesTo = '',
    -- Der Ctor (Cfile:656079-656081): mQuickSelectPriority = 0, mCapCost = 1.0,
    -- mSelectionPriority = 1. QuickSelectPriority > 0 macht eine Unit zum
    -- AVATAR (rechte Leiste; in Vanilla setzen es nur die vier ACU-.bp auf 1).
    QuickSelectPriority = 0,
    CapCost = 1.0,
    SelectionPriority = 1,
  },
  -- RUnitBlueprintAir fields used by motion and weapon gates. The reflected
  -- Lua name is MaxAirspeed (lower-case "s"), despite the C++ member being
  -- mMaxAirSpeed (Cfile:656086-656127, 657447-657561).
  -- RUnitBlueprintAir ctor (Cfile:656086-656129), every field.
  Air = {
    TurnSpeed = 1.0, CombatTurnSpeed = 1.0, TightTurnMultiplier = 1.0,
    KMove = 1.0, KMoveDamping = 1.0, KLift = 1.0, KLiftDamping = 1.0,
    CirclingRadiusVsAirMult = 1.0, SustainedTurnThreshold = 10.0,
    CirclingElevationChangeRatio = 0.25, LiftFactor = 5.0,
    CirclingFlightChangeFrequency = 2.0, BankFactor = 0.5,
    CirclingRadiusChangeMinRatio = 0.6, RandomBreakOffDistanceMult = 1.5,
    CanFly = false, Winged = false, FlyInWater = false, AutoLandTime = 0.0,
    MaxAirspeed = 0.0, MinAirspeed = 0.0, StartTurnDistance = 0.0,
    BankForward = false, EngageDistance = 0.0, BreakOffTrigger = 0.0,
    BreakOffDistance = 0.0, BreakOffIfNearNewTarget = false,
    KTurn = 3.0, KTurnDamping = 3.0, KRoll = 3.0, KRollDamping = 3.0,
    CirclingTurnMult = 3.0, CirclingRadiusChangeMaxRatio = 0.9,
    CirclingDirChange = true, HoverOverAttack = false,
    RandomMinChangeCombatStateTime = 3.0, RandomMaxChangeCombatStateTime = 6.0,
    TransportHoverHeight = 0.0, PredictAheadForBombDrop = 0.0,
  },
  -- IdleEffects: Tabellen-Feld im Struct -> leer, nie nil. unit.lua:2463
  -- indiziert es ungeprueft (bpTable[layer]).
  Display = {
    UniformScale = 1.0, SpawnRandomRotation = false, HideLifebars = false,
    IdleEffects = {}, MovementEffects = {},
    -- Der Ctor legt mDisplay.mIconName als LEEREN String an (Cfile:655662-655664:
    -- _Mysize = 0, Buf[0] = 0). KEIN einziges .bp setzt das Feld — trotzdem
    -- verkettet gamecommon.lua:17 es ungeprueft zu einem Pfad. Er wird dadurch
    -- '/textures/ui/common/icons/units/_icon.dds', DiskGetFileInfo liefert false,
    -- und die Lua faellt auf default_icon.dds zurueck (gamecommon.lua:22-24).
    -- Genau so ist es gemeint: das leere Feld IST der Standard-Weg.
    IconName = '',
  },
  Intel = {
    VisionRadius = 10, WaterVisionRadius = 10, RadarRadius = 0, SonarRadius = 0,
    OmniRadius = 0, RadarStealth = false, SonarStealth = false, Cloak = false,
    ShowIntelOnSelect = false, RadarStealthFieldRadius = 0,
    SonarStealthFieldRadius = 0, CloakFieldRadius = 0, JammerBlips = 0,
    -- Range-Structs (Ctor: mJamRadius.min/.max); RType-Feldnamen sind
    -- 'Min'/'Max' (Cfile:442519). unit.lua:1876 iteriert sie direkt —
    -- fehlen sie, laeuft das generische for auf nil.
    JamRadius = { Min = 0, Max = 0 },
    SpoofRadius = { Min = 0, Max = 0 },
  },
  Transport = {
    TransportClass = 1, ClassGenericUpTo = 0, Class2AttachSize = 2,
    Class3AttachSize = 6, Class4AttachSize = 1, ClassSAttachSize = 0,
    AirClass = false, StorageSlots = 0, DockingSlots = 0, RepairsRate = 0.0,
  },
  Defense = {
    MaxHealth = 1.0, Health = 1.0, RegenRate = 0.0, AirThreatLevel = 0.0,
    SurfaceThreatLevel = 0.0, SubThreatLevel = 0.0, EconomyThreatLevel = 0.0,
    ArmorType = 'Default',
    Shield = { ShieldSize = 0.0, RegenAssistMult = 1.0 },
  },
  Economy = {
    BuildCostEnergy = 0.0, BuildCostMass = 0.0, BuildRate = 1.0, BuildTime = 0.0,
    StorageEnergy = 0.0, StorageMass = 0.0, NaturalProducer = false,
    NeedToFaceTargetToBuild = false, InitialRallyX = 0.0, InitialRallyZ = 5.0,
    SacrificeMassMult = 0.0, SacrificeEnergyMult = 0.0, MaxBuildDistance = 5.0,
  },
  AI = {
    GuardScanRadius = 25.0, GuardReturnRadius = 50.0,
    StagingPlatformScanRadius = 300.0, ShowAssistRangeOnSelect = false,
    NeedUnpack = false, InitialAutoMode = false, RefuelingMultiplier = 1.0,
    RefuelingRepairAmount = 20.0, RepairConsumeEnergy = 2.0,
    RepairConsumeMass = 0.5, AutoSurfaceToAttack = true, AttackAngle = 0.0,
  },
  Physics = {
    MaxGroundVariation = 1.0, DiveSurfaceSpeed = 1.0, RollStability = 0.2,
    FlattenSkirt = false, SkirtOffsetX = 0.0, SkirtOffsetZ = 0.0,
    SkirtSizeX = 0.0, SkirtSizeZ = 0.0, StandUpright = false, SinkLower = false,
    RotateBodyWhileMoving = false, MaxSpeed = 0.0, MaxSpeedReverse = -1.0,
    MaxAcceleration = 0.0, MaxBrake = 0.0, MaxSteerForce = 0.0,
    BankingSlope = 0.0, RollDamping = 0.5, WobbleFactor = 0.0, WobbleSpeed = 0.0,
    TurnRadius = 5.0, TurnRate = 0.0, TurnFacingRate = 0.0, RotateOnSpot = false,
    RotateOnSpotThreshold = 0.5, Elevation = 0.0, AttackElevation = 0.0,
    CatchUpAcc = 0.0, BackUpDistance = -1.0, LayerChangeOffsetHeight = -0.1,
    LayerTransitionDuration = 0.0, FuelUseTime = 0.0, FuelRechargeRate = 0.0,
    GroundCollisionOffset = 0.0,
    -- RUnitBlueprintPhysics ctor (Cfile:656146-656172): a .bp omitting these
    -- still exposes them. BuildOnLayerCaps is the LAYER_Land bit — as a table
    -- for our table-based readers (OGrid packBuildOnLayerCaps).
    MotionType = 'RULEUMT_None', AltMotionType = 'RULEUMT_None',
    BuildOnLayerCaps = { LAYER_Land = true }, BuildRestriction = 'RULEUBR_None',
  },
  -- Footprint-Felder sind uchar (AddField_uchar "SizeX", Cfile:642465) -> 0.
  Footprint = { SizeX = 0, SizeZ = 0 },
}

-- Defaults einmischen: vorhandene Werte des .bp gewinnen immer.
local function fillDefaults(target, defaults)
  for k, v in pairs(defaults) do
    if type(v) == 'table' then
      if type(target[k]) ~= 'table' then target[k] = {} end
      fillDefaults(target[k], v)
    elseif target[k] == nil then
      target[k] = v
    end
  end
end

-- PROJEKTIL-Blueprints haben ihren eigenen Struct-Ctor
-- (RProjectileBlueprintPhysics, Cfile:653667-653712). Auch hier gilt: die Engine
-- belegt JEDES Feld vor, und die Original-Lua greift ungeprueft darauf zu.
--
-- Zwei Werte, die man nicht raten darf:
--   UseGravity = true   — ohne ihn fliegt jede Kugel schnurgerade weiter
--   Lifetime   = 15     — ohne ihn lebt sie ewig (oder gar nicht)
--
-- Und eine Eigenheit: das Projektil-Blueprint hat GAR KEINE Defense-Sektion
-- (RProjectileBlueprintTypeInfo::AddFields, Cfile:654222-654240 kennt nur
-- DevStatus/Display/Economy/Physics). Projectile.lua:75 liest trotzdem
-- `bp.Defense.MaxHealth or 1` — das laeuft nur dank der LuaPlus-nil-Metatable
-- (boot.lua). Deshalb wird hier KEINE Defense-Sektion erfunden.
-- Die FELDNAMEN sind die des PARSERS (AddFields, Cfile:653990-654175), nicht die
-- internen Member-Namen. Zwei davon hatte ich falsch — mit dem Member-Namen statt
-- dem .bp-Namen:
--   CollideEntity (NICHT CollisionEntity): die Kollision mit Einheiten. Ein .bp
--     mit `CollideEntity = false` (Nukes, Strat-Raketen) flog bei uns trotzdem in
--     die erste ueberflogene Einheit — der echte Wert wurde nie gelesen.
--   BounceVelDamp (NICHT BounceVelocityDamping).
-- Werte aus dem Struct-Ctor (Cfile:653667-653712), Feldliste aus AddFields.
__projDefaults = {
  Physics = {
    Lifetime = 15.0, LifetimeRange = 0.0,
    InitialSpeed = 1.0, InitialSpeedRange = 0.0,
    MaxSpeed = 0.0, MaxSpeedRange = 0.0,
    Acceleration = 0.0, AccelerationRange = 0.0,
    TurnRate = 0.0, TurnRateRange = 0.0,
    RotationalVelocity = 0.0, RotationalVelocityRange = 0.0,
    CollideSurface = true, CollideEntity = true,
    TrackTarget = false, LeadTarget = true,
    VelocityAlign = true, StayUpright = false, StayUnderwater = false,
    UseGravity = true,
    -- Start-Offset (PositionX/Y/Z ± Range) — die Engine versetzt das Projektil
    -- damit von der Muendung (Ctor Cfile:653700-653707).
    PositionX = 0.0, PositionXRange = 0.0,
    PositionY = 0.0, PositionYRange = 0.0,
    PositionZ = 0.0, PositionZRange = 0.0,
    DirectionX = 0.0, DirectionY = 1.0, DirectionZ = 0.0,
    DirectionXRange = 1.5, DirectionYRange = 0.0, DirectionZRange = 1.5,
    DestroyOnWater = false,
    BounceVelDamp = 0.5, MinBounceCount = 0, MaxBounceCount = 0,
    -- Detonationshoehen und ZigZag (Lenkwaffen) — vom Ctor mit 0 belegt.
    DetonateAboveHeight = 0.0, DetonateBelowHeight = 0.0,
    MaxZigZag = 0.0, ZigZagFrequency = 0.0,
    RealisticOrdinance = false, StraightDownOrdinance = false,
  },
  Economy = { BuildTime = 10.0 },
  -- Der Display-Block, wie ihn `RProjectileBlueprint::RProjectileBlueprint`
  -- setzt (Cfile:653726-653736). Hier stand `UniformScale = 1.0` — eine
  -- ERFUNDENE Zahl: der Projektil-Ctor setzt 0.0. Die 1.0 gehoert zum
  -- UNIT-Blueprint (Cfile:655665), und die beiden Strukturen wurden hier
  -- verwechselt.
  --
  -- Der Wert ist additiv: `sub_51C7F0` liefert
  -- `zufall(-MeshScaleRange, +MeshScaleRange) + mUniformScale`
  -- (Cfile:654396-654401). Gemessen betrifft die Aenderung genau ZWEI
  -- Blueprints: von 287 Projektil-Blueprints lassen 153 `UniformScale` weg, und
  -- 151 davon haben ueberhaupt kein Mesh (reine Partikeleffekte).
  Display = {
    MeshBlueprint = '',
    UniformScale = 0.0,
    MeshScaleRange = 0.0,
    MeshScaleVelocity = 0.0,
    MeshScaleVelocityRange = 0.0,
    CameraFollowsProjectile = false,
    CameraFollowTimeout = 1.0,
    StrategicIconSize = 1.0,
  },
}

-- WAFFEN-Defaults. Jede Waffe eines Units ist ein eigenes Struct
-- (RUnitBlueprintWeapon, 0x184 Bytes, RUnitBlueprintWeaponTypeInfo::Init
-- Cfile:658191). Seine Felder registriert AddFields (Cfile:658290-658520) mit
-- TYP und Offset — 23 float, 26 bool, 7 string. Das Struct wird wertinitialisiert:
-- float -> 0.0, bool -> false, string -> "".
--
-- Das ist kein Feinschliff: die ACU-Waffe „RightZephyr" (uel0001_unit.bp:880ff)
-- setzt KEIN DamageRadius — sie ist Einzelziel. `weapon.lua:287` rechnet aber
-- ungeprueft `weaponBlueprint.DamageRadius + (self.DamageRadiusMod or 0)`, und
-- ohne Default steht dort nil. Ergebnis: die ACU schiesst nicht (der Thread
-- stirbt in schook/lua/sim/weapon.lua:17). Genau so gefunden — im Durchlauf.
--
-- Die Feldliste ist die der Engine, nicht eine geratene Auswahl.
-- The NON-NULL defaults come from the weapon struct ctor sub_51F4C0 @0x51F4C0
-- (Cfile:656326-656412 — the offsets match the weapon AddFields Cfile:658290-
-- 658477), NOT from faf-re. Verified values: FiringTolerance 0.01, MaxHeightDiff
-- inf, RateOfFire 1.0, TrackingRadius 1.0, HeadingArcRange 180, IgnoresAlly 1,
-- LeadTarget 1, TargetCheckInterval 3.0, DamageType "Normal" (a1+168,
-- Cfile:656372), SlavedToBodyArcRange 1.0 (a1+72), EffectiveRadius -1.0 (a1+100),
-- AlwaysRecheckTarget 1 (a1+84), AttackGroundTries 3 (a1+308), BombDropThreshold
-- 1.5 (a1+324). Not cosmetic: IgnoresAlly=1 lets projectiles fly through allies,
-- TargetCheckInterval=0 would mean "search every tick", and DamageType='' vs
-- 'Normal' changes armor lookups for a .bp that omits it.
__weaponDefaults = {
  -- float
  BombDropThreshold = 1.5, Damage = 0.0, DamageRadius = 0.0, EffectiveRadius = -1.0,
  FiringRandomness = 0.0, FiringTolerance = 0.01, HeadingArcCenter = 0.0,
  HeadingArcRange = 180.0, MaxHeightDiff = math.huge, MaxRadius = 0.0,
  MaximumBeamLength = 0.0, MinRadius = 0.0, MuzzleVelocity = 0.0,
  MuzzleVelocityRandom = 0.0, MuzzleVelocityReduceDistance = 0.0,
  ProjectileLifetime = 0.0, ProjectileLifetimeUsesMultiplier = 0.0,
  RateOfFire = 1.0, RequiresEnergy = 0.0, RequiresMass = 0.0,
  SlavedToBodyArcRange = 1.0, TargetCheckInterval = 3.0, TrackingRadius = 1.0,
  -- int
  AttackGroundTries = 3, MaxProjectileStorage = 0,
  -- bool
  AboveWaterFireOnly = false, AboveWaterTargetsOnly = false,
  AimsStraightOnDisable = false, AlwaysRecheckTarget = true,
  AutoInitiateAttackCommand = false, BelowWaterFireOnly = false,
  BelowWaterTargetsOnly = false, CannotAttackGround = false,
  CountedProjectile = false, DummyWeapon = false, IgnoreIfDisabled = false,
  IgnoresAlly = true, LeadTarget = true, ManualFire = false, NeedPrep = false,
  NeedToComputeBombDrop = false, NukeWeapon = false, OverChargeWeapon = false,
  PrefersPrimaryWeaponTarget = false, ReTargetOnMiss = false, SlavedToBody = false,
  StopOnPrimaryWeaponBusy = false, Turreted = false,
  UseFiringSolutionInsteadOfAimBone = false, YawOnlyOnTarget = false,
  -- string
  DamageType = 'Normal', DisplayName = '', Label = '',
  TargetRestrictDisallow = '', TargetRestrictOnlyAllow = '',
  UIMaxRangeVisualId = '', UIMinRangeVisualId = '',
  ProjectileId = '',
}

--- The FOOTPRINT the engine derives when the blueprint leaves it at 0
--- (RUnitBlueprint post-load, Cfile:647164-647177): `frndint(SizeX)` plus one
--- if SizeX is larger than that — i.e. ceil() into the integer footprint
--- field. The same runs for the AltFootprint (Cfile:647178-647192).
---
--- Without it `bp.Footprint.SizeX` stays 0, and the ORIGINAL Lua computes with
--- it: unit.lua:243 `fx = x - bp.Footprint.SizeX * 0.5` is the skirt rect used
--- by FlattenSkirt (defaultunits.lua:70) and by the engine's adjacency test.
--- A 0 there moves every skirt half a footprint off.
local function fillFootprint(fp, sizeX, sizeZ)
  if not fp then return end
  if not fp.SizeX or fp.SizeX == 0 then fp.SizeX = math.ceil(sizeX or 0) end
  if not fp.SizeZ or fp.SizeZ == 0 then fp.SizeZ = math.ceil(sizeZ or 0) end
end

function RegisterUnitBlueprint(bp)
  fillDefaults(bp, __bpDefaults)
  fillFootprint(bp.Footprint, bp.SizeX, bp.SizeZ)
  -- `RUnitBlueprintPhysics::ComputeDerivedQuantities` (Cfile:656297-656314),
  -- gerufen aus `OnInitBlueprint` VOR dem Luft-Block (Cfile:655931). Zwei
  -- Ableitungen fehlten hier ganz:
  --
  --   * der Skirt-VERSATZ wird auf <= 0 geklemmt (Cfile:656297-656305)
  --   * die Skirt-GROESSE wird auf den Fussabdruck angehoben:
  --     `SkirtSizeX = max(SkirtSizeX, footprint.SizeX)` (Cfile:656306-656314)
  --
  -- Deshalb steht `fillFootprint` jetzt VOR diesem Block: die Klemme liest
  -- den bereits aufgerundeten Fussabdruck, nicht den rohen.
  local ph = bp.Physics
  if (ph.SkirtOffsetX or 0) >= 0 then ph.SkirtOffsetX = 0.0 end
  if (ph.SkirtOffsetZ or 0) >= 0 then ph.SkirtOffsetZ = 0.0 end
  local fpx = (bp.Footprint and bp.Footprint.SizeX) or 0
  local fpz = (bp.Footprint and bp.Footprint.SizeZ) or 0
  if fpx > (ph.SkirtSizeX or 0) then ph.SkirtSizeX = fpx end
  if fpz > (ph.SkirtSizeZ or 0) then ph.SkirtSizeZ = fpz end
  -- RUnitBlueprint::OnInitBlueprint-derived air values
  -- (Cfile:655931-655939).
  local air = bp.Air
  local physics = bp.Physics
  if not air.CanFly and physics.MotionType == 'RULEUMT_Air' then air.CanFly = true end
  if air.MaxAirspeed == 0 and air.CanFly then air.MaxAirspeed = physics.MaxSpeed end
  if air.MinAirspeed == 0 then air.MinAirspeed = air.MaxAirspeed end
  if air.StartTurnDistance == 0 then air.StartTurnDistance = (bp.SizeZ or 0) * 3 end
  -- The inertia tensor of a box when the .bp leaves it at 0
  -- (RUnitBlueprint, Cfile:647192-647199): (b^2 + c^2) / 12 per axis.
  if (bp.InertiaTensorX or 0) * (bp.InertiaTensorY or 0) * (bp.InertiaTensorZ or 0) == 0 then
    local sx, sy, sz = bp.SizeX or 1, bp.SizeY or 1, bp.SizeZ or 1
    bp.InertiaTensorX = (sz * sz + sy * sy) / 12
    bp.InertiaTensorY = (sz * sz + sx * sx) / 12
    bp.InertiaTensorZ = (sy * sy + sx * sx) / 12
  end
  -- Jeder Waffen-Eintrag ist ein eigenes Struct — also auch eigene Defaults.
  for _, w in ipairs(bp.Weapon or {}) do
    fillDefaults(w, __weaponDefaults)
  end
  fillFootprint(bp.AltFootprint, bp.SizeX, bp.SizeZ)
  __registered.Unit[bp.BlueprintId or '?'] = bp
end

function RegisterProjectileBlueprint(bp)
  fillDefaults(bp, __projDefaults)
  __registered.Projectile[bp.BlueprintId or '?'] = bp
end

RegisterMeshBlueprint=collector('Mesh')

-- PROP blueprints have their own struct ctor (Moho::RPropBlueprint @0x51D250,
-- Cfile:654903-654920): UniformScale 1.0, Defense.MaxHealth/Health 1.0 and the
-- Economy pair ReclaimMassMax/ReclaimEnergyMax 0.0. Both Economy fields are
-- FLOATS in the struct (AddField_float, Cfile:655099-655102) — a .bp that puts
-- a string there (defaultwreckage_prop.bp:6 writes ReclaimEnergyMax = '')
-- can never land in the float member, so the reflected value the Lua sees is
-- always numeric. Without the coercion, Prop.lua:155 divides that string and
-- every reclaim on such a prop dies in GetReclaimCosts.
__propDefaults = {
  Display = { UniformScale = 1.0 },
  Defense = { MaxHealth = 1.0, Health = 1.0 },
  Economy = { ReclaimMassMax = 0.0, ReclaimEnergyMax = 0.0 },
}

function RegisterPropBlueprint(bp)
  fillDefaults(bp, __propDefaults)
  local eco = bp.Economy
  eco.ReclaimMassMax = tonumber(eco.ReclaimMassMax) or 0.0
  eco.ReclaimEnergyMax = tonumber(eco.ReclaimEnergyMax) or 0.0
  __registered.Prop[bp.BlueprintId or '?'] = bp
end

RegisterEmitterBlueprint=collector('Emitter'); RegisterTrailEmitterBlueprint=collector('TrailEmitter')
RegisterBeamBlueprint=collector('Beam')

-- Ein EMITTER-Blueprint als JSON — der Renderer (Partikelsystem im
-- Main-Thread) holt die geparsten Daten aus der Sim, statt die 2724
-- _emit.bp-Dateien selbst noch einmal zu laden. Emitter-BPs sind reine
-- Daten: Zahlen, Strings, Booleans und Tabellen (die 21 Kurven mit
-- XRange + Keys). Arrays (fortlaufende 1..n) werden als JSON-Array
-- serialisiert, alles andere als Objekt.
local function jsonVal(v)
  local t = type(v)
  if t == 'number' then
    return string.format('%.9g', v)
  elseif t == 'string' then
    return string.format('%q', v)
  elseif t == 'boolean' then
    return tostring(v)
  elseif t == 'table' then
    local n = 0
    for _ in pairs(v) do n = n + 1 end
    if n == #v and n > 0 then
      local parts = {}
      for i = 1, n do parts[i] = jsonVal(v[i]) end
      return '[' .. table.concat(parts, ',') .. ']'
    end
    local parts, i = {}, 0
    for k, val in pairs(v) do
      i = i + 1
      parts[i] = string.format('%q:', tostring(k)) .. jsonVal(val)
    end
    return '{' .. table.concat(parts, ',') .. '}'
  end
  return 'null'
end

-- Auch fuer andere Engine-Lua-Dateien (props.lua serialisiert Mesh-BPs).
__jsonVal = jsonVal

--- Liefert das Emitter-/Trail-/Beam-Blueprint zur Id als JSON-String —
--- oder den String 'null', wenn es keines gibt (der Aufrufer prueft).
function __emitterBpJson(bpId)
  local bp = __registered.Emitter[bpId]
    or __registered.TrailEmitter[bpId]
    or __registered.Beam[bpId]
  if not bp then return 'null' end
  return jsonVal(bp)
end
function BlueprintLoaderUpdateProgress() end
__bpFiles = {}

--- `DiskFindFiles(dir, pattern)` — zwei Quellen, und die Trennung ist Absicht.
---
--- Hier stand eine Fassung, die NUR `__bpFiles` durchsuchte und das
--- `pattern`-Argument **vollständig ignorierte**. Das war eine stille falsche
--- Antwort: `localization.lua:29` fragt nach `'*strings_db.lua'` und bekam
--- Blueprint-Pfade oder nichts, weshalb `/lua/globalinit.lua:14-24` — und damit
--- die echte `/lua/simInit.lua` — nie durchlief. Die UI-VM hatte die richtige
--- Fassung die ganze Zeit (`src/vfs/glob.ts`).
---
--- `.bp` kommt weiterhin aus `__bpFiles`, und das ist eine bewusste Abweichung
--- von der Engine: die hätte hier den ganzen Spielordner, wir laden Blueprints
--- ABSICHTLICH selektiv (`unitFactory.ts` setzt `__bpFiles` vor jedem
--- `LoadBlueprints()`). Ohne diese Verengung zöge jeder Testlauf alle 2437
--- Blueprints durch die Original-Pipeline. Alles andere — `/loc`, `/maps`,
--- `/mods`, `/tutorials` — kommt aus dem echten Dateisatz des Hosts.
---
--- Das Muster kennt nur `*` als Platzhalter, wie im Original.
local function __matchesPattern(name, pattern)
  if not pattern or pattern == '' or pattern == '*' then return true end
  local rx = string.gsub(pattern, '[%^%$%(%)%%%.%[%]%+%-%?]', '%%%1')
  rx = string.gsub(rx, '%*', '.*')
  return string.find(string.lower(name), '^' .. rx .. '$') ~= nil
end

function DiskFindFiles(dir, pattern)
  pattern = pattern or '*'
  -- Blueprints: die vom Host ausgewaehlte Liste.
  if string.find(string.lower(pattern), '%.bp$') then
    local out = {}
    for _, f in ipairs(__bpFiles) do
      local name = string.match(f, '[^/]+$') or f
      if string.find(string.lower(f), string.lower(dir), 1, true) == 1
        and __matchesPattern(name, pattern) then
        out[#out + 1] = f
      end
    end
    return out
  end
  -- Alles andere: der echte Dateisatz — aber ALS ECHTE TABELLE.
  --
  -- `__simDiskFindFiles` ist eine JS-Funktion, und wasmoon legt ihr Array nicht
  -- als Lua-Tabelle ab, sondern als USERDATA-Proxy. Nachgemessen: `type(...)`
  -- ist `userdata`, `#` und `ipairs` gehen, aber `pairs` reisst die VM um
  -- (`Cannot read properties of null (reading 'then')`) — und `for k,v in t do`
  -- der Original-Lua wird vom Transpiler zu `__foriter(t)` (compat.lua:14-22),
  -- dessen Tabellen-Zweig auf `type(a) == 'table'` prueft. Userdata faellt
  -- durch, der generische `for` ruft den Proxy als Iterator auf, und heraus
  -- kommt `TypeError: self is not a function`.
  --
  -- Genau daran starb `/schook/lua/simInit.lua`. Betroffen ist jede
  -- Original-Stelle, die das Ergebnis durchlaeuft: `maputil.lua:106`,
  -- `helptext.lua:26`, `mods.lua:261`, `localization.lua:29`.
  --
  -- Dieselbe Familie wie die `null`-Falle in `LuaHost.setGlobal` — ein
  -- JS-Rueckgabewert, den Lua anders sieht als gedacht.
  local raw = __simDiskFindFiles(dir, pattern)
  local out = {}
  for i = 1, #raw do out[i] = raw[i] end
  return out
end
