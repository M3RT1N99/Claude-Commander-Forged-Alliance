# Claude Commander: Forged Alliance

Browser-Reimplementierung von Supreme Commander: Forged Alliance. Assets kommen
aus der Installation des Nutzers (bring your own assets).

## Das Kernprinzip — hier wird nicht verhandelt

**Die Original-Lua IST das Spiel. Die Engine führt sie aus.**

Die Engine (TypeScript/WebGL) ist zuständig für:

1. **Berechnungen** — Physik, Ökonomie-Mathematik, Pathfinding, Kategorien
2. **Rendering** — WebGL, UI-Substrat
3. **Lua laden und ausführen** — `lua/sim/**`, `lua/ui/**`, Blueprints

Die Engine ist **nicht** zuständig für Spiellogik. `Unit.lua`, `defaultunits.lua`,
`aibrain.lua`, `construction.lua` werden **ausgeführt, nicht nachgebaut**.

### Verboten

- ❌ **Spiellogik in TS nachbauen.** Wenn die Antwort in `lua/sim/` oder `lua/ui/`
  steht, wird diese Datei ausgeführt — kein TS-Nachbau, kein HTML-Nachbau.
  (Das Brain war mal ein TS-Table. Dann stellte sich heraus, dass die gesuchte
  Methode in `aibrain.lua:500` steht. Jetzt läuft die echte Klasse.)
- ❌ **Zahlen erfinden.** Jeder Wert kommt aus einem Blueprint, aus der Original-Lua
  oder aus der Decomp. Kein „das fühlt sich richtig an".
- ❌ **Stubs im Produktivpfad.** Fehlende Engine-Teile müssen **knallen**, nicht still
  Unsinn liefern. Der Stub-Trap (`_G`-Metatable, die Identitätsfunktionen lieferte)
  machte jeden grünen Test wertlos — er hat monatelang gelogen. Er kommt nicht zurück.
- ❌ **Halbe Engines.** Es gibt genau einen Boot-Pfad: `installEngine()` in
  [src/lua/engine.ts](src/lua/engine.ts). Wer sich die Engine aus Einzelteilen selbst
  zusammensetzt, lässt Teile weg und merkt es nicht (der Worker hatte so das komplette
  Bau-System vergessen).
- ❌ **Lua (oder C++) in TS-Template-Literals.** Lua gehört in `.lua`-Dateien unter
  [src/engine-lua/](src/engine-lua/). Kein Syntax-Highlighting, kein Lua-Linter — und
  ein Backtick im Lua-Kommentar beendet still das TS-Template. Die TS-Datei daneben
  ist nur noch Loader + Bridge.

Zwei **Auto-Vivifier** stehen trotzdem noch im Produktivpfad, die muss man kennen:
`moho.<x>` erzeugt für jeden unbekannten Schlüssel eine leere Klasse
([moho.lua](src/engine-lua/moho.lua)), und `__getBrain(army)` legt für jeden Index
still ein Brain an ([brain.lua](src/engine-lua/brain.lua)). Dort knallt nichts.

## Quellen der Wahrheit — in dieser Reihenfolge

1. **IDA-Decompilation:** `Cfile/ForgedAlliance.exe.c` (~2 Mio. Zeilen, volle
   `Moho::`-Symbole, gitignored). Zusätzlich MCP-Zugriff auf IDA (`mcp__ida__*`).
   *Das* ist die Engine. Bei jeder Frage „wie macht die Engine das?" → hier suchen.
2. **Original-Lua + Blueprints:** `npx tsx scripts/peek-lua.ts <pfad> <von> <bis>`
   oder `npx tsx scripts/peek-lua.ts --grep <regex>` (sucht in lua.scd, mohodata.scd,
   units.scd — inkl. `.bp`-Dateien).
3. **faf-re / Community / Web** — nur wenn 1 und 2 nichts hergeben.

Nichts halluzinieren. Erst recherchieren, dann implementieren, dann gegen echte
Daten verifizieren.

## Architektur

