-- =====================================================================
-- SCHADEN, RUESTUNG, TOD — die Engine-Seite.
--
-- Aufteilung (docs/research/damage-binary.md + combat-projectiles.md §4):
--   Lua entscheidet, WIEVIEL Schaden entsteht (Projectile:DoDamage ruft Damage/
--   DamageArea mit den Werten aus dem Waffen-Blueprint).
--   Engine verrechnet ihn: Ruestung, Handicap, und ruft dann OnDamage auf dem
--   Ziel. Sie zieht KEINE HP ab (Entity::AdjustHealth klemmt nur, Cfile:915978) —
--   das tut Unit:DoTakeDamage in der Lua (unit.lua:794-818).
--
-- Belege:
--   cfunc_DamageL         Cfile:1064167  (FUENF Argumente!)
--   cfunc_DamageAreaL     Cfile:1064280
--   cfunc_DamageRingL     Cfile:1064409
--   func_DoDamagePoint    Cfile:1062873  (Ruestung, Handicap, OnDamageBy, OnDamage)
--   Armor-Tabelle         Cfile:708539   (die Engine importiert /lua/armordefinition.lua)
--   Entity::SetHealth     Cfile:916009   (OnHealthChanged nur in 25%-Stufen)
--   Moho::Unit::Kill      Cfile:951962   (CheckCanBeKilled, SetDead, OnKilled)
--
-- STANDARD-LUA 5.4.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Die Ruestungstabelle. Die Engine importiert /lua/armordefinition.lua und
-- sucht den ArmorType der Unit (Gross-/Kleinschreibung egal, stricmp
-- Cfile:708566); jede weitere Zeile des Eintrags ist "<Schadenstyp> <Faktor>".
-- Nicht gelistete Schadenstypen: Faktor 1.0.
-- ---------------------------------------------------------------------
__armorTable = false
-- Handicap kommt aus der Lobby (ArmyGetHandicap). Ohne Lobby: keins.
__armyHandicap = {}

local function armorTable()
  if __armorTable then return __armorTable end
  local t = {}
  local ok, mod = pcall(import, '/lua/armordefinition.lua')
  if ok and mod and mod.armordefinition then
    for _, entry in ipairs(mod.armordefinition) do
      local name = string.lower(tostring(entry[1]))
      local defs = {}
      for i = 2, table.getn(entry) do
        local dtype, mult = string.match(tostring(entry[i]), '^%s*(%S+)%s+([%d%.]+)')
        if dtype then defs[string.lower(dtype)] = tonumber(mult) end
      end
      t[name] = defs
    end
  else
    -- Genau die Meldung der Engine (Cfile:708543).
    WARN("can't load the armordefinition module -- no armor for you.")
  end
  __armorTable = t
  return t
end

--- Unit:GetArmorMult(damageType) — der Faktor aus der Ruestungstabelle.
function __armorMult(unit, damageType)
  local bp = unit.__bp
  local armor = (bp and bp.Defense and bp.Defense.ArmorType) or 'Default'
  -- AlterArmor(type, mult) ueberschreibt zur Laufzeit (Cfile:972372).
  local altered = unit.__armorOverride and unit.__armorOverride[string.lower(tostring(damageType))]
  if altered then return altered end
  local defs = armorTable()[string.lower(tostring(armor))]
  if not defs then return 1.0 end
  return defs[string.lower(tostring(damageType or 'Normal'))] or 1.0
end

--- ArmyGetHandicap(army) — im Skirmish ohne Lobby-Handicap: 0.
--- (Die Engine teilt durch (1 + handicap), Cfile:1063020.)
function ArmyGetHandicap(army)
  return (__armyHandicap and __armyHandicap[army]) or 0
end

-- Active shields as a per-beat list (SIM_DoDamage walks a1->mShields,
-- Cfile:1062762): each carries its owner's position and its collision radius
-- (the shield entity Size = bp.Defense.Shield.ShieldSize, shield.lua:72).
-- Rebuilt when the tick changes so a splash over many targets scans this small
-- list, not every unit per hit.
__shieldListTick = -1
__shieldList = {}
local function shieldOn(s)
  return s and not s.__destroyed and not s.__destroyQueued
    and s.IsOn and s:IsOn() and s.GetHealth and s:GetHealth() > 0
