# Die komplette Session-UI — Inventar aus `gamemain.lua`

Was die Engine beim Session-Start in der UI-VM aufbaut, was jedes Panel dafür von der
Engine verlangt, und in welcher Reihenfolge der Beat-/Sync-Kreislauf läuft.

Bezug: [engine-api.md](engine-api.md) (Bindungen je VM), [game-shell.md](game-shell.md),
[ui-complete.md](ui-complete.md). Ist-Stand: `src/lua/uiEngine.ts` (`setupGameUi`),
`src/engine-lua/ui-globals.lua`, `src/engine-lua/ui-globals-missing.lua`.

## 1. Überblick

Die Engine baut die Spiel-UI **nicht** selbst. Sie ruft genau einen Einstiegspunkt:
`WldUIProvider.CreateGameInterface` (gamemain.lua:316) → `CreateUI(isReplay)`
(gamemain.lua:116-192). Alles darin ist Original-Lua. Die Engine liefert nur
Primitive: maui-Controls, Session-Auskünfte (`GetArmiesTable`, `SessionGetScenarioInfo`),
Selektion, Kamera, Sound — und **den Takt** (Frame-Pumpe + Sim-Beat).

Unser `setupGameUi()` (uiEngine.ts:169-212) ist eine handgeführte Teilmenge von
`CreateUI`: Screen-Group → borders → economy, multifunction, orders, construction,
unitview, unitviewDetail. Es fehlen **13 Module** aus derselben Funktion.

## 2. Ablauf / Callchain

### 2.1 Session-Start (Engine → Lua)

```
CUIManager (UI-VM)  ── userinit.lua ──> globalInit.lua, Prefetcher = CreatePrefetchSet()  (userinit.lua:11/27)
CWldSession         ── WldUIProvider ──> provider.CreateGameInterface(isReplay)           (gamemain.lua:316)
                                          └─> CreateUI(isReplay)                          (gamemain.lua:116)
```

`CreateUI` in exakter Reihenfolge (Zeile → Aufruf → Parent):

| gamemain | Aufruf | Parent |
|---|---|---|
| 117 | `ConExecute("Cam_Free off")` | — |
| 122 | `UIUtil.changeLayoutFunction = SetLayout` | — |
| 125-128 | `GetFocusArmy()` → `LocGlobals.PlayerName` aus `GetArmiesTable()` | — |
| 130 | `GameCommon.InitializeUnitIconBitmaps(prefetchTable.batch_textures)` | — |
| 132 | `UIUtil.CreateScreenGroup(GetFrame(0), "GameMain ScreenGroup")` | Frame 0 |
| 134 | `borders.SetupBorderControl(gameParent)` → **controlCluster, statusCluster, mapGroup, windowGroup** | gameParent |
| 136-140 | `controlClusterGroup.OnFrame` → **einmalig `OnFirstUpdate()`**, dann `SetNeedsFrameUpdate(false)` | — |
| 142/143 | `worldview.CreateMainWorldView(gameParent, mapGroup)` + `LockInput()` | mapGroup |
| 145 | `economy.CreateEconomyBar(statusClusterGroup)` | statusCluster ✔ |
| 146 | `tabs.Create(mapGroup)` | mapGroup |
| 148 | `multifunction.Create(controlClusterGroup)` | controlCluster ✔ |
| 150 | `orders.SetupOrdersControl(controlCluster, mfdControl)` (nicht im Replay) | controlCluster ✔ |
| 152 | `construction.SetupConstructionControl(controlCluster, mfd, orders)` | controlCluster ✔ |
| 153 | `unitview.SetupUnitViewLayout(mapGroup, ordersControl)` | mapGroup ✔ |
| 154 | `unitviewDetail.SetupUnitViewLayout(mapGroup, mapGroup)` | mapGroup ✔ |
| 155 | `avatars.CreateAvatarUI(mapGroup)` | mapGroup |
| 156 | `controlgroups.CreateUI(mapGroup)` | mapGroup |
| 157 | `transmissionlog.CreateTransmissionLog()` | **kein Parent** (GetFrame(0)) |
| 158 | `helptext.CreateHelpText(mapGroup)` | mapGroup |
| 159 | `timer.CreateTimerDialog(mapGroup)` | mapGroup |
| 160 | `consoleecho.CreateConsoleEcho(mapGroup)` | mapGroup |
| 161 | `build_templates.Init()` | — |
| 162 | `taunt.Init()` | — |
| 164 | `chat.SetupChatLayout(windowGroup)` | windowGroup |
| 165 | `minimap.CreateMinimap(windowGroup)` | windowGroup |
| 167-169 | `objectives2.CreateUI(mapGroup)` — **nur `campaignMode`** | mapGroup |
| 171-173 | `multihead.CreateSecondView()` — nur bei `GetNumRootFrames() > 1` | Frame 1 |
| 175-189 | `HandleEvent` auf beiden Clustern: `WheelRotation` → `worldview.ForwardMouseWheelInput` | — |
| 191 | `Prefetcher:Update(prefetchTable)` | — |

