-- =====================================================================
-- Was die ENGINE beim Hochfahren der UI tut — in Lua, nicht in TS.
--
-- Diese Datei ist das Gegenstueck zu dem, was in der C++-Engine als fester
-- Ablauf steht: Profil sicherstellen, Optionen anwenden, Front-End starten,
-- Spiel-UI aufspannen. Bisher stand dieser Lua-Code in TS-Template-Literalen
-- (`host.eval(\`…\`)`) — und damit an einer Stelle, an der ihn kein Werkzeug als
-- Lua sieht: keine Syntaxhervorhebung, keine Pruefung, und ein Backtick in einem
-- Kommentar beendet still den TS-String. CLAUDE.md verbietet das ausdruecklich.
-- TS ist nur noch Loader und Bruecke.
--
-- STANDARD-LUA 5.4 (geht roh in host.eval, nicht durch den FA-Transpiler).
-- =====================================================================

--- Ein Benutzerprofil muss existieren.
---
--- prefs.lua:96 greift ungeprueft darauf zu, und main.lua:57-62 baut ohne
--- `profile.current` den Profil-Dialog statt des Menues. Angelegt wird es ueber
--- den Original-Weg: Prefs.CreateProfile (prefs.lua:31) — dieselbe Funktion, die
--- das Spiel benutzt, wenn jemand zum ersten Mal startet; sie setzt
--- `profile.current` selbst (prefs.lua:57).
function __uiEnsureProfile()
  local Prefs = import('/lua/user/prefs.lua')
  if not Prefs.ProfilesExist() then
    Prefs.CreateProfile('Commander')
  end
end

--- Die Optionen anwenden — der Aufruf, den die Engine selbst macht.
---
--- Moho::OPTIONS_Apply() (Cfile:1368338-1368360) ruft
--- `SCR_Import('/lua/options/optionslogic.lua')['Apply']` mit `Call_True_Obj`,
--- also Apply(true). Damit laufen ALLE `set`-Funktionen der 37 Optionen mit
--- startup=true durch (deshalb rufen primary_adapter/vsync/antialiasing dabei
--- KEIN ConExecute — sie sind beim Start schon gesetzt).
---
--- Ohne diesen Aufruf wirkt beim Start keine einzige Option: der gespeicherte
--- Wert steht zwar in den Prefs, aber niemand traegt ihn in die Engine.
function __uiApplyOptions()
  import('/lua/options/optionslogic.lua').Apply(true)
end

--- Das Front-End starten (Splash -> main.lua), wie main() es tut.
---
--- Cfile:1373865: ohne Kommandozeilen-Argumente ruft die Engine
--- Moho::UI_StartSplashScreens().
---
--- `movie.nologo` ist die Original-Preference dafuer, die Logo-Filme zu
--- ueberspringen (splash.lua:22-25: dann sofort EngineStartFrontEndUI()). Wir
--- setzen sie, weil diese Engine keinen SFD-Decoder hat — das ist dieselbe Lage
--- wie `/nomovie` auf der Kommandozeile (Cfile:1143020-1143035).
---
--- Sie ist NOETIG, nicht bequem: laedt ein Film nicht, ruft movie.lua:52
--- `OnStopped()`, und splash.lua behandelt nur `OnFinished` (splash.lua:75) —
--- der Splash bliebe also stehen, bis jemand eine Taste drueckt. Genau so
--- verhaelt sich auch das Original mit /nomovie.
---
--- Der HINTERGRUNDFILM des Menues braucht dagegen KEINEN Sonderfall mehr:
--- `mainmenu_bgmovie` bleibt die echte Option (Default true), main.lua:151 baut
--- sein Movie, InternalSet liefert ehrlich false, und das Menue steht ohne Film.
function __uiStartFrontEnd()
  SetPreference('movie.nologo', true)
  EngineStartSplashScreens()
end

--- SetupUI() aus dem Original-uimain.lua — der Einstiegspunkt, den die Engine
--- selbst ruft (Cfile:1262333: SCR_Import('/lua/ui/uimain.lua')['SetupUI']()).
function __uiSetupUi()
  import('/lua/ui/uimain.lua').SetupUI()
end

-- =====================================================================
-- Die Spiel-UI (gamemain.lua:145-154)
-- =====================================================================

--- Der Bildschirm-Baum, exakt wie gamemain.lua ihn aufspannt: EINE Screen-Group,
--- darin die vier Cluster von borders.lua. Alle Panels haengen an diesen Gruppen
--- — wer sie stattdessen an GetFrame(0) haengt, bekommt jedes Panel an die
--- falsche Stelle (die Layout-Dateien rechnen gegen den Cluster, nicht gegen den
--- Bildschirm).
---
--- Die Handles leben in der Tabelle `__ui`, nicht in Globals: `x = nil` legt
--- unter dem strengen _G (config.lua:51-56) keinen Schluessel an, und der
--- spaetere Lesezugriff wirft "access to nonexistent global variable".
function __uiCreateScreenTree()
  __ui = {}
  UIUtil = import('/lua/ui/uiutil.lua')
  __ui.gameParent = UIUtil.CreateScreenGroup(GetFrame(0), 'GameMain ScreenGroup')
  __ui.controlCluster, __ui.statusCluster, __ui.mapGroup, __ui.windowGroup =
    import('/lua/ui/game/borders.lua').SetupBorderControl(__ui.gameParent)
end

--- Die Panels der Spiel-UI, in der Reihenfolge aus gamemain.lua:145-154.
--- Jedes Panel wird EINZELN gebaut, damit ein fehlendes Engine-Teil nur SEIN
--- Panel kostet und benannt wird — statt den ganzen Aufbau mitzureissen.
__uiPanels = {
  {
    -- gamemain.lua:142 — die HAUPTANSICHT. Sie ist ein Control (CUIWorldView),
    -- kein Sonderfall: worldview.lua:22 haengt sie in die mapGroup. Nur deshalb
    -- laesst sich im Original auch die MINIMAP verschieben — sie ist dieselbe
    -- Klasse (minimap.lua:115).
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
    -- gamemain.lua:154 — die Detailansicht (Rollover-Tooltip). construction.lua
    -- ruft sie ungeprueft (UnitViewDetail.Hide()), also MUSS sie stehen.
    name = 'unitviewDetail',
    build = function()
      import('/lua/ui/game/unitviewDetail.lua').SetupUnitViewLayout(__ui.mapGroup, __ui.mapGroup)
    end,
  },
}

--- Baut Panel Nr. `i`. Liefert nil bei Erfolg, sonst die Fehlermeldung.
function __uiBuildPanel(i)
  local panel = __uiPanels[i]
  if not panel then return 'kein Panel ' .. tostring(i) end
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

--- Ab jetzt gibt es Empfaenger fuer Selektions-Ereignisse (im Original
--- registriert die Engine den SelectionListener erst beim Session-Start,
--- Cfile:1294170).
function __uiSessionStarted()
  __uiSessionActive = true
end
