-- =====================================================================
-- What the ENGINE does when booting up the UI — in Lua, not in TS.
--
-- This file is the counterpart to what is known in the C++ engine as fixed
-- The process is: ensure profile, apply options, start front-end,
-- Open game UI. Until now, this Lua code was in TS template literals
-- (`host.eval(\`…\`)`) — and therefore in a place where no tool can use it
-- Lua sees: no syntax highlighting, no checking, and a backtick all in one
-- Comment silently ends the TS string. CLAUDE.md expressly prohibits this.
-- TS is just loader and bridge.
--
-- STANDARD LUA 5.4 (goes raw in host.eval, not through the FA transpiler).
-- =====================================================================

--- A user profile must exist.
---
--- prefs.lua:96 accesses it without checking, and main.lua:57-62 builds without it
--- `profile.current` the profile dialog instead of the menu. It is created via
--- the original way: Prefs.CreateProfile (prefs.lua:31) — the same function that
--- uses the game when someone starts it for the first time; she sets
--- `profile.current` selbst (prefs.lua:57).
function __uiEnsureProfile()
  local Prefs = import('/lua/user/prefs.lua')
  if not Prefs.ProfilesExist() then
    Prefs.CreateProfile('Commander')
  end
end

--- Apply the options — the call that the engine itself makes.
---
--- Moho::OPTIONS_Apply() (Cfile:1368338-1368360) ruft
--- `SCR_Import('/lua/options/optionslogic.lua')['Apply']` mit `Call_True_Obj`,
--- so Apply(true). This means that ALL `set` functions of the 37 options work
--- startup=true (that's why primary_adapter/vsync/antialiasing calls
--- NO ConExecute — they are already set at startup).
---
--- Without this call, not a single option works at startup: the saved one
--- Value is in the prefs, but nobody puts it into the engine.
function __uiApplyOptions()
  import('/lua/options/optionslogic.lua').Apply(true)
end

--- Start the front-end (Splash -> main.lua) like main() does.
---
--- Cfile:1373865: the engine calls without command line arguments
--- Moho::UI_StartSplashScreens().
---
--- `movie.nologo` is the original preference for protecting the logo films
--- skip (splash.lua:22-25: then immediately EngineStartFrontEndUI()). We
--- put them because this engine doesn't have an SFD decoder — that's the same situation
--- like `/nomovie` on the command line (Cfile:1143020-1143035).
---
--- It is NECESSARY, not convenient: if a film doesn't load, movie.lua:52 calls
--- `OnStopped()`, and splash.lua only handles `OnFinished` (splash.lua:75) —
--- So the splash would stay until someone presses a key. Just as
--- the original also behaves with /nomovie.
---
--- The BACKGROUND FILM of the menu no longer needs a special case:
--- `mainmenu_bgmovie` remains the real option (default true), main.lua:151 builds
--- its Movie, InternalSet honestly returns false, and the menu is without a movie.
function __uiStartFrontEnd()
  SetPreference('movie.nologo', true)
  EngineStartSplashScreens()
end

--- SetupUI() from the Original-uimain.lua — the entry point that the engine
--- selbst ruft (Cfile:1262333: SCR_Import('/lua/ui/uimain.lua')['SetupUI']()).
function __uiSetupUi()
  import('/lua/ui/uimain.lua').SetupUI()
end

-- =====================================================================
-- The world launch — the engine's provider chain
-- =====================================================================

--- func_StartGameUI (Cfile:1262514): sets the UI state to UIS_game and
--- calls uimain.StartGameUI() — the WldUIProvider is created there
--- (gamemain.lua:225, "SHOULD NOT BE CALLED FROM LUA CODE"). The engine is calling
--- it TWICE: at world start (func_DoPreload, Cfile:1320768) and after
--- Reload with fresh root frames (DoInitializing, Cfile:1321035) —
--- the second call clears the loading dialog. Whoever the chain in ONE
--- VM runs twice, has to call __mauiResetFrames() in between (that is
--- the SetNewLuaState of the engine).
function __uiStartGameUI()
  -- func_StartGameUI (Cfile:1262514) sets sUIState = UIS_game (3) BEFORE the
  -- Lua call — the enter fallback of the key handler (chat) checks it.
  __uiState = 3
  import('/lua/ui/uimain.lua').StartGameUI()
end

