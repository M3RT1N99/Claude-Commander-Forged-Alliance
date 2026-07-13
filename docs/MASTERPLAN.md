# Masterplan: Supreme Commander FA vollständig nachbauen

Ziel: **Das komplette Spiel 1:1 im Browser** — alle Einheiten, Waffen,
Fabriken, KI, Karten, Kampagne, Multiplayer, Mods. Original-Verhalten,
-Werte und -Look; neu ist nur die Architektur (TypeScript/WebGL statt
C++/DirectX9).

Grundlage: Tiefenrecherche in der rekonstruierten Engine (faf-re), der
Original-Lua-Schicht und den Spieldaten (2026-07-13, 10 parallele Analysen
+ eigene Messungen). **Jede Zahl hier ist belegt** — Vermutungen sind als
solche markiert.

---

## 1. Befund: Wo steckt das Spiel?

Die Moho-Engine ist ein Framework; die Spiel-Logik liegt zum großen Teil in
**Lua**. Gemessen:

| Schicht | Umfang | Inhalt |
| --- | --- | --- |
| Engine C++ (faf-re) | ~600.000 Zeilen | sim 169k, unit 89k, ai 85k, render 44k, entity 44k, resource 33k, audio 27k, net 27k, particles 20k, effects 12k, script 11k, task 8k, terrain 8k, projectile 6k, collision 5k, command 5k, path 4k, vision 1k |
| Gameplay-Lua | **183.202 LOC** | AI 83.723 · UI+MAUI 46.255 · Sim-Kern 28.658 · Unit-Skripte 13.473 · Projektile/Effekte/Props 6.309 · Kampagnen-Framework 4.784 (+28.718 LOC Map-Skripte) |
| Effekt-Blueprints | **2724** (effects.scd) | 2437 Emitter · 184 Trails · 103 Beams |
| Engine↔Lua-API | **~490 Methoden + ~410 Globals + 183 Callbacks**; **nur Sim: 339 + 204 ≈ 543 Bindings** | 36 Basisklassen `moho.*_methods`, davon ~15 sim-relevant |

**Konsequenz:** Gameplay-Lua von Hand nach TypeScript zu übersetzen hieße,
183k Zeilen originaler Spiellogik neu zu schreiben — nie exakt, und
Mods/Kampagne blieben unmöglich (Mods sind Lua-Monkeypatching und führen
**fremden Lua-Code** aus).

---

## 2. Architektur-Entscheidung: Original-Lua ausführen

> **Wir führen die Original-Lua-Skripte in einem eingebetteten VM aus und
> implementieren die Engine-API (`moho.*`) in TypeScript.**

### 2.1 Welcher VM? (empirisch geklärt)

FA nutzt **Lua 5.0.1 (PUC-Rio) mit GPG-gepatchtem Lexer** (Versions-String in
`bin/main.exe`; Engine bindet LuaPlus 5.0 build 1081).

**Eigene Messungen:**

| Test | Ergebnis | Konsequenz |
| --- | --- | --- |
| Transpiler + Lua 5.4 (wasmoon): **alle 1316 Original-Skripte parsen** (`scripts/verify-lua.ts`) | ✅ Syntax lösbar | Transpiler funktioniert |
| `tostring(10/2)` in 5.4 | `"5.0"` (Original: `"5"`) | ❌ Integer-Subtyp verfälscht Strings/IDs |
| `math.type(3)` in 5.4 | `integer` | ❌ 5.0 kennt nur Doubles |
| `arg`-Tabelle in Vararg-Funktion (5.4) | `nil` (106 Fundstellen im Spiel) | ❌ bricht zur Laufzeit |

→ **Syntax ≠ Semantik.** wasmoon/5.4 taugt zum Prototyping, nicht für 1:1.

**Zwei-Gleise-Strategie:**

- **Gleis A (Ziel, Fidelity):** **Lua 5.0.1 mit den GPG-Lexer-Patches selbst
  nach WASM bauen** (Emscripten). Patches sind bekannt und aus den Daten
  rekonstruiert: `#`-Kommentar, `!=`, `!`, `continue`, LuaPlus-Tabellen-
  Größenhinweise `{&1&4}`. Ergebnis: **kein Transpiler nötig, exakte
  5.0-Semantik** (keine Integer, `arg`, `table.getn`, `for k,v in t`).
