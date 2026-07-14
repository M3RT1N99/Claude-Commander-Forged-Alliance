# Das echte Front-End: Splash, Hauptmenü, Weg in die Session

Wie die Engine das Front-End bootet, was `lua/ui/menus/main.lua` dafür verlangt und was
uns dazu noch fehlt. Ergänzt [engine-api.md](engine-api.md) (Liste aller Bindungen je VM)
und [game-shell.md](game-shell.md); Session-Start selbst ist hier **nicht** Thema — nur
der Übergang.

## 1. Überblick

Es gibt **eine** UI-Lua-VM für die ganze Anwendung. `Moho::USER_GetLuaState`
(Cfile:1368027-1368075) ist ein Singleton (`sUserLuaState`), das beim ersten Aufruf
angelegt wird und `scr_CoreInits` + `scr_UserInits` **einmal** registriert. Splash,
Hauptmenü, Lobby und Spiel-UI laufen alle in **derselben** VM.

Was wechselt, ist nicht die VM, sondern der **UI-Zustand**:

```
UIS_none=0  UIS_splash=1  UIS_frontend=2  UIS_game=3  UIS_lobby=4   (Cfile:1262301-1262311)
```

`GetCurrentUIState()` liefert daraus `'splash'`, `'frontend'` oder `'game'`
(mHelp, Cfile:1265924).

## 2. Die Boot-Kette (mit Belegen)

### 2.1 Der Zustandswechsel: `CUIManager::SetNewLuaState` (@0x84C4E0-ff, Cfile:1273520)

Jeder Wechsel geht durch diese eine Funktion. Sie tut der Reihe nach:

1. Input-Capture-Stack und aktuellen Dragger abräumen (Cfile:1273557-1273564).
2. Alte Root-Frames freigeben, `mState = neuerState` (Cfile:1273600-1273605).
3. `__EngineStats`-Tabelle in die Globals legen (Cfile:1273610).
4. **Pro Head einen `CMauiFrame` erzeugen** (Cfile:1273621) und seine LazyVars setzen:
   `Left=0, Top=0, Width=w, Height=h` (Cfile:1273661-1273666).
   Fehlschlag ⇒ `gpg::Die("CUIManager::Init - unable to create root frame for head %d.")`
5. **`SetupUI()` aus `/lua/ui/uimain.lua` rufen** (`sub_83CD30`, Cfile:1262316-1262345;
   Aufruf Cfile:1273680). Fehlschlag ⇒ `gpg::Die("... unable to start main UI script.")`

