# Input 1:1 — Cursor, Tastenbelegung, InputCapture

Alle Input-Bindungen liegen in `scr_UserInits` — Input ist **reine UI-VM**
([engine-api.md](engine-api.md)). Die Sim sieht keine Taste und keinen Cursor.

## 1. Überblick

Die Engine liefert drei getrennte Dinge, die die Original-Lua zusammensetzt:

| Was | Engine-Seite | Lua-Seite |
|---|---|---|
| **Cursor** | genau **ein** `CMauiCursor` für das ganze Spiel; Textur + Hotspot umschaltbar | `Cursor` (cursor.lua:6) animiert ihn per LazyVar/Thread; `worldview.lua` schaltet ihn pro Frame um |
| **Hotkeys** | `CUIKeyHandler`: `keyString → {action, keyRepeat}`-Map, führt `action` per **Konsole** aus | `keymapper.lua` baut die Map aus `defaultKeyMap` + `keyactions` |
| **maui-Events** | `KeyDown`/`KeyUp`/`Char` als `SMauiEventData` an Controls | `HandleEvent(self, event)` — dieselbe Funktion wie für die Maus |

Der Rest (InputCapture, Keyboard-Fokus) ist **Routing**: er entscheidet, *wer*
Events und Hotkeys bekommt.

## 2. Cursor

### Callchain

1. `SetupUI()` (uimain.lua:20-25) → `UIUtil.CreateCursor()` → `Cursor(GetCursor('DEFAULT'))`
   → `SetCursor(c)`. Kommentar dort: *„SetCursor needs to happen anytime this
   function is called because we could be switching lua states."*
2. `UIUtil.GetCursor(id)` (uiutil.lua:341-348) holt aus
   `skins[currentSkin()].cursors[id]` fünf Werte:
   **`texture, hotspotX, hotspotY, [numFrames], [fps]`** (skins.lua:169).
   ⚠️ Zeile 343 ist die LuaPlus-`nil`-Metatable-Stelle (siehe CLAUDE.md).
3. `Cursor.__init` (cursor.lua:7-21) ruft `_c_CreateCursor(self, nil)`, dann
   `SetDefaultTexture(...)` + `ResetToDefault()`. `SetTexture` (cursor.lua:23-47)
   forkt bei `numFrames != 1` einen **Animations-Thread**, der den Dateinamen auf
   `<basename>%02d.dds` hochzählt (`WaitSeconds(1/fps)`) und über eine LazyVar
   (`_filename.OnDirty`) `SetNewTexture` auslöst.
4. Ab da holt sich jeder das *eine* Cursor-Objekt über das **Engine-Global**
   `GetCursor()` (`GetCursor()` @Cfile:1274426, mHelp `"GetCursor()"`) — nicht zu
   verwechseln mit `UIUtil.GetCursor(id)`, das nur die Skin-Tabelle liest.

### Die 30 Cursor-Formen (skins.lua:170-201)

Schlüssel sind entweder **`RULEUCC_*`-Namen** (die Engine-Command-Caps, siehe
commandmode.lua:26-56) oder UI-Namen:
`RULEUCC_Attack/CallTransport/Capture/Ferry/Guard/Move/Nuke/Tactical/Overcharge/
SpecialAction/Patrol/Reclaim/Repair/Sacrifice/Transport/Teleport/Script/Invalid`,
`COORDINATED_ATTACK`, `MESSAGE`, `BUILD`, `HOVERCOMMAND`, `DRAGCOMMAND`,
`MOVE2PATROLCOMMAND`, `DEFAULT`, `NE_SW`, `NW_SE`, `N_S`, `W_E`, `MOVE_WINDOW`.
Die meisten sind **animiert** (z. B. `RULEUCC_Reclaim` = 23 Frames à 12 fps).

### Wer den Cursor wechselt — `OnUpdateCursor`

