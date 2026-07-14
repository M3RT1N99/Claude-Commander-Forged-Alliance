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

  -- BOOLEANS duerfen Attribute TRAGEN — Lesen UND Schreiben.
  --
  -- config.lua:21-23 raeumt die LuaPlus-Attribute nur fuer nil, Zahlen und
  -- Strings ab (`metacleanup(nil) / metacleanup(0) / metacleanup('')`).
  -- Booleans stehen dort NICHT — und die Original-UI nutzt das aus:
  --
  --   commandmode.lua:113  function EndCommandMode(isCancel)
  --   commandmode.lua:114      modeData.isCancel = isCancel or false
  --
  -- `modeData` ist `false`, solange kein Command-Mode laeuft (commandmode.lua:75).
  -- In FA schreibt diese Zeile das Attribut also auf einen BOOLEAN — und liest es
  -- fuenf Zeilen spaeter wieder (Z. 119). Ohne diese Metatable stirbt jeder
  -- Befehl, der ohne aktiven Command-Mode erteilt wird (ein normaler Rechtsklick-
  -- Move!) mit "attempt to index a boolean value (upvalue 'modeData')".
  --
  -- LuaPlus haelt die Attribute pro TYP (eine Metatable je Typ), nicht pro Wert —
  -- deshalb ist eine gemeinsame Tabelle das richtige Abbild.
  local boolAttrs = {}
  debug.setmetatable(true, {
    __index = boolAttrs,
    __newindex = function(_, k, v) boolAttrs[k] = v end,
  })

  -- FUNKTIONEN koennen ebenfalls Attribute tragen — dieselbe LuaPlus-Eigenschaft.
  -- multifunction.lua:979 haengt ein Feld an eine Funktion:
  --
  --     bg.MouseClickFunc.OnDestroy = function(self) ... end
  --
  -- In Standard-Lua ist das "attempt to index a function value". Ohne diese
  -- Metatable stirbt genau dort das strategische Ansichts-Menue (der Aufklapper
  -- der Multifunktionsanzeige).
  local funcAttrs = {}
  debug.setmetatable(function() end, {
    __index = funcAttrs,
    __newindex = function(_, k, v) funcAttrs[k] = v end,
  })

  -- Coroutines brauchen ebenfalls eine Metatable, denn config.lua:35 haengt
  -- ihre eigene daran:  local thread_mt = { Destroy = KillThread }
  -- Genau das ist das Thread-Objekt mit :Destroy(), das die Original-Lua in den
  -- TrashBag legt — die Engine liefert die Coroutine, config.lua die Methode.
  -- In Lua 5.4 hat ein Thread keine Metatable; getmetatable() gaebe nil und
  -- config.lua:35 stuerbe an setmetatable(nil, ...).
  debug.setmetatable(coroutine.create(function() end), {})

  -- ---------------------------------------------------------------------
  -- VERGLEICHE UEBER TYPGRENZEN KNALLEN IN FA NICHT.
  --
  -- Die Engine hat luaV_lessthan gepatcht (Cfile:1442257):
  --
  --     if ( l->tt != r->tt )
  --         return l_tt < r->tt;      // <-- die TYP-TAGS, kein Fehler!
  --     if ( l_tt == LUA_TNUMBER ) ...
  --
  -- und luaV_lessequal genauso (Cfile:1442275). Standard-Lua wirft hier
  -- "attempt to compare number with nil" — FA liefert still das Ergebnis des
  -- Tag-Vergleichs (nil=0, boolean=1, lightuserdata=2, number=3, string=4,
  -- table=5, function=6, userdata=7, thread=8).
  --
  -- Das ist kein Kuriosum, die Original-UI RECHNET damit:
  --
  --   diplomacy.lua:24   parent.Items = {}        -- Attribut auf `false`
  --   diplomacy.lua:107  parent = Group(inParent) -- jetzt ein Control ...
  --   diplomacy.lua:123  if table.getsize(parent.Items) > 0 then
  --
  -- `parent.Items` ist auf dem frischen Control nil, table.getsize(nil) liefert
  -- nil (utils.lua:279), und `nil > 0` ist in FA schlicht false — die Zeile
  -- ueberspringt den Aufraeum-Block. In Standard-Lua stirbt der Diplomatie-Reiter
  -- genau dort.
  --
  -- Bei GLEICHEN Typen bleibt alles wie gehabt: Zahlen/Strings vergleicht Lua
  -- selbst (die Metamethode wird dann gar nicht gerufen), und nil<nil oder
  -- Tabelle<Tabelle ohne __lt geht in call_orderTM — dort knallt es, wie im
  -- Original.
  local TYPE_TAG = {
    ['nil'] = 0, boolean = 1, number = 3, string = 4,
    table = 5, ['function'] = 6, userdata = 7, thread = 8,
  }
  local function faOrder(a, b)
    local ta, tb = TYPE_TAG[type(a)] or 9, TYPE_TAG[type(b)] or 9
    if ta ~= tb then return ta < tb end
    error('attempt to compare two ' .. type(a) .. ' values', 3)
  end

  -- Lua 5.4 sucht die Metamethode beim ERSTEN Operanden und, wenn er keine hat,
  -- beim ZWEITEN. Es reicht also, sie an die Typen zu haengen, die eine
  -- Typ-Metatable haben — jeder gemischte Vergleich hat mindestens einen davon.
  for _, mt in ipairs({
    debug.getmetatable(nil), debug.getmetatable(0), debug.getmetatable(''),
    debug.getmetatable(true), debug.getmetatable(function() end),
  }) do
    mt.__lt = faOrder
    mt.__le = faOrder
  end
