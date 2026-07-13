import type { LuaHost } from './host'

/**
 * moho-Engine-API v1 (Gleis B, Phase A).
 *
 * Die Original-Lua-Klassen leiten von `moho.unit_methods` /
 * `moho.entity_methods` ab (die C++-Basisklassen). Das Klassensystem
 * (`class.lua`) KOPIERT Basisfelder in die abgeleitete Klasse, daher müssen
 * die Engine-Methoden echte Felder auf den moho-Basisklassen sein — ein
 * Metatable-Fallback würde nicht kopiert.
 *
 * Methodennamen: vollständig aus den faf-re-Lua-Bindungen (`cfunc_Unit*`,
 * `cfunc_Entity*`) — 105 Unit- + 72 Entity-Methoden. Die meisten sind
 * zunächst No-Op-Stubs; die für den Lifecycle kritischen Accessor liefern
 * echte Werte aus dem Instanz-Zustand/Blueprint. Nach und nach werden diese
 * Stubs durch echte TS-Implementierungen ersetzt (Sim-Anbindung).
 */

const ENTITY_METHODS = [
  'AddLocalImpulse', 'AddManualScroller', 'AddPingPongScroller', 'AddShooter',
  'AddThreadScroller', 'AddWorldImpulse', 'AdjustHealth', 'AttachBoneTo', 'AttachTo',
  'BeenDestroyed', 'CategoryContainsSim', 'CategoryContainsUser', 'CategoryCount',
  'CategoryCountAroundPosition', 'CategoryEmpty', 'CategoryFilterDownSim',
  'CategoryFilterDownUser', 'CategoryFilterOut', 'Category__add', 'Category__mul',
  'Category__sub', 'CreateProjectile', 'CreateProjectileAtBone', 'CreatePropAtBone',
  'Destroy', 'DetachAll', 'DetachFrom', 'DisableIntel', 'EnableIntel', 'GetAIBrain',
  'GetArmy', 'GetBlueprint', 'GetBoneCount', 'GetBoneDirection', 'GetBoneName',
  'GetCollisionExtents', 'GetEntityId', 'GetFractionComplete', 'GetHeading', 'GetHealth',
  'GetIntelRadius', 'GetMaxHealth', 'GetOrientation', 'GetParent', 'GetPosition',
  'GetPositionXYZ', 'GetScale', 'InitIntel', 'IsIntelEnabled', 'IsValidBone', 'Kill',
  'PlaySound', 'ReachedMaxShooters', 'RemoveScroller', 'RemoveShooter', 'RequestRefreshUI',
  'SetAmbientSound', 'SetCollisionShape', 'SetDrawScale', 'SetHealth', 'SetIntelRadius',
  'SetMaxHealth', 'SetMesh', 'SetOrientation', 'SetParentOffset', 'SetPosition', 'SetScale',
  'SetVizToAllies', 'SetVizToEnemies', 'SetVizToFocusPlayer', 'SetVizToNeutrals', 'ShakeCamera',
]

