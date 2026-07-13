# agent3

## Summary
Der Spiel-Rahmen von SupCom:FA ist fast vollständig in Lua abgebildet und liegt in `lua.scd` (UI/Lobby/Menü/AI) + `mohodata.scd` (Boot-/Session-Init, Prefs, ScenarioUtilities) + `schook.scd` (Hooks, u.a. der Victory-Thread). Der Skirmish-Start läuft: Splash → `uimain.StartFrontEndUI` → `ui/menus/main.lua` → `lobby.CreateLobby('None',0,…)` + `lobby.HostGame(name, scenarioFile, singlePlayer=true)` → `TryLaunch` → `lobbyComm:LaunchGame(gameInfo)`; danach Engine-Session mit Sim-Init (`simInit.SetupSession/BeginSession`) und UI-Init (`gamemain.CreateWldUIProvider`). Victory-Bedingungen sind nur ~100 Zeilen (`lua/victory.lua`), Optionen/Prefs sind Lua-Tabellen (`lobbyOptions.lua`, `options/options.lua`, Game.prefs als serialisierte Lua-Tabelle). Für einen minimal spielbaren Skirmish braucht es: ScenarioFile-Loader, GameOptions/PlayerOptions-Struktur, Army-Spawn (`ScenarioUtilities.InitializeArmies`), Victory-Thread, Score/GameResult-Sync — die Lobby-UI selbst ist ersetzbar (SinglePlayerLaunch.lua zeigt den minimalen Weg ohne Lobby).

## Key Facts
- Skirmish-Start ist Single-Player-Hosting: main.lua ButtonSkirmish ruft lobby.CreateLobby('None', 0, playerName, …) + lobby.HostGame(name, lastScenario, inSinglePlayer=true) — Protokoll 'None' = lokal, kein Netzwerk.
- Das Launch-Objekt ist `gameInfo = { GameOptions={}, PlayerOptions={}, Observers={}, ClosedSlots={}, GameMods={} }` (lobby.lua Reset) und geht per `lobbyComm:LaunchGame(gameInfo)` an die Engine; der Lobby-freie Pfad `LaunchSinglePlayerSession(sessionInfo)` (SinglePlayerLaunch.lua) nutzt `{playerName, createReplay, scenarioInfo(+Options), teamInfo[], scenarioMods, RandomSeed}`.
- Sim-Init-Reihenfolge (mohodata/lua/simInit.lua Kommentar): __blueprints → simInit.lua → ScenarioInfo gesetzt → SetupSession() (lädt _save.lua + _script.lua) → Armies/Brains erzeugt (OnCreateArmyBrain → InitializeArmyAI) → BeginSession() (OnPopulate/OnStart des Map-Scripts, Teams/Allianzen, Build-Restrictions).
- Der Map-Script für Skirmish ist minimal: `OnPopulate() ScenarioUtils.InitializeArmies() end; OnStart(self) end` — die gesamte Army-/ACU-/Resource-Erzeugung steckt in mohodata `lua/sim/ScenarioUtilities.lua`.
- Victory: `lua/victory.lua CheckVictory(scenarioInfo)` wird von `schook/lua/simInit.lua` in BeginSession geforkt; Kategorien: demoralization=COMMAND, domination=STRUCTURE+ENGINEER-WALL, eradication=ALLUNITS-WALL, sandbox=kein Check; Poll alle 3 s, Sieg braucht 15 s stabile Allied-Victory-Lage.
- Spielende-Fluss: brain:OnDefeat/OnVictory → `Sync.GameResult` → UserSync → `ui/game/gameresult.lua DoGameResult(armyIndex, result)` → Sound + Tab-Announcement + Score-Button → `ui/dialogs/score.lua CreateDialog(victory)`; Engine ruft zusätzlich `NoteGameOver()` in uimain.lua.
- GameOptions-Defaults kommen aus `lua/ui/lobby/lobbyOptions.lua` (teamOptions + globalOpts), gemischt mit Prefs: TeamSpawn=random, TeamLock=locked, UnitCap=500, FogOfWar=explored, Victory=demoralization(Assassination), Timeouts=3, GameSpeed=normal, CheatsEnabled=false, CivilianAlliance=enemy, PrebuiltUnits=Off, NoRushOption=Off.
- PlayerOptions pro Slot (lobbyComm.GetDefaultPlayerOptions): {Team=1, PlayerColor=1, ArmyColor=1, StartSpot=1, Ready=false, Faction=5 (=NumFactions+1 → random), PlayerName, AIPersonality='', Human=true, Civilian=false} + OwnerID; maxPlayerSlots=8.
- Game.prefs ist eine serialisierte Lua-Tabelle (kein INI) unter %LOCALAPPDATA%\Gas Powered Games\Supreme Commander Forged Alliance\Game.prefs mit Top-Level-Keys profile{current,profiles[]}, options_overrides, Options.Log/Debug, CPUBenchmark, PreGameData; Zugriff via Engine-Globals GetPreference/SetPreference/SavePreferences, gewrappt in mohodata `lua/user/prefs.lua`.
- Grafik-/Sound-/Gameplay-Optionen: `lua/options/options.lua` (4 Tabs: gameplay, ui, video, sound), jedes Item {key, default, type=toggle|slider|button, custom.states[], set=fn→ConExecute}; Logik in `lua/options/optionsLogic.lua` (GetCurrent/SetCurrent/Apply/ResetToDefaults).
- Keybindings: `lua/keymap/defaultKeyMap.lua` (Key→Action-Name, plus separate debugKeyMap), `lua/keymap/keyactions.lua` (Action-Name→Konsolenkommando bzw. `UI_Lua import(...)`), `lua/keymap/keymapper.lua` (UserKeyMap aus Prefs überschreibt Default).
- Skirmish-KI: ScenarioInfo.ArmySetup[name].AIPersonality (aitypes.lua: easy/medium/adaptive/rush/turtle/tech/random + *cheat); aibrain.OnCreateAI setzt CurrentPlan = AIPlansList[faction][1] = '/lua/AI/aiarchetype-managerloader.lua' (für ALLE 4 Fraktionen identisch) und forkt EvaluateAIThread/ExecuteAIThread.
- AI-Bootstrap: `ScenarioUtilities.InitializeArmies` ruft `brain:InitializeSkirmishSystems()` → BuilderManagers['MAIN'] (Position = StartVector, Radius 100) mit Factory-/Engineer-/PlatoonForm-Manager, ConditionsMonitor, EconomyMonitor, BaseMonitor, PickEnemy-Thread; `aiarchetype-managerloader.ExecutePlan` wählt via `FirstBaseFunction(aiBrain)` das höchstbewertete Template aus `lua/AI/AIBaseTemplates/*.lua`.
- AI-Cheats: Personality-Suffix 'cheat' → `AIUtils.SetupCheat` → Buffs aus `lua/sim/CheatBuffs.lua`: CheatBuildRate (BuildRate ×2), CheatIncome (Mass+Energy Production ×2), IntelCheat (Vision/Omni +10000, nur ACU).
- AI-Umfang: lua/AI = 2,02 MB in 89 Dateien; dazu aibrain.lua 169 KB, platoon.lua 131 KB, AIBehaviors 52 KB, aiattackutilities 59 KB, aiutilities 68 KB — schook/simInit lädt beim Sim-Boot alle Dateien aus /lua/AI/PlatoonTemplates, /lua/AI/AIBuilders, /lua/AI/AIBaseTemplates per DiskFindFiles.
- Kampagne: `campaignmanager.campaignSequence` = {uef|cybran|aeon → X1CA_001…X1CA_006}; pro Op `maps/<opID>/<opID>_operation.lua` (exportiert `operationData` via `operationvars.MakeOpVars(opID,'X',n)`); Briefings/FMV sind .sfd-Movies in /movies (1004 Dateien); Fortschritt liegt in Prefs unter 'campaign' [campaignID][opKey][difficulty] = {allPrimary, allSecondary}.
- Kampagne im Sim: `ScenarioUtilities.InitializeScenarioArmies()` (statt InitializeArmies) setzt Sync.CampaignMode, Fraktion/Farbe/Personality aus dem _save.lua, lädt PBM-Builder; Objectives über SimObjectives.lua → Sync.ObjectivesTable → ui/game/objectives2.lua; Ende über Sync.OperationComplete → campaignmanager.OperationVictory.
- Cheat-/Debug-Kommandos (nur bei DebugFacilitiesEnabled(); uimain.StartFrontEndUI entfernt sonst die debugKeyMap): PopupCreateUnitMenu (Alt-F2 → createunit.lua → `ConExecuteSave('CreateUnit <bpid> <army> <x> <y>')`), SetFocusArmy <n>, TeleportSelectedUnits, DestroySelectedUnits, Nodamage, SallyShears, BlingBling, AI_RunOpponentAI, WLD_SingleStep, ShowArmyStats, ren_ShowWireframe, dbg navpath|grid|weapons|Collision.
- Fraktionen (lua/factions.lua, Index = Array-Position): 1 uef/uel0001, 2 aeon/ual0001, 3 cybran/url0001, 4 seraphim/xsl0001 — inkl. loadingMovie/-Texture/-Color, DefaultSkin und Icon-Pfaden; Faction-Index 5 in PlayerOptions = 'random', wird erst beim Launch (AssignRandomFactions) aufgelöst.
- Spieler-/Armee-Farben: mohodata `lua/GameColors.lua` — 10 PlayerColors/ArmyColors (FFe80a0a, DarkGreen, FF131cd3, Goldenrod, FFA7A7A7, Darkslategray, FF202020, FF4d0505, FF2E8B57, BlueViolet), CivilianArmyColor='BurlyWood'.

