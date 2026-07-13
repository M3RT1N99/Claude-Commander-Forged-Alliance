__diskwatch = {}
-- Sprache der Installation. Die Original-Init-Skripte setzen sie genau so
-- (viewerinit.lua:5, editorinit.lua:5: `__language = 'us'`); Localization.lua:150
-- liest sie beim Laden.
__language = 'us'
-- false, nicht nil: `x = nil` legt den Schluessel gar nicht an, und config.lua:56
-- macht den Zugriff auf ein nicht existierendes Global zum Fehler.
__currentSource = false

-- =====================================================================
-- LuaPlus-Dialekt: nil, Zahlen und Strings HABEN Metatables.
--
-- FAs eigenes config.lua sagt es in seinem Kommentar (config.lua:6):
--   "Disable the LuaPlus bit where you can add attributes to nil, numbers,
--    and strings."
-- Es schaltet dort aber nur das SCHREIBEN ab (__newindex) — der __index-Teil
-- ist auskommentiert (config.lua:14-16). In FA liefert `nil.foo` also `nil`,
-- statt zu knallen, und die Original-Lua verlaesst sich darauf. Beispiel:
--
--   uiutil.lua:343  skins[currentSkin()].cursors or skins['default'].cursors
--
-- Beim ersten SetupUI() ist der Skin noch ungesetzt (lazyvar.lua:110: ein
-- ungesetzter LazyVar ist 0), skins[0] ist nil — und die Zeile funktioniert
-- trotzdem, weil das `.cursors` auf nil eben nil ergibt und das `or` greift.
--
-- Standard-Lua 5.4 kennt diese Metatables nicht; `debug.setmetatable` kann sie
-- setzen. Ohne das laeuft kein einziges Original-UI-Skript.
-- (Strings haben in 5.4 bereits eine Metatable — die bleibt unangetastet.)
-- =====================================================================
do
  local readsNil = { __index = function() return nil end }
  debug.setmetatable(nil, readsNil)
  debug.setmetatable(0, readsNil)
  debug.setmetatable(true, readsNil)

  -- Coroutines brauchen ebenfalls eine Metatable, denn config.lua:35 haengt
  -- ihre eigene daran:  local thread_mt = { Destroy = KillThread }
  -- Genau das ist das Thread-Objekt mit :Destroy(), das die Original-Lua in den
  -- TrashBag legt — die Engine liefert die Coroutine, config.lua die Methode.
  -- In Lua 5.4 hat ein Thread keine Metatable; getmetatable() gaebe nil und
  -- config.lua:35 stuerbe an setmetatable(nil, ...).
  debug.setmetatable(coroutine.create(function() end), {})
end

-- Engine-Hook: Modul in gegebener Umgebung ausfuehren (import.lua ruft das).
-- Verfolgt zusaetzlich das aktuell geladene File fuer GetSource() (die
-- Blueprint-Pipeline leitet daraus die BlueprintId ab).
function doscript(name, env)
    local fsPath = __mountModule(name)
    if not fsPath then error("module not found: " .. tostring(name), 2) end
    -- Ohne env laeuft das Modul im globalen Environment (Blueprints/Boot).
    -- Explizites nil als 4. load-Argument wuerde _ENV auf nil setzen.
    local chunk, err = loadfile(fsPath, "t", env or _G)
    if not chunk then error(err, 2) end
    local prev = __currentSource
    __currentSource = name
    local r = chunk()
    __currentSource = prev
    return r
end

-- Engine-Funktion: Pfad des gerade per doscript geladenen Files
function GetSource()
    return __currentSource
end

-- Boot-Skripte im globalen _ENV ausfuehren; gibt Fehlermeldung oder nil
function __runGlobal(fsPath)
    local chunk, err = loadfile(fsPath, "t")
    if not chunk then return err end
    local ok, e = pcall(chunk)
    if not ok then return e end
    return nil
end
