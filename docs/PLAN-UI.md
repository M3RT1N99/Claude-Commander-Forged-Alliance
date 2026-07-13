# Weg zur echten `lua/ui` — Plan

Erstellt nach einem Audit des Browser-Pfads + Recherche in Original-Lua und Decomp.
Jede Zeile hier ist belegt (Datei:Zeile bzw. Cfile-Zeile), nichts geraten.

## Ausgangslage

Die **Sim ist echt**: Worker → `installEngine()` → Original-`unit.lua`, Waffen aus
den Skript-Klassen, echtes `AIBrain`, Zwei-Ratio-Ökonomie. Die **UI ist ein Fake**:
`src/ui/hud.ts` (454 Zeilen TS) + `src/style.css` (601 Zeilen) bauen
`economy_mini.lua`, `orders_mini.lua` und `unitview.lua` nach — die Pixelwerte sind
aus der Original-Lua *abgeschrieben* statt sie auszuführen.

Der Weg zur echten `lua/ui` führt über **zwei Dinge**:

1. Eine **zweite Lua-VM im Main-Thread** (wie im Original: `scr_UserInits` ≠
   `sim_SimInits`, Cfile:422253/422444; `Moho::USER_GetLuaState` @0x8C65B0).
2. Ein **maui-Substrat**: die `InternalCreate*`-Globals, LazyVar-Instanzen,
   Event-Pump, Text-Metriken.

Steht das Substrat, ist jede weitere `lua/ui`-Datei fast geschenkt. `construction.lua`
allein sind 1700 Zeilen, die man sonst von Hand nachbauen müsste.

---

## Teil 0 — Quick Wins (vorher, löschen mehr als sie bauen)

Regel: **nichts Neues in `hud.ts`.** Diese Punkte beheben Bugs, entfernen Lügen oder
bauen Substrat, das die spätere `lua/ui` ohnehin braucht.

| # | Was | Datei | Warum jetzt |
|---|-----|-------|-------------|
| Q1 | `luaHookRegistered` wird nie zurückgesetzt, `clearContent()` killt alle Update-Hooks → **ab dem 2. Sandbox-Start bewegt sich nichts mehr** | main.ts:686 | Reproduzierbarer Totalausfall |
| Q2 | Worker-`reset` (neuer LuaHost + `installEngine()`) | luaSimWorker.ts | 2. Start = 2. ACU = doppeltes `GiveInitialResources` |
| Q3 | **Terrain in die Sim**: `setTerrainSource()` wird **nie gerufen** → `GetTerrainHeight` liefert überall still 0. Ohne Quelle muss es **knallen**. | engineGlobals.ts:25, globals.lua, motion.lua | Verbotener stiller Stub. Voraussetzung für Schritt 6 (`GetElevation` beim Platzieren) |
| Q4 | Spawn exakt auf dem `ARMY_n`-Marker (`+6/+6`-Offset und Default `(20,0,20)` raus) | main.ts:336, 742 | Erfundene Zahlen |
| Q5 | Werbelügen raus: „Box-Selektion", „Shift = Warteschlange", Kosmetik-Rechteck, toter Multi-Select-Zweig | index.html, main.ts, hud.ts | Box-Select kommt als `worldview.lua`, nicht als TS |
| Q6 | Tote CSS-Leichen (style.css:456-590) — sie **überschreiben** die als „1:1 verifiziert" deklarierten Werte | style.css | Layout behauptet verifiziert zu sein und ist es still nicht |
| Q7 | Order-Attrappen (`action: undefined`) als `disabled` rendern | hud.ts:36-43 | Ehrlichkeit, kein Ausbau |
| Q8 | `requested()` mitsenden + `NaN`-Guard bei `max == 0` | worker, hud.ts:390 | `lastUseRequested` ist Pflichtfeld für `GetEconomyTotals()` |
| Q9 | Armeefarben **nicht** in TS „korrigieren" — `lua/gamecolors.lua` wird in Schritt 3 importiert | hud.ts:158 | Ein zweiter erfundener Wert ersetzt keinen ersten |

Nicht anfassen (Schritt 2+ wirft es weg): Minimap-Rahmen, Icon-Tinting, Unit-View-Ausbau.

---

## Das minimale C++-Substrat (mit Decomp-Beleg)

