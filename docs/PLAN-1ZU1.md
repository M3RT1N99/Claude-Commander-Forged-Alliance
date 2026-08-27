# PLAN-1ZU1 — the path to the real game

Consolidated from seven in-depth research (July 2026):
[frontend-menu](research/frontend-menu.md) · [worldview-camera](research/worldview-camera.md) ·
[session-start](research/session-start.md) · [combat-projectiles](research/combat-projectiles.md) ·
[session-ui-panels](research/session-ui-panels.md) · [maui-controls](research/maui-controls.md) ·
[input-cursor-keymap](research/input-cursor-keymap.md).
Every claim is substantiated (`Cfile:<line>` or `<luafile>:<line>`). Nothing is guessed;
unresolved items are listed as an **OPEN QUESTION**, not assumed in the prose.

## Destination Experience

Connect game directory → the **real FA main menu** from `lua/ui/menus/main.lua` appears
(logo, bracket animation, menu music) → **Skirmish** → the map loads itself, the ACU appears
at its marker → **the real game UI** (`gamemain.CreateUI`) with WorldView, commands, construction, and
combat → game end → back to the main menu. Everything comes from `lua/ui/**` and `lua/sim/**`: no web menu,
no TS HUD, no recreated game logic.

## Where we are today

The tech demo is running (ACU → construction menu → buildings on the grid → paid from the real economy → the
factory produces tanks). The session UI (economy, multifunction, orders, construction, unitview,
unitviewDetail) renders from the original Lua via `setupGameUi()`
([src/lua/uiEngine.ts](../src/lua/uiEngine.ts)); two Lua VMs and 22 passing verification suites.
For the full gap list, see [STATUS.md](STATUS.md). The **shell** is missing (main menu, session start,
WorldView, input), as is **combat**.

## Dependencies

```
M1 maui gaps ───┬─> M2 Front End ──> M3 Input ──┬──────────────┐
                │                               │              │
                └─> M9 Controls ────────────────┼──> M11 Lobby (Skirmish button)
                                                │              │
M4 Session start ─┬─> M5 Transition ────────────┘              │
                  ├─> M6 Sync+Beat ──> M7 WorldView ──> M10 gamemain.CreateUI
                  └─> M8 Combat ← sim-only, immediately parallel to the entire UI chain
                                                       M12 Movie/Splash/Audio
```

The **two seams** between the UI and Sim branches are **M6** (the sync cycle) and
**M5** (`LaunchSinglePlayerSession`). Otherwise, the branches do not connect.

---

## M1 — close maui gaps: border, keyboard, focus, input capture

**Size: M** · depends on: — · research: [maui-controls](research/maui-controls.md),
[input-cursor-keymap](research/input-cursor-keymap.md)

**Target experience:** Nothing new is visible — but panels get their real frames, a
modal dialog swallows clicks outside it, and a control with keyboard focus receives keys exclusively.

**Engine Parts:**

- **`moho.border_methods` (2)**: `SetNewTextures(vertical, horizontal, upperLeft, upperRight,
  lowerLeft, lowerRight)` and `SetSolidColor(color)`; they set the LazyVars
  `BorderWidth`/`BorderHeight` from the **texture dimensions** (Cfile:1123156, 1123475; write locations
  1122728/1122748). Today the Auto-Vivifier ([moho.lua](../src/engine-lua/moho.lua):530-536) delivers
  an **empty class** — the border is half built (`InternalCreateBorder` + LazyVars there,
  methods are missing), and `border.lua:28` fails on the first texture change. Also add a `border` child
  (9-slice) to [mauiRenderer.ts](../src/ui/mauiRenderer.ts), which currently knows only `bitmap`/`text`.
- **Keyboard Events**: `__mauiKey(type, keyCode, rawKeyCode, mods)`. Event table **exactly** like
  `func_CreateLuaEvent` @0x795BD0 (Cfile:1136293-1136348). Enum additions: `MouseHover=3`,
  `KeyUp=9`, `KeyDown=10`, `Char=11` (Cfile:1136267-1136288). **`KeyCode` is a wx code, not a
  VK** (`UIUtil.VK_PAUSE = 310` = `WXK_PAUSE`, uiutil.lua:81); `RawKeyCode` is the MSW-VK.
- **Routing** (three identical dispatchers: `MET_KeyDown` Cfile:1147634, `MET_KeyUp` 1147668,
  `MET_Char` 1147745): Keyboard focus control set ⇒ **only** this gets `HandleEvent`
  (if it returns `false`, the capture stack is **not** consulted; the event is sent as `skipped` to
  the console keymap); otherwise the capture top; otherwise `skipped`.
- **Focus**: `AcquireKeyboardFocus(bool)` / `AbandonKeyboardFocus()` / `GetCurrentFocusControl()`
  (Cfile:1125768 / 1125828 / 1125718) + `OnLoseKeyboardFocus` (1124572), `OnKeyboardFocusChange`
  (1124577). A `ButtonPress` on another control removes the focus (Cfile:1147523-1147531).
- **InputCapture stack** (`std::vector sInputCapture`, Cfile:430346): `AddInputCapture` (1147871),
  `RemoveInputCapture` — *“always first from back”* (1147921), `GetInputCapture` (1147818),
  `AnyInputCapture` (1147773). **Effect:** If the stack is not empty, the mouse hit test starts
  not at the root frame but at `back()` (Cfile:1147376-1147390) — *that* is modality.
- **The UI scheduler is frame based, not tick based.** The UI VM uses the Sim scheduler today
  ([threads.lua](../src/engine-lua/threads.lua)). The original: `WaitFrames = coroutine.yield`,
  `WaitSeconds(n)` polls `CurrentTime()` (userinit.lua:13-21) — the UI VM has **no**
  tick scheduler. Menu animations and the cursor-animation thread depend on this
  (cursor.lua:34-43).

**Affected original Lua:** `lua/maui/border.lua`, `lua/maui/control.lua`,
`lua/ui/uiutil.lua:615-646` (`MakeInputModal` — attaches `RemoveInputCapture` to `OnDestroy` and
checks `event.Type == 'KeyDown'` for `VK_ESCAPE`/`VK_ENTER`), `lua/userinit.lua`.

**Verification:** extend `scripts/verify-maui.ts`. (a) `Border(group):SetTextures(…)` ⇒ 8 tiles
in `__mauiSnapshot()`, `BorderWidth()` == width of the `vertical` DDS. (b) Two controls, one with
focus ⇒ only that control sees `KeyDown`; if it returns `false`, **no one** else sees it.
(c) `UIUtil.MakeInputModal(dialog)` ⇒ a hit test outside returns nothing from the rest of the tree.

---

## M2 — Front-end boot: the real main menu

**Size: L** · depends on: M1 · research: [frontend-menu](research/frontend-menu.md)

**Target Experience:** After connecting the game directory, the original main menu is there:
Logo, console frame, version text, bracket animation, the buttons from `menuTop` (Campaign,
Skirmish, Multiplayer, ..., Options, Exit) with glow and tooltips, plus menu music (tracked as a handle;
audio output comes only in M12).

**Engine Parts:**

1. **Straighten the order.** `CUIManager::SetNewLuaState` (@0x84C4E0) generates **first** per head
   a `CMauiFrame` including LazyVars (Cfile:1273621-1273666) and **then** calls `SetupUI()` from
   `/lua/ui/uimain.lua` (Cfile:1273680). In this project, the order is reversed
   ([gameUi.ts](../src/ui/gameUi.ts):106-107: `setupUi()` before `createRootFrame()`).
   `effecthelpers.lua:28` calls at **module level** `UIUtil.CreateScreenGroup(GetFrame(0), …)` —
   otherwise importing `main.lua` breaks immediately. `SetupUI()` runs again on **every**
   state change (uimain.lua:22-25); `if alreadySetup then return end` (:29) protects only the rest.
2. **`startFrontEnd(host)`** in [uiEngine.ts](../src/lua/uiEngine.ts) as a counterpart to
   `setupGameUi()`: `import('/lua/ui/uimain.lua').StartFrontEndUI()` (uimain.lua:46-64).
   **There is exactly one UI VM for everything** (`USER_GetLuaState`, Singleton, Cfile:1368027) — what
   changes is the state: `UIS_none=0, splash=1, frontend=2, game=3, lobby=4`
   (Cfile:1262301-1262311); `GetCurrentUIState()` (1265924) reads borders.lua:101.
3. **Globals** (all currently in
   [ui-globals-missing.lua](../src/engine-lua/ui-globals-missing.lua), where they throw on invocation):
   `EngineStartFrontEndUI` (Cfile:1263827), `EngineStartSplashScreens` (1263790),
   `FrontEndData` + `GetFrontEndData`/`SetFrontEndData` (1268794 / 1268715),
   `IN_RemoveKeyMapTable` (1260010 — uimain.lua:52 **always** runs here because
   `DebugFacilitiesEnabled()` returns false), `FlushEvents` (1274594, main.lua:992),
   `ExitApplication` (1263877, main.lua:980), `ClearFrame(head)` (1264066).
4. **Audio handles without output.** `PlaySound` **must provide a handle** (Cfile:1348174), otherwise
   `StopSound(handle,[immediate])` (1348237) has nothing to stop; plus `StartSound`,
   `SoundIsPrepared` (1348102), `PauseSound`, `PlayVoice` (1348652). main.lua:231-249 starts
   `Sound{Cue='AMB_Menu_Loop', Bank='AmbientTest'}` and `Sound{Cue='Main_Menu', Bank='Music'}` and
   stops it via the handle. **Don't invent an output** — just maintain the state (M12).
