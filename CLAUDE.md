# Claude Commander: Forged Alliance

Browser reimplementation of Supreme Commander: Forged Alliance — **1:1**.
Assets come from the user's installation (bring your own assets).

**Target experience:** Connect a game directory → the **real FA main menu**
(`lua/ui/menus/main.lua`) → Skirmish through the real lobby → a session with the
real game UI. **No web menus in the game and no recreated panels.** The web
shell (Start/Sandbox/Unit Viewer/Map Viewer) is only a tool and launcher until
the original front end is running.

## The core principle — this is non-negotiable

**The original Lua IS the game. The engine executes it.**

The engine (TypeScript/WebGL) is responsible for **calculations** (physics,
economics mathematics, pathfinding, categories), **rendering**, and **loading
and executing Lua** (`lua/sim/**`, `lua/ui/**`, Blueprints). It is **not**
responsible for game logic: `Unit.lua`, `defaultunits.lua`, `aibrain.lua`, and
`construction.lua` are **executed, not recreated**.

### Prohibited

- ❌ **Recreating game logic in TS.** If the answer is in `lua/sim/` or
  `lua/ui/`, execute that file — do not recreate it in TS or HTML.
- ❌ **Inventing values.** Every value comes from a blueprint, the original Lua,
  or the Decomp. No “that feels right.”
- ❌ **Stubs in the production path.** Missing engine parts must **fail loudly**;
  do not silently return nonsense. (The old stub trap made every passing test
  worthless for months. It must not return.)
- ❌ **Partial engines.** Exactly one Sim boot: `installEngine()`
  ([src/lua/engine.ts](src/lua/engine.ts)); exactly one UI boot:
  `installUiEngine()` + `setupGameUi()` ([src/lua/uiEngine.ts](src/lua/uiEngine.ts),
  order = `gamemain.lua:132-154`). Manually assembling the engine leaves out
  parts without noticing.
- ❌ **Lua/C++ in TS template literals.** Lua belongs in `.lua` files under
  [src/engine-lua/](src/engine-lua/); the adjacent TS files are only loaders
  and bridges.

**Four Auto-Vivifiers** are deliberately in the production path (they do not
fail there), and the list is exhaustive:

1. `moho.<x>` creates empty classes ([moho.lua](src/engine-lua/moho.lua))
2. `__getBrain(army)` creates Brains ([brain.lua](src/engine-lua/brain.lua))
3. `categories.<NAME>` returns a token category
   ([globals.lua](src/engine-lua/globals.lua))
4. `EconomyManager.army(n)` creates an army economy
   ([economy.ts](src/sim/economy.ts))

Creating the shell so the original Lua can **reference** it is the sanctioned
part. **Answering a real question with invented state is not** — an
auto-vivified object must fail on the first semantically required operation,
and where the retail engine rejects the input outright, so do we (an undeclared
army index: `Cfile:980346-980352`). The reference-works / call-throws pattern is
in [ui-globals-missing.lua](src/engine-lua/ui-globals-missing.lua). A fifth
entry in that list is a change to this document, not an implementation detail.

## Sources of truth — in this order

1. **IDA decompilation:** `Cfile/ForgedAlliance.exe.c` (~2 million lines, full
   `Moho::` symbols, gitignored). MCP access is also available (`mcp__ida__*`).
   For every “how does the engine do this?” question, search here first.
2. **Original Lua + Blueprints:** `npx tsx scripts/peek-lua.ts <path> <from> <to>`
   or `--grep <regex>` (searches lua.scd, mohodata.scd, and units.scd, including
   `.bp`).
3. **faf-re / community / web** — only when 1 and 2 provide no answer, and
   **only to tell you where to look**. Rank 3 never supplies a value on its
   own: anything found there is verified against 1 or 2 before it enters the
   code, or carried explicitly as `UNVERIFIED`. faf-re is wrong in places; on
   conflict the Decomp wins.

**`UNKNOWN` / `UNVERIFIED` is a legitimate state.** Research that did not
resolve is recorded as unresolved — in the plan's Evidence Base, in
[docs/STATUS.md](docs/STATUS.md), or in a comment at the site. An open question
blocks the affected task; it never licenses a guess.

Do not hallucinate. Research first, then implement, then verify against real
data.

## Architecture in one paragraph

