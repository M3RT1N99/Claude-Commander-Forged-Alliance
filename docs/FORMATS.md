# File formats (verified against the installation)

All information was checked against the real Steam installation
(`scripts/verify.ts`); byte layouts were also compared with hex samples from
the original files. Sources: GPG Mod SDK documentation, FAF community tools,
and independent verification.

## SCD — archives (`gamedata/*.scd`)

Standard **Zip archives** (magic `PK\x03\x04`). Entries are mostly *Stored*
(uncompressed), with some *Deflate*. No Zip64 (all < 4 GB). →
[src/vfs/zipArchive.ts](../src/vfs/zipArchive.ts) reads only the central
directory and loads entries individually (random access through Blob/HTTP
range). Paths must be handled case-insensitively (`UEL0001_NormalsTS.DDS` vs.
`uel0001_lod1_normalsts.dds`).

## SCM — models (`*_lod0.scm`)

Little-endian, magic `MODL`, version 5. Sections are padded with `0xC5`, with
one 4-byte marker (`NAME`, `SKEL`, `VTXL`, `TRIS`, `INFO`) immediately before
each offset target. The complete layout is in the header comment of
[src/formats/scm.ts](../src/formats/scm.ts).

Reference UEL0001_LOD0.scm: 5807 vertices, 10458 indices (3486 triangles),
29 bones (19 weighted).

- Vertex (68 B): pos ³f · tangent ³f · normal ³f · binormal ³f · uv0 ²f ·
  uv1 ²f · boneIdx ⁴u8
- Bone (108 B): restPoseInverse 4×4f · pos ³f · rot (quaternion) ⁴f ·
  nameOffset u32 · parentIndex i32 · 8 B reserved
- UVs follow the DirectX convention (origin at the top left) and therefore
  work without a flip with unflipped (compressed) WebGL textures.

## SCA — animations (`*_A*.sca`)

Magic `ANIM`, version 5. Header (verified against UEL0001_A001.sca and the
reconstructed `RScaResource::LoadScaFile` loader in faf-re):
numFrames u32 · duration f32 · numBones u32 · namesOffset u32 ·
linksOffset u32 · animDataOffset u32 · frameSize u32.

- From animDataOffset: one 28-byte **root-delta** record, then per frame:
  8-byte header (f32 time, u32 flags) + numBones × 28-byte keys
  {pos ³f, quat ⁴f (w,x,y,z)}
- Version < 5: rotate quaternion components [a,b,c,d]→[d,a,b,c]
- Playback (original): 10 Hz Sim ticks, `framePos = (frames-1)/duration * t`,
  position LERP + quaternion LERP between neighboring frames
- The skeleton comes from the SCM file (bones + parents + bind pose)

**Parser not yet implemented (M3).**

## Blueprints (`*_unit.bp`, Lua)

Declarative Lua: `UnitBlueprint { ... }` with nested constructors
(`Sound { ... }`), strings, numbers, booleans, simple arithmetic, and
`--`/`#` comments. → [src/formats/blueprint.ts](../src/formats/blueprint.ts)
(no full Lua implementation is required; 568/568 unit BPs parse).

## DDS — textures

Unit textures: DXT5, 1024², full mip chain. Channel meanings (from the
original shader `effects/mesh.fx` in effects.scd):

| Texture | Contents |
| ------- | -------- |
| `_Albedo.dds` | RGB color, A unused/transparency (depending on the shader) |
| `_NormalsTS.dds` | Tangent-space normal: **x = G channel, y = A channel**, z reconstructed (`2*tex.gaa-1`), sampled with **UV1** |
| `_SpecTeam.dds` | R = environment reflection · G = Phong specular · B = glow/emissive · **A = team-color mask** |

Team color (mesh.fx): `albedo.rgb = lerp(teamColor, albedo.rgb, 1 - specular.a)`

## SCMAP — maps (`maps/*/*.scmap`)

Magic `Map\x1a`, version major 2, minor 56 (FA) / 60 (FAF Editor; original
Steam maps are sometimes also 60). The complete layout is in
[src/formats/scmap.ts](../src/formats/scmap.ts); the parser is verified against
all 60 maps in the installation. Sources: Neroxis `SCMapImporter.java`,
ozonex FAF Map Editor (HazardX loader), faf-re (`CWldMap::MapLoad`).

Core facts:

- Heightmap: u16 grid with (w+1)×(h+1) samples, world height = value × 1/128,
  1 sample per world meter
- 10 albedo strata (Lower, Stratum0–7, Upper) + 9 normal strata, each with a
  path (case-insensitive in env.scd) + tile size in world meters
- Splat masks: 2 embedded uncompressed BGRA DDS files (Stratum 0–3 in RGBA
  from UtilityA, 4–7 in UtilityB), decoded with `saturate(tex*2-1)`.
  **Important:** in the original, the map's `terrainShader` string selects the
  shader technique (faf-re: `StratumMaterial::mShaderName`, default
  `TTerrain`). `TTerrain` maps (for example, SCMP_001) **never** sample
  UtilityB — the second mask contains junk there (a duplicate of UtilityA).
  Our solution applies masks only to strata with a non-empty texture path
  (`stratumEnable` uniforms), making it behaviorally equivalent for both
  techniques.
- Embedded images (masks/watermap/preview) have the same row orientation as
  the heightmap — no V flip (proved numerically:
  `scripts/check-orientation.ts`, correlation 0,998)
- Watermap (UtilityC, DXT5, half resolution): R = above water,
  **G = water depth**, B = flatness, A = foam
- Water settings: elevation/deep/abyss, SurfaceColor, WaterRamp texture
- Lighting: sun direction/color, ambience, ShadowFill, Specular,
  LightingMultiplier, Fog — passed through to the terrain shader 1:1
- Then: WaveGenerators, Decals, TerrainType bytes, (v60: Skybox), props
  (blueprint path + position + 3×3 rotation matrix)