### A. Zweite Lua-VM (UI)
`Moho::USER_GetLuaState()` @0x8C65B0 (Cfile:1368027): eigener State, dann
`scr_CoreInits` (Cfile:1368069) **und** `scr_UserInits` (Cfile:1368082).
70 Core-Globals in beiden VMs, 460 User-Globals **nur** hier, 668 Sim-Globals **nie**.
Einstieg: `SCR_Import('/lua/ui/uimain.lua')['SetupUI']()` (Cfile:1262316), später
`func_StartGameUI` @0x83D240 → `gamemain.CreateWldUIProvider()`.

### B. LazyVar — **nicht nachbauen**
`lua/lazyvar.lua` liegt in `mohodata.scd` und ist Original-Lua. C++ liefert nur die
*Instanzen*: `CMauiControl::CMauiControl` @0x7867B0 erzeugt sieben
`CScriptLazyVar_float` und veröffentlicht sie ins Lua-Table (Cfile:1123966-1123972):
`Left, Right, Top, Bottom, Width, Height, Depth`. `CMauiBitmap` zusätzlich
`BitmapWidth`/`BitmapHeight` (Cfile:1118538), gesetzt aus den Texturmaßen
(Cfile:1118647) — deshalb bemisst sich ein Bitmap per Default nach seiner DDS.

### C. `InternalCreate*` (für Schritt 3 reichen vier)
| Global | Cfile | DoInit |
|--------|-------|--------|
| `InternalCreateFrame` | 1136866 | 1136917 |
| `InternalCreateGroup` | 1137468 | 1137536 |
| `InternalCreateBitmap` | 1119519 | 1119577 |
| `InternalCreateText` | 1146210 | 1146271 |

Muster überall gleich: Lua legt die Tabelle an → C++ hängt sich als Peer dran → am
Ende `DoInit()`, und `CMauiControl::DoInit` @0x786E90 (Cfile:1124190) ist nichts
anderes als `RunScript(this, "OnInit")`. Erst dadurch läuft `Control.OnInit`
(control.lua:42) → `ResetLayout()` → die zirkuläre 6-Var-Kette.

### D. Control-Methoden (Minimalmenge)
`Destroy, GetParent, SetParent, Hide, Show, SetHidden, IsHidden, DisableHitTest,
EnableHitTest, SetName, SetNeedsFrameUpdate, SetAlpha, HitTest`
Bitmap: `SetNewTexture` (Cfile:1119593), `InternalSetSolidColor` (Cfile:1119821), `SetUV`
Text: `SetNewFont` (Cfile:1146287), `SetText`, `SetNewColor`, `GetStringAdvance`
(Cfile:1146720 — **Pflicht**, sonst kann kein Text-Layout rechnen)

### E. Event-Pump
`CMauiControl::HandleEvent` @0x7873A0 (Cfile:1124539) → `RunScript("HandleEvent", event)`.
**Liefert Lua `false`, bubbelt das Event die Parent-Kette hoch** (Cfile:1124525).
Event-Table exakt nach `func_CreateLuaEvent` @0x795BD0 (Cfile:1136293):
`Type, MouseX, MouseY, WheelRotation, KeyCode, Modifiers{Shift,Ctrl,Alt,Left,Middle,Right}`.
Frame-Hook `OnFrame(delta)`, gated über `mNeedsFrameUpdate` (Cfile:1118936).

### F. Rendering
Ein Control = ein absolut positioniertes `<div>` über dem WebGL-Canvas. Pro RAF ein
Layout-Pass, der `Left()/Top()/Width()/Height()` **pullt** (dafür ist der
LazyVar-Cache gebaut). Hit-Test **nicht** dem DOM überlassen (`pointer-events:none`),
sondern das Original-Bubbling aus Cfile:1124525 nachfahren.

---

## Die Schritte (jederzeit lauffähig)

Regel: Jeder Schritt ersetzt **genau ein** Panel. Ist ein Panel aus Lua da, wird der
TS-Zwilling **gelöscht** — nicht per Flag deaktiviert, sonst hat man zwei Wahrheiten.

### Schritt 1 — UI-VM bootet, `SetupUI()` läuft (2 Tage, Risiko niedrig)
Gebaut: `installUiEngine()`, UI-Globals (`DiskGetFileInfo`, `GetPreference`, `LOC`,
`ConExecute`). `_c_CreateCursor` (Cfile:1129627) **sofort echt**, kein Stub.
Ausgeführt: `uimain.lua`, `uiutil.lua`, `skins.lua`.
Verify: `SetupUI()` fehlerfrei; `UIUtil.GetLayoutFilename('economy')` löst auf.

