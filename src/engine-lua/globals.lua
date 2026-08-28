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
function MATH_Lerp(...)
  local argc = select('#', ...)
  if argc < 3 or argc > 5 then
    error(
      'MATH_Lerp(s, a, b) or MATH_Lerp(s, sMin, sMax, a, b) -> number'
        .. '\n  expected between 3 and 5 args, but got ' .. tostring(argc),
      2
    )
  end
  local s, a, b, c, d = ...
  -- The native binding accepts three to five arguments, but its four-argument
  -- branch deliberately pushes nil (Cfile:598206-598265). Testing `d == nil`
  -- cannot distinguish that call from the three-argument overload and used to
  -- return an invented interpolation result.
  if argc == 4 then return nil end
  if argc == 3 then
    if type(s) ~= 'number' then error("bad argument #1 to 'MATH_Lerp' (number expected)", 2) end
    if type(a) ~= 'number' then error("bad argument #2 to 'MATH_Lerp' (number expected)", 2) end
    if type(b) ~= 'number' then error("bad argument #3 to 'MATH_Lerp' (number expected)", 2) end
    return a + (b - a) * s
  end
  if type(s) ~= 'number' then error("bad argument #1 to 'MATH_Lerp' (number expected)", 2) end
  if type(a) ~= 'number' then error("bad argument #2 to 'MATH_Lerp' (number expected)", 2) end
  if type(b) ~= 'number' then error("bad argument #3 to 'MATH_Lerp' (number expected)", 2) end
  if type(c) ~= 'number' then error("bad argument #4 to 'MATH_Lerp' (number expected)", 2) end
  if type(d) ~= 'number' then error("bad argument #5 to 'MATH_Lerp' (number expected)", 2) end
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
-- Ein Engine-Vektor traegt BEIDE Zugriffe — und das ist kein Komfort, sondern
-- Voraussetzung: die Original-Lua benutzt wirklich beide Formen.
--
--   aeonweapons.lua:105     VDist2(unitPos[1], unitPos[3], …)     -- Index
--   effectutilities.lua:274 2 * (endVec2.x - endVec1.x)           -- Feld
--
-- Ein Vektor nur mit Indizes laesst jeden Bau-Effekt an "attempt to perform
-- arithmetic on a nil value" sterben (genau das stand im Log).
--
-- The native Vector metatable does not duplicate named fields. Its __index and
-- __newindex map x/y/z directly to raw array slots 1/2/3
-- (Cfile:596930-596959). Keeping both copies made writes diverge: `v.x = 9`
-- left `v[1]` unchanged and vice versa.
local VectorMeta = {}
local function vectorIndex(k)
  if k == 'x' then return 1 end
  if k == 'y' then return 2 end
  if k == 'z' then return 3 end
  error("'x', 'y', or 'z' expected", 3)
end
VectorMeta.__index = function(v, k)
  local i = vectorIndex(k)
  return rawget(v, i)
end
VectorMeta.__newindex = function(v, k, value)
  local i = vectorIndex(k)
  rawset(v, i, value)
end

function Vector(...)
  local argc = select('#', ...)
  if argc ~= 3 then
    error('Create a vector (x,y,z)\n  expected 3 args, but got ' .. tostring(argc), 2)
  end
  local x, y, z = ...
  if type(x) ~= 'number' then error("bad argument #1 to 'Vector' (number expected)", 2) end
  if type(y) ~= 'number' then error("bad argument #2 to 'Vector' (number expected)", 2) end
  if type(z) ~= 'number' then error("bad argument #3 to 'Vector' (number expected)", 2) end
  return setmetatable({ x, y, z }, VectorMeta)
end

function Vector2(...)
  local argc = select('#', ...)
  if argc ~= 2 then
    error('Create a vector (x,y)\n  expected 2 args, but got ' .. tostring(argc), 2)
  end
  local x, y = ...
  if type(x) ~= 'number' then error("bad argument #1 to 'Vector2' (number expected)", 2) end
  if type(y) ~= 'number' then error("bad argument #2 to 'Vector2' (number expected)", 2) end
  return setmetatable({ x, y }, VectorMeta)
end

local function Quaternion(x, y, z, w)
  -- SCR_ToLua<Quaternion> writes the fourth scalar component and then attaches
  -- the same Vector metatable (Cfile:596768-596804).
  return setmetatable({ x, y, z, w }, VectorMeta)
end

function VAdd(a, b) local ax,ay,az = vxyz(a); local bx,by,bz = vxyz(b); return Vector(ax+bx, ay+by, az+bz) end
function VSub(a, b) local ax,ay,az = vxyz(a); local bx,by,bz = vxyz(b); return Vector(ax-bx, ay-by, az-bz) end
function VDiff(a, b) return VSub(a, b) end
function VMult(a, s) local ax,ay,az = vxyz(a); return Vector(ax*s, ay*s, az*s) end

-- === Core math globals (scr_CoreInits => both VMs) ===

-- "Dot product of two vectors" (VDot, Cfile:597741) — full 3D dot.
function VDot(a, b)
  local ax, ay, az = vxyz(a)
  local bx, by, bz = vxyz(b)
  return ax * bx + ay * by + az * bz
end

-- "Perp dot product of two vectors" (VPerpDot, Cfile:598057) — a.x*b.z -
-- b.x*a.z, the XZ-plane perp-dot (the Y component is ignored, Cfile:598096).
function VPerpDot(a, b)
  local ax, _, az = vxyz(a)
  local bx, _, bz = vxyz(b)
  return ax * bz - bx * az
end

-- "Create a 2d Rectangle (x0,y0,x1,y1)" (Rect, Cfile:597354) — a plain table
-- with the NAMED fields x0/y0/x1/y1, no array part (SCR_ToLua<Rect2f>,
-- Cfile:597236-597244); GetUnitsInRect reads exactly those names. utilities.lua:22
-- passes world x/z as the y0/y1 fields — the field names are the engine's.
function Rect(x0, y0, x1, y1)
  return { x0 = x0, y0 = y0, x1 = x1, y1 = y1 }
end

-- "Create a point vector(px,py,pz, vx,vy,vz)" (PointVector, Cfile:597151) —
-- named fields only (SCR_ToLua<SPointVector>, Cfile:597070-597083).
function PointVector(px, py, pz, vx, vy, vz)
  return { px = px, py = py, pz = pz, vx = vx, vy = vy, vz = vz }
end

-- "Round a number to the nearest integer" (MATH_IRound, Cfile:598120). The
-- x87 `fistp` uses the default control word = ROUND HALF TO EVEN (disasm
-- 0x4D2005), not truncation and not round-half-away-from-zero: 2.5 -> 2,
-- 3.5 -> 4, -2.5 -> -2.
function MATH_IRound(n)
  local f = math.floor(n)
  local d = n - f
  if d > 0.5 then
    f = f + 1
  elseif d == 0.5 and math.mod(f, 2) ~= 0 then
    f = f + 1
  end
  return f
end

-- === Quaternion math (scr_CoreInits => both VMs) ===
-- Lua quaternion order is {x, y, z, w} (SCR_ToLua<Quaternion>,
-- Cfile:596768-596785; effectutilities.lua:418 unpacks qx,qy,qz,qw).

-- "quaternion EulerToQuaternion(roll, pitch, yaw)" (Cfile:643413) — angles in
-- radians (func_EulerToQuaternion, Cfile:617610-617643).
function EulerToQuaternion(roll, pitch, yaw)
  local cr, sr = math.cos(roll * 0.5), math.sin(roll * 0.5)
  local cp, sp = math.cos(pitch * 0.5), math.sin(pitch * 0.5)
  local cy, sy = math.cos(yaw * 0.5), math.sin(yaw * 0.5)
  return Quaternion(
    sr * cp * sy + cr * sp * cy, -- x
    cr * cp * sy - sr * sp * cy, -- y
    sr * cp * cy - cr * sp * sy, -- z
    cr * cp * cy + sr * sp * sy -- w
  )
end

-- func_MatrixToQuat (Cfile:617541-617603) — rows m[1..3], each {x,y,z}.
local function matToQuat(m)
  local t = m[1][1] + m[2][2] + m[3][3]
  if t > 0 then
    local s = math.sqrt(t + 1)
    local h = 0.5 / s
    return Quaternion((m[2][3] - m[3][2]) * h, (m[3][1] - m[1][3]) * h, (m[1][2] - m[2][1]) * h, s * 0.5)
  end
  local sh = { 2, 3, 1 }
  local i = (m[2][2] > m[1][1]) and 2 or 1
  if m[3][3] > m[i][i] then i = 3 end
  local j, k = sh[i], sh[sh[i]]
  local s = math.sqrt(m[i][i] - (m[k][k] + m[j][j]) + 1)
  local h = 0.5 / s
  local v = {}
  v[i] = s * 0.5
  v[j] = (m[j][i] + m[i][j]) * h
  v[k] = (m[i][k] + m[k][i]) * h
  return Quaternion(v[1], v[2], v[3], (m[j][k] - m[k][j]) * h)