✔ = bei uns bereits gebaut. `diplomacy.lua` wird **nicht** von gamemain gestartet — es
hängt an tabs.lua (Menü) und `SimCallback`.

`OnFirstUpdate` (gamemain.lua:77-114, ausgelöst vom **ersten Frame** des controlClusters):
`EnableWorldSounds()` :78 · `GetArmyAvatars()` :79 · `GetArmiesTable()` :81 ·
`avatars[1]:SetCustomName(nickname)` :84 · `UserMusic.StartPeaceMusic()` :86 ·
**`score.CreateScoreUI()`** :88 (nicht in `CreateUI`!) · `PlaySound(...)` :90 ·
`ForkThread`: `WaitSeconds(1.5)` → `UIZoomTo(avatars,1)` → `WaitSeconds(1.5)` →
`SelectUnits(avatars)` → `FlushEvents()` → `worldview.UnlockInput()` :91-102 ·
Fraktions-Skin über `Prefs.GetOption('skin_change_on_start')` :104-113.

`SetLayout(layout)` (gamemain.lua:53-75) ruft `SetLayout` auf **15 Modulen** —
u. a. `missiontext`, `helptext`, `score`, `avatars`, `tabs`, `controlgroups`, `chat`,
`minimap`, `objectives2`. Es ist `UIUtil.changeLayoutFunction`, läuft also bei jedem
Skin-/Layout-Wechsel.

`StopLoadingDialog` → `InitialAnimations` (gamemain.lua:253-264):
tabs → (0,15 s) → economy, score → (0,15 s) → multifunction, avatars, controlgroups →
`HideGameUI('off')`.

### 2.2 Der Beat-/Sync-Kreislauf (Decomp)

Pro **Sim-Beat** (10 Hz, auch wenn pausiert — usersync.lua:1-2):

```
SIM-VM:  Sim::Sync (@Cfile:1074261)
           Sync.PausedBy / Sync.TimeoutsRemaining        (Cfile:1074663-1074676)
           Sync.__ArmyStats { Tick = mCurTick, ... }     (Cfile:~1074688)
           Sync.Cheaters                                 (Cfile:~1074753)
           → Byte-Stream in SSyncData.mStream
           SCR_LuaDoString("ResetSyncTable()")           (Cfile:1074773 → simsync.lua:9)

UI-VM:   CWldSession::DoBeat (@Cfile:1327644)
           PreviousSync = SCR_Copy(Sync)                 (Cfile:1328263-1328269)
           Sync        = SCR_FromByteStream(mStream)     (Cfile:1328276-1328280)
           SCR_LuaDoString("OnSync()")                   (Cfile:1328286 → usersync.lua:14)
           ... Kamera/Viz-Updates ...
           UI_Manager->OnBeat()                          (Cfile:1328540)
             └ CUIManager::DoBeat (@Cfile:1273907, 0x84D310)
                 ├ UI_FactoryCommandQueueHandlerBeat     (Cfile:1256904)
                 │    └ gamemain.OnQueueChanged(queue)   (Cfile:1256936)
                 └ UI_LuaBeat                            (Cfile:1262940)
                      └ gamemain.OnBeat()                (Cfile:1262957 → gamemain.lua:437)
```

**Die Reihenfolge ist Semantik:** `OnSync()` (merged `Sync.UnitData` in `UnitData`,
usersync.lua:44-50) läuft **vor** `gamemain.OnBeat()`. Wer erst OnBeat rechnet, zeigt
die Daten des vorigen Beats.

