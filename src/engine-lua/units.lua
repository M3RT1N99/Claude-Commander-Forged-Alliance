__units = {}
__nextUnitId = 1

-- KEIN Instanz-Fallback mehr. Fehlende Engine-Methoden sind nil und knallen
-- beim Aufruf — genau so soll es sein. Der frühere Feld-Stub lieferte für JEDEN
-- unbekannten Schlüssel eine (truthy!) Funktion; damit wurde in unit.lua:143
-- (self.FxDamage1Amount = self.FxDamage1Amount or damageamounts) die Stub-
-- FUNKTION statt der Zahl zugewiesen. Instanz-FELDER müssen nil bleiben.

-- Engine-Globals, die Unit-OnCreate braucht ------------------------------

-- TrashBag: Original aus trashbag.lua, sonst minimaler Ersatz.
do
  local ok, mod = pcall(import, '/lua/system/trashbag.lua')
  if ok and mod and mod.TrashBag then
    TrashBag = mod.TrashBag
  else
    TrashBag = Class() {
      Add = function(self, e) return e end,
      Destroy = function(self) end,
    }
  end
end

-- Sound{}: Blueprint-DSL-Konstruktor -> Argument zurueck
Sound = Sound or function(t) return t end

-- Scenario: KEIN Platzhalter mehr.
--
-- Hier stand `Scenario = Scenario or { MasterChain = { _MASTERCHAIN_ =
-- { Markers = {} } }, Armies = {}, Props = {} }` — „minimal leer, damit
-- GetMarkers() fehlerfrei laeuft". Genau das war der Fehler: `GetMarkers()`
-- (scenarioutilities.lua:53) lieferte still `{}`, und `InitializeArmies()`
-- uebersprang jede Armee an `scenarioutilities.lua:449` (`if tblData then`),
-- ohne dass irgendetwas fehlschlug. Eine erfundene Antwort auf eine echte
-- Frage — und ein fuenfter Auto-Vivifier, den CLAUDE.md nicht kennt.
--
-- `Scenario` wird ausschliesslich von `SetupSession` gesetzt, aus der echten
-- Karte (siminit.lua:95, `Scenario = ScenarioInfo.Env.Scenario`). Wer vorher
-- darauf zugreift, bekommt den strikten `_G`-Fehler — und das ist richtig so.

-- categories / EntityCategory*: echt in engineGlobals.ts (Ausdrucksbaum über
-- die Blueprint-Categories-Liste), NICHT hier.

-- No brain/economy/navigator fallbacks here. installEconomy and installMotion
-- run earlier in the engine boot (see engine.ts) and define the real ones;
-- re-defining them here would clobber them — which silently zeroed the whole
-- economy exactly once. The engine is booted as a whole or not at all.

-- Weapons: the engine instantiates them from the blueprint, using the Lua
-- class from the unit script's Weapons table (keyed by the weapon Label).
-- Base class is Weapon from /lua/sim/Weapon.lua (Class(moho.weapon_methods)).
-- Das Skelett je Blueprint liegt in bones.lua (__unitBones, __setBones ueber
-- __beginBones/__addBone/__finishBones) — mit Ruhepose, nicht nur Namen: ohne
-- Knochen-Transform gibt es keine Muendungsposition und damit kein Projektil.

function __createWeapons(u, bp)
  u.__weapons = {}
  local list = bp.Weapon
  if not list then return end
  local BaseWeapon = import('/lua/sim/Weapon.lua').Weapon
  for i = 1, table.getn(list) do
    local wbp = list[i]
    local cls = BaseWeapon
    if u.Weapons and wbp.Label and u.Weapons[wbp.Label] then
      cls = u.Weapons[wbp.Label]
    end
    local w = cls(u)
    w.__bp = wbp
    w.__unit = u
    w.__index = i
    w.__army = u.__army
    w.__enabled = true
    -- The acquire task's `mWaitTicks`: a CTaskThread starts at 0
    -- (Cfile:438797), so the first target check is the weapon's FIRST tick,
    -- not the next multiple of TargetCheckInterval (weapons.lua __weaponTick).
    w.__acquireWait = 0
    -- The fire-control label starts as "Default" (Cfile:984161); only the aim
    -- manipulator carrying the same label may write the fire gate.
    w.__fireControl = 'Default'
    -- UnitWeapon starts with no valid target layers. Weapon.OnCreate selects
    -- the blueprint mask for the unit's current layer.
    w.__fireTargetLayerCaps = 'None'
    u.__weapons[i] = w

    -- Und dann ruft die Engine OnCreate — genau wie auf der Unit selbst.
    --
    -- Das ist kein Detail: DefaultProjectileWeapon.OnCreate endet mit
    -- ChangeState(self, self.IdleState) (defaultweapons.lua:87), und erst der
    -- IdleState startet die Zustandsmaschine der Waffe. Ohne OnCreate lief sie
    -- gar nicht — bis irgendein spaeterer Zustandswechsel sie doch anwarf.
    --
    -- Folge: der Overcharge der ACU (IdleState.Main -> StartEconomyDrain,
    -- defaultweapons.lua:404) lud seine 5000 Energie nicht beim Start auf
    -- (wo der Startvorrat sie deckt), sondern IRGENDWANN spaeter — bei leerer
    -- Kasse. Dann fordert er 500 Energie/Tick, bekommt bei 2/Tick Einkommen
    -- eine Rate von 0.004, wird nie fertig und verhungert nebenbei jede Fabrik.
    -- Die Reihenfolge der Engine ist die Loesung, nicht ein Sonderfall.
    if w.OnCreate then w:OnCreate() end
  end
end

-- Unit spawnen: Original-Script-Klasse instanziieren + OnCreate ----------
local LAYER_INFO = {
  land = { name = 'Land', bit = 0x01, bp = 'LAYER_Land' },
  seabed = { name = 'Seabed', bit = 0x02, bp = 'LAYER_Seabed' },
  sub = { name = 'Sub', bit = 0x04, bp = 'LAYER_Sub' },
  water = { name = 'Water', bit = 0x08, bp = 'LAYER_Water' },
  air = { name = 'Air', bit = 0x10, bp = 'LAYER_Air' },
  orbit = { name = 'Orbit', bit = 0x20, bp = 'LAYER_Orbit' },
}

-- COORDS_StringToLayer accepts exactly these six unprefixed names,
-- case-insensitively; every other string maps to LAYER_None
-- (Cfile:641397-641409). In particular, "LAYER_Air" is not an alias.
local function coordsStringToLayer(value)
  if type(value) ~= 'string' then return nil end
  return LAYER_INFO[string.lower(value)]
end

-- RUnitBlueprintPhysics::ComputeDerivedQuantities writes these exact caps into
-- the unit footprint (Cfile:656226-656293; FootprintOccupancyCaps). This is not
-- a starting-layer heuristic: GetStartingLayer consumes the derived footprint
-- caps, and the browser blueprint does not expose the native SFootprint.
local MOTION_FOOTPRINT_CAPS = {
  RULEUMT_None = 0x00,
  RULEUMT_Land = 0x01,
  RULEUMT_Air = 0x10,
  RULEUMT_Water = 0x08,
  RULEUMT_Biped = 0x01,
  RULEUMT_SurfacingSub = 0x0C,
  RULEUMT_Amphibious = 0x03,
  RULEUMT_Hover = 0x09,
  RULEUMT_AmphibiousFloating = 0x09,
  RULEUMT_Special = 0x00,
}

local function footprintLayerCaps(bp)
  local physics = bp.Physics or {}
  local motion = physics.MotionType or 'RULEUMT_None'
  -- The native derived-quantity pass forces zero-speed blueprints to None
  -- before choosing the footprint (Cfile:656226-656238).
  if (physics.MaxSpeed or 0) == 0 then motion = 'RULEUMT_None' end

  local caps = MOTION_FOOTPRINT_CAPS[motion] or 0
  if motion == 'RULEUMT_None' then
    -- Buildings get the low byte of Physics.BuildOnLayerCaps instead
    -- (Cfile:656283-656293).
    local buildCaps = physics.BuildOnLayerCaps or {}
    caps = 0
    for _, info in pairs(LAYER_INFO) do
      if buildCaps[info.bp] == true then caps = caps | info.bit end
    end
  end
  return caps
end

local function fittingCapsAtPoint(caps, x, z)
  local submerged = (__mapWaterLevel or -10000) > GetTerrainHeight(x, z)
  if submerged then
    -- The native OCCUPY_FootprintFits also checks every footprint sample,
    -- slope, blocking terrain and occupied structure grids. Those grids and
    -- resolved footprint depth limits do not exist in this simulator yet.
    -- At a submerged centre point, conservatively do not claim LAND fits.
    caps = caps & ~0x01
  else
    -- Conversely, water-only layers cannot fit when the centre terrain is at
    -- or above the water plane. AIR/ORBIT remain independent of that plane.
    caps = caps & ~0x0E
  end
  return caps, submerged
