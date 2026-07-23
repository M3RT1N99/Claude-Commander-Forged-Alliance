# Master Plan: Complete reconstruction of Supreme Commander FA

Goal: **the complete game 1:1 in the browser** — every unit, weapon, factory,
AI, map, campaign, multiplayer mode, and mod. Original behavior, values, and
look; only the architecture is new (TypeScript/WebGL instead of C++/DirectX9).

Basis: in-depth research into the reconstructed engine (faf-re), the original
Lua layer, and the game data (2026-07-13, 10 parallel analyses + independent
measurements). **Every number here is substantiated** — assumptions are marked
as such.

---

## 1. Finding: where is the game?

The Moho engine is a framework; most game logic lives in **Lua**. Measured:

| Layer | Scope | Contents |
| --- | --- | --- |
| Engine C++ (faf-re) | ~600,000 lines | sim 169k, unit 89k, ai 85k, render 44k, entity 44k, resource 33k, audio 27k, net 27k, particles 20k, effects 12k, script 11k, task 8k, terrain 8k, projectile 6k, collision 5k, command 5k, path 4k, vision 1k |
| Gameplay Lua | **183,202 LOC** | AI 83,723 · UI+MAUI 46,255 · Sim core 28,658 · Unit scripts 13,473 · Projectiles/effects/props 6,309 · Campaign framework 4,784 (+28,718 LOC map scripts) |
| Effect blueprints | **2724** (effects.scd) | 2437 emitters · 184 trails · 103 beams |
| Engine↔Lua API | **~490 methods + ~410 globals + 183 callbacks**; **Sim only: 339 + 204 ≈ 543 bindings** | 36 base classes `moho.*_methods`, ~15 of them Sim-relevant |

**Consequence:** manually translating gameplay Lua to TypeScript would mean
rewriting 183k lines of original game logic — never exactly. Mods and campaigns
would remain impossible (mods monkey-patch Lua and execute **third-party Lua
code**).

---

## 2. Architecture decision: execute original Lua

> **We execute the original Lua scripts in an embedded VM and implement the
> engine API (`moho.*`) in TypeScript.**

### 2.1 Which VM? (empirically settled)

FA uses **Lua 5.0.1 (PUC-Rio) with a GPG-patched lexer** (version string in
`bin/main.exe`; the engine binds LuaPlus 5.0 build 1081).

**Independent measurements:**

| Test | Result | Consequence |
| --- | --- | --- |
| Transpiler + Lua 5.4 (wasmoon): **all 1316 original scripts parse** (`scripts/verify-lua.ts`) | ✅ Syntax can be handled | Transpiler works |
| `tostring(10/2)` in 5.4 | `"5.0"` (original: `"5"`) | ❌ Integer subtype corrupts strings/IDs |
| `math.type(3)` in 5.4 | `integer` | ❌ 5.0 knows only doubles |
| `arg` table in a vararg function (5.4) | `nil` (106 occurrences in the game) | ❌ fails at runtime |

→ **Syntax ≠ semantics.** wasmoon/5.4 is suitable for prototyping, not for 1:1.

**Two-track strategy:**

- **Track A (target, Fidelity):** **build Lua 5.0.1 with the GPG lexer patches
  ourselves for WASM** (Emscripten). The patches are known and reconstructed
  from the data: `#` comment, `!=`, `!`, `continue`, LuaPlus table size hints
  `{&1&4}`. Result: **no transpiler required, exact 5.0 semantics** (no
  integers, `arg`, `table.getn`, `for k,v in t`).
- **Track B (bridge, usable now):** the existing lexer transpiler
  ([src/lua/transpile.ts](../src/lua/transpile.ts)) + wasmoon + compatibility
  shims — to develop the `moho` API and boot path *now*. Known deviations are
  documented; it will be replaced by Track A.

**Determinism benefit of embedding:** every client executes the same VM build
→ identical table-iteration order. A TS reimplementation would need to
artificially reproduce that order or lockstep would drift.

### 2.2 What remains TypeScript?

The engine side: tick loop, movement/pathfinding, collision, intel grids,
economy, renderer, network. Lua receives the 543 Sim bindings + callbacks.

---

## 3. System specifications (researched, for implementation)

### 3.1 Sim core
- **Fixed tick rate: 10 Hz** (`GetSimTicksPerSecond` always pushes 10.0).
- **Beat ≠ tick**: beats always run (network, checksum); ticks run only when
  not paused/GameOver.
