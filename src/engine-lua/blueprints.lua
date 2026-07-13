__active_mods = {}
__registered = { Unit={}, Mesh={}, Prop={}, Projectile={}, Emitter={}, TrailEmitter={}, Beam={} }
-- Sound{}: der EINZIGE DSL-Konstruktor in den .bp-Dateien (3445 Vorkommen,
-- z. B. uel0001_unit.bp:14 CaptureLoop = Sound{Bank=…, Cue=…}). Fehlt er,
-- bricht die Blueprint-Auswertung mittendrin ab und das bp wird unter dem
-- Schlüssel 'null' halbfertig registriert.
function Sound(t) return t end
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
  General = {},
  -- IdleEffects: Tabellen-Feld im Struct -> leer, nie nil. unit.lua:2463
  -- indiziert es ungeprueft (bpTable[layer]).
  Display = {
    UniformScale = 1.0, SpawnRandomRotation = false, HideLifebars = false,
    IdleEffects = {}, MovementEffects = {},
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

function RegisterUnitBlueprint(bp)
  fillDefaults(bp, __bpDefaults)
  __registered.Unit[bp.BlueprintId or '?'] = bp
end
RegisterMeshBlueprint=collector('Mesh')
RegisterPropBlueprint=collector('Prop'); RegisterProjectileBlueprint=collector('Projectile')
RegisterEmitterBlueprint=collector('Emitter'); RegisterTrailEmitterBlueprint=collector('TrailEmitter')
RegisterBeamBlueprint=collector('Beam')
function BlueprintLoaderUpdateProgress() end
__bpFiles = {}
function DiskFindFiles(dir, pattern)
  local out = {}
  for _, f in ipairs(__bpFiles) do
    if string.find(f, dir, 1, true) == 1 then out[#out+1] = f end
  end
  return out
end
