-- =====================================================================
-- PROJEKTILE — die Engine-Seite.
--
-- Aufteilung wie im Original (docs/research/combat-projectiles.md §1):
--   Engine: erzeugen, fliegen (Moho::Projectile::MotionTick), Treffer erkennen
--           (Projectile::CheckCollision), Einschlag melden (RunScript "OnImpact")
--   Lua:    /lua/sim/Projectile.lua + das <id>_script.lua des Blueprints —
--           Effekte, Schaden anrichten (DoDamage), Sound
--
-- Die Lua entscheidet NICHTS ueber Flugbahn und Treffer. Sie bekommt sie gesagt.
--
-- Belege (Cfile = IDA-Decomp):
--   PROJ_Create                       Cfile:946751-946800
--   Projectile::Projectile (Ctor)     Cfile:943313-944010
--   Projectile::MotionTick            Cfile:944040-944290   (dt = 0.1)
--   Projectile::Impact                Cfile:944692-944745   (OnImpact: 2 Args)
--   func_OnCollisionCheck             Cfile:945766-945830   (1 Arg, bool)
--   EImpactType                       Cfile:640486-640525
--   func_FindBlueprintScriptModule    Cfile:914189-914360
--
-- STANDARD-LUA 5.4 (geht roh in host.eval, nicht durch den FA-Transpiler).
-- =====================================================================

__projectiles = {}

-- EImpactType (Cfile:640486-640525) — die Strings, die Projectile.lua:310-345
-- abfragt (ENT_GetImpactTypeString, Cfile:917363-917400).
local IMPACT_TERRAIN = 'Terrain'
local IMPACT_WATER = 'Water'
local IMPACT_AIR = 'Air'
local IMPACT_UNDERWATER = 'Underwater'
local IMPACT_UNIT = 'Unit'
local IMPACT_UNIT_AIR = 'UnitAir'
local IMPACT_UNIT_UNDERWATER = 'UnitUnderwater'

--- Welche Lua-Klasse ein Blueprint bekommt (func_FindBlueprintScriptModule,
--- Cfile:914189-914360). Fuer Projektile:
---   1. Default: /lua/sim/projectile.lua, Klasse "Projectile"
---   2. bp.ScriptModule, sonst aus bp.Source: bis zum LETZTEN '_' abschneiden
---      und '_script.lua' anhaengen
---      /projectiles/TDFGauss01/TDFGauss01_proj.bp
---        -> /projectiles/TDFGauss01/TDFGauss01_script.lua
---   3. Klassenname: bp.ScriptClass, sonst "TypeClass"
---   4. Datei fehlt -> Default aus (1)
local function projectileClass(bp)
  local path = bp.ScriptModule
  if not path or path == '' then
    local src = bp.Source or bp.BlueprintId or ''
    local cut = string.match(src, '^(.*)_[^_/]*$')
    if cut then path = cut .. '_script.lua' end
  end
  if path and exists(path) then
    local ok, mod = pcall(import, path)
    if ok and mod then
      local cls = mod[bp.ScriptClass or 'TypeClass']
      if cls then return cls end
    end
  end
  return import('/lua/sim/Projectile.lua').Projectile
end

--- Gleichverteilung um einen Mittelwert (der Ctor zieht TurnRate/MaxSpeed/
--- Acceleration/InitialSpeed je mit ±Range, Cfile:943520-943660).
local function jitter(mid, range)
  if not range or range == 0 then return mid or 0 end
  return (mid or 0) + (Random() * 2 - 1) * range
end

