-- Lua-5.0-Kompatibilität für FA-Skripte

-- Generic-for-Dispatcher (see rewriteForIn): Table -> pairs/next,
-- Iterator-Tripel unveraendert durchreichen.
function __foriter(a, b, c)
  if type(a) == 'table' then
    return next, a, nil
  end
  return a, b, c
end

-- string.format: Lua 5.0 ignored nonsense flags on %s, Lua 5.4 throws
-- "invalid conversion specification". The original Lua uses this:
--   economy.lua:305   string.format("%+s", rateStr)
-- The flags '+', '#' and ' ' make no sense for %s and are removed;
-- '-' (left-aligned) and width specifications remain, they are also valid in 5.4.
do
  local rawformat = string.format
  string.format = function(fmt, ...)
    if type(fmt) == 'string' then
      fmt = string.gsub(fmt, '%%([-+# 0]*[%d%.]*)s', function(flags)
        return '%' .. string.gsub(flags, '[+# ]', '') .. 's'
      end)
    end
    return rawformat(fmt, ...)
  end
end

-- string.gfind was called this in Lua 5.0; from 5.1 the same function is called gmatch.
-- The original UI uses it (text.lua:170 uses it to wrap long texts) — without
-- Every tooltip with "attempt to call a nil value (field 'gfind')" dies.
string.gfind = string.gfind or string.gmatch

table.getn = table.getn or function(t) return #t end
table.setn = table.setn or function() end
table.foreach = table.foreach or function(t, f)
  for k, v in pairs(t) do local r = f(k, v); if r ~= nil then return r end end
end
table.foreachi = table.foreachi or function(t, f)
  for i, v in ipairs(t) do local r = f(i, v); if r ~= nil then return r end end
end
math.mod = math.mod or function(a, b) return a % b end
unpack = unpack or table.unpack
loadstring = loadstring or load
if not setfenv then
  -- 5.4: über Upvalue _ENV (ausreichend für FAs Nutzung)
  function setfenv(fn, env)
    if type(fn) == 'number' then return end
    local i = 1
    while true do
      local name = debug.getupvalue(fn, i)
      if not name then break end
      if name == '_ENV' then debug.upvaluejoin(fn, i, function() return env end, 1); break end
      i = i + 1
    end
    return fn
  end
  function getfenv(fn)
    if type(fn) ~= 'function' then return _G end
    local i = 1
    while true do
      local name, val = debug.getupvalue(fn, i)
      if not name then return _G end
      if name == '_ENV' then return val end
      i = i + 1
    end
  end
end
