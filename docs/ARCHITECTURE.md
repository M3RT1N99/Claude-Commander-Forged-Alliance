# Architektur

## Leitprinzipien

1. **Bring your own assets** — the app reads the original installation of the
   Users (Steam/GOG) local; the repo does not contain or distribute game data.
2. **Browser first** — a TypeScript core that also runs without changes
   Mobile (PWA/Capacitor) and desktop (Tauri) runs.
3. **Sim and representation strictly separated** — the simulation is
   deterministic and doesn't render anything; the renderer only reads sim state.
   This is a requirement for lockstep multiplayer (like in the original) and
   Replays.
4. **Original behavior for reference** — the reconstructed ones
   Moho engine sources (`faf-re`, ~91% recovered) and the Lua rules
   `lua.scd` define the target behavior (balance, formulas, path finding).

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

### Why no port from faf-re?

`faf-re` reconstructs the original C++ engine (MSVC8-ABI, Win32,
DirectX 9) — valuable as a **behavioral reference** (formulas, data structures,
Netcode semantics), but not directly portable: 32-bit ABI layouts,
D3D9 renderer, x87 floating point. An Emscripten port would be a
Mammoth project with unclear legal situation (derivative work of the binary).
Instead: re-implementation in TS with faf-re as a reference.

## Verifizierte Dateiformate

Details in [FORMATS.md](FORMATS.md). All parsers are against the real one
Installation tested (`scripts/verify.ts`): 568/568 unit blueprints,
638/638 LOD0 meshes, reference values ​​of UEL0001 exact.

## Plattform-Strategie

| Phase | Plattform | Technik |
| ----- | --------- | ------- |
| 1 | Browser (Desktop) | Vite + Three.js, File System Access API |
| 2 | Mobile | PWA or capacitor; DXT software decoder already exists (mobile GPUs cannot do S3TC); Touch UI |
| 3 | Linux/Windows | Tauri (nutzt dieselbe Web-Codebasis, nativer FS-Zugriff, GOG/Steam-Erkennung) |

Mobile Note: File access to the installation is not practical there
— an asset sync from the desktop (LAN, HTTP range source exists) is planned
already) or a one-time import into the Origin Private File System (OPFS).

## Determinismus-Plan (Sim-Kern)

- Fixed point arithmetic or consistent `Math.fround` for sim math
  (Float determinism across platforms; original uses x87 compatible FP)
- Sim tick: 10/s (original clock), renderer interpolated
- No iteration over unsorted maps in the sim path; own PRNG with seed
- Replays = start state + command stream (like original)

## Meilensteine

1. ✅ **M1 Unit Viewer**: VFS, SCM/BP/DDS parser, original shader look
2. **M2 Map Renderer**: SCMAP parser (heightmap, texture layers, water,
   Props), terrain shader port (`terrain.fx` is in effects.scd)
3. **M3 Animation**: SCA-Parser, Skinning (GPU), Idle/Walk-Zyklen
4. **M4 Sim Base**: Blueprint database, spawn/move units,
   Flowfield/Pathfinding, Befehls-Queue
5. **M5 Kampf & Wirtschaft**: Waffen, Projektile, Schaden, Mass/Energy,
   Build, upgrade chains
6. **M6 playability**: selection/commands/camera as in the original, minimap,
   Fog of War, einfache Skirmish-KI
7. **M7 Plattformen & Multiplayer**: Tauri-Builds, Mobile-UI,
   Lockstep-Netcode