end

local function startingLayer(u, bp, x, z, requested)
  local requestedInfo = coordsStringToLayer(requested)
  local footprintCaps = footprintLayerCaps(bp)
  local fittingCaps, submerged = fittingCapsAtPoint(footprintCaps, x, z)

  -- Entity::GetStartingLayer first preserves a requested layer only if the
  -- footprint actually fits it (Cfile:857497-857499).
  if requestedInfo and (fittingCaps & requestedInfo.bit) ~= 0 then
    return requestedInfo.name
  end

  local experimental = EntityCategoryContains(categories.EXPERIMENTAL, u)
  if (fittingCaps & 0x10) ~= 0 then
    return experimental and 'Land' or 'Air'
  end
  if not submerged then return 'Land' end
  if (footprintCaps & 0x04) ~= 0 and not experimental then return 'Sub' end
  if (footprintCaps & 0x08) ~= 0 or EntityCategoryContains(categories.FERRYBEACON, u) then
    return 'Water'
  end
  return 'Seabed'
end

--- `Moho::IUnit::CalcSpawnElevation(map, attributes, layer, pos)`
--- (Cfile:683091-683120) — die Hoehe, mit der eine Einheit entsteht.
---
--- Fuenf Faelle, in dieser Reihenfolge (die Bits sind die aus `LAYER_INFO`):
---   Land|Seabed (0x03) -> `CHeightField::GetElevation(x, z)`, also das reine
---                         Gelaende (bei uns `GetTerrainHeight`, NICHT
---                         `GetSurfaceHeight`: der Seabed liegt unter Wasser)
---   Water (0x08)       -> der Wasserspiegel, ohne Wasser -10000
---   Sub (0x04)         -> `Physics.Elevation` + Wasserspiegel (bzw. -10000)
---   Air (0x10)         -> `STIMap::GetSurface(x, z)` + `Physics.Elevation`
---   sonst              -> 0
---
--- `a2->mElevation` ist `UnitAttributes.mElevation`, das die Engine aus
--- `Physics.Elevation` des Blueprints fuellt.
local function calcSpawnElevation(bp, layerName, x, z)
  local info = LAYER_INFO[string.lower(layerName or '')]
  local bit = info and info.bit or 0
  local elevation = (bp.Physics and bp.Physics.Elevation) or 0
  if (bit & 0x03) ~= 0 then return GetTerrainHeight(x, z) end
  if (bit & 0x08) ~= 0 then return __mapWaterLevel or -10000 end
  if (bit & 0x04) ~= 0 then return elevation + (__mapWaterLevel or -10000) end
  if (bit & 0x10) ~= 0 then return GetSurfaceHeight(x, z) + elevation end
  return 0
end

function __spawnUnit(scriptPath, bpId, x, y, z, army, complete, requestedLayer, heading)
  local bp = __registered.Unit[bpId]
  if not bp then return -1, 'blueprint not registered: ' .. tostring(bpId) end
  local mod = import(scriptPath)
  local cls = mod.TypeClass
  if not cls then return -1, 'script has no TypeClass: ' .. scriptPath end

  local u = cls()
  local id = __nextUnitId
  __nextUnitId = id + 1
  -- IsUnit(e) unterscheidet die Arten (Projektile haben auch ein Blueprint).
  u.__isUnit = true
  u.__bp = bp
  u.__id = id
  u.__army = army
  u.__brain = __getBrain(army)
  -- mVarDat.mLayer is initialized before Weapon.OnCreate. Original Lua also
  -- reads the legacy `Layer` field, so both names must refer to the same
  -- starting layer. Previously only `Layer` was set while GetCurrentLayer and
  -- projectile impact classification read `__layer`, making every Air unit
  -- report Land.
  u.__layer = startingLayer(u, bp, x, z, requestedLayer)
  u.Layer = u.__layer
  -- Die HOEHE gehoert der Engine, nicht dem Aufrufer.
  --
  -- `SUnitConstructionParams::SUnitConstructionParams` setzt
  -- `mFixElevation = 1` und direkt danach `if (!layer) mFixElevation = 0`
  -- (Cfile:733280-733285) — `layer` ist das OPTIONALE zehnte Argument von
  -- `CreateUnit` (cfunc_CreateUnitL: `layer = 0`, und nur wenn Argument 10 ein
  -- String ist, `COORDS_StringToLayer`, Cfile:980412-980423). Und
  -- `Moho::Unit::Unit` ersetzt dann `pos.y` durch `CalcSpawnElevation` mit der
  -- eben bestimmten STARTEBENE (Cfile:950181-950196).
  --
  -- Ohne Ebenen-Argument ist das uebergebene y also gar kein Wunsch, sondern
  -- wird verworfen — genau darauf verlaesst sich `CreateInitialArmyUnit`, das
  -- immer y = 0 schickt (Cfile:1025265). Vorher stand die ACU deshalb auf 0
  -- statt auf dem Berg.
  if not coordsStringToLayer(requestedLayer) then
    y = calcSpawnElevation(bp, u.__layer, x, z)
  end
  u.__pos = { x, y, z }
  -- Das Skelett aus dem Modell (siehe __setBones). Es muss VOR OnCreate stehen:
  -- die Waffen pruefen ihre Turm-Knochen beim Aufbau (weapon.lua:67).
  u.__bones = __unitBones[string.lower(bpId)] or { names = {}, xform = {}, index = {} }
  -- The creation transform's yaw: the initial rally point below turns by it.
  u.__heading = heading or 0
  -- CUnitMotion::CUnitMotion: Stopped / Bottom (Cfile:964772-964773).
  u.__horzEvent = 'Stopped'
  u.__vertEvent = 'Bottom'
  u.__navigator = __getNavigator(id)
  -- echte Felder (nicht der wrapInstance-Stub) für die Physik-Fortschreibung
  u.__goal = false
  u.__speed = 0
  u.__health = (bp.Defense and bp.Defense.MaxHealth) or 0
  u.__fraction = 1
  u.__autoMode = false
  u.__autoSurfaceMode = false
  -- Erstellungs-Tick: die Build-/Wreckage-Shader zaehlen ihr Alter darueber
  -- (mesh.fx: material.x = time - creationTime).
  u.__spawnTick = __gameTick or 0
  -- `UnitAttributes.mRegenRate` kommt aus `Defense.RegenRate` des Blueprints
  -- (Cfile:949124) und wird zur Laufzeit von `SetRegenRate`/`RevertRegenRate`
  -- veraendert. `Unit::OnTick` regeneriert damit jeden Tick um `rate * 0.1`
  -- (Cfile:952810-952817).
  u.__regenRate = ((bp.Defense or {}).RegenRate) or 0
  -- Die frische Einheit landet im Pool ihrer Armee — und zwar BEVOR ihr
  -- `OnCreate` laeuft: `Sim::CreateUnit` macht erst
  -- `mArmy->Func9(…, "ArmyPool")` (Cfile:950549) und dann
  -- `RunScript("OnCreate")` (Cfile:950554).
  __addUnitToArmyPool(u)
  -- Engine-bereitgestellte Instanz-Felder (vor OnCreate vorhanden)
  u.Trash = TrashBag()
  __units[id] = u

  -- Install the command-cap bindings up front (seeded from the blueprint mask)
  -- so a script's OnCreate/OnStopBeingBuilt can already call AddCommandCap/
  -- RemoveCommandCap. Without this they hit the withNoops stub until the first
  -- readRow beat and the cap change is silently lost
  -- (globals.lua __ensureCommandCapMask; UnitAttributes init Cfile:949126).
  __ensureCommandCapMask(u)

  -- The native constructor calls SetAutoMode(InitialAutoMode) immediately
  -- before OnPreCreate (Cfile:950066). SetAutoMode dispatches OnAutoModeOn/Off
  -- even when the value equals the default.
  local okAuto, errAuto = pcall(function()
    u:SetAutoMode((bp.AI or {}).InitialAutoMode == true)
  end)
  if not okAuto then return id, tostring(errAuto) end

  -- Blueprint-Ökonomie in die Engine-Ökonomie der Armee einklinken (Original:
  -- CEconomy im CArmyImpl; die Unit registriert Produktion/Unterhalt).
  local e = bp.Economy or {}
  __econRegister(army, id,
    e.ProductionPerSecondMass or 0, e.ProductionPerSecondEnergy or 0,
    e.MaintenanceConsumptionPerSecondMass or 0, e.MaintenanceConsumptionPerSecondEnergy or 0,
    e.StorageMass or 0, e.StorageEnergy or 0,
    -- NaturalProducer exempts the unit from the production throttle
    -- (mex stall, Cfile:953936-953944) — only ACUs/sACUs carry it.
    e.NaturalProducer == true)

  -- OnPreCreate VOR OnCreate — so ruft es die Engine (Cfile: OnPreCreate
  -- @943748, danach OnCreate @944007). Dort entstehen self.Sync (SyncMeta),
  -- self.Trash und self.EventCallbacks; ohne diesen Schritt laufen spaeter
  -- z. B. DoUnitCallbacks (unit.lua:2815) ins Leere.
  local okPre, errPre = pcall(function() u:OnPreCreate() end)
  if not okPre then return id, tostring(errPre) end

  -- The engine creates one weapon object per bp.Weapon entry and binds it to
  -- the Lua class the unit script declared under that weapon's Label
  -- (uel0001_script.lua:25 declares Weapons with RightZephyr = Class(...)).
  -- GetWeapon(i) hands that object back; wep:GetBlueprint() is bp.Weapon[i].
  local okW, errW = pcall(function() __createWeapons(u, bp) end)
  if not okW then return id, tostring(errW) end

  -- A FACTORY builder gets its initial rally point before OnCreate: the unit
  -- constructor calls mBuilder->IssueRallyPoint when GetBool1 holds, right
  -- after the army pool and before InitializeArmor / RunScript("OnCreate")
  -- (Cfile:950550-950554).
  if __isFactoryBuilder(u) then __issueInitialRally(u) end

  -- OnCreate läuft als Thread (Original: Unit-Logik ist kooperativ). Der erste
  -- Slice läuft sofort (Sofort-Zustand); WaitTicks/ForkThread darin laufen auf
  -- den folgenden Beats weiter. Fallback ohne Scheduler: direkter pcall.
  local ok, err
  if __startThread then
    ok, err = __startThread(function() u:OnCreate() end)
  else
    ok, err = pcall(function() u:OnCreate() end)
  end
  if not ok then return id, tostring(err) end

  -- Fertig platzierte Units (Karten-Startunits) bekommen von der Engine direkt
  -- OnStopBeingBuilt — daher forkt jede ACU dort GiveInitialResources und die
  -- Armee erhaelt ihren Startvorrat. Baustellen bekommen das erst bei
  -- Fertigstellung (siehe __finishUnit).
  if complete ~= false then
    local ok2, err2
    if __startThread then
      ok2, err2 = __startThread(function() u:OnStopBeingBuilt(nil, u:GetCurrentLayer()) end)
    else
      ok2, err2 = pcall(function() u:OnStopBeingBuilt(nil, u:GetCurrentLayer()) end)
    end
    if not ok2 then return id, tostring(err2) end
    -- The engine tells an immobile unit and its neighbours about each other
    -- right after creation (Cfile:950616-950645).
    __notifyAdjacent(id)
  end
  return id, ''
