# Claude Commander: Forged Alliance

A new implementation of **Supreme Commander: Forged Alliance** for the
Browser (later Mobile, Linux and Windows) — as an open engine after the
**Bring-your-own-assets**-Prinzip.

> This project does not provide **any game data**. It reads models,
> Textures, blueprints and maps directly from the **own, purchased
> Install** the game (Steam/GOG). Without original game, no assets.

## Status: M1 Viewer ✅ · M2 Maps ✅ · M3 Animations ✅ · M4 Sim Base ✅

The app mounts the entire game installation as a virtual file system
Browser and renders original entities with original textures in WebGL:

- **SCD archives** (Zip) with random access — including the 1.3 GB archives
  are never completely loaded into memory
- **SCM-Meshes** (Format `MODL` v5): Vertices, Normals, Tangents, UV0/UV1,
  Bones, Skinning-Indizes
- **Blueprints** (.bp, declarative Lua): own parser, verified against
  all 568 unit blueprints in the game
- **DDS textures** (DXT1/3/5): native GPU upload, software decoder as
  Fallback für Mobile
- **Original shader look**: Port of the FA unit shader (`mesh.fx`,
  NormalMappedPS) including team color mask, tangent-space normal mapping
  the G/A channels, Spec/Glow

## Schnellstart (Entwicklung)

```bash
npm install
npm run dev
```

Then open <http://localhost:5173> and the FA installation directory
choose — or directly with a locally running dev server
<http://localhost:5173/?http=1> (serves the installation
`CFA_GAME_DIR`, default: Steam path).

Verify suites against real installation (no mocks):

```bash
npm test
```

Single suite (the `--import` loader is necessary because the engine Lua is made from real
`.lua` files are loaded):

```bash
npx tsx --import ./scripts/register-lua.mjs scripts/verify-spawn.ts
```

## Rechtliches

- The source code of this repo is an in-house development (TypeScript); he
  contains no original code, no original assets and none from the
  Binary kopierten Daten.
- Assets are only read locally from the user's installation,
  never uploaded, bundled or distributed (`.gitignore` blocked
  Asset-Formate).
- The existing local installation serves as proof of ownership; an optional one
  Steam/GOG verification is planned (see `docs/LEGAL.md`).

Same principle as OpenRA, OpenMW, openage or OpenSAGE.

## Roadmap

Siehe [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Kurzfassung:

1. ✅ **Unit Viewer** — Formats, VFS, Rendering Base
2. ✅ **Map Renderer** — SCMAP terrain splatting, water (basic)
3. ✅ **Animationen** — SCA-Parser, GPU-Skinning, Walk-Cycles
4. ✅ **Sim-Basis** — deterministischer 10-Hz-Kern (bit-identische Läufe),
   Command queues, movement model from blueprint values, multiple units
   with selection in the sandbox
5. **Sim-Ausbau** — Pathfinding, Kollision, Waffen/Schaden, Wirtschaft,
   Fabriken; Referenz: rekonstruierte Moho-Engine-Quellen (faf-re)
6. **Playability** — Controls, UI, Fog of War, AI Skirmish
7. **Plattformen** — Mobile (Touch-UI), Desktop-Builds (Tauri), Multiplayer