**Engine-Lua** (das, was die C++-Engine in den Lua-State legt) liegt in
`src/engine-lua/`; die TS-Dateien daneben sind nur Loader + Bridges:

```
src/engine-lua/moho.lua        C++-Basisklassen (entity/unit/weapon/aibrain_methods)
src/engine-lua/globals.lua     C++-Globals (categories, VDist, IsDestroyed, Manipulatoren,
                               Emitter, CreateEconomyEvent, WaitFor, GetArmyBrain …)
src/engine-lua/threads.lua     Scheduler (ForkThread → Thread-Objekt mit :Destroy())
src/engine-lua/blueprints.lua  Blueprint-Pipeline + Struct-Defaults aus dem Ctor
src/engine-lua/units.lua       Spawn über die Original-Klasse, Waffen, Lifecycle
src/engine-lua/brain.lua       __createBrain → echte AIBrain-Klasse aus aibrain.lua
src/engine-lua/build.lua       Bau-Tasks (Ökonomie-Verbraucher)
src/engine-lua/motion.lua      Navigator + Bewegung
src/engine-lua/compat.lua      Lua-5.0-Kompat (__foriter, table.getn …)
src/engine-lua/maui.lua        UI-Substrat: LazyVars, InternalCreate*, Event-Pump, Frame-Pumpe
src/engine-lua/ui-globals.lua  UI-Globals (scr_UserInits): Selektion, Befehle, Rollover …

src/lua/engine.ts      installEngine() — DER Sim-Boot; beat() — der 10-Hz-Sim-Beat
src/lua/uiEngine.ts    installUiEngine() + setupGameUi() — DER UI-Boot (gamemain.lua:132-154)
src/lua/host.ts        wasmoon-Host + VFS-Mounting
src/lua/transpile.ts   FA-Dialekt → Standard-Lua (siehe „Zwei Lua-Dialekte")
src/sim/economy.ts     Zwei-Ratio-Ökonomie (binär verifiziert)
src/sim/session.ts     ScenarioInfo + Brains (SimInit-Schritte 3a/5a)
src/sim/luaSimWorker.ts  Web Worker, der die Sim hostet
src/ui/gameUi.ts       Die UI-VM im Main-Thread (Original lua/ui)
src/ui/mauiRenderer.ts maui-Baum → DOM (ein Control = ein <div>)
src/ui/worldCommands.ts Klick in die Welt → commandmode.lua fragen → Befehl an die Sim
src/ui/fonts.ts        Die Schriften des Spiels (TTF-Metrik)
```

**Die Spiel-UI hat genau einen Aufbauweg:** `setupGameUi()` in
[src/lua/uiEngine.ts](src/lua/uiEngine.ts) — dieselbe Reihenfolge wie `gamemain.lua:132-154`
(Screen-Group → `borders.lua` liefert die vier Cluster → economy, multifunction, orders,
construction, unitview, unitviewDetail). Browser und Verify-Suite nehmen ihn beide; wer
die Panels direkt an `GetFrame(0)` hängt, bekommt sie an die falsche Stelle.

### Boot-Reihenfolge ist nicht kosmetisch

`installEngine()`: **Engine-Primitive zuerst** (SimThreads → Globals → Economy →
Motion → Build), dann **`/lua/system/class.lua` NEU laden**, dann moho → utils →
Blueprints → UnitFactory → SimSync → terrainTypes → `setupSession()`.

`class.lua` wird **zweimal** geladen: einmal im LuaHost-Bootstrap (da ist `ForkThread`
noch `nil`) und erneut nach dem Scheduler. Grund: `class.lua:78` macht
`local ForkThread = ForkThread` — ein Upvalue-Snapshot. Wer den zweiten Load für
redundant hält und streicht, bekommt einen Fehler weit weg vom Verursacher
(`class.lua:377`, bei jedem State-Wechsel). `globals.lua` enthält bewusst **kein**
`Class(` — nur deshalb darf es vor dem Reload laufen.

### Zwei Lua-VMs — nicht eine

