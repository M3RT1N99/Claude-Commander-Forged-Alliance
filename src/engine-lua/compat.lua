-- Lua-5.0-Kompatibilität für FA-Skripte

-- Generic-for-Dispatcher (siehe rewriteForIn): Tabelle -> pairs/next,
-- Iterator-Tripel unveraendert durchreichen.
function __foriter(a, b, c)
  if type(a) == 'table' then
    return next, a, nil
  end
  return a, b, c
end

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
