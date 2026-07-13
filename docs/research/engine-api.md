# Engine-Lua-API — welche Bindung in welche VM geht

**Generiert von [scripts/dump-engine-api.ts](../../scripts/dump-engine-api.ts) aus der
IDA-Decompilation. Nicht von Hand pflegen.**

Jede Lua-Bindung der Engine ist ein `Moho::CScrLuaInitForm luadef_*`. Das Feld
`mPrevDef` verrät, in welche Lua-VM sie registriert wird — und damit, dass die
Engine **zwei getrennte Lua-States** hat:

| Init-Liste | Ziel-VM |
|---|---|
| `scr_CoreInits` | beide (Sim **und** UI) |
| `scr_UserInits` | nur die **UI**-VM |
| `sim_SimInits` | nur die **Sim**-VM |

Darum kennt die Sim kein `_c_CreateCursor` und die UI kein `CreateUnit`. Wer
beides in eine VM wirft, baut etwas, das es im Original nie gab.

## Core — in beiden VMs

Vektor-Mathematik, Kategorien, Threads, Blueprint-Registrierung, Dateizugriff.

**70 Bindungen** — 65 Globals, 2 Klassen.

### Globals (65)

`AITarget`, `Basename`, `BeginLoggingStats`, `BlueprintLoaderUpdateProgress`, `CreatePrefetchSet`, `CurrentThread`, `Dirname`, `DiskFindFiles`, `DiskGetFileInfo`, `DiskToLocal`, `EndLoggingStats`, `EntityCategoryEmpty`, `EntityCategoryGetUnitList`, `EnumColorNames`, `EulerToQuaternion`, `FileCollapsePath`, `ForkThread`, `GetCueBank`, `GetMovieDuration`, `GetVersion`, `IsDestroyed`, `KillThread`, `LOG`, `MATH_IRound`, `MATH_Lerp`, `MinLerp`, `MinSlerp`, `OrientFromDir`, `PointVector`, `RPCSound`, `Rect`, `RegisterBeamBlueprint`, `RegisterEmitterBlueprint`, `RegisterMeshBlueprint`, `RegisterProjectileBlueprint`, `RegisterPropBlueprint`, `RegisterTrailEmitterBlueprint`, `RegisterUnitBlueprint`, `ResumeThread`, `SPEW`, `STR_GetTokens`, `STR_Utf8Len`, `STR_Utf8SubString`, `STR_itox`, `STR_xtoi`, `SecondsPerTick`, `Sound`, `SpecFootprints`, `SuspendCurrentThread`, `Trace`, `VAdd`, `VDiff`, `VDist2`, `VDist2Sq`, `VDist3`, `VDist3Sq`, `VDot`, `VMult`, `VPerpDot`, `Vector`, `Vector2`, `WARN`, `WaitFor`, `doscript`, `exists`

### Klassen (2)

**CPrefetchSet** (2): `Reset`, `Update`

**EntityCategory** (3): `__add`, `__mul`, `__sub`


## User — nur die UI-VM

maui-Controls, Kommandos, Selektion, Kamera, Session, Preferences.

**453 Bindungen** — 200 Globals, 23 Klassen.

### Globals (200)