`Moho::CUIWorldView::OnFrame` (@0x871140, Cfile:1299998) ruft **jeden Frame**
`OnUpdateCursor` auf der WorldView (nur wenn Highlight an und kein Mouse-Scrubbing).
Die Lua dazu steht in worldview.lua (`/lua/ui/controls/worldview.lua`:131-204) und
ist die vollständige Cursor-Priorität:

```
mode = commandmode.GetCommandMode()
mode[1] == "order"  → ShowConvertToPatrolCursor() ? MOVE2PATROLCOMMAND
                      : DecalFunctions[mode[2].name]() liefert „invalid“ ? RULEUCC_Invalid
                      : mode[2].cursor  or  mode[2].name          (:139-152)
mode[1] == "build"  → BUILD                                        (:155)
mode[1] == "ping"   → mode[2].cursor                               (:157)
HasHighlightCommand() → MOVE2PATROLCOMMAND oder HOVERCOMMAND       (:158-163)
sonst GetRightMouseButtonOrder() → dieser Order-Cursor,
      ABER "RULEUCC_Move" → kein Cursor (Reset)                    (:165-180)
```
Zusätzlich: `OnCommandDragBegin` → `DRAGCOMMAND` (:222-228),
`MouseEnter/MouseMotion` → `GetCursor():SetTexture(unpack(self.Cursor))`,
`MouseExit` → `GetCursor():Reset()` (:107-127).
`worldview.lua:147/152` (Manager) macht `GetCursor():Hide()/:Show()` bei
Lock/UnlockInput; `uimain.lua:154` zeigt ihn bei `NoteGameOver` wieder.

`CMauiCursor` hat exakt 5 Methoden: `Hide`, `ResetToDefault`, `SetDefaultTexture`,
`SetNewTexture`, `Show` (engine-api.md, Klasse `CMauiCursor`). `SetTexture` und
`Reset` sind **Lua** (cursor.lua), nicht Engine.

## 3. Tastenbelegung

### Die Kette

`defaultKeyMap.lua` (`'Ctrl-W' → 'tog_military'`) + `keyactions.lua`
(`tog_military → {action = 'UI_Lua import("…/multifunction.lua").ToggleMilitary()', category, order, [keyRepeat]}`)
→ `keymapper.GetKeyMappings()` (keymapper.lua:103-117) faltet beides zu
`{ ['Ctrl-W'] = {action=…, keyRepeat=…}, … }` → **das** frisst `IN_AddKeyMapTable`.

**Die Engine lädt das selbst.** `CUIKeyHandler::LoadKeyMappings` (Cfile:1259476-1259525):
1. `SCR_Import("/lua/keymap/keyNames.lua")` → `SetKeyNameTable(keyNames)`
2. `SCR_Import("/lua/keymap/keymapper.lua")` → **ruft `GetKeyMappings()` auf** →
   `AddKeyMapTable(result)`.

Keine Lua-Datei tut das — genau wie bei `usersync.lua`. Die drei `IN_*`-Globals sind
nur die *Nachträge* (Debug-Keys raus in uimain.lua:52, Neuaufbau in
keybindings.lua:24-28, Cheat-Keys in lobby.lua:2866-2867).

### `IN_AddKeyMapTable` — das exakte Format (Cfile:1259176-1259266)

Iteriert die Tabelle: **Schlüssel** = Key-String → `Moho::IN_ParseKeyModifiers`,
**Wert** = Tabelle mit `.action` (String, Pflicht) und optional `.keyRepeat` (Bool).
Andere Felder (`category`, `order`) ignoriert die Engine — die sind nur für
`keybindings.lua`. Kein Table → `Warnf("CUIKeyHandler::AddKeyMapTable requires a table")`.

### `IN_ParseKeyModifiers` (Cfile:1259566-1259720)

- Splittet den String an `-` (`gpg::STR_GetToken`), **erster** Token = Tastenname,
  Rest = Modifier.
