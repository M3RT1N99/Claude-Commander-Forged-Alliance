# Status & known gaps

*This document tracks the changing status so [CLAUDE.md](../CLAUDE.md) does not
have to. Update it at every major milestone.*

## Status (July 2026): tech demo with combat, effects, audio, and a live UI

Select an ACU → open the build menu from its blueprint → place a building on
the grid → the real economy pays → the factory produces tanks → a Gauss duel
with projectiles, damage, death, and **wreckage** (the wreckage shader from
mesh.fx). Also included: particles/trails/beams (particle.fx port,
CEfxEmitter tick), CollisionBeams, guided munitions, XACT audio as PCM through
the speakers, and units under map lighting (mesh.fx ComputeLight). The session
UI (economy, multifunction, orders, construction, unitview, tabs, avatars,
minimap window, ...) renders entirely from the original Lua through the real
provider chain (DoPreload → first sync beat → DoInitializing); **keyboard input
works** (keymap from keymapper.lua, 135 hotkeys, CUIKeyHandler executor,
UI_Lua). Verified in 29 suites (`npm test`) and in the browser through
`?sandbox=<map>&selftest=<blueprint>`.

## Known gaps

The path to the real UI: [PLAN-UI.md](PLAN-UI.md); the complete 1:1 roadmap:
[PLAN-1ZU1.md](PLAN-1ZU1.md).

- **No real main menu as the default path.** The front end boots
  (verify-frontend), but the sandbox starts through the web launcher;
  `LaunchSinglePlayerSession`/Lobby are missing.
- **Rendering inventory remains open (H/M list):** normal decals (need a
  normal RT), the water's refraction/reflection RT (a named approximation),
  prop Sim (RECLAIMABLE/BlockPath), planet glow pass (Write_A), Bloating Props
  (2 BPs static), and construction-site depth (SeraphimBuildDepth). **NEWLY
  COMPLETED:** shadows (H7) with ComputeShadowPCF + depth pass, Aeon/Insect
  unit shader (M5), and undulating tree sway. **COMPLETED since the
  inventory:** SCMAP tail fully parsed (ad3c8e4), map props as instance LOD
  chains (H5), DDS cubemaps + environment reflection (5287a98), terrain shader
  variants + stratum normals + skirt (H4), albedo decals as instance patches,
  sky dome with planets + Cirrus (M9), water fully according to HighFidelityPS
  (H6, 95a36b0), build shaders for **ALL** four factions (c370942), glow/bloom
  pass after CBloomRenderer (H2, ef1f088), construction-site appearance (H3),
  beat interpolation (M6), and icon tint (M1).
- **Sound settings do not change anything** (user finding): SetVolume/GetVolume
  are missing; GameAudio has no xgs category gains (research is ongoing).
- **Keyboard follow-up findings:** `InternalCreateEdit` is missing (chat/console
  input), the `StartCommandMode` console command is missing (hotkeys such as
  Shift-P/Patrol go to the WARN list), and `IsAlly` is missing from the UI VM
  ('allies' chat).
- **Command dispatch:** Stop, Move-cancels-build, Attack (units and ground,
  AITARGET_Ground), Repair (including HP repair), shift queueing
  (CUnitCommandQueue), Guard/Assist (queue sharing, build assist, follow), and
  SetFireState are now 1:1 (dispatch table @0x608EF0). Still open: Patrol,
  Reclaim/Capture, point guard, capture-on-enemy, guard enemy chase
  (GetBestEnemy), ground-attack ring rotation in the queue, and command markers
  (UICommandGraph — order lines exist).
- **Sim findings:** units stack up at roll-off (no separation), Mex stall
  (production × LimitingRate, Cfile:953938), turrets do not rotate
  (Turret-Aiming), audio loops/variations.
- **`src/ui/hud.ts`** is the last TS remainder (minimap image, strategic
  icons). Do not add anything new there; it disappears with worldview/minimap.
- **The map is parsed in TS** (`main.ts` reads `Scenario…Markers` itself)
  instead of through `ScenarioUtilities.lua` (no army groups, no props).
- **The blueprint is read twice** — by the TS parser (models/bones) and the
  real `LoadBlueprints()` pipeline. Two sources of truth.
- **Assist works** (multi-builder placement plus Guard on a builder/factory);
  a Guard on a reclaiming builder does not assist yet (Reclaim is entirely
  missing).
- **Economy Lua API is partly a no-op:** `SetProductionPerSecond*`,
  `SetConsumptionPerSecond*`, and `SetBuildRate` still do not write to the
  engine economy (values come only from the blueprint).
- **`research/economy-binary.md` describes more than `economy.ts` supports**
  (Handicap, overflow sharing, cumulative `granted` accumulator).
- **DDS parser:** 16-bit uncompressed DDS files are rejected (a finding from a
  self-test run; it affects at least one UI texture).
- **Score numbers remain blank** (1:1: Vanilla-3599 has no `currentScores`
  producers) — the user decision between Vanilla and FAF remains open.
