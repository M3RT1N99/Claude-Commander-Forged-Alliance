# maui-Controls — the widget substrate of the C++ engine

What the engine puts under `lua/maui/*.lua` and `lua/ui/**`, what is missing from it, and in
what order it is built. Adds [engine-api.md](engine-api.md) (list of all
Bindings per VM) and [frontend-menu.md](frontend-menu.md) (main menu boot chain);
This is just about the **controls, events and the focus/capture path**.

## 1. Überblick

The engine delivers exactly four things for the UI — nothing more:

1. **LazyVars**, which the C++ processor attaches to the Lua table.
2. **`InternalCreate*`-Globals** that pin the C++ peer object to a Lua table
   and at the end call `DoInit` (`CMauiControl::DoInit` @0x786E90, Cfile:1124190 =
   `RunScript(this, "OnInit")` → `control.lua:42`).
3. **Methods** of the base classes (`moho.<x>_methods`).
4. **Events**: Hit test → `HandleEvent` up the parent chain; Keyboard over
   Fokus-Control bzw. Capture-Stack.

Everything else (Button, Checkbox, Slider, Grid, Window, MultiLineText, Combo, SpecialGrid,
StatusBar, RadioButtons) is **pure original Lua** on Bitmap/Group/Text — none
Engine part, nothing to build.

### The full LazyVar table (grep `mLuaObj, "` via decomp)

There are **exactly 17** engine-set LazyVars. No other control gets any -
Edit, ItemList, Scrollbar, MapPreview, Histogram and Mesh have **zero** of their own.

| class | LazyVars | receipt |
|---|---|---|
| `CMauiControl` | `Left, Right, Top, Bottom, Width, Height, Depth` | Cfile:1123966-1123972 |
| `CMauiBitmap` | `BitmapWidth, BitmapHeight` (from texture size) | Cfile:1118538-1118539 |
| `CMauiBorder` | `BorderWidth, BorderHeight` (from texture size, set in `SetNewTextures`) | Cfile:1122575-1122576, writing points 1122728/1122748 |
| `CMauiMovie` | `MovieWidth, MovieHeight` | Cfile:1142984-1142985 |
| `CMauiText` | `TextAdvance, FontAscent, FontDescent, FontExternalLeading` | Cfile:1145927-1145930 |

The Ctor also gives each control its **child name** (2nd Arg of
`CMauiControl::CMauiControl`): `"bitmap"`, `"border"` (Cfile:1122554), `"text"`,
`"group"`, `"frame"`, `"edit"`, `"itemlist"`, `"scrollbar"`, `"movie"`,
`"mappreview"` (Cfile:1276205).

## 2. Ablauf/Callchain

### 2.1 Erzeugung

`Bitmap(parent)` → `InternalCreateBitmap(self, parent)` → C++ `new CMauiBitmap` →
Ctor attaches LazyVars to `self` → `DoInit` → `self:OnInit()` (control.lua:42) builds the
circular layout chain. **Identical for every control** — only `InternalCreateScrollbar`
has a third argument.

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
| `InternalCreateScrollbar` | `(luaobj,parent,axis)` — `axis` is the **lexical string** of the `EMauiScrollAxis` (`"Vert"`/`"Horz"`, scrollbar.lua:9-12), conversion Cfile:1144789 | Cfile:1144735 |
| `InternalCreateMovie` | `(luaobj,parent)` | Cfile:1143260 |
| `InternalCreateMapPreview` | `(luaobj,parent)` | Cfile:1276475 |
| `InternalCreateHistogram` | `(luaobj,parent)` | Cfile:1137793 |
| `InternalCreateMesh` | `(luaobj,parent)` | Cfile:1142596 |
| `InternalCreateWorldMesh` | `(luaobj)` — no control | Cfile:1296231 |
| `InternalCreateWldUIProvider` | `(luaobj)` — no control | Cfile:1295462 |
| `InternalCreateDiscoveryService` | `(class)` — MP | Cfile:1168381 |
| `InternalCreateLobby` | `(class, protocol, localPort, maxConnections, …)` — MP | Cfile:1168970 |

### 2.2 Maus

`CMauiControl::GetTopmostControl` (Cfile:1124492-1124512) runs **every**
Descendants of the root via `DepthFirstSuccessor` and takes the one with the **largest
`mDepth`** that is (a) not hidden, (b) not hit-test disabled, and (c) whose
**virtuelles** `HitTest(x,y)` trifft (Basis = Rechteck, Cfile:1126279; `CMauiBitmap`
overwrites it at `UseAlphaHitTest(bool)`, Cfile:1120035).

