-- === Sound-Parameter-Objekte ===
--
-- Beides sind CORE-Globals (scr_CoreInits) — sie stehen in BEIDEN Lua-States,
-- und das ist der Punkt:
--
--   Sound( {cue,bank,cutoff} ) - Make a sound parameters object   Cfile:608456
--   RPCSound( {cue,bank,cutoff} )                                 Cfile:608507
--
-- In der Sim ist `Sound{}` der EINZIGE DSL-Konstruktor in den .bp-Dateien
-- (3445 Vorkommen; fehlt er, bricht die Blueprint-Auswertung mittendrin ab und
-- das bp landet halbfertig unter dem Schluessel 'null'). In der UI baut
-- main.lua:231 damit die Menuemusik. Lag die Definition nur bei den Blueprints,
-- kannte die UI-VM ihn nicht — obwohl die Engine ihn dort genauso registriert.
function Sound(t) return t end
function RPCSound(t) return t end

-- "cue,bank = GetCueBank(params)" (mHelp, Cfile:608558) — eine KERN-Bindung
-- (scr_CoreInits, also beide VMs). Sie zerlegt ein Sound-Objekt in seine beiden
-- Bestandteile. aibrain.lua:924 (PlayVOSound) ruft sie beim Tod jeder Einheit —
-- ohne sie stirbt dort der Thread.
function GetCueBank(sound)
  if type(sound) ~= 'table' then return nil, nil end
  return sound.Cue, sound.Bank
end

-- === MATH_Lerp (Core-Global, Cfile:598170) ===
--
-- mHelp: "MATH_Lerp(s, a, b) or MATH_Lerp(s, sMin, sMax, a, b) -> number".
-- Der Rumpf (Cfile:598228-598258) rechnet:
--
--   3 Argumente:  a + (b - a) * s
--   5 Argumente:  a + (b - a) * ((s - sMin) / (sMax - sMin))
--
-- KEIN Klemmen auf [0,1] — die Engine laesst den Wert ueberschiessen. Wer hier
-- ein math.min/max dazuerfindet, macht die Ein-/Ausblendungen der UI (die genau
-- damit rechnen, effecthelpers.lua:446) an den Raendern falsch.
function MATH_Lerp(s, a, b, c, d)
  if d == nil then
    return a + (b - a) * s
  end
  local sMin, sMax = a, b
  return c + (d - c) * ((s - sMin) / (sMax - sMin))
end

-- === Vektor-Mathematik (cfunc_VDist2/VDist3/…) ===
function VDist2(x1, z1, x2, z2)
  local dx, dz = x1 - x2, z1 - z2
  return math.sqrt(dx * dx + dz * dz)
end
function VDist2Sq(x1, z1, x2, z2)
  local dx, dz = x1 - x2, z1 - z2
  return dx * dx + dz * dz
end
local function vxyz(v)
  if not v then return 0, 0, 0 end
  return v[1] or v.x or 0, v[2] or v.y or 0, v[3] or v.z or 0
end
function VDist3(a, b)
  local ax, ay, az = vxyz(a)
  local bx, by, bz = vxyz(b)
  local dx, dy, dz = ax - bx, ay - by, az - bz
  return math.sqrt(dx * dx + dy * dy + dz * dz)
end
function VDist3Sq(a, b)
  local ax, ay, az = vxyz(a)
  local bx, by, bz = vxyz(b)
  local dx, dy, dz = ax - bx, ay - by, az - bz
  return dx * dx + dy * dy + dz * dz
end
function VAdd(a, b) local ax,ay,az = vxyz(a); local bx,by,bz = vxyz(b); return { ax+bx, ay+by, az+bz } end
function VSub(a, b) local ax,ay,az = vxyz(a); local bx,by,bz = vxyz(b); return { ax-bx, ay-by, az-bz } end
function VDiff(a, b) return VSub(a, b) end
function VMult(a, s) local ax,ay,az = vxyz(a); return { ax*s, ay*s, az*s } end
-- Ein Engine-Vektor traegt BEIDE Zugriffe — und das ist kein Komfort, sondern
-- Voraussetzung: die Original-Lua benutzt wirklich beide Formen.
--
--   aeonweapons.lua:105     VDist2(unitPos[1], unitPos[3], …)     -- Index
--   effectutilities.lua:274 2 * (endVec2.x - endVec1.x)           -- Feld
--
-- Ein Vektor nur mit Indizes laesst jeden Bau-Effekt an "attempt to perform
-- arithmetic on a nil value" sterben (genau das stand im Log).
function Vector(x, y, z)
  return { x or 0, y or 0, z or 0, x = x or 0, y = y or 0, z = z or 0 }
end

function Vector2(x, y)
  return { x or 0, y or 0, x = x or 0, y = y or 0 }
end

-- === Entity-Praedikate (cfunc_IsDestroyed/IsUnit/…) ===
--
-- Die Praedikate muessen die ARTEN unterscheiden, nicht nur „hat ein Blueprint":
-- ein Projektil hat auch eines. Solange IsUnit(projektil) true lieferte, waere
-- jeder Kollisions- und Schadensfilter geraten (unit.lua:934, shield.lua:151).
function IsDestroyed(e)
  if not e then return true end
  if type(e) ~= 'table' then return true end
  return e.__destroyed == true or e.__destroyQueued == true
end
function IsEntity(e) return type(e) == 'table' and e.__id ~= nil end
function IsUnit(e) return type(e) == 'table' and e.__isUnit == true end
function IsProjectile(e) return type(e) == 'table' and e.__isProj == true end
function IsProp(e) return type(e) == 'table' and e.__isProp == true end
-- CollisionBeam-Entities tragen ihre zwei virtuellen Knochen (__beamBones).
function IsCollisionBeam(e) return type(e) == 'table' and e.__beamBones ~= nil end
-- === Alliances (CArmyImpl) ===
-- Each army carries three sets (allies/enemies/neutrals, BVIntSets in
-- ArmyVariableData); IsAlly(a,b) tests b's bit in a's allies set
-- (Moho::IArmy::IsAlly, Cfile:772178-772186). Every army is ally of
-- itself from birth (ctor adds its own index, Cfile:1017297).
__alliances = {}

local function __allianceRow(a)
  local row = __alliances[a]
  if not row then
    row = { allies = { [a] = true }, enemies = {}, neutrals = {} }
    __alliances[a] = row
  end
  return row
end

local function __resolveArmy(x)
  if type(x) == 'number' then
    if x <= 0 then error(string.format('Invalid army %d. (Use a 1-based index)', x)) end
    return x
  end
  error('Unexpected type for army object')
end

local function __setAllianceOneWay(a, b, state)
  -- CArmyImpl::SetAlliance (Cfile:1016642-1016680): set the bit in exactly
  -- one of the three sets, clear it in the other two.
  local row = __allianceRow(a)
  row.allies[b] = nil
  row.enemies[b] = nil
  row.neutrals[b] = nil
  if state == 'Ally' then row.allies[b] = true
  elseif state == 'Enemy' then row.enemies[b] = true
  elseif state == 'Neutral' then row.neutrals[b] = true
  else error('SetAlliance: unknown state ' .. tostring(state)) end
end

--- SetAlliance(army1, army2, <Neutral|Enemy|Ally>) — BOTH directions
--- (cfunc_SetAllianceL, Cfile:1025315-1025360).
function SetAlliance(a, b, state)
  a = __resolveArmy(a)
  b = __resolveArmy(b)
  __setAllianceOneWay(a, b, state)
  __setAllianceOneWay(b, a, state)
end

--- SetAllianceOneWay(army1, army2, state) — only army1's view
--- (Cfile:1025391-1025420).
function SetAllianceOneWay(a, b, state)
  __setAllianceOneWay(__resolveArmy(a), __resolveArmy(b), state)
end

function IsAlly(a, b) return __allianceRow(__resolveArmy(a)).allies[__resolveArmy(b)] == true end
function IsEnemy(a, b) return __allianceRow(__resolveArmy(a)).enemies[__resolveArmy(b)] == true end
function IsNeutral(a, b) return __allianceRow(__resolveArmy(a)).neutrals[__resolveArmy(b)] == true end