end

-- These are sim_SimInits globals: sim-only, like CreateUnit above. The UI
-- VM must not have them (the core principle: never boot both into one VM).
-- === Per-army state + the victory / game-over chain ===
--
-- The engine keeps these on CArmyImpl (mVarDat/mConstDat). aibrain.lua and
-- victory.lua drive defeat and end-of-game with them; without the bindings the
-- AI's IsDefeated loop (aibrain.lua:806) and CallEndGame (victory.lua:89-99)
-- died at "access to nonexistent global".

-- One lazy record per 1-based army index. Civilian and the unit cap are seeded
-- from the session on first touch (ScenarioInfo, like the CArmyImpl ctor reads
-- the army table, Cfile:1017244/1017634).
__armyVarDat = {}
function __armyVar(army)
  -- Auch hier gilt `ARMY_FromLuaState`: SECHS Bindungen haengen an dieser
  -- Funktion, und alle sechs nehmen im Original einen Armee-NAMEN, weil sie
  -- durch `ARMY_FromLuaState` gehen — nachgesehen, nicht angenommen:
  -- `SetIgnoreArmyUnitCap`, `ArmyIsOutOfGame`, `ArmyIsCivilian`
  -- (Cfile:1025687), `GetArmyUnitCap` (Cfile:1024976), `SetArmyUnitCap`
  -- (Cfile:1025033), `SetArmyOutOfGame` (Cfile:1026347).
  --
  -- Zahlen gehen unveraendert durch: `__armyVar` wird intern mit bereits
  -- aufgeloesten Indizes gerufen, und eine zusaetzliche Bereichspruefung hier
  -- wuerde Aufrufer treffen, die es heute richtig machen.
  local i = army
  if type(i) == 'string' then i = __resolveArmy(i) end
  if type(i) ~= 'number' then error('Unexpected type for army object', 2) end
  local r = __armyVarDat[i]
  if not r then
    -- UnitCap: session option, default 500 (Cfile:1017634-1017644).
    local cap = 500
    local civ = false
    if ScenarioInfo then
      if ScenarioInfo.Options and tonumber(ScenarioInfo.Options.UnitCap) then
        cap = tonumber(ScenarioInfo.Options.UnitCap)
      end
      -- Civilian flag from the army setup row (Cfile:1017244).
      for _, a in pairs((ScenarioInfo.ArmySetup) or {}) do
        if a.ArmyIndex == i and a.Civilian == true then civ = true end
      end
    end
    r = { isOutOfGame = false, isCivilian = civ, unitCap = cap, ignoreUnitCap = false }
    __armyVarDat[i] = r
  end
  return r
end

-- "Signal the end of the game. Acts like a permanent pause." (EndGame,
-- Cfile:1077480). Sets the ended flag; victory.lua:97 calls it 3 s after the
-- result is synced.
__gameEnded = false
function EndGame()
  __gameEnded = true
end

-- "Return true if the game is over (EndGame() has been called)." (IsGameOver,
-- Cfile:1077505) — mGameEnded || mGameOver (Cfile:1077543). aibrain.lua:3586
-- guards an AI loop with it.
__gameOver = false
function IsGameOver()
  return __gameEnded == true or __gameOver == true
end

-- Defeat flag (Cfile:1026283/1026322). aibrain.lua:781 sets it first in
-- OnDefeat; IsDefeated (aibrain.lua:806) reads it; victory.lua walks the armies.
function ArmyIsOutOfGame(army) return __armyVar(army).isOutOfGame == true end
function SetArmyOutOfGame(army) __armyVar(army).isOutOfGame = true end

-- Civilian flag from the session (Cfile:1025673). victory.lua:28 skips
-- civilians in the defeat/victory scan.
function ArmyIsCivilian(army) return __armyVar(army).isCivilian == true end

-- "SubmitXMLArmyStats" (Cfile:1091052) — the Lua-visible part is just a request
-- flag; the gpg.net upload is the network layer's, which we do not have.
-- victory.lua:91 calls it on every result, so it must not throw.
__requestXMLArmyStatsSubmit = false
function SubmitXMLArmyStats()
  __requestXMLArmyStatsSubmit = true
end

-- === Unit cap ===
-- GetArmyUnitCap/SetArmyUnitCap (Cfile:1024961/1025008), SetIgnoreArmyUnitCap
-- (Cfile:1025065). simutils.lua:196-204 redistributes the total cap over the
-- surviving brains after every defeat.
function GetArmyUnitCap(army) return __armyVar(army).unitCap end
function SetArmyUnitCap(army, cap)
  if type(cap) ~= 'number' then error('SetArmyUnitCap: number expected', 2) end
  __armyVar(army).unitCap = cap
end
function SetIgnoreArmyUnitCap(army, flag)
  __armyVar(army).ignoreUnitCap = flag == true
end

-- "GetArmyUnitCostTotal(army)" (Cfile:1024895) — sums bp.General.CapCost over
-- the army's units, skipping those in UNITSTATE_NoCost (Cfile:1016520-1016540).
-- CapCost defaults to 1.0 (Cfile:656080).
function GetArmyUnitCostTotal(army)
  local total = 0
  for _, u in ipairs(__armyUnits(army)) do
    if not (u.IsUnitState and u:IsUnitState('NoCost')) then
      local cc = (u.__bp and u.__bp.General and u.__bp.General.CapCost)
      total = total + (cc or 1)
    end
  end
  return total
end

-- "ListArmies()" (Cfile:1024337) — the army NAMES at 1-based indices, in army
-- order (mConstDat.mArmyName, Cfile:1024383). siminit.lua:187 applies build
-- restrictions to each; scenarioutilities iterates it. Strings, not brains.
function ListArmies()
  local out = {}
  if ScenarioInfo and ScenarioInfo.ArmySetup then
    for name, a in pairs(ScenarioInfo.ArmySetup) do
      out[a.ArmyIndex] = a.ArmyName or name
    end
  end
  return out