## Details
## 1. Spielstart-Fluss (Original)

### 1.1 Boot / Front-End
| Schritt | Datei | Was passiert |
| --- | --- | --- |
| Lua-User-State init | `mohodata:lua/userInit.lua` | `__language` aus Prefs, `globalInit.lua`, `WaitSeconds` über Frames, globales `FrontEndData = {}` |
| UI-Setup | `lua/ui/uimain.lua` `SetupUI()` | Cursor, `UIUtil.currentLayout` aus Prefs (`layout`, Default `'bottom'`), `UIUtil.SetCurrentSkin(prefs.skin or 'uef')` |
| Splash | `uimain.StartSplashScreen()` → `lua/ui/splash/splash.lua` | |
| Front-End | `uimain.StartFrontEndUI()` | entfernt debugKeyMap wenn `not DebugFacilitiesEnabled()`; wenn `GetFrontEndData('NextOpBriefing')` gesetzt → direkt Kampagnen-Briefing, sonst `ui/menus/main.lua CreateUI()` |
| Hauptmenü | `lua/ui/menus/main.lua` | Falls kein Profil (`GetPreference("profile.current")` nil) → Profil-Dialog zuerst. Menüpunkte: Campaign / Skirmish / Multiplayer LAN / Matchmaking / Extras / Options / Exit. Hintergrund: `/movies/main_menu.sfd` (per Option `mainmenu_bgmovie` abschaltbar) |

**Skirmish-Button (main.lua ~909):**
```
lobby.CreateLobby('None', 0, playerName, nil, nil, topLevelGroup, exitBehavior)
lobby.HostGame(playerName .. "'s Skirmish", scenarioFileName, true)   -- inSinglePlayer=true
```
`scenarioFileName = Prefs.GetFromCurrentProfile('LastScenario') or UIUtil.defaultScenario` (= `/maps/scmp_039/scmp_039_scenario.lua`).

### 1.2 Lobby (`lua/ui/lobby/lobby.lua`, 115 KB)
- `Reset()` erzeugt `gameInfo = { GameOptions={}, PlayerOptions={}, Observers={}, ClosedSlots={}, GameMods={} }`.
- `lobbyComm.Hosting` (Z. 2872): Slot 1 = lokaler Spieler (`GetDefaultPlayerOptions`, `PlayerColor/ArmyColor` aus Pref `LastColor`, `Faction` aus Pref `LastFaction`, sonst `#Factions+1` = random). Danach **Default-GameOptions**: für jede Option in `teamOpts` und `globalOpts`: `SetGameOption(option.key, option.values[ Prefs[option.pref] or option.default ].key)`. Dann `SetGameOption('ScenarioFile', desiredScenario)`.
- Slot-Verwaltung: `HostTryAddPlayer`, `HostRemoveAI`, `HostOpenSlot`/`HostCloseSlot`, `SetSlotInfo`, `UpdateAvailableSlots(numAvailStartSpots)` — Slots über der Armee-Anzahl der Karte werden gesperrt. `LobbyComm.maxPlayerSlots = 8`.
- Slot-Menü (`GetSlotMenuTables`): open/close slot, KI hinzufügen (aus `aitypes.lua`), Farbe/Fraktion/Team setzen.
- Kartenwahl: `ui/dialogs/mapselect.lua CreateDialog(...)` → auf OK: `SetGameOption('ScenarioFile', selectedScenario.file)`, `SetGameOption('RestrictedCategories', restrictedCategories, true)`, plus geänderte Optionen in Prefs.
- **Launch (`TryLaunch`, Z. 756):** Validierung → mind. 1 Spieler; wenn `Victory != 'sandbox'`: mind. 2 Spieler ODER >1 Team; mind. 1 Mensch oder Observer. Dann `LaunchGame()`:
  1. `AssignRandomFactions(gameInfo)` — Faction ≥ #Factions+1 → `math.random(1,4)`
  2. `AssignRandomStartSpots(gameInfo)` — nur wenn `GameOptions.TeamSpawn == 'random'`: Fisher-Yates-artiger Tausch der PlayerOptions über die Anzahl Start-Spots (geschlossene Slots übersprungen)
  3. `AssignAINames(gameInfo)` — Name aus `ui/lobby/aiNames.lua[factionKey]`, Ergebnis `"<AIName> (<Personality>)"`
  4. `lobbyComm:LaunchGame(gameInfo)` (Engine-Native)

  Im Single-Player wird sofort gelauncht, im MP erst nach 5-s-Countdown.

