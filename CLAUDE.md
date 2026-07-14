# Claude Commander: Forged Alliance

Browser-Reimplementierung von Supreme Commander: Forged Alliance — **1:1**.
Assets kommen aus der Installation des Nutzers (bring your own assets).

**Das Ziel-Erlebnis:** Spielverzeichnis verbinden → das **echte FA-Hauptmenü**
(`lua/ui/menus/main.lua`) → Skirmish über die echte Lobby → Session mit der
echten Spiel-UI. **Keine Web-Menüs im Spiel, keine nachgebauten Panels.** Der
Web-Rahmen (Start/Sandbox/Unit-Viewer/Karten-Viewer) ist nur Werkzeug und
Launcher, bis das Original-Front-End läuft.

## Das Kernprinzip — hier wird nicht verhandelt

**Die Original-Lua IST das Spiel. Die Engine führt sie aus.**

Die Engine (TypeScript/WebGL) ist zuständig für: **Berechnungen** (Physik,
Ökonomie-Mathematik, Pathfinding, Kategorien), **Rendering** und **Lua laden
und ausführen** (`lua/sim/**`, `lua/ui/**`, Blueprints). Sie ist **nicht**
zuständig für Spiellogik: `Unit.lua`, `defaultunits.lua`, `aibrain.lua`,
`construction.lua` werden **ausgeführt, nicht nachgebaut**.

### Verboten

- ❌ **Spiellogik in TS nachbauen.** Wenn die Antwort in `lua/sim/` oder
  `lua/ui/` steht, wird diese Datei ausgeführt — kein TS-, kein HTML-Nachbau.
- ❌ **Zahlen erfinden.** Jeder Wert kommt aus einem Blueprint, der
  Original-Lua oder der Decomp. Kein „das fühlt sich richtig an".
- ❌ **Stubs im Produktivpfad.** Fehlende Engine-Teile müssen **knallen**,
  nicht still Unsinn liefern. (Der alte Stub-Trap hat monatelang jeden grünen
  Test wertlos gemacht. Er kommt nicht zurück.)
- ❌ **Halbe Engines.** Genau ein Sim-Boot: `installEngine()`
  ([src/lua/engine.ts](src/lua/engine.ts)); genau ein UI-Boot:
  `installUiEngine()` + `setupGameUi()` ([src/lua/uiEngine.ts](src/lua/uiEngine.ts),
  Reihenfolge = `gamemain.lua:132-154`). Wer sich die Engine selbst
  zusammensetzt, lässt Teile weg und merkt es nicht.
- ❌ **Lua/C++ in TS-Template-Literals.** Lua gehört in `.lua`-Dateien unter
  [src/engine-lua/](src/engine-lua/); die TS-Dateien daneben sind nur
  Loader + Bridge.

Zwei **Auto-Vivifier** stehen bewusst im Produktivpfad (dort knallt nichts):
`moho.<x>` erzeugt leere Klassen ([moho.lua](src/engine-lua/moho.lua)),
`__getBrain(army)` legt still Brains an ([brain.lua](src/engine-lua/brain.lua)).

## Quellen der Wahrheit — in dieser Reihenfolge

1. **IDA-Decompilation:** `Cfile/ForgedAlliance.exe.c` (~2 Mio. Zeilen, volle
   `Moho::`-Symbole, gitignored). Zusätzlich MCP-Zugriff (`mcp__ida__*`).
   Bei jeder Frage „wie macht die Engine das?" → hier suchen.
2. **Original-Lua + Blueprints:** `npx tsx scripts/peek-lua.ts <pfad> <von> <bis>`
   oder `--grep <regex>` (sucht lua.scd, mohodata.scd, units.scd inkl. `.bp`).
3. **faf-re / Community / Web** — nur wenn 1 und 2 nichts hergeben.

Nichts halluzinieren. Erst recherchieren, dann implementieren, dann gegen
echte Daten verifizieren.

## Architektur in einem Absatz

