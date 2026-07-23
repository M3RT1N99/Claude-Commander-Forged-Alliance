-- =====================================================================
-- maui — the C++ substrate under the original UI Lua.
--
-- The UI itself (lua/maui/*.lua, lua/ui/**) is EXECUTED, not recreated.
-- The engine only delivers three things:
--
--   1. The LazyVar instances of each control.
--      CMauiControl::CMauiControl (@0x7867B0, Cfile:1123966-1123972) erzeugt
--      seven CScriptLazyVar_float and publishes them to the Lua table:
--        Left, Right, Top, Bottom, Width, Height, Depth
--      A bitmap also gets BitmapWidth/BitmapHeight (Cfile:1118538),
--      set from the texture masses (Cfile:1118647) — therefore dimensioned
--      Bitmap per Default nach seiner DDS (bitmap.lua:69-70).
--
--   2. The InternalCreate* globals (scr_UserInits):
--        InternalCreateFrame  (Cfile:1136866)
--        InternalCreateGroup  (Cfile:1137468)
--        InternalCreateBitmap (Cfile:1119519)
--        InternalCreateText   (Cfile:1146210)
--      The pattern is the same everywhere: Lua creates the table, C++ hangs on as a peer
--      turn, and at the end DoInit calls. CMauiControl::DoInit (@0x786E90,
--      Cfile:1124190) is nothing other than RunScript(this, "OnInit") — first
--      This causes Control.OnInit (control.lua:42) to run and build the circular
--      Layout chain.
--
--   3. The methods of the base classes (moho.control_methods etc., see moho.lua).
--
-- LazyVar itself is NOT recreated: /lua/lazyvar.lua is original Lua and
-- is imported.
-- =====================================================================

__mauiControls = {}
__nextMauiId = 1
__mauiDirty = false
__mauiBroken = {}
__uiTextureDims = false
__uiStringAdvance = false
__uiFontMetrics = false

-- GetTextureDimensions(filename) -> width, height  (UI-Global, scr_UserInits).
-- bitmap.lua nutzt es indirekt: SetNewTexture fuellt daraus BitmapWidth/Height,
-- and a bitmap without a layout helper is sized exactly accordingly.
function GetTextureDimensions(filename)
  if not __uiTextureDims then
    error('GetTextureDimensions: no texture source set (VFS missing)', 2)
  end
  local d = __uiTextureDims(filename)
  if not d then return nil end
  return d[1], d[2]
end

-- Font metrics: upper and lower length. text.lua:39 builds the height of one
-- Text controls. Without real values ​​there is no height - so it is demanded
-- not appreciated.
function __mauiFontMetrics(family, size)
  if not __uiFontMetrics then
    error('FontAscent/FontDescent: no font metric set (engine must provide it)', 2)
  end
  local m = __uiFontMetrics(family, size)
  return m[1], m[2]
end

-- Text width in pixels. No layout can calculate without real font metrics —
-- So it is NOT estimated here, but required (Cfile:1146720
-- CMauiText::GetStringAdvance).
function __mauiStringAdvance(str, family, size)
  if not __uiStringAdvance then
    error('GetStringAdvance: no font metric set (engine must provide it)', 2)
  end
  return __uiStringAdvance(str, family, size)
end

local function lazyvar()
  return import('/lua/lazyvar.lua')
end

-- The seven LazyVars that the engine attaches to each control (Cfile:1123966).
-- Without a starting value they would be 0 (lazyvar.lua:110) — that is exactly the behavior
-- on which control.lua:33-40 is based: only ResetLayout() makes it the
-- circular chain in which at least four variables must be set.
local function attachControl(luaobj, parent, kind)
  local LazyVar = lazyvar()
  luaobj.Left = LazyVar.Create()
  luaobj.Right = LazyVar.Create()
  luaobj.Top = LazyVar.Create()
  luaobj.Bottom = LazyVar.Create()
  luaobj.Width = LazyVar.Create()
  luaobj.Height = LazyVar.Create()
  luaobj.Depth = LazyVar.Create()

  luaobj.__id = __nextMauiId
  __nextMauiId = __nextMauiId + 1
  luaobj.__kind = kind
  luaobj.__parent = parent or false
  luaobj.__children = {}
  luaobj.__hidden = false
  luaobj.__alpha = 1
  luaobj.__hitTest = true
  luaobj.__name = kind
  luaobj.__needsFrameUpdate = false
  luaobj.__renderPass = 0

  if parent then
    parent.__children[table.getn(parent.__children) + 1] = luaobj
  end
  __mauiControls[luaobj.__id] = luaobj
  __mauiDirty = true
  return luaobj
end

-- CMauiControl::DoInit (@0x786E90) = RunScript(this, "OnInit").
local function doInit(luaobj)
  luaobj:OnInit()
  return luaobj
end

-- === The InternalCreate* globals ===

-- A frame is the root of the UI tree (not a parent).
function InternalCreateFrame(luaobj)
  attachControl(luaobj, nil, 'frame')
  __uiFrames[0] = luaobj
  return doInit(luaobj)
end

function InternalCreateGroup(luaobj, parent)
  attachControl(luaobj, parent, 'group')
  return doInit(luaobj)
end

function InternalCreateBitmap(luaobj, parent)
  attachControl(luaobj, parent, 'bitmap')
  -- CMauiBitmap: zwei zusaetzliche LazyVars (Cfile:1118538-1118539), gefuellt
  -- from the texture masses as soon as SetNewTexture is running (Cfile:1118647).
  local LazyVar = lazyvar()
  luaobj.BitmapWidth = LazyVar.Create()
  luaobj.BitmapHeight = LazyVar.Create()
  return doInit(luaobj)
end

function InternalCreateText(luaobj, parent)
  attachControl(luaobj, parent, 'text')
  luaobj.__text = ''
  luaobj.__fontFamily = ''
  luaobj.__fontSize = 12
  -- CMauiText publishes four more LazyVars in the Lua table (the
  -- Complete list of all engine LazyVars is in the decomp:
  -- grep 'SetObject(&this->mLuaObj, "'):
  --   FontAscent, FontDescent, FontExternalLeading  (Cfile:1145928-1145930)
  --   TextAdvance (width of text)
  -- text.lua:39 builds height from Ascent+Descent, text.lua:47 from TextAdvance
  -- the width. Without them, no text has any size.
  local LazyVar = lazyvar()
  luaobj.FontAscent = LazyVar.Create()
  luaobj.FontDescent = LazyVar.Create()
  luaobj.FontExternalLeading = LazyVar.Create()
  luaobj.TextAdvance = LazyVar.Create()
  return doInit(luaobj)
end

-- CMauiItemList (Cfile:1140074) — the row list. It is the foundation of everything
-- Dropdowns (combo.lua:117), the map selection, the points list and the
-- chat window. The engine holds the rows, the selection and the scroll state
-- SELF (18 methods, all in C++) — that's why the state is here and not in
-- the Lua.
function InternalCreateItemList(luaobj, parent)
  attachControl(luaobj, parent, 'itemlist')
  luaobj.__items = {}
  luaobj.__selection = -1 -- no selection (GetSelection returns -1)
  luaobj.__top = 0 -- erste sichtbare Zeile
  luaobj.__fontFamily = ''
  luaobj.__fontSize = 12
  luaobj.__colors = {}
  luaobj.__showSelection = true
  luaobj.__showMouseover = true
  return doInit(luaobj)
end

-- CMauiEdit (Cfile:1133710) — the text field. The text editing itself is in C++
-- (CMauiEdit::HandleKeyEvent on MET_Char); Here is the state that the 31st
-- Reading and writing bindings.
function InternalCreateEdit(luaobj, parent)
  attachControl(luaobj, parent, 'edit')
  luaobj.__text = ''
  luaobj.__caret = 0
  luaobj.__maxChars = 0
  luaobj.__enabled = true
  luaobj.__fontFamily = ''
  luaobj.__fontSize = 12
  luaobj.__colors = {}
  return doInit(luaobj)
end

-- CMauiMovie (Cfile:1143258) — the film.
--
-- Zwei LazyVars gehoeren dazu (Cfile:1142984-1142985): MovieWidth/MovieHeight.
-- movie.lua:22-23 attaches the width/height of the control to it.
--
-- Nothing loads here without an SFD decoder - and that's exactly what the engine has one for
-- documented way: CMauiMovie::LoadFile returns FALSE if there is no movie
-- (Cfile:1143020-1143035, including /nomovie on the command line). movie.lua:32
-- intercepts this (`local ok = self:InternalSet(filename)` ... `else self:OnStopped()`).
-- This is not a stub, but engine behavior: splash.lua then moves through to
-- Main menu, and main.lua builds its menu without a background film.
function InternalCreateMovie(luaobj, parent)
  attachControl(luaobj, parent, 'movie')
  local LazyVar = lazyvar()
  luaobj.MovieWidth = LazyVar.Create()
  luaobj.MovieHeight = LazyVar.Create()
  luaobj.MovieWidth:Set(0)
  luaobj.MovieHeight:Set(0)
  luaobj.__file = false
  luaobj.__playing = false
  luaobj.__loop = false
  return doInit(luaobj)
end

-- CUIWorldView — the world view. She is a CONTROL, not a special case.
--
-- That's the reason why the minimap can be moved in the original: it
-- IS a WorldView (minimap.lua:115) that hangs in a window - none
-- festgenageltes Rechteck.
--
-- Your __init is in C++ (Cfile:1300209), the signature is written verbatim
-- mHelp:
--
--   moho.UIWorldView:__init(parent_control, cameraName, depth, isMiniMap, trackCamera)
--
-- worldview.lua:96 derives from it: `WorldView = Class(moho.UIWorldView, Control)`.
-- There are two views in the game:
--   * the main view — worldview.lua:22 CreateMainWorldView(parent, mapGroup)
--   * the minimap — minimap.lua:115 WorldView(..., 'MiniMap', 2, true, 'WorldCamera')
--     (isMiniMap = true -> kartografisch, Draufsicht)
--
-- The world is drawn by the 3D engine, not by the Maui renderer: that
-- Control only says WHERE and HOW BIG. That's exactly what the snapshot delivers.
function __uiCreateWorldView(luaobj, parent, cameraName, depth, isMiniMap, trackCamera)
  attachControl(luaobj, parent, 'worldview')
  luaobj.__cameraName = cameraName or 'WorldCamera'
  luaobj.__isMiniMap = isMiniMap == true
  luaobj.__trackCamera = trackCamera
  luaobj.__cartographic = isMiniMap == true
  luaobj.__resourceIcons = false
  luaobj.__inputLocked = false
  luaobj.__highlight = true
  luaobj.__globalCameraCommands = false
  if depth then luaobj.Depth:Set(depth) end
  return doInit(luaobj)
end

-- CMauiScrollbar (Cfile:1144735). `axis` is the lexical string
-- EMauiScrollAxis ("Vert"/"Horz", scrollbar.lua:9-12).
--
-- The scrollbar does NOT calculate itself: it asks its scrollable object via
-- RunScript (Cfile:1124664/1124731/1124775). The protocol is Lua, not C++:
--
--   GetScrollValues(axis) -> rangeMin, rangeMax, visibleMin, visibleMax
--   ScrollLines(axis, delta)   ScrollPages(axis, delta)   ScrollSetTop(axis, top)
function InternalCreateScrollbar(luaobj, parent, axis)
  attachControl(luaobj, parent, 'scrollbar')
  luaobj.__axis = axis or 'Vert'
  luaobj.__scrollable = false
  return doInit(luaobj)
end

-- The root frame: the root of the UI tree that GetFrame(0) returns. The engine
-- creates it at startup and gives it the window size; the class is for that
-- the original frame (frame.lua:6, sets depth to 0).
__mauiRootWidth = 0
__mauiRootHeight = 0
function __mauiCreateRootFrame(width, height)
  local Frame = import('/lua/maui/frame.lua').Frame
  local f = Frame('root')
  -- A frame belongs to exactly one head (screen); we have one.
  -- uiutil.lua:671 fragt ihn: GetFrame(ctrl:GetRootFrame():GetTargetHead()).
  f.__head = 0
  f.Left:Set(0)
  f.Top:Set(0)
  f.Width:Set(width)
  f.Height:Set(height)
  __mauiRootWidth = width
  __mauiRootHeight = height
  return f
end

-- CUIManager::SetNewLuaState (@0x84C4E0, Cfile:1273520) — the ONE way
-- the engine changes the UI state (splash → front-end → lobby → game). The
-- Order is in the decomp:
--
--   1. Clear input capture stack and running dragger (1273557-1273564)
--   2. release old root frames, mState = new state (1273600-1273605)
--   3. a NEW CMauiFrame including LazyVars (1273621-1273666) per head
--   4. Call SetupUI() from /lua/ui/uimain.lua (1273680)
--
-- Two things follow from this that you shouldn't guess: the root frame exists
-- BEFORE SetupUI() (effecthelpers.lua:28 calls GetFrame(0) at the module level), and the
-- maui tree is empty after EVERY state change.
function __mauiResetFrames()
  __mauiCapture = {}
  __mauiDragger = false
  __mauiFocus = false
  -- Everything that is not attached to a frame would otherwise survive the change.
  local roots = {}
  for _, c in pairs(__mauiControls) do
    if not c.__parent then roots[table.getn(roots) + 1] = c end
  end
  for _, c in ipairs(roots) do
    if not c.__destroyed then c:Destroy() end
  end
  __uiFrames = {}
  __mauiCreateRootFrame(__mauiRootWidth, __mauiRootHeight)
end

-- Snapshot of the UI tree for the renderer. The layout numbers are here
-- DRAWN (LazyVar-__call) — that's exactly what the LazyVar cache is built for: as long as
-- If nothing changes, pulling costs nothing.
--
-- A control without a complete layout throws "circular." when dragged
-- dependency" (lazyvar.lua:21). The renderer does NOT catch this
-- unfinished layout is a mistake, not a special case.
-- A control is only visible if neither it nor an ancestor is hidden
-- is. The engine does not render hidden controls - and therefore also draws them
-- their layout does not. A control that was never positioned because it was never
-- is displayed, so it is NOT an error.
local function visible(c)
  local node = c
  while node do
    if node.__hidden then return false end
    node = node.__parent or nil
  end
  return true
end

-- The frame pump: the engine calls OnFrame(delta) on each control per image,
-- which SetNeedsFrameUpdate(true) required (Cfile:1118936 checks
-- mNeedsFrameUpdate). Build on this, among other things: the grids have their layout -
-- gamemain.lua:136-140 uses it as a one-shot init.
-- The UI clock. CurrentTime() is the REAL time (seconds since.) in the UI VM
-- Start), not the Sim tick - userinit.lua:15-21 builds WaitSeconds from it:
--
--   WaitFrames = coroutine.yield
--   function WaitSeconds(n)
--       local later = CurrentTime() + n
--       WaitFrames(1)
--       while CurrentTime() < later do WaitFrames(1) end
--   end
--
-- So the UI VM does NOT have a tick scheduler: its threads run per IMAGE. At
-- They didn't work for us until now - the SIM scheduler was installed, but
-- nobody ticked him. The menu animations and the depend on this
-- Cursor-Thread (cursor.lua:34-43).
__uiTime = 0

-- The parent chain of a control, for error messages. Stands BEFORE the
-- Image pump, because it needs it in the event of an error (a `local` would be further down
-- not yet visible here).
local function chainOf(c)
  local chain = tostring(c.__name) .. '(' .. tostring(c.__kind) .. ')'
  local p = c.__parent
  while p do
    chain = tostring(p.__name) .. '(' .. tostring(p.__kind) .. ') > ' .. chain
    p = p.__parent or nil
  end
  return chain
end

function __mauiFrame(delta)
  -- First the clock, then the threads: a thread waiting for CurrentTime(),
  -- must see the new time.
  __uiTime = __uiTime + (delta or 0)
  if __simAdvanceThreads then __simAdvanceThreads() end

  for _, c in pairs(__mauiControls) do
    if not c.__destroyed and c.__needsFrameUpdate and c.OnFrame then
      -- WITH traceback. Otherwise an error in an OnFrame just says “attempt to
      -- call a nil value" — without the line where it happened, you search in
      -- 300 controls. The engine also logs at this point and does
      -- weiter (CMauiControl::Frame -> RunScript).
      local ok, err = xpcall(function() c:OnFrame(delta) end, debug.traceback)
      if not ok then
        c.__needsFrameUpdate = false -- otherwise it will continue to bang 60 times per second
        WARN('OnFrame ' .. chainOf(c) .. ':\n' .. tostring(err))
      end
    end
  end
end

-- A control only DRAWS if it has something to draw: a bitmap or a
-- Text. Group, Frame and Border are containers — the engine just draws their layout
-- then when someone needs it (a child who aligns with it).
--
-- That's not a detail: borders_mini.lua destroys everything in the mini view
-- Frame bitmaps and leaves the empty `borderGroup` without a layout. In the
-- Originally this is never noticed because no one draws their numbers. Who in the snapshot
-- If you touch EVERY control in general, it reports an error that doesn't exist.
local function draws(c)
  -- A bitmap WITHOUT texture and without color doesn't draw anything. The original UI lays
  -- such placeholders (Bitmap(parent) without file, texture comes later via
  -- SetTexture) — the engine doesn't render them, so we can't either
  -- DOM node still results in a mouse hit.
  if c.__kind == 'bitmap' then
    return (c.__texture ~= nil and c.__texture ~= false)
      or (c.__solidColor ~= nil and c.__solidColor ~= false)
  end
  -- A border draws eight tiles (four edges, four corners) - but only
  -- if he has received textures (border.lua adds them one by one).
  if c.__kind == 'border' then
    return c.__border ~= nil and c.__border.vertical ~= nil
  end
  -- ItemList, Edit and Scrollbar always draw: the engine renders them itself
  -- (Lines, Text, Thumb), they don't need any external texture.
  return c.__kind == 'text'
    or c.__kind == 'itemlist'
    or c.__kind == 'edit'
    or c.__kind == 'scrollbar'
    -- The WorldView draws the WORLD (the 3D page does it in its place) and
    -- accepts clicks - so it has to be in the snapshot and the hit test.
    or c.__kind == 'worldview'
end

-- The four numbers of a control — or nil if the layout is incomplete
-- ("circular dependency", lazyvar.lua:21: less than four of the six variables
-- set).
local function bounds(c)
  local ok, l, t, r, b = pcall(function() return c.Left(), c.Top(), c.Right(), c.Bottom() end)
  if not ok then return nil end
  return l, t, r, b
end

function __mauiSnapshot()
  local out = {}
  local n = 0
  for _, c in pairs(__mauiControls) do
    local laidOut = false
    if not c.__destroyed and draws(c) and visible(c) then
      laidOut = bounds(c) ~= nil
      -- A VISIBLE bitmap or text without layout is a real error: the
      -- Engine would want to draw it and would have no coordinates. Once
      -- Report loudly, then skip over it - don't take up the whole page.
      if not laidOut and not __mauiBroken[c.__id] then
        __mauiBroken[c.__id] = true
        WARN('maui-Layout unvollstaendig, Control uebersprungen: ' .. chainOf(c))
      end
    end
    if laidOut then
      n = n + 1
      -- A control is its RECTANGLE (Left, Top, Right, Bottom) — not
      -- Left + Width. That's not a finishing touch, that's the difference between
      -- “the bar moves” and “the bar stands”:
      --
      --   bitmap.lua:67-70 Bitmap:ResetLayout pins Width/Height FIXED to the
      --                     Texturgroesse (BitmapWidth/BitmapHeight).
      --   statusbar.lua:56-63 The fill bar only sets Left and Right (Right as
      --                     Function of the level) — Width remains the texture!
      --
      -- Anyone who reads the width from Width() ALWAYS draws the bar full.
      -- That's exactly what it looked like: the numbers worked, the bar didn't.
      local l, t, r, b = bounds(c)
      out[n] = {
        id = c.__id,
        kind = c.__kind,
        name = c.__name,
        -- The 9-slice border (only set with kind == 'border').
        __border = c.__border,
        left = l,
        top = t,
        width = r - l,
        height = b - t,
        depth = c.Depth(),
        hidden = c.__hidden == true,
        alpha = c.__alpha or 1,
        texture = c.__texture or false,
        solidColor = c.__solidColor or false,
        text = c.__text or false,
        color = c.__color or false,
        fontSize = c.__fontSize or false,
        fontFamily = c.__fontFamily or false,
        centerH = c.__centerH == true,
        centerV = c.__centerV == true,
      }
    end
  end
  return out
end

-- =====================================================================
-- The snapshot as a JSON STRING.
--
-- Why not just the table? Because EVERY return value from Lua to JS im
-- wasmoon registry gets stuck and the Lua GC never collects it (measured:
-- a snapshot table costs ~78 kB, which will never be freed again). At 60
-- Images per second are around 5 MB/s - after a few minutes it stopped
-- UI VM at its 2GB limit and died with "not enough memory" in the middle of the game.
--
-- A string that Lua PASSES to a JS function is copied during the transition
-- and leaves nothing behind (measured: 0 MB increase). That's why it's done here by hand
-- serialized — the structure is known and flat, a general one
-- JSON-Encoder waere unnoetig teuer.
-- =====================================================================
local function jsonStr(s)
  s = tostring(s)
  s = string.gsub(s, '\\', '\\\\')
  s = string.gsub(s, '"', '\\"')
  s = string.gsub(s, '\n', '\\n')
  s = string.gsub(s, '\r', '\\r')
  s = string.gsub(s, '\t', '\\t')
  return '"' .. s .. '"'
end

-- Number or false/nil -> JSON. Lua otherwise writes integers as "1.0".
-- A layout number can be broken: `inf` or `nan` occurs when a
-- LazyVar divides by zero or a chain does not resolve. `%.4g` writes
-- from it "-inf" or "nan" — and that is NOT valid JSON: the parser breaks
-- with "No number after minus sign" and tears the ENTIRE surface with it,
-- without saying which control is to blame.
--
-- So: the broken number becomes zero (the renderer leaves out the control) and
-- Reported ONCE — with name and field so that the cause can be found.
__mauiBadNumbers = {}

local function jsonNum(v, what)
  if v == nil or v == false then return 'false' end
  if type(v) ~= 'number' or v ~= v or v == math.huge or v == -math.huge then
    local label = tostring(what or '?')
    if not __mauiBadNumbers[label] then
      __mauiBadNumbers[label] = true
      WARN('maui: ' .. label .. ' ist keine gueltige Zahl (' .. tostring(v) .. ') — Control wird nicht gezeichnet')
    end
    return 'null'
  end
  return string.format('%.4g', v)
end

local function jsonOpt(v)
  if v == nil or v == false then return 'false' end
  return jsonStr(v)
end

-- The 9-slice frame: six textures + the two LazyVars that make up the
-- Edge width comes. The renderer puts eight tiles together from this.
local function borderJson(c)
  local b = c.__border
  if not b then return 'false' end
  local ctrl = __mauiControls[c.id]
  local bw, bh = 0, 0
  if ctrl then
    local ok = pcall(function()
      bw = ctrl.BorderWidth()
      bh = ctrl.BorderHeight()
    end)
    if not ok then bw, bh = 0, 0 end
  end
  return '{"vertical":' .. jsonOpt(b.vertical)
    .. ',"horizontal":' .. jsonOpt(b.horizontal)
    .. ',"upperLeft":' .. jsonOpt(b.upperLeft)
    .. ',"upperRight":' .. jsonOpt(b.upperRight)
    .. ',"lowerLeft":' .. jsonOpt(b.lowerLeft)
    .. ',"lowerRight":' .. jsonOpt(b.lowerRight)
    .. ',"borderWidth":' .. jsonNum(bw)
    .. ',"borderHeight":' .. jsonNum(bh)
    .. '}'
end

-- === The Scrollable Protocol ===
--
-- A scrollbar doesn't calculate anything itself: it asks its scrollable
-- (Cfile:1124664/1124731/1124775). Two cases, and the difference is real:
--
--  * An ItemList scrolls in the ENGINE (C++) — it holds lines and
--    Scroll position itself. Your Lua class may use the protocol methods at all
--    don't have: `control.lua:104-118` already defines it, and two
--    Base classes with the same field are "ambiguous" according to class.lua:147.
--  * Any other control (grid, groups in filepicker/mapselect/keybindings)
--    defines it in Lua - the method is called there as normal.
local function itemListRows(ctrl)
  local ok, rh = pcall(function() return ctrl:GetRowHeight() end)
  return math.max(1, math.floor(ctrl.Height() / math.max(1, ok and rh or 12)))
end

function __mauiScrollValues(scrollable, axis)
  if not scrollable then return 0, 0, 0, 0 end
  if scrollable.__kind == 'itemlist' then
    local rows = itemListRows(scrollable)
    local n = table.getn(scrollable.__items)
    return 0, n, scrollable.__top, math.min(n, scrollable.__top + rows)
  end
  if scrollable.GetScrollValues then
    return scrollable:GetScrollValues(axis)
  end
  return 0, 0, 0, 0
end

function __mauiScroll(scrollable, axis, unit, delta)
  if not scrollable then return end
  if scrollable.__kind == 'itemlist' then
    local rows = itemListRows(scrollable)
    local step = delta
    if unit == 'pages' then step = delta * rows end
    local n = table.getn(scrollable.__items)
    local maxTop = math.max(0, n - rows)
    scrollable.__top = math.max(0, math.min(maxTop, math.floor(scrollable.__top + step + 0.5)))
    __mauiDirty = true
    return
  end
  if unit == 'pages' and scrollable.ScrollPages then
    scrollable:ScrollPages(axis, delta)
  elseif scrollable.ScrollLines then
    scrollable:ScrollLines(axis, delta)
  end
end

-- The lines of an ItemList, the text of an edit, the thumb of a scrollbar.
-- The engine renders all three in the original - so it comes from the state of
-- Controls, not from Lua.
local function listJson(ctrl)
  if not ctrl then return 'false' end
  if ctrl.__kind == 'itemlist' then
    local rows = {}
    for i, item in ipairs(ctrl.__items) do
      rows[i] = jsonStr(item)
    end
    local ok, rh = pcall(function() return ctrl:GetRowHeight() end)
    local c = ctrl.__colors or {}
    return '{"items":[' .. table.concat(rows, ',') .. ']'
      .. ',"top":' .. jsonNum(ctrl.__top)
      .. ',"selection":' .. jsonNum(ctrl.__selection)
      .. ',"rowHeight":' .. jsonNum(ok and rh or 12)
      .. ',"fg":' .. jsonOpt(c.fg) .. ',"bg":' .. jsonOpt(c.bg)
      .. ',"selFg":' .. jsonOpt(c.selFg) .. ',"selBg":' .. jsonOpt(c.selBg)
      .. ',"showSelection":' .. tostring(ctrl.__showSelection ~= false)
      .. '}'
  end
  if ctrl.__kind == 'edit' then
    local c = ctrl.__colors or {}
    return '{"text":' .. jsonStr(ctrl.__text or '')
      .. ',"caret":' .. jsonNum(ctrl.__caret or 0)
      .. ',"fg":' .. jsonOpt(c.fg) .. ',"bg":' .. jsonOpt(c.bg)
      .. '}'
  end
  if ctrl.__kind == 'worldview' then
    return '{"camera":' .. jsonStr(ctrl.__cameraName or 'WorldCamera')
      .. ',"miniMap":' .. tostring(ctrl.__isMiniMap == true)
      .. ',"cartographic":' .. tostring(ctrl.__cartographic == true)
      .. ',"resourceIcons":' .. tostring(ctrl.__resourceIcons == true)
      .. '}'
  end
  if ctrl.__kind == 'scrollbar' then
    -- The scrollbar asks its scrollable (Cfile:1124664) - this creates the
    -- Thumb geometry, in proportions (0..1) of the bar.
    local rangeMin, rangeMax, visMin, visMax = 0, 1, 0, 1
    local ok, a, b, cc, d = pcall(function()
      return __mauiScrollValues(ctrl.__scrollable, ctrl.__axis)
    end)
    if ok and a and b and b > a then rangeMin, rangeMax, visMin, visMax = a, b, cc, d end
    local span = math.max(1, rangeMax - rangeMin)
    local t = ctrl.__textures or {}
    return '{"axis":' .. jsonStr(ctrl.__axis or 'Vert')
      .. ',"thumbStart":' .. jsonNum((visMin - rangeMin) / span)
      .. ',"thumbEnd":' .. jsonNum((visMax - rangeMin) / span)
      .. ',"background":' .. jsonOpt(t.background)
      .. ',"thumbMiddle":' .. jsonOpt(t.thumbMiddle)
      .. ',"thumbTop":' .. jsonOpt(t.thumbTop)
      .. ',"thumbBottom":' .. jsonOpt(t.thumbBottom)
      .. '}'
  end
  return 'false'
end

function __mauiSnapshotJson()
  local parts = {}
  local n = 0
  for _, c in ipairs(__mauiSnapshot()) do
    n = n + 1
    parts[n] = '{"id":' .. c.id
      .. ',"list":' .. listJson(__mauiControls[c.id])
      .. ',"border":' .. borderJson(c)
      .. ',"kind":' .. jsonStr(c.kind)
      .. ',"name":' .. jsonStr(c.name)
      .. ',"left":' .. jsonNum(c.left, c.name .. '.Left')
      .. ',"top":' .. jsonNum(c.top, c.name .. '.Top')
      .. ',"width":' .. jsonNum(c.width, c.name .. '.Width')
      .. ',"height":' .. jsonNum(c.height, c.name .. '.Height')
      .. ',"depth":' .. jsonNum(c.depth, c.name .. '.Depth')
      .. ',"hidden":' .. tostring(c.hidden)
      .. ',"alpha":' .. jsonNum(c.alpha, c.name .. '.Alpha')
      .. ',"texture":' .. jsonOpt(c.texture)
      .. ',"solidColor":' .. jsonOpt(c.solidColor)
      .. ',"text":' .. jsonOpt(c.text)
      .. ',"color":' .. jsonOpt(c.color)
      .. ',"fontSize":' .. jsonNum(c.fontSize)
      .. ',"fontFamily":' .. jsonOpt(c.fontFamily)
      .. ',"centerH":' .. tostring(c.centerH)
      .. ',"centerV":' .. tostring(c.centerV)
      .. '}'
  end
  return '[' .. table.concat(parts, ',') .. ']'
end

-- =====================================================================
-- Event-Pump
--
-- The event table has exactly the fields that func_CreateLuaEvent @0x795BD0
-- (Cfile:1136293-1136348) setzt:
--   Type, MouseX, MouseY, WheelRotation, WheelDelta, KeyCode, RawKeyCode,
--   Modifiers { Shift, Ctrl, Alt, Left, Middle, Right }, Control
--
-- The types are Strings; the original Lua compares directly against them
-- (MouseEnter, MouseExit, ButtonPress, ButtonDClick, KeyDown, WheelRotation,
-- MouseMotion).
--
-- And the bubbling is NOT that of the DOM: CMauiControl::HandleEvent
-- (@0x7873A0, Cfile:1124525-1124536) calls HandleEvent on the control; delivers
-- If it is false, the same event goes up the PARENT chain until one returns true.
-- That's why the DOM is set to pointer-events:none — the hit test runs here.
-- =====================================================================

-- Hit test: the highest (largest depth) visible control under the
-- Point whose hit test is active.
-- Only what DRAWS is hit.
--
-- The invisible full-screen containers of the original UI (Screen-Group, mapGroup,
-- windowGroup, the grids) are on top of everything and disable their hit test
-- NOT (uiutil.lua:333). Anyone who counts them lets them eat every click:
-- First, no unit was selectable anymore, then a group above the one was swallowed up
-- In the construction menu, click on the construction icon (and the selection disappeared because of the click
-- passed through as a click in the world).
--
-- The groups still see their events: __mauiDispatch sends the event from
-- hit control up the PARENT chain (CMauiControl::HandleEvent,
-- Cfile:1124525) — exactly like the original.
-- CMauiControl::GetTopmostControl (@0x785xxx, Cfile:1124492) — WOERTLICH:
--
--   for (i = a1; i; i = DepthFirstSuccessor(i, a1))
--     if (!IsHidden && !IsHitTestDisabled && HitTest(x,y) && i->mDepth > mDepth)
--       { best = i; mDepth = i->mDepth; }
--
-- There are two things that you shouldn't guess:
--
--  1. It is a DEPTH SEARCH starting from the root - i.e. the order in which the
--     Controls have been created.
--  2. The comparison is REALLY BIGGER. If the depth is THE SAME, the FIRST in wins
--     Tree order, not the last one.
--
-- Both together decide real cases: they are in the tutorial dialog
-- "No" button and the decorative brackets at the same depth (10110). Who about
-- a hash table runs (pairs) and takes the last one in case of a tie,
-- the bracket grabs by chance - the dialogue can then no longer be answered.
function __mauiHitTest(x, y)
  -- MODALITY: if the capture stack is not empty, the search does not start on
  -- Root frame, but at the top capture control (Cfile:1147376-1147390).
  -- A click next to it does NOTHING - that's exactly what makes a dialog modal
  -- (uiutil.lua:615 MakeInputModal).
  local root = GetInputCapture() or __uiFrames[0]
  if not root then return nil end

  local best, bestDepth = nil, nil
  local function walk(c)
    if c.__destroyed or c.__hidden then return end
    if c.__hitTest ~= false and draws(c) then
      -- Without a layout there is no area, and therefore no hit. That is
      -- no error case: the mini view leaves empty groups without a layout
      -- (borders_mini.lua), and the engine never asks them.
      local l, t, r, b = bounds(c)
      if l and x >= l and x < r and y >= t and y < b then
        local d = c.Depth()
        if bestDepth == nil or d > bestDepth then
          best, bestDepth = c, d
        end
      end
    end
    for _, child in ipairs(c.__children or {}) do
      walk(child)
    end
  end
  walk(root)
  return best
end

-- Add an event to the tree. `control` is the control hit (or nil).
-- Returns true if someone has handled it.
function __mauiDispatch(control, event)
  if not control then return false end
  event.Control = control
  local c = control
  while c do
    if c:HandleEvent(event) then return true end
    c = c.__parent or nil
  end
  return false
end

-- MouseEnter/MouseExit creates the engine from the movement, not the browser:
-- it remembers which control the pointer was last over.
__mauiHover = false

-- Returns true if the event belongs to the UI.
--
-- Zwei Faelle:
--  1. A control handled it (HandleEvent -> true).
--  2. The pointer is over a control that DRAWS something (bitmap/text).
--
-- Case 2 reflects the original: there the game world itself is a control
-- (CUIWorldView), which lies WITHIN the mapGroup — i.e. in the depth order
-- ABOUT the invisible full-screen containers (Screen-Group, mapGroup,
-- windowGroup; uiutil.lua:333 CreateScreenGroup disables its hit test
-- NOT). A click in the free playing area therefore hits the original
-- WorldView, never the containers underneath. With us the world is not (yet).
-- maui-Control — a hit on a pure container therefore means
-- same as there: the click belongs to the world.
--
-- (The rule used to be "everything except the root frame is UI" - that's it
-- Screen group every click and no unit could be selected anymore.)
function __mauiMouse(evType, x, y, mods, keyCode)
  -- An active dragger has CAPTURED the mouse: movement and release are on
  -- it, not in the maui tree (CMauiLuaDragger::OnMove/OnRelease,
  -- Cfile:1130393/1130403). That's exactly how a button comes into its own
  -- OnClick (button.lua:122).
  if __mauiDragger then
    local d = __mauiDragger
    if evType == 'MouseMotion' then
      if d.OnMove then d:OnMove(x, y) end
      return true
    elseif evType == 'ButtonRelease' then
      -- Only the key that started the dragger ends it
      -- (PostDragger gets the KeyCode of the ButtonPress event).
      if __mauiDraggerKey == 0 or keyCode == nil or keyCode == __mauiDraggerKey then
        __mauiDragger = false
        if d.OnRelease then d:OnRelease(x, y) end
      end
      return true
    end
  end

  local hit = __mauiHitTest(x, y)

  -- A ButtonPress on a DIFFERENT control removes keyboard focus
  -- (Cfile:1147523-1147531). Otherwise you continue typing in an input field that you
  -- laengst verlassen hat.
  if evType == 'ButtonPress' and __mauiFocus and hit ~= __mauiFocus then
    local old = __mauiFocus
    __mauiFocus = false
    if old.OnLoseKeyboardFocus then old:OnLoseKeyboardFocus() end
  end

  if hit ~= __mauiHover then
    if __mauiHover then
      __mauiDispatch(__mauiHover, { Type = 'MouseExit', MouseX = x, MouseY = y, Modifiers = mods })
    end
    if hit then
      __mauiDispatch(hit, { Type = 'MouseEnter', MouseX = x, MouseY = y, Modifiers = mods })
    end
    __mauiHover = hit or false
  end

  -- KeyCode gehoert ins Event (func_CreateLuaEvent setzt ihn, Cfile:1136341):
  -- button.lua:160 passes it on to PostDragger so that only THIS mouse button
  -- ended the dragger again.
  local handled = __mauiDispatch(hit, {
    Type = evType, MouseX = x, MouseY = y, Modifiers = mods, KeyCode = keyCode or 0,
  })
  if handled then return true end
  -- A hit on the WORLDVIEW is NOT a UI hit: the world view IS
  -- World (CUIWorldView). In the original it deals with the click itself — selection,
  -- Command, construction. For us, the 3D page does this, so the click has to go there
  -- be passed through.
  --
  -- Before, WorldView didn't exist and the rule was "one click
  -- an invisible full-screen container "belongs to the world". This crutch is
  -- get rid of it - the world is now a real control.
  if hit and hit.__kind == 'worldview' then return false end
  -- Otherwise: the hit test only returns drawing controls - so it's a hit
  -- a UI hit, even if no one has handled it (a click on a panel
  -- is not a movement command).
  return hit ~= nil
end

function __mauiWheel(x, y, rotation, mods)
  local hit = __mauiHitTest(x, y)
  return __mauiDispatch(hit, {
    Type = 'WheelRotation',
    MouseX = x, MouseY = y,
    WheelRotation = rotation, WheelDelta = rotation,
    Modifiers = mods,
  })
end

-- =====================================================================
-- Keyboard, focus and input capture — the three things without which there is no
-- Modality exists.
--
-- FOKUS (Cfile:1125718/1125768/1125828):
--   AcquireKeyboardFocus(exclusive) / AbandonKeyboardFocus() /
--   GetCurrentFocusControl()
-- A ButtonPress on a DIFFERENT control removes the focus
-- (Cfile:1147523-1147531).
--
-- INPUT-CAPTURE-STACK (std::vector sInputCapture, Cfile:430346):
--   AddInputCapture(control) (1147871), RemoveInputCapture(control) — "always
--   first from back" (1147921), GetInputCapture() (1147818), AnyInputCapture()
--   (1147773).
-- Effect: if the stack is not empty, the mouse hit test does NOT start on
-- Root frame, but at back() (Cfile:1147376-1147390). That's exactly what it is
-- Modality — a dialog swallows the clicks next to it.
--
-- ROUTING A KEY EVENT (three identical dispatchers: MET_KeyDown
-- Cfile:1147634, MET_KeyUp 1147668, MET_Char 1147745):
--   1. Has a Control Keyboard focus -> ONLY this gets HandleEvent.
--      If it returns false, the capture stack is NOT asked; the event applies
--      as "skipped" and goes to the console keymap (M3).
--   2. Otherwise: the top capture control.
--   3. Otherwise: skipped.
-- =====================================================================
__mauiFocus = false
__mauiCapture = {}

function GetCurrentFocusControl()
  return __mauiFocus or nil
end

function AnyInputCapture()
  return table.getn(__mauiCapture) > 0
end

function GetInputCapture()
  local n = table.getn(__mauiCapture)
  if n == 0 then return nil end
  return __mauiCapture[n]
end

function AddInputCapture(control)
  if not control then return end
  __mauiCapture[table.getn(__mauiCapture) + 1] = control
end

-- "always first from back" (Cfile:1147921): search from behind, the first
-- Treffer entfernen.
function RemoveInputCapture(control)
  for i = table.getn(__mauiCapture), 1, -1 do
    if __mauiCapture[i] == control then
      table.remove(__mauiCapture, i)
      return
    end
  end
end

-- A key event. Type is 'KeyDown', 'KeyUp' or 'Char'.
--
-- KeyCode is originally a wx code, RawKeyCode from MSW-VK (uiutil.lua:81:
-- UIUtil.VK_PAUSE = 310 = WXK_PAUSE). Both go to the event so that they can
-- Original Lua can read both.
--
-- Returns true if someone handled the event. false means “skipped” —
-- then the keymap can be used (M3).
function __mauiKey(evType, keyCode, rawKeyCode, mods)
  local event = {
    Type = evType,
    KeyCode = keyCode or 0,
    RawKeyCode = rawKeyCode or keyCode or 0,
    Modifiers = mods or {},
  }

  if __mauiFocus and not __mauiFocus.__destroyed then
    -- Just the focus control. If it returns false, the event is “skipped” — the
    -- Capture stack is NOT asked (Cfile:1147634-1147650).
    return __mauiFocus:HandleEvent(event) == true
  end

  local top = GetInputCapture()
  if top then
    return __mauiDispatch(top, event)
  end
  return false
end

-- =====================================================================
-- Dragger — the engine's mouse capture.
--
-- EVERY button click in the original UI goes over it (button.lua:120-160):
--   ButtonPress -> Dragger() -> PostDragger(rootFrame, event.KeyCode, dragger)
--   Let go -> the engine calls dragger:OnRelease(x, y) -> then OnClick
-- So without Dragger there is NEVER an OnClick — no build mode, no order button,
-- no menu button. (That's exactly why the click on the construction icon died: it fell through
-- UI was considered a click into the world, and the ACU lost its
-- Auswahl.)
--
-- Semantics from the decomp:
--   PostDragger(originFrame, keycode, dragger)  @0x78E210, Hilfetext:
--     "Make 'dragger' the active dragger from a particular frame. You can pass
--      nil to cancel the current dragger."
--   CMauiLuaDragger::OnMove/OnRelease (Cfile:1130393/1130403) call the
--     Lua methods with MOUSE POSITION (mMousePos.x/.y),
--   CMauiLuaDragger::OnCancel (Cfile:1130413) without arguments.
--
-- As long as a dragger is active, movement and letting go are not his concern
-- the Maui tree — it caught the mouse.
-- =====================================================================
__mauiDragger = false
__mauiDraggerKey = 0

function InternalCreateDragger(luaobj)
  luaobj.__isDragger = true
  return luaobj
end

function PostDragger(originFrame, keycode, dragger)
  if not dragger then
    -- nil aborts the running dragger (help text @0x78E210).
    local old = __mauiDragger
    __mauiDragger = false
    if old and old.OnCancel then old:OnCancel() end
    return
  end
  __mauiDragger = dragger
  __mauiDraggerKey = keycode or 0
end

-- A dragger is NOT a control: it is created via moho.dragger_methods and
-- destroys itself (dragger.lua:15 OnRelease -> self:Destroy()).
function __mauiDraggerDestroy(dragger)
  if __mauiDragger == dragger then __mauiDragger = false end
end

function InternalCreateBorder(luaobj, parent)
  attachControl(luaobj, parent, 'border')
  local LazyVar = lazyvar()
  luaobj.BorderWidth = LazyVar.Create()
  luaobj.BorderHeight = LazyVar.Create()
  return doInit(luaobj)
end
