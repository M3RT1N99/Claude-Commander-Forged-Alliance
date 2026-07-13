# agent2

## Summary
Die Gameplay-Schicht von FA ist **echtes Lua 5.0.1 (PUC-Rio) mit GPG-gepatchtem Lexer** — bestätigt via Versions-String in bin/main.exe. Die Skripte benutzen `#` als Zeilenkommentar (299/460 Dateien), `!=` statt `~=` (556x), `!` als `not` (26x), sowie Lua-5.0-Semantik (`arg`-Varargs, `table.getn` 480x, `for k,v in t do` ohne pairs() 2039x). **Damit ist wasmoon (Lua 5.4) und fengari (5.3) für 1:1-Ausführung unbrauchbar** — beide scheitern bereits am Parsen praktisch jeder Datei. Klare Empfehlung: **Lua einbetten** (eigener Emscripten-Build von Lua 5.0.1 + 3 Lexer-Patches), und in TypeScript nur die *Engine* (`moho.*`, ~543 Sim-Bindings) nachbauen — denn diese Bindings müsstest du im Nachbau-Pfad ohnehin schreiben, während du dort zusätzlich 53k LOC Sim-Lua portierst und Mods + Kampagne + Skirmish-KI dauerhaft verlierst.

## Key Facts
- Engine-Lua ist Lua 5.0.1 (String '$Lua: Lua 5.0.1 Copyright (C) 1994-2003 Tecgraf, PUC-Rio' in bin/main.exe) — NICHT 5.1/5.3/5.4.
- GPG hat den Lua-Lexer gepatcht: '#' = Zeilenkommentar, '!=' = Ungleich (556 Vorkommen vs. nur 105x '~='), '!' = not (26x). Vanilla-Lua 5.0 parst das NICHT — ein eigener Build ist auch für den Einbett-Pfad zwingend.
- wasmoon (5.4) und fengari (5.3) sind ausgeschlossen: zusätzlich zu den Lexer-Extensions nutzen die Skripte Lua-5.0-only-Semantik — 'arg'-Varargs (106x), table.getn (480x), 'for k,v in TBL do' ohne pairs() (2039x), math.mod (42x).
- Gesamtumfang gamedata-Lua: 183.202 LOC (ohne Kommentare) — AI 83.723 / UI+MAUI 46.255 / Sim-Kern 28.658 / Unit-Skripte 13.473 / Projektile+Effekte+Props 6.309 / Kampagnen-Framework 4.784; dazu 28.718 LOC Map-/Kampagnen-Skripte unter maps/.
- Engine<->Lua-Grenze gesamt: ~490 Engine-Methoden (moho.*) + ~410 Engine-Globals + 183 On*-Callbacks; NUR für die Sim reduziert sich das auf 339 Methoden + 204 Globals = ~543 Bindings.
- 36 engine-seitige Basisklassen 'moho.<x>_methods'; davon ~15 sim-relevant (unit_, weapon_, projectile_, prop_, shield_, entity_, aibrain_, platoon_, navigator_, blip_, attacker_, CollisionBeamEntity, ScriptTask_, aipersonality_, PathDebugger_).
- Zweischichtiges Archiv-Layout: mohodata.scd (526 KB, 91 Dateien) = Engine-SDK-Basis (class.lua, Blueprints.lua, weapon.lua, defaultweapons.lua, Entity.lua); lua.scd (7,67 MB, 354 Dateien) = Spiel-Layer, der die Basis überlagert (z.B. lua/sim/Unit.lua: 3.757 B in mohodata vs. 142.533 B in lua.scd).
- Unit-Hierarchie: Unit (Class(moho.unit_methods), 246 Methoden, States Idle/Dead/Working) -> defaultunits.lua mit 31 Basisklassen (StructureUnit, FactoryUnit, AirFactoryUnit, LandFactoryUnit, SeaFactoryUnit, MobileUnit, AirUnit, LandUnit, SeaUnit, SubUnit, HoverLandUnit, WalkingLandUnit, ConstructionUnit, Shield*Unit, ...) -> je Fraktion ~28-30 Ableitungen (T*/A*/C*/S*) = ~118 Fraktionsklassen.
- Waffen: Weapon = Class(moho.weapon_methods) mit 39 Methoden; DefaultProjectileWeapon/DefaultBeamWeapon/KamikazeWeapon/BareBonesWeapon als State-Machine mit 8 States (IdleState, RackSalvoChargeState, RackSalvoFireReadyState, RackSalvoFiringState, RackSalvoReloadState, WeaponUnpackingState, WeaponPackingState, DeadState).
- Unit-Skripte hängen nur DÜNN an den Klassen: 568 Skripte, Ø 1.451 Bytes, 61% (345) enthalten KEINE einzige eigene Funktion (nur 'Class(TLandUnit){ Weapons = {...} }; TypeClass = X'); nur 42 Skripte >3 KB, 10 >8 KB (die ACUs: XSL0001 27,6 KB / URL0001 25,1 KB / UEL0001 22,2 KB / UAL0001 19,2 KB).
- Custom-Verhalten in Unit-Skripten konzentriert sich auf: Effekte/Emitter (72 Skripte), Threads (59), Animationen (45), State-Machines (43), Enhancements/ACU-Upgrades (9).
- Kampagne: In FA gibt es KEIN lua/sim/Ops. Das Framework sind 8 Dateien / 4.784 LOC: ScenarioFramework.lua (68 KB), SimObjectives.lua (63 KB), ScenarioPlatoonAI.lua (108 KB), ScenarioUtilities.lua (62 KB, in mohodata), TriggerManager.lua (60 KB), scenariotriggers.lua (16 KB), SinglePlayerLaunch.lua, cinematics.lua.
- Kampagnen-Inhalt: 6 FA-Missionen (X1CA_001..006) + Tutorial, 59 Lua-Dateien / 1.605 KB — je Mission ein *_script.lua (~130 KB) plus mehrere *_<m>ai.lua; dazu 21 Coop-Maps (X1MP_*) und 21,6 MB *_save.lua (Map-Unit-/Marker-Daten).
- Mod-System = Monkeypatching per Lua: Mods liefern 'hook/lua/<pfad>.lua', das nach der Basisdatei im selben Env läuft und die Klasse neu ableitet (Original-Beispiel schook/lua/sim/weapon.lua: 'local MohoWeapon = Weapon; Weapon = Class(MohoWeapon) { ... }'). Blueprints kennen zusätzlich Replace/'Merge = true'/ModBlueprints()-Hook. Mods 1:1 zu unterstützen heißt zwingend: fremdes Lua ausführen.
- Determinismus-Argument PRO Einbetten: alle Clients führen denselben WASM-Lua-Build aus, damit ist auch die Tabellen-Iterationsreihenfolge ('for k,v in t do') über alle Clients identisch — bei einem TS-Nachbau müsstest du diese Reihenfolge künstlich reproduzieren, sonst driftet der Lockstep.