- Tastenname → Index in `Moho::in_keyNames[256]` (Cfile:1259151-1259172, linearer
  `stricmp`-Scan; `-1` wenn unbekannt). Der Index **ist der Windows-VK-Code** —
  keyNames.lua:2: *„Key codes must be in hex and match the Windows VK codes"*.
  Die Tabelle ist mit `"Unknown%02X"` vorbelegt (Cfile:1258965) und wird von
  `SetKeyNameTable` aus keyNames.lua überschrieben.
- Modifier werden als Flags in denselben `int` gefaltet:
  **`Shift = 0x80000000`, `Ctrl = 0x40000000`, `Alt = 0x20000000`**
  (Reihenfolge der drei Vergleichs-Strings Cfile:1259596-1259606 → Flags 1259627/1259648/1259668;
  gegengeprüft am Event-Handler unten und an defaultKeyMap.lua:4-6). Unbekannter
  Modifier → `Warnf("Key map contains unrecognized modifier string: %s")`.

### Ein Tastendruck (`sub_838D10` @0x838D10, Cfile:1258983-1259080)

`CUIKeyHandler` ist ein `wxEvtHandler`, den die Engine pro Fenster per
`PushEventHandler` **vorn** einhängt (Cfile:1273505-1273516).

1. **Hat irgendein Control Keyboard-Fokus** (`Maui_CurrentFocusControl.mPrev`)?
   → **sofort raus**, kein Hotkey (Cfile:1259003-1259007). Das ist die
   Edit-Feld-Regel: wer tippt, löst keine Hotkeys aus.
2. Modifier aus dem `wxKeyEvent` in den Suchschlüssel falten:
   `+44 (m_controlDown) → 0x40000000`, `+45 (m_shiftDown) → 0x80000000`,
   `+46 (m_altDown) → 0x20000000`, dazu `+52` = **Raw-VK** (Cfile:1259010-1259019).
3. Ist die Taste **nicht** in der keyRepeat-Menge und ist das Event ein
   Auto-Repeat (`m_rawFlags & 0x40000000` = lParam-Bit 30, Cfile:1259053) →
   ignorieren. *Das* ist `keyRepeat = true` (nur `camera.lua`-Zoom nutzt es,
   keyactions.lua:177/179).
4. Treffer in der Action-Map → **`Moho::CON_Execute(action)`** (Cfile:1259059).
5. Kein Treffer, Sonderfälle über den **wx**-KeyCode (`+40`):
   - `13` (Enter) → `chat.lua:ActivateChat{Shift=,Ctrl=,Alt=}` (Cfile:1263522-1263560).
     keyNames.lua:12 sagt es selbst: *„change Enter at your own peril, it's handled
     specially to open the chat window"*.
   - `126` (`~`) → `uimain.lua:ToggleConsole()` (Cfile:1262747-1262775).
6. **Jeder** Pfad endet mit `m_skipped = 1` (LABEL_25) → das Key-Event läuft
   **trotzdem weiter** an den nächsten wx-Handler. Hotkey und maui-Event schließen
   sich also nicht aus.

### `ConExecute` ist der Ausführungspfad

Ein Key-Action-String ist eine **Konsolenzeile**, kein Lua-Callback:
- `UI_Lua <code>` (`Moho::CConFunc_UI_Lua`, Cfile:423593-423600) hängt alle Argumente
  mit Leerzeichen zusammen und ruft `SCR_LuaDoString(code, UI_Manager->mState)`
  (Cfile:1256278-1256324) — also `host.eval` in der **UI-VM**.
- Daneben echte Engine-Kommandos: `UI_RenderUnitBars`, `UI_RotateLayout +`,
  `UI_RotateSkin -`, `UI_ShowRenameDialog`, `Dump_Frame`, `SetFocusArmy n`,
  `CreateUnit …` (game-shell.md:244-248).
- `ConExecute` mHelp: *„Perform a console command"* (Cfile:453271);
  `ConExecuteSave` zusätzlich *„saved to stack"* (Cfile:453543) — die History der
  Konsole (console.lua).

## 4. maui-Key-Events und das Fokus-Modell