- **Tick order** (`Sim::AdvanceBeat`): clear resource accumulators → per army
  `OnTick` (eco cache, stats, navigator/steering stages) → **TaskStageA
  (command dispatch + all unit tasks)** → TaskStageB → blips → recon → effects
  → formations → kill cleanup → transform commit → checksum.
- **Commands never run directly**: a persistent task reads the queue head and
  pushes a `CCommandTask` onto the task stack. Return values control scheduling
  (−1 = complete, 0 = immediately again, N = wait N−1 ticks).
- **Economy = request/grant**: a consumer adds `CEconRequest` (demand per tick)
  to the army list; the engine writes `mGranted`; construction/repair use the
  ratio (stall = slowdown), while Capture/Teleport wait for full coverage.
  - Construction: `time = BuildTime / buildRate`; `energy_rate = BuildCostEnergy/time`;
    progress/tick = `(buildRate / BuildTime) * 0.1 * ResourceConsumed`.
  - **Assist is additive**: effective rate = Σ buildRate of helpers.
  - **Distribution now from the binary** (`func_ArmyProcessEconomy` @ 0x771B50,
    a stub in faf-re) → [research/economy-binary.md](research/economy-binary.md):
    **two-stage** — consumers needing *both* resources run with ratio
    `r1 = min(1, min available/totalDemand)`; consumers needing *only one*
    receive their own ratio `r2` from the remaining non-bottleneck resource.
    `mGranted` is per consumer; `LimitingRate = granted/requested` scales
    progress *per structure*. The current one-factor stall is too simple.
  - **Command→task dispatch** (`DispatchTask` @ 0x608EF0) → 40 command types
    ([research/command-dispatch-binary.md](research/command-dispatch-binary.md)).
  - **Construction-task flow** complete
    ([research/build-task-binary.md](research/build-task-binary.md)):
    `delta = (buildRate/BuildTime) * resourceConsumed * 0.1`, HP grows linearly
    with progress, completion → `OnStopBeingBuilt` (Lua) + adjacency scan;
    `resourceConsumed` = `LimitingRate` from economy distribution (both systems
    interact).
  - Reclaim: `Ticks = max(BuildCostEnergy, BuildCostMass) / buildRate`.
  - Capture: `Ticks = max(1, ((BuildTime/buildRate)/2 * CaptureTimeMultiplier) * 10)`,
    progress += number of captors.
  - **Veterancy is kill-based** (default thresholds 25/100/250/500/1000):
    MaxHealth ×1.1…×1.5 (REPLACE from bp base), regen +2…+10.
- **Decomp gaps (honestly):** the economy-distribution routine, the large
  `DispatchQueuedCommand` switch, and the build-task state machines are **not**
  reconstructed → derive them from Lua + callers and **verify** them.

### 3.2 Weapons (shared between engine + Lua)
- Core Lua is in **mohodata.scd** (`sim/weapon.lua`, `sim/defaultweapons.lua`,
  `sim/DefaultDamage.lua`, `sim/CollisionBeam.lua`, `sim/DefaultProjectiles.lua`).
- **Fire cadence is engine-side and tick-quantized**:
  `fireClock = (int)(10 / RateOfFire)` → RateOfFire 3 ⇒ 3 ticks = 0.30 s
  (effective 3.33/s), **not** 0.333 s.
- The engine calls only `weapon:OnFire()`; the **salvo state machine** (Idle →
  RackSalvoCharge → FireReady → Firing → Reload, + Pack/Unpack) lives in Lua.
- **Range is purely 2D (XZ)** against MaxRadius²/MinRadius², with separate
  `|Δy| ≤ MaxHeightDiff` and HeadingArc checks.
- `TrackingRadius` is a **multiplier** of MaxRadius.
- Turrets: `TurretYaw/PitchSpeed` [°/s] → `slew = speed * DEG2RAD * 0.1` per
  tick; `FiringTolerance` [°] per axis.
- Projectiles: gravity **(0, −4.9, 0)**; defaults UseGravity=1, Lifetime=15,
  LeadTarget=1, TrackTarget=0; `MuzzleVelocity` overrides InitialSpeed (with
  Gaussian jitter + short-range attenuation).
