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
-- (luadef_C<Class><Method>.mMethodName). Methods without a body here are
-- deliberate no-ops: the engine subsystem behind them (bones, effects, target
-- acquisition) does not exist yet. Nothing here invents game behaviour —
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

  -- Lifecycle. IsDestroyed()/BeenDestroyed() read this flag (see globals.lua).
  Destroy = function(self)
    self.__destroyed = true
    if self.__id then
      __units[self.__id] = nil
      __econUnregister(self.__army or 1, self.__id)
    end
  end,
  BeenDestroyed = function(self) return self.__destroyed == true end,

  -- Health.
  GetHealth = function(self) return self.__health or 0 end,
  GetMaxHealth = function(self)
    return (self.__bp and self.__bp.Defense and self.__bp.Defense.MaxHealth) or 0
  end,
  SetHealth = function(self, instigator, hp)
    self.__health = math.max(0, math.min(hp, self:GetMaxHealth()))
  end,
  AdjustHealth = function(self, instigator, delta)
    self.__health = math.max(0, math.min((self.__health or 0) + delta, self:GetMaxHealth()))
  end,
  GetFractionComplete = function(self) return self.__fraction or 1 end,

  -- Transform. __pos is {x, y, z}, __orient a quaternion.
  GetPosition = function(self) return self.__pos or { 0, 0, 0 } end,
  GetPositionXYZ = function(self)
    local p = self.__pos or { 0, 0, 0 }
    return p[1], p[2], p[3]
  end,
  SetPosition = function(self, pos) self.__pos = pos end,
  GetOrientation = function(self) return self.__orient or { 0, 0, 0, 1 } end,
  SetOrientation = function(self, o) self.__orient = o end,
  GetHeading = function(self) return self.__heading or 0 end,

  SetMesh = function(self, mesh) self.__meshBp = mesh end,

  -- Das Skelett. Die Engine kennt es, weil sie das Modell der Unit auch in der
  -- SIM laedt (nicht nur im Renderer): Waffen-Tuerme, Bau-Knochen, Muendungen
  -- und Effekte haengen alle an Knochennamen. `Unit.lua:2751 ValidateBone` und
  -- `weapon.lua:67 SetupTurret` fragen genau danach — ohne Skelett kann keine
  -- Waffe aufgebaut werden.
  --
  -- Die Namen kommen aus der SCM-Datei (src/formats/scm.ts) und werden pro
  -- Blueprint gesetzt (__setBones).
  GetBoneCount = function(self)
    return table.getn(self.__bones or {})
  end,
  GetBoneName = function(self, i)
    return (self.__bones or {})[i + 1]
  end,
  IsValidBone = function(self, bone)
    if bone == nil then return false end
    local bones = self.__bones or {}
    if type(bone) == 'number' then
      return bone >= 0 and bone < table.getn(bones)
    end
    local want = string.lower(tostring(bone))
    for _, name in ipairs(bones) do
      if string.lower(name) == want then return true end
    end
    return false
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
}