5. **`GetVersion()`** (Core global, Cfile:599401) is visible in the menu (main.lua:172). Today,
   [ui-globals.lua](../src/engine-lua/ui-globals.lua):654 returns `'CFA'` — an **invented value
   in the production path** (→ OPEN QUESTION 5).
6. **Load `userinit.lua`** (counterpart to `simInit.lua`; no Lua file loads it, the engine does
   it): brings `Prefetcher = CreatePrefetchSet()` (userinit.lua:11/27) and the frame-based
   scheduler from M1.
7. **Start without film — the original way:** `Prefs.SetOption('mainmenu_bgmovie', false)`
   (options.lua:358-371, default true; main.lua:151-153). The movie path comes in M12.

**Affected original Lua:** `lua/ui/uimain.lua`, `lua/ui/menus/main.lua` (`CreateUI`, 50-993),
`lua/ui/uiutil.lua`, `lua/ui/effecthelpers.lua`, `lua/ui/menucommon.lua`, `lua/maui/button.lua`,
`lua/ui/game/tooltip.lua`, `lua/ui/help/tooltips.lua`, `lua/user/prefs.lua`, `lua/userinit.lua`.

**Verification:** `scripts/verify-frontend.ts` — boot the UI VM, create the root frame, call `StartFrontEndUI()`;
`__mauiSnapshot()` must contain `/scx_menu/logo/logo.dds`, `border-console-top_bmp.dds`, and **exactly as
many `large_btn_up.dds` bitmaps as `menuTop` has entries** (main.lua:104-142).
Browser (`?frontend`): Clicking on “Skirmish” must fail with **exactly one** message —
`InternalCreateLobby … nicht implementiert` (lobbycomm.lua:121). This is honest proof that
the chain reaches the lobby.

---

## M3 — Complete input: ConExecute, keymap, hotkeys, cursor

**Size: M** · depends on: M1, M2 · research: [input-cursor-keymap](research/input-cursor-keymap.md)

**Target Experience:** The mouse pointer is the original cursor (animated, 30 shapes). ESC/Enter/`~` do,
what they do in the original. `Ctrl-W` toggles the military panel because `keyactions.lua` says so,
not because it is hard-wired. Shift appends commands to the queue.

**Engine Parts:**

1. **Make `ConExecute` real.** A key action string is a **console line**, not a
   Lua callback: `UI_Lua <code>` (`CConFunc_UI_Lua`, Cfile:423593-423600) joins the arguments
   and calls `SCR_LuaDoString(code, UI_Manager->mState)` (Cfile:1256278-1256324) — here,
   `host.eval()` in the **UI VM**. Today `ConExecute` only logs (ui-globals.lua:648-651) ⇒ **every**
   key action is dead even if the keymap loads. An unknown command must **fail loudly**.
2. **Load keymap like the engine.** `CUIKeyHandler::LoadKeyMappings` (Cfile:1259476-1259525) does it
   itself — no Lua file does it: `SCR_Import('/lua/keymap/keyNames.lua')` → `SetKeyNameTable`,
   then `SCR_Import('/lua/keymap/keymapper.lua')` → **calls `GetKeyMappings()`** → `AddKeyMapTable`.
3. `IN_AddKeyMapTable` (Cfile:1259176-1259266): Key = key string, value = table with `.action`
   (mandatory) + optional `.keyRepeat`; `category`/`order` ignores the engine.
   `IN_RemoveKeyMapTable` (1259267), `IN_ClearKeyMap` (1260044).
4. `IN_ParseKeyModifiers` (Cfile:1259566-1259720): split on `-`; the first token = key name → index
   in `in_keyNames[256]` = **Windows-VK** (keyNames.lua:2), modifiers as flags in the same int:
   **`Shift = 0x80000000`, `Ctrl = 0x40000000`, `Alt = 0x20000000`** (Cfile:1259627/1259648/1259668).
5. **One key press** (`sub_838D10`, Cfile:1258983-1259080): (1) has **some** control
   keyboard focus ⇒ **no hotkey** — typing does not trigger a hotkey; (2) auto-repeat without
   `keyRepeat` ⇒ ignore; (3) Hit ⇒ `CON_Execute(action)` (1259059); (4) Special cases about the
   **wx**-Keycode: `13` (Enter) → `chat.ActivateChat` (Cfile:1263522-1263560), `126` (`~`) →
   `uimain.ToggleConsole()` (1262747-1262775); (5) **every** path ends with `m_skipped = 1` — hotkey
   and Maui event are **not** mutually exclusive.
6. `IsKeyDown(name)` (`MAUI_KeyIsDown`, Cfile:1141557-1141585): returns **false** if the window
   is not in the foreground **or** a control has focus. Argument is a `EMauiKeyCode` **Name**:
   `IsKeyDown('Shift')` — **commandmode.lua:82, the command queue**.
7. **Cursor.** `GetCursor()` (Cfile:1274426) returns the **one** `CMauiCursor` (5 methods: `Hide`,
   `Show`, `ResetToDefault`, `SetDefaultTexture`, `SetNewTexture`). `SetTexture`/`Reset` are **Lua**
   (cursor.lua), not the engine. `UIUtil.GetCursor(id)` reads five values from `skins[…].cursors[id]`:
   `texture, hotspotX, hotspotY, [numFrames], [fps]` (skins.lua:169; 30 forms, mostly animated —
   `RULEUCC_Reclaim` = 23 frames at 12 fps). For us, `__uiSetCursorTexture` is attached to **nothing**
   (ui-globals.lua:24 = `false`) ⇒ the cursor object has no effect. TS hook: DDS → Blob URL →
   `document.body.style.cursor = url(<png>) <hx> <hy>, auto`.
8. **Resolve:** ESC and arrow keys are now attached directly to the `window` ([main.ts](../src/main.ts):651-680,
   726-742). This belongs to `uimain.EscapeHandler` (uimain.lua:119) and `keyactions.lua`.

**Affected original Lua:** `lua/keymap/{keyNames,keymapper,defaultKeyMap,keyactions}.lua`,
`lua/ui/uimain.lua`, `lua/ui/game/eschandler.lua`, `lua/maui/cursor.lua`, `lua/ui/uiutil.lua`,
`lua/ui/dialogs/keybindings.lua`, `lua/ui/game/commandmode.lua`.

**Verification:** `scripts/verify-input.ts` — (a) `ConExecute('UI_Lua LOG("hi")')` creates the
log line; an invented command fails loudly. (b) `keymapper.GetKeyMappings()` provides an `action` for **every**
entry in `defaultKeyMap.lua` (keymapper.lua:112 warns otherwise), and `'Ctrl-W'` parses
to `0x40000000 | 0x57`. Browser: after `SetupUI()`, `body.style.cursor` uses the skin texture;
Shift-click appends a command to the queue instead of replacing it.

---

## M4 — Session start from the original Lua

**Size: L** · depends on: — (Sim side, immediately buildable) · research:
[session-start](research/session-start.md)

**Target experience:** The map reads itself. The ACU stands on its `ARMY_n` marker and warps
in (`PlayCommanderWarpInEffect`); SCMP_009 has **108 Mass points and 8 Hydrocarbon** as
original splats (`mass_marker.dds`) with `massDeposit01_prop.bp` — not invented rings.

**Engine Parts:**

1. **`/maps` in the VFS.** `GameVfs.mount` only mounts `gamedata/*.scd` today
   ([vfs.ts](../src/vfs/vfs.ts):27-28), although the comment next to it is `bin/SupComDataPath.lua`
   correctly cites `bin/SupComDataPath.lua`; `main.ts` reads the map through a separate `DirectorySource` (main.ts:305/413).
   As long as `_save.lua` is not in the LuaHost VFS as `/maps/<x>/<x>_save.lua`, `SetupSession()`
   cannot `doscript` it.
2. **The find: `/schook`.** `bin/SupComDataPath.lua` sets `hook = { '/schook' }`; the engine reads
   that (Cfile:505923-505936 → `SCR_AddHookDirectory`) and appends `<hookdir><path>` on **every** script load
   (Cfile:595822-595866, log line `"Hooked %s with %s"`).
   **`schook/lua/siminit.lua` is the missing half session start:** it wraps `BeginSession` and
   calls `ScenarioUtils.CreateProps()` (:17), `CreateResources()` (:18), scores and
   `victory.CheckVictory` (:23-27); it envelops `OnCreateArmyBrain` and calls
   `InitializeStartLocation(name)` (:47) + `SetPlans` (:48). `CreateProps`/`CreateResources`
   **are not called anywhere else**. `schook.scd` is already in the VFS
   ([gameFiles.ts](../scripts/gameFiles.ts):86) — it just never loads.
3. **Real SimInit boot.** `installEngine()` loads `SimSync.lua` directly today and calls
   `ResetSyncTable()` itself — normally `SetupSession()` (siminit.lua:45/100) does both. Instead, load
   `/lua/simInit.lua`. Prerequisites: `CreatePrefetchSet()` (**simInit.lua:232, top level!**),
   `__active_mods` (:33) and `/lua/dataInit.lua` (34 lines: `BOOLEAN/INTEGER/FLOAT/VECTOR2/VECTOR3/
   RECTANGLE/STRING/GROUP`) — without the DSL every `_save.lua` is unreadable, and strict `_G`
   (config.lua:51) would correctly fail loudly.
