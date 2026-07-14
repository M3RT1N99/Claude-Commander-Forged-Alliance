# WorldView & Kamera — die Weltansicht ist ein maui-Control

**Kernsatz:** In FA ist die Spielwelt kein Sonderfall neben der UI, sondern ein
**Control im selben maui-Baum** — `Moho::CUIWorldView`, abgeleitet von
`CMauiControl` (vftable @0x86E480-Region, Cfile:397420-397449: `Draw`,
`SetHidden`, `HitTest`, `HandleEvent`, `OnFrame` — alles Control-Slots). Jeder
Klick in die Welt ist ein maui-Event an dieses Control. Es gibt keinen zweiten
Eingabepfad.

Die Lua-Seite: `WorldView = Class(moho.UIWorldView, Control)`
(`lua/ui/controls/worldview.lua:96`). `Control` hat **kein** `__init` —
konstruiert wird über `moho.UIWorldView.__init`, also den C++-Ctor.

---

## 1. Was die Engine tut, was die Lua tut

| | Engine (C++) | Original-Lua |
|---|---|---|
| Control erzeugen | `CUIWorldView::CUIWorldView` @**0x86E480** | `WorldView(mapGroup, 'WorldCamera', 1, false)` (worldview.lua:37/56) |
| Kamera | `RCamManager::CreateCamera(name)` **im Ctor** | `GetCamera('WorldCamera')` |
| Maus → Welt/Unit | `CUIWorldView::UpdateSelection` @**0x86F520** | — |
| Event-Verzweigung | `CUIWorldView::HandleEvent` @**0x8704B0** | `WorldView:HandleEvent` (nur Cursor!) |
| „Was heißt der Klick?" | `CWldSession::GetLeftMouseButtonAction` @**0x81F7B0**, `func_GetRightMouseButtonAction` @**0x81EC00** | **liefert den Modus**: `commandmode.lua:GetCommandMode()` |
| Befehl absetzen | `SCommandModeData::HandleEvent` @**0x81FCD0** (29× `ISSUE_Command`, 5× `ISSUE_FactoryCommand`) | Rückmeldung: `commandmode.lua:OnCommandIssued` |
| Cursor/Reticle | ruft `OnUpdateCursor` jeden Frame | `WorldView:OnUpdateCursor` (worldview.lua:131) |

**Der Command-Mode lebt in der Lua, nicht in der Engine.**
`Moho::UI_GetCommandMode` @**0x83DDA0** macht wörtlich:
`SCR_Import("/lua/ui/game/commandmode.lua")["GetCommandMode"]()` und liest
`ret[1]` (String) und `ret[2]` (Table). Gegenstück:
`UI_StartCommandMode` @0x83DF90, `UI_EndCommandMode` @0x83E080 (ruft
`EndCommandMode`), `UI_OnCommandIssued` @0x83E770 (ruft `OnCommandIssued`).
Auch `worldview.lua:IsInputLocked()` wird von der **Engine** gerufen
(Cfile:1262798-1262815 — der Kommentar in worldview.lua:169 sagt es selbst).

---

## 2. Callchain: ein Klick in die Welt

`CUIWorldView::HandleEvent` @0x8704B0 (Cfile:1299476-1299975), in dieser Reihenfolge:

1. `MET_MouseEnter/Exit` → `v86e` (Maus im Control), Formation zurücksetzen.
2. **`UpdateSelection(this, mousePos)` — VOR der Lua.** (Cfile:1299571-1299580)
3. `CMauiControl::HandleEvent(...)` → **das ist der Aufruf der Lua-`HandleEvent`**.
   Liefert sie `true`, oder ist `mInputLocks > 0`, endet alles hier (Cfile:1299583).
   Die Lua-Ebene liegt also **innerhalb** der C++-Ebene, nicht davor.
4. Cursor-Texte (`"<LOC Engine0007>Double left-click for coordinated attack"`,
   `"<LOC Engine0009>Left-click to convert moves into patrol"`).
