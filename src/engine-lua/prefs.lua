-- =====================================================================
-- Die Prefs-Serialisierung der Engine.
--
-- Das Spiel schreibt seine Einstellungen als LUA-QUELLTEXT. Nachgesehen in der
-- Installation des Nutzers (%LOCALAPPDATA%/Gas Powered Games/Supreme Commander
-- Forged Alliance/Game.prefs):
--
--     PreGameData = {
--         CurrentMapDir = '/maps/gaf_coop_theta_civilian_rescue.v0001',
--         IconReplacements = {
--             { Identifier = 'redux strategic icons 1200', ... },
--
-- Also wird hier genauso serialisiert: eine Lua-Tabelle als Text. Wo die Engine
-- die Datei schreibt, legt der Browser den Text in den localStorage — der Weg
-- ist derselbe, nur die Ablage ist anders.
--
-- Ohne das war `SavePreferences()` ein Nullaufruf (`__uiSavePrefs` wurde nie
-- gesetzt): jede Einstellung, jedes Profil und jede Option war nach dem
-- Neuladen der Seite weg.
--
-- Diese Datei ist STANDARD-LUA 5.4 (sie geht roh in host.eval, nicht durch den
-- FA-Transpiler) — `#t` ist hier der Laengenoperator, kein Kommentar.
-- =====================================================================

local function isIdent(k)
  return type(k) == 'string' and string.match(k, '^[%a_][%w_]*$') ~= nil
end

local function serialize(value, indent)
  local t = type(value)
  if t == 'number' or t == 'boolean' then
    return tostring(value)
  end
  if t == 'string' then
    return string.format('%q', value)
  end
  if t ~= 'table' then
    -- Funktionen und Userdata haben in den Prefs nichts verloren. Sie still zu
    -- verschlucken waere ein Stub — also fliegt der Eintrag mit Ansage raus.
    WARN('Prefs: Wert vom Typ ' .. t .. ' laesst sich nicht speichern')
    return 'nil'
  end

  local inner = indent .. '    '
  local parts = {}

  -- Erst der Array-Teil (1..n), dann die benannten Schluessel — sortiert, damit
  -- derselbe Zustand denselben Text ergibt (sonst sieht jeder Speichervorgang
  -- nach einer Aenderung aus).
  local n = 0
  for i, item in ipairs(value) do
    n = i
    parts[#parts + 1] = inner .. serialize(item, inner)
  end

  local keys = {}
  for k in pairs(value) do
    local isArrayIndex = type(k) == 'number' and k >= 1 and k <= n and math.floor(k) == k
    if not isArrayIndex then
      keys[#keys + 1] = k
    end
  end
  table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)

  for _, k in ipairs(keys) do
    local name = isIdent(k) and k or ('[' .. serialize(k, inner) .. ']')
    parts[#parts + 1] = inner .. name .. ' = ' .. serialize(value[k], inner)
  end

  if #parts == 0 then return '{}' end
  return '{\n' .. table.concat(parts, ',\n') .. '\n' .. indent .. '}'
end

--- Der komplette Prefs-Baum als Lua-Text (auswertbar mit __prefsLoad).
function __prefsSerialize()
  return 'return ' .. serialize(__prefs, '')
end

--- Den gespeicherten Text zurueck in __prefs holen.
function __prefsLoad(text)
  if not text or text == '' then return false end
  local chunk = load(text, 'prefs', 't', {})
  if not chunk then
    WARN('Prefs: gespeicherter Text ist kein gueltiges Lua — wird verworfen')
    return false
  end
  local ok, value = pcall(chunk)
  if not ok or type(value) ~= 'table' then
    WARN('Prefs: gespeicherter Text ergibt keine Tabelle — wird verworfen')
    return false
  end
  __prefs = value
  return true
end
