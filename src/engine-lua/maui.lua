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

-- CMauiItemList (Cfile:1140074) — die Zeilenliste. Sie ist die Grundlage jedes
-- Dropdowns (combo.lua:117), der Kartenauswahl, der Punkteliste und des
-- Chat-Fensters. Die Engine haelt die Zeilen, die Auswahl und den Scroll-Zustand
-- SELBST (18 Methoden, alle in C++) — deshalb liegt der Zustand hier und nicht in
-- der Lua.
function InternalCreateItemList(luaobj, parent)
  attachControl(luaobj, parent, 'itemlist')
  luaobj.__items = {}
  luaobj.__selection = -1 -- keine Auswahl (GetSelection liefert -1)
  luaobj.__top = 0 -- erste sichtbare Zeile
  luaobj.__fontFamily = ''
  luaobj.__fontSize = 12
  luaobj.__colors = {}
  luaobj.__showSelection = true
  luaobj.__showMouseover = true
  return doInit(luaobj)
end

-- CMauiEdit (Cfile:1133710) — das Textfeld. Das Text-Editing selbst liegt in C++
-- (CMauiEdit::HandleKeyEvent auf MET_Char); hier steht der Zustand, den die 31
-- Bindungen lesen und schreiben.
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

-- CMauiMovie (Cfile:1143258) — der Film.
--
-- Zwei LazyVars gehoeren dazu (Cfile:1142984-1142985): MovieWidth/MovieHeight.
-- movie.lua:22-23 haengt Width/Height des Controls daran.
--
-- Ohne SFD-Decoder laedt hier nichts — und genau dafuer hat die Engine einen
-- dokumentierten Weg: CMauiMovie::LoadFile liefert FALSE, wenn kein Film da ist
-- (Cfile:1143020-1143035, u. a. bei /nomovie auf der Kommandozeile). movie.lua:32
-- faengt das ab (`local ok = self:InternalSet(filename)` ... `else self:OnStopped()`).
-- Das ist kein Stub, sondern Engine-Verhalten: splash.lua zieht dann durch zum
-- Hauptmenue, und main.lua baut sein Menue ohne Hintergrundfilm.
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

-- CMauiScrollbar (Cfile:1144735). `axis` ist der Lexical-String der
-- EMauiScrollAxis ("Vert"/"Horz", scrollbar.lua:9-12).
--
-- Der Scrollbar rechnet NICHT selbst: er fragt sein Scrollable-Objekt per
-- RunScript (Cfile:1124664/1124731/1124775). Das Protokoll ist Lua, nicht C++:
--
--   GetScrollValues(axis) -> rangeMin, rangeMax, visibleMin, visibleMax
--   ScrollLines(axis, delta)   ScrollPages(axis, delta)   ScrollSetTop(axis, top)
function InternalCreateScrollbar(luaobj, parent, axis)
  attachControl(luaobj, parent, 'scrollbar')
  luaobj.__axis = axis or 'Vert'
  luaobj.__scrollable = false
  return doInit(luaobj)
end

-- Der Root-Frame: die Wurzel des UI-Baums, die GetFrame(0) liefert. Die Engine
-- erzeugt ihn beim Start und gibt ihm die Fenstergroesse; die Klasse dafuer ist
-- die Original-Frame (frame.lua:6, setzt Depth auf 0).
__mauiRootWidth = 0
__mauiRootHeight = 0
function __mauiCreateRootFrame(width, height)
  local Frame = import('/lua/maui/frame.lua').Frame
  local f = Frame('root')
  -- Ein Frame gehoert zu genau einem Head (Bildschirm); wir haben einen.
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