end

-- "CheatsEnabled()" (Cfile:1077381) — the session flag, and it LOGS the attempt
-- either way (Cfile:1074063). ScenarioInfo.Options.CheatsEnabled == 'true'.
__cheatsEnabled = false
function CheatsEnabled()
  if ScenarioInfo and ScenarioInfo.Options and ScenarioInfo.Options.CheatsEnabled == 'true' then
    __cheatsEnabled = true
  end
  return __cheatsEnabled == true
end

-- === Creating units from Lua ===
--
-- CreateUnit(blueprint, army, tx, ty, tz, qx, qy, qz, qw, [layer])
-- (cfunc_CreateUnitL, Cfile:980268, help text Cfile:980258). The engine checks
-- the blueprint ("Unknown unit kind: %s", Cfile:980337) and the army index
-- ("Invalid army index; must be >= 1 and < %d", Cfile:980352), builds
-- SUnitConstructionParams(layer, pos, army, bp, creator = 0, complete = 1) from
-- them and calls Sim::CreateUnit — the unit comes into being COMPLETE, not as
-- a construction site (Cfile:980435-980444). It returns the unit; if creation
-- fails the engine throws "CreateUnit(%s) failed".
--
-- Callers in the original: effectutilities.lua:436 (SpawnBuildBots — the
-- Cybran build drones), scenarioframework, terranunits.lua (build pods).
local function spawnCreateUnit(blueprint, army, x, y, z, heading, who, layer)
  local key = type(blueprint) == 'string' and string.lower(blueprint) or nil
  local bp = key and __registered and __registered.Unit[key]
  if not bp then error('Unknown unit kind: ' .. tostring(blueprint), 3) end
  if type(army) ~= 'number' or army < 1 then
    error('Invalid army index; must be >= 1 but got ' .. tostring(army), 3)
  end
  local scriptPath = bp.Script or ('/units/' .. key .. '/' .. key .. '_script.lua')
  local id, err = __spawnUnit(scriptPath, key, x, y, z, army, true, layer, heading)
  if id < 0 then error(who .. '(' .. tostring(blueprint) .. ') failed: ' .. tostring(err), 3) end
  return __units[id]
end

--- The yaw from a quaternion (the engine hands out orientations as
--- quaternions, GetOrientation -> {x, y, z, w}).
local function headingFromQuat(qx, qy, qz, qw)
  qx, qy, qz, qw = qx or 0, qy or 0, qz or 0, qw or 1
  return math.atan(2 * (qw * qy + qx * qz), 1 - 2 * (qy * qy + qz * qz))
end

function CreateUnit(blueprint, army, tx, ty, tz, qx, qy, qz, qw, layer)
  return spawnCreateUnit(blueprint, army, tx, ty, tz, headingFromQuat(qx, qy, qz, qw), 'CreateUnit', layer)
end

--- CreateUnitHPR(blueprint, army, x, y, z, pitch, yaw, roll) — Cfile:980475.
--- The same creation, only with Euler angles instead of a quaternion.
---
--- Anders als `CreateUnit` nimmt diese Bindung auch einen Armee-NAMEN: sie
--- geht durch `ARMY_FromLuaState` (Cfile:980538), waehrend `cfunc_CreateUnitL`
--- auf `LUA_TNUMBER` besteht und sonst `TypeError "integer"` wirft
--- (Cfile:980336-980352). Die Original-Lua verlaesst sich darauf —
--- `scenarioutilities.lua:206` reicht `strArmy` durch.
function CreateUnitHPR(blueprint, army, x, y, z, pitch, yaw, roll)
  return spawnCreateUnit(blueprint, __resolveArmy(army), x, y, z, yaw or 0, 'CreateUnitHPR')
end

--- CreateUnit2(blueprint, army, layer, x, z, heading) — Cfile:980637. The
--- height comes from the terrain (the signature has no y).
function CreateUnit2(blueprint, army, layer, x, z, heading)
  -- CreateUnit2 alone specifies heading in degrees; the native binding
  -- multiplies it by pi/180 before constructing the quaternion
  -- (Cfile:980842-980853). Runtime headings in this engine are radians.
  return spawnCreateUnit(
    blueprint, army, x, GetSurfaceHeight(x, z), z,
    math.rad(heading or 0), 'CreateUnit2', layer
  )
end

-- === Adjacency (Moho::Unit::CollectAllOverlapping, Cfile:62d460) ===
--
-- When an immobile unit comes into being — created complete (Cfile:950616) or
-- finished by a build task (Materialize, Cfile:953548) — the engine collects
-- every overlapping structure and runs the Lua callback on BOTH sides:
--
--   new:OnAdjacentTo(other, new)      Cfile:953563
--   other:OnAdjacentTo(new,   new)    Cfile:953568
--
-- That is where FA's adjacency bonuses come from: StructureUnit.OnAdjacentTo
-- (defaultunits.lua:357) looks up bp.Adjacency in AdjacencyBuffs and applies
-- every buff of that table to the neighbour. Without the callback a power
-- generator next to a factory does nothing at all — one of the game's core
-- mechanics was missing.

--- The ENGINE's skirt rect (Moho::RUnitBlueprint::GetSkirtRect, Cfile:51ec50).
--- NOT the same as the Lua one in unit.lua:240: the engine TRUNCATES the lower
--- corner to whole ogrids (grid alignment) and falls back to the footprint when
--- a skirt size is 0.
local function skirtRect(u)
  local bp = u.__bp or {}
  local fp = bp.Footprint or {}
  local phys = bp.Physics or {}
  local p = u.__pos or { 0, 0, 0 }
  local fpX = fp.SizeX or 0
  local fpZ = fp.SizeZ or 0
  -- (int) truncates toward zero; map coordinates are positive.
  local xLower = math.floor(p[1] - fpX * 0.5)
  local zLower = math.floor(p[3] - fpZ * 0.5)
  local x0, x1, z0, z1
  if (phys.SkirtSizeX or 0) == 0 then
    x0, x1 = xLower, xLower + fpX
  else
    x0 = xLower + (phys.SkirtOffsetX or 0)
    x1 = x0 + phys.SkirtSizeX
  end
  if (phys.SkirtSizeZ or 0) == 0 then
    z0, z1 = zLower, zLower + fpZ
  else
    z0 = zLower + (phys.SkirtOffsetZ or 0)
    z1 = z0 + phys.SkirtSizeZ
  end
  return x0, z0, x1, z1
end

--- Moho::Unit::OverlapsWith (Cfile:62d2b0) — two skirts count as adjacent when
--- they TOUCH on one axis (edge distance < 1 ogrid) and one of them CONTAINS
--- the other on the other axis. That containment rule is why FA's adjacency is
--- so picky about alignment.
local function overlapsWith(a, b)
  local ax0, az0, ax1, az1 = skirtRect(a)
  local bx0, bz0, bx1, bz1 = skirtRect(b)
  local touchX = math.abs(ax0 - bx1) < 1 or math.abs(ax1 - bx0) < 1
  if not touchX then
    -- Not touching along X: then they must touch along Z and overlap in X.
    local touchZ = math.abs(az0 - bz1) < 1 or math.abs(az1 - bz0) < 1
    if not touchZ then return false end
    if ax0 >= bx0 and bx1 >= ax1 then return true end
    if bx0 >= ax0 and ax1 >= bx1 then return true end
    return false
  end
  -- Touching along X: they must contain each other along Z.
  if az0 >= bz0 and bz1 >= az1 then return true end
  if bz0 >= az0 and az1 >= bz1 then return true end
  return false
end

local function immobile(u)
  return ((u.__bp and u.__bp.Physics and u.__bp.Physics.MotionType) or 'RULEUMT_None') == 'RULEUMT_None'
end

--- Every structure of the same army whose skirt overlaps this one's.
--- Filter per Cfile:62d56a-62d5be: alive, IMMOBILE, SAME ARMY, not itself,
--- same layer, within 20 ogrids, and OverlapsWith.
local function overlappingNeighbours(id, u)
  local out = {}
  local p = u.__pos or { 0, 0, 0 }
  for oid, o in pairs(__units) do
    if oid ~= id and not o.__dead and not o.__destroyQueued and immobile(o)
      and (o.__army or 1) == (u.__army or 1) and o.Layer == u.Layer then
      local q = o.__pos or { 0, 0, 0 }
      local dx, dz = q[1] - p[1], q[3] - p[3]
      -- The engine's spatial query uses a 20 ogrid radius (Cfile:62d4f9).
      if dx * dx + dz * dz <= 400 and overlapsWith(u, o) then
        out[table.getn(out) + 1] = o
      end
    end
  end
  return out