There is **no "draw something" criterion** — an empty Group is hit like
everything else. The fact that the full-screen containers in the original still don't eat up a click,
is solely because the **world view itself is a control** (`CUIWorldView` in
`mapGroup`, created in gamemain.lua:142) and lies above them in the depth.

Then `CMauiControl::PostEvent` (Cfile:1124517-1124536): `HandleEvent` on the
hit control; If it delivers `false`, the same event goes up the **parent** chain.

**The root of the hit test is not always the root frame:** is the capture stack
not empty, starts `GetTopmostControl` at `sInputCapture.back()` (Cfile:1147376-1147390).
This is exactly what makes `uiutil.MakeInputModal` (uiutil.lua:615-620) modal.

### 2.3 Keyboard — Focus beats capture

Three dispatchers, one per event type (`MET_KeyUp`=9 Cfile:1147668, `MET_KeyDown`=10
Cfile:1147634, `MET_Char`=11 Cfile:1147745). All three are constructed identically:

1. `Moho::Maui_CurrentFocusControl` set? → **only** gets this control
   `HandleEvent`. If it delivers `true`, it's over; otherwise the event will be canceled
   `skipped = 1` set (→ console keymap) — the capture stack is **not** asked.
2. No focus control, capture stack not empty? → `sInputCapture.back()` gets it.
3. Otherwise: `skipped = 1`.

Focus is set via `Control:AcquireKeyboardFocus(bool blocksKeyDown)` (Cfile:1125768) /
`Control:AbandonKeyboardFocus()` (Cfile:1125828) set; `GetCurrentFocusControl()`
(Cfile:1125718) reads the global singleton.

We don't have `MET_Char` **yet** - that's the channel through which an edit
gets its text (`CMauiEdit::HandleEvent` @0x790470, Cfile:1132299-1132317:
ButtonPress/DClick → `HandleClickEvent`, `MET_Char` → `HandleKeyEvent`; **always returns 0
back**, so an edit never “consumes” the event).

**Event-Enum** (`Moho::EMauiEventTypeTypeInfo::AddEnums`, Cfile:1136267-1136288,
Prefix `MET_`): `MouseMotion`=1, `MouseEnter`=2, **`MouseHover`=3**, `MouseExit`=4,
`ButtonPress`=5, `ButtonDClick`=6, `ButtonRelease`=7, `WheelRotation`=8, `KeyUp`=9,
`KeyDown`=10, `Char`=11.

### 2.4 Input capture stack (`sInputCapture`, a `std::vector`)

| Global | Semantik | Beleg |
|---|---|---|
| `AddInputCapture(control)` | push_back | Cfile:1147871 / 1147900 |
| `RemoveInputCapture(control)` | "always first from back" — removes the **backmost** matching element | Cfile:1147921, Impl 1147071-1147118 |
| `GetInputCapture()` | `back()` or nil | Cfile:1147818 |
| `AnyInputCapture()` | `size() ~= 0` | Cfile:1147773 |

User: uiutil.lua:616/620 (`MakeInputModal` → every dialog), splash.lua:30/49,
score.lua:274, shareresources.lua:150, keybindings.lua:239, connectivity.lua:99,
objectivedetail.lua:470, transmissionlog.lua:246, campaignmovies.lua:61, missiontext.lua:405.

### 2.5 The scrollable protocol is Lua, not C++

`CMauiScrollbar` only renders and calculates; It gets the data from the using `RunScript`
**Lua object** that got `SetScrollable()` — the call sites are in
`CMauiControl`: `GetScrollValues` (Cfile:1124664, MultiRet), `ScrollLines`
(Cfile:1124731/1124753), `ScrollSetTop` (Cfile:1124775). Signatures from the original Lua
(filepicker.lua:292-312, createunit.lua:558-578, keybindings.lua:318-334):

```
GetScrollValues(axis) -> rangeMin, rangeMax, visibleMin, visibleMax
ScrollLines(axis, delta)      ScrollPages(axis, delta)      ScrollSetTop(axis, top)
```

So a scrollbar needs **no** own layout knowledge — just thumb geometry,
Mouse drag and these four calls. `Scrollbar:DoScrollLines/DoScrollPages` (bindings)
are the opposite direction (buttons/mouse wheel → scrollable).

### 2.6 What the engine calls back to the Lua (`RunScript`, range Cfile:1118000-1150000)