`gamemain.OnBeat` (gamemain.lua:437-441) ruft nur die Liste aus `AddBeatFunction`
(gamemain.lua:423). Registriert sind: economy.lua:239, avatars.lua:70/747,
score.lua:86, objectives2.lua:109, rallypoint.lua:56, commandmode.lua:87,
connectivity.lua:147.

**Pro UI-Frame** (nicht pro Beat) laufen dagegen: `OnFrame`/`SetNeedsFrameUpdate`
(u. a. `OnFirstUpdate`, gamemain.lua:136-140), die maui-Animationen und — laut
userinit.lua:13-21 — die **Lua-Threads der UI**: `WaitFrames = coroutine.yield`,
`WaitSeconds(n)` pollt `CurrentTime()`. Die UI-VM hat also **keinen** Tick-Scheduler.

Weitere Engine→gamemain-Rückrufe: `OnSelectionChanged` (SelectionListener::Receive,
Cfile:1294170 → :1294453), `OnUserPause` (Cfile:1294560), `ReceiveChat`
(func_ReceiveChat, Cfile:1263605 → :1263628), `OnDetectAdjacencyBonus`
(Cfile:1263749), `OnFocusArmyUnitDamaged` (UserUnit::NotifyFocusArmyUnitDamaged,
Cfile:1364255 → :1364271), `HideGameUI` (CON_UI_ToggleGamePanels, Cfile:1255891),
`IsNISMode` (Cfile:1149084, :1258822).

## 3. Fehlende Engine-Bindungen

`ui-globals-missing.lua` listet 200 Namen; **66 sind implementiert, 134 fehlen**.
Aus der Decomp gezählt sind es aber **205** `<global>`-Bindungen in `scr_UserInits` —
in engine-api.md **und** in unserer Lückenliste fehlen: **`EnableWorldSounds`**,
`DisableWorldSounds`, `StopAllSounds`, `CreateUnitAtMouse`.
`EnableWorldSounds` (Cfile:1348521, `mPrevDef = scr_UserInits`, :1348548) ist die
**erste Zeile** von `OnFirstUpdate` — ohne sie kommt die Session-UI nicht hoch.

### Die Bindungen, die die Session-Panels brauchen