Das Event-Table ist **dasselbe** wie bei der Maus — `func_CreateLuaEvent` @0x795BD0
(Cfile:1136293-1136348) setzt immer alle Felder:
`Type, MouseX, MouseY, WheelRotation, WheelDelta, KeyCode, RawKeyCode,
Modifiers{Shift,Ctrl,Alt,Left,Middle,Right}, Control`.

`EMauiEventType` vollständig (Cfile:1136253-1136290):
`MouseMotion=1, MouseEnter=2, MouseHover=3, MouseExit=4, ButtonPress=5,
ButtonDClick=6, ButtonRelease=7, WheelRotation=8, KeyUp=9, KeyDown=10, Char=11`.
Wir kennen bisher nur 1,2,4,5,6,7,8 — **`KeyDown`, `KeyUp`, `Char`, `MouseHover` fehlen**.

- **`KeyCode` ist ein wx-Keycode, nicht VK.** `KeycodeMSWToMaui` = `wxCharCodeMSWToWX`
  (Cfile:1142082-1142100), `KeycodeMauiToMSW` = `wxCharCodeWXToMSW`. Beleg auf der
  Lua-Seite: `UIUtil.VK_PAUSE = 310` (uiutil.lua:81) — das ist `WXK_PAUSE`, nicht
  `VK_PAUSE (0x13)`. `VK_BACKSPACE=8, VK_TAB=9, VK_ENTER=13, VK_ESCAPE=27, VK_SPACE=32,
  VK_PRIOR=33, VK_NEXT=34, VK_UP=38, VK_DOWN=40` (uiutil.lua:72-81).
  `RawKeyCode` ist der MSW-VK (derselbe Raum wie keyNames.lua).
- **`IsKeyDown(keyName)`** = `Moho::MAUI_KeyIsDown` (Cfile:1141557-1141585): liefert
  **false**, wenn das Fenster nicht im Vordergrund ist **oder** ein Control
  Keyboard-Fokus hat; sonst `GetKeyState(wxCharCodeWXToMSW(code)) < 0`. Das Argument
  ist ein **`EMauiKeyCode`-Name** (`SCR_GetEnum`), z. B. `IsKeyDown('Shift')`
  (commandmode.lua:82 — die Shift-Queue!). Die 103 Namen (Prefix `MKEY_`):
  `BACK TAB RETURN ESCAPE SPACE DELETE START LBUTTON RBUTTON CANCEL MBUTTON CLEAR
  SHIFT ALT CONTROL MENU PAUSE CAPITAL PRIOR NEXT END HOME LEFT UP RIGHT DOWN SELECT
  PRINT EXECUTE SNAPSHOT INSERT HELP NUMPAD0…9 MULTIPLY ADD SEPARATOR SUBTRACT DECIMAL
  DIVIDE F1…F24 NUMLOCK SCROLL PAGEUP PAGEDOWN NUMPAD_*` (Cfile:1141633 ff.).
- **Keyboard-Fokus**: `MAUI_SetKeyboardFocus(control, hasFocus)` (Cfile:1141557 ff.,
  Anm.: `Moho::Maui_CurrentFocusControl` + `Moho::Maui_ControlHasFocus`). Lua-API:
  `CMauiControl:AcquireKeyboardFocus(bool)`, `:AbandonKeyboardFocus()`,
  `:GetCurrentFocusControl()`. Callbacks in die Lua: **`OnLoseKeyboardFocus`**
  (Cfile:1124572) und **`OnKeyboardFocusChange`** (Cfile:1124577).
  Ein **ButtonPress auf ein anderes Control nimmt dem Fokus-Control den Fokus**
  (Cfile:1147523-1147531).
- `CMauiEdit::HandleEvent` (Cfile:1132301-1132318) reagiert nur auf `MET_Char`
  (→ `HandleKeyEvent`) und die Button-Events; Enter/Esc melden sich als
  `OnEnterPressed` / `OnEscPressed` (Cfile:1132326/1132331).