4. **Deserialize `ScenarioInfo`, don't invent it.** [session.ts](../src/sim/session.ts):61-72 builds
   a mini table; `save`, `script`, `Env`, `Options`, `norushradius`, `Configurations` are missing,
   and `ArmySetup` has no `Team`/`PlayerName`/`ArmyColor`/`StartSpot` — `BeginSession`
   (siminit.lua:150) reads `army.Team`. Template: `SinglePlayerLaunch.lua:228-295`
   (`SetupCommandLineSkirmish`) + `LobbyComm.GetDefaultPlayerOptions` (lobbycomm.lua:29) +
   `defaultOptions` (SPL:123-135). The engine writes `ArmySetup[ArmyName] = teamInfo[i]` for each army
   and `ArmyIndex = i` (**1-based**, Cfile:1071871), then `_G.ScenarioInfo` (:1071889).
5. **Boot Order** (`Moho::Sim::Setup`, Cfile:1071723): Seed/PhysConstants → `ScenarioInfo` →
   **`SetupSession()`** (:1071898 — *before* an army exists) → EntityDB/CommandDB →
   **`Sim::CreateArmies`** (:1072015) → Props (:1072071) → **`BeginSession()`** (:1072090 —
   *after* all Brains are there, *before* there are Units) → `Sim::PostInitialize` (:1072103, only at
   `Options.PrebuiltUnits == 'On'`).
6. **`CreateArmies`** (Cfile:1073404): per army first `GenerateArmyStart` (**Random**, Cfile:1017961),
   then fields from `ArmySetup` (**`Faction → mFaction = Faction − 1`**, :1017289), then **Lua**
   `OnCreateArmyBrain(i+1, brain, ArmyName, PlayerName)` (:1073457). `brain:GetFactionIndex()` =
   `mFaction + 1` (Cfile:733604) — 1-based, directly indexed into `factions.lua`.
7. **`BeginSession()`** (siminit.lua:137) → `ScenarioInfo.Env.OnPopulate` → the map script →
   `InitializeArmies()` (scenarioutilities.lua:436) → `CreateInitialArmyGroup` →
   `CreateInitialArmyUnit` (Cfile:1025200: Position from `GetArmyStartPos()`, **`pos.y = 0.0`**,
   `mComplete = 1`).
8. **Bindings** (`sim_SimInits`): `ListArmies` (1024373), `SetArmyStart(army, x, z)` (**2D only**,
   1024490), `GenerateArmyStart` (1017961), `brain:GetArmyStartPos` (1016481),
   `ShouldCreateInitialArmyUnits` (= `not /noinitialunits`, 1024331), **`CreateResourceDeposit`**
   (687675 → `AddDepositPoint` 686680: rectangle `trunc(p − size/2) … +size` in int16 cells ⇒ a
   Mass point is exactly **one 1×1 cell**, the same grid as `COORDS_GridSnap`), `CreatePropHPR`
   (1015362), `CreateUnitHPR`, `SetAlliance`, `SetArmyPlans`, `InitializeArmyAI`,
   `SetIgnoreArmyUnitCap`, `AddBuildRestriction`, `ArmyInitializePrebuiltUnits` (1024702),
   `GetMapSize`, `Random` (deterministic → OPEN QUESTION 3), `Warp`, `OrientFromDir`,
   `SetAlliedVictory`/`EndGame`/`IsGameOver`. Unit methods: `SetCustomName`, `HideBone`,
   `CreateTarmac`, `PlayCommanderWarpInEffect`, `CreateWreckageProp`.
9. **Resolve:** [main.ts](../src/main.ts):413-432 (marker parser) and :483 (`spawnViaLua('uel0001')`)
   fall away.

**Affected original Lua:** `lua/simInit.lua`, `schook/lua/siminit.lua`, `lua/dataInit.lua`,
`lua/scenarioutilities.lua`, `lua/scenarioframework.lua`, `lua/factions.lua`, `lua/victory.lua`,
`lua/aibrain.lua`, `maps/<x>/<x>_{scenario,save,script}.lua`.

**Verification:** `scripts/verify-session-start.ts`, four stages individually red/green:
(a) `doscript('/lua/dataInit.lua', env); doscript('/maps/SCMP_009/SCMP_009_save.lua', env)` ⇒
`env.Scenario.MasterChain._MASTERCHAIN_.Markers.ARMY_1.position == {672.5, 18.6797, 346.5}`.
(b) After the hook load, `BeginSession` is the **hooked** version (counter spy on
`CreateResourceDeposit`). (c) `ArmyBrains[1]:GetArmyStartPos()` == `672.5, 346.5` — proof that
`InitializeStartLocation` ran from the hook. (d) `BeginSession()` ⇒ exactly **1 unit** per non-civilian
army, blueprint == `Factions[faction].InitialUnit`; **116 deposits** (108 Mass, 8 Hydrocarbon).
Browser: load the map; the ACU is at the starting point — **without** `?luaspawn`.

---

## M5 — The transition: `LaunchSinglePlayerSession` (seam 2)

**Size: M** · depends on: M2, M4 · research: [frontend-menu](research/frontend-menu.md) §6,
[session-start](research/session-start.md) §2.1

**Target experience:** The session starts from the **original Lua**, not from a web button. The
Launcher button disappears.

**Engine Parts:**

