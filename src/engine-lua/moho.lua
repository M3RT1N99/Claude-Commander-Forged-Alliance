-- =====================================================================
-- moho — the engine's C++ base classes, as the original Lua sees them.
--
-- The real engine registers its C++ methods with CScrLuaInitForm (luadef_*)
-- and publishes the resulting metatables as moho.<x>_methods. The original
-- Lua derives from them: Unit = Class(moho.unit_methods), Weapon =
-- Class(moho.weapon_methods), AIBrain = Class(moho.aibrain_methods).
--
-- class.lua COPIES base fields into the derived class, so these must be real
-- fields on the base class — a metatable __index fallback would not be copied.
--
-- Method names are 1:1 from the decompiled Lua bindings
-- (luadef_C<Class><Method>.mMethodName). Methods without a body are here
-- deliberate no-ops: the engine subsystem behind them (bones, effects, target
-- acquisition) does not exist yet. Nothing here invents game behavior —
-- everything with a body reads or writes real state.
--
-- Instance state lives in self.__* fields, which the TS side reads and writes.
-- =====================================================================

local function noop() end

-- Fill in a no-op for every listed name that has no explicit body.
--
-- `parent` matters: class.lua copies base fields into the derived class, so a
-- no-op placed on the derived class SHADOWS a real implementation on the base.
-- GetHealth appears in both the entity and the unit binding list — filling it
-- with a no-op on the unit silently made every unit report zero health. So a
-- name the parent already implements is never no-op'd here.
local function withNoops(names, methods, parent)
  for _, name in ipairs(names) do
    if methods[name] == nil and not (parent and parent[name]) then
      methods[name] = noop
    end
  end
  return methods
end

-- ---------------------------------------------------------------------
-- entity_methods (CEntity) — 72 bindings
-- ---------------------------------------------------------------------
local ENTITY_NAMES = {
  'AddLocalImpulse', 'AddManualScroller', 'AddPingPongScroller', 'AddShooter',
  'AddThreadScroller', 'AddWorldImpulse', 'AdjustHealth', 'AttachBoneTo', 'AttachTo',
  'BeenDestroyed', 'CategoryContainsSim', 'CategoryContainsUser', 'CategoryCount',
  'CategoryCountAroundPosition', 'CategoryEmpty', 'CategoryFilterDownSim',
  'CategoryFilterDownUser', 'CategoryFilterOut', 'CreateProjectile',
  'CreateProjectileAtBone', 'CreatePropAtBone', 'Destroy', 'DetachAll', 'DetachFrom',
  'DisableIntel', 'EnableIntel', 'GetAIBrain', 'GetArmy', 'GetBlueprint',
  'GetBoneCount', 'GetBoneDirection', 'GetBoneName', 'GetCollisionExtents',
  'GetEntityId', 'GetFractionComplete', 'GetHeading', 'GetHealth', 'GetIntelRadius',
  'GetMaxHealth', 'GetOrientation', 'GetParent', 'GetPosition', 'GetPositionXYZ',
  'GetScale', 'HideBone', 'InitIntel', 'IsIntelEnabled', 'IsValidBone', 'Kill',
  'PlaySound', 'ReachedMaxShooters', 'RemoveScroller', 'RemoveShooter',
  'RequestRefreshUI', 'SetAmbientSound', 'SetBoneEnabled', 'SetCollisionShape',
  'SetDrawScale', 'SetHealth', 'SetIntelRadius', 'SetMaxHealth', 'SetMesh',
  'SetOrientation', 'SetParentOffset', 'SetPosition', 'SetScale', 'SetVizToAllies',
  'SetVizToEnemies', 'SetVizToFocusPlayer', 'SetVizToNeutrals', 'ShakeCamera',
  'ShowBone',
}

local entity = withNoops(ENTITY_NAMES, {
  GetBlueprint = function(self) return self.__bp end,
  GetEntityId = function(self) return self.__id end,
  GetArmy = function(self) return self.__army or 1 end,
  GetAIBrain = function(self) return self.__brain end,
  GetParent = function(self) return self.__parent end,

  -- Life cycle. Entity::Destroy (Cfile:916089) does NOT delete immediately: it sets
  -- mDestroyQueued and hangs the entity in Sim::mDeletionQueue. Only at the end
  -- of the beat, Entity::OnDestroy runs — and with it the Lua callback OnDestroy,
  -- which empties the TrashBag (unit.lua:1244). If you delete it immediately, you lose it.
  Destroy = function(self)
    if self.__destroyQueued then return end
    self.__destroyQueued = true
    __queueDeletion(self)
  end,
  BeenDestroyed = function(self)
    return self.__destroyQueued == true or self.__destroyed == true
  end,

  -- Health. The engine just stalls — it doesn't kill anyone at 0 HP
  -- (Entity::AdjustHealth, Cfile:915978). This is what Unit:DoTakeDamage does in Lua.
  GetHealth = function(self) return self.__health or 0 end,
  GetMaxHealth = function(self)
    if self.__maxHealth then return self.__maxHealth end
    return (self.__bp and self.__bp.Defense and self.__bp.Defense.MaxHealth) or 0
  end,
  SetMaxHealth = function(self, hp) self.__maxHealth = hp end,

  -- OnHealthChanged ONLY fires when QUANTIZED at 25% levels
  -- Proportion changes (round(ratio*4)/4, Cfile:916030-916050). That's exactly why
  -- comments unit.lua:823 “Health values ​​come in at fixed 25% intervals” —
  -- The damage smokers (ManageDamageEffects) depend on this.
  SetHealth = function(self, instigator, hp)
    local max = self:GetMaxHealth()
    local old = self.__health or 0
    local new = math.max(0, math.min(hp, max))
    self.__health = new
    if max > 0 and self.OnHealthChanged then
      -- The engine quantizes with FLOOR, not commercially: `frndint` with
      -- the correction `if (x < round(x)) -1` (Cfile:916030-916037) results in
      -- positive x exactly floor(x). Fired with +0.5 (round-half-up).
      -- OnHealthChanged a tad too early at the 12.5/37.5/62.5/87.5% boundaries.
      local qOld = math.floor((old / max) * 4) / 4
      local qNew = math.floor((new / max) * 4) / 4
      if qOld ~= qNew then
        pcall(function() self:OnHealthChanged(qNew, qOld) end)
      end
    end
  end,
  AdjustHealth = function(self, instigator, delta)
    self:SetHealth(instigator, (self.__health or 0) + delta)
  end,
  GetFractionComplete = function(self) return self.__fraction or 1 end,

  -- Moho::Unit::Kill (Cfile:951962) — the engine kills, the Lua has it
  -- arranged (unit.lua:809 from DoTakeDamage).
  --
  --   1. already dead -> out
  --   2. Lua CheckCanBeKilled(self, instigator) darf es verhindern (Cfile:952042)
  --   3. Construction site with FractionComplete < 0.5 -> excessDamageRatio = 10.0
  --      (Cfile:952122-952126). In the Lua, 10.0 means: NO WRECK
  --      (unit.lua:1079: overkillRatio > 1 -> no wreck). You can do that
  --      not think up, and without this line leaves every half-finished one
  --      Construction site a complete wreck.
  --   4. Lua SetDead (Cfile:952128) -> mIsDead
  --   5. Lua OnKilled(instigator, type, overkillRatio) (Cfile:952177)
  Kill = function(self, instigator, damageType, excessDamageRatio)
    if self.__dead then return end
    if self.CheckCanBeKilled then
      local ok, res = pcall(function() return self:CheckCanBeKilled(instigator) end)
      if ok and res == false then return end
    end
    local overkill = excessDamageRatio or 0.0
    if self.__beingBuilt and (self.__fraction or 1) < 0.5 then overkill = 10.0 end

    self.__dead = true
    if self.SetDead then pcall(function() self:SetDead() end) end

    -- OnKilled FIRST, KILLS AFTER — the order in cfunc_EntityKillL:
    -- first `v4->Kill(...)` (fires OnKilled internally, Cfile:936149), then that
    -- KILLS counter on the Instigator (Cfile:936183). This is load bearing:
    -- OnKilled -> instigator:OnKilledUnit -> CheckVeteranLevel liest
    -- `GetStat('KILLS',0).Value + 1` (unit.lua:3139) — the +1 applies exactly BECAUSE
    -- the engine hasn't counted this kill yet. If you count beforehand, it increases
    -- the unit gets up one kill too early.
    if self.OnKilled then
      local ok, err = pcall(function()
        self:OnKilled(instigator, damageType or '', overkill)
      end)
      if not ok then WARN('OnKilled: ' .. tostring(err)) end
    end

    -- The kill statistics count the ENGINE (Cfile:936180-936183) — unit.lua:3083
    -- relies on it (“kills through the engine are already counted”).
    -- BENIGN targets (wrecks, claimable items) do NOT count (Cfile:936164).
    if instigator and instigator.__isUnit and not self.__beingBuilt
      and instigator.__army ~= self.__army
      and not EntityCategoryContains(categories.BENIGN, self) then
      local stat = instigator.__stats or {}
      stat.KILLS = (stat.KILLS or 0) + 1
      instigator.__stats = stat
    end
  end,
  -- SetCollisionShape(shape, cx, cy, cz, size…) (Cfile:934167). unit.lua:922
  -- This switches off the collision during the death animation ('None').
  SetCollisionShape = function(self, shape, cx, cy, cz, sx, sy, sz)
    self.__collisionShape = { shape = shape, x = cx, y = cy, z = cz, sx = sx, sy = sy, sz = sz }
  end,

  -- Entity:CreateProjectile(proj_bp, [ox,oy,oz], [dx,dy,dz]) (Cfile:930715).
  -- Start Pose = Entity Pose + Offset; Direction is missing -> from the blueprint.
  -- Damage 0, type 'Normal' - a projectile created in this way does no damage
  -- (the weapon passes it separately, PassDamageData).
  CreateProjectile = function(self, bpId, ox, oy, oz, dx, dy, dz)
    local p, q = __boneWorld(self, nil)
    p = { p[1] + (ox or 0), p[2] + (oy or 0), p[3] + (oz or 0) }
    if dx or dy or dz then
      local len = math.sqrt((dx or 0) ^ 2 + (dy or 0) ^ 2 + (dz or 0) ^ 2)
      if len > 0 then
        q = __orientFromDir({ (dx or 0) / len, (dy or 0) / len, (dz or 0) / len })
      end
    end
    return __projCreate(self, bpId, p, q, nil, 0, 0, 'Normal', nil, true)
  end,

  -- Entity:CreateProjectileAtBone(projectile_blueprint, bone) (Cfile:930926).
  CreateProjectileAtBone = function(self, bpId, bone)
    local p, q = __boneWorld(self, bone)
    return __projCreate(self, bpId, p, q, nil, 0, 0, 'Normal', nil, true)
  end,

  -- Transform. __pos is {x, y, z}, __orient a quaternion.
  --
  -- The engine returns a VECTOR, not a bare array: the original Lua
  -- accesses BOTH — `pos[1]` (aeonweapons.lua:105) and `pos.x`
  -- (effectutilities.lua:274). Without the fields, any building effect dies
  -- "attempt to perform arithmetic on a nil value".
  -- "Entity:GetPosition([bone])" (Cfile:934579): WITH bone the world position
  -- this very bone — that's where the starting point of a shot comes from.
  GetPosition = function(self, bone)
    if bone ~= nil then
      local p = __boneWorld(self, bone)
      return Vector(p[1], p[2], p[3])
    end
    local p = self.__pos or { 0, 0, 0 }
    return Vector(p[1] or p.x or 0, p[2] or p.y or 0, p[3] or p.z or 0)
  end,
  GetPositionXYZ = function(self, bone)
    if bone ~= nil then
      local p = __boneWorld(self, bone)
      return p[1], p[2], p[3]
    end
    local p = self.__pos or { 0, 0, 0 }
    return p[1], p[2], p[3]
  end,

  -- "Entity:GetBoneDirection(nameOrIndex)" (cfunc_EntityGetBoneDirectionL,
  -- Cfile:931469-931505): the engine fetches the world quaternion of the bone and
  -- rotates with it (0,0,1) — the viewing direction of a bone is its +Z-AXIS.
  -- Return: THREE numbers, no vector.
  GetBoneDirection = function(self, bone)
    local _, q = __boneWorld(self, bone)
    local d = __quatForward(q)
    return d[1], d[2], d[3]
  end,
  SetPosition = function(self, pos) self.__pos = pos end,
  GetOrientation = function(self) return self.__orient or { 0, 0, 0, 1 } end,
  SetOrientation = function(self, o) self.__orient = o end,
  GetHeading = function(self) return self.__heading or 0 end,

  SetMesh = function(self, mesh) self.__meshBp = mesh end,
  -- The character scale (unit.lua:1111 gives the wreck the UniformScale of
  -- Unit with). The renderer reads it from the prop snapshot.
  SetScale = function(self, s) self.__drawScale = s end,

  -- The skeleton. The engine knows it because it also has the model of the unit in the
  -- SIM loads (not just in the renderer): weapon turrets, construction bones, muzzles
  -- and effects all depend on bone names. `Unit.lua:2751 ValidateBone` and
  -- `weapon.lua:67 SetupTurret` are asking exactly that - no one can do it without a skeleton
  -- weapon can be constructed.
  --
  -- The names come from the SCM file (src/formats/scm.ts) and are used per
  -- Blueprint set (__setBones).
  GetBoneCount = function(self)
    return table.getn(__skeletonOf(self).names)
  end,
  GetBoneName = function(self, i)
    return __skeletonOf(self).names[i + 1]
  end,
  IsValidBone = function(self, bone)
    if bone == nil then return false end
    return __boneIndex(self, bone) ~= nil
  end,
})