## Details
## 1. Struktur & Schichtung

**Zwei Archive, zwei Schichten** (`lua.scd` überlagert `mohodata.scd`):

| Archiv | Größe | Dateien | Rolle |
|---|---|---|---|
| `mohodata.scd` | 526 KB (489 KB entpackt) | 91 | Engine-SDK-Basis |
| `lua.scd` | 7,67 MB (7,21 MB entpackt) | 354 | Spiel-Layer (überschreibt) |

Beweis der Überlagerung: `lua/sim/Unit.lua` existiert in **beiden** — 3.757 B in mohodata (nur `Class(moho.unit_methods)` mit leeren Callback-Stubs) vs. **142.533 B** in lua.scd (das echte Spiel-Unit). Umgekehrt liegen `lua/sim/weapon.lua` (19.922 B) und `lua/sim/defaultweapons.lua` (38.611 B) **nur** in mohodata — dort ist die echte Waffenlogik.

### lua/system/* — Kernsystem (mohodata)
- **`class.lua` (13.273 B)** — komplettes eigenes OO-System: `Class(Base1,Base2){...}` mit Mehrfachvererbung (`__bases`, `__spec`, `__index`), Ambiguitäts-Fehler bei Diamond, plus **`State{...}` / `ChangeState()`**: States sind Klassen, die von der Container-Klasse ableiten; `ChangeState` tauscht die Metatable des *Objekts*, killt den alten `Main`-Thread, ruft `OnExitState` → setmetatable → `OnEnterState` → forkt `Main`. Auch `ConvertCClassToLuaClass()` für Engine-C-Klassen.
- **`Blueprints.lua` (11.644 B)** — Pipeline: Engine scannt `.bp`-Dateien → diese rufen `UnitBlueprint()`/`PropBlueprint()`/`ProjectileBlueprint()`/`MeshBlueprint()`/`EmitterBlueprint()`/`BeamBlueprint()`/`TrailEmitterBlueprint()` → landen in `original_blueprints[group][id]` → dann `ModBlueprints(all_bps)` (Mod-Hook) → Engine registriert final; Sim- und User-Seite bekommen je eine eigene Kopie. Mod-Regeln: gleiche ID = Ersetzen; `Merge = true` = `table.merged`; `ModBlueprints()` hooken = beliebige Manipulation.
- **`import.lua` (2.383 B)** — Modulsystem: `import('/lua/x.lua')` erzeugt pro Modul ein Env mit `__index = _G`, cached in `__modules`, trackt Abhängigkeiten (`used_by`) für Hot-Reload (`dirty_module` am `__diskwatch`). **Das ist der Angelpunkt für Mod-Hooks.**
- Weiter: `trashbag.lua` (Ressourcen-Cleanup, `self.Trash:Add()`), `utils.lua`, `MultiEvent.lua`, `SingleEvent.lua`, `repr.lua`, `Localization.lua`, `saveload.lua`, `BuffBlueprints.lua`.