| Name | Semantik (Decomp) | Beleg | Wer braucht sie |
|---|---|---|---|
| `EnableWorldSounds` | Welt-Sounds an (CUserSoundManager) | Cfile:1346188/1348521 | gamemain:78 |
| `GetArmiesTable` | `{numArmies, focusArmy, armiesTable[i] = {name, nickname, faction, color, iconColor, showScore, civilian, human, outOfGame, authorizedCommandSources}}` | Cfile:1266971-1267112 | gamemain:81/127, score:180/242, avatars:**30 (Modulebene!)**/664, chat:541/795, diplomacy:39 |
| `SessionGetScenarioInfo` | ScenarioInfo, wie es der Sim beim Start übergeben wurde | Cfile:1330883 | score:**28 (Modulebene!)**, tabs:20, diplomacy:34 |
| `GetArmyAvatars` | Avatar-Units der **Focus**-Armee (+ angedockte Pods über `PODSTAGINGPLATFORM`/`POD`) als UserUnits | Cfile:1360885ff, :1360757; Blueprint-Feld `General.QuickSelectPriority` (Cfile:657062-657063; nur die 4 ACUs haben `= 1`) | gamemain:79, avatars:658 |
| `GetIdleEngineers` / `GetIdleFactories` | Tabellen der untätigen Bauer/Fabriken der Armee | Cfile:1360975 / :1361090 | avatars:35/659/660 |
| `UISelectAndZoomTo(unit,[s])` / `UIZoomTo(units,[s])` | selektieren + Kamera drauf | Cfile:1292599 / :1292715 | avatars:42/377, gamemain:94, selection:111 |
| `GetGameTime` | **formatierter String** der Spielzeit | Cfile:1266614 | score:228/230, objectives2:129, transmissionlog:265 |
| `GameTime` | Spielzeit in **Sekunden** (Sim-Zeit, hält bei Pause) | Cfile:1361870 | score:301, objectives2:139 |
| `FormatTime(seconds)` | String aus Sekunden | Cfile:1266840 | timer:64/94 |
| `GetArmyScore(armyIndex)` | int | Cfile:1267137 | score (Punkte) |
| `SimCallback({Func=..,Args=..})` | Lua-Funktion in der Sim ausführen (`/lua/simcallbacks.lua`) | Cfile:1359123 | controlgroups:155/166, selection:97, objectives2:104, diplomacy:91 |
| `ValidateUnitsList` | tote Units aus einer Liste werfen | Cfile:1360576 | controlgroups:102, selection:82/132 |
| `GetSystemTimeSeconds` | Wanduhr (Doppelklick-Erkennung) | Cfile:1266799 | selection:101/143 |
| `AddConsoleOutputReciever(func)` → handler | Konsolen-Ausgabe abgreifen | Cfile:454772 | consoleecho:35/40 |
| `AddInputCapture` / `RemoveInputCapture` / `GetInputCapture` / `AnyInputCapture` | Capture-**Stack** für Tastatur/Maus | Cfile:1147773-1147921 | transmissionlog:240/246, missiontext:405/445, chat |
| `IsKeyDown(keyCode)` | Taste gedrückt? | Cfile:1141963 | controlgroups, chat |
| `GetCursor()` | Cursor-Objekt (`SetTexture`, `Reset`) | Cfile:1274426 | minimap:54/61, chat:104, worldview:147 |
| `GetCamera(name)` → CameraImpl (25 Methoden) | Kamera nach Name (`WorldCamera`, `MiniMap`) | Cfile:1151854; engine-api.md „CameraImpl" | minimap:128, chat:280/752, objectives2:337 |
| `FlushEvents` | Maus-/Tastatur-Events verwerfen | Cfile:1274594 | gamemain:97/297/327 |
| `GetCurrentUIState` | `'splash'`\|`'frontend'`\|`'game'` | Cfile:1265924 | borders:101 (SplitMapGroup) |
| `SessionGetLocalCommandSource` / `SessionGetCommandSourceNames` / `GetSessionClients` | Netz-Identität | Cfile:1330573 / :1330491 / :1321819 | gamemain:383, tabs:721, chat:545/568 |
| `SessionSendChatMessage([clients,] msg)` | → Engine → `gamemain.ReceiveChat` | Cfile:1322062 | chat:756/758, taunt:99, build_templates:89 |
| `SessionRequestPause` / `SessionResume` / `SessionIsPaused` | Pause (bestätigt über `OnPause`) | Cfile:1330316/:1330361/:1330406 | tabs:425/428, missiontext:374 |
| `GetGameSpeed` / `SetGameSpeed` | −10…+10 | Cfile:1322407 / :1322458 | gamemain:555, score |
| `GenerateBuildTemplateFromSelection` | Bau-Template aus Selektion | Cfile:1269110 | build_templates:14 |
| `PlayVoice` / `StopSound` / `PauseSound` / `PauseVoice` | Audio | Cfile:1348652/:1348237/:1347882/:1347956 | taunt:87/88, gamemain:386-388 |
| `IsObserver`, `WorldIsPlaying`, `GetSimRate`, `CurrentTime`, `Random`, `print` | Kleinkram | Cfile:1266560, :1322303, :1266914 | diverse |

### Engine-**Controls**, die fehlen (maui-Klassen, engine-api.md „Klassen (23)")

| Control | Binding | gebraucht von |
|---|---|---|
| `CMauiItemList` (19 Methoden) | `InternalCreateItemList` (Cfile:1140074) | **helptext:98/146**, transmissionlog, chat |
| `CMauiEdit` (31) | `InternalCreateEdit` (Cfile:1133710) | **chat:601** |
| `CMauiScrollbar` (4) | `InternalCreateScrollbar` (Cfile:1144735) | chat, itemlist-Begleiter |
| `CUIWorldView` (17) | `__init` der moho-Klasse (worldview.lua:96 `Class(moho.UIWorldView, Control)`) | **worldview, minimap:115** |
| `CameraImpl` (25) | `GetCamera` | worldview, minimap |
| `CMauiMovie` (7) | `InternalCreateMovie` | Ladebildschirm, transmissionlog |
| `CUIWorldMesh` (16) | `InternalCreateWorldMesh` | rallypoint, commandmeshes |