-- ---------------------------------------------------------------------
-- unit_methods (CUnit) — 105 bindings, inherits from entity
-- ---------------------------------------------------------------------
local UNIT_NAMES = {
  'AddBuildRestriction', 'AddCommandCap', 'AddToggleCap', 'AlterArmor',
  'CalculateWorldPositionFromRelative', 'ClearFocusEntity', 'GetArmorMult',
  'GetAttacker', 'GetBuildRate', 'GetConsumptionPerSecondEnergy',
  'GetConsumptionPerSecondMass', 'GetCurrentLayer', 'GetFireState', 'GetFocusUnit',
  'GetGuards', 'GetHealth', 'GetNavigator', 'GetNumBuildOrders',
  'GetProductionPerSecondEnergy', 'GetProductionPerSecondMass', 'GetResourceConsumed',
  'GetScriptBit', 'GetTargetEntity', 'GetUnitId', 'GetVelocity', 'GetWeapon',
  'GetWeaponCount', 'IsBeingBuilt', 'IsIdleState', 'IsMoving', 'IsPaused', 'IsStunned',
  'IsUnitState', 'IsValidTarget', 'KillManipulator', 'KillManipulators',
  'PlayUnitAmbientSound', 'PlayUnitSound', 'RemoveBuildRestriction',
  'RemoveCommandCap', 'RemoveToggleCap', 'RestoreBuildRestrictions',
  'RestoreCommandCaps', 'RestoreToggleCaps', 'RevertElevation', 'RevertRegenRate',
  'ScaleGetBuiltEmitter', 'SetAccMult', 'SetAutoMode', 'SetBlockCommandQueue',
  'SetBreakOffDistanceMult', 'SetBreakOffTriggerMult', 'SetBuildRate', 'SetBusy',
  'SetCanBeKilled', 'SetCanTakeDamage', 'SetCapturable', 'SetConsumptionActive',
  'SetConsumptionPerSecondEnergy', 'SetConsumptionPerSecondMass', 'SetCreator',
  'SetCustomName', 'SetDoNotTarget', 'SetElevation', 'SetFireState', 'SetFocusEntity',
  'SetImmobile', 'SetIsValidTarget', 'SetPaused', 'SetProductionActive',
  'SetProductionPerSecondEnergy', 'SetProductionPerSecondMass', 'SetReclaimable',
  'SetRegenRate', 'SetScriptBit', 'SetShieldRatio', 'SetSpeedMult',
  'SetStrategicUnderlay', 'SetStunned', 'SetTurnMult', 'SetUnSelectable',
  'SetUnitState', 'SetWorkProgress', 'StopSiloBuild', 'StopUnitAmbientSound',
  'TestCommandCaps', 'TestToggleCaps', 'ToggleFireState', 'ToggleScriptBit',
  'WeaponBeenDestroyed', 'WeaponCanFire', 'WeaponChangeDamage',
  'WeaponChangeDamageRadius', 'WeaponChangeDamageType', 'WeaponChangeFiringTolerance',
  'WeaponChangeMaxHeightDiff', 'WeaponChangeMaxRadius', 'WeaponChangeMinRadius',
  'WeaponChangeProjectileBlueprint', 'WeaponChangeRateOfFire', 'WeaponCreateProjectile',
  'WeaponGetBlueprint', 'WeaponGetCurrentTarget', 'WeaponGetCurrentTargetPos',
  'WeaponGetFireClockPct', 'WeaponGetFiringRandomness', 'WeaponGetProjectileBlueprint',
  'WeaponHasTarget', 'WeaponIsFireControl', 'WeaponPlaySound', 'WeaponSetEnabled',
  'WeaponSetFireControl', 'WeaponSetFireTargetLayerCaps', 'WeaponSetFiringRandomness',
  'WeaponSetTargetingPriorities', 'WeaponTransferTarget',
  'GetStat', 'SetStat',
}

local unit = withNoops(UNIT_NAMES, {
  GetUnitId = function(self)
    return (self.__bp and self.__bp.BlueprintId) or self.__id
  end,

  -- Armor. The factor comes from /lua/armordefinition.lua — the file that
  -- imported the engine itself (Cfile:708539). Not an invented value.
  GetArmorMult = function(self, damageType) return __armorMult(self, damageType) end,
  AlterArmor = function(self, damageType, mult)
    self.__armorOverride = self.__armorOverride or {}
    self.__armorOverride[string.lower(tostring(damageType))] = mult
  end,

  -- Unit:GetStat(name, default) -> Table with .Value (Cfile:978066).
  -- unit.lua:3139 (CheckVeteranLevel) reads GetStat('KILLS', 0).Value; the
  -- Engine counts up KILLS when killing itself (Cfile:936068).
  GetStat = function(self, name, default)
    local v = (self.__stats or {})[name]
    if v == nil then v = default end
    return { Value = v }
  end,
  SetStat = function(self, name, value)
    self.__stats = self.__stats or {}
    self.__stats[name] = value
  end,

  -- FIRE-STATE. EFireState (Cfile:702842-702850): Mix = -1, ReturnFire = 0,
  -- HoldFire = 1, HoldGround = 2. Default of the unit: ReturnFire (Cfile:772277).
  -- "Return Fire" is NOT a mechanism, it is simply "not a HoldFire" — it
  -- There is no OnDamage->Fire path in the engine.
  -- Effect: the fire cycle does not fire with HoldFire (Cfile:983935) and the
  -- Target lock DELETES the target (Cfile:793085-793097). Both in weapons.lua.
  GetFireState = function(self) return self.__fireState or 0 end,
  SetFireState = function(self, state) self.__fireState = state end,
  ToggleFireState = function(self)
    self.__fireState = ((self.__fireState or 0) == 1) and 0 or 1
  end,

  -- SCRIPT BITS (Unit::ToggleScriptBit, Cfile:951395-951437): 1 << bit
  -- mScriptbits, then OnScriptBitSet/OnScriptBitClear(bit) in the Lua.
  -- Indizes (Cfile:656792-656811): 0 Shield, 1 Weapon, 2 Jamming, 3 Intel,
  -- 4 Production, 5 Stealth, 6 Generic, 7 Special, 8 Cloak.
  GetScriptBit = function(self, bit)
    local bits = self.__scriptBits or 0
    local n = tonumber(bit) or 0
    return (math.floor(bits / (2 ^ n)) % 2) == 1
  end,
  SetScriptBit = function(self, bit, state)
    local n = tonumber(bit) or 0
    local was = self:GetScriptBit(n)
    if was == (state == true) then return end
    self.__scriptBits = (self.__scriptBits or 0) + (state and (2 ^ n) or -(2 ^ n))
    local cb = state and self.OnScriptBitSet or self.OnScriptBitClear
    if cb then pcall(function() cb(self, n) end) end
  end,
  ToggleScriptBit = function(self, bit)
    self:SetScriptBit(bit, not self:GetScriptBit(bit))
  end,
  GetCurrentLayer = function(self) return self.__layer or 'Land' end,
  IsBeingBuilt = function(self) return self.__beingBuilt or false end,

  -- The assembly point of a factory. Without a set point, it is the factory itself
  -- — FactoryUnit.CalculateRollOffPoint (defaultunits.lua:578) looks for the
  -- the nearest RollOffPoint of the blueprint.
  -- Overcharge: the ACU stops it as long as it is not charged
  -- (cfunc_UnitSetOverchargePaused; uel0001_script.lua:35 setzt ihn beim
  -- Waffen-Aufbau).
  SetOverchargePaused = function(self, paused)
    self.__overchargePaused = paused == true
  end,
  IsOverchargePaused = function(self)
    return self.__overchargePaused == true
  end,

  GetRallyPoint = function(self)
    return self.__rally or self:GetPosition()
  end,
  SetRallyPoint = function(self, pos)
    self.__rally = pos
    return true
  end,
  IsUnitState = function(self) return false end,
  IsIdleState = function(self) return true end,
  IsPaused = function(self) return false end,
  IsStunned = function(self) return false end,

  -- Weapons: the engine builds one object per bp.Weapon entry (see units.lua).
  GetWeaponCount = function(self)
    return (self.__weapons and table.getn(self.__weapons)) or 0
  end,
  GetWeapon = function(self, i) return self.__weapons and self.__weapons[i] end,

  -- Economy: rates come from the blueprint, the active flags go to the army
  -- economy. Production and consumption are separate switches — mapping both
  -- to one flag once killed the production of every finished building,
  -- because OnStopBeingBuilt calls SetConsumptionActive(false).
  GetBuildRate = function(self)
    return (self.__bp and self.__bp.Economy and self.__bp.Economy.BuildRate) or 0
  end,
  GetProductionPerSecondEnergy = function(self)
    return (self.__bp and self.__bp.Economy and self.__bp.Economy.ProductionPerSecondEnergy) or 0
  end,
  GetProductionPerSecondMass = function(self)
    return (self.__bp and self.__bp.Economy and self.__bp.Economy.ProductionPerSecondMass) or 0
  end,
  GetConsumptionPerSecondEnergy = function(self)
    return (self.__bp and self.__bp.Economy and self.__bp.Economy.MaintenanceConsumptionPerSecondEnergy) or 0
  end,
  GetConsumptionPerSecondMass = function(self)
    return (self.__bp and self.__bp.Economy and self.__bp.Economy.MaintenanceConsumptionPerSecondMass) or 0
  end,
  SetProductionActive = function(self, active)
    __econSetProductionActive(self.__army or 1, self.__id, active)
  end,
  SetConsumptionActive = function(self, active)
    __econSetConsumptionActive(self.__army or 1, self.__id, active)
  end,
  -- The granted share of the requested resources this tick
  -- (CEconRequest::LimitingRate); 1 means the demand was fully met.
  GetResourceConsumed = function(self) return self.__resourceConsumed or 1 end,

  -- Motion.
  GetNavigator = function(self) return self.__navigator end,
  IsMoving = function(self)
    if self.__goal then return true end
    return false
  end,
  GetVelocity = function(self)
    local s = self.__speed or 0
    local h = self.__heading or 0
    return math.sin(h) * s, 0, math.cos(h) * s
  end,
}, entity)

