# Masterplan: Supreme Commander FA vollständig nachbauen

Ziel: **Das komplette Spiel 1:1 im Browser** — alle Einheiten, Waffen,
Fabriken, KI, Karten, Kampagne, Multiplayer. Original-Verhalten, -Werte und
-Look; neu ist nur die Architektur (TypeScript/WebGL statt C++/DirectX9).

Grundlage: Recherche in der rekonstruierten Engine (faf-re), der
Original-Lua-Schicht und den Spieldaten (Stand 2026-07-13).

---

## 1. Befund: Wo steckt das Spiel eigentlich?

Die Moho-Engine ist ein **Framework**, das Spiel-Logik liegt zum großen Teil
in **Lua**. Gemessene Größen:

| Schicht | Umfang | Inhalt |
| --- | --- | --- |
| Engine C++ (faf-re) | ~600.000 Zeilen | sim 169k, unit 89k, ai 85k, render 44k, entity 44k, resource 33k, audio 27k, net 27k, particles 20k, effects 12k, script 11k, task 8k, terrain 8k, projectile 6k, collision 5k, command 5k, path 4k, vision 1k |
| Lua Gameplay (lua.scd) | **6,7 MB, 369 Dateien** | `sim/Unit.lua` (139 KB!), `defaultunits.lua` (Klassenhierarchie), `defaultweapons.lua`, `shield.lua`, `EffectTemplates.lua` (176 KB), `formations.lua`, `victory.lua`, AI (1,3 MB), UI (2,0 MB) |
| Unit-Skripte (units.scd) | 805 KB, 568 Dateien | pro Einheit: Waffen-Verdrahtung, Animationen, Effekte |
| Projektil-Skripte | 293 KB, 288 Dateien | + 289 Projektil-Blueprints |
| Effekt-Blueprints | **2827 `.bp`** (effects.scd) | Partikel-Emitter |
| Engine↔Lua-API | **2296 Binder** | ~105 Unit-, 72 Entity-, 57 AiBrain-, 47 Platoon-, 25 Projectile-Methoden + Globals |

**Konsequenz:** Ein „Nachbau in TypeScript" der Gameplay-Logik hieße, ~8 MB
originalen Lua-Code von Hand zu übersetzen — fehleranfällig, nie exakt, und
Mods/Kampagne blieben unmöglich.

## 2. Architektur-Entscheidung: Lua einbetten

> **Wir betten einen echten Lua-VM ein und implementieren die Engine-API
> (`moho.*`) in TypeScript.** Die Original-Lua-Dateien laufen — nach einer
> mechanischen Dialekt-Übersetzung — unverändert.

**VM-Wahl:** Lua **5.1** (via Emscripten nach WASM) statt 5.4 — 5.1 kennt
`setfenv`/`getfenv`/`unpack`/`loadstring` nativ, die FA an 24 Stellen nutzt.
Fallback: `wasmoon` (5.4) + Shim-Schicht.

**Dialekt-Adapter** (Umfang exakt vermessen über alle 369 lua.scd-Dateien):

| Konstrukt | Dateien | Übersetzung |
| --- | --- | --- |
| `#` als Zeilenkommentar | 234 | → `--` · **eindeutig**: FA-Lua (5.0) kennt keinen `#`-Längenoperator; alle 1149 Fundstellen sind Kommentare (verifiziert) |
| `!=` | 118 | → `~=` |
| `for k,v in TBL do` (5.0-Implizit-Iteration) | 154 | → `for k,v in pairs(TBL) do` (nur wenn Ausdruck kein Funktionsaufruf) |
| `table.getn/setn/foreach` | 87 | Kompat-Shims in Lua |
| `arg`-Tabelle in Vararg-Funktionen | 15 | `local arg = table.pack(...)` injizieren |
| `math.mod` | 17 | Shim |

→ **Lexer-basierter Transpiler** (nicht Regex: Strings/Long-Strings dürfen
nicht kaputtgehen), Test: alle 369 Dateien müssen fehlerfrei laden.

- **Sim bleibt in TypeScript**: Bewegung, Pathfinding, Kollision, Vision,
  Wirtschaft, Tick-Loop — die Hot Paths. Lua bekommt die Callbacks
  (`OnCreate`, `OnDamage`, `OnKilled`, `OnStopBeingBuilt`, Waffen-Zyklen …).
- **Gewinn**: Balance, Waffenverhalten, Effekte, KI, Kampagne und **Mods**
  funktionieren automatisch original-getreu — statt ~8 MB Lua von Hand zu
  übersetzen.
- **Risiko**: Lua-Aufruf-Overhead bei 1000+ Einheiten. Mitigation: Callbacks
  batchen, heiße Pfade in TS, Benchmark ab Phase B.

## 3. Systeminventar & Status

Legende: ✅ fertig · 🔶 teilweise · ❌ offen