end

-- Engine-Hook: Modul in gegebener Umgebung ausfuehren (import.lua ruft das).
-- Verfolgt zusaetzlich das aktuell geladene File fuer GetSource() (die
-- Blueprint-Pipeline leitet daraus die BlueprintId ab).
-- HOOKS — der Mechanismus, mit dem FA seine eigenen Module nachtraeglich patcht.
--
-- bin/SupComDataPath.lua sagt:
--
--     hook = { '/schook' }
--
-- Die Engine laedt danach zu JEDEM Modul zusaetzlich die gleichnamige Datei aus
-- dem Hook-Verzeichnis — IN DERSELBEN Umgebung, direkt nach dem Original.
-- Der Hook sieht also alles, was das Modul gerade angelegt hat, und kann es
-- ergaenzen oder ersetzen.
--
-- Das ist keine Kuer, sondern noetig: `lua/maui/window.lua` legt nur ein leeres
-- `styles = {}` an (Zeile 71) und sagt im Kopfkommentar ausdruecklich "you MUST
-- hook in a styles table in your product". Genau das tut
-- `schook/lua/maui/window.lua` — es fuellt styles.backgrounds mit den Rahmen der
-- Minimap. Ohne Hooks stirbt window.lua:160 an `styles.backgrounds` (nil), und
-- damit die MINIMAP, das Chat-Fenster und die Konsole.
--
-- Auch die Sim haengt daran: schook/lua/simInit.lua, SessionInit.lua,
-- sim/weapon.lua, SimSync.lua, UserSync.lua.
__hookPaths = { '/schook' }

local function runHooks(name, env)
    for _, hookDir in ipairs(__hookPaths) do
        local hookName = hookDir .. name
        local hookPath = __mountModule(hookName)
        if hookPath then
            local chunk, err = loadfile(hookPath, 't', env or _G)
            if not chunk then
                WARN('Hook ' .. hookName .. ': ' .. tostring(err))
            else
                local prev = __currentSource
                __currentSource = hookName
                local ok, msg = pcall(chunk)
                __currentSource = prev
                if not ok then
                    WARN('Hook ' .. hookName .. ': ' .. tostring(msg))
                end
            end
        end
    end
end

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
    runHooks(name, env)
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
