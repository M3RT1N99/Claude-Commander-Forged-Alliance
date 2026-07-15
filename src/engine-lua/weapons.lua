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

--- Ein Waffen-Tick fuer alle Einheiten. Laeuft VOR der Thread-Stage, weil die
--- Salven-FSM der Lua Coroutinen benutzt: OnFire setzt den Zustand, und der
--- Thread-Scheduler laeuft ihn im selben Beat weiter.
function __weaponTick()
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
            local ok, err = pcall(function() fireTick(w, u) end)
            if not ok then WARN('Feuertakt: ' .. tostring(err)) end
          end
        end
      end
    end
  end
end