`src/engine-lua/*.lua` is what the C++ engine puts into the Lua states
(moho classes, globals, scheduler, maui substrate, ui globals); the adjacent TS
contains only loaders and bridges. The Sim runs in a worker
(`src/sim/luaSimWorker.ts`, 10 Hz beat); the UI VM runs on the main thread
(`src/ui/gameUi.ts` → maui tree → DOM via `src/ui/mauiRenderer.ts`). A click in
the world: `src/ui/worldCommands.ts` asks `commandmode.lua` — the engine does
not decide anything.

### Two Lua VMs — not one

Each engine binding is registered in exactly one state via `mPrevDef`
([docs/research/engine-api.md](docs/research/engine-api.md), generated):
`scr_CoreInits` = both VMs (70), `scr_UserInits` = UI only (453),
`sim_SimInits` = Sim only (626). That is why the Sim does not know
`_c_CreateCursor` and the UI does not know `CreateUnit`. Never boot both into
one VM.

### Boot order is not cosmetic

`installEngine()`: engine primitives first (SimThreads → Globals → Economy →
Motion → Build), then **reload `/lua/system/class.lua`**, then moho → utils →
Blueprints → UnitFactory → SimSync → terrainTypes → `setupSession()`.
`class.lua` loads **twice** because `class.lua:78`
`local ForkThread = ForkThread` takes a snapshot — during bootstrap it is still
`nil`, and without the reload `class.lua:377` fails on every state transition,
far from the cause. `globals.lua` deliberately contains no `Class(`.

### FA Lua is one dialect — actually two

- **LuaPlus:** `nil`/numbers/strings have metatables; `nil.foo` returns `nil`
  instead of failing — FA's `config.lua:14-16` deliberately allows that read,
  and the original UI **relies on it** (uiutil.lua:343 during the first
  `SetupUI()`). Implemented through `debug.setmetatable` in
  [boot.lua](src/engine-lua/boot.lua).
- **`config.lua` provides:** the **strict `_G`** (accessing nonexistent globals
  throws; `x = nil` does **not** create a key — initialize engine globals with
  `false`), the **Thread object** (a coroutine metatable with
  `Destroy = KillThread`), and `iscallable`.
- **Two dialects in the repo:** VFS files (original Lua, `.bp`) pass through
  `transpileFaLua` (`#` = comment, `!=`→`~=`, `continue`, `for k,v in tbl do`);
  files from `src/engine-lua/` are **standard Lua 5.4** (`#t` = length
  operator) and go raw into `host.eval()`. Moving an engine Lua file into the
  VFS silently turns every `#t` into a comment.

## Cross-cutting facts (always apply)

- **Blueprint struct defaults:** the engine constructor (`Moho::RUnitBlueprint`
  @0x51E480) populates **every field** first — Lua accesses
  `bp.Defense.Shield.ShieldSize` without checking, even when the `.bp` has no
  Shield section.
- **One authoritative blueprint representation.** The real `LoadBlueprints()`
  pipeline ([blueprints.lua](src/engine-lua/blueprints.lua)) owns blueprint
  semantics — struct defaults and derivations included. The TS reader
  ([blueprint.ts](src/formats/blueprint.ts)) and its consumers are a **pure
  projection** (rendering, indexing, binary access) and must not re-derive
  semantics with their own defaults. Where a projection unavoidably needs a
  derived value, it reproduces the engine derivation *with its citation* **and**
  a suite compares it against the pipeline for every affected blueprint. **If
  the two readers disagree, verification fails**
  ([verify-ogrid.ts](scripts/verify-ogrid.ts) does this for placement).
- **`class.lua` copies base-class fields** (there is no `__index` fallback): a
  method name may appear in exactly **one** moho name list; otherwise a no-op
  shadows the real implementation.
- **Production ≠ consumption** (separate switches), and **construction sites
  are invisible to the economy**.
- **The Sim has the unit skeleton** (weapons validate bones), and the engine
  calls **`OnCreate` on every weapon** — order is semantic.
- **wasmoon:** a JS function must never pass `null` to Lua
  (`LuaHost.setGlobal` converts `null → undefined`), or the VM fails deep in
  third-party Lua.

For all other established facts (economy, snap, fire state, fonts, usersync,
MaxBrake, ...), **read
[docs/research/verified-facts.md](docs/research/verified-facts.md) before
working on the topic.**

## Tools & workflow

