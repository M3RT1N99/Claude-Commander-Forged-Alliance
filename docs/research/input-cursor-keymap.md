# Input 1:1 — Cursor, Tastenbelegung, InputCapture

All input bindings are in `scr_UserInits` — input is **pure UI VM**
([engine-api.md](engine-api.md)). The sim sees no key or cursor.

## 1. Overview

The engine delivers three separate things that the original Lua puts together:

| What | Engine page | Lua page |
|---|---|---|
| **Cursor** | exactly **one** `CMauiCursor` for the whole game; Texture + hotspot switchable | `Cursor` (cursor.lua:6) animates it via LazyVar/Thread; `worldview.lua` switches it per frame |
| **Hotkeys** | `CUIKeyHandler`: `keyString → {action, keyRepeat}` map, executes `action` via **console** | `keymapper.lua` builds the map from `defaultKeyMap` + `keyactions` |
| **maui events** | `KeyDown`/`KeyUp`/`Char` as `SMauiEventData` to Controls | `HandleEvent(self, event)` — the same function as for the mouse |

The rest (InputCapture, keyboard focus) is **routing**: it decides *who*
Events and hotkeys.

## 2. Cursor

### Callchain

1. `SetupUI()` (uimain.lua:20-25) → `UIUtil.CreateCursor()` → `Cursor(GetCursor('DEFAULT'))`
   → `SetCursor(c)`. Comment there: *“SetCursor needs to happen anytime this
   function is called because we could be switching lua states."*
2. `UIUtil.GetCursor(id)` (uiutil.lua:341-348) takes off
   `skins[currentSkin()].cursors[id]` five values:
   **`texture, hotspotX, hotspotY, [numFrames], [fps]`** (skins.lua:169).
   ⚠️ Line 343 is the LuaPlus `nil` metatable location (see CLAUDE.md).
3. `Cursor.__init` (cursor.lua:7-21) calls `_c_CreateCursor(self, nil)`, then
   `SetDefaultTexture(...)` + `ResetToDefault()`. `SetTexture` (cursor.lua:23-47)
   at `numFrames != 1` forks an **animation thread** that displays the file name
   `<basename>%02d.dds` increments (`WaitSeconds(1/fps)`) and via a LazyVar
(`_filename.OnDirty`) `SetNewTexture` triggers.
4. From then on everyone gets the *one* cursor object via the **Engine-Global**
   `GetCursor()` (`GetCursor()` @Cfile:1274426, mHelp `"GetCursor()"`) — not possible
   be confused with `UIUtil.GetCursor(id)`, which only reads the skin table.

### The 30 cursor shapes (skins.lua:170-201)

Keys are either **`RULEUCC_*` names** (the engine command caps, see
commandmode.lua:26-56) or UI name:
`RULEUCC_Attack/CallTransport/Capture/Ferry/Guard/Move/Nuke/Tactical/Overcharge/
SpecialAction/Patrol/Reclaim/Repair/Sacrifice/Transport/Teleport/Script/Invalid`,
`COORDINATED_ATTACK`, `MESSAGE`, `BUILD`, `HOVERCOMMAND`, `DRAGCOMMAND`,
`MOVE2PATROLCOMMAND`, `DEFAULT`, `NE_SW`, `NW_SE`, `N_S`, `W_E`, `MOVE_WINDOW`.
Most are **animated** (e.g. `RULEUCC_Reclaim` = 23 frames at 12 fps).

### Whoever changes the cursor — `OnUpdateCursor`

`Moho::CUIWorldView::OnFrame` (@0x871140, Cfile:1299998) calls **every frame**
`OnUpdateCursor` on the WorldView (only if highlight is on and no mouse scrubbing).
The Lua for this is in worldview.lua (`/lua/ui/controls/worldview.lua`:131-204) and
is the full cursor priority:

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
Additionally: `OnCommandDragBegin` → `DRAGCOMMAND` (:222-228),
`MouseEnter/MouseMotion` → `GetCursor():SetTexture(unpack(self.Cursor))`,
`MouseExit` → `GetCursor():Reset()` (:107-127).
`worldview.lua:147/152` (Manager) joins `GetCursor():Hide()/:Show()`
Lock/UnlockInput; `uimain.lua:154` shows him again at `NoteGameOver`.