- **Damage — now reconstructed directly from the binary** (IDA; `SIM_Damage`
  is only a stub in faf-re) → [research/damage-binary.md](research/damage-binary.md):
  - **No distance falloff** (proven): full amount to every entity in the radius.
  - Formula: `effektiv = amount * ArmorMult(damageType) / (1 + Handicap)`
    — **division**, not `*(1-Handicap)` as previously assumed.
  - Category **`NOSPLASHDAMAGE`** is immune to area damage.
  - Shield absorption is deducted **before** individual damage.
  - Self-damage: the projectile is resolved onto its launcher.
  - Health loss/death happens in **Lua** (`Unit.lua:OnDamage`), not in the engine.
- Overkill: `overkillRatio > 1` ⇒ **no wreck**; wreck mass =
  `BuildCostMass * Wreckage.MassMult * (1-overkill) * FractionComplete`.
- Shields: absorption = `min(shieldHP, amount*ArmorMult*(1-Handicap))`,
  overspill via `PassOverkillDamage`; regen starts after `ShieldRegenStartTime`,
  and every hit resets it.
- Beams: no projectile; `CollisionCheckInterval = BeamCollisionDelay * 10` ticks.
- **Gap:** `SIM_Damage` is a stub in the Decomp → verify damage application
  from Lua + blueprint calculation.

### 3.3 Movement, paths, collision
- Units: `MaxSpeed*0.1` = m/tick; `MaxAcceleration*0.01` = m/tick²;
  `TurnRate [°/s] * 0.0017453` = rad/tick.
- **Passability grid**: 1 cell = 1 world meter (= heightmap grid); bitmask
  `{LAND=1, SEABED=2, SUB=4, WATER=8, AIR=16, ORBIT=32}` from footprint
  (MaxSlope, Min/MaxWaterDepth, Size) + heightmap + TerrainType + structure
  occupancy.
- **Slope is not an angle**: maximum absolute height difference between
  adjacent samples > `MaxSlope` (default **0.75**) ⇒ impassable.
- Footprints are global in `mohodata.scd:lua/footprints.lua` (20 entries).
- **Pathfinding**: hierarchical A* (clusters 1/8/32/128), one ClusterMap per
  footprint type, incremental updates with a frame budget; A* runs in one army
  queue; heuristic = Octile × 1.01.
- **Repath** when: target distance > threshold, layer change, or 30 ticks
  without position change; 3 failures ⇒ escalation.
- **Avoidance is prediction-based** (not boids): neighbors within radius,
  spline forward simulation every 3 ticks, 2D OBB-overlap test. **No physical
  pushing** — only occupancy + reservation + steering.
- Layer height: land = terrain (SnapToGround averages 4 footprint corners),
  water = water level, sub = level + (negative) elevation, air = + elevation.
- Ships: no true draft (footprint MinWaterDepth); curve radius limits speed;
  bots (RotateOnSpot) begin moving only once heading alignment > 0.98.
- Air: **no pathfinding** (direct to target), damping + bank/lift factors.
- Formations: `lua/formations.lua` (offsets per category/row), slots snap to
  free cells, formation speed is regulated.

### 3.4 Intel (radar/sonar/omni/vision)
- **Grids**: vision 2 m/cell; all others (Water, Radar, Sonar, Omni,
  Counter-Intel) 4 m/cell.
- `CIntelGrid` is an **int8 counter** (AddCircle +1 / SubtractCircle −1);
  visible = cell ≠ 0. Radius→cells uses **integer division**.
- The vision grid exists only when FoW=on; without FoW everything is visible.
- Update a handle only when movement ≥ `radius*0.333` **or** it is > 30 ticks old.
- Recon scheduling: **one army per tick** (`tick % armyCount`).
- Flags: Radar/Sonar/Omni/LOSNow/LOSEver/KnownFake/MaybeDead;
  **LOSEver + KnownFake are sticky**.
- **Ghost buildings**: no-longer-seen *stationary* units with LOSEver remain as
  frozen blips (last known state).
- **Jammer**: `Intel.JammerBlips` are fake blips with a random offset in
  `JamRadius`; exposed by Omni/LOS/loss of source.
- Client FoW: two grids per army — *Explored* (ever seen) and *Fog*
  (currently visible).

### 3.5 Effects & audio
- Emitter blueprints are a **Lua DSL** (`EmitterBlueprint{…}`), with 21 curves
  per emitter; **curve evaluation**: linearly interpolate y **and** z, then
  `(rand()-0.5)*z + y` (z = spread width). Time unit = Sim ticks.
