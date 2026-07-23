# The complete session UI — inventory from `gamemain.lua`

What the engine builds in the UI VM when the session starts, what each panel does for it
Engine requires, and in what order the beat/sync cycle runs.

Bezug: [engine-api.md](engine-api.md) (Bindungen je VM), [game-shell.md](game-shell.md),
[ui-complete.md](ui-complete.md). Current status: `src/lua/uiEngine.ts` (`setupGameUi`),
`src/engine-lua/ui-globals.lua`, `src/engine-lua/ui-globals-missing.lua`.

## 1. Overview

The engine **doesn't** build the game UI itself. It calls exactly one entry point:
`WldUIProvider.CreateGameInterface` (gamemain.lua:316) → `CreateUI(isReplay)`
(gamemain.lua:116-192). Everything in it is original Lua. The engine just delivers
Primitives: maui controls, session information (`GetArmiesTable`, `SessionGetScenarioInfo`),
Selection, camera, sound — and **the beat** (frame pump + sim beat).

Our `setupGameUi()` (uiEngine.ts:169-212) is a handheld subset of
`CreateUI`: Screen-Group → borders → economy, multifunction, orders, construction,
unitview, unitviewDetail. There are **13 modules** missing from the same function.

## 2. Ablauf / Callchain

### 2.1 Session-Start (Engine → Lua)

```
CUIManager (UI-VM)  ── userinit.lua ──> globalInit.lua, Prefetcher = CreatePrefetchSet()  (userinit.lua:11/27)
CWldSession         ── WldUIProvider ──> provider.CreateGameInterface(isReplay)           (gamemain.lua:316)
                                          └─> CreateUI(isReplay)                          (gamemain.lua:116)
```

`CreateUI` in exact order (line → call → parent):

| gamemain | Aufruf | Parent |
|---|---|---|
| 117 | `ConExecute("Cam_Free off")` | — |
| 122 | `UIUtil.changeLayoutFunction = SetLayout` | — |
| 125-128 | `GetFocusArmy()` → `LocGlobals.PlayerName` from `GetArmiesTable()` | — |
| 130 | `GameCommon.InitializeUnitIconBitmaps(prefetchTable.batch_textures)` | — |
| 132 | `UIUtil.CreateScreenGroup(GetFrame(0), "GameMain ScreenGroup")` | Frame 0 |
| 134 | `borders.SetupBorderControl(gameParent)` → **controlCluster, statusCluster, mapGroup, windowGroup** | gameParent |
| 136-140 | `controlClusterGroup.OnFrame` → **`OnFirstUpdate()`** once, then `SetNeedsFrameUpdate(false)` | — |
| 142/143 | `worldview.CreateMainWorldView(gameParent, mapGroup)` + `LockInput()` | mapGroup |
| 145 | `economy.CreateEconomyBar(statusClusterGroup)` | statusCluster ✔ |
| 146 | `tabs.Create(mapGroup)` | mapGroup |
| 148 | `multifunction.Create(controlClusterGroup)` | controlCluster ✔ |
| 150 | `orders.SetupOrdersControl(controlCluster, mfdControl)` (not in replay) | controlCluster ✔ |
| 152 | `construction.SetupConstructionControl(controlCluster, mfd, orders)` | controlCluster ✔ |
| 153 | `unitview.SetupUnitViewLayout(mapGroup, ordersControl)` | mapGroup ✔ |
| 154 | `unitviewDetail.SetupUnitViewLayout(mapGroup, mapGroup)` | mapGroup ✔ |
| 155 | `avatars.CreateAvatarUI(mapGroup)` | mapGroup |
| 156 | `controlgroups.CreateUI(mapGroup)` | mapGroup |
| 157 | `transmissionlog.CreateTransmissionLog()` | **no parent** (GetFrame(0)) |
| 158 | `helptext.CreateHelpText(mapGroup)` | mapGroup |
| 159 | `timer.CreateTimerDialog(mapGroup)` | mapGroup |
| 160 | `consoleecho.CreateConsoleEcho(mapGroup)` | mapGroup |
| 161 | `build_templates.Init()` | — |
| 162 | `taunt.Init()` | — |
| 164 | `chat.SetupChatLayout(windowGroup)` | windowGroup |
| 165 | `minimap.CreateMinimap(windowGroup)` | windowGroup |
| 167-169 | `objectives2.CreateUI(mapGroup)` — **`campaignMode` only** | mapGroup |
| 171-173 | `multihead.CreateSecondView()` — only with `GetNumRootFrames() > 1` | Frame 1 |
| 175-189 | `HandleEvent` on both clusters: `WheelRotation` → `worldview.ForwardMouseWheelInput` | — |
| 191 | `Prefetcher:Update(prefetchTable)` | — |