**Nicht** nötig: `Checkbox`, `Button`, `Group`, `StatusBar`, `Grid`, `Slider`,
`Window`, `MultiLineText`, `Combo` — das sind reine Lua-Kompositionen aus
Bitmap/Group/Text (nur bitmap, border, dragger, edit, frame, group, histogram,
itemlist, mesh, movie, scrollbar, text rufen `InternalCreate*`).

**Folge:** `score`, `tabs`, `avatars`, `controlgroups`, `timer`, `consoleecho`,
`build_templates`, `taunt` brauchen **kein einziges neues Control** — nur Globals.

### Sync-Daten, die die Panels erwarten

Die Session-Panels lesen `Sync` **nicht direkt** (einziger Treffer in `lua/ui/`:
`orders.lua:909 UnitData[unit:GetEntityId()]`). Sie fragen die Engine-Globals ab.
`usersync.lua` verteilt: `Sync.Sounds` → `PlaySound` (:22), `Sync.UnitData` → `UnitData`
(:44), `Sync.ReleaseIds` (:48), `Sync.RequestingExit` (:16), `Sync.UserConRequests`
(:38). Die Sim-Seite legt die Tabelle bei jedem Beat neu an (simsync.lua:9-31:
`CameraRequests, Sounds, Voice, GameResult, PlayerQueries, QueryResults,
OperationComplete, UnitData, ReleaseIds`).

## 4. Ist-Stand

**Da:** Screen-Group + die vier Cluster aus `borders.lua`, economy, multifunction,
orders, construction, unitview, unitviewDetail (uiEngine.ts:176-207) — alles über die
Original-Lua. `usersync.lua` ist geladen (uiEngine.ts:93), `UnitData` existiert.
`gamemain.OnSelectionChanged` wird korrekt aus `SelectUnits` gerufen
(ui-globals.lua:238-264).

**Falsch/fehlt:**

1. **Der Beat läuft nicht über gamemain.** `gameUi.beat()` ruft
   `Economy._BeatFunction()` direkt (gameUi.ts:161) — an `AddBeatFunction`/`OnBeat`
   vorbei. Jedes weitere Panel mit Beat-Funktion (score, avatars, objectives2,
   rallypoint, commandmode) bliebe damit tot.
2. **Kein Sync-Kreislauf.** `Sync` bleibt `{}`, `OnSync()` wird nie gerufen,
   `PreviousSync` nie gesetzt. Der Worker schickt stattdessen einen TS-Snapshot
   (`__uiSetUnit`, `__uiSetEconomy`).
3. **`CreateUI` wird nie ausgeführt** — wir bauen die Panels von Hand. Damit fehlt auch
   `OnFirstUpdate` (der `OnFrame`-Einmalhaken auf dem controlCluster).
4. **`userinit.lua` läuft nicht:** kein `Prefetcher`, kein `FrontEndData`, kein
   `__language`. Und die UI-VM benutzt den **Sim**-Scheduler (`threads.lua`,
   tick-basiert) statt `WaitFrames = coroutine.yield` + `CurrentTime()`
   (userinit.lua:13-21).
5. **134 Globals fehlen** (+ 4, die in keiner Liste stehen, s. o.).

## 5. Bau-Reihenfolge

Jeder Schritt ist einzeln verifizierbar.

1. **Beat ehrlich machen.** `gameUi.beat()` → `import('/lua/ui/game/gamemain.lua').OnBeat()`
   statt `Economy._BeatFunction()`. *Verify:* Suite prüft, dass `economy.lua` sich über
   `AddBeatFunction` registriert hat und der Text nach einem OnBeat steht.
2. **Sync-Kreislauf.** Sim-Worker serialisiert das `Sync`-Table nach jedem Beat und
   ruft `ResetSyncTable()`; die UI setzt `PreviousSync = Sync`, `Sync = <empfangen>`,
   `OnSync()` — **vor** `OnBeat()`. *Verify:* eine Unit in `Sync.UnitData` taucht in
   `UnitData[id]` auf; `orders.lua:909` liest sie.
3. **Session-Globals** (kein neues Control): `SessionGetScenarioInfo`, `GetArmiesTable`,
   `GetGameTime`, `GameTime`, `GetArmyScore`, `IsObserver`, `EnableWorldSounds`,
   `FlushEvents`, `CurrentTime`. *Verify:* `import('/lua/ui/game/score.lua')` lädt ohne
   Fehler (score.lua:28 ist Modulebene!).