- **Gleis B (Brücke, sofort nutzbar):** vorhandener Lexer-Transpiler
  ([src/lua/transpile.ts](../src/lua/transpile.ts)) + wasmoon + Compat-Shims —
  um die `moho`-API und den Boot-Pfad *jetzt* zu entwickeln. Bekannte
  Abweichungen dokumentiert; wird mit Gleis A ersetzt.

**Determinismus-Bonus des Einbettens:** Alle Clients führen denselben
VM-Build aus → identische Tabellen-Iterationsreihenfolge. Ein TS-Nachbau
müsste diese Reihenfolge künstlich reproduzieren, sonst driftet Lockstep.

### 2.2 Was bleibt TypeScript?

Die Engine-Seite: Tick-Loop, Bewegung/Pathfinding, Kollision, Intel-Grids,
Wirtschaft, Renderer, Netz. Lua bekommt die 543 Sim-Bindings + Callbacks.

---

## 3. Systemspezifikationen (recherchiert, für die Implementierung)

### 3.1 Sim-Kern
- **Tickrate fix 10 Hz** (`GetSimTicksPerSecond` pusht konstant 10.0).
- **Beat ≠ Tick**: Beats laufen immer (Netz, Checksum), Ticks nur wenn nicht
  pausiert/GameOver.
- **Tick-Reihenfolge** (`Sim::AdvanceBeat`): Ressourcen-Akkus leeren → pro
  Armee `OnTick` (Eco-Cache, Stats, Navigator-/Steering-Stages) → **TaskStageA
  (Befehls-Dispatch + alle Unit-Tasks)** → TaskStageB → Blips → Recon →
  Effekte → Formationen → Kill-Cleanup → Transform-Commit → Checksum.
- **Befehle laufen nie direkt**: ein Dauer-Task liest den Queue-Kopf und
  pusht einen `CCommandTask` auf den Task-Stack. Rückgabewerte steuern das
  Scheduling (−1 = fertig, 0 = sofort nochmal, N = N−1 Ticks warten).
- **Wirtschaft = Request/Grant**: Verbraucher hängt `CEconRequest`
  (Bedarf pro Tick) in die Armee-Liste; Engine trägt `mGranted` ein;
  Bau/Reparatur nutzen die Ratio (Stall = Verlangsamung), Capture/Teleport
  warten auf volle Deckung.
  - Bau: `time = BuildTime / buildRate`; `energy_rate = BuildCostEnergy/time`;
    Fortschritt/Tick = `(buildRate / BuildTime) * 0.1 * ResourceConsumed`.
  - **Assist ist additiv**: effektive Rate = Σ buildRate der Helfer.
  - **Verteilung jetzt aus dem Binary** (`func_ArmyProcessEconomy` @ 0x771B50,
    in faf-re Stub) → [research/economy-binary.md](research/economy-binary.md):
    **zweistufig** — Verbraucher, die *beide* Ressourcen brauchen, laufen mit
    Ratio `r1 = min(1, min available/totalDemand)`; wer *nur eine* braucht,
    bekommt aus dem Rest eine eigene Ratio `r2` auf der Nicht-Engpass-Ressource.
    `mGranted` je Verbraucher; `LimitingRate = granted/requested` skaliert den
    Fortschritt *pro Bauwerk*. Unser aktueller Ein-Faktor-Stall ist zu simpel.
  - **Command→Task-Dispatch** (`DispatchTask` @ 0x608EF0) → 40 Befehlstypen
    ([research/command-dispatch-binary.md](research/command-dispatch-binary.md)).
  - **Bau-Task-Ablauf** komplett ([research/build-task-binary.md](research/build-task-binary.md)):
    `delta = (buildRate/BuildTime) * resourceConsumed * 0.1`, HP wächst linear
    mit dem Fortschritt, Fertigstellung → `OnStopBeingBuilt` (Lua) + Adjacency-
    Scan; `resourceConsumed` = `LimitingRate` aus der Econ-Verteilung (beide
    Systeme greifen ineinander).
  - Reclaim: `Ticks = max(BuildCostEnergy, BuildCostMass) / buildRate`.
  - Capture: `Ticks = max(1, ((BuildTime/buildRate)/2 * CaptureTimeMultiplier) * 10)`,
    Fortschritt += Anzahl Captors.
  - **Veterancy ist kill-basiert** (Default-Schwellen 25/100/250/500/1000):
    MaxHealth ×1.1…×1.5 (REPLACE aus bp-Basis), Regen +2…+10.