### 1.3 Lobby-freier Pfad (wichtig für einen minimalen Nachbau)
`lua/SinglePlayerLaunch.lua` zeigt die **kleinste** Session-Erzeugung — kein Lobby-UI nötig:
```
sessionInfo = {
  playerName, createReplay=false,
  scenarioInfo = MapUtil.LoadScenario(mapPath),      -- + .Options = GameOptions
  teamInfo = { [1..N] = PlayerOptions },             -- GetDefaultPlayerOptions()-Form
  scenarioMods, RandomSeed
}
LaunchSinglePlayerSession(sessionInfo)               -- Engine-Native
```
Default-Options dort (`defaultOptions`, Z. 123): FogOfWar=explored, NoRushOption=Off, PrebuiltUnits=Off, Difficulty=2, DoNotShareUnitCap=true, Timeouts=-1, GameSpeed=normal, UnitCap='500', Victory='sandbox', CheatsEnabled='true', CivilianAlliance='enemy'.
Zusätzlich: `MapUtil.GetExtraArmies(scenarioInfo)` → Civilian-Armeen (`Civilian=true, Human=false`).
`FixupMapName(name)` → `/maps/<n>/<n>_scenario.lua`.

### 1.4 Session-Init im Sim (`mohodata:lua/simInit.lua` + `schook/lua/simInit.lua`)
1. `__blueprints` aus vorgeladenen Daten
2. `simInit.lua` läuft (globalInit, SimSync)
3. `ScenarioInfo` von der Engine gefüllt (Felder aus `_scenario.lua` + `Options` aus GameOptions + `ArmySetup` aus PlayerOptions)
4. **`SetupSession()`**: `ArmyBrains={}`, ScenarioInfo.{PlatoonHandles, UnitGroups, UnitNames, VarTable, BuilderTable, MapData}, `ScenarioInfo.Env = import('/lua/scenarioEnvironment.lua')`, dann `doscript(ScenarioInfo.save)` → globales `Scenario`, `doscript(ScenarioInfo.script)`; schook ergänzt `ScenarioInfo.TriggerManager`.
5. Engine erzeugt Armeen/Brains → **`OnCreateArmyBrain(index, brain, name, nickname)`**: `ArmyBrains[index]=brain`, `InitializeArmyAI(name)`; schook-Hook ruft vorher `ScenarioUtils.InitializeStartLocation(name)` und `ScenarioUtils.SetPlans(name)`.
6. **`BeginSession()`**: schook zuerst `ScenarioUtils.CreateProps()` + `CreateResources()` (Mass-/Hydro-Deposits + Splats aus Markern), dann Basis-BeginSession:
   - `ScenarioInfo.Env.OnPopulate(ScenarioInfo)` → Map-Script → `ScenarioUtils.InitializeArmies()`
   - `ScenarioInfo.Env.OnStart(ScenarioInfo)`
   - Teams aus `ScenarioInfo.ArmySetup[*].Team > 1` → `SetAlliance(a,b,"Ally")` + `brain.RequestingAlliedVictory = true`
   - `TeamLock == 'locked'` → `ScenarioInfo.TeamGame = true`, `Sync.LockTeams = true`
   - `Options.RestrictedCategories` → Kategorien aus `ui/lobby/restrictedUnitsData.lua` → `AddBuildRestriction(index, cats)` für alle Armeen
   - Effect-Marker instanziieren
   - schook danach: `ForkThread(aibrain.CollectCurrentScores)`, `ForkThread(aibrain.SyncCurrentScores)` (1 Hz), `ForkThread(victory.CheckVictory, ScenarioInfo)`

**`ScenarioUtilities.InitializeArmies()`** (Skirmish):
- pro Armee `SetArmyEconomy(strArmy, tblData.Economy.mass, tblData.Economy.energy)` (aus _save.lua)
- `if brain.SkirmishSystems then brain:InitializeSkirmishSystems() end`
- `CreateInitialArmyGroup(strArmy, createCommander)`: falls Map keine INITIAL-Gruppe hat → `CreateInitialArmyUnit(strArmy, Factions[factionIndex].InitialUnit)`; bei `PrebuiltUnits == 'Off'` → ACU `HideBone(0,true)` + nach 3 s `PlayCommanderWarpInEffect()` (der Warp-In-Effekt)
- ACU bekommt `SetCustomName(brain.Nickname)`
- WRECKAGE-Gruppe → Wracks
- Allianzen: default alle Enemy; `CivilianAlliance == 'neutral'` → Civ neutral; `'removed'` → keine Civ-Units; Armee `NEUTRAL_CIVILIAN` immer neutral

### 1.5 Session-Init in der UI (`lua/ui/game/gamemain.lua`, 26 KB)
`uimain.StartGameUI()` → `gamemain.CreateWldUIProvider()` setzt einen `WldUIProvider` mit Callbacks, die die Engine ruft:
- `StartLoadingDialog` → Faction-Loading-Movie (`factions[LoadingFaction].loadingMovie`, z. B. `/movies/UEF_load.sfd`) + "IN TRANSIT"-Text; `supressExitDialog=true`
- `CreateGameInterface(isReplay)` → `CreateUI(isReplay)`
- `StopLoadingDialog` → Faction-Loading-Bitmap ausblenden, danach `InitialAnimations()` (tabs → economy/score → multifunction/avatars/controlgroups)
- `DestroyGameInterface`, `GetPrefetchTextures`, `Start/StopWaitingDialog`