`AddBlinkyBox`, `AddCommandFeedbackBlip`, `AddConsoleOutputReciever`, `AddInputCapture`, `AddSelectUnits`, `AddToSessionExtraSelectList`, `AnyInputCapture`, `AudioSetLanguage`, `ClearBuildTemplates`, `ClearCurrentFactoryForQueueDisplay`, `ClearFrame`, `ClearSessionExtraSelectList`, `ConExecute`, `ConExecuteSave`, `ConTextMatches`, `CopyCurrentReplay`, `CurrentTime`, `DebugFacilitiesEnabled`, `DecreaseBuildCountInQueue`, `DeleteCommand`, `EjectSessionClient`, `EngineStartFrontEndUI`, `EngineStartSplashScreens`, `EntityCategoryContains`, `EntityCategoryFilterDown`, `EntityCategoryFilterOut`, `ExecLuaInSim`, `ExitApplication`, `ExitGame`, `FlushEvents`, `FormatTime`, `GameTick`, `GameTime`, `GenerateBuildTemplateFromSelection`, `GetActiveBuildTemplate`, `GetAntiAliasingOptions`, `GetArmiesTable`, `GetArmyAvatars`, `GetArmyScore`, `GetAssistingUnitsList`, `GetAttachedUnitsList`, `GetBlueprint`, `GetCamera`, `GetCommandLineArg`, `GetCurrentUIState`, `GetCursor`, `GetEconomyTotals`, `GetFireState`, `GetFocusArmy`, `GetFrame`, `GetFrontEndData`, `GetGameSpeed`, `GetGameTime`, `GetGameTimeSeconds`, `GetIdleEngineers`, `GetIdleFactories`, `GetInputCapture`, `GetIsAutoMode`, `GetIsAutoSurfaceMode`, `GetIsPaused`, `GetIsSubmerged`, `GetMouseScreenPos`, `GetMouseWorldPos`, `GetMovieVolume`, `GetNumRootFrames`, `GetOptions`, `GetPreference`, `GetResourceSharing`, `GetRolloverInfo`, `GetScriptBit`, `GetSelectedUnits`, `GetSessionClients`, `GetSimRate`, `GetSimTicksPerSecond`, `GetSpecialFileInfo`, `GetSpecialFilePath`, `GetSpecialFiles`, `GetSpecialFolder`, `GetSystemTime`, `GetSystemTimeSeconds`, `GetTextureDimensions`, `GetUIControlsAlpha`, `GetUnitById`, `GetUnitCommandData`, `GetUnitCommandFromCommandCap`, `GetValidAttackingUnits`, `GetVolume`, `GpgNetActive`, `GpgNetSend`, `HasCommandLineArg`, `HasLocalizedVO`, `IN_AddKeyMapTable`, `IN_ClearKeyMap`, `IN_RemoveKeyMapTable`, `IncreaseBuildCountInQueue`, `InternalCreateBitmap`, `InternalCreateBorder`, `InternalCreateDiscoveryService`, `InternalCreateDragger`, `InternalCreateEdit`, `InternalCreateFrame`, `InternalCreateGroup`, `InternalCreateHistogram`, `InternalCreateItemList`, `InternalCreateLobby`, `InternalCreateMapPreview`, `InternalCreateMesh`, `InternalCreateMovie`, `InternalCreateScrollbar`, `InternalCreateText`, `InternalCreateWldUIProvider`, `InternalCreateWorldMesh`, `InternalSaveGame`, `IsAlly`, `IsEnemy`, `IsKeyDown`, `IsNeutral`, `IsObserver`, `IssueBlueprintCommand`, `IssueCommand`, `IssueDockCommand`, `IssueUnitCommand`, `KeycodeMSWToMaui`, `KeycodeMauiToMSW`, `LaunchGPGNet`, `LaunchSinglePlayerSession`, `LoadSavedGame`, `MapBorderAdd`, `MapBorderClear`, `OpenURL`, `ParseEntityCategory`, `PauseSound`, `PauseVoice`, `PlaySound`, `PlayTutorialVO`, `PlayVoice`, `PostDragger`, `PrefetchSession`, `Random`, `RemoveConsoleOutputReciever`, `RemoveFromSessionExtraSelectList`, `RemoveInputCapture`, `RemoveProfileDirectories`, `RemoveSpecialFile`, `RenderOverlayEconomy`, `RenderOverlayIntel`, `RenderOverlayMilitary`, `RestartSession`, `SavePreferences`, `SelectUnits`, `SessionCanRestart`, `SessionEndGame`, `SessionGetCommandSourceNames`, `SessionGetLocalCommandSource`, `SessionGetScenarioInfo`, `SessionIsActive`, `SessionIsBeingRecorded`, `SessionIsGameOver`, `SessionIsMultiplayer`, `SessionIsObservingAllowed`, `SessionIsPaused`, `SessionIsReplay`, `SessionRequestPause`, `SessionResume`, `SessionSendChatMessage`, `SetActiveBuildTemplate`, `SetAutoMode`, `SetAutoSurfaceMode`, `SetCursor`, `SetFireState`, `SetFocusArmy`, `SetFrontEndData`, `SetGameSpeed`, `SetMovieVolume`, `SetOverlayFilter`, `SetOverlayFilters`, `SetPaused`, `SetPreference`, `SetUIControlsAlpha`, `SetVolume`, `SimCallback`, `SoundIsPrepared`, `StartSound`, `StopSound`, `SyncPlayableRect`, `TeamColorMode`, `ToggleFireState`, `ToggleScriptBit`, `UISelectAndZoomTo`, `UISelectionByCategory`, `UIZoomTo`, `UnProject`, `ValidateIPAddress`, `ValidateUnitsList`, `WorldIsLoading`, `WorldIsPlaying`, `_c_CreateCursor`, `_c_CreateDecal`, `_c_CreatePathDebugger`, `print`

