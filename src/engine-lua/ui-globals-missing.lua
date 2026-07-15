-- =====================================================================
-- UI-Globals, die es in der Engine GIBT, die wir aber noch nicht haben.
--
-- Erzeugt aus der Decomp: alle 200 <global>-Bindungen in scr_UserInits
-- (siehe docs/research/engine-api.md). Wer hier schon implementiert ist, wird
-- uebersprungen — der Rest bekommt eine Funktion, die beim AUFRUF laut
-- scheitert.
--
-- Das ist KEIN Stub-Trap: die Original-UI-Lua REFERENZIERT viele dieser
-- Globals beim Laden (uiutil.lua:103 baut daraus Tastatur-Aktionen), ruft sie
-- aber erst spaeter. Referenzieren muss also gehen; Aufrufen muss knallen —
-- mit dem Namen, damit man weiss, was als Naechstes zu bauen ist.
-- =====================================================================

local NOT_IMPLEMENTED = {
  'AddBlinkyBox', 'AddCommandFeedbackBlip', 'AddConsoleOutputReciever', 'AddInputCapture', 'AddSelectUnits', 'AddToSessionExtraSelectList',
  'AnyInputCapture', 'AudioSetLanguage', 'ClearBuildTemplates', 'ClearCurrentFactoryForQueueDisplay', 'ClearFrame', 'ClearSessionExtraSelectList',
  'ConExecute', 'ConExecuteSave', 'ConTextMatches', 'CopyCurrentReplay', 'CurrentTime', 'DebugFacilitiesEnabled',
  'DecreaseBuildCountInQueue', 'DeleteCommand', 'EjectSessionClient', 'EngineStartFrontEndUI', 'EngineStartSplashScreens', 'EntityCategoryContains',
  'EntityCategoryFilterDown', 'EntityCategoryFilterOut', 'ExecLuaInSim', 'ExitApplication', 'ExitGame',
  'FormatTime', 'GenerateBuildTemplateFromSelection', 'GetActiveBuildTemplate', 'GetAntiAliasingOptions',
  'GetArmiesTable', 'GetArmyAvatars', 'GetArmyScore', 'GetAssistingUnitsList', 'GetAttachedUnitsList', 'GetBlueprint',
  'GetCamera', 'GetCommandLineArg', 'GetCurrentUIState', 'GetCursor', 'GetEconomyTotals', 'GetFireState',
  'GetFocusArmy', 'GetFrame', 'GetFrontEndData', 'GetGameSpeed',
  'GetIdleEngineers', 'GetIdleFactories', 'GetInputCapture', 'GetIsAutoMode', 'GetIsAutoSurfaceMode', 'GetIsPaused',
  'GetIsSubmerged', 'GetMouseScreenPos', 'GetMouseWorldPos', 'GetMovieVolume', 'GetNumRootFrames', 'GetOptions',
  'GetPreference', 'GetResourceSharing', 'GetRolloverInfo', 'GetScriptBit', 'GetSelectedUnits', 'GetSessionClients',
  'GetSimRate', 'GetSimTicksPerSecond', 'GetSpecialFileInfo', 'GetSpecialFilePath', 'GetSpecialFiles', 'GetSpecialFolder',
  'GetSystemTime', 'GetSystemTimeSeconds', 'GetTextureDimensions', 'GetUIControlsAlpha', 'GetUnitById', 'GetUnitCommandData',
  'GetUnitCommandFromCommandCap', 'GetValidAttackingUnits', 'GetVolume', 'GpgNetActive', 'GpgNetSend', 'HasCommandLineArg',
  'HasLocalizedVO', 'IN_AddKeyMapTable', 'IN_ClearKeyMap', 'IN_RemoveKeyMapTable', 'IncreaseBuildCountInQueue', 'InternalCreateBitmap',
  'InternalCreateBorder', 'InternalCreateDiscoveryService', 'InternalCreateDragger', 'InternalCreateEdit', 'InternalCreateFrame', 'InternalCreateGroup',
  'InternalCreateHistogram', 'InternalCreateItemList', 'InternalCreateLobby', 'InternalCreateMapPreview', 'InternalCreateMesh', 'InternalCreateMovie',
  'InternalCreateScrollbar', 'InternalCreateText', 'InternalCreateWorldMesh', 'InternalSaveGame', 'IsAlly',
  'IsEnemy', 'IsKeyDown', 'IsNeutral', 'IsObserver', 'IssueBlueprintCommand', 'IssueCommand',
  'IssueDockCommand', 'IssueUnitCommand', 'KeycodeMSWToMaui', 'KeycodeMauiToMSW', 'LaunchGPGNet', 'LaunchSinglePlayerSession',
  'LoadSavedGame', 'OpenURL', 'ParseEntityCategory', 'PauseSound',
  'PauseVoice', 'PlaySound', 'PlayTutorialVO', 'PlayVoice', 'PostDragger', 'PrefetchSession',
  'Random', 'RemoveConsoleOutputReciever', 'RemoveFromSessionExtraSelectList', 'RemoveInputCapture', 'RemoveProfileDirectories', 'RemoveSpecialFile',
  'RenderOverlayEconomy', 'RenderOverlayIntel', 'RenderOverlayMilitary', 'RestartSession', 'SavePreferences', 'SelectUnits',
  'SessionCanRestart', 'SessionEndGame', 'SessionGetCommandSourceNames', 'SessionGetLocalCommandSource', 'SessionGetScenarioInfo', 'SessionIsActive',
  'SessionIsBeingRecorded', 'SessionIsGameOver', 'SessionIsMultiplayer', 'SessionIsObservingAllowed', 'SessionIsPaused', 'SessionIsReplay',
  'SessionRequestPause', 'SessionResume', 'SessionSendChatMessage', 'SetActiveBuildTemplate', 'SetAutoMode', 'SetAutoSurfaceMode',
  'SetCursor', 'SetFireState', 'SetFocusArmy', 'SetFrontEndData', 'SetGameSpeed', 'SetMovieVolume',
  'SetOverlayFilter', 'SetOverlayFilters', 'SetPaused', 'SetPreference', 'SetUIControlsAlpha', 'SetVolume',
  'SimCallback', 'SoundIsPrepared', 'StartSound', 'StopSound', 'SyncPlayableRect', 'TeamColorMode',
  'ToggleFireState', 'ToggleScriptBit', 'UISelectionByCategory', 'UnProject',
  'ValidateIPAddress', 'ValidateUnitsList', 'WorldIsLoading', 'WorldIsPlaying', '_c_CreateCursor', '_c_CreateDecal',
  '_c_CreatePathDebugger', 'print',
}

for _, name in ipairs(NOT_IMPLEMENTED) do
  if rawget(_G, name) == nil then
    _G[name] = function()
      error(name .. ': UI-Global aus scr_UserInits ist noch nicht implementiert', 2)
    end
  end
end