- **Decomp-Lücken (ehrlich):** Econ-Verteilungsroutine, der große
  `DispatchQueuedCommand`-Switch und die Build-Task-State-Machines sind
  **nicht** rekonstruiert → aus Lua + Aufrufern ableiten und **verifizieren**.

### 3.2 Waffen (Engine + Lua geteilt)
- Kern-Lua liegt in **mohodata.scd** (`sim/weapon.lua`, `sim/defaultweapons.lua`,
  `sim/DefaultDamage.lua`, `sim/CollisionBeam.lua`, `sim/DefaultProjectiles.lua`).
- **Feuertakt Engine-seitig, tick-quantisiert**: `fireClock = (int)(10 / RateOfFire)`
  → RateOfFire 3 ⇒ 3 Ticks = 0,30 s (effektiv 3,33/s), **nicht** 0,333 s.
- Engine ruft nur `weapon:OnFire()`; die **Salven-Zustandsmaschine** (Idle →
  RackSalvoCharge → FireReady → Firing → Reload, + Pack/Unpack) liegt in Lua.
- **Reichweite rein 2D (XZ)** gegen MaxRadius²/MinRadius², separat
  `|Δy| ≤ MaxHeightDiff` und HeadingArc.
- `TrackingRadius` ist ein **Multiplikator** von MaxRadius.
- Türme: `TurretYaw/PitchSpeed` [°/s] → `slew = speed * DEG2RAD * 0.1` je Tick;
  `FiringTolerance` [°] pro Achse.
- Projektile: Gravitation **(0, −4.9, 0)**; Defaults UseGravity=1, Lifetime=15,
  LeadTarget=1, TrackTarget=0; `MuzzleVelocity` überschreibt InitialSpeed
  (mit Gauss-Jitter + Nahbereichsdämpfung).
- **Schaden — jetzt direkt aus dem Binary rekonstruiert** (IDA; in faf-re ist
  `SIM_Damage` nur ein Stub) → [research/damage-binary.md](research/damage-binary.md):
  - **Kein Distanz-Falloff** (belegt): voller Betrag an jede Entity im Radius.
  - Formel: `effektiv = amount * ArmorMult(damageType) / (1 + Handicap)`
    — **Division**, nicht `*(1-Handicap)` wie zuvor angenommen.
  - Kategorie **`NOSPLASHDAMAGE`** ist immun gegen Flächenschaden.
  - Schild-Absorption wird **vor** dem Einzelschaden abgezogen.
  - Selbstschaden: Projektil wird auf seinen Launcher aufgelöst.
  - Health-Abzug/Tod passiert in **Lua** (`Unit.lua:OnDamage`), nicht in der Engine.
- Overkill: `overkillRatio > 1` ⇒ **kein Wrack**; Wrack-Masse =
  `BuildCostMass * Wreckage.MassMult * (1-overkill) * FractionComplete`.
- Schilde: Absorption = `min(shieldHP, amount*ArmorMult*(1-Handicap))`,
  Overspill via `PassOverkillDamage`; Regen startet nach `ShieldRegenStartTime`,
  jeder Treffer setzt ihn zurück.
- Beams: kein Projektil; `CollisionCheckInterval = BeamCollisionDelay * 10` Ticks.
- **Lücke:** `SIM_Damage` ist im Decomp ein Stub → Schadensausbringung aus
  Lua + Blueprint-Rechnung verifizieren.

### 3.3 Bewegung, Pfade, Kollision
- Einheiten: `MaxSpeed*0.1` = m/Tick; `MaxAcceleration*0.01` = m/Tick²;
  `TurnRate [°/s] * 0.0017453` = rad/Tick.
- **Passierbarkeits-Grid**: 1 Zelle = 1 Weltmeter (= Heightmap-Raster);
  Bitmaske `{LAND=1, SEABED=2, SUB=4, WATER=8, AIR=16, ORBIT=32}` aus
  Footprint (MaxSlope, Min/MaxWaterDepth, Size) + Heightmap + TerrainType +
  Struktur-Occupancy.
- **Slope ist kein Winkel**: max. absolute Höhendifferenz benachbarter Samples
  > `MaxSlope` (Standard **0.75**) ⇒ nicht befahrbar.