### Sim-Klassen
- `lua/sim/Entity.lua` (mohodata, 647 B): `Entity = Class(moho.entity_methods)` + `_c_CreateEntity(self,spec)` in `__init`.
- `lua/sim/Unit.lua` (lua.scd, **142.533 B, 246 Methoden**), States: `IdleState`, `DeadState`, `WorkingState`. Importiert Entity, defaultexplosions, EffectTemplates, EffectUtilities, game, utilities, **shield**, **Buff**, AIUtils. Enthält `SyncMeta` (Sim→UI-Sync-Tabelle über `Sync.UnitData[id]`).
- `lua/defaultunits.lua` (lua.scd, **65.968 B, 121 Methoden**) — **31 Basisklassen**:
  - `Unit` → `StructureUnit` → `FactoryUnit` → `AirFactoryUnit` / `LandFactoryUnit` / `SeaFactoryUnit` / `QuantumGateUnit`
  - `StructureUnit` → `AirStagingPlatformUnit`, `ConcreteStructureUnit`, `EnergyCreationUnit`, `EnergyStorageUnit`, `MassCollectionUnit`, `MassFabricationUnit`, `MassStorageUnit`, `RadarUnit`, `RadarJammerUnit`, `SonarUnit`, `ShieldStructureUnit`, `TransportBeaconUnit`, `WallStructureUnit`
  - `Unit` → `MobileUnit` → `WalkingLandUnit`, `SubUnit`, `AirUnit`, `HoverLandUnit`, `LandUnit`, `ConstructionUnit`, `SeaUnit`; dazu `ShieldHoverLandUnit`/`ShieldLandUnit`/`ShieldSeaUnit`
  - States hier: `IdleState`, `UpgradingState`, `BuildingState`, `RollingOffState`
