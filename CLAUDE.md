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
`economy.lua`, `construction.lua` werden **ausgeführt, nicht nachgebaut**.

### Verboten

- ❌ **Spiellogik in TS nachbauen.** Wenn die Antwort in `lua/sim/` oder `lua/ui/`
  steht, wird diese Datei ausgeführt — kein TS-Nachbau, kein HTML-Nachbau.
- ❌ **Zahlen erfinden.** Jeder Wert kommt aus einem Blueprint, aus der Original-Lua
  oder aus der Decomp. Kein „das fühlt sich richtig an".
- ❌ **Stubs im Produktivpfad.** Fehlende Engine-Teile müssen **knallen**, nicht still
  Unsinn liefern. Ein Stub-Trap (`_G`-Metatable, die Identitätsfunktionen liefert)
  macht jeden grünen Test wertlos — das hatten wir schon, es hat monatelang gelogen.
- ❌ **Halbe Engines.** Es gibt genau einen Boot-Pfad: `installEngine()` in
  [src/lua/engine.ts](src/lua/engine.ts). Wer sich die Engine aus Einzelteilen selbst
  zusammensetzt, lässt Teile weg und merkt es nicht.
- ❌ **Lua (oder C++) in TS-Template-Literals.** Lua gehört in `.lua`-Dateien unter
  [src/engine-lua/](src/engine-lua/). In TS-Strings gibt es keine Syntax-Hervorhebung,
  keinen Lua-Linter — und ein Backtick im Lua-Kommentar beendet still das TS-Template.
  Die TS-Datei daneben ist nur noch Loader + Bridge.

### Engine-Lua laden

```ts
import GLOBALS_LUA from '../engine-lua/globals.lua?raw'
host.eval(GLOBALS_LUA)
```

Vite kann `?raw` nativ. Node/tsx nicht — dafür gibt es
[scripts/lua-loader.mjs](scripts/lua-loader.mjs). Deshalb laufen alle Skripte mit:

```bash
npx tsx --import ./scripts/register-lua.mjs scripts/<datei>.ts
```

(`npm test` setzt das Flag selbst.)

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

**Die Engine-Lua** (das, was die C++-Engine in den Lua-State legt) liegt in
`src/engine-lua/`, die TS-Dateien daneben sind nur Loader + Bridges:

```
src/engine-lua/moho.lua        C++-Basisklassen (entity/unit/weapon/aibrain_methods)
src/engine-lua/globals.lua     C++-Globals (categories, VDist, IsDestroyed, Manipulatoren,
                               Emitter, CreateEconomyEvent, WaitFor …)
src/engine-lua/threads.lua     Scheduler (ForkThread → Thread-Objekt mit :Destroy())
src/engine-lua/blueprints.lua  Blueprint-Pipeline + Struct-Defaults aus dem Ctor
src/engine-lua/units.lua       Spawn über die Original-Klasse, Waffen, Lifecycle
src/engine-lua/brain.lua       __createBrain → echte AIBrain-Klasse aus aibrain.lua
src/engine-lua/build.lua       Bau-Tasks
src/engine-lua/motion.lua      Navigator
src/engine-lua/compat.lua      Lua-5.0-Kompat (__foriter, table.getn …)
src/engine-lua/boot.lua        Host-Bootstrap

src/lua/engine.ts      installEngine() — DER Boot; beat() — der 10-Hz-Sim-Beat
src/lua/host.ts        wasmoon-Host, VFS, FA-Dialekt-Transpiler
src/sim/economy.ts     Zwei-Ratio-Ökonomie (binär verifiziert)
src/sim/session.ts     ScenarioInfo + Brains (SimInit-Schritte 3a/5a)
src/sim/luaSimWorker.ts  Web Worker, der die Sim hostet
```

**Boot-Reihenfolge ist nicht kosmetisch:** erst alle Engine-Primitive, dann Original-Lua.
`class.lua:78` macht `local ForkThread = ForkThread` — wird das Klassensystem vor dem
Scheduler geladen, bleibt dieser Upvalue für immer `nil`.

**Sim-Beat-Reihenfolge** (aus `Sim::AdvanceBeat` @:1076363):
Bau-Bedarf anmelden → Ökonomie verteilen → gewährte Rate anwenden → Lua-Threads →
Bewegung.

**Unit-Lifecycle** (aus der Decomp): `OnPreCreate` (@943748) → `OnCreate` (@944007)
→ bei fertigen Units `OnStopBeingBuilt`.

## Verifizierte Fakten (nicht neu erfinden)

- **Ökonomie ist gleitend** (wie SCFA, nicht wie SC2): zwei Ratios in
  `func_ArmyProcessEconomy` (@0x771B50). Produktion ist bedingungsloses Einkommen und
  wird **nie** an die Gewährungs-Ratio gekoppelt.
- **Startressourcen:** kommen NICHT aus einer Konstante. Jede ACU forkt in
  `OnStopBeingBuilt` ihr `GiveInitialResources` (z. B. `uel0001_script.lua:159`) und
  schenkt der Armee nach `WaitTicks(5)` ihr eigenes Lager
  (`Economy.StorageEnergy = 4000`, `StorageMass = 650`).
- **Lager:** ausschließlich aus `Storage*` der Units. `SSTIArmyVariableData`-Ctor
  (@0x6FD390) startet mit `mStored = 0/0`, `mMaxStorage = 0/0`.
- **Blueprint-Defaults:** `Moho::RUnitBlueprint::RUnitBlueprint` (@0x51E480, Cfile
  ~655645) initialisiert das getypte Struct mit Defaults (`Defense.Shield.ShieldSize = 0`, `Intel.VisionRadius = 10`, `Economy.BuildRate = 1` …). Die Lua sieht das
  reflektierte Struct — **jedes Feld existiert immer**. Darum greift `Unit.lua`
  ungeprüft auf `bp.Defense.Shield.ShieldSize` zu.
- **Bau-Fortschritt:** `delta = buildRate/BuildTime · ResourceConsumed · 0.1`
  (`CBuildTaskHelper::UpdateWorkProgress` @0x5f5f2c).
- **`Sound{}`** ist der einzige DSL-Konstruktor in den `.bp`-Dateien (3445×).

## Werkzeuge

```bash
npm test                                    # alle Verify-Suiten
npx tsx scripts/peek-lua.ts --grep <regex>  # Original-Lua/Blueprints durchsuchen
npx tsc --noEmit                            # Typecheck
```

Tests sind Verify-Suiten gegen echte Spieldaten (`scripts/verify-*.ts`), keine Mocks.
Ein roter Test nach einer Ehrlichkeits-Korrektur ist ein **Fund**, kein Rückschritt.

## Sprache

Antworten auf Deutsch. Code-Kommentare auf Englisch.