end

-- "quaternion OrientFromDir(vector)" (Cfile:643353) — an orientation whose
-- forward axis points along the direction (Moho::COORDS_Orient,
-- Cfile:641728-641776). shield.lua:201/466, effectutilities.lua:1151 use it.
function OrientFromDir(dir)
  local dx = dir[1] or dir.x or 0
  local dy = dir[2] or dir.y or 0
  local dz = dir[3] or dir.z or 0
  local l = math.sqrt(dx * dx + dy * dy + dz * dz)
  if l == 0 then return Quaternion(0, 0, 0, 1) end
  local f = { dx / l, dy / l, dz / l }
  local rl = math.sqrt(f[3] * f[3] + f[1] * f[1])
  if rl == 0 then
    -- Straight up/down (Cfile:641748-641757).
    return Quaternion((dy > 0) and -0.70710677 or 0.70710677, 0, 0, 0.70710677)
  end
  local r = { f[3] / rl, 0, -f[1] / rl }
  local u = {
    f[2] * r[3] - f[3] * r[2],
    f[3] * r[1] - r[3] * f[1],
    r[2] * f[1] - f[2] * r[1],
  }
  return matToQuat({ r, u, f })
end

local function quatsNearEqual(a, b)
  return math.abs(a[1] - b[1]) <= 1e-6 and math.abs(a[2] - b[2]) <= 1e-6
    and math.abs(a[3] - b[3]) <= 1e-6 and math.abs(a[4] - b[4]) <= 1e-6
end
local function quatNormalize(q)
  local l = math.sqrt(q[1] * q[1] + q[2] * q[2] + q[3] * q[3] + q[4] * q[4])
  if l <= 1e-6 then return Quaternion(0, 0, 0, 0) end
  return Quaternion(q[1] / l, q[2] / l, q[3] / l, q[4] / l)
end

-- "quaternion MinLerp(alpha, L, R)" (Cfile:643493) — func_QuatLERP
-- (Cfile:617768-617815): near-equal quats return L; else clamp alpha to [0,1],
-- flip R on the shortest path, lerp and normalise.
function MinLerp(alpha, L, R)
  if quatsNearEqual(L, R) then return Quaternion(L[1], L[2], L[3], L[4]) end
  local t = alpha
  if t >= 1 then t = 1 elseif t < 0 then t = 0 end
  local d = R[1] * L[1] + R[2] * L[2] + R[3] * L[3] + R[4] * L[4]
  local s = (d < 0) and -1 or 1
  return quatNormalize(Quaternion(
    L[1] * (1 - t) + s * R[1] * t, L[2] * (1 - t) + s * R[2] * t,
    L[3] * (1 - t) + s * R[3] * t, L[4] * (1 - t) + s * R[4] * t
  ))
end

-- "quaternion MinSlerp(alpha, L, R)" (Cfile:643570) — Moho::SLERP
-- (Cfile:617818-617991): a true slerp when the angle is large enough, else the
-- same normalised lerp as MinLerp.
function MinSlerp(alpha, L, R)
  if quatsNearEqual(L, R) then return Quaternion(L[1], L[2], L[3], L[4]) end
  local t = alpha
  if t >= 1 then t = 1 elseif t < 0 then t = 0 end
  local d = R[1] * L[1] + R[2] * L[2] + R[3] * L[3] + R[4] * L[4]
  local s = 1
  if d < 0 then s = -1; d = -d end
  if (1 - d) > 0.001 then
    local th = math.acos(d)
    if (math.pi - th) >= 0.001 then
      local isin = 1 / math.sin(th)
      local a = math.sin(th * (1 - t)) * isin
      local b = math.sin(th * t) * isin
      return Quaternion(
        L[1] * a + s * R[1] * b, L[2] * a + s * R[2] * b,
        L[3] * a + s * R[3] * b, L[4] * a + s * R[4] * b
      )
    end
  end
  return quatNormalize(Quaternion(
    L[1] * (1 - t) + s * R[1] * t, L[2] * (1 - t) + s * R[2] * t,
    L[3] * (1 - t) + s * R[3] * t, L[4] * (1 - t) + s * R[4] * t
  ))
end

-- "GetVersion()" (Cfile:599401) — a CORE global: the ENGINE version, not the
-- game-data version. Moho::GetEngineVersion is compiled in as
-- STR_Printf("%1.1f.%i", 1.5, 3764) = "1.5.3764" (Cfile:599330-599334). The
-- host may override it (uiEngine.ts sets __engineVersion from package.json, so
-- the main menu shows this reimplementation's version); the Sim VM reports the
-- real FA engine version. main.lua:172 draws it.
function GetVersion()
  return __engineVersion or '1.5.3764'
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

--- `Moho::ARMY_FromLuaState` (Cfile:1024163-1024225) — die EINE Stelle, an der
--- aus einem Lua-Argument eine Armee wird. Zahl ODER Name.
---
--- Die Original-Lua reicht ueberall den NAMEN durch: `SetArmyEconomy(strArmy,
--- ...)` (scenarioutilities.lua:456), `GetArmyBrain(strArmy)` (:460),
--- `CreateUnitHPR(..., strArmy, ...)` (:206). Ohne Namensaufloesung laeuft von
--- `InitializeArmies()` keine einzige Zeile.
---
--- Die drei Fehlertexte sind die der Engine, samt ihrer Eigenheit: bei einer
--- Zahl ausserhalb des Bereichs druckt sie `index - 1`, also den 0-basierten
--- Wert (Cfile:1024184: `v4 = Integer - 1`, dann `"Invalid army %d", v4`).
--- Bei einer negativen Zahl den Ausgangswert plus den Hinweis auf die
--- 1-Basierung (Cfile:1024191).
---
--- NICHT fuer `CreateUnit`: das ist im Original zahl-only (`cfunc_CreateUnitL`
--- prueft `lua_type(...) != LUA_TNUMBER` und wirft `TypeError "integer"`,
--- Cfile:980336-980352), waehrend `cfunc_CreateUnitHPRL` genau hier
--- durchgeht (Cfile:980538).
function __resolveArmy(x)
  if type(x) == 'number' then
    local zero = x - 1
    local n = 0
    if ScenarioInfo and ScenarioInfo.ArmySetup then
      for _ in pairs(ScenarioInfo.ArmySetup) do n = n + 1 end
    end
    -- Ohne ArmySetup kann die Zahl nicht geprueft werden; dann gilt nur die
    -- 1-Basierung. (Die Sandbox-Suiten spawnen vor `setupSession`.)
    if zero < 0 then
      error(string.format('Invalid army %d. (Use a 1-based index)', x), 2)
    end
    if n > 0 and zero >= n then
      error(string.format('Invalid army %d', zero), 2)
    end
    return x
  end
  if type(x) == 'string' then
    if ScenarioInfo and ScenarioInfo.ArmySetup then
      for name, a in pairs(ScenarioInfo.ArmySetup) do
        if name == x or a.ArmyName == x then return a.ArmyIndex end
      end
    end
    error(string.format('Unknown army: %s', x), 2)
  end
  error('Unexpected type for army object', 2)
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

-- Der Wasserspiegel der geladenen Karte (aus der .scmap). Ohne Wasser setzt
-- STIMap exakt -10000 ein (Entity::GetStartingLayer, Cfile:857506-857510).
__mapWaterLevel = -10000
function __setWaterLevel(y) __mapWaterLevel = type(y) == 'number' and y or -10000 end

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

-- ParseEntityCategory('TECH1,TECH2 MOBILE'): the engine's string DSL
-- (ParseEntityCategory @Cfile:698138-698245) splits on COMMAS into groups that
-- are UNIONED, and on WHITESPACE within a group into tokens that are
-- INTERSECTED. There are no '+'/'-'/'*' operators in the string form — a token
-- not in the category rules map is SKIPPED (Cfile:698215, v14 == Myhead), so
-- the operators contribute nothing rather than collapsing the group to empty.
-- Real blueprints rely on the comma form: url0103_unit.bp:230
-- TargetAllow='TECH1,TECH2', uaa0103_unit.bp:287
-- TargetDisallow='TECH3,EXPERIMENTAL,COMMAND'. An empty or all-unrecognised
-- expression is the EMPTY set (matches nothing), not ALLUNITS.
-- Reduction: we have no separate registry of DECLARED categories (our
-- `categories` table auto-vivifies any token), so an unknown category NAME
-- (a typo) cannot be told apart from a real one and still empties its group —
-- shipped FA strings never contain such typos, only valid tokens and the
-- operators below, which we skip like the engine.
local CAT_OPERATORS = { ['*'] = true, ['+'] = true, ['-'] = true }
function ParseEntityCategory(expr)
  if type(expr) ~= 'string' then return expr end
  local result = nil
  for group in string.gmatch(expr, '[^,]+') do
    local inter = nil
    for tok in string.gmatch(group, '%S+') do
      if not CAT_OPERATORS[tok] then
        local c = categories[tok]
        inter = inter and (inter * c) or c
      end
    end
    if inter then result = result and (result + inter) or inter end
  end
  return result or mkcat('none')
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
function ManipMeta:SetBoneEnabled(bone, on) self.__boneEnabled = self.__boneEnabled or {}; self.__boneEnabled[bone] = on ~= false; return self end
-- Slider:SetWorldUnits(bool) — the slider goal is in world units instead of the
-- model's. effectutilities.lua:362/574/646 (the Aeon/Seraphim/Cybran build-effect
-- threads) call it on every build; it was not defined anywhere, so those threads
-- died with "attempt to call a nil value" (units.lua:4-8 deliberately disables
-- the instance fallback, so a missing engine method throws).
function ManipMeta:SetWorldUnits(v) self.__worldUnits = v ~= false; return self end
function ManipMeta:ClearGoal() self.__goal = nil; return self end
function ManipMeta:Disable() self.__enabled = false; return self end
function ManipMeta:Enable() self.__enabled = true; return self end
function ManipMeta:Destroy()
  self.__destroyed = true
  -- CAimManipulator's destructor restores UnitWeapon::mCanFire to true
  -- (Cfile:861517-861538).
  if self.__kind == 'aim' and self.__weapon then
    self.__weapon.__canFire = true
  end
