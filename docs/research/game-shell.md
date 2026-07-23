# agent3

## Summary
The game framework of SupCom:FA is almost completely mapped in Lua and is located in `lua.scd` (UI/Lobby/Menu/AI) + `mohodata.scd` (Boot/Session Init, Prefs, ScenarioUtilities) + `schook.scd` (Hooks, including the Victory Thread). The skirmish start is running: Splash → `uimain.StartFrontEndUI` → `ui/menus/main.lua` → `lobby.CreateLobby('None',0,…)` + `lobby.HostGame(name, scenarioFile, singlePlayer=true)` → `TryLaunch` → `lobbyComm:LaunchGame(gameInfo)`; then engine session with Sim-Init (`simInit.SetupSession/BeginSession`) and UI-Init (`gamemain.CreateWldUIProvider`). Victory conditions are only ~100 lines (`lua/victory.lua`), options/prefs are Lua tables (`lobbyOptions.lua`, `options/options.lua`, Game.prefs as a serialized Lua table). For a minimally playable skirmish you need: ScenarioFile loader, GameOptions/PlayerOptions structure, army spawn (`ScenarioUtilities.InitializeArmies`), victory thread, score/GameResult sync — the lobby UI itself is replaceable (SinglePlayerLaunch.lua shows the minimal path without a lobby).

## Key Facts
- Skirmish launch is single-player hosting: main.lua ButtonSkirmish calls lobby.CreateLobby('None', 0, playerName, …) + lobby.HostGame(name, lastScenario, inSinglePlayer=true) — protocol 'None' = local, no network.
- The launch object is `gameInfo = { GameOptions={}, PlayerOptions={}, Observers={}, ClosedSlots={}, GameMods={} }` (lobby.lua Reset) and goes to the engine via `lobbyComm:LaunchGame(gameInfo)`; the lobby-free path `LaunchSinglePlayerSession(sessionInfo)` (SinglePlayerLaunch.lua) uses `{playerName, createReplay, scenarioInfo(+Options), teamInfo[], scenarioMods, RandomSeed}`.
- Sim init order (mohodata/lua/simInit.lua comment): __blueprints → simInit.lua → ScenarioInfo set → SetupSession() (loads _save.lua + _script.lua) → Armies/Brains created (OnCreateArmyBrain → InitializeArmyAI) → BeginSession() (OnPopulate/OnStart of the map script, teams/alliances, build restrictions).
- The map script for skirmish is minimal: `OnPopulate() ScenarioUtils.InitializeArmies() end; OnStart(self) end` — all Army/ACU/Resource generation is in mohodata `lua/sim/ScenarioUtilities.lua`.
- Victory: `lua/victory.lua CheckVictory(scenarioInfo)` is forked by `schook/lua/simInit.lua` in BeginSession; Categories: demoralization=COMMAND, domination=STRUCTURE+ENGINEER-WALL, eradication=ALLUNITS-WALL, sandbox=no check; Poll every 3 s, victory takes 15 s stable Allied Victory situation.
- Spielende-Fluss: brain:OnDefeat/OnVictory → `Sync.GameResult` → UserSync → `ui/game/gameresult.lua DoGameResult(armyIndex, result)` → Sound + Tab-Announcement + Score-Button → `ui/dialogs/score.lua CreateDialog(victory)`; Engine ruft zusätzlich `NoteGameOver()` in uimain.lua.
- GameOptions defaults come from `lua/ui/lobby/lobbyOptions.lua` (teamOptions + globalOpts), mixed with prefs: TeamSpawn=random, TeamLock=locked, UnitCap=500, FogOfWar=explored, Victory=demoralization(Assassination), Timeouts=3, GameSpeed=normal, CheatsEnabled=false, CivilianAlliance=enemy, PrebuiltUnits=Off, NoRushOption=Off.
- PlayerOptions per slot (lobbyComm.GetDefaultPlayerOptions): {Team=1, PlayerColor=1, ArmyColor=1, StartSpot=1, Ready=false, Faction=5 (=NumFactions+1 → random), PlayerName, AIPersonality='', Human=true, Civilian=false} + OwnerID; maxPlayerSlots=8.
- Game.prefs is a serialized Lua table (no INI) at %LOCALAPPDATA%\Gas Powered Games\Supreme Commander Forged Alliance\Game.prefs with top level keys profile{current,profiles[]}, options_overrides, Options.Log/Debug, CPUBenchmark, PreGameData; Access via engine globals GetPreference/SetPreference/SavePreferences, wrapped in mohodata `lua/user/prefs.lua`.
- Graphics/Sound/Gameplay options: `lua/options/options.lua` (4 tabs: gameplay, ui, video, sound), each item {key, default, type=toggle|slider|button, custom.states[], set=fn→ConExecute}; Logic in `lua/options/optionsLogic.lua` (GetCurrent/SetCurrent/Apply/ResetToDefaults).
- Keybindings: `lua/keymap/defaultKeyMap.lua` (Key→Action name, plus separate debugKeyMap), `lua/keymap/keyactions.lua` (Action name→Console command or `UI_Lua import(...)`), `lua/keymap/keymapper.lua` (UserKeyMap from Prefs overwrites default).
- Skirmish AI: ScenarioInfo.ArmySetup[name].AIPersonality (aitypes.lua: easy/medium/adaptive/rush/turtle/tech/random + *cheat); aibrain.OnCreateAI sets CurrentPlan = AIPlansList[faction][1] = '/lua/AI/aiarchetype-managerloader.lua' (identical for ALL 4 factions) and forks EvaluateAIThread/ExecuteAIThread.
- AI Bootstrap: `ScenarioUtilities.InitializeArmies` calls `brain:InitializeSkirmishSystems()` → BuilderManagers['MAIN'] (Position = StartVector, Radius 100) with Factory/Engineer/PlatoonForm Manager, ConditionsMonitor, EconomyMonitor, BaseMonitor, PickEnemy thread; `aiarchetype-managerloader.ExecutePlan` selects the highest rated template from `lua/AI/AIBaseTemplates/*.lua` via `FirstBaseFunction(aiBrain)`.
- AI cheats: Personality suffix 'cheat' → `AIUtils.SetupCheat` → Buffs from `lua/sim/CheatBuffs.lua`: CheatBuildRate (BuildRate ×2), CheatIncome (Mass+Energy Production ×2), IntelCheat (Vision/Omni +10000, ACU only).
- AI scope: lua/AI = 2.02 MB in 89 files; plus aibrain.lua 169 KB, platoon.lua 131 KB, AIBehaviors 52 KB, aiattackutilities 59 KB, aiutilities 68 KB — schook/simInit loads all files from /lua/AI/PlatoonTemplates, /lua/AI/AIBuilders, /lua/AI/AIBaseTemplates per DiskFindFiles.
- Campaign: `campaignmanager.campaignSequence` = {uef|cybran|aeon → X1CA_001…X1CA_006}; per Op `maps/<opID>/<opID>_operation.lua` (exports `operationData` via `operationvars.MakeOpVars(opID,'X',n)`); Briefings/FMV are .sfd movies in /movies (1004 files); Progress is in Prefs under 'campaign' [campaignID][opKey][difficulty] = {allPrimary, allSecondary}.
- Campaign in the Sim: `ScenarioUtilities.InitializeScenarioArmies()` (instead of InitializeArmies) sets Sync.CampaignMode, faction/color/personality from the _save.lua, loads PBM builder; Objectives via SimObjectives.lua → Sync.ObjectivesTable → ui/game/objectives2.lua; End via Sync.OperationComplete → campaignmanager.OperationVictory.
- Cheat/Debug commands (only with DebugFacilitiesEnabled(); uimain.StartFrontEndUI otherwise removes the debugKeyMap): PopupCreateUnitMenu (Alt-F2 → createunit.lua → `ConExecuteSave('CreateUnit <bpid> <army> <x> <y>')`), SetFocusArmy <n>, TeleportSelectedUnits, DestroySelectedUnits, Nodamage, SallyShears, BlingBling, AI_RunOpponentAI, WLD_SingleStep, ShowArmyStats, ren_ShowWireframe, dbg navpath|grid|weapons|Collision.
- Factions (lua/factions.lua, index = array position): 1 uef/uel0001, 2 aeon/ual0001, 3 cybran/url0001, 4 seraphim/xsl0001 — incl. loadingMovie/-Texture/-Color, DefaultSkin and icon paths; Faction index 5 in PlayerOptions = 'random', is only resolved at launch (AssignRandomFactions).
- Player/Army Colors: mohodata `lua/GameColors.lua` — 10 PlayerColors/ArmyColors (FFe80a0a, DarkGreen, FF131cd3, Goldenrod, FFA7A7A7, Darkslategray, FF202020, FF4d0505, FF2E8B57, BlueViolet), CivilianArmyColor='BurlyWood'.