`CreateUI()` baut in dieser Reihenfolge: `borders.SetupBorderControl` (liefert controlCluster/statusCluster/mapGroup/windowGroup) → worldview → economy-Bar → tabs → multifunction → orders → construction → unitview(+Detail) → avatars → controlgroups → transmissionlog → helptext → timer → consoleecho → build_templates → taunt → chat → minimap → (campaign: objectives2).

`OnFirstUpdate()` (erster Frame des controlClusterGroup): `EnableWorldSounds()`, ACU-Name setzen, `StartPeaceMusic()`, `score.CreateScoreUI()` (nicht im Campaign-Mode), nach 1,5 s `UIZoomTo(avatars,1)`, nach weiteren 1,5 s `SelectUnits(avatars)` + `worldview.UnlockInput()`; optional Skin auf Fraktions-Skin (`Prefs 'skin_change_on_start' != 'no'`).

Engine-Callbacks in gamemain: `OnSelectionChanged`, `OnQueueChanged`, `OnBeat`, `OnPause/OnResume/OnUserPause`, `NISMode`, `ReceiveChat`, `QuickSave`.

---

## 2. Spieloptionen / Prefs

### 2.1 Game.prefs
- Ort: `%LOCALAPPDATA%\Gas Powered Games\Supreme Commander Forged Alliance\Game.prefs` (+ `Game.prefs.save`); im Test 929 KB.
- **Format = serialisierte Lua-Tabelle** (Text, `key = value`-Syntax, Strings in `'…'`), nicht INI. Top-Level-Keys: `PreGameData` (CurrentMapDir, IconReplacements), `mods_expanded`, `Options` (Log.{Info,Warn,Debug,Custom,Error,Filter}, Debug.{Files,Breakpoints}), `CPUBenchmark`, `options_overrides` (überschreibt `default`/`custom` einzelner Options-Items — z. B. die erkannten Auflösungen), `profile` (siehe unten).
- Engine-API: `GetPreference(path, default)`, `SetPreference(path, val)`, `SavePreferences()`; Pfade sind punktiert (`'options_overrides.language'`).
- Wrapper: `mohodata:lua/user/prefs.lua` — `ProfilesExist`, `CreateProfile(name)`, `GetCurrentProfile()`, `GetFromCurrentProfile(field)`, `SetToCurrentProfile(field, data)`, `GetOption/SetOption`.

### 2.2 Profil-Felder (in `profile.profiles[current]`), die der Shell-Code liest/schreibt
`Name`, `options` (die komplette Options-Tabelle), `LastScenario`, `LastColor`, `LastFaction`, `LoadingFaction`, `UserKeyMap`, `UserDebugKeyMap`, `campaign`, `layout`, `skin`, `console_alpha`, `last_faction`, plus die Lobby-Prefs `Lobby_Team_Spawn`, `Lobby_Team_Lock`, `Lobby_Gen_Cap`, `Lobby_Gen_Fog`, `Lobby_Gen_Victory`, `Lobby_Gen_Timeouts`, `Lobby_Gen_GameSpeed`, `Lobby_Gen_CheatsEnabled`, `Lobby_Gen_Civilians`, `Lobby_Prebuilt_Units`, `Lobby_NoRushOption` (jeweils der **Index** in `values`).

### 2.3 Options-Dialog (`lua/options/options.lua` + `optionsLogic.lua`)
- `optionsOrder = { "gameplay", "ui", "video", "sound" }`.
- Item-Schema: `{title, tip, key, default, restart?, verify?, type='toggle'|'slider'|'button', custom={states={{text,key},…}} | {min,max,inc}, set=function(key,value,startup)}`.
- Wichtige Keys: **gameplay** `wheel_sensitivity`, `strat_icons_always_on`, `uvd_format`, `econ_warnings`, `display_eta`, `mp_taunt_head_enabled`, `screen_edge_pans_main_view`, `arrow_keys_pan_main_view`, `keyboard_pan_speed`, `keyboard_pan_accelerate_multiplier`, `keyboard_rotate_speed`, `keyboard_rotate_accelerate_multiplier`, `accept_build_templates`; **ui** `subtitles`, `world_border`, `tooltips`, `tooltip_delay`, `quick_exit`, `lock_fullscreen_cursor_to_window`, `mainmenu_bgmovie`, `show_attached_unit_lifebars`, `skin_change_on_start`; **video** `primary_adapter`/`secondary_adapter` (`'W,H,Hz'` oder `'windowed'`), `fidelity_presets` (Low/Medium/High/Ultra/Custom), `render_skydome`, `fidelity`, `shadow_quality`, `antialiasing` (0/2/4/8/16), `texture_level` (0=High…2=Low), `level_of_detail`, `vsync`, `bloom_render`; **sound** `master_volume`, `fx_volume`, `music_volume`, `vo_volume`.
- `set`-Funktionen führen Konsolenkommandos aus: `SC_PrimaryAdapter`, `SC_SecondaryAdapter`, `SC_AntiAliasingSamples`, `SC_VerticalSync`, `SC_CameraScaleLOD`, `SC_ToggleCursorClip`, `ren_bloom`, `ren_Skydome`, `ren_MipSkipLevels`, `ren_Oblivion`, `graphics_Fidelity`, `shadow_Fidelity`, `cam_ZoomAmount`, `ui_*` (Pan/Rotate/ScreenEdge/ArrowKeys/AlwaysRenderStrategicIcons).
- Logik: `GetCurrent()` füllt fehlende Keys mit `default` und speichert; `SetCurrent(newOptions)` sammelt `restart`-/`verify`-Items (Restart-Dialog → `ExitApplication()`), ruft dann `item.set(...)` und `Prefs.SetToCurrentProfile('options', …)` + `SavePreferences()`; `Apply(startup)` beim Start.