**⚠️ OFFEN:** Die Stelle, an der `MET_KeyDown/KeyUp/Char` in den maui-Baum
**gepostet** wird, habe ich in der Decomp nicht gefunden — `CMauiControl::PostEvent`
(@0x787370) hat nur drei Aufrufer, alle im Maus-Handler (Cfile:1147441/1147448/1147582).
Was die Original-Lua **verlangt**, ist aber eindeutig: `UIUtil.MakeInputModal`
(uiutil.lua:615-645) hängt sich an `control.HandleEvent` und prüft dort
`event.Type == 'KeyDown'` auf `VK_ESCAPE`/`VK_ENTER` — und dieses Control ist das
**InputCapture**-Control, das gerade *keinen* Keyboard-Fokus hat. Key-Events müssen
also (mindestens auch) an den **Top of Capture Stack** gehen und von dort per
Parent-Kette bubbeln.

## 5. InputCapture

`std::vector sInputCapture` (Cfile:430346). Semantik:

| Binding | mHelp / Beleg |
|---|---|
| `AddInputCapture(control)` | *„set a control as the current capture"* — Cfile:1147871 (push_back) |
| `RemoveInputCapture(control)` | *„remove the control from the capture array (always first from back)"* — Cfile:1147921, Impl. 1147071-1147115 (sucht **von hinten**) |
| `AnyInputCapture()` / `GetInputCapture()` | Stack abfragen — Cfile:1147773 / 1147818 |

**Wirkung im Maus-Dispatch** (Cfile:1147378-1147392): ist der Stack **nicht leer**,
wird der Hit-Test nicht auf dem Root-Frame, sondern auf dem **letzten Eintrag**
(`back()`) gestartet — alles außerhalb dieses Teilbaums ist tot. Das *ist* die
Modalität. Ein Lua-State-Wechsel leert den Stack und beendet den laufenden Dragger
(Cfile:1273556-1273562).

Nutzer: `uiutil.MakeInputModal` (uiutil.lua:615-646, hängt `RemoveInputCapture` an
`OnDestroy`), splash.lua:30/49, score.lua, keybindings.lua:190/239, connectivity.lua,
objectivedetail.lua, shareresources.lua, transmissionlog.lua, campaignmovies.lua,
missiontext.lua — und `worldview.LockInput()` (worldview.lua:133-138), das eine
Vollbild-`Group` als Capture setzt **und** `GetCursor():Hide()` macht.

*Dragger* sind **getrennt** davon: `PostDragger(originFrame, keycode, dragger)`
(Cfile:1130551), `sCurrentDragger` + `sCurrentDraggerKeycode`; der Keycode darf nur
`MKEY_LBUTTON/RBUTTON/MBUTTON` (bzw. 1/2/3) sein (Cfile:1130686-1130697).
Das haben wir schon (maui.lua:519).

## 6. Ist-Stand unserer Engine

**Da:**
- `_c_CreateCursor` / `SetCursor` (ui-globals.lua:38-46) — legen das Objekt an,
  merken es in `__cursor`; `moho.cursor_methods` (moho.lua:332-350) hat
  `SetDefaultTexture`/`ResetToDefault` echt und reicht `SetNewTexture` an den
  TS-Hook `__uiSetCursorTexture` weiter — **der aber nirgends gesetzt wird**
  (`= false`, ui-globals.lua:24; kein Treffer in `src/ui/`). Der Cursor ist also
  ein Objekt ohne Wirkung. `Hide`/`Show` sind No-Ops.
- Maus-Events komplett: `__mauiMouse` / `__mauiWheel` (maui.lua:433-490), Hit-Test +
  Parent-Bubbling (maui.lua:383-410), Modifiers-Table aus dem Browser-Event
  (gameUi.ts:260-276), `PostDragger` (maui.lua:519).
- `ConExecute` / `ConExecuteSave` (ui-globals.lua:648-651) — **loggen nur**
  (`'ConExecute (nicht ausgefuehrt): …'`). Damit ist **jede** Tastenaktion tot,
  auch wenn die Keymap käme.
