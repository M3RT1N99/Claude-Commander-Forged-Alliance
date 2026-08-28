---
description: "Tasks — engine-fidelity fixes (audit round 2)"
---

# Tasks: Engine-fidelity fixes (audit round 2)

**Input**: [spec.md](spec.md), [research.md](research.md)

Every task names its evidence and the check that proves it (constitution
Principles II and V).

---

## Phase 1: P1 — visibly wrong

### US2 — a killed unit stops moving and stops taking orders ✅ DONE

- [x] T001 Dead-gate the drive in `src/engine-lua/motion.lua`: treat
      `__dead`/`__destroyQueued` like `Immobile` — speed 0, goal kept.
      `CUnitMotion::CalcMoveLand` (Cfile:971696-971704), `::CalcMoveWater`
      (Cfile:971825-971826) and `::CalcMoveHover` (Cfile:971533-971534) each
      open with `if (IsDead) { result = 0; }`.
- [x] T002 Skip a dead unit in `__ordersTick`
      (`src/engine-lua/globals.lua:1804`) without clearing its queue — dispatch
      runs only while `!IsDead` (Cfile:746583-746586), and `__destroyed` already
      does the cleanup.
- [x] T003 `scripts/verify-motion.ts`: a killed unit with a live goal does not
      move a millimetre over 10 beats, with a **living control** proving the
      same goal does move it. Separately — and through the real dispatch path
      (`__dispatchMove`, NOT `SetGoal`, which never populates
      `__orders`/`__orderActive`) — a killed unit's running command is neither
      advanced nor completed nor popped, and its queue length is unchanged.
      *Verified by*: `scripts/verify-motion.ts`.
      asserts: sie bewegt sich keinen Millimeter
      asserts: die Warteschlange bleibt unveraendert

### US1, US3, US4 — open

- [ ] T004 **US1** De-duplicate sim one-shot sounds per drain in
      `src/main.ts:2493-2503`, keyed `cueId | bankId<<16` like the engine's
      per-call vector (Cfile:1347280/1347398/1347407-1347413). Loops must keep
      bypassing it (Cfile:1347379).
      *Check to add*: a volley of N identical shots queues one Play.
- [ ] T005 **US3** Feed `mesh.fx time` / `material.x` SIM TICKS, not seconds:
      `fmod(sCurGameTick + sDeltaFrame, 36000)` (Cfile:1194896-1194904).
      `src/viewer/skyDome.ts:253-255` already does this — extract that into one
      shared helper and use it in `src/viewer/unitViewer.ts:233` and
      `src/viewer/mapProps.ts:327-329`.
      *Check to add*: all shader `time` feeds come from the one helper.
- [ ] T006 **US4** Replace the invented max-zoom shape in
      `src/viewer/unitViewer.ts:1103-1106` with the engine formula
      (Cfile:1149241-1149290) and move the 1.4 into `maxZoomMult` as the
      `CameraImpl` ctor default (Cfile:1149693), so `SetMaxZoom` can override it.

---

## Phase 2: P2

- [ ] T007 **US5** Thread `StopSound(immediate)` through
      `src/engine-lua/ui-globals.lua:1774-1793` (Cfile:1348263-1348288;
      `StopAllSounds` passes true, Cfile:1346492ff).
- [ ] T008 **US6 + US13 together** Gate `gameUi.beat` on a sim beat sequence
      instead of the render frame (`src/main.ts:2478-2484`, new `beatSeq` in
      `src/sim/luaSimClient.ts`), and make the worker post while paused with the
      tick frozen — the engine beats under pause
      (Cfile:1328786-1328790 gates only the tick advance).
- [ ] T009 **US7** Key sound banks by file base name and scan `sounds/`
      non-recursively, one engine per directory
      (Cfile:604127/604238→516077). `src/ui/audio.ts:106-118`.
- [x] T010 **US8** Gate production (Cfile:953968) and consumption
      (Cfile:953945) on a new `dead` flag in `src/sim/economy.ts`, set from
      `Entity::Kill` (Cfile:916084) through `__econSetDead`.
      The storage branch is left ungated and marked `UNVERIFIED` in place — the
      engine has it inside the same gate, but that branch was not traced far
      enough to change it on a guess.
      *Verified by*: `scripts/verify-econ-lua.ts` — a killed ACU's production
      drops to 0 in the same beat while it is still un-destroyed.
### US9 — script bits gated on the runtime toggle-cap mask ✅ DONE