```bash
npm test                                    # all verification suites
npx tsx --import ./scripts/register-lua.mjs scripts/verify-<x>.ts   # one suite
npx tsc --noEmit                            # Typecheck
npx tsx scripts/peek-lua.ts --grep <regex>  # search original Lua/Blueprints
```

- **Every script that imports `src/lua/*` or `src/sim/*` needs
  `--import ./scripts/register-lua.mjs`**; otherwise it gets
  `ERR_UNKNOWN_FILE_EXTENSION ".lua"`. `npm test` sets it itself.
- Tests are verification suites against real game data, not mocks. A failing
  test after an honesty correction is a **finding**, not a regression — but a
  finding is something you *record*, not something you leave lying around.
- Run the appropriate suite while working; before **every commit**,
  `npx tsc --noEmit` and `npm test` (all suites) must **pass**. A red suite is
  either fixed in that commit or written into
  [docs/STATUS.md](docs/STATUS.md) as an accepted finding in the same commit.
  Neither “the tests were run” nor “it is a finding” replaces a green gate.
- **Start every session by reading the state, then running the gate — before
  changing anything:** `git log --oneline -15`, [docs/STATUS.md](docs/STATUS.md),
  the open tasks in `specs/*/tasks.md`, then `npm test`. This is not ceremony:
  commit `8325662` inherited a red `verify-combat` and pushed it, and turret
  weapons were dead for ~23 hours of committed history because nobody looked
  first.
- **The gate runs on push**, via `.githooks/pre-push`. Activate it once with
  `git config core.hooksPath .githooks`. It has to be local: 49 of the 56
  suites read the original game files, which no CI runner has. The GitHub
  workflow only typechecks and runs the three asset-free suites — a green tick
  there does **not** mean the engine was verified.
- **A check that cannot fail is not a check.** See every new check go red once
  before trusting it: undo the fix, confirm red, restore. Written down because
  in one session a check counted a field that does not exist (always 0, always
  green), and three tasks named suites that were never extended.
- Browser end-to-end: `?sandbox=<map>&selftest=<blueprint>` runs the tech demo
  without a mouse (headless Chrome; the Sim ticks in real time, not under
  `--virtual-time-budget`). **It only logs — it cannot fail yet**; the running
  end-to-end gate is `scripts/verify-playthrough.ts`.
- **Debugging:** errors in Lua threads are only logged — first search the WARN
  lines for `ForkThread-Fehler:`.
- Commit messages are in **English**: what and why, one milestone per commit.

### Spec-driven workflow (spec-kit)