`CMauiCursor` hat exakt 5 Methoden: `Hide`, `ResetToDefault`, `SetDefaultTexture`,
`SetNewTexture`, `Show` (engine-api.md, class `CMauiCursor`). `SetTexture` and
`Reset` are **Lua** (cursor.lua), not Engine.

## 3. Tastenbelegung

### The chain

`defaultKeyMap.lua` (`'Ctrl-W' → 'tog_military'`) + `keyactions.lua`
(`tog_military → {action = 'UI_Lua import("…/multifunction.lua").ToggleMilitary()', category, order, [keyRepeat]}`)
→ `keymapper.GetKeyMappings()` (keymapper.lua:103-117) faltet beides zu
`{ ['Ctrl-W'] = {action=…, keyRepeat=…}, … }` → **that** eats `IN_AddKeyMapTable`.

**The engine loads this itself.** `CUIKeyHandler::LoadKeyMappings` (Cfile:1259476-1259525):
1. `SCR_Import("/lua/keymap/keyNames.lua")` → `SetKeyNameTable(keyNames)`
2. `SCR_Import("/lua/keymap/keymapper.lua")` → **calls `GetKeyMappings()`** →
   `AddKeyMapTable(result)`.

No Lua file does that — just like `usersync.lua`. The three `IN_*` globals are
only the *addendums* (debug keys out in uimain.lua:52, rebuild in
keybindings.lua:24-28, Cheat-Keys in lobby.lua:2866-2867).

### `IN_AddKeyMapTable` — the exact format (Cfile:1259176-1259266)

Iterates the table: **key** = key string → `Moho::IN_ParseKeyModifiers`,
**Value** = Table with `.action` (string, mandatory) and optionally `.keyRepeat` (bool).
The engine ignores other fields (`category`, `order`) — they are only for
`keybindings.lua`. No table → `Warnf("CUIKeyHandler::AddKeyMapTable requires a table")`.

### `IN_ParseKeyModifiers` (Cfile:1259566-1259720)

- Splits the string to `-` (`gpg::STR_GetToken`), **first** token = key name,
  Rest = Modifier.
- Tastenname → Index in `Moho::in_keyNames[256]` (Cfile:1259151-1259172, linearer
  `stricmp` scan; `-1` if unknown). The index **is the Windows VK code** —
  keyNames.lua:2: *„Key codes must be in hex and match the Windows VK codes"*.
  The table is pre-filled with `"Unknown%02X"` (Cfile:1258965) and is used by
  `SetKeyNameTable` overwritten from keyNames.lua.
- Modifiers are folded as flags into the same `int`:
  **`Shift = 0x80000000`, `Ctrl = 0x40000000`, `Alt = 0x20000000`**
  (Order of the three comparison strings Cfile:1259596-1259606 → Flags 1259627/1259648/1259668;
  cross-checked on the event handler below and on defaultKeyMap.lua:4-6). Unknown
  Modifier → `Warnf("Key map contains unrecognized modifier string: %s")`.

### One keystroke (`sub_838D10` @0x838D10, Cfile:1258983-1259080)

`CUIKeyHandler` is a `wxEvtHandler` that the engine sends per window
`PushEventHandler` **front** mounts (Cfile:1273505-1273516).

1. **Does any Control Keyboard have focus** (`Maui_CurrentFocusControl.mPrev`)?
   → **out immediately**, no hotkey (Cfile:1259003-1259007). That's the one
   Edit field rule: typing does not trigger hotkeys.
2. Fold modifier from the `wxKeyEvent` into the search key:
   `+44 (m_controlDown) → 0x40000000`, `+45 (m_shiftDown) → 0x80000000`,
   `+46 (m_altDown) → 0x20000000`, dazu `+52` = **Raw-VK** (Cfile:1259010-1259019).