### 2.4 Keybindings
- `lua/keymap/defaultKeyMap.lua`: `defaultKeyMap` (Key-Kombi → Action-Name) und `debugKeyMap`. Modifier-Präfixe `Ctrl-`, `Shift-`, `Alt-` (Reihenfolge Ctrl-Shift-Alt), Trennzeichen `-`.
  Auszug: Esc=escape, Pause=pause, F1=toggle_key_bindings, F2=toggle_score_screen, F3=quick_save, F4=toggle_diplomacy_screen, F5–F8=ping_*, F10=toggle_main_menu, F11=toggle_disconnect_screen; 1–0 = group1…group0, Ctrl-N = set_groupN, Shift-N = append_groupN, Ctrl-Shift-N = fac_groupN; Ctrl-A/S/L = select_air/naval/land, Ctrl-Z = select_all_units_of_same_type, Ctrl-B = select_engineers, Comma = goto_commander, Period = cycle_engineers, Ctrl-X = select_all, Ctrl-C = select_all_onscreen, H = select_nearest_factory; Q/W = zoom_in/out, Shift-Q/W = fast, T = track_unit, V = reset_camera, Tab = next_cam_position; Orders: R=repair, E=reclaim, P=patrol, A=attack, C=capture, S=stop, D=dive, F=ferry, I=guard, U=transport, L=launch_tactical, O=overcharge, M=move, N=nuke (jeweils Shift-Variante = shift_*); B = toggle_build_mode, Z = pause_unit, Ctrl-K = suicide, NumMinus/NumPlus/NumStar = game speed, NumSlash = show_fps.
- `lua/keymap/keyactions.lua` (22 KB): Action-Name → `action` (Konsolenkommando-String) + `category` + `order`. Zwei Sorten: echte Engine-Kommandos (`UI_ApplySelectionSet 1`, `UI_SelectByCategory +nearest COMMAND`, `StartCommandMode order RULEUCC_Move`, `WLD_ResetSimRate`, `UI_RotateLayout +`, …) und `UI_Lua import("…").Fn()`.
- `lua/keymap/keymapper.lua`: `GetCurrentKeyMap() = GetUserKeyMap() or GetDefaultKeyMap()`; `SetUserKeyMapping(key, oldKey, action)` → Prefs `UserKeyMap`. Debug-Keys nur wenn `DebugFacilitiesEnabled()`.
- Key-Namen: `mohodata:lua/keymap/keyNames.lua` + `properKeyNames.lua`.

---

## 3. Victory Conditions & Spielende

### 3.1 `lua/victory.lua` (3,3 KB — vollständige Logik)
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
- `lua/ui/game/gameresult.lua DoGameResult(armyIndex, result)` (2,5 KB): eigener Army-Index → ggf. `SetFocusArmy(-1)` (wenn Observing erlaubt), Sound `UI_END_Game_Victory` / `UI_END_Game_Fail`, `tabs.OnGameOver()`, `tabs.TabAnnouncement('main', "Victory!"/"You have been defeated!"/"It's a draw.")`, `tabs.AddModeText("<LOC _Score>", → score.CreateDialog(victory))`. Fremder Army-Index → `score.ArmyAnnounce(armyIndex, "%s wins!/%s has been defeated!")`.
- **Score-Screen**: `lua/ui/dialogs/score.lua` (50 KB) `CreateDialog(victory, showCampaign, operationVictoryTable, midGame)` → `CreateSkirmishScreen(...)`.
- Engine ruft zusätzlich `uimain.NoteGameOver()` → `SetFocusArmy(-1)`, Cursor zeigen, Ansage "Game over.".
- In-Game-Menü (`lua/ui/game/tabs.lua`, 34 KB): Tabs `menu` / `diplomacy` / `pause`; Menü-Aktionen `Save`, `Load`, `Options`, `RestartGame` (→ `RestartSession()`), `EndSPGame`/`EndMPGame` (→ `EndGame()` → Score-Dialog), `ExitSPGame`/`ExitMPGame` (→ `ExitApplication()`), `Return`. `CanUserPause()` prüft `Options.Timeouts` (nur MP).

---

## 4. Skirmish-KI

### 4.1 Auswahl & Einstieg
- Lobby-Auswahl: `lua/ui/lobby/aitypes.lua` → keys `easy`, `medium`, `adaptive`, `rush`, `turtle`, `tech`, `random` + Cheat-Varianten `adaptivecheat`, `rushcheat`, `turtlecheat`, `techcheat`, `randomcheat`. Landet in `PlayerOptions[slot].AIPersonality` → `ScenarioInfo.ArmySetup[armyName].AIPersonality`.
- `aibrain.AIBrain.OnCreateAI(planName)` (Z. 356):
  - `self.SkirmishSystems = true`
  - Suffix `cheat` gefunden → `AIUtils.SetupCheat(self, true)` und Personality auf den Präfix gekürzt
  - `self.CurrentPlan = self.AIPlansList[self:GetFactionIndex()][1]` — `lua/aibrainPlans.lua` liefert für **alle 4 Fraktionen** `'/lua/AI/aiarchetype-managerloader.lua'`
  - `self.EvaluateThread = ForkThread(EvaluateAIThread)`, `self.ExecuteThread = ForkThread(ExecuteAIThread)`
- `ScenarioUtilities.InitializeArmies` → `brain:InitializeSkirmishSystems()` (aibrain.lua Z. 1106):
  ArmyPool-Platoon-AI aus, `BuilderHandles`, `BrainConditionsMonitor`, EconomyMonitor (`EconomyTicksMonitor=50`), `NumBases=1`, `AddBuilderManagers(GetStartVector3f(), 100, 'MAIN', false)`, `BaseMonitorInitialization()`, `ArmyPool:ForkThread(BaseManagersDistressAI)`, `PickEnemy`-Thread.

### 4.2 Plan-Ausführung (`lua/AI/aiarchetype-managerloader.lua`, 3,6 KB — kompletter „Plan")
```
GetHighestBuilder(aiBrain): iteriert globale BaseBuilderTemplates; jedes hat FirstBaseFunction(aiBrain) -> (score, type); höchster Score gewinnt
ExecutePlan(aiBrain): SetResourceSharing(true), Under-Energy/Mass-StatTrigger(0.1),
  SetupMainBase -> AIAddBuilderTable.AddGlobalBaseTemplate(aiBrain,'MAIN',base); aiBrain:ForceManagerSort()
  ArmyPool-Units auf EngineerManager / FactoryManager verteilen
  ForkThread(UnitCapWatchThread)  -- killt bei Unit-Cap-Nähe T1-PowerGens bzw. T1-PD
```
`FirstBaseFunction`-Gating (Beispiele): `NormalMain` → `per=='easy'` ⇒ 150 sonst 1; `ChallengeMain` → `per=='medium'` ⇒ 150 sonst 1; `RushMainLand/Air/Naval/Balanced`, `TurtleMain`, `TechMain` → hoher Score bei passender Personality, `'adaptive'` ⇒ zufälliger Score (`Random(1,100)` etc.). Damit ist die „Schwierigkeit" (easy/medium) einfach ein anderes Basis-Template, nicht ein Multiplikator.

