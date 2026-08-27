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
UI_Lua). Verified in **53 suites** (`npm test`) and in the browser through
`?sandbox=<map>&selftest=<blueprint>`.

## Engine coverage (August 2026)

`npx tsx --import ./scripts/register-lua.mjs scripts/coverage-engine.ts` measures
every binding in [research/engine-api.md](research/engine-api.md) against what
our engine made of it: **1149 bindings, 698 real / 147 no-op / 304 missing =
61 %**.

Two earlier figures are void. "86 %" was measured while the class-line regex
(`$`-anchored, CRLF checkout) parsed **no class binding at all** and pinned the
NO-OP column to 0. The replacement "57 %" was **also wrong**: `methodenStand`
returned `FEHLT` for every class not in a 19-entry map, so **238 methods across
32 classes were scored blind**. The map now covers the manipulators (one shared
`ManipMeta` — a named reduction), `CollisionBeamEntity` and `CMauiLuaDragger`;
**38 methods moved from "missing" to "real"** on re-measurement.

Largest remaining gaps: `Unit` (54), `CPlatoon` (49) and `CAiBrain` (48) — the
two AI classes are a scheduled phase in [MASTERPLAN.md](MASTERPLAN.md), not a
defect — then Sim-Globals (47), `CAiPersonality` (35), `Entity` (27),
`CLobby` (18). Those four classes genuinely do not exist in `src/engine-lua/`
(checked); `FEHLT` is correct for them.

## Welche der stillen No-ops das Spiel wirklich aufruft

`src/engine-lua/moho.lua` füllt **147** Bindungen mit einem stillen No-op. Bis
jetzt war unbekannt, welche davon im laufenden Spiel überhaupt erreicht werden —
die Priorisierung war Raten. `scripts/verify-playthrough.ts` schaltet dafür
`__mohoNoopWarn` ein; jeder No-op meldet sich beim ersten Aufruf.

Eine vollständige Partie (ACU → Bau → Fabrik → Kampf → Wrack) ruft **9 von 147**:

| No-op | Wofür |
| --- | --- |
| `HideBone`, `ShowBone` | Knochen aus-/einblenden (Bau, Upgrade) |
| `AttachTo`, `AttachBoneTo`, `DetachFrom`, `DetachAll` | Anhängen — Transporter, Bauarme |
| `AddBuildRestriction` | Bau-Beschränkungen der Armee |
| `GetFocusUnit` | die Fokus-Einheit |
| `ShakeCamera` | Kamera-Erschütterung bei Einschlägen |

Das ist die Arbeitsliste, nach Messung sortiert. Die übrigen 138 werden auf
diesem Weg nicht erreicht — sie sind deshalb nicht harmlos, aber sie sind auch
nicht dringend. Ein **zehnter** aufgerufener No-op lässt den Durchlauf
fehlschlagen (eingecheckte Fund-Liste).

## Known gaps

The path to the real UI: [PLAN-UI.md](PLAN-UI.md); the complete 1:1 roadmap:
[PLAN-1ZU1.md](PLAN-1ZU1.md).

- **No real main menu as the default path.** The front end boots
  (verify-frontend), but the sandbox starts through the web launcher;
  `LaunchSinglePlayerSession`/Lobby are missing.
- **Rendering inventory (H/M list), still open:** the water's
  refraction/reflection RT (a named approximation), Bloating Props (2 BPs
  static), and construction-site depth
  (SeraphimBuildDepth). **COMPLETED since the inventory:** the planet glow
  pass (Write_A) — `skyPlanetGlow.frag.glsl`, wired at `skyDome.ts:10`, built
  in `4d42592` and listed as open here for 36 days; normals decals
  through the screen-space normal prepass (46c3e8b), shadows (H7) with
  ComputeShadowPCF + depth pass, Aeon/Insect unit shader (M5), undulating
  tree sway, SCMAP tail fully parsed (ad3c8e4), map props as instance LOD
  chains (H5), DDS cubemaps + environment reflection (5287a98), terrain
  shader variants + stratum normals + skirt (H4), albedo decals as
  instance patches, sky dome with planets + Cirrus (M9), water according
  to HighFidelityPS (H6, 95a36b0), build shaders for ALL four factions
  (c370942), glow/bloom pass after CBloomRenderer (H2, ef1f088),
  construction-site appearance (H3), beat interpolation (M6), icon
  tint (M1).
- **Sound settings work.** `SetVolume`/`GetVolume` are real
  (`ui-globals.lua:2378`/`:2383`), `SupCom.xgs` is parsed
  (`src/formats/xgs.ts`) and GameAudio builds one GainNode per category;
  covered by `scripts/verify-audio.ts`. (This entry claimed the opposite for
  41 days after `5ba81e5` fixed it — corrected 2026-08-27.)
  Still open in audio: loops/variations/instance limits.
- **Text input works** (CMauiEdit vtable-override port: typing, selection,
  MaxChars, OnTextChanged/OnEnterPressed/OnEscPressed/OnCharPressed,
  caret rendering); StartCommandMode console command and UI IsAlly exist.
  The chat WINDOW renders completely (panel, title buttons, scrollbar,
  localized "To all:" prompt, blinking caret) — the earlier
  "invisible window" reading was CDP screenshot latency racing the
  auto-fade toggle. Open: verify the fade duration matches the 15 s of
  chat.lua:1004-1009 in real play; clipboard is a VM-internal buffer
  (browser clipboard is async — platform deviation); drag-selection and
  the exact caret-blink math (CMauiEdit::DoRender undecoded) are named
  gaps.
