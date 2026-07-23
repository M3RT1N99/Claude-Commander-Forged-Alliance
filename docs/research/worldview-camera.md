# WorldView & Camera — the world view is a Maui control

**Key statement:** In FA, the game world is not a special case next to the UI, but a
**Control in the same maui tree** — `Moho::CUIWorldView`, derived from
`CMauiControl` (vftable @0x86E480-Region, Cfile:397420-397449: `Draw`,
`SetHidden`, `HitTest`, `HandleEvent`, `OnFrame` — all control slots). Everyone
Click into the world is a Maui event on this control. There is no second
Eingabepfad.

The Lua page: `WorldView = Class(moho.UIWorldView, Control)`
(`lua/ui/controls/worldview.lua:96`). `Control` has **no** `__init` —
is constructed via `moho.UIWorldView.__init`, i.e. the C++ Ctor.

---

## 1. What the engine does, what the Lua does

| | Engine (C++) | Original Lua |
|---|---|---|
| Create control | `CUIWorldView::CUIWorldView` @**0x86E480** | `WorldView(mapGroup, 'WorldCamera', 1, false)` (worldview.lua:37/56) |
| Camera | `RCamManager::CreateCamera(name)` **in Ctor** | `GetCamera('WorldCamera')` |
| Mouse → World/Unit | `CUIWorldView::UpdateSelection` @**0x86F520** | — |
| Event branch | `CUIWorldView::HandleEvent` @**0x8704B0** | `WorldView:HandleEvent` (cursor only!) |
| "What does the click mean?" | `CWldSession::GetLeftMouseButtonAction` @**0x81F7B0**, `func_GetRightMouseButtonAction` @**0x81EC00** | **provides the mode**: `commandmode.lua:GetCommandMode()` |
| Issue command | `SCommandModeData::HandleEvent` @**0x81FCD0** (29× `ISSUE_Command`, 5× `ISSUE_FactoryCommand`) | Feedback: `commandmode.lua:OnCommandIssued` |
| Cursor/Reticle | calls `OnUpdateCursor` every frame | `WorldView:OnUpdateCursor` (worldview.lua:131) |

**Command mode lives in Lua, not in the engine.**
`Moho::UI_GetCommandMode` @**0x83DDA0** literally does:
`SCR_Import("/lua/ui/game/commandmode.lua")["GetCommandMode"]()` and reads
`ret[1]` (String) and `ret[2]` (Table). Counterpart:
`UI_StartCommandMode` @0x83DF90, `UI_EndCommandMode` @0x83E080 (ruft
`EndCommandMode`), `UI_OnCommandIssued` @0x83E770 (ruft `OnCommandIssued`).
`worldview.lua:IsInputLocked()` is also called by the **Engine**
(Cfile:1262798-1262815 — the comment in worldview.lua:169 says it itself).

---

## 2. Callchain: one click into the world

`CUIWorldView::HandleEvent` @0x8704B0 (Cfile:1299476-1299975), in this order:

1. `MET_MouseEnter/Exit` → `v86e` (mouse in control), reset formation.
2. **`UpdateSelection(this, mousePos)` — BEFORE the Lua.** (Cfile:1299571-1299580)
3. `CMauiControl::HandleEvent(...)` → **this is the call to the Lua-`HandleEvent`**.
   If it returns `true`, or is `mInputLocks > 0`, everything ends here (Cfile:1299583).
   So the Lua layer is **within** the C++ layer, not in front of it.
4. Cursor texts (`"<LOC Engine0007>Double left-click for coordinated attack"`,
   `"<LOC Engine0009>Left-click to convert moves into patrol"`).
5. `MET_WheelRotation` → Command mode active? then `SCommandModeData::HandleEvent`,
   otherwise `Camera:SetPivot(mausPos)` + `Camera:Zoom(rot/delta)` (Cfile:1299680-1299700).
6. `MET_MouseMotion` → `SPACE` pressed (+ `cam_Free` or Zoom < `ren_BgLowerBound`=125)
   ⇒ `Camera:Spin(delta)`, otherwise `Camera:RevertRotation()`. Always: `Camera:SetPivot`.