✔ = already built by us. `diplomacy.lua` is **not** launched by gamemain — it
depends on tabs.lua (menu) and `SimCallback`.

`OnFirstUpdate` (gamemain.lua:77-114, triggered by the **first frame** of the controlCluster):
`EnableWorldSounds()` :78 · `GetArmyAvatars()` :79 · `GetArmiesTable()` :81 ·
`avatars[1]:SetCustomName(nickname)` :84 · `UserMusic.StartPeaceMusic()` :86 ·
**`score.CreateScoreUI()`** :88 (not in `CreateUI`!) · `PlaySound(...)` :90 ·
`ForkThread`: `WaitSeconds(1.5)` → `UIZoomTo(avatars,1)` → `WaitSeconds(1.5)` →
`SelectUnits(avatars)` → `FlushEvents()` → `worldview.UnlockInput()` :91-102 ·
Faction skin via `Prefs.GetOption('skin_change_on_start')` :104-113.

`SetLayout(layout)` (gamemain.lua:53-75) calls `SetLayout` on **15 modules** —
u. a. `missiontext`, `helptext`, `score`, `avatars`, `tabs`, `controlgroups`, `chat`,
`minimap`, `objectives2`. It's `UIUtil.changeLayoutFunction`, so it works for everyone
Skin-/Layout-Wechsel.

`StopLoadingDialog` → `InitialAnimations` (gamemain.lua:253-264):
tabs → (0,15 s) → economy, score → (0,15 s) → multifunction, avatars, controlgroups →
`HideGameUI('off')`.

### 2.2 The Beat/Sync Circuit (Decomp)

Per **Sim Beat** (10 Hz, even when paused — usersync.lua:1-2):

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

**The order is semantics:** `OnSync()` (merged `Sync.UnitData` into `UnitData`,
usersync.lua:44-50) runs **before** `gamemain.OnBeat()`. Whoever calculates OnBeat first shows
the data of the previous beat.

`gamemain.OnBeat` (gamemain.lua:437-441) only gets the list from `AddBeatFunction`
(gamemain.lua:423). Registered are: economy.lua:239, avatars.lua:70/747,
score.lua:86, objectives2.lua:109, rallypoint.lua:56, commandmode.lua:87,
connectivity.lua:147.

However, **per UI frame** (not per beat) runs: `OnFrame`/`SetNeedsFrameUpdate`
(including `OnFirstUpdate`, gamemain.lua:136-140), the Maui animations and — loud
userinit.lua:13-21 — the **LUA threads of the UI**: `WaitFrames = coroutine.yield`,
`WaitSeconds(n)` polls `CurrentTime()`. So the UI VM has **no** tick scheduler.

More Engine→gamemain callbacks: `OnSelectionChanged` (SelectionListener::Receive,
Cfile:1294170 → :1294453), `OnUserPause` (Cfile:1294560), `ReceiveChat`
(func_ReceiveChat, Cfile:1263605 → :1263628), `OnDetectAdjacencyBonus`
(Cfile:1263749), `OnFocusArmyUnitDamaged` (UserUnit::NotifyFocusArmyUnitDamaged,
Cfile:1364255 → :1364271), `HideGameUI` (CON_UI_ToggleGamePanels, Cfile:1255891),
`IsNISMode` (Cfile:1149084, :1258822).

## 3. Missing engine bindings

`ui-globals-missing.lua` lists 200 names; **66 are implemented, 134 are missing**.
Counted from the decomp, there are **205** `<global>` bindings in `scr_UserInits` —
in engine-api.md **and** missing from our gap list: **`EnableWorldSounds`**,
`DisableWorldSounds`, `StopAllSounds`, `CreateUnitAtMouse`.
`EnableWorldSounds` (Cfile:1348521, `mPrevDef = scr_UserInits`, :1348548) is the
**first line** of `OnFirstUpdate` — without it the session UI won't come up.

### The bindings that the session panels need

