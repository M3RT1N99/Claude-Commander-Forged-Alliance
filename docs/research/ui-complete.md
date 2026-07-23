# agent1

## Summary
Full inventory of the original in-game UI (lua/ui/game/* from lua.scd, "mini" layout variant that the project already uses) plus frontend (lua/ui/lobby, lua/ui/menus, lua/ui/dialogs). The project currently has 4 of ~30 UI modules: Economy, Orders (only 6 of 12 slots), UnitView, Minimap Baseform, Strategic Icons — all in a single file src/ui/hud.ts. All systems relevant to construction and commands are missing: Construction Panel (the construction menu), CommandMode/Build Preview, Cursors, Command Feedback Meshes, Rally Points, Keybindings, Selection/Control Groups, Avatars, Score, Tabs Menu Bar, Multifunction, Chat, Pings, Tooltips and the entire frontend. Without Construction + CommandMode + Cursors the game is unplayable — that's P0.

## Key Facts
- Der In-Game-UI-Baum wird von lua/ui/game/gamemain.lua:CreateUI() aufgebaut: borders.SetupBorderControl liefert 4 Layout-Container (controlClusterGroup = unteres 150px-Band, statusClusterGroup = oberes 150px-Band, mapGroup = Vollbild, windowGroup = Vollbild), an denen ALLE Panels haengen — dieses Container-Modell fehlt im Projekt komplett und ist die Voraussetzung fuer originalgetreue Positionen.
- Das Baumenue (construction.lua, 79 KB, + construction_mini.lua Layout) ist das groesste fehlende Element: 3 Haupt-Tabs (construction/selection/enhancement) links, 5 Sub-Tabs (t1/t2/t3/t4/templates), Grid mit 50px-Icons, Bau-Queue-Zeile darunter, Infinite-/Pause-Buttons; Klick links = bauen (Shift/Ctrl = 5x), rechts = aus Queue entfernen.
- Das Orders-Panel im Projekt hat nur die 6 commonOrders (Slots 1-6); das Original hat 12 Slots mit 18 weiteren Order-Caps (Reclaim Slot 10, Repair 12, Capture 11, Overcharge 7, Ferry/Nuke/Teleport 9, Transport 8, Dive 10, Dock 12) plus 9 RULEUTC_*-Toggles (Shield, Weapon, Jamming, Intel, Production, Stealth, Cloak ...) — Quelle orders.lua:697-733.
- Cursors sind vollstaendig in lua/skins/skins.lua als skins.default.cursors definiert (Format: dds-Pfad, hotspotX, hotspotY, numFrames, fps) — z.B. RULEUCC_Move = move-.dds/15/15/12 Frames/12 fps; ohne diese fehlt jedes visuelle Befehls-Feedback am Mauszeiger.
- Command-Feedback in der Welt laeuft ueber 3 Systeme: commandmode.lua (AddCommandFeedbackBlip mit Meshes aus commandmeshes.lua, ShaderName 'CommandFeedback', 0.7s Lifetime), commandgraphparams.lua (Orderline-Farben/Texturen je UNITCOMMAND_*: Move cyan 3300ffff, Attack rot, Engineering gelb) und rallypoint.lua (persistenter Rally-Mesh je Fabrik, Shader 'RallyPoint', Scale 0.10).
- Die Sim (src/sim/simWorld.ts) kennt nur UnitCommand = {type:'move'} — es gibt weder Bau, Bau-Queue, Bau-Fortschritt noch Reclaim/Repair/Attack; das Construction-Panel braucht also parallel eine Sim-Erweiterung, sonst ist es nur eine Huelle.
- Die vollstaendige Original-Hotkey-Belegung steht in lua/keymap/defaultKeyMap.lua (Kamera Q/W/Tab/V, Orders M/A/P/S/R/E/C/I/O/N/U/F/L/D + Shift-Variante fuer Queue, Gruppen 1-0 mit Ctrl=setzen/Shift=anhaengen/Ctrl-Shift=Fabriken, B=Build-Mode, F1-F11 Dialoge) und die zugehoerigen Aktionen in lua/keymap/keyactions.lua.
- Das Frontend (Hauptmenue lua/ui/menus/main.lua, Lobby lua/ui/lobby/lobby.lua 115 KB, Kartenauswahl lua/ui/dialogs/mapselect.lua, Optionen, Keybindings-Dialog) ist als eigener, spaeterer Meilenstein zu behandeln — es blockiert die Spielbarkeit nicht, solange eine feste Karte/Fraktion geladen wird.

## Details
## 0. Fundament, das VOR allen Panels fehlt

**Border-/Container-System** — `lua/ui/game/borders.lua` + `layouts/borders_mini.lua`.
`SetupBorderControl(gameParent)` gibt vier Groups zurueck, an denen jedes Panel per Anchor haengt. Im "mini"-Layout (borders_mini.lua) werden alle Rahmen-Bitmaps zerstoert (rahmenlos), und es gilt:
- `controlClusterGroup`: Left=0, Right=screenW, Bottom=screenH, **Top = Bottom − 150** → Orders + Construction leben hier.
- `statusClusterGroup`: Left=0, Top=0, Right=screenW, Height 150 → Economy lebt hier.
- `mapGroup`: Vollbild → UnitView, Avatars, Score, ControlGroups, Tabs, Timer, ConsoleEcho, HelpText, Objectives.
- `windowGroup`: Vollbild → Chat + Minimap (die beiden verschiebbaren Fenster).
Ohne diese 4 Container sind alle weiteren Offsets im Original nicht reproduzierbar. **Das ist die erste Aufgabe im Plan.**

**Layout-/Skin-Aufloesung** — `lua/ui/uiutil.lua` (`UIFile`/`SkinnableFile` → Fraktions-Skin, dann `default`), `lua/skins/skins.lua` (Fonts: `Zeroes Three` fuer Buttons/Titel, `Arial` fuer Body; fontColor je Fraktion, z.B. UEF `FFbadbdb`, Cybran `FFe24f2d`, Seraphim `FFffd700`). Das Projekt hat davon nur eine Mini-Variante (`Hud.skin()` in `src/ui/hud.ts:199`).

---

## P0 — blockiert Spielbarkeit

### 1. Construction Panel — BIGGEST MISSING PART
Quelle: `lua/ui/game/construction.lua` (79 KB) + `lua/ui/game/layouts/construction_mini.lua` (Layout).
Funktion: Zeigt fuer die Auswahl alle baubaren Einheiten, die Bau-Queue und Upgrades. Wird von `gamemain.OnSelectionChanged` ueber `GetUnitCommandData(selection)` → `buildableCategories` gefuettert.

Aufbau (construction_mini.lua):
- `constructionGroup`: Top = controlCluster.Top + 12, Bottom = controlCluster.Bottom, **Left = ordersControl.Right − 6**, Right = controlCluster.Right − 18. Liegt also rechts neben dem Orders-Panel.
- Hintergrund dreiteilig: `construct-panel_bmp_l/_m1/_m2/_m3/_r.dds` (`minBG` bei Left+67 / Bottom+4, `maxBG` rechts, `midBG3` tiled).
- Haupt-Tabs links vertikal, `AtLeftTopIn(constructionTab, constructionGroup, 0, 14)`, dann `Below(..., −16)`: **construction** (`construct-tab_btn/top_tab_btn_*`), **selection** (`mid_tab_btn_*`), **enhancement** (`bot_tab_btn_*`).
- Sub-Tabs horizontal ab `AtLeftTopIn(tab, minBG, 82, 0)`: `t1..t4` + `templates` (`construct-tech_btn/t1_btn_*` … `template_btn_*`), bei Enhancement stattdessen `LCH`/`RCH`/`Back` (`left_upgrade_btn_*`, `r_upgrade_btn_*`, `m_upgrade_btn_*`).
- `choices` = SpecialGrid, **height 50**, horizontal, Top = minBG.Top + 31 (for construction/templates) or +4 (for selection); Left = minBG.Left + 85, Right = maxBG.Right − 49. Left/right scroll buttons (`construct-sm_btn/mid_btn_*`) and page buttons (`left_btn_*`/`right_btn_*`).
- `secondaryChoices` (**construction queue line**) directly below (Top = choices.Bottom + 1, height 50), with its own progress bar 40×4 at (5, 42).
- `extraBtn1/2` bei (10, 31) in minBG: **Infinite-Bau** (`infinite_on/off.dds`) und **Queue-Pause** (`pause_on/off.dds`); im selection-Tab wird extraBtn1 zu **Template erstellen** (`template_on/off.dds`).

Verhalten (construction.lua):
- `OnSelection()` (Z. 1677): sortiert baubare Units in `t1/t2/t3/t4` nach `categories.TECH1..EXPERIMENTAL`; `CONSTRUCTIONSORTDOWN`-Units rutschen eine Stufe runter. Enhancement-Tab nur bei 1 Unit mit `bp.Enhancements`. Templates-Tab nur wenn alle Selektierten MOBILE sind.
- `FormatData()` (Z. 1405): Reihenfolge im Grid = Kategorie-Bloecke **SORTCONSTRUCTION, SORTECONOMY, SORTDEFENSE, SORTSTRATEGIC, SORTINTEL, SORTOTHER**, jeweils mit Spacer dazwischen; innerhalb sortiert nach `bp.BuildIconSortPriority ?? bp.StrategicIconSortPriority` (aufsteigend).
- `OnClickHandler()` (Z. 837): Linksklick → Upgrade (falls `bp.General.UpgradesFrom` passt) sonst `StartCommandMode('build', {name=id})` bei `Physics.MotionType == 'RULEUMT_None'` (Gebaeude) sonst `IssueBlueprintCommand("UNITCOMMAND_BuildFactory", id, count)`. **Shift oder Ctrl → count = 5.** Rechtsklick → `DecreaseBuildCountInQueue`. Queue-Stack: links +count, rechts −count.
- Icons: `GameCommon.GetUnitIconFileNames(bp)` → `/textures/ui/common/icons/units/<Display.IconName>_icon.dds` bzw. `_build_btn_up/down/over.dds`, Fallback `default_icon.dds`. Icon-Grid-Metrik: `iconBmpWidth/Height = 48`, +1px Padding → 50 (`gamecommon.lua:9-15`).

**Sim-Abhaengigkeit:** braucht in `src/sim/simWorld.ts` Bau-Queue, Bau-Fortschritt (BuildRate/BuildTime aus Blueprint), Mass/Energy-Drain waehrend Bau. Aktuell existiert nur `UnitCommand = {type:'move'}`.

### 2. CommandMode + Build-Preview/Platzierung
Quellen: `lua/ui/game/commandmode.lua`, `lua/ui/controls/worldview.lua`, `lua/ui/game/buildmode.lua`, `lua/ui/game/build_templates.lua`.
- `StartCommandMode(mode, data)` mit modes `order` / `build` / `buildanchored`; `EndCommandMode(isCancel)` ruft `ClearBuildTemplates()`.
- `OnCommandModeBeat()`: Command-Mode endet nach **einem** Befehl, ausser Shift ist gedrueckt → das ist die Queue-Mechanik.
- Geister-Gebaeude/Grid-Snap sind Engine-seitig (`SetActiveBuildTemplate`, `ClearBuildTemplates`, Cursor `BUILD`); im Nachbau muss das die eigene Renderschicht leisten: Blueprint-Mesh halbtransparent an gesnappter Position (`Footprint.SizeX/SizeZ`, Snap auf 1er-Raster, Offset 0.5 bei geraden Footprints), rot bei ungueltig.
- `buildmode.lua`: Taste **B** schaltet Build-Mode; dann waehlen Tasten 1–5 die Tech-Stufe und Buchstaben-Keys die Einheiten des aktiven Tabs (`GetUnitKeys(factoryID, techLevel)`), Grid zeigt Key-Overlays (`Construction.ShowBuildModeKeys`).
- Build-Templates: `build_templates.lua` (Speicherung in Prefs, `GenerateBuildTemplateFromSelection`, Shift-T = Template aus Auswahl, Rechtsklick auf Template → Options-Menue mit Rename/Delete/Key/Send).

### 3. Cursors
Quelle: `lua/skins/skins.lua` → `skins.default.cursors`; angewandt in `lua/ui/controls/worldview.lua:OnUpdateCursor()`.
Format `{dds, hotspotX, hotspotY, numFrames, fps}` — animierte DDS-Sprite-Strips:
`RULEUCC_Attack attack-.dds 15/15/11/12`, `Move move-.dds 12 Frames`, `Patrol patrol-.dds 5`, `Guard guard-.dds 10`, `Reclaim reclaim02-.dds 23`, `Repair repair-.dds 7`, `Capture capture-.dds 9`, `Overcharge overcharge-.dds 8`, `Transport unload-.dds 14 (Hotspot 15/3)`, `CallTransport load-.dds 14`, `Sacrifice sacrifice-.dds 13`, `Ferry/Teleport/Nuke/Tactical statisch`, `RULEUCC_Invalid attack-invalid.dds`, `BUILD selectable-.dds 7`, `DEFAULT selectable.dds (2/2)`, `HOVERCOMMAND waypoint-hover.dds`, `DRAGCOMMAND waypoint-drag.dds`, `MOVE2PATROLCOMMAND patrol.dds`, `MESSAGE message-.dds 11`, plus Resize-Cursor `NE_SW/NW_SE/N_S/W_E/MOVE_WINDOW`.
Logik in worldview.lua: bei aktivem CommandMode → Cursor des Modes; bei Hover ueber Ziel → Cursor des impliziten Befehls; Rechtsklick-Drag → `DRAGCOMMAND`; ungueltiges Ziel → `RULEUCC_Invalid`.

### 4. Command-Feedback in der Welt
- **Blips** (`commandmode.lua:OnCommandIssued`): `AddCommandFeedbackBlip({Position, MeshName, TextureName, ShaderName='CommandFeedback', UniformScale=0.125}, 0.7)`. Mesh/Textur je CommandType aus `commandmeshes.lua`: Move/Attack/Guard(=Assist)/Capture/Ferry/Nuke(Launch_Missile02)/Tactical(Launch_Missile01)/Load/Unload/Overcharge/Patrol/Reclaim/Repair/Sacrifice/Teleport. Fallback: `flag02d_lod0.scm` (Scale 0.5) + `crosshair02d_lod0.scm` (Shader `CommandFeedback2`, 0.75s). Bei `BuildMobile`: Blip mit `BlueprintID` statt Mesh, Scale 1.
- **Orderlines/Waypoints** (`commandgraphparams.lua`): pro `UNITCOMMAND_*` je `orderline_texture` (default `orderline_generic.dds`), Farben `orderline_color` / `_selected_color` / `_highlight_color`, Glow-Werte, `waypoint_texture` (`/game/waypoints/<x>_btn_up.dds`), `arrowhead_texture` `orderline_arrow04.dds`. Farbschema: Move/Default cyan (`3300ffff` / sel `dd00ffff`), Attack rot (`33ff0000`), Transport violett (`aa654bc2`), Engineering gelb (`33ffff00`), Special gruen (`3300ff00`). Patrol + Ferry haben animierte Linien (`orderline_anim_rate` 0.25 / 0.20).
- **Rally-Points** (`rallypoint.lua`): bei Auswahl von STRUCTURE+FACTORY wird der **letzte** Queue-Befehl als persistenter WorldMesh gezeigt (`rallyMeshes.Move = Rally_lod0.scm`, Shader `RallyPoint`, Scale 0.10, Lifetime-Parameter 10), pro Sim-Beat aktualisiert.

### 5. Orders-Panel vervollstaendigen (Slots 7–12 + Toggles)
Quelle: `lua/ui/game/orders.lua:697-733`. Aktuell im Projekt nur Slots 1–6 (`src/ui/hud.ts:37-44`).
Fehlend: Slot 7 `SiloBuildTactical`/`SiloBuildNuke`/`Overcharge`(mit Puls-Glow `glow-02_bmp.dds`)/`Script`; 8 `Transport`; 9 `Nuke`/`Tactical`(mit Munitionszaehler-Text via `ButtonTextFunc`)/`Teleport`/`Ferry`/`Sacrifice`; 10 `Dive`/`Reclaim`; 11 `Capture`/`DroneL`/`DroneR`; 12 `Repair`/`Dock`.
Toggles (`RULEUTC_*`): Shield(7), Weapon(7), Jamming(8), Intel(8), Production(9), Stealth(9), Generic(10), Special(11), Cloak(11).
Ausserdem: **Firestate-Popup** (`RULEUCC_RetaliateToggle`, Slot 6) mit 3 Zustaenden `return-fire` / `hold-fire` / `stand-ground` (`orders.lua:418-421`) und `RULEUCC_Pause` als Spezial-Order.

### 6. Keybindings
Quellen: `lua/keymap/defaultKeyMap.lua`, `keyactions.lua`, `keycategories.lua`, `keydescriptions.lua`.
Minimal-Set fuer Spielbarkeit: Orders **M A P S R E C I O N U F L D Z** (+ `Shift-<key>` = an Queue anhaengen), **B** Build-Mode, Kamera **Q/W** Zoom, `Shift-Q/W` schnell, **Tab/Shift-Tab/Ctrl-Tab** Kamera-Positionen, **V** Reset, **T** Track-Unit; Selektion **Ctrl-A/S/L** (Air/Naval/Land), **Ctrl-Z** alle gleichen Typs, **Ctrl-B** Engineers, **Ctrl-X** alles, **Ctrl-C** alles on-screen, **Komma** Goto-Commander, **Punkt** Cycle-Engineers, **H** naechste Fabrik; Gruppen **1–0**, `Ctrl-N` = setzen, `Shift-N` = anhaengen, `Ctrl-Shift-N` = Fabriken; **Esc**, **Pause**, **F1–F11** (F2 Score, F4 Diplomatie, F5–F8 Pings, F10 Menue).

---

## P1 — fuer normales Spielgefuehl noetig

### 7. Tabs / Menue-Leiste (oben mittig)
`lua/ui/game/tabs.lua` (34 KB) + `layouts/tabs_mini.lua`.
Drei Tabs horizontal zentriert am oberen Bildrand (`AtHorizontalCenterIn(parent, GetFrame(0))`, `AtTopIn`), Panel-Breite default **180**, Texturen `/game/options_tab/<bitmap>_btn_up|selected|over|down|dis.dds`:
1. **menu** (`content='main'`) → Menue mit Save / Load / Options / Restart / End Game / Exit / Close (Varianten fuer MP/Replay/Observer).
2. **diplomacy** → oeffnet Diplomatie-Panel (in Kampagne/Replay deaktiviert).
3. **pause** (Sonderfall: Textur-Paare `pause_btn_*` / `play_btn_*` + Glow `pause_btn/glow_bmp.dds`).
Klapp-Pfeil `tab-t-btn/tab-close|open_btn_*`. Panel-Rahmen aus `/game/options-panel/options_brd_*` (9-Slice). Ausserdem beheimatet tabs.lua den **ModeText** (z.B. "Tracking", `tracking.lua`) und `TogglePause`/`ToggleScore`/`ToggleTab`.

### 8. Avatare (rechts)
`lua/ui/game/avatars.lua` (32 KB) + `layouts/avatars_mini.lua`.
`avatarGroup` rechts oben, `AtRightTopIn(parent, 0, 200)`, Breite 200; Avatare rechtsbuendig ab (14, 14), Abstand −5; Rahmen aus `/game/bracket-right/bracket_bmp_t|m|b.dds`.
Inhalt: (a) ACU-Avatar mit Health-Balken (`SetHealthbarColor`) — Klick = Select+Zoom; (b) **Idle-Engineers-Tab** (`CreateIdleEngineerList`, `GetIdleEngineers()`, Klick zykliert per `UISelectAndZoomTo`); (c) **Idle-Factories-Tab** (`CreateIdleFactoryList`). Aktualisierung per Beat (`AvatarUpdate`).
Position ist an Score gekoppelt: `score_mini.lua` setzt `avatarGroup.Top = score.bgBottom.Bottom + 4`.

### 9. Score-Panel (rechts oben)
`lua/ui/game/score.lua` (18 KB) + `layouts/score_mini.lua`.
`AtRightTopIn(mapGroup, 18, 7)`, Breite = `panel-score_bmp_t.dds`; Hintergrund dreiteilig `panel-score_bmp_t/_m/_b.dds`, links Bracket `bracket-left-energy/*`, rechts `bracket-right/*`.
Kopfzeile: links Uhr-Icon (`/game/unit_view_icons/time.dds`, 80 % skaliert) + **Spielzeit** (`GetGameTime()`; bei `GameSpeed=adjustable` als `"MM:SS (+n)"`; bei NoRush-Option zeigt es den Countdown), rechts Panzer-Icon (`/dialogs/score-overlay/tank_bmp.dds`, 90 %) + **Unit-Count "cur/cap"**.
One line per army (width 210, height 14): faction icon 14×14 with army color as background, nickname (12 px, left, clipped), score (right). Focus Army: `ffff7f00` + Arial Bold 14. Eliminated: Skull `icon-skull_bmp.dds`, Gray `ffa0a0a0`. Rows are sorted **each beat in descending order by score**. Folding arrow `tab-r-btn/*`.

### 10. Multifunction / Filter + Ping-Leiste (links, unter Economy)
`lua/ui/game/multifunction.lua` (41 KB) + `layouts/multifunction_mini.lua`.
`Below(economy.GUI.bg, 5)`, `AtLeftIn(parent, 15)`; Panel `filter-ping-panel/filter-ping-panel02_bmp.dds`.
Obere Reihe (ab (15, 6)): **4 Ping-Buttons** — alert / move / attack / marker (`ping-alert|move|attack|marker`), setzen den Cursor (`RULEUCC_Guard|Move|Attack|MESSAGE`) und feuern `ping.DoPing(type)`.
Untere Reihe (ab (3, 33)): **4 Overlay-Buttons** — `control` (Map-Optionen-Dropout: Strategic View, Minimap-Resources, Rollover/Selection/BuildPreview-Ranges), `team-color` (`TeamColorMode`), `economy` (`RenderOverlayEconomy`, Params in `econoverlayparams.lua`: gruen `FF00D000` / rot, Bar-Texturen `econ_bmp_l/m/r.dds`), `military-radar` (Waffenreichweiten-Overlay mit Dropout, Params in `rangeoverlayparams.lua`).

### 11. UnitViewDetail (Rollover-Detailpanel)
`lua/ui/game/unitviewDetail.lua` (13 KB) + `layouts/unitviewDetail_mini.lua` (12 KB).
Erscheint beim Hover ueber ein Bau-Icon oder eine Einheit: Name, Tech-Level, Beschreibung, Faehigkeiten-Liste (`GetAbilityList`), **Kosten (Mass/Energy) + Bauzeit** (`DisplayResources(bp, time, energy, mass)`), Upkeep/Yield, Shield-Werte. Texte aus `lua/ui/help/unitdescription.lua` (59 KB) und `lua/ui/help/tooltips.lua` (82 KB).

### 12. Selection-Uebersicht bei Mehrfachauswahl
Ist der **selection-Tab** des Construction-Panels (`construction.lua:FormatData`, `type='selection'`): gruppiert die Auswahl nach BlueprintId zu `unitstack`-Buttons mit Anzahl; Linksklick = nur diese Untergruppe selektieren, Rechtsklick = diese aus der Auswahl entfernen. Air-Units mit `GetFuelRatio() < 0.2` werden separat als `lowFuel` gelistet. Sekundaerzeile zeigt dann `attached` (Transport-Insassen).
Zusaetzlich: `selection.lua` (Selection-Sets + `PlaySelectionSound` aus `bp.Audio.UISelection`).

### 13. Control-Groups (rechts, unter Avataren)
`lua/ui/game/controlgroups.lua` + `layouts/controlgroups_mini.lua`.
Container `AtTopIn(parent, 368)`, `AtRightIn(parent)`, Breite 60; pro belegter Gruppe ein Icon-Button (Doppel-Tap = `UIZoomTo`). Logik in `selection.lua`: `AddSelectionSet` / `ApplySelectionSet` (Double-Tap-Erkennung < 1.0 s), `AppendSetToSelection`, `FactorySelection`.

---

## P2 — Komfort / Multiplayer

- **Chat** — `chat.lua` (59 KB) + `layouts/chat_layout.lua`: verschiebbares/resizable Fenster im `windowGroup`, Zeilen mit Armee-Farbe, Scroll, Config-Fenster (Filter, Fade-Zeit), Enter = aktivieren, `ReceiveChat` via `gamemain.RegisterChatFunc`.
- **Pings/Marker** — `ping.lua`: `PingTypes = {alert (6 s, ring_yellow02-blur), move (6 s, blau), attack (6 s, rot), marker (5 s, benannt, persistent)}`; Marker-Namensdialog; Ping-Ring-Texturen `/game/marker/ring_*.dds`; `pingGroup.lua` = gruppierte Ping-Liste am Rand (Klick = Kamera hinspringen).
- **Objectives** — `objectives2.lua` (35 KB) + `layouts/objectives2_mini.lua`: Kampagnen-Zielliste links oben mit Icons, Fortschritt, Tooltip-Popup; nur im `campaignMode` erzeugt.
- **Timer** — `timer.lua`: Panel `AtRightIn(parent, 3)`, Top+5, `timer-panel_bmp.dds` + `clock_bmp.dds` (bei 6,6) + Text 18 px bei clockIcon.Right+5; `FormatTime` → `HH:MM:SS`; unter 30 s pulsierendes Glow (`glow-02_bmp.dds`, Alpha 0→0.3, Rate 2/s).
- **Diplomatie** — `diplomacy.lua` (26 KB): Spielerzeilen mit Buttons "Verbuendeter Sieg", Allianz-Angebot (`allianceOffer.lua`), **Ressourcen teilen** (`CreateShareResourcesDialog` → `shareResources.lua`: Slider fuer Mass/Energy-Anteil an einen Spieler).
- **Announcement** — `announcement.lua`: mittiger Einblende-Text mit Zielsteuerung auf ein Control (z. B. "No Rush Time Elapsed", "Build Template Received").
- **Console-Echo** — `consoleecho.lua`: 5 Zeilen (Pref `console_size`), horizontal zentriert, unterste bei `parent.Bottom − 180`, Font "Zeroes Three" 12, Farbe `FFbadbdb`, Fade nach 3 s.
- **Tooltips** — `tooltip.lua`: `CreateMouseoverDisplay(parent, ID, delay, extended)`; Text aus `lua/ui/help/tooltips.lua`; zeigt zusaetzlich die **gebundene Taste** aus `defaultKeyMap` in Klammern; erweiterte Variante mit Titel + Beschreibung; Farben aus dem Skin (`tooltipBorderColor` etc.).
- **Konsole** — `lua/ui/dialogs/console.lua`.

## P3 — Rahmen / Fenster / Nebensysteme
- **Minimap als echtes Window** — `minimap.lua` + `layouts/minimap_mini.lua`: `Window`-Control im `windowGroup`, verschiebbar + resizable ueber 4 Drag-Handles (`/game/drag-handle/drag-handle-ul|ur|ll|lr_btn_up|over|down.dds`), Rahmen `mini-map-brd/*` (9-Slice, borderColor `ff415055`), Glow-Rahmen `mini-map-glow-brd/*`; Client-Inset: Left+8/Top+4/Right−8/Bottom−6. Projekt hat nur statischen Rahmen (`src/ui/hud.ts:315-334`).
- **Zoom-Slider** — `zoomslider.lua`: vertikaler Slider rechts unten (`/game/zoom-control_bmp/*`), 5–95; plus Kamera-Positions-Speicher (Tab/Shift-Tab/Ctrl-Tab) und `ToggleWideView`.
- **Connectivity** — `connectivity.lua`: Ping/Lag-Anzeige im MP.
- **Rename** — `rename.lua` (Ctrl-N, Einheit umbenennen); **ConfirmUnitDestroy** (`confirmunitdestroy.lua`, Ctrl-K).
- **Replay-Leiste** — `replay.lua` + `layouts/replay_mini.lua` (Geschwindigkeits-Slider, Pause).
- **GameResult** — `gameresult.lua` (Sieg/Niederlage-Screen) + `lua/ui/dialogs/score.lua` (51 KB, Endstatistik mit Graphen).
- **Split-Screen** — `borders.SplitMapGroup(true)` (Home/End), zwei WorldViews (`WorldCamera`/`WorldCamera2`).

## P4 — Frontend (eigener Meilenstein, blockiert nichts)
- **Hauptmenue** — `lua/ui/menus/main.lua` (42 KB): Hintergrund-Movie + Buttons Campaign / Skirmish / LAN / Matchmaking / Extras (Replay, Mods, Credits, EULA) / Options / Exit.
- **Skirmish-Setup / Lobby** — `lua/ui/lobby/lobby.lua` (115 KB) + `gamecreate.lua`, `lobbyOptions.lua` (Spieloptionen-Definitionen), `aitypes.lua`, `aiNames.lua`, `restrictedUnitsDlg.lua`; Slots, Fraktion, Farbe, Team, Handicap, Chat.
- **Kartenauswahl** — `lua/ui/dialogs/mapselect.lua` (28 KB) + `lua/ui/maputil.lua` (Scenario-Parser `_scenario.lua`) + `lua/ui/controls/mappreview.lua`.
- **Optionen-Dialog** — `lua/ui/dialogs/options.lua` (21 KB); **Keybindings-Dialog** — `lua/ui/dialogs/keybindings.lua` (20 KB, nutzt `keycategories`/`keydescriptions`).
- **Sonstige Dialoge** — `saveload.lua`, `modmanager.lua`, `disconnect.lua`, `createunit.lua` (Debug-Spawner), `profile.lua`.

## Empfohlene Reihenfolge fuer den Implementierungsplan
1. Border-Container (4 Groups) + Skin/Layout-Aufloesung sauber aus `hud.ts` herausziehen (eigene Module pro Panel).
2. Sim: Bau-Queue + Bau-Fortschritt + Ressourcen-Drain; CommandMode-State-Machine.
3. Construction-Panel (construction + selection Tab; enhancement/templates spaeter).
4. Cursors + Build-Preview/Grid-Snap + Command-Feedback-Blips + Orderlines + Rally-Points.
5. Orders-Panel auf 12 Slots + Toggles + Firestate-Popup.
6. Keybindings (defaultKeyMap-Subset) + Control-Groups + Selection-Sets.
7. Tabs-Leiste (Pause/Menue), Score, Avatare (Idle-Engineers), Multifunction, UnitViewDetail, Tooltips.
8. Chat, Pings, Announcement, Timer, Diplomatie.
9. Frontend.

## Refs
- lua.scd → lua/ui/game/gamemain.lua (CreateUI Z.116-192: Modul-Reihenfolge; SetLayout Z.53-75; HideGameUI Z.455)
- lua.scd → lua/ui/game/borders.lua + lua/ui/game/layouts/borders_mini.lua (controlCluster Bottom−150, statusCluster Top+150, mapGroup/windowGroup Vollbild)
- lua.scd → lua/ui/game/construction.lua (OnSelection Z.1677, FormatData Z.1405, OnClickHandler Z.837, unitGridPages Z.29-35, constructionTabs Z.61)
- lua.scd → lua/ui/game/layouts/construction_mini.lua (panel geometry, tab positions Z.398-436, choices height 50 Z.130, OnTabChangeLayout Z.438)
- lua.scd → lua/ui/game/orders.lua Z.697-733 (standardOrdersTable: 12 preferredSlots + 9 RULEUTC-Toggles), Z.418-421 (Firestate-Modi)
- lua.scd → lua/ui/game/commandmode.lua (StartCommandMode/EndCommandMode, OnCommandIssued → AddCommandFeedbackBlip, orderModes/toggleModes-Referenztabellen)
- lua.scd → lua/ui/game/commandmeshes.lua + commandgraphparams.lua (Meshes je CommandType; Orderline-Farben/Waypoint-Texturen je UNITCOMMAND_*)
- lua.scd → lua/ui/game/rallypoint.lua (WorldMesh, Shader 'RallyPoint', UniformScale 0.10)
- lua.scd → lua/skins/skins.lua (skins.default.cursors: complete cursor table with hotspots/frames/FPS; fonts + colors per faction)
- lua.scd → lua/ui/controls/worldview.lua (OnUpdateCursor Z.131-202, DecalFunctions Z.28-90, ApplyCursor Z.234)
- lua.scd → lua/keymap/defaultKeyMap.lua (complete original key mapping) + lua/keymap/keyactions.lua (console actions per binding)
- lua.scd → lua/ui/game/tabs.lua Z.34-56 (tabs: menu/diplomacy/pause) + Z.58+ (menus.main) + layouts/tabs_mini.lua (Panel-Breite 180, oben zentriert)
- lua.scd → lua/ui/game/score.lua (SetupPlayerLines Z.114, _OnBeat Z.226 sorting/colors) + layouts/score_mini.lua (AtRightTopIn 18/7, clock + unit count)
- lua.scd → lua/ui/game/avatars.lua (CreateAvatarUI Z.46, CreateIdleEngineerList Z.419, CreateIdleFactoryList Z.556) + layouts/avatars_mini.lua (rechts, Top 200, Breite 200)
- lua.scd → lua/ui/game/multifunction.lua Z.60-135 (overlays: control/team-color/economy/military-radar; pings: alert/move/attack/marker) + layouts/multifunction_mini.lua
- lua.scd → lua/ui/game/ping.lua Z.15-20 (PingTypes) + lua/ui/game/pingGroup.lua
- lua.scd → lua/ui/game/tooltip.lua (CreateMouseoverDisplay Z.23, hotkey display) + lua/ui/help/tooltips.lua (82 KB texts) + lua/ui/help/unitdescription.lua
- lua.scd → lua/ui/game/timer.lua, consoleecho.lua, announcement.lua, zoomslider.lua, tracking.lua, connectivity.lua, rename.lua, gameresult.lua
- lua.scd → lua/ui/game/chat.lua + layouts/chat_layout.lua; lua/ui/game/diplomacy.lua + shareResources.lua + allianceOffer.lua
- lua.scd → lua/ui/game/minimap.lua + layouts/minimap_mini.lua (window with drag handles, frame mini-map-brd/*)
- lua.scd → lua/ui/game/gamecommon.lua (iconBmpWidth/Height 48 + 1px padding; GetUnitIconFileNames → /textures/ui/common/icons/units/<IconName>_icon|_build_btn_up|down|over.dds)
- lua.scd → lua/ui/game/buildmode.lua + build_templates.lua (Taste B, Tech-Keys, Template-Verwaltung in Prefs)
- lua.scd → lua/ui/menus/main.lua, lua/ui/lobby/lobby.lua, lua/ui/lobby/lobbyOptions.lua, lua/ui/dialogs/mapselect.lua, options.lua, keybindings.lua, score.lua
- Project: C:\Users\Marti\Documents\02Projekte\Claude Commander Forged Alliance\src\ui\hud.ts (current status: Economy Z.230-249, Orders Z.251-285 only 6 slots, UnitView Z.287-299, Minimap Z.301-334, Strategic Icons Z.121-196)
- Project: C:\Users\Marti\Documents\02Projekte\Claude Commander Forged Alliance\src\sim\simWorld.ts:153 (UnitCommand only knows 'move' - construction/queue/reclaim are completely missing)
- Projekt: C:\Users\Marti\Documents\02Projekte\Claude Commander Forged Alliance\src\sandbox\sandbox.ts:85-320 (SandboxController: spawn/clickSelect/boxSelect/commandMove/stopSelected/selectedCaps/hudUnits)
- Extracted original sources (read only, for reference): C:\Users\Marti\AppData\Local\Temp\claude\c--Users-Marti-Documents-02Projekte-Claude-Commander-Forged-Alliance\795d25b0-6aed-4269-81c5-1f3b66283dbf\scratchpad\lua\