-- CUIManager::SetNewLuaState (@0x84C4E0, Cfile:1273520) — der EINE Weg, auf dem
-- die Engine den UI-Zustand wechselt (Splash → Front-End → Lobby → Spiel). Die
-- Reihenfolge steht in der Decomp:
--
--   1. Input-Capture-Stack und laufenden Dragger abraeumen   (1273557-1273564)
--   2. alte Root-Frames freigeben, mState = neuer Zustand    (1273600-1273605)
--   3. pro Head einen NEUEN CMauiFrame samt LazyVars         (1273621-1273666)
--   4. SetupUI() aus /lua/ui/uimain.lua rufen                (1273680)
--
-- Zwei Dinge folgen daraus, die man nicht raten darf: der Root-Frame existiert
-- VOR SetupUI() (effecthelpers.lua:28 ruft auf Modulebene GetFrame(0)), und der
-- maui-Baum ist nach JEDEM Zustandswechsel leer.
function __mauiResetFrames()
  __mauiCapture = {}
  __mauiDragger = false
  __mauiFocus = false
  -- Alles, was an keinem Frame haengt, wuerde den Wechsel sonst ueberleben.
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
-- Die UI-Uhr. CurrentTime() ist in der UI-VM die ECHTE Zeit (Sekunden seit
-- Start), nicht der Sim-Tick — userinit.lua:15-21 baut WaitSeconds daraus:
--
--   WaitFrames = coroutine.yield
--   function WaitSeconds(n)
--       local later = CurrentTime() + n
--       WaitFrames(1)
--       while CurrentTime() < later do WaitFrames(1) end
--   end
--
-- Die UI-VM hat also KEINEN Tick-Scheduler: ihre Threads laufen pro BILD. Bei
-- uns liefen sie bisher gar nicht — der Sim-Scheduler war installiert, aber
-- niemand hat ihn getickt. Daran haengen die Menue-Animationen und der
-- Cursor-Thread (cursor.lua:34-43).
__uiTime = 0

function __mauiFrame(delta)
  -- Erst die Uhr, dann die Threads: ein Thread, der auf CurrentTime() wartet,
  -- muss die neue Zeit sehen.
  __uiTime = __uiTime + (delta or 0)
  if __simAdvanceThreads then __simAdvanceThreads() end

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
  -- Ein Bitmap OHNE Textur und ohne Farbe zeichnet nichts. Die Original-UI legt
  -- solche Platzhalter an (Bitmap(parent) ohne Datei, Textur kommt spaeter per
  -- SetTexture) — die Engine rendert sie nicht, also darf auch bei uns weder ein
  -- DOM-Knoten noch ein Maus-Treffer daraus entstehen.
  if c.__kind == 'bitmap' then
    return (c.__texture ~= nil and c.__texture ~= false)
      or (c.__solidColor ~= nil and c.__solidColor ~= false)
  end
  -- Ein Border zeichnet acht Kacheln (vier Kanten, vier Ecken) — aber erst,
  -- wenn er Texturen bekommen hat (border.lua setzt sie einzeln nach).
  if c.__kind == 'border' then
    return c.__border ~= nil and c.__border.vertical ~= nil
  end
  -- ItemList, Edit und Scrollbar zeichnen immer: die Engine rendert sie selbst
  -- (Zeilen, Text, Thumb), sie brauchen keine Textur von aussen.
  return c.__kind == 'text'
    or c.__kind == 'itemlist'
    or c.__kind == 'edit'
    or c.__kind == 'scrollbar'
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
        -- Der 9-Slice-Rahmen (nur bei kind == 'border' gesetzt).
        __border = c.__border,
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
-- Der Snapshot als JSON-STRING.
--
-- Warum nicht einfach die Tabelle? Weil JEDER Rueckgabewert aus Lua nach JS im
-- wasmoon-Registry haengen bleibt und der Lua-GC ihn nie einsammelt (gemessen:
-- eine Snapshot-Tabelle kostet ~78 kB, die nie wieder frei werden). Bei 60
-- Bildern pro Sekunde sind das rund 5 MB/s — nach wenigen Minuten stand die
-- UI-VM an ihrer 2-GB-Grenze und starb mit "not enough memory" mitten im Spiel.
--
-- Ein String, den Lua an eine JS-Funktion UEBERGIBT, wird beim Uebergang kopiert
-- und hinterlaesst nichts (gemessen: 0 MB Zuwachs). Deshalb wird hier von Hand
-- serialisiert — die Struktur ist bekannt und flach, ein allgemeiner
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

-- Zahl oder false/nil -> JSON. Lua schreibt Ganzzahlen sonst als "1.0".
local function jsonNum(v)
  if v == nil or v == false then return 'false' end
  return string.format('%.4g', v)
end

local function jsonOpt(v)
  if v == nil or v == false then return 'false' end
  return jsonStr(v)
end

-- Der 9-Slice-Rahmen: sechs Texturen + die beiden LazyVars, aus denen die
-- Kantenbreite kommt. Der Renderer setzt daraus acht Kacheln zusammen.
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

