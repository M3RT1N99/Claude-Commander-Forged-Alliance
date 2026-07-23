# Stand & bekannte Löcher

*This document carries the changing status so that [CLAUDE.md](../CLAUDE.md)
doesn't have to carry it. Update at every major milestone.*

## Status (July 2026): Tech demo with combat, effects, audio and live UI

Select ACU → Construction menu from the blueprint → Put building on grid →
real economy pays → the factory produces tanks → Gauss duel with
Projectiles, damage, death and **wreck** (wreckage shader from mesh.fx). In addition:
Partikel/Trails/Beams (particle.fx-Port, CEfxEmitter-Tick), CollisionBeams,
guided munitions, XACT audio as PCM in the speaker, units in the
Map Light (mesh.fx ComputeLight). The session UI (economy, multifunction,
orders, construction, unitview, tabs, avatars, minimap-Fenster …) rendert
completely from the original Lua via the real provider chain
(DoPreload → first sync beat → DoInitializing); the **keyboard is alive**
(Keymap from keymapper.lua, 135 hotkeys, CUIKeyHandler executor, UI_Lua).
Verified in 29 suites (`npm test`) and in the browser via
`?sandbox=<karte>&selftest=<blueprint>`.

## Bekannte Löcher

The path to real UI: [PLAN-UI.md](PLAN-UI.md); the 1:1 overall timetable:
[PLAN-1ZU1.md](PLAN-1ZU1.md).

- **No real main menu as the default way.** The front-end boots
  (verify-frontend), but the sandbox starts via the web launcher;
  `LaunchSinglePlayerSession`/Lobby fehlen.
- **Render-Inventur offen (H/M-Liste):** Normals-Decals (brauchen
  Normal RT), refraction/reflection RT of the water (named approximation),
  Prop-Sim (RECLAIMABLE/BlockPath), Planeten-Glow-Pass (Write_A),
  Bloating-Props (2 BPs statisch), Baustellen-Depth (SeraphimBuildDepth).
  NEU ERLEDIGT: Schatten (H7) mit ComputeShadowPCF + Depth-Pass,
  Aeon/Insect Unit Shader (M5), Undulating Tree Wavering. DONE since inventory:
  scmap tail fully parsed (ad3c8e4), map props as
  Instanz-LOD-Ketten (H5), DDS-Cubemaps + Env-Reflexion (5287a98),
  Terrain-Shader-Varianten + Stratum-Normals + Skirt (H4), Albedo-Decals
  as instance patches, sky dome with planets + Cirrus (M9), water full
  according to HighFidelityPS (H6, 95a36b0), build shader of ALL four factions
  (c370942), Glow/Bloom-Pass nach CBloomRenderer (H2, ef1f088),
  Baustellen-Look (H3), Beat-Interpolation (M6), Icon-Tint (M1).
- **Sound settings don't set anything** (user discovery): SetVolume/GetVolume
  miss; GameAudio does not have xgs category gains (research ongoing).
- **Keyboard follow-up findings:** `InternalCreateEdit` missing (chat/console INPUT),
  `StartCommandMode` console command missing (hotkeys like Shift-P/Patrol are running
  into the WARN list), `IsAlly` is missing in the UI VM ('allies' chat).
- **Command dispatch, remaining gaps:** Stop / Move-cancels-build / Attack
  on units are 1:1 now (dispatch table @0x608EF0, abort chain
  Cfile:814989); still open: attack-ground (CFireAtTask), shift-queueing
  of orders, Patrol, Guard/Assist (resume builds), Reclaim/Repair/Capture,
  and the command markers (UICommandGraph).
- **Sim Finds:** Units stack at roll-off (no separation),
  Mex stable (Production × LimitingRate, Cfile:953938), towers do not rotate
  (Turret-Aiming), Audio-Loops/Variationen.
- **`src/ui/hud.ts`** is the last TS remainder (minimap image, strategic
  icons). Don’t grow anything new there; it disappears with worldview/minimap.
- **The map is parsed in TS** (`main.ts` reads `Scenario…Markers` itself)
  instead of via `ScenarioUtilities.lua` (no army groups, no props).
- **The blueprint is read twice** — TS parser (models/bones) and
  real `LoadBlueprints()` pipeline. Two truths.
- **Only one farmer per construction site** — Assist is missing.
- **Ökonomie-Lua-API teils No-Op:** `SetProductionPerSecond*`,
  `SetConsumptionPerSecond*`, `SetBuildRate` don't write anything to them yet
  Engine economics (values ​​only come from the blueprint).
- **`research/economy-binary.md` describes more than `economy.ts` can**
  (Handicap, Overflow-Sharing, kumulierter `granted`-Akku).
- **DDS parser:** 16-bit uncompressed DDS are rejected (found by
  Self-test run, affects at least one UI texture).
- **Score numbers remain blank** (1:1: Vanilla-3599 has none
  currentScores-Produzenten) — Nutzer-Entscheidung Vanilla vs. FAF offen.