### Klassen (23)

**CDiscoveryService** (3): `Destroy`, `GetGameCount`, `Reset`

**CLobby** (18): `BroadcastData`, `ConnectToPeer`, `DebugDump`, `Destroy`, `DisconnectFromPeer`, `EjectPeer`, `GetLocalPlayerID`, `GetLocalPlayerName`, `GetLocalPort`, `GetPeer`, `GetPeers`, `HostGame`, `IsHost`, `JoinGame`, `LaunchGame`, `MakeValidGameName`, `MakeValidPlayerName`, `SendData`

**CLuaWldUIProvider** (1): `Destroy`

**CMauiBitmap** (18): `GetFrame`, `GetNumFrames`, `InternalSetSolidColor`, `Loop`, `Play`, `SetBackwardPattern`, `SetForwardPattern`, `SetFrame`, `SetFramePattern`, `SetFrameRate`, `SetLoopPingPongPattern`, `SetNewTexture`, `SetPingPongPattern`, `SetTiled`, `SetUV`, `ShareTextures`, `Stop`, `UseAlphaHitTest`

**CMauiBorder** (2): `SetNewTextures`, `SetSolidColor`

**CMauiControl** (25): `AbandonKeyboardFocus`, `AcquireKeyboardFocus`, `ApplyFunction`, `ClearChildren`, `Destroy`, `DisableHitTest`, `EnableHitTest`, `GetAlpha`, `GetCurrentFocusControl`, `GetName`, `GetParent`, `GetRenderPass`, `GetRootFrame`, `Hide`, `HitTest`, `IsHidden`, `IsHitTestDisabled`, `NeedsFrameUpdate`, `SetAlpha`, `SetHidden`, `SetName`, `SetNeedsFrameUpdate`, `SetParent`, `SetRenderPass`, `Show`

**CMauiCursor** (5): `Hide`, `ResetToDefault`, `SetDefaultTexture`, `SetNewTexture`, `Show`

**CMauiEdit** (31): `AbandonFocus`, `AcquireFocus`, `ClearText`, `DisableInput`, `EnableInput`, `GetBackgroundColor`, `GetCaretColor`, `GetCaretPosition`, `GetFontHeight`, `GetForegroundColor`, `GetHighlightBackgroundColor`, `GetHighlightForegroundColor`, `GetMaxChars`, `GetStringAdvance`, `GetText`, `IsBackgroundVisible`, `IsCaretVisible`, `IsEnabled`, `SetCaretCycle`, `SetCaretPosition`, `SetDropShadow`, `SetMaxChars`, `SetNewBackgroundColor`, `SetNewCaretColor`, `SetNewFont`, `SetNewForegroundColor`, `SetNewHighlightBackgroundColor`, `SetNewHighlightForegroundColor`, `SetText`, `ShowBackground`, `ShowCaret`

**CMauiFrame** (3): `GetTargetHead`, `GetTopmostDepth`, `SetTargetHead`

**CMauiHistogram** (3): `SetData`, `SetXIncrement`, `SetYIncrement`

**CMauiItemList** (19): `AddItem`, `DeleteAllItems`, `DeleteItem`, `Empty`, `GetItem`, `GetItemCount`, `GetRowHeight`, `GetSelection`, `GetStringAdvance`, `ModifyItem`, `NeedsScrollBar`, `ScrollToBottom`, `ScrollToTop`, `SetNewColors`, `SetNewFont`, `SetSelection`, `ShowItem`, `ShowMouseoverItem`, `ShowSelection`

**CMauiLuaDragger** (1): `Destroy`

**CMauiMesh** (2): `SetMesh`, `SetOrientation`

**CMauiMovie** (7): `GetFrameRate`, `GetNumFrames`, `InternalSet`, `IsLoaded`, `Loop`, `Play`, `Stop`

**CMauiScrollbar** (4): `DoScrollLines`, `DoScrollPages`, `SetNewTextures`, `SetScrollable`

**CMauiText** (9): `GetStringAdvance`, `GetText`, `SetCenteredHorizontally`, `SetCenteredVertically`, `SetDropShadow`, `SetNewClipToWidth`, `SetNewColor`, `SetNewFont`, `SetText`