- Fraktions-Layer: `terranunits.lua` (30 Klassen), `aeonunits.lua` (28), `cybranunits.lua` (28), `seraphimunits.lua` (28) — reine Ableitungen `T*`/`A*`/`C*`/`S*` + Fraktions-FX/Build-Animationen.
- `lua/sim/weapon.lua` (mohodata, 19.922 B): `Weapon = Class(moho.weapon_methods)`, **39 Methoden** (SetupTurret, Aim-Manipulatoren, GetDamageTable, CreateProjectileForWeapon, SetWeaponPriorities, Buff-Handling …).
- `lua/sim/defaultweapons.lua` (mohodata, 38.611 B): `DefaultProjectileWeapon`, `KamikazeWeapon`, `BareBonesWeapon`, `DefaultBeamWeapon` — **State-Machine mit 8 States**: `IdleState`, `RackSalvoChargeState`, `RackSalvoFireReadyState`, `RackSalvoFiringState`, `RackSalvoReloadState`, `WeaponUnpackingState`, `WeaponPackingState`, `DeadState`. Fraktions-Waffen: `terranweapons.lua`, `aeonweapons.lua`, `cybranweapons.lua`, `seraphimweapons.lua`.
- `lua/shield.lua` (17.454 B): `Shield = Class(moho.shield_methods, Entity)` → `UnitShield`, `AntiArtilleryShield`.
- `lua/sim/Buff.lua` (20.961 B) + `BuffDefinitions.lua`, `sim/AdjacencyBuffs.lua` (**60.459 B!**), `AdjacencyBuffFunctions.lua`, `CheatBuffs.lua`, `OpBuffDefinitions.lua` — Buff-System inkl. Adjazenz-Boni.
- Projektile: `lua/sim/Projectile.lua` (17.416 B, `Class(moho.projectile_methods, Entity)`), `lua/sim/DefaultProjectiles.lua` (mohodata) mit `NullShell`, `EmitterProjectile`, `Single/MultiBeamProjectile`, `Single/MultiPolyTrailProjectile`, `Single/MultiCompositeEmitterProjectile`, `OnWaterEntryEmitterProjectile`; Fraktions-Projektile `aeon-/cybran-/terran-/seraphimprojectiles.lua` (30–37 KB je).
- `lua/defaultcollisionbeams.lua` (21.692 B): 16 Beam-Klassen (Ginsu, ParticleCannon, PhasonLaser, TractorClaw, OrbitalDeathLaser …).
- Effekte: `lua/EffectTemplates.lua` (**180.301 B** — reine Datentabellen), `EffectUtilities.lua` (56.566 B), `defaultexplosions.lua`.

## 2. Wie tief hängen Unit-Skripte an den Klassen? — **Sehr dünn.**

568 `*_script.lua` in `units.scd`, zusammen nur **804,8 KB / 13.473 LOC**, Ø **1.451 Bytes**.

| Bucket | Anzahl |
|---|---|
| ≤ 1 KB (rein deklarativ) | 362 (64%) |
| 1–3 KB | 164 |
| 3–8 KB | 32 |
| > 8 KB (schweres Custom) | 10 |
| **0 eigene Funktionen** | **345 (61%)** |

Typisches Skript (`units/UEL0201/UEL0201_script.lua`, 683 B) ist vollständig deklarativ:
```
local TLandUnit = import('/lua/terranunits.lua').TLandUnit
local TDFGaussCannonWeapon = import('/lua/terranweapons.lua').TDFGaussCannonWeapon
UEL0201 = Class(TLandUnit) { Weapons = { MainGun = Class(TDFGaussCannonWeapon) {} }, }
TypeClass = UEL0201
```
`TypeClass` ist der Export, den die Engine liest. Das Skript wählt also nur **Basisklasse + Waffenklassen**; alles Verhalten kommt aus `defaultunits.lua` / `<faction>units.lua` / `defaultweapons.lua`, alle Werte aus dem `_unit.bp`.

Was die Skripte, die *doch* Code haben, tun: Effekte/Emitter (72), Threads `ForkThread`/`WaitSeconds` (59), Animationen `PlayAnim`/`CreateAnimator` (45), eigene State-Machines (43), Enhancements/ACU-Upgrades (9). Die 10 schweren sind praktisch nur die Commander: `XSL0001` 27,6 KB, `URL0001` 25,1 KB, `UEL0001` 22,2 KB, `UAL0001` 19,2 KB, dann `URL0301`/`XSL0301` (SACUs), `URL0402`, `XRL0403`, `UEL0301`, `UAL0301`.

Daneben: 568 `*_unit.bp` (4,5 MB) mit allen Zahlenwerten.

