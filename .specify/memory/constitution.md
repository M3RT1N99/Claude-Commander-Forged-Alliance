<!--
Sync Impact Report
- Version change: 1.0.0 → 1.1.0
- Modified principles:
  - II. Evidence Over Invention — rank-3 sources may only point at where to look;
    a rank-3 value must be verified against rank 1/2 or carried as UNVERIFIED.
    Adds UNKNOWN/UNVERIFIED as a legitimate recorded state.
  - III. Fail Loudly — the sanctioned auto-vivifier list corrected from two to
    four (it was factually stale); adds the requirement that an auto-vivified
    object must fail on the first semantically required operation.
  - V. Verification Against Real Data — the commit gate now requires the checks
    to PASS, not merely to be run; a red suite is fixed or recorded in
    docs/STATUS.md in the same commit.
- Added sections: Technical Constraints → "One authoritative blueprint
  representation"; Governance → "Rejected amendments" (so refuted proposals are
  not re-proposed).
- Removed sections: none
- Follow-up TODOs: none. The __getBrain hardening required by Principle III is
  tracked as a task in specs/001-engine-fidelity-fixes/tasks.md.
-->

# Claude Commander: Forged Alliance Constitution

Browser reimplementation of Supreme Commander: Forged Alliance — **1:1**. Assets come from the
user's installation. This constitution encodes the project's non-negotiable invariants; it is the
governance mirror of `CLAUDE.md`, which remains the operational source of truth.

## Core Principles

### I. The Original Lua IS the Game (NON-NEGOTIABLE)

The engine (TypeScript/WebGL) is responsible for calculations (physics, economy math, pathfinding,
categories), rendering, and loading/executing Lua (`lua/sim/**`, `lua/ui/**`, blueprints). It MUST
NOT contain game logic. If the answer is in `lua/sim/` or `lua/ui/`, that file is executed — never
recreated in TS or HTML. No web menus in the game, no recreated panels: the target is the real FA
front end (`lua/ui/menus/main.lua`) driving the real lobby and the real game UI.

### II. Evidence Over Invention

Every value comes from a blueprint, the original Lua, or the IDA decompilation — no "that feels
right". Sources of truth, in strict order: (1) `Cfile/ForgedAlliance.exe.c` (IDA decomp, also via
`mcp__ida__*`), (2) original Lua + blueprints (`npx tsx scripts/peek-lua.ts`), (3) faf-re /
community / web.

**Rank 3 may only tell you WHERE to look.** It never supplies a value on its own: anything found
there MUST be verified against rank 1 or rank 2 before it enters the code, or be carried
explicitly as `UNVERIFIED`. faf-re is known to be wrong in places; on conflict, the decomp wins.

**UNKNOWN / UNVERIFIED is a legitimate state.** Research that did not resolve is recorded as
unresolved — in the plan's Evidence Base, in `docs/STATUS.md`, or in a comment at the site. An
unresolved question blocks the affected task; it never licenses a guess. Every implementation
claim carries its evidence (`Cfile:line` / `lua:line`). Research first, then implement, then
verify against real data.

### III. Fail Loudly — No Stubs in the Production Path

Missing engine parts MUST fail loudly; silently returning nonsense is prohibited (the historical
stub trap made every passing test worthless for months). This is an absolute rule, not a process
gate: there is no category of "temporary, audited" shim.

Four auto-vivifiers are sanctioned in the production path, and the list is exhaustive:

1. `moho.<x>` creating empty classes (`src/engine-lua/moho.lua`)
2. `__getBrain(army)` creating brains (`src/engine-lua/brain.lua`)
3. `categories.<NAME>` returning a token category (`src/engine-lua/globals.lua`)
4. `EconomyManager.army(n)` creating an army economy (`src/sim/economy.ts`)

**An auto-vivified object MUST fail on the first semantically required operation** rather than
behaving like a valid engine object. Creating the shell so that the original Lua can *reference*
it is the sanctioned part; answering a real question with invented state is not. Where the retail
engine rejects the input outright, so must we (e.g. an undeclared army index, Cfile:980346-980352).

Adding a fifth entry to that list is a constitutional amendment, not an implementation detail.
The referencing-works / calling-throws pattern already exists in
`src/engine-lua/ui-globals-missing.lua` and is the model for making a gap loud.

### IV. One Engine, One Boot Path, Two VMs

Exactly one Sim boot (`installEngine()` in `src/lua/engine.ts`) and exactly one UI boot
(`installUiEngine()` + `setupGameUi()` in `src/lua/uiEngine.ts`, order = `gamemain.lua:132-154`).
Manually assembling partial engines is prohibited. Sim VM and UI VM are separate states with
separate binding sets (`docs/research/engine-api.md`); booting both binding sets into one VM is
prohibited. Boot order is semantic, not cosmetic (e.g. the deliberate double load of
`/lua/system/class.lua`).

### V. Verification Against Real Data (NON-NEGOTIABLE)