end

--- Tell a freshly completed structure and its neighbours about each other
--- (Cfile:953563/953568). The second argument is the TRIGGERING unit in both
--- calls — the one that just came into being.
function __notifyAdjacent(id)
  local u = __units[id]
  if not u or u.__dead or u.__destroyQueued or not immobile(u) then return end
  for _, o in ipairs(overlappingNeighbours(id, u)) do
    local ok, err = pcall(function() u:OnAdjacentTo(o, u) end)
    if not ok then WARN('OnAdjacentTo: ' .. tostring(err)) end
    local ok2, err2 = pcall(function() o:OnAdjacentTo(u, u) end)
    if not ok2 then WARN('OnAdjacentTo: ' .. tostring(err2)) end
  end
end

--- The counterpart when a structure DIES (Cfile:952133-952162): if it is
--- immobile and was NOT still under construction, both sides get
--- `OnNotAdjacentTo(other)` — one argument, not two (defaultunits.lua:372).
--- That is what REMOVES the adjacency buffs again; without it a destroyed
--- power generator kept boosting its neighbour forever.
function __notifyNotAdjacent(id)
  local u = __units[id]
  if not u or not immobile(u) or u.__beingBuilt then return end
  for _, o in ipairs(overlappingNeighbours(id, u)) do
    local ok, err = pcall(function() u:OnNotAdjacentTo(o) end)
    if not ok then WARN('OnNotAdjacentTo: ' .. tostring(err)) end
    local ok2, err2 = pcall(function() o:OnNotAdjacentTo(u) end)
    if not ok2 then WARN('OnNotAdjacentTo: ' .. tostring(err2)) end
  end
end

-- Baustelle: wie __spawnUnit, aber UNFERTIG (FractionComplete 0, Health 0,
-- IsBeingBuilt) — ohne OnStopBeingBuilt. Produktion/Unterhalt bleiben inaktiv
-- bis zur Fertigstellung.
function __spawnBuildSite(scriptPath, bpId, x, y, z, army, builderId, order)
  local id, err = __spawnUnit(scriptPath, bpId, x, y, z, army, false)
  if id < 0 then return id, err end
  local u = __units[id]
  u.__fraction = 0
  u.__health = 0
  u.__beingBuilt = true
  __econSetComplete(army, id, false)
  if builderId then __startBuildSite(id, builderId, order) end
  return id, err
end

--- Unit::Materialize calls the target callback once when the construction site
--- is created (Cfile:950553-950593). Later helpers receive only OnStartBuild.
function __startBuildSite(id, builderId, order)
  local u = __units[id]
  local builder = __units[builderId]
  if not u or not builder or u.__startBeingBuilt then return false end
  u.__startBeingBuilt = true
  pcall(function() u:OnStartBeingBuilt(builder, order or 'MobileBuild') end)
  return true
end

-- Fertigstellung einer Baustelle: die Engine setzt den Zustand und ruft dann
-- OnStopBeingBuilt auf der Unit (Original-Kette; dort schalten Gebaeude ihre
-- Produktion ein, Fabriken ihre Bau-Caps usw.).
function __finishUnit(id, builderId)
  local u = __units[id]
  if not u then return false, 'unknown unit ' .. tostring(id) end
  u.__fraction = 1
  u.__beingBuilt = false
  u.__health = u:GetMaxHealth()
  __econSetComplete(u.__army or 1, id, true)
  local builder = builderId and __units[builderId] or nil
  local ok, err
  if __startThread then
    ok, err = __startThread(function() u:OnStopBeingBuilt(builder, u:GetCurrentLayer()) end)
  else
    ok, err = pcall(function() u:OnStopBeingBuilt(builder, u:GetCurrentLayer()) end)
  end
  -- Materialize runs the adjacency scan once the unit is complete
  -- (Cfile:953548-953576).
  __notifyAdjacent(id)
  return ok, (ok and '' or tostring(err))
end

-- Alle Units in einem Aufruf lesen (ein Eval pro Beat für den Renderer/Worker).
-- EIN Zustandsabbild einer Unit. Frueher gab es zwei — __readUnit ohne
-- fraction/moving, __readAllUnits ohne mesh. Zwei Abbilder derselben Sache
-- laufen garantiert auseinander; wer dann welches liest, entscheidet der Zufall.
-- The unit's active order for the command graph (UICommandGraph draws
-- order lines + waypoint markers per UNITCOMMAND_*, params from
-- commandgraphparams.lua).
-- mVarDat.mMesh as the renderer needs it: the mesh blueprint id when it is
-- NOT the blueprint's Display.MeshBlueprint -- Unit:SetMesh swapped it (the
-- personal shield's OwnerShieldMesh, shield.lua:478; the build mesh,
-- unit.lua:1607) -- and '' when the unit has no mesh at all (SetMesh('')).
-- nil while it is the blueprint one: the row stays small and the golden
-- master unmoved for every unit that never swaps.
local function swappedMesh(u)
  local disp = u.__bp and u.__bp.Display
  local def = (disp and disp.MeshBlueprint) or ''
  local cur = u.__meshBp or ''
  if cur ~= def then return cur end
  return nil
end

local function activeOrder(id, u)
  local target = __attackOrders and __attackOrders[id]
  if target then
    if type(target) == 'table' then
      -- Ground attack: the position IS the target (AITARGET_Ground).
      return 'Attack', target[1], target[3]
    end
    local t = __units[target]
    if t and t.__pos then return 'Attack', t.__pos[1], t.__pos[3] end
  end
  for _, task in pairs(__buildTasks or {}) do
    if task.builder == id then
      local t = __units[task.target]
      if t and t.__pos then
        -- BuildMobile and Repair share the engineering colors; the repair
        -- waypoint texture is the BuildMobile one (commandgraphparams:140-144).
        return (task.order == 'Repair') and 'Repair' or 'BuildMobile', t.__pos[1], t.__pos[3]
      end
    end
  end
  if u.__goal then return 'Move', u.__goal[1], u.__goal[2] end
  return nil
end

-- Resolve one command's waypoint position by its type — the SAME rules for the
-- executing head and the waiting queue (both are entries of the command list).
local function resolveOrderPos(cmd)
  if cmd.type == 'Move' or cmd.type == 'Patrol' or cmd.type == 'AggressiveMove' or cmd.type == 'TransportUnload' then
    return cmd.x, cmd.z
  elseif cmd.gx then
    return cmd.gx, cmd.gz -- ground attack (queued or active)
  elseif cmd.type == 'Reclaim' then
    -- Reclaim targets a PROP (wreck / map feature) or, rarely, a live unit
    -- (globals.lua:1703) — resolve from either so the reclaim line draws.
    local p = (__props and __props[cmd.target]) or __units[cmd.target]
    if p and p.__pos then return p.__pos[1], p.__pos[3] end
  else
    local t = __units[cmd.target]
    if t and t.__pos then return t.__pos[1], t.__pos[3] end
  end
  return nil
end