-- === Das Scrollable-Protokoll ===
--
-- Ein Scrollbar rechnet nichts selbst: er fragt sein Scrollable
-- (Cfile:1124664/1124731/1124775). Zwei Faelle, und der Unterschied ist echt:
--
--  * Eine ItemList scrollt in der ENGINE (C++) — sie haelt Zeilen und
--    Scroll-Position selbst. Ihre Lua-Klasse darf die Protokoll-Methoden gar
--    nicht haben: `control.lua:104-118` definiert sie schon, und zwei
--    Basisklassen mit demselben Feld sind laut class.lua:147 "ambiguous".
--  * Jedes andere Control (Grid, Gruppen in filepicker/mapselect/keybindings)
--    definiert sie in Lua — dort wird ganz normal die Methode gerufen.
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

-- Die Zeilen einer ItemList, der Text eines Edits, der Thumb eines Scrollbars.
-- Alles drei rendert im Original die Engine — also kommt es aus dem Zustand des
-- Controls, nicht aus der Lua.
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
  if ctrl.__kind == 'scrollbar' then
    -- Der Scrollbar fragt sein Scrollable (Cfile:1124664) — daraus entsteht die
    -- Thumb-Geometrie, in Anteilen (0..1) des Balkens.
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
      .. ',"left":' .. jsonNum(c.left)
      .. ',"top":' .. jsonNum(c.top)
      .. ',"width":' .. jsonNum(c.width)
      .. ',"height":' .. jsonNum(c.height)
      .. ',"depth":' .. jsonNum(c.depth)
      .. ',"hidden":' .. tostring(c.hidden)
      .. ',"alpha":' .. jsonNum(c.alpha)
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
-- Getroffen wird nur, was auch ZEICHNET.
--
-- Die unsichtbaren Vollbild-Container der Original-UI (Screen-Group, mapGroup,
-- windowGroup, die Grids) liegen ueber allem und deaktivieren ihren Hit-Test
-- NICHT (uiutil.lua:333). Wer sie mitzaehlt, laesst sie jeden Klick fressen:
-- erst war keine Einheit mehr waehlbar, dann verschluckte eine Gruppe ueber dem
-- Bau-Menue den Klick aufs Bau-Icon (und die Auswahl fiel weg, weil der Klick
-- als Klick in die Welt durchging).
--
-- Die Gruppen sehen ihre Events trotzdem: __mauiDispatch schickt das Event vom
-- getroffenen Control die ELTERN-Kette hoch (CMauiControl::HandleEvent,
-- Cfile:1124525) — genau wie im Original.
-- CMauiControl::GetTopmostControl (@0x785xxx, Cfile:1124492) — WOERTLICH:
--
--   for (i = a1; i; i = DepthFirstSuccessor(i, a1))
--     if (!IsHidden && !IsHitTestDisabled && HitTest(x,y) && i->mDepth > mDepth)
--       { best = i; mDepth = i->mDepth; }
--
-- Zwei Dinge stehen da, die man nicht raten darf:
--
--  1. Es ist eine TIEFENSUCHE ab der Wurzel — also die Reihenfolge, in der die
--     Controls angelegt wurden.
--  2. Der Vergleich ist ECHT GROESSER. Bei GLEICHER Tiefe gewinnt der ERSTE in
--     Baumreihenfolge, nicht der letzte.
--
-- Beides zusammen entscheidet echte Faelle: im Tutorial-Dialog liegen der
-- "Nein"-Knopf und die Deko-Klammern auf derselben Tiefe (10110). Wer ueber
-- eine Hash-Tabelle laeuft (pairs) und bei Gleichstand den letzten nimmt,
-- greift zufaellig die Klammer — der Dialog ist dann nicht mehr zu beantworten.
function __mauiHitTest(x, y)
  -- MODALITAET: ist der Capture-Stack nicht leer, beginnt die Suche nicht am
  -- Root-Frame, sondern beim obersten Capture-Control (Cfile:1147376-1147390).
  -- Ein Klick daneben trifft dann NICHTS — genau das macht einen Dialog modal
  -- (uiutil.lua:615 MakeInputModal).
  local root = GetInputCapture() or __uiFrames[0]
  if not root then return nil end

  local best, bestDepth = nil, nil
  local function walk(c)
    if c.__destroyed or c.__hidden then return end
    if c.__hitTest ~= false and draws(c) then
      -- Ohne Layout gibt es keine Flaeche, also auch keinen Treffer. Das ist
      -- kein Fehlerfall: die Mini-Ansicht laesst leere Gruppen ohne Layout
      -- stehen (borders_mini.lua), und die Engine fragt sie nie.
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
--  2. Der Zeiger steht ueber einem Control, das etwas ZEICHNET (Bitmap/Text).
--
-- Fall 2 bildet das Original ab: dort ist die Spielwelt selbst ein Control
-- (CUIWorldView), das INNERHALB der mapGroup liegt — also in der Tiefenordnung
-- UEBER den unsichtbaren Vollbild-Containern (Screen-Group, mapGroup,
-- windowGroup; uiutil.lua:333 CreateScreenGroup deaktiviert seinen Hit-Test
-- NICHT). Ein Klick in die freie Spielflaeche trifft im Original deshalb die
-- WorldView, nie die Container darunter. Bei uns ist die Welt (noch) kein
-- maui-Control — ein Treffer auf einen reinen Container bedeutet daher
-- dasselbe wie dort: der Klick gehoert der Welt.
--
-- (Die Regel war frueher "alles ausser dem Root-Frame ist UI" — damit fras die
-- Screen-Group jeden Klick und keine Einheit war mehr selektierbar.)
function __mauiMouse(evType, x, y, mods, keyCode)
  -- Ein aktiver Dragger hat die Maus ERFASST: Bewegung und Loslassen gehen an
  -- ihn, nicht in den maui-Baum (CMauiLuaDragger::OnMove/OnRelease,
  -- Cfile:1130393/1130403). Genau so kommt ein Button ueberhaupt zu seinem
  -- OnClick (button.lua:122).
  if __mauiDragger then
    local d = __mauiDragger
    if evType == 'MouseMotion' then
      if d.OnMove then d:OnMove(x, y) end
      return true
    elseif evType == 'ButtonRelease' then
      -- Nur die Taste, mit der der Dragger gestartet wurde, beendet ihn
      -- (PostDragger bekommt den KeyCode des ButtonPress-Events).
      if __mauiDraggerKey == 0 or keyCode == nil or keyCode == __mauiDraggerKey then
        __mauiDragger = false
        if d.OnRelease then d:OnRelease(x, y) end
      end
      return true
    end
  end

  local hit = __mauiHitTest(x, y)

  -- Ein ButtonPress auf ein ANDERES Control entzieht den Tastatur-Fokus
  -- (Cfile:1147523-1147531). Sonst tippt man weiter in ein Eingabefeld, das man
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
  -- button.lua:160 reicht ihn an PostDragger weiter, damit nur DIESE Maustaste
  -- den Dragger wieder beendet.
  local handled = __mauiDispatch(hit, {
    Type = evType, MouseX = x, MouseY = y, Modifiers = mods, KeyCode = keyCode or 0,
  })
  if handled then return true end
  -- Der Hit-Test liefert nur zeichnende Controls — ein Treffer ist also immer
  -- ein UI-Treffer, auch wenn ihn niemand behandelt hat (ein Klick auf ein
  -- Panel ist kein Bewegungsbefehl).
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
-- Tastatur, Fokus und InputCapture — die drei Dinge, ohne die es keine
-- Modalitaet gibt.
--
-- FOKUS (Cfile:1125718/1125768/1125828):
--   AcquireKeyboardFocus(exclusive) / AbandonKeyboardFocus() /
--   GetCurrentFocusControl()
-- Ein ButtonPress auf ein ANDERES Control entzieht den Fokus
-- (Cfile:1147523-1147531).
--
-- INPUT-CAPTURE-STACK (std::vector sInputCapture, Cfile:430346):
--   AddInputCapture(control) (1147871), RemoveInputCapture(control) — "always
--   first from back" (1147921), GetInputCapture() (1147818), AnyInputCapture()
--   (1147773).
-- Wirkung: ist der Stack nicht leer, startet der Maus-Hit-Test NICHT am
-- Root-Frame, sondern bei back() (Cfile:1147376-1147390). Genau DAS ist die
-- Modalitaet — ein Dialog schluckt die Klicks daneben.
--
-- ROUTING EINES TASTEN-EVENTS (drei identische Dispatcher: MET_KeyDown
-- Cfile:1147634, MET_KeyUp 1147668, MET_Char 1147745):
--   1. Hat ein Control Keyboard-Fokus -> NUR dieses bekommt HandleEvent.
--      Liefert es false, wird der Capture-Stack NICHT gefragt; das Event gilt
--      als "skipped" und geht an die Konsolen-Keymap (M3).
--   2. Sonst: das oberste Capture-Control.
--   3. Sonst: skipped.
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