-- === Random (Cfile:758FB0) ===
-- Ohne Argument ein Float [0,1), sonst wie math.random. config.lua:43 setzt
-- `math.random = Random` — die Sim wuerfelt also ueber die Engine (im Original
-- deterministisch fuer alle Clients; unsere Sim ist noch nicht lockstep).
--
-- Ohne dieses Global stirbt jeder Todes-Thread: unit.lua:1200 DeathThread ruft
-- GetRandomFloat (utils.lua) -> Random().
--
-- ACHTUNG: config.lua:42 setzt spaeter `math.random = Random`. Im Original ist
-- Random eine C-Bindung — hier ist es Lua, und wer dann ueber `math.random`
-- geht, ruft SICH SELBST (endlose Tail-Rekursion: die VM haengt, kein
-- Stack-Overflow). Also das echte math.random VOR dem Alias festhalten.
local mathRandom = math.random
function Random(a, b)
  if a == nil then return mathRandom() end
  if b == nil then return mathRandom(1, math.floor(a)) end
  return mathRandom(math.floor(a), math.floor(b))
end

-- Warp(unit, location, [orientation]) — eine Entity SOFORT versetzen
-- (mHelp Cfile:1089605). Die Explosions-Entities werden so an den Ort des Todes
-- gesetzt (defaultexplosions.lua:121); ohne Warp stirbt der Todes-Thread.
function Warp(entity, location, orientation)
  if not entity then return end
  local p = __vec3(location)
  entity.__pos = { p[1], p[2], p[3] }
  if orientation then entity.__orient = orientation end
end

-- === Physik-Konstanten der Sim (Moho::SPhysConstants) ===
-- Der Ctor setzt mGravity = { 0, -4.9, 0 } (Cfile:699A90 / sub_699A90:
-- result[1] = -1063465779 = float -4.9). Daran haengt JEDE ballistische
-- Flugbahn — ein geschaetzter Wert waere ein anderes Spiel.
__simGravity = 4.9

-- Der Wasserspiegel der geladenen Karte (aus der .scmap). Ohne Karte: kein
-- Wasser.
__mapWaterLevel = 0
function __setWaterLevel(y) __mapWaterLevel = y or 0 end

-- === Kategorie-System (EntityCategory, categories, ParseEntityCategory) ===
-- Eine EntityCategory ist ein Ausdrucksbaum ueber Kategorie-Tokens; getestet
-- wird gegen die Categories-Liste des Blueprints (wie EntityCategoryContains).
local CatMeta = {}
local function mkcat(kind, a, b) return setmetatable({ __cat = true, kind = kind, a = a, b = b }, CatMeta) end
CatMeta.__add = function(x, y) return mkcat('or', x, y) end
CatMeta.__mul = function(x, y) return mkcat('and', x, y) end
CatMeta.__sub = function(x, y) return mkcat('sub', x, y) end
CatMeta.__index = CatMeta

local function catTest(c, set)
  if type(c) ~= 'table' or not c.__cat then return false end
  local k = c.kind
  if k == 'tok' then return set[c.a] == true end
  if k == 'or' then return catTest(c.a, set) or catTest(c.b, set) end
  if k == 'and' then return catTest(c.a, set) and catTest(c.b, set) end
  if k == 'sub' then return catTest(c.a, set) and not catTest(c.b, set) end
  if k == 'all' then return true end
  return false
end

categories = setmetatable({}, {
  __index = function(t, k)
    local c = mkcat('tok', k)
    rawset(t, k, c)
    return c
  end,
})
categories.ALLUNITS = mkcat('all')

-- ParseEntityCategory('BUILTBYCOMMANDER UEF'): Leerzeichen = UND (wie in den
-- Blueprint-BuildableCategory-Termen); '+'/'-'/'*' werden ebenfalls erkannt.
function ParseEntityCategory(expr)
  if type(expr) ~= 'string' then return expr end
  local cur = nil
  local op = 'and'
  for tok in string.gmatch(expr, '%S+') do
    if tok == '+' then op = 'or'
    elseif tok == '-' then op = 'sub'
    elseif tok == '*' then op = 'and'
    else
      local c = categories[tok]
      if not cur then cur = c
      elseif op == 'or' then cur = cur + c
      elseif op == 'sub' then cur = cur - c
      else cur = cur * c end
      op = 'and'
    end
  end
  return cur or mkcat('all')
end

local function bpCategorySet(bp)
  local set = {}
  if bp and bp.Categories then
    for _, c in ipairs(bp.Categories) do set[c] = true end
  end
  return set
end

-- Das Blueprint hinter einem Kategorie-Argument. Die Engine prueft Kategorien
-- auf ALLEN Objektarten (cfunc_EntityCategoryContains): Sim-Entities, die
-- UserUnit-Spiegel der UI und nackte Blueprint-Tabellen. Diese Datei laeuft in
-- BEIDEN VMs — die Sim-Pfade (__bp) bleiben unangetastet, __registered.Unit
-- ist in beiden VMs dieselbe Ablage (uiEngine.ts aliast __blueprints darauf).
local function entityBp(e)
  if type(e) == 'table' then
    -- Sim-Entity: traegt ihr Blueprint direkt.
    if e.__bp then return e.__bp end
    -- UI-UserUnit (der Sim-Spiegel aus ui-globals.lua): traegt nur die ID.
    if e.blueprintId then return __registered and __registered.Unit[e.blueprintId] end
    -- Eine Blueprint-TABELLE selbst (Rueckgabe von GetBlueprint()).
    if e.Categories then return e end
  end
  if type(e) == 'string' then return __registered and __registered.Unit[string.lower(e)] end
  return nil
end

function EntityCategoryContains(cat, e)
  local bp = entityBp(e)
  if not bp then
    -- auch ein Blueprint-Name ist erlaubt
    if type(e) == 'string' and __registered then bp = __registered.Unit[string.lower(e)] end
  end
  if not bp or not cat then return false end
  if type(cat) == 'string' then cat = ParseEntityCategory(cat) end
  return catTest(cat, bpCategorySet(bp))
end

function EntityCategoryFilterDown(cat, list)
  local out = {}
  local n = 0
  for _, e in ipairs(list or {}) do
    if EntityCategoryContains(cat, e) then n = n + 1; out[n] = e end
  end
  return out
end
function EntityCategoryFilterOut(cat, list)
  local out = {}
  local n = 0
  for _, e in ipairs(list or {}) do
    if not EntityCategoryContains(cat, e) then n = n + 1; out[n] = e end
  end
  return out
end
function EntityCategoryCount(cat, list)
  local n = 0
  for _, e in ipairs(list or {}) do if EntityCategoryContains(cat, e) then n = n + 1 end end
  return n
end
function EntityCategoryEmpty(cat, list)
  return EntityCategoryCount(cat, list) == 0
end

-- Alle registrierten Blueprint-IDs, die die Kategorie erfuellen.
function EntityCategoryGetUnitList(cat)
  local out = {}
  local n = 0
  if type(cat) == 'string' then cat = ParseEntityCategory(cat) end
  if __registered and __registered.Unit then
    for id, bp in pairs(__registered.Unit) do
      if catTest(cat, bpCategorySet(bp)) then n = n + 1; out[n] = id end
    end
  end
  table.sort(out)
  return out
end

-- === Manipulatoren (CreateRotator/CreateSlider/… ) ===
-- Im Original C++-Objekte, die die Unit im Trash sammelt (brauchen :Destroy()).
local ManipMeta = {}
ManipMeta.__index = ManipMeta
function ManipMeta:SetGoal(...) self.__goal = { ... }; return self end
function ManipMeta:SetSpeed(s) self.__speed = s; return self end
function ManipMeta:SetTargetSpeed(s) self.__targetSpeed = s; return self end
function ManipMeta:SetAccel(a) self.__accel = a; return self end
function ManipMeta:SetPrecedence(p) self.__precedence = p; return self end
function ManipMeta:SetSpinDown(v) self.__spinDown = v; return self end
-- unit.lua:1660 dokumentiert die Signatur selbst:
-- BuilderArmManipulator:SetAimingArc(minHeading, maxHeading, headingMaxSlew, minPitch, maxPitch, pitchMaxSlew)
function ManipMeta:SetAimingArc(minH, maxH, slewH, minP, maxP, slewP)
  self.__arc = { minH, maxH, slewH, minP, maxP, slewP }
  return self
