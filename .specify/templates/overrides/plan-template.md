# Implementation Plan: [FEATURE]

**Feature**: `[###-feature-name]` | **Date**: [DATE] | **Spec**: [link]

**Input**: Feature specification from `/specs/[###-feature-name]/spec.md`

**Note**: Filled in by `/speckit-plan`. This is the project-local override of the
core plan template — it encodes the invariants of `CLAUDE.md` and
`.specify/memory/constitution.md`. Do not replace it with the generic template.

## Summary

[Primary requirement + technical approach. Name the engine subsystem(s) touched.]

## Technical Context

**Layer**: [engine TS (`src/**`) | engine Lua (`src/engine-lua/*.lua`) | loader/bridge | docs]

**Original behavior lives in**: [`lua/sim/...`, `lua/ui/...`, blueprint field, or a `Moho::` symbol]

**Sim VM / UI VM**: [which VM owns the bindings involved — see `docs/research/engine-api.md`]

**Verification**: [the concrete checks: `scripts/verify-<x>.ts`, `npm test`,
`?sandbox=<map>&selftest=<blueprint>`. "Manual inspection" is not verification.]

**Assets required**: [maps/blueprints/SCDs the checks need, or N/A]

**Constraints**: [tick budget, 10 Hz sim beat, lockstep determinism, memory, or N/A]

## Evidence Base

*GATE: no plan without primary-source evidence. Fill before Phase 0 completes.*

| Claim about original behavior | Source (rank 1-3) | Reference |
|---|---|---|
| [what the original engine does] | 1 = IDA decomp | `Cfile/ForgedAlliance.exe.c:[line]` (`Moho::[symbol]` @0x[addr]) |
| [what the original Lua does] | 2 = original Lua/blueprint | `[vfs path]:[line]` via `peek-lua.ts` |
| [only if 1 and 2 are silent] | 3 = faf-re/community | [url] — **must** be cross-checked against the decomp |

**Unresolved**: [every `NEEDS CLARIFICATION` / unfound behavior. An unresolved
row blocks the affected task, it does not license a guess.]

## Constitution Check

*GATE: must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Gate | Verdict | Notes |
|---|---|---|---|
| I | **No game logic in TS.** Nothing in this plan recreates `lua/sim/**` or `lua/ui/**` behavior in TS/HTML; the engine only calculates, renders, and hosts Lua. No web UI substitutes for an original panel. | PASS / FAIL | |
| II | **Every value is sourced.** No invented constants, curves, or thresholds — each traces to a blueprint, the original Lua, or the decomp (see Evidence Base). | PASS / FAIL | |
| III | **Fails loudly.** No stub, no placeholder return, no swallowed error on the production path. (Sanctioned exceptions: `moho.<x>` auto-vivify, `__getBrain`.) | PASS / FAIL | |
| IV | **One boot path, two VMs.** Uses `installEngine()` / `installUiEngine()` + `setupGameUi()`; no hand-assembled engine; no binding registered into the wrong VM. | PASS / FAIL | |
| V | **Runnable verification.** Every task names a check that can actually be executed and that fails today if the behavior is wrong. | PASS / FAIL | |

A `FAIL` blocks implementation. Justify only in Complexity Tracking, never by
weakening the gate.

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit-plan)
├── research.md          # Phase 0: decomp/Lua findings with line references
├── data-model.md        # Phase 1: structs, blueprint fields, message shapes (if any)
├── quickstart.md        # Phase 1: how to run the verification for this feature
├── contracts/           # Phase 1: engine binding signatures / sync payload shapes (if any)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── engine-lua/          # what the C++ engine puts into the Lua states (standard Lua 5.4)
├── lua/                 # loaders + bridges only: engine.ts, uiEngine.ts, host.ts, transpile.ts, ...
├── sim/                 # Sim calculations + worker (10 Hz beat)
├── ui/                  # UI VM host, maui renderer, world commands
├── effects/ anim/ formats/ vfs/ types/ viewer/ sandbox/
scripts/                 # verify-*.ts suites + peek-lua.ts (run with --import ./scripts/register-lua.mjs)
docs/research/           # distilled evidence per subsystem
```

**Structure Decision**: [Which of these directories this feature touches, and why
the logic belongs in that layer rather than one above it.]

## Complexity Tracking

> **Fill ONLY if the Constitution Check has violations that must be justified.**

| Violation | Why the original engine forces it | Simpler alternative rejected because |
|---|---|---|
| [gate # and what it breaks] | [evidence reference] | [why it does not reproduce the original] |