--- Moho::PROJ_Create — ein Projektil in die Welt setzen.
---
--- launcher: die Entity, die schiesst (Unit oder Waffe -> deren Unit)
--- pos/quat: Startpose in der WELT
--- speed:    Betrag der Anfangsgeschwindigkeit (nil = InitialSpeed aus dem bp)
--- ignoresAlly: das Projektil fliegt durch VERBUENDETE hindurch. PROJ_Create
---   bekommt es als Parameter (Cfile:946751); Entity:CreateProjectile uebergibt
---   fest 1 (Cfile:930895), die Waffe ihr Blueprint-Feld IgnoresAlly (Default 1,
---   weapons.md:599). nil heisst hier: ignorieren (der Engine-Default).
function __projCreate(launcher, bpId, pos, quat, speed, damage, damageRadius, damageType, target, ignoresAlly)
  local key = string.lower(tostring(bpId))
  local bp = __registered.Projectile[key]
  if not bp then
    -- Genau die Meldung der Engine (Cfile:930793) — kein stiller Fehlschlag.
    error('CreateProjectile: Invalid blueprint ' .. tostring(bpId), 2)
  end

  local phys = bp.Physics
  local cls = projectileClass(bp)
  local p = cls()

  local id = __nextUnitId
  __nextUnitId = id + 1

  p.__isProj = true
  p.__bp = bp
  p.__id = id
  p.__army = (launcher and launcher.__army) or 1
  p.__brain = launcher and launcher.__brain
  p.__launcher = launcher
  p.__pos = { pos[1], pos[2], pos[3] }
  p.__orient = { quat[1], quat[2], quat[3], quat[4] }
  p.__bones = { names = {}, xform = {}, index = {} }
  p.__health = 1
  p.__fraction = 1

  -- Flugparameter aus dem Blueprint (die Defaults setzt die Engine im
  -- Struct-Ctor, siehe blueprints.lua __projDefaults).
  p.__turnRate = jitter(phys.TurnRate, phys.TurnRateRange)       -- GRAD/Sekunde
  p.__maxSpeed = jitter(phys.MaxSpeed, phys.MaxSpeedRange)
  p.__accel = jitter(phys.Acceleration, phys.AccelerationRange)
  p.__trackTarget = phys.TrackTarget == true
  p.__velocityAlign = phys.VelocityAlign ~= false
  p.__stayUpright = phys.StayUpright == true
  p.__collideSurface = phys.CollideSurface ~= false
  p.__collideEntity = phys.CollideEntity ~= false
  p.__destroyOnWater = phys.DestroyOnWater == true
  -- Verbuendete ueberfliegen (PROJ_Create-Parameter, Default 1). Ohne diesen
  -- Filter starb jeder Schuss einer bauenden ACU in ihrer EIGENEN Baustelle,
  -- die direkt neben ihr steht — der Feind blieb unversehrt.
  p.__ignoresAlly = ignoresAlly ~= false
  p.__target = target
  p.__damage = damage or 0
  p.__damageRadius = damageRadius or 0
  p.__damageType = damageType or 'Normal'

  -- mBallisticAcc = Gravitation * UseGravity (Cfile:943663-943668). Die
  -- Gravitationskonstante der Sim: 4.9 Weltmeter/s^2 (PhysConstants).
  p.__ballistic = { 0, (phys.UseGravity ~= false) and -__simGravity or 0, 0 }

  -- Lebensdauer in TICKS (Cfile:943680: curTick + (Lifetime ± Range) * 10).
  p.__lifetimeEnd = __gameTick + math.floor(jitter(phys.Lifetime, phys.LifetimeRange) * 10)

  -- Startgeschwindigkeit: Vorwaertsachse der Startpose * InitialSpeed
  -- (Cfile:943842-943854).
  local v0 = speed
  if not v0 then v0 = jitter(phys.InitialSpeed, phys.InitialSpeedRange) end
  local fwd = __quatForward(p.__orient)
  p.__vel = { fwd[1] * v0, fwd[2] * v0, fwd[3] * v0 }

  p.__impactType = false
  p.Trash = TrashBag()
  __projectiles[id] = p

  -- OnPreCreate, dann OnCreate(inWater) — EIN Argument (Cfile:943988). Genau das
  -- erwartet z. B. TDFGauss01_script.lua:OnCreate(self, inWater).
  local inWater = p.__pos[2] < __waterLevel()
  if inWater and p.__destroyOnWater then
    p:Destroy()
    return p
  end
  if p.OnPreCreate then pcall(function() p:OnPreCreate() end) end
  local ok, err = pcall(function() p:OnCreate(inWater) end)
  if not ok then WARN('Projektil ' .. tostring(bp.BlueprintId) .. ': OnCreate — ' .. tostring(err)) end
  return p
