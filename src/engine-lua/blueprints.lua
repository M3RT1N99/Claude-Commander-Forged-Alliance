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
  Display = { UniformScale = 1.0 },
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
-- Die NICHT-NULL-Defaults kommen aus dem Struct-Ctor. Der ist im Retail-Binary
-- nicht als eigene Funktion dekompilierbar; die beste Quelle ist faf-re
-- (RUnitBlueprint.cpp:1015-1086, dokumentiert in weapons.md:1001):
--   FiringTolerance 0.01, MaxHeightDiff inf, RateOfFire 1.0, TrackingRadius 1.0,
--   HeadingArcRange 180, IgnoresAlly 1, LeadTarget 1, TargetCheckInterval 3.0
-- Sie sind nicht kosmetisch: IgnoresAlly=1 laesst Projektile durch Verbuendete
-- fliegen (sonst stirbt der Schuss einer bauenden ACU in der eigenen
-- Baustelle), und TargetCheckInterval=0 hiesse „jeden Tick Ziele suchen".
__weaponDefaults = {
  -- float (Feldliste: Cfile:658290-658520; Nicht-Null-Werte: weapons.md:1001)
  BombDropThreshold = 0.0, Damage = 0.0, DamageRadius = 0.0, EffectiveRadius = 0.0,
  FiringRandomness = 0.0, FiringTolerance = 0.01, HeadingArcCenter = 0.0,
  HeadingArcRange = 180.0, MaxHeightDiff = math.huge, MaxRadius = 0.0,
  MaximumBeamLength = 0.0, MinRadius = 0.0, MuzzleVelocity = 0.0,
  MuzzleVelocityRandom = 0.0, MuzzleVelocityReduceDistance = 0.0,
  ProjectileLifetime = 0.0, ProjectileLifetimeUsesMultiplier = 0.0,
  RateOfFire = 1.0, RequiresEnergy = 0.0, RequiresMass = 0.0,
  SlavedToBodyArcRange = 0.0, TargetCheckInterval = 3.0, TrackingRadius = 1.0,
  -- int
  AttackGroundTries = 0, MaxProjectileStorage = 0,
  -- bool
  AboveWaterFireOnly = false, AboveWaterTargetsOnly = false,
  AimsStraightOnDisable = false, AlwaysRecheckTarget = false,
  AutoInitiateAttackCommand = false, BelowWaterFireOnly = false,
  BelowWaterTargetsOnly = false, CannotAttackGround = false,
  CountedProjectile = false, DummyWeapon = false, IgnoreIfDisabled = false,
  IgnoresAlly = true, LeadTarget = true, ManualFire = false, NeedPrep = false,
  NeedToComputeBombDrop = false, NukeWeapon = false, OverChargeWeapon = false,
  PrefersPrimaryWeaponTarget = false, ReTargetOnMiss = false, SlavedToBody = false,
  StopOnPrimaryWeaponBusy = false, Turreted = false,
  UseFiringSolutionInsteadOfAimBone = false, YawOnlyOnTarget = false,
  -- string
  DamageType = '', DisplayName = '', Label = '',
  TargetRestrictDisallow = '', TargetRestrictOnlyAllow = '',
  UIMaxRangeVisualId = '', UIMinRangeVisualId = '',
  ProjectileId = '',
}

function RegisterUnitBlueprint(bp)
  fillDefaults(bp, __bpDefaults)
  -- Jeder Waffen-Eintrag ist ein eigenes Struct — also auch eigene Defaults.
  for _, w in ipairs(bp.Weapon or {}) do
    fillDefaults(w, __weaponDefaults)
  end
  __registered.Unit[bp.BlueprintId or '?'] = bp
end

function RegisterProjectileBlueprint(bp)
  fillDefaults(bp, __projDefaults)
  __registered.Projectile[bp.BlueprintId or '?'] = bp
end

RegisterMeshBlueprint=collector('Mesh')
RegisterPropBlueprint=collector('Prop')
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
function DiskFindFiles(dir, pattern)
  local out = {}
  for _, f in ipairs(__bpFiles) do
    if string.find(f, dir, 1, true) == 1 then out[#out+1] = f end
  end
  return out
end