**CPathDebugger** (1): `Destroy`

**CUIMapPreview** (3): `ClearTexture`, `SetTexture`, `SetTextureFromMap`

**CUIWorldMesh** (16): `Destroy`, `GetInterpolatedAlignedBox`, `GetInterpolatedOrientedBox`, `GetInterpolatedPosition`, `GetInterpolatedScroll`, `GetInterpolatedSphere`, `IsHidden`, `SetAuxiliaryParameter`, `SetColor`, `SetFractionCompleteParameter`, `SetFractionHealthParameter`, `SetHidden`, `SetLifetimeParameter`, `SetMesh`, `SetScale`, `SetStance`

**CUIWorldView** (17): `CameraReset`, `EnableResourceRendering`, `GetRightMouseButtonOrder`, `GetScreenPos`, `GetsGlobalCameraCommands`, `HasHighlightCommand`, `IsCartographic`, `IsInputLocked`, `IsResourceRenderingEnabled`, `LockInput`, `Project`, `SetCartographic`, `SetHighlightEnabled`, `ShowConvertToPatrolCursor`, `UnlockInput`, `ZoomScale`, `__init`

**CameraImpl** (25): `DisableEaseInOut`, `EnableEaseInOut`, `GetFocusPosition`, `GetMaxZoom`, `GetMinZoom`, `GetTargetZoom`, `GetZoom`, `HoldRotation`, `MoveTo`, `MoveToRegion`, `NoseCam`, `Reset`, `RestoreSettings`, `RevertRotation`, `SaveSettings`, `SetAccMode`, `SetMaxZoomMult`, `SetTargetZoom`, `SetZoom`, `SnapTo`, `Spin`, `TargetEntities`, `TrackEntities`, `UseGameClock`, `UseSystemClock`

**ScriptedDecal** (5): `Destroy`, `SetPosition`, `SetPositionByScreen`, `SetScale`, `SetTexture`

**UserUnit** (35): `AddSelectionSet`, `CanAttackTarget`, `GetArmy`, `GetBlueprint`, `GetBuildRate`, `GetCommandQueue`, `GetCreator`, `GetCustomName`, `GetEconData`, `GetEntityId`, `GetFocus`, `GetFootPrintSize`, `GetFuelRatio`, `GetHealth`, `GetMaxHealth`, `GetMissileInfo`, `GetPosition`, `GetSelectionSets`, `GetShieldRatio`, `GetStat`, `GetUnitId`, `GetWorkProgress`, `HasSelectionSet`, `HasUnloadCommandQueuedUp`, `IsAutoMode`, `IsAutoSurfaceMode`, `IsDead`, `IsIdle`, `IsInCategory`, `IsOverchargePaused`, `IsRepeatQueue`, `IsStunned`, `ProcessInfo`, `RemoveSelectionSet`, `SetCustomName`


## Sim — nur die Sim-VM

Units, Waffen, Brains, Platoons, Effekte, Ökonomie.

**626 Bindungen** — 133 Globals, 27 Klassen.

### Globals (133)

