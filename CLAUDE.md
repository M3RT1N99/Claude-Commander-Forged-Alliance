# Claude Commander: Forged Alliance

Browser reimplementation of Supreme Commander: Forged Alliance — **1:1**.
Assets come from the user's installation (bring your own assets).

**The Destination Experience:** Connect game directory → the **real FA main menu**
(`lua/ui/menus/main.lua`) → Skirmish over the real lobby → Session with the
real game UI. **No web menus in the game, no recreated panels.** The
Web Framework (Start/Sandbox/Unit Viewer/Map Viewer) is just tool and
Launcher until the original front end is running.

## The core principle — there is no negotiation here

**The original Lua IS the game. The engine executes them.**

The engine (TypeScript/WebGL) is responsible for: **Calculations** (physics,
Economics-Mathematics, Pathfinding, Categories), **Rendering** and **Load Lua
and execute** (`lua/sim/**`, `lua/ui/**`, Blueprints). She is **not**
responsible for game logic: `Unit.lua`, `defaultunits.lua`, `aibrain.lua`,
`construction.lua` are **executed, not recreated**.

### Verboten

- ❌ **Recreate game logic in TS.** If the answer is in `lua/sim/` or
  `lua/ui/` is written, this file is executed - no TS, no HTML replica.
- ❌ **Invent numbers.** Each value comes from a blueprint that
  Original Lua or the Decomp. No "that feels right."
- ❌ **Stubs in the production path.** Missing engine parts have to **pop**,
  don't silently deliver nonsense. (The old stub trap has every green one for months
  Test rendered worthless. He's not coming back.)
- ❌ **Half engines.** Exactly one sim boat: `installEngine()`
  ([src/lua/engine.ts](src/lua/engine.ts)); exactly one UI boot:
  `installUiEngine()` + `setupGameUi()` ([src/lua/uiEngine.ts](src/lua/uiEngine.ts),
  Order = `gamemain.lua:132-154`). Anyone who owns the engine
  puts things together, leaves parts out and doesn't notice it.
- ❌ **Lua/C++ in TS template literals.** Lua belongs in `.lua` files under
  [src/engine-lua/](src/engine-lua/); the TS files next to it are just
  Loader + Bridge.

Two **Auto-Vivifiers** are deliberately in the productive path (nothing pops there):
`moho.<x>` creates empty classes ([moho.lua](src/engine-lua/moho.lua)),
`__getBrain(army)` legt still Brains an ([brain.lua](src/engine-lua/brain.lua)).

## Sources of Truth — in that order

1. **IDA-Decompilation:** `Cfile/ForgedAlliance.exe.c` (~2 Mio. Zeilen, volle
   `Moho::`-Symbole, gitignored). Zusätzlich MCP-Zugriff (`mcp__ida__*`).
   For every question “how does the engine do this?” → search here.
2. **Original Lua + Blueprints:** `npx tsx scripts/peek-lua.ts <pfad> <von> <bis>`
   or `--grep <regex>` (searches lua.scd, mohodata.scd, units.scd incl. `.bp`).
3. **faf-re / Community / Web** — only if 1 and 2 don't give anything away.

Don't hallucinate anything. First research, then implement, then counteract
verify real data.

## Architecture in one paragraph

`src/engine-lua/*.lua` is what the C++ engine puts into the Lua states
(moho-classes, globals, scheduler, maui-substrate, ui-globals); TS next to it only
Loader/Bridges. Sim läuft im Worker (`src/sim/luaSimWorker.ts`, 10-Hz-Beat),
UI-VM im Main-Thread (`src/ui/gameUi.ts` → maui-Baum → DOM via
`src/ui/mauiRenderer.ts`). Click into the world: `src/ui/worldCommands.ts` asks
`commandmode.lua` — the engine doesn't decide anything.

### Two Lua VMs — not one

Each engine binding is registered in exactly one state via `mPrevDef`
([docs/research/engine-api.md](docs/research/engine-api.md), generiert):
`scr_CoreInits` = both VMs (70), `scr_UserInits` = UI only (453),
`sim_SimInits` = Sim only (626). That's why the sim doesn't know `_c_CreateCursor`
and the UI no `CreateUnit`. Never boot both into a VM.

### Boot order is not cosmetic

`installEngine()`: Engine primitives first (SimThreads → Globals → Economy →
Motion → Build), then **RELOAD `/lua/system/class.lua`**, then moho →
utils → Blueprints → UnitFactory → SimSync → terrainTypes → `setupSession()`.
`class.lua` lädt **zweimal**, weil `class.lua:78`
`local ForkThread = ForkThread` snapshotted — this is still the case with the bootstrap
`nil`, and without reload `class.lua:377` dies with every state change
away from the polluter. `globals.lua` deliberately does not contain `Class(`.

### FA-Lua is one dialect (two in fact)

- **LuaPlus:** `nil`/Numbers/Strings have metatables; `nil.foo` delivers `nil`
  instead of banging - FAs `config.lua:14-16` allows reading consciously, and
  the original UI **relies on** (uiutil.lua:343 on the first
  `SetupUI()`). Hergestellt via `debug.setmetatable` in
  [boot.lua](src/engine-lua/boot.lua).
