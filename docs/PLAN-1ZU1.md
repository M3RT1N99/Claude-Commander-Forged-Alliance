# PLAN-1ZU1 — der Weg zum echten Spiel

Konsolidiert aus sieben Tiefenrecherchen (Juli 2026):
[frontend-menu](research/frontend-menu.md) · [worldview-camera](research/worldview-camera.md) ·
[session-start](research/session-start.md) · [combat-projectiles](research/combat-projectiles.md) ·
[session-ui-panels](research/session-ui-panels.md) · [maui-controls](research/maui-controls.md) ·
[input-cursor-keymap](research/input-cursor-keymap.md).
Jede Behauptung ist belegt (`Cfile:<zeile>` bzw. `<luadatei>:<zeile>`). Nichts geraten;
Ungeklärtes steht als **OFFENE FRAGE**, nicht als Annahme im Fließtext.

## Ziel-Erlebnis

Spielverzeichnis verbinden → das **echte FA-Hauptmenü** aus `lua/ui/menus/main.lua` erscheint
(Logo, Bracket-Animation, Menü-Musik) → **Skirmish** → die Karte lädt sich selbst, die ACU steht
auf ihrem Marker → **die echte Spiel-UI** (`gamemain.CreateUI`) mit Weltansicht, Befehlen, Bau und
Kampf → Spielende → zurück ins Hauptmenü. Alles aus `lua/ui/**` und `lua/sim/**`: kein Web-Menü,
kein TS-HUD, keine nachgebaute Spiellogik.

## Wo wir heute stehen

Die Techdemo läuft (ACU → Bau-Menü → Gebäude aufs Raster → aus der echten Ökonomie bezahlt → die
Fabrik produziert Panzer). Die Session-UI (economy, multifunction, orders, construction, unitview,
unitviewDetail) rendert aus der Original-Lua über `setupGameUi()`
([src/lua/uiEngine.ts](../src/lua/uiEngine.ts)); zwei Lua-VMs, 22 Verify-Suiten grün.
Volle Lochliste: [STATUS.md](STATUS.md). Es fehlt der **Rahmen** (Hauptmenü, Session-Start,
WorldView, Input) und der **Kampf**.

## Abhängigkeiten

```
M1 maui-Lücken ─┬─> M2 Front-End ──> M3 Input ──┬──────────────┐
                │                               │              │
                └─> M9 Controls ────────────────┼──> M11 Lobby (Skirmish-Taste)
                                                │              │
M4 Session-Start ─┬─> M5 Übergang ──────────────┘              │
                  ├─> M6 Sync+Beat ──> M7 WorldView ──> M10 gamemain.CreateUI
                  └─> M8 Kampf   ← sim-only, ab sofort parallel zur ganzen UI-Kette
                                                       M12 Movie/Splash/Audio
```

Die **zwei Nähte** zwischen UI- und Sim-Strang: **M6** (der Sync-Kreislauf) und **M5**
(`LaunchSinglePlayerSession`). Sonst hängen die Stränge nicht aneinander.

---

## M1 — maui-Lücken schließen: Border, Tastatur, Fokus, InputCapture

**Größe: M** · hängt an: — · Recherche: [maui-controls](research/maui-controls.md),
[input-cursor-keymap](research/input-cursor-keymap.md)

**Ziel-Erlebnis:** Nichts Neues zu sehen — aber Panels bekommen ihre echten Rahmen, ein modaler
Dialog schluckt Klicks daneben, und ein Control mit Keyboard-Fokus bekommt Tasten exklusiv.

**Engine-Teile:**

- **`moho.border_methods` (2)**: `SetNewTextures(vertical, horizontal, upperLeft, upperRight,
  lowerLeft, lowerRight)` und `SetSolidColor(color)`; sie setzen dabei die LazyVars
  `BorderWidth`/`BorderHeight` aus den **Texturmaßen** (Cfile:1123156, 1123475; Schreibstellen
  1122728/1122748). Heute liefert der Auto-Vivifier ([moho.lua](../src/engine-lua/moho.lua):530-536)
  eine **leere Klasse** — der Border ist halb gebaut (`InternalCreateBorder` + LazyVars da,
  Methoden nicht), und `border.lua:28` knallt beim ersten Texturwechsel. Dazu `border`-Kind
  (9-Slice) im [mauiRenderer.ts](../src/ui/mauiRenderer.ts) (kennt heute nur `bitmap`/`text`).
- **Tastatur-Events**: `__mauiKey(type, keyCode, rawKeyCode, mods)`. Event-Tabelle **exakt** wie
  `func_CreateLuaEvent` @0x795BD0 (Cfile:1136293-1136348). Enum-Ergänzung: `MouseHover=3`,
  `KeyUp=9`, `KeyDown=10`, `Char=11` (Cfile:1136267-1136288). **`KeyCode` ist ein wx-Code, kein
  VK** (`UIUtil.VK_PAUSE = 310` = `WXK_PAUSE`, uiutil.lua:81); `RawKeyCode` ist der MSW-VK.
- **Routing** (drei identische Dispatcher: `MET_KeyDown` Cfile:1147634, `MET_KeyUp` 1147668,
  `MET_Char` 1147745): Keyboard-Fokus-Control gesetzt ⇒ **nur** dieses bekommt `HandleEvent`
  (liefert es `false`, wird der Capture-Stack **nicht** gefragt, das Event geht als `skipped` an
  die Konsolen-Keymap); sonst Capture-Top; sonst `skipped`.
- **Fokus**: `AcquireKeyboardFocus(bool)` / `AbandonKeyboardFocus()` / `GetCurrentFocusControl()`
  (Cfile:1125768 / 1125828 / 1125718) + `OnLoseKeyboardFocus` (1124572), `OnKeyboardFocusChange`
  (1124577). Ein `ButtonPress` auf ein anderes Control entzieht den Fokus (Cfile:1147523-1147531).
- **InputCapture-Stack** (`std::vector sInputCapture`, Cfile:430346): `AddInputCapture` (1147871),
  `RemoveInputCapture` — *„always first from back"* (1147921), `GetInputCapture` (1147818),
  `AnyInputCapture` (1147773). **Wirkung:** ist der Stack nicht leer, startet der Maus-Hit-Test
  nicht am Root-Frame, sondern bei `back()` (Cfile:1147376-1147390) — *das* ist die Modalität.
- **Der UI-Scheduler ist frame-, nicht tickbasiert.** Die UI-VM benutzt heute den Sim-Scheduler
  ([threads.lua](../src/engine-lua/threads.lua)). Das Original: `WaitFrames = coroutine.yield`,
  `WaitSeconds(n)` pollt `CurrentTime()` (userinit.lua:13-21) — die UI-VM hat **keinen**
  Tick-Scheduler. Daran hängen die Menü-Animationen und der Cursor-Animationsthread
  (cursor.lua:34-43).

**Betroffene Original-Lua:** `lua/maui/border.lua`, `lua/maui/control.lua`,
`lua/ui/uiutil.lua:615-646` (`MakeInputModal` — hängt `RemoveInputCapture` an `OnDestroy` und
prüft `event.Type == 'KeyDown'` auf `VK_ESCAPE`/`VK_ENTER`), `lua/userinit.lua`.

**Verifikation:** `scripts/verify-maui.ts` erweitern. (a) `Border(group):SetTextures(…)` ⇒ 8 Kacheln
im `__mauiSnapshot()`, `BorderWidth()` == Breite der `vertical`-DDS. (b) Zwei Controls, eines mit
Fokus ⇒ nur dieses sieht `KeyDown`; gibt es `false` zurück, sieht es **niemand** sonst.
(c) `UIUtil.MakeInputModal(dialog)` ⇒ Hit-Test außerhalb liefert nichts aus dem Rest des Baums.

---

## M2 — Front-End-Boot: das echte Hauptmenü

**Größe: L** · hängt an: M1 · Recherche: [frontend-menu](research/frontend-menu.md)

**Ziel-Erlebnis:** Nach dem Verbinden des Spielverzeichnisses steht das Original-Hauptmenü da:
Logo, Konsolen-Rahmen, Versionstext, Bracket-Animation, die Knöpfe aus `menuTop` (Campaign,
Skirmish, Multiplayer, …, Options, Exit) mit Glow und Tooltip, dazu Menü-Musik (als Handle geführt,
Ausgabe erst in M12).

**Engine-Teile:**

1. **Reihenfolge geradeziehen.** `CUIManager::SetNewLuaState` (@0x84C4E0) erzeugt **erst** pro Head
   einen `CMauiFrame` samt LazyVars (Cfile:1273621-1273666) und ruft **danach** `SetupUI()` aus
   `/lua/ui/uimain.lua` (Cfile:1273680). Bei uns ist es umgedreht
   ([gameUi.ts](../src/ui/gameUi.ts):106-107: `setupUi()` vor `createRootFrame()`).
   `effecthelpers.lua:28` ruft auf **Modulebene** `UIUtil.CreateScreenGroup(GetFrame(0), …)` —
   der Import von `main.lua` zerreißt sonst sofort. `SetupUI()` läuft bei **jedem**
   Zustandswechsel neu (uimain.lua:22-25); `if alreadySetup then return end` (:29) schützt nur den Rest.
2. **`startFrontEnd(host)`** in [uiEngine.ts](../src/lua/uiEngine.ts) als Gegenstück zu
   `setupGameUi()`: `import('/lua/ui/uimain.lua').StartFrontEndUI()` (uimain.lua:46-64).
   **Es gibt genau eine UI-VM für alles** (`USER_GetLuaState`, Singleton, Cfile:1368027) — was
   wechselt, ist der Zustand: `UIS_none=0, splash=1, frontend=2, game=3, lobby=4`
   (Cfile:1262301-1262311); `GetCurrentUIState()` (1265924) liest borders.lua:101.
3. **Globals** (alle heute in
   [ui-globals-missing.lua](../src/engine-lua/ui-globals-missing.lua), werfen beim Aufruf):
   `EngineStartFrontEndUI` (Cfile:1263827), `EngineStartSplashScreens` (1263790),
   `FrontEndData` + `GetFrontEndData`/`SetFrontEndData` (1268794 / 1268715),
   `IN_RemoveKeyMapTable` (1260010 — uimain.lua:52 läuft bei uns **immer**, weil
   `DebugFacilitiesEnabled()` false liefert), `FlushEvents` (1274594, main.lua:992),
   `ExitApplication` (1263877, main.lua:980), `ClearFrame(head)` (1264066).
