# Masterplan: Completely recreate Supreme Commander FA

Goal: **The complete game 1:1 in the browser** — all units, weapons,
Factories, AI, maps, campaign, multiplayer, mods. original behavior,
-values ​​and look; Only the architecture is new (TypeScript/WebGL instead
C++/DirectX9).

Basis: in-depth research in the reconstructed engine (faf-re), the
Original Lua layer and the game data (2026-07-13, 10 parallel analyses
+ own measurements). **Every number here is proven** — guesses are as
solche markiert.

---

## 1. Finding: Where is the game?

The Moho engine is a framework; The game logic lies largely in
**Lua**. Gemessen:

| Schicht | Umfang | Inhalt |
| --- | --- | --- |
| Engine C++ (faf-re) | ~600,000 rows | sim 169k, unit 89k, ai 85k, render 44k, entity 44k, resource 33k, audio 27k, net 27k, particles 20k, effects 12k, script 11k, task 8k, terrain 8k, projectile 6k, collision 5k, command 5k, path 4k, vision 1k |
| Gameplay Lua | **183,202 LOC** | AI 83,723 · UI+MAUI 46,255 · Sim Core 28,658 · Unit Scripts 13,473 · Projectiles/Effects/Props 6,309 · Campaign Framework 4,784 (+28,718 LOC Map Scripts) |
| Effect Blueprints | **2724** (effects.scd) | 2437 Emitters · 184 Trails · 103 Beams |
| Engine↔Lua API | **~490 methods + ~410 globals + 183 callbacks**; **Sim only: 339 + 204 ≈ 543 bindings** | 36 base classes `moho.*_methods`, of which ~15 are sim-relevant |

**Consequence:** Translating gameplay Lua to TypeScript by hand would mean
Rewriting 183k lines of original game logic - never exactly, and
Mods/campaign remained impossible (mods are Lua monkey patching and lead
**foreign Lua code**).

---

## 2. Architecture decision: Run original Lua

> **We run the original Lua scripts in an embedded VM and
> implement the engine API (`moho.*`) in TypeScript.**

### 2.1 Which VM? (empirically clarified)

FA nutzt **Lua 5.0.1 (PUC-Rio) mit GPG-gepatchtem Lexer** (Versions-String in
`bin/main.exe`; Engine bindet LuaPlus 5.0 build 1081).

**Eigene Messungen:**

| Test | Ergebnis | Konsequenz |
| --- | --- | --- |
| Transpiler + Lua 5.4 (wasmoon): **parse all 1316 original scripts** (`scripts/verify-lua.ts`) | ✅ Syntax solvable | Transpiler works |
| `tostring(10/2)` in 5.4 | `"5.0"` (Original: `"5"`) | ❌ Integer subtype corrupts strings/IDs |
| `math.type(3)` in 5.4 | `integer` | ❌ 5.0 only knows doubles |
| `arg` table in Vararg function (5.4) | `nil` (106 locations in the game) | ❌ breaks at runtime |

→ **Syntax ≠ Semantics.** wasmoon/5.4 is suitable for prototyping, not for 1:1.

**Zwei-Gleise-Strategie:**

- **Track A (Target, Fidelity):** **Lua 5.0.1 with the GPG Lexer patches themselves
  Build according to WASM** (Emscripten). Patches are known and from the data
  reconstructed: `#` comment, `!=`, `!`, `continue`, LuaPlus table
  Size instructions `{&1&4}`. Result: **no transpiler necessary, exact
  5.0 semantics** (no integers, `arg`, `table.getn`, `for k,v in t`).
- **Track B (bridge, immediately usable):** existing Lexer transpiler
  ([src/lua/transpile.ts](../src/lua/transpile.ts)) + wasmoon + Compat-Shims —
  to develop the `moho` API and boot path *now*. Acquaintance
  deviations documented; will be replaced with track A.

**Determinism Bonus of Embedding:** All clients run the same one
VM build from → identical table iteration order. A TS replica
would have to reproduce this order artificially, otherwise lockstep would drift.

### 2.2 What remains TypeScript?

The Engine Side: Tick Loop, Motion/Pathfinding, Collision, Intel Grids,
Economy, renderer, network. Lua gets the 543 sim bindings + callbacks.

---

## 3. System specifications (researched, for implementation)

### 3.1 Sim-Kern
- **Tickrate fix 10 Hz** (`GetSimTicksPerSecond` pusht konstant 10.0).
- **Beat ≠ Tick**: Beats always run (mains, checksum), ticks only when not
  pausiert/GameOver.