| Name | Semantics (Decomp) | receipt | Who needs them |
|---|---|---|---|
| `EnableWorldSounds` | Welt-Sounds an (CUserSoundManager) | Cfile:1346188/1348521 | gamemain:78 |
| `GetArmiesTable` | `{numArmies, focusArmy, armiesTable[i] = {name, nickname, faction, color, iconColor, showScore, civilian, human, outOfGame, authorizedCommandSources}}` | Cfile:1266971-1267112 | gamemain:81/127, score:180/242, avatars:**30 (module level!)**/664, chat:541/795, diplomacy:39 |
| `SessionGetScenarioInfo` | ScenarioInfo as passed to the Sim at startup | Cfile:1330883 | score:**28 (module level!)**, tabs:20, diplomacy:34 |
| `GetArmyAvatars` | Avatar units of the **Focus** army (+ docked pods via `PODSTAGINGPLATFORM`/`POD`) as UserUnits | Cfile:1360885ff, :1360757; Blueprint field `General.QuickSelectPriority` (Cfile:657062-657063; only the 4 ACUs have `= 1`) | gamemain:79, avatars:658 |
| `GetIdleEngineers` / `GetIdleFactories` | Tables of Idle Farmer/Army Factories | Cfile:1360975 / :1361090 | avatars:35/659/660 |
| `UISelectAndZoomTo(unit,[s])` / `UIZoomTo(units,[s])` | select + camera on it | Cfile:1292599 / :1292715 | avatars:42/377, gamemain:94, selection:111 |
| `GetGameTime` | **formatted string** of playing time | Cfile:1266614 | score:228/230, objectives2:129, transmissionlog:265 |
| `GameTime` | Playtime in **seconds** (Sim time, stops when paused) | Cfile:1361870 | score:301, objectives2:139 |
| `FormatTime(seconds)` | String of seconds | Cfile:1266840 | timer:64/94 |
| `GetArmyScore(armyIndex)` | int | Cfile:1267137 | score (points) |
| `SimCallback({Func=..,Args=..})` | Execute Lua function in the sim (`/lua/simcallbacks.lua`) | Cfile:1359123 | controlgroups:155/166, selection:97, objectives2:104, diplomacy:91 |
| `ValidateUnitsList` | throw dead units from a list | Cfile:1360576 | controlgroups:102, selection:82/132 |
| `GetSystemTimeSeconds` | Wanduhr (Doppelklick-Erkennung) | Cfile:1266799 | selection:101/143 |
| `AddConsoleOutputReciever(func)` → handler | Konsolen-Ausgabe abgreifen | Cfile:454772 | consoleecho:35/40 |
| `AddInputCapture` / `RemoveInputCapture` / `GetInputCapture` / `AnyInputCapture` | Capture **Stack** for keyboard/mouse | Cfile:1147773-1147921 | transmissionlog:240/246, missiontext:405/445, chat |
| `IsKeyDown(keyCode)` | Button pressed? | Cfile:1141963 | control groups, chat |
| `GetCursor()` | Cursor object (`SetTexture`, `Reset`) | Cfile:1274426 | minimap:54/61, chat:104, worldview:147 |
| `GetCamera(name)` → CameraImpl (25 methods) | Camera by Name (`WorldCamera`, `MiniMap`) | Cfile:1151854; engine-api.md “CameraImpl” | minimap:128, chat:280/752, objectives2:337 |
| `FlushEvents` | Discard mouse/keyboard events | Cfile:1274594 | gamemain:97/297/327 |
| `GetCurrentUIState` | `'splash'`\|`'frontend'`\|`'game'` | Cfile:1265924 | borders:101 (SplitMapGroup) |
| `SessionGetLocalCommandSource` / `SessionGetCommandSourceNames` / `GetSessionClients` | Network Identity | Cfile:1330573 / :1330491 / :1321819 | gamemain:383, tabs:721, chat:545/568 |
| `SessionSendChatMessage([clients,] msg)` | → Engine → `gamemain.ReceiveChat` | Cfile:1322062 | chat:756/758, taunt:99, build_templates:89 |
| `SessionRequestPause` / `SessionResume` / `SessionIsPaused` | Pause (confirmed via `OnPause`) | Cfile:1330316/:1330361/:1330406 | tabs:425/428, missiontext:374 |
| `GetGameSpeed` / `SetGameSpeed` | −10…+10 | Cfile:1322407 / :1322458 | gamemain:555, score |
| `GenerateBuildTemplateFromSelection` | Construction template from selection | Cfile:1269110 | build_templates:14 |
| `PlayVoice` / `StopSound` / `PauseSound` / `PauseVoice` | Audio | Cfile:1348652/:1348237/:1347882/:1347956 | taunt:87/88, gamemain:386-388 |
| `IsObserver`, `WorldIsPlaying`, `GetSimRate`, `CurrentTime`, `Random`, `print` | Kleinkram | Cfile:1266560, :1322303, :1266914 | diverse |

