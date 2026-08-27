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

## Golden Master: ein Orakel, das keine Frage stellt

Jede der 57 Suiten prüft eine Sache, die jemand vorher bedacht hat. Genau daran
sind zwei Regressionen dieser Woche vorbeigelaufen (beschildete Einheiten nahmen
null Flächenschaden; Schüsse an einer Küste meldeten `Water`), und die aus
`4a37b2f` überlebte so einen ganzen Monat.

`scripts/verify-goldenmaster.ts` fährt einen festen Ablauf — Ökonomie, Bau,
Fabrik, Bewegung, Kampf, Flächenschaden, Schildkuppel — und hasht den Endzustand.
Das Material ist nicht ausgedacht: es ist `__readAllUnitsJson()`
(`units.lua:846`), also exakt der Block, den die Sim zehnmal pro Sekunde an die
UI schickt, plus die acht Ökonomie-Summen je Armee. Der Hash liegt in
`scripts/fixtures/goldenmaster.json`.

Der Test weiß nicht, was RICHTIG ist — nur was ANDERS ist. Jede
Verhaltensänderung wird rot, auch eine, an die niemand gedacht hat. War sie
Absicht, wird der Hash mit `--update` in demselben Commit nachgezogen, der sie
erklärt; `--dump` schreibt das gehashte Material heraus, damit ein roter Lauf
zeigt **was** sich geändert hat statt nur **dass**.

Rot-Probe: die Schild-Regression wieder eingebaut (`damage.lua:223`
`if not fromArea` → `if true`) → Hash weicht ab, Exit 1; zurückgenommen → grün.

### Was die Rot-Probe nebenbei gefunden hat: `math.pow`

Der rote Lauf meldete `ForkThread-Fehler: /mod/lua/utilities.lua:50: attempt to
call a nil value (field 'pow')`. FAs Lua 5.0.1 hatte `math.pow`, Lua 5.4
(wasmoon) hat es nicht mehr, und `compat.lua` shimmte es nicht. Betroffen ist
`GetVectorLength` (`utilities.lua:50`) und `platoon.lua:983` — mehr Stellen gibt
es in der Original-Lua nicht (alle 1316 Dateien durchsucht; `math.log10`,
`frexp`, `ldexp`, `cosh/sinh/tanh`, `atan2`, `fmod` kommen nicht vor,
`math.mod` war bereits geshimmt).

Der Fehler war doppelt still: aus einem ForkThread wird er nur geloggt, der
Aufrufer bekommt einfach nie eine Länge. Behoben in `compat.lua`, geprüft in
`verify-lua.ts` über den Original-Ausdruck aus `utilities.lua:50` (3/4/12 → 13),
Rot-Probe: Shim entfernt → FAIL + Exit 1.

## Das Replay als Orakel: die Frage ist beantwortet

Ein Golden Master schützt vor Änderung, aber er sagt nicht, ob der Zustand
RICHTIG ist — er ist unser eigener Zustand. Die einzige Quelle, die das
beantworten kann, ist die Originalengine. Sie hat auf diesem Rechner neun
Partien aufgezeichnet.

Offen war, ob der aufgezeichnete Körper die `VerifyChecksum`-Nachrichten
wirklich Byte für Byte enthält. Die Architektur legte es nahe, bewiesen war es
nicht. **Jetzt ist es bewiesen.**

Der Weg dahin, vollständig aus dem Decompilat: `CDecoder::DecodeMessage`
(Cfile:996781-996800) rahmt jede Nachricht als `[u8 Opcode][u16 Gesamtlänge
LE][Nutzlast]`, `MSGOP_VerifyChecksum` ist Opcode 3 (`case 3u`), und
`DecodeVerifyChecksum` (Cfile:996938-996946) liest 16 Byte Digest plus den Beat
als `int` — ein Datensatz von genau 23 Byte. Das Kopfformat steht in
`VCR_SetupReplaySession` (Cfile:1303988-1304227).