## Details
## 1. Game start flow (original)

### 1.1 Boot / Front-End
| step | File | What happens |
| --- | --- | --- |
| Lua-User-State init | `mohodata:lua/userInit.lua` | `__language` from prefs, `globalInit.lua`, `WaitSeconds` over frames, global `FrontEndData = {}` |
| UI Setup | `lua/ui/uimain.lua` `SetupUI()` | Cursor, `UIUtil.currentLayout` from Prefs (`layout`, Default `'bottom'`), `UIUtil.SetCurrentSkin(prefs.skin or 'uef')` |
| Splash | `uimain.StartSplashScreen()` → `lua/ui/splash/splash.lua` | |
| Front End | `uimain.StartFrontEndUI()` | removes debugKeyMap if `not DebugFacilitiesEnabled()`; if `GetFrontEndData('NextOpBriefing')` set → direct campaign briefing, otherwise `ui/menus/main.lua CreateUI()` |
| Main menu | `lua/ui/menus/main.lua` | If no profile (`GetPreference("profile.current")` nil) → Profile dialog first. Menu items: Campaign / Skirmish / Multiplayer LAN / Matchmaking / Extras / Options / Exit. Background: `/movies/main_menu.sfd` (can be switched off using the `mainmenu_bgmovie` option) |

**Skirmish-Button (main.lua ~909):**
```
lobby.CreateLobby('None', 0, playerName, nil, nil, topLevelGroup, exitBehavior)
lobby.HostGame(playerName .. "'s Skirmish", scenarioFileName, true)   -- inSinglePlayer=true
```
`scenarioFileName = Prefs.GetFromCurrentProfile('LastScenario') or UIUtil.defaultScenario` (= `/maps/scmp_039/scmp_039_scenario.lua`).

### 1.2 Lobby (`lua/ui/lobby/lobby.lua`, 115 KB)
- `Reset()` erzeugt `gameInfo = { GameOptions={}, PlayerOptions={}, Observers={}, ClosedSlots={}, GameMods={} }`.
- `lobbyComm.Hosting` (Z. 2872): Slot 1 = local player (`GetDefaultPlayerOptions`, `PlayerColor/ArmyColor` from Pref `LastColor`, `Faction` from Pref `LastFaction`, otherwise `#Factions+1` = random). Then **Default-GameOptions**: for each option in `teamOpts` and `globalOpts`: `SetGameOption(option.key, option.values[ Prefs[option.pref] or option.default ].key)`. Then `SetGameOption('ScenarioFile', desiredScenario)`.
- Slot management: `HostTryAddPlayer`, `HostRemoveAI`, `HostOpenSlot`/`HostCloseSlot`, `SetSlotInfo`, `UpdateAvailableSlots(numAvailStartSpots)` — Slots above the map's army number will be blocked. `LobbyComm.maxPlayerSlots = 8`.
- Slot menu (`GetSlotMenuTables`): open/close slot, add AI (from `aitypes.lua`), set color/faction/team.
- Map selection: `ui/dialogs/mapselect.lua CreateDialog(...)` → on OK: `SetGameOption('ScenarioFile', selectedScenario.file)`, `SetGameOption('RestrictedCategories', restrictedCategories, true)`, plus changed options in Prefs.
- **Launch (`TryLaunch`, Z. 756):** Validation → at least 1 player; if `Victory != 'sandbox'`: at least 2 players OR >1 team; at least 1 human or observer. Then `LaunchGame()`:
  1. `AssignRandomFactions(gameInfo)` — Faction ≥ #Factions+1 → `math.random(1,4)`
  2. `AssignRandomStartSpots(gameInfo)` — only if `GameOptions.TeamSpawn == 'random'`: Fisher-Yates-like exchange of PlayerOptions based on the number of starting spots (closed slots skipped)
  3. `AssignAINames(gameInfo)` — name from `ui/lobby/aiNames.lua[factionKey]`, result `"<AIName> (<Personality>)"`
  4. `lobbyComm:LaunchGame(gameInfo)` (Engine-Native)

  In the single player it launches immediately, in the MP only after a 5-s countdown.

