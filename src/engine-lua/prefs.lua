-- =====================================================================
-- The engine's preferences serialization.
--
-- The game writes its settings as LUA SOURCE TEXT. Verified in the user's
-- installation (%LOCALAPPDATA%/Gas Powered Games/Supreme Commander
-- Forged Alliance/Game.prefs):
--
--     PreGameData = {
--         CurrentMapDir = '/maps/gaf_coop_theta_civilian_rescue.v0001',
--         IconReplacements = {
--             { Identifier = 'redux strategic icons 1200', ... },
--
-- Therefore this serializes the same way: a Lua table as text. Where the engine
-- writes a file, the browser puts the text in localStorage — the path is the
-- same; only the storage differs.
--
-- Without this, `SavePreferences()` was a no-op (`__uiSavePrefs` was never
-- set): every setting, profile, and option vanished after reloading the page.
--
-- This file is STANDARD LUA 5.4 (it goes raw into host.eval, not through the
-- FA transpiler) — `#t` is the length operator here, not a comment.
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
    -- Functions and userdata do not belong in preferences. Silently swallowing
    -- them would be a stub, so reject the entry with a diagnostic.
    WARN('Prefs: value of type ' .. t .. ' cannot be saved')
    return 'nil'
  end

  local inner = indent .. '    '
  local parts = {}

  -- First the array part (1..n), then named keys — sorted so the same state
  -- produces the same text (otherwise every save looks like a change).
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

--- The complete preferences tree as Lua text (evaluatable with __prefsLoad).
function __prefsSerialize()
  return 'return ' .. serialize(__prefs, '')
end

--- Load the saved text back into __prefs.
function __prefsLoad(text)
  if not text or text == '' then return false end
  local chunk = load(text, 'prefs', 't', {})
  if not chunk then
    WARN('Prefs: saved text is not valid Lua — discarding it')
    return false
  end
  local ok, value = pcall(chunk)
  if not ok or type(value) ~= 'table' then
    WARN('Prefs: saved text does not evaluate to a table — discarding it')
    return false
  end
  __prefs = value
  return true
end