### Engine **Controls** that are missing (maui classes, engine-api.md “Classes (23)”)

| Control | Binding | used by |
|---|---|---|
| `CMauiItemList` (19 Methoden) | `InternalCreateItemList` (Cfile:1140074) | **helptext:98/146**, transmissionlog, chat |
| `CMauiEdit` (31) | `InternalCreateEdit` (Cfile:1133710) | **chat:601** |
| `CMauiScrollbar` (4) | `InternalCreateScrollbar` (Cfile:1144735) | chat, itemlist-Begleiter |
| `CUIWorldView` (17) | moho class `__init` (worldview.lua:96 `Class(moho.UIWorldView, Control)`) | **worldview, minimap:115** |
| `CameraImpl` (25) | `GetCamera` | worldview, minimap |
| `CMauiMovie` (7) | `InternalCreateMovie` | Ladebildschirm, transmissionlog |
| `CUIWorldMesh` (16) | `InternalCreateWorldMesh` | rallypoint, commandmeshes |

**Not** necessary: ​​`Checkbox`, `Button`, `Group`, `StatusBar`, `Grid`, `Slider`,
`Window`, `MultiLineText`, `Combo` — these are pure Lua compositions
Bitmap/Group/Text (only bitmap, border, dragger, edit, frame, group, histogram,
itemlist, mesh, movie, scrollbar, text call `InternalCreate*`).

**Folge:** `score`, `tabs`, `avatars`, `controlgroups`, `timer`, `consoleecho`,
`build_templates`, `taunt` do not need **a single new control** — just globals.

### Sync data that the panels expect

The session panels do not read `Sync` **directly** (only hit in `lua/ui/`:
`orders.lua:909 UnitData[unit:GetEntityId()]`). You query the engine globals.
`usersync.lua` verteilt: `Sync.Sounds` → `PlaySound` (:22), `Sync.UnitData` → `UnitData`
(:44), `Sync.ReleaseIds` (:48), `Sync.RequestingExit` (:16), `Sync.UserConRequests`
(:38). The Sim page recreates the table for every beat (simsync.lua:9-31:
`CameraRequests, Sounds, Voice, GameResult, PlayerQueries, QueryResults,
OperationComplete, UnitData, ReleaseIds`).

## 4. Current status

**There:** Screen group + the four clusters from `borders.lua`, economy, multifunction,
orders, construction, unitview, unitviewDetail (uiEngine.ts:176-207) — everything about the
Original Lua. `usersync.lua` is loaded (uiEngine.ts:93), `UnitData` exists.
`gamemain.OnSelectionChanged` is correctly called from `SelectUnits`
(ui-globals.lua:238-264).

**Incorrect/missing:**

1. **The beat doesn't play on gamemain.** `gameUi.beat()` calls
   `Economy._BeatFunction()` direkt (gameUi.ts:161) — an `AddBeatFunction`/`OnBeat`
   over. Each additional panel with beat function (score, avatars, objectives2,
   rallypoint, commandmode) bliebe damit tot.
2. **No sync circuit.** `Sync` remains `{}`, `OnSync()` is never called,
   `PreviousSync` never set. The worker sends a TS snapshot instead
   (`__uiSetUnit`, `__uiSetEconomy`).
3. **`CreateUI` is never executed** — we build the panels by hand. This is also missing
   `OnFirstUpdate` (the `OnFrame` one-time hook on the controlCluster).
4. **`userinit.lua` is not running:** no `Prefetcher`, no `FrontEndData`, no
   `__language`. And the UI VM uses the **Sim** scheduler (`threads.lua`,
   tick-based) instead of `WaitFrames = coroutine.yield` + `CurrentTime()`
   (userinit.lua:13-21).
5. **134 globals are missing** (+ 4 that are not in any list, see above).

## 5. Construction order

Each step can be verified individually.

1. **Beat honest.** `gameUi.beat()` → `import('/lua/ui/game/gamemain.lua').OnBeat()`
   instead of `Economy._BeatFunction()`. *Verify:* Suite verifies that `economy.lua` is over
   `AddBeatFunction` registered and the text comes after an OnBeat.