### 1.3 Lobby-free path (important for minimal replication)
`lua/SinglePlayerLaunch.lua` shows the **smallest** session creation — no lobby UI needed:
```
sessionInfo = {
  playerName, createReplay=false,
  scenarioInfo = MapUtil.LoadScenario(mapPath),      -- + .Options = GameOptions
  teamInfo = { [1..N] = PlayerOptions },             -- GetDefaultPlayerOptions()-Form
  scenarioMods, RandomSeed
}
LaunchSinglePlayerSession(sessionInfo)               -- Engine-Native
```
Default options there (`defaultOptions`, Z. 123): FogOfWar=explored, NoRushOption=Off, PrebuiltUnits=Off, Difficulty=2, DoNotShareUnitCap=true, Timeouts=-1, GameSpeed=normal, UnitCap='500', Victory='sandbox', CheatsEnabled='true', CivilianAlliance='enemy'.
Zusätzlich: `MapUtil.GetExtraArmies(scenarioInfo)` → Civilian-Armeen (`Civilian=true, Human=false`).
`FixupMapName(name)` → `/maps/<n>/<n>_scenario.lua`.

### 1.4 Session-Init im Sim (`mohodata:lua/simInit.lua` + `schook/lua/simInit.lua`)
1. `__blueprints` from preloaded data
2. `simInit.lua` läuft (globalInit, SimSync)
3. `ScenarioInfo` filled by the engine (fields from `_scenario.lua` + `Options` from GameOptions + `ArmySetup` from PlayerOptions)
4. **`SetupSession()`**: `ArmyBrains={}`, ScenarioInfo.{PlatoonHandles, UnitGroups, UnitNames, VarTable, BuilderTable, MapData}, `ScenarioInfo.Env = import('/lua/scenarioEnvironment.lua')`, then `doscript(ScenarioInfo.save)` → global `Scenario`, `doscript(ScenarioInfo.script)`; schook complements `ScenarioInfo.TriggerManager`.
5. Engine creates armies/brains → **`OnCreateArmyBrain(index, brain, name, nickname)`**: `ArmyBrains[index]=brain`, `InitializeArmyAI(name)`; schook-Hook calls `ScenarioUtils.InitializeStartLocation(name)` and `ScenarioUtils.SetPlans(name)` beforehand.
6. **`BeginSession()`**: first schook `ScenarioUtils.CreateProps()` + `CreateResources()` (mass/hydro deposits + splats from markers), then basic BeginSession:
   - `ScenarioInfo.Env.OnPopulate(ScenarioInfo)` → Map-Script → `ScenarioUtils.InitializeArmies()`
   - `ScenarioInfo.Env.OnStart(ScenarioInfo)`
   - Teams from `ScenarioInfo.ArmySetup[*].Team > 1` → `SetAlliance(a,b,"Ally")` + `brain.RequestingAlliedVictory = true`
   - `TeamLock == 'locked'` → `ScenarioInfo.TeamGame = true`, `Sync.LockTeams = true`
   - `Options.RestrictedCategories` → Categories from `ui/lobby/restrictedUnitsData.lua` → `AddBuildRestriction(index, cats)` for all armies
   - Effect-Marker instanziieren
   - schook danach: `ForkThread(aibrain.CollectCurrentScores)`, `ForkThread(aibrain.SyncCurrentScores)` (1 Hz), `ForkThread(victory.CheckVictory, ScenarioInfo)`

**`ScenarioUtilities.InitializeArmies()`** (Skirmish):
- per army `SetArmyEconomy(strArmy, tblData.Economy.mass, tblData.Economy.energy)` (from _save.lua)
- `if brain.SkirmishSystems then brain:InitializeSkirmishSystems() end`
- `CreateInitialArmyGroup(strArmy, createCommander)`: if map has no INITIAL group → `CreateInitialArmyUnit(strArmy, Factions[factionIndex].InitialUnit)`; at `PrebuiltUnits == 'Off'` → ACU `HideBone(0,true)` + after 3 s `PlayCommanderWarpInEffect()` (the warp-in effect)
- ACU bekommt `SetCustomName(brain.Nickname)`
- WRECKAGE group → wrecks
- Alliances: default all Enemy; `CivilianAlliance == 'neutral'` → Civ neutral; `'removed'` → no Civ units; Army `NEUTRAL_CIVILIAN` always neutral

### 1.5 Session init in the UI (`lua/ui/game/gamemain.lua`, 26 KB)
`uimain.StartGameUI()` → `gamemain.CreateWldUIProvider()` sets a `WldUIProvider` with callbacks that the engine calls:
- `StartLoadingDialog` → faction loading movie (`factions[LoadingFaction].loadingMovie`, e.g. `/movies/UEF_load.sfd`) + "IN TRANSIT" text; `supressExitDialog=true`
- `CreateGameInterface(isReplay)` → `CreateUI(isReplay)`
- `StopLoadingDialog` → Faction-Loading-Bitmap ausblenden, danach `InitialAnimations()` (tabs → economy/score → multifunction/avatars/controlgroups)
- `DestroyGameInterface`, `GetPrefetchTextures`, `Start/StopWaitingDialog`

`CreateUI()` builds in this order: `borders.SetupBorderControl` (provides controlCluster/statusCluster/mapGroup/windowGroup) → worldview → economy-Bar → tabs → multifunction → orders → construction → unitview(+Detail) → avatars → controlgroups → transmissionlog → helptext → timer → consoleecho → build_templates → taunt → chat → minimap → (campaign: objectives2).

`OnFirstUpdate()` (first frame of the controlClusterGroup): `EnableWorldSounds()`, set ACU name, `StartPeaceMusic()`, `score.CreateScoreUI()` (not in campaign mode), after 1.5 s `UIZoomTo(avatars,1)`, after another 1.5 s `SelectUnits(avatars)` + `worldview.UnlockInput()`; optional skin on faction skin (`Prefs 'skin_change_on_start' != 'no'`).

Engine-Callbacks in gamemain: `OnSelectionChanged`, `OnQueueChanged`, `OnBeat`, `OnPause/OnResume/OnUserPause`, `NISMode`, `ReceiveChat`, `QuickSave`.

---

## 2. Spieloptionen / Prefs

### 2.1 Game.prefs
- Ort: `%LOCALAPPDATA%\Gas Powered Games\Supreme Commander Forged Alliance\Game.prefs` (+ `Game.prefs.save`); im Test 929 KB.
- **Format = serialized Lua table** (text, `key = value` syntax, strings in `'…'`), not INI. Top level keys: `PreGameData` (CurrentMapDir, IconReplacements), `mods_expanded`, `Options` (Log.{Info,Warn,Debug,Custom,Error,Filter}, Debug.{Files,Breakpoints}), `CPUBenchmark`, `options_overrides` (overrides `default`/`custom` individual option items — e.g. the detected resolutions), `profile` (see below).
- Engine API: `GetPreference(path, default)`, `SetPreference(path, val)`, `SavePreferences()`; Paths are dotted (`'options_overrides.language'`).
- Wrappers: `mohodata:lua/user/prefs.lua` — `ProfilesExist`, `CreateProfile(name)`, `GetCurrentProfile()`, `GetFromCurrentProfile(field)`, `SetToCurrentProfile(field, data)`, `GetOption/SetOption`.