- `DebugFacilitiesEnabled() → false` (ui-globals.lua:655) ⇒ Debug-Keys sind korrekt aus.

**Fehlt (14 Globals + 3 Control-Methoden), alle in `ui-globals-missing.lua`
(werfen beim Aufruf):**

| Binding | Semantik (Decomp) | Wer braucht es |
|---|---|---|
| `IN_AddKeyMapTable(t)` | Cfile:1259176 — `key → {action, keyRepeat}` in die Map | keybindings.lua:27, lobby.lua:2867, **Engine-Boot** |
| `IN_RemoveKeyMapTable(t)` | Cfile:1259267 | uimain.lua:52 (Debug-Keys) |
| `IN_ClearKeyMap()` | Cfile:1260044 | keybindings.lua:25 |
| `IsKeyDown(name)` | Cfile:1141557 — false bei Fokus/Hintergrund | **commandmode.lua:82** (Shift-Queue) |
| `KeycodeMSWToMaui` / `KeycodeMauiToMSW` | wx↔VK, Cfile:1142082/1142029 | keybindings.lua (Tastenaufzeichnung) |
| `AddInputCapture` / `RemoveInputCapture` | Cfile:1147871/1147921 | uiutil.lua:616/620 → **jeder Dialog** |
| `AnyInputCapture` / `GetInputCapture` | Cfile:1147773/1147818 | worldview.lua, eschandler |
| `GetCursor()` | Cfile:1274426 → das `CMauiCursor`-Objekt | worldview.lua:112/115/119/147/152 (**jede Mausbewegung**) |
| `FlushEvents()` | *„flush mouse/keyboard events"*, Cfile:1274594 | Szenenwechsel |
| `GetMouseScreenPos` / `GetMouseWorldPos` | — | worldview.lua:194 (Target-Decal) |
| `CMauiControl:AcquireKeyboardFocus/AbandonKeyboardFocus/GetCurrentFocusControl` | Cfile:1124581/1124587/… | Edit-Felder, Chat, Konsole |

Dazu für `console.lua`: `AddConsoleOutputReciever`, `RemoveConsoleOutputReciever`,
`ConTextMatches` (3 weitere).

**Falsch/provisorisch:** ESC und die Pfeiltasten hängen in `src/main.ts:651-680` und
`:726-742` direkt am `window` (Launcher-ESC, Kamera-Pan). Sobald `EscapeHandler`
(uimain.lua:119) und `keyactions` laufen, gehört das der Original-Lua.

## 7. Bau-Reihenfolge

**S1 — `ConExecute` echt machen.** Kommando-Registry im TS/Lua: `UI_Lua <code>` →
`host.eval(code)` in der UI-VM (Cfile:1256278); unbekanntes Kommando → **laut**
warnen (nicht still schlucken). `ConExecuteSave` = `ConExecute` + History.
*Verify:* Suite ruft `ConExecute('UI_Lua LOG("hi")')` und prüft die Logzeile; ein
erfundenes Kommando muss knallen.

**S2 — Keyboard-Events in maui.** `__mauiKey(evType, keyCode, rawKeyCode, mods)` in
`maui.lua`, Event-Table exakt wie `func_CreateLuaEvent`. Routing:
Keyboard-Fokus-Control, sonst Top-of-Capture, sonst Root-Frame — dann Parent-Bubbling
wie bei der Maus. Dazu `AcquireKeyboardFocus`/`AbandonKeyboardFocus`/
`GetCurrentFocusControl` + `OnLoseKeyboardFocus`/`OnKeyboardFocusChange`.
Browser: `keydown → KeyDown`, `keyup → KeyUp`, `keypress`/`beforeinput → Char`.
*Verify:* Browser-Selbsttest — Edit-Feld fokussieren, tippen, `GetText()` prüfen.

**S3 — InputCapture-Stack.** Vier Globals; `__mauiHitTest` bekommt eine Wurzel
(Top-of-Capture statt Root-Frame). *Verify:* Dialog per `MakeInputModal` öffnen,
Klick daneben darf **nicht** ankommen; ESC schließt ihn (uiutil.lua:627).

