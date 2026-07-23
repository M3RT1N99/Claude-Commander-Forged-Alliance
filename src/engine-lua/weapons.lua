-- =====================================================================
-- WAFFEN — die zwei Engine-Tasks pro Waffe.
--
-- Die Engine haengt an JEDE Waffe zwei Tasks (CAiAttackerImpl::CreateWeapon,
-- Cfile:791794-791828) — aber nur, wenn `ManualFire == false`:
--
--   CAcquireTargetTask::TaskTick  (Cfile:792838)  sucht Ziele
--       Rhythmus: alle ceil(TargetCheckInterval * 10) Ticks
--   CFireWeaponTask::Dispatch     (Cfile:983912)  taktet das Feuern
--       Rhythmus: JEDEN Tick
--
-- Was die Engine dabei NICHT tut: schiessen. `UnitWeapon::Fire` (Cfile:985500)
-- ruft `RunScript("OnFire")` — und mehr nicht. Den Schuss macht die Lua in ihrer
-- Salven-Zustandsmaschine (defaultweapons.lua RackSalvoFiringState:582 ->
-- CreateProjectileAtMuzzle). Wer hier ein Projektil erzeugt, hat die Salven,
-- Muendungen, Nachladezeiten und Effekte des Originals uebergangen.
--
-- STANDARD-LUA 5.4.
-- =====================================================================

--- Das Ziel einer Waffe setzen (Moho::UnitWeapon::SetTarget, Cfile:985364-985494).
---
--- Die Callbacks haengen an der FLANKE, nicht am Aufruf:
---   kein Ziel -> Ziel   ruft OnGotTarget   (Cfile:985494)
---   Ziel -> kein Ziel   ruft OnLostTarget  (Cfile:985364)
--- Beides auf der WAFFE. Wer OnGotTarget bei jedem Tick feuert, startet die
--- Salven-FSM in jedem Tick neu — die Waffe kaeme nie zum Schuss.
function __weaponSetTarget(w, target, groundPos)
  local had = (w.__target ~= nil) or (w.__targetGround ~= nil)
  local has = (target ~= nil) or (groundPos ~= nil)

  w.__target = target
  w.__targetGround = groundPos

  if has and not had then
    w.__shotsAtTarget = 0
    if w.OnGotTarget then
      local ok, err = pcall(function() w:OnGotTarget() end)
      if not ok then WARN('OnGotTarget: ' .. tostring(err)) end
    end
  elseif had and not has then
    if w.OnLostTarget then
      local ok, err = pcall(function() w:OnLostTarget() end)
      if not ok then WARN('OnLostTarget: ' .. tostring(err)) end
    end
  end
end