### 2.2 Profile fields (in `profile.profiles[current]`) that the shell code reads/writes
`Name`, `options` (the complete options table), `LastScenario`, `LastColor`, `LastFaction`, `LoadingFaction`, `UserKeyMap`, `UserDebugKeyMap`, `campaign`, `layout`, `skin`, `console_alpha`, `last_faction`, plus the lobby prefs `Lobby_Team_Spawn`, `Lobby_Team_Lock`, `Lobby_Gen_Cap`, `Lobby_Gen_Fog`, `Lobby_Gen_Victory`, `Lobby_Gen_Timeouts`, `Lobby_Gen_GameSpeed`, `Lobby_Gen_CheatsEnabled`, `Lobby_Gen_Civilians`, `Lobby_Prebuilt_Units`, `Lobby_NoRushOption` (the **index** in `values`).

### 2.3 Options-Dialog (`lua/options/options.lua` + `optionsLogic.lua`)
- `optionsOrder = { "gameplay", "ui", "video", "sound" }`.
- Item scheme: `{title, tip, key, default, restart?, verify?, type='toggle'|'slider'|'button', custom={states={{text,key},…}} | {min,max,inc}, set=function(key,value,startup)}`.
- Important Keys: **gameplay** `wheel_sensitivity`, `strat_icons_always_on`, `uvd_format`, `econ_warnings`, `display_eta`, `mp_taunt_head_enabled`, `screen_edge_pans_main_view`, `arrow_keys_pan_main_view`, `keyboard_pan_speed`, `keyboard_pan_accelerate_multiplier`, `keyboard_rotate_speed`, `keyboard_rotate_accelerate_multiplier`, `accept_build_templates`; **ui** `subtitles`, `world_border`, `tooltips`, `tooltip_delay`, `quick_exit`, `lock_fullscreen_cursor_to_window`, `mainmenu_bgmovie`, `show_attached_unit_lifebars`, `skin_change_on_start`; **video** `primary_adapter`/`secondary_adapter` (`'W,H,Hz'` or `'windowed'`), `fidelity_presets` (Low/Medium/High/Ultra/Custom), `render_skydome`, `fidelity`, `shadow_quality`, `antialiasing` (0/2/4/8/16), `texture_level` (0=High…2=Low), `level_of_detail`, `vsync`, `bloom_render`; **sound** `master_volume`, `fx_volume`, `music_volume`, `vo_volume`.
- `set` functions execute console commands: `SC_PrimaryAdapter`, `SC_SecondaryAdapter`, `SC_AntiAliasingSamples`, `SC_VerticalSync`, `SC_CameraScaleLOD`, `SC_ToggleCursorClip`, `ren_bloom`, `ren_Skydome`, `ren_MipSkipLevels`, `ren_Oblivion`, `graphics_Fidelity`, `shadow_Fidelity`, `cam_ZoomAmount`, `ui_*` (Pan/Rotate/ScreenEdge/ArrowKeys/AlwaysRenderStrategicIcons).
- Logic: `GetCurrent()` fills missing keys with `default` and saves; `SetCurrent(newOptions)` collects `restart`/`verify` items (restart dialog → `ExitApplication()`), then calls `item.set(...)` and `Prefs.SetToCurrentProfile('options', …)` + `SavePreferences()`; `Apply(startup)` at startup.

### 2.4 Keybindings
- `lua/keymap/defaultKeyMap.lua`: `defaultKeyMap` (key combination → action name) and `debugKeyMap`. Modifier prefixes `Ctrl-`, `Shift-`, `Alt-` (order Ctrl-Shift-Alt), separator `-`.
  Excerpt: Esc=escape, Pause=pause, F1=toggle_key_bindings, F2=toggle_score_screen, F3=quick_save, F4=toggle_diplomacy_screen, F5–F8=ping_*, F10=toggle_main_menu, F11=toggle_disconnect_screen; 1–0 = group1…group0, Ctrl-N = set_groupN, Shift-N = append_groupN, Ctrl-Shift-N = fac_groupN; Ctrl-A/S/L = select_air/naval/land, Ctrl-Z = select_all_units_of_same_type, Ctrl-B = select_engineers, Comma = goto_commander, Period = cycle_engineers, Ctrl-X = select_all, Ctrl-C = select_all_onscreen, H = select_nearest_factory; Q/W = zoom_in/out, Shift-Q/W = fast, T = track_unit, V = reset_camera, Tab = next_cam_position; Orders: R=repair, E=reclaim, P=patrol, A=attack, C=capture, S=stop, D=dive, F=ferry, I=guard, U=transport, L=launch_tactical, O=overcharge, M=move, N=nuke (each shift variant = shift_*); B = toggle_build_mode, Z = pause_unit, Ctrl-K = suicide, NumMinus/NumPlus/NumStar = game speed, NumSlash = show_fps.
- `lua/keymap/keyactions.lua` (22 KB): Action name → `action` (console command string) + `category` + `order`. Two types: real engine commands (`UI_ApplySelectionSet 1`, `UI_SelectByCategory +nearest COMMAND`, `StartCommandMode order RULEUCC_Move`, `WLD_ResetSimRate`, `UI_RotateLayout +`, …) and `UI_Lua import("…").Fn()`.
- `lua/keymap/keymapper.lua`: `GetCurrentKeyMap() = GetUserKeyMap() or GetDefaultKeyMap()`; `SetUserKeyMapping(key, oldKey, action)` → Prefs `UserKeyMap`. Debug keys only if `DebugFacilitiesEnabled()`.
- Key names: `mohodata:lua/keymap/keyNames.lua` + `properKeyNames.lua`.

---

## 3. Victory Conditions & Spielende

### 3.1 `lua/victory.lua` (3.3 KB — full logic)
```
CheckVictory(scenarioInfo):
  categoryCheck =
     'demoralization' -> categories.COMMAND                                (Lobby: "Assassination")
     'domination'     -> categories.STRUCTURE + categories.ENGINEER - categories.WALL   ("Supremacy")
     'eradication'    -> categories.ALLUNITS - categories.WALL             ("Annihilation")
     sonst (sandbox)  -> return   (kein Check, Spiel endet nie)
  loop alle 3 s:
     für jeden nicht-besiegten, nicht-zivilen Brain:
        brain:GetCurrentUnits(categoryCheck) == 0  ->  brain:OnDefeat(); CallEndGame(false, true)
        sonst -> stillAlive
     stillAlive leer            -> CallEndGame(true,false)  (Draw)
     alle stillAlive gegenseitig verbündet UND alle RequestingAlliedVictory
        -> nach 15 s stabil: brain:OnVictory() für alle; CallEndGame(true,true)
     alle OfferingDraw          -> brain:OnDraw(); CallEndGame(true,true)
CallEndGame(callEndGame, submitXMLStats):
  submitXMLStats -> SubmitXMLArmyStats()
  callEndGame    -> gameOver=true; ForkThread(WaitSeconds(3); EndGame())
```
Aufruf: **`schook/lua/simInit.lua` Z. 27** `ForkThread(import('/lua/victory.lua').CheckVictory, ScenarioInfo)` in BeginSession.

