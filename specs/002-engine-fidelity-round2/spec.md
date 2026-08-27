# Feature Specification: Engine-fidelity fixes (audit round 2)

**Feature**: `002-engine-fidelity-round2` | **Date**: 2026-08-25
**Status**: in progress

## Why

Round 1 ([001](../001-engine-fidelity-fixes/spec.md)) covered economy, weapons,
damage, motion, projectiles, command dispatch, UI/maui and the VM core. Round 2
audited the six subsystems it did not touch: session lifecycle and sim↔UI sync,
unit lifecycle, intel/vision, binary formats, renderer/animation, and audio.

Six finders produced 25 candidates; each went through an adversarial verifier
whose default verdict was REFUTED. **17 confirmed, 8 refuted.**

## Scope

In scope: the 17 confirmed divergences below. Out of scope: the 8 refuted ones
(recorded in [research.md](research.md) so they are not re-found), everything in
`docs/STATUS.md` "Known gaps", and the AI subsystem.

## Success criteria

Same gates as round 1: every story closed by a check that fails before the fix;
`npx tsc --noEmit` and `npm test` green at every commit; every changed value
cites `Cfile:<line>` or `<lua path>:<line>`.

## User stories

### P1 — visibly wrong

- **US1 — One-shot sounds are de-duplicated per sync beat.**
  A volley of N identical shots plays N stacked copies. The engine keys each
  request `cueId | bankId<<16` into a per-call vector, scans it, and reaches
  `Play` only on a miss (Cfile:1347280/1347398/1347407-1347413); loops bypass it
  (Cfile:1347379). Ours: `src/main.ts:2493-2503`.

- **US2 — A killed unit stops moving and stops executing orders.**
  Ours keeps driving to its goal and working its order queue for the whole
  multi-beat death sequence. `CUnitMotion::CalcMoveLand` (Cfile:971701-971702),
  `::CalcMoveWater` (Cfile:971825-971826) and `::CalcMoveHover`
  (Cfile:971533-971534) all open with an `IsDead` early-out.
  Ours: `src/engine-lua/motion.lua:163`.

- **US3 — `mesh.fx time` counts SIM TICKS, not seconds.**
  We feed seconds into `time` / `material.x`; the engine sets it to
  `fmod(sCurGameTick + sDeltaFrame, 36000)` — ticks at 10 Hz
  (Cfile:1194896-1194904, fed from `Batch(..., sCurGameTick, sDeltaFrame)`).
  Everything time-driven in the shader therefore runs 10× too slow.
  `src/viewer/skyDome.ts:253-255` already does it correctly — the others do not.
  Ours: `src/viewer/unitViewer.ts:233`, `src/viewer/mapProps.ts:327-329`.

- **US4 — Camera max zoom uses the engine formula.**
  Ours applies an invented `* 1.4` over the full heightfield.
  `Moho::CameraImpl` ctor sets the multiplier to 1.4 (Cfile:1149693) and
  `worldview.lua:594` re-sets it to `gamemain.defaultZoom`; the zoom itself has
  its own formula (Cfile:1149241-1149290). Ours:
  `src/viewer/unitViewer.ts:861/1103-1106`.

### P2 — wrong in edge cases

- **US5 — `StopSound(immediate)`** — the flag is dropped, so every stop is a hard
  cut instead of the authored release/fade (Cfile:1348263-1348288;
  `StopAllSounds` passes true, Cfile:1346492ff).
  Ours: `src/engine-lua/ui-globals.lua:1774-1793`.
- **US6 — `gamemain.OnBeat` runs per rendered frame, not per sim beat.**
  The engine calls it once per consumed sync packet
  (`CWldSession::DoBeat` Cfile:1327644/1328538-1328540, drain loop
  Cfile:1328782-1328814; `gamemain.lua:436` says so in words). Ours runs it at
  ~60 Hz on data that changes at 10 Hz, so `commandmode.OnCommandModeBeat` ends
  command mode ~6× earlier than it should. Ours: `src/main.ts:2478-2484`.
  Note the paired half: the worker skips posting while paused, but the engine
  keeps beating under pause (Cfile:1328786-1328790 gates only the tick advance).
- **US7 — Sound banks are keyed by their internal SDBK name**, not the file base
  name, so the DE and US voice banks collide and one silently wins. The engine
  loads one engine per directory, non-recursively (Cfile:604127/604238→516077).
  Ours: `src/ui/audio.ts:106-118`.
- **US8 — Dead units keep producing and consuming** until `OnDestroy`.
  `HandleResourceManagement` gates BOTH halves on `IsDead`
  (Cfile:953945, 953968; `Kill` sets `mIsDead` at Cfile:916084).
  Ours: `src/sim/economy.ts:229`.
- **US9 — `SetScriptBit`/`ToggleScriptBit` skip the ToggleCaps gate**, so intel
  and stealth toggles fire on units that do not have them
  (`Moho::Unit::ToggleScriptBit`, Cfile:951384-951441). Must gate on the
  RUNTIME mask, not `TestToggleCaps` — enhancements add caps at runtime
  (`ual0001_script.lua:261`). Ours: `src/engine-lua/moho.lua:525`.
- **US10 — `EnableIntel`/`IsIntelEnabled` ignore whether the entity HAS that
  intel type.** `InitIntel` is what creates the capability
  (Cfile:1103903-1103913 for bool types, 1103745+ for positional).
  Ours: `src/engine-lua/moho.lua:77-107`.
- **US11 — Walk animation plays at a constant rate**; the engine scales it by
  `speed / MaxSpeed` (`CAnimationManipulator::MoveManipulator`, Cfile:873406,
  ratio at 873557-873559). Ours: `src/main.ts:2716`.
- **US12 — DDS `DDPF_LUMINANCE` (L8)** is decoded red-only instead of luminance
  replicated to RGB. Ours: `src/formats/dds.ts:122/155`.

### P3 — subtle

- **US13 — Session reset beats on a closed Lua host** (use-after-close): the
  references are dropped only after `await`, so `tickAndPost` beats through the
  window. The engine has no session to beat during a rebuild
  (Cfile:1328795-1328799). Ours: `src/sim/luaSimWorker.ts:312-330`.
- **US14 — The Sync table is never reset per beat.** `Sim::Sync` serializes it
  and then runs `ResetSyncTable()` (Cfile:1074261, 1074772-1074773).
  Ours: `src/lua/engine.ts:95`.
- **US15 — The deletion queue is drained one generation per beat**; the engine
  drains until empty (`while (mDeletionQueue._Mysize)`, Cfile:1076638-1076659).
  Ours: `src/engine-lua/damage.lua:406-408`.
- **US16 — The per-cell terrain-type layer never reaches the sim**, so
  `GetTerrainType` always answers the Default entry
  (`STIMap::GetTerrainType`, Cfile:1087694-1087707). The bytes are already
  parsed (`src/formats/scmap.ts:130/411`). Ours: `src/engine-lua/globals.lua:1163`.
- **US17 — SCMAP skybox gate is `>= 60`, the engine reads it from 58**
  (Cfile:1339158; `SkyDome::Load` takes no version, Cfile:1232684), and the
  cartographic decal-batch count is its own field from 59.
  Ours: `src/formats/scmap.ts:415/443`.

## Order of work

P1 first (US1-US4), then the cheap and self-contained P2/P3 items. US6 and US13
touch the same worker/beat plumbing and should land together.