-- "always first from back" (Cfile:1147921): von hinten suchen, den ersten
-- Treffer entfernen.
function RemoveInputCapture(control)
  for i = table.getn(__mauiCapture), 1, -1 do
    if __mauiCapture[i] == control then
      table.remove(__mauiCapture, i)
      return
    end
  end
end

-- Ein Tasten-Event. Typ ist 'KeyDown', 'KeyUp' oder 'Char'.
--
-- KeyCode ist im Original ein wx-Code, RawKeyCode der MSW-VK (uiutil.lua:81:
-- UIUtil.VK_PAUSE = 310 = WXK_PAUSE). Beide gehen ins Event, damit die
-- Original-Lua beide lesen kann.
--
-- Rueckgabe: true, wenn jemand das Event behandelt hat. false heisst "skipped" —
-- dann darf die Keymap ran (M3).
function __mauiKey(evType, keyCode, rawKeyCode, mods)
  local event = {
    Type = evType,
    KeyCode = keyCode or 0,
    RawKeyCode = rawKeyCode or keyCode or 0,
    Modifiers = mods or {},
  }

  if __mauiFocus and not __mauiFocus.__destroyed then
    -- Nur das Fokus-Control. Liefert es false, ist das Event "skipped" — der
    -- Capture-Stack wird NICHT gefragt (Cfile:1147634-1147650).
    return __mauiFocus:HandleEvent(event) == true
  end

  local top = GetInputCapture()
  if top then
    return __mauiDispatch(top, event)
  end
  return false