| class | Callbacks |
|---|---|
| `CMauiControl` | `OnInit`, `HandleEvent`, `OnFrame`, `OnDestroy`, `GetScrollValues`/`ScrollLines`/`ScrollSetTop` |
| `CMauiEdit` | `OnEnterPressed(text)` (Cfile:1132320), `OnEscPressed(text)` (Cfile:1132327), `OnNonTextKeyPressed`, `OnLoseKeyboardFocus`, `OnFrame` |
| `CMauiItemList` | `OnClick`, `OnDoubleClick`, `OnKeySelect`, `OnMouseoverItem` |
| `CMauiMovie` | `OnStopped`, `OnFinished`, `OnSubtitle`, `OnFrame` |
| `CMauiLuaDragger` | `OnMove(x,y)`, `OnRelease(x,y)`, `OnCancel()` (Cfile:1130393-1130413) |

## 3. Missing engine bindings

| Binding | Semantics (Decomp) | receipt | used by |
|---|---|---|---|
| `InternalCreateMovie` + `moho.movie_methods` (7: `InternalSet`, `IsLoaded`, `Play`, `Stop`, `Loop`, `GetFrameRate`, `GetNumFrames`) + LazyVars `MovieWidth/MovieHeight` | `bool Movie:InternalSet(filename)`; `movie.lua:20-24` binds Width/Height to the LazyVars | Cfile:1143260, 1143337, 1142984 | **main.lua:35 (`CreateBackMovie`)**, main.lua:152/829, splash.lua:32, gamemain.lua:206 (loading screen), credits.lua:28, missiontext.lua:84/382 |
| `InternalCreateEdit` + `moho.edit_methods` (31) | textfield; Text editing is **in C++** (`HandleKeyEvent` on `MET_Char`) | Cfile:1133710; Method Helps 1133786-1135522 | chat.lua:601, ping.lua:80, rename.lua:29, construction.lua:1022 (template menu), lobby.lua, console.lua, createunit.lua, filepicker.lua:156 |
| `InternalCreateItemList` + `moho.item_list_methods` (19) | Line list with own selection/scroll; `GetRowHeight`, `NeedsScrollBar` | Cfile:1140074, Helps 1140151-1141154 | **combo.lua:117 → any dropdown**, uiutil.lua:931, helptext.lua:98/146, eula.lua:47, mapselect.lua, score.lua, chat.lua |
| `InternalCreateScrollbar` + `moho.scrollbar_methods` (4: `SetScrollable`, `SetNewTextures`, `DoScrollLines`, `DoScrollPages`) | siehe 2.5 | Cfile:1144735, 1144824, 1144886 | uiutil.lua (`CreateVertScrollbar`/`CreateHorzScrollbar`, ~580-611), console, mapselect, modmanager, gameselect |
| `InternalCreateMapPreview` + `moho.ui_map_preview_methods` (3: `SetTexture`, `SetTextureFromMap`, `ClearTexture`) | renders a map preview texture | Cfile:1276475, 1276552-1276672 | mappreview.lua:8 → mapselect.lua, lobby.lua |
| `moho.border_methods` (2: `SetNewTextures(vertical, horizontal, upperLeft, upperRight, lowerLeft, lowerRight)`, `SetSolidColor(color)`) | sets `BorderWidth/BorderHeight` from the texture dimensions | Cfile:1123156, 1123475; LV writing positions 1122728/1122748 | border.lua:28-42, window.lua, each panel frame |
| `AddInputCapture` / `RemoveInputCapture` / `GetInputCapture` / `AnyInputCapture` | Capture stack, see 2.4 | Cfile:1147871/1147921/1147818/1147773 | uiutil.lua:616 (**all dialogs**), splash.lua:30 |
| `Control:AcquireKeyboardFocus(bool)` / `AbandonKeyboardFocus()` / `GetCurrentFocusControl()` | globaler Fokus-Singleton, siehe 2.3 | Cfile:1125768/1125828/1125718 | edit.lua (`AcquireFocus`), construction.lua:1026, chat.lua |
| `Control:HitTest(x,y)` / `ApplyFunction(func)` / `Bitmap:UseAlphaHitTest(bool)` | Cfile:1126279 / 1126220 / 1120035 | | worldview, tooltip, uiutil |
| `ClearFrame(head)` | "destroy all controls in frame, nil head will clear all frames" | Cfile:1264066 | uimain on VM change |
| `IsKeyDown(keyCode)`, `KeycodeMauiToMSW`, `KeycodeMSWToMaui`, `IN_AddKeyMapTable`, `FlushEvents` | Keyboard peripherals | Cfile:1141963 / 1142018 / 1142071 / 1259962 / 1274594 | keymap, construction (Shift/Ctrl), main.lua:992 |
| `InternalCreateHistogram` (`moho.hostogram_methods` — **typo is in the original**, histogram.lua:19), `InternalCreateMesh` | instantiated by **no** `lua/ui/**` file | Cfile:1137793 / 1142596 | — (only `lua/maui/*.lua` itself) |
| `InternalCreateWorldMesh` (16 Methoden), `InternalCreateWldUIProvider`, `CUIWorldView` (17), `ScriptedDecal`, `CPathDebugger` | Welt-Seite | Cfile:1296231 / 1295462 | worldview.lua:96, worldmesh.lua:26, rallypoint.lua:24 → gehört zu [worldview-camera.md](worldview-camera.md) |
| `CLobby` (18), `CDiscoveryService` (3) | Multiplayer | Cfile:1168970 / 1168381 | lobby.lua, gameselect.lua |