**Der Root-Frame existiert also VOR `SetupUI()`** — und `SetupUI()` läuft bei **jedem**
Zustandswechsel neu, nicht nur einmal. Genau darauf zielt der Kommentar in
uimain.lua:22-25 („SetCursor needs to happen anytime this function is called").
`uimain.lua:29` (`if alreadySetup then return end`) schützt nur den Rest.

### 2.2 Die vier Einstiege (alle: `USER_GetLuaState` → `sUIState=…` → `SetNewLuaState` → `SCR_Import('/lua/ui/uimain.lua')[X]()`)

| Engine-Funktion | Adresse / Cfile | ruft in uimain.lua |
|---|---|---|
| `Moho::UI_StartSplashScreens` | 0x83CE20, Cfile:1262357 | `StartSplashScreen` (uimain.lua:41) |
| `Moho::UI_StartFrontEnd` | 0x83D140, Cfile:1262476 | `StartFrontEndUI` (uimain.lua:46) |
| `func_StartHostLobbyUI` / `func_StartJoinLobbyUI` | 0x83CF20 / 0x83D030 | `StartHostLobbyUI` / `StartJoinLobbyUI` (uimain.lua:68/76) |
| `func_StartGameUI` | 0x83D240, Cfile:1262514 | `StartGameUI` (uimain.lua:83) |

Die Lua-Globals `EngineStartSplashScreens()` / `EngineStartFrontEndUI()` sind nur dünne
Wrapper darum (Cfile:1263777-1263805 bzw. 1263827) — mHelp: *„kill current UI and start
splash screens"*.

### 2.3 Anwendungsstart (`main`, Cfile:1373640-1373870)

Reihenfolge der Kommandozeilen-Prüfungen; der letzte Zweig ist der Normalfall:

- `/map <x>` bzw. `/perf` → `func_StartCommandLineSession` (Cfile:1373521) ruft
  `singleplayerlaunch.lua:StartCommandLineSession` (Cfile:1373668, 1373854)
- `/replay <f>` → schreibt `FrontEndData.replay_filename` in die UI-Globals (Cfile:1373686)
- `/joingame`, `/gpgnet`, `/hostgame` → Lobby-Einstiege
- **sonst: `Moho::UI_StartSplashScreens()`** (Cfile:1373865)

Rückweg: `sub_88C9C0` (Cfile:1321251) = `WLD_Teardown()` → `UI_StartFrontEnd()`. Nach
dem Spiel landet man also wieder im Hauptmenü, und weil `SetNewLuaState` die Frames
neu baut, ist der maui-Baum dabei leer.

### 2.4 `uimain.lua` — was danach passiert

- `SetupUI()` (uimain.lua:20-37): `UIUtil.CreateCursor()` + `SetCursor(c)`; einmalig
  Layout aus `Prefs.GetFromCurrentProfile('layout')` (Default `'bottom'`) und
  `UIUtil.SetCurrentSkin(skin or 'uef')`.
- `StartSplashScreen()` (uimain.lua:41-44) → `splash.lua:CreateUI()`.
- `StartFrontEndUI()` (uimain.lua:46-64):
  1. `if not DebugFacilitiesEnabled() then IN_RemoveKeyMapTable(keyMap.debugKeyMap) end`
     — **wird bei uns immer laufen**, weil `DebugFacilitiesEnabled()` false liefert.
  2. `GetFrontEndData('NextOpBriefing')` → Kampagnen-Briefing, sonst
     `import('/lua/ui/menus/main.lua').CreateUI()`.
  3. `GetNumRootFrames() > 1` → `multihead.lua`.

### 2.5 `splash.lua` — und der ehrliche Ausweg

`splash.lua:14-19` spielt vier `.sfd`-Filme (thqlogo, gpglogo, nvidia_logo,
fmv_scx_intro) mit FMOD-Cues. Aber **Zeile 22-25**:

```lua
if GetPreference("movie.nologo") then
    EngineStartFrontEndUI()
    return
end
```

Das ist ein Original-Pfad, kein Trick: gesetzte Preference ⇒ kein Splash. Zweiter
Original-Ausweg: `CMauiMovie::LoadFile` gibt **false** zurück, wenn `/nomovie` auf der
Kommandozeile steht (Cfile:1143020-1143035) — `movie.lua:32-53` fängt das ab
(`local ok = self:InternalSet(filename)`; `else self:OnStopped()`). Ein `Movie`, dessen
`InternalSet` false liefert, ist also **das dokumentierte Engine-Verhalten**, nicht ein
Stub. Damit kann das Hauptmenü ohne SFD-Decoder korrekt laufen.

## 3. `lua/ui/menus/main.lua` — was das Hauptmenü verlangt

`CreateUI()` (main.lua:50-993), der Reihe nach:

| Zeile | Was |
|---|---|
| 52 | `UIUtil.SetCurrentSkin('uef')` |
| 57-62 | ohne `GetPreference("profile.current")` → `dialogs/profile.lua` statt Menü |
| 65-142 | Menü-Tabellen: `menuTop` (Campaign, Skirmish, Multiplayer LAN, …, Options, Exit), `menuExtras`, `menuMultiplayer` |
| 148 | `parent = UIUtil.CreateScreenGroup(GetFrame(0), "Main Menu ScreenGroup")` |
| 151-153, 34-48 | `Prefs.GetOption("mainmenu_bgmovie")` (Default **true**, options.lua:358-371) → `Movie('/movies/main_menu.sfd')`, `Loop(true)`, `Play()` |
| 166-198 | Bitmaps: `/scx_menu/logo/logo.dds`, `border-console-top_bmp.dds`, `border-bot-{left,mid,right}.dds` |
| 172 | `UIUtil.CreateText(border, GetVersion(), 14, UIUtil.bodyFont)` |
| 208-222 | Lauftext (EULA) über `SetNeedsFrameUpdate(true)` + `OnFrame` |
| 231-255 | `PlaySound(Sound{Cue='AMB_Menu_Loop',Bank='AmbientTest'})`, Musik `Sound{Cue='Main_Menu',Bank='Music'}`; `StopSound(handle)` in `StopMusic`/`OnDestroy` |
| 258-295 | `topLevelGroup`, `mainMenuGroup`, sechs Bracket-Bitmaps aus `/scx_menu/main-menu/` |
| 297-327 | `menuBracketMiddle.Animate` — Einfahr-Animation über `OnFrame` + `PlaySound('X_Main_Menu_On_Start')` |
| 341-820 | `MenuBuild(menuTable)`: Titel-Bitmap `/menus/main03/panel-top_bmp.dds` + Text, Profil-Button, dann **je Eintrag** `UIUtil.CreateButtonStd(mainMenuGroup, '/scx_menu/large-no-bracket-btn/large', v.name, 22, 2, 0, "UI_Menu_MouseDown", "UI_Menu_Rollover")` (543), `btn:UseAlphaHitTest(false)` (555), Glow-Bitmap + `EffectHelpers.FadeIn/FadeOut` (567-590), `Tooltip.AddButtonTooltip` (593) |
| 990-992 | `MenuBuild('home', true)` und `FlushEvents()` |

Importe von main.lua: `uiutil`, `layouthelpers`, `effecthelpers`, `bitmap`, `menucommon`,
`multilinetext`, `button`, `group`, `prefs`, `ui/game/tooltip`, `maputil`, `ui/help/tooltips`,
`movie`, `mods` (main.lua:9-22).

**Achtung, Import-Nebenwirkung:** `effecthelpers.lua:28` ruft auf **Modulebene**
`UIUtil.CreateScreenGroup(GetFrame(0), "Effect Helper ScreenGroup")`. Ohne Root-Frame
knallt schon der Import.

## 4. Fehlende Engine-Bindungen

Alle aus `scr_UserInits` (engine-api.md), alle heute in
[ui-globals-missing.lua](../../src/engine-lua/ui-globals-missing.lua) → sie werfen beim Aufruf.

### 4.1 Für Hauptmenü **zwingend**

| Name | Semantik (Decomp) | Beleg | gebraucht von |
|---|---|---|---|
| `EngineStartFrontEndUI` | UI abräumen, `sUIState=UIS_frontend`, `uimain.StartFrontEndUI()` | Cfile:1263827, 1262476 | splash.lua:23/51 |
| `EngineStartSplashScreens` | dito für `UIS_splash`, `uimain.StartSplashScreen()` | Cfile:1263790, 1262357 | Boot |
| `GetFrontEndData` / `SetFrontEndData` | lesen/schreiben in die **UI-Global-Tabelle `FrontEndData`** | Cfile:1268794 / 1268715; Tabellenzugriff 1268831 / 1268751 | uimain.lua:56 |
| `IN_RemoveKeyMapTable` | „removes the keys from the key map" | Cfile:1260010 | uimain.lua:52 |
| `StopSound(handle,[immediate=false])` | Handle stoppen | Cfile:1348237 | main.lua:242/249 |
| `PlaySound` **muss ein Handle liefern** | heute `nil` → `StopSound` bekäme nichts | Cfile:1348174 (`StartSound(handle)`) | main.lua:231/236 |
| `FlushEvents()` | „flush mouse/keyboard events" | Cfile:1274594 | main.lua:992 |
| `ExitApplication` | „request that the application shut down" | Cfile:1263877 | main.lua:980 |
| `InternalCreateMovie(luaobj,parent)` | + `moho.movie_methods`: `InternalSet`, `Play`, `Stop`, `Loop`, `IsLoaded`, `GetFrameRate`, `GetNumFrames`; LazyVars **`MovieWidth`/`MovieHeight`** | Cfile:1143258; LazyVars 1142984-1142985; `LoadFile`→false bei `/nomovie` 1143020-1143035 | main.lua:35, splash.lua:32 |
| `GetVersion()` | Core-Global, `"GetVersion() -> string"` | Cfile:599401 | main.lua:172 — heute **erfunden** (`'CFA'`) |

### 4.2 Für Splash zusätzlich

| Name | Semantik | Beleg |
|---|---|---|
| `GetCursor()` | liefert das Cursor-Objekt (CMauiCursor, 5 Methoden) | Cfile:1274426; splash.lua:27/52 |
| `AddInputCapture(control)` | „set a control as the current capture" | Cfile:1147871; splash.lua:30 |
| `RemoveInputCapture(control)` | „remove … (always first from back)" | Cfile:1147921; splash.lua:49 |
| `AnyInputCapture` / `GetInputCapture` | Stack abfragen | Cfile:1147773 / 1147818 |
| `SoundIsPrepared(handle)`, `StartSound`, `PlayVoice(params,duck)` | Movie wartet in `movie.lua:37-49` darauf | Cfile:1348102 / 1348174 / 1348652 |

### 4.3 Für Untermenüs (später)

`InternalCreateItemList` (Cfile:1140074), `InternalCreateEdit` (1133710),
`InternalCreateScrollbar` (1144735), `InternalCreateMapPreview` (1276475),
`InternalCreateLobby` (1168970, Klasse `CLobby` mit 18 Methoden),
`InternalCreateDiscoveryService` (1168381), `GetAntiAliasingOptions`,
`GetVolume`/`SetVolume` (options.lua:700-807), `OpenURL`, `GetSpecialFile*`.

**Nicht in der Decomp:** `IsSignedInToSteam()` (main.lua:900) taucht in
`scr_UserInits` **nicht** auf → siehe offene Fragen.

## 5. Ist-Stand unserer Engine

**Da:** [maui.lua](../../src/engine-lua/maui.lua) — `InternalCreateFrame/Group/Bitmap/Text/Border`,
die sieben LazyVars, `DoInit→OnInit`, Hit-Test, Event-Pump (`__mauiMouse`, `__mauiWheel`,
Parent-Bubbling wie Cfile:1124525), Frame-Pumpe (`__mauiFrame`), Snapshot für den Renderer.
[moho.lua](../../src/engine-lua/moho.lua) — `control_methods` (25), `bitmap_methods` (18,
inkl. `UseAlphaHitTest`), `text_methods`, `frame_methods`, `cursor_methods`.
[ui-globals.lua](../../src/engine-lua/ui-globals.lua) — `GetPreference`/`SetPreference`/
`SavePreferences`/`GetOptions` (in-memory + localStorage), `GetFrame`/`GetNumRootFrames`,
`_c_CreateCursor`/`SetCursor`, `PlaySound` (nur Protokoll), `ConExecute`,
`DebugFacilitiesEnabled`, `HasCommandLineArg`.
[uiEngine.ts](../../src/lua/uiEngine.ts) — `installUiEngine()`, `setupUi()` (ruft
das echte `uimain.SetupUI()`), `createRootFrame()`, `setupGameUi()`.

**Fehlt / ist falsch:**

1. **Es gibt keinen Front-End-Boot.** [gameUi.ts](../../src/ui/gameUi.ts):106-116 springt
   direkt in `setupGameUi()`. Kein `StartSplashScreen`, kein `StartFrontEndUI`, kein `main.lua`.
2. **Reihenfolge verdreht:** gameUi.ts:106-107 ruft `setupUi()` **vor** `createRootFrame()`.
   Die Engine macht es umgekehrt (Root-Frame Cfile:1273621-1273666, dann SetupUI
   Cfile:1273680). Solange nur `SetupUI` läuft, fällt es nicht auf; `effecthelpers.lua:28`
   (Modulebene, `GetFrame(0)`) würde es sofort zerreißen.
3. **`GetVersion()` liefert `'CFA'`** — eine erfundene Zahl im Produktivpfad
   (ui-globals.lua:654). Sie steht sichtbar im Hauptmenü (main.lua:172).
4. **`PlaySound` gibt kein Handle zurück**, `StopSound`/`StartSound`/`SoundIsPrepared`
   fehlen ganz → jede Musik-/Movie-Steuerung ist tot.
5. **Kein `moho.movie_methods`.** Der Auto-Vivifier in moho.lua liefert dafür eine **leere
   Klasse**; `movie.lua:32` (`self:InternalSet(...)`) knallt dann mit „attempt to call a nil
   value" — laut, aber weit weg von der Ursache.
6. **Kein Input-Capture, kein Keymap, kein `FlushEvents`.**
7. **Der maui-Renderer kennt keinen `movie`-Kind** (`draws()` in maui.lua:225-235 kennt nur
   `bitmap`/`text`).

## 6. Bau-Reihenfolge (kleinste ehrlich testbare Schritte)

**Schritt 1 — Front-End-Boot ohne Splash, ohne Movie.**
`createRootFrame()` **vor** `setupUi()` ziehen; `startFrontEnd(host)` in `uiEngine.ts`
(Gegenstück zu `setupGameUi`), das `import('/lua/ui/uimain.lua').StartFrontEndUI()` ruft.
Dazu die Minimal-Globals: `EngineStartFrontEndUI`, `EngineStartSplashScreens`,
`FrontEndData = {}` + `Get/SetFrontEndData`, `GetCurrentUIState`, `IN_AddKeyMapTable`/
`IN_RemoveKeyMapTable`/`IN_ClearKeyMap`, `FlushEvents`, `ExitApplication`, echtes
`GetVersion()` (aus der Installation, nicht erfunden).
Damit `main.lua` ohne Film startet: `Prefs.SetOption('mainmenu_bgmovie', false)` — der
Original-Weg (options.lua:358-371), kein Sonderfall im Code.
*Verifikation:* `scripts/verify-frontend.ts` — UI-VM booten, `StartFrontEndUI()`, dann
`__mauiSnapshot()`: es muss `logo.dds`, `border-console-top_bmp.dds` und **genau so viele
`large_btn_up.dds`-Bitmaps geben, wie `menuTop` Einträge hat** (main.lua:104-142).

**Schritt 2 — Audio-Handles (ohne Ausgabe).**
`PlaySound` liefert ein Handle-Objekt (Tabelle mit Bank/Cue/State); `StartSound`,
`StopSound`, `SoundIsPrepared`, `PauseSound`, `PlayVoice`, `PauseVoice`, `GetVolume`,
`SetVolume` arbeiten darauf. Keine Ausgabe erfinden — nur den Zustand führen, wie bisher
protokollieren.
*Verifikation:* `__uiSoundsRequested` enthält nach `CreateUI()` `AMB_Menu_Loop` und
`Main_Menu`; nach `parent:Destroy()` ist bei beiden Handles `stopped = true`.

**Schritt 3 — Menü bedienbar.**
Maus-Events über `__mauiMouse` (steht schon) an die Buttons; `Tooltip`, `EffectHelpers`
laufen dann von selbst. `AddInputCapture`/`RemoveInputCapture`/`GetInputCapture`/
`AnyInputCapture` als echter Stack (Cfile:1147871/1147921).
*Verifikation (Browser, `?frontend`):* Klick auf „Options" baut `dialogs/options.lua`;
Klick auf „Skirmish" muss mit **genau einer** Meldung scheitern:
`InternalCreateLobby: … noch nicht implementiert` (lobbycomm.lua:121). Das ist der
ehrliche Beweis, dass die Kette bis zur Lobby läuft.

**Schritt 4 — Movie-Control.**
`InternalCreateMovie` + `moho.movie_methods` + LazyVars `MovieWidth`/`MovieHeight`.
`InternalSet` liefert zunächst **false** — exakt das `/nomovie`-Verhalten
(Cfile:1143020-1143035), also `OnStopped()`. Damit sind `mainmenu_bgmovie=true` und
`splash.lua` lauffähig, ohne dass ein einziger Frame gerendert wird oder eine Zahl
erfunden wäre. SFD-Decoder ist ein eigenes Thema.

**Schritt 5 — Splash.**
`GetCursor()` + Input-Capture; `movie.nologo`-Preference als Abkürzung bleibt bestehen.

**Schritt 6 — Der Übergang in die Session.**
Zwei Original-Wege, die Skirmish-Taste ist der **teurere**:

- **Lobby** (main.lua:909-922): `lobby.CreateLobby('None', 0, playerName, nil, nil,
  topLevelGroup, cb)` + `lobby.HostGame(name, scenarioFileName, true)`. Braucht
  `InternalCreateLobby` (lobbycomm.lua:121) und die Klasse `CLobby` (18 Methoden); der
  Start läuft dann über `CLobby::LaunchGame` (Cfile:1170898) — eine große Engine-Funktion
  (LaunchInfoNew, ClientManager, NetConnector).
- **`LaunchSinglePlayerSession(sessionInfo)`** (Cfile:1321744): mHelp *„launch a new single
  player session."*, Rumpf = `WLD_SetupSessionInfo(luaTable)` → `WLD_BeginSession(...)`
  (Cfile:1321776-1321782); wirft, wenn schon eine Session läuft. Genau diesen Weg nehmen
  Kampagne (main.lua:864), Tutorial und
  `singleplayerlaunch.lua:StartCommandLineSession` (297-324 → `SetupCommandLineSkirmish`,
  228-294 → `LaunchSinglePlayerSession`, 323).

**Empfehlung:** zuerst `LaunchSinglePlayerSession` + `StartCommandLineSession` bedienen —
das ist ein echter, in der Engine verdrahteter Einstieg (`/map`, Cfile:1373668), erzeugt
`sessionInfo` (teamInfo, Fraktionen, Farben, scenarioMods) komplett aus der Original-Lua
und braucht **keine** Lobby. Die Skirmish-Taste kommt danach.

## 7. Offene Fragen

1. **`IsSignedInToSteam()`** (main.lua:900, `ButtonMatchmaking`) steht **nicht** in
   `scr_UserInits` (engine-api.md, 200 Globals). Die `lua.scd` des Nutzers ist also aus
   einem anderen Build als `Cfile/ForgedAlliance.exe.c`. Betrifft nur den
   Matchmaking-Knopf — aber: gibt es weitere solche Divergenzen im Front-End?
2. **`GetVersion()`** — woher kommt der String? Core-Global (Cfile:599401), aber die
   Quelle (Ressource? `version.lua`?) ist ungeprüft. Bis dahin darf er nicht erfunden werden.
3. **`FrontEndData`** wird von der Engine in die Globals gelegt (Cfile:1268751) — an welcher
   Stelle wird die Tabelle **angelegt**? (Bei `/replay` wird sie ohne vorheriges Create
   beschrieben, Cfile:1373686.)
4. **`func_StartGameUI`** bekommt einen `LuaState*` als Argument (Cfile:1262514) — ist das
   immer `USER_GetLuaState()`, oder gibt es für die Spiel-UI doch einen zweiten State?
   Für uns heute irrelevant (eine UI-VM), aber die Annahme sollte belegt sein.
5. **`_head_test` / Multihead** (`GetNumRootFrames() > 1`, uimain.lua:61) — wir haben genau
   einen Frame. Bleibt das so?
6. **SFD-Format** (`/movies/*.sfd`) — ungeprüft. Solange `InternalSet` ehrlich false
   liefert, blockiert es nichts.