- `LaunchSinglePlayerSession(sessionInfo)` — **UI-VM**-Bindung (Cfile:1321744; mHelp *„launch a new
  single player session."*). Body: `WLD_SetupSessionInfo(luaTable)` → `WLD_BeginSession(…)`
  (Cfile:1321776-1321782); it throws if a session is already running. Fields read — **there are no more**:
  `scenarioInfo` (1321432), `scenarioMods` (1321444), `teamInfo` (1321455), `RandomSeed`
  (missing ⇒ system time, 1321475), `scenarioInfo.map` (1321529), `createReplay` (1321539),
  `playerName` (1321545). For us: boots the Sim Worker with exactly this table.
- The **construction plan** for `sessionInfo` is completely in `SinglePlayerLaunch.lua:228-295`
  (`SetupCommandLineSkirmish`) — factions, colors, teams, `defaultOptions`, `GetExtraArmies`
  (NEUTRAL_CIVILIAN), everything from the original Lua, **without network lobby**.
- `LoadScenario` (maputil.lua:21-30) = `doscript('/lua/dataInit.lua', env)` + `doscript(scenName, env)`
  — the same thing the engine does in `WLD_LoadScenarioInfo` (Cfile:1320686-1320693).
- The **entry is wired into the engine:** `main` (Cfile:1373640-1373870) checks `/map <x>` →
  `func_StartCommandLineSession` (1373521) → `singleplayerlaunch.StartCommandLineSession` (1373668).
  Browser counterpart: `?map=<x>` over the already existing `HasCommandLineArg`.
- Further UI bindings: `SessionGetScenarioInfo` (1330883), `PrefetchSession`,
  `WorldIsLoading`/`WorldIsPlaying` (1322303).
- **Return path:** `sub_88C9C0` (Cfile:1321251) = `WLD_Teardown()` → `UI_StartFrontEnd()`. After the game
  you return to the main menu — and because `SetNewLuaState` rebuilds the frames, the maui tree is
  empty.

**Affected original Lua:** `lua/ui/lobby/SinglePlayerLaunch.lua`, `lua/ui/maputil.lua`,
`lua/ui/lobby/lobbyComm.lua` (`GetDefaultPlayerOptions` only), `lua/ui/uimain.lua` (`NoteGameOver`).

**Verification:** `scripts/verify-launch.ts` — run `SetupCommandLineSkirmish` against SCMP_009,
check the generated `sessionInfo` (`teamInfo[1].ArmyName == 'ARMY_1'`, `Faction`,
`scenarioInfo.Options == defaultOptions`), then `LaunchSinglePlayerSession(sessionInfo)` ⇒ the worker
boots, and after N beats the ACU is at `ARMY_1`. Browser: `?map=SCMP_009` ⇒ the session runs, **without**
any TS line creating an army; `NoteGameOver` ⇒ main menu, `GetFrame(0)` has 0 children.

---

## M6 — Sync cycle + `gamemain.OnBeat` + session globals (seam 1)

**Size: M** · depends on: M4 · research: [session-ui-panels](research/session-ui-panels.md)

**Target experience:** Nothing new is visible, but from this point onward **every** panel runs in the original
beat, and `UnitData` comes from `Sync` rather than a TypeScript snapshot.

**Engine components:**

- **The cycle — the order *is* semantics:**

  ```
  SIM:  Sim::Sync (Cfile:1074261)  →  Sync.__ArmyStats, Sync.Cheaters, …
                                   →  ResetSyncTable()          (1074773 → simsync.lua:9)
  UI:   CWldSession::DoBeat (1327644)
          PreviousSync = SCR_Copy(Sync)   (1328263)
          Sync         = <received>       (1328276)
          OnSync()                        (1328286 → usersync.lua:14)   ← FIRST
          UI_Manager->OnBeat() (1328540) → CUIManager::DoBeat (1273907)
            ├ UI_FactoryCommandQueueHandlerBeat (1256904) → gamemain.OnQueueChanged
            └ UI_LuaBeat (1262940)               → gamemain.OnBeat()    (gamemain.lua:437)
  ```

  If `OnBeat` runs first, it sees the previous beat's data. Currently,
  [gameUi.ts](../src/ui/gameUi.ts):161 calls `Economy._BeatFunction()` **directly**, bypassing
  `AddBeatFunction`/`OnBeat`. The following functions are registered there: economy.lua:239,
  avatars.lua:70/747, score.lua:86, objectives2.lua:109, rallypoint.lua:56, commandmode.lua:87,
  connectivity.lua:147.
- `usersync.lua` distributes: `Sync.Sounds` → `PlaySound` (:22), `Sync.UnitData` → `UnitData` (:44),
  `Sync.ReleaseIds` (:48), `Sync.RequestingExit` (:16), `Sync.UserConRequests` (:38). The Sim side
  recreates the table for every beat (simsync.lua:9-31).
- Transport across the worker boundary: structured clone instead of `SCR_ToByteStream`/`SCR_FromByteStream`
  (Cfile:1328276) — the same semantics but a different transport mechanism: engine freedom, no logic
  reimplementation (constraint → OPEN QUESTION 12).
- **Session globals** (not a single new control required): `GetArmiesTable`
  (Cfile:1266971-1267112 — `{numArmies, focusArmy, armiesTable[i] = {name, nickname, faction, color,
  iconColor, showScore, civilian, human, outOfGame, authorizedCommandSources}}`),
  `SessionGetScenarioInfo` (1330883), `GetGameTime` (**string**, 1266614), `GameTime` (**seconds**,
  1361870), `FormatTime` (1266840), `GetArmyScore` (1267137), `GetSystemTimeSeconds` (1266799),
  `CurrentTime`, `IsObserver`, `GetSimRate`, `SimCallback({Func, Args})` (1359123 →
  `/lua/simcallbacks.lua`), `ValidateUnitsList` (1360576), **`EnableWorldSounds`** (1348521),
  `SessionRequestPause`/`SessionResume`/`SessionIsPaused` (1330316/1330361/1330406),
  `GetGameSpeed`/`SetGameSpeed` (1322407/1322458).
- **Module-level warning:** `score.lua:28` calls `SessionGetScenarioInfo()` and `avatars.lua:30` calls
  `GetArmiesTable()` **at module level** — without these globals, even the `import` fails.
- **Count correction:** `engine-api.md` lists 200 `<global>` bindings in `scr_UserInits`; the Decomp
  contains **205**. Both lists omit: `EnableWorldSounds`, `DisableWorldSounds`,
  `StopAllSounds`, `CreateUnitAtMouse`.

**Affected original Lua:** `lua/ui/game/gamemain.lua` (423-441), `lua/usersync.lua`,
`lua/simsync.lua`, `lua/SimCallbacks.lua`, `lua/ui/game/economy.lua`.

**Verification:** `scripts/verify-sync-beat.ts` (or extend `verify-ui-panels.ts`) — (a)
`economy.lua` is registered through `AddBeatFunction`; one `gamemain.OnBeat()` updates the text.
(b) A unit in `Sync.UnitData` appears in `UnitData[id]` after `OnSync()`; `orders.lua:909` reads it.
(c) After the second beat, `PreviousSync` contains the first beat's data.

---

## M7 — Camera + WorldView as a maui control

**Size: XL** · depends on: M1, M3, M6 · research: [worldview-camera](research/worldview-camera.md)

**Target experience:** The world is part of the UI: zooming to the cursor, middle-button panning,
camera jumps from Lua, box selection, a build preview at the cursor, and right-click formations. The
cursor indicates what a click would do. [worldCommands.ts](../src/ui/worldCommands.ts) is **deleted**.

**Core assertion:** `CUIWorldView` derives from `CMauiControl` (vtable Cfile:397420-397449:
`Draw`, `SetHidden`, `HitTest`, `HandleEvent`, `OnFrame`). **There is no second input path.**

**Engine components** (the order is semantic: without a camera, no constructor; without a constructor,
no control; without `cursorInfo`, no click):

1. **Camera.** `GetCamera(name)` (`cfunc_GetCameraL` @0x7AB100, Cfile:1151852) → `CameraImpl`
   (25 methods). **The complete model has four fields** (`SaveSettings`, Cfile:1153090-1153150):
   `{ Focus = Vector3, Zoom = number, Pitch = number, Heading = number }`. **Zoom is a distance in
   world metres**, not a factor (`GetTargetZoom() > 130`, unittext.lua:31). Names: `WorldCamera`,
   `WorldCamera2`, `MiniMap`, `CameraHead2`. [unitViewer.ts](../src/viewer/unitViewer.ts) currently has
   `{target, dist, pitchOffset}` — almost `{Focus, Zoom, Pitch}`.
2. **`moho.UIWorldView:__init(parent, cameraName, depth, isMiniMap, trackCamera)`** (@0x86E480,
   Cfile:1298140-1298350). The constructor does more than it seems: the control name is **always**
   `"World View"`; the second argument is the **camera name**; **`RCamManager::CreateCamera(name)`
   creates the camera here**; `name == "WorldCamera"` ⇒ `func_SetWorldCamera(cam)`; `isMiniMap` ⇒
   `SetLODScale(cam_DefaultMiniLOD)` + `CanShake(false)`; `WRenViewport::AddWorldView(view,
   eventMapper, depth)` registers both rendering **and** events; `mNeedsFrameUpdate = 1`; it reads
   `worldview.WorldViewParams` and sets **exactly three** ConVars from it (`ui_SelectTolerance`,
   `ui_DisableCursorFixing`, `ui_ExtractSnapTolerance`) — `ui_MinExtractSnapPixels`/
   `ui_MaxExtractSnapPixels` from the same table are **ignored** (Cfile:1298295-1298345).
3. **`cursorInfo` + `UpdateSelection`** (@0x86F520): writes `mMouseScreenPos`, `mMouseWorldPos`,
   `mInWorld`, `mUnitHover`, `mIsDragger`. The world point comes from `Camera->CameraScreenToSurface`;
   the unit under the cursor comes from `Camera->Unproject` → `Wm3::IntrLine3Box3f` against mesh boxes,
   **expanded by `ui_SelectTolerance`** (Cfile:1298979-1298981). This feeds `GetMouseWorldPos()`
   (@0x842C30), `GetMouseScreenPos()`, `GetRolloverInfo()`, `Project`/`UnProject`,
   `GetScreenPos(unit)`.
4. **`OnFrame`** (@0x871140, Cfile:1299977): `UpdateSelection(mMouseScreenPos)` **then**
   `RunScript("OnUpdateCursor")` — this invokes worldview.lua:131-204. Afterwards, keyboard pan/rotate
   (`ui_KeyboardPanSpeed` = 90, `…AccelerateMultiplier` = 4, `ui_KeyboardRotateSpeed` = 10,
   `…Multiplier` = 2; Cfile:421739-421742).
5. **`HandleEvent` with the correct nesting** (@0x8704B0, Cfile:1299476-1299975):
   `UpdateSelection` runs **before** Lua (:1299571); then `CMauiControl::HandleEvent` invokes the
   **Lua** `HandleEvent`; if it returns `true` **or** `mInputLocks > 0`, processing ends here
   (:1299583). **The Lua layer is inside the C++ layer, not before it.** The engine branches then
   follow: mouse wheel → command mode or `Camera:SetPivot` + `Camera:Zoom`; mouse motion with
   `SPACE` → `Camera:Spin`, otherwise `RevertRotation`; middle button → `CameraDragger`; left press →
   `GetLeftMouseButtonAction`; right-**release** → dispatch the command.
6. **`GetLeftMouseButtonAction`** (@0x81F7B0, Cfile:1240587-1240695) — **command mode lives in Lua**:
   `UI_GetCommandMode` @0x83DDA0 literally does
   `SCR_Import('/lua/ui/game/commandmode.lua')['GetCommandMode']()`. Mapping: `"order"` →
   `COMMOD_Order` (`data.name` → `RULEUCC_*`; special case: `RULEUCC_Transport` plus a hovered unit
   with `RULEUCC_Transport` ⇒ `RULEUCC_CallTransport`), `"build"`/`"buildanchored"` → build dragger
   (without a valid bp, the mode remains `None`), `"ping"` → `COMMOD_Ping`, `""` → Select (4) or
   CommandDrag (5). **Precondition for all of this: `cursorInfo.mInWorld`** (:1240553).
7. **Bindings:** `LockInput`/`UnlockInput`/`IsInputLocked` (counter `mInputLocks`; the **engine** calls
   `IsInputLocked()` itself, Cfile:1262798-1262815), `GetsGlobalCameraCommands` (1300446),
   `SetCartographic`/`IsCartographic`, `EnableResourceRendering`, `SetHighlightEnabled`/
   `HasHighlightCommand`, `GetRightMouseButtonOrder()` → `RULEUCC_*`, `ShowConvertToPatrolCursor()`,
   `ZoomScale`, `CameraReset`, `UIZoomTo`/`UISelectAndZoomTo` (Cfile:1292660-1292715),
   `UISelectionByCategory` (1292494), `_c_CreateDecal` → `ScriptedDecal` (5, target reticle),
   `InternalCreateWorldMesh` → `CUIWorldMesh` (16, rally point),
   `InternalCreateWldUIProvider` → `CLuaWldUIProvider` (gamemain.lua:225).
8. **Draggers:** `func_NewSelectionDragger2D` (@0x865880, box selection), `func_NewUIBuildDragger`
   (@0x823CB0 — the grid snap is **here**, not in the UI), `CameraDragger`,
   `func_NewCommandDragger` (@0x8242B0). All four are **C++** in the original; they belong in the
   engine, not Lua. The snap in `worldCommands.ts` is **calculated correctly** (`COORDS_GridSnap`) —
   it is simply in the wrong place. The fixed `Right-click = Move` value (worldCommands.ts:125) is
   removed; `GetRightMouseButtonAction` answers this instead.
9. **Then remove the `draws()` filter** from hit testing ([maui.lua](../src/engine-lua/maui.lua):225-235,
   320-334, 344-356). The engine rectangle-tests **every** visible control (Cfile:1124492) — there is
   **no** "draws something" criterion. The full-screen containers do not consume clicks in the original
   solely because the **world view itself is a control**. Removing the heuristic proves that WorldView
   is in place (→ conflict B).

**Affected original Lua:** `lua/ui/controls/worldview.lua` (`Class(moho.UIWorldView, Control)`, :96),
`lua/ui/game/worldview.lua` (`CreateMainWorldView`, gamemain.lua:142), `lua/ui/game/commandmode.lua`,
`lua/ui/game/{rallypoint,ping,selection,zoomslider}.lua`, `lua/usercamera.lua`,
`lua/ui/controls/worldmesh.lua`, `lua/ui/game/wlduiprovider.lua`.

**Verification:** `scripts/verify-camera.ts` — `SaveSettings()` → `RestoreSettings()` is idempotent;
`zoomslider.lua` loads and toggles. `scripts/verify-worldview.ts` — after UI setup,
`import('/lua/ui/game/worldview.lua').viewLeft` is a control, `MapControls['WorldCamera']` is set, and
`LockInput()`/`UnlockInput()` toggle `IsInputLocked()`; **`Project(UnProject(view, Vector2(x,y)))
≈ (x,y)` within ±1 px across the screen** — the most honest test the camera permits.
**Rewrite `scripts/verify-command-chain.ts`:** instead of calling `worldClick(…)`, send
`__mauiMouse('ButtonPress', x, y)` to WorldView and verify that the factory is built at the **snapped**
position — then the test exercises the real path.

---

## M8 — Combat: projectiles, damage, death, wrecks

**Size: XL** · depends on: M4 · **Sim-only — can be built in parallel with the entire UI chain from now on** ·
research: [combat-projectiles](research/combat-projectiles.md), supplemented by
[weapons](research/weapons.md) + [damage-binary](research/damage-binary.md)

**Target experience:** Two tanks from different armies see each other, fire, hit, die, and leave a wreck
with the correct reclaim value.

> **This milestone is DONE (2026-08-25).** The paragraph below is the starting
> position it was written against and is kept for context only. Since then:
> weapons acquire targets (now priority-ranked, `FindBestEnemy` Cfile:791970),
> fire and impact; `Kill` (moho.lua:175) and `GetArmorMult` (moho.lua:443) have
> real bodies; `moho.projectile_methods` is a real class; and `beat()` runs the
> weapon and projectile phases. Verified by `scripts/verify-combat.ts`.

Starting position: **no weapon is ever given a target** — the FSM has been in `IdleState` since the
first tick. `Kill` and `GetArmorMult` are **no-ops** (moho.lua:53/138), `moho.projectile_methods` is
an empty Auto-Vivifier class, and `beat()` ([engine.ts](../src/lua/engine.ts):91-108) has six phases
— none of them is weapon or projectile processing.

**Engine components (smallest honestly testable steps):**

1. **Load projectile blueprints.** `/projectiles/**/*_proj.bp` into `__bpFiles`
   ([unitFactory.ts](../src/lua/unitFactory.ts):50 knows only `units/<id>/<id>_unit.bp`). The pipeline
   already exists (blueprints.lua:259-262/313); the ID is the **full lower-case path including
   `.bp`** (`SetBackwardsCompatId`, blueprints.lua:104-107) — the exact string in
   `Weapon.ProjectileId`.
2. **Blueprint defaults.** `Projectile` (constructor `RProjectileBlueprintPhysics`, Cfile:653667-653712):
   `Lifetime 15`, `InitialSpeed 1`, `MaxSpeed 0`, `TurnRate 0`, `CollideSurface 1`, `TrackTarget 0`,
   `VelocityAlign 1`, **`UseGravity 1`**, `DestroyOnWater 0`, `RealisticOrdinance 0`, …
   The projectile blueprint has **no `Defense` section** (Cfile:654222-654240), yet
   `Projectile.lua:75` reads `bp.Defense.MaxHealth or 1`; that works **only** because of the LuaPlus
   `nil` metatable in [boot.lua](../src/engine-lua/boot.lua). `Weapon` is likewise absent from
   [blueprints.lua](../src/engine-lua/blueprints.lua):16-73, while `weapon.lua:287` calculates
   `weaponBlueprint.DamageRadius + 0` (→ OPEN QUESTION 9).
3. **Bring bone transforms into the Sim.** [scm.ts](../src/formats/scm.ts):36-43 reads
   `position`/`rotation`/`parent` for each bone, but `__setBones` forwards only **names**. Without a
   muzzle world position, there is no starting point. This also requires `Entity:GetPosition([bone])`
   (Cfile:934579 — **we lack the bone argument**) and `Entity:GetBoneDirection` (931458).
4. **`moho.projectile_methods` (30) + `__spawnProjectile`** (new file
   `src/engine-lua/projectiles.lua`). Resolve classes as `func_FindBlueprintScriptModule` does
   (Cfile:914189-914360): truncate `bp.Source` at the **last** `_` and append `_script.lua`; use
   `bp.ScriptClass` as the class name, otherwise **`"TypeClass"`**; if the file is missing, use
   `/lua/sim/projectile.lua`.
5. **`UnitWeapon::CreateProjectile`** (@0x6D6820, Cfile:985613-985800): **a missing `ProjectileId` is not
   an error**; it instead does `DoInstaHit` and returns `nil` (:985658-985675). `MuzzleVelocity != 0`
   overrides the magnitude; lifetime is in **ticks**. Lua chain: `defaultweapons.lua:582` →
   `weapon.lua:321-325` (`CreateProjectile(bone)` → `PassDamageData(GetDamageTable())`, 11 fields,
   Projectile.lua:415-427).
6. **Add `__projectileTick()` as phase 5 in `beat()`** (after `motionTick`). `Projectile::MotionTick`
   (Cfile:944040-944290), dt = 0.1. Two details must not be guessed: **integration is trapezoidal** —
   `pos += 0.5·(v_alt + v_neu)·0.1`, **not** `pos += v·0.1` (naive Euler shifts every trajectory); and
   `mImpactInterp` resolves the impact only on the **next** tick. `mBallisticAcc = mGravity · UseGravity`
   (:943663) — `UseGravity` simply disables gravity. `TurnRate` also limits mesh orientation when
   `TrackTarget = false` (`· 0.0017453292` = rad/tick), which is why TDFGauss01 has `TurnRate = 360`
   despite being unguided.
7. **Collision.** `Projectile::CheckCollision` (@0x69D1D0) is **not decompilable** — the call list
   establishes a swept **line-segment** test (not a point test), terrain from the heightfield, water as
   a plane intersection, and the Lua filter `OnCollisionCheck(other)` with **one** argument
   (Cfile:945766-945830). `ENT_GetImpactType` (@0x67B240) returns
   Air/Underwater/Unit/UnitAir/UnitUnderwater/Projectile/Prop/Shield — it **does not** produce
   `Terrain` or `Water`. `EImpactType` Cfile:640486-640525. `Projectile::Impact` (944692):
   `RunScript("OnImpact", ImpactTypeString, targetEntity)` — **two** arguments.
   → OPEN QUESTION 8: **explicitly mark it as an assumption; do not guess.**
8. **`Damage` / `DamageArea` / `DamageRing` / `MetaImpact`** (Cfile:1064181/1064294/1064409/1064536).
   **`Damage` has 5 arguments** — `(instigator, origin, target, amount, type)`; `cfunc_DamageL`
   checks `lua_gettop != 5` (Cfile:1064215), while the mHelp text is outdated; `amount == 0` ⇒
   **Lua error**. Formula: `effektiv = amount · ArmorMult / (1 + Handicap)`, **no**
   distance falloff. `Unit:GetArmorMult` (972450) is currently a no-op, so `shield.lua:101` calculates
   `amount * nil`.
9. **`Entity:Kill(instigator, type, overkillRatio)`** (Cfile:951962-952180), including the rule that
   must not be invented: if the unit is under construction and **`FractionComplete < 0.5`,
   `overkillRatio` is set to `10.0`** (:952126), so a half-finished construction site **never** leaves
   a wreck. `Entity::Destroy` is **deferred** (deletion queue; `OnDestroy` runs only on actual
   deletion, :916143). On the Lua side, `Unit:OnDamage` fires only when `self.CanTakeDamage` is set
   (unit.lua:190/779/787) → `DoTakeDamage` → `self:Kill(…)`.
10. **Target acquisition + firing cadence** (`__weaponTick`). `CAcquireTargetTask::TaskTick` (@0x5D8D10):
    check interval `TargetCheckInterval · 10` ticks; search radius `max(TrackingRadius · MaxRadius,
    MaxRadius)` (Cfile:793146-793156) — a **maximum**, so `TrackingRadius < 1` reduces nothing.
    `CFireWeaponTask::Dispatch` (@0x6D3DC0, Cfile:983912-983956): `mFireClock = (int)(10.0 / rof)` —
    **truncated**, in ticks; `UnitWeapon::Fire` only calls `RunScript("OnFire")` and does nothing else.
    Binary-confirmed Sentinel behavior: `mRateOfFire = -1` ⇒ *use the blueprint value*
    (Cfile:983289-983304). `SetTarget` ⇒ `OnGotTarget`/`OnLostTarget` on the **weapon**
    (Cfile:985364-985494).
11. **Incorrect, not merely missing:** `IsAlly`/`IsEnemy`
    ([globals.lua](../src/engine-lua/globals.lua):42-43) compare only army indices. Without a real
    alliance table (from `SetAlliance`, M4), every collision and friendly-fire filter is **guessed**.
12. **Wreck** (`CreateProp`, `moho.prop_methods`, `/lua/sim/prop.lua`) — only after step 10 is green.
    Formulas: weapons.md §5.
13. **Later:** shields, beams (`CollisionBeamEntity`, 6 bindings; `defaultweapons.lua:909`), DoT,
    nuke rings, flares.

**Affected original Lua:** `lua/sim/{Projectile,DefaultProjectile,Weapon,DefaultWeapons,Unit,Prop,
Shield}.lua`, `lua/defaultdamage.lua`, `projectiles/**/*_script.lua`.

**Verification:** **`scripts/verify-combat.ts` is the target** — two UEL0201 units, armies 1 and 2,
15 world metres apart, with `beat()` in a loop. Expected: `OnFire` on the first tick after target
acquisition, then exactly every **10 ticks** (RoF 1); one `TDFGauss01` (not `Projectile`) per shot;
`GetLauncher()` is the unit; `DamageData.DamageAmount == 24`; flight time ≈ 6 ticks; the target loses
**24 HP** per hit; `OnKilled` after `ceil(MaxHealth/24)` hits; a wreck prop with
`mass = BuildCostMass · 0.9 · (1 − overkill)`. Test intermediate steps independently: the trapezoidal
trajectory analytically after 5 ticks; `Damage(a, pos, b, 24, 'Overcharge')` against
`ArmorType = 'Commander'` subtracts `24 · 0.033333`.

---

## M9 — The remaining maui controls: ItemList, Edit, Scrollbar, MapPreview

**Size: L** · depends on: M1 · research: [maui-controls](research/maui-controls.md)

**Target experience:** Dropdowns work (every `Combo` is an `ItemList`), making options and map selection
usable; in-game text input works (chat, renaming, build templates).

**Engine components:**

| Control | Binding | unlocks |
|---|---|---|
| `CMauiItemList` (19) | `InternalCreateItemList(luaobj,parent)` (Cfile:1140074, Helps 1140151-1141154); callbacks `OnClick`, `OnDoubleClick`, `OnKeySelect`, `OnMouseoverItem` | **combo.lua:117 → every dropdown**, uiutil.lua:931, helptext.lua:98/146, transmissionlog, eula, mapselect, score |
| `CMauiEdit` (31) | `InternalCreateEdit(luaobj,parent)` (Cfile:1133710). **Text editing is in C++** (`CMauiEdit::HandleEvent` @0x790470, Cfile:1132299-1132317: only ButtonPress/DClick and `MET_Char`; **always returns 0** — an edit never "consumes" an event). `OnEnterPressed(text)` (1132320), `OnEscPressed(text)` (1132327), `OnNonTextKeyPressed`, `OnLoseKeyboardFocus`. Requires `MET_Char` from M1. | chat.lua:601, ping.lua:80, rename.lua:29, construction.lua:1022, console, lobby, filepicker |
| `CMauiScrollbar` (4) | `InternalCreateScrollbar(luaobj,parent,axis)` (Cfile:1144735) — `axis` is the **lexical string** of `EMauiScrollAxis` (`"Vert"`/`"Horz"`, scrollbar.lua:9-12; conversion 1144789). **The scrollable protocol is Lua, not C++:** `GetScrollValues(axis) -> rangeMin, rangeMax, visibleMin, visibleMax` (1124664), `ScrollLines(axis,delta)` (1124731), `ScrollSetTop(axis,top)` (1124775) — via `RunScript` on the object passed to `SetScrollable()`. | uiutil (`CreateVertScrollbar`/`CreateHorzScrollbar`, ~580-611), console, mapselect, modmanager |
| `CUIMapPreview` (3) | `InternalCreateMapPreview` (1276475) + `SetTexture`, `SetTextureFromMap`, `ClearTexture` | mappreview.lua:8 → mapselect, lobby |

Add the new kinds `itemlist`, `edit`, `scrollbar`, `mappreview` to
[mauiRenderer.ts](../src/ui/mauiRenderer.ts).

**Do not build:** `Histogram` and `Mesh` are instantiated by **no** `lua/ui/**` file
(Cfile:1137793/1142596). **Dead imports** (they import a control but never create one):
specialgrid.lua:9, unitviewdetail.lua:7, tooltip.lua — **the build grid is a `SpecialGrid` made from
bitmaps, not an ItemList.** Button, Checkbox, Slider, Grid, Window, MultiLineText, Combo, StatusBar,
and RadioButtons are **pure original Lua** built from Bitmap/Group/Text: there is nothing to build.

**Affected original Lua:** `lua/maui/{itemlist,edit,scrollbar,mappreview,combo}.lua`,
`lua/ui/uiutil.lua`, `lua/ui/dialogs/{options,mapselect,rename}.lua`, `lua/ui/game/chat.lua`.

**Verification:** `scripts/verify-controls.ts` — (a) `Combo(parent, {…})` ⇒ `GetItemCount()` matches,
`OnClick` sets the selection, and `mapselect.lua` loads without errors. (b) Create the `rename.lua`
dialog, feed a `MET_Char` sequence, verify `GetText()`, then press Enter ⇒ `OnEnterPressed` receives
the text. (c) `UIUtil.CreateVertScrollbar(list)` ⇒ the mouse wheel calls `ScrollLines(axis, delta)` on
the scrollable object.

---

## M10 — `gamemain.CreateUI()` is the only setup path

**Size: L** · depends on: M6, M7, M9 · research: [session-ui-panels](research/session-ui-panels.md)

**Target experience:** The complete session UI — score clock, tab menu, ACU avatar, control groups,
minimap, chat, help text, and transmission log. `setupGameUi()` is **removed**;
[hud.ts](../src/ui/hud.ts) is **deleted**.

**Engine components:** The engine does **not** build the game UI itself — it invokes exactly one entry point:
`WldUIProvider.CreateGameInterface` (gamemain.lua:316) → `CreateUI(isReplay)` (gamemain.lua:116-192).
In **exact** order (✔ = already present in our implementation):
`ConExecute("Cam_Free off")` (117) · `GameCommon.InitializeUnitIconBitmaps` (130) ·
   `CreateScreenGroup` (132) · `borders.SetupBorderControl` → **controlCluster, statusCluster, mapGroup,
   windowGroup** (134) · `controlClusterGroup.OnFrame` → **`OnFirstUpdate()`** once (136-140) ·
`worldview.CreateMainWorldView` + `LockInput()` (142/143 ← M7) · economy ✔ (145) · `tabs.Create` (146) ·
multifunction ✔ (148) · orders ✔ (150) · construction ✔ (152) · unitview ✔ (153) · unitviewDetail ✔
(154) · `avatars.CreateAvatarUI` (155) · `controlgroups.CreateUI` (156) · `transmissionlog` (157,
**no parent** → GetFrame(0)) · `helptext` (158 ← ItemList) · `timer` (159) · `consoleecho` (160) ·
`build_templates.Init` (161) · `taunt.Init` (162) · `chat.SetupChatLayout` (164 ← Edit) ·
   `minimap.CreateMinimap` (165 ← **a second WorldView with `isMiniMap = true`**, not a canvas with
   points) · `objectives2` (167-169, only `campaignMode`) · `Prefetcher:Update` (191).

**`OnFirstUpdate`** (gamemain.lua:77-114, triggered by the control cluster's **first frame**):
`EnableWorldSounds()` :78 · `GetArmyAvatars()` :79 · `avatars[1]:SetCustomName(nickname)` :84 ·
`UserMusic.StartPeaceMusic()` :86 · **`score.CreateScoreUI()`** :88 (**not** in `CreateUI`!) ·
`ForkThread`: `WaitSeconds(1.5)` → `UIZoomTo(avatars,1)` → `WaitSeconds(1.5)` → `SelectUnits(avatars)`
→ `FlushEvents()` → `worldview.UnlockInput()` :91-102.

New bindings: `GetArmyAvatars` (Cfile:1360885ff; blueprint field `General.QuickSelectPriority`,
Cfile:657062 — only the 4 ACUs have `= 1`), `GetIdleEngineers`/`GetIdleFactories` (1360975/1361090),
`AddConsoleOutputReciever` (454772), `GenerateBuildTemplateFromSelection` (1269110),
`SessionSendChatMessage` (1322062) + `gamemain.ReceiveChat` (1263605),
`GetSessionClients`/`SessionGetLocalCommandSource` (1321819/1330573), `HideGameUI` (1255891),
`IsNISMode` (1149084), `InternalCreateWldUIProvider` (1295462).
`SetLayout` (gamemain.lua:53-75) calls `SetLayout` on **15 modules** and is
`UIUtil.changeLayoutFunction`.

**Priority for the 1:1 feel** (each step is visible independently): score (clock + points) → tabs
(menu) → avatars (ACU button) → controlgroups → minimap → chat. **Score, tabs, avatars, controlgroups,
timer, consoleecho, build_templates, and taunt require not a single new control** — only globals
(therefore only M6).

**Affected original Lua:** `lua/ui/game/{gamemain,borders,score,tabs,avatars,controlgroups,
transmissionlog,helptext,timer,consoleecho,build_templates,taunt,chat,minimap,objectives2}.lua` +
the layout files (`score_mini.lua` …).

**Verification:** `scripts/verify-ui-panels.ts` runs against `gamemain.CreateUI(false)` rather than
`setupGameUi()` — the same control count and positions as today, plus the 13 new modules; the four
clusters from `borders.lua` are the parents (not `GetFrame(0)`); `OnFirstUpdate` fires **exactly
once**; the time text from `GetGameTime()` changes each beat.
**Then update [CLAUDE.md](../CLAUDE.md):** "The game UI has exactly one setup path:
`setupGameUi()`" is false from this point onward.

---

## M11 — Lobby: the Skirmish button

**Size: XL** · depends on: M2, M5, M9 · research: [frontend-menu](research/frontend-menu.md) §6

**Target experience:** Literally the target experience: main menu → **Skirmish** → lobby (map, faction,
colour, AI, options) → session. This also lays the foundation for multiplayer.

**Engine components:** main.lua:909-922 calls `lobby.CreateLobby('None', 0, playerName, nil, nil,
topLevelGroup, cb)` + `lobby.HostGame(name, scenarioFileName, true)`. This requires
`InternalCreateLobby` (Cfile:1168970 — **`CLobby` with 18 methods**; lobbycomm.lua:121),
`InternalCreateDiscoveryService` (1168381, 3 methods), and launch runs through
`CLobby::LaunchGame` (Cfile:1170898) — a large engine function (LaunchInfoNew, ClientManager,
NetConnector). Single-player also uses `lobbyComm:LaunchGame(gameInfo)` (lobby.lua:879/882).
Prerequisites from M9: ItemList (Combo), Scrollbar, Edit, MapPreview.

**Affected original Lua:** `lua/ui/lobby/{lobby,lobbyComm,gameselect}.lua`,
`lua/ui/dialogs/mapselect.lua`, `lua/ui/maputil.lua`.

**Verification:** Browser (`?frontend`) — clicking "Skirmish" opens the original lobby; map selection
shows the `MapPreview`; "Launch" ⇒ **the same `sessionInfo`** checked by `verify-launch.ts` (M5) goes
to `LaunchSinglePlayerSession`. The Sim boot is identical — only the route to it is new.

---

## M12 — Movie/SFD, splash, and audio output

**Size: L–XL** · depends on: M2 · research: [frontend-menu](research/frontend-menu.md) §2.5/§5,
[maui-controls](research/maui-controls.md) §5, [effects-audio](research/effects-audio.md)

**Target experience:** Splash logos, a background movie in the main menu, menu music, unit sounds — the
part that turns a silent still image into a game.

**Engine components:**

- **Movie.** `InternalCreateMovie(luaobj, parent)` (Cfile:1143258) + `moho.movie_methods` (7:
  `InternalSet`, `IsLoaded`, `Play`, `Stop`, `Loop`, `GetFrameRate`, `GetNumFrames`) + LazyVars
  **`MovieWidth`/`MovieHeight`** (Cfile:1142984-1142985) + the `movie` kind in the renderer; callbacks
  `OnStopped`, `OnFinished`, `OnSubtitle`, `OnFrame`. Format: **CRI Sofdec** (`.sfd` = MPEG-1-Video +
  CRI-ADX-Audio; Symbole `MWSFD_*`, `struct_sofdec_ply`, Cfile:44063-44075;
  `Moho::CMovie::GetWidth/GetHeight` 29109-29110).
   **`CMauiMovie::LoadFile` returns `false` when `/nomovie` is set**
   (Cfile:1143020-1143035); `movie.lua:32-53` handles that (`local ok = self:InternalSet(…)` … `else
   self:OnStopped()`). The second original escape route is `splash.lua:22-25`: if
   `GetPreference("movie.nologo")` is set, it immediately calls `EngineStartFrontEndUI()`. →
   **Decision required, CONFLICT A.**
- **Splash.** `GetCursor()` (1274426) + input capture (splash.lua:30/49), `SoundIsPrepared`,
  `StartSound`, `PlayVoice` (movie.lua:37-49 waits for it).
- **Audio — and CLAUDE.md is wrong here.** There is **no `sounds.scd`** and **no FMOD**. The data is
  plain files under `<FA>/sounds/`: **78 `*.xwb`** (XACT Wave Banks, magic `WBND`, version 43),
  **80 `*.xsb`** (Sound Banks, magic `SDBK`), and **`SupCom.xgs`** (XACT Global Settings, magic
  `XGSF`) — hex-verified (effects-audio.md:19/217-288). Engine:
  `AudioEngine::Create("/sounds")` enumerates `*.xwb`/`*.xsb`; `func_InitSound` loads
  `/sounds/SupCom.xgs`. **1896 cues** across all 80 `.xsb`. `Sound{}` (`cfunc_SoundL`) builds a
  `CSndParams` (`mBank`, `mCue`, `mLodCutoff` — **`LodCutoff` is the name of an XACT variable**,
  e.g. `UnitMove_LodCutoff`, not a numerical value). Music: `lua/UserMusic.lua`, bank `Music` (cues
  `Main_Menu`, `Base_Building`, `Battle`). An XWB reader is ~100 lines; the
  **cue→sound→track chain** in XACT is the actual work and is **not yet verified**
  (effects-audio.md:288).

**Affected original Lua:** `lua/maui/movie.lua`, `lua/ui/menus/splash.lua`,
`lua/ui/menus/main.lua:34-48`, `lua/UserMusic.lua`, `lua/ui/game/gamemain.lua:206` (loading screen).

**Verification:** headless — `main.lua:CreateBackMovie(GetFrame(0))` ⇒ movie in the snapshot,
`Width == 1824 * (H/1024)` (main.lua:43-46). After `CreateUI()`, `__uiSoundsRequested` contains
`AMB_Menu_Loop` and `Main_Menu`; after `parent:Destroy()`, both handles have `stopped = true`.
Browser: main menu with a running background movie and music.

---

## Afterwards (not part of this plan)

Intel/FoW (blips, ghosts — [intel-vision.md](research/intel-vision.md)), shields, beam weapons,
assist (multiple builders at one construction site), reclaim/repair/capture, veterancy, air and naval,
particle system, victory conditions, AI, lockstep/replays, campaign, mods.
→ [MASTERPLAN.md](MASTERPLAN.md), phases D–F.

---

# Conflicts & open questions

## To be decided by the user

**A. Movie: honest `false` path or a Sofdec decoder?**
The two research documents assess the same behavior in opposite ways.
[frontend-menu.md](research/frontend-menu.md):96-101 describes an `InternalSet` that returns `false`,
*"the documented engine behavior, not a stub"* (Cfile:1143020-1143035, `/nomovie`).
[maui-controls.md](research/maui-controls.md):236-240 calls exactly that *"a lie as long as the file
would be readable"* and requires a decision.
**Resolution that satisfies both:** `false` is honest only when it is the **result of a set flag**.
Therefore expose `/nomovie` or `movie.nologo` as an **explicit, visible** command-line option/preference
(the engine has both) — an `InternalSet` that silently returns `false` without a set flag would be a
stub in the production path and is prohibited.
**The user decision remains open:** build a Sofdec decoder (MPEG-1 + CRI-ADX), or leave the flags set
permanently? The main menu works **both** ways.

**B. Skirmish button (lobby) or command-line launch?**
There is **no** faithful route from the menu to a Skirmish session **without** the lobby:
main.lua:909-922 goes through `lobby.CreateLobby`/`HostGame` → `CLobby` (18 methods, `LaunchGame`
@Cfile:1170898). The cheaper but still **real** route is `StartCommandLineSession` (`/map`,
Cfile:1373521/1373668 → `LaunchSinglePlayerSession`) — that is M5. The plan puts M5 first.
**Question:** Is `?map=<x>` sufficient as an interim state (then bring M6–M10 forward), or should M11
immediately follow M5 because the target experience literally says "Skirmish"?

**C. Determinism now or later?**
`Sim::Setup` seeds a Mersenne Twister from `sessionInfo.RandomSeed` (Cfile:1071820), making the Sim
reproducible. Our `Random` does not yet exist; if it is `Math.random`, it will not be reproducible
(with consequences for replays and multiplayer). **Both M4 and M8 introduce random sources** — adding
determinism later means revisiting each one. The **exact** generator is not binary-verified.

## Contradictions between the research documents — resolved

**1. Where do key events go?**
[input-cursor-keymap.md](research/input-cursor-keymap.md):193-201 marks this as **OPEN** ("the location
… was not found in the Decomp"). [maui-controls.md](research/maui-controls.md):92-101 **has it**:
three dispatchers — `MET_KeyDown` @Cfile:1147634, `MET_KeyUp` @1147668, `MET_Char` @1147745 — all with
the same order: **focused control first** (if it returns `false`, the capture stack is **not** queried;
the event goes to the console keymap as `skipped`), **otherwise** the capture top, otherwise nothing.
This is compatible with `MakeInputModal`: a modal dialog generally has *no* focused control, so stage 2
applies.
**Still open:** whether key events bubble up the **parent chain** — `PostEvent` (Cfile:1124517) is never
called for keys, yet `MakeInputModal` (uiutil.lua:615-645) relies on the capture control's `HandleEvent`
seeing them. → Mark as an **assumption** in M1 (capture top receives them directly; no bubbling) and
revise it at the first contradiction.

**2. When is the `draws()` filter removed from hit testing?**
[maui-controls.md](research/maui-controls.md) (step 9) and
[worldview-camera.md](research/worldview-camera.md) (S2) say the same thing, but it is an easy-to-miss
**hard coupling**: the filter must be removed **only after** `CUIWorldView` exists (otherwise the
full-screen Group consumes every click), and it **must** be removed once it exists (otherwise the
minimap and chat window accept no clicks). **Both belong in one commit** (M7, item 9).

**3. "Not a single maui control is missing for the session UI" vs. "`border_methods` is an empty
class."** Both appear in [maui-controls.md](research/maui-controls.md) (§5 vs. §4.1) and only seem to
conflict: Border is **half** built (`InternalCreateBorder` + LazyVars exist, methods do not). Our panels
currently run only because **no one calls `SetNewTextures` yet**. → **M1**, not later.

**4. WorldView early or late?** [session-ui-panels.md](research/session-ui-panels.md) puts
`CUIWorldView` at position 10 in its list, while [worldview-camera.md](research/worldview-camera.md)
treats it as a foundation. **Resolution:** it is not blocking for the **current panels** (they run), but
it is the bottleneck for **everything else** (minimap, cursor, draggers, box selection, hit testing) —
and `gamemain.CreateUI` calls it on line 142. Therefore **M7, before M10**.

**5. Audio: CLAUDE.md and STATUS.md are wrong.** Both say "FMOD banks from `sounds.scd`"
(STATUS.md also refers to a `research/sound-fmod.md` that **does not exist**). The hex-verified research
[effects-audio.md](research/effects-audio.md):19/217-224 says: **XACT** (78 `.xwb`/`WBND`, 80 `.xsb`/
`SDBK`, `SupCom.xgs`/`XGSF`), and **there is no `sounds.scd`**. → Correct CLAUDE.md and STATUS.md
(with M12).

**6. `Random` has three consumers but only one binding.** session-start (Mersenne, seed from
`sessionInfo.RandomSeed`, Cfile:1071820), combat (`DeathThread` dies immediately without `Random`), and
scenarioutilities.lua:391. From the beginning, it must be the **deterministic Sim RNG**, not
`Math.random` (→ decision C).

## Invented values in the production path — must be removed

| Where | What | addressed in |
|---|---|---|
| [ui-globals.lua](../src/engine-lua/ui-globals.lua):654 | `GetVersion() → 'CFA'` — visible in the main menu (main.lua:172). The source of the real string is **unverified** (core global, Cfile:599401). | M2 |
| [moho.lua](../src/engine-lua/moho.lua):522 | `GetTopmostDepth() → 5000000` — guessed. Real binding Cfile:1136937; return value **unread**. | M1 |
| [globals.lua](../src/engine-lua/globals.lua):42-43 | `IsAlly`/`IsEnemy` compare army indices instead of the alliance table. | M4/M8 |
| [unitViewer.ts](../src/viewer/unitViewer.ts) | `rtsPitch()` invents the pitch↔zoom curve; the real one is in `CameraImpl` and has **not been read**. | M7 |
| [session.ts](../src/sim/session.ts):61-72 | `ScenarioInfo` built by hand instead of deserialized. | M4 |

## Still open — do not guess; mark as an assumption during implementation

1. **`Projectile::CheckCollision` (@0x69D1D0) is not decompilable** (IDA fails on 0xC9A
   bytes). Collision volume (`CollisionShape` box/sphere from `SizeX/Y/Z`) or bounding radius?
   `Wm3::DistVector3Segment3f::GetSquared` suggests "line-segment-to-point distance against radius", but
   it is not proven. (M8)
2. **`ui_SelectTolerance` — pixels or world metres?** `UpdateSelection` expands the box **before**
   ray testing (Cfile:1298979), which suggests screen pixels. Not verified. (M7)
3. **`COMMOD_Ping`** — the enum value is **not established**; `None=0, Order=1, Build=2, BuildAnchored=3,
   Select=4, CommandDrag=5` are derived from the code. (M7)
4. **`CameraScreenToSurface` vs. `Unproject`** — does `ScreenToSurface` include the water surface?
   (Clicks on the sea.) The **pitch↔zoom coupling** in `CameraImpl` has also not been read. (M7)
5. **`SetRenderPass(UIUtil.UIRP_UnderWorld | UIUtil.UIRP_PostGlow)`** (worldview.lua:39,
   original comment: *"don't change this or the camera will lag one frame behind"*) — the world is
   rendered **between** UI render passes. What this means for a DOM-over-canvas renderer (z-order,
   one-frame offset) remains open. (M7)
6. **`RUnitBlueprintWeapon` constructor** cannot be found in the Cfile as a separate function; the
   weapon blueprint defaults (`FiringTolerance 0.01`, `RateOfFire 1.0`, `TrackingRadius 1.0`,
   `TargetCheckInterval 3.0`, `HeadingArcRange 180`, `IgnoresAlly 1`) currently come **only from
   faf-re** ([weapons.md](research/weapons.md)) — binary-check them before adding them to
   `blueprints.lua`. (M8)
7. **Blips.** Target acquisition in the original runs through the reconnaissance database
   (`unit->mBlipsInRange`, Cfile:793167). We have none. "All units of the enemy army in range" is a
   **deliberate deviation**, not a reimplementation — it is replaced only with
   [intel-vision.md](research/intel-vision.md). (M8)
8. **`currentScores` is set nowhere in the retail Lua** (score.lua:10 `currentScores = false`; read in
   score.lua:243 and objectives2.lua:130). Where does the score come from — per beat from
   `GetArmyScore(i)`, or from a Sim script we did not find? (M10)
9. **How does `Sync` cross the worker boundary?** The original uses `SCR_ToByteStream`/
   `SCR_FromByteStream` (Cfile:1328276). Ours uses structured clone, but only while `Sync` contains no
   Lua functions/userdata. Must be checked. (M6)
10. **`GetGameTime` returns a string, `GameTime` seconds** — the format in
    `cfunc_GetGameTimeL` (Cfile:1266614) has not yet been read. (M6)
11. **`IsSignedInToSteam()`** (main.lua:900) is **not** in `scr_UserInits` (205 globals). The user's
    `lua.scd` is therefore from a **different build** than `Cfile/ForgedAlliance.exe.c`. Today this
    affects only the matchmaking button, but it is a split between source 1 (Decomp) and source 2
    (original Lua). Are there others? Which source wins in a conflict? (M2/M11)
12. **`SetArmyStart` has no `y`**; `CreateInitialArmyUnit` constructs with `pos.y = 0.0`
    (Cfile:1025261). Does the unit constructor set height from the heightfield, or does the first
    motion tick? Not checked. (M4)
13. **Two prop sources:** ` Sim Setup 7` (Cfile:1072049-1072081) creates props from `LaunchInfo`, in
    parallel with `ScenarioUtils.CreateProps()` from the schook hook. Presumably, the C++ path is for
    saved games/replays — **not verified**. The Lua path is sufficient for Skirmish. (M4)
14. **Does the hook mechanism also apply to `import()`?** It is established for file loading
    (Cfile:595822). Irrelevant to our 8 schook files (all through `doscript`), but not later for mods.
    (M4)
15. **`AcquireKeyboardFocus(bool blocksKeyDown)`** — where the flag takes effect has not been traced
    (Cfile:1125768-1125790). Presumably, it decides whether an unhandled `KeyDown` falls through to
    the keymap. (M1/M3)
16. **`FlushEvents`** — which queue (wx or maui)? Without knowing its effect, a no-op here would be a
    stub and is therefore prohibited. (M2)
17. **`MET_MouseHover` (=3)** is never generated by us. What triggers it, and after which delay?
    (Tooltips currently depend on `MouseEnter`.) (M1)
18. **`ScrollPages`** — the Decomp has `RunScript` call sites for `GetScrollValues`, `ScrollLines`,
    and `ScrollSetTop`, but **none** for `ScrollPages`; Lua implements it anyway (filepicker.lua:307).
    (M9)
19. **The XACT cue→sound→track chain** is **not** verified (only the header structures of WBND and
    SDBK are hex-checked, effects-audio.md:288). (M12)
20. **The blueprint is read twice** — by the TypeScript parser in `main.ts` (models/bones) **and** the
    real `LoadBlueprints()` pipeline. Two sources of truth. M8 needs bone transforms in the Sim; at
    that point at the latest, the authoritative source must be decided.
