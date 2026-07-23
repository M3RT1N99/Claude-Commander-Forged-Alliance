__active_mods = {}
__registered = { Unit={}, Mesh={}, Prop={}, Projectile={}, Emitter={}, TrailEmitter={}, Beam={} }
local function collector(g) return function(bp) __registered[g][bp.BlueprintId or '?'] = bp end end
-- Blueprint defaults: the engine does NOT read a .bp into a raw table,
-- but into a typed struct (Moho::RUnitBlueprint). Its Ctor
-- (@0x51E480, Cfile ~655645, plus the sub-ctors for Physics/Economy/AI)
-- initializes EVERY field with a default; the Lua sees this
-- reflected struct. That's why Unit.lua is allowed to run unchecked
-- bp.Defense.Shield.ShieldSize (unit.lua:1572) or bp.Footprint.SizeX
-- (unit.lua:243) even though the .bp file does not contain these sections
-- contains. Values ​​1:1 from the ctors - nothing estimated.
__bpDefaults = {
  -- The upgrade fields are NOT empty strings: the ctor sets them to the
  -- String "none" (Cfile:656076-656077, func_StringInitFilename("none", ...));
  -- only UpgradesTo starts empty (str_empty, Cfile:656075).
  --
  -- This is not a detail: construction.lua:863 asks
  --   elseif blueprint.General.UpgradesFromBase != "none" then
  --       ... elseif blueprint.General.UpgradesFromBase == unitBp.General.UpgradesFromBase then
  --           performUpgrade = true
  -- If the default is missing, BOTH sides are nil - nil == nil is true, and the UI
  -- EVERY building counts as an upgrade to the selected unit. The click on
  -- Bau-Icon then sent a UNITCOMMAND_Upgrade to the sim instead of the
  -- Start construction mode - nothing could be built anymore.
  General = {
    UpgradesFrom = 'none',
    UpgradesFromBase = 'none',
    UpgradesTo = '',
    -- The Ctor (Cfile:656079-656081): mQuickSelectPriority = 0, mCapCost = 1.0,
    -- mSelectionPriority = 1. QuickSelectPriority > 0 makes a unit the
    -- AVATAR (right bar; in vanilla only the four ACU-.bp set it to 1).
    QuickSelectPriority = 0,
    CapCost = 1.0,
    SelectionPriority = 1,
  },
  -- IdleEffects: Table field in the struct -> empty, never nil. unit.lua:2463
  -- indiziert es ungeprueft (bpTable[layer]).
  Display = {
    UniformScale = 1.0, SpawnRandomRotation = false, HideLifebars = false,
    IdleEffects = {}, MovementEffects = {},
    -- The Ctor creates mDisplay.mIconName as an EMPTY string (Cfile:655662-655664:
    -- _Mysize = 0, Buf[0] = 0). NOT a single .bp sets the field — still
    -- gamecommon.lua:17 concatenates it unchecked into a path. He will through this
    -- '/textures/ui/common/icons/units/_icon.dds', DiskGetFileInfo returns false,
    -- and the Lua falls back to default_icon.dds (gamecommon.lua:22-24).
    -- That's exactly what it means: the empty field IS the standard way.
    IconName = '',
  },
  Intel = {
    VisionRadius = 10, WaterVisionRadius = 10, RadarRadius = 0, SonarRadius = 0,
    OmniRadius = 0, RadarStealth = false, SonarStealth = false, Cloak = false,
    ShowIntelOnSelect = false, RadarStealthFieldRadius = 0,
    SonarStealthFieldRadius = 0, CloakFieldRadius = 0, JammerBlips = 0,
    -- Range Structs (Ctor: mJamRadius.min/.max); RType field names are
    -- 'Min'/'Max' (Cfile:442519). unit.lua:1876 iterates it directly —
    -- If they are missing, the generic for runs to nil.
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
  -- Footprint fields are uchar (AddField_uchar "SizeX", Cfile:642465) -> 0.
  Footprint = { SizeX = 0, SizeZ = 0 },
}

-- Mix in defaults: existing values ​​of the .bp always win.
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

-- PROJECTIL Blueprints have their own Struct Ctor
-- (RProjectileBlueprintPhysics, Cfile:653667-653712). The same applies here: the engine
-- EVERY field is pre-occupied, and the original Lua accesses it unchecked.
--
-- Two values ​​​​that should not be guessed:
--   UseGravity = true — without it, every ball flies straight
--   Lifetime = 15 — without him she lives forever (or not at all)
--
-- And a peculiarity: the projectile blueprint has NO defense section AT ALL
-- (RProjectileBlueprintTypeInfo::AddFields, Cfile:654222-654240 only knows
-- DevStatus/Display/Economy/Physics). Projectile.lua:75 liest trotzdem
-- `bp.Defense.MaxHealth or 1` — this only works thanks to the LuaPlus-nil metatable
-- (boot.lua). That's why NO defense section is being invented here.
-- The FIELD NAMES are those of the PARSER (AddFields, Cfile:653990-654175), not that
-- internal member name. I had two of them wrong - with the member name instead
-- the .bp name:
--   CollideEntity (NOT CollisionEntity): the collision with entities. A .bp
--     with `CollideEntity = false` (nukes, strat rockets) still flew in with us
--     the first unit flown over — the real value was never read.
--   BounceVelDamp (NOT BounceVelocityDamping).
-- Values ​​from the Struct Ctor (Cfile:653667-653712), field list from AddFields.
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
    -- Start Offset (PositionX/Y/Z ± Range) — the engine offsets the projectile
    -- thus from the mouth (Ctor Cfile:653700-653707).
    PositionX = 0.0, PositionXRange = 0.0,
    PositionY = 0.0, PositionYRange = 0.0,
    PositionZ = 0.0, PositionZRange = 0.0,
    DirectionX = 0.0, DirectionY = 1.0, DirectionZ = 0.0,
    DirectionXRange = 1.5, DirectionYRange = 0.0, DirectionZRange = 1.5,
    DestroyOnWater = false,
    BounceVelDamp = 0.5, MinBounceCount = 0, MaxBounceCount = 0,
    -- Detonation heights and ZigZag (guided weapons) - assigned 0 by the Ctor.
    DetonateAboveHeight = 0.0, DetonateBelowHeight = 0.0,
    MaxZigZag = 0.0, ZigZagFrequency = 0.0,
    RealisticOrdinance = false, StraightDownOrdinance = false,
  },
  Economy = { BuildTime = 10.0 },
  Display = { UniformScale = 1.0 },
}