7. `MET_ButtonPress` **KeyCode 2** (Mitte) → `CameraDragger` via `func_PostDragger` (Pan).
8. `MET_ButtonPress` **KeyCode 1** (links) → `GetLeftMouseButtonAction` → Switch:
   | `mMode` | Aktion |
   |---|---|
   | `COMMOD_None` (0) | nothing |
   | `COMMOD_Order` (1) | `sub_870310` @0x870310: Select formation → `SCommandModeData::HandleEvent` → Command |
   | `COMMOD_Build` (2) / `COMMOD_BuildAnchored` (3) | `func_NewUIBuildDragger` @0x823CB0 |
   | (4) “Select” | Minimap? `CMiniMapDragger` : `func_NewSelectionDragger2D` @0x865880 (rubber band) |
   | (5) „CommandDrag" | `func_NewCommandDragger` @0x8242B0 (Befehlsmarke im Command-Graph verschieben) |
9. `MET_ButtonDClick` KeyCode 1 → at Mode 1: Command; at mode 4:
   `CWldSession::HandleDoubleClickSelection` (all of the same type in the picture).
10. **KeyCode 3 (right)**, Press/DClick → `func_GetRightMouseButtonAction`; only if
    `COMMOD_Order` **and** selection not empty → `CFormation::ProcessMouse` @0x838800
    (Rechtsklick-Ziehen = Formation ausrichten).
11. `MET_ButtonRelease` KeyCode 3 → **now** `SCommandModeData::HandleEvent` (command goes out).
    Ctrl+Shift on a command marker ⇒ `ISSUE_RemoveCommandFromUnitQueue` instead of command.

`CUIWorldView::OnFrame` @**0x871140** (Cfile:1299977-1300000):
`UpdateSelection(cursorInfo.mMouseScreenPos)` **and then**
`RunScript("OnUpdateCursor")` — this is how worldview.lua:131 comes into play. Thereafter
Keyboard Pan/Rotate (`ui_KeyboardPanSpeed` = 90, `…AccelerateMultiplier` = 4,
`ui_KeyboardRotateSpeed` = 10, `…Multiplier` = 2; Cfile:421739-421742).
Außerdem `RunScriptBool("OnIconsVisible", …)` (Cfile:1300081).

### `GetLeftMouseButtonAction` — the translation Lua mode → Engine mode

Cfile:1240587-1240695:

| `GetCommandMode()[1]` | Engine | Data from `[2]` |
|---|---|---|
| `"order"` | `COMMOD_Order` | `data.name` → `RULEUCC_*` via **Lexical** of the enum `ERuleBPUnitCommandCaps`. Special case: `RULEUCC_Transport` + hover unit has `RULEUCC_Transport` ⇒ becomes `RULEUCC_CallTransport`. |
| `"build"` | `COMMOD_Build` | `data.name` → `GetUnitBlueprint(name)`; without a valid bp the mode remains `None` |
| `"buildanchored"` | `COMMOD_BuildAnchored` | dito |
| `"ping"` | `COMMOD_Ping` | — |
| `""` (no mode) | `4` (Select) or `5` if the cursor is on a command mark (`mIsDragger != -1`) | — |
| otherwise | `Warnf("CUIActionHandler::GetLeftMouseButtonAction got invalid commandMode: %s")` | — |

Prerequisite for **everything**: `cursorInfo.mInWorld` (Cfile:1240553) — the beam must
hit the terrain. Otherwise `COMMOD_None`.

### `UpdateSelection` @0x86F520 — the cursor truth

Schreibt `mWldSession->mCursorInfo` (`Moho::UICursorInfo`):
`mMouseScreenPos` (Vector2), `mMouseWorldPos` (Vector3), `mInWorld` (bool),
`mUnitHover`, `mIsDragger`.

- Weltpunkt: `Camera->CameraScreenToSurface(out, mouse)`; `mInWorld = IsValid_Vector3f(out)`.
- Unit under the cursor: `Camera->Unproject(...)` → `GeomLine3` → `Wm3::IntrLine3Box3f`
  against the mesh boxes, **expanded by `ui_SelectTolerance`** (Cfile:1298979-1298981).

