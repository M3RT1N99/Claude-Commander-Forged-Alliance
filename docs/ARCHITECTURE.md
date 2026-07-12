# Architektur

## Leitprinzipien

1. **Bring your own assets** — die App liest die Original-Installation des
   Users (Steam/GOG) lokal; das Repo enthält und verteilt keine Spieldaten.
2. **Browser zuerst** — ein TypeScript-Kern, der ohne Änderungen auch auf
   Mobile (PWA/Capacitor) und Desktop (Tauri) läuft.
3. **Sim und Darstellung strikt getrennt** — die Simulation ist
   deterministisch und rendert nichts; der Renderer liest nur Sim-Zustand.
   Das ist Voraussetzung für Lockstep-Multiplayer (wie im Original) und
   Replays.
4. **Original-Verhalten als Referenz** — die rekonstruierten
   Moho-Engine-Quellen (`faf-re`, ~91 % recovered) und die Lua-Regeln aus
   `lua.scd` definieren das Soll-Verhalten (Balance, Formeln, Pfadfindung).

## Schichten

```
┌────────────────────────────────────────────────────────┐
│ UI (HTML/CSS)  ·  Input  ·  Audio                      │
├────────────────────────────────────────────────────────┤
│ Renderer (Three.js/WebGL2)                             │
│   Units (SCM+DDS, mesh.fx-Port) · Terrain · Effekte    │
├────────────────────────────────────────────────────────┤
│ Sim-Kern (deterministisch, später im Web Worker)       │
│   Blueprints · Einheiten · Bewegung/Pathfinding ·      │
│   Waffen/Schaden · Wirtschaft (Mass/Energy-Flow)       │
├────────────────────────────────────────────────────────┤
│ Formate: scm · sca · dds/dxt · blueprint · scmap       │
├────────────────────────────────────────────────────────┤
│ VFS: SCD-Archive (Zip, Random-Access)                  │
├────────────────────────────────────────────────────────┤
│ GameSource: File System Access API │ webkitdirectory │ │
│             HTTP-Range (Dev/LAN)                       │
└────────────────────────────────────────────────────────┘
```

### Warum kein Port von faf-re?

`faf-re` rekonstruiert die originale C++-Engine (MSVC8-ABI, Win32,
DirectX 9) — wertvoll als **Verhaltensreferenz** (Formeln, Datenstrukturen,
Netcode-Semantik), aber nicht direkt portierbar: 32-bit-ABI-Layouts,
D3D9-Renderer, x87-Floating-Point. Ein Emscripten-Port wäre ein
Mammutprojekt mit unklarer Rechtslage (abgeleitetes Werk der Binary).
Stattdessen: Neuimplementierung in TS mit faf-re als Nachschlagewerk.

## Verifizierte Dateiformate

Details in [FORMATS.md](FORMATS.md). Alle Parser sind gegen die echte
Installation getestet (`scripts/verify.ts`): 568/568 Unit-Blueprints,
638/638 LOD0-Meshes, Referenzwerte des UEL0001 exakt.

## Plattform-Strategie

| Phase | Plattform | Technik |
| ----- | --------- | ------- |
| 1 | Browser (Desktop) | Vite + Three.js, File System Access API |
| 2 | Mobile | PWA oder Capacitor; DXT-Software-Dekoder existiert bereits (Mobile-GPUs können kein S3TC); Touch-UI |
| 3 | Linux/Windows | Tauri (nutzt dieselbe Web-Codebasis, nativer FS-Zugriff, GOG/Steam-Erkennung) |

Mobile-Hinweis: Dateizugriff auf die Installation ist dort nicht praktikabel
— geplant ist ein Asset-Sync vom Desktop (LAN, HTTP-Range-Quelle existiert
bereits) oder ein einmaliger Import ins Origin Private File System (OPFS).

## Determinismus-Plan (Sim-Kern)

- Festkomma-Arithmetik oder konsequentes `Math.fround` für Sim-Mathematik
  (Float-Determinismus über Plattformen; Original nutzt x87-kompatible FP)
- Sim-Tick: 10/s (Original-Taktung), Renderer interpoliert
- Keine Iteration über unsortierte Maps im Sim-Pfad; eigener PRNG mit Seed
- Replays = Startzustand + Befehlsstrom (wie Original)

## Meilensteine

1. ✅ **M1 Unit-Viewer**: VFS, SCM/BP/DDS-Parser, Original-Shader-Look
2. **M2 Karten-Renderer**: SCMAP-Parser (Heightmap, Texturlagen, Wasser,
   Props), Terrain-Shader-Port (`terrain.fx` liegt in effects.scd)
3. **M3 Animation**: SCA-Parser, Skinning (GPU), Idle/Walk-Zyklen
4. **M4 Sim-Basis**: Blueprint-Datenbank, Einheiten spawnen/bewegen,
   Flowfield/Pathfinding, Befehls-Queue
5. **M5 Kampf & Wirtschaft**: Waffen, Projektile, Schaden, Mass/Energy,
   Bauen, Upgrade-Ketten
6. **M6 Spielbarkeit**: Auswahl/Befehle/Kamera wie im Original, Minimap,
   Fog of War, einfache Skirmish-KI
7. **M7 Plattformen & Multiplayer**: Tauri-Builds, Mobile-UI,
   Lockstep-Netcode