`src/formats/scfareplay.ts` setzt das um, `scripts/verify-replay.ts` prüft es
gegen die echten Aufzeichnungen: **9 Replays aus drei Engine-Ständen
(v1.50.3599, v1.50.3608, v1.60.6), 258 107 Nachrichten, 4 884 Prüfsummen, kein
Fehler.** Die tragende Prüfung ist nicht „parst ohne Ausnahme", sondern dass der
Rahmenlauf in jeder Datei **exakt** auf dem Dateiende endet; ein unabhängiger
roher Byte-Scan findet dieselben Prüfsummen.

Rot-Proben: Körperbeginn um **ein** Byte verschoben → alle neun scheitern
sofort. Kein Replay im Ordner → Exit 1 (ein Fehlschlag, kein Übersprung).

Gemessen: die Prüfsummen liegen bei Beat 0, 50, 100, … ohne Lücke — die größte
Datei hat 2701 Datensätze bis Beat 135 000 (= 2700 × 50 + Beat 0, exakt). **Die
50 ist eine Messung, keine Cfile-Konstante:** die Sendestelle
(Cfile:1067922-1067937) verschickt den Beat, den die Sync-Anfrage nennt, aus dem
128er-Ring `mSimHashes[beat & 0x7F]`; welche Kadenz die Anfrage wählt, ist nicht
nachverfolgt.

Damit existiert alle 5 Sekunden Spielzeit ein Vergleichspunkt gegen die
Originalengine. **Noch nicht gebaut** ist der Vergleich selbst: dafür muss
`Sim::UpdateChecksum` (Cfile:1076701, faltet `SEconTotals` je Armee über 0x38
Byte) nachgebildet werden, und der eingespeiste Befehlsstrom muss bei uns
überhaupt laufen. Das nächste ehrliche Fortschrittsmaß ist deshalb keine
Prozentzahl, sondern: **bis zu welchem Beat kommen wir?**

## Offener Befund: der Typecheck sieht die Skripte nicht

`npx tsc --noEmit` prüft `tsconfig.json`, und dessen `include` ist `["src"]`.
Die **58 Dateien in `scripts/`** — also jedes einzelne Verifikationsgate, der
Playthrough, der Coverage-Zähler, der Selftest-Treiber — laufen damit
**ungeprüft**. „Typecheck grün" hieß bisher: grün für 65 % des Codes, den
`npm test` ausführt.

Aufgefallen beim Bau des Replay-Lesers. Gemessen, nicht geschätzt:

* `@types/node` war **gar nicht installiert** (jetzt als devDependency da) —
  ohne Node-Typen kann `scripts/` gar nicht geprüft werden;
* `scripts/verify-selection.ts:73` war **syntaktisch ungültig für `tsc`**: nach
  dem semikolonlosen `const cand = … => ({…})` liest der Parser den folgenden
  alleinstehenden Block `{` als Fortsetzung. `tsx`/esbuild verzeiht das, `tsc`
  nicht. Behoben (`;{`);
* danach bleiben **155 Fehler in 18 Dateien**:

| Datei | Fehler |
| --- | --- |
| `verify-emitter-curves.ts` | 53 |
| `shot-click.ts` | 24 |
| `shot.ts` | 16 |
| `selftest-gate.ts` | 12 |
| `verify-factory.ts` | 7 |
| `verify-command-chain.ts` | 5 |
| `verify-build-effects.ts` | 4 |
| `src/main.ts`, `verify-user-unit-state.ts`, `verify-upgrade.ts`, `verify-combat.ts` | je 3 |
| `verify-shields.ts`, `verify-playthrough.ts`, `verify-coverage.ts`, `playthrough.ts` | je 2 |
| `verify-restrictions.ts`, `verify-core-globals.ts`, `verify-army-victory.ts` | je 1 |

