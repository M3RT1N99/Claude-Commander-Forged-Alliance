# The real front-end: Splash, main menu, way into the session

How the engine boots the front end, what `lua/ui/menus/main.lua` charges for it and what
we still lack it. Added [engine-api.md](engine-api.md) (list of all bindings per VM)
and [game-shell.md](game-shell.md); Session start itself is **not** an issue here — just
the transition.

## 1. Overview

There is **one** UI Lua VM for the whole application. `Moho::USER_GetLuaState`
(Cfile:1368027-1368075) is a singleton (`sUserLuaState`) that is activated on the first call
is created and `scr_CoreInits` + `scr_UserInits` is registered **once**. splash,
Main menu, lobby and game UI all run in **the same** VM.

What changes is not the VM, but the **UI state**:

```
UIS_none=0  UIS_splash=1  UIS_frontend=2  UIS_game=3  UIS_lobby=4   (Cfile:1262301-1262311)
```

`GetCurrentUIState()` then returns `'splash'`, `'frontend'` or `'game'`
(mHelp, Cfile:1265924).

## 2. The boot chain (with receipts)

### 2.1 The state change: `CUIManager::SetNewLuaState` (@0x84C4E0-ff, Cfile:1273520)

Every change goes through this one function. She does in turn:

1. Clear input capture stack and current dragger (Cfile:1273557-1273564).
2. Alte Root-Frames freigeben, `mState = neuerState` (Cfile:1273600-1273605).
3. Place `__EngineStats` table in the globals (Cfile:1273610).
4. **Create a `CMauiFrame` per head** (Cfile:1273621) and set its LazyVars:
   `Left=0, Top=0, Width=w, Height=h` (Cfile:1273661-1273666).
   Failure ⇒ `gpg::Die("CUIManager::Init - unable to create root frame for head %d.")`
5. **Call `SetupUI()` from `/lua/ui/uimain.lua`** (`sub_83CD30`, Cfile:1262316-1262345;
   Call Cfile:1273680). Failure ⇒ `gpg::Die("... unable to start main UI script.")`