3. If the key is **not** in the keyRepeat set and the event is on
   Auto-Repeat (`m_rawFlags & 0x40000000` = lParam-Bit 30, Cfile:1259053) →
   ignore. *This* is `keyRepeat = true` (only `camera.lua`-Zoom uses it,
   keyactions.lua:177/179).
4. Hit in the action map → **`Moho::CON_Execute(action)`** (Cfile:1259059).
5. No hit, special cases via the **wx**-KeyCode (`+40`):
   - `13` (Enter) → `chat.lua:ActivateChat{Shift=,Ctrl=,Alt=}` (Cfile:1263522-1263560).
     keyNames.lua:12 sagt es selbst: *„change Enter at your own peril, it's handled
     specially to open the chat window"*.
   - `126` (`~`) → `uimain.lua:ToggleConsole()` (Cfile:1262747-1262775).
6. **Every** path ends with `m_skipped = 1` (LABEL_25) → the key event is running
   **continue anyway** to the next wx handler. Close hotkey and maui event
   so not out.

### `ConExecute` is the execution path

A key action string is a **console line**, not a Lua callback:
- `UI_Lua <code>` (`Moho::CConFunc_UI_Lua`, Cfile:423593-423600) hangs all arguments
  with spaces and calls `SCR_LuaDoString(code, UI_Manager->mState)`
  (Cfile:1256278-1256324) — i.e. `host.eval` in the **UI-VM**.
- In addition, real engine commands: `UI_RenderUnitBars`, `UI_RotateLayout +`,
  `UI_RotateSkin -`, `UI_ShowRenameDialog`, `Dump_Frame`, `SetFocusArmy n`,
  `CreateUnit …` (game-shell.md:244-248).
- `ConExecute` mHelp: *„Perform a console command"* (Cfile:453271);
  `ConExecuteSave` additionally *“saved to stack”* (Cfile:453543) — the history of the
  Konsole (console.lua).

## 4. maui key events and the focus model

The event table is **the same** as the mouse — `func_CreateLuaEvent` @0x795BD0
(Cfile:1136293-1136348) always sets all fields:
`Type, MouseX, MouseY, WheelRotation, WheelDelta, KeyCode, RawKeyCode,
Modifiers{Shift,Ctrl,Alt,Left,Middle,Right}, Control`.

`EMauiEventType` complete (Cfile:1136253-1136290):
`MouseMotion=1, MouseEnter=2, MouseHover=3, MouseExit=4, ButtonPress=5,
ButtonDClick=6, ButtonRelease=7, WheelRotation=8, KeyUp=9, KeyDown=10, Char=11`.
So far we only know 1,2,4,5,6,7,8 — **`KeyDown`, `KeyUp`, `Char`, `MouseHover` are missing**.

- **`KeyCode` is a wx keycode, not VK.** `KeycodeMSWToMaui` = `wxCharCodeMSWToWX`
  (Cfile:1142082-1142100), `KeycodeMauiToMSW` = `wxCharCodeWXToMSW`. receipt on the
  Lua page: `UIUtil.VK_PAUSE = 310` (uiutil.lua:81) — this is `WXK_PAUSE`, not
  `VK_PAUSE (0x13)`. `VK_BACKSPACE=8, VK_TAB=9, VK_ENTER=13, VK_ESCAPE=27, VK_SPACE=32,
  VK_PRIOR=33, VK_NEXT=34, VK_UP=38, VK_DOWN=40` (uiutil.lua:72-81).
  `RawKeyCode` is the MSW-VK (same room as keyNames.lua).
- **`IsKeyDown(keyName)`** = `Moho::MAUI_KeyIsDown` (Cfile:1141557-1141585): liefert
  **false** if the window is not in the foreground **or** a control
  has keyboard focus; otherwise `GetKeyState(wxCharCodeWXToMSW(code)) < 0`. The argument
  is a **`EMauiKeyCode` name** (`SCR_GetEnum`), e.g. E.g. `IsKeyDown('Shift')`
  (commandmode.lua:82 — the shift queue!). The 103 names (prefix `MKEY_`):
  `BACK TAB RETURN ESCAPE SPACE DELETE START LBUTTON RBUTTON CANCEL MBUTTON CLEAR
  SHIFT ALT CONTROL MENU PAUSE CAPITAL PRIOR NEXT END HOME LEFT UP RIGHT DOWN SELECT
  PRINT EXECUTE SNAPSHOT INSERT HELP NUMPAD0…9 MULTIPLY ADD SEPARATOR SUBTRACT DECIMAL
  DIVIDE F1…F24 NUMLOCK SCROLL PAGEUP PAGEDOWN NUMPAD_*` (Cfile:1141633 ff.).