- [x] T011 **US9** Gate `SetScriptBit`/`ToggleScriptBit` on the RUNTIME
      toggle-cap mask (never `TestToggleCaps` — enhancements add caps at
      runtime, `ual0001_script.lua:261`). `moho.lua:525`,
      `Moho::Unit::ToggleScriptBit` Cfile:951384-951441.
      The gate is the first thing the engine does:
      `if ((1 << bit) & GetAttributes1(this)->mToggleCaps)` (Cfile:951398).
      Not in the mask means nothing happens — no flip, no callback.
      `SetScriptBit` does no work itself; it converts the cap string to an index
      and delegates to ToggleScriptBit (Cfile:974910-974925), so the gate lives
      in one place here too. The numbering lines up: script bit 0 is
      RULEUTC_ShieldToggle is toggle-cap bit 0x1, through 8 (Cloak).
      NOT modelled, for lack of anything to check against: the engine also
      blocks while the unit is attached to something in category TRANSPORTATION
      (Cfile:951400-951424). We have no attachment state — `AttachTo` is one of
      the silent no-ops, and one of the NINE the game actually calls.
      check: scripts/verify-moho-sim-contracts.ts
      asserts: ohne Cap schaltet SetScriptBit NICHT
      asserts: TestToggleCaps prüft weiter das Blueprint
      Red probe: remove the gate -> the no-cap assertions go red.
### US10 — the intel "has" bit ✅ DONE

- [x] T012 **US10** Model the "has this intel type" bit that `InitIntel`
      creates (Cfile:1103903-1103913 / 1103745+); `EnableIntel`/`IsIntelEnabled`
      must answer against it. `moho.lua:77-107`.
      `CIntel::InitIntel` brings the type into existence — a grid for
      Radar/Sonar/Vision/Omni, or a "has" byte for the pure switches
      Jammer/Cloak/RadarStealth/SonarStealth (Cfile:1103907-1103908).
      `EnableIntel` therefore does NOTHING on an uninitialised type: it skips
      the write at Cfile:933447 (no byte) and Cfile:933452-933453 (no grid).
      `IsIntelEnabled` reads in the same order (Cfile:933356-933369).
      NOT modelled, and marked at the site: the engine throws
      "EnableIntel called before InitIntel" when the entity has no intel manager
      at all (Cfile:933353/933441) — whether every unit gets one is UNKNOWN, so
      inventing that exception would be worse than omitting it.
      check: scripts/verify-moho-sim-contracts.ts
      asserts: EnableIntel ohne InitIntel schaltet NICHT ein
      asserts: das Bit gilt je Typ
      Red probe: let EnableIntel create the slot again -> "InitIntel allein
      schaltet nichts ein" goes red (the leaked switch).
- [ ] T013 **US11** Ship `speed / MaxSpeed` from the sim and scale the walk
      animation with it (`CAnimationManipulator::MoveManipulator` Cfile:873406,
      ratio 873557-873559). `src/main.ts:2716`.
### US12 — DDPF_LUMINANCE ✅ DONE

- [x] T014 **US12** Decode `DDPF_LUMINANCE` (0x20000) as luminance replicated
      to RGB, leaving the `DDPF_ALPHA` path alone. `src/formats/dds.ts:122/155`.
      Counted over all 14,307 DDS in the archives: exactly ONE file has the
      flag — `textures/particles/beam_white_03.dds` (8-bit, pfFlags 0x20000,
      R mask 0xff, G/B/A = 0). Without the branch its brightness lands on RED
      alone, so a white beam renders red.
      The semantics are NOT in the decompilation ("luminance" does not appear —
      the engine hands the DDS to D3DX); they are Direct3D's D3DFMT_L8, i.e.
      source 3, and marked as such at the site. What grounds it is source 2:
      the one affected file is a WHITE beam.
      check: scripts/verify-dds.ts
      asserts: Pixel sind grau
      asserts: nicht einfach schwarz
      Red probe: turn the flag off -> 14,991 of 16,384 pixels go non-grey.

---

## Phase 3: P3

- [ ] T015 **US13** — see T008, they share the worker plumbing.
- [x] T016 **US14** Run `ResetSyncTable()` at the end of `beat()`
      (`src/lua/engine.ts`), mirroring `Sim::Sync`
      (Cfile:1074261, 1074772-1074773).
      *Verified by*: `scripts/verify-toggle-pause.ts` — a `Sync` write is
      readable inside the beat, gone at the start of the next, and the table
      itself survives the reset.
      ⚠ **Ordering constraint for whoever lands the Sim→UI sync bridge**: no TS
      code reads the Lua `Sync` table yet, so the reset currently discards
      whatever the sim Lua wrote. The reader must be inserted **before** this
      line in `beat()`, exactly as `Sim::Sync` serialises to the user layer
      before running `ResetSyncTable()` (Cfile:1074772-1074773).
