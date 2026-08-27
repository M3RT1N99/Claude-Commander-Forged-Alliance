-- Lua 5.0 compatibility for FA scripts.

-- Generic-for dispatcher (see rewriteForIn): table -> pairs/next,
-- pass iterator triples through unchanged.
--
-- NIL is a THIRD case: FA's LuaPlus 5.0 tolerates `for k,v in nil do` as a
-- zero-iteration loop (the same nil-tolerance config.lua grants nil reads), and
-- the shipped UI relies on it — e.g. construction.lua:889
-- `for index, unitStack in currentCommandQueue do`, where currentCommandQueue is
-- legitimately nil for a unit with no build queue (SetCurrentFactoryForQueueDisplay
-- returns nil, AssignNil @Cfile:1257091). Standard Lua 5.4 would raise "attempt
-- to call a nil value (for iterator)" and take the whole click handler down with
-- it. Returning an empty iterator makes the loop a no-op, exactly as in FA.
function __foriter(a, b, c)
  if a == nil then
    return function() return nil end
  end
  if type(a) == 'table' then
    return next, a, nil
  end
  return a, b, c
end

-- string.format — two differences between Lua 5.0 (FA) and 5.4 (here):
--
--  1. 5.0 ignored nonsensical flags on %s, 5.4 throws "invalid conversion
--     specification". The original relies on that: economy.lua:305
--     `string.format("%+s", rateStr)`. '+', '#' and ' ' are dropped; '-' (left
--     aligned) and width specifications stay — 5.4 accepts those too.
--
--  2. 5.0 handed %d to C, which truncated the number; 5.4 THROWS on a
--     fractional value: "bad argument #n to 'format' (number has no integer
--     representation)". The original computes in floating point everywhere and
--     still formats with %d: unitview.lua:269 `string.format("%d / %d",
--     info.health, info.maxHealth)` — and health is rarely integral. Without
--     this truncation the rollover panel dies for EVERY damaged unit.
--     Truncation is toward zero, as in C — not floor.
do
  local rawformat = string.format
  local unpack = table.unpack or unpack
  local function trunc(x)
    if x >= 0 then return math.floor(x) end
    return math.ceil(x)
  end
  string.format = function(fmt, ...)
    if type(fmt) ~= 'string' then return rawformat(fmt, ...) end
    local n = select('#', ...)
    local args = { ... }
    local argi = 0
    fmt = string.gsub(fmt, '%%[-+# 0]*%d*%.?%d*[%a%%]', function(spec)
      local conv = string.sub(spec, -1)
      if conv == '%' then return spec end
      argi = argi + 1
      if string.find(conv, '^[diouxXc]$') then
        local v = args[argi]
        if type(v) == 'number' then args[argi] = trunc(v) end
      elseif conv == 's' then
        return '%' .. string.gsub(string.sub(spec, 2, -2), '[+# ]', '') .. 's'
      end
      return spec
    end)
    return rawformat(fmt, unpack(args, 1, n))
  end
end

-- string.gfind was its Lua 5.0 name; since 5.1 the same function is gmatch.
-- The original UI uses it (text.lua:170 wraps long text with it); without it,
-- every tooltip dies with "attempt to call a nil value (field 'gfind')".
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
-- math.pow was a real function in FA's Lua 5.0.1; 5.4 dropped it in favour of
-- the `^` operator. The original Lua still calls it in two places, and the first
-- one is not obscure:
--
--   lua/utilities.lua:50   GetVectorLength — math.sqrt(pow(x,2)+pow(y,2)+pow(z,2))
--   lua/platoon.lua:983    local dir = math.pow(-1, Random(1,2))
--
-- Without the shim GetVectorLength raises "attempt to call a nil value (field
-- 'pow')". Since it is almost always reached from a ForkThread, the error is
-- only LOGGED and the thread dies silently — the caller just never gets a
-- result. Found by the golden master: reintroducing the shield regression sent
-- the damage effects down a path that calls it, and the run reported
-- "ForkThread-Fehler: /mod/lua/utilities.lua:50".
math.pow = math.pow or function(a, b) return a ^ b end
unpack = unpack or table.unpack
loadstring = loadstring or load
if not setfenv then
  -- 5.4: via the _ENV upvalue (sufficient for FA's use).
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