This is what `GetMouseWorldPos()` (@0x842C30: simply reads).
`sWldSession->mCursorInfo.mMouseWorldPos`, error "No session started." without session)
and `GetRolloverInfo()`.

---

## 3. The Ctor - he does more than you think

`moho.UIWorldView:__init(parent_control, cameraName, depth, isMiniMap, trackCamera)`
(mHelp, Cfile:1300210). Cfile:1298140-1298350:

1. `CMauiControl::CMauiControl(this, luaobj, parent, "World View")` — the control name
   is **always** `"World View"`; the second argument is the **camera name**.
2. `RCamManager::CreateCamera(name, map, luaState)` — **the camera is created here**,
   not elsewhere. `GetCamera('WorldCamera')` then finds exactly that.
3. `name == "WorldCamera"` ⇒ `func_SetWorldCamera(cam)` (the global camera).
4. `isMiniMap` ⇒ `SetLODScale(cam_DefaultMiniLOD)`, `CanShake(false)`.
5. `WRenViewport::AddWorldView(view, eventMapper, depth)` — Render **and** event registration.
6. `mNeedsFrameUpdate = 1`.
7. Reads `import('/lua/ui/controls/worldview.lua').WorldViewParams` and sets the
   ConVars — **only these three**: `ui_SelectTolerance` (Lua 7.0, Engine Default 4.0),
   `ui_DisableCursorFixing`, `ui_ExtractSnapTolerance` (Lua 4.0, Default 20.0).
   `ui_MinExtractSnapPixels`/`ui_MaxExtractSnapPixels` from the same Lua table
   hier **ignoriert** (Cfile:1298295-1298345).

`Register(cameraName, …)` (worldview.lua:580) then only appends prefs
(`<cam>_cartographic_mode`, `<cam>_resource_icons`) and `SetMaxZoomMult(defaultZoom)`.

---

## 4. Kamera-API

`GetCamera(name)` (global, mHelp `"GetCamera(name)"`, Cfile:1151852) → `CameraImpl`
(25 methods). Names in game: `WorldCamera`, `WorldCamera2` (Split), `MiniMap`,
`CameraHead2` (multihead.lua:32).

The camera model is in `SaveSettings` (Cfile:1153090-1153150) — it sets exactly
four fields:

```lua
{ Focus = Vector3, Zoom = number, Pitch = number, Heading = number }
```

`RestoreSettings(settings)` reads them back (chat.lua:280, zoomslider.lua:103,
worldview.lua:498-500). **This is the full camera.**

Zoom is a **distance in world meters**, not a factor: `unittext.lua:31` compares
`GetTargetZoom() > 130`. Further evidence from the Lua:
`GetZoom`/`GetTargetZoom`/`SetTargetZoom`/`GetMinZoom`/`GetMaxZoom`,
`SetMaxZoomMult(gamemain.defaultZoom)` (worldview.lua:594),
`MoveTo(position, orientationHPR, zoom, seconds)`, `SnapTo(position, hpr, zoom)`,
`MoveToRegion(region[,seconds])` (objectives2.lua:337), `Spin(headingRate[,zoomRate])`,
`Reset`, `HoldRotation`/`RevertRotation`, `TrackEntities(ents,zoom,seconds)`,
`NoseCam(ent,pitchAdjust,zoom,seconds,transition)`.

`/lua/usercamera.lua` is the Sim→UI channel: `Sync.CameraRequests` → `GetCamera(v.Name)[v.Exec](cam, unpack(v.Params))`.

---

## 5. Missing engine bindings

**83 bindings** (13 globals + 70 class methods). All 13 Globals are in place today
[src/engine-lua/ui-globals-missing.lua](../../src/engine-lua/ui-globals-missing.lua)
and throw when called.