end

--- Der Wasserspiegel der Karte. Ohne geladene Karte: 0 (kein Wasser).
function __waterLevel()
  return __mapWaterLevel or 0
end

-- ---------------------------------------------------------------------
-- Der Einschlag (Moho::Projectile::Impact, Cfile:944692-944745)
-- ---------------------------------------------------------------------
local function impact(p, kind, target)
  p.__impactType = false
  if p.__destroyed then return end
  local ok, err = pcall(function() p:OnImpact(kind, target) end)
  if not ok then
    WARN('Projektil OnImpact(' .. tostring(kind) .. ') — ' .. tostring(err))
    p:Destroy()
  end
end

-- ---------------------------------------------------------------------
-- Kollision (Projectile::CheckCollision, @0x69D1D0 — NICHT dekompilierbar).
--
-- Was gesichert ist (Aufrufliste der Funktion): ein GESWEEPTER Strecken-Test von
-- der alten zur neuen Position (COGrid::GetEntityCollisionsInLine +
-- Wm3::DistVector3Segment3f::GetSquared), Terrain aus dem Heightfield
-- (CHeightField::Intersection), und der Lua-Filter self:OnCollisionCheck(other)
-- mit EINEM Argument.
--
-- ANNAHME, ausdruecklich benannt: wir pruefen Abstand Strecke<->Mittelpunkt gegen
-- den Bounding-Radius der Unit (aus SizeX/SizeY/SizeZ). Ob die Engine das
-- Kollisionsvolumen (Box/Sphere) nimmt, ist nicht belegt
-- (docs/research/combat-projectiles.md §9).
-- ---------------------------------------------------------------------
--- Die Kollisionskugel einer Unit: Mittelpunkt = KOERPERMITTE (Fuesse + SizeY/2),
--- Radius aus dem Kollisionsquader SizeX/Y/Z (Weltmeter, uel0001: 1/2/0.7).
---
--- Der Mittelpunkt ist nicht Kosmetik: `u.__pos` sind die FUESSE der Einheit.
--- Ein Schuss, der auf Koerperhoehe vorbeifliegt, war von den Fuessen weiter
--- entfernt als der Radius — Punkt-Blank-Schuesse gingen "durch" die Einheit.
--- (Die Engine sweept gegen das Kollisionsvolumen, CheckCollision @0x69D1D0 ist
--- nicht dekompilierbar — die Kugel um die Koerpermitte ist die benannte
--- Naeherung, combat-projectiles.md §9.)
function __unitCollision(u)
  local bp = u.__bp
  local sy = bp.SizeY or 1
  local r = math.max(bp.SizeX or 1, bp.SizeZ or 1, sy) * 0.5
  local p = u.__pos
  return { p[1], p[2] + sy * 0.5, p[3] }, math.max(r, 0.5)
end

--- Quadrierter Abstand Punkt <-> Strecke.
local function distSqSegment(a, b, c)
  local abx, aby, abz = b[1] - a[1], b[2] - a[2], b[3] - a[3]
  local acx, acy, acz = c[1] - a[1], c[2] - a[2], c[3] - a[3]
  local len = abx * abx + aby * aby + abz * abz
  local t = 0
  if len > 0 then
    t = (acx * abx + acy * aby + acz * abz) / len
    if t < 0 then t = 0 elseif t > 1 then t = 1 end
  end
  local dx = acx - abx * t
  local dy = acy - aby * t
  local dz = acz - abz * t
  return dx * dx + dy * dy + dz * dz
end