-- The FULL order list for the command graph: the active order first, then
-- the queued commands (__orders FIFO) with entity targets resolved to
-- their CURRENT position — the original graph tracks entity targets live
-- (DirtyCommandGraph re-tesselation).
local function orderList(id, u)
  local out = nil
  -- HEAD: the executing command keeps its OWN UNITCOMMAND type. The engine's
  -- UICommandGraph::CreateMeshes (Cfile:1247191) walks the whole command queue
  -- INCLUDING the running head, and every node keeps its EUnitCommandType
  -- (LoadPathParams builds one node per type, Cfile:1244312). __orderActive[id]
  -- IS that head (globals.lua). Reading it fixes an active Patrol drawn as a Move
  -- waypoint and an active Reclaim/Guard (whose __goal is cleared while it works)
  -- drawn as no line at all — activeOrder() reconstructed the type from live
  -- physics and got both wrong.
  local active = __orderActive and __orderActive[id]
  if active then
    local x, z = resolveOrderPos(active)
    if x then out = { { id = active.serial or 0, t = active.type, x = x, y = GetSurfaceHeight(x, z), z = z } } end
  else
    -- Commands that do NOT flow through the order queue keep their execution
    -- state elsewhere: a mobile builder's structure build/repair lives only in
    -- __buildTasks (luaSimWorker.ts:219), and an auto-engagement attack in
    -- __attackOrders. activeOrder() surfaces those as the head.
    local ot, ox, oz = activeOrder(id, u)
    if ot then out = { { t = ot, x = ox, z = oz } } end
  end
  for _, cmd in ipairs((__orders and __orders[id]) or {}) do
    local x, z = resolveOrderPos(cmd)
    if x then
      out = out or {}
      out[#out + 1] = { id = cmd.serial or 0, t = cmd.type, x = x, y = GetSurfaceHeight(x, z), z = z }
    end
  end
  return out
end

-- The FACTORY command list for the user side (Unit::SyncInterface copies
-- mBuilder->GetCommands() whenever the builder needs a refresh; the user
-- unit's GetCommandQueue reads that list when the unit has one,
-- Cfile:1367121-1367128, and the command graph draws it for an immobile
-- FACTORY beside the unit's own queue, 1245537-1245575). One entry per
-- command: id, type and the target position (GetTargetPosGun).
local function factoryCommandList(id, u)
  local list = __factoryCommands and __factoryCommands[id]
  if not list or #list == 0 then return nil end
  local out = {}
  for _, c in ipairs(list) do
    local x, y, z = __factoryCommandPos(c)
    if x then out[#out + 1] = { id = c.id, t = c.type, x = x, y = y, z = z } end
  end
  return out
end

-- Turret bone angles for the renderer (CAimManipulator state, advanced in
-- weapons.lua aimTick): yaw/pitch relative to the rest pose per aim bone.
local function readTurrets(u)
  local out = nil
  for _, w in ipairs(u.__weapons or {}) do
    for _, aim in ipairs(w.__aims or {}) do
      if not aim.__destroyed and aim.__yawBone
        and (math.abs(aim.__yaw or 0) > 0.0001 or math.abs(aim.__pitch or 0) > 0.0001) then
        out = out or {}
        out[#out + 1] = {
          b = aim.__yawBone, y = aim.__yaw or 0,
          pb = aim.__pitchBone, p = aim.__pitch or 0,
        }
      end
    end
  end
  return out
end

local function readRow(id, u)
  local p = u.__pos or { 0, 0, 0 }
  local moving = (u.__goal ~= nil and u.__goal ~= false)
  return {
    orders = orderList(id, u),
    fcmds = factoryCommandList(id, u),
    turrets = readTurrets(u),
    id = id,
    name = (u.__bp and u.__bp.BlueprintId) or '?',
    x = p[1], y = p[2], z = p[3],
    heading = u.__heading or 0,
    -- A flyer's full pose (the PhysBody's mOrientation, air.lua) for the
    -- renderer's banking and pitch: (x, y, z, w), absent for ground units.
    orient = (u.__air and u.__orient) or nil,
    health = u.__health or 0,
    maxHealth = u:GetMaxHealth(),
    moving = moving,
    fraction = u.__fraction or 1,
    -- Fire state mirror for the user side (SUnitVarDat.mFireState is part of
    -- the per-unit sync block, ctor Cfile:772277). The sim itself never
    -- changes it — only the SetFireState user command does.
    fireState = u.__fireState or 0,
    -- The guarded unit id (mUnit->mGuardedUnit, task-synced Cfile:839316) —
    -- feeds GetGuardedEntity/GetAssistingUnitsList in the user mirror.
    guard = u.__guardedUnit or 0,
    -- The effective command-cap mask (UnitAttributes::commandCapsMask:
    -- blueprint-initialized, mutated by Add/RemoveCommandCap, faf-re
    -- Unit.cpp:8675-8813). Synced per beat so the UI mirror follows
    -- runtime cap changes instead of freezing at the blueprint state.
    caps = __ensureCommandCapMask(u),
    toggleCaps = __ensureToggleCapMask(u),
    -- ToggleScriptBit and the UI getters read the synchronized Unit variable
    -- data, not an optimistic UI copy (cfunc_ToggleScriptBitL).
    scriptBits = u.__scriptBits or 0,
    -- Current layer (mVarDat.mLayer): GetIsSubmerged folds this value into
    -- -1/0/+1 on the user side.
    layer = u:GetCurrentLayer(),
    autoMode = u.__autoMode == true,
    autoSurfaceMode = u.__autoSurfaceMode == true,
    -- Shield strength ratio (0..1), fed by shield.lua UpdateShieldRatio ->
    -- Unit:SetShieldRatio (moho). The UI mirror shows it (GetShieldRatio; the
    -- rollover shield bar, unitview.lua).
    shieldRatio = u.__shieldRatio or 0,
    -- The unit's own build-restriction category (UnitAttributes::
    -- mRestrictionCategory) in text form; the user layer subtracts it from
    -- the build menu (GetUnitCommandData, Cfile:1264642-1264646).
    restrict = __unitRestrictionString(u),
    -- Bones hidden by HideBone (CAniPoseBone::mVisible), by name; nil when
    -- none. The renderer collapses their geometry.
    hidden = __hiddenBoneNames(u),
    -- The texture scroll pair (mVarDat.mScroll1 -> mScroll2, synced per
    -- entity, Cfile:701559-701562); nil until a scroller exists.
    scroll = __scrollerRow(u),
    -- Unit::SetCustomName (Cfile:979089-979120): the user layer shows it.
    customName = u.__customName or '',
    -- UNITSTATE_UnSelectable (SetUnSelectable, Cfile:974215-974260).
    unselectable = (u.__unitStates and u.__unitStates.UnSelectable) == true,
    -- WorkProgress (mUnitVarDat.mWorkProgress): what this unit is working on,
    -- written by the build task every tick (Cfile:815482) and by Lua for
    -- enhancements (unit.lua:3579). The UI shows exactly this
    -- (construction.lua:380 GetWorkProgress) — for an upgrading structure it is
    -- the progress of its successor.
    workProgress = u.__workProgress or 0,
    -- UNITSTATE_BeingUpgraded (37) — the successor growing on top of a
    -- structure. The drag box skips it (Cfile:1290062), so the box keeps
    -- selecting the working original.
    beingUpgraded = u:IsUnitState('BeingUpgraded'),
    born = u.__spawnTick or 0,
    mesh = swappedMesh(u),
    army = u.__army or 1,
    -- Death mirror: a unit lingers in __units through its multi-beat death
    -- sequence (Kill -> OnKilled thread -> Destroy), so readRow still sends it.
    -- Without this flag __uiSetUnit marks it alive (u.dead = false) and
    -- SelectUnits/avatars/ValidateUnitsList would keep a dying unit selectable —
    -- the engine excludes IsDead AND DestroyQueued (Cfile:1361497-1361498).
    dead = (u.__dead == true) or (u.__destroyQueued == true),
    -- „idle" im Sinn der Engine (die Idle-Sets am UserArmy, Cfile:1352334-1352374,
    -- werden aus dem TASK-Zustand gepflegt): kein Bewegungsziel, kein laufender
    -- oder wartender Bau-Auftrag, keine Fabrik-Produktion — und eine BAUSTELLE
    -- ist nicht leerlaufend, sie ist noch gar nicht in Betrieb. Ein bauender
    -- Ingenieur steht still und ist trotzdem NICHT idle.
    idle = not moving
      and (u.__fraction or 1) >= 1
      and not __builderBusy(id)
      and (u.__buildQueue == nil or u.__buildQueue[1] == nil),
    -- The factory's queue as the construction panel shows it: consecutive
    -- same-blueprint commands merged into stacks ({ id, count }, sub_835DF0,
    -- Cfile:1256786-1256813) -- the queue itself holds one command per unit.
    buildQueue = __factoryQueueDisplay(u),
  }
end

-- Der Unit-Zustand als JSON-STRING.
--
-- Dieselbe Falle wie beim maui-Snapshot: ein Rueckgabewert aus Lua nach JS bleibt
-- im wasmoon-Registry haengen und wird nie eingesammelt. Der Worker liest den
-- Zustand ZEHNMAL PRO SEKUNDE — die Sim-VM wuerde langsam aber sicher volllaufen.
-- Deshalb uebergibt Lua einen String an eine JS-Funktion (LuaHost.pull), statt
-- eine Tabelle zurueckzugeben.
local function jstr(s)
  s = tostring(s)
  s = string.gsub(s, '\\', '\\\\')
  s = string.gsub(s, '"', '\\"')
  return '"' .. s .. '"'
end

local function jnum(v)
  return string.format('%.6g', v or 0)
end

-- Integer fields need an EXACT serialization, not '%.6g'. '%.6g' keeps only 6
-- significant digits, so a 7-digit value is rounded: the command-cap BITMASK
-- 0x1602FF = 1442559 became 1442560 = 0x160300 — silently dropping the whole
-- low byte (RULEUCC_Move 0x1, Attack, Guard, Repair, ...) while keeping the
-- high bits (Reclaim 0x100000). The UI then reported canMove=false and the
-- commander could not be moved, only reclaim. Entity ids and the spawn tick
-- (which grows past 6 digits) have the same latent corruption.
local function jint(v)
  return string.format('%d', math.floor(v or 0))