- **Particle physics is in the vertex shader** (`effects/particle.fx`):
  without drag `pos = P0 + V·t + 0.5·A·t²`; with drag, exponential. Color =
  particle texture × ramp (U = t/lifetime).
- BlendModes: 0=Alpha, 3=Add (most common), … ; 747 particle textures.
- Trails = ribbons; beams have their own blueprints.
- Effect templates: `lua/EffectTemplates.lua` (~586 tables).
- **Audio = XACT**: `.xwb` (WBND) + `.xsb` (SDBK) — header verified.

### 3.6 Rendering (open features)
- **SCMAP tail now fully decoded** (verified through EOF for 60/60 maps):
  Foam/Flatness/DepthBias masks, TerrainType, (v60) Skybox, and the **props
  list** follow WaterMap (up to **46,971 props/map** ⇒ instancing is mandatory).
- **39 of 60 maps use `TTerrain`** (only 4 strata, a different lighting
  formula) — all are currently rendered as TTerrainXP. Must branch by
  `terrainShader`.
- The original terrain normal comes from a **deferred buffer** (the base pass
  writes geometry and stratum normals; `frame.fx` builds the TBN).
- Water: Fresnel = procedural 128×128 lookup
  (`d·bias + (1−d·bias)(1−NdotV)^power`); WaterMap channels:
  **R=Flatness, G=depth, B=alpha mask, A=1−Foam**.
- Skycube DDS = real cubemaps (DXT1 512², 6 faces, no mips).
- Decals: type enum (1=Albedo, 2=Normals, …); matrix =
  translate(−pos)·Ry·Rx·Rz·scale(1/s).
- LOD selection: first LOD with `cutoff ≤ 0` **or** `distance ≤ cutoff`.
- Legacy shader aliases: `TMeshAlpha→NormalMappedAlpha`, `TMeshGlow→…`,
  `Team→Unit` (props use the old names).

### 3.7 UI (original structure)
- **The container model is entirely missing**: `gamemain.lua:CreateUI()` builds
  four containers through `borders.SetupBorderControl` —
  `controlClusterGroup` (lower 150 px band), `statusClusterGroup` (upper band),
  `mapGroup`, `windowGroup`. Every panel attaches to them. **Prerequisite for
  original-accurate positions.**
- **Build menu** (`construction.lua`, 79 KB) is the largest missing element:
  3 main tabs, 5 sub-tabs, a 50 px icon grid, build queue, Infinite/Pause.
- Orders: the original has **12 slots** (we have 6) + 9 toggle caps.
- Cursors, command feedback (blips/orderlines/rally), and hotkeys
  (`keymap/defaultKeyMap.lua`) are completely data-driven.

### 3.8 Network, replay, save
- **Lockstep transfers commands only**: 24 opcodes; wire format
  `[u8 type][u16 size][payload]`; **no host relay** (broadcast to all, full-mesh
  P2P).
- Desync detection: MD5 over economy + dirty entities + the **complete
  MT19937 RNG state** per beat; 128-beat ring.
- **Replay = recorded wire stream** (feed bytes back in 1:1).
- Session start through `SWldSessionInfo` (map, LaunchInfo, RNG seed) —
  identical for MP, SP, replay, and load.

### 3.9 Game shell
- Skirmish = **single-player hosting** through the same lobby (protocol “None”).
- Sim init: `__blueprints` → `simInit.lua` → `ScenarioInfo` → `SetupSession()`
  (loads `_save.lua` + `_script.lua`) → armies/Brains → `BeginSession()`
  (`OnPopulate`/`OnStart`).
- The map script for skirmish is **minimal**; army/ACU creation is in
  `mohodata:lua/sim/ScenarioUtilities.lua`.
- **Victory**: `lua/victory.lua` — demoralization (=Assassination, default),
  domination, eradication, sandbox; poll every 3 s, 15 s stable state.
- Options/prefs/keybindings: all Lua tables (`Game.prefs`).

---

## 4. Phase plan

Every phase ends with: type check, `verify*.ts` against original data,
behavior/screenshot test, commit.

### Phase A — Lua foundation ✅ milestone achieved
1. ✅ **FA Lua transpiler** — 1316/1316 scripts parse (`scripts/verify-lua.ts`).
   Dialect features resolved: `#` comment, `!=`, `continue`→goto,
   `arg` vararg→`table.pack`, generic-for→`__foriter` dispatcher,
   number-before-keyword (`0then`), `{&1&4}`, BOM, invalid escapes.