const UNIT_METHODS = [
  'AddBuildRestriction', 'AddCommandCap', 'AddToggleCap', 'AlterArmor',
  'CalculateWorldPositionFromRelative', 'ClearFocusEntity', 'GetArmorMult', 'GetAttacker',
  'GetBuildRate', 'GetConsumptionPerSecondEnergy', 'GetConsumptionPerSecondMass',
  'GetFireState', 'GetFocusUnit', 'GetGuards', 'GetHealth', 'GetNavigator', 'GetNumBuildOrders',
  'GetProductionPerSecondEnergy', 'GetProductionPerSecondMass', 'GetResourceConsumed',
  'GetScriptBit', 'GetTargetEntity', 'GetUnitId', 'GetVelocity', 'GetWeapon', 'GetWeaponCount',
  'IsBeingBuilt', 'IsIdleState', 'IsMoving', 'IsPaused', 'IsStunned', 'IsUnitState', 'IsValidTarget',
  'KillManipulator', 'KillManipulators', 'RemoveBuildRestriction', 'RemoveCommandCap',
  'RemoveToggleCap', 'RestoreBuildRestrictions', 'RestoreCommandCaps', 'RestoreToggleCaps',
  'RevertElevation', 'RevertRegenRate', 'ScaleGetBuiltEmitter', 'SetAccMult', 'SetAutoMode',
  'SetBlockCommandQueue', 'SetBreakOffDistanceMult', 'SetBreakOffTriggerMult', 'SetBuildRate',
  'SetBusy', 'SetConsumptionActive', 'SetConsumptionPerSecondEnergy',
  'SetConsumptionPerSecondMass', 'SetCreator', 'SetCustomName', 'SetDoNotTarget',
  'SetElevation', 'SetFireState', 'SetFocusEntity', 'SetImmobile', 'SetIsValidTarget',
  'SetPaused', 'SetProductionActive', 'SetProductionPerSecondEnergy',
  'SetProductionPerSecondMass', 'SetRegenRate', 'SetScriptBit', 'SetShieldRatio',
  'SetSpeedMult', 'SetStrategicUnderlay', 'SetStunned', 'SetTurnMult', 'SetUnSelectable',
  'SetUnitState', 'SetWorkProgress', 'StopSiloBuild', 'TestCommandCaps', 'TestToggleCaps',
  'ToggleFireState', 'ToggleScriptBit', 'WeaponBeenDestroyed', 'WeaponCanFire',
  'WeaponChangeDamage', 'WeaponChangeDamageRadius', 'WeaponChangeDamageType',
  'WeaponChangeFiringTolerance', 'WeaponChangeMaxHeightDiff', 'WeaponChangeMaxRadius',
  'WeaponChangeMinRadius', 'WeaponChangeProjectileBlueprint', 'WeaponChangeRateOfFire',
  'WeaponCreateProjectile', 'WeaponGetBlueprint', 'WeaponGetCurrentTarget',
  'WeaponGetCurrentTargetPos', 'WeaponGetFireClockPct', 'WeaponGetFiringRandomness',
  'WeaponGetProjectileBlueprint', 'WeaponHasTarget', 'WeaponIsFireControl', 'WeaponPlaySound',
  'WeaponSetEnabled', 'WeaponSetFireControl', 'WeaponSetFireTargetLayerCaps',
  'WeaponSetFiringRandomness', 'WeaponSetTargetingPriorities', 'WeaponTransferTarget',
]

/**
 * Kritische Accessor mit echten Rückgaben (Lua-Rümpfe). Alles andere ist ein
 * No-Op-Stub. Der Instanz-Zustand liegt in Feldern `self.__…`.
 */