Optionswerte ↔ Lobby-Labels (lobbyOptions.lua): `demoralization`=Assassination (Default), `domination`=Supremacy, `eradication`=Annihilation, `sandbox`=Sandbox.

### 3.2 Sim-Seite (aibrain.lua)
- `OnDefeat`: `SetArmyOutOfGame(idx)`, `table.insert(Sync.GameResult, {idx, "defeat"})`, `SimUtils.UpdateUnitCap()`, `SimPing.OnArmyDefeat(idx)`, `ForkThread(KillArmy)`.
- `OnVictory`: `table.insert(Sync.GameResult, {idx, "victory"})`. `OnDraw` analog.
- `IsDefeated()` = `ArmyIsOutOfGame(idx)`.
- Score-Sync: `CollectCurrentScores` + `SyncCurrentScores` (1 Hz → `Sync.Score`), UI: `ui/game/score.lua` + `scoreaccum.lua`.

### 3.3 UI-Seite
- `schook/lua/UserSync.lua`: `for k,gameResult in Sync.GameResult do … GpgNetSend('GameResult',…); import('/lua/ui/game/gameresult.lua').DoGameResult(armyIndex, result) end`.
- `lua/ui/game/gameresult.lua DoGameResult(armyIndex, result)` (2.5 KB): own army index → ​​if necessary `SetFocusArmy(-1)` (if observation is allowed), sound `UI_END_Game_Victory` / `UI_END_Game_Fail`, `tabs.OnGameOver()`, `tabs.TabAnnouncement('main', "Victory!"/"You have been defeated!"/"It's a draw.")`, `tabs.AddModeText("<LOC _Score>", → score.CreateDialog(victory))`. Foreign Army Index → ​​`score.ArmyAnnounce(armyIndex, "%s wins!/%s has been defeated!")`.
- **Score-Screen**: `lua/ui/dialogs/score.lua` (50 KB) `CreateDialog(victory, showCampaign, operationVictoryTable, midGame)` → `CreateSkirmishScreen(...)`.
- Engine ruft zusätzlich `uimain.NoteGameOver()` → `SetFocusArmy(-1)`, Cursor zeigen, Ansage "Game over.".
- In-game menu (`lua/ui/game/tabs.lua`, 34 KB): tabs `menu` / `diplomacy` / `pause`; Menu actions `Save`, `Load`, `Options`, `RestartGame` (→ `RestartSession()`), `EndSPGame`/`EndMPGame` (→ `EndGame()` → Score dialog), `ExitSPGame`/`ExitMPGame` (→ `ExitApplication()`), `Return`. `CanUserPause()` checks `Options.Timeouts` (MP only).

---

## 4. Skirmish-KI

### 4.1 Auswahl & Einstieg
- Lobby-Auswahl: `lua/ui/lobby/aitypes.lua` → keys `easy`, `medium`, `adaptive`, `rush`, `turtle`, `tech`, `random` + Cheat-Varianten `adaptivecheat`, `rushcheat`, `turtlecheat`, `techcheat`, `randomcheat`. Landet in `PlayerOptions[slot].AIPersonality` → `ScenarioInfo.ArmySetup[armyName].AIPersonality`.
- `aibrain.AIBrain.OnCreateAI(planName)` (Z. 356):
  - `self.SkirmishSystems = true`
  - Suffix `cheat` found → `AIUtils.SetupCheat(self, true)` and personality shortened to the prefix
  - `self.CurrentPlan = self.AIPlansList[self:GetFactionIndex()][1]` — `lua/aibrainPlans.lua` delivers `'/lua/AI/aiarchetype-managerloader.lua'` for **all 4 factions**
  - `self.EvaluateThread = ForkThread(EvaluateAIThread)`, `self.ExecuteThread = ForkThread(ExecuteAIThread)`
- `ScenarioUtilities.InitializeArmies` → `brain:InitializeSkirmishSystems()` (aibrain.lua Z. 1106):
  ArmyPool Platoon AI off, `BuilderHandles`, `BrainConditionsMonitor`, EconomyMonitor (`EconomyTicksMonitor=50`), `NumBases=1`, `AddBuilderManagers(GetStartVector3f(), 100, 'MAIN', false)`, `BaseMonitorInitialization()`, `ArmyPool:ForkThread(BaseManagersDistressAI)`, `PickEnemy` thread.

### 4.2 Plan-Ausführung (`lua/AI/aiarchetype-managerloader.lua`, 3,6 KB — kompletter „Plan")
```
GetHighestBuilder(aiBrain): iteriert globale BaseBuilderTemplates; jedes hat FirstBaseFunction(aiBrain) -> (score, type); höchster Score gewinnt
ExecutePlan(aiBrain): SetResourceSharing(true), Under-Energy/Mass-StatTrigger(0.1),
  SetupMainBase -> AIAddBuilderTable.AddGlobalBaseTemplate(aiBrain,'MAIN',base); aiBrain:ForceManagerSort()
  ArmyPool-Units auf EngineerManager / FactoryManager verteilen
  ForkThread(UnitCapWatchThread)  -- killt bei Unit-Cap-Nähe T1-PowerGens bzw. T1-PD
```
`FirstBaseFunction` gating (examples): `NormalMain` → `per=='easy'` ⇒ 150 otherwise 1; `ChallengeMain` → `per=='medium'` ⇒ 150 otherwise 1; `RushMainLand/Air/Naval/Balanced`, `TurtleMain`, `TechMain` → high score with matching personality, `'adaptive'` ⇒ random score (`Random(1,100)` etc.). This means that the “difficulty” (easy/medium) is simply a different base template, not a multiplier.

