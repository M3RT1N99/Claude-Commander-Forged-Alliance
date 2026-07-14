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
__mauiBroken = {}
__uiTextureDims = false
__uiStringAdvance = false
__uiFontMetrics = false

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

-- Schriftmetrik: Ober- und Unterlaenge. text.lua:39 baut daraus die Hoehe eines
-- Text-Controls. Ohne echte Werte gibt es keine Hoehe — also wird gefordert,
-- nicht geschaetzt.
function __mauiFontMetrics(family, size)
  if not __uiFontMetrics then
    error('FontAscent/FontDescent: keine Schriftmetrik gesetzt (Engine muss sie liefern)', 2)
  end
  local m = __uiFontMetrics(family, size)
  return m[1], m[2]
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
  -- CMauiText veroeffentlicht vier weitere LazyVars ins Lua-Table (die
  -- vollstaendige Liste aller Engine-LazyVars steht in der Decomp:
  -- grep 'SetObject(&this->mLuaObj, "'):
  --   FontAscent, FontDescent, FontExternalLeading  (Cfile:1145928-1145930)
  --   TextAdvance                                   (Breite des Textes)
  -- text.lua:39 baut aus Ascent+Descent die Hoehe, text.lua:47 aus TextAdvance
  -- die Breite. Ohne sie hat kein Text Groesse.
  local LazyVar = lazyvar()
  luaobj.FontAscent = LazyVar.Create()
  luaobj.FontDescent = LazyVar.Create()
  luaobj.FontExternalLeading = LazyVar.Create()
  luaobj.TextAdvance = LazyVar.Create()
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

-- Momentaufnahme des UI-Baums fuer den Renderer. Die Layout-Zahlen werden hier
-- GEZOGEN (LazyVar-__call) — genau dafuer ist der LazyVar-Cache gebaut: solange
-- sich nichts aendert, kostet das Ziehen nichts.
--
-- Ein Control ohne vollstaendiges Layout wirft beim Ziehen "circular
-- dependency" (lazyvar.lua:21). Das faengt der Renderer NICHT ab — ein
-- unfertiges Layout ist ein Fehler, kein Sonderfall.
-- Ein Control ist nur sichtbar, wenn weder es selbst noch ein Vorfahr versteckt
-- ist. Versteckte Controls rendert die Engine nicht — und zieht folglich auch
-- ihr Layout nicht. Ein Control, das nie positioniert wurde, weil es nie
-- angezeigt wird, ist also KEIN Fehler.
local function visible(c)
  local node = c
  while node do
    if node.__hidden then return false end
    node = node.__parent or nil
  end
  return true
end

-- Die Frame-Pumpe: die Engine ruft pro Bild OnFrame(delta) auf jedem Control,
-- das SetNeedsFrameUpdate(true) verlangt hat (Cfile:1118936 prueft
-- mNeedsFrameUpdate). Darauf bauen u. a. die Grids ihr Layout auf —
-- gamemain.lua:136-140 nutzt es als One-Shot-Init.
function __mauiFrame(delta)
  for _, c in pairs(__mauiControls) do
    if not c.__destroyed and c.__needsFrameUpdate and c.OnFrame then
      c:OnFrame(delta)
    end
  end
end

-- Die Elternkette eines Controls, fuer Fehlermeldungen.
local function chainOf(c)
  local chain = tostring(c.__name) .. '(' .. tostring(c.__kind) .. ')'
  local p = c.__parent
  while p do
    chain = tostring(p.__name) .. '(' .. tostring(p.__kind) .. ') > ' .. chain
    p = p.__parent or nil
  end
  return chain
end

-- Ein Control ZEICHNET nur, wenn es etwas zu zeichnen hat: ein Bitmap oder ein
-- Text. Group, Frame und Border sind Behaelter — die Engine zieht ihr Layout nur
-- dann, wenn es jemand braucht (ein Kind, das sich daran ausrichtet).
--
-- Das ist kein Detail: borders_mini.lua zerstoert in der Mini-Ansicht saemtliche
-- Rahmen-Bitmaps und laesst die leere `borderGroup` ohne Layout stehen. Im
-- Original faellt das nie auf, weil niemand ihre Zahlen zieht. Wer im Snapshot
-- pauschal JEDES Control anfasst, meldet dort einen Fehler, den es nicht gibt.
local function draws(c)
  return c.__kind == 'bitmap' or c.__kind == 'text'
end

