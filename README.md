# Claude Commander: Forged Alliance

A reimplementation of **Supreme Commander: Forged Alliance** for the browser
(later mobile, Linux, and Windows) — an open engine based on the
**bring-your-own-assets** principle.

> This project provides **no game data**. It reads models, textures,
> blueprints, and maps directly from the user's **own purchased game
> installation** (Steam/GOG). No original game, no assets.

## Status: M1 Viewer ✅ · M2 Maps ✅ · M3 Animations ✅ · M4 Sim Foundation ✅

The app mounts the entire game installation as a virtual file system in the
browser and renders original units with original textures in WebGL:

- **SCD archives** (Zip) with random access — even the 1.3 GB archives are
  never loaded into memory in full
- **SCM meshes** (format `MODL` v5): vertices, normals, tangents, UV0/UV1,
  bones, skinning indices
- **Blueprints** (.bp, declarative Lua): a dedicated parser, verified against
  all 568 unit blueprints in the game
- **DDS textures** (DXT1/3/5): native GPU upload, with a software decoder as a
  fallback for mobile
- **Original shader look**: port of the FA unit shader (`mesh.fx`,
  NormalMappedPS), including the team-color mask, tangent-space normal mapping
  from the G/A channels, and specular/glow

## Quick start (development)

```bash
npm install
npm run dev
```

Then open <http://localhost:5173> and select the FA installation directory —
or, with a local dev server running, open <http://localhost:5173/?http=1>
directly (it serves the installation from `CFA_GAME_DIR`; default: Steam path).

Verification suites against the real installation (no mocks):

```bash
npm test
```

Run an individual suite (the `--import` loader is required because engine Lua
is loaded from real `.lua` files):

```bash
npx tsx --import ./scripts/register-lua.mjs scripts/verify-spawn.ts
```

## Legal

- This repository's source code is an independent TypeScript development; it
  contains no original code, original assets, or data copied from the binary.
- Assets are read exclusively and locally from the user's installation; they
  are never uploaded, bundled, or distributed (`.gitignore` also blocks asset
  formats).
- The existing local installation serves as proof of ownership; optional
  Steam/GOG verification is planned (see `docs/LEGAL.md`).

The same principle is used by OpenRA, OpenMW, openage, and OpenSAGE.

## Roadmap

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In brief:

1. ✅ **Unit Viewer** — formats, VFS, rendering foundation
2. ✅ **Map Renderer** — SCMAP terrain splatting, water (basic)
3. ✅ **Animations** — SCA parser, GPU skinning, walk cycles
4. ✅ **Sim Foundation** — deterministic 10 Hz core (bit-identical runs),
   command queues, movement model from blueprint values, and multiple units
   with selection in the sandbox
5. **Sim Expansion** — pathfinding, collision, weapons/damage, economy,
   factories; reference: reconstructed Moho engine sources (faf-re)
6. **Gameplay** — controls, UI, fog of war, AI skirmish
7. **Platforms** — mobile (touch UI), desktop builds (Tauri), multiplayer
