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

local canTarget, canTargetGround

--- Das Ziel einer Waffe setzen (Moho::UnitWeapon::SetTarget, Cfile:985364-985494).
---
--- Die Callbacks haengen an der FLANKE, nicht am Aufruf:
---   kein Ziel -> Ziel   ruft OnGotTarget   (Cfile:985494)
---   Ziel -> kein Ziel   ruft OnLostTarget  (Cfile:985364)
--- Beides auf der WAFFE. Wer OnGotTarget bei jedem Tick feuert, startet die
--- Salven-FSM in jedem Tick neu — die Waffe kaeme nie zum Schuss.
function __weaponSetTarget(w, target, groundPos)
  -- The native target setters leave the current target unchanged when a new
  -- target fails CanAttackTarget (UnitWeapon.cpp:1073-1093).
  if target and not canTarget(w, w.__unit, target) then return false end
  if groundPos and not canTargetGround(w, groundPos) then return false end
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
  return true
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

-- === The sim->user audio bridge (SAudioRequest, size 0x1C: {position,
-- layer, params, sound(handle), type EntitySound=0/StartLoop=1/StopLoop=2}
-- — effects-audio.md "Sound-Lua-API"). The sim has no audio output; the
-- requests drain to the browser once per beat. Position/layer (3D audio)
-- are a named gap — the browser plays flat for now.
__audioRequests = {}
__audioNextLoopHandle = 1

function __audioRequest(reqType, bank, cue, handle)
  __audioRequests[table.getn(__audioRequests) + 1] =
    { t = reqType, bank = bank or '', cue = cue or '', h = handle or 0 }
end

function __drainAudioRequestsJson()
  if __audioRequests[1] == nil then return '[]' end
  local parts = {}
  for i, r in ipairs(__audioRequests) do
    parts[i] = string.format('{"t":%d,"bank":%q,"cue":%q,"h":%d}', r.t, r.bank, r.cue, r.h)
  end
  for i = table.getn(__audioRequests), 1, -1 do __audioRequests[i] = nil end
  return '[' .. table.concat(parts, ',') .. ']'
end

function __simSoundRequested(cue)
  __simSounds[table.getn(__simSounds) + 1] = cue
  -- Sound{} carries Bank+Cue (CSndParams) — forward it as an EntitySound
  -- request so the browser actually plays weapon fire.
  if type(cue) == 'table' and cue.Bank and cue.Cue then
    __audioRequest(0, cue.Bank, cue.Cue)
  end
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
local function layerMaskContains(mask, layer)
  if type(mask) ~= 'string' then return false end
  for entry in string.gmatch(mask, '[^|]+') do
    if entry == layer then return true end
  end
  return false
end

canTarget = function(w, u, target)
  if not u or not target then return false end
  if target.__destroyQueued or target.__dead then return false end
  -- No alliance test: CanAttackTarget -> func_PickTargetPoint checks only layer
  -- caps, seabed above/below-water and the category masks, never IsAlly/IsEnemy
  -- (Cfile:984750-984845 returns 1 with no alliance branch). A commanded/force-
  -- fire order onto an allied or own entity therefore passes; friendly damage is
  -- filtered separately. Autonomous acquisition below still limits itself to
  -- enemies via IsEnemy, so this does not auto-target allies.

  local bp = w.__bp or {}
  if bp.IgnoreIfDisabled and w.__enabled == false then return false end

  local layer = target.__layer or target.Layer or 'Land'
  if not layerMaskContains(w.__fireTargetLayerCaps, layer) then return false end

  if bp.TargetRestrictOnlyAllow and bp.TargetRestrictOnlyAllow ~= ''
    and not EntityCategoryContains(bp.TargetRestrictOnlyAllow, target) then
    return false
  end
  if bp.TargetRestrictDisallow and bp.TargetRestrictDisallow ~= ''
    and EntityCategoryContains(bp.TargetRestrictDisallow, target) then
    return false
  end
  return true
end