### 4.3 Structure/size of the AI-Lua
| Bereich | Umfang |
| --- | --- |
| `lua/AI/**` total | **2.02 MB, 89 files** |
| `lua/AI/AIBaseTemplates/*.lua` | 22 Templates (NormalMain, ChallengeMain, RushMain{Land,Air,Naval,Balanced}, TurtleMain, TechMain, + Expansions) |
| `lua/AI/AIBuilders/*.lua` | AIEconomicBuilders 80 KB, AIEconomyUpgradeBuilders 52 KB, AIDefenseBuilders 50 KB, AILandAttackBuilders 37 KB, AIAirAttackBuilders 31 KB, AIIntelBuilders 21 KB, AIExpansionBuilders 21 KB, AIExperimentalBuilders 20 KB, AIFactoryConstructionBuilders 18 KB, AINavalBuilders/AISeaAttackBuilders/AIArtilleryBuilders |
| `lua/AI/PlatoonTemplates/*.lua` | Land/Air/Sea/Engineer/Structure |
| `lua/AI/OpAI/**` | Kampagnen-KI (BaseManager 74 KB, BaseManagerPlatoonThreads 52 KB, …) |
| core | `lua/aibrain.lua` 169 KB, `lua/platoon.lua` 131 KB, `lua/aiutilities.lua` 68 KB, `lua/aiattackutilities.lua` 59 KB, `lua/AIBehaviors.lua` 52 KB, `lua/basetemplates.lua` **1.17 MB** (construction layouts!), `lua/platoontemplates.lua` 82 KB |
| Manager | `lua/sim/{BuilderManager, FactoryBuilderManager, EngineerManager, PlatoonFormManager, Builder, BrainConditionsMonitor, StrategyManager}.lua` |
| Conditions | `lua/editor/*BuildConditions.lua` (10 files, 130 KB) |

Bootstrap: `schook/lua/simInit.lua` imports **all** files from `/lua/AI/PlatoonTemplates`, `/lua/AI/AIBuilders`, `/lua/AI/AIBaseTemplates` when the sim starts (they register in global tables via `GlobalBuilderTemplate`/`GlobalBaseTemplate`/`GlobalPlatoonTemplate`).

### 4.4 AI-Cheats (`lua/sim/CheatBuffs.lua`)
`CheatBuildRate`: BuildRate ×2 · `CheatIncome`: EnergyProduction ×2, MassProduction ×2 · `IntelCheat` (COMMAND only): VisionRadius +10000, OmniRadius +10000. Applied in `AIUtils.SetupCheat` to all ArmyPool units.

---

## 5. Kampagne

- **Sequence**: `campaignmanager.campaignSequence = { uef = {X1CA_001…X1CA_006}, cybran = {…}, aeon = {…} }` (FA campaign is identical for all three — player chooses faction). Difficulty: `diffIntToDiffKey = {easy, medium, hard}` (1/2/3).
- **Files per operation** (`maps/X1CA_001/`): `X1CA_001.scmap`, `_scenario.lua` (`type='campaign'`, armies `{Player, Seraphim, Order, UEF, Civilians}`), `_save.lua`, `_script.lua`, `_strings.lua`, `_operation.lua`, multiple `_mXainame.lua` (mission AI per phase), `_in.raw`/`_out.raw`, preview DDS/PNG.
- **`_operation.lua`** exports `operationData = {key, name, long_name, description, opNum, opBriefingText, opMovies, opMap, opDebriefingSuccess, opDebriefingFailure}` — generated via `import('/lua/ui/campaign/operationvars.lua').MakeOpVars(opID, 'X', n)` (string/movie key convention).
- **UI**: `ui/campaign/selectcampaign.lua` (30 KB) → `campaignmanager.LaunchBriefing({opID, campaignID, difficulty})` → `ui/campaign/operationbriefing.lua` (27 KB) → `SinglePlayerLaunch.SetupCampaignSession(scenario, difficulty, faction, campaignFlowInfo)` → `LaunchSinglePlayerSession`.
- **Movies/FMV**: `/movies/*.sfd` (1004 files: character heads like `Brackman.sfd`, `Dostya.sfd`, mission videos `D01.sfd`…, `FMV_SCX_Intro/Outro.sfd`, `main_menu.sfd`, faction loading `UEF_load.sfd`/`aeon_load.sfd`/`cybran_load.sfd`/`seraphim_load.sfd`). No own movies.scd — the .sfd are open in the folder. Assignment: `ui/campaign/campaignmovies.lua` + `campaignmoviedata.lua`; played via `maui/movie.lua` (`Movie(parent, '/movies/x.sfd')`), in-game via `ui/game/missiontext.lua` (`PlayMFDMovie`, `PlayNIS`, `PlayEndGameMovie`) and `ui/game/fmv_timeline.lua`.
- **Sim**: `ScenarioUtilities.InitializeScenarioArmies()` sets `ScenarioInfo.CampaignMode=true`, `Sync.CampaignMode=true`, faction/color/personality from `_save.lua`, `brain:InitializePlatoonBuildManager()` + `LoadArmyPBMBuilders(strArmy)`; Mission logic about `lua/ScenarioFramework.lua` (68 KB), `lua/SimObjectives.lua` (63 KB), `lua/TriggerManager.lua` (60 KB), `lua/ScenarioPlatoonAI.lua` (108 KB), `lua/AI/OpAI/**`.
- **End**: `Sync.OperationComplete` → `campaignmanager.OperationVictory(ovTable)` with `{opKey, campaignID, success, difficulty, allPrimary, allSecondary, factionVideo?}` → Prefs table `campaign[campaignID][opKey][difficulty] = {allPrimary, allSecondary}`, `SetFrontEndData('NextOpBriefing', GetNextOperation(...))`, then score dialog (`score.CreateDialog(success, true, ovTable)`). `InstaWin()` = Debug key Ctrl-Alt-Shift-F8.
- NIS/Cutscenes in the game: `gamemain.NISMode('on'/'off')` — hidden UI, letterbox bar, GameSpeed ​​0, empty selection.

---

## 6. Console commands / cheats (referenced from the UI code)

**Game/Session:** `RestartGame`, `RestartReplay`, `EndSPGame`, `EndMPGame`, `ExitSPGame`, `ExitMPGame`, `Save`, `Load`, `LoadReplay`, `Return`, `Options`, `SetFocusArmy <n>`, `WLD_IncreaseSimRate`, `WLD_DecreaseSimRate`, `WLD_ResetSimRate`, `WLD_GameSpeed`, `WLD_SingleStep`.

**UI/Kamera/Selektion:** `UI_ApplySelectionSet n`, `UI_MakeSelectionSet n`, `UI_SelectByCategory [+nearest|+inview|+idle|+goto|+excludeengineers] <CATS>`, `UI_ExpandCurrentSelection`, `UI_RenderUnitBars`, `UI_NisRenderIcons`, `UI_ToggleGamePanels`, `UI_RotateLayout +/-`, `UI_RotateSkin +/-`, `UI_ShowRenameDialog`, `UI_TrackUnit WorldCamera|MiniMap|CameraHead2`, `UI_Lua <lua>`, `Cam_Free on|off`, `cam_ZoomAmount`, `StartCommandMode order RULEUCC_{Move,Attack,Patrol,Repair,Reclaim,Capture,Guard,Ferry,Transport,Nuke,Tactical}`, `IssueCommand Stop`, `ren_SelectBoxes`, `Dump_Frame`, `CON_ExecuteLastCommand`.