Die Engine hat **zwei getrennte Lua-States**. Jede Bindung wird über `mPrevDef` in
genau einen registriert ([docs/research/engine-api.md](docs/research/engine-api.md),
aus der Decomp generiert):

| Init-Liste | Ziel | Umfang |
|---|---|---|
| `scr_CoreInits` | beide VMs | 70 Bindungen |
| `scr_UserInits` | nur **UI** | 453 (200 Globals, 23 Klassen) |
| `sim_SimInits` | nur **Sim** | 626 (133 Globals, 27 Klassen) |

Darum kennt die Sim kein `_c_CreateCursor` und die UI kein `CreateUnit`.
`installEngine()` bootet die Sim, `installUiEngine()` die UI — nie beides in einer VM.

### LuaPlus-Dialekt: `nil` hat eine Metatable

FAs eigenes `config.lua:6` sagt es: *„Disable the LuaPlus bit where you can add
attributes to nil, numbers, and strings."* — es schaltet dort aber nur das **Schreiben**
ab; der `__index`-Teil ist **auskommentiert** (config.lua:14-16). In FA liefert
`nil.foo` also `nil` statt zu knallen, und die Original-Lua **verlässt sich darauf**:

```lua
uiutil.lua:343   skins[currentSkin()].cursors or skins['default'].cursors
```

Beim ersten `SetupUI()` ist der Skin ungesetzt, `currentSkin()` liefert **0**
(lazyvar.lua:110: `result[1] = initial or 0`), `skins[0]` ist nil — und die Zeile
funktioniert trotzdem. Wir stellen das über `debug.setmetatable` in
[boot.lua](src/engine-lua/boot.lua) her. Ohne das läuft kein einziges Original-UI-Skript.

### `config.lua` bringt drei Dinge mit, die man nicht nachbauen darf

1. **Der strenge `_G`** (config.lua:51-56): der Zugriff auf ein **nicht existierendes
   Global wirft einen Fehler**. Das Original hat unsere Anti-Stub-Regel selbst
   eingebaut — ein Stub-Trap ist also nicht nur schädlich, er ist das genaue Gegenteil
   dessen, was die Engine tut. Folge: `x = nil` legt den Schlüssel **nicht** an; wer ein
   Engine-Global später lesen will, muss es mit `false` initialisieren.
2. **Das Thread-Objekt** (config.lua:29-35): Coroutines bekommen eine Metatable mit
   `Destroy = KillThread`. *Das* ist das Objekt, das die Original-Lua in den TrashBag
   legt — die Engine liefert die Coroutine, `config.lua` die Methode.
3. **`iscallable`** (config.lua:63).

### Zwei Lua-Dialekte im selben Projekt

- Dateien aus dem **VFS** (Original-Lua, `.bp`) laufen durch `transpileFaLua`:
  dort ist `#` ein **Kommentar**, `!=` wird zu `~=`, `for k,v in tbl do` und
  `continue` werden umgeschrieben.
- Dateien aus **`src/engine-lua/`** gehen roh in `host.eval()` — das ist
  **Standard-Lua 5.4**, dort ist `#t` der **Längenoperator**.

Verschiebt man eine Engine-Lua-Datei ins VFS, wird jedes `#t` still zum Kommentar:
kein Fehler, nur falsche Ergebnisse.

### Sim-Beat (`Sim::AdvanceBeat` @Cfile:1076363)

Fabrik-Warteschlangen → Bau-Bedarf anmelden → Ökonomie verteilen → gewährte Rate
anwenden → Lua-Threads → Bewegung.

Die Reihenfolge ist messbar: eine Unit wird in Phase 3 fertig, ihr **Lager** taucht
deshalb erst im Ökonomie-Tick des **nächsten** Beats auf.

### Unit-Lifecycle

`OnPreCreate` (@943748) → `OnCreate` (@944007) → bei fertigen Units
`OnStopBeingBuilt`. Ohne `OnPreCreate` gibt es kein `self.Sync`, kein `self.Trash`
und keine `EventCallbacks`.