end
function ManipMeta:IsDestroyed() return self.__destroyed == true end
-- BeenDestroyed() — the engine answers `opt == 0`, i.e. "the object is gone"
-- (cfunc_CSlideManipulatorBeenDestroyedL, Cfile:879376). It was missing:
-- effectutilities.lua:664/670 (the Seraphim factory build effect) calls it on
-- the slider, so that thread died with "attempt to call a nil value (method
-- 'BeenDestroyed')" — and the build base was never removed.
function ManipMeta:BeenDestroyed() return self.__destroyed == true end
function ManipMeta:GetGoal() return self.__goal end
-- WaitFor(manipulator) blocks until the manipulator reached its goal. There is
-- no bone animation system yet, so a manipulator is done the moment it is set;
-- once bones animate, this reports real progress instead.
function ManipMeta:IsDone() return true end

-- Die Manipulator-Methoden fuer die Bestandsaufnahme erreichbar machen.
-- Die Engine hat je Manipulator-Art eine eigene C++-Klasse (CAimManipulator,
-- CRotateManipulator, CAnimationManipulator, ... - engine-api.md); wir teilen
-- uns EINE gemeinsame Metatable. Das ist eine BENANNTE REDUKTION: die
-- Bestandsaufnahme meldet eine Methode als ECHT, sobald unsere gemeinsame
-- Implementierung sie hat, ohne nach Manipulator-Art zu trennen.
-- Ohne diesen Zugriff zaehlte sie alle 50 Manipulator-Methoden pauschal als
-- FEHLT, weil ManipMeta ein Local ist - und genau daher kam die falsche Zahl
-- in STATUS.md. Eigener `__`-Namensraum: die Original-Lua stoesst nicht darauf.
__manipulatorMethods = ManipMeta

local function newManipulator(kind, unit, bone)
  return setmetatable({ __kind = kind, __unit = unit, __bone = bone, __enabled = true }, ManipMeta)
end
-- CreateRotator(unit, bone, axis, [goal], [speed], [accel], [goalspeed])
-- (mHelp Cfile:876359). The four optional arguments were dropped before, so a
-- rotator built in one call (`CreateRotator(u, b, 'y', nil, 30)`) started blank.
function CreateRotator(unit, bone, axis, goal, speed, accel, goalSpeed)
  local m = newManipulator('rotator', unit, bone)
  m.__axis = axis
  if goal ~= nil then m.__goal = { goal } end
  if speed ~= nil then m.__speed = speed end
  if accel ~= nil then m.__accel = accel end
  if goalSpeed ~= nil then m.__targetSpeed = goalSpeed end
  return m
end
function CreateSlider(unit, bone) return newManipulator('slider', unit, bone) end
function CreateAnimator(unit) return newManipulator('animator', unit) end
-- CreateBuilderArmController(unit, turretBone, [barrelBone], [aimBone])
-- (mHelp Cfile:866166) — unit.lua:1661 passes all three bones.
function CreateBuilderArmController(unit, turretBone, barrelBone, aimBone)
  local m = newManipulator('builderarm', unit, turretBone)
  m.__barrelBone = barrelBone
  m.__aimBone = aimBone
  return m
end
function CreateThrustController(unit, bone) return newManipulator('thrust', unit, bone) end

-- "manip = CreateSlaver(unit, dest_bone, src_bone)" (Cfile:877923, sim only) —
-- a CSlaveManipulator that copies src_bone's animated pose onto dest_bone.
-- weapon.lua:101 slaves every rack bone to the pitch bone for weapons with
-- RackSlavedToTurret; without it that weapon's OnCreate thread died.
function CreateSlaver(unit, destBone, srcBone)
  local m = newManipulator('slaver', unit, destBone)
  m.__srcBone = srcBone
  return m
end

-- "CreateStorageManip(unit, bone, resource, minX,minY,minZ, maxX,maxY,maxZ)"
-- (Cfile:880155, sim only) — a CStorageManipulator that slides the bone
-- between min and max as the army's storage of that resource fills. The eight
-- mass/energy storage structure scripts call it in OnCreate (ueb1105 etc.).
function CreateStorageManip(unit, bone, resource, mnX, mnY, mnZ, mxX, mxY, mxZ)
  local m = newManipulator('storage', unit, bone)
  m.__resource = resource
  m.__min = { mnX, mnY, mnZ }
  m.__max = { mxX, mxY, mxZ }
  return m
end

-- CSlaveManipulator:SetMaxRate(deg/s) (Cfile:880156) — weapon.lua caps the
-- slaved bone's rate with it.
function ManipMeta:SetMaxRate(dps) self.__maxRate = dps; return self end

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
  if weapon then
    weapon.__aim = m
    -- Constructing an aim manipulator clears mCanFire until tracking reports
    -- OnTarget (Cfile:861326-861510, 862080-862097).
    weapon.__canFire = false
  end
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
--- `GetArmyBrain(army)` nimmt Zahl ODER Namen — die Original-Lua reicht
--- ueberall `strArmy` durch (scenarioutilities.lua:460/469). Die Aufloesung ist
--- `ARMY_FromLuaState` (Cfile:1024163-1024225), dieselbe wie fuer
--- `SetArmyEconomy` und `CreateUnitHPR`.
function GetArmyBrain(army) return __getBrain(__resolveArmy(army)) end
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

-- Cheats flag (Sim::CheatsEnabled) — off in a normal sandbox; a cheat host would
-- flip it to allow commanding any army.
__cheatsEnabled = false

-- OkayToMessWithArmy(army) — may the local player command this army?
-- (cfunc_OkayToMessWithArmyL, Cfile:1026233: NOT out-of-game AND the current
-- command source is a valid source for the army, OR cheats are on.) Self-destruct
-- (selfdestruct.lua:17) and the control-group callbacks gate on it. Our single
-- local player owns the focus army, so that army is commandable; a defeated
-- army would be out of the game (not modelled — no army is out-of-game here).
function OkayToMessWithArmy(army)
  return army == GetFocusArmy() or __cheatsEnabled == true
end


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
    -- A FIXED effect (splat/decal — CreateSplat/CreateDecal) lives at a stored
    -- world transform, owner-independent, until its duration elapses; an
    -- OWNER-attached emitter follows its bone and dies with the owner.
    local expired = e.__expireTick and (__gameTick or 0) >= e.__expireTick
    local lebt = not e.__destroyed and not expired
      and (e.__fixedPos ~= nil or (o ~= nil and not o.__destroyed and not o.__destroyQueued))
    if lebt then
      k = k + 1
      kompakt[k] = e
      -- Position UND Rotation des Knochens: LocalVelocity/LocalAcceleration
      -- drehen die Spawn-Richtungen EINMALIG beim Spawn in den Bone-Raum
      -- (CEfxEmitter::Tick, Cfile:894849-894859) — dafuer braucht der
      -- Spawner die Bone-Orientierung, nicht nur den Ort.
      local pos, rot
      if e.__fixedPos then
        pos, rot = e.__fixedPos, e.__fixedRot or { 1, 0, 0, 0 }
      else
        pos, rot = __boneWorld(o, e.__bone)
      end
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
-- DOCUMENTED FIDELITY GAP: the engine's CreateEmitterAtBone/AtEntity spawn the
-- emitter DETACHED at a fixed spawn transform that OUTLIVES the owner (they set
-- only mMatrix, never mEnt; CEfxEmitter::InterpolatePosition returns the fixed
-- matrix when mEnt is null, Cfile:892334/892375-892381), while CreateAttached
-- Emitter/CreateEmitterOnEntity follow the owner (SetBone/SetEntity set mEnt,
-- Cfile:895350/895570). We make AtBone/AtEntity follow the owner and die with it
-- like the attached variants — deferred (a fixed detach would need a per-emitter
-- lifetime to avoid leaking fire-and-forget effects; splats/decals below DO use
-- the fixed-transform + duration path).
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