**S4 — Keymap + Hotkeys.** `IN_*` + `CUIKeyHandler`-Nachbau in `ui-globals.lua`:
`IN_ParseKeyModifiers` (Split an `-`, VK aus keyNames.lua, Flags 0x8/0x4/0x2 0000000),
Auto-Repeat-Filter, Fokus-Sperre, `CON_Execute(action)`. Beim UI-Boot dasselbe tun
wie `LoadKeyMappings` (Cfile:1259476): `keyNames.lua` → `SetKeyNameTable`,
`keymapper.GetKeyMappings()` → `AddKeyMapTable`. Browser-Keycode → VK: `KeyboardEvent.code`
ist der stabile Weg (`KeyW → 0x57`, `Digit1 → 0x31`).
*Verify:* Suite lädt `keymapper.GetKeyMappings()` und prüft, dass **jeder** Eintrag
aus `defaultKeyMap.lua` eine `action` bekommt (keymapper.lua:112 warnt sonst) und
dass `'Ctrl-W'` auf `0x40000000|0x57` parst. Browser: Ctrl-W togglet das
Military-Panel (multifunction.lua).

**S5 — ESC/Enter.** Hotkey `escape` → `uimain.EscapeHandler()` (uimain.lua:119-127) →
`eschandler.HandleEsc()`; Enter (kein Mapping) → `chat.ActivateChat` (Cfile:1263522);
`~` → `uimain.ToggleConsole()` (Cfile:1262747). Damit ist das **Hauptmenü**
bedienbar (ESC/Enter/Edit-Fokus).

**S6 — Cursor.** `GetCursor()` liefert `__cursor`; `__uiSetCursorTexture` an einen
echten TS-Hook hängen: DDS → Canvas/Blob-URL → `document.body.style.cursor =
url(<png>) <hotspotX> <hotspotY>, auto`. Animation macht die Original-Lua von selbst
(cursor.lua:34-43) — sie ruft nur öfter `SetNewTexture`. Danach `IsKeyDown` (S4 liefert
den Tastenzustand) und `GetMouseScreenPos/GetMouseWorldPos`, dann kann
`worldview.lua:OnUpdateCursor` als echtes Control laufen (braucht aber die WorldView
aus [worldview-camera.md](worldview-camera.md)).
*Verify:* Browser-Selbsttest — nach `SetupUI()` steht `body.style.cursor` auf
`selectable.dds`; Bau-Modus schaltet auf `BUILD`.

## 8. Offene Fragen

1. **Wohin genau postet die Engine `MET_KeyDown/KeyUp/Char`?** (Abschnitt 4). Die
   Reihenfolge Fokus-Control ↔ InputCapture-Top ist aus der Lua *erschlossen*, nicht
   aus der Decomp belegt. Kandidat: ein zweiter `wxEvtHandler` hinter `CUIKeyHandler`.
   Nachfassen per IDA an den Xrefs von `CMauiEdit::HandleKeyEvent`.
2. **Bubbeln Key-Events?** `PostEvent` (Parent-Kette) wird für Keys nirgends
   aufgerufen — trotzdem verlässt sich `MakeInputModal` darauf, dass `HandleEvent`
   des Capture-Controls sie sieht.
3. **Die drei Modifier-Strings** (`0x10C1D08/1D24/1D40`) sind laufzeit-konstruierte
   `std::string`-Globals; IDA liest sie nicht. „Shift/Ctrl/Alt" ist aus der
   Flag-Reihenfolge + defaultKeyMap.lua:4-6 erschlossen, nicht direkt gelesen.
4. **`MET_MouseHover`** (=3) wird von uns nie erzeugt. Wer löst es aus, und nach
   welcher Verzögerung? (Tooltips hängen bisher an `MouseEnter`.)
5. **`FlushEvents`** — welche Queue genau (wx-Queue oder maui)? Ohne Kenntnis der
   Wirkung ist ein No-Op hier ein Stub, also verboten.