- Footprints global in `mohodata.scd:lua/footprints.lua` (20 Einträge).
- **Pathfinding**: hierarchisches A* (Cluster 1/8/32/128), pro Footprint-Typ
  eine ClusterMap, inkrementelles Update mit Frame-Budget; A* läuft in einer
  Armee-Queue; Heuristik = Octile × 1.01.
- **Repath** bei: Zielabstand > Schwelle, Layerwechsel, 30 Ticks ohne
  Positionsänderung; 3 Fehlschläge ⇒ Eskalation.
- **Ausweichen ist vorhersagebasiert** (keine Boids): Nachbarn im Radius,
  Spline-Vorwärtssimulation alle 3 Ticks, 2D-OBB-Überlappungstest.
  **Kein physikalisches Schieben** — nur Occupancy + Reservierung + Steering.
- Layer-Höhe: Land = Terrain (SnapToGround mittelt 4 Footprint-Ecken),
  Water = Wasserspiegel, Sub = Spiegel + (negatives) Elevation, Air = + Elevation.
- Schiffe: kein echter Tiefgang (Footprint-MinWaterDepth), Kurvenradius
  begrenzt die Geschwindigkeit; Bots (RotateOnSpot) fahren erst ab
  Heading-Alignment > 0.98 an.
- Luft: **kein Pathfinding** (direkt zum Ziel), Dämpfung + Bank/Lift-Faktoren.
- Formationen: `lua/formations.lua` (Offsets je Kategorie/Reihe), Slots werden
  auf freie Zellen gesnappt, Formationsgeschwindigkeit geregelt.

### 3.4 Intel (Radar/Sonar/Omni/Sicht)
- **Grids**: Vision 2 m/Zelle, alle anderen (Water, Radar, Sonar, Omni,
  Counter-Intel) 4 m/Zelle.
- `CIntelGrid` ist ein **int8-Zähler** (AddCircle +1 / SubtractCircle −1);
  sichtbar = Zelle ≠ 0. Radius→Zellen per **Ganzzahldivision**.
- Vision-Grid existiert nur bei FoW=on; ohne FoW ist alles sofort sichtbar.
- Handle-Update nur wenn Bewegung ≥ `radius*0.333` **oder** > 30 Ticks alt.
- Recon-Scheduling: **eine Armee pro Tick** (`tick % armyCount`).
- Flags: Radar/Sonar/Omni/LOSNow/LOSEver/KnownFake/MaybeDead;
  **LOSEver + KnownFake sind sticky**.
- **Ghost-Gebäude**: nicht mehr gesehene *unbewegliche* Units mit LOSEver
  bleiben als eingefrorener Blip (letzter bekannter Stand).
- **Jammer**: `Intel.JammerBlips` Fake-Blips mit zufälligem Offset im
  `JamRadius`; entlarvt durch Omni/LOS/Quellverlust.
- Client-FoW: zwei Grids je Armee — *Explored* (jemals gesehen) und *Fog*
  (aktuell sichtbar).

### 3.5 Effekte & Audio
- Emitter-Blueprints sind **Lua-DSL** (`EmitterBlueprint{…}`), 21 Kurven je
  Emitter; **Kurven-Auswertung**: linear interpolieren von y **und** z, dann
  `(rand()-0.5)*z + y` (z = Streubreite!). Zeiteinheit = Sim-Ticks.
- **Partikel-Physik steckt im Vertex-Shader** (`effects/particle.fx`):
  ohne Drag `pos = P0 + V·t + 0.5·A·t²`; mit Drag exponentiell. Farbe =
  Partikeltextur × Ramp (U = t/lifetime).
- BlendModes: 0=Alpha, 3=Add (häufigster), … ; 747 Partikeltexturen.
- Trails = Ribbons; Beams eigene Blueprints.
- Effekt-Templates: `lua/EffectTemplates.lua` (~586 Tabellen).
- **Audio = XACT**: `.xwb` (WBND) + `.xsb` (SDBK) — Header verifiziert.

### 3.6 Rendering (offene Features)
- **SCMAP-Schwanz jetzt vollständig dekodiert** (über 60/60 Karten bis EOF
  verifiziert): nach WaterMap folgen Foam/Flatness/DepthBias-Masken,
  TerrainType, (v60) Skybox, **Props-Liste** (bis **46.971 Props/Karte** ⇒
  Instancing zwingend).
- **39 von 60 Karten nutzen `TTerrain`** (nur 4 Strata, andere Licht-Formel) —
  wir rendern derzeit alle als TTerrainXP. Muss nach `terrainShader` verzweigen.