-- WEAPON defaults. Each unit weapon is its own struct
-- (RUnitBlueprintWeapon, 0x184 Bytes, RUnitBlueprintWeaponTypeInfo::Init
-- Cfile:658191). Its fields are registered with AddFields (Cfile:658290-658520).
-- TYPE and offset — 23 float, 26 bool, 7 string. The struct is value initialized:
-- float -> 0.0, bool -> false, string -> "".
--
-- This is not a finishing touch: the ACU weapon “RightZephyr” (uel0001_unit.bp:880ff)
-- does NOT set DamageRadius - it is single target. But `weapon.lua:287` does the math
-- untested `weaponBlueprint.DamageRadius + (self.DamageRadiusMod or 0)`, and
-- without default it says nil. Result: the ACU does not fire (the thread
-- dies in schook/lua/sim/weapon.lua:17). Found exactly that way — in transit.
--
-- The field list is that of the engine, not a guessed selection.
-- The NOT-NULL defaults come from the Struct-Ctor. It's in the retail binary
-- cannot be decompiled as a separate function; the best source is faf-re
-- (RUnitBlueprint.cpp:1015-1086, dokumentiert in weapons.md:1001):
--   FiringTolerance 0.01, MaxHeightDiff inf, RateOfFire 1.0, TrackingRadius 1.0,
--   HeadingArcRange 180, IgnoresAlly 1, LeadTarget 1, TargetCheckInterval 3.0
-- They are not cosmetic: IgnoresAlly=1 lets projectiles pass through allies
-- fly (otherwise the shot of a building ACU dies in its own
-- construction site), and TargetCheckInterval=0 would mean “search for targets every tick”.
__weaponDefaults = {
  -- float (field list: Cfile:658290-658520; non-zero values: weapons.md:1001)
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
  -- Each weapon entry is its own struct - including its own defaults.
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

-- An EMITTER blueprint as JSON — the renderer (particle system in
-- Main thread) fetches the parsed data from the sim, instead of the 2724
-- _emit.bp files yourself to load again. Emitter BPs are pure
-- Data: numbers, strings, booleans and tables (which contain 21 curves
-- XRange + Keys). Arrays (consecutive 1..n) are saved as a JSON array
-- serialized, anything but object.
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

-- Also for other engine Lua files (props.lua serializes mesh BPs).
__jsonVal = jsonVal

--- Delivers the emitter/trail/beam blueprint to the ID as a JSON string —
--- or the string 'null' if there is none (the caller checks).
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