`AddBuildRestriction`, `ArmyGetHandicap`, `ArmyInitializePrebuiltUnits`, `ArmyIsCivilian`, `ArmyIsOutOfGame`, `AttachBeamEntityToEntity`, `AttachBeamToEntity`, `AudioSetLanguage`, `ChangeUnitArmy`, `CheatsEnabled`, `CreateAimController`, `CreateAnimator`, `CreateAttachedBeam`, `CreateAttachedEmitter`, `CreateBeamEmitter`, `CreateBeamEmitterOnEntity`, `CreateBeamEntityToEntity`, `CreateBeamToEntityBone`, `CreateBuilderArmController`, `CreateCollisionDetector`, `CreateDecal`, `CreateEconomyEvent`, `CreateEmitterAtBone`, `CreateEmitterAtEntity`, `CreateEmitterOnEntity`, `CreateFootPlantController`, `CreateInitialArmyUnit`, `CreateLightParticle`, `CreateLightParticleIntel`, `CreateProp`, `CreatePropHPR`, `CreateResourceDeposit`, `CreateRotator`, `CreateSlaver`, `CreateSlider`, `CreateSplat`, `CreateSplatOnBone`, `CreateStorageManip`, `CreateThrustController`, `CreateTrail`, `CreateUnit`, `CreateUnit2`, `CreateUnitHPR`, `Damage`, `DamageArea`, `DamageRing`, `DebugGetSelection`, `DrawCircle`, `DrawLine`, `DrawLinePop`, `EconomyEventIsDone`, `EndGame`, `EntityCategoryContains`, `EntityCategoryCount`, `EntityCategoryCountAroundPosition`, `EntityCategoryFilterDown`, `FlattenMapRect`, `FlushIntelInRect`, `GenerateArmyStart`, `GenerateRandomOrientation`, `GetArmyBrain`, `GetArmyUnitCap`, `GetArmyUnitCostTotal`, `GetBlueprint`, `GetCurrentCommandSource`, `GetEntitiesInRect`, `GetEntityById`, `GetFocusArmy`, `GetGameTick`, `GetGameTimeSeconds`, `GetMapSize`, `GetReclaimablesInRect`, `GetSurfaceHeight`, `GetSystemTimeSecondsOnlyForProfileUse`, `GetTerrainHeight`, `GetTerrainType`, `GetTerrainTypeOffset`, `GetUnitBlueprintByName`, `GetUnitById`, `GetUnitsInRect`, `HasLocalizedVO`, `InitializeArmyAI`, `IsAlly`, `IsBlip`, `IsCollisionBeam`, `IsEnemy`, `IsEntity`, `IsGameOver`, `IsNeutral`, `IsProjectile`, `IsProp`, `IsUnit`, `LUnitMove`, `LUnitMoveNear`, `ListArmies`, `MetaImpact`, `NotifyUpgrade`, `OkayToMessWithArmy`, `ParseEntityCategory`, `PlayLoop`, `Random`, `RemoveBuildRestriction`, `RemoveEconomyEvent`, `SelectedUnit`, `SetAlliance`, `SetAllianceOneWay`, `SetAlliedVictory`, `SetArmyAIPersonality`, `SetArmyColor`, `SetArmyColorIndex`, `SetArmyEconomy`, `SetArmyFactionIndex`, `SetArmyOutOfGame`, `SetArmyPlans`, `SetArmyShowScore`, `SetArmyStart`, `SetArmyStatsSyncArmy`, `SetArmyUnitCap`, `SetIgnoreArmyUnitCap`, `SetIgnorePlayableRect`, `SetPlayableRect`, `SetTerrainType`, `SetTerrainTypeRect`, `ShouldCreateInitialArmyUnits`, `SimConExecute`, `SplitProp`, `StopLoop`, `SubmitXMLArmyStats`, `TryCopyPose`, `Warp`, `_c_CreateEntity`, `_c_CreateShield`, `print`

### Klassen (27)

**CAiAttackerImpl** (17): `AttackerWeaponsBusy`, `CanAttackTarget`, `FindBestEnemy`, `ForceEngage`, `GetDesiredTarget`, `GetMaxWeaponRange`, `GetPrimaryWeapon`, `GetTargetWeapon`, `GetUnit`, `GetWeaponCount`, `HasSlavedTarget`, `IsTargetExempt`, `IsTooClose`, `IsWithinAttackRange`, `ResetReportingState`, `SetDesiredTarget`, `Stop`

**CAiBrain** (64): `AddArmyStat`, `AssignThreatAtPosition`, `AssignUnitsToPlatoon`, `BuildPlatoon`, `BuildStructure`, `BuildUnit`, `CanBuildPlatoon`, `CanBuildStructureAt`, `CheckBlockingTerrain`, `CreateResourceBuildingNearest`, `CreateUnitNearSpot`, `DecideWhatToBuild`, `DisbandPlatoon`, `DisbandPlatoonUniquelyNamed`, `FindClosestArmyWithBase`, `FindPlaceToBuild`, `FindUnit`, `FindUnitToUpgrade`, `FindUpgradeBP`, `GetArmyIndex`, `GetArmyStartPos`, `GetArmyStat`, `GetAttackVectors`, `GetAvailableFactories`, `GetBlueprintStat`, `GetCurrentEnemy`, `GetCurrentUnits`, `GetEconomyIncome`, `GetEconomyRequested`, `GetEconomyStored`, `GetEconomyStoredRatio`, `GetEconomyTrend`, `GetEconomyUsage`, `GetFactionIndex`, `GetHighestThreatPosition`, `GetListOfUnits`, `GetMapWaterRatio`, `GetNoRushTicks`, `GetNumUnitsAroundPoint`, `GetPersonality`, `GetPlatoonUniquelyNamed`, `GetPlatoonsList`, `GetThreatAtPosition`, `GetThreatBetweenPositions`, `GetThreatsAroundPosition`, `GetUnitBlueprint`, `GetUnitsAroundPoint`, `GiveResource`, `GiveStorage`, `IsAnyEngineerBuilding`, `IsOpponentAIRunning`, `MakePlatoon`, `NumCurrentlyBuilding`, `PickBestAttackVector`, `PlatoonExists`, `RemoveArmyStatsTrigger`, `SetArmyStat`, `SetArmyStatsTrigger`, `SetCurrentEnemy`, `SetCurrentPlan`, `SetGreaterOf`, `SetResourceSharing`, `SetUpAttackVectorsToArmy`, `TakeResource`

