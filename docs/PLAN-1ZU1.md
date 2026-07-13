# Plan: 1:1-Spielbarkeit — was aus der Engine übernommen ist und was fehlt

> **Überholt durch [MASTERPLAN.md](MASTERPLAN.md)** (vollständige Inventur,
> Lua-Einbettungs-Entscheidung, Phasen A–F). Dieses Dokument bleibt als
> Kurzüberblick über den Asset-/Render-Stand.

Ziel: Forged Alliance im Browser **1:1 wie im Original** spielen. Referenz
ist die rekonstruierte Moho-Engine (faf-re, `src/sdk/moho/*`) plus die
Original-Daten (lua.scd, mohodata.scd, Blueprints, Shader). Wir übernehmen
Verhalten/Werte/Look exakt; nur die Architektur (TypeScript, WebGL,
eigene deterministische Sim) ist neu.

Stand: 2026-07-12. ✅ = übernommen & verifiziert · 🔶 = teilweise ·
❌ = fehlt noch.

## Übernommen (mit Quelle)

| Bereich | Engine-Subsystem | Stand bei uns |
| --- | --- | --- |
| VFS/Archive (SCD=Zip, case-insensitiv) | `resource` | ✅ Random-Access-Zip, alle Archive gemountet |
| SCM-Meshes, Bones, Bindpose | `mesh`, `animation` | ✅ Parser + numerisch verifizierte Konventionen |
| SCA-Animationen + Playback-Semantik | `animation` (RScaResource, CAnimationManipulator) | ✅ 474/474; Slerp statt NLERP (visuell identisch) |
| Blueprints (deklaratives Lua) | `script`/LuaPlus | ✅ eigener Parser, 568/568 Unit-BPs |
| Mesh-/Textur-Auflösung je LOD | `resource` (RMeshBlueprintLOD::Init 0x00518870) | ✅ 1:1 inkl. MeshBlueprint/Placeholder |
| Unit-Shader | mesh.fx: NormalMappedPS, **UnitFalloffPS (Seraphim)** | ✅ portiert; ❌ Aeon/Insect/PBR-Varianten, Wracks, Bau-Shader |
| SCMAP + Terrain-Splatting | `terrain` (CWldMap, HighFidelityTerrain, terrain.fx) | ✅ 60/60 Karten; ❌ Stratum-Normals, Decals, Props, Skirts |
| Wasser | water2.fx (HighFidelityPS) | 🔶 Komposition portiert; ❌ Wellen-Normalmaps, Sky-Cubemap, Refraktion |
| Sim-Grundlage (10-Hz-Ticks, deterministisch) | `sim` | ✅ f32/fround, bit-identische Läufe |
| Bewegung (MaxSpeed/TurnRate/Accel/Brake) | `sim`/`unit` | 🔶 Modell ja; ❌ exakte Original-Integration aus faf-re nachziehen |
| Steuerung + Kamera | `ui`/CameraImpl-Verhalten | ✅ SupCom-Schema (Zoom-zum-Cursor, Pitch-Kopplung, Box-Selektion) |
| HUD (mini-Layout) | lua/ui/game/layouts | ✅ Economy/Orders/UnitView/Minimap; ❌ Rest s. u. |
| Economy-Basis | `sim` | 🔶 Einkommen/Storage je Armee; ❌ Verbrauch/Stall/Baukosten |

## Fehlt für 1:1-Spielbarkeit (nach Engine-Subsystem, priorisiert)

1. **UI komplett** (`ui`, lua/ui/game): 🔶 **Strategic Icons (jetzt in Arbeit)**,
   Score-Panel/Uhr, Avatare, Multifunction-Tabs, Economy-Warn-Overlays,
   Tooltips, Command-Feedback (Waypoint-Linien aus `commandgraph`), Cursor.
2. **Economy voll** (`sim`): **(jetzt in Arbeit)** Baukosten, Verbrauch
   (Maintenance), Mass-Spots/Extraktoren, Stall-Verhalten, Overflow/Teams.
3. **Waffen/Schaden** (`unit/weapon`, `projectile`, lua DefaultWeapons):
   RackSalvo-Zustandsmaschine, Turm-Aiming (TurretYaw/Pitch), Projektile
   (ballistisch/gelenkt), DamageArea, Tod/Wracks. → nächster großer Block.
4. **Bauen/Fabriken** (`sim`, `task`): BuildRate, Baufortschritt,
   Fabrik-Queues, Assist, Reclaim, Repair, Capture, Upgrades, Enhancements.
5. **Pathfinding/Kollision** (`path`, `collision`): Passierbarkeits-Grid aus
   Terrain (Steigung/Wasser), Formationen, Ausweichen; Layer Land/Wasser/Luft.
6. **Intel** (`vision`): Radar/Sonar/LoS, Fog of War, Stealth/Cloak,
   Blips (recon rings im UI).
7. **Luft & Marine** (`sim`): Flugphysik (Höhe, Wenden), Marine-Tiefgang,
   Transporte, Träger.
8. **Schilde/Specials** (`unit`): Schild-Shader (ShieldSeraphimPS bereits
   gelesen), Overcharge, Teleport, Nukes/TML mit Silo-Bau.
9. **Effekte/Sound** (`effects`, `particles`, `audio`): Emitter (lua
   /effects), Mündungsfeuer, Explosionen, Tracks; Sound aus XACT-Banken
   (Format-Recherche nötig).
10. **Lua-Sim-Schicht** (`script`): Original-Skripte (Unit.lua, Weapon.lua)
    laufen im Original in LuaPlus — Entscheidung: nachbauen (bisheriger Weg)
    vs. echtes Lua einbetten (wasmoon) für Mods/Kampagne.
11. **KI** (`ai`): Skirmish-KI (Platoons, Builder) — sehr groß, spät.
12. **Multiplayer/Replays** (`net`): Lockstep (Trig-Determinismus fixen),
    Command-Streams; Kampagne (`sim`-Ops) danach.

## Reihenfolge (User-Testbarkeit zuerst)

1. ✅→ **Strategic Icons** (dieser Schritt)
2. **Eco testbar** (dieser Schritt): Mass-Spots, Extraktor/Pgen mit
   Baukosten & Verbrauch, Expense-Anzeige
3. Waffen & Schaden → 4. Bauen/Fabriken → 5. Pathfinding →
6. Intel/FoW → 7. Score/restliche UI → 8. Luft/Marine → 9. Effekte/Sound →
10. Schilde/Specials → 11. KI → 12. Netz/Replays