2. ✅ **A1** Host boots `import.lua` + `class.lua` (`verify-luaboot.ts`).
3. ✅ **A2** Original `LoadBlueprints()` pipeline loads real blueprints
   (`verify-blueprints.ts`).
4. ✅ **A3** Real `Unit.lua` (142 KB) + `defaultunits.lua` (33 classes) load
   with the complete import cascade (`verify-units.ts`).
5. ✅ **A4 milestone**: a unit is instantiated through original `Unit.lua`,
   `OnCreate` runs, and original blueprint values are read
   (`verify-unit-create.ts`). moho API v1 (105 Unit + 72 Entity methods).
6. **Open — Track A**: Lua 5.0.1 + GPG patches to WASM (exact semantics,
   replaces transpiler); progressively replace moho stubs with real Sim binding.

### Phase B — Combat
5. Weapons API + `defaultweapons.lua` state machine, fire clock
   (tick-quantized), aiming/slew, target acquisition.
6. Projectiles (ballistic/guided/beam), collision, `Damage`/`DamageArea`/
   `DamageRing` (no falloff!), armor multipliers, overkill/wrecks.
7. Shields (absorption/regen/overspill).
8. **Milestone**: DPS/ranges match the blueprint calculation.

### Phase C — Construction
9. Task/command system (queue semantics including Patrol rotation), engineering.
10. Passability grid + hierarchical A* + steering/avoidance + formations.
11. Factories, build queue, Assist (additive), Reclaim, Repair, Capture,
    upgrades; **UI**: container model + build menu + build placement + command
    feedback.
12. **Milestone**: complete ACU → T2 construction is playable.

### Phase D — World & Intel
13. Intel grids (counter semantics!), blips, ghosts, jammer, FoW (Sim + render).
14. Props (instancing), decals, TTerrain variant, complete water (Fresnel LUT,
    cubemap), particle system (curves + particle.fx port), construction/wreck
    shader.
15. **Milestone**: map + effects look like the original.

### Phase E — Completeness
16. Air/navy (layer physics, transports, submarines).
17. Audio (XACT parser → WebAudio).
18. Remaining UI (score, avatars, chat, tabs, tooltips, cursors, hotkeys),
    lobby/menu, options, **victory conditions**, game end.

### Phase F — Opponents, network, campaign
19. **AI**: AiBrain/Platoon bindings (57+47 methods) → original AI Lua
    (83k LOC) runs.
20. Lockstep (deterministic trig!), command stream, MD5 checksums, replays.
21. Save/load, campaign (ScenarioFramework, Objectives, 6 FA missions).
22. **Milestone**: playable 1:1 — skirmish vs. AI, multiplayer, campaign, mods.

---

## 5. Cross-cutting
- **Determinism**: dedicated seeded PRNG (MT19937 as in the original), trig
  tables instead of `Math.sin`, no unsorted iteration; the “2 runs
  bit-identical” regression test remains mandatory.
- **Performance**: 1000-unit benchmark from Phase B (Lua callback overhead is
  the main risk); Sim in a Web Worker; instancing for props/units.
- **Verification**: `verify.ts` (data), `verify-lua.ts` (scripts), and later
  `verify-sim.ts` (blueprint calculation vs. Sim: DPS, build time, range).

## 6. Risks (honestly)
| Risk | Status / Mitigation |
| --- | --- |
| Lua semantics (5.4 ≠ 5.0) | **Confirmed by measurement** → Track A (own 5.0 build) |
| Lua performance with 1000+ units | open → early benchmark, hot paths in TS |
| Decomp gaps | **closed: all four reconstructed from the FAF binary through IDA MCP** — SIM_Damage ([damage-binary.md](research/damage-binary.md)), economy distribution ([economy-binary.md](research/economy-binary.md)), command dispatch ([command-dispatch-binary.md](research/command-dispatch-binary.md)), construction tasks ([build-task-binary.md](research/build-task-binary.md)). Obtain further details directly from the IDB as needed. |
| Props/particle volume (46k props, thousands of particles) | instancing + GPU particles (physics in the shader as in the original) |
| XACT audio format | parser required; reference: open-source XACT implementations |
| Legal | unchanged: no assets/code in the repo, BYO game ([LEGAL.md](LEGAL.md)) |