--- Trifft das Projektil auf seinem Weg von `from` nach `to` etwas?
--- Liefert Art des Einschlags + getroffene Entity (oder nil).
local function checkCollision(p, from, to)
  -- 1. Entities. Die Engine fragt die Lua VOR der Kollision: OnCollisionCheck.
  if p.__collideEntity then
    -- VERBUENDETE ueberfliegen: PROJ_Create bekommt `ignoresAlly` (Default 1,
    -- Cfile:930895; Waffen-Blueprint IgnoresAlly, weapons.md:599). Nur wenn die
    -- DamageData ausdruecklich CollideFriendly sagt (weapon.lua:294, Default
    -- false; die Engine fragt Projectile.lua:407 GetCollideFriendly), kollidiert
    -- das Projektil doch mit eigenen Einheiten.
    local hitsAllies = not p.__ignoresAlly
      or (p.DamageData and p.DamageData.CollideFriendly == true)
    local army = p.__army

    for id, u in pairs(__units) do
      if not u.__destroyed and u ~= p.__launcher
        and (hitsAllies or not IsAlly(u.__army, army)) then
        local center, r = __unitCollision(u)
        if distSqSegment(from, to, center) <= r * r then
          -- Der Lua-Filter (func_OnCollisionCheck, Cfile:945766): liefert er
          -- false, fliegt das Projektil weiter (Freund-Beschuss, Flares, …).
          local pass = true
          if p.OnCollisionCheck then
            local ok, res = pcall(function() return p:OnCollisionCheck(u) end)
            if ok then pass = res ~= false end
          end
          if pass then
            local under = u.__pos[2] < __waterLevel()
            local kind = IMPACT_UNIT
            if under then kind = IMPACT_UNIT_UNDERWATER
            elseif u.__layer == 'Air' then kind = IMPACT_UNIT_AIR end
            return kind, u
          end
        end
      end
    end
  end

  -- 2. Boden/Wasser. Terrain kommt aus dem Heightfield, Wasser aus der Ebene.
  if p.__collideSurface then
    local ground = GetSurfaceHeight(to[1], to[3])
    if to[2] <= ground then return IMPACT_TERRAIN, nil end
    local water = __waterLevel()
    if water > 0 and from[2] > water and to[2] <= water then
      return IMPACT_WATER, nil
    end
  end
  return nil, nil
end

-- ---------------------------------------------------------------------
-- Moho::Projectile::MotionTick (Cfile:944040-944290) — pro Tick, dt = 0.1 s.
--
-- Zwei Dinge, die man nicht raten darf:
--   * die Integration ist TRAPEZFOERMIG: pos += (v_alt + v_neu) * 0.05
--     (Cfile:944219-944228). Naives Euler verschiebt jede Flugbahn.
--   * TurnRate ist GRAD/Sekunde und wirkt auch OHNE TrackTarget: sie begrenzt,
--     wie schnell sich die Ausrichtung an die Geschwindigkeit anpasst
--     (mTurnRateDeg * 0.0017453292 = deg * pi/180 * 0.1 rad/Tick).
-- ---------------------------------------------------------------------
local DEG_PER_SEC_TO_RAD_PER_TICK = 0.0017453292

--- Eine Quaternion zur Flugrichtung drehen, hoechstens `maxAngle` je Tick.
local function alignToVelocity(q, v, maxAngle)
  local len = math.sqrt(v[1] * v[1] + v[2] * v[2] + v[3] * v[3])
  if len < 1e-6 then return q end
  local want = __orientFromDir({ v[1] / len, v[2] / len, v[3] / len })
  if maxAngle <= 0 then return want end
  -- Winkel zwischen den Quaternionen (dot -> cos(theta/2)).
  local dot = q[1] * want[1] + q[2] * want[2] + q[3] * want[3] + q[4] * want[4]
  if dot < 0 then
    want = { -want[1], -want[2], -want[3], -want[4] }
    dot = -dot
  end
  if dot > 0.9999 then return want end
  local theta = 2 * math.acos(math.min(1, dot))
  if theta <= maxAngle then return want end
  -- Slerp mit t = maxAngle / theta.
  local t = maxAngle / theta
  local sinT = math.sin(theta * 0.5)
  local a = math.sin((1 - t) * theta * 0.5) / sinT
  local b = math.sin(t * theta * 0.5) / sinT
  return {
    q[1] * a + want[1] * b, q[2] * a + want[2] * b,
    q[3] * a + want[3] * b, q[4] * a + want[4] * b,
  }
end