end

-- =====================================================================
-- Dragger — die Maus-Erfassung der Engine.
--
-- JEDER Button-Klick der Original-UI laeuft darueber (button.lua:120-160):
--   ButtonPress -> Dragger() -> PostDragger(rootFrame, event.KeyCode, dragger)
--   Loslassen   -> die Engine ruft dragger:OnRelease(x, y) -> dort erst OnClick
-- Ohne Dragger gibt es also NIE ein OnClick — kein Bau-Modus, kein Order-Button,
-- kein Menue-Knopf. (Genau daran starb der Klick aufs Bau-Icon: er fiel durch die
-- UI hindurch, wurde als Klick in die Welt gewertet, und die ACU verlor ihre
-- Auswahl.)
--
-- Semantik aus der Decomp:
--   PostDragger(originFrame, keycode, dragger)  @0x78E210, Hilfetext:
--     "Make 'dragger' the active dragger from a particular frame. You can pass
--      nil to cancel the current dragger."
--   CMauiLuaDragger::OnMove/OnRelease  (Cfile:1130393/1130403) rufen die
--     Lua-Methoden mit der MAUSPOSITION (mMousePos.x/.y),
--   CMauiLuaDragger::OnCancel (Cfile:1130413) ohne Argumente.
--
-- Solange ein Dragger aktiv ist, gehen Bewegung und Loslassen an IHN, nicht an
-- den maui-Baum — er hat die Maus erfasst.
-- =====================================================================
__mauiDragger = false
__mauiDraggerKey = 0

function InternalCreateDragger(luaobj)
  luaobj.__isDragger = true
  return luaobj
end

function PostDragger(originFrame, keycode, dragger)
  if not dragger then
    -- nil bricht den laufenden Dragger ab (Hilfetext @0x78E210).
    local old = __mauiDragger
    __mauiDragger = false
    if old and old.OnCancel then old:OnCancel() end
    return
  end
  __mauiDragger = dragger
  __mauiDraggerKey = keycode or 0
end

-- Ein Dragger ist KEIN Control: er wird ueber moho.dragger_methods erzeugt und
-- raeumt sich selbst weg (dragger.lua:15 OnRelease -> self:Destroy()).
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