**Grafik (Options-`set`):** `SC_PrimaryAdapter`, `SC_SecondaryAdapter`, `SC_AntiAliasingSamples`, `SC_VerticalSync`, `SC_CameraScaleLOD`, `SC_ToggleCursorClip`, `graphics_Fidelity 0|2`, `shadow_Fidelity`, `ren_bloom`, `ren_Skydome`, `ren_MipSkipLevels`, `ren_Oblivion`, `ui_AlwaysRenderStrategicIcons`, `ui_ScreenEdgeScrollView`, `ui_ArrowKeysScrollView`, `ui_KeyboardPanSpeed`, `ui_KeyboardPanAccelerateMultiplier`, `ui_KeyboardRotateSpeed`, `ui_KeyboardRotateAccelerateMultiplier`.

**Cheats/Debug (only with `DebugFacilitiesEnabled()`; otherwise `uimain.StartFrontEndUI` removes `debugKeyMap` via `IN_RemoveKeyMapTable`):**
- `PopupCreateUnitMenu` (Alt-F2) → `lua/ui/dialogs/createunit.lua` → per unit `ConExecuteSave('CreateUnit <bpid> <armyIndex> <x> <y>')`; Army change in dialogue about `ConExecute('SetFocusArmy '..(army-1))`.
- `TeleportSelectedUnits` (Alt-T), `DestroySelectedUnits` (Alt-Delete), `Nodamage` (Alt-N), `SallyShears` (Ctrl-Alt-Z), `BlingBling` (Ctrl-Alt-B), `AI_RunOpponentAI` (Alt-A), `CopySelectedUnitsToClipboard` / `ExecutePasteBuffer` (Ctrl-Shift-C/V), `SC_CreateEntityDialog` (Shift-F6), `ShowStats` / `ShowStats frame` / `ShowArmyStats`, `WIN_ToggleLogDialog` (F9), `SC_LuaDebugger` (Alt-F9), `ren_ShowWireframe tog`, `Ren_Showskeletons`, `Ren_ShowBoneNames`, `EFX_CreateEmitterWindow`, `dbg navpath|grid|weapons|Collision`, `ScenarioMethod OnF3…OnCtrlAltF5`, `debug_restart_session` (Ctrl-F10).
- In-session gated by lobby option `CheatsEnabled`; Abuse is reported to all clients via `Sync.Cheaters` (UserSync.lua Z. 126).
- Konsole selbst: `lua/ui/dialogs/console.lua` (`uimain.ToggleConsole()`), History-Deque (10), `ConExecute` / `ConExecuteSave`.

---

## 7. Prioritization — what does a playable skirmish need MINIMALLY?

**Level 0 — essential (no match will start without it):**
1. **Scenario Loader**: Load `_scenario.lua` as Lua table (`MapUtil.LoadScenario`) → `{name, description, type, size, map, save, script, norushradius, Configurations.standard.teams[1].armies}`; Run `_save.lua` (Markers, Armies[].Economy/Units, MasterChain markers = starting positions) and `_script.lua`.
2. **Session descriptor** (instead of lobby network): `{ScenarioFile, GameOptions, PlayerOptions[1..N]}` with the fields from §1.3/§2. Launch order: AssignRandomFactions → AssignRandomStartSpots → AssignAINames.
3. **Sim Init Chain**: `SetupSession()` → Generate Brains (`OnCreateArmyBrain` + `ScenarioUtils.InitializeStartLocation` + `SetPlans`) → `BeginSession()` → `OnPopulate()` → `ScenarioUtils.InitializeArmies()` (ACU spawn from `Factions[i].InitialUnit`, economy, alliances) → `CreateResources()` (Mass/Hydro Deposits!) → `CreateProps()`.
4. **GameOptions that actually control sim behavior**: `Victory`, `FogOfWar`, `UnitCap`, `PrebuiltUnits`, `CivilianAlliance`, `TeamSpawn`, `TeamLock`, `GameSpeed`, `NoRushOption`, `RestrictedCategories`.
5. **Victory thread** (`lua/victory.lua`, ~100 lines — trivial to recreate) + `Sync.GameResult` → `gameresult.DoGameResult` → Score dialog. **Sandbox** as default is even enough to initially play without victory logic (SinglePlayerLaunch uses exactly that).
6. **gamemain.CreateUI** + `OnFirstUpdate` (camera zoom on ACU, select ACU) — HUD parts already exist in the project.

**Stufe 1 — „richtiges" Skirmish-Gefühl:**
7. Score-Sync (`aibrain.CollectCurrentScores`/`SyncCurrentScores` 1 Hz → `Sync.Score` → `ui/game/score.lua`).
8. Prefs layer (profile + `options` table + `LastScenario`/`LastColor`/`LastFaction`) — otherwise no persistence of card/faction.
9. Keymap Layer (`defaultKeyMap` + `keyactions` + Console Dispatcher) — Order hotkeys and control groups are essential.
10. Skirmish lobby UI (slots/faction/color/team/options/map selection with `MapPreview` from `scen.preview` or embedded scmap preview).

**Stufe 2 — später:**
11. AI (`aiarchetype-managerloader` + AIBaseTemplates + AIBuilders + basetemplates.lua 1.17 MB) — by far the largest chunk; Until then: opponent = second person or none at all (sandbox).
12. Kampagne (ScenarioFramework/SimObjectives/OpAI + .sfd-Movie-Decoder).
13. Save/Load, Replays, Multiplayer/LobbyComm, Diplomacy, Mod-Manager.

**Explicitly NOT necessary for the first playable skirmish:** LobbyComm/Network (`'None'` protocol is sufficient), Observers/ClosedSlots, Timeouts, Mods, Restricted Units, Taunts, Transmission Log.