-- "CreateBeamEntityToEntity(entity, bone, other, bone, army, blueprint)"
-- (Cfile:890531, sim only) — a beam between two bones from a BEAM BLUEPRINT,
-- the same carrier as AttachBeamEntityToEntity. defaultcollisionbeams.lua:325
-- draws the experimental phason laser (muzzle bone 0 -> impact bone 1) with it.
--
-- The engine additionally looks the blueprint up and throws "Unknown beam kind"
-- for an unknown one (Cfile:890636). We do NOT mirror that check: the sim VM
-- does not register beam emitter blueprints up front (the renderer fetches them
-- on demand via emitterBlueprint), so a valid beam path is absent from
-- __registered.Emitter and validating against it would reject every real beam.
-- The blueprint is carried as the emitter spec; the renderer resolves it.
function CreateBeamEntityToEntity(a, aBone, b, bBone, army, blueprint)
  local e = newEmitter(a, aBone, army, blueprint)
  e.__other = b
  e.__otherBone = bBone
  return e
end
function CreateLightParticle(owner, bone, army, size, life, tex, ramp) end
function CreateLightParticleIntel(owner, bone, army, size, life, tex, ramp) end
-- CreateSplat(position, heading, texture, sizeX, sizeZ, lod, duration, army,
-- fidelity) / CreateDecal(...) drop a GROUND effect at a FIXED world transform
-- independent of any entity (cfunc_CreateDecalL builds a VTransform from the
-- position + heading and constructs a CDecal there, Cfile:908234-908243). The
-- position and heading are load-bearing — the old nil-owner emitter was
-- compacted out of __emitters immediately and never rendered. Stored as a fixed
-- transform with a duration (splat marks, scorch decals, tread marks).
local function fixedGroundEffect(pos, heading, tex, size, life, army)
  local e = newEmitter(nil, -1, army, tex)
  local h = (heading or 0) * 0.5
  e.__fixedPos = { (pos and pos[1]) or 0, (pos and pos[2]) or 0, (pos and pos[3]) or 0 }
  e.__fixedRot = { math.cos(h), 0, math.sin(h), 0 } -- heading = rotation about Y
  e.__scale = size or 1
  if life and life > 0 then e.__expireTick = (__gameTick or 0) + math.floor(life * 10) end
  return e
end
function CreateSplat(pos, heading, tex, sx, sz, lod, life, army)
  return fixedGroundEffect(pos, heading, tex, sx, life, army)
end
function CreateDecal(pos, heading, tex1, tex2, type, sx, sz, lod, life, army)
  return fixedGroundEffect(pos, heading, tex1, sx, life, army)
end

-- "CreateSplatOnBone(entity, offset, boneName, textureName, sizeX, sizeZ,
-- lodParam, duration, army)" (Cfile:908461, sim only; the mHelp is incomplete
-- but the impl and unit.lua:2648 give the 9-arg order). It takes the bone's
-- world transform, rotates the offset by the bone orientation and drops a
-- ground splat there. unit.lua:2325/2649 lays tread marks with it.
function CreateSplatOnBone(ent, offset, bone, tex, sx, sz, lod, life, army)
  local pos, rot = __boneWorld(ent, bone)
  local o = __qrot(rot, offset or { 0, 0, 0 })
  local p = { pos[1] + o[1], pos[2] + o[2], pos[3] + o[3] }
  -- Heading = the bone's +Z direction projected onto the ground.
  local fwd = __quatForward(rot)
  local heading = math.atan(fwd[1], fwd[3])
  return CreateSplat(p, heading, tex, sx, sz, lod, life, army)
end

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
  -- Yield at least ONE tick before re-checking. A manipulator always needs time
  -- in the engine, and while no bone animation runs here IsDone() is instantly
  -- true — with a plain `while not IsDone()` the loop body never ran, so
  -- WaitFor returned inside the same tick. unit.lua:3683 (RockingThread) does
  -- `while true do WaitFor(RockManip) ... end`: that spun forever without ever
  -- yielding and hung the sim thread.
  repeat
    coroutine.yield(1)
  until obj:IsDone()
end

-- === Buff blueprints ===
--
-- NOT ours: `BuffBlueprint` and the global `Buffs` table are ORIGINAL Lua
-- (/lua/system/buffblueprints.lua:11/30-60) — the engine loads that file into
-- the sim state, like the other /lua/system files. It used to be reimplemented
-- here, writing into a private `__buffs`; the original /lua/sim/buff.lua reads
-- `Buffs[name]`, so every ApplyBuff (adjacency, veterancy, enhancements) died
-- with "*ERROR: Tried to add a buff that doesn't exist!". engine.ts loads the
-- original file instead.

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
-- "entity = GetEntityById(id)" (Cfile:1077559, sim only) — any entity (unit,
-- prop, projectile) by id, no IsUnit filter; nil when gone. selfdestruct.lua:16
-- (Ctrl-K) and simcallbacks.lua:78 (control groups) look units up with it.
function GetEntityById(id)
  local n = tonumber(id)
  if not n then return nil end
  return __units[n] or (__props and __props[n]) or (__projectiles and __projectiles[n]) or nil
end

-- "GetUnitById(id)" (Cfile:1077628, sim; the UI has its own at Cfile:1269630) —
-- like GetEntityById but ONLY when the entity is a unit (Entity::IsUnit filter,
-- Cfile:1077672).
function GetUnitById(id)
  local u = __units[tonumber(id)]
  if u and u.__isUnit then return u end
  return nil
end

-- "sizeX, sizeZ = GetMapSize()" (Cfile:1089710, sim only) — the heightfield is
-- (w+1)x(h+1) samples, so this returns the map extent in world coords
-- (field->width - 1, field->height - 1, Cfile:1089736/1089738). __mapSizeX/Z
-- come from setTerrainSource. AI base templates scale their radii with it.
__mapSizeX = false
__mapSizeZ = false
function GetMapSize()
  if not __mapSizeX then
    error('GetMapSize: no map loaded — the engine must call setTerrainSource()', 2)
  end
  return __mapSizeX, __mapSizeZ
end

__terrainHeight = false
function GetTerrainHeight(x, z)
  if not __terrainHeight then
    error('GetTerrainHeight: no terrain loaded — the engine must call setTerrainSource()', 2)
  end
  return __terrainHeight(x, z)
end
-- GetSurfaceHeight clamps the terrain elevation UP to the water surface when
-- the map has water (cfunc_GetSurfaceHeightL, Cfile:1089863-1089872: returns
-- max(GetElevation, mWaterElevation) when mWaterEnabled). Over water it must be
-- the water level, NOT the seabed — GetTerrainHeight stays the raw elevation.
-- __mapWaterLevel is -10000 while water is disabled (line 436), so the max is a
-- no-op there, exactly matching the engine's mWaterEnabled=false branch.
function GetSurfaceHeight(x, z)
  local h = GetTerrainHeight(x, z)
  local w = __mapWaterLevel or -10000
  if w > h then return w end
  return h
end

-- GetTerrainType(x, z) — `Moho::STIMap::GetTerrainType` (Cfile:1087694-1087707).
--
-- Die Engine macht dreierlei, und der zweite Punkt ist der ueberraschende:
--
--   1. ausserhalb der Karte (`x >= width-1` oder `z >= height-1`) ist der Index
--      fest **1** (Cfile:1087702-1087703) — nicht 0;
--   2. sonst ist er das Byte der Terrain-Typ-Ebene an dieser Zelle
--      (`mTerrainType.data[x + z * width]`, Cfile:1087705);
--   3. nachgeschlagen wird `mTerrainTypes.ttvec.start[index]` — ein C++-Vektor,
--      indiziert nach TYPCODE, nicht nach Listenposition. terrainTypes.lua:8
--      sagt es selbst: „Each terrain type has a type code that must be unique,
--      with a max of 255", und die Bereiche beginnen bei 002.
--
-- Damit ergibt der Randfall genau das, was die Datei verspricht: Code 1 ist
-- `TerrainTypes[1]` mit `TypeCode = 1` und `Name = 'Default'`
-- (terrainTypes.lua:126-129) — „Position (-1, -1) will return the 'Default'
-- terrain type" (terrainTypes.lua:15-16). `unit.lua:2421` verlaesst sich darauf.
--
-- Vorher stand hier `return TerrainTypes[1]` fuer JEDE Position. Fuer den
-- Randfall war das zufaellig richtig und fuer jede echte Zelle falsch: die Karte
-- hat eine Typ-Ebene, und sie wurde nie gelesen.
__terrainTypeAt = false
__terrainTypeByCode = false