- **Keyboard-Fokus**: `MAUI_SetKeyboardFocus(control, hasFocus)` (Cfile:1141557 ff.,
  Anm.: `Moho::Maui_CurrentFocusControl` + `Moho::Maui_ControlHasFocus`). Lua-API:
  `CMauiControl:AcquireKeyboardFocus(bool)`, `:AbandonKeyboardFocus()`,
  `:GetCurrentFocusControl()`. Callbacks to Lua: **`OnLoseKeyboardFocus`**
  (Cfile:1124572) and **`OnKeyboardFocusChange`** (Cfile:1124577).
  A **ButtonPress on another control takes the focus away from the focus control**
  (Cfile:1147523-1147531).
- `CMauiEdit::HandleEvent` (Cfile:1132301-1132318) only responds to `MET_Char`
  (→ `HandleKeyEvent`) and the button events; Enter/Esc report as
  `OnEnterPressed` / `OnEscPressed` (Cfile:1132326/1132331).

**⚠️ OPEN:** The location where `MET_KeyDown/KeyUp/Char` enters the maui tree
I didn't find **posted** in the decomp — `CMauiControl::PostEvent`
(@0x787370) only has three callers, all in the mouse handler (Cfile:1147441/1147448/1147582).
What the original Lua **requires** is clear: `UIUtil.MakeInputModal`
(uiutil.lua:615-645) attaches itself to `control.HandleEvent` and checks there
`event.Type == 'KeyDown'` to `VK_ESCAPE`/`VK_ENTER` — and this control is it
**InputCapture** control that currently has *no* keyboard focus. Key events must
So (at least also) go to the **Top of Capture Stack** and from there via
Parent-Kette bubbeln.

## 5. InputCapture

`std::vector sInputCapture` (Cfile:430346). Semantik:

| Binding | mHelp / Beleg |
|---|---|
| `AddInputCapture(control)` | *„set a control as the current capture"* — Cfile:1147871 (push_back) |
| `RemoveInputCapture(control)` | *“remove the control from the capture array (always first from back)”* — Cfile:1147921, Impl. 1147071-1147115 (looking **from behind**) |
| `AnyInputCapture()` / `GetInputCapture()` | Stack abfragen — Cfile:1147773 / 1147818 |

**Effect in mouse dispatch** (Cfile:1147378-1147392): if the stack is **not empty**,
the hit test is not on the root frame, but on the **last entry**
(`back()`) started — everything outside this subtree is dead. That *is* the
Modality. A Lua state change empties the stack and terminates the running dragger
(Cfile:1273556-1273562).

User: `uiutil.MakeInputModal` (uiutil.lua:615-646, appends `RemoveInputCapture`
`OnDestroy`), splash.lua:30/49, score.lua, keybindings.lua:190/239, connectivity.lua,
objectivedetail.lua, shareresources.lua, transmissionlog.lua, campaignmovies.lua,
missiontext.lua — and `worldview.LockInput()` (worldview.lua:133-138), the one
Fullscreen `Group` sets as capture **and** makes `GetCursor():Hide()`.

*Draggers* are **separate** from: `PostDragger(originFrame, keycode, dragger)`
(Cfile:1130551), `sCurrentDragger` + `sCurrentDraggerKeycode`; the key code is only allowed
`MKEY_LBUTTON/RBUTTON/MBUTTON` (bzw. 1/2/3) sein (Cfile:1130686-1130697).
We already have that (maui.lua:519).

## 6. Current status of our engine