`src/engine-lua/*.lua` ist das, was die C++-Engine in die Lua-States legt
(moho-Klassen, Globals, Scheduler, maui-Substrat, ui-globals); TS daneben nur
Loader/Bridges. Sim läuft im Worker (`src/sim/luaSimWorker.ts`, 10-Hz-Beat),
UI-VM im Main-Thread (`src/ui/gameUi.ts` → maui-Baum → DOM via
`src/ui/mauiRenderer.ts`). Klick in die Welt: `src/ui/worldCommands.ts` fragt
`commandmode.lua` — die Engine entscheidet nichts.

### Zwei Lua-VMs — nicht eine

Jede Engine-Bindung ist über `mPrevDef` in genau einen State registriert
([docs/research/engine-api.md](docs/research/engine-api.md), generiert):
`scr_CoreInits` = beide VMs (70), `scr_UserInits` = nur UI (453),
`sim_SimInits` = nur Sim (626). Darum kennt die Sim kein `_c_CreateCursor`
und die UI kein `CreateUnit`. Nie beides in eine VM booten.

### Boot-Reihenfolge ist nicht kosmetisch

`installEngine()`: Engine-Primitive zuerst (SimThreads → Globals → Economy →
Motion → Build), dann **`/lua/system/class.lua` NEU laden**, dann moho →
utils → Blueprints → UnitFactory → SimSync → terrainTypes → `setupSession()`.
`class.lua` lädt **zweimal**, weil `class.lua:78`
`local ForkThread = ForkThread` snapshottet — beim Bootstrap ist das noch
`nil`, und ohne Reload stirbt `class.lua:377` bei jedem State-Wechsel weit
weg vom Verursacher. `globals.lua` enthält bewusst kein `Class(`.

### FA-Lua ist ein Dialekt (zwei sogar)

- **LuaPlus:** `nil`/Zahlen/Strings haben Metatables; `nil.foo` liefert `nil`
  statt zu knallen — FAs `config.lua:14-16` lässt das Lesen bewusst zu, und
  die Original-UI **verlässt sich darauf** (uiutil.lua:343 beim ersten
  `SetupUI()`). Hergestellt via `debug.setmetatable` in
  [boot.lua](src/engine-lua/boot.lua).
- **`config.lua` bringt mit:** den **strengen `_G`** (Zugriff auf
  nicht existierende Globals wirft; `x = nil` legt KEINEN Schlüssel an —
  Engine-Globals mit `false` initialisieren), das **Thread-Objekt**
  (Coroutine-Metatable mit `Destroy = KillThread`) und `iscallable`.
- **Zwei Dialekte im Repo:** VFS-Dateien (Original-Lua, `.bp`) laufen durch
  `transpileFaLua` (`#` = Kommentar, `!=`→`~=`, `continue`, `for k,v in tbl do`);
  Dateien aus `src/engine-lua/` sind **Standard-Lua 5.4** (`#t` =
  Längenoperator!) und gehen roh in `host.eval()`. Eine Engine-Lua-Datei ins
  VFS verschieben macht jedes `#t` still zum Kommentar.

## Querschneidende Fakten (gelten immer)

- **Blueprint-Struct-Defaults:** der Engine-Ctor (`Moho::RUnitBlueprint`
  @0x51E480) belegt **jedes Feld** vor — die Lua greift ungeprüft auf
  `bp.Defense.Shield.ShieldSize` zu, auch ohne Shield-Sektion in der `.bp`.
- **`class.lua` kopiert Basisklassen-Felder** (kein `__index`-Fallback): ein
  Methodenname darf in genau **einer** moho-Namensliste stehen, sonst
  überschattet ein No-Op die echte Implementierung.
- **Produktion ≠ Verbrauch** (getrennte Schalter) und **Baustellen sind für
  die Ökonomie unsichtbar**.
- **Die Sim hat das Skelett der Unit** (Waffen validieren Knochen), und die
  Engine ruft **`OnCreate` auf jeder Waffe** — Reihenfolge ist Semantik.
- **wasmoon:** eine JS-Funktion darf nie `null` nach Lua geben
  (`LuaHost.setGlobal` wandelt `null → undefined`), sonst stirbt die VM tief
  in fremder Lua.