-- Ein Code OHNE Eintrag ist UNBEKANNT: die Engine indiziert dort ihren Vektor,
-- und ob der 256 Plaetze hat oder nur so viele wie die Liste, steht nicht im
-- Decompilat. Statt zu raten wird gewarnt (einmal je Code) und der Default
-- geliefert — sichtbar, nicht still.
__terrainTypeWarned = {}

function GetTerrainType(x, z)
  if not TerrainTypes then return nil end
  if not __terrainTypeByCode then
    local m = {}
    for _, t in ipairs(TerrainTypes) do
      if t.TypeCode then m[t.TypeCode] = t end
    end
    __terrainTypeByCode = m
  end
  local code = 1
  if __terrainTypeAt and __mapSizeX and x and z
    and x >= 0 and z >= 0 and x < __mapSizeX and z < __mapSizeZ then
    code = __terrainTypeAt(x, z)
  end
  local t = __terrainTypeByCode[code]
  if t then return t end
  if not __terrainTypeWarned[code] then
    __terrainTypeWarned[code] = true
    WARN('GetTerrainType: Typcode ' .. tostring(code) .. ' hat keinen Eintrag in '
      .. 'TerrainTypes; die Engine indiziert dort ihren Vektor (Cfile:1087706), '
      .. 'was sie dabei liefert ist UNBEKANNT. Default zurueckgegeben.')
  end
  return __terrainTypeByCode[1]
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
      apply(u, cmd)
      cmd.units[table.getn(cmd.units) + 1] = u
    end
  end
  return cmd
end

--- IssueMove(units, pos) — a COMMAND, not a direct goal: the engine builds
--- SSTICommandIssueData(UNITCOMMAND_Move) and sends it through
--- UNIT_IssueCommand with clear = 0 (Cfile:1008574), so the command is APPENDED
--- to the queue instead of replacing it. (The player's path is a different one:
--- IssueUnitCommand clears by default, Cfile:1265640.) Only because of this can
--- a factory's rally point wait behind the roll-off command.
function IssueMove(units, pos)
  return issueTo(units, function(u, cmd)
    __issueOrder(u.__id, { type = 'Move', x = pos[1], z = pos[3], cmdId = cmd.id }, false)
  end)
end