end
local function activeShieldList()
  if __shieldListTick ~= (__gameTick or 0) then
    __shieldListTick = __gameTick or 0
    __shieldList = {}
    for _, u in pairs(__units) do
      local s = u.MyShield
      if shieldOn(s) then
        local p = u.__pos or { 0, 0, 0 }
        local r = s.Size or 0
        if r > 0 then
          __shieldList[table.getn(__shieldList) + 1] =
            { shield = s, owner = u, x = p[1], y = p[2], z = p[3], r2 = r * r }
        end
      end
    end
  end
  return __shieldList
end

-- SIM_DoDamage (Cfile:1062730-1062869) — run ONCE per damage event, before any
-- unit is touched (func_DoDamageArea calls it at Cfile:1063221). It walks the
-- sim's shield list a single time and records, per eligible dome, how much it
-- would absorb. A dome is eligible when:
--   * it has a collision shape (Cfile:1062773-1062775),
--   * `damageFriendly` is set OR the instigator is not its ally
--     (Cfile:1062776-1062795),
--   * the damage ORIGIN is NOT inside its sphere, tested at radius - 0.1
--     (Cfile:1062796-1062802) — a shell fired from under the dome is not
--     absorbed by it,
--   * its sphere intersects the damage sphere (radius; for a ring the engine
--     retries with maxRadius, Cfile:1062804-1062851),
--   * and OnGetDamageAbsorption returns > 0 (Cfile:1062828-1062836).
-- shield.lua:96-99 states the contract in the original's own words: "damage
-- logic will subtract this value from any damage it does to units under the
-- shield".
local function collectAbsorption(origin, radius, amount, damageType, inst, damageFriendly)
  local out = {}
  local instArmy = inst and inst.__army
  for _, e in ipairs(activeShieldList()) do
    local eligible = true
    if not damageFriendly and instArmy and e.owner.__army then
      if IsAlly(instArmy, e.owner.__army) then eligible = false end
    end
    if eligible then
      -- Origin inside the dome (radius - 0.1): not absorbed.
      local r = math.sqrt(e.r2)
      local inner = r - 0.1
      local dox, doy, doz = origin[1] - e.x, origin[2] - e.y, origin[3] - e.z
      if dox * dox + doy * doy + doz * doz <= inner * inner then eligible = false end
    end
    if eligible then
      -- Sphere-vs-sphere: |centres| <= shieldRadius + damageRadius.
      local r = math.sqrt(e.r2)
      local sum = r + radius
      local dox, doy, doz = origin[1] - e.x, origin[2] - e.y, origin[3] - e.z
      if dox * dox + doy * doy + doz * doz > sum * sum then eligible = false end
    end
    if eligible then
      local ok, absorbed = pcall(function()
        return e.shield:OnGetDamageAbsorption(inst, amount, damageType)
      end)
      if not ok then
        WARN('OnGetDamageAbsorption: ' .. tostring(absorbed))
      elseif type(absorbed) == 'number' and absorbed > 0 then
        out[table.getn(out) + 1] =
          { shield = e.shield, x = e.x, y = e.y, z = e.z, r2 = e.r2, absorbed = absorbed }
      end
    end
  end
  return out
end

-- sub_736E40 (Cfile:1062694-1062727): subtract the absorption of EVERY recorded
-- dome whose sphere contains this entity's position (PointIsInside at
-- Cfile:1062711, subtraction at Cfile:1062715).
local function reduceByShields(absorbers, p, amount)
  for _, a in ipairs(absorbers) do
    local dx, dy, dz = p[1] - a.x, p[2] - a.y, p[3] - a.z
    if dx * dx + dy * dy + dz * dz <= a.r2 then amount = amount - a.absorbed end
  end
  return amount