## Verifizierte Fakten (nicht neu erfinden)

- **Ökonomie ist gleitend** (wie SCFA, nicht wie SC2): zwei Ratios in
  `func_ArmyProcessEconomy` (@0x771B50). Produktion ist bedingungsloses Einkommen und
  wird **nie** an die Gewährungs-Ratio gekoppelt.
- **Produktion und Verbrauch sind getrennte Schalter** (`SetProductionActive` /
  `SetConsumptionActive`) — niemals einer. Original-`OnStopBeingBuilt` ruft
  `SetConsumptionActive(false)`; auf einem gemeinsamen Flag stirbt damit lautlos die
  Produktion **jedes fertigen Gebäudes**.
- **Unfertige Units (`complete = false`) sind in der Ökonomie unsichtbar** — kein
  Lager, keine Produktion, kein Unterhalt. Eine Baustelle entsteht über
  `__spawnBuildSite`, nicht über `__spawnUnit`.
- **Startressourcen** kommen NICHT aus einer Konstante. Jede ACU forkt in
  `OnStopBeingBuilt` ihr `GiveInitialResources` (`uel0001_script.lua:159`) und schenkt
  der Armee nach `WaitTicks(5)` ihr eigenes Lager (`StorageEnergy = 4000`,
  `StorageMass = 650`).