- **Command dispatch:** Stop, Move-cancels-build, Attack (units and
  ground, AITARGET_Ground), Repair (including HP repair), shift queueing
  (CUnitCommandQueue), Guard/Assist (queue sharing, build assist, follow),
  Patrol (ring-rotated queue legs with engage-on-the-way), Reclaim
  (props/wrecks with the target-Lua cost formula; clickable in the
  browser — wreck raycast plus instanced map-prop picking resolved
  through the scmap index, RULEUCC_Reclaim command mode and the default
  right-click), SetFireState, and command-cap masks/build restrictions
  (Add/RemoveCommandCap, Add/RemoveBuildRestriction with dispatch
  validation) are 1:1 now (dispatch table @0x608EF0); a guard with unit
  category RECLAIM also joins the guarded unit's running reclaim
  (sub_612E80). Still open: Capture, point guard, capture-on-enemy,
  guard enemy chase (GetBestEnemy), ground-attack ring rotation in the
  queue, rectangle reclaim (GetReclaimablesInRect), and command markers
  (UICommandGraph — order lines exist). Click picking is ONE
  depth-sorted raycast across units, wrecks and instanced map props
  (the closest entity of any kind wins — engine semantics).
- **Sim findings:** occupancy at arrival works — two units sent to the same
  point stop 1.41 m apart instead of stacking (`verify-motion.ts`, since
  `7df07bf`). Still open is *predictive* avoidance **during** travel: units do
  not steer around each other on the way, only refuse an occupied arrival cell.
- **Fixed in the August 2026 fidelity round** (spec
  [001-engine-fidelity-fixes](../specs/001-engine-fidelity-fixes/spec.md), each
  with its decomp evidence and a suite): `AIBrain:TakeResource` drains storage
  and returns what it took instead of being a negative `GiveResource`; shields
  absorb once per damage event instead of once per covered unit; target
  acquisition honours `TargetPriorities` instead of picking the nearest;
  construction and decay *adjust* health by the delta instead of assigning it
  (damage to a site is no longer healed away every tick); `Stop` clears a
  factory's production queue; a dying factory stops producing;
  `Unit:GetResourceConsumed` reports the real granted rate instead of a flat 1;
  water impacts report `Water` instead of `Terrain`; the map's water elevation
  reaches the Sim at last, and unit height now branches by motion type (only
  Water/AmphibiousFloating/Hover float — an amphibious unit walks the seabed);
  `uimain.OnMouseButtonPress` is called again, so every `AddOnMouseClickedFunc`
  registration works; a click elsewhere no longer steals the keyboard focus.
- **`src/ui/hud.ts`** is the last TS remainder (minimap image, strategic
  icons). Do not add anything new there; it disappears with worldview/minimap.
- **The map is parsed in TS** (`main.ts` reads `Scenario…Markers` itself)
  instead of through `ScenarioUtilities.lua` (no army groups); map PROPS
  now reach the sim through the boot message (Sim::Setup step 7,
  5182/5182 on SCMP_009).
- **The blueprint is read twice** — by the TS parser (models/bones) and the
  real `LoadBlueprints()` pipeline. The TS side is a pure projection again:
  `blueprintPlacement()` had grown two invented defaults (`Footprint → 1`,
  `BuildOnLayerCaps → 0`) and disagreed with the pipeline on the 72 retail
  structures that ship no `Footprint` section, so the build ghost judged a 3×3
  building as 1×1. Both now derive from the engine rule, and
  `verify-ogrid.ts` compares all 374 structures against the pipeline — a future
  drift is a test failure, not a surprise.
- **Assist works** (multi-builder placement, Guard on a builder/factory, and
  a Guard with category RECLAIM joining a reclaiming builder — sub_612E80,
  asserted in `verify-combat.ts`). Still open: Capture, point guard,
  capture-on-enemy.
- ~~**Economy Lua API is partly a no-op**~~ — no longer true, and the entry was
  stale: `SetProductionPerSecond*` and `SetConsumptionPerSecond*` write through
  `__econUpdateRate` into the army economy (moho.lua:793-808), and
  `SetBuildRate` mutates the value the build task actually reads
  (`b:GetBuildRate()`, build.lua:476). `Unit:GetResourceConsumed` now reports
  the real granted rate too (the last placeholder in that corner).
- **`research/economy-binary.md` describes more than `economy.ts` supports**
  (Handicap, overflow sharing, cumulative `granted` accumulator).
- **DDS parser** handles DXT1/3/5, uncompressed 8/16/24/32-bit (incl. A1R5G5B5,
  the format of all 1,134 strategic icons), cubemaps and full mip chains.
  Sub-4-bit channels now expand uniformly (`round(v*255/(2^bits-1))`) — the
  1-bit alpha of the A1R5G5B5 icons no longer renders at half opacity. Open:
  ATI2/BC5, BC6H/BC7, DX10 headers and DDSD_PITCH — no retail asset uses them.
- **Score numbers remain blank** (1:1: Vanilla-3599 has no `currentScores`
  producers) — the user decision between Vanilla and FAF remains open.