4. **Audio-Handles ohne Ausgabe.** `PlaySound` **muss ein Handle liefern** (Cfile:1348174), sonst
   hat `StopSound(handle,[immediate])` (1348237) nichts zu stoppen; dazu `StartSound`,
   `SoundIsPrepared` (1348102), `PauseSound`, `PlayVoice` (1348652). main.lua:231-249 startet
   `Sound{Cue='AMB_Menu_Loop', Bank='AmbientTest'}` und `Sound{Cue='Main_Menu', Bank='Music'}` und
   stoppt sie über das Handle. **Keine Ausgabe erfinden** — nur den Zustand führen (M12).
5. **`GetVersion()`** (Core-Global, Cfile:599401) steht sichtbar im Menü (main.lua:172). Heute
   liefert [ui-globals.lua](../src/engine-lua/ui-globals.lua):654 `'CFA'` — eine **erfundene Zahl
   im Produktivpfad** (→ OFFENE FRAGE 5).
6. **`userinit.lua` laden** (Gegenstück zu `simInit.lua`; keine Lua-Datei lädt es, die Engine tut
   es): bringt `Prefetcher = CreatePrefetchSet()` (userinit.lua:11/27) und den frame-basierten
   Scheduler aus M1.
7. **Ohne Film starten — auf dem Original-Weg:** `Prefs.SetOption('mainmenu_bgmovie', false)`
   (options.lua:358-371, Default true; main.lua:151-153). Der Movie-Pfad kommt in M12.

**Betroffene Original-Lua:** `lua/ui/uimain.lua`, `lua/ui/menus/main.lua` (`CreateUI`, 50-993),
`lua/ui/uiutil.lua`, `lua/ui/effecthelpers.lua`, `lua/ui/menucommon.lua`, `lua/maui/button.lua`,
`lua/ui/game/tooltip.lua`, `lua/ui/help/tooltips.lua`, `lua/user/prefs.lua`, `lua/userinit.lua`.

**Verifikation:** `scripts/verify-frontend.ts` — UI-VM booten, Root-Frame, `StartFrontEndUI()`;
`__mauiSnapshot()` muss `/scx_menu/logo/logo.dds`, `border-console-top_bmp.dds` und **genau so
viele `large_btn_up.dds`-Bitmaps enthalten, wie `menuTop` Einträge hat** (main.lua:104-142).
Browser (`?frontend`): Klick auf „Skirmish" muss mit **genau einer** Meldung scheitern —
`InternalCreateLobby … nicht implementiert` (lobbycomm.lua:121). Das ist der ehrliche Beweis, dass
die Kette bis zur Lobby trägt.

---

## M3 — Input scharf: ConExecute, Keymap, Hotkeys, Cursor

**Größe: M** · hängt an: M1, M2 · Recherche: [input-cursor-keymap](research/input-cursor-keymap.md)

**Ziel-Erlebnis:** Der Mauszeiger ist der Original-Cursor (animiert, 30 Formen). ESC/Enter/`~` tun,
was sie im Original tun. `Ctrl-W` togglet das Military-Panel — weil `keyactions.lua` es sagt, nicht
weil wir es verdrahtet haben. Shift hängt Befehle an die Queue.

**Engine-Teile:**

1. **`ConExecute` echt machen.** Ein Key-Action-String ist eine **Konsolenzeile**, kein
   Lua-Callback: `UI_Lua <code>` (`CConFunc_UI_Lua`, Cfile:423593-423600) hängt die Argumente
   zusammen und ruft `SCR_LuaDoString(code, UI_Manager->mState)` (Cfile:1256278-1256324) — bei uns
   `host.eval()` in der **UI-VM**. Heute loggt `ConExecute` nur (ui-globals.lua:648-651) ⇒ **jede**
   Tastenaktion ist tot, auch wenn die Keymap käme. Unbekanntes Kommando muss **knallen**.
2. **Keymap laden wie die Engine.** `CUIKeyHandler::LoadKeyMappings` (Cfile:1259476-1259525) tut es
   selbst — keine Lua-Datei tut es: `SCR_Import('/lua/keymap/keyNames.lua')` → `SetKeyNameTable`,
   dann `SCR_Import('/lua/keymap/keymapper.lua')` → **ruft `GetKeyMappings()`** → `AddKeyMapTable`.
3. `IN_AddKeyMapTable` (Cfile:1259176-1259266): Schlüssel = Key-String, Wert = Tabelle mit `.action`
   (Pflicht) + optional `.keyRepeat`; `category`/`order` ignoriert die Engine.
   `IN_RemoveKeyMapTable` (1259267), `IN_ClearKeyMap` (1260044).
4. `IN_ParseKeyModifiers` (Cfile:1259566-1259720): Split an `-`, erster Token = Tastenname → Index
   in `in_keyNames[256]` = **Windows-VK** (keyNames.lua:2), Modifier als Flags in denselben int:
   **`Shift = 0x80000000`, `Ctrl = 0x40000000`, `Alt = 0x20000000`** (Cfile:1259627/1259648/1259668).
5. **Ein Tastendruck** (`sub_838D10`, Cfile:1258983-1259080): (1) hat **irgendein** Control
   Keyboard-Fokus ⇒ **kein Hotkey** — wer tippt, löst keinen Hotkey aus; (2) Auto-Repeat ohne
   `keyRepeat` ⇒ ignorieren; (3) Treffer ⇒ `CON_Execute(action)` (1259059); (4) Sonderfälle über den
   **wx**-Keycode: `13` (Enter) → `chat.ActivateChat` (Cfile:1263522-1263560), `126` (`~`) →
   `uimain.ToggleConsole()` (1262747-1262775); (5) **jeder** Pfad endet mit `m_skipped = 1` — Hotkey
   und maui-Event schließen sich **nicht** aus.
6. `IsKeyDown(name)` (`MAUI_KeyIsDown`, Cfile:1141557-1141585): liefert **false**, wenn das Fenster
   nicht im Vordergrund ist **oder** ein Control Fokus hat. Argument ist ein `EMauiKeyCode`-**Name**:
   `IsKeyDown('Shift')` — **commandmode.lua:82, die Befehls-Queue**.
7. **Cursor.** `GetCursor()` (Cfile:1274426) liefert das **eine** `CMauiCursor` (5 Methoden: `Hide`,
   `Show`, `ResetToDefault`, `SetDefaultTexture`, `SetNewTexture`). `SetTexture`/`Reset` sind **Lua**
   (cursor.lua), nicht Engine. `UIUtil.GetCursor(id)` liest aus `skins[…].cursors[id]` fünf Werte:
   `texture, hotspotX, hotspotY, [numFrames], [fps]` (skins.lua:169; 30 Formen, meist animiert —
   `RULEUCC_Reclaim` = 23 Frames à 12 fps). Bei uns hängt `__uiSetCursorTexture` an **nichts**
   (ui-globals.lua:24 = `false`) ⇒ das Cursor-Objekt ist wirkungslos. TS-Hook: DDS → Blob-URL →
   `document.body.style.cursor = url(<png>) <hx> <hy>, auto`.
8. **Auflösen:** ESC und Pfeiltasten hängen heute direkt am `window` ([main.ts](../src/main.ts):651-680,
   726-742). Das gehört `uimain.EscapeHandler` (uimain.lua:119) und `keyactions.lua`.

**Betroffene Original-Lua:** `lua/keymap/{keyNames,keymapper,defaultKeyMap,keyactions}.lua`,
`lua/ui/uimain.lua`, `lua/ui/game/eschandler.lua`, `lua/maui/cursor.lua`, `lua/ui/uiutil.lua`,
`lua/ui/dialogs/keybindings.lua`, `lua/ui/game/commandmode.lua`.

**Verifikation:** `scripts/verify-input.ts` — (a) `ConExecute('UI_Lua LOG("hi")')` erzeugt die
Logzeile; ein erfundenes Kommando knallt. (b) `keymapper.GetKeyMappings()` liefert für **jeden**
Eintrag aus `defaultKeyMap.lua` eine `action` (keymapper.lua:112 warnt sonst), und `'Ctrl-W'` parst
auf `0x40000000 | 0x57`. Browser: nach `SetupUI()` steht `body.style.cursor` auf der Skin-Textur;
Shift-Klick hängt einen Befehl an die Queue statt ihn zu ersetzen.

---

## M4 — Session-Start aus der Original-Lua

**Größe: L** · hängt an: — (Sim-Seite, ab sofort baubar) · Recherche:
[session-start](research/session-start.md)

**Ziel-Erlebnis:** Die Karte liest sich selbst. Die ACU steht auf ihrem `ARMY_n`-Marker und warpt
ein (`PlayCommanderWarpInEffect`); auf SCMP_009 liegen **108 Massepunkte und 8 Hydrocarbon** als
Original-Splats (`mass_marker.dds`) mit `massDeposit01_prop.bp` — statt erfundener Ringe.

**Engine-Teile:**

1. **`/maps` in den VFS.** `GameVfs.mount` mountet heute nur `gamedata/*.scd`
   ([vfs.ts](../src/vfs/vfs.ts):27-28), obwohl der Kommentar daneben `bin/SupComDataPath.lua`
   korrekt zitiert; `main.ts` liest die Karte über einen separaten `DirectorySource` (main.ts:305/413).
   Solange `_save.lua` nicht als `/maps/<x>/<x>_save.lua` im LuaHost-VFS liegt, kann `SetupSession()`
   es nicht `doscript`en.
2. **Der Fund: `/schook`.** `bin/SupComDataPath.lua` setzt `hook = { '/schook' }`; die Engine liest
   das (Cfile:505923-505936 → `SCR_AddHookDirectory`) und hängt bei **jedem** Skript-Load zusätzlich
   `<hookdir><pfad>` an (Cfile:595822-595866, Logzeile `"Hooked %s with %s"`).
   **`schook/lua/siminit.lua` ist der fehlende halbe Session-Start:** es umhüllt `BeginSession` und
   ruft `ScenarioUtils.CreateProps()` (:17), `CreateResources()` (:18), Scores und
   `victory.CheckVictory` (:23-27); es umhüllt `OnCreateArmyBrain` und ruft
   `InitializeStartLocation(name)` (:47) + `SetPlans` (:48). `CreateProps`/`CreateResources` werden
   **nirgends sonst** aufgerufen. `schook.scd` liegt bereits im VFS
   ([gameFiles.ts](../scripts/gameFiles.ts):86) — es wird nur nie geladen.
3. **Echter SimInit-Boot.** `installEngine()` lädt heute `SimSync.lua` direkt und ruft
   `ResetSyncTable()` selbst — beides macht sonst `SetupSession()` (siminit.lua:45/100). Statt dessen
   `/lua/simInit.lua`. Voraussetzung: `CreatePrefetchSet()` (**simInit.lua:232, Top-Level!**),
   `__active_mods` (:33) und `/lua/dataInit.lua` (34 Zeilen: `BOOLEAN/INTEGER/FLOAT/VECTOR2/VECTOR3/
   RECTANGLE/STRING/GROUP`) — ohne die DSL ist jedes `_save.lua` unlesbar, und der strenge `_G`
   (config.lua:51) würde korrekt knallen.
