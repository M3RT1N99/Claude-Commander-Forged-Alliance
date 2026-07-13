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

src/lua/engine.ts      installEngine() — DER Boot; beat() — der 10-Hz-Sim-Beat
src/lua/host.ts        wasmoon-Host + VFS-Mounting
src/lua/transpile.ts   FA-Dialekt → Standard-Lua (siehe „Zwei Lua-Dialekte")
src/sim/economy.ts     Zwei-Ratio-Ökonomie (binär verifiziert)
src/sim/session.ts     ScenarioInfo + Brains (SimInit-Schritte 3a/5a)
src/sim/luaSimWorker.ts  Web Worker, der die Sim hostet
```

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

### Zwei Lua-Dialekte im selben Projekt

- Dateien aus dem **VFS** (Original-Lua, `.bp`) laufen durch `transpileFaLua`:
  dort ist `#` ein **Kommentar**, `!=` wird zu `~=`, `for k,v in tbl do` und
  `continue` werden umgeschrieben.
- Dateien aus **`src/engine-lua/`** gehen roh in `host.eval()` — das ist
  **Standard-Lua 5.4**, dort ist `#t` der **Längenoperator**.

Verschiebt man eine Engine-Lua-Datei ins VFS, wird jedes `#t` still zum Kommentar:
kein Fehler, nur falsche Ergebnisse.

### Sim-Beat (`Sim::AdvanceBeat` @Cfile:1076363)

Bau-Bedarf anmelden → Ökonomie verteilen → gewährte Rate anwenden → Lua-Threads →
Bewegung.

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

## Werkzeuge

```bash
npm test                                    # alle 14 Verify-Suiten (~25 s)
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

## Bekannte Löcher (Stand: Juli 2026)

Der Weg zur echten UI steht in [docs/PLAN-UI.md](docs/PLAN-UI.md) — mit Decomp-Belegen.

- **`src/ui/hud.ts`** ist ein TS/HTML-Nachbau von
  `lua/ui/game/{economy,orders,unitview}.lua`, inklusive erfundener Farben. Größter
  offener Verstoß gegen das Kernprinzip. Dort **nichts Neues anbauen** — der Weg ist
  der maui-Layer + die echte `lua/ui`.
- **`setTerrainSource()` wird nie gerufen.** `GetTerrainHeight` liefert daher überall
  0, ohne jede Fehlermeldung — ein stiller Stub im Produktivpfad, also verboten.
- **Die Karte wird in TS geparst** (`main.ts` liest `Scenario.MasterChain…Markers`
  selbst), statt `ScenarioUtilities.lua` auszuführen. Folge: keine Armee-Gruppen,
  keine Props, kein `CreateInitialArmyGroup`.
- **Das Blueprint wird zweimal gelesen** — einmal vom TS-Parser (`main.ts`, fürs HUD)
  und einmal von der echten `LoadBlueprints()`-Pipeline (Worker). Zwei Wahrheiten.
- **Ökonomie-Lua-API ist noch No-Op:** `SetProductionPerSecond*`,
  `SetConsumptionPerSecond*`, `SetBuildRate` schreiben nichts in die Engine-Ökonomie
  (Werte kommen bisher nur aus dem Blueprint).
- **`docs/research/economy-binary.md` beschreibt mehr, als `economy.ts` kann**
  (Handicap, Overflow-Sharing an Verbündete, kumulierter `granted`-Akku fehlen).
- `defaultweapons.lua:909` wirft `attempt to index a nil value (field 'Beams')` —
  Beam-Waffen fehlen noch.

## Sprache

Antworten auf Deutsch. Code-Kommentare auf Englisch.
