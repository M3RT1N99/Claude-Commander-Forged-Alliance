-- =====================================================================
-- UI globals that EXIST in the engine but that we don't have yet.
--
-- Generated from decomp: all 200 <global> bindings in scr_UserInits
-- (see docs/research/engine-api.md). Anyone who has already implemented this will
-- skipped - the rest gets a function that is loud when CALLED
-- scheitert.
--
-- This is NOT a stub trap: the original UI Lua REFERENCES many of these
-- Globals loading (uiutil.lua:103 builds keyboard actions from them), she calls
-- but only later. So referencing has to work; Calling has to bang -
-- with the name so that you know what to build next.
-- =====================================================================

local NOT_IMPLEMENTED = {
  'AddBlinkyBox', 'AddCommandFeedbackBlip', 'AddConsoleOutputReciever', 'AddInputCapture', 'AddSelectUnits', 'AddToSessionExtraSelectList',
  'AnyInputCapture', 'AudioSetLanguage', 'ClearBuildTemplates', 'ClearCurrentFactoryForQueueDisplay', 'ClearFrame', 'ClearSessionExtraSelectList',
  'ConExecute', 'ConExecuteSave', 'ConTextMatches', 'CopyCurrentReplay', 'CurrentTime', 'DebugFacilitiesEnabled',
  'DeleteCommand', 'EjectSessionClient', 'EngineStartFrontEndUI', 'EngineStartSplashScreens', 'EntityCategoryContains',
  'EntityCategoryFilterDown', 'EntityCategoryFilterOut', 'ExecLuaInSim', 'ExitApplication', 'ExitGame',
  'FormatTime', 'GenerateBuildTemplateFromSelection', 'GetActiveBuildTemplate', 'GetAntiAliasingOptions',
  'GetArmiesTable', 'GetArmyAvatars', 'GetArmyScore', 'GetAttachedUnitsList', 'GetBlueprint',
  'GetCamera', 'GetCommandLineArg', 'GetCursor', 'GetEconomyTotals', 'GetFireState',
  'GetFocusArmy', 'GetFrame', 'GetFrontEndData', 'GetGameSpeed',
  'GetIdleEngineers', 'GetIdleFactories', 'GetInputCapture', 'GetIsAutoMode', 'GetIsAutoSurfaceMode', 'GetIsPaused',
  'GetIsSubmerged', 'GetMouseScreenPos', 'GetMouseWorldPos', 'GetMovieVolume', 'GetNumRootFrames', 'GetOptions',
  'GetPreference', 'GetResourceSharing', 'GetRolloverInfo', 'GetScriptBit', 'GetSelectedUnits',
  'GetSimRate', 'GetSimTicksPerSecond', 'GetSpecialFileInfo', 'GetSpecialFilePath', 'GetSpecialFiles', 'GetSpecialFolder',
  'GetSystemTime', 'GetSystemTimeSeconds', 'GetTextureDimensions', 'GetUIControlsAlpha', 'GetUnitById', 'GetUnitCommandData',
  'GetValidAttackingUnits', 'GpgNetActive', 'GpgNetSend', 'HasCommandLineArg',
  'HasLocalizedVO', 'IN_AddKeyMapTable', 'IN_ClearKeyMap', 'IN_RemoveKeyMapTable', 'InternalCreateBitmap',
  'InternalCreateBorder', 'InternalCreateDiscoveryService', 'InternalCreateDragger', 'InternalCreateEdit', 'InternalCreateFrame', 'InternalCreateGroup',
  'InternalCreateHistogram', 'InternalCreateItemList', 'InternalCreateLobby', 'InternalCreateMapPreview', 'InternalCreateMesh', 'InternalCreateMovie',
  'InternalCreateScrollbar', 'InternalCreateText', 'InternalCreateWorldMesh', 'InternalSaveGame', 'IsAlly',
  'IsEnemy', 'IsNeutral', 'IsObserver', 'IssueBlueprintCommand', 'IssueCommand',
  'IssueDockCommand', 'IssueUnitCommand', 'KeycodeMSWToMaui', 'KeycodeMauiToMSW', 'LaunchGPGNet', 'LaunchSinglePlayerSession',
  'LoadSavedGame', 'OpenURL', 'ParseEntityCategory', 'PauseSound',
  'PauseVoice', 'PlaySound', 'PlayTutorialVO', 'PlayVoice', 'PostDragger', 'PrefetchSession',
  'Random', 'RemoveConsoleOutputReciever', 'RemoveFromSessionExtraSelectList', 'RemoveInputCapture', 'RemoveProfileDirectories', 'RemoveSpecialFile',
  'RenderOverlayEconomy', 'RenderOverlayIntel', 'RenderOverlayMilitary', 'SavePreferences', 'SelectUnits',
  'SessionEndGame', 'SessionGetCommandSourceNames', 'SessionGetLocalCommandSource', 'SessionGetScenarioInfo', 'SessionIsActive',
  'SessionIsBeingRecorded', 'SessionIsGameOver', 'SessionIsMultiplayer', 'SessionIsObservingAllowed', 'SessionIsPaused', 'SessionIsReplay',
  'SessionRequestPause', 'SessionResume', 'SetActiveBuildTemplate', 'SetAutoMode', 'SetAutoSurfaceMode',
  'SetCursor', 'SetFireState', 'SetFocusArmy', 'SetFrontEndData', 'SetGameSpeed', 'SetMovieVolume',
  'SetOverlayFilter', 'SetOverlayFilters', 'SetPaused', 'SetPreference', 'SetUIControlsAlpha',
  'SoundIsPrepared', 'StartSound', 'StopSound', 'SyncPlayableRect', 'TeamColorMode',
  'ToggleFireState', 'ToggleScriptBit', 'UISelectionByCategory', 'UnProject',
  'ValidateIPAddress', 'WorldIsPlaying', '_c_CreateCursor', '_c_CreateDecal',
  '_c_CreatePathDebugger', 'print',
}

for _, name in ipairs(NOT_IMPLEMENTED) do
  if rawget(_G, name) == nil then
    _G[name] = function()
      error(name .. ': UI-Global aus scr_UserInits ist noch nicht implementiert', 2)
    end
  end
end
