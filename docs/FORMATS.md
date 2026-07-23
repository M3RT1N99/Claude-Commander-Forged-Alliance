# File formats (verified against installation)

All information has been checked against the real Steam installation
(`scripts/verify.ts`); Byte layouts were additionally provided with hex samples
Original files compared. Sources: GPG Mod SDK documentation,
FAF-Community-Tools, eigene Verifikation.

## SCD — Archive (`gamedata/*.scd`)

Normal **Zip archives** (Magic `PK\x03\x04`). Entries mostly
*Stored* (uncompressed), partly *Deflate*. No Zip64 (all < 4GB).
→ [src/vfs/zipArchive.ts](../src/vfs/zipArchive.ts) only reads the central
Directory and loads entries individually (random access via Blob/HTTP range).
Paths must be treated case-insensitively (`UEL0001_NormalsTS.DDS` vs.
`uel0001_lod1_normalsts.dds`).

## SCM — Models (`*_lod0.scm`)

Little-endian, Magic `MODL`, version 5. Sections padded with `0xC5`,
one 4-byte marker each (`NAME`, `SKEL`, `VTXL`, `TRIS`, `INFO`) directly in front of the
Offset target. Full layout in header comment by
[src/formats/scm.ts](../src/formats/scm.ts).

Referenz UEL0001_LOD0.scm: 5807 Vertices, 10458 Indizes (3486 Tris),
29 Bones (19 gewichtet).

- Vertex (68 B): pos ³f · tangent ³f · normal ³f · binormal ³f · uv0 ²f ·
  uv1 ²f · boneIdx ⁴u8
- Bone (108 B): restPoseInverse 4×4f · pos ³f · rot (Quaternion) ⁴f ·
  nameOffset u32 · parentIndex i32 · 8 B reserviert
- UVs are DirectX convention (top left origin) — fits without flip
  non-flipped (compressed) WebGL textures.

## SCA — Animationen (`*_A*.sca`)

Magic `ANIM`, version 5. Header (verified on UEL0001_A001.sca and the
rekonstruierten Loader `RScaResource::LoadScaFile` in faf-re):
numFrames u32 · duration f32 · numBones u32 · namesOffset u32 ·
linksOffset u32 · animDataOffset u32 · frameSize u32.

- From animDataOffset: a 28-byte **root delta** record, then per frame:
  8-Byte-Header (f32 time, u32 flags) + numBones × 28-Byte-Keys
  {pos ³f, quat ⁴f (w,x,y,z)}
- Version < 5: Rotate quaternion components [a,b,c,d]→[d,a,b,c].
- Playback (original): 10 Hz sim ticks, `framePos = (frames-1)/duration * t`,
  Position LERP + Quaternion LERP between neighboring frames
- Skeleton comes from SCM file (Bones + Parents + Bindpose)

**Parser not yet implemented (M3).**

## Blueprints (`*_unit.bp`, Lua)

Deklaratives Lua: `UnitBlueprint { ... }` mit verschachtelten Konstruktoren
(`Sound { ... }`), strings, numbers, booleans, simple arithmetic and
`--`/`#`-Kommentaren. → [src/formats/blueprint.ts](../src/formats/blueprint.ts)
(no need for full Lua; parse 568/568 unit BPs).

## DDS — Texturen

Unit textures: DXT5, 1024², full mip chain. Meaning of the channels (from the
Original shader `effects/mesh.fx` in effects.scd):

| Textur | Inhalt |
| ------ | ------ |
| `_Albedo.dds` | RGB Farbe, A ungenutzt/Transparenz (je nach Shader) |
| `_NormalsTS.dds` | Tangent-Space-Normale: **x = G-Kanal, y = A-Kanal**, z rekonstruiert (`2*tex.gaa-1`), gesampelt mit **UV1** |
| `_SpecTeam.dds` | R = Environment-Reflexion · G = Phong-Spekular · B = Glow/Emissive · **A = Team-Color-Maske** |

Team-Color (mesh.fx): `albedo.rgb = lerp(teamColor, albedo.rgb, 1 - specular.a)`

## SCMAP — Maps (`maps/*/*.scmap`)

Magic `Map\x1a`, version major 2, minor 56 (FA) / 60 (FAF editor;
Original Steam cards are sometimes also 60). Full layout in
[src/formats/scmap.ts](../src/formats/scmap.ts); Parser verifies against
all 60 cards of the installation. Sources: Neroxis `SCMapImporter.java`,
ozonex FAF Map Editor (HazardX-Loader), faf-re (`CWldMap::MapLoad`).

Kernfakten:

- Heightmap: u16 grid with (w+1)×(h+1) samples, world height = value × 1/128,
  1 sample per world meter
- 10 Albedo-Strata (Lower, Stratum0–7, Upper) + 9 Normal-Strata, je
  Path (case-insensitive in env.scd!) + tile size in world meters
- Splat-Masken: 2 eingebettete unkomprimierte BGRA-DDS (Stratum 0-3 in
  RGBA from UtilityA, 4-7 in UtilityB), decoding `saturate(tex*2-1)`.
  **Attention:** The `terrainShader` string of the card originally selects the
  Shader-Technique (faf-re: `StratumMaterial::mShaderName`, Default
  `TTerrain`). `TTerrain` cards (e.g. SCMP_001) **never** sample UtilityB
  — the second mask contains junk there (duplicate of UtilityA). Our
  Solution: Apply masks only to strata with non-empty texture path
(`stratumEnable`-Uniforms), behavior equivalent for both techniques.
- Embedded images (masks/watermap/preview) have the same
  Line orientation like the heightmap — no V-flip (proven numerically:
  `scripts/check-orientation.ts`, Korrelation 0,998)
- Watermap (UtilityC, DXT5, half resolution): R = above water,
  **G = Wassertiefe**, B = Flatness, A = Foam
- Wasser-Settings: elevation/deep/abyss, SurfaceColor, WaterRamp-Textur
- Lighting: Sonnenrichtung/-farbe, Ambience, ShadowFill, Specular,
  LightingMultiplier, Fog — passed through 1:1 to the terrain shader
- Danach: WaveGenerators, Decals, TerrainType-Bytes, (v60: Skybox), Props
  (Blueprint path + position + 3×3 rotation matrix)