end

function __readAllUnitsJson()
  local parts = {}
  local n = 0
  for id, u in pairs(__units) do
    local r = readRow(id, u)
    local q = {}
    for i, item in ipairs(r.buildQueue) do
      -- `count` ist eine ANZAHL, also `jint`: dieselbe Regel wie fuer die
      -- Masken darunter. Heute ist keine Warteschlange sechs Stellen lang, aber
      -- die Regel gilt nicht „solange es passt".
      q[i] = '{"id":' .. jstr(item.id) .. ',"count":' .. jint(item.count) .. '}'
    end
    n = n + 1
    parts[n] = '{"id":' .. jint(r.id)
      .. ',"name":' .. jstr(r.name)
      .. ',"x":' .. jnum(r.x) .. ',"y":' .. jnum(r.y) .. ',"z":' .. jnum(r.z)
      .. ',"heading":' .. jnum(r.heading)
      .. (r.orient and (',"orient":[' .. jnum(r.orient[1]) .. ',' .. jnum(r.orient[2]) .. ','
        .. jnum(r.orient[3]) .. ',' .. jnum(r.orient[4]) .. ']') or '')
      .. ',"health":' .. jnum(r.health)
      .. ',"maxHealth":' .. jnum(r.maxHealth)
      .. ',"moving":' .. tostring(r.moving)
      .. ',"fraction":' .. jnum(r.fraction)
      .. ',"fireState":' .. jint(r.fireState)
      .. ',"guard":' .. jint(r.guard)
      .. ',"caps":' .. jint(r.caps)
      .. ',"toggleCaps":' .. jint(r.toggleCaps)
      .. ',"scriptBits":' .. jint(r.scriptBits)
      .. ',"layer":' .. jstr(r.layer)
      .. ',"autoMode":' .. tostring(r.autoMode)
      .. ',"autoSurfaceMode":' .. tostring(r.autoSurfaceMode)
      .. ',"dead":' .. tostring(r.dead)
      .. ',"shieldRatio":' .. jnum(r.shieldRatio)
      .. ',"restrict":' .. jstr(r.restrict)
      .. (r.customName ~= '' and (',"customName":' .. jstr(r.customName)) or '')
      .. (r.unselectable and ',"unselectable":true' or '')
      .. (function()
        if not r.hidden then return '' end
        local hs = {}
        for hi, name in ipairs(r.hidden) do hs[hi] = jstr(name) end
        return ',"hidden":[' .. table.concat(hs, ',') .. ']'
      end)()
      .. (r.scroll and (',"scroll":[' .. jnum(r.scroll[1]) .. ',' .. jnum(r.scroll[2]) .. ','
        .. jnum(r.scroll[3]) .. ',' .. jnum(r.scroll[4]) .. ']') or '')
      .. ',"workProgress":' .. jnum(r.workProgress)
      .. ',"beingUpgraded":' .. tostring(r.beingUpgraded)
      .. ',"born":' .. jint(r.born)
      .. (r.mesh and (',"mesh":' .. jstr(r.mesh)) or '')
      .. (function()
        -- The whole command queue (head first) for the command graph;
        -- 'order' stays as the head alias for existing consumers.
        if not r.orders then return '' end
        local os = {}
        for oi, o in ipairs(r.orders) do
          os[oi] = '{"id":' .. jint(o.id or 0) .. ',"t":' .. jstr(o.t) .. ',"x":' .. jnum(o.x)
            .. ',"y":' .. jnum(o.y or 0) .. ',"z":' .. jnum(o.z) .. '}'
        end
        return ',"order":' .. os[1] .. ',"orders":[' .. table.concat(os, ',') .. ']'
      end)()
      .. (function()
        -- The factory command list (rally commands) the user side reads as
        -- the factory's command queue and draws beside the unit's own queue.
        if not r.fcmds then return '' end
        local fs = {}
        for fi, f in ipairs(r.fcmds) do
          fs[fi] = '{"id":' .. jint(f.id) .. ',"t":' .. jstr(f.t) .. ',"x":' .. jnum(f.x)
            .. ',"y":' .. jnum(f.y) .. ',"z":' .. jnum(f.z) .. '}'
        end
        return ',"fcmds":[' .. table.concat(fs, ',') .. ']'
      end)()
      .. (function()
        if not r.turrets then return '' end
        local ts = {}
        for ti, t in ipairs(r.turrets) do
          ts[ti] = '{"b":' .. jstr(t.b) .. ',"y":' .. jnum(t.y)
            .. (t.pb and (',"pb":' .. jstr(t.pb) .. ',"p":' .. jnum(t.p)) or '')
            .. '}'
        end
        return ',"turrets":[' .. table.concat(ts, ',') .. ']'
      end)()
      .. ',"army":' .. jint(r.army)
      .. ',"idle":' .. tostring(r.idle)
      .. ',"buildQueue":[' .. table.concat(q, ',') .. ']'
      .. '}'
  end
  return '[' .. table.concat(parts, ',') .. ']'
end

function __readAllUnits()
  local out = {}
  local n = 0
  for id, u in pairs(__units) do
    n = n + 1
    out[n] = readRow(id, u)
  end
  return out
end

function __readUnit(id)
  local u = __units[id]
  if not u then return nil end
  return readRow(id, u)
end

-- ── Startposition und Start-Einheit ──────────────────────────────────────────
--
-- Das Original setzt die Startposition BEVOR irgendetwas gebaut wird:
-- `ScenarioUtils.InitializeStartLocation(name)` (scenarioutilities.lua:1026-1033)
-- laeuft je Armee aus dem schook-`OnCreateArmyBrain` (schook/lua/simInit.lua:47),
-- liest den Marker `ARMY_<n>` aus der geladenen Karte und ruft `SetArmyStart`.
-- Fehlt der Marker, wuerfelt `GenerateArmyStart` eine Position.

--- `SetArmyStart(army, x, z)` — drei Argumente, Armee ueber `ARMY_FromLuaState`,
--- dann zwei Zahlen (cfunc_SetArmyStartL, Cfile:1024490-1024526).
---
--- Gespeichert wird ein **2D**-Vektor `Wm3::Vector2f(x, z)` (Cfile:1024524) —
--- keine Hoehe. Die kommt erst beim Spawn aus dem Gelaende.
function SetArmyStart(army, x, z)
  local i = __resolveArmy(army)
  if type(x) ~= 'number' or type(z) ~= 'number' then
    error('SetArmyStart: number expected', 2)
  end
  __armyVar(i).start = { x, z }
end

--- `GenerateArmyStart(army)` — die Zufallsposition, wenn die Karte keinen
--- Marker hat (Cfile:1017961-1017981). Die Engine ruft sie selbst waehrend der
--- Armee-Erzeugung (Cfile:1017228); ein vorhandener Marker ueberschreibt sie
--- danach.
---
--- Der Zufallsteil ist NICHT nachgebildet: die Engine zieht aus ihrem eigenen
--- Generator (`rand * 1.862645e-10 + 0.1`, skaliert mit `width-1`/`height-1`).
--- Diesen Generator gibt es hier nicht (siehe docs/STATUS.md, Prüfsummen), und
--- eine eigene Zufallsquelle waere eine Erfindung. Deshalb: Kartenmitte, und
--- der Aufrufer bekommt es GESAGT.
function GenerateArmyStart(army)
  local i = __resolveArmy(army)
  local w, h = GetMapSize()
  WARN('GenerateArmyStart(' .. tostring(army) .. '): kein ARMY-Marker; die '
    .. 'Engine wuerfelt hier (Cfile:1017961-1017981), wir setzen die Kartenmitte. '
    .. 'Solange der Zufallsgenerator der Engine fehlt, ist das nicht 1:1.')
  __armyVar(i).start = { w * 0.5, h * 0.5 }
end

--- `ShouldCreateInitialArmyUnits()` — NULL Argumente (die Engine wirft sonst,
--- Cfile:1024327-1024329), Ergebnis `not CFG_GetArgOption("/noinitialunits")`
--- (Cfile:1024330-1024331). Ohne die Kommandozeilenoption also `true`.
function ShouldCreateInitialArmyUnits()
  return __noInitialUnits ~= true
end