--- DoInstaHit (Cfile:987034): eine Waffe ohne ProjectileId trifft SOFORT.
--- Die Engine loggt dabei woertlich („no projectile blueprint, doing instahit
--- instead", Cfile:985669).
function __weaponInstaHit(w)
  local bp = w.__bp or {}
  local t = w.__target
  if not t or not t.__pos then return end
  local u = w.__unit
  local p = t.__pos
  Damage(u, u.__pos, t, (bp.Damage or 0), bp.DamageType or 'Normal')
end

--- Der Feuer-Sound der Sim (die Sim hat keine Ausgabe — die hat die UI-VM).
__simSounds = {}
function __simSoundRequested(cue)
  __simSounds[table.getn(__simSounds) + 1] = cue
end

-- ---------------------------------------------------------------------
-- Zielerfassung — CAcquireTargetTask::TaskTick (Cfile:792838-793228)
--
-- Der Suchradius ist ein MAXIMUM, kein Produkt:
--   radius = max(MaxRadius, TrackingRadius * MaxRadius)   (Cfile:793125-793132)
-- TrackingRadius < 1 verkleinert also nichts.
--
-- ABWEICHUNG, ausdruecklich benannt: die Engine sucht in den BLIPS der Unit
-- (mBlipsInRange — die Aufklaerungs-DB, Cfile:793167). Unsere Sim hat noch keine
-- Aufklaerung; wir nehmen alle lebenden Einheiten der Feind-Armee im Radius. Das
-- ist eine bewusste Abweichung, kein Nachbau (combat-projectiles.md §9).
-- ---------------------------------------------------------------------
local function canTarget(w, u, target)
  if target.__destroyQueued or target.__dead then return false end
  if target.__army == u.__army then return false end
  if target.__beingBuilt then return false end
  return true
end

local function acquireTarget(w, u)
  local bp = w.__bp or {}
  -- HoldFire (1) LOESCHT das Ziel (Cfile:793085-793097).
  if (u.__fireState or 0) == 1 then
    __weaponSetTarget(w, nil, nil)
    return
  end
  if u.__beingBuilt then return end
  if w.__enabled == false then return end

  local maxRadius = w.__maxRadius or bp.MaxRadius or 0
  if maxRadius <= 0 then return end
  local radius = math.max(maxRadius, (bp.TrackingRadius or 1) * maxRadius)

  -- Ein ATTACK-BEFEHL (CAttackTargetTask setzt das Ziel ueber den
  -- AiAttacker auf die Waffen) hat Vorrang vor der freien Zielsuche —
  -- sobald das Befehlsziel im Suchradius steht, feuert die Waffe darauf.
  local forcedId = __attackOrders[u.__id]
  if forcedId then
    if type(forcedId) == 'table' then
      -- Ground attack order: the position IS the target (AITARGET_Ground).
      -- CannotAttackGround weapons never take it (fire gate Cfile:983950,
      -- weapons.md:70) and keep searching freely.
      if not bp.CannotAttackGround then
        local p = u.__pos
        local dx, dz = forcedId[1] - p[1], forcedId[3] - p[3]
        if dx * dx + dz * dz <= radius * radius then
          __weaponSetTarget(w, nil, forcedId)
          return
        end
      end
    else
      local ft = __units[forcedId]
      if ft and canTarget(w, u, ft) then
        local p, q = u.__pos, ft.__pos
        local dx, dz = q[1] - p[1], q[3] - p[3]
        if dx * dx + dz * dz <= radius * radius then
          __weaponSetTarget(w, ft, nil)
          return
        end
      end
    end
  end

  -- Steht das alte Ziel noch und ist es in Reichweite, bleibt es (die Engine
  -- prueft es ueber CanAttackTarget, Cfile:793034).
  local cur = w.__target
  if cur and canTarget(w, u, cur) then
    local p, q = u.__pos, cur.__pos
    local dx, dz = q[1] - p[1], q[3] - p[3]
    if dx * dx + dz * dz <= radius * radius then return end
  end

  local best, bestDist = nil, radius * radius
  for _, other in pairs(__units) do
    if canTarget(w, u, other) then
      local p, q = u.__pos, other.__pos
      local dx, dz = q[1] - p[1], q[3] - p[3]
      local d2 = dx * dx + dz * dz
      if d2 <= bestDist then
        best, bestDist = other, d2
      end
    end
  end
  __weaponSetTarget(w, best, nil)
end

-- ---------------------------------------------------------------------
-- Turret aiming — CAimManipulator::CheckTracking/Track (weapons.md par. 2c,
-- CAimManipulator.cpp:1239-1327/1386). Per tick the turret slews toward the
-- target direction (slew = TurretYawSpeed * DEG2RAD * 0.1, arc-clamped to
-- center ± half range) and the weapon may only FIRE while both axes are
-- within FiringTolerance (weapon->mCanFire = onTarget). Angles live in the
-- UNIT frame relative to the rest pose; the renderer applies them to the
-- yaw/pitch bones. Idle turrets keep their pose (structures never reset,
-- weapon.lua:94 SetResetPoseTime 9999999; the mobile reset timer is a
-- documented gap).
-- ---------------------------------------------------------------------
local function normalizeAngle(a)
  while a > math.pi do a = a - 2 * math.pi end
  while a < -math.pi do a = a + 2 * math.pi end
  return a
end

local function aimAxis(current, wanted, center, range, slew)
  -- Arc clamp (2c): c = clamp(normalize(desired - center), -half, +half);
  -- laneDelta = (c + center) - current, then slew-clamped.
  local delta
  if range and range < math.pi then
    local c = normalizeAngle(wanted - center)
    if c > range then c = range elseif c < -range then c = -range end
    delta = normalizeAngle((c + center) - current)
  else
    delta = normalizeAngle(wanted - current)
  end
  local step = delta
  if slew and slew > 0 then
    if step > slew then step = slew elseif step < -slew then step = -slew end
  end
  return normalizeAngle(current + step), normalizeAngle(current + step - wanted)
end

local function aimTick(w, u)
  local aim = w.__aim
  if not aim or aim.__destroyed then return end
  local t = w.__target
  local tp = nil
  if t and not t.__dead and not t.__destroyQueued then
    tp = __unitCollision(t)
  elseif w.__targetGround then
    tp = w.__targetGround
  end
  if not tp then
    aim.__onTarget = false
    return
  end
  local bp = w.__bp or {}
  local p = u.__pos or { 0, 0, 0 }
  local dx, dy, dz = tp[1] - p[1], tp[2] - (p[2] or 0), tp[3] - p[3]
  -- Desired yaw in the UNIT frame (world bearing minus unit heading).
  local wantedYaw = normalizeAngle(math.atan(dx, dz) - (u.__heading or 0))
  local dxz = math.sqrt(dx * dx + dz * dz)
  local wantedPitch = math.atan(dy, dxz)

  local tol = (bp.FiringTolerance or 0.01) * 0.017453292
  local yaw, yawErr = aimAxis(aim.__yaw or 0, wantedYaw,
    aim.__yawCenter or 0, aim.__yawRange, aim.__yawSlew)
  aim.__yaw = yaw
  local onTarget = math.abs(yawErr) <= tol
  if aim.__pitchBone then
    local pitch, pitchErr = aimAxis(aim.__pitch or 0, wantedPitch,
      aim.__pitchCenter or 0, aim.__pitchRange, aim.__pitchSlew)
    aim.__pitch = pitch
    if not bp.YawOnlyOnTarget and math.abs(pitchErr) > tol then onTarget = false end
  end
  aim.__onTarget = onTarget
end

-- ---------------------------------------------------------------------
-- Feuertakt — CFireWeaponTask::Dispatch (Cfile:983912-983959)
--
--   if (mFireClock) --mFireClock;
--   ... Gates ...
--   UnitWeapon::Fire()                 -> RunScript("OnFire")
--   mFireClock = (int)(10.0f / rof);   <- TRUNKIERT, in Ticks
--
-- RateOfFire 1 heisst also: alle 10 Ticks = jede Sekunde.
-- ---------------------------------------------------------------------
local function fireTick(w, u)
  if (w.__fireClock or 0) > 0 then
    w.__fireClock = w.__fireClock - 1
  end
  if w.__enabled == false then return end

  local bp = w.__bp or {}
  if bp.ManualFire then return end
  if (w.__fireClock or 0) > 0 then return end
  if (u.__fireState or 0) == 1 then return end -- HoldFire
  -- The fire gate (weapon->mCanFire, CAimManipulator::Track): a turreted
  -- weapon only fires while its aim is within FiringTolerance.
  if w.__aim and not w.__aim.__destroyed and not w.__aim.__onTarget then return end
  if not w.__target and not w.__targetGround then return end
  if u.__beingBuilt then return end

  -- Reichweite: CanAttackTarget (Cfile:983938). MinRadius sperrt zu nahe Ziele
  -- (TargetIsTooClose, Cfile:983942).
  local t = w.__target
  if t then
    if t.__destroyQueued or t.__dead then
      __weaponSetTarget(w, nil, nil)
      return
    end
    local p, q = u.__pos, t.__pos
    local dx, dz = q[1] - p[1], q[3] - p[3]
    local d2 = dx * dx + dz * dz
    local maxR = w.__maxRadius or bp.MaxRadius or 0
    local minR = w.__minRadius or bp.MinRadius or 0
    if d2 > maxR * maxR then return end
    if minR > 0 and d2 < minR * minR then return end
  elseif w.__targetGround then
    -- The fire clock's ground gate (weapons.md:70): CannotAttackGround
    -- weapons never fire at an AITARGET_Ground target; same range window
    -- as entity targets otherwise.
    if bp.CannotAttackGround then return end
    local p, q = u.__pos, w.__targetGround
    local dx, dz = q[1] - p[1], q[3] - p[3]
    local d2 = dx * dx + dz * dz
    local maxR = w.__maxRadius or bp.MaxRadius or 0
    local minR = w.__minRadius or bp.MinRadius or 0
    if d2 > maxR * maxR then return end
    if minR > 0 and d2 < minR * minR then return end
  end

  -- Und jetzt die Lua: OnFire startet die Salven-Zustandsmaschine.
  if w.OnFire then
    local ok, err = pcall(function() w:OnFire() end)
    if not ok then WARN('OnFire: ' .. tostring(err)) end
  end
  w.__shotsAtTarget = (w.__shotsAtTarget or 0) + 1

  local rof = w.__rateOfFire or bp.RateOfFire or 1
  if rof <= 0 then rof = 1 end
  w.__fireClock = math.floor(10 / rof)
end

-- ---------------------------------------------------------------------
-- CollisionBeam-Tick (Moho::CollisionBeamEntity::MotionTick @911386 +
-- CheckCollision): pro Tick zaehlt der Intervall-Zaehler; erreicht er
-- CollisionCheckInterval, castet die Engine den Strahl von der Muendung
-- entlang deren Blickrichtung und ruft bei WECHSEL des Getroffenen
-- OnImpact(type, entity) — den Schaden macht die Lua (CollisionBeam.lua:186).
-- Die maximale Strahllaenge ist die Waffenreichweite (bp.MaxRadius) —
-- ABGELEITET (CheckCollision ist nicht dekompilierbar); ein Beam schiesst
-- nie weiter, als seine Waffe reicht.
-- ---------------------------------------------------------------------
local function beamCast(beam)
  local w = beam.Weapon
  local u = w and w.unit
  if not u or u.__destroyQueued or u.__dead then return end
  local start, rot = __boneWorld(u, beam.__muzzleBone)
  -- Die Strahlrichtung: im Original richtet das Turret-Aiming die Muendung
  -- aufs Ziel; unsere Tuerme drehen (noch) nicht — der Cast zielt deshalb wie
  -- der Projektilschuss auf die Koerpermitte des AKTUELLEN Waffenziels
  -- (dieselbe Zielsemantik wie fireTick). Ohne Ziel: Muendungs-Blickrichtung.
  local dir
  local aimZiel = w.__target
  if aimZiel and not aimZiel.__destroyed and not aimZiel.__destroyQueued then
    local c = __unitCollision(aimZiel)
    local dx = c[1] - start[1]
    local dy = c[2] - start[2]
    local dz = c[3] - start[3]
    local l = math.sqrt(dx * dx + dy * dy + dz * dz)
    if l > 0.001 then dir = { dx / l, dy / l, dz / l } end
  end
  dir = dir or __quatForward(rot)
  local maxLen = (w.__bp and w.__bp.MaxRadius) or 30
  beam.__beamBones[1] = { start[1], start[2], start[3] }
  beam.__beamOrient = rot

  -- Naechster Treffer entlang des Strahls: Ray-Kugel gegen alle Feind-Units
  -- (dieselbe Koerperkugel wie die Projektil-Kollision, __unitCollision).
  local bestT = maxLen
  local bestUnit = nil
  for _, ziel in pairs(__units) do
    if not ziel.__destroyed and not ziel.__destroyQueued and ziel ~= u
      and not IsAlly(ziel.__army, beam.__army) then
      local c, r = __unitCollision(ziel)
      local ox = c[1] - start[1]
      local oy = c[2] - start[2]
      local oz = c[3] - start[3]
      local t = ox * dir[1] + oy * dir[2] + oz * dir[3]
      if t > 0 and t < bestT + r then
        local px = start[1] + dir[1] * t
        local py = start[2] + dir[2] * t
        local pz = start[3] + dir[3] * t
        local d2 = (px - c[1]) ^ 2 + (py - c[2]) ^ 2 + (pz - c[3]) ^ 2
        if d2 <= r * r then
          local hitT = t - math.sqrt(r * r - d2)
          if hitT >= 0 and hitT < bestT then
            bestT = hitT
            bestUnit = ziel
          end
        end
      end
    end
  end

  -- Terrain: Marsch in 1-m-Schritten bis der Strahl unter den Boden taucht.
  local terrainT = nil
  if not bestUnit or bestT > 1 then
    local schritt = 1
    local t = schritt
    while t < bestT do
      local y = start[2] + dir[2] * t
      local g = GetSurfaceHeight(start[1] + dir[1] * t, start[3] + dir[3] * t)
      if y <= g then terrainT = t break end
      t = t + schritt
    end
  end

  local impactType, impactEntity, endT
  if terrainT and terrainT < bestT then
    impactType, impactEntity, endT = 'Terrain', nil, terrainT
  elseif bestUnit then
    impactType, impactEntity, endT = 'Unit', bestUnit, bestT
  else
    impactType, impactEntity, endT = 'Air', nil, maxLen
  end
  beam.__beamBones[2] = {
    start[1] + dir[1] * endT,
    start[2] + dir[2] * endT,
    start[3] + dir[3] * endT,
  }

  -- OnImpact NUR bei Wechsel des Getroffenen (CollisionBeam.lua:182-185:
  -- "only executes this function when the thing it is touching changes").
  local kennung = impactType .. ':' .. tostring(impactEntity and impactEntity.__id or '')
  if kennung ~= beam.__lastImpact then
    beam.__lastImpact = kennung
    if beam.OnImpact then
      local ok, err = pcall(function() beam:OnImpact(impactType, impactEntity) end)
      if not ok then WARN('CollisionBeam OnImpact: ' .. tostring(err)) end
    end
  end
end

function __beamTick()
  local lebend = {}
  for _, beam in ipairs(__collisionBeams) do
    local u = beam.Weapon and beam.Weapon.unit
    if not beam.__destroyed and not beam.__destroyQueued and u and not u.__destroyed then
      lebend[#lebend + 1] = beam
      if beam.__enabled then
        -- Bone 0 folgt der Muendung JEDEN Tick; der Kollisions-Check laeuft
        -- im Intervall (MotionTick @911410: Zaehler, dann CheckCollision).
        beam.__intervalCount = beam.__intervalCount + 1
        if beam.__intervalCount >= beam.__interval then
          beam.__intervalCount = 0
          local ok, err = pcall(function() beamCast(beam) end)
          if not ok then WARN('CollisionBeam: ' .. tostring(err)) end
        end
      end
    end
  end
  __collisionBeams = lebend
end

--- Ein Waffen-Tick fuer alle Einheiten. Laeuft VOR der Thread-Stage, weil die
--- Salven-FSM der Lua Coroutinen benutzt: OnFire setzt den Zustand, und der
--- Thread-Scheduler laeuft ihn im selben Beat weiter.
function __weaponTick()
  -- Command queue head advance FIRST (TaskTick pops finished commands and
  -- starts the next, sim-core.md:211-252), then the attack orders.
  __ordersTick()
  -- Attack-Orders ZUERST (CAttackTargetTask laeuft vor den Waffen-Tasks):
  -- sie steuern die Bewegung in Reichweite, die Zielerfassung unten
  -- bevorzugt dann das Befehlsziel.
  __attackTick()
  for _, u in pairs(__units) do
    if not u.__destroyQueued and not u.__dead and u.__weapons then
      for _, w in ipairs(u.__weapons) do
        if not w.__destroyed then
          local bp = w.__bp or {}
          if not bp.ManualFire then
            -- Zielsuche im Rhythmus TargetCheckInterval * 10 Ticks, aufgerundet
            -- mit CEIL (Cfile:792904-792908: `round(x) + (x>round(x))` = ceil,
            -- Minimum 1). Mit round-half-up prueften wir bei x.4x einen Tick zu
            -- oft.
            local interval = math.max(1, math.ceil((bp.TargetCheckInterval or 3.0) * 10))
            if (__gameTick % interval) == 0 then
              local ok, err = pcall(function() acquireTarget(w, u) end)
              if not ok then WARN('Zielerfassung: ' .. tostring(err)) end
            end
            local okA, errA = pcall(function() aimTick(w, u) end)
            if not okA then WARN('Turret aim: ' .. tostring(errA)) end
            local ok, err = pcall(function() fireTick(w, u) end)
            if not ok then WARN('Feuertakt: ' .. tostring(err)) end
          end
        end
      end
    end
  end
  -- Die Dauerstrahlen ticken im selben Beat (CollisionBeamEntity::MotionTick
  -- laeuft in derselben Sim-Stage wie die Waffen-Tasks).
  __beamTick()
end