end
-- CAimManipulator: der Turm einer Waffe. weapon.lua:139 setzt seinen Schwenk-
-- und Neigungsbereich aus dem Blueprint (TurretYawMin/Max/Speed,
-- TurretPitchMin/Max/Speed) — dieselben sechs Zahlen wie beim BuilderArm, nur
-- unter dem Namen, den die Engine fuer Waffen fuehrt.
function ManipMeta:SetFiringArc(minH, maxH, slewH, minP, maxP, slewP)
  self.__arc = { minH, maxH, slewH, minP, maxP, slewP }
  return self
end
function ManipMeta:SetEnabled(on) self.__enabled = on ~= false; return self end
-- Zeit, bis der Turm ohne Ziel in die Ruhelage zurueckschwenkt (weapon.lua:94:
-- Gebaeude bekommen 9999999 — sie schwenken nie zurueck).
function ManipMeta:SetResetPoseTime(t) self.__resetPoseTime = t; return self end
function ManipMeta:SetHeadingPitch(h, p) self.__heading = h; self.__pitch = p; return self end
function ManipMeta:GetHeadingPitch() return self.__heading or 0, self.__pitch or 0 end
-- CAnimationManipulator (decomp: cfunc_CAnimationManipulatorPlayAnim).
function ManipMeta:PlayAnim(anim, loop)
  self.__anim = anim
  self.__loop = loop == true
  self.__animTime = 0
  return self
end
function ManipMeta:SetAnimationFraction(fr) self.__animFraction = fr; return self end
function ManipMeta:GetAnimationFraction() return self.__animFraction or 0 end
function ManipMeta:SetRate(r) self.__rate = r; return self end
function ManipMeta:GetAnimationTime() return self.__animTime or 0 end
function ManipMeta:SetBoneEnabled(bone, on) return self end
function ManipMeta:ClearGoal() self.__goal = nil; return self end
function ManipMeta:Disable() self.__enabled = false; return self end
function ManipMeta:Enable() self.__enabled = true; return self end
function ManipMeta:Destroy() self.__destroyed = true end
function ManipMeta:IsDestroyed() return self.__destroyed == true end
function ManipMeta:GetGoal() return self.__goal end
-- WaitFor(manipulator) blocks until the manipulator reached its goal. There is
-- no bone animation system yet, so a manipulator is done the moment it is set;
-- once bones animate, this reports real progress instead.
function ManipMeta:IsDone() return true end

local function newManipulator(kind, unit, bone)
  return setmetatable({ __kind = kind, __unit = unit, __bone = bone, __enabled = true }, ManipMeta)
end
function CreateRotator(unit, bone, axis) return newManipulator('rotator', unit, bone) end
function CreateSlider(unit, bone) return newManipulator('slider', unit, bone) end
function CreateAnimator(unit) return newManipulator('animator', unit) end
function CreateBuilderArmController(unit, bone) return newManipulator('builderarm', unit, bone) end
function CreateThrustController(unit, bone) return newManipulator('thrust', unit, bone) end

-- SetFiringArc(yawMin, yawMax, yawSpeed, pitchMin, pitchMax, pitchSpeed) —
-- weapon.lua:150 hands center±halfRange in DEGREES; the engine stores the
-- centered arc (CAimManipulator: mMinHeading = arc center, mMaxHeading =
-- half range) and converts speeds to rad/tick with kSlewScale
-- (slew = deg/s * DEG2RAD * 0.1, CAimManipulator.cpp:1197-1206).
function ManipMeta:SetFiringArc(yawMin, yawMax, yawSpeed, pitchMin, pitchMax, pitchSpeed)
  local d2r = 0.017453292
  self.__yawCenter = (yawMin + yawMax) * 0.5 * d2r
  self.__yawRange = math.abs(yawMax - yawMin) * 0.5 * d2r
  self.__yawSlew = (yawSpeed or 0) * d2r * 0.1
  self.__pitchCenter = (pitchMin + pitchMax) * 0.5 * d2r
  self.__pitchRange = math.abs(pitchMax - pitchMin) * 0.5 * d2r
  self.__pitchSlew = (pitchSpeed or 0) * d2r * 0.1
  return self
end

--- CreateAimController(weapon, label, yawBone, [pitchBone], [muzzleBone]) —
--- the REAL signature (weapon.lua:63). The manipulator carries the turret
--- state the aim tick advances (weapons.lua __aimTick): current yaw/pitch
--- relative to the rest pose and the on-target flag that gates the fire
--- task (weapon->mCanFire, CAimManipulator::Track, weapons.md par. 2c).
function CreateAimController(weapon, label, yawBone, pitchBone, muzzleBone)
  local m = newManipulator('aim', weapon and weapon.__unit or nil, yawBone)
  m.__weapon = weapon
  m.__label = label
  m.__yawBone = yawBone
  m.__pitchBone = pitchBone
  m.__muzzleBone = muzzleBone
  m.__yaw = 0
  m.__pitch = 0
  m.__onTarget = false
  if weapon then weapon.__aim = m end
  return m
end