Every change is anchored to a check that can actually run: `npx tsc --noEmit`, the appropriate
`scripts/verify-*.ts` suite, `npm test`, or the browser self-test
(`?sandbox=<map>&selftest=<blueprint>`) — never to "looks done". Tests are verification suites
against real game data, not mocks.

A failing test after an honesty correction is a **finding**, not a regression — that stays true.
But a finding is something you record, not something you leave lying around: **before every
commit, `npx tsc --noEmit` and `npm test` (all suites) MUST PASS.** A red suite is either fixed in
that commit or written into `docs/STATUS.md` as an accepted finding in the same commit. Neither
"the tests were run" nor "it is a finding" is a substitute for a green gate.

The project's own measuring instruments are covered by this principle. An audit that cannot see
what it claims to measure (`scripts/coverage-engine.ts`) is a defect of the highest priority,
because every other number depends on it.

## Technical Constraints

- **One authoritative blueprint representation.** The real `LoadBlueprints()` pipeline
  (`src/engine-lua/blueprints.lua`) owns blueprint semantics, including the engine's struct
  defaults and derivations. Any secondary reader (`src/formats/blueprint.ts` and its consumers)
  is a strictly defined **projection** — rendering, indexing, binary access — and MUST NOT
  re-derive blueprint semantics with its own defaults. Where a projection unavoidably needs a
  derived value, it reproduces the engine derivation with its citation **and** a suite compares it
  against the pipeline for every affected blueprint. **If two readers disagree, verification
  fails** (`scripts/verify-ogrid.ts`).
- **Two Lua dialects:** VFS files (original Lua, `.bp`) go through `transpileFaLua`; files in
  `src/engine-lua/` are standard Lua 5.4 and go raw into `host.eval()`. Moving an engine Lua file
  into the VFS silently turns every `#t` into a comment — prohibited without re-review.
- **No Lua/C++ in TS template literals.** Lua lives in `.lua` files under `src/engine-lua/`;
  adjacent TS files are loaders and bridges only.
- **Blueprint struct defaults:** the engine constructor populates every field first
  (`Moho::RUnitBlueprint` @0x51E480); Lua reads nested fields without checking.
- **`class.lua` copies base-class fields** (no `__index` fallback): a method name may appear in
  exactly one moho name list, or a no-op shadows the real implementation.
- **wasmoon:** a JS function must never pass `null` to Lua; integers/bitmasks in the Lua→JS JSON
  layer must never be serialized with `%.Ng` formats (bit-flipping trap) — use `%d`/jint.
- **Language:** all repository content is English (code, comments, commits, logs, check text,
  docs). Chat with the user is German.

## Development Workflow & Quality Gates

- **Brownfield loop (Spec Kit):** work proceeds as specify → clarify (optional) → plan → tasks →
  implement → converge. Every spec/plan MUST pass a Constitution Check against this document
  before implementation starts; every task list MUST name the concrete verification suite(s) that
  prove completion.
- **Bug fixing:** reproduce or pin the discrepancy first, locate the authoritative behavior in the
  decomp/original Lua (Principle II), fix in the engine layer only (Principle I), then verify with
  the matching suite. One verified fix per commit; commit messages in English state what and why.
- **Debugging entry point:** errors in Lua threads are only logged — search WARN lines for
  `ForkThread-Fehler:` first.
- **Scripts:** every script importing `src/lua/*` or `src/sim/*` runs with
  `--import ./scripts/register-lua.mjs`.

## Governance

This constitution mirrors the invariants of `CLAUDE.md`; on conflict, `CLAUDE.md` wins and this
document MUST be amended to match. Amendments require: an explicit diff of the changed principle,
a semver bump (MAJOR = principle removal/redefinition, MINOR = new principle or materially
expanded guidance, PATCH = clarification), and a sync of `CLAUDE.md` where applicable. All
specs, plans, and reviews MUST verify compliance with Principles I–V; violations are findings that
block implementation, not style notes. Complexity beyond what the original engine requires MUST
be justified in the plan's Complexity Tracking section.

### Rejected amendments

Recorded so they are not re-proposed as improvements:

- **"Allow compatibility shims as explicitly listed, temporary, audited exceptions"** (proposed
  2026-08-24). Rejected: it converts Principle III from a bright line into a process gate whose
  criteria ("temporary", "audited") are not testable, while "fails loudly on call" is testable in
  one line. The repo's own coverage audit was silently broken for months, so an "audited" gate
  would have admitted ~148 no-op bindings unnoticed. The correct direction is the opposite —
  keep the absolute rule and make the exception mechanism itself loud.
- **"Replace the global source hierarchy with a question-type-dependent one that ranks faf-re
  above community/web for gameplay questions"** (proposed 2026-08-24). Rejected: the hierarchy in
  Principle II is already scoped to "how does the engine do this?" questions, and the proposal
  would promote a source known to be actively wrong in places into a regular rank. The genuine
  part of the criticism — that rank 3 sat in tension with "every value comes from a blueprint, the
  original Lua, or the Decomp" — is adopted above instead.

**Version**: 1.1.0 | **Ratified**: 2026-08-24 | **Last Amended**: 2026-08-24