[GitHub Spec Kit](https://github.com/github/spec-kit) is installed
(`.specify/`, skills in `.claude/skills/speckit-*`). Use it for work that spans
more than one file or one session — not for a single verified fix.

- **The constitution** ([.specify/memory/constitution.md](.specify/memory/constitution.md))
  is the governance mirror of this file: the five invariants (original Lua is
  the game, evidence over invention, fail loudly, one boot path/two VMs,
  verification against real data). Every spec and plan runs a Constitution
  Check against it. **On conflict, CLAUDE.md wins** and the constitution is
  amended to match.
- **Loop:** `/speckit-specify` (what and why, no solution) → `/speckit-clarify`
  (optional) → `/speckit-plan` → `/speckit-tasks` → `/speckit-analyze`
  (optional) → `/speckit-implement` → `/speckit-converge` (repeat until
  converged). Artifacts land in `specs/<NNN>-<name>/`.
- **Project rule:** every task names the check that proves it —
  a `scripts/verify-*.ts` suite, `npm test`, or `?sandbox=…&selftest=…`.
  A task without a runnable check is not a task.
- The scripts are PowerShell (`.specify/scripts/powershell/`); they create
  `specs/` directories only and never switch git branches.

## Working style by model

Everything above applies to **every** model. This section changes only *how
much* work you take on at a time and with what effort — **never what is
correct**. Your active model is listed in your system prompt.

**Baseline** (Sonnet class, every model, and whenever uncertain): take small,
verifiable steps; before major changes across multiple files, reconfirm with
the user; for broad searches, use **one** research subagent instead of further
fan-out. Effort: medium; high for difficult reasoning.

**Opus 4.8 and the Claude-5 family (Fable 5):** work autonomously. Plan
multi-step work from beginning to end, and complete long efforts (migrations or
changes across many files) **without stopping** as long as the type check and
suites remain green. Define the specification up front (task, intent,
constraints, and acceptance criteria) in one pass, not piecemeal. Effort:
start coding/agent work at `xhigh`, use at least `high` for reasoning, and use
`max` only for genuine edge cases (reconsidering structured tasks). The user
can increase this further with **ultracode** (xhigh + deterministic workflow
fan-out).

**Fan out and check coverage (Opus 4.8 and newer):** these models do not spawn
enough agents on their own. Explicitly fan out parallel subagents across
independent topics — for example, one agent per research topic (front-end menu,
WorldView, session start, combat, ...) or per engine subsystem. **Do not** fan
out work that can be completed in one answer. Before declaring work “done,”
have a fresh subagent inspect your own diff — their task is **coverage**
(report every correctness or requirements gap, with confidence and severity),
not filtering. This repo has no prebuilt reviewer agents yet; use
`/code-review` or a `general-purpose` agent with a clear review mandate.

**State the scope of a rule literally.** These models follow instructions
literally and do not generalize a rule on their own. When an invariant applies
to *every* case, write “every/all”: *every* value comes from a blueprint, Lua,
or the Decomp; *every* missing engine part fails loudly; *all* game logic runs
in the original Lua.

**Never** weaken the invariants (the core principle and “Prohibited”), the
honesty rules, or correctness by making them dependent on the currently active
model — the model list can be stale; when in doubt, use the baseline. Anchor
every autonomous step to a check you can **actually run**
(`npx tsc --noEmit`, the appropriate `verify-*` suite, `npm test`, or the
browser self-test `?sandbox=…&selftest=…`) — never to “looks done.”

## Further documentation

| Document | Contents |
| --- | --- |
| [docs/STATUS.md](docs/STATUS.md) | Status + known gaps (read first) |
| [.specify/memory/constitution.md](.specify/memory/constitution.md) | Spec-kit constitution (the invariants as governance) |
| [docs/PLAN-1ZU1.md](docs/PLAN-1ZU1.md) | Consolidated 1:1 roadmap (milestones) |
| [docs/PLAN-UI.md](docs/PLAN-UI.md) | Path to the real `lua/ui`, with Decomp evidence |
| [docs/MASTERPLAN.md](docs/MASTERPLAN.md) | Full-game inventory, phases A–F |
| [docs/FORMATS.md](docs/FORMATS.md) | File formats (scd/scm/sca/scmap/dds), verified |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture (older; CLAUDE.md applies if it conflicts) |
| [research/engine-api.md](docs/research/engine-api.md) | **All** engine bindings per VM (generated — checklist) |
| [research/verified-facts.md](docs/research/verified-facts.md) | Established detailed knowledge by topic |
| [research/economy-binary.md](docs/research/economy-binary.md) | Two-ratio economy from the binary |
| [research/build-task-binary.md](docs/research/build-task-binary.md) | Build-task flow |
| [research/command-dispatch-binary.md](docs/research/command-dispatch-binary.md) | Command dispatch (Command→Task) |
| [research/damage-binary.md](docs/research/damage-binary.md) | Damage system |
| [research/movement-path.md](docs/research/movement-path.md) | Movement: grid, HaStar, navigator, steering |
| [research/weapons.md](docs/research/weapons.md) | Weapon system |
| [research/ui-complete.md](docs/research/ui-complete.md) | Complete UI system |
| [research/game-shell.md](docs/research/game-shell.md) | Front end, lobby, session start |
| [research/effects-audio.md](docs/research/effects-audio.md) | Effects blueprints + XACT audio |
| [research/sound-fmod.md](docs/research/sound-fmod.md) | Audio banks |
| [research/intel-vision.md](docs/research/intel-vision.md) | Intel/recon/visibility |
| [research/net-replay-save.md](docs/research/net-replay-save.md) | Lockstep, replay, save |
| [research/render-details.md](docs/research/render-details.md) | Renderer, remaining SCMAP structure |
| [research/lua-gameplay.md](docs/research/lua-gameplay.md) | FA Lua dialect evidence (Lua 5.0.1) |
| [research/engine-core.md](docs/research/engine-core.md) / [engine-architecture.md](docs/research/engine-architecture.md) | Engine core from the Decomp |

## Language

Respond in German in chat. Keep **all** repository content in English: code
comments, commits, log messages, check text, and new documentation.

Preserve HTML entities and syntax exactly during text translation (for example,
retain `&amp;` rather than replacing it with a raw `&`).
