-- =====================================================================
-- maui — das C++-Substrat unter der Original-UI-Lua.
--
-- Die UI selbst (lua/maui/*.lua, lua/ui/**) wird AUSGEFUEHRT, nicht nachgebaut.
-- Die Engine liefert nur drei Dinge:
--
--   1. Die LazyVar-Instanzen jedes Controls.
--      CMauiControl::CMauiControl (@0x7867B0, Cfile:1123966-1123972) erzeugt
--      sieben CScriptLazyVar_float und veroeffentlicht sie ins Lua-Table:
--        Left, Right, Top, Bottom, Width, Height, Depth
--      Ein Bitmap bekommt zusaetzlich BitmapWidth/BitmapHeight (Cfile:1118538),
--      gesetzt aus den Texturmassen (Cfile:1118647) — deshalb bemisst sich ein
--      Bitmap per Default nach seiner DDS (bitmap.lua:69-70).
--
--   2. Die InternalCreate*-Globals (scr_UserInits):
--        InternalCreateFrame  (Cfile:1136866)
--        InternalCreateGroup  (Cfile:1137468)
--        InternalCreateBitmap (Cfile:1119519)
--        InternalCreateText   (Cfile:1146210)
--      Muster ueberall gleich: Lua legt die Tabelle an, C++ haengt sich als Peer
--      dran, und am Ende ruft DoInit. CMauiControl::DoInit (@0x786E90,
--      Cfile:1124190) ist nichts anderes als RunScript(this, "OnInit") — erst
--      dadurch laeuft Control.OnInit (control.lua:42) und baut die zirkulaere
--      Layout-Kette auf.
--
--   3. Die Methoden der Basisklassen (moho.control_methods etc., siehe moho.lua).
--
-- LazyVar selbst wird NICHT nachgebaut: /lua/lazyvar.lua ist Original-Lua und
-- wird importiert.
-- =====================================================================

__mauiControls = {}
__nextMauiId = 1
__mauiDirty = false
__uiTextureDims = false
__uiStringAdvance = false

-- GetTextureDimensions(filename) -> width, height  (UI-Global, scr_UserInits).
-- bitmap.lua nutzt es indirekt: SetNewTexture fuellt daraus BitmapWidth/Height,
-- und ein Bitmap ohne Layout-Helfer bemisst sich genau danach.
function GetTextureDimensions(filename)
  if not __uiTextureDims then
    error('GetTextureDimensions: keine Textur-Quelle gesetzt (VFS fehlt)', 2)
  end
  local d = __uiTextureDims(filename)
  if not d then return nil end
  return d[1], d[2]
end

-- Textbreite in Pixeln. Ohne echte Schriftmetrik kann kein Layout rechnen —
-- also wird hier NICHT geschaetzt, sondern gefordert (Cfile:1146720
-- CMauiText::GetStringAdvance).
function __mauiStringAdvance(str, family, size)
  if not __uiStringAdvance then
    error('GetStringAdvance: keine Schriftmetrik gesetzt (Engine muss sie liefern)', 2)
  end
  return __uiStringAdvance(str, family, size)
end

local function lazyvar()
  return import('/lua/lazyvar.lua')
end

-- Die sieben LazyVars, die die Engine an jedes Control haengt (Cfile:1123966).
-- Ohne Startwert waeren sie 0 (lazyvar.lua:110) — das ist genau das Verhalten,
-- auf das control.lua:33-40 baut: erst ResetLayout() macht daraus die
-- zirkulaere Kette, in der mindestens vier Variablen gesetzt sein muessen.
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

-- === Die InternalCreate*-Globals ===

-- Ein Frame ist die Wurzel des UI-Baums (kein Parent).
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
  -- aus den Texturmassen, sobald SetNewTexture laeuft (Cfile:1118647).
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
  return doInit(luaobj)
end

-- Der Root-Frame: die Wurzel des UI-Baums, die GetFrame(0) liefert. Die Engine
-- erzeugt ihn beim Start und gibt ihm die Fenstergroesse; die Klasse dafuer ist
-- die Original-Frame (frame.lua:6, setzt Depth auf 0).
function __mauiCreateRootFrame(width, height)
  local Frame = import('/lua/maui/frame.lua').Frame
  local f = Frame('root')
  f.Left:Set(0)
  f.Top:Set(0)
  f.Width:Set(width)
  f.Height:Set(height)
  return f
end

function InternalCreateBorder(luaobj, parent)
  attachControl(luaobj, parent, 'border')
  local LazyVar = lazyvar()
  luaobj.BorderWidth = LazyVar.Create()
  luaobj.BorderHeight = LazyVar.Create()
  return doInit(luaobj)
end