**Dead imports** (import a control but never create it — no reason to close them
build): specialgrid.lua:9 (`ItemList`), unitviewdetail.lua:7 + the three
`unitviewdetail_*` layouts (`ItemList`), tooltip.lua (`Edit`). The construction grid is one
`SpecialGrid` from Bitmaps — **no ItemList**.

## 4. Current status

**Da** ([maui.lua](../../src/engine-lua/maui.lua), [moho.lua](../../src/engine-lua/moho.lua)):
`InternalCreateFrame/Group/Bitmap/Text/Border/Dragger`, the 7 + 2 + 2 + 4 LazyVars,
`DoInit→OnInit`, Maus-Dispatch mit Eltern-Bubbling, Dragger-Maus-Erfassung,
Frame pump, snapshot. `control_methods` (25), `bitmap_methods` (18), `text_methods` (9),
`frame_methods` (3), `cursor_methods` (5).

**Missing or incorrect:**

1. **`moho.border_methods` does not exist.** `InternalCreateBorder` does
   `BorderWidth/BorderHeight` on (maui.lua:474-480), but the Auto-Vivifier in
   moho.lua:530-536 returns an **empty class** for `moho.border_methods` →
   `SetNewTextures`/`SetSolidColor` are `nil`, and border.lua:28 pops as soon as someone
   sets a texture. The Border is half built.
2. **No keyboard path.** `__mauiMouse`/`__mauiWheel` exists, but neither `KeyDown`/
   `KeyUp`/`Char` still focus still capture stack. This means that every modal dialogue is open,
   every edit is deaf, and `AcquireKeyboardFocus` throws out ui-globals-missing.lua.
3. **The hit test filters on `draws()`** (maui.lua:225-235/320-334): bitmap and text only
   are hit. The engine tests **every** visible control via rectangle
   (Cfile:1124492). The filter is a conscious replacement for the world view
   There is no control for us - it has to fall as soon as `CUIWorldView` is standing, otherwise it will eat
   World group nothing and the mini map windows do not accept clicks.
4. **The renderer knows two children** (mauiRenderer.ts:95/103: `bitmap`, `text`). For
   Border, Edit, ItemList, Scrollbar, Movie, MapPreview there is no drawing path.
5. **No `MouseHover` (=3)** — the type exists, we never create it. Tooltips hang
   in the original it has its own timer (tooltip.lua), so that's just a note.
6. **`GetTopmostDepth` returns 5000000** (moho.lua:522) — invented. The real bond
   Cfile:1136937 (`float GetTopmostDepth()`), value unchecked.

## 5. Construction order