**Da:**
- `_c_CreateCursor` / `SetCursor` (ui-globals.lua:38-46) — create the object,
  merken es in `__cursor`; `moho.cursor_methods` (moho.lua:332-350) hat
  `SetDefaultTexture`/`ResetToDefault` genuine and extends to `SetNewTexture`
  TS-Hook `__uiSetCursorTexture` continues - **which is not set anywhere**
  (`= false`, ui-globals.lua:24; no hit in `src/ui/`). So the cursor is
  an object with no effect. `Hide`/`Show` are no-ops.
- Maus-Events komplett: `__mauiMouse` / `__mauiWheel` (maui.lua:433-490), Hit-Test +
  Parent bubbling (maui.lua:383-410), modifiers table from the browser event
  (gameUi.ts:260-276), `PostDragger` (maui.lua:519).
- `ConExecute` / `ConExecuteSave` (ui-globals.lua:648-651) — **log only**
  (`'ConExecute (nicht ausgefuehrt): …'`). This means that **every** key action is dead,
  even if the keymap came.
- `DebugFacilitiesEnabled() → false` (ui-globals.lua:655) ⇒ Debug keys are correct.

**Missing (14 globals + 3 control methods), all in `ui-globals-missing.lua`
(werfen beim Aufruf):**

| Binding | Semantics (Decomp) | Who needs it |
|---|---|---|
| `IN_AddKeyMapTable(t)` | Cfile:1259176 — `key → {action, keyRepeat}` in the map | keybindings.lua:27, lobby.lua:2867, **Engine Boot** |
| `IN_RemoveKeyMapTable(t)` | Cfile:1259267 | uimain.lua:52 (Debug-Keys) |
| `IN_ClearKeyMap()` | Cfile:1260044 | keybindings.lua:25 |
| `IsKeyDown(name)` | Cfile:1141557 — false on focus/background | **commandmode.lua:82** (shift queue) |
| `KeycodeMSWToMaui` / `KeycodeMauiToMSW` | wx↔VK, Cfile:1142082/1142029 | keybindings.lua (Tastenaufzeichnung) |
| `AddInputCapture` / `RemoveInputCapture` | Cfile:1147871/1147921 | uiutil.lua:616/620 → **every dialog** |
| `AnyInputCapture` / `GetInputCapture` | Cfile:1147773/1147818 | worldview.lua, eschandler |
| `GetCursor()` | Cfile:1274426 → the `CMauiCursor` object | worldview.lua:112/115/119/147/152 (**every mouse movement**) |
| `FlushEvents()` | *„flush mouse/keyboard events"*, Cfile:1274594 | Szenenwechsel |
| `GetMouseScreenPos` / `GetMouseWorldPos` | — | worldview.lua:194 (Target-Decal) |
| `CMauiControl:AcquireKeyboardFocus/AbandonKeyboardFocus/GetCurrentFocusControl` | Cfile:1124581/1124587/… | Edit fields, chat, console |

For `console.lua`: `AddConsoleOutputReciever`, `RemoveConsoleOutputReciever`,
`ConTextMatches` (3 weitere).

**Incorrect/Temporary:** ESC and the arrow keys are stuck in `src/main.ts:651-680` and
`:726-742` direkt am `window` (Launcher-ESC, Kamera-Pan). Sobald `EscapeHandler`
(uimain.lua:119) and `keyactions` are running, this belongs to the original Lua.

## 7. Construction order