-- ---------------------------------------------------------------------
-- weapon_methods (CWeapon) — the unit's Weapon* bindings without the prefix.
-- GetWeapon(i) returns a proxy over (unit, index); Weapon (weapon.lua:13)
-- derives from this.
-- ---------------------------------------------------------------------
local WEAPON_NAMES = {
  'BeenDestroyed', 'CanFire', 'ChangeDamage', 'ChangeDamageRadius', 'ChangeDamageType',
  'ChangeFiringTolerance', 'ChangeMaxHeightDiff', 'ChangeMaxRadius', 'ChangeMinRadius',
  'ChangeProjectileBlueprint', 'ChangeRateOfFire', 'CreateProjectile', 'GetBlueprint',
  'GetCurrentTarget', 'GetCurrentTargetPos', 'GetFireClockPct', 'GetFiringRandomness',
  'GetParent', 'GetProjectileBlueprint', 'HasTarget', 'IsFireControl', 'PlaySound',
  'ResetTarget', 'SetEnabled', 'SetFireControl', 'SetFireTargetLayerCaps',
  'SetFiringRandomness', 'SetTargetEntity', 'SetTargetGround',
  'SetTargetingPriorities', 'SetValidTargetsForCurrentLayer', 'SetWeaponPriorities',
  'TransferTarget',
}

local weapon = withNoops(WEAPON_NAMES, {
  GetBlueprint = function(self) return self.__bp end,
  GetParent = function(self) return self.__unit end,
  BeenDestroyed = function(self) return self.__destroyed == true end,
  HasTarget = function(self) return self.__target ~= nil end,
  GetCurrentTarget = function(self) return self.__target end,
  SetEnabled = function(self, e) self.__enabled = e end,

  -- Weapon:CanFire() (Cfile:987703-987735): HasTarget && UnitWeapon::CanFire &&
  -- CheckSilo && target solution available. ONLY he writes `mCanFire` himself
  -- Aim Manipulator (Cfile:862074-862092); without a tower it remains on the
  -- Ctor value 1 (Cfile:984168) — non-turreted weapons can always fire.
  CanFire = function(self)
    if self.__enabled == false then return false end
    if self.__unit and self.__unit.__stunned then return false end
    return self.__target ~= nil
  end,

  -- Set the target - the FLANK triggers the callbacks (Cfile:985364/985494):
  -- OnGotTarget only for no->one target, OnLostTarget only for one->no target.
  -- Anyone who fires it every time it is called will restart the volley FSM again and again.
  SetTargetEntity = function(self, target) __weaponSetTarget(self, target) end,
  SetTargetGround = function(self, pos) __weaponSetTarget(self, nil, __vec3(pos)) end,
  ResetTarget = function(self) __weaponSetTarget(self, nil, nil) end,

  -- GetCurrentTargetPos: the world position of what the weapon is aiming at
  -- (Cfile:987621). defaultweapons.lua:114 uses this to calculate the detonation height.
  GetCurrentTargetPos = function(self)
    if self.__target and self.__target.__pos then
      local p = self.__target.__pos
      return Vector(p[1], p[2], p[3])
    end
    if self.__targetGround then
      local p = self.__targetGround
      return Vector(p[1], p[2], p[3])
    end
    return nil
  end,

  -- GetFireClockPct = 1 - mFireClock / (10/RoF) (Cfile:988512-988531).
  GetFireClockPct = function(self)
    local bp = self.__bp or {}
    local rof = bp.RateOfFire or 1
    local full = math.floor(10 / rof)
    if full <= 0 then return 1 end
    return 1 - ((self.__fireClock or 0) / full)
  end,

  -- Runtime overrides. The CWeaponAttributes ctor sets it to -1
  -- (Cfile:983289-983304): NEGATIVE means “take the blueprint value”.
  ChangeRateOfFire = function(self, rof) self.__rateOfFire = rof end,
  ChangeMaxRadius = function(self, r) self.__maxRadius = r end,
  ChangeMinRadius = function(self, r) self.__minRadius = r end,
  ChangeDamage = function(self, d) self.__damage = d end,
  ChangeDamageRadius = function(self, r) self.__damageRadius = r end,
  ChangeDamageType = function(self, t) self.__damageType = t end,
  ChangeProjectileBlueprint = function(self, bpId) self.__projectileId = bpId end,
  GetProjectileBlueprint = function(self)
    return self.__projectileId or (self.__bp and self.__bp.ProjectileId)
  end,

  -- UnitWeapon:CreateProjectile(muzzlebone) — THE SHOT (Cfile:985613-985800).
  --
  -- Without ProjectileId the engine will not fire a projectile but will make one
  -- DoInstaHit and returns nil (Cfile:985658-985675) — CreateProjectileAtMuzzle
  -- check carefully.
  --
  -- MuzzleVelocity != 0 overwrites the amount of the starting speed.
  -- Lifetime in TICKS: ProjectileLifetime * 10, else
  -- (MaxRadius / MuzzleVelocity) * ProjectileLifetimeUsesMultiplier * 10.
  CreateProjectile = function(self, bone)
    local bp = self.__bp or {}
    local u = self.__unit
    local projId = self:GetProjectileBlueprint()
    if not projId or projId == '' then
      -- DoInstaHit: the hit happens immediately, without a flying body.
      __weaponInstaHit(self)
      return nil
    end

    local pos, quat = __boneWorld(u, bone)
    -- Target direction: the engine takes the muzzle axis with it
    -- UseFiringSolutionInsteadOfAimBone the direction to the target (Cfile:985700ff).
    -- Our towers are not rotating yet (the AimManipulators are dummies),
    -- That's why we ALWAYS aim over the target solution - otherwise every weapon would fire
    -- stur nach vorn.
    --
    -- Aiming at the BODY (CAiTarget::GetTargetPosGun — a target point
    -- ON the unit), not on the feet: `__pos` is the ground position, and
    -- A shot at the feet falls with gravity BEFORE the target
    -- Floor - effective hits only happened by chance.
    local tp = nil
    if self.__target then
      tp = __unitCollision(self.__target)
    elseif self.__targetGround then
      tp = self.__targetGround
    end

    local speed = nil
    if bp.MuzzleVelocity and bp.MuzzleVelocity ~= 0 then speed = bp.MuzzleVelocity end

    if tp then
      local dx, dy, dz = tp[1] - pos[1], tp[2] - pos[2], tp[3] - pos[3]
      local aimed = false

      -- BALLISTISCHE FEUERLOESUNG (Moho::AI_CalculateFiringPitch,
      -- Cfile:790870-790905). A projectile with gravity falls on the way -
      -- the engine raises the launch angle exactly so that the bow is on the
      -- Target lands (that's what `BallisticArc = 'RULEUBA_LowArc'` says in the
      -- Blueprint). Verbatim from the decomp:
      --   dxz  = horizontale Distanz
      --   A    = -(dxz^2 * gravity.y) / (2 * v^2)        (gravity.y = -4.9)
      --   disc = dxz^2 - 4 * A * (dy + A)
      --   lowArc  = atan((dxz - sqrt(disc)) / (2A))
      --   highArc = atan((dxz + sqrt(disc)) / (2A))      (Artillerie)
      -- Without the solution, every flat shot fell into the ground BEFORE the target.
      local projPhys = __registered.Projectile[string.lower(tostring(projId))]
      projPhys = projPhys and projPhys.Physics
      local useGravity = projPhys and projPhys.UseGravity ~= false
      local v0 = speed or (projPhys and projPhys.InitialSpeed) or 0

      if useGravity and v0 > 0 and bp.BallisticArc ~= 'RULEUBA_None' then
        local dxz = math.sqrt(dx * dx + dz * dz)
        if dxz > 0.001 then
          local A = (__simGravity * dxz * dxz) / (2 * v0 * v0)
          local disc = dxz * dxz - 4 * A * (dy + A)
          if disc >= 0 and A > 0 then
            local sq = math.sqrt(disc)
            local t = (bp.BallisticArc == 'RULEUBA_HighArc') and (dxz + sq) or (dxz - sq)
            local pitch = math.atan(t / (2 * A))
            local horiz = math.cos(pitch)
            quat = __orientFromDir({
              (dx / dxz) * horiz, math.sin(pitch), (dz / dxz) * horiz,
            })
            aimed = true
          end
        end
      end

      -- Out of ballistic range or without gravity: aim directly.
      if not aimed then
        local len = math.sqrt(dx * dx + dy * dy + dz * dz)
        if len > 0 then
          quat = __orientFromDir({ dx / len, dy / len, dz / len })
        end
      end
    end

    local damage = self.__damage or bp.Damage or 0
    local radius = self.__damageRadius or bp.DamageRadius or 0
    local proj = __projCreate(
      u, projId, pos, quat, speed, damage, radius,
      self.__damageType or bp.DamageType or 'Normal', self.__target,
      bp.IgnoresAlly ~= false
    )
    -- LeadTarget comes from WEAPON (Struct-Default 1, weapons.md:1001):
    -- Guided ammunition stops at the target (UpdateTracking @944470).
    if proj then proj.__leadTarget = bp.LeadTarget ~= false end

    -- Lebensdauer (Cfile:985760ff).
    if proj and not proj.__destroyQueued then
      local life
      if bp.ProjectileLifetime and bp.ProjectileLifetime > 0 then
        life = bp.ProjectileLifetime
      elseif bp.MuzzleVelocity and bp.MuzzleVelocity > 0 then
        life = ((bp.MaxRadius or 0) / bp.MuzzleVelocity)
          * (bp.ProjectileLifetimeUsesMultiplier or 1)
      end
      if life and life > 0 then proj:SetLifetime(life) end
    end
    return proj
  end,

  -- Weapon:PlaySound(cue) — the weapon asks for its firing sound. The sim has
  -- no audio output (the UI VM has that); It is collected anyway, so that
  -- the tests show THAT there was a shot.
  PlaySound = function(self, cue) __simSoundRequested(cue) end,
}, entity)