end

-- The second loop of func_DoDamageArea (Cfile:1063310-1063386): each recorded
-- dome is damaged EXACTLY ONCE, with the amount it absorbed
-- (mAmount = v17[3], Cfile:1063319). Previously every covered unit drove its own
-- OnDamage call into the same dome, draining it N-fold.
local function damageAbsorbers(absorbers, inst, origin, damageType)
  for _, a in ipairs(absorbers) do
    local vec = Vector(a.x - origin[1], a.y - origin[2], a.z - origin[3])
    local ok, err = pcall(function()
      a.shield:OnDamage(inst, a.absorbed, vec, damageType)
    end)
    if not ok then WARN('Shield OnDamage: ' .. tostring(err)) end
  end
end

-- ---------------------------------------------------------------------
-- func_DoDamagePoint (Cfile:1062873) — EIN Ziel.
-- ---------------------------------------------------------------------
-- `fromArea` marks the calls made by DamageArea/DamageRing: those already had
-- every covering dome's absorption subtracted by the caller, so this function
-- must not consult covering domes again (that double-count was the N-fold drain).
local function damagePoint(instigator, origin, target, amount, damageType, damageSelf, fromArea)
  if not target or target.__destroyQueued then return end
  if amount == 0 then return end

  -- Ein Projektil als Verursacher wird auf seinen Launcher aufgeloest
  -- (Cfile:1062930-1063000). Selbstschaden faellt normalerweise weg — AUSSER die
  -- Waffe verlangt ihn ausdruecklich (damageSelf, z. B. Kamikaze-/Selbstzerstoerungs-
  -- Einheiten). Ohne diesen Durchgriff traf DamageArea(damageSelf=true) den
  -- Verursacher NIE, weil dieser Punkt-Schaden ihn immer uebersprang.
  local inst = instigator
  if inst and inst.__isProj then inst = inst.__launcher or inst end
  if not damageSelf and inst == target then return end

  local tp = target.__pos or { 0, 0, 0 }
  local vec = Vector(tp[1] - origin[1], tp[2] - origin[2], tp[3] - origin[3])

  -- Only the target's OWN dome is consulted here. func_DoDamagePoint
  -- (Cfile:1062873-1063170) contains NO shield code at all: in the engine a
  -- projectile physically collides with the shield entity, so a direct hit
  -- never reaches the unit underneath. We do not model projectile-vs-shield
  -- collision, so the own-shield branch is our stand-in for that — a DOCUMENTED
  -- approximation, not a guess.
  --
  -- `fromArea` skips the WHOLE shield block, own dome included. For area damage
  -- `collectAbsorption` walks activeShieldList(), which contains every unit's
  -- own dome as well, and the caller has already subtracted each covering dome
  -- from `amount` (reduceByShields = sub_736E40, Cfile:1063263). Re-consulting
  -- ANY dome here — including the target's own — would swallow the remainder
  -- the engine explicitly passes to the entity (it skips the entity only when
  -- the remainder is <= 0, Cfile:1063264) and charge that dome a second time on
  -- top of `damageAbsorbers` (Cfile:1063310-1063386).
  --
  -- For a DIRECT point hit both branches stay: the engine's dome stops the
  -- PROJECTILE by collision and we do not model projectile-vs-shield collision,
  -- so this is the stand-in for it. Documented in
  -- specs/001-engine-fidelity-fixes/research.md.
  if not fromArea then
    local shield = target.MyShield
    if not shieldOn(shield) then
      for _, e in ipairs(activeShieldList()) do
        if e.owner ~= target then
          local dtx, dty, dtz = tp[1] - e.x, tp[2] - e.y, tp[3] - e.z
          if dtx * dtx + dty * dty + dtz * dtz <= e.r2 then
            local dox, doy, doz = origin[1] - e.x, origin[2] - e.y, origin[3] - e.z
            -- A shell fired from inside the dome is not absorbed (Cfile:1062801).
            if dox * dox + doy * doy + doz * doz > e.r2 then
              shield = e.shield
              break
            end
          end
        end
      end
    end
    if shieldOn(shield) then
      local ok, err = pcall(function() shield:OnDamage(inst, amount, vec, damageType) end)
      if not ok then WARN('Shield OnDamage: ' .. tostring(err)) end
      return
    end
  end

  -- Armor + handicap reduce the amount only for UNITS (Cfile:1063012-1063033);
  -- props and projectiles take the raw amount.
  local dealt = amount
  if target.__isUnit then
    dealt = dealt * __armorMult(target, damageType)
    dealt = dealt / (1 + ArmyGetHandicap(target.__army or 1))
  end

  if dealt <= 0 then return end

  -- OnDamageBy(armyIndex) — who fired (Cfile:1063052; unit.lua uses it for
  -- retaliation/stats). It fires only AFTER the reduction, on a UNIT that
  -- actually takes damage (not on a full shield absorb, a prop or a projectile).
  if inst and inst.__army and target.__isUnit and target.OnDamageBy then
    pcall(function() target:OnDamageBy(inst.__army) end)
  end

  -- OnExtraDamageDealt(damageType): the engine fires it on a UNIT when armor
  -- AMPLIFIED the hit to >= 2x the raw amount (func_DoDamagePoint, Cfile:1063057-
  -- 1063059: ratio = dealt/rawAmount >= 2.0). dealt already includes the armor
  -- multiplier and the handicap divisor.
  if target.__isUnit and amount > 0 and (dealt / amount) >= 2.0 and target.OnExtraDamageDealt then
    pcall(function() target:OnExtraDamageDealt(damageType) end)
  end

  -- Und jetzt sagt es die Engine der Lua — sie zieht die HP selbst ab
  -- (RunScript_EntityOnDamage, Cfile:1063151).
  if target.OnDamage then
    local ok, err = pcall(function() target:OnDamage(inst, dealt, vec, damageType) end)
    if not ok then WARN('OnDamage: ' .. tostring(err)) end
  end