- **Tick Order** (`Sim::AdvanceBeat`): Empty resource batteries → per
  Armee `OnTick` (Eco-Cache, Stats, Navigator-/Steering-Stages) → **TaskStageA
  (Command dispatch + all unit tasks)** → TaskStageB → Blips → Recon →
  Effekte → Formationen → Kill-Cleanup → Transform-Commit → Checksum.
- **Commands never run directly**: a continuous task reads the queue header and
  pushes a `CCommandTask` onto the task stack. Return values ​​control this
  Scheduling (−1 = finished, 0 = immediately again, N = wait N−1 ticks).
- **Economy = Request/Grant**: Consumer hangs `CEconRequest`
  (requirements per tick) to the army list; Engine enters `mGranted`;
  Construction/repair use the ratio (stall = slow), capture/teleport
  waiting for full coverage.
  - Construction: `time = BuildTime / buildRate`; `energy_rate = BuildCostEnergy/time`;
    Fortschritt/Tick = `(buildRate / BuildTime) * 0.1 * ResourceConsumed`.
  - **Assist is additive**: effective rate = Σ buildRate of the helper.
  - **Distribution now from the binary** (`func_ArmyProcessEconomy` @ 0x771B50,
    in faf-re Stub) → [research/economy-binary.md](research/economy-binary.md):
    **two-tier** — consumers who need *both* resources run along
    Ratio `r1 = min(1, min available/totalDemand)`; who *only needs one*,
    gets its own ratio `r2` from the rest on the non-bottleneck resource.
    `mGranted` per consumer; `LimitingRate = granted/requested` scales the
    Progress *per building*. Our current one-factor stable is too simple.
  - **Command→Task-Dispatch** (`DispatchTask` @ 0x608EF0) → 40 Befehlstypen
    ([research/command-dispatch-binary.md](research/command-dispatch-binary.md)).
  - **Construction task flow** complete ([research/build-task-binary.md](research/build-task-binary.md)):
`delta = (buildRate/BuildTime) * resourceConsumed * 0.1`, HP grows linearly
    with progress, completion → `OnStopBeingBuilt` (Lua) + Adjacency-
    Scan; `resourceConsumed` = `LimitingRate` from the Econ distribution (both
    Systeme greifen ineinander).
  - Reclaim: `Ticks = max(BuildCostEnergy, BuildCostMass) / buildRate`.
  - Capture: `Ticks = max(1, ((BuildTime/buildRate)/2 * CaptureTimeMultiplier) * 10)`,
    Progress += Number of Captors.
  - **Veterancy is kill-based** (default thresholds 25/100/250/500/1000):
    MaxHealth ×1.1…×1.5 (REPLACE from bp basis), Regen +2…+10.
- **Decomp loopholes (honest):** Econ distribution routine, the big one
  `DispatchQueuedCommand` switch and the build task state machines are
  **not** reconstructed → derive and **verify** from Lua + callers.

### 3.2 Waffen (Engine + Lua geteilt)
- Core Lua is located in **mohodata.scd** (`sim/weapon.lua`, `sim/defaultweapons.lua`,
  `sim/DefaultDamage.lua`, `sim/CollisionBeam.lua`, `sim/DefaultProjectiles.lua`).
- **Feuertakt Engine-seitig, tick-quantisiert**: `fireClock = (int)(10 / RateOfFire)`
  → RateOfFire 3 ⇒ 3 ticks = 0.30 s (effective 3.33/s), **not** 0.333 s.
- Engine only calls `weapon:OnFire()`; the **Salvo state machine** (Idle →
  RackSalvoCharge → FireReady → Firing → Reload, + Pack/Unpack) is located in Lua.
- **Range purely 2D (XZ)** versus MaxRadius²/MinRadius², separately
  `|Δy| ≤ MaxHeightDiff` and HeadingArc.
- `TrackingRadius` is a **multiplier** from MaxRadius.
- Towers: `TurretYaw/PitchSpeed` [°/s] → `slew = speed * DEG2RAD * 0.1` per tick;
  `FiringTolerance` [°] per axis.
- Projektile: Gravitation **(0, −4.9, 0)**; Defaults UseGravity=1, Lifetime=15,
LeadTarget=1, TrackTarget=0; `MuzzleVelocity` overrides InitialSpeed
(with Gaussian jitter + short-range attenuation).
- **Damage — now reconstructed directly from the binary** (IDA; in faf-re is
  `SIM_Damage` just a stub) → [research/damage-binary.md](research/damage-binary.md):
  - **No distance falloff** (occupied): full amount to every entity in the radius.
  - Formel: `effektiv = amount * ArmorMult(damageType) / (1 + Handicap)`
    — **Division**, not `*(1-Handicap)` as previously assumed.
  - Category **`NOSPLASHDAMAGE`** is immune to area damage.
  - Shield absorption is deducted **before** the individual damage.
  - Self Damage: Projectile is resolved onto its launcher.
  - Health penalty/death happens in **Lua** (`Unit.lua:OnDamage`), not in the engine.