| Bindung | Semantik (Decomp) | Beleg | Braucht |
|---|---|---|---|
| `moho.UIWorldView:__init` | Control + **Camera** create, register viewport, WorldViewParams→ConVars | 0x86E480 | controls/worldview.lua:96 |
| `UIWorldView:Project(v3)` → Vector2 | World → **Control** coordinates (not Screen!) | mHelp @1301174 | worldview.lua:242, unittext, ping |
| `UnProject(view, v2)` → Vector3 | **global**, arg1 = View: `view:GetCamera():Unproject(v2)` | 0x872CE0, mClassName `<global>` | worldview.lua:342 |
| `UIWorldView:GetScreenPos(unit)` | Vector2 or nil | mHelp @1300952 | avatars, unittext |
| `UIWorldView:ZoomScale(x,y,rot,delta)` | Wheel Zoom to Pivot (x,y) | mHelp @1300847 | worldview.lua:176 |
| `LockInput`/`UnlockInput`/`IsInputLocked` | counter `mInputLocks`; >0 ⇒ HandleEvent swallows everything | Cfile:1299583 | worldview.lua:133-172, gamemain:143 |
| `GetsGlobalCameraCommands(bool)` | `mGlobalCameraCommands` — accepts keyboard camera commands | Cfile:1300446 | worldview.lua:41/60 |
| `SetCartographic`/`IsCartographic` | Ortho-Ansicht (`CRenderWorldView::SetOrthographic`) | vftable Cfile:397448 | worldview.lua:191 |
| `EnableResourceRendering`/`IsResourceRenderingEnabled` | Resource icons in View | — | minimap.lua:126, multifunction:455 |
| `SetHighlightEnabled` / `HasHighlightCommand` | Hover-Highlight für Befehlsziele | — | worldview.lua:158, 182 |
| `GetRightMouseButtonOrder()` → string | `RULEUCC_*`, what a right click would do now | mHelp @1300466 | worldview.lua:165 |
| `ShowConvertToPatrolCursor()` → bool | Move-Kette → Patrol (siehe LOC Engine0009) | mHelp @1300584 | worldview.lua:139/159 |
| `CameraReset()` | `Camera:Reset()` on the View Camera | mHelp @1300357 | — |
| `GetCamera(name)` → CameraImpl (**25 methods**) | Camera Registry (`CAM_GetCamera`); Model = `{Focus,Zoom,Pitch,Heading}` | `cfunc_GetCameraL` @**0x7AB100**, `SaveSettings` Cfile:1153090-1153150 | worldview, zoomslider, usercamera, chat |
| `GetMouseWorldPos()` | `cursorInfo.mMouseWorldPos` | 0x842C30 | worldview:194, ping:26 |
| `GetMouseScreenPos()` | `cursorInfo.mMouseScreenPos` | mHelp @1266396 | ping, pinggroup |
| `UIZoomTo(units[,sec])` / `UISelectAndZoomTo(unit[,sec])` | `Camera:TargetEntityBox(...)` | Cfile:1292660-1292715 | selection.lua:111, avatars:42 |
| `UISelectionByCategory(expr, addToCurSel, inViewFrustum, nearestToMouse, …)` | Selektion per Kategorie/Frustum | mHelp @1292494 | Hotkeys |
| `GetCursor()` → **CMauiCursor** (5) | `SetTexture`/`Reset`/`Show`/`Hide` | Class list engine-api.md | worldview.lua:112-119 (**any** MouseMotion) |
| `_c_CreateDecal` → **ScriptedDecal** (5) | Bottom decal: `SetTexture`, `SetScale`, `SetPosition`, `SetPositionByScreen` | mohodata `user/userdecal.lua` | Target reticle, worldview.lua:184 |
| `InternalCreateDragger` + `PostDragger` → **CMauiLuaDragger** (1) | Lua Dragger; the world draggers (Select/Build/Command) are **C++** | Cfile:1299811-1299854 | worldview.lua:325 (ping marker) |
| `InternalCreateWorldMesh` → **CUIWorldMesh** (16) | Mesh in the world (rally point, tutorial marker) | controls/worldmesh.lua:26 | rallypoint.lua:24 |
| `InternalCreateWldUIProvider` → **CLuaWldUIProvider** (1) | Engine recalls `CreateGameInterface`, `StartLoadingDialog`, … | wlduiprovider.lua:13 | gamemain.lua:225 |