--- The engine's loading dialog calls, with the same Nil check as in
--- Original (`if ( sWldUIProvider )`, Cfile:1320769/1321066):
---   StartLoadingDialog  beim Weltstart (Cfile:1320770)
--- UpdateLoadingDialog(elapsed) per image while loading (Cfile:1295322)
--- StopLoadingDialog after the first beat with sync data (Cfile:1321067)
--- StopLoadingDialog shows the faction image, hides it after 1.5 s and
--- forks InitialAnimations (gamemain.lua:253-263) — FIRST THAT will score,
--- Economy, avatars and tabs displayed. Without this chain they stand
--- Panels forever invisible.
function __uiProviderStartLoading()
  -- WorldIsLoading() is true between DoPreload and DoInitializing —
  -- uimain.EscapeHandler (uimain.lua:120) suppresses ESC during loading.
  __uiWorldLoading = true
  if __uiWldProvider then __uiWldProvider:StartLoadingDialog() end
end

function __uiProviderUpdateLoading(elapsed)
  if __uiWldProvider then __uiWldProvider:UpdateLoadingDialog(elapsed) end
end

function __uiProviderStopLoading()
  __uiWorldLoading = false
  if __uiWldProvider then __uiWldProvider:StopLoadingDialog() end
end

-- =====================================================================
-- The Game UI (gamemain.lua:145-154)
-- =====================================================================

--- The screen tree, exactly as gamemain.lua creates it: ONE screen group,
--- inside the four clusters of borders.lua. All panels depend on these groups
--- — if you attach them to GetFrame(0) instead, you get every panel to them
--- wrong location (the layout files calculate against the cluster, not against the
--- Screen).
---
--- The handles live in the table `__ui`, not in globals: `x = nil`
--- no key under the strict _G (config.lua:51-56), and the
--- spaetere Lesezugriff wirft "access to nonexistent global variable".
function __uiCreateScreenTree()
  __ui = {}
  UIUtil = import('/lua/ui/uiutil.lua')
  __ui.gameParent = UIUtil.CreateScreenGroup(GetFrame(0), 'GameMain ScreenGroup')
  __ui.controlCluster, __ui.statusCluster, __ui.mapGroup, __ui.windowGroup =
    import('/lua/ui/game/borders.lua').SetupBorderControl(__ui.gameParent)

  -- The ONE-SHOT from gamemain.lua:136-140, literally: in the FIRST picture after that
  -- Setup runs gamemain.OnFirstUpdate() - this is where the points panel is created
  -- (score.lua:CreateScoreUI), the ACU gets the player name, music and
  -- the start zoom starts. Without the hook, all of this would be missing without comment.
  __ui.controlCluster:SetNeedsFrameUpdate(true)
  __ui.controlCluster.OnFrame = function(self, deltaTime)
    __ui.controlCluster:SetNeedsFrameUpdate(false)
    import('/lua/ui/game/gamemain.lua').OnFirstUpdate()
  end

  -- This framework is our provider.CreateGameInterface (gamemain.lua:316-328)
  -- — and in the end it creates two states without which the UI gets stuck:
  -- supressExitDialog = false (line 326; StartLoadingDialog had it set to true
  -- set — as long as it remains true, ESC is DEAD in the game, uimain.lua:120)
  -- and FlushEvents (line 327).
  import('/lua/ui/game/gamemain.lua').supressExitDialog = false
  FlushEvents()
end