- Overkill: `overkillRatio > 1` ⇒ **no wreck**; Wreck mass =
  `BuildCostMass * Wreckage.MassMult * (1-overkill) * FractionComplete`.
- Schilde: Absorption = `min(shieldHP, amount*ArmorMult*(1-Handicap))`,
  Overspill via `PassOverkillDamage`; Regen startet nach `ShieldRegenStartTime`,
  every hit resets it.
- Beams: no projectile; `CollisionCheckInterval = BeamCollisionDelay * 10` ticks.
- **Gap:** `SIM_Damage` is a stub in decomp → damage output
  Lua + Blueprint-Rechnung verifizieren.

### 3.3 Movement, Paths, Collision
- Units: `MaxSpeed*0.1` = m/tick; `MaxAcceleration*0.01` = m/tick²;
  `TurnRate [°/s] * 0.0017453` = rad/Tick.
- **Passierbarkeits-Grid**: 1 Zelle = 1 Weltmeter (= Heightmap-Raster);
  Bitmask `{LAND=1, SEABED=2, SUB=4, WATER=8, AIR=16, ORBIT=32}` off
  Footprint (MaxSlope, Min/MaxWaterDepth, Size) + Heightmap + TerrainType +
  Structure Occupancy.
- **Slope is not an angle**: max. absolute height difference between neighboring samples
  > `MaxSlope` (standard **0.75**) ⇒ not passable.
- Footprints global in `mohodata.scd:lua/footprints.lua` (20 entries).
- **Pathfinding**: hierarchical A* (cluster 1/8/32/128), per footprint type
  a ClusterMap, incremental update with frame budget; A* runs in one
  Armee-Queue; Heuristik = Octile × 1.01.
- **Repath** at: target distance > threshold, layer change, 30 ticks without
change of position; 3 failures ⇒ escalation.
- **Dodge is prediction based** (no boids): neighbors in radius,
  Spline forward simulation every 3 ticks, 2D OBB overlap test.
  **No physical pushing** — just occupancy + reservation + steering.
- Layer height: Land = Terrain (SnapToGround averages 4 footprint corners),
  Water = Wasserspiegel, Sub = Spiegel + (negatives) Elevation, Air = + Elevation.
- Ships: no real draft (Footprint-MinWaterDepth), curve radius
  limits speed; Bots (RotateOnSpot) only leave
  Heading-Alignment > 0.98 an.
- Air: **no pathfinding** (direct to target), dampening + bank/lift factors.
- Formations: `lua/formations.lua` (offsets per category/row), slots will be
  snapped to free cells, formation speed regulated.

### 3.4 Intel (Radar/Sonar/Omni/Sicht)
- **Grids**: Vision 2 m/cell, all others (Water, Radar, Sonar, Omni,
  Counter-Intel) 4 m/Zelle.
- `CIntelGrid` is an **int8 counter** (AddCircle +1 / SubtractCircle −1);
  sichtbar = Zelle ≠ 0. Radius→Zellen per **Ganzzahldivision**.
- Vision Grid only exists with FoW=on; without FoW everything is immediately visible.
- Handle update only if movement ≥ `radius*0.333` **or** > 30 ticks old.
- Recon scheduling: **one army per tick** (`tick % armyCount`).
- Flags: Radar/Sonar/Omni/LOSNow/LOSEver/KnownFake/MaybeDead;
  **LOSEver + KnownFake are sticky**.
- **Ghost buildings**: no longer seen *immobile* units with LOSEver
  remain as a frozen blip (last known status).
- **Jammer**: `Intel.JammerBlips` fake blips with random offset in
  `JamRadius`; exposed by Omni/LOS/source loss.
- Client FoW: two grids per army — *Explored* (ever seen) and *Fog*
  (aktuell sichtbar).

### 3.5 Effekte & Audio
- Emitter blueprints are **Lua-DSL** (`EmitterBlueprint{…}`), 21 curves each
  emitters; **Curve evaluation**: linearly interpolate from y **and** z, then
  `(rand()-0.5)*z + y` (z = Streubreite!). Zeiteinheit = Sim-Ticks.