canTargetGround = function(w, pos)
  local bp = w.__bp or {}
  if bp.CannotAttackGround then return false end
  if bp.IgnoreIfDisabled and w.__enabled == false then return false end
  local x, z = (pos and pos[1]) or 0, (pos and pos[3]) or 0
  local terrain = GetTerrainHeight(x, z)
  local water = __mapWaterLevel or -10000
  if terrain > water then
    return layerMaskContains(w.__fireTargetLayerCaps, 'Land')
  elseif water > terrain then
    return layerMaskContains(w.__fireTargetLayerCaps, 'Water')
  end
  -- Exact equality is neither native branch and therefore cannot be targeted.
  return false
end

local function acquireTarget(w, u)
  local bp = w.__bp or {}
  -- A unit that must unpack (AI.NeedUnpack: the mobile artillery uel0304,
  -- url0304, xal0305, xsl0304 and the Monkeylord) does not look for targets
  -- while it is Moving, TransportLoading or WaitingForTransport -- the whole
  -- check is skipped and the task just re-arms its interval
  -- (Cfile:792913-792917, the else branch returns v6). The current target is
  -- left alone; the fire gate refuses it separately (UnitWeapon::CanFire:
  -- NeedUnpack and not Immobile).
  local ubp = u.__bp or {}
  if (ubp.AI or {}).NeedUnpack and u.IsUnitState
    and (u:IsUnitState('Moving') or u:IsUnitState('TransportLoading') or u:IsUnitState('WaitingForTransport')) then
    return
  end
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
      if canTargetGround(w, forcedId) then
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

  -- Retention matches the engine's sticky path: keep the current target only
  -- while the full FIRE solution is available (TargetIsTooClose == TRS_Available,
  -- Cfile:793070) — that uses MaxRadius (not the larger tracking radius) and
  -- also enforces MinRadius, MaxHeightDiff and the heading arc via
  -- __weaponTargetSolution. Weapons flagged AlwaysRecheckTarget skip retention
  -- and re-run the free search every interval (Cfile:793070 gates the keep path
  -- on !mAlwaysRecheckTarget), letting them switch to a better target.
  local cur = w.__target
  if cur and not bp.AlwaysRecheckTarget and canTarget(w, u, cur)
    and __weaponTargetSolution(w, __unitCollision(cur) or cur.__pos) then
    return
  end

  -- FindBestEnemy (Cfile:791970-792233) does NOT pick the nearest enemy. It
  -- walks the weapon's mTargetPriorities and, for each candidate, finds the
  -- LOWEST category index the candidate's blueprint matches
  -- (HasBlueprint at Cfile:792183). A better (lower) category wins outright
  -- (`bestCat > closestSeen` -> SET_BEST, Cfile:792190-792191); distance only
  -- breaks ties INSIDE a category (`bestDist > usedDist`, Cfile:792203).
  -- The whole selection sits inside `if Size(mTargetPriorities)`
  -- (Cfile:792176): a candidate matching no listed category is not a target at
  -- all. Most FA weapons end their list with 'ALLUNITS' (e.g.
  -- uel0201_unit.bp:245-253), which is what makes that catch everything.
  local prios = w.__targetPriorities
  local nPrio = prios and #prios or 0
  local maxD2 = radius * radius
  local best, bestDist, bestCat = nil, maxD2, nil
  for _, other in pairs(__units) do
    if IsEnemy(u.__army, other.__army) and canTarget(w, u, other) then
      local p, q = u.__pos, other.__pos
      local dx, dz = q[1] - p[1], q[3] - p[3]
      local d2 = dx * dx + dz * dz
      if d2 <= maxD2 then
        local cat = nil
        for i = 1, nPrio do
          if EntityCategoryContains(prios[i], other) then
            cat = i
            break
          end
        end
        if nPrio == 0 then
          -- No priority list: the engine would select nothing here. We keep the
          -- nearest-enemy fallback because our weapon set-up path may not have
          -- run SetWeaponPriorities for every unit yet; a silent "never shoots"
          -- would be worse than a documented approximation. DEVIATION, recorded
          -- in specs/001-engine-fidelity-fixes/research.md.
          if d2 <= bestDist then best, bestDist = other, d2 end
        elseif cat ~= nil then
          if bestCat == nil or cat < bestCat then
            best, bestDist, bestCat = other, d2, cat
          elseif cat == bestCat and d2 < bestDist then
            best, bestDist = other, d2
          end
        end
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
  return normalizeAngle(current + step), normalizeAngle(current + step - wanted), step
end