Additionally block (not WorldView's own, but used by worldview.lua):
`GetValidAttackingUnits` (Reticle-Größe), `EntityCategoryContains`, `IsKeyDown`,
`GetNumRootFrames`.

---

## 6. Current status

**Da:** [src/engine-lua/maui.lua](../../src/engine-lua/maui.lua) hat Hit-Test,
MouseEnter/Exit generation, event bubbling (`__mauiDispatch`) and a frame pump —
the substrate is standing. `GetRolloverInfo`, `GetSelectedUnits`/`SelectUnits`,
`GetUnitCommandData`, `AddCommandFeedbackBlip`, `SetOverlayFilter*` liegen in
[ui-globals.lua](../../src/engine-lua/ui-globals.lua).
[src/viewer/unitViewer.ts](../../src/viewer/unitViewer.ts) can already
`pickTerrain` (beam → terrain), `pickUnit`, `worldToScreen`, `heightAt` and leads one
RTS camera as `{ target, dist, pitchOffset }` — that's almost `{Focus, Zoom, Pitch}`.

**Falsch/fehlend:**

1. **The world is not a control.** `maui.lua:344-356` admits it openly: “With us
   the world does not (yet) have Maui control - a hit on a pure container means
   therefore the same as there: the click belongs to the world." That's a heuristic on the
   Place where the original has a real control.
2. **The click passes the Lua.** `main.ts:575-640` wired
   `pointerdown`/`contextmenu`/`wheel` directly on `viewer` and
   [worldCommands.ts](../../src/ui/worldCommands.ts). There is the branch in TS
   after — including “Right click = Move” as a fixed value (`worldClick`, line 125), while
   the engine for this asks `GetRightMouseButtonAction`.
3. **No camera in the Lua.** `GetCamera` throws. This means that every file containing the
   Kamera anfasst: zoomslider, minimap, avatars, unittext, chat-Kamera-Sprünge, usercamera.
4. **No `UpdateSelection`.** There is no `cursorInfo` state; `GetMouseWorldPos()`
   does not exist, the target reticle and hover cursor cannot work.
5. **Selection via TS** (`selectLua` in main.ts) instead of using the selection dragger.
6. `worldCommands.ts` correctly maps the raster snap (`COORDS_GridSnap`) — the code
   is **correct**, it's just in the wrong place: in the original it does that
   `UIBuildDragger`, not the UI.

---

## 7. Construction order

Each step can be tested individually. Order is semantics: no camera, no ctor,
without Ctor no control, without `cursorInfo` no click.

**S1 — Kamera (`GetCamera` + CameraImpl).**
A `camera.lua` in `src/engine-lua/` + Bridge on `unitViewer`. Exact condition
`{Focus, Zoom, Pitch, Heading}`. First just: `SaveSettings`, `RestoreSettings`,
`GetFocusPosition`, `GetZoom`/`GetTargetZoom`/`SetZoom`/`SetTargetZoom`,
`GetMinZoom`/`GetMaxZoom`/`SetMaxZoomMult`, `Reset`, `MoveTo`, `SnapTo`.
*Verify:* `verify-camera.ts` — `SaveSettings()` → `RestoreSettings()` is idempotent;
`zoomslider.lua` charges and switches without errors.

**S2 — `moho.UIWorldView:__init` + the control.**
Neue `src/engine-lua/worldview.lua`: `__init(parent, cameraName, depth, isMiniMap,
trackCamera)` legt das Control an (wie `InternalCreateGroup`), **creates the camera under
`cameraName`**, reads `WorldViewParams` (the three ConVars) and registers the view.
`mauiRenderer` gives it a transparent `<div>`; the Three.js canvas is on its
rectangle laid. Then `CreateMainWorldView(gameParent, mapGroup)` (worldview.lua:22) runs
as part of `setupGameUi()` — in the same location as gamemain.lua:142.
*Verify:* `verify-worldview.ts` — after `setupGameUi` is
`import('/lua/ui/game/worldview.lua').viewLeft` a control, `MapControls['WorldCamera']`
set; `LockInput()`/`UnlockInput()` switch `IsInputLocked()`.
The heuristic in `maui.lua:344-356` **drops out** — that is proof that it works.

**S3 — `cursorInfo` + `UpdateSelection`.**
With every mouse movement (and in the frame pump when the mouse is in the view):
`mMouseWorldPos` from `pickTerrain`, `mInWorld` from the hit, `mUnitHover` from
`pickUnit` **mit `ui_SelectTolerance`-Aufweitung**. Danach `Project`/`UnProject`,
`GetMouseWorldPos`, `GetMouseScreenPos`, `GetScreenPos`.
*Verify:* `Project(UnProject(view, Vector2(x,y)))` ≈ `(x,y)` to ±1 px, across the
Screen — the most honest test the camera allows.

**S4 — `OnFrame` → `OnUpdateCursor` + `GetCursor()`.**
Only now does the cursor move to (worldview.lua:131-204). Needs `GetCursor()` →
CMauiCursor and `_c_CreateDecal` → ScriptedDecal for the target reticle.
*Verify:* Browser `?selftest=cursor` — Build mode on ⇒ BUILD cursor; Move order ⇒
Move-Cursor; Maus raus ⇒ Reset.

**S5 — `HandleEvent` in the correct nesting.**
In `worldview.lua` (engine-lua): `UpdateSelection` → `control:HandleEvent(event)` (the
Original class!) → only if `false` **and** `mInputLocks == 0` are the engine branches.
First just two: **Left-Press with Command Mode** (`GetLeftMouseButtonAction` in Lua
tightened: read `GetCommandMode()`, distinguish between `order`/`build`/`buildanchored`) and
**Right release without command mode** (`GetRightMouseButtonAction` → default order).
In the end `OnCommandIssued`. `worldCommands.ts` is **dissolved**: the snap moves
into the build dragger, the mode branch is omitted (it is in the Lua).
*Verify:* Rewrite `verify-command-chain.ts` — no longer call `worldClick(...)`,
but fire a `__mauiMouse('ButtonPress', x, y)` at the WorldView and check that
the factory is built at the gridded location. The test then checks the real path.

**S6 — Dragger.** `SelectionDragger2D` (Gummiband), `UIBuildDragger` (mit Snap +
Construction preview), `CameraDragger` (middle button). All three are in the original **C++** — them
belong in the engine, not in the Lua.

**S7 — Rest:** `WorldMesh` (rally point), `WldUIProvider`, Minimap as second WorldView
(`isMiniMap=true`), Split-View.

---

## 8. Offene Fragen

1. **`COMMOD_*` enum values.** Derived from code: `None=0`, `Order=1`, `Build=2`,
   `BuildAnchored=3`, Select=4, CommandDrag=5 (Cfile:1299788-1299855 + the DClick branch
   `mMode-1 == 0 → Order`, `== 3 → Select`). **`COMMOD_Ping` is not assigned** — the value
   is unknown.
2. **`CameraScreenToSurface` vs. `Unproject`.** Both are converted into `UpdateSelection`
   used; whether `ScreenToSurface` includes the water surface (relevant for
   Clicks on the sea) has not been looked up. The Pitch↔Zoom (SupCom) coupling also tilts
   the camera when zooming) is in `CameraImpl` and has not yet been read out -
   `unitViewer.rtsPitch()` is inventing its own curve today.
3. **`SetRenderPass(UIUtil.UIRP_UnderWorld | UIUtil.UIRP_PostGlow)`** (worldview.lua:39)
   with the original comment *“don't change this or the camera will lay one frame
   behind"*: The world is drawn **between** UI render passes. What this means for our
   DOM over canvas renderer called (Z order, one frame offset) is open.
4. **Who calls `IsInputLocked()`?** The engine does it (Cfile:1262798) — at what point
   of the frame, has not been checked. For us: before event delivery.
5. **`ui_SelectTolerance` in pixels or world meters?** In `UpdateSelection` he expands the
   Box **before** the beam test on (Cfile:1298979), which indicates screen pixels - not
   verifiziert.