**CAiNavigatorImpl** (14): `AbortMove`, `AtGoal`, `BroadcastResumeTaskEvent`, `CanPathToGoal`, `FollowingLeader`, `GetCurrentTargetPos`, `GetGoalPos`, `GetStatus`, `HasGoodPath`, `IgnoreFormation`, `IsIgnorningFormation`, `SetDestUnit`, `SetGoal`, `SetSpeedThroughGoal`

**CAiPersonality** (35): `AdjustDelay`, `GetAirUnitsEmphasis`, `GetArmySize`, `GetAttackFrequency`, `GetBotUnitsEmphasis`, `GetChatFrequency`, `GetChatPersonality`, `GetCoordinatedAttacks`, `GetCounterForces`, `GetDefenseDriven`, `GetDifficulty`, `GetDirectDamageEmphasis`, `GetEconomyDriven`, `GetExpansionDriven`, `GetFactoryTycoon`, `GetFavouriteStructures`, `GetFavouriteUnits`, `GetFormationUse`, `GetInDirectDamageEmphasis`, `GetIntelBuildingTycoon`, `GetIntelGathering`, `GetPersonalityName`, `GetPlatoonSize`, `GetQuittingTendency`, `GetRepeatAttackFrequency`, `GetSeaUnitsEmphasis`, `GetSpecialtyForcesEmphasis`, `GetSuperWeaponTendency`, `GetSupportUnitsEmphasis`, `GetSurvivalEmphasis`, `GetTankUnitsEmphasis`, `GetTargetSpread`, `GetTeamSupport`, `GetTechAdvancement`, `GetUpgradesDriven`

**CAimManipulator** (7): `GetHeadingPitch`, `OnTarget`, `SetAimHeadingOffset`, `SetEnabled`, `SetFiringArc`, `SetHeadingPitch`, `SetResetPoseTime`

**CAnimationManipulator** (12): `GetAnimationDuration`, `GetAnimationFraction`, `GetAnimationTime`, `GetRate`, `PlayAnim`, `SetAnimationFraction`, `SetAnimationTime`, `SetBoneEnabled`, `SetDirectionalAnim`, `SetDisableOnSignal`, `SetOverwriteMode`, `SetRate`

**CBoneEntityManipulator** (1): `SetPivot`

**CBuilderArmManipulator** (3): `GetHeadingPitch`, `SetAimingArc`, `SetHeadingPitch`

**CCollisionManipulator** (4): `Disable`, `Enable`, `EnableTerrainCheck`, `WatchBone`

**CDamage** (4): `GetInstigator`, `GetTarget`, `SetInstigator`, `SetTarget`

**CDecalHandle** (1): `Destroy`

**CPlatoon** (49): `AggressiveMoveToLocation`, `AttackTarget`, `CalculatePlatoonThreat`, `CalculatePlatoonThreatAroundPosition`, `CanAttackTarget`, `CanConsiderFormingPlatoon`, `CanFormPlatoon`, `Destroy`, `DisbandOnIdle`, `FerryToLocation`, `FindClosestUnit`, `FindClosestUnitToBase`, `FindFurthestUnit`, `FindHighestValueUnit`, `FindPrioritizedUnit`, `FormPlatoon`, `GetAIPlan`, `GetBrain`, `GetFactionIndex`, `GetFerryBeacons`, `GetPersonality`, `GetPlatoonLifetimeStats`, `GetPlatoonPosition`, `GetPlatoonUniqueName`, `GetPlatoonUnits`, `GetSquadPosition`, `GetSquadUnits`, `GuardTarget`, `IsAttacking`, `IsCommandsActive`, `IsFerrying`, `IsMoving`, `IsOpponentAIRunning`, `IsPatrolling`, `LoadUnits`, `MoveToLocation`, `MoveToTarget`, `Patrol`, `PlatoonCategoryCount`, `PlatoonCategoryCountAroundPosition`, `SetPlatoonFormationOverride`, `SetPrioritizedTargetList`, `Stop`, `SwitchAIPlan`, `UniquelyNamePlatoon`, `UnloadAllAtLocation`, `UnloadUnitsAtLocation`, `UseFerryBeacon`, `UseTeleporter`

