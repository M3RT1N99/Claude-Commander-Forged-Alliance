# Architecture

## Guiding principles

1. **Bring your own assets** — the app reads the user's original Steam/GOG
   installation locally; the repository contains and distributes no game data.
2. **Browser first** — a TypeScript core that also runs unchanged on mobile
   (PWA/Capacitor) and desktop (Tauri).
3. **Sim and rendering strictly separated** — the simulation is deterministic
   and renders nothing; the renderer only reads Sim state. This is a
   prerequisite for lockstep multiplayer (as in the original) and replays.
4. **Original behavior as the reference** — the reconstructed Moho engine
   sources (`faf-re`, ~91 % recovered) and the Lua rules in `lua.scd` define
   the intended behavior (balance, formulas, pathfinding).

## Layers

```
┌────────────────────────────────────────────────────────┐
│ UI (HTML/CSS)  ·  Input  ·  Audio                      │
├────────────────────────────────────────────────────────┤
│ Renderer (Three.js/WebGL2)                             │
│   Units (SCM+DDS, mesh.fx port) · Terrain · Effects    │
├────────────────────────────────────────────────────────┤
│ Sim core (deterministic, later in a Web Worker)        │
│   Blueprints · Units · Movement/pathfinding ·           │
│   Weapons/damage · Economy (Mass/Energy flow)           │
├────────────────────────────────────────────────────────┤
│ Formats: scm · sca · dds/dxt · blueprint · scmap       │
├────────────────────────────────────────────────────────┤
│ VFS: SCD archives (Zip, random access)                 │
├────────────────────────────────────────────────────────┤
│ GameSource: File System Access API │ webkitdirectory │ │
│             HTTP range (development/LAN)                │
└────────────────────────────────────────────────────────┘
```

### Why not port faf-re?

`faf-re` reconstructs the original C++ engine (MSVC8 ABI, Win32, DirectX 9).
It is valuable as a **behavioral reference** (formulas, data structures,
netcode semantics), but cannot be ported directly: 32-bit ABI layouts, the
D3D9 renderer, and x87 floating point. An Emscripten port would be a massive
project with an unclear legal status (a derivative work of the binary).
Instead, this project is a TypeScript reimplementation that uses faf-re as a
reference.

## Verified file formats

See [FORMATS.md](FORMATS.md) for details. All parsers are tested against the
real installation (`scripts/verify.ts`): 568/568 unit blueprints, 638/638 LOD0
meshes, and exact reference values for UEL0001.

## Platform strategy

| Phase | Platform | Technology |
| ----- | -------- | ---------- |
| 1 | Browser (desktop) | Vite + Three.js, File System Access API |
| 2 | Mobile | PWA or Capacitor; a DXT software decoder already exists (mobile GPUs cannot use S3TC); touch UI |
| 3 | Linux/Windows | Tauri (uses the same web codebase, native FS access, GOG/Steam detection) |

Mobile note: file access to the installation is not practical there. The plan
is either an asset sync from the desktop (LAN; an HTTP range source already
exists) or a one-time import into the Origin Private File System (OPFS).

## Determinism plan (Sim core)

- Fixed-point arithmetic or consistent `Math.fround` for Sim mathematics
  (float determinism across platforms; the original uses x87-compatible FP)
- Sim tick: 10/s (original timing); the renderer interpolates
- No iteration over unsorted maps in the Sim path; use a dedicated seeded PRNG
- Replays = initial state + command stream (as in the original)

## Milestones

1. ✅ **M1 Unit Viewer**: VFS, SCM/BP/DDS parsers, original shader look
2. **M2 Map Renderer**: SCMAP parser (heightmap, texture layers, water,
   props), terrain shader port (`terrain.fx` is in effects.scd)
3. **M3 Animation**: SCA parser, GPU skinning, idle/walk cycles
4. **M4 Sim Foundation**: blueprint database, spawn/move units,
   flowfield/pathfinding, command queue
5. **M5 Combat & Economy**: weapons, projectiles, damage, Mass/Energy,
   construction, upgrade chains
6. **M6 Gameplay**: selection/commands/camera as in the original, minimap,
   fog of war, simple skirmish AI
7. **M7 Platforms & Multiplayer**: Tauri builds, mobile UI, lockstep netcode