`tsconfig.scripts.json` und `npm run typecheck:scripts` machen das messbar.
**Das ist noch kein Gate** — es ist rot, und es wird als Befund geführt statt
still zu bleiben. Erst wenn die 155 abgearbeitet sind, gehört der Lauf in
`npm test` und in den pre-push-Hook. Die neuen Dateien dieser Sitzung
(`scfareplay.ts`, `verify-replay.ts`, `verify-goldenmaster.ts`) sind bereits
sauber.

## Die vier `check-*`-Skripte sind jetzt Gates (Runde-2 T023)

`scripts/run-tests.ts` globte nur `verify*`. Die vier `check-*`-Skripte liefen
deshalb **nie** — und das war zu Recht so: sie DRUCKTEN nur. Null
`check()`-Aufrufe, null `exit(1)`-Pfade. Sie damals in den Glob zu nehmen hätte
die Suite-Zahl von 53 auf 58 gehoben, ohne ein einziges Gate hinzuzufügen.

Der Grund für ihre Existenz war ein anderer: jedes hat einmal eine **Konvention
ermittelt**, auf der der Renderer seitdem stillschweigend steht. Ein Mensch hat
die Zahlen gelesen und entschieden; die Entscheidung wurde Code; geprüft wurde
sie nie wieder. Genau das sind sie jetzt — Wächter über ihre eigene Antwort:

| Skript | Die stillschweigende Annahme | Gemessen |
| --- | --- | --- |
| `check-convention` | `scm.ts:24-26`: `restPoseInverse` spaltenweise, Rotation `w,x,y,z`; `animator.ts:61` transponiert nicht | Über 5 Modelle: Einheitsmatrix-Fehler `1e-7`, die drei falschen Kombinationen `7e+0` bis `5e+2` |
| `check-orientation` | `fitDepthToG` bildet die Watermap-Zeile direkt auf die Heightmap-Zeile ab, ohne Spiegelung | 40 auswertbare Karten, `corr(normal) ≥ 0.9` überall, 29 davon trennen die Lesungen um ≥ 0.3 |
| `check-unit-assets` | `resolveUnitPaths` findet die Modelle | 555 von 568 lösen auf, 553 mit Albedo, 3 bewusst `<none>`, 10 ohne Fund |
| `check-watermap-holes` | `FALLBACK = 1/15` im Renderer, und die lineare Ersetzung ist zulässig | Median-Steigung **0.0665** gegen 1/15 = 0.0667; R² ≥ 0.9 ausser SCMP_016 (0.530); 36 DXT-Löcher gesamt |

Zwei Dinge daran sind mehr als Aufräumen:

* **`check-unit-assets` hatte eine eigene Kopie der Auflösungslogik** (`<id>_lod0.scm`,
  `<id>_albedo.dds` von Hand). Sie konnte grün melden, während der echte Lader
  danebenlag. Jetzt ruft es `resolveUnitPaths` selbst — die eine massgebliche
  Darstellung, wie CLAUDE.md es verlangt.
* **`check-watermap-holes` prüft eine Konstante, die sonst nur als Literal
  dasteht.** Die 41 Karten sagen 0.0665, der Renderer sagt 1/15 = 0.0667.

Rot-Proben, jede einzeln gesehen: Rotationsreihenfolge in `scm.ts` vertauscht →
alle 5 Modelle rot mit Nennung der Ursache · Zeilenlesung gespiegelt → alle 40
Karten rot, „0 Karten unterscheiden" · `resolveUnitPaths` lahmgelegt → 555 → 496,
Sperrklinke rot · Grünkanal im DXT-Decoder um 12 gedämpft → 36 → 219 Löcher.

Ein Detail, das die Prüfung selbst korrigiert hat: die erste Fassung von
`check-orientation` verlangte auf JEDER Karte eine niedrige Korrelation der
gespiegelten Lesung — und wurde auf 16 Karten rot. Der Grund war kein Fehler im
Code, sondern in meinem Kriterium: auf **vertikal symmetrischen** Karten
korreliert die gespiegelte Lesung genauso gut (SCMP_002: 1.000 gegen 0.984).
Unterscheidbarkeit ist eine Eigenschaft der Suite, nicht jeder Karte.

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