-- ---------------------------------------------------------------------
-- aibrain_methods (CAiBrain) — 66 bindings. The brain's LOGIC is not here:
-- AIBrain (aibrain.lua:342) derives from this class and brings its own
-- (ESRegisterUnitMassStorage, InitializeEconomyState, …). Only the C++ part
-- lives here, and its economy accessors read the real army economy.
-- ---------------------------------------------------------------------
local AIBRAIN_NAMES = {
  'AddArmyStat', 'AssignThreatAtPosition', 'AssignUnitsToPlatoon', 'BuildPlatoon',
  'BuildStructure', 'BuildUnit', 'CanBuildPlatoon', 'CanBuildStructureAt',
  'CheckBlockingTerrain', 'CreateResourceBuildingNearest', 'CreateUnitNearSpot',
  'DecideWhatToBuild', 'DisbandPlatoon', 'DisbandPlatoonUniquelyNamed',
  'FindClosestArmyWithBase', 'FindPlaceToBuild', 'FindUnit', 'FindUnitToUpgrade',
  'FindUpgradeBP', 'GetArmyIndex', 'GetArmyStartPos', 'GetArmyStat',
  'GetAttackVectors', 'GetAvailableFactories', 'GetBlueprintStat', 'GetCurrentEnemy',
  'GetCurrentUnits', 'GetEconomyIncome', 'GetEconomyRequested', 'GetEconomyStored',
  'GetEconomyStoredRatio', 'GetEconomyTrend', 'GetEconomyUsage', 'GetFactionIndex',
  'GetHighestThreatPosition', 'GetListOfUnits', 'GetMapWaterRatio', 'GetNoRushTicks',
  'GetNumPlatoonsTemplateNamed', 'GetNumPlatoonsWithAI', 'GetNumUnitsAroundPoint',
  'GetPersonality', 'GetPlatoonUniquelyNamed', 'GetPlatoonsList', 'GetThreatAtPosition',
  'GetThreatBetweenPositions', 'GetThreatsAroundPosition', 'GetUnitBlueprint',
  'GetUnitsAroundPoint', 'GiveResource', 'GiveStorage', 'IsAnyEngineerBuilding',
  'IsOpponentAIRunning', 'MakePlatoon', 'NumCurrentlyBuilding', 'PickBestAttackVector',
  'PlatoonExists', 'RemoveArmyStatsTrigger', 'SetArmyStat', 'SetArmyStatsTrigger',
  'SetCurrentEnemy', 'SetCurrentPlan', 'SetGreaterOf', 'SetResourceSharing',
  'SetUpAttackVectorsToArmy', 'TakeResource',
}

local aibrain = withNoops(AIBRAIN_NAMES, {
  GetArmyIndex = function(self) return self.__army or 1 end,
  GetFactionIndex = function(self) return self.__faction or 1 end,

  GetEconomyStored = function(self, res) return __econStored(self.__army or 1, res) end,
  GetEconomyStoredRatio = function(self, res) return __econStoredRatio(self.__army or 1, res) end,
  GetEconomyIncome = function(self, res) return __econIncome(self.__army or 1, res) end,
  GetEconomyUsage = function(self, res) return __econUsage(self.__army or 1, res) end,
  GetEconomyRequested = function(self, res) return __econRequested(self.__army or 1, res) end,
  GetEconomyTrend = function(self, res) return __econTrend(self.__army or 1, res) end,
  GiveResource = function(self, res, amount) __econGive(self.__army or 1, res, amount) end,
  TakeResource = function(self, res, amount) __econGive(self.__army or 1, res, -amount) end,

  GetListOfUnits = function(self, cat) return __armyUnits(self.__army or 1, cat) end,
  GetCurrentUnits = function(self, cat) return table.getn(__armyUnits(self.__army or 1, cat)) end,

  SetArmyStat = function(self, name, value)
    self.__stats = self.__stats or {}
    self.__stats[name] = { Value = value }
  end,
  GetArmyStat = function(self, name, default)
    local s = self.__stats and self.__stats[name]
    return s or { Value = default }
  end,

  -- The engine's THREAT MAP (a grid that the AI ​​reads). Our Sim
  -- does nothing — GetThreatAtPosition therefore returns 0: “There is nothing here
  -- entered". This is not an invented number, but the state of an empty one
  -- card, and it is a NUMBER: defaultunits.lua:1223 calculates unchecked
  -- `threat / 2` and took the entire path of death with it without it (no wreckage).
  GetThreatAtPosition = function(self, pos, rings, enemy, threatType) return 0 end,
  AssignThreatAtPosition = function(self, pos, threat, decay, threatType) end,
})

-- ---------------------------------------------------------------------
-- cursor_methods (CMauiCursor) — 5 bindings, UI VM only (scr_UserInits).
-- Cursor (cursor.lua:6) derives from this and calls _c_CreateCursor in __init.
-- The texture name is what the browser turns into a CSS cursor.
-- ---------------------------------------------------------------------
local CURSOR_NAMES = { 'Hide', 'ResetToDefault', 'SetDefaultTexture', 'SetNewTexture', 'Show' }

local cursor = withNoops(CURSOR_NAMES, {
  SetDefaultTexture = function(self, filename, hotspotX, hotspotY)
    self.__defaultTexture = { filename, hotspotX or 0, hotspotY or 0 }
  end,
  ResetToDefault = function(self)
    local d = self.__defaultTexture
    if d then self:SetNewTexture(d[1], d[2], d[3]) end
  end,
  SetNewTexture = function(self, filename, hotspotX, hotspotY)
    self.__texture = filename
    self.__hotspot = { hotspotX or 0, hotspotY or 0 }
    if __uiSetCursorTexture then __uiSetCursorTexture(filename, hotspotX or 0, hotspotY or 0) end
  end,
  Show = function(self) self.__hidden = false end,
  Hide = function(self) self.__hidden = true end,
})

-- ---------------------------------------------------------------------
-- control_methods (CMauiControl) — 25 bindings, UI VM only.
-- Control (control.lua:28) derives from this. The LazyVars (Left/Top/…) are
-- attached by InternalCreate* (see maui.lua), not by these methods.
-- ---------------------------------------------------------------------
local CONTROL_NAMES = {
  'AbandonKeyboardFocus', 'AcquireKeyboardFocus', 'ApplyFunction', 'ClearChildren',
  'Destroy', 'DisableHitTest', 'EnableHitTest', 'GetAlpha', 'GetCurrentFocusControl',
  'GetName', 'GetParent', 'GetRenderPass', 'GetRootFrame', 'Hide', 'HitTest',
  'IsHidden', 'IsHitTestDisabled', 'NeedsFrameUpdate', 'SetAlpha', 'SetHidden',
  'SetName', 'SetNeedsFrameUpdate', 'SetParent', 'SetRenderPass', 'Show',
}

