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
- ❌ **Inventing values.** Every factual implementation value MUST have a
  traceable source. Preferred sources are the original Lua, Blueprints, and
  IDA decompilation. No “that feels right.”
- ❌ **Stubs in the production path.** Missing engine behavior MUST fail loudly;
  do not silently make an unimplemented behavior appear implemented.
- ❌ **Partial engines.** Exactly one Sim boot: `installEngine()`
  ([src/lua/engine.ts](src/lua/engine.ts)); exactly one UI boot:
  `installUiEngine()` + `setupGameUi()` ([src/lua/uiEngine.ts](src/lua/uiEngine.ts),
  order = `gamemain.lua:132-154`). Manually assembling the engine leaves out
  parts without noticing.
- ❌ **Lua/C++ in TS template literals.** Lua belongs in `.lua` files under
  [src/engine-lua/](src/engine-lua/); the adjacent TS files are only loaders
  and bridges.

Two **Auto-Vivifiers** are deliberately in the production path: `moho.<x>`
creates empty classes ([moho.lua](src/engine-lua/moho.lua)), and
`__getBrain(army)` creates Brains ([brain.lua](src/engine-lua/brain.lua)).
These are explicit compatibility exceptions, not proof that the represented
engine behavior exists. They MUST NOT silently make an unimplemented behavior
appear implemented; the first semantically required operation MUST fail loudly
or be otherwise explicitly verified.

### Source authority and evidence

There is no single global source order. The correct primary source depends on
what is being established:

**Gameplay / UI behavior**
1. **Original Lua + Blueprints:** `npx tsx scripts/peek-lua.ts <path> <from> <to>`
   or `--grep <regex>` (searches lua.scd, mohodata.scd, and units.scd, including
   `.bp`).
2. **IDA decompilation:** `Cfile/ForgedAlliance.exe.c` (~2 million lines, full
   `Moho::` symbols, gitignored) and available MCP access (`mcp__ida__*`) for
   native engine semantics behind the Lua behavior.
3. **faf-re / community / web** — only when primary evidence does not answer the
   question.

**Native engine behavior**
1. **IDA decompilation**
2. **Original Lua call sites, bindings, and Blueprints**
3. **faf-re / community / web** — only when primary evidence does not answer the
   question.

A lower-priority source MUST NOT silently override higher-priority evidence.
If credible sources conflict, document the conflict and resolve it from
primary evidence before implementation whenever possible.

### Unknown / unverified behavior

If the available evidence is insufficient:

- do not infer missing behavior;
- do not choose a merely plausible implementation;
- do not create a placeholder that behaves as implemented;
- mark the behavior **UNVERIFIED**;
- record the missing evidence or required research;
- stop implementation of that behavior until enough evidence exists.

Words such as “likely”, “probably”, “should”, “typically”, or “I assume” are
not implementation evidence.

For research claims, record enough provenance to reproduce the finding: source,
relevant file/function/line or address when available, the claim, and confidence.

**Do not hallucinate. Research first, then implement, then verify against real
data.**

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

## Verification invariants

The repository's tests are verification suites against real game data, not
mocks. Verification is part of correctness, not optional cleanup.

A failing verification test is a correctness finding, but it MUST NOT be left
unresolved in a commit. The agent MUST identify whether the implementation, test,
or underlying assumption is wrong; attach evidence; fix it or explicitly record
a verified limitation; and leave the repository in a green verification state
before committing, unless the repository explicitly documents a deliberate
non-green checkpoint.

If a change exposes that an earlier implementation was wrong, prefer correcting
the implementation and the evidence trail over weakening the test merely to
restore green status.

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
- Run the appropriate suite while working; before **every commit**, run
  `npx tsc --noEmit` and `npm test` (all suites).
- Browser end-to-end: `?sandbox=<map>&selftest=<blueprint>` runs the tech demo
  without a mouse (headless Chrome; the Sim ticks in real time, not under
  `--virtual-time-budget`).
- **Debugging:** errors in Lua threads are only logged — first search the WARN
  lines for `ForkThread-Fehler:`.
- Commit messages are in **English**: what and why, one milestone per commit.

## Single semantic source

There MUST be one authoritative semantic representation of each game data
concept.

Secondary parsers or projections may exist for rendering, indexing, file-format
access, or other explicitly scoped purposes, but they MUST NOT independently
redefine game semantics.

The blueprint data is currently read both by the TS parser and by the real
`LoadBlueprints()` pipeline. Treat the `LoadBlueprints()` representation as the
authoritative semantic representation. Any TS-side representation MUST be a
strict projection for its documented purpose.

If two representations disagree on a semantic value, behavior MUST be treated
as **UNVERIFIED** until the discrepancy is resolved and covered by verification.

## Working style by model

All agents follow the same correctness, evidence, architecture, and verification
rules. Agent autonomy and tool usage MAY vary by environment, but MUST NOT change
what is considered correct.

**Baseline:** take small, verifiable steps; before major changes across multiple
files, reconfirm the intended scope when required; for broad searches, use one
research subagent instead of unnecessary fan-out. Effort: medium; high for
difficult reasoning.

**Higher-capability models:** may work autonomously on larger changes when the
verification gates remain green. Define the specification up front (task,
intent, constraints, and acceptance criteria) before implementation when the
change is non-trivial.

**Fan out and check coverage:** when parallel research is useful, use independent
agents across genuinely independent topics or subsystems. Before declaring a
large change done, have a fresh agent inspect the diff for correctness and
requirements coverage. The reviewer is not allowed to replace primary evidence
or silently lower verification standards.

**State the scope of a rule literally.** When an invariant applies to every case,
write “every/all”: every value needs traceable evidence; every missing engine
behavior fails loudly unless explicitly listed as a compatibility exception;
all game logic runs in the original Lua.

**Never** weaken the invariants (the core principle and “Prohibited”), the honesty
rules, or correctness because of the active model. Anchor autonomous work to a
check that can actually be run (`npx tsc --noEmit`, the appropriate `verify-*`
suite, `npm test`, or the browser self-test `?sandbox=…`) — never to “looks done.”

## Further documentation

| Document | Contents |
| --- | --- |
| [docs/STATUS.md](docs/STATUS.md) | Status + known gaps (read first) |
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
| [research/engine-core.md](docs/research/engine-core.md) / [engine-architecture.md](docs/engine-architecture.md) | Engine core from the Decomp |

## Language

Respond in German in chat. Keep **all** repository content in English: code
comments, commits, log messages, check text, and new documentation.

Preserve HTML entities and syntax exactly during text translation (for example,
retain `&amp;` rather than replacing it with a raw `&`).