Alle weiteren belegten Fakten (Ökonomie, Snap, Fire-State, Schriften,
usersync, MaxBrake …): **vor Arbeit am Thema
[docs/research/verified-facts.md](docs/research/verified-facts.md) lesen.**

## Werkzeuge & Arbeitsweise

```bash
npm test                                    # alle Verify-Suiten
npx tsx --import ./scripts/register-lua.mjs scripts/verify-<x>.ts   # eine Suite
npx tsc --noEmit                            # Typecheck
npx tsx scripts/peek-lua.ts --grep <regex>  # Original-Lua/Blueprints suchen
```

- **Jedes Skript, das `src/lua/*` oder `src/sim/*` importiert, braucht
  `--import ./scripts/register-lua.mjs`** (sonst
  `ERR_UNKNOWN_FILE_EXTENSION ".lua"`; `npm test` setzt es selbst).
- Tests sind Verify-Suiten gegen echte Spieldaten, keine Mocks. Ein roter
  Test nach einer Ehrlichkeits-Korrektur ist ein **Fund**, kein Rückschritt.
- Während der Arbeit gezielt die passende Suite laufen lassen; **vor jedem
  Commit** `npx tsc --noEmit` und `npm test` (alle Suiten).
- Browser-Ende-zu-Ende: `?sandbox=<karte>&selftest=<blueprint>` fährt die
  Techdemo ohne Maus (headless Chrome; Sim tickt in Echtzeit, nicht unter
  `--virtual-time-budget`).
- **Debuggen:** Fehler in Lua-Threads werden nur geloggt — zuerst nach
  `ForkThread-Fehler:` in den WARN-Zeilen suchen.
- Commits auf Deutsch, Was + Warum, ein Meilenstein pro Commit.

## Arbeitsstil je Modell

Alles oben gilt für **jedes** Modell. Dieser Abschnitt ändert nur, *wie viel* du
am Stück übernimmst und mit welchem Aufwand — **nie, was richtig ist**. Dein
aktives Modell steht in deinem System-Prompt.

**Basis** (Sonnet-Klasse, jedes Modell, und immer bei Unsicherheit): kleine,
verifizierbare Schritte; vor großen Umbauten über mehrere Dateien beim Nutzer
rückversichern; für breite Suchen **einen** Recherche-Subagenten statt weiter
Fächerung. Aufwand: mittel; hoch bei schwerem Denken.

**Opus 4.8 und die Claude-5-Familie (Fable 5):** autonom arbeiten. Mehrstufige
Arbeit von Anfang bis Ende planen und lange Vorhaben (Migrationen, Umbauten über
viele Dateien) **ohne Zwischenhalt** zu Ende bringen, solange Typecheck und
Suiten grün bleiben. Die Spezifikation vorn festlegen (Aufgabe, Absicht,
Randbedingungen, Abnahmekriterium in einem Zug), nicht scheibchenweise. Aufwand:
`xhigh` als Startpunkt für Coding/Agenten-Arbeit, `high` als Minimum bei
Denkarbeit; `max` nur für echte Grenzfälle (überdenkt strukturierte Aufgaben).
Der Nutzer kann mit **ultracode** weiter aufdrehen (xhigh + deterministische
Workflow-Fächerung).

**Fächern und auf Abdeckung prüfen (Opus 4.8 und neuer):** diese Modelle
spawnen von sich aus zu wenig. Also *ausdrücklich* parallele Subagenten über
unabhängige Themen fächern — z. B. je ein Agent pro Recherche-Thema
(Front-End-Menü, WorldView, Session-Start, Kampf …) oder pro Engine-Subsystem.
**Nicht** fächern für Arbeit, die in einer Antwort erledigt ist. Vor „fertig":
einen frischen Subagenten den eigenen Diff prüfen lassen — sein Auftrag ist
**Abdeckung** (jede Korrektheits- oder Anforderungslücke melden, mit
Zuversicht + Schwere), nicht Filtern. In diesem Repo gibt es (noch) keine
vorgefertigten Reviewer-Agenten; nutze `/code-review` bzw. einen
`general-purpose`-Agenten mit klarem Prüfauftrag.

