# maui-Controls — das Widget-Substrat der C++-Engine

Was die Engine unter `lua/maui/*.lua` und `lua/ui/**` legt, was davon fehlt, und in
welcher Reihenfolge es gebaut wird. Ergänzt [engine-api.md](engine-api.md) (Liste aller
Bindungen je VM) und [frontend-menu.md](frontend-menu.md) (Boot-Kette des Hauptmenüs);
hier geht es nur um die **Controls, Events und den Fokus/Capture-Pfad**.

## 1. Überblick

Die Engine liefert für die UI genau vier Dinge — mehr nicht:

1. **LazyVars**, die der C++-Ctor ins Lua-Table hängt.
2. **`InternalCreate*`-Globals**, die das C++-Peer-Objekt an eine Lua-Tabelle heften
   und am Ende `DoInit` rufen (`CMauiControl::DoInit` @0x786E90, Cfile:1124190 =
   `RunScript(this, "OnInit")` → `control.lua:42`).
3. **Methoden** der Basisklassen (`moho.<x>_methods`).
4. **Events**: Hit-Test → `HandleEvent` die Eltern-Kette hoch; Tastatur über
   Fokus-Control bzw. Capture-Stack.

Alles andere (Button, Checkbox, Slider, Grid, Window, MultiLineText, Combo, SpecialGrid,
StatusBar, RadioButtons) ist **reine Original-Lua** auf Bitmap/Group/Text — kein
Engine-Teil, nichts zu bauen.

### Die vollständige LazyVar-Tabelle (grep `mLuaObj, "` über die Decomp)

Es gibt **genau 17** engine-gesetzte LazyVars. Kein anderes Control bekommt welche —
Edit, ItemList, Scrollbar, MapPreview, Histogram und Mesh haben **null** eigene.

| Klasse | LazyVars | Beleg |
|---|---|---|
| `CMauiControl` | `Left, Right, Top, Bottom, Width, Height, Depth` | Cfile:1123966-1123972 |
| `CMauiBitmap` | `BitmapWidth, BitmapHeight` (aus der Texturgröße) | Cfile:1118538-1118539 |
| `CMauiBorder` | `BorderWidth, BorderHeight` (aus der Texturgröße, gesetzt in `SetNewTextures`) | Cfile:1122575-1122576, Schreibstellen 1122728/1122748 |
| `CMauiMovie` | `MovieWidth, MovieHeight` | Cfile:1142984-1142985 |
| `CMauiText` | `TextAdvance, FontAscent, FontDescent, FontExternalLeading` | Cfile:1145927-1145930 |

Der Ctor gibt jedem Control außerdem seinen **Kind-Namen** (2. Arg von
`CMauiControl::CMauiControl`): `"bitmap"`, `"border"` (Cfile:1122554), `"text"`,
`"group"`, `"frame"`, `"edit"`, `"itemlist"`, `"scrollbar"`, `"movie"`,
`"mappreview"` (Cfile:1276205).

## 2. Ablauf/Callchain

### 2.1 Erzeugung

`Bitmap(parent)` → `InternalCreateBitmap(self, parent)` → C++ `new CMauiBitmap` →
Ctor hängt LazyVars an `self` → `DoInit` → `self:OnInit()` (control.lua:42) baut die
zirkuläre Layout-Kette. **Identisch für jedes Control** — nur `InternalCreateScrollbar`
hat ein drittes Argument.

| Global | Signatur (mHelp) | Beleg |
|---|---|---|
| `InternalCreateFrame` | `(luaobj)` | Cfile:1136870 |
| `InternalCreateGroup` | `(luaobj,parent)` | Cfile:1137472 |
| `InternalCreateBitmap` | `(luaobj,parent)` | Cfile:1119522 |
| `InternalCreateText` | `(luaobj,parent)` | Cfile:1146214 |
| `InternalCreateBorder` | `(luaobj,parent)` | Cfile:1123080 |
| `InternalCreateDragger` | `(luaobj)` | Cfile:1130486 |
| `InternalCreateEdit` | `(luaobj,parent)` | Cfile:1133710 |
| `InternalCreateItemList` | `(luaobj,parent)` | Cfile:1140074 |
| `InternalCreateScrollbar` | `(luaobj,parent,axis)` — `axis` ist der **Lexical-String** der `EMauiScrollAxis` (`"Vert"`/`"Horz"`, scrollbar.lua:9-12), Konvertierung Cfile:1144789 | Cfile:1144735 |
| `InternalCreateMovie` | `(luaobj,parent)` | Cfile:1143260 |
| `InternalCreateMapPreview` | `(luaobj,parent)` | Cfile:1276475 |
| `InternalCreateHistogram` | `(luaobj,parent)` | Cfile:1137793 |
| `InternalCreateMesh` | `(luaobj,parent)` | Cfile:1142596 |
| `InternalCreateWorldMesh` | `(luaobj)` — kein Control | Cfile:1296231 |
| `InternalCreateWldUIProvider` | `(luaobj)` — kein Control | Cfile:1295462 |
| `InternalCreateDiscoveryService` | `(class)` — MP | Cfile:1168381 |
| `InternalCreateLobby` | `(class, protocol, localPort, maxConnections, …)` — MP | Cfile:1168970 |