local unit = withNoops(UNIT_NAMES, {
  GetUnitId = function(self)
    return (self.__bp and self.__bp.BlueprintId) or self.__id
  end,
  GetCurrentLayer = function(self) return self.__layer or 'Land' end,
  IsBeingBuilt = function(self) return self.__beingBuilt or false end,

  -- Der Sammelpunkt einer Fabrik. Ohne gesetzten Punkt ist es die Fabrik selbst
  -- — FactoryUnit.CalculateRollOffPoint (defaultunits.lua:578) sucht damit den
  -- naechstgelegenen RollOffPoint des Blueprints aus.
  -- Overcharge: die ACU haelt ihn an, solange er nicht geladen ist
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
  CanFire = function(self) return self.__enabled ~= false end,
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
  -- (Cfile:1125051/1125109). Das OPTIONALE recursive-Flag ist kein Beiwerk:
  -- uiutil.lua:993 (`ret:DisableHitTest(true)`) macht damit die Deko-Klammern
  -- eines Dialogs mausdurchlaessig. Wer es ignoriert, laesst die Klammern
  -- weiterhin treffen — und weil sie mit den Knoepfen auf DERSELBEN Tiefe liegen
  -- und in der Baumreihenfolge davor stehen, gewinnt bei `mDepth > best`
  -- (Cfile:1124509, echt groesser) die Klammer. Der Tutorial-Dialog war so nicht
  -- mehr zu beantworten.
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

  -- Tastatur-Fokus (Cfile:1125718/1125768/1125828). Hat ein Control den Fokus,
  -- bekommt NUR es die Tasten — und die Keymap schweigt (M3: IsKeyDown liefert
  -- dann false, Cfile:1141557). Genau deshalb loest ein Hotkey nicht aus,
  -- waehrend jemand im Chat tippt.
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
-- SetNewTexture fuellt BitmapWidth/BitmapHeight aus den Texturmassen
-- (Cfile:1118647) — darum bemisst sich ein Bitmap ohne Layout-Helfer nach
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
-- GetStringAdvance ist Pflicht: ohne Textbreite kann kein Layout rechnen
-- (Cfile:1146720). Die Breite kommt aus der Engine (Schriftmetrik).
-- ---------------------------------------------------------------------
local TEXT_NAMES = {
  'GetStringAdvance', 'GetText', 'SetCenteredHorizontally', 'SetCenteredVertically',
  'SetDropShadow', 'SetNewClipToWidth', 'SetNewColor', 'SetNewFont', 'SetText',
}

-- TextAdvance ist die Breite des gesetzten Textes (text.lua:47 macht daraus die
-- Breite des Controls). Sie haengt an Text UND Schrift — also nach jeder
-- Aenderung von beidem neu ziehen.
local function refreshTextAdvance(self)
  self.TextAdvance:Set(
    __mauiStringAdvance(self.__text or '', self.__fontFamily or '', self.__fontSize or 12)
  )
end

local text = withNoops(TEXT_NAMES, {
  SetText = function(self, str)
    -- tostring, weil die UI-Lua auch ZAHLEN durchreicht (economy.lua schreibt
    -- ihre Werte direkt in die Controls). Die Engine nimmt einen String entgegen;
    -- LuaPlus wandelt eine Zahl beim Uebergeben selbst um. Ohne diese Umwandlung
    -- bekommt die Schriftmetrik eine Zahl zu messen — und verschluckt sich.
    self.__text = str ~= nil and tostring(str) or ''
    refreshTextAdvance(self)
    __mauiDirty = true
  end,
  GetText = function(self) return self.__text or '' end,
  SetNewFont = function(self, family, pointSize)
    self.__fontFamily = family
    self.__fontSize = pointSize
    -- Die Engine fuellt FontAscent/FontDescent/FontExternalLeading aus der
    -- Schrift (Cfile:1145928-1145930); text.lua:39 macht daraus die Hoehe.
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
  -- "int GetTargetHead()" (Cfile:1136990) — der Bildschirm, auf dem dieser Frame
  -- liegt. Wir haben genau einen Head; __mauiCreateRootFrame haengt ihn als
  -- __head an. uiutil.lua:671 baut damit seine Dialog-Tiefe:
  --   GetFrame(parent:GetRootFrame():GetTargetHead()):GetTopmostDepth() + 1
  GetTargetHead = function(self) return self.__head or 0 end,
  SetTargetHead = function(self, head) self.__head = head end,

  -- "float GetTopmostDepth()" (Cfile:1136937) — die groesste Tiefe, die in
  -- diesem Frame vergeben ist. Ein Dialog legt sich damit UEBER alles, was schon
  -- da ist (uiutil.lua:671, +1). Ein fester Wert (hier stand 5000000) waere eine
  -- erfundene Zahl: zwei Dialoge saessen auf derselben Tiefe, und der zweite
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
-- Ein Border ist der 9-Slice-Rahmen der Original-UI (Dialoge, Panels): vier
-- Kanten + vier Ecken, die Mitte bleibt frei.
--
--   SetNewTextures(vertical, horizontal, upperLeft, upperRight, lowerLeft, lowerRight)
--   SetSolidColor(color)
--
-- (mHelp woertlich, Cfile:1123156.) Die Methode setzt dabei die beiden LazyVars,
-- die die Engine dem Control mitgibt: BorderWidth aus der BREITE der
-- vertical-Textur, BorderHeight aus der HOEHE der horizontal-Textur
-- (Cfile:1122728/1122748 — SetValue(mBorderWidthLV, width) bzw.
-- SetValue(mBorderHeightLV, height)). border.lua:11-13 sagt es selbst:
-- "SetTextures will set the BorderWidth and BorderHeight lazy vars."
--
-- Jedes Argument darf nil sein: border.lua:28 ruft die Methode SECHSMAL, jedes
-- Mal mit genau einer gesetzten Textur (eine LazyVar je Kachel, OnDirty).
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

    -- Die Masse kommen aus den TEXTUREN, nicht aus einer Zahl im Skript.
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

rawset(moho, 'entity_methods', Class() (entity))
rawset(moho, 'unit_methods', Class(moho.entity_methods) (unit))
rawset(moho, 'weapon_methods', Class(moho.entity_methods) (weapon))
rawset(moho, 'aibrain_methods', Class() (aibrain))
rawset(moho, 'cursor_methods', Class() (cursor))

-- maui (nur UI-VM). group_methods hat keine eigenen Bindungen — ein Group ist
-- ein CMauiControl mit der Klasse "group" (deshalb steht CMauiGroup auch nicht
-- in der Decomp-Liste). Die leere Klasse liefert das lazy-moho von selbst.
rawset(moho, 'control_methods', Class() (control))
rawset(moho, 'bitmap_methods', Class(moho.control_methods) (bitmap))
rawset(moho, 'text_methods', Class(moho.control_methods) (text))
rawset(moho, 'frame_methods', Class(moho.control_methods) (frame))
rawset(moho, 'border_methods', Class(moho.control_methods) (border))


-- CMauiLuaDragger: KEIN Control (kein Layout, kein Parent) — die Engine haelt
-- ihn separat und ruft OnMove/OnRelease/OnCancel (Cfile:1130393-1130413).
-- dragger.lua:15 raeumt ihn selbst weg: `OnRelease -> self:Destroy()`.
rawset(moho, 'dragger_methods', Class() ({
  Destroy = function(self)
    __mauiDraggerDestroy(self)
    self.__destroyed = true
  end,
}))
