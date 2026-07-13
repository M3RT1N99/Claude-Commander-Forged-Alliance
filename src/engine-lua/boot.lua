__diskwatch = {}
__currentSource = nil

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