### Daten & Assets
| System | Status | Quelle/Referenz |
| --- | --- | --- |
| SCD-Archive (Zip-VFS) | ✅ | `resource` |
| SCM-Meshes, Bones | ✅ | verifiziert |
| SCA-Animationen | ✅ | 474/474 |
| Blueprints (Unit) | ✅ | 568/568 |
| Mesh-/Textur-Auflösung je LOD | ✅ | `RMeshBlueprintLOD::Init` |
| DDS/DXT | ✅ | inkl. Software-Fallback |
| SCMAP (Terrain/Wasser/Lighting) | ✅ | 60/60 Karten |
| Props/Decals aus SCMAP | ❌ | Props-Liste geparst, nicht gerendert |
| Emitter-Blueprints (2827) | ❌ | effects.scd |
| Sound-Banks | ❌ | **XACT**: `.xwb` (WBND) + `.xsb` (SDBK), verifiziert per Header |
| Movies/Briefings | ❌ | movies.scd (Sofdec/ADX) |

### Simulation
| System | Status | Was fehlt |
| --- | --- | --- |
| Tick-Loop 10 Hz, deterministisch (f32) | ✅ | bit-identische Läufe verifiziert |
| Bewegung (Speed/Turn/Accel/Brake) | 🔶 | Original-Integration aus `CUnitMotion` nachziehen; Layer (Hover/Air/Sea) |
| Wirtschaft (Floating Eco) | 🔶 | echte BuildRate-Zuordnung, Assist-Stacking, Reclaim, Overflow, Adjacency-Buffs |
| Command/Task-System | ❌ | `CUnitCommandQueue`, `task/` — Queue, Formationen, Attack-Move, Patrol, Guard |
| Waffen | ❌ | RackSalvo-Zustandsmaschine (`defaultweapons.lua`), Aiming, Ziel-Erfassung |
| Projektile (289 Typen) | ❌ | ballistisch/gelenkt/Beam, Kollision, Splash |
| Schaden/Tod/Wracks | ❌ | `defaultdamage.lua`, `wreckage.lua` |
| Schilde | ❌ | `shield.lua` (Absorption, Regen, Overspill) |
| Pathfinding | ❌ | `path/` (ClusterMap, PathTables) + `formations.lua` (53 KB) |
| Kollision/Footprints | ❌ | `collision/` |
| Intel (Radar/Sonar/Omni/LoS) | ❌ | `sim/CIntelGrid`, `vision/VisionDB`, Blips, Stealth/Jamming |
| Fabriken/Bauen/Upgrades | ❌ | `defaultunits.lua` (FactoryUnit …), Enhancements |
| Veterancy, Buffs | ❌ | `sim/Buff.lua`, `AdjacencyBuffs.lua` (59 KB) |
| Victory Conditions | ❌ | `victory.lua` |

### Rendering
| System | Status | Was fehlt |
| --- | --- | --- |
| Unit-Shader (Standard, Seraphim) | ✅ | ❌ Aeon/Insect/Bau-/Wrack-Shader |
| Terrain-Splatting | ✅ | ❌ Stratum-Normalmaps, Skirts |
| Wasser | 🔶 | Wellen-Normalmaps, Sky-Cubemap, Refraktion, Shorelines |
| Skinning (rigid) | ✅ | |
| Strategic Icons | ✅ | |
| Props/Bäume, Decals, Tarmacs | ❌ | |
| Partikel/Beams/Tracks | ❌ | `particles/` (20k Zeilen) + 2827 Emitter |
| Schild-Kuppeln | ❌ | `ShieldSeraphimPS` u. a. |
| Fog of War / Military-Overlay | ❌ | |
| Range-Ringe, Reticles, Waypoint-Linien | ❌ | `range.fx`, `commandgraph.lua` |
| LOD-System | ❌ | `LODCutoff` je LOD |
| Skybox/Background | ❌ | scmap v60 |

### UI (Original-Layouts aus `lua/ui/game`)
| Panel | Status |
| --- | --- |
| Economy, Orders, UnitView, Minimap | ✅ |
| **Baumenü (`construction.lua`)** | ❌ **kritisch für Spielbarkeit** |
| Build-Platzierung (Geister-Gebäude, Grid-Snap, `commandmode`) | ❌ |
| Command-Feedback (Waypoints, Rally, Reticles) | ❌ |
| Score/Uhr, Avatare, Tabs, Chat, Diplomatie, Ping | ❌ |
| Tooltips, Cursors, Hotkeys (`keymap/`) | ❌ |
| Lobby/Skirmish-Setup, Hauptmenü, Optionen | ❌ |

### Shell/Meta
| System | Status |
| --- | --- |
| Skirmish-Start (Armeen, Optionen, Spawn) | 🔶 Sandbox |
| KI (`lua/AI` 1,3 MB + `aibrain.lua` 165 KB + `platoon.lua` 128 KB) | ❌ — läuft mit Lua-Einbettung „gratis", braucht aber die volle Engine-API |
| Kampagne (`ScenarioFramework`, `SimObjectives`) | ❌ |
| Multiplayer (Lockstep), Replays, Save/Load | ❌ |

---

## 4. Phasenplan

Jede Phase endet mit: Typecheck grün, `verify.ts`-Checks gegen Originaldaten,
Headless-Screenshot/Verhaltenstest, Commit.

