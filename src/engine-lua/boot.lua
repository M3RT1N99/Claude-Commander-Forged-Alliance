__diskwatch = {}
-- Installation language. The original init scripts set them exactly like this
-- (viewerinit.lua:5, editorinit.lua:5: `__language = 'us'`); Localization.lua:150
-- she reads while loading.
__language = 'us'
-- false, not nil: `x = nil` does not create the key at all, and config.lua:56
-- makes accessing a non-existent global an error.
__currentSource = false

-- DiskToLocal(path): a path from the HOST file system back to the VFS path of the
-- game. The LuaHost mounts each VFS file under `/mod/<path>`
-- (src/lua/host.ts: FS_PREFIX) — exactly this prefix has to be removed here.
--
-- This is not a cosmetic: `lua/system/Blueprints.lua:70-83` has one of its OWN
-- GetSource() which takes the chunk name from `debug.getinfo(n).source` and puts it
-- through DiskToLocal. SetBackwardsCompatId turns this into the BlueprintId
-- (`bp.BlueprintId = lower(bp.Source)`, lines 104-107) — and a projectile is called
-- so `/projectiles/tdfgauss01/tdfgauss01_proj.bp`, EXACTLY the string that is in
-- `Weapon.ProjectileId` is written. With `/mod` in front of it, CreateProjectile finds it
-- Blueprint never ("Invalid blueprint") and no weapon fires.
-- Units never noticed this: SetShortId cuts down to the file name anyway.
__fsPrefix = '/mod'

function DiskToLocal(path)
  local p = tostring(path)
  if string.sub(p, 1, string.len(__fsPrefix)) == __fsPrefix then
    return string.sub(p, string.len(__fsPrefix) + 1)
  end
  return p
end

-- =====================================================================
-- LuaPlus dialect: nil, numbers and strings HAVE metatables.
--
-- FAs eigenes config.lua sagt es in seinem Kommentar (config.lua:6):
--   "Disable the LuaPlus bit where you can add attributes to nil, numbers,
--    and strings."
-- But it only switches off WRITE there (__newindex) — the __index part
-- is commented out (config.lua:14-16). So in FA `nil.foo` returns `nil`,
-- instead of banging, and the original Lua relies on that. Example:
--
--   uiutil.lua:343  skins[currentSkin()].cursors or skins['default'].cursors
--
-- During the first SetupUI() the skin is still unset (lazyvar.lua:110: on
-- unset LazyVar is 0), skins[0] is nil — and the line works
-- anyway, because the `.cursors` on nil results in nil and the `or` takes effect.
--
-- Standard Lua 5.4 does not recognize these metatables; `debug.setmetatable` can
-- set. Without this, not a single original UI script will run.
-- (Strings already have a metatable in 5.4 - this remains untouched.)
-- =====================================================================
do
  local readsNil = { __index = function() return nil end }
  debug.setmetatable(nil, readsNil)
  debug.setmetatable(0, readsNil)

  -- BOOLEANS may CARRY attributes - reading AND writing.
  --
  -- config.lua:21-23 clears the LuaPlus attributes only for nil, numbers and
  -- Strings ab (`metacleanup(nil) / metacleanup(0) / metacleanup('')`).
  -- Booleans are NOT there — and the original UI takes advantage of that:
  --
  --   commandmode.lua:113  function EndCommandMode(isCancel)
  --   commandmode.lua:114      modeData.isCancel = isCancel or false
  --
  -- `modeData` is `false` as long as no command mode is running (commandmode.lua:75).
  -- So in FA, this line writes the attribute to a BOOLEAN — and reads it
  -- again five lines later (l. 119). Without this metatable, everyone dies
  -- Command that is issued without an active command mode (a normal right-click
  -- Move!) mit "attempt to index a boolean value (upvalue 'modeData')".
  --
  -- LuaPlus keeps the attributes per TYPE (one metatable per type), not per value —
  -- therefore a common table is the correct image.
  local boolAttrs = {}
  debug.setmetatable(true, {
    __index = boolAttrs,
    __newindex = function(_, k, v) boolAttrs[k] = v end,
  })

  -- FUNCTIONS can also carry attributes — the same LuaPlus property.
  -- multifunction.lua:979 attaches a field to a function:
  --
  --     bg.MouseClickFunc.OnDestroy = function(self) ... end
  --
  -- In standard Lua this is "attempt to index a function value". Without this
  -- Metatable dies right there the strategic view menu (the flap
  -- the multifunction display).
  local funcAttrs = {}
  debug.setmetatable(function() end, {
    __index = funcAttrs,
    __newindex = function(_, k, v) funcAttrs[k] = v end,
  })

  -- Coroutines also need a metatable because config.lua:35 hangs
  -- ihre eigene daran:  local thread_mt = { Destroy = KillThread }
  -- This is exactly the thread object with :Destroy() that the original Lua in the
  -- TrashBag sets — the engine provides the coroutine, config.lua the method.
  -- In Lua 5.4, a thread does not have a metatable; getmetatable() would give nil and
  -- config.lua:35 stuerbe an setmetatable(nil, ...).
  debug.setmetatable(coroutine.create(function() end), {})

  -- ---------------------------------------------------------------------
  -- COMPARISONS ABOUT TYPE LIMITATIONS DO NOT MATTER IN FA.
  --
  -- The engine has patched luaV_lessthan (Cfile:1442257):
  --
  --     if ( l->tt != r->tt )
  --         return l_tt < r->tt;      // <-- the TYPE TAGS, no error!
  --     if ( l_tt == LUA_TNUMBER ) ...
  --
  -- and luaV_lessequal the same (Cfile:1442275). Standard Lua throws here
  -- "attempt to compare number with nil" — FA silently returns the result of the
  -- Tag-Vergleichs (nil=0, boolean=1, lightuserdata=2, number=3, string=4,
  -- table=5, function=6, userdata=7, thread=8).
  --
  -- This is not a curiosity, the original UI COUNTS on it:
  --
  --   diplomacy.lua:24 parent.Items = {} -- Attribute on `false`
  --   diplomacy.lua:107 parent = Group(inParent) -- now a control...
  --   diplomacy.lua:123  if table.getsize(parent.Items) > 0 then
  --
  -- `parent.Items` is nil on the fresh control, table.getsize(nil) returns
  -- nil (utils.lua:279), and `nil > 0` is simply false in FA — the line
  -- skips the cleanup block. In standard Lua, the diplomacy rider dies
  -- right there.
  --
  -- With the SAME types, everything stays as usual: Lua compares numbers/strings
  -- itself (the meta method is then not called at all), and nil<nil or
  -- Table<table without __lt goes into call_orderTM — there is a bang, as in
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

  -- Lua 5.4 looks for the meta method at the FIRST operand and, if it doesn't have one,
  -- at the SECOND. So it's enough to hang them on the types, the one
  -- Have type metatable — every mixed comparison has at least one of these.
  for _, mt in ipairs({
    debug.getmetatable(nil), debug.getmetatable(0), debug.getmetatable(''),
    debug.getmetatable(true), debug.getmetatable(function() end),
  }) do
    mt.__lt = faOrder
    mt.__le = faOrder
  end