4. **`ScenarioInfo` deserialisieren, nicht erfinden.** [session.ts](../src/sim/session.ts):61-72 baut
   ein Mini-Table; es fehlen `save`, `script`, `Env`, `Options`, `norushradius`, `Configurations`,
   und `ArmySetup` hat kein `Team`/`PlayerName`/`ArmyColor`/`StartSpot` — `BeginSession`
   (siminit.lua:150) liest aber `army.Team`. Vorlage: `SinglePlayerLaunch.lua:228-295`
   (`SetupCommandLineSkirmish`) + `LobbyComm.GetDefaultPlayerOptions` (lobbycomm.lua:29) +
   `defaultOptions` (SPL:123-135). Die Engine schreibt je Armee `ArmySetup[ArmyName] = teamInfo[i]`
   und `ArmyIndex = i` (**1-basiert**, Cfile:1071871), dann `_G.ScenarioInfo` (:1071889).
5. **Boot-Reihenfolge** (`Moho::Sim::Setup`, Cfile:1071723): Seed/PhysConstants → `ScenarioInfo` →
   **`SetupSession()`** (:1071898 — *bevor* eine Armee existiert) → EntityDB/CommandDB →
   **`Sim::CreateArmies`** (:1072015) → Props (:1072071) → **`BeginSession()`** (:1072090 —
   *nachdem* alle Brains da sind, *bevor* es Units gibt) → `Sim::PostInitialize` (:1072103, nur bei
   `Options.PrebuiltUnits == 'On'`).
6. **`CreateArmies`** (Cfile:1073404): je Armee zuerst `GenerateArmyStart` (**Zufall**, Cfile:1017961),
   dann Felder aus `ArmySetup` (**`Faction → mFaction = Faction − 1`**, :1017289), dann **Lua**
   `OnCreateArmyBrain(i+1, brain, ArmyName, PlayerName)` (:1073457). `brain:GetFactionIndex()` =
   `mFaction + 1` (Cfile:733604) — 1-basiert, direkt als Index in `factions.lua`.
7. **`BeginSession()`** (siminit.lua:137) → `ScenarioInfo.Env.OnPopulate` → das Karten-Skript →
   `InitializeArmies()` (scenarioutilities.lua:436) → `CreateInitialArmyGroup` →
   `CreateInitialArmyUnit` (Cfile:1025200: Position aus `GetArmyStartPos()`, **`pos.y = 0.0`**,
   `mComplete = 1`).
8. **Bindungen** (`sim_SimInits`): `ListArmies` (1024373), `SetArmyStart(army, x, z)` (**nur 2D**,
   1024490), `GenerateArmyStart` (1017961), `brain:GetArmyStartPos` (1016481),
   `ShouldCreateInitialArmyUnits` (= `not /noinitialunits`, 1024331), **`CreateResourceDeposit`**
   (687675 → `AddDepositPoint` 686680: Rechteck `trunc(p − size/2) … +size` in int16-Zellen ⇒ ein
   Mass-Punkt ist genau **eine 1×1-Zelle**, dasselbe Raster wie `COORDS_GridSnap`), `CreatePropHPR`
   (1015362), `CreateUnitHPR`, `SetAlliance`, `SetArmyPlans`, `InitializeArmyAI`,
   `SetIgnoreArmyUnitCap`, `AddBuildRestriction`, `ArmyInitializePrebuiltUnits` (1024702),
   `GetMapSize`, `Random` (deterministisch → OFFENE FRAGE 3), `Warp`, `OrientFromDir`,
   `SetAlliedVictory`/`EndGame`/`IsGameOver`. Unit-Methoden: `SetCustomName`, `HideBone`,
   `CreateTarmac`, `PlayCommanderWarpInEffect`, `CreateWreckageProp`.
9. **Auflösen:** [main.ts](../src/main.ts):413-432 (Marker-Parser) und :483 (`spawnViaLua('uel0001')`)
   fallen weg.

**Betroffene Original-Lua:** `lua/simInit.lua`, `schook/lua/siminit.lua`, `lua/dataInit.lua`,
`lua/scenarioutilities.lua`, `lua/scenarioframework.lua`, `lua/factions.lua`, `lua/victory.lua`,
`lua/aibrain.lua`, `maps/<x>/<x>_{scenario,save,script}.lua`.

**Verifikation:** `scripts/verify-session-start.ts`, vier Stufen einzeln rot/grün:
(a) `doscript('/lua/dataInit.lua', env); doscript('/maps/SCMP_009/SCMP_009_save.lua', env)` ⇒
`env.Scenario.MasterChain._MASTERCHAIN_.Markers.ARMY_1.position == {672.5, 18.6797, 346.5}`.
(b) Nach dem Hook-Load ist `BeginSession` die **gehookte** Fassung (Zähler-Spion auf
`CreateResourceDeposit`). (c) `ArmyBrains[1]:GetArmyStartPos()` == `672.5, 346.5` — der Beweis, dass
`InitializeStartLocation` aus dem Hook lief. (d) `BeginSession()` ⇒ genau **1 Unit** je nicht-ziviler
Armee, Blueprint == `Factions[faction].InitialUnit`; **116 Deposits** (108 Mass, 8 Hydrocarbon).
Browser: Karte laden, ACU steht auf dem Startpunkt — **ohne** `?luaspawn`.

---

## M5 — Der Übergang: `LaunchSinglePlayerSession` (Naht 2)

**Größe: M** · hängt an: M2, M4 · Recherche: [frontend-menu](research/frontend-menu.md) §6,
[session-start](research/session-start.md) §2.1

**Ziel-Erlebnis:** Die Session startet aus der **Original-Lua**, nicht aus einem Web-Button. Der
Launcher-Knopf verschwindet.

**Engine-Teile:**