end

--- "Damage(instigator, origin, target, amount, damageType)" — FUENF Argumente.
--- Der mHelp-Text der Engine ist veraltet (4); cfunc_DamageL prueft
--- `lua_gettop != 5` (Cfile:1064215). `amount == 0` ist ein FEHLER, kein No-Op.
function Damage(instigator, origin, target, amount, damageType)
  if amount == 0 then error('0 damage specified.', 2) end
  damagePoint(instigator, __vec3(origin), target, amount, damageType)
end

-- Area/ring splash eligibility (func_DoDamageArea, Cfile:1063243-1063261):
--   * damageSelf gates the instigator itself;
--   * the friendly filter uses IsAlly, NOT exact-army equality
--     (Cfile:1063248-1063249) — allies of a DIFFERENT army are spared too unless
--     damageFriendly (IsAlly(x,x) keeps the instigator's own army spared);
--   * a target in category NOSPLASHDAMAGE is immune to splash
--     (Cfile:1063254-1063256).
local function splashEligible(u, inst, instArmy, damageFriendly, damageSelf)
  if u.__destroyQueued then return false end
  if not damageSelf and u == inst then return false end
  if not damageFriendly and instArmy ~= nil and IsAlly(instArmy, u.__army) then return false end
  if EntityCategoryContains(categories.NOSPLASHDAMAGE, u) then return false end
  return true
end

--- "DamageArea(instigator, location, radius, amount, damageType, damageFriendly,
--- [damageSelf])" (Cfile:1064280). No distance falloff: every target in the
--- radius takes the full amount (damage-binary.md). Shields are not modelled yet
--- (the shield-sphere subtraction, Cfile:1062695, arrives with the shield system).
--- The engine ERRORS on degenerate input rather than silently no-oping
--- (cfunc_DamageAreaL, Cfile:1064381/1064383).
--- DOCUMENTED GAP: the engine iterates the OGrid for Unit|Prop|Projectile|Entity
--- (func_DoDamageArea, Cfile:1063234) so splash also destroys trees/wrecks and
--- in-flight projectiles. We iterate only __units — props and projectiles carry
--- __health but no damage->destroy path (they are removed via the reclaim/
--- renderer-instance path, globals.lua __dispatchReclaimMapProp, or projectile
--- impact), so splashing them needs that removal wiring; deferred, not faked.
function DamageArea(instigator, location, radius, amount, damageType, damageFriendly, damageSelf)
  if amount == 0 then error('0 damage specified.', 2) end
  if radius == 0 then error('0 radius specified.', 2) end
  local origin = __vec3(location)
  local inst = instigator
  if inst and inst.__isProj then inst = inst.__launcher or inst end
  local instArmy = inst and inst.__army

  -- ONE shield pass for the whole event (Cfile:1063221), before any unit.
  local absorbers = collectAbsorption(origin, radius, amount, damageType, inst, damageFriendly)

  for _, u in pairs(__units) do
    local p = u.__pos
    local dx, dy, dz = p[1] - origin[1], p[2] - origin[2], p[3] - origin[3]
    if dx * dx + dy * dy + dz * dz <= radius * radius
      and splashEligible(u, inst, instArmy, damageFriendly, damageSelf) then
      -- Per entity: amount minus every containing dome's absorption; <= 0 means
      -- fully covered and the unit is skipped entirely (Cfile:1063263-1063264).
      local reduced = reduceByShields(absorbers, p, amount)
      if reduced > 0 then
        damagePoint(instigator, origin, u, reduced, damageType, damageSelf, true)
      end
    end
  end

  -- Then each dome once, with what it absorbed (Cfile:1063310-1063386).
  damageAbsorbers(absorbers, inst, origin, damageType)