## 3. Engine↔Lua-Grenze (Umfang)

**Engine → Lua (Callbacks):** **183 distinkte `On*`-Handler** im Korpus definiert — u.a. `OnPreCreate`, `OnCreate`, `OnStartBeingBuilt`, `OnStopBeingBuilt`, `OnDamage`, `OnKilled`, `OnDestroy`, `OnCollisionCheck`, `OnCollisionCheckWeapon`, `OnImpact`, `OnMotionHorzEventChange`/`Vert`/`Turn`, `OnLayerChange`, `OnTerrainTypeChange`, `OnAdjacentTo`/`OnNotAdjacentTo`, `OnStartBuild`/`OnStopBuild`, `OnStartReclaim`/`OnStopReclaim`, `OnStartCapture`/`OnStopCapture`, `OnTransportAttach`/`OnTransportDetach`, `OnVeteranLevel`, `OnShieldEnabled`/`OnShieldDisabled`, `OnNukeLaunched`, `OnIntelEnabled`/`OnIntelDisabled`, `OnEnterState`/`OnExitState`, `OnAnimationFinished`, `OnWeaponFired`, `OnGotTarget`/`OnLostTarget`, `OnRunOutOfFuel`, `OnEnterWater`/`OnExitWater`, `OnTeleportUnit`, …

**Lua → Engine:**

| Fläche | Gesamt | **nur Sim** |
|---|---|---|
| Methoden auf Engine-Objekten (`moho.*`) | **490** | **339** |
| Globale Engine-Funktionen | **410** | **204** |
| **Summe** | **900** | **≈ 543** |
| Engine-Basisklassen `moho.<x>_methods` | **36** | **≈ 15** |

(Ermittelt: alle `:Method(`-Aufrufe bzw. Capitalized-Globals im gesamten Korpus minus alles, was irgendwo in Lua definiert wird.)

Meistgenutzte Engine-Methoden: `GetBlueprint` (742x), `GetArmy` (426), `Hide` (227), `SetNeedsFrameUpdate` (225), `SetTurnRate` (199), `SetAlpha` (187), `Show`, `SetSpeed`, `SetTargetSpeed`, `SetRate`, `SetGoal`, `SetVelocity`, `BeenDestroyed`, `IsUnitState`, `CreateProjectile`, `PlayAnim`, `GetCurrentLayer`, `HideBone`, `SetCollisionShape`, `TrackTarget`, `PlaySound`, `SetMesh` …

Meistgenutzte Engine-Globals: `EntityCategoryContains` (277x), `Random` (218), `CreateAttachedEmitter` (204), `LOG`, `CreateRotator` (124), `PlaySound`, `KillThread`, `ParseEntityCategory` (91), `WaitTicks` (86), `CreateEmitterAtEntity`, `VDist2`, `Vector`, `CreateAnimator`, `IssueClearCommands`, `DamageArea` (54), `EntityCategoryFilterDown`, `CreateSlider`, `CreateDecal`, `Warp`, `CreateLightParticle`, `GetSurfaceHeight`, `DamageRing`, `IssueMove`, `TrashBag`, `AttachBeamEntityToEntity`, `SimCallback`, `GetGameTimeSeconds` …

Sim-relevante `moho`-Klassen: `unit_methods`, `weapon_methods`, `projectile_methods`, `prop_methods`, `shield_methods`, `entity_methods`, `aibrain_methods`, `platoon_methods`, `navigator_methods`, `blip_methods`, `attacker_methods`, `CollisionBeamEntity`, `ScriptTask_Methods`, `aipersonality_methods`, `PathDebugger_methods`. Der Rest (`control_`, `bitmap_`, `text_`, `edit_`, `group_`, `lobby_`, `cursor_` …) ist UI/MAUI.

## 4. Kampagne

**Es gibt kein `lua/sim/Ops` in FA** (verifiziert: kein Treffer in lua.scd/mohodata.scd/mods.scd/schook.scd). Das Kampagnen-Framework liegt flach in `lua/`:

| Datei | Größe |
|---|---|
| `lua/ScenarioPlatoonAI.lua` | 108.459 B |
| `lua/ScenarioFramework.lua` | 68.018 B |
| `lua/SimObjectives.lua` | 63.160 B |
| `lua/sim/ScenarioUtilities.lua` (mohodata) | 62.027 B |
| `lua/TriggerManager.lua` | 60.192 B |
| `lua/scenariotriggers.lua` | 15.940 B |
| `lua/SinglePlayerLaunch.lua` | 11.362 B |
| `lua/TauntManager.lua`, `lua/cinematics.lua` | 12,3 / 6,2 KB |

Framework gesamt: **8 Dateien / 4.784 LOC** — überschaubar.

**Inhalt:** 6 FA-Missionen `X1CA_001..006` + `X1CA_TUT`, zusammen **59 Lua-Dateien / 1.605 KB**. Je Mission: ein `X1CA_00N_script.lua` (~131 KB!), ein `_operation.lua`, ein `_scenario.lua`, `_strings.lua` (64 KB Texte) und 3–5 Missions-AI-Dateien (`_m1orderai.lua` 37,7 KB, `_m4seraphimai.lua` 22,4 KB …). Dazu 21 Coop-Maps (`X1MP_*`, 28 Dateien / 20 KB) und 80 Skirmish-Maps (`SCMP_*`, 61 KB). Separat: **61 `*_save.lua` mit 21,6 MB** Map-Daten (Units, Marker, Armeen) — reine Datentabellen, aber als Lua ausgeführt.

Map-/Kampagnen-Lua gesamt: **28.718 LOC**.

## 5. Mod-System (entscheidend für die Empfehlung)

Zwei Wege, beide **erfordern das Ausführen fremden Lua-Codes**:
1. **Blueprint-Ebene** (deklarativ, portierbar): ID-Replace, `Merge = true`, oder `ModBlueprints(all_bps)`-Hook.
2. **Script-Hooks** (Code, NICHT portierbar): Mod legt `hook/lua/<originalpfad>.lua` ab; die Datei läuft nach dem Original im selben Modul-Env und leitet die Klasse neu ab. Original-Beleg — `schook/lua/sim/weapon.lua` aus `schook.scd`:
   ```
   local MohoWeapon = Weapon
   Weapon = Class(MohoWeapon) { GetDamageTable = function(self) ... end, }
   ```
   Das ist Monkeypatching über `Class()` + das `import.lua`-Env. `schook.scd` selbst nutzt genau diesen Mechanismus für 8 Dateien (`sim/weapon.lua`, `simInit.lua`, `SimSync.lua`, `UserSync.lua`, `maui/window.lua` …). Mod-Verwaltung: `lua/mods.lua` (15.749 B, mohodata) mit `GetGameMods()`, `GetUiMods()`, `GetCampaignMods()`, `GetDependencies()`.

**Konsequenz:** Ein reiner TS-Nachbau kann Script-Mods prinzipiell nicht laden — sie sind Lua, das exakt gegen `Class`, `import`, `Weapon`, `Unit` und die `moho.*`-Signaturen programmiert ist.

## 6. Aufwandsvergleich & Empfehlung

### Weg A — **Lua einbetten** (empfohlen)
**Schritte:**
1. **Eigener Lua-Build → WASM.** wasmoon/fengari fallen aus (5.4/5.3). Vanilla Lua 5.0.1 (~13k LOC C, klein, gut verstanden) mit 3 Lexer-Patches in `llex.c`: `#` als Zeilenkommentar, `!=` → `TK_NE`, `!` → `TK_NOT`. Danach parsen die Original-Skripte **unverändert**. Emscripten-Build. Aufwand: ~1–2 Wochen inkl. JS-Bridge.
2. **`moho.*`-Bindings in TypeScript**: ~543 Sim-Funktionen (339 Methoden + 204 Globals) — das ist die eigentliche Arbeit, aber **im Nachbau-Pfad exakt genauso nötig**, denn das sind Physik, Pathfinding, Kollision, Ökonomie-Tick, Animationen, Emitter, Rendering.
3. Sim-Init-Kette nachziehen: `globalInit.lua` → `SessionInit.lua` → `simInit.lua` → `Blueprints.lua`-Pipeline → `import.lua`.