--- IssueGuard(units, target) — cfunc_IssueGuardL (Cfile:1008933):
--- SSTICommandIssueData(UNITCOMMAND_Guard) with the target, through
--- UNIT_IssueCommand with clear = 0 (Cfile:1009018) — appended, not replacing.
--- effectutilities.lua:445 sends the Cybran build drones to the construction
--- site with it.
function IssueGuard(units, target)
  local targetId = type(target) == 'table' and target.__id or target
  return issueTo(units, function(u, cmd)
    __issueOrder(u.__id, { type = 'Guard', target = targetId, cmdId = cmd.id }, false)
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
--- A command is done once it sits in NO unit's queue any more — neither
--- running nor waiting. That is exactly what the engine checks: if the
--- CUnitCommandOpt no longer exists, the command is finished (Cfile:1007814).
--- ("Does the unit still have a goal?" would be something else: a NEW command
--- sets a new goal, and the old command is over regardless.)
function IsCommandDone(cmd)
  if not cmd or not cmd.units then return true end
  for _, u in ipairs(cmd.units) do
    if u and not u.__destroyQueued then
      local id = u.__id
      local active = __orderActive[id]
      if active and active.cmdId == cmd.id then return false end
      for _, q in ipairs(__orders[id] or {}) do
        if q.cmdId == cmd.id then return false end
      end
    end
  end
  return true
end

function IssueStop(units)
  return issueTo(units, function(u) __dispatchStop(u.__id) end)
end

--- IssueUpgrade(units, blueprintId) — cfunc_IssueUpgradeL (Cfile:1011315).
--- Exactly two arguments (unit list + blueprint); the engine builds
--- SSTICommandIssueData(UNITCOMMAND_Upgrade) with the blueprint as its target
--- and sends it through UNIT_IssueCommand — WITHOUT clearing the queue
--- (clear = 0, Cfile:1011353). The command becomes a CUnitUpgradeTask
--- (build.lua __issueUpgrade).
function IssueUpgrade(units, blueprintId)
  return issueTo(units, function(u)
    local uid, err = __issueUpgrade(u.__id, blueprintId)
    -- -2 = der Befehl verpufft (schon am Upgraden), -1 = echter Fehler.
    if uid == -1 then WARN('IssueUpgrade: ' .. tostring(err)) end
  end)
end

--- NotifyUpgrade(oldBuilding, newBuilding) — cfunc_NotifyUpgradeL
--- (Cfile:978489). The hand-over at the end of an upgrade: the Lua calls it in
--- UpgradingState.OnStopBuild (defaultunits.lua:264, terranunits.lua:697),
--- BEFORE the old building destroys itself. The engine moves everything from
--- the old building to the new one:
---
---   * the command queue, WITHOUT the upgrade command itself — skipped is
---     exactly the entry of type 27 (UNITCOMMAND_Upgrade) whose target is the
---     blueprint of the NEW building (Cfile:978572-978581)
---   * AI builder commands and the platoon slot (Cfile:978602-978634) — the sim
---     has neither AI builders nor platoons, so there is nothing to move
---   * the repeat-queue flag with OnStartRepeatQueue/OnStopRepeatQueue
---     (Cfile:978635-978646); the sim has no repeat queue
---     (UserUnit:IsRepeatQueue is false)
---   * the HEALTH as a RATIO: new = newMax * (oldHP / oldMax)
---     (Cfile:978648-978652) — a damaged mex stays damaged
---   * the guarded unit and ALL guards of the old building
---     (Cfile:978653-978670)
---
--- Both arguments must be live units, otherwise the engine throws
--- "Passed in invalid source/destination object to upgrade"
--- (Cfile:978553/978557).
function NotifyUpgrade(old, new)
  if type(old) ~= 'table' or not old.__id or old.__dead or old.__destroyed then
    error('Passed in invalid source object to upgrade', 2)
  end
  if type(new) ~= 'table' or not new.__id or new.__dead or new.__destroyed then
    error('Passed in invalid destination object to upgrade', 2)
  end
  local oldId, newId = old.__id, new.__id

  -- The queue: the running command first, then the waiting ones.
  local newBp = (new.__bp and new.__bp.BlueprintId) or ''
  local moved = __orders[newId] or {}
  local function carry(cmd)
    if not cmd then return end
    if cmd.type == 'Upgrade' and (cmd.blueprint or '') == newBp then return end
    moved[#moved + 1] = cmd
  end
  carry(__orderActive[oldId])
  for _, cmd in ipairs(__orders[oldId] or {}) do carry(cmd) end
  __orders[oldId] = nil
  __orderActive[oldId] = nil
  if moved[1] then
    __orders[newId] = moved
    if not __orderActive[newId] then __ordersAdvance(newId) end
  end

  -- Health as a ratio (Cfile:978648-978652).
  local oldMax = old:GetMaxHealth()
  if oldMax > 0 then
    local ratio = (old.__health or 0) / oldMax
    local h = new:GetMaxHealth() * ratio
    -- No instigator — the engine calls Entity::SetHealth directly
    -- (Cfile:978652); this is not damage.
    if h ~= (new.__health or 0) then new:SetHealth(nil, h) end
  end

  -- Guarding: whatever the old building guarded, the new one guards now …
  local g = __guardOrders[oldId]
  if g then
    __guardOrders[oldId] = nil
    __guardOrders[newId] = g
    new.__guardedUnit = old.__guardedUnit
  end
  old.__guardedUnit = false
  -- … and every guard of the old building follows (Cfile:978664-978670).
  for unitId, order in pairs(__guardOrders) do
    if order.target == oldId then
      order.target = newId
      local guard = __units[unitId]
      if guard then guard.__guardedUnit = newId end
    end
  end
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

-- UnitAttributes::commandCapsMask is mutable. The blueprint initializes that
-- mask once, while Unit:AddCommandCap and Unit:RemoveCommandCap subsequently
-- modify the unit instance (faf-re Unit.cpp:8675-8813).
local COMMAND_CAP_BITS = {
  RULEUCC_Move = 0x1,
  RULEUCC_Stop = 0x2,
  RULEUCC_Attack = 0x4,
  RULEUCC_Guard = 0x8,
  RULEUCC_Patrol = 0x10,
  RULEUCC_RetaliateToggle = 0x20,
  RULEUCC_Repair = 0x40,
  RULEUCC_Capture = 0x80,
  RULEUCC_Transport = 0x100,
  RULEUCC_CallTransport = 0x200,
  RULEUCC_Nuke = 0x400,
  RULEUCC_Tactical = 0x800,
  RULEUCC_Teleport = 0x1000,
  RULEUCC_Ferry = 0x2000,
  RULEUCC_SiloBuildTactical = 0x4000,
  RULEUCC_SiloBuildNuke = 0x8000,
  RULEUCC_Sacrifice = 0x10000,
  RULEUCC_Pause = 0x20000,
  RULEUCC_Overcharge = 0x40000,
  RULEUCC_Dive = 0x80000,
  RULEUCC_Reclaim = 0x100000,
  RULEUCC_SpecialAction = 0x200000,
  RULEUCC_Dock = 0x400000,
  RULEUCC_Script = 0x800000,
}

local function commandCapBit(cap)
  if type(cap) == 'number' then return cap end
  return COMMAND_CAP_BITS[cap] or 0
end

local function blueprintCommandCapMask(bp)
  local mask = 0
  local caps = bp and bp.General and bp.General.CommandCaps
  for cap, bit in pairs(COMMAND_CAP_BITS) do
    if caps and caps[cap] == true then mask = mask | bit end
  end
  return mask
end

local TOGGLE_CAP_BITS = {
  RULEUTC_ShieldToggle = 0x1,
  RULEUTC_WeaponToggle = 0x2,
  RULEUTC_JammingToggle = 0x4,
  RULEUTC_IntelToggle = 0x8,
  RULEUTC_ProductionToggle = 0x10,
  RULEUTC_StealthToggle = 0x20,
  RULEUTC_GenericToggle = 0x40,
  RULEUTC_SpecialToggle = 0x80,
  RULEUTC_CloakToggle = 0x100,
}

local function toggleCapBit(cap)
  if type(cap) == 'number' then return cap end
  return TOGGLE_CAP_BITS[cap] or 0
end

local function blueprintToggleCapMask(bp)
  local mask = 0
  local caps = bp and bp.General and bp.General.ToggleCaps
  for cap, bit in pairs(TOGGLE_CAP_BITS) do
    if caps and caps[cap] == true then mask = mask | bit end
  end
  return mask
end

-- mToggleCaps is mutable independently of mCommandCaps. The original bindings
-- request a UI refresh after each mutation (Cfile:975684-975858); synchronizing
-- the mask every beat gives the mirror the same observable result.
function __ensureToggleCapMask(u)
  if not u then return 0 end
  if u.__toggleCapMask == nil then
    u.__toggleCapMask = blueprintToggleCapMask(u.__bp)
  end
  if not u.__toggleCapBindingsInstalled then
    u.__toggleCapBindingsInstalled = true
    u.AddToggleCap = function(self, cap)
      local bit = toggleCapBit(cap)
      if bit ~= 0 then self.__toggleCapMask = __ensureToggleCapMask(self) | bit end
    end
    u.RemoveToggleCap = function(self, cap)
      local bit = toggleCapBit(cap)
      if bit ~= 0 then self.__toggleCapMask = __ensureToggleCapMask(self) & ~bit end
    end
    u.RestoreToggleCaps = function(self)
      self.__toggleCapMask = blueprintToggleCapMask(self.__bp)
    end
    -- Despite the mutable runtime mask, TestToggleCaps explicitly tests the
    -- immutable blueprint field (Cfile:975885-975932).
    u.TestToggleCaps = function(self, cap)
      local bit = toggleCapBit(cap)
      return bit ~= 0 and (blueprintToggleCapMask(self.__bp) & bit) ~= 0
    end
  end
  return u.__toggleCapMask
end

-- The moho bindings mutate this state; keeping the implementation here makes
-- command dispatch observe the exact same instance mask. The bindings are
-- installed on the live unit instead of the blueprint-derived class so all
-- existing derived Unit classes retain their copied method table.
function __ensureCommandCapMask(u)
  if not u then return 0 end
  __ensureToggleCapMask(u)
  if u.__commandCapMask == nil then
    u.__commandCapMask = blueprintCommandCapMask(u.__bp)
  end
  if not u.__commandCapBindingsInstalled then
    u.__commandCapBindingsInstalled = true
    u.AddCommandCap = function(self, cap)
      local bit = commandCapBit(cap)
      if bit ~= 0 then self.__commandCapMask = __ensureCommandCapMask(self) | bit end
    end
    u.RemoveCommandCap = function(self, cap)
      local bit = commandCapBit(cap)
      if bit ~= 0 then self.__commandCapMask = __ensureCommandCapMask(self) & ~bit end
    end
    u.RestoreCommandCaps = function(self)
      self.__commandCapMask = blueprintCommandCapMask(self.__bp)
    end
    -- NOTE: the engine's TestCommandCaps tests the blueprint's TOGGLE caps,
    -- an apparent native copy/paste quirk for a "CommandCaps" test.
    u.TestCommandCaps = function(self, cap)
      local bit = commandCapBit(cap)
      -- Exact native copy/paste quirk: a RULEUCC bit is tested against the
      -- blueprint's ToggleCaps field (Cfile:975662-975663).
      return bit ~= 0 and (blueprintToggleCapMask(self.__bp) & bit) ~= 0
    end
  end
  return u.__commandCapMask
end

-- === Shields (Defense.Shield) ===
-- The shield LOGIC is the original /lua/shield.lua: a ChangeState state machine
-- (OnState/OffState/DamageRechargeState) that absorbs damage, regenerates, and
-- passes overkill to the owner. It runs on our scheduler; the engine supplies
-- only the shield ENTITY here and routes damage through it (damage.lua, the
-- shield-sphere subtraction, Cfile:1062695). Regular Shield, UnitShield
-- (personal) and AntiArtilleryShield all derive from Shield and share this
-- __init binding (_c_CreateShield, shield.lua:20).
function _c_CreateShield(luaobj, spec)
  local owner = spec.Owner
  luaobj.__isShield = true
  luaobj.__army = (owner and owner.__army) or 1
  local op = (owner and owner.__pos) or { 0, 0, 0 }
  luaobj.__pos = { op[1], op[2], op[3] }
  luaobj.__heading = (owner and owner.__heading) or 0
  -- Health comes from OnCreate (SetMaxHealth/SetHealth); start at 0 like the
  -- engine ctor before the script fills it.
  luaobj.__health = 0
  luaobj.__bones = { names = {}, xform = {}, index = {} }
  local id = __nextUnitId
  __nextUnitId = id + 1
  luaobj.__id = id
  return luaobj
end

local function hasCommandCap(u, cap)
  local bit = commandCapBit(cap)
  return bit ~= 0 and (__ensureCommandCapMask(u) & bit) == bit
end

local function isFactory(u)
  local bp = u and u.__bp
  for _, category in ipairs((bp and bp.Categories) or {}) do
    if category == 'FACTORY' then return true end
  end
  return false
end

local function isMobile(u)
  local bp = u and u.__bp
  return u and not u.__immobile and bp and bp.Physics and bp.Physics.MotionType ~= 'RULEUMT_None'
end

-- CAiAttackerImpl::CanAttackTarget leaves per-weapon layer/category checks to
-- UnitWeapon::CanAttackTarget (weapons.lua). Dispatch only rejects orders that
-- cannot ever execute: an invalid source, an allied/dead entity, or no weapon
-- capable of entity/ground attack (faf-re CAiAttackerImpl.cpp:879-893).
local function canAttackTarget(u, target)
  if not u or u.__destroyed or u.__dead or u.__beingBuilt or not hasCommandCap(u, 'RULEUCC_Attack') then
    return false
  end
  if target and (target.__destroyed or target.__dead or IsAlly(u.__army, target.__army)) then
    return false
  end
  for _, weapon in ipairs(u.__weapons or {}) do
    local bp = weapon.__bp or {}
    if not weapon.__destroyed and (target or not bp.CannotAttackGround) then return true end
  end
  return false
end

local function categoryTermsMatch(terms, targetCategories)
  if terms == nil then return false end
  if type(terms) == 'string' or (type(terms) == 'table' and terms.__cat) then
    return catTest(ParseEntityCategory(terms), targetCategories)
  end
  for _, term in ipairs(terms) do
    if catTest(ParseEntityCategory(term), targetCategories) then return true end
  end
  return false
end

local function appendCategoryTerm(terms, category)
  if category == nil then return end
  for _, existing in ipairs(terms) do
    if existing == category then return end
  end
  terms[table.getn(terms) + 1] = category
end

local function removeCategoryTerm(terms, category)
  for i, existing in ipairs(terms) do
    if existing == category then table.remove(terms, i); return end
  end
end

-- CArmyImpl stores army restrictions as an inverted build-allow filter. The
-- equivalent port state is a category deny-list; it has the same CanBuild
-- result and is changed by the original global Lua bindings.
__armyBuildRestrictions = {}
function AddBuildRestriction(army, category)
  local restrictions = __armyBuildRestrictions[army]
  if not restrictions then restrictions = {}; __armyBuildRestrictions[army] = restrictions end
  appendCategoryTerm(restrictions, category)
end

function RemoveBuildRestriction(army, category)
  local restrictions = __armyBuildRestrictions[army]
  if restrictions then removeCategoryTerm(restrictions, category) end
end

-- Unit::CanBuild checks the army filter, the builder blueprint cache, then the
-- per-unit restriction cache in that order (faf-re Unit.cpp:12386-12398).
local function canBuildBlueprint(u, bp)
  if not u or not bp then return false end
  local targetCategories = bpCategorySet(bp)
  if categoryTermsMatch(__armyBuildRestrictions[u.__army], targetCategories) then return false end
  local builderCategories = u.__bp and u.__bp.Economy and u.__bp.Economy.BuildableCategory
  if not categoryTermsMatch(builderCategories, targetCategories) then return false end
  return not categoryTermsMatch(u.__buildRestrictions, targetCategories)
end

-- Restriction-only gate for the primary build path (build.lua __factoryTick):
-- the builder's own BuildableCategory is already enforced by what the queue
-- accepts, so here only the army deny-list (AddBuildRestriction) and the
-- per-unit restriction cache block production — Unit::CanBuild consults the army
-- filter first (faf-re Unit.cpp:12386-12398).
function __isBuildRestricted(u, bpId)
  local bp = __registered and __registered.Unit and __registered.Unit[string.lower(tostring(bpId))]
  if not u or not bp then return false end
  local targetCategories = bpCategorySet(bp)
  if categoryTermsMatch(__armyBuildRestrictions[u.__army], targetCategories) then return true end
  return categoryTermsMatch(u.__buildRestrictions, targetCategories)
end

local function factoryBuildCategoriesIntersect(a, b)
  local aCategories = a.__bp and a.__bp.Economy and a.__bp.Economy.BuildableCategory
  local bCategories = b.__bp and b.__bp.Economy and b.__bp.Economy.BuildableCategory
  if not aCategories or not bCategories then return false end
  for _, bp in pairs((__registered and __registered.Unit) or {}) do
    local targetCategories = bpCategorySet(bp)
    if categoryTermsMatch(aCategories, targetCategories) and categoryTermsMatch(bCategories, targetCategories) then
      return true
    end
  end
  return false
end

-- Sim::ValidateUnitCommand applies Guard rules after it resolves the target
-- (faf-re Sim.cpp:5580-5611). Entity guard can be valid for an immobile
-- factory; point guard requires a mobile source.
local function canGuardTarget(u, target)
  if not u or u.__destroyed or u.__dead or not hasCommandCap(u, 'RULEUCC_Guard') then return false end
  if not target then return isMobile(u) end
  if target.__destroyed or target.__dead or target == u then return false end
  if not isMobile(u) and not isMobile(target) and isFactory(u) and isFactory(target)
    and not factoryBuildCategoriesIntersect(u, target) then
    return false
  end
  if isFactory(u) and not isFactory(target) then return false end
  return target.__guardedUnit ~= u.__id
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
      if not canAttackTarget(u, nil) then return false end
      __attackOrders[unitId] = { cmd.gx, GetSurfaceHeight(cmd.gx, cmd.gz), cmd.gz }
      return true
    end
    local t = __units[cmd.target]
    if not canAttackTarget(u, t) then return false end
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
    -- The reclaim target is usually a PROP (wreck/tree), but a live UNIT is a
    -- valid target too (the engine reclaims a being-built enemy structure a
    -- selection cannot attack, dispatch 0x13 CUnitReclaimTask, Cfile:1240271).
    local t = __props[cmd.target] or __units[cmd.target]
    if not t or t.__destroyed or t.__dead or t.__destroyQueued then return false end
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
    elseif u.__dead or u.__destroyQueued then
      -- Nothing. Dispatch runs only while !IsDead
      -- (IAiCommandDispatchImpl::TaskTick, Cfile:746583-746586), so a dying
      -- unit's command simply is not ticked: it is neither advanced nor
      -- completed nor popped. The queue is deliberately NOT cleared either —
      -- the unit is inside its multi-beat DeathThread (unit.lua:1200-1241) and
      -- the `__destroyed` branch above does the cleanup when it ends.
      -- Doing anything else here (stopping the navigator, clearing the goal)
      -- would be an invented action: the engine takes no such step.
    else
      local done = false
      if cmd.type == 'Move' then
        -- Speed-through this leg when a further Move/Patrol is queued behind it
        -- (NextCommand chain, Cfile:955444): the unit flows through the goal cell
        -- at MaxSpeed instead of braking; only the FINAL leg stops. Off otherwise.
        local nxt = __orders[unitId] and __orders[unitId][1]
        local through = nxt ~= nil and (nxt.type == 'Move' or nxt.type == 'Patrol')
        u:GetNavigator():SetSpeedThroughGoal(through and 1 or 0)
        done = not u.__goal -- motion.lua sets __goal = false on arrival
      elseif cmd.type == 'Patrol' then
        -- A patrol leg always flows through its waypoint (SetSpeedThroughGoal(1),
        -- Cfile:850088/850132/850199) — the unit never stops at a patrol point.
        u:GetNavigator():SetSpeedThroughGoal(1)
        -- Engage on the way; otherwise the leg completes inside the 1x1
        -- goal cell (the task's SNavGoal box, Cfile:845637-845650) and a
        -- navigator idle AWAY from it (after a kill) re-issues the goal
        -- (TaskTick idle path, Cfile:845598-845601).
        -- DOCUMENTED REDUCTION: the engine's patrol tick also auto-REPAIRS a
        -- damaged/being-built ally (Cfile:845611) and auto-RECLAIMS a prop
        -- (Cfile:845620) found within GuardScanRadius along the route. We scan
        -- for enemies only; the repair/reclaim-on-patrol behaviour is not
        -- modelled yet (it would spawn the same repair/reclaim tasks used
        -- elsewhere, gated on an independent GuardScanRadius scan).
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
        -- Guarded unit died (Cfile:839365) — but an adopted reclaim task
        -- (sub_612E80) sits ABOVE the guard on the engine's task stack and
        -- must finish first, or the next queued order would fight
        -- __reclaimTick over the unit's movement goal.
        done = __guardOrders[unitId] == nil and __reclaimTasks[unitId] == nil
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
  -- A factory's production queue IS part of the CUnitCommandQueue: the entries
  -- are UNITCOMMAND_BuildFactory commands read out of mUnit->mCommandQueue
  -- (Cfile:838000-838062), and ClearCommandQueue removes EVERY command without
  -- exception (Cfile:1005371-1005399). The UI's Stop button reaches us through
  -- ISSUE_Command(mSelection, UNITCOMMAND_Stop, clear = 1) (Cfile:1255059-1255063),
  -- so the queue goes with it — leaving it behind meant Stop visibly did
  -- nothing to a producing factory.
  u.__buildQueue = nil
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
  local u = __units[unitId]
  local target = __units[targetId]
  if canAttackTarget(u, target) then
    __issueOrder(unitId, { type = 'Attack', target = targetId }, clear)
  end
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
  local u = __units[unitId]
  if canAttackTarget(u, nil) then
    __issueOrder(unitId, { type = 'Attack', gx = x, gz = z }, clear)
  end
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
  if not canGuardTarget(u, t) then return false end
  __guardOrders[unitId] = { target = targetId, mode = guardMode(u, t), clock = 0 }
  u.__guardedUnit = targetId
  return true
end

--- One guard decision, in the decomp's Processing priority order
--- (Cfile:839432-839516). Air-platform refuel, ferry beacons and the
--- active enemy chase (GetBestEnemy) are named gaps — our sim has no
--- refuel/ferry yet and free weapon acquisition already covers nearby
--- enemies.
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
    local from, bpId = nil, nil
    -- CUnitGuardTask scans every eligible BuildFactory command and only
    -- removes/decrements one after Unit::CanBuild has accepted its blueprint
    -- (Cfile:837988-838049; faf-re CUnitGuardTask.cpp:1018-1047).
    for i, queued in ipairs(q) do
      local count = queued.count or 1
      if i > 1 or count > 1 then
        local candidateId = queued.id
        local bp = __registered and __registered.Unit and __registered.Unit[string.lower(candidateId)]
        if canBuildBlueprint(u, bp) then
          from, bpId = i, candidateId
          break
        end
      end
    end
    if not from then return end
    if (q[from].count or 1) > 1 then
      q[from].count = q[from].count - 1
    else
      table.remove(q, from)
    end
    __queueFactoryBuild(unitId, bpId, 1)
    return
  end

  -- A guard that is itself mid-reclaim stays on it — the engine's spawned
  -- CUnitReclaimTask preempts the guard task until the target is gone.
  if __reclaimTasks and __reclaimTasks[unitId] then return end

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
    -- Reclaim assist (sub_612E80, Cfile:838256-838314): a guard with unit
    -- category RECLAIM joins the guarded unit's RUNNING reclaim — the
    -- guarded unit must be IsUnitState(Reclaiming) (enum 28, AddEnum
    -- Cfile:702962ff) and its focus entity (unit+1232, set by the reclaim
    -- task, Cfile:848750) becomes the guard's own target: the caller
    -- issues a reclaim task on it (sub_613A10 -> IssueReclaimTask,
    -- Cfile:838814-838824).
    local guardedReclaim = __reclaimTasks and __reclaimTasks[g.target]
    if guardedReclaim and unitInCat(u, 'RECLAIM') then
      local prop = __props[guardedReclaim.target]
      if prop and not prop.__destroyed and not prop.__destroyQueued then
        __reclaimTasks[unitId] = { target = guardedReclaim.target, started = false }
        return
      end
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

--- Reclaim a MAP prop by its scmap index — the browser picks map props
--- from the instanced renderer and only knows the instance index; the
--- sim prop id lives in __mapPropIds (props.lua).
function __dispatchReclaimMapProp(unitId, mapIndex, clear)
  local targetId = __mapPropIds[mapIndex]
  if not targetId then
    WARN('reclaim: no sim prop for map index ' .. tostring(mapIndex))
    return
  end
  __dispatchReclaim(unitId, targetId, clear)
end

function __reclaimTick()
  for unitId, task in pairs(__reclaimTasks) do
    local u = __units[unitId]
    -- A reclaim target is a PROP (wreck/tree) or a live UNIT (a being-built
    -- enemy structure the selection cannot attack, Cfile:1240271).
    local t = __props[task.target] or __units[task.target]
    local isUnit = t ~= nil and __props[task.target] == nil
    if not u or u.__dead or u.__destroyQueued
      or not t or t.__destroyed or t.__dead or t.__destroyQueued then
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
          local ok, time, energy, mass
          if isUnit then
            -- A unit's reclaim cost from the target blueprint (unit.lua:2705-
            -- 2713): time = max(BuildCostEnergy, BuildCostMass) / the reclaimer's
            -- BUILD RATE * (ReclaimTimeMultiplier or 1), returned as time/10;
            -- ticks below multiply by 10 again. The rate is u:GetBuildRate() (the
            -- runtime __buildRate from SetBuildRate/enhancements, moho.lua:715),
            -- NOT the static blueprint value.
            local eco = (t.__bp and t.__bp.Economy) or {}
            mass = eco.BuildCostMass or 0
            energy = eco.BuildCostEnergy or 0
            local buildRate = u:GetBuildRate()
            if buildRate <= 0 then buildRate = 1 end
            time = math.max(mass, energy) / buildRate * (u.ReclaimTimeMultiplier or 1) / 10
            ok = true
          else
            ok, time, energy, mass = pcall(function() return t:GetReclaimCosts(u) end)
          end
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
          -- Reclaim is a SEPARATE display counter in the original (mTotals.
          -- mReclaimed), ON TOP OF the storage credit above — the engine writes
          -- to both places (Cfile:848614-848639). __econReclaim feeds
          -- GetEconomyTotals().reclaimed; income stays untouched.
          __econReclaim(u.__army or 1, live.mass * delta, live.energy * delta)
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
  local u = __units[unitId]
  local target = __units[targetId]
  if canGuardTarget(u, target) then
    __issueOrder(unitId, { type = 'Guard', target = targetId }, clear)
  end
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

-- ── Sprache: in der SIM absichtlich leer ─────────────────────────────────────
--
-- `HasLocalizedVO` und `AudioSetLanguage` sind in BEIDEN VMs registriert
-- (engine-api.md:45 und :104), aber die Sim-Fassungen tun nachweislich nichts:
-- `cfunc_HasLocalizedVOSim` (Cfile:1090520-1090533) und
-- `cfunc_AudioSetLanguageSim` (Cfile:1090484-1090497) pruefen beide nur die
-- Argumentzahl (genau 1, sonst Fehler) und machen dann `return 0` — sie legen
-- KEINEN Rueckgabewert ab.
--
-- Fuer `localization.lua:43` heisst das: `HasLocalizedVO(la)` ist nil, der
-- `else`-Zweig greift, und `AudioSetLanguage('us')` verpufft. Ton ist Sache der
-- UI-VM.
--
-- Das ist der Unterschied zu einem stillen Stub: hier IST Nichtstun das
-- Verhalten der Engine, und die Fundstelle steht daneben. Die Argumentpruefung
-- kommt mit, weil sie Teil davon ist.
function HasLocalizedVO(language)
  if language == nil then error('HasLocalizedVO(language) -- expected 1 args, but got 0', 2) end
end

function AudioSetLanguage(language)
  if language == nil then error('AudioSetLanguage(language) -- expected 1 args, but got 0', 2) end
end

-- ── Rohstoff-Lagerstaetten ───────────────────────────────────────────────────
--
-- `CreateResourceDeposit(type, x, y, z, size)` (cfunc_CreateResourceDepositL,
-- Cfile:687704-687772). Genau FUENF Argumente, sonst wirft die Engine
-- (Cfile:687704-687706). Die Zuordnung im Decompilat ist verdreht lesbar, aber
-- eindeutig: Argument 2 -> `pos.x`, 3 -> `pos.y`, 4 -> `pos.z`
-- (Cfile:687718-687738), Argument 5 -> ein quadratisches `Vector2i{size, size}`
-- (Cfile:687744-687752). Am Ende `AddDepositPoint(typ, pos, size)`
-- (Cfile:687769).
--
-- Der Typ wird im Original in einem String-Array nachgeschlagen; ist er
-- unbekannt, LOGGT die Engine `"unknown resource deposit type: %s"` und nimmt
-- Index 0 (Cfile:687753-687767) — sie bricht NICHT ab.
--
-- **Die Enum-Werte sind UNBEKANNT.** IDA zeigt nur den Container
-- `resource_deposit_t`, nicht seine Zeichenketten (Cfile:422326). Deshalb wird
-- hier der STRING gespeichert und keine Zahl erfunden. Benutzt werden ohnehin
-- nur zwei: `Mass` und `Hydrocarbon` (markertemplates.lua:9-23, beide
-- `resource = true`).
--
-- Was die Engine damit tut, haben wir NICHT: `CSimResources` speist die
-- Bauplatzpruefung, damit ein Extraktor nur auf einer Lagerstaette stehen darf.
-- Hier wird bis auf Weiteres nur GESAMMELT — und nichts liest es, ausser der
-- Pruefung. Das ist eine Luecke, keine Implementierung.
__resourceDeposits = {}

function CreateResourceDeposit(depositType, x, y, z, size)
  if depositType == nil or x == nil or y == nil or z == nil or size == nil then
    error('CreateResourceDeposit(type,x,y,z,size) -- expected 5 args', 2)
  end
  if type(depositType) ~= 'string' then error('CreateResourceDeposit: string expected', 2) end
  for _, n in ipairs({ 'x', 'y', 'z', 'size' }) do
    local v = ({ x = x, y = y, z = z, size = size })[n]
    if type(v) ~= 'number' then error('CreateResourceDeposit: number expected for ' .. n, 2) end
  end
  if depositType ~= 'Mass' and depositType ~= 'Hydrocarbon' then
    -- Wie die Engine: melden und weitermachen (Cfile:687767).
    LOG('unknown resource deposit type: ' .. depositType)
  end
  __resourceDeposits[#__resourceDeposits + 1] =
    { type = depositType, x = x, y = y, z = z, size = size }
end

--- Wie viele Lagerstaetten eines Typs bisher angelegt wurden (fuer die Pruefung).
function __countResourceDeposits(depositType)
  local n = 0
  for _, d in ipairs(__resourceDeposits) do
    if depositType == nil or d.type == depositType then n = n + 1 end
  end
  return n
end