### 2.2 Maus

`CMauiControl::GetTopmostControl` (Cfile:1124492-1124512) läuft **jeden**
Nachkommen der Wurzel per `DepthFirstSuccessor` ab und nimmt den mit dem **größten
`mDepth`**, der (a) nicht versteckt, (b) nicht Hit-Test-deaktiviert ist und (c) dessen
**virtuelles** `HitTest(x,y)` trifft (Basis = Rechteck, Cfile:1126279; `CMauiBitmap`
überschreibt es bei `UseAlphaHitTest(bool)`, Cfile:1120035).

Es gibt **kein „zeichnet etwas"-Kriterium** — eine leere Group wird getroffen wie
alles andere. Dass die Vollbild-Container im Original trotzdem keinen Klick fressen,
liegt allein daran, dass die **Weltansicht selbst ein Control ist** (`CUIWorldView` in
`mapGroup`, erzeugt in gamemain.lua:142) und über ihnen in der Tiefe liegt.

Danach `CMauiControl::PostEvent` (Cfile:1124517-1124536): `HandleEvent` auf dem
getroffenen Control; liefert es `false`, geht dasselbe Event die **Eltern**-Kette hoch.

**Die Wurzel des Hit-Tests ist nicht immer der Root-Frame:** ist der Capture-Stack
nicht leer, startet `GetTopmostControl` bei `sInputCapture.back()` (Cfile:1147376-1147390).
Genau das macht `uiutil.MakeInputModal` (uiutil.lua:615-620) modal.

### 2.3 Tastatur — Fokus schlägt Capture

Drei Dispatcher, einer je Event-Typ (`MET_KeyUp`=9 Cfile:1147668, `MET_KeyDown`=10
Cfile:1147634, `MET_Char`=11 Cfile:1147745). Alle drei identisch aufgebaut:

1. `Moho::Maui_CurrentFocusControl` gesetzt? → **nur** dieses Control bekommt
   `HandleEvent`. Liefert es `true`, ist Schluss; sonst wird das Event auf
   `skipped = 1` gesetzt (→ Konsolen-Keymap) — der Capture-Stack wird **nicht** gefragt.
2. Kein Fokus-Control, Capture-Stack nicht leer? → `sInputCapture.back()` bekommt es.
3. Sonst: `skipped = 1`.

Fokus wird per `Control:AcquireKeyboardFocus(bool blocksKeyDown)` (Cfile:1125768) /
`Control:AbandonKeyboardFocus()` (Cfile:1125828) gesetzt; `GetCurrentFocusControl()`
(Cfile:1125718) liest den globalen Singleton.

