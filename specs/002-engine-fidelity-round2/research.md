# Research — audit round 2

**Method**: six finders, one per subsystem round 1 did not cover
(session/sync, unit lifecycle, intel/vision, binary formats, renderer/animation,
audio). Each was given `docs/STATUS.md` "Known gaps" and the whole of spec 001
(including its 19-item backlog) as exclusion lists, plus `git log -20`. Every
candidate then went through an adversarial verifier whose default verdict was
REFUTED and which had to re-read the cited decomp lines itself.

**25 candidates → 17 confirmed, 8 refuted.**

## Refuted — recorded so they are not re-found

| Finding | Why refuted |
| --- | --- |
| `PauseSound`/`PauseVoice` are inert placeholders (`ui-globals.lua:1802`) | Real in the code, but unreachable in this build — nothing can call them. Same rule as round 1's inert findings. |
| World sounds ignore the listener: no LOS and no `LodCutoff` gate (`moho.lua`) | Refuted on the engine side. |
| `SetAlliance`/`IsAlly` reject army NAMES the engine accepts (`globals.lua:359`) | Criteria 1-3 hold, observability fails — no caller passes a name in this build. |
| Intel-type names matched case-sensitively, never validated (`moho.lua:90`) | Criteria 1-3 hold, observability fails. |
| `__startBuildSite` swallows errors from `OnStartBeingBuilt` (`units.lua:613`) | Our code does swallow, but the claimed original behaviour and the observability argument do not carry it. |
| `OnStartBeingBuilt` gets the order name where the engine passes the layer (`units.lua:613`) | Two of its three claims are factually wrong about the engine; the third is unobservable. |
| Poly-trail `RepeatTexture` V mapping (`viewer/trails.ts:66`) | The finding reads the shader right but misidentifies what feeds it; its central claim about the original is false. |
| SCM parser rejects versions other than 5 (`formats/scm.ts:92`) | The engine really has no version check, but the finding's own observability argument is wrong — every retail SCM is version 5. |

## Corrections the verifiers made to their finders

Worth keeping, because they show where a plausible-looking citation was wrong:

- **One-shot sound de-dup**: the finder blamed the wrong cause; the verifier
  measured it and replaced the diagnosis while keeping the finding.
- **Camera max zoom**: the headline "invented 1.4" is wrong — 1.4 *is* the
  engine's `CameraImpl` ctor value (Cfile:1149693). What is invented is applying
  it over the full heightfield instead of the engine's formula
  (Cfile:1149241-1149290). The fix keeps the 1.4 as a named default and replaces
  the shape around it.
- **Session reset use-after-close**: two quantitative claims in the finding were
  wrong and were corrected; the verifier also confirmed experimentally that an
  eval after `close()` is a hard WASM trap, not silent nonsense.
- **`mesh.fx time`**: the finder's citation chain had a hole the verifier had to
  close itself before confirming.

## Self-review of the round-1 + round-2 diff (2026-08-25)

Three independent reviewers were run over the uncommitted diff — one on evidence
integrity, one on "can these new checks ever fail?", one on correctness and
regression risk. The evidence lens hit the session limit before returning; the
other two completed and **found real defects introduced by the fixes
themselves**. All of the following were corrected before the gate:

| What | Severity |
| --- | --- |
| **`damagePoint` still consulted the target's OWN dome on the area path.** `collectAbsorption` walks `activeShieldList()`, which contains every unit's own shield, so the caller had already subtracted it — the second consult swallowed the remainder the engine explicitly passes to the entity (Cfile:1063263-1063264) and charged the dome twice. A shielded unit took **zero** damage from splash that exceeded its shield. `fromArea` now skips the whole shield block. | high |
| **Water won unconditionally over terrain in projectile collision.** Testing the water plane first is right over open water, but on a coast or island (ground above the water level) every descending shot reported `Water` — the mirror image of the bug being fixed. Now the higher surface wins, which on a descending path is the one reached first. | high |
| **`SetSpeedThroughGoal(0)` in the dead-unit order branch was an invented action** — the engine simply does not dispatch a dead unit (Cfile:746583-746586); it takes no such step. Removed (Principle II). | medium |
| **`verify-build`'s "fraction is never below health/maxHealth" was vacuous AND asserted a non-invariant.** It passed under both old and new code, and `Materialize` (Cfile:953458-953468) actually ends an over-healed tick with `health/maxH > fraction`. Replaced with a check that drives the positive-delta branch. | medium |
| **The decay half of US6 had no check that could fail** — a revert to the assign form would have left all 53 suites green. Now covered (and the suite's local `beat()` does not run `__decayTick()`, which is why it looked covered). | medium |
| **The water bridge itself was untested.** Both water checks called `__setWaterLevel` directly; the `setTerrainSource → __setWaterLevel` line — the actual gap the spec describes — was executed by nothing. Now covered. | medium |
| **`AcquireKeyboardFocus`'s rewritten semantics had no check**, and the round-1 tasks claimed a suite (`verify-maui-control-state.ts`) that was never touched. Now covered in `verify-maui.ts` with callback counters. | medium |
| **`__getBrain`'s hardening had no check either way.** Now covered: declared armies resolve, an undeclared index raises, and nothing is registered in `ArmyBrains` as a side effect. | medium |
| **Round-2 T016/T017 were marked done with no check at all.** Now covered in `verify-toggle-pause.ts`. | medium |
| **Three "*Verified by*" lines named suites that were never extended** (T010 splash-damage, T031 combo/orders, T034 maui-control-state) — corrected to what is actually proven, with the un-proven part named. | low |
| **`spec.md` US11 and tasks T032/T033 stated the two maui focus callbacks INVERTED** relative to the decomp and the (correct) implementation. A later reader following the spec would have "fixed" working code into a regression. Corrected, with the vtable offsets in a table. | low |
| **Published coverage figures were already stale** (659/148 → 660/147). Refreshed — and then found wrong AGAIN: the class map scored 238 methods from 32 classes blind, so even 660/147/342 was false. Final measured figure after completing the map: **698/147/304 = 61 %**. Three wrong numbers in a row from the same instrument is the argument for gating it in `npm test`. | low |

The lesson worth keeping: **every one of the high-severity findings was in code
the 53 suites passed on.** Adversarial review of one's own diff is not
ceremony here — two of these were real gameplay regressions shipped behind a
green gate.

Still open from that review, recorded rather than silently dropped:

- `scripts/coverage-engine.ts` is not run by `npm test` (`run-tests.ts` only
  globs `verify*.ts`) and exits 0 regardless of what it parsed — the exact
  defect it fixed could return unnoticed. SC-004 of spec 001 is therefore
  closed on inspection. A `verify-coverage.ts` asserting hard floors (classes
  parsed > 0, NO-OP > 0) would close it properly.
- `verify-ui-panels`' "not bound to `hit`" check does not assert that a control
  was actually hit at that point, and nothing observes that the hook runs
  BEFORE the control's `HandleEvent` (Cfile:1147549 vs 1147582).
- Two of the four `GetResourceConsumed` checks are positive controls, not
  regression checks — they passed before the fix too (the old binding returned
  `... or 1`). The falsifiable ones are the stall rate and the idle 0.

## Cross-round note

`src/viewer/skyDome.ts:253-255` already feeds the shader the tick-based value.
That makes US3 a *consistency* bug as much as a fidelity one: one call site had
it right and the others did not, and nothing compared them. Worth a check that
asserts all shader `time` feeds share one helper.
