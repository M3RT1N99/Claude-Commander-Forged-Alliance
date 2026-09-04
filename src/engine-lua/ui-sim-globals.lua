-- === Die Trennung der beiden VMs, von der UI-Seite her ====================
--
-- `globals.lua` ist die gemeinsame Datei fuer beide VMs, aber sie enthaelt
-- nicht nur Core-Bindungen: ein guter Teil davon ist `sim_SimInits` und gehoert
-- damit AUSSCHLIESSLICH in den Sim-VM. Der UI-Boot laedt die Datei trotzdem
-- ganz (uiEngine.ts ruft `installEngineGlobals`), und damit standen 51
-- Sim-Bindungen im UI-VM, die es dort im Original nie gab.
--
-- CLAUDE.md nennt das als Invariante: „Jede Engine-Bindung ist ueber `mPrevDef`
-- in genau einem State registriert … Deshalb kennt die Sim `_c_CreateCursor`
-- nicht und die UI kein `CreateUnit`. Niemals beide in einen VM booten."
--
-- Diese Liste ist NICHT von Hand gepflegt: sie ist die Globals-Liste des
-- Abschnitts „## Sim" aus `docs/research/engine-api.md` (generiert aus den
-- `mPrevDef`-Ketten des Decomps) ohne die vierzehn Namen, die dort UND im
-- UI-Abschnitt stehen — die sind in beiden Listen registriert und duerfen
-- bleiben. `scripts/check-vm-separation.ts` vergleicht die Laufzeit gegen genau
-- dieses Dokument und wird rot, sobald die Liste und die Wirklichkeit
-- auseinanderlaufen.
--
-- Ein Name, der gar nicht da ist, wird hier einfach nicht entfernt — die Liste
-- darf also vollstaendig sein, auch wenn `globals.lua` nur einen Teil davon
-- definiert.
local NUR_SIM = {
  'AddBuildRestriction', 'ArmyGetHandicap',
  'ArmyInitializePrebuiltUnits', 'ArmyIsCivilian', 'ArmyIsOutOfGame',
  'AttachBeamEntityToEntity', 'AttachBeamToEntity', 'ChangeUnitArmy',
  'CheatsEnabled', 'CreateAimController', 'CreateAnimator',
  'CreateAttachedBeam', 'CreateAttachedEmitter', 'CreateBeamEmitter',
  'CreateBeamEmitterOnEntity', 'CreateBeamEntityToEntity',
  'CreateBeamToEntityBone', 'CreateBuilderArmController',
  'CreateCollisionDetector', 'CreateDecal', 'CreateEconomyEvent',
  'CreateEmitterAtBone', 'CreateEmitterAtEntity',
  'CreateEmitterOnEntity', 'CreateFootPlantController',
  'CreateInitialArmyUnit', 'CreateLightParticle',
  'CreateLightParticleIntel', 'CreateProp', 'CreatePropHPR',
  'CreateResourceDeposit', 'CreateRotator', 'CreateSlaver',
  'CreateSlider', 'CreateSplat', 'CreateSplatOnBone',
  'CreateStorageManip', 'CreateThrustController', 'CreateTrail',
  'CreateUnit', 'CreateUnit2', 'CreateUnitHPR', 'Damage', 'DamageArea',
  'DamageRing', 'DebugGetSelection', 'DrawCircle', 'DrawLine',
  'DrawLinePop', 'EconomyEventIsDone', 'EndGame', 'EntityCategoryCount',
  'EntityCategoryCountAroundPosition', 'FlattenMapRect',
  'FlushIntelInRect', 'GenerateArmyStart', 'GenerateRandomOrientation',
  'GetArmyBrain', 'GetArmyUnitCap', 'GetArmyUnitCostTotal',
  'GetCurrentCommandSource', 'GetEntitiesInRect', 'GetEntityById',
  'GetGameTick', 'GetMapSize', 'GetReclaimablesInRect',
  'GetSurfaceHeight', 'GetSystemTimeSecondsOnlyForProfileUse',
  'GetTerrainHeight', 'GetTerrainType', 'GetTerrainTypeOffset',
  'GetUnitBlueprintByName', 'GetUnitsInRect', 'InitializeArmyAI',
  'IsBlip', 'IsCollisionBeam', 'IsEntity', 'IsGameOver', 'IsProjectile',
  'IsProp', 'IsUnit', 'LUnitMove', 'LUnitMoveNear', 'ListArmies',
  'MetaImpact', 'NotifyUpgrade', 'OkayToMessWithArmy', 'PlayLoop',
  'RemoveBuildRestriction', 'RemoveEconomyEvent', 'SelectedUnit',
  'SetAlliance', 'SetAllianceOneWay', 'SetAlliedVictory',
  'SetArmyAIPersonality', 'SetArmyColor', 'SetArmyColorIndex',
  'SetArmyEconomy', 'SetArmyFactionIndex', 'SetArmyOutOfGame',
  'SetArmyPlans', 'SetArmyShowScore', 'SetArmyStart',
  'SetArmyStatsSyncArmy', 'SetArmyUnitCap', 'SetIgnoreArmyUnitCap',
  'SetIgnorePlayableRect', 'SetPlayableRect', 'SetTerrainType',
  'SetTerrainTypeRect', 'ShouldCreateInitialArmyUnits', 'SimConExecute',
  'SplitProp', 'StopLoop', 'SubmitXMLArmyStats', 'TryCopyPose', 'Warp',
  '_c_CreateEntity', '_c_CreateShield',
  -- The whole Issue* family plus IsCommandDone and CoordinateAttacks were
  -- missing from engine-api.md until 2026-09-04: the generator matched the
  -- three luadef assignments in one fixed order, and these bindings have
  -- mMethodName before mPrevDef (Cfile:1008266-1008270). They are
  -- sim_SimInits like the rest.
  'CoordinateAttacks',
  'IsCommandDone', 'IssueAggressiveMove', 'IssueAttack', 'IssueBuildFactory',
  'IssueBuildMobile', 'IssueCapture', 'IssueClearCommands',
  'IssueClearFactoryCommands', 'IssueDestroySelf', 'IssueDive',
  'IssueFactoryAssist', 'IssueFactoryRallyPoint', 'IssueFerry',
  'IssueFormAggressiveMove', 'IssueFormAttack', 'IssueFormMove',
  'IssueFormPatrol', 'IssueGuard', 'IssueKillSelf', 'IssueMove',
  'IssueMoveOffFactory', 'IssueNuke', 'IssueOverCharge', 'IssuePatrol',
  'IssuePause', 'IssueReclaim', 'IssueRepair', 'IssueSacrifice', 'IssueScript',
  'IssueSiloBuildNuke', 'IssueSiloBuildTactical', 'IssueStop', 'IssueTactical',
  'IssueTeleport', 'IssueTeleportToBeacon', 'IssueTransportLoad',
  'IssueTransportUnload', 'IssueTransportUnloadSpecific', 'IssueUpgrade',
  -- Sim-side helpers of the factory command list (globals.lua): no engine
  -- bindings, but Sim state that reads __units -- the UI VM has none of it.
  '__factoryCommands', '__factoryCommandSerial', '__isFactoryBuilder',
  '__factoryCommandPos', '__issueFactoryCommand', '__clearFactoryCommands',
  '__issueInitialRally', '__factoryCommandTick', '__inheritFactoryCommands',
  '__dispatchFactoryMove', '__dispatchFactoryPatrol', '__dispatchFactoryAttack',
  '__dispatchFactoryAttackGround', '__dispatchFactoryGuard'}

for _, name in ipairs(NUR_SIM) do
  rawset(_G, name, nil)
end