- Original-Terrain-Normale kommt aus einem **Deferred-Buffer** (Basis-Pass
  schreibt Geometrie- und Stratum-Normalen, `frame.fx` baut die TBN).
- Wasser: Fresnel = prozedurale 128×128-Lookup (`d·bias + (1−d·bias)(1−NdotV)^power`);
  WaterMap-Kanäle: **R=Flatness, G=Tiefe, B=Alphamaske, A=1−Foam**.
- Skycube-DDS = echte Cubemaps (DXT1 512², 6 Faces, keine Mips).
- Decals: Typ-Enum (1=Albedo, 2=Normals, …); Matrix = translate(−pos)·Ry·Rx·Rz·scale(1/s).
- LOD-Auswahl: erste LOD mit `cutoff ≤ 0` **oder** `distance ≤ cutoff`.
- Legacy-Shader-Aliase: `TMeshAlpha→NormalMappedAlpha`, `TMeshGlow→…`, `Team→Unit`
  (Props nutzen die alten Namen).

### 3.7 UI (Original-Struktur)
- **Container-Modell fehlt uns komplett**: `gamemain.lua:CreateUI()` baut über
  `borders.SetupBorderControl` vier Container — `controlClusterGroup` (unteres
  150-px-Band), `statusClusterGroup` (oberes Band), `mapGroup`, `windowGroup`.
  Alle Panels hängen daran. **Voraussetzung für originalgetreue Positionen.**
- **Baumenü** (`construction.lua`, 79 KB) ist das größte fehlende Element:
  3 Haupt-Tabs, 5 Sub-Tabs, 50-px-Icon-Grid, Bau-Queue, Infinite/Pause.
- Orders: Original hat **12 Slots** (wir: 6) + 9 Toggle-Caps.
- Cursors, Command-Feedback (Blips/Orderlines/Rally), Hotkeys
  (`keymap/defaultKeyMap.lua`) sind vollständig datengetrieben.

### 3.8 Netz, Replay, Save
- **Lockstep überträgt nur Befehle**: 24 Opcodes; Wire-Format
  `[u8 type][u16 size][payload]`; **kein Host-Relay** (Broadcast an alle,
  vollvermaschtes P2P).
- Desync-Erkennung: MD5 über Economy + dirty Entities + **kompletten
  MT19937-RNG-State** je Beat; 128-Beat-Ring.
- **Replay = mitgeschriebener Wire-Stream** (Bytes 1:1 wieder einspeisen).
- Session-Start über `SWldSessionInfo` (Karte, LaunchInfo, RNG-Seed) —
  identisch für MP, SP, Replay, Load.