- **Partikel-Physik steckt im Vertex-Shader** (`effects/particle.fx`):
  without drag `pos = P0 + V·t + 0.5·A·t²`; with drag exponential. Color =
  Partikeltextur × Ramp (U = t/lifetime).
- BlendModes: 0=Alpha, 3=Add (most common), … ; 747 particle textures.
- Trails = Ribbons; Beam's own blueprints.
- Effect templates: `lua/EffectTemplates.lua` (~586 tables).
- **Audio = XACT**: `.xwb` (WBND) + `.xsb` (SDBK) — Header verifiziert.

### 3.6 Rendering (offene Features)
- **SCMAP tail now fully decoded** (over 60/60 maps up to EOF
  verified): WaterMap is followed by Foam/Flatness/DepthBias masks,
  TerrainType, (v60) Skybox, **Props List** (up to **46,971 Props/Map** ⇒
  Instancing zwingend).
- **39 of 60 cards use `TTerrain`** (only 4 strata, different light formula) —
  we currently render everything as TTerrainXP. Must branch to `terrainShader`.
- Original terrain normal comes from a **deferred buffer** (base pass
  writes geometry and stratum normals, `frame.fx` builds the TBN).
- Wasser: Fresnel = prozedurale 128×128-Lookup (`d·bias + (1−d·bias)(1−NdotV)^power`);
WaterMap channels: **R=Flatness, G=Depth, B=Alpha Mask, A=1−Foam**.
- Skycube-DDS = real cubemaps (DXT1 512², 6 faces, no mips).
- Decals: Typ-Enum (1=Albedo, 2=Normals, …); Matrix = translate(−pos)·Ry·Rx·Rz·scale(1/s).
- LOD selection: first LOD with `cutoff ≤ 0` **or** `distance ≤ cutoff`.
- Legacy shader aliases: `TMeshAlpha→NormalMappedAlpha`, `TMeshGlow→…`, `Team→Unit`
  (Props use the old names).

### 3.7 UI (original structure)
- **We are completely missing the container model**: `gamemain.lua:CreateUI()` is overbuilding
  `borders.SetupBorderControl` vier Container — `controlClusterGroup` (unteres
  150-px-Band), `statusClusterGroup` (oberes Band), `mapGroup`, `windowGroup`.
  All panels hang on it. **Requirement for positions true to the original.**
- **Build Menu** (`construction.lua`, 79 KB) is the biggest missing item:
  3 main tabs, 5 sub-tabs, 50px icon grid, construction queue, infinite/pause.
- Orders: Original has **12 slots** (us: 6) + 9 toggle caps.
- Cursors, Command-Feedback (Blips/Orderlines/Rally), Hotkeys
  (`keymap/defaultKeyMap.lua`) are completely data-driven.

### 3.8 Netz, Replay, Save
- **Lockstep transmits commands only**: 24 opcodes; Wire format
  `[u8 type][u16 size][payload]`; **no host relay** (broadcast to everyone,
  vollvermaschtes P2P).
- Desync detection: MD5 via economy + dirty entities + **complete
  MT19937-RNG-State** je Beat; 128-Beat-Ring.
- **Replay = recorded wire stream** (feed in bytes 1:1 again).
- Session start via `SWldSessionInfo` (map, launch info, RNG seed) —
identical for MP, SP, Replay, Load.

### 3.9 Game Framework
- Skirmish = **Single-player hosting** via the same lobby ("None" protocol).
- Sim init: `__blueprints` → `simInit.lua` → `ScenarioInfo` → `SetupSession()`
(loads `_save.lua` + `_script.lua`) → Armies/Brains → `BeginSession()`
  (`OnPopulate`/`OnStart`).
- Map script for Skirmish is **minimal**; the Army/ACU generation is in
  `mohodata:lua/sim/ScenarioUtilities.lua`.
- **Victory**: `lua/victory.lua` — demoralization (=Assassination, Default),
  domination, eradication, sandbox; Poll every 3 s, 15 s stable position.
- Options/Prefs/Keybindings: all Lua tables (`Game.prefs`).

---

## 4. Phasenplan

Each phase ends with: Typecheck, `verify*.ts` against original data,
Verhaltens-/Screenshot-Test, Commit.

### Phase A — Lua-Fundament ✅ Meilenstein erreicht
1. ✅ **FA-Lua-Transpiler** — 1316/1316 Skripte parsen (`scripts/verify-lua.ts`).
Dialect peculiarities solved: `#` comment, `!=`, `continue`→goto,
   `arg`-Vararg→`table.pack`, generic-for→`__foriter`-Dispatcher,