2. **Sync cycle.** Sim worker serializes the `Sync` table after each beat and
   calls `ResetSyncTable()`; the UI sets `PreviousSync = Sync`, `Sync = <empfangen>`,
   `OnSync()` — **before** `OnBeat()`. *Verify:* a unit in `Sync.UnitData` appears
   `UnitData[id]` on; `orders.lua:909` reads it.
3. **Session globals** (no new control): `SessionGetScenarioInfo`, `GetArmiesTable`,
   `GetGameTime`, `GameTime`, `GetArmyScore`, `IsObserver`, `EnableWorldSounds`,
   `FlushEvents`, `CurrentTime`. *Verify:* `import('/lua/ui/game/score.lua')` loads without
   Error (score.lua:28 is module level!).
4. **`score.CreateScoreUI()`** — attaches to `GetFrame(0)` (score.lua:38), layout
   `score_mini.lua`. *Verify:* Time text in maui snapshot, changes per beat.
5. **`tabs.Create(mapGroup)`** — Checkbox/Bitmap/Group only. Menu buttons
   (`RestartSession`, `ExitApplication`…) are allowed to continue banging; they will only be when
   Click called.
6. **`avatars.CreateAvatarUI(mapGroup)`** — braucht `GetArmyAvatars` (Focus-Armee ×
   `QuickSelectPriority`), `GetIdleEngineers`, `GetIdleFactories`, `UISelectAndZoomTo`.
   *Verify:* ACU button appears, `AvatarUpdate` plays on the beat.
7. **`controlgroups.CreateUI(mapGroup)`** + `ValidateUnitsList` + `SimCallback` (Sim:
   `/lua/simcallbacks.lua`, `OnControlGroupAssign`/`OnControlGroupApply`) + `IsKeyDown`.
8. **`timer`, `consoleecho`, `build_templates`, `taunt`** — billig: `FormatTime`,
   `AddConsoleOutputReciever`, `GenerateBuildTemplateFromSelection`, `PlayVoice`.
9. **`InternalCreateItemList`** → `helptext.CreateHelpText(mapGroup)`,
   `transmissionlog`.
10. **`CUIWorldView` + `GetCamera`/`CameraImpl`** → `worldview.CreateMainWorldView`
    and `minimap.CreateMinimap(windowGroup)`. The big chunk; after that you can
    `worldCommands.ts` (TS-Nachbau) fallen.
11. **`InternalCreateEdit` + `SessionSendChatMessage`/`GetSessionClients`/`ReceiveChat`**
    → `chat.SetupChatLayout(windowGroup)`.
12. **`gamemain.CreateUI(false)` as the ONLY installation method** — `setupGameUi()` in
    uiEngine.ts is omitted, `OnFirstUpdate` comes from the frame pump.

**Prioritization for the 1:1 feeling:** score (clock + points at the top right) → tabs (menu) →
avatars (ACU button) → controlgroups → minimap → chat. Score and tabs are the
most visible gaps and do not cost a single new control.

## 6. Offene Fragen

- **`currentScores` is not set anywhere in the retail lua** (score.lua:10
  `currentScores = false`; read in score.lua:243 and objectives2.lua:130). From where
  The score comes per beat from `GetArmyScore(i)`, or via a sim script that
  we haven't found yet? (Don't guess without proof.)
- **`GetArmyAvatars`:** that `General.QuickSelectPriority` is the blueprint field
  (Cfile:657062: „Indicates unit has it's own avatar button in the quick select
  interface, and it's sorting priority"). Whether the engine builds the list from it or from it
  a category of its own, has not yet been traced to the source in the decomp.
- **How ​​does `Sync` get over the worker boundary?** The original uses
  `SCR_ToByteStream`/`SCR_FromByteStream` (Cfile:1328276). With us: structured clone —
  but only as long as there are no Lua functions/user data in `Sync`. To be checked.
- **The input capture stack is completely missing** (`AddInputCapture` &c., Cfile:1147773ff).
  Our Maui event pump (`maui.lua`) does not know it. Who pumps it and what has
  Priority over the hit test?
- **`GetGameTime` returns a string, `GameTime` seconds** — which format exactly
  (`hh:mm:ss`?) is in `cfunc_GetGameTimeL` (Cfile:1266614ff), but is not yet
  ausgelesen.