--- The game UI panels, in the order from gamemain.lua:145-154.
--- Each panel is built INDIVIDUALLY so that any missing engine part just BE
--- Panel costs and is named - instead of taking the entire structure along.
__uiPanels = {
  {
    -- gamemain.lua:142 — the MAIN VIEW. It is a control (CUIWorldView),
    -- no special case: worldview.lua:22 puts it in the mapGroup. Just because of that
    -- The MINIMAP can also be moved in the original - it is the same
    -- Class (minimap.lua:115).
    name = 'worldview',
    build = function()
      import('/lua/ui/game/worldview.lua').CreateMainWorldView(__ui.gameParent, __ui.mapGroup)
    end,
  },
  {
    name = 'economy',
    build = function()
      Economy = import('/lua/ui/game/economy.lua')
      Economy.CreateEconomyBar(__ui.statusCluster)
    end,
  },
  {
    name = 'multifunction',
    build = function()
      __ui.mfd = import('/lua/ui/game/multifunction.lua').Create(__ui.controlCluster)
    end,
  },
  {
    name = 'orders',
    build = function()
      __ui.ordersModule = import('/lua/ui/game/orders.lua')
      __ui.orders = __ui.ordersModule.SetupOrdersControl(__ui.controlCluster, __ui.mfd)
    end,
  },
  {
    name = 'construction',
    build = function()
      __ui.construction = import('/lua/ui/game/construction.lua')
        .SetupConstructionControl(__ui.controlCluster, __ui.mfd, __ui.orders)
    end,
  },
  {
    name = 'unitview',
    build = function()
      import('/lua/ui/game/unitview.lua').SetupUnitViewLayout(__ui.mapGroup, __ui.orders)
    end,
  },
  {
    -- gamemain.lua:154 — the detailed view (rollover tooltip). construction.lua
    -- it calls unchecked (UnitViewDetail.Hide()), so it MUST be there.
    name = 'unitviewDetail',
    build = function()
      import('/lua/ui/game/unitviewDetail.lua').SetupUnitViewLayout(__ui.mapGroup, __ui.mapGroup)
    end,
  },
  -- From here on out the REST of gamemain.lua:146-165, in the original order.
  {
    -- gamemain.lua:146 — the tabs at the top (diplomacy, goals, points…).
    name = 'tabs',
    build = function()
      import('/lua/ui/game/tabs.lua').Create(__ui.mapGroup)
    end,
  },
  {
    -- gamemain.lua:155 — the player avatars (top right).
    name = 'avatars',
    build = function()
      import('/lua/ui/game/avatars.lua').CreateAvatarUI(__ui.mapGroup)
    end,
  },
  {
    -- gamemain.lua:156 — the control group display (Ctrl+1…).
    name = 'controlgroups',
    build = function()
      import('/lua/ui/game/controlgroups.lua').CreateUI(__ui.mapGroup)
    end,
  },
  {
    -- gamemain.lua:157 — the radio protocol (campaign messages).
    name = 'transmissionlog',
    build = function()
      import('/lua/ui/game/transmissionlog.lua').CreateTransmissionLog()
    end,
  },
  {
    -- gamemain.lua:158 — the help texts.
    name = 'helptext',
    build = function()
      import('/lua/ui/game/helptext.lua').CreateHelpText(__ui.mapGroup)
    end,
  },
  {
    -- gamemain.lua:159 — the game time clock.
    name = 'timer',
    build = function()
      import('/lua/ui/game/timer.lua').CreateTimerDialog(__ui.mapGroup)
    end,
  },
  {
    -- gamemain.lua:160 — the console echo.
    name = 'consoleecho',
    build = function()
      import('/lua/ui/game/consoleecho.lua').CreateConsoleEcho(__ui.mapGroup)
    end,
  },
  {
    -- gamemain.lua:161-162 — construction templates and mockeries.
    name = 'templates+taunt',
    build = function()
      import('/lua/ui/game/build_templates.lua').Init()
      import('/lua/ui/game/taunt.lua').Init()
    end,
  },
  {
    -- gamemain.lua:164 — the chat window. Also a `Window` (slidable).
    name = 'chat',
    build = function()
      import('/lua/ui/game/chat.lua').SetupChatLayout(__ui.windowGroup)
    end,
  },
  {
    -- gamemain.lua:165 — THE MINIMAP. It hangs in a `Window`
    -- (lua/maui/window.lua): movable, resizable, with
    -- Minimum size 150x150 (minimap.lua:114). There is a WorldView in it
    -- isMiniMap = true (minimap.lua:115) — kartografisch, Draufsicht.
    --
    -- THAT is EXACTLY why you can move them in the game. Our
    -- TS replica was a nailed down <canvas>; it is deleted.
    name = 'minimap',
    build = function()
      import('/lua/ui/game/minimap.lua').CreateMinimap(__ui.windowGroup)
    end,
  },
}

--- Builds panel no. `i`. Returns nil if successful, otherwise the error message.
function __uiBuildPanel(i)
  local panel = __uiPanels[i]
  if not panel then return 'no panel ' .. tostring(i) end
  local ok, err = pcall(panel.build)
  if ok then return nil end
  return tostring(err)
end

function __uiPanelName(i)
  local panel = __uiPanels[i]
  return panel and panel.name or '?'
end

function __uiPanelCount()
  return #__uiPanels
end

--- From now on there are receivers for selection events (in the original
--- the engine only registers the SelectionListener when the session starts,
--- Cfile:1294170).
function __uiSessionStarted()
  __uiSessionActive = true
end