## Refs
- gamedata/lua.scd :: lua/ui/game/gamemain.lua (26 KB) — CreateWldUIProvider, CreateUI, OnFirstUpdate, NISMode, HideGameUI, QuickSave
- gamedata/lua.scd :: lua/ui/uimain.lua — SetupUI, StartSplashScreen, StartFrontEndUI, StartHostLobbyUI, StartGameUI, NoteGameOver, EscapeHandler
- gamedata/lua.scd :: lua/ui/menus/main.lua:909 — ButtonSkirmish → lobby.CreateLobby('None',0,…) + lobby.HostGame(name, lastScenario, true)
- gamedata/lua.scd :: lua/ui/lobby/lobby.lua:283 Reset (gameInfo structure), :601 AssignRandomFactions, :612 AssignRandomStartSpots, :648 AssignAINames, :756 TryLaunch, :2872 lobbyComm.Hosting (Default-Options), :2973 SetPlayerOption, :2999 SetGameOption
- gamedata/lua.scd :: lua/ui/lobby/lobbyOptions.lua — teamOptions (TeamSpawn, TeamLock) + globalOpts (UnitCap, FogOfWar, Victory, Timeouts, GameSpeed, CheatsEnabled, CivilianAlliance, PrebuiltUnits, NoRushOption) mit Defaults
- gamedata/lua.scd :: lua/ui/lobby/lobbyComm.lua:29 GetDefaultPlayerOptions, :5 maxPlayerSlots=8
- gamedata/lua.scd :: lua/ui/lobby/aitypes.lua — 12 AI-Keys (easy/medium/adaptive/rush/turtle/tech/random + *cheat)
- gamedata/lua.scd :: lua/SinglePlayerLaunch.lua:53 SetupCampaignSession, :123 defaultOptions, :169 SetupBotSession, :228 SetupCommandLineSkirmish, :297 StartCommandLineSession → LaunchSinglePlayerSession(sessionInfo)
- gamedata/lua.scd :: lua/ui/maputil.lua — LoadScenario, EnumerateSkirmishScenarios, GetStartPositions, GetArmies, GetExtraArmies
- gamedata/lua.scd :: lua/victory.lua:2 CheckVictory (Kategorien + 3-s-Loop + 15-s-Allied-Victory), :89 CallEndGame
- gamedata/lua.scd :: lua/ui/game/gameresult.lua:34 DoGameResult
- gamedata/lua.scd :: lua/ui/dialogs/score.lua:213 CreateDialog, :353 CreateSkirmishScreen (End-Screen)
- gamedata/lua.scd :: lua/ui/game/tabs.lua:61 menus table (Save/Load/Options/RestartGame/EndSPGame/ExitSPGame), :258 EndGame
- gamedata/lua.scd :: lua/aibrain.lua:59 CollectCurrentScores, :356 OnCreateAI, :782 OnDefeat, :797 OnVictory, :1106 InitializeSkirmishSystems
- gamedata/lua.scd :: lua/aibrainPlans.lua — AIPlansList (4× /lua/AI/aiarchetype-managerloader.lua)
- gamedata/lua.scd :: lua/AI/aiarchetype-managerloader.lua — GetHighestBuilder / EvaluatePlan / ExecutePlan / SetupMainBase / UnitCapWatchThread
- gamedata/lua.scd :: lua/AI/AIBaseTemplates/NormalMain.lua:95 FirstBaseFunction (per=='easy' → 150), ChallengeMain.lua:110 ('medium'), RushMainLand/TurtleMain/TechMain analog
- gamedata/lua.scd :: lua/AI/aiutilities.lua:1763 SetupCheat + ApplyCheatBuffs
- gamedata/lua.scd :: lua/sim/CheatBuffs.lua — CheatBuildRate (×2), CheatIncome (×2), IntelCheat (+10000)
- gamedata/lua.scd :: lua/options/options.lua (33 KB, optionsOrder = gameplay/ui/video/sound) + lua/options/optionsLogic.lua (GetCurrent/SetCurrent/Apply/ResetToDefaults)
- gamedata/lua.scd :: lua/keymap/defaultKeyMap.lua (defaultKeyMap + debugKeyMap), lua/keymap/keyactions.lua (Action→Konsolenkommando), lua/keymap/keymapper.lua (UserKeyMap-Override)
- gamedata/lua.scd :: lua/factions.lua — 4 Fraktionen (Key, InitialUnit, DefaultSkin, loadingMovie/-Texture/-Color, Icons)
- gamedata/lua.scd :: lua/ui/campaign/campaignmanager.lua:13 campaignSequence, :167 OperationVictory, :224 LaunchBriefing, :247 InstaWin
- gamedata/lua.scd :: lua/ui/campaign/selectcampaign.lua, operationbriefing.lua, campaignmovies.lua, operationvars.lua
- gamedata/lua.scd :: lua/ui/dialogs/createunit.lua:214 → ConExecuteSave('CreateUnit <bpid> <army> <x> <y>'), :305 ConExecute('SetFocusArmy n')
- gamedata/lua.scd :: lua/ui/dialogs/console.lua, lua/ui/dialogs/mapselect.lua:154 ShowMapPositions/:294 MapPreview, lua/ui/controls/mappreview.lua
- gamedata/lua.scd :: lua/SimCallbacks.lua — Sim callbacks from the UI (BreakAlliance, GiveUnitsToPlayer, RequestAlliedVictory, SetOfferDraw, DiplomacyHandler, FactionSelection, ToggleSelfDestruct)
- gamedata/mohodata.scd :: lua/simInit.lua — init order, SetupSession, OnCreateArmyBrain, BeginSession (Teams, RestrictedCategories)
- gamedata/mohodata.scd :: lua/userInit.lua, lua/user/prefs.lua (Profile-API), lua/GameColors.lua (10 PlayerColors)
- gamedata/mohodata.scd :: lua/sim/ScenarioUtilities.lua:331 CreateInitialArmyGroup, :358 CreateProps, :371 CreateResources, :436 InitializeArmies, :514 InitializeScenarioArmies, :1026 InitializeStartLocation, :1035 SetPlans
- gamedata/schook.scd :: schook/lua/simInit.lua:16 BeginSession-Hook (CreateProps/CreateResources, Score-Threads, ForkThread(victory.CheckVictory)), :53 lädt AI/PlatoonTemplates+AIBuilders+AIBaseTemplates
- gamedata/schook.scd :: schook/lua/UserSync.lua:94 Sync.GameResult → gameresult.DoGameResult, :122 Sync.OperationComplete → OperationVictory, :126 Sync.Cheaters
- maps/SCMP_009/SCMP_009_scenario.lua + _script.lua — Skirmish scenario format (type='skirmish', Configurations.standard.teams FFA, ExtraArmies) and minimal map script
- maps/X1CA_001/ — Campaign op structure (_operation.lua, _script.lua, _strings.lua, _mXai.lua, .scmap, previews)
- C:\Users\Marti\AppData\Local\Gas Powered Games\Supreme Commander Forged Alliance\Game.prefs — serialized Lua table (profile{current,profiles[]}, options_overrides, Options.Log/Debug, CPUBenchmark, PreGameData)
- C:\Program Files (x86)\Steam\steamapps\common\Supreme Commander Forged Alliance\movies\ — 1004 .sfd (Briefings, Heads, FMV, main_menu.sfd, <faction>_load.sfd)