### 4.3 Struktur/Größe der AI-Lua
| Bereich | Umfang |
| --- | --- |
| `lua/AI/**` gesamt | **2,02 MB, 89 Dateien** |
| `lua/AI/AIBaseTemplates/*.lua` | 22 Templates (NormalMain, ChallengeMain, RushMain{Land,Air,Naval,Balanced}, TurtleMain, TechMain, + Expansions) |
| `lua/AI/AIBuilders/*.lua` | AIEconomicBuilders 80 KB, AIEconomyUpgradeBuilders 52 KB, AIDefenseBuilders 50 KB, AILandAttackBuilders 37 KB, AIAirAttackBuilders 31 KB, AIIntelBuilders 21 KB, AIExpansionBuilders 21 KB, AIExperimentalBuilders 20 KB, AIFactoryConstructionBuilders 18 KB, AINavalBuilders/AISeaAttackBuilders/AIArtilleryBuilders |
| `lua/AI/PlatoonTemplates/*.lua` | Land/Air/Sea/Engineer/Structure |
| `lua/AI/OpAI/**` | Kampagnen-KI (BaseManager 74 KB, BaseManagerPlatoonThreads 52 KB, …) |
| Kern | `lua/aibrain.lua` 169 KB, `lua/platoon.lua` 131 KB, `lua/aiutilities.lua` 68 KB, `lua/aiattackutilities.lua` 59 KB, `lua/AIBehaviors.lua` 52 KB, `lua/basetemplates.lua` **1,17 MB** (Bau-Layouts!), `lua/platoontemplates.lua` 82 KB |
| Manager | `lua/sim/{BuilderManager, FactoryBuilderManager, EngineerManager, PlatoonFormManager, Builder, BrainConditionsMonitor, StrategyManager}.lua` |
| Bedingungen | `lua/editor/*BuildConditions.lua` (10 Dateien, 130 KB) |

Bootstrap: `schook/lua/simInit.lua` importiert beim Sim-Start **alle** Dateien aus `/lua/AI/PlatoonTemplates`, `/lua/AI/AIBuilders`, `/lua/AI/AIBaseTemplates` (die registrieren sich in globalen Tabellen via `GlobalBuilderTemplate`/`GlobalBaseTemplate`/`GlobalPlatoonTemplate`).

### 4.4 AI-Cheats (`lua/sim/CheatBuffs.lua`)
`CheatBuildRate`: BuildRate ×2 · `CheatIncome`: EnergyProduction ×2, MassProduction ×2 · `IntelCheat` (nur COMMAND): VisionRadius +10000, OmniRadius +10000. Angewendet in `AIUtils.SetupCheat` auf alle ArmyPool-Units.

---

## 5. Kampagne

- **Sequenz**: `campaignmanager.campaignSequence = { uef = {X1CA_001…X1CA_006}, cybran = {…}, aeon = {…} }` (FA-Kampagne ist für alle drei identisch — Fraktion wählt der Spieler). Schwierigkeit: `diffIntToDiffKey = {easy, medium, hard}` (1/2/3).
- **Dateien pro Operation** (`maps/X1CA_001/`): `X1CA_001.scmap`, `_scenario.lua` (`type='campaign'`, armies `{Player, Seraphim, Order, UEF, Civilians}`), `_save.lua`, `_script.lua`, `_strings.lua`, `_operation.lua`, mehrere `_mXainame.lua` (Missions-KI pro Phase), `_in.raw`/`_out.raw`, Vorschau-DDS/PNG.
- **`_operation.lua`** exportiert `operationData = {key, name, long_name, description, opNum, opBriefingText, opMovies, opMap, opDebriefingSuccess, opDebriefingFailure}` — erzeugt via `import('/lua/ui/campaign/operationvars.lua').MakeOpVars(opID, 'X', n)` (String-/Movie-Key-Konvention).
- **UI**: `ui/campaign/selectcampaign.lua` (30 KB) → `campaignmanager.LaunchBriefing({opID, campaignID, difficulty})` → `ui/campaign/operationbriefing.lua` (27 KB) → `SinglePlayerLaunch.SetupCampaignSession(scenario, difficulty, faction, campaignFlowInfo)` → `LaunchSinglePlayerSession`.
- **Movies/FMV**: `/movies/*.sfd` (1004 Dateien: Charakter-Heads wie `Brackman.sfd`, `Dostya.sfd`, Missions-Videos `D01.sfd`…, `FMV_SCX_Intro/Outro.sfd`, `main_menu.sfd`, Faction-Loading `UEF_load.sfd`/`aeon_load.sfd`/`cybran_load.sfd`/`seraphim_load.sfd`). Kein eigenes movies.scd — die .sfd liegen offen im Ordner. Zuordnung: `ui/campaign/campaignmovies.lua` + `campaignmoviedata.lua`; abgespielt via `maui/movie.lua` (`Movie(parent, '/movies/x.sfd')`), in-game über `ui/game/missiontext.lua` (`PlayMFDMovie`, `PlayNIS`, `PlayEndGameMovie`) und `ui/game/fmv_timeline.lua`.
- **Sim**: `ScenarioUtilities.InitializeScenarioArmies()` setzt `ScenarioInfo.CampaignMode=true`, `Sync.CampaignMode=true`, Fraktion/Farbe/Personality aus `_save.lua`, `brain:InitializePlatoonBuildManager()` + `LoadArmyPBMBuilders(strArmy)`; Missionslogik über `lua/ScenarioFramework.lua` (68 KB), `lua/SimObjectives.lua` (63 KB), `lua/TriggerManager.lua` (60 KB), `lua/ScenarioPlatoonAI.lua` (108 KB), `lua/AI/OpAI/**`.
- **Ende**: `Sync.OperationComplete` → `campaignmanager.OperationVictory(ovTable)` mit `{opKey, campaignID, success, difficulty, allPrimary, allSecondary, factionVideo?}` → Prefs-Tabelle `campaign[campaignID][opKey][difficulty] = {allPrimary, allSecondary}`, `SetFrontEndData('NextOpBriefing', GetNextOperation(...))`, dann Score-Dialog (`score.CreateDialog(success, true, ovTable)`). `InstaWin()` = Debug-Key Ctrl-Alt-Shift-F8.
- NIS/Cutscenes im Spiel: `gamemain.NISMode('on'/'off')` — versteckt UI, Letterbox-Balken, GameSpeed 0, Selektion leeren.