--- Eine Quaternion, deren +Z-Achse in Richtung `d` zeigt (COORDS_Orient).
function __orientFromDir(d)
  local dx, dy, dz = d[1], d[2], d[3]
  -- Rotation von (0,0,1) nach d.
  local dot = dz -- (0,0,1) . d
  if dot > 0.999999 then return { 1, 0, 0, 0 } end
  if dot < -0.999999 then return { 0, 0, 1, 0 } end -- 180 Grad um Y
  -- Achse = (0,0,1) x d
  local ax, ay = -dy, dx
  local w = 1 + dot
  local n = math.sqrt(ax * ax + ay * ay + w * w)
  return { w / n, ax / n, ay / n, 0 }
end

function __projectileTick()
  for id, p in pairs(__projectiles) do
    if p.__destroyed then
      __projectiles[id] = nil
    elseif p.__impactType then
      -- Der Aufschlag wird im NAECHSTEN Tick aufgeloest (mImpactInterp >= 0,
      -- Cfile:944110-944116).
      local kind, target = p.__impactType, p.__impactTarget
      p.__impactTarget = nil
      impact(p, kind, target)
    else
      local v = p.__vel
      local vOld = { v[1], v[2], v[3] }

      if not p.__trackTarget then
        v[1] = v[1] + p.__ballistic[1] * 0.1
        v[2] = v[2] + p.__ballistic[2] * 0.1
        v[3] = v[3] + p.__ballistic[3] * 0.1
      end
      -- Beschleunigung entlang der eigenen Achse.
      if p.__accel ~= 0 then
        local f = __quatForward(p.__orient)
        v[1] = v[1] + f[1] * p.__accel * 0.1
        v[2] = v[2] + f[2] * p.__accel * 0.1
        v[3] = v[3] + f[3] * p.__accel * 0.1
      end
      if p.__velocityAlign then
        p.__orient = alignToVelocity(
          p.__orient, v, (p.__turnRate or 0) * DEG_PER_SEC_TO_RAD_PER_TICK
        )
      end
      if p.__maxSpeed and p.__maxSpeed ~= 0 then
        local len = math.sqrt(v[1] * v[1] + v[2] * v[2] + v[3] * v[3])
        if len > p.__maxSpeed then
          local s = p.__maxSpeed / len
          v[1], v[2], v[3] = v[1] * s, v[2] * s, v[3] * s
        end
      end

      -- TRAPEZ (Cfile:944219-944228).
      local from = { p.__pos[1], p.__pos[2], p.__pos[3] }
      local to = {
        from[1] + (vOld[1] + v[1]) * 0.05,
        from[2] + (vOld[2] + v[2]) * 0.05,
        from[3] + (vOld[3] + v[3]) * 0.05,
      }

      local kind, target = checkCollision(p, from, to)
      p.__pos = to
      if kind then
        p.__impactType = kind
        p.__impactTarget = target
        p.__pos = to
      elseif __gameTick >= p.__lifetimeEnd then
        -- Lebensdauer abgelaufen: Air bzw. Underwater (Cfile:944284-944289).
        p.__impactType = (to[2] < __waterLevel()) and IMPACT_UNDERWATER or IMPACT_AIR
      end
    end
  end
end

--- Der Zustand aller Projektile als JSON — der Renderer zeichnet sie.
--- (Kein Rueckgabewert nach JS: eine Lua-Tabelle bliebe im wasmoon-Registry
--- haengen, siehe units.lua.)
function __readAllProjectilesJson()
  local parts = {}
  local n = 0
  for id, p in pairs(__projectiles) do
    if not p.__destroyed then
      n = n + 1
      local pos = p.__pos
      local q = p.__orient
      parts[n] = string.format(
        '{"id":%d,"bp":%q,"x":%.6g,"y":%.6g,"z":%.6g,"qw":%.6g,"qx":%.6g,"qy":%.6g,"qz":%.6g}',
        id, tostring(p.__bp.BlueprintId), pos[1], pos[2], pos[3], q[1], q[2], q[3], q[4]
      )
    end
  end
  return '[' .. table.concat(parts, ',') .. ']'
end
