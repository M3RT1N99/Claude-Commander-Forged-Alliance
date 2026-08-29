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

-- === Path helpers (Moho::FILE_*, scr_CoreInits => both VMs) ===

-- "base = Dirname(fullPath)" (mHelp Cfile:599...) — Moho::FILE_DirPrefix
-- (Cfile:444657-444750). Normalises '\' to '/', finds the LAST '/'. No slash ->
-- "". If NO '.' follows that slash the whole path is returned (only a trailing
-- slash is trimmed) — Dirname('/mods/foo') == '/mods/foo'; only when a dot
-- follows the last slash is the path cut before the slash, with no trailing
-- slash. mods.lua:228/242 (LoadModInfo) reads env.location = Dirname(filename).
function Dirname(path)
  local s = string.gsub(tostring(path), '\\', '/')
  local slash = string.match(s, '^.*()/')
  if not slash then return '' end
  local dot = string.match(s, '^.*()%.')
  if not dot or dot <= slash then
    if slash == string.len(s) then return string.sub(s, 1, slash - 1) end
    return s
  end
  return string.sub(s, 1, slash - 1)
end

-- "base = Basename(fullPath, stripExtension?)" (mHelp Cfile:503815) —
-- Moho::FILE_Base (Cfile:444986-445066): everything after the last '/' or '\';
-- with stripExtension it also cuts at the LAST '.' of that component. The
-- binding demands EXACTLY 2 args despite the '?' (Cfile:503840). saveload.lua,
-- replay.lua and helptext.lua use it.
function Basename(path, stripExtension)
  local base = string.match(tostring(path), '[^/\\]*$')
  if stripExtension then
    local cut = string.match(base, '^(.*)%.[^.]*$')
    if cut then base = cut end
  end
  return base
end

-- "table STR_GetTokens(string, delimiter)" (Cfile:599203) — the delimiter is a
-- SET of characters, empty tokens are dropped. The result table is 0-BASED:
-- the engine writes SetString(t, i++, tok) starting at i = 0 (Cfile:599300,
-- v5 = 0). maputil.lua:203 / aiattackutilities.lua:1062 pass it straight on, so
-- consumers rely on that shape.
function STR_GetTokens(s, delim)
  s, delim = tostring(s), tostring(delim)
  local out, i = {}, 0
  if delim == '' then
    if s ~= '' then out[0] = s end
    return out
  end
  local set = string.gsub(delim, '(%W)', '%%%1')
  for tok in string.gmatch(s, '[^' .. set .. ']+') do
    out[i] = tok
    i = i + 1
  end
  return out
end

-- "int STR_xtoi(string)" (Cfile:598960) — gpg::STR_Xtoi: reads hex digits from
-- the START and stops at the first non-hex char (no '0x' handling), nil/empty
-- -> 0. keymapper.lua:137 turns the key-name table into key codes with it.
function STR_xtoi(s)
  local r = 0
  for c in string.gmatch(tostring(s or ''), '.') do
    local d = tonumber(c, 16)
    if d == nil then break end
    r = (r * 16 + d) % 4294967296
  end
  return r
end

-- "string STR_itox(int)" (Cfile:599011) — STR_Printf("%X", (int)n): UPPERCASE
-- hex, no prefix, no padding; a fractional value truncates and negatives wrap
-- to two's complement.
function STR_itox(n)
  n = tonumber(n)
  if n == nil then error('STR_itox: integer expected', 2) end
  return string.format('%X', math.floor(n) % 4294967296)
end

-- ── CreatePrefetchSet (scr_CoreInits, also BEIDE VMs) ────────────────────────
--
-- `Prefetcher = CreatePrefetchSet()` steht in `siminit.lua:232` — ohne diese
-- Bindung kommt die echte `/lua/simInit.lua` dort nicht vorbei.
--
-- Registrierung: `func_CreatePrefetchSet_LuaFuncDef` (Cfile:563841-563853),
-- `<global>`, Hilfetext woertlich „create an empty prefetch set", angehaengt an
-- `scr_CoreInits` (Cfile:563845) — deshalb hier in `str.lua`, das `LuaHost`
-- in beide VMs laedt. Erzeugt wird ein `Moho::CPrefetchSet`-Userdata mit der
-- Metatabelle aus `CScrLuaMetatableFactory<CPrefetchSet>` (Cfile:565840-565865).
--
-- Die Metatabelle traegt GENAU ZWEI Methoden, beide ebenfalls `scr_CoreInits`:
--   `Update({d3d_textures=..., batch_textures=..., models=..., anims=...})`
--                                            (Cfile:563891-563897)
--   `Reset()`                                (Cfile:563950-563956)
--
-- Was `Update` bei LEEREN Listen tut, ist nichts — und genau die bekommt es:
-- `DefaultPrefetchSet()` (siminit.lua:234-250) baut
-- `{ models = {}, anims = {}, d3d_textures = {} }`, und alle drei
-- `DiskFindFiles`-Schleifen darin sind AUSKOMMENTIERT (siminit.lua:237-247).
-- `siminit.lua:252` ruft `Prefetcher:Update(DefaultPrefetchSet())`. Auf diese
-- Eingabe ist Nichtstun das Verhalten der Engine, kein Stub.
--
-- Kommt jemals eine NICHT leere Liste, ist das etwas anderes: dann laedt die
-- Engine Assets vor, und das haben wir nicht. Dann wird gewarnt — einmal —
-- statt still zu schlucken.
__prefetchWarned = false

function CreatePrefetchSet()
  local set = { __models = 0, __anims = 0, __textures = 0 }

  function set:Update(spec)
    if type(spec) ~= 'table' then
      error('CPrefetchSet:Update({d3d_textures=..., batch_textures=..., models=..., anims=...})', 2)
    end
    local n = 0
    for _, key in ipairs({ 'models', 'anims', 'd3d_textures', 'batch_textures' }) do
      local list = spec[key]
      if type(list) == 'table' then n = n + #list end
    end
    self.__models = n
    if n > 0 and not __prefetchWarned then
      __prefetchWarned = true
      WARN('CPrefetchSet:Update mit ' .. tostring(n) .. ' Eintraegen: das Vorladen von '
        .. 'Assets gibt es hier nicht. Bei der Standard-Menge (siminit.lua:234-250, '
        .. 'drei LEERE Listen) ist das folgenlos — hier ist sie es nicht.')
    end
  end

  function set:Reset()
    self.__models, self.__anims, self.__textures = 0, 0, 0
  end

  return set
end