---

## 6. Konsolen-Kommandos / Cheats (aus dem UI-Code referenziert)

**Spiel/Session:** `RestartGame`, `RestartReplay`, `EndSPGame`, `EndMPGame`, `ExitSPGame`, `ExitMPGame`, `Save`, `Load`, `LoadReplay`, `Return`, `Options`, `SetFocusArmy <n>`, `WLD_IncreaseSimRate`, `WLD_DecreaseSimRate`, `WLD_ResetSimRate`, `WLD_GameSpeed`, `WLD_SingleStep`.

**UI/Kamera/Selektion:** `UI_ApplySelectionSet n`, `UI_MakeSelectionSet n`, `UI_SelectByCategory [+nearest|+inview|+idle|+goto|+excludeengineers] <CATS>`, `UI_ExpandCurrentSelection`, `UI_RenderUnitBars`, `UI_NisRenderIcons`, `UI_ToggleGamePanels`, `UI_RotateLayout +/-`, `UI_RotateSkin +/-`, `UI_ShowRenameDialog`, `UI_TrackUnit WorldCamera|MiniMap|CameraHead2`, `UI_Lua <lua>`, `Cam_Free on|off`, `cam_ZoomAmount`, `StartCommandMode order RULEUCC_{Move,Attack,Patrol,Repair,Reclaim,Capture,Guard,Ferry,Transport,Nuke,Tactical}`, `IssueCommand Stop`, `ren_SelectBoxes`, `Dump_Frame`, `CON_ExecuteLastCommand`.

**Grafik (Options-`set`):** `SC_PrimaryAdapter`, `SC_SecondaryAdapter`, `SC_AntiAliasingSamples`, `SC_VerticalSync`, `SC_CameraScaleLOD`, `SC_ToggleCursorClip`, `graphics_Fidelity 0|2`, `shadow_Fidelity`, `ren_bloom`, `ren_Skydome`, `ren_MipSkipLevels`, `ren_Oblivion`, `ui_AlwaysRenderStrategicIcons`, `ui_ScreenEdgeScrollView`, `ui_ArrowKeysScrollView`, `ui_KeyboardPanSpeed`, `ui_KeyboardPanAccelerateMultiplier`, `ui_KeyboardRotateSpeed`, `ui_KeyboardRotateAccelerateMultiplier`.

**Cheats/Debug (nur bei `DebugFacilitiesEnabled()`; `uimain.StartFrontEndUI` entfernt sonst `debugKeyMap` per `IN_RemoveKeyMapTable`):**
- `PopupCreateUnitMenu` (Alt-F2) → `lua/ui/dialogs/createunit.lua` → pro Einheit `ConExecuteSave('CreateUnit <bpid> <armyIndex> <x> <y>')`; Armee-Wechsel im Dialog über `ConExecute('SetFocusArmy '..(army-1))`.
- `TeleportSelectedUnits` (Alt-T), `DestroySelectedUnits` (Alt-Delete), `Nodamage` (Alt-N), `SallyShears` (Ctrl-Alt-Z), `BlingBling` (Ctrl-Alt-B), `AI_RunOpponentAI` (Alt-A), `CopySelectedUnitsToClipboard` / `ExecutePasteBuffer` (Ctrl-Shift-C/V), `SC_CreateEntityDialog` (Shift-F6), `ShowStats` / `ShowStats frame` / `ShowArmyStats`, `WIN_ToggleLogDialog` (F9), `SC_LuaDebugger` (Alt-F9), `ren_ShowWireframe tog`, `Ren_Showskeletons`, `Ren_ShowBoneNames`, `EFX_CreateEmitterWindow`, `dbg navpath|grid|weapons|Collision`, `ScenarioMethod OnF3…OnCtrlAltF5`, `debug_restart_session` (Ctrl-F10).
- In-Session gated durch Lobby-Option `CheatsEnabled`; Missbrauch wird über `Sync.Cheaters` an alle Clients gemeldet (UserSync.lua Z. 126).
- Konsole selbst: `lua/ui/dialogs/console.lua` (`uimain.ToggleConsole()`), History-Deque (10), `ConExecute` / `ConExecuteSave`.

---

## 7. Priorisierung — was braucht ein spielbarer Skirmish MINIMAL?

**Stufe 0 — unverzichtbar (ohne das startet kein Match):**
1. **Scenario-Loader**: `_scenario.lua` als Lua-Tabelle laden (`MapUtil.LoadScenario`) → `{name, description, type, size, map, save, script, norushradius, Configurations.standard.teams[1].armies}`; `_save.lua` (Markers, Armies[].Economy/Units, MasterChain-Marker = Start-Positionen) und `_script.lua` ausführen.
2. **Session-Descriptor** (statt Lobby-Netzwerk): `{ScenarioFile, GameOptions, PlayerOptions[1..N]}` mit den Feldern aus §1.3/§2. Reihenfolge beim Launch: AssignRandomFactions → AssignRandomStartSpots → AssignAINames.
3. **Sim-Init-Kette**: `SetupSession()` → Brains erzeugen (`OnCreateArmyBrain` + `ScenarioUtils.InitializeStartLocation` + `SetPlans`) → `BeginSession()` → `OnPopulate()` → `ScenarioUtils.InitializeArmies()` (ACU-Spawn aus `Factions[i].InitialUnit`, Economy, Allianzen) → `CreateResources()` (Mass/Hydro-Deposits!) → `CreateProps()`.
4. **GameOptions, die tatsächlich Sim-Verhalten steuern**: `Victory`, `FogOfWar`, `UnitCap`, `PrebuiltUnits`, `CivilianAlliance`, `TeamSpawn`, `TeamLock`, `GameSpeed`, `NoRushOption`, `RestrictedCategories`.
5. **Victory-Thread** (`lua/victory.lua`, ~100 Zeilen — trivial nachzubauen) + `Sync.GameResult` → `gameresult.DoGameResult` → Score-Dialog. **Sandbox** als Default reicht sogar, um erstmal ohne Victory-Logik zu spielen (SinglePlayerLaunch nutzt genau das).
6. **gamemain.CreateUI** + `OnFirstUpdate` (Kamera-Zoom auf ACU, ACU selektieren) — HUD-Teile existieren im Projekt bereits.