- `LaunchSinglePlayerSession(sessionInfo)` — **UI-VM**-Bindung (Cfile:1321744; mHelp *„launch a new
  single player session."*). Rumpf: `WLD_SetupSessionInfo(luaTable)` → `WLD_BeginSession(…)`
  (Cfile:1321776-1321782); wirft, wenn schon eine Session läuft. Gelesene Felder — **mehr gibt es
  nicht**: `scenarioInfo` (1321432), `scenarioMods` (1321444), `teamInfo` (1321455), `RandomSeed`
  (fehlt ⇒ Systemzeit, 1321475), `scenarioInfo.map` (1321529), `createReplay` (1321539),
  `playerName` (1321545). Bei uns: bootet den Sim-Worker mit genau dieser Tabelle.
- Der **Bauplan** für `sessionInfo` steht komplett in `SinglePlayerLaunch.lua:228-295`
  (`SetupCommandLineSkirmish`) — Fraktionen, Farben, Teams, `defaultOptions`, `GetExtraArmies`
  (NEUTRAL_CIVILIAN), alles aus der Original-Lua, **ohne Netzwerk-Lobby**.
- `LoadScenario` (maputil.lua:21-30) = `doscript('/lua/dataInit.lua', env)` + `doscript(scenName, env)`
  — dasselbe, was die Engine in `WLD_LoadScenarioInfo` (Cfile:1320686-1320693) tut.
- Der **Einstieg ist in der Engine verdrahtet:** `main` (Cfile:1373640-1373870) prüft `/map <x>` →
  `func_StartCommandLineSession` (1373521) → `singleplayerlaunch.StartCommandLineSession` (1373668).
  Browser-Gegenstück: `?map=<x>` über das schon vorhandene `HasCommandLineArg`.
- Weitere UI-Bindungen: `SessionGetScenarioInfo` (1330883), `PrefetchSession`,
  `WorldIsLoading`/`WorldIsPlaying` (1322303).
- **Rückweg:** `sub_88C9C0` (Cfile:1321251) = `WLD_Teardown()` → `UI_StartFrontEnd()`. Nach dem Spiel
  landet man wieder im Hauptmenü — und weil `SetNewLuaState` die Frames neu baut, ist der maui-Baum
  dabei leer.

**Betroffene Original-Lua:** `lua/ui/lobby/SinglePlayerLaunch.lua`, `lua/ui/maputil.lua`,
`lua/ui/lobby/lobbyComm.lua` (nur `GetDefaultPlayerOptions`), `lua/ui/uimain.lua` (`NoteGameOver`).

**Verifikation:** `scripts/verify-launch.ts` — `SetupCommandLineSkirmish` gegen SCMP_009 laufen
lassen, die erzeugte `sessionInfo` prüfen (`teamInfo[1].ArmyName == 'ARMY_1'`, `Faction`,
`scenarioInfo.Options == defaultOptions`), dann `LaunchSinglePlayerSession(sessionInfo)` ⇒ der Worker
bootet, nach N Beats steht die ACU auf `ARMY_1`. Browser: `?map=SCMP_009` ⇒ Session läuft, **ohne**
dass eine TS-Zeile eine Armee anlegt; `NoteGameOver` ⇒ Hauptmenü, `GetFrame(0)` hat 0 Kinder.

---

## M6 — Sync-Kreislauf + `gamemain.OnBeat` + Session-Globals (Naht 1)

**Größe: M** · hängt an: M4 · Recherche: [session-ui-panels](research/session-ui-panels.md)

**Ziel-Erlebnis:** Nichts Neues sichtbar — aber ab hier lebt **jedes** Panel im Original-Takt, und
`UnitData` kommt aus `Sync` statt aus einem TS-Snapshot.

**Engine-Teile:**

- **Der Kreislauf — die Reihenfolge *ist* Semantik:**

  ```
  SIM:  Sim::Sync (Cfile:1074261)  →  Sync.__ArmyStats, Sync.Cheaters, …
                                   →  ResetSyncTable()          (1074773 → simsync.lua:9)
  UI:   CWldSession::DoBeat (1327644)
          PreviousSync = SCR_Copy(Sync)   (1328263)
          Sync         = <empfangen>      (1328276)
          OnSync()                        (1328286 → usersync.lua:14)   ← ZUERST
          UI_Manager->OnBeat() (1328540) → CUIManager::DoBeat (1273907)
            ├ UI_FactoryCommandQueueHandlerBeat (1256904) → gamemain.OnQueueChanged
            └ UI_LuaBeat (1262940)               → gamemain.OnBeat()    (gamemain.lua:437)
  ```

  Wer erst `OnBeat` rechnet, zeigt die Daten des vorigen Beats. Heute ruft
  [gameUi.ts](../src/ui/gameUi.ts):161 `Economy._BeatFunction()` **direkt** — an
  `AddBeatFunction`/`OnBeat` vorbei. Registriert sind dort aber: economy.lua:239,
  avatars.lua:70/747, score.lua:86, objectives2.lua:109, rallypoint.lua:56, commandmode.lua:87,
  connectivity.lua:147.
- `usersync.lua` verteilt: `Sync.Sounds` → `PlaySound` (:22), `Sync.UnitData` → `UnitData` (:44),
  `Sync.ReleaseIds` (:48), `Sync.RequestingExit` (:16), `Sync.UserConRequests` (:38). Die Sim-Seite
  legt die Tabelle je Beat neu an (simsync.lua:9-31).
- Transport über die Worker-Grenze: structured clone statt `SCR_ToByteStream`/`SCR_FromByteStream`
  (Cfile:1328276) — gleiche Semantik, andere Leitung: Engine-Freiheit, kein Logik-Nachbau
  (Einschränkung → OFFENE FRAGE 12).
- **Session-Globals** (kein einziges neues Control nötig): `GetArmiesTable`
  (Cfile:1266971-1267112 — `{numArmies, focusArmy, armiesTable[i] = {name, nickname, faction, color,
  iconColor, showScore, civilian, human, outOfGame, authorizedCommandSources}}`),
  `SessionGetScenarioInfo` (1330883), `GetGameTime` (**String**, 1266614), `GameTime` (**Sekunden**,
  1361870), `FormatTime` (1266840), `GetArmyScore` (1267137), `GetSystemTimeSeconds` (1266799),
  `CurrentTime`, `IsObserver`, `GetSimRate`, `SimCallback({Func, Args})` (1359123 →
  `/lua/simcallbacks.lua`), `ValidateUnitsList` (1360576), **`EnableWorldSounds`** (1348521),
  `SessionRequestPause`/`SessionResume`/`SessionIsPaused` (1330316/1330361/1330406),
  `GetGameSpeed`/`SetGameSpeed` (1322407/1322458).
- **Achtung Modulebene:** `score.lua:28` ruft `SessionGetScenarioInfo()` und `avatars.lua:30` ruft
  `GetArmiesTable()` auf **Modulebene** — ohne diese Globals scheitert schon der `import`.
- **Zähl-Korrektur:** `engine-api.md` listet 200 `<global>`-Bindungen in `scr_UserInits`, aus der
  Decomp sind es **205**. In beiden Listen fehlen: `EnableWorldSounds`, `DisableWorldSounds`,
  `StopAllSounds`, `CreateUnitAtMouse`.

**Betroffene Original-Lua:** `lua/ui/game/gamemain.lua` (423-441), `lua/usersync.lua`,
`lua/simsync.lua`, `lua/SimCallbacks.lua`, `lua/ui/game/economy.lua`.

**Verifikation:** `scripts/verify-sync-beat.ts` (bzw. `verify-ui-panels.ts` erweitern) — (a)
`economy.lua` hat sich über `AddBeatFunction` registriert; ein `gamemain.OnBeat()` aktualisiert den
Text. (b) Eine Unit in `Sync.UnitData` taucht nach `OnSync()` in `UnitData[id]` auf — das liest
`orders.lua:909`. (c) `PreviousSync` ist nach dem zweiten Beat der Inhalt des ersten.

---

## M7 — Kamera + WorldView als maui-Control

**Größe: XL** · hängt an: M1, M3, M6 · Recherche: [worldview-camera](research/worldview-camera.md)

**Ziel-Erlebnis:** Die Welt ist Teil der UI. Zoom zum Cursor, Mitteltasten-Pan, Kamera-Sprünge aus
der Lua; Gummiband-Selektion, Bau-Vorschau am Cursor, Rechtsklick-Formation. Der Cursor zeigt an,
was ein Klick täte. [worldCommands.ts](../src/ui/worldCommands.ts) wird **gelöscht**.

**Kernsatz:** `CUIWorldView` ist von `CMauiControl` abgeleitet (vftable Cfile:397420-397449:
`Draw`, `SetHidden`, `HitTest`, `HandleEvent`, `OnFrame`). **Es gibt keinen zweiten Eingabepfad.**

**Engine-Teile** (Reihenfolge ist Semantik: ohne Kamera kein Ctor, ohne Ctor kein Control, ohne
`cursorInfo` kein Klick):

1. **Kamera.** `GetCamera(name)` (`cfunc_GetCameraL` @0x7AB100, Cfile:1151852) → `CameraImpl`
   (25 Methoden). **Das Modell ist vollständig vier Felder** (`SaveSettings`, Cfile:1153090-1153150):
   `{ Focus = Vector3, Zoom = number, Pitch = number, Heading = number }`. **Zoom ist eine Distanz
   in Weltmetern**, kein Faktor (`GetTargetZoom() > 130`, unittext.lua:31). Namen: `WorldCamera`,
   `WorldCamera2`, `MiniMap`, `CameraHead2`. [unitViewer.ts](../src/viewer/unitViewer.ts) führt heute
   `{target, dist, pitchOffset}` — das ist fast `{Focus, Zoom, Pitch}`.
2. **`moho.UIWorldView:__init(parent, cameraName, depth, isMiniMap, trackCamera)`** (@0x86E480,
   Cfile:1298140-1298350). Der Ctor tut mehr, als man denkt: Control-Name ist **immer**
   `"World View"`, das zweite Argument ist der **Kameraname**; **`RCamManager::CreateCamera(name)`
   erzeugt die Kamera hier**; `name == "WorldCamera"` ⇒ `func_SetWorldCamera(cam)`; `isMiniMap` ⇒
   `SetLODScale(cam_DefaultMiniLOD)` + `CanShake(false)`; `WRenViewport::AddWorldView(view,
   eventMapper, depth)` = Render- **und** Event-Registrierung; `mNeedsFrameUpdate = 1`; liest
   `worldview.WorldViewParams` und setzt daraus **genau drei** ConVars (`ui_SelectTolerance`,
   `ui_DisableCursorFixing`, `ui_ExtractSnapTolerance`) — `ui_MinExtractSnapPixels`/
   `ui_MaxExtractSnapPixels` aus derselben Tabelle werden **ignoriert** (Cfile:1298295-1298345).
3. **`cursorInfo` + `UpdateSelection`** (@0x86F520): schreibt `mMouseScreenPos`, `mMouseWorldPos`,
   `mInWorld`, `mUnitHover`, `mIsDragger`. Weltpunkt aus `Camera->CameraScreenToSurface`; Unit unter
   dem Cursor aus `Camera->Unproject` → `Wm3::IntrLine3Box3f` gegen die Mesh-Boxen, **aufgeweitet um
   `ui_SelectTolerance`** (Cfile:1298979-1298981). Daraus speisen sich `GetMouseWorldPos()`
   (@0x842C30), `GetMouseScreenPos()`, `GetRolloverInfo()`, `Project`/`UnProject`,
   `GetScreenPos(unit)`.
4. **`OnFrame`** (@0x871140, Cfile:1299977): `UpdateSelection(mMouseScreenPos)` **und dann**
   `RunScript("OnUpdateCursor")` — so kommt worldview.lua:131-204 zum Zug. Danach Tastatur-Pan/Rotate
   (`ui_KeyboardPanSpeed` = 90, `…AccelerateMultiplier` = 4, `ui_KeyboardRotateSpeed` = 10,
   `…Multiplier` = 2; Cfile:421739-421742).
5. **`HandleEvent` in der richtigen Schachtelung** (@0x8704B0, Cfile:1299476-1299975):
   `UpdateSelection` läuft **vor** der Lua (:1299571); dann `CMauiControl::HandleEvent` = der Aufruf
   der **Lua**-`HandleEvent`; liefert sie `true` **oder** ist `mInputLocks > 0`, endet alles hier
   (:1299583). **Die Lua-Ebene liegt innerhalb der C++-Ebene, nicht davor.** Danach die
   Engine-Zweige: Mausrad → Command-Mode oder `Camera:SetPivot` + `Camera:Zoom`; MouseMotion mit
   `SPACE` → `Camera:Spin`, sonst `RevertRotation`; Mitteltaste → `CameraDragger`; Links-Press →
   `GetLeftMouseButtonAction`; Rechts-**Release** → der Befehl geht raus.
6. **`GetLeftMouseButtonAction`** (@0x81F7B0, Cfile:1240587-1240695) — **der Command-Mode lebt in der
   Lua**: `UI_GetCommandMode` @0x83DDA0 macht wörtlich
   `SCR_Import('/lua/ui/game/commandmode.lua')['GetCommandMode']()`. Übersetzung: `"order"` →
   `COMMOD_Order` (`data.name` → `RULEUCC_*`; Sonderfall `RULEUCC_Transport` + Hover-Unit mit
   `RULEUCC_Transport` ⇒ `RULEUCC_CallTransport`), `"build"`/`"buildanchored"` → Build-Dragger (ohne
   gültiges bp bleibt der Modus `None`), `"ping"` → `COMMOD_Ping`, `""` → Select (4) bzw. CommandDrag
   (5). **Vorbedingung für alles: `cursorInfo.mInWorld`** (:1240553).
7. **Bindungen:** `LockInput`/`UnlockInput`/`IsInputLocked` (Zähler `mInputLocks`; die **Engine** ruft
   `IsInputLocked()` selbst, Cfile:1262798-1262815), `GetsGlobalCameraCommands` (1300446),
   `SetCartographic`/`IsCartographic`, `EnableResourceRendering`, `SetHighlightEnabled`/
   `HasHighlightCommand`, `GetRightMouseButtonOrder()` → `RULEUCC_*`, `ShowConvertToPatrolCursor()`,
   `ZoomScale`, `CameraReset`, `UIZoomTo`/`UISelectAndZoomTo` (Cfile:1292660-1292715),
   `UISelectionByCategory` (1292494), `_c_CreateDecal` → `ScriptedDecal` (5, Ziel-Reticle),
   `InternalCreateWorldMesh` → `CUIWorldMesh` (16, Rallypunkt),
   `InternalCreateWldUIProvider` → `CLuaWldUIProvider` (gamemain.lua:225).
8. **Dragger:** `func_NewSelectionDragger2D` (@0x865880, Gummiband), `func_NewUIBuildDragger`
   (@0x823CB0 — **hier** sitzt der Raster-Snap, nicht in der UI), `CameraDragger`,
   `func_NewCommandDragger` (@0x8242B0). Alle vier sind im Original **C++**; sie gehören in die
   Engine, nicht in die Lua. Der Snap in `worldCommands.ts` ist **richtig gerechnet**
   (`COORDS_GridSnap`) — er steht nur an der falschen Stelle. „Rechtsklick = Move" als Festwert
   (worldCommands.ts:125) entfällt; das beantwortet `GetRightMouseButtonAction`.
9. **Und dann fällt der `draws()`-Filter** im Hit-Test ([maui.lua](../src/engine-lua/maui.lua):225-235,
   320-334, 344-356). Die Engine testet **jedes** sichtbare Control per Rechteck (Cfile:1124492) — es
   gibt **kein** „zeichnet etwas"-Kriterium. Dass die Vollbild-Container im Original keinen Klick
   fressen, liegt allein daran, dass die **Weltansicht selbst ein Control ist**. Der Wegfall der
   Heuristik ist der Beweis, dass die WorldView sitzt (→ Konflikt B).

**Betroffene Original-Lua:** `lua/ui/controls/worldview.lua` (`Class(moho.UIWorldView, Control)`, :96),
`lua/ui/game/worldview.lua` (`CreateMainWorldView`, gamemain.lua:142), `lua/ui/game/commandmode.lua`,
`lua/ui/game/{rallypoint,ping,selection,zoomslider}.lua`, `lua/usercamera.lua`,
`lua/ui/controls/worldmesh.lua`, `lua/ui/game/wlduiprovider.lua`.

**Verifikation:** `scripts/verify-camera.ts` — `SaveSettings()` → `RestoreSettings()` ist idempotent;
`zoomslider.lua` lädt und schaltet. `scripts/verify-worldview.ts` — nach dem UI-Aufbau ist
`import('/lua/ui/game/worldview.lua').viewLeft` ein Control, `MapControls['WorldCamera']` gesetzt,
`LockInput()`/`UnlockInput()` schalten `IsInputLocked()`; **`Project(UnProject(view, Vector2(x,y)))
≈ (x,y)` auf ±1 px quer über den Bildschirm** — der ehrlichste Test, den die Kamera zulässt.
**`scripts/verify-command-chain.ts` umschreiben:** nicht mehr `worldClick(…)` aufrufen, sondern
`__mauiMouse('ButtonPress', x, y)` auf die WorldView feuern und prüfen, dass die Fabrik an der
**gerasterten** Stelle entsteht — dann prüft der Test den echten Pfad.

---

## M8 — Kampf: Projektile, Schaden, Tod, Wracks

**Größe: XL** · hängt an: M4 · **sim-only — ab sofort parallel zur gesamten UI-Kette baubar** ·
Recherche: [combat-projectiles](research/combat-projectiles.md), ergänzt
[weapons](research/weapons.md) + [damage-binary](research/damage-binary.md)

**Ziel-Erlebnis:** Zwei Panzer verschiedener Armeen sehen sich, feuern, treffen, sterben — und
hinterlassen ein Wrack mit dem richtigen Rückgewinnungswert.

Heute gibt **niemand einer Waffe je ein Ziel**: die FSM steht seit dem ersten Tick im `IdleState`.
`Kill` und `GetArmorMult` sind **No-Ops** (moho.lua:53/138), `moho.projectile_methods` ist eine
leere Auto-Vivifier-Klasse, `beat()` ([engine.ts](../src/lua/engine.ts):91-108) hat sechs Phasen —
keine davon ist Waffe oder Projektil.

**Engine-Teile (kleinste ehrlich testbare Schritte):**

1. **Projektil-Blueprints laden.** `/projectiles/**/*_proj.bp` in `__bpFiles`
   ([unitFactory.ts](../src/lua/unitFactory.ts):50 kennt nur `units/<id>/<id>_unit.bp`). Die Pipeline
   steht bereits (blueprints.lua:259-262/313); die ID ist der **volle kleingeschriebene Pfad mit
   `.bp`** (`SetBackwardsCompatId`, blueprints.lua:104-107) — genau der String in
   `Weapon.ProjectileId`.
2. **Blueprint-Defaults.** `Projectile` (Ctor `RProjectileBlueprintPhysics`, Cfile:653667-653712):
   `Lifetime 15`, `InitialSpeed 1`, `MaxSpeed 0`, `TurnRate 0`, `CollideSurface 1`, `TrackTarget 0`,
   `VelocityAlign 1`, **`UseGravity 1`**, `DestroyOnWater 0`, `RealisticOrdinance 0`, …
   Das Projektil-Blueprint hat **keine `Defense`-Sektion** (Cfile:654222-654240) —
   `Projectile.lua:75` liest trotzdem `bp.Defense.MaxHealth or 1`; das trägt **nur** dank der
   LuaPlus-`nil`-Metatable aus [boot.lua](../src/engine-lua/boot.lua). Ebenso fehlt `Weapon` in
   [blueprints.lua](../src/engine-lua/blueprints.lua):16-73 — `weapon.lua:287` rechnet
   `weaponBlueprint.DamageRadius + 0` (→ OFFENE FRAGE 9).
3. **Bone-Transforms in die Sim.** [scm.ts](../src/formats/scm.ts):36-43 liest
   `position`/`rotation`/`parent` je Bone, aber `__setBones` gibt nur **Namen** weiter. Ohne
   Mündungs-Weltposition gibt es keinen Startpunkt. Dazu `Entity:GetPosition([bone])` (Cfile:934579 —
   **das Bone-Argument fehlt uns**) und `Entity:GetBoneDirection` (931458).
4. **`moho.projectile_methods` (30) + `__spawnProjectile`** (neue Datei
   `src/engine-lua/projectiles.lua`). Klassenauflösung wie `func_FindBlueprintScriptModule`
   (Cfile:914189-914360): `bp.Source` bis zum **letzten** `_` abschneiden + `_script.lua`;
   Klassenname `bp.ScriptClass`, sonst **`"TypeClass"`**; Datei fehlt ⇒ `/lua/sim/projectile.lua`.
5. **`UnitWeapon::CreateProjectile`** (@0x6D6820, Cfile:985613-985800): **kein `ProjectileId` ⇒ kein
   Fehler**, sondern `DoInstaHit` + Rückgabe `nil` (:985658-985675). `MuzzleVelocity != 0`
   überschreibt den Betrag; Lebensdauer in **Ticks**. Lua-Kette: `defaultweapons.lua:582` →
   `weapon.lua:321-325` (`CreateProjectile(bone)` → `PassDamageData(GetDamageTable())`, 11 Felder,
   Projectile.lua:415-427).
6. **`__projectileTick()` als Phase 5 in `beat()`** (nach `motionTick`). `Projectile::MotionTick`
   (Cfile:944040-944290), dt = 0.1. Zwei Dinge, die man nicht raten darf: **die Integration ist
   trapezförmig** — `pos += 0.5·(v_alt + v_neu)·0.1`, **nicht** `pos += v·0.1` (naives Euler
   verschiebt jede Flugbahn); und `mImpactInterp` löst den Aufschlag erst im **nächsten** Tick auf.
   `mBallisticAcc = mGravity · UseGravity` (:943663) — `UseGravity` schaltet die Gravitation schlicht
   ab. `TurnRate` begrenzt auch bei `TrackTarget = false` die Mesh-Ausrichtung (`· 0.0017453292` =
   rad/Tick) — darum hat TDFGauss01 `TurnRate = 360`, obwohl es ungelenkt ist.
7. **Kollision.** `Projectile::CheckCollision` (@0x69D1D0) ist **nicht dekompilierbar** — aus der
   Aufrufliste gesichert: gesweepter **Strecken**-Test (nicht Punkttest), Terrain aus dem
   Heightfield, Wasser als Ebenenschnitt, Lua-Filter `OnCollisionCheck(other)` mit **einem** Argument
   (Cfile:945766-945830). `ENT_GetImpactType` (@0x67B240) liefert
   Air/Underwater/Unit/UnitAir/UnitUnderwater/Projectile/Prop/Shield — `Terrain` und `Water` erzeugt
   sie **nicht**. `EImpactType` Cfile:640486-640525. `Projectile::Impact` (944692):
   `RunScript("OnImpact", ImpactTypeString, targetEntity)` — **zwei** Argumente.
   → OFFENE FRAGE 8: **explizit als Annahme markieren, nicht raten.**
8. **`Damage` / `DamageArea` / `DamageRing` / `MetaImpact`** (Cfile:1064181/1064294/1064409/1064536).
   **`Damage` hat 5 Argumente** — `(instigator, origin, target, amount, type)`; `cfunc_DamageL`
   prüft `lua_gettop != 5` (Cfile:1064215), der mHelp-Text ist veraltet; `amount == 0` ⇒
   **Lua-Fehler**. Formel: `effektiv = amount · ArmorMult / (1 + Handicap)`, **kein**
   Distanz-Falloff. `Unit:GetArmorMult` (972450) ist heute No-Op ⇒ `shield.lua:101` rechnet
   `amount * nil`.
9. **`Entity:Kill(instigator, type, overkillRatio)`** (Cfile:951962-952180) — inklusive der Regel,
   die man nicht erfinden kann: ist die Unit im Bau und **`FractionComplete < 0.5`, wird
   `overkillRatio` auf `10.0` gesetzt** (:952126) ⇒ eine halbfertige Baustelle hinterlässt **nie**
   ein Wrack. `Entity::Destroy` ist **aufgeschoben** (Deletion-Queue; `OnDestroy` erst beim echten
   Löschen, :916143). Lua-Seite: `Unit:OnDamage` feuert nur bei gesetztem `self.CanTakeDamage`
   (unit.lua:190/779/787) → `DoTakeDamage` → `self:Kill(…)`.
10. **Zielerfassung + Feuertakt** (`__weaponTick`). `CAcquireTargetTask::TaskTick` (@0x5D8D10):
    Prüfintervall `TargetCheckInterval · 10` Ticks; Suchradius `max(TrackingRadius · MaxRadius,
    MaxRadius)` (Cfile:793146-793156) — **ein Maximum**, `TrackingRadius < 1` verkleinert nichts.
    `CFireWeaponTask::Dispatch` (@0x6D3DC0, Cfile:983912-983956): `mFireClock = (int)(10.0 / rof)` —
    **trunkiert**, in Ticks; `UnitWeapon::Fire` ruft **nur** `RunScript("OnFire")`, sonst nichts.
    Sentinel binär bestätigt: `mRateOfFire = -1` ⇒ *nimm den Blueprint-Wert*
    (Cfile:983289-983304). `SetTarget` ⇒ `OnGotTarget`/`OnLostTarget` auf der **Waffe**
    (Cfile:985364-985494).
11. **Falsch, nicht nur fehlend:** `IsAlly`/`IsEnemy`
    ([globals.lua](../src/engine-lua/globals.lua):42-43) vergleichen bloß Armee-Indizes. Ohne echte
    Allianz-Tabelle (aus `SetAlliance`, M4) ist jeder Kollisions- und Friendly-Fire-Filter
    **geraten**.
12. **Wrack** (`CreateProp`, `moho.prop_methods`, `/lua/sim/prop.lua`) — erst wenn 10 grün ist.
    Formeln: weapons.md §5.
13. **Später:** Schilde, Beams (`CollisionBeamEntity`, 6 Bindungen; `defaultweapons.lua:909`), DoT,
    Nuke-Ringe, Flares.

**Betroffene Original-Lua:** `lua/sim/{Projectile,DefaultProjectile,Weapon,DefaultWeapons,Unit,Prop,
Shield}.lua`, `lua/defaultdamage.lua`, `projectiles/**/*_script.lua`.

**Verifikation:** **`scripts/verify-combat.ts` ist die Zielmarke** — zwei UEL0201, Armee 1 und 2,
15 Weltmeter Abstand, `beat()` in der Schleife. Erwartet: `OnFire` im ersten Tick nach der
Zielerfassung, danach exakt alle **10 Ticks** (RoF 1); je Schuss ein `TDFGauss01` (nicht
`Projectile`), `GetLauncher()` ist die Unit, `DamageData.DamageAmount == 24`; Flugzeit ≈ 6 Ticks;
das Ziel verliert **24 HP** pro Treffer; nach `ceil(MaxHealth/24)` Treffern `OnKilled`; Wrack-Prop
mit `mass = BuildCostMass · 0.9 · (1 − overkill)`. Zwischenstufen einzeln: Trapez-Flugbahn
analytisch nach 5 Ticks; `Damage(a, pos, b, 24, 'Overcharge')` gegen `ArmorType = 'Commander'` zieht
`24 · 0.033333`.

---

## M9 — Die restlichen maui-Controls: ItemList, Edit, Scrollbar, MapPreview

**Größe: L** · hängt an: M1 · Recherche: [maui-controls](research/maui-controls.md)

**Ziel-Erlebnis:** Dropdowns funktionieren (jedes `Combo` ist ein `ItemList`) — damit werden die
Optionen und die Kartenauswahl bedienbar; im Spiel kann man tippen (Chat, Umbenennen,
Bau-Templates).

**Engine-Teile:**

| Control | Bindung | schaltet frei |
|---|---|---|
| `CMauiItemList` (19) | `InternalCreateItemList(luaobj,parent)` (Cfile:1140074, Helps 1140151-1141154); Callbacks `OnClick`, `OnDoubleClick`, `OnKeySelect`, `OnMouseoverItem` | **combo.lua:117 → jedes Dropdown**, uiutil.lua:931, helptext.lua:98/146, transmissionlog, eula, mapselect, score |
| `CMauiEdit` (31) | `InternalCreateEdit(luaobj,parent)` (Cfile:1133710). **Das Text-Editing liegt in C++** (`CMauiEdit::HandleEvent` @0x790470, Cfile:1132299-1132317: nur ButtonPress/DClick und `MET_Char`; **gibt immer 0 zurück** — ein Edit „verbraucht" ein Event nie). `OnEnterPressed(text)` (1132320), `OnEscPressed(text)` (1132327), `OnNonTextKeyPressed`, `OnLoseKeyboardFocus`. Braucht `MET_Char` aus M1. | chat.lua:601, ping.lua:80, rename.lua:29, construction.lua:1022, console, lobby, filepicker |
| `CMauiScrollbar` (4) | `InternalCreateScrollbar(luaobj,parent,axis)` (Cfile:1144735) — `axis` ist der **Lexical-String** der `EMauiScrollAxis` (`"Vert"`/`"Horz"`, scrollbar.lua:9-12; Konvertierung 1144789). **Das Scrollable-Protokoll ist Lua, nicht C++:** `GetScrollValues(axis) -> rangeMin, rangeMax, visibleMin, visibleMax` (1124664), `ScrollLines(axis,delta)` (1124731), `ScrollSetTop(axis,top)` (1124775) — per `RunScript` auf dem Objekt, das `SetScrollable()` bekam. | uiutil (`CreateVertScrollbar`/`CreateHorzScrollbar`, ~580-611), console, mapselect, modmanager |
| `CUIMapPreview` (3) | `InternalCreateMapPreview` (1276475) + `SetTexture`, `SetTextureFromMap`, `ClearTexture` | mappreview.lua:8 → mapselect, lobby |

Dazu die neuen Kinds `itemlist`, `edit`, `scrollbar`, `mappreview` im
[mauiRenderer.ts](../src/ui/mauiRenderer.ts).

**Nicht bauen:** `Histogram` und `Mesh` werden von **keiner** `lua/ui/**`-Datei instanziiert
(Cfile:1137793/1142596). **Tote Importe** (importieren ein Control, erzeugen es nie):
specialgrid.lua:9, unitviewdetail.lua:7, tooltip.lua — **das Bau-Grid ist eine `SpecialGrid` aus
Bitmaps, kein ItemList.** Button, Checkbox, Slider, Grid, Window, MultiLineText, Combo, StatusBar,
RadioButtons sind **reine Original-Lua** auf Bitmap/Group/Text: dort gibt es nichts zu bauen.

**Betroffene Original-Lua:** `lua/maui/{itemlist,edit,scrollbar,mappreview,combo}.lua`,
`lua/ui/uiutil.lua`, `lua/ui/dialogs/{options,mapselect,rename}.lua`, `lua/ui/game/chat.lua`.

**Verifikation:** `scripts/verify-controls.ts` — (a) `Combo(parent, {…})` ⇒ `GetItemCount()` stimmt,
`OnClick` setzt die Selektion; `mapselect.lua` lädt fehlerfrei. (b) `rename.lua`-Dialog erzeugen,
`MET_Char`-Folge einspeisen, `GetText()` prüfen, Enter ⇒ `OnEnterPressed` mit dem Text.
(c) `UIUtil.CreateVertScrollbar(list)` ⇒ Mausrad ruft `ScrollLines(axis, delta)` auf dem Scrollable.

---

## M10 — `gamemain.CreateUI()` ist der einzige Aufbauweg

**Größe: L** · hängt an: M6, M7, M9 · Recherche: [session-ui-panels](research/session-ui-panels.md)

**Ziel-Erlebnis:** Die komplette Session-UI — Score-Uhr, Tabs-Menü, ACU-Avatar, Kontrollgruppen,
Minimap, Chat, Hilfetext, Funkspruch-Log. `setupGameUi()` **entfällt**; [hud.ts](../src/ui/hud.ts)
wird **gelöscht**.

**Engine-Teile:** Die Engine baut die Spiel-UI **nicht** selbst — sie ruft genau einen Einstieg:
`WldUIProvider.CreateGameInterface` (gamemain.lua:316) → `CreateUI(isReplay)` (gamemain.lua:116-192).
In **exakter** Reihenfolge (✔ = bei uns schon da):
`ConExecute("Cam_Free off")` (117) · `GameCommon.InitializeUnitIconBitmaps` (130) ·
`CreateScreenGroup` (132) · `borders.SetupBorderControl` → **controlCluster, statusCluster, mapGroup,
windowGroup** (134) · `controlClusterGroup.OnFrame` → einmalig **`OnFirstUpdate()`** (136-140) ·
`worldview.CreateMainWorldView` + `LockInput()` (142/143 ← M7) · economy ✔ (145) · `tabs.Create` (146) ·
multifunction ✔ (148) · orders ✔ (150) · construction ✔ (152) · unitview ✔ (153) · unitviewDetail ✔
(154) · `avatars.CreateAvatarUI` (155) · `controlgroups.CreateUI` (156) · `transmissionlog` (157,
**kein Parent** → GetFrame(0)) · `helptext` (158 ← ItemList) · `timer` (159) · `consoleecho` (160) ·
`build_templates.Init` (161) · `taunt.Init` (162) · `chat.SetupChatLayout` (164 ← Edit) ·
`minimap.CreateMinimap` (165 ← **eine zweite WorldView mit `isMiniMap = true`**, kein Canvas mit
Punkten) · `objectives2` (167-169, nur `campaignMode`) · `Prefetcher:Update` (191).

**`OnFirstUpdate`** (gamemain.lua:77-114, ausgelöst vom **ersten Frame** des controlClusters):
`EnableWorldSounds()` :78 · `GetArmyAvatars()` :79 · `avatars[1]:SetCustomName(nickname)` :84 ·
`UserMusic.StartPeaceMusic()` :86 · **`score.CreateScoreUI()`** :88 (steht **nicht** in `CreateUI`!) ·
`ForkThread`: `WaitSeconds(1.5)` → `UIZoomTo(avatars,1)` → `WaitSeconds(1.5)` → `SelectUnits(avatars)`
→ `FlushEvents()` → `worldview.UnlockInput()` :91-102.

Neue Bindungen: `GetArmyAvatars` (Cfile:1360885ff; Blueprint-Feld `General.QuickSelectPriority`,
Cfile:657062 — nur die 4 ACUs haben `= 1`), `GetIdleEngineers`/`GetIdleFactories` (1360975/1361090),
`AddConsoleOutputReciever` (454772), `GenerateBuildTemplateFromSelection` (1269110),
`SessionSendChatMessage` (1322062) + `gamemain.ReceiveChat` (1263605),
`GetSessionClients`/`SessionGetLocalCommandSource` (1321819/1330573), `HideGameUI` (1255891),
`IsNISMode` (1149084), `InternalCreateWldUIProvider` (1295462).
`SetLayout` (gamemain.lua:53-75) ruft `SetLayout` auf **15 Modulen** und ist
`UIUtil.changeLayoutFunction`.

**Priorisierung fürs 1:1-Gefühl** (jeder Schritt einzeln sichtbar): score (Uhr + Punkte) → tabs
(Menü) → avatars (ACU-Knopf) → controlgroups → minimap → chat. **Score, tabs, avatars, controlgroups,
timer, consoleecho, build_templates und taunt brauchen kein einziges neues Control** — nur Globals
(also nur M6).

**Betroffene Original-Lua:** `lua/ui/game/{gamemain,borders,score,tabs,avatars,controlgroups,
transmissionlog,helptext,timer,consoleecho,build_templates,taunt,chat,minimap,objectives2}.lua` +
die Layout-Dateien (`score_mini.lua` …).

**Verifikation:** `scripts/verify-ui-panels.ts` läuft gegen `gamemain.CreateUI(false)` statt gegen
`setupGameUi()` — gleiche Control-Zahl und Positionen wie heute, plus die 13 neuen Module; die vier
Cluster aus `borders.lua` sind die Eltern (nicht `GetFrame(0)`); `OnFirstUpdate` feuert **genau
einmal**; der Zeit-Text aus `GetGameTime()` ändert sich pro Beat.
**Danach: [CLAUDE.md](../CLAUDE.md) anpassen** — „Die Spiel-UI hat genau einen Aufbauweg:
`setupGameUi()`" ist ab hier falsch.

---

## M11 — Lobby: die Skirmish-Taste

**Größe: XL** · hängt an: M2, M5, M9 · Recherche: [frontend-menu](research/frontend-menu.md) §6

**Ziel-Erlebnis:** Das Ziel-Erlebnis wörtlich: Hauptmenü → **Skirmish** → Lobby (Karte, Fraktion,
Farbe, KI, Optionen) → Session. Und Multiplayer ist damit angelegt.

**Engine-Teile:** main.lua:909-922 ruft `lobby.CreateLobby('None', 0, playerName, nil, nil,
topLevelGroup, cb)` + `lobby.HostGame(name, scenarioFileName, true)`. Das braucht
`InternalCreateLobby` (Cfile:1168970 — Klasse **`CLobby` mit 18 Methoden**; lobbycomm.lua:121),
`InternalCreateDiscoveryService` (1168381, 3 Methoden), und der Start läuft über
`CLobby::LaunchGame` (Cfile:1170898) — eine große Engine-Funktion (LaunchInfoNew, ClientManager,
NetConnector). Auch im Single-Player geht es über `lobbyComm:LaunchGame(gameInfo)`
(lobby.lua:879/882). Voraussetzung aus M9: ItemList (Combo), Scrollbar, Edit, MapPreview.

**Betroffene Original-Lua:** `lua/ui/lobby/{lobby,lobbyComm,gameselect}.lua`,
`lua/ui/dialogs/mapselect.lua`, `lua/ui/maputil.lua`.

**Verifikation:** Browser (`?frontend`) — Klick auf „Skirmish" öffnet die Original-Lobby, die
Kartenauswahl zeigt die `MapPreview`; „Launch" ⇒ **dieselbe `sessionInfo`**, die
`verify-launch.ts` (M5) prüft, geht an `LaunchSinglePlayerSession`. Der Sim-Boot ist identisch — nur
der Weg dorthin ist neu.

---

## M12 — Movie/SFD, Splash und Audio-Ausgabe

**Größe: L–XL** · hängt an: M2 · Recherche: [frontend-menu](research/frontend-menu.md) §2.5/§5,
[maui-controls](research/maui-controls.md) §5, [effects-audio](research/effects-audio.md)

**Ziel-Erlebnis:** Splash-Logos, Hintergrundfilm im Hauptmenü, Menü-Musik, Einheiten-Sounds — der
Teil, der aus einem stummen Standbild ein Spiel macht.

**Engine-Teile:**

- **Movie.** `InternalCreateMovie(luaobj, parent)` (Cfile:1143258) + `moho.movie_methods` (7:
  `InternalSet`, `IsLoaded`, `Play`, `Stop`, `Loop`, `GetFrameRate`, `GetNumFrames`) + LazyVars
  **`MovieWidth`/`MovieHeight`** (Cfile:1142984-1142985) + `movie`-Kind im Renderer; Callbacks
  `OnStopped`, `OnFinished`, `OnSubtitle`, `OnFrame`. Format: **CRI Sofdec** (`.sfd` = MPEG-1-Video +
  CRI-ADX-Audio; Symbole `MWSFD_*`, `struct_sofdec_ply`, Cfile:44063-44075;
  `Moho::CMovie::GetWidth/GetHeight` 29109-29110).
  **`CMauiMovie::LoadFile` gibt `false` zurück, wenn `/nomovie` gesetzt ist**
  (Cfile:1143020-1143035); `movie.lua:32-53` fängt das ab (`local ok = self:InternalSet(…)` … `else
  self:OnStopped()`). Zweiter Original-Ausweg: `splash.lua:22-25` — bei
  `GetPreference("movie.nologo")` sofort `EngineStartFrontEndUI()`. → **Entscheidung nötig,
  KONFLIKT A.**
- **Splash.** `GetCursor()` (1274426) + Input-Capture (splash.lua:30/49), `SoundIsPrepared`,
  `StartSound`, `PlayVoice` (movie.lua:37-49 wartet darauf).
- **Audio — und hier ist CLAUDE.md falsch.** Es gibt **keine `sounds.scd`** und **kein FMOD**. Die
  Daten liegen im Klartext unter `<FA>/sounds/`: **78 `*.xwb`** (XACT Wave Banks, Magic `WBND`,
  Version 43), **80 `*.xsb`** (Sound Banks, Magic `SDBK`), **`SupCom.xgs`** (XACT Global Settings,
  Magic `XGSF`) — hex-verifiziert (effects-audio.md:19/217-288). Engine:
  `AudioEngine::Create("/sounds")` enumeriert `*.xwb`/`*.xsb`, `func_InitSound` lädt
  `/sounds/SupCom.xgs`. **1896 Cues** über alle 80 `.xsb`. `Sound{}` (`cfunc_SoundL`) baut ein
  `CSndParams` (`mBank`, `mCue`, `mLodCutoff` — **`LodCutoff` ist der Name einer XACT-Variablen**,
  z. B. `UnitMove_LodCutoff`, kein Zahlenwert). Musik: `lua/UserMusic.lua`, Bank `Music` (Cues
  `Main_Menu`, `Base_Building`, `Battle`). Ein XWB-Reader ist ~100 Zeilen; die
  **Cue→Sound→Track-Kette** von XACT ist die eigentliche Arbeit und ist **noch nicht verifiziert**
  (effects-audio.md:288).

**Betroffene Original-Lua:** `lua/maui/movie.lua`, `lua/ui/menus/splash.lua`,
`lua/ui/menus/main.lua:34-48`, `lua/UserMusic.lua`, `lua/ui/game/gamemain.lua:206` (Ladebildschirm).

**Verifikation:** headless — `main.lua:CreateBackMovie(GetFrame(0))` ⇒ Movie im Snapshot,
`Width == 1824 * (H/1024)` (main.lua:43-46). `__uiSoundsRequested` enthält nach `CreateUI()`
`AMB_Menu_Loop` und `Main_Menu`; nach `parent:Destroy()` ist bei beiden Handles `stopped = true`.
Browser: Hauptmenü mit laufendem Hintergrundfilm und Musik.

---

## Danach (nicht Teil dieses Plans)

Intel/FoW (Blips, Ghosts — [intel-vision.md](research/intel-vision.md)), Schilde, Beam-Waffen,
Assist (mehrere Bauer an einer Baustelle), Reclaim/Repair/Capture, Veterancy, Luft & Marine,
Partikel-System, Victory Conditions, KI, Lockstep/Replays, Kampagne, Mods.
→ [MASTERPLAN.md](MASTERPLAN.md), Phasen D–F.

---

# Konflikte & offene Fragen

## Zu entscheiden — vom Nutzer

**A. Movie: ehrlicher `false`-Pfad oder Sofdec-Decoder?**
Die beiden Recherchen bewerten dasselbe Verhalten gegensätzlich.
[frontend-menu.md](research/frontend-menu.md):96-101 nennt ein `InternalSet`, das `false` liefert,
*„das dokumentierte Engine-Verhalten, nicht ein Stub"* (Cfile:1143020-1143035, `/nomovie`).
[maui-controls.md](research/maui-controls.md):236-240 nennt genau das *„eine Lüge, solange die Datei
lesbar wäre"* und verlangt eine Entscheidung.
**Auflösung, die beide erfüllt:** `false` ist nur dann ehrlich, wenn es die **Folge eines gesetzten
Flags** ist. Also `/nomovie` bzw. `movie.nologo` als **explizite, sichtbare** Kommandozeile/Preference
führen (die Engine hat beide) — ein `InternalSet`, das ohne gesetztes Flag stumm `false` liefert,
wäre ein Stub im Produktivpfad und ist verboten.
**Offen bleibt die Nutzer-Entscheidung:** Sofdec-Decoder (MPEG-1 + CRI-ADX) bauen, oder die Flags
dauerhaft gesetzt lassen? Das Hauptmenü läuft **beide** Wege.

**B. Skirmish-Taste (Lobby) oder Kommandozeilen-Start?**
Es gibt **keinen** originalgetreuen Weg vom Menü in eine Skirmish-Session **ohne** die Lobby:
main.lua:909-922 geht über `lobby.CreateLobby`/`HostGame` → `CLobby` (18 Methoden, `LaunchGame`
@Cfile:1170898). Der billigere, aber ebenfalls **echte** Weg ist `StartCommandLineSession` (`/map`,
Cfile:1373521/1373668 → `LaunchSinglePlayerSession`) — das ist M5. Der Plan setzt M5 zuerst.
**Frage:** Reicht `?map=<x>` als Zwischenstand (dann M6–M10 vorziehen), oder soll M11 sofort nach M5
kommen, weil das Ziel-Erlebnis wörtlich „Skirmish" sagt?

**C. Determinismus jetzt oder später?**
`Sim::Setup` sät einen Mersenne-Twister aus `sessionInfo.RandomSeed` (Cfile:1071820) — die Sim ist
reproduzierbar. Unser `Random` gibt es noch nicht; wird es `Math.random`, ist sie es nicht mehr
(Konsequenz für Replays und Multiplayer). **M4 und M8 legen beide Zufallsquellen an** — nachträglich
einzuziehen heißt, jede noch einmal anzufassen. Der **exakte** Generator ist nicht binär verifiziert.

## Widersprüche zwischen den Recherchen — aufgelöst

**1. Wohin gehen Key-Events?**
[input-cursor-keymap.md](research/input-cursor-keymap.md):193-201 markiert das als **OFFEN** („die
Stelle … in der Decomp nicht gefunden"). [maui-controls.md](research/maui-controls.md):92-101 **hat
sie**: drei Dispatcher — `MET_KeyDown` @Cfile:1147634, `MET_KeyUp` @1147668, `MET_Char` @1147745 —
alle mit derselben Reihenfolge: **Fokus-Control zuerst** (liefert es `false`, wird der Capture-Stack
**nicht** gefragt; das Event geht als `skipped` an die Konsolen-Keymap), **sonst** Capture-Top, sonst
nichts. Das ist mit `MakeInputModal` verträglich: ein modaler Dialog hat in der Regel *kein*
Fokus-Control, also greift Stufe 2.
**Bleibt offen:** ob Key-Events die **Parent-Kette** hochbubbeln — `PostEvent` (Cfile:1124517) wird
für Keys nirgends aufgerufen, `MakeInputModal` (uiutil.lua:615-645) verlässt sich aber darauf, dass
`HandleEvent` des Capture-Controls sie sieht. → In M1 als **Annahme markieren** (Capture-Top bekommt
sie direkt, kein Bubbling) und beim ersten Widerspruch nachziehen.

**2. Wann fällt der `draws()`-Filter im Hit-Test?**
[maui-controls.md](research/maui-controls.md) (Schritt 9) und
[worldview-camera.md](research/worldview-camera.md) (S2) sagen dasselbe, aber es ist eine **harte
Kopplung**, die man übersieht: Der Filter darf **erst** fallen, wenn `CUIWorldView` steht (vorher
frisst die Vollbild-Group jeden Klick), und er **muss** fallen, sobald sie steht (sonst nehmen
Minimap und Chat-Fenster keine Klicks an). **Beides gehört in einen Commit** (M7, Punkt 9).

**3. „Für die Session-UI fehlt kein einziges maui-Control" vs. „`border_methods` ist eine leere
Klasse".** Beides steht in [maui-controls.md](research/maui-controls.md) (§5 vs. §4.1) und beißt sich
nur scheinbar: der Border ist **halb** gebaut (`InternalCreateBorder` + LazyVars da, Methoden nicht).
Unsere Panels laufen heute nur, weil **noch niemand `SetNewTextures` ruft**. → **M1**, nicht später.

**4. WorldView früh oder spät?** [session-ui-panels.md](research/session-ui-panels.md) stellt
`CUIWorldView` an Position 10 seiner Liste, [worldview-camera.md](research/worldview-camera.md)
behandelt es als Fundament. **Auflösung:** für die **heutigen Panels** ist es nicht blockierend (die
laufen), für **alles andere** ist es der Flaschenhals (Minimap, Cursor, Dragger, Box-Selektion,
Hit-Test) — und `gamemain.CreateUI` ruft es an Zeile 142. Darum hier **M7, vor M10**.

**5. Audio: CLAUDE.md und STATUS.md sind falsch.** Beide sagen „FMOD-Bänke aus `sounds.scd`"
(STATUS.md verweist zusätzlich auf ein `research/sound-fmod.md`, **das nicht existiert**). Die
hex-verifizierte Recherche [effects-audio.md](research/effects-audio.md):19/217-224 sagt: **XACT**
(78 `.xwb`/`WBND`, 80 `.xsb`/`SDBK`, `SupCom.xgs`/`XGSF`), und **es gibt keine `sounds.scd`**.
→ CLAUDE.md und STATUS.md korrigieren (mit M12).

**6. `Random` hat drei Kunden, aber nur eine Bindung.** session-start (Mersenne, Seed aus
`sessionInfo.RandomSeed`, Cfile:1071820), combat (ohne `Random` stirbt `DeathThread` sofort) und
scenarioutilities.lua:391. Sie muss von Anfang an der **deterministische Sim-RNG** sein, nicht
`Math.random` (→ Entscheidung C).

## Erfundene Werte im Produktivpfad — müssen weg

| Wo | Was | fällt in |
|---|---|---|
| [ui-globals.lua](../src/engine-lua/ui-globals.lua):654 | `GetVersion() → 'CFA'` — steht sichtbar im Hauptmenü (main.lua:172). Quelle des echten Strings **ungeprüft** (Core-Global, Cfile:599401). | M2 |
| [moho.lua](../src/engine-lua/moho.lua):522 | `GetTopmostDepth() → 5000000` — geraten. Echte Bindung Cfile:1136937, Rückgabewert **ungelesen**. | M1 |
| [globals.lua](../src/engine-lua/globals.lua):42-43 | `IsAlly`/`IsEnemy` vergleichen Armee-Indizes statt der Allianz-Tabelle. | M4/M8 |
| [unitViewer.ts](../src/viewer/unitViewer.ts) | `rtsPitch()` erfindet die Pitch↔Zoom-Kurve; die echte steckt in `CameraImpl` und ist **nicht ausgelesen**. | M7 |
| [session.ts](../src/sim/session.ts):61-72 | `ScenarioInfo` von Hand gebaut statt deserialisiert. | M4 |

## Weiter offen — nicht raten, beim Bau als Annahme markieren

1. **`Projectile::CheckCollision` (@0x69D1D0) ist nicht dekompilierbar** (IDA scheitert an 0xC9A
   Bytes). Kollisionsvolumen (`CollisionShape` Box/Sphere aus `SizeX/Y/Z`) oder Bounding-Radius?
   `Wm3::DistVector3Segment3f::GetSquared` legt „Abstand Strecke↔Punkt gegen Radius" nahe — belegt
   ist es nicht. (M8)
2. **`ui_SelectTolerance` — Pixel oder Weltmeter?** `UpdateSelection` weitet die Box **vor** dem
   Strahltest auf (Cfile:1298979), was auf Screen-Pixel deutet. Nicht verifiziert. (M7)
3. **`COMMOD_Ping`** — der Enumwert ist **nicht belegt**; `None=0, Order=1, Build=2, BuildAnchored=3,
   Select=4, CommandDrag=5` sind aus dem Code abgeleitet. (M7)
4. **`CameraScreenToSurface` vs. `Unproject`** — bezieht `ScreenToSurface` die Wasseroberfläche mit
   ein? (Klicks aufs Meer.) Und die **Pitch↔Zoom-Kopplung** in `CameraImpl` ist nicht ausgelesen. (M7)
5. **`SetRenderPass(UIUtil.UIRP_UnderWorld | UIUtil.UIRP_PostGlow)`** (worldview.lua:39,
   Originalkommentar: *„don't change this or the camera will lag one frame behind"*) — die Welt wird
   **zwischen** UI-Render-Pässen gezeichnet. Was das für einen DOM-über-Canvas-Renderer heißt
   (Z-Reihenfolge, Ein-Frame-Versatz), ist offen. (M7)
6. **`RUnitBlueprintWeapon`-Ctor** ist im Cfile nicht als eigene Funktion auffindbar; die
   Weapon-Blueprint-Defaults (`FiringTolerance 0.01`, `RateOfFire 1.0`, `TrackingRadius 1.0`,
   `TargetCheckInterval 3.0`, `HeadingArcRange 180`, `IgnoresAlly 1`) stammen bisher **nur aus
   faf-re** ([weapons.md](research/weapons.md)) — vor der Übernahme in `blueprints.lua` binär
   gegenprüfen. (M8)
7. **Blips.** Die Zielerfassung läuft im Original über die Aufklärungs-DB (`unit->mBlipsInRange`,
   Cfile:793167). Wir haben keine. „Alle Units der Feind-Armee im Radius" ist eine **bewusste
   Abweichung**, kein Nachbau — sie fällt erst mit [intel-vision.md](research/intel-vision.md). (M8)
8. **`currentScores` wird in der Retail-Lua nirgends gesetzt** (score.lua:10 `currentScores = false`;
   gelesen in score.lua:243 und objectives2.lua:130). Woher kommt die Punktzahl — pro Beat aus
   `GetArmyScore(i)`, oder aus einem Sim-Skript, das wir nicht gefunden haben? (M10)
9. **Wie kommt `Sync` über die Worker-Grenze?** Das Original nutzt `SCR_ToByteStream`/
   `SCR_FromByteStream` (Cfile:1328276). Bei uns structured clone — aber nur, solange in `Sync` keine
   Lua-Funktionen/Userdata stehen. Zu prüfen. (M6)
10. **`GetGameTime` liefert einen String, `GameTime` Sekunden** — das Format ist in
    `cfunc_GetGameTimeL` (Cfile:1266614) noch nicht ausgelesen. (M6)
11. **`IsSignedInToSteam()`** (main.lua:900) steht **nicht** in `scr_UserInits` (205 Globals). Die
    `lua.scd` des Nutzers ist also aus einem **anderen Build** als `Cfile/ForgedAlliance.exe.c`. Heute
    betrifft es nur den Matchmaking-Knopf — aber es ist ein Riss zwischen Quelle 1 (Decomp) und
    Quelle 2 (Original-Lua). Gibt es weitere? Wer gewinnt im Konfliktfall? (M2/M11)
12. **`SetArmyStart` hat kein `y`**; `CreateInitialArmyUnit` konstruiert mit `pos.y = 0.0`
    (Cfile:1025261). Setzt der Unit-Ctor die Höhe aus dem Heightfield, oder der erste Motion-Tick?
    Nicht nachgesehen. (M4)
13. **Zwei Prop-Quellen:** „ Sim Setup 7" (Cfile:1072049-1072081) erzeugt Props aus der `LaunchInfo`,
    parallel zu `ScenarioUtils.CreateProps()` aus dem schook-Hook. Vermutlich ist der C++-Pfad für
    gespeicherte Spiele/Replays — **nicht verifiziert**. Für Skirmish reicht der Lua-Pfad. (M4)
14. **Gilt der Hook-Mechanismus auch für `import()`?** Belegt ist er für den Datei-Load
    (Cfile:595822). Für unsere 8 schook-Dateien irrelevant (alle per `doscript`), für Mods später
    nicht. (M4)
15. **`AcquireKeyboardFocus(bool blocksKeyDown)`** — wohin das Flag wirkt, ist nicht verfolgt
    (Cfile:1125768-1125790). Vermutlich entscheidet es, ob ein unbehandeltes `KeyDown` zur Keymap
    durchfällt. (M1/M3)
16. **`FlushEvents`** — welche Queue (wx oder maui)? Ohne Kenntnis der Wirkung wäre ein No-Op hier ein
    Stub, also verboten. (M2)
17. **`MET_MouseHover` (=3)** wird von uns nie erzeugt. Wer löst es aus, nach welcher Verzögerung?
    (Tooltips hängen heute an `MouseEnter`.) (M1)
18. **`ScrollPages`** — in der Decomp gibt es `RunScript`-Callsites für `GetScrollValues`,
    `ScrollLines` und `ScrollSetTop`, aber **keine** für `ScrollPages`; die Lua implementiert es
    trotzdem (filepicker.lua:307). (M9)
19. **Die XACT-Cue→Sound→Track-Kette** ist **nicht** verifiziert (nur die Kopfstrukturen von WBND und
    SDBK sind hex-geprüft, effects-audio.md:288). (M12)
20. **Das Blueprint wird zweimal gelesen** — TS-Parser in `main.ts` (Modelle/Knochen) **und** die
    echte `LoadBlueprints()`-Pipeline. Zwei Wahrheiten. M8 braucht Bone-Transforms in der Sim;
    spätestens dort muss entschieden werden, wer die Quelle ist.