**S1 — Make `ConExecute` real.** Command registry in TS/Lua: `UI_Lua <code>` →
`host.eval(code)` in the UI VM (Cfile:1256278); unknown command → **loud**
warn (don't swallow silently). `ConExecuteSave` = `ConExecute` + History.
*Verify:* Suite calls `ConExecute('UI_Lua LOG("hi")')` and checks the log line; a
Invented command has to work.

**S2 — Keyboard-Events in maui.** `__mauiKey(evType, keyCode, rawKeyCode, mods)` in
`maui.lua`, event table exactly like `func_CreateLuaEvent`. Routing:
Keyboard focus control, otherwise top-of-capture, otherwise root frame — then parent bubbling
like the mouse. Plus `AcquireKeyboardFocus`/`AbandonKeyboardFocus`/
`GetCurrentFocusControl` + `OnLoseKeyboardFocus`/`OnKeyboardFocusChange`.
Browser: `keydown → KeyDown`, `keyup → KeyUp`, `keypress`/`beforeinput → Char`.
*Verify:* Browser self-test — focus edit field, type, check `GetText()`.

**S3 — InputCapture stack.** Four globals; `__mauiHitTest` gets a root
(Top-of-capture instead of root frame). *Verify:* Open dialog via `MakeInputModal`,
Click next to it must **not** arrive; ESC closes it (uiutil.lua:627).

**S4 — Keymap + Hotkeys.** `IN_*` + `CUIKeyHandler`-Nachbau in `ui-globals.lua`:
`IN_ParseKeyModifiers` (split to `-`, VK from keyNames.lua, flags 0x8/0x4/0x2 0000000),
Auto-Repeat-Filter, Fokus-Sperre, `CON_Execute(action)`. Beim UI-Boot dasselbe tun
like `LoadKeyMappings` (Cfile:1259476): `keyNames.lua` → `SetKeyNameTable`,
`keymapper.GetKeyMappings()` → `AddKeyMapTable`. Browser-Keycode → VK: `KeyboardEvent.code`
is the stable way (`KeyW → 0x57`, `Digit1 → 0x31`).
*Verify:* Suite loads `keymapper.GetKeyMappings()` and verifies that **every** entry
`defaultKeyMap.lua` gets a `action` (keymapper.lua:112 warns otherwise) and
that `'Ctrl-W'` parses to `0x40000000|0x57`. Browser: Ctrl-W toggle that
Military-Panel (multifunction.lua).

**S5 — ESC/Enter.** Hotkey `escape` → `uimain.EscapeHandler()` (uimain.lua:119-127) →
`eschandler.HandleEsc()`; Enter (no mapping) → `chat.ActivateChat` (Cfile:1263522);
`~` → `uimain.ToggleConsole()` (Cfile:1262747). This is the **main menu**
bedienbar (ESC/Enter/Edit-Fokus).

**S6 — Cursor.** `GetCursor()` returns `__cursor`; `__uiSetCursorTexture` to one
real TS hook: DDS → Canvas/Blob URL → `document.body.style.cursor =
url(<png>) <hotspotX> <hotspotY>, auto`. Animation does the original Lua by itself
(cursor.lua:34-43) — she just calls `SetNewTexture` more often. Then `IsKeyDown` (S4 delivers
the button state) and `GetMouseScreenPos/GetMouseWorldPos`, then can
`worldview.lua:OnUpdateCursor` runs as a real control (but needs the WorldView
from [worldview-camera.md](worldview-camera.md)).
*Verify:* Browser self-test — after `SetupUI()` it says `body.style.cursor`
`selectable.dds`; Construction mode switches to `BUILD`.

## 8. Offene Fragen

1. **Where exactly does the engine post `MET_KeyDown/KeyUp/Char`?** (Section 4). The
   The order of focus control ↔ input capture top is *inferred* from the Lua, not
   evidenced from the decomp. Candidate: a second `wxEvtHandler` behind `CUIKeyHandler`.
   Follow up via IDA to the Xrefs of `CMauiEdit::HandleKeyEvent`.
2. **Do key events bubble?** `PostEvent` (parent chain) goes nowhere for keys
   called — yet `MakeInputModal` relies on `HandleEvent`
   of the capture control she sees.
3. **The three modifier strings** (`0x10C1D08/1D24/1D40`) are runtime-constructed
   `std::string` globals; IDA doesn't read them. "Shift/Ctrl/Alt" is from the
   Flag order + defaultKeyMap.lua:4-6 deduced, not read directly.
4. **`MET_MouseHover`** (=3) is never created by us. Who triggers it, and after
   what delay? (Tooltips are currently attached to `MouseEnter`.)
5. **`FlushEvents`** — which queue exactly (wx queue or maui)? Without knowledge of the
   Effect is a no-op here a stub, i.e. forbidden.
