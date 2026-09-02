---
description: "Task list template — Claude Commander: Forged Alliance (project override)"
---

# Tasks: [FEATURE NAME]

**Input**: Design documents from `/specs/[###-feature-name]/`

**Prerequisites**: plan.md (required, incl. Evidence Base + Constitution Check),
spec.md (required for user stories), research.md

**Note**: Project-local override of the core tasks template. It encodes the
verification rule of `.specify/memory/constitution.md` (Principle V).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependencies)
- **[Story]**: which user story the task belongs to (US1, US2, ...)
- Every task names **exact file paths**.

## Project rules for every task (non-negotiable)

1. **Named check.** Every implementation task ends with the check that proves it:
   a `scripts/verify-<x>.ts` suite, `npm test`, or
   `?sandbox=<map>&selftest=<blueprint>`. A task without a runnable check is not
   a task — split it until one exists.
2. **Named evidence.** Every task that sets a value or reproduces behavior cites
   its source inline: `Cfile:<line>` or `<lua path>:<line>`. No citation, no task.
3. **Right layer.** Game logic is executed from the original Lua, never
   reimplemented in TS (Constitution I). If a task would put logic in TS, it is
   the wrong task.
4. **No stubs.** A partially implemented engine part fails loudly; it never
   returns a placeholder (Constitution III).
5. **Scripts** importing `src/lua/*` or `src/sim/*` run with
   `--import ./scripts/register-lua.mjs`.

## Path conventions

- Engine Lua: `src/engine-lua/*.lua` (standard Lua 5.4 — `#t` is length)
- VFS/original Lua: read-only reference via `npx tsx scripts/peek-lua.ts`
- Engine TS: `src/lua/` (loaders/bridges), `src/sim/`, `src/ui/`, `src/effects/`
- Checks: `scripts/verify-*.ts`

---

## Phase 1: Evidence (Blocking)

**Purpose**: pin the original behavior before touching code. No implementation
task may start while a row here is open.

- [ ] T001 [P] Locate [behavior] in the decomp — record `Cfile:<line>` and the
      `Moho::` symbol in `specs/[###]/research.md`
- [ ] T002 [P] Locate [behavior] in the original Lua/blueprint —
      `npx tsx scripts/peek-lua.ts --grep "<regex>"`, record `<path>:<line>`
- [ ] T003 Reconcile conflicts (decomp wins over Lua docs wins over faf-re) and
      close every `NEEDS CLARIFICATION` in plan.md's Evidence Base

**Checkpoint**: every value this feature needs has a source. Guesses are blocked.

---

## Phase 2: Failing check (Blocking)

**Purpose**: make the divergence observable before fixing it — a check that
fails today for the documented reason (Constitution V).

- [ ] T004 Add/extend `scripts/verify-<x>.ts` asserting the behavior from
      Phase 1 (cite the evidence in the check text, in English)
- [ ] T005 Run it and record the actual failure output in
      `specs/[###]/quickstart.md`

**Checkpoint**: red for the right reason. A check that passes before the fix
proves nothing.

---

## Phase 3: User Story 1 - [Title] (Priority: P1) 🎯

**Goal**: [what this story delivers, in engine-behavior terms]

**Independent verification**: [the exact command and the expected result]

### Implementation

- [ ] T006 [US1] [change] in `src/[path]` — evidence `Cfile:<line>` /
      `<lua path>:<line>`; verified by `npx tsx --import ./scripts/register-lua.mjs scripts/verify-<x>.ts`
- [ ] T007 [US1] [change] in `src/[path]` — evidence ...; verified by ...

**Checkpoint**: the Phase 2 check is green; `npx tsc --noEmit` and `npm test`
are green.

---

## Phase 4: User Story 2 - [Title] (Priority: P2)

**Goal**: [...]

**Independent verification**: [...]

### Implementation

- [ ] TXXX [US2] [change] in `src/[path]` — evidence ...; verified by ...

**Checkpoint**: [...]

---

[Add more user story phases as needed, same pattern]

---

## Phase N: Close-out

- [ ] TXXX Run the full gate: `npx tsc --noEmit` **and** `npm test` (all suites)
- [ ] TXXX Update `docs/STATUS.md` — move what is now done out of "Known gaps";
      add any gap this work newly exposed
- [ ] TXXX Record any newly established detail knowledge in
      `docs/research/verified-facts.md` (with evidence references)
- [ ] TXXX [P] Commit per verified fix, English message: what and why

---

## Dependencies & Execution Order

- **Phase 1 (Evidence)** blocks everything. No code before sources.
- **Phase 2 (Failing check)** blocks all implementation phases.
- **User stories (Phase 3+)** may run in parallel once Phase 2 is done, provided
  they touch different files.
- **Close-out** depends on all desired stories.

### Within a user story

- Engine binding/plumbing before the Lua that calls it
- Sim before UI when the UI consumes sync data
- One behavior per task — a task that changes two behaviors cannot be bisected

### Parallel opportunities

- All `[P]` evidence tasks (different research targets)
- Stories touching disjoint files
- Never `[P]` two tasks editing the same file

---

## Notes

- A failing suite after an honesty correction is a **finding**, not a regression —
  record it, do not paper over it.
- Debugging Lua threads: errors are only logged — search WARN lines for
  `Error running lua script:` first.
- All repository content is English (code, comments, checks, docs, commits).
- Avoid: vague tasks, tasks without a check, tasks without evidence, two tasks
  editing one file in parallel.
