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

-- ---------------------------------------------------------------------
-- func_DoDamagePoint (Cfile:1062873) — EIN Ziel.
-- ---------------------------------------------------------------------
local function damagePoint(instigator, origin, target, amount, damageType, damageSelf)
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

  -- OnDamageBy(armyIndex) — the Lua counts who fired (Cfile:1063052; unit.lua
  -- uses it for retaliation/stats). It fires whether or not a shield eats the hit.
  if inst and inst.__army and target.OnDamageBy then
    pcall(function() target:OnDamageBy(inst.__army) end)
  end

  -- Shield: a unit with an ACTIVE shield takes the hit on the shield first
  -- (native shield-sphere routing, Cfile:1062695). shield.lua's OnDamage applies
  -- the shield's OWN armor/handicap (OnGetDamageAbsorption) and passes overkill
  -- to the owner (Owner:DoTakeDamage) — so it receives the RAW amount, BEFORE the
  -- unit-armor reduction below.
  local shield = target.MyShield
  if shield and not shield.__destroyed and not shield.__destroyQueued
    and shield.IsOn and shield:IsOn() and shield:GetHealth() > 0 then
    local ok, err = pcall(function() shield:OnDamage(inst, amount, vec, damageType) end)
    if not ok then WARN('Shield OnDamage: ' .. tostring(err)) end
    return
  end

  local dealt = amount
  if target.__bp and not target.__isProj then
    dealt = dealt * __armorMult(target, damageType)
  end
  dealt = dealt / (1 + ArmyGetHandicap(target.__army or 1))

  if dealt <= 0 then return end

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
function DamageArea(instigator, location, radius, amount, damageType, damageFriendly, damageSelf)
  if amount == 0 then error('0 damage specified.', 2) end
  if radius == 0 then error('0 radius specified.', 2) end
  local origin = __vec3(location)
  local inst = instigator
  if inst and inst.__isProj then inst = inst.__launcher or inst end
  local instArmy = inst and inst.__army

  for _, u in pairs(__units) do
    local p = u.__pos
    local dx, dy, dz = p[1] - origin[1], p[2] - origin[2], p[3] - origin[3]
    if dx * dx + dy * dy + dz * dz <= radius * radius
      and splashEligible(u, inst, instArmy, damageFriendly, damageSelf) then
      damagePoint(instigator, origin, u, amount, damageType, damageSelf)
    end
  end
end

--- "DamageRing(instigator, location, minRadius, maxRadius, amount, damageType,
--- damageFriendly, [damageSelf])" (Cfile:1064409). Errors on 0 damage / 0 min /
--- 0 max radius (cfunc_DamageRingL, Cfile:1064503-1064507).
function DamageRing(instigator, location, minRadius, maxRadius, amount, damageType, damageFriendly, damageSelf)
  if amount == 0 then error('0 damage specified.', 2) end
  if minRadius == 0 then error('0 min radius specified.', 2) end
  if maxRadius == 0 then error('0 max radius specified.', 2) end
  local origin = __vec3(location)
  local inst = instigator
  if inst and inst.__isProj then inst = inst.__launcher or inst end
  local instArmy = inst and inst.__army

  for _, u in pairs(__units) do
    local p = u.__pos
    local dx, dy, dz = p[1] - origin[1], p[2] - origin[2], p[3] - origin[3]
    local d2 = dx * dx + dy * dy + dz * dz
    if d2 >= minRadius * minRadius and d2 <= maxRadius * maxRadius
      and splashEligible(u, inst, instArmy, damageFriendly, damageSelf) then
      damagePoint(instigator, origin, u, amount, damageType, damageSelf)
    end
  end
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
  local queue = __deletionQueue
  if table.getn(queue) == 0 then return end
  __deletionQueue = {}
  for _, e in ipairs(queue) do
    if not e.__destroyed then
      if e.OnDestroy then
        local ok, err = pcall(function() e:OnDestroy() end)
        if not ok then WARN('OnDestroy: ' .. tostring(err)) end
      end
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
        __units[e.__id] = nil
        __econUnregister(e.__army or 1, e.__id)
      end
    end
  end
end