local control = withNoops(CONTROL_NAMES, {
  GetParent = function(self) return self.__parent or nil end,
  SetParent = function(self, parent)
    self.__parent = parent or false
    if parent then
      parent.__children[table.getn(parent.__children) + 1] = self
    end
    __mauiDirty = true
  end,
  ClearChildren = function(self)
    for _, c in ipairs(self.__children or {}) do c:Destroy() end
    self.__children = {}
    __mauiDirty = true
  end,
  Destroy = function(self)
    self:ClearChildren()
    if self.OnDestroy then self:OnDestroy() end
    __mauiControls[self.__id] = nil
    self.__destroyed = true
    __mauiDirty = true
  end,

  GetName = function(self) return self.__name end,
  SetName = function(self, name) self.__name = name end,

  Hide = function(self) self:SetHidden(true) end,
  Show = function(self) self:SetHidden(false) end,
  SetHidden = function(self, hidden)
    self.__hidden = hidden == true
    __mauiDirty = true
  end,
  IsHidden = function(self) return self.__hidden == true end,

  SetAlpha = function(self, alpha, children)
    self.__alpha = alpha
    if children then
      for _, c in ipairs(self.__children or {}) do c:SetAlpha(alpha, true) end
    end
    __mauiDirty = true
  end,
  GetAlpha = function(self) return self.__alpha or 1 end,

  -- "Control:DisableHitTest([recursive])" / "Control:EnableHitTest([recursive])"
  -- (Cfile:1125051/1125109). The OPTIONAL recursive flag is not an accessory:
  -- uiutil.lua:993 (`ret:DisableHitTest(true)`) makes the decorative brackets
  -- of a dialog is mouse-permeable. If you ignore it, leave the brackets
  -- continue to hit - and because the buttons are at the SAME depth
  -- and are in front of it in the tree order wins at `mDepth > best`
  -- (Cfile:1124509, really bigger) the bracket. The tutorial dialog wasn't like that
  -- more to answer.
  DisableHitTest = function(self, recursive)
    self.__hitTest = false
    if recursive then
      for _, c in ipairs(self.__children or {}) do c:DisableHitTest(true) end
    end
  end,
  EnableHitTest = function(self, recursive)
    self.__hitTest = true
    if recursive then
      for _, c in ipairs(self.__children or {}) do c:EnableHitTest(true) end
    end
  end,
  IsHitTestDisabled = function(self) return self.__hitTest == false end,

  -- Keyboard Focus (Cfile:1125718/1125768/1125828). If a control has focus,
  -- ONLY it gets the keys - and the keymap is silent (M3: IsKeyDown returns
  -- then false, Cfile:1141557). That's exactly why a hotkey doesn't trigger
  -- while someone is typing in the chat.
  AcquireKeyboardFocus = function(self, exclusive)
    local old = __mauiFocus
    if old and old ~= self and old.OnLoseKeyboardFocus then old:OnLoseKeyboardFocus() end
    __mauiFocus = self
    self.__focusExclusive = exclusive == true
    if self.OnKeyboardFocusChange then self:OnKeyboardFocusChange() end
  end,
  AbandonKeyboardFocus = function(self)
    if __mauiFocus == self then
      __mauiFocus = false
      if self.OnLoseKeyboardFocus then self:OnLoseKeyboardFocus() end
    end
  end,
  GetCurrentFocusControl = function(self)
    return __mauiFocus or nil
  end,

  SetNeedsFrameUpdate = function(self, needs) self.__needsFrameUpdate = needs == true end,
  NeedsFrameUpdate = function(self) return self.__needsFrameUpdate == true end,
  SetRenderPass = function(self, pass) self.__renderPass = pass end,
  GetRenderPass = function(self) return self.__renderPass or 0 end,

  GetRootFrame = function(self)
    local c = self
    while c.__parent do c = c.__parent end
    return c
  end,
})

-- ---------------------------------------------------------------------
-- bitmap_methods (CMauiBitmap) — 18 bindings.
-- SetNewTexture fills BitmapWidth/BitmapHeight from the texture masses
-- (Cfile:1118647) — that's why a bitmap is sized without a layout helper
-- seiner DDS (bitmap.lua:69-70).
-- ---------------------------------------------------------------------
local BITMAP_NAMES = {
  'GetFrame', 'GetNumFrames', 'InternalSetSolidColor', 'Loop', 'Play',
  'SetBackwardPattern', 'SetForwardPattern', 'SetFrame', 'SetFramePattern',
  'SetFrameRate', 'SetLoopPingPongPattern', 'SetNewTexture', 'SetPingPongPattern',
  'SetTiled', 'SetUV', 'ShareTextures', 'Stop', 'UseAlphaHitTest',
}

local bitmap = withNoops(BITMAP_NAMES, {
  SetNewTexture = function(self, filename, border)
    self.__texture = filename
    self.__border = border or 1
    local w, h = GetTextureDimensions(filename)
    self.BitmapWidth:Set(w or 0)
    self.BitmapHeight:Set(h or 0)
    __mauiDirty = true
  end,
  InternalSetSolidColor = function(self, color)
    self.__solidColor = color
    __mauiDirty = true
  end,
  SetUV = function(self, u0, v0, u1, v1)
    self.__uv = { u0, v0, u1, v1 }
    __mauiDirty = true
  end,
  SetTiled = function(self, tiled) self.__tiled = tiled == true end,
  ShareTextures = function(self, other)
    if other and other.__texture then self:SetNewTexture(other.__texture, other.__border) end
  end,
  GetFrame = function(self) return self.__frame or 0 end,
  GetNumFrames = function(self) return 1 end,
}, control)

-- ---------------------------------------------------------------------
-- text_methods (CMauiText) — 9 bindings.
-- GetStringAdvance is mandatory: no layout can be calculated without text width
-- (Cfile:1146720). The width comes from the engine (font metrics).
-- ---------------------------------------------------------------------
local TEXT_NAMES = {
  'GetStringAdvance', 'GetText', 'SetCenteredHorizontally', 'SetCenteredVertically',
  'SetDropShadow', 'SetNewClipToWidth', 'SetNewColor', 'SetNewFont', 'SetText',
}

-- TextAdvance is the width of the typed text (text.lua:47 makes this the
-- width of the control). It depends on text AND writing - that is, after each
-- Redraw changes from both.
local function refreshTextAdvance(self)
  self.TextAdvance:Set(
    __mauiStringAdvance(self.__text or '', self.__fontFamily or '', self.__fontSize or 12)
  )
end

local text = withNoops(TEXT_NAMES, {
  SetText = function(self, str)
    -- tostring, because the UI Lua also passes NUMBERS (economy.lua writes
    -- their values ​​directly into the controls). The engine accepts a string;
    -- LuaPlus converts a number itself when passing it. Without this transformation
    -- the font metric gets a number to measure - and chokes.
    self.__text = str ~= nil and tostring(str) or ''
    refreshTextAdvance(self)
    __mauiDirty = true
  end,
  GetText = function(self) return self.__text or '' end,
  SetNewFont = function(self, family, pointSize)
    self.__fontFamily = family
    self.__fontSize = pointSize
    -- The engine populates FontAscent/FontDescent/FontExternalLeading from the
    -- Font (Cfile:1145928-1145930); text.lua:39 makes the most of it.
    local asc, desc = __mauiFontMetrics(family, pointSize)
    self.FontAscent:Set(asc)
    self.FontDescent:Set(desc)
    self.FontExternalLeading:Set(0)
    refreshTextAdvance(self)
    __mauiDirty = true
  end,
  SetNewColor = function(self, color)
    self.__color = color
    __mauiDirty = true
  end,
  SetCenteredHorizontally = function(self, on) self.__centerH = on == true end,
  SetCenteredVertically = function(self, on) self.__centerV = on == true end,
  GetStringAdvance = function(self, str)
    return __mauiStringAdvance(str or '', self.__fontFamily or '', self.__fontSize or 12)
  end,
}, control)

-- ---------------------------------------------------------------------
-- frame_methods (CMauiFrame) — 3 bindings.
-- ---------------------------------------------------------------------
local FRAME_NAMES = { 'GetTargetHead', 'GetTopmostDepth', 'SetTargetHead' }
local frame = withNoops(FRAME_NAMES, {
  -- "int GetTargetHead()" (Cfile:1136990) — the screen on which this frame
  -- lies. We have exactly one head; __mauiCreateRootFrame appends it as
  -- __head on. uiutil.lua:671 thus increases its dialogue depth:
  --   GetFrame(parent:GetRootFrame():GetTargetHead()):GetTopmostDepth() + 1
  GetTargetHead = function(self) return self.__head or 0 end,
  SetTargetHead = function(self, head) self.__head = head end,

  -- "float GetTopmostDepth()" (Cfile:1136937) — the greatest depth that can be found in
  -- assigned to this frame. This creates a dialogue ABOUT everything that already exists
  -- there is (uiutil.lua:671, +1). A fixed value (here it said 5000000) would be one
  -- invented number: two dialogues sat at the same depth, and the second
  -- laege je nach Zeichenreihenfolge zufaellig hinten.
  GetTopmostDepth = function(self)
    local top = 0
    for _, c in pairs(__mauiControls) do
      if not c.__destroyed then
        local root = c
        while root.__parent do root = root.__parent end
        if root == self then
          local d = c.Depth()
          if d and d > top then top = d end
        end
      end
    end
    return top
  end,
}, control)

-- ---------------------------------------------------------------------
-- border_methods (CMauiBorder) — 2 Bindungen.
--
-- A Border is the 9-slice frame of the original UI (dialogs, panels): four
-- Edges + four corners, the middle remains free.
--
--   SetNewTextures(vertical, horizontal, upperLeft, upperRight, lowerLeft, lowerRight)
--   SetSolidColor(color)
--
-- (mHelp literally, Cfile:1123156.) The method sets the two LazyVars,
-- which the engine gives to the control: BorderWidth from the WIDTH of the
-- vertical texture, BorderHeight from the HEIGHT of the horizontal texture
-- (Cfile:1122728/1122748 — SetValue(mBorderWidthLV, width) bzw.
-- SetValue(mBorderHeightLV, height)). border.lua:11-13 sagt es selbst:
-- "SetTextures will set the BorderWidth and BorderHeight lazy vars."
--
-- Each argument can be nil: border.lua:28 calls the method SIX TIMES, each
-- Sometimes with exactly one texture set (one LazyVar per tile, OnDirty).
local BORDER_NAMES = { 'SetNewTextures', 'SetSolidColor' }
local border = withNoops(BORDER_NAMES, {
  SetNewTextures = function(self, vertical, horizontal, upperLeft, upperRight, lowerLeft, lowerRight)
    self.__border = self.__border or {}
    local b = self.__border
    if vertical then b.vertical = vertical end
    if horizontal then b.horizontal = horizontal end
    if upperLeft then b.upperLeft = upperLeft end
    if upperRight then b.upperRight = upperRight end
    if lowerLeft then b.lowerLeft = lowerLeft end
    if lowerRight then b.lowerRight = lowerRight end

    -- The measurements come from the TEXTURES, not from a number in the script.
    if b.vertical then
      local w = GetTextureDimensions(b.vertical)
      if w then self.BorderWidth:Set(w) end
    end
    if b.horizontal then
      local _, h = GetTextureDimensions(b.horizontal)
      if h then self.BorderHeight:Set(h) end
    end
    __mauiDirty = true
  end,
  SetSolidColor = function(self, color)
    self.__border = self.__border or {}
    self.__border.solidColor = color
    __mauiDirty = true
  end,
}, control)