-- Die vier Zahlen eines Controls — oder nil, wenn das Layout unvollstaendig ist
-- ("circular dependency", lazyvar.lua:21: weniger als vier der sechs Variablen
-- gesetzt).
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
      -- Ein SICHTBARES Bitmap oder Text ohne Layout ist ein echter Fehler: die
      -- Engine wuerde es zeichnen wollen und haette keine Koordinaten. Einmal
      -- laut melden, dann ueberspringen — nicht die ganze Seite mitreissen.
      if not laidOut and not __mauiBroken[c.__id] then
        __mauiBroken[c.__id] = true
        WARN('maui-Layout unvollstaendig, Control uebersprungen: ' .. chainOf(c))
      end
    end
    if laidOut then
      n = n + 1
      out[n] = {
        id = c.__id,
        kind = c.__kind,
        name = c.__name,
        left = c.Left(),
        top = c.Top(),
        width = c.Width(),
        height = c.Height(),
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
-- Event-Pump
--
-- Das Event-Table hat exakt die Felder, die func_CreateLuaEvent @0x795BD0
-- (Cfile:1136293-1136348) setzt:
--   Type, MouseX, MouseY, WheelRotation, WheelDelta, KeyCode, RawKeyCode,
--   Modifiers { Shift, Ctrl, Alt, Left, Middle, Right }, Control
--
-- Die Typen sind Strings; die Original-Lua vergleicht direkt gegen sie
-- (MouseEnter, MouseExit, ButtonPress, ButtonDClick, KeyDown, WheelRotation,
-- MouseMotion).
--
-- Und das Bubbling ist NICHT das des DOM: CMauiControl::HandleEvent
-- (@0x7873A0, Cfile:1124525-1124536) ruft HandleEvent auf dem Control; liefert
-- es false, geht dasselbe Event die PARENT-Kette hoch, bis eines true liefert.
-- Deshalb ist das DOM auf pointer-events:none — der Hit-Test laeuft hier.
-- =====================================================================

-- Trefferpruefung: das oberste (groesste Depth) sichtbare Control unter dem
-- Punkt, dessen Hit-Test aktiv ist.
function __mauiHitTest(x, y)
  local best = nil
  for _, c in pairs(__mauiControls) do
    if not c.__destroyed and visible(c) and c.__hitTest ~= false then
      -- Ohne Layout gibt es keine Flaeche, also auch keinen Treffer. Das ist
      -- kein Fehlerfall: die Mini-Ansicht laesst leere Gruppen ohne Layout
      -- stehen (borders_mini.lua), und die Engine fragt sie nie.
      local l, t, r, b = bounds(c)
      if l and x >= l and x < r and y >= t and y < b then
        if not best or c.Depth() > best.Depth() then best = c end
      end
    end
  end
  return best
end

-- Ein Event in den Baum geben. `control` ist das getroffene Control (oder nil).
-- Rueckgabe: true, wenn es jemand behandelt hat.
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

-- MouseEnter/MouseExit erzeugt die Engine aus der Bewegung, nicht der Browser:
-- sie merkt sich, ueber welchem Control der Zeiger zuletzt stand.
__mauiHover = false

-- Liefert true, wenn das Event der UI gehoert.
--
-- Zwei Faelle:
--  1. Ein Control hat es behandelt (HandleEvent -> true).
--  2. Der Zeiger steht ueberhaupt ueber einem UI-Control.
--
-- Fall 2 ist kein Zusatz, sondern das Original: die Spielwelt ist dort selbst
-- ein Control (CUIWorldView) ganz unten im Stapel. Liegt ein Panel darueber,
-- ist das Panel das oberste getroffene Control — und die WorldView sieht das
-- Event nie. Bei uns ist die Welt kein maui-Control, also gilt: alles ausser
-- dem Root-Frame ist UI, und ein Klick darauf ist kein Bewegungsbefehl.
function __mauiMouse(evType, x, y, mods)
  local hit = __mauiHitTest(x, y)

  if hit ~= __mauiHover then
    if __mauiHover then
      __mauiDispatch(__mauiHover, { Type = 'MouseExit', MouseX = x, MouseY = y, Modifiers = mods })
    end
    if hit then
      __mauiDispatch(hit, { Type = 'MouseEnter', MouseX = x, MouseY = y, Modifiers = mods })
    end
    __mauiHover = hit or false
  end

  local handled = __mauiDispatch(hit, {
    Type = evType, MouseX = x, MouseY = y, Modifiers = mods,
  })
  if handled then return true end
  return hit ~= nil and hit.__kind ~= 'frame'
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

function InternalCreateBorder(luaobj, parent)
  attachControl(luaobj, parent, 'border')
  local LazyVar = lazyvar()
  luaobj.BorderWidth = LazyVar.Create()
  luaobj.BorderHeight = LazyVar.Create()
  return doInit(luaobj)
end