--- `SetArmyPlans(army, plans)` und `InitializeArmyAI(name)` — die beiden
--- anderen Haelften des schook-`OnCreateArmyBrain` (schook/lua/simInit.lua:45-51,
--- siminit.lua:122).
---
--- `InitializeArmyAI` ist im Original `CAiBrain::Initialize`
--- (Cfile:1024677-1024699): es ruft `brain:OnCreateHuman(plan)`, wenn die Armee
--- menschlich ist, sonst `brain:OnCreateAI(plan)` (Cfile:724516-724518;
--- `IsHuman` = `ArmyType() == "Human"`, Cfile:1017952-1017957).
function SetArmyPlans(army, plans)
  __armyVar(__resolveArmy(army)).plans = plans
end

function InitializeArmyAI(army)
  local i = __resolveArmy(army)
  local brain = __getBrain(i)
  local human = false
  if ScenarioInfo and ScenarioInfo.ArmySetup then
    for name, a in pairs(ScenarioInfo.ArmySetup) do
      if a.ArmyIndex == i then human = a.Human == true end
    end
  end
  local plan = __armyVar(i).plans
  if human then
    if brain.OnCreateHuman then brain:OnCreateHuman(plan) end
  else
    if brain.OnCreateAI then brain:OnCreateAI(plan) end
  end
end

--- `CreateInitialArmyUnit(army, blueprintId)` (cfunc_CreateInitialArmyUnitL,
--- Cfile:1025200-1025275).
---
--- Zwei Argumente. Die Armee kommt ueber `ARMY_FromLuaState`, die POSITION aus
--- `GetArmyStartPos()` derselben Armee — nicht aus einem Argument. Der Rest ist
--- festgelegt: Orientierung Identitaet (`orient.x = 1.0`, Rest 0,
--- Cfile:1025263-1025264), `pos.y = 0.0` (Cfile:1025265), `mCreator = 0` und
--- `mComplete = 1` (Cfile:1025272-1025273). Ein unbekannter Blueprint ist
--- `"Unknown initial unit: %s"` (Cfile:1025258).
---
--- Die Hoehe ist NICHT unsere: die Engine uebergibt `y = 0` und `Moho::Unit::Unit`
--- ersetzt sie durch `CalcSpawnElevation(...)`, solange `!mFixElevation`
--- (Cfile:950181-950196). Deshalb geht hier `y = 0` in denselben Spawn-Pfad,
--- den jede andere Einheit nimmt — kein eigenes `GetSurfaceHeight`, das nur
--- fuer die Land-Ebene stimmen wuerde.
function CreateInitialArmyUnit(army, bpId)
  local i = __resolveArmy(army)
  if type(bpId) ~= 'string' then error('CreateInitialArmyUnit: string expected', 2) end
  local start = __armyVar(i).start
  if not start then
    -- Die Engine kann hier nicht landen: `GenerateArmyStart` lief bereits
    -- waehrend der Armee-Erzeugung (Cfile:1017228). Kommen wir doch hierher,
    -- ist unser Sitzungsaufbau unvollstaendig — und das soll man merken.
    error(string.format(
      'CreateInitialArmyUnit: Armee %s hat keine Startposition. SetArmyStart '
      .. 'oder GenerateArmyStart muss vorher gelaufen sein '
      .. '(InitializeStartLocation, scenarioutilities.lua:1026).', tostring(army)), 2)
  end
  local u = CreateUnitHPR(bpId, i, start[1], 0, start[2], 0, 0, 0)
  if not u then error(string.format('Unknown initial unit: %s', bpId), 2) end
  return u
end

-- === The transfer of a unit to another army ===

--- Moho::Sim::TransferUnit (Cfile:1073702-1074080): nothing for a dead or
--- deletion-queued unit; for a unit WITH a transport component
--- (1073756-1073889) the stored units and the attached live mobile units
--- are detached (skipBallistic) and transferred first (1073818-1073876);
--- a new unit of the same blueprint is created for the new army at the
--- same transform and layer, complete, with the elevation fixed
--- (1073890-1073908); the poses are shared (1073911-1073913 -- no
--- animation state here), the health is copied when it differs
--- (1073938-1073941), the custom name is copied (1073942-1073944); the
--- transferred passengers are attached to the new unit at their bones --
--- the transport assigns the slot and hears OnTransportAttach
--- (1073945-1074030); a static new unit clears the old unit's occupancy
--- flag (1074031 -- no per-unit ogrid flag here: the old structure's
--- footprint goes with its destroy) and the old unit is destroyed
--- (1074033). When the new unit cannot be created and the army does not
--- ignore the unit cap, the brain hears OnFailedUnitTransfer
--- (1074036-1074040; the cap is not enforced by __spawnUnit,
--- docs/STATUS.md). Not modelled: the transport's stored units
--- (TransportGetStoredUnits 1073760-1073817), the flyer's full pose (the
--- heading is carried). The "mobile" of the passengers (IsMobile 1073822)
--- is read off the blueprint's MotionType -- UNVERIFIED as the engine's
--- own test.
function __transferUnit(u, army)
  if not u or u.__dead or u.__destroyQueued then return nil end
  local carried = {}
  if __transportOf and __transportOf(u) then
    for _, e in ipairs(u.__attachedEntities or {}) do
      local mt = e.__bp and e.__bp.Physics and e.__bp.Physics.MotionType
      if e.__isUnit and mt ~= nil and mt ~= 'RULEUMT_None' and not e.__dead and not e.__destroyQueued then
        carried[#carried + 1] = { unit = e, parentBone = e.__attachParentBone, selfBone = e.__attachSelfBone }
      end
    end
  end
  for _, c in ipairs(carried) do
    __entityDetach(c.unit, true)
    c.unit.__transportedBy = false
  end
  for _, c in ipairs(carried) do c.newUnit = __transferUnit(c.unit, army) end
  local bp = u.__bp
  local key = string.lower(bp.BlueprintId or u.__bpId or '')
  local scriptPath = bp.Script or ('/units/' .. key .. '/' .. key .. '_script.lua')
  local p = u.__pos
  local id, err = __spawnUnit(scriptPath, key, p[1], p[2], p[3], army, true, u.__layer, u.__heading)
  if id < 0 then
    if not __armyVar(army).ignoreUnitCap then
      local brain = __getBrain(army)
      if brain and type(brain.OnFailedUnitTransfer) == 'function' then
        local ok, e2 = pcall(brain.OnFailedUnitTransfer, brain)
        if not ok then WARN('OnFailedUnitTransfer: ' .. tostring(e2)) end
      end
    end
    WARN('TransferUnit: ' .. tostring(err))
    return nil
  end
  local n = __units[id]
  if (u.__health or 0) ~= (n.__health or 0) then n:SetHealth(u, u.__health or 0) end
  if u.__customName and u.__customName ~= '' then n.__customName = u.__customName end
  for _, c in ipairs(carried) do
    if c.newUnit then
      __entityAttach(c.newUnit, n, c.selfBone, c.parentBone)
      local t = __transportOf and __transportOf(n)
      if t then
        __transportAssignSlot(t, c.newUnit, c.parentBone)
        local name = __skeletonOf(n).names[(c.parentBone or -1) + 1]
        if name and type(n.OnTransportAttach) == 'function' then
          local ok, e3 = pcall(n.OnTransportAttach, n, name, c.newUnit)
          if not ok then WARN('OnTransportAttach: ' .. tostring(e3)) end
        end
      end
    end
  end
  u:Destroy()
  return n
end

--- ChangeUnitArmy(unit, army) -- cfunc_ChangeUnitArmyL (Cfile:1089461-1089587):
--- two arguments, the unit (SCR_FromLua_Unit), the army by index or name
--- (ARMY_FromLuaState; an unknown one is "Invalid army %d", a non-number
--- the integer TypeError), "Unit already belongs to army %d" for its own; a
--- unit carrying a COMMAND unit is refused with nil (1089531-1089575);
--- otherwise Sim::TransferUnit's new unit, or nil. unit.lua:555 (the
--- capture), simutils.lua:97 (TransferUnitsOwnership) and
--- scenarioframework.lua:224 call it.
function ChangeUnitArmy(...)
  local n = select('#', ...)
  if n ~= 2 then error(string.format('ChangeUnitArmy\n  expected %d args, but got %d', 2, n), 2) end
  local unit, army = ...
  if type(unit) ~= 'table' or not unit.__isUnit then
    error("Expected a game object. (Did you call with '.' instead of ':'?)", 2)
  end
  local a = __resolveArmy(army)
  if not a then
    if type(army) ~= 'number' then error('bad argument #2 to \'ChangeUnitArmy\' (integer expected)', 2) end
    error(string.format('Invalid army %d', army), 2)
  end
  if unit.__army == a then error(string.format('Unit already belongs to army %d', a), 2) end
  for _, e in ipairs(unit.__attachedEntities or {}) do
    if e.__isUnit and EntityCategoryContains(categories.COMMAND, e) then return nil end
  end
  return __transferUnit(unit, a)
end