-- ---------------------------------------------------------------------
-- Publish. Unknown moho.<x> keys become empty classes on demand, so a script
-- deriving from a subsystem we have not built yet still loads (and then fails
-- loudly at the first real call, which is what we want).
-- ---------------------------------------------------------------------
moho = setmetatable({}, {
  __index = function(t, k)
    local c = Class() {}
    rawset(t, k, c)
    return c
  end,
})

-- ---------------------------------------------------------------------
-- projectile_methods (Moho::Projectile) — 30 bindings, Sim VM only
-- (docs/research/engine-api.md, class `Projectile`).
--
-- Projectile.lua:16: `Projectile = Class(moho.projectile_methods, Entity)`.
--
-- EVERY setter returns `self` (Cfile:947725, `return 1` with the Lua object)
-- — the original Lua concatenated:
--   defaultweapons.lua:777 unit:CreateProjectile(id,0,0,0,nil,nil,nil):SetCollision(false)
-- If you don't return anything here, you'll set this line to nil.
--
-- And SetTurnRate is DEGREES/second, not radians: the engine writes directly
-- mTurnRateDeg (Cfile:947724) and multiplies by in the MotionTick
-- 0.0017453292 = pi/180 * 0.1. The mHelp text ("radians_per_second") is incorrect.
-- ---------------------------------------------------------------------
local PROJECTILE_NAMES = {
  'ChangeDetonateAboveHeight', 'ChangeDetonateBelowHeight', 'ChangeMaxZigZag',
  'ChangeZigZagFrequency', 'CreateChildProjectile', 'GetCurrentSpeed',
  'GetCurrentTargetPosition', 'GetLauncher', 'GetTrackingTarget', 'GetVelocity',
  'SetAcceleration', 'SetBallisticAcceleration', 'SetCollideEntity',
  'SetCollideSurface', 'SetCollision', 'SetDamage', 'SetDestroyOnWater',
  'SetLifetime', 'SetLocalAngularVelocity', 'SetMaxSpeed', 'SetNewTarget',
  'SetNewTargetGround', 'SetScaleVelocity', 'SetStayUpright', 'SetTurnRate',
  'SetVelocity', 'SetVelocityAlign', 'SetVelocityRandomUpVector',
  'StayUnderwater', 'TrackTarget',
}

local projectile = withNoops(PROJECTILE_NAMES, {
  GetLauncher = function(self) return self.__launcher end,
  GetTrackingTarget = function(self) return self.__target end,

  GetVelocity = function(self)
    local v = self.__vel or { 0, 0, 0 }
    return v[1], v[2], v[3]
  end,
  GetCurrentSpeed = function(self)
    local v = self.__vel or { 0, 0, 0 }
    return math.sqrt(v[1] * v[1] + v[2] * v[2] + v[3] * v[3])
  end,
  GetCurrentTargetPosition = function(self)
    if self.__target and self.__target.__pos then
      local p = self.__target.__pos
      return Vector(p[1], p[2], p[3])
    end
    if self.__targetGround then
      local p = self.__targetGround
      return Vector(p[1], p[2], p[3])
    end
    return nil
  end,

  -- SetVelocity(speed) OR SetVelocity(vx, vy, vz) — both forms are occupied
  -- (mHelp the binding). With one argument the DIRECTION remains and only that
  -- Amount is set.
  SetVelocity = function(self, x, y, z)
    local v = self.__vel or { 0, 0, 0 }
    if y == nil then
      local len = math.sqrt(v[1] * v[1] + v[2] * v[2] + v[3] * v[3])
      if len > 0 then
        self.__vel = { v[1] / len * x, v[2] / len * x, v[3] / len * x }
      else
        local f = __quatForward(self.__orient)
        self.__vel = { f[1] * x, f[2] * x, f[3] * x }
      end
    else
      self.__vel = { x, y, z }
    end
    return self
  end,
  SetMaxSpeed = function(self, s) self.__maxSpeed = s; return self end,
  SetAcceleration = function(self, a) self.__accel = a; return self end,
  SetBallisticAcceleration = function(self, a)
    -- A scalar: the acceleration DOWN (defaultexplosions.lua:319 sets
    -- thus the gravity of the rubble).
    self.__ballistic = { 0, a, 0 }
    return self
  end,
  SetTurnRate = function(self, degPerSec) self.__turnRate = degPerSec; return self end,
  SetLifetime = function(self, seconds)
    self.__lifetimeEnd = __gameTick + math.floor(seconds * 10)
    return self
  end,
  TrackTarget = function(self, on) self.__trackTarget = on ~= false; return self end,
  SetNewTarget = function(self, target) self.__target = target; return self end,
  SetNewTargetGround = function(self, pos) self.__targetGround = __vec3(pos); return self end,
  SetDamage = function(self, amount, radius)
    self.__damage = amount
    if radius then self.__damageRadius = radius end
    if self.DamageData then
      self.DamageData.DamageAmount = amount
      if radius then self.DamageData.DamageRadius = radius end
    end
    return self
  end,
  SetCollision = function(self, on)
    self.__collideEntity = on ~= false
    self.__collideSurface = on ~= false
    return self
  end,
  SetCollideEntity = function(self, on) self.__collideEntity = on ~= false; return self end,
  SetCollideSurface = function(self, on) self.__collideSurface = on ~= false; return self end,
  SetDestroyOnWater = function(self, on) self.__destroyOnWater = on ~= false; return self end,
  SetVelocityAlign = function(self, on) self.__velocityAlign = on ~= false; return self end,
  SetStayUpright = function(self, on) self.__stayUpright = on ~= false; return self end,
  StayUnderwater = function(self, on) self.__stayUnderwater = on ~= false; return self end,
  SetScaleVelocity = function(self, s) self.__scaleVel = s; return self end,
  CreateChildProjectile = function(self, bpId)
    return __projCreate(self.__launcher, bpId, self.__pos, self.__orient, nil,
      self.__damage or 0, self.__damageRadius or 0, self.__damageType or 'Normal', self.__target,
      self.__ignoresAlly)
  end,
}, entity)

-- ---------------------------------------------------------------------
-- prop_methods (Moho::Prop) — EXACTLY ONE custom binding: AddBoundedProp
-- (engine-api.md, class `Prop`; Cfile:1015752). Everything else inherits a prop from
-- Entity. Prop.lua:16: `Prop = Class(moho.prop_methods, Entity)`.
-- ---------------------------------------------------------------------
local prop = withNoops({ 'AddBoundedProp' }, {
  -- Limits the number of wrecks on the map (priority = mass). Our Sim
  -- has no upper limit - nothing happens here, and that's no lie:
  -- the engine only throws some away when there is an overflow.
  AddBoundedProp = function(self, priority) self.__boundedPriority = priority end,
}, entity)

-- ---------------------------------------------------------------------
-- CollisionBeamEntity (Moho::CollisionBeamEntity) — the WEAPON CONTINUOUS BEAMS.
--
-- DefaultBeamWeapon:OnCreate builds ONE CollisionBeam instance per muzzle
-- (defaultweapons.lua:802-816: BeamType{ Weapon, BeamBone=0, OtherBone=
-- muzzleBone, CollisionCheckInterval = BeamCollisionDelay*10 }) and
-- Enable() them when firing instead of creating a projectile. The engine
-- then casts a beam per CollisionCheckInterval (MotionTick counts,
-- Cfile:911386-911416; CheckCollision) and calls when the victim changes
-- OnImpact(type, entity) — the Lua does the damage (CollisionBeam.lua:186).
-- Bindungen: __init/SetBeamFx/Enable/Disable/IsEnabled/GetLauncher
-- (cfunc_CollisionBeamEntity*, Cfile:16648-16658), Rest inherits from Entity
-- (GetBoneCount = 2: Bone 0 = Anfang, Bone 1 = Treffpunkt).
-- The beam tick itself runs in weapons.lua (__beamTick).
-- ---------------------------------------------------------------------
__collisionBeams = {}