- [x] T017 **US15** Drain the deletion queue until EMPTY, not one generation
      per beat (`while (mDeletionQueue._Mysize)`, Cfile:1076638-1076657), so a
      cascading destroy completes in the same beat.
      `src/engine-lua/damage.lua:405`.
      *Verified by*: `scripts/verify-toggle-pause.ts` — an entity destroyed
      from inside another's `OnDestroy` is fully destroyed in the same flush.
### US16 — GetTerrainType reads the map's type layer ✅ DONE

- [x] T018 **US16** Carry the parsed per-cell terrain-type layer into the sim
      (`src/formats/scmap.ts:130/411` → `setTerrainSource` → `__terrainTypeAt`)
      so `GetTerrainType` stops answering Default everywhere
      (`STIMap::GetTerrainType`, Cfile:1087694-1087707). The lookup is by TYPE
      CODE, not list position (terrainTypes.lua:8), and out of bounds is index
      1 — which is exactly the `TypeCode = 1` 'Default' entry
      (terrainTypes.lua:126-129), as the file's own doc promises for (-1,-1).
      check: scripts/verify-session-start.ts
      asserts: die Typ-Ebene wird wirklich gelesen
      Red probe: ignore the layer and answer code 1 -> both assertions red.

### US17 — open
- [ ] T019 **US17** Split the SCMAP `>= 60` gate into the engine's two:
      skybox from 58 (Cfile:1339158), cartographic decal-batch count from 59.
      `src/formats/scmap.ts:415/443`.
      **BLOCKED — not verifiable with the installed data, and deliberately not
      guessed.** Both gates are confirmed in the decompilation: `if (v108 >= 0x3A)`
      -> `Moho::SkyDome::Load` (Cfile:1339157-1339161) and, after it,
      `if (v53 >= 0x3B)` -> `Moho::Cartographic::ReadDecals`
      (Cfile:1339183-1339184), which reads a u32 count followed by that many
      `CartographicDecalBatch(version, reader)` (Cfile:1182437-1182453).
      But: **all 60 installed maps are versionMinor 60** (measured). No 58 or 59
      map exists here, so any change to the gate is unobservable on the corpus
      and unfalsifiable — exactly the guess this project forbids.
      Worse, there is an unresolved contradiction to settle first: the engine
      reads the cartographic decals AFTER the skybox, while
      `src/formats/scmap.ts:380` reads its decal-group block BEFORE it — and our
      parser nevertheless consumes every one of the 60 maps to the exact last
      byte (`scmap.ts:465` throws otherwise). Either the decompiled control flow
      is not the file order, or the two "decal" blocks are different things.
      **UNKNOWN.** Resolve that before touching the gate.
      check: none — the assertion cannot be made false with the data on this
      machine; a 58/59 map would be needed.

---

## Close-out

- [x] T020 Full gate after every landed change: `npx tsc --noEmit` and
      `npm test` green.
      check: none — this task IS the gate; `npm test` running green is its own
      evidence, there is nothing further to assert about it.
- [ ] T021 Update `docs/STATUS.md` and `docs/research/verified-facts.md` once
      the remaining stories land.
### T023 — the four `check-*.ts` scripts are gates ✅ DONE

- [x] T023 **The four `check-*.ts` scripts could not fail.** `check-unit-assets`,
      `check-watermap-holes`, `check-orientation`, `check-convention` had zero
      `check()` calls and zero `exit(1)` paths — they printed diagnostics. Each
      had once ESTABLISHED a convention the renderer has silently relied on ever
      since; nobody re-checked it. Each now asserts its own answer and exits
      non-zero, and `run-tests.ts` globs `check-*` alongside `verify*`.
      Wiring them in as-is was tried and reverted first: it raised the suite
      count from 53 to 58 while adding no gate at all.
      check: scripts/check-convention.ts, scripts/check-orientation.ts,
      scripts/check-unit-assets.ts, scripts/check-watermap-holes.ts
      asserts: die Messung unterscheidet wirklich
      asserts: die Annahme in scm.ts:24-26
      Red probes, each seen individually: rotation order swapped in `scm.ts` ->
      all 5 models red naming the cause; row reading mirrored -> all 40 maps red
      plus "0 maps discriminate"; `resolveUnitPaths` disabled -> 555 -> 496,
      ratchet red; DXT decoder green channel dimmed by 12 -> 36 -> 219 holes.

### Close-out (continued)

- [ ] T022 One commit per verified fix, English message: what and why.

## Notes

T004-T006 (US1/US3/US4) are P1 and still open — they are renderer/audio work
that needs its own checks; the sim-side P1 (US2) is done. Nothing in this list
may be closed on inspection.