**Stufe 1 — „richtiges" Skirmish-Gefühl:**
7. Score-Sync (`aibrain.CollectCurrentScores`/`SyncCurrentScores` 1 Hz → `Sync.Score` → `ui/game/score.lua`).
8. Prefs-Schicht (Profil + `options`-Tabelle + `LastScenario`/`LastColor`/`LastFaction`) — sonst kein Persistieren von Karte/Fraktion.
9. Keymap-Schicht (`defaultKeyMap` + `keyactions` + Konsolen-Dispatcher) — Order-Hotkeys und Control-Groups sind essenziell.
10. Skirmish-Lobby-UI (Slots/Fraktion/Farbe/Team/Optionen/Kartenwahl mit `MapPreview` aus `scen.preview` bzw. eingebettetem scmap-Preview).

**Stufe 2 — später:**
11. KI (`aiarchetype-managerloader` + AIBaseTemplates + AIBuilders + basetemplates.lua 1,17 MB) — der mit Abstand größte Brocken; bis dahin: Gegner = zweiter Mensch oder gar keiner (Sandbox).
12. Kampagne (ScenarioFramework/SimObjectives/OpAI + .sfd-Movie-Decoder).
13. Save/Load, Replays, Multiplayer/LobbyComm, Diplomacy, Mod-Manager.

**Explizit NICHT nötig für den ersten spielbaren Skirmish:** LobbyComm/Netzwerk (Protokoll `'None'` reicht), Observers/ClosedSlots, Timeouts, Mods, Restricted Units, Taunts, Transmission-Log.

## Refs
- gamedata/lua.scd :: lua/ui/game/gamemain.lua (26 KB) — CreateWldUIProvider, CreateUI, OnFirstUpdate, NISMode, HideGameUI, QuickSave
- gamedata/lua.scd :: lua/ui/uimain.lua — SetupUI, StartSplashScreen, StartFrontEndUI, StartHostLobbyUI, StartGameUI, NoteGameOver, EscapeHandler
- gamedata/lua.scd :: lua/ui/menus/main.lua:909 — ButtonSkirmish → lobby.CreateLobby('None',0,…) + lobby.HostGame(name, lastScenario, true)
- gamedata/lua.scd :: lua/ui/lobby/lobby.lua:283 Reset (gameInfo-Struktur), :601 AssignRandomFactions, :612 AssignRandomStartSpots, :648 AssignAINames, :756 TryLaunch, :2872 lobbyComm.Hosting (Default-Options), :2973 SetPlayerOption, :2999 SetGameOption
- gamedata/lua.scd :: lua/ui/lobby/lobbyOptions.lua — teamOptions (TeamSpawn, TeamLock) + globalOpts (UnitCap, FogOfWar, Victory, Timeouts, GameSpeed, CheatsEnabled, CivilianAlliance, PrebuiltUnits, NoRushOption) mit Defaults
- gamedata/lua.scd :: lua/ui/lobby/lobbyComm.lua:29 GetDefaultPlayerOptions, :5 maxPlayerSlots=8
- gamedata/lua.scd :: lua/ui/lobby/aitypes.lua — 12 AI-Keys (easy/medium/adaptive/rush/turtle/tech/random + *cheat)
- gamedata/lua.scd :: lua/SinglePlayerLaunch.lua:53 SetupCampaignSession, :123 defaultOptions, :169 SetupBotSession, :228 SetupCommandLineSkirmish, :297 StartCommandLineSession → LaunchSinglePlayerSession(sessionInfo)
- gamedata/lua.scd :: lua/ui/maputil.lua — LoadScenario, EnumerateSkirmishScenarios, GetStartPositions, GetArmies, GetExtraArmies
- gamedata/lua.scd :: lua/victory.lua:2 CheckVictory (Kategorien + 3-s-Loop + 15-s-Allied-Victory), :89 CallEndGame
- gamedata/lua.scd :: lua/ui/game/gameresult.lua:34 DoGameResult
- gamedata/lua.scd :: lua/ui/dialogs/score.lua:213 CreateDialog, :353 CreateSkirmishScreen (End-Screen)
- gamedata/lua.scd :: lua/ui/game/tabs.lua:61 menus-Tabelle (Save/Load/Options/RestartGame/EndSPGame/ExitSPGame), :258 EndGame
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
- gamedata/lua.scd :: lua/SimCallbacks.lua — Sim-Callbacks aus der UI (BreakAlliance, GiveUnitsToPlayer, RequestAlliedVictory, SetOfferDraw, DiplomacyHandler, FactionSelection, ToggleSelfDestruct)
- gamedata/mohodata.scd :: lua/simInit.lua — Init-Reihenfolge, SetupSession, OnCreateArmyBrain, BeginSession (Teams, RestrictedCategories)
- gamedata/mohodata.scd :: lua/userInit.lua, lua/user/prefs.lua (Profile-API), lua/GameColors.lua (10 PlayerColors)
- gamedata/mohodata.scd :: lua/sim/ScenarioUtilities.lua:331 CreateInitialArmyGroup, :358 CreateProps, :371 CreateResources, :436 InitializeArmies, :514 InitializeScenarioArmies, :1026 InitializeStartLocation, :1035 SetPlans
- gamedata/schook.scd :: schook/lua/simInit.lua:16 BeginSession-Hook (CreateProps/CreateResources, Score-Threads, ForkThread(victory.CheckVictory)), :53 lädt AI/PlatoonTemplates+AIBuilders+AIBaseTemplates
- gamedata/schook.scd :: schook/lua/UserSync.lua:94 Sync.GameResult → gameresult.DoGameResult, :122 Sync.OperationComplete → OperationVictory, :126 Sync.Cheaters
- maps/SCMP_009/SCMP_009_scenario.lua + _script.lua — Skirmish-Scenario-Format (type='skirmish', Configurations.standard.teams FFA, ExtraArmies) und minimaler Map-Script
- maps/X1CA_001/ — Kampagnen-Op-Struktur (_operation.lua, _script.lua, _strings.lua, _mXai.lua, .scmap, Previews)
- C:\Users\Marti\AppData\Local\Gas Powered Games\Supreme Commander Forged Alliance\Game.prefs — serialisierte Lua-Tabelle (profile{current,profiles[]}, options_overrides, Options.Log/Debug, CPUBenchmark, PreGameData)
- C:\Program Files (x86)\Steam\steamapps\common\Supreme Commander Forged Alliance\movies\ — 1004 .sfd (Briefings, Heads, FMV, main_menu.sfd, <faction>_load.sfd)
