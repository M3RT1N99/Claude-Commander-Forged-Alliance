-- gpg string helpers registered in scr_CoreInits — BOTH VMs
-- (func_STR_Utf8Len_LuaFuncDef / func_STR_Utf8SubString_LuaFuncDef,
-- Cfile:599069-599108 / 599119-599139). Every SetupEditStd edit calls
-- STR_Utf8Len per keystroke (uiutil.lua:392, chat.lua:726); maui text
-- wrapping slices with STR_Utf8SubString (text.lua:78/126-134).
--
-- This file is standard Lua 5.4 (raw host.eval): the utf8 library gives
-- codepoint semantics; on invalid UTF-8 we fall back to byte counting.

-- "int STR_Utf8Len(string) - return the number of characters in a UTF-8
-- string" (mHelp Cfile:599077)
function STR_Utf8Len(s)
  s = tostring(s or '')
  local n = utf8.len(s)
  if n == nil then return string.len(s) end
  return n
end

-- "string STR_Utf8SubString(string, start, count) - return a substring
-- from start to count" (mHelp Cfile:599128) — 1-based CHARACTER start,
-- `count` characters (text.lua:78 slices from 1).
function STR_Utf8SubString(s, start, count)
  s = tostring(s or '')
  start = math.floor(tonumber(start) or 1)
  count = math.floor(tonumber(count) or 0)
  if count <= 0 then return '' end
  local n = utf8.len(s)
  if n == nil then return string.sub(s, start, start + count - 1) end
  if start < 1 then start = 1 end
  if start > n then return '' end
  local last = math.min(start + count - 1, n)
  local i = utf8.offset(s, start)
  local j = utf8.offset(s, last + 1)
  if j then j = j - 1 else j = string.len(s) end
  return string.sub(s, i, j)
end