local function aimControlsWeapon(w, aim)
  -- The manipulator writes the weapon's mCanFire only when its label equals
  -- the weapon's FIRE-CONTROL label, compared with stricmp (CAimManipulator::
  -- AimManip, Cfile:862060-862085). That label is UnitWeapon::mLabel --
  -- "Default" from the ctor (Cfile:984161), changed by SetFireControl
  -- (Cfile:987460) -- not the blueprint's Label. weapon.lua:92 creates the
  -- single turret as 'Default', which matches the ctor value; the dual-turret
  -- units (weapon.lua:78-87) create Torso/Right/Left and hand fire control to
  -- 'Right', so the torso and the left arm never open the gate.
  if aim.__weapon ~= w then return false end
  return string.lower(aim.__label or '') == string.lower(w.__fireControl or 'Default')
end

--- The manipulator that may write the weapon's fire gate: the one whose label
--- is the weapon's fire-control label (stricmp, Cfile:862060-862085). nil when
--- the weapon has none, or none matches.
function __weaponFireControlAim(w)
  local want = string.lower(w.__fireControl or 'Default')
  for _, aim in ipairs(w.__aims or {}) do
    if not aim.__destroyed and string.lower(aim.__label or '') == want then return aim end
  end
  return nil
end

--- One manipulator's tick (CAimManipulator::AimManip, Cfile:861922-862100).
--- A weapon owns up to three of them (weapon.lua:78-80); each aims its own
--- bones at the same target, and only the fire-control one opens the gate.
local function aimOne(w, u, aim, tp)
  if not tp then
    aim.__onTarget = false
    if aimControlsWeapon(w, aim) then w.__canFire = false end
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
  local yaw, yawErr, yawStep = aimAxis(aim.__yaw or 0, wantedYaw,
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
  if aimControlsWeapon(w, aim) then w.__canFire = onTarget end

  -- Tracking is "the heading moved this tick" -- CheckTracking sets the bit
  -- only for the heading axis and only when the clamped step exceeds 0.001
  -- (Cfile:861850-861851). Track then calls the weapon's OnStartTracking on
  -- the off->on edge and OnStopTracking on the on->off edge, each with the
  -- manipulator's label (Cfile:861862-861880). weapon.lua:232-243 plays the
  -- barrel sounds there and freezes a structure's reset pose.
  local moving = math.abs(yawStep) > 0.001
  if moving and not aim.__isTracking then
    aim.__isTracking = true
    if w.OnStartTracking then
      local ok, err = pcall(function() w:OnStartTracking(aim.__label) end)
      if not ok then WARN('OnStartTracking: ' .. tostring(err)) end
    end
  elseif not moving and aim.__isTracking then
    aim.__isTracking = false
    if w.OnStopTracking then
      local ok, err = pcall(function() w:OnStopTracking(aim.__label) end)
      if not ok then WARN('OnStopTracking: ' .. tostring(err)) end
    end
  end
end

local function aimTick(w, u)
  local aims = w.__aims
  if not aims or aims[1] == nil then return end
  local t = w.__target
  local tp = nil
  if t and not t.__dead and not t.__destroyQueued then
    tp = __unitCollision(t)
  elseif w.__targetGround then
    tp = w.__targetGround
  end
  for _, aim in ipairs(aims) do
    if not aim.__destroyed then aimOne(w, u, aim, tp) end
  end
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
  if not w.__target and not w.__targetGround then return end
  if u.__beingBuilt then return end

  -- CFireWeaponTask::Dispatch gate order (Cfile:983938-983947):
  -- CanAttackTarget, UnitWeapon::CanFire, CheckSilo, then the full
  -- TargetIsTooClose solution status (despite that misleading function name).
  -- On a failed gate CFireWeaponTask::Dispatch does NOTHING to the target and
  -- returns (Cfile:983938-983958 has no else/SetTarget). Clearing it here fired
  -- spurious OnLostTarget and restarted the salvo FSM inside one acquire
  -- interval; leave the target for acquireTarget (the CAcquireTargetTask
  -- equivalent) to re-evaluate and clear on its own interval.
  local t = w.__target
  if t then
    if not canTarget(w, u, t) then return end
  elseif w.__targetGround then
    if not canTargetGround(w, w.__targetGround) then return end
  end
  if not __weaponUnitCanFire(w) or not __weaponCheckSilo(w) then return end
  local targetPos = t and t.__pos or w.__targetGround
  if not __weaponTargetSolution(w, targetPos) then return end

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
-- entlang deren Blickrichtung und ruft bei JEDEM Check OnImpact(type, entity)
-- auf — den Schaden macht die Lua (CollisionBeam.lua:186). Die maximale
-- Strahllaenge ist MaximumBeamLength mit dem nativen MaxRadius-Fallback
-- (CreateCollisionBeamHelper, Cfile:985931-985950).
-- ---------------------------------------------------------------------
function __beamCheckCollision(beam)
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
  local weaponBp = w.__bp or {}
  local maxLen = weaponBp.MaximumBeamLength or 0
  if maxLen <= 0 then
    maxLen = w.__maxRadius
    if maxLen == nil or maxLen < 0 then maxLen = weaponBp.MaxRadius or 0 end
  end
  beam.__beamBones[1] = { start[1], start[2], start[3] }
  beam.__beamOrient = rot

  -- Naechster Treffer entlang des Strahls. GetClosestCollision first invokes
  -- Entity:OnCollisionCheckWeapon and then applies the IgnoresAlly Air-layer
  -- gate (Cfile:985827-985847); it does not blanket-filter every ally.
  local bestT = maxLen
  local bestUnit = nil
  for _, ziel in pairs(__units) do
    if not ziel.__destroyed and not ziel.__destroyQueued and ziel ~= u then
      local accepts = false
      if ziel.OnCollisionCheckWeapon then
        local ok, result = pcall(function()
          return ziel:OnCollisionCheckWeapon(w)
        end)
        if ok then
          accepts = result ~= false and result ~= nil
        else
          WARN('CollisionBeam OnCollisionCheckWeapon: ' .. tostring(result))
        end
      end
      if accepts and weaponBp.IgnoresAlly ~= false
        and ziel.__layer == 'Air' and IsAlly(ziel.__army, beam.__army) then
        accepts = false
      end

      if accepts then
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

  -- CheckCollision calls RunScript("OnImpact", ...) for every nonzero impact
  -- type on every check (Cfile:911339-911350). CollisionBeam.lua applies its
  -- damage in that callback; suppressing identical hits made continuous beams
  -- damage a stationary target only once.
  if beam.OnImpact then
    local ok, err = pcall(function() beam:OnImpact(impactType, impactEntity) end)
    if not ok then WARN('CollisionBeam OnImpact: ' .. tostring(err)) end
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
        -- im Intervall. MotionTick compares the old counter, increments it,
        -- then checks (Cfile:911410-911416): after a reset that is precisely
        -- CollisionCheckInterval + 1 ticks. Enable primes the counter to the
        -- interval, so the first enabled tick still checks immediately.
        local count = beam.__intervalCount
        beam.__intervalCount = count + 1
        if count >= beam.__interval then
          beam.__intervalCount = 0
          local ok, err = pcall(function() __beamCheckCollision(beam) end)
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
  -- Guard orders (CUnitGuardTask): queue sharing, builder assist and the
  -- follow behavior run per beat like the engine's TaskTick.
  __guardTick()
  -- Reclaim tasks (CUnitReclaimTask): drain the target, grant resources.
  __reclaimTick()
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
            --
            -- The rhythm is the TASK's, not the clock's: CAcquireTargetTask
            -- returns `interval + 1` (Cfile:792908-792912), DoTaskTick stores
            -- `mWaitTicks = interval` (Cfile:438947) and pre-decrements it
            -- every tick (Cfile:438898) -- so the check repeats every
            -- `interval` ticks counted from the weapon's FIRST tick, which
            -- comes at once (`mWaitTicks = 0` in the CTaskThread ctor,
            -- Cfile:438797). Aligning it to `__gameTick % interval` made a
            -- unit built at tick 17 wait until tick 30 for its first look.
            local interval = math.max(1, math.ceil((bp.TargetCheckInterval or 3.0) * 10))
            local wait = (w.__acquireWait or 0) - 1
            if wait <= 0 then
              local ok, err = pcall(function() acquireTarget(w, u) end)
              if not ok then WARN('Zielerfassung: ' .. tostring(err)) end
              wait = interval
            end
            w.__acquireWait = wait
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