- **Lager** entsteht ausschließlich aus `Storage*` der Units. Der
  `SSTIArmyVariableData`-Ctor (@0x6FD390) startet mit `mStored = 0/0`,
  `mMaxStorage = 0/0`. (Ein zusätzlicher „Sockel 650/4000" wäre die ACU doppelt.)
- **Blueprint-Defaults:** die Engine liest ein `.bp` in ein getyptes Struct, dessen
  Ctor (`Moho::RUnitBlueprint` @0x51E480) **jedes Feld** vorbelegt
  (`Defense.Shield.ShieldSize = 0`, `Intel.VisionRadius = 10`, `Economy.BuildRate = 1`
  …). Die Lua sieht das reflektierte Struct — **jedes Feld existiert immer**. Darum
  greift `Unit.lua` ungeprüft auf `bp.Defense.Shield.ShieldSize` zu, obwohl die
  `.bp`-Datei gar keine Shield-Sektion hat.
- **`MaxBrake == 0` / `MaxSteerForce == 0` heißen „nimm `MaxAcceleration`"**, nicht
  „kann nicht bremsen/lenken" (Cfile:942136-942147). Die ACU hat gar keinen
  `MaxBrake` — wer das falsch liest, pinnt ihre Geschwindigkeit für immer auf 0.
  Motion-Parameter sind **pro Tick** skaliert (`·0.1` Speed, `·0.01` Accel,
  `·0.0017453` deg/s → rad/Tick).
- **`class.lua` kopiert Basisklassen-Felder in die abgeleitete Klasse** (kein
  `__index`-Fallback). Ein Methodenname darf in **genau einer** moho-Namensliste
  stehen: `GetHealth` stand in ENTITY_NAMES *und* UNIT_NAMES, der No-Op auf der Unit
  überschattete die echte Implementierung — jede Unit meldete 0 HP.
- **Bau-Fortschritt:** `delta = buildRate/BuildTime · ResourceConsumed · 0.1`
  (`CBuildTaskHelper::UpdateWorkProgress` @0x5f5f2c).
- **`Sound{}`** ist der einzige DSL-Konstruktor in den `.bp`-Dateien (3445×). Fehlt er,
  bricht die Blueprint-Auswertung mittendrin ab — und das bp landet halbfertig unter
  dem Schlüssel `'null'`.
- **Die Sim hat das SKELETT der Unit**, nicht nur der Renderer. `weapon.lua:67` prüft
  die Turm-Knochen über `Unit:ValidateBone` (unit.lua:2751); Mündungen, Bau- und
  Effekt-Knochen hängen ebenfalls an Namen. Die Knochen kommen aus derselben
  `.scm`-Datei, die der Renderer liest (`__setBones`, [scripts/gameFiles.ts](scripts/gameFiles.ts)).
  Ohne Skelett bricht schon `Weapon:OnCreate` ab.
- **Die Engine ruft `OnCreate` auf JEDER Waffe.** `DefaultProjectileWeapon.OnCreate`
  endet mit `ChangeState(self, self.IdleState)` (defaultweapons.lua:87) — erst der
  IdleState startet die Zustandsmaschine der Waffe. Ohne diesen Aufruf lief sie gar
  nicht, bis ein späterer Zustandswechsel sie zufällig anwarf: der Overcharge der ACU
  (IdleState.Main → `StartEconomyDrain`, defaultweapons.lua:404) lud seine
  **5000 Energie** dann bei leerer Kasse. 500 E/Tick Bedarf gegen 2 E/Tick Einkommen
  ⇒ Rate 0.004, nie fertig — und jede Fabrik verhungert nebenbei. **Reihenfolge ist
  Semantik.**
- **Raster-Snap beim Bauen** (`COORDS_GridSnap` @0x50B1E0, Cfile:641666-641686):
  `cell = trunc(p − size/2)`, zurück `+ size/2`, **Höhe erst nach dem Snap**
  (Cfile:641588). `size` sind die ganzzahligen `Footprint.SizeX/SizeZ` — nicht
  SkirtSize, nicht SelectionSize. Ein 5×5-Gebäude sitzt also immer auf `x.5`.
- **Feuerhaltung** (`GetFireState` @0x8BB500): Sentinel 3 → erste Unit **mit**
  `RULEUCC_RetaliateToggle` (Bit 5 der CommandCaps, Reihenfolge Cfile:656671-656719)
  setzt den Zustand, Abweichung ⇒ −1 (gemischt). Werte: 0 = ReturnFire, 1 = HoldFire,
  2 = HoldGround; der Ctor startet mit ReturnFire (Cfile:772277).
- **Schriften:** `lua/skins/skins.lua:22-26` verlangt „Arial" und „Zeroes Three" —
  beide liegen als TTF in `<GameDir>/fonts`. Text-Controls bemessen sich nach
  `FontAscent + FontDescent` und `TextAdvance` (text.lua:39/47), also wird die echte
  TTF-Metrik gelesen ([src/formats/ttf.ts](src/formats/ttf.ts)) und dieselbe Datei per
  `FontFace` gerendert. Der volle Name (nameID 4) ist der Schlüssel: `ARIAL.TTF` und
  `ARIALBD.TTF` haben **beide** die Familie „Arial".
- **`/lua/usersync.lua` gehört in die UI-VM** (Gegenstück zu `/lua/simsync.lua` in der
  Sim; keine Lua-Datei lädt es, die Engine tut es). Es bringt `Sync`, `UnitData` und
  `OnSync()` — ohne `UnitData` scheitert schon orders.lua:909 an der ersten Selektion.

### wasmoon: eine JS-Funktion darf NIE `null` zurückgeben

wasmoon prüft den Rückgabewert mit `typeof target !== 'object'` und greift danach auf
`target.then` zu (`node_modules/wasmoon/dist/index.js:1020-1026`). Für `null` ist
`typeof` aber `"object"` — die VM stirbt mit *„Cannot read properties of null (reading
'then')"*, und zwar tief in einer Original-Lua-Datei, die damit nichts zu tun hat.
`LuaHost.setGlobal` wandelt deshalb `null → undefined` (= Lua `nil`). Gefunden, als
`GetTextureDimensions` für eine fehlende DDS `null` lieferte: die Auswahl der ACU riss
die komplette UI-VM um.

## Werkzeuge

```bash
npm test                                    # alle 20 Verify-Suiten
npx tsc --noEmit                            # Typecheck
npx tsx scripts/peek-lua.ts --grep <regex>  # Original-Lua/Blueprints durchsuchen
npx tsx --import ./scripts/register-lua.mjs scripts/discover-engine-api.ts
                                            # ehrliche Liste fehlender Engine-API
```

**Jedes Skript, das `src/lua/*` oder `src/sim/*` importiert, braucht den Loader:**

```bash
npx tsx --import ./scripts/register-lua.mjs scripts/verify-<x>.ts
```

Sonst: `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".lua"`. Vite kann `?raw`
nativ, Node nicht — dafür ist [scripts/lua-loader.mjs](scripts/lua-loader.mjs) da.
(`npm test` setzt das Flag selbst; die Kommentarzeilen *in* den verify-Dateien sind
veraltet und lassen es weg.)

Tests sind Verify-Suiten gegen echte Spieldaten (`scripts/verify-*.ts`), keine Mocks.
Ein roter Test nach einer Ehrlichkeits-Korrektur ist ein **Fund**, kein Rückschritt.

**Beim Debuggen:** Fehler in Lua-Threads werden nur geloggt, nicht geworfen — die
Unit läuft scheinbar weiter. Zuerst nach `ForkThread-Fehler:` in den WARN-Zeilen
suchen.

## Stand: die Techdemo läuft

ACU auswählen → Bau-Menü aus dem Blueprint → Gebäude aufs Raster setzen → es wird aus
der echten Ökonomie bezahlt → die fertige Fabrik produziert Panzer, die vom Hof rollen.
Alles über die Original-Lua; verifiziert in
[scripts/verify-command-chain.ts](scripts/verify-command-chain.ts) und
[scripts/verify-factory.ts](scripts/verify-factory.ts), im Browser über
`?selftest=<blueprint>`.

## Bekannte Löcher

Der Weg zur echten UI steht in [docs/PLAN-UI.md](docs/PLAN-UI.md) — mit Decomp-Belegen.

- **`src/ui/hud.ts`** ist der letzte TS/HTML-Nachbau (Orders, Unit-View, Minimap). Die
  Ökonomie ist dort schon raus — sie kommt aus der echten `economy.lua`. Dort **nichts
  Neues anbauen**; der Rest gehört ebenfalls abgebaut.
- **Kein Audio.** `PlaySound` protokolliert die angeforderten Cues
  (`__uiSoundsRequested`) und meldet einmal laut, dass keine Ausgabe angeschlossen ist.
  Die FMOD-Bänke aus `sounds.scd` sind ungelesen.
- **Keine Weltansicht als maui-Control.** `worldview.lua`, `borders`-Rahmen, Minimap,
  Tabs und Chat fehlen; der Klick in die Welt läuft über
  [src/ui/worldCommands.ts](src/ui/worldCommands.ts).
- **Die Karte wird in TS geparst** (`main.ts` liest `Scenario.MasterChain…Markers`
  selbst), statt `ScenarioUtilities.lua` auszuführen. Folge: keine Armee-Gruppen,
  keine Props, kein `CreateInitialArmyGroup`.
- **Das Blueprint wird zweimal gelesen** — einmal vom TS-Parser (`main.ts`, für Modelle
  und Knochen) und einmal von der echten `LoadBlueprints()`-Pipeline. Zwei Wahrheiten.
- **Nur ein Bauer pro Baustelle** — Assist (mehrere Bauer an einer Baustelle) fehlt.
- **Kein Kampf:** Waffen bauen sich auf und zielen, aber es gibt keine Projektile,
  keinen Schaden und keine Beam-Waffen (`defaultweapons.lua:909`, `Beams`).
- **Ökonomie-Lua-API ist noch No-Op:** `SetProductionPerSecond*`,
  `SetConsumptionPerSecond*`, `SetBuildRate` schreiben nichts in die Engine-Ökonomie
  (Werte kommen bisher nur aus dem Blueprint).
- **`docs/research/economy-binary.md` beschreibt mehr, als `economy.ts` kann**
  (Handicap, Overflow-Sharing an Verbündete, kumulierter `granted`-Akku fehlen).

## Sprache

Antworten auf Deutsch. Code-Kommentare auf Englisch.