`MET_Char` gibt es bei uns **noch gar nicht** — das ist der Kanal, über den ein Edit
seinen Text bekommt (`CMauiEdit::HandleEvent` @0x790470, Cfile:1132299-1132317:
ButtonPress/DClick → `HandleClickEvent`, `MET_Char` → `HandleKeyEvent`; **gibt immer 0
zurück**, ein Edit „verbraucht" das Event also nie).

**Event-Enum** (`Moho::EMauiEventTypeTypeInfo::AddEnums`, Cfile:1136267-1136288,
Prefix `MET_`): `MouseMotion`=1, `MouseEnter`=2, **`MouseHover`=3**, `MouseExit`=4,
`ButtonPress`=5, `ButtonDClick`=6, `ButtonRelease`=7, `WheelRotation`=8, `KeyUp`=9,
`KeyDown`=10, `Char`=11.

### 2.4 Input-Capture-Stack (`sInputCapture`, ein `std::vector`)

| Global | Semantik | Beleg |
|---|---|---|
| `AddInputCapture(control)` | push_back | Cfile:1147871 / 1147900 |
| `RemoveInputCapture(control)` | „always first from back" — entfernt das **hinterste** passende Element | Cfile:1147921, Impl 1147071-1147118 |
| `GetInputCapture()` | `back()` oder nil | Cfile:1147818 |
| `AnyInputCapture()` | `size() ~= 0` | Cfile:1147773 |

Nutzer: uiutil.lua:616/620 (`MakeInputModal` → jeder Dialog), splash.lua:30/49,
score.lua:274, shareresources.lua:150, keybindings.lua:239, connectivity.lua:99,
objectivedetail.lua:470, transmissionlog.lua:246, campaignmovies.lua:61, missiontext.lua:405.

### 2.5 Das Scrollable-Protokoll ist Lua, nicht C++

`CMauiScrollbar` rendert und rechnet nur; die Daten holt es per `RunScript` aus dem
**Lua-Objekt**, das `SetScrollable()` bekommen hat — die Callsites stehen in
`CMauiControl`: `GetScrollValues` (Cfile:1124664, MultiRet), `ScrollLines`
(Cfile:1124731/1124753), `ScrollSetTop` (Cfile:1124775). Signaturen aus der Original-Lua
(filepicker.lua:292-312, createunit.lua:558-578, keybindings.lua:318-334):

```
GetScrollValues(axis) -> rangeMin, rangeMax, visibleMin, visibleMax
ScrollLines(axis, delta)      ScrollPages(axis, delta)      ScrollSetTop(axis, top)
```

Ein Scrollbar braucht also **kein** eigenes Layoutwissen — nur Thumb-Geometrie,
Maus-Drag und diese vier Aufrufe. `Scrollbar:DoScrollLines/DoScrollPages` (Bindungen)
sind die Gegenrichtung (Buttons/Mausrad → Scrollable).

### 2.6 Was die Engine in die Lua zurückruft (`RunScript`, Bereich Cfile:1118000-1150000)

| Klasse | Callbacks |
|---|---|
| `CMauiControl` | `OnInit`, `HandleEvent`, `OnFrame`, `OnDestroy`, `GetScrollValues`/`ScrollLines`/`ScrollSetTop` |
| `CMauiEdit` | `OnEnterPressed(text)` (Cfile:1132320), `OnEscPressed(text)` (Cfile:1132327), `OnNonTextKeyPressed`, `OnLoseKeyboardFocus`, `OnFrame` |
| `CMauiItemList` | `OnClick`, `OnDoubleClick`, `OnKeySelect`, `OnMouseoverItem` |
| `CMauiMovie` | `OnStopped`, `OnFinished`, `OnSubtitle`, `OnFrame` |
| `CMauiLuaDragger` | `OnMove(x,y)`, `OnRelease(x,y)`, `OnCancel()` (Cfile:1130393-1130413) |

## 3. Fehlende Engine-Bindungen

| Bindung | Semantik (Decomp) | Beleg | gebraucht von |
|---|---|---|---|
| `InternalCreateMovie` + `moho.movie_methods` (7: `InternalSet`, `IsLoaded`, `Play`, `Stop`, `Loop`, `GetFrameRate`, `GetNumFrames`) + LazyVars `MovieWidth/MovieHeight` | `bool Movie:InternalSet(filename)`; `movie.lua:20-24` bindet Width/Height an die LazyVars | Cfile:1143260, 1143337, 1142984 | **main.lua:35 (`CreateBackMovie`)**, main.lua:152/829, splash.lua:32, gamemain.lua:206 (Ladebildschirm), credits.lua:28, missiontext.lua:84/382 |
| `InternalCreateEdit` + `moho.edit_methods` (31) | Textfeld; Text-Editing liegt **in C++** (`HandleKeyEvent` auf `MET_Char`) | Cfile:1133710; Methoden-Helps 1133786-1135522 | chat.lua:601, ping.lua:80, rename.lua:29, construction.lua:1022 (Template-Menü), lobby.lua, console.lua, createunit.lua, filepicker.lua:156 |
| `InternalCreateItemList` + `moho.item_list_methods` (19) | Zeilenliste mit eigener Selektion/Scroll; `GetRowHeight`, `NeedsScrollBar` | Cfile:1140074, Helps 1140151-1141154 | **combo.lua:117 → jedes Dropdown**, uiutil.lua:931, helptext.lua:98/146, eula.lua:47, mapselect.lua, score.lua, chat.lua |
| `InternalCreateScrollbar` + `moho.scrollbar_methods` (4: `SetScrollable`, `SetNewTextures`, `DoScrollLines`, `DoScrollPages`) | siehe 2.5 | Cfile:1144735, 1144824, 1144886 | uiutil.lua (`CreateVertScrollbar`/`CreateHorzScrollbar`, ~580-611), console, mapselect, modmanager, gameselect |
| `InternalCreateMapPreview` + `moho.ui_map_preview_methods` (3: `SetTexture`, `SetTextureFromMap`, `ClearTexture`) | rendert eine Karten-Vorschautextur | Cfile:1276475, 1276552-1276672 | mappreview.lua:8 → mapselect.lua, lobby.lua |
| `moho.border_methods` (2: `SetNewTextures(vertical, horizontal, upperLeft, upperRight, lowerLeft, lowerRight)`, `SetSolidColor(color)`) | setzt dabei `BorderWidth/BorderHeight` aus den Texturmaßen | Cfile:1123156, 1123475; LV-Schreibstellen 1122728/1122748 | border.lua:28-42, window.lua, jeder Panel-Rahmen |
| `AddInputCapture` / `RemoveInputCapture` / `GetInputCapture` / `AnyInputCapture` | Capture-Stack, siehe 2.4 | Cfile:1147871/1147921/1147818/1147773 | uiutil.lua:616 (**alle Dialoge**), splash.lua:30 |
| `Control:AcquireKeyboardFocus(bool)` / `AbandonKeyboardFocus()` / `GetCurrentFocusControl()` | globaler Fokus-Singleton, siehe 2.3 | Cfile:1125768/1125828/1125718 | edit.lua (`AcquireFocus`), construction.lua:1026, chat.lua |
| `Control:HitTest(x,y)` / `ApplyFunction(func)` / `Bitmap:UseAlphaHitTest(bool)` | Cfile:1126279 / 1126220 / 1120035 | | worldview, tooltip, uiutil |
| `ClearFrame(head)` | „destroy all controls in frame, nil head will clear all frames" | Cfile:1264066 | uimain beim VM-Wechsel |
| `IsKeyDown(keyCode)`, `KeycodeMauiToMSW`, `KeycodeMSWToMaui`, `IN_AddKeyMapTable`, `FlushEvents` | Tastatur-Peripherie | Cfile:1141963 / 1142018 / 1142071 / 1259962 / 1274594 | keymap, construction (Shift/Ctrl), main.lua:992 |
| `InternalCreateHistogram` (`moho.hostogram_methods` — **Tippfehler steht so im Original**, histogram.lua:19), `InternalCreateMesh` | von **keiner** `lua/ui/**`-Datei instanziiert | Cfile:1137793 / 1142596 | — (nur `lua/maui/*.lua` selbst) |
| `InternalCreateWorldMesh` (16 Methoden), `InternalCreateWldUIProvider`, `CUIWorldView` (17), `ScriptedDecal`, `CPathDebugger` | Welt-Seite | Cfile:1296231 / 1295462 | worldview.lua:96, worldmesh.lua:26, rallypoint.lua:24 → gehört zu [worldview-camera.md](worldview-camera.md) |
| `CLobby` (18), `CDiscoveryService` (3) | Multiplayer | Cfile:1168970 / 1168381 | lobby.lua, gameselect.lua |

**Tote Importe** (importieren ein Control, erzeugen es aber nie — kein Grund, sie zu
bauen): specialgrid.lua:9 (`ItemList`), unitviewdetail.lua:7 + die drei
`unitviewdetail_*`-Layouts (`ItemList`), tooltip.lua (`Edit`). Das Bau-Grid ist eine
`SpecialGrid` aus Bitmaps — **kein ItemList**.

## 4. Ist-Stand

**Da** ([maui.lua](../../src/engine-lua/maui.lua), [moho.lua](../../src/engine-lua/moho.lua)):
`InternalCreateFrame/Group/Bitmap/Text/Border/Dragger`, die 7 + 2 + 2 + 4 LazyVars,
`DoInit→OnInit`, Maus-Dispatch mit Eltern-Bubbling, Dragger-Maus-Erfassung,
Frame-Pumpe, Snapshot. `control_methods` (25), `bitmap_methods` (18), `text_methods` (9),
`frame_methods` (3), `cursor_methods` (5).

**Fehlt oder ist falsch:**

1. **`moho.border_methods` existiert nicht.** `InternalCreateBorder` legt zwar
   `BorderWidth/BorderHeight` an (maui.lua:474-480), aber der Auto-Vivifier in
   moho.lua:530-536 liefert für `moho.border_methods` eine **leere Klasse** →
   `SetNewTextures`/`SetSolidColor` sind `nil`, und border.lua:28 knallt, sobald jemand
   eine Textur setzt. Der Border ist halb gebaut.
2. **Kein Tastatur-Pfad.** `__mauiMouse`/`__mauiWheel` gibt es, aber weder `KeyDown`/
   `KeyUp`/`Char` noch Fokus noch Capture-Stack. Damit ist jeder modale Dialog offen,
   jedes Edit taub, und `AcquireKeyboardFocus` wirft aus ui-globals-missing.lua.
3. **Der Hit-Test filtert auf `draws()`** (maui.lua:225-235/320-334): nur Bitmap und Text
   werden getroffen. Die Engine testet **jedes** sichtbare Control per Rechteck
   (Cfile:1124492). Der Filter ist ein bewusster Ersatz dafür, dass die Weltansicht bei
   uns kein Control ist — er muss fallen, sobald `CUIWorldView` steht, sonst frisst die
   Welt-Group nichts und die Mini-Map-Fenster nehmen keine Klicks an.
4. **Der Renderer kennt zwei Kinds** (mauiRenderer.ts:95/103: `bitmap`, `text`). Für
   Border, Edit, ItemList, Scrollbar, Movie, MapPreview gibt es keinen Zeichenpfad.
5. **Kein `MouseHover` (=3)** — der Typ existiert, wir erzeugen ihn nie. Tooltips hängen
   im Original an einem eigenen Timer (tooltip.lua), das ist also nur ein Vermerk.
6. **`GetTopmostDepth` liefert 5000000** (moho.lua:522) — erfunden. Die echte Bindung
   steht Cfile:1136937 (`float GetTopmostDepth()`), Wert ungeprüft.

## 5. Bau-Reihenfolge

| # | Schritt | Verifikation |
|---|---|---|
| 1 | **`moho.border_methods`** (2 Methoden) + `BorderWidth/BorderHeight` aus `GetTextureDimensions` + `border`-Kind im Renderer (9-Slice aus 6 Texturen). | headless: `Border(group)` + `SetTextures` → Snapshot enthält 8 Kacheln; `BorderWidth()` == Breite der `vertical`-DDS. Panels (`borders.lua`) bekommen ihre Rahmen zurück. |
| 2 | **Tastatur-Substrat**: `__mauiKey(type, keyCode, rawKeyCode, mods)` mit der Reihenfolge aus 2.3 (Fokus → sonst Capture-Spitze → sonst „skipped"), `MET_Char` als eigener Typ; `AcquireKeyboardFocus/AbandonKeyboardFocus/GetCurrentFocusControl`. | headless: zwei Controls, eines mit Fokus → nur dieses sieht `KeyDown`; gibt es `false` zurück, sieht es **niemand** sonst. |
| 3 | **Capture-Stack**: `AddInputCapture/RemoveInputCapture/GetInputCapture/AnyInputCapture` + Hit-Test-Wurzel = `back()` (Cfile:1147380). | headless: `UIUtil.MakeInputModal(dialog)`, dann `__mauiHitTest` auf einen Punkt außerhalb → liefert nichts aus dem Rest des Baums. |
| 4 | **`CMauiEdit`**: `InternalCreateEdit`, `edit_methods` (31), Text-Editing in der Engine (Caret, MaxChars, Highlight), `OnEnterPressed`/`OnEscPressed`/`OnNonTextKeyPressed`/`OnLoseKeyboardFocus`, `edit`-Kind im Renderer. Setzt 2+3 voraus. | headless: `rename.lua`-Dialog erzeugen, `MET_Char`-Folge einspeisen, `GetText()` prüfen, Enter → `OnEnterPressed` mit dem Text. |
| 5 | **`CMauiMovie`**: `InternalCreateMovie`, `movie_methods`, `MovieWidth/MovieHeight`, `OnStopped/OnFinished`. Format ist **CRI Sofdec** (`.sfd`: MPEG-1-Video + ADX-Audio; Symbole `MWSFD_*`, `mwsfsfx_*`, `struct_sofdec_ply`, Cfile:44063-44075; `Moho::CMovie::GetWidth/GetHeight` Cfile:29109-29110). | headless: `main.lua:CreateBackMovie(GetFrame(0))` → Movie im Snapshot, `Width == 1824 * (H/1024)` (main.lua:43-46). Browser: Hauptmenü mit laufendem Hintergrund. |
| 6 | **`CMauiItemList`** (19) — freischalten von `combo.lua` und damit **jedem Dropdown**. | headless: `Combo(parent, {…})` → `GetItemCount()`, `OnClick` setzt die Selektion; `mapselect.lua` lädt ohne Fehler. |
| 7 | **`CMauiScrollbar`** (4) + Scrollable-Protokoll (`GetScrollValues`/`ScrollLines`/`ScrollPages`/`ScrollSetTop`) auf `control_methods`. | headless: `UIUtil.CreateVertScrollbar(list)` → Mausrad ruft `ScrollLines(axis, delta)` auf dem Scrollable. |
| 8 | **`CUIMapPreview`** (3) — Kartenauswahl. | headless: `MapPreview(parent):SetTextureFromMap(scenario)` → Textur im Snapshot. |
| 9 | **`CUIWorldView`** — eigenes Thema ([worldview-camera.md](worldview-camera.md)); danach den `draws()`-Filter aus dem Hit-Test entfernen (Punkt 4.3). | `gamemain.lua:142` läuft; Klick in die freie Fläche trifft die WorldView, nicht die Screen-Group. |

**Nicht bauen:** Histogram, Mesh (von keiner UI-Datei instanziiert), Lobby/DiscoveryService
(MP), bis es einen Anlass gibt.

**Blockade-Bild:** Für die **Session-UI** fehlt **kein einziges** maui-Control auf dem
kritischen Pfad — Economy, Orders, Construction, UnitView bestehen aus Group/Bitmap/Text/
Border/Dragger. Was dort fehlt, ist die **WorldView** und der **Tastatur-Pfad**.
Das **Hauptmenü** hängt an genau einem Control: **Movie** (main.lua:35). Der Weg
Hauptmenü → Skirmish → Session braucht zusätzlich **ItemList** (Combo), **Scrollbar**
und **MapPreview**.

## 6. Offene Fragen

- **Sofdec im Browser.** `.sfd` ist MPEG-1-Video + CRI-ADX-Audio. Ein JS/WASM-Decoder ist
  machbar, aber Aufwand. Ein „schwarzes Rechteck statt Video" wäre ein Stub im
  Produktivpfad (verboten). Zwischenweg: `InternalSet` liefert `false`, wenn kein Decoder
  angeschlossen ist — das **ist** ein echter Engine-Pfad (movie.lua:50-53 ruft dann
  `OnStopped()`), aber es ist eine Lüge, solange die Datei lesbar wäre. Entscheidung nötig.
- **`AcquireKeyboardFocus(bool blocksKeyDown)`**: Das Flag landet in einem Feld
  (Cfile:1125768-1125790); **wo** es ausgelesen wird, ist nicht nachverfolgt. Vermutlich
  entscheidet es, ob ein nicht behandeltes `KeyDown` zum Keymap durchfällt.
- **`ScrollPages`**: In der Decomp finden sich `RunScript`-Callsites für
  `GetScrollValues`, `ScrollLines` (2×) und `ScrollSetTop` — für `ScrollPages` keine.
  Entweder IDA-String-Aliasing an Cfile:1124753, oder die Engine ruft nur `ScrollLines`.
  Die Lua-Seite implementiert `ScrollPages` jedenfalls (filepicker.lua:307).
- **`GetTopmostDepth()`** (Cfile:1136937): echter Rückgabewert nicht gelesen; unser 5000000
  ist geraten.
- **`CMauiItemList` mit eigenem Scroll**: `NeedsScrollBar`, `ShowMouseoverItem`,
  `ShowSelection` — ob die Liste ihren Scroll selbst rendert oder zwingend eine externe
  Scrollbar braucht, ist nicht geprüft.
- **`CMauiEdit`-Textmodell**: Selektion/Highlight (`SetNewHighlight*Color`) und
  `SetCaretCycle(seconds, minAlpha, maxAlpha)` liegen komplett in C++
  (`CMauiEdit::HandleKeyEvent`). Für einen originalgetreuen Nachbau muss diese Funktion
  gelesen werden — noch nicht getan.