### Schritt 2 — maui-Substrat (1–2 Wochen, **Risiko hoch**)
Gebaut: B–F oben.
Ausgeführt: `lazyvar.lua`, `maui/{control,group,bitmap,text,layouthelpers}.lua`.
Verify (headless, ohne DOM — nur LazyVar-Zahlen):
- `LayoutHelpers.AtLeftTopIn(b, g, 16, 3)` → `b.Left() == 16`, `b.Top() == 3`
- Bitmap ohne Helper misst sich nach Textur: `resources_panel_bmp.dds` → 324×72
  (**deckt sich mit den heute hartkodierten Werten** — der Beweis, dass es trägt)
- `ResetLayout()` mit zu wenig gesetzten Vars → `error("circular dependency")`.
  **Der Fehler MUSS kommen.**

Die drei Minen: Text-Metriken (`GetStringAdvance` muss zu den Original-TTFs passen),
`pixelScaleFactor` (layouthelpers.lua:22 — das CSS ignoriert ihn heute komplett),
LazyVar-Zyklen.

### Schritt 3 — Erste echte `lua/ui`: `economy.lua` (3–4 Tage)
Gebaut: **Sim→UI-Kanal.** Original: `Sim::Sync` (Cfile:1074261) serialisiert `_G.Sync`
binär, UI setzt `_G.Sync` und ruft `OnSync()` (Cfile:1328262). Bei uns: Worker postet
das Sync-Table als structured clone. *Gleiche Semantik, anderer Transport — das ist
Engine-Freiheit, kein Logik-Nachbau.*
Globals: `GetEconomyTotals()` (Keys exakt `maxStorage, stored, income,
lastUseRequested, lastUseActual` — economy.lua:271), `GetArmiesTable()` (Farben aus
`/lua/gamecolors.lua:16` — **importieren, nicht abtippen**).
Danach **gelöscht**: hud.ts:256-320 + style.css:226-330.

### Schritt 4 — Selektion in der Sim + `unitview.lua` (4–5 Tage)
**Der versteckte Blocker.** Ohne `GetSelectedUnits` läuft weder `orders.lua` noch
`construction.lua`. `UserUnit`-Proxy (Cfile:1364828), gespeist aus dem Sync-Snapshot.
Icon-Pfad ist `/textures/ui/common/icons/units/<Display.IconName>_icon.dds`
(gamecommon.lua:16) — der heutige Pfad über die Blueprint-ID (hud.ts:374) ist falsch.

### Schritt 5 — `orders.lua` + echte Kommandos (1 Woche, Risiko hoch)
Order-Queue in der Sim statt Navigator-Direktzugriff. `commandmode.lua` ist nur ein
State-Halter — die **Engine pollt** `GetCommandMode()` (Cfile:1262974), nicht umgekehrt.

### Schritt 6 — `construction.lua` + Bau (1 Woche)
`IssueBlueprintCommand` (Cfile:1265693), Platzierung über `func_OrderBuildStructure`
@0x57A790 (Footprint, Snap, `GetElevation` — **braucht Q3**).
Sim-seitig hängt das an `__spawnBuildSite` + `issueBuildTask` — **die existieren
bereits und hatten im Browser noch nie einen Aufrufer.**

### Schritt 7 — Rest von `gamemain.CreateUI` (2+ Wochen)
`borders.lua`, `worldview.lua` (der three.js-Canvas wird ein `CUIWorldView`-Peer),
`minimap.lua` (eine **zweite WorldView** mit `SetCartographic(true)`, kein Canvas mit
Punkten), `tabs`, `chat`, `tooltip`.
**`src/ui/hud.ts` und `style.css:226-590` werden gelöscht.**

---

## Ehrliche Einschätzung

- **Flaschenhals ist Schritt 2**, nicht die UI-Module.
- **Schritt 4 ist der versteckte Blocker.** Wer 5/6 vorzieht, baut wieder TS.
- **Q3 (Terrain) ist Voraussetzung für Schritt 6.**
- Zwei VMs im Browser: die UI-VM läuft synchron im Main-Thread; `OnSync()` muss pro
  Beat unter ~5 ms bleiben. Falls nicht: Sync auf Deltas eindampfen (das Original tut
  genau das, `mUpdateEntities`, Cfile:1074586) — **nicht** die UI in den Worker schieben.
- `luaSimClient.ts` lädt heute den kompletten `lua/ui/`-Baum in den **Sim**-Worker,
  wo er nie läuft. Ab Schritt 1 gehört er in die UI-VM.