4. **`score.CreateScoreUI()`** — hängt an `GetFrame(0)` (score.lua:38), Layout
   `score_mini.lua`. *Verify:* Zeit-Text im maui-Snapshot, ändert sich pro Beat.
5. **`tabs.Create(mapGroup)`** — nur Checkbox/Bitmap/Group. Menü-Knöpfe
   (`RestartSession`, `ExitApplication`…) dürfen weiter knallen; sie werden erst beim
   Klick gerufen.
6. **`avatars.CreateAvatarUI(mapGroup)`** — braucht `GetArmyAvatars` (Focus-Armee ×
   `QuickSelectPriority`), `GetIdleEngineers`, `GetIdleFactories`, `UISelectAndZoomTo`.
   *Verify:* ACU-Knopf erscheint, `AvatarUpdate` läuft im Beat.
7. **`controlgroups.CreateUI(mapGroup)`** + `ValidateUnitsList` + `SimCallback` (Sim:
   `/lua/simcallbacks.lua`, `OnControlGroupAssign`/`OnControlGroupApply`) + `IsKeyDown`.
8. **`timer`, `consoleecho`, `build_templates`, `taunt`** — billig: `FormatTime`,
   `AddConsoleOutputReciever`, `GenerateBuildTemplateFromSelection`, `PlayVoice`.
9. **`InternalCreateItemList`** → `helptext.CreateHelpText(mapGroup)`,
   `transmissionlog`.
10. **`CUIWorldView` + `GetCamera`/`CameraImpl`** → `worldview.CreateMainWorldView`
    und `minimap.CreateMinimap(windowGroup)`. Der große Brocken; danach kann
    `worldCommands.ts` (TS-Nachbau) fallen.
11. **`InternalCreateEdit` + `SessionSendChatMessage`/`GetSessionClients`/`ReceiveChat`**
    → `chat.SetupChatLayout(windowGroup)`.
12. **`gamemain.CreateUI(false)` als EINZIGER Aufbauweg** — `setupGameUi()` in
    uiEngine.ts entfällt, `OnFirstUpdate` kommt aus der Frame-Pumpe.

**Priorisierung fürs 1:1-Gefühl:** score (Uhr + Punkte oben rechts) → tabs (Menü) →
avatars (ACU-Knopf) → controlgroups → minimap → chat. Score und tabs sind die
sichtbarsten Lücken und kosten kein einziges neues Control.

## 6. Offene Fragen

- **`currentScores` wird in der Retail-Lua nirgends gesetzt** (score.lua:10
  `currentScores = false`; gelesen in score.lua:243 und objectives2.lua:130). Woher
  kommt die Punktzahl — pro Beat aus `GetArmyScore(i)`, oder über ein Sim-Skript, das
  wir noch nicht gefunden haben? (Ohne Beleg nicht raten.)
- **`GetArmyAvatars`:** dass `General.QuickSelectPriority` das Blueprint-Feld ist, ist
  belegt (Cfile:657062: „Indicates unit has it's own avatar button in the quick select
  interface, and it's sorting priority"). Ob die Engine die Liste daraus baut oder aus
  einer eigenen Kategorie, ist im Decomp noch nicht bis zur Quelle verfolgt.
- **Wie kommt `Sync` über die Worker-Grenze?** Das Original nutzt
  `SCR_ToByteStream`/`SCR_FromByteStream` (Cfile:1328276). Bei uns: structured clone —
  aber nur, solange in `Sync` keine Lua-Funktionen/Userdata stehen. Zu prüfen.
- **Der Input-Capture-Stack fehlt komplett** (`AddInputCapture` &c., Cfile:1147773ff).
  Unsere maui-Event-Pumpe (`maui.lua`) kennt ihn nicht. Wer pumpt ihn, und was hat
  Vorrang vor dem Hit-Test?
- **`GetGameTime` liefert einen String, `GameTime` Sekunden** — welches Format genau
  (`hh:mm:ss`?) steht in `cfunc_GetGameTimeL` (Cfile:1266614ff), ist aber noch nicht
  ausgelesen.