**CRotateManipulator** (10): `ClearFollowBone`, `ClearGoal`, `GetCurrentAngle`, `SetAccel`, `SetCurrentAngle`, `SetFollowBone`, `SetGoal`, `SetSpeed`, `SetSpinDown`, `SetTargetSpeed`

**CSlaveManipulator** (1): `SetMaxRate`

**CSlideManipulator** (6): `BeenDestroyed`, `SetAcceleration`, `SetDeceleration`, `SetGoal`, `SetSpeed`, `SetWorldUnits`

**CThrustManipulator** (1): `SetThrustingParam`

**CUnitScriptTask** (2): `GetUnit`, `SetAIResult`

**CollisionBeamEntity** (6): `Disable`, `Enable`, `GetLauncher`, `IsEnabled`, `SetBeamFx`, `__init`

**Entity** (65): `AddLocalImpulse`, `AddManualScroller`, `AddPingPongScroller`, `AddShooter`, `AddThreadScroller`, `AddWorldImpulse`, `AdjustHealth`, `AttachBoneTo`, `AttachBoneToEntityBone`, `AttachTo`, `BeenDestroyed`, `CreateProjectile`, `CreateProjectileAtBone`, `CreatePropAtBone`, `Destroy`, `DetachAll`, `DetachFrom`, `DisableIntel`, `EnableIntel`, `FallDown`, `GetAIBrain`, `GetArmy`, `GetBlueprint`, `GetBoneCount`, `GetBoneDirection`, `GetBoneName`, `GetCollisionExtents`, `GetEntityId`, `GetFractionComplete`, `GetHeading`, `GetHealth`, `GetIntelRadius`, `GetMaxHealth`, `GetOrientation`, `GetParent`, `GetPosition`, `GetPositionXYZ`, `GetScale`, `InitIntel`, `IsIntelEnabled`, `IsValidBone`, `Kill`, `PlaySound`, `PushOver`, `ReachedMaxShooters`, `RemoveScroller`, `RemoveShooter`, `RequestRefreshUI`, `SetAmbientSound`, `SetCollisionShape`, `SetDrawScale`, `SetHealth`, `SetIntelRadius`, `SetMaxHealth`, `SetMesh`, `SetOrientation`, `SetParentOffset`, `SetPosition`, `SetScale`, `SetVizToAllies`, `SetVizToEnemies`, `SetVizToFocusPlayer`, `SetVizToNeutrals`, `ShakeCamera`, `SinkAway`

**IAniManipulator** (4): `Destroy`, `Disable`, `Enable`, `SetPrecedence`

**IEffect** (7): `Destroy`, `OffsetEmitter`, `ResizeEmitterCurve`, `ScaleEmitter`, `SetBeamParam`, `SetEmitterCurveParam`, `SetEmitterParam`

**MotorFallDown** (1): `Whack`

**Projectile** (30): `ChangeDetonateAboveHeight`, `ChangeDetonateBelowHeight`, `ChangeMaxZigZag`, `ChangeZigZagFrequency`, `CreateChildProjectile`, `GetCurrentSpeed`, `GetCurrentTargetPosition`, `GetLauncher`, `GetTrackingTarget`, `GetVelocity`, `SetAcceleration`, `SetBallisticAcceleration`, `SetCollideEntity`, `SetCollideSurface`, `SetCollision`, `SetDamage`, `SetDestroyOnWater`, `SetLifetime`, `SetLocalAngularVelocity`, `SetMaxSpeed`, `SetNewTarget`, `SetNewTargetGround`, `SetScaleVelocity`, `SetStayUpright`, `SetTurnRate`, `SetVelocity`, `SetVelocityAlign`, `SetVelocityRandomUpVector`, `StayUnderwater`, `TrackTarget`

