-- =====================================================================
-- DAMAGE, ARMOR, DEATH — the engine side.
--
-- Aufteilung (docs/research/damage-binary.md + combat-projectiles.md §4):
--   Lua entscheidet, WIEVIEL Schaden entsteht (Projectile:DoDamage ruft Damage/
--   DamageArea with the values ​​from the weapon blueprint).
--   Engine resolves it: Armor, Handicap, and then calls OnDamage on that
--   Goal. It does NOT drain HP (Entity::AdjustHealth is just stuck, Cfile:915978) —
--   This is what Unit:DoTakeDamage does in Lua (unit.lua:794-818).
--
-- Belege:
--   cfunc_DamageL         Cfile:1064167  (FUENF Argumente!)
--   cfunc_DamageAreaL     Cfile:1064280
--   cfunc_DamageRingL     Cfile:1064409
--   func_DoDamagePoint    Cfile:1062873  (Ruestung, Handicap, OnDamageBy, OnDamage)
--   Armor table Cfile:708539 (the engine imports /lua/armordefinition.lua)
--   Entity::SetHealth Cfile:916009 (OnHealthChanged only in 25% increments)
--   Moho::Unit::Kill Cfile:951962 (CheckCanBeKilled, SetDead, OnKilled)
--
-- STANDARD-LUA 5.4.
-- =====================================================================

-- ---------------------------------------------------------------------
-- The Armor Table. The engine imports /lua/armordefinition.lua and
-- looks for the ArmorType of the unit (case sensitive, stricmp
-- Cfile:708566); each additional line of the entry is "<damage type> <factor>".
-- Damage types not listed: factor 1.0.
-- ---------------------------------------------------------------------
__armorTable = false
-- Handicap comes from the lobby (ArmyGetHandicap). Without a lobby: none.
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
    -- Exactly the message from the engine (Cfile:708543).
    WARN("can't load the armordefinition module -- no armor for you.")
  end
  __armorTable = t
  return t
end

--- Unit:GetArmorMult(damageType) — the factor from the armor table.
function __armorMult(unit, damageType)
  local bp = unit.__bp
  local armor = (bp and bp.Defense and bp.Defense.ArmorType) or 'Default'
  -- AlterArmor(type, mult) overwrites at runtime (Cfile:972372).
  local altered = unit.__armorOverride and unit.__armorOverride[string.lower(tostring(damageType))]
  if altered then return altered end
  local defs = armorTable()[string.lower(tostring(armor))]
  if not defs then return 1.0 end
  return defs[string.lower(tostring(damageType or 'Normal'))] or 1.0
end

--- ArmyGetHandicap(army) — in skirmish without lobby handicap: 0.
--- (The engine divides by (1 + handicap), Cfile:1063020.)
function ArmyGetHandicap(army)
  return (__armyHandicap and __armyHandicap[army]) or 0
end

-- ---------------------------------------------------------------------
-- func_DoDamagePoint (Cfile:1062873) — ONE target.
-- ---------------------------------------------------------------------
local function damagePoint(instigator, origin, target, amount, damageType, damageSelf)
  if not target or target.__destroyQueued then return end
  if amount == 0 then return end

  -- A projectile as the causer is released onto its launcher
  -- (Cfile:1062930-1063000). Self-harm usually goes away - EXCEPT that
  -- Waffe verlangt ihn ausdruecklich (damageSelf, z. B. Kamikaze-/Selbstzerstoerungs-
  -- units). Without this penetration, DamageArea(damageSelf=true) hit the
  -- NEVER cause it, because this point damage always skipped him.
  local inst = instigator
  if inst and inst.__isProj then inst = inst.__launcher or inst end
  if not damageSelf and inst == target then return end

  local dealt = amount
  if target.__bp and not target.__isProj then
    dealt = dealt * __armorMult(target, damageType)
  end
  dealt = dealt / (1 + ArmyGetHandicap(target.__army or 1))

  if dealt <= 0 then return end

  -- OnDamageBy(armyIndex) — the Lua uses it to count who shot
  -- (Cfile:1063052; unit.lua uses it for retaliation/statistics).
  if inst and inst.__army and target.OnDamageBy then
    pcall(function() target:OnDamageBy(inst.__army) end)
  end

  local tp = target.__pos or { 0, 0, 0 }
  local vec = Vector(tp[1] - origin[1], tp[2] - origin[2], tp[3] - origin[3])

  -- And now the Lua engine says it — it deducts the HP itself
  -- (RunScript_EntityOnDamage, Cfile:1063151).
  if target.OnDamage then
    local ok, err = pcall(function() target:OnDamage(inst, dealt, vec, damageType) end)
    if not ok then WARN('OnDamage: ' .. tostring(err)) end
  end