### Phase A — Lua-Fundament (Schlüsselphase)
1. `wasmoon` einbinden; **FA-Lua-Transpiler** (Lexer: `#`-Kommentare, `!=`,
   5.0-Idiome) mit Test gegen alle 369 lua.scd-Dateien (Ziel: 100 % parsen).
2. `moho`-API-Layer v1 in TS: Entity/Unit-Grundmethoden (Getter, Health,
   Bones, Blueprint, Army), Globals (`import`, `LOG`, `Random`, …).
3. Klassensystem (`system/class.lua`) + Blueprint-Pipeline (`Blueprints.lua`)
   im VM booten; `defaultunits.lua` laden.
4. **Meilenstein**: Ein ACU wird über die Original-`Unit.lua` erzeugt,
   `OnCreate`/`OnStopBeingBuilt` feuern, Health/Eco kommen aus dem Original.

### Phase B — Kampf (das „Spiel"-Gefühl)
5. Waffen-Engine-API (`CreateProjectileAtBone`, Aiming, `RackSalvo`-Callbacks)
   → `defaultweapons.lua` läuft.
6. Projektile in TS-Sim (ballistisch/gelenkt/Beam) + Kollision + Splash
   nach `defaultdamage.lua`.
7. Schaden/Tod/Wracks/Schilde; Effekte minimal (Muzzle/Impact als Platzhalter).
8. **Meilenstein**: Zwei Armeen kämpfen, Werte exakt wie im Original
   (DPS-Test gegen Blueprint-Rechnung).

### Phase C — Aufbau
9. Pathfinding (Grid aus Terrain/Layer + Cluster-A*), Kollision, Formationen.
10. Fabriken, Ingenieure, Bau-Platzierung (UI: Baumenü + Geister-Gebäude),
    Assist, Reclaim, Repair, Upgrades/Enhancements, Adjacency-Buffs.
11. Command-Queue voll (Attack-Move, Patrol, Guard, Ferry) + Command-Feedback.
12. **Meilenstein**: Ein kompletter Skirmish-Aufbau vom ACU bis T2 spielbar.

### Phase D — Intel & Welt
13. Intel-Grid (Radar/Sonar/Omni/LoS), Blips, Stealth/Jamming, Fog of War
    (Rendering + Sim), Military-Overlay, Range-Ringe.
14. Props/Decals/Tarmacs, Wasser voll, Partikel-System (Emitter-Parser),
    Bau-/Wrack-Shader, LODs.
15. **Meilenstein**: Karte sieht aus wie im Original; FoW funktioniert.

### Phase E — Vollständigkeit
16. Luft & Marine (Flugmodell, Transporte, U-Boote, Träger).
17. Audio: XACT-Parser (`.xwb`/`.xsb`) → WebAudio; Musik/Ambient/VO.
18. Restliche UI (Score, Avatare, Chat, Tabs, Tooltips, Cursors, Hotkeys),
    Lobby/Hauptmenü, Optionen, Victory Conditions, Spielende.
19. **Meilenstein**: Vollständiger Skirmish gegen … noch nichts.

### Phase F — Gegner & Netz
20. **KI**: Engine-API für `AiBrain`/`Platoon` vervollständigen (57+47
    Methoden) → Original-KI-Lua (1,3 MB) läuft.
21. Multiplayer: deterministische Trigonometrie (Tabellen statt `Math.sin`),
    Lockstep-Command-Stream, Desync-Checksummen; Replays (Befehlsstrom).
22. Save/Load, Kampagne (`ScenarioFramework`, Objectives, Briefings).
23. **Meilenstein**: 1:1 spielbar — Skirmish vs. KI, Multiplayer, Kampagne.

## 5. Querschnitts-Aufgaben
- **Determinismus**: eigene Trig-Tabellen, keine unsortierte Iteration,
  Seed-PRNG; Regressionstest „2 Läufe bit-identisch" bei jedem Feature.
- **Performance**: 1000-Unit-Benchmark ab Phase B; Ziel 60 fps Render /
  10 Hz Sim; Sim in Web Worker, Instancing im Renderer.
- **Verifikation**: `verify.ts` wächst mit — Blueprint-Rechnungen vs.
  Sim-Ergebnis (DPS, Bauzeit, Reichweite), Screenshot-Vergleiche.
- **Plattform**: Mobile/Tauri erst nach Phase D (Touch-UI, native FS).

## 6. Risiken
| Risiko | Gegenmaßnahme |
| --- | --- |
| Lua-Performance bei Großschlachten | Hot Paths in TS, Callback-Batching, früher Benchmark |
| Lua-5.0-Dialekt bricht im 5.4-VM | Lexer-Transpiler + Test über alle 369 Dateien |
| Engine-API größer als gedacht (2296 Binder) | inkrementell: nur was die geladenen Skripte rufen; Missing-Method-Trap loggt Lücken |
| Pathfinding-Verhalten weicht ab | gegen `path/`-Rekonstruktion bauen, nicht frei erfinden |
| XACT-Audio-Format | bekannte Open-Source-Parser (MonoGame/XactLib) als Referenz |
| Rechtliches | unverändert: keine Assets/Code im Repo, BYO-Game (docs/LEGAL.md) |
