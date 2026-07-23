-- =====================================================================
-- The engine's Prefs serialization.
--
-- The game writes its settings as LUA SOURCE TEXT. Looked in the
-- User installation (%LOCALAPPDATA%/Gas Powered Games/Supreme Commander
-- Forged Alliance/Game.prefs):
--
--     PreGameData = {
--         CurrentMapDir = '/maps/gaf_coop_theta_civilian_rescue.v0001',
--         IconReplacements = {
--             { Identifier = 'redux strategic icons 1200', ... },
--
-- So the serialization is the same here: a Lua table as text. Where the engine
-- writes the file, the browser places the text in the localStorage — the path
-- is the same, only the storage is different.
--
-- Without that, `SavePreferences()` was a null call (`__uiSavePrefs` was never
-- set): every setting, every profile and every option was according to the
-- Reload the page away.
--
-- This file is STANDARD LUA 5.4 (it goes raw into host.eval, not through the
-- FA transpiler) — `#t` is the length operator here, no comment.
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
    -- Functions and user data have no place in the prefs. She shut up
    -- swallowed would be a stub - so the entry is thrown out with an announcement.
    WARN('Prefs: Wert vom Typ ' .. t .. ' laesst sich nicht speichern')
    return 'nil'
  end

  local inner = indent .. '    '
  local parts = {}

  -- First the array part (1..n), then the named keys — sorted, so
  -- the same state results in the same text (otherwise everyone sees the save operation
  -- after a change).
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

--- The complete Prefs tree as Lua text (evaluable with __prefsLoad).
function __prefsSerialize()
  return 'return ' .. serialize(__prefs, '')
end

--- Get the saved text back into __prefs.
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