end

-- Engine hook: Execute module in given environment (import.lua calls this).
-- Additionally tracks the currently loaded file for GetSource() (the
-- Blueprint pipeline derives the BlueprintId from this).
-- HOOKS — the mechanism by which FA subsequently patches its own modules.
--
-- bin/SupComDataPath.lua sagt:
--
--     hook = { '/schook' }
--
-- The engine then loads the file of the same name for EACH module
-- the hook directory — IN THE SAME environment, right after the original.
-- The hook sees everything that the module has just created and can do it
-- supplement or replace.
--
-- This is not a cure, but necessary: ​​`lua/maui/window.lua` just puts an empty one
-- `styles = {}` (line 71) and explicitly says "you MUST
-- hook in a styles table in your product". That's exactly what it does
-- `schook/lua/maui/window.lua` — it fills styles.backgrounds with the frames of the
-- Minimap. Without hooks, window.lua:160 dies to `styles.backgrounds` (nil), and
-- thus the MINIMAP, the chat window and the console.
--
-- The sim also depends on it: schook/lua/simInit.lua, SessionInit.lua,
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

-- exists(path): is the file in the VFS? A CORE binding (scr_CoreInits, i.e
-- both VMs, docs/research/engine-api.md). The sim needs them to
-- Script class of a blueprint to resolve: exists
-- `<id>_script.lua` does not apply, the default from the blueprint type applies
-- (func_FindBlueprintScriptModule, Cfile:914189-914360).
function exists(name)
  return __mountModule(name) ~= false
end

function doscript(name, env)
    local fsPath = __mountModule(name)
    if not fsPath then error("module not found: " .. tostring(name), 2) end
    -- Without env, the module runs in the global environment (Blueprints/Boot).
    -- Explicit nil as 4th load argument would set _ENV to nil.
    local chunk, err = loadfile(fsPath, "t", env or _G)
    if not chunk then error(err, 2) end
    local prev = __currentSource
    __currentSource = name
    local r = chunk()
    __currentSource = prev
    runHooks(name, env)
    return r
end

-- Engine function: Path of the file just loaded via doscript
function GetSource()
    return __currentSource
end

-- Run boot scripts in global _ENV; gives error message or nil
function __runGlobal(fsPath)
    local chunk, err = loadfile(fsPath, "t")
    if not chunk then return err end
    local ok, e = pcall(chunk)
    if not ok then return e end
    return nil
end