Number-to-keyword (`0then`), `{&1&4}`, BOM, invalid escapes.
2. ✅ **A1** Host bootet `import.lua` + `class.lua` (`verify-luaboot.ts`).
3. ✅ **A2** Original `LoadBlueprints()` pipeline loads real blueprint
   (`verify-blueprints.ts`).
4. ✅ **A3** real `Unit.lua` (142 KB) + `defaultunits.lua` (33 classes)
   load with full import cascade (`verify-units.ts`).
5. ✅ **A4 Milestone**: Unit instantiated via original `Unit.lua`,
   `OnCreate` runs through, reading original blueprint values
   (`verify-unit-create.ts`). moho API v1 (105 Unit + 72 Entity methods).
6. **offen — Gleis A**: Lua 5.0.1 + GPG-Patches nach WASM (exakte Semantik,
   replaces transpiler); moho stubs step by step through real sim connection.

### Phase B — Kampf
5. Waffen-API + `defaultweapons.lua`-Zustandsmaschine, Fire-Clock
   (tick-quantisiert), Aiming/Slew, Zielerfassung.
6. Projektile (ballistisch/gelenkt/Beam), Kollision, `Damage`/`DamageArea`/
   `DamageRing` (no falloff!), armor multipliers, overkill/wrecks.
7. Schilde (Absorption/Regen/Overspill).
8. **Milestone**: DPS/Ranges match Blueprint invoice.

### Phase C — Aufbau
9. Task/Command system (queue semantics including patrol rotation), engineering.
10. Passierbarkeits-Grid + hierarchisches A* + Steering/Avoidance + Formationen.
11. Factories, Build Queue, Assist (additive), Reclaim, Repair, Capture, Upgrades;
**UI**: Container model + build menu + build placement + command feedback.
12. **Meilenstein**: kompletter Aufbau ACU → T2 spielbar.

### Phase D — Welt & Intel
13. Intel Grids (counter semantics!), Blips, Ghosts, Jammer, FoW (Sim + Render).
14. Props (Instancing), Decals, TTerrain-Variante, Wasser voll (Fresnel-LUT,
    Cubemap), particle system (curves + particle.fx port), build/wreck shader.
15. **Milestone**: Map + effects look like the original.

### Phase E — Completeness
16. Luft/Marine (Layer-Physik, Transporte, U-Boote).
17. Audio (XACT-Parser → WebAudio).
18. Restliche UI (Score, Avatare, Chat, Tabs, Tooltips, Cursors, Hotkeys),
Lobby/Menu, Options, **Victory Conditions**, End of Game.

### Phase F — Gegner, Netz, Kampagne
19. **KI**: AiBrain/Platoon bindings (57+47 methods) → Original AI Lua (83k LOC) running.
20. Lockstep (deterministische Trig!), Command-Stream, MD5-Checksummen, Replays.
21. Save/Load, Kampagne (ScenarioFramework, Objectives, 6 FA-Missionen).
22. **Meilenstein**: 1:1 spielbar — Skirmish vs. KI, Multiplayer, Kampagne, Mods.

---

## 5. Querschnitt
- **Determinism**: own seed PRNG (MT19937 like original), trig tables
  instead of `Math.sin`, no unsorted iteration; Regression test “2 runs
  bit-identisch" bleibt Pflicht.
- **Performance**: 1000-unit benchmark from phase B (Lua callback overhead is
  the main risk); Sim in Web Worker; Instancing for props/units.
- **Verification**: `verify.ts` (data), `verify-lua.ts` (scripts), future
  `verify-sim.ts` (Blueprint-Rechnung vs. Sim: DPS, Bauzeit, Reichweite).

## 6. Risiken (ehrlich)
| Risk | Status/Countermeasure |
| --- | --- |
| Lua semantics (5.4 ≠ 5.0) | **Confirmed measured** → Track A (own 5.0 build) |
| Lua performance at 1000+ units | open → former benchmark, hot paths in TS |
| Decomp gaps | **closed: all four reconstructed from the FAF binary via IDA-MCP** — SIM_Damage ([damage-binary.md](research/damage-binary.md)), Econ distribution ([economy-binary.md](research/economy-binary.md)), command dispatch ([command-dispatch-binary.md](research/command-dispatch-binary.md)), construction tasks ([build-task-binary.md](research/build-task-binary.md)). Further details if required directly from the IDB. |
| Props/Particle Amount (46k props, thousands of particles) | Instancing + GPU particles (physics in the shader as in the original) |
| XACT audio format | parser needed; Reference: Open Source XACT Implementations |
| Legal | unchanged: no assets/code in the repo, BYO game ([LEGAL.md](LEGAL.md)) |