end

--- "Damage(instigator, origin, target, amount, damageType)" — FUENF Argumente.
--- Engine mHelp text is deprecated (4); cfunc_DamageL checks
--- `lua_gettop != 5` (Cfile:1064215). `amount == 0` is a BUG, ​​not a no-op.
function Damage(instigator, origin, target, amount, damageType)
  if amount == 0 then error('0 damage specified.', 2) end
  damagePoint(instigator, __vec3(origin), target, amount, damageType)
end

--- "DamageArea(instigator, location, radius, amount, damageType, damageFriendly,
--- [damageSelf])" (Cfile:1064280).
---
--- NO distance falloff: every target in the radius gets the full amount
--- (damage-binary.md). Shields are still missing - the trigger via the shield balls
--- (Cfile:1062695) comes with the shield system.
function DamageArea(instigator, location, radius, amount, damageType, damageFriendly, damageSelf)
  local origin = __vec3(location)
  local inst = instigator
  if inst and inst.__isProj then inst = inst.__launcher or inst end
  local instArmy = inst and inst.__army

  for _, u in pairs(__units) do
    if not u.__destroyQueued then
      if damageSelf or u ~= inst then
        local friendly = instArmy ~= nil and u.__army == instArmy
        if damageFriendly or not friendly then
          local p = u.__pos
          local dx, dy, dz = p[1] - origin[1], p[2] - origin[2], p[3] - origin[3]
          if dx * dx + dy * dy + dz * dz <= radius * radius then
            damagePoint(instigator, origin, u, amount, damageType, damageSelf)
          end
        end
      end
    end
  end
end

--- "DamageRing(instigator, location, minRadius, maxRadius, amount, damageType,
--- damageFriendly, [damageSelf])" (Cfile:1064409).
function DamageRing(instigator, location, minRadius, maxRadius, amount, damageType, damageFriendly, damageSelf)
  local origin = __vec3(location)
  local inst = instigator
  if inst and inst.__isProj then inst = inst.__launcher or inst end
  local instArmy = inst and inst.__army

  for _, u in pairs(__units) do
    if not u.__destroyQueued then
      if damageSelf or u ~= inst then
        local friendly = instArmy ~= nil and u.__army == instArmy
        if damageFriendly or not friendly then
          local p = u.__pos
          local dx, dy, dz = p[1] - origin[1], p[2] - origin[2], p[3] - origin[3]
          local d2 = dx * dx + dy * dy + dz * dz
          if d2 >= minRadius * minRadius and d2 <= maxRadius * maxRadius then
            damagePoint(instigator, origin, u, amount, damageType, damageSelf)
          end
        end
      end
    end
  end
end

--- MetaImpact(instigator, location, radius, amount) — the IMPULSE of a
--- Impact (units are thrown away).
---
--- Our sim has no impulse physics (movement runs via the navigator,
--- motion.lua). That's why nothing happens here - and this is said ONCE,
--- instead of hiding it.
__metaImpactWarned = false
function MetaImpact(instigator, location, radius, amount)
  if not __metaImpactWarned then
    __metaImpactWarned = true
    WARN('MetaImpact: keine Impuls-Physik — Einheiten werden nicht weggeschleudert')
  end
end

--- A vector argument (table with x/y/z OR 1/2/3) in {x,y,z}.
function __vec3(v)
  if not v then return { 0, 0, 0 } end
  return { v[1] or v.x or 0, v[2] or v.y or 0, v[3] or v.z or 0 }
end

-- ---------------------------------------------------------------------
-- The delete queue (Sim::mDeletionQueue).
--
-- Entity::Destroy (Cfile:916089) does NOT delete immediately: it sets mDestroyQueued
-- and adds the entity to the queue. Only at the end of the beat
-- (Sim::AdvanceBeat, Cfile:1076638-1076656) runs Entity::OnDestroy — and with it
-- the Lua callback OnDestroy, which empties the TrashBag (unit.lua:1244).
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
      if e.__isProj then
        __projectiles[e.__id] = nil
      elseif e.__isProp then
        __props[e.__id] = nil
      else
        __units[e.__id] = nil
        __econUnregister(e.__army or 1, e.__id)
      end
    end
  end
end