local collision_beam = withNoops({
  '__init', 'SetBeamFx', 'Enable', 'Disable', 'IsEnabled', 'GetLauncher',
}, {
  __init = function(self, spec)
    self.Weapon = spec.Weapon
    self.__muzzleBone = spec.OtherBone
    self.__interval = spec.CollisionCheckInterval or 10
    self.__intervalCount = 0
    self.__enabled = false
    self.__army = (spec.Weapon and spec.Weapon.unit and spec.Weapon.unit.__army) or 1
    -- Bone 0 = mouth, Bone 1 = meeting point (identical until the first check).
    self.__beamBones = { { 0, 0, 0 }, { 0, 0, 0 } }
    self.__beamOrient = { 1, 0, 0, 0 }
    __collisionBeams[#__collisionBeams + 1] = self
    -- The engine calls OnCreate during entity creation — CollisionBeam.lua:40
    -- creates BeamEffectsBag/TerrainEffectsBag/Trash in it; without the call
    -- CreateBeamEffects dies because of the missing table.
    if self.OnCreate then self:OnCreate() end
  end,
  Enable = function(self)
    if self.__enabled then return end
    self.__enabled = true
    self.__lastImpact = nil
    if self.OnEnable then self:OnEnable() end
  end,
  Disable = function(self)
    if not self.__enabled then return end
    self.__enabled = false
    if self.OnDisable then self:OnDisable() end
  end,
  IsEnabled = function(self) return self.__enabled == true end,
  GetLauncher = function(self) return self.Weapon and self.Weapon.unit end,
  -- The visible beam emitter depends on us anyway (AttachBeamToEntity,
  -- Bone 0 -> Bone 1) — just note here.
  SetBeamFx = function(self, fx, collideOnStart)
    self.__fxBeam = fx
    self.__collideOnStart = collideOnStart == true
  end,
  GetBoneCount = function(self) return 2 end,
}, entity)

rawset(moho, 'entity_methods', Class() (entity))
-- WITH entity_methods as a base — different from projectile/prop: CollisionBeam.lua
-- DO NOT add Entity itself (pure `Class(moho.CollisionBeamEntity)`,
-- CollisionBeam.lua:16); in the original, the C++ class inherits from Entity.
rawset(moho, 'CollisionBeamEntity', Class(moho.entity_methods) (collision_beam))
rawset(moho, 'unit_methods', Class(moho.entity_methods) (unit))
rawset(moho, 'weapon_methods', Class(moho.entity_methods) (weapon))
-- WITHOUT entity_methods as a basis — and that's no accident:
--   Projectile.lua:16  Projectile = Class(moho.projectile_methods, Entity)
--   Prop.lua:16        Prop       = Class(moho.prop_methods, Entity)
-- The original Lua mixes the entity methods ITSELF (entity from
-- /lua/sim/Entity.lua is already Class(moho.entity_methods)). We would here
-- also inherit from entity_methods, each entity field would come in via TWO ways
-- the class — and class.lua:147 aborts with "field 'X' is ambiguous".
rawset(moho, 'projectile_methods', Class() (projectile))
rawset(moho, 'prop_methods', Class() (prop))
rawset(moho, 'aibrain_methods', Class() (aibrain))
rawset(moho, 'cursor_methods', Class() (cursor))

-- maui (UI VM only). group_methods has no bindings of its own — a Group is
-- a CMauiControl with the class "group" (that's why CMauiGroup isn't there either
-- in the decomp list). The empty class provides the lazy-moho by itself.
rawset(moho, 'control_methods', Class() (control))
-- ---------------------------------------------------------------------
-- item_list_methods (CMauiItemList) — 18 Bindungen.
--
-- The game's line list: EACH dropdown is a (combo.lua:117), to
-- Map selection, points list, chat, EULA. The engine holds rows, selections and
-- Scroll position itself — the mHelp strings (Cfile:1140151-1141154) are here
-- literally the signature:
--
--   itemlist = ItemList:AddItem('newitem')      item = ItemList:GetItem(index)
--   ItemList:ModifyItem(index, string)          ItemList:DeleteItem(index)
--   int ItemList:GetItemCount()                 bool ItemList:Empty()
--   index = ItemList:GetSelection()             ItemList:SetSelection(index)
--   float ItemList:GetRowHeight()               ItemList:ShowItem(index)
--   bool NeedsScrollBar()                       ItemList:ScrollToTop()
--   SetNewColors(fg, bg, selFg, selBg)          SetNewFont(family, pointsize)
--
-- The selection is 0-BASED (combo.lua calculates with index+1 in Lua tables), and
-- "no selection" is -1.
-- ---------------------------------------------------------------------
local ITEM_LIST_NAMES = {
  'AddItem', 'DeleteAllItems', 'DeleteItem', 'Empty', 'GetItem', 'GetItemCount',
  'GetRowHeight', 'GetSelection', 'GetStringAdvance', 'ModifyItem', 'NeedsScrollBar',
  'ScrollToTop', 'SetNewColors', 'SetNewFont', 'SetSelection', 'ShowItem',
  'ShowMouseoverItem', 'ShowSelection',
}
local item_list = withNoops(ITEM_LIST_NAMES, {
  AddItem = function(self, text)
    self.__items[table.getn(self.__items) + 1] = tostring(text)
    __mauiDirty = true
    return self
  end,
  ModifyItem = function(self, index, text)
    self.__items[index + 1] = tostring(text)
    __mauiDirty = true
    return self
  end,
  DeleteItem = function(self, index)
    table.remove(self.__items, index + 1)
    __mauiDirty = true
    return self
  end,
  DeleteAllItems = function(self)
    self.__items = {}
    self.__selection = -1
    self.__top = 0
    __mauiDirty = true
    return self
  end,
  GetItem = function(self, index) return self.__items[index + 1] end,
  GetItemCount = function(self) return table.getn(self.__items) end,
  Empty = function(self) return table.getn(self.__items) == 0 end,
  GetSelection = function(self) return self.__selection end,
  SetSelection = function(self, index)
    self.__selection = index
    __mauiDirty = true
  end,

  -- The line height comes from the WRITING, not from a constant: the
  -- Engine measures the upper and lower length of the set font (the same metric,
  -- which uses text.lua:39). combo.lua calculates its height from this.
  GetRowHeight = function(self)
    local a, d = __mauiFontMetrics(self.__fontFamily, self.__fontSize)
    return math.floor(a + d + 0.5)
  end,
  GetStringAdvance = function(self, str)
    return __mauiStringAdvance(str, self.__fontFamily, self.__fontSize)
  end,

  SetNewFont = function(self, family, pointsize)
    self.__fontFamily = family or ''
    self.__fontSize = pointsize or 12
    __mauiDirty = true
  end,
  SetNewColors = function(self, fg, bg, selFg, selBg)
    self.__colors = { fg = fg, bg = bg, selFg = selFg, selBg = selBg }
    __mauiDirty = true
  end,
  ShowSelection = function(self, on) self.__showSelection = on ~= false end,
  ShowMouseoverItem = function(self, on) self.__showMouseover = on ~= false end,

  -- "bool NeedsScrollBar() - returns true if a scrollbar is needed, else false":
  -- Can more lines fit in the list than it is high?
  NeedsScrollBar = function(self)
    local rows = math.floor(self.Height() / math.max(1, self:GetRowHeight()))
    return table.getn(self.__items) > rows
  end,
  ScrollToTop = function(self)
    self.__top = 0
    __mauiDirty = true
  end,
  ShowItem = function(self, index)
    -- Bring the line into the view window (Cfile: SetTopItem/ScrollToItem).
    local rows = math.max(1, math.floor(self.Height() / math.max(1, self:GetRowHeight())))
    if index < self.__top then
      self.__top = index
    elseif index >= self.__top + rows then
      self.__top = index - rows + 1
    end
    __mauiDirty = true
  end,

  -- ATTENTION: the Scrollable protocol (GetScrollValues/ScrollLines/ScrollPages/
  -- ScrollSetTop) does NOT belong here. `control.lua:104-118` defines it
  -- already, and then `ItemList = Class(moho.item_list_methods, Control)` would have
  -- two base classes with the same field — class.lua:147 says this verbatim
  -- "field 'ScrollPages' is ambiguous in class definition" and the import of
  -- itemlist.lua bricht ab.
  --
  -- This also fits the engine: a CMauiItemList scrolls in C++, not over
  -- Lua methods. The scrollbar asks you directly (__mauiScrollValues ​​in maui.lua).
}, control)

-- ---------------------------------------------------------------------
-- edit_methods (CMauiEdit) — 31 Bindungen.
--
-- The text field: Chat, Rename, Console, Lobby, Build Templates. The editing
-- itself runs in the engine via MET_Char (CMauiEdit::HandleKeyEvent) — the
-- Lua only sees GetText/SetText and the OnEnterPressed/OnEscPressed callbacks.
-- ---------------------------------------------------------------------
local EDIT_NAMES = {
  'AbandonFocus', 'AcquireFocus', 'ClearText', 'DisableInput', 'EnableInput',
  'GetBackgroundColor', 'GetCaretColor', 'GetCaretPosition', 'GetFontHeight',
  'GetForegroundColor', 'GetHighlightBackgroundColor', 'GetHighlightForegroundColor',
  'GetMaxChars', 'GetStringAdvance', 'GetText', 'IsBackgroundVisible', 'IsCaretVisible',
  'IsEnabled', 'SetCaretCycle', 'SetCaretPosition', 'SetDropShadow', 'SetMaxChars',
  'SetNewBackgroundColor', 'SetNewCaretColor', 'SetNewFont', 'SetNewForegroundColor',
  'SetNewHighlightBackgroundColor', 'SetNewHighlightForegroundColor', 'SetText',
  'ShowBackground', 'ShowCaret',
}
local edit = withNoops(EDIT_NAMES, {
  SetText = function(self, text)
    self.__text = tostring(text or '')
    self.__caret = string.len(self.__text)
    __mauiDirty = true
  end,
  GetText = function(self) return self.__text end,
  ClearText = function(self)
    self.__text = ''
    self.__caret = 0
    __mauiDirty = true
  end,
  SetMaxChars = function(self, n) self.__maxChars = n end,
  GetMaxChars = function(self) return self.__maxChars end,
  SetCaretPosition = function(self, p) self.__caret = p end,
  GetCaretPosition = function(self) return self.__caret end,
  EnableInput = function(self) self.__enabled = true end,
  DisableInput = function(self) self.__enabled = false end,
  IsEnabled = function(self) return self.__enabled end,
  SetNewFont = function(self, family, pointsize)
    self.__fontFamily = family or ''
    self.__fontSize = pointsize or 12
    __mauiDirty = true
  end,
  GetFontHeight = function(self)
    local a, d = __mauiFontMetrics(self.__fontFamily, self.__fontSize)
    return math.floor(a + d + 0.5)
  end,
  GetStringAdvance = function(self, str)
    return __mauiStringAdvance(str, self.__fontFamily, self.__fontSize)
  end,
  SetNewForegroundColor = function(self, c) self.__colors.fg = c __mauiDirty = true end,
  SetNewBackgroundColor = function(self, c) self.__colors.bg = c __mauiDirty = true end,
  GetForegroundColor = function(self) return self.__colors.fg end,
  GetBackgroundColor = function(self) return self.__colors.bg end,
  AcquireFocus = function(self) self:AcquireKeyboardFocus(false) end,
  AbandonFocus = function(self) self:AbandonKeyboardFocus() end,
}, control)

-- ---------------------------------------------------------------------
-- scrollbar_methods (CMauiScrollbar) — 4 Bindungen (mHelp woertlich):
--
--   Scrollbar:SetScrollable(scrollable)
--   Scrollbar:SetTextures(background, thumbMiddle, thumbTop, thumbBottom)
--   DoScrollLines(float)   DoScrollPages(float)
--
-- The scrollbar doesn't calculate anything itself: it calls the scrollable protocol on the
-- Object he got (Cfile:1124664/1124731/1124775).
-- ---------------------------------------------------------------------
local SCROLLBAR_NAMES = { 'DoScrollLines', 'DoScrollPages', 'SetNewTextures', 'SetScrollable' }
local scrollbar = withNoops(SCROLLBAR_NAMES, {
  SetScrollable = function(self, scrollable)
    self.__scrollable = scrollable or false
    __mauiDirty = true
  end,
  SetNewTextures = function(self, background, thumbMiddle, thumbTop, thumbBottom)
    self.__textures = {
      background = background,
      thumbMiddle = thumbMiddle,
      thumbTop = thumbTop,
      thumbBottom = thumbBottom,
    }
    __mauiDirty = true
  end,
  DoScrollLines = function(self, lines)
    __mauiScroll(self.__scrollable, self.__axis, 'lines', lines)
  end,
  DoScrollPages = function(self, pages)
    __mauiScroll(self.__scrollable, self.__axis, 'pages', pages)
  end,
}, control)

-- ---------------------------------------------------------------------
-- movie_methods (CMauiMovie) — 7 Bindungen (mHelp woertlich):
--
--   bool Movie:InternalSet(filename)
--   Play()   Stop()   Loop(bool)   IsLoaded()
--   number GetFrameRate() - returns the frame rate of the movie in FPS
--   int GetNumFrames() - returns the number of frames in the movie
--
-- There is no SFD decoder - and the engine has a documented one
-- Way: CMauiMovie::LoadFile returns FALSE if no movie is loaded
-- can (Cfile:1143020-1143035; that's exactly what happens with /nomovie on the
-- command line). movie.lua:32-53 intercepts this and calls OnStopped().
--
-- This is the REAL way: splash.lua goes through to the main menu, and
-- main.lua builds its menu without a background film - both without a single one
-- Special case in code. A movie that was never loaded has 0 frames and 0 FPS;
-- This is not a made-up number, but the truth about an empty movie.
local MOVIE_NAMES = { 'GetFrameRate', 'GetNumFrames', 'InternalSet', 'IsLoaded', 'Loop', 'Play', 'Stop' }
local movie = withNoops(MOVIE_NAMES, {
  InternalSet = function(self, filename)
    self.__file = filename or false
    self.__playing = false
    return false
  end,
  IsLoaded = function(self) return false end,
  Play = function(self) self.__playing = true end,
  Stop = function(self) self.__playing = false end,
  Loop = function(self, loop) self.__loop = loop == true end,
  GetFrameRate = function(self) return 0 end,
  GetNumFrames = function(self) return 0 end,
}, control)

-- ---------------------------------------------------------------------
-- UIWorldView (CUIWorldView) — 17 bindings. The world view is a CONTROL.
--
-- That's the reason why the minimap can be moved in the original: it
-- IS a WorldView (minimap.lua:115) that hangs in a window.
--
-- Your __init is in C++ — mHelp verbatim (Cfile:1300209):
--   moho.UIWorldView:__init(parent_control, cameraName, depth, isMiniMap, trackCamera)
--
-- The remaining signatures are also verbatim:
--   Reset()                         SetCartographic(bool)     bool IsCartographic()
--   LockInput(camera)               UnlockInput(camera)       IsInputLocked(camera)
--   EnableResourceRendering(bool)   bool IsResourceRenderingEnabled()
--   SetHighlightEnabled(bool)       bool HasHighlightCommand()
--   GetsGlobalCameraCommands(bool)  string GetRightMouseButtonOrder()
--   (vector2f|nil) = GetScreenPos(unit)
--   VECTOR2 Project(self, VECTOR3) - Weltpunkt -> Control-Koordinaten
--   ZoomScale(x, y, wheelRot, wheelDelta)
--
-- The world is drawn by the 3D engine, not by the Maui renderer: that
-- Control only says WHERE and HOW BIG. What is a condition here is a condition; What
-- Geometry needs (Project, GetScreenPos), the 3D page provides
-- __uiWorldProject — without it, it is not guessed, but reported nil.
-- ---------------------------------------------------------------------
local WORLDVIEW_NAMES = {
  '__init', 'CameraReset', 'EnableResourceRendering', 'GetRightMouseButtonOrder',
  'GetScreenPos', 'GetsGlobalCameraCommands', 'HasHighlightCommand', 'IsCartographic',
  'IsInputLocked', 'IsResourceRenderingEnabled', 'LockInput', 'Project', 'Reset',
  'SetCartographic', 'SetHighlightEnabled', 'UnlockInput', 'ZoomScale',
}
local worldview = withNoops(WORLDVIEW_NAMES, {
  __init = function(self, parent, cameraName, depth, isMiniMap, trackCamera)
    __uiCreateWorldView(self, parent, cameraName, depth, isMiniMap, trackCamera)
  end,

  SetCartographic = function(self, on)
    self.__cartographic = on == true
    __mauiDirty = true
  end,
  IsCartographic = function(self) return self.__cartographic == true end,

  EnableResourceRendering = function(self, on)
    self.__resourceIcons = on == true
    __mauiDirty = true
  end,
  IsResourceRenderingEnabled = function(self) return self.__resourceIcons == true end,

  LockInput = function(self) self.__inputLocked = true end,
  UnlockInput = function(self) self.__inputLocked = false end,
  IsInputLocked = function(self) return self.__inputLocked == true end,

  SetHighlightEnabled = function(self, on) self.__highlight = on == true end,
  HasHighlightCommand = function(self) return false end,

  GetsGlobalCameraCommands = function(self, on) self.__globalCameraCommands = on == true end,

  -- "string moho.UIWorldView:GetRightMouseButtonOrder()" — which command hangs
  -- just click on the right mouse button. The decision is made by the engine
  -- Selection; As long as they don't exist, NOTHING will be claimed.
  GetRightMouseButtonOrder = function(self) return nil end,

  -- World point -> Control coordinates. Only the 3D side (projection of the
  -- Camera); it attaches itself as __uiWorldProject.
  Project = function(self, pos)
    if not __uiWorldProject then return nil end
    return __uiWorldProject(self.__id, pos[1], pos[2], pos[3])
  end,
  GetScreenPos = function(self, unit)
    if not __uiWorldProject or not unit then return nil end
    local p = unit:GetPosition()
    return __uiWorldProject(self.__id, p[1], p[2], p[3])
  end,
}, control)

rawset(moho, 'bitmap_methods', Class(moho.control_methods) (bitmap))
rawset(moho, 'text_methods', Class(moho.control_methods) (text))
rawset(moho, 'frame_methods', Class(moho.control_methods) (frame))
rawset(moho, 'border_methods', Class(moho.control_methods) (border))
rawset(moho, 'item_list_methods', Class(moho.control_methods) (item_list))
rawset(moho, 'edit_methods', Class(moho.control_methods) (edit))
rawset(moho, 'scrollbar_methods', Class(moho.control_methods) (scrollbar))
-- ---------------------------------------------------------------------
-- camera_methods (CameraImpl) — 25 Bindungen, mHelp woertlich:
--
--   Camera:Reset()                       Camera:SnapTo(position, orientationHPR, zoom)
--   Camera:MoveTo(position, orientationHPR, zoom, seconds)
--   Camera:MoveToRegion(region[,seconds])
--   Camera:SetZoom(zoom, seconds)        Camera:GetZoom()
--   Camera:SetTargetZoom(zoom)           Camera:GetTargetZoom()
--   Camera:GetMinZoom()                  Camera:GetMaxZoom()
--   Camera:SetMaxZoomMult()              Camera:GetFocusPosition()
--   Camera:Spin(headingRate[,zoomRate])  Camera:HoldRotation()  Camera:RevertRotation()
--   Camera:TrackEntities(ents,zoom,seconds)  Camera:TargetEntities(ents,zoom,seconds)
--   Camera:NoseCam(ent,pitchAdjust,zoom,seconds,transition)
--   Camera:SaveSettings() / RestoreSettings(settings)
--   Camera:EnableEaseInOut() / DisableEaseInOut()  Camera:SetAccMode(accTypeName)
--   Camera:UseGameClock() / UseSystemClock()
--
-- There are SEVERAL cameras, distinguished by their names ('WorldCamera',
-- 'MiniMap', 'CameraHead2') — worldview.lua:593 gets them with GetCamera(name).
--
-- The camera ITSELF is the 3D side (TypeScript). Here is just the status
-- and the bridge: __uiCameraCall(name, method, …). If the bridge is missing,
-- nothing claims.
-- ---------------------------------------------------------------------
local CAMERA_NAMES = {
  'DisableEaseInOut', 'EnableEaseInOut', 'GetFocusPosition', 'GetMaxZoom', 'GetMinZoom',
  'GetTargetZoom', 'GetZoom', 'HoldRotation', 'MoveTo', 'MoveToRegion', 'NoseCam',
  'Reset', 'RestoreSettings', 'RevertRotation', 'SaveSettings', 'SetAccMode',
  'SetMaxZoomMult', 'SetTargetZoom', 'SetZoom', 'SnapTo', 'Spin', 'TargetEntities',
  'TrackEntities', 'UseGameClock', 'UseSystemClock',
}
local camera = withNoops(CAMERA_NAMES, {
  GetZoom = function(self) return __uiCameraGet(self.__name, 'zoom') end,
  GetTargetZoom = function(self) return __uiCameraGet(self.__name, 'targetZoom') end,
  GetMinZoom = function(self) return __uiCameraGet(self.__name, 'minZoom') end,
  GetMaxZoom = function(self) return __uiCameraGet(self.__name, 'maxZoom') end,
  GetFocusPosition = function(self) return __uiCameraGet(self.__name, 'focus') end,
  SetZoom = function(self, zoom, seconds) __uiCameraSet(self.__name, 'zoom', zoom, seconds) end,
  SetTargetZoom = function(self, zoom) __uiCameraSet(self.__name, 'targetZoom', zoom) end,
  SetMaxZoomMult = function(self, mult) __uiCameraSet(self.__name, 'maxZoomMult', mult) end,
  Reset = function(self) __uiCameraSet(self.__name, 'reset', true) end,
  SnapTo = function(self, pos, hpr, zoom) __uiCameraMove(self.__name, pos, hpr, zoom, 0) end,
  MoveTo = function(self, pos, hpr, zoom, seconds)
    __uiCameraMove(self.__name, pos, hpr, zoom, seconds or 0)
  end,
})
rawset(moho, 'camera_methods', Class() (camera))

rawset(moho, 'movie_methods', Class(moho.control_methods) (movie))
rawset(moho, 'UIWorldView', Class(moho.control_methods) (worldview))


-- CMauiLuaDragger: NO control (no layout, no parent) — the engine holds
-- it separately and calls OnMove/OnRelease/OnCancel (Cfile:1130393-1130413).
-- dragger.lua:15 removes it himself: `OnRelease -> self:Destroy()`.
rawset(moho, 'dragger_methods', Class() ({
  Destroy = function(self)
    __mauiDraggerDestroy(self)
    self.__destroyed = true
  end,
}))