-- CollisionDetector: Engine-Objekt, das Bones auf Bodenkontakt ueberwacht
-- (unit.lua:2660 CreateCollisionDetector(self) -> :WatchBone(bone); landet im
-- Trash, braucht also Destroy()). Fussstapfen-/Aufschlag-Effekte haengen daran.
local DetectorMeta = {}
DetectorMeta.__index = DetectorMeta
function DetectorMeta:WatchBone(bone)
  self.bones[#self.bones + 1] = bone
  return self
end
function DetectorMeta:Enable() self.__enabled = true; return self end
function DetectorMeta:Disable() self.__enabled = false; return self end
function DetectorMeta:Destroy() self.__destroyed = true end
function CreateCollisionDetector(unit)
  return setmetatable({ __unit = unit, bones = {}, __enabled = true }, DetectorMeta)
end
function CreateFootPlantController(unit, footBone, kneeBone, hipBone, straightLegs, maxFootFall)
  return newManipulator('footplant', unit, footBone)
end

-- === Armeen / Brains ===
-- GetArmyBrain(army) ist ein echtes Engine-Global (defaultunits.lua:442 u. a.).
-- Als Stub lieferte es die Identitaet — also die ARMEE-ZAHL statt des Brains,
-- worauf defaultunits.lua:443 eine Zahl indizierte.
function GetArmyBrain(army) return __getBrain(army) end
-- brain:GetListOfUnits(cat, needToBeIdle) -> living units of that army.
function __armyUnits(army, cat)
  local out = {}
  local n = 0
  for _, u in pairs(__units or {}) do
    if u.__army == army and not u.__destroyed then
      if not cat or EntityCategoryContains(cat, u) then n = n + 1; out[n] = u end
    end
  end
  return out
end
__focusArmy = 1
function GetFocusArmy() return __focusArmy end
function SetFocusArmy(a) __focusArmy = a end

-- Sim-Global: Enhancements je Entity-Id. Die Sim fuellt es, die UI liest es
-- ueber Sync.UserUnitEnhancements (simuistate.lua:44). unit.lua:576/2085
-- indizieren es ungeprueft, es muss also immer eine Tabelle sein.
SimUnitEnhancements = {}

-- _c_CreateEntity(self, spec): der C-Konstruktor hinter Entity (entity.lua:11).
-- Er verwandelt die Lua-Tabelle in eine Engine-Entity — Id, Armee, Position.
__nextEntityId = 1000000
function _c_CreateEntity(self, spec)
  spec = spec or {}
  self.__id = __nextEntityId
  __nextEntityId = __nextEntityId + 1
  self.__army = spec.Army or spec.army or -1
  self.__pos = spec.Position or { 0, 0, 0 }
  self.__orient = spec.Orientation or { 0, 0, 0, 1 }
  self.__bp = spec.Blueprint or spec.bp
  self.__owner = spec.Owner
  return self
end

-- === Effekt-Emitter (CreateAttachedEmitter / CreateEmitterAtBone …) ===
-- Engine objects for particle effects. The Lua chains calls on them
-- (defaultunits.lua:189 :OffsetEmitter(...)), collects them in TrashBags and
-- expects :Destroy(). The renderer will consume __emitters later; for now they
-- are honest state carriers, not identity stubs.
local EmitterMeta = {}
EmitterMeta.__index = EmitterMeta
function EmitterMeta:OffsetEmitter(x, y, z) self.__offset = { x, y, z }; return self end
function EmitterMeta:ScaleEmitter(s) self.__scale = s; return self end
function EmitterMeta:SetEmitterParam(p, v) self.__params[p] = v; return self end
function EmitterMeta:SetEmitterCurveParam(p, a, b) self.__params[p] = { a, b }; return self end
function EmitterMeta:SetAmbientSound(a, b) return self end
function EmitterMeta:SetSoftness(s) self.__softness = s; return self end
function EmitterMeta:Enable() self.__enabled = true; return self end
function EmitterMeta:Disable() self.__enabled = false; return self end
function EmitterMeta:Destroy() self.__destroyed = true end
function EmitterMeta:IsDestroyed() return self.__destroyed == true end

__emitters = {}
__nextEmitterId = 1
local function newEmitter(owner, bone, army, spec)
  local e = setmetatable({
    __owner = owner, __bone = bone, __army = army, __spec = spec,
    __params = {}, __enabled = true,
    __id = __nextEmitterId, __born = __gameTick or 0,
  }, EmitterMeta)
  __nextEmitterId = __nextEmitterId + 1
  __emitters[#__emitters + 1] = e
  return e
end

--- Der Zustand aller lebenden Emitter als JSON — der Renderer (Partikelsystem)
--- zeichnet sie. Die Weltposition rechnet die SIM (Owner + Knochen,
--- __boneWorld) — der Renderer kennt die Skelette nicht. Zerstoerte Emitter
--- und Emitter toter Owner werden dabei aus der Liste kompaktiert.
--- (String statt Rueckgabetabelle — wasmoon-Registry, siehe units.lua.)
function __readAllEmittersJson()
  local parts, n = {}, 0
  local kompakt, k = {}, 0
  for _, e in ipairs(__emitters) do
    local o = e.__owner
    local lebt = not e.__destroyed and o ~= nil and not o.__destroyed and not o.__destroyQueued
    if lebt then
      k = k + 1
      kompakt[k] = e
      -- Position UND Rotation des Knochens: LocalVelocity/LocalAcceleration
      -- drehen die Spawn-Richtungen EINMALIG beim Spawn in den Bone-Raum
      -- (CEfxEmitter::Tick, Cfile:894849-894859) — dafuer braucht der
      -- Spawner die Bone-Orientierung, nicht nur den Ort.
      local pos, rot = __boneWorld(o, e.__bone)
      local off = e.__offset
      -- Beam-Emitter mit zweitem Ende (AttachBeamEntityToEntity): die
      -- Zielposition wandert mit — stirbt das Ziel, endet der Beam
      -- (CEfxBeam::Update prueft die Attachments genauso).
      local zwei = ''
      local other = e.__other
      if other and not other.__destroyed and not other.__destroyQueued then
        local p2 = __boneWorld(other, e.__otherBone)
        zwei = string.format(',"x2":%.6g,"y2":%.6g,"z2":%.6g', p2[1], p2[2], p2[3])
      elseif other then
        -- Ziel weg -> Beam-Emitter ist tot (im Original zerstoert ihn Update).
        e.__destroyed = true
      end
      n = n + 1
      parts[n] = string.format(
        '{"id":%d,"bp":%q,"x":%.6g,"y":%.6g,"z":%.6g,"qw":%.6g,"qx":%.6g,"qy":%.6g,"qz":%.6g,"scale":%.6g,"born":%d,"enabled":%s%s%s}',
        e.__id, tostring(e.__spec), pos[1], pos[2], pos[3],
        rot[1], rot[2], rot[3], rot[4],
        e.__scale or 1, e.__born, tostring(e.__enabled == true),
        off and string.format(',"ox":%.6g,"oy":%.6g,"oz":%.6g', off[1] or 0, off[2] or 0, off[3] or 0) or '',
        zwei
      )
    end
  end
  __emitters = kompakt
  return '[' .. table.concat(parts, ',') .. ']'
end
function CreateAttachedEmitter(owner, bone, army, spec) return newEmitter(owner, bone, army, spec) end
function CreateEmitterAtBone(owner, bone, army, spec) return newEmitter(owner, bone, army, spec) end
function CreateEmitterAtEntity(owner, army, spec) return newEmitter(owner, -1, army, spec) end
function CreateEmitterOnEntity(owner, army, spec) return newEmitter(owner, -1, army, spec) end
-- CreateTrail(owner, bone, army, spec) — die Polytrail-Spur eines Projektils
-- (defaultprojectiles.lua:78/100/104 haengt sie ungeprueft an und ruft danach
-- :OffsetEmitter() darauf). Ohne Rueckgabewert stirbt jedes Projektil in seinem
-- eigenen OnCreate.
function CreateTrail(owner, bone, army, spec) return newEmitter(owner, bone, army, spec) end
-- "CreateBeamEmitter(blueprint, army)" (EffectLuaStartupRegistrations,
-- effects-audio.md — KEIN Owner-Argument!): erzeugt den sichtbaren
-- Beam-Effekt frei; AttachBeamToEntity haengt ihn an (CollisionBeam.lua:111f).
function CreateBeamEmitter(spec, army) return newEmitter(nil, -1, army, spec) end

-- "AttachBeamToEntity(emitter, entity, tobone, army)": haengt einen
-- EXISTIERENDEN Beam-Emitter an eine Entity. Bei CollisionBeam-Entities
-- spannt der Strahl von Bone 0 (Anfang) zu Bone 1 (Treffpunkt) — beide an
-- derselben Entity; die Emitter-Meldung traegt dann x2/y2/z2 mit, und der
-- Beam-Renderer zeichnet Muendung -> Einschlag.
function AttachBeamToEntity(emitter, entity, tobone, army)
  emitter.__owner = entity
  emitter.__bone = tobone or 0
  if entity and entity.__beamBones then
    emitter.__other = entity
    emitter.__otherBone = 1
  end
  return emitter
end
function CreateBeamEmitterOnEntity(owner, bone, army, spec) return newEmitter(owner, bone, army, spec) end
-- Beam ZWISCHEN zwei Entities (CEfxBeam::AttachEntityToEntity @0x655B50):
-- Start = sourceBone, Ende = targetBone — der Bau-Strahl der Ingenieure
-- (build_beam_01, EffectUtilities) haengt genau so zwischen Bauer und
-- Baustelle. Der zweite Endpunkt wandert mit in die Emitter-Meldung.
function AttachBeamEntityToEntity(a, ab, b, bb, army, spec)
  local e = newEmitter(a, ab, army, spec)
  e.__other = b
  e.__otherBone = bb
  return e
end
function CreateLightParticle(owner, bone, army, size, life, tex, ramp) end
function CreateLightParticleIntel(owner, bone, army, size, life, tex, ramp) end
function CreateSplat(pos, heading, tex, sx, sz, lod, life, army) return newEmitter(nil, -1, army, tex) end
function CreateDecal(pos, heading, tex1, tex2, type, sx, sz, lod, life, army) return newEmitter(nil, -1, army, tex1) end

-- === Economy events (CreateEconomyEvent / WaitFor) ===
-- unit.lua:3599 (teleport drain) and defaultweapons.lua:143 (overcharge) buy a
-- timed resource drain: CreateEconomyEvent(unit, energy, mass, time, callback).
-- It is an economy CONSUMER just like a build task, so it goes through the same
-- two-ratio distribution — if the army stalls, the event simply takes longer.
__econEvents = {}
__nextEconEventId = 1

local EventMeta = {}
EventMeta.__index = EventMeta
function EventMeta:IsDone() return self.progress >= 1.0 end
function EventMeta:GetProgress() return self.progress end
function EventMeta:Destroy()
  self.destroyed = true
  __econEvents[self.id] = nil
  __econClearBuildRequest(self.army, self.id)
end

function CreateEconomyEvent(entity, energy, mass, time, callback)
  local ticks = math.max(1, math.floor((time or 1) * 10))
  local ev = setmetatable({
    -- Negative ids: economy events and build tasks share the consumer table.
    id = -__nextEconEventId,
    army = (entity and entity.__army) or 1,
    massPerTick = (mass or 0) / ticks,
    energyPerTick = (energy or 0) / ticks,
    ticksLeft = ticks,
    totalTicks = ticks,
    progress = 0,
    callback = callback,
    entity = entity,
  }, EventMeta)
  __nextEconEventId = __nextEconEventId + 1
  __econEvents[ev.id] = ev
  return ev
end

function RemoveEconomyEvent(entity, ev)
  if ev then ev:Destroy() end
end

-- Phase 1 of the beat: register demand. Phase 2: apply the granted rate.
function __econEventsCollect()
  for id, ev in pairs(__econEvents) do
    if not ev.destroyed and ev.progress < 1.0 then
      __econSetBuildRequest(ev.army, id, ev.massPerTick, ev.energyPerTick)
    end
  end
end

function __econEventsApply()
  for id, ev in pairs(__econEvents) do
    if not ev.destroyed and ev.progress < 1.0 then
      local rate = __econBuildRate(ev.army, id)
      ev.progress = math.min(1.0, ev.progress + rate / ev.totalTicks)
      if ev.callback then ev.callback(ev.entity, ev.progress) end
      if ev.progress >= 1.0 then __econClearBuildRequest(ev.army, id) end
    end
  end
end

-- WaitFor(obj): suspend the calling thread until the object reports done.
-- Used on economy events and on manipulators (aeonweapons.lua:138).
function WaitFor(obj)
  if type(obj) ~= 'table' or not obj.IsDone then return end
  while not obj:IsDone() do
    coroutine.yield(1)
  end
end

-- === Buff-Blueprints (BuffBlueprint{...}) ===
__buffs = {}
function BuffBlueprint(spec)
  if type(spec) == 'table' and spec.Name then __buffs[spec.Name] = spec end
  return spec
end

-- === Datei-/Pfad-Helfer ===
-- DiskToLocal steht in boot.lua (Kern, beide VMs): es nimmt den /mod-Praefix des
-- Hosts wieder weg. Blueprints.lua leitet daraus die BlueprintId ab.
function DiskGetFileInfo(path) return false end

-- === Terrain ===
-- The engine feeds this from the loaded map (setTerrainSource). Without a map
-- it must FAIL, not quietly answer 0: the original Lua reads GetSurfaceHeight
-- for layer changes (land/water), amphibious movement and effects, and a silent
-- 0 makes every one of those decisions wrong while looking fine. A test that
-- wants flat ground says so explicitly.
__terrainHeight = false
function GetTerrainHeight(x, z)
  if not __terrainHeight then
    error('GetTerrainHeight: no terrain loaded — the engine must call setTerrainSource()', 2)
  end
  return __terrainHeight(x, z)
end
function GetSurfaceHeight(x, z) return GetTerrainHeight(x, z) end

-- GetTerrainType(x, z) returns a terrain-type record from TerrainTypes
-- (lua/terraintypes.lua:126, a global list whose first entry is 'Default').
-- The original Lua indexes the result without checking (unit.lua:2420) and
-- explicitly asks for the default with (-1, -1) (unit.lua:2421). Until a map
-- with a terrain-type layer is loaded, every position is the default type.
function GetTerrainType(x, z)
  return TerrainTypes and TerrainTypes[1]
end

-- === Befehle an Units (sim_SimInits) ===
--
-- Die Sim-Lua erteilt selbst Befehle: FactoryUnit.RollOffUnit (defaultunits.lua:571)
-- schickt die frisch gebaute Einheit mit IssueMove vom Hof. Die Befehle laufen
-- ueber denselben Navigator, den auch ein Spielerbefehl benutzt — es gibt keinen
-- zweiten Bewegungspfad.
--
-- Rueckgabe ist ein Kommando-Objekt; die Lua haelt es (self.MoveCommand) und
-- kann es spaeter loeschen.
__nextCommand = 1

local function issueTo(units, apply)
  local cmd = { id = __nextCommand, units = {} }
  __nextCommand = __nextCommand + 1
  for _, u in ipairs(units or {}) do
    if u then
      apply(u)
      cmd.units[table.getn(cmd.units) + 1] = u
    end
  end
  return cmd
end

function IssueMove(units, pos)
  return issueTo(units, function(u)
    u:GetNavigator():SetGoal({ pos[1], pos[2] or 0, pos[3] })
  end)
end

--- IsCommandDone(command) -> true, wenn der Befehl abgearbeitet ist
--- (cfunc_IsCommandDoneL, Cfile:1007814: die Engine prueft, ob der
--- CUnitCommandOpt noch existiert — `pushboolean(opt == 0)`).
---
--- Die FABRIK haengt daran: defaultunits.lua:643 (RolloffBody) wartet in einer
--- Schleife, bis die frisch gebaute Einheit vom Hof gefahren ist —
--- `while ... and self.MoveCommand and not IsCommandDone(self.MoveCommand) do`.
--- Fehlt das Global, stirbt der Thread, die Fabrik bleibt BUSY und baut nie
--- wieder etwas. Genau so sah es im Browser aus.
---
--- Fertig ist der Befehl, wenn keine Einheit mehr ein Ziel hat.
function IsCommandDone(cmd)
  if not cmd or not cmd.units then return true end
  for _, u in ipairs(cmd.units) do
    if u and not u.__destroyQueued and u.__goal then return false end
  end
  return true
end

function IssueStop(units)
  return issueTo(units, function(u) __dispatchStop(u.__id) end)
end

function IssueClearCommands(units)
  return issueTo(units, function(u) __dispatchStop(u.__id) end)
end

-- === Befehls-Dispatch (IAiCommandDispatchImpl::DispatchTask @0x608EF0) ===
--
-- Ein NEUER Befehl ohne Shift ERSETZT die Arbeit einer Unit: der laufende
-- Bau bricht mit der vollen Kette ab (__abortBuildTasks, Cfile:814989),
-- die Attack-Order faellt weg, das Bewegungsziel wird neu gesetzt. Genau
-- daran hing der Nutzer-Befund "bauende Einheiten lassen sich nicht
-- wegbewegen": ohne Task-Abbruch setzte approach() (build.lua) das
-- Fahrziel jeden Beat aufs Bau-Ziel zurueck.
__attackOrders = {}

-- === Command queue (CUnitCommandQueue) ===
-- UNIT_IssueCommand (Cfile:1007498-1007610): clear=true wipes the queue
-- FIRST (ClearCommandQueue) and aborts the running task, then appends;
-- clear=false only APPENDS — a plain insert does NOT interrupt the running
-- order (UCQS_CommandInserted only updates speed, sim-core.md:255-258).
-- Queue cap 500 (Cfile:1007566). The dispatcher consumes only the queue
-- head and pops it on completion (TaskTick, sim-core.md:211-252).
-- Engineer BUILD orders keep their own proven chain in build.lua (its
-- per-builder queue IS the shift-build path); a mixed shift train of
-- moves and builds is a documented gap.
__orders = {}      -- unitId -> FIFO of pending commands
__orderActive = {} -- unitId -> command currently driving the unit

local function __abortActive(unitId)
  local u = __units[unitId]
  if not u then return end
  __abortBuildTasks(unitId)
  __attackOrders[unitId] = nil
  __guardOrders[unitId] = nil
  __reclaimTasks[unitId] = nil
  u.__guardedUnit = false
  u:GetNavigator():AbortMove()
end

--- Start one command through the existing single-order mechanisms.
local function __startOrder(unitId, cmd)
  local u = __units[unitId]
  if not u then return false end
  if cmd.type == 'Move' then
    u:GetNavigator():SetGoal({ cmd.x, 0, cmd.z })
    return true
  elseif cmd.type == 'Patrol' then
    -- One patrol leg IS a move: CUnitPatrolTask sets exactly one nav goal
    -- (TaskTick, Cfile:845598-845601); the LOOP lives in the queue's ring
    -- rotation, not in the task.
    u:GetNavigator():SetGoal({ cmd.x, 0, cmd.z })
    return true
  elseif cmd.type == 'Attack' then
    if cmd.gx then
      -- Ground attack: the SAME task with an AITARGET_Ground target.
      -- CAiTarget::HasTarget returns true for Ground (Cfile:800284) and
      -- NoTarget stays false without an entity (Cfile:800519) — the order
      -- never completes on its own (task sleeps in TASKSTATE_Complete).
      __attackOrders[unitId] = { cmd.gx, GetSurfaceHeight(cmd.gx, cmd.gz), cmd.gz }
      return true
    end
    local t = __units[cmd.target]
    if not t or t.__destroyed then return false end
    __attackOrders[unitId] = cmd.target
    return true
  elseif cmd.type == 'Repair' then
    local t = __units[cmd.target]
    if not t or t.__destroyed then return false end
    if (t.__fraction or 1) >= 1 and (t.__health or 0) >= t:GetMaxHealth() then
      return false -- nothing to repair (TaskTick -1, Cfile:817856-817875)
    end
    __issueBuildTask(unitId, cmd.target, 'Repair', true)
    return true
  elseif cmd.type == 'Reclaim' then
    local t = __props[cmd.target]
    if not t or t.__destroyed or t.__destroyQueued then return false end
    __reclaimTasks[unitId] = { target = cmd.target, started = false }
    return true
  elseif cmd.type == 'Guard' then
    return __guardStart(unitId, cmd.target)
  end
  return false
end

--- Pop the queue head and start it; skips commands that fail to start.
function __ordersAdvance(unitId)
  local q = __orders[unitId]
  if not q then return end
  while q[1] do
    local cmd = table.remove(q, 1)
    if __startOrder(unitId, cmd) then
      __orderActive[unitId] = cmd
      return
    end
  end
  __orderActive[unitId] = nil
end

--- The queue insert (UNIT_IssueCommand, Cfile:1007575-1007589).
__orderSerial = 0
function __issueOrder(unitId, cmd, clear)
  if clear == nil then clear = true end -- IssueUnitCommand default (Cfile:1265640)
  local u = __units[unitId]
  if not u then return end
  local q = __orders[unitId]
  if not q then
    q = {}
    __orders[unitId] = q
  end
  if clear then
    __abortActive(unitId)
    for i = #q, 1, -1 do q[i] = nil end
    __orderActive[unitId] = nil
  elseif #q >= 500 then
    return -- queue cap (Cfile:1007566-1007569)
  end
  -- mInstanceSerial: every command gets an increasing stamp; the patrol
  -- insertion rule below needs it after the ring has rotated.
  __orderSerial = __orderSerial + 1
  cmd.serial = __orderSerial
  -- AddCommandToQueue patrol rule (CUnitCommandQueue.cpp:446, sim-core.md
  -- :208-209): a new Patrol appended while the HEAD is Patrol and more
  -- than one command exists goes BEFORE the element with the smallest
  -- serial — keeps the loop in original order after rotation.
  local head = __orderActive[unitId] or q[1]
  local inserted = false
  if not clear and cmd.type == 'Patrol' and head and head.type == 'Patrol' then
    -- Find the waiting element with the smallest serial; if it is older
    -- than the RUNNING command, the ring has rotated and the new point
    -- goes before it (else appending is cyclically equivalent).
    local activeSerial = __orderActive[unitId] and (__orderActive[unitId].serial or 0) or math.huge
    local at, smallest = nil, nil
    for i, e in ipairs(q) do
      if smallest == nil or (e.serial or 0) < smallest then
        smallest, at = e.serial or 0, i
      end
    end
    if at and smallest < activeSerial then
      table.insert(q, at, cmd)
      inserted = true
    end
  end
  if not inserted then q[#q + 1] = cmd end
  -- The engine starts the head on the next TaskTick; with nothing active
  -- we start it now (same beat).
  if not __orderActive[unitId] then __ordersAdvance(unitId) end
end

--- Patrol engagement (CUnitPatrolTask::FindTarget, Cfile:845090-845235):
--- the best enemy within bp.AI.GuardScanRadius becomes a full attack
--- subtask (Cfile:845567-845585). DEVIATION: the original iterates the
--- unit's recon blips (mBlipsInRange) — our sim has no intel system yet,
--- so we scan units directly.
local function patrolFindEnemy(u)
  if not u.__weapons or not u.__weapons[1] then return nil end
  local radius = (u.__bp and u.__bp.AI and u.__bp.AI.GuardScanRadius) or 25
  local p = u.__pos
  local best, bestD2 = nil, radius * radius
  for id, other in pairs(__units) do
    if not other.__dead and not other.__destroyQueued and not other.__beingBuilt
      and IsEnemy(u.__army or 1, other.__army or 1) then
      local q = other.__pos
      local dx, dz = q[1] - p[1], q[3] - p[3]
      local d2 = dx * dx + dz * dz
      if d2 <= bestD2 then best, bestD2 = id, d2 end
    end
  end
  return best
end

--- Per-beat completion detection: pop the head when its work is done and
--- start the next queued command (TaskTick RemoveFirstCommandFromQueue).
function __ordersTick()
  for unitId, cmd in pairs(__orderActive) do
    local u = __units[unitId]
    if not u or u.__destroyed then
      __orders[unitId] = nil
      __orderActive[unitId] = nil
    else
      local done = false
      if cmd.type == 'Move' then
        done = not u.__goal -- motion.lua sets __goal = false on arrival
      elseif cmd.type == 'Patrol' then
        -- Engage on the way; otherwise the leg completes inside the 1x1
        -- goal cell (the task's SNavGoal box, Cfile:845637-845650) and a
        -- navigator idle AWAY from it (after a kill) re-issues the goal
        -- (TaskTick idle path, Cfile:845598-845601).
        if not __attackOrders[unitId] then
          local enemy = patrolFindEnemy(u)
          if enemy then
            __attackOrders[unitId] = enemy
          else
            local p = u.__pos
            local dx, dz = cmd.x - p[1], cmd.z - p[3]
            if dx * dx + dz * dz <= 1.0 then
              done = true
            elseif not u.__goal then
              u:GetNavigator():SetGoal({ cmd.x, 0, cmd.z })
            end
          end
        end
      elseif cmd.type == 'Attack' then
        done = __attackOrders[unitId] == nil -- __attackTick clears dead targets
      elseif cmd.type == 'Repair' then
        done = not __builderBusy(unitId)
      elseif cmd.type == 'Reclaim' then
        done = __reclaimTasks[unitId] == nil -- target fully reclaimed or gone
      elseif cmd.type == 'Guard' then
        done = __guardOrders[unitId] == nil -- guarded unit died (Cfile:839365)
      end
      if done then
        __orderActive[unitId] = nil
        -- Ring rotation (dispatcher TaskTick, sim-core.md:243-252): a
        -- finished Patrol goes to the BACK of a non-empty queue; a single
        -- patrol point just completes (RemoveFirstCommandFromQueue).
        if cmd.type == 'Patrol' then
          local q = __orders[unitId]
          if q and q[1] then q[#q + 1] = cmd end
        end
        __ordersAdvance(unitId)
      end
    end
  end
end

--- Stop (Dispatch 0x01): Bau-Tasks (mit Abbruch-Hooks), Attack-Order,
--- Bewegungsziel, Dreh-Ziel UND die Befehls-Queue — alles weg.
function __dispatchStop(unitId)
  local u = __units[unitId]
  if not u then return end
  __orders[unitId] = nil
  __orderActive[unitId] = nil
  __abortBuildTasks(unitId)
  __attackOrders[unitId] = nil
  __guardOrders[unitId] = nil
  __reclaimTasks[unitId] = nil
  u.__guardedUnit = false
  u:GetNavigator():AbortMove()
  u.__faceGoal = false
end

--- Move (Dispatch 0x02): with clear it replaces build and attack, with
--- clear=false (Shift) it queues behind the running order.
function __dispatchMove(unitId, x, z, clear)
  __issueOrder(unitId, { type = 'Move', x = x, z = z }, clear)
end

--- Patrol (dispatch 0x10, CUnitPatrolTask): ONE leg per command — the
--- loop is the queue's ring rotation, engagement happens on the way
--- (see __ordersTick). Shift-added points use the serial insertion rule.
function __dispatchPatrol(unitId, x, z, clear)
  __issueOrder(unitId, { type = 'Patrol', x = x, z = z }, clear)
end

--- Attack (Dispatch 0x0A, CAttackTargetTask): die Order merken — der
--- Task-Tick faehrt in Waffenreichweite und die Zielerfassung bevorzugt
--- das Befehlsziel (weapons.lua).
function __dispatchAttack(unitId, targetId, clear)
  __issueOrder(unitId, { type = 'Attack', target = targetId }, clear)
end

--- Ground attack (dispatch 0x0A with a position target): the CAiTarget
--- carries mPosition instead of an entity (ctor copies both,
--- Cfile:812553-812563). The unit closes to weapon range (SetWeaponGoal
--- squares maxRadius around the position, Cfile:812691-812718), then the
--- attacker hands the ground target to the weapons (UpdateAttacker ->
--- SetDesiredTarget) and the task SLEEPS — a position never dies, so the
--- order runs until replaced (queue ring rotation with follow-up commands
--- is a named gap).
function __dispatchAttackGround(unitId, x, z, clear)
  __issueOrder(unitId, { type = 'Attack', gx = x, gz = z }, clear)
end

--- Repair (dispatch 0x14, CUnitRepairTask): the SAME CBuildTaskHelper as
--- construction (ctor Cfile:817427, UpdateWorkProgress 0x5F5BF0) — on an
--- UNFINISHED target it resumes construction; on a FINISHED damaged target
--- Materialize only raises health (AdjustHealth, Cfile:953468) at the same
--- rate and FULL build cost per second (unit.lua:712-726). A full-HP
--- finished target ends the task immediately (TaskTick -1, Cfile:817856).
function __dispatchRepair(unitId, targetId, clear)
  __issueOrder(unitId, { type = 'Repair', target = targetId }, clear)
end

-- The distance the attack task closes to: the largest FIRING range
-- (MaxRadius) over all enabled non-manual weapons. NOT
-- CAiAttackerImpl::GetMaxWeaponRange (Cfile:791342) — that one folds in
-- TrackingRadius and is only the Lua binding (its sole caller is the
-- LuaFuncDef); a unit stopping at tracking range never fires (found by the
-- verify suite: uel0201 halted at 20.45 m with an 18 m gun).
local function maxWeaponRange(u)
  if u.__beingBuilt then return 0 end
  local best = 0
  for _, w in ipairs(u.__weapons or {}) do
    local bp = w.__bp or {}
    if w.__enabled ~= false and not bp.ManualFire then
      local r = w.__maxRadius or bp.MaxRadius or 0
      if r > best then best = r end
    end
  end
  return best
end

--- Pro Beat (Anfang von __weaponTick): jede Attack-Order faehrt ihre Unit
--- in Waffenreichweite und stoppt dort; totes/fehlendes Ziel beendet den
--- Task (CAttackTargetTask ueber die AiAttacker-Events).
function __attackTick()
  for unitId, targetId in pairs(__attackOrders) do
    local u = __units[unitId]
    -- A table target is AITARGET_Ground (a position, never an entity):
    -- HasTarget is true for it (Cfile:800284), so the order has no
    -- "target died" exit — only Stop or a replacing command ends it.
    local ground = type(targetId) == 'table' and targetId or nil
    local t = not ground and __units[targetId] or nil
    if not u or u.__dead or u.__destroyQueued
      or (not ground and (not t or t.__dead or t.__destroyQueued)) then
      __attackOrders[unitId] = nil
    else
      local range = maxWeaponRange(u)
      local p = u.__pos
      local q = ground or t.__pos
      local dx, dz = q[1] - p[1], q[3] - p[3]
      local dist = math.sqrt(dx * dx + dz * dz)
      if range > 0 and dist > range then
        u.__goal = { q[1], q[3] }
        u.__faceGoal = false
      elseif u.__goal then
        u.__goal = false
        u.__speed = 0
        u.__faceGoal = { q[1], q[3] }
      elseif dist > 0.01 then
        u.__faceGoal = { q[1], q[3] }
      end
    end
  end
end

-- === Guard/Assist (dispatch 0x0F, CUnitGuardTask) ===
--
-- The ctor classifies the guard from categories (Cfile:836995-837075):
-- an IMMOBILE FACTORY assists by build-queue sharing, ENGINEER->ENGINEER
-- and ENGINEER->FACTORY are the builder-assist modes, everything else
-- guards by following. TaskTick re-checks every 7 ticks, engineer assist
-- every tick (Cfile:839518-839527). The task ends only when the guarded
-- unit dies (Cfile:839365-839385) or the order is replaced.
__guardOrders = {}

local function unitInCat(u, cat)
  local bp = u.__bp
  for _, c in ipairs((bp and bp.Categories) or {}) do
    if c == cat then return true end
  end
  return false
end

local function guardMode(u, t)
  local motion = (u.__bp and u.__bp.Physics and u.__bp.Physics.MotionType) or 'RULEUMT_None'
  if unitInCat(u, 'FACTORY') and motion == 'RULEUMT_None' then return 'factory' end
  if unitInCat(u, 'ENGINEER') and (unitInCat(t, 'ENGINEER') or unitInCat(t, 'FACTORY')) then
    return 'engineer'
  end
  return 'follow'
end

--- Start a guard order (called from the command queue's __startOrder).
--- Guarding yourself or a missing unit fails like the dispatch does
--- (no target -> Stop, Cfile:830638-830650).
function __guardStart(unitId, targetId)
  local u = __units[unitId]
  local t = __units[targetId]
  if not u or not t or t.__destroyed or targetId == unitId then return false end
  __guardOrders[unitId] = { target = targetId, mode = guardMode(u, t), clock = 0 }
  u.__guardedUnit = targetId
  return true
end

--- One guard decision, in the decomp's Processing priority order
--- (Cfile:839432-839516). Air-platform refuel, ferry beacons, the active
--- enemy chase (GetBestEnemy) and assist-reclaim are named gaps — our sim
--- has no refuel/ferry/reclaim yet and free weapon acquisition already
--- covers nearby enemies.
local function guardProcess(unitId, u, g, t)
  if g.mode == 'factory' then
    -- Queue sharing (sub_6127F0, Cfile:837860-838073): the assisting
    -- factory only pulls when it is idle with an empty queue of its own
    -- (own builds take priority, Cfile:837930-837962; not while Building,
    -- Cfile:837903-837908). Pull ONE item and leave the guarded factory
    -- its RUNNING head item (pull when index>0 or count>1,
    -- Cfile:837988-838024), decrementing or removing it (Cfile:838030-838049).
    if __builderBusy(unitId) then return end
    local own = u.__buildQueue
    if own and own[1] then return end
    local q = t.__buildQueue
    if not q then return end
    local from = nil
    if q[1] and (q[1].count or 1) > 1 then from = 1
    elseif q[2] then from = 2 end
    if not from then return end
    local bpId = q[from].id
    -- CanBuild check (Cfile:838020): the puller must be able to build it.
    local bp = __registered and __registered.Unit and __registered.Unit[string.lower(bpId)]
    if not bp then return end
    if (q[from].count or 1) > 1 then
      q[from].count = q[from].count - 1
    else
      table.remove(q, from)
    end
    __queueFactoryBuild(unitId, bpId, 1)
    return
  end

  -- Builder assist: walk the guard chain with a visited set
  -- (sub_612BB0, Cfile:838175-838228 — A guards B guards C resolves C),
  -- then join the chain unit's structure build through the repair task
  -- (sub_613970 starts the same build; our repair task IS the shared
  -- build path).
  if not __builderBusy(unitId) then
    local visited = { [unitId] = true }
    local chain = g.target
    while chain and not visited[chain] do
      visited[chain] = true
      local cu = __units[chain]
      local nxt = cu and cu.__guardedUnit
      if nxt and __units[nxt] and not visited[nxt] then chain = nxt else break end
    end
    local site = nil
    for _, task in pairs(__buildTasks) do
      if task.builder == chain then site = task.target end
    end
    if site and __units[site] and unitInCat(u, 'REPAIR') then
      __issueBuildTask(unitId, site, 'Repair', true)
      return
    end
    -- Repair the guarded unit itself when damaged or incomplete
    -- (sub_613110: guarding unit must be REBUILDER or REPAIR; target
    -- damaged, incomplete or enhancing — Cfile via report-guard-assist).
    if (unitInCat(u, 'REPAIR') or unitInCat(u, 'REBUILDER'))
      and ((t.__health or 0) < t:GetMaxHealth() or (t.__fraction or 1) < 1) then
      __issueBuildTask(unitId, g.target, 'Repair', true)
      return
    end
  end

  -- Follow (sub_613C40): only mobiles; ENGINEERS stay put within
  -- 2 * Economy.MaxBuildDistance of the guarded unit (Cfile:839020-839037).
  -- The desired position is the guarded unit's position (sub_612220,
  -- Cfile:837556-837700), clamped outside its skirt rect
  -- (Cfile:839040-839170) — exact PrepareMove spreading is a named gap.
  local motion = (u.__bp and u.__bp.Physics and u.__bp.Physics.MotionType) or 'RULEUMT_None'
  if motion == 'RULEUMT_None' then return end
  local p, q = u.__pos, t.__pos
  local dx, dz = q[1] - p[1], q[3] - p[3]
  local dist = math.sqrt(dx * dx + dz * dz)
  local stop
  if unitInCat(u, 'ENGINEER') then
    local mbd = (u.__bp.Economy and u.__bp.Economy.MaxBuildDistance) or 5
    stop = 2 * mbd
  else
    local skirt = (t.__bp and t.__bp.Physics and t.__bp.Physics.SkirtSizeX)
      or (t.__bp and t.__bp.Footprint and t.__bp.Footprint.SizeX) or 1
    local ownFp = (u.__bp and u.__bp.Footprint and u.__bp.Footprint.SizeX) or 1
    stop = skirt / 2 + ownFp / 2
  end
  if dist > stop then
    u.__goal = { q[1], q[3] }
    u.__faceGoal = false
  end
end

function __guardTick()
  for unitId, g in pairs(__guardOrders) do
    local u = __units[unitId]
    local t = __units[g.target]
    if not u or u.__dead or u.__destroyQueued then
      __guardOrders[unitId] = nil
    elseif not t or t.__dead or t.__destroyQueued then
      -- TaskTick -1: the guarded unit is gone (Cfile:839365-839385).
      __guardOrders[unitId] = nil
      u.__guardedUnit = false
    else
      g.clock = (g.clock or 0) - 1
      if g.clock <= 0 then
        -- 7-tick re-check, every tick for engineer assist (Cfile:839518-839527)
        g.clock = (g.mode == 'engineer') and 1 or 7
        guardProcess(unitId, u, g, t)
      end
    end
  end
end

-- === Reclaim (dispatch 0x13, CUnitReclaimTask — AiUnitReclaim.cpp) ===
--
-- The task asks the TARGET's own Lua for the costs
-- (GetReclaimCosts(reclaimer) -> time, energy, mass; Cfile:848452-848455,
-- prop.lua:153-162 — the formula stays in the original Lua), then drains
-- fraction by 1/ticks per tick with ticks = max(1, time*10)
-- (Cfile:848456-848465). The grant is total * |fraction delta|, added
-- DIRECTLY to the army storage (Cfile:848612-848638) — reclaim is never
-- economy-throttled (the request stays 0/0, LimitingRate = 1,
-- Cfile:1107891-1107909). At fraction 0 the target runs OnReclaimed and
-- dies (Prop::Materialize, Cfile:1013985-1014040).
__reclaimTasks = {}

function __dispatchReclaim(unitId, targetId, clear)
  __issueOrder(unitId, { type = 'Reclaim', target = targetId }, clear)
end

function __reclaimTick()
  for unitId, task in pairs(__reclaimTasks) do
    local u = __units[unitId]
    local t = __props[task.target]
    if not u or u.__dead or u.__destroyQueued
      or not t or t.__destroyed or t.__destroyQueued then
      __reclaimTasks[unitId] = nil
    else
      local p, q = u.__pos, t.__pos
      local dx, dz = q[1] - p[1], q[3] - p[3]
      local dist = math.sqrt(dx * dx + dz * dz)
      local range = (u.__bp.Economy and u.__bp.Economy.MaxBuildDistance) or 5
      if dist > range then
        -- Close in first (the dispatcher's Move precedes the task).
        u.__goal = { q[1], q[3] }
        u.__faceGoal = false
      else
        if u.__goal then
          u.__goal = false
          u.__speed = 0
        end
        if not task.started then
          task.started = true
          local ok, time, energy, mass = pcall(function() return t:GetReclaimCosts(u) end)
          if not ok or type(time) ~= 'number' then
            WARN('Failed to get valid reclaim costs from the target') -- Cfile:848452
            __reclaimTasks[unitId] = nil
          else
            local ticks = math.max(1, time * 10)
            task.perTick = 1 / ticks
            task.energy = math.max(0, energy or 0)
            task.mass = math.max(0, mass or 0)
            if u.OnStartReclaim then
              local okS, err = pcall(function() u:OnStartReclaim(t) end)
              if not okS then WARN('OnStartReclaim: ' .. tostring(err)) end
            end
          end
        end
        local live = __reclaimTasks[unitId]
        if live and live.perTick then
          local delta = math.min(live.perTick, t.__fraction or 1)
          t.__fraction = (t.__fraction or 1) - delta
          -- Materialize runs the prop's "BeingReclaimed" on EVERY call
          -- (Cfile:1014010 area).
          if t.BeingReclaimed then
            pcall(function() t:BeingReclaimed() end)
          end
          local brain = __getBrain(u.__army or 1)
          brain:GiveResource('MASS', live.mass * delta)
          brain:GiveResource('ENERGY', live.energy * delta)
          if t.__fraction <= 0 then
            if t.OnReclaimed then
              local okR, err = pcall(function() t:OnReclaimed(u) end)
              if not okR then WARN('OnReclaimed: ' .. tostring(err)) end
            end
            if not t.__destroyed and not t.__destroyQueued then t:Destroy() end
            if u.OnStopReclaim then pcall(function() u:OnStopReclaim(t) end) end
            __reclaimTasks[unitId] = nil
          end
        end
      end
    end
  end
end

--- Guard (dispatch 0x0F): remember the guarded unit (mUnit->mGuardedUnit,
--- synced into the task every tick, Cfile:839316-839333) and run the
--- guard state machine per beat. Guarding yourself is refused like a
--- missing target (dispatch falls back to Stop, Cfile:830638-830650).
function __dispatchGuard(unitId, targetId, clear)
  __issueOrder(unitId, { type = 'Guard', target = targetId }, clear)
end

-- FlattenMapRect(x, z, w, h, y): Gebaeude planieren ihr Baufeld
-- (defaultunits.lua:72, StructureUnit:FlattenSkirt). Die Engine deformiert die
-- Hoehenkarte; solange keine Karte geladen ist, werden die Rechtecke
-- gesammelt (der Renderer/die Karte wenden sie an).
__flattenRects = {}
function FlattenMapRect(x, z, w, h, y)
  __flattenRects[#__flattenRects + 1] = { x = x, z = z, w = w, h = h, y = y }
  if __terrainFlatten then __terrainFlatten(x, z, w, h, y) end
end

-- === SimCallback — der Empfaenger (Moho::Sim::LuaSimCallback) ===
--
-- Die UI schickt {Func, Args, EntityIds} durch den Befehlsstrom (CMarshaller::
-- LuaSimCallback, Cfile:999094-999136); die Sim-Seite (Cfile:1076180-1076287)
-- baut aus den Ids eine Tabelle von Sim-Unit-Objekten — NUR existierende,
-- leeres Set -> nil (Cfile:1076219-1076251) — und ruft
-- import('/lua/simcallbacks.lua').DoCallback(name, args, units).
-- Fehler im Callback werden geloggt, nicht geworfen (gpg::Warnf-Verhalten).
function __simCallback(func, args, unitIds)
  local units = nil
  if unitIds then
    for _, id in ipairs(unitIds) do
      local u = __units[id]
      if u and not u.__destroyQueued then
        units = units or {}
        units[#units + 1] = u
      end
    end
  end
  local ok, err = pcall(function()
    local cb = import('/lua/simcallbacks.lua').DoCallback
    if type(cb) ~= 'function' then
      error('No DoCallback in simcallbacks.lua')
    end
    cb(func, args, units)
  end)
  if not ok then
    WARN('SimCallback ' .. tostring(func) .. ': ' .. tostring(err))
  end
end