**Was du geschenkt bekommst:** 28.658 LOC Sim-Kern, 13.473 LOC Unit-Skripte, 6.309 LOC Projektile/Effekte, 4.784 LOC Kampagnen-Framework, **83.723 LOC Skirmish-KI**, 28.718 LOC Kampagnen-/Map-Skripte — **und alle Mods**. Balance und Verhalten sind per Konstruktion 1:1, weil es *derselbe Code* ist.

### Weg B — **In TypeScript nachbauen**
- Die 543 Engine-Bindings musst du **trotzdem** bauen (sie sind die Engine).
- **Zusätzlich**: ~53.200 LOC Sim-Lua nach TS portieren (Unit 246 Methoden, defaultunits 121, Weapon 39 + 8-State-Machine, Shields, Buffs inkl. 60 KB Adjacency, 4 Fraktions-Layer, 568 Unit-Skripte, 16 Beam-Klassen, Projektil-Hierarchie).
- Plus eigenes `Class`/`State`-System mit Mehrfachvererbung nachbilden.
- Plus 83.723 LOC KI und 28.718 LOC Kampagne, wenn die je kommen sollen.
- **Mods: dauerhaft verloren.**
- Jede subtile Verhaltensabweichung (Rundung, Iterationsreihenfolge, Tick-Semantik) ist ein eigener Bug.

**Weg B ist eine echte Obermenge von Weg A.** Weg A ist strikt weniger Arbeit *und* liefert mehr.

### Zusatzargument: Determinismus
`for k,v in t do` (2.039 Vorkommen) iteriert in Lua-5.0-Hash-Reihenfolge. Wenn alle Clients denselben WASM-Lua-Build fahren, ist diese Reihenfolge über alle Clients **identisch** → Lockstep hält. Bei einem TS-Nachbau müsstest du die Iterationsreihenfolge künstlich reproduzieren oder jede betroffene Stelle auf deterministische Sortierung umbauen — sonst driftet die Simulation.

### Hybrid-Fallstrick, den du vermeiden solltest
"wasmoon + Transpiler 5.0→5.4" wirkt verlockend, ist aber die schlechteste Option: du brauchst einen kompletten Lua-5.0-Parser (für `#`, `!=`, `!`, `arg`, `table.getn`, `math.mod`), musst `for k,v in t do` → `pairs(t)` umschreiben und handelst dir damit **genau die Iterationsreihenfolgen-Divergenz** ein, die den Lockstep bricht — und Mods müsstest du zur Ladezeit ebenfalls durch den Transpiler jagen. Der Patch an Lua 5.0.1 ist deutlich kleiner und semantisch exakt.

### Empfohlene Reihenfolge
1. Lua 5.0.1+Patches → WASM, `import`/`Class`/`Blueprints` booten, ein Blueprint laden.
2. `moho.entity_methods` + `moho.unit_methods` minimal (Position, Bones, Health, GetBlueprint) → erste Unit erscheint und wird von Original-Lua gesteuert.
3. Bindings inkrementell nach Nutzungsfrequenz (Liste oben nach Call-Count) ausbauen — `GetBlueprint`/`GetArmy`/`Hide`/`SetNeedsFrameUpdate` zuerst.
4. Weapon-Bindings + `CreateProjectile` → Kampf.
5. KI und Kampagne kommen dann ohne weitere Portierarbeit dazu.