end

--- "DamageRing(instigator, location, minRadius, maxRadius, amount, damageType,
--- damageFriendly, [damageSelf])" (Cfile:1064409). Errors on 0 damage / 0 min /
--- 0 max radius (cfunc_DamageRingL, Cfile:1064503-1064507).
function DamageRing(instigator, location, minRadius, maxRadius, amount, damageType, damageFriendly, damageSelf)
  if amount == 0 then error('0 damage specified.', 2) end
  if minRadius == 0 then error('0 min radius specified.', 2) end
  if maxRadius == 0 then error('0 max radius specified.', 2) end
  -- cfunc_DamageRingL also rejects a degenerate ring (Cfile:1064508-1064509).
  if minRadius >= maxRadius then error('Max radius must be greater than min radius.', 2) end
  local origin = __vec3(location)
  local inst = instigator
  if inst and inst.__isProj then inst = inst.__launcher or inst end
  local instArmy = inst and inst.__army

  -- A ring tests the shields against maxRadius (the RING_EFFECT retry at
  -- Cfile:1062812-1062851 uses mMaxRadius).
  local absorbers = collectAbsorption(origin, maxRadius, amount, damageType, inst, damageFriendly)

  for _, u in pairs(__units) do
    local p = u.__pos
    local dx, dy, dz = p[1] - origin[1], p[2] - origin[2], p[3] - origin[3]
    local d2 = dx * dx + dy * dy + dz * dz
    if d2 >= minRadius * minRadius and d2 <= maxRadius * maxRadius
      and splashEligible(u, inst, instArmy, damageFriendly, damageSelf) then
      local reduced = reduceByShields(absorbers, p, amount)
      if reduced > 0 then
        damagePoint(instigator, origin, u, reduced, damageType, damageSelf, true)
      end
    end
  end

  damageAbsorbers(absorbers, inst, origin, damageType)
end

--- MetaImpact(instigator, location, radius, amount) — der IMPULS eines
--- Einschlags (Einheiten werden weggeschleudert).
---
--- Unsere Sim hat keine Impuls-Physik (Bewegung laeuft ueber den Navigator,
--- motion.lua). Deshalb passiert hier nichts — und das wird EINMAL gesagt,
--- statt es zu verschweigen.
__metaImpactWarned = false
function MetaImpact(instigator, location, radius, amount)
  if not __metaImpactWarned then
    __metaImpactWarned = true
    WARN('MetaImpact: keine Impuls-Physik — Einheiten werden nicht weggeschleudert')
  end
