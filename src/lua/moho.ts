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
  'GetFireState', 'GetFocusUnit', 'GetGuards', 'GetHealth', 'GetNumBuildOrders',
  'GetProductionPerSecondEnergy', 'GetProductionPerSecondMass', 'GetResourceConsumed',
  'GetScriptBit', 'GetTargetEntity', 'GetUnitId', 'GetWeapon', 'GetWeaponCount',
  'IsBeingBuilt', 'IsIdleState', 'IsPaused', 'IsStunned', 'IsUnitState', 'IsValidTarget',
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
  GetPosition: 'function(self) return {0, 0, 0} end',
  GetPositionXYZ: 'function(self) return 0, 0, 0 end',
  GetHeading: 'function(self) return 0 end',
  IsValidBone: 'function(self) return false end',
  GetUnitId: 'function(self) return (self.__bp and self.__bp.BlueprintId) or self.__id end',
  IsBeingBuilt: 'function(self) return self.__beingBuilt or false end',
  IsUnitState: 'function(self) return false end',
  IsIdleState: 'function(self) return true end',
  IsPaused: 'function(self) return false end',
  IsStunned: 'function(self) return false end',
  GetBuildRate: 'function(self) return (self.__bp and self.__bp.Economy and self.__bp.Economy.BuildRate) or 0 end',
  GetWeaponCount: 'function(self) return (self.__bp and self.__bp.Weapon and table.getn(self.__bp.Weapon)) or 0 end',
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