**Prop** (1): `AddBoundedProp`

**ReconBlip** (9): `GetBlueprint`, `GetSource`, `IsKnownFake`, `IsMaybeDead`, `IsOnOmni`, `IsOnRadar`, `IsOnSonar`, `IsSeenEver`, `IsSeenNow`

**Unit** (108): `AddBuildRestriction`, `AddCommandCap`, `AddToggleCap`, `AddUnitToStorage`, `AlterArmor`, `CalculateWorldPositionFromRelative`, `CanBuild`, `CanPathTo`, `CanPathToRect`, `ClearFocusEntity`, `EnableManipulators`, `GetArmorMult`, `GetAttacker`, `GetBlip`, `GetBuildRate`, `GetCargo`, `GetCommandQueue`, `GetConsumptionPerSecondEnergy`, `GetConsumptionPerSecondMass`, `GetCurrentMoveLocation`, `GetFocusUnit`, `GetFuelRatio`, `GetFuelUseTime`, `GetHealth`, `GetNavigator`, `GetNukeSiloAmmoCount`, `GetNumBuildOrders`, `GetRallyPoint`, `GetResourceConsumed`, `GetScriptBit`, `GetShieldRatio`, `GetStat`, `GetTacticalSiloAmmoCount`, `GetTargetEntity`, `GetTransportFerryBeacon`, `GetUnitId`, `GetWeapon`, `GetWeaponCount`, `GetWorkProgress`, `GiveNukeSiloAmmo`, `GiveTacticalSiloAmmo`, `HasMeleeSpaceAroundTarget`, `HideBone`, `IsBeingBuilt`, `IsCapturable`, `IsIdleState`, `IsMoving`, `IsPaused`, `IsStunned`, `IsUnitState`, `KillManipulator`, `KillManipulators`, `MeleeWarpAdjacentToTarget`, `PrintCommandQueue`, `RemoveBuildRestriction`, `RemoveCommandCap`, `RemoveNukeSiloAmmo`, `RemoveTacticalSiloAmmo`, `RemoveToggleCap`, `RestoreBuildRestrictions`, `RestoreCommandCaps`, `RestoreToggleCaps`, `RevertRegenRate`, `ScaleGetBuiltEmitter`, `SetAutoMode`, `SetBlockCommandQueue`, `SetBreakOffTriggerMult`, `SetBuildRate`, `SetBusy`, `SetCapturable`, `SetConsumptionActive`, `SetConsumptionPerSecondEnergy`, `SetConsumptionPerSecondMass`, `SetCreator`, `SetCustomName`, `SetDoNotTarget`, `SetElevation`, `SetFireState`, `SetFocusEntity`, `SetFuelRatio`, `SetFuelUseTime`, `SetImmobile`, `SetIsValidTarget`, `SetOverchargePaused`, `SetPaused`, `SetProductionActive`, `SetProductionPerSecondEnergy`, `SetProductionPerSecondMass`, `SetReclaimable`, `SetRegenRate`, `SetScriptBit`, `SetShieldRatio`, `SetStat`, `SetStrategicUnderlay`, `SetStunned`, `SetTurnMult`, `SetUnSelectable`, `SetUnitState`, `SetWorkProgress`, `ShowBone`, `StopSiloBuild`, `TestCommandCaps`, `TestToggleCaps`, `ToggleFireState`, `ToggleScriptBit`, `TransportDetachAllUnits`, `TransportHasAvailableStorage`, `TransportHasSpaceFor`

**UnitWeapon** (31): `BeenDestroyed`, `CanFire`, `ChangeDamage`, `ChangeDamageRadius`, `ChangeDamageType`, `ChangeFiringTolerance`, `ChangeMaxHeightDiff`, `ChangeMaxRadius`, `ChangeMinRadius`, `ChangeProjectileBlueprint`, `ChangeRateOfFire`, `CreateProjectile`, `DoInstaHit`, `FireWeapon`, `GetBlueprint`, `GetCurrentTarget`, `GetCurrentTargetPos`, `GetFireClockPct`, `GetFiringRandomness`, `GetProjectileBlueprint`, `IsFireControl`, `PlaySound`, `ResetTarget`, `SetEnabled`, `SetFireControl`, `SetFireTargetLayerCaps`, `SetFiringRandomness`, `SetTargetGround`, `SetTargetingPriorities`, `TransferTarget`, `WeaponHasTarget`