- **`config.lua` brings:** the **strict `_G`** (access to
  throws non-existent globals; `x = nil` does NOT create a key —
  Initialize engine globals with `false`), the **Thread object**
  (Coroutine metatable with `Destroy = KillThread`) and `iscallable`.
- **Two dialects in the repo:** VFS files (original Lua, `.bp`) pass through
  `transpileFaLua` (`#` = Kommentar, `!=`→`~=`, `continue`, `for k,v in tbl do`);
  Files from `src/engine-lua/` are **Standard Lua 5.4** (`#t` =
  length operator!) and go raw into `host.eval()`. An Engine Lua file ins
  Moving VFS makes every `#t` silently a comment.

## Cross-cutting facts (always apply)

- **Blueprint-Struct-Defaults:** the engine ctor (`Moho::RUnitBlueprint`
  @0x51E480) occupies **every field** - the Lua picks up without checking
  `bp.Defense.Shield.ShieldSize` too, even without a shield section in the `.bp`.
- **`class.lua` copies base class fields** (no `__index` fallback): on
  Method name may appear in exactly **one** moho name list, otherwise
  a no-op overshadows the real implementation.
- **Production ≠ consumption** (separate switches) and **Construction sites are for
  the economy invisible**.
- **The sim has the skeleton of the unit** (weapons validate bones), and the
  Engine calls **`OnCreate` on each weapon** — order is semantics.
- **wasmoon:** a JS function must never give `null` to Lua
  (`LuaHost.setGlobal` converts `null → undefined`), otherwise the VM dies deeply
  in fremder Lua.

All other proven facts (economy, snap, fire state, writings,
usersync, MaxBrake ...): **before working on the topic
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
- Commits in ENGLISH: what and why, one milestone per commit.

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

| Dokument                                                                                                               | Inhalt                                                          |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [docs/STATUS.md](docs/STATUS.md)                                                                                        | Stand + bekannte Löcher (zuerst lesen)                         |
| [docs/PLAN-1ZU1.md](docs/PLAN-1ZU1.md)                                                                                  | Konsolidierter 1:1-Fahrplan (Meilensteine)                      |
| [docs/PLAN-UI.md](docs/PLAN-UI.md)                                                                                      | Weg zur echten`lua/ui`, mit Decomp-Belegen                    |
| [docs/MASTERPLAN.md](docs/MASTERPLAN.md)                                                                                | Gesamtinventur Vollspiel, Phasen A–F                           |
| [docs/FORMATS.md](docs/FORMATS.md)                                                                                      | Dateiformate (scd/scm/sca/scmap/dds), verifiziert               |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                                                            | Architektur (älter; bei Widerspruch gilt CLAUDE.md)            |
| [research/engine-api.md](docs/research/engine-api.md)                                                                   | **Alle** Engine-Bindungen je VM (generiert — Checkliste) |
| [research/verified-facts.md](docs/research/verified-facts.md)                                                           | Belegtes Detailwissen nach Themen                               |
| [research/economy-binary.md](docs/research/economy-binary.md)                                                           | Zwei-Ratio-Ökonomie aus dem Binary                             |
| [research/build-task-binary.md](docs/research/build-task-binary.md)                                                     | Bau-Task-Ablauf                                                 |
| [research/command-dispatch-binary.md](docs/research/command-dispatch-binary.md)                                         | Befehls-Dispatch (Command→Task)                                |
| [research/damage-binary.md](docs/research/damage-binary.md)                                                             | Schadenssystem                                                  |
| [research/movement-path.md](docs/research/movement-path.md)                                                             | Bewegung: Grid, HaStar, Navigator, Steering                     |
| [research/weapons.md](docs/research/weapons.md)                                                                         | Waffensystem                                                    |
| [research/ui-complete.md](docs/research/ui-complete.md)                                                                 | UI-System komplett                                              |
| [research/game-shell.md](docs/research/game-shell.md)                                                                   | Front-End, Lobby, Session-Start                                 |
| [research/effects-audio.md](docs/research/effects-audio.md)                                                             | Effekt-Blueprints + XACT-Audio                                  |
| [research/sound-fmod.md](docs/research/sound-fmod.md)                                                                   | Audio-Bänke                                                    |
| [research/intel-vision.md](docs/research/intel-vision.md)                                                               | Intel/Recon/Sichtbarkeit                                        |
| [research/net-replay-save.md](docs/research/net-replay-save.md)                                                         | Lockstep, Replay, Save                                          |
| [research/render-details.md](docs/research/render-details.md)                                                           | Renderer, SCMAP-Reststruktur                                    |
| [research/lua-gameplay.md](docs/research/lua-gameplay.md)                                                               | FA-Lua-Dialekt-Nachweis (Lua 5.0.1)                             |
| [research/engine-core.md](docs/research/engine-core.md) / [engine-architecture.md](docs/research/engine-architecture.md) | Engine-Kern aus der Decomp                                      |

## Sprache

Antworten im Chat auf Deutsch. ALLES im Repo auf Englisch: Code-Kommentare, Commits, Log-Meldungen, Check-Texte, neue Doku.