5. `MET_WheelRotation` → Command-Mode aktiv? dann `SCommandModeData::HandleEvent`,
   sonst `Camera:SetPivot(mausPos)` + `Camera:Zoom(rot/delta)` (Cfile:1299680-1299700).
6. `MET_MouseMotion` → `SPACE` gedrückt (+ `cam_Free` oder Zoom < `ren_BgLowerBound`=125)
   ⇒ `Camera:Spin(delta)`, sonst `Camera:RevertRotation()`. Immer: `Camera:SetPivot`.
7. `MET_ButtonPress` **KeyCode 2** (Mitte) → `CameraDragger` via `func_PostDragger` (Pan).
8. `MET_ButtonPress` **KeyCode 1** (links) → `GetLeftMouseButtonAction` → Switch:
   | `mMode` | Aktion |
   |---|---|
   | `COMMOD_None` (0) | nichts |
   | `COMMOD_Order` (1) | `sub_870310` @0x870310: Formation wählen → `SCommandModeData::HandleEvent` → Befehl |
   | `COMMOD_Build` (2) / `COMMOD_BuildAnchored` (3) | `func_NewUIBuildDragger` @0x823CB0 |
   | (4) „Select" | Minimap? `CMiniMapDragger` : `func_NewSelectionDragger2D` @0x865880 (Gummiband) |
   | (5) „CommandDrag" | `func_NewCommandDragger` @0x8242B0 (Befehlsmarke im Command-Graph verschieben) |
9. `MET_ButtonDClick` KeyCode 1 → bei Mode 1: Befehl; bei Mode 4:
   `CWldSession::HandleDoubleClickSelection` (alle gleichen Typs im Bild).
10. **KeyCode 3 (rechts)**, Press/DClick → `func_GetRightMouseButtonAction`; nur wenn
    `COMMOD_Order` **und** Selektion nicht leer → `CFormation::ProcessMouse` @0x838800
    (Rechtsklick-Ziehen = Formation ausrichten).
11. `MET_ButtonRelease` KeyCode 3 → **jetzt** `SCommandModeData::HandleEvent` (Befehl geht raus).
    Ctrl+Shift auf eine Befehlsmarke ⇒ `ISSUE_RemoveCommandFromUnitQueue` statt Befehl.

`CUIWorldView::OnFrame` @**0x871140** (Cfile:1299977-1300000):
`UpdateSelection(cursorInfo.mMouseScreenPos)` **und dann**
`RunScript("OnUpdateCursor")` — so kommt worldview.lua:131 zum Zug. Danach
Tastatur-Pan/Rotate (`ui_KeyboardPanSpeed` = 90, `…AccelerateMultiplier` = 4,
`ui_KeyboardRotateSpeed` = 10, `…Multiplier` = 2; Cfile:421739-421742).
Außerdem `RunScriptBool("OnIconsVisible", …)` (Cfile:1300081).

### `GetLeftMouseButtonAction` — die Übersetzung Lua-Modus → Engine-Modus

Cfile:1240587-1240695:

| `GetCommandMode()[1]` | Engine | Daten aus `[2]` |
|---|---|---|
| `"order"` | `COMMOD_Order` | `data.name` → `RULEUCC_*` per **Lexical** des Enums `ERuleBPUnitCommandCaps`. Sonderfall: `RULEUCC_Transport` + Hover-Unit hat `RULEUCC_Transport` ⇒ wird zu `RULEUCC_CallTransport`. |
| `"build"` | `COMMOD_Build` | `data.name` → `GetUnitBlueprint(name)`; ohne gültiges bp bleibt der Modus `None` |
| `"buildanchored"` | `COMMOD_BuildAnchored` | dito |
| `"ping"` | `COMMOD_Ping` | — |
| `""` (kein Modus) | `4` (Select) bzw. `5`, wenn der Cursor auf einer Befehlsmarke steht (`mIsDragger != -1`) | — |
| sonst | `Warnf("CUIActionHandler::GetLeftMouseButtonAction got invalid commandMode: %s")` | — |