| # | step | Verification |
|---|---|---|
| 1 | **`moho.border_methods`** (2 methods) + `BorderWidth/BorderHeight` from `GetTextureDimensions` + `border` child in renderer (9 slice from 6 textures). | headless: `Border(group)` + `SetTextures` → Snapshot contains 8 tiles; `BorderWidth()` == Width of the `vertical`-DDS. Panels (`borders.lua`) get their frames back. |
| 2 | **Keyboard substrate**: `__mauiKey(type, keyCode, rawKeyCode, mods)` with the order from 2.3 (focus → otherwise capture tip → otherwise “skipped”), `MET_Char` as a separate type; `AcquireKeyboardFocus/AbandonKeyboardFocus/GetCurrentFocusControl`. | headless: two controls, one with focus → only this sees `KeyDown`; if it returns `false`, **no one** else will see it. |
| 3 | **Capture stack**: `AddInputCapture/RemoveInputCapture/GetInputCapture/AnyInputCapture` + hit test root = `back()` (Cfile:1147380). | headless: `UIUtil.MakeInputModal(dialog)`, then `__mauiHitTest` to a point outside → returns nothing from the rest of the tree. |
| 4 | **`CMauiEdit`**: `InternalCreateEdit`, `edit_methods` (31), text editing in the engine (caret, MaxChars, Highlight), `OnEnterPressed`/`OnEscPressed`/`OnNonTextKeyPressed`/`OnLoseKeyboardFocus`, `edit` child in the renderer. Assumes 2+3. | headless: Create `rename.lua` dialog, feed in `MET_Char` sequence, check `GetText()`, Enter → `OnEnterPressed` with the text. |
| 5 | **`CMauiMovie`**: `InternalCreateMovie`, `movie_methods`, `MovieWidth/MovieHeight`, `OnStopped/OnFinished`. Format is **CRI Sofdec** (`.sfd`: MPEG-1 video + ADX audio; symbols `MWSFD_*`, `mwsfsfx_*`, `struct_sofdec_ply`, Cfile:44063-44075; `Moho::CMovie::GetWidth/GetHeight` Cfile:29109-29110). | headless: `main.lua:CreateBackMovie(GetFrame(0))` → Movie in snapshot, `Width == 1824 * (H/1024)` (main.lua:43-46). Browser: Main menu with running background. |
| 6 | **`CMauiItemList`** (19) — unlock `combo.lua` and thus **every dropdown**. | headless: `Combo(parent, {…})` → `GetItemCount()`, `OnClick` sets the selection; `mapselect.lua` loads without errors. |
| 7 | **`CMauiScrollbar`** (4) + Scrollable protocol (`GetScrollValues`/`ScrollLines`/`ScrollPages`/`ScrollSetTop`) on `control_methods`. | headless: `UIUtil.CreateVertScrollbar(list)` → mouse wheel calls `ScrollLines(axis, delta)` on the scrollable. |
| 8 | **`CUIMapPreview`** (3) — Kartenauswahl. | headless: `MapPreview(parent):SetTextureFromMap(scenario)` → Textur im Snapshot. |
| 9 | **`CUIWorldView`** — own topic ([worldview-camera.md](worldview-camera.md)); then remove the `draws()` filter from the hit test (point 4.3). | `gamemain.lua:142` is running; Clicking in the free area hits the WorldView, not the screen group. |

**Don't build:** Histogram, Mesh (not instantiated by any UI file), Lobby/DiscoveryService
(MP) until there is a reason.

**Blocked image:** For the **Session UI**, **not a single** maui control is missing on the
critical path — Economy, Orders, Construction, UnitView consist of Group/Bitmap/Text/
Border/Dragger. What is missing there is the **WorldView** and the **Keyboard Path**.
The **main menu** depends on exactly one control: **Movie** (main.lua:35). The way
Hauptmenü → Skirmish → Session braucht zusätzlich **ItemList** (Combo), **Scrollbar**
and **MapPreview**.

## 6. Offene Fragen

- **Sofdec in browser.** `.sfd` is MPEG-1 video + CRI-ADX audio. A JS/WASM decoder is
  feasible, but effort. A "black rectangle instead of video" would be a stub
  Productive path (forbidden). Intermediate: `InternalSet` returns `false` if no decoder
  is connected — this **is** a real engine path (movie.lua:50-53 then calls
  `OnStopped()`), but it's a lie as long as the file would be readable. Decision necessary.
- **`AcquireKeyboardFocus(bool blocksKeyDown)`**: The flag lands in a field
  (Cfile:1125768-1125790); **where** it is read is not tracked. Allegedly
  it decides whether an untreated `KeyDown` falls through to the keymap.
- **`ScrollPages`**: The decomp contains `RunScript` call sites for
  `GetScrollValues`, `ScrollLines` (2×) and `ScrollSetTop` — none for `ScrollPages`.
  Either IDA string aliasing to Cfile:1124753, or the engine just calls `ScrollLines`.
  In any case, the Lua side implements `ScrollPages` (filepicker.lua:307).
- **`GetTopmostDepth()`** (Cfile:1136937): real return value not read; our 5000000
  is advised.
- **`CMauiItemList` mit eigenem Scroll**: `NeedsScrollBar`, `ShowMouseoverItem`,
  `ShowSelection` — whether the list renders its scroll itself or necessarily an external one
  Scrollbar needs, is not checked.
- **`CMauiEdit` text model**: selection/highlight (`SetNewHighlight*Color`) and
  `SetCaretCycle(seconds, minAlpha, maxAlpha)` liegen komplett in C++
  (`CMauiEdit::HandleKeyEvent`). This function must be used for a replica that is true to the original
  to be read — not done yet.
