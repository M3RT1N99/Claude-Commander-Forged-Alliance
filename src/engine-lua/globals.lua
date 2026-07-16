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
function IsAlly(a, b) return a == b end
function IsEnemy(a, b) return a ~= b end

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
function CreateAimController(unit, bone) return newManipulator('aim', unit, bone) end

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
  return issueTo(units, function(u) u:GetNavigator():AbortMove() end)
end

function IssueClearCommands(units)
  return issueTo(units, function(u) u:GetNavigator():AbortMove() end)
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