Vorbedingung für **alles**: `cursorInfo.mInWorld` (Cfile:1240553) — der Strahl muss
das Gelände treffen. Sonst `COMMOD_None`.

### `UpdateSelection` @0x86F520 — die Cursor-Wahrheit

Schreibt `mWldSession->mCursorInfo` (`Moho::UICursorInfo`):
`mMouseScreenPos` (Vector2), `mMouseWorldPos` (Vector3), `mInWorld` (bool),
`mUnitHover`, `mIsDragger`.

- Weltpunkt: `Camera->CameraScreenToSurface(out, mouse)`; `mInWorld = IsValid_Vector3f(out)`.
- Unit unter dem Cursor: `Camera->Unproject(...)` → `GeomLine3` → `Wm3::IntrLine3Box3f`
  gegen die Mesh-Boxen, **aufgeweitet um `ui_SelectTolerance`** (Cfile:1298979-1298981).

Daraus speisen sich `GetMouseWorldPos()` (@0x842C30: liest schlicht
`sWldSession->mCursorInfo.mMouseWorldPos`, Fehler „No session started." ohne Session)
und `GetRolloverInfo()`.

---

## 3. Der Ctor — er tut mehr, als man denkt

`moho.UIWorldView:__init(parent_control, cameraName, depth, isMiniMap, trackCamera)`
(mHelp, Cfile:1300210). Cfile:1298140-1298350:

1. `CMauiControl::CMauiControl(this, luaobj, parent, "World View")` — der Control-Name
   ist **immer** `"World View"`; das zweite Argument ist der **Kameraname**.
2. `RCamManager::CreateCamera(name, map, luaState)` — **die Kamera entsteht hier**,
   nicht anderswo. `GetCamera('WorldCamera')` findet danach genau diese.
3. `name == "WorldCamera"` ⇒ `func_SetWorldCamera(cam)` (die globale Kamera).
4. `isMiniMap` ⇒ `SetLODScale(cam_DefaultMiniLOD)`, `CanShake(false)`.
5. `WRenViewport::AddWorldView(view, eventMapper, depth)` — Render- **und** Event-Registrierung.
6. `mNeedsFrameUpdate = 1`.
7. Liest `import('/lua/ui/controls/worldview.lua').WorldViewParams` und setzt daraus die
   ConVars — **nur diese drei**: `ui_SelectTolerance` (Lua 7.0, Engine-Default 4.0),
   `ui_DisableCursorFixing`, `ui_ExtractSnapTolerance` (Lua 4.0, Default 20.0).
   `ui_MinExtractSnapPixels`/`ui_MaxExtractSnapPixels` aus derselben Lua-Tabelle werden
   hier **ignoriert** (Cfile:1298295-1298345).

`Register(cameraName, …)` (worldview.lua:580) hängt danach nur noch Prefs an
(`<cam>_cartographic_mode`, `<cam>_resource_icons`) und `SetMaxZoomMult(defaultZoom)`.

---

## 4. Kamera-API

`GetCamera(name)` (global, mHelp `"GetCamera(name)"`, Cfile:1151852) → `CameraImpl`
(25 Methoden). Namen im Spiel: `WorldCamera`, `WorldCamera2` (Split), `MiniMap`,
`CameraHead2` (multihead.lua:32).

Das Kameramodell steht in `SaveSettings` (Cfile:1153090-1153150) — es setzt genau
vier Felder:

```lua
{ Focus = Vector3, Zoom = number, Pitch = number, Heading = number }
```

`RestoreSettings(settings)` liest sie zurück (chat.lua:280, zoomslider.lua:103,
worldview.lua:498-500). **Das ist die vollständige Kamera.**

Zoom ist eine **Distanz in Weltmetern**, kein Faktor: `unittext.lua:31` vergleicht
`GetTargetZoom() > 130`. Weitere Belege aus der Lua:
`GetZoom`/`GetTargetZoom`/`SetTargetZoom`/`GetMinZoom`/`GetMaxZoom`,
`SetMaxZoomMult(gamemain.defaultZoom)` (worldview.lua:594),
`MoveTo(position, orientationHPR, zoom, seconds)`, `SnapTo(position, hpr, zoom)`,
`MoveToRegion(region[,seconds])` (objectives2.lua:337), `Spin(headingRate[,zoomRate])`,
`Reset`, `HoldRotation`/`RevertRotation`, `TrackEntities(ents,zoom,seconds)`,
`NoseCam(ent,pitchAdjust,zoom,seconds,transition)`.

`/lua/usercamera.lua` ist der Sim→UI-Kanal: `Sync.CameraRequests` → `GetCamera(v.Name)[v.Exec](cam, unpack(v.Params))`.

---

## 5. Fehlende Engine-Bindungen

**83 Bindungen** (13 Globals + 70 Klassen-Methoden). Alle 13 Globals stehen heute in
[src/engine-lua/ui-globals-missing.lua](../../src/engine-lua/ui-globals-missing.lua)
und werfen beim Aufruf.

| Bindung | Semantik (Decomp) | Beleg | Braucht |
|---|---|---|---|
| `moho.UIWorldView:__init` | Control + **Kamera** erzeugen, Viewport registrieren, WorldViewParams→ConVars | 0x86E480 | controls/worldview.lua:96 |
| `UIWorldView:Project(v3)` → Vector2 | Welt → **Control**-Koordinaten (nicht Screen!) | mHelp @1301174 | worldview.lua:242, unittext, ping |
| `UnProject(view, v2)` → Vector3 | **global**, arg1 = View: `view:GetCamera():Unproject(v2)` | 0x872CE0, mClassName `<global>` | worldview.lua:342 |
| `UIWorldView:GetScreenPos(unit)` | Vector2 oder nil | mHelp @1300952 | avatars, unittext |
| `UIWorldView:ZoomScale(x,y,rot,delta)` | Rad-Zoom auf Pivot (x,y) | mHelp @1300847 | worldview.lua:176 |
| `LockInput`/`UnlockInput`/`IsInputLocked` | Zähler `mInputLocks`; >0 ⇒ HandleEvent verschluckt alles | Cfile:1299583 | worldview.lua:133-172, gamemain:143 |
| `GetsGlobalCameraCommands(bool)` | `mGlobalCameraCommands` — nimmt Tastatur-Kamerabefehle an | Cfile:1300446 | worldview.lua:41/60 |
| `SetCartographic`/`IsCartographic` | Ortho-Ansicht (`CRenderWorldView::SetOrthographic`) | vftable Cfile:397448 | worldview.lua:191 |
| `EnableResourceRendering`/`IsResourceRenderingEnabled` | Ressourcen-Icons im View | — | minimap.lua:126, multifunction:455 |
| `SetHighlightEnabled` / `HasHighlightCommand` | Hover-Highlight für Befehlsziele | — | worldview.lua:158, 182 |
| `GetRightMouseButtonOrder()` → string | `RULEUCC_*`, was ein Rechtsklick jetzt täte | mHelp @1300466 | worldview.lua:165 |
| `ShowConvertToPatrolCursor()` → bool | Move-Kette → Patrol (siehe LOC Engine0009) | mHelp @1300584 | worldview.lua:139/159 |
| `CameraReset()` | `Camera:Reset()` auf der View-Kamera | mHelp @1300357 | — |
| `GetCamera(name)` → CameraImpl (**25 Methoden**) | Kamera-Registry (`CAM_GetCamera`); Modell = `{Focus,Zoom,Pitch,Heading}` | `cfunc_GetCameraL` @**0x7AB100**, `SaveSettings` Cfile:1153090-1153150 | worldview, zoomslider, usercamera, chat |
| `GetMouseWorldPos()` | `cursorInfo.mMouseWorldPos` | 0x842C30 | worldview:194, ping:26 |
| `GetMouseScreenPos()` | `cursorInfo.mMouseScreenPos` | mHelp @1266396 | ping, pinggroup |
| `UIZoomTo(units[,sec])` / `UISelectAndZoomTo(unit[,sec])` | `Camera:TargetEntityBox(...)` | Cfile:1292660-1292715 | selection.lua:111, avatars:42 |
| `UISelectionByCategory(expr, addToCurSel, inViewFrustum, nearestToMouse, …)` | Selektion per Kategorie/Frustum | mHelp @1292494 | Hotkeys |
| `GetCursor()` → **CMauiCursor** (5) | `SetTexture`/`Reset`/`Show`/`Hide` | Klassenliste engine-api.md | worldview.lua:112-119 (**jeder** MouseMotion) |
| `_c_CreateDecal` → **ScriptedDecal** (5) | Boden-Decal: `SetTexture`, `SetScale`, `SetPosition`, `SetPositionByScreen` | mohodata `user/userdecal.lua` | Ziel-Reticle, worldview.lua:184 |
| `InternalCreateDragger` + `PostDragger` → **CMauiLuaDragger** (1) | Lua-Dragger; die Welt-Dragger (Select/Build/Command) sind **C++** | Cfile:1299811-1299854 | worldview.lua:325 (Ping-Marker) |
| `InternalCreateWorldMesh` → **CUIWorldMesh** (16) | Mesh in der Welt (Rallypunkt, Tutorial-Marker) | controls/worldmesh.lua:26 | rallypoint.lua:24 |
| `InternalCreateWldUIProvider` → **CLuaWldUIProvider** (1) | Engine ruft `CreateGameInterface`, `StartLoadingDialog`, … zurück | wlduiprovider.lua:13 | gamemain.lua:225 |

Zusätzlich blockieren (nicht WorldView-eigen, aber von worldview.lua gebraucht):
`GetValidAttackingUnits` (Reticle-Größe), `EntityCategoryContains`, `IsKeyDown`,
`GetNumRootFrames`.

---

## 6. Ist-Stand

**Da:** [src/engine-lua/maui.lua](../../src/engine-lua/maui.lua) hat Hit-Test,
MouseEnter/Exit-Erzeugung, Event-Bubbling (`__mauiDispatch`) und eine Frame-Pumpe —
das Substrat steht. `GetRolloverInfo`, `GetSelectedUnits`/`SelectUnits`,
`GetUnitCommandData`, `AddCommandFeedbackBlip`, `SetOverlayFilter*` liegen in
[ui-globals.lua](../../src/engine-lua/ui-globals.lua).
[src/viewer/unitViewer.ts](../../src/viewer/unitViewer.ts) kann bereits
`pickTerrain` (Strahl → Gelände), `pickUnit`, `worldToScreen`, `heightAt` und führt eine
RTS-Kamera als `{ target, dist, pitchOffset }` — das ist fast `{Focus, Zoom, Pitch}`.

**Falsch/fehlend:**

1. **Die Welt ist kein Control.** `maui.lua:344-356` gesteht es offen ein: „Bei uns ist
   die Welt (noch) kein maui-Control — ein Treffer auf einen reinen Container bedeutet
   daher dasselbe wie dort: der Klick gehört der Welt." Das ist eine Heuristik an der
   Stelle, an der das Original ein echtes Control hat.
2. **Der Klick läuft an der Lua vorbei.** `main.ts:575-640` verdrahtet
   `pointerdown`/`contextmenu`/`wheel` direkt auf `viewer` und
   [worldCommands.ts](../../src/ui/worldCommands.ts). Dort steht die Verzweigung in TS
   nach — inklusive „Rechtsklick = Move" als Festwert (`worldClick`, Zeile 125), während
   die Engine dafür `GetRightMouseButtonAction` fragt.
3. **Keine Kamera in der Lua.** `GetCamera` wirft. Damit fällt jede Datei aus, die die
   Kamera anfasst: zoomslider, minimap, avatars, unittext, chat-Kamera-Sprünge, usercamera.
4. **Kein `UpdateSelection`.** Es gibt keinen `cursorInfo`-Zustand; `GetMouseWorldPos()`
   existiert nicht, das Ziel-Reticle und der Hover-Cursor können nicht funktionieren.
5. **Selektion per TS** (`selectLua` in main.ts) statt über den Selection-Dragger.
6. `worldCommands.ts` bildet den Raster-Snap korrekt ab (`COORDS_GridSnap`) — der Code
   ist **richtig**, steht nur an der falschen Stelle: im Original macht das der
   `UIBuildDragger`, nicht die UI.

---

## 7. Bau-Reihenfolge

Jeder Schritt ist für sich prüfbar. Reihenfolge ist Semantik: ohne Kamera kein Ctor,
ohne Ctor kein Control, ohne `cursorInfo` kein Klick.

**S1 — Kamera (`GetCamera` + CameraImpl).**
Eine `camera.lua` in `src/engine-lua/` + Bridge auf `unitViewer`. Zustand exakt
`{Focus, Zoom, Pitch, Heading}`. Zuerst nur: `SaveSettings`, `RestoreSettings`,
`GetFocusPosition`, `GetZoom`/`GetTargetZoom`/`SetZoom`/`SetTargetZoom`,
`GetMinZoom`/`GetMaxZoom`/`SetMaxZoomMult`, `Reset`, `MoveTo`, `SnapTo`.
*Verify:* `verify-camera.ts` — `SaveSettings()` → `RestoreSettings()` ist idempotent;
`zoomslider.lua` lädt und schaltet ohne Fehler.

**S2 — `moho.UIWorldView:__init` + das Control.**
Neue `src/engine-lua/worldview.lua`: `__init(parent, cameraName, depth, isMiniMap,
trackCamera)` legt das Control an (wie `InternalCreateGroup`), **erzeugt die Kamera unter
`cameraName`**, liest `WorldViewParams` (die drei ConVars) und registriert die View.
`mauiRenderer` gibt ihm ein transparentes `<div>`; der Three.js-Canvas wird auf dessen
Rechteck gelegt. Dann läuft `CreateMainWorldView(gameParent, mapGroup)` (worldview.lua:22)
als Teil von `setupGameUi()` — an derselben Stelle wie gamemain.lua:142.
*Verify:* `verify-worldview.ts` — nach `setupGameUi` ist
`import('/lua/ui/game/worldview.lua').viewLeft` ein Control, `MapControls['WorldCamera']`
gesetzt; `LockInput()`/`UnlockInput()` schalten `IsInputLocked()` um.
Die Heuristik in `maui.lua:344-356` **fällt weg** — das ist der Beweis, dass es sitzt.

**S3 — `cursorInfo` + `UpdateSelection`.**
Bei jeder Mausbewegung (und in der Frame-Pumpe, wenn die Maus im View steht):
`mMouseWorldPos` aus `pickTerrain`, `mInWorld` aus dem Treffer, `mUnitHover` aus
`pickUnit` **mit `ui_SelectTolerance`-Aufweitung**. Danach `Project`/`UnProject`,
`GetMouseWorldPos`, `GetMouseScreenPos`, `GetScreenPos`.
*Verify:* `Project(UnProject(view, Vector2(x,y)))` ≈ `(x,y)` auf ±1 px, quer über den
Bildschirm — der ehrlichste Test, den die Kamera zulässt.

**S4 — `OnFrame` → `OnUpdateCursor` + `GetCursor()`.**
Erst jetzt zieht der Cursor um (worldview.lua:131-204). Braucht `GetCursor()` →
CMauiCursor und `_c_CreateDecal` → ScriptedDecal fürs Ziel-Reticle.
*Verify:* Browser `?selftest=cursor` — Bau-Modus an ⇒ BUILD-Cursor; Move-Order ⇒
Move-Cursor; Maus raus ⇒ Reset.

**S5 — `HandleEvent` in der richtigen Schachtelung.**
In `worldview.lua` (engine-lua): `UpdateSelection` → `control:HandleEvent(event)` (die
Original-Klasse!) → nur wenn `false` **und** `mInputLocks == 0` die Engine-Zweige.
Zuerst nur zwei: **Links-Press mit Command-Mode** (`GetLeftMouseButtonAction` in Lua
nachgezogen: `GetCommandMode()` lesen, `order`/`build`/`buildanchored` unterscheiden) und
**Rechts-Release ohne Command-Mode** (`GetRightMouseButtonAction` → Default-Order).
Am Ende `OnCommandIssued`. `worldCommands.ts` wird dabei **aufgelöst**: der Snap wandert
in den Build-Dragger, die Modus-Verzweigung entfällt (sie steht in der Lua).
*Verify:* `verify-command-chain.ts` umschreiben — nicht mehr `worldClick(...)` aufrufen,
sondern ein `__mauiMouse('ButtonPress', x, y)` auf die WorldView feuern und prüfen, dass
die Fabrik an der gerasterten Stelle entsteht. Der Test prüft dann den echten Pfad.

**S6 — Dragger.** `SelectionDragger2D` (Gummiband), `UIBuildDragger` (mit Snap +
Bau-Vorschau), `CameraDragger` (Mitteltaste). Alle drei sind im Original **C++** — sie
gehören in die Engine, nicht in die Lua.

**S7 — Rest:** `WorldMesh` (Rallypunkt), `WldUIProvider`, Minimap als zweite WorldView
(`isMiniMap=true`), Split-View.

---

## 8. Offene Fragen

1. **`COMMOD_*`-Enumwerte.** Aus dem Code abgeleitet: `None=0`, `Order=1`, `Build=2`,
   `BuildAnchored=3`, Select=4, CommandDrag=5 (Cfile:1299788-1299855 + der DClick-Zweig
   `mMode-1 == 0 → Order`, `== 3 → Select`). **`COMMOD_Ping` ist nicht belegt** — der Wert
   ist unbekannt.
2. **`CameraScreenToSurface` vs. `Unproject`.** Beide werden in `UpdateSelection`
   benutzt; ob `ScreenToSurface` die Wasseroberfläche mit einbezieht (relevant für
   Klicks aufs Meer) ist nicht nachgelesen. Auch die Kopplung Pitch↔Zoom (SupCom kippt
   die Kamera beim Zoomen) steckt in `CameraImpl` und ist noch nicht ausgelesen —
   `unitViewer.rtsPitch()` erfindet dafür heute eine eigene Kurve.
3. **`SetRenderPass(UIUtil.UIRP_UnderWorld | UIUtil.UIRP_PostGlow)`** (worldview.lua:39)
   mit dem Original-Kommentar *„don't change this or the camera will lag one frame
   behind"*: Die Welt wird **zwischen** UI-Render-Pässen gezeichnet. Was das für unseren
   DOM-über-Canvas-Renderer heißt (Z-Reihenfolge, Ein-Frame-Versatz) ist offen.
4. **Wer ruft `IsInputLocked()`?** Die Engine tut es (Cfile:1262798) — an welcher Stelle
   des Frames, ist nicht nachgesehen. Für uns: vor der Event-Zustellung.
5. **`ui_SelectTolerance` in Pixeln oder Weltmetern?** In `UpdateSelection` weitet er die
   Box **vor** dem Strahltest auf (Cfile:1298979), was auf Screen-Pixel deutet — nicht
   verifiziert.