const OVERRIDES: Record<string, string> = {
  GetBlueprint: 'function(self) return self.__bp end',
  GetEntityId: 'function(self) return self.__id end',
  GetArmy: 'function(self) return self.__army or 1 end',
  GetAIBrain: 'function(self) return self.__brain end',
  GetBoneCount: 'function(self) return 0 end',
  GetHealth: 'function(self) return self.__health or 0 end',
  GetMaxHealth: 'function(self) return (self.__bp and self.__bp.Defense and self.__bp.Defense.MaxHealth) or 0 end',
  GetFractionComplete: 'function(self) return self.__fraction or 1 end',
  // Zustand in Instanz-Feldern (self.__pos {x,y,z}, self.__orient, self.__health,
  // self.__meshBp). TS liest/schreibt diese Felder für Renderer und Sim.
  GetPosition: 'function(self) return self.__pos or {0, 0, 0} end',
  GetPositionXYZ:
    'function(self) local p = self.__pos or {0,0,0}; return p[1], p[2], p[3] end',
  SetPosition: 'function(self, pos) self.__pos = pos end',
  GetOrientation: 'function(self) return self.__orient or {0, 0, 0, 1} end',
  SetOrientation: 'function(self, o) self.__orient = o end',
  GetHeading: 'function(self) return self.__heading or 0 end',
  SetHealth:
    'function(self, inst, h) self.__health = math.max(0, math.min(h, self:GetMaxHealth())) end',
  AdjustHealth:
    'function(self, inst, delta) self.__health = math.max(0, math.min((self.__health or 0) + delta, self:GetMaxHealth())) end',
  SetMesh: 'function(self, mesh) self.__meshBp = mesh end',
  IsValidBone: 'function(self) return false end',
  GetUnitId: 'function(self) return (self.__bp and self.__bp.BlueprintId) or self.__id end',
  IsBeingBuilt: 'function(self) return self.__beingBuilt or false end',
  IsUnitState: 'function(self) return false end',
  IsIdleState: 'function(self) return true end',
  IsPaused: 'function(self) return false end',
  IsStunned: 'function(self) return false end',
  GetBuildRate: 'function(self) return (self.__bp and self.__bp.Economy and self.__bp.Economy.BuildRate) or 0 end',
  GetWeaponCount: 'function(self) return (self.__bp and self.__bp.Weapon and table.getn(self.__bp.Weapon)) or 0 end',
  // Ökonomie: Werte aus dem Blueprint, Aktiv-Zustand an die Engine-Ökonomie
  // (installEconomy stellt __econSetActive; ohne sie harmloser No-Op).
  GetProductionPerSecondEnergy:
    'function(self) return (self.__bp and self.__bp.Economy and self.__bp.Economy.ProductionPerSecondEnergy) or 0 end',
  GetProductionPerSecondMass:
    'function(self) return (self.__bp and self.__bp.Economy and self.__bp.Economy.ProductionPerSecondMass) or 0 end',
  GetConsumptionPerSecondEnergy:
    'function(self) return (self.__bp and self.__bp.Economy and self.__bp.Economy.MaintenanceConsumptionPerSecondEnergy) or 0 end',
  GetConsumptionPerSecondMass:
    'function(self) return (self.__bp and self.__bp.Economy and self.__bp.Economy.MaintenanceConsumptionPerSecondMass) or 0 end',
  SetProductionActive:
    'function(self, a) __econSetProductionActive(self.__army or 1, self.__id, a) end',
  SetConsumptionActive:
    'function(self, a) __econSetConsumptionActive(self.__army or 1, self.__id, a) end',
  GetResourceConsumed: 'function(self) return self.__resourceConsumed or 1 end',
  // Bewegung: Navigator (installMotion) + Zustand aus der Physik-Fortschreibung.
  GetNavigator: 'function(self) return self.__navigator end',
  IsMoving: 'function(self) if self.__goal then return true else return false end end',
  GetVelocity: 'function(self) local s = self.__speed or 0; local h = self.__heading or 0; return math.sin(h)*s, 0, math.cos(h)*s end',
}

function methodSpec(names: string[]): string {
  const entries = names.map((n) => `  ["${n}"] = ${OVERRIDES[n] ?? 'function() end'},`)
  return `{\n${entries.join('\n')}\n}`
}

/**
 * Installiert die `moho`-API im VM: entity_methods + unit_methods (mit
 * Vererbung wie in der Engine), restliche `moho.*` als lazy leere Klassen.
 */
export function installMoho(host: LuaHost): void {
  host.eval(`
    moho = setmetatable({}, {
      __index = function(t, k)
        local c = Class() {}
        rawset(t, k, c)
        return c
      end,
    })
    rawset(moho, 'entity_methods', Class() ${methodSpec(ENTITY_METHODS)})
    rawset(moho, 'unit_methods', Class(moho.entity_methods) ${methodSpec(UNIT_METHODS)})
  `)
}

export const MOHO_METHOD_COUNT = { entity: ENTITY_METHODS.length, unit: UNIT_METHODS.length }