### 3.9 Spiel-Rahmen
- Skirmish = **Single-Player-Hosting** über dieselbe Lobby (Protokoll „None").
- Sim-Init: `__blueprints` → `simInit.lua` → `ScenarioInfo` → `SetupSession()`
  (lädt `_save.lua` + `_script.lua`) → Armeen/Brains → `BeginSession()`
  (`OnPopulate`/`OnStart`).
- Map-Skript für Skirmish ist **minimal**; die Army-/ACU-Erzeugung steckt in
  `mohodata:lua/sim/ScenarioUtilities.lua`.
- **Victory**: `lua/victory.lua` — demoralization (=Assassination, Default),
  domination, eradication, sandbox; Poll alle 3 s, 15 s stabile Lage.
- Optionen/Prefs/Keybindings: alles Lua-Tabellen (`Game.prefs`).

---

## 4. Phasenplan

Jede Phase endet mit: Typecheck, `verify*.ts` gegen Originaldaten,
Verhaltens-/Screenshot-Test, Commit.

### Phase A — Lua-Fundament ✳ läuft
1. ✅ **FA-Lua-Transpiler** — 1316/1316 Skripte parsen (Gleis B).
2. **Lua 5.0.1 + GPG-Patches nach WASM** bauen (Gleis A) — beseitigt
   Semantik-Deltas (Integer-Subtyp, `arg`, `getn`).
3. **`moho`-API v1**: Entity/Unit-Basis, Globals, `class.lua` +
   `Blueprints.lua` booten; Missing-Method-Trap protokolliert Lücken.
4. **Meilenstein**: ACU entsteht über die Original-`Unit.lua`;
   `OnCreate`/`OnStopBeingBuilt` feuern; Werte kommen aus dem Original.

### Phase B — Kampf
5. Waffen-API + `defaultweapons.lua`-Zustandsmaschine, Fire-Clock
   (tick-quantisiert), Aiming/Slew, Zielerfassung.
6. Projektile (ballistisch/gelenkt/Beam), Kollision, `Damage`/`DamageArea`/
   `DamageRing` (kein Falloff!), Armor-Multiplikatoren, Overkill/Wracks.
7. Schilde (Absorption/Regen/Overspill).
8. **Meilenstein**: DPS/Reichweiten stimmen mit der Blueprint-Rechnung überein.

### Phase C — Aufbau
9. Task/Command-System (Queue-Semantik inkl. Patrol-Rotation), Engineering.
10. Passierbarkeits-Grid + hierarchisches A* + Steering/Avoidance + Formationen.
11. Fabriken, Bau-Queue, Assist (additiv), Reclaim, Repair, Capture, Upgrades;
    **UI**: Container-Modell + Baumenü + Build-Platzierung + Command-Feedback.
12. **Meilenstein**: kompletter Aufbau ACU → T2 spielbar.

### Phase D — Welt & Intel
13. Intel-Grids (Zähler-Semantik!), Blips, Ghosts, Jammer, FoW (Sim + Render).
14. Props (Instancing), Decals, TTerrain-Variante, Wasser voll (Fresnel-LUT,
    Cubemap), Partikel-System (Kurven + particle.fx-Port), Bau-/Wrack-Shader.
15. **Meilenstein**: Karte + Effekte sehen aus wie im Original.

### Phase E — Vollständigkeit
16. Luft/Marine (Layer-Physik, Transporte, U-Boote).
17. Audio (XACT-Parser → WebAudio).
18. Restliche UI (Score, Avatare, Chat, Tabs, Tooltips, Cursors, Hotkeys),
    Lobby/Menü, Optionen, **Victory Conditions**, Spielende.

### Phase F — Gegner, Netz, Kampagne
19. **KI**: AiBrain/Platoon-Bindings (57+47 Methoden) → Original-KI-Lua (83k LOC) läuft.
20. Lockstep (deterministische Trig!), Command-Stream, MD5-Checksummen, Replays.
21. Save/Load, Kampagne (ScenarioFramework, Objectives, 6 FA-Missionen).
22. **Meilenstein**: 1:1 spielbar — Skirmish vs. KI, Multiplayer, Kampagne, Mods.

---

## 5. Querschnitt
- **Determinismus**: eigener Seed-PRNG (MT19937 wie Original), Trig-Tabellen
  statt `Math.sin`, keine unsortierte Iteration; Regressionstest „2 Läufe
  bit-identisch" bleibt Pflicht.
- **Performance**: 1000-Unit-Benchmark ab Phase B (Lua-Callback-Overhead ist
  das Hauptrisiko); Sim in Web Worker; Instancing für Props/Units.
- **Verifikation**: `verify.ts` (Daten), `verify-lua.ts` (Skripte), künftig
  `verify-sim.ts` (Blueprint-Rechnung vs. Sim: DPS, Bauzeit, Reichweite).

## 6. Risiken (ehrlich)
| Risiko | Status / Gegenmaßnahme |
| --- | --- |
| Lua-Semantik (5.4 ≠ 5.0) | **Bestätigt gemessen** → Gleis A (eigener 5.0-Build) |
| Lua-Performance bei 1000+ Units | offen → früher Benchmark, Hot Paths in TS |
| Decomp-Lücken | **geschlossen: alle vier per IDA-MCP aus der FAF-Binary rekonstruiert** — SIM_Damage ([damage-binary.md](research/damage-binary.md)), Econ-Verteilung ([economy-binary.md](research/economy-binary.md)), Command-Dispatch ([command-dispatch-binary.md](research/command-dispatch-binary.md)), Bau-Tasks ([build-task-binary.md](research/build-task-binary.md)). Weitere Details bei Bedarf direkt aus der IDB. |
| Props/Partikel-Menge (46k Props, tausende Partikel) | Instancing + GPU-Partikel (Physik im Shader wie im Original) |
| XACT-Audioformat | Parser nötig; Referenz: Open-Source-XACT-Implementierungen |
| Rechtliches | unverändert: keine Assets/Code im Repo, BYO-Game ([LEGAL.md](LEGAL.md)) |