end

--- Ein Vektor-Argument (Tabelle mit x/y/z ODER 1/2/3) in {x,y,z}.
function __vec3(v)
  if not v then return { 0, 0, 0 } end
  return { v[1] or v.x or 0, v[2] or v.y or 0, v[3] or v.z or 0 }
end

-- ---------------------------------------------------------------------
-- Die Loeschwarteschlange (Sim::mDeletionQueue).
--
-- Entity::Destroy (Cfile:916089) loescht NICHT sofort: es setzt mDestroyQueued
-- und haengt die Entity in die Warteschlange. Erst am Ende des Beats
-- (Sim::AdvanceBeat, Cfile:1076638-1076656) laeuft Entity::OnDestroy — und damit
-- der Lua-Callback OnDestroy, der den TrashBag leert (unit.lua:1244).
-- ---------------------------------------------------------------------
__deletionQueue = {}

function __queueDeletion(e)
  __deletionQueue[table.getn(__deletionQueue) + 1] = e
end

function __flushDeletions()
  -- Sim::AdvanceBeat drains until EMPTY, not one generation per beat:
  -- `while (mDeletionQueue._Mysize) { pop_front; dtor(); }`
  -- (Cfile:1076638-1076657). An OnDestroy that destroys something else — a
  -- factory taking its half-built unit with it (unit.lua:1259-1263), a
  -- TrashBag flush — therefore completes in the SAME beat. Taking one snapshot
  -- deferred each such cascade by a beat.
  -- Termination is not in question: Entity::Destroy refuses to queue an entity
  -- twice (`if self.__destroyQueued then return end`, moho.lua), so every
  -- entity enters this queue at most once.
  while table.getn(__deletionQueue) > 0 do
  local queue = __deletionQueue
  __deletionQueue = {}
  for _, e in ipairs(queue) do
    if not e.__destroyed then
      if e.OnDestroy then
        local ok, err = pcall(function() e:OnDestroy() end)
        if not ok then WARN('OnDestroy: ' .. tostring(err)) end
      end
      -- Entity::OnDestroy goes on with the attachment callbacks
      -- (Cfile:916143-916162): OnAttachedDestroyed on the parent, the
      -- detach, OnParentDestroyed on every attached entity.
      __attachOnDestroyed(e)
      e.__destroyed = true
      -- A dying entity's ambient loop stops (the engine releases the HSound
      -- with the entity — CSimSoundManager loop handles).
      if e.__ambientHandle then
        __audioRequest(2, nil, nil, e.__ambientHandle)
        e.__ambientHandle = false
      end
      if e.__isProj then
        __projectiles[e.__id] = nil
      elseif e.__isProp then
        -- A dying MAP prop reports its instance index exactly once — the
        -- browser hides it in the instanced renderer (map props are not
        -- serialized per beat).
        if e.__mapIndex and not e.__removalReported then
          e.__removalReported = true
          __removedMapProps[#__removedMapProps + 1] = e.__mapIndex
        end
        __props[e.__id] = nil
      else
        -- OnDestroy strips this structure's adjacency buffs from its neighbours,
        -- but ONLY when it was NOT killed (the Kill path already ran the teardown,
        -- moho.lua:158) and only for a complete immobile structure
        -- (Cfile:952388-952409; the `not e.__dead` guard mirrors the engine's
        -- `!mIsDead` at 952388, __notifyNotAdjacent enforces the immobile /
        -- not-being-built gate). Without this an upgrade or reclaim
        -- (defaultunits.lua:267 self:Destroy()) leaks the old building's buffs
        -- onto its neighbours and they stack across the upgrade chain.
        if not e.__dead and __notifyNotAdjacent then __notifyNotAdjacent(e.__id) end
        __units[e.__id] = nil
        __econUnregister(e.__army or 1, e.__id)
      end
    end
  end
  end
end