**Regel-Reichweite wörtlich nennen.** Diese Modelle folgen Anweisungen wörtlich
und verallgemeinern eine Regel nicht von selbst. Wenn eine Invariante *jeden*
Fall betrifft, schreibe „jede/alle": *jede* Zahl kommt aus Blueprint, Lua oder
Decomp; *jedes* fehlende Engine-Teil knallt; *jede* Spiellogik läuft in der
Original-Lua.

**Niemals** die Invarianten (Kernprinzip, „Verboten"), die Ehrlichkeitsregeln
oder die Korrektheit davon abhängig machen, welches Modell gerade läuft — die
Modellzeile kann veraltet sein; im Zweifel gilt die Basis. Jeden autonomen
Schritt an einer Prüfung verankern, die du **wirklich ausführen** kannst
(`npx tsc --noEmit`, die passende `verify-*`-Suite, `npm test`, der
Browser-Selbsttest `?sandbox=…&selftest=…`) — nie an „sieht fertig aus".

## Weiterführende Doku

| Dokument | Inhalt |
|---|---|
| [docs/STATUS.md](docs/STATUS.md) | Stand + bekannte Löcher (zuerst lesen) |
| [docs/PLAN-1ZU1.md](docs/PLAN-1ZU1.md) | Konsolidierter 1:1-Fahrplan (Meilensteine) |
| [docs/PLAN-UI.md](docs/PLAN-UI.md) | Weg zur echten `lua/ui`, mit Decomp-Belegen |
| [docs/MASTERPLAN.md](docs/MASTERPLAN.md) | Gesamtinventur Vollspiel, Phasen A–F |
| [docs/FORMATS.md](docs/FORMATS.md) | Dateiformate (scd/scm/sca/scmap/dds), verifiziert |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architektur (älter; bei Widerspruch gilt CLAUDE.md) |
| [research/engine-api.md](docs/research/engine-api.md) | **Alle** Engine-Bindungen je VM (generiert — Checkliste) |
| [research/verified-facts.md](docs/research/verified-facts.md) | Belegtes Detailwissen nach Themen |
| [research/economy-binary.md](docs/research/economy-binary.md) | Zwei-Ratio-Ökonomie aus dem Binary |
| [research/build-task-binary.md](docs/research/build-task-binary.md) | Bau-Task-Ablauf |
| [research/command-dispatch-binary.md](docs/research/command-dispatch-binary.md) | Befehls-Dispatch (Command→Task) |
| [research/damage-binary.md](docs/research/damage-binary.md) | Schadenssystem |
| [research/movement-path.md](docs/research/movement-path.md) | Bewegung: Grid, HaStar, Navigator, Steering |
| [research/weapons.md](docs/research/weapons.md) | Waffensystem |
| [research/ui-complete.md](docs/research/ui-complete.md) | UI-System komplett |
| [research/game-shell.md](docs/research/game-shell.md) | Front-End, Lobby, Session-Start |
| [research/effects-audio.md](docs/research/effects-audio.md) | Effekt-Blueprints + XACT-Audio |
| [research/sound-fmod.md](docs/research/sound-fmod.md) | Audio-Bänke |
| [research/intel-vision.md](docs/research/intel-vision.md) | Intel/Recon/Sichtbarkeit |
| [research/net-replay-save.md](docs/research/net-replay-save.md) | Lockstep, Replay, Save |
| [research/render-details.md](docs/research/render-details.md) | Renderer, SCMAP-Reststruktur |
| [research/lua-gameplay.md](docs/research/lua-gameplay.md) | FA-Lua-Dialekt-Nachweis (Lua 5.0.1) |
| [research/engine-core.md](docs/research/engine-core.md) / [engine-architecture.md](docs/research/engine-architecture.md) | Engine-Kern aus der Decomp |

## Sprache

Antworten auf Deutsch. Code-Kommentare auf Englisch. Commits auf Deutsch.