## Refs
- C:\Program Files (x86)\Steam\steamapps\common\Supreme Commander Forged Alliance\bin\main.exe (16.714.240 B) — enthält '$Lua: Lua 5.0.1 Copyright (C) 1994-2003 Tecgraf, PUC-Rio'
- C:\Program Files (x86)\Steam\steamapps\common\Supreme Commander Forged Alliance\bin\MohoEngine.dll (9.827.584 B)
- gamedata/lua.scd (7.671.907 B; 354 Lua-Dateien, 7,21 MB entpackt) — Spiel-Layer
- gamedata/mohodata.scd (526.529 B; 91 Dateien, 489 KB) — Engine-SDK-Basis
- gamedata/units.scd (1.114.843.505 B) — 568 *_script.lua (804,8 KB) + 568 *_unit.bp (4,5 MB)
- gamedata/schook.scd (25.568 B) — 8 Hook-Dateien; Beleg für Mod-Monkeypatching
- gamedata/mods.scd (1.239.705 B)
- mohodata.scd :: lua/system/class.lua (13.273 B) — Class()/State()/ChangeState(), Mehrfachvererbung
- mohodata.scd :: lua/system/Blueprints.lua (11.644 B) — Blueprint-Pipeline + ModBlueprints()/Merge
- mohodata.scd :: lua/system/import.lua (2.383 B) — Modul-Env, Dependency-Tracking, Hot-Reload
- mohodata.scd :: lua/sim/Unit.lua (3.757 B) — Basis-Stub Class(moho.unit_methods)
- mohodata.scd :: lua/sim/Entity.lua (647 B) — Class(moho.entity_methods)
- mohodata.scd :: lua/sim/weapon.lua (19.922 B, 39 Methoden)
- mohodata.scd :: lua/sim/defaultweapons.lua (38.611 B) — 8-State-Waffen-FSM
- mohodata.scd :: lua/sim/DefaultProjectiles.lua (7.453 B)
- mohodata.scd :: lua/sim/CollisionBeam.lua (11.227 B)
- mohodata.scd :: lua/sim/ScenarioUtilities.lua (62.027 B)
- mohodata.scd :: lua/mods.lua (15.749 B) — GetGameMods/GetUiMods/GetCampaignMods
- mohodata.scd :: lua/simInit.lua (9.510 B)
- mohodata.scd :: lua/system/trashbag.lua (1.221 B)
- lua.scd :: lua/sim/Unit.lua (142.533 B, 246 Methoden, States Idle/Dead/Working)
- lua.scd :: lua/defaultunits.lua (65.968 B, 31 Basisklassen, 121 Methoden)
- lua.scd :: lua/terranunits.lua (29.457 B) / seraphimunits.lua (28.549) / cybranunits.lua (21.194) / aeonunits.lua (11.829)
- lua.scd :: lua/shield.lua (17.454 B) — Shield/UnitShield/AntiArtilleryShield
- lua.scd :: lua/sim/Buff.lua (20.961 B) + lua/sim/AdjacencyBuffs.lua (60.459 B)
- lua.scd :: lua/sim/Projectile.lua (17.416 B)
- lua.scd :: lua/defaultcollisionbeams.lua (21.692 B) — 16 Beam-Klassen
- lua.scd :: lua/EffectTemplates.lua (180.301 B) + lua/EffectUtilities.lua (56.566 B)
- lua.scd :: lua/aibrain.lua (169.471 B) + lua/platoon.lua (130.780 B) + lua/basetemplates.lua (1.166.619 B) — Skirmish-KI
- lua.scd :: lua/ScenarioPlatoonAI.lua (108.459 B), lua/ScenarioFramework.lua (68.018 B), lua/SimObjectives.lua (63.160 B), lua/TriggerManager.lua (60.192 B)
- schook.scd :: schook/lua/sim/weapon.lua (2.154 B) — Hook-Pattern 'local MohoWeapon = Weapon; Weapon = Class(MohoWeapon){...}'
- units.scd :: units/UEL0201/UEL0201_script.lua (683 B) — typisches deklaratives Unit-Skript
- units.scd :: units/XSL0001/XSL0001_script.lua (27.639 B) — größtes Unit-Skript (Seraphim-ACU)
- maps/X1CA_001/ — X1CA_001_script.lua (131.389 B), _m1orderai.lua (37.740 B), _strings.lua (64.603 B), _save.lua (2.343.934 B)
- maps/ — 61 Maps: 6 Kampagne (X1CA_001..006) + Tutorial + 21 Coop (X1MP_*) + 80 SCMP-Skirmish-Lua; Map-Lua gesamt 28.718 LOC