**So the root frame exists BEFORE `SetupUI()`** — and `SetupUI()` runs on **everyone**
Change of state new, not just once. That's exactly what the comment in is aimed at
uimain.lua:22-25 („SetCursor needs to happen anytime this function is called").
`uimain.lua:29` (`if alreadySetup then return end`) only protects the rest.

### 2.2 The four entrances (all: `USER_GetLuaState` → `sUIState=…` → `SetNewLuaState` → `SCR_Import('/lua/ui/uimain.lua')[X]()`)

| Engine function | Address/Cfile | calls in uimain.lua |
|---|---|---|
| `Moho::UI_StartSplashScreens` | 0x83CE20, Cfile:1262357 | `StartSplashScreen` (uimain.lua:41) |
| `Moho::UI_StartFrontEnd` | 0x83D140, Cfile:1262476 | `StartFrontEndUI` (uimain.lua:46) |
| `func_StartHostLobbyUI` / `func_StartJoinLobbyUI` | 0x83CF20 / 0x83D030 | `StartHostLobbyUI` / `StartJoinLobbyUI` (uimain.lua:68/76) |
| `func_StartGameUI` | 0x83D240, Cfile:1262514 | `StartGameUI` (uimain.lua:83) |

The Lua globals `EngineStartSplashScreens()` / `EngineStartFrontEndUI()` are only thin
Wrapper around it (Cfile:1263777-1263805 or 1263827) — mHelp: *“kill current UI and start
splash screens"*.

### 2.3 Anwendungsstart (`main`, Cfile:1373640-1373870)

Order of command line checks; the last branch is the normal case:

- `/map <x>` bzw. `/perf` → `func_StartCommandLineSession` (Cfile:1373521) ruft
  `singleplayerlaunch.lua:StartCommandLineSession` (Cfile:1373668, 1373854)
- `/replay <f>` → writes `FrontEndData.replay_filename` into the UI globals (Cfile:1373686)
- `/joingame`, `/gpgnet`, `/hostgame` → Lobby-Einstiege
- **otherwise: `Moho::UI_StartSplashScreens()`** (Cfile:1373865)

Return path: `sub_88C9C0` (Cfile:1321251) = `WLD_Teardown()` → `UI_StartFrontEnd()`. After
After the game you end up back in the main menu, and because `SetNewLuaState` the frames
new, the Maui tree is empty.

### 2.4 `uimain.lua` — what happens afterwards

- `SetupUI()` (uimain.lua:20-37): `UIUtil.CreateCursor()` + `SetCursor(c)`; einmalig
  Layout from `Prefs.GetFromCurrentProfile('layout')` (default `'bottom'`) and
  `UIUtil.SetCurrentSkin(skin or 'uef')`.
- `StartSplashScreen()` (uimain.lua:41-44) → `splash.lua:CreateUI()`.
- `StartFrontEndUI()` (uimain.lua:46-64):
  1. `if not DebugFacilitiesEnabled() then IN_RemoveKeyMapTable(keyMap.debugKeyMap) end`
     — **will always run for us** because `DebugFacilitiesEnabled()` returns false.
  2. `GetFrontEndData('NextOpBriefing')` → Campaign briefing, otherwise
     `import('/lua/ui/menus/main.lua').CreateUI()`.
  3. `GetNumRootFrames() > 1` → `multihead.lua`.

### 2.5 `splash.lua` — and the honest way out

`splash.lua:14-19` spielt vier `.sfd`-Filme (thqlogo, gpglogo, nvidia_logo,
fmv_scx_intro) with FMOD cues. But **Lines 22-25**:

```lua
if GetPreference("movie.nologo") then
    EngineStartFrontEndUI()
    return
end
```

This is an original path, not a trick: set preference ⇒ no splash. Second
Original way out: `CMauiMovie::LoadFile` returns **false** if `/nomovie` on the
Command line is (Cfile:1143020-1143035) — `movie.lua:32-53` intercepts this
(`local ok = self:InternalSet(filename)`; `else self:OnStopped()`). A `Movie`, whose
`InternalSet` returns false, so it is **the documented engine behavior**, not a
Stub. This means that the main menu can run correctly without an SFD decoder.

## 3. `lua/ui/menus/main.lua` — what the main menu asks for

`CreateUI()` (main.lua:50-993), in order:

| line | What |
|---|---|
| 52 | `UIUtil.SetCurrentSkin('uef')` |
| 57-62 | without `GetPreference("profile.current")` → `dialogs/profile.lua` instead of menu |
| 65-142 | Menu tables: `menuTop` (Campaign, Skirmish, Multiplayer LAN, …, Options, Exit), `menuExtras`, `menuMultiplayer` |
| 148 | `parent = UIUtil.CreateScreenGroup(GetFrame(0), "Main Menu ScreenGroup")` |
| 151-153, 34-48 | `Prefs.GetOption("mainmenu_bgmovie")` (Default **true**, options.lua:358-371) → `Movie('/movies/main_menu.sfd')`, `Loop(true)`, `Play()` |
| 166-198 | Bitmaps: `/scx_menu/logo/logo.dds`, `border-console-top_bmp.dds`, `border-bot-{left,mid,right}.dds` |
| 172 | `UIUtil.CreateText(border, GetVersion(), 14, UIUtil.bodyFont)` |
| 208-222 | Running text (EULA) via `SetNeedsFrameUpdate(true)` + `OnFrame` |
| 231-255 | `PlaySound(Sound{Cue='AMB_Menu_Loop',Bank='AmbientTest'})`, Musik `Sound{Cue='Main_Menu',Bank='Music'}`; `StopSound(handle)` in `StopMusic`/`OnDestroy` |
| 258-295 | `topLevelGroup`, `mainMenuGroup`, six bracket bitmaps from `/scx_menu/main-menu/` |
| 297-327 | `menuBracketMiddle.Animate` — Retract animation via `OnFrame` + `PlaySound('X_Main_Menu_On_Start')` |
| 341-820 | `MenuBuild(menuTable)`: Title bitmap `/menus/main03/panel-top_bmp.dds` + text, profile button, then **per entry** `UIUtil.CreateButtonStd(mainMenuGroup, '/scx_menu/large-no-bracket-btn/large', v.name, 22, 2, 0, "UI_Menu_MouseDown", "UI_Menu_Rollover")` (543), `btn:UseAlphaHitTest(false)` (555), glow bitmap + `EffectHelpers.FadeIn/FadeOut` (567-590), `Tooltip.AddButtonTooltip` (593) |
| 990-992 | `MenuBuild('home', true)` and `FlushEvents()` |

Imports of main.lua: `uiutil`, `layouthelpers`, `effecthelpers`, `bitmap`, `menucommon`,
`multilinetext`, `button`, `group`, `prefs`, `ui/game/tooltip`, `maputil`, `ui/help/tooltips`,
`movie`, `mods` (main.lua:9-22).

**Attention, import side effect:** `effecthelpers.lua:28` calls at **module level**
`UIUtil.CreateScreenGroup(GetFrame(0), "Effect Helper ScreenGroup")`. Without root frame
the import is already banging.

## 4. Missing engine bindings

All from `scr_UserInits` (engine-api.md), all in today
[ui-globals-missing.lua](../../src/engine-lua/ui-globals-missing.lua) → sie werfen beim Aufruf.

### 4.1 For main menu **mandatory**

| Name | Semantics (Decomp) | receipt | used by |
|---|---|---|---|
| `EngineStartFrontEndUI` | Clear UI, `sUIState=UIS_frontend`, `uimain.StartFrontEndUI()` | Cfile:1263827, 1262476 | splash.lua:23/51 |
| `EngineStartSplashScreens` | ditto for `UIS_splash`, `uimain.StartSplashScreen()` | Cfile:1263790, 1262357 | boat |
| `GetFrontEndData` / `SetFrontEndData` | read/write to the **UI global table `FrontEndData`** | Cfile:1268794 / 1268715; Table access 1268831 / 1268751 | uimain.lua:56 |
| `IN_RemoveKeyMapTable` | „removes the keys from the key map" | Cfile:1260010 | uimain.lua:52 |
| `StopSound(handle,[immediate=false])` | Handle stoppen | Cfile:1348237 | main.lua:242/249 |
| `PlaySound` **must provide a handle** | today `nil` → `StopSound` would get nothing | Cfile:1348174 (`StartSound(handle)`) | main.lua:231/236 |
| `FlushEvents()` | „flush mouse/keyboard events" | Cfile:1274594 | main.lua:992 |
| `ExitApplication` | „request that the application shut down" | Cfile:1263877 | main.lua:980 |
| `InternalCreateMovie(luaobj,parent)` | + `moho.movie_methods`: `InternalSet`, `Play`, `Stop`, `Loop`, `IsLoaded`, `GetFrameRate`, `GetNumFrames`; LazyVars **`MovieWidth`/`MovieHeight`** | Cfile:1143258; LazyVars 1142984-1142985; `LoadFile`→false at `/nomovie` 1143020-1143035 | main.lua:35, splash.lua:32 |
| `GetVersion()` | Core-Global, `"GetVersion() -> string"` | Cfile:599401 | main.lua:172 — heute **erfunden** (`'CFA'`) |

### 4.2 For Splash additionally

| Name | Semantics | receipt |
|---|---|---|
| `GetCursor()` | returns the cursor object (CMauiCursor, 5 methods) | Cfile:1274426; splash.lua:27/52 |
| `AddInputCapture(control)` | „set a control as the current capture" | Cfile:1147871; splash.lua:30 |
| `RemoveInputCapture(control)` | „remove … (always first from back)" | Cfile:1147921; splash.lua:49 |
| `AnyInputCapture` / `GetInputCapture` | Stack abfragen | Cfile:1147773 / 1147818 |
| `SoundIsPrepared(handle)`, `StartSound`, `PlayVoice(params,duck)` | Movie is waiting for it in `movie.lua:37-49` | Cfile:1348102 / 1348174 / 1348652 |

### 4.3 For submenus (later)

`InternalCreateItemList` (Cfile:1140074), `InternalCreateEdit` (1133710),
`InternalCreateScrollbar` (1144735), `InternalCreateMapPreview` (1276475),
`InternalCreateLobby` (1168970, class `CLobby` with 18 methods),
`InternalCreateDiscoveryService` (1168381), `GetAntiAliasingOptions`,
`GetVolume`/`SetVolume` (options.lua:700-807), `OpenURL`, `GetSpecialFile*`.

**Not in the decomp:** `IsSignedInToSteam()` (main.lua:900) appears in
`scr_UserInits` **not** on → see open questions.

## 5. Current status of our engine

**There:** [maui.lua](../../src/engine-lua/maui.lua) — `InternalCreateFrame/Group/Bitmap/Text/Border`,
the seven LazyVars, `DoInit→OnInit`, hit test, event pump (`__mauiMouse`, `__mauiWheel`,
Parent bubbling like Cfile:1124525), frame pump (`__mauiFrame`), snapshot for the renderer.
[moho.lua](../../src/engine-lua/moho.lua) — `control_methods` (25), `bitmap_methods` (18,
including `UseAlphaHitTest`), `text_methods`, `frame_methods`, `cursor_methods`.
[ui-globals.lua](../../src/engine-lua/ui-globals.lua) — `GetPreference`/`SetPreference`/
`SavePreferences`/`GetOptions` (in-memory + localStorage), `GetFrame`/`GetNumRootFrames`,
`_c_CreateCursor`/`SetCursor`, `PlaySound` (protocol only), `ConExecute`,
`DebugFacilitiesEnabled`, `HasCommandLineArg`.
[uiEngine.ts](../../src/lua/uiEngine.ts) — `installUiEngine()`, `setupUi()` (ruft
the real `uimain.SetupUI()`), `createRootFrame()`, `setupGameUi()`.

**Missing/incorrect:**

1. **There is no front-end boot.** [gameUi.ts](../../src/ui/gameUi.ts):106-116 jumps
   directly in `setupGameUi()`. No `StartSplashScreen`, no `StartFrontEndUI`, no `main.lua`.
2. **Order reversed:** gameUi.ts:106-107 calls `setupUi()` **before** `createRootFrame()`.
   The engine does it the other way around (root frame Cfile:1273621-1273666, then SetupUI
   Cfile:1273680). As long as `SetupUI` is running, it is not noticeable; `effecthelpers.lua:28`
(module level, `GetFrame(0)`) would immediately tear it.
3. **`GetVersion()` returns `'CFA'`** — a made-up number in the production path
   (ui-globals.lua:654). It is visible in the main menu (main.lua:172).
4. **`PlaySound` does not return a handle**, `StopSound`/`StartSound`/`SoundIsPrepared`
   are completely missing → every music/movie control is dead.
5. **No `moho.movie_methods`.** The auto-vivifier in moho.lua provides an **empty one
   Class**; `movie.lua:32` (`self:InternalSet(...)`) then pops with “attempt to call a nil
   value" — loud, but far from the cause.
6. **No input capture, no keymap, no `FlushEvents`.**
7. **The maui renderer does not know any `movie` child** (`draws()` in maui.lua:225-235 only knows
   `bitmap`/`text`).

## 6. Construction sequence (smallest honestly testable steps)

**Step 1 — Front End Boot without Splash, without Movie.**
`createRootFrame()` **drag before** `setupUi()`; `startFrontEnd(host)` to `uiEngine.ts`
(counterpart to `setupGameUi`), which calls `import('/lua/ui/uimain.lua').StartFrontEndUI()`.
Plus the minimal globals: `EngineStartFrontEndUI`, `EngineStartSplashScreens`,
`FrontEndData = {}` + `Get/SetFrontEndData`, `GetCurrentUIState`, `IN_AddKeyMapTable`/
`IN_RemoveKeyMapTable`/`IN_ClearKeyMap`, `FlushEvents`, `ExitApplication`, echtes
`GetVersion()` (from the installation, not invented).
So that `main.lua` starts without film: `Prefs.SetOption('mainmenu_bgmovie', false)` — the
Original way (options.lua:358-371), no special case in the code.
*Verification:* `scripts/verify-frontend.ts` — Boot UI VM, `StartFrontEndUI()`, then
`__mauiSnapshot()`: there must be `logo.dds`, `border-console-top_bmp.dds` and **exactly as many
`large_btn_up.dds` bitmaps give as `menuTop` has entries** (main.lua:104-142).

**Step 2 — Audio Handles (without output).**
`PlaySound` returns a handle object (table with bank/cue/state); `StartSound`,
`StopSound`, `SoundIsPrepared`, `PauseSound`, `PlayVoice`, `PauseVoice`, `GetVolume`,
`SetVolume` work on it. Don't invent an output - just keep the situation as before
protokollieren.
*Verification:* `__uiSoundsRequested` contains `AMB_Menu_Loop` and `CreateUI()`
`Main_Menu`; after `parent:Destroy()` is `stopped = true` for both handles.

**Step 3 — Menu operable.**
Mouse events via `__mauiMouse` (already written) to the buttons; `Tooltip`, `EffectHelpers`
then run automatically. `AddInputCapture`/`RemoveInputCapture`/`GetInputCapture`/
`AnyInputCapture` as a real stack (Cfile:1147871/1147921).
*Verification (browser, `?frontend`):* Clicking on “Options” builds `dialogs/options.lua`;
Clicking on "Skirmish" must fail with **exactly one** message:
`InternalCreateLobby: … noch nicht implementiert` (lobbycomm.lua:121). That's the one
honest proof that the chain runs all the way to the lobby.

**Step 4 — Movie Control.**
`InternalCreateMovie` + `moho.movie_methods` + LazyVars `MovieWidth`/`MovieHeight`.
`InternalSet` initially returns **false** — exactly the `/nomovie` behavior
(Cfile:1143020-1143035), i.e. `OnStopped()`. This means that `mainmenu_bgmovie=true` and
`splash.lua` can run without rendering a single frame or number
would be invented. SFD decoder is a separate topic.

**Step 5 — Splash.**
`GetCursor()` + input capture; `movie.nologo`-Preference remains as an abbreviation.

**Step 6 — Transitioning into the session.**
Two original ways, the skirmish button is the **more expensive** one:

- **Lobby** (main.lua:909-922): `lobby.CreateLobby('None', 0, playerName, nil, nil,
  topLevelGroup, cb)` + `lobby.HostGame(name, scenarioFileName, true)`. Needs
  `InternalCreateLobby` (lobbycomm.lua:121) and the class `CLobby` (18 methods); the
  Start then runs via `CLobby::LaunchGame` (Cfile:1170898) — a large engine function
  (LaunchInfoNew, ClientManager, NetConnector).
- **`LaunchSinglePlayerSession(sessionInfo)`** (Cfile:1321744): mHelp *„launch a new single
  player session."*, Rumpf = `WLD_SetupSessionInfo(luaTable)` → `WLD_BeginSession(...)`
  (Cfile:1321776-1321782); throws if a session is already running. Take exactly this route
  Campaign (main.lua:864), tutorial and
  `singleplayerlaunch.lua:StartCommandLineSession` (297-324 → `SetupCommandLineSkirmish`,
  228-294 → `LaunchSinglePlayerSession`, 323).

**Recommendation:** use `LaunchSinglePlayerSession` + `StartCommandLineSession` first —
this is a real entry wired into the engine (`/map`, Cfile:1373668), generated
`sessionInfo` (teamInfo, factions, colors, scenarioMods) completely from the original Lua
and needs **no** lobby. The skirmish button comes after.

## 7. Offene Fragen

1. **`IsSignedInToSteam()`** (main.lua:900, `ButtonMatchmaking`) is **not** in
   `scr_UserInits` (engine-api.md, 200 globals). So the user's `lua.scd` is off
   a build other than `Cfile/ForgedAlliance.exe.c`. Only affects that
   Matchmaking button — but: are there other such divergences in the front end?
2. **`GetVersion()`** — where does the string come from? Core-Global (Cfile:599401), but the
   Source (resource? `version.lua`?) is unchecked. Until then it must not be invented.
3. **`FrontEndData`** is placed by the engine in the globals (Cfile:1268751) - where
   Where is the table **created**? (With `/replay` it is created without prior creation
   beschrieben, Cfile:1373686.)
4. **`func_StartGameUI`** gets a `LuaState*` as argument (Cfile:1262514) — that is
   always `USER_GetLuaState()`, or is there a second state for the game UI?
   Irrelevant to us today (a UI VM), but the assumption should be proven.
5. **`_head_test` / Multihead** (`GetNumRootFrames() > 1`, uimain.lua:61) — we have exactly
   a frame. Will it stay that way?
6. **SFD format** (`/movies/*.sfd`) — unchecked. As long as `InternalSet` is honestly false
   delivers, it blocks nothing.